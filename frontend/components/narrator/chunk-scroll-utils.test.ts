import { describe, expect, test } from "bun:test";
import {
	DESKTOP_CHUNK_BAND_RADIUS,
	MOBILE_CHUNK_BAND_RADIUS,
	resolveChunkBandRadius,
	resolveMessageScrollerOverscrollBehavior,
	resolveOlderHistoryAutoLoad,
	resolveOlderHistoryAutoLoadEnabled,
} from "./chunk-scroll-utils";

const baseInput = {
	now: 10_000,
	autoLoadEnabled: true,
	hasOlder: true,
	expanding: false,
	atBottom: false,
	scrollTop: 100,
	triggerPx: 600,
};

describe("message scroller overscroll containment", () => {
	test("contains vertical chaining only on mobile without changing other gestures", () => {
		expect(resolveMessageScrollerOverscrollBehavior(true)).toBe("contain");
		expect(resolveMessageScrollerOverscrollBehavior(false)).toBeUndefined();
		expect(resolveMessageScrollerOverscrollBehavior(undefined)).toBeUndefined();
	});
});

describe("older-history auto-load preference", () => {
	test("does not enable scrolling while the persisted preference is loading", () => {
		expect(resolveOlderHistoryAutoLoadEnabled(undefined, true)).toBeFalse();
		expect(resolveOlderHistoryAutoLoadEnabled(false, false)).toBeFalse();
		expect(resolveOlderHistoryAutoLoadEnabled(true, false)).toBeTrue();
		expect(resolveOlderHistoryAutoLoadEnabled(undefined, false)).toBeTrue();
	});
});

/**
 * Measured cause of "opening a narrator on a phone loads far too much": the
 * mount/load band was a fixed radius of 3, so first paint fetched the centre
 * chunk (20 messages) and then a second request for the 3 chunks below it (60
 * messages, ~750KB) purely to fill a band that a 390px viewport cannot show.
 * These lock the numbers that make the request small, not just the fact that a
 * function exists.
 */
describe("chunk mount/load band radius", () => {
	test("mobile mounts a strictly smaller band than desktop", () => {
		expect(MOBILE_CHUNK_BAND_RADIUS).toBeLessThan(DESKTOP_CHUNK_BAND_RADIUS);
		expect(resolveChunkBandRadius(true)).toBe(MOBILE_CHUNK_BAND_RADIUS);
		expect(resolveChunkBandRadius(false)).toBe(DESKTOP_CHUNK_BAND_RADIUS);
	});

	/**
	 * The band spans radius*2+1 chunks and the server packs 20 top-level messages
	 * per chunk, so the radius is a direct bound on first-paint message volume.
	 * Stated in messages because that is the quantity the user feels.
	 */
	test("mobile first paint stays bounded to a few chunks of messages", () => {
		const CHUNK_MESSAGES = 20;
		const mobileBand = resolveChunkBandRadius(true) * 2 + 1;
		expect(mobileBand).toBeLessThanOrEqual(3);
		expect(mobileBand * CHUNK_MESSAGES).toBeLessThanOrEqual(60);
		// And materially less than what desktop pulls, which is the regression that
		// a future "just bump it back to 3" change must trip over.
		expect(mobileBand).toBeLessThan(resolveChunkBandRadius(false) * 2 + 1);
	});

	/**
	 * A neighbour on each side is what keeps a short scroll landing on mounted
	 * content instead of a blank height spacer, so shrinking the band must not go
	 * all the way to zero.
	 */
	test("mobile still keeps a neighbour chunk mounted on each side", () => {
		expect(resolveChunkBandRadius(true)).toBeGreaterThanOrEqual(1);
	});

	/**
	 * `useMediaQuery` returns undefined before it has evaluated, and an unknown
	 * viewport must not silently shrink a desktop user's prefetch window.
	 */
	test("an unknown viewport resolves to the desktop band", () => {
		expect(resolveChunkBandRadius(undefined)).toBe(DESKTOP_CHUNK_BAND_RADIUS);
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

	test("loads once for recent upward user intent and consumes it", () => {
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
