import { realpath } from "node:fs/promises";
import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db";
import { projects, remoteDevices } from "../db/schema";
import { readQueryFirst } from "../db/worker-read";
import { AppError, catalogError } from "../lib/errors";
import { isSecretPlatformPath, isSecretUserPath } from "../lib/fs-secret-paths";
import { logger } from "../lib/logger";
import { narratorPrincipalOf } from "../lib/narrator-access";
import { getHome } from "../lib/platform";
import { narraforkDir } from "../lib/settings";
import { isDeviceAuthorized } from "./device-service";
import { executionPolicyEngine } from "./execution-policy/engine";
import type { ExecutionDeviceClass, ExecutionTargetContext } from "./execution-policy/types";
import { type GitWorkspaceTarget, resolveNarratorGitTarget } from "./git-workspace";
import { ACCESS_PAGE_SIZE, GitAccessScan } from "./git-workspace-access-scan";
import { gitPathPolicyAllows } from "./git-workspace-path-policy";
import { integrationResourceBindingService } from "./integration-resource-binding-service";
import { canWriteNarrator, loadNarratorForAccess, type NarratorPrincipal } from "./narrator-acl";
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
	delete workspace.projectId;
	delete target.repositoryPath;
	delete target.worktreeListOnly;
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
		for (const row of page) matches.set(row.id, row);
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
					matches.set(project.id, project);
			},
		);
	}
	return [...matches.values()];
}

export async function authorizeGitTarget(
	c: Context,
	source: { narratorId: string },
	need: "read" | "write",
	discoveryMode?: "metadata",
): Promise<GitWorkspaceTarget> {
	return authorizeGitTargetForPrincipal(
		narratorPrincipalOf(c),
		source,
		need,
		c.req.raw.signal,
		false,
		false,
		discoveryMode === "metadata",
	);
}

/** Shared by HTTP and authenticated workspace WebSocket subscriptions. */
export async function authorizeGitTargetForPrincipal(
	principal: NarratorPrincipal,
	source: { narratorId: string },
	need: "read" | "write",
	signal: AbortSignal,
	cachedDiscovery = false,
	recoverWorktreeList = false,
	metadataDiscovery: boolean | GitWorkspaceTarget = false,
): Promise<GitWorkspaceTarget> {
	if (signal.aborted) {
		await loadNarratorForAccess(source.narratorId, principal, need, {
			deadlineAt: Date.now() + 30_000,
			executionPolicy: "worker-required",
		});
		throw catalogError("GIT_REQUEST_CANCELLED");
	}
	const budget = new GitAccessScan(signal, 30_000);
	let completed = false;
	try {
		const target = await budget.run(() =>
			authorizeGitTargetWithinBudget(
				principal,
				source,
				need,
				signal,
				budget,
				cachedDiscovery,
				recoverWorktreeList,
				metadataDiscovery,
			),
		);
		completed = true;
		return target;
	} finally {
		budget.dispose(!completed);
	}
}

