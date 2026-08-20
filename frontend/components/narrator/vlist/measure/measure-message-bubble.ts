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

import { measureLineStats, measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";
import { fitImageBox, readImageIntrinsicSize } from "@shared/pretext-layout/image-fit";
import { getPreparedTextWithSegments } from "@shared/pretext-layout/prepared-markdown-cache";
import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type ElementFrame,
	type MeasuredElement,
	type PreparedBlock,
	type PreparedCodeBlock,
	type PreparedFixedBlock,
	type RenderLod,
} from "../prepared-block";
import {
	FONT_SIZE,
	FONT_WEIGHT,
	LINE_HEIGHT,
	lineBoxHeight,
	MONO_FAMILY,
	SANS_FAMILY,
	SPACING,
} from "../pretext-fonts";
import { measureMarkdown } from "./measure-markdown";
import { IMAGE_FIXED_HEIGHT, IMAGE_MAX_DISPLAY_HEIGHT, TEXT_FILE_HEIGHT } from "./measure-media";
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
/** Stack gap between a user bubble's attachments and its body text (Stack gap={4}). */
export const USER_ATTACHMENT_GAP = 4;
/**
 * Minimum inner width for a bubble carrying attachments. A dimensionless image
 * paints at its intrinsic aspect ratio inside the reserved 200px-tall box, so
 * the measure layer cannot know its width; this floor keeps a short/absent
 * caption from shrink-wrapping the bubble narrower than the image it contains.
 * (An image WITH persisted dimensions reports its fitted width directly and
 * widens the bubble beyond this floor when wider.) Matches the classic
 * ImageBlock's Skeleton placeholder width (300). Height-neutral.
 */
export const USER_ATTACHMENT_MIN_CONTENT_WIDTH = 300;
/** assistant markdown wrapper: paddingInline = xs, paddingBlock = 0.25rem. */
export const ASSISTANT_PAD_X = SPACING.xs;
export const ASSISTANT_PAD_Y = 4; // 0.25rem ≈ 4px

const BODY_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.sm, LINE_HEIGHT.sm);
const USER_BODY_FONT = `400 ${FONT_SIZE.sm}px ${SANS_FAMILY}`;

// ── Slash-command bubble chrome ──────────────────────────────────────────────
/**
 * A user message produced by a slash command is stored EXPANDED: `commandText`
 * keeps the short `/name args` the user typed while the text block holds the full
 * prompt template the server substituted in. Painting that expansion as the body
 * turns a one-line command into a screen-tall block, so the bubble mirrors the
 * classic renderer instead: the command line, a single clamped preview line of
 * the expansion, and — only when the preview is actually clipped — a toggle row
 * that reveals the whole prompt on demand.
 *
 * Height consequence: a command bubble is a CONSTANT height until the user
 * clicks the toggle, regardless of how long the expansion is.
 */
/** Command line: sm monospace, weight 500, forced single line (truncate). */
export const COMMAND_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.sm, LINE_HEIGHT.sm);
/** Clamped preview line of the expansion: xs, forced single line. */
export const COMMAND_PREVIEW_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs);
/** "Show / hide expanded prompt" control row: xs single line. */
export const COMMAND_TOGGLE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs);
/**
 * Chevron glyph on the toggle row (12px, matching the reasoning / trace headers).
 * Height-neutral: it sits inside the xs line box, which is 17px tall.
 */
export const COMMAND_CHEVRON_SIZE = 12;
/** Stack gap={4} between the command line, the preview, and the toggle. */
export const COMMAND_ROW_GAP = 4;
/** Command line font (monospace sm, medium weight) — matches the render copy. */
export const COMMAND_LINE_FONT = `${FONT_WEIGHT.medium} ${FONT_SIZE.sm}px ${MONO_FAMILY}`;
/** Expansion preview / toggle font (xs sans). */
export const COMMAND_PREVIEW_FONT = `${FONT_WEIGHT.regular} ${FONT_SIZE.xs}px ${SANS_FAMILY}`;
/**
 * Chars of the expansion fed to the preview / expanded-body measurement.
 *
 * The collapsed preview only ever shows one line, so a bounded prefix is enough
 * to decide "does it overflow one line". The EXPANDED body is measured from the
 * same bounded prefix: a command expansion is a prompt template (observed at a
 * few KB), and capping keeps a pathological multi-megabyte expansion off the
 * synchronous layout path. Matching prefixes also guarantee the render copy
 * paints exactly the text that was measured.
 */
