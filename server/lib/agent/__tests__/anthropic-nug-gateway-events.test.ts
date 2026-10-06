import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AnthropicProvider } from "../anthropic-provider";
import type { ChatParams, ParsedStreamEvent } from "../provider";

/**
 * NUG injects its own gateway events (credit consumption, context-window
 * occupancy) into an Anthropic Messages SSE stream — the Anthropic protocol has
 * no field for either.
 *
 * These assert that `AnthropicProvider` consumes such a mixed stream: the gateway
 * events must be surfaced as `metering` / `contextUsagePercentage`, and the
 * surrounding protocol events must be parsed normally rather than being disturbed
 * by the interleaved non-standard names.
 *
 * Without this coverage the two halves are only connected by a name string:
 * `gateway-events.ts` has unit tests for the parsing and NUG has tests for the
 * emitting, but nothing proves the provider's SSE loop routes these names to the
 * gateway parser instead of dropping them as unknown Anthropic events.
 */

const MODEL = "nugtest:claude-sonnet-4.5";

let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
	savedFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = savedFetch;
});

function installStream(sse: string): void {
	globalThis.fetch = (async () =>
		new Response(sse, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		})) as unknown as typeof fetch;
}

function chatParams(): ChatParams {
	return {
		conversationId: "nug-gateway-events",
		content: "hello",
		model: MODEL,
		cwd: process.cwd(),
		history: [],
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
	};
}

async function collect(sse: string): Promise<ParsedStreamEvent[]> {
	installStream(sse);
	const provider = new AnthropicProvider({
		id: "nugtest",
		prefix: "nugtest",
		baseUrl: "https://gateway.invalid/v1",
		apiKey: "test-key",
		officialApi: false,
		models: [{ id: "claude-sonnet-4.5", name: "Sonnet" }],
	} as never);

	const events: ParsedStreamEvent[] = [];
	for await (const event of provider.chat(chatParams())) {
		events.push(event);
	}
	return events;
}

/** A stream shaped like what NUG's Anthropic-compatible endpoint actually emits. */
const MIXED_SSE =
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_nug_req1","role":"assistant","model":"claude-sonnet-4.5","content":[],"usage":{"input_tokens":0,"output_tokens":0}}}\n\n' +
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n' +
	'event: meteringEvent\ndata: {"type":"meteringEvent","usage":12.5,"unit":"credit","unitPlural":"credits"}\n\n' +
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world."}}\n\n' +
	'event: contextUsageEvent\ndata: {"type":"contextUsageEvent","contextUsagePercentage":34.5}\n\n' +
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}\n\n' +
	'event: message_stop\ndata: {"type":"message_stop"}\n\n';

