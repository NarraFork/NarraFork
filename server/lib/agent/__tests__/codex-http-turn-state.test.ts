/**
 * HTTP codex transport turn-state parity: codex-rs replays the
 * `x-codex-turn-state` token (handed back on a turn's first response) as a
 * request header on every later request of that same turn — here the
 * strip-and-retry attempts inside one chat call. The token is per-turn, so
 * it must never leak into the next independent request.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { OpenAIProvider } from "../openai-provider";
import { resetUnsupportedParameterMemory } from "../unsupported-parameter-fallback";

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function makeProvider(): OpenAIProvider {
	return new OpenAIProvider({
		id: "codex",
		name: "Codex",
		prefix: "codex",
		apiKey: "sk-test-key",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		defaultModel: "gpt-6.1-sol",
		apiMode: "codex",
		userAgentMode: "codex",
		// biome-ignore lint/suspicious/noExplicitAny: test config subset
	} as any);
}

function headersOf(init?: RequestInit): Record<string, string> {
	const headers: Record<string, string> = {};
	const raw = init?.headers;
	if (raw instanceof Headers) {
		raw.forEach((v, k) => {
			headers[k.toLowerCase()] = v;
		});
	} else if (Array.isArray(raw)) {
		for (const [k, v] of raw) headers[String(k).toLowerCase()] = String(v);
	} else {
		for (const [k, v] of Object.entries((raw ?? {}) as Record<string, string>)) {
			headers[k.toLowerCase()] = v;
		}
	}
	return headers;
}

function sseResponse(extraHeaders: Record<string, string> = {}): Response {
	const sse = 'data: {"type":"response.completed","response":{"output":[]}}\n\n';
	return new Response(sse, {
		status: 200,
		headers: { "content-type": "text/event-stream", ...extraHeaders },
	});
}

const genMeta = (p: OpenAIProvider) =>
	p.generateWithMeta("hello", "codex:gpt-6.1-sol", "You are a title generator.", {
		reasoningEffort: "high",
	});

afterEach(() => {
	resetUnsupportedParameterMemory();
});

describe("codex HTTP turn-state", () => {
	test("replays a captured x-codex-turn-state on the same-turn retry", async () => {
		const provider = makeProvider();
		const requests: Captured[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			requests.push({
				url: String(input),
				headers: headersOf(init),
				body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
			});
			if (requests.length === 1) {
				// Reject an optional field so the transport strips it and retries —
				// the retry is a later request of the SAME turn and must carry the
				// token this response hands back.
				return new Response(
					JSON.stringify({
						error: {
							message: "Unsupported parameter: prompt_cache_key",
							type: "invalid_request_error",
						},
					}),
					{
						status: 400,
						headers: { "content-type": "application/json", "x-codex-turn-state": "ts-123" },
					},
				);
			}
			return sseResponse();
			// biome-ignore lint/suspicious/noExplicitAny: fetch stub
		}) as any;

		try {
			await genMeta(provider);
		} finally {
			globalThis.fetch = realFetch;
		}

		expect(requests.length).toBe(2);
		// The turn's first request cannot carry a token it does not have yet.
		expect(requests[0].headers["x-codex-turn-state"]).toBeUndefined();
		// The retry came from the unsupported-parameter fallback (the rejected
		// field is stripped before re-sending).
		expect(requests[1].body.prompt_cache_key).toBeUndefined();
		expect(requests[1].headers["x-codex-turn-state"]).toBe("ts-123");
	});

	test("never leaks the token into the next turn", async () => {
		const provider = makeProvider();
		const requests: Captured[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			requests.push({
				url: String(input),
				headers: headersOf(init),
				body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
			});
			return sseResponse({ "x-codex-turn-state": "ts-per-turn" });
			// biome-ignore lint/suspicious/noExplicitAny: fetch stub
		}) as any;

		try {
			await genMeta(provider);
			await genMeta(provider);
		} finally {
			globalThis.fetch = realFetch;
		}

		expect(requests.length).toBe(2);
		// Each chat call is its own turn: the second call's first request starts
		// clean even though the previous turn's response carried a token.
		expect(requests[1].headers["x-codex-turn-state"]).toBeUndefined();
	});
});
