import { describe, expect, test } from "bun:test";
import type { ListenerOptions, MessageCallback } from "./narrator-ws-manager";
import { OutlineBlockWatch, type OutlineWatchTransport } from "./outline-block-watch";
import { OutlineSubtreeWatches } from "./outline-subtree-watch";

class FakeTransport implements OutlineWatchTransport {
	connected = true;
	sent: Array<Record<string, unknown>> = [];
	private listeners = new Map<number, MessageCallback>();
	private next = 0;
	send(message: Record<string, unknown>) {
		this.sent.push(message);
		return true;
	}
	addListener(_options: ListenerOptions, callback: MessageCallback) {
		const id = ++this.next;
		this.listeners.set(id, callback);
		return { _id: id };
	}
	removeListener(handle: { _id: number }) {
		this.listeners.delete(handle._id);
	}
	onConnectionChange() {
		return () => {};
	}
	emit(frame: Record<string, unknown>) {
		for (const listener of [...this.listeners.values()]) listener(frame);
	}
	/** Subscriptions with a watch on the wire now (sent and not unwatched). */
	open(): Map<string, Record<string, unknown>> {
		const out = new Map<string, Record<string, unknown>>();
		for (const m of this.sent) {
			const id = String(m.subscriptionId);
			if (m.type === "outline_watch") out.set(id, m);
			if (m.type === "outline_unwatch") out.delete(id);
		}
		return out;
	}
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(resumeMs = 30) {
	const transport = new FakeTransport();
	const block = new OutlineBlockWatch(transport, 1, 5);
	const watches = new OutlineSubtreeWatches(
		(spaceId, handlers) => block.open(spaceId, handlers),
		resumeMs,
	);
	return { transport, block, watches };
}

describe("subtree watches shared across a tab", () => {
	test("N cards in one space use one subscription carrying the union; the last to leave closes it", async () => {
		const { transport, block, watches } = setup();
		const heard: string[] = [];
		const stops = ["a", "b", "c", "a"].map((id, n) =>
			watches.watch("S", [id], (seq) => heard.push(`${n}:${seq}`)),
		);
		const other = watches.watch("T", ["x"], () => {});
		await tick();
		expect(block.size).toBe(2);
		expect(watches.size).toBe(2);
		const open = [...transport.open().values()];
		expect(open).toHaveLength(2);
		expect(open.find((m) => m.spaceId === "S")?.subtrees).toEqual(["a", "b", "c"]);
		// A change under `b` reaches its card only; `all` reaches every card of the space.
		const sid = String(open.find((m) => m.spaceId === "S")?.subscriptionId);
		transport.emit({ type: "outline_watching", subscriptionId: sid, spaceId: "S", seq: 5 });
		heard.length = 0;
		transport.emit({
			type: "outline_watch_changed",
			subscriptionId: sid,
			spaceId: "S",
			seq: 6,
			levels: [],
			subtrees: ["b"],
		});
		expect(heard).toEqual(["1:6"]);
		heard.length = 0;
		transport.emit({
			type: "outline_watch_changed",
			subscriptionId: sid,
			spaceId: "S",
			seq: 7,
			levels: [],
			subtrees: [],
			all: true,
		});
		expect(heard.sort()).toEqual(["0:7", "1:7", "2:7", "3:7"]);
		// Leaving narrows the union; the last card closes the space's watch.
		stops[1]?.();
		await tick();
		expect(transport.open().get(sid)?.subtrees).toEqual(["a", "c"]);
		for (const stop of [stops[0], stops[2], stops[3]]) stop?.();
		await tick();
		expect(transport.open().has(sid)).toBe(false);
		expect(watches.size).toBe(1);
		other();
		expect(block.size).toBe(0);
	});

	test("no room after every retry: asked again later, and every card re-reads when it is back", async () => {
		const { transport, watches } = setup(20);
		const heard: Array<number | null> = [];
		watches.watch("S", ["a"], (seq) => heard.push(seq));
		await tick();
		const sid = String([...transport.open().values()][0]?.subscriptionId);
		transport.emit({ type: "outline_watching", subscriptionId: sid, spaceId: "S", seq: 3 });
		expect(heard).toEqual([3]);
		// `unavailable` past the block watch's own retries (5 ms backoff, 4 tries): paused.
		for (let n = 0; n < 4; n++) {
			transport.emit({ type: "outline_watch_error", subscriptionId: sid, code: "unavailable" });
			await tick(5 * 2 ** n + 5);
		}
		transport.emit({ type: "outline_watch_error", subscriptionId: sid, code: "unavailable" });
		const sentBefore = transport.sent.filter((m) => m.type === "outline_watch").length;
		await tick(40);
		// Asked again after the pause.
		expect(transport.sent.filter((m) => m.type === "outline_watch").length).toBeGreaterThan(
			sentBefore,
		);
		// Back, at the same seq as before the pause: still news (the card re-reads).
		transport.emit({ type: "outline_watching", subscriptionId: sid, spaceId: "S", seq: 3 });
		expect(heard).toEqual([3, 3]);
		// Denied: re-read too.
		transport.emit({ type: "outline_watch_error", subscriptionId: sid, code: "access_denied" });
		expect(heard).toEqual([3, 3, null]);
	});
});
