import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db";
import { aclGrants, chapters, projects, remoteDevices, users } from "../db/schema";
import { AppError } from "../lib/errors";
import { isSecretPlatformPath, isSecretUserPath } from "../lib/fs-secret-paths";
import { logger } from "../lib/logger";
import { narratorPrincipalOf } from "../lib/narrator-access";
import { getHome } from "../lib/platform";
import { narraforkDir } from "../lib/settings";
import { isDeviceAuthorized } from "./device-service";
import { executionPolicyEngine } from "./execution-policy/engine";
import type { ExecutionDeviceClass, ExecutionTargetContext } from "./execution-policy/types";
import {
	type GitWorkspaceTarget,
	resolveChapterGitTarget,
	resolveNarratorGitTarget,
} from "./git-workspace";
import {
	ACCESS_PAGE_SIZE,
	accessCheckUnavailable,
	GitAccessScan,
} from "./git-workspace-access-scan";
import { gitPathPolicyAllows } from "./git-workspace-path-policy";
import { integrationResourceBindingService } from "./integration-resource-binding-service";
import { canWriteNarrator, loadNarratorForAccess, type NarratorPrincipal } from "./narrator-acl";
import { resolveOAuthDeviceRuntimeAuthorization } from "./oauth-device-runtime-policy";
import { resolveOAuthNarratorRuntimePolicy } from "./oauth-narrator-runtime-policy";
import { assertChapterProjectAccess, hasProjectAccess, loadProjectForAccess } from "./project-acl";

const denied = () =>
	new AppError("Git workspace access denied", 403, "GIT_WORKSPACE_ACCESS_DENIED");

const MAX_RELATED_GIT_PROJECTS = 512;
const MAX_RELATED_GIT_GRANTS = 2048;
const MAX_RELATED_GIT_FINGERPRINT_BYTES = 256 * 1024;

/** Identity-only stamp for this already-matched project set; never grants path/device authority. */
function captureRelatedProjectAuthority(projectIds: string[], principal: NarratorPrincipal) {
	const ids = [...new Set(projectIds)].sort();
	if (ids.length > MAX_RELATED_GIT_PROJECTS) throw accessCheckUnavailable();
	const snapshot = () => {
		const actor = db
			.select({ id: users.id, role: users.role })
			.from(users)
			.where(eq(users.id, principal.userId))
			.get();
		if (!actor || (actor.role === "admin") !== principal.isAdmin) throw denied();
		const rows = ids.length
			? db
					.select({
						id: projects.id,
						ownerUserId: projects.ownerUserId,
						visibility: projects.visibility,
						gitPath: sql<string | null>`substr(${projects.gitPath}, 1, 4097)`,
						gitPathLength: sql<number | null>`length(${projects.gitPath})`,
					})
					.from(projects)
					.where(inArray(projects.id, ids))
					.orderBy(asc(projects.id))
					.limit(MAX_RELATED_GIT_PROJECTS + 1)
					.all()
			: [];
		if (rows.length !== ids.length) throw denied();
		if (rows.some((row) => (row.gitPathLength ?? 0) > 4096)) throw accessCheckUnavailable();
		const grants = ids.length
			? db
					.select({
						id: aclGrants.id,
						scopeType: aclGrants.scopeType,
						scopeId: aclGrants.scopeId,
						principalType: aclGrants.principalType,
						principalId: aclGrants.principalId,
						capability: aclGrants.capability,
						domainKind: aclGrants.domainKind,
						domainValue: sql<string | null>`substr(${aclGrants.domainValue}, 1, 4097)`,
						domainValueLength: sql<number | null>`length(${aclGrants.domainValue})`,
					})
					.from(aclGrants)
					.where(
						and(
							or(
								and(
									eq(aclGrants.principalType, "user"),
									eq(aclGrants.principalId, principal.userId),
								),
								and(
									eq(aclGrants.principalType, "role"),
									eq(aclGrants.principalId, principal.isAdmin ? "admin" : "user"),
								),
							),
							or(
								and(eq(aclGrants.scopeType, "global"), isNull(aclGrants.scopeId)),
								and(eq(aclGrants.scopeType, "project"), inArray(aclGrants.scopeId, ids)),
							),
						),
					)
					.orderBy(asc(aclGrants.id))
					.limit(MAX_RELATED_GIT_GRANTS + 1)
					.all()
			: [];
		if (
			grants.length > MAX_RELATED_GIT_GRANTS ||
			grants.some((row) => (row.domainValueLength ?? 0) > 4096)
		)
			throw accessCheckUnavailable();
		let bytes = 0;
		const hash = createHash("sha256");
		for (const row of [actor, ...rows, ...grants]) {
			const chunk = JSON.stringify(row);
			bytes += Buffer.byteLength(chunk);
			if (bytes > MAX_RELATED_GIT_FINGERPRINT_BYTES) throw accessCheckUnavailable();
			hash.update(chunk);
		}
		return { rows, fingerprint: hash.digest("hex") };
	};
	// Synchronous baseline precedes the FIRST project hasProjectAccess await.
	const before = snapshot();
	return {
		rows: before.rows,
		assertStillCurrent() {
			if (snapshot().fingerprint !== before.fingerprint) throw denied();
		},
	};
}

