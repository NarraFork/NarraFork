import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import { createProviderTurnContext } from "../codex-turn-state";
import type { ChatParams, DbMessage, ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import { type AgentConfig, type AgentEvent, ApiError } from "../types";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

let script: ProviderAdapter["chat"];
let attempts = 0;
let scriptEveryAttempt = false;
const started: string[] = [];
/** Rows each projected request was built from (the fake builder's input). */
const builtRows: DbMessage[][] = [];
const requests: Array<{ history: unknown[]; content: string; toolResults?: unknown[] }> = [];
const turnContexts: ChatParams["turnContext"][] = [];
const provider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async (rows) => {
		builtRows.push(structuredClone(rows));
		return {
			history: rows.map((row) => ({
				role: row.role,
				content: row.contentJson,
				calls: row.toolCalls,
			})),
		};
	},
	injectSystemPrompt: () => {},
	async *chat(params) {
		requests.push(
			structuredClone({
				history: params.history ?? [],
				content: params.content,
				toolResults: params.toolResults,
			}),
		);
		turnContexts.push(params.turnContext);
		params.onRequestStart?.();
		if (++attempts > 1 && !scriptEveryAttempt) {
			yield { text: "收尾" };
			return;
		}
		yield* script(params);
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
	scriptEveryAttempt = false;
	started.length = 0;
	builtRows.length = 0;
	requests.length = 0;
	turnContexts.length = 0;
});
afterAll(() => {
	mock.module("../provider", () => realProvider);
	toolRegistry.unregister("ContentProbe");
	mock.restore();
});

