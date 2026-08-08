/**
 * summary-retry-progress.test.ts — a retrying summary must report progress.
 *
 * Compact is bounded by INACTIVITY, not total duration, and `summaryGenerate`
 * retries transient failures internally with exponential backoff. Those two facts
 * collide: at the default cap the backoff alone sums to ~126s of pure sleep, and
 * each failing attempt adds its own request time on top. If none of that reports
 * progress, the entire retry chain reads as one silent gap to the compact
 * watchdog, which then aborts a compact that is merely rate-limited and
 * recovering — exactly the false kill the stall-based design set out to avoid.
 *
 * So every attempt, and both sides of every backoff sleep, must beat.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Keep the backoff negligible so the test exercises the beat wiring, not the clock.
const realErrorHandling = { ...(await import("../error-handling")) };
mock.module("../error-handling", () => ({
	...realErrorHandling,
	auxiliaryRetryDelayMs: () => 1,
	getAuxiliaryMaxRetries: () => 3,
}));

let generateAttempts = 0;
let generateImpl: () => Promise<{ text: string }> = async () => ({ text: "summary" });

// `agentGenerateWithMeta` lives inside index.ts, so it cannot be mocked from
// outside. Intercept one level down instead: stub provider resolution to hand back
// an adapter whose generateWithMeta is the fake request.
const realProviderModule = { ...(await import("../provider")) };
mock.module("../provider", () => ({
	...realProviderModule,
	resolveProviderAndModel: () => ({
		provider: "anthropic",
		model: "claude-haiku",
		adapter: {
			generateWithMeta: async () => {
				generateAttempts++;
				return generateImpl();
			},
		},
	}),
}));

const { summaryGenerate } = await import("../index");

beforeEach(() => {
	generateAttempts = 0;
	generateImpl = async () => ({ text: "summary" });
});

afterAll(() => {
	mock.module("../error-handling", () => realErrorHandling);
	mock.module("../provider", () => realProviderModule);
	mock.restore();
});

/** Call summaryGenerate with the retry-progress callback in its trailing slot. */
function generateWithProgress(onRetryProgress: () => void) {
	return summaryGenerate(
		"text",
		"system",
		undefined,
		undefined,
		undefined,
		"anthropic:claude-haiku",
		undefined,
		// Do not broadcast summary-model errors from a unit test.
		false,
		undefined,
		onRetryProgress,
	);
}

describe("summaryGenerate retry progress", () => {
	test("beats once when the first attempt succeeds", async () => {
		let beats = 0;
		const result = await generateWithProgress(() => beats++);

		expect(result.text).toBe("summary");
		expect(generateAttempts).toBe(1);
		// Starting the attempt is itself progress, so the happy path still beats.
		expect(beats).toBe(1);
	});

	test("beats across a transient retry chain instead of going silent", async () => {
		// "overloaded" is a retryable pattern, so this is the rate-limited-but-
		// recovering case the watchdog must not kill.
		let beats = 0;
		generateImpl = async () => {
			if (generateAttempts < 3) throw new Error("Provider overloaded, try again");
			return { text: "late summary" };
		};

		const result = await generateWithProgress(() => beats++);

		expect(result.text).toBe("late summary");
		expect(generateAttempts).toBe(3);
		// 3 attempt beats + 2 beats around each of the 2 backoff sleeps.
		expect(beats).toBe(7);
	});

	test("keeps beating while a retry chain runs out of attempts", async () => {
		let beats = 0;
		generateImpl = async () => {
			throw new Error("Provider overloaded, try again");
		};

		await expect(generateWithProgress(() => beats++)).rejects.toThrow(/overloaded/);

		// A doomed chain still has to look alive: the watchdog's job here is to catch
		// a STUCK compact, and this one is failing loudly on its own schedule.
		expect(generateAttempts).toBe(4);
		expect(beats).toBeGreaterThanOrEqual(generateAttempts);
	});

	test("works without a progress callback", async () => {
		generateImpl = async () => {
			if (generateAttempts < 2) throw new Error("rate limit exceeded");
			return { text: "ok" };
		};

		const result = await summaryGenerate("text", "system");

		expect(result.text).toBe("ok");
		expect(generateAttempts).toBe(2);
	});
});
