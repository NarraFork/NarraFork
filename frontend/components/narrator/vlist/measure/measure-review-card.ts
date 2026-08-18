/**
 * measure-review-card.ts — a concluded code review, shaped like a tool card.
 *
 * ## Why not the two shapes that were tried first
 *
 * A review conclusion is a DOCUMENT: a verdict, then findings written in markdown with
 * inline code, file paths and fenced snippets, and it can run to several screens. The two
 * earlier attempts each failed on that:
 *
 *   - `system-simple` (one clamped line): showed one finding at best, and since the
 *     producer wrote no display text, none at all.
 *   - `system-text` inside an `injection-bubble`: a card nested in a bubble (two frames
 *     around one body), a badge lane reserved at a guessed 200px that the real badges did
 *     not fill (so the body wrapped in a column that did not line up with them), text
 *     painted line-by-line as PLAIN text (no markdown, no highlighting), and no overflow
 *     box — a long conclusion simply grew the row instead of scrolling.
 *
 * So this element borrows the tool card's proven arrangement instead: a header row that
 * says what this is, over a maxHeight-capped scroll box holding a real markdown body.
 * That is the same machinery `ExitPlanMode` uses for a plan (`measureMarkdownDetail`),
 * which is the closest existing thing — a long markdown document produced by an agent.
 *
 * ## Geometry
 *
 *   height = padding×2 + border×2
 *          + header row (icon / badges / action button)
 *          + markdown detail region (DETAIL_TOP_MARGIN + min(content, cap))
 *
 * The body's own geometry comes from `measureMarkdownDetail`, so it is NOT re-derived
 * here: that function owns the merged block list, the box padding and the cap, and a
 * second copy of those rules is how the two would drift. The cap can never clip, because
 * the box scrolls (see its doc comment).
 *
 * Zero DOM — the wrap comes from pretext arithmetic inside `measureMarkdown`.
 */

import type { ElementFrame, MeasuredElement, PreparedBlock } from "../prepared-block";
import { DEFAULT_RENDER_LOD, type RenderLod } from "../prepared-block";
import { FONT_SIZE, LINE_HEIGHT, lineBoxHeight, SPACING } from "../pretext-fonts";
import { DETAIL_CAPS, DETAIL_TOP_MARGIN, measureMarkdownDetail } from "./measure-tool-call";

// ── Chrome constants (px) ────────────────────────────────────────────────────

/** Paper p="sm" inner padding (each side), matching the tool card's shell. */
export const REVIEW_CARD_PADDING = SPACING.sm; // 12
/** withBorder = 1px border (each side). */
export const REVIEW_CARD_BORDER = 1;
/** Header icon (IconEyeCheck size=16). */
export const REVIEW_HEADER_ICON = 16;
/** Badge size="xs" visual height. */
export const REVIEW_HEADER_BADGE = 17;
/** Button size="compact-xs" height (the action). */
export const REVIEW_HEADER_BUTTON = 18;
/** xs single line box (12 × 1.4 ≈ 17) — the header's own label. */
export const REVIEW_HEADER_LABEL_LINE = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17
/** Gap between the header row and the body. */
export const REVIEW_HEADER_GAP = 6;

/**
 * The header is ONE row whose height is the tallest thing in it.
 *
 * Constant regardless of what the header shows: the button is the tallest element and is
 * always reserved, because handing the conclusion over flips its label while the row has
 * already been measured and cached. A conditional row would move a committed height.
 */
export function reviewCardHeaderHeight(): number {
	return Math.max(
		REVIEW_HEADER_ICON,
		REVIEW_HEADER_LABEL_LINE,
		REVIEW_HEADER_BADGE,
		REVIEW_HEADER_BUTTON,
	);
}

/** Fixed chrome around the body (padding + border + header + gap). */
export function reviewCardChrome(): number {
	return (
		REVIEW_CARD_PADDING * 2 + REVIEW_CARD_BORDER * 2 + reviewCardHeaderHeight() + REVIEW_HEADER_GAP
	);
}

/**
 * Cap for the body's scroll box.
 *
 * Borrowed from the `plan` cap rather than invented, because the content is the same
 * species: a long agent-authored markdown document the reader skims and scrolls.
 */
export const REVIEW_BODY_CAP = DETAIL_CAPS.plan; // 400

// ── Data ─────────────────────────────────────────────────────────────────────

