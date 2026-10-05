import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import { settings } from "../../settings";
import { AnthropicProvider } from "../anthropic-provider";
import {
	clearCodexResponsesWebSocketSessions,
	streamCodexResponsesWebSocket,
} from "../codex-websocket";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
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
	| "truncated_tool_input_forever"
	| "reasoning_then_truncated_tool_input"
	| "broken_anthropic_single"
	| "broken_anthropic_mixed"
	| "ws_error_response" = "error_then_usage_only";
let providerAttempts = 0;
let wsBaseUrl = "";
/** `content` (user-side turn text) seen by each provider.chat() call, in order. */
let sentContents: string[] = [];
let sentToolResults: unknown[][] = [];
let sentHistories: unknown[][] = [];
const RECOVERY_TOOL = "__BrokenInputRecoveryTest";
const anthropicFormatter = new AnthropicProvider({
	id: "recovery-test",
	prefix: "recovery-test",
	baseUrl: "https://example.invalid/v1",
	apiKey: "test",
} as never);
function usesAnthropicRecovery(): boolean {
	return (
		providerScenario === "broken_anthropic_single" || providerScenario === "broken_anthropic_mixed"
	);
}

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		providerAttempts++;
		sentContents.push(params.content ?? "");
		params.onRequestStart?.();

		if (usesAnthropicRecovery()) {
			sentToolResults.push(structuredClone(params.toolResults ?? []));
			sentHistories.push(structuredClone(params.history));
			if (providerAttempts === 1) {
				yield {
					toolUseChunk: {
						toolUseId: "broken-call",
						name: RECOVERY_TOOL,
						input: '{"content":}',
						stop: true,
					},
				};
				if (providerScenario === "broken_anthropic_mixed") {
					yield {
						toolUseChunk: {
							toolUseId: "valid-call",
							name: RECOVERY_TOOL,
							input: '{"content":"ok"}',
							stop: true,
						},
					};
				}
			} else {
				yield { text: "recovered" };
			}
			return;
		}

		if (providerScenario === "ws_error_response") {
			yield* streamCodexResponsesWebSocket({
				baseUrl: wsBaseUrl,
				apiKey: "local-test-key",
				sessionKey: "ws-empty-attribution",
				conversationId: params.conversationId,
				credentialId: "local-test-credential",
				model: params.model,
				request: { model: params.model, input: [], stream: true },
				signal: AbortSignal.any([params.signal, AbortSignal.timeout(2000)]),
				requestDump: params.requestDump,
			});
			return;
		}

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

		if (providerScenario === "reasoning_then_truncated_tool_input") {
			// The shape a model produces when it thinks, commits to a large write, and
			// runs out of output budget mid-arguments. First attempt only; a follow-up
			// attempt answers so the test can inspect what the loop asked next.
			if (providerAttempts === 1) {
				yield { reasoning: "I will write the entire file in one call" };
				yield { toolUseChunk: { toolUseId: "tu-big", name: "Write" } };
				yield { toolUseChunk: { toolUseId: "tu-big", input: '{"file_path":"/tmp/x.ts","cont' } };
				return;
			}
			yield { text: "using a skeleton instead" };
			return;
		}
	},
	formatToolResult: (toolUseId, output, isError) =>
		usesAnthropicRecovery()
			? anthropicFormatter.formatToolResult(toolUseId, output, isError)
			: { toolUseId, output, isError },
	pushUserTurn: (...args) => {
		if (usesAnthropicRecovery()) anthropicFormatter.pushUserTurn(...args);
	},
	pushAssistantTurn: (...args) => {
		if (usesAnthropicRecovery()) anthropicFormatter.pushAssistantTurn(...args);
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

describe("Anthropic broken tool recovery", () => {
	test.each([
		"broken_anthropic_single",
		"broken_anthropic_mixed",
	] as const)("%s removes both broken call and native tool_use_id result", async (scenario) => {
		providerScenario = scenario;
		providerAttempts = 0;
		sentContents = [];
		sentToolResults = [];
		sentHistories = [];
		const execute = mock(async () => ({ output: "valid result" }));
		toolRegistry.register({
			name: RECOVERY_TOOL,
			description: "Recovery fixture",
			parameters: z.object({ content: z.string() }),
			execute,
		});
		try {
			const events = await runLoop({ maxTurns: 3 });
			expect(providerAttempts).toBe(2);
			expect(
				events.some((event) => event.type === "assistant_message" && event.text === "recovered"),
			).toBe(true);
			expect(sentToolResults[1]).toEqual(
				scenario === "broken_anthropic_mixed"
					? [{ tool_use_id: "valid-call", content: "valid result", is_error: undefined }]
					: [],
			);
			expect(JSON.stringify(sentHistories[1])).not.toContain("broken-call");
			if (scenario === "broken_anthropic_mixed") {
				expect(JSON.stringify(sentHistories[1])).toContain("valid-call");
				expect(execute).toHaveBeenCalledTimes(1);
			} else {
				expect(execute).not.toHaveBeenCalled();
			}
			expect(sentContents[1]).toContain("invalid or missing input");
			expect(sentContents[1]).not.toContain("output was cut off by the token limit");
		} finally {
			toolRegistry.unregister(RECOVERY_TOOL);
		}
	});
});

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

describe("真实 WS 错误不落入空响应兜底", () => {
	test.each([
		["error", 400, false],
		["error", 503, false],
		["completed", 400, false],
		["completed", 503, false],
		["completed", 400, true],
		["completed", 503, true],
	] as const)("保留错误并按状态重试，关闭 dump 也有效 (%s, %i, usage=%s)", async (delivery, status, withUsage) => {
		const message = "backend rejected this request";
		const code = "gateway_failure";
		const frame =
			delivery === "error"
				? { type: "error", status, code, error: message }
				: {
						type: "response.completed",
						response: {
							id: "failed-response",
							status: "failed",
							statusCode: status,
							error: { code, message },
							...(withUsage ? { usage: { input_tokens: 4, output_tokens: 0 } } : {}),
						},
					};
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) return;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				message(socket) {
					socket.send(JSON.stringify(frame));
				},
			},
		});
		wsBaseUrl = `http://127.0.0.1:${server.port}/backend-api/codex`;
		providerScenario = "ws_error_response";
		providerAttempts = 0;
		const dumpEnabled = settings.agent.requestDumpEnabled;
		settings.agent.requestDumpEnabled = false;
		try {
			const events = await runLoop({ maxTransientRetries: 1 });
			const terminal = events.at(-1);
			expect(terminal).toBeDefined();
			if (!terminal || !("message" in terminal)) throw new Error("Missing terminal error");
			expect(terminal.message).toContain(message);
			expect(terminal.message).not.toContain("base URL");
			if (status === 503) expect(terminal.type).toBe("retryable_error");
			else expect(["error", "invalid_state"]).toContain(terminal.type);
			expect(providerAttempts).toBe(status === 503 ? 2 : 1);
			expect(events.filter((event) => event.type === "retrying")).toHaveLength(
				status === 503 ? 1 : 0,
			);
			const requests = events.filter((event) => event.type === "api_request_end");
			expect(requests).toHaveLength(providerAttempts);
			for (const request of requests) {
				expect(request.rawDump).toBeUndefined();
				expect(request.diagnostics).toMatchObject({ code, statusCode: status });
				expect(request.diagnostics?.message).toContain(message);
				expect(request.diagnostics?.reason).not.toMatch(/^empty_response/);
			}
		} finally {
			settings.agent.requestDumpEnabled = dumpEnabled;
			await clearCodexResponsesWebSocketSessions();
			server.stop(true);
		}
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
		sentContents = [];

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

	/**
	 * Regression: "reasoning + a tool call cut off mid-arguments" is the exact shape a
	 * model produces when a single Write does not fit in one response. The
	 * reasoning-only dead-turn guard used to claim it — it only inspected completed
	 * `toolUses` — and discarded the turn to replay the identical request, which hit
	 * the same ceiling every time. The model therefore never received the
	 * skeleton-first instructions. A half-written tool input now counts as meaningful
	 * output, so the turn survives and the reminder is injected.
	 */
	test("推理后工具输入被截断时，注入骨架优先提醒而非丢弃回合重发", async () => {
		providerScenario = "reasoning_then_truncated_tool_input";
		providerAttempts = 0;
		sentContents = [];

		const events = await runLoop({ maxTurns: 3 });

		// Not treated as a dead turn: no reasoning-only discard, no in-place replay.
		expect(events.some((e) => e.type === "stream_reset")).toBe(false);
		expect(events.some((e) => e.type === "retrying")).toBe(false);
		expect(
			events.some(
				(e) =>
					e.type === "invalid_state" &&
					(e as { reason: string }).reason.startsWith("reasoning_only"),
			),
		).toBe(false);

		// The turn advanced, and the follow-up request carries the skeleton-first
		// instructions naming the tool whose input was cut off.
		expect(providerAttempts).toBe(2);
		const followUp = sentContents[1];
		expect(followUp).toContain("Write");
		expect(followUp).toContain("SPLICE_1");
		expect(followUp).toContain("10,000");
	});
});