describe("anthropic provider consuming NUG gateway streams", () => {
	test("surfaces metering and context usage from interleaved gateway events", async () => {
		const events = await collect(MIXED_SSE);

		const metering = events.find((event) => event.metering != null)?.metering;
		expect(metering).toEqual({ unit: "credit", unitPlural: "credits", usage: 12.5 });

		const contextPercent = events.find(
			(event) => event.contextUsagePercentage != null,
		)?.contextUsagePercentage;
		expect(contextPercent).toBe(34.5);
	});

	test("drains gateway measurements after message_stop", async () => {
		const events = await collect(
			`${MIXED_SSE}event: contextUsageEvent\ndata: {"contextUsagePercentage":42}\n\n` +
				'event: meteringEvent\ndata: {"usage":15}\n\n',
		);
		expect(events.filter((event) => event.contextUsagePercentage != null).at(-1)).toEqual({
			contextUsagePercentage: 42,
		});
		expect(events.filter((event) => event.metering != null).at(-1)?.metering?.usage).toBe(15);
	});

	test.each([
		34.5, 0, 125, -5,
	])("helper preserves gateway occupancy %s across trailing token usage", async (percentage) => {
		installStream(
			MIXED_SSE.replace('"contextUsagePercentage":34.5', `"contextUsagePercentage":${percentage}`),
		);
		const provider = new AnthropicProvider({
			id: "nugtest",
			prefix: "nugtest",
			baseUrl: "https://gateway.invalid/v1",
			apiKey: "test-key",
			officialApi: false,
			models: [{ id: "claude-sonnet-4.5", name: "Sonnet" }],
		} as never);
		const result = await provider.generateWithMeta("hello", MODEL);
		expect(result.text).toBe("Hello world.");
		expect(result.contextPercent).toBe(Math.min(Math.max(percentage, 0), 100));
		// Occupancy must not be presented as measured token consumption.
		expect(result.usage?.inputTokens ?? 0).toBe(0);
	});

	test("helper keeps actual tokens independent of gateway occupancy", async () => {
		installStream(
			`${MIXED_SSE.replace(
				'"output_tokens":0}}\n\nevent: message_stop',
				'"input_tokens":2000,"output_tokens":20}}\n\nevent: message_stop',
			)}event: contextUsageEvent\ndata: {"contextUsagePercentage":42}\n\n`,
		);
		const provider = new AnthropicProvider({
			id: "nugtest",
			prefix: "nugtest",
			baseUrl: "https://gateway.invalid/v1",
			apiKey: "test-key",
			officialApi: false,
			models: [{ id: "claude-sonnet-4.5", name: "Sonnet" }],
		} as never);
		const result = await provider.generateWithMeta("hello", MODEL);
		expect(result.contextPercent).toBe(42);
		expect(result.usage?.inputTokens).toBe(2000);
		expect(result.usage?.outputTokens).toBe(20);
	});

	test("still parses the surrounding protocol events", async () => {
		const events = await collect(MIXED_SSE);

		// The gateway events sit between two text deltas, so text reassembly proves
		// they did not disturb the block state.
		const text = events
			.map((event) => event.text ?? "")
			.join("")
			.trim();
		expect(text).toBe("Hello world.");

		expect(events.some((event) => event.messageId === "msg_nug_req1")).toBe(true);
		expect(events.some((event) => event.stopReason === "end_turn")).toBe(true);
	});

	test("gateway events do not become assistant text", async () => {
		const events = await collect(MIXED_SSE);

		const text = events.map((event) => event.text ?? "").join("");
		for (const leaked of ["meteringEvent", "contextUsageEvent", "12.5", "34.5"]) {
			expect(text).not.toContain(leaked);
		}
	});

	test("does not report token usage from a credit-metered stream", async () => {
		// NUG sends zeroed token counts when reporting credits instead of tokens.
		// The loop treats a token count as a real measurement, so a zero must not be
		// promoted into a usage event that would render as a free request with an
		// empty prompt.
		const events = await collect(MIXED_SSE);

		for (const event of events) {
			if (!event.usage) continue;
			expect(event.usage.completionTokens ?? 0).toBe(0);
			expect(event.usage.inputTokens ?? 0).toBe(0);
		}
	});

	test("a metering event with no usable usage is ignored rather than reported as free", async () => {
		const sse =
			'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":0}}}\n\n' +
			'event: meteringEvent\ndata: {"type":"meteringEvent"}\n\n' +
			'event: message_stop\ndata: {"type":"message_stop"}\n\n';

		const events = await collect(sse);

		expect(events.some((event) => event.metering != null)).toBe(false);
	});

	test("data-embedded gateway events are recognised without an SSE event line", async () => {
		// The non-streaming and WebSocket paths carry the name in the payload's
		// `type` field instead of an `event:` line, so both routes must work.
		const sse =
			'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":0}}}\n\n' +
			'data: {"type":"meteringEvent","usage":3}\n\n' +
			'event: message_stop\ndata: {"type":"message_stop"}\n\n';

		const events = await collect(sse);

		expect(events.find((event) => event.metering != null)?.metering?.usage).toBe(3);
	});
});
