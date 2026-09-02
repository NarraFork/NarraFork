/**
 * vlist-fold-motion.test.ts — the fold's keyframe builders and geometry capture.
 *
 * Animation lifetime (handles, cancellation, timing) is NOT tested here: it belongs
 * to `vlist-motion-scheduler.ts` and is covered by its own tests. This file asserts
 * only what this module still owns — the shape of each keyframe pair, and that a
 * capture reshapes committed layout geometry without ever touching the DOM.
 */

import { describe, expect, it } from "bun:test";
import type { FoldFrameMotion, FoldRowMotion } from "./vlist-fold-animation";
import {
	captureFoldFrameGeometry,
	captureFoldGeometry,
	captureFoldNestedRows,
	foldRowKeyframes,
	frameKeyframes,
	nestedResizeKeyframes,
	revealKeyframes,
	shiftKeyframes,
} from "./vlist-fold-motion";

const shift: FoldRowMotion = { key: "b", kind: "shift", fromOffset: -200 };
const reveal: FoldRowMotion = { key: "card", kind: "reveal", fromInsetBottom: 200 };
const frame: FoldFrameMotion = {
	key: "run:t1",
	from: { top: 100, height: 240 },
	to: { top: 100, height: 440 },
};

describe("row keyframes", () => {
	it("inverts a shifted row's old offset and settles at the committed position", () => {
		const frames = shiftKeyframes(-200);
		expect(frames[0]?.transform).toBe("translateY(-200px)");
		expect(frames.at(-1)?.transform).toBe("translateY(0px)");
	});

	it("uncovers the toggled row inside its already-final box", () => {
		const frames = revealKeyframes(200);
		expect(frames[0]?.clipPath).toBe("inset(0px 0px 200px 0px)");
		expect(frames.at(-1)?.clipPath).toBe("inset(0px 0px 0px 0px)");
	});

	it("routes a planned motion to the right builder", () => {
		expect(foldRowKeyframes(shift)).toEqual(shiftKeyframes(-200));
		expect(foldRowKeyframes(reveal)).toEqual(revealKeyframes(200));
	});

	/**
	 * REGRESSION: no builder may write `opacity` on a row.
	 *
	 * A collapse fade shipped briefly and was a bug — a cross-fade masks a component
	 * SWAP (§4.7), and collapsing a card swaps nothing, so it made the unchanged header
	 * blink on every collapse. The row builders are `transform` / `clip-path` only.
	 */
	it("never writes opacity on a row motion", () => {
		for (const frames of [foldRowKeyframes(shift), foldRowKeyframes(reveal)]) {
			for (const keyframe of frames) {
				expect(keyframe).not.toHaveProperty("opacity");
			}
		}
	});

	it("animates only composited properties — never top/height", () => {
		// Animating layout properties would cost a layout pass per frame for the whole
		// canvas, and `height` could feed back into the measured geometry.
		for (const frames of [foldRowKeyframes(shift), foldRowKeyframes(reveal)]) {
			for (const keyframe of frames) {
				expect(keyframe).not.toHaveProperty("top");
				expect(keyframe).not.toHaveProperty("height");
				expect(keyframe).not.toHaveProperty("marginTop");
				expect(keyframe).not.toHaveProperty("paddingBottom");
			}
		}
	});
});

describe("nestedResizeKeyframes", () => {
	/**
	 * A drilled row's block IS the card, so closing it must animate the block's height —
	 * otherwise React commits the 18.8px summary height in frame one and the card, header
	 * included, vanishes instead of closing.
	 */
	it("travels from the card's height to the summary row's", () => {
		const frames = nestedResizeKeyframes(41, 18.8);
		expect(frames[0]).toEqual({ offset: 0, height: "41px" });
		expect(frames.at(-1)).toEqual({ offset: 1, height: "18.8px" });
	});

	it("ends on the COMMITTED height, so a cancel lands where React put it", () => {
		expect(nestedResizeKeyframes(205, 18.8).at(-1)).toMatchObject({ height: "18.8px" });
	});

	/**
	 * `scaleY` is not an alternative here: it would squash the card's text while it
	 * closes. `transform` must stay free anyway — the same node usually carries a
	 * concurrent `shift`, and one property per node per animation is what lets the two
	 * compose.
	 */
	it("writes height only — never transform or opacity", () => {
		for (const frame of nestedResizeKeyframes(41, 18.8)) {
			expect(frame).not.toHaveProperty("transform");
			expect(frame).not.toHaveProperty("opacity");
		}
	});
});

