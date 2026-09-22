import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent } from "../types";

const REFLECTION_TOOL_NAME = "TestReflectDecisionTool";
const NORMAL_TOOL_NAME = "TestReflectNormalTool";

/** Records the order in which each tool's execute() started. */
const executionOrder: string[] = [];

let scenario: "reflection" | "normal" | "reflection_then_normal" = "reflection";
let onNormalStarted: (() => void) | undefined;

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		params.onRequestStart?.();
		// The ordinary eager baseline has no preceding reflection barrier. A separate
		// scenario verifies that ordinary work cannot overtake such a barrier.
		const toolName = scenario === "normal" ? NORMAL_TOOL_NAME : REFLECTION_TOOL_NAME;
		yield {
			toolUses: [
				{ toolUseId: "tu_decision", name: toolName, input: { value: "x" } },
				...(scenario === "reflection_then_normal"
					? [{ toolUseId: "tu_after_reflection", name: NORMAL_TOOL_NAME, input: { value: "y" } }]
					: []),
			],
		};
		yield { text: "trailing text after tool call" };
		// Hang until the caller aborts mid-stream (mirrors a real provider stream that is
		// still open when the reflection decision settles and aborts the reflection signal).
		while (!params.signal.aborted) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		throw new Error("Aborted");
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

toolRegistry.register({
	name: REFLECTION_TOOL_NAME,
	description: "Fake reflection decision tool",
	reflectionOnly: true,
	parameters: z.object({ value: z.string() }),
	execute: async (args) => {
		executionOrder.push(REFLECTION_TOOL_NAME);
		return { output: `reflect:${args.value}` };
	},
});

toolRegistry.register({
	name: NORMAL_TOOL_NAME,
	description: "Fake normal (eager-eligible) tool",
	parameters: z.object({ value: z.string() }),
	execute: async (args) => {
		executionOrder.push(NORMAL_TOOL_NAME);
		onNormalStarted?.();
		return { output: `normal:${args.value}` };
	},
});

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	toolRegistry.unregister(REFLECTION_TOOL_NAME);
	toolRegistry.unregister(NORMAL_TOOL_NAME);
	mock.restore();
});

function makeConfig(signal: AbortSignal): AgentConfig {
	return {
		narratorId: "n-reflect-eager",
		conversationId: "conv-reflect-eager",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
	};
}

async function runUntilAbortMidStream(): Promise<AgentEvent[]> {
	const ac = new AbortController();
	const events: AgentEvent[] = [];
	const normalStarted = new Promise<void>((resolve) => {
		onNormalStarted = resolve;
	});
	for await (const event of agentLoop(makeConfig(ac.signal), "decide", [])) {
		events.push(event);
		// Abort while the provider stream is still open (trailing text just arrived),
		// mirroring the reflection abort race that produced spurious "Aborted" records.
		if (event.type === "stream_text") {
			// A tool_call announcement alone does not imply execute() has started.
			// Wait for real execution only in the independent, barrier-free baseline.
			if (scenario === "normal") await normalStarted;
			ac.abort();
		}
	}
	onNormalStarted = undefined;
	return events;
}

describe("reflection-only tools are not eager-executed mid-stream", () => {
	test("reflection decision tool is deferred until the post-stream tool phase", async () => {
		scenario = "reflection";
		executionOrder.length = 0;

		const events = await runUntilAbortMidStream();

		// The reflection tool must NOT execute eagerly during streaming. When the stream is
		// aborted mid-flight (before the post-stream tool phase), a deferred tool never runs,
		// so its execute() is never called. This is the exact behavior that prevents the
		// reflection decision from aborting the reflection provider.chat() mid-stream and
		// recording a spurious "Aborted" API request.
		expect(executionOrder).not.toContain(REFLECTION_TOOL_NAME);
		expect(events.at(-1)).toEqual({ type: "error", message: "Aborted" });
	});

	test("ordinary tools after a reflection barrier do not execute mid-stream", async () => {
		scenario = "reflection_then_normal";
		executionOrder.length = 0;

		const events = await runUntilAbortMidStream();

		expect(executionOrder).toEqual([]);
		// Persisted but unstarted calls receive cancellation results, not execution.
		const results = events.filter((event) => event.type === "tool_result");
		expect(results).toHaveLength(2);
		expect(results.every((event) => event.isError && event.durationMs === 0)).toBe(true);
		expect(events.at(-1)).toEqual({ type: "error", message: "Aborted" });
	});

	test("a normal eager-eligible tool still executes during streaming", async () => {
		scenario = "normal";
		executionOrder.length = 0;

		const events = await runUntilAbortMidStream();

		// Baseline: a non-reflection tool IS eager-executed, so its execute() starts during
		// streaming even though the stream is aborted mid-flight. This guards against the fix
		// over-broadly disabling eager execution for ordinary tools.
		expect(executionOrder).toEqual([NORMAL_TOOL_NAME]);
		expect(events.some((event) => event.type === "assistant_message")).toBe(false);
		expect(events.filter((event) => event.type === "tool_result")).toMatchObject([
			{ toolUseId: "tu_decision", output: "normal:x", isError: false },
		]);
		expect(events.at(-1)).toEqual({ type: "error", message: "Aborted" });
	});
});
