import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { WorkspaceContext } from "@shared/workspace-context";
import { localPathSemantics } from "../lib/agent/execution/path-semantics";
import { safeSpawn } from "../lib/spawn";
import {
	type LegacyLinkedWorktreeEvidence,
	prepareLegacyLinkedWorktreeIdentity,
	revalidateLegacyLinkedWorktreeIdentity,
} from "./legacy-linked-worktree-identity";
import type {
	LegacyRetainedHistoryResult,
	LegacyRetainedWorkspaceBinding,
} from "./legacy-retained-history-contract";
import { prepareLegacyRetainedHistory } from "./legacy-retained-history-plan";
import { inspectLegacyRootHistory, type LegacyRootHistoryResult } from "./legacy-root-history";
import { treeSnapshotKey, treeSnapshotPhysicalDir } from "./tree-snapshot-paths";

export type ScalarRow = Record<string, string | number | null>;
export interface LegacyRootAdoptionInput {
	project: ScalarRow;
	chapters: ScalarRow[];
	sessions: ScalarRow[];
	databasePath: string;
	/** Trusted migration adapter only; strict-empty remains the default. */
	retainHistory?: boolean;
	/** Independent rollout gate: root-only retained readiness does not authorize linked adoption. */
	linkedWorktreesReady?: boolean;
	/** Server-owned closure, valid only while its physical admission reservation is held. Never cloned to workers. */
	assertLinkedAdmissionReady?: () => void;
}
export interface LegacyLinkedWorktreeAdoption {
	sourceChapterId: string;
	evidence: LegacyLinkedWorktreeEvidence;
	narratorIds: string[];
}
export interface LegacyRootAdoptionResult {
	blockers: Array<{ code: string; message: string }>;
	digest: string;
	updates: Array<{
		id: string;
		previous: WorkspaceContext;
		current: WorkspaceContext;
		directoryIdentity: { dev: number; ino: number };
		gitDirectoryIdentity?: { dev: number; ino: number };
	}>;
	history: LegacyRootHistoryResult | LegacyRetainedHistoryResult;
	/** Empty/absent for the existing ordinary-main and explicit non-Git paths. */
	linkedWorktrees?: LegacyLinkedWorktreeAdoption[];
}
/** Test seams are read-only; production does not import DB or runtime singletons. */
export interface LegacyRootAdoptionOverrides {
	spawn?: typeof safeSpawn;
	history?: typeof inspectLegacyRootHistory;
	stat?: typeof stat;
	lstat?: typeof lstat;
	realpath?: typeof realpath;
	access?: typeof access;
}
const MAX_JSON_BYTES = 16_384;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const present = (value: unknown) => value !== null && value !== undefined && value !== "";
const integer = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const path = (value: unknown): value is string =>
	typeof value === "string" && value.length <= 4096 && !value.includes("\0") && isAbsolute(value);
const json = (raw: unknown): unknown => {
	if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_JSON_BYTES)
		throw new Error("Invalid or oversized JSON metadata");
	return JSON.parse(raw);
};
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

/** Exact identity algorithms of prepareLocalWorkspaceContext/gitWorkspaceIdentity,
 * using the same pure backend path semantics without loading write-capable services. */
export function legacyLocalWorkspaceContext(
	cwd: string,
	revision: number,
	projectId: string,
	gitRoot?: string,
	gitCommonDirectory?: string,
): WorkspaceContext {
	const identity = (root: string) => hash(["local", localPathSemantics.identityKey(root)]);
	const git = gitRoot
		? {
				workspaceKey: identity(gitRoot),
				repositoryKey: identity(gitCommonDirectory ?? join(gitRoot, ".git")),
				rootPath: gitRoot,
			}
		: undefined;
	return {
		revision,
		deviceId: "local",
		cwd,
		pathFlavor: localPathSemantics.flavor === "windows" ? "windows" : "posix",
		contextProjectId: projectId,
		git,
		contextKey: hash([
			"local",
			localPathSemantics.identityKey(cwd),
			git?.workspaceKey ?? null,
			git?.repositoryKey ?? null,
		]),
		capabilities: { switchDirectory: true },
	};
}

