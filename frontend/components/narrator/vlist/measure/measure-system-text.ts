/**
 * measure-system-text.ts — Multi-line / pre-wrap system cards (batch-2 P5).
 *
 * Covers the system-card family whose body is a WRAPPING text block (pre-wrap or
 * normal), so the height depends on the wrapped LINE COUNT and must be measured
 * with pretext — never DOM. Fixed chrome (icons / badges / buttons / titles) is
 * added as constants; only the body flows.
 *
 * Kinds (see CONTRACT.md §4 + MessageBubble.tsx):
 *   - info                : Paper p=xs + Text xs pre-wrap (multi-line body).
 *   - tool_loaded         : Paper p=xs + Text xs pre-wrap (usually single line).
 *   - tool_unloaded       : same as tool_loaded.
 *   - bash_command        : Paper p=xs + Text xs MONOSPACE pre-wrap ("$ cmd").
 *   - error               : Paper p=xs + Group(icon16 + text pre-wrap + actions).
 *   - segment_compact_failed : Paper p=xs + Group(icon16 + Stack(title + body
 *                              pre-wrap) + dismiss button).
 *   - spec_goal_added     : Paper p=xs + Stack(badge-row[2 badges + task text
 *                            pre-wrap] + 1 button).
 *   - spec_fork_carryover : Paper p=xs + Stack(badge-row[badge + desc text] +
 *                            3 buttons).
 *   - spec_context_cleared: same layout as spec_fork_carryover.
 *
 * Universal height model (all cards are Paper p="xs", radius=sm):
 *
 *   height = CARD_PADDING(10)×2
 *          + max(sideMin, preBody + bodyHeight + postBody)
 *
 * where:
 *   - bodyHeight = wrapped line count × XS line box (17px), measured by pretext.
 *   - preBody  = fixed rows ABOVE the body (e.g. segment title row + gap).
 *   - postBody = fixed rows BELOW the body (e.g. button row + Stack gap).
 *   - sideMin  = min height of a horizontal sibling (icon / button) that shares
 *                the body's row — the row is at least this tall.
 *   - leftChrome/rightChrome = px reserved LEFT/RIGHT of the body (icon, badges,
 *     action buttons) so the body wraps in its true available width.
 *
 * The body is carried as a PreparedCodeBlock (like the user-message body in
 * measure-message-bubble): prepareWithSegments(text, font, { whiteSpace }) with
 * codePaddingX/Y = 0. Chrome constants come from CONTRACT.md §3/§4 and
 * pretext-fonts.ts. ZERO DOM.
 */

import { prepareWithSegments } from "@chenglou/pretext";
import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type MeasuredElement,
	type PreparedCodeBlock,
	type RenderLod,
} from "../prepared-block";
import {
	FONT_CODE_BLOCK,
	FONT_SIZE,
	FONT_XS,
	LINE_HEIGHT,
	lineBoxHeight,
	SPACING,
} from "../pretext-fonts";
import { pretextLineMetrics } from "./pretext-metrics";

// ── Discriminant + payload ───────────────────────────────────────────────────

/** The multi-line / pre-wrap system-card kinds covered by this module. */
export type SystemTextKind =
	| "info"
	| "tool_loaded"
	| "tool_unloaded"
	| "bash_command"
	| "error"
	| "segment_compact_failed"
	| "spec_goal_added"
	| "spec_fork_carryover"
	| "spec_context_cleared"
	/**
	 * A turn stored as `role: "user"` (protocol/scheduling requirement) that no
	 * human authored — auto-continuation, review kickoff, AI-initiated sends — plus
	 * plain-text `sys` notices. Heading row (icon + source + time) above the body.
	 */
	| "origin_notice";

/**
 * Render payload carried alongside the MeasuredElement. Only `text`/`command`
 * affect the measured height (they are the wrapping body); every other field is
 * height-neutral chrome the renderer paints (title / badges / buttons / colour).
 */
