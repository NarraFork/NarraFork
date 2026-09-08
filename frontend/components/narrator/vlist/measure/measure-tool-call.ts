/**
 * measure-tool-call.ts — Height model for the ToolCallCard (batch-2 P10), the
 * single most complex vlist element. Visual parity targets (do NOT import them —
 * this is a zero-DOM measure copy):
 *   - ToolCallCard.tsx  — ToolHeader(:1746) + effectiveOpened(:5594) +
 *     defaultOpen(:5483) + the per-category *Detail renderers + the grouped card
 *     ToolCallGroup(:6136).
 *   - ToolCallCard.module.css — the native-span header styles (headerText uses
 *     `line-height: var(--mantine-line-height)` = base 1.55, NOT xs 1.4).
 *
 * ── The card shape (CONTRACT.md §4 ToolCallCard) ──────────────────────────────
 *
 *   standalone: <Paper withBorder p="xs">            (10px padding + 1px border)
 *   in a run  : <Box p="xs"> … </Box> + <Divider>    (no border; 1px divider
 *                                                      unless it is the last row)
 *     <ToolHeader/>                                   ← ALWAYS a single row
 *     <LazyCollapse in={effectiveOpened}>             ← 0-height when collapsed
 *       <Box style={planStyle}><DetailRenderer/></Box>← the detail region
 *       {permissionUI}                                ← InlinePermission (pending)
 *     </LazyCollapse>
 *
 * ── Header (always one row) ───────────────────────────────────────────────────
 *   category icon(16) + displayName(xs mono) + summary(xs mono, truncate) +
 *   [remote badge] + StatusIcon(12) + timing + chevron(12). The header text uses
 *   the module CSS `--mantine-line-height` (1.55) → 12×1.55 = 19px line box; the
 *   16px category-icon lane is shorter, so the header row is 19px. Collapsed card
 *   ≈ 10*2 + 1*2 + 19 = 41px (standalone) — within the 40-42px target.
 *
 * ── Detail region: maxHeight-capped (🟡 = min(content, cap)) ──────────────────
 * Each detail body is clamped by a maxHeight, so its height is `min(content,
 * cap)` — beyond the cap we only need to know THAT it overflows.
 * The caps (see DETAIL_CAPS):
 *   code / term / diff / generic = 200,  bash & terminal command = 60,
 *   image/video/iframe / skill / knowledge = 400,  streaming bash = 120,
 *   other streaming = 400,  plan = 0.85 × viewport height (falls back to 400).
 * When a detail carries its real body `text`, the content height comes from
 * measuring how that text WRAPS at the available width (pretext arithmetic, zero
 * DOM) — bounded to a prefix that can only ever exceed the cap, so sub-cap
 * results stay exact while huge bodies cost O(cap). Details with no text (media,
 * estimate-only) fall back to `contentLines × line height` or a pixel estimate.
 *
 * ── Detail region: pretext-measured (🔴) ─────────────────────────────────────
 * A few detail shapes are NOT capped and DO wrap, so they are measured with
 * pretext (zero DOM): SpecTasks (N tasks × wrapped rows), the structured
 * Recall/Send/Pipeline/WebSearch segments (badge header + wrapped body lines),
 * and error text (wrapped pre-wrap). These use PreparedInlineBlock.
 *
 * ── Permission UI (pendingPermission) ─────────────────────────────────────────
 * When the card is pending a permission decision, the expanded body also carries
 * the InlinePermission form. We REUSE measure-permission.ts's
 * `measureInlinePermission` (P11) rather than re-deriving it.
 *
 * ── effectiveOpened (mirrors ToolCallCard :5594) ──────────────────────────────
 *   lodExempt (running / streaming / pendingPermission) → always expanded.
 *   L6 → expanded.  L5 → recent cards follow `opened`, older cards collapse.
 *   L4 → collapsed.  L1-L3 → handled by the upstream tool-run gate; a card shown
 *   at those levels is treated as collapsed here.
 *
 * ── Grouped card (ToolCallGroup) ──────────────────────────────────────────────
 * Paper p="xs" + a header row (label + ×N badge + status + chevron) + an
 * expandable body (mt=4, pl=4, 2px left border) that stacks the child cards.
 * Default collapsed. Child cards are measured with measureToolCall at the inner
 * width and their heights accumulate.
 *
 * Zero DOM. Follows the measure-markdown / measure-reasoning / measure-permission
 * templates.
 */

import { measureLineStats, prepareWithSegments } from "@chenglou/pretext";
import { prepareRichInline, type RichInlineItem } from "@chenglou/pretext/rich-inline";
import {
	type DiffDocument,
	diffDocumentLineNoWidth,
	readDiffRowContent,
} from "@shared/pretext-layout/diff-core";
import type {
	DetailCapKind,
	ToolAskQuestion,
	ToolCappedDetail,
	ToolDetailData,
	ToolMediaRef,
	ToolMetaRow,
	ToolSectionBody,
	ToolSectionLabel,
	ToolStructuredEntry,
} from "@shared/pretext-layout/tool-detail";
import { ASK_OPTIONS_MAX, ASK_QUESTIONS_MAX } from "@shared/pretext-layout/tool-detail";

export type {
	DetailCapKind,
	SpecTaskLine,
	ToolAskDetail,
	ToolAskOption,
	ToolAskQuestion,
	ToolCappedDetail,
	ToolDetailData,
	ToolDetailSection,
	ToolErrorDetail,
	ToolMediaRef,
	ToolMetaRow,
	ToolMetaRowsDetail,
	ToolRowAction,
	ToolRowProgress,
	ToolSectionBody,
	ToolSectionLabel,
	ToolSectionsDetail,
	ToolSpecTasksDetail,
	ToolStructuredBadge,
	ToolStructuredDetail,
	ToolStructuredEntry,
} from "@shared/pretext-layout/tool-detail";
export {
	ASK_OPTIONS_MAX,
	ASK_QUESTIONS_MAX,
	MEDIA_IMAGE_CONTENT_PX,
} from "@shared/pretext-layout/tool-detail";

import {
	type FittedImageBox,
	fitImageBox,
	readImageIntrinsicSize,
} from "@shared/pretext-layout/image-fit";
import type { ReflectionNoticeData } from "@shared/pretext-layout/reflection";
import { BARE_ROW_GAP, BARE_ROW_ICON } from "@shared/pretext-layout/row-metrics";
import { letterSpacingPxFor, scaleFontSize } from "@shared/pretext-layout/typography";
import { MARKDOWN_CONSTANTS } from "../parse-markdown";
import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type ElementFrame,
	type LineMetricsResolver,
	type MeasuredElement,
	type PreparedBlock,
	type PreparedFixedBlock,
	type PreparedInlineBlock,
	type RenderLod,
} from "../prepared-block";
import {
	BASE_LINE_HEIGHT,
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
import { preparedMarkdownBlocks } from "./math-support";
import { MEASURE_MARKDOWN_CODE_PADDING } from "./measure-markdown";
import {
	ALERT_STACK_GAP,
	CUSTOM_ANSWER_FONT,
	CUSTOM_ANSWER_LINE_HEIGHT,
	HEADER_FONT,
	HEADER_LINE_HEIGHT,
	type InlinePermissionData,
	type MeasuredInlinePermission,
	measureInlinePermission,
	OPTION_DESC_FONT,
	OPTION_DESC_LINE_HEIGHT,
	OPTION_DESC_MARGIN_TOP,
	OPTION_INDENT,
	OPTION_LABEL_FONT,
	OPTION_LABEL_LINE_HEIGHT,
	OPTIONS_GAP,
	QUESTION_STACK_GAP,
} from "./measure-permission";
import {
	type MeasuredReflectionNotice,
	measureReflectionNotice,
} from "./measure-reflection-notice";
import { pretextLineMetrics } from "./pretext-metrics";

// ─────────────────────────────────────────────────────────────────────────────
// Tool category — a LOCAL copy of ToolCallCard.tsx's ToolCategory union. We do
// NOT import from ToolCallCard.tsx: it is a heavy React/Mantine module and the
// measure layer must stay pure/arithmetic (mirrors measure-web-search.ts not
// importing i18n). The dispatch/registry layer maps a live tool call to this.
// ─────────────────────────────────────────────────────────────────────────────
export type ToolCategory =
	| "read"
	| "file"
	| "bash"
	| "search"
	| "webSearch"
	| "webFetch"
	| "tasks"
	| "taskOutput"
	| "agent"
	| "await"
	| "send"
	| "ask"
	| "plan"
	| "pipeline"
	| "terminal"
	| "share"
	| "transfer"
	| "recall"
	| "skill"
	| "browser"
	| "knowledge"
	| "generic";

/** Tool-call status (subset of the live statuses that affect the height model). */
export type ToolCallStatus =
	| "pending"
	| "initializing"
	| "running"
	| "success"
	| "fail"
	| "cancelled";

// ─────────────────────────────────────────────────────────────────────────────
// Chrome constants (px) — CONTRACT §3/§4 + ToolCallCard.tsx / .module.css.
// ─────────────────────────────────────────────────────────────────────────────

/** Paper / Box `p="xs"` inner padding (10px each side). */
export const CARD_PADDING = SPACING.xs; // 10
/** Paper `withBorder` edge (1px each side; standalone cards only). */
export const CARD_BORDER = 1;
/** In-run `<Divider size={1}>` under a non-last card. */
export const CARD_DIVIDER = 1;

/**
 * Header category-icon lane (`.headerCategoryIcon { width/height }`).
 *
 * Deliberately `BARE_ROW_ICON` — the SAME 14px tile a folded trace row uses. The header
 * was 16px, so drilling in or out resized the chip mid-morph; the two forms are one line
 * in two states, and the row's size won because it is the one that appears in a dense
 * column where the tile competes with its neighbours.
 *
 * Height-neutral: `HEADER_ROW_HEIGHT` is `max(icon, text line 19)`, and the text line
 * dominates at both 14 and 16 — so no measured height changes (asserted in
 * `measure-tool-call.test.ts`).
 */
export const HEADER_CATEGORY_ICON = BARE_ROW_ICON;

/**
 * Gap between the header's cells, notably between the BOLD tool name and the summary.
 *
 * Deliberately `BARE_ROW_GAP` — the SAME gap a folded trace row uses between its cells.
 *
 * ⚠️ This is load-bearing for the morph, and NOT merely cosmetic. The whole line is moved
 * by ONE `translate`, so every cell in it must need the SAME displacement. That holds only
 * when the two forms agree on the total width of everything preceding the text:
 *
 *     row:  chevron 12 + gap 6 + icon 14 + gap 6   → text at 38
 *     card: border 1 + padding 10 + icon + gap     → text at 11 + icon + gap
 *
 * With `icon + gap` equal on both sides (14 + 6 = 20), the icon and the text both need
 * 7px and one translate serves both. It used to be 16 + 4 = 20 — the same total by
 * coincidence, which is why the text did not jump even though neither number matched the
 * row. Unifying the ICON alone broke that accident (14 + 4 = 18): the text then needed 9px
 * while the icon needed 7, and a single translate could not satisfy both, so the text
 * jumped 2px mid-morph. Changing one of these two constants without the other reintroduces
 * exactly that.
 *
 * Width-only: never part of any height computation.
 */
export const HEADER_CELL_GAP = BARE_ROW_GAP;

/**
 * Glyph size INSIDE a category chip, shared by the card header and a folded trace row.
 *
 * Both tiles are now the same 14px lane ({@link HEADER_CATEGORY_ICON}); a different inner
 * glyph would still resize the icon across the morph, which is what unifying the tile was
 * meant to stop. Render-only — the glyph sits inside the tile and cannot affect height.
 */
export const CARD_HEADER_INNER_ICON = 9;
/**
 * Header text line box. `.headerText` uses `line-height: var(--mantine-line-
 * height)` (the BASE 1.55, NOT xs 1.4), at font-size xs (12): 12×1.55 = 18.6 → 19.
 */
export const HEADER_TEXT_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, BASE_LINE_HEIGHT); // 19
/** Header row height: the taller of the icon lane (16) vs the text line (19). */
export const HEADER_ROW_HEIGHT = Math.max(HEADER_CATEGORY_ICON, HEADER_TEXT_LINE_HEIGHT); // 19

