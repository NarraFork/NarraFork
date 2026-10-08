/**
 * injection-row-placement.test.ts — where an injected `sys` ROW lands in the request.
 *
 * ## Why this is the gate for Phase 3
 *
 * The remaining side-cars are `target: "tool_result"`: their text is appended INSIDE a
 * tool result's string, right after the output. Moving them onto message rows changes
 * where the model reads them — after the whole tool batch, as their own turn entry —
 * and that placement is decided by seven separate `buildHistory` implementations.
 *
 * Two things must hold for every provider, or the migration silently corrupts requests:
 *
 *  1. The injected text is PRESENT and lands after the tool results it follows.
 *  2. `tool_use` ↔ `tool_result` pairing survives. A stray user turn inserted between
 *     an assistant's tool_use and its result is a 400 from Anthropic, and on some
 *     triggers a synthetic assistant `"OK"` that pushes the real message out of place.
 *
 * These are asserted BEFORE the producers move, against the `sys` rows the existing
 * `autoContinuation` path already writes — i.e. the mechanism is proven on traffic that
 * exists today, and Phase 3 then only changes who produces it.
 *
 * Byte equality with the side-car form is deliberately NOT asserted: the whole point is
 * that the text moves out of the tool_result string. What matters is completeness,
 * position, pairing, and appearing exactly once.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INJECTION = "Dynamic Spec reminder: 1 open task — migrate the queues";

type Row = {
	id: string;
	role: "user" | "assistant" | "sys";
	contentJson: unknown;
	contentText: string | null;
	parentToolUseId: string | null;
	messageUuid: string | null;
	narratorId?: string;
	toolCalls: Array<{
		toolUseId: string;
		toolName: string;
		inputJson: unknown;
		outputJson: unknown;
		status: string;
	}>;
};

function userRow(text = "Inspect the repo."): Row {
	return {
		id: "u1",
		role: "user",
		contentJson: [{ type: "text", text }],
		contentText: text,
		parentToolUseId: null,
		messageUuid: null,
		toolCalls: [],
	};
}

/** An assistant turn that called one tool, with the tool's result attached. */
function assistantWithTool(id: string, toolUseId: string): Row {
	return {
		id,
		role: "assistant",
		contentJson: [
			{ type: "text", text: "Reading the file." },
			{ type: "tool_use", id: toolUseId, name: "Read", input: { file_path: "/a" } },
		],
		contentText: "Reading the file.",
		parentToolUseId: null,
		messageUuid: null,
		toolCalls: [
			{
				toolUseId,
				toolName: "Read",
				inputJson: { file_path: "/a" },
				outputJson: "file contents here",
				status: "success",
			},
		],
	};
}

function sysRow(text = INJECTION): Row {
	return {
		id: "s1",
		role: "sys",
		contentJson: [{ type: "text", text }],
		contentText: text,
		parentToolUseId: null,
		messageUuid: null,
		toolCalls: [],
	};
}

/**
 * The shape Phase 3 produces: a tool ran, an injection row followed it, and the
 * assistant then took another turn (so the injection is mid-history, not trailing).
 *
 * Trailing rows are excluded on purpose — every provider pops the trailing turn to send
 * as the current message, which would prove nothing about PLACEMENT.
 */
function historyWithInjection(): Row[] {
	return [
		userRow(),
		assistantWithTool("a1", "tool_1"),
		sysRow(),
		{
			id: "a2",
			role: "assistant",
			contentJson: [{ type: "text", text: "Done." }],
			contentText: "Done.",
			parentToolUseId: null,
			messageUuid: null,
			toolCalls: [],
		},
		userRow("and now the current turn"),
	];
}

/** Every string anywhere in a payload, for presence and single-occurrence checks. */
function allText(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) allText(item, out);
	else if (value && typeof value === "object") {
		for (const nested of Object.values(value)) allText(nested, out);
	}
	return out;
}

function occurrences(payload: unknown, needle: string): number {
	return allText(payload).filter((text) => text.includes(needle)).length;
}

let testHome = "";
let originalHome: string | undefined;

