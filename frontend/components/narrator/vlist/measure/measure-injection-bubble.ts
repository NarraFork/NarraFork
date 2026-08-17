/**
 * measure-injection-bubble.ts — a FRAMED bubble whose body is markdown.
 *
 * ## Why this is a third bubble form
 *
 * The list had exactly two body shapes, and neither fits server-authored injected
 * content:
 *
 *   - user bubble    → framed + shrink-wrapping, body is PLAIN pre-wrap text
 *   - assistant body → markdown, but UNFRAMED and full-width
 *
 * An injection that speaks for somebody (a subagent's report, a teammate's message,
 * a finished background task) needs both halves: the frame and header say WHO, the
 * markdown body carries structure the projection already produces (task lists,
 * sub-headings, bullets — see `sideCarBodyToMarkdown`). Painting it as plain text
 * would show the reader literal `- ` and `### ` glyphs; painting it unframed would
 * drop the speaker.
 *
 * ## The one interaction that needed care
 *
 * Shrink-wrap and markdown pull against each other. `accumulateFrame` reports
 * `usedWidth` (the widest line's natural width) measured AT the width it was given,
 * so narrowing the box afterwards would invalidate the line breaking that produced
 * that number. The order here is therefore:
 *
 *   1. measure the markdown at the full available inner width,
 *   2. shrink the FRAME to the widest line (plus the header floor),
 *   3. report `contentWidth` as the width the body was actually measured at.
 *
 * A body narrower than the box is safe (lines simply do not fill it). A body wider
 * is impossible: `usedWidth` cannot exceed the width it was measured at. This is the
 * same discipline `measureCommandMessage` documents for its expansion, and the
 * reason the render copy must paint at `measured.contentWidth`, never at the frame's
 * inner width.
 *
 * Zero DOM: heights come from pretext line metrics exactly like every other measure.
 */

import { DEFAULT_RENDER_LOD, type MeasuredElement, type RenderLod } from "../prepared-block";
import { FONT_SIZE, LINE_HEIGHT, lineBoxHeight, SPACING } from "../pretext-fonts";
import { measureMarkdown } from "./measure-markdown";
import { isSpecTaskPayload, measureSpecTask, type SpecTaskData } from "./measure-spec-task";
import { measureSystemSimpleCard } from "./measure-system-simple";
import { measureSystemTextCard } from "./measure-system-text";

/** Inner padding of an injection bubble (Paper p="sm" = 12px), as for a user bubble. */
export const INJECTION_BUBBLE_PADDING = SPACING.sm;
/**
 * Header row: avatar/glyph + speaker name + optional marker, one xs line.
 *
 * Matches the user bubble's 20px header so the two read as the same family of object
 * at a glance — the difference between them is meant to be the SIDE and the tint, not
 * the chrome metrics.
 */
export const INJECTION_HEADER_HEIGHT = 20;
/** Gap between the header row and the body (Stack gap={4}). */
export const INJECTION_HEADER_BODY_GAP = 4;
/**
 * Minimum inner width so the header row is not squeezed by a short body.
 *
 * Same reasoning as `USER_HEADER_MIN_CONTENT_WIDTH`, but wider: an injection header
 * carries a source name that can be a subagent title or a bash alias, which run
 * longer than a username. Height-neutral — it only widens the frame, never the width
 * the body was wrapped at.
 */
export const INJECTION_HEADER_MIN_CONTENT_WIDTH = 180;
/**
 * Ceiling on the bubble's share of the row, as a fraction of the available width.
 *
 * An injection is one voice in a conversation, and a full-width framed block reads as
 * a document rather than something somebody said. Leaving a gutter on the right also
 * keeps the left/right distinction legible when a long message would otherwise span
 * the whole row and lose its side.
 */
