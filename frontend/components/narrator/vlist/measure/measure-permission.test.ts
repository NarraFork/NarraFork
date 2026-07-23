import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

// Install the deterministic canvas stub BEFORE importing any pretext-backed
// module (measure-permission calls prepareRichInline at prepare time).
beforeAll(() => {
	installCanvasStub();
});

// A short header/label that never wraps at a wide width (deterministic stub:
// each char = 0.6 × fontSize, so ~8 chars @ 14px ≈ 67px ≪ any test width).
const SHORT = "OK";

function q(header: string, options: Array<{ label: string; description?: string }> = []) {
	return { header, options };
}

// ─────────────────────────────────────────────────────────────────────────────
// AskUserQuestionBanner
// ─────────────────────────────────────────────────────────────────────────────

describe("measureAskUserQuestion — chrome + linear growth", () => {
	it("a single question with no options = Alert chrome + header + textarea + buttons", async () => {
		const { measureAskUserQuestion, MEASURE_PERMISSION_CONSTANTS } = await import(
			"./measure-permission"
		);
		const c = MEASURE_PERMISSION_CONSTANTS;
		const r = measureAskUserQuestion({ questions: [q(SHORT)] }, 600);
		// chrome + header(20) + gap(10)+textarea(30) + gap(16)+buttons(30)
		const expected =
			c.ALERT_VERTICAL_CHROME +
			c.HEADER_LINE_HEIGHT +
			(c.QUESTION_STACK_GAP + (1 * c.TEXTAREA_ROW_HEIGHT + c.XS_TEXTAREA_CHROME)) +
			(c.ALERT_STACK_GAP + c.ASK_BUTTON_ROW_HEIGHT);
		expect(r.height).toBe(expected);
		// blocks: header, textarea, buttons.
		expect(r.metas.map((m) => m.role)).toEqual(["header", "ask-textarea", "buttons"]);
	});

	it("height grows linearly with the number of questions", async () => {
		const { measureAskUserQuestion } = await import("./measure-permission");
		const one = measureAskUserQuestion({ questions: [q(SHORT)] }, 600);
		const two = measureAskUserQuestion({ questions: [q(SHORT), q(SHORT)] }, 600);
		const three = measureAskUserQuestion({ questions: [q(SHORT), q(SHORT), q(SHORT)] }, 600);
		const d1 = two.height - one.height;
		const d2 = three.height - two.height;
		// Each extra question adds the same block: gap + header + gap + textarea.
		expect(d1).toBe(d2);
		expect(d1).toBeGreaterThan(0);
	});

	it("height grows with the number of options (each adds one label line + gap)", async () => {
		const { measureAskUserQuestion, MEASURE_PERMISSION_CONSTANTS } = await import(
			"./measure-permission"
		);
		const c = MEASURE_PERMISSION_CONSTANTS;
		const zero = measureAskUserQuestion({ questions: [q(SHORT)] }, 600);
		const oneOpt = measureAskUserQuestion({ questions: [q(SHORT, [{ label: SHORT }])] }, 600);
		const twoOpt = measureAskUserQuestion(
			{ questions: [q(SHORT, [{ label: SHORT }, { label: SHORT }])] },
			600,
		);
		// First option replaces nothing; it inserts a label line separated from the
		// header by the question Stack gap.
		expect(oneOpt.height - zero.height).toBe(c.QUESTION_STACK_GAP + c.OPTION_LABEL_LINE_HEIGHT);
		// Each subsequent option adds a label line + the tighter options gap (4).
		expect(twoOpt.height - oneOpt.height).toBe(c.OPTIONS_GAP + c.OPTION_LABEL_LINE_HEIGHT);
	});

	it("an option description adds exactly its line + the description margin", async () => {
		const { measureAskUserQuestion, MEASURE_PERMISSION_CONSTANTS } = await import(
			"./measure-permission"
		);
		const c = MEASURE_PERMISSION_CONSTANTS;
		const noDesc = measureAskUserQuestion({ questions: [q(SHORT, [{ label: SHORT }])] }, 600);
		const withDesc = measureAskUserQuestion(
			{ questions: [q(SHORT, [{ label: SHORT, description: SHORT }])] },
			600,
		);
		expect(withDesc.height - noDesc.height).toBe(
			c.OPTION_DESC_MARGIN_TOP + c.OPTION_DESC_LINE_HEIGHT,
		);
		expect(withDesc.metas.map((m) => m.role)).toContain("option-desc");
	});

	it("tags options as checkbox controls when multiSelect, radio otherwise", async () => {
		const { measureAskUserQuestion } = await import("./measure-permission");
		const radio = measureAskUserQuestion(
			{ questions: [{ header: SHORT, options: [{ label: SHORT }], multiSelect: false }] },
			600,
		);
		const check = measureAskUserQuestion(
			{ questions: [{ header: SHORT, options: [{ label: SHORT }], multiSelect: true }] },
			600,
		);
		expect(radio.metas.find((m) => m.role === "option-label")?.control).toBe("radio");
		expect(check.metas.find((m) => m.role === "option-label")?.control).toBe("checkbox");
	});
});

