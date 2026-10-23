import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { nativePathEquals } from "@shared/target-native-path";
import type { WorkspaceContext } from "@shared/workspace-context";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, terminals, users } from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { resolveBackend } from "../lib/agent/execution/registry";
import { detectShell } from "../lib/agent/shell";
import { resetCursorForTerminal } from "../lib/agent/tools/terminal";
import type { ToolExecutionTarget } from "../lib/agent/types";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { envWithAmbientProxy } from "../lib/net/proxy-env";
import { DEV_NULL, getHome, IS_WINDOWS } from "../lib/platform";
import { BufferManager } from "../terminal/buffer-manager";
import {
	dtachService,
	findProcessesByArg,
	getDescendantPids,
	ProcessSnapshot,
} from "../terminal/dtach-service";
import type { TerminalRuntime, TerminalSpawnOptions } from "../terminal/runtime";
import { spawnBunTerminal } from "../terminal/runtime-bun";
import { spawnPortablePty } from "../terminal/runtime-pty";
import {
	REMOTE_PTY_BOUNDED_IO_FEATURE,
	REMOTE_PTY_CONPTY_FEATURE,
	REMOTE_PTY_LIFECYCLE_FEATURE,
	REMOTE_PTY_READY_FEATURE,
	type RemoteTerminalRuntime,
	spawnRemotePty,
} from "../terminal/runtime-remote";
import { sendToTerminal } from "../websocket/terminal-ws";
import { getConnectedDeviceHello, isDeviceOnline } from "./device-connection-service";
import {
	DeviceScopeError,
	deviceHasFeature,
	isDeviceAuthorized,
	requireAuthorizedDeviceForProject,
} from "./device-service";
import { executionPolicyEngine } from "./execution-policy/engine";
import type { ExecutionDeviceClass } from "./execution-policy/types";
import type { NarratorPrincipal } from "./narrator-acl";
import { loadNarratorForAccess } from "./narrator-acl";
import {
	finishRemoteActivity,
	markRemoteActivityRunning,
	registerRemoteActivity,
	registerRemoteTerminalActivity,
} from "./remote-tree-snapshot-hooks";
import { assertLegacyRuntimeOwner } from "./worktree-resource-owner";

const DEFAULT_SHELL = detectShell().path;

/** A human shell writer needs live actor, narrator and original project write authority. */
async function terminalCreationAuthority(opts: CreateTerminalOptions, projectId: string | null) {
	if (!opts.principal)
		throw new AppError("Authenticated terminal principal required", 403, "TERMINAL_ACTOR_REQUIRED");
	const user = await db.query.users.findFirst({
		where: eq(users.id, opts.principal.userId),
		columns: { role: true },
	});
	if (!user)
		throw new AppError("Terminal principal is unavailable", 403, "TERMINAL_ACTOR_REQUIRED");
	const principal = { userId: opts.principal.userId, isAdmin: user.role === "admin" };
	if (opts.narratorId) await loadNarratorForAccess(opts.narratorId, principal, "write");
	if (opts.chapterId || projectId) {
		const { assertChapterProjectAccess, loadProjectForAccess } = await import("./project-acl");
		if (opts.chapterId) await assertChapterProjectAccess(opts.chapterId, principal, "write");
		// Do not reinterpret the frozen endpoint through a narrator's later project binding.
		if (projectId) await loadProjectForAccess(projectId, principal, "write");
	}
	return principal;
}

/** Device ownership has its own ceiling, independent of the actor/narrator's OAuth group. */
async function terminalDeviceAuthority(
	deviceId: string,
	projectId: string | null,
	principal: NarratorPrincipal,
	need: "read" | "write",
) {
	const device = await requireAuthorizedDeviceForProject(deviceId, projectId, principal.userId);
	const { resolveOAuthDeviceRuntimeAuthorization } = await import("./oauth-device-runtime-policy");
	const oauth = await resolveOAuthDeviceRuntimeAuthorization(device);
	const level = oauth.policy?.deviceAccess.selfRegistered;
	if (
		!isDeviceAuthorized(device, { userId: principal.userId, projectId }) ||
		!oauth.allowed ||
		(oauth.oauthOwned &&
			(need === "write" ? level !== "readWrite" : level !== "readOnly" && level !== "readWrite"))
	)
		throw new AppError(
			"Terminal execution device access denied by live device authority",
			403,
			"DEVICE_SCOPE_FORBIDDEN",
		);
	return device;
}

/** Classify OAuth selectors BEFORE compiling path policy; ordinary narrators use null. */
async function terminalRuntimeAuthority(
	narratorId: string,
	backend: ExecutionBackend,
	need: "read" | "write",
	userId: string,
) {
	const { resolveOAuthNarratorRuntimePolicy } = await import("./oauth-narrator-runtime-policy");
	const oauth = await resolveOAuthNarratorRuntimePolicy(narratorId, userId);
	if (!oauth) return { oauth, deviceClass: null };
	const { integrationResourceBindingService } = await import(
		"./integration-resource-binding-service"
	);
	const binding =
		backend.kind === "remote"
			? await integrationResourceBindingService.get("device", backend.deviceId)
			: null;
	const deviceClass: ExecutionDeviceClass =
		backend.kind === "local"
			? "host"
			: binding?.sourceType === "oauth_client" &&
					binding.sourceId === oauth.clientId &&
					binding.authorityId === oauth.grantId
				? "selfRegistered"
				: "global";
	if (
		(backend.kind === "local"
			? !oauth.allowLocalExecution
			: !oauth.deviceIds.includes(backend.deviceId)) ||
		!oauth.allowedTools.has("Terminal") ||
		(need === "write"
			? oauth.policy.deviceAccess[deviceClass] !== "readWrite"
			: oauth.policy.deviceAccess[deviceClass] === "denied")
	)
		throw new AppError(
			"Terminal exceeds external runtime authority",
			403,
			"TERMINAL_AUTHORITY_DENIED",
		);
	return { oauth, deviceClass };
}

function assertTerminalAuthorityStable(
	before: Awaited<ReturnType<typeof terminalRuntimeAuthority>>,
	after: Awaited<ReturnType<typeof terminalRuntimeAuthority>>,
) {
	if (
		before.deviceClass !== after.deviceClass ||
		before.oauth?.clientId !== after.oauth?.clientId ||
		before.oauth?.grantId !== after.oauth?.grantId ||
		before.oauth?.useRobotDiagnosticPreset !== after.oauth?.useRobotDiagnosticPreset
	)
		throw new AppError(
			"Terminal runtime authority changed before dispatch",
			409,
			"TERMINAL_AUTHORITY_CHANGED",
		);
}

export interface TerminalProcessInfo {
	pid: number;
	ppid: number;
	command: string;
	state: string;
	rss: number;
	cpu: number;
	elapsed: string;
}

/** Batch-fetch process info for multiple PIDs in a single ps call. */
async function getProcessInfoBatch(pids: number[]): Promise<Map<number, TerminalProcessInfo>> {
	const result = new Map<number, TerminalProcessInfo>();
	if (pids.length === 0) return result;
	try {
		if (IS_WINDOWS) {
			const pwsh = Bun.which("pwsh") ?? Bun.which("powershell.exe");
			if (!pwsh) return result;
			const pidList = pids.join(",");
			const proc = Bun.spawn(
				[
					pwsh,
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`Get-Process -Id ${pidList} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.Parent.Id)|$($_.ProcessName)|$($_.WorkingSet64)|$($_.CPU)" }`,
				],
				{ stdout: "pipe", stderr: "ignore", stdin: "ignore" },
			);
			const output = await Promise.race([
				proc.exited.then(async (code) => {
					if (code !== 0) return null;
					return new Response(proc.stdout).text();
				}),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
			]);
			try {
				proc.kill();
			} catch {
				// already exited
			}
			if (!output) return result;
			for (const line of output.trim().split(/\r?\n/)) {
				const parts = line.split("|");
				if (parts.length < 5) continue;
				const pid = Number.parseInt(parts[0], 10);
				if (Number.isNaN(pid)) continue;
				const ppid = Number.parseInt(parts[1], 10);
				result.set(pid, {
					pid,
					ppid: Number.isNaN(ppid) ? 0 : ppid,
					command: parts[2] || "",
					state: "running",
					rss: Math.round((Number.parseInt(parts[3], 10) || 0) / 1024),
					cpu: Number.parseFloat(parts[4]) || 0,
					elapsed: "",
				});
			}
			return result;
		}
		const proc = Bun.spawn(
			["ps", "-o", "pid=,ppid=,comm=,stat=,rss=,%cpu=,etime=", "-p", pids.join(",")],
			{ stdout: "pipe", stderr: "ignore", stdin: "ignore" },
		);
		const output = await Promise.race([
			proc.exited.then(async (code) => {
				if (code !== 0) return null;
				return new Response(proc.stdout).text();
			}),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
		]);
		try {
			proc.kill();
		} catch {
			// already exited
		}
		if (!output) return result;
		for (const line of output.trim().split("\n")) {
			const parts = line.trim().split(/\s+/);
			if (parts.length < 7) continue;
			const pid = Number.parseInt(parts[0], 10);
			if (Number.isNaN(pid)) continue;
			result.set(pid, {
				pid,
				ppid: Number.parseInt(parts[1], 10),
				command: parts[2],
				state: parts[3],
				rss: Number.parseInt(parts[4], 10),
				cpu: Number.parseFloat(parts[5]),
				elapsed: parts[6],
			});
		}
	} catch {
		// fallback: empty
	}
	return result;
}

