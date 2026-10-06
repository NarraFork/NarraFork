/**
 * End-to-end guard for providers that mint one tool_use id for every call.
 *
 * Reproduces the observed grok-4.5-behind-a-proxy behaviour: each turn returns
 * `call_go_0`. Nothing is wrong within a single turn, but the replayed history then
 * carries the same id in several assistant messages and the upstream rejects the
 * request with 400 "Found duplicate tool_use id". The loop must keep the model-facing
 * history unique while leaving the persisted/broadcast ids untouched.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent, AgentToolUse } from "../types";

const TEST_TOOL_NAME = "TestDupIdTool";
/** The id this provider repeats on every single tool call. */
const REPEATED_ID = "call_go_0";
/** How many tool turns the fake provider produces before answering with text. */
const TOOL_TURNS = 3;

let providerAttempts = 0;
/** Anthropic-ish history the fake provider accumulates, mirroring a real adapter. */
let history: Array<Record<string, unknown>> = [];
/** tool_use ids seen by pushAssistantTurn, per turn. */
const historyToolUseIdsPerTurn: string[][] = [];
/** tool_use_id values seen by pushUserTurn (the paired tool results). */
const historyToolResultIdsPerTurn: string[][] = [];

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		providerAttempts++;
		params.onRequestStart?.();

		// Assert what a real API would validate: no duplicate tool_use id anywhere in
		// the request. Throwing here would surface as a loop error event, so record it
		// as a plain failure the test can assert on afterwards.
		const seen = new Set<string>();
		for (const message of params.history as Array<Record<string, unknown>>) {
			const content = message.content;
			if (!Array.isArray(content)) continue;
			for (const block of content as Array<Record<string, unknown>>) {
				if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
				if (seen.has(block.id)) {
					throw new Error(`duplicate tool_use id "${block.id}" in request history`);
				}
				seen.add(block.id);
			}
		}

		if (providerAttempts <= TOOL_TURNS) {
			yield {
				toolUses: [{ toolUseId: REPEATED_ID, name: TEST_TOOL_NAME, input: { value: "x" } }],
			};
			return;
		}
		yield { text: "done" };
	},
	formatToolResult: (toolUseId, output, isError) => ({
		type: "tool_result",
		tool_use_id: toolUseId,
		content: output,
		is_error: isError,
	}),
	pushUserTurn: (h, content, _model, toolResults) => {
		const target = h as Array<Record<string, unknown>>;
		const results = toolResults as Array<Record<string, unknown>>;
		historyToolResultIdsPerTurn.push(
			results.map((tr) => String((tr as { tool_use_id?: string }).tool_use_id)),
		);
		target.push({
			role: "user",
			content: [...results, ...(content ? [{ type: "text", text: content }] : [])],
		});
	},
	pushAssistantTurn: (h, text, toolUses) => {
		const target = h as Array<Record<string, unknown>>;
		const uses = toolUses as AgentToolUse[];
		historyToolUseIdsPerTurn.push(uses.map((tu) => tu.toolUseId));
		target.push({
			role: "assistant",
			content: [
				...(text ? [{ type: "text", text }] : []),
				...uses.map((tu) => ({
					type: "tool_use",
					id: tu.toolUseId,
					name: tu.name,
					input: tu.input,
				})),
			],
		});
	},
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
	name: TEST_TOOL_NAME,
	description: "test tool for duplicate tool_use id handling",
	parameters: z.object({ value: z.string() }),
	execute: async () => ({ output: "ok" }),
});

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	mock.restore();
});

function makeConfig(signal: AbortSignal, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		narratorId: "n-dup-tool-id",
		conversationId: "conv-dup-tool-id",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		retryBackoffCeilMs: 1,
		...overrides,
	};
}

describe("agentLoop 处理提供商重复的 tool_use ID", () => {
	test("跨轮重复的 ID 在模型历史中被唯一化，但对外事件保留原始 ID", async () => {
		providerAttempts = 0;
		history = [];
		historyToolUseIdsPerTurn.length = 0;
		historyToolResultIdsPerTurn.length = 0;

		const ac = new AbortController();
		const events: AgentEvent[] = [];
		for await (const event of agentLoop(makeConfig(ac.signal), "go", history)) {
			events.push(event);
		}

		// No provider-side validation failure: the request history stayed unique.
		const errors = events.filter((e) => e.type === "error");
		expect(errors).toEqual([]);

		// The loop ran all tool turns plus the final text turn.
		expect(providerAttempts).toBe(TOOL_TURNS + 1);
		expect(historyToolUseIdsPerTurn).toHaveLength(TOOL_TURNS);

		// Model-facing history: every tool_use id is unique across turns, and the first
		// turn keeps the provider's original id.
		const historyIds = historyToolUseIdsPerTurn.flat();
		expect(historyIds).toHaveLength(TOOL_TURNS);
		expect(new Set(historyIds).size).toBe(TOOL_TURNS);
		expect(historyIds[0]).toBe(REPEATED_ID);

		// Each replayed tool result matches the tool_use id of the turn it answers,
		// so no orphaned result / unanswered call reaches the API.
		const pairedResultIds = historyToolResultIdsPerTurn.flat().filter(Boolean);
		expect(pairedResultIds).toEqual(historyIds.slice(0, pairedResultIds.length));

		// Outward-facing events (persistence, UI, permissions) keep the provider's id.
		const toolCallIds = events
			.filter((e) => e.type === "tool_call")
			.map((e) => (e as { toolUseId: string }).toolUseId);
		const toolResultIds = events
			.filter((e) => e.type === "tool_result")
			.map((e) => (e as { toolUseId: string }).toolUseId);
		expect(toolCallIds).toEqual(Array(TOOL_TURNS).fill(REPEATED_ID));
		expect(toolResultIds).toEqual(Array(TOOL_TURNS).fill(REPEATED_ID));
	});
});
