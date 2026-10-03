import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { diskSpaceMonitor } from "../../disk-safety";
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
	| "streaming_field_boundaries"
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
let streamingBoundaryClock = 0;
let streamingBoundaryTool = "Write";
let streamingBoundaryChunks: Array<{
	input?: string;
	finalInput?: string;
	flatInput?: Record<string, unknown>;
	advanceMs?: number;
	stop?: boolean;
}> = [];
const executedToolValues: string[] = [];
const completedToolValues: string[] = [];
const formattedToolResultOrder: string[] = [];
const modelToolResultOrder: string[] = [];
const assistantToolUseOrders: string[][] = [];
let enterPlanStopEmitted = false;
let readStartedBeforeEnterPlanStop = false;
let releasePendingTool: (() => void) | undefined;
const parallelAbortResolvers: Array<() => void> = [];

function createGate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

interface ParallelPreflightGate {
	firstPath: string;
	secondPath: string;
	firstHeld: boolean;
	firstRelease: ReturnType<typeof createGate>;
	secondStarted: ReturnType<typeof createGate>;
}
let parallelPreflight: ParallelPreflightGate | undefined;
const diskAssessment = spyOn(diskSpaceMonitor, "assess");
beforeEach(() => {
	parallelPreflight = undefined;
	// These fake tools exercise loop barriers, not host disk health. Real statfs/ancestor
	// lookup latency can invert parallel execute() entry even on unchanged HEAD. Keep
	// all original order assertions; inject controlled preflight latency in the cases below.
	diskAssessment.mockImplementation(async (path) => {
		const gate = parallelPreflight;
		if (gate && path.split(/[\\/]/).at(-1) === gate.firstPath) {
			gate.firstHeld = true;
			await gate.firstRelease.promise;
		}
		return { path, level: "ok", space: null };
	});
});