export interface SystemTextData {
	/**
	 * The wrapping body text: info.message / tool.text / error message /
	 * segment error / spec_goal task / carryover description. This is the only
	 * content that drives the height (with `command`). Optional because
	 * bash_command carries its body in `command` instead.
	 */
	text?: string;
	/** bash_command payload; rendered as "$ command" (takes precedence as body). */
	command?: string;
	/** segment_compact_failed heading (a fixed single line above the body). */
	title?: string;
	/** Leading badge labels (spec_goal_added / carryover). Height-neutral. */
	badges?: string[];
	/**
	 * Button labels (spec_goal / carryover / segment dismiss). Height-neutral for
	 * those kinds, whose chrome ALWAYS reserves a button row.
	 *
	 * The `error` card is the exception: its button row is conditional (only the
	 * provider fix adds one), so for that kind a non-empty `buttons` array ADDS a
	 * row — see `resolveSystemTextChrome`.
	 */
	buttons?: string[];
	/** Primary Mantine colour (indigo / red / orange …). Height-neutral. */
	color?: string;
	/** carryover variant: fork (git-fork icon) vs contextCleared (eraser icon). */
	variant?: "fork" | "contextCleared";
	/** spec_goal_added: newly added (true) vs already existed (false) badge. */
	added?: boolean;
	/** error: show the right-side retry/close action icons (default true). */
	actions?: boolean;
	/**
	 * origin_notice: preformatted timestamp for the heading row's right edge.
	 * Preformatted by the adapter because the render layer must stay free of
	 * locale/formatting imports. Height-neutral (a fixed single-line row).
	 */
	timeLabel?: string;
}

// ── Chrome constants (px) — CONTRACT.md §3/§4 + pretext-fonts.ts ──────────────

/** Paper p="xs" inner padding (top + bottom each). */
export const CARD_PADDING = SPACING.xs; // 10
/** xs body line box: round(12 × 1.4) = 17. Shared by SANS + MONO (xs line-height). */
export const BODY_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17

/** Leading alert/notice icon size (error / segment_compact_failed). */
export const ICON_16 = 16;
/** error icon marginTop (aligns with first text line). */
export const ICON_MARGIN_TOP = 1;
/** Group gap={6} between icon / text / actions. */
export const GROUP_GAP = 6;
/** Group gap="xs" (=10) between badges and text in spec rows. */
export const GROUP_GAP_XS = SPACING.xs; // 10
/** Stack gap={6} between the badge row and the button row (spec cards). */
export const STACK_GAP = 6;
/** Inner Stack gap={2} between title and body (segment_compact_failed). */
export const SEGMENT_TITLE_GAP = 2;
/** origin_notice: gap between the source heading row and the body text. */
export const ORIGIN_HEADING_GAP = 4;
/** Button size="compact-xs" height. */
export const BUTTON_COMPACT_XS = 18;
/** ActionIcon size="xs" (error retry/close). */
export const ACTION_ICON_XS = 18;
/** Badge size="xs" visual height (round(16.8) → integer row). */
export const BADGE_XS = 17;

// ── Body left/right reserves (px) — harness-tunable font-metric estimates ─────
// These reserve horizontal room for the fixed chrome flanking the body so the
// body wraps at its true width. They are ESTIMATES (badge/button intrinsic
// widths depend on their labels); unit tests never assert their exact value —
// only that the body wraps and the chrome composition holds. VListHarness
// calibrates them against real DOM.

/** error: icon(16) + gap(6) to the LEFT of the body. */
export const ERROR_LEFT = ICON_16 + GROUP_GAP; // 22
/** error: gap + retry(18) + gap + close(18) to the RIGHT of the body. */
export const ERROR_RIGHT = GROUP_GAP + ACTION_ICON_XS + GROUP_GAP + ACTION_ICON_XS; // 48
/** segment_compact_failed: icon(16) + gap(6) to the LEFT of the Stack. */
export const SEGMENT_LEFT = ICON_16 + GROUP_GAP; // 22
/** segment_compact_failed: gap + dismiss button to the RIGHT of the Stack. */
export const SEGMENT_DISMISS_WIDTH = 58;
export const SEGMENT_RIGHT = GROUP_GAP + SEGMENT_DISMISS_WIDTH; // 64
/** spec_goal_added: 2 badges (protected + added/exists) + 2 gaps LEFT of text. */
export const SPEC_GOAL_BADGE_RESERVE = 80 + GROUP_GAP_XS + 50 + GROUP_GAP_XS; // 150
/** spec carryover: 1 badge (fork/eraser) + gap LEFT of the description text. */
export const SPEC_FORK_BADGE_RESERVE = 110 + GROUP_GAP_XS; // 120

// ── Per-kind chrome descriptor ───────────────────────────────────────────────

export interface KindChrome {
	/** CSS font shorthand for the body (measure MUST match render). */
	font: string;
	/** pretext white-space mode: pre-wrap (keep newlines) vs normal (collapse). */
	whiteSpace: "pre-wrap" | "normal";
	/** px reserved to the LEFT of the body (icon / badges). */
	leftChrome: number;
	/** px reserved to the RIGHT of the body (action buttons). */
	rightChrome: number;
	/** fixed height ABOVE the body within the card (title row + gap). */
	preBody: number;
	/** fixed height BELOW the body within the card (button row + gap). */
	postBody: number;
	/** min height of a horizontal sibling sharing the body row (icon / button). */
	sideMin: number;
	/** literal prefix prepended to the body text (bash "$ "). */
	prefix: string;
}

