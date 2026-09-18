/**
 * loop-retry-preserves-progress.test.ts — the "history grows, request never changes" defect.
 *
 * Every in-place retry re-sends the SAME `provider.chat()` call: `content`, `history` and
 * `toolResults` are loop invariants inside the retry loop, and each attempt starts by
 * clearing the per-attempt accumulators (`toolUses`, `settledResults`, `earlyExecMap`).
 *
 * That is correct only while an attempt produced nothing. Once a tool call has completed —
 * and especially once it has EXECUTED — a replay throws that work away while sending
 * byte-identical bytes upstream. The model naturally asks for the same tool again, lands in
 * the same branch, and the loop burns its whole budget re-sending the first request. The
 * transcript keeps growing (blocks persist as they complete) while the model never sees
 * anything new.
 *
 * These tests pin the fix from three sides:
 *  1. progress must not be replayed away — the turn is handed back as resumable instead;
 *  2. a genuinely empty attempt must still replay in place, unchanged;
 *  3. every replay must announce `attempt_discarded` (carrying its requestId) so the host
 *     can drop the blocks that attempt persisted, before the request teardown.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import type { ParsedStreamEvent, ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import { type AgentConfig, type AgentEvent, ApiError } from "../types";

/** Scripted attempts: entry N is the event sequence for the Nth provider.chat() call. */
let attempts: Array<ParsedStreamEvent[] | (() => never)> = [];
let attemptCount = 0;
/** What each provider.chat() call was actually sent, so replay-vs-progress is observable. */
let sentRequests: Array<{ content: string; toolResultCount: number }> = [];

/** A transient failure the loop retries in place. */
function transientError(): ApiError {
	return new ApiError(502, "upstream stream error", {
		schema: "narrafork.error-diagnostics.v1",
		source: "gateway",
		statusCode: 502,
		requestId: "req-progress",
	});
}

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		params.onRequestStart?.();
		sentRequests.push({
			content: params.content ?? "",
			toolResultCount: (params.toolResults as unknown[] | undefined)?.length ?? 0,
		});
		const script = attempts[attemptCount++];
		if (!script) throw new Error(`Unexpected provider.chat() call ${attemptCount}`);
		if (typeof script === "function") script();
		else for (const event of script) yield event;
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
		requestedProvider: "progress",
		requestedModel: "progress:test-model",
		provider: "progress",
		adapter: testProvider,
		model: "progress:test-model",
	}),
}));

const { agentLoop } = await import("../loop");

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	mock.restore();
});

function makeConfig(signal: AbortSignal, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		narratorId: "n-retry-progress",
		conversationId: "conv-retry-progress",
		model: "progress:test-model",
		provider: "progress",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		// Keep the backoff negligible so the tests do not wait the real base delay.
		retryBackoffCeilMs: 1,
		...overrides,
	};
}

async function runLoop(
	script: Array<ParsedStreamEvent[] | (() => never)>,
	prompt: string,
	overrides?: Partial<AgentConfig>,
): Promise<AgentEvent[]> {
	attempts = script;
	attemptCount = 0;
	sentRequests = [];
	const ac = new AbortController();
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(makeConfig(ac.signal, overrides), prompt, [])) {
		events.push(event);
	}
	return events;
}

/** A complete Read call: input opens, streams, and closes, so the tool really executes. */
function completeReadToolCall(toolUseId: string): ParsedStreamEvent[] {
	return [
		{ toolUseChunk: { toolUseId, name: "Read", stop: false } },
		{
			toolUseChunk: {
				toolUseId,
				name: "Read",
				input: '{"file_path":"/tmp/does-not-exist.txt"}',
				stop: false,
			},
		},
		{ toolUseChunk: { toolUseId, name: "Read", stop: true } },
	];
}

beforeEach(() => {
	attemptCount = 0;
	sentRequests = [];
});

