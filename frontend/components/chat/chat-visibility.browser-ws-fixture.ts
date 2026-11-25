import type { ListenerOptions, MessageCallback } from "../../lib/narrator-ws-manager";

// Only the WS transport is controlled. Production sessions/hooks own leases,
// requestId matching, callback lifetimes, and actual fetch AbortSignals.
const listeners = new Map<number, { options: ListenerOptions; callback: MessageCallback }>();
const connections = new Set<(connected: boolean, reconnect: boolean) => void>();
const recoveries = new Set<() => void>();
const owners = new Map<number, { roomId: string; requestId?: string }>();
const frames: { kind: string; roomId: string; requestId?: string }[] = [];
let nextId = 0;
export const narratorWSManager = {
	connected: true,
	disconnected: false,
	allocateId: () => ++nextId,
	subscribe: () => ({ _id: ++nextId }),
	unsubscribe() {},
	joinPresence() {},
	leavePresence() {},
	seedCatchUpCursor() {},
	joinChatRoom(roomId: string, owner: number, requestId?: string) {
		owners.set(owner, { roomId, requestId });
		frames.push({ kind: "join", roomId, requestId });
	},
	leaveChatRoom(roomId: string, owner: number) {
		owners.delete(owner);
		frames.push({ kind: "leave", roomId });
	},
	addListener(options: ListenerOptions, callback: MessageCallback) {
		const handle = { _id: ++nextId };
		listeners.set(handle._id, { options, callback });
		return handle;
	},
	removeListener(handle: { _id: number }) {
		listeners.delete(handle._id);
	},
	onConnectionChange(callback: (connected: boolean, reconnect: boolean) => void) {
		connections.add(callback);
		return () => connections.delete(callback);
	},
	onControlPlaneRecovery(callback: () => void) {
		recoveries.add(callback);
		return () => recoveries.delete(callback);
	},
	send: () => true,
	reconnect() {
		for (const callback of connections) callback(true, true);
	},
};

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
export function acknowledge(tailSeq: number) {
	for (const { roomId, requestId } of owners.values()) {
		if (requestId) emit({ type: "chat:subscribed", roomId, requestId, tailSeq });
	}
}
export function reportWS() {
	return {
		owners: owners.size,
		bodyListeners: [...listeners.values()].filter(({ options }) =>
			options.types?.includes("chat:message"),
		).length,
		joins: frames.filter((frame) => frame.kind === "join").length,
		leaves: frames.filter((frame) => frame.kind === "leave").length,
		frames: [...frames],
	};
}
