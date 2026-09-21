/**
 * measure-permission.ts — Height model for the two permission / interaction
 * elements (batch-2 P11), both marked "strongly dynamic" in CONTRACT.md §4:
 *
 *   1. AskUserQuestionBanner (Alert, NO folding, NO LOD) — visual parity target:
 *      AskUserQuestionBanner.tsx.
 *
 *        ┌ Alert p="md"(16) border 1px radius="md" ───────────────────────────────┐
 *        │  Stack gap="md"(16)                                                    │
 *        │    ├ question × N  → Stack gap="xs"(10):                               │
 *        │    │    header      Text sm/500  (wraps 🔴, sm line 20)               │
 *        │    │    options     Checkbox/Radio Stack gap={4}:                      │
 *        │    │        label   (wraps 🔴, label lh 20) [+ control 20 to the left] │
 *        │    │        [desc]  (wraps 🔴, 12/1.2 → 14, mt 5)                      │
 *        │    │    input       !readOnly → Textarea xs autosize 1..3 (30..68)     │
 *        │    │                readOnly  → saved custom answer (xs mono, wraps 🔴)│
 *        │    │    [badge]     readOnly + answered → Badge xs (16)               │
 *        │    ├ [countdown]  !readOnly + armed → Group icon14 + xs text (17)      │
 *        │    └ [buttons]    !readOnly → Button xs row (30)                       │
 *        └────────────────────────────────────────────────────────────────────────┘
 *
 *   2. InlinePermission (inside ToolCallCard, wrapped in Box mt="xs") — visual
 *      parity target: ToolCallCard.tsx InlinePermission(:4972) + PermButtonBar(:4841).
 *      NOTE: the outer `mt="xs"`(10) is EXTERNAL spacing owned by the tool card
 *      (P10); it is NOT baked into this element's height — see
 *      INLINE_PERMISSION_TOP_MARGIN. The element itself is a stack of fixed rows:
 *
 *        [exec target Paper p="xs" mb="xs"]  header 17 + (cwd/path lines × 17)
 *        [plan-edited badge mb={4}]          16
 *        [plan Textarea mb="xs"]             editing → autosize 8..30 rows (× 19)
 *        [decision reason mb={4}]            reasonLines × 17
 *        feedback Textarea mb="xs"           autosize 1..3 rows (30..68)   [always]
 *        readOnly → "unavailable" text 17 | !readOnly → PermButtonBar sm row 36
 *
 * The wrapping-critical AskUserQuestion header / option label / option
 * description / saved-custom-answer are `PreparedInlineBlock`s measured with
 * pretext (zero DOM). Every Textarea / badge / button / countdown / execution
 * target / reason is a fixed-height `PreparedFixedBlock` (row counts, never DOM).
 *
 * Follows the measure-markdown.ts / measure-web-search.ts / measure-reasoning.ts
 * template. Zero DOM measurement.
 */

import { prepareRichInline, type RichInlineItem } from "@chenglou/pretext/rich-inline";
import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type LineMetricsResolver,
	type MeasuredElement,
	type PreparedBlock,
	type PreparedFixedBlock,
	type PreparedInlineBlock,
	type RenderLod,
} from "../prepared-block";
import {
	BASE_LINE_HEIGHT,
	FONT_SIZE,
	FONT_WEIGHT,
	LINE_HEIGHT,
	lineBoxHeight,
	MONO_FAMILY,
	SANS_FAMILY,
	SPACING,
	scaledLineBoxHeight,
	typographyMetrics,
} from "../pretext-fonts";
import { pretextLineMetrics } from "./pretext-metrics";

// ─────────────────────────────────────────────────────────────────────────────
// Shared line-box heights (px) — CONTRACT.md §3 + Mantine ground-truth CSS.
// ─────────────────────────────────────────────────────────────────────────────

