/**
 * measure-reflection-notice.ts — Height model for the reflection notice
 * (danger / plan / task / question gates).
 *
 * WHY THIS EXISTS
 *
 * The chunked tool card renders `ReflectionNotice` INSTEAD of the permission form
 * whenever a gate is running or has resolved (ToolCallCard.tsx:5419). The exact
 * vlist first reproduced that by MOUNTING the real component through the
 * integration bridge and correcting the row height after paint (ResizeObserver →
 * heightOverrides). That broke the list's core invariant — a committed row's
 * height must never change unless the USER acted — because the row settled one
 * frame after mounting and pushed every row below it while the reader was merely
 * scrolling past.
 *
 * The notice is entirely predictable, so nothing about it warranted the dynamic
 * path: its data (`permissionSuggestions`) already ships with every `tool_use`
 * block, and its layout is a fixed icon column beside up to three text rows plus
 * an optional button. This module measures exactly that, zero DOM.
 *
 * ── Geometry (parity target: ToolCallCard.tsx ReflectionNotice :1684) ──────────
 *
 *   ┌ Paper withBorder radius="sm" p="sm"(12) ─────────────────────────────────┐
 *   │  Group gap="sm"(12) wrap="nowrap" align="flex-start"                     │
 *   │    ThemeIcon size="sm"(22) mt={1}        ← fixed left column             │
 *   │    Box flex=1 minWidth=0                                                 │
 *   │      title       Text xs fw700 lh={1.35}          (wraps 🔴)             │
 *   │      [summary]   Text xs lh={1.45} mt={3}         (wraps 🔴)             │
 *   │      [nextSteps] Text xs lh={1.45} mt={3}         (wraps 🔴)             │
 *   │      [button]    Group mt="xs"(10) → Button xs (30)                      │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * The three text rows are `PreparedInlineBlock`s measured with pretext against
 * the width remaining right of the icon column; the button row is a fixed block.
 *
 * ── The one status-driven height change (deliberate) ──────────────────────────
 *
 * Only a RUNNING gate shows the manual-takeover button, so a gate resolving
 * (running → confirmed) removes a 40px row. That transition is WS-driven, not
 * user-driven, which would violate the invariant for a committed row — so the
 * height is measured at the RUNNING maximum and stays there: `reserveTakeOver`
 * keeps the button's space reserved once a gate has occupied it. See
 * `measureReflectionNotice`'s `reserveTakeOver` option.
 *
 * Follows the measure-permission.ts template.
 */

import { prepareRichInline, type RichInlineItem } from "@chenglou/pretext/rich-inline";
import type { ReflectionNoticeData } from "@shared/pretext-layout/reflection";
import {
	accumulateFrame,
	type MeasuredElement,
	type PreparedBlock,
	type PreparedFixedBlock,
	type PreparedInlineBlock,
} from "../prepared-block";
import { FONT_SIZE, FONT_WEIGHT, lineBoxHeight, SANS_FAMILY, SPACING } from "../pretext-fonts";
import { pretextLineMetrics } from "./pretext-metrics";

// ─────────────────────────────────────────────────────────────────────────────
// Chrome constants (px) — Mantine ground truth.
// ─────────────────────────────────────────────────────────────────────────────

/** Paper p="sm" (12) on every side. */
export const NOTICE_PADDING = SPACING.sm; // 12
/** Paper withBorder → 1px. */
export const NOTICE_BORDER = 1;
/** Fixed vertical chrome: padding×2 + border×2. */
export const NOTICE_VERTICAL_CHROME = NOTICE_PADDING * 2 + NOTICE_BORDER * 2; // 26
/** Fixed horizontal chrome: padding×2 + border×2. */
export const NOTICE_HORIZONTAL_CHROME = NOTICE_PADDING * 2 + NOTICE_BORDER * 2; // 26

/** ThemeIcon size="sm" → 22px square. */
export const NOTICE_ICON_SIZE = 22;
/** Group gap="sm" (12) between the icon column and the text column. */
export const NOTICE_ICON_GAP = SPACING.sm; // 12
/** Left indent of every text row (icon column + gap). */
export const NOTICE_TEXT_INDENT = NOTICE_ICON_SIZE + NOTICE_ICON_GAP; // 34

/** Title: Text size="xs" fw={700} lh={1.35} → round(12 × 1.35) = 16. */
export const NOTICE_TITLE_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, 1.35); // 16
export const NOTICE_TITLE_FONT = `${FONT_WEIGHT.bold} ${FONT_SIZE.xs}px ${SANS_FAMILY}`;

/** Summary / nextSteps: Text size="xs" lh={1.45} → round(12 × 1.45) = 17. */
export const NOTICE_BODY_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, 1.45); // 17
export const NOTICE_BODY_FONT = `${FONT_WEIGHT.regular} ${FONT_SIZE.xs}px ${SANS_FAMILY}`;
/** Both body rows carry `mt={3}`. */
export const NOTICE_BODY_MARGIN_TOP = 3;

/** Manual-takeover Button size="xs" → 30px, inside a `Group mt="xs"`(10). */
export const NOTICE_BUTTON_HEIGHT = 30;
export const NOTICE_BUTTON_MARGIN_TOP = SPACING.xs; // 10

/**
 * External top margin the OWNER (tool card) adds — the notice's own
 * `marginTop: var(--mantine-spacing-xs)`. Kept out of the element height for the
 * same reason InlinePermission does it: the card owns inter-region spacing.
 */
export const NOTICE_TOP_MARGIN = SPACING.xs; // 10

export type ReflectionBlockRole = "title" | "summary" | "next-steps" | "take-over";

export interface ReflectionBlockMeta {
	role: ReflectionBlockRole;
}

