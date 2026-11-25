import { afterEach, expect, spyOn, test } from "bun:test";
import type { CommunicationScope, CommunicationTopology } from "@shared/narrator-communication";
import type { ServerWebSocket } from "bun";
import * as auth from "../lib/auth";
import { eventBus } from "../lib/event-bus";
import * as reader from "../services/narrator-communication/index";
import { communicationSubscriptionStats } from "./narrator-communication-ws";
import { type WSData, wsHandlers } from "./ws-handler";

const scope: CommunicationScope = { kind: "narrator", narratorId: "source" };
const graph = (title: string): CommunicationTopology => ({
	scope,
	nodes: [
		{
			id: "source",
			title,
			status: "idle",
			parentNarratorId: null,
			groupId: "source",
			version: 1,
			delegated: false,
			canManage: true,
			canConnect: true,
			restoreParentId: null,
		},
	],
	peers: [],
	truncated: false,
});
const sockets: ServerWebSocket<WSData>[] = [];
const spies: Array<{ mockRestore(): void }> = [];
function socket() {
	const frames: Record<string, unknown>[] = [];
	const ws = {
		readyState: 1,
		data: {
			channel: "narrator",
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			subscribedNarrators: new Set(),
			subscribedChatRooms: new Set(),
			catchingUpNarrators: new Map(),
			catchUpBuffers: new Map(),
			userId: "person",
			userRole: "admin",
			sessionId: "session",
			sessionUserId: "person",
		},
		send(text: string) {
			frames.push(JSON.parse(text));
			return 1;
		},
		getBufferedAmount: () => 0,
		close: () => {},
	} as unknown as ServerWebSocket<WSData>;
	sockets.push(ws);
	wsHandlers.open(ws);
	return { ws, frames };
}
async function settle(predicate: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("did not settle");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
afterEach(() => {
	for (const ws of sockets.splice(0)) wsHandlers.close(ws, 1000, "test");
	for (const spy of spies.splice(0)) spy.mockRestore();
});

test("real WS JSON dispatcher/schema routes snapshots, dirty data deltas, unsubscribe and close cleanup", async () => {
	let current = graph("first");
	const session = spyOn(auth, "resolveLiveSession").mockResolvedValue({
		sub: "person",
		role: "user",
		iat: 0,
		exp: 9999999999,
	});
	spies.push(session);
	const read = spyOn(reader, "getCommunicationTopology").mockImplementation(async () => current);
	spies.push(read);
	const { ws, frames } = socket();
	wsHandlers.message(
		ws,
		JSON.stringify({ type: "communication_subscribe", subscriptionId: "actual", scope }),
	);
	await settle(() => frames.some((frame) => frame.type === "communication_snapshot"));
	expect(read.mock.calls[0][1]).toEqual({ userId: "person", isAdmin: false }); // Never trust stale admin role on socket.
	expect(ws.data.channel === "narrator" && ws.data.subscribedNarrators.size).toBe(0);
	current = graph("pushed not HTTP hint");
	eventBus.emit({ type: "team:communication_changed", teamId: "team" });
	await settle(() => frames.some((frame) => frame.type === "communication_delta"));
	expect(frames.at(-1)).toMatchObject({
		type: "communication_delta",
		seq: 1,
		baseSeq: 0,
		delta: { upsertNodes: [{ title: "pushed not HTTP hint" }] },
	});
	wsHandlers.message(
		ws,
		JSON.stringify({ type: "communication_unsubscribe", subscriptionId: "actual" }),
	);
	await settle(() => communicationSubscriptionStats().total === 0);
	wsHandlers.message(
		ws,
		JSON.stringify({ type: "communication_subscribe", subscriptionId: "closed", scope }),
	);
	await settle(() => communicationSubscriptionStats().total === 1);
	wsHandlers.close(ws, 1000, "test");
	expect(communicationSubscriptionStats().total).toBe(0);
});

test("invalid wire scopes are rejected before creating subscriptions; revoked session never calls graph worker", async () => {
	const session = spyOn(auth, "resolveLiveSession").mockResolvedValue(null);
	spies.push(session);
	const read = spyOn(reader, "getCommunicationTopology").mockResolvedValue(graph("secret"));
	spies.push(read);
	const { ws, frames } = socket();
	wsHandlers.message(
		ws,
		JSON.stringify({
			type: "communication_subscribe",
			subscriptionId: "bad",
			scope: { kind: "all" },
		}),
	);
	await settle(() => frames.length === 1);
	expect(frames[0].type).toBe("error");
	expect(communicationSubscriptionStats().total).toBe(0);
	wsHandlers.message(
		ws,
		JSON.stringify({ type: "communication_subscribe", subscriptionId: "revoked", scope }),
	);
	await settle(() => frames.some((frame) => frame.type === "communication_error"));
	expect(frames.at(-1)).toMatchObject({ type: "communication_error", code: "access_denied" });
	expect(read).not.toHaveBeenCalled();
});
