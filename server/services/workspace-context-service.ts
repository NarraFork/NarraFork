import { createHash, randomUUID } from "node:crypto";
import { access, constants, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type {
	SwitchWorkingDirectoryRequest,
	SwitchWorkingDirectoryResult,
	WorkspaceContext,
} from "@shared/workspace-context";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import {
	chapters,
	narratorDeviceWorkspaceRequests,
	narrators,
	projects,
	workspaceSwitchRequests,
} from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { localBackend, resolveBackend } from "../lib/agent/execution/registry";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { isSecretPlatformPath, isSecretUserPath } from "../lib/fs-secret-paths";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { isKnowledgeStewardNarrator } from "../lib/narrator-utils";
import { getHome } from "../lib/platform";
import { isInsidePath } from "../lib/platform-path";
import { narraforkDir } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { getSessionDevices } from "./device-connection-service";
import { executionPolicyEngine } from "./execution-policy/engine";
import { gitWorkspaceIdentity, probeLocalGitWorkspace } from "./git-workspace";
import { resolveNarratorSessionCwd } from "./narrator-cwd";
import {
	readDeviceWorkspaceBinding,
	saveLegacyDeviceWorkspaceBinding,
} from "./narrator-device-workspace-store";
import {
	type ActiveNarrator,
	activeNarrators,
	compactLocks,
	isNarratorMutationAdmissionBusy,
	isNarratorRevertAdmissionBlocked,
	isNarratorRuntimeBusy,
	pendingDangerReflections,
	pendingPermissions,
	withNarratorMutationAdmission,
} from "./narrator-session-state";
import { resolveOAuthNarratorRuntimePolicy } from "./oauth-narrator-runtime-policy";
import { transitionWorkspaceContext, workspaceConflict } from "./workspace-context-transition";
import { withWorkspaceAdmission } from "./worktree-lifecycle-guard";

const writingRepositories = hotSafe("narrafork.workspaceRepositoryWrites", () => new Set<string>());

/** Repository common-dir identity, shared across linked worktrees. */
export async function withWorkspaceRepositoryLock<T>(
	repositoryKey: string,
	action: () => Promise<T>,
): Promise<T> {
	// No waiting queue for shared refs/stash mutations across linked worktrees.
	if (writingRepositories.has(repositoryKey))
		throw workspaceConflict(
			"Another Git write is in progress in this repository",
			"GIT_WORKSPACE_BUSY",
		);
	writingRepositories.add(repositoryKey);
	try {
		return await action();
	} finally {
		writingRepositories.delete(repositoryKey);
	}
}

/** M0 has no cross-directory restore engine: do not reinterpret old trees under the new cwd. */
export async function assertWorkspaceHistoryRevertSupported(narratorId: string): Promise<void> {
	const row = await loadWorkspaceRow(narratorId);
	if (row.workspaceRevision > 0)
		throw workspaceConflict(
			"File rollback across a changed workspace context is unsupported (M0)",
			"WORKSPACE_REVERT_UNSUPPORTED",
		);
}

export interface WorkspaceSwitchOptions {
	origin: "http" | "agent";
	active?: ActiveNarrator;
	userId?: string | null;
	/** Revalidate the device allowlist/OAuth authority immediately before CAS. */
	validateDevice?: () => Promise<void>;
	/** Internal adapter for legacy SwitchDevice, never accepted from public request bodies. */
	deviceOnly?: boolean;
}

async function loadWorkspaceRow(id: string) {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
		columns: {
			id: true,
			cwd: true,
			workspaceRevision: true,
			workspaceContext: true,
			defaultDeviceId: true,
			chapterId: true,
			contextProjectId: true,
			variant: true,
			traits: true,
			status: true,
			ownerUserId: true,
		},
	});
	if (!row) throw new NotFoundError("Narrator", id);
	return row;
}