export const INJECTION_BUBBLE_MAX_WIDTH_RATIO = 0.86;
/**
 * Chars of the body fed to the measurement.
 *
 * The retired projection had its own ceiling (`SIDECAR_PROJECTION_MAX_LINES` = 200) and
 * the comment there explains why it existed: the measure layer only gets to decide what
 * to draw AFTER the projection has built its output, so an unbounded body turns one
 * pathological record into a per-measure-pass cost of its full length. The bubble path
 * does not go through that projection, so the ceiling has to live here.
 *
 * Not merely defensive: `Send`'s message text reaches `deliverInjection` unbounded
 * (`agent-communication.ts` passes `input.message` straight through), so the only per-
 * message limit on a teammate's text is this one. Bounding it here rather than trusting
 * four unrelated upstream producers to each keep their own cap is the same reasoning as
 * `COMMAND_EXPANSION_MAX_CHARS`, and the prefix is what the render copy paints, so the
 * measured and painted text stay identical.
 */
export const INJECTION_BODY_MAX_CHARS = 32 * 1024;

/** Trailing "…output was truncated" note: one xs line inside the frame. */
export const INJECTION_NOTE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs);
/** Gap above the trailing note. */
export const INJECTION_NOTE_GAP = 4;

export interface MeasureInjectionBubbleInput {
	/**
	 * Markdown body, already projected for the reader (`sideCarBodyToMarkdown`).
	 *
	 * Optional because `payload` is the other way to own the body. Supplying neither
	 * yields a header-only bubble rather than an error: a producer whose content came up
	 * empty should still be able to say "this happened".
	 */
	markdown?: string;
	/**
	 * Speaker label for the header row (a subagent title, a bash alias, a username).
	 * Height-relevant only through the header row, which is a fixed single line.
	 */
	speaker?: string | null;
	/** Producer tag, forwarded for the render layer's icon / accent choice. */
	source?: string | null;
	/** Show the header row. Defaults to true — an injection without a speaker is a notice. */
	hasHeader?: boolean;
	/**
	 * Reserve a trailing single-line note (e.g. "result truncated"). Passed as a
	 * boolean rather than the text because the row is a fixed line box either way;
	 * the wording is render chrome.
	 */
	hasNote?: boolean;
	/**
	 * An existing system CARD as the body, instead of markdown.
	 *
	 * Why a nested element rather than flattening the card into text: these producers
	 * already own structured, interactive UI — `merge_summary` has branch names and a
	 * commit sha, `review_feedback` has a findings list, `spec_goal_added` has badges.
	 * Projecting them to markdown would reduce that to prose and lose the affordances.
	 * So the bubble becomes a FRAME around the card that already exists.
	 *
	 * Mutually exclusive with `markdown`: exactly one thing owns the body, or the two
	 * would each claim the same vertical space. `payload` wins when both are present,
	 * and the resolved choice is reported as `bodyForm`.
	 */
	payload?: {
		/** The inner element kind (`merge_summary`, `container_ready`, …). */
		kind: string;
		/** That element's own measure data, passed through untouched. */
		data: unknown;
	} | null;
}

/** Geometry the injection bubble's render copy needs on top of MeasuredElement. */
export interface MeasuredInjectionBubble extends MeasuredElement {
	/** Discriminates this form from a plain / command bubble. */
	form: "injection";
	/**
	 * The bounded body text that was actually MEASURED.
	 *
	 * The render copy paints from `blocks`, so it cannot drift from this; it is exposed
	 * so a caller can tell that clipping happened without re-deriving the bound.
	 */
	measuredMarkdown: string;
	/**
	 * Which kind of body this bubble measured.
	 *
	 * The render copy MUST branch on this rather than sniffing `blocks`: a card body's
	 * blocks are `PreparedFixedBlock`s that look nothing like markdown's, and a future
	 * payload could coincide. An explicit discriminant cannot be collided into.
	 */
	bodyForm: "markdown" | "payload";
	/** Inner element kind when `bodyForm === "payload"`, else null. */
	payloadKind: string | null;
	/** Top offset (px) of the body (markdown or nested card) inside the frame. */
	bodyTop: number;
	/** True when the header row is drawn (and its height reserved). */
	hasHeader: boolean;
	/** Top offset (px) of the trailing note; -1 when there is none. */
	noteTop: number;
}

/**
 * Measure a nested system card at the bubble's inner width.
 *
 * Delegates to the card's OWN measure function — the bubble must never re-derive
 * another element's geometry, or the two copies would drift and the frame would clip
 * (or over-reserve for) the card it contains.
 *
 * An unrecognized kind measures to zero height rather than throwing: a producer added
 * without teaching this dispatcher about it should degrade to a header-only bubble, not
 * take the whole list down. The `payloadKind` on the result makes the omission visible.
 */
