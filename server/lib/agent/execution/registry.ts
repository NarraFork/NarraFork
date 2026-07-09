/**
 * Backend registry — resolves a device id to an ExecutionBackend.
 *
 * Phase 0: only the local backend exists, so every resolution returns it.
 * Later phases register RemoteBackend instances keyed by device id and this
 * module gains online/offline awareness. Keeping resolution behind one seam
 * means the tools never need to know how many backends exist.
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

/**
 * Resolve the effective backend for a tool call.
 * Priority: explicit request > session default > local.
 * Unknown/offline remote ids fall back to local so a stale reference never
 * hard-fails a tool — the tool surfaces a notice instead.
 */
export function resolveBackend(input: ResolveBackendInput = {}): ExecutionBackend {
	const target = input.requested ?? input.sessionDefault ?? LOCAL_DEVICE_ID;
	if (!target || target === LOCAL_DEVICE_ID) return localBackend;

	const remote = remoteResolver?.(target);
	if (remote) return remote;

	// Unknown or offline device — fall back to local.
	return localBackend;
}

export { LOCAL_DEVICE_ID, localBackend };