export const COMMAND_EXPANSION_MAX_CHARS = 32 * 1024;

export type MessageRole = "assistant" | "user";

/**
 * One attachment carried INSIDE a user bubble (image / text file). Mirrors
 * MessageBubble, which renders every block of a user message — not only the
 * text ones. `type` and (for images) the intrinsic `width`/`height` are the
 * height-relevant fields; the rest is render data.
 */
export interface MeasureUserAttachment {
	type: string;
	imageId?: string | null;
	previewUrl?: string | null;
	filename?: string | null;
	mediaType?: string | null;
	size?: number | null;
	/** Intrinsic pixel size persisted at upload time — drives aspect fitting. */
	width?: number | null;
	height?: number | null;
	uploadNarratorId?: string | null;
	/**
	 * Text-file attachment's on-disk path. HEIGHT-NEUTRAL passthrough: the row is
	 * always TEXT_FILE_HEIGHT, this only lets the render layer make it clickable.
	 */
	filePath?: string | null;
}

export interface MeasureMessageInput {
	role: MessageRole;
	/** Visible text of the message (the common case). For assistant this is
	 * markdown; for user it is plain pre-wrap text. */
	text: string;
	/** True when the user header row (avatar/name/time) should be counted. */
	hasHeader?: boolean;
	/** User bubbles: image / text_file attachments stacked above the body text. */
	attachments?: readonly MeasureUserAttachment[];
	/**
	 * Slash command the user typed. When present the bubble switches to the
	 * command form: `commandText` on its own line and `text` (the server-side
	 * expansion) folded behind a toggle instead of painted as the body.
	 */
	commandText?: string | null;
}

/** Expand state for a slash-command bubble's folded expansion. */
export interface MessageBubbleExpandState {
	/** True when the user revealed the expanded prompt. */
	expanded?: boolean;
	/** Localized toggle labels (measured: the control row is a text line). */
	showLabel?: string;
	hideLabel?: string;
}

/** Geometry a command bubble's render copy needs, on top of MeasuredElement. */
export interface MeasuredCommandBubble extends MeasuredElement {
	/** Discriminates the command form from a plain bubble. */
	form: "command";
	/** The command line text (`/name args`). */
	commandText: string;
	/** Bounded expansion text that was measured (what the render copy paints). */
	expansionText: string;
	/** True when the expansion does not fit the single clamped preview line. */
	overflows: boolean;
	/** True when the expansion is currently revealed in full. */
	expanded: boolean;
	/** Top offset (px) of the command line inside the bubble. */
	commandTop: number;
	/** Top offset (px) of the preview / expanded body. */
	bodyTop: number;
	/** Top offset (px) of the toggle row; -1 when no toggle is shown. */
	toggleTop: number;
	/** Toggle row label for the current state. */
	toggleLabel: string;
}

/** True when a measured bubble is the slash-command form. */
export function isMeasuredCommandBubble(
	measured: MeasuredElement,
): measured is MeasuredCommandBubble {
	return (measured as MeasuredCommandBubble).form === "command";
}

/**
 * Measure a simple text message element. Returns total height including the
 * element's own chrome (bubble padding + header for user; markdown insets for
 * assistant).
 */
export function measureMessageBubble(
	input: MeasureMessageInput,
	contentWidth: number,
	_lod: RenderLod = DEFAULT_RENDER_LOD,
	expandState: MessageBubbleExpandState = {},
): MeasuredElement {
	if (input.role === "user" && input.commandText) {
		return measureCommandMessage(input, contentWidth, expandState);
	}
	return input.role === "user"
		? measureUserMessage(input, contentWidth)
		: measureAssistantMessage(input, contentWidth);
}

// ── assistant: markdown body, no bubble, small padding ───────────────────────
/**
 * Measure an assistant message: the markdown body plus this element's own insets.
 *
 * DELEGATES to `measureMarkdown` rather than re-running `accumulateFrame` here.
 * The two are painted by the SAME renderer — `RenderMessageBubble`'s assistant
 * branch hands the measured element straight to `RenderMarkdown`, whose code panel
 * reads `MEASURE_MARKDOWN_CODE_PADDING` — so a second copy of the code-chrome
 * constants is a divergence waiting to happen. It already had: this measured
 * fenced code at `codePaddingY: 8` while the renderer drew 11 (10 xs + 1 border,
 * per HighlightedCode.module.css), losing 6px per code block, and
 * `CODE_PANEL_BORDER`'s compensation assumed 11 as well.
 */