/** sm body line box: round(14 × 1.45) = 20 (Text size="sm" header + Radio/Checkbox label lh). */
export const SM_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.sm, LINE_HEIGHT.sm); // 20
/** xs line box: round(12 × 1.4) = 17 (dimmed xs rows, saved custom answer, reason lines). */
export const XS_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17
/**
 * Checkbox/Radio description line box: 12px × 1.2 → round(14.4) = 14. The
 * InputDescription font-size is sm-2 = 12px and its line-height is a hard-coded
 * 1.2 (Mantine Input.css). CONTRACT §4 loosely approximated this as "≈17"; the
 * real rendered value (14) is used here for accuracy — the VListHarness
 * calibrates the exact pixels. (Reported to the main agent; no skeleton change.)
 */
export const OPTION_DESC_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, 1.2);
/** optionDescLineHeight() at the reader's typography (baseline above). */
export function optionDescLineHeight(): number {
	return scaledLineBoxHeight(FONT_SIZE.xs, 1.2);
} // 14
/**
 * Textarea autosize row box: 12px × base line-height (1.55) → round(18.6) = 19.
 * Multiline inputs use `--input-line-height: var(--mantine-line-height)` (1.55),
 * and the xs feedback / xs custom-input / ExitPlanMode edit (font overridden to
 * xs) textareas all render at 12px, so every textarea row is 19px.
 */
export const TEXTAREA_ROW_HEIGHT = lineBoxHeight(FONT_SIZE.xs, BASE_LINE_HEIGHT); // 19

// ─────────────────────────────────────────────────────────────────────────────
// AskUserQuestionBanner chrome constants (px).
// ─────────────────────────────────────────────────────────────────────────────

/** Alert padding (Alert defaults to spacing md on every side). */
export const ALERT_PADDING = SPACING.md; // 16
/** Alert border (`--alert-bd: 1px solid transparent`). */
export const ALERT_BORDER = 1;
/** Fixed vertical chrome: padding×2 + border×2. */
export const ALERT_VERTICAL_CHROME = ALERT_PADDING * 2 + ALERT_BORDER * 2; // 34
/** Fixed horizontal chrome: padding×2 + border×2 (subtracted for wrap width). */
export const ALERT_HORIZONTAL_CHROME = ALERT_PADDING * 2 + ALERT_BORDER * 2; // 34
/** Outer Stack gap="md" — between questions, countdown and the button row. */
export const ALERT_STACK_GAP = SPACING.md; // 16
/** Per-question inner Stack gap="xs" — header ↔ options ↔ input ↔ badge. */
export const QUESTION_STACK_GAP = SPACING.xs; // 10
/** Options inner Stack gap={4} — between successive option rows. */
export const OPTIONS_GAP = 4;

/** Header text (Text size="sm" fw={500}). */
export const HEADER_LINE_HEIGHT = SM_LINE_HEIGHT; // 20
export const HEADER_FONT = `${FONT_WEIGHT.medium} ${FONT_SIZE.sm}px ${SANS_FAMILY}`;

/** Option label (Radio/Checkbox label, size sm, weight 400, lh 20). */
export const OPTION_LABEL_LINE_HEIGHT = SM_LINE_HEIGHT; // 20
export const OPTION_LABEL_FONT = `${FONT_WEIGHT.regular} ${FONT_SIZE.sm}px ${SANS_FAMILY}`;
/** Option description font (12px, weight 400). */
export const OPTION_DESC_FONT = `${FONT_WEIGHT.regular} ${FONT_SIZE.xs}px ${SANS_FAMILY}`;
/** Description margin-top (calc(spacing.xs / 2) = 5). */
export const OPTION_DESC_MARGIN_TOP = SPACING.xs / 2; // 5

/** Checkbox/Radio control square (size sm = 20). */
export const OPTION_CONTROL_SIZE = 20;
/** Label offset-start (spacing sm = 12) between the control and the label. */
export const OPTION_LABEL_OFFSET = SPACING.sm; // 12
/** Left indent of an option's label/description (control + offset). */
export const OPTION_INDENT = OPTION_CONTROL_SIZE + OPTION_LABEL_OFFSET; // 32

/** Saved custom answer (readOnly): Text size="xs" ff="monospace", lh 17. */
export const CUSTOM_ANSWER_LINE_HEIGHT = XS_LINE_HEIGHT; // 17
export const CUSTOM_ANSWER_FONT = `${FONT_WEIGHT.regular} ${FONT_SIZE.xs}px ${MONO_FAMILY}`;