describe("measureAskUserQuestion — wrapping (pretext, zero DOM)", () => {
	it("a long header wraps into more lines as the width shrinks", async () => {
		const { measureAskUserQuestion } = await import("./measure-permission");
		const longHeader =
			"this is a fairly long question header that will certainly wrap onto multiple visual lines once the alert gets narrow";
		const wide = measureAskUserQuestion({ questions: [q(longHeader)] }, 2000);
		const narrow = measureAskUserQuestion({ questions: [q(longHeader)] }, 200);
		expect(narrow.height).toBeGreaterThan(wide.height);
	});

	it("a long option label wraps and grows the height in label-line multiples", async () => {
		const { measureAskUserQuestion, MEASURE_PERMISSION_CONSTANTS } = await import(
			"./measure-permission"
		);
		const c = MEASURE_PERMISSION_CONSTANTS;
		const longLabel = "word ".repeat(30).trim();
		const wide = measureAskUserQuestion({ questions: [q(SHORT, [{ label: longLabel }])] }, 2000);
		const narrow = measureAskUserQuestion({ questions: [q(SHORT, [{ label: longLabel }])] }, 200);
		const delta = narrow.height - wide.height;
		expect(delta).toBeGreaterThan(0);
		// The delta is entirely extra label lines → a multiple of the label line box.
		expect(delta % c.OPTION_LABEL_LINE_HEIGHT).toBe(0);
	});

	it("option label wrap width accounts for the control indent", async () => {
		const { measureAskUserQuestion, MEASURE_PERMISSION_CONSTANTS } = await import(
			"./measure-permission"
		);
		const c = MEASURE_PERMISSION_CONSTANTS;
		expect(c.OPTION_INDENT).toBe(c.OPTION_CONTROL_SIZE + c.OPTION_LABEL_OFFSET);
		// The option-label block carries the indent as its contentLeft.
		const r = measureAskUserQuestion({ questions: [q(SHORT, [{ label: SHORT }])] }, 600);
		const optIndex = r.metas.findIndex((m) => m.role === "option-label");
		expect(r.blocks[optIndex]?.contentLeft).toBe(c.OPTION_INDENT);
	});
});

describe("measureAskUserQuestion — Textarea autosize rows", () => {
	it("the custom-input textarea grows with its autosize row count (clamped 1..3)", async () => {
		const { measureAskUserQuestion, MEASURE_PERMISSION_CONSTANTS } = await import(
			"./measure-permission"
		);
		const c = MEASURE_PERMISSION_CONSTANTS;
		const oneRow = measureAskUserQuestion(
			{ questions: [{ ...q(SHORT), customInputRows: 1 }] },
			600,
		);
		const threeRow = measureAskUserQuestion(
			{ questions: [{ ...q(SHORT), customInputRows: 3 }] },
			600,
		);
		expect(threeRow.height - oneRow.height).toBe(2 * c.TEXTAREA_ROW_HEIGHT);
		// Beyond 3 rows the textarea is clamped, so no further growth.
		const fiveRow = measureAskUserQuestion(
			{ questions: [{ ...q(SHORT), customInputRows: 5 }] },
			600,
		);
		expect(fiveRow.height).toBe(threeRow.height);
	});

	it("suppresses the custom-input textarea when hasCustomInput is false", async () => {
		const { measureAskUserQuestion } = await import("./measure-permission");
		const withInput = measureAskUserQuestion({ questions: [q(SHORT)] }, 600);
		const without = measureAskUserQuestion(
			{ questions: [{ ...q(SHORT), hasCustomInput: false }] },
			600,
		);
		expect(without.metas.map((m) => m.role)).not.toContain("ask-textarea");
		expect(without.height).toBeLessThan(withInput.height);
	});
});

