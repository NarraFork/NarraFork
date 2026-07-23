import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

// Install the deterministic canvas stub BEFORE importing any pretext-backed
// module (measure-plan-card → measure-markdown → parse-markdown call pretext at
// prepare time).
beforeAll(() => {
	installCanvasStub();
});

describe("measurePlanCard", () => {
	it("adds fixed chrome (padding + border + header + mb) around the markdown body", async () => {
		const { measurePlanCard, planCardChrome } = await import("./measure-plan-card");
		const { measureMarkdown } = await import("./measure-markdown");
		const { PLAN_CARD_PADDING, PLAN_CARD_BORDER } = await import("./measure-plan-card");

		const summary = "Step one.";
		const contentWidth = 1000;
		const result = measurePlanCard({ summary }, contentWidth);

		// Body is measured at the inner width (content minus padding + border).
		const innerWidth = contentWidth - PLAN_CARD_PADDING * 2 - PLAN_CARD_BORDER * 2;
		const body = measureMarkdown(summary, innerWidth);

		expect(result.contentWidth).toBe(innerWidth);
		// Total height = fixed chrome + markdown body content height.
		expect(result.height).toBe(planCardChrome(false) + body.frame.contentHeight);
	});

	it("chrome equals padding×2 + border×2 + header + mb (no actions)", async () => {
		const { measurePlanCard, planCardChrome, planCardHeaderHeight } = await import(
			"./measure-plan-card"
		);
		const { PLAN_CARD_PADDING, PLAN_CARD_BORDER, PLAN_HEADER_MB } = await import(
			"./measure-plan-card"
		);

		const expectedChrome =
			PLAN_CARD_PADDING * 2 + PLAN_CARD_BORDER * 2 + planCardHeaderHeight(false) + PLAN_HEADER_MB;
		expect(planCardChrome(false)).toBe(expectedChrome);

		// A single short line: whole card = chrome + one body line height.
		const { MARKDOWN_CONSTANTS } = await import("../parse-markdown");
		const result = measurePlanCard({ summary: "Hello." }, 1000);
		expect(result.height).toBe(expectedChrome + MARKDOWN_CONSTANTS.BODY_LINE_HEIGHT);
	});

	it("markdown body wraps to more lines (taller card) as width shrinks", async () => {
		const { measurePlanCard } = await import("./measure-plan-card");
		const { MARKDOWN_CONSTANTS } = await import("../parse-markdown");

		const summary = "one two three four five six seven eight nine ten eleven twelve";
		const wide = measurePlanCard({ summary }, 2000);
		const narrow = measurePlanCard({ summary }, 120);

		// Wide: single body line. Narrow: strictly taller (wrapped).
		expect(narrow.height).toBeGreaterThan(wide.height);
		// The delta is an integer number of extra body lines.
		const delta = narrow.height - wide.height;
		expect(delta % MARKDOWN_CONSTANTS.BODY_LINE_HEIGHT).toBe(0);
		expect(delta).toBeGreaterThan(0);
	});

	it("multi-paragraph markdown adds inter-block margins inside the body", async () => {
		const { measurePlanCard } = await import("./measure-plan-card");
		const { MARKDOWN_CONSTANTS } = await import("../parse-markdown");

		const one = measurePlanCard({ summary: "First paragraph." }, 1000);
		const two = measurePlanCard({ summary: "First paragraph.\n\nSecond paragraph." }, 1000);

		// Second card is taller by exactly one body line + one paragraph margin.
		// (PARAGRAPH_MARGIN_TOP = 0.35em @14px = 4.9px → float, use toBeCloseTo.)
		expect(two.height - one.height).toBeCloseTo(
			MARKDOWN_CONSTANTS.BODY_LINE_HEIGHT + MARKDOWN_CONSTANTS.PARAGRAPH_MARGIN_TOP,
			5,
		);
	});

	it("header height grows when action buttons are present (compact-xs=18 > icon/label)", async () => {
		const { planCardHeaderHeight, planCardChrome } = await import("./measure-plan-card");
		const { PLAN_HEADER_ICON, PLAN_HEADER_LABEL_LINE, PLAN_HEADER_BUTTON } = await import(
			"./measure-plan-card"
		);

		const noActions = planCardHeaderHeight(false);
		const withActions = planCardHeaderHeight(true);

		expect(noActions).toBe(Math.max(PLAN_HEADER_ICON, PLAN_HEADER_LABEL_LINE));
		expect(withActions).toBe(
			Math.max(PLAN_HEADER_ICON, PLAN_HEADER_LABEL_LINE, PLAN_HEADER_BUTTON),
		);
		// compact-xs button (18) is the tallest → header (and chrome) grows.
		expect(withActions).toBeGreaterThan(noActions);
		expect(planCardChrome(true)).toBeGreaterThan(planCardChrome(false));
	});

	it("hasActions flag increases total card height by the header delta", async () => {
		const { measurePlanCard, planCardHeaderHeight } = await import("./measure-plan-card");

		const summary = "Do the thing.";
		const plain = measurePlanCard({ summary, hasActions: false }, 1000);
		const acting = measurePlanCard({ summary, hasActions: true }, 1000);

		const headerDelta = planCardHeaderHeight(true) - planCardHeaderHeight(false);
		expect(acting.height - plain.height).toBe(headerDelta);
	});

	it("usedWidth includes the Paper padding + border around the body", async () => {
		const { measurePlanCard } = await import("./measure-plan-card");
		const { measureMarkdown } = await import("./measure-markdown");
		const { PLAN_CARD_PADDING, PLAN_CARD_BORDER } = await import("./measure-plan-card");

		const summary = "short line";
		const contentWidth = 1000;
		const result = measurePlanCard({ summary }, contentWidth);
		const innerWidth = contentWidth - PLAN_CARD_PADDING * 2 - PLAN_CARD_BORDER * 2;
		const body = measureMarkdown(summary, innerWidth);

		expect(result.usedWidth).toBe(body.usedWidth + PLAN_CARD_PADDING * 2 + PLAN_CARD_BORDER * 2);
	});
});
