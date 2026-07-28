import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ParsedStreamEvent, ProviderAdapter } from "../provider";
import type { AgentConfig, AgentEvent, ApiRequestDiagnostics } from "../types";

/**
 * Recovery strategy for a resumable stream interruption depends on WHAT partial
 * output landed before the break:
 *  - a complete tool call  → finish the turn normally so the tool runs and its
 *                            result is carried into the next turn
 *  - visible answer text   → flush it and let the caller append a continuation
 *  - only reasoning        → drop the truncated reasoning and replay the request
 *
 * These tests drive the loop through a scripted provider adapter so each shape
 * can be produced exactly, including a tool call whose input was cut off.
 */

const RESUMABLE_DIAGNOSTICS: ApiRequestDiagnostics = {
	schema: "narrafork.error-diagnostics.v1",
	source: "channel",
	phase: "upstream_stream_read",
	reason: "stream_read_error",
	statusCode: 502,
	retryable: false,
	resumable: true,
};


function resumableErrorEvent(): ParsedStreamEvent {
	return {
		invalidState: {
			reason: "stream_read_error",
			message: RESUMABLE_MESSAGE,
			diagnostics: RESUMABLE_DIAGNOSTICS,
		},
	};
}

/** Scripted attempts: each entry is the event sequence for one provider.chat() call. */
let attempts: ParsedStreamEvent[][] = [];
let attemptCount = 0;

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		params.onRequestStart?.();
		const script = attempts[attemptCount++];
		if (!script) throw new Error(`Unexpected provider.chat() call ${attemptCount}`);
		for (const event of script) {
			yield event;
		}
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
		requestedProvider: "resume-strategy",
		requestedModel: "resume-strategy:test-model",
		provider: "resume-strategy",
		adapter: testProvider,
		model: "resume-strategy:test-model",
	}),
}));

const { agentLoop } = await import("../loop");

function makeConfig(signal: AbortSignal, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		narratorId: "n-resume-strategy",
		conversationId: "conv-resume-strategy",
		model: "resume-strategy:test-model",
		provider: "resume-strategy",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		maxTransientRetries: 2,
		retryBackoffCeilMs: 0,
		...overrides,
	};
}

/**
 * Run the loop, collecting events. `stopAfter` bails out once the named event
 * type is seen so a tool-continuation turn does not need a scripted follow-up.
 */
async function runLoop(
	script: ParsedStreamEvent[][],
	options: { overrides?: Partial<AgentConfig>; stopAfter?: AgentEvent["type"] } = {},
): Promise<AgentEvent[]> {
	attempts = script;
	attemptCount = 0;
	const events: AgentEvent[] = [];
	const controller = new AbortController();
	for await (const event of agentLoop(
		makeConfig(controller.signal, options.overrides),
		"answer",
		[],
	)) {
		events.push(event);
		if (options.stopAfter && event.type === options.stopAfter) break;
	}
	return events;
}

function providerCalls(): number {
	return attemptCount;
}

beforeEach(() => {
	attempts = [];
	attemptCount = 0;
});

afterEach(() => {
	attempts = [];
	attemptCount = 0;
});

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	mock.restore();
});

describe("resumable interruption: reasoning-only → drop and replay the request", () => {
	test("discards truncated reasoning, emits stream_reset + retrying, and replays in place", async () => {
		const events = await runLoop([
			[{ reasoning: "half a thought before the stream br" }, resumableErrorEvent()],
			[{ text: "recovered answer" }],
		]);

		// The request was replayed rather than continued from a truncated thought.
		expect(providerCalls()).toBe(2);
		// Not surfaced as a resumable continuation nor as a terminal failure.
		expect(events.some((event) => event.type === "resumable_error")).toBe(false);
		expect(events.some((event) => event.type === "invalid_state")).toBe(false);
		// The frontend is told to drop the live reasoning it was showing.
		expect(events.some((event) => event.type === "stream_reset")).toBe(true);
		expect(events.find((event) => event.type === "retrying")).toMatchObject({
			type: "retrying",
			message: RESUMABLE_MESSAGE,
			attempt: 1,
		});
		// The truncated reasoning must NOT be persisted as a block.
		const reasoningBlocks = events.filter(
			(event) => event.type === "block_complete" && event.block.type === "reasoning",
		);
		expect(reasoningBlocks).toHaveLength(0);
		// The replay produced the real answer.
		expect(events.find((event) => event.type === "assistant_message")).toMatchObject({
			type: "assistant_message",
			text: "recovered answer",
		});
		expect(events.at(-1)).toEqual({ type: "done" });
	});

	test("a tool call with truncated input counts as reasoning-only (broken call, not a real tool)", async () => {
		const events = await runLoop([
			[
				// toolUseChunk without a stop: the input was cut off mid-stream, so no
				// complete tool call exists — replaying is safe (nothing executed).
				{ toolUseChunk: { toolUseId: "tu_broken", name: "Bash", input: '{"comm' } },
				resumableErrorEvent(),
			],
			[{ text: "recovered after broken tool input" }],
		]);

		expect(providerCalls()).toBe(2);
		expect(events.some((event) => event.type === "resumable_error")).toBe(false);
		expect(events.some((event) => event.type === "stream_reset")).toBe(true);
		// No tool was ever executed.
		expect(events.some((event) => event.type === "tool_result")).toBe(false);
		expect(events.at(-1)).toEqual({ type: "done" });
	});

	test("falls back to a textual continuation when the replay budget is spent", async () => {
		const events = await runLoop([[{ reasoning: "truncated thought" }, resumableErrorEvent()]], {
			overrides: { maxTransientRetries: 0 },
		});

		// No replay attempted.
		expect(providerCalls()).toBe(1);
		expect(events.some((event) => event.type === "retrying")).toBe(false);
		// Degrades to a resumable continuation, NOT a hard failure.
		expect(events.some((event) => event.type === "invalid_state")).toBe(false);
		expect(events.at(-1)).toMatchObject({
			type: "resumable_error",
			message: RESUMABLE_MESSAGE,
			diagnostics: { resumable: true, retryable: false },
		});
	});
});

