import { describe, expect, test } from "bun:test";
import { extractAnthropicUsage } from "../../usage-tracking";
import { parseAnthropicEvent } from "../anthropic-provider";

function freshUsage() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheCreation5mTokens: 0,
		cacheCreation1hTokens: 0,
		cacheReported: false,
	};
}

function streamUsage(events: Record<string, unknown>[]) {
	const usage = freshUsage();
	let last: unknown;
	for (const event of events) {
		const parsed = parseAnthropicEvent(
			// biome-ignore lint/suspicious/noExplicitAny: minimal SSE frames
			event as any,
			new Map(),
			new Map(),
			new Map(),
			new Map(),
			usage,
		);
		for (const item of parsed) if (item.usage) last = item.usage;
	}
	return last as { cacheReported?: boolean } | undefined;
}

describe("Anthropic cache counter reporting", () => {
	test("explicit zero cache counters are a reported miss", () => {
		const usage = streamUsage([
			{
				type: "message_start",
				message: {
					id: "m",
					usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				},
			},
		]);
		expect(usage?.cacheReported).toBe(true);
	});

	test("a later counter-less message_delta does not retract earlier cache fields", () => {
		const usage = streamUsage([
			{
				type: "message_start",
				message: { id: "m", usage: { input_tokens: 50, cache_read_input_tokens: 10 } },
			},
			{ type: "message_delta", delta: {}, usage: { output_tokens: 4 } },
		]);
		expect(usage?.cacheReported).toBe(true);
	});

	test("relays that omit cache fields are not reported", () => {
		const usage = streamUsage([
			{ type: "message_start", message: { id: "m", usage: { input_tokens: 50 } } },
			{ type: "message_delta", delta: {}, usage: { output_tokens: 4 } },
		]);
		expect(usage?.cacheReported).toBe(false);
	});

	test("non-streaming extraction follows field presence", () => {
		expect(
			extractAnthropicUsage({ input_tokens: 1, cache_read_input_tokens: 0 }).cacheReported,
		).toBe(true);
		expect(extractAnthropicUsage({ input_tokens: 1 }).cacheReported).toBe(false);
	});
});
