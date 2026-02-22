/**
 * Global WebSocket connection status tracker.
 *
 * Components register their WS connection state here.
 * The WSConnectionAlert component subscribes to changes and
 * shows a banner when any connection is lost.
 */

type ConnectionEntry = {
	label: string;
	connected: boolean;
	reconnect?: () => void;
};

type Listener = () => void;

const connections = new Map<string, ConnectionEntry>();
const listeners = new Set<Listener>();

function notify() {
	for (const cb of listeners) cb();
}

/** Register or update a WS connection's status. */
export function setWSStatus(id: string, entry: ConnectionEntry) {
	connections.set(id, entry);
	notify();
}

/** Remove a WS connection (e.g. on unmount). */
export function removeWSStatus(id: string) {
	connections.delete(id);
	notify();
}

/** Get all disconnected entries. */
export function getDisconnected(): Array<{ id: string } & ConnectionEntry> {
	const result: Array<{ id: string } & ConnectionEntry> = [];
	for (const [id, entry] of connections) {
		if (!entry.connected) result.push({ id, ...entry });
	}
	return result;
}

/** Check if any connection is disconnected. */
export function hasDisconnected(): boolean {
	for (const entry of connections.values()) {
		if (!entry.connected) return true;
	}
	return false;
}

/** Subscribe to status changes. Returns unsubscribe function. */
export function onWSStatusChange(cb: Listener): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}
