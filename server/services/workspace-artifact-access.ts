import { realpath } from "node:fs/promises";
import type { WorkspaceContext } from "@shared/workspace-context";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators, users } from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { resolveBackend } from "../lib/agent/execution/registry";
import type { ToolContext, ToolExecutionTarget } from "../lib/agent/types";
import { AppError } from "../lib/errors";
import { isSecretPlatformPath, isSecretUserPath } from "../lib/fs-secret-paths";
import { getDisabledToolSet } from "../lib/narrator-custom-traits";
import { isPermissionMode } from "../lib/permission-modes";
import { createWorkspaceFileAccess, type WorkspaceFileAccess } from "../lib/plan-file-path";
import { getHome } from "../lib/platform";
import { narraforkDir } from "../lib/settings";
import type { WorkspaceAttachmentAccess } from "../lib/uploads";
import { isRuntimeToolAllowed } from "./agent-runtime/policy";
import { getSessionDevices } from "./device-connection-service";
import { executionPolicyEngine } from "./execution-policy/engine";
import type { ExecutionDeviceClass, ExecutionTargetContext } from "./execution-policy/types";
import { integrationResourceBindingService } from "./integration-resource-binding-service";
import { assertNarratorAccess, NARRATOR_ACL_COLUMNS } from "./narrator-acl";
import { resolveOAuthNarratorRuntimePolicy } from "./oauth-narrator-runtime-policy";
import { loadProjectForAccess } from "./project-acl";
import { resolveEffectiveTraits, resolveNarratorProjectId } from "./trait-layer-service";

export type ApprovedWorkspaceReadGuard = (
	canonicalPath: string,
	backend: ExecutionBackend,
	signal?: AbortSignal,
) => Promise<boolean | undefined>;

function denied(message: string): AppError {
	return new AppError(message, 403, "WORKSPACE_ARTIFACT_ACCESS_DENIED");
}

function assertGeneration(backend: ExecutionBackend, generation: number): void {
	const live = resolveBackend({ requested: backend.deviceId });
	if (
		live.kind !== backend.kind ||
		live.runtimeGeneration !== generation ||
		backend.runtimeGeneration !== generation
	)
		throw denied("Workspace execution identity changed");
}

/** Roles and resource ACLs always come from current server state, never caller input. */
async function liveAuthority(
	narratorId: string,
	actor: string | null | undefined,
	projectId: string | null | undefined,
	backend: ExecutionBackend,
	operation: "read" | "write",
) {
	if (!actor) throw denied("Workspace artifacts require an authenticated actor");
	const user = await db.query.users.findFirst({
		where: eq(users.id, actor),
		columns: { role: true },
	});
	if (!user) throw denied("Workspace actor no longer exists");
	const principal = { userId: actor, isAdmin: user.role === "admin" };
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: {
			...NARRATOR_ACL_COLUMNS,
			workspaceRevision: true,
			workspaceContext: true,
			permissionMode: true,
			planMode: true,
			relaxedPlan: true,
			traits: true,
		},
	});
	if (!row) throw denied("Workspace narrator no longer exists");
	await assertNarratorAccess(row, principal, operation);
	if (projectId) await loadProjectForAccess(projectId, principal, operation);
	const runtime = await resolveOAuthNarratorRuntimePolicy(narratorId, actor);
	let deviceClass: ExecutionDeviceClass | null = backend.kind === "local" ? "host" : null;
	if (backend.kind === "remote") {
		const devices = await getSessionDevices(projectId, actor);
		if (!devices.some((device) => device.id === backend.deviceId && device.online))
			throw denied("Workspace device is offline or unauthorized");
		if (runtime) {
			const binding = await integrationResourceBindingService.get("device", backend.deviceId);
			deviceClass =
				binding?.sourceType === "oauth_client" &&
				binding.sourceId === runtime.clientId &&
				binding.authorityType === "oauth_grant" &&
				binding.authorityId === runtime.grantId &&
				binding.state === "active"
					? "selfRegistered"
					: "global";
		}
	}
	if (runtime) {
		if (
			!runtime.allowedTools.has(operation === "write" ? "Write" : "Read") ||
			(backend.kind === "local"
				? !runtime.allowLocalExecution
				: !runtime.deviceIds.includes(backend.deviceId)) ||
			!deviceClass
		)
			throw denied("Workspace artifact is outside the OAuth authority");
		const level = runtime.policy.deviceAccess[deviceClass];
		if (level !== "readWrite" && (operation === "write" || level !== "readOnly"))
			throw denied("Workspace artifact exceeds the OAuth device access ceiling");
	}
	return { row, runtime, deviceClass };
}