let serialToolsCompleted: ReturnType<typeof createGate> | undefined;
let parallelToolsStarted = createGate();
let writeExecutionGate:
	| { started: ReturnType<typeof createGate>; release: ReturnType<typeof createGate> }
	| undefined;

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
		if (providerScenario === "streaming_field_boundaries") {
			for (const { input, finalInput, flatInput, advanceMs = 0, stop } of streamingBoundaryChunks) {
				streamingBoundaryClock += advanceMs;
				if (flatInput) {
					yield {
						toolUses: [
							{ toolUseId: "tu_field_boundaries", name: streamingBoundaryTool, input: flatInput },
						],
					};
					continue;
				}
				yield {
					toolUseChunk: {
						toolUseId: "tu_field_boundaries",
						name: streamingBoundaryTool,
						input,
						...(finalInput != null && { finalInput }),
						stop,
					},
				};
			}
			return;
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
					{ toolUseId: "tu_read_must_skip", name: "Read", input: { file_path: "must-skip.txt" } },
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
		// These interruption fixtures require BOTH serial calls to have actually run.
		// Receiving toolUses is not evidence that a later execution group has started.
		if (providerScenario === "abort" || providerScenario === "codex_rebuild_after_tool") {
			await serialToolsCompleted?.promise;
		}
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
		completedToolValues.push(`serial:${args.value}`);
		if (args.value === "two") serialToolsCompleted?.resolve();
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
		const preflight = parallelPreflight;
		if (preflight && preflight.secondPath === args.file_path) preflight.secondStarted.resolve();
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
			await new Promise<void>((resolve) => {
				parallelAbortResolvers.push(resolve);
				if (parallelAbortResolvers.length === 2) parallelToolsStarted.resolve();
			});
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
		if (writeExecutionGate) {
			writeExecutionGate.started.resolve();
			await writeExecutionGate.release.promise;
		}
		completedToolValues.push(`write:${args.file_path}`);
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
	parallelPreflight?.firstRelease.resolve();
	diskAssessment.mockRestore();
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
		executedToolValues.length = 0;
		completedToolValues.length = 0;
		serialToolsCompleted = createGate();
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(makeConfig(ac.signal), "run tools then answer", [])) {
			events.push(event);
			if (event.type === "stream_text") {
				expect(executedToolValues).toEqual(["serial:one", "serial:two"]);
				expect(completedToolValues).toEqual(["serial:one", "serial:two"]);
				ac.abort();
			}
		}
		serialToolsCompleted = undefined;

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

		// The stop must arrive AFTER the first tool was eagerly started, which is the
		// only situation where mislabeling is possible: its side effects have already
		// happened, so it has to be awaited and reported with its real result.
		// (`shouldStop: () => true` cannot express this — a stop pending before any tool
		// exists now suppresses the eager start itself, so nothing is ever "started".)
		let asks = 0;
		for await (const event of agentLoop(
			makeConfig(ac.signal, { shouldStop: () => ++asks > 1 }),
			"finish tools that already started",
			[],
		)) {
			events.push(event);
		}

		// First tool ran (started before the stop); the second never started.
		expect(executedToolValues).toEqual(["serial:first"]);
		const toolResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_result" }> =>
				event.type === "tool_result",
		);
		expect(toolResults.map((event) => event.toolUseId)).toEqual(["tu_stop_1", "tu_stop_2"]);
		// The already-started tool keeps its real success result…
		expect(toolResults[0]?.isError).toBe(false);
		expect(toolResults[0]?.metadata?.skippedForSoftStop).toBeUndefined();
		// …while the one that never ran is explicitly reported as skipped.
		expect(toolResults[1]?.metadata).toEqual({ skippedForSoftStop: true });
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
				// The after-tools boundary is now reached through `getAfterToolsInjections`
				// (the side-car phase of the same name is gone); the race this pins — user
				// feedback landing between the last tool and the next request — is unchanged.
				getAfterToolsInjections: () => {
					stopRequested = true;
					return "";
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

	test("soft-stop 等待已 eager 启动的 Write 并跳过后续 Edit 和 Read", async () => {
		providerScenario = "soft_stop_interleaved";
		providerAttempts = 0;
		executedToolValues.length = 0;
		completedToolValues.length = 0;
		formattedToolResultOrder.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		// Request stop while Write is genuinely running, before allowing it to finish.
		// Later groups must not overtake that write or acquire side effects after stop.
		const gate = { started: createGate(), release: createGate() };
		writeExecutionGate = gate;
		let stopRequested = false;
		let completedWhenStopRequested: string[] = [];
		const requestStop = gate.started.promise.then(() => {
			completedWhenStopRequested = [...completedToolValues];
			stopRequested = true;
			gate.release.resolve();
		});
		for await (const event of agentLoop(
			makeConfig(ac.signal, {
				shouldStop: () => stopRequested,
			}),
			"stop without running an unstarted edit",
			[],
		)) {
			events.push(event);
		}

		await requestStop;
		writeExecutionGate = undefined;
		expect(completedWhenStopRequested).toEqual([]);
		expect(executedToolValues).toEqual(["write:first.txt"]);
		expect(completedToolValues).toEqual(["write:first.txt"]);
		const toolResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_result" }> =>
				event.type === "tool_result",
		);
		expect(toolResults.find((event) => event.toolUseId === "tu_edit_must_skip")).toMatchObject({
			isError: true,
			metadata: { skippedForSoftStop: true },
		});
		expect(toolResults.map((event) => event.toolUseId)).toEqual([
			"tu_write_before_stop",
			"tu_edit_must_skip",
			"tu_read_must_skip",
		]);
		expect(toolResults[0]).toMatchObject({ isError: false, output: "write:first.txt" });
		expect(toolResults[0]?.metadata?.skippedForSoftStop).toBeUndefined();
		expect(toolResults[2]).toMatchObject({
			isError: true,
			metadata: { skippedForSoftStop: true },
		});
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
		parallelToolsStarted = createGate();
		const ac = new AbortController();
		const events: AgentEvent[] = [];
		// assistant_message can precede execute(): release only after both reads
		// installed their resolvers, without blocking the event consumer itself.
		const releaseReads = parallelToolsStarted.promise.then(releaseParallelAbortTools);

		for await (const event of agentLoop(makeConfig(ac.signal), "abort between tool groups", [])) {
			events.push(event);
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
		await releaseReads;
		expect(executedToolValues).toEqual(["read:parallel-1.txt", "read:parallel-2.txt"]);
		expect(completedToolValues).toEqual(["read:parallel-1.txt", "read:parallel-2.txt"]);
		expect(toolResultIds).toEqual([
			"tu_parallel_abort_1",
			"tu_parallel_abort_2",
			"tu_serial_after_parallel",
		]);
		expect(
			events.find(
				(event) => event.type === "tool_result" && event.toolUseId === "tu_serial_after_parallel",
			),
		).toMatchObject({ isError: true, durationMs: 0 });
		expect(new Set(toolResultIds).size).toBe(toolResultIds.length);
		expect(executedToolValues).not.toContain("write:after-parallel.txt");
		expect(events.at(-1)).toEqual({ type: "error", message: "Aborted" });
	});

	for (const abortAfterFirstResult of [false, true]) {
		test(
			abortAfterFirstResult
				? "受控逆序磁盘预检：并行完成后中断不重复 drain，也不启动后续串行工具"
				: "受控逆序磁盘预检：soft-stop 仍等待完整并行组，并按调用顺序组装模型结果",
			async () => {
				providerScenario = abortAfterFirstResult
					? "parallel_then_serial_abort"
					: "soft_stop_parallel";
				providerAttempts = 0;
				executedToolValues.length = 0;
				completedToolValues.length = 0;
				formattedToolResultOrder.length = 0;
				parallelToolsStarted = createGate();
				const gate: ParallelPreflightGate = {
					firstPath: abortAfterFirstResult ? "parallel-1.txt" : "first.txt",
					secondPath: abortAfterFirstResult ? "parallel-2.txt" : "second.txt",
					firstHeld: false,
					firstRelease: createGate(),
					secondStarted: createGate(),
				};
				parallelPreflight = gate;
				const firstId = abortAfterFirstResult ? "tu_parallel_abort_1" : "tu_read_1";
				const secondId = abortAfterFirstResult ? "tu_parallel_abort_2" : "tu_read_2";
				const serialId = abortAfterFirstResult ? "tu_serial_after_parallel" : "tu_stop_3";
				const permissionOrder: string[] = [];
				const ac = new AbortController();
				const events: AgentEvent[] = [];
				let stopRequested = false;
				let heldWhenSecondStarted = false;
				const observeSecond = gate.secondStarted.promise.then(() => {
					heldWhenSecondStarted = gate.firstHeld;
					// Abort fixture waits until both execute() calls installed their resolvers.
					// The soft-stop fixture instead holds first until second's result is delivered.
					if (abortAfterFirstResult) gate.firstRelease.resolve();
				});
				const releaseReads = abortAfterFirstResult
					? parallelToolsStarted.promise.then(releaseParallelAbortTools)
					: Promise.resolve();
				try {
					for await (const event of agentLoop(
						makeConfig(ac.signal, {
							deferEagerToolsForSafeStop: !abortAfterFirstResult,
							shouldStop: () => stopRequested,
							permissionHandler: async (_name, _input, id) => {
								permissionOrder.push(id);
								return { behavior: "allow" };
							},
						}),
						"parallel preflight completes out of order",
						[],
					)) {
						events.push(event);
						if (event.type !== "tool_result" || event.toolUseId !== secondId) continue;
						if (abortAfterFirstResult) ac.abort();
						else {
							expect(gate.firstHeld).toBe(true);
							expect(executedToolValues).toEqual([`read:${gate.secondPath}`]);
							stopRequested = true;
							gate.firstRelease.resolve();
						}
					}
					await observeSecond;
					await releaseReads;
					expect(heldWhenSecondStarted).toBe(true);
					expect(permissionOrder).toEqual([firstId, secondId]);
					expect(executedToolValues).toEqual([`read:${gate.secondPath}`, `read:${gate.firstPath}`]);
					expect(completedToolValues).toEqual([
						`read:${gate.secondPath}`,
						`read:${gate.firstPath}`,
					]);
					const results = events.filter(
						(event): event is Extract<AgentEvent, { type: "tool_result" }> =>
							event.type === "tool_result",
					);
					const ids = results.map((event) => event.toolUseId);
					expect(ids).toEqual([secondId, firstId, serialId]);
					expect(new Set(ids).size).toBe(ids.length);
					expect(results.slice(0, 2).map((event) => event.isError)).toEqual([false, false]);
					expect(providerAttempts).toBe(1);
					if (abortAfterFirstResult) {
						expect(results[2]).toMatchObject({ isError: true, durationMs: 0 });
						expect(events.at(-1)).toEqual({ type: "error", message: "Aborted" });
					} else {
						expect(results[2]?.metadata).toEqual({ skippedForSoftStop: true });
						expect(formattedToolResultOrder).toEqual([firstId, secondId, serialId]);
						expect(events.at(-1)).toEqual({ type: "turn_complete", turnIndex: 0 });
					}
				} finally {
					gate.firstRelease.resolve();
					releaseParallelAbortTools();
				}
			},
		);
	}

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

	test("宽松计划模式下的计划提醒不会污染工具输出，且被中断时不投递", async () => {
		// The reminder used to be a side-car appended inside the tool result's string; it is
		// now delivered as its own message row at the TURN BOUNDARY.
		//
		// That boundary is never reached when the user aborts mid-turn, so an aborted turn
		// delivers nothing — which is the right outcome and self-correcting: the reminder is
		// re-raised on the next non-read-only tool call, and nothing was persisted or
		// acknowledged on the strength of a message the model never saw.
		providerScenario = "abort";
		providerAttempts = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];
		const delivered: string[] = [];

		for await (const event of agentLoop(
			makeConfig(ac.signal, {
				planMode: true,
				relaxedPlan: true,
				deliverInjectionRow: (injection) => {
					delivered.push(injection.source);
					return injection.content;
				},
			}),
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
		// The invariant that matters either way: the reminder is never mixed into the tool
		// output the reader sees. There is no longer any channel on the tool result that
		// could carry it — `tool_result` has no injection field at all.
		expect(toolResult?.output).not.toContain("<relaxed_plan_reminder>");
		expect(delivered).not.toContain("relaxed_plan");
	});

	test("宽松计划模式下的计划提醒在回合边界作为独立消息行投递", async () => {
		// The positive case: a turn that reaches its boundary hands the reminder to the host
		// for persistence, and gets the text back to fold into the next request.
		providerScenario = "soft_stop_serial";
		providerAttempts = 0;
		const ac = new AbortController();
		const delivered: Array<{ source: string; content: string }> = [];
		let stopAfterBoundary = false;

		for await (const _event of agentLoop(
			makeConfig(ac.signal, {
				planMode: true,
				relaxedPlan: true,
				shouldStop: () => stopAfterBoundary,
				deliverInjectionRow: (injection) => {
					delivered.push({ source: injection.source, content: injection.content });
					// Stop once the boundary has been reached, so the loop does not run on.
					stopAfterBoundary = true;
					return injection.content;
				},
			}),
			"run tools while planning",
			[],
		)) {
			// drain
		}

		expect(delivered.some((injection) => injection.source === "relaxed_plan")).toBe(true);
		expect(
			delivered.some((injection) => injection.content.includes("<relaxed_plan_reminder>")),
		).toBe(true);
	});

	test("流式工具参数跨 chunk 的换行转义会被正确还原", async () => {
		providerScenario = "split_streaming_escape";
		providerAttempts = 0;
		const ac = new AbortController();
		let streamedText = "";
		const startsField: Array<boolean | undefined> = [];

		for await (const event of agentLoop(makeConfig(ac.signal), "write a multiline file", [])) {
			if (event.type === "tool_use_chunk" && event.streamingField?.delta) {
				startsField.push(event.streamingField.startsField);
				streamedText += event.streamingField.delta;
				if (streamedText.includes("line2")) break;
			}
		}

		expect(providerAttempts).toBe(1);
		expect(streamedText).toBe("line1\nline2");
		expect(streamedText).not.toContain("\\n");
		expect(startsField).toEqual([true, false]);
	});

	for (const scenario of [
		{
			name: "首段 Unicode 转义未完整时保留起点，stop flush 仍标记 true",
			tool: "Write",
			chunks: [
				{ input: '{"file_path":"split.txt","content":"\\u0' },
				{ input: "041tail", stop: true },
			],
			expected: [
				{ name: "content", delta: "Atail", startsField: true, offset: 0, complete: false },
			],
		},
		{
			name: "已发送首段后 stop flush 的续段标记 false",
			tool: "Write",
			chunks: [
				{ input: '{"file_path":"split.txt","content":"first' },
				{ input: "tail", stop: true },
			],
			expected: [
				{ name: "content", delta: "first", startsField: true, offset: 0, complete: false },
				{ name: "content", delta: "tail", startsField: false, offset: 5, complete: false },
			],
		},
		{
			name: "节流合并多个原始 chunk 后仍从字段起点发送",
			tool: "Write",
			chunks: [
				{ input: '{"file_path":"split.txt",' },
				{ input: '"content":"first' },
				{ input: "tail", advanceMs: 50 },
			],
			expected: [
				{ name: "content", delta: "firsttail", startsField: true, offset: 0, complete: false },
			],
		},
		{
			name: "Edit 切换字段后重置起点，起始转义完成前不消耗标记",
			tool: "Edit",
			chunks: [
				{ input: '{"file_path":"split.txt","old_string":"old' },
				{ input: "tail", advanceMs: 50 },
				{ input: '","new_string":"\\' },
				{ input: "nnew", advanceMs: 50 },
				{ input: "tail", advanceMs: 50 },
			],
			expected: [
				{ name: "old_string", delta: "old", startsField: true, offset: 0, complete: false },
				{ name: "old_string", delta: "tail", startsField: false, offset: 3, complete: false },
				{ name: "old_string", delta: "", startsField: false, offset: 7, complete: true },
				{ name: "new_string", delta: "\nnew", startsField: true, offset: 0, complete: false },
				{ name: "new_string", delta: "tail", startsField: false, offset: 4, complete: false },
			],
		},
	]) {
		test(scenario.name, async () => {
			providerScenario = "streaming_field_boundaries";
			providerAttempts = 0;
			streamingBoundaryTool = scenario.tool;
			streamingBoundaryChunks = scenario.chunks;
			streamingBoundaryClock = Date.now();
			const clock = spyOn(Date, "now").mockImplementation(() => streamingBoundaryClock);
			const deltas: Array<{ name: string; delta: string; startsField?: boolean }> = [];
			try {
				for await (const event of agentLoop(
					makeConfig(new AbortController().signal),
					"stream tool arguments",
					[],
				)) {
					if (event.type !== "tool_use_chunk" || !event.streamingField) continue;
					deltas.push(event.streamingField);
					if (deltas.length === scenario.expected.length) break;
				}
				expect(providerAttempts).toBe(1);
				expect(deltas).toEqual(scenario.expected);
			} finally {
				clock.mockRestore();
			}
		});
	}

	for (const scenario of [
		{
			name: "同 chunk 关闭旧字段并完成新字段不会丢尾段",
			tool: "Edit",
			chunks: [
				{ input: '{"file_path":"split.txt","old_string":"old' },
				{ input: 'tail","new_string":"new\\r\\n\\ud83d\\ude00"}', stop: true },
			],
			final: { file_path: "split.txt", old_string: "oldtail", new_string: "new\r\n😀" },
		},
		{
			name: "Gemini 整包参数经过相同字段与完成管线",
			tool: "Write",
			chunks: [
				{ input: JSON.stringify({ file_path: "split.txt", content: "whole\r\n😀" }), stop: true },
			],
			final: { file_path: "split.txt", content: "whole\r\n😀" },
		},
		{
			name: "非 append 最终 snapshot 重置字段而不污染完整执行输入",
			tool: "Write",
			chunks: [
				{ input: '{"file_path":"split.txt","content":"draft' },
				{ finalInput: '{"file_path":"split.txt","content":"final"}', stop: true },
			],
			final: { file_path: "split.txt", content: "final" },
		},
		{
			name: "最终 snapshot 确为前缀续写时只发送新 suffix",
			tool: "Write",
			chunks: [
				{ input: '{"file_path":"split.txt","content":"a' },
				{ finalInput: '{"file_path":"split.txt","content":"abc"}', stop: true },
			],
			final: { file_path: "split.txt", content: "abc" },
		},
		{
			name: "flat toolUses 接管前补齐并 flush 未发送字段尾段",
			tool: "Write",
			chunks: [
				{ input: '{"file_path":"split.txt","content":"a' },
				{ flatInput: { file_path: "split.txt", content: "abc" } },
			],
			final: { file_path: "split.txt", content: "abc" },
		},
		{
			name: "content 完成后短字段变化不反复广播累计全文",
			tool: "Write",
			chunks: [
				{ input: '{"content":"large-body",' },
				{ input: '"file_path":"split.txt"', advanceMs: 50 },
				{ input: "}", stop: true },
			],
			final: { file_path: "split.txt", content: "large-body" },
		},
	]) {
		test(scenario.name, async () => {
			providerScenario = "streaming_field_boundaries";
			providerAttempts = 0;
			streamingBoundaryTool = scenario.tool;
			streamingBoundaryChunks = scenario.chunks;
			streamingBoundaryClock = Date.now();
			const clock = spyOn(Date, "now").mockImplementation(() => streamingBoundaryClock);
			const events: AgentEvent[] = [];
			try {
				for await (const event of agentLoop(
					makeConfig(new AbortController().signal),
					"stream complete tool",
					[],
				)) {
					events.push(event);
					if (event.type === "tool_call") break;
				}
				const fields: Record<string, string> = {};
				const completed = new Set<string>();
				for (const event of events) {
					if (event.type !== "tool_use_chunk") continue;
					expect(event.extractedFields?.content).toBeUndefined();
					expect(event.extractedFields?.old_string).toBeUndefined();
					expect(event.extractedFields?.new_string).toBeUndefined();
					const field = event.streamingField;
					if (!field) continue;
					if (field.startsField) fields[field.name] = "";
					expect(field.offset).toBe(fields[field.name]?.length ?? 0);
					fields[field.name] = (fields[field.name] ?? "") + field.delta;
					if (field.complete) completed.add(field.name);
				}
				for (const name of scenario.tool === "Edit" ? ["old_string", "new_string"] : ["content"]) {
					const expected = (scenario.final as Record<string, string | undefined>)[name];
					if (expected === undefined) throw new Error(`Missing fixture field: ${name}`);
					expect(fields[name]).toBe(expected);
					expect(completed.has(name)).toBe(true);
				}
				const call = events.find((event) => event.type === "tool_call");
				expect(call?.type === "tool_call" && call.input).toEqual(scenario.final);
				expect(events.findIndex((event) => event.type === "block_complete")).toBeLessThan(
					events.findIndex((event) => event.type === "tool_call"),
				);
				if (scenario.name.includes("suffix")) {
					const starts = events.filter(
						(event) => event.type === "tool_use_chunk" && event.streamingField?.startsField,
					);
					expect(starts).toHaveLength(1);
				}
			} finally {
				clock.mockRestore();
			}
		});
	}

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

		// Ended as RESUMABLE, not as a hard failure. The tools above already ran and had
		// side effects, so a terminal event would strand them: both executors turn
		// `invalid_state` into an error state, whereas `resumable_error` is an interrupted
		// pass whose continuation is capped by the caller's interruption budget.
		const lastEvent = events.at(-1);
		expect(lastEvent).toMatchObject({
			type: "resumable_error",
			message: "Responses API stream closed before response.completed.",
		});
		// The originating reason still travels with the event for diagnostics.
		expect(
			(lastEvent as Extract<AgentEvent, { type: "resumable_error" }>).diagnostics,
		).toMatchObject({ reason: "stream_closed_before_response_completed" });
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
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "stream_text",
				text: "partial codex output",
				blockId: expect.any(String),
				blockRevision: 1,
				blockTextOffset: 0,
			}),
		);
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
		executedToolValues.length = 0;
		completedToolValues.length = 0;
		serialToolsCompleted = createGate();
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(makeConfig(ac.signal), "tool then quota", [])) {
			events.push(event);
		}
		serialToolsCompleted = undefined;

		expect(executedToolValues).toEqual(["serial:one", "serial:two"]);
		expect(completedToolValues).toEqual(["serial:one", "serial:two"]);
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
