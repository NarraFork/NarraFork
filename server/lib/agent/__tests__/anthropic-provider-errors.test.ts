import { beforeAll, describe, expect, test } from "bun:test";

type ParsedEvent = {
	invalidState?: { reason: string; message: string };
	text?: string;
	messageId?: string;
	usage?: unknown;
};

type ParseAnthropicEventFn = (
	event: unknown,
	toolAccum: Map<unknown, unknown>,
	thinkingAccum: Map<unknown, unknown>,
	redactedThinkingAccum: Map<unknown, unknown>,
	serverToolAccum: Map<unknown, unknown>,
	usageAccum: ReturnType<typeof makeUsageAccum>,
) => ParsedEvent[];

type ParseAnthropicSSEStreamFn = (
	body: ReadableStream<Uint8Array>,
	contextWindow?: number | null,
) => AsyncGenerator<ParsedEvent>;

type ExtractAnthropicStreamErrorFn = (event: unknown) => { reason: string; message: string } | null;
type AnthropicProviderLike = {
	generateWithMeta(
		text: string,
		model: string,
		systemInstruction?: string,
		options?: { onTextDelta?: (delta: string) => void | Promise<void> },
	): Promise<{ text: string; usage?: unknown }>;
};

let AnthropicProvider: new (config: Record<string, unknown>) => AnthropicProviderLike;
let parseAnthropicEvent: ParseAnthropicEventFn;
let parseAnthropicSSEStream: ParseAnthropicSSEStreamFn;
let extractAnthropicStreamError: ExtractAnthropicStreamErrorFn;

beforeAll(async () => {
	const mod = await import("../anthropic-provider");
	AnthropicProvider = mod.AnthropicProvider as unknown as new (
		config: Record<string, unknown>,
	) => AnthropicProviderLike;
	parseAnthropicEvent = mod.parseAnthropicEvent as unknown as ParseAnthropicEventFn;
	parseAnthropicSSEStream = mod.parseAnthropicSSEStream as unknown as ParseAnthropicSSEStreamFn;
	extractAnthropicStreamError =
		mod.extractAnthropicStreamError as unknown as ExtractAnthropicStreamErrorFn;
});

function makeUsageAccum() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheCreation5mTokens: 0,
		cacheCreation1hTokens: 0,
	};
}

function parseWithFreshState(event: Record<string, unknown>): ParsedEvent[] {
	return parseAnthropicEvent(event, new Map(), new Map(), new Map(), new Map(), makeUsageAccum());
}

/** Build a ReadableStream of UTF-8 bytes from an SSE text body. */
function sseStream(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

async function collect(gen: AsyncGenerator<ParsedEvent>): Promise<ParsedEvent[]> {
	const out: ParsedEvent[] = [];
	for await (const evt of gen) out.push(evt);
	return out;
}

describe("extractAnthropicStreamError", () => {
	test("native Anthropic error envelope", () => {
		const err = extractAnthropicStreamError({
			type: "error",
			error: { type: "overloaded_error", message: "Overloaded" },
		});
		expect(err).toMatchObject({
			reason: "overloaded_error",
			message: "Overloaded",
			diagnostics: {
				schema: "narrafork.error-diagnostics.v1",
				source: "provider",
				reason: "overloaded_error",
			},
		});
	});

	test("gateway error WITH top-level type and numeric codes", () => {
		const err = extractAnthropicStreamError({
			type: "error",
			code: 429,
			message: "rate limited",
			error: { type: "error", code: 429, message: "rate limited" },
		});
		// nested.type wins for reason; message preserved.
		expect(err?.reason).toBe("error");
		expect(err?.message).toBe("rate limited");
	});

	test("gateway error WITHOUT top-level type (the shape that was silently dropped)", () => {
		const err = extractAnthropicStreamError({
			code: 429,
			message: "model quota exhausted on all credentials; resets in 42s",
			error: { code: 429, message: "model quota exhausted on all credentials; resets in 42s" },
		});
		expect(err).not.toBeNull();
		// No nested.type; falls back to nested.code.
		expect(err?.reason).toBe("429");
		expect(err?.message).toContain("quota exhausted");
	});

	test("error with only a top-level code + string message (no nested error)", () => {
		const err = extractAnthropicStreamError({ code: 500, message: "boom" });
		expect(err).toMatchObject({
			reason: "500",
			message: "boom",
			diagnostics: {
				schema: "narrafork.error-diagnostics.v1",
				statusCode: 500,
				code: 500,
			},
		});
	});

	test("does not misclassify normal message_start", () => {
		expect(
			extractAnthropicStreamError({
				type: "message_start",
				message: { id: "msg_1", usage: { input_tokens: 5 } },
			}),
		).toBeNull();
	});

	test("does not misclassify content_block_delta", () => {
		expect(
			extractAnthropicStreamError({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "hello" },
			}),
		).toBeNull();
	});

	test("does not misclassify ping / message_delta", () => {
		expect(extractAnthropicStreamError({ type: "ping" })).toBeNull();
		expect(
			extractAnthropicStreamError({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 3 },
			}),
		).toBeNull();
	});
});

