import { describe, expect, it } from "bun:test";
import { type InsertCandidate, insertLoadedMessage } from "./vlist-message-insert";

function msg(id: string, seq: number, extra: Partial<InsertCandidate> = {}): InsertCandidate {
	return { id, seq, ...extra };
}

const loaded = [msg("m1", 1), msg("m2", 2), msg("m3", 3), msg("m4", 4)];

describe("insertLoadedMessage — placing a mid-window structural marker", () => {
	it("inserts at the first loaded row whose seq is >= the marker's", () => {
		const marker = msg("c-mid", 3);
		const result = insertLoadedMessage(loaded, marker);
		expect(result.inserted).toBe(true);
		expect(result.messages.map((entry) => entry.id)).toEqual(["m1", "m2", "c-mid", "m3", "m4"]);
	});

	it("places a segment marker immediately BEFORE its first compressed row", () => {
		// The server persists the marker AT the compressed run's first seq and shifts
		// every following ref up by one. Locally that shift has not happened, so the
		// marker's seq EQUALS that row's — and `>=` puts the marker right before the
		// run it will replace, exactly where the server has it.
		const marker = msg("seg", 2);
		const result = insertLoadedMessage(loaded, marker);
		expect(result.inserted).toBe(true);
		expect(result.messages.map((entry) => entry.id)).toEqual(["m1", "seg", "m2", "m3", "m4"]);
	});

	it("does NOT shift the following seqs (the drift is unobservable; see the module)", () => {
		const result = insertLoadedMessage(loaded, msg("seg", 2));
		expect(result.inserted).toBe(true);
		expect(result.messages.map((entry) => entry.seq)).toEqual([1, 2, 2, 3, 4]);
	});

	it("returns a new array and leaves the input untouched", () => {
		const result = insertLoadedMessage(loaded, msg("seg", 2));
		expect(result.messages).not.toBe(loaded);
		expect(loaded.map((entry) => entry.id)).toEqual(["m1", "m2", "m3", "m4"]);
	});

	it("rejects a duplicate broadcast (catch-up replays the same marker)", () => {
		const result = insertLoadedMessage(loaded, msg("m2", 2));
		expect(result.inserted).toBe(false);
		expect(result.reason).toBe("duplicate");
		expect(result.messages).toBe(loaded);
	});

	it("rejects a marker with no usable id (cannot de-duplicate)", () => {
		expect(insertLoadedMessage(loaded, msg("", 2)).reason).toBe("no-id");
	});

	it("rejects a marker with no seq (position unknown)", () => {
		expect(insertLoadedMessage(loaded, { id: "x" }).reason).toBe("no-seq");
	});

	it("rejects a marker newer than the loaded tail — that is the append path's job", () => {
		// Declined here so the caller does not confuse "insert declined" with
		// "append declined": both fall through to the reload, which is correct for
		// whatever the append path also refused.
		const result = insertLoadedMessage(loaded, msg("c-tail", 9));
		expect(result.inserted).toBe(false);
		expect(result.reason).toBe("not-mid-window");
		expect(result.messages).toBe(loaded);
	});

	it("rejects when no loaded row carries a seq to place the marker against", () => {
		const messy: InsertCandidate[] = [{ id: "a" }, { id: "b" }];
		expect(insertLoadedMessage(messy, msg("seg", 1)).reason).toBe("not-mid-window");
	});

	it("tolerates seq-less loaded rows while finding the insert point", () => {
		const messy: InsertCandidate[] = [msg("a", 1), { id: "b" }, msg("c", 5)];
		const result = insertLoadedMessage(messy, msg("seg", 3));
		expect(result.inserted).toBe(true);
		expect(result.messages.map((entry) => entry.id)).toEqual(["a", "b", "seg", "c"]);
	});
});
