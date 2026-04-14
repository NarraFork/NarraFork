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

describe("executeAgentLoop abort draining", () => {
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
