/**
 * loop-reflection-cache-prefix.test.ts — a reflection loop must reuse the parent
 * conversation's cacheable prefix byte-for-byte.
 *
 * Prompt caching is an exact prefix match, so the reflection request has to start
 * with the same system prompt bytes as the parent turn it interrupts. The parent
 * `agentLoop` already injected the system prompt into the history array it hands
 * down, so the nested loop must NOT inject it a second time: a duplicate lands at
 * the very front of the request and shifts every following byte, forcing the whole
 * (often 100k+ token) prefix to be re-billed at full price instead of a cache read.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig } from "../types";

const DECISION_TOOL_NAME = "CachePrefixDecisionTool";
const SYSTEM_PROMPT = "PARENT_SYSTEM_PROMPT";

/** Requests the fake provider saw, in order. */
let captured: Array<{ history: unknown[]; content: string }> = [];

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools.map((t) => ({ name: t.name })),
	// Mirrors the real providers: prepend a marker entry representing the system prompt.
	injectSystemPrompt: (history, systemPrompt) => {
		(history as unknown[]).unshift({ role: "system", content: systemPrompt });
	},
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	async *chat(params) {
		params.onRequestStart?.();
		captured.push({
			history: JSON.parse(JSON.stringify(params.history)),
			content: params.content,
		});
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
		narratorId: "n-cache-prefix",
		conversationId: "conv-cache-prefix",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		systemPrompt: SYSTEM_PROMPT,
		signal: new AbortController().signal,
		permissionHandler: async () => ({ behavior: "allow" }),
	};
}

/** The history shape a parent agentLoop hands down: system prompt already injected. */
function parentHistory(): unknown[] {
	return [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: "first user turn" },
		{ role: "assistant", content: "some work" },
	];
}

async function runReflection(
	history: unknown[],
	injectParentSystemPrompt?: boolean,
): Promise<unknown[]> {
	captured = [];
	await runReflectionLoop({
		parentConfig: parentConfig(),
		history,
		prompt: "REFLECTION_PROMPT",
		reflectionLoop: {
			allowedTools: [DECISION_TOOL_NAME],
			context: { kind: "taskReflection", requestId: "req-cache" },
		},
		label: "Cache prefix test loop",
		...(injectParentSystemPrompt === undefined ? {} : { injectParentSystemPrompt }),
	});
	expect(captured.length).toBe(1);
	return captured[0].history;
}

function systemEntries(history: unknown[]): string[] {
	return (history as Array<{ role?: string; content?: unknown }>)
		.filter((m) => m?.role === "system")
		.map((m) => String(m.content));
}

describe("reflection loop cacheable prefix", () => {
	test("does not duplicate the system prompt already present in the parent history", async () => {
		const history = await runReflection(parentHistory());

		// Exactly one copy — a second copy is the cache-prefix bug.
		expect(systemEntries(history)).toEqual([SYSTEM_PROMPT]);
	});

	test("keeps the reflection prefix byte-identical to the parent prefix", async () => {
		const parent = parentHistory();
		const history = await runReflection(parent);

		// The parent turn's prefix must survive verbatim, in order, at the front.
		expect(history.slice(0, parent.length)).toEqual(parent);
	});

	test("the reflection prompt is the current turn, not part of the prefix", async () => {
		const parent = parentHistory();
		await runReflection(parent);

		// The gate's question rides in `content`, after the shared prefix, so it
		// cannot shift the cached bytes.
		expect(captured[0].content).toBe("REFLECTION_PROMPT");
	});

	test("still injects when the caller supplies a raw history without one", async () => {
		// A caller building its own history has no injected prompt to inherit.
		const history = await runReflection([], true);

		expect(systemEntries(history)).toEqual([SYSTEM_PROMPT]);
	});

	test("an empty inherited history injects the system prompt by default", async () => {
		const history = await runReflection([]);

		// Nothing was inherited, so suppressing injection would drop the prompt entirely.
		expect(systemEntries(history)).toEqual([SYSTEM_PROMPT]);
	});
});
