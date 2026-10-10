/**
 * Tests for the axis-restriction modifiers.
 *
 * These lock the claim the module exists for: both are equivalent to the ones
 * shipped by `@dnd-kit/modifiers`, so a future dnd-kit upgrade cannot silently
 * change behaviour without one of these failing.
 */

import { describe, expect, test } from "bun:test";
import type { Modifier } from "@dnd-kit/core";
import type { Transform } from "@dnd-kit/utilities";
import { restrictToHorizontalAxis, restrictToVerticalAxis } from "./dnd-modifiers";

/**
 * The full argument bag `Modifier` receives. Nothing outside `transform` is read by
 * either modifier, but the type requires all of it, and supplying it is what keeps
 * this test honest about the real call signature.
 */
function modifierArgs(transform: Transform): Parameters<Modifier>[0] {
	return {
		transform,
		activatorEvent: null,
		active: null,
		activeNodeRect: null,
		draggingNodeRect: null,
		containerNodeRect: null,
		over: null,
		overlayNodeRect: null,
		scrollableAncestors: [],
		scrollableAncestorRects: [],
		windowRect: null,
	};
}

describe("restrictToVerticalAxis", () => {
	test("zeroes horizontal movement and preserves the vertical axis", () => {
		const result = restrictToVerticalAxis(modifierArgs({ x: 42, y: -7, scaleX: 1, scaleY: 1 }));

		expect(result).toEqual({ x: 0, y: -7, scaleX: 1, scaleY: 1 });
	});

	test("preserves scale factors", () => {
		const result = restrictToVerticalAxis(modifierArgs({ x: 10, y: 20, scaleX: 1.5, scaleY: 2 }));

		expect(result.scaleX).toBe(1.5);
		expect(result.scaleY).toBe(2);
	});

	test("is a no-op for movement that is already vertical", () => {
		const result = restrictToVerticalAxis(modifierArgs({ x: 0, y: 33, scaleX: 1, scaleY: 1 }));

		expect(result).toEqual({ x: 0, y: 33, scaleX: 1, scaleY: 1 });
	});
});

describe("restrictToHorizontalAxis", () => {
	test("zeroes vertical movement and preserves the horizontal axis", () => {
		const result = restrictToHorizontalAxis(modifierArgs({ x: 42, y: -7, scaleX: 1, scaleY: 1 }));

		expect(result).toEqual({ x: 42, y: 0, scaleX: 1, scaleY: 1 });
	});
});