describe("resumable interruption: complete tool call → run the tool and continue", () => {
	test("executes the tool, yields its result, and finishes the turn normally", async () => {
		const events = await runLoop(
			[
				[
					{ text: "let me check that" },
					{
						toolUses: [
							{ toolUseId: "tu_read", name: "Read", input: { file_path: "/tmp/does-not-exist" } },
						],
					},
					resumableErrorEvent(),
				],
			],
			// tool_result is yielded after assistant_message when the eager execution
			// has not settled by the time the turn is finalized, so collect through it.
			{ stopAfter: "tool_result" },
		);

		// No wholesale replay: the tool call must not be duplicated.
		expect(providerCalls()).toBe(1);
		// Not a continuation-prompt path and not a terminal failure.
		expect(events.some((event) => event.type === "resumable_error")).toBe(false);
		expect(events.some((event) => event.type === "invalid_state")).toBe(false);
		// An informational recovery notice is emitted instead.
		expect(events.find((event) => event.type === "resumable_recovered")).toMatchObject({
			type: "resumable_recovered",
			strategy: "tool_continuation",
			diagnostics: { resumable: true },
		});
		// The tool actually ran and produced a result the model can consume.
		expect(events.find((event) => event.type === "tool_result")).toMatchObject({
			type: "tool_result",
			toolUseId: "tu_read",
			toolName: "Read",
		});
		// The turn completed normally, carrying the tool call.
		const assistantMessage = events.find((event) => event.type === "assistant_message");
		expect(assistantMessage).toMatchObject({
			type: "assistant_message",
			text: "let me check that",
		});
		expect(
			(assistantMessage as Extract<AgentEvent, { type: "assistant_message" }>).toolUses,
		).toHaveLength(1);
	});

	test("a tool call without any text still takes the tool-continuation path", async () => {
		const events = await runLoop(
			[
				[
					{ reasoning: "I should read the file" },
					{
						toolUses: [
							{ toolUseId: "tu_only", name: "Read", input: { file_path: "/tmp/does-not-exist" } },
						],
					},
					resumableErrorEvent(),
				],
			],
			{ stopAfter: "tool_result" },
		);

		expect(providerCalls()).toBe(1);
		// A complete tool call outranks the reasoning-only replay path: nothing is
		// discarded and no request is replayed, because the tool may have side effects.
		expect(events.some((event) => event.type === "stream_reset")).toBe(false);
		expect(events.some((event) => event.type === "resumable_error")).toBe(false);
		expect(events.find((event) => event.type === "resumable_recovered")).toMatchObject({
			strategy: "tool_continuation",
		});
		expect(events.some((event) => event.type === "tool_result")).toBe(true);
	});
});

describe("resumable interruption: trailing text → continuation prompt (unchanged)", () => {
	test("flushes the partial text and yields resumable_error for the caller to continue", async () => {
		const events = await runLoop([
			[{ text: "partial answer before disconnect" }, resumableErrorEvent()],
		]);

		// Text-only interruptions must not replay the request (that would repeat
		// visible output) and must not execute anything.
		expect(providerCalls()).toBe(1);
		expect(events.some((event) => event.type === "retrying")).toBe(false);
		expect(events.some((event) => event.type === "resumable_recovered")).toBe(false);
		// The partial text is persisted before signalling the continuation.
		expect(
			events.find((event) => event.type === "block_complete" && event.block.type === "text"),
		).toMatchObject({
			type: "block_complete",
			block: { type: "text", text: "partial answer before disconnect" },
		});
		expect(events.at(-1)).toMatchObject({
			type: "resumable_error",
			message: RESUMABLE_MESSAGE,
		});
	});
});
