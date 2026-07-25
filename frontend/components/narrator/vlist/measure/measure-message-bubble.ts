/**
 * measure-message-bubble.ts — Message-level measure TEMPLATE (batch-2 seed).
 *
 * Covers the two most common message shapes; subagents extend the block
 * dispatch (image / reasoning / web_search / system cards / tool blocks) by
 * delegating to the corresponding measure-*.ts.
 *
 *   - assistant text message: NO bubble frame; blocks stack with a small gap;
 *     text blocks flow through markdown (measure-markdown).
 *   - user message: a bubble (Paper p="sm") + a single header row (avatar +
 *     username + timestamp); body text is PLAIN pre-wrap (NOT markdown), and the
 *     bubble shrink-wraps to its widest line.
 *
 * Chrome constants come from the batch-1 exploration (see CONTRACT.md §4) and
 * pretext-fonts.ts. Zero DOM.
 */

import { prepareWithSegments } from "@chenglou/pretext";
import { MARKDOWN_CONSTANTS, parseMarkdownToPreparedBlocks } from "../parse-markdown";
import {
	accumulateFrame,
	type MeasuredElement,
	type PreparedBlock,
	type PreparedCodeBlock,
	type RenderLod,
} from "../prepared-block";
import { FONT_SIZE, LINE_HEIGHT, lineBoxHeight, SANS_FAMILY, SPACING } from "../pretext-fonts";
import { pretextLineMetrics } from "./pretext-metrics";

// ── Chrome constants (px) — from CONTRACT.md §4 / Mantine defaults ───────────
/** assistant block-to-block vertical gap. */
export const ASSISTANT_BLOCK_GAP = 4;
/** user bubble inner padding (Paper p="sm" = 12px). */
export const USER_BUBBLE_PADDING = SPACING.sm;
/** user bubble header row height (avatar 20 / username xs / timestamp xs). */
export const USER_HEADER_HEIGHT = 20;
/** gap between header and body inside the user bubble (Stack gap={4}). */
export const USER_HEADER_BODY_GAP = 4;
/**
 * Minimum inner content width for a user bubble WITH a header, so the header row
 * (avatar 20 + gap 6 + username + auto-margin timestamp) is not squeezed by a
 * short body. Without this, a 2-char message ("hi") shrink-wraps to a bubble far
 * narrower than the header needs, clipping the name/time. Height-neutral: only
 * widens the bubble frame, never the body's wrap width.
 */
export const USER_HEADER_MIN_CONTENT_WIDTH = 140;
/** assistant markdown wrapper: paddingInline = xs, paddingBlock = 0.25rem. */
export const ASSISTANT_PAD_X = SPACING.xs;
export const ASSISTANT_PAD_Y = 4; // 0.25rem ≈ 4px

const BODY_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.sm, LINE_HEIGHT.sm);
const USER_BODY_FONT = `400 ${FONT_SIZE.sm}px ${SANS_FAMILY}`;

export type MessageRole = "assistant" | "user";

export interface MeasureMessageInput {
	role: MessageRole;
	/** Visible text of the message (the common case). For assistant this is
	 * markdown; for user it is plain pre-wrap text. */
	text: string;
	/** True when the user header row (avatar/name/time) should be counted. */
	hasHeader?: boolean;
}

/**
 * Measure a simple text message element. Returns total height including the
 * element's own chrome (bubble padding + header for user; markdown insets for
 * assistant).
 */
export function measureMessageBubble(
	input: MeasureMessageInput,
	contentWidth: number,
	_lod: RenderLod = 5,
): MeasuredElement {
	return input.role === "user"
		? measureUserMessage(input, contentWidth)
		: measureAssistantMessage(input, contentWidth);
}

// ── assistant: markdown body, no bubble, small padding ───────────────────────
function measureAssistantMessage(
	input: MeasureMessageInput,
	contentWidth: number,
): MeasuredElement {
	const innerWidth = Math.max(1, contentWidth - ASSISTANT_PAD_X * 2);
	const blocks = parseMarkdownToPreparedBlocks(input.text);
	const frame = accumulateFrame(blocks, innerWidth, pretextLineMetrics, {
		codePaddingX: 12,
		codePaddingY: 8,
		codeLangExtraTop: MARKDOWN_CONSTANTS.CODE_LANG_EXTRA_TOP,
		quotePaddingY: MARKDOWN_CONSTANTS.BLOCKQUOTE_PADDING,
		quoteMarginTop: MARKDOWN_CONSTANTS.PARAGRAPH_MARGIN_TOP,
	});
	return {
		height: frame.contentHeight + ASSISTANT_PAD_Y * 2,
		blocks,
		frame,
		contentWidth: innerWidth,
		usedWidth: frame.usedWidth + ASSISTANT_PAD_X * 2,
	};
}

// ── user: plain pre-wrap body inside a shrink-wrapping bubble ─────────────────
function measureUserMessage(input: MeasureMessageInput, contentWidth: number): MeasuredElement {
	const innerWidth = Math.max(1, contentWidth - USER_BUBBLE_PADDING * 2);
	// User body text is PLAIN pre-wrap (not markdown): a single pre-wrap block.
	const bodyBlock: PreparedCodeBlock = {
		kind: "code",
		prepared: prepareWithSegments(input.text, USER_BODY_FONT, { whiteSpace: "pre-wrap" }),
		lineHeight: BODY_LINE_HEIGHT,
		lang: null,
		marginTop: 0,
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
	const blocks: PreparedBlock[] = [bodyBlock];
	// No code-box padding for plain user text (it's not a fenced block).
	const frame = accumulateFrame(blocks, innerWidth, pretextLineMetrics, {
		codePaddingX: 0,
		codePaddingY: 0,
		codeLangExtraTop: 0,
	});

	const hasHeader = input.hasHeader !== false;
	const headerHeight = hasHeader ? USER_HEADER_HEIGHT + USER_HEADER_BODY_GAP : 0;
	const height = USER_BUBBLE_PADDING * 2 + headerHeight + frame.contentHeight;
	// Shrink-wrap: bubble width = padding*2 + widest line (bounded by contentWidth).
	// With a header, floor the inner width at USER_HEADER_MIN_CONTENT_WIDTH so the
	// avatar/name/time row is not clipped by a short body. Height stays unchanged
	// (body wraps within `innerWidth`, which is unaffected).
	const innerUsed = Math.max(1, frame.usedWidth, hasHeader ? USER_HEADER_MIN_CONTENT_WIDTH : 0);
	const usedWidth = Math.min(contentWidth, USER_BUBBLE_PADDING * 2 + innerUsed);

	return { height, blocks, frame, contentWidth: innerWidth, usedWidth };
}

export const MEASURE_MESSAGE_CONSTANTS = {
	ASSISTANT_BLOCK_GAP,
	USER_BUBBLE_PADDING,
	USER_HEADER_HEIGHT,
	USER_HEADER_BODY_GAP,
	USER_HEADER_MIN_CONTENT_WIDTH,
	ASSISTANT_PAD_X,
	ASSISTANT_PAD_Y,
	BODY_LINE_HEIGHT,
} as const;
