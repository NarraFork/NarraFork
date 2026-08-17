/**
 * measure-subagent.ts — Height model for the SubagentCard (batch-2 P12).
 *
 * Visual parity target: SubagentCard.tsx. This is the ONLY list element that
 * reads the render LOD directly (mirroring ToolCallCard's layering), so — like
 * measure-reasoning — the height model MUST take (data, contentWidth, lod, opts)
 * and resolve `effectiveExpanded` deterministically. The card has three always-
 * visible regions plus a LazyCollapse expansion body:
 *
 *   ┌ Header  (Box p="xs" = 10 padding, ALWAYS shown) ───────────────────────────┐
 *   │  badge row  ThemeIcon16 + Badge×N(xs 16) + status12 + timing + chevron12    │
 *   │             → row height = max(icon16, badge16, xs line17, chevron12) = 17  │
 *   │  description Text xs mt2 ml21  — collapsed: truncate SINGLE line 🟢         │
 *   │                                  expanded : wraps 🔴 (pretext)             │
 *   │  [result preview]  !expanded && terminal && result → truncate single line  │
 *   │  collapsed header ≈ 56 (no preview) .. 75 (with preview) px                 │
 *   └────────────────────────────────────────────────────────────────────────────┘
 *   ┌ Recent Calls  (Box px="xs" pb="xs", ALWAYS shown when activityCalls>0) ─────┐
 *   │  title row (mb4) + ≤3 flush TRACE rows (18.8 each — see RECENT_ROW_HEIGHT)   │
 *   └────────────────────────────────────────────────────────────────────────────┘
 *   ┌ LazyCollapse body  (only when effectiveExpanded) ──────────────────────────┐
 *   │  [selfPermission]  Box mx/mb="xs" + InlinePermission (P11 measure-permission)│
 *   │  [prompt]          toggle row + (open → ContentViewer maxHeight:200 🟡)      │
 *   │  [pendingPerms]    title + ToolCallCard × N (P10 — placeholder, see note)   │
 *   │  [resolveOverride] compact-xs button                                        │
 *   │  [resultText]      ContentViewer maxHeight:300 🟡 (markdown)                 │
 *   └────────────────────────────────────────────────────────────────────────────┘
 *
 * OUTER frame: inRun=false → wrapped in Paper withBorder (1px × 2). inRun=true →
 * no border + an optional 1px Divider when it is not the last card in the run.
 *
 * effectiveExpanded (mirrors SubagentCard.tsx:289-317):
 *   lodExempt (active | selfPermission | pendingPermissions) → always expanded
 *   L6 → expanded; L5 → recent cards follow `opened`, old cards collapse;
 *   L4 → collapsed; L1-L3 → follow `opened` (upstream gate).
 *
 * LINE HEIGHTS: CONTRACT §3 is ground truth — "xs single line = 17px" (§4's
 * 16.8 / 26.8 are earlier un-rounded approximations). We therefore use the
 * rounded lineBoxHeight(12,1.4)=17 everywhere, consistent with the other
 * measure-*.ts modules; the VListHarness calibrates exact pixels.
 *
 * maxHeight regions (prompt / result) are CAPPED: height = min(estimate, cap);
 * we only need to know whether the content exceeds the cap.
 *
 * P10 DEPENDENCY: pendingPermissions render a ToolCallCard each (owned by P10,
 * `measure-tool-call.ts`, which is not yet available). Each pending card uses a
 * conservative placeholder height; when the caller supplies InlinePermissionData
 * per pending permission we refine it via measureInlinePermission + a header
 * estimate. Reported back to the main agent.
 *
 * Zero DOM. Follows the measure-reasoning.ts / measure-web-search.ts template.
 */

import { prepareWithSegments } from "@chenglou/pretext";
import { prepareRichInline, type RichInlineItem } from "@chenglou/pretext/rich-inline";
import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type ElementFrame,
	type MeasuredElement,
	type PreparedCodeBlock,
	type PreparedInlineBlock,
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
import {
	type InlinePermissionData,
	type MeasuredInlinePermission,
	measureInlinePermission,
} from "./measure-permission";
import { resolveToolTimingStamps, type ToolTimingStamps } from "./measure-tool-call";
// The recent-call rows ARE trace rows, so their height comes from the trace model
// rather than a second copy of it. One-way: measure-tool-run imports
// measure-markdown + measure-tool-call and never this module, so no cycle.
import { TRACE_ROW_HEIGHT } from "./measure-tool-run";
import { pretextLineMetrics } from "./pretext-metrics";

