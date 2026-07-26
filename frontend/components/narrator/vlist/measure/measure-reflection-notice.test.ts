import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

// Install the deterministic canvas stub BEFORE importing any pretext-backed
// module (measure-reflection-notice prepares rich inline text at import-time use).
beforeAll(() => {
	installCanvasStub();
});

const RUNNING = {
	title: "Danger reflection running",
	kind: "danger_reflection" as const,
	status: "running" as const,
	hasTakeOver: true,
};

const RESOLVED = {
	title: "Danger reflection confirmed",
	kind: "danger_reflection" as const,
	status: "confirmed" as const,
};

describe("measureReflectionNotice", () => {
	it("measures a title-only notice as chrome + the icon column floor", async () => {
		const { measureReflectionNotice, MEASURE_REFLECTION_CONSTANTS: C } = await import(
			"./measure-reflection-notice"
		);
		const result = measureReflectionNotice(RESOLVED, 800);
		// A one-line xs title (16px) is shorter than the 22+1 icon column, so the
		// content box is floored by the icon rather than the text.
		expect(result.height).toBe(C.NOTICE_VERTICAL_CHROME + C.NOTICE_ICON_SIZE + 1);
		expect(result.blocks).toHaveLength(1);
		expect(result.metas.map((m) => m.role)).toEqual(["title"]);
	});

	it("reserves the takeover button row for a running gate", async () => {
		const { measureReflectionNotice, MEASURE_REFLECTION_CONSTANTS: C } = await import(
			"./measure-reflection-notice"
		);
		const running = measureReflectionNotice(RUNNING, 800);
		expect(running.hasTakeOver).toBe(true);
		expect(running.metas.map((m) => m.role)).toEqual(["title", "take-over"]);
		// title line + button mt + button, all past the icon floor now.
		const content =
			C.NOTICE_TITLE_LINE_HEIGHT + C.NOTICE_BUTTON_MARGIN_TOP + C.NOTICE_BUTTON_HEIGHT;
		expect(running.height).toBe(C.NOTICE_VERTICAL_CHROME + content);
	});

	it("keeps the running height after the gate resolves when asked to reserve", async () => {
		const { measureReflectionNotice } = await import("./measure-reflection-notice");
		const running = measureReflectionNotice(RUNNING, 800);
		// A resolved gate measured with reserveTakeOver keeps the running geometry,
		// so a WS-driven running → confirmed transition never shrinks the row.
		const resolvedReserved = measureReflectionNotice(RESOLVED, 800, { reserveTakeOver: true });
		expect(resolvedReserved.height).toBe(running.height);
		// …but the button is not PAINTED any more.
		expect(resolvedReserved.hasTakeOver).toBe(false);
		expect(resolvedReserved.metas.map((m) => m.role)).toEqual(["title", "take-over"]);
	});

	it("adds the summary and nextSteps rows with their mt=3 margins", async () => {
		const { measureReflectionNotice, MEASURE_REFLECTION_CONSTANTS: C } = await import(
			"./measure-reflection-notice"
		);
		const bare = measureReflectionNotice(RESOLVED, 800);
		const withSummary = measureReflectionNotice({ ...RESOLVED, summary: "short reason" }, 800);
		const withBoth = measureReflectionNotice(
			{ ...RESOLVED, summary: "short reason", nextSteps: "do the thing" },
			800,
		);
		expect(withSummary.metas.map((m) => m.role)).toEqual(["title", "summary"]);
		expect(withBoth.metas.map((m) => m.role)).toEqual(["title", "summary", "next-steps"]);
		// Adding one single-line body row costs exactly line + margin, once the
		// content box has grown past the icon floor.
		const bodyRow = C.NOTICE_BODY_LINE_HEIGHT + C.NOTICE_BODY_MARGIN_TOP;
		expect(withBoth.height - withSummary.height).toBe(bodyRow);
		expect(withSummary.height).toBeGreaterThan(bare.height);
	});

	it("wraps long text as the width shrinks (pretext arithmetic, zero DOM)", async () => {
		const { measureReflectionNotice, MEASURE_REFLECTION_CONSTANTS: C } = await import(
			"./measure-reflection-notice"
		);
		const summary =
			"a considerably longer reason that has to wrap onto several lines when the card is narrow";
		const wide = measureReflectionNotice({ ...RESOLVED, summary }, 1200);
		const mid = measureReflectionNotice({ ...RESOLVED, summary }, 600);
		const narrow = measureReflectionNotice({ ...RESOLVED, summary }, 400);
		expect(mid.height).toBeGreaterThan(wide.height);
		expect(narrow.height).toBeGreaterThan(mid.height);
		// The summary block itself grows in whole body line boxes. (The overall
		// height cannot be asserted that way: at very narrow widths the TITLE wraps
		// too, adding title-line boxes of a different size.)
		const summaryHeight = (m: typeof wide) => m.frame.blocks[1]!.height;
		expect(summaryHeight(wide)).toBe(C.NOTICE_BODY_LINE_HEIGHT);
		expect(summaryHeight(mid) % C.NOTICE_BODY_LINE_HEIGHT).toBe(0);
		expect(summaryHeight(narrow) % C.NOTICE_BODY_LINE_HEIGHT).toBe(0);
		expect(summaryHeight(narrow)).toBeGreaterThan(summaryHeight(mid));
	});

	it("wraps the title too when the card is very narrow", async () => {
		const { measureReflectionNotice, MEASURE_REFLECTION_CONSTANTS: C } = await import(
			"./measure-reflection-notice"
		);
		const wide = measureReflectionNotice(RESOLVED, 1200);
		const narrow = measureReflectionNotice(RESOLVED, 260);
		expect(wide.frame.blocks[0]!.height).toBe(C.NOTICE_TITLE_LINE_HEIGHT);
		expect(narrow.frame.blocks[0]!.height).toBe(C.NOTICE_TITLE_LINE_HEIGHT * 2);
	});

	it("reserves the icon column so text never wraps under the icon", async () => {
		const { measureReflectionNotice, MEASURE_REFLECTION_CONSTANTS: C } = await import(
			"./measure-reflection-notice"
		);
		const result = measureReflectionNotice(RESOLVED, 800);
		// Wrap width excludes the padding/border AND the icon lane.
		expect(result.contentWidth).toBe(800 - C.NOTICE_HORIZONTAL_CHROME - C.NOTICE_TEXT_INDENT);
		expect(result.usedWidth).toBe(800);
		// Text blocks are indented past the icon lane.
		expect(result.blocks[0]!.contentLeft).toBe(C.NOTICE_TEXT_INDENT);
	});

	it("keeps the external top margin out of the element height", async () => {
		const { measureReflectionNotice, MEASURE_REFLECTION_CONSTANTS: C } = await import(
			"./measure-reflection-notice"
		);
		const result = measureReflectionNotice(RESOLVED, 800);
		// The owner (tool card) adds this above the region; it is not baked in.
		expect(result.topMargin).toBe(C.NOTICE_TOP_MARGIN);
		expect(result.height).toBe(C.NOTICE_VERTICAL_CHROME + C.NOTICE_ICON_SIZE + 1);
	});

	it("degrades safely at absurdly narrow widths", async () => {
		const { measureReflectionNotice } = await import("./measure-reflection-notice");
		const result = measureReflectionNotice({ ...RESOLVED, summary: "x" }, 4);
		expect(Number.isFinite(result.height)).toBe(true);
		expect(result.height).toBeGreaterThan(0);
		expect(result.contentWidth).toBeGreaterThanOrEqual(1);
	});
});