function measureAssistantMessage(
	input: MeasureMessageInput,
	contentWidth: number,
): MeasuredElement {
	const innerWidth = Math.max(1, contentWidth - ASSISTANT_PAD_X * 2);
	// Assistant text is the main markdown surface, so it is also where LaTeX shows
	// up. Math support is undefined until KaTeX loads; formulas then stay literal
	// text and the layout rebuilds once the runtime revision bumps. (Reached via
	// measureMarkdown's own preparedMarkdownBlocks call.)
	const measured = measureMarkdown(input.text, innerWidth);
	return {
		...measured,
		height: measured.height + ASSISTANT_PAD_Y * 2,
		usedWidth: measured.usedWidth + ASSISTANT_PAD_X * 2,
	};
}

/**
 * Build the fixed block reserving one user attachment's box. Heights mirror the
 * media measures the classic path renders with, so no DOM measurement is
 * involved: an image WITH persisted intrinsic dimensions reserves the
 * aspect-ratio-fitted box (the same `fitImageBox` formula the render layer
 * paints), an image WITHOUT them reserves the fixed 200px placeholder, and a
 * text file keeps its single row.
 *
 * The fitted image also reports its `displayWidth`: the bubble shrink-wraps
 * around it, so a wide screenshot widens the bubble up to the column instead
 * of being squeezed into whatever width the caption text happened to wrap to.
 */
