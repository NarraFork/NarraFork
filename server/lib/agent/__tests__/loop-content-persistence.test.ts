import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent } from "../types";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

let script: ProviderAdapter["chat"];
let attempts = 0;
const started: string[] = [];
const replayed: unknown[][] = [];
const provider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		params.onRequestStart?.();
		if (++attempts > 1) {
			yield { text: "收尾" };
			return;
		}
		yield* script(params);
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: (...args) => {
		replayed.push(args);
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const realProvider = { ...(await import("../provider")) };
mock.module("../provider", () => ({
	getProvider: () => provider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:model",
		provider: "test",
		adapter: provider,
		model: "test:model",
	}),
}));
const { agentLoop } = await import("../loop");

toolRegistry.register({
	name: "ContentProbe",
	description: "Observe content publication before tool execution",
	parameters: z.object({ value: z.string() }),
	execute: async (input) => {
		started.push(String(input.value));
		return { output: "ok" };
	},
});

beforeEach(() => {
	attempts = 0;
	started.length = 0;
	replayed.length = 0;
});
afterAll(() => {
	mock.module("../provider", () => realProvider);
	toolRegistry.unregister("ContentProbe");
	mock.restore();
});

async function run(onEvent?: (event: AgentEvent) => Promise<void> | void) {
	const config: AgentConfig = {
		narratorId: "n-content-persistence",
		conversationId: "content-persistence",
		provider: "test",
		model: "test:model",
		cwd: process.cwd(),
		signal: new AbortController().signal,
		permissionHandler: async () => ({ behavior: "allow" }),
	};
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(config, "test content ordering", [])) {
		events.push(event);
		await onEvent?.(event);
	}
	expect(events.filter((event) => event.type === "error")).toEqual([]);
	return events;
}

function contentBefore(events: AgentEvent[], index: number) {
	return events
		.slice(0, index)
		.flatMap((event) =>
			event.type === "block_complete" &&
			(event.block.type === "text" || event.block.type === "reasoning")
				? [event.block]
				: [],
		);
}

