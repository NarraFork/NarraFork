import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceContext } from "@shared/workspace-context";
import { and, eq, sql } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../db";
import { legacyNarratorWorkspaceAdoptions, narrators } from "../db/schema";
import { localPathSemantics } from "../lib/agent/execution/path-semantics";
import { safeSpawn } from "../lib/spawn";
import {
	type LegacyLinkedHistoryBinding,
	readAuthorizedLegacyLinkedHistoryBinding,
} from "./legacy-linked-history-reader";
import {
	assertLegacyLinkedWorktreeIdentityUnchangedSync,
	type LegacyLinkedWorktreeEvidence,
	prepareLegacyLinkedWorktreeIdentity,
} from "./legacy-linked-worktree-identity";
import type { NarratorPrincipal } from "./narrator-acl";

export interface LegacyRollbackWorkspace {
	id: string;
	cwd: string | null;
	workspaceRevision: number;
	workspaceContext: WorkspaceContext | null;
	defaultDeviceId?: string | null;
	chapterId?: string | null;
	contextProjectId?: string | null;
	scheduledTaskId?: string | null;
	oauthOwnerGrantId?: string | null;
	oauthProvisionKey?: string | null;
	oauthPolicySnapshotJson?: unknown;
}
export interface LegacyRollbackProof {
	migrationProjectId?: string;
	adoptedRevision: number;
	deviceId: string;
	cwd: string;
	contextKey: string;
	historyDigest: string;
	proofMode?: "empty" | "retained";
	originJson?: unknown;
	workspaceKey: string | null;
	repositoryKey: string | null;
	directoryDev: string;
	directoryIno: string;
	gitDirectoryDev?: string | null;
	gitDirectoryIno?: string | null;
}
interface BridgeDependencies {
	lookup(id: string): Promise<LegacyRollbackProof | undefined>;
	verifyDirectory(cwd: string, proof: LegacyRollbackProof): Promise<boolean>;
	verifyLinkedDirectory?(
		row: LegacyRollbackWorkspace,
		proof: LegacyRollbackProof,
		principal: NarratorPrincipal,
	): Promise<boolean>;
}

/** A physical-lineage check only; caller authorization and normal revert policy still apply. */
export function createLegacyWorkspaceRollbackBridge(deps: BridgeDependencies) {
	return async (row: LegacyRollbackWorkspace, principal?: NarratorPrincipal): Promise<boolean> => {
		try {
			const context = row.workspaceContext;
			if (
				row.chapterId ||
				row.contextProjectId ||
				row.scheduledTaskId ||
				row.oauthOwnerGrantId ||
				row.oauthProvisionKey ||
				row.oauthPolicySnapshotJson ||
				!row.cwd ||
				!context ||
				context.contextProjectId ||
				context.deviceId !== "local" ||
				(row.defaultDeviceId != null && row.defaultDeviceId !== "local") ||
				context.pathFlavor !== localPathSemantics.flavor ||
				context.revision !== row.workspaceRevision ||
				context.cwd !== row.cwd ||
				(context.git && context.git.rootPath !== row.cwd)
			)
				return false;
			const proof = await deps.lookup(row.id);
			if (
				!proof ||
				proof.deviceId !== "local" ||
				proof.cwd !== row.cwd ||
				!Number.isSafeInteger(proof.adoptedRevision) ||
				proof.adoptedRevision < 1 ||
				proof.adoptedRevision !== row.workspaceRevision ||
				proof.contextKey !== context.contextKey ||
				!/^[a-f0-9]{64}$/.test(proof.historyDigest) ||
				proof.workspaceKey !== (context.git?.workspaceKey ?? null) ||
				proof.repositoryKey !== (context.git?.repositoryKey ?? null)
			)
				return false;
			if (proof.proofMode === "retained") {
				const evidence = proof.originJson as {
					version?: number;
					manifestDigest?: string;
					origin?: {
						deviceId?: string;
						workspacePath?: string;
						workspaceRevision?: number;
						narratorId?: string;
						sourceChapterId?: string | null;
						workspaceContext?: string | null;
					};
				} | null;
				if (
					!evidence ||
					evidence.version !== 1 ||
					evidence.manifestDigest !== proof.historyDigest ||
					evidence.origin?.narratorId !== row.id ||
					evidence.origin.deviceId !== "local" ||
					evidence.origin.workspacePath !== proof.cwd ||
					evidence.origin.workspaceRevision !== proof.adoptedRevision - 1 ||
					typeof evidence.origin.sourceChapterId !== "string" ||
					!evidence.origin.sourceChapterId ||
					(evidence.origin.workspaceContext !== null &&
						typeof evidence.origin.workspaceContext !== "string")
				)
					return false;
				if (evidence.origin.workspaceContext) {
					if (Buffer.byteLength(evidence.origin.workspaceContext) > 16384) return false;
					const old = JSON.parse(evidence.origin.workspaceContext) as WorkspaceContext;
					if (
						old.cwd !== proof.cwd ||
						old.deviceId !== "local" ||
						old.revision !== proof.adoptedRevision - 1 ||
						old.contextKey !== proof.contextKey ||
						(old.git?.repositoryKey ?? null) !== proof.repositoryKey ||
						(old.git?.workspaceKey ?? null) !== proof.workspaceKey ||
						JSON.stringify((old as unknown as Record<string, unknown>).scopeMetadata) !==
							JSON.stringify((context as unknown as Record<string, unknown>).scopeMetadata)
					)
						return false;
				}
			} else if (proof.proofMode !== undefined && proof.proofMode !== "empty") return false;
			if ((proof.originJson as { linkedWorktree?: unknown } | null)?.linkedWorktree) {
				// No principal means the legacy whole-tree adapter, not the modern file restore.
				return (
					!!principal &&
					proof.proofMode === "retained" &&
					!!deps.verifyLinkedDirectory &&
					(await deps.verifyLinkedDirectory(row, proof, principal))
				);
			}
			return await deps.verifyDirectory(row.cwd, proof);
		} catch {
			// Unknown ownership or unreadable evidence never relaxes M0's history boundary.
			return false;
		}
	};
}