/** "Answered" Badge size="xs" height. */
export const BADGE_XS_HEIGHT = 16;
/** Countdown Group row: max(icon 14, xs text 17) = 17. */
export const COUNTDOWN_ROW_HEIGHT = Math.max(14, XS_LINE_HEIGHT); // 17
/** AskUserQuestion action buttons (Button size="xs" = 30). */
export const ASK_BUTTON_ROW_HEIGHT = 30;

/** xs Textarea autosize chrome (multiline padding-y-xs 4.5×2 + border 1×2). */
export const XS_TEXTAREA_CHROME = 4.5 * 2 + ALERT_BORDER * 2; // 11
/** Custom-input / feedback textarea autosize row bounds. */
export const CUSTOM_INPUT_MIN_ROWS = 1;
export const CUSTOM_INPUT_MAX_ROWS = 3;

/**
 * Height of an xs autosize Textarea (custom-input / feedback), clamped to
 * [1, 3] rows. 1 row → 30, 3 rows → 68.
 */
export function xsTextareaHeight(rows: number): number {
	const r = clamp(rows, CUSTOM_INPUT_MIN_ROWS, CUSTOM_INPUT_MAX_ROWS);
	return r * typographyMetrics().line.xsBase + XS_TEXTAREA_CHROME;
}

// ─────────────────────────────────────────────────────────────────────────────
// InlinePermission chrome constants (px).
// ─────────────────────────────────────────────────────────────────────────────

/** Outer `Box mt="xs"`(10) — EXTERNAL spacing owned by the tool card (P10). */
export const INLINE_PERMISSION_TOP_MARGIN = SPACING.xs; // 10

/** Execution-target Paper p="xs"(10). */
export const TARGET_PADDING = SPACING.xs; // 10
/** Execution-target Paper border (withBorder = 1px). */
export const TARGET_BORDER = 1;
/** Execution-target header row: max(icon-less xs text 17, Badge xs 16) = 17. */
export const TARGET_HEADER_ROW = XS_LINE_HEIGHT; // 17
/** Header Group mb={4} shown only when a cwd or path line follows. */
export const TARGET_HEADER_MARGIN = 4;
/** Execution-target Paper mb="xs"(10). */
export const TARGET_MARGIN_BOTTOM = SPACING.xs; // 10

/** "Plan edited" Badge size="xs" (16) + mb={4}. */
export const PLAN_EDITED_BADGE_HEIGHT = BADGE_XS_HEIGHT; // 16
export const PLAN_EDITED_BADGE_MARGIN_BOTTOM = 4;

/** ExitPlanMode edit Textarea (default size sm) autosize chrome + row bounds. */
export const PLAN_TEXTAREA_CHROME = 5.5 * 2 + ALERT_BORDER * 2; // 13
export const PLAN_TEXTAREA_MIN_ROWS = 8;
export const PLAN_TEXTAREA_MAX_ROWS = 30;
/** ExitPlanMode edit Textarea mb="xs"(10). */
export const PLAN_TEXTAREA_MARGIN_BOTTOM = SPACING.xs; // 10

/** Decision-reason text (Text size="xs" dimmed) mb={4}; each line 17. */
export const DECISION_REASON_MARGIN_BOTTOM = 4;
/** Feedback Textarea mb="xs"(10). */
export const FEEDBACK_MARGIN_BOTTOM = SPACING.xs; // 10

/** PermButtonBar buttons are Button size="sm" (36). */
export const PERM_BUTTON_ROW_HEIGHT = 36;
/** PermButtonBar Group gap="sm"(12) between rows when buttons wrap. */
export const PERM_BUTTON_GROUP_GAP = SPACING.sm; // 12
/** readOnly note ("permission actions unavailable") — single xs line. */
export const READONLY_NOTE_HEIGHT = XS_LINE_HEIGHT; // 17

