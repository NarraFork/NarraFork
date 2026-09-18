/**
 * vlist-drill-morph-motion.test.ts — the drill morph's keyframe shape.
 *
 * Animation lifetime (handles, per-row cancellation so stacked activity survives a
 * re-toggle, timing) belongs to `vlist-motion-scheduler.ts` and is covered by its
 * tests. What remains here is the keyframe pair itself.
 */

import { describe, expect, it } from "bun:test";
import { BARE_ROW_CHEVRON, BARE_ROW_GAP } from "@shared/pretext-layout/row-metrics";
import { CARD_BORDER, CARD_PADDING } from "./measure/measure-tool-call";
import { DRILL_MORPH_X_OFFSET, type DrillMorphPlan } from "./vlist-drill-morph";
import {
	drillBorderKeyframes,
	drillBorderKeyframesFrom,
	drillMorphKeyframes,
	drillMorphKeyframesFrom,
	drillTailKeyframes,
	drillTailKeyframesFrom,
} from "./vlist-drill-morph-motion";

function plan(rowUid: string, kind: "expand" | "collapse", driftY: number): DrillMorphPlan {
	return { rowUid, kind, driftY, durationMs: 200 };
}

describe("drillMorphKeyframes", () => {
	/**
	 * Both axes travel. The card header's lane starts at the card's left edge while a
	 * folded row's starts after its chevron slot, so a Y-only morph slid the line into
	 * place while its icon and text jumped `DRILL_MORPH_X_OFFSET` sideways in one frame.
	 */
	it("slides the incoming line home from the outgoing line's position, on both axes", () => {
		const frames = drillMorphKeyframes(plan("t::r0", "expand", 11.1));
		expect(frames[0]).toMatchObject({
			transform: `translate(${DRILL_MORPH_X_OFFSET}px, -11.1px)`,
		});
		expect(frames.at(-1)).toMatchObject({ transform: "translate(0px, 0px)" });
	});

	/**
	 * BOTH ends of the offset must be counted.
	 *
	 * An earlier version used the row's lane alone (`chevron + gap` = 18), which assumed
	 * the card header starts at 0. It does not: the card is a bordered, padded `Paper`, so
	 * its header begins at `CARD_BORDER + CARD_PADDING` = 11. Ignoring that put the morph's
	 * target 11px too far right — the reader saw the icon and text settle right of where
	 * the summary line actually sits.
	 */
	it("derives the X offset from BOTH forms' content starts, not a literal", () => {
		expect(DRILL_MORPH_X_OFFSET).toBe(
			BARE_ROW_CHEVRON + BARE_ROW_GAP - (CARD_BORDER + CARD_PADDING),
		);
		// Sanity: the row's lane really is to the RIGHT of the card's, so the compensation
		// is a small positive nudge rather than the row's whole lane.
		expect(DRILL_MORPH_X_OFFSET).toBeGreaterThan(0);
		expect(DRILL_MORPH_X_OFFSET).toBeLessThan(BARE_ROW_CHEVRON + BARE_ROW_GAP);
	});

	/**
	 * REGRESSION: no cross-fade.
	 *
	 * An earlier version faded (`opacity: 0 → 1`), which a reader watching frame by frame
	 * sees as the incoming line "blurring in". §4.7's rule is that a cross-fade masks a
	 * COMPONENT SWAP, and this is not one worth masking: the summary row and the card
	 * header carry the same `Name · summary` text in the same slot, so the transition
	 * wanted here is a seamless replacement plus travel. The fade also fought the block's
	 * height animation, so the two read as one blurry event instead of one solid movement.
	 */
	it("never writes opacity", () => {
		for (const kind of ["expand", "collapse"] as const) {
			for (const frame of drillMorphKeyframes(plan("t::r0", kind, 11.1))) {
				expect(frame).not.toHaveProperty("opacity");
			}
		}
	});

	/**
	 * COLLAPSE animates the OUTGOING line, so it runs the other way round.
	 *
	 * The node is the CARD's header — the line actually on screen, since the card is
	 * retained for the duration of the close (see closingRowKeys). It therefore starts at
	 * its committed position and travels TO where the summary line will be. An earlier
	 * version animated the summary row instead, which is not even rendered during the
	 * close, so the resolver returned null and the header the reader was looking at jumped
	 * with no transition.
	 */
	it("moves the outgoing card header toward the summary line on collapse", () => {
		const frames = drillMorphKeyframes(plan("t::r0", "collapse", -11.1));
		expect(frames[0]).toMatchObject({ transform: "translate(0px, 0px)" });
		expect(frames.at(-1)).toMatchObject({
			transform: `translate(${DRILL_MORPH_X_OFFSET}px, -11.1px)`,
		});
	});

	it("keeps expand and collapse mirror images of each other", () => {
		// The planner supplies a LOCAL collapse delta, so the two directions remain symmetric
		// without importing the viewport's pinned-bottom scroll correction.
		const expand = drillMorphKeyframes(plan("t::r0", "expand", 11.1));
		const collapse = drillMorphKeyframes(plan("t::r0", "collapse", -11.1));
		expect(expand[0]?.transform).toBe(collapse.at(-1)?.transform);
		expect(expand.at(-1)?.transform).toBe(collapse[0]?.transform);
	});

	it("animates only composited properties — never top/height", () => {
		for (const frame of drillMorphKeyframes(plan("t::r0", "expand", 11.1))) {
			expect(frame).not.toHaveProperty("top");
			expect(frame).not.toHaveProperty("height");
		}
	});
});