/** The single source of truth mapping each kind to its chrome geometry. */
export const KIND_CHROME: Record<SystemTextKind, KindChrome> = {
	info: {
		font: FONT_XS,
		whiteSpace: "pre-wrap",
		leftChrome: 0,
		rightChrome: 0,
		preBody: 0,
		postBody: 0,
		sideMin: 0,
		prefix: "",
	},
	tool_loaded: {
		font: FONT_XS,
		whiteSpace: "pre-wrap",
		leftChrome: 0,
		rightChrome: 0,
		preBody: 0,
		postBody: 0,
		sideMin: 0,
		prefix: "",
	},
	tool_unloaded: {
		font: FONT_XS,
		whiteSpace: "pre-wrap",
		leftChrome: 0,
		rightChrome: 0,
		preBody: 0,
		postBody: 0,
		sideMin: 0,
		prefix: "",
	},
	bash_command: {
		font: FONT_CODE_BLOCK,
		whiteSpace: "pre-wrap",
		leftChrome: 0,
		rightChrome: 0,
		preBody: 0,
		postBody: 0,
		sideMin: 0,
		prefix: "$ ",
	},
	error: {
		font: FONT_XS,
		whiteSpace: "pre-wrap",
		leftChrome: ERROR_LEFT,
		rightChrome: ERROR_RIGHT,
		preBody: 0,
		postBody: 0,
		sideMin: ICON_MARGIN_TOP + ICON_16, // 17
		prefix: "",
	},
	segment_compact_failed: {
		font: FONT_XS,
		whiteSpace: "pre-wrap",
		leftChrome: SEGMENT_LEFT,
		rightChrome: SEGMENT_RIGHT,
		preBody: BODY_LINE_HEIGHT + SEGMENT_TITLE_GAP, // title line (17) + gap (2) = 19
		postBody: 0,
		sideMin: BUTTON_COMPACT_XS, // 18
		prefix: "",
	},
	spec_goal_added: {
		font: FONT_XS,
		whiteSpace: "pre-wrap",
		leftChrome: SPEC_GOAL_BADGE_RESERVE,
		rightChrome: 0,
		preBody: 0,
		postBody: STACK_GAP + BUTTON_COMPACT_XS, // gap (6) + button (18) = 24
		sideMin: BADGE_XS, // 17
		prefix: "",
	},
	spec_fork_carryover: {
		font: FONT_XS,
		whiteSpace: "normal",
		leftChrome: SPEC_FORK_BADGE_RESERVE,
		rightChrome: 0,
		preBody: 0,
		postBody: STACK_GAP + BUTTON_COMPACT_XS, // gap (6) + button row (18) = 24
		sideMin: BADGE_XS, // 17
		prefix: "",
	},
	spec_context_cleared: {
		font: FONT_XS,
		whiteSpace: "normal",
		leftChrome: SPEC_FORK_BADGE_RESERVE,
		rightChrome: 0,
		preBody: 0,
		postBody: STACK_GAP + BUTTON_COMPACT_XS, // gap (6) + button row (18) = 24
		sideMin: BADGE_XS, // 17
		prefix: "",
	},
	origin_notice: {
		font: FONT_XS,
		whiteSpace: "pre-wrap",
		// The heading row sits ABOVE the body (a Stack, not a horizontal sibling),
		// so the body keeps the full card width.
		leftChrome: 0,
		rightChrome: 0,
		preBody: BODY_LINE_HEIGHT + ORIGIN_HEADING_GAP, // heading (17) + gap (4) = 21
		postBody: 0,
		sideMin: 0,
		prefix: "",
	},
};

/** Resolve the body text for a kind (bash prepends "$ "; command wins if set). */
export function resolveBodyText(kind: SystemTextKind, data: SystemTextData): string {
	const chrome = KIND_CHROME[kind];
	if (kind === "bash_command") {
		const cmd = data.command ?? data.text ?? "";
		return chrome.prefix + cmd;
	}
	return chrome.prefix + (data.text ?? "");
}

/**
 * The chrome for one card instance.
 *
 * Every kind's geometry is a static property of the kind EXCEPT the error card's
 * button row: the "turn off image generation and retry" fix only applies to one
 * specific failure, so reserving its row unconditionally would add 24px of empty
 * space under every unrelated error. A labelled button is the point (an icon-only
 * control hides its meaning in a hover tooltip that touch users never see), and a
 * labelled button needs a row, so this one kind reads its data.
 *
 * The adapter decides whether the button exists, so the decision is already made
 * before measurement — measure and render both read the same `buttons` array and
 * cannot disagree.
 */
