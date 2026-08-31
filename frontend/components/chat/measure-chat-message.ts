/**
 * measure-chat-message.ts — Deterministic, zero-DOM height for one chat bubble.
 *
 * Follows the same three-layer model as the narrator list (see
 * `vlist/CONTRACT.md`), and reuses the SAME pure kernel
 * (`@shared/pretext-layout/`):
 *
 *   1. Prepared  (once, width-free)  — markdown → PreparedBlock[]
 *   2. Frame     (per width)         — accumulateFrame → per-block top/height
 *   3. Render    (in viewport)       — RenderChatMessage, absolute positioning
 *
 * ## Why this is not the narrator vlist
 *
 * Two reasons, both structural rather than stylistic:
 *
 *  - `vlist-isolation.guard.test.ts` fails the build if ANY file outside
 *    `vlist/` statically imports it. Chat would have to dynamically import the
 *    whole pretext document pipeline to reuse `PretextExactMessageList`.
 *  - That shell is built around the narrator DOCUMENT model (message trees, tool
 *    cards, streaming deltas, compact markers, live patches, LOD tiers) and is
 *    keyed on `narratorId` + `messageVersion`. A chat message is an avatar, a
 *    name, a timestamp and a markdown body.
 *
 * The pure kernel has no such isolation rule (`ChunkedMessageList`,
 * `MessageBubble` and others import it directly), so chat gets the same
 * arithmetic with its own thin shell.
 *
 * ## Zero DOM, and no unknown heights
 *
 * Math support is deliberately NOT injected and remote images are not inlined, so
 * the parse can never emit a `PreparedUnknownBlock`. That means chat needs no
 * ResizeObserver correction pass and no height-override table: every height here
 * is final. Supporting formulas or mermaid later would require the
 * unknown-height forwarding contract (CONTRACT.md §4.5) and is out of scope.
 */

import { MARKDOWN_CONSTANTS } from "@shared/pretext-layout/parse-markdown";
import {
	accumulateFrame,
	type MeasuredElement,
	type PreparedBlock,
} from "@shared/pretext-layout/prepared-block";
import { getPreparedMarkdownBlocks } from "@shared/pretext-layout/prepared-markdown-cache";
import {
	FONT_SIZE,
	LINE_HEIGHT,
	lineBoxHeight,
	scaledLineBoxHeight,
} from "@shared/pretext-layout/pretext-fonts";
import { pretextLineMetrics } from "@shared/pretext-layout/pretext-metrics";

// ─────────────────────────────────────────────────────────────────────────────
// Chrome constants
//
// Every value here is a fixed decoration: it does not depend on the text, so it
// never needs measuring. They mirror what RenderChatMessage draws — the two must
// change together, which is what `measure-chat-message.test.ts` pins.
// ─────────────────────────────────────────────────────────────────────────────

/** Bubble inner padding (Mantine `p="sm"` = 12px) on each side. */
export const CHAT_BUBBLE_PADDING_X = 12;
export const CHAT_BUBBLE_PADDING_Y = 10;

/** Header row: avatar (20px) beside the username + timestamp, both `xs`. */
export const CHAT_HEADER_HEIGHT = 20;
/** Gap between the header row and the body. */
export const CHAT_HEADER_GAP = 4;

/** Quote strip shown when the message replies to another (single clamped line). */
export const CHAT_REPLY_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs);
/** chatReplyLineHeight() at the reader's typography (baseline above). */
export function chatReplyLineHeight(): number {
	return scaledLineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs);
}
export const CHAT_REPLY_GAP = 4;
/** Left rail + its inner padding for the quote strip. */
export const CHAT_REPLY_RAIL = 3;
export const CHAT_REPLY_PADDING_X = 6;

/** Vertical gap between two consecutive bubbles in the list. */
export const CHAT_MESSAGE_GAP = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Attachment chrome
//
// Attachments are laid out ONE PER ROW rather than wrapped inline. A wrapping row
// would make the block's height depend on how many items happen to fit at the
// current width, which is a second wrap calculation the measure layer would have to
// reproduce exactly — and the height contract has no tolerance for "approximately".
// Stacking makes the height a plain sum.
// ─────────────────────────────────────────────────────────────────────────────

