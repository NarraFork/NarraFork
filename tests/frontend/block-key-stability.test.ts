import { afterEach, describe, expect, test } from "bun:test";
import {
	buildStreamingMsg,
	clearToolBlockCache,
	generateBlockKeys,
} from "../../frontend/components/narrator/message-segments";

// ---------------------------------------------------------------------------
// buildStreamingMsg — stable synthetic IDs
// ---------------------------------------------------------------------------

describe("buildStreamingMsg — stable block IDs", () => {
	const base = { narratorId: "n1" };

	test("reasoning block gets stable id", () => {
		const msg = buildStreamingMsg({ ...base, streamingReasoning: "thinking..." });
		expect(msg).not.toBeNull();
		const reasoningBlock = msg?.contentJson.find((b: any) => b.type === "reasoning");
		expect(reasoningBlock).toBeDefined();
		expect(reasoningBlock?.id).toBe("streaming:reasoning");
	});

	test("text block gets stable id", () => {
		const msg = buildStreamingMsg({ ...base, streamingText: "hello" });
		expect(msg).not.toBeNull();
		const textBlock = msg?.contentJson.find((b: any) => b.type === "text");
		expect(textBlock).toBeDefined();
		expect(textBlock?.id).toBe("streaming:text");
	});

	test("reasoning + text both get stable ids", () => {
		const msg = buildStreamingMsg({
			...base,
			streamingReasoning: "thinking...",
			streamingText: "hello",
		});
		expect(msg).not.toBeNull();
		const ids = msg?.contentJson.map((b: any) => b.id);
		expect(ids).toEqual(["streaming:reasoning", "streaming:text"]);
	});

	test("web_search block keeps its original id", () => {
		const msg = buildStreamingMsg({
			...base,
			webSearch: { id: "ws-123", status: "searching", query: "test" },
		});
		expect(msg).not.toBeNull();
		const wsBlock = msg?.contentJson.find((b: any) => b.type === "web_search");
		expect(wsBlock).toBeDefined();
		expect(wsBlock?.id).toBe("ws-123");
	});

	test("tool_use blocks keep their original ids from toolChunksMsg", () => {
		const toolChunksMsg = {
			id: "__streaming_chunks__",
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant" as const,
			contentJson: [
				{ type: "tool_use", id: "tu-1", name: "Bash", input: {} },
				{ type: "tool_use", id: "tu-2", name: "Write", input: {} },
			],
			contentText: null,
			toolCalls: [],
			createdAt: new Date().toISOString(),
			children: [],
		};
		const msg = buildStreamingMsg({ ...base, toolChunksMsg });
		expect(msg).not.toBeNull();
		const toolBlocks = msg?.contentJson.filter((b: any) => b.type === "tool_use") ?? [];
		expect(toolBlocks.map((b: any) => b.id)).toEqual(["tu-1", "tu-2"]);
	});

	test("all block types combined: ids remain stable", () => {
		const toolChunksMsg = {
			id: "__streaming_chunks__",
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant" as const,
			contentJson: [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }],
			contentText: null,
			toolCalls: [],
			createdAt: new Date().toISOString(),
			children: [],
		};
		const msg = buildStreamingMsg({
			...base,
			streamingReasoning: "thinking...",
			streamingText: "result",
			webSearch: { id: "ws-1", status: "completed", query: "q" },
			toolChunksMsg,
		});
		expect(msg).not.toBeNull();
		const ids = msg?.contentJson.map((b: any) => b.id);
		expect(ids).toEqual(["streaming:reasoning", "ws-1", "streaming:text", "tu-1"]);
	});

	test("ids are stable across incremental streaming updates", () => {
		// Simulate the streaming sequence: reasoning → +text → +web_search → +tool
		const step1 = buildStreamingMsg({ ...base, streamingReasoning: "t" });
		const reasoningId1 = step1?.contentJson[0].id;

		const step2 = buildStreamingMsg({
			...base,
			streamingReasoning: "thinking...",
			streamingText: "hel",
		});
		const reasoningId2 = step2?.contentJson.find((b: any) => b.type === "reasoning")?.id;
		const textId2 = step2?.contentJson.find((b: any) => b.type === "text")?.id;

		const step3 = buildStreamingMsg({
			...base,
			streamingReasoning: "thinking...",
			streamingText: "hello world",
			webSearch: { id: "ws-1", status: "searching" },
		});
		const reasoningId3 = step3?.contentJson.find((b: any) => b.type === "reasoning")?.id;
		const textId3 = step3?.contentJson.find((b: any) => b.type === "text")?.id;

		// All ids should be identical across steps
		expect(reasoningId1).toBe("streaming:reasoning");
		expect(reasoningId2).toBe("streaming:reasoning");
		expect(reasoningId3).toBe("streaming:reasoning");
		expect(textId2).toBe("streaming:text");
		expect(textId3).toBe("streaming:text");
	});
});

