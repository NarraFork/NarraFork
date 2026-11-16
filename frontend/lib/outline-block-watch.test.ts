import { describe, expect, test } from "bun:test";
import type { ListenerOptions, MessageCallback } from "./narrator-ws-manager";
import { OutlineBlockWatch, type OutlineWatchTransport } from "./outline-block-watch";

class FakeTransport implements OutlineWatchTransport {
	connected = true;
	sent: Array<Record<string, unknown>> = [];
	private listeners = new Map<number, MessageCallback>();
	private changes = new Set<(connected: boolean, reconnect: boolean) => void>();
	private next = 0;
	send(message: Record<string, unknown>) {
		if (!this.connected) return false;
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
	onConnectionChange(callback: (connected: boolean, reconnect: boolean) => void) {
		this.changes.add(callback);
		return () => this.changes.delete(callback);
	}
	emit(frame: Record<string, unknown>) {
		for (const listener of this.listeners.values()) listener(frame);
	}
	setConnected(connected: boolean) {
		this.connected = connected;
		for (const change of this.changes) change(connected, connected);
	}
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function setup() {
	const transport = new FakeTransport();
	const watch = new OutlineBlockWatch(transport, 1, 20);
	const heard: string[] = [];
	const handle = watch.open("S", {
		onWatching: (seq, added) =>
			heard.push(`watching ${seq} +${added.levels.join(",")}|${added.subtrees.join(",")}`),
		onChanged: (frame) =>
			heard.push(
				`changed ${frame.seq} ${frame.levels.join(",")}|${frame.subtrees.join(",")}${frame.all ? " all" : ""}`,
			),
		onPending: () => heard.push("pending"),
		onError: (code) => heard.push(`error ${code}`),
		onPaused: () => heard.push("paused"),
	});
	const id = () =>
		String(transport.sent.findLast((m) => m.type === "outline_watch")?.subscriptionId);
	return { transport, watch, heard, handle, id };
}

describe("the block watch's client", () => {
	test("a burst of sets is one send; the same set is not sent again; a new one replaces", async () => {
		const { transport, handle, id } = setup();
		handle.set(["a"], []);
		handle.set(["a", "b"], ["x"]);
		handle.set(["b", "a", "a"], ["x"]);
		await tick();
		expect(transport.sent).toHaveLength(1);
		expect(transport.sent[0]).toMatchObject({
			type: "outline_watch",
			spaceId: "S",
			levels: ["a", "b"],
			subtrees: ["x"],
		});
		handle.set(["a", "b"], ["x"]);
		await tick();
		expect(transport.sent).toHaveLength(1);
		const first = id();
		handle.set(["a", "c"], []);
		await tick();
		expect(transport.sent).toHaveLength(2);
		// The same subscription: the server replaces what it watches.
		expect(id()).toBe(first);
	});

	test("each confirmation says which keys are new in the set", async () => {
		const { transport, handle, heard, id } = setup();
		handle.set(["a", "b"], ["x"]);
		await tick();
		transport.emit({ type: "outline_watching", subscriptionId: id(), spaceId: "S", seq: 4 });
		handle.set(["b", "c"], ["x", "y"]);
		await tick();
		transport.emit({ type: "outline_watching", subscriptionId: id(), spaceId: "S", seq: 6 });
		expect(heard).toEqual(["watching 4 +a,b|x", "watching 6 +c|y"]);
	});

	test("changes, pending and frames of others", async () => {
		const { transport, handle, heard, id } = setup();
		handle.set(["a"], []);
		await tick();
		transport.emit({
			type: "outline_watch_changed",
			subscriptionId: id(),
			spaceId: "S",
			seq: 9,
			commitIds: [],
			levels: ["a"],
			subtrees: [],
			all: false,
		});
		transport.emit({
			type: "outline_watch_changed",
			subscriptionId: "other",
			spaceId: "S",
			seq: 10,
			levels: ["a"],
			subtrees: [],
			all: true,
		});
		transport.emit({
			type: "outline_watch_changed",
			subscriptionId: id(),
			spaceId: "T",
			seq: 11,
			levels: ["a"],
			subtrees: [],
			all: true,
		});
		transport.emit({ type: "outline_watch_pending", subscriptionId: id(), spaceId: "S" });
		expect(heard).toEqual(["changed 9 a|", "pending"]);
	});

	test("after a reconnect the set is sent again and every key is new", async () => {
		const { transport, handle, heard, id } = setup();
		handle.set(["a"], ["x"]);
		await tick();
		transport.emit({ type: "outline_watching", subscriptionId: id(), spaceId: "S", seq: 3 });
		transport.setConnected(false);
		transport.setConnected(true);
		await tick();
		expect(transport.sent.filter((m) => m.type === "outline_watch")).toHaveLength(2);
		transport.emit({ type: "outline_watching", subscriptionId: id(), spaceId: "S", seq: 8 });
		expect(heard.at(-1)).toBe("watching 8 +a|x");
	});

	test("no room: said, and tried again later; access denied: said, not retried", async () => {
		const { transport, handle, heard, id } = setup();
		handle.set(["a"], []);
		await tick();
		transport.emit({ type: "outline_watch_error", subscriptionId: id(), code: "unavailable" });
		expect(heard).toEqual(["error unavailable"]);
		await tick(40);
		expect(transport.sent.filter((m) => m.type === "outline_watch")).toHaveLength(2);
		transport.emit({ type: "outline_watch_error", subscriptionId: id(), code: "access_denied" });
		await tick(40);
		expect(transport.sent.filter((m) => m.type === "outline_watch")).toHaveLength(2);
		expect(heard.at(-1)).toBe("error access_denied");
		// The view found the deny transient: it asks again.
		handle.retry();
		await tick();
		expect(transport.sent.filter((m) => m.type === "outline_watch")).toHaveLength(3);
	});

	test("no room again and again: the delay grows, then the watch is paused until retry", async () => {
		const { transport, handle, heard, id } = setup();
		handle.set(["a"], []);
		await tick();
		const watches = () => transport.sent.filter((m) => m.type === "outline_watch").length;
		const times: number[] = [];
		let last = Date.now();
		for (let i = 0; i < 4; i++) {
			const before = watches();
			transport.emit({ type: "outline_watch_error", subscriptionId: id(), code: "unavailable" });
			while (watches() === before) await tick(2);
			times.push(Date.now() - last);
			last = Date.now();
		}
		// 20, 40, 80, 160 ms (the test's base delay is 20): never sooner than that.
		times.forEach((took, i) => {
			expect(took).toBeGreaterThanOrEqual(20 * 2 ** i - 3);
		});
		transport.emit({ type: "outline_watch_error", subscriptionId: id(), code: "unavailable" });
		expect(heard.at(-1)).toBe("paused");
		const sent = watches();
		await tick(400);
		expect(watches()).toBe(sent);
		handle.retry();
		await tick();
		expect(watches()).toBe(sent + 1);
		// A confirmation starts the count over.
		transport.emit({ type: "outline_watching", subscriptionId: id(), spaceId: "S", seq: 3 });
		transport.emit({ type: "outline_watch_error", subscriptionId: id(), code: "unavailable" });
		expect(heard.at(-1)).toBe("error unavailable");
	}, 10_000);

	test("an empty set unwatches; dispose unwatches and frees the place; keys are bounded", async () => {
		const { transport, handle, watch } = setup();
		expect(watch.size).toBe(1);
		handle.set(
			Array.from({ length: 2500 }, (_, i) => `l${i}`),
			["x"],
		);
		await tick();
		const sent = transport.sent.at(-1) as { levels: string[]; subtrees: string[] };
		expect(sent.levels.length + sent.subtrees.length).toBe(2000);
		handle.set([], []);
		await tick();
		expect(transport.sent.at(-1)).toMatchObject({ type: "outline_unwatch" });
		handle.set(["a"], []);
		await tick();
		handle.dispose();
		expect(transport.sent.at(-1)).toMatchObject({ type: "outline_unwatch" });
		expect(watch.size).toBe(0);
	});
});