interface ActiveTerminal {
	runtime: TerminalRuntime;
	terminalId: string;
	buffer: BufferManager;
	useDtach: boolean;
	closing?: boolean;
}

const activeTerminals = new Map<string, ActiveTerminal>();

function lifecycleFor(terminal: {
	id: string;
	status: string;
	exitCode: number | null;
	deviceId?: string | null;
}) {
	const active = activeTerminals.get(terminal.id);
	return {
		state: active?.closing
			? ("closing" as const)
			: terminal.status === "running" &&
					(!terminal.deviceId || terminal.deviceId === "local" || active)
				? ("ready" as const)
				: terminal.exitCode === null
					? ("unknown" as const)
					: ("exited" as const),
		code: terminal.exitCode,
	};
}
function broadcastExit(terminalId: string, code: number | null) {
	if (typeof code === "number" && Number.isInteger(code)) {
		sendToTerminal(terminalId, { type: "exit", terminalId, code });
	} else {
		sendToTerminal(terminalId, { type: "lifecycle", terminalId, state: "unknown", code: null });
	}
}

/**
 * Mark a terminal as exited in DB and emit the lifecycle event.
 *
 * @param narratorId - Pass `null` if the terminal has no narrator.
 *   Pass `undefined` (or omit) to have the function look up the value from DB.
 * @param chapterId  - Same convention as narratorId.
 */
async function markTerminalExited(
	terminalId: string,
	exitCode: number | null,
	narratorId?: string | null,
	chapterId?: string | null,
) {
	await db
		.update(terminals)
		.set({ status: "exited", exitCode })
		.where(eq(terminals.id, terminalId));
	// Resolve narrator/chapter IDs if not provided
	let nId = narratorId;
	let cId = chapterId;
	if (nId === undefined || cId === undefined) {
		const row = await db.query.terminals.findFirst({
			where: eq(terminals.id, terminalId),
			columns: { narratorId: true, chapterId: true },
		});
		if (row) {
			if (nId === undefined) nId = row.narratorId;
			if (cId === undefined) cId = row.chapterId;
		}
	}
	eventBus.emit({
		type: "terminal:exited",
		terminalId,
		narratorId: nId ?? null,
		chapterId: cId ?? null,
	});
}

function onData(id: string, buffer: BufferManager, data: string | Uint8Array) {
	const text = typeof data === "string" ? data : new TextDecoder().decode(data);
	if (text) {
		buffer.append(text);
		sendToTerminal(id, { type: "output", terminalId: id, data: text });
	}
}

/**
 * Monitor a dtach attach process. When it exits:
 * - If the dtach socket is still alive, save buffer and remove from activeTerminals
 *   (lazy re-attach will happen when a client subscribes via ensureAttached).
 * - If the socket is dead, the shell truly exited — mark terminal as exited.
 */
function monitorAttachProcess(
	terminalId: string,
	runtime: TerminalRuntime,
	narratorId?: string | null,
	chapterId?: string | null,
) {
	runtime.exited.then(async (code) => {
		const active = activeTerminals.get(terminalId);
		if (!active) return;

		if (await dtachService.isSocketAlive(terminalId)) {
			// Detached — save buffer, remove from active. Will re-attach on demand.
			active.buffer.saveToDisk();
			active.runtime.close();
			activeTerminals.delete(terminalId);
			logger.info("dtach attach process exited, session still alive", { terminalId });
			return;
		}

		// Shell actually exited
		await active.buffer.dispose();
		activeTerminals.delete(terminalId);
		runtime.close();
		await markTerminalExited(terminalId, code, narratorId, chapterId);
		broadcastExit(terminalId, code);
		logger.info("Terminal exited", { terminalId, code });
	});
}

export interface CreateTerminalOptions {
	chapterId?: string;
	narratorId?: string;
	name?: string;
	cols?: number;
	rows?: number;
	deviceId?: string;
	worktreeResourceId?: string;
	expectedRevision?: number;
	contextKey?: string;
	/** Pair binding pin, independent of the selected workspace revision. */
	expectedBindingRevision?: number;
	bindingId?: string;
	signal?: AbortSignal;
	principal?: NarratorPrincipal;
}

const TERMINAL_METADATA_COLUMNS = {
	id: true,
	chapterId: true,
	narratorId: true,
	name: true,
	cwd: true,
	deviceId: true,
	ownerUserId: true,
	workspaceRevision: true,
	status: true,
	exitCode: true,
	createdAt: true,
} as const;
export const TERMINAL_METADATA_LIST_LIMIT = 128;

