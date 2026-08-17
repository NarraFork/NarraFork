import { describe, expect, it } from "bun:test";
import {
	resolveHeadTrim,
	retainKeysInPlace,
	TRIM_TARGET_MESSAGES,
	TRIM_TRIGGER_MESSAGES,
	trimLoadedHead,
} from "./vlist-head-trim";

function messages(count: number, startSeq = 0) {
	return Array.from({ length: count }, (_, index) => ({
		id: `m${startSeq + index}`,
		seq: startSeq + index,
	}));
}

/** A window big enough and tall enough that only the flag under test can reject. */
function healthy(overrides: Partial<Parameters<typeof resolveHeadTrim>[0]> = {}) {
	const count = TRIM_TRIGGER_MESSAGES + 400;
	return {
		messages: messages(count),
		// 200px per row: 800 survivors ≈ 160_000px, far above 4 × (900 + 600).
		totalHeight: count * 200,
		viewportHeight: 900,
		overscan: 600,
		pinnedToBottom: true,
		hasStreamingRow: false,
		...overrides,
	};
}

describe("resolveHeadTrim — when the head may be dropped", () => {
	it("trims down to the target once the trigger is exceeded", () => {
		const input = healthy();
		const decision = resolveHeadTrim(input);
		expect(decision.trim).toBe(true);
		expect(decision.dropCount).toBe(input.messages.length - TRIM_TARGET_MESSAGES);
	});

	it("refuses while the reader has scrolled up", () => {
		expect(resolveHeadTrim(healthy({ pinnedToBottom: false }))).toEqual({
			trim: false,
			dropCount: 0,
			reason: "not-pinned",
		});
	});

	/**
	 * The failure this prevents is silent output LOSS, not a layout glitch: see the
	 * "streaming" rejection's own note. It is checked before everything else, so it
	 * holds even for a window that is otherwise perfectly trimmable.
	 */
	it("refuses while a live streaming row is published", () => {
		expect(resolveHeadTrim(healthy({ hasStreamingRow: true }))).toEqual({
			trim: false,
			dropCount: 0,
			reason: "streaming",
		});
	});

	it("refuses when streaming even if the reader is also scrolled up", () => {
		// Ordering matters only for the reported reason, but the reason is what a
		// diagnostic reads, and "streaming" is the one that must never be masked.
		expect(resolveHeadTrim(healthy({ hasStreamingRow: true, pinnedToBottom: false })).reason).toBe(
			"streaming",
		);
	});

	it("refuses below the message trigger", () => {
		const count = TRIM_TRIGGER_MESSAGES;
		expect(
			resolveHeadTrim(healthy({ messages: messages(count), totalHeight: count * 200 })).reason,
		).toBe("below-threshold");
	});

	/**
	 * Independent of the count condition: a window can hold thousands of SHORT
	 * messages that barely fill two screens. Trimming that leaves a canvas the
	 * shell's first-screen fill loop immediately re-fetches, which is the
	 * trim/refetch loop this factor exists to prevent.
	 */
	it("refuses when the survivors would not cover enough canvas", () => {
		const count = TRIM_TRIGGER_MESSAGES + 400;
		expect(
			resolveHeadTrim(
				healthy({
					messages: messages(count),
					// 2px per row: 800 survivors ≈ 1600px, below 4 × (900 + 600).
					totalHeight: count * 2,
				}),
			).reason,
		).toBe("below-threshold");
	});

	it("applies the count and height conditions independently", () => {
		// Tall enough, but too few messages.
		expect(resolveHeadTrim(healthy({ messages: messages(10), totalHeight: 100_000 })).reason).toBe(
			"below-threshold",
		);
		// Many messages, but not tall enough.
		const count = TRIM_TRIGGER_MESSAGES + 400;
		expect(resolveHeadTrim(healthy({ messages: messages(count), totalHeight: count })).reason).toBe(
			"below-threshold",
		);
	});

	it("refuses when a protected message falls inside the cut", () => {
		const input = healthy();
		// m0 is the very oldest, so it is certainly inside the dropped range.
		expect(resolveHeadTrim({ ...input, protectedMessageIds: ["m0"] })).toEqual({
			trim: false,
			dropCount: 0,
			reason: "protected-in-range",
		});
	});

	it("ignores protected messages that survive the cut", () => {
		const input = healthy();
		const survivor = String(input.messages[input.messages.length - 1]?.id);
		expect(resolveHeadTrim({ ...input, protectedMessageIds: [survivor] }).trim).toBe(true);
	});

	it("ignores empty and non-string protected ids", () => {
		const input = healthy();
		expect(resolveHeadTrim({ ...input, protectedMessageIds: [] }).trim).toBe(true);
		expect(resolveHeadTrim({ ...input, protectedMessageIds: [""] }).trim).toBe(true);
	});

	/**
	 * Hysteresis. If the trigger equalled the target, every append would sit at the
	 * boundary and trim one message, paying a full rebuild per message forever.
	 */
	it("does not trim again on the appends right after a trim", () => {
		let window = messages(TRIM_TRIGGER_MESSAGES + 400);
		const first = resolveHeadTrim(healthy({ messages: window, totalHeight: window.length * 200 }));
		expect(first.trim).toBe(true);
		window = [...trimLoadedHead(window, first.dropCount).messages];
		expect(window.length).toBe(TRIM_TARGET_MESSAGES);

		// Append and re-evaluate: nothing may trim until the trigger is passed again.
		let trims = 0;
		for (let i = 0; i < TRIM_TRIGGER_MESSAGES - TRIM_TARGET_MESSAGES; i++) {
			window = [...window, { id: `new${i}`, seq: 100_000 + i }];
			if (resolveHeadTrim(healthy({ messages: window, totalHeight: window.length * 200 })).trim) {
				trims++;
			}
		}
		expect(trims).toBe(0);
	});

	it("honours threshold overrides so tests need not build huge windows", () => {
		const decision = resolveHeadTrim(
			healthy({
				messages: messages(30),
				totalHeight: 30 * 200,
				targetMessages: 10,
				triggerMessages: 20,
				// Also relaxed: 10 survivors at 200px cover 2000px, which is legitimately
				// below 4 bands. The count override alone cannot satisfy the pixel rule.
				keepHeightFactor: 1,
			}),
		);
		expect(decision).toEqual({ trim: true, dropCount: 20 });
	});

	/**
	 * The pixel rule is not bypassable by shrinking the count thresholds — the two
	 * conditions are independent, which is what keeps a short-message window from
	 * being trimmed into the fill loop's trigger zone.
	 */
	it("still enforces the height rule when count overrides are relaxed", () => {
		expect(
			resolveHeadTrim(
				healthy({
					messages: messages(30),
					totalHeight: 30 * 200,
					targetMessages: 10,
					triggerMessages: 20,
				}),
			).reason,
		).toBe("below-threshold");
	});
});

