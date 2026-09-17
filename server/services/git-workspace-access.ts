import { realpath } from "node:fs/promises";
import { eq, inArray, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db";
import { chapters, projects, remoteDevices } from "../db/schema";
import { AppError } from "../lib/errors";
import { isSecretPlatformPath, isSecretUserPath } from "../lib/fs-secret-paths";
import { narratorPrincipalOf, requireNarratorAccess } from "../lib/narrator-access";
import { getHome } from "../lib/platform";
import { requireChapterAccess } from "../lib/project-access";
import { narraforkDir } from "../lib/settings";
import { isDeviceAuthorized } from "./device-service";
import type { CompiledExecutionPolicy } from "./execution-policy/compiler";
import { executionPolicyEngine } from "./execution-policy/engine";
import type { ExecutionDeviceClass, ExecutionTargetContext } from "./execution-policy/types";
import {
	type GitWorkspaceTarget,
	resolveChapterGitTarget,
	resolveNarratorGitTarget,
} from "./git-workspace";
import { integrationResourceBindingService } from "./integration-resource-binding-service";
import { canWriteNarrator } from "./narrator-acl";
import { resolveOAuthDeviceRuntimeAuthorization } from "./oauth-device-runtime-policy";
import { resolveOAuthNarratorRuntimePolicy } from "./oauth-narrator-runtime-policy";
import { hasProjectAccess, loadProjectForAccess } from "./project-acl";

const denied = () =>
	new AppError("Git workspace access denied", 403, "GIT_WORKSPACE_ACCESS_DENIED");

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
	delete workspace.chapterId;
	delete workspace.projectId;
	delete target.repositoryPath;
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

/** A whole-tree operation cannot skip forbidden descendants or widen a subtree grant. */
export function gitPathPolicyAllows(
	policy: CompiledExecutionPolicy,
	context: ExecutionTargetContext,
	root: string,
	need: "read" | "write",
): boolean {
	const paths = context.paths;
	if (
		policy.directoryBlacklist.some(
			(rule) =>
				rule.enabled &&
				(rule.denyLevel === "denyAll" || need === "write") &&
				(paths.contains(root, rule.path) || paths.contains(rule.path, root)),
		)
	)
		return false;
	const decision = policy.evaluatePath({ path: root, operation: need });
	if (decision.decision === "deny") return false;
	// An explicit narrower grant is not permission to manage its containing repository.
	const scoped = policy.directoryWhitelist.filter(
		(rule) => paths.contains(root, rule.path) || paths.contains(rule.path, root),
	);
	if (scoped.length > 0 && decision.decision !== "allow") return false;
	return true;
}

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
async function relatedProjects(target: GitWorkspaceTarget) {
	if (!target.backend || target.backend.kind !== "local" || !target.workspace.rootPath) return [];
	const root = target.workspace.rootPath;
	const candidates = new Set([
		...ancestors(root, target),
		...ancestors(target.workspace.cwd, target),
		...(target.repositoryPath
			? ancestors(target.backend.paths.dirname(target.repositoryPath), target)
			: []),
	]);
	const escaped = `${root.replace(/[\\%_]/g, "\\$&")}/%`;
	const rows = await db
		.select({
			id: projects.id,
			ownerUserId: projects.ownerUserId,
			visibility: projects.visibility,
			gitPath: projects.gitPath,
		})
		.from(projects)
		.where(
			or(
				inArray(projects.gitPath, [...candidates]),
				sql`${projects.gitPath} like ${escaped} escape '\\'`,
			),
		)
		.limit(257);
	const chapterRows = await db
		.select({ projectId: chapters.projectId })
		.from(chapters)
		.where(inArray(chapters.worktreePath, [...candidates]))
		.limit(257);
	if (rows.length > 256 || chapterRows.length > 256) throw denied();
	const missing = [...new Set(chapterRows.map((row) => row.projectId))].filter(
		(id) => !rows.some((row) => row.id === id),
	);
	if (missing.length)
		rows.push(
			...(await db
				.select({
					id: projects.id,
					ownerUserId: projects.ownerUserId,
					visibility: projects.visibility,
					gitPath: projects.gitPath,
				})
				.from(projects)
				.where(inArray(projects.id, missing))
				.limit(256)),
		);
	// A project may have been registered through a symlink. Lexical SQL matching
	// alone would let a standalone narrator use its physical spelling to bypass ACL.
	// Bound metadata and asynchronous canonicalization; never read project content.
	const aliases = await db
		.select({
			id: projects.id,
			ownerUserId: projects.ownerUserId,
			visibility: projects.visibility,
			gitPath: projects.gitPath,
		})
		.from(projects)
		.limit(257);
	if (aliases.length > 256) throw denied();
	for (let start = 0; start < aliases.length; start += 8) {
		const canonical = await Promise.all(
			aliases.slice(start, start + 8).map(async (project) => ({
				project,
				path: project.gitPath ? await realpath(project.gitPath).catch(() => null) : null,
			})),
		);
		for (const item of canonical) {
			if (!item.path || rows.some((row) => row.id === item.project.id)) continue;
			const paths = target.backend.paths;
			if (
				paths.contains(item.path, root) ||
				paths.contains(root, item.path) ||
				(target.repositoryPath && paths.contains(item.path, target.repositoryPath))
			)
				rows.push(item.project);
		}
	}
	return rows;
}

export async function authorizeGitTarget(
	c: Context,
	source: { narratorId: string } | { chapterId: string },
	need: "read" | "write",
): Promise<GitWorkspaceTarget> {
	const principal = narratorPrincipalOf(c);
	const signal = c.req.raw.signal;
	let canWrite = true;
	let policy: Awaited<ReturnType<typeof resolveOAuthNarratorRuntimePolicy>> = null;
	let deviceClass: ExecutionDeviceClass | null = null;
	const narratorExecution: {
		context: ExecutionTargetContext | null;
		policy: Awaited<ReturnType<typeof executionPolicyEngine.compile>> | null;
	} = { context: null, policy: null };
	let target: GitWorkspaceTarget;
	if ("narratorId" in source) {
		const narrator = await requireNarratorAccess(c, source.narratorId, need);
		canWrite = await canWriteNarrator(narrator, principal);
		policy = await resolveOAuthNarratorRuntimePolicy(source.narratorId);
		target = await resolveNarratorGitTarget(
			source.narratorId,
			signal,
			async (initial) => {
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
						}) ||
						!(await resolveOAuthDeviceRuntimeAuthorization(device)).allowed
					)
						throw denied();
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
		);
	} else {
		await requireChapterAccess(c, source.chapterId, need);
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
	try {
		for (const project of await relatedProjects(target)) {
			if (!(await hasProjectAccess(project, principal, "read"))) throw denied();
			canWrite &&= await hasProjectAccess(project, principal, "write");
		}
		await requireSafeLocalGitPath(target, root);
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
		workspace.capabilities = { read: true, write: canWrite };
	} catch (error) {
		if (!(error instanceof AppError) || error.statusCode !== 403) throw error;
		redactDeniedTarget(target);
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
