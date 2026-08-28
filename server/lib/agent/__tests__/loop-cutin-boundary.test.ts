import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent } from "../types";

/**
 * A cut-in ("插队 · 下次请求时发送") queued while a tool is already running must be
 * answered by the request that follows THAT tool call.
 *
 * The regression this pins: `shouldStop` was only consulted in the post-stream tool
 * phase, but the primary narrator eagerly STARTS every tool of the turn as its input
 * finishes streaming. Eagerly started tools are awaited and delivered by the execution
 * phase (never skipped), so every remaining tool of the turn still ran and the queued
 * message effectively waited for the request after next — reported as "下次请求时发送"
 * behaving like "下下次请求时发送".
 *
 * Subagents were unaffected because they pass `deferEagerToolsForSafeStop`, which is
 * why this went unnoticed: the same code with one flag flipped behaved correctly.
 */

const SLOW = "CutInSlowTool";
const FAST = "CutInFastTool";

const executed: string[] = [];
let releaseSlow: (() => void) | undefined;
/** Invoked mid-stream, right after the slow tool's input finishes arriving. */
let queueCutIn: (() => void) | undefined;

/**
 * Let the slow tool finish, waiting for it to actually start first.
 *
 * When it starts depends on the configuration under test: eagerly during streaming,
 * or in the post-stream tool phase under `deferEagerToolsForSafeStop`. Releasing
 * blindly would no-op in the deferred case and hang the turn.
 */
async function releaseSlowOnceStarted(): Promise<void> {
	for (let i = 0; i < 2000 && !releaseSlow; i++) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	releaseSlow?.();
}

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		params.onRequestStart?.();
		// One long-running tool, then three more streamed in the SAME turn — the shape
		// of a model that keeps working while the user types a cut-in.
		yield {
			toolUseChunk: {
				toolUseId: "tu_slow",
				name: SLOW,
				input: JSON.stringify({ value: "in-flight" }),
				outputIndex: 0,
			},
		};
		yield { toolUseChunk: { toolUseId: "tu_slow", stop: true } };

		queueCutIn?.();
		await new Promise((resolve) => setTimeout(resolve, 10));

		let outputIndex = 1;
		for (const name of ["b", "c", "d"]) {
			yield {
				toolUseChunk: {
					toolUseId: `tu_${name}`,
					name: FAST,
					input: JSON.stringify({ value: name }),
					outputIndex: outputIndex++,
				},
			};
			yield { toolUseChunk: { toolUseId: `tu_${name}`, stop: true } };
			await new Promise((resolve) => setTimeout(resolve, 5));
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
	name: SLOW,
	description: "Long-running tool for cut-in boundary tests",
	parameters: z.object({ value: z.string() }),
	execute: async (args) => {
		executed.push(`slow:${args.value}`);
		await new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		return { output: `done:${args.value}` };
	},
});

toolRegistry.register({
	name: FAST,
	description: "Fast tool for cut-in boundary tests",
	parameters: z.object({ value: z.string() }),
	execute: async (args) => {
		executed.push(`fast:${args.value}`);
		return { output: `done:${args.value}` };
	},
});

afterAll(() => {
	releaseSlow?.();
	mock.module("../provider", () => realProviderModule);
	toolRegistry.unregister(SLOW);
	toolRegistry.unregister(FAST);
	mock.restore();
});

/**
 * Run one turn, queueing a cut-in while the first tool is still executing.
 *
 * `shouldStop` mirrors the host's one-shot contract (`evaluateSoftStopRequest`):
 * the request is consumed by whoever observes it first, so a loop that asks twice
 * and keeps only the second answer would see `false` and carry on.
 */
async function runTurnWithCutIn(overrides: Partial<AgentConfig> = {}): Promise<{
	executed: string[];
	skipped: string[];
	softStopAsks: number;
}> {
	executed.length = 0;
	releaseSlow = undefined;
	let queued = false;
	let softStopAsks = 0;

	queueCutIn = () => {
		queued = true;
		// The tool that was running when the cut-in arrived still finishes.
		void releaseSlowOnceStarted();
	};

	const events: AgentEvent[] = [];
	for await (const event of agentLoop(
		{
			narratorId: "n-cutin",
			conversationId: "conv-cutin",
			model: "test:model",
			provider: "test",
			cwd: "/tmp",
			signal: new AbortController().signal,
			permissionHandler: async () => ({ behavior: "allow" }),
			shouldStop: () => {
				softStopAsks++;
				if (!queued) return false;
				queued = false; // one-shot, like the real flag
				return true;
			},
			...overrides,
		} satisfies AgentConfig,
		"do a long task",
		[],
	)) {
		events.push(event);
	}

	return {
		executed: [...executed],
		skipped: events
			.filter((e) => e.type === "tool_result" && e.metadata?.skippedForSoftStop === true)
			.map((e) => (e as Extract<AgentEvent, { type: "tool_result" }>).toolUseId),
		softStopAsks,
	};
}

describe("cut-in queued while a tool is running", () => {
	test("no later tool of the turn runs once the cut-in is queued", async () => {
		const result = await runTurnWithCutIn();

		// The tool that was already in flight completes — a cut-in must never abort it.
		expect(result.executed).toEqual(["slow:in-flight"]);
		// Everything the model streamed afterwards is reported as skipped, so the model
		// sees why it did not run instead of a silently missing tool_result.
		expect(result.skipped).toEqual(["tu_b", "tu_c", "tu_d"]);
	});

	test("subagents keep their existing behaviour", async () => {
		// Subagents already deferred eager execution; this pins that the shared gate did
		// not change their outcome.
		const result = await runTurnWithCutIn({ deferEagerToolsForSafeStop: true });

		expect(result.executed).toEqual(["slow:in-flight"]);
		expect(result.skipped).toEqual(["tu_b", "tu_c", "tu_d"]);
	});

	test("a granted soft stop is consumed once, not re-asked per boundary", async () => {
		// The host's flag is one-shot: re-asking after a grant returns the NEXT request's
		// answer, which would resurrect the turn the loop already agreed to end. Granting
		// on the first ask (whichever phase makes it) and refusing forever after is the
		// harshest version of that contract.
		let asks = 0;
		let granted = false;
		const result = await runTurnWithCutIn({
			shouldStop: () => {
				asks++;
				if (granted) return false;
				granted = true;
				void releaseSlowOnceStarted();
				return true;
			},
		});

		expect(asks).toBeGreaterThan(0);
		expect(result.executed).toEqual(["slow:in-flight"]);
		expect(result.skipped).toEqual(["tu_b", "tu_c", "tu_d"]);
	});
});