/** Height of the ExitPlanMode edit Textarea, clamped to [8, 30] rows. */
export function planTextareaHeight(rows: number): number {
	const r = clamp(rows, PLAN_TEXTAREA_MIN_ROWS, PLAN_TEXTAREA_MAX_ROWS);
	return r * typographyMetrics().line.xsBase + PLAN_TEXTAREA_CHROME;
}

/**
 * Height of the execution-target Paper. `cwdLines`/`pathLines` are the wrapped
 * line counts (0 = that row is absent). The header Group carries a 4px bottom
 * margin only when at least one detail line follows.
 */
export function executionTargetHeight(cwdLines: number, pathLines: number): number {
	const cwd = Math.max(0, cwdLines);
	const path = Math.max(0, pathLines);
	const hasDetail = cwd + path > 0;
	return (
		TARGET_PADDING * 2 +
		TARGET_BORDER * 2 +
		TARGET_HEADER_ROW +
		(hasDetail ? TARGET_HEADER_MARGIN : 0) +
		cwd * typographyMetrics().line.xs +
		path * typographyMetrics().line.xs
	);
}

/** Height of the PermButtonBar, laid out over `rows` wrapped rows (default 1). */
export function permButtonBarHeight(rows: number): number {
	const r = Math.max(1, rows);
	return r * PERM_BUTTON_ROW_HEIGHT + (r - 1) * PERM_BUTTON_GROUP_GAP;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data shapes (custom to this element, per the task brief).
// ─────────────────────────────────────────────────────────────────────────────

export interface AskQuestionOptionData {
	/** Option title text (wraps). */
	header: string;
	/** Optional description text under the header (wraps). */
	description?: string;
}

export interface AskQuestionData {
	/** Full question text (Text sm/500, wraps). */
	header: string;
	/** Optional extra context under the header (Text sm, wraps). */
	description?: string;
	/** Selectable options (Checkbox when multiSelect, else Radio). */
	options: AskQuestionOptionData[];
	/** multiSelect → Checkbox squares; otherwise → Radio circles. */
	multiSelect?: boolean;
	/**
	 * Whether the custom-input Textarea (non-readOnly) / saved custom-answer line
	 * (readOnly) is present. Defaults to true (the live banner always shows the
	 * Textarea when interactive). Set false to suppress.
	 */
	hasCustomInput?: boolean;
	/** Custom-input Textarea autosize rows (clamped [1,3]); default 1. */
	customInputRows?: number;
	/** readOnly: the saved free-text answer to show as a mono xs line (wraps). */
	savedCustomAnswer?: string;
	/** readOnly: whether the "answered" badge is shown for this question. */
	hasSavedAnswer?: boolean;
}

export interface AskUserQuestionData {
	questions: AskQuestionData[];
	/** readOnly display: locks controls, drops the Textarea/countdown/buttons. */
	readOnly?: boolean;
	/** !readOnly only: whether the live reflection countdown row is shown. */
	hasCountdown?: boolean;
}

export interface InlinePermissionData {
	/** readOnly display: drops the button bar for a single "unavailable" line. */
	readOnly?: boolean;
	/**
	 * Whether the frozen execution-target Paper is shown. Ignored when
	 * `isExitPlanMode` is true — the plan gate suppresses the block.
	 */
	hasExecutionTarget?: boolean;
	/** Wrapped line count of the cwd row (0 = absent); default 1 with a target. */
	executionCwdLines?: number;
	/** Wrapped line count of the resolved-path row (0 = absent); default 0. */
	executionPathLines?: number;
	/** ExitPlanMode tool → enables the plan-edit affordances. */
	isExitPlanMode?: boolean;
	/** Whether the plan-edit Textarea is currently shown (editing mode). */
	isEditingPlan?: boolean;
	/** Plan-edit Textarea autosize rows (clamped [8,30]); default 8. */
	planEditRows?: number;
	/** Whether the "plan edited" badge is shown (planEdited && !editing). */
	planEdited?: boolean;
	/** Whether a decision-reason line block is shown. */
	hasDecisionReason?: boolean;
	/** Wrapped line count of the decision reason; default 1. */
	decisionReasonLines?: number;
	/** Feedback Textarea autosize rows (clamped [1,3]); default 1. */
	feedbackRows?: number;
	/** Number of permission buttons (render-only; the bar is one row). */
	buttonCount?: number;
	/** Wrapped rows the button bar occupies (default 1). */
	buttonRows?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Render metadata carried alongside each prepared block (parallel arrays).
// ─────────────────────────────────────────────────────────────────────────────

export type AskBlockRole =
	| "header"
	| "description"
	| "option-label"
	| "option-desc"
	| "custom-answer"
	| "ask-textarea"
	| "answered-badge"
	| "countdown"
	| "buttons";

export interface AskBlockMeta {
	role: AskBlockRole;
	/** Which question this block belongs to (for grouping / keys). */
	questionIndex: number;
	/** option-label only: control kind + checked state (readOnly). */
	control?: "checkbox" | "radio";
}

export interface MeasuredAskUserQuestion extends MeasuredElement {
	/** Parallel to `blocks` — the render role of each block. */
	metas: AskBlockMeta[];
	readOnly: boolean;
	/** Outer Alert width (px) — the full-width block width for the renderer. */
	outerWidth: number;
}

export type PermBlockRole =
	| "exec-target"
	| "plan-edited-badge"
	| "plan-textarea"
	| "decision-reason"
	| "feedback-textarea"
	| "button-bar"
	| "readonly-note";

export interface PermBlockMeta {
	role: PermBlockRole;
	data?: Record<string, unknown>;
}

export interface MeasuredInlinePermission extends MeasuredElement {
	/** Parallel to `blocks` — the render role of each fixed block. */
	metas: PermBlockMeta[];
	readOnly: boolean;
	/** External top margin (Box mt="xs") the tool card owner should add. */
	topMargin: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers.
// ─────────────────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

function baseBlockFields() {
	return {
		marginTop: 0,
		contentLeft: 0,
		quoteRailLefts: [] as number[],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
}

function makeInline(
	text: string,
	font: string,
	lineHeight: number,
	contentLeft: number,
	className: string,
): PreparedInlineBlock {
	const items: RichInlineItem[] = [{ text, font, break: "normal", extraWidth: 0 }];
	return {
		...baseBlockFields(),
		kind: "inline",
		flow: prepareRichInline(items),
		lineHeight,
		classNames: [className],
		hrefs: [null],
		fonts: [font],
		contentLeft,
	};
}

function makeFixed(
	height: number,
	tag: string,
	data?: Record<string, unknown>,
): PreparedFixedBlock {
	return {
		...baseBlockFields(),
		kind: "fixed",
		height,
		tag,
		...(data ? { data } : {}),
	};
}

/** A no-op resolver for elements whose every block is a fixed-height block. */
const NO_TEXT_MEASURE: LineMetricsResolver = () => ({ lineCount: 1, maxLineWidth: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// AskUserQuestionBanner.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Measure an AskUserQuestionBanner (Alert). Height grows linearly with the
 * number of questions, options and description lines; wrapping of the header /
 * option label / option description / saved answer is measured with pretext.
 * There is no folded form and no LOD dependence.
 *
 * @param data         questions + readOnly + countdown flags
 * @param contentWidth available OUTER Alert width in px
 * @param _lod         render LOD — ignored (this element never folds)
 */
export function measureAskUserQuestion(
	data: AskUserQuestionData,
	contentWidth: number,
	_lod: RenderLod = DEFAULT_RENDER_LOD,
): MeasuredAskUserQuestion {
	const readOnly = data.readOnly === true;
	const innerWidth = Math.max(1, contentWidth - ALERT_HORIZONTAL_CHROME);

	const blocks: PreparedBlock[] = [];
	const metas: AskBlockMeta[] = [];
	let first = true;

	const push = (block: PreparedBlock, meta: AskBlockMeta, marginTop: number) => {
		block.marginTop = first ? 0 : marginTop;
		first = false;
		blocks.push(block);
		metas.push(meta);
	};

	data.questions.forEach((q, qi) => {
		// Header (gap before it = the outer Stack gap, unless it is the first block).
		push(
			makeInline(
				q.header,
				typographyMetrics().font.bodyMedium,
				// Scaled to match the scaled font on the line above. A frozen box here held
				// scaled glyphs, which clips ascenders/descenders rather than merely looking off.
				scaledLineBoxHeight(FONT_SIZE.sm, LINE_HEIGHT.sm),
				0,
				"vlist-ask-header",
			),
			{ role: "header", questionIndex: qi },
			ALERT_STACK_GAP,
		);

		// Optional question description under the header (Text size="sm" dimmed).
		if (q.description?.trim()) {
			push(
				makeInline(
					q.description,
					typographyMetrics().font.body,
					scaledLineBoxHeight(FONT_SIZE.sm, LINE_HEIGHT.sm),
					0,
					"vlist-ask-description",
				),
				{ role: "description", questionIndex: qi },
				QUESTION_STACK_GAP,
			);
		}

		// Options (Checkbox / Radio rows).
		if (q.options.length > 0) {
			const control: "checkbox" | "radio" = q.multiSelect ? "checkbox" : "radio";
			q.options.forEach((opt, oi) => {
				// First option is separated from the header/description by the question Stack gap;
				// subsequent options by the tighter options Stack gap.
				const labelMt = oi === 0 ? QUESTION_STACK_GAP : OPTIONS_GAP;
				// Live typography, like the header above. These read frozen baseline
				// constants while the header scaled, so at a non-default setting a card's
				// header grew and its options did not — the option text simply ignored the
				// reader's preference. The render layer paints from `block.fonts` /
				// `block.lineHeight`, so measure is the only authority and this is the fix.
				push(
					makeInline(
						opt.header,
						typographyMetrics().font.body,
						scaledLineBoxHeight(FONT_SIZE.sm, LINE_HEIGHT.sm),
						OPTION_INDENT,
						"vlist-ask-option-label",
					),
					{ role: "option-label", questionIndex: qi, control },
					labelMt,
				);
				if (opt.description) {
					push(
						makeInline(
							opt.description,
							typographyMetrics().font.xs,
							// 1.2 is Mantine's hard-coded InputDescription ratio, not a body ratio.
							optionDescLineHeight(),
							OPTION_INDENT,
							"vlist-ask-option-desc",
						),
						{ role: "option-desc", questionIndex: qi },
						OPTION_DESC_MARGIN_TOP,
					);
				}
			});
		}

		// Input region: interactive Textarea, or readOnly saved custom answer.
		const showCustom = q.hasCustomInput !== false;
		if (!readOnly && showCustom) {
			push(
				makeFixed(xsTextareaHeight(q.customInputRows ?? 1), "ask-textarea"),
				{ role: "ask-textarea", questionIndex: qi },
				QUESTION_STACK_GAP,
			);
		} else if (readOnly && q.savedCustomAnswer) {
			push(
				makeInline(
					q.savedCustomAnswer,
					typographyMetrics().font.xsMono,
					scaledLineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs),
					0,
					"vlist-ask-custom-answer",
				),
				{ role: "custom-answer", questionIndex: qi },
				QUESTION_STACK_GAP,
			);
		}

		// readOnly "answered" badge.
		if (readOnly && q.hasSavedAnswer) {
			push(
				makeFixed(BADGE_XS_HEIGHT, "answered-badge"),
				{ role: "answered-badge", questionIndex: qi },
				QUESTION_STACK_GAP,
			);
		}
	});

	// Countdown row (interactive + armed only).
	if (!readOnly && data.hasCountdown) {
		push(
			makeFixed(COUNTDOWN_ROW_HEIGHT, "countdown"),
			{ role: "countdown", questionIndex: -1 },
			ALERT_STACK_GAP,
		);
	}

	// Action button row (interactive only).
	if (!readOnly) {
		push(
			makeFixed(ASK_BUTTON_ROW_HEIGHT, "buttons"),
			{ role: "buttons", questionIndex: -1 },
			ALERT_STACK_GAP,
		);
	}

	const frame = accumulateFrame(blocks, innerWidth, pretextLineMetrics);
	const height = ALERT_VERTICAL_CHROME + frame.contentHeight;

	return {
		height,
		blocks,
		frame,
		// Renderer re-materializes inline line ranges at the inner width.
		contentWidth: innerWidth,
		// Full-width block: occupies the given outer width.
		usedWidth: contentWidth,
		metas,
		readOnly,
		outerWidth: contentWidth,
	};
}

/** Parse once, measure many (e.g. on resize). Returns a reusable closure. */
export function prepareAskUserQuestionMeasurer(
	data: AskUserQuestionData,
): (contentWidth: number, lod?: RenderLod) => MeasuredAskUserQuestion {
	return (contentWidth, lod = DEFAULT_RENDER_LOD) =>
		measureAskUserQuestion(data, contentWidth, lod);
}

// ─────────────────────────────────────────────────────────────────────────────
// InlinePermission.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Measure an InlinePermission block (the non-AskUserQuestion permission form).
 * Every region is a fixed-height row, so the result is fully deterministic and
 * needs no pretext. The height is the sum of the present rows plus their inter-
 * row margins; the outer `Box mt="xs"` is reported via `topMargin` for the tool
 * card owner to add (it is NOT included in `height`).
 *
 * @param data         which regions are present + their row counts
 * @param contentWidth available width in px (full-width block)
 * @param _lod         render LOD — ignored (permission prompts never fold)
 */
export function measureInlinePermission(
	data: InlinePermissionData,
	contentWidth: number,
	_lod: RenderLod = DEFAULT_RENDER_LOD,
): MeasuredInlinePermission {
	const readOnly = data.readOnly === true;

	const blocks: PreparedBlock[] = [];
	const metas: PermBlockMeta[] = [];
	let pendingGap = 0;
	let first = true;

	// Each region carries an explicit bottom margin (mb) in the DOM; we translate
	// that into the NEXT block's marginTop so accumulateFrame spaces them exactly.
	const push = (block: PreparedFixedBlock, meta: PermBlockMeta, bottomMargin: number) => {
		block.marginTop = first ? 0 : pendingGap;
		first = false;
		pendingGap = bottomMargin;
		blocks.push(block);
		metas.push(meta);
	};

	// Execution-target Paper (mb="xs"). ExitPlanMode never paints it: the plan gate
	// is an approval decision, not a routed filesystem/command action, so the card
	// suppresses the block (ToolCallCard.tsx InlinePermission) — measuring it would
	// reserve height for a Paper that never mounts.
	if (data.hasExecutionTarget && data.isExitPlanMode !== true) {
		const cwdLines = data.executionCwdLines ?? 1;
		const pathLines = data.executionPathLines ?? 0;
		push(
			makeFixed(executionTargetHeight(cwdLines, pathLines), "exec-target", {
				cwdLines,
				pathLines,
			}),
			{ role: "exec-target", data: { cwdLines, pathLines } },
			TARGET_MARGIN_BOTTOM,
		);
	}

	// "Plan edited" badge (mb={4}) — only when edited and not currently editing.
	if (data.planEdited && !data.isEditingPlan) {
		push(
			makeFixed(PLAN_EDITED_BADGE_HEIGHT, "plan-edited-badge"),
			{ role: "plan-edited-badge" },
			PLAN_EDITED_BADGE_MARGIN_BOTTOM,
		);
	}

	// ExitPlanMode edit Textarea (mb="xs") — only while editing.
	if (data.isEditingPlan) {
		const rows = data.planEditRows ?? PLAN_TEXTAREA_MIN_ROWS;
		push(
			makeFixed(planTextareaHeight(rows), "plan-textarea", { rows: clamp(rows, 8, 30) }),
			{ role: "plan-textarea", data: { rows: clamp(rows, 8, 30) } },
			PLAN_TEXTAREA_MARGIN_BOTTOM,
		);
	}

	// Decision reason (mb={4}).
	if (data.hasDecisionReason) {
		const reasonLines = Math.max(1, data.decisionReasonLines ?? 1);
		push(
			makeFixed(reasonLines * typographyMetrics().line.xs, "decision-reason", { reasonLines }),
			{ role: "decision-reason", data: { reasonLines } },
			DECISION_REASON_MARGIN_BOTTOM,
		);
	}

	// Feedback Textarea (mb="xs") — ALWAYS present (disabled in readOnly).
	const feedbackRows = data.feedbackRows ?? CUSTOM_INPUT_MIN_ROWS;
	push(
		makeFixed(xsTextareaHeight(feedbackRows), "feedback-textarea", {
			rows: clamp(feedbackRows, CUSTOM_INPUT_MIN_ROWS, CUSTOM_INPUT_MAX_ROWS),
		}),
		{ role: "feedback-textarea", data: { rows: clamp(feedbackRows, 1, 3) } },
		FEEDBACK_MARGIN_BOTTOM,
	);

	// Actions: readOnly → single "unavailable" line; else the PermButtonBar.
	if (readOnly) {
		push(makeFixed(READONLY_NOTE_HEIGHT, "readonly-note"), { role: "readonly-note" }, 0);
	} else {
		const buttonRows = data.buttonRows ?? 1;
		push(
			makeFixed(permButtonBarHeight(buttonRows), "button-bar", {
				buttonCount: data.buttonCount ?? 0,
				buttonRows,
				isExitPlanMode: data.isExitPlanMode === true,
			}),
			{
				role: "button-bar",
				data: {
					buttonCount: data.buttonCount ?? 0,
					buttonRows,
					isExitPlanMode: data.isExitPlanMode === true,
				},
			},
			0,
		);
	}

	const frame = accumulateFrame(blocks, contentWidth, NO_TEXT_MEASURE);

	return {
		height: frame.contentHeight,
		blocks,
		frame,
		contentWidth,
		usedWidth: contentWidth,
		metas,
		readOnly,
		topMargin: INLINE_PERMISSION_TOP_MARGIN,
	};
}

/** Parse once, measure many (e.g. on resize). Returns a reusable closure. */
export function prepareInlinePermissionMeasurer(
	data: InlinePermissionData,
): (contentWidth: number, lod?: RenderLod) => MeasuredInlinePermission {
	return (contentWidth, lod = DEFAULT_RENDER_LOD) =>
		measureInlinePermission(data, contentWidth, lod);
}

// ─────────────────────────────────────────────────────────────────────────────

export const MEASURE_PERMISSION_CONSTANTS = {
	SM_LINE_HEIGHT,
	XS_LINE_HEIGHT,
	OPTION_DESC_LINE_HEIGHT,
	TEXTAREA_ROW_HEIGHT,
	ALERT_PADDING,
	ALERT_BORDER,
	ALERT_VERTICAL_CHROME,
	ALERT_HORIZONTAL_CHROME,
	ALERT_STACK_GAP,
	QUESTION_STACK_GAP,
	OPTIONS_GAP,
	HEADER_LINE_HEIGHT,
	OPTION_LABEL_LINE_HEIGHT,
	OPTION_DESC_MARGIN_TOP,
	OPTION_CONTROL_SIZE,
	OPTION_LABEL_OFFSET,
	OPTION_INDENT,
	CUSTOM_ANSWER_LINE_HEIGHT,
	BADGE_XS_HEIGHT,
	COUNTDOWN_ROW_HEIGHT,
	ASK_BUTTON_ROW_HEIGHT,
	XS_TEXTAREA_CHROME,
	INLINE_PERMISSION_TOP_MARGIN,
	TARGET_PADDING,
	TARGET_BORDER,
	TARGET_HEADER_ROW,
	TARGET_HEADER_MARGIN,
	TARGET_MARGIN_BOTTOM,
	PLAN_EDITED_BADGE_HEIGHT,
	PLAN_TEXTAREA_CHROME,
	PLAN_TEXTAREA_MIN_ROWS,
	PLAN_TEXTAREA_MAX_ROWS,
	DECISION_REASON_MARGIN_BOTTOM,
	FEEDBACK_MARGIN_BOTTOM,
	PERM_BUTTON_ROW_HEIGHT,
	PERM_BUTTON_GROUP_GAP,
	READONLY_NOTE_HEIGHT,
} as const;