/** Also rejects an ancestor tree that would disclose protected platform descendants. */
async function assertSafeLocalPath(backend: ExecutionBackend, path: string): Promise<void> {
	if (backend.kind !== "local") return;
	const [home, platform] = await Promise.all([
		realpath(getHome()).catch(() => getHome()),
		realpath(narraforkDir).catch(() => narraforkDir),
	]);
	if (
		isSecretPlatformPath(path, platform) ||
		isSecretUserPath(path, home) ||
		backend.paths.contains(platform, path) ||
		backend.paths.contains(path, platform) ||
		[".ssh", ".aws", ".gnupg", ".kube"].some((part) => {
			const secret = backend.paths.resolve(home, part);
			return backend.paths.contains(secret, path) || backend.paths.contains(path, secret);
		})
	)
		throw denied("Workspace artifacts cannot access private platform files");
}

async function assertCanonical(
	backend: ExecutionBackend,
	path: string,
	generation: number,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	assertGeneration(backend, generation);
	if (!backend.paths.isAbsolute(path)) throw denied("Artifact path must be absolute");
	const identity = await backend.resolvePathIdentity(path, { signal, timeoutMs: 5_000 });
	if (
		identity.runtimeGeneration !== generation ||
		!backend.paths.equals(identity.canonicalPath, path)
	)
		throw denied("Artifact canonical path changed");
	assertGeneration(backend, generation);
}

function targetContext(
	backend: ExecutionBackend,
	generation: number,
	cwd: string,
	path: string,
	deviceClass: ExecutionDeviceClass | null,
): ExecutionTargetContext {
	return {
		backend,
		paths: backend.paths,
		deviceClass,
		target: {
			deviceId: backend.deviceId,
			backendKind: backend.kind,
			cwd,
			lexicalPath: path,
			canonicalPath: path,
			pathFlavor: backend.pathFlavor,
			runtimeGeneration: generation,
			selectionSource: "session_default",
		},
	};
}