/** Detail wrapper `<Box mt="xs">` — the gap between the header and the detail. */
export const DETAIL_TOP_MARGIN = SPACING.xs; // 10
/**
 * Font size of a capped detail body. Exported so RenderToolCall's box declares
 * the same number instead of repeating the literal.
 */
export const DETAIL_BODY_FONT_SIZE = 11;
/**
 * Capped-detail content line box (ContentViewer / code / terminal preview at
 * font-size 11): 11×1.4 = 15.4 → 15.
 *
 * The render layer MUST declare this integer as its `lineHeight` (in px) rather
 * than the 1.4 ratio. A ratio yields 15.4px per line in the browser, so each
 * wrapped line drifts 0.4px from the box this constant reserved and a 15-line
 * body overflows by 6px — clipped silently, because the box is height-fixed.
 */
export const DETAIL_CONTENT_LINE_HEIGHT = lineBoxHeight(DETAIL_BODY_FONT_SIZE, LINE_HEIGHT.xs);
/** detailContentLineHeight() at the reader's typography (baseline above). */
export function detailContentLineHeight(): number {
	return scaledLineBoxHeight(DETAIL_BODY_FONT_SIZE, LINE_HEIGHT.xs);
} // 15
/**
 * Scaled font for detail bodies, and the partner of `detailContentLineHeight()`.
 *
 * These two must move together. Wrapping at the frozen `DETAIL_BODY_FONT` while
 * multiplying by the scaled line box produced a height computed from one font and a
 * wrap computed from another: at 150% the reserved box was ~50% taller per line but
 * the text still wrapped as 11px, so a long body ended up short of its box — and at a
 * shrunken scale it overflowed a height-fixed box and was clipped.
 */
export function detailBodyFont(): string {
	return scaledFont(FONT_WEIGHT.regular, DETAIL_BODY_FONT_SIZE, MONO_FAMILY);
}
/** Scaled detail body font size (px), for the render layer's `fontSize`. */
export function detailBodyFontSize(): number {
	return scaleFontSize(DETAIL_BODY_FONT_SIZE);
}
/** Detail section label ("Input"/"Output", Text size="xs") line box: 12×1.4 = 17. */
export const DETAIL_LABEL_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17
/** Detail section label `mb={2}`. */
export const DETAIL_LABEL_MARGIN_BOTTOM = 2;
/**
 * Total vertical space one label row takes off a block (`cappedBodyHeight`'s
 * `labelH`). Exported because the render layer has to subtract the SAME amount
 * to size the body inside the block — it used to hardcode 19 in two places,
 * which would silently clip (or under-fill) the body the day either part of the
 * label chrome moved.
 */
export const DETAIL_LABEL_CHROME_Y = DETAIL_LABEL_LINE_HEIGHT + DETAIL_LABEL_MARGIN_BOTTOM; // 19
/** Generic detail: `mt="xs"` gap before the output section. */
export const GENERIC_SECTION_GAP = SPACING.xs; // 10

// ── Capped-detail scroll box chrome (RenderToolCall DetailRegion) ─────────────
/**
 * The capped scroll box is `boxSizing: "border-box"` with `padding: "2px 6px"`
 * (RenderToolCall.tsx DetailRegion). Both axes matter for an exact sub-cap
 * height: text wraps at `width - 12`, and the content height gains 4px.
 */
export const DETAIL_BOX_PADDING_X = 6;
export const DETAIL_BOX_PADDING_Y = 2;
/** Horizontal chrome subtracted from the available width before wrapping. */
export const DETAIL_BOX_CHROME_X = DETAIL_BOX_PADDING_X * 2; // 12
/** Vertical chrome added to the wrapped content height. */
export const DETAIL_BOX_CHROME_Y = DETAIL_BOX_PADDING_Y * 2; // 4

/** Capped bodies render at 11px monospace (matches the render layer's box). */
export const DETAIL_BODY_FONT = `${FONT_WEIGHT.regular} ${DETAIL_BODY_FONT_SIZE}px ${MONO_FAMILY}`;

/**
 * Hard ceiling (chars) on how much capped body text is handed to pretext.
 *
 * Capped bodies can be huge (a 120KB tool output is a real observed value) while
 * the cap only ever reveals a few dozen lines, so measuring the whole string is
 * both wasted work and a violation of the "no unbounded work on the main
 * thread" rule. `cappedBodyHeight` slices a bounded prefix that is guaranteed to
 * exceed the cap whenever the full text would, so every sub-cap result stays
 * exact (see measureCappedContentHeight).
 */
export const DETAIL_MEASURE_PREFIX_MAX_CHARS = 8 * 1024;

/**
 * Hard ceiling (chars) on how much markdown body text is PARSED for a capped
 * detail (ExitPlanMode plans, skill/knowledge bodies).
 *
 * Markdown parsing is the expensive step (~180ms for a 16KB document — the same
 * price the assistant-markdown path already pays), and the schema allows a 1MB
 * plan file, which must never reach the synchronous layout path in full. This is
 * the ONE place body content is legitimately dropped, so `markdownMeasurePrefix`
 * cuts on a block boundary and the measurement reports `isPrefix`.
 *
 * NOT TO BE CONFUSED WITH THE CAP: the cap fixes the scroll box's OUTER height,
 * but the box is `overflow: auto` and the reader scrolls the rest. "Already past
 * the cap" is therefore not a reason to stop parsing — a previous escalating
 * budget did exactly that and a 15.7K-char plan lost everything after char 8154
 * (see measureMarkdownDetail).
 *
 * Sized so every observed real plan (~18K chars) is parsed whole. Mirrored by
 * `TOOL_IO_BUDGETS.markdownLeaf`, the payload budget that has to deliver the text
 * this ceiling is willing to read.
 */
export const DETAIL_MARKDOWN_PREFIX_MAX_CHARS = 32 * 1024;

/** Gap between the `_planFile` provenance line and the markdown body. */
export const DETAIL_SOURCE_LINE_MARGIN_BOTTOM = 4;

/** Shared xs text line box (measured detail bodies): 12×1.4 = 17. */
export const XS_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17

/** SpecTasks: List `size="xs"` icon (ThemeIcon 16) + its label offset. */
export const SPEC_TASK_ICON = 16;
/** SpecTasks label indent (icon lane + List center gap). */
export const SPEC_TASK_INDENT = SPEC_TASK_ICON + 8; // 24
/** SpecTasks `List spacing={4}` between items. */
export const SPEC_TASK_GAP = 4;
/** Protected-commitment lock glyph (`<IconLock size={11}>`). */
export const SPEC_TASK_LOCK = 11;
/** Gap between the status glyph and the lock (`Group gap={4}`). */
export const SPEC_TASK_LOCK_GAP = 4;
/**
 * Extra indent a PROTECTED task reserves for its lock glyph.
 *
 * The lock is drawn in the same leading lane as the status icon, so without this
 * reserve the 11px glyph (plus its 4px gap) spills past `SPEC_TASK_INDENT` and
 * paints on top of the first characters of the task text — the chunked card
 * avoids that by keeping the lock INSIDE the label row, where it pushes the text.
 * Reserving the lane here reproduces that offset on the zero-DOM path: the text
 * wraps at the narrower width AND starts after the glyph.
 */
export const SPEC_TASK_LOCK_LANE = SPEC_TASK_LOCK + SPEC_TASK_LOCK_GAP; // 15
/** Empty task doc placeholder (`Paper withBorder px="sm" py={6}`) padding. */
export const SPEC_TASK_EMPTY_PADDING_Y = 6;
/** Empty task doc placeholder height: padding + border + one xs row. */
export const SPEC_TASK_EMPTY_HEIGHT =
	SPEC_TASK_EMPTY_PADDING_Y * 2 + CARD_BORDER * 2 + typographyMetrics().line.xs; // 31

/** Structured (recall/send/pipeline/web-search) badge header row (Badge xs). */
export const STRUCT_BADGE_ROW = 16;
/** Structured body line box (xs text). */
export const STRUCT_BODY_LINE_HEIGHT = XS_LINE_HEIGHT; // 17
/** Structured: gap between the badge header and the first body line. */
export const STRUCT_BADGE_GAP = 4;

/** Error detail: leading icon(16) + wrapped error text. */
export const ERROR_ICON = 16;
export const ERROR_INDENT = ERROR_ICON + 6; // 22

// ── Section / meta-row / entry chrome ────────────────────────────────────────
/** Section label row (`<Text size="xs" fw={500}>`): 12×1.4 = 17. */
export const SECTION_LABEL_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17
/** Section label `mb={2}`. */
export const SECTION_LABEL_MARGIN_BOTTOM = 2;
/** Gap between two sections of one detail. */
export const SECTION_GAP = SPACING.xs; // 10
/** Gap between meta rows / entries within one region. */
export const META_ROW_GAP = 4;
/** Reserved badge row inside a meta row / entry (Badge size=xs = 16). */
export const META_BADGE_ROW = 16;
/** Reserved action-button row (Button size=xs = 30). */
export const META_ACTION_ROW = 30;
/**
 * Reserved progress-bar row: the `Progress` track (size="sm" = 8) plus the
 * percent label beside it, which is the taller of the two.
 *
 * A FIXED reservation on purpose. The alternative — sizing to the current
 * numbers — would re-measure the card on every progress frame and walk the whole
 * conversation below it up and down while the user is trying to read it.
 */
