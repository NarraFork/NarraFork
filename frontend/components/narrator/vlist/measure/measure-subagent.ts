/**
 * measure-subagent.ts — Height model for the SubagentCard (batch-2 P12).
 *
 * L1 defaults to folded; L2–L5 follow the reader's preference, not recency. The height
 * model takes (data, contentWidth, lod, opts) and resolves `effectiveExpanded`
 * deterministically; nested permissions still receive the current LOD. The card
 * has always-visible regions plus a collapsible expansion body:
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

import { prepareRichInline, type RichInlineItem } from "@chenglou/pretext/rich-inline";
// The recent-call rows ARE trace rows, so their height comes from the shared row
// metrics rather than a second copy of it. Sourced from `row-metrics` directly
// (NOT `./measure-tool-run`, which merely re-exports it): measure-tool-run now
// imports THIS module to measure a drilled-in subagent card, so importing it back
// would close a cycle — and `RECENT_ROW_HEIGHT` is a module-level const, which
// would hit the TDZ at import time.
import { BARE_ROW_HEIGHT, bareRowMetrics } from "@shared/pretext-layout/row-metrics";
import type { ToolCappedDetail } from "@shared/pretext-layout/tool-detail";
import { scaleFontSize } from "@shared/pretext-layout/typography";
import { readBackgroundTaskId } from "@shared/subagent-result-text";
import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type ElementFrame,
	type MeasuredElement,
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
	scaledFont,
	scaledLineBoxHeight,
	typographyMetrics,
} from "../pretext-fonts";
import {
	type InlinePermissionData,
	type MeasuredInlinePermission,
	measureInlinePermission,
} from "./measure-permission";
import {
	type MeasuredToolBody,
	measureToolBody,
	resolveToolTimingStamps,
	type ToolTimingStamps,
} from "./measure-tool-call";
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
/**
 * Badge row at NEUTRAL typography — tallest inline element (xs text line dominates icons/badges).
 * Baseline only; measurement/paint read {@link badgeRowHeight}.
 */
export const BADGE_ROW_HEIGHT = Math.max(
	THEME_ICON_SIZE,
	BADGE_XS_HEIGHT,
	XS_LINE_HEIGHT,
	CHEVRON_SIZE,
	STATUS_ICON_SIZE,
); // 17

