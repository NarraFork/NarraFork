import { describe, expect, it } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { syncAskInPassingMessage } from "./vlist-ask-in-passing-sync";

const row = (id: string, seq: number) => ({ id, seq, contentJson: [] }) as unknown as TreeMessage;
const card = (id = "ask", status = "pending", askInsertVersion = 8) =>
	({
		...row(id, 2),
		askInsertVersion,
		contentJson: [{ type: "ask_in_passing", status, sourceMessageId: "source" }],
	}) as unknown as TreeMessage;
const base = [row("source", 1), row("next", 2), row("tail", 3)];
function sync(loaded: readonly TreeMessage[], message: TreeMessage, version?: number) {
	const result = syncAskInPassingMessage(loaded, message, version);
	if (!result) throw new Error("Expected safe insertion");
	return result;
}

describe("ask canonical synchronization", () => {
	it("inserts after source and shifts following seq exactly once", () => {
		const first = sync(base, card(), 7);
		expect(first.messages.map((m) => [m.id, m.seq])).toEqual([
			["source", 1],
			["ask", 2],
			["next", 3],
			["tail", 4],
		]);
		const duplicate = sync(first.messages, card());
		expect(duplicate.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
		expect(base.map((m) => m.seq)).toEqual([1, 2, 3]);
	});
	it("consecutive ordered versions preserve seq and stale HTTP does not undo shifts", () => {
		const first = sync(base, card(), 7);
		const second = sync(first.messages, card("second", "pending", 9), 8);
		const replay = sync(second.messages, card(), 9);
		expect(replay.messages.map((m) => [m.id, m.seq])).toEqual([
			["source", 1],
			["second", 2],
			["ask", 3],
			["next", 4],
			["tail", 5],
		]);
	});
	it("rejects B-before-A delivery rather than guessing arrival order", () => {
		expect(syncAskInPassingMessage(base, card("second", "pending", 9), 7)).toBeUndefined();
		const canonical = [
			row("source", 1),
			card("second", "pending", 9),
			{ ...card(), seq: 3 },
			row("next", 4),
		];
		expect(sync(canonical, card(), 9).messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
	});
	it("does not regress resolved to pending", () => {
		const first = sync(base, card(), 7);
		const resolved = sync(first.messages, card("ask", "resolved"));
		const pending = sync(resolved.messages, card());
		expect(pending.changed).toBe(false);
		expect(pending.messages).toBe(resolved.messages);
	});
	it("rejects unversioned, stale, mismatched-seq and unknown-source projections", () => {
		expect(syncAskInPassingMessage(base, card())).toBeUndefined();
		expect(syncAskInPassingMessage(base, card(), 8)).toBeUndefined();
		expect(syncAskInPassingMessage(base, { ...card(), seq: 5 }, 7)).toBeUndefined();
		expect(syncAskInPassingMessage([row("other", 1)], card(), 7)).toBeUndefined();
	});
	it("version proof shifts even with seq holes caused by deletion", () => {
		const gap = [row("source", 1), row("next", 3)];
		expect(sync(gap, card(), 7).messages.map((m) => m.seq)).toEqual([1, 2, 4]);
	});
});
