import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ProviderAdapter } from "../provider";
import type { AgentConfig, AgentEvent } from "../types";

// Scenario switches drive the mock provider's per-attempt behavior.
let providerScenario:
	| "reasoning_then_text" // attempt 1: reasoning only; attempt 2: real text
	| "reasoning_high_context_then_text" // attempt 1: high-context reasoning only; attempt 2: text
	| "reasoning_high_context_abort" // attempt 1: high-context reasoning only; recovery waits for abort
	| "reasoning_forever" = "reasoning_then_text"; // every attempt: reasoning only (exhausts retries)
let providerAttempts = 0;
// Captures the `content` passed to each chat() call so we can assert the
// previous-block recovery behavior (same-turn resend vs continue nudge).
const contentLog: string[] = [];
const resetLog: boolean[] = [];
let highContextRecoveryCompleted = false;
let highContextSecondAttemptSawRecovery = false;

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		providerAttempts++;
		contentLog.push(params.content);
		resetLog.push(params.resetUpstreamSession === true);
		params.onRequestStart?.();

		if (providerScenario === "reasoning_then_text") {
			if (providerAttempts === 1) {
				yield { reasoning: "thinking but no answer", reasoningOutputIndex: 0 };
				return;
			}
			yield { text: "final answer" };
			return;
		}

		if (
			providerScenario === "reasoning_high_context_then_text" ||
			providerScenario === "reasoning_high_context_abort"
		) {
			if (providerAttempts === 1) {
				yield { contextUsagePercentage: 96 };
				yield { reasoning: "context is full", reasoningOutputIndex: 0 };
				return;
			}
			highContextSecondAttemptSawRecovery = highContextRecoveryCompleted;
			yield { text: "final answer after compact" };
			return;
		}

		if (providerScenario === "reasoning_forever") {
			yield { reasoning: "still only thinking", reasoningOutputIndex: 0 };
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
		narratorId: "n-reasoning-only",
		conversationId: "conv-reasoning-only",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		// Keep retry backoff negligible so the test doesn't wait the 5s base delay.
		retryBackoffCeilMs: 1,
		...overrides,
	};
}

describe("agentLoop reasoning-only dead turn", () => {
	test("首回合纯 reasoning 死回合不入库，重发后产出正常文本", async () => {
		providerScenario = "reasoning_then_text";
		providerAttempts = 0;
		contentLog.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(makeConfig(ac.signal), "do the thing", [])) {
			events.push(event);
		}

		// The dead turn triggered a stream_reset and a retry.
		expect(events.some((e) => e.type === "stream_reset")).toBe(true);
		expect(events.some((e) => e.type === "retrying")).toBe(true);

		// No reasoning block_complete was flushed (the dead-turn reasoning is dropped).
		const reasoningBlocks = events.filter(
			(e) => e.type === "block_complete" && e.block.type === "reasoning",
		);
		expect(reasoningBlocks).toHaveLength(0);

		// The final assistant_message carries the real answer, not an empty turn.
		const assistantMessages = events.filter((e) => e.type === "assistant_message");
		expect(assistantMessages).toHaveLength(1);
		expect((assistantMessages[0] as { text: string }).text).toBe("final answer");

		// Same-turn in-place retry: content unchanged across both attempts.
		expect(providerAttempts).toBe(2);
		expect(contentLog).toEqual(["do the thing", "do the thing"]);

		expect(events.at(-1)).toEqual({ type: "done" });
	});

	test("高上下文纯 reasoning 先等待压缩完成，再用重建 history 重试", async () => {
		providerScenario = "reasoning_high_context_then_text";
		providerAttempts = 0;
		contentLog.length = 0;
		resetLog.length = 0;
		highContextRecoveryCompleted = false;
		highContextSecondAttemptSawRecovery = false;
		const recoveryPercentages: number[] = [];
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		const config = makeConfig(ac.signal, {
			onReasoningOnlyHighContext: async (percentage) => {
				recoveryPercentages.push(percentage);
				await Promise.resolve();
				highContextRecoveryCompleted = true;
				return {
					history: [{ role: "system", content: "rebuilt after compact" }],
					pendingToolResults: [],
					systemPrompt: "rebuilt system prompt",
				};
			},
		});

		for await (const event of agentLoop(config, "compact before retry", [])) {
			events.push(event);
		}

		expect(recoveryPercentages).toEqual([96]);
		expect(highContextSecondAttemptSawRecovery).toBe(true);
		expect(providerAttempts).toBe(2);
		expect(contentLog).toEqual(["compact before retry", "compact before retry"]);
		expect(resetLog).toEqual([false, true]);
		expect(
			events.some((e) => e.type === "assistant_message" && e.text === "final answer after compact"),
		).toBe(true);
		expect(events.at(-1)).toEqual({ type: "done" });
	});

	test("高上下文 compact 等待会响应 Agent abort", async () => {
		providerScenario = "reasoning_high_context_abort";
		providerAttempts = 0;
		highContextRecoveryCompleted = false;
		const ac = new AbortController();
		const events: AgentEvent[] = [];
		const config = makeConfig(ac.signal, {
			onReasoningOnlyHighContext: async (_percentage, signal) => {
				await new Promise<void>((resolve) => {
					if (signal.aborted) {
						resolve();
						return;
					}
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				highContextRecoveryCompleted = signal.aborted;
				return null;
			},
		});
		const abortTimer = setTimeout(() => ac.abort(), 0);
		for await (const event of agentLoop(config, "abort compact", [])) events.push(event);
		clearTimeout(abortTimer);

		expect(highContextRecoveryCompleted).toBe(true);
		expect(events.at(-1)).toEqual({ type: "error", message: "Aborted" });
	});

	test("持续纯 reasoning 超过重试上限后以 invalid_state 收尾", async () => {
		providerScenario = "reasoning_forever";
		providerAttempts = 0;
		contentLog.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(makeConfig(ac.signal), "loop forever", [])) {
			events.push(event);
		}

		// stream_reset on every dead attempt; no reasoning persisted.
		expect(events.some((e) => e.type === "stream_reset")).toBe(true);
		const reasoningBlocks = events.filter(
			(e) => e.type === "block_complete" && e.block.type === "reasoning",
		);
		expect(reasoningBlocks).toHaveLength(0);

		// No assistant_message ever emitted (no meaningful content).
		expect(events.some((e) => e.type === "assistant_message")).toBe(false);

		// Exhausts the shared empty-response ceiling (3 retries → 4 attempts total).
		expect(providerAttempts).toBe(4);

		const last = events.at(-1);
		expect(last?.type).toBe("invalid_state");
		expect((last as { reason: string }).reason).toBe("empty_response");
	});
});
