/**
 * Header layout arithmetic — pretext title width FIRST, then tools with the remainder.
 *
 * NO flex auto-sizing between title and tools. The sequence is fixed:
 *
 *   W_title = measureHeaderTitleTextWidth(fullTitle)   // complete text, never truncated
 *   title box = W_title (fixed, flex-shrink: 0)
 *   tools     = as many ActionIcons as fit in (row − chrome − W_title − overflow)
 *
 * Buttons never steal title width; if anything is dropped it is tools (into the
 * overflow menu). When even chrome + overflow + the title floor exceed the row
 * (pathological narrow host), the title box shrinks down to
 * {@link HEADER_TITLE_TEXT_MIN_PX} so CSS ellipsis can apply — tools stay at 0.
 */

import { SANS_FAMILY, typographyMetrics } from "@shared/pretext-layout/pretext-fonts";

/** Matches `<Text size="sm" fw={500}>` in NarratorPanelHeaderTitle. */
const TITLE_WEIGHT_CSS = 500;

/** Soft ceiling for absurd titles; normal titles use their full measured width. */
export const HEADER_TITLE_TEXT_MAX_PX = 720;

/**
 * Hard floor when chrome + full title cannot fit the row. Below this the host
 * clips; at this value CSS ellipsis still has room to signal truncation.
 */
export const HEADER_TITLE_TEXT_MIN_PX = 80;

/** Fallback if canvas fails — still a real width, never 0 for non-empty text. */
export const HEADER_TITLE_TEXT_FALLBACK_PX = 160;

/** `ActionIcon size="sm"` — see narrator-header-toolbar-capacity / guard tests. */
export const HEADER_TOOL_ITEM_WIDTH_PX = 22;
/** Leading block gap: back ↔ title slot ↔ badge. Matches NarratorPanel `gap: 8`. */
export const HEADER_LEADING_GAP_PX = 8;
/** Row gap between the leading block and the toolbar. Matches NarratorPanel `gap: 8`. */
export const HEADER_ROW_GAP_PX = 8;
/** `Group gap="xs"` on the tool row (`--mantine-spacing-xs`). */
export const HEADER_TOOLBAR_GAP_PX = 10;
/** Back / minimize control. */
export const HEADER_BACK_WIDTH_PX = 22;
/** Edit + generate (`ActionIcon size="xs"` ≈ 18px) + their 4px gaps inside the title slot. */
export const HEADER_TITLE_ACTIONS_PX = 18 * 2 + 4 * 2;
/** Overflow menu trigger (always present in the toolbar). */
export const HEADER_OVERFLOW_WIDTH_PX = 22;
/** Close button when the host shows one (after overflow, toolbar gap). */
export const HEADER_CLOSE_WIDTH_PX = 22;
/** Header horizontal padding `px="md"` → 16×2. Matches `padding: "8px 16px"`. */
export const HEADER_ROW_PADDING_PX = 16 * 2;

export function estimateTitleWidthFallback(text: string): number {
	const sm = typographyMetrics().size.sm;
	let units = 0;
	for (const ch of text) {
		units +=
			/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60]/.test(ch)
				? 1
				: 0.55;
	}
	return Math.ceil(units * sm);
}

type MeasureCtx = {
	font: string;
	measureText(text: string): { width: number };
};

let measureCtx: MeasureCtx | null = null;
let measureCtxFailed = false;

function getMeasureCtx(): MeasureCtx | null {
	if (measureCtx) return measureCtx;
	if (measureCtxFailed) return null;
	try {
		if (typeof OffscreenCanvas !== "undefined") {
			measureCtx = new OffscreenCanvas(1, 1).getContext("2d");
			if (measureCtx) return measureCtx;
		}
		if (typeof document !== "undefined") {
			const canvas = document.createElement("canvas");
			measureCtx = canvas.getContext("2d");
			if (measureCtx) return measureCtx;
		}
	} catch {
		// fall through
	}
	measureCtxFailed = true;
	return null;
}

export function headerTitleFont(): string {
	const { size } = typographyMetrics();
	return `${TITLE_WEIGHT_CSS} ${size.sm}px ${SANS_FAMILY}`;
}

/**
 * Painted width of the COMPLETE `text` string in the header title font.
 * Callers must pass the full title — never an already-truncated display string.
 */
export function measureHeaderTitleTextWidth(text: string): number {
	const trimmed = text ?? "";
	if (!trimmed) return 0;
	const ctx = getMeasureCtx();
	if (!ctx) return estimateTitleWidthFallback(trimmed);
	try {
		ctx.font = headerTitleFont();
		const width = ctx.measureText(trimmed).width;
		if (Number.isFinite(width) && width > 0) return Math.ceil(width);
	} catch {
		// fall through
	}
	return estimateTitleWidthFallback(trimmed);
}

