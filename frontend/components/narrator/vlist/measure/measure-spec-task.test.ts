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
