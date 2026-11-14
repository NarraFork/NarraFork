import {
	parseRemoteBackendIdentity,
	type RemoteBackendIdentity,
	sameRemoteBackendIdentity,
} from "@shared/remote-access/application";
import type { RemoteFrontendMountOptions } from "@shared/remote-access/business-transport";

let runtime: RemoteFrontendMountOptions | null = null;
let authenticated = false;
const disposers = new Set<() => void>();

export function initializeRemoteRuntime(options: RemoteFrontendMountOptions): void {
	const identity = parseRemoteBackendIdentity(options.backendIdentity);
	if (
		!options.transport.backendIdentity ||
		!sameRemoteBackendIdentity(identity, options.transport.backendIdentity)
	) {
		throw new Error("REMOTE_BACKEND_IDENTITY_CHANGED");
	}
	const base = new URL(options.assetBase, location.href);
	if (
		base.origin !== location.origin ||
		base.search ||
		base.hash ||
		!/^\/remote\/frontends\/[a-f0-9]{64}\/$/.test(base.pathname)
	) {
		throw new Error("REMOTE_ASSET_BASE_INVALID");
	}
	if (runtime) throw new Error("REMOTE_ALREADY_MOUNTED");
	runtime = { ...options, backendIdentity: identity, assetBase: base.href };
	authenticated = false;
}

export function remoteRuntime(): RemoteFrontendMountOptions {
	if (!runtime) throw new Error("REMOTE_TRANSPORT_NOT_INITIALIZED");
	const identity = runtime.transport.backendIdentity;
	if (!identity || !sameRemoteBackendIdentity(runtime.backendIdentity, identity)) {
		clearRemoteRuntime();
		throw new Error("REMOTE_BACKEND_IDENTITY_CHANGED");
	}
	return runtime;
}

export async function authenticateRemoteSession(token: string): Promise<void> {
	const current = remoteRuntime();
	await current.transport.authenticate(token);
	if (current !== remoteRuntime()) throw new Error("REMOTE_SESSION_CHANGED");
	authenticated = true;
}

export function isRemoteSessionAuthenticated(): boolean {
	return authenticated;
}
export function remoteIdentity(): RemoteBackendIdentity {
	return remoteRuntime().backendIdentity;
}
export function onRemoteCleanup(dispose: () => void): () => void {
	disposers.add(dispose);
	return () => disposers.delete(dispose);
}
export function clearRemoteRuntime(): void {
	authenticated = false;
	const previous = runtime;
	runtime = null;
	for (const dispose of disposers) {
		try {
			dispose();
		} catch {
			/* Continue releasing every resource. */
		}
	}
	disposers.clear();
	previous?.transport.close(new Error("REMOTE_SESSION_CLOSED"));
}
