import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ProviderAdapter } from "../provider";
import { type AgentConfig, type AgentEvent, ApiError } from "../types";

/**
 * These tests pin the two halves of the "every failure looks the same" defect:
 *
 * 1. Attribution: a real upstream error (e.g. 503) followed by an attempt that
 *    only carries bookkeeping events (usage/queue) must still be reported as
 *    that upstream error. Previously any `isMeaningfulStreamEvent` — including a
 *    pure queue notice — cleared the stored cause, so the turn fell back to the
 *    generic "check base URL / model / credentials" empty-response text.
 *
 * 2. Classification: when a turn genuinely produces nothing, the reported reason
 *    must name what the upstream actually did instead of collapsing every case
 *    into one message.
 */
let providerScenario:
	| "error_then_usage_only"
	| "error_then_queue_only"
	| "usage_only_forever"
	| "no_events_forever"
	| "stop_reason_without_content_forever"
	| "truncated_tool_input_forever" = "error_then_usage_only";
let providerAttempts = 0;

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		providerAttempts++;
		params.onRequestStart?.();

		if (providerScenario === "error_then_usage_only") {
			if (providerAttempts === 1) {
				throw new ApiError(503, "NUG chat error 503: model upstream unavailable", {
					schema: "narrafork.error-diagnostics.v1",
					source: "gateway",
					statusCode: 503,
					requestId: "req-503",
				});
			}
			// Bookkeeping only: proves the request was served, commits no content.
			yield { usage: { promptTokens: 1200, completionTokens: 0 } };
			return;
		}

		if (providerScenario === "error_then_queue_only") {
			if (providerAttempts === 1) {
				throw new ApiError(503, "NUG chat error 503: model upstream unavailable", {
					schema: "narrafork.error-diagnostics.v1",
					source: "gateway",
					statusCode: 503,
					requestId: "req-503",
				});
			}
			// `queueStatus` counts as "meaningful" for liveness but lands nothing.
			yield { queueStatus: { position: 2, queueDepth: 5 } };
			return;
		}

		if (providerScenario === "usage_only_forever") {
			yield { usage: { promptTokens: 900, completionTokens: 0 } };
			return;
		}

		if (providerScenario === "no_events_forever") {
			return;
		}

		if (providerScenario === "stop_reason_without_content_forever") {
			yield { stopReason: "content_filter" };
			return;
		}

		if (providerScenario === "truncated_tool_input_forever") {
			// A named tool call whose input stream is cut off before `stop`.
			yield { toolUseChunk: { toolUseId: "tu-1", name: "Bash" } };
			yield { toolUseChunk: { toolUseId: "tu-1", input: '{"command":"ec' } };
			return;
		}
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
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

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	mock.restore();
});

function makeConfig(signal: AbortSignal, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		narratorId: "n-empty-attribution",
		conversationId: "conv-empty-attribution",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		// Keep retry backoff negligible so the test doesn't wait the real delay.
		retryBackoffCeilMs: 1,
		...overrides,
	};
}

async function runLoop(overrides: Partial<AgentConfig> = {}): Promise<AgentEvent[]> {
	const ac = new AbortController();
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(makeConfig(ac.signal, overrides), "go", [])) {
		events.push(event);
	}
	return events;
}

describe("空响应归因链", () => {
	test("上游 503 后仅收到 usage 事件时，仍报告 503 而非空响应", async () => {
		providerScenario = "error_then_usage_only";
		providerAttempts = 0;

		// One transient retry allowed: attempt 1 throws 503, attempt 2 is usage-only.
		const events = await runLoop({ maxTransientRetries: 1 });

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("retryable_error");
		const message = (terminal as { message: string }).message;
		expect(message).toContain("503");
		// The misleading configuration advice must not appear.
		expect(message).not.toContain("base URL");
		expect((terminal as { diagnostics?: { statusCode?: number } }).diagnostics?.statusCode).toBe(
			503,
		);
	});

	test("上游 503 后仅收到 queue 事件时，仍报告 503 而非空响应", async () => {
		providerScenario = "error_then_queue_only";
		providerAttempts = 0;

		const events = await runLoop({ maxTransientRetries: 1 });

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("retryable_error");
		expect((terminal as { message: string }).message).toContain("503");
		expect((terminal as { message: string }).message).not.toContain("base URL");
	});
});

describe("空响应细分归因", () => {
	test("完全没有事件时报告 no_events", async () => {
		providerScenario = "no_events_forever";
		providerAttempts = 0;

		const events = await runLoop();

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("invalid_state");
		expect((terminal as { reason: string }).reason).toBe("empty_response_no_events");
		expect(
			(terminal as { diagnostics?: { responseSnippet?: string } }).diagnostics?.responseSnippet,
		).toContain("events=0");
	});

	test("只有 usage 事件时报告 usage_only，且不建议检查本地配置", async () => {
		providerScenario = "usage_only_forever";
		providerAttempts = 0;

		const events = await runLoop();

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("invalid_state");
		expect((terminal as { reason: string }).reason).toBe("empty_response_usage_only");
		const message = (terminal as { message: string }).message;
		// The request demonstrably reached the model, so pointing at local config is wrong.
		expect(message).not.toContain("base URL");
		expect(message).toContain("upstream");
		expect(
			(terminal as { diagnostics?: { responseSnippet?: string } }).diagnostics?.responseSnippet,
		).toContain("usage=true");
	});

	test("有 stopReason 但无内容时报告 stop_without_content 并带上 stopReason", async () => {
		providerScenario = "stop_reason_without_content_forever";
		providerAttempts = 0;

		const events = await runLoop();

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("invalid_state");
		expect((terminal as { reason: string }).reason).toBe("empty_response_stop_without_content");
		expect((terminal as { message: string }).message).toContain("content_filter");
		expect(
			(terminal as { diagnostics?: { responseSnippet?: string } }).diagnostics?.responseSnippet,
		).toContain("stopReason=content_filter");
	});

	test("工具输入被截断不归入空响应，而是走 broken-tool-call 恢复路径", async () => {
		providerScenario = "truncated_tool_input_forever";
		providerAttempts = 0;

		// A named-but-truncated tool accumulator counts as persistable output, so this
		// case must never be reported as an empty response. It has its own recovery
		// (the broken-tool-call reminder), which keeps re-prompting until max turns.
		const events = await runLoop({ maxTurns: 2 });

		expect(
			events.some(
				(e) => e.type === "invalid_state" && (e as { reason: string }).reason.startsWith("empty_"),
			),
		).toBe(false);
		// The turn still completes as an assistant message rather than a hard failure.
		expect(events.some((e) => e.type === "assistant_message")).toBe(true);
	});
});