/** Gap between the attachment block and the text body below it. */
export const CHAT_ATTACHMENT_BLOCK_GAP = 6;
/** Gap between two stacked attachments. */
export const CHAT_ATTACHMENT_GAP = 4;
/** Thumbnail box the image is fitted into (aspect preserved, never upscaled). */
export const CHAT_IMAGE_MAX_WIDTH = 240;
export const CHAT_IMAGE_MAX_HEIGHT = 180;
/**
 * Height reserved for an image whose dimensions are unknown.
 *
 * Reachable only for a malformed row: the upload path parses dimensions
 * fail-closed, so a stored image always has them. A fixed fallback keeps such a row
 * renderable instead of collapsing it to zero height.
 */
export const CHAT_IMAGE_FALLBACK_HEIGHT = 120;
/** One-line chip for a non-image attachment (icon + name + size). */
export const CHAT_FILE_CHIP_HEIGHT = 28;
/** Minimum width a file chip needs before its label visibly clips. */
export const CHAT_FILE_CHIP_MIN_WIDTH = 180;

/**
 * Fenced-code chrome inside a bubble. Same values as the narrator markdown
 * measure so a code block does not change size between the two surfaces
 * (`MEASURE_MARKDOWN_CODE_PADDING` is inside `vlist/`, which this module may not
 * import — see the header — so the numbers are restated with that provenance).
 */
const CODE_PADDING_Y = 11;
const CODE_PADDING_X = 12;

/**
 * Single source of the code-panel padding for both layers.
 *
 * The render layer must position lines with the SAME padding the measure layer
 * subtracted from the wrap width, so the two read one constant rather than each
 * writing its own number.
 */
export const CHAT_CODE_PADDING = { x: CODE_PADDING_X, y: CODE_PADDING_Y } as const;

/**
 * A deleted message renders one italic placeholder line instead of a body.
 * Fixed height, because the placeholder text is ours, not the author's.
 */
export const CHAT_DELETED_BODY_HEIGHT = lineBoxHeight(FONT_SIZE.sm, LINE_HEIGHT.sm);
/** chatDeletedBodyHeight() at the reader's typography (baseline above). */
export function chatDeletedBodyHeight(): number {
	return scaledLineBoxHeight(FONT_SIZE.sm, LINE_HEIGHT.sm);
}

/**
 * Ceiling on the body text a single bubble measures and draws.
 *
 * The server caps a message at `CHAT_MESSAGE_MAX_CHARS` (8k), so this is a
 * defence-in-depth bound for anything that reaches the client by another route
 * (an older row, a future import path). Measure and render must use the SAME
 * prefix or the drawn text would not fit the measured box.
 */
export const CHAT_BODY_MAX_CHARS = 8_000;

/**
 * Minimum inner width a header row needs before it would visibly clip.
 *
 * A floor rather than a measurement: the header is avatar + name + timestamp, all
 * single-line and truncatable, so its exact width never changes the HEIGHT. The
 * floor exists only so shrink-wrap does not squeeze a one-word message into a box
 * narrower than its own header.
 */
export const CHAT_HEADER_MIN_CONTENT_WIDTH = 160;
/** Same idea for the quote strip's rail + padding. */
export const CHAT_REPLY_MIN_CONTENT_WIDTH = 120;
/** Same idea for the "message deleted" placeholder line. */
export const CHAT_DELETED_MIN_CONTENT_WIDTH = 120;

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

/** Just enough of an attachment to reserve its space (no bytes, no DOM). */
export interface ChatAttachmentMeasureData {
	kind: "image" | "file";
	/** Intrinsic pixel size, images only. Absent → the fallback height is used. */
	width?: number | null;
	height?: number | null;
}

