import { describe, expect, test } from "bun:test";
import { NarratorWSManager } from "./narrator-ws-manager";

type Frame = Record<string, unknown>;
function route(manager: NarratorWSManager, frame: Frame) {
	(manager as unknown as { _dispatchImmediate(frame: Frame): void })._dispatchImmediate(frame);
}
function state(revision: number, status = "working", type = "status_change"): Frame {
	return {
		type,
		narratorId: "n1",
		statusEpoch: "server-epoch",
		statusRevision: revision,
		status,
		substatus: [],
		turnStartedAt: null,
		updatedAt: "2026-11-24T15:00:00.000Z",
		errorMessage: null,
		errorRetryable: null,
		archivedWithNarratorId: null,
	};
}

describe("committed narrator state version ordering", () => {
	test("a delayed idle patch cannot roll back a newer working state, including equal timestamps", () => {
		const manager = new NarratorWSManager();
		const seen: Frame[] = [];
		manager.addListener({ narratorIds: ["n1"] }, (frame) => seen.push(frame));
		route(manager, state(2, "working"));
		route(manager, state(1, "idle"));
		expect(seen.map((frame) => frame.status)).toEqual(["working"]);
		expect(manager.isStatusVersionStale("n1", state(1))).toBe(true);
	});

	test("newer full substatus projections preserve the committed main state when a delayed status frame is rejected", () => {
		const manager = new NarratorWSManager();
		const seen: Frame[] = [];
		manager.addListener({ narratorIds: ["n1"] }, (frame) => seen.push(frame));
		route(manager, { ...state(3, "idle", "substatus_change"), substatus: ["unread"] });
		route(manager, state(2, "idle"));
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ status: "idle", substatus: ["unread"], statusRevision: 3 });
	});

	test("one listener's newer snapshot never suppresses a live update needed by its sibling", () => {
		const manager = new NarratorWSManager();
		const a = manager.subscribe(["n1"], { kind: "panel" });
		const b = manager.subscribe(["n1"], { kind: "panel" });
		const seenA: number[] = [];
		const seenB: number[] = [];
		manager.addListener({ narratorIds: ["n1"], subscriptionId: a._id }, (frame) =>
			seenA.push(frame.statusRevision as number),
		);
		manager.addListener({ narratorIds: ["n1"], subscriptionId: b._id }, (frame) =>
			seenB.push(frame.statusRevision as number),
		);
		const request = (
			manager as unknown as { _registerRequest(handle: typeof a): string }
		)._registerRequest(a);
		route(manager, { ...state(5), subscriptionRequestId: request });
		route(manager, state(4));
		expect(seenA).toEqual([5]);
		expect(seenB).toEqual([4]);
		route(manager, state(6));
		expect(seenA).toEqual([5, 6]);
		expect(seenB).toEqual([4, 6]);
		manager.unsubscribe(a);
		manager.unsubscribe(b);
	});

	test("unknown request snapshots cannot establish an epoch or block the next live event", () => {
		const manager = new NarratorWSManager();
		const seen: Frame[] = [];
		manager.addListener({ narratorIds: ["n1"] }, (frame) => seen.push(frame));
		route(manager, {
			...state(100),
			statusEpoch: "abandoned-epoch",
			subscriptionRequestId: "unknown-request",
		});
		route(manager, state(1));
		expect(seen).toEqual([state(1)]);
	});

	test("version watermarks reset on a new connection without discarding legacy sparse producers", () => {
		const manager = new NarratorWSManager();
		const seen: Frame[] = [];
		manager.addListener({ narratorIds: ["n1"] }, (frame) => seen.push(frame));
		route(manager, state(20));
		(manager as unknown as { _clearStatusVersionState(): void })._clearStatusVersionState();
		route(manager, { ...state(1), statusEpoch: "new-server" });
		route(manager, { type: "status_change", narratorId: "n1", status: "idle" });
		expect(seen.map((frame) => frame.statusRevision)).toEqual([20, 1, undefined]);
	});
});