// ---------------------------------------------------------------------------
// generateBlockKeys — stable key generation
// ---------------------------------------------------------------------------

describe("generateBlockKeys", () => {
	test("blocks with id use that id as key", () => {
		const blocks = [
			{ type: "tool_use", id: "tu-1", name: "Bash", input: {} },
			{ type: "tool_use", id: "tu-2", name: "Write", input: {} },
		];
		expect(generateBlockKeys(blocks)).toEqual(["tu-1", "tu-2"]);
	});

	test("text block without id gets type as key", () => {
		const blocks = [{ type: "text", text: "hello" }];
		expect(generateBlockKeys(blocks)).toEqual(["text"]);
	});

	test("reasoning block without id gets type as key", () => {
		const blocks = [{ type: "reasoning", text: "thinking..." }];
		expect(generateBlockKeys(blocks)).toEqual(["reasoning"]);
	});

	test("thinking block without id gets type as key", () => {
		const blocks = [{ type: "thinking", thinking: "thinking..." }];
		expect(generateBlockKeys(blocks)).toEqual(["thinking"]);
	});

	test("multiple different block types without ids get unique keys", () => {
		const blocks = [
			{ type: "reasoning", text: "thinking..." },
			{ type: "text", text: "hello" },
		];
		expect(generateBlockKeys(blocks)).toEqual(["reasoning", "text"]);
	});

	test("mixed blocks: some with id, some without", () => {
		const blocks = [
			{ type: "reasoning", text: "thinking..." },
			{ type: "tool_use", id: "tu-1", name: "Bash", input: {} },
			{ type: "text", text: "hello" },
		];
		expect(generateBlockKeys(blocks)).toEqual(["reasoning", "tu-1", "text"]);
	});

	test("two text blocks without ids get dedup counter", () => {
		const blocks = [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		];
		expect(generateBlockKeys(blocks)).toEqual(["text", "text-1"]);
	});

	test("two reasoning blocks without ids get dedup counter", () => {
		const blocks = [
			{ type: "reasoning", text: "r1" },
			{ type: "reasoning", text: "r2" },
		];
		expect(generateBlockKeys(blocks)).toEqual(["reasoning", "reasoning-1"]);
	});

	test("key stability when a new block is inserted before existing ones", () => {
		// Before: [text] → keys: ["text"]
		const before = [{ type: "text", text: "hello" }];
		expect(generateBlockKeys(before)).toEqual(["text"]);

		// After: [reasoning, text] → keys: ["reasoning", "text"] — text key unchanged!
		const after = [
			{ type: "reasoning", text: "thinking..." },
			{ type: "text", text: "hello" },
		];
		expect(generateBlockKeys(after)).toEqual(["reasoning", "text"]);
	});

	test("key stability across a full streaming sequence", () => {
		// Step 1: only text
		const step1 = [{ type: "text", text: "hel" }];
		const keys1 = generateBlockKeys(step1);
		expect(keys1).toEqual(["text"]);

		// Step 2: reasoning + text (reasoning appeared)
		const step2 = [
			{ type: "reasoning", text: "think" },
			{ type: "text", text: "hello" },
		];
		const keys2 = generateBlockKeys(step2);
		expect(keys2).toEqual(["reasoning", "text"]);

		// Step 3: reasoning + web_search + text (web_search inserted)
		const step3 = [
			{ type: "reasoning", text: "thinking..." },
			{ type: "web_search", id: "ws-1", status: "searching" },
			{ type: "text", text: "hello world" },
		];
		const keys3 = generateBlockKeys(step3);
		expect(keys3).toEqual(["reasoning", "ws-1", "text"]);

		// Step 4: reasoning + web_search + text + tool_use (tool_use appended)
		const step4 = [
			{ type: "reasoning", text: "thinking..." },
			{ type: "web_search", id: "ws-1", status: "completed" },
			{ type: "text", text: "hello world!" },
			{ type: "tool_use", id: "tu-1", name: "Bash", input: {} },
		];
		const keys4 = generateBlockKeys(step4);
		expect(keys4).toEqual(["reasoning", "ws-1", "text", "tu-1"]);

		// Verify: text key is "text" in every step where it appears
		expect(keys1[0]).toBe("text");
		expect(keys2[1]).toBe("text");
		expect(keys3[2]).toBe("text");
		expect(keys4[2]).toBe("text");

		// Verify: reasoning key is "reasoning" in every step where it appears
		expect(keys2[0]).toBe("reasoning");
		expect(keys3[0]).toBe("reasoning");
		expect(keys4[0]).toBe("reasoning");
	});

	test("unknown block type without id falls back to type-index key", () => {
		const blocks = [{ type: "custom_unknown_type" }];
		expect(generateBlockKeys(blocks)).toEqual(["custom_unknown_type-0"]);
	});

	test("mixed: one block with id, two without id of same type", () => {
		const blocks = [
			{ type: "text", text: "first" },
			{ type: "tool_use", id: "tu-1", name: "Bash", input: {} },
			{ type: "text", text: "second" },
		];
		expect(generateBlockKeys(blocks)).toEqual(["text", "tu-1", "text-1"]);
	});

	test("empty blocks array returns empty keys", () => {
		expect(generateBlockKeys([])).toEqual([]);
	});

	test("all blocks have ids → keys match ids exactly", () => {
		const blocks = [
			{ type: "tool_use", id: "tu-1", name: "Bash", input: {} },
			{ type: "web_search", id: "ws-1" },
			{ type: "tool_use", id: "tu-2", name: "Write", input: {} },
		];
		expect(generateBlockKeys(blocks)).toEqual(["tu-1", "ws-1", "tu-2"]);
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
		const toolChunksMsg = {
			id: "__streaming_tool_chunks__",
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant" as const,
			contentJson: [{ type: "tool_use", id: "tu-1", name: "Bash", input }],
			contentText: null,
			toolCalls: [],
			createdAt: new Date().toISOString(),
			children: [],
		};

		const msg1 = buildStreamingMsg({
			narratorId: "n1",
			streamingText: "first",
			toolChunksMsg,
		});
		const msg2 = buildStreamingMsg({
			narratorId: "n1",
			streamingText: "second",
			toolChunksMsg,
		});

		expect(msg1).not.toBeNull();
		expect(msg2).not.toBeNull();

		const toolBlock1 = msg1?.contentJson.find((b: any) => b.type === "tool_use");
		const toolBlock2 = msg2?.contentJson.find((b: any) => b.type === "tool_use");

		// Same object reference — not just same data
		expect(toolBlock1).toBe(toolBlock2);
	});

	test("different tool-use data returns new block object reference", () => {
		const toolChunksMsg1 = {
			id: "__streaming_tool_chunks__",
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant" as const,
			contentJson: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { x: 1 } }],
			contentText: null,
			toolCalls: [],
			createdAt: new Date().toISOString(),
			children: [],
		};
		const toolChunksMsg2 = {
			...toolChunksMsg1,
			contentJson: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { x: 2 } }],
		};

		const msg1 = buildStreamingMsg({ narratorId: "n1", toolChunksMsg: toolChunksMsg1 });
		const msg2 = buildStreamingMsg({ narratorId: "n1", toolChunksMsg: toolChunksMsg2 });

		const toolBlock1 = msg1?.contentJson.find((b: any) => b.type === "tool_use");
		const toolBlock2 = msg2?.contentJson.find((b: any) => b.type === "tool_use");

		// Different input → different reference
		expect(toolBlock1).not.toBe(toolBlock2);
	});

	test("text-only streaming preserves tool-use block references", () => {
		const toolChunksMsg = {
			id: "__streaming_tool_chunks__",
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant" as const,
			contentJson: [
				{ type: "tool_use", id: "tu-1", name: "Bash", input: {} },
				{ type: "tool_use", id: "tu-2", name: "Write", input: {} },
			],
			contentText: null,
			toolCalls: [],
			createdAt: new Date().toISOString(),
			children: [],
		};

		// Simulate streaming: same tool chunks, changing text
		const msg1 = buildStreamingMsg({
			narratorId: "n1",
			streamingText: "h",
			toolChunksMsg,
		});
		const msg2 = buildStreamingMsg({
			narratorId: "n1",
			streamingText: "hello",
			toolChunksMsg,
		});
		const msg3 = buildStreamingMsg({
			narratorId: "n1",
			streamingText: "hello world",
			toolChunksMsg,
		});

		const getToolBlocks = (msg: any) => msg?.contentJson.filter((b: any) => b.type === "tool_use");

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
