import { beforeAll, describe, expect, test } from "bun:test";
import { installCanvasStub } from "../vlist/measure/test-canvas-stub";
import {
	HEADER_CLOSE_WIDTH_PX,
	HEADER_LEADING_GAP_PX,
	HEADER_PIN_WIDTH_PX,
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

	test("chrome arithmetic pins the DOM model (no double-counted row gap)", () => {
		// chrome = pad32 + back22+gap8 + actions44 + rowGap8 + overflow22 = 136
		// remaining = 520 − 136 − 200 = 184; each tool costs 22+10=32 → 5 tools, slack 24
		const layout = resolveHeaderLayoutAfterTitle({
			rowWidth: 520,
			titleFullWidth,
			showBack: true,
			showTitleActions: true,
			surfacedToolCount: 10,
			showClose: false,
		});
		expect(layout.visibleToolCount).toBe(5);
		expect(layout.overflowToolCount).toBe(5);
		expect(layout.slackPx).toBe(24);

		// With close: chrome += gap10 + close22 → 168; remaining=152 → 4 tools, slack 24
		const withClose = resolveHeaderLayoutAfterTitle({
			rowWidth: 520,
			titleFullWidth,
			showBack: true,
			showTitleActions: true,
			surfacedToolCount: 10,
			showClose: true,
		});
		expect(withClose.visibleToolCount).toBe(4);
		expect(withClose.slackPx).toBe(24);
	});

	test("host pin reserves exactly 28px plus its gap without inflating the sm close", () => {
		const input = {
			rowWidth: 520,
			titleFullWidth,
			showBack: true,
			showTitleActions: true,
			surfacedToolCount: 10,
			showClose: true,
		};
		const plain = resolveHeaderLayoutAfterTitle(input);
		const pinned = resolveHeaderLayoutAfterTitle({ ...input, showPin: true });
		expect(HEADER_CLOSE_WIDTH_PX).toBe(22);
		expect(HEADER_PIN_WIDTH_PX).toBe(28);
		expect(pinned.titleWidth).toBe(titleFullWidth);
		expect(pinned.visibleToolCount).toBe(3);
		expect(pinned.slackPx).toBe(18);
		// Removing tools adds back 32px each; the pin independently costs 28+10.
		expect(
			plain.slackPx + (plain.visibleToolCount - pinned.visibleToolCount) * 32 - pinned.slackPx,
		).toBe(HEADER_PIN_WIDTH_PX + HEADER_TOOLBAR_GAP_PX);
		expect(resolveHeaderLayoutAfterTitle({ ...input, showClose: false, showPin: true })).toEqual(
			resolveHeaderLayoutAfterTitle({ ...input, showClose: false }),
		);
	});

	test("pin and close fit after the full title by collapsing tools first", () => {
		const input = {
			titleFullWidth,
			showBack: true,
			showTitleActions: true,
			surfacedToolCount: 10,
			showClose: true,
			showPin: true,
		};
		// chrome206 + title200 + three 32px tools: exact fit, no inflated close.
		expect(resolveHeaderLayoutAfterTitle({ ...input, rowWidth: 502 })).toMatchObject({
			titleWidth: titleFullWidth,
			visibleToolCount: 3,
			slackPx: 0,
		});
		expect(resolveHeaderLayoutAfterTitle({ ...input, rowWidth: 501 })).toMatchObject({
			titleWidth: titleFullWidth,
			visibleToolCount: 2,
			slackPx: 31,
		});
		const narrow = resolveHeaderLayoutAfterTitle({ ...input, rowWidth: 350 });
		expect(narrow.titleWidth).toBe(144);
		expect(narrow.visibleToolCount).toBe(0);
		expect(narrow.titleWidth + 206).toBe(350);
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

	test("rowWidth 0 (unmeasured) shows all tools and is not a no-room shortfall", () => {
		const pending = resolveHeaderLayoutAfterTitle({
			rowWidth: 0,
			titleFullWidth,
			surfacedToolCount: 6,
		});
		expect(pending.titleWidth).toBe(titleFullWidth);
		expect(pending.visibleToolCount).toBe(6);
		expect(pending.overflowToolCount).toBe(0);
		expect(pending.unmeasured).toBe(true);
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
