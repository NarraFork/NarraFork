import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import { CODEX_REBUILD_HISTORY_RETRY_CODE, CodexRebuildHistoryRetryError } from "../codex-errors";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent } from "../types";

const TEST_TOOL_NAME = "TestAbortDrainTool";

let providerScenario:
	| "abort"
	| "abort_pending_tool"
	| "truncated_after_tool"
	| "split_streaming_escape"
	| "codex_rebuild_after_text"
	| "codex_rebuild_after_tool"
	| "soft_stop_serial"
	| "soft_stop_parallel"
	| "soft_stop_interleaved"
	| "parallel_completion_order"
	| "parallel_then_serial_abort"
	| "enter_plan_prepared_order"
	| "interleaved_tool_chunk_order" = "abort";
let providerAttempts = 0;
const executedToolValues: string[] = [];
const completedToolValues: string[] = [];
const formattedToolResultOrder: string[] = [];
const modelToolResultOrder: string[] = [];
const assistantToolUseOrders: string[][] = [];
let enterPlanStopEmitted = false;
let readStartedBeforeEnterPlanStop = false;
let releasePendingTool: (() => void) | undefined;
const parallelAbortResolvers: Array<() => void> = [];

function releasePendingToolIfAny(): void {
	const release = releasePendingTool;
	if (release) release();
}

