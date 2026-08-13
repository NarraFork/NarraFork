import { describe, expect, it } from "bun:test";
import { type RemoveCandidate, removeLoadedMessages } from "./vlist-message-remove";

function msg(id: string): RemoveCandidate {
	return { id };
}

const loaded = [msg("m1"), msg("m2"), msg("m3")];

describe("removeLoadedMessages — what may be dropped in place", () => {
	it("drops a single loaded message", () => {
		const result = removeLoadedMessages(loaded, ["m2"]);
		expect(result.removed).toBe(true);
		expect(result.messages.map((m) => m.id)).toEqual(["m1", "m3"]);
	});

	it("drops a tail range, which is what a rollback deletes", () => {
		const result = removeLoadedMessages(loaded, ["m2", "m3"]);
		expect(result.removed).toBe(true);
		expect(result.messages.map((m) => m.id)).toEqual(["m1"]);
	});

	it("drops the ids it recognises and ignores the rest", () => {
		// The server deletes by ref across the whole narrator, so an event routinely
		// names messages older than the loaded window. Those are simply not present.
		const result = removeLoadedMessages(loaded, ["m0", "m3", "m99"]);
		expect(result.removed).toBe(true);
		expect(result.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
	});

	it("leaves the document untouched when no id is loaded", () => {
		// Not a failure to apply: there is no row on screen for these, and — the point
		// of this branch — no reason to refetch either.
		const result = removeLoadedMessages(loaded, ["nope", "also-nope"]);
		expect(result.removed).toBe(false);
		expect(result.reason).toBe("not-loaded");
	});

	it("refuses to empty the document, handing that to the reload path", () => {
		// An empty document has its own load path (the shell's hasIndex branch); the
		// removal channel must not be the thing that produces it.
		const result = removeLoadedMessages(loaded, ["m1", "m2", "m3"]);
		expect(result.removed).toBe(false);
		expect(result.reason).toBe("empty-result");
	});

	it("rejects an event carrying no usable id", () => {
		expect(removeLoadedMessages(loaded, []).reason).toBe("no-ids");
		expect(removeLoadedMessages(loaded, ["", ""]).reason).toBe("no-ids");
	});

	it("returns the SAME array whenever nothing changed", () => {
		// The coordinator skips its rebuild by identity, so this is load-bearing:
		// a fresh array with equal contents would cost a full re-measure per event.
		expect(removeLoadedMessages(loaded, []).messages).toBe(loaded);
		expect(removeLoadedMessages(loaded, ["nope"]).messages).toBe(loaded);
		expect(removeLoadedMessages(loaded, ["m1", "m2", "m3"]).messages).toBe(loaded);
	});

	it("tolerates messages without a usable id instead of dropping them", () => {
		// A row with no id cannot be named by a delete event, so it must survive.
		const messy = [msg("m1"), {} as RemoveCandidate, { id: null } as RemoveCandidate];
		const result = removeLoadedMessages(messy, ["m1"]);
		expect(result.removed).toBe(true);
		expect(result.messages.length).toBe(2);
	});

	it("preserves the order of the surviving messages", () => {
		const long = [msg("a"), msg("b"), msg("c"), msg("d"), msg("e")];
		const result = removeLoadedMessages(long, ["b", "d"]);
		expect(result.messages.map((m) => m.id)).toEqual(["a", "c", "e"]);
	});
});