export interface MeasuredReflectionNotice extends MeasuredElement {
	/** Parallel to `blocks` — the render role of each block. */
	metas: ReflectionBlockMeta[];
	/** External top margin the tool card should add above this region. */
	topMargin: number;
	/** Whether the takeover button is actually PAINTED (running gates only). */
	hasTakeOver: boolean;
	/** Reflection kind (render-only: icon + colour). */
	kind?: ReflectionNoticeData["kind"];
	/** Reflection status (render-only: icon + colour). */
	status?: ReflectionNoticeData["status"];
	/** Gate request id the takeover call targets (render-only). */
	requestId?: string;
}

export interface MeasureReflectionNoticeOpts {
	/**
	 * Reserve the takeover button row even when the gate is no longer running.
	 *
	 * A gate resolving (running → confirmed) is a SERVER event: without this the
	 * row would silently shrink by 40px and shift the whole list below it, which
	 * is exactly the invariant this module exists to protect. Callers that cannot
	 * prove the gate was never running should pass `true`.
	 */
	reserveTakeOver?: boolean;
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
		contentLeft: NOTICE_TEXT_INDENT,
	};
}

function makeFixed(height: number, tag: string): PreparedFixedBlock {
	return {
		...baseBlockFields(),
		kind: "fixed",
		height,
		tag,
		contentLeft: NOTICE_TEXT_INDENT,
	};
}

/**
 * Measure a reflection notice.
 *
 * @param data          localized title + optional summary / nextSteps + flags
 * @param contentWidth  available OUTER Paper width in px
 * @param opts          reserveTakeOver (see MeasureReflectionNoticeOpts)
 */
export function measureReflectionNotice(
	data: ReflectionNoticeData,
	contentWidth: number,
	opts: MeasureReflectionNoticeOpts = {},
): MeasuredReflectionNotice {
	// Text wraps against the width left of the icon column, inside the padding.
	const textWidth = Math.max(1, contentWidth - NOTICE_HORIZONTAL_CHROME - NOTICE_TEXT_INDENT);

	const blocks: PreparedBlock[] = [];
	const metas: ReflectionBlockMeta[] = [];
	const push = (block: PreparedBlock, meta: ReflectionBlockMeta, marginTop: number) => {
		block.marginTop = blocks.length === 0 ? 0 : marginTop;
		blocks.push(block);
		metas.push(meta);
	};

	push(
		makeInline(data.title, NOTICE_TITLE_FONT, NOTICE_TITLE_LINE_HEIGHT, "vlist-reflection-title"),
		{ role: "title" },
		0,
	);

	if (data.summary) {
		push(
			makeInline(
				data.summary,
				NOTICE_BODY_FONT,
				NOTICE_BODY_LINE_HEIGHT,
				"vlist-reflection-summary",
			),
			{ role: "summary" },
			NOTICE_BODY_MARGIN_TOP,
		);
	}

	if (data.nextSteps) {
		push(
			makeInline(
				data.nextSteps,
				NOTICE_BODY_FONT,
				NOTICE_BODY_LINE_HEIGHT,
				"vlist-reflection-next-steps",
			),
			{ role: "next-steps" },
			NOTICE_BODY_MARGIN_TOP,
		);
	}

	// The button row is reserved whenever the gate is running OR the caller asked
	// for the running maximum, so a gate resolving never shrinks the row.
	const hasTakeOver = data.hasTakeOver === true;
	if (hasTakeOver || opts.reserveTakeOver === true) {
		push(
			makeFixed(NOTICE_BUTTON_HEIGHT, "take-over"),
			{ role: "take-over" },
			NOTICE_BUTTON_MARGIN_TOP,
		);
	}

	// Text is measured at `textWidth`; the frame is accumulated over the same
	// width so every block's wrap width matches what the render layer paints.
	const frame = accumulateFrame(blocks, textWidth, pretextLineMetrics);
	// The icon (22 + mt 1) can be taller than a lone one-line title, so the
	// content box is at least as tall as the icon column.
	const contentHeight = Math.max(frame.contentHeight, NOTICE_ICON_SIZE + 1);

	return {
		height: NOTICE_VERTICAL_CHROME + contentHeight,
		blocks,
		frame,
		contentWidth: textWidth,
		usedWidth: contentWidth,
		metas,
		topMargin: NOTICE_TOP_MARGIN,
		hasTakeOver,
		...(data.kind ? { kind: data.kind } : {}),
		...(data.status ? { status: data.status } : {}),
		...(data.requestId ? { requestId: data.requestId } : {}),
	};
}

/** Parse once, measure many (e.g. on resize). Returns a reusable closure. */
export function prepareReflectionNoticeMeasurer(
	data: ReflectionNoticeData,
): (contentWidth: number, opts?: MeasureReflectionNoticeOpts) => MeasuredReflectionNotice {
	return (contentWidth, opts = {}) => measureReflectionNotice(data, contentWidth, opts);
}

export const MEASURE_REFLECTION_CONSTANTS = {
	NOTICE_PADDING,
	NOTICE_BORDER,
	NOTICE_VERTICAL_CHROME,
	NOTICE_HORIZONTAL_CHROME,
	NOTICE_ICON_SIZE,
	NOTICE_ICON_GAP,
	NOTICE_TEXT_INDENT,
	NOTICE_TITLE_LINE_HEIGHT,
	NOTICE_BODY_LINE_HEIGHT,
	NOTICE_BODY_MARGIN_TOP,
	NOTICE_BUTTON_HEIGHT,
	NOTICE_BUTTON_MARGIN_TOP,
	NOTICE_TOP_MARGIN,
} as const;
