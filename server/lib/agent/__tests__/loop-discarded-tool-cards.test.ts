/**
 * loop-discarded-tool-cards.test.ts — the "ghost tool" regression.
 *
 * A `tool_use_chunk` publishes a tool card as soon as the model starts writing that
 * tool's arguments. At that moment nothing is persisted: no `narrator_tool_calls`
 * row exists, because the row is only created once the input closes.
 *
 * If the stream breaks BEFORE the input closes and the turn is replayed, the id is
 * abandoned. Every event that would retire the card is tied to completion —
 * `tool_completed`, and the persisted message carrying the id — so none of them ever
 * arrives. The card was left spinning forever with a live elapsed timer, still on
 * screen after the retry succeeded and the turn was done.
 *
 * The fix names the abandoned ids in a `tool_use_discarded` event. These tests pin
 * the two halves of that contract: abandoned ids ARE announced, and ids whose input
 * completed are NOT (retracting those would erase a real, executing tool).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ProviderAdapter } from "../provider";
import { type AgentConfig, type AgentEvent, ApiError } from "../types";

let scenario:
	| "truncated_tool_then_text" // arguments cut mid-stream, then a clean retry
	| "complete_tool_then_error" // input closed before the break — must NOT be retracted
	| "truncated_tool_forever" = "truncated_tool_then_text";
let attempts = 0;

/** A transient failure the loop retries in place. */
function transientError(): ApiError {
	return new ApiError(502, "upstream stream error", {
		schema: "narrafork.error-diagnostics.v1",
		source: "gateway",
		statusCode: 502,
		requestId: "req-ghost",
	});
}

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		attempts++;
		params.onRequestStart?.();

		if (scenario === "truncated_tool_then_text") {
			// The model starts writing Bash's arguments. The frontend renders a card from
			// this alone — "Bash · 49 chars", spinner running.
			yield { toolUseChunk: { toolUseId: "ghost-bash", name: "Bash", stop: false } };
			yield {
				toolUseChunk: {
					toolUseId: "ghost-bash",
					name: "Bash",
					input: '{"command":"bun test --',
					stop: false,
				},
			};
			// Connection dies mid-arguments: no `stop`, so the input never closes.
			throw transientError();
		}

		if (scenario === "complete_tool_then_error") {
			if (attempts === 1) {
				yield { toolUseChunk: { toolUseId: "real-bash", name: "Bash", stop: false } };
				yield {
					toolUseChunk: {
						toolUseId: "real-bash",
						name: "Bash",
						input: '{"command":"echo hi"}',
						stop: false,
					},
				};
				// Input CLOSES — this is a real tool call the loop will execute.
				yield { toolUseChunk: { toolUseId: "real-bash", name: "Bash", stop: true } };
				return;
			}
			yield { text: "done" };
			return;
		}

		// truncated_tool_forever: every attempt dies mid-arguments.
		yield { toolUseChunk: { toolUseId: `ghost-${attempts}`, name: "Bash", stop: false } };
		yield {
			toolUseChunk: { toolUseId: `ghost-${attempts}`, name: "Bash", input: '{"comm', stop: false },
		};
		throw transientError();
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

const realProviderModule = { ...(await import("../provider")) };

mock.module("../provider", () => ({
	...realProviderModule,
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
		narratorId: "n-ghost-tool",
		conversationId: "conv-ghost-tool",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		// Keep the backoff negligible so the test does not wait the real base delay.
		retryBackoffCeilMs: 1,
		...overrides,
	};
}

async function collect(prompt: string, overrides?: Partial<AgentConfig>): Promise<AgentEvent[]> {
	const ac = new AbortController();
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(makeConfig(ac.signal, overrides), prompt, [])) {
		events.push(event);
	}
	return events;
}

function discardedIds(events: AgentEvent[]): string[] {
	return events
		.filter((event) => event.type === "tool_use_discarded")
		.flatMap((event) => (event as { toolUseIds: string[] }).toolUseIds);
}

describe("agentLoop 放弃重放时回收流式工具卡", () => {
	beforeEach(() => {
		attempts = 0;
	});

	test("输入未写完就断流时，必须显式回收该工具卡", async () => {
		scenario = "truncated_tool_then_text";
		// maxTransientRetries: 0 so the loop hands the failure back to the caller
		// immediately. This is the shape the ghost was actually reported in: the
		// narrator layer rebuilds history and starts a fresh turn, so the loop never
		// returns to its own retry path — the abandoned id must still be retracted.
		const events = await collect("run the thing", { maxTransientRetries: 0 });

		// The card was published — this is what the user saw spinning.
		expect(events.some((event) => event.type === "tool_use_chunk")).toBe(true);
		// The turn died and was handed back to the caller rather than retried in place.
		expect(events.some((event) => event.type === "retryable_error")).toBe(true);

		// The abandoned id is announced, so the client can retire a card that no
		// completion event will ever cover. This assertion IS the bug: before the fix
		// nothing named this id and the card stayed running forever.
		expect(discardedIds(events)).toContain("ghost-bash");

		// The retraction must reach the client together with the failure, not later:
		// it has to precede the request teardown that reports the error.
		const discardIndex = events.findIndex((event) => event.type === "tool_use_discarded");
		const endIndex = events.findIndex((event) => event.type === "api_request_end");
		expect(discardIndex).toBeGreaterThanOrEqual(0);
		expect(discardIndex).toBeLessThan(endIndex);

		// The truncated call never became a real tool call, so no tool ran.
		expect(events.some((event) => event.type === "tool_result")).toBe(false);
	});

	test("输入已闭合的工具不得被回收（它是真实调用，可能已产生副作用）", async () => {
		scenario = "complete_tool_then_error";
		const events = await collect("echo please");

		// The tool completed its input, so it is a genuine call.
		const assistant = events.find((event) => event.type === "assistant_message");
		expect(
			((assistant as { toolUses?: Array<{ toolUseId: string }> }).toolUses ?? []).map(
				(tu) => tu.toolUseId,
			),
		).toContain("real-bash");

		// Retracting it would have deleted a card for a tool that really ran.
		expect(discardedIds(events)).not.toContain("real-bash");
	});

	test("反复断流时每一次放弃的 id 都被回收，不留残卡", async () => {
		scenario = "truncated_tool_forever";
		const events = await collect("keep failing", { maxTransientRetries: 2 });

		// Every published card belongs to an attempt that was abandoned, so every one
		// of those ids must be retracted — otherwise each retry leaves a new ghost.
		const published = new Set(
			events
				.filter((event) => event.type === "tool_use_chunk")
				.map((event) => (event as { toolUseId: string }).toolUseId),
		);
		const retracted = new Set(discardedIds(events));
		expect(published.size).toBeGreaterThan(1);
		for (const toolUseId of published) {
			expect(retracted).toContain(toolUseId);
		}
	});
});
