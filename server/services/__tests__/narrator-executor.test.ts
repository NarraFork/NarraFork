import { describe, expect, test } from "bun:test";
import type { AgentConfig, AgentEvent } from "../../lib/agent/types";
import { CriticalEventPersistenceError, type EventHandlerContext } from "../narrator-event-handler";
import { executeAgentLoop } from "../narrator-executor";

function makeConfig(signal: AbortSignal): AgentConfig {
	return {
		narratorId: "test-narrator",
		conversationId: "test-conversation",
		model: "test-model",
		provider: "test-provider",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
	};
}

async function* makeEventSource(events: AgentEvent[]): AsyncIterable<AgentEvent> {
	for (const event of events) {
		yield event;
	}
}

describe("executeAgentLoop file-reference context", () => {
	test("binds a reused event context to this pass's in-memory config", async () => {
		const eventContext = {} as EventHandlerContext;
		for (const cwd of ["/first/pass", "/second/pass"]) {
			const config = { ...makeConfig(new AbortController().signal), cwd };
			await executeAgentLoop(
				{ config, userText: "", history: [], eventContext },
				{
					eventSource: makeEventSource([{ type: "stream_text", text: "src/a.ts" }]),
					processEventFn: async (_event, ctx) => {
						expect(ctx.getFileReferenceContext?.()).toEqual({ deviceId: "local", cwd });
						return null;
					},
				},
			);
		}
	});
});

