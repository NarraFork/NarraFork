import { describe, expect, it } from "bun:test";
import {
	formatMeterUsage,
	formatTurnUsageCost,
	formatTurnUsageParts,
	getPromptTokenFootprint,
	resolveTurnUsageLines,
} from "./turn-usage";

describe("getPromptTokenFootprint", () => {
	it("prefers a provider-reported prompt_tokens", () => {
		expect(getPromptTokenFootprint({ prompt_tokens: 1234, input_tokens: 10 })).toBe(1234);
	});

	it("reconstructs the footprint from the parts when prompt_tokens is absent", () => {
		expect(
			getPromptTokenFootprint({
				input_tokens: 100,
				cached_input_tokens: 20,
				cache_creation_input_tokens: 5,
			}),
		).toBe(125);
	});

	it("returns null without any input accounting", () => {
		expect(getPromptTokenFootprint({ output_tokens: 42 })).toBeNull();
		expect(getPromptTokenFootprint(null)).toBeNull();
		expect(getPromptTokenFootprint(undefined)).toBeNull();
	});

	it("ignores non-finite values", () => {
		expect(getPromptTokenFootprint({ prompt_tokens: Number.NaN, input_tokens: 7 })).toBe(7);
	});
});

describe("formatTurnUsageParts", () => {
	it("always emits ctx / in / out", () => {
		expect(formatTurnUsageParts({ input_tokens: 10, output_tokens: 3 })).toEqual([
			"Σ 10 ctx",
			"10 in",
			"3 out",
		]);
	});

	it("omits zero-valued optional parts", () => {
		const parts = formatTurnUsageParts({
			input_tokens: 10,
			output_tokens: 3,
			cached_input_tokens: 0,
			cache_creation_input_tokens: 0,
			reasoning_tokens: 0,
		});
		expect(parts).toHaveLength(3);
	});

	it("appends cache hit / write / reasoning when non-zero", () => {
		const parts = formatTurnUsageParts({
			input_tokens: 10,
			output_tokens: 3,
			cached_input_tokens: 8,
			cache_creation_input_tokens: 4,
			reasoning_tokens: 9,
		});
		expect(parts).toEqual([
			"Σ 22 ctx",
			"10 in",
			"3 out",
			"8 cache hit",
			"4 cache write",
			"9 reasoning",
		]);
	});

	it("details the cache-write TTL split when present", () => {
		const parts = formatTurnUsageParts({
			input_tokens: 10,
			output_tokens: 3,
			cache_creation_input_tokens: 4,
			cache_creation_5m_tokens: 3,
			cache_creation_1h_tokens: 1,
		});
		expect(parts?.at(-1)).toBe("4 cache write (3 5m / 1 1h)");
	});

	it("uses the injected number formatter", () => {
		const parts = formatTurnUsageParts({ input_tokens: 1000, output_tokens: 2000 }, (n) =>
			n.toLocaleString("en-US"),
		);
		expect(parts).toEqual(["Σ 1,000 ctx", "1,000 in", "2,000 out"]);
	});

	it("returns null without a payload", () => {
		expect(formatTurnUsageParts(null)).toBeNull();
	});
});

describe("formatTurnUsageCost / formatMeterUsage", () => {
	it("formats a positive cost to four decimals", () => {
		expect(formatTurnUsageCost(0.12345)).toBe("$0.1235");
	});

	it("drops a zero / missing / non-finite cost", () => {
		expect(formatTurnUsageCost(0)).toBeNull();
		expect(formatTurnUsageCost(null)).toBeNull();
		expect(formatTurnUsageCost(Number.POSITIVE_INFINITY)).toBeNull();
	});

	it("formats credits to two decimals", () => {
		expect(formatMeterUsage(1.5)).toBe("1.50 credits");
		expect(formatMeterUsage(null)).toBeNull();
	});
});

describe("resolveTurnUsageLines", () => {
	const usage = { input_tokens: 100, output_tokens: 20 };

	it("returns null when a message carries no usage at all", () => {
		expect(resolveTurnUsageLines({ role: "assistant" })).toBeNull();
	});

	it("draws the leading footprint line only for assistant messages", () => {
		expect(resolveTurnUsageLines({ role: "assistant", turnUsageJson: usage })?.leading).toBe(
			"↑ 100",
		);
		expect(resolveTurnUsageLines({ role: "user", turnUsageJson: usage })?.leading).toBeNull();
	});

	it("falls back to tokensIn when the payload has no accounting", () => {
		expect(resolveTurnUsageLines({ role: "assistant", tokensIn: 77 })?.leading).toBe("↑ 77");
	});

	it("joins the summary with the cost on desktop", () => {
		const lines = resolveTurnUsageLines({ role: "assistant", turnUsageJson: usage, costUsd: 0.5 });
		expect(lines?.trailing).toBe("Σ 100 ctx · 100 in · 20 out · $0.5000");
		expect(lines?.trailingSecondary).toBeNull();
	});

	it("splits the summary across two lines on mobile", () => {
		const lines = resolveTurnUsageLines(
			{
				role: "assistant",
				turnUsageJson: { ...usage, cached_input_tokens: 8 },
				costUsd: 0.5,
			},
			{ mobile: true },
		);
		expect(lines?.trailing).toBe("Σ 108 ctx · 100 in · 20 out");
		expect(lines?.trailingSecondary).toBe("8 cache hit · $0.5000");
	});

	it("omits the mobile second line when only three parts and no cost exist", () => {
		const lines = resolveTurnUsageLines(
			{ role: "assistant", turnUsageJson: usage },
			{ mobile: true },
		);
		expect(lines?.trailing).toBe("Σ 100 ctx · 100 in · 20 out");
		expect(lines?.trailingSecondary).toBeNull();
	});

	it("uses credits when a metered provider reports no tokens", () => {
		const lines = resolveTurnUsageLines({ role: "assistant", meterUsage: 2 });
		expect(lines?.leading).toBe("2.00 credits");
		expect(lines?.trailing).toBe("2.00 credits");
	});

	it("prefers the token summary over credits when both exist", () => {
		const lines = resolveTurnUsageLines({
			role: "assistant",
			turnUsageJson: usage,
			meterUsage: 2,
		});
		expect(lines?.leading).toBe("↑ 100");
		expect(lines?.trailing).toBe("Σ 100 ctx · 100 in · 20 out");
	});
});