function validateContext(raw: unknown, fresh: WorkspaceContext): WorkspaceContext {
	const ctx = json(raw);
	if (
		!object(ctx) ||
		ctx.revision !== fresh.revision ||
		ctx.deviceId !== "local" ||
		ctx.cwd !== fresh.cwd ||
		ctx.pathFlavor !== fresh.pathFlavor ||
		ctx.contextKey !== fresh.contextKey ||
		(present(ctx.contextProjectId) && ctx.contextProjectId !== fresh.contextProjectId) ||
		!object(ctx.capabilities) ||
		typeof ctx.capabilities.switchDirectory !== "boolean" ||
		(ctx.capabilities.reason !== undefined &&
			(typeof ctx.capabilities.reason !== "string" || ctx.capabilities.reason.length > 1024))
	)
		throw new Error("Persisted workspace context is invalid or stale");
	if (fresh.git) {
		if (
			!object(ctx.git) ||
			ctx.git.rootPath !== fresh.git.rootPath ||
			ctx.git.workspaceKey !== fresh.git.workspaceKey ||
			ctx.git.repositoryKey !== fresh.git.repositoryKey
		)
			throw new Error("Persisted Git identity does not match fresh discovery");
	} else if (ctx.git !== undefined) throw new Error("Unexpected persisted Git identity");
	return ctx as unknown as WorkspaceContext;
}

/** Prepare only: never writes metadata, touches Git state, unloads runtime, or
 * removes resources. An empty result still needs SQL guard/CAS revalidation. */
