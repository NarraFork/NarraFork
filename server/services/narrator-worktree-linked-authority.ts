import { lstatSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../db";
import {
	legacyNarratorWorkspaceAdoptions as adoptions,
	legacyRetainedChapterMetadata as chapters,
	narratorWorktreeResourceClaims as claims,
	narrators,
	narratorWorktreeResourceOrigins as origins,
	narratorWorktreeResources as resources,
} from "../db/schema";
import { AppError } from "../lib/errors";
import { safeSpawn } from "../lib/spawn";
import type { GitWorkspaceTarget } from "./git-workspace";
import { authorizeGitTargetForPrincipal } from "./git-workspace-access";
import { createLegacyLinkedWorktreeClaimsReader } from "./legacy-linked-worktree-claims";
import { canWriteNarrator, type NarratorAclRow, type NarratorPrincipal } from "./narrator-acl";
import {
	type CurrentResourceAuthority,
	validateResourceAuthority,
	WorktreeResourceError,
	withResourceDeadline,
} from "./worktree-resource-owner";

const resourceProjection = {
	id: resources.id,
	ownerNarratorId: resources.ownerNarratorId,
	deviceId: resources.deviceId,
	repositoryKey: resources.repositoryKey,
	worktreePath: resources.worktreePath,
	state: resources.state,
	scopeKind: resources.scopeKind,
	scopeProjectId: resources.scopeProjectId,
	scopeOwnerUserId: resources.scopeOwnerUserId,
	ownershipRevision: resources.ownershipRevision,
	createRequestId: resources.createRequestId,
	createdAt: resources.createdAt,
};
const aclProjection = {
	id: narrators.id,
	ownerUserId: narrators.ownerUserId,
	visibility: narrators.visibility,
	writeAudience: narrators.writeAudience,
	type: narrators.type,
	aclRootNarratorId: narrators.aclRootNarratorId,
	chapterId: narrators.chapterId,
	contextProjectId: narrators.contextProjectId,
};
function denied(): never {
	throw new AppError(
		"Current linked worktree claimant authority denied",
		403,
		"RESOURCE_ACCESS_DENIED",
	);
}

/** Portable scalar candidate lookup, never authority or owner selection. */
function possibleLinkedCandidate(rootId: string, target: GitWorkspaceTarget): boolean {
	const { workspace, backend } = target;
	if (!backend || !workspace.rootPath) return false;
	const find = (path: string) =>
		db
			.select({ id: resources.id, originId: origins.resourceId, claimId: claims.id })
			.from(resources)
			.leftJoin(origins, eq(origins.resourceId, resources.id))
			.leftJoin(claims, eq(claims.resourceId, resources.id))
			.where(and(eq(resources.deviceId, workspace.deviceId), eq(resources.worktreePath, path)))
			.limit(1)
			.get();
	const current = find(workspace.rootPath);
	if (current?.originId || current?.claimId) return true;
	const anchor = db
		.select({ cwd: adoptions.cwd, device: adoptions.deviceId })
		.from(adoptions)
		.where(eq(adoptions.narratorId, rootId))
		.limit(1)
		.get();
	if (
		!anchor ||
		anchor.device !== workspace.deviceId ||
		!backend.paths.contains(anchor.cwd, workspace.cwd)
	)
		return false;
	// Also classify a partial/missing-origin resource at the adoption path as a candidate.
	// Full validation below may return unchanged when the optional linked marker is absent.
	return !!(backend.paths.equals(anchor.cwd, workspace.rootPath) ? current : find(anchor.cwd));
}

/** Called ONLY after uncached authorizeGitTargetForPrincipal + current source/root ACL loads.
 * The resolver's ready/read capability is aggregate evidence that its project/device/OAuth/
 * execution gates all succeeded, not an admin/DTO permission override. This adapter never
 * creates a claim from cwd. An exact current-root lookup can only REQUIRE an existing binding.
 */
export async function authorizeNarratorLinkedWorktreeResource(
	principal: NarratorPrincipal,
	source: NarratorAclRow,
	root: NarratorAclRow,
	target: GitWorkspaceTarget,
	need: "read" | "write",
	signal: AbortSignal,
): Promise<void> {
	if (target.workspace.state !== "ready" || !target.backend || !target.workspace.rootPath) return;
	// The existing runtime already rejects PG before this call; never touch its unavailable
	// SQLite handle or introduce a new nonlinked PG gate here.
	if (activeDatabaseBackend !== "sqlite") return;
	signal.throwIfAborted();
	if (!possibleLinkedCandidate(root.id, target)) return;
	try {
		await withResourceDeadline(signal, (boundedSignal) =>
			validateCurrentLinkedAuthority(principal, source, root, target, need, boundedSignal),
		);
	} catch (error) {
		if (error instanceof WorktreeResourceError) throw new AppError(error.message, 503, error.code);
		throw error;
	}
}

async function validateCurrentLinkedAuthority(
	principal: NarratorPrincipal,
	source: NarratorAclRow,
	root: NarratorAclRow,
	target: GitWorkspaceTarget,
	need: "read" | "write",
	signal: AbortSignal,
): Promise<void> {
	const { workspace, backend } = target;
	if (workspace.state !== "ready" || !backend || !workspace.rootPath) return;
	const rootPath = workspace.rootPath;
	if (activeDatabaseBackend !== "sqlite") denied();
	const loadProof = () =>
		db
			.select({
				migrationProjectId: adoptions.migrationProjectId,
				cwd: adoptions.cwd,
				deviceId: adoptions.deviceId,
				proofMode: adoptions.proofMode,
				historyDigest: adoptions.historyDigest,
				directoryDev: adoptions.directoryDev,
				directoryIno: adoptions.directoryIno,
				commonDev: adoptions.gitDirectoryDev,
				commonIno: adoptions.gitDirectoryIno,
				resourceId: sql<unknown>`json_extract(${adoptions.originJson}, '$.linkedWorktree.resourceId')`,
				evidenceDigest: sql<unknown>`json_extract(${adoptions.originJson}, '$.linkedWorktree.evidenceDigest')`,
				ownershipRevision: sql<unknown>`json_extract(${adoptions.originJson}, '$.linkedWorktree.ownershipRevision')`,
				common: sql<unknown>`json_extract(${adoptions.originJson}, '$.linkedWorktree.commonDirectoryPath')`,
				admin: sql<unknown>`json_extract(${adoptions.originJson}, '$.linkedWorktree.gitAdminDirectoryPath')`,
				sourceChapterId: sql<unknown>`json_extract(${adoptions.originJson}, '$.origin.sourceChapterId')`,
			})
			.from(adoptions)
			.where(eq(adoptions.narratorId, root.id))
			.limit(1)
			.get();
	const proof = loadProof();
	const loadCurrentRoot = () =>
		db
			.select({
				...resourceProjection,
				originResourceId: origins.resourceId,
				evidenceDigest: origins.evidenceDigest,
			})
			.from(resources)
			.leftJoin(origins, eq(origins.resourceId, resources.id))
			.where(and(eq(resources.deviceId, workspace.deviceId), eq(resources.worktreePath, rootPath)))
			.limit(1)
			.get();
	const currentRoot = loadCurrentRoot();
	const proofTargetsCurrentRoot =
		!!proof &&
		proof.deviceId === workspace.deviceId &&
		backend.paths.equals(proof.cwd, workspace.rootPath);
	const proofTargetsCurrentCwd =
		!!proof &&
		proof.deviceId === workspace.deviceId &&
		backend.paths.contains(proof.cwd, workspace.cwd);
	const protectedAnchor =
		proofTargetsCurrentCwd && proof
			? db
					.select({ originId: origins.resourceId, claimId: claims.id })
					.from(resources)
					.leftJoin(origins, eq(origins.resourceId, resources.id))
					.leftJoin(claims, eq(claims.resourceId, resources.id))
					.where(
						and(eq(resources.deviceId, workspace.deviceId), eq(resources.worktreePath, proof.cwd)),
					)
					.limit(1)
					.get()
			: null;
	if (
		proofTargetsCurrentCwd &&
		(proof?.resourceId != null || protectedAnchor?.originId || protectedAnchor?.claimId) &&
		(!proofTargetsCurrentRoot || proof?.resourceId == null)
	)
		denied();
	// Presence is protection/lineage evidence only: never select this row as an owner.
	const hasDurableClaim =
		!!currentRoot &&
		!!db
			.select({ id: claims.id })
			.from(claims)
			.where(eq(claims.resourceId, currentRoot.id))
			.limit(1)
			.get();
	if (
		!currentRoot?.originResourceId &&
		!hasDurableClaim &&
		!(proofTargetsCurrentRoot && proof?.resourceId != null)
	)
		return;
	// A different current cwd/root must not keep a session permanently bound to its old resource.
	// Conversely, foreign/same-cwd sessions can never obtain a claim from this indexed lookup.
	if (
		!currentRoot?.originResourceId ||
		currentRoot.state !== "ready" ||
		!currentRoot.scopeOwnerUserId ||
		currentRoot.scopeKind === "unknown" ||
		!proof ||
		!proofTargetsCurrentRoot ||
		typeof proof.resourceId !== "string" ||
		proof.resourceId !== currentRoot.id ||
		proof.ownershipRevision !== currentRoot.ownershipRevision ||
		proof.evidenceDigest !== currentRoot.evidenceDigest ||
		target.repositoryPath == null ||
		workspace.repositoryKey !== currentRoot.repositoryKey ||
		backend.kind !== "local" ||
		workspace.deviceId !== "local" ||
		(source.type !== "primary" && source.type !== "subagent")
	)
		denied();
	// New filesystem/authority gates apply only to a positively identified linked candidate.
	const canonicalCwd = await realpath(workspace.cwd).catch(() => null);
	if (!canonicalCwd || !backend.paths.contains(workspace.rootPath, canonicalCwd)) denied();
	const probe = await safeSpawn({
		cmd: [
			"git",
			"--no-optional-locks",
			"-C",
			workspace.cwd,
			"rev-parse",
			"--path-format=absolute",
			"--show-toplevel",
			"--git-common-dir",
			"--absolute-git-dir",
		],
		env: {
			...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
			LC_ALL: "C",
			LANG: "C",
		},
		timeout: 5000,
		maxOutputBytes: 16384,
		signal,
	});
	const lines = probe.stdout.trim().split("\n");
	if (probe.exitCode !== 0 || probe.stdoutTruncated || probe.stderrTruncated || lines.length !== 3)
		denied();
	const [actualRoot, actualCommon, actualAdmin] = await Promise.all(
		lines.map((path) => realpath(path).catch(() => null)),
	);
	if (
		!actualRoot ||
		!actualCommon ||
		!actualAdmin ||
		!backend.paths.equals(actualRoot, workspace.rootPath) ||
		!target.repositoryPath ||
		!backend.paths.equals(actualCommon, target.repositoryPath)
	)
		denied();
	// Same spelling is not the same incarnation. Inspect only immutable directory/gitfile
	// identity, not HEAD/index/reflog stamps, so ordinary commits remain ordinary operations.
	const gitfile = join(workspace.rootPath, ".git");
	const recorded = db
		.select({
			path: sql<string>`json_extract(linked_identity.value, '$.path')`,
			kind: sql<unknown>`json_extract(linked_identity.value, '$.kind')`,
			dev: sql<unknown>`json_extract(linked_identity.value, '$.dev')`,
			ino: sql<unknown>`json_extract(linked_identity.value, '$.ino')`,
		})
		.from(origins)
		.innerJoin(
			sql`json_each(${origins.evidenceJson}, '$.metadata') AS linked_identity`,
			sql`json_extract(linked_identity.value, '$.path') IN (${actualAdmin}, ${gitfile})`,
		)
		.where(eq(origins.resourceId, currentRoot.id))
		.limit(3)
		.all();
	const [rootStat, commonStat, adminStat, gitfileStat] = await Promise.all(
		[actualRoot, actualCommon, actualAdmin, gitfile].map((path) =>
			lstat(path, { bigint: true }).catch(() => null),
		),
	);
	const sameDirectory = (value: typeof rootStat, dev: unknown, ino: unknown) =>
		!!value &&
		value.isDirectory() &&
		!value.isSymbolicLink() &&
		typeof dev === "string" &&
		typeof ino === "string" &&
		String(value.dev) === dev &&
		String(value.ino) === ino;
	const adminIdentity = recorded.find((entry) => entry.path === actualAdmin);
	const fileIdentity = recorded.find((entry) => entry.path === gitfile);
	if (
		recorded.length !== 2 ||
		!sameDirectory(rootStat, proof.directoryDev, proof.directoryIno) ||
		!sameDirectory(commonStat, proof.commonDev, proof.commonIno) ||
		adminIdentity?.kind !== "directory" ||
		!sameDirectory(adminStat, adminIdentity.dev, adminIdentity.ino) ||
		fileIdentity?.kind !== "file" ||
		!gitfileStat?.isFile() ||
		gitfileStat.isSymbolicLink() ||
		typeof fileIdentity.dev !== "string" ||
		typeof fileIdentity.ino !== "string" ||
		String(gitfileStat.dev) !== fileIdentity.dev ||
		String(gitfileStat.ino) !== fileIdentity.ino
	)
		denied();
	// Native probing yielded: refresh the actual resolver, including current project/device/
	// OAuth/execution guards, instead of copying old 'allowed' flags over a revocation window.
	const refreshed = await authorizeGitTargetForPrincipal(
		principal,
		{ narratorId: source.id },
		need,
		signal,
	);
	if (
		refreshed.workspace.state !== "ready" ||
		refreshed.workspace.capabilities.read !== true ||
		refreshed.workspace.deviceId !== workspace.deviceId ||
		refreshed.workspace.workspaceKey !== workspace.workspaceKey ||
		refreshed.workspace.repositoryKey !== workspace.repositoryKey ||
		refreshed.workspace.rootPath !== workspace.rootPath ||
		refreshed.repositoryPath !== target.repositoryPath ||
		refreshed.contextProjectId !== target.contextProjectId
	)
		denied();
	const canWrite =
		refreshed.workspace.capabilities.write &&
		(await canWriteNarrator(source, principal)) &&
		(await canWriteNarrator(root, principal));
	signal.throwIfAborted();
	// No async gap remains between current snapshots and shared authority validation.
	if (
		JSON.stringify(loadProof()) !== JSON.stringify(proof) ||
		JSON.stringify(loadCurrentRoot()) !== JSON.stringify(currentRoot)
	)
		denied();
	for (const expected of [source, root]) {
		const current = db
			.select(aclProjection)
			.from(narrators)
			.where(eq(narrators.id, expected.id))
			.limit(1)
			.get();
		if (
			!current ||
			Object.entries(current).some(
				([key, value]) => expected[key as keyof NarratorAclRow] !== value,
			)
		)
			denied();
	}
	const linked = createLegacyLinkedWorktreeClaimsReader(db).readSummary(currentRoot.id, root.id);
	if (
		!linked.origin ||
		!linked.claim ||
		linked.origin.migrationProjectId !== proof.migrationProjectId ||
		linked.claim.sourceChapterId !== proof.sourceChapterId ||
		linked.claim.migrationProjectId !== proof.migrationProjectId ||
		linked.origin.commonDirectoryPath !== proof.common ||
		linked.origin.gitAdminDirectoryPath !== proof.admin ||
		!backend.paths.equals(target.repositoryPath, linked.origin.commonDirectoryPath) ||
		!actualAdmin ||
		!backend.paths.equals(actualAdmin, linked.origin.gitAdminDirectoryPath)
	)
		denied();
	// Each claim closes its own archived chapter namespace; the origin chapter is only an anchor.
	if (proof.proofMode === "retained") {
		const archive = db
			.select({ migration: chapters.migrationProjectId, digest: chapters.manifestDigest })
			.from(chapters)
			.where(eq(chapters.sourceChapterId, linked.claim.sourceChapterId))
			.limit(1)
			.get();
		if (
			!archive ||
			archive.migration !== proof.migrationProjectId ||
			archive.digest !== proof.historyDigest
		)
			denied();
	} else {
		// Empty-history linked namespace proof is not implemented by this production adapter.
		throw new AppError(
			"Linked empty-history authority proof unsupported",
			409,
			"RESOURCE_CAPABILITY_UNSUPPORTED",
		);
	}
	const currentSession = db
		.select({
			mode: sql<unknown>`json_extract(${narrators.workspaceContext}, '$.mode')`,
			contextCwd: sql<unknown>`json_extract(${narrators.workspaceContext}, '$.cwd')`,
			contextDevice: sql<unknown>`json_extract(${narrators.workspaceContext}, '$.deviceId')`,
			contextRevision: sql<unknown>`json_extract(${narrators.workspaceContext}, '$.revision')`,
			revision: narrators.workspaceRevision,
		})
		.from(narrators)
		.where(eq(narrators.id, source.id))
		.limit(1)
		.get();
	if (!currentSession) denied();
	const mode = currentSession.mode;
	if (mode != null && mode !== "normal" && mode !== "readonly") denied();
	if (
		currentSession.contextRevision === currentSession.revision &&
		(typeof currentSession.contextCwd !== "string" ||
			!backend.paths.equals(currentSession.contextCwd, workspace.cwd) ||
			currentSession.contextDevice !== workspace.deviceId)
	)
		denied();
	const verifiedRead =
		refreshed.workspace.state === "ready" && refreshed.workspace.capabilities.read === true;
	const localDevice = backend.kind === "local" && workspace.deviceId === "local";
	const authority: CurrentResourceAuthority = {
		actorUserId: principal.userId,
		scopeOwnerUserId: root.ownerUserId ?? "",
		contextProjectId: target.contextProjectId ?? null,
		rootNarratorId: root.id,
		sessionNarratorId: source.id,
		sessionType: source.type,
		sessionAclRootNarratorId: source.aclRootNarratorId,
		sourceNarratorId: root.id,
		sourceRootNarratorId: root.id,
		basis: "sourceRoot",
		backend: activeDatabaseBackend,
		workspaceKind: workspace.rootPath && target.repositoryPath ? "git" : "directory",
		workspaceMode: mode === "readonly" ? "readonly" : "normal",
		deviceId: workspace.deviceId,
		canonicalWorktreePath: workspace.rootPath,
		repositoryKey: workspace.repositoryKey ?? "",
		complete: verifiedRead && localDevice,
		readAllowed: verifiedRead,
		writeAllowed: canWrite,
		// ready/read is only assigned after all four real resolver guard families pass.
		projectAllowed: verifiedRead,
		deviceAllowed: verifiedRead && localDevice,
		oauthAllowed: verifiedRead && localDevice,
		executionAllowed: verifiedRead,
	};
	// Resolver/ACL refreshes yielded after the first native snapshot. Close that gap in
	// this final no-await section with exactly four small metadata reads. Do not pin
	// HEAD, index, timestamps or directory contents: normal commits remain valid.
	for (const { path, before, file } of [
		{ path: actualRoot, before: rootStat, file: false },
		{ path: actualCommon, before: commonStat, file: false },
		{ path: actualAdmin, before: adminStat, file: false },
		{ path: gitfile, before: gitfileStat, file: true },
	]) {
		let after: NonNullable<typeof before>;
		try {
			after = lstatSync(path, { bigint: true });
		} catch {
			denied();
		}
		if (
			!before ||
			after.isSymbolicLink() ||
			(file ? !after.isFile() : !after.isDirectory()) ||
			after.dev !== before.dev ||
			after.ino !== before.ino
		)
			denied();
	}
	try {
		validateResourceAuthority(currentRoot, authority, need, linked);
		// Listing must not advertise create when the current linked context is readonly.
		workspace.capabilities.write &&= authority.writeAllowed && authority.workspaceMode === "normal";
	} catch (error) {
		if (error instanceof WorktreeResourceError) throw new AppError(error.message, 403, error.code);
		throw error;
	}
}