// ─────────────────────────────────────────────────────────────────────────────
// Chrome constants (px) — CONTRACT.md §3/§4 + SubagentCard.tsx + pretext-fonts.
// ─────────────────────────────────────────────────────────────────────────────

/** Header / recent-calls / expanded-body Box padding (Box p/px/pb="xs"). */
export const CARD_PADDING = SPACING.xs; // 10
/** xs single-line box: round(12 × 1.4) = 17 (CONTRACT §3 ground truth). */
export const XS_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17

/** Header ThemeIcon size={16}. */
export const THEME_ICON_SIZE = 16;
/** Badge size="xs" height (CONTRACT §3). */
export const BADGE_XS_HEIGHT = 16;
/** IconChevronDown / IconChevronRight size={12}. */
export const CHEVRON_SIZE = 12;
/** StatusIcon / Loader size={12}. */
export const STATUS_ICON_SIZE = 12;
/** Badge row = tallest inline element (xs text line dominates icons/badges). */
export const BADGE_ROW_HEIGHT = Math.max(
	THEME_ICON_SIZE,
	BADGE_XS_HEIGHT,
	XS_LINE_HEIGHT,
	CHEVRON_SIZE,
	STATUS_ICON_SIZE,
); // 17

/** description Text mt={2}. */
export const DESC_MARGIN_TOP = 2;
/** description Text ml={21} (aligns under the badge row content). */
export const DESC_LEFT = 21;
/** description font (Text size="xs"). */
export const DESC_FONT = `${FONT_WEIGHT.regular} ${FONT_SIZE.xs}px ${SANS_FAMILY}`;
/** result-preview Text mt={2} (collapsed only). */
export const RESULT_PREVIEW_MARGIN_TOP = 2;

// ── Recent Calls (Box px="xs" pb="xs" — NO top padding) ──────────────────────
/** Title row height when the "open session" button is present (compact-xs 18). */
export const BUTTON_COMPACT_XS = 18;
/** Title Group mb={4}. */
export const RECENT_TITLE_MARGIN_BOTTOM = 4;
/**
 * Activity row height — the TRACE row height, not a bespoke one.
 *
 * These rows used to be tinted `5px 7px` buttons (27px), so the same child tool
 * call looked like a chunky card row inside a subagent card and like a slim trace
 * line once the reader dropped to a low LOD. They are now the same row, which is
 * expressed by taking the height from `measure-tool-run` rather than restating it.
 * One-way import: `measure-tool-run` never imports this module.
 */
export const RECENT_ROW_HEIGHT = TRACE_ROW_HEIGHT; // 18.8
/** Trace rows sit flush; the old 4px seam belonged to the tinted-button look. */
export const RECENT_STACK_GAP = 0;
/** At most 3 recent calls are shown (slice(-3)). */
export const RECENT_MAX_ROWS = 3;

// ── Expanded body: shared block chrome ───────────────────────────────────────
/** Every expanded sub-block uses Box px="xs" pb="xs" (bottom padding only). */
export const BLOCK_PADDING_X = SPACING.xs; // 10
export const BLOCK_PADDING_BOTTOM = SPACING.xs; // 10

// selfPermission — Box mx="xs" mb="xs" + InlinePermission (P11).
/** Left/right margin around the InlinePermission block. */
export const SELF_PERMISSION_MARGIN_X = SPACING.xs; // 10
/** Bottom margin below the InlinePermission block. */
export const SELF_PERMISSION_MARGIN_BOTTOM = SPACING.xs; // 10

