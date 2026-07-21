import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent } from "../types";

// Records which tools' execute() actually started, in start order.
const executionOrder: string[] = [];
// Model-facing tool_result order (provider.formatToolResult call order).
const modelResultOrder: string[] = [];

let scenario:
	| "parallel_reject_middle"
	| "serial_reject"
	| "await_send_not_eager"
	| "parallel_all_reject" = "parallel_reject_middle";
let providerAttempts = 0;

const PARALLEL_TOOL_NAMES = ["Read", "Glob", "Grep"] as const;

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		providerAttempts++;
		params.onRequestStart?.();
		// After the tool turn, end the conversation with plain text so the loop does not
		// re-emit the same tool calls until maxTurns.
		if (
			providerAttempts > 1 &&
			(scenario === "parallel_reject_middle" ||
				scenario === "parallel_all_reject" ||
				scenario === "serial_reject")
		) {
			yield { text: "done" };
			return;
		}
		if (scenario === "parallel_reject_middle") {
			// Read/Glob/Grep are all in the production parallel-safe set; Glob rejects.
			yield {
				toolUses: [
					{ toolUseId: "tu_a", name: "Read", input: { value: "a" } },
					{ toolUseId: "tu_b", name: "Glob", input: { value: "b" } },
					{ toolUseId: "tu_c", name: "Grep", input: { value: "c" } },
				],
			};
			return;
		}
		if (scenario === "parallel_all_reject") {
			// Every production parallel-safe tool in the group rejects.
			yield {
				toolUses: [
					{ toolUseId: "tu_r1", name: "Read", input: { value: "r1" } },
					{ toolUseId: "tu_r2", name: "Glob", input: { value: "r2" } },
					{ toolUseId: "tu_r3", name: "Grep", input: { value: "r3" } },
				],
			};
			return;
		}
		if (scenario === "serial_reject") {
			yield {
				toolUses: [{ toolUseId: "tu_serial", name: "Write", input: { value: "s" } }],
			};
			return;
		}
		if (scenario === "await_send_not_eager") {
			// An Agent-like tool then Await + Send. We only assert that Await/Send do not
			// execute eagerly during streaming (their execute() must not run before the
			// post-stream tool phase, which never arrives because we abort mid-stream).
			yield {
				toolUses: [
					{ toolUseId: "tu_await", name: "Await", input: { type: "bash", id: "x" } },
					{ toolUseId: "tu_send", name: "Send", input: { id: "y", message: "hi" } },
				],
			};
			yield { text: "trailing text so we can abort mid-stream" };
			while (!params.signal.aborted) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			throw new Error("Aborted");
		}
	},
	formatToolResult: (toolUseId, output, isError) => {
		modelResultOrder.push(String(toolUseId));
		return { toolUseId, output, isError };
	},
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

// Snapshot real provider before mocking; afterAll re-points it back (Bun mock.module is
// global and leaks; mock.restore() does not undo it).
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

