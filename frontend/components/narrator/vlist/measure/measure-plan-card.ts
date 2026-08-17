/**
 * measure-plan-card.ts — Height model for the PlanCard (system compact message
 * with subtype "plan", non-editing state).
 *
 * Original component: MessageBubble.tsx `PlanCard` (~:4312). Shape:
 *   <Paper p="sm" radius="md" withBorder>
 *     <Group gap={6} mb={6}>            ← header row
 *       <IconListCheck size={16} />
 *       <Text size="xs" fw={600}>plan</Text>
 *       {optional right-aligned compact-xs action buttons}
 *     </Group>
 *     <MarkdownContent text={summary} />  ← markdown body (multi-line 🔴)
 *   </Paper>
 *
 * Height = Paper padding(sm=12)×2 + border(1)×2
 *        + header(≈max(icon16, xs-label 17[, button 18]) + mb 6)
 *        + markdown body height.
 *
 * The markdown body reuses `measureMarkdown` (default sm 14px body, matching
 * MarkdownContent). We take only its *content* height and add our own Paper
 * chrome + header — we do NOT stack the assistant markdown insets on top.
 *
 * Zero DOM. Body wrapping comes from pretext arithmetic inside measureMarkdown.
 */

import { DEFAULT_RENDER_LOD, type MeasuredElement, type RenderLod } from "../prepared-block";
import { FONT_SIZE, LINE_HEIGHT, lineBoxHeight, SPACING } from "../pretext-fonts";
import { measureMarkdown } from "./measure-markdown";

// ── Chrome constants (px) — from CONTRACT.md §3/§4 / Mantine defaults ─────────
/** Paper p="sm" inner padding (each side). */
export const PLAN_CARD_PADDING = SPACING.sm; // 12
/** withBorder = 1px border (each side). */
export const PLAN_CARD_BORDER = 1;
/** IconListCheck size=16 in the header row. */
export const PLAN_HEADER_ICON = 16;
/** Text size="xs" single line box (12 × 1.4 ≈ 17). */
export const PLAN_HEADER_LABEL_LINE = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs);
/** Optional right-aligned Button size="compact-xs" = 18px. */
export const PLAN_HEADER_BUTTON = 18;
/** Group mb={6} — gap between the header row and the markdown body. */
export const PLAN_HEADER_MB = 6;
/** radius="md" = 8px (visual only, does not affect height). */
export const PLAN_CARD_RADIUS = 8;

/** Header row height = tallest inline element in the Group. */
export function planCardHeaderHeight(hasActions: boolean): number {
	return hasActions
		? Math.max(PLAN_HEADER_ICON, PLAN_HEADER_LABEL_LINE, PLAN_HEADER_BUTTON)
		: Math.max(PLAN_HEADER_ICON, PLAN_HEADER_LABEL_LINE);
}

/** Fixed chrome around the markdown body (padding + border + header + mb). */
export function planCardChrome(hasActions: boolean): number {
	return (
		PLAN_CARD_PADDING * 2 + PLAN_CARD_BORDER * 2 + planCardHeaderHeight(hasActions) + PLAN_HEADER_MB
	);
}

export interface MeasurePlanCardInput {
	/** Plan summary in markdown (rendered by MarkdownContent). */
	summary: string;
	/** True when narratorId + messageId are present → edit/delete buttons show. */
	hasActions?: boolean;
}

/**
 * Measure a PlanCard element. Returns total height (Paper chrome + header +
 * markdown body). `blocks`/`frame`/`contentWidth` describe the *markdown body*
 * so the render layer can hand them straight to RenderMarkdown; `height` is the
 * whole card.
 */
export function measurePlanCard(
	data: MeasurePlanCardInput,
	contentWidth: number,
	_lod: RenderLod = DEFAULT_RENDER_LOD,
): MeasuredElement {
	const chrome = planCardChrome(data.hasActions ?? false);
	const innerWidth = Math.max(1, contentWidth - PLAN_CARD_PADDING * 2 - PLAN_CARD_BORDER * 2);
	const body = measureMarkdown(data.summary, innerWidth);
	return {
		height: chrome + body.frame.contentHeight,
		blocks: body.blocks,
		frame: body.frame,
		contentWidth: innerWidth,
		usedWidth: body.usedWidth + PLAN_CARD_PADDING * 2 + PLAN_CARD_BORDER * 2,
	};
}

export const MEASURE_PLAN_CARD_CONSTANTS = {
	PLAN_CARD_PADDING,
	PLAN_CARD_BORDER,
	PLAN_HEADER_ICON,
	PLAN_HEADER_LABEL_LINE,
	PLAN_HEADER_BUTTON,
	PLAN_HEADER_MB,
	PLAN_CARD_RADIUS,
} as const;