describe("reasoning identity and replay", () => {
	test("metadata in the middle of signed reasoning never inserts synthetic newlines", async () => {
		script = async function* () {
			yield { reasoning: "ab", reasoningBlockId: "native", reasoningOutputIndex: 0 };
			yield {
				reasoningMetadata: { anthropic: { blockIndex: 0, signature: "signed" } },
				reasoningBlockId: "native",
				reasoningOutputIndex: 0,
			};
			yield { reasoning: "cd", reasoningBlockId: "native", reasoningOutputIndex: 0 };
			yield { text: "done", textOutputIndex: 1 };
			yield {
				toolUses: [
					{ toolUseId: "t1", name: "ContentProbe", input: { value: "one" }, outputIndex: 2 },
				],
			};
		};
		const events = await run();
		const text = events
			.flatMap((event) => (event.type === "stream_reasoning" ? [event.text] : []))
			.join("");
		expect(text).toBe("abcd");
		const end = events.findIndex((event) => event.type === "assistant_message");
		const reasoning = contentBefore(events, end).filter((block) => block.type === "reasoning");
		expect(reasoning).toHaveLength(1);
		expect(reasoning[0]).toMatchObject({
			text: "abcd",
			providerMetadata: { anthropic: { signature: "signed" } },
		});
		expect(replayed[0]?.[9]).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "reasoning", text: "abcd" })]),
		);
	});

	test("content and metadata in one provider event are saved before its tool", async () => {
		script = async function* () {
			yield {
				reasoning: "R",
				text: "T",
				toolUses: [{ toolUseId: "t1", name: "ContentProbe", input: { value: "one" } }],
			};
		};
		const events = await run();
		const tool = events.findIndex((event) => event.type === "tool_call");
		expect(contentBefore(events, tool).map((block) => [block.type, block.text])).toEqual([
			["reasoning", "R"],
			["text", "T"],
		]);
	});

	test("aborting the consumer at a failed content write never starts the tool", async () => {
		script = async function* () {
			yield { text: "must persist first" };
			yield { toolUses: [{ toolUseId: "t1", name: "ContentProbe", input: { value: "one" } }] };
		};
		await expect(
			run((event) => {
				if (event.type === "block_complete" && event.block.type === "text")
					throw new Error("persist failed");
			}),
		).rejects.toThrow("persist failed");
		expect(started).toEqual([]);
	});
});
describe("content publication precedes tools", () => {
	test("reasoning and text are committed before the FIRST tool UI chunk", async () => {
		script = async function* () {
			yield { reasoning: "先检查状态" };
			yield { text: "开始检查。" };
			yield { toolUseChunk: { toolUseId: "t1", name: "ContentProbe" } };
			yield { toolUseChunk: { toolUseId: "t1", input: '{"value":"one"}', stop: true } };
			yield { toolUseChunk: { toolUseId: "t2", name: "ContentProbe" } };
			yield { toolUseChunk: { toolUseId: "t2", input: '{"value":"two"}', stop: true } };
		};
		const events = await run();
		const firstTool = events.findIndex((event) => event.type === "tool_use_chunk");
		expect(firstTool).toBeGreaterThan(0);
		expect(contentBefore(events, firstTool).map((block) => [block.type, block.text])).toEqual([
			["reasoning", "先检查状态"],
			["text", "开始检查。"],
		]);
		const finalFirstTurn = events.findIndex((event) => event.type === "assistant_message");
		// Finalization must not append the same body for a second time.
		expect(contentBefore(events, finalFirstTurn)).toHaveLength(2);
	});

	test("awaiting a content write prevents tool display AND eager execution", async () => {
		script = async function* () {
			yield { reasoning: "前序内容" };
			yield { text: "先保存这段正文。" };
			yield { toolUses: [{ toolUseId: "t1", name: "ContentProbe", input: { value: "one" } }] };
		};
		const writing = gate();
		const release = gate();
		const visibleTools: string[] = [];
		const running = run(async (event) => {
			if (event.type === "tool_use_chunk" || event.type === "tool_call") {
				visibleTools.push(event.toolUseId);
			}
			if (event.type === "block_complete" && event.block.type === "reasoning") {
				writing.resolve();
				await release.promise;
			}
		});
		await writing.promise;
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(visibleTools).toEqual([]);
			expect(started).toEqual([]);
		} finally {
			release.resolve();
			await running;
		}
	});

	test("text before and after a tool remains two ordered blocks", async () => {
		script = async function* () {
			yield { text: "工具之前。", textOutputIndex: 0 };
			yield {
				toolUses: [
					{ toolUseId: "t1", name: "ContentProbe", input: { value: "one" }, outputIndex: 1 },
				],
			};
			yield { text: "工具之后。", textOutputIndex: 2 };
		};
		const events = await run();
		const finalFirstTurn = events.findIndex((event) => event.type === "assistant_message");
		expect(
			contentBefore(events, finalFirstTurn).map((block) => [block.text, block.outputIndex]),
		).toEqual([
			["工具之前。", 0],
			["工具之后。", 2],
		]);
	});

	test("a late reasoning signature updates its original persisted block", async () => {
		script = async function* () {
			yield {
				reasoning: "完整推理",
				reasoningMetadata: { openai: { itemId: "rs-1" } },
				reasoningOutputIndex: 0,
			};
			yield { text: "开始处理。", textOutputIndex: 1 };
			yield {
				toolUses: [
					{ toolUseId: "t1", name: "ContentProbe", input: { value: "one" }, outputIndex: 2 },
				],
			};
			yield {
				reasoningMetadata: { openai: { itemId: "rs-1", reasoningEncryptedContent: "encrypted" } },
				reasoningOutputIndex: 0,
			};
		};
		const events = await run();
		const toolIndex = events.findIndex((event) => event.type === "tool_call");
		const before = contentBefore(events, toolIndex).find((block) => block.type === "reasoning");
		expect(before?.text).toBe("完整推理");
		const firstMessage = events.findIndex((event) => event.type === "assistant_message");
		const reasoningWrites = contentBefore(events, firstMessage).filter(
			(block) => block.type === "reasoning",
		);
		expect(reasoningWrites).toHaveLength(2);
		expect(reasoningWrites[0].id).toBe(reasoningWrites[1].id);
		expect(reasoningWrites[1].revision).toBeGreaterThan(reasoningWrites[0].revision ?? 0);
		expect(reasoningWrites.at(-1)?.text).toBe("完整推理");
		expect(reasoningWrites.at(-1)?.providerMetadata?.openai?.reasoningEncryptedContent).toBe(
			"encrypted",
		);
	});
});