/** Human attachment materialization is not an AI Write or an owner-user impersonation. */
export function createNarratorWorkspaceAttachmentAccess(
	narratorId: string,
	workspaceContext: WorkspaceContext,
	options: {
		userId?: string | null;
		signal?: AbortSignal;
		sourceAccess?: WorkspaceFileAccess;
		authorizationGuard?: () => Promise<void>;
	} = {},
): WorkspaceAttachmentAccess {
	const workspace = Object.freeze({ ...workspaceContext });
	const { userId, signal: callerSignal, sourceAccess, authorizationGuard } = options;
	const backend = resolveBackend({ requested: workspace.deviceId });
	const generation = backend.runtimeGeneration;
	if (backend.paths.flavor !== workspace.pathFlavor || !backend.paths.isAbsolute(workspace.cwd))
		throw denied("Workspace attachment backend mismatch");
	const access: WorkspaceAttachmentAccess = {
		backend,
		workspaceContext: workspace,
		signal: callerSignal,
		sourceAccess,
		async authorizeWrite(canonicalPath, selectedBackend, writeSignal) {
			const signal =
				writeSignal && callerSignal
					? AbortSignal.any([writeSignal, callerSignal])
					: (writeSignal ?? callerSignal);
			signal?.throwIfAborted();
			if (selectedBackend !== backend) throw denied("Workspace attachment backend changed");
			await authorizationGuard?.();
			const { row, runtime, deviceClass } = await liveAuthority(
				narratorId,
				userId,
				workspace.contextProjectId,
				backend,
				"write",
			);
			if (
				row.workspaceRevision !== workspace.revision ||
				(row.workspaceContext && row.workspaceContext.contextKey !== workspace.contextKey)
			)
				throw denied("Workspace attachment context changed");
			await assertCanonical(backend, workspace.cwd, generation, signal);
			await assertCanonical(backend, canonicalPath, generation, signal);
			if (!backend.paths.contains(workspace.cwd, canonicalPath))
				throw denied("Workspace attachment escaped its canonical workspace");
			await assertSafeLocalPath(backend, canonicalPath);
			const policy = await executionPolicyEngine.compile(
				narratorId,
				targetContext(backend, generation, workspace.cwd, canonicalPath, deviceClass),
				runtime?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
				signal,
			);
			if (policy.evaluatePath({ path: canonicalPath, operation: "write" }).decision === "deny")
				throw denied("Workspace attachment write denied by execution policy");
			// Explicit human upload needs no AI permission-mode promotion or Read-rule inference.
			await authorizationGuard?.();
			const final = await liveAuthority(
				narratorId,
				userId,
				workspace.contextProjectId,
				backend,
				"write",
			);
			if (
				final.row.workspaceRevision !== workspace.revision ||
				(final.row.workspaceContext &&
					final.row.workspaceContext.contextKey !== workspace.contextKey)
			)
				throw denied("Workspace attachment context changed");
			await assertCanonical(backend, workspace.cwd, generation, signal);
			await assertCanonical(backend, canonicalPath, generation, signal);
			return true;
		},
		async withAttachmentTarget(signal, body, admitted) {
			if (!userId) throw denied("Attachment native publisher requires its actual human actor");
			const { withWorkspaceAttachmentTarget } = await import("./workspace-attachment-runtime");
			return withWorkspaceAttachmentTarget({ narratorId, userId, access, admitted, signal, body });
		},
	};
	return access;
}

/**
 * Original human attachment provenance supplies an exact source, not an approved tool root.
 * A later source narrator workspace switch must not reinterpret this persisted source binding.
 */
export function createNarratorWorkspaceAttachmentSourceAccess(
	sourceNarratorId: string,
	originalWorkspace: WorkspaceContext,
	originalFilePath: string,
	options: {
		userId?: string | null;
		signal?: AbortSignal;
		authorizationGuard?: () => Promise<void>;
	} = {},
): WorkspaceFileAccess {
	const workspace = Object.freeze({ ...originalWorkspace });
	const { userId, signal: callerSignal, authorizationGuard } = options;
	const backend = resolveBackend({ requested: workspace.deviceId });
	const generation = backend.runtimeGeneration;
	if (
		backend.paths.flavor !== workspace.pathFlavor ||
		!backend.paths.isAbsolute(workspace.cwd) ||
		!backend.paths.isAbsolute(originalFilePath) ||
		!backend.paths.contains(workspace.cwd, originalFilePath)
	)
		throw denied("Attachment source does not match its original workspace binding");
	return createWorkspaceFileAccess({
		backend,
		workspaceContext: workspace,
		signal: callerSignal,
		async authorizeRead(canonicalPath, selectedBackend, readSignal) {
			const signal =
				callerSignal && readSignal
					? AbortSignal.any([callerSignal, readSignal])
					: (callerSignal ?? readSignal);
			signal?.throwIfAborted();
			if (selectedBackend !== backend || !backend.paths.equals(originalFilePath, canonicalPath))
				throw denied("Attachment source Read is limited to its exact original file");
			await authorizationGuard?.();
			const { runtime, deviceClass } = await liveAuthority(
				sourceNarratorId,
				userId,
				workspace.contextProjectId,
				backend,
				"read",
			);
			await assertCanonical(backend, workspace.cwd, generation, signal);
			await assertCanonical(backend, originalFilePath, generation, signal);
			await assertSafeLocalPath(backend, originalFilePath);
			const policy = await executionPolicyEngine.compile(
				sourceNarratorId,
				targetContext(backend, generation, workspace.cwd, originalFilePath, deviceClass),
				runtime?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
				signal,
			);
			if (policy.evaluatePath({ path: originalFilePath, operation: "read" }).decision === "deny")
				throw denied("Attachment source Read denied by execution policy");
			await authorizationGuard?.();
			await liveAuthority(sourceNarratorId, userId, workspace.contextProjectId, backend, "read");
			await assertCanonical(backend, workspace.cwd, generation, signal);
			await assertCanonical(backend, originalFilePath, generation, signal);
			return true;
		},
	});
}

