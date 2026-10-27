import { expect, mock, test } from "bun:test";
import { OUTLINE_PAGE_SUBSCRIPTION_LIMITS } from "@shared/outline-page-events";
import type { MessageCallback } from "./narrator-ws-manager";
import { type OutlinePageHint, OutlinePageSubscriptions } from "./outline-page-subscription";

function fixture(connected = true) {
	const receivers = new Set<MessageCallback>();
	const connections = new Set<(connected: boolean, reconnect: boolean) => void>();
	const send = mock((_frame: Record<string, unknown>) => true);
	const removeListener = mock((_handle: unknown) => {});
	const transport = {
		connected,
		send,
		removeListener,
		addListener: (_opts: unknown, cb: MessageCallback) => {
			receivers.add(cb);
			return { _id: receivers.size };
		},
		onConnectionChange: (cb: (connected: boolean, reconnect: boolean) => void) => {
			connections.add(cb);
			return () => connections.delete(cb);
		},
	};
	const pool = new OutlinePageSubscriptions(transport);
	const sent = (type: string) =>
		send.mock.calls.map(([frame]) => frame).filter((f) => f.type === type);
	const lastId = () => sent("outline_page_subscribe").at(-1)?.subscriptionId as string;
	const receive = (frame: Record<string, unknown>) => {
		for (const cb of receivers) cb(frame);
	};
	return {
		pool,
		send,
		sent,
		lastId,
		receive,
		removeListener,
		connect: (value: boolean) => {
			for (const cb of connections) cb(value, true);
		},
	};
}

test("listeners of one page share a wire subscription and hear seqs only when they move", () => {
	const f = fixture();
	const a = mock((_hint: OutlinePageHint) => {});
	const b = mock((_hint: OutlinePageHint) => {});
	const stopA = f.pool.subscribe("page-1", a);
	const stopB = f.pool.subscribe("page-1", b);
	expect(f.sent("outline_page_subscribe")).toEqual([
		{ type: "outline_page_subscribe", subscriptionId: f.lastId(), pageId: "page-1" },
	]);
	const id = f.lastId();
	f.receive({ type: "outline_page_subscribed", subscriptionId: id, pageId: "page-1", seq: 4 });
	for (const seq of [5, 5, 3, 7]) {
		f.receive({ type: "outline_page_changed", subscriptionId: id, pageId: "page-1", seq });
	}
	// Frames of another subscription or page are not ours.
	f.receive({ type: "outline_page_changed", subscriptionId: "other", pageId: "page-1", seq: 99 });
	f.receive({ type: "outline_page_changed", subscriptionId: id, pageId: "page-2", seq: 99 });
	expect(a.mock.calls.map(([hint]) => hint)).toEqual([
		{ kind: "subscribed", seq: 4 },
		{ kind: "changed", seq: 5 },
		{ kind: "changed", seq: 7 },
	]);
	expect(b).toHaveBeenCalledTimes(3);

	stopA();
	stopA();
	expect(f.pool.size).toBe(1);
	expect(f.sent("outline_page_unsubscribe")).toEqual([]);
	stopB();
	expect(f.pool.size).toBe(0);
	expect(f.removeListener).toHaveBeenCalledTimes(1);
	expect(f.sent("outline_page_unsubscribe")).toEqual([
		{ type: "outline_page_unsubscribe", subscriptionId: id },
	]);
});

test("a reconnect re-subscribes under a new id and ignores the old one", () => {
	const f = fixture();
	const hint = mock((_hint: OutlinePageHint) => {});
	f.pool.subscribe("page-1", hint);
	const oldId = f.lastId();
	f.connect(false);
	expect(hint).toHaveBeenLastCalledWith({ kind: "disconnect" });
	f.connect(true);
	const newId = f.lastId();
	expect(newId).not.toBe(oldId);
	f.receive({ type: "outline_page_changed", subscriptionId: oldId, pageId: "page-1", seq: 50 });
	expect(hint).toHaveBeenCalledTimes(1);
	f.receive({ type: "outline_page_subscribed", subscriptionId: newId, pageId: "page-1", seq: 50 });
	expect(hint).toHaveBeenLastCalledWith({ kind: "subscribed", seq: 50 });
});

test("errors end the subscription: denied and unavailable are told apart", () => {
	const f = fixture();
	const hint = mock((_hint: OutlinePageHint) => {});
	f.pool.subscribe("private", hint);
	const id = f.lastId();
	f.receive({ type: "outline_page_error", subscriptionId: id, code: "access_denied" });
	f.receive({ type: "outline_page_changed", subscriptionId: id, pageId: "private", seq: 9 });
	expect(hint.mock.calls.map(([h]) => h)).toEqual([{ kind: "denied" }]);

	f.pool.subscribe("busy", hint);
	f.receive({ type: "outline_page_error", subscriptionId: f.lastId(), code: "unavailable" });
	expect(hint).toHaveBeenLastCalledWith({ kind: "unavailable" });
});

test("nothing is sent while disconnected, and pages past the per-socket limit are not subscribed", () => {
	const offline = fixture(false);
	offline.pool.subscribe("page-1", () => {});
	expect(offline.send).not.toHaveBeenCalled();
	offline.connect(true);
	expect(offline.sent("outline_page_subscribe")).toHaveLength(1);

	const f = fixture();
	for (let i = 0; i < OUTLINE_PAGE_SUBSCRIPTION_LIMITS.perSocket; i++) {
		f.pool.subscribe(`page-${i}`, () => {});
	}
	const stop = f.pool.subscribe("one-too-many", () => {});
	expect(f.pool.size).toBe(OUTLINE_PAGE_SUBSCRIPTION_LIMITS.perSocket);
	expect(f.sent("outline_page_subscribe")).toHaveLength(OUTLINE_PAGE_SUBSCRIPTION_LIMITS.perSocket);
	stop();
});
