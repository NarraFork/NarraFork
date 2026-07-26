/**
 * measure-subagent-recovery.ts — The post-error "resume subagents" card.
 *
 * Structure mirrors SubagentRecoveryCard.tsx:
 *
 *   ┌ Paper p="sm" (12) ───────────────────────────────────────────────────────┐
 *   │  <Stack gap="xs" (10)>                                                   │
 *   │    <Group align="flex-start"> Icon(16)                                   │
 *   │      <Stack gap={2}>  title line (17)                                    │
 *   │                       description line (17)                              │
 *   │    <Checkbox.Group><Stack gap={4}>                                       │
 *   │        row #1 … row #N     (each max(checkbox 20, xs line 17) = 20)      │
 *   │    <Group justify="flex-end"> two Buttons size="compact-sm" (26)         │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * Every label row is `truncate`, so the height depends ONLY on the row COUNT —
 * not on text, width or LOD. It is therefore a pure linear function of N with
 * zero pretext and zero DOM measurement (single `PreparedFixedBlock`).
 *
 *   pending height = padding(12)×2
 *                  + header (2 lines × 17 + 1 inner gap × 2 = 36)
 *                  + stack gap (10) + N rows × 20 + (N-1) gaps × 4
 *                  + stack gap (10) + button row (26)
 *
 * The resolved state is a single dimmed line inside Paper p="xs".
 */

import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type LineMetricsResolver,
	type MeasuredElement,
	type PreparedFixedBlock,
	type RenderLod,
} from "../prepared-block";
import { FONT_SIZE, LINE_HEIGHT, lineBoxHeight, SPACING } from "../pretext-fonts";

// ── Payload ──────────────────────────────────────────────────────────────────

export interface SubagentRecoveryRow {
	id: string;
	title: string;
	subagentType: string;
	/** Foreground subagents get an extra "to background" badge. Height-neutral. */
	wasForeground?: boolean;
}

export type SubagentRecoveryKind = "pending" | "resolved";

export interface SubagentRecoveryData {
	kind: SubagentRecoveryKind;
	/** Card title line. Height-neutral (single truncated line). */
	title: string;
	/** Description line. Height-neutral (single truncated line). */
	description: string;
	/** The listed subagents; the COUNT is what drives the height. */
	subagents: SubagentRecoveryRow[];
	/** Resolved-state summary line. Height-neutral. */
	summary?: string;
	/** Button captions. Height-neutral. */
	notifyLabel?: string;
	waitLabel?: string;
	backgroundBadge?: string;
}

/**
 * Row indices the user has UNCHECKED, threaded through `opts` so the measure
 * cache key tracks the checkboxes. The card starts with everything selected, so
 * the generic (initially empty) per-row index set naturally means "deselected".
 */
export interface MeasureSubagentRecoveryOpts {
	deselected?: readonly number[];
}

// ── Chrome constants (px) — CONTRACT.md §3/§4 + pretext-fonts.ts ──────────────

/** Paper p="sm" inner padding (top + bottom each). */
export const CARD_PADDING = SPACING.sm; // 12
/** Paper p="xs" padding used by the resolved variant. */
export const RESOLVED_PADDING = SPACING.xs; // 10
/** xs single-line box height: round(12 × 1.4) = 17. */
export const XS_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17
/** Outer Stack gap="xs". */
export const STACK_GAP = SPACING.xs; // 10
/** Header inner Stack gap={2} between title and description. */
export const HEADER_INNER_GAP = 2;
/** Checkbox size="xs" control box; the row never shrinks below it. */
export const CHECKBOX_CONTROL_SIZE = 20;
/** One checkbox row: max(control, xs text line). */
export const ROW_HEIGHT = Math.max(CHECKBOX_CONTROL_SIZE, XS_LINE_HEIGHT); // 20
/** Checkbox list Stack gap={4}. */
export const ROW_GAP = 4;
/** Button size="compact-sm" height. */
export const BUTTON_ROW_HEIGHT = 26;
/**
 * Maximum rows the card lists, mirroring the caps the other measured details use
 * (META_ROWS_MAX = 12, ENTRY_MAX = 10). The server already limits its query to 50
 * subagents, but the height is a pure linear function of the row count, so an
 * unexpected payload would otherwise reserve a multi-thousand-pixel card.
 */
export const ROWS_MAX = 12;

/** Title + description, two clamped lines with one inner gap. */
export const HEADER_HEIGHT = XS_LINE_HEIGHT * 2 + HEADER_INNER_GAP; // 36