/**
 * INTERRUPTION: clicking the same row again mid-flight must continue the movement.
 *
 * Every animation runs `fill: "none"`, so cancelling one makes its node read the COMMITTED
 * style instantly. That is right for teardown and wrong for a re-toggle: the line would
 * snap to where the previous fold had put it and start the new motion from there — a
 * visible jump on every rapid double click. So the scheduler samples the outgoing
 * animation's progress before cancelling it, and the incoming plan resumes from the
 * position the element visually holds.
 */
describe("drillMorphKeyframesFrom — resuming an interrupted morph", () => {
	it("starts from the committed endpoint when nothing was interrupted", () => {
		const p = plan("t::r0", "expand", 11.1);
		expect(drillMorphKeyframesFrom(p, null)).toEqual(drillMorphKeyframes(p));
	});

	it("resumes from the OUTGOING motion's remaining displacement", () => {
		// Interrupted at the very start: the outgoing motion had not moved, so the element
		// still holds its full starting displacement.
		const atStart = drillMorphKeyframesFrom(plan("t::r0", "expand", 20), { progress: 0 });
		expect(atStart[0]?.transform).toBe(`translate(${DRILL_MORPH_X_OFFSET}px, 20px)`);
		// Interrupted at the very end: it had arrived, so there is nothing left to hold.
		const atEnd = drillMorphKeyframesFrom(plan("t::r0", "expand", 20), { progress: 1 });
		expect(atEnd[0]?.transform).toBe("translate(0px, 0px)");
	});

	it("lands strictly between the two ends at mid-flight", () => {
		const mid = drillMorphKeyframesFrom(plan("t::r0", "expand", 20), { progress: 0.5 });
		const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(String(mid[0]?.transform ?? ""));
		expect(match).not.toBeNull();
		const [x, y] = [Number(match?.[1]), Number(match?.[2])];
		// Half-eased: past neither end, and both axes agree on the same fraction so the
		// line cannot skew while it resumes.
		expect(y).toBeGreaterThan(0);
		expect(y).toBeLessThan(20);
		expect(x / DRILL_MORPH_X_OFFSET).toBeCloseTo(y / 20, 6);
	});

	it("always settles on the committed endpoint, however it was interrupted", () => {
		// The resume only rewrites the FIRST keyframe; the destination is untouched, which
		// is what guarantees repeated interruptions cannot accumulate drift.
		for (const progress of [0, 0.1, 0.37, 0.5, 0.9, 1]) {
			for (const kind of ["expand", "collapse"] as const) {
				const p = plan("t::r0", kind, kind === "collapse" ? -14 : 14);
				const frames = drillMorphKeyframesFrom(p, { progress });
				expect(frames.at(-1)).toEqual(drillMorphKeyframes(p).at(-1));
			}
		}
	});

	it("is monotonic in progress, so a later interruption never resumes further back", () => {
		const held = (progress: number) => {
			const frames = drillMorphKeyframesFrom(plan("t::r0", "expand", 100), { progress });
			return Number(
				/translate\([-\d.]+px, ([-\d.]+)px\)/.exec(String(frames[0]?.transform ?? ""))?.[1],
			);
		};
		const samples = [0, 0.25, 0.5, 0.75, 1].map(held);
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i] as number).toBeLessThanOrEqual(samples[i - 1] as number);
		}
	});

	it("clamps a progress outside 0..1 instead of overshooting", () => {
		// A sampled `currentTime` can exceed the duration on a finished-but-not-yet-cleaned
		// animation; extrapolating would fling the line past its endpoint.
		expect(
			drillMorphKeyframesFrom(plan("t::r0", "expand", 20), { progress: 1.4 })[0]?.transform,
		).toBe("translate(0px, 0px)");
		expect(
			drillMorphKeyframesFrom(plan("t::r0", "expand", 20), { progress: -0.3 })[0]?.transform,
		).toBe(`translate(${DRILL_MORPH_X_OFFSET}px, 20px)`);
	});
});

/**
 * TAIL CROSS-FADE + BORDER FADE.
 *
 * The tail cluster (diff stats + duration) sits at the card's right edge but hugs the title
 * in a folded row, and the distance between those places depends on the RENDERED TITLE
 * WIDTH — which the measure layer never computes. So it is faded rather than moved. The
 * border exists only in the card form, so it has nothing to travel between either.
 *
 * Both must be exact mirrors between the two directions, because that is what lets a
 * mid-flight flip reverse instead of restarting.
 */
