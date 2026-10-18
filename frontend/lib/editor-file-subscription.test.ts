import { expect, mock, test } from "bun:test";
import { type EditorFileHint, EditorFileSubscriptions } from "./editor-file-subscription";
import type { MessageCallback } from "./narrator-ws-manager";

function fixture() {
	let receive: MessageCallback = () => {},
		connection = (_connected: boolean, _reconnect: boolean) => {};
	const send = mock((_frame: Record<string, unknown>) => true),
		removeListener = mock(() => {});
	const transport = {
		connected: true,
		send,
		removeListener,
		addListener: (_opts: unknown, cb: MessageCallback) => {
			receive = cb;
			return { _id: 1 };
		},
		onConnectionChange: (cb: typeof connection) => {
			connection = cb;
			return () => {};
		},
	};
	const pool = new EditorFileSubscriptions(transport);
	const subscribeId = () =>
		send.mock.calls.filter(([frame]) => frame.type === "editor_file_subscribe").at(-1)?.[0]
			.subscriptionId;
	const frame = (seq: number, generation = "g1", type = "editor_file_changed") =>
		receive({ type, subscriptionId: subscribeId(), generation, seq, resourceId: "stable" });
	return {
		pool,
		send,
		removeListener,
		frame,
		subscribeId,
		receive: (data: Record<string, unknown>) => receive(data),
		connect: (connected: boolean) => connection(connected, true),
	};
}
const target = { resourceId: "stable", narratorId: "actual-file-narrator", docId: "doc" };
test("two refs share a wire subscription; duplicate/out of order/gap/overflow coalesce", async () => {
	const f = fixture(),
		hint = mock((_reason: EditorFileHint) => {});
	const a = f.pool.subscribe(target, hint),
		b = f.pool.subscribe(target, hint);
	expect(f.send).toHaveBeenCalledTimes(1);
	f.frame(1, "g1", "editor_file_subscribed");
	await Promise.resolve();
	hint.mockClear();
	for (const seq of [2, 2, 1, 8, 9999]) f.frame(seq);
	await Promise.resolve();
	expect(hint).toHaveBeenCalledTimes(2); // one per independent owner
	f.frame(10000, "old-generation");
	await Promise.resolve();
	expect(hint).toHaveBeenCalledTimes(2);
	a();
	a();
	expect(f.pool.size).toBe(1);
	expect(f.removeListener).not.toHaveBeenCalled();
	b();
	expect(f.pool.size).toBe(0);
	expect(f.removeListener).toHaveBeenCalledTimes(1);
	expect(f.send.mock.calls.at(-1)?.[0].type).toBe("editor_file_unsubscribe");
});
test("reconnect rejects old ACKs, changes and queued microtasks, then reconciles once", async () => {
	const f = fixture(),
		hint = mock((_reason: EditorFileHint) => {}),
		stop = f.pool.subscribe(target, hint);
	const oldId = f.subscribeId();
	f.frame(1, "old", "editor_file_subscribed");
	f.connect(false);
	expect(hint).toHaveBeenCalledWith("disconnect");
	hint.mockClear();
	f.connect(true);
	f.receive({
		type: "editor_file_subscribed",
		subscriptionId: oldId,
		generation: "old",
		seq: 1,
		resourceId: "stable",
	});
	f.frame(1, "fresh", "editor_file_subscribed");
	f.frame(20, "fresh");
	await Promise.resolve();
	expect(hint.mock.calls).toEqual([["rebind"]]);
	stop();
});
test("revocation clears queued notification and final release cancels pending dispatch", async () => {
	const f = fixture(),
		hint = mock((_reason: EditorFileHint) => {}),
		stop = f.pool.subscribe(target, hint);
	f.frame(1, "g1", "editor_file_subscribed");
	f.receive({ type: "editor_file_error", subscriptionId: f.subscribeId(), code: "access_denied" });
	await Promise.resolve();
	expect(hint.mock.calls).toEqual([["denied"]]);
	f.frame(1, "fresh", "editor_file_subscribed");
	stop();
	await Promise.resolve();
	expect(hint).toHaveBeenCalledTimes(1);
});
