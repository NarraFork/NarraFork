import { afterEach, describe, expect, test } from "bun:test";
import { messageBody, rowWithElements } from "@shared/narrator-blocks/message-blocks";
import {
	buildStreamingMsg,
	clearToolBlockCache,
	type StreamingBlock,
	upsertStreamingImageGenerationBlock,
	upsertStreamingWebSearchBlock,
} from "../../frontend/components/narrator/message/message-segments";
import type { ContentBlock } from "../../frontend/lib/api";

type StreamingMsg = ReturnType<typeof buildStreamingMsg>;

function getContentBlocks(msg: StreamingMsg): readonly ContentBlock[] {
	return messageBody(msg);
}

function findContentBlock(msg: StreamingMsg, type: string): ContentBlock | undefined {
	return getContentBlocks(msg).find((block) => block.type === type);
}

function getToolUseBlocks(msg: StreamingMsg): ContentBlock[] {
	return getContentBlocks(msg).filter((block) => block.type === "tool_use");
}

// ---------------------------------------------------------------------------
// buildStreamingMsg — every block keeps its element id
// ---------------------------------------------------------------------------

describe("buildStreamingMsg — block ids", () => {
	const base = { narratorId: "n1" };

	test("a reasoning block keeps its element id", () => {
		const msg = buildStreamingMsg({
			...base,
			streamingBlocks: [
				{ type: "reasoning", id: "1:0", revision: 1, textOffset: 0, text: "thinking..." },
			],
		});
		expect(msg).not.toBeNull();
		const reasoningBlock = findContentBlock(msg, "reasoning");
		expect(reasoningBlock).toBeDefined();
		expect(reasoningBlock?.id).toBe("1:0");
	});

	test("a text block keeps its element id", () => {
		const msg = buildStreamingMsg({
			...base,
			streamingBlocks: [{ type: "text", id: "1:2", revision: 1, textOffset: 0, text: "hello" }],
		});
		expect(msg).not.toBeNull();
		const textBlock = findContentBlock(msg, "text");
		expect(textBlock).toBeDefined();
		expect(textBlock?.id).toBe("1:2");
	});

	test("reasoning and text both keep their element ids", () => {
		const msg = buildStreamingMsg({
			...base,
			streamingBlocks: [
				{ type: "reasoning", id: "1:0", revision: 1, textOffset: 0, text: "thinking..." },
				{ type: "text", id: "1:2", revision: 1, textOffset: 0, text: "hello" },
			],
		});
		expect(msg).not.toBeNull();
		const ids = getContentBlocks(msg).map((block) => block.id);
		expect(ids).toEqual(["1:0", "1:2"]);
	});

	test("web_search block keeps its original id", () => {
		const msg = buildStreamingMsg({
			...base,
			streamingBlocks: [{ type: "web_search", id: "ws-123", status: "searching", query: "test" }],
		});
		expect(msg).not.toBeNull();
		const wsBlock = findContentBlock(msg, "web_search");
		expect(wsBlock).toBeDefined();
		expect(wsBlock?.id).toBe("ws-123");
	});

	test("tool_use blocks keep their original ids from toolChunksMsg", () => {
		const toolChunksMsg = rowWithElements(
			{
				id: "__streaming_chunks__",
				narratorId: "n1",
				parentToolUseId: null,
				role: "assistant" as const,
				contentText: null,
				toolCalls: [],
				createdAt: new Date().toISOString(),
			},
			[
				{ type: "tool_use", id: "tu-1", name: "Bash", input: {} },
				{ type: "tool_use", id: "tu-2", name: "Write", input: {} },
			],
		);
		const msg = buildStreamingMsg({ ...base, toolChunksMsg });
		expect(msg).not.toBeNull();
		const toolBlocks = getToolUseBlocks(msg);
		expect(toolBlocks.map((b: ContentBlock) => b.id)).toEqual(["tu-1", "tu-2"]);
	});

	test("all block types combined: ids remain stable", () => {
		const toolChunksMsg = rowWithElements(
			{
				id: "__streaming_chunks__",
				narratorId: "n1",
				parentToolUseId: null,
				role: "assistant" as const,
				contentText: null,
				toolCalls: [],
				createdAt: new Date().toISOString(),
			},
			[{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }],
		);
		const msg = buildStreamingMsg({
			...base,
			streamingBlocks: [
				{ type: "reasoning", id: "1:0", revision: 1, textOffset: 0, text: "thinking..." },
				{ type: "web_search", id: "ws-1", status: "completed", query: "q" },
				{ type: "text", id: "1:2", revision: 1, textOffset: 0, text: "result" },
			],
			toolChunksMsg,
		});
		expect(msg).not.toBeNull();
		const ids = getContentBlocks(msg).map((block) => block.id);
		expect(ids).toEqual(["1:0", "ws-1", "1:2", "tu-1"]);
	});

	test("ids are stable across incremental streaming updates", () => {
		// Simulate the streaming sequence: reasoning → +text → +web_search → +tool
		const step1 = buildStreamingMsg({
			...base,
			streamingBlocks: [{ type: "reasoning", id: "1:0", revision: 1, textOffset: 0, text: "t" }],
		});
		const reasoningId1 = getContentBlocks(step1)[0]?.id;

		const step2 = buildStreamingMsg({
			...base,
			streamingBlocks: [
				{ type: "reasoning", id: "1:0", revision: 1, textOffset: 0, text: "thinking..." },
				{ type: "text", id: "1:2", revision: 1, textOffset: 0, text: "hel" },
			],
		});
		const reasoningId2 = findContentBlock(step2, "reasoning")?.id;
		const textId2 = findContentBlock(step2, "text")?.id;

		const step3 = buildStreamingMsg({
			...base,
			streamingBlocks: [
				{ type: "reasoning", id: "1:0", revision: 1, textOffset: 0, text: "thinking..." },
				{ type: "web_search", id: "ws-1", status: "searching" },
				{ type: "text", id: "1:2", revision: 1, textOffset: 0, text: "hello world" },
			],
		});
		const reasoningId3 = findContentBlock(step3, "reasoning")?.id;
		const textId3 = findContentBlock(step3, "text")?.id;

		// All ids should be identical across steps
		expect(reasoningId1).toBe("1:0");
		expect(reasoningId2).toBe("1:0");
		expect(reasoningId3).toBe("1:0");
		expect(textId2).toBe("1:2");
		expect(textId3).toBe("1:2");
	});

	test("temporal order is preserved: search between reasoning steps", () => {
		// Simulate: reasoning → search → reasoning (the bug scenario)
		const msg = buildStreamingMsg({
			...base,
			streamingBlocks: [
				{ type: "reasoning", id: "1:0", revision: 1, textOffset: 0, text: "initial thinking" },
				{ type: "web_search", id: "ws-1", status: "completed", query: "first search" },
				{ type: "text", id: "1:2", revision: 1, textOffset: 0, text: "result" },
			],
		});
		expect(msg).not.toBeNull();
		const types = getContentBlocks(msg).map((block) => block.type);
		expect(types).toEqual(["reasoning", "web_search", "text"]);
	});

	test("multiple web_search blocks preserve temporal order", () => {
		const msg = buildStreamingMsg({
			...base,
			streamingBlocks: [
				{ type: "reasoning", id: "1:0", revision: 1, textOffset: 0, text: "thinking about X" },
				{ type: "web_search", id: "ws-1", status: "completed", query: "search X" },
				{ type: "web_search", id: "ws-2", status: "searching", query: "search Y" },
				{ type: "text", id: "1:2", revision: 1, textOffset: 0, text: "partial..." },
			],
		});
		expect(msg).not.toBeNull();
		const types = getContentBlocks(msg).map((block) => block.type);
		expect(types).toEqual(["reasoning", "web_search", "web_search", "text"]);
		const wsIds = getContentBlocks(msg)
			.filter((block) => block.type === "web_search")
			.map((block) => block.id);
		expect(wsIds).toEqual(["ws-1", "ws-2"]);
	});
});