/**
 * Explicit AI artifact copies require their own approved Write endpoint. This is deliberately
 * separate from human attachments: neither a Read approval nor an upload permission grants it.
 * The optional original source access is supplied by the trusted resource publisher, not inferred.
 */
export function createApprovedWorkspaceArtifactAccess(
	ctx: ToolContext,
	sourceAccess?: WorkspaceFileAccess,
): WorkspaceAttachmentAccess {
	if (!ctx.workspaceContext) throw denied("AI artifacts require a frozen workspace context");
	const workspace = Object.freeze({ ...ctx.workspaceContext });
	const { narratorId, userId, signal, runtimePolicy, planFileBinding, planFileId, planFilePath } =
		ctx;
	const recheck = ctx.recheckAuthorization;
	const backend = resolveBackend({ requested: workspace.deviceId });
	const generation = backend.runtimeGeneration;
	const writes =
		ctx.executionPlan?.endpoints
			.filter((endpoint) => endpoint.operation === "write")
			.map((endpoint) => ({ ...endpoint.target })) ?? [];
	if (backend.paths.flavor !== workspace.pathFlavor || !backend.paths.isAbsolute(workspace.cwd))
		throw denied("AI artifact backend does not match its frozen workspace");

	async function assertAiAuthority() {
		signal.throwIfAborted();
		if (!recheck) throw denied("AI artifacts require a live authorization fence");
		await recheck();
		if (
			planFileBinding ||
			planFileId ||
			planFilePath ||
			(runtimePolicy &&
				(runtimePolicy.tools.readOnly || !isRuntimeToolAllowed(runtimePolicy, "Write")))
		)
			throw denied("AI artifact Write is outside the runtime or plan authority");
		const authority = await liveAuthority(
			narratorId,
			userId,
			workspace.contextProjectId,
			backend,
			"write",
		);
		const effectiveTraits = await resolveEffectiveTraits({
			narratorTraits: authority.row.traits,
			projectId: (await resolveNarratorProjectId(authority.row)) ?? workspace.contextProjectId,
			actingUserId: userId,
		});
		if (getDisabledToolSet(effectiveTraits.traits).has("Write"))
			throw denied("AI artifact Write is disabled by effective user/project/narrator traits");
		const mode = authority.runtime?.permissionMode ?? authority.row.permissionMode;
		if (
			!isPermissionMode(mode) ||
			mode === "readOnly" ||
			(authority.row.planMode && !authority.row.relaxedPlan)
		)
			throw denied("AI artifacts are forbidden by live read-only or strict plan mode");
		if (
			authority.row.workspaceRevision !== workspace.revision ||
			(authority.row.workspaceContext &&
				authority.row.workspaceContext.contextKey !== workspace.contextKey)
		)
			throw denied("AI artifact workspace context changed");
		return authority;
	}

	return {
		backend,
		workspaceContext: workspace,
		signal,
		sourceAccess,
		async authorizeWrite(canonicalPath, selectedBackend, writeSignal) {
			const operationSignal = writeSignal ? AbortSignal.any([signal, writeSignal]) : signal;
			operationSignal.throwIfAborted();
			if (selectedBackend !== backend) throw denied("AI artifact backend changed");
			const { runtime, deviceClass } = await assertAiAuthority();
			const endpoint = writes.find(
				(target) =>
					target.deviceId === backend.deviceId &&
					target.backendKind === backend.kind &&
					target.runtimeGeneration === generation &&
					target.pathFlavor === backend.pathFlavor &&
					target.canonicalPath &&
					backend.paths.contains(target.canonicalPath, canonicalPath),
			);
			if (!endpoint?.canonicalPath)
				throw denied("AI artifact is outside its approved canonical Write endpoints");
			await assertCanonical(backend, workspace.cwd, generation, operationSignal);
			await assertCanonical(backend, endpoint.canonicalPath, generation, operationSignal);
			await assertCanonical(backend, canonicalPath, generation, operationSignal);
			if (!backend.paths.contains(workspace.cwd, canonicalPath))
				throw denied("AI artifact escaped its canonical workspace");
			await assertSafeLocalPath(backend, canonicalPath);
			const policy = await executionPolicyEngine.compile(
				narratorId,
				targetContext(backend, generation, workspace.cwd, canonicalPath, deviceClass),
				runtime?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
				operationSignal,
			);
			const decision = policy.evaluatePath({ path: canonicalPath, operation: "write" }).decision;
			if (decision === "deny") throw denied("AI artifact Write denied by execution policy");
			const final = await assertAiAuthority();
			if (
				(final.runtime?.permissionMode ?? final.row.permissionMode) === "dontAsk" &&
				decision !== "allow"
			)
				throw denied("AI artifact Write has no automatic allow under dontAsk mode");
			await assertCanonical(backend, workspace.cwd, generation, operationSignal);
			await assertCanonical(backend, endpoint.canonicalPath, generation, operationSignal);
			await assertCanonical(backend, canonicalPath, generation, operationSignal);
			return true;
		},
	};
}

