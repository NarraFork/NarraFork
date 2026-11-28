import { describe, expect, mock, test } from "bun:test";
import { createAgentReferenceStore } from "./agent-reference-store";
import type { ListenerOptions, MessageCallback } from "./narrator-ws-manager";

function fixture() {
	let seq = 0;
	const events = new Map<number, MessageCallback>();
	const connections = new Set<(connected: boolean, reconnect: boolean) => void>();
	const manager = {
		addListener: mock((_options: ListenerOptions, callback: MessageCallback) => {
			const handle = { _id: ++seq };
			events.set(handle._id, callback);
			return handle;
		}),
		removeListener: mock((handle: { _id: number }) => {
			events.delete(handle._id);
		}),
		subscribe: mock((ids: string[], options: { kind: "activity" }) => ({
			_id: ++seq,
			_narratorIds: ids,
			_kind: options.kind,
		})),
		unsubscribe: mock(() => {}),
		onConnectionChange: (callback: (connected: boolean, reconnect: boolean) => void) => {
			connections.add(callback);
			return () => {
				connections.delete(callback);
			};
		},
	};
	return {
		manager,
		store: createAgentReferenceStore(manager),
		emit(data: Record<string, unknown>) {
			for (const callback of [...events.values()]) callback(data);
		},
		connection(connected: boolean) {
			for (const callback of connections) callback(connected, true);
		},
		connections,
	};
}

describe("agent reference activity store", () => {
	test("shares subscriptions across fragments and releases every resource on last unmount", () => {
		const { manager, store, connections } = fixture();
		const stopA = store.subscribe("child", () => {});
		const stopB = store.subscribe("child", () => {});
		expect(manager.subscribe).toHaveBeenCalledTimes(1);
		expect(manager.subscribe).toHaveBeenCalledWith(["child"], { kind: "activity" });
		stopA();
		expect(manager.unsubscribe).toHaveBeenCalledTimes(0);
		stopB();
		expect(manager.unsubscribe).toHaveBeenCalledTimes(1);
		expect(manager.removeListener).toHaveBeenCalledTimes(1);
		expect(connections.size).toBe(0);
		expect(store.get("child")).toEqual({ kind: "unknown" });
	});
	test("replays initial batches, status and substatus, but ignores unrelated sessions", () => {
		const { store, emit } = fixture();
		const notify = mock(() => {});
		store.subscribe("child", notify);
		emit({
			type: "list_state_snapshot",
			items: [
				{ narratorId: "other", status: "idle" },
				{ narratorId: "child", status: "working", substatus: ["reasoning"] },
			],
		});
		expect(store.get("child")).toEqual({
			kind: "ready",
			status: "working",
			substatus: ["reasoning"],
		});
		emit({ type: "substatus_change", narratorId: "child", substatus: ["planning", 1] });
		expect(store.get("child")).toEqual({
			kind: "ready",
			status: "working",
			substatus: ["planning"],
		});
		emit({ type: "status_change", narratorId: "other", status: "archived" });
		expect(notify).toHaveBeenCalledTimes(2);
		emit({ type: "status_change", narratorId: "child", status: "idle", substatus: ["unread"] });
		expect(store.get("child")).toEqual({ kind: "ready", status: "idle", substatus: ["unread"] });
	});
	test("denial clears metadata and ignores late snapshots until reauthorization", () => {
		const { store, emit, manager, connection } = fixture();
		store.subscribe("child", () => {});
		emit({ type: "status_change", narratorId: "child", status: "working" });
		emit({ type: "subscribe_denied", narratorId: "child" });
		emit({ type: "list_state_snapshot", items: [{ narratorId: "child", status: "idle" }] });
		expect(store.get("child")).toEqual({ kind: "unavailable" });
		emit({ type: "narrator_access_changed" });
		expect(store.get("child")).toEqual({ kind: "unknown" });
		expect(manager.subscribe).toHaveBeenCalledTimes(2);
		emit({ type: "status_change", narratorId: "child", status: "working" });
		connection(false);
		expect(store.get("child")).toEqual({ kind: "unknown" });
		connection(true);
		emit({ type: "list_state_snapshot", items: [{ narratorId: "child", status: "waiting" }] });
		expect(store.get("child")).toEqual({ kind: "ready", status: "waiting", substatus: [] });
	});
	test("caps unique visible subscriptions, not the number of fragments", () => {
		const { manager, store } = fixture();
		const stops = Array.from({ length: 70 }, (_, i) => store.subscribe(`child-${i}`, () => {}));
		expect(manager.subscribe).toHaveBeenCalledTimes(64);
		store.subscribe("child-0", () => {});
		expect(manager.subscribe).toHaveBeenCalledTimes(64);
		expect(store.get("child-69")).toEqual({ kind: "unknown" });
		for (const stop of stops) stop();
	});
});
