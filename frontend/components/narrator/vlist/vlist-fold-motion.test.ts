import { describe, expect, it } from "bun:test";
import { FOLD_DURATION_MS, type FoldRowMotion } from "./vlist-fold-animation";
import {
	captureFoldGeometry,
	createFoldMotionController,
	type FoldMotionTarget,
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

describe("prefersReducedMotion", () => {
	it("returns false where matchMedia is unavailable", () => {
		// linkedom provides no matchMedia; a missing capability must not disable folds.
		expect(prefersReducedMotion()).toBe(false);
	});
});