// prompt — toggle row + optional ContentViewer (maxHeight:200).
/** Prompt toggle row = max(chevron12, xs line17) = 17. */
export const PROMPT_TOGGLE_ROW_HEIGHT = Math.max(CHEVRON_SIZE, XS_LINE_HEIGHT); // 17
/** Box mt={4} between the toggle row and the prompt ContentViewer. */
export const PROMPT_BODY_MARGIN_TOP = 4;
/** ContentViewer maxHeight cap for the prompt (🟡). */
export const PROMPT_MAX_HEIGHT = 200;
/** Prompt ContentViewer is a <Code block style={{fontSize:11}}> (monospace). */
export const PROMPT_FONT = `${FONT_WEIGHT.regular} 11px ${MONO_FAMILY}`;
/** Prompt line box: round(11 × 1.55) = 17 (Code block base line-height). */
export const PROMPT_LINE_HEIGHT = lineBoxHeight(11, LINE_HEIGHT.md); // 17

// pendingPermissions — title + ToolCallCard × N (P10, placeholder).
/** Title Text xs. */
export const PENDING_TITLE_ROW_HEIGHT = XS_LINE_HEIGHT; // 17
/** Title mb={4}. */
export const PENDING_TITLE_MARGIN_BOTTOM = 4;
/** Wrapper Box border (1px each side) around each pending ToolCallCard. */
export const PENDING_CARD_BORDER = 1;
/** Stack gap={4} between pending cards. */
export const PENDING_STACK_GAP = 4;
/**
 * Conservative placeholder height for a pending-permission ToolCallCard when no
 * per-permission InlinePermissionData is supplied. P10 (measure-tool-call.ts)
 * owns the real card model; a pending card is always expanded (header + exec
 * target + feedback textarea + button bar), so ≈200px is a safe estimate.
 */
export const PENDING_PERMISSION_CARD_PLACEHOLDER = 200;
/** ToolCallCard collapsed header estimate (CONTRACT §4 ≈40-42) for refined mode. */
export const TOOLCALL_HEADER_ESTIMATE = 42;

// resolveOverride — a single compact-xs button (Box px="xs" pb="xs").
export const RESOLVE_OVERRIDE_BUTTON_HEIGHT = BUTTON_COMPACT_XS; // 18

// resultText — ContentViewer maxHeight:300 (markdown).
/** ContentViewer maxHeight cap for the result (🟡). */
export const RESULT_MAX_HEIGHT = 300;
/** MarkdownContent wrapper paddingBlock (0.25rem ≈ 4px, top + bottom). */
export const RESULT_MD_PADDING_BLOCK = 4;
/** MarkdownContent wrapper paddingInline (xs = 10px, left + right). */
export const RESULT_MD_PADDING_INLINE = SPACING.xs; // 10

// ── Outer frame ──────────────────────────────────────────────────────────────
/** Paper withBorder edge (1px each side) when inRun=false. */
export const CARD_BORDER = 1;
/** Divider size={1} shown between in-run cards (inRun && !isLast). */
export const DIVIDER_HEIGHT = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Data + options.
// ─────────────────────────────────────────────────────────────────────────────