/** Badge-row height at the reader's current typography (only the xs line scales). */
export function badgeRowHeight(): number {
	return Math.max(
		THEME_ICON_SIZE,
		BADGE_XS_HEIGHT,
		typographyMetrics().line.xs,
		CHEVRON_SIZE,
		STATUS_ICON_SIZE,
	);
}

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
 * expressed by taking the height from the shared row metrics (`BARE_ROW_HEIGHT`,
 * the constant `measure-tool-run`'s `TRACE_ROW_HEIGHT` re-exports) rather than
 * restating it.
 *
 * NEUTRAL baseline: measurement reads `bareRowMetrics().height` so the row follows
 * the reader's font scale. Keeping this a constant while a trace row scaled would
 * reintroduce exactly the mismatch described above — the same call rendered at two
 * different heights depending on which surface showed it.
 */
export const RECENT_ROW_HEIGHT = BARE_ROW_HEIGHT; // 18.8

// ── File changes (`+N -N` per path) ──────────────────────────────────────────
//
// Reuses the recent-call row geometry: same xs mono line, same flush stacking, so a
// file row and an activity row sit on the same rhythm and neither needs its own
// metric. The rows are single-line and truncating, so only their COUNT drives height.

/**
 * Visible file rows before the reader expands the list.
 *
 * Mirrors the server's `CARD_FILE_LIST_MAX`. Kept small on purpose: this list is
 * MEASURED, so an uncapped one would let a single card (220 files in real data) eat
 * the viewport. The rest stays one click away.
 */
export const FILE_CHANGE_MAX_ROWS = 5;

/** Height of one file row (identical to a recent-call row). */
export const FILE_CHANGE_ROW_HEIGHT = BARE_ROW_HEIGHT;

/** Gap between stacked file rows (flush, like recent calls). */
export const FILE_CHANGE_STACK_GAP = 0;

/** Structural mirror of the server payload. Missing legacy location is UNKNOWN, not local. */
export interface SubagentFileChangesData {
	files: {
		subagentNarratorId?: string | null;
		deviceId?: string | null;
		workspacePath?: string | null;
		filePath: string;
		linesAdded: number | null;
		linesRemoved: number | null;
		editCount: number;
		unmeasuredCount?: number;
		/** Even false describes location only; it never authorizes a revert. */
		outsideParentWorkspace?: boolean | null;
	}[];
	totalFiles: number;
	totalUnmeasured: number;
	bashTouchedCount: number;
	countsTruncated: boolean;
	/** Exact only when the current execution segment has complete v2 evidence. */
	attributionScope?: "exact_attempt" | "mixed" | "legacy_unscoped";
	/** Requested filter boundary, NOT evidence linking changes to an execution attempt. */
	scope?: {
		sourceToolUseId: string | null;
		startedAt?: string | null;
		completedAt?: string | null;
	};
}

/** A display path alone is not identity, including within one child's card. */
export function subagentFileChangeIdentityKey(
	file: SubagentFileChangesData["files"][number],
): string {
	return JSON.stringify([
		file.subagentNarratorId ?? null,
		file.deviceId || null,
		file.workspacePath || null,
		file.filePath,
	]);
}

/** Card-local scope identity. Presence of a window never upgrades legacy attribution. */
export function subagentFileChangeScopeKey(changes: SubagentFileChangesData): string {
	return JSON.stringify([
		changes.attributionScope ?? "legacy_unscoped",
		changes.scope
			? [
					changes.scope.sourceToolUseId ?? null,
					changes.scope.startedAt ?? null,
					changes.scope.completedAt ?? null,
				]
			: null,
	]);
}
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
/** Baseline size of the prompt body, shared by the font string and the line box. */
export const PROMPT_FONT_SIZE = 11;
/** Prompt ContentViewer is a <Code block style={{fontSize:11}}> (monospace). */
export const PROMPT_FONT = `${FONT_WEIGHT.regular} ${PROMPT_FONT_SIZE}px ${MONO_FAMILY}`;
/** Prompt line box: round(11 × 1.55) = 17 (Code block base line-height). */
export const PROMPT_LINE_HEIGHT = lineBoxHeight(PROMPT_FONT_SIZE, LINE_HEIGHT.md);
/** promptLineHeight() at the reader's typography (baseline above). */
export function promptLineHeight(): number {
	return scaledLineBoxHeight(11, LINE_HEIGHT.md);
} // 17
/**
 * Scaled prompt font — the partner of `promptLineHeight()`, and it must move with it.
 *
 * Measuring with the frozen `PROMPT_FONT` while sizing the line box with the scaled
 * helper made the wrap width and the reserved height disagree, which the fixed 200px
 * prompt cap then silently clips.
 */
export function promptFont(): string {
	return scaledFont(FONT_WEIGHT.regular, PROMPT_FONT_SIZE, MONO_FAMILY);
}
/** Scaled prompt font size (px), for the render layer's `fontSize`. */
export function promptFontSize(): number {
	return scaleFontSize(PROMPT_FONT_SIZE);
}

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
	/**
	 * Extra "taken over by user" badge is shown — the parent's call is blocked
	 * until the user releases the child. Height-neutral (same fixed badge row as
	 * the background badge), but PAINTED from the cached payload, so it is keyed in
	 * `subagentRevision`: the takeover patch writes this field alone, with `status`,
	 * `opts` and `messageVersion` all unmoved.
	 */
	isTakenOver?: boolean;
	/** Extra model badge label. Height-neutral (same row). */
	model?: string;
	/** Extra thinking-effort badge label. Height-neutral (same row). */
	reasoningEffort?: string;
	/** Description line (collapsed: truncated single line; expanded: wraps). */
	description: string;
	/** Prompt text — presence enables the prompt toggle block. */
	prompt?: string;
	promptBody?: ToolCappedDetail;
	resultBody?: ToolCappedDetail;
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
	/**
	 * Files this subagent changed on disk (`+N -N` per path).
	 *
	 * HEIGHT-AFFECTING, unlike the tool card's `diffStats`: this is a LIST of rows, so
	 * every visible entry makes the card taller. That is why the visible count is
	 * capped ({@link FILE_CHANGE_MAX_ROWS}) and the remainder hides behind an expand
	 * row — one parent in real data aggregated 220 changed files.
	 */
	fileChanges?: SubagentFileChangesData;
	/** The reader expanded the file list (shows all rows instead of the capped head). */
	fileChangesExpanded?: boolean;
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
	promptMeasured: MeasuredToolBody<ToolCappedDetail> | null;
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
	resultMeasured: MeasuredToolBody<ToolCappedDetail> | null;
	/** Result block height (min(content,300) + padding); 0 when absent. */
	resultBlockHeight: number;
	/** Replace a background launch acknowledgement with a compact panel shortcut. */
	hasBackgroundNotice: boolean;
	/** File-changes block height (title + attribution notices + rows + overflow). */
	fileChangesHeight: number;
	/** Shared title/notice/file/overflow line height at the measured typography. */
	fileChangeRowHeight: number;
	/** Legacy notice, plus a requested-boundary notice when a scope was supplied. */
	fileChangeNoticeRowCount: number;
	/** How many file rows are DRAWN (capped unless the reader expanded the list). */
	fileChangeRowCount: number;
	/** Whether the trailing "N more / N touched by shell" row is drawn. */
	hasFileChangeOverflowRow: boolean;
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
	const items: RichInlineItem[] = [
		{ text, font: typographyMetrics().font.xs, break: "normal", extraWidth: 0 },
	];
	const block: PreparedInlineBlock = {
		...baseBlockFields(),
		kind: "inline",
		flow: prepareRichInline(items),
		lineHeight: typographyMetrics().line.xs,
		classNames: [className],
		hrefs: [null],
		fonts: [typographyMetrics().font.xs],
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

// ─────────────────────────────────────────────────────────────────────────────
// effectiveExpanded — reader preference with active/permission exemptions.
// ─────────────────────────────────────────────────────────────────────────────

export interface SubagentExpandInput {
	isActive: boolean;
	hasSelfPermission: boolean;
	pendingPermissionCount: number;
	isRecent: boolean;
	opened: boolean;
	lodUserOverride?: boolean;
	/**
	 * The reader EXPLICITLY folded this card (a stored preference), as opposed to
	 * `opened === false` merely being the derived default. Only the former may
	 * collapse a card at any LOD — see `resolveSubagentExpanded`.
	 */
	userCollapsed?: boolean;
}

/** Decide whether the card body is shown; shared by measurement and rendering. */
export function resolveSubagentExpanded(lod: RenderLod, input: SubagentExpandInput): boolean {
	const lodExempt = input.isActive || input.hasSelfPermission || input.pendingPermissionCount > 0;
	if (lodExempt || input.lodUserOverride) return true;
	if (lod === 1) return false;
	// L2–L5 stay expanded regardless of recency, unless the reader folds the card.
	return !input.userCollapsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// measureSubagentCard.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Measure a SubagentCard at a content width + LOD. Deterministic, zero DOM.
 * @param data         subagent card data (badges/description/prompt/result/…)
 * @param contentWidth available OUTER card width in px
 * @param lod          render LOD (1..5) — passed to nested permission cards
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
		// Distinct from `opened === false`, which is also the DEFAULT here (`?? false`)
		// and therefore says nothing about the reader's intent. Only a stored
		// preference may fold a card, at any LOD.
		userCollapsed: opts.opened === false,
	});

	// ── Header (always shown) ──────────────────────────────────────────────────
	// Background launch acknowledgements are protocol text, not user-facing output.
	// Keep errors and actual results readable rather than hiding every background result.
	// Detached foreground agents also return this envelope without run_in_background.
	const hasBackgroundNotice = readBackgroundTaskId(data.resultBody?.text ?? "") !== undefined;
	const hasResultPreview =
		!hasBackgroundNotice && !effectiveExpanded && isTerminal && !!data.resultBody?.text;
	const descInnerWidth = Math.max(1, contentWidth - CARD_PADDING * 2 - DESC_LEFT);
	const descriptionMeasured = effectiveExpanded
		? measureWrappedText(data.description, descInnerWidth, "vlist-sa-desc")
		: null;
	const descriptionHeight = descriptionMeasured
		? descriptionMeasured.frame.contentHeight
		: typographyMetrics().line.xs;

	const headerHeight =
		CARD_PADDING * 2 +
		badgeRowHeight() +
		DESC_MARGIN_TOP +
		descriptionHeight +
		(hasResultPreview ? RESULT_PREVIEW_MARGIN_TOP + typographyMetrics().line.xs : 0);

	// ── File changes (expanded only; row COUNT is the whole height model) ───────
	const fileChangeTotal = data.fileChanges?.files.length ?? 0;
	// Expanded shows every row; collapsed shows the capped head. Both are bounded —
	// the expanded case by the server's own aggregate cap.
	const fileChangeRowCount =
		data.fileChangesExpanded === true
			? fileChangeTotal
			: Math.min(fileChangeTotal, FILE_CHANGE_MAX_ROWS);
	// Keep the toggle after expansion so the list can collapse again. Shell-only,
	// unmeasured-only and budget-truncated observations need this row even when
	// there are NO Write/Edit files. totalFiles can also exceed the returned list.
	const hasFileChangeOverflowRow =
		fileChangeTotal > FILE_CHANGE_MAX_ROWS ||
		fileChangeRowCount < (data.fileChanges?.totalFiles ?? 0) ||
		(data.fileChanges?.bashTouchedCount ?? 0) > 0 ||
		(data.fileChanges?.totalUnmeasured ?? 0) > 0 ||
		data.fileChanges?.countsTruncated === true;
	const hasFileChanges = fileChangeRowCount > 0 || hasFileChangeOverflowRow;
	const fileChangeRowHeight = bareRowMetrics().height;
	// Only legacy-only file rows need the long attribution warning. Exact v2 and
	// mixed/Bash-best-effort cards should not reserve a warning row by default.
	const hasLegacyFileNotice =
		hasFileChanges &&
		(data.fileChanges?.attributionScope ?? "legacy_unscoped") === "legacy_unscoped" &&
		fileChangeTotal > 0;
	const fileChangeNoticeRowCount = hasLegacyFileNotice ? 1 + (data.fileChanges?.scope ? 1 : 0) : 0;
	let fileChangesHeight = 0;

	// ── Recent Calls (always shown when there are activity calls) ───────────────
	const recentRowCount = Math.min(Math.max(0, data.recentCallCount ?? 0), RECENT_MAX_ROWS);
	const hasRecentCallsButton = data.hasRecentCallsButton === true;
	let recentCallsHeight = 0;
	if (recentRowCount > 0) {
		const titleRow = hasRecentCallsButton
			? Math.max(typographyMetrics().line.xs, BUTTON_COMPACT_XS)
			: typographyMetrics().line.xs;
		const rowsHeight =
			recentRowCount * bareRowMetrics().height + (recentRowCount - 1) * RECENT_STACK_GAP;
		recentCallsHeight = titleRow + RECENT_TITLE_MARGIN_BOTTOM + rowsHeight + BLOCK_PADDING_BOTTOM;
	}

	// ── Expanded body (LazyCollapse) ────────────────────────────────────────────
	let expandedHeight = 0;
	let selfPermissionMeasured: MeasuredInlinePermission | null = null;
	let selfPermissionBlockHeight = 0;
	let promptMeasured: MeasuredToolBody<ToolCappedDetail> | null = null;
	let promptBlockHeight = 0;
	let pendingBlockHeight = 0;
	let pendingCardCount = 0;
	let resolveOverrideHeight = 0;
	let resultMeasured: MeasuredToolBody<ToolCappedDetail> | null = null;
	let resultBlockHeight = 0;

	if (effectiveExpanded) {
		// selfPermission (Box mx="xs" mb="xs" + InlinePermission).
		if (hasSelfPermission) {
			const permWidth = Math.max(1, contentWidth - SELF_PERMISSION_MARGIN_X * 2);
			selfPermissionMeasured = measureInlinePermission(data.selfPermission ?? {}, permWidth, lod);
			selfPermissionBlockHeight = selfPermissionMeasured.height + SELF_PERMISSION_MARGIN_BOTTOM;
			expandedHeight += selfPermissionBlockHeight;
		}

		// Prompt and result use the same body model and painter as tool sections.
		if (data.promptBody) {
			let body = 0;
			if (data.promptOpen === true) {
				promptMeasured = measureToolBody(
					data.promptBody,
					Math.max(1, contentWidth - BLOCK_PADDING_X * 2),
				);
				body = PROMPT_BODY_MARGIN_TOP + promptMeasured.height;
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

		// Title + explicit legacy/boundary notices + file rows + optional summary.
		// Every row is single-line and truncating. Clamp seams at zero: summary-only
		// blocks must not acquire a negative gap when no file rows were returned.
		if (hasFileChanges) {
			fileChangesHeight =
				(1 + fileChangeNoticeRowCount + fileChangeRowCount + (hasFileChangeOverflowRow ? 1 : 0)) *
					fileChangeRowHeight +
				Math.max(0, fileChangeRowCount - 1) * FILE_CHANGE_STACK_GAP +
				BLOCK_PADDING_BOTTOM;
			expandedHeight += fileChangesHeight;
		}

		if (hasBackgroundNotice) {
			resultBlockHeight =
				Math.max(typographyMetrics().line.xs, BUTTON_COMPACT_XS) + BLOCK_PADDING_BOTTOM;
			expandedHeight += resultBlockHeight;
		} else if (data.resultBody) {
			resultMeasured = measureToolBody(
				data.resultBody,
				Math.max(1, contentWidth - BLOCK_PADDING_X * 2),
			);
			resultBlockHeight = resultMeasured.height + BLOCK_PADDING_BOTTOM;
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
		promptTruncated: promptMeasured != null && data.promptBody?.textTruncated === true,
		toolUseId: data.toolUseId ?? null,
		resultMeasured,
		resultBlockHeight,
		hasBackgroundNotice,
		fileChangesHeight,
		fileChangeRowHeight,
		fileChangeNoticeRowCount,
		fileChangeRowCount,
		hasFileChangeOverflowRow,
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