export async function prepareLocalWorkspaceContext(
	cwd: string,
	revision: number,
	contextProjectId?: string,
	allowUnavailableCurrent = false,
): Promise<WorkspaceContext> {
	if (!isAbsolute(cwd)) throw new ValidationError("cwd must be an absolute path");
	let canonical: string;
	try {
		await access(cwd, constants.R_OK | constants.X_OK);
		canonical = await realpath(cwd);
		if (!(await stat(canonical)).isDirectory()) throw new Error("Not a directory");
	} catch {
		if (!allowUnavailableCurrent)
			throw new ValidationError("Working directory does not exist or is not accessible");
		// The existing cwd can disappear externally. Read/activation must still work
		// so the normal Bash recovery path or an explicit switch can repair it.
		canonical = localBackend.paths.normalize(cwd);
	}
	const probe = await probeLocalGitWorkspace(canonical);
	const git =
		probe.state === "ready" && probe.rootPath && probe.repositoryPath
			? {
					workspaceKey: gitWorkspaceIdentity(localBackend, probe.rootPath),
					repositoryKey: gitWorkspaceIdentity(localBackend, probe.repositoryPath),
					rootPath: probe.rootPath,
				}
			: undefined;
	if (
		!allowUnavailableCurrent &&
		probe.state !== "ready" &&
		probe.state !== "not_git" &&
		probe.state !== "git_unavailable"
	)
		throw new ValidationError(probe.reason ?? "Cannot safely resolve working directory");
	return {
		revision,
		deviceId: "local",
		cwd: canonical,
		pathFlavor: localBackend.paths.flavor === "windows" ? "windows" : "posix",
		contextProjectId,
		git,
		contextKey: createHash("sha256")
			.update(
				JSON.stringify([
					"local",
					localBackend.paths.identityKey(canonical),
					git?.workspaceKey ?? null,
					git?.repositoryKey ?? null,
				]),
			)
			.digest("hex"),
		capabilities: { switchDirectory: true, ...workspaceFeatureCapabilities(localBackend) },
	};
}

function workspaceFeatureCapabilities(
	backend: ExecutionBackend | null,
): Pick<WorkspaceContext["capabilities"], "browse" | "git" | "worktree" | "share"> {
	const local = backend?.kind === "local";
	const capability = (available: boolean, reason: string) =>
		available ? { available: true } : { available: false, reason };
	return {
		browse: capability(
			!!backend && (local || backend.supportsFsListBounded === true),
			backend ? "Executor upgrade required: fs.list.bounded.v1" : "Execution device is offline",
		),
		git: capability(
			!!backend && (local || backend.supportsGitWorkspace === true),
			backend ? "Git workspace capability is unavailable" : "Execution device is offline",
		),
		worktree: capability(
			!!backend && (local || backend.supportsGitWorktree === true),
			backend ? "Executor upgrade required: git.worktree.v1" : "Execution device is offline",
		),
		share: capability(
			!!backend && (local || backend.supportsShareArchive === true),
			backend ? "Executor upgrade required: share.archive.v1" : "Execution device is offline",
		),
	};
}
function unavailableWorkspaceContext(
	deviceId: string,
	cwd: string,
	pathFlavor: WorkspaceContext["pathFlavor"],
	revision: number,
	contextProjectId?: string,
): WorkspaceContext {
	return {
		revision,
		deviceId,
		cwd,
		pathFlavor,
		contextProjectId,
		contextKey: createHash("sha256")
			.update(JSON.stringify([deviceId, cwd]))
			.digest("hex"),
		availability: cwd ? "offline" : "needs_initialization",
		capabilities: {
			switchDirectory: true,
			reason: "Remote workspace is unavailable; no local fallback",
		},
	};
}

export interface WorkspacePreparationOptions {
	narratorId?: string;
	userId?: string | null;
	validateDevice?: () => Promise<void>;
}

export async function runtimeDeviceClass(
	narratorId: string,
	deviceId: string,
	userId?: string | null,
) {
	const runtime = await resolveOAuthNarratorRuntimePolicy(narratorId, userId);
	if (!runtime) return { runtime, deviceClass: deviceId === "local" ? ("host" as const) : null };
	const { integrationResourceBindingService } = await import(
		"./integration-resource-binding-service"
	);
	const binding =
		deviceId === "local" ? null : await integrationResourceBindingService.get("device", deviceId);
	const deviceClass =
		deviceId === "local"
			? ("host" as const)
			: binding?.sourceType === "oauth_client" &&
					binding.sourceId === runtime.clientId &&
					binding.authorityType === "oauth_grant" &&
					binding.state === "active" &&
					binding.authorityId === runtime.grantId
				? ("selfRegistered" as const)
				: ("global" as const);
	if (!runtime.allowedTools.has("Read") || runtime.policy.deviceAccess[deviceClass] === "denied")
		throw new AppError(
			"Workspace device reads are outside the runtime authority",
			403,
			"WORKSPACE_ACCESS_DENIED",
		);
	return { runtime, deviceClass };
}
export async function authorizeWorkspaceDevice(
	deviceId: string,
	projectId: string | undefined,
	options: WorkspacePreparationOptions,
): Promise<void> {
	const runtime = options.narratorId
		? (await runtimeDeviceClass(options.narratorId, deviceId, options.userId)).runtime
		: null;
	await options.validateDevice?.();
	if (deviceId === "local") {
		if (runtime && !runtime.allowLocalExecution)
			throw new AppError("Local execution is not allowed", 403, "WORKSPACE_ACCESS_DENIED");
		return;
	}
	if (runtime && !runtime.deviceIds.includes(deviceId))
		throw new AppError(
			"Remote device is outside the runtime authority",
			403,
			"WORKSPACE_ACCESS_DENIED",
		);
	const devices = await getSessionDevices(projectId, options.userId);
	const device = devices.find((entry) => entry.id === deviceId);
	if (!device)
		throw new AppError("Remote device is not authorized", 403, "WORKSPACE_ACCESS_DENIED");
	if (!device.online)
		throw workspaceConflict("Remote device is offline", "WORKSPACE_DEVICE_OFFLINE");
}

