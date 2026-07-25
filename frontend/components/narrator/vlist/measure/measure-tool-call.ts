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
 * Each detail body is clamped by a maxHeight, so its height is `min(estimated
 * content, cap)` — we only need to know whether the content overflows the cap.
 * The caps (see DETAIL_CAPS):
 *   code / term / diff / generic = 200,  bash & terminal command = 60,
 *   image/video/iframe / skill / knowledge = 400,  streaming bash = 120,
 *   other streaming = 400,  plan = 0.85 × viewport height (falls back to 400).
 * Content is estimated arithmetically (lineCount × line height, or a direct
 * pixel estimate for media) — never measured against the DOM.
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

import { prepareRichInline, type RichInlineItem } from "@chenglou/pretext/rich-inline";
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
} from "../pretext-fonts";
import {
	type InlinePermissionData,
	type MeasuredInlinePermission,
	measureInlinePermission,
} from "./measure-permission";
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

/** Header category-icon lane (`.headerCategoryIcon { width/height: 16px }`). */
export const HEADER_CATEGORY_ICON = 16;
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
 * Capped-detail content line box (ContentViewer / code / terminal preview at
 * font-size 11): 11×1.4 = 15.4 → 15. Only used to estimate whether content
 * overflows the cap — VListHarness calibrates the exact pixels.
 */
export const DETAIL_CONTENT_LINE_HEIGHT = lineBoxHeight(11, LINE_HEIGHT.xs); // 15
/** Detail section label ("Input"/"Output", Text size="xs") line box: 12×1.4 = 17. */
export const DETAIL_LABEL_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17
/** Detail section label `mb={2}`. */
export const DETAIL_LABEL_MARGIN_BOTTOM = 2;
/** Generic detail: `mt="xs"` gap before the output section. */
export const GENERIC_SECTION_GAP = SPACING.xs; // 10

/** Shared xs text line box (measured detail bodies): 12×1.4 = 17. */
export const XS_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17

/** SpecTasks: List `size="xs"` icon (ThemeIcon 16) + its label offset. */
export const SPEC_TASK_ICON = 16;
/** SpecTasks label indent (icon lane + List center gap). */
export const SPEC_TASK_INDENT = SPEC_TASK_ICON + 8; // 24
/** SpecTasks `List spacing={4}` between items. */
export const SPEC_TASK_GAP = 4;

/** Structured (recall/send/pipeline/web-search) badge header row (Badge xs). */
export const STRUCT_BADGE_ROW = 16;
/** Structured body line box (xs text). */
export const STRUCT_BODY_LINE_HEIGHT = XS_LINE_HEIGHT; // 17
/** Structured: gap between the badge header and the first body line. */
export const STRUCT_BADGE_GAP = 4;

/** Error detail: leading icon(16) + wrapped error text. */
export const ERROR_ICON = 16;
export const ERROR_INDENT = ERROR_ICON + 6; // 22

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
export type DetailCapKind =
	| "code"
	| "term"
	| "diff"
	| "bash-cmd"
	| "media"
	| "skill"
	| "knowledge"
	| "plan"
	| "streaming-bash"
	| "streaming";

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
	"streaming-bash": 120,
	streaming: 400,
};

/** Detail kinds that render a leading "Input"/"Output"-style label row. */
const CAPPED_WITH_LABEL = new Set<DetailCapKind>(["code", "term", "skill", "knowledge"]);

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
 * RENDER-ONLY image descriptor for a `media` cap (mirrors ToolMediaRef in
 * tool-detail.ts). Height-neutral; the render layer resolves an <img> src.
 */
export interface ToolMediaRef {
	previewUrl?: string;
	filePath?: string;
	imageId?: string;
	filename?: string;
	sizeKB?: number;
	imageFormat?: string;
}

/** 🟡 A single maxHeight-capped detail body (code/term/diff/media/skill/…). */
export interface ToolCappedDetail {
	kind: "capped";
	/** Which cap applies (also selects the default label behaviour). */
	cap: DetailCapKind;
	/** Estimated content line count (× DETAIL_CONTENT_LINE_HEIGHT). */
	contentLines?: number;
	/** Direct content pixel estimate (media/images); wins over contentLines. */
	contentPx?: number;
	/** Override the default label presence for this cap kind. */
	hasLabel?: boolean;
	/**
	 * Real body text (code/command/diff/output). RENDER-ONLY: painted inside the
	 * maxHeight-capped scroll box; never affects the measured height (driven by
	 * contentLines/contentPx + cap). Kept in sync with tool-detail.ts.
	 */
	text?: string;
	/**
	 * RENDER-ONLY image descriptor for `media` caps. Height-neutral (the height
	 * comes from contentPx). Kept in sync with tool-detail.ts.
	 */
	media?: ToolMediaRef;
}

