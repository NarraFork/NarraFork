import { describe, expect, test } from "bun:test";
import type { AgentConfig, AgentEvent } from "../../lib/agent/types";
import type { EventHandlerContext } from "../narrator-event-handler";
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

describe("executeAgentLoop smart interruption check", () => {
	test("does not treat an empty assistant turn as interrupted", async () => {
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

		expect(result.interrupted).toBe(false);
		expect(result.hasError).toBe(false);
	});

	test("does not treat an image-only assistant turn as interrupted", async () => {
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

		expect(result.interrupted).toBe(false);
		expect(result.hasError).toBe(false);
	});

	test("does not skip interruption check for image block_complete without result", async () => {
		const ac = new AbortController();

		// A block_complete with only revisedPrompt but no result means the image
		// data was never received — the interruption check should still run.
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

		// Without result, sawCompletedImageGeneration stays false, so the
		// empty-text guard in the interruption check path is not bypassed.
		// The turn has no meaningful text output, so it should not be interrupted.
		expect(result.interrupted).toBe(false);
		expect(result.hasError).toBe(false);
	});

	test("does not skip interruption check for lifecycle image_generation event alone", async () => {
		const ac = new AbortController();

		// A lifecycle image_generation event with status "completed" but without
		// a corresponding block_complete should not bypass the interruption check.
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

		expect(result.interrupted).toBe(false);
		expect(result.hasError).toBe(false);
	});

	test("treats empty-response invalid state as an error instead of interruption", async () => {
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
		expect(result.interrupted).toBe(false);
		expect(result.finalText).toContain("Provider returned an empty response");
	});
});

describe("executeAgentLoop abort draining", () => {
	test("marks silent disconnect without running interruption recovery", async () => {
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
		expect(result.interrupted).toBe(false);
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
});