function releaseParallelAbortTools(): void {
	for (const resolve of parallelAbortResolvers.splice(0)) resolve();
}

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		providerAttempts++;
		params.onRequestStart?.();
		if (providerScenario === "codex_rebuild_after_text") {
			yield { text: "partial codex output" };
			throw new CodexRebuildHistoryRetryError("The usage limit has been reached", {
				previousCredentialId: "cred-a",
				operation: "chat",
			});
		}
		if (providerScenario === "split_streaming_escape") {
			yield {
				toolUseChunk: {
					toolUseId: "tu_split_escape",
					name: "Write",
					input: '{"file_path":"split.txt","content":"line1\\',
				},
			};
			await new Promise((resolve) => setTimeout(resolve, 60));
			yield {
				toolUseChunk: {
					toolUseId: "tu_split_escape",
					input: "nline2",
				},
			};
			return;
		}
		if (providerScenario === "soft_stop_serial") {
			yield {
				toolUses: [
					{ toolUseId: "tu_stop_1", name: TEST_TOOL_NAME, input: { value: "first" } },
					{ toolUseId: "tu_stop_2", name: TEST_TOOL_NAME, input: { value: "second" } },
				],
			};
			return;
		}
		if (providerScenario === "soft_stop_parallel") {
			yield {
				toolUses: [
					{ toolUseId: "tu_read_1", name: "Read", input: { file_path: "first.txt" } },
					{ toolUseId: "tu_read_2", name: "Read", input: { file_path: "second.txt" } },
					{ toolUseId: "tu_stop_3", name: TEST_TOOL_NAME, input: { value: "after" } },
				],
			};
			return;
		}
		if (providerScenario === "soft_stop_interleaved") {
			yield {
				toolUses: [
					{
						toolUseId: "tu_write_before_stop",
						name: "Write",
						input: { file_path: "first.txt", content: "first" },
					},
					{
						toolUseId: "tu_edit_must_skip",
						name: "Edit",
						input: { file_path: "first.txt", old_string: "first", new_string: "changed" },
					},
					{ toolUseId: "tu_read_started", name: "Read", input: { file_path: "started.txt" } },
				],
			};
			return;
		}
		if (providerScenario === "interleaved_tool_chunk_order") {
			if (providerAttempts === 1) {
				yield {
					toolUseChunk: {
						toolUseId: "tu_enter_plan_interleaved",
						name: "EnterPlanMode",
						input: "{}",
						outputIndex: 0,
					},
				};
				yield {
					toolUseChunk: {
						toolUseId: "tu_write_interleaved",
						name: "Write",
						input: '{"file_path":"ordered.txt","content":"ordered"}',
						outputIndex: 1,
					},
				};
				yield { toolUseChunk: { toolUseId: "tu_write_interleaved", stop: true } };
				yield {
					toolUseChunk: {
						toolUseId: "tu_read_interleaved",
						name: "Read",
						input: '{"file_path":"ordered.txt"}',
						outputIndex: 2,
					},
				};
				yield { toolUseChunk: { toolUseId: "tu_read_interleaved", stop: true } };
				yield {
					toolUseChunk: {
						toolUseId: "tu_unindexed_first",
						name: TEST_TOOL_NAME,
						input: '{"value":"unindexed-first"}',
					},
				};
				yield {
					toolUseChunk: {
						toolUseId: "tu_unindexed_second",
						name: TEST_TOOL_NAME,
						input: '{"value":"unindexed-second"}',
					},
				};
				yield { toolUseChunk: { toolUseId: "tu_unindexed_second", stop: true } };
				yield { toolUseChunk: { toolUseId: "tu_unindexed_first", stop: true } };
				enterPlanStopEmitted = true;
				yield { toolUseChunk: { toolUseId: "tu_enter_plan_interleaved", stop: true } };
			} else {
				modelToolResultOrder.push(
					...(params.toolResults as Array<{ toolUseId?: string }>).map((result) =>
						String(result.toolUseId),
					),
				);
				yield { text: "interleaved tools complete" };
			}
			return;
		}
		if (providerScenario === "parallel_completion_order") {
			if (providerAttempts === 1) {
				yield {
					toolUses: [
						{ toolUseId: "tu_parallel_slow", name: "Read", input: { file_path: "slow.txt" } },
						{ toolUseId: "tu_parallel_fast", name: "Read", input: { file_path: "fast.txt" } },
					],
				};
			} else {
				yield { text: "parallel tools complete" };
			}
			return;
		}
		if (providerScenario === "parallel_then_serial_abort") {
			yield {
				toolUses: [
					{
						toolUseId: "tu_parallel_abort_1",
						name: "Read",
						input: { file_path: "parallel-1.txt" },
					},
					{
						toolUseId: "tu_parallel_abort_2",
						name: "Read",
						input: { file_path: "parallel-2.txt" },
					},
					{
						toolUseId: "tu_serial_after_parallel",
						name: "Write",
						input: { file_path: "after-parallel.txt", content: "must not run" },
					},
				],
			};
			return;
		}
		if (providerScenario === "enter_plan_prepared_order") {
			yield {
				toolUses: [{ toolUseId: "tu_enter_plan", name: "EnterPlanMode", input: {} }],
			};
			return;
		}
		yield {
			toolUses: [
				{ toolUseId: "tu_done_1", name: TEST_TOOL_NAME, input: { value: "one" } },
				{ toolUseId: "tu_done_2", name: TEST_TOOL_NAME, input: { value: "two" } },
			],
		};
		if (providerScenario === "codex_rebuild_after_tool") {
			throw new CodexRebuildHistoryRetryError("The usage limit has been reached", {
				previousCredentialId: "cred-a",
				operation: "chat",
			});
		}
		if (providerScenario === "truncated_after_tool") {
			yield {
				invalidState: {
					reason: "stream_closed_before_response_completed",
					message: "Responses API stream closed before response.completed.",
				},
			};
			return;
		}
		yield { text: "now streaming final text" };
		while (!params.signal.aborted) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		throw new Error("Aborted");
	},
	formatToolResult: (toolUseId, output, isError) => {
		formattedToolResultOrder.push(toolUseId);
		return { toolUseId, output, isError };
	},
	pushUserTurn: () => {},
	pushAssistantTurn: (_history, _text, toolUses) => {
		if (providerScenario === "interleaved_tool_chunk_order" && toolUses.length > 0) {
			assistantToolUseOrders.push(toolUses.map((toolUse) => toolUse.toolUseId));
		}
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

// Snapshot real provider before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realProviderModule = { ...(await import("../provider")) };

mock.module("../provider", () => ({
	getProvider: () => testProvider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:model",
		provider: "test",
		adapter: testProvider,
		model: "test:model",
	}),
}));

const { agentLoop } = await import("../loop");

toolRegistry.register({
	name: TEST_TOOL_NAME,
	description: "Fast test tool for abort result draining",
	parameters: z.object({ value: z.string() }),
	execute: async (args) => {
		executedToolValues.push(`serial:${args.value}`);
		if (providerScenario === "abort_pending_tool") {
			return new Promise<{ output: string }>((resolve) => {
				releasePendingTool = () => resolve({ output: `completed:${args.value}` });
			});
		}
		return { output: `completed:${args.value}` };
	},
});

