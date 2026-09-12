import { beforeAll, describe, expect, it } from "bun:test";
import {
	measureSpecTask,
	SPEC_TASK_LINE_HEIGHT,
	SPEC_TASK_LOCK,
	SPEC_TASK_LOCK_GAP,
	specTaskChromeWidth,
} from "./measure-spec-task";
import { installCanvasStub } from "./test-canvas-stub";

// Install the deterministic canvas stub BEFORE any pretext-backed measure runs
// (measureSpecTask prepares a rich-inline flow at prepare time).
beforeAll(() => {
	installCanvasStub();
});

/**
 * The regression this pins: the measure pass and render pass must agree on the
 * meaning of `contentWidth`. It is the bubble's INNER width; RenderSpecTask then
 * subtracts the per-row glyph/lock chrome. Returning an already-reduced text
 * column made render subtract the chrome twice, so the precomputed height was based
 * on a wider column than the DOM painted and the task text was clipped.
 */
describe("spec task row fits inside the bubble's inner width", () => {
	for (const isProtected of [false, true]) {
		it(`chrome + text column never exceeds the inner width (protected=${isProtected})`, () => {
			const innerWidth = 420;
			const data = { text: "a reasonably long continuation task text", protected: isProtected };
			const chrome = specTaskChromeWidth(data);
			// What the render layer computes for the text column.
			const renderTextWidth = Math.max(1, innerWidth - chrome);
			expect(chrome + renderTextWidth).toBeLessThanOrEqual(innerWidth);
			// The measure pass exposes the bubble inner width; the renderer derives the
			// same text column from it once, so both sides use the same geometry.
			expect(measureSpecTask(data, innerWidth).contentWidth).toBe(innerWidth);
		});
	}

	it("degenerate widths still leave a positive text column", () => {
		const data = { text: "x", protected: true };
		// Narrower than the chrome itself: the column floors at 1px rather than going
		// negative, which would make the flex child collapse or overflow.
		expect(measureSpecTask(data, 4).contentWidth).toBeGreaterThan(0);
	});
});

describe("measureSpecTask — glyph + lock + wrapping text", () => {
	it("a short task fits a single line", () => {
		const m = measureSpecTask({ text: "short", protected: false }, 600);
		expect(m.height).toBe(SPEC_TASK_LINE_HEIGHT);
	});

	it("an empty task still reserves one line (no zero-height hole)", () => {
		const m = measureSpecTask({ text: "", protected: false }, 600);
		expect(m.height).toBe(SPEC_TASK_LINE_HEIGHT);
	});

	it("a long task wraps beyond one line instead of clamping", () => {
		const long = "word ".repeat(400);
		const m = measureSpecTask({ text: long, protected: false }, 200);
		expect(m.height).toBeGreaterThan(SPEC_TASK_LINE_HEIGHT);
	});

	it("contentWidth remains the bubble inner width for render-time chrome subtraction", () => {
		const m = measureSpecTask({ text: "x", protected: false }, 600);
		expect(m.contentWidth).toBe(600);
	});

	it("protected adds the lock lane to the chrome width", () => {
		const open = specTaskChromeWidth({ text: "x", protected: false });
		const locked = specTaskChromeWidth({ text: "x", protected: true });
		expect(locked - open).toBe(SPEC_TASK_LOCK + SPEC_TASK_LOCK_GAP);
	});

	it("a protected task wraps within the narrower text column", () => {
		const long = "word ".repeat(400);
		const open = measureSpecTask({ text: long, protected: false }, 300);
		const locked = measureSpecTask({ text: long, protected: true }, 300);
		// The lock eats text width, so the protected task wraps to at least as many lines.
		expect(locked.height).toBeGreaterThanOrEqual(open.height);
	});

	it("a blocked task measures identically (tone is render-only, not geometry)", () => {
		const data = { text: "blocked task", protected: false };
		const plain = measureSpecTask(data, 400);
		const blocked = measureSpecTask({ ...data, blocked: true }, 400);
		expect(blocked.height).toBe(plain.height);
		expect(blocked.contentWidth).toBe(plain.contentWidth);
	});
});