function measureInnerCard(
	kind: string,
	data: unknown,
	innerWidth: number,
	lod: RenderLod,
): MeasuredElement {
	if (isSpecTaskPayload(kind)) {
		// A spec task is drawn BY THE BUBBLE as a status-glyph + lock + wrapping-text
		// row, not nested as the clamped system-simple card. See measure-spec-task.ts.
		return measureSpecTask((data ?? {}) as SpecTaskData, innerWidth);
	}
	if (SYSTEM_SIMPLE_KINDS.has(kind)) {
		return measureSystemSimpleCard(kind as never, data as never, innerWidth, lod);
	}
	if (SYSTEM_TEXT_KINDS.has(kind)) {
		return measureSystemTextCard(kind as never, data as never, innerWidth, lod);
	}
	return EMPTY_BODY;
}

/** Inner kinds measured by `measure-system-simple` (fixed-height cards). */
const SYSTEM_SIMPLE_KINDS = new Set([
	"merge_summary",
	"review_feedback",
	// spec_continuation / spec_blocked_continuation are intercepted above as
	// "spec-task" — the bubble draws the row itself rather than nesting this card.
]);

/** Inner kinds measured by `measure-system-text` (wrapping-body cards). */
const SYSTEM_TEXT_KINDS = new Set([
	"info",
	"error",
	"container_ready",
	"browser_session_lost",
	"origin_notice",
	"spec_goal_added",
	"spec_fork_carryover",
	"spec_context_cleared",
]);

/**
 * True when a body contains a block the render layer paints EDGE TO EDGE.
 *
 * Only fenced code qualifies today: `CodeBlockView` draws a background, a border and
 * a copy button spanning the content width it is handed, so unlike text it does not
 * "simply not fill" a box wider than its content — it fills all of it, and overflows
 * a frame that shrank below that width.
 *
 * A table is deliberately NOT here: `accumulateFrame`'s table arm already clamps its
 * reported width to the box, and the render layer scrolls it internally, so its
 * measured and painted widths cannot diverge the way a code panel's do.
 */
function hasFullBleedBlock(blocks: readonly { kind: string }[]): boolean {
	for (const block of blocks) {
		if (block.kind === "code") return true;
	}
	return false;
}

/** A body that reserves nothing (unrecognized payload kind). */
const EMPTY_BODY: MeasuredElement = {
	height: 0,
	blocks: [],
	frame: { blocks: [], contentHeight: 0, usedWidth: 0 },
	contentWidth: 0,
	usedWidth: 0,
};

/** True when a measured element is the injection bubble form. */
export function isMeasuredInjectionBubble(
	measured: MeasuredElement,
): measured is MeasuredInjectionBubble {
	return (measured as MeasuredInjectionBubble).form === "injection";
}

/**
 * Measure a framed markdown bubble.
 *
 * `contentWidth` is the row's available width; the returned `usedWidth` is the frame
 * the render copy must paint, and `contentWidth` on the result is the width the body
 * was wrapped at (see the module header on why those differ).
 */