toolRegistry.register({
	name: "EnterPlanMode",
	description: "Strict-serial plan-mode test tool",
	parameters: z.object({}),
	execute: async () => {
		executedToolValues.push("enter-plan");
		return { output: "entered plan mode" };
	},
});

toolRegistry.register({
	name: "Read",
	description: "Parallel-safe test tool",
	parameters: z.object({ file_path: z.string() }),
	execute: async (args) => {
		executedToolValues.push(`read:${args.file_path}`);
		if (
			providerScenario === "interleaved_tool_chunk_order" &&
			args.file_path === "ordered.txt" &&
			!enterPlanStopEmitted
		) {
			readStartedBeforeEnterPlanStop = true;
		}
		if (providerScenario === "parallel_completion_order" && args.file_path === "slow.txt") {
			await new Promise((resolve) => setTimeout(resolve, 30));
		}
		if (
			providerScenario === "parallel_then_serial_abort" &&
			(args.file_path === "parallel-1.txt" || args.file_path === "parallel-2.txt")
		) {
			await new Promise<void>((resolve) => parallelAbortResolvers.push(resolve));
		}
		completedToolValues.push(`read:${args.file_path}`);
		return { output: `read:${args.file_path}` };
	},
});

toolRegistry.register({
	name: "Write",
	description: "Serial write test tool",
	parameters: z.object({ file_path: z.string(), content: z.string() }),
	execute: async (args) => {
		executedToolValues.push(`write:${args.file_path}`);
		return { output: `write:${args.file_path}` };
	},
});

toolRegistry.register({
	name: "Edit",
	description: "Serial edit test tool",
	parameters: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() }),
	execute: async (args) => {
		executedToolValues.push(`edit:${args.file_path}`);
		return { output: `edit:${args.file_path}` };
	},
});

afterAll(() => {
	releasePendingToolIfAny();
	releaseParallelAbortTools();
	mock.module("../provider", () => realProviderModule);
	toolRegistry.unregister(TEST_TOOL_NAME);
	toolRegistry.unregister("EnterPlanMode");
	toolRegistry.unregister("Read");
	toolRegistry.unregister("Write");
	toolRegistry.unregister("Edit");
	mock.restore();
});

function makeConfig(signal: AbortSignal, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		narratorId: "n-abort-drain",
		conversationId: "conv-abort-drain",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		...overrides,
	};
}

