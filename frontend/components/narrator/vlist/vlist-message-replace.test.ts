import { describe, expect, it } from "bun:test";
import { type ReplaceCandidate, replaceLoadedMessage } from "./vlist-message-replace";

function block(type: string, text: string, extra: Record<string, unknown> = {}) {
	return { type, text, ...extra };
}

function msg(id: string, blocks: unknown[]): ReplaceCandidate {
	return { id, contentJson: blocks };
}

const target = msg("m2", [
	block("text", "kept"),
	block("tool_use", "", { id: "tu1", name: "Edit" }),
	block("text", "rolled back"),
]);
const loaded = [msg("m1", [block("text", "before")]), target, msg("m3", [block("text", "after")])];

describe("replaceLoadedMessage — only a trailing truncation may land in place", () => {
	it("replaces a copy-on-write row by oldMessageId without duplicating it", () => {
		const result = replaceLoadedMessage(
			loaded,
			msg("m2-new", [block("text", "rewritten with different wrapping")]),
			{ oldMessageId: "m2" },
		);
		expect(result.replaced).toBe(true);
		expect(result.messages.map((item) => item.id)).toEqual(["m1", "m2-new", "m3"]);
	});

	it("accepts dropping trailing blocks, which is what a rollback does", () => {
		const result = replaceLoadedMessage(loaded, msg("m2", [block("text", "kept")]));
		expect(result.replaced).toBe(true);
		expect(result.messages[1]?.contentJson).toHaveLength(1);
		// The untouched neighbours keep their identity so their measurements are reused.
		expect(result.messages[0]).toBe(loaded[0]);
		expect(result.messages[2]).toBe(loaded[2]);
	});

	it("accepts a truncation that keeps a tool_use block intact", () => {
		const result = replaceLoadedMessage(
			loaded,
			msg("m2", [block("text", "kept"), block("tool_use", "", { id: "tu1", name: "Edit" })]),
		);
		expect(result.replaced).toBe(true);
		expect(result.messages[1]?.contentJson).toHaveLength(2);
	});

	it("rejects an edit that rewrites a surviving block's text", () => {
		// The block keeps its `-b0` key while its content changed, and messageVersion
		// is deliberately not bumped — so accepting this would render the new text at
		// the height measured from the old text.
		const result = replaceLoadedMessage(loaded, msg("m2", [block("text", "rewritten")]));
		expect(result.replaced).toBe(false);
		expect(result.reason).toBe("not-a-truncation");
	});

	it("rejects an edit that changes a surviving tool block's status", () => {
		const result = replaceLoadedMessage(
			loaded,
			msg("m2", [
				block("text", "kept"),
				block("tool_use", "", { id: "tu1", name: "Edit", status: "error" }),
			]),
		);
		expect(result.replaced).toBe(false);
		expect(result.reason).toBe("not-a-truncation");
	});

	it("rejects a same-length update (an edit, not a truncation)", () => {
		const result = replaceLoadedMessage(
			loaded,
			msg("m2", [
				block("text", "kept"),
				block("tool_use", "", { id: "tu1", name: "Edit" }),
				block("text", "changed"),
			]),
		);
		expect(result.reason).toBe("not-a-truncation");
	});

	it("rejects a longer update (an append the reload path places)", () => {
		const result = replaceLoadedMessage(
			loaded,
			msg("m2", [
				block("text", "kept"),
				block("tool_use", "", { id: "tu1", name: "Edit" }),
				block("text", "rolled back"),
				block("text", "extra"),
			]),
		);
		expect(result.reason).toBe("not-a-truncation");
	});

	it("rejects removing a MIDDLE block (surviving keys would shift)", () => {
		// Shorter, but not a prefix: `-b1` would now denote what used to be `-b2`.
		const result = replaceLoadedMessage(
			loaded,
			msg("m2", [block("text", "kept"), block("text", "rolled back")]),
		);
		expect(result.replaced).toBe(false);
		expect(result.reason).toBe("not-a-truncation");
	});

	it("rejects emptying the block list", () => {
		expect(replaceLoadedMessage(loaded, msg("m2", [])).reason).toBe("not-a-truncation");
	});

	it("rejects a message that is not loaded", () => {
		expect(replaceLoadedMessage(loaded, msg("m9", [block("text", "x")])).reason).toBe("not-loaded");
	});

	it("rejects a message with no usable id", () => {
		expect(replaceLoadedMessage(loaded, { contentJson: [] }).reason).toBe("no-id");
		expect(replaceLoadedMessage(loaded, { id: "", contentJson: [] }).reason).toBe("no-id");
	});

	it("rejects a non-array payload on either side", () => {
		expect(replaceLoadedMessage(loaded, { id: "m2", contentJson: null }).reason).toBe(
			"not-a-truncation",
		);
		const messyLoaded = [{ id: "m2", contentJson: "not an array" }];
		expect(replaceLoadedMessage(messyLoaded, msg("m2", [block("text", "a")])).reason).toBe(
			"not-a-truncation",
		);
	});

	it("returns the SAME array whenever nothing changed", () => {
		// Identity is load-bearing: the coordinator skips its rebuild on it, so a
		// rejected update must not cost a full re-measure.
		expect(replaceLoadedMessage(loaded, msg("m9", [])).messages).toBe(loaded);
		expect(replaceLoadedMessage(loaded, msg("m2", [block("text", "rewritten")])).messages).toBe(
			loaded,
		);
	});
});