/** 🟡 Generic detail: an input section + an optional output section (cap 200 each). */
export interface ToolGenericDetail {
	kind: "generic";
	inputLines: number;
	outputLines?: number;
	/** Real input/output body text. RENDER-ONLY (painted in the capped box). */
	inputText?: string;
	outputText?: string;
}

/** One SpecTasks row (mirrors SpecTaskLine in tool-detail.ts). */
export interface SpecTaskLine {
	text: string;
	status?: string;
	protected?: boolean;
}

/** 🔴 SpecTasks list: one wrapped row per task (task text drives wrapping). */
export interface ToolSpecTasksDetail {
	kind: "spec-tasks";
	tasks: SpecTaskLine[];
}

/** A structured badge chip (mirrors ToolStructuredBadge in tool-detail.ts). */
export interface ToolStructuredBadge {
	label: string;
	color?: string;
}

/** 🔴 Structured segment (recall/send/pipeline/web-search): badges + body lines. */
export interface ToolStructuredDetail {
	kind: "structured";
	/** Number of badge header rows (0 = none). Drives the reserved header height. */
	badgeRows?: number;
	/** RENDER-ONLY badge chips painted in the reserved header row(s). */
	badges?: ToolStructuredBadge[];
	/** Body text lines (each wraps; monospace when `mono`). */
	bodyLines: string[];
	/** Render the body lines in monospace (recall paths, pipeline ids). */
	mono?: boolean;
}

/** 🔴 Error detail: a leading icon + wrapped error text. */
export interface ToolErrorDetail {
	kind: "error";
	text: string;
}

export type ToolDetailData =
	| ToolCappedDetail
	| ToolGenericDetail
	| ToolSpecTasksDetail
	| ToolStructuredDetail
	| ToolErrorDetail;

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
	/** Remote execution → header badge (same row → height-neutral). */
	isRemoteTarget?: boolean;
	/** Expanded-body detail summary; null/absent → no detail region. */
	detail?: ToolDetailData | null;
	/** Rendered inside a run: no border, a trailing 1px divider unless last. */
	inRun?: boolean;
	/** In-run only: whether this is the last card (drops the divider). */
	isLast?: boolean;
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Measured result.
// ─────────────────────────────────────────────────────────────────────────────

