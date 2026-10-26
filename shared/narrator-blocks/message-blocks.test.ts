import { describe, expect, test } from "bun:test";
import {
	type BlockSourceMessage,
	blockAtIndex,
	filterRowElements,
	mapRowElements,
	messageBlocks,
	messageBody,
	type RowBlock,
	rowWithElements,
} from "./message-blocks";

type ContentBlock = Record<string, unknown>;
type Row = BlockSourceMessage<ContentBlock>;

function row(overrides: Partial<Row>): Row {
	return {
		id: "m1",
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentText: null,
		...overrides,
	};
}

const named = (id: string, kind: string, elements: ContentBlock[]): RowBlock<ContentBlock> => ({
	id,
	kind,
	subtype: null,
	phase: "done",
	revision: 3,
	wireId: null,
	attemptId: "a1",
	hasOriginal: false,
	named: true,
	elements,
});

const think = { type: "reasoning", text: "think" };
const hello = { type: "text", text: "hello" };

describe("messageBlocks", () => {
	test("a row from the block protocol is its named blocks, placed over its body", () => {
		const message = row({
			blocks: [named("b1", "reasoning", [think]), named("b2", "output", [hello])],
		});
		const blocks = messageBlocks(message);
		expect(blocks.map((block) => [block.id, block.kind, block.revision, block.from])).toEqual([
			["b1", "reasoning", 3, 0],
			["b2", "output", 3, 1],
		]);
		expect(blocks[1].elements).toEqual([hello]);
		expect(messageBody(message)).toEqual([think, hello]);
	});

	test("a client-built row is split as the server splits a legacy envelope", () => {
		const assistant = rowWithElements(row({}), [
			think,
			hello,
			{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a" } },
		]);
		expect(messageBlocks(assistant).map((block) => [block.id, block.kind, block.wireId])).toEqual([
			["m1:0", "reasoning", null],
			["m1:1", "output", null],
			["m1:2", "tool", "toolu_1"],
		]);
		expect(messageBlocks(assistant).every((block) => !block.named)).toBe(true);
		// An injection and its legacy companion text are one context block.
		const injection = rowWithElements(row({ id: "s1", role: "sys" }), [
			{ type: "text", text: "legacy" },
			{ type: "sidecar", source: "spec_update" },
		]);
		const [context] = messageBlocks(injection);
		expect(messageBlocks(injection)).toHaveLength(1);
		expect(context).toMatchObject({ kind: "context", subtype: "system_injection", from: 0 });
		expect(context.elements).toHaveLength(2);
		// System-written user turns are context; human turns are input.
		const continued = row({ id: "u1", role: "user", origin: "system" });
		const text = [{ type: "text", text: "continue" }];
		expect(messageBlocks(rowWithElements(continued, text))[0]).toMatchObject({ kind: "context" });
		expect(messageBlocks(rowWithElements({ ...continued, origin: "user" }, text))[0]).toMatchObject(
			{ kind: "input" },
		);
	});

	test("a row without blocks has no body", () => {
		const bare = row({});
		expect(messageBlocks(bare)).toEqual([]);
		expect(messageBody(bare)).toEqual([]);
		expect(mapRowElements(bare, (element) => ({ ...element, seen: true }))).toBe(bare);
		expect(filterRowElements(bare, () => false)).toBe(bare);
	});

	test("the same blocks give the same arrays", () => {
		const blocks = [named("b1", "reasoning", [think]), named("b2", "output", [hello])];
		const first = row({ blocks });
		expect(messageBlocks(first)).toBe(messageBlocks({ ...first }));
		expect(messageBody(first)).toBe(messageBody({ ...first }));
		expect(messageBlocks({ ...first, blocks: [...blocks] })).not.toBe(messageBlocks(first));
		expect(messageBlocks(row({ blocks: [] }))).toEqual([]);
		expect(messageBody(row({}))).toEqual([]);
	});

	test("blockAtIndex names the block holding an element", () => {
		const message = row({
			blocks: [named("b1", "reasoning", [think]), named("b2", "output", [hello])],
		});
		expect(blockAtIndex(message, 1)?.id).toBe("b2");
		expect(blockAtIndex(message, 2)).toBeUndefined();
	});
});

describe("rewriting a row's body", () => {
	const tool = { type: "tool_use", id: "t1", status: "running" };
	const source = () =>
		row({
			blocks: [
				named("b1", "output", [hello]),
				named("b2", "tool", [tool]),
				named("b3", "output", [{ type: "text", text: "bye" }]),
			],
		});

	test("mapRowElements keeps each block's identity and every unchanged block", () => {
		const message = source();
		const mapped = mapRowElements(message, (element, index) =>
			element.type === "tool_use" ? { ...element, status: "success", index } : element,
		);
		expect(mapped.blocks?.map((block) => block.id)).toEqual(["b1", "b2", "b3"]);
		expect(mapped.blocks?.[0]).toBe(message.blocks?.[0]);
		expect(mapped.blocks?.[2]).toBe(message.blocks?.[2]);
		expect(mapped.blocks?.[1]).toMatchObject({ id: "b2", named: true, revision: 3 });
		expect(messageBody(mapped)[1]).toEqual({ ...tool, status: "success", index: 1 });
		expect(mapRowElements(message, (element) => element)).toBe(message);
	});

	test("filterRowElements drops emptied blocks and keeps the rest", () => {
		const message = source();
		const filtered = filterRowElements(message, (element) => element.type !== "tool_use");
		expect(filtered.blocks?.map((block) => block.id)).toEqual(["b1", "b3"]);
		expect(filtered.blocks?.[0]).toBe(message.blocks?.[0]);
		expect(filterRowElements(message, () => true)).toBe(message);
	});

	test("filterRowElements drops a block left empty and keeps the others' identity", () => {
		const message = source();
		const filtered = filterRowElements(message, (_element, index) => index !== 0);
		expect(filtered.blocks?.map((block) => block.id)).toEqual(["b2", "b3"]);
		expect(filtered.blocks?.[1]).toBe(message.blocks?.[2]);
	});
});
