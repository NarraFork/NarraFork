import { describe, expect, test } from "bun:test";
import { compactProgressLabel } from "./progress-label";

/**
 * Identity translate: returns the key with its interpolation values appended,
 * so assertions read as "which key + which count" without a locale fixture.
 */
const t = (key: string, options?: Record<string, unknown>) =>
	options?.count !== undefined ? `${key}(${options.count})` : key;

describe("compactProgressLabel", () => {
	test("a retry in flight replaces the char counts", () => {
		// "0 chars" alone reads as a stall; the retry ordinal is the honest signal.
		expect(
			compactProgressLabel(t, { phase: "output", thinkingChars: 0, outputChars: 0, retryCount: 2 }),
		).toBe("compactRetrying(2)");
		// The retry label also beats the thinking phase.
		expect(
			compactProgressLabel(t, {
				phase: "thinking",
				thinkingChars: 240,
				outputChars: 0,
				retryCount: 1,
			}),
		).toBe("compactRetrying(1)");
	});

	test("retryCount 0 (or absent) keeps the previous count behaviour", () => {
		expect(
			compactProgressLabel(t, {
				phase: "output",
				thinkingChars: 0,
				outputChars: 42,
				retryCount: 0,
			}),
		).toBe("compactOutputChars(42)");
		expect(compactProgressLabel(t, { phase: "output", thinkingChars: 0, outputChars: 42 })).toBe(
			"compactOutputChars(42)",
		);
		expect(compactProgressLabel(t, null)).toBe("compactOutputChars(0)");
	});

	test("thinking phase shows the bare label below the display threshold", () => {
		expect(compactProgressLabel(t, { phase: "thinking", thinkingChars: 3, outputChars: 0 })).toBe(
			"compactThinking",
		);
		expect(compactProgressLabel(t, { phase: "thinking", thinkingChars: 55, outputChars: 0 })).toBe(
			"compactThinking · compactThinkingChars(55)",
		);
	});
});