// ---------------------------------------------------------------------------
// Native streaming tool upserts — chunk-mode realtime rendering
// ---------------------------------------------------------------------------

describe("native streaming tool upserts", () => {
	test("web_search upsert inserts in output order and updates existing block", () => {
		const blocks: StreamingBlock[] = [
			{
				type: "reasoning",
				id: "1:0",
				revision: 1,
				textOffset: 0,
				text: "thinking",
				outputIndex: 0,
			},
			{ type: "text", id: "1:2", revision: 1, textOffset: 0, text: "answer", outputIndex: 3 },
		];

		upsertStreamingWebSearchBlock(blocks, {
			id: "ws-1",
			status: "searching",
			query: "weather",
			outputIndex: 2,
		});

		expect(blocks.map((block) => block.type)).toEqual(["reasoning", "web_search", "text"]);
		upsertStreamingWebSearchBlock(blocks, {
			id: "ws-1",
			status: "completed",
			query: "weather in sf",
		});

		const searches = blocks.filter((block) => block.type === "web_search");
		expect(searches).toHaveLength(1);
		expect(searches[0]?.status).toBe("completed");
		expect(searches[0]?.query).toBe("weather in sf");
		expect(searches[0]?.outputIndex).toBe(2);
	});

	test("image_generation upsert promotes partial preview to final saved image", () => {
		const blocks: StreamingBlock[] = [
			{ type: "text", id: "1:2", revision: 1, textOffset: 0, text: "before", outputIndex: 0 },
		];

		upsertStreamingImageGenerationBlock(blocks, {
			id: "ig-1",
			status: "generating",
			revisedPrompt: "a tiny blue square",
			partialImageIndex: 0,
			partialSavedPath: "/tmp/partial.png",
			width: 256,
			height: 256,
			outputIndex: 1,
		});
		upsertStreamingImageGenerationBlock(blocks, {
			id: "ig-1",
			status: "completed",
			savedPath: "/tmp/final.png",
			width: 512,
			height: 384,
		});

		const images = blocks.filter((block) => block.type === "image_generation");
		expect(images).toHaveLength(1);
		expect(images[0]?.status).toBe("completed");
		expect(images[0]?.revisedPrompt).toBe("a tiny blue square");
		expect(images[0]?.partialSavedPath).toBe("/tmp/partial.png");
		expect(images[0]?.savedPath).toBe("/tmp/final.png");
		expect(images[0]?.width).toBe(512);
		expect(images[0]?.height).toBe(384);
		expect(images[0]?.outputIndex).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// buildStreamingMsg — tool-use block reference stability
// ---------------------------------------------------------------------------

describe("buildStreamingMsg — tool-use block reference stability", () => {
	afterEach(() => {
		clearToolBlockCache();
	});

	test("same tool-use data returns same block object reference", () => {
		const input = { command: "ls", timeout: 5000 };
		const toolChunksMsg = rowWithElements(
			{
				id: "__streaming_tool_chunks__",
				narratorId: "n1",
				parentToolUseId: null,
				role: "assistant" as const,
				contentText: null,
				toolCalls: [],
				createdAt: new Date().toISOString(),
			},
			[{ type: "tool_use", id: "tu-1", name: "Bash", input }],
		);

		const msg1 = buildStreamingMsg({
			narratorId: "n1",
			streamingBlocks: [{ type: "text", id: "1:0", revision: 1, textOffset: 0, text: "first" }],
			toolChunksMsg,
		});
		const msg2 = buildStreamingMsg({
			narratorId: "n1",
			streamingBlocks: [{ type: "text", id: "1:0", revision: 1, textOffset: 0, text: "second" }],
			toolChunksMsg,
		});

		expect(msg1).not.toBeNull();
		expect(msg2).not.toBeNull();

		const toolBlock1 = getToolUseBlocks(msg1)[0];
		const toolBlock2 = getToolUseBlocks(msg2)[0];

		// Same object reference — not just same data
		expect(toolBlock1).toBe(toolBlock2);
	});

	test("different tool-use data returns new block object reference", () => {
		const toolChunksMsg1 = rowWithElements(
			{
				id: "__streaming_tool_chunks__",
				narratorId: "n1",
				parentToolUseId: null,
				role: "assistant" as const,
				contentText: null,
				toolCalls: [],
				createdAt: new Date().toISOString(),
			},
			[{ type: "tool_use", id: "tu-1", name: "Bash", input: { x: 1 } }],
		);
		const toolChunksMsg2 = rowWithElements(
			{
				...toolChunksMsg1,
			},
			[{ type: "tool_use", id: "tu-1", name: "Bash", input: { x: 2 } }],
		);

		const msg1 = buildStreamingMsg({ narratorId: "n1", toolChunksMsg: toolChunksMsg1 });
		const msg2 = buildStreamingMsg({ narratorId: "n1", toolChunksMsg: toolChunksMsg2 });

		const toolBlock1 = getToolUseBlocks(msg1)[0];
		const toolBlock2 = getToolUseBlocks(msg2)[0];

		// Different input → different reference
		expect(toolBlock1).not.toBe(toolBlock2);
	});

	test("text-only streaming preserves tool-use block references", () => {
		const toolChunksMsg = rowWithElements(
			{
				id: "__streaming_tool_chunks__",
				narratorId: "n1",
				parentToolUseId: null,
				role: "assistant" as const,
				contentText: null,
				toolCalls: [],
				createdAt: new Date().toISOString(),
			},
			[
				{ type: "tool_use", id: "tu-1", name: "Bash", input: {} },
				{ type: "tool_use", id: "tu-2", name: "Write", input: {} },
			],
		);

		// Simulate streaming: same tool chunks, changing text
		const msg1 = buildStreamingMsg({
			narratorId: "n1",
			streamingBlocks: [{ type: "text", id: "1:0", revision: 1, textOffset: 0, text: "h" }],
			toolChunksMsg,
		});
		const msg2 = buildStreamingMsg({
			narratorId: "n1",
			streamingBlocks: [{ type: "text", id: "1:0", revision: 1, textOffset: 0, text: "hello" }],
			toolChunksMsg,
		});
		const msg3 = buildStreamingMsg({
			narratorId: "n1",
			streamingBlocks: [
				{ type: "text", id: "1:0", revision: 1, textOffset: 0, text: "hello world" },
			],
			toolChunksMsg,
		});

		const getToolBlocks = getToolUseBlocks;

		const [tu1_1, tu2_1] = getToolBlocks(msg1);
		const [tu1_2, tu2_2] = getToolBlocks(msg2);
		const [tu1_3, tu2_3] = getToolBlocks(msg3);

		// All tool-use blocks should be the SAME reference across frames
		expect(tu1_1).toBe(tu1_2);
		expect(tu1_2).toBe(tu1_3);
		expect(tu2_1).toBe(tu2_2);
		expect(tu2_2).toBe(tu2_3);
	});
});