export interface ReviewCardData {
	/** The conclusion body, markdown. */
	text: string;
	/** Verdict badge label, already localized by the adapter. */
	verdictLabel: string;
	/** Mantine colour for the badge / accents. */
	color?: string;
	/** "Revised" badge label; absent → the badge is not drawn. Height-neutral. */
	revisedLabel?: string;
	/** Action button label (Handle / Handled), always present. Height-neutral. */
	actionLabel?: string;
	/**
	 * A turn has already been started for this conclusion. Height-neutral — the action
	 * row is reserved either way; this only disables it and changes the label.
	 */
	applied?: boolean;
	/**
	 * `text` is only a prefix of the real conclusion → reserve the full cap, matching
	 * every other capped body. Present for symmetry with the plan path; conclusions are
	 * currently written whole.
	 */
	textTruncated?: boolean;
}

/** Geometry the review card's render copy needs on top of MeasuredElement. */
export interface MeasuredReviewCard extends MeasuredElement {
	/** Discriminates this element for the render layer. */
	form: "review-card";
	/** Top offset (px) of the body's scroll box inside the card. */
	bodyTop: number;
	/** Height (px) of that scroll box — already clamped by the cap. */
	bodyHeight: number;
	/** The cap the box was clamped to, forwarded as its `maxHeight`. */
	appliedCap: number;
	/** The markdown blocks cover only a prefix of `text` (hard ceiling hit). */
	isPrefix: boolean;
}

/** True when a measured element is the review-card form. */
export function isMeasuredReviewCard(measured: MeasuredElement): measured is MeasuredReviewCard {
	return (measured as MeasuredReviewCard).form === "review-card";
}

/**
 * Measure a review card at a content width.
 *
 * The body is measured through `measureMarkdownDetail`, whose result is already
 * "DETAIL_TOP_MARGIN + capped box". That outer margin is the tool card's gap between a
 * label and its box; here the header gap plays that role, so it is subtracted back out
 * and only the box travels — otherwise the two gaps would stack into a visible seam.
 */
export function measureReviewCard(
	data: ReviewCardData,
	contentWidth: number,
	_lod: RenderLod = DEFAULT_RENDER_LOD,
): MeasuredReviewCard {
	const innerWidth = Math.max(1, contentWidth - (REVIEW_CARD_PADDING + REVIEW_CARD_BORDER) * 2);
	const detail = measureMarkdownDetail(
		data.text ?? "",
		REVIEW_BODY_CAP,
		innerWidth,
		undefined,
		data.textTruncated,
	);
	// `measureMarkdownDetail` reports the box plus its own leading gap; this card supplies
	// that gap itself (REVIEW_HEADER_GAP), so take the box alone.
	const bodyHeight = Math.max(0, detail.height - DETAIL_TOP_MARGIN);
	const height = reviewCardChrome() + bodyHeight;

	// Re-based onto the box's coordinate space, the same transform the tool card's
	// markdown body applies: the measured frame's tops include DETAIL_TOP_MARGIN, and the
	// render copy offsets the whole box instead.
	const frame: ElementFrame = {
		...detail.frame,
		contentHeight: Math.max(0, detail.frame.contentHeight - DETAIL_TOP_MARGIN),
		blocks: detail.frame.blocks.map((b) => ({ ...b, top: b.top - DETAIL_TOP_MARGIN })),
	};

	return {
		form: "review-card",
		height,
		blocks: detail.blocks as PreparedBlock[],
		frame,
		contentWidth: detail.contentWidth,
		// A full-width card: a conclusion is a document to read, not an utterance to
		// attribute, so it does not shrink-wrap the way a speech bubble does.
		usedWidth: contentWidth,
		bodyTop:
			REVIEW_CARD_PADDING + REVIEW_CARD_BORDER + reviewCardHeaderHeight() + REVIEW_HEADER_GAP,
		bodyHeight,
		appliedCap: REVIEW_BODY_CAP,
		isPrefix: detail.isPrefix,
	};
}

export const MEASURE_REVIEW_CARD_CONSTANTS = {
	REVIEW_CARD_PADDING,
	REVIEW_CARD_BORDER,
	REVIEW_HEADER_ICON,
	REVIEW_HEADER_BADGE,
	REVIEW_HEADER_BUTTON,
	REVIEW_HEADER_LABEL_LINE,
	REVIEW_HEADER_GAP,
	REVIEW_BODY_CAP,
} as const;
