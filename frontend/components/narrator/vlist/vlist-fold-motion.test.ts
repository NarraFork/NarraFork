import { describe, expect, it } from "bun:test";
import { FOLD_DURATION_MS, type FoldFrameMotion, type FoldRowMotion } from "./vlist-fold-animation";
import {
	captureFoldFrameGeometry,
	captureFoldGeometry,
	createFoldMotionController,
	type FoldMotionTarget,
	playFoldFrameMotion,
	playFoldMotion,
	prefersReducedMotion,
} from "./vlist-fold-motion";

interface FakeAnimation {
	keyframes: Keyframe[];
	options: KeyframeAnimationOptions;
	cancelled: boolean;
}

function fakeNode(): FoldMotionTarget & { animations: FakeAnimation[] } {
	const animations: FakeAnimation[] = [];
	return {
		animations,
		animate(keyframes, options) {
			const animation: FakeAnimation = { keyframes, options, cancelled: false };
			animations.push(animation);
			return {
				cancel: () => {
					animation.cancelled = true;
				},
			};
		},
	};
}

const shift: FoldRowMotion = { key: "b", kind: "shift", fromOffset: -200 };
const reveal: FoldRowMotion = { key: "card", kind: "reveal", fromInsetBottom: 200 };
const frame: FoldFrameMotion = {
	key: "run:t1",
	from: { top: 100, height: 240 },
	to: { top: 100, height: 440 },
};

describe("playFoldMotion", () => {
	it("inverts a shifted row's old offset and settles at the committed position", () => {
		const node = fakeNode();
		expect(playFoldMotion(node, shift)).not.toBeNull();
		const frames = node.animations[0]?.keyframes ?? [];
		expect(frames[0]?.transform).toBe("translateY(-200px)");
		expect(frames.at(-1)?.transform).toBe("translateY(0px)");
	});

	it("animates only composited properties — never top/height", () => {
		// Animating layout properties would cost a layout pass per frame for the whole
		// canvas, and `height` could feed back into the measured geometry.
		const node = fakeNode();
		playFoldMotion(node, shift);
		playFoldMotion(node, reveal);
		for (const animation of node.animations) {
			for (const frame of animation.keyframes) {
				expect(frame).not.toHaveProperty("top");
				expect(frame).not.toHaveProperty("height");
				expect(frame).not.toHaveProperty("marginTop");
				expect(frame).not.toHaveProperty("paddingBottom");
			}
		}
	});

	it("uncovers the toggled row inside its already-final box", () => {
		const node = fakeNode();
		playFoldMotion(node, reveal);
		const frames = node.animations[0]?.keyframes ?? [];
		expect(frames[0]?.clipPath).toBe("inset(0px 0px 200px 0px)");
		expect(frames.at(-1)?.clipPath).toBe("inset(0px 0px 0px 0px)");
	});

	it("retains nothing: fill is none so an interrupted fold reads the committed style", () => {
		const node = fakeNode();
		playFoldMotion(node, shift);
		expect(node.animations[0]?.options.fill).toBe("none");
		expect(node.animations[0]?.options.duration).toBe(FOLD_DURATION_MS);
	});

	it("honours an explicit duration", () => {
		const node = fakeNode();
		playFoldMotion(node, shift, 90);
		expect(node.animations[0]?.options.duration).toBe(90);
	});

	it("degrades silently without a node, without WAAPI, or when animate throws", () => {
		expect(playFoldMotion(null, shift)).toBeNull();
		expect(playFoldMotion(undefined, shift)).toBeNull();
		expect(playFoldMotion({}, shift)).toBeNull();
		expect(
			playFoldMotion(
				{
					animate: () => {
						throw new Error("unsupported keyframe");
					},
				},
				shift,
			),
		).toBeNull();
		expect(playFoldMotion({ animate: () => undefined }, shift)).toBeNull();
	});
});

describe("playFoldFrameMotion", () => {
	it("travels the frame's box from where the reader saw it to the committed one", () => {
		const node = fakeNode();
		expect(playFoldFrameMotion(node, frame)).not.toBeNull();
		const frames = node.animations[0]?.keyframes ?? [];
		expect(frames[0]).toMatchObject({ top: "100px", height: "240px" });
		expect(frames.at(-1)).toMatchObject({ top: "100px", height: "440px" });
	});

	it("animates layout properties, NOT a transform", () => {
		// The deliberate exception to the row rule: `scaleY` on a box whose visible
		// substance is a 1px border smears that border and its radius. The frame is
		// absolutely positioned decoration with no in-flow siblings and no measured
		// height, so writing its top/height cannot reflow or perturb anything.
		const node = fakeNode();
		playFoldFrameMotion(node, frame);
		for (const keyframe of node.animations[0]?.keyframes ?? []) {
			expect(keyframe).not.toHaveProperty("transform");
			expect(keyframe).not.toHaveProperty("clipPath");
		}
	});

	it("ends on the committed geometry so a cancel lands where React put it", () => {
		const node = fakeNode();
		playFoldFrameMotion(node, frame);
		expect(node.animations[0]?.options.fill).toBe("none");
		expect(node.animations[0]?.keyframes.at(-1)).toMatchObject({
			top: `${frame.to.top}px`,
			height: `${frame.to.height}px`,
		});
	});

	it("honours an explicit duration and shares the row easing", () => {
		const rowNode = fakeNode();
		const frameNode = fakeNode();
		playFoldMotion(rowNode, shift, 90);
		playFoldFrameMotion(frameNode, frame, 90);
		expect(frameNode.animations[0]?.options.duration).toBe(90);
		// A border decelerating differently from its own contents would read as two
		// separate movements, which is the whole artifact being fixed.
		expect(frameNode.animations[0]?.options.easing).toBe(rowNode.animations[0]?.options.easing);
	});

	it("degrades silently without a node, without WAAPI, or when animate throws", () => {
		expect(playFoldFrameMotion(null, frame)).toBeNull();
		expect(playFoldFrameMotion(undefined, frame)).toBeNull();
		expect(playFoldFrameMotion({}, frame)).toBeNull();
		expect(
			playFoldFrameMotion(
				{
					animate: () => {
						throw new Error("unsupported keyframe");
					},
				},
				frame,
			),
		).toBeNull();
		expect(playFoldFrameMotion({ animate: () => undefined }, frame)).toBeNull();
	});
});

