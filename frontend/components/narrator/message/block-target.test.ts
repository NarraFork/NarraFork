import { describe, expect, test } from "bun:test";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import type { TreeMessage } from "../../../lib/api/types";
import { decodeBlockPage } from "../../../lib/block-protocol";
import { blockTargetOf, inputBlockIdOf } from "./block-target";

const envelope = (id: string, role: string, blockIds: string[]) => ({
	id,
	narratorId: "n1",
	role,
	parentToolUseId: null,
	contentText: null,
	blockIds,
	parentMessageId: null,
});
const block = (id: string, messageId: string, kind: string, elements: unknown[]) => ({
	id,
	messageId,
	ordinal: 0,
	kind,
	subtype: null,
	phase: "done",
	revision: 1,
	wireId: kind === "tool" ? "call_1" : null,
	attemptId: null,
	elements,
	hasOriginal: false,
});

/** Rows from a block-protocol page: an input, then a reasoning run, a tool and a text. */
function listOfPage() {
	const { messages } = decodeBlockPage({
		protocol: 2,
		messages: [envelope("in1", "user", ["bIn"]), envelope("st1", "assistant", ["bR", "bT", "bX"])],
		blocks: [
			block("bIn", "in1", "input", [{ type: "text", text: "go" }]),
			block("bR", "st1", "reasoning", [
				{ type: "reasoning", text: "a" },
				{ type: "reasoning", text: "b" },
			]),
			block("bT", "st1", "tool", [{ type: "tool_use", id: "call_1", name: "Bash", input: {} }]),
			block("bX", "st1", "output", [{ type: "text", text: "done" }]),
		],
	}) as unknown as { messages: TreeMessage[] };
	const byId = new Map(messages.map((message) => [message.id, message]));
	return { messageOf: (id: string) => byId.get(id) };
}

describe("block targets", () => {
	test("an element of a named row names the block holding it", () => {
		const list = listOfPage();
		expect(blockTargetOf(list, "st1", 1)).toEqual({
			messageId: "st1",
			blockIndex: 1,
			blockId: "bR",
		});
		expect(blockTargetOf(list, "st1", 2)?.blockId).toBe("bT");
		expect(inputBlockIdOf(list, "in1")).toBe("bIn");
		expect(inputBlockIdOf(list, "st1")).toBeUndefined();
	});

	test("a client-built row, an unknown element or an unloaded message names no block", () => {
		const row: TreeMessage = rowWithElements(
			{
				id: "u1",
				narratorId: "n1",
				role: "user",
			},
			[{ type: "text", text: "hi" }],
		) as TreeMessage;
		const list = { messageOf: (id: string) => (id === "u1" ? row : undefined) };
		expect(blockTargetOf(list, "u1", 0)).toBeNull();
		expect(inputBlockIdOf(list, "u1")).toBeUndefined();
		expect(blockTargetOf(listOfPage(), "st1", 9)).toBeNull();
		expect(blockTargetOf(null, "st1", 0)).toBeNull();
	});
});
