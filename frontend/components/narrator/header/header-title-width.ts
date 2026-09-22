/**
 * Header layout arithmetic — pretext title width FIRST, then tools with the remainder.
 *
 * NO flex auto-sizing between title and tools. The sequence is fixed:
 *
 *   W_title = measureHeaderTitleTextWidth(fullTitle)   // complete text, never truncated
 *   title box = W_title (fixed, flex-shrink: 0)
 *   tools     = as many ActionIcons as fit in (row − chrome − W_title)
 *
 * Buttons never steal title width. When `rowWidth` is unknown (skeleton →
 * header mount), show every surfaced tool and do NOT label them "空间不足".
 */

import { SANS_FAMILY, typographyMetrics } from "@shared/pretext-layout/pretext-fonts";

/** Matches `<Text size="sm" fw={500}>` in NarratorPanelHeaderTitle. */
const TITLE_WEIGHT_CSS = 500;

/** Soft ceiling for absurd titles; normal titles use their full measured width. */
export const HEADER_TITLE_TEXT_MAX_PX = 720;

/**
 * Hard floor only when chrome + full title cannot fit a pathological row.
 * Normal layouts keep the complete measured width.
 */
export const HEADER_TITLE_TEXT_MIN_PX = 80;

/** Fallback if canvas fails — still a real width, never 0 for non-empty text. */
export const HEADER_TITLE_TEXT_FALLBACK_PX = 160;

/** `ActionIcon size="sm"`. */
export const HEADER_TOOL_ITEM_WIDTH_PX = 22;
/** Leading block gap (back ↔ title ↔ badge) — NarratorPanel `gap: 8`. */
export const HEADER_LEADING_GAP_PX = 8;
/** Row gap between leading block and toolbar — NarratorPanel `gap: 8`. */
export const HEADER_ROW_GAP_PX = 8;
/** Tool-row `Group gap="xs"` — `--mantine-spacing-xs`. */
export const HEADER_TOOLBAR_GAP_PX = 10;
export const HEADER_BACK_WIDTH_PX = 22;
/** Edit + generate (`size="xs"` ≈ 18px) + 4px gaps inside the title slot. */
export const HEADER_TITLE_ACTIONS_PX = 18 * 2 + 4 * 2;
export const HEADER_OVERFLOW_WIDTH_PX = 22;
export const HEADER_CLOSE_WIDTH_PX = 22;
/** Header `padding: "8px 16px"` → 16×2. */
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
 * Painted width of the COMPLETE `text` in the header title font.
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
 * INPUT to tool layout — tools are fitted around it, never the reverse.
 */
export function headerTitleLayoutWidth(text: string): number {
	if (!(text ?? "").trim()) return 0;
	const measured = measureHeaderTitleTextWidth(text);
	const w = measured > 0 ? measured : HEADER_TITLE_TEXT_FALLBACK_PX;
	return Math.min(w, HEADER_TITLE_TEXT_MAX_PX);
}

export interface HeaderAfterTitleInput {
	/** Header row border-box width. 0 = not measured yet. */
	rowWidth: number;
	/** Complete title text width from {@link headerTitleLayoutWidth}. */
	titleFullWidth: number;
	showBack?: boolean;
	showTitleActions?: boolean;
	surfacedToolCount: number;
	showClose?: boolean;
}

export interface HeaderAfterTitleLayout {
	/** Title box — COMPLETE `titleFullWidth` except pathological narrow rows. */
	titleWidth: number;
	visibleToolCount: number;
	overflowToolCount: number;
	slackPx: number;
	/**
	 * `rowWidth` unknown: tools shown optimistically; MUST NOT say "空间不足".
	 */
	unmeasured: boolean;
}

/**
 * Title-first single-row layout.
 *
 * DOM (NarratorPanel header row + NarratorPanelHeaderTitle + HeaderToolbar):
 *
 *   [pad 16][back?][gap 8][title text + actions][row-gap 8][tool… gap10 …overflow][gap10 close?][pad 16]
 *
 * `HEADER_TITLE_ACTIONS_PX` already includes the title-slot gaps after the text
 * (edit + 4 + generate + 4). The leading↔toolbar gap is charged once as
 * `HEADER_ROW_GAP_PX`. Overflow is in chrome without its preceding toolbar gap;
 * packing therefore charges each visible tool `item + toolbar gap` — that gap is
 * what sits between the tool and the next tool / overflow. Do NOT also subtract
 * a row gap before the first tool (double-count).
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

	// Skeleton → header mount: width not ready. Show all tools; title stays full.
	// Do NOT invent a "no room" shortfall.
	if (!(rowWidth > 0)) {
		return {
			titleWidth: titleFullWidth,
			visibleToolCount: toolsTotal,
			overflowToolCount: 0,
			slackPx: 0,
			unmeasured: true,
		};
	}

	let chrome = HEADER_ROW_PADDING_PX;
	if (showBack) chrome += HEADER_BACK_WIDTH_PX + HEADER_LEADING_GAP_PX;
	// Actions sit inside the title slot after the fixed text box; their constant
	// already counts the slot's internal gaps. No extra leading gap here.
	if (showTitleActions) chrome += HEADER_TITLE_ACTIONS_PX;
	chrome += HEADER_ROW_GAP_PX;
	chrome += HEADER_OVERFLOW_WIDTH_PX;
	if (showClose) chrome += HEADER_TOOLBAR_GAP_PX + HEADER_CLOSE_WIDTH_PX;

	// Complete title first.
	let titleWidth = titleFullWidth;
	const titleBudget = rowWidth - chrome;
	if (titleBudget < titleWidth) {
		titleWidth = Math.max(HEADER_TITLE_TEXT_MIN_PX, titleBudget);
	}

	// Toolbar pack: every visible tool costs item + the gap that follows it
	// (toward the next tool or the always-present overflow trigger).
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
		unmeasured: false,
	};
}