describe("executeAgentLoop result handling", () => {
	test("handles an empty assistant turn", async () => {
		const ac = new AbortController();

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{ type: "assistant_message", text: "", toolUses: [] },
					{ type: "done" },
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.hasError).toBe(false);
		expect(result.completedAssistantTurn).toBe(true);
	});

	test("reports completed assistant progress before a later context overflow", async () => {
		const ac = new AbortController();

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{
						type: "assistant_message",
						text: "",
						toolUses: [{ toolUseId: "toolu_1", name: "Read", input: {} }],
					},
					{ type: "context_length_exceeded", message: "too long" },
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.contextLengthExceeded).toBe(true);
		expect(result.completedAssistantTurn).toBe(true);
	});

	test("preserves an immediate overflow as no-progress recovery", async () => {
		const ac = new AbortController();

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{ type: "context_length_exceeded", message: "still too long" },
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.contextLengthExceeded).toBe(true);
		expect(result.completedAssistantTurn).toBe(false);
	});

	test("marks provider completion-limit truncation as interrupted", async () => {
		const ac = new AbortController();

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{ type: "assistant_message", text: "partial", toolUses: [] },
					{ type: "output_truncated", message: "max_tokens" },
					{ type: "done" },
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.interrupted).toBe(true);
		expect(result.shouldReplayInterruptedToolResultTurn).toBe(false);
		expect(result.hasError).toBe(false);
	});

	test("replays tool-result turn when completion limit interrupts a tool turn", async () => {
		const ac = new AbortController();

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{
						type: "assistant_message",
						text: "",
						toolUses: [{ toolUseId: "toolu_1", name: "Read", input: {} }],
					},
					{ type: "output_truncated", message: "length" },
					{ type: "done" },
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.interrupted).toBe(true);
		expect(result.shouldReplayInterruptedToolResultTurn).toBe(true);
		expect(result.hasError).toBe(false);
	});

	test("marks a NUG resumable_error as interrupted with interruptedReason='resumable_error'", async () => {
		const ac = new AbortController();

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				// The loop yields resumable_error directly (no assistant_message —
				// it never completes a turn, it flushes block_complete and returns).
				eventSource: makeEventSource([
					{
						type: "resumable_error",
						message: "upstream stream error",
						diagnostics: { schema: "narrafork.error-diagnostics.v1", resumable: true },
					},
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.interrupted).toBe(true);
		expect(result.interruptedReason).toBe("resumable_error");
		expect(result.hasError).toBe(false);
		expect(result.shouldReplayInterruptedToolResultTurn).toBe(false);
	});

	test("resumable_error after a tool-carrying turn still requests a tool-result replay", async () => {
		const ac = new AbortController();

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{
						type: "assistant_message",
						text: "",
						toolUses: [{ toolUseId: "toolu_1", name: "Read", input: {} }],
					},
					{ type: "resumable_error", message: "upstream stream error" },
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.interrupted).toBe(true);
		expect(result.interruptedReason).toBe("resumable_error");
		expect(result.shouldReplayInterruptedToolResultTurn).toBe(true);
	});

	test("reports completedNaturally when the model stops calling tools", async () => {
		const ac = new AbortController();

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{ type: "assistant_message", text: "final answer", toolUses: [] },
					{ type: "done" },
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.completedNaturally).toBe(true);
	});

	test("does not report completedNaturally when the pass ends without done", async () => {
		const ac = new AbortController();

		// A tool-carrying turn that never reached `done`: the loop returned because
		// of an out-of-band condition, so there may still be work left.
		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{
						type: "assistant_message",
						text: "",
						toolUses: [{ toolUseId: "toolu_1", name: "Read", input: {} }],
					},
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.completedNaturally).toBe(false);
		expect(result.completedAssistantTurn).toBe(true);
	});

	test("does not report completedNaturally for an aborted pass", async () => {
		const ac = new AbortController();
		ac.abort();

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([{ type: "done" }]),
				processEventFn: async () => null,
			},
		);

		expect(result.aborted).toBe(true);
		expect(result.completedNaturally).toBe(false);
	});

	test("does not report completedNaturally when the context overflowed", async () => {
		const ac = new AbortController();

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{ type: "context_length_exceeded", message: "too long" },
					{ type: "done" },
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.contextLengthExceeded).toBe(true);
		expect(result.completedNaturally).toBe(false);
	});

	test("handles an image-only assistant turn", async () => {
		const ac = new AbortController();

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{
						type: "block_complete",
						block: {
							type: "image_generation",
							id: "ig_1",
							revisedPrompt: "a tiny blue square",
							result: "Zm9v",
						},
					},
					{ type: "assistant_message", text: "", toolUses: [] },
					{ type: "done" },
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.hasError).toBe(false);
	});

	test("handles image block_complete without result", async () => {
		const ac = new AbortController();

		// A block_complete with only revisedPrompt but no result should still
		// complete without surfacing an executor error.
		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{
						type: "block_complete",
						block: {
							type: "image_generation",
							id: "ig_2",
							revisedPrompt: "a red circle",
						},
					},
					{ type: "assistant_message", text: "", toolUses: [] },
					{ type: "done" },
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.hasError).toBe(false);
	});

	test("handles lifecycle image_generation event alone", async () => {
		const ac = new AbortController();

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{
						type: "image_generation",
						id: "ig_3",
						status: "completed",
					},
					{ type: "assistant_message", text: "", toolUses: [] },
					{ type: "done" },
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.hasError).toBe(false);
	});

	test("preserves retryable error metadata for outer recovery", async () => {
		const ac = new AbortController();

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{
						type: "retryable_error",
						message: "retry me",
						code: "codex_quota_failover_rebuild",
						bypassRetryLimit: true,
					},
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.retryableError).toBe("retry me");
		expect(result.retryableErrorCode).toBe("codex_quota_failover_rebuild");
		expect(result.bypassRetryLimit).toBe(true);
	});

	test("treats empty-response invalid state as an error", async () => {
		const ac = new AbortController();

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{
						type: "invalid_state",
						reason: "empty_response",
						message: "openai: Provider returned an empty response.",
					},
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.hasError).toBe(true);
		expect(result.finalText).toContain("Provider returned an empty response");
	});

	test("reports taskReflection denial fingerprints from tool metadata", async () => {
		const ac = new AbortController();
		const fingerprint = '[{"kind":"complete","text":"standing constraint"}]';

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{
						type: "assistant_message",
						text: "",
						toolUses: [{ toolUseId: "edit-task", name: "Edit", input: {} }],
					},
					{
						type: "tool_result",
						toolUseId: "edit-task",
						toolName: "Edit",
						output: "taskReflection rejected the change",
						isError: true,
						metadata: {
							taskReflection: { decision: "revise", fingerprint },
						},
					},
					{ type: "done" },
				]),
				processEventFn: async () => null,
			},
		);

		expect(result.hadToolUses).toBe(true);
		expect(result.taskReflectionDenialFingerprint).toBe(fingerprint);
	});

	test("surfaces max-turn exhaustion without running generic error cleanup", async () => {
		const ac = new AbortController();
		const cleanupMessages: string[] = [];

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
				hooks: {
					onErrorCleanup: async (message) => {
						cleanupMessages.push(message);
					},
				},
			},
			{
				eventSource: makeEventSource([{ type: "max_turns_exceeded", maxTurns: 3 }]),
				processEventFn: async (event, _eventContext, hooks) => {
					if (event.type === "error") await hooks?.onErrorCleanup?.(event.message);
					return null;
				},
			},
		);

		expect(result.maxTurnsExceeded).toBe(true);
		expect(result.hasError).toBe(true);
		expect(result.finalText).toBe("Error: Max turns (3) exceeded");
		expect(cleanupMessages).toEqual([]);
	});

	test("rethrows critical persistence failures instead of continuing the loop", async () => {
		const ac = new AbortController();
		const failure = new CriticalEventPersistenceError("atomic commit failed");

		await expect(
			executeAgentLoop(
				{
					config: makeConfig(ac.signal),
					userText: "",
					history: [],
					eventContext: {} as EventHandlerContext,
				},
				{
					eventSource: makeEventSource([
						{
							type: "tool_result",
							toolUseId: "enter-plan",
							toolName: "EnterPlanMode",
							output: "entered",
							isError: false,
						},
					]),
					processEventFn: async () => {
						throw failure;
					},
				},
			),
		).rejects.toBe(failure);
	});
});