for (const name of PARALLEL_TOOL_NAMES) {
	toolRegistry.register({
		name,
		description: `Test override for production parallel-safe tool ${name}`,
		parameters: z.object({ value: z.string() }),
		execute: async (args) => {
			executionOrder.push(`${name}:${args.value}`);
			if (scenario === "parallel_all_reject" || name === "Glob") {
				throw new Error(`boom:${args.value}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
			return { output: `ok:${args.value}` };
		},
	});
}

toolRegistry.register({
	name: "Write",
	description: "Test override for a production serial tool",
	parameters: z.object({ value: z.string() }),
	execute: async (args) => {
		executionOrder.push(`Write:${args.value}`);
		throw new Error(`boom:${args.value}`);
	},
});

toolRegistry.register({
	name: "Await",
	description: "Test Await tool (should never eager-execute)",
	parameters: z.object({ type: z.string(), id: z.string() }),
	execute: async () => {
		executionOrder.push("Await");
		return { output: "await-done" };
	},
});

toolRegistry.register({
	name: "Send",
	description: "Test Send tool (should never eager-execute)",
	parameters: z.object({ id: z.string(), message: z.string() }),
	execute: async () => {
		executionOrder.push("Send");
		return { output: "send-done" };
	},
});

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	for (const name of [...PARALLEL_TOOL_NAMES, "Write", "Await", "Send"]) {
		toolRegistry.unregister(name);
	}
	mock.restore();
});

function makeConfig(signal: AbortSignal, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		narratorId: "n-settle",
		conversationId: "conv-settle",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		...overrides,
	};
}

function toolResults(events: AgentEvent[]): Extract<AgentEvent, { type: "tool_result" }>[] {
	return events.filter(
		(event): event is Extract<AgentEvent, { type: "tool_result" }> => event.type === "tool_result",
	);
}

describe("agent loop tool-result settlement", () => {
	test("a rejecting parallel tool becomes isError while siblings keep yielding, model order preserved", async () => {
		scenario = "parallel_reject_middle";
		providerAttempts = 0;
		executionOrder.length = 0;
		modelResultOrder.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		// deferEagerToolsForSafeStop keeps execution in the deterministic post-stream group
		// phase so the parallel group is exercised via executeToolAfterReflections directly.
		for await (const event of agentLoop(
			makeConfig(ac.signal, { deferEagerToolsForSafeStop: true }),
			"run parallel tools with one failure",
			[],
		)) {
			events.push(event);
		}

		const results = toolResults(events);
		// All three siblings still produced a tool_result — the rejection did not abort the group.
		expect(results.map((r) => r.toolUseId).sort()).toEqual(["tu_a", "tu_b", "tu_c"]);

		const byId = new Map(results.map((r) => [r.toolUseId, r]));
		expect(byId.get("tu_a")?.isError).toBe(false);
		expect(byId.get("tu_c")?.isError).toBe(false);
		// The genuine rejection was converted into a formal isError result.
		expect(byId.get("tu_b")?.isError).toBe(true);
		expect(byId.get("tu_b")?.output).toContain("boom:b");

		// Model-facing results are assembled in the original call order regardless of
		// completion order or the middle failure.
		expect(modelResultOrder).toEqual(["tu_a", "tu_b", "tu_c"]);

		// The loop completed the tool turn instead of surfacing a fatal error.
		expect(events.some((e) => e.type === "error")).toBe(false);
		expect(events.some((e) => e.type === "turn_complete")).toBe(true);
	});

	test("every parallel tool rejecting still yields isError results and completes the turn", async () => {
		scenario = "parallel_all_reject";
		providerAttempts = 0;
		executionOrder.length = 0;
		modelResultOrder.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			makeConfig(ac.signal, { deferEagerToolsForSafeStop: true }),
			"run parallel tools that all throw",
			[],
		)) {
			events.push(event);
		}

		const results = toolResults(events);
		expect(results.map((r) => r.toolUseId).sort()).toEqual(["tu_r1", "tu_r2", "tu_r3"]);
		expect(results.every((r) => r.isError === true)).toBe(true);
		// Model-facing order still follows the original call order.
		expect(modelResultOrder).toEqual(["tu_r1", "tu_r2", "tu_r3"]);
		expect(events.some((e) => e.type === "error")).toBe(false);
		expect(events.some((e) => e.type === "turn_complete")).toBe(true);
	});

	test("a rejecting serial tool becomes isError instead of aborting the loop", async () => {
		scenario = "serial_reject";
		providerAttempts = 0;
		executionOrder.length = 0;
		modelResultOrder.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			makeConfig(ac.signal, { deferEagerToolsForSafeStop: true }),
			"run a serial tool that throws",
			[],
		)) {
			events.push(event);
		}

		const results = toolResults(events);
		expect(results).toHaveLength(1);
		expect(results[0]?.toolUseId).toBe("tu_serial");
		expect(results[0]?.isError).toBe(true);
		expect(results[0]?.output).toContain("boom:s");
		expect(modelResultOrder).toEqual(["tu_serial"]);
		expect(events.some((e) => e.type === "error")).toBe(false);
		expect(events.some((e) => e.type === "turn_complete")).toBe(true);
	});

	test("Await and Send are not eager-executed mid-stream", async () => {
		scenario = "await_send_not_eager";
		providerAttempts = 0;
		executionOrder.length = 0;
		modelResultOrder.length = 0;
		const ac = new AbortController();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(makeConfig(ac.signal), "await then send", [])) {
			events.push(event);
			if (event.type === "stream_text") {
				await Promise.resolve();
				ac.abort();
			}
		}

		// Aborting mid-stream means the post-stream tool phase never runs. Because Await/Send
		// are eager-disabled, their execute() must not have started during streaming.
		expect(executionOrder).not.toContain("Await");
		expect(executionOrder).not.toContain("Send");
		expect(events.at(-1)).toEqual({ type: "error", message: "Aborted" });
	});
});