export interface SubagentCardData {
	/** Agent-type badge label (explore/plan/general/agent/send/…). */
	agentType: string;
	/** Extra "background" badge is shown. Height-neutral (same row). */
	isBackground?: boolean;
	/** Extra model badge label. Height-neutral (same row). */
	model?: string;
	/** Extra thinking-effort badge label. Height-neutral (same row). */
	reasoningEffort?: string;
	/** Description line (collapsed: truncated single line; expanded: wraps). */
	description: string;
	/** Prompt text — presence enables the prompt toggle block. */
	prompt?: string;
	/**
	 * `prompt` is only a PREFIX of the real body (the input was truncated
	 * server-side and the full one has not been fetched yet).
	 *
	 * Such a body reserves the WHOLE cap, mirroring measure-tool-call's
	 * `cappedBodyHeight`: measuring the prefix would tie the height to how many
	 * chars the server's budget happened to include, so the row would resize when
	 * the fetched prompt lands. The box scrolls, so the cap can never clip.
	 */
	promptTruncated?: boolean;
	/**
	 * Owning tool use id. Identity passthrough for the shell's on-demand prompt
	 * fetch — never read for layout.
	 */
	toolUseId?: string;
	/** Result text — drives the result preview line + expanded result block. */
	resultText?: string;
	/** Whether the tool call is in a terminal status (gates the result preview). */
	isTerminal?: boolean;
	/** Number of recent activity calls (≤3 shown). */
	recentCallCount?: number;
	/**
	 * Per-recent-call label detail (`Bash` → its description, `Read` → the file's
	 * basename), POSITIONALLY aligned with the row names.
	 *
	 * Render-only: a row's title is one truncating line, so its length cannot change
	 * the row's fixed height. Present so the vlist row says the same thing the
	 * chunked one does — it previously showed only the bare tool name.
	 */
	recentCallSummaries?: Array<string | null | undefined>;
	/**
	 * Per-recent-call tool category for the row's chip, positionally aligned with
	 * the names. Render-only (fixed 14px chip slot).
	 */
	recentCallCategories?: Array<string | null | undefined>;
	/** Whether the recent-calls title row shows the "open session" button. */
	hasRecentCallsButton?: boolean;
	/** Self-permission detail (P11). Presence forces expansion + the perm block. */
	selfPermission?: InlinePermissionData;
	/**
	 * Per-pending-permission detail (P10 dependency). When supplied the pending
	 * cards are estimated via measureInlinePermission + a header estimate;
	 * otherwise a conservative placeholder is used per card.
	 */
	pendingPermissions?: InlinePermissionData[];
	/** Whether the prompt ContentViewer is currently expanded (default false). */
	promptOpen?: boolean;
	/** Whether the suspended "resolve override" button is shown. */
	hasResolveOverride?: boolean;
	/**
	 * The card's own lifecycle stamps, feeding the header's timing popover
	 * (SubagentCard.tsx:623 renders a ToolTimingArea there). HEIGHT-NEUTRAL: the
	 * popover is portaled and the duration text shares the fixed badge row.
	 */
	timing?: Partial<ToolTimingStamps> | null;
	/**
	 * Per-recent-call stamps, POSITIONALLY aligned with `recentCallNames` (the
	 * adapter derives both from the same filtered list). Each row shows its own
	 * timing, mirroring SubagentCard.tsx:684. Height-neutral — the duration sits in
	 * the row's fixed 27px box next to the truncated tool name.
	 */
	recentCallTimings?: Array<(Partial<ToolTimingStamps> & { status?: string }) | null | undefined>;
}

export interface SubagentMeasureOpts {
	/** Whether this is a recent card (L5 layering). Default true. */
	isRecent?: boolean;
	/** User/soleInRun expand state (L1-L3 + L5-recent). Default false. */
	opened?: boolean;
	/** Explicit click override for L4 / old-L5 header-only cards. */
	lodUserOverride?: boolean;
	/** Whether the subagent is still active (non-terminal). Default !isTerminal. */
	isActive?: boolean;
	/** Whether a self-permission is pending. Default derived from data.selfPermission. */
	hasSelfPermission?: boolean;
	/** Number of pending sub-permissions. Default data.pendingPermissions?.length. */
	pendingPermissionCount?: number;
	/** True when rendered inside a tool-run (no border; optional divider). */
	inRun?: boolean;
	/** True when this is the last card in the run (suppresses the divider). */
	isLast?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result type — MeasuredElement superset carrying the geometry the renderer
// needs to redraw the composite card at the predicted heights.
// ─────────────────────────────────────────────────────────────────────────────

export interface MeasuredSubagent extends MeasuredElement {
	/** Resolved expand decision (LOD + opts). */
	effectiveExpanded: boolean;
	/** Header block height (always shown). */
	headerHeight: number;
	/** Description height inside the header (single line collapsed, wrapped open). */
	descriptionHeight: number;
	/** Whether the collapsed result-preview line is included. */
	hasResultPreview: boolean;
	/** Recent-calls region height (0 when no activity calls). */
	recentCallsHeight: number;
	/** Number of recent rows drawn (min(count, 3)). */
	recentRowCount: number;
	/** Whether the recent-calls title button is drawn. */
	hasRecentCallsButton: boolean;
	/** Total LazyCollapse body height (0 when collapsed). */
	expandedHeight: number;
	/** 1px divider height (inRun && !isLast), else 0. */
	dividerHeight: number;
	/** Outer Paper border height (0 when inRun). */
	borderHeight: number;