describe("measureAskUserQuestion — read-only mode", () => {
	it("drops the textarea, countdown and buttons; keeps header + options", async () => {
		const { measureAskUserQuestion } = await import("./measure-permission");
		const ro = measureAskUserQuestion(
			{ questions: [q(SHORT, [{ label: SHORT }])], readOnly: true, hasCountdown: true },
			600,
		);
		const roles = ro.metas.map((m) => m.role);
		expect(roles).not.toContain("ask-textarea");
		expect(roles).not.toContain("countdown");
		expect(roles).not.toContain("buttons");
		expect(roles).toContain("header");
		expect(roles).toContain("option-label");
		expect(ro.readOnly).toBe(true);
	});

	it("shows the saved custom answer + an answered badge when present", async () => {
		const { measureAskUserQuestion, MEASURE_PERMISSION_CONSTANTS } = await import(
			"./measure-permission"
		);
		const c = MEASURE_PERMISSION_CONSTANTS;
		const bare = measureAskUserQuestion({ questions: [q(SHORT)], readOnly: true }, 600);
		const answered = measureAskUserQuestion(
			{
				questions: [{ ...q(SHORT), savedCustomAnswer: SHORT, hasSavedAnswer: true }],
				readOnly: true,
			},
			600,
		);
		const roles = answered.metas.map((m) => m.role);
		expect(roles).toContain("custom-answer");
		expect(roles).toContain("answered-badge");
		// The answered card is taller by: gap + answer line + gap + badge.
		expect(answered.height - bare.height).toBe(
			c.QUESTION_STACK_GAP + c.CUSTOM_ANSWER_LINE_HEIGHT + c.QUESTION_STACK_GAP + c.BADGE_XS_HEIGHT,
		);
	});
});

