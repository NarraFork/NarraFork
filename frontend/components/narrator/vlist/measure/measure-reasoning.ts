/**
 * measure-reasoning.ts — Height model for the `reasoning` / `thinking` block.
 *
 * Visual parity target: MessageBubble.tsx ReasoningBlock (:2041) +
 * ReasoningCountLine.tsx. The block has four visual FORMS, chosen by LOD +
 * expand state (this is why the height model MUST take both as input):
 *
 *   1. "streaming"  — streaming with NO text yet: a single dimmed row
 *        Group py={2} + chevron 12 + ThemeIcon 16 + "thinking…" (xs).
 *   2. "count"      — low LOD (L1/L2), collapsed: ReasoningCountLine, a single
 *        row Group py={2} + ThemeIcon 16 (IconBrain 10) + "reasoning" +
 *        "N steps" (xs) + chevron 12. (See CONTRACT §4 ReasoningCountLine.)
 *   3. "collapsed"  — L3..L6, not expanded: header only, a single row
 *        Group py={2} + chevron 12 + ThemeIcon 16 + "reasoning" + char count +
 *        an 80-char truncated preview (truncate → forced single line).
 *   4. "expanded"   — header row + body. Body is
 *        Box pl="md"(16) py={4} borderLeft:2px  containing MarkdownContent.
 *        Streaming WITH text is always shown expanded (live full feedback).
 *
 * IMPORTANT — body font size: CONTRACT §4 / WBS-batch2 P1 describe the expanded
 * body as "markdown(xs 12px)". That is INACCURATE for the real render:
 * MarkdownContent.module.css hard-codes paragraphs / list items / strong / em /
 * headings / links to `font-size: var(--mantine-font-size-sm)` (14px); the
 * wrapper's `fontSize: xs` only affects bare text nodes, which react-markdown
 * never emits (it always wraps content in a paragraph). So the body renders at
 * sm (14px body text, 12px code),
 * which is EXACTLY what parseMarkdownToPreparedBlocks / measureMarkdown already
 * model. We therefore reuse measureMarkdown as-is — no xs markdown variant is
 * needed. (Reported back to the main agent; no CONTRACT/skeleton change needed.)
 *
 * Height (per form):
 *   streaming / count / collapsed → HEADER_ROW_HEIGHT (fixed single row)
 *   expanded → HEADER_ROW_HEIGHT + BODY_PADDING_Y*2 + markdownHeight
 *              (+ TRANSLATION_TOGGLE_HEIGHT when a translation toggle is shown)
 *
 * TRANSLATION: a translated run shows its translation by default and the toggle
 * flips to the original. Both texts wrap differently, so `showOriginal` is an
 * INPUT to the measure (expandState) rather than a paint-time swap — otherwise
 * the body would be drawn at the other language's predicted height.
 *
 * Zero DOM. Follows the measure-markdown.ts / measure-web-search.ts template.
 */

import type { MeasuredElement, RenderLod } from "../prepared-block";
import { FONT_SIZE, LINE_HEIGHT, lineBoxHeight, SPACING } from "../pretext-fonts";
import { measureMarkdown } from "./measure-markdown";

// ── Chrome constants (px) — from CONTRACT.md §4 + ReasoningBlock / CountLine ──
/** Group py={2} on every header / count / streaming row. */
export const REASONING_ROW_PADDING_Y = 2;
/** ThemeIcon size={16} (holds IconBrain 10). */
export const REASONING_ICON_SIZE = 16;
/** IconChevronRight / IconChevronDown size={12}. */
export const REASONING_CHEVRON_SIZE = 12;
/** xs text line box: round(12 * 1.4) = 17px. */
export const REASONING_XS_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs);

/**
 * Fixed single-row height shared by the streaming / count / collapsed forms and
 * the header of the expanded form: py*2 + max(icon lane, xs text line).
 */
export const REASONING_HEADER_ROW_HEIGHT =
	REASONING_ROW_PADDING_Y * 2 + Math.max(REASONING_ICON_SIZE, REASONING_XS_LINE_HEIGHT);

/** ReasoningCountLine row height (identical structure to the header row). */
export const REASONING_COUNT_LINE_HEIGHT = REASONING_HEADER_ROW_HEIGHT;

/** Expanded body Box py={4}. */
export const REASONING_BODY_PADDING_Y = 4;
/** Expanded body Box pl="md" (16px). */
export const REASONING_BODY_PADDING_LEFT = SPACING.md;
/** Expanded body Box borderLeft: 2px. */
export const REASONING_BODY_BORDER_LEFT = 2;