/** Revalidate stored root evidence, live policy and the same connection; never mint new evidence. */
export async function assertWorkspaceContextFresh(
	id: string,
	context: WorkspaceContext,
	options: WorkspacePreparationOptions = {},
): Promise<void> {
	await authorizeWorkspaceDevice(context.deviceId, context.contextProjectId, {
		...options,
		narratorId: id,
	});
	const backend = resolveBackend({ requested: context.deviceId });
	const generation = backend.runtimeGeneration;
	await assertTargetAllowed(id, context.cwd, backend, options.userId);
	if (
		context.pathFlavor === "windows" &&
		backend.kind === "remote" &&
		!context.nativeRootDescriptor
	)
		throw workspaceConflict(
			"Windows workspace needs original native root evidence",
			"WORKSPACE_DIRECTORY_NOT_CONFIGURED",
		);
	if (context.nativeRootDescriptor) {
		const info = await backend.statFile(context.cwd, {
			timeoutMs: 10_000,
			expectedNativeDescriptor: context.nativeRootDescriptor,
		});
		if (!info?.isDirectory) throw workspaceConflict("Workspace root is no longer available");
	}
	const fresh = await prepareWorkspaceContext(
		{ deviceId: context.deviceId, cwd: context.cwd },
		context.revision,
		context.contextProjectId,
		{ ...options, narratorId: id },
	);
	if (
		fresh.contextKey !== context.contextKey ||
		fresh.cwd !== context.cwd ||
		(context.nativeRootDescriptor &&
			JSON.stringify(fresh.nativeRootDescriptor) !==
				JSON.stringify(context.nativeRootDescriptor)) ||
		resolveBackend({ requested: context.deviceId }).runtimeGeneration !== generation
	)
		throw workspaceConflict("Workspace root or device connection changed");
}

/** Prepare one target using its own filesystem, never the host's path grammar. */
export async function prepareWorkspaceContext(
	target: { deviceId: string; cwd: string },
	revision: number,
	contextProjectId?: string,
	options: WorkspacePreparationOptions = {},
): Promise<WorkspaceContext> {
	await authorizeWorkspaceDevice(target.deviceId, contextProjectId, options);
	if (target.deviceId === "local") {
		const context = await prepareLocalWorkspaceContext(target.cwd, revision, contextProjectId);
		if (options.narratorId)
			await assertTargetAllowed(options.narratorId, context.cwd, localBackend, options.userId);
		return { ...context, availability: "ready" };
	}
	const backend = resolveBackend({ requested: target.deviceId });
	if (!backend.paths.isAbsolute(target.cwd))
		throw new ValidationError("cwd must be an absolute target path");
	const identity = await backend.resolvePathIdentity(target.cwd, { timeoutMs: 10_000 });
	const info = await backend.statFile(identity.canonicalPath, {
		timeoutMs: 10_000,
		expectedNativeDescriptor: identity.nativeDescriptor,
	});
	if (!identity.exists || !info?.isDirectory)
		throw new ValidationError("Remote working directory does not exist or is not accessible");
	if (info.resolvedPath && !backend.paths.equals(info.resolvedPath, identity.canonicalPath))
		throw workspaceConflict("Remote directory identity changed");
	const cwd = identity.canonicalPath;
	if (options.narratorId)
		await assertTargetAllowed(options.narratorId, cwd, backend, options.userId);
	let git: WorkspaceContext["git"];
	if (backend.supportsGitWorkspace && backend.gitWorkspace) {
		const probe = await backend.gitWorkspace(
			{
				operation: "probe",
				cwd,
				maxBytes: 64 * 1024,
				timeoutMs: 10_000,
			},
			AbortSignal.timeout(10_000),
		);
		if (probe.state === "ready" && probe.rootPath && probe.repositoryPath) {
			if (options.narratorId)
				await assertTargetAllowed(options.narratorId, probe.rootPath, backend, options.userId);
			git = {
				workspaceKey: gitWorkspaceIdentity(backend, probe.rootPath),
				repositoryKey: gitWorkspaceIdentity(backend, probe.repositoryPath),
				rootPath: probe.rootPath,
			};
		} else if (
			probe.state &&
			!["not_git", "git_unavailable", "unsupported"].includes(probe.state)
		) {
			throw new ValidationError(probe.reason ?? "Cannot resolve the remote Git workspace");
		}
	}
	return {
		revision,
		deviceId: backend.deviceId,
		cwd,
		pathFlavor: backend.paths.flavor === "windows" ? "windows" : "posix",
		contextProjectId,
		...(identity.nativeDescriptor ? { nativeRootDescriptor: identity.nativeDescriptor } : {}),
		git,
		availability: "ready",
		contextKey: createHash("sha256")
			.update(
				JSON.stringify([
					backend.deviceId,
					backend.paths.identityKey(cwd),
					git?.workspaceKey ?? null,
					git?.repositoryKey ?? null,
				]),
			)
			.digest("hex"),
		capabilities: { switchDirectory: true, ...workspaceFeatureCapabilities(backend) },
	};
}