describe("agentLoop abort result draining", () => {
	test("保留中断前已完成 eager tool call 的成功状态", async () => {
		providerScenario = "abort";
		providerAttempts = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(makeConfig(ac.signal), "run tools then answer", [])) {
			events.push(event);
			if (event.type === "stream_text") {
				await Promise.resolve();
				ac.abort();
			}
		}

		const toolResults = events.filter((event) => event.type === "tool_result");
		expect(toolResults).toHaveLength(2);
		expect(toolResults.map((event) => event.toolUseId)).toEqual(["tu_done_1", "tu_done_2"]);
		expect(toolResults.map((event) => event.isError)).toEqual([false, false]);
		expect(toolResults.map((event) => event.output)).toEqual(["completed:one", "completed:two"]);

		const lastEvent = events.at(-1);
		expect(lastEvent).toEqual({ type: "error", message: "Aborted" });
	});

	test("中断不会等待仍未完成的 eager 工具", async () => {
		providerScenario = "abort_pending_tool";
		providerAttempts = 0;
		releasePendingTool = undefined;
		const ac = new AbortController();
		const startedAt = Date.now();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(makeConfig(ac.signal), "interrupt pending tool", [])) {
			events.push(event);
			if (event.type === "stream_text") ac.abort();
		}

		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(events.at(-1)).toEqual({ type: "error", message: "Aborted" });
		releasePendingToolIfAny();
		await Promise.resolve();
	});

	test("soft-stop 在首个串行工具后停止并标记剩余工具未执行", async () => {
		providerScenario = "soft_stop_serial";
		providerAttempts = 0;
		executedToolValues.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			makeConfig(ac.signal, {
				deferEagerToolsForSafeStop: true,
				shouldStop: () => true,
			}),
			"stop after first tool",
			[],
		)) {
			events.push(event);
		}

		expect(executedToolValues).toEqual(["serial:first"]);
		const toolResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_result" }> =>
				event.type === "tool_result",
		);
		expect(toolResults.map((event) => event.toolUseId)).toEqual(["tu_stop_1", "tu_stop_2"]);
		expect(toolResults.map((event) => event.isError)).toEqual([false, true]);
		expect(toolResults[1]?.metadata).toEqual({ skippedForSoftStop: true });
		expect(events.at(-1)).toEqual({ type: "turn_complete", turnIndex: 0 });
	});

	test("未禁用 eager 时 soft-stop 不会把已启动工具误标为跳过", async () => {
		providerScenario = "soft_stop_serial";
		providerAttempts = 0;
		executedToolValues.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			makeConfig(ac.signal, { shouldStop: () => true }),
			"finish tools that already started",
			[],
		)) {
			events.push(event);
		}

		expect(executedToolValues).toEqual(["serial:first", "serial:second"]);
		const toolResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_result" }> =>
				event.type === "tool_result",
		);
		expect(toolResults.map((event) => event.isError)).toEqual([false, false]);
		expect(toolResults.every((event) => event.metadata?.skippedForSoftStop !== true)).toBe(true);
	});

	test("after-tools 阶段到达的 soft-stop 会阻止下一轮模型请求", async () => {
		providerScenario = "soft_stop_serial";
		providerAttempts = 0;
		executedToolValues.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];
		let stopRequested = false;

		for await (const event of agentLoop(
			makeConfig(ac.signal, {
				deferEagerToolsForSafeStop: true,
				shouldStop: () => stopRequested,
				getSideCars: async (request) => {
					if (request.phase === "after_tools") stopRequested = true;
					return [];
				},
			}),
			"stop before the next provider turn",
			[],
		)) {
			events.push(event);
		}

		expect(providerAttempts).toBe(1);
		expect(executedToolValues).toEqual(["serial:first", "serial:second"]);
		expect(events.at(-1)).toEqual({ type: "turn_complete", turnIndex: 0 });
	});

	test("soft-stop 等待完整并行组后再跳过后续串行工具", async () => {
		providerScenario = "soft_stop_parallel";
		providerAttempts = 0;
		executedToolValues.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			makeConfig(ac.signal, {
				deferEagerToolsForSafeStop: true,
				shouldStop: () => true,
			}),
			"finish parallel reads then stop",
			[],
		)) {
			events.push(event);
		}

		expect(executedToolValues).toEqual(["read:first.txt", "read:second.txt"]);
		const toolResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_result" }> =>
				event.type === "tool_result",
		);
		expect(toolResults.map((event) => event.toolUseId)).toEqual([
			"tu_read_1",
			"tu_read_2",
			"tu_stop_3",
		]);
		expect(toolResults.at(-1)?.metadata).toEqual({ skippedForSoftStop: true });
		expect(events.at(-1)).toEqual({ type: "turn_complete", turnIndex: 0 });
	});

	test("soft-stop 只等待已 eager 启动的工具并跳过夹在中间的副作用工具", async () => {
		providerScenario = "soft_stop_interleaved";
		providerAttempts = 0;
		executedToolValues.length = 0;
		completedToolValues.length = 0;
		formattedToolResultOrder.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			makeConfig(ac.signal, { shouldStop: () => true }),
			"stop without running an unstarted edit",
			[],
		)) {
			events.push(event);
		}

		expect(executedToolValues).toContain("write:first.txt");
		expect(executedToolValues).toContain("read:started.txt");
		expect(executedToolValues).not.toContain("edit:first.txt");
		const toolResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_result" }> =>
				event.type === "tool_result",
		);
		expect(toolResults.find((event) => event.toolUseId === "tu_edit_must_skip")).toMatchObject({
			isError: true,
			metadata: { skippedForSoftStop: true },
		});
		expect(toolResults.find((event) => event.toolUseId === "tu_read_started")?.isError).toBe(false);
		expect(events.at(-1)).toEqual({ type: "turn_complete", turnIndex: 0 });
	});

	test("并行组按完成顺序立即产出事件但按调用顺序组装模型结果", async () => {
		providerScenario = "parallel_completion_order";
		providerAttempts = 0;
		executedToolValues.length = 0;
		completedToolValues.length = 0;
		formattedToolResultOrder.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			makeConfig(ac.signal, { deferEagerToolsForSafeStop: true }),
			"run parallel reads",
			[],
		)) {
			events.push(event);
		}

		expect(completedToolValues).toEqual(["read:fast.txt", "read:slow.txt"]);
		const toolResultIds = events
			.filter((event): event is Extract<AgentEvent, { type: "tool_result" }> => {
				return event.type === "tool_result";
			})
			.map((event) => event.toolUseId);
		expect(toolResultIds).toEqual(["tu_parallel_fast", "tu_parallel_slow"]);
		expect(formattedToolResultOrder).toEqual(["tu_parallel_slow", "tu_parallel_fast"]);
	});

	test("并行组完成后进入下一串行组前中断不会重复 drain 已即时产出的结果", async () => {
		providerScenario = "parallel_then_serial_abort";
		providerAttempts = 0;
		executedToolValues.length = 0;
		completedToolValues.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(makeConfig(ac.signal), "abort between tool groups", [])) {
			events.push(event);
			if (event.type === "assistant_message") {
				releaseParallelAbortTools();
			}
			if (
				event.type === "tool_result" &&
				(event.toolUseId === "tu_parallel_abort_1" || event.toolUseId === "tu_parallel_abort_2")
			) {
				ac.abort();
			}
		}

		const toolResultIds = events
			.filter(
				(event): event is Extract<AgentEvent, { type: "tool_result" }> =>
					event.type === "tool_result",
			)
			.map((event) => event.toolUseId);
		expect(toolResultIds).toEqual(["tu_parallel_abort_1", "tu_parallel_abort_2"]);
		expect(new Set(toolResultIds).size).toBe(toolResultIds.length);
		expect(executedToolValues).not.toContain("write:after-parallel.txt");
		expect(events.at(-1)).toEqual({ type: "error", message: "Aborted" });
	});

	test("交错 tool chunks 以 start 的 outputIndex 建立严格屏障和模型顺序", async () => {
		providerScenario = "interleaved_tool_chunk_order";
		providerAttempts = 0;
		executedToolValues.length = 0;
		formattedToolResultOrder.length = 0;
		modelToolResultOrder.length = 0;
		assistantToolUseOrders.length = 0;
		enterPlanStopEmitted = false;
		readStartedBeforeEnterPlanStop = false;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(makeConfig(ac.signal), "run interleaved tools", [])) {
			events.push(event);
		}

		const firstToolMessage = events.find(
			(event): event is Extract<AgentEvent, { type: "assistant_message" }> =>
				event.type === "assistant_message" && event.toolUses.length > 0,
		);
		const expectedToolOrder = [
			"tu_enter_plan_interleaved",
			"tu_write_interleaved",
			"tu_read_interleaved",
			"tu_unindexed_first",
			"tu_unindexed_second",
		];
		expect(readStartedBeforeEnterPlanStop).toBe(false);
		expect(firstToolMessage?.toolUses.map((toolUse) => toolUse.toolUseId)).toEqual(
			expectedToolOrder,
		);
		expect(executedToolValues).toEqual([
			"enter-plan",
			"write:ordered.txt",
			"read:ordered.txt",
			"serial:unindexed-first",
			"serial:unindexed-second",
		]);
		expect(formattedToolResultOrder).toEqual(expectedToolOrder);
		expect(modelToolResultOrder).toEqual(expectedToolOrder);
		expect(assistantToolUseOrders).toContainEqual(expectedToolOrder);
		expect(events.at(-1)).toEqual({ type: "done" });
	});

	test("EnterPlanMode 在 assistant_message 建立准备态之后才请求执行权限", async () => {
		providerScenario = "enter_plan_prepared_order";
		providerAttempts = 0;
		formattedToolResultOrder.length = 0;
		const ac = new AbortController();
		const order: string[] = [];

		for await (const event of agentLoop(
			makeConfig(ac.signal, {
				shouldStop: () => true,
				permissionHandler: async (toolName) => {
					if (toolName === "EnterPlanMode") order.push("permission");
					return { behavior: "deny" };
				},
			}),
			"enter plan mode",
			[],
		)) {
			if (event.type === "assistant_message") order.push("assistant_message");
		}

		expect(order).toEqual(["assistant_message", "permission"]);
	});

	test("宽松计划模式下非只读工具结果会注入计划提醒 sidecar", async () => {
		providerScenario = "abort";
		providerAttempts = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			makeConfig(ac.signal, { planMode: true, relaxedPlan: true }),
			"run tools while planning",
			[],
		)) {
			events.push(event);
			if (event.type === "stream_text") {
				ac.abort();
			}
		}

		const toolResult = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_result" }> =>
				event.type === "tool_result",
		);
		expect(toolResult?.sideCars?.some((sideCar) => sideCar.source === "relaxed_plan")).toBe(true);
		expect(
			toolResult?.sideCars?.some((sideCar) => sideCar.content.includes("<relaxed_plan_reminder>")),
		).toBe(true);
		expect(toolResult?.output).not.toContain("<relaxed_plan_reminder>");
	});

	test("流式工具参数跨 chunk 的换行转义会被正确还原", async () => {
		providerScenario = "split_streaming_escape";
		providerAttempts = 0;
		const ac = new AbortController();
		let streamedText = "";

		for await (const event of agentLoop(makeConfig(ac.signal), "write a multiline file", [])) {
			if (event.type === "tool_use_chunk" && event.streamingField?.delta) {
				streamedText += event.streamingField.delta;
				if (streamedText.includes("line2")) break;
			}
		}

		expect(providerAttempts).toBe(1);
		expect(streamedText).toBe("line1\nline2");
		expect(streamedText).not.toContain("\\n");
	});

	test("工具执行已启动后遇到 retryable 截断流时不重试并保留结果", async () => {
		providerScenario = "truncated_after_tool";
		providerAttempts = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			makeConfig(ac.signal, { maxTransientRetries: 2 }),
			"run tools then truncate",
			[],
		)) {
			events.push(event);
		}

		expect(providerAttempts).toBe(1);
		expect(events.some((event) => event.type === "retrying")).toBe(false);
		expect(events.some((event) => event.type === "retryable_error")).toBe(false);

		const toolResults = events.filter((event) => event.type === "tool_result");
		expect(toolResults).toHaveLength(2);
		expect(toolResults.map((event) => event.output)).toEqual(["completed:one", "completed:two"]);

		const lastEvent = events.at(-1);
		expect(lastEvent).toMatchObject({
			type: "invalid_state",
			reason: "stream_closed_before_response_completed",
			message: "Responses API stream closed before response.completed.",
		});
	});

	test("Codex 切号重试前保留已输出文本并要求外层重建 history", async () => {
		providerScenario = "codex_rebuild_after_text";
		providerAttempts = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(makeConfig(ac.signal), "answer then quota", [])) {
			events.push(event);
		}

		expect(providerAttempts).toBe(1);
		expect(events).toContainEqual({ type: "stream_text", text: "partial codex output" });
		const textBlock = events.find(
			(event): event is Extract<AgentEvent, { type: "block_complete" }> =>
				event.type === "block_complete" && event.block.type === "text",
		);
		expect(textBlock?.block).toMatchObject({ type: "text", text: "partial codex output" });
		const lastEvent = events.at(-1);
		expect(lastEvent).toEqual({
			type: "retryable_error",
			message: "The usage limit has been reached",
			code: CODEX_REBUILD_HISTORY_RETRY_CODE,
			bypassRetryLimit: true,
		});
	});

	test("Codex 切号重试前保留已启动工具结果并要求外层重建 history", async () => {
		providerScenario = "codex_rebuild_after_tool";
		providerAttempts = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(makeConfig(ac.signal), "tool then quota", [])) {
			events.push(event);
		}

		expect(providerAttempts).toBe(1);
		const toolResults = events.filter((event) => event.type === "tool_result");
		expect(toolResults).toHaveLength(2);
		expect(toolResults.map((event) => event.output)).toEqual(["completed:one", "completed:two"]);
		const lastEvent = events.at(-1);
		expect(lastEvent).toEqual({
			type: "retryable_error",
			message: "The usage limit has been reached",
			code: CODEX_REBUILD_HISTORY_RETRY_CODE,
			bypassRetryLimit: true,
		});
	});
});
