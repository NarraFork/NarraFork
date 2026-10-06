/**
 * Backend registry — resolves a device id to an ExecutionBackend.
 *
 * Local execution is selected only when no target is configured or the caller
 * explicitly requests `local`. A configured remote target must resolve to a
 * live backend; silently running the operation on the server would route file
 * and command access to the wrong machine.
 */
import type { ExecutionBackend } from "./backend";
import { LOCAL_DEVICE_ID } from "./backend";
import { localBackend } from "./local-backend";

/** Factory for a remote backend, injected by the device layer in later phases. */
export type RemoteBackendResolver = (deviceId: string) => ExecutionBackend | null;

let remoteResolver: RemoteBackendResolver | null = null;

/**
 * Register the remote-backend resolver. Called once during server startup by
 * the device service (phase 2+). No-op wiring in phase 0/1.
 */
export function setRemoteBackendResolver(resolver: RemoteBackendResolver | null): void {
	remoteResolver = resolver;
}

export interface ResolveBackendInput {
	/** Device explicitly requested by a tool call (the `device` parameter). */
	requested?: string;
	/** The session's default device (set via SwitchDevice or global default). */
	sessionDefault?: string | null;
}

export type ExecutionTargetErrorCode = "REMOTE_DEVICE_UNAVAILABLE" | "REMOTE_DEVICE_UNAUTHORIZED";
export type ExecutionTargetSource = "requested" | "session_default";

/** Typed routing failure for a remote target that cannot currently be resolved. */
export class ExecutionTargetError extends Error {
	readonly code: ExecutionTargetErrorCode;
	readonly deviceId: string;
	readonly source: ExecutionTargetSource;

	constructor(deviceId: string, source: ExecutionTargetSource) {
		const sourceLabel = source === "requested" ? "requested" : "session default";
		super(
			`Remote execution device "${deviceId}" (${sourceLabel}) is unknown or offline. ` +
				`The operation was not run locally. Select an online device or switch to "${LOCAL_DEVICE_ID}".`,
		);
		this.name = "ExecutionTargetError";
		this.code = "REMOTE_DEVICE_UNAVAILABLE";
		this.deviceId = deviceId;
		this.source = source;
	}
}

/** Routing failure for a remote target outside the narrator's authorized device list. */
export class ExecutionTargetAuthorizationError extends Error {
	readonly code: ExecutionTargetErrorCode = "REMOTE_DEVICE_UNAUTHORIZED";
	readonly deviceId: string;
	readonly source: ExecutionTargetSource;

	constructor(deviceId: string, source: ExecutionTargetSource) {
		const sourceLabel = source === "requested" ? "requested" : "session default";
		super(
			`Remote execution device "${deviceId}" (${sourceLabel}) is not authorized for this narrator session. ` +
				`The operation was not run locally. Select a device from availableDevices or switch to "${LOCAL_DEVICE_ID}".`,
		);
		this.name = "ExecutionTargetAuthorizationError";
		this.deviceId = deviceId;
		this.source = source;
	}
}

/**
 * Resolve the effective backend for a tool call.
 * Priority: explicit request > session default > local.
 * Remote targets fail closed when unknown or offline; they never fall back to
 * the local server.
 */
export function resolveBackend(input: ResolveBackendInput = {}): ExecutionBackend {
	let target: string;
	let source: ExecutionTargetSource | null;
	if (input.requested !== undefined) {
		target = input.requested;
		source = "requested";
	} else if (input.sessionDefault !== undefined && input.sessionDefault !== null) {
		target = input.sessionDefault;
		source = "session_default";
	} else {
		target = LOCAL_DEVICE_ID;
		source = null;
	}

	if (target === LOCAL_DEVICE_ID) return localBackend;

	const remote = remoteResolver?.(target);
	if (remote?.kind === "remote" && remote.deviceId === target) return remote;

	throw new ExecutionTargetError(target, source ?? "requested");
}

export { LOCAL_DEVICE_ID, localBackend };
