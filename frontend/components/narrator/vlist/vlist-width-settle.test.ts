import { describe, expect, it } from "bun:test";
import {
	bucketViewportHeight,
	isWidthFeedbackCycle,
	pushCommittedWidth,
	resolveWidthSettle,
	VIEWPORT_HEIGHT_BUCKET_PX,
	WIDTH_CYCLE_RING,
	WIDTH_POINTER_BACKSTOP_MS,
	WIDTH_SETTLE_DELAY_MS,
	type WidthSettleInput,
} from "./vlist-width-settle";

const base: WidthSettleInput = {
	nextWidth: 800,
	committedWidth: 700,
	trigger: "observer",
	pointerDown: false,
};

describe("resolveWidthSettle", () => {
	// The central rule, and the reason no cost estimate is consulted: two attempts at
	// predicting rebuild cost each failed differently (measurement time missed the DOM;
	// row count missed a ~30x per-row content variance, which made two panels either
	// side of a splitter disagree). A drag now defers unconditionally.
	it("defers during a drag, with no cost input of any kind", () => {
		const decision = resolveWidthSettle({ ...base, pointerDown: true });
		expect(decision).toEqual({
			commit: false,
			defer: true,
			deferForMs: WIDTH_POINTER_BACKSTOP_MS,
		});
	});

	it("defers during a drag no matter how small the change is", () => {
		expect(
			resolveWidthSettle({ ...base, nextWidth: 701, committedWidth: 700, pointerDown: true }).defer,
		).toBe(true);
	});

	it("commits when the gesture ends", () => {
		expect(resolveWidthSettle({ ...base, trigger: "gesture-end" }).commit).toBe(true);
	});

	// A release can be observed while another finger is still down; the decision must
	// be correct either way.
	it("commits on gesture-end even if a pointer is still reported down", () => {
		expect(resolveWidthSettle({ ...base, trigger: "gesture-end", pointerDown: true }).commit).toBe(
			true,
		);
	});

	// Non-pointer resizes (OS window chrome, a programmatic panel toggle) have no
	// gesture to wait for, so the quiet period is the right signal there.
	it("uses the quiet period when no pointer is involved", () => {
		expect(resolveWidthSettle(base)).toEqual({
			commit: false,
			defer: true,
			deferForMs: WIDTH_SETTLE_DELAY_MS,
		});
	});

	it("commits when the quiet period elapses", () => {
		expect(resolveWidthSettle({ ...base, trigger: "timer" }).commit).toBe(true);
	});

	// The backstop: a held pointer whose width has gone idle for seconds is a stuck
	// state, not a drag. Committing there is what makes convergence unconditional — an
	// earlier version re-armed instead and wedged the width permanently.
	it("commits on the backstop timer even while a pointer reads as down", () => {
		expect(resolveWidthSettle({ ...base, trigger: "timer", pointerDown: true }).commit).toBe(true);
	});

	it("arms the long backstop during a drag, never the short delay", () => {
		const decision = resolveWidthSettle({ ...base, pointerDown: true });
		expect(decision.deferForMs).toBe(WIDTH_POINTER_BACKSTOP_MS);
		expect(decision.deferForMs).toBeGreaterThan(WIDTH_SETTLE_DELAY_MS);
	});

	// A ResizeObserver fires for HEIGHT-only changes too (the composer growing a line,
	// a banner appearing). Answering those with a rebuild would re-measure the whole
	// document for a change that cannot affect wrapping.
	it("does nothing when the width did not actually change", () => {
		expect(resolveWidthSettle({ ...base, nextWidth: 700, committedWidth: 700 })).toEqual({
			commit: false,
			defer: false,
			deferForMs: 0,
		});
	});

	it("treats sub-pixel width noise as unchanged, even mid-drag", () => {
		expect(
			resolveWidthSettle({
				...base,
				nextWidth: 700.4,
				committedWidth: 700,
				pointerDown: true,
			}),
		).toEqual({ commit: false, defer: false, deferForMs: 0 });
	});

	it("keeps the pointer backstop far above any plausible in-gesture pause", () => {
		expect(WIDTH_POINTER_BACKSTOP_MS).toBeGreaterThan(WIDTH_SETTLE_DELAY_MS * 10);
	});

	it("keeps the settle delay longer than a 60fps frame gap", () => {
		// Otherwise a non-pointer resize would commit between two of its own frames.
		expect(WIDTH_SETTLE_DELAY_MS).toBeGreaterThan(1000 / 60);
	});

	// Guard against a cost model creeping back in: the decision must depend only on
	// these four inputs (plus the optional cycle history, which is not a cost model —
	// it carries no timing or size estimate, only previously committed widths).
	it("accepts no cost-estimate input", () => {
		const keys = Object.keys(base).sort();
		expect(keys).toEqual(["committedWidth", "nextWidth", "pointerDown", "trigger"]);
	});

	// The cycle guard is OPTIONAL: a caller that passes no history must behave exactly
	// as before, so the field cannot silently freeze a width somewhere it is not wired.
	it("is unaffected when no cycle history is supplied", () => {
		expect(resolveWidthSettle({ ...base, trigger: "timer" }).commit).toBe(true);
		expect(
			resolveWidthSettle({ ...base, trigger: "timer", recentCommittedWidths: [] }).commit,
		).toBe(true);
	});
});

/**
 * The cycle guard, at the level of its two helpers.
 *
 * `vlist-width-settle-loop.test.ts` drives these through the real measure stack and
 * pins the bound on commits. Here only the pattern recognition is checked, because that
 * is what decides whether a width is measurement feedback or genuine user input.
 */