describe("trimLoadedHead — dropping the head and retreating the cursor", () => {
	it("keeps the newest messages and reports the oldest surviving seq", () => {
		const window = messages(10, 5); // seq 5..14
		const result = trimLoadedHead(window, 4);
		expect(result.messages.map((m) => m.id)).toEqual(["m9", "m10", "m11", "m12", "m13", "m14"]);
		expect(result.oldestKeptSeq).toBe(9);
	});

	/**
	 * The cursor MUST retreat with the data. Leaving it forward makes the next
	 * upward page start below the gap the trim created — history that no later
	 * fetch repairs. This is the opposite of removeLoadedMessages' contract.
	 */
	it("reports a cursor that moved backwards relative to the untrimmed window", () => {
		const window = messages(10, 5);
		const before = trimLoadedHead(window, 0).oldestKeptSeq;
		const after = trimLoadedHead(window, 4).oldestKeptSeq;
		expect(before).toBe(5);
		expect(after).toBe(9);
		expect(after).toBeGreaterThan(before as number);
	});

	it("returns the same array identity when nothing is dropped", () => {
		const window = messages(5);
		expect(trimLoadedHead(window, 0).messages).toBe(window);
		expect(trimLoadedHead(window, -3).messages).toBe(window);
	});

	it("never empties the document", () => {
		const window = messages(5);
		expect(trimLoadedHead(window, 5).messages).toBe(window);
		expect(trimLoadedHead(window, 99).messages).toBe(window);
	});

	it("ignores messages without a usable seq when resolving the cursor", () => {
		const window = [
			{ id: "a", seq: 1 },
			{ id: "b" },
			{ id: "c", seq: 7 },
			{ id: "d", seq: Number.NaN },
		];
		expect(trimLoadedHead(window, 1).oldestKeptSeq).toBe(7);
	});
});

describe("retainKeysInPlace — sweeping dead per-row handler caches", () => {
	it("drops entries absent from the live key set and keeps the rest", () => {
		const a = new Map<string, unknown>([
			["live1", 1],
			["dead1", 2],
		]);
		const b = new Map<string, unknown>([
			["dead2", 3],
			["live2", 4],
		]);
		const removed = retainKeysInPlace([a, b], new Set(["live1", "live2"]));
		expect(removed).toBe(2);
		expect([...a.keys()]).toEqual(["live1"]);
		expect([...b.keys()]).toEqual(["live2"]);
	});

	it("removes nothing when every key is still live", () => {
		const cache = new Map<string, unknown>([["k", 1]]);
		expect(retainKeysInPlace([cache], new Set(["k"]))).toBe(0);
		expect(cache.size).toBe(1);
	});

	it("clears a cache entirely when no key survives", () => {
		const cache = new Map<string, unknown>([
			["a", 1],
			["b", 2],
		]);
		expect(retainKeysInPlace([cache], new Set())).toBe(2);
		expect(cache.size).toBe(0);
	});

	it("skips empty caches without touching them", () => {
		expect(retainKeysInPlace([new Map()], new Set(["x"]))).toBe(0);
	});
});
