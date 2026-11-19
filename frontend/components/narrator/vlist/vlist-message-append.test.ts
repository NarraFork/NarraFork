import { describe, expect, it } from "bun:test";
import { messageBody, rowWithElements } from "@shared/narrator-blocks/message-blocks";
import {
	type AppendCandidate,
	appendLoadedMessage,
	resolveMessageAppend,
	upsertLoadedMessage,
} from "./vlist-message-append";

/** A row; a body in `extra` is split again as this row's, as the server would. */
function msg(id: string, seq: number, extra: Partial<AppendCandidate> = {}): AppendCandidate {
	const { blocks, ...rest } = extra;
	return rowWithElements(
		{
			id,
			seq,
			role: "assistant",
			parentToolUseId: null,
			...rest,
		},
		blocks ? messageBody({ blocks }) : [{ type: "text", text: "hello" }],
	);
}

const loaded = [msg("m1", 1), msg("m2", 2), msg("m3", 3)];

function decide(message: AppendCandidate, isSubagent = false) {
	return resolveMessageAppend({ message, loaded, isSubagent });
}

describe("reasoning state on full-message upserts", () => {
	it("keeps the persistent reasoning body revision when a delayed checkpoint is older", () => {
		const previous = msg(
			"m",
			1,
			rowWithElements({}, [
				{ type: "reasoning", id: "e", revision: 4, text: "abcdef", translationGeneration: "g" },
			]),
		);
		const incoming = msg(
			"m",
			1,
			rowWithElements({}, [
				{ type: "reasoning", id: "e", revision: 3, text: "abc", translationGeneration: "g" },
			]),
		);
		if (!previous.blocks?.[0] || !incoming.blocks?.[0]) throw new Error("fixture has no block");
		previous.blocks[0].id = "persistent";
		previous.blocks[0].revision = 2;
		previous.blocks[0].named = true;
		incoming.blocks[0].id = "persistent";
		incoming.blocks[0].revision = 1;
		incoming.blocks[0].named = true;
		const result = upsertLoadedMessage([previous], incoming, false);
		expect(result.messages[0].blocks?.[0]).toBe(previous.blocks[0]);
		expect(messageBody(result.messages[0])).toEqual(messageBody(previous));
	});

	it("keeps REST translations when an older identical persistent checkpoint omits state", () => {
		const valid = {
			id: "p",
			generation: "g",
			start: 0,
			end: 3,
			sourceText: "abc",
			translatedText: "甲",
		};
		const element = { type: "reasoning", id: "e", revision: 2, text: "abcdef" };
		const checkpoint = (
			stateRevision: number | undefined,
			extra = {},
			blockId = "b",
			bodyRevision = 2,
		) => {
			const result = msg("m", 1, {
				stateRevision,
				...rowWithElements({}, [{ ...element, ...extra }]),
			});
			if (!result.blocks?.[0]) throw new Error("fixture has no block");
			result.blocks[0].id = blockId;
			result.blocks[0].revision = bodyRevision;
			result.blocks[0].named = true;
			return result;
		};
		// This state came only from REST, so no completed-part patch store can replay it.
		const previous = checkpoint(9, {
			translationGeneration: "g",
			translationParts: [valid, { ...valid, id: "invalid", start: 3, end: 6, sourceText: "bad" }],
		});
		const late = checkpoint(4);
		const result = upsertLoadedMessage([previous], late, false);
		expect(messageBody(result.messages[0])[0]).toEqual({
			...element,
			translationGeneration: "g",
			translationParts: [valid],
		});
		expect(result.messages[0].stateRevision).toBe(9);
		expect(result.messages[0].blocks?.[0].revision).toBe(2);
		expect(messageBody(late)[0]).toEqual(element);
		for (const incoming of [
			checkpoint(4, { text: "changed" }),
			checkpoint(4, { translationGeneration: "different" }),
			checkpoint(4, {}, "other-block"),
			checkpoint(4, { id: "other-element" }),
			checkpoint(4, {}, "b", 3),
			checkpoint(9),
			checkpoint(10),
			checkpoint(undefined),
		]) {
			const unchanged = messageBody(
				upsertLoadedMessage([previous], incoming, false).messages[0],
			)[0];
			expect(unchanged).not.toHaveProperty("translationParts");
			expect(unchanged).toEqual(messageBody(incoming)[0]);
		}
	});

	it("retains independently completed parts through a late same-body checkpoint", () => {
		const part = {
			id: "p",
			generation: "g",
			start: 0,
			end: 3,
			sourceText: "abc",
			translatedText: "甲",
		};
		const reasoning = {
			type: "reasoning",
			id: "e",
			revision: 2,
			text: "abcdef",
			translationGeneration: "g",
		};
		const previous = msg("m", 1, {
			stateRevision: 9,
			...rowWithElements({}, [{ ...reasoning, translationParts: [part] }]),
		});
		const incoming = msg("m", 1, { stateRevision: 4, ...rowWithElements({}, [reasoning]) });
		const result = upsertLoadedMessage([previous], incoming, false);
		expect(messageBody(result.messages[0])[0]).toEqual({ ...reasoning, translationParts: [part] });
		expect(result.messages[0].stateRevision).toBe(9);
		expect(messageBody(incoming)[0]).toEqual(reasoning);
		const rewritten = msg("m", 1, {
			stateRevision: 10,
			...rowWithElements({}, [{ ...reasoning, revision: 3, translationGeneration: "new" }]),
		});
		expect(
			messageBody(upsertLoadedMessage(result.messages, rewritten, false).messages[0])[0],
		).toEqual({ ...reasoning, revision: 3, translationGeneration: "new" });
	});
});

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
			expect(decide(msg(`s-${type}`, 9, rowWithElements({}, [{ type }])))).toEqual({
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
			decide(msg("c-tail", 9, rowWithElements({}, [{ type: "compact", status: "compacting" }]))),
		).toEqual({ append: true });
	});

	it("still declines a compact marker that lands mid-window (the insert path's job)", () => {
		// A segment compact marker is persisted at the seq of the FIRST message it
		// compresses, so it is never newer than the loaded tail while that segment is
		// loaded. The caller routes this to the in-place insert, not the reload.
		expect(
			decide(
				msg("c-mid", 2, rowWithElements({}, [{ type: "segment_compact", status: "compacting" }])),
			),
		).toEqual({ append: false, reason: "not-tail" });
		expect(
			decide(msg("c-mid", 2, rowWithElements({}, [{ type: "compact", status: "compacting" }]))),
		).toEqual({ append: false, reason: "not-tail" });
	});

	it("still appends a normal message that merely contains a tool_use block", () => {
		expect(
			decide(msg("m4", 4, rowWithElements({}, [{ type: "tool_use", id: "t1", name: "Bash" }]))),
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

describe("upsertLoadedMessage", () => {
	it("replaces a same-id row so delivery state is not dropped", () => {
		const next = msg("m2", 2, { deliveryState: "materialized" });
		const result = upsertLoadedMessage(loaded, next, false);
		expect(result.changed).toBe(true);
		expect(result.appended).toBe(false);
		expect(result.messages).toHaveLength(3);
		expect(result.messages[1]).toMatchObject(next);
		expect(result.messages[1]).not.toBe(loaded[1]);
	});

	it("does not add a second row when a catch-up payload repeats id + seq", () => {
		const result = upsertLoadedMessage(loaded, msg("m2", 2), false);
		expect(result.messages).toHaveLength(3);
		expect(result.changed).toBe(true);
		expect(result.messages.filter((entry) => entry.id === "m2")).toHaveLength(1);
	});

	it("appends a new tail row and rejects a conflicting occupied seq", () => {
		expect(upsertLoadedMessage(loaded, msg("m4", 4), false).appended).toBe(true);
		const conflict = upsertLoadedMessage(loaded, msg("other", 2), false);
		expect(conflict.changed).toBe(false);
		expect(conflict.reason).toBe("duplicate");
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
