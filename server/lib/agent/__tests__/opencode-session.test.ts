import { describe, expect, test } from "bun:test";
import type { AnthropicProviderConfig, OpenAIProviderConfig } from "../../settings";
import { AnthropicProvider } from "../anthropic-provider";
import { OpenAIProvider } from "../openai-provider";
import {
	buildOpencodeSessionHeader,
	deriveOpencodeSessionId,
	isOpencodeEndpoint,
	OPENCODE_SESSION_HEADER,
} from "../opencode-session";

/**
 * OpenCode Go's session header.
 *
 * OpenCode routes a session to one upstream provider so its prompt cache hits,
 * and reads the session identity from `x-opencode-session` alone — neither the
 * Anthropic nor the OpenAI wire format it speaks carries one. Requests without
 * it are announced to start erroring.
 *
 * Every assertion below goes through the real outgoing request rather than a
 * provider field: the wire is what OpenCode reads, and a value that is computed
 * but never serialized would satisfy any weaker check.
 */

const CONVERSATION = "0f9d3a1e-2b4c-4d5e-8f10-112233445566";
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Drive one chat turn against a stubbed fetch and return the request headers. */
async function chatHeaders(
	provider: { chat: (params: never) => AsyncIterable<unknown> },
	model: string,
	body: string,
): Promise<Headers> {
	const original = globalThis.fetch;
	let captured = new Headers();
	globalThis.fetch = (async (_input: unknown, init: { headers?: unknown }) => {
		// Normalized through Headers because the request layer may pass a plain
		// record or a Headers instance, and header names are case-insensitive on
		// the wire — a record lookup by exact case would fail a correct request.
		captured = new Headers((init?.headers ?? {}) as HeadersInit);
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}) as unknown as typeof fetch;
	try {
		for await (const _event of provider.chat({
			conversationId: CONVERSATION,
			content: "hi",
			model,
			cwd: "/w",
			history: [],
			tools: [],
			toolResults: [],
			signal: new AbortController().signal,
		} as never)) {
			// drain
		}
	} finally {
		globalThis.fetch = original;
	}
	return captured;
}

function anthropicConfig(overrides: Partial<AnthropicProviderConfig> = {}) {
	return {
		id: "opencode-anthropic-test",
		name: "OpenCode Go",
		prefix: "og",
		apiKey: "key",
		baseUrl: "https://opencode.ai/zen/go/v1",
		defaultModel: "minimax-m3",
		officialApi: false,
		...overrides,
	} as unknown as AnthropicProviderConfig;
}

function openaiConfig(overrides: Partial<OpenAIProviderConfig> = {}) {
	return {
		id: "opencode-openai-test",
		name: "OpenCode Go",
		prefix: "og",
		apiKey: "key",
		baseUrl: "https://opencode.ai/zen/go/v1",
		defaultModel: "glm-5.3",
		apiMode: "completions",
		...overrides,
	} as unknown as OpenAIProviderConfig;
}

describe("isOpencodeEndpoint", () => {
	test("matches the hosted gateway on every path it serves", () => {
		// Three model families, three paths, one host — which is why the check is
		// host-based rather than pinned to any one of them.
		expect(isOpencodeEndpoint("https://opencode.ai/zen/go/v1")).toBe(true);
		expect(isOpencodeEndpoint("https://opencode.ai/zen/go/v1/")).toBe(true);
		expect(isOpencodeEndpoint("https://opencode.ai/zen/v1")).toBe(true);
		expect(isOpencodeEndpoint("https://api.opencode.ai/v1")).toBe(true);
	});

	test("does not match a relay in front of OpenCode, or a lookalike host", () => {
		// A gateway on another host receives a request addressed to itself; it is
		// that gateway's job to carry the session identity the rest of the way, and
		// stamping our header on traffic bound elsewhere would be noise.
		expect(isOpencodeEndpoint("https://gateway.invalid/v1")).toBe(false);
		// Suffix matching must not accept a domain that merely ends in the same
		// letters.
		expect(isOpencodeEndpoint("https://notopencode.ai/v1")).toBe(false);
		expect(isOpencodeEndpoint("https://api.anthropic.com")).toBe(false);
		expect(isOpencodeEndpoint(undefined)).toBe(false);
		expect(isOpencodeEndpoint("not a url")).toBe(false);
	});
});