export const terminalService = {
	async create(opts: CreateTerminalOptions) {
		if (opts.chapterId && opts.narratorId)
			throw new ValidationError("Only one of chapterId or narratorId may be provided");
		if (!opts.narratorId) return this.createAdmitted(opts);
		if (!opts.principal)
			throw new AppError(
				"Terminal creation requires an authenticated actor",
				403,
				"TERMINAL_ACTOR_REQUIRED",
			);
		const narratorId = opts.narratorId;
		const signal = opts.signal
			? AbortSignal.any([opts.signal, AbortSignal.timeout(10_000)])
			: AbortSignal.timeout(10_000);
		const principal = await terminalCreationAuthority(opts, null);
		const actor = { userId: principal.userId };
		const { workspaceContextService, assertWorkspaceSelectionInstalled } = await import(
			"./workspace-context-service"
		);
		assertWorkspaceSelectionInstalled(narratorId);
		const { createDeviceWorkspaceConfig } = await import("./workspace-artifact-access");
		const explicit = opts.deviceId !== undefined;
		// Resolve the pair before asking the legacy projection service to initialize:
		// an unconfigured local narrator must not create a home-based workspace.
		const stored = explicit
			? undefined
			: await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { workspaceContext: true, defaultDeviceId: true },
				});
		const deviceId =
			opts.deviceId ?? stored?.workspaceContext?.deviceId ?? stored?.defaultDeviceId ?? "local";
		const config = await createDeviceWorkspaceConfig(narratorId, { ...actor, signal });
		const resolved = await config.resolveDeviceWorkspace?.(deviceId);
		if (!resolved?.cwd)
			throw new AppError(
				"Terminal device workspace is not configured",
				409,
				"WORKSPACE_BINDING_REQUIRED",
			);
		const frozen = structuredClone(resolved);
		// Legacy selection pins still name the selected projection, never another device's cwd.
		const selected =
			!explicit || opts.expectedRevision !== undefined || opts.contextKey !== undefined
				? await workspaceContextService.get(narratorId, actor)
				: undefined;
		if (
			selected &&
			((!explicit && selected.deviceId !== deviceId) ||
				(opts.contextKey !== undefined && opts.contextKey !== selected.contextKey) ||
				(opts.expectedRevision !== undefined && opts.expectedRevision !== selected.revision))
		)
			throw new AppError(
				"Workspace changed before terminal creation",
				409,
				"WORKSPACE_CONTEXT_STALE",
			);
		if (
			(opts.expectedBindingRevision !== undefined &&
				opts.expectedBindingRevision !== frozen.binding?.bindingRevision) ||
			(opts.bindingId !== undefined && opts.bindingId !== frozen.binding?.bindingId)
		)
			throw new AppError("Terminal workspace binding changed", 409, "WORKSPACE_CONTEXT_STALE");
		const backend = resolveBackend({ requested: deviceId });
		const proof = await config.assertEndpointAuthorized?.({
			deviceId,
			backendKind: backend.kind,
			cwd: frozen.cwd,
			baseCwd: frozen.cwd,
			pathFlavor: backend.paths.flavor,
			runtimeGeneration: backend.runtimeGeneration,
			selectionSource: explicit ? "explicit" : "session_default",
			workspaceContext: frozen,
		});
		if (!proof || !config.assertDeviceWorkspaceCurrent || !config.assertDeviceWorkspaceCurrentSync)
			throw new AppError(
				"Terminal endpoint authority is unavailable",
				403,
				"TERMINAL_AUTHORITY_DENIED",
			);
		const guard = {
			async assertCurrent() {
				signal.throwIfAborted();
				await config.assertDeviceWorkspaceCurrent?.(frozen);
			},
			assertStillCurrent() {
				signal.throwIfAborted();
				assertWorkspaceSelectionInstalled(narratorId);
				config.assertDeviceWorkspaceCurrentSync?.(frozen);
				proof.assertStillCurrent();
				const live = resolveBackend({ requested: deviceId });
				if (
					live.kind !== backend.kind ||
					live.runtimeGeneration !== backend.runtimeGeneration ||
					live.paths.flavor !== backend.paths.flavor
				)
					throw new AppError("Terminal backend changed", 409, "WORKSPACE_CONTEXT_STALE");
			},
		};
		guard.assertStillCurrent();
		const admitted = { ...opts, principal, signal, deviceId };
		// Only default/legacy-pinned calls are serialized with selection. Explicit inactive
		// pair bindings do not mutate or borrow the current selection.
		return selected
			? workspaceContextService.withRevision(
					narratorId,
					selected.revision,
					undefined,
					() => this.createAdmitted(admitted, frozen, guard),
					actor,
				)
			: this.createAdmitted(admitted, frozen, guard);
	},

	/** Internal admission body; existing terminals always use their persisted device/cwd. */
	async createAdmitted(
		opts: CreateTerminalOptions,
		frozenWorkspace?: WorkspaceContext,
		guard?: { assertCurrent(): Promise<void>; assertStillCurrent(): void },
	) {
		assertLegacyRuntimeOwner(opts);
		const cols = opts.cols ?? 80;
		const rows = opts.rows ?? 24;
		let cwd: string;
		let projectId: string | null = null;
		const chapterId: string | undefined = opts.chapterId;
		const narratorId: string | undefined = opts.narratorId;
		const requestedDeviceId = opts.deviceId?.trim();
		const hasExplicitDevice = requestedDeviceId !== undefined && requestedDeviceId !== "";
		let deviceId: string | undefined =
			hasExplicitDevice && requestedDeviceId !== "local" ? requestedDeviceId : undefined;

		if (chapterId && narratorId) {
			throw new ValidationError("Only one of chapterId or narratorId may be provided");
		}

		if (chapterId) {
			const chapter = await db.query.chapters.findFirst({
				where: eq(chapters.id, chapterId),
			});
			if (!chapter) throw new NotFoundError("Chapter", chapterId);
			if (!chapter.worktreePath) {
				throw new ValidationError("Chapter has no worktree (dormant?)");
			}
			projectId = chapter.projectId;
			cwd = chapter.worktreePath;
		} else if (narratorId) {
			if (!frozenWorkspace || !guard)
				throw new AppError(
					"Terminal device workspace is not configured",
					409,
					"WORKSPACE_BINDING_REQUIRED",
				);
			cwd = frozenWorkspace.cwd;
			const source = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { chapterId: true, contextProjectId: true },
			});
			if (!source) throw new NotFoundError("Narrator", narratorId);
			const chapter = source.chapterId
				? await db.query.chapters.findFirst({
						where: eq(chapters.id, source.chapterId),
						columns: { projectId: true },
					})
				: undefined;
			projectId = chapter?.projectId ?? source.contextProjectId ?? null;
			if (
				frozenWorkspace.contextProjectId !== undefined &&
				frozenWorkspace.contextProjectId !== projectId
			)
				throw new AppError(
					"Terminal original project binding changed",
					409,
					"WORKSPACE_CONTEXT_STALE",
				);
		} else {
			// Standalone terminals are used by global flows such as setup wizard dependency installs.
			cwd = getHome();
		}

		// Narrator-linked creation uses this device's own server-read binding only.
		const requested = hasExplicitDevice
			? (requestedDeviceId ?? "local")
			: (frozenWorkspace?.deviceId ?? deviceId ?? "local");
		if (frozenWorkspace) {
			deviceId = requested === "local" ? undefined : requested;
			if (requested !== frozenWorkspace.deviceId)
				throw new AppError("Terminal binding device mismatch", 409, "WORKSPACE_CONTEXT_STALE");
			cwd = frozenWorkspace.cwd;
		}
		let remoteShell: string | null = null;
		let remoteWindows = false;
		let remoteRequiredFeatures = [REMOTE_PTY_READY_FEATURE];
		if (deviceId) {
			if (!opts.principal)
				throw new AppError(
					"Remote terminal creation requires an authenticated actor",
					403,
					"TERMINAL_ACTOR_REQUIRED",
				);
			const device = await terminalDeviceAuthority(deviceId, projectId, opts.principal, "write");
			if (!isDeviceOnline(deviceId)) {
				throw new DeviceScopeError(
					`Selected remote device "${deviceId}" is offline`,
					"DEVICE_OFFLINE",
				);
			}
			const hello = getConnectedDeviceHello(deviceId);
			const capabilities = hello?.capabilities ?? device.capabilities;
			if (capabilities?.pty !== true) {
				throw new DeviceScopeError(
					`Remote device "${deviceId}" does not support interactive PTY terminals`,
					"DEVICE_PTY_UNAVAILABLE",
				);
			}
			const platformOs = hello?.platform.os ?? device.platformOs;
			remoteWindows = platformOs === "windows";
			if (remoteWindows) {
				remoteRequiredFeatures = [
					REMOTE_PTY_READY_FEATURE,
					REMOTE_PTY_CONPTY_FEATURE,
					REMOTE_PTY_LIFECYCLE_FEATURE,
					REMOTE_PTY_BOUNDED_IO_FEATURE,
					"fs.path.resolve.v2",
				];
			}
			if (remoteRequiredFeatures.some((feature) => !deviceHasFeature(capabilities, feature))) {
				throw new DeviceScopeError(
					`Remote device "${deviceId}" requires an executor upgrade for interactive terminals (${REMOTE_PTY_READY_FEATURE})`,
					"DEVICE_EXECUTOR_UPGRADE_REQUIRED",
				);
			}
			// Global setup terminals are not narrator workspace consumers.
			if (!narratorId && !frozenWorkspace) cwd = hello?.defaultCwd || device.defaultCwd || "";
			remoteShell =
				hello?.platform.shellPath ||
				device.shellPath ||
				(remoteWindows ? "powershell.exe" : "/bin/sh");
		}

		const backend = resolveBackend({ requested: deviceId ?? "local" });
		if (!cwd || !backend.paths.isAbsolute(cwd))
			throw new ValidationError("Terminal target has no absolute working directory");
		const boundNativeRoot =
			remoteWindows && frozenWorkspace?.deviceId === requested
				? frozenWorkspace.nativeRootDescriptor
				: undefined;
		if (remoteWindows && frozenWorkspace?.deviceId === requested && !boundNativeRoot) {
			throw new DeviceScopeError(
				"Bound Windows workspace lacks its original native directory proof",
				"DEVICE_EXECUTOR_UPGRADE_REQUIRED",
			);
		}
		await guard?.assertCurrent();
		guard?.assertStillCurrent();
		const identity = await backend.resolvePathIdentity(cwd, {
			timeoutMs: 10_000,
			signal: opts.signal,
			...(boundNativeRoot ? { expectedNativeDescriptor: boundNativeRoot } : {}),
		});
		if (!identity.exists)
			throw new AppError(
				"Terminal target directory is unavailable",
				409,
				"WORKSPACE_DIRECTORY_UNAVAILABLE",
			);
		if (
			identity.runtimeGeneration !== backend.runtimeGeneration ||
			(frozenWorkspace?.deviceId === requested &&
				!backend.paths.equals(identity.canonicalPath, cwd))
		)
			throw new AppError("Terminal workspace identity changed", 409, "WORKSPACE_CONTEXT_STALE");
		if (
			boundNativeRoot &&
			(!identity.nativeDescriptor || !nativePathEquals(boundNativeRoot, identity.nativeDescriptor))
		) {
			throw new AppError(
				"Original terminal directory incarnation changed",
				409,
				"WORKSPACE_CONTEXT_STALE",
			);
		}
		if (remoteWindows && !identity.nativeDescriptor) {
			throw new DeviceScopeError(
				"Native Windows terminal requires an original directory identity",
				"DEVICE_EXECUTOR_UPGRADE_REQUIRED",
			);
		}
		// The admitted pair must retain its original canonical root.
		cwd = identity.canonicalPath;
		let spawnAuthority: Awaited<ReturnType<typeof terminalRuntimeAuthority>> | undefined;
		if (narratorId) {
			const authority = await terminalRuntimeAuthority(
				narratorId,
				backend,
				"write",
				opts.principal?.userId ?? "",
			);
			spawnAuthority = authority;
			const policy = await executionPolicyEngine.compile(
				narratorId,
				{
					backend,
					paths: backend.paths,
					deviceClass: authority.deviceClass,
					target: {
						deviceId: backend.deviceId,
						backendKind: backend.kind,
						cwd,
						lexicalPath: cwd,
						canonicalPath: cwd,
						...(identity.nativeDescriptor
							? { nativeDescriptor: boundNativeRoot ?? identity.nativeDescriptor }
							: {}),
						pathFlavor: backend.paths.flavor,
						runtimeGeneration: backend.runtimeGeneration,
						selectionSource: "session_default",
					},
				},
				authority.oauth?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
			);
			if (
				["read", "write"].some(
					(operation) =>
						policy.evaluatePath({ path: cwd, operation: operation as "read" | "write" })
							.decision === "deny",
				)
			)
				throw new AppError("Terminal working directory access denied", 403, "TERMINAL_PATH_DENIED");
			assertTerminalAuthorityStable(
				authority,
				await terminalRuntimeAuthority(narratorId, backend, "write", opts.principal?.userId ?? ""),
			);
		}
		const terminalWorkspace:
			| (WorkspaceContext & {
					terminalOrigin?: {
						version: 1;
						runtimeGeneration: number | undefined;
						projectId: string | null;
					};
			  })
			| undefined =
			!frozenWorkspace && backend.kind === "remote"
				? {
						revision: 0,
						contextKey: createHash("sha256")
							.update(
								JSON.stringify([
									backend.deviceId,
									identity.nativeDescriptor?.pathSlotKey ?? backend.paths.identityKey(cwd),
									backend.runtimeGeneration,
									opts.principal?.userId,
									projectId,
								]),
							)
							.digest("hex"),
						deviceId: backend.deviceId,
						cwd,
						pathFlavor: backend.paths.flavor === "windows" ? "windows" : "posix",
						...(identity.nativeDescriptor
							? { nativeRootDescriptor: structuredClone(identity.nativeDescriptor) }
							: {}),
						...(projectId ? { contextProjectId: projectId } : {}),
						capabilities: { switchDirectory: false },
						terminalOrigin: {
							version: 1 as const,
							runtimeGeneration: backend.runtimeGeneration,
							projectId,
						},
					}
				: frozenWorkspace
					? {
							...frozenWorkspace,
							terminalOrigin: {
								version: 1,
								runtimeGeneration: backend.runtimeGeneration,
								projectId,
							},
						}
					: undefined;
		// Path resolution/compilation can yield; refresh the device ceiling before a row or writer claim.
		if (deviceId && opts.principal)
			await terminalDeviceAuthority(deviceId, projectId, opts.principal, "write");
		if (opts.principal)
			opts = { ...opts, principal: await terminalCreationAuthority(opts, projectId) };
		await guard?.assertCurrent();
		guard?.assertStillCurrent();
		// All remote authorization/capability checks above must finish before any terminal side effect.
		const id = generateId();
		const now = new Date().toISOString();
		// Standalone origins have no narrator FK. Persist their server-admitted
		// metadata before native spawn; exited/null is a pending, unproven process,
		// never a successful exit or a fabricated `creating` schema state.
		const [pendingOrigin] =
			backend.kind === "remote" && !narratorId
				? await db
						.insert(terminals)
						.values({
							id,
							chapterId: chapterId ?? null,
							narratorId: null,
							name: opts.name ?? "Terminal",
							cwd,
							deviceId: deviceId ?? null,
							ownerUserId: opts.principal?.userId ?? null,
							workspaceContext: terminalWorkspace ?? null,
							workspaceRevision: terminalWorkspace?.revision ?? null,
							status: "exited",
							exitCode: null,
							createdAt: now,
						})
						.returning()
				: [];
		const buffer = new BufferManager(id);
		// Remote terminals run on a device PTY; dtach (local detach) does not apply.
		const useRemote = !!deviceId;
		const activityId = `pty:${id}`;
		const activityTarget: ToolExecutionTarget | null = useRemote
			? {
					deviceId: backend.deviceId,
					backendKind: "remote",
					cwd,
					baseCwd: cwd,
					lexicalPath: cwd,
					canonicalPath: cwd,
					...(identity.nativeDescriptor
						? { nativeDescriptor: structuredClone(boundNativeRoot ?? identity.nativeDescriptor) }
						: {}),
					pathFlavor: backend.paths.flavor,
					runtimeGeneration: backend.runtimeGeneration,
					selectionSource: "session_default",
				}
			: null;
		if (activityTarget && opts.principal) {
			try {
				if (!narratorId) {
					if (
						!pendingOrigin ||
						!terminalWorkspace ||
						typeof backend.runtimeGeneration !== "number" ||
						!Number.isInteger(backend.runtimeGeneration)
					)
						throw new AppError(
							"Standalone terminal origin is unavailable",
							409,
							"TERMINAL_ORIGIN_UNAVAILABLE",
						);
					await registerRemoteTerminalActivity({
						principal: { ...opts.principal },
						terminalId: id,
						workspaceContext: structuredClone(terminalWorkspace),
						runtimeGeneration: backend.runtimeGeneration,
						target: activityTarget,
						activityId,
					});
				} else
					await registerRemoteActivity({
						narratorId,
						userId: opts.principal.userId,
						projectId,
						actorKind: "human",
						workspaceContext: terminalWorkspace ?? undefined,
						target: activityTarget,
						activityId,
						kind: "pty",
					});
			} catch (error) {
				await buffer.dispose();
				throw error;
			}
		}
		buffer.startPeriodicFlush();
		const useDtach = !useRemote && (await dtachService.isAvailable());

		let runtime: TerminalRuntime;
		let dtachSocket: string | null = null;
		let releasePreparationCancellation: (() => void) | undefined;

		if (!useRemote && opts.principal) {
			try {
				opts = { ...opts, principal: await terminalCreationAuthority(opts, projectId) };
			} catch (error) {
				await buffer.dispose();
				throw error;
			}
		}
		if (useRemote && deviceId && remoteShell) {
			const { sendRpc } = await import("./device-connection-service");
			let dispatched = false;
			try {
				// Admission may await durable history; do not dispatch under an earlier device policy.
				if (narratorId && spawnAuthority)
					assertTerminalAuthorityStable(
						spawnAuthority,
						await terminalRuntimeAuthority(
							narratorId,
							backend,
							"write",
							opts.principal?.userId ?? "",
						),
					);
				if (opts.principal) {
					await terminalDeviceAuthority(deviceId, projectId, opts.principal, "write");
					// ACL/role changes are not serialized by the workspace revision lock.
					opts = { ...opts, principal: await terminalCreationAuthority(opts, projectId) };
				}
				await guard?.assertCurrent();
				guard?.assertStillCurrent();
				opts.signal?.throwIfAborted();
				// pty.open is a lifetime stream, not a finite prepare RPC. Forward caller/10s
				// cancellation only until ready, then retain the runtime's own lifecycle signal.
				const preparation = new AbortController();
				const preparationSignal = opts.signal;
				const cancelPreparation = () => preparation.abort(preparationSignal?.reason);
				preparationSignal?.addEventListener("abort", cancelPreparation, { once: true });
				releasePreparationCancellation = () =>
					preparationSignal?.removeEventListener("abort", cancelPreparation);
				runtime = spawnRemotePty(
					deviceId,
					{
						// Native Windows selects interactive PowerShell in the executor;
						// never send Unix login arguments or a Unix history path.
						cmd: remoteWindows ? [] : [remoteShell, "-l"],
						cwd,
						env: remoteWindows
							? { TERM: "xterm-256color" }
							: { HISTFILE: "/dev/null", TERM: "xterm-256color" },
						cols,
						rows,
						onData: (data) => onData(id, buffer, data),
					},
					{
						requireLifecycleEvidence: remoteWindows,
						requireInputAuthorityProof: !!narratorId,
						expectedNativeDescriptor: remoteWindows
							? structuredClone(boundNativeRoot ?? identity.nativeDescriptor)
							: undefined,
						onFailure: (error) =>
							sendToTerminal(id, {
								type: "error",
								terminalId: id,
								message: error.message.slice(0, 1024),
								code: "REMOTE_PTY_IO_FAILED",
							}),
						beforeInput: async () => {
							if (!opts.principal)
								throw new AppError("Terminal input actor missing", 403, "TERMINAL_ACTOR_REQUIRED");
							const principal = await terminalCreationAuthority(opts, projectId);
							return this.authorizeTargetAccess(id, principal, "write");
						},
						sendRpc: (device, method, params, options) => {
							if (method === "pty.open") {
								guard?.assertStillCurrent();
								dispatched = true;
							}
							return sendRpc(device, method, params, {
								...options,
								...(method === "pty.open" && opts.signal
									? {
											signal: options?.signal
												? AbortSignal.any([preparation.signal, options.signal])
												: preparation.signal,
										}
									: {}),
								expectedConnectionGeneration: backend.runtimeGeneration,
								requiredFeatures: remoteRequiredFeatures,
							});
						},
					},
				);
			} catch (error) {
				releasePreparationCancellation?.();
				if (activityTarget)
					await finishRemoteActivity({
						target: activityTarget,
						activityId,
						outcome: dispatched ? "unknown" : "finished",
					}).catch((settlementError) =>
						logger.warn("Remote PTY spawn settlement failed", {
							terminalId: id,
							error: String(settlementError),
						}),
					);
				await buffer.dispose();
				throw error;
			}
		} else if (useDtach) {
			// No await may intervene between the final proof and local writer start.
			await guard?.assertCurrent();
			guard?.assertStillCurrent();
			await dtachService.createSession({ terminalId: id, cwd });
			dtachSocket = dtachService.getSocketPath(id);
			runtime = dtachService.attachSession({
				terminalId: id,
				cols,
				rows,
				onData: (text) => onData(id, buffer, text),
			});
		} else {
			// Direct mode: platform-appropriate PTY. On some Linux-like runtimes
			// (notably Android/proot), Bun.Terminal may be present but fail at spawn
			// time, so keep the portable PTY as a Unix fallback too.
			const spawnOpts: TerminalSpawnOptions = {
				cmd: [DEFAULT_SHELL, "-l"],
				cwd,
				// User-facing shell: restore the ambient proxy variables NarraFork
				// blanks for its own fetch, so the user's tools behave as they do
				// outside NarraFork.
				env: envWithAmbientProxy({
					HISTFILE: DEV_NULL,
					TERM: "xterm-256color",
				}),
				cols,
				rows,
				onData: (data) => onData(id, buffer, data),
			};
			await guard?.assertCurrent();
			guard?.assertStillCurrent();
			if (IS_WINDOWS) {
				runtime = spawnPortablePty(spawnOpts);
			} else {
				try {
					runtime = spawnBunTerminal(spawnOpts);
				} catch (err) {
					logger.warn("Bun.Terminal failed, falling back to portable PTY", {
						error: String(err),
					});
					runtime = spawnPortablePty(spawnOpts);
				}
			}
		}

		// Listen before readiness: a short-lived process can exit before ready is observed.
		// Transport closure/kill acknowledgements are not process-exit evidence.
		if (activityTarget) {
			void runtime.exited
				.then((code) =>
					finishRemoteActivity({
						target: activityTarget,
						activityId,
						outcome: typeof code === "number" && Number.isInteger(code) ? "finished" : "unknown",
					}),
				)
				.catch((error) =>
					logger.warn("Remote PTY lifetime settlement failed", {
						terminalId: id,
						error: String(error),
					}),
				);
		}
		if (runtime.ready) {
			try {
				await runtime.ready;
			} catch (error) {
				runtime.kill();
				await buffer.dispose();
				throw new ValidationError(
					`Remote terminal failed to start: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				releasePreparationCancellation?.();
			}
		} else releasePreparationCancellation?.();
		if (activityTarget) {
			try {
				markRemoteActivityRunning({ target: activityTarget, activityId });
			} catch (error) {
				logger.warn("PTY running ledger update failed; prepared barrier retained", {
					terminalId: id,
					error: String(error),
				});
			}
		}

		activeTerminals.set(id, { runtime, terminalId: id, buffer, useDtach });

		const [terminal] = pendingOrigin
			? await db
					.update(terminals)
					.set({ status: "running" })
					.where(eq(terminals.id, id))
					.returning()
			: await db
					.insert(terminals)
					.values({
						id,
						chapterId: chapterId ?? null,
						narratorId: narratorId ?? null,
						name: opts.name ?? "Terminal",
						cwd,
						dtachSocket,
						deviceId: deviceId ?? null,
						ownerUserId: opts.principal?.userId ?? null,
						workspaceContext: terminalWorkspace ?? null,
						workspaceRevision: terminalWorkspace?.revision ?? null,
						status: "running",
						createdAt: now,
					})
					.returning();

		// Persist before installing this observer: an already-settled exit must not
		// race an UPDATE against a row that has not been inserted yet.
		if (useDtach) {
			monitorAttachProcess(id, runtime, narratorId ?? null, chapterId ?? null);
		} else {
			void runtime.exited
				.then(async (code) => {
					const active = activeTerminals.get(id);
					if (!active) return;
					await active.buffer.dispose();
					activeTerminals.delete(id);
					runtime.close();
					await markTerminalExited(id, code ?? null, narratorId ?? null, chapterId ?? null);
					broadcastExit(id, code);
					logger.info("Terminal exited", { terminalId: id, code });
				})
				.catch((error) =>
					logger.warn("Terminal exit persistence failed", { terminalId: id, error: String(error) }),
				);
		}
		logger.info("Terminal created", { id, chapterId, narratorId, useDtach });
		eventBus.emit({
			type: "terminal:created",
			terminalId: id,
			narratorId: narratorId ?? null,
			chapterId: chapterId ?? null,
		});
		return { ...terminal, lifecycle: lifecycleFor(terminal) };
	},

	/** Authorize the terminal's ORIGINAL endpoint, never the narrator's current workspace. */
	async authorizeTargetAccess(
		terminalId: string,
		principal: NarratorPrincipal,
		need: "read" | "write",
	) {
		const terminal = await this.getById(terminalId);
		let projectId = terminal.workspaceContext?.contextProjectId ?? null;
		let originalProof: { assertStillCurrent(): void } | undefined;
		if (terminal.narratorId) {
			const original = terminal.workspaceContext;
			if (
				!original ||
				original.deviceId !== (terminal.deviceId ?? "local") ||
				original.cwd !== terminal.cwd
			)
				throw new AppError(
					"Terminal original workspace is unavailable",
					409,
					"TERMINAL_ORIGIN_UNAVAILABLE",
				);
			const origin = (
				original as WorkspaceContext & {
					terminalOrigin?: {
						version?: number;
						projectId?: string | null;
						runtimeGeneration?: number;
					};
				}
			).terminalOrigin;
			const originalProjectId =
				original.contextProjectId ?? (origin?.version === 1 ? origin.projectId : undefined);
			if (originalProjectId === undefined)
				throw new AppError(
					"Terminal original project source is unavailable",
					409,
					"TERMINAL_ORIGIN_UNAVAILABLE",
				);
			projectId = originalProjectId;
			const backend = resolveBackend({ requested: original.deviceId });
			await terminalRuntimeAuthority(terminal.narratorId, backend, need, principal.userId);
			if (
				origin?.runtimeGeneration !== undefined &&
				origin.runtimeGeneration !== backend.runtimeGeneration
			)
				throw new AppError("Terminal original backend changed", 409, "TERMINAL_ORIGIN_UNAVAILABLE");
			const { assertNarratorOriginalWorkspaceAuthority } = await import(
				"./workspace-artifact-access"
			);
			originalProof = await assertNarratorOriginalWorkspaceAuthority(
				terminal.narratorId,
				original,
				{ userId: principal.userId, need, originalProjectId },
			);
			// Native metadata must follow actor/narrator/original-project admission.
			if (backend.paths.flavor === "windows") {
				if (!original.nativeRootDescriptor)
					throw new AppError(
						"Terminal original native root is unavailable",
						409,
						"TERMINAL_ORIGIN_UNAVAILABLE",
					);
				const identity = await backend.resolvePathIdentity(original.cwd, {
					timeoutMs: 5_000,
					expectedNativeDescriptor: original.nativeRootDescriptor,
				});
				if (
					!identity.exists ||
					!identity.nativeDescriptor ||
					!nativePathEquals(original.nativeRootDescriptor, identity.nativeDescriptor) ||
					identity.runtimeGeneration !== backend.runtimeGeneration ||
					!backend.paths.equals(identity.canonicalPath, original.cwd)
				)
					throw new AppError(
						"Terminal original native root changed",
						409,
						"TERMINAL_ORIGIN_UNAVAILABLE",
					);
			}
		} else if (terminal.chapterId) {
			const { assertChapterProjectAccess } = await import("./project-acl");
			await assertChapterProjectAccess(terminal.chapterId, principal, need);
			const chapter = await db.query.chapters.findFirst({
				where: eq(chapters.id, terminal.chapterId),
				columns: { projectId: true },
			});
			projectId ??= chapter?.projectId ?? null;
		} else if (!principal.isAdmin && terminal.ownerUserId !== principal.userId) {
			throw new AppError("Standalone terminal access denied", 403, "TERMINAL_ACCESS_DENIED");
		}
		if (terminal.deviceId && terminal.deviceId !== "local")
			await terminalDeviceAuthority(terminal.deviceId, projectId, principal, need);
		if (terminal.narratorId && terminal.cwd) {
			const backend = resolveBackend({ requested: terminal.deviceId ?? "local" });
			const authority = await terminalRuntimeAuthority(
				terminal.narratorId,
				backend,
				need,
				principal.userId,
			);
			const policy = await executionPolicyEngine.compile(
				terminal.narratorId,
				{
					backend,
					paths: backend.paths,
					deviceClass: authority.deviceClass,
					target: {
						deviceId: backend.deviceId,
						backendKind: backend.kind,
						cwd: terminal.cwd,
						lexicalPath: terminal.cwd,
						canonicalPath: terminal.cwd,
						...(terminal.workspaceContext?.nativeRootDescriptor
							? { nativeDescriptor: terminal.workspaceContext.nativeRootDescriptor }
							: {}),
						pathFlavor: backend.paths.flavor,
						runtimeGeneration: backend.runtimeGeneration,
						selectionSource: "explicit",
					},
				},
				authority.oauth?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
			);
			if (policy.evaluatePath({ path: terminal.cwd, operation: need }).decision === "deny")
				throw new AppError(
					"Terminal original working directory access denied",
					403,
					"TERMINAL_PATH_DENIED",
				);
			assertTerminalAuthorityStable(
				authority,
				await terminalRuntimeAuthority(terminal.narratorId, backend, need, principal.userId),
			);
			if (terminal.deviceId && terminal.deviceId !== "local")
				await terminalDeviceAuthority(terminal.deviceId, projectId, principal, need);
		}
		originalProof?.assertStillCurrent();
		// Request-bound final proof is deliberately non-enumerable: never part of the HTTP DTO.
		return Object.defineProperty(terminal, "assertStillCurrent", {
			value: () => originalProof?.assertStillCurrent(),
		}) as typeof terminal & { assertStillCurrent(): void };
	},

	writeAuthorized(
		terminalId: string,
		data: string,
		authority: () => Promise<unknown>,
		beforeDispatch?: () => void,
	) {
		const active = activeTerminals.get(terminalId);
		if (!active || active.closing) return;
		beforeDispatch?.();
		if ("writeAuthorized" in active.runtime) {
			(active.runtime as RemoteTerminalRuntime).writeAuthorized(data, authority);
		} else {
			active.runtime.write(data);
		}
	},

	resizeAuthorized(
		terminalId: string,
		cols: number,
		rows: number,
		authority: () => Promise<unknown>,
		beforeDispatch?: () => void,
	) {
		const active = activeTerminals.get(terminalId);
		if (!active || active.closing) return;
		beforeDispatch?.();
		if ("resizeAuthorized" in active.runtime) {
			(active.runtime as RemoteTerminalRuntime).resizeAuthorized(cols, rows, authority);
			void active.buffer.resize(cols, rows);
		} else {
			this.resize(terminalId, cols, rows);
		}
	},

	write(terminalId: string, data: string) {
		const active = activeTerminals.get(terminalId);
		if (!active) {
			logger.warn("Terminal write: no active terminal", { terminalId });
			return;
		}
		active.runtime.write(data);
	},

	resize(terminalId: string, cols: number, rows: number) {
		const active = activeTerminals.get(terminalId);
		if (!active) return;
		active.runtime.resize(cols, rows);
		// Bun.Terminal.resize() does not send SIGWINCH to the child.
		// dtach relies on SIGWINCH to forward the new size. Only on Unix.
		if (active.useDtach && !IS_WINDOWS && active.runtime.pid) {
			try {
				process.kill(active.runtime.pid, "SIGWINCH");
			} catch {
				// process may have exited
			}
		}
		// Buffer resize is async (waits for pending writes) — fire and forget
		active.buffer.resize(cols, rows);
	},

	async kill(terminalId: string, beforeDispatch?: () => void) {
		const terminal = await this.getById(terminalId);
		beforeDispatch?.();
		const active = activeTerminals.get(terminalId);
		if (active) {
			if (active.closing) return;
			active.closing = true;
			sendToTerminal(terminalId, { type: "lifecycle", terminalId, state: "closing", code: null });
			let dispatched = false;
			try {
				if (active.useDtach)
					await dtachService.killSession(terminalId, beforeDispatch, () => {
						dispatched = true;
					});
				beforeDispatch?.();
				// Retain the original runtime and observer until REAL exit/unknown.
				// Once effects were dispatched (or their outcome is unknown), never reopen input.
				dispatched = true;
				active.runtime.kill();
			} catch (error) {
				if (!dispatched && activeTerminals.get(terminalId) === active) {
					active.closing = false;
					sendToTerminal(terminalId, {
						type: "lifecycle",
						terminalId,
						state: "ready",
						code: null,
					});
				}
				throw error;
			}
			logger.info("Terminal close requested", { terminalId });
			return;
		}
		if (terminal.deviceId && terminal.deviceId !== "local") {
			if (terminal.status === "exited" && terminal.exitCode !== null) return;
			throw new AppError(
				"Original remote terminal process cannot be confirmed",
				409,
				"TERMINAL_PROCESS_UNCONFIRMED",
			);
		}
		if (await dtachService.isAvailable()) {
			beforeDispatch?.();
			const socketAlive = await dtachService.isSocketAlive(terminalId);
			beforeDispatch?.();
			if (socketAlive) await dtachService.killSession(terminalId, beforeDispatch);
			beforeDispatch?.();
			const buf = new BufferManager(terminalId);
			await buf.deleteFromDisk();
		}
		beforeDispatch?.();
		// Detached cleanup has no original process wait handle: keep that honest.
		await markTerminalExited(terminalId, null, terminal.narratorId, terminal.chapterId);
		broadcastExit(terminalId, null);
	},

	/** A bounded wait on the ORIGINAL runtime; null never authorizes deleting unknown provenance. */
	async waitForExit(terminalId: string): Promise<number | null> {
		const active = activeTerminals.get(terminalId);
		if (!active) return (await this.getById(terminalId)).exitCode;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				active.runtime.exited,
				new Promise<null>((resolve) => {
					timer = setTimeout(() => resolve(null), 10_000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	},

	async rename(terminalId: string, name: string, beforeDispatch?: () => void) {
		const terminal = await db.query.terminals.findFirst({
			where: eq(terminals.id, terminalId),
		});
		if (!terminal) throw new NotFoundError("Terminal", terminalId);
		assertLegacyRuntimeOwner(terminal);
		beforeDispatch?.();
		await db.update(terminals).set({ name }).where(eq(terminals.id, terminalId));
	},

	async getById(id: string) {
		const terminal = await db.query.terminals.findFirst({
			where: eq(terminals.id, id),
		});
		if (!terminal) throw new NotFoundError("Terminal", id);
		assertLegacyRuntimeOwner(terminal);
		return { ...terminal, lifecycle: lifecycleFor(terminal) };
	},

	async listByChapter(chapterId: string) {
		const rows = await db.query.terminals.findMany({
			where: and(eq(terminals.chapterId, chapterId), isNull(terminals.worktreeResourceId)),
			columns: TERMINAL_METADATA_COLUMNS,
			limit: TERMINAL_METADATA_LIST_LIMIT,
			orderBy: (table, { desc }) => [desc(table.createdAt), desc(table.id)],
		});
		return rows.map((terminal) => ({ ...terminal, lifecycle: lifecycleFor(terminal) }));
	},

	async listByNarrator(narratorId: string) {
		const rows = await db.query.terminals.findMany({
			where: and(eq(terminals.narratorId, narratorId), isNull(terminals.worktreeResourceId)),
			columns: TERMINAL_METADATA_COLUMNS,
			limit: TERMINAL_METADATA_LIST_LIMIT,
			orderBy: (table, { desc }) => [desc(table.createdAt), desc(table.id)],
		});
		return rows.map((terminal) => ({ ...terminal, lifecycle: lifecycleFor(terminal) }));
	},

	/** List all terminals (admin use) */
	async listAll() {
		return db.query.terminals.findMany({
			where: isNull(terminals.worktreeResourceId),
			orderBy: (t, { desc }) => [desc(t.createdAt)],
		});
	},

	/** Find orphan dtach sockets — sockets on disk with no matching running terminal in DB */
	async listOrphanSockets(
		snapshot?: ProcessSnapshot,
	): Promise<{ socketPath: string; terminalId: string }[]> {
		if (!(await dtachService.isAvailable())) return [];
		const orphans: { socketPath: string; terminalId: string }[] = [];
		try {
			const files = await readdir(dtachService.socketsDir);
			for (const file of files) {
				const match = file.match(/^terminal-(.+)\.sock$/);
				if (!match) continue;
				const terminalId = match[1];
				const tracked = await db.query.terminals.findFirst({
					where: eq(terminals.id, terminalId),
					columns: { worktreeResourceId: true },
				});
				if (tracked?.worktreeResourceId != null) continue;
				const socketPath = dtachService.getSocketPath(terminalId);
				// Check if the socket is alive but terminal is not in activeTerminals
				const alive = snapshot
					? snapshot.findByArg(socketPath).length > 0
					: await dtachService.isSocketAlive(terminalId);
				if (alive && !activeTerminals.has(terminalId)) {
					orphans.push({ socketPath, terminalId });
				}
			}
		} catch {
			// sockets dir may not exist
		}
		return orphans;
	},

	/** Kill an orphan dtach socket that has no DB record */
	async killOrphanSocket(terminalId: string) {
		const existing = await db.query.terminals.findFirst({ where: eq(terminals.id, terminalId) });
		if (existing) assertLegacyRuntimeOwner(existing);
		await dtachService.killSession(terminalId);
		// Clean up buffer file if any
		const buf = new BufferManager(terminalId);
		await buf.deleteFromDisk();
	},

	/** Check if a terminal is currently attached (has an active PTY connection) */
	isAttached(terminalId: string): boolean {
		return activeTerminals.has(terminalId);
	},

	/**
	 * Ensure a dtach terminal is attached. If it's a running dtach terminal
	 * that's not in activeTerminals (e.g. after server restart or detach),
	 * automatically re-attach so new output flows through WebSocket.
	 * No-op for non-dtach terminals or already-attached terminals.
	 */
	async ensureAttached(terminalId: string, beforeDispatch?: () => void): Promise<void> {
		if (activeTerminals.has(terminalId)) return;
		if (!(await dtachService.isAvailable())) return;

		const terminal = await db.query.terminals.findFirst({
			where: eq(terminals.id, terminalId),
			columns: {
				id: true,
				status: true,
				dtachSocket: true,
				worktreeResourceId: true,
				deviceId: true,
			},
		});
		if (!terminal || terminal.status !== "running" || !terminal.dtachSocket) return;
		if (terminal.deviceId && terminal.deviceId !== "local") return;
		if (terminal.worktreeResourceId != null) return;

		await this.reattach(terminalId, beforeDispatch);
	},

	/** Get attached status for multiple terminals at once */
	getAttachedSet(): Set<string> {
		return new Set(activeTerminals.keys());
	},

	/**
	 * Re-attach to a dtach terminal that exists in DB but is not in activeTerminals.
	 * Returns true if successfully re-attached.
	 */
	async reattach(terminalId: string, beforeDispatch?: () => void): Promise<boolean> {
		const terminal = await db.query.terminals.findFirst({
			where: eq(terminals.id, terminalId),
		});
		if (!terminal) return false;
		assertLegacyRuntimeOwner(terminal);
		if (terminal.deviceId && terminal.deviceId !== "local") return false;
		if (activeTerminals.has(terminalId)) return true; // already attached
		if (!(await dtachService.isAvailable())) return false;
		if (!(await dtachService.isSocketAlive(terminalId))) return false;

		const buffer = new BufferManager(terminalId);
		await buffer.loadFromDisk();
		try {
			beforeDispatch?.();
		} catch (error) {
			await buffer.dispose();
			throw error;
		}
		buffer.startPeriodicFlush();

		const runtime = dtachService.attachSession({
			terminalId,
			cols: 80,
			rows: 24,
			onData: (text) => onData(terminalId, buffer, text),
		});

		activeTerminals.set(terminalId, {
			runtime,
			terminalId,
			buffer,
			useDtach: true,
		});

		// Ensure DB status is running
		await db.update(terminals).set({ status: "running" }).where(eq(terminals.id, terminalId));

		// Clear stale read cursors so next read returns full buffer
		resetCursorForTerminal(terminalId);

		monitorAttachProcess(terminalId, runtime);

		logger.info("Terminal re-attached", { terminalId });
		return true;
	},

	/**
	 * Re-attach to an orphan dtach socket (no DB record).
	 * Creates a DB record and attaches. Returns the new terminal record.
	 */
	async reattachOrphan(terminalId: string): Promise<unknown> {
		const existing = await db.query.terminals.findFirst({ where: eq(terminals.id, terminalId) });
		if (existing) assertLegacyRuntimeOwner(existing);
		if (!(await dtachService.isAvailable()) || !(await dtachService.isSocketAlive(terminalId))) {
			throw new AppError("dtach socket not alive", 500);
		}

		const id = terminalId;
		const now = new Date().toISOString();
		const dtachSocket = dtachService.getSocketPath(terminalId);

		if (!existing) {
			// Create DB record for the orphan
			await db.insert(terminals).values({
				id,
				chapterId: null,
				narratorId: null,
				name: `Recovered ${id.slice(0, 8)}`,
				cwd: getHome(),
				dtachSocket,
				status: "running",
				createdAt: now,
			});
		} else {
			await db
				.update(terminals)
				.set({ status: "running", dtachSocket })
				.where(eq(terminals.id, id));
		}

		// Now reattach
		const success = await this.reattach(id);
		if (!success) throw new AppError("Failed to reattach", 500);

		return db.query.terminals.findFirst({ where: eq(terminals.id, id) });
	},

	async getScrollback(
		terminalId: string,
	): Promise<{ data: string; cols: number; rows: number } | null> {
		// Same-ID legacy buffers are not evidence of ownership of a resource terminal.
		await this.getById(terminalId);
		const active = activeTerminals.get(terminalId);
		if (active) {
			const contents = await active.buffer.getContents();
			await this.getById(terminalId);
			if (!contents) return null;
			return { data: contents, cols: active.buffer.cols, rows: active.buffer.rows };
		}
		// Try loading from disk (detached terminal)
		const buf = new BufferManager(terminalId);
		if (await buf.loadFromDisk()) {
			const contents = await buf.getContents();
			await this.getById(terminalId);
			if (!contents) return null;
			return { data: contents, cols: buf.cols, rows: buf.rows };
		}
		return null;
	},

	getBufferState(terminalId: string): { mouseTracking: boolean; cursorVisible: boolean } | null {
		const active = activeTerminals.get(terminalId);
		if (!active) return null;
		return active.buffer.getState();
	},

	/** On startup, recover dtach sessions or mark stale terminals as exited. */
	async recoverOnStartup() {
		if (!(await dtachService.isAvailable())) {
			// No dtach — just mark all running terminals as exited
			const running = await db.query.terminals.findMany({
				where: and(eq(terminals.status, "running"), isNull(terminals.worktreeResourceId)),
			});
			for (const terminal of running) {
				if (terminal.worktreeResourceId != null) continue;
				await markTerminalExited(terminal.id, null, terminal.narratorId, terminal.chapterId);
			}
			if (running.length > 0) {
				logger.info("Marked stale terminals as exited (no dtach)", { count: running.length });
			}
			return;
		}

		// Phase 1: recover DB-tracked running terminals
		const running = await db.query.terminals.findMany({
			where: and(eq(terminals.status, "running"), isNull(terminals.worktreeResourceId)),
		});

		let recovered = 0;
		let marked = 0;

		for (const terminal of running) {
			if (terminal.worktreeResourceId != null) continue;
			if (terminal.dtachSocket && (await dtachService.isSocketAlive(terminal.id))) {
				// Re-attach to the dtach session
				const buffer = new BufferManager(terminal.id);
				await buffer.loadFromDisk();
				buffer.startPeriodicFlush();

				const runtime = dtachService.attachSession({
					terminalId: terminal.id,
					cols: 80,
					rows: 24,
					onData: (text) => onData(terminal.id, buffer, text),
				});

				activeTerminals.set(terminal.id, {
					runtime,
					terminalId: terminal.id,
					buffer,
					useDtach: true,
				});

				// Clear stale read cursors so next read returns full buffer
				resetCursorForTerminal(terminal.id);

				monitorAttachProcess(terminal.id, runtime, terminal.narratorId, terminal.chapterId);

				recovered++;
				continue;
			}

			// Socket dead — mark as exited
			await markTerminalExited(terminal.id, null, terminal.narratorId, terminal.chapterId);
			marked++;
		}

		// Phase 2: recover orphan sockets that have a matching exited DB record.
		// This handles the case where a previous server run incorrectly marked a
		// still-alive dtach terminal as exited (e.g. due to a detection failure).
		// We restore the DB record to running and re-attach.
		let revivedFromExited = 0;
		try {
			const files = await readdir(dtachService.socketsDir);
			for (const file of files) {
				const match = file.match(/^terminal-(.+)\.sock$/);
				if (!match) continue;
				const terminalId = match[1];

				// Skip if already recovered in phase 1
				if (activeTerminals.has(terminalId)) continue;

				// Resource rows are not legacy sockets, even if a stale file has the same ID.
				const existing = await db.query.terminals.findFirst({
					where: eq(terminals.id, terminalId),
				});
				if (existing?.worktreeResourceId != null) continue;
				if (!(await dtachService.isSocketAlive(terminalId))) continue;
				if (existing && existing.status === "exited") {
					// Revive: update status back to running and re-attach
					await db
						.update(terminals)
						.set({
							status: "running",
							dtachSocket: dtachService.getSocketPath(terminalId),
						})
						.where(eq(terminals.id, terminalId));

					const buffer = new BufferManager(terminalId);
					await buffer.loadFromDisk();
					buffer.startPeriodicFlush();

					const runtime = dtachService.attachSession({
						terminalId,
						cols: 80,
						rows: 24,
						onData: (text) => onData(terminalId, buffer, text),
					});

					activeTerminals.set(terminalId, {
						runtime,
						terminalId,
						buffer,
						useDtach: true,
					});

					// Clear stale read cursors so next read returns full buffer
					resetCursorForTerminal(terminalId);

					monitorAttachProcess(terminalId, runtime, existing.narratorId, existing.chapterId);

					revivedFromExited++;
				}
			}
		} catch {
			// sockets dir may not exist
		}

		if (recovered > 0) logger.info("Recovered dtach terminals", { count: recovered });
		if (marked > 0) logger.info("Marked stale terminals as exited", { count: marked });
		if (revivedFromExited > 0) {
			logger.info("Revived exited terminals with live dtach sockets", {
				count: revivedFromExited,
			});
		}
	},

	async cleanupForChapter(chapterId: string) {
		await this._cleanupByField("chapterId", chapterId);
	},

	async cleanupForNarrator(narratorId: string) {
		await this._cleanupByField("narratorId", narratorId);
	},

	async _cleanupByField(field: "chapterId" | "narratorId", value: string) {
		const col = field === "chapterId" ? terminals.chapterId : terminals.narratorId;
		const matched = await db.query.terminals.findMany({
			where: and(eq(col, value), isNull(terminals.worktreeResourceId)),
		});
		for (const terminal of matched) {
			if (terminal.worktreeResourceId != null) continue;
			if (terminal.status === "running") {
				try {
					await this.kill(terminal.id);
				} catch {
					// best effort
				}
			}
		}
		await db.delete(terminals).where(and(eq(col, value), isNull(terminals.worktreeResourceId)));
	},

	/**
	 * Get the root shell PID for a terminal.
	 * dtach mode: find the dtach process via socket path, its child is the shell.
	 * direct mode: the subprocess PID is the shell.
	 */
	async getShellPid(terminalId: string): Promise<number | null> {
		const existing = await db.query.terminals.findFirst({ where: eq(terminals.id, terminalId) });
		if (existing) assertLegacyRuntimeOwner(existing);
		const active = activeTerminals.get(terminalId);
		if (active) {
			if (active.useDtach) {
				// In dtach mode, active.process is the "dtach -a" attach process, not the shell.
				// The actual shell is a child of the "dtach -n" server process.
				const socketPath = dtachService.getSocketPath(terminalId);
				const dtachPids = await findProcessesByArg(socketPath);
				for (const pid of dtachPids) {
					const children = await getDescendantPids(pid);
					if (children.length > 0) return children[0];
				}
				return null;
			}
			return active.runtime.pid ?? null;
		}
		// Detached dtach terminal (not in activeTerminals)
		if ((await dtachService.isAvailable()) && (await dtachService.isSocketAlive(terminalId))) {
			const socketPath = dtachService.getSocketPath(terminalId);
			const dtachPids = await findProcessesByArg(socketPath);
			for (const pid of dtachPids) {
				const children = await getDescendantPids(pid);
				if (children.length > 0) return children[0];
			}
		}
		return null;
	},

	/**
	 * Get process info for a terminal: the shell and all its descendants.
	 */
	async getProcesses(terminalId: string): Promise<TerminalProcessInfo[]> {
		const shellPid = await this.getShellPid(terminalId);
		if (!shellPid) return [];

		const allPids = [shellPid, ...(await getDescendantPids(shellPid))];
		const infoMap = await getProcessInfoBatch(allPids);
		return allPids
			.map((pid) => infoMap.get(pid))
			.filter((info): info is TerminalProcessInfo => info !== undefined);
	},

	/**
	 * Batch-get process info for multiple terminals using a single ps snapshot.
	 * Returns a Map from terminalId to its process list.
	 */
	async getProcessesBatch(
		terminalIds: string[],
		snapshot?: ProcessSnapshot,
	): Promise<Map<string, TerminalProcessInfo[]>> {
		const result = new Map<string, TerminalProcessInfo[]>();
		if (terminalIds.length === 0) return result;

		const snap = snapshot ?? (await ProcessSnapshot.create());

		for (const terminalId of terminalIds) {
			const shellPid = await this._getShellPidWithSnapshot(terminalId, snap);
			if (!shellPid) {
				result.set(terminalId, []);
				continue;
			}
			const allPids = [shellPid, ...snap.getDescendants(shellPid)];
			const processes = allPids
				.map((pid) => snap.getInfo(pid))
				.filter((info): info is TerminalProcessInfo => info !== null);
			result.set(terminalId, processes);
		}
		return result;
	},

	/**
	 * getShellPid variant that uses a pre-built ProcessSnapshot instead of spawning processes.
	 */
	async _getShellPidWithSnapshot(
		terminalId: string,
		snapshot: ProcessSnapshot,
	): Promise<number | null> {
		const active = activeTerminals.get(terminalId);
		if (active) {
			if (active.useDtach) {
				const socketPath = dtachService.getSocketPath(terminalId);
				const dtachPids = snapshot.findByArg(socketPath);
				for (const pid of dtachPids) {
					const children = snapshot.getChildren(pid);
					if (children.length > 0) return children[0];
				}
				return null;
			}
			return active.runtime.pid ?? null;
		}
		if (await dtachService.isAvailable()) {
			const socketPath = dtachService.getSocketPath(terminalId);
			const dtachPids = snapshot.findByArg(socketPath);
			for (const pid of dtachPids) {
				const children = snapshot.getChildren(pid);
				if (children.length > 0) return children[0];
			}
		}
		return null;
	},

	/**
	 * Graceful shutdown: detach from dtach sessions (keeping them alive)
	 * and kill direct-mode terminals.
	 */
	async shutdownAll() {
		const promises: Promise<void>[] = [];
		for (const [id, active] of activeTerminals) {
			promises.push(
				(async () => {
					if (active.useDtach) {
						// dtach mode: save buffer and close the attach process,
						// but do NOT kill the dtach session — it should survive restart.
						// DB status stays "running" so recoverOnStartup can find it.
						await active.buffer.saveToDisk();
						active.buffer.stopPeriodicFlush();
						active.runtime.close();
					} else {
						// Direct mode: kill the process and mark as exited.
						await active.buffer.dispose(true);
						active.runtime.kill();
						active.runtime.close();
						await markTerminalExited(id, -1);
					}
				})(),
			);
		}
		const results = await Promise.allSettled(promises);
		const count = activeTerminals.size;
		activeTerminals.clear();
		if (count > 0) {
			logger.info("Shutdown: detached/killed active terminals", { count });
		}
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length > 0) {
			throw new AggregateError(failures, `Failed to shut down ${failures.length} terminal(s)`);
		}
	},
};