	// ── Sub-measures the renderer materializes (null when not drawn) ──
	/** Wrapped description (expanded only); null when collapsed. */
	descriptionMeasured: MeasuredElement | null;
	/** Prompt ContentViewer body (promptOpen only); null otherwise. */
	promptMeasured: MeasuredElement | null;
	/** Prompt block height (toggle row + optional body + padding); 0 when absent. */
	promptBlockHeight: number;
	/**
	 * The prompt body currently drawn is still only a PREVIEW.
	 *
	 * Read by the shell to decide which OPEN prompts should fetch their full input.
	 * Height-relevant indirectly (a truncated body reserves the whole cap), so it is
	 * part of the measure cache key.
	 */
	promptTruncated: boolean;
	/**
	 * Owning tool use id (identity passthrough, never read for layout), so the
	 * shell can bind the on-demand prompt fetch without re-deriving it from the
	 * spec key — which is de-duplicated (`#dup1`) for repeated tool use ids.
	 */
	toolUseId: string | null;
	/** Result ContentViewer body (expanded + resultText); null otherwise. */
	resultMeasured: MeasuredElement | null;
	/** Result block height (min(content,300) + padding); 0 when absent. */
	resultBlockHeight: number;
	/** Self-permission InlinePermission measure (P11); null when absent. */
	selfPermissionMeasured: MeasuredInlinePermission | null;
	/** Self-permission block height (perm + bottom margin); 0 when absent. */
	selfPermissionBlockHeight: number;
	/** Pending-permissions block height; 0 when none. */
	pendingBlockHeight: number;
	/** Number of pending cards drawn. */
	pendingCardCount: number;
	/** Resolve-override block height; 0 when absent. */
	resolveOverrideHeight: number;