export interface ChatMessageMeasureData {
	/** Markdown body. Empty when the message was soft-deleted. */
	text: string;
	/** Soft-deleted: the body is replaced by a fixed placeholder line. */
	deleted?: boolean;
	/** Quoted message preview, already truncated by the caller. */
	replyPreview?: string | null;
	/**
	 * Whether to reserve the quote strip, independent of whether there is text to
	 * put in it.
	 *
	 * Explicit rather than inferred from a non-empty `replyPreview`, which was the
	 * previous rule and silently dropped the strip in exactly the cases that need a
	 * label instead of a quote: a target that was deleted, and (before snapshots) a
	 * target outside the loaded window. Both are still replies, and a reply whose
	 * strip vanishes reads as an ordinary message answering nothing.
	 *
	 * Optional so an omitted value keeps the old inference, which remains correct for
	 * the plain "quote with text" case.
	 */
	hasReply?: boolean;
	/**
	 * Consecutive message from the same author within the grouping window — the
	 * header row is omitted, so the bubble is exactly `CHAT_HEADER_HEIGHT +
	 * CHAT_HEADER_GAP` shorter.
	 */
	grouped?: boolean;
	/**
	 * Attachments drawn above the text body.
	 *
	 * Dimensions come from the SERVER (parsed at upload time), never from loading the
	 * image: a height that depended on a network fetch would arrive after the row was
	 * already laid out, and the list has no unknown-height correction pass.
	 */
	attachments?: readonly ChatAttachmentMeasureData[];
}

/** One attachment's reserved box, in bubble-content coordinates. */
export interface MeasuredChatAttachment {
	kind: "image" | "file";
	top: number;
	width: number;
	height: number;
}

export interface MeasuredChatMessage extends MeasuredElement {
	/** Height of the body area alone (used by the render layer's body box). */
	bodyHeight: number;
	/** Whether the header row was included. */
	hasHeader: boolean;
	/** Whether the quote strip was included. */
	hasReply: boolean;
	/** True when the body is the deleted placeholder rather than markdown. */
	isDeletedPlaceholder: boolean;
	/** The exact text the render layer must draw (already prefix-bounded). */
	bodyText: string;
	/** Per-attachment boxes, in order. Empty when there are none. */
	attachments: MeasuredChatAttachment[];
	/** Total height of the attachment block, including its gap to the body. */
	attachmentsHeight: number;
}

/**
 * Language tags the parser turns into an unknown-height placeholder.
 *
 * `mermaid` is the only one: the parser cannot predict an SVG's height from its
 * source, so it emits `PreparedUnknownBlock` and expects the render layer to
 * measure the real diagram once and report a correction. Chat does NOT implement
 * that forwarding contract (CONTRACT.md §4.5) and has no mermaid renderer, so a
 * placeholder would reserve a height nothing ever fills.
 *
 * Retagging is the honest degradation: the fence becomes an ordinary code block,
 * so the reader sees the diagram SOURCE — which is all chat could show anyway —
 * and the height is exact. The retag is visible in the rendered language label,
 * not silent.
 */