describe("measureAskUserQuestion — countdown + full-width + reusable measurer", () => {
	it("adds the countdown row only when armed and interactive", async () => {
		const { measureAskUserQuestion, MEASURE_PERMISSION_CONSTANTS } = await import(
			"./measure-permission"
		);
		const c = MEASURE_PERMISSION_CONSTANTS;
		const noCd = measureAskUserQuestion({ questions: [q(SHORT)] }, 600);
		const cd = measureAskUserQuestion({ questions: [q(SHORT)], hasCountdown: true }, 600);
		expect(cd.metas.map((m) => m.role)).toContain("countdown");
		expect(cd.height - noCd.height).toBe(c.ALERT_STACK_GAP + c.COUNTDOWN_ROW_HEIGHT);
	});

	it("is a full-width block (usedWidth == outer width) and re-measures on resize", async () => {
		const { measureAskUserQuestion, prepareAskUserQuestionMeasurer } = await import(
			"./measure-permission"
		);
		const r = measureAskUserQuestion({ questions: [q(SHORT)] }, 640);
		expect(r.usedWidth).toBe(640);
		expect(r.outerWidth).toBe(640);

		const measure = prepareAskUserQuestionMeasurer({
			questions: [q("a recurring header phrase repeated enough to wrap when narrow")],
		});
		const wide = measure(2000);
		const narrow = measure(160);
		expect(narrow.height).toBeGreaterThanOrEqual(wide.height);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// InlinePermission
// ─────────────────────────────────────────────────────────────────────────────

describe("measureInlinePermission — minimal + button bar", () => {
	it("minimal interactive form = feedback textarea + button bar (no top margin baked in)", async () => {
		const { measureInlinePermission, MEASURE_PERMISSION_CONSTANTS } = await import(
			"./measure-permission"
		);
		const c = MEASURE_PERMISSION_CONSTANTS;
		const r = measureInlinePermission({}, 600);
		expect(r.metas.map((m) => m.role)).toEqual(["feedback-textarea", "button-bar"]);
		// feedback(30) + mb(10) + button bar(36).
		expect(r.height).toBe(
			1 * c.TEXTAREA_ROW_HEIGHT +
				c.XS_TEXTAREA_CHROME +
				c.FEEDBACK_MARGIN_BOTTOM +
				c.PERM_BUTTON_ROW_HEIGHT,
		);
		// The Box mt="xs" is external and reported, not folded into height.
		expect(r.topMargin).toBe(c.INLINE_PERMISSION_TOP_MARGIN);
	});

	it("the button bar grows with wrapped button rows", async () => {
		const { measureInlinePermission, MEASURE_PERMISSION_CONSTANTS } = await import(
			"./measure-permission"
		);
		const c = MEASURE_PERMISSION_CONSTANTS;
		const oneRow = measureInlinePermission({ buttonCount: 2, buttonRows: 1 }, 600);
		const twoRows = measureInlinePermission({ buttonCount: 4, buttonRows: 2 }, 600);
		expect(twoRows.height - oneRow.height).toBe(c.PERM_BUTTON_ROW_HEIGHT + c.PERM_BUTTON_GROUP_GAP);
	});
});

describe("measureInlinePermission — execution target", () => {
	it("adds the execution-target Paper with a cwd line by default", async () => {
		const { measureInlinePermission, MEASURE_PERMISSION_CONSTANTS, executionTargetHeight } =
			await import("./measure-permission");
		const c = MEASURE_PERMISSION_CONSTANTS;
		const none = measureInlinePermission({}, 600);
		const withTarget = measureInlinePermission({ hasExecutionTarget: true }, 600);
		expect(withTarget.metas.map((m) => m.role)).toContain("exec-target");
		// The delta is the paper (cwd=1, path=0) + its bottom margin.
		expect(withTarget.height - none.height).toBe(
			executionTargetHeight(1, 0) + c.TARGET_MARGIN_BOTTOM,
		);
	});

	it("execution-target height grows with cwd + path lines and drops the header margin when bare", async () => {
		const { executionTargetHeight, MEASURE_PERMISSION_CONSTANTS } = await import(
			"./measure-permission"
		);
		const c = MEASURE_PERMISSION_CONSTANTS;
		// No detail lines → no header bottom margin.
		expect(executionTargetHeight(0, 0)).toBe(
			c.TARGET_PADDING * 2 + c.TARGET_BORDER * 2 + c.TARGET_HEADER_ROW,
		);
		// One cwd line → + header margin + one xs line.
		expect(executionTargetHeight(1, 0)).toBe(
			c.TARGET_PADDING * 2 +
				c.TARGET_BORDER * 2 +
				c.TARGET_HEADER_ROW +
				c.TARGET_HEADER_MARGIN +
				c.XS_LINE_HEIGHT,
		);
		// Additional path lines add one xs line each.
		expect(executionTargetHeight(1, 2) - executionTargetHeight(1, 0)).toBe(2 * c.XS_LINE_HEIGHT);
	});
});

describe("measureInlinePermission — ExitPlanMode editing", () => {
	it("adds the plan-edit textarea (clamped 8..30 rows) while editing", async () => {
		const { measureInlinePermission, MEASURE_PERMISSION_CONSTANTS, planTextareaHeight } =
			await import("./measure-permission");
		const c = MEASURE_PERMISSION_CONSTANTS;
		const editing8 = measureInlinePermission(
			{ isExitPlanMode: true, isEditingPlan: true, planEditRows: 8 },
			600,
		);
		const editing20 = measureInlinePermission(
			{ isExitPlanMode: true, isEditingPlan: true, planEditRows: 20 },
			600,
		);
		expect(editing8.metas.map((m) => m.role)).toContain("plan-textarea");
		// 8 rows is the minimum; 20 rows is 12 rows taller.
		expect(editing20.height - editing8.height).toBe(12 * c.TEXTAREA_ROW_HEIGHT);
		// Below the minimum the textarea clamps to 8 rows.
		const editing2 = measureInlinePermission(
			{ isExitPlanMode: true, isEditingPlan: true, planEditRows: 2 },
			600,
		);
		expect(editing2.height).toBe(editing8.height);
		expect(planTextareaHeight(2)).toBe(planTextareaHeight(8));
	});

	it("shows the plan-edited badge only when edited and not editing", async () => {
		const { measureInlinePermission } = await import("./measure-permission");
		const edited = measureInlinePermission(
			{ isExitPlanMode: true, planEdited: true, isEditingPlan: false },
			600,
		);
		const editing = measureInlinePermission(
			{ isExitPlanMode: true, planEdited: true, isEditingPlan: true },
			600,
		);
		expect(edited.metas.map((m) => m.role)).toContain("plan-edited-badge");
		// While editing the badge is hidden (the textarea is shown instead).
		expect(editing.metas.map((m) => m.role)).not.toContain("plan-edited-badge");
		expect(editing.metas.map((m) => m.role)).toContain("plan-textarea");
	});
});

describe("measureInlinePermission — feedback rows, decision reason, read-only", () => {
	it("the feedback textarea grows with its autosize row count (clamped 1..3)", async () => {
		const { measureInlinePermission, MEASURE_PERMISSION_CONSTANTS } = await import(
			"./measure-permission"
		);
		const c = MEASURE_PERMISSION_CONSTANTS;
		const one = measureInlinePermission({ feedbackRows: 1 }, 600);
		const three = measureInlinePermission({ feedbackRows: 3 }, 600);
		expect(three.height - one.height).toBe(2 * c.TEXTAREA_ROW_HEIGHT);
		const five = measureInlinePermission({ feedbackRows: 5 }, 600);
		expect(five.height).toBe(three.height);
	});

	it("adds decision-reason lines above the feedback textarea", async () => {
		const { measureInlinePermission, MEASURE_PERMISSION_CONSTANTS } = await import(
			"./measure-permission"
		);
		const c = MEASURE_PERMISSION_CONSTANTS;
		const none = measureInlinePermission({}, 600);
		const twoLines = measureInlinePermission(
			{ hasDecisionReason: true, decisionReasonLines: 2 },
			600,
		);
		expect(twoLines.metas.map((m) => m.role)).toContain("decision-reason");
		// 2 reason lines + the reason bottom margin.
		expect(twoLines.height - none.height).toBe(
			2 * c.XS_LINE_HEIGHT + c.DECISION_REASON_MARGIN_BOTTOM,
		);
	});

	it("read-only mode replaces the button bar with a single unavailable line", async () => {
		const { measureInlinePermission, MEASURE_PERMISSION_CONSTANTS } = await import(
			"./measure-permission"
		);
		const c = MEASURE_PERMISSION_CONSTANTS;
		const ro = measureInlinePermission({ readOnly: true }, 600);
		const roles = ro.metas.map((m) => m.role);
		expect(roles).toContain("readonly-note");
		expect(roles).not.toContain("button-bar");
		expect(ro.readOnly).toBe(true);
		// feedback(30) + mb(10) + readonly note(17).
		expect(ro.height).toBe(
			1 * c.TEXTAREA_ROW_HEIGHT +
				c.XS_TEXTAREA_CHROME +
				c.FEEDBACK_MARGIN_BOTTOM +
				c.READONLY_NOTE_HEIGHT,
		);
	});

	it("prepareInlinePermissionMeasurer re-measures at the same height (fixed rows)", async () => {
		const { prepareInlinePermissionMeasurer } = await import("./measure-permission");
		const measure = prepareInlinePermissionMeasurer({ hasExecutionTarget: true, feedbackRows: 2 });
		const a = measure(600);
		const b = measure(320);
		// All rows are fixed-height → identical regardless of width.
		expect(a.height).toBe(b.height);
		expect(a.usedWidth).toBe(600);
		expect(b.usedWidth).toBe(320);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Constant sanity (ground-truth vs Mantine CSS)
// ─────────────────────────────────────────────────────────────────────────────

describe("measure-permission constants", () => {
	it("match the Mantine ground-truth line boxes", async () => {
		const { MEASURE_PERMISSION_CONSTANTS } = await import("./measure-permission");
		const c = MEASURE_PERMISSION_CONSTANTS;
		expect(c.SM_LINE_HEIGHT).toBe(20); // round(14 × 1.45)
		expect(c.XS_LINE_HEIGHT).toBe(17); // round(12 × 1.4)
		expect(c.OPTION_DESC_LINE_HEIGHT).toBe(14); // round(12 × 1.2)
		expect(c.TEXTAREA_ROW_HEIGHT).toBe(19); // round(12 × 1.55)
		expect(c.ALERT_VERTICAL_CHROME).toBe(34); // 16×2 + 1×2
		expect(c.ASK_BUTTON_ROW_HEIGHT).toBe(30); // Button xs
		expect(c.PERM_BUTTON_ROW_HEIGHT).toBe(36); // Button sm
		expect(c.OPTION_INDENT).toBe(32); // control 20 + offset 12
	});
});