describe("drillTailKeyframes — the cluster fades instead of travelling", () => {
	it("fades IN on expand and OUT on collapse", () => {
		// The animated node belongs to the CARD in both directions: on expand it is
		// incoming, on collapse it is retained and animated shut. A single 0→1 would flash
		// the cluster back to full opacity at the start of every close.
		expect(drillTailKeyframes("expand").map((f) => f.opacity)).toEqual([0, 1]);
		expect(drillTailKeyframes("collapse").map((f) => f.opacity)).toEqual([1, 0]);
	});

	it("is a mirror pair, so a flip reverses rather than restarts", () => {
		const a = drillTailKeyframes("expand").map((f) => f.opacity);
		const b = drillTailKeyframes("collapse").map((f) => f.opacity);
		expect(a).toEqual([...b].reverse());
	});

	it("touches opacity only — never a layout property", () => {
		for (const kind of ["expand", "collapse"] as const) {
			for (const frame of drillTailKeyframes(kind)) {
				expect(frame).not.toHaveProperty("transform");
				expect(frame).not.toHaveProperty("width");
				expect(frame).not.toHaveProperty("left");
			}
		}
	});

	it("resumes from the live opacity, from either direction", () => {
		// Interrupted halfway, the replacement starts where the outgoing fade had got to
		// rather than at its own start — otherwise the cluster blinks on every re-click.
		expect(drillTailKeyframesFrom("expand", { progress: 0.5 })[0]?.opacity).toBeCloseTo(0.5, 6);
		expect(drillTailKeyframesFrom("collapse", { progress: 0.5 })[0]?.opacity).toBeCloseTo(0.5, 6);
	});

	it("resumes at the extremes without overshooting", () => {
		// progress 0 → the outgoing fade had not moved, so it still holds ITS start, which
		// is this direction's end value.
		expect(drillTailKeyframesFrom("expand", { progress: 0 })[0]?.opacity).toBe(1);
		expect(drillTailKeyframesFrom("collapse", { progress: 0 })[0]?.opacity).toBe(0);
		// progress 1 → it had arrived, i.e. at this direction's start value.
		expect(drillTailKeyframesFrom("expand", { progress: 1 })[0]?.opacity).toBe(0);
		expect(drillTailKeyframesFrom("collapse", { progress: 1 })[0]?.opacity).toBe(1);
	});

	it("always keeps the committed endpoint, however it was interrupted", () => {
		for (const kind of ["expand", "collapse"] as const) {
			for (const progress of [0, 0.3, 0.5, 0.8, 1]) {
				expect(drillTailKeyframesFrom(kind, { progress }).at(-1)).toEqual(
					drillTailKeyframes(kind).at(-1),
				);
			}
		}
	});

	it("falls back to the plain fade when nothing was interrupted", () => {
		expect(drillTailKeyframesFrom("expand", null)).toEqual(drillTailKeyframes("expand"));
	});
});

describe("drillBorderKeyframes — only the transparent end is named", () => {
	/**
	 * The card's border is a theme variable by default and a STATUS OVERRIDE on some cards.
	 * Naming an opaque colour here would repaint those in the wrong hue for the duration —
	 * a fade that also changes colour. Leaving that end implicit makes the browser fill it
	 * from the committed style, which cannot disagree with itself.
	 */
	it("names transparent only, leaving the opaque end to the computed style", () => {
		const expand = drillBorderKeyframes("expand");
		expect(expand).toHaveLength(1);
		expect(expand[0]).toMatchObject({ offset: 0, borderColor: "transparent" });
		const collapse = drillBorderKeyframes("collapse");
		expect(collapse).toHaveLength(1);
		expect(collapse[0]).toMatchObject({ offset: 1, borderColor: "transparent" });
	});

	it("puts the transparent end at the START of an expand and the END of a collapse", () => {
		// i.e. the border arrives when drilling in and leaves when closing.
		expect(drillBorderKeyframes("expand")[0]?.offset).toBe(0);
		expect(drillBorderKeyframes("collapse")[0]?.offset).toBe(1);
	});

	it("never animates opacity, which would fade the whole card including its content", () => {
		for (const kind of ["expand", "collapse"] as const) {
			for (const frame of drillBorderKeyframes(kind)) {
				expect(frame).not.toHaveProperty("opacity");
			}
		}
	});

	it("is interruption-safe without arithmetic, being implicit at one end already", () => {
		for (const kind of ["expand", "collapse"] as const) {
			expect(drillBorderKeyframesFrom(kind, { progress: 0.4 })).toEqual(drillBorderKeyframes(kind));
			expect(drillBorderKeyframesFrom(kind, null)).toEqual(drillBorderKeyframes(kind));
		}
	});
});