/**
 * Translation-toggle row shown inside the expanded body when both original and
 * translated text exist: Group mt={4} + (IconLanguage 12 + xs text). Modeled as
 * mt(4) + one xs line.
 */
export const REASONING_TRANSLATION_TOGGLE_MARGIN_TOP = 4;
export const REASONING_TRANSLATION_TOGGLE_HEIGHT =
	REASONING_TRANSLATION_TOGGLE_MARGIN_TOP + REASONING_XS_LINE_HEIGHT;

/** The four visual forms of a reasoning block. */
export type ReasoningForm = "streaming" | "count" | "collapsed" | "expanded";

export interface ReasoningBlockData {
	/** Raw reasoning text (merged run text). */
	text?: string | null;
	/** Optional translated text; when present it is the displayed text. */
	translatedText?: string | null;
	/** True while the reasoning run is still streaming. */
	isStreaming?: boolean;
	/** Number of reasoning steps / blocks (for the count line + header). */
	stepCount?: number;
	/** Char-count override for the header; defaults to displayText.length. */
	charCount?: number;
}

export interface ReasoningExpandState {
	/** Whether the block is expanded (resolved upstream from LOD + user pref). */
	expanded?: boolean;
	/**
	 * Reader asked for the ORIGINAL text of a translated run.
	 *
	 * Height-affecting: the two languages wrap differently, so the choice must
	 * reach the measure layer rather than being applied at paint time (that is
	 * what made the toggle unusable on the exact path — see the shell's
	 * `showOriginal` interaction state).
	 */
	showOriginal?: boolean;
}

/**
 * The reasoning measure result — a MeasuredElement (structural superset) plus
 * the form + geometry the renderer needs to draw the correct shape. `blocks` /
 * `frame` carry the markdown body ONLY in the expanded form (empty otherwise).
 */
export interface MeasuredReasoning extends MeasuredElement {
	/** Which of the four visual forms was measured. */
	form: ReasoningForm;
	/** Fixed header/count/streaming row height (px). */
	headerHeight: number;
	/** Top offset (px) where the markdown body begins (expanded form only). */
	bodyTop: number;
	/** Left offset (px) of the body content (pl + border), expanded only. */
	bodyLeft: number;
	/** The text that would be displayed (translated when available). */
	displayText: string;
	/** Character count shown in the header. */
	charCount: number;
	/** Reasoning step count shown in the count line. */
	stepCount: number;
	/** True when a translation toggle row is included in the body height. */
	hasTranslationToggle: boolean;
	/**
	 * True when the body currently shows the ORIGINAL text of a translated run.
	 * Drives the toggle's wording (show-original vs show-translated); the renderer
	 * has no other way to tell which side is on screen.
	 */
	showingOriginal: boolean;
	/** Mirrors data.isStreaming (renderer shimmer gate). */
	isStreaming: boolean;
}

/**
 * Resolve the displayed text: translated text wins when present, unless the
 * reader explicitly asked for the original (`showOriginal`).
 */
export function resolveReasoningDisplayText(
	data: ReasoningBlockData,
	expandState: ReasoningExpandState = {},
): string {
	const raw = data.text ?? "";
	if (expandState.showOriginal && raw.length > 0) return raw;
	const translated = data.translatedText;
	if (typeof translated === "string" && translated.length > 0) return translated;
	return raw;
}

/** True when both raw + translated text exist (translation toggle is shown). */
function hasTranslation(data: ReasoningBlockData): boolean {
	return (
		typeof data.translatedText === "string" &&
		data.translatedText.length > 0 &&
		typeof data.text === "string" &&
		data.text.length > 0
	);
}

/**
 * Decide the visual form from (data, lod, expandState). Pure function — this is
 * the height/shape main switch and MUST be deterministic for the same inputs.
 */
export function resolveReasoningForm(
	data: ReasoningBlockData,
	lod: RenderLod,
	expandState: ReasoningExpandState = {},
): ReasoningForm {
	const displayText = resolveReasoningDisplayText(data, expandState);
	// Streaming with no content yet → minimal "thinking…" row.
	if (data.isStreaming && displayText.length === 0) return "streaming";
	// Streaming with content is always shown in full (live feedback).
	if (data.isStreaming) return "expanded";
	// An explicit expand (user override or L5/L6 opened pref) wins over LOD.
	if (expandState.expanded) return "expanded";
	// Low LOD collapses to the single "reasoning ×N" count line.
	if (lod <= 2) return "count";
	// L3..L6 collapsed → header only.
	return "collapsed";
}