function attachmentBlock(
	attachment: MeasureUserAttachment,
	marginTop: number,
	innerWidth: number,
): PreparedFixedBlock | null {
	const isImage = attachment.type === "image";
	if (!isImage && attachment.type !== "text_file") return null;
	const natural = isImage ? readImageIntrinsicSize(attachment.width, attachment.height) : null;
	const fit = natural ? fitImageBox(natural, innerWidth, IMAGE_MAX_DISPLAY_HEIGHT) : null;
	return {
		kind: "fixed",
		marginTop,
		height: isImage ? (fit?.displayHeight ?? IMAGE_FIXED_HEIGHT) : TEXT_FILE_HEIGHT,
		tag: isImage ? "user-image" : "user-text-file",
		...(fit ? { displayWidth: fit.displayWidth } : {}),
		data: {
			imageId: attachment.imageId ?? null,
			previewUrl: attachment.previewUrl ?? null,
			filename: attachment.filename ?? null,
			mediaType: attachment.mediaType ?? null,
			size: typeof attachment.size === "number" ? attachment.size : null,
			uploadNarratorId: attachment.uploadNarratorId ?? null,
			// Render-only (see MeasureUserAttachment.filePath): does not touch height.
			filePath: attachment.filePath ?? null,
			...(natural && fit
				? {
						width: natural.width,
						height: natural.height,
						displayWidth: fit.displayWidth,
						displayHeight: fit.displayHeight,
					}
				: {}),
		},
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
}

// ── user: plain pre-wrap body inside a shrink-wrapping bubble ─────────────────
function measureUserMessage(input: MeasureMessageInput, contentWidth: number): MeasuredElement {
	const innerWidth = Math.max(1, contentWidth - USER_BUBBLE_PADDING * 2);
	const blocks: PreparedBlock[] = [];
	// Attachments (images / text files) stack ABOVE the body text, inside the same
	// bubble — the block order MessageBubble renders (server persists attachment
	// blocks before the text block).
	for (const attachment of input.attachments ?? []) {
		const block = attachmentBlock(
			attachment,
			blocks.length === 0 ? 0 : USER_ATTACHMENT_GAP,
			innerWidth,
		);
		if (block) blocks.push(block);
	}
	const hasAttachments = blocks.length > 0;
	// User body text is PLAIN pre-wrap (not markdown): a single pre-wrap block.
	// An attachment-only message has no text block at all (an empty pre-wrap block
	// would still reserve one line, leaving a blank gap under the image).
	if (input.text.length > 0 || !hasAttachments) {
		const bodyBlock: PreparedCodeBlock = {
			kind: "code",
			// Cross-width memo (see prepared-markdown-cache): the segment precompute is
			// width-independent and is the dominant cost of a user bubble.
			prepared: getPreparedTextWithSegments(input.text, USER_BODY_FONT, "pre-wrap"),
			lineHeight: BODY_LINE_HEIGHT,
			lang: null,
			marginTop: hasAttachments ? USER_ATTACHMENT_GAP : 0,
			contentLeft: 0,
			quoteRailLefts: [],
			markerText: null,
			markerLeft: null,
			markerClassName: null,
		};
		blocks.push(bodyBlock);
	}
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
	// (body wraps within `innerWidth`, which is unaffected). An attachment whose
	// display size is known from data (an image with persisted dimensions) reports
	// its fitted `displayWidth` through the frame, so the bubble WIDENS around a
	// wide screenshot up to the column; a dimensionless image keeps the
	// USER_ATTACHMENT_MIN_CONTENT_WIDTH floor instead.
	const innerUsed = Math.max(
		1,
		frame.usedWidth,
		hasHeader ? USER_HEADER_MIN_CONTENT_WIDTH : 0,
		hasAttachments ? USER_ATTACHMENT_MIN_CONTENT_WIDTH : 0,
	);
	const usedWidth = Math.min(contentWidth, USER_BUBBLE_PADDING * 2 + innerUsed);

	return { height, blocks, frame, contentWidth: innerWidth, usedWidth };
}

// ── user + slash command: command line, folded expansion ─────────────────────
/**
 * Measure a slash-command bubble.
 *
 * Collapsed (the default) is a CONSTANT height: header + command line + one
 * clamped preview line + an optional toggle row. The expansion's real wrapped
 * height only enters the total once the user expands it, so a 5000-char prompt
 * template occupies the same space as a 20-char one until it is opened.
 */
function measureCommandMessage(
	input: MeasureMessageInput,
	contentWidth: number,
	expandState: MessageBubbleExpandState,
): MeasuredCommandBubble {
	const innerWidth = Math.max(1, contentWidth - USER_BUBBLE_PADDING * 2);
	const commandText = input.commandText ?? "";
	const expansionText = input.text.slice(0, COMMAND_EXPANSION_MAX_CHARS);
	const hasBody = expansionText.length > 0;
	const hasHeader = input.hasHeader !== false;

	// ── Width first, THEN overflow ──────────────────────────────────────────────
	// The bubble SHRINK-WRAPS, so the box the expansion is painted in is
	// `usedWidth - padding*2` (= `innerUsed`), not the full `innerWidth`. The
	// overflow decision and the reported `contentWidth` must both describe THAT
	// box, otherwise they describe a box that never exists on screen.
	//
	// No circular dependency: the width decision never reads the overflow flag. It
	// is a function of the command's natural width, the expansion's own widest
	// line, and the header floor — so it can be computed first, and the overflow
	// judgement then reads the settled width.
	//
	// One measurement pass is enough, and this is the invariant that makes it so:
	//   innerUsed >= min(innerWidth, expansion's widest line at innerWidth)
	// Greedy wrapping means every line already fits `maxLineWidth`, and the word
	// that ended each line did not fit `innerWidth >= maxLineWidth` either — so
	// re-wrapping at `innerUsed` reproduces exactly the same breaks. Measuring
	// twice would cost a second pretext pass for a provably identical answer.
	const expansionPrepared = prepareWithSegments(expansionText, COMMAND_PREVIEW_FONT, {
		whiteSpace: "pre-wrap",
	});
	const expansionStats = measureLineStats(expansionPrepared, innerWidth);
	// The command line is clamped to one line (truncate), so its NATURAL width is
	// what the bubble should try to accommodate; `min(innerWidth, …)` caps it when
	// the command is longer than the frame.
	const commandPrepared = prepareWithSegments(commandText, COMMAND_LINE_FONT);
	const commandWidth = measureNaturalWidth(commandPrepared);
	const innerUsed = Math.min(
		innerWidth,
		Math.max(
			1,
			Math.min(innerWidth, commandWidth),
			hasBody ? Math.min(innerWidth, expansionStats.maxLineWidth) : 0,
			hasHeader ? USER_HEADER_MIN_CONTENT_WIDTH : 0,
		),
	);
	const usedWidth = Math.min(contentWidth, USER_BUBBLE_PADDING * 2 + innerUsed);
	// A toggle is needed whenever the collapsed single line cannot show everything:
	// either the expansion wraps, or it stays ONE line that is still wider than the
	// box (an unbreakable path / URL), which the render copy ellipsis-clips. The
	// second case is why this compares against `innerUsed` and not `innerWidth`:
	// without a toggle there would be no way to reveal the clipped tail.
	const overflows =
		hasBody && (expansionStats.lineCount > 1 || expansionStats.maxLineWidth > innerUsed);
	// Nothing to reveal when the whole expansion already fits the preview line.
	const expanded = overflows && expandState.expanded === true;

	const blocks: PreparedBlock[] = [];
	// Block 0 — the command line, forced to one line (truncate), so its height is
	// constant no matter how long the command is.
	blocks.push({
		kind: "fixed",
		marginTop: 0,
		height: COMMAND_LINE_HEIGHT,
		tag: "command-line",
		data: { text: commandText },
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	} satisfies PreparedFixedBlock);
	// Block 1 — the expansion body: one clamped line when collapsed, the real
	// wrapped text when expanded. Both use the same prepared handle so the render
	// copy paints exactly what was measured.
	const bodyBlock: PreparedCodeBlock = {
		kind: "code",
		prepared: expansionPrepared,
		lineHeight: COMMAND_PREVIEW_LINE_HEIGHT,
		lang: null,
		marginTop: COMMAND_ROW_GAP,
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
	if (hasBody) blocks.push(bodyBlock);

	const commandTop = 0;
	const bodyTop = hasBody ? COMMAND_LINE_HEIGHT + COMMAND_ROW_GAP : -1;
	const bodyHeight = !hasBody
		? 0
		: expanded
			? expansionStats.lineCount * COMMAND_PREVIEW_LINE_HEIGHT
			: COMMAND_PREVIEW_LINE_HEIGHT;
	const toggleTop = overflows ? bodyTop + bodyHeight + COMMAND_ROW_GAP : -1;
	const toggleLabel = expanded
		? (expandState.hideLabel ?? "Hide expanded prompt")
		: (expandState.showLabel ?? "Show expanded prompt");

	const contentHeight =
		COMMAND_LINE_HEIGHT +
		(hasBody ? COMMAND_ROW_GAP + bodyHeight : 0) +
		(overflows ? COMMAND_ROW_GAP + COMMAND_TOGGLE_HEIGHT : 0);

	const headerHeight = hasHeader ? USER_HEADER_HEIGHT + USER_HEADER_BODY_GAP : 0;
	const height = USER_BUBBLE_PADDING * 2 + headerHeight + contentHeight;

	// This form does NOT use the frame layer, and the frame it returns is
	// deliberately derived from the explicit geometry rather than from
	// `accumulateFrame`.
	//
	// Why: a collapsed body is clamped to ONE line no matter how many lines the
	// expansion wraps to, and a frame walk cannot express that — it would report
	// the fully-expanded body height. Running the walk anyway (as this used to)
	// produced a `frame.contentHeight` that disagreed with the `height` above, and
	// any consumer following CONTRACT.md §6 ("render absolutely from the frame")
	// would silently lay out at the wrong height. It also paid for a pretext line
	// count on every measure whose result nobody read.
	//
	// `blocks` is still the real block list (the render copy reads the code block's
	// `prepared` handle from it), and the frame now mirrors the collapsed geometry
	// the render copy actually paints.
	const frame: ElementFrame = {
		blocks: blocks.map((_, index) => ({
			index,
			top: index === 0 ? commandTop : bodyTop,
			height: index === 0 ? COMMAND_LINE_HEIGHT : bodyHeight,
			usedWidth: innerUsed,
		})),
		contentHeight,
		usedWidth: innerUsed,
	};

	return {
		height,
		blocks,
		frame,
		contentWidth: innerUsed,
		usedWidth,
		form: "command",
		commandText,
		expansionText,
		overflows,
		expanded,
		commandTop,
		bodyTop,
		toggleTop,
		toggleLabel,
	};
}

export const MEASURE_MESSAGE_CONSTANTS = {
	ASSISTANT_BLOCK_GAP,
	USER_BUBBLE_PADDING,
	USER_HEADER_HEIGHT,
	USER_HEADER_BODY_GAP,
	USER_HEADER_MIN_CONTENT_WIDTH,
	USER_ATTACHMENT_GAP,
	USER_ATTACHMENT_MIN_CONTENT_WIDTH,
	USER_IMAGE_HEIGHT: IMAGE_FIXED_HEIGHT,
	USER_TEXT_FILE_HEIGHT: TEXT_FILE_HEIGHT,
	ASSISTANT_PAD_X,
	ASSISTANT_PAD_Y,
	BODY_LINE_HEIGHT,
	COMMAND_LINE_HEIGHT,
	COMMAND_PREVIEW_LINE_HEIGHT,
	COMMAND_TOGGLE_HEIGHT,
	COMMAND_ROW_GAP,
	COMMAND_EXPANSION_MAX_CHARS,
} as const;