/** Read scope comes exclusively from the immutable permission-approved endpoint plan. */
export function createApprovedWorkspaceReadGuard(ctx: ToolContext): ApprovedWorkspaceReadGuard {
	const { narratorId, userId, signal: callerSignal, runtimePolicy } = ctx;
	const projectId = ctx.workspaceContext?.contextProjectId ?? ctx.projectId;
	const recheck = ctx.recheckAuthorization;
	const targets: ToolExecutionTarget[] = ctx.executionPlan
		? ctx.executionPlan.endpoints
				.filter((endpoint) => endpoint.operation === "read")
				.map((endpoint) => ({ ...endpoint.target }))
		: ctx.executionTarget
			? [{ ...ctx.executionTarget }]
			: [];
	const sources = targets.map((target) => {
		const backend =
			ctx.resolveBackend?.(target.deviceId) ?? resolveBackend({ requested: target.deviceId });
		return { target, backend, generation: backend.runtimeGeneration };
	});
	return async (canonicalPath, backend, readSignal) => {
		const signal = readSignal ? AbortSignal.any([callerSignal, readSignal]) : callerSignal;
		signal.throwIfAborted();
		if (!recheck) throw denied("Approved workspace reads require a live authorization fence");
		await recheck();
		if (runtimePolicy && !isRuntimeToolAllowed(runtimePolicy, "Read"))
			throw denied("Workspace read is outside the runtime tool authority");
		const source = sources.find(
			({ target, backend: admitted, generation }) =>
				admitted === backend &&
				target.deviceId === backend.deviceId &&
				target.backendKind === backend.kind &&
				target.runtimeGeneration === generation &&
				target.pathFlavor === backend.pathFlavor &&
				target.canonicalPath &&
				backend.paths.contains(target.canonicalPath, canonicalPath),
		);
		if (!source?.target.canonicalPath)
			throw denied("Workspace read is outside its approved canonical endpoints");
		const root = source.target.canonicalPath;
		const { generation, target } = source;
		const { runtime, deviceClass } = await liveAuthority(
			narratorId,
			userId,
			projectId,
			backend,
			"read",
		);
		await assertCanonical(backend, root, generation, signal);
		await assertCanonical(backend, canonicalPath, generation, signal);
		await assertSafeLocalPath(backend, canonicalPath);
		const policy = await executionPolicyEngine.compile(
			narratorId,
			targetContext(backend, generation, target.cwd, canonicalPath, deviceClass),
			runtime?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
			signal,
		);
		if (
			policy.evaluatePath({ path: canonicalPath, operation: "read" }).decision === "deny" ||
			policy.directoryBlacklist.some(
				(rule) => rule.denyLevel === "denyAll" && backend.paths.contains(canonicalPath, rule.path),
			)
		)
			throw denied("Workspace read tree includes an execution-policy denied path");
		await recheck();
		await liveAuthority(narratorId, userId, projectId, backend, "read");
		await assertCanonical(backend, root, generation, signal);
		await assertCanonical(backend, canonicalPath, generation, signal);
		return true;
	};
}
