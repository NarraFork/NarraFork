/**
 * Upstream error payloads must keep their message no matter which envelope shape
 * they arrive in.
 *
 * The bug this guards: every stream parser gated on a `type === "error"`
 * discriminator (or on `error.message` specifically), but gateways relay several
 * other shapes — a bare `{"error":{...}}` frame with no `type`, a string-valued
 * `error`, or the text under `detail`. Those produced NO event at all, so the
 * upstream explanation was discarded and the turn was later reported by the
 * empty-response guard as "the provider returned no content" — pointing the user
 * at their own base URL/credentials for what was an upstream failure.
 *
 * It was diagnosable only because the provider model-test dialog showed the same
 * error correctly: that path surfaces a thrown error's `message` instead of
 * parsing a stream, so it never depended on the discriminator.
 */
import { describe, expect, test } from "bun:test";
import { parseUpstreamErrorEnvelope } from "@shared/agent-protocol/error-diagnostics";
import { parseCodexWrappedError } from "../codex-websocket";
import { OpenAIProvider, parseResponsesAPIEvent } from "../openai-provider";

function parseResponses(chunk: unknown) {
	return parseResponsesAPIEvent(chunk as never, new Map(), new Map());
}

/** Shapes observed from gateways and relays, none of which carry `type: "error"`. */
const UNDISCRIMINATED_SHAPES: Array<[string, unknown, string]> = [
	[
		"bare nested error with no type field",
		{ error: { message: "upstream pool exhausted", code: "server_error" } },
		"upstream pool exhausted",
	],
	[
		"flat message plus code",
		{ message: "rate limited by upstream", code: "rate_limit_exceeded" },
		"rate limited by upstream",
	],
	["string-valued error", { error: "backend refused the request" }, "backend refused the request"],
	[
		"message under detail",
		{ error: { detail: "model is not enabled for this key" } },
		"model is not enabled for this key",
	],
];

describe("parseUpstreamErrorEnvelope", () => {
	for (const [name, shape, expected] of UNDISCRIMINATED_SHAPES) {
		test(`recovers the message from ${name}`, () => {
			expect(parseUpstreamErrorEnvelope(shape)?.message).toBe(expected);
		});
	}

	test("keeps the machine-readable code when one is supplied", () => {
		const envelope = parseUpstreamErrorEnvelope({
			error: { message: "quota gone", code: "insufficient_quota" },
			status: 429,
		});
		expect(envelope?.code).toBe("insufficient_quota");
		expect(envelope?.statusCode).toBe(429);
	});

	test("does not report a generic `error` discriminator as the code", () => {
		// `type: "error"` says only "this is an error"; treating it as the code would
		// display "error" where a real reason belongs.
		expect(parseUpstreamErrorEnvelope({ type: "error", message: "boom" })?.code).toBeUndefined();
	});

	// The counterpart risk of matching on content instead of a discriminator: a
	// content frame misread as a failure would kill a healthy turn. That is strictly
	// worse than the bug being fixed, so these cases are pinned explicitly.
	const CONTENT_FRAMES: Array<[string, unknown]> = [
		["a text delta", { type: "response.output_text.delta", delta: "hi" }],
		["a completed response", { type: "response.completed", response: { id: "resp-1" } }],
		["a usage-only frame", { usage: { input_tokens: 5 } }],
		["an output item", { type: "response.output_item.done", item: { type: "message" } }],
		// Several providers stamp `code: 200` on success frames.
		["a success status code", { code: 200 }],
		// A bare `message` is also how some providers label ordinary content, so it
		// needs a corroborating error signal before counting as a failure.
		["a bare message with no error signal", { message: "hello from the model" }],
		["null", null],
		["an array", []],
	];
	for (const [name, frame] of CONTENT_FRAMES) {
		test(`does not treat ${name} as an error`, () => {
			expect(parseUpstreamErrorEnvelope(frame)).toBeNull();
		});
	}
});

describe("Responses stream parser (SSE and WebSocket share this)", () => {
	for (const [name, shape, expected] of UNDISCRIMINATED_SHAPES) {
		test(`surfaces an invalidState for ${name}`, () => {
			const events = parseResponses(shape);
			expect(events).toHaveLength(1);
			expect(events[0]?.invalidState?.message).toBe(expected);
			// The message must also reach diagnostics: that is what the persisted record
			// and the error card read from.
			expect(events[0]?.invalidState?.diagnostics?.message).toBe(expected);
		});
	}

	test("prefers the upstream text over the generic placeholder", () => {
		// A typed error whose text sits under `detail` used to fall through to
		// "Unknown API error", discarding the one useful sentence upstream sent.
		const events = parseResponses({ type: "error", error: { detail: "region not available" } });
		expect(events[0]?.invalidState?.message).toBe("region not available");
	});

	test("still parses the canonical typed error event", () => {
		const events = parseResponses({
			type: "error",
			error: { message: "canonical", code: "server_error" },
		});
		expect(events[0]?.invalidState?.message).toBe("canonical");
		expect(events[0]?.invalidState?.reason).toBe("server_error");
	});

	test("leaves content frames untouched", () => {
		// Guards the same false-positive risk at the parser level, where a misread
		// would surface as a failed turn rather than a dropped message.
		expect(parseResponses({ type: "response.completed", response: { id: "r" } })).toEqual([]);
	});
});

describe("end to end through a real SSE stream", () => {
	/** Run one SSE body through the provider and return the surfaced failure text. */
	async function failureTextFor(sseBody: string): Promise<string> {
		const provider = new OpenAIProvider({
			id: "test-openai",
			name: "Test OpenAI",
			prefix: "openai",
			apiKey: "test-key",
			baseUrl: "https://example.com/v1",
			defaultModel: "gpt-5",
			apiMode: "responses",
		});
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(sseBody, {
				headers: { "content-type": "text/event-stream" },
			})) as unknown as typeof fetch;
		try {
			await provider.generateWithMeta("prompt", "openai:gpt-5");
			return "";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		} finally {
			globalThis.fetch = originalFetch;
		}
	}

	test("a bare error frame reaches the user with the upstream text", async () => {
		const message = await failureTextFor(
			'data: {"error":{"message":"upstream pool exhausted","code":"server_error"}}\n\n',
		);

		expect(message).toContain("upstream pool exhausted");
		// The regression symptom: the frame parsed to nothing, the stream looked like it
		// simply ended, and this generic reason replaced the real explanation.
		expect(message).not.toContain("stream_closed_before_response_completed");
		expect(message).not.toContain("No Responses API events were parsed");
	});

	test("a typed error frame still reaches the user unchanged", async () => {
		const message = await failureTextFor(
			'data: {"type":"error","error":{"message":"canonical failure","code":"server_error"}}\n\n',
		);

		expect(message).toContain("canonical failure");
	});
});

describe("Codex WebSocket wrapped-error parser", () => {
	for (const [name, shape, expected] of UNDISCRIMINATED_SHAPES) {
		test(`recognizes ${name}`, () => {
			const wrapped = parseCodexWrappedError(JSON.stringify(shape));
			expect(wrapped?.error?.message).toBe(expected);
		});
	}

	test("returns null for a frame that is not an error", () => {
		expect(parseCodexWrappedError(JSON.stringify({ type: "response.created" }))).toBeNull();
	});
});
