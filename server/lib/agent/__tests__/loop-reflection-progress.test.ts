/**
 * loop-reflection-progress.test.ts — `runReflectionLoop` reports two-phase
 * progress while a gate deliberates.
 *
 * The gate families (danger / plan / task) run through this loop, so this is the
 * single place their "thinking · N chars" → "N chars" progress originates. The
 * loop must not broadcast anything itself (it has no gate identity), so progress
 * is delivered through the injected `onProgress` callback.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ProgressSnapshot } from "@shared/progress-phase";
import { z } from "zod/v4";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig } from "../types";

const DECISION_TOOL_NAME = "TestProgressDecisionTool";

/** What the fake provider streams before calling the decision tool. */
let streamPlan: Array<{ reasoning?: string; text?: string }> = [];

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		params.onRequestStart?.();
		for (const chunk of streamPlan) yield chunk;
		yield {
			toolUses: [{ toolUseId: "tu_decide", name: DECISION_TOOL_NAME, input: { value: "ok" } }],
		};
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

// Snapshot the real provider before mocking; afterAll re-points it back (Bun's
// mock.module is global and leaks; mock.restore() does not undo it).
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

const { runReflectionLoop } = await import("../loop");

toolRegistry.register({
	name: DECISION_TOOL_NAME,
	description: "Fake reflection decision tool",
	reflectionOnly: true,
	parameters: z.object({ value: z.string() }),
	execute: async () => ({ output: "decided" }),
});

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	toolRegistry.unregister(DECISION_TOOL_NAME);
	mock.restore();
});

function parentConfig(): AgentConfig {
	return {
		narratorId: "n-reflect-progress",
		conversationId: "conv-reflect-progress",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal: new AbortController().signal,
		permissionHandler: async () => ({ behavior: "allow" }),
	};
}

async function runWithPlan(
	plan: Array<{ reasoning?: string; text?: string }>,
): Promise<ProgressSnapshot[]> {
	streamPlan = plan;
	const seen: ProgressSnapshot[] = [];
	await runReflectionLoop({
		parentConfig: parentConfig(),
		history: [],
		prompt: "decide",
		reflectionLoop: {
			allowedTools: [DECISION_TOOL_NAME],
			context: { kind: "taskReflection", requestId: "req-1" },
		},
		label: "Progress test loop",
		onProgress: (snapshot) => seen.push(snapshot),
	});
	return seen;
}

describe("runReflectionLoop two-phase progress", () => {
	test("reports the thinking phase before any visible output", async () => {
		const seen = await runWithPlan([{ reasoning: "r".repeat(64) }]);

		expect(seen.length).toBeGreaterThan(0);
		const thinking = seen.find((s) => s.phase === "thinking");
		expect(thinking).toBeDefined();
		expect(thinking?.thinkingChars).toBe(64);
		// The whole point of the phase split: no visible output exists yet.
		expect(thinking?.outputChars).toBe(0);
	});

	test("switches to the output phase once visible text arrives", async () => {
		const seen = await runWithPlan([{ reasoning: "r".repeat(40) }, { text: "hello world" }]);

		const last = seen.at(-1);
		expect(last?.phase).toBe("output");
		expect(last?.outputChars).toBe("hello world".length);
		// The thinking total keeps accumulating behind the featured count.
		expect(last?.thinkingChars).toBe(40);
	});

	test("never regresses to thinking after output started", async () => {
		const seen = await runWithPlan([
			{ text: "abc" },
			{ reasoning: "late reasoning" },
			{ text: "def" },
		]);

		const firstOutputIndex = seen.findIndex((s) => s.phase === "output");
		expect(firstOutputIndex).toBeGreaterThanOrEqual(0);
		expect(seen.slice(firstOutputIndex).every((s) => s.phase === "output")).toBe(true);
	});

	test("runs normally with no progress callback attached", async () => {
		streamPlan = [{ reasoning: "r" }, { text: "t" }];
		const observed = await runReflectionLoop({
			parentConfig: parentConfig(),
			history: [],
			prompt: "decide",
			reflectionLoop: {
				allowedTools: [DECISION_TOOL_NAME],
				context: { kind: "taskReflection", requestId: "req-2" },
			},
			label: "Progress test loop",
		});
		expect(observed.toolCalls).toContain(DECISION_TOOL_NAME);
	});
});