describe("buildOpencodeSessionHeader", () => {
	test("is stable across turns of one conversation", () => {
		// The whole point of the header. Provider instances are rebuilt every turn,
		// so an instance-scoped id would change mid-conversation and scatter the
		// turns across upstreams — silently, since each request still succeeds.
		const first = buildOpencodeSessionHeader({
			baseUrl: "https://opencode.ai/zen/go/v1",
			conversationId: CONVERSATION,
		});
		const second = buildOpencodeSessionHeader({
			baseUrl: "https://opencode.ai/zen/go/v1",
			conversationId: CONVERSATION,
		});
		expect(first[OPENCODE_SESSION_HEADER]).toBe(second[OPENCODE_SESSION_HEADER]);
		expect(first[OPENCODE_SESSION_HEADER]).toMatch(UUID_SHAPE);
	});

	test("differs between conversations", () => {
		expect(deriveOpencodeSessionId("a")).not.toBe(deriveOpencodeSessionId("b"));
	});

	test("falls back to a process-stable id when there is no conversation", () => {
		// Title generation, compaction and model probes have no conversation, but
		// still need a session; a fresh id per request would be worse than one.
		const first = buildOpencodeSessionHeader({ baseUrl: "https://opencode.ai/zen/go/v1" });
		const second = buildOpencodeSessionHeader({ baseUrl: "https://opencode.ai/zen/go/v1" });
		expect(first[OPENCODE_SESSION_HEADER]).toMatch(UUID_SHAPE);
		expect(first[OPENCODE_SESSION_HEADER]).toBe(second[OPENCODE_SESSION_HEADER]);
	});

	test("yields to an operator-configured header regardless of casing", () => {
		// Emitting ours anyway would leave two differently-cased keys in the map,
		// which fetch comma-joins into a single malformed value.
		expect(
			buildOpencodeSessionHeader({
				baseUrl: "https://opencode.ai/zen/go/v1",
				conversationId: CONVERSATION,
				extraHeaders: { "X-OpenCode-Session": "ses_operator" },
			}),
		).toEqual({});
	});
});

describe("outgoing requests", () => {
	test("the Anthropic-compatible path sends the session header", async () => {
		const headers = await chatHeaders(
			new AnthropicProvider(anthropicConfig()),
			"og:minimax-m3",
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		);
		expect(headers.get(OPENCODE_SESSION_HEADER)).toBe(deriveOpencodeSessionId(CONVERSATION));
	});

	test("the OpenAI-compatible path sends the session header", async () => {
		const headers = await chatHeaders(
			new OpenAIProvider(openaiConfig()),
			"og:glm-5.3",
			"data: [DONE]\n\n",
		);
		expect(headers.get(OPENCODE_SESSION_HEADER)).toBe(deriveOpencodeSessionId(CONVERSATION));
	});

	test("a non-OpenCode endpoint is left untouched", async () => {
		const headers = await chatHeaders(
			new OpenAIProvider(openaiConfig({ baseUrl: "https://api.deepseek.com/v1" })),
			"og:glm-5.3",
			"data: [DONE]\n\n",
		);
		expect(headers.get(OPENCODE_SESSION_HEADER)).toBeNull();
	});

	test("an operator override reaches the wire instead of the derived id", async () => {
		const headers = await chatHeaders(
			new OpenAIProvider(openaiConfig({ extraHeaders: { "x-opencode-session": "ses_operator" } })),
			"og:glm-5.3",
			"data: [DONE]\n\n",
		);
		expect(headers.get(OPENCODE_SESSION_HEADER)).toBe("ses_operator");
	});
});