/** Migration uses the full metadata CAS. Later restores bind only the stable namespace:
 * HEAD/index/refs and directory timestamps legitimately change after a normal commit.
 * This comparison grants no freshness: callers must use a real strict native probe
 * and its WeakMap-backed synchronous guard at the final authorized boundary. */
export function hasSameLegacyLinkedWorktreeNamespace(
	original: LegacyLinkedWorktreeEvidence,
	fresh: LegacyLinkedWorktreeEvidence,
): boolean {
	if (
		original.version !== 1 ||
		fresh.version !== 1 ||
		["projectRoot", "top", "common", "adminDir", "gitfile", "branch", "backpointer"].some(
			(key) =>
				original[key as keyof LegacyLinkedWorktreeEvidence] !==
				fresh[key as keyof LegacyLinkedWorktreeEvidence],
		) ||
		original.registration.id !== fresh.registration.id ||
		original.registration.worktree !== fresh.registration.worktree ||
		original.registration.branch !== fresh.registration.branch
	)
		return false;
	const stableDirectories = [
		original.projectRoot,
		original.top,
		original.common,
		original.adminDir,
		join(original.common, "worktrees"),
	];
	const stableFiles = [
		original.gitfile,
		join(original.adminDir, "gitdir"),
		join(original.adminDir, "commondir"),
	];
	for (const path of [...stableDirectories, ...stableFiles]) {
		const before = original.metadata.find((fact) => fact.path === path);
		const after = fresh.metadata.find((fact) => fact.path === path);
		const kind = stableFiles.includes(path) ? "file" : "directory";
		if (
			!before ||
			!after ||
			before.kind !== kind ||
			after.kind !== kind ||
			!before.dev ||
			!before.ino ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			(kind === "file" && (!before.contentDigest || before.contentDigest !== after.contentDigest))
		)
			return false;
	}
	return true;
}