describe("createFoldMotionController", () => {
	it("plays every planned row, resolving each key to its mounted node", () => {
		const controller = createFoldMotionController();
		const card = fakeNode();
		const below = fakeNode();
		const nodes = new Map<string, FoldMotionTarget>([
			["card", card],
			["b", below],
		]);
		controller.play([reveal, shift], (key) => nodes.get(key) ?? null);
		expect(card.animations).toHaveLength(1);
		expect(below.animations).toHaveLength(1);
	});

	it("composes a reveal and a shift on the SAME node without cancelling either", () => {
		// Expanding at the bottom plans both for the toggled row. They animate different
		// properties (clip-path vs transform) so WAAPI composes them; cancelling one to
		// start the other would drop half the movement.
		const controller = createFoldMotionController();
		const card = fakeNode();
		controller.play([reveal, { key: "card", kind: "shift", fromOffset: 200 }], () => card);
		expect(card.animations).toHaveLength(2);
		expect(card.animations.map((a) => a.cancelled)).toEqual([false, false]);
		expect(card.animations[0]?.keyframes[0]).toHaveProperty("clipPath");
		expect(card.animations[1]?.keyframes[0]).toHaveProperty("transform");
	});

	it("skips rows that are no longer mounted", () => {
		const controller = createFoldMotionController();
		const card = fakeNode();
		controller.play([reveal, shift], (key) => (key === "card" ? card : null));
		expect(card.animations).toHaveLength(1);
	});

	it("cancels the previous fold so two animations never fight over one transform", () => {
		const controller = createFoldMotionController();
		const node = fakeNode();
		controller.play([shift], () => node);
		controller.play([shift], () => node);
		expect(node.animations[0]?.cancelled).toBe(true);
		expect(node.animations[1]?.cancelled).toBe(false);
	});

	it("plays rows and grouping frames in the same call", () => {
		const controller = createFoldMotionController();
		const row = fakeNode();
		const border = fakeNode();
		controller.play(
			[shift],
			() => row,
			undefined,
			[frame],
			() => border,
		);
		expect(row.animations).toHaveLength(1);
		expect(border.animations).toHaveLength(1);
	});

	it("cancels a frame together with its rows, never one without the other", () => {
		// A border still animating after its contents were cancelled (or vice versa) is
		// exactly the detachment this transition exists to remove, so both must share
		// one cancel boundary.
		const controller = createFoldMotionController();
		const row = fakeNode();
		const border = fakeNode();
		const resolveRow = () => row;
		const resolveFrame = () => border;
		controller.play([shift], resolveRow, undefined, [frame], resolveFrame);
		controller.play([shift], resolveRow, undefined, [frame], resolveFrame);
		expect(row.animations[0]?.cancelled).toBe(true);
		expect(border.animations[0]?.cancelled).toBe(true);
		expect(row.animations[1]?.cancelled).toBe(false);
		expect(border.animations[1]?.cancelled).toBe(false);
	});

	it("plays rows normally when no frames are supplied", () => {
		const controller = createFoldMotionController();
		const row = fakeNode();
		controller.play([shift], () => row);
		expect(row.animations).toHaveLength(1);
	});

	it("skips frames whose node is no longer mounted", () => {
		const controller = createFoldMotionController();
		const row = fakeNode();
		controller.play(
			[shift],
			() => row,
			undefined,
			[frame],
			() => null,
		);
		expect(row.animations).toHaveLength(1);
	});

	it("cancel() stops everything in flight and is idempotent", () => {
		const controller = createFoldMotionController();
		const card = fakeNode();
		const below = fakeNode();
		const nodes = new Map<string, FoldMotionTarget>([
			["card", card],
			["b", below],
		]);
		controller.play([reveal, shift], (key) => nodes.get(key) ?? null);
		controller.cancel();
		controller.cancel();
		expect(card.animations[0]?.cancelled).toBe(true);
		expect(below.animations[0]?.cancelled).toBe(true);
	});

	it("survives an unsupported node without dropping the rest of the fold", () => {
		const controller = createFoldMotionController();
		const good = fakeNode();
		controller.play([reveal, shift], (key) => (key === "card" ? {} : good));
		expect(good.animations).toHaveLength(1);
	});
});