beforeAll(() => {
	originalHome = process.env.HOME;
	testHome = mkdtempSync(join(tmpdir(), "narrafork-injection-placement-"));
	process.env.HOME = testHome;
});

afterAll(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (testHome) {
		rmSync(testHome, { recursive: true, force: true });
		testHome = "";
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic
// ─────────────────────────────────────────────────────────────────────────────

describe("Anthropic — an injected sys row", () => {
	// Reached through the provider's public `buildHistory`, as the sibling history tests
	// do: the builders themselves are module-private and widening their visibility for a
	// test would misrepresent the API.
	async function build(officialApi: boolean) {
		const { AnthropicProvider } = await import("../anthropic-provider");
		const provider = new (
			AnthropicProvider as unknown as new (
				config: Record<string, unknown>,
			) => {
				buildHistory: (
					rows: unknown[],
					model: string,
				) => Promise<{ history: unknown[]; trailingToolResults: unknown[] }>;
			}
		)({
			id: "test-anthropic",
			name: "Test Anthropic",
			prefix: "anthropic",
			apiKey: "test-key",
			baseUrl: "https://example.com/v1",
			defaultModel: "claude-sonnet-4",
			officialApi,
		});
		return provider.buildHistory(historyWithInjection(), "anthropic:claude-sonnet-4");
	}

	test("reaches the model exactly once, after the tool result", async () => {
		const { history } = await build(false);
		expect(occurrences(history, INJECTION)).toBe(1);

		// The tool result and the injection must share one user turn (or be adjacent
		// turns): what must NOT happen is the injection landing before the result.
		const flat = JSON.stringify(history);
		expect(flat.indexOf("file contents here")).toBeLessThan(flat.indexOf(INJECTION));
	});

	test("does not break tool_use ↔ tool_result pairing", async () => {
		const { history } = await build(false);
		const uses: string[] = [];
		const results: string[] = [];
		for (const message of history as Array<{ role: string; content: unknown }>) {
			for (const block of Array.isArray(message.content) ? message.content : []) {
				const part = block as { type?: string; id?: string; tool_use_id?: string };
				if (part.type === "tool_use" && part.id) uses.push(part.id);
				if (part.type === "tool_result" && part.tool_use_id) results.push(part.tool_use_id);
			}
		}
		expect(uses).toEqual(["tool_1"]);
		expect(results).toEqual(["tool_1"]);
	});

	test("the ON-THE-WIRE request alternates, with the injection intact", async () => {
		// `buildHistory` legitimately leaves `user(tool_result) , user(injection)` adjacent:
		// alternation is normalized LATER by `ensureAlternating` at request time
		// (anthropic-provider.ts:1340). Asserting on buildHistory's output alone would
		// report a violation the API never sees, so this captures the actual request body
		// by intercepting fetch — the only place the real invariant lives.
		const { AnthropicProvider } = await import("../anthropic-provider");
		const provider = new (
			AnthropicProvider as unknown as new (
				config: Record<string, unknown>,
			) => {
				buildHistory: (
					rows: unknown[],
					model: string,
				) => Promise<{ history: unknown[]; trailingToolResults: unknown[] }>;
				chat: (params: Record<string, unknown>) => AsyncGenerator<unknown>;
			}
		)({
			id: "test-anthropic",
			name: "Test Anthropic",
			prefix: "anthropic",
			apiKey: "test-key",
			baseUrl: "https://example.com/v1",
			defaultModel: "claude-sonnet-4",
			officialApi: false,
		});

		const built = await provider.buildHistory(historyWithInjection(), "anthropic:claude-sonnet-4");

		let sentBody: { messages: Array<{ role: string; content: unknown }> } | null = null;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
			sentBody = JSON.parse(init?.body ?? "{}");
			// A minimal well-formed SSE stream: the assertion is on the REQUEST, so the
			// response only has to let `chat` finish without throwing.
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
						);
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof globalThis.fetch;

		try {
			for await (const _event of provider.chat({
				history: built.history,
				content: "",
				model: "anthropic:claude-sonnet-4",
				tools: [],
				toolResults: built.trailingToolResults,
				conversationId: "conv-1",
			})) {
				// drain
			}
		} finally {
			globalThis.fetch = realFetch;
		}

		expect(sentBody).not.toBeNull();
		const messages = (sentBody as unknown as { messages: Array<{ role: string }> }).messages;

		const roles = messages.map((m) => m.role);
		for (let i = 1; i < roles.length; i++) {
			// `system` entries are independent and may sit anywhere; only user/assistant
			// repeating is what the API rejects.
			if (roles[i] === "system" || roles[i - 1] === "system") continue;
			expect(roles[i]).not.toBe(roles[i - 1]);
		}

		// Normalization must not lose the injection nor move it before the tool result.
		expect(occurrences(messages, INJECTION)).toBe(1);
		const flat = JSON.stringify(messages);
		expect(flat.indexOf("file contents here")).toBeLessThan(flat.indexOf(INJECTION));
	});

	test("official requests may carry it as a real mid-conversation system message", async () => {
		const { history } = await build(true);
		expect(occurrences(history, INJECTION)).toBe(1);
		const systemEntries = (history as Array<{ role: string; content: unknown }>).filter(
			(m) => m.role === "system",
		);
		expect(systemEntries.length).toBe(1);
		expect(JSON.stringify(systemEntries[0].content)).toContain(INJECTION);
	});

	test("compatible relays fold it into a user turn instead", async () => {
		const { history } = await build(false);
		expect((history as Array<{ role: string }>).some((m) => m.role === "system")).toBe(false);
		expect(occurrences(history, INJECTION)).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI — both request shapes
// ─────────────────────────────────────────────────────────────────────────────

describe("OpenAI — an injected sys row", () => {
	async function build(apiMode: "responses" | "completions") {
		const { OpenAIProvider } = await import("../openai-provider");
		const provider = new (
			OpenAIProvider as unknown as new (
				config: Record<string, unknown>,
			) => {
				buildHistory: (
					rows: unknown[],
					model: string,
				) => Promise<{ history: unknown[]; trailingToolResults: unknown[] }>;
			}
		)({
			id: "test-openai",
			name: "Test OpenAI",
			prefix: "openai",
			apiKey: "test-key",
			baseUrl: "https://example.com/v1",
			defaultModel: "gpt-5",
			apiMode,
		});
		return provider.buildHistory(historyWithInjection(), "openai:gpt-5");
	}

	test("Responses input carries it once, after the tool output", async () => {
		const { history } = await build("responses");
		expect(occurrences(history, INJECTION)).toBe(1);
		const flat = JSON.stringify(history);
		expect(flat.indexOf("file contents here")).toBeLessThan(flat.indexOf(INJECTION));
	});

	test("Responses keeps every function_call paired with its output", async () => {
		const { history } = await build("responses");
		const items = history as Array<{ type?: string; call_id?: string }>;
		const calls = items.filter((i) => i.type === "function_call").map((i) => i.call_id);
		const outputs = items.filter((i) => i.type === "function_call_output").map((i) => i.call_id);
		expect(calls).toEqual(["tool_1"]);
		expect(outputs).toEqual(["tool_1"]);
	});

	test("Responses does not emit a developer role for the injection", async () => {
		// A `developer`/`system` item would be hoisted into `instructions` by translating
		// proxies, leaving `input` short of the text — the failure the sys mapping avoids.
		const { history } = await build("responses");
		expect(JSON.stringify(history)).not.toContain('"role":"developer"');
	});

	test("Chat Completions carries it once, after the tool message", async () => {
		const { history } = await build("completions");
		expect(occurrences(history, INJECTION)).toBe(1);
		const flat = JSON.stringify(history);
		expect(flat.indexOf("file contents here")).toBeLessThan(flat.indexOf(INJECTION));
	});

	test("Chat Completions keeps tool_calls paired with their tool messages", async () => {
		const { history } = await build("completions");
		const messages = history as Array<{
			role: string;
			tool_call_id?: string;
			tool_calls?: Array<{ id: string }>;
		}>;
		const called = messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id));
		const answered = messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
		expect(called).toEqual(["tool_1"]);
		expect(answered).toEqual(["tool_1"]);
	});
});