const bridge = createLegacyWorkspaceRollbackBridge({
	lookup: (id) =>
		db.query.legacyNarratorWorkspaceAdoptions.findFirst({
			where: and(
				eq(legacyNarratorWorkspaceAdoptions.narratorId, id),
				sql`(${legacyNarratorWorkspaceAdoptions.originJson} IS NULL OR
					length(CAST(${legacyNarratorWorkspaceAdoptions.originJson} AS BLOB)) <= 65536)`,
			),
			columns: {
				migrationProjectId: true,
				adoptedRevision: true,
				deviceId: true,
				cwd: true,
				contextKey: true,
				historyDigest: true,
				proofMode: true,
				originJson: true,
				workspaceKey: true,
				repositoryKey: true,
				directoryDev: true,
				directoryIno: true,
				gitDirectoryDev: true,
				gitDirectoryIno: true,
			},
		}),
	verifyLinkedDirectory: async (row, proof, principal) => {
		if (!proof.migrationProjectId || !row.cwd) return false;
		const origin = proof.originJson as {
			linkedWorktree: LegacyLinkedHistoryBinding;
			origin: { sourceChapterId: string };
		};
		const read = () =>
			readAuthorizedLegacyLinkedHistoryBinding(
				row.id,
				principal,
				origin.linkedWorktree,
				proof.migrationProjectId as string,
				origin.origin.sourceChapterId,
				proof.cwd,
				"write",
			);
		const expected = await read();
		if (!expected || expected.top !== row.cwd) return false;
		const fresh = await prepareLegacyLinkedWorktreeIdentity({
			projectRoot: expected.projectRoot,
			worktreePath: expected.top,
			expectedBranch: expected.branch,
		});
		if (!hasSameLegacyLinkedWorktreeNamespace(expected, fresh)) return false;
		const current = await read();
		if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false;
		assertLegacyLinkedWorktreeIdentityUnchangedSync(fresh);
		return true;
	},
	verifyDirectory: async (cwd, proof) => {
		if ((await realpath(cwd)) !== cwd) return false;
		const directory = await lstat(cwd);
		if (
			!directory.isDirectory() ||
			directory.isSymbolicLink() ||
			!Number.isSafeInteger(directory.dev) ||
			!Number.isSafeInteger(directory.ino) ||
			String(directory.dev) !== proof.directoryDev ||
			String(directory.ino) !== proof.directoryIno
		)
			return false;
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)),
		);
		const probe = await safeSpawn({
			cmd: [
				"git",
				"--no-optional-locks",
				"-C",
				cwd,
				"rev-parse",
				"--is-inside-work-tree",
				"--is-bare-repository",
				"--path-format=absolute",
				"--show-toplevel",
				"--absolute-git-dir",
				"--git-common-dir",
			],
			env: { ...env, LC_ALL: "C", LANG: "C" },
			timeout: 5000,
			maxOutputBytes: 32768,
		});
		if (probe.stdoutTruncated || probe.stderrTruncated) return false;
		if (!proof.workspaceKey && !proof.repositoryKey)
			return (
				probe.exitCode !== 0 &&
				/not a git repository/i.test(probe.stderr) &&
				!proof.gitDirectoryDev &&
				!proof.gitDirectoryIno
			);
		const parts = probe.stdout.trim().split("\n");
		if (probe.exitCode !== 0 || parts.length !== 5 || parts[0] !== "true" || parts[1] !== "false")
			return false;
		const gitPath = join(cwd, ".git");
		const [root, git, common] = await Promise.all(parts.slice(2).map((path) => realpath(path)));
		if (
			root !== cwd ||
			git !== gitPath ||
			common !== gitPath ||
			!proof.gitDirectoryDev ||
			!proof.gitDirectoryIno
		)
			return false;
		const gitDirectory = await lstat(gitPath);
		const key = (path: string) =>
			createHash("sha256")
				.update(JSON.stringify(["local", localPathSemantics.identityKey(path)]))
				.digest("hex");
		return (
			gitDirectory.isDirectory() &&
			!gitDirectory.isSymbolicLink() &&
			Number.isSafeInteger(gitDirectory.dev) &&
			Number.isSafeInteger(gitDirectory.ino) &&
			String(gitDirectory.dev) === proof.gitDirectoryDev &&
			String(gitDirectory.ino) === proof.gitDirectoryIno &&
			proof.workspaceKey === key(cwd) &&
			proof.repositoryKey === key(gitPath)
		);
	},
});

export async function canUseLegacyWorkspaceRollbackBridge(
	row: LegacyRollbackWorkspace,
	principal?: NarratorPrincipal,
) {
	if (activeDatabaseBackend !== "sqlite") return false;
	try {
		const [bindings] = await db
			.select({
				chapterId: narrators.chapterId,
				contextProjectId: narrators.contextProjectId,
				scheduledTaskId: narrators.scheduledTaskId,
				oauthOwnerGrantId: narrators.oauthOwnerGrantId,
				oauthProvisionKey: narrators.oauthProvisionKey,
				oauthPolicySnapshotJson: sql<boolean>`${narrators.oauthPolicySnapshotJson} IS NOT NULL`,
				defaultDeviceId: narrators.defaultDeviceId,
			})
			.from(narrators)
			.where(eq(narrators.id, row.id))
			.limit(1);
		if (!bindings) return false;
		return await bridge({ ...row, ...bindings }, principal);
	} catch {
		// Missing/unreadable current binding authority never opens a history write boundary.
		return false;
	}
}
