import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ProviderAdapter } from "../provider";
import type { AgentConfig, AgentEvent } from "../types";

// Scenario switches drive the mock provider's per-attempt behavior.
let providerScenario:
	| "phantom_then_text" // attempt 1: a toolUseChunk with id but NO name (never lands); attempt 2: real text
	| "phantom_forever" = "phantom_then_text"; // every attempt: phantom chunk only (exhausts retries)
let providerAttempts = 0;
// Captures the `content` passed to each chat() call so we can assert the
// in-place same-turn retry behavior (resend identical request).
const contentLog: string[] = [];

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		providerAttempts++;
		contentLog.push(params.content);
		params.onRequestStart?.();

		if (providerScenario === "phantom_then_text") {
			if (providerAttempts === 1) {
				// sawMeaningfulResponse=true, yet the loop never builds an accumulator
				// (name is required) and never pushes to toolUses — leaving zero
				// persistable output. The old empty-response guard (gated on
				// !sawMeaningfulResponse) was suppressed and the turn silently went idle.
				yield { toolUseChunk: { toolUseId: "phantom-1", stop: false } };
				return;
			}
			yield { text: "final answer" };
			return;
		}

		if (providerScenario === "phantom_forever") {
			yield { toolUseChunk: { toolUseId: `phantom-${providerAttempts}`, stop: false } };
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
	mock.restore();
});

function makeConfig(signal: AbortSignal, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		narratorId: "n-phantom-toolchunk",
		conversationId: "conv-phantom-toolchunk",
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

describe("agentLoop phantom toolUseChunk (no name) empty turn", () => {
	test("无 name 的 toolUseChunk 不应被当作有效响应，应触发空回重试后产出正常文本", async () => {
		providerScenario = "phantom_then_text";
		providerAttempts = 0;
		contentLog.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(makeConfig(ac.signal), "do the thing", [])) {
			events.push(event);
		}

		// The phantom chunk produced no persistable output, so the empty-response
		// guard fired and retried.
		expect(events.some((e) => e.type === "retrying")).toBe(true);

		// The final assistant_message carries the real answer, and there is exactly
		// one — no empty-text assistant_message was emitted for the phantom turn.
		const assistantMessages = events.filter((e) => e.type === "assistant_message");
		expect(assistantMessages).toHaveLength(1);
		expect((assistantMessages[0] as { text: string }).text).toBe("final answer");

		// No empty assistant_message leaked through (the bug persisted text:"" ,toolUses:[]).
		const emptyAssistantMessages = events.filter(
			(e) =>
				e.type === "assistant_message" &&
				!(e as { text: string }).text &&
				((e as { toolUses?: unknown[] }).toolUses?.length ?? 0) === 0,
		);
		expect(emptyAssistantMessages).toHaveLength(0);

		// Same-turn in-place retry: content unchanged across both attempts.
		expect(providerAttempts).toBe(2);
		expect(contentLog).toEqual(["do the thing", "do the thing"]);

		expect(events.at(-1)).toEqual({ type: "done" });
	});

	test("持续无 name 的 toolUseChunk 超过重试上限后以 invalid_state(empty_response) 收尾", async () => {
		providerScenario = "phantom_forever";
		providerAttempts = 0;
		contentLog.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(makeConfig(ac.signal), "loop forever", [])) {
			events.push(event);
		}

		// No assistant_message ever emitted (no meaningful content landed).
		expect(events.some((e) => e.type === "assistant_message")).toBe(false);

		// Exhausts the empty-response ceiling (3 retries → 4 attempts total).
		expect(providerAttempts).toBe(4);

		const last = events.at(-1);
		expect(last?.type).toBe("invalid_state");
		expect((last as { reason: string }).reason).toBe("empty_response");
	});
});