describe("executeAgentLoop abort draining", () => {
	test("marks silent disconnect without surfacing an error", async () => {
		const ac = new AbortController();
		const processed: string[] = [];

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([{ type: "silent_disconnect" }]),
				processEventFn: async (event) => {
					processed.push(event.type);
					return null;
				},
			},
		);

		expect(processed).toEqual(["silent_disconnect"]);
		expect(result.silentDisconnect).toBe(true);
		expect(result.hasError).toBe(false);
	});

	test("continues draining until Aborted error after tool_result", async () => {
		const ac = new AbortController();
		ac.abort();
		const processed: string[] = [];
		const cleanupMessages: string[] = [];

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
				hooks: {
					onErrorCleanup: async (message) => {
						cleanupMessages.push(message);
					},
				},
			},
			{
				eventSource: makeEventSource([
					{
						type: "tool_result",
						toolUseId: "tool-1",
						toolName: "Read",
						output: "ok",
						isError: false,
					},
					{ type: "error", message: "Aborted" },
				]),
				processEventFn: async (event, _eventContext, hooks) => {
					processed.push(event.type === "error" ? `error:${event.message}` : event.type);
					if (event.type === "error") {
						await hooks?.onErrorCleanup?.(event.message);
					}
					return null;
				},
			},
		);

		expect(processed).toEqual(["tool_result", "error:Aborted"]);
		expect(cleanupMessages).toEqual(["Aborted"]);
		expect(result.aborted).toBe(true);
		expect(result.hasError).toBe(false);
	});

	test("marks turn aborted when stream ends after post-abort tool_result", async () => {
		const ac = new AbortController();
		ac.abort();
		const processed: string[] = [];

		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{
						type: "tool_result",
						toolUseId: "tool-1",
						toolName: "Read",
						output: "ok",
						isError: false,
					},
				]),
				processEventFn: async (event) => {
					processed.push(event.type);
					return null;
				},
			},
		);

		expect(processed).toEqual(["tool_result"]);
		expect(result.aborted).toBe(true);
		expect(result.hasError).toBe(false);
	});

	test("drains block_complete after abort so flushed text is persisted", async () => {
		const ac = new AbortController();
		ac.abort();
		const processed: string[] = [];

		// On abort the agent loop flushes accumulated text/reasoning as
		// block_complete (see loop.ts). Text blocks are only persisted at flush
		// time, so the executor must not drop block_complete during abort draining.
		const result = await executeAgentLoop(
			{
				config: makeConfig(ac.signal),
				userText: "",
				history: [],
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: makeEventSource([
					{
						type: "block_complete",
						block: { type: "text", text: "completed text before interrupt" },
					},
					{ type: "error", message: "Aborted" },
				]),
				processEventFn: async (event) => {
					processed.push(event.type === "error" ? `error:${event.message}` : event.type);
					return null;
				},
			},
		);

		expect(processed).toEqual(["block_complete", "error:Aborted"]);
		expect(result.aborted).toBe(true);
		expect(result.hasError).toBe(false);
	});
});