const UNKNOWN_HEIGHT_CODE_LANGS = /^([ \t]*(?:`{3,}|~{3,}))[ \t]*mermaid[ \t]*$/gim;

/** Chat's rendering language: mermaid downgraded to a plain fence (see above). */
function neutralizeUnknownHeightBlocks(text: string): string {
	if (!text.includes("mermaid")) return text;
	return text.replace(UNKNOWN_HEIGHT_CODE_LANGS, "$1");
}

/** Clip the body to the shared measure/render bound. */
export function boundChatBody(text: string): string {
	const neutralized = neutralizeUnknownHeightBlocks(text);
	return neutralized.length > CHAT_BODY_MAX_CHARS
		? neutralized.slice(0, CHAT_BODY_MAX_CHARS)
		: neutralized;
}

/**
 * Parsed + prepared blocks for a chat body, memoised across widths.
 *
 * Deliberately passes `undefined` math support and a constant revision: chat does
 * not render formulas (see the header), so there is no async runtime whose
 * arrival would invalidate these entries.
 */
export function preparedChatBlocks(text: string): PreparedBlock[] {
	return getPreparedMarkdownBlocks(boundChatBody(text), undefined, "chat");
}

// ─────────────────────────────────────────────────────────────────────────────
// Measure
// ─────────────────────────────────────────────────────────────────────────────

export interface MeasureChatMessageOptions {
	/** Reuse already-parsed blocks (skip the marked.lexer pass). */
	preparedBlocks?: PreparedBlock[];
}

/**
 * Measure one chat bubble at a given OUTER width.
 *
 * `outerWidth` is the width available to the bubble; the body wraps at
 * `outerWidth - padding*2`. The returned `usedWidth` is the shrink-wrapped bubble
 * width (never more than `outerWidth`), so a short message does not draw a
 * full-width box.
 */
export function measureChatMessage(
	data: ChatMessageMeasureData,
	outerWidth: number,
	opts: MeasureChatMessageOptions = {},
): MeasuredChatMessage {
	const contentWidth = Math.max(1, outerWidth - CHAT_BUBBLE_PADDING_X * 2);
	const hasHeader = !data.grouped;
	// Explicit flag wins; the preview-derived fallback covers callers that predate it.
	const hasReply = data.hasReply ?? !!data.replyPreview?.trim();
	const attachmentsInput = data.attachments ?? [];
	// An attachment carries a message on its own, so a body-less message with
	// attachments is NOT the deleted placeholder — rendering it as one would
	// mislabel an image-only post as removed.
	const isDeletedPlaceholder =
		!!data.deleted || (!data.text.trim() && attachmentsInput.length === 0);
	const bodyText = isDeletedPlaceholder ? "" : boundChatBody(data.text);
	const hasBody = !isDeletedPlaceholder && !!data.text.trim();

	const blocks =
		isDeletedPlaceholder || !hasBody ? [] : (opts.preparedBlocks ?? preparedChatBlocks(data.text));

	const frame = accumulateFrame(blocks, contentWidth, pretextLineMetrics, {
		codePaddingX: CODE_PADDING_X,
		codePaddingY: CODE_PADDING_Y,
		codeLangExtraTop: MARKDOWN_CONSTANTS.CODE_LANG_EXTRA_TOP,
		quotePaddingY: MARKDOWN_CONSTANTS.BLOCKQUOTE_PADDING,
		quoteMarginTop: MARKDOWN_CONSTANTS.PARAGRAPH_MARGIN_TOP,
	});

	const bodyHeight = isDeletedPlaceholder ? chatDeletedBodyHeight() : frame.contentHeight;

	// A soft-deleted message reports no attachments from the server, but measuring
	// defensively here keeps the height right even if a stale cached row still has
	// them: the placeholder replaces the whole content area.
	const { attachments, attachmentsHeight, attachmentsUsedWidth } = isDeletedPlaceholder
		? { attachments: [], attachmentsHeight: 0, attachmentsUsedWidth: 0 }
		: measureAttachments(attachmentsInput, contentWidth, hasBody);

	let height = CHAT_BUBBLE_PADDING_Y * 2 + bodyHeight + attachmentsHeight;
	if (hasHeader) height += CHAT_HEADER_HEIGHT + CHAT_HEADER_GAP;
	if (hasReply) height += chatReplyLineHeight() + CHAT_REPLY_GAP;

	// Shrink-wrap: the box is as wide as its widest line, floored by the header
	// (which must not be clipped) and capped by the space it was given.
	const headerFloor = hasHeader ? CHAT_HEADER_MIN_CONTENT_WIDTH : 0;
	const replyFloor = hasReply ? CHAT_REPLY_MIN_CONTENT_WIDTH : 0;
	const innerUsed = Math.max(
		isDeletedPlaceholder ? CHAT_DELETED_MIN_CONTENT_WIDTH : frame.usedWidth,
		headerFloor,
		replyFloor,
		// Without this floor a one-word caption would shrink the bubble narrower than
		// the thumbnail it contains, and the image would be clipped by the bubble's
		// own `overflow: hidden`.
		attachmentsUsedWidth,
	);
	const usedWidth = Math.min(outerWidth, Math.ceil(innerUsed) + CHAT_BUBBLE_PADDING_X * 2);

	return {
		height,
		blocks,
		frame,
		// The render layer MUST wrap at the same width the frame was measured at,
		// not at `usedWidth - padding*2` (which is narrower after shrink-wrap and
		// would re-wrap the text into a taller box than the one reserved).
		contentWidth,
		usedWidth,
		bodyHeight,
		hasHeader,
		hasReply,
		isDeletedPlaceholder,
		bodyText,
		attachments,
		attachmentsHeight,
	};
}

/**
 * Reserve space for the attachment block: pure arithmetic, one item per row.
 *
 * An image is fitted into `CHAT_IMAGE_MAX_WIDTH × CHAT_IMAGE_MAX_HEIGHT` preserving
 * aspect ratio and NEVER upscaled — a 40×40 avatar stays 40×40 rather than being
 * blown up to a blurry 240px box. The available content width also caps it, so a
 * narrow bubble does not reserve a box wider than itself.
 *
 * `hasBody` decides whether the trailing gap to the text is charged: an
 * attachment-only message has no body to separate from, and charging the gap anyway
 * would leave a visible strip of dead space at the bottom of the bubble.
 */
function measureAttachments(
	attachments: readonly ChatAttachmentMeasureData[],
	contentWidth: number,
	hasBody: boolean,
): {
	attachments: MeasuredChatAttachment[];
	attachmentsHeight: number;
	attachmentsUsedWidth: number;
} {
	if (attachments.length === 0) {
		return { attachments: [], attachmentsHeight: 0, attachmentsUsedWidth: 0 };
	}

	const measured: MeasuredChatAttachment[] = [];
	let top = 0;
	let usedWidth = 0;

	for (let index = 0; index < attachments.length; index++) {
		const attachment = attachments[index];
		if (index > 0) top += CHAT_ATTACHMENT_GAP;

		let width: number;
		let height: number;
		if (attachment.kind === "image") {
			const boxWidth = Math.min(CHAT_IMAGE_MAX_WIDTH, contentWidth);
			const intrinsicWidth = attachment.width ?? 0;
			const intrinsicHeight = attachment.height ?? 0;
			if (intrinsicWidth > 0 && intrinsicHeight > 0) {
				// `min(1, …)` is the no-upscale rule; both axes are constrained so a very
				// tall screenshot is bounded by the height, not just the width.
				const scale = Math.min(
					1,
					boxWidth / intrinsicWidth,
					CHAT_IMAGE_MAX_HEIGHT / intrinsicHeight,
				);
				width = Math.max(1, Math.round(intrinsicWidth * scale));
				height = Math.max(1, Math.round(intrinsicHeight * scale));
			} else {
				width = boxWidth;
				height = CHAT_IMAGE_FALLBACK_HEIGHT;
			}
		} else {
			width = Math.min(contentWidth, Math.max(CHAT_FILE_CHIP_MIN_WIDTH, contentWidth));
			height = CHAT_FILE_CHIP_HEIGHT;
		}

		measured.push({ kind: attachment.kind, top, width, height });
		usedWidth = Math.max(usedWidth, width);
		top += height;
	}

	return {
		attachments: measured,
		attachmentsHeight: top + (hasBody ? CHAT_ATTACHMENT_BLOCK_GAP : 0),
		attachmentsUsedWidth: usedWidth,
	};
}

/** Parse once, measure many (resize). Returns a reusable closure. */
export function prepareChatMessageMeasurer(
	data: ChatMessageMeasureData,
): (outerWidth: number) => MeasuredChatMessage {
	const preparedBlocks = data.deleted || !data.text.trim() ? [] : preparedChatBlocks(data.text);
	return (outerWidth: number) => measureChatMessage(data, outerWidth, { preparedBlocks });
}

/**
 * Cache-key contribution for a message's attachments.
 *
 * ⚠️ The measure cache keys on this. Anything that changes an attachment's reserved
 * box must appear here or the key will match a stale entry and the new content will
 * be drawn into the old box (chat-measure-cache.ts documents the same hazard for the
 * text signature). Today that is the count, each item's kind, and each image's
 * intrinsic dimensions.
 */
export function attachmentsSignature(
	attachments: readonly ChatAttachmentMeasureData[] | undefined,
): string {
	if (!attachments || attachments.length === 0) return "";
	return attachments
		.map((attachment) => `${attachment.kind}:${attachment.width ?? ""}x${attachment.height ?? ""}`)
		.join(",");
}
