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
import { chapters, narrators, projects, workspaceSwitchRequests } from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { localBackend, resolveBackend } from "../lib/agent/execution/registry";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { isSecretPlatformPath, isSecretUserPath } from "../lib/fs-secret-paths";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
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

async function runtimeDeviceClass(narratorId: string, deviceId: string, userId?: string | null) {
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
async function authorizeWorkspaceDevice(
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

async function assertTargetAllowed(
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

function assertSwitchAdmission(id: string, options: WorkspaceSwitchOptions) {
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

function pauseWorkspace(id: string) {
	const active = activeNarrators.get(id);
	if (!active) return;
	active._workspaceInstallFailed = true;
	active._workspacePassInvalidated = true;
	active.abortController.abort("Workspace installation failed");
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
	): Promise<T> {
		return withNarratorMutationAdmission(id, async () => {
			if (isNarratorRevertAdmissionBlocked(id))
				throw workspaceConflict("Narrator history is reserved");
			const context = await this.get(id);
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
		const fresh = await prepareWorkspaceContext(
			{ deviceId: current.deviceId, cwd: current.cwd },
			current.revision,
			current.contextProjectId,
			{ ...options, narratorId: id },
		);
		if (fresh.contextKey !== current.contextKey)
			throw workspaceConflict("Recovery directory identity changed");
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
				try {
					const backend = resolveBackend({ requested: deviceId });
					if (!backend.defaultCwd)
						throw new ValidationError("Remote directory needs configuration");
					context = await prepareWorkspaceContext(
						{ deviceId, cwd: backend.defaultCwd },
						row.workspaceRevision,
						projectId,
						{
							narratorId: id,
							userId: options.userId ?? null,
						},
					);
					context.compatibility = { version: 1, ...(row.cwd ? { localCwd: row.cwd } : {}) };
				} catch (error) {
					logger.warn("Remote workspace initialization unavailable", {
						narratorId: id,
						deviceId,
						errorType: error instanceof Error ? error.name : "unknown",
						errorCode: error instanceof AppError ? error.code : undefined,
					});
					return {
						...unavailableWorkspaceContext(deviceId, "", "posix", row.workspaceRevision, projectId),
						capabilities: {
							switchDirectory: supported,
							reason: "Remote workspace needs initialization; no local fallback",
						},
					};
				}
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
		if (targetDeviceId === previous.deviceId)
			return { changed: false, previous, current: previous };
		await authorizeWorkspaceDevice(targetDeviceId, previous.contextProjectId, {
			...options,
			narratorId: id,
		});
		let cwd: string;
		if (targetDeviceId !== "local") {
			const backend = resolveBackend({ requested: targetDeviceId });
			if (!backend.defaultCwd) throw new ValidationError("Remote device has no default directory");
			cwd = backend.defaultCwd;
		} else {
			const row = await loadWorkspaceRow(id);
			const chapter = row.chapterId
				? await db.query.chapters.findFirst({
						where: eq(chapters.id, row.chapterId),
						columns: { worktreePath: true },
					})
				: undefined;
			cwd = previous.compatibility?.localCwd ?? chapter?.worktreePath ?? getHome();
		}
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
					const target = await prepareWorkspaceContext(
						input.target,
						previous.revision,
						previous.contextProjectId,
						{ ...options, narratorId: id },
					);
					preparedGeneration = resolveBackend({ requested: target.deviceId }).runtimeGeneration;
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
					const fresh = await prepareWorkspaceContext(
						{ deviceId: current.deviceId, cwd: current.cwd },
						current.revision,
						current.contextProjectId,
						{ ...options, narratorId: id },
					);
					if (
						fresh.contextKey !== current.contextKey ||
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
								const rows = tx
									.update(narrators)
									.set({
										cwd: current.cwd,
										defaultDeviceId: current.deviceId === "local" ? null : current.deviceId,
										workspaceRevision: current.revision,
										workspaceContext: current,
										apiConversationId: null,
										updatedAt: new Date().toISOString(),
									})
									.where(
										and(eq(narrators.id, id), eq(narrators.workspaceRevision, previous.revision)),
									)
									.returning({ id: narrators.id })
									.all();
								if (rows.length !== 1) return false;
								tx.insert(workspaceSwitchRequests)
									.values({
										id: generateId(),
										narratorId: id,
										requestId: request.requestId,
										actorUserId: actor,
										requestDigest: digest,
										expectedRevision: request.expectedRevision,
										result: { changed: true, previous, current },
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
					await installWorkspaceContext(id, current);
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
						current,
					}),
			});
			if (!result.changed) {
				await db
					.insert(workspaceSwitchRequests)
					.values({
						id: generateId(),
						narratorId: id,
						requestId: request.requestId,
						actorUserId: actor,
						requestDigest: digest,
						expectedRevision: request.expectedRevision,
						result,
						installState: "installed",
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					})
					.onConflictDoNothing()
					.run();
				return (await replay()) ?? result;
			}
			return result;
		} catch (error) {
			if (error instanceof AppError && error.code === "WORKSPACE_CONTEXT_INSTALL_FAILED")
				throw error;
			const receipt = await replay();
			if (receipt) return receipt;
			throw error;
		}
	},
};
