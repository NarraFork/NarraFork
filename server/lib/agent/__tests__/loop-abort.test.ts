import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import { CODEX_REBUILD_HISTORY_RETRY_CODE, CodexRebuildHistoryRetryError } from "../codex-errors";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent } from "../types";

const TEST_TOOL_NAME = "TestAbortDrainTool";

let providerScenario:
	| "abort"
	| "truncated_after_tool"
	| "codex_rebuild_after_text"
	| "codex_rebuild_after_tool" = "abort";
let providerAttempts = 0;

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
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

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
	execute: async (args) => ({ output: `completed:${args.value}` }),
});

afterAll(() => {
	toolRegistry.unregister(TEST_TOOL_NAME);
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
		expect(lastEvent).toEqual({
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
