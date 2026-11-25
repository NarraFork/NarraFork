import type { ListenerOptions, MessageCallback } from "../../lib/narrator-ws-manager";

// Transport only: production hooks and HTTP clients are never replaced.
const listeners = new Map<number, { options: ListenerOptions; callback: MessageCallback }>();
const connections = new Set<(connected: boolean, isReconnect: boolean) => void>();
const recoveries = new Set<() => void>();
let nextId = 0;
export const controlledWS = {
	connected: true,
	disconnected: false,
	subscribe() {
		return { _id: ++nextId };
	},
	unsubscribe() {},
	joinPresence() {},
	leavePresence() {},
	addListener(options: ListenerOptions, callback: MessageCallback) {
		const handle = { _id: ++nextId };
		listeners.set(handle._id, { options, callback });
		return handle;
	},
	removeListener(handle: { _id: number }) {
		listeners.delete(handle._id);
	},
	onConnectionChange(callback: (connected: boolean, isReconnect: boolean) => void) {
		connections.add(callback);
		return () => connections.delete(callback);
	},
	onControlPlaneRecovery(callback: () => void) {
		recoveries.add(callback);
		return () => recoveries.delete(callback);
	},
	send() {
		return true;
	},
	reconnect() {
		connection(true, true);
	},
};

export { controlledWS as narratorWSManager };

export function emit(frame: Record<string, unknown>) {
	for (const { options, callback } of [...listeners.values()]) {
		if (
			options.narratorIds &&
			options.narratorIds !== "*" &&
			!options.narratorIds.includes(String(frame.narratorId))
		)
			continue;
		if (options.types && !options.types.includes(String(frame.type))) continue;
		if (options.excludeTypes?.includes(String(frame.type))) continue;
		callback(frame);
	}
}

export function connection(connected: boolean, isReconnect = false) {
	controlledWS.connected = connected;
	controlledWS.disconnected = !connected;
	for (const callback of connections) callback(connected, isReconnect);
}

export function foreground() {
	// Exercise the manager's public recovery channel, not its visibility/throttling implementation.
	for (const callback of recoveries) callback();
}