export const META_PROGRESS_ROW = 18;
/** Reserved figures line under a progress bar (xs text). */
export const META_PROGRESS_FIGURES_ROW = 16;
/** Max meta rows measured/painted in one region (bounded work). */
export const META_ROWS_MAX = 12;
/** Max structured entries measured/painted (mirrors the classifier's slice). */
export const ENTRY_MAX = 10;
/** Entry snippet clamp (`lineClamp`) — a fixed ceiling keeps entries bounded. */
export const ENTRY_SNIPPET_MAX_LINES = 3;

// ── Ask replay ceilings (mirror ASK_QUESTIONS_MAX / ASK_OPTIONS_MAX) ─────────
/**
 * Second line of defence on the ask replay's size. The classifier already
 * truncates, but re-truncating here means a hand-built detail (harness, test,
 * future producer) can never reach the layout path unbounded.
 */

// ── Grouped-card chrome ──────────────────────────────────────────────────────
/** Group header text line box (Mantine `<Text size="xs">` → xs 1.4 = 17). */
export const GROUP_HEADER_TEXT_LINE = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17
/** Group header ThemeIcon size={16}. */
export const GROUP_HEADER_ICON = 16;
/** Group header row: max(icon 16, badge 16, xs text 17, chevron 12) = 17. */
export const GROUP_HEADER_ROW = Math.max(GROUP_HEADER_ICON, GROUP_HEADER_TEXT_LINE); // 17
/** Group body `<Box mt={4}>`. */
export const GROUP_BODY_MARGIN_TOP = 4;
/** Group body `pl={4}`. */
export const GROUP_BODY_PADDING_LEFT = 4;
/** Group body `borderLeft: 2px`. */
export const GROUP_BODY_BORDER_LEFT = 2;

// ── Detail maxHeight caps (px) — ToolCallCard codeStyle/termStyle + per-detail ─
/** Central cap table (px). `plan` is a fallback — the live card uses vpHeight. */
export const DETAIL_CAPS: Record<DetailCapKind, number> = {
	code: 200,
	term: 200,
	diff: 200,
	"bash-cmd": 60,
	media: 400,
	skill: 400,
	knowledge: 400,
	plan: 400,
	"agent-result": 300,
	"streaming-bash": 120,
	streaming: 400,
};

// ─────────────────────────────────────────────────────────────────────────────
// Prebuilt fonts.
// ─────────────────────────────────────────────────────────────────────────────
/** SpecTasks / structured / error body text (xs sans, weight 400). */
export const DETAIL_TEXT_FONT = `${FONT_WEIGHT.regular} ${FONT_SIZE.xs}px ${SANS_FAMILY}`;
/** Structured monospace body (recall paths etc.). */
export const DETAIL_MONO_FONT = `${FONT_WEIGHT.regular} ${FONT_SIZE.xs}px ${MONO_FAMILY}`;

// ─────────────────────────────────────────────────────────────────────────────
// Detail data (discriminated union). The dispatch layer summarizes a live tool
// call into ONE of these — passing wrap-critical text for the pretext-measured
// kinds and a line/pixel estimate for the capped kinds.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Content height for a media cap. With the image's intrinsic dimensions the
 * reserved height is the aspect-ratio fit into (availableWidth × cap) — pure
 * arithmetic on persisted data, and the render layer's contain-fit lands on
 * the same box. Without dimensions the classifier's fixed estimate stands.
 *
 * ⚠️ The `fit` is returned ALONGSIDE the height, not discarded, because the
 * render layer needs BOTH numbers. Reserving only the fitted height and letting
 * the paint fall back to its legacy `width: 100%` box breaks §0 铁律 2 whenever
 * the CAP is the binding constraint: a tall screenshot's fit narrows
 * `displayWidth` to keep the ratio, but a full-width box paints
 * `boxWidth × h/w` — far taller than the reserved 400px, so the image is
 * clipped by the box's `overflow: hidden`. Both dimensions must travel to the
 * `<img>` so measurement and paint describe the same rectangle.
 */
