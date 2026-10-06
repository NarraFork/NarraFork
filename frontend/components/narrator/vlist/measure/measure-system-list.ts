/**
 * measure-system-list.ts — List-shaped system cards (linearly predictable).
 *
 * Covers the batch-2 P6 family: `knowledge_hint`. This card renders a heading
 * line followed by N entry lines, and EVERY line is force-clamped to a single
 * line (heading + each entry are `truncate` / `lineClamp={1}`), so the height
 * depends ONLY on the entry COUNT — never on the text content, width, or LOD.
 * Height is therefore a pure linear function of N: zero pretext, zero DOM
 * measurement. The single block is a `PreparedFixedBlock`.
 *
 * Structure (see CONTRACT.md §4 + MessageBubble.tsx KnowledgeHintNotice):
 *
 *   ┌ Paper p="xs" (10) ───────────────────────────────────────────────────────┐
 *   │  <Group align="flex-start"> IconNotebook(14, mt=2)                        │
 *   │    <Stack gap={2}>                                                        │
 *   │       <Text xs dimmed fw600 truncate>   heading line       (1 line, 17px) │
 *   │       <Text xs indigo truncate>         entry #1           (1 line, 17px) │
 *   │       …                                 entry #N           (1 line, 17px) │
 *   │    </Stack>                                                               │
 *   └───────────────────────────────────────────────────────────────────────────┘
 *
 * The Stack holds (1 + N) single-line rows with N inter-row gaps of 2px; the
 * 14px icon (+2 top margin = 16px) is never taller than the Stack, so it does
 * not affect the height.
 *
 *   height = Paper padding(10)×2
 *          + (1 + N) rows × XS_LINE(17)
 *          + N gaps × STACK_GAP(2)
 *          = 37 + 19·N      (N=0→37, N=1→56, N=2→75; slope is a constant 19)
 *
 * Chrome constants come from CONTRACT.md §3/§4 and pretext-fonts.ts.
 */

import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type LineMetricsResolver,
	type MeasuredElement,
	type PreparedFixedBlock,
	type RenderLod,
} from "../prepared-block";
import {
	FONT_SIZE,
	LINE_HEIGHT,
	lineBoxHeight,
	SPACING,
	typographyMetrics,
} from "../pretext-fonts";

// ── Payload ──────────────────────────────────────────────────────────────────

/** One injected knowledge entry surfaced as a single truncated line. */
export interface KnowledgeHintEntry {
	/** Knowledge entry id (fallback label + navigation target). */
	entryId: string;
	/** Display title (falls back to entryId when absent). Height-neutral. */
	title?: string;
	/** Optional summary shown in the hover Tooltip. Height-neutral. */
	summary?: string;
}

/**
 * Render payload carried on the prepared block. The height is fully determined
 * by `entries.length` — neither `heading` nor any entry text affects it (every
 * line is clamped to one line). The renderer reads these to paint the card.
 */
export interface KnowledgeHintData {
	/** Pre-composed heading text (e.g. "Referenced 3 knowledge entries"). */
	heading: string;
	/** The injected entries, one truncated line each. Count decides the height. */
	entries: KnowledgeHintEntry[];
}

// ── Chrome constants (px) — CONTRACT.md §3/§4 + pretext-fonts.ts ──────────────

/** Paper p="xs" inner padding (top + bottom each). */
export const CARD_PADDING = SPACING.xs; // 10
/** xs single-line box height: round(12 × 1.4) = 17. */
export const XS_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17
/** Vertical gap between the heading and each entry row (Stack gap={2}). */
export const STACK_GAP = 2;

/** Height with zero entries: padding×2 + the lone heading line. ≈37px. */
export const KNOWLEDGE_HINT_BASE_HEIGHT = CARD_PADDING * 2 + XS_LINE_HEIGHT; // 37 (baseline)
export function knowledgeHintBaseHeight(): number {
	return CARD_PADDING * 2 + typographyMetrics().line.xs;
}
/** Extra height per additional entry row: one xs line + one Stack gap. =19px. */
export const KNOWLEDGE_HINT_HEIGHT_PER_ENTRY = XS_LINE_HEIGHT + STACK_GAP; // 19 (baseline)
export function knowledgeHintHeightPerEntry(): number {
	return typographyMetrics().line.xs + STACK_GAP;
}

/**
 * The linear height of a knowledge_hint card with `entryCount` entries:
 *   padding(10)×2 + (1 + N)·17 + N·2  ===  37 + 19·N
 * (heading line always present; each entry adds one clamped line + gap).
 */
export function knowledgeHintHeight(entryCount: number): number {
	const n = Math.max(0, entryCount);
	return knowledgeHintBaseHeight() + n * knowledgeHintHeightPerEntry();
}

/**
 * A no-op line resolver. This card contains only a `PreparedFixedBlock`, whose
 * height is intrinsic (`accumulateFrame` never calls the resolver for it), so
 * this module stays fully decoupled from pretext/canvas — tests need no stub.
 */
const NO_TEXT_MEASURE: LineMetricsResolver = () => ({ lineCount: 1, maxLineWidth: 0 });

/** Opaque tag stamped on the prepared block so the renderer knows what to draw. */
export const KNOWLEDGE_HINT_TAG = "knowledge_hint";

/**
 * Measure a knowledge_hint card. The height is a pure linear function of the
 * entry count and does not depend on any text content, `contentWidth`, or `lod`.
 * The full-width card uses `contentWidth` as its used width.
 */
export function measureKnowledgeHint(
	data: KnowledgeHintData,
	contentWidth: number,
	_lod: RenderLod = DEFAULT_RENDER_LOD,
): MeasuredElement {
	const entryCount = data.entries.length;
	const block: PreparedFixedBlock = {
		kind: "fixed",
		height: knowledgeHintHeight(entryCount),
		tag: KNOWLEDGE_HINT_TAG,
		data: {
			heading: data.heading,
			entries: data.entries.map((e) => ({
				entryId: e.entryId,
				title: e.title,
				summary: e.summary,
			})),
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

export const MEASURE_SYSTEM_LIST_CONSTANTS = {
	CARD_PADDING,
	XS_LINE_HEIGHT,
	STACK_GAP,
	KNOWLEDGE_HINT_BASE_HEIGHT,
	KNOWLEDGE_HINT_HEIGHT_PER_ENTRY,
} as const;