export async function assertTargetAllowed(
	narratorId: string,
	cwd: string,
	backend: ExecutionBackend = localBackend,
	userId?: string | null,
) {
	if (backend.kind === "local") {
		const [home, nf] = await Promise.all([
			realpath(getHome()).catch(() => getHome()),
			realpath(narraforkDir).catch(() => narraforkDir),
		]);
		if (
			isSecretPlatformPath(cwd, nf) ||
			isSecretUserPath(cwd, home) ||
			backend.paths.contains(cwd, nf) ||
			[".ssh", ".aws", ".gnupg", ".kube"].some((part) =>
				backend.paths.contains(cwd, backend.paths.resolve(home, part)),
			)
		)
			throw new AppError("Workspace access denied", 403, "WORKSPACE_ACCESS_DENIED");
	}
	const { deviceClass } = await runtimeDeviceClass(narratorId, backend.deviceId, userId);
	const policy = await executionPolicyEngine.compile(narratorId, {
		backend,
		paths: backend.paths,
		deviceClass,
		target: {
			deviceId: backend.deviceId,
			backendKind: backend.kind,
			cwd,
			lexicalPath: cwd,
			canonicalPath: cwd,
			pathFlavor: backend.pathFlavor,
			runtimeGeneration: backend.runtimeGeneration,
			selectionSource: "session_default",
		},
	});
	if (policy.evaluatePath({ path: cwd, operation: "read" }).decision === "deny")
		throw new AppError(
			"Workspace access denied by execution policy",
			403,
			"WORKSPACE_ACCESS_DENIED",
		);
}

export function assertSwitchAdmission(id: string, options: WorkspaceSwitchOptions) {
	const active = activeNarrators.get(id);
	if (active?._workspaceInstallFailed)
		throw workspaceConflict("Workspace runtime requires recovery");
	if (isNarratorRevertAdmissionBlocked(id) || compactLocks.has(id))
		throw workspaceConflict("Narrator history is reserved");
	if (isNarratorMutationAdmissionBusy(id))
		throw workspaceConflict("Another workspace mutation is in progress", "WORKSPACE_CONTEXT_BUSY");
	if (options.origin === "http") {
		if (isNarratorRuntimeBusy(id))
			throw workspaceConflict("Narrator is busy", "WORKSPACE_CONTEXT_BUSY");
	} else {
		if (
			!active ||
			active !== options.active ||
			!active._loopRunning ||
			active._workspacePassInvalidated
		)
			throw workspaceConflict("Switching agent pass is no longer current");
		if (
			[...pendingPermissions.values(), ...pendingDangerReflections.values()].some(
				(pending) => pending.narratorId === id,
			)
		)
			throw workspaceConflict("Narrator is waiting for a permission decision");
	}
}

export async function installWorkspaceContext(
	id: string,
	current: WorkspaceContext,
): Promise<void> {
	executionPolicyEngine.invalidate(id);
	const active = activeNarrators.get(id);
	if (!active?.alive) return;
	active._workspacePassInvalidated = !!active._loopRunning;
	active._workspaceContext = current;
	active._defaultDeviceId = current.deviceId === "local" ? null : current.deviceId;
	active.cwd = current.cwd;
	active._lastTreeHash = undefined;
	active._bashBeforeStatus?.clear();
	if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
	active._gitTrackTimer = undefined;
	const { updateActiveNarratorCwdAndSkillContext } = await import("./narrator-session");
	await updateActiveNarratorCwdAndSkillContext(id, current.cwd);
	active._workspaceInstallFailed = false;
	active.conversationId = randomUUID();
	active._resetUpstreamSessionOnNextRequest = true;
}

export function pauseWorkspace(id: string) {
	const active = activeNarrators.get(id);
	if (!active) return;
	active._workspaceInstallFailed = true;
	active._workspacePassInvalidated = true;
	active.abortController.abort("Workspace installation failed");
}