function redactDeniedTarget(target: GitWorkspaceTarget): void {
	const { workspace } = target;
	workspace.state = "access_denied";
	workspace.reason = "Current permissions do not allow management of the Git working tree";
	workspace.capabilities = { read: false, write: false };
	// A public narrator must not disclose a private repository path or stable hash.
	workspace.cwd = "";
	workspace.rootPath = null;
	workspace.workspaceKey = null;
	workspace.repositoryKey = null;
	delete workspace.contextKey;
	delete workspace.workspaceRevision;
	delete workspace.chapterId;
	delete workspace.projectId;
	delete target.repositoryPath;
	delete workspace.branch;
}

async function requireSafeLocalGitPath(target: GitWorkspaceTarget, path: string): Promise<void> {
	const backend = target.backend;
	if (!backend || backend.kind !== "local") return;
	const [home, nf] = await Promise.all([
		realpath(getHome()).catch(() => getHome()),
		realpath(narraforkDir).catch(() => narraforkDir),
	]);
	if (
		isSecretPlatformPath(path, nf) ||
		isSecretUserPath(path, home) ||
		backend.paths.contains(path, nf) ||
		[".ssh", ".aws", ".gnupg", ".kube"].some((part) =>
			backend.paths.contains(path, backend.paths.resolve(home, part)),
		)
	)
		throw denied();
}

export { gitPathPolicyAllows } from "./git-workspace-path-policy";

function ancestors(path: string, target: GitWorkspaceTarget): string[] {
	const paths = target.backend?.paths;
	if (!paths) return [path];
	const result = [path];
	while (result.length < 128) {
		const parent = paths.dirname(result[result.length - 1]);
		if (paths.equals(parent, result[result.length - 1])) break;
		result.push(parent);
	}
	return result;
}

/** Bound both rows and fields. Standalone cwd must not bypass a protected project's ACL. */
async function relatedProjects(
	target: GitWorkspaceTarget,
	scan: GitAccessScan,
	principal: NarratorPrincipal,
) {
	if (
		principal.isAdmin ||
		!target.backend ||
		target.backend.kind !== "local" ||
		!target.workspace.rootPath
	)
		return [];
	// Owner/admin always pass both project gates. Their associations cannot narrow
	// capabilities, so do not enumerate/realpath their entire project inventory on
	// first paint. Foreign (including null-owner) aliases still fail closed and
	// receive fresh ACL checks; no permission verdict is cached.
	const foreignProject = or(
		isNull(projects.ownerUserId),
		ne(projects.ownerUserId, principal.userId),
	);
	const root = target.workspace.rootPath;
	const candidates = new Set([
		...ancestors(root, target),
		...ancestors(target.workspace.cwd, target),
		...(target.repositoryPath
			? ancestors(target.backend.paths.dirname(target.repositoryPath), target)
			: []),
	]);
	const escaped = `${root.replace(/[\\%_]/g, "\\$&")}/%`;
	const fields = {
		id: projects.id,
		ownerUserId: projects.ownerUserId,
		visibility: projects.visibility,
		gitPath: projects.gitPath,
	};
	type Project = Pick<typeof projects.$inferSelect, keyof typeof fields>;
	const matches = new Map<string, Project>();
	const addMatch = (row: Project) => {
		if (!matches.has(row.id) && matches.size >= MAX_RELATED_GIT_PROJECTS)
			throw accessCheckUnavailable();
		matches.set(row.id, row);
	};
	for await (const page of scan.pagesOf((cursor) =>
		db
			.select(fields)
			.from(projects)
			.where(
				and(
					foreignProject,
					cursor ? gt(projects.id, cursor) : undefined,
					or(
						inArray(projects.gitPath, [...candidates]),
						sql`${projects.gitPath} like ${escaped} escape '\\'`,
					),
				),
			)
			.orderBy(asc(projects.id))
			.limit(ACCESS_PAGE_SIZE),
	)) {
		for (const row of page) addMatch(row);
	}
	for await (const page of scan.pagesOf((cursor) =>
		db
			.select({ id: chapters.id, projectId: chapters.projectId })
			.from(chapters)
			.where(
				and(
					cursor ? gt(chapters.id, cursor) : undefined,
					inArray(chapters.worktreePath, [...candidates]),
				),
			)
			.orderBy(asc(chapters.id))
			.limit(ACCESS_PAGE_SIZE),
	)) {
		const missing = [...new Set(page.map((row) => row.projectId))].filter((id) => !matches.has(id));
		if (!missing.length) continue;
		const rows = await scan.run(() =>
			db
				.select(fields)
				.from(projects)
				.where(and(foreignProject, inArray(projects.id, missing)))
				.limit(ACCESS_PAGE_SIZE),
		);
		for (const row of rows) addMatch(row);
	}
	// Registered symlink aliases can occur anywhere in the project table.
	const paths = target.backend.paths;
	for await (const page of scan.pagesOf((cursor) =>
		db
			.select(fields)
			.from(projects)
			.where(and(foreignProject, cursor ? gt(projects.id, cursor) : undefined))
			.orderBy(asc(projects.id))
			.limit(ACCESS_PAGE_SIZE),
	)) {
		await scan.canonicalize(
			page.filter((row) => !matches.has(row.id)),
			(project, path) => {
				if (
					paths.contains(path, root) ||
					paths.contains(root, path) ||
					(target.repositoryPath && paths.contains(path, target.repositoryPath))
				)
					addMatch(project);
			},
		);
	}
	return [...matches.values()];
}

