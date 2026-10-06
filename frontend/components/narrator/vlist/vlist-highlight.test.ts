import { describe, expect, it } from "bun:test";
import {
	createHighlightController,
	flashHighlight,
	HIGHLIGHT_DURATION_MS,
	type HighlightTarget,
} from "./vlist-highlight";

interface FakeAnimation {
	keyframes: Keyframe[];
	options: KeyframeAnimationOptions;
	cancelled: boolean;
}

function fakeElement(): HighlightTarget & { animations: FakeAnimation[] } {
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

describe("flashHighlight", () => {
	it("animates the element once with the default duration", () => {
		const element = fakeElement();
		const handle = flashHighlight(element);
		expect(handle).not.toBeNull();
		expect(element.animations).toHaveLength(1);
		expect(element.animations[0]?.options.duration).toBe(HIGHLIGHT_DURATION_MS);
	});

	it("animates OUTLINE, never background — the row keeps its own colour", () => {
		const element = fakeElement();
		flashHighlight(element);
		const keyframes = element.animations[0]?.keyframes ?? [];
		expect(keyframes.length).toBeGreaterThan(0);
		for (const frame of keyframes) {
			expect(frame).toHaveProperty("outline");
			expect(frame).not.toHaveProperty("backgroundColor");
			expect(frame).not.toHaveProperty("background");
		}
	});

	it("touches no layout-affecting property", () => {
		const element = fakeElement();
		flashHighlight(element);
		const layoutProps = [
			"height",
			"width",
			"padding",
			"paddingTop",
			"paddingBottom",
			"margin",
			"marginTop",
			"marginBottom",
			"border",
			"borderWidth",
			"borderRadius",
			"top",
			"transform",
		];
		for (const frame of element.animations[0]?.keyframes ?? []) {
			for (const prop of layoutProps) expect(frame).not.toHaveProperty(prop);
		}
	});

	it("starts and ends fully transparent so nothing is retained", () => {
		const element = fakeElement();
		flashHighlight(element);
		const keyframes = element.animations[0]?.keyframes ?? [];
		expect(String(keyframes.at(0)?.outline)).toContain("transparent");
		expect(String(keyframes.at(-1)?.outline)).toContain("transparent");
		// `fill: none` is what guarantees the final frame is not left as an inline style.
		expect(element.animations[0]?.options.fill).toBe("none");
	});

	it("honours an explicit duration", () => {
		const element = fakeElement();
		flashHighlight(element, 300);
		expect(element.animations[0]?.options.duration).toBe(300);
	});

	it("returns null without throwing when the element is missing", () => {
		expect(flashHighlight(null)).toBeNull();
		expect(flashHighlight(undefined)).toBeNull();
	});

	it("returns null when the environment has no Web Animations support", () => {
		expect(flashHighlight({})).toBeNull();
	});

	it("returns null when animate() throws", () => {
		const element: HighlightTarget = {
			animate: () => {
				throw new Error("unsupported keyframe");
			},
		};
		expect(flashHighlight(element)).toBeNull();
	});

	it("returns null when animate() yields nothing", () => {
		expect(flashHighlight({ animate: () => undefined })).toBeNull();
	});
});

describe("createHighlightController", () => {
	it("cancels the previous flash before starting a new one", () => {
		const controller = createHighlightController();
		const first = fakeElement();
		const second = fakeElement();
		controller.flash(first);
		controller.flash(second);
		expect(first.animations[0]?.cancelled).toBe(true);
		expect(second.animations[0]?.cancelled).toBe(false);
	});

	it("re-flashes the SAME element (a repeated jump must be visible)", () => {
		const controller = createHighlightController();
		const element = fakeElement();
		controller.flash(element);
		controller.flash(element);
		expect(element.animations).toHaveLength(2);
		expect(element.animations[0]?.cancelled).toBe(true);
		expect(element.animations[1]?.cancelled).toBe(false);
	});

	it("cancel() stops the running flash and is idempotent", () => {
		const controller = createHighlightController();
		const element = fakeElement();
		controller.flash(element);
		controller.cancel();
		controller.cancel();
		expect(element.animations[0]?.cancelled).toBe(true);
	});

	it("survives an unsupported element without breaking later flashes", () => {
		const controller = createHighlightController();
		controller.flash({});
		const element = fakeElement();
		controller.flash(element);
		expect(element.animations).toHaveLength(1);
	});
});