/** Scalar indexed readiness, not a path/actor authorization or an existing-resource fence. */
export function workspaceSelectionInstallationStatus(id: string) {
	const row = db
		.select({ revision: narrators.workspaceRevision })
		.from(narrators)
		.where(eq(narrators.id, id))
		.get();
	if (!row) throw new NotFoundError("Narrator", id);
	const previousRevision = row.revision - 1;
	const legacyPending =
		previousRevision < 0
			? undefined
			: db
					.select({ id: workspaceSwitchRequests.id })
					.from(workspaceSwitchRequests)
					.where(
						and(
							eq(workspaceSwitchRequests.narratorId, id),
							eq(workspaceSwitchRequests.installState, "pending"),
							eq(workspaceSwitchRequests.expectedRevision, previousRevision),
						),
					)
					.limit(1)
					.get();
	const devicePending =
		previousRevision < 0
			? undefined
			: db
					.select({ id: narratorDeviceWorkspaceRequests.id })
					.from(narratorDeviceWorkspaceRequests)
					.where(
						and(
							eq(narratorDeviceWorkspaceRequests.narratorId, id),
							eq(narratorDeviceWorkspaceRequests.installState, "pending"),
							eq(narratorDeviceWorkspaceRequests.expectedSelectionRevision, previousRevision),
						),
					)
					.limit(1)
					.get();
	return {
		revision: row.revision,
		installed:
			!legacyPending && !devicePending && !activeNarrators.get(id)?._workspaceInstallFailed,
	};
}

/** New IO must not consume a durable selection whose runtime installation is paused. */
export function assertWorkspaceSelectionInstalled(id: string): void {
	if (!workspaceSelectionInstallationStatus(id).installed)
		throw workspaceConflict(
			"Workspace selection is committed but waiting for installation",
			"WORKSPACE_CONTEXT_INSTALL_PENDING",
		);
}