export async function prepareLegacyRootAdoption(
	input: LegacyRootAdoptionInput,
	overrides: LegacyRootAdoptionOverrides = {},
): Promise<LegacyRootAdoptionResult> {
	const io = {
		stat,
		lstat,
		realpath,
		access,
		spawn: safeSpawn,
		history: inspectLegacyRootHistory,
		...overrides,
	};
	const blockers: LegacyRootAdoptionResult["blockers"] = [];
	const updates: LegacyRootAdoptionResult["updates"] = [];
	const linkedWorktrees: LegacyLinkedWorktreeAdoption[] = [];
	const linkedProbeStarted = performance.now();
	const facts: unknown[] = [];
	let history: LegacyRootHistoryResult | LegacyRetainedHistoryResult = {
		status: "unknown",
		digest: hash("not inspected"),
	};
	const block = (code: string, message: string) => blockers.push({ code, message });
	const finish = (): LegacyRootAdoptionResult => ({
		blockers,
		updates: blockers.length ? [] : updates,
		history,
		...(linkedWorktrees.length ? { linkedWorktrees } : {}),
		digest: hash({ input, facts, history, blockers, updates, linkedWorktrees }),
	});
	if (
		input.sessions.length > 128 ||
		input.chapters.length > 128 ||
		!input.sessions.length ||
		!input.project.id ||
		Buffer.byteLength(JSON.stringify(input)) > 2 * 1024 * 1024
	) {
		block("ADOPTION_BUDGET", "No narrator or metadata exceeds the adoption budget.");
		return finish();
	}
	const ids = new Set(input.sessions.map((row) => String(row.id)));
	if (ids.size !== input.sessions.length) {
		block("ADOPTION_METADATA", "Duplicate narrator identities.");
		return finish();
	}
	const projectId = String(input.project.id);
	const complex =
		input.chapters.some((row) => present(row.worktree_path) || present(row.snapshot_shadow_key)) ||
		input.sessions.some((row) => present(row.workspace_context) || row.has_workspace_context === 1);
	const directories = new Map<string, Awaited<ReturnType<typeof stat>>>();
	const stamp = (s: Awaited<ReturnType<typeof stat>>) => [
		s.dev,
		s.ino,
		s.mode,
		s.size,
		s.mtimeMs,
		s.ctimeMs,
	];
	let root: string | undefined;
	let gitDirectoryStamp: unknown;
	let ready = false;
	try {
		if (complex) {
			if (!path(input.project.git_path)) throw new Error("Project root is missing or not absolute");
			root = await io.realpath(input.project.git_path);
			let rootChapter = false;
			for (const chapter of input.chapters) {
				if (!present(chapter.worktree_path)) continue;
				if (!path(chapter.worktree_path))
					throw new Error("Allocated chapter workspace is not an absolute directory");
				const worktree = await io.realpath(chapter.worktree_path);
				if (worktree !== root) {
					if (!input.linkedWorktreesReady || !input.retainHistory) {
						block(
							"LINKED_WORKTREE_NOT_READY",
							"Linked adoption requires independent consumer readiness and retained origin-aware history proof.",
						);
						return finish();
					}
					if (
						chapter.is_root === 1 ||
						chapter.project_id !== projectId ||
						!["active", "dormant"].includes(String(chapter.status)) ||
						chapter.worktree_path !== worktree ||
						typeof chapter.branch !== "string"
					)
						throw new Error(
							"Linked source needs a canonical allocated non-root workspace and exact branch",
						);
					if (linkedWorktrees.some((entry) => entry.evidence.top === worktree))
						throw new Error("Multiple chapters claim one linked workspace");
					if (linkedWorktrees.length >= 16 || performance.now() - linkedProbeStarted > 10000)
						throw new Error("Linked workspace probe group exceeds the bounded admission budget");
					const evidence = await prepareLegacyLinkedWorktreeIdentity({
						projectRoot: root,
						worktreePath: worktree,
						expectedBranch: chapter.branch,
					});
					linkedWorktrees.push({ sourceChapterId: String(chapter.id), evidence, narratorIds: [] });
				} else if (chapter.is_root === 1) rootChapter = true;
			}
			if (!rootChapter) throw new Error("No canonical root chapter owns the main checkout");
			if (linkedWorktrees.length && input.chapters.some((chapter) => !path(chapter.worktree_path)))
				throw new Error(
					"Every chapter in linked adoption needs an explicit verified allocated source workspace",
				);
		}
		const candidates: Array<{ row: ScalarRow; cwd: string; revision: number }> = [];
		for (const row of input.sessions) {
			if (present(row.parent_narrator_id) && !ids.has(String(row.parent_narrator_id)))
				throw new Error("Parent outside adoption inventory would change inherited permissions");
			if (present(row.acl_root_narrator_id) && !ids.has(String(row.acl_root_narrator_id)))
				throw new Error("ACL root outside adoption inventory");
			if (
				[row.default_device_id, row.runtime_device].some(
					(device) => present(device) && device !== "local",
				)
			)
				throw new Error("Remote execution identity cannot be adopted locally");
			const revision = row.workspace_revision ?? 0;
			if (!integer(revision) || revision === Number.MAX_SAFE_INTEGER)
				throw new Error("Invalid workspace revision");
			let committed: unknown;
			if (present(row.workspace_context)) committed = json(row.workspace_context);
			else if (row.has_workspace_context === 1)
				throw new Error("Persisted context was not inventoried");
			if (committed !== undefined && (!object(committed) || !path(committed.cwd)))
				throw new Error("Invalid persisted workspace cwd");
			const chapter = input.chapters.find((c) => c.id === row.chapter_id);
			if (
				linkedWorktrees.length &&
				(!chapter ||
					!path(chapter.worktree_path) ||
					input.project.visibility !== "private" ||
					!input.project.owner_user_id ||
					row.owner_user_id !== input.project.owner_user_id ||
					row.visibility !== "private" ||
					row.write_audience !== "owner" ||
					row.type !== "primary" ||
					row.variant !== "primary" ||
					present(row.parent_narrator_id) ||
					present(row.acl_root_narrator_id) ||
					present(row.runtime_cwd) ||
					present(row.runtime_device) ||
					!["idle", "archived"].includes(String(row.status)) ||
					row.substatus !== "[]")
			)
				throw new Error(
					"Linked adoption only supports same-owner private local idle chapter-bound primary narrators without runtime or inherited ACL",
				);
			const raw = object(committed)
				? committed.cwd
				: [row.runtime_cwd, row.cwd, chapter?.worktree_path, input.project.git_path].find(present);
			if (!path(raw))
				throw new Error("No explicit absolute execution directory; home fallback forbidden");
			await io.access(raw, constants.R_OK | constants.X_OK);
			const cwd = await io.realpath(raw);
			const s = await io.stat(cwd);
			if (!s.isDirectory() || !integer(s.dev) || !integer(s.ino))
				throw new Error("Invalid directory identity");
			facts.push({ cwd, stat: stamp(s) });
			const earlier = directories.get(cwd);
			if (earlier && JSON.stringify(stamp(earlier)) !== JSON.stringify(stamp(s)))
				throw new Error("Execution directory identity changed between narrators");
			directories.set(cwd, s);
			if (root === undefined) root = cwd;
			const linked = linkedWorktrees.find((entry) => entry.sourceChapterId === chapter?.id);
			const expected = linked?.evidence.top ?? root;
			if (cwd !== expected || (linkedWorktrees.length && chapter?.worktree_path !== cwd))
				throw new Error("Narrator execution directory does not match its allocated source chapter");
			if (linked) linked.narratorIds.push(String(row.id));
			candidates.push({ row, cwd, revision });
		}
		if (!root) throw new Error("No materialized execution root");
		// Strip all inherited Git discovery/config overrides, including GIT_DIR,
		// GIT_WORK_TREE, GIT_COMMON_DIR and GIT_CONFIG_COUNT. Never run status/checkout.
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)),
		);
		env.LC_ALL = "C";
		env.LANG = "C";
		const probeOptions = {
			cmd: [
				"git",
				"--no-optional-locks",
				"-C",
				root,
				"rev-parse",
				"--is-inside-work-tree",
				"--is-bare-repository",
				"--path-format=absolute",
				"--show-toplevel",
				"--absolute-git-dir",
				"--git-common-dir",
			],
			env,
			timeout: 10_000,
			maxOutputBytes: 32 * 1024,
		};
		const probe = await io.spawn(probeOptions);
		facts.push({ probe });
		if (
			probe.stdoutTruncated ||
			probe.stderrTruncated ||
			Buffer.byteLength(probe.stdout) > 32 * 1024 ||
			Buffer.byteLength(probe.stderr) > 32 * 1024
		)
			throw new Error("Git probe exceeded output budget");
		const lines = probe.stdout
			.trim()
			.split("\n")
			.map((line) => line.replace(/\r$/, ""));
		if (probe.exitCode === 0) {
			if (!complex) throw new Error("Git adoption requires a canonical root chapter checkout");
			const [inside, bare, top, gitDir, common] = lines;
			if (
				lines.length !== 5 ||
				inside !== "true" ||
				bare !== "false" ||
				top !== root ||
				gitDir !== join(root, ".git") ||
				common !== gitDir
			)
				throw new Error("Not an ordinary main checkout (bare/linked/submodule/gitfile excluded)");
			const metadata = await io.lstat(join(root, ".git"));
			if (
				!metadata.isDirectory() ||
				metadata.isSymbolicLink() ||
				!integer(metadata.dev) ||
				!integer(metadata.ino)
			)
				throw new Error("Git metadata must be a real directory with safe integer identity");
			gitDirectoryStamp = stamp(metadata);
			facts.push({ gitDirectory: gitDirectoryStamp });
			ready = true;
		} else {
			if (complex || !/not a git repository/i.test(probe.stderr))
				throw new Error("Git discovery failed or repository is unsupported");
			// Retain stage-one plain explicit non-Git cwd only, never inferred roots.
			if (candidates.some(({ row }) => !path(row.cwd) || row.cwd !== root))
				throw new Error("Non-Git adoption requires an explicit cwd");
			try {
				await io.lstat(join(root, ".git"));
				throw new Error("Unexpected Git metadata in a non-Git directory");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const shadowKey = treeSnapshotKey("local", root);
		for (const chapter of input.chapters) {
			const linked = linkedWorktrees.find((entry) => entry.sourceChapterId === chapter.id);
			const expectedShadow = linked ? treeSnapshotKey("local", linked.evidence.top) : shadowKey;
			if (present(chapter.snapshot_shadow_key) && chapter.snapshot_shadow_key !== expectedShadow)
				throw new Error("Snapshot shadow belongs to another physical workspace");
		}
		for (const linked of linkedWorktrees)
			if (!linked.narratorIds.length)
				throw new Error("Linked source has no durable narrator claimant");
		for (const { row, cwd, revision } of candidates) {
			const linked = linkedWorktrees.find((entry) => entry.narratorIds.includes(String(row.id)));
			const fresh = legacyLocalWorkspaceContext(
				cwd,
				revision,
				projectId,
				ready ? cwd : undefined,
				linked?.evidence.common,
			);
			const committed = present(row.workspace_context)
				? validateContext(row.workspace_context, fresh)
				: fresh;
			const traits = row.traits == null ? [] : json(row.traits);
			if (!Array.isArray(traits) || !traits.every((trait) => typeof trait === "string"))
				throw new Error("Invalid narrator traits");
			const supported =
				row.variant === "primary" &&
				!traits.includes("background") &&
				!traits.includes("knowledge-steward");
			if (linkedWorktrees.length && !supported)
				throw new Error(
					"Linked adoption requires an ordinary primary narrator, not a managed background variant",
				);
			const previous: WorkspaceContext = {
				...committed,
				capabilities: {
					switchDirectory: supported,
					...(!supported
						? { reason: "Only ordinary primary narrators support directory switching" }
						: {}),
				},
			};
			const { contextProjectId: _removed, ...physical } = previous;
			const current: WorkspaceContext = { ...physical, revision: revision + 1 };
			const s = directories.get(cwd);
			if (!s) throw new Error("Missing execution identity");
			updates.push({
				id: String(row.id),
				previous,
				current,
				directoryIdentity: { dev: Number(s.dev), ino: Number(s.ino) },
			});
		}
		const historyInput = {
			databasePath: input.databasePath,
			projectId,
			chapterIds: input.chapters.map((row) => String(row.id)).sort(),
			narratorIds: [...ids].sort(),
			workspacePaths: [...new Set([root, ...directories.keys()])].sort(),
			snapshotShadowKeys: [
				shadowKey,
				...linkedWorktrees.map((entry) => treeSnapshotKey("local", entry.evidence.top)),
			].sort(),
			shadowDirectories: [
				treeSnapshotPhysicalDir("local", root),
				...linkedWorktrees.map((entry) => treeSnapshotPhysicalDir("local", entry.evidence.top)),
			].sort(),
		};
		const mainCheckoutRoot = root;
		let workspaceBindings: LegacyRetainedWorkspaceBinding[] | undefined;
		if (linkedWorktrees.length) {
			if (!input.assertLinkedAdmissionReady) {
				block(
					"ADOPTION_HISTORY",
					"Linked history requires a trusted live server admission callback.",
				);
				return finish();
			}
			input.assertLinkedAdmissionReady();
			workspaceBindings = input.chapters.map((chapter) => {
				const linked = linkedWorktrees.find((entry) => entry.sourceChapterId === chapter.id);
				const workspacePath = linked?.evidence.top ?? mainCheckoutRoot;
				return {
					sourceChapterId: String(chapter.id),
					workspacePath,
					deviceId: "local",
					kind: linked ? "linked" : "root",
					shadowKey: treeSnapshotKey("local", workspacePath),
					shadowDirectory: treeSnapshotPhysicalDir("local", workspacePath),
					...(linked
						? {
								linked: {
									input: {
										projectRoot: mainCheckoutRoot,
										worktreePath: workspacePath,
										expectedBranch: String(chapter.branch),
									},
									evidence: linked.evidence,
								},
							}
						: {}),
				};
			});
		}
		const prepareRetained = () =>
			prepareLegacyRetainedHistory(
				{
					...historyInput,
					mainCheckoutRoot,
					...(workspaceBindings ? { workspaceBindings } : {}),
					narratorOrigins: candidates.map(({ row, cwd, revision }) => ({
						narratorId: String(row.id),
						sourceChapterId: row.chapter_id == null ? null : String(row.chapter_id),
						deviceId: "local",
						workspacePath: cwd,
						persistedCwd: row.cwd == null ? null : String(row.cwd),
						workspaceRevision: revision,
						workspaceContext: row.workspace_context == null ? null : String(row.workspace_context),
					})),
				},
				{ assertLinkedAdmissionReady: input.assertLinkedAdmissionReady },
			);
		if (linkedWorktrees.length) {
			history = await prepareRetained();
		} else {
			// Consumer rollout cannot make the existing strict-empty/unborn path depend on a committed HEAD.
			history = await io.history(historyInput);
			if (input.retainHistory && history.status === "history") history = await prepareRetained();
		}
		const retainedHistory = history.status === "retained" ? history : null;
		if (
			linkedWorktrees.length &&
			retainedHistory &&
			(!retainedHistory.complete ||
				!Array.isArray(retainedHistory.manifest.workspaces) ||
				linkedWorktrees.some(
					(linked) =>
						!retainedHistory.manifest.workspaces.some(
							(workspace) =>
								workspace.kind === "linked" &&
								workspace.workspacePath === linked.evidence.top &&
								workspace.sourceChapterIds.length === 1 &&
								workspace.sourceChapterIds[0] === linked.sourceChapterId &&
								workspace.commonDirectoryPath === linked.evidence.common &&
								workspace.gitAdminDirectoryPath === linked.evidence.adminDir &&
								workspace.gitfilePath === linked.evidence.gitfile &&
								workspace.branch === linked.evidence.branch &&
								workspace.headCommitSha === linked.evidence.head &&
								workspace.linkedEvidence?.digest === linked.evidence.digest,
						),
				))
		)
			block(
				"ADOPTION_HISTORY",
				"Retained proof omitted or changed a linked physical source binding.",
			);
		if (
			(history.status === "empty" || history.status === "retained") &&
			(!/^[a-f0-9]{64}$/.test(history.digest) ||
				!Array.isArray(history.guards) ||
				history.guards.length > 128 ||
				new Set(history.guards.map((guard) => guard.id)).size !== history.guards.length ||
				[...ids].some((id) => !history.guards?.some((guard) => guard.id === id)) ||
				history.guards.some(
					(guard) =>
						typeof guard.id !== "string" ||
						!guard.id ||
						guard.id.length > 1024 ||
						![guard.messageVersion, guard.messageStructureVersion, guard.nextSeq].every(integer),
				))
		)
			throw new Error("Strict history proof omitted narrator mutation guards");
		if (history.status !== "empty" && !(history.status === "retained" && history.complete))
			block("ADOPTION_HISTORY", history.reason ?? "Filesystem history is present or unknown.");
		const probeAfter = await io.spawn(probeOptions);
		facts.push({ probeAfter });
		if (JSON.stringify(probeAfter) !== JSON.stringify(probe))
			throw new Error("Git discovery changed during inspection");
		for (const linked of linkedWorktrees)
			linked.evidence = await revalidateLegacyLinkedWorktreeIdentity(
				{
					projectRoot: root,
					worktreePath: linked.evidence.top,
					expectedBranch: linked.evidence.branch,
				},
				linked.evidence,
			);
		for (const [cwd, before] of directories) {
			const after = await io.stat(cwd);
			facts.push({ cwd, after: stamp(after) });
			if (
				JSON.stringify(stamp(before)) !== JSON.stringify(stamp(after)) ||
				(await io.realpath(cwd)) !== cwd
			)
				throw new Error("Execution directory identity changed during inspection");
		}
		if (ready) {
			const after = await io.lstat(join(root, ".git"));
			facts.push({ gitDirectoryAfter: stamp(after) });
			if (
				!after.isDirectory() ||
				after.isSymbolicLink() ||
				!integer(after.dev) ||
				!integer(after.ino) ||
				JSON.stringify(gitDirectoryStamp) !== JSON.stringify(stamp(after))
			)
				throw new Error("Git metadata identity changed during inspection");
			for (const update of updates)
				update.gitDirectoryIdentity = { dev: after.dev, ino: after.ino };
		}
	} catch (error) {
		block(
			"ADOPTION_IDENTITY",
			error instanceof Error ? error.message : "Unknown adoption identity",
		);
	}
	return finish();
}
