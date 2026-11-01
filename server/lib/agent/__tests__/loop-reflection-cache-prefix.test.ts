/**
 * loop-reflection-cache-prefix.test.ts — a reflection loop must reuse the parent
 * conversation's cacheable prefix byte-for-byte.
 *
 * Prompt caching is an exact prefix match, so the reflection request has to start
 * with the same bytes as the parent request it interrupts. The reflection receives the
 * rows the parent's request was projected from and projects them with the same adapter,
 * tools and system prompt, so the prefix is identical by construction; its prompt is
 * the input that follows it. A duplicated system prompt would land at the very front
 * and shift every following byte, re-billing the whole (often 100k+ token) prefix.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import type { DbMessage, ProviderAdapter } from "../provider";
import { markSenderProjected } from "../sender-projection";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig } from "../types";

const DECISION_TOOL_NAME = "CachePrefixDecisionTool";
const SYSTEM_PROMPT = "PARENT_SYSTEM_PROMPT";
let emittedTool = DECISION_TOOL_NAME;
let decisions = 0;

/** Requests the fake provider saw, in order. */
let captured: Array<{ history: unknown[]; content: string; tools: unknown[]; identity: unknown }> =
	[];

const testProvider: ProviderAdapter = {
	formatTools: (tools) =>
		tools.map((t) => ({
			name: t.name,
			description: t.description,
			input_schema: t.rawJsonSchema ?? z.toJSONSchema(t.parameters),
		})),
	// Mirrors the real providers: prepend a marker entry representing the system prompt.
	injectSystemPrompt: (history, systemPrompt) => {
		(history as unknown[]).unshift({ role: "system", content: systemPrompt });
	},
	// Deterministic over rows, like the real builders: one entry per row, in order.
	buildHistory: async (rows) => ({
		history: rows.map((row) => ({ role: row.role, content: row.contentText ?? "" })),
	}),
	async *chat(params) {
		params.onRequestStart?.();
		captured.push({
			history: JSON.parse(JSON.stringify(params.history)),
			content: params.content,
			tools: JSON.parse(JSON.stringify(params.tools)),
			identity: {
				conversationId: params.conversationId,
				stickySessionKey: params.stickySessionKey,
				metadata: params.metadata,
				model: params.model,
			},
		});
		yield {
			toolUses: [{ toolUseId: "tu_decide", name: emittedTool, input: { value: "ok" } }],
		};
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

const { agentLoop, runReflectionLoop } = await import("../loop");

toolRegistry.register({
	name: DECISION_TOOL_NAME,
	description: "Fake reflection decision tool",
	reflectionOnly: true,
	parameters: z.object({ value: z.string() }),
	execute: async () => {
		decisions++;
		return { output: "decided" };
	},
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

function row(id: string, role: DbMessage["role"], text: string): DbMessage {
	return {
		id,
		role,
		contentJson: [{ type: "text", text }],
		contentText: text,
		parentToolUseId: null,
		messageUuid: null,
	};
}

/** The conversation a parent request is projected from. */
function parentRows(): DbMessage[] {
	return [row("u1", "user", "first user turn"), row("a1", "assistant", "some work")];
}

async function runReflection(rows: DbMessage[]): Promise<unknown[]> {
	await runReflectionLoop({
		parentConfig: parentConfig(),
		rows,
		prompt: "REFLECTION_PROMPT",
		reflectionLoop: {
			allowedTools: [DECISION_TOOL_NAME],
			context: { kind: "taskReflection", requestId: "req-cache" },
		},
		label: "Cache prefix test loop",
	});
	return captured.at(-1)?.history ?? [];
}

/** The parent's request: its rows plus the input it sends. */
async function parentRequest(): Promise<unknown[]> {
	captured = [];
	for await (const _event of agentLoop({ ...parentConfig(), maxTurns: 1 }, "current input", {
		rows: parentRows(),
	})) {
		/* drain */
	}
	expect(captured.length).toBe(1);
	return captured[0].history;
}

function systemEntries(history: unknown[]): string[] {
	return (history as Array<{ role?: string; content?: unknown }>)
		.filter((m) => m?.role === "system")
		.map((m) => String(m.content));
}

describe("reflection loop cacheable prefix", () => {
	test("ordinary loops cannot execute reflection decisions", async () => {
		const before = decisions;
		for await (const _event of agentLoop({ ...parentConfig(), maxTurns: 1 }, "normal", {
			rows: [],
		})) {
			/* drain */
		}
		expect(decisions).toBe(before);
	});

	test("reflection rejects ordinary tools even with an allowing parent handler", async () => {
		let executed = false;
		const name = "CacheForbiddenTool";
		toolRegistry.register({
			name,
			description: "ordinary",
			parameters: z.object({ value: z.string() }),
			execute: async () => {
				executed = true;
				return { output: "bad" };
			},
		});
		emittedTool = name;
		try {
			const result = await runReflectionLoop({
				parentConfig: parentConfig(),
				rows: parentRows(),
				prompt: "reflect",
				reflectionLoop: {
					allowedTools: [DECISION_TOOL_NAME],
					context: { kind: "taskReflection", requestId: "denial" },
				},
			});
			expect(executed).toBe(false);
			expect(result.toolResults.some((r) => r.toolName === name && r.isError)).toBe(true);
		} finally {
			emittedTool = DECISION_TOOL_NAME;
			toolRegistry.unregister(name);
		}
	});
	for (const planMode of [false, true]) {
		test(`inherits complete ordered parent tools (planMode=${planMode})`, async () => {
			const dynamicName = "CacheStaticTool";
			toolRegistry.register({
				name: dynamicName,
				description: "Static description remains identical in plan and reflection modes",
				rawJsonSchema: {
					type: "object",
					properties: { value: { type: "string" } },
				},
				parameters: z.object({}),
				execute: async () => {
					throw new Error("Must not execute");
				},
			});
			try {
				captured = [];
				const characters: number[] = [];
				const config = {
					...parentConfig(),
					onToolsCharacters: (chars: number) => {
						characters.push(chars);
					},
					maxTurns: 1,
					planMode,
					toolFilter: (tool: { name: string }) => tool.name === dynamicName,
				};
				for await (const _event of agentLoop(config, "parent", { rows: [] })) {
					/* drain */
				}
				const parentTools = captured[0].tools;
				const parentCharacters = [...characters];
				expect(parentCharacters).toHaveLength(1);
				expect(parentCharacters[0]).toBeGreaterThan(0);
				expect(parentTools.map((t) => (t as { name: string }).name)).toContain(DECISION_TOOL_NAME);
				await runReflectionLoop({
					parentConfig: config,
					rows: parentRows(),
					prompt: "reflect",
					reflectionLoop: {
						allowedTools: [DECISION_TOOL_NAME],
						context: { kind: "taskReflection", requestId: "snapshot" },
					},
				});
				expect(JSON.stringify(captured[1].tools)).toBe(JSON.stringify(parentTools));
				// Auxiliary reflection must not replace the parent's context accounting.
				expect(characters).toEqual(parentCharacters);
				expect(captured[1].identity).toEqual(captured[0].identity);
				expect(parentTools).toContainEqual({
					name: dynamicName,
					description: "Static description remains identical in plan and reflection modes",
					input_schema: { type: "object", properties: { value: { type: "string" } } },
				});
			} finally {
				toolRegistry.unregister(dynamicName);
			}
		});
	}

	test("injects the parent's system prompt exactly once", async () => {
		captured = [];
		const history = await runReflection(parentRows());

		// Exactly one copy — a second copy is the cache-prefix bug.
		expect(systemEntries(history)).toEqual([SYSTEM_PROMPT]);
	});

	test("keeps the reflection prefix byte-identical to the parent's request", async () => {
		const parent = await parentRequest();
		// The rows the parent's request was projected from: its transcript plus its input,
		// which the loop writes as already in model form (no sender attribution).
		const input = markSenderProjected(row("in", "user", "current input"));
		const history = await runReflection([...parentRows(), input]);

		// The parent request survives verbatim, in order, at the front.
		expect(history.slice(0, parent.length)).toEqual(parent);
		expect(history).toHaveLength(parent.length + 1);
	});

	test("the reflection prompt is the input after the shared prefix", async () => {
		captured = [];
		const history = await runReflection(parentRows());

		// The gate's question is the last input row, so it cannot shift the cached bytes.
		expect(history.at(-1)).toEqual({ role: "user", content: "REFLECTION_PROMPT" });
		expect(captured.at(-1)?.content).toBe("");
	});

	test("an empty parent conversation still gets the system prompt", async () => {
		captured = [];
		const history = await runReflection([]);

		expect(systemEntries(history)).toEqual([SYSTEM_PROMPT]);
	});
});