describe("frame keyframes", () => {
	it("travels from the box the reader last saw to the committed one", () => {
		const frames = frameKeyframes(frame);
		expect(frames[0]).toMatchObject({ top: "100px", height: "240px" });
		expect(frames.at(-1)).toMatchObject({ top: "100px", height: "440px" });
	});

	it("restates the committed geometry last, so a cancel lands where React put it", () => {
		expect(frameKeyframes(frame).at(-1)).toMatchObject({
			top: `${frame.to.top}px`,
			height: `${frame.to.height}px`,
		});
	});

	it("never writes transform — that would race the layout properties", () => {
		for (const keyframe of frameKeyframes(frame)) {
			expect(keyframe).not.toHaveProperty("transform");
		}
	});
});

describe("captureFoldGeometry", () => {
	it("reshapes the layout's own offsets, keyed by row key", () => {
		const geometry = captureFoldGeometry(["a", "b"], (index) =>
			index === 0 ? { top: 0, height: 100 } : { top: 104, height: 40 },
		);
		expect(geometry.get("a")).toEqual({ top: 0, height: 100 });
		expect(geometry.get("b")).toEqual({ top: 104, height: 40 });
	});

	it("skips a row the layout has no geometry for", () => {
		const geometry = captureFoldGeometry(["a", "b"], (index) =>
			index === 0 ? { top: 0, height: 100 } : undefined,
		);
		expect(geometry.has("b")).toBe(false);
		expect(geometry.size).toBe(1);
	});
});

describe("captureFoldNestedRows", () => {
	it("records each trace's rows by key, with their LOCAL tops and block heights", () => {
		const snapshot = captureFoldNestedRows(["act1", "plain"], (key) =>
			key === "act1"
				? [
						{ key: "r0", top: 22.8, blockHeight: 18.8 },
						// A drilled row: its block IS the card, hence the tall height.
						{ key: "r1", top: 41.6, blockHeight: 205 },
					]
				: undefined,
		);
		expect(snapshot.get("act1")?.rows.get("r0")).toEqual({ top: 22.8, height: 18.8 });
		// The height is what lets a drill-down be animated closed instead of unmounted.
		expect(snapshot.get("act1")?.rows.get("r1")).toEqual({ top: 41.6, height: 205 });
		// An element with no nested rows contributes no entry at all.
		expect(snapshot.has("plain")).toBe(false);
	});

	it("skips rows with an unusable key, top, or block height", () => {
		// The measured payload is trusted but not assumed: a row the layout could not
		// place has nothing honest to animate from.
		const snapshot = captureFoldNestedRows(["act1"], () => [
			{ key: "r0", top: 10, blockHeight: 18.8 },
			{ key: "r1", top: Number.NaN, blockHeight: 18.8 },
			{ key: "r2", top: 30, blockHeight: Number.NaN },
			{ key: undefined as unknown as string, top: 20, blockHeight: 18.8 },
		]);
		expect([...(snapshot.get("act1")?.rows.keys() ?? [])]).toEqual(["r0"]);
	});

	it("omits a trace whose every row was unusable", () => {
		const snapshot = captureFoldNestedRows(["act1"], () => [
			{ key: "r0", top: Number.POSITIVE_INFINITY, blockHeight: 18.8 },
		]);
		expect(snapshot.size).toBe(0);
	});
});

describe("captureFoldFrameGeometry", () => {
	it("spans the first member's top to the last member's bottom", () => {
		const boxes = [{ key: "run:t1", start: 1, end: 3 }];
		const frames = captureFoldFrameGeometry(boxes, (index) =>
			index === 1 ? { top: 100, bottom: 140 } : index === 3 ? { top: 200, bottom: 260 } : undefined,
		);
		expect(frames.get("run:t1")).toEqual({ top: 100, height: 160 });
	});

	it("skips a frame whose members have no geometry rather than approximating", () => {
		const frames = captureFoldFrameGeometry([{ key: "run:t1", start: 1, end: 9 }], (index) =>
			index === 1 ? { top: 100, bottom: 140 } : undefined,
		);
		expect(frames.size).toBe(0);
	});

	it("never reports a negative height", () => {
		const frames = captureFoldFrameGeometry([{ key: "run:t1", start: 0, end: 1 }], (index) =>
			index === 0 ? { top: 300, bottom: 340 } : { top: 100, bottom: 140 },
		);
		expect(frames.get("run:t1")?.height).toBe(0);
	});
});
