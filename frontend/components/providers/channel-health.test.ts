import { describe, expect, test } from "bun:test";
import { type ChannelHealth, channelHealthKey, normalizeChannelHealth } from "./channel-health";

const sample: ChannelHealth[] = [
	{ channel: "xs", channelType: "openai", availabilityRate: 0 },
	{ channel: "dongplus", channelType: "openai", availabilityRate: 1 },
	{ channel: "tjcn", channelType: "anthropic", availabilityRate: 1 },
];

describe("channelHealthKey", () => {
	test("distinguishes instances sharing a channelType", () => {
		expect(channelHealthKey(sample[0])).not.toBe(channelHealthKey(sample[1]));
	});

	test("falls back to channelType when instance name is absent", () => {
		expect(channelHealthKey({ channelType: "grok", availabilityRate: 1 })).toBe("::grok");
	});
});

describe("normalizeChannelHealth", () => {
	test("keeps every distinct instance of the same channelType", () => {
		expect(normalizeChannelHealth(sample)).toHaveLength(3);
	});

	test("produces a stable order regardless of upstream ordering", () => {
		const shuffled = [sample[1], sample[2], sample[0]];
		expect(normalizeChannelHealth(shuffled)).toEqual(normalizeChannelHealth(sample));
	});

	/**
	 * The order must come from the CODE POINTS, not from the runtime's collation.
	 *
	 * `localeCompare` was the original comparator, and it reorders exactly the
	 * characters these identifiers are made of: under `tr` a dotless `ı` sorts away
	 * from `i`, under `sv` `w` sorts with `v`. Two users hitting the same endpoint
	 * would then see different row orders — which is the very thing this function is
	 * here to prevent, since upstream order is non-deterministic.
	 *
	 * Asserted against a literal expectation rather than "equals localeCompare's
	 * answer": the point is that ONE fixed order is produced, whatever locale the
	 * browser was started in.
	 */
	test("orders by code point, not by the runtime locale's collation", () => {
		const locale: ChannelHealth[] = [
			{ channel: "w", channelType: "vendor", availabilityRate: 1 },
			{ channel: "v", channelType: "vendor", availabilityRate: 1 },
			{ channel: "ı", channelType: "vendor", availabilityRate: 1 },
			{ channel: "i", channelType: "vendor", availabilityRate: 1 },
			{ channel: "Z", channelType: "vendor", availabilityRate: 1 },
			{ channel: "a", channelType: "vendor", availabilityRate: 1 },
		];
		// Pure code-point order: uppercase before lowercase (`Z` = U+005A < `a` =
		// U+0061), and `ı` (U+0131) last. Every locale-aware collation disagrees with
		// at least one of those.
		expect(normalizeChannelHealth(locale).map((c) => c.channel)).toEqual([
			"Z",
			"a",
			"i",
			"v",
			"w",
			"ı",
		]);
	});

	test("channelType is the primary key and is also compared by code point", () => {
		const mixed: ChannelHealth[] = [
			{ channel: "a", channelType: "openai", availabilityRate: 1 },
			{ channel: "a", channelType: "Anthropic", availabilityRate: 1 },
			{ channel: "a", channelType: "anthropic", availabilityRate: 1 },
		];
		expect(normalizeChannelHealth(mixed).map((c) => c.channelType)).toEqual([
			"Anthropic",
			"anthropic",
			"openai",
		]);
	});

	test("dedupes repeated instances instead of stacking them", () => {
		const dup = [...sample, { channel: "xs", channelType: "openai", availabilityRate: 0.5 }];
		const result = normalizeChannelHealth(dup);
		expect(result).toHaveLength(3);
		expect(result.find((c) => c.channel === "xs")?.availabilityRate).toBe(0.5);
	});

	test("row keys are unique", () => {
		const keys = normalizeChannelHealth(sample).map(channelHealthKey);
		expect(new Set(keys).size).toBe(keys.length);
	});

	test("skips malformed entries and handles undefined input", () => {
		expect(normalizeChannelHealth(undefined)).toEqual([]);
		const dirty = [
			null as unknown as ChannelHealth,
			{ channelType: "", availabilityRate: 1 },
			sample[2],
		];
		expect(normalizeChannelHealth(dirty)).toEqual([sample[2]]);
	});
});