/**
 * Fixed title box width from the COMPLETE title text.
 * This value is an INPUT to tool layout — tools are fitted around it, never
 * the other way around.
 */
export function headerTitleLayoutWidth(text: string): number {
	if (!(text ?? "").trim()) return 0;
	const measured = measureHeaderTitleTextWidth(text);
	const w = measured > 0 ? measured : HEADER_TITLE_TEXT_FALLBACK_PX;
	return Math.min(w, HEADER_TITLE_TEXT_MAX_PX);
}

export interface HeaderAfterTitleInput {
	/** Header row content-box width (including padding we subtract). 0 = not ready. */
	rowWidth: number;
	/** Complete title text width from {@link headerTitleLayoutWidth}. */
	titleFullWidth: number;
	/** Whether the back/minimize control is shown. */
	showBack?: boolean;
	/** Whether edit+generate sit beside the title. */
	showTitleActions?: boolean;
	/** How many tools the reader surfaced into the header zone. */
	surfacedToolCount: number;
	/** Host close button on the far right of the toolbar. */
	showClose?: boolean;
}

export interface HeaderAfterTitleLayout {
	/** Title box — full pretext width when the row can hold chrome; floored when not. */
	titleWidth: number;
	/** How many surfaced tools fit AFTER the title reserved its width. */
	visibleToolCount: number;
	/** Surfaced tools that did not fit (overflow menu). */
	overflowToolCount: number;
	/** px left after title+chrome+overflow+visible tools (debug/UI). */
	slackPx: number;
}

/**
 * Precise single-row layout: reserve the pretext-measured title first,
 * then pack tool icons into whatever remains. Chrome constants must match the
 * DOM in NarratorPanel / HeaderToolbar (leading gap 8, toolbar gap 10, padding 16).
 */
export function resolveHeaderLayoutAfterTitle(
	input: HeaderAfterTitleInput,
): HeaderAfterTitleLayout {
	const {
		rowWidth,
		titleFullWidth,
		showBack = false,
		showTitleActions = false,
		surfacedToolCount,
		showClose = false,
	} = input;

	const toolsTotal = Math.max(0, surfacedToolCount);

	// Not measured yet: keep the full title width, show no tools until rowWidth lands
	// (avoids a flash that steals title space then reflows).
	if (!(rowWidth > 0)) {
		return {
			titleWidth: titleFullWidth,
			visibleToolCount: 0,
			overflowToolCount: toolsTotal,
			slackPx: 0,
		};
	}

	// Fixed chrome that is NOT collapsible tools. Mirrors the DOM:
	//   [padding][leading: back? + title(+actions) + badge?][row-gap][toolbar: tools… + overflow + close?][padding]
	let chrome = HEADER_ROW_PADDING_PX;
	if (showBack) chrome += HEADER_BACK_WIDTH_PX + HEADER_LEADING_GAP_PX;
	if (showTitleActions) chrome += HEADER_TITLE_ACTIONS_PX;
	// Row gap between leading block and toolbar (always present once both exist).
	chrome += HEADER_ROW_GAP_PX;
	// Toolbar always ends with the overflow trigger; close sits after it.
	chrome += HEADER_OVERFLOW_WIDTH_PX;
	if (showClose) chrome += HEADER_TOOLBAR_GAP_PX + HEADER_CLOSE_WIDTH_PX;

	// Title keeps its complete pretext-measured width whenever possible.
	let titleWidth = titleFullWidth;
	const titleBudget = rowWidth - chrome;
	if (titleBudget < titleWidth) {
		// Pathological narrow row: floor the title so CSS ellipsis can signal
		// truncation instead of hard-clipping at an arbitrary overflow boundary.
		titleWidth = Math.max(HEADER_TITLE_TEXT_MIN_PX, Math.min(titleWidth, titleBudget));
		if (titleWidth < HEADER_TITLE_TEXT_MIN_PX) titleWidth = HEADER_TITLE_TEXT_MIN_PX;
	}

	// Tools sit in the toolbar Group: each visible tool plus its gap before the
	// next item (overflow or the following tool) costs item + toolbar gap.
	let remaining = rowWidth - chrome - titleWidth;
	let visibleToolCount = 0;
	while (visibleToolCount < toolsTotal) {
		const need = HEADER_TOOL_ITEM_WIDTH_PX + HEADER_TOOLBAR_GAP_PX;
		if (remaining < need) break;
		remaining -= need;
		visibleToolCount += 1;
	}

	return {
		titleWidth,
		visibleToolCount,
		overflowToolCount: toolsTotal - visibleToolCount,
		slackPx: Math.max(0, remaining),
	};
}