describe("重试不得丢弃已产生的工具进展", () => {
	for (const failure of ["throw", "invalidState"] as const) {
		for (const mode of ["allow", "mixed", "deny", "abortBefore", "abort", "softStop"] as const) {
			test(`Browser deferred 在 ${failure}/${mode} 中正常结算且不重放`, async () => {
				const originalChat = testProvider.chat;
				const ac = new AbortController();
				let calls = 0;
				let browserExecutions = 0;
				let readExecutions = 0;
				let permissions = 0;
				let streamFailed = false;
				const completeTool = (name: string, toolUseId: string): ParsedStreamEvent[] => [
					{ toolUseChunk: { toolUseId, name, stop: false } },
					{ toolUseChunk: { toolUseId, name, input: '{"action":"fill"}', stop: false } },
					{ toolUseChunk: { toolUseId, name, stop: true } },
				];
				toolRegistry.register({
					name: "Browser",
					description: "Mock browser; never accesses a real browser",
					parameters: z.object({ action: z.string() }),
					execute: async () => {
						expect(streamFailed).toBe(true);
						browserExecutions++;
						if (mode === "abort") ac.abort();
						return { output: "filled" };
					},
				});
				toolRegistry.register({
					name: "Read",
					description: "Mock eager read",
					parameters: z.object({ action: z.string() }),
					execute: async () => {
						readExecutions++;
						return { output: "read" };
					},
				});
				testProvider.chat = async function* (params) {
					params.onRequestStart?.();
					calls++;
					if (calls > 1) throw new Error("Unexpected provider replay");
					if (mode === "mixed") {
						for (const event of completeTool("Read", "tu-eager")) yield event;
					}
					for (const event of completeTool("Browser", "tu-browser")) yield event;
					expect(browserExecutions).toBe(0);
					streamFailed = true;
					if (failure === "throw") throw transientError();
					yield {
						invalidState: { reason: "overloaded_error", message: "upstream overloaded" },
					};
				};
				try {
					const events: AgentEvent[] = [];
					for await (const event of agentLoop(
						makeConfig(ac.signal, {
							maxTransientRetries: 3,
							shouldStop: () => mode === "softStop" && browserExecutions > 0,
							permissionHandler: async (toolName) => {
								if (toolName !== "Browser") return { behavior: "allow" };
								permissions++;
								if (mode === "deny") {
									return { behavior: "deny", message: "not allowed" };
								}
								return { behavior: "allow" };
							},
						}),
						"fill the input",
						[],
					)) {
						events.push(event);
						if (mode === "abortBefore" && event.type === "assistant_message") ac.abort();
					}
					expect(calls).toBe(1);
					expect(permissions).toBe(mode === "abortBefore" ? 0 : 1);
					expect(browserExecutions).toBe(mode === "deny" || mode === "abortBefore" ? 0 : 1);
					expect(readExecutions).toBe(mode === "mixed" ? 1 : 0);
					const results = events.filter((event) => event.type === "tool_result");
					expect(results).toHaveLength(mode === "abortBefore" ? 0 : mode === "mixed" ? 2 : 1);
					if (mode !== "abortBefore") {
						expect(results.find((event) => event.toolName === "Browser")).toMatchObject({
							isError: mode === "deny",
						});
					}
					expect(events.at(-1)).toMatchObject(
						mode === "abort" || mode === "abortBefore"
							? { type: "error", message: "Aborted" }
							: { type: mode === "softStop" ? "turn_complete" : "resumable_error" },
					);
					expect(
						events.some(
							(event) =>
								event.type === "retrying" ||
								event.type === "attempt_discarded" ||
								event.type === "done",
						),
					).toBe(false);
					for (const result of results) {
						expect(events.indexOf(result)).toBeLessThan(events.length - 1);
					}
				} finally {
					testProvider.chat = originalChat;
					toolRegistry.unregister("Browser");
					toolRegistry.unregister("Read");
				}
			});
		}
	}

	test("工具已执行后瞬态失败不得原地重放，必须把结果交回调用方", async () => {
		// The scripted-array provider cannot throw mid-sequence, and that is exactly the
		// shape under test: the tool call must LAND before the stream dies. Swap in a
		// generator for this one case.
		const original = testProvider.chat;
		let calls = 0;
		testProvider.chat = async function* (params) {
			params.onRequestStart?.();
			calls++;
			sentRequests.push({
				content: params.content ?? "",
				toolResultCount: (params.toolResults as unknown[] | undefined)?.length ?? 0,
			});
			if (calls === 1) {
				for (const event of completeReadToolCall("tu-read")) yield event;
				throw transientError();
			}
			yield { text: "second attempt should not happen" };
		} as typeof testProvider.chat;

		try {
			sentRequests = [];
			const ac = new AbortController();
			const events: AgentEvent[] = [];
			for await (const event of agentLoop(
				makeConfig(ac.signal, { maxTransientRetries: 3 }),
				"read the file",
				[],
			)) {
				events.push(event);
			}

			// No in-place replay: the request went out exactly once.
			expect(sentRequests).toHaveLength(1);
			expect(events.some((e) => e.type === "retrying")).toBe(false);

			// The executed tool's result was drained so the caller's rebuilt history has it.
			const toolResults = events.filter((e) => e.type === "tool_result");
			expect(toolResults).toHaveLength(1);
			expect((toolResults[0] as { toolUseId: string }).toolUseId).toBe("tu-read");

			// Handed back as RESUMABLE, so the caller resumes from the persisted tool
			// results under its bounded interruption budget. Deliberately not
			// `retryable_error`/`invalid_state`: for a stateless provider both end the run,
			// which would strand a tool that already executed behind a hard failure.
			expect(events.at(-1)).toMatchObject({ type: "resumable_error" });

			// Nothing was discarded: the attempt's work is being kept, not replayed away.
			expect(events.some((e) => e.type === "attempt_discarded")).toBe(false);
		} finally {
			testProvider.chat = original;
		}
	});

	test("完全空的一次尝试仍允许原地重放，且请求参数保持不变", async () => {
		const events = await runLoop([[], [{ text: "recovered" }]], "go", {
			maxTransientRetries: 0,
		});

		// Replayed in place with an identical request.
		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[0]).toEqual(sentRequests[1]);
		expect(events.some((e) => e.type === "retrying")).toBe(true);
		expect(events.at(-1)).toEqual({ type: "done" });
	});

	test("每次原地重放都先发出 attempt_discarded，且早于 api_request_end", async () => {
		const events = await runLoop([[], [{ text: "recovered" }]], "go");

		const discardIndex = events.findIndex((e) => e.type === "attempt_discarded");
		const endIndex = events.findIndex((e) => e.type === "api_request_end");
		expect(discardIndex).toBeGreaterThanOrEqual(0);
		expect(discardIndex).toBeLessThan(endIndex);

		// Exactly one replay happened, so exactly one attempt was discarded.
		expect(events.filter((e) => e.type === "attempt_discarded")).toHaveLength(1);
	});

	test("attempt_discarded 标明被丢弃的 requestId，即使该 attempt 的 api_request_start 后到", async () => {
		// `api_request_start` is flushed LAZILY: the request is marked started by the
		// provider's onRequestStart callback, but the event only reaches the consumer on
		// the first stream event or during request teardown. An attempt that throws
		// before yielding anything therefore emits its discard FIRST and its own
		// api_request_start second.
		//
		// That is why the discard has to name its requestId: a consumer keying the
		// truncation baseline on "the most recent api_request_start" would be holding the
		// PREVIOUS attempt's baseline here, and truncating to it can delete blocks an
		// earlier attempt already committed.
		const original = testProvider.chat;
		let calls = 0;
		testProvider.chat = async function* (params) {
			params.onRequestStart?.();
			calls++;
			sentRequests.push({
				content: params.content ?? "",
				toolResultCount: (params.toolResults as unknown[] | undefined)?.length ?? 0,
			});
			// Throw before the first yield, so the stream loop never runs an iteration.
			if (calls === 1) throw transientError();
			yield { text: "recovered" };
		} as typeof testProvider.chat;

		try {
			sentRequests = [];
			const ac = new AbortController();
			const events: AgentEvent[] = [];
			for await (const event of agentLoop(
				makeConfig(ac.signal, { maxTransientRetries: 3 }),
				"go",
				[],
			)) {
				events.push(event);
			}

			// It really was an in-place replay of the identical request.
			expect(sentRequests).toHaveLength(2);
			expect(sentRequests[0]).toEqual(sentRequests[1]);

			const discarded = events.filter(
				(e): e is Extract<AgentEvent, { type: "attempt_discarded" }> =>
					e.type === "attempt_discarded",
			);
			expect(discarded).toHaveLength(1);
			expect(discarded[0].requestId).toBeTruthy();

			// The ordering that makes the requestId necessary.
			const discardIndex = events.findIndex((e) => e.type === "attempt_discarded");
			const ownStartIndex = events.findIndex(
				(e) => e.type === "api_request_start" && e.requestId === discarded[0].requestId,
			);
			expect(ownStartIndex).toBeGreaterThan(discardIndex);

			// And it names the FIRST attempt, not the replay that followed.
			const startIds = events.flatMap((e) => (e.type === "api_request_start" ? [e.requestId] : []));
			expect(startIds).toHaveLength(2);
			expect(discarded[0].requestId).toBe(startIds[0]);
			expect(discarded[0].requestId).not.toBe(startIds[1]);
		} finally {
			testProvider.chat = original;
		}
	});
});

describe("空响应重试预算按上游行为分级", () => {
	test("上游已服务（usage_only）时只重放一次就交回调用方", async () => {
		const usageOnly: ParsedStreamEvent[] = [{ usage: { promptTokens: 900, completionTokens: 0 } }];
		const events = await runLoop([usageOnly, usageOnly, usageOnly, usageOnly], "go");

		// One retry, not three: the request demonstrably reached the model and came back
		// deliberately empty, so replaying the same bytes is not worth another full prompt.
		expect(sentRequests).toHaveLength(2);
		expect(events.filter((e) => e.type === "retrying")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({
			type: "invalid_state",
			reason: "empty_response_usage_only",
		});
	});

	test("传输层故障（no_events）保留完整重放预算", async () => {
		const events = await runLoop([[], [], [], []], "go");

		// 3 retries + the original = 4 attempts.
		expect(sentRequests).toHaveLength(4);
		expect(events.filter((e) => e.type === "retrying")).toHaveLength(3);
		expect(events.at(-1)).toMatchObject({
			type: "invalid_state",
			reason: "empty_response_no_events",
		});
	});
});