export function measureInjectionBubble(
	input: MeasureInjectionBubbleInput,
	contentWidth: number,
	_lod: RenderLod = DEFAULT_RENDER_LOD,
): MeasuredInjectionBubble {
	const hasHeader = input.hasHeader !== false;
	const hasNote = input.hasNote === true;

	// The bubble never spans the full row, so the body is wrapped inside the capped
	// box — not the row width. Doing this the other way round (measure wide, cap the
	// frame afterwards) would report line breaks for a width the reader never sees.
	const outerLimit = Math.max(1, Math.floor(contentWidth * INJECTION_BUBBLE_MAX_WIDTH_RATIO));
	const innerWidth = Math.max(1, outerLimit - INJECTION_BUBBLE_PADDING * 2);

	// A card body is measured by the element that owns it, so the bubble never
	// re-implements another card's geometry — it only frames whatever height comes back.
	const payload = input.payload ?? null;
	const bodyForm: "markdown" | "payload" = payload ? "payload" : "markdown";

	// Bounded prefix, so a pathological body cannot make every measure pass O(its size).
	const rawMarkdown = input.markdown ?? "";
	const bodyText =
		bodyForm === "payload"
			? ""
			: rawMarkdown.length > INJECTION_BODY_MAX_CHARS
				? rawMarkdown.slice(0, INJECTION_BODY_MAX_CHARS)
				: rawMarkdown;
	const firstPass = payload
		? measureInnerCard(payload.kind, payload.data, innerWidth, _lod)
		: measureMarkdown(bodyText, innerWidth);

	// ── Second pass, only for a body that contains a FULL-BLEED block ────────────
	//
	// The shrink-wrap contract (see the module header) is that the frame narrows to
	// `frame.usedWidth` while the body is painted at the width it was MEASURED at.
	// That is safe for text — short lines simply do not fill the box — but a fenced
	// code panel is full-bleed: `CodeBlockView` paints its background, border and
	// copy button across the whole content width it is handed, not across its widest
	// line. So a narrow-code bubble shrank its frame while the panel inside kept
	// painting at the wider measured width, and the panel spilled out of the bubble.
	//
	// Rather than making a code block report the full width (which would force every
	// bubble containing one to span the row, and would widen the USER bubble too —
	// it reuses `kind: "code"` for its plain pre-wrap body), re-measure the body at
	// the width the frame actually settled on. One extra pass, only when a full-bleed
	// block is present, and it converges: the second pass is given exactly the width
	// the first pass asked for, so the panel now fills a box the frame committed to.
	// The header floor is folded in, because it is part of the width the frame will
	// settle on: re-measuring at a width the floor then widens past would leave the
	// panel narrower than the bubble it sits in — a gap rather than an overflow, but
	// still the two sides disagreeing about one number.
	const shrinkTo = Math.max(
		1,
		Math.min(
			innerWidth,
			Math.max(firstPass.frame.usedWidth, hasHeader ? INJECTION_HEADER_MIN_CONTENT_WIDTH : 0),
		),
	);
	const body =
		!payload && shrinkTo < innerWidth && hasFullBleedBlock(firstPass.blocks)
			? measureMarkdown(bodyText, shrinkTo)
			: firstPass;
	// The markdown frame is reused verbatim: its per-block `top` values are relative
	// to the body's own origin, and the render copy offsets the whole body by
	// `bodyTop`. Rewriting the tops here would duplicate that offset.
	const frame = body.frame;
	// What the body was actually wrapped at, which the render copy must paint at.
	const bodyWidth = body.contentWidth;

	const headerBlock = hasHeader ? INJECTION_HEADER_HEIGHT + INJECTION_HEADER_BODY_GAP : 0;
	const noteBlock = hasNote ? INJECTION_NOTE_GAP + INJECTION_NOTE_HEIGHT : 0;
	const bodyTop = INJECTION_BUBBLE_PADDING + headerBlock;
	const height = INJECTION_BUBBLE_PADDING * 2 + headerBlock + frame.contentHeight + noteBlock;

	// Shrink-wrap to the widest line, floored so the header is not clipped, and
	// capped at the ratio limit. `frame.usedWidth` was produced AT `innerWidth`, so
	// it can only ever be ≤ innerWidth — narrowing here cannot invalidate the wrap.
	const innerUsed = Math.max(
		1,
		frame.usedWidth,
		hasHeader ? INJECTION_HEADER_MIN_CONTENT_WIDTH : 0,
	);
	const usedWidth = Math.min(outerLimit, INJECTION_BUBBLE_PADDING * 2 + innerUsed);

	return {
		form: "injection",
		bodyForm,
		payloadKind: payload?.kind ?? null,
		measuredMarkdown: bodyText,
		height,
		blocks: body.blocks,
		frame,
		// The width the body was WRAPPED at, which the render copy must paint at.
		// Deliberately not the frame's inner width: those differ whenever the bubble
		// shrink-wrapped, and painting at the narrower one would re-wrap the text
		// under a height that was predicted for the wider one. When the body was
		// re-measured for a full-bleed block this is the SECOND pass's width, which is
		// the one its frame belongs to.
		contentWidth: bodyWidth,
		usedWidth,
		bodyTop,
		hasHeader,
		noteTop: hasNote ? height - INJECTION_BUBBLE_PADDING - INJECTION_NOTE_HEIGHT : -1,
	};
}