function mediaContentPx(
	media: ToolMediaRef | undefined,
	fallbackPx: number | undefined,
	availableWidth: number,
	cap: number,
): { contentPx: number | undefined; fit: FittedImageBox | null } {
	const natural = media ? readImageIntrinsicSize(media.width, media.height) : null;
	if (!natural) return { contentPx: fallbackPx, fit: null };
	const fit = fitImageBox(natural, availableWidth, cap);
	return { contentPx: fit.displayHeight, fit };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-call data (the measure input) + options.
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolCallData {
	/** Tool name (renderer header; height-neutral). */
	toolName: string;
	/** Header summary line (truncated → height-neutral). */
	summary: string;
	/** Category (icon/colour + selects the default auto-open behaviour). */
	category: ToolCategory;
	/** Tool status (drives lodExempt + default open). */
	status: ToolCallStatus;
	/** True while the tool input is still streaming (lodExempt, no fold). */
	isStreaming?: boolean;
	/**
	 * Added / removed line counts for a settled Write/Edit (`+12 -3`).
	 *
	 * HEIGHT-NEUTRAL: one nowrap span inside the already-fixed header row, exactly
	 * like the status glyph and the duration it sits next to. Keyed in
	 * `extractDataRevision` all the same, because it is PAINTED from the cached
	 * payload and can appear while nothing height-bearing moves (a fetched payload
	 * resolving a truncated Edit, or metadata landing on a live patch).
	 */
	diffStats?: { added: number; removed: number };
	/** Remote execution → header badge (same row → height-neutral). */
	isRemoteTarget?: boolean;
	/**
	 * The subagent this call waits on is TAKEN OVER by the user → header badge
	 * (same row → height-neutral). Matters for an in-flight `Await({type:"agent"})`,
	 * which never returns while the takeover lasts; without the badge the card only
	 * shows a ticking timer.
	 *
	 * Keyed in `extractDataRevision` despite being height-neutral: the takeover
	 * patch writes this field ALONE, so nothing else in the cache key moves and a
	 * stale entry would keep painting the pre-takeover header.
	 */
	isTakenOver?: boolean;
	/**
	 * Header timing passthrough (all HEIGHT-NEUTRAL — they render inside the one
	 * fixed header row). The chunked header shows an elapsed timer while running,
	 * the final duration afterwards, and a `/ timeout` suffix; none of that existed
	 * in the vlist card.
	 */
	durationMs?: number | null;
	/** Pure execution time (bash `_metadata.execDurationMs`), preferred when set. */
	execDurationMs?: number | null;
	/** Start epoch (ms) for the live elapsed timer. */
	startedAt?: number | null;
	/** Effective timeout (ms) shown after the duration. */
	timeoutMs?: number | null;
	/**
	 * Lifecycle stamps (epoch ms) behind the header's timing POPOVER. Strictly
	 * height-neutral: the popover is portaled, so none of these can move the card.
	 * Mirrors ToolCallCard's ToolTimingPopoverLabel inputs — without them the vlist
	 * header had a duration but no breakdown of where the time went.
	 */
	streamStartedAt?: number | null;
	permissionStartedAt?: number | null;
	executionStartedAt?: number | null;
	completedAt?: number | null;
	createdAt?: number | null;
	/** Tool error text (render-only; the classifier already folds it into detail). */
	errorMessage?: string | null;
	/** Tool use id — lets the integration layer bind terminate / fetch actions. */
	toolUseId?: string;
	/**
	 * How many payload fields are still a preview, and their combined original size.
	 *
	 * A COUNT rather than a boolean: field-level truncation can cut several fields of
	 * one call (an Edit's old_string AND new_string), and the notice reports both
	 * numbers. Height-AFFECTING: a non-zero count reserves the notice row.
	 */
	truncatedLeafCount?: number;
	truncatedTotalBytes?: number;
	/** Expanded-body detail summary; null/absent → no detail region. */
	detail?: ToolDetailData | null;
	/**
	 * Reflection notice to show INSTEAD of the permission form (danger / plan /
	 * task / question gates). Mirrors the chunked precedence
	 * (ToolCallCard.tsx:5419). Measured here — never mounted-then-measured — so a
	 * reflection row's height is final on its first paint.
	 */
	reflection?: ReflectionNoticeData | null;
	/** Rendered inside a run: no border, a trailing 1px divider unless last. */
	inRun?: boolean;
	/** In-run only: whether this is the last card (drops the divider). */
	isLast?: boolean;
}

/**
 * Lifecycle stamps + final duration for the header's timing popover.
 *
 * A single object rather than five loose fields because three renderers consume
 * the identical shape (tool card header, subagent card header, subagent
 * recent-call rows) and the adapter produces it for all of them. Every member is
 * HEIGHT-NEUTRAL — the popover is portaled.
 */
export interface ToolTimingStamps {
	startedAt: number | null;
	streamStartedAt: number | null;
	permissionStartedAt: number | null;
	executionStartedAt: number | null;
	completedAt: number | null;
	createdAt: number | null;
	/** Resolved final duration (explicit, else derived) — the popover's total. */
	durationMs: number | null;
}

/** Read a finite number off a loosely-typed record, else null. */
function stampOf(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Collect the popover's stamps from a tool-call-ish record.
 *
 * Accepts a loose record so the subagent card (whose rows carry the same shape
 * under a different type) can reuse it without a cast at every call site.
 */
export function resolveToolTimingStamps(source: {
	startedAt?: number | null;
	streamStartedAt?: number | null;
	permissionStartedAt?: number | null;
	executionStartedAt?: number | null;
	completedAt?: number | null;
	createdAt?: number | null;
	durationMs?: number | null;
}): ToolTimingStamps {
	return {
		startedAt: stampOf(source.startedAt),
		streamStartedAt: stampOf(source.streamStartedAt),
		permissionStartedAt: stampOf(source.permissionStartedAt),
		executionStartedAt: stampOf(source.executionStartedAt),
		completedAt: stampOf(source.completedAt),
		createdAt: stampOf(source.createdAt),
		durationMs: stampOf(source.durationMs),
	};
}

/**
 * Earliest known start for a tool call — parity with ToolCallCard's
 * `getEarliestToolStartMs` (:1177), which the grouped header uses to label its
 * aggregate timer. Null when the call carries no stamp at all.
 */
export function earliestToolStartMs(timing: ToolTimingStamps): number | null {
	const candidates = [
		timing.startedAt,
		timing.createdAt,
		timing.streamStartedAt,
		timing.permissionStartedAt,
		timing.executionStartedAt,
	].filter((value): value is number => value != null);
	return candidates.length > 0 ? Math.min(...candidates) : null;
}

export interface MeasureToolCallOpts {
	/** Viewport height (px) — plan cards cap their detail at 0.85 × this. */
	viewportHeight?: number;
	/** L5: recent cards follow `opened`; older ones collapse. Default true. */
	isRecent?: boolean;
	/** User/derived expand preference. Defaults to computeDefaultOpen(data). */
	opened?: boolean;
	/** Explicit click override for levels that otherwise force a collapsed header. */
	lodUserOverride?: boolean;
	/** Pending permission payload → the card is lodExempt + shows the perm UI. */
	pendingPermission?: InlinePermissionData | null;
	/**
	 * True when the card has a live pending permission request (injected by the
	 * shell). Forces the card expanded so the permission form area is visible; the
	 * form is mounted by the integration layer and measured after paint, so no
	 * permission height is baked in here.
	 */
	hasPendingPermission?: boolean;
	/**
	 * True when the card is the pinned latest spec://tasks.json call (injected by
	 * the adapter from the shell's resolver). Forces the card expanded at every
	 * LOD — the task board is the narrator's live working state, which a reader at
	 * a low LOD still wants on screen. The boolean folds into the measure cache
	 * key via digestOpts, so the two geometries never share an entry.
	 */
	forceExpanded?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Measured result.
// ─────────────────────────────────────────────────────────────────────────────

/** Geometry belongs to the body itself, with local zero-based coordinates. */
export interface MeasuredToolBody<T extends ToolSectionBody = ToolSectionBody> {
	model: T;
	kind: T["kind"];
	height: number;
	blocks: PreparedBlock[];
	frame: ElementFrame;
	contentWidth: number;
	appliedCap: number | null;
	markdown?: boolean;
	sourceText?: string;
	bodyIsPrefix?: boolean;
	textTruncated?: boolean;
}

export interface MeasuredToolDetailSection {
	key: string;
	label?: ToolSectionLabel;
	top: number;
	height: number;
	bodyTop: number;
	bodyHeight: number;
	measuredBody: MeasuredToolBody;
}

export interface MeasuredToolDetail {
	kind: "sections";
	/** Includes the single leading detail margin. */
	height: number;
	contentWidth: number;
	sections: MeasuredToolDetailSection[];
}

export interface MeasuredToolCall extends MeasuredElement {
	/** Resolved expand decision (the height/shape main switch). */
	effectiveOpened: boolean;
	/** True when running/streaming/pendingPermission (always expanded). */
	lodExempt: boolean;
	/** Mirrors data.isStreaming. */
	isStreaming: boolean;
	/** Rendered inside a run (no border + divider). */
	inRun: boolean;
	/** In-run last-row flag (no divider). */
	isLast: boolean;
	/** Whether the card draws a border (standalone only). */
	hasBorder: boolean;
	/** Fixed vertical chrome (padding×2 + border×2). */
	chromeY: number;
	/** Header row height (px). */
	headerHeight: number;
	/** Header top offset within the card content box (== 0). */
	headerTop: number;
	/** Collapsed whole-card height (header + chrome + divider). */
	collapsedHeight: number;
	/** Measured detail region (present when expanded + detail exists), else null. */
	detail: MeasuredToolDetail | null;
	/** Detail region top within the card content box (== headerHeight). */
	detailTop: number;
	/** Measured InlinePermission (present when pendingPermission), else null. */
	permission: MeasuredInlinePermission | null;
	/** Permission region top within the card content box. */
	permissionTop: number;
	/**
	 * Measured reflection notice (present when a gate is running/resolved), else
	 * null. Takes the permission area's place, exactly like the chunked card.
	 */
	reflection: MeasuredReflectionNotice | null;
	/** Reflection region top within the card content box. */
	reflectionTop: number;
	/** Passthrough render metadata. */
	category: ToolCategory;
	status: ToolCallStatus;
	toolName: string;
	summary: string;
	/**
	 * Added / removed line counts for a Write/Edit (`+12 -3`), else null.
	 *
	 * Null means UNKNOWN and draws nothing. `{ added: 0, removed: 0 }` is a real
	 * measurement (the call changed no lines) and also draws nothing — the two look
	 * alike on screen but must not be conflated upstream.
	 */
	diffStats: { added: number; removed: number } | null;
	isRemoteTarget: boolean;
	/** See `ToolCallData.isTakenOver` — a header badge, painted from this payload. */
	isTakenOver: boolean;
	/**
	 * Header timing passthrough — measured never reads these for layout (they live
	 * in the fixed 19px header row), the renderer just paints them.
	 */
	displayDurationMs: number | null;
	startedAt: number | null;
	timeoutMs: number | null;
	/** Lifecycle stamps for the header's timing popover (portaled → no geometry). */
	timing: ToolTimingStamps;
	errorMessage: string | null;
	toolUseId: string | null;
	/**
	 * Number of payload fields still showing a preview (0 = nothing truncated), and
	 * their combined original size.
	 *
	 * PAYLOAD COMPLETENESS SIGNAL, not geometry: nothing is reserved for it. The
	 * shell reads the count to decide which rows may fetch the full payload and
	 * which requests are still in flight, and the measure cache keys on it (`|tp:`)
	 * because it is the only field that moves when a fetched payload lands.
	 */
	truncatedLeafCount: number;
	truncatedTotalBytes: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers.
// ─────────────────────────────────────────────────────────────────────────────

/** Fixed blocks never consult the resolver; measured detail uses pretext. */
const RESOLVER: LineMetricsResolver = pretextLineMetrics;

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

function makeFixed(
	height: number,
	tag: string,
	marginTop: number,
	data?: Record<string, unknown>,
): PreparedFixedBlock {
	return {
		...baseBlockFields(),
		kind: "fixed",
		height,
		tag,
		marginTop,
		...(data ? { data } : {}),
	};
}

function makeInline(
	text: string,
	font: string,
	lineHeight: number,
	contentLeft: number,
	marginTop: number,
	className: string,
	data?: Record<string, unknown>,
): PreparedInlineBlock {
	const items: RichInlineItem[] = [{ text, font, break: "normal", extraWidth: 0 }];
	return {
		...baseBlockFields(),
		kind: "inline",
		flow: prepareRichInline(items),
		lineHeight,
		classNames: [className],
		hrefs: [null],
		fonts: [font],
		contentLeft,
		marginTop,
		...(data ? { data } : {}),
	};
}

/** True when the tool is in-progress (running/pending/initializing). */
export function isRunningStatus(status: ToolCallStatus): boolean {
	return status === "running" || status === "pending" || status === "initializing";
}

/**
 * Derive the default expand state (mirrors ToolCallCard defaultOpen :5483). Used
 * only when `opts.opened` is undefined. Truncation nuances are omitted — this is
 * a best-effort default the caller can override.
 *
 * `pendingPermission` here is the merged force-expand flag: a live permission OR
 * the pinned latest-tasks card (`opts.forceExpanded`) both arrive through it.
 */
export function computeDefaultOpen(data: ToolCallData, pendingPermission: boolean): boolean {
	if (pendingPermission) return true;
	if (data.status === "pending") return true;
	if (data.isStreaming) return data.category === "file";
	const autoOpen: ToolCategory[] = [
		"tasks",
		"share",
		// A transfer's whole point is the live bar; a collapsed card would hide the
		// one thing that changes while it runs.
		"transfer",
		"recall",
		"send",
		"pipeline",
		"plan",
		"knowledge",
		"file",
	];
	if (autoOpen.includes(data.category)) return true;
	if ((data.category === "await" || data.category === "bash") && data.detail != null) return true;
	if (data.status === "fail") return true;
	return false;
}

/**
 * Resolve the effective expand state (mirrors ToolCallCard effectiveOpened :5594).
 * Pure function — the height/shape main switch, deterministic per input.
 */
export function resolveToolCallOpened(
	lod: RenderLod,
	opts: {
		lodExempt: boolean;
		isRecent: boolean;
		opened: boolean;
		lodUserOverride?: boolean;
		userCollapsed?: boolean;
	},
): boolean {
	if (opts.lodExempt || opts.lodUserOverride) return true;
	// L5 is the most detailed level, so an UNTOUCHED card is expanded — but the
	// reader may still fold one, and `userCollapsed` is the only input that can say
	// so. Returning a bare `true` here made the header chevron dead at L5: the
	// shell's toggle writes `!effectiveOpened` into the `expanded` map, so the click
	// stored `false` into a channel this branch never read, and the card kept its
	// height with no feedback. Worst on a card that badly needs folding — a denied
	// ExitPlanMode measures ~1200px (a 0.85×viewport plan body plus its reflection
	// notice), i.e. more than a screen the reader could not put away.
	//
	// Only an EXPLICIT fold counts, so the default shape of every other L5 card is
	// unchanged (see the `userCollapsed` field doc).
	if (lod >= 5) return !opts.userCollapsed;
	if (lod === 4) return opts.isRecent ? opts.opened : false;
	if (lod === 3) return false;
	// L1/L2: the upstream tool-run gate owns these levels; a card shown here is
	// treated as collapsed (its content lives in the folded trace instead).
	return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail region measurement.
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve the cap for a capped detail (plan uses 0.85 × viewport height). */
export function resolveDetailCap(cap: DetailCapKind, viewportHeight?: number): number {
	if (cap === "plan" && viewportHeight && viewportHeight > 0) {
		return Math.round(viewportHeight * 0.85);
	}
	return DETAIL_CAPS[cap];
}

/**
 * Number of body lines a cap can actually reveal, +1 so a measurement can prove
 * "this overflows" without measuring any further.
 */
export function cappedUsefulLines(cap: number): number {
	return Math.ceil(cap / detailContentLineHeight()) + 1;
}

/**
 * Slice the shortest prefix of `text` that is guaranteed to wrap to at least
 * `maxUsefulLines` lines whenever the full text would.
 *
 * Rationale: the rendered box is `pre-wrap`, so every hard newline starts a new
 * line and each line needs at least one character. Taking `maxUsefulLines`
 * newline-delimited segments, or `maxUsefulLines × wrapWidth` characters
 * (1px-per-char is a floor for any real glyph at 11px), can only ever
 * over-estimate how much text is needed. Hard-capped by
 * DETAIL_MEASURE_PREFIX_MAX_CHARS.
 */
export function cappedMeasurePrefix(
	text: string,
	maxUsefulLines: number,
	wrapWidth: number,
): string {
	// Character budget: even a 1px-wide glyph needs `wrapWidth` chars to fill a
	// line, so this many characters must produce >= maxUsefulLines lines.
	const charBudget = Math.min(
		DETAIL_MEASURE_PREFIX_MAX_CHARS,
		Math.max(1, Math.ceil(wrapWidth)) * maxUsefulLines,
	);
	if (text.length <= charBudget) return text;

	// Prefer cutting after the Nth hard newline when one occurs early: those
	// segments alone already exceed the visible-line budget.
	let index = -1;
	for (let i = 0; i < maxUsefulLines; i++) {
		const next = text.indexOf("\n", index + 1);
		if (next === -1) {
			index = -1;
			break;
		}
		index = next;
	}
	if (index !== -1 && index + 1 <= charBudget) return text.slice(0, index + 1);
	return text.slice(0, charBudget);
}

/**
 * Character width of a diff's gutter: `oldNo + ' ' + newNo + marker`, i.e.
 * `2 × lineNoWidth + 2`. Zero when the diff carries no line numbers (the render
 * layer then draws just the marker column, which is folded in as 1 char).
 *
 * Exported-adjacent helper shared by measure and render so both agree on exactly
 * how much horizontal room the gutter takes.
 */
export function diffGutterWidthChars(document: DiffDocument | undefined): number {
	if (!document) return 0;
	return diffDocumentLineNoWidth(document) * 2 + 2;
}

/** Outer-card probing reads only enough rows to prove its cap. No viewport projection. */
function measureDiffDocumentHeight(
	document: DiffDocument,
	cap: number,
	availableWidth: number,
	textTruncated?: boolean,
): number {
	const maxRows = cappedUsefulLines(cap);
	if (textTruncated || document.totalRows >= maxRows) return cap;
	const rows: { content: string }[] = [];
	for (let row = 0; row < document.totalRows; row++) {
		rows.push({ content: readDiffRowContent(document, row) ?? "" });
	}
	return measureDiffContentHeight(rows, diffGutterWidthChars(document), cap, availableWidth);
}

/**
 * Wrapped content height (px) of a structured DIFF body.
 *
 * A diff cannot be measured as one blob of text: each row is its own `pre-wrap`
 * line, and the fixed line-number gutter steals horizontal room from EVERY row,
 * so the code column wraps earlier than a plain body of the same text would.
 * Measuring the joined text at the full width would under-count lines and clip
 * the box.
 *
 * The gutter is `oldNo + ' ' + newNo + marker` characters wide — monospace, so
 * its pixel width is that character count × the advance of one glyph. Rows are
 * measured until the cap is provably exceeded, keeping the cost O(cap) for a
 * 500-row diff.
 */
export function measureDiffContentHeight(
	lines: readonly { content: string }[],
	gutterChars: number,
	cap: number,
	availableWidth: number,
): number {
	const boxWidth = Math.max(1, availableWidth - DETAIL_BOX_CHROME_X);
	// One monospace advance at the body font, measured through pretext (zero DOM).
	const gutterWidth = gutterChars > 0 ? monoAdvance(detailBodyFont(), gutterChars) : 0;
	const wrapWidth = Math.max(1, boxWidth - gutterWidth);
	const maxUsefulLines = cappedUsefulLines(cap);
	// Explicit row bound, so the cost is visibly O(cap) rather than relying on the
	// early return below to happen to fire.
	//
	// The coupling this makes visible: rows are only ever measured until the cap is
	// provably exceeded, so the work scales with `cap`, NOT with the diff's length —
	// at cap=200 that is ~15 rows out of a 500-row diff. A LARGER cap (plan's 400,
	// or a viewport-derived one) therefore raises the row budget proportionally.
	// Each row costs one `prepareWithSegments` + one `measureLineStats`, so a cap
	// tied to a tall viewport is a real cost increase, not a constant.
	//
	// A single row can also wrap to several lines, so this ceiling alone does not
	// bound the LINE count — the early return still does that.
	const maxRows = Math.min(lines.length, maxUsefulLines);

	let totalLines = 0;
	for (let i = 0; i < maxRows; i++) {
		const line = lines[i];
		if (!line) continue;
		if (line.content.length === 0) {
			totalLines += 1;
		} else {
			const prepared = prepareWithSegments(line.content, detailBodyFont(), {
				whiteSpace: "pre-wrap",
				letterSpacing: letterSpacingPxFor(detailBodyFontSize()),
			});
			totalLines += Math.max(1, measureLineStats(prepared, wrapWidth).lineCount);
		}
		// Overflowing already: the exact count no longer changes the height.
		if (totalLines >= maxUsefulLines) return cap;
	}
	// Every row that could matter has been measured: either the loop consumed the
	// whole diff, or it stopped at `maxUsefulLines` rows, which each contribute at
	// least one line — so the total already reached the cap and returned above.
	return Math.min(totalLines * detailContentLineHeight() + DETAIL_BOX_CHROME_Y, cap);
}

/**
 * Width (px) of `count` monospace characters at `font`. Diff gutters are drawn in
 * the same monospace face as the body, so one measured advance scales exactly.
 */
/**
 * Wrap width used when a measurement must NOT wrap. Large enough that no real
 * gutter run reaches it (a 1e6px line is ~150k monospace glyphs at 11px), small
 * enough to stay exactly representable through any arithmetic pretext does with
 * it. `Number.MAX_SAFE_INTEGER` would be the obvious choice and is the wrong one:
 * a single addition or multiplication inside the wrap math overflows it to
 * `Infinity` or loses integer precision, so the "no wrapping" intent would rest on
 * pretext never touching the value.
 */
const NO_WRAP_WIDTH = 1e6;

function monoAdvance(font: string, count: number): number {
	// Digits only, so there is no break opportunity: the run stays on one line and
	// its measured width IS the advance of `count` monospace glyphs.
	const prepared = prepareWithSegments("0".repeat(Math.max(1, count)), font, {
		whiteSpace: "pre-wrap",
		letterSpacing: letterSpacingPxFor(detailBodyFontSize()),
	});
	return measureLineStats(prepared, NO_WRAP_WIDTH).maxLineWidth;
}

/**
 * Wrapped content height (px) of a capped body, including the scroll box's
 * vertical padding. Early-returns `cap` as soon as the measured prefix proves
 * the content overflows, so huge bodies never pay for a full measurement.
 */
export function measureCappedContentHeight(text: string, cap: number, availableWidth: number) {
	const wrapWidth = Math.max(1, availableWidth - DETAIL_BOX_CHROME_X);
	const maxUsefulLines = cappedUsefulLines(cap);
	const prefix = cappedMeasurePrefix(text, maxUsefulLines, wrapWidth);
	const prepared = prepareWithSegments(prefix, detailBodyFont(), { whiteSpace: "pre-wrap" });
	const { lineCount } = measureLineStats(prepared, wrapWidth);
	const lines = Math.max(1, lineCount);
	// Overflowing the cap: the exact line count no longer matters.
	if (lines >= maxUsefulLines) return cap;
	return Math.min(lines * detailContentLineHeight() + DETAIL_BOX_CHROME_Y, cap);
}

/**
 * Slice a bounded markdown prefix, cutting on a BLOCK boundary (blank line) so a
 * fenced code block / table is never split mid-structure — a half-open fence
 * would make the parser reinterpret the rest of the document.
 */
export function markdownMeasurePrefix(
	text: string,
	budget: number = DETAIL_MARKDOWN_PREFIX_MAX_CHARS,
): string {
	if (text.length <= budget) return text;
	const window = text.slice(0, budget);
	const boundary = window.lastIndexOf("\n\n");
	// Only honour a boundary in the back half, otherwise a document with one huge
	// leading block would collapse to almost nothing.
	if (boundary > budget / 2) return window.slice(0, boundary);
	return window;
}

/**
 * Measure a capped detail body as MARKDOWN (ExitPlanMode plans).
 *
 * `blocks` and `frame` describe ONE merged list — an optional provenance line
 * followed by the markdown blocks — because the render layer indexes
 * `frame.blocks[i]` against `blocks[i]`. Prepending a block to measureMarkdown's
 * own frame would desynchronize those arrays (off-by-one positions, or an
 * undefined frame for the last block), so the frame is always re-accumulated
 * over the merged list here. `blocks.length === frame.blocks.length` holds.
 *
 * All geometry is local to the body: the first block starts at zero, and height
 * is min(box content + box padding, cap). Callers own their header/section gap
 * and must use this height and frame directly, without subtracting a top margin.
 */
export function measureMarkdownDetail(
	text: string,
	cap: number,
	availableWidth: number,
	sourcePath: string | undefined,
	/**
	 * `text` is only a server-side PREFIX of the real body → reserve the FULL cap,
	 * exactly like `cappedBodyHeight` does for a plain capped body.
	 *
	 * Without this the box was sized to whatever the projection budget happened to
	 * include, so the height depended on the server's cut (and a wider layout wrapped
	 * that prefix into fewer lines, shrinking the box while the remaining scrollable
	 * content had nowhere to go). The cap can never clip — the box scrolls.
	 */
	textTruncated?: boolean,
): {
	blocks: PreparedBlock[];
	frame: ElementFrame;
	contentWidth: number;
	height: number;
	/** The parsed body was cut at the ceiling — blocks cover only a prefix. */
	isPrefix: boolean;
} {
	const innerWidth = Math.max(1, availableWidth - DETAIL_BOX_CHROME_X);

	// Parse the whole body, bounded only by the hard ceiling.
	//
	// This must NOT stop at "boxContent >= cap". The cap fixes the box's OUTER
	// height, but the box is `overflow: auto` and scrolls internally, so everything
	// past the cap is content the reader reaches by scrolling. Breaking there left
	// the remainder unparsed — no blocks, nothing to scroll to — a real truncation
	// of the body on screen rather than a saved measurement (a 15.7K-char plan
	// stopped dead at char 8154, ~40% of the way in).
	//
	// Work stays bounded by `markdownMeasurePrefix`: a body over the ceiling is cut
	// on a block boundary, which is the one case where content is genuinely dropped
	// (`isPrefix` reports it so the render layer can say so). The cost is also
	// amortized by the prepared-block cache — re-measuring the same text at another
	// width is a hit — so the full parse is paid once per body, not once per layout.
	const prefix = markdownMeasurePrefix(text, DETAIL_MARKDOWN_PREFIX_MAX_CHARS);
	const built = buildMarkdownDetailFrame(prefix, innerWidth, sourcePath);
	const boxHeight = textTruncated === true ? cap : Math.min(built.boxContent, cap);
	const height = boxHeight;
	return {
		blocks: built.blocks,
		frame: built.frame,
		contentWidth: innerWidth,
		height,
		isPrefix: prefix.length < text.length,
	};
}

/** Parse + frame one markdown prefix; `boxContent` excludes the outer mt gap. */
function buildMarkdownDetailFrame(
	markdown: string,
	innerWidth: number,
	sourcePath: string | undefined,
): { blocks: PreparedBlock[]; frame: ElementFrame; boxContent: number } {
	const mdBlocks = preparedMarkdownBlocks(markdown);
	const blocks: PreparedBlock[] = [];
	if (sourcePath) {
		blocks.push(
			makeFixed(typographyMetrics().line.xs, "detail-plan-source", 0, {
				sourcePath,
			}),
		);
	}
	for (const [index, block] of mdBlocks.entries()) {
		// The first markdown block starts at zero unless a provenance line precedes it.
		//
		// This RE-WRAPS rather than assigning `block.marginTop` in place. The parsed
		// array is shared (see prepared-markdown-cache): the same markdown measured by
		// another element — or by this one at a different width — hands back the very
		// same block objects, so writing to one would silently re-margin every other
		// consumer of that text. A shallow copy is cheap (blocks are flat records; the
		// expensive `flow` / `prepared` payloads are referenced, not cloned) and keeps
		// the cached blocks pristine.
		blocks.push(
			index === 0
				? {
						...block,
						marginTop: sourcePath ? DETAIL_SOURCE_LINE_MARGIN_BOTTOM : 0,
					}
				: block,
		);
	}
	if (blocks.length === 0) {
		blocks.push(makeFixed(typographyMetrics().line.xs, "detail-plan-empty", 0));
	}
	const frame = accumulateFrame(blocks, innerWidth, RESOLVER, {
		codePaddingX: MEASURE_MARKDOWN_CODE_PADDING.x,
		codePaddingY: MEASURE_MARKDOWN_CODE_PADDING.y,
		codeLangExtraTop: MARKDOWN_CONSTANTS.CODE_LANG_EXTRA_TOP,
		quotePaddingY: MARKDOWN_CONSTANTS.BLOCKQUOTE_PADDING,
		quoteMarginTop: MARKDOWN_CONSTANTS.PARAGRAPH_MARGIN_TOP,
	});
	// The local content frame excludes only the scroll box's own padding.
	const boxContent = Math.max(0, frame.contentHeight) + DETAIL_BOX_CHROME_Y;
	return { blocks, frame, boxContent };
}

/**
 * Build the capped body height: label chrome + min(content, cap).
 *
 * When real body `text` is present the content height comes from measuring how
 * that text WRAPS at the available width (bounded — see
 * measureCappedContentHeight). The caller-supplied `contentLines` counts only
 * hard newlines, which under-reports any soft-wrapped line and left long
 * single-line bodies clipped inside a 15px box. `contentLines` remains the
 * fallback when no text is carried (media caps, estimate-only details).
 */
function cappedBodyHeight(
	cap: number,
	contentLines: number | undefined,
	contentPx: number | undefined,
	text: string | undefined,
	availableWidth: number,
	textTruncated?: boolean,
): number {
	const content =
		contentPx ??
		(textTruncated === true
			? cap
			: text !== undefined
				? measureCappedContentHeight(text, cap, availableWidth)
				: (contentLines ?? 0) * detailContentLineHeight());
	return Math.min(content, cap);
}

function finishRegion(
	model: ToolSectionBody,
	blocks: PreparedBlock[],
	innerWidth: number,
	appliedCap: number | null,
): MeasuredToolBody {
	const frame = accumulateFrame(blocks, innerWidth, RESOLVER);
	return {
		model,
		kind: model.kind,
		height: frame.contentHeight,
		blocks,
		frame,
		contentWidth: innerWidth,
		appliedCap,
	};
}

/**
 * Blocks for one meta row: an optional wrapped text line, plus reserved fixed
 * rows for its badges and action buttons. Zero DOM — the badge/button rows are
 * fixed-height slots, so the chips inside them never affect the geometry.
 */
function metaRowBlocks(row: ToolMetaRow, marginTop: number): PreparedBlock[] {
	const out: PreparedBlock[] = [];
	let nextMargin = marginTop;
	if (row.text.length > 0) {
		out.push(
			makeInline(
				row.text,
				row.mono ? typographyMetrics().font.xsMono : typographyMetrics().font.xs,
				XS_LINE_HEIGHT,
				0,
				nextMargin,
				"vlist-tc-meta-row",
				// RENDER-ONLY: link target + dimmed tint (height-neutral).
				{
					...(row.href ? { href: row.href } : {}),
					...(row.dimmed ? { dimmed: true } : {}),
				},
			),
		);
		nextMargin = META_ROW_GAP;
	}
	if ((row.badges?.length ?? 0) > 0) {
		out.push(makeFixed(META_BADGE_ROW, "detail-meta-badges", nextMargin, { badges: row.badges }));
		nextMargin = META_ROW_GAP;
	}
	if (row.progress) {
		out.push(
			makeFixed(META_PROGRESS_ROW, "detail-meta-progress", nextMargin, {
				progress: row.progress,
			}),
		);
		nextMargin = META_ROW_GAP;
		const figures = row.progress.figures ?? [];
		if (figures.length > 0) {
			// One line: the figures are joined with separators by the render layer, and
			// a producer keeps the set stable for a run (see ToolRowProgress.figures),
			// so this never wraps into a second line mid-transfer.
			out.push(
				makeFixed(META_PROGRESS_FIGURES_ROW, "detail-meta-progress-figures", nextMargin, {
					figures,
				}),
			);
			nextMargin = META_ROW_GAP;
		}
	}
	if ((row.actions?.length ?? 0) > 0) {
		out.push(
			makeFixed(META_ACTION_ROW, "detail-meta-actions", nextMargin, { actions: row.actions }),
		);
	}
	return out;
}

/** Blocks for one structured entry: title + meta + clamped snippet + badges. */
function entryBlocks(
	entry: ToolStructuredEntry,
	marginTop: number,
	innerWidth: number,
): PreparedBlock[] {
	const out: PreparedBlock[] = [];
	let nextMargin = marginTop;
	out.push(
		makeInline(
			entry.title.length > 0 ? entry.title : " ",
			DETAIL_TEXT_FONT,
			XS_LINE_HEIGHT,
			0,
			nextMargin,
			"vlist-tc-entry-title",
			{
				...(entry.href ? { href: entry.href } : {}),
				...(entry.tone ? { tone: entry.tone } : {}),
			},
		),
	);
	nextMargin = 0;
	if ((entry.badges?.length ?? 0) > 0) {
		out.push(
			makeFixed(META_BADGE_ROW, "detail-entry-badges", nextMargin, { badges: entry.badges }),
		);
	}
	if (entry.meta) {
		out.push(
			makeInline(
				entry.meta,
				DETAIL_MONO_FONT,
				XS_LINE_HEIGHT,
				0,
				nextMargin,
				"vlist-tc-entry-meta",
				{
					dimmed: true,
				},
			),
		);
	}
	if (entry.snippet) {
		// Clamped: measure the wrap, then cap the row count so one huge snippet
		// cannot stretch the list (parity with the chunked `lineClamp`).
		const lines = Math.min(
			clampedLineCount(entry.snippet, typographyMetrics().font.xs, innerWidth),
			ENTRY_SNIPPET_MAX_LINES,
		);
		out.push(
			makeFixed(lines * typographyMetrics().line.xs, "detail-entry-snippet", nextMargin, {
				text: entry.snippet,
				maxLines: ENTRY_SNIPPET_MAX_LINES,
				...(entry.tone ? { tone: entry.tone } : {}),
			}),
		);
	}
	return out;
}

/**
 * Blocks for one question of a read-only ask replay.
 *
 * Mirrors the geometry AskUserQuestionBanner produces in `readOnly` mode (whose
 * exact chrome constants live in measure-permission.ts, reused here), minus the
 * Alert frame: the detail region already sits inside the tool card's padding.
 *
 * Row order: header → (option label [+ description])* → answer → customAnswer.
 * `role` / `control` / `selected` ride along as RENDER-ONLY data so the render
 * layer can draw radio/checkbox glyphs and the selected emphasis without
 * re-deriving anything.
 */
function askQuestionBlocks(question: ToolAskQuestion, marginTop: number): PreparedBlock[] {
	const out: PreparedBlock[] = [];
	let nextMargin = marginTop;
	const push = (block: PreparedBlock) => {
		out.push(block);
	};

	if (question.omitHeader !== true) {
		push(
			makeInline(
				question.header.length > 0 ? question.header : " ",
				HEADER_FONT,
				HEADER_LINE_HEIGHT,
				0,
				nextMargin,
				"vlist-tc-ask-header",
				{ role: "ask-header" },
			),
		);
		nextMargin = QUESTION_STACK_GAP;
	}

	const control = question.multiSelect === true ? "checkbox" : "radio";
	question.options.slice(0, ASK_OPTIONS_MAX).forEach((option, index) => {
		// The first option is separated from the header by the question gap; later
		// options by the tighter options gap.
		push(
			makeInline(
				option.label.length > 0 ? option.label : " ",
				OPTION_LABEL_FONT,
				OPTION_LABEL_LINE_HEIGHT,
				OPTION_INDENT,
				index === 0 ? nextMargin : OPTIONS_GAP,
				"vlist-tc-ask-option-label",
				{ role: "ask-option-label", control, ...(option.selected ? { selected: true } : {}) },
			),
		);
		if (option.description) {
			push(
				makeInline(
					option.description,
					OPTION_DESC_FONT,
					OPTION_DESC_LINE_HEIGHT,
					OPTION_INDENT,
					OPTION_DESC_MARGIN_TOP,
					"vlist-tc-ask-option-desc",
					{ role: "ask-option-desc" },
				),
			);
		}
		nextMargin = QUESTION_STACK_GAP;
	});

	// The answer text arrives already prefixed with its localized label, so the
	// measured string is exactly the painted string.
	if (question.answer) {
		push(
			makeInline(
				question.answer,
				OPTION_LABEL_FONT,
				OPTION_LABEL_LINE_HEIGHT,
				0,
				nextMargin,
				"vlist-tc-ask-answer",
				{ role: "ask-answer" },
			),
		);
		nextMargin = QUESTION_STACK_GAP;
	}
	if (question.customAnswer) {
		push(
			makeInline(
				question.customAnswer,
				CUSTOM_ANSWER_FONT,
				CUSTOM_ANSWER_LINE_HEIGHT,
				0,
				nextMargin,
				"vlist-tc-ask-custom-answer",
				{ role: "ask-custom-answer" },
			),
		);
	}
	return out;
}

/**
 * Wrapped line count of a short text at `width`, bounded: only the prefix that
 * could possibly fill the clamp is measured, so a 300KB snippet costs O(clamp).
 */
function clampedLineCount(text: string, font: string, width: number): number {
	const budget = Math.max(1, Math.ceil(width)) * (ENTRY_SNIPPET_MAX_LINES + 1);
	const prefix = text.length > budget ? text.slice(0, budget) : text;
	const prepared = prepareWithSegments(prefix, font, { whiteSpace: "pre-wrap" });
	const { lineCount } = measureLineStats(prepared, Math.max(1, width));
	return Math.max(1, lineCount);
}

/** Place independently measured bodies; labels/gaps belong only to this level. */
export function measureToolDetail(
	detail: ToolDetailData,
	innerWidth: number,
	viewportHeight?: number,
): MeasuredToolDetail {
	const sections: MeasuredToolDetailSection[] = [];
	let y = DETAIL_TOP_MARGIN;
	for (const part of detail.sections) {
		if (sections.length > 0) y += SECTION_GAP;
		const top = y;
		if (part.label !== undefined) y += typographyMetrics().line.xs + SECTION_LABEL_MARGIN_BOTTOM;
		const bodyTop = y;
		const measuredBody = measureToolBody(part.body, innerWidth, viewportHeight);
		y += measuredBody.height;
		sections.push({
			key: part.key,
			label: part.label,
			top,
			height: y - top,
			bodyTop,
			bodyHeight: measuredBody.height,
			measuredBody,
		});
	}
	return {
		kind: "sections",
		height: sections.length > 0 ? y : 0,
		contentWidth: innerWidth,
		sections,
	};
}

/** Measure one leaf in its own zero-based coordinates. No section margin or label. */
export function measureToolBody(
	detail: ToolCappedDetail,
	innerWidth: number,
	viewportHeight?: number,
): MeasuredToolBody<ToolCappedDetail>;
export function measureToolBody(
	detail: ToolSectionBody,
	innerWidth: number,
	viewportHeight?: number,
): MeasuredToolBody;
export function measureToolBody(
	detail: ToolSectionBody,
	innerWidth: number,
	viewportHeight?: number,
): MeasuredToolBody {
	switch (detail.kind) {
		case "meta-rows": {
			const rows = detail.rows.slice(0, META_ROWS_MAX);
			const blocks: PreparedBlock[] = [];
			rows.forEach((row, i) => {
				blocks.push(...metaRowBlocks(row, i === 0 ? 0 : META_ROW_GAP));
			});
			if (blocks.length === 0) {
				blocks.push(makeFixed(typographyMetrics().line.xs, "detail-meta-empty", 0));
			}
			return finishRegion(detail, blocks, innerWidth, null);
		}

		case "capped": {
			const cap = resolveDetailCap(detail.cap, viewportHeight);
			// Markdown bodies (ExitPlanMode plans) carry real prepared blocks instead
			// of one opaque fixed block, so the render layer can paint headings/lists/
			// code the way the chunked card's ContentViewer does.
			if (detail.format === "markdown" && detail.text != null && detail.text.length > 0) {
				const md = measureMarkdownDetail(
					detail.text,
					cap,
					innerWidth,
					detail.sourcePath,
					detail.textTruncated,
				);
				return {
					kind: "capped",
					model: detail,
					height: md.height,
					blocks: md.blocks,
					frame: md.frame,
					contentWidth: md.contentWidth,
					appliedCap: cap,
					markdown: true,
					// The parse above consumed the text; keep the raw source reachable so
					// the fullscreen viewer can show the whole body (the box only reveals
					// `cap` px of it). Output-only field — no block, no frame entry.
					sourceText: detail.text,
					// The rendered blocks stop short of the text: only a body past the
					// parse ceiling. Reported so the viewer can say the inline body is
					// incomplete rather than let it end mid-document.
					...(md.isPrefix ? { bodyIsPrefix: true } : {}),
					// `sourceText` is only a SERVER-side prefix, so the body's real bytes
					// still have to be fetched. Carried out for the same reason
					// `textTruncated` is on a plain capped block: it is what tells the
					// viewer host this body can ask for more. Height was already reserved
					// at the full cap above — this field is output-only.
					...(detail.textTruncated === true ? { textTruncated: true } : {}),
				};
			}
			const diffGutterChars = diffGutterWidthChars(detail.diffDocument);
			const media = mediaContentPx(detail.media, detail.contentPx, innerWidth, cap);
			const capped = detail.diffDocument
				? measureDiffDocumentHeight(detail.diffDocument, cap, innerWidth, detail.textTruncated)
				: cappedBodyHeight(
						cap,
						detail.contentLines,
						media.contentPx,
						detail.text,
						innerWidth,
						detail.textTruncated,
					);
			const block = makeFixed(capped, "detail-body", 0, {
				cap,
				capped,
				diffGutterChars,
				...(media.fit ? media.fit : {}),
			});
			return finishRegion(detail, [block], innerWidth, cap);
		}

		case "spec-tasks": {
			const blocks: PreparedInlineBlock[] = detail.tasks.map((task, i) => {
				// A protected task draws a lock AFTER the status glyph, in the same
				// leading lane, so its text lane starts further right. Folding that into
				// `contentLeft` keeps measure and render on one geometry: the text wraps
				// at the narrower width and is painted clear of the glyph.
				const indent = SPEC_TASK_INDENT + (task.protected === true ? SPEC_TASK_LOCK_LANE : 0);
				return makeInline(
					task.text.length > 0 ? task.text : "—",
					DETAIL_TEXT_FONT,
					XS_LINE_HEIGHT,
					indent,
					i === 0 ? 0 : SPEC_TASK_GAP,
					"vlist-tc-spec-task",
					// RENDER-ONLY: status glyph + protected lock (height-neutral).
					{ status: task.status ?? "todo", protected: task.protected === true },
				);
			});
			// Empty task doc still renders a compact one-row placeholder (a bordered
			// Paper with the "task list is empty" line, mirroring the chunked card).
			if (blocks.length === 0) {
				return finishRegion(
					detail,
					[makeFixed(SPEC_TASK_EMPTY_HEIGHT, "detail-spec-empty", 0)],
					innerWidth,
					null,
				);
			}
			return finishRegion(detail, blocks, innerWidth, null);
		}

		case "ask": {
			const blocks: PreparedBlock[] = [];
			detail.questions.slice(0, ASK_QUESTIONS_MAX).forEach((question, i) => {
				// Questions are separated by the banner's outer Stack gap; the first one
				// carries the region's own leading gap instead.
				blocks.push(...askQuestionBlocks(question, i === 0 ? 0 : ALERT_STACK_GAP));
			});
			// A question with no header, no options and no answer would otherwise
			// produce a zero-height region; keep one placeholder row.
			if (blocks.length === 0) {
				return finishRegion(
					detail,
					[makeFixed(typographyMetrics().line.xs, "detail-ask-empty", 0)],
					innerWidth,
					null,
				);
			}
			return finishRegion(detail, blocks, innerWidth, null);
		}

		case "structured": {
			const blocks: PreparedBlock[] = [];
			const badgeRows = detail.badgeRows ?? 0;
			if (badgeRows > 0) {
				blocks.push(
					makeFixed(badgeRows * STRUCT_BADGE_ROW, "detail-struct-badges", 0, {
						badgeRows,
						// RENDER-ONLY badge chips (height-neutral; height comes from badgeRows).
						badges: detail.badges,
					}),
				);
			}
			// Structured ENTRIES replace the flat body lines: each result keeps its
			// own title / meta / snippet / badges instead of being flattened.
			if (detail.entries && detail.entries.length > 0) {
				const entries = detail.entries.slice(0, ENTRY_MAX);
				entries.forEach((entry, i) => {
					const marginTop = i === 0 ? (badgeRows > 0 ? STRUCT_BADGE_GAP : 0) : SECTION_GAP;
					blocks.push(...entryBlocks(entry, marginTop, innerWidth));
				});
				return finishRegion(detail, blocks, innerWidth, null);
			}
			const font = detail.mono ? typographyMetrics().font.xsMono : typographyMetrics().font.xs;
			detail.bodyLines.forEach((line, i) => {
				const marginTop = i === 0 ? (badgeRows > 0 ? STRUCT_BADGE_GAP : 0) : STRUCT_BADGE_GAP;
				blocks.push(
					makeInline(
						line.length > 0 ? line : " ",
						font,
						STRUCT_BODY_LINE_HEIGHT,
						0,
						marginTop,
						"vlist-tc-struct-line",
					),
				);
			});
			// A badge-only structured detail (no body lines) is still one region.
			if (blocks.length === 0) {
				blocks.push(
					makeFixed(STRUCT_BADGE_ROW, "detail-struct-badges", 0, {
						badgeRows: 1,
						badges: detail.badges,
					}),
				);
			}
			return finishRegion(detail, blocks, innerWidth, null);
		}

		case "error": {
			const block = makeInline(
				detail.text.length > 0 ? detail.text : " ",
				DETAIL_TEXT_FONT,
				XS_LINE_HEIGHT,
				ERROR_INDENT,
				0,
				"vlist-tc-error",
				// RENDER-ONLY tone, carried on the block because the render layer only
				// ever sees the measured blocks (it never re-reads the classifier
				// output). Colour only — the geometry above is identical either way.
				detail.tone ? { tone: detail.tone } : undefined,
			);
			return finishRegion(detail, [block], innerWidth, null);
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Single tool card.
// ─────────────────────────────────────────────────────────────────────────────

/** Inner content width (px) inside the card padding + border. */
export function toolCardInnerWidth(contentWidth: number, inRun: boolean): number {
	const border = inRun ? 0 : CARD_BORDER * 2;
	return Math.max(1, contentWidth - CARD_PADDING * 2 - border);
}

/**
 * Measure a ToolCallCard at a content width. Deterministic, zero DOM.
 * @param data          the tool-call summary (name/summary/category/status/detail)
 * @param contentWidth  available OUTER card width in px
 * @param lod           render LOD (1..6); selects collapsed vs expanded
 * @param opts          viewportHeight / isRecent / opened / pendingPermission
 */
export function measureToolCall(
	data: ToolCallData,
	contentWidth: number,
	lod: RenderLod = DEFAULT_RENDER_LOD,
	opts: MeasureToolCallOpts = {},
): MeasuredToolCall {
	const inRun = data.inRun === true;
	const isLast = data.isLast === true;
	const isStreaming = data.isStreaming === true;
	const hasBorder = !inRun;
	const pending = opts.pendingPermission ?? null;
	const hasPending = pending != null;
	// A live pending-permission request (integration layer mounts the real form as
	// a slot). Distinct from `pending` (the zero-DOM measure copy); either one
	// forces the card expanded so the permission area shows.
	const hasPendingPermission = opts.hasPendingPermission === true;
	const forceExpanded = hasPending || hasPendingPermission || opts.forceExpanded === true;

	const innerWidth = toolCardInnerWidth(contentWidth, inRun);

	// ── Expand decision ──────────────────────────────────────────────────────
	const lodExempt = isRunningStatus(data.status) || isStreaming || forceExpanded;
	const isRecent = opts.isRecent ?? true;
	const opened = opts.opened ?? computeDefaultOpen(data, forceExpanded);
	// An EXPLICIT fold, as opposed to `opened === false` derived from
	// `computeDefaultOpen`. The two must stay distinct: at L5 the derived default is
	// not a decision the reader made, so honouring it there would collapse every
	// card whose category is not auto-open — while the reader's own click must be
	// honoured. `opts.opened` is supplied ONLY when the shell holds a stored
	// preference for this key, which is exactly what makes it the reader's voice.
	const userCollapsed = opts.opened === false;
	const effectiveOpened = resolveToolCallOpened(lod, {
		lodExempt,
		userCollapsed,
		isRecent,
		opened,
		lodUserOverride: opts.lodUserOverride,
	});

	// ── Fixed chrome ─────────────────────────────────────────────────────────
	const chromeY = CARD_PADDING * 2 + (hasBorder ? CARD_BORDER * 2 : 0);
	const dividerExtra = inRun && !isLast ? CARD_DIVIDER : 0;

	// ── Header block (always present, single row) ──────────────────────────────
	const headerBlock = makeFixed(HEADER_ROW_HEIGHT, "tool-header", 0, {
		toolName: data.toolName,
		category: data.category,
		status: data.status,
		summary: data.summary,
	});
	const blocks: PreparedBlock[] = [headerBlock];
	const frame = accumulateFrame(blocks, innerWidth, RESOLVER);

	// ── Collapsed height ───────────────────────────────────────────────────────
	// A folded card measures the SAME whether or not it carries injections. The
	// chunked path put its notice outside the collapse, and the vlist copied that
	// for parity — but the reasoning does not survive the footnote redesign: a
	// side-car is appended to the END of the tool's OUTPUT text, so on a folded card
	// (which shows no output at all) it is a footnote with nothing to be a footnote
	// to. The count marker in the header row says it exists; that costs no height.
	const collapsedHeight = chromeY + HEADER_ROW_HEIGHT + dividerExtra;

	// ── Expanded regions ───────────────────────────────────────────────────────
	let detail: MeasuredToolDetail | null = null;
	let permission: MeasuredInlinePermission | null = null;
	let reflection: MeasuredReflectionNotice | null = null;
	let innerContentH = HEADER_ROW_HEIGHT;

	const detailTop = HEADER_ROW_HEIGHT;
	let permissionTop = HEADER_ROW_HEIGHT;
	let reflectionTop = HEADER_ROW_HEIGHT;

	// A still-truncated payload costs NO geometry: a prefix body already reserves
	// its full cap (see `cappedBodyHeight`), and the rest is fetched when the reader
	// scrolls into the body's later half (VListContentViewHost) or opens it
	// fullscreen — so there is nothing to announce and no row to reserve.
	if (effectiveOpened) {
		if (data.detail) {
			detail = measureToolDetail(data.detail, innerWidth, opts.viewportHeight);
			innerContentH += detail.height;
		}
		const belowDetail = HEADER_ROW_HEIGHT + (detail?.height ?? 0);
		permissionTop = belowDetail;
		reflectionTop = belowDetail;
		// A reflection notice REPLACES the permission form, mirroring the chunked
		// precedence (ToolCallCard.tsx:5419). Streaming cards show neither.
		if (data.reflection && !isStreaming) {
			// Measured at exactly what paints: a running gate includes the takeover
			// row, a resolved one does not. The shrink when a gate resolves rides the
			// anchored live-patch rebuild (the same channel a completing tool uses);
			// pinning the running maximum instead would leave ~40px of blank canvas
			// under every resolved and every historical notice.
			reflection = measureReflectionNotice(data.reflection, innerWidth);
			innerContentH += reflection.topMargin + reflection.height;
		} else if (hasPending && !isStreaming) {
			// Streaming cards render only StreamingInputDetail — no permission UI.
			permission = measureInlinePermission(pending, innerWidth, lod);
			innerContentH += permission.topMargin + permission.height;
		}
	}

	const height = chromeY + innerContentH + dividerExtra;

	return {
		height,
		blocks,
		frame,
		contentWidth: innerWidth,
		usedWidth: contentWidth,
		effectiveOpened,
		lodExempt,
		isStreaming,
		inRun,
		isLast,
		hasBorder,
		chromeY,
		headerHeight: HEADER_ROW_HEIGHT,
		headerTop: 0,
		collapsedHeight,
		detail,
		detailTop,
		permission,
		permissionTop,
		reflection,
		reflectionTop,
		category: data.category,
		status: data.status,
		toolName: data.toolName,
		summary: data.summary,
		diffStats: data.diffStats ?? null,
		isRemoteTarget: data.isRemoteTarget === true,
		isTakenOver: data.isTakenOver === true,
		// Bash prefers pure execution time (mirrors the chunked getBashExecDurationMs).
		displayDurationMs:
			(data.category === "bash" ? data.execDurationMs : undefined) ?? data.durationMs ?? null,
		startedAt: data.startedAt ?? null,
		timeoutMs: data.timeoutMs ?? null,
		timing: resolveToolTimingStamps(data),
		errorMessage: data.errorMessage ?? null,
		toolUseId: data.toolUseId ?? null,
		truncatedLeafCount: data.truncatedLeafCount ?? 0,
		truncatedTotalBytes: data.truncatedTotalBytes ?? 0,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouped card (ToolCallGroup) — consecutive same-category tools folded into one.
// ─────────────────────────────────────────────────────────────────────────────

export interface MeasureToolCallGroupOpts {
	/** Whether the group is expanded (default false — groups collapse by default). */
	expanded?: boolean;
	/** Viewport height (px) forwarded to child plan cards. */
	viewportHeight?: number;
	/** L5 recency forwarded to child cards. Default true. */
	isRecent?: boolean;
}

export interface MeasuredToolCallGroup extends MeasuredElement {
	/** Whether the group body is expanded. */
	expanded: boolean;
	/** Group header row height. */
	headerHeight: number;
	/** Collapsed whole-group height. */
	collapsedHeight: number;
	/** Fixed vertical chrome (padding×2 + border×2). */
	chromeY: number;
	/** Child count (the ×N badge). */
	childCount: number;
	/** Measured child cards (present when expanded), in order. */
	children: MeasuredToolCall[];
	/** Body top within the group content box (== headerHeight). */
	bodyTop: number;
	/** Child list left offset (pl + border). */
	bodyLeft: number;
	/**
	 * Aggregate header timing — parity with the chunked ToolCallGroup header
	 * (ToolCallCard.tsx:5917-5949), which shows a live timer while any child runs
	 * and the summed duration once they all finish. All height-neutral (the group
	 * header is one fixed 17px row).
	 */
	totalDurationMs: number;
	/** Earliest start across ALL children — labels the header's tooltip. */
	earliestStartMs: number | null;
	/** Earliest start among still-running children — drives the live timer. */
	earliestActiveStartMs: number | null;
}

/** Statuses the chunked group treats as "still in progress" (:5910). */
const GROUP_ACTIVE_STATUSES = new Set<ToolCallStatus>(["running", "pending", "initializing"]);

/** Inner width of the grouped card's body (inside padding, border, pl + border). */
export function toolGroupBodyInnerWidth(contentWidth: number): number {
	const cardInner = Math.max(1, contentWidth - CARD_PADDING * 2 - CARD_BORDER * 2);
	return Math.max(1, cardInner - GROUP_BODY_PADDING_LEFT - GROUP_BODY_BORDER_LEFT);
}

/**
 * Measure a grouped tool-call card. Collapsed = header only; expanded = header +
 * a left-bordered body that stacks the child cards (each measured at the inner
 * body width). Follows the same chrome model as the single card.
 */
export function measureToolCallGroup(
	toolCalls: ToolCallData[],
	contentWidth: number,
	lod: RenderLod = DEFAULT_RENDER_LOD,
	opts: MeasureToolCallGroupOpts = {},
): MeasuredToolCallGroup {
	const expanded = opts.expanded === true;
	const childCount = toolCalls.length;

	const chromeY = CARD_PADDING * 2 + CARD_BORDER * 2;
	const innerWidth = Math.max(1, contentWidth - CARD_PADDING * 2 - CARD_BORDER * 2);

	const headerBlock = makeFixed(GROUP_HEADER_ROW, "group-header", 0, { childCount });
	const blocks: PreparedBlock[] = [headerBlock];
	const frame = accumulateFrame(blocks, innerWidth, RESOLVER);

	const collapsedHeight = chromeY + GROUP_HEADER_ROW;
	const bodyLeft = GROUP_BODY_PADDING_LEFT + GROUP_BODY_BORDER_LEFT;

	let children: MeasuredToolCall[] = [];
	let innerContentH = GROUP_HEADER_ROW;
	if (expanded) {
		const bodyInner = toolGroupBodyInnerWidth(contentWidth);
		children = toolCalls.map((tc) =>
			// Child cards are standalone (bordered) Paper cards — the group does not
			// pass inRun. They fold by default (own computeDefaultOpen).
			measureToolCall({ ...tc, inRun: false }, bodyInner, lod, {
				viewportHeight: opts.viewportHeight,
				isRecent: opts.isRecent ?? true,
			}),
		);
		const childrenH = children.reduce((sum, c) => sum + c.height, 0);
		innerContentH += GROUP_BODY_MARGIN_TOP + childrenH;
	}

	const height = chromeY + innerContentH;

	// Aggregates come from the RAW list, not `children`: child cards are only
	// measured when the group is expanded, and a collapsed group still shows its
	// header timer.
	let totalDurationMs = 0;
	let earliestStartMs: number | null = null;
	let earliestActiveStartMs: number | null = null;
	for (const tc of toolCalls) {
		const timing = resolveToolTimingStamps(tc);
		totalDurationMs += timing.durationMs ?? 0;
		const start = earliestToolStartMs(timing);
		if (start == null) continue;
		earliestStartMs = earliestStartMs == null ? start : Math.min(earliestStartMs, start);
		if (GROUP_ACTIVE_STATUSES.has(tc.status)) {
			earliestActiveStartMs =
				earliestActiveStartMs == null ? start : Math.min(earliestActiveStartMs, start);
		}
	}

	return {
		height,
		blocks,
		frame,
		contentWidth: innerWidth,
		usedWidth: contentWidth,
		expanded,
		headerHeight: GROUP_HEADER_ROW,
		collapsedHeight,
		chromeY,
		childCount,
		children,
		bodyTop: GROUP_HEADER_ROW,
		bodyLeft,
		totalDurationMs,
		earliestStartMs,
		earliestActiveStartMs,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