/** A measured detail region (the LazyCollapse body's DetailRenderer part). */
export interface MeasuredToolDetail {
	/** Detail discriminant (renderer picks the visual). */
	kind: ToolDetailData["kind"];
	/** Region height (px), INCLUDING the `mt="xs"` top margin. */
	height: number;
	/** Prepared blocks (fixed for capped, inline for measured). */
	blocks: PreparedBlock[];
	/** Resolved frame at `contentWidth`. */
	frame: ElementFrame;
	/** Inner content width the frame was computed at. */
	contentWidth: number;
	/** The cap that was applied (capped/generic/plan only), else null. */
	appliedCap: number | null;
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
	/** Passthrough render metadata. */
	category: ToolCategory;
	status: ToolCallStatus;
	toolName: string;
	summary: string;
	isRemoteTarget: boolean;
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
 */
export function computeDefaultOpen(data: ToolCallData, pendingPermission: boolean): boolean {
	if (pendingPermission) return true;
	if (data.status === "pending") return true;
	if (data.isStreaming) return data.category === "file";
	const autoOpen: ToolCategory[] = [
		"tasks",
		"share",
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
	opts: { lodExempt: boolean; isRecent: boolean; opened: boolean; lodUserOverride?: boolean },
): boolean {
	if (opts.lodExempt || opts.lodUserOverride) return true;
	if (lod >= 6) return true;
	if (lod === 5) return opts.isRecent ? opts.opened : false;
	if (lod === 4) return false;
	// L1-L3: the upstream tool-run gate owns these levels; a card shown here is
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

/** Build the capped body height: label chrome + min(estimated content, cap). */
function cappedBodyHeight(
	cap: number,
	contentLines: number | undefined,
	contentPx: number | undefined,
	hasLabel: boolean,
): { height: number; capped: number } {
	const content = contentPx ?? (contentLines ?? 0) * DETAIL_CONTENT_LINE_HEIGHT;
	const capped = Math.min(content, cap);
	const labelH = hasLabel ? DETAIL_LABEL_LINE_HEIGHT + DETAIL_LABEL_MARGIN_BOTTOM : 0;
	return { height: labelH + capped, capped };
}

function finishRegion(
	kind: ToolDetailData["kind"],
	blocks: PreparedBlock[],
	innerWidth: number,
	appliedCap: number | null,
): MeasuredToolDetail {
	const frame = accumulateFrame(blocks, innerWidth, RESOLVER);
	return { kind, height: frame.contentHeight, blocks, frame, contentWidth: innerWidth, appliedCap };
}

/**
 * Measure a detail region at the card's inner width. Capped kinds are a single
 * fixed block (`min(content, cap)`); the pretext-measured kinds build inline
 * blocks. The first block carries `DETAIL_TOP_MARGIN` (the `<Box mt="xs">` gap).
 */
export function measureToolDetail(
	detail: ToolDetailData,
	innerWidth: number,
	viewportHeight?: number,
): MeasuredToolDetail {
	switch (detail.kind) {
		case "capped": {
			const cap = resolveDetailCap(detail.cap, viewportHeight);
			const hasLabel = detail.hasLabel ?? CAPPED_WITH_LABEL.has(detail.cap);
			const { height, capped } = cappedBodyHeight(
				cap,
				detail.contentLines,
				detail.contentPx,
				hasLabel,
			);
			const block = makeFixed(height, `detail-${detail.cap}`, DETAIL_TOP_MARGIN, {
				cap,
				capped,
				hasLabel,
				// Render-only body text (painted in the capped scroll box).
				text: detail.text,
				// Render-only image descriptor for media caps (painted as an <img>).
				media: detail.media,
			});
			return finishRegion("capped", [block], innerWidth, cap);
		}

		case "generic": {
			const cap = DETAIL_CAPS.code; // 200 per section
			const inH = cappedBodyHeight(cap, detail.inputLines, undefined, true);
			const blocks: PreparedFixedBlock[] = [
				makeFixed(inH.height, "detail-generic-input", DETAIL_TOP_MARGIN, {
					cap,
					capped: inH.capped,
					text: detail.inputText,
				}),
			];
			if (detail.outputLines != null) {
				const outH = cappedBodyHeight(cap, detail.outputLines, undefined, true);
				blocks.push(
					makeFixed(outH.height, "detail-generic-output", GENERIC_SECTION_GAP, {
						cap,
						capped: outH.capped,
						text: detail.outputText,
					}),
				);
			}
			return finishRegion("generic", blocks, innerWidth, cap);
		}

		case "spec-tasks": {
			const blocks: PreparedInlineBlock[] = detail.tasks.map((task, i) =>
				makeInline(
					task.text.length > 0 ? task.text : "—",
					DETAIL_TEXT_FONT,
					XS_LINE_HEIGHT,
					SPEC_TASK_INDENT,
					i === 0 ? DETAIL_TOP_MARGIN : SPEC_TASK_GAP,
					"vlist-tc-spec-task",
					// RENDER-ONLY: status glyph + protected lock (height-neutral).
					{ status: task.status ?? "todo", protected: task.protected === true },
				),
			);
			// Empty task doc still renders a compact one-row placeholder.
			if (blocks.length === 0) {
				return finishRegion(
					"spec-tasks",
					[makeFixed(SPEC_TASK_ICON, "detail-spec-empty", DETAIL_TOP_MARGIN)],
					innerWidth,
					null,
				);
			}
			return finishRegion("spec-tasks", blocks, innerWidth, null);
		}

		case "structured": {
			const blocks: PreparedBlock[] = [];
			const badgeRows = detail.badgeRows ?? 0;
			if (badgeRows > 0) {
				blocks.push(
					makeFixed(badgeRows * STRUCT_BADGE_ROW, "detail-struct-badges", DETAIL_TOP_MARGIN, {
						badgeRows,
						// RENDER-ONLY badge chips (height-neutral; height comes from badgeRows).
						badges: detail.badges,
					}),
				);
			}
			const font = detail.mono ? DETAIL_MONO_FONT : DETAIL_TEXT_FONT;
			detail.bodyLines.forEach((line, i) => {
				const marginTop =
					i === 0 ? (badgeRows > 0 ? STRUCT_BADGE_GAP : DETAIL_TOP_MARGIN) : STRUCT_BADGE_GAP;
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
					makeFixed(STRUCT_BADGE_ROW, "detail-struct-badges", DETAIL_TOP_MARGIN, {
						badgeRows: 1,
						badges: detail.badges,
					}),
				);
			}
			return finishRegion("structured", blocks, innerWidth, null);
		}

		case "error": {
			const block = makeInline(
				detail.text.length > 0 ? detail.text : " ",
				DETAIL_TEXT_FONT,
				XS_LINE_HEIGHT,
				ERROR_INDENT,
				DETAIL_TOP_MARGIN,
				"vlist-tc-error",
			);
			return finishRegion("error", [block], innerWidth, null);
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
	const forceExpanded = hasPending || hasPendingPermission;

	const innerWidth = toolCardInnerWidth(contentWidth, inRun);

	// ── Expand decision ──────────────────────────────────────────────────────
	const lodExempt = isRunningStatus(data.status) || isStreaming || forceExpanded;
	const isRecent = opts.isRecent ?? true;
	const opened = opts.opened ?? computeDefaultOpen(data, forceExpanded);
	const effectiveOpened = resolveToolCallOpened(lod, {
		lodExempt,
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
	const collapsedHeight = chromeY + HEADER_ROW_HEIGHT + dividerExtra;

	// ── Expanded regions ───────────────────────────────────────────────────────
	let detail: MeasuredToolDetail | null = null;
	let permission: MeasuredInlinePermission | null = null;
	let innerContentH = HEADER_ROW_HEIGHT;
	const detailTop = HEADER_ROW_HEIGHT;
	let permissionTop = HEADER_ROW_HEIGHT;

	if (effectiveOpened) {
		if (data.detail) {
			detail = measureToolDetail(data.detail, innerWidth, opts.viewportHeight);
			innerContentH += detail.height;
			permissionTop = HEADER_ROW_HEIGHT + detail.height;
		}
		// Streaming cards render only StreamingInputDetail — no permission UI.
		if (hasPending && !isStreaming) {
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
		category: data.category,
		status: data.status,
		toolName: data.toolName,
		summary: data.summary,
		isRemoteTarget: data.isRemoteTarget === true,
	};
}

/** Parse once, measure many (e.g. on resize / LOD change). Reusable closure. */
export function prepareToolCallMeasurer(
	data: ToolCallData,
): (contentWidth: number, lod?: RenderLod, opts?: MeasureToolCallOpts) => MeasuredToolCall {
	return (contentWidth, lod = DEFAULT_RENDER_LOD, opts = {}) =>
		measureToolCall(data, contentWidth, lod, opts);
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
}

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
	};
}

// ─────────────────────────────────────────────────────────────────────────────

export const MEASURE_TOOL_CALL_CONSTANTS = {
	CARD_PADDING,
	CARD_BORDER,
	CARD_DIVIDER,
	HEADER_CATEGORY_ICON,
	HEADER_TEXT_LINE_HEIGHT,
	HEADER_ROW_HEIGHT,
	DETAIL_TOP_MARGIN,
	DETAIL_CONTENT_LINE_HEIGHT,
	DETAIL_LABEL_LINE_HEIGHT,
	DETAIL_LABEL_MARGIN_BOTTOM,
	GENERIC_SECTION_GAP,
	XS_LINE_HEIGHT,
	SPEC_TASK_ICON,
	SPEC_TASK_INDENT,
	SPEC_TASK_GAP,
	STRUCT_BADGE_ROW,
	STRUCT_BODY_LINE_HEIGHT,
	STRUCT_BADGE_GAP,
	ERROR_ICON,
	ERROR_INDENT,
	GROUP_HEADER_TEXT_LINE,
	GROUP_HEADER_ICON,
	GROUP_HEADER_ROW,
	GROUP_BODY_MARGIN_TOP,
	GROUP_BODY_PADDING_LEFT,
	GROUP_BODY_BORDER_LEFT,
	DETAIL_CAPS,
} as const;
