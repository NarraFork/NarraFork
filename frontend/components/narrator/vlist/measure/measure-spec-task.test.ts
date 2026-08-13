import { beforeAll, describe, expect, it } from "bun:test";
import {
	measureSpecTask,
	SPEC_TASK_GLYPH,
	SPEC_TASK_GLYPH_GAP,
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
 * The regression this pins: `measureInjectionBubble` overwrites the composite's
 * `contentWidth` with its own INNER width, so a render copy that used
 * `measured.contentWidth` as the text-column width and then placed the glyph/lock
 * lanes beside it produced a row `chromeWidth` wider than the frame — the task text
 * spilled past the bubble's right edge. The render layer must re-derive the text
 * column with `specTaskChromeWidth`, which is exactly what this asserts.
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
			// And it agrees with what the measure pass wrapped the text at.
			expect(measureSpecTask(data, innerWidth).contentWidth).toBe(renderTextWidth);
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

	it("the text column is what's left after the glyph lane", () => {
		const m = measureSpecTask({ text: "x", protected: false }, 600);
		expect(m.contentWidth).toBe(600 - (SPEC_TASK_GLYPH + SPEC_TASK_GLYPH_GAP));
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