async function run(
	onEvent?: (event: AgentEvent) => Promise<void> | void,
	permissionHandler: AgentConfig["permissionHandler"] = async () => ({ behavior: "allow" }),
	overrides: Partial<AgentConfig> = {},
	initialRows: DbMessage[] = [],
) {
	const config: AgentConfig = {
		narratorId: "n-content-persistence",
		conversationId: "content-persistence",
		provider: "test",
		model: "test:model",
		cwd: process.cwd(),
		signal: new AbortController().signal,
		permissionHandler,
	};
	Object.defineProperties(config, Object.getOwnPropertyDescriptors(overrides));
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(config, "test content ordering", { rows: initialRows })) {
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
		// The next request reads the step with the reasoning whole.
		const step = builtRows.at(-1)?.find((row) => row.role === "assistant");
		expect(step?.contentJson).toEqual(
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

describe("Responses phase and explicit end_turn", () => {
	test("false→false→true replays item/part metadata and consumes input exactly once", async () => {
		scriptEveryAttempt = true;
		script = async function* () {
			if (attempts === 1) {
				yield {
					text: "commentary",
					textBlockId: "comment/0",
					textOutputIndex: 0,
					textMetadata: { openai: { itemId: "comment", contentIndex: 0 } },
				};
				yield {
					contentBoundary: {
						kind: "text",
						phase: "complete",
						blockId: "comment/0",
						outputIndex: 0,
					},
				};
				for (const index of [0, 1]) {
					yield {
						text: `part ${index}`,
						textBlockId: `partial/${index}`,
						textOutputIndex: 1,
						textMetadata: {
							openai: { itemId: "partial", contentIndex: index, phase: "partial_answer" },
						},
					};
				}
				yield {
					textBlockId: "comment/0",
					textOutputIndex: 0,
					textMetadata: { openai: { phase: "commentary" } },
					endTurn: false,
				};
			} else {
				yield {
					text: `answer ${attempts}`,
					textBlockId: `final-${attempts}/0`,
					textOutputIndex: 0,
					textMetadata: {
						openai: { itemId: `final-${attempts}`, contentIndex: 0, phase: "final_answer" },
					},
					// final_answer alone must not end the logical turn.
					endTurn: attempts === 3,
				};
			}
		};
		const initialRows: DbMessage[] = [
			{
				id: "previous-step",
				role: "assistant",
				parentToolUseId: null,
				messageUuid: null,
				contentText: null,
				contentJson: [
					{ type: "tool_use", id: "old-call", name: "ContentProbe", input: { value: "old" } },
				],
				toolCalls: [
					{
						toolUseId: "old-call",
						toolName: "ContentProbe",
						inputJson: { value: "old" },
						outputJson: { output: "consumed result" },
						status: "completed",
					},
				],
			},
		];
		const events = await run(undefined, undefined, { maxTurns: 4 }, initialRows);
		expect(attempts).toBe(3);
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		expect(events.filter((event) => event.type === "assistant_message")).toHaveLength(3);
		expect(requests.map((request) => request.content)).toEqual(["", "", ""]);
		expect(requests.map((request) => request.toolResults)).toEqual([[], [], []]);
		expect(requests[2].history).toMatchObject([
			{ role: "assistant", content: initialRows[0].contentJson, calls: initialRows[0].toolCalls },
			{ role: "user", content: [{ type: "text", text: "test content ordering" }] },
			{
				role: "assistant",
				content: [
					{
						text: "commentary",
						providerMetadata: {
							openai: { itemId: "comment", contentIndex: 0, phase: "commentary" },
						},
					},
					{
						text: "part 0",
						providerMetadata: {
							openai: { itemId: "partial", contentIndex: 0, phase: "partial_answer" },
						},
					},
					{
						text: "part 1",
						providerMetadata: {
							openai: { itemId: "partial", contentIndex: 1, phase: "partial_answer" },
						},
					},
				],
			},
			{
				role: "assistant",
				content: [{ text: "answer 2", providerMetadata: { openai: { phase: "final_answer" } } }],
			},
		]);
		const commentWrites = events.flatMap((event) =>
			event.type === "block_complete" &&
			event.block.type === "text" &&
			event.block.text === "commentary"
				? [event.block]
				: [],
		);
		expect(commentWrites).toHaveLength(2);
		expect(commentWrites[1].id).toBe(commentWrites[0].id);
		expect(commentWrites[1]).toMatchObject({
			completed: true,
			providerMetadata: { openai: { phase: "commentary" } },
		});
		expect(turnContexts[0]).toBeDefined();
		expect(turnContexts[1]).toBe(turnContexts[0]);
		expect(turnContexts[2]).toBe(turnContexts[0]);
	});

	test.each([
		undefined,
		"commentary" as const,
	])("missing end_turn keeps legacy completion (phase=%s)", async (phase) => {
		script = async function* () {
			yield { text: "legacy", ...(phase ? { textMetadata: { openai: { phase } } } : {}) };
		};
		const events = await run();
		expect(attempts).toBe(1);
		expect(events.at(-1)?.type).toBe("done");
	});

	test("end_turn=true cannot bypass tools awaiting execution", async () => {
		script = async function* () {
			yield {
				text: "running",
				endTurn: true,
				toolUses: [{ toolUseId: "true-call", name: "ContentProbe", input: { value: "executed" } }],
			};
		};
		await run();
		expect(started).toEqual(["executed"]);
		expect(attempts).toBe(2);
	});

	test.each([
		false,
		true,
	])("explicit continuation remains bounded (reflection=%s)", async (reflection) => {
		scriptEveryAttempt = true;
		script = async function* () {
			yield { text: "more", endTurn: false };
		};
		const events = await run(undefined, undefined, {
			maxTurns: 2,
			...(reflection ? { reflectionLoop: { allowedTools: [], context: { kind: "test" } } } : {}),
		});
		expect(attempts).toBe(2);
		expect(events.at(-1)).toEqual({ type: "max_turns_exceeded", maxTurns: 2 });
		expect(requests[1].content).toBe("");
	});

	test("a graceful stop wins over explicit continuation", async () => {
		script = async function* () {
			yield { text: "more", endTurn: false };
		};
		let stop = false;
		const events = await run(
			(event) => {
				if (event.type === "assistant_message") stop = true;
			},
			undefined,
			{ shouldStop: () => stop },
		);
		expect(attempts).toBe(1);
		expect(events.at(-1)?.type).toBe("turn_complete");
	});

	test.each([
		"empty",
		"reasoning",
	] as const)("completed intermediate %s output follows up without a dead-turn retry", async (kind) => {
		script = async function* () {
			if (kind === "reasoning") yield { reasoning: "intermediate reasoning" };
			yield { endTurn: false };
		};
		const events = await run(undefined, undefined, { maxTurns: 2 });
		expect(attempts).toBe(2);
		expect(events.some((event) => event.type === "retrying" || event.type === "stream_reset")).toBe(
			false,
		);
		expect(events.filter((event) => event.type === "assistant_message")).toHaveLength(
			kind === "empty" ? 1 : 2,
		);
		const replayed = builtRows[1].filter((row) => row.role === "assistant");
		expect(replayed).toHaveLength(kind === "empty" ? 0 : 1);
		if (kind === "reasoning")
			expect(replayed[0].contentJson).toMatchObject([
				{ type: "reasoning", text: "intermediate reasoning" },
			]);
		expect(requests[1].content).toBe("");
		expect(events.at(-1)?.type).toBe("done");
	});

	test("after-tools input and results are committed once before a no-tool continuation", async () => {
		scriptEveryAttempt = true;
		script = async function* () {
			if (attempts === 1)
				yield {
					toolUses: [{ toolUseId: "tool-once", name: "ContentProbe", input: { value: "once" } }],
				};
			else yield { text: `response ${attempts}`, endTurn: attempts === 3 };
		};
		let consumed = 0;
		let deliveries = 0;
		await run(undefined, undefined, {
			maxTurns: 4,
			getAfterToolsInjections: () => {
				deliveries++;
				return {
					text: "host update",
					parts: [{ text: "host update", messageId: "injected-once" }],
					onConsumed: () => {
						consumed++;
					},
				};
			},
		});
		expect(started).toEqual(["once"]);
		expect(deliveries).toBe(1);
		expect(consumed).toBe(1);
		expect(requests.map((request) => request.content)).toEqual(["", "", ""]);
		expect(requests.map((request) => request.toolResults)).toEqual([[], [], []]);
		expect(builtRows[2]).toMatchObject([
			{ role: "user", contentJson: [{ type: "text", text: "test content ordering" }] },
			{
				role: "assistant",
				contentJson: [{ type: "tool_use", id: "tool-once" }],
				toolCalls: [{ toolUseId: "tool-once", status: "success", outputJson: "ok" }],
			},
			{ role: "user", contentJson: [{ type: "text", text: "host update" }] },
			{ role: "assistant", contentJson: [{ type: "text", text: "response 2" }] },
		]);
	});

	test.each([
		"abort",
		"error",
	] as const)("%s wins over a previously reported end_turn=false", async (kind) => {
		const abort = new AbortController();
		script = async function* () {
			yield { text: "intermediate", endTurn: false };
			if (kind === "abort") abort.abort();
			else yield { invalidState: { reason: "invalid_request_error", message: "invalid request" } };
		};
		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			{
				narratorId: "n-phase-error",
				conversationId: "phase-error",
				provider: "test",
				model: "test:model",
				cwd: process.cwd(),
				signal: abort.signal,
				maxTurns: 2,
				permissionHandler: async () => ({ behavior: "allow" }),
			},
			"do not continue",
			{ rows: [] },
		))
			events.push(event);
		expect(attempts).toBe(1);
		expect(events.some((event) => event.type === "error" || event.type === "invalid_state")).toBe(
			true,
		);
		expect(events.some((event) => event.type === "done")).toBe(false);
	});

	test("a retry clears the failed attempt's end_turn while retaining its logical context", async () => {
		scriptEveryAttempt = true;
		script = async function* () {
			if (attempts === 1) {
				yield { endTurn: false };
				throw new ApiError(503, "retry me");
			}
			yield { text: "legacy final" };
		};
		const events = await run(undefined, undefined, {
			maxTurns: 3,
			maxTransientRetries: 1,
			retryBackoffCeilMs: 1,
		});
		expect(attempts).toBe(2);
		expect(requests.map((request) => request.content)).toEqual(["", ""]);
		expect(requests[1].history).toEqual(requests[0].history);
		expect(turnContexts[1]).toBe(turnContexts[0]);
		expect(events.some((event) => event.type === "retrying")).toBe(true);
		expect(events.at(-1)?.type).toBe("done");
	});

	test("turn contexts are live, and independent direct loops never share the fallback", async () => {
		script = async function* () {
			yield { text: "more", endTurn: false };
		};
		const first = createProviderTurnContext();
		const second = createProviderTurnContext();
		let current = first;
		await run(undefined, undefined, {
			get turnContext() {
				return current;
			},
			onBeforeTurn: async () => {
				current = second;
				return null;
			},
		});
		expect(turnContexts).toEqual([first, second]);
		await run();
		await run();
		expect(turnContexts[2]).not.toBe(turnContexts[3]);
		expect(turnContexts[2]).not.toBe(first);
	});
});

