import { describe, expect, it } from "bun:test";
import type { DrillMorphPlan } from "./vlist-drill-morph";
import {
	createDrillMorphController,
	type DrillMorphNode,
	playDrillMorph,
	prefersReducedMotion,
} from "./vlist-drill-morph-motion";

interface FakeAnimation {
	keyframes: Keyframe[];
	options: KeyframeAnimationOptions;
	cancelled: boolean;
}

function fakeNode(): DrillMorphNode & { animations: FakeAnimation[] } {
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

function plan(rowUid: string, kind: "expand" | "collapse", driftY: number): DrillMorphPlan {
	return { rowUid, kind, driftY, durationMs: 200 };
}

describe("playDrillMorph", () => {
	it("slides + fades the incoming line home from the outgoing line's position", () => {
		const incoming = fakeNode();
		playDrillMorph(plan("t::r0", "expand", 11.1), incoming);
		const frames = incoming.animations[0]?.keyframes ?? [];
		expect(frames[0]).toMatchObject({ opacity: 0, transform: "translateY(-11.1px)" });
		expect(frames.at(-1)).toMatchObject({ opacity: 1, transform: "translateY(0px)" });
	});

	it("reverses the drift on collapse", () => {
		const incoming = fakeNode();
		playDrillMorph(plan("t::r0", "collapse", -11.1), incoming);
		expect(incoming.animations[0]?.keyframes[0]).toMatchObject({ transform: "translateY(11.1px)" });
	});

	it("animates only composited properties — never top/height", () => {
		const incoming = fakeNode();
		playDrillMorph(plan("t::r0", "expand", 11.1), incoming);
		for (const frame of incoming.animations[0]?.keyframes ?? []) {
			expect(frame).not.toHaveProperty("top");
			expect(frame).not.toHaveProperty("height");
		}
	});

	it("retains nothing: fill is none so an interrupted morph reads the committed style", () => {
		const incoming = fakeNode();
		playDrillMorph(plan("t::r0", "expand", 11.1), incoming);
		expect(incoming.animations[0]?.options.fill).toBe("none");
		expect(incoming.animations[0]?.options.duration).toBe(200);
		expect(incoming.animations[0]?.options.easing).toBe("ease");
	});

	it("degrades silently without a node, without WAAPI, or when animate throws", () => {
		expect(playDrillMorph(plan("t::r0", "expand", 11.1), null)).toBeNull();
		expect(playDrillMorph(plan("t::r0", "expand", 11.1), {})).toBeNull();
		expect(
			playDrillMorph(plan("t::r0", "expand", 11.1), {
				animate: () => {
					throw new Error("unsupported");
				},
			}),
		).toBeNull();
	});
});

describe("createDrillMorphController — multi-activity", () => {
	it("plays EVERY planned row, each on its own node (stacked activity)", () => {
		const controller = createDrillMorphController();
		const a = fakeNode();
		const b = fakeNode();
		const nodes = new Map([
			["t::r0", a],
			["t::r1", b],
		]);
		controller.playAll([plan("t::r0", "expand", 11.1), plan("t::r1", "expand", 11.1)], (uid) =>
			nodes.get(uid),
		);
		expect(a.animations).toHaveLength(1);
		expect(b.animations).toHaveLength(1);
	});

	it("cancels ONLY the same row's stale morph — other rows keep playing", () => {
		const controller = createDrillMorphController();
		const a = fakeNode();
		const b = fakeNode();
		const nodes = new Map([
			["t::r0", a],
			["t::r1", b],
		]);
		controller.playAll([plan("t::r0", "expand", 11.1), plan("t::r1", "expand", 11.1)], (uid) =>
			nodes.get(uid),
		);
		// Re-toggle row r0 mid-flight: only r0's animation is cancelled, r1's survives.
		controller.playAll([plan("t::r0", "collapse", -11.1)], (uid) => nodes.get(uid));
		expect(a.animations[0]?.cancelled).toBe(true);
		expect(a.animations[1]?.cancelled).toBe(false);
		expect(b.animations[0]?.cancelled).toBe(false);
	});

	it("cancel() stops every row's morph and is idempotent", () => {
		const controller = createDrillMorphController();
		const a = fakeNode();
		const b = fakeNode();
		const nodes = new Map([
			["t::r0", a],
			["t::r1", b],
		]);
		controller.playAll([plan("t::r0", "expand", 11.1), plan("t::r1", "expand", 11.1)], (uid) =>
			nodes.get(uid),
		);
		controller.cancel();
		controller.cancel();
		expect(a.animations[0]?.cancelled).toBe(true);
		expect(b.animations[0]?.cancelled).toBe(true);
	});

	it("skips rows whose node is not mounted, without dropping the rest", () => {
		const controller = createDrillMorphController();
		const b = fakeNode();
		controller.playAll([plan("t::r0", "expand", 11.1), plan("t::r1", "expand", 11.1)], (uid) =>
			uid === "t::r1" ? b : null,
		);
		expect(b.animations).toHaveLength(1);
	});
});

describe("prefersReducedMotion", () => {
	it("returns false where matchMedia is unavailable", () => {
		expect(prefersReducedMotion()).toBe(false);
	});
});