async function authorizeGitTargetWithinBudget(
	principal: NarratorPrincipal,
	source: { narratorId: string },
	need: "read" | "write",
	requestSignal: AbortSignal,
	budget: GitAccessScan,
	cachedDiscovery = false,
	recoverWorktreeList = false,
	metadataDiscovery: boolean | GitWorkspaceTarget = false,
): Promise<GitWorkspaceTarget> {
	const signal = budget.signal;
	let canWrite = true;
	let policy: Awaited<ReturnType<typeof resolveOAuthNarratorRuntimePolicy>> = null;
	let deviceClass: ExecutionDeviceClass | null = null;
	const narratorExecution: {
		context: ExecutionTargetContext | null;
		policy: Awaited<ReturnType<typeof executionPolicyEngine.compile>> | null;
	} = { context: null, policy: null };
	let target: GitWorkspaceTarget;
	const narrator = await loadNarratorForAccess(
		source.narratorId,
		principal,
		need,
		budget.readOptions(),
	);
	if (signal.aborted) throw catalogError("GIT_REQUEST_CANCELLED");
	canWrite = await canWriteNarrator(narrator, principal, budget.readOptions());
	policy = await resolveOAuthNarratorRuntimePolicy(
		source.narratorId,
		undefined,
		budget.readOptions(),
		narrator,
	);
	target = await resolveNarratorGitTarget(
		source.narratorId,
		signal,
		async (initial) => {
			if (initial.contextProjectId) {
				const project = await loadProjectForAccess(
					initial.contextProjectId,
					principal,
					need,
					budget.readOptions(),
				);
				canWrite &&= await hasProjectAccess(project, principal, "write", budget.readOptions());
			}
			const id = initial.workspace.deviceId;
			if (id !== "local") {
				const device = await readQueryFirst(
					db.query.remoteDevices.findMany({
						limit: 1,
						where: eq(remoteDevices.id, id),
					}),
					{ ...budget.readOptions(), executionPolicy: "worker-required", maxRows: 1 },
				);
				if (
					!device ||
					device.revokedAt ||
					!isDeviceAuthorized(device, {
						userId: principal.userId,
						projectId: initial.contextProjectId,
					}) ||
					!(await resolveOAuthDeviceRuntimeAuthorization(device, budget.readOptions())).allowed
				)
					throw denied();
			}
			if (policy) {
				if (id === "local" ? !policy.allowLocalExecution : !policy.deviceIds.includes(id))
					throw denied();
				const binding =
					id === "local"
						? null
						: await integrationResourceBindingService.get("device", id, budget.readOptions());
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
				signal,
				budget.readOptions(),
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
		recoverWorktreeList && need === "read",
		metadataDiscovery,
		budget.readOptions(),
		narrator,
	);
	const { workspace, backend } = target;
	if (
		(workspace.state !== "ready" && !target.worktreeListOnly) ||
		!backend ||
		!workspace.rootPath
	) {
		if (workspace.state === "access_denied") redactDeniedTarget(target);
		return target;
	}
	const root = workspace.rootPath;
	const scan = budget;
	scan.limitRemaining(5000);
	try {
		for (const project of await relatedProjects(target, scan, principal)) {
			if (!(await scan.run(() => hasProjectAccess(project, principal, "read", scan.readOptions()))))
				throw denied();
			canWrite &&= await scan.run(() =>
				hasProjectAccess(project, principal, "write", scan.readOptions()),
			);
		}
		await scan.run(() => requireSafeLocalGitPath(target, root));
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
		if (need === "write" && !canWrite) throw denied();
		target.authorizeFilePaths = async (files, operation) => {
			// The authorization scope is already disposed; subsequent use belongs to the request.
			requestSignal.throwIfAborted();
			if (operation === "write" && !canWrite) throw denied();
			for (const file of files) {
				const absolute = backend.paths.resolve(root, file);
				if (
					!backend.paths.contains(root, absolute) ||
					!gitPathPolicyAllows(compiled, context, absolute, operation)
				)
					throw denied();
			}
		};
		scan.check();
		workspace.capabilities = target.worktreeListOnly
			? { read: false, write: false }
			: { read: true, write: canWrite };
	} catch (error) {
		if (!(error instanceof AppError) || error.statusCode !== 403) throw error;
		redactDeniedTarget(target);
	} finally {
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

/** Check the exact destination independently of the narrator's current checkout grant. */
export async function authorizeGitDestinationForPrincipal(
	principal: NarratorPrincipal,
	narratorId: string,
	destination: string,
	need: "read" | "write",
	signal: AbortSignal,
): Promise<GitWorkspaceTarget> {
	const budget = new GitAccessScan(signal, 30_000);
	let completed = false;
	try {
		const target = await budget.run(() =>
			authorizeGitDestinationWithinBudget(principal, narratorId, destination, need, signal, budget),
		);
		completed = true;
		return target;
	} finally {
		budget.dispose(!completed);
	}
}

async function authorizeGitDestinationWithinBudget(
	principal: NarratorPrincipal,
	narratorId: string,
	destination: string,
	need: "read" | "write",
	requestSignal: AbortSignal,
	budget: GitAccessScan,
): Promise<GitWorkspaceTarget> {
	const signal = budget.signal;
	const target = await authorizeGitTargetWithinBudget(
		principal,
		{ narratorId },
		need,
		requestSignal,
		budget,
	);
	requireReadyGitTarget(target, need);
	const backend = target.backend;
	if (backend.kind !== "local") throw denied();
	const identity = await backend.resolvePathIdentity(destination, { signal, timeoutMs: 5000 });
	if (
		!backend.paths.equals(identity.canonicalPath, destination) ||
		identity.runtimeGeneration !== backend.runtimeGeneration
	)
		throw denied();
	await requireSafeLocalGitPath(target, destination);
	const policy = await resolveOAuthNarratorRuntimePolicy(
		narratorId,
		undefined,
		budget.readOptions(),
	);
	const context: ExecutionTargetContext = {
		backend,
		paths: backend.paths,
		deviceClass: policy ? "host" : null,
		target: {
			deviceId: target.workspace.deviceId,
			backendKind: backend.kind,
			cwd: target.workspace.cwd,
			lexicalPath: destination,
			canonicalPath: destination,
			pathFlavor: backend.pathFlavor,
			runtimeGeneration: backend.runtimeGeneration,
			selectionSource: "session_default",
		},
	};
	const compiled = await executionPolicyEngine.compile(
		narratorId,
		context,
		policy?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
		signal,
		budget.readOptions(),
	);
	if (!gitPathPolicyAllows(compiled, context, destination, need)) throw denied();
	const decision = compiled.evaluatePath({ path: destination, operation: need }).decision;
	const paths = backend.paths;
	const repositoryRoot = target.repositoryPath ? paths.dirname(target.repositoryPath) : null;
	// Preserve explicit narrower grants: a current-checkout whitelist is not a sibling grant.
	if (
		decision !== "allow" &&
		compiled.directoryWhitelist.some(
			(rule) =>
				paths.contains(rule.path, destination) ||
				(repositoryRoot &&
					target.workspace.rootPath &&
					!paths.contains(target.workspace.rootPath, destination) &&
					paths.contains(repositoryRoot, rule.path)),
		)
	)
		throw denied();
	// OAuth ask is not an implicit grant outside its current directory, even for reads.
	if (
		policy &&
		policy.permissionMode !== "bypassPermissions" &&
		compiled.evaluatePath({ path: destination, operation: need }).decision !== "allow"
	)
		throw denied();
	const scopedTarget = {
		...target,
		workspace: { ...target.workspace, rootPath: destination, cwd: destination },
		// The source common directory was already authorized; don't treat it as a destination grant.
		repositoryPath: undefined,
	};
	const scan = budget;
	scan.limitRemaining(5000);
	for (const project of await relatedProjects(scopedTarget, scan, principal)) {
		if (!(await scan.run(() => hasProjectAccess(project, principal, need, scan.readOptions()))))
			throw denied();
	}
	scan.check();
	signal.throwIfAborted();
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