describe("isWidthFeedbackCycle", () => {
	const ringOf = (...widths: number[]): readonly number[] => {
		let ring: readonly number[] = [];
		for (const w of widths) ring = pushCommittedWidth(ring, w);
		return ring;
	};

	it("recognises a repeated two-width alternation", () => {
		expect(isWidthFeedbackCycle(ringOf(700, 685, 700, 685), 700)).toBe(true);
	});

	// The next hop must be the one the alternation predicts. A different width means
	// something external moved, so it is not the cycle continuing.
	it("does not fire for a width outside the alternation", () => {
		expect(isWidthFeedbackCycle(ringOf(700, 685, 700, 685), 640)).toBe(false);
	});

	it("needs the full window (a single there-and-back is ordinary resize traffic)", () => {
		expect(isWidthFeedbackCycle(ringOf(700, 685, 700), 685)).toBe(false);
	});

	it("does not fire on a monotonic sweep", () => {
		expect(isWidthFeedbackCycle(ringOf(700, 710, 720, 730), 740)).toBe(false);
		expect(isWidthFeedbackCycle(ringOf(700, 710, 720, 730), 700)).toBe(false);
	});

	it("does not treat a constant width as an alternation", () => {
		expect(isWidthFeedbackCycle(ringOf(700, 700, 700, 700), 700)).toBe(false);
	});

	it("is safe on an empty or short history", () => {
		expect(isWidthFeedbackCycle([], 700)).toBe(false);
		expect(isWidthFeedbackCycle([700], 700)).toBe(false);
	});
});

describe("pushCommittedWidth", () => {
	it("keeps the most recent WIDTH_CYCLE_RING entries, newest last", () => {
		let ring: readonly number[] = [];
		for (const w of [1, 2, 3, 4, 5, 6]) ring = pushCommittedWidth(ring, w);
		expect(ring).toEqual([3, 4, 5, 6]);
		expect(ring.length).toBe(WIDTH_CYCLE_RING);
	});

	// Rounded on the way in, matching the `changed` comparison — otherwise one physical
	// width could occupy two ring slots and hide an alternation from the guard.
	it("rounds on the way in", () => {
		expect(pushCommittedWidth([], 699.6)).toEqual([700]);
		expect(pushCommittedWidth([], 700.4)).toEqual([700]);
	});

	it("does not mutate the array it was given", () => {
		const original: readonly number[] = [1, 2, 3, 4];
		pushCommittedWidth(original, 5);
		expect(original).toEqual([1, 2, 3, 4]);
	});

	it("keeps the window big enough to witness a repeat, not just a there-and-back", () => {
		// A B A is legitimate; A B A B is a cycle. Distinguishing them needs 4 slots.
		expect(WIDTH_CYCLE_RING).toBeGreaterThanOrEqual(4);
	});
});

/**
 * Height bucketing — the fix for the failure that survived several rounds.
 *
 * `viewportHeight` is a build option AND a rebuild-effect dependency, while its only
 * influence on measurement is the plan-detail cap (0.85 x height). Fed at pixel
 * resolution it re-measured the whole document per pixel, and because a sash drag
 * changes both dimensions it bypassed the width gate completely. Counted against the
 * real coordinator over an 80-frame drag at 4000 messages:
 *
 *     height raw       → 80 rebuilds, 1267ms
 *     height bucketed  →  2 rebuilds,   35ms
 */
describe("bucketViewportHeight", () => {
	it("collapses a run of pixel heights to very few distinct values", () => {
		const raw = Array.from({ length: 80 }, (_, i) => 700 + i);
		expect(new Set(raw).size).toBe(80);
		expect(new Set(raw.map(bucketViewportHeight)).size).toBeLessThanOrEqual(2);
	});

	it("is stable across sub-bucket jitter", () => {
		expect(bucketViewportHeight(740)).toBe(bucketViewportHeight(700));
		expect(bucketViewportHeight(700)).toBe(bucketViewportHeight(651));
	});

	it("rounds to nearest so a viewport is never described as much shorter", () => {
		expect(bucketViewportHeight(760)).toBe(800);
		expect(bucketViewportHeight(749)).toBe(700);
		for (const h of [301, 555, 700, 913, 1080, 1441]) {
			expect(Math.abs(bucketViewportHeight(h) - h)).toBeLessThanOrEqual(
				VIEWPORT_HEIGHT_BUCKET_PX / 2,
			);
		}
	});

	// `resolveDetailCap` treats 0/absent as "unknown" and falls back to the fixed cap.
	// Returning 0 for a real viewport would change a plan card's height the moment the
	// list is first measured.
	it("never returns 0 for a real viewport", () => {
		for (const h of [1, 30, 49, 50, 99, 120]) {
			expect(bucketViewportHeight(h)).toBeGreaterThanOrEqual(VIEWPORT_HEIGHT_BUCKET_PX);
		}
	});

	it("reports 0 for an unmeasured or invalid viewport", () => {
		expect(bucketViewportHeight(0)).toBe(0);
		expect(bucketViewportHeight(-10)).toBe(0);
		expect(bucketViewportHeight(Number.NaN)).toBe(0);
		expect(bucketViewportHeight(Number.POSITIVE_INFINITY)).toBe(0);
	});

	it("keeps the plan cap error under 10% of the cap", () => {
		for (const h of [600, 700, 850, 1000, 1400]) {
			const exactCap = Math.round(h * 0.85);
			const bucketedCap = Math.round(bucketViewportHeight(h) * 0.85);
			expect(Math.abs(bucketedCap - exactCap) / exactCap).toBeLessThan(0.1);
		}
	});
});