/** Pending height with zero rows: padding + header + button row. */
export const PENDING_BASE_HEIGHT = CARD_PADDING * 2 + HEADER_HEIGHT + STACK_GAP + BUTTON_ROW_HEIGHT;
/** Extra height per listed subagent: one row plus its preceding gap. */
export const PENDING_HEIGHT_PER_ROW = ROW_HEIGHT + ROW_GAP; // 24

/** Resolved height: a single dimmed line inside Paper p="xs". */
export const RESOLVED_HEIGHT = RESOLVED_PADDING * 2 + XS_LINE_HEIGHT; // 37

/**
 * Linear height of the pending card:
 *   padding×2 + header + gap + (N rows + N-1 gaps) + gap + buttons
 * With N = 0 the checkbox stack collapses entirely (no gap, no rows).
 */
export function subagentRecoveryPendingHeight(rowCount: number): number {
	const n = Math.max(0, rowCount);
	if (n === 0) return PENDING_BASE_HEIGHT;
	const rows = STACK_GAP + n * ROW_HEIGHT + (n - 1) * ROW_GAP;
	return PENDING_BASE_HEIGHT + rows;
}

export function subagentRecoveryHeight(kind: SubagentRecoveryKind, rowCount: number): number {
	return kind === "resolved" ? RESOLVED_HEIGHT : subagentRecoveryPendingHeight(rowCount);
}

/**
 * No-op line resolver: this card holds a single `PreparedFixedBlock` whose
 * height is intrinsic, so `accumulateFrame` never calls it. Keeps the module
 * decoupled from pretext/canvas — tests need no stub.
 */
const NO_TEXT_MEASURE: LineMetricsResolver = () => ({ lineCount: 1, maxLineWidth: 0 });

/** Opaque tag stamped on the prepared block so the renderer knows what to draw. */
export const SUBAGENT_RECOVERY_TAG = "subagent_recovery";

/**
 * Measure a subagent-recovery card. The height is a pure linear function of the
 * row count and does not depend on text content, `contentWidth` or `lod`. The
 * selected ids in `opts` do not change the height but DO participate in the
 * measure cache key, so a toggle re-renders with a fresh payload.
 */
export function measureSubagentRecovery(
	data: SubagentRecoveryData,
	contentWidth: number,
	_lod: RenderLod = DEFAULT_RENDER_LOD,
	opts?: MeasureSubagentRecoveryOpts,
): MeasuredElement {
	// Clamped so the card's height stays bounded; the renderer draws the same slice.
	const rows = (Array.isArray(data.subagents) ? data.subagents : []).slice(0, ROWS_MAX);
	const kind: SubagentRecoveryKind = data.kind === "resolved" ? "resolved" : "pending";
	const block: PreparedFixedBlock = {
		kind: "fixed",
		height: subagentRecoveryHeight(kind, rows.length),
		tag: SUBAGENT_RECOVERY_TAG,
		data: {
			kind,
			title: data.title,
			description: data.description,
			summary: data.summary,
			notifyLabel: data.notifyLabel,
			waitLabel: data.waitLabel,
			backgroundBadge: data.backgroundBadge,
			subagents: rows.map((row) => ({
				id: row.id,
				title: row.title,
				subagentType: row.subagentType,
				wasForeground: row.wasForeground === true,
			})),
			deselected: [...(opts?.deselected ?? [])],
		} as Record<string, unknown>,
		marginTop: 0,
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
	const blocks: PreparedFixedBlock[] = [block];
	const frame = accumulateFrame(blocks, contentWidth, NO_TEXT_MEASURE);
	return {
		height: frame.contentHeight,
		blocks,
		frame,
		contentWidth,
		usedWidth: contentWidth,
	};
}

export const MEASURE_SUBAGENT_RECOVERY_CONSTANTS = {
	CARD_PADDING,
	RESOLVED_PADDING,
	XS_LINE_HEIGHT,
	STACK_GAP,
	HEADER_INNER_GAP,
	CHECKBOX_CONTROL_SIZE,
	ROW_HEIGHT,
	ROW_GAP,
	ROWS_MAX,
	BUTTON_ROW_HEIGHT,
	HEADER_HEIGHT,
	PENDING_BASE_HEIGHT,
	PENDING_HEIGHT_PER_ROW,
	RESOLVED_HEIGHT,
} as const;