	// ── Header timing passthrough (never read for layout) ──
	/** The card's own lifecycle stamps for the header popover. */
	timing: ToolTimingStamps;
	/** One stamp record per DRAWN recent-call row (length == recentRowCount). */
	recentCallTimings: Array<ToolTimingStamps & { status: string | null }>;
	/** Label detail per DRAWN recent-call row (length == recentRowCount). */
	recentCallSummaries: Array<string | null>;
	/** Tool category per DRAWN recent-call row (length == recentRowCount). */
	recentCallCategories: Array<string | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers.
// ─────────────────────────────────────────────────────────────────────────────

function baseBlockFields() {
	return {
		marginTop: 0,
		contentLeft: 0,
		quoteRailLefts: [] as number[],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
}

const EMPTY_FRAME: ElementFrame = { blocks: [], contentHeight: 0, usedWidth: 0 };

/** Measure a wrapping xs text line block (description, expanded). */
function measureWrappedText(text: string, innerWidth: number, className: string): MeasuredElement {
	const items: RichInlineItem[] = [{ text, font: DESC_FONT, break: "normal", extraWidth: 0 }];
	const block: PreparedInlineBlock = {
		...baseBlockFields(),
		kind: "inline",
		flow: prepareRichInline(items),
		lineHeight: XS_LINE_HEIGHT,
		classNames: [className],
		hrefs: [null],
		fonts: [DESC_FONT],
	};
	const frame = accumulateFrame([block], innerWidth, pretextLineMetrics);
	return {
		height: frame.contentHeight,
		blocks: [block],
		frame,
		contentWidth: innerWidth,
		usedWidth: frame.usedWidth,
	};
}

/** Measure the monospace pre-wrap prompt body (before the maxHeight cap). */
function measurePromptBody(prompt: string, innerWidth: number): MeasuredElement {
	const block: PreparedCodeBlock = {
		...baseBlockFields(),
		kind: "code",
		prepared: prepareWithSegments(prompt, PROMPT_FONT, { whiteSpace: "pre-wrap" }),
		lineHeight: PROMPT_LINE_HEIGHT,
		lang: null,
	};
	const frame = accumulateFrame([block], innerWidth, pretextLineMetrics, {
		codePaddingX: 0,
		codePaddingY: 0,
		codeLangExtraTop: 0,
	});
	return {
		height: frame.contentHeight,
		blocks: [block],
		frame,
		contentWidth: innerWidth,
		usedWidth: frame.usedWidth,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// effectiveExpanded — the LOD/expand main switch (mirrors SubagentCard.tsx).
// ─────────────────────────────────────────────────────────────────────────────

export interface SubagentExpandInput {
	isActive: boolean;
	hasSelfPermission: boolean;
	pendingPermissionCount: number;
	isRecent: boolean;
	opened: boolean;
	lodUserOverride?: boolean;
}

/**
 * Decide whether the card body is shown. Pure + deterministic — this is the
 * height/shape main switch and must match SubagentCard.tsx:289-317 exactly.
 */
export function resolveSubagentExpanded(lod: RenderLod, input: SubagentExpandInput): boolean {
	const lodExempt = input.isActive || input.hasSelfPermission || input.pendingPermissionCount > 0;
	if (lodExempt || input.lodUserOverride) return true;
	if (lod >= 5) return true;
	if (lod === 4) return input.isRecent ? input.opened : false;
	if (lod === 3) return false;
	// L1/L2 follow the upstream gate / user-opened state.
	return input.opened;
}

// ─────────────────────────────────────────────────────────────────────────────
// measureSubagentCard.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Measure a SubagentCard at a content width + LOD. Deterministic, zero DOM.
 * @param data         subagent card data (badges/description/prompt/result/…)
 * @param contentWidth available OUTER card width in px
 * @param lod          render LOD (1..6) — selects effectiveExpanded
 * @param opts         layering inputs (isRecent/opened/isActive/permissions/inRun)
 */
export function measureSubagentCard(
	data: SubagentCardData,
	contentWidth: number,
	lod: RenderLod = DEFAULT_RENDER_LOD,
	opts: SubagentMeasureOpts = {},
): MeasuredSubagent {
	const isTerminal = data.isTerminal === true;
	const isActive = opts.isActive ?? !isTerminal;
	const hasSelfPermission = opts.hasSelfPermission ?? !!data.selfPermission;
	const pendingCount =
		data.pendingPermissions?.length ?? Math.max(0, opts.pendingPermissionCount ?? 0);
	const isRecent = opts.isRecent ?? true;
	const opened = opts.opened ?? false;
	const inRun = opts.inRun === true;

	const effectiveExpanded = resolveSubagentExpanded(lod, {
		isActive,
		hasSelfPermission,
		pendingPermissionCount: pendingCount,
		isRecent,
		opened,
		lodUserOverride: opts.lodUserOverride,
	});

	// ── Header (always shown) ──────────────────────────────────────────────────
	const hasResultPreview = !effectiveExpanded && isTerminal && !!data.resultText;
	const descInnerWidth = Math.max(1, contentWidth - CARD_PADDING * 2 - DESC_LEFT);
	const descriptionMeasured = effectiveExpanded
		? measureWrappedText(data.description, descInnerWidth, "vlist-sa-desc")
		: null;
	const descriptionHeight = descriptionMeasured
		? descriptionMeasured.frame.contentHeight
		: XS_LINE_HEIGHT;

	const headerHeight =
		CARD_PADDING * 2 +
		BADGE_ROW_HEIGHT +
		DESC_MARGIN_TOP +
		descriptionHeight +
		(hasResultPreview ? RESULT_PREVIEW_MARGIN_TOP + XS_LINE_HEIGHT : 0);

	// ── Recent Calls (always shown when there are activity calls) ───────────────
	const recentRowCount = Math.min(Math.max(0, data.recentCallCount ?? 0), RECENT_MAX_ROWS);
	const hasRecentCallsButton = data.hasRecentCallsButton === true;
	let recentCallsHeight = 0;
	if (recentRowCount > 0) {
		const titleRow = hasRecentCallsButton
			? Math.max(XS_LINE_HEIGHT, BUTTON_COMPACT_XS)
			: XS_LINE_HEIGHT;
		const rowsHeight = recentRowCount * RECENT_ROW_HEIGHT + (recentRowCount - 1) * RECENT_STACK_GAP;
		recentCallsHeight = titleRow + RECENT_TITLE_MARGIN_BOTTOM + rowsHeight + BLOCK_PADDING_BOTTOM;
	}

	// ── Expanded body (LazyCollapse) ────────────────────────────────────────────
	let expandedHeight = 0;
	let selfPermissionMeasured: MeasuredInlinePermission | null = null;
	let selfPermissionBlockHeight = 0;
	let promptMeasured: MeasuredElement | null = null;
	let promptBlockHeight = 0;
	let pendingBlockHeight = 0;
	let pendingCardCount = 0;
	let resolveOverrideHeight = 0;
	let resultMeasured: MeasuredElement | null = null;
	let resultBlockHeight = 0;

	if (effectiveExpanded) {
		// selfPermission (Box mx="xs" mb="xs" + InlinePermission).
		if (hasSelfPermission) {
			const permWidth = Math.max(1, contentWidth - SELF_PERMISSION_MARGIN_X * 2);
			selfPermissionMeasured = measureInlinePermission(data.selfPermission ?? {}, permWidth, lod);
			selfPermissionBlockHeight = selfPermissionMeasured.height + SELF_PERMISSION_MARGIN_BOTTOM;
			expandedHeight += selfPermissionBlockHeight;
		}

		// prompt (toggle row + optional ContentViewer maxHeight:200).
		if (data.prompt) {
			const promptOpen = data.promptOpen === true;
			let body = 0;
			if (promptOpen) {
				const promptInnerWidth = Math.max(1, contentWidth - BLOCK_PADDING_X * 2);
				promptMeasured = measurePromptBody(data.prompt, promptInnerWidth);
				// A still-truncated prompt reserves the full cap, so the fetched body
				// arriving later cannot resize a committed row (see `promptTruncated`).
				const capped =
					data.promptTruncated === true
						? PROMPT_MAX_HEIGHT
						: Math.min(promptMeasured.frame.contentHeight, PROMPT_MAX_HEIGHT);
				body = PROMPT_BODY_MARGIN_TOP + capped;
			}
			promptBlockHeight = PROMPT_TOGGLE_ROW_HEIGHT + body + BLOCK_PADDING_BOTTOM;
			expandedHeight += promptBlockHeight;
		}

		// pendingPermissions (title + ToolCallCard × N — P10 placeholder).
		if (pendingCount > 0) {
			pendingCardCount = pendingCount;
			const cardInnerWidth = Math.max(
				1,
				contentWidth - BLOCK_PADDING_X * 2 - PENDING_CARD_BORDER * 2,
			);
			let cardsHeight = 0;
			for (let i = 0; i < pendingCount; i++) {
				const detail = data.pendingPermissions?.[i];
				const cardBody = detail
					? TOOLCALL_HEADER_ESTIMATE + measureInlinePermission(detail, cardInnerWidth, lod).height
					: PENDING_PERMISSION_CARD_PLACEHOLDER;
				cardsHeight += cardBody + PENDING_CARD_BORDER * 2;
			}
			cardsHeight += (pendingCount - 1) * PENDING_STACK_GAP;
			pendingBlockHeight =
				PENDING_TITLE_ROW_HEIGHT + PENDING_TITLE_MARGIN_BOTTOM + cardsHeight + BLOCK_PADDING_BOTTOM;
			expandedHeight += pendingBlockHeight;
		}

		// resolveOverride (compact-xs button).
		if (data.hasResolveOverride) {
			resolveOverrideHeight = RESOLVE_OVERRIDE_BUTTON_HEIGHT + BLOCK_PADDING_BOTTOM;
			expandedHeight += resolveOverrideHeight;
		}

		// resultText (ContentViewer maxHeight:300, markdown).
		if (data.resultText) {
			const resultInnerWidth = Math.max(
				1,
				contentWidth - BLOCK_PADDING_X * 2 - RESULT_MD_PADDING_INLINE * 2,
			);
			resultMeasured = measureMarkdown(data.resultText, resultInnerWidth);
			const mdHeight = resultMeasured.frame.contentHeight + RESULT_MD_PADDING_BLOCK * 2;
			const capped = Math.min(mdHeight, RESULT_MAX_HEIGHT);
			resultBlockHeight = capped + BLOCK_PADDING_BOTTOM;
			expandedHeight += resultBlockHeight;
		}
	}

	// ── Outer frame ─────────────────────────────────────────────────────────────
	const borderHeight = inRun ? 0 : CARD_BORDER * 2;
	const dividerHeight = inRun && opts.isLast !== true ? DIVIDER_HEIGHT : 0;

	const height =
		borderHeight +
		headerHeight +
		recentCallsHeight +
		(effectiveExpanded ? expandedHeight : 0) +
		dividerHeight;

	return {
		height,
		blocks: [],
		frame: { ...EMPTY_FRAME, blocks: [] },
		contentWidth,
		usedWidth: contentWidth,
		effectiveExpanded,
		headerHeight,
		descriptionHeight,
		hasResultPreview,
		recentCallsHeight,
		recentRowCount,
		hasRecentCallsButton,
		expandedHeight,
		dividerHeight,
		borderHeight,
		descriptionMeasured,
		promptMeasured,
		promptBlockHeight,
		promptTruncated: promptMeasured != null && data.promptTruncated === true,
		toolUseId: data.toolUseId ?? null,
		resultMeasured,
		resultBlockHeight,
		selfPermissionMeasured,
		selfPermissionBlockHeight,
		pendingBlockHeight,
		pendingCardCount,
		resolveOverrideHeight,
		timing: resolveToolTimingStamps(data.timing ?? {}),
		// Sliced to the DRAWN rows so the renderer can index it in lockstep with the
		// names it paints (both are capped at RECENT_MAX_ROWS).
		recentCallTimings: (data.recentCallTimings ?? []).slice(0, recentRowCount).map((entry) => ({
			...resolveToolTimingStamps(entry ?? {}),
			status: typeof entry?.status === "string" ? entry.status : null,
		})),
		// Sliced and length-normalized the same way, so the renderer can index all
		// three arrays in lockstep with the names it paints.
		recentCallSummaries: sliceRowStrings(data.recentCallSummaries, recentRowCount),
		recentCallCategories: sliceRowStrings(data.recentCallCategories, recentRowCount),
	};
}

/**
 * Normalize a per-row string array to exactly `count` entries.
 *
 * Padding with nulls (rather than returning a short array) is what lets the
 * renderer index it positionally without a bounds check — a header that arrived
 * with no summary is `null`, not `undefined` from a missing slot.
 */
function sliceRowStrings(
	values: Array<string | null | undefined> | undefined,
	count: number,
): Array<string | null> {
	const out: Array<string | null> = [];
	for (let i = 0; i < count; i++) {
		const value = values?.[i];
		out.push(typeof value === "string" && value.length > 0 ? value : null);
	}
	return out;
}

/** Parse once, measure many (e.g. on resize / LOD change). Reusable closure. */
export function prepareSubagentMeasurer(
	data: SubagentCardData,
): (contentWidth: number, lod?: RenderLod, opts?: SubagentMeasureOpts) => MeasuredSubagent {
	return (contentWidth, lod = DEFAULT_RENDER_LOD, opts = {}) =>
		measureSubagentCard(data, contentWidth, lod, opts);
}

export const MEASURE_SUBAGENT_CONSTANTS = {
	CARD_PADDING,
	XS_LINE_HEIGHT,
	THEME_ICON_SIZE,
	BADGE_XS_HEIGHT,
	CHEVRON_SIZE,
	STATUS_ICON_SIZE,
	BADGE_ROW_HEIGHT,
	DESC_MARGIN_TOP,
	DESC_LEFT,
	RESULT_PREVIEW_MARGIN_TOP,
	BUTTON_COMPACT_XS,
	RECENT_TITLE_MARGIN_BOTTOM,
	RECENT_ROW_HEIGHT,
	RECENT_STACK_GAP,
	RECENT_MAX_ROWS,
	BLOCK_PADDING_X,
	BLOCK_PADDING_BOTTOM,
	SELF_PERMISSION_MARGIN_X,
	SELF_PERMISSION_MARGIN_BOTTOM,
	PROMPT_TOGGLE_ROW_HEIGHT,
	PROMPT_BODY_MARGIN_TOP,
	PROMPT_MAX_HEIGHT,
	PROMPT_LINE_HEIGHT,
	PENDING_TITLE_ROW_HEIGHT,
	PENDING_TITLE_MARGIN_BOTTOM,
	PENDING_CARD_BORDER,
	PENDING_STACK_GAP,
	PENDING_PERMISSION_CARD_PLACEHOLDER,
	TOOLCALL_HEADER_ESTIMATE,
	RESOLVE_OVERRIDE_BUTTON_HEIGHT,
	RESULT_MAX_HEIGHT,
	RESULT_MD_PADDING_BLOCK,
	RESULT_MD_PADDING_INLINE,
	CARD_BORDER,
	DIVIDER_HEIGHT,
} as const;