function switchRequestDigest(request: SwitchWorkingDirectoryRequest, actor: string | null) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				actor,
				request.expectedRevision,
				request.target.deviceId,
				request.target.cwd,
				request.expectedWorktreeKey ?? null,
			]),
		)
		.digest("hex");
}
export const workspaceContextService = {
	async withRevision<T>(
		id: string,
		expectedRevision: number,
		expectedWorktreeKey: string | undefined,
		action: (context: WorkspaceContext) => Promise<T>,
		options: { userId?: string | null } = {},
	): Promise<T> {
		// The request actor is a source, not a mutable option read after admission waits.
		const actor = { userId: options.userId };
		return withNarratorMutationAdmission(id, async () => {
			if (isNarratorRevertAdmissionBlocked(id))
				throw workspaceConflict("Narrator history is reserved");
			assertWorkspaceSelectionInstalled(id);
			const context = await this.get(id, actor);
			if (
				context.revision !== expectedRevision ||
				(expectedWorktreeKey !== undefined && context.git?.workspaceKey !== expectedWorktreeKey)
			)
				throw workspaceConflict("Workspace identity changed");
			return action(context);
		});
	},
	async getRequest(id: string, requestId: string) {
		return db.query.workspaceSwitchRequests.findFirst({
			where: and(
				eq(workspaceSwitchRequests.narratorId, id),
				eq(workspaceSwitchRequests.requestId, requestId),
			),
		});
	},
	async recoverRequest(
		id: string,
		requestId: string,
		options: WorkspaceSwitchOptions,
	): Promise<SwitchWorkingDirectoryResult> {
		const receipt = await this.getRequest(id, requestId);
		if (!receipt) throw new NotFoundError("Workspace request", requestId);
		if (receipt.actorUserId !== (options.userId ?? null))
			throw new AppError(
				"Workspace recovery belongs to its original actor",
				403,
				"WORKSPACE_ACCESS_DENIED",
			);
		if (receipt.installState !== "pending") return receipt.result;
		const check = () => {
			if (
				activeNarrators.get(id)?._loopRunning ||
				isNarratorRevertAdmissionBlocked(id) ||
				compactLocks.has(id) ||
				[...pendingPermissions.values(), ...pendingDangerReflections.values()].some(
					(pending) => pending.narratorId === id,
				)
			)
				throw workspaceConflict("Workspace recovery is busy", "WORKSPACE_CONTEXT_BUSY");
		};
		check();
		const current = receipt.result.current;
		await assertWorkspaceContextFresh(id, current, { ...options, narratorId: id });
		const generation = resolveBackend({ requested: current.deviceId }).runtimeGeneration;
		return withNarratorMutationAdmission(
			id,
			async () => {
				check();
				const row = await loadWorkspaceRow(id);
				if (
					row.workspaceRevision !== current.revision ||
					row.workspaceContext?.contextKey !== current.contextKey
				) {
					await db
						.update(workspaceSwitchRequests)
						.set({ installState: "superseded", updatedAt: new Date().toISOString() })
						.where(eq(workspaceSwitchRequests.id, receipt.id));
					return receipt.result;
				}
				if (resolveBackend({ requested: current.deviceId }).runtimeGeneration !== generation)
					throw workspaceConflict("Recovery device connection changed");
				try {
					await installWorkspaceContext(id, current);
					await db
						.update(workspaceSwitchRequests)
						.set({ installState: "installed", updatedAt: new Date().toISOString() })
						.where(eq(workspaceSwitchRequests.id, receipt.id));
				} catch (error) {
					pauseWorkspace(id);
					throw error;
				}
				return receipt.result;
			},
			{ failIfBusy: true },
		);
	},
	async get(
		id: string,
		options: { userId?: string | null; persistLegacy?: boolean } = {},
	): Promise<WorkspaceContext> {
		const row = await loadWorkspaceRow(id);
		const chapter = row.chapterId
			? await db.query.chapters.findFirst({
					where: eq(chapters.id, row.chapterId),
					columns: { worktreePath: true, projectId: true },
				})
			: undefined;
		const projectId = chapter?.projectId ?? row.contextProjectId ?? undefined;
		const supported =
			row.variant === "primary" &&
			!row.traits.includes("background") &&
			!isKnowledgeStewardNarrator(row.traits);
		const committed =
			row.workspaceContext?.revision === row.workspaceRevision ? row.workspaceContext : null;
		let context: WorkspaceContext;
		if (committed) {
			// A committed device/cwd owns the session even when legacy mirrors disagree.
			context = { ...committed, contextProjectId: projectId };
			if (
				options.persistLegacy !== false &&
				(row.cwd !== context.cwd || (row.defaultDeviceId ?? "local") !== context.deviceId)
			) {
				await db
					.update(narrators)
					.set({
						cwd: context.cwd,
						defaultDeviceId: context.deviceId === "local" ? null : context.deviceId,
					})
					.where(and(eq(narrators.id, id), eq(narrators.workspaceRevision, row.workspaceRevision)));
			}
		} else {
			const deviceId = row.defaultDeviceId ?? "local";
			if (deviceId !== "local") {
				return {
					...unavailableWorkspaceContext(deviceId, "", "posix", row.workspaceRevision, projectId),
					availability: "needs_initialization",
					capabilities: {
						switchDirectory: supported,
						reason: "Remote workspace needs initialization; no local fallback",
					},
				};
			} else {
				const project = projectId
					? await db.query.projects.findFirst({
							where: eq(projects.id, projectId),
							columns: { gitPath: true },
						})
					: undefined;
				context = await prepareLocalWorkspaceContext(
					resolveNarratorSessionCwd(row.cwd, chapter?.worktreePath, project?.gitPath, getHome()),
					row.workspaceRevision,
					projectId,
					true,
				);
			}
			if (options.persistLegacy !== false) {
				const rows = await db
					.update(narrators)
					.set({
						cwd: context.cwd,
						defaultDeviceId: context.deviceId === "local" ? null : context.deviceId,
						workspaceContext: context,
					})
					.where(
						and(
							eq(narrators.id, id),
							eq(narrators.workspaceRevision, row.workspaceRevision),
							row.workspaceContext === null
								? isNull(narrators.workspaceContext)
								: eq(narrators.workspaceContext, row.workspaceContext),
						),
					)
					.returning({ id: narrators.id });
				if (rows.length !== 1) return this.get(id, options);
			}
		}
		if (options.persistLegacy !== false && context.cwd && !context.binding) {
			context = db.transaction((tx) => {
				const latest = tx
					.select({ revision: narrators.workspaceRevision, context: narrators.workspaceContext })
					.from(narrators)
					.where(eq(narrators.id, id))
					.get();
				if (
					latest?.revision !== context.revision ||
					latest.context?.contextKey !== context.contextKey
				)
					throw workspaceConflict("Workspace changed during legacy binding initialization");
				const augmented = saveLegacyDeviceWorkspaceBinding(tx, id, context);
				tx.update(narrators).set({ workspaceContext: augmented }).where(eq(narrators.id, id)).run();
				return augmented;
			});
		}
		let backend: ExecutionBackend | null = null;
		try {
			backend = resolveBackend({ requested: context.deviceId });
		} catch {
			/* No host fallback. */
		}
		const online = backend !== null;
		const { reason: _reason, ...capabilities } = context.capabilities;
		return {
			...context,
			availability: online ? "ready" : "offline",
			capabilities: {
				...capabilities,
				...workspaceFeatureCapabilities(backend),
				switchDirectory: supported,
				...(!supported
					? { reason: "Only ordinary primary narrators support directory switching" }
					: !online
						? { reason: "Remote device is offline; no local fallback" }
						: {}),
			},
		};
	},
	/** Device selection uses the same CAS and publication protocol as cwd selection. */
	async switchDevice(id: string, deviceId: string | null, options: WorkspaceSwitchOptions) {
		assertSwitchAdmission(id, options);
		const previous = await this.get(id, { userId: options.userId, persistLegacy: false });
		const targetDeviceId = deviceId ?? "local";
		if (targetDeviceId === previous.deviceId) {
			if (!previous.cwd || previous.availability === "needs_initialization")
				throw workspaceConflict(
					"Device workspace needs explicit initialization",
					"WORKSPACE_DIRECTORY_NOT_CONFIGURED",
				);
			await assertWorkspaceContextFresh(id, previous, { ...options, narratorId: id });
			const current = await this.get(id, { userId: options.userId });
			return { changed: false, previous: current, current };
		}
		await authorizeWorkspaceDevice(targetDeviceId, previous.contextProjectId, {
			...options,
			narratorId: id,
		});
		const binding = readDeviceWorkspaceBinding(db, id, targetDeviceId);
		if (!binding)
			throw workspaceConflict(
				"Device workspace needs explicit initialization",
				"WORKSPACE_DIRECTORY_NOT_CONFIGURED",
			);
		const cwd = binding.context.cwd;
		await assertWorkspaceContextFresh(id, binding.context, { ...options, narratorId: id });
		return this.switch(
			id,
			{
				expectedRevision: previous.revision,
				requestId: randomUUID(),
				target: { deviceId: targetDeviceId, cwd },
			},
			{ ...options, deviceOnly: true },
		);
	},
	async switch(
		id: string,
		request: SwitchWorkingDirectoryRequest,
		options: WorkspaceSwitchOptions,
	): Promise<SwitchWorkingDirectoryResult> {
		const actor = options.userId ?? null;
		const digest = switchRequestDigest(request, actor);
		const replay = async (): Promise<SwitchWorkingDirectoryResult | null> => {
			const newReceipt = await db
				.select({ id: narratorDeviceWorkspaceRequests.id })
				.from(narratorDeviceWorkspaceRequests)
				.where(
					and(
						eq(narratorDeviceWorkspaceRequests.narratorId, id),
						eq(narratorDeviceWorkspaceRequests.requestId, request.requestId),
					),
				)
				.limit(1);
			if (newReceipt.length)
				throw workspaceConflict(
					"Request id belongs to a device workspace mutation",
					"WORKSPACE_REQUEST_CONFLICT",
				);
			const receipt = await this.getRequest(id, request.requestId);
			if (!receipt) return null;
			if (receipt.requestDigest !== digest || receipt.actorUserId !== actor)
				throw workspaceConflict(
					"Request id was already used for a different workspace selection",
					"WORKSPACE_REQUEST_CONFLICT",
				);
			if (receipt.installState === "pending")
				return this.recoverRequest(id, request.requestId, options);
			return receipt.result;
		};
		const prior = await replay();
		if (prior) return prior;
		let preparedGeneration: number | undefined;
		let committedContext: WorkspaceContext | undefined;
		try {
			const result = await transitionWorkspaceContext(request, {
				read: () => this.get(id, { userId: actor, persistLegacy: false }),
				checkAdmission: () => assertSwitchAdmission(id, options),
				prepare: async (previous, input) => {
					if (!previous.capabilities.switchDirectory && !options.deviceOnly)
						throw workspaceConflict(
							"Specialized narrator directory switching is unsupported",
							"WORKSPACE_CONTEXT_UNSUPPORTED",
						);
					if (!options.deviceOnly && (await resolveOAuthNarratorRuntimePolicy(id, actor)))
						throw workspaceConflict(
							"OAuth directory switching is not enabled by policy",
							"WORKSPACE_CONTEXT_UNSUPPORTED",
						);
					const row = await loadWorkspaceRow(id);
					if (options.origin === "http" && (row.status === "working" || row.status === "waiting"))
						throw workspaceConflict("Narrator is busy", "WORKSPACE_CONTEXT_BUSY");
					await authorizeWorkspaceDevice(input.target.deviceId, previous.contextProjectId, {
						...options,
						narratorId: id,
					});
					preparedGeneration = resolveBackend({
						requested: input.target.deviceId,
					}).runtimeGeneration;
					const target = await prepareWorkspaceContext(
						input.target,
						previous.revision,
						previous.contextProjectId,
						{ ...options, narratorId: id },
					);
					if (
						preparedGeneration !== resolveBackend({ requested: target.deviceId }).runtimeGeneration
					)
						throw workspaceConflict("Device connection changed during preparation");
					if (row.chapterId && !options.deviceOnly) {
						const chapter = await db.query.chapters.findFirst({
							where: eq(chapters.id, row.chapterId),
							columns: { worktreePath: true },
						});
						const root = chapter?.worktreePath
							? await realpath(chapter.worktreePath).catch(() => null)
							: null;
						if (
							target.deviceId !== "local" ||
							!root ||
							!isInsidePath(root, target.cwd) ||
							previous.git?.workspaceKey !== target.git?.workspaceKey
						)
							throw workspaceConflict(
								"Chapter cross-worktree switching is unsupported",
								"WORKSPACE_CONTEXT_UNSUPPORTED",
							);
					}
					if (input.expectedWorktreeKey && input.expectedWorktreeKey !== target.git?.workspaceKey)
						throw workspaceConflict("Target worktree identity changed");
					target.compatibility = {
						version: 1,
						localCwd:
							previous.deviceId === "local" ? previous.cwd : previous.compatibility?.localCwd,
					};
					return target;
				},
				admit: (action) => withNarratorMutationAdmission(id, action, { failIfBusy: true }),
				commit: async (previous, current) => {
					const backend = resolveBackend({ requested: current.deviceId });
					if (backend.runtimeGeneration !== preparedGeneration)
						throw workspaceConflict("Execution device changed while preparing the workspace");
					await assertWorkspaceContextFresh(id, current, { ...options, narratorId: id });
					if (
						backend.runtimeGeneration !==
						resolveBackend({ requested: current.deviceId }).runtimeGeneration
					)
						throw workspaceConflict("Target directory identity changed");
					return withWorkspaceAdmission(
						{
							deviceId: current.deviceId,
							path: current.cwd,
							repositoryKey: current.git?.repositoryKey,
						},
						async () =>
							db.transaction((tx) => {
								// Preserve the departed endpoint, then save only the target pair.
								if (previous.cwd && !readDeviceWorkspaceBinding(tx, id, previous.deviceId))
									saveLegacyDeviceWorkspaceBinding(tx, id, previous);
								const augmented = saveLegacyDeviceWorkspaceBinding(tx, id, current);
								const rows = tx
									.update(narrators)
									.set({
										cwd: current.cwd,
										defaultDeviceId: current.deviceId === "local" ? null : current.deviceId,
										workspaceRevision: current.revision,
										workspaceContext: augmented,
										apiConversationId: null,
										updatedAt: new Date().toISOString(),
									})
									.where(
										and(eq(narrators.id, id), eq(narrators.workspaceRevision, previous.revision)),
									)
									.returning({ id: narrators.id })
									.all();
								if (rows.length !== 1) throw workspaceConflict("Workspace revision changed");
								committedContext = augmented;
								tx.insert(workspaceSwitchRequests)
									.values({
										id: generateId(),
										narratorId: id,
										requestId: request.requestId,
										actorUserId: actor,
										requestDigest: digest,
										expectedRevision: request.expectedRevision,
										result: { changed: true, previous, current: augmented },
										installState: "pending",
										createdAt: new Date().toISOString(),
										updatedAt: new Date().toISOString(),
									})
									.run();
								return true;
							}),
					);
				},
				install: async (current) => {
					await installWorkspaceContext(id, committedContext ?? current);
					await db
						.update(workspaceSwitchRequests)
						.set({ installState: "installed", updatedAt: new Date().toISOString() })
						.where(
							and(
								eq(workspaceSwitchRequests.narratorId, id),
								eq(workspaceSwitchRequests.requestId, request.requestId),
							),
						);
				},
				pause: () => pauseWorkspace(id),
				publish: ({ previous, current }) =>
					broadcastToNarrator(id, {
						type: "workspace_context_changed",
						narratorId: id,
						previous,
						current: committedContext ?? current,
					}),
			});
			if (!result.changed) {
				const saved = db.transaction((tx) => {
					const latest = tx
						.select({ revision: narrators.workspaceRevision })
						.from(narrators)
						.where(eq(narrators.id, id))
						.get();
					if (latest?.revision !== result.current.revision)
						throw workspaceConflict("Workspace revision changed");
					const augmented = saveLegacyDeviceWorkspaceBinding(tx, id, result.current);
					tx.update(narrators)
						.set({
							workspaceContext: augmented,
							cwd: augmented.cwd,
							defaultDeviceId: augmented.deviceId === "local" ? null : augmented.deviceId,
						})
						.where(eq(narrators.id, id))
						.run();
					const savedResult = { ...result, previous: augmented, current: augmented };
					tx.insert(workspaceSwitchRequests)
						.values({
							id: generateId(),
							narratorId: id,
							requestId: request.requestId,
							actorUserId: actor,
							requestDigest: digest,
							expectedRevision: request.expectedRevision,
							result: savedResult,
							installState: "installed",
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
						})
						.onConflictDoNothing()
						.run();
					return savedResult;
				});
				return (await replay()) ?? saved;
			}
			return committedContext ? { ...result, current: committedContext } : result;
		} catch (error) {
			if (error instanceof AppError && error.code === "WORKSPACE_CONTEXT_INSTALL_FAILED")
				throw error;
			const receipt = await replay();
			if (receipt) return receipt;
			throw error;
		}
	},
};