describe("question reply ownership during real loop execution", () => {
	test.each([
		false,
		true,
	])("permission reply never becomes the assistant's arguments (deferred=%s)", async (deferred) => {
		const originalTool = toolRegistry.get("AskUserQuestion");
		const authored = {
			questions: [{ header: "Direction", options: [{ header: "A" }, { header: "B" }] }],
			async: false,
		};
		const reply = deferred
			? { ...authored, async: true, deferredByUser: true }
			: {
					...authored,
					answers: { Direction: "UNIQUE_HUMAN_PERMISSION_REPLY" },
					annotations: { Direction: { notes: "human note" } },
				};
		let executionInput: unknown;
		toolRegistry.register({
			name: "AskUserQuestion",
			description: "Question execution observer",
			parameters: z.object({ questions: z.array(z.unknown()), async: z.boolean().optional() }),
			execute: async (input) => {
				executionInput = structuredClone(input);
				return {
					output: deferred
						? "Question accepted asynchronously."
						: "User answered: UNIQUE_HUMAN_PERMISSION_REPLY",
				};
			},
		});
		script = async function* () {
			yield {
				toolUses: [
					{
						toolUseId: "question-authored",
						name: "AskUserQuestion",
						input: structuredClone(authored),
					},
				],
			};
		};
		try {
			const events = await run(undefined, async () => ({ behavior: "allow", updatedInput: reply }));
			expect(executionInput).toEqual(reply);
			// The next request's step keeps the authored call; the reply is only its result.
			expect(requests).toHaveLength(2);
			const step = builtRows.at(-1)?.find((row) => row.role === "assistant");
			const call = (step?.contentJson as Array<{ type: string; name?: string; input?: unknown }>)
				.filter((block) => block.type === "tool_use")
				.find((block) => block.name === "AskUserQuestion");
			expect(call?.input).toEqual(authored);
			const ledger = step?.toolCalls?.find((entry) => entry.toolUseId === "question-authored");
			expect(ledger?.inputJson).toEqual(authored);
			expect(JSON.stringify(ledger?.outputJson)).toContain(
				deferred ? "Question accepted asynchronously." : "UNIQUE_HUMAN_PERMISSION_REPLY",
			);
			expect(events.find((event) => event.type === "tool_result")).toMatchObject({
				updatedInput: reply,
			});
			expect(authored.async).toBe(false);
		} finally {
			if (originalTool) toolRegistry.register(originalTool);
			else toolRegistry.unregister("AskUserQuestion");
		}
	});
});
