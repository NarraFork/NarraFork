import { beforeAll, describe, expect, test } from "bun:test";
import { installCanvasStub } from "../vlist/measure/test-canvas-stub";
import {
	HEADER_LEADING_GAP_PX,
	HEADER_ROW_PADDING_PX,
	HEADER_TITLE_TEXT_FALLBACK_PX,
	HEADER_TITLE_TEXT_MAX_PX,
	HEADER_TITLE_TEXT_MIN_PX,
	HEADER_TOOLBAR_GAP_PX,
	headerTitleFont,
	headerTitleLayoutWidth,
	measureHeaderTitleTextWidth,
	resolveHeaderLayoutAfterTitle,
} from "./header-title-width";

let restoreCanvas: (() => void) | undefined;

beforeAll(() => {
	restoreCanvas = installCanvasStub({ widthRatio: 0.6 });
	return () => restoreCanvas?.();
});

describe("header title pretext width", () => {
	test("measures COMPLETE title text; never from a truncated string", () => {
		expect(headerTitleFont()).toContain("500");
		expect(headerTitleFont()).toContain("14px");
		const full = "按钮显示空间未充分利用";
		const w = measureHeaderTitleTextWidth(full);
		expect(w).toBeGreaterThan(0);
		// Same function on the full string is the layout input.
		expect(headerTitleLayoutWidth(full)).toBe(w);
		expect(headerTitleLayoutWidth("")).toBe(0);
		expect(HEADER_TITLE_TEXT_FALLBACK_PX).toBeGreaterThan(0);
	});

	test("layout soft-caps only pathological lengths", () => {
		expect(headerTitleLayoutWidth("x".repeat(400))).toBe(HEADER_TITLE_TEXT_MAX_PX);
	});
});

describe("resolveHeaderLayoutAfterTitle — tools fit AFTER full title", () => {
	const titleFullWidth = 200;

	test("title keeps COMPLETE measured width; tools get only the remainder", () => {
		// Mid row: full title reserved first, tools take the rest.
		const mid = resolveHeaderLayoutAfterTitle({
			rowWidth: 520,
			titleFullWidth,
			showBack: true,
			showTitleActions: true,
			surfacedToolCount: 10,
			showClose: false,
		});
		expect(mid.titleWidth).toBe(titleFullWidth);
		expect(mid.visibleToolCount).toBeGreaterThan(0);
		expect(mid.visibleToolCount).toBeLessThan(10);
		expect(mid.overflowToolCount).toBe(10 - mid.visibleToolCount);
	});

	test("narrow row still prioritizes title over tools", () => {
		const narrow = resolveHeaderLayoutAfterTitle({
			rowWidth: 320,
			titleFullWidth,
			showBack: true,
			showTitleActions: true,
			surfacedToolCount: 8,
			showClose: false,
		});
		// Title may floor when chrome + full text exceed the row, but it must stay
		// near full width — tools collapse first, never the reverse.
		expect(narrow.titleWidth).toBeGreaterThanOrEqual(HEADER_TITLE_TEXT_MIN_PX);
		expect(narrow.titleWidth).toBeLessThanOrEqual(titleFullWidth);
		expect(narrow.titleWidth).toBeGreaterThan(titleFullWidth * 0.7);
		expect(narrow.visibleToolCount).toBeLessThanOrEqual(2);
	});

	test("chrome constants stay unique enough for answers-style layout math", () => {
		expect(HEADER_TITLE_TEXT_MIN_PX).toBeGreaterThan(0);
		expect(HEADER_LEADING_GAP_PX).toBe(8);
		expect(HEADER_TOOLBAR_GAP_PX).toBe(10);
		expect(HEADER_ROW_PADDING_PX).toBe(32);
	});

	test("rowWidth 0 (unmeasured) shows full title and defers tools", () => {
		const pending = resolveHeaderLayoutAfterTitle({
			rowWidth: 0,
			titleFullWidth,
			surfacedToolCount: 6,
		});
		expect(pending.titleWidth).toBe(titleFullWidth);
		expect(pending.visibleToolCount).toBe(0);
		expect(pending.overflowToolCount).toBe(6);
	});

	test("zero surfaced tools still reserves the full title", () => {
		const none = resolveHeaderLayoutAfterTitle({
			rowWidth: 400,
			titleFullWidth,
			showBack: true,
			showTitleActions: true,
			surfacedToolCount: 0,
		});
		expect(none.titleWidth).toBe(titleFullWidth);
		expect(none.visibleToolCount).toBe(0);
	});
});