export function resolveSystemTextChrome(kind: SystemTextKind, data: SystemTextData): KindChrome {
	const chrome = KIND_CHROME[kind];
	if (kind !== "error" || !data.buttons?.length) return chrome;
	return { ...chrome, postBody: STACK_GAP + BUTTON_COMPACT_XS };
}

/**
 * Measure a multi-line / pre-wrap system card. The body wraps in its true
 * available width (contentWidth minus card padding and the kind's left/right
 * chrome); the fixed chrome rows are added by the per-kind height model. Height
 * does not depend on `lod`. Zero DOM.
 */
export function measureSystemTextCard(
	kind: SystemTextKind,
	data: SystemTextData,
	contentWidth: number,
	_lod: RenderLod = DEFAULT_RENDER_LOD,
): MeasuredElement {
	const chrome = resolveSystemTextChrome(kind, data);
	const bodyText = resolveBodyText(kind, data);

	// True body width = card inner width minus the flanking chrome reserves.
	const innerWidth = Math.max(
		1,
		contentWidth - CARD_PADDING * 2 - chrome.leftChrome - chrome.rightChrome,
	);

	// Body carried as a pre-wrap/normal code block (no code-box padding).
	const bodyBlock: PreparedCodeBlock = {
		kind: "code",
		prepared: prepareWithSegments(bodyText, chrome.font, { whiteSpace: chrome.whiteSpace }),
		lineHeight: BODY_LINE_HEIGHT,
		lang: null,
		marginTop: 0,
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
	const blocks: PreparedCodeBlock[] = [bodyBlock];
	const frame = accumulateFrame(blocks, innerWidth, pretextLineMetrics, {
		codePaddingX: 0,
		codePaddingY: 0,
		codeLangExtraTop: 0,
	});

	const bodyHeight = frame.contentHeight; // wrapped line count × 17
	const bodyStack = chrome.preBody + bodyHeight + chrome.postBody;
	const height = CARD_PADDING * 2 + Math.max(chrome.sideMin, bodyStack);

	return {
		height,
		blocks,
		frame,
		contentWidth: innerWidth,
		usedWidth: contentWidth, // full-width card
	};
}

/**
 * The fixed (non-body) height of a card kind, i.e. everything except the
 * wrapped body: card padding + preBody + postBody. Adding the body height on top
 * gives the total (subject to the sideMin floor). Useful for tests + the
 * registry. For horizontal-sibling kinds (error/segment) the sideMin floor may
 * raise the total when the body is tiny — the total is always
 * `CARD_PADDING*2 + max(sideMin, preBody + bodyHeight + postBody)`.
 *
 * Reports the kind's BASELINE chrome. An error card carrying the conditional
 * provider-fix button row is taller by `STACK_GAP + BUTTON_COMPACT_XS`; only
 * `measureSystemTextCard` (which sees the data) accounts for it.
 */
export function systemTextChromeHeight(kind: SystemTextKind): number {
	const chrome = KIND_CHROME[kind];
	return CARD_PADDING * 2 + chrome.preBody + chrome.postBody;
}

/**
 * Single-line height of a card kind (body = exactly one 17px line), for the
 * kind's baseline chrome — see the note on `systemTextChromeHeight`.
 */
export function systemTextSingleLineHeight(kind: SystemTextKind): number {
	const chrome = KIND_CHROME[kind];
	const bodyStack = chrome.preBody + BODY_LINE_HEIGHT + chrome.postBody;
	return CARD_PADDING * 2 + Math.max(chrome.sideMin, bodyStack);
}

export const MEASURE_SYSTEM_TEXT_CONSTANTS = {
	CARD_PADDING,
	BODY_LINE_HEIGHT,
	ICON_16,
	ICON_MARGIN_TOP,
	GROUP_GAP,
	GROUP_GAP_XS,
	STACK_GAP,
	SEGMENT_TITLE_GAP,
	ORIGIN_HEADING_GAP,
	BUTTON_COMPACT_XS,
	ACTION_ICON_XS,
	BADGE_XS,
	ERROR_LEFT,
	ERROR_RIGHT,
	SEGMENT_LEFT,
	SEGMENT_RIGHT,
	SPEC_GOAL_BADGE_RESERVE,
	SPEC_FORK_BADGE_RESERVE,
} as const;
