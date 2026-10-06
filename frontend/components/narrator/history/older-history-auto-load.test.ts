import { describe, expect, test } from "bun:test";
import {
	resolveOlderHistoryAutoLoad,
	resolveOlderHistoryAutoLoadEnabled,
} from "./older-history-auto-load";

const baseInput = {
	now: 10_000,
	autoLoadEnabled: true,
	hasOlder: true,
	expanding: false,
	atBottom: false,
	scrollTop: 100,
	triggerPx: 600,
};

describe("older-history auto-load preference", () => {
	test("does not enable scrolling while the persisted preference is loading", () => {
		expect(resolveOlderHistoryAutoLoadEnabled(undefined, true)).toBeFalse();
		expect(resolveOlderHistoryAutoLoadEnabled(false, false)).toBeFalse();
		expect(resolveOlderHistoryAutoLoadEnabled(true, false)).toBeTrue();
		expect(resolveOlderHistoryAutoLoadEnabled(undefined, false)).toBeTrue();
	});
});

describe("older-history auto-load intent", () => {
	test("does not load for programmatic near-top scrolling without user intent", () => {
		expect(resolveOlderHistoryAutoLoad({ ...baseInput, intentAt: null })).toEqual({
			shouldLoad: false,
			nextIntentAt: null,
		});
	});

	test("does not load for recent upward intent when automatic loading is disabled", () => {
		expect(
			resolveOlderHistoryAutoLoad({
				...baseInput,
				intentAt: 9_900,
				autoLoadEnabled: false,
			}),
		).toEqual({ shouldLoad: false, nextIntentAt: 9_900 });
	});

	test("loads once for recent upward intent and consumes it", () => {
		const decision = resolveOlderHistoryAutoLoad({ ...baseInput, intentAt: 9_900 });
		expect(decision).toEqual({ shouldLoad: true, nextIntentAt: null });

		expect(resolveOlderHistoryAutoLoad({ ...baseInput, intentAt: decision.nextIntentAt })).toEqual({
			shouldLoad: false,
			nextIntentAt: null,
		});
	});

	test("retains recent intent while travelling upward, then expires it", () => {
		expect(resolveOlderHistoryAutoLoad({ ...baseInput, intentAt: 9_900, scrollTop: 800 })).toEqual({
			shouldLoad: false,
			nextIntentAt: 9_900,
		});
		expect(resolveOlderHistoryAutoLoad({ ...baseInput, intentAt: 7_000 })).toEqual({
			shouldLoad: false,
			nextIntentAt: null,
		});
	});

	test("clears intent after returning to the bottom", () => {
		expect(resolveOlderHistoryAutoLoad({ ...baseInput, intentAt: 9_900, atBottom: true })).toEqual({
			shouldLoad: false,
			nextIntentAt: null,
		});
	});

	test("does not consume intent merely because another expansion holds the lock", () => {
		expect(resolveOlderHistoryAutoLoad({ ...baseInput, intentAt: 9_900, expanding: true })).toEqual(
			{ shouldLoad: false, nextIntentAt: 9_900 },
		);
	});
});