export async function authorizeGitTarget(
	c: Context,
	source: { narratorId: string } | { chapterId: string },
	need: "read" | "write",
): Promise<GitWorkspaceTarget> {
	return authorizeGitTargetForPrincipal(narratorPrincipalOf(c), source, need, c.req.raw.signal);
}

/** Shared by HTTP and authenticated workspace WebSocket subscriptions. */
export async function authorizeGitTargetForPrincipal(
	principal: NarratorPrincipal,
	source: { narratorId: string } | { chapterId: string },
	need: "read" | "write",
	signal: AbortSignal,
	cachedDiscovery = false,
): Promise<GitWorkspaceTarget> {
	// HTTP tokens and WS upgrade roles are historical claims, never current authority.
	const actorId = principal.userId;
	const user = await db.query.users.findFirst({
		where: eq(users.id, actorId),
		columns: { role: true },
	});
	if (!user) throw denied();
	principal = { userId: actorId, isAdmin: user.role === "admin" };
	const expectedRole = user.role;
	const assertPrincipalStillCurrent = () => {
		const live = db.select({ role: users.role }).from(users).where(eq(users.id, actorId)).get();
		if (!live || live.role !== expectedRole) throw denied();
	};
	let canWrite = true;
	let policy: Awaited<ReturnType<typeof resolveOAuthNarratorRuntimePolicy>> = null;
	let deviceClass: ExecutionDeviceClass | null = null;
	const narratorExecution: {
		context: ExecutionTargetContext | null;
		policy: Awaited<ReturnType<typeof executionPolicyEngine.compile>> | null;
	} = { context: null, policy: null };
	let target: GitWorkspaceTarget;
	if ("narratorId" in source) {
		const narrator = await loadNarratorForAccess(source.narratorId, principal, need);
		canWrite = await canWriteNarrator(narrator, principal);
		policy = await resolveOAuthNarratorRuntimePolicy(source.narratorId, principal.userId);
		target = await resolveNarratorGitTarget(
			source.narratorId,
			signal,
			async (initial) => {
				assertPrincipalStillCurrent();
				if (initial.contextProjectId) {
					const project = await loadProjectForAccess(initial.contextProjectId, principal, need);
					canWrite &&= await hasProjectAccess(project, principal, "write");
				}
				const id = initial.workspace.deviceId;
				if (id !== "local") {
					const device = await db.query.remoteDevices.findFirst({
						where: eq(remoteDevices.id, id),
					});
					if (
						!device ||
						device.revokedAt ||
						!isDeviceAuthorized(device, {
							userId: principal.userId,
							projectId: initial.contextProjectId,
						})
					)
						throw denied();
					const authorization = await resolveOAuthDeviceRuntimeAuthorization(device);
					const level = authorization.policy?.deviceAccess.selfRegistered;
					if (
						!authorization.allowed ||
						(authorization.oauthOwned && level !== "readOnly" && level !== "readWrite")
					)
						throw denied();
					canWrite &&= !authorization.oauthOwned || level === "readWrite";
					if (need === "write" && !canWrite) throw denied();
				}
				if (policy) {
					if (id === "local" ? !policy.allowLocalExecution : !policy.deviceIds.includes(id))
						throw denied();
					const binding =
						id === "local" ? null : await integrationResourceBindingService.get("device", id);
					deviceClass =
						id === "local"
							? "host"
							: binding?.sourceType === "oauth_client" &&
									binding.sourceId === policy.clientId &&
									binding.authorityId === policy.grantId
								? "selfRegistered"
								: "global";
					const level = policy.policy.deviceAccess[deviceClass];
					if (level === "denied" || !policy.allowedTools.has("Read")) throw denied();
					canWrite &&= level === "readWrite" && policy.allowedTools.has("Bash");
					if (need === "write" && !canWrite) throw denied();
				}
			},
			async (initial) => {
				const { backend, workspace } = initial;
				if (!backend) throw denied();
				await requireSafeLocalGitPath(initial, workspace.cwd);
				narratorExecution.context = {
					backend,
					paths: backend.paths,
					deviceClass,
					target: {
						deviceId: workspace.deviceId,
						backendKind: backend.kind,
						cwd: workspace.cwd,
						lexicalPath: workspace.cwd,
						canonicalPath: workspace.cwd,
						pathFlavor: backend.pathFlavor,
						runtimeGeneration: backend.runtimeGeneration,
						selectionSource: "session_default",
					},
				};
				narratorExecution.policy = await executionPolicyEngine.compile(
					source.narratorId,
					narratorExecution.context,
					policy?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
				);
				if (
					!gitPathPolicyAllows(
						narratorExecution.policy,
						narratorExecution.context,
						workspace.cwd,
						"read",
					)
				)
					throw denied();
				canWrite &&= gitPathPolicyAllows(
					narratorExecution.policy,
					narratorExecution.context,
					workspace.cwd,
					"write",
				);
				if (need === "write" && !canWrite) throw denied();
			},
			cachedDiscovery && need === "read",
			{ userId: principal.userId },
		);
	} else {
		await assertChapterProjectAccess(source.chapterId, principal, need);
		target = await resolveChapterGitTarget(source.chapterId, signal);
		if (target.contextProjectId)
			canWrite = await hasProjectAccess(
				await loadProjectForAccess(target.contextProjectId, principal, "read"),
				principal,
				"write",
			);
	}
	const { workspace, backend } = target;
	if (workspace.state !== "ready" || !backend || !workspace.rootPath) {
		if (workspace.state === "access_denied") redactDeniedTarget(target);
		return target;
	}
	const root = workspace.rootPath;
	const scan = new GitAccessScan(signal);
	try {
		const matchedProjects = await relatedProjects(target, scan, principal);
		const relatedAuthority = captureRelatedProjectAuthority(
			matchedProjects.map((project) => project.id),
			principal,
		);
		const endpointFence = target.assertStillCurrent;
		target.assertStillCurrent = () => {
			assertPrincipalStillCurrent();
			relatedAuthority.assertStillCurrent();
			endpointFence?.();
		};
		for (const project of relatedAuthority.rows) {
			if (!(await scan.run(() => hasProjectAccess(project, principal, "read")))) throw denied();
			canWrite &&= await scan.run(() => hasProjectAccess(project, principal, "write"));
		}
		await scan.run(() => requireSafeLocalGitPath(target, root));
		if ("narratorId" in source) {
			const context = narratorExecution.context;
			const compiled = narratorExecution.policy;
			if (!context || !compiled) throw denied();
			if (!gitPathPolicyAllows(compiled, context, root, "read")) throw denied();
			canWrite &&= gitPathPolicyAllows(compiled, context, root, "write");
			if (target.repositoryPath) {
				if (!gitPathPolicyAllows(compiled, context, target.repositoryPath, "read")) throw denied();
				canWrite &&= gitPathPolicyAllows(compiled, context, target.repositoryPath, "write");
			}
			if (policy && policy.permissionMode !== "bypassPermissions") {
				if (
					compiled.evaluatePath({ path: root, operation: "read" }).decision !== "allow" &&
					!backend.paths.contains(workspace.cwd, root)
				)
					throw denied();
				canWrite &&= compiled.evaluatePath({ path: root, operation: "write" }).decision === "allow";
			}
		}
		if (need === "write" && !canWrite) throw denied();
		scan.check();
		assertPrincipalStillCurrent();
		target.assertStillCurrent?.();
		workspace.capabilities = { read: true, write: canWrite };
	} catch (error) {
		if (!(error instanceof AppError) || error.statusCode !== 403) throw error;
		redactDeniedTarget(target);
	} finally {
		scan.dispose();
		const elapsedMs = Math.round(performance.now() - scan.started);
		if (elapsedMs >= 1000)
			logger.warn("Slow Git workspace access check", {
				elapsedMs,
				pages: scan.pages,
				rows: scan.rows,
			});
	}
	return target;
}

export function requireReadyGitTarget(
	target: GitWorkspaceTarget,
	need: "read" | "write",
): asserts target is GitWorkspaceTarget & { backend: NonNullable<GitWorkspaceTarget["backend"]> } {
	if (target.workspace.state !== "ready" || !target.workspace.capabilities[need])
		throw new AppError(
			target.workspace.reason ?? "Git workspace unavailable",
			target.workspace.state === "access_denied" ? 403 : 409,
			"GIT_WORKSPACE_UNAVAILABLE",
		);
}
