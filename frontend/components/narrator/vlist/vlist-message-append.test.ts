import { describe, expect, it } from "bun:test";
import {
	type AppendCandidate,
	appendLoadedMessage,
	resolveMessageAppend,
} from "./vlist-message-append";

function msg(id: string, seq: number, extra: Partial<AppendCandidate> = {}): AppendCandidate {
	return {
		id,
		seq,
		role: "assistant",
		parentToolUseId: null,
		contentJson: [{ type: "text", text: "hello" }],
		...extra,
	};
}

const loaded = [msg("m1", 1), msg("m2", 2), msg("m3", 3)];

function decide(message: AppendCandidate, isSubagent = false) {
	return resolveMessageAppend({ message, loaded, isSubagent });
}

describe("resolveMessageAppend — what may extend the loaded window", () => {
	it("appends a message newer than the loaded tail", () => {
		expect(decide(msg("m4", 4))).toEqual({ append: true });
	});

	it("appends a user message the same way (a turn starts with one)", () => {
		expect(decide(msg("m4", 4, { role: "user" }))).toEqual({ append: true });
	});

	it("rejects a duplicate broadcast (catch-up replays the same message)", () => {
		expect(decide(msg("m2", 2))).toEqual({ append: false, reason: "duplicate" });
	});

	it("rejects a message that would land inside the loaded window", () => {
		// Only the server can place a mid-window row: every following seq shifts.
		expect(decide(msg("m-mid", 2.5))).toEqual({ append: false, reason: "not-tail" });
		expect(decide(msg("m-old", 0))).toEqual({ append: false, reason: "not-tail" });
	});

	it("rejects a message with no seq (position unknown)", () => {
		expect(decide({ id: "x", role: "assistant", parentToolUseId: null })).toEqual({
			append: false,
			reason: "no-seq",
		});
	});

	it("rejects a message with no usable id (cannot de-duplicate)", () => {
		expect(decide(msg("", 9))).toEqual({ append: false, reason: "no-id" });
	});

	it("rejects a child message on a parent page, accepts it on a subagent page", () => {
		const child = msg("c1", 9, { parentToolUseId: "tool-1" });
		expect(decide(child)).toEqual({ append: false, reason: "child-message" });
		// On its own page a subagent's messages ARE the top level.
		expect(decide(child, true)).toEqual({ append: true });
	});

	it("rejects structural inserts that restructure the document", () => {
		// These land mid-history and shift every following seq, so the window must be
		// rebuilt from the server rather than extended locally.
		for (const type of ["ask_in_passing", "context_cleared"]) {
			expect(decide(msg(`s-${type}`, 9, { contentJson: [{ type }] }))).toEqual({
				append: false,
				reason: "structural",
			});
		}
	});

	it("appends a compact marker that lands at the tail", () => {
		// A tail compact marker EXTENDS the window like any other row: the "history
		// before me is compacted away" meaning belongs to the server's next load, not
		// to a reader's already-loaded window. Declining it here used to defer the
		// marker behind the reload gate until the reader scrolled back to the bottom.
		expect(
			decide(msg("c-tail", 9, { contentJson: [{ type: "compact", status: "compacting" }] })),
		).toEqual({ append: true });
	});

	it("still declines a compact marker that lands mid-window (the insert path's job)", () => {
		// A segment compact marker is persisted at the seq of the FIRST message it
		// compresses, so it is never newer than the loaded tail while that segment is
		// loaded. The caller routes this to the in-place insert, not the reload.
		expect(
			decide(msg("c-mid", 2, { contentJson: [{ type: "segment_compact", status: "compacting" }] })),
		).toEqual({ append: false, reason: "not-tail" });
		expect(
			decide(msg("c-mid", 2, { contentJson: [{ type: "compact", status: "compacting" }] })),
		).toEqual({ append: false, reason: "not-tail" });
	});

	it("still appends a normal message that merely contains a tool_use block", () => {
		expect(
			decide(msg("m4", 4, { contentJson: [{ type: "tool_use", id: "t1", name: "Bash" }] })),
		).toEqual({ append: true });
	});

	it("appends into an empty window", () => {
		expect(resolveMessageAppend({ message: msg("m1", 1), loaded: [], isSubagent: false })).toEqual({
			append: true,
		});
	});

	it("tolerates loaded rows without a seq when finding the tail", () => {
		const messy = [msg("a", 1), { id: "b", role: "assistant", parentToolUseId: null }, msg("c", 5)];
		expect(
			resolveMessageAppend({ message: msg("d", 6), loaded: messy, isSubagent: false }),
		).toEqual({ append: true });
		expect(
			resolveMessageAppend({ message: msg("d", 4), loaded: messy, isSubagent: false }),
		).toEqual({ append: false, reason: "not-tail" });
	});
});

describe("appendLoadedMessage", () => {
	it("returns a new array with the message appended", () => {
		const result = appendLoadedMessage(loaded, msg("m4", 4), false);
		expect(result.appended).toBe(true);
		expect(result.messages.map((entry) => entry.id)).toEqual(["m1", "m2", "m3", "m4"]);
	});

	it("returns the SAME array identity when it must not append", () => {
		// Identity is the caller's signal to skip the rebuild entirely.
		const result = appendLoadedMessage(loaded, msg("m2", 2), false);
		expect(result.appended).toBe(false);
		expect(result.reason).toBe("duplicate");
		expect(result.messages).toBe(loaded);
	});
});