/** Inner content width (px) of the expanded body (inside pl + borderLeft). */
export function reasoningBodyInnerWidth(contentWidth: number): number {
	return Math.max(1, contentWidth - REASONING_BODY_PADDING_LEFT - REASONING_BODY_BORDER_LEFT);
}

const EMPTY_FRAME = { blocks: [], contentHeight: 0, usedWidth: 0 } as const;

/**
 * Measure a reasoning/thinking block at a content width. Deterministic, zero DOM.
 * @param data         reasoning block data (text/translatedText/isStreaming/…)
 * @param contentWidth available OUTER width in px
 * @param lod          render LOD (1..6) — selects count vs header/body form
 * @param expandState  resolved expand decision (expanded?)
 */
export function measureReasoning(
	data: ReasoningBlockData,
	contentWidth: number,
	lod: RenderLod = 5,
	expandState: ReasoningExpandState = {},
): MeasuredReasoning {
	const displayText = resolveReasoningDisplayText(data, expandState);
	// `charCount` is a HEADER label, so it must describe the text actually shown.
	// The adapter's precomputed value always describes the default (translated)
	// side, hence it is only honoured while that side is on screen.
	const showingOriginal = !!expandState.showOriginal && hasTranslation(data);
	const charCount = showingOriginal ? displayText.length : (data.charCount ?? displayText.length);
	const stepCount = data.stepCount ?? 1;
	const form = resolveReasoningForm(data, lod, expandState);

	// Non-expanded forms are a single fixed row; no markdown body is rendered.
	if (form !== "expanded") {
		return {
			height: REASONING_HEADER_ROW_HEIGHT,
			blocks: [],
			frame: { ...EMPTY_FRAME, blocks: [] },
			contentWidth,
			usedWidth: contentWidth,
			form,
			headerHeight: REASONING_HEADER_ROW_HEIGHT,
			bodyTop: REASONING_HEADER_ROW_HEIGHT,
			bodyLeft: 0,
			displayText,
			charCount,
			stepCount,
			hasTranslationToggle: false,
			showingOriginal,
			isStreaming: !!data.isStreaming,
		};
	}

	// Expanded: header row + body (markdown at sm, see file header note).
	const innerWidth = reasoningBodyInnerWidth(contentWidth);
	const md = measureMarkdown(displayText, innerWidth);
	const withToggle = hasTranslation(data);
	const toggleHeight = withToggle ? REASONING_TRANSLATION_TOGGLE_HEIGHT : 0;

	const bodyTop = REASONING_HEADER_ROW_HEIGHT;
	const bodyLeft = REASONING_BODY_PADDING_LEFT + REASONING_BODY_BORDER_LEFT;
	const height =
		REASONING_HEADER_ROW_HEIGHT +
		REASONING_BODY_PADDING_Y * 2 +
		md.frame.contentHeight +
		toggleHeight;

	return {
		height,
		// Body markdown blocks/frame flow through to the renderer (RenderMarkdown).
		blocks: md.blocks,
		frame: md.frame,
		// contentWidth is the body inner width so the renderer re-materializes
		// markdown line ranges at the exact width they were measured for.
		contentWidth: innerWidth,
		usedWidth: contentWidth,
		form,
		headerHeight: REASONING_HEADER_ROW_HEIGHT,
		bodyTop,
		bodyLeft,
		displayText,
		charCount,
		stepCount,
		hasTranslationToggle: withToggle,
		showingOriginal,
		isStreaming: !!data.isStreaming,
	};
}

/** Parse once, measure many (e.g. on resize / LOD change). Reusable closure. */
export function prepareReasoningMeasurer(
	data: ReasoningBlockData,
): (
	contentWidth: number,
	lod?: RenderLod,
	expandState?: ReasoningExpandState,
) => MeasuredReasoning {
	return (contentWidth, lod = 5, expandState = {}) =>
		measureReasoning(data, contentWidth, lod, expandState);
}

export const MEASURE_REASONING_CONSTANTS = {
	REASONING_ROW_PADDING_Y,
	REASONING_ICON_SIZE,
	REASONING_CHEVRON_SIZE,
	REASONING_XS_LINE_HEIGHT,
	REASONING_HEADER_ROW_HEIGHT,
	REASONING_COUNT_LINE_HEIGHT,
	REASONING_BODY_PADDING_Y,
	REASONING_BODY_PADDING_LEFT,
	REASONING_BODY_BORDER_LEFT,
	REASONING_TRANSLATION_TOGGLE_HEIGHT,
} as const;