describe("captureFoldGeometry", () => {
	it("reshapes the layout's own offsets — no DOM measurement", () => {
		const items = [
			{ top: 0, height: 100 },
			{ top: 104, height: 40 },
		];
		const captured = captureFoldGeometry(["a", "card"], (index) => items[index]);
		expect(captured.get("a")).toEqual({ top: 0, height: 100 });
		expect(captured.get("card")).toEqual({ top: 104, height: 40 });
	});

	it("skips keys the layout has no geometry for", () => {
		const captured = captureFoldGeometry(["a", "missing"], (index) =>
			index === 0 ? { top: 0, height: 10 } : undefined,
		);
		expect([...captured.keys()]).toEqual(["a"]);
	});
});

describe("captureFoldFrameGeometry", () => {
	it("spans a frame from its first member's top to its last member's bottom", () => {
		// The same derivation the render pass uses. Deriving it here is what keeps the
		// captured "before" and the committed "after" provably consistent.
		const items = [
			{ top: 0, bottom: 100 },
			{ top: 104, bottom: 200 },
			{ top: 204, bottom: 340 },
		];
		const captured = captureFoldFrameGeometry(
			[{ key: "run:t1", start: 1, end: 2 }],
			(index) => items[index],
		);
		expect(captured.get("run:t1")).toEqual({ top: 104, height: 236 });
	});

	it("skips a frame whose members the layout has no geometry for", () => {
		// With no box there is nothing honest to animate from; the plan's
		// "present in both maps" rule then leaves it where the rebuild put it.
		const captured = captureFoldFrameGeometry(
			[
				{ key: "run:ok", start: 0, end: 0 },
				{ key: "run:partial", start: 0, end: 9 },
				{ key: "run:gone", start: 7, end: 9 },
			],
			(index) => (index === 0 ? { top: 0, bottom: 40 } : undefined),
		);
		expect([...captured.keys()]).toEqual(["run:ok"]);
	});

	it("never reports a negative height", () => {
		const captured = captureFoldFrameGeometry([{ key: "run:t1", start: 0, end: 1 }], (index) =>
			index === 0 ? { top: 100, bottom: 200 } : { top: 0, bottom: 40 },
		);
		expect(captured.get("run:t1")).toEqual({ top: 100, height: 0 });
	});
});

describe("prefersReducedMotion", () => {
	/**
	 * Install a `matchMedia` stub for one assertion and restore whatever was there.
	 *
	 * `window` itself may be absent (this file runs without a DOM), so the stub also
	 * has to be able to create and remove the global — otherwise the reduced-motion
	 * branch below could only ever be reached in a DOM-ful test file.
	 */
	function withMatchMedia(matches: boolean | Error, run: () => void): void {
		const globals = globalThis as { window?: unknown };
		const hadWindow = "window" in globals;
		const previousWindow = globals.window;
		const existing = hadWindow ? (previousWindow as { matchMedia?: unknown }) : undefined;
		const hadMatchMedia = existing != null && "matchMedia" in existing;
		const previousMatchMedia = existing?.matchMedia;
		const matchMedia = () => {
			if (matches instanceof Error) throw matches;
			return { matches };
		};
		if (existing) (existing as { matchMedia?: unknown }).matchMedia = matchMedia;
		else globals.window = { matchMedia };
		try {
			run();
		} finally {
			if (!hadWindow) delete globals.window;
			else if (existing) {
				if (hadMatchMedia) (existing as { matchMedia?: unknown }).matchMedia = previousMatchMedia;
				else delete (existing as { matchMedia?: unknown }).matchMedia;
			}
		}
	}

	it("returns false where matchMedia is unavailable", () => {
		// linkedom provides no matchMedia; a missing capability must not disable folds.
		expect(prefersReducedMotion()).toBe(false);
	});

	it("reports TRUE when the OS asks for reduced motion", () => {
		// The half that actually suppresses the transition, and the half no test covered:
		// `captureFoldBefore` skips its capture on this answer, so the play effect finds
		// nothing and the fold applies as the committed geometry. A silent regression here
		// (an inverted read, a swallowed `.matches`) would animate for readers who asked
		// the OS not to, with every other fold test still green.
		withMatchMedia(true, () => {
			expect(prefersReducedMotion()).toBe(true);
		});
	});

	it("reports false when the OS does NOT ask for reduced motion", () => {
		withMatchMedia(false, () => {
			expect(prefersReducedMotion()).toBe(false);
		});
	});

	it("falls back to animating when matchMedia throws", () => {
		// A malformed-query rejection must not be read as "reduce": that would disable
		// the transition everywhere rather than in the one place it is asked for.
		withMatchMedia(new Error("unsupported media query"), () => {
			expect(prefersReducedMotion()).toBe(false);
		});
	});
});
