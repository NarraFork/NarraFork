import { describe, expect, it } from "bun:test";
import type { LodMorphPlan } from "./vlist-lod-morph";
import {
	createLodMorphController,
	type LodMorphNode,
	playLodMorph,
	prefersReducedMotion,
} from "./vlist-lod-morph-motion";

interface FakeAnimation {
	keyframes: Keyframe[];
	options: KeyframeAnimationOptions;
	cancelled: boolean;
}

function fakeNode(): LodMorphNode & { animations: FakeAnimation[] } {
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

/** A plain MOVE (same component at both levels): slides, does not fade. */
function plan(unitId: string, deltaY: number): LodMorphPlan {
	return { unitId, deltaY, fade: false, durationMs: 250 };
}

/** A RE-THEME (the component was swapped): slides and cross-fades. */
function swapPlan(unitId: string, deltaY: number): LodMorphPlan {
	return { unitId, deltaY, fade: true, durationMs: 250 };
}

describe("playLodMorph", () => {
	it("slides the new node from the old element's screen position", () => {
		const node = fakeNode();
		playLodMorph(plan("tool-a", -200), node);
		const frames = node.animations[0]?.keyframes ?? [];
		expect(frames[0]).toMatchObject({ transform: "translateY(-200px)" });
		expect(frames.at(-1)).toMatchObject({ transform: "translateY(0px)" });
	});

	it("cross-fades a re-theme, so the component swap is masked", () => {
		const node = fakeNode();
		playLodMorph(swapPlan("tool-a", -200), node);
		const frames = node.animations[0]?.keyframes ?? [];
		expect(frames[0]).toMatchObject({ opacity: 0, transform: "translateY(-200px)" });
		expect(frames.at(-1)).toMatchObject({ opacity: 1, transform: "translateY(0px)" });
	});

	/**
	 * A body that merely moved keeps its component and its content, so fading it makes
	 * unchanged prose blink once per zoom step. `opacity` must be ABSENT rather than
	 * pinned to 1: writing it hands the property to the animation for the duration,
	 * which is a needless composited layer on a node whose opacity never changes.
	 */
	it("writes no opacity at all for a plain move", () => {
		const node = fakeNode();
		playLodMorph(plan("m1-b0", -200), node);
		for (const frame of node.animations[0]?.keyframes ?? []) {
			expect(frame).not.toHaveProperty("opacity");
		}
	});

	/**
	 * The planner emits `deltaY: 0, fade: true` for a re-theme whose travel had to be
	 * dropped — an activity fold that swapped the component in place, or a nested row
	 * whose start box fell outside its clip. Writing a `translateY(0px)` pair there
	 * hands `transform` to the animation (and thus a composited layer) for nothing.
	 */
	it("fades in place without touching transform when deltaY is 0", () => {
		const node = fakeNode();
		playLodMorph(swapPlan("tool-a", 0), node);
		const frames = node.animations[0]?.keyframes ?? [];
		expect(frames[0]).toEqual({ offset: 0, opacity: 0 });
		expect(frames.at(-1)).toEqual({ offset: 1, opacity: 1 });
		for (const frame of frames) {
			expect(frame).not.toHaveProperty("transform");
		}
	});

	it("animates only composited properties — never top/height/scaleY", () => {
		const node = fakeNode();
		playLodMorph(plan("tool-a", -200), node);
		for (const frame of node.animations[0]?.keyframes ?? []) {
			expect(frame).not.toHaveProperty("top");
			expect(frame).not.toHaveProperty("height");
			expect(frame).not.toHaveProperty("scaleY");
		}
	});

	it("retains nothing: fill is none", () => {
		const node = fakeNode();
		playLodMorph(plan("tool-a", -200), node);
		expect(node.animations[0]?.options.fill).toBe("none");
		expect(node.animations[0]?.options.duration).toBe(250);
		expect(node.animations[0]?.options.easing).toBe("ease");
	});

	it("degrades silently without a node / WAAPI / a throwing animate", () => {
		expect(playLodMorph(plan("a", 1), null)).toBeNull();
		expect(playLodMorph(plan("a", 1), {})).toBeNull();
		expect(
			playLodMorph(plan("a", 1), {
				animate: () => {
					throw new Error("unsupported");
				},
			}),
		).toBeNull();
	});
});

describe("createLodMorphController — multi-activity, one frame", () => {
	it("plays EVERY planned morph, each on its own node", () => {
		const controller = createLodMorphController();
		const a = fakeNode();
		const b = fakeNode();
		const nodes = new Map([
			["tool-a", a],
			["tool-b", b],
		]);
		controller.playAll([plan("tool-a", -200), plan("tool-b", 150)], (uid) => nodes.get(uid));
		expect(a.animations).toHaveLength(1);
		expect(b.animations).toHaveLength(1);
		expect(a.animations[0]?.keyframes[0]).toMatchObject({ transform: "translateY(-200px)" });
		expect(b.animations[0]?.keyframes[0]).toMatchObject({ transform: "translateY(150px)" });
	});

	it("cancels ONLY the same unitId's stale morph (a rapid re-zoom)", () => {
		const controller = createLodMorphController();
		const a = fakeNode();
		const b = fakeNode();
		const nodes = new Map([
			["tool-a", a],
			["tool-b", b],
		]);
		controller.playAll([plan("tool-a", -200), plan("tool-b", 150)], (uid) => nodes.get(uid));
		controller.playAll([plan("tool-a", -80)], (uid) => nodes.get(uid));
		expect(a.animations[0]?.cancelled).toBe(true);
		expect(a.animations[1]?.cancelled).toBe(false);
		expect(b.animations[0]?.cancelled).toBe(false);
	});

	it("cancel() stops every morph and is idempotent", () => {
		const controller = createLodMorphController();
		const a = fakeNode();
		controller.playAll([plan("tool-a", -200)], () => a);
		controller.cancel();
		controller.cancel();
		expect(a.animations[0]?.cancelled).toBe(true);
	});

	it("skips morphs whose node is not mounted, without dropping the rest", () => {
		const controller = createLodMorphController();
		const b = fakeNode();
		controller.playAll([plan("tool-a", -200), plan("tool-b", 150)], (uid) =>
			uid === "tool-b" ? b : null,
		);
		expect(b.animations).toHaveLength(1);
	});
});

describe("prefersReducedMotion", () => {
	it("returns false where matchMedia is unavailable", () => {
		expect(prefersReducedMotion()).toBe(false);
	});
});