describe("parseAnthropicEvent error handling", () => {
	test("native error yields invalidState", () => {
		const events = parseWithFreshState({
			type: "error",
			error: { type: "overloaded_error", message: "Overloaded" },
		});
		expect(events).toHaveLength(1);
		expect(events[0].invalidState).toMatchObject({
			reason: "overloaded_error",
			message: "Overloaded",
			diagnostics: {
				schema: "narrafork.error-diagnostics.v1",
				source: "provider",
			},
		});
	});

	test("gateway error without type yields invalidState (regression)", () => {
		const events = parseWithFreshState({
			code: 429,
			message: "quota exhausted",
			error: { code: 429, message: "quota exhausted" },
		});
		expect(events).toHaveLength(1);
		expect(events[0].invalidState?.message).toBe("quota exhausted");
		expect(events[0].invalidState?.reason).toBe("429");
	});

	test("normal text delta is unaffected", () => {
		const events = parseWithFreshState({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "hi" },
		});
		expect(events.some((e) => e.invalidState)).toBe(false);
		expect(events.some((e) => e.text === "hi")).toBe(true);
	});
});

describe("Anthropic lightweight generation invalidState handling", () => {
	test("does not map max_tokens to HTTP 502 and preserves its completion-limit classification", async () => {
		const provider = new AnthropicProvider({
			id: "test-anthropic",
			name: "Test Anthropic",
			prefix: "anthropic",
			apiKey: "test-key",
			baseUrl: "https://example.com/v1",
			defaultModel: "claude-test",
		});
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":2}}}\n\n' +
					'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":4}}\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			)) as unknown as typeof fetch;

		try {
			let thrown: unknown;
			try {
				await provider.generateWithMeta("prompt", "anthropic:claude-test");
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeDefined();
			expect(thrown).toMatchObject({
				reason: "max_tokens",
				classification: "completion_limit",
				retryable: false,
			});
			expect((thrown as { status?: number }).status).not.toBe(502);
			expect((thrown as { diagnostics?: { reason?: string } }).diagnostics?.reason).toBe(
				"max_tokens",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("parseAnthropicSSEStream end-to-end error surfacing", () => {
	test("event: error with type-less data still surfaces invalidState", async () => {
		// This is exactly the gateway's writeSSEError output shape before the fix:
		// an `event: error` line with a data payload that has no `type` field.
		const body = sseStream(
			'event: error\ndata: {"code":429,"message":"model quota exhausted on all credentials; resets in 42s","error":{"code":429,"message":"model quota exhausted on all credentials; resets in 42s"}}\n\n',
		);
		const events = await collect(parseAnthropicSSEStream(body));
		const errEvt = events.find((e) => e.invalidState);
		expect(errEvt).toBeDefined();
		expect(errEvt?.invalidState?.message).toContain("quota exhausted");
	});

	test("standard Anthropic error event surfaces invalidState", async () => {
		const body = sseStream(
			'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
		);
		const events = await collect(parseAnthropicSSEStream(body));
		const errEvt = events.find((e) => e.invalidState);
		expect(errEvt?.invalidState?.reason).toBe("overloaded_error");
	});

	test("normal streaming content is not treated as an error", async () => {
		const body = sseStream(
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10}}}\n\n' +
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
		);
		const events = await collect(parseAnthropicSSEStream(body));
		expect(events.some((e) => e.invalidState)).toBe(false);
		expect(events.some((e) => e.text === "hello")).toBe(true);
	});
});
