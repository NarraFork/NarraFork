/**
 * RenderToolCall.tsx — Render copy for the ToolCallCard (batch-2 P10).
 *
 * Pairs with measure-tool-call.ts. Draws the exact shape the measure layer chose
 * (collapsed header / expanded detail + permission / grouped card) at the
 * predicted geometry, with zero DOM measurement. Visual parity target:
 * ToolCallCard.tsx ToolHeader(:1746) + the LazyCollapse body + ToolCallGroup.
 *
 *   - collapsed : a single header row (category icon + name + summary + status +
 *                 chevron), inside a bordered Paper (standalone) or a padded Box
 *                 + Divider (in a run).
 *   - expanded  : header row + the detail region (a maxHeight-capped scroll box
 *                 for capped kinds, or absolutely-positioned pretext lines for
 *                 spec-tasks / structured / error) + the optional InlinePermission
 *                 UI (reused from RenderPermission — P11).
 *   - group     : header row (label + ×N badge + status + chevron) + a
 *                 left-bordered body that stacks the child cards.
 *
 * The pretext-measured detail lines are materialized from the SAME flow the
 * measure layer used (walkRichInlineLineRanges + materializeRichInlineLineRange),
 * painted with the measured font so wrapping never drifts. Capped detail regions
 * are drawn as their own scroll container clamped to the measured cap. These are
 * VISUAL copies: the live interactive detail renderers (syntax highlighting,
 * truncation fetch, file preview, i18n) live in ToolCallCard.tsx outside vlist/.
 *
 * Follows the RenderMarkdown / RenderReasoning / RenderPermission template.
 */

import {
	materializeRichInlineLineRange,
	walkRichInlineLineRanges,
} from "@chenglou/pretext/rich-inline";
import { DiffContent } from "@frontend/components/narrator/diff/DiffContent";
import { formatDurationText, formatFullLocaleDateTime } from "@frontend/lib/format";
import { getShikiLang } from "@frontend/lib/shiki-lang";
import {
	Badge,
	Box,
	Button,
	CopyButton,
	Divider,
	Group,
	NumberInput,
	Paper,
	Popover,
	Progress,
	Stack,
	Text,
	ThemeIcon,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	CARD_SHIMMER_CLASS,
	resolveToolShimmerFlash,
	resolveToolShimmerPhase,
	type ToolShimmerFlash,
} from "@shared/tool-shimmer";
import {
	IconBan,
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconCopy,
	IconDevices,
	IconDownload,
	IconListCheck,
	IconLoader2,
	IconLock,
	IconPlayerPlay,
	IconPlayerStop,
	type IconProps,
	IconTool,
	IconX,
} from "@tabler/icons-react";
import type { ComponentType, ReactNode } from "react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import "../vlist-markdown.css";
import { useShikiTokens } from "@frontend/hooks/useShikiTokens";
import { fragmentTextStyle, letterSpacingForFont } from "@shared/pretext-layout/fragment-style";
import { TOOL_HEADER_SELECT_ATTR } from "../../message/MessageSelectionCtx";
import { AutoFollowScroll } from "../../scroll/AutoFollowScroll";
import { OPTION_CONTROL_SIZE } from "../measure/measure-permission";
import {
	CARD_HEADER_INNER_ICON,
	CARD_PADDING,
	DETAIL_BOX_PADDING_X,
	DETAIL_BOX_PADDING_Y,
	DETAIL_TOP_MARGIN,
	detailBodyFontSize,
	detailContentLineHeight,
	ENTRY_SNIPPET_MAX_LINES,
	earliestToolStartMs,
	GROUP_BODY_BORDER_LEFT,
	GROUP_BODY_MARGIN_TOP,
	GROUP_BODY_PADDING_LEFT,
	HEADER_CATEGORY_ICON,
	HEADER_CELL_GAP,
	HEADER_ROW_HEIGHT,
	isRunningStatus,
	type MeasuredToolBody,
	type MeasuredToolCall,
	type MeasuredToolCallGroup,
	type MeasuredToolDetail,
	SPEC_TASK_ICON,
	SPEC_TASK_INDENT,
	SPEC_TASK_LOCK,
	SPEC_TASK_LOCK_GAP,
	SPEC_TASK_LOCK_LANE,
	type ToolCallStatus,
	type ToolCategory,
	type ToolRowAction,
	type ToolRowProgress,
	type ToolSectionLabel,
	type ToolTimingStamps,
} from "../measure/measure-tool-call";
import type { BlockFrame, PreparedInlineBlock } from "../prepared-block";
import { typographyMetrics } from "../pretext-fonts";
import { VListContentViewHost, type VListViewControls } from "../VListContentViewHost";
import { findViewTarget, type VListViewTarget } from "../vlist-content-view-target";
import { categoryIcon } from "./category-icons";
import { DiffStatsText, type DiffStatsValue } from "./diff-stats-text";
import { activateOnKey, swallowSelectionClick } from "./key-activate";
import { FragmentGap, LineFragments } from "./line-fragments";
import { RenderMarkdown } from "./RenderMarkdown";
import { type InlinePermissionLabels, RenderInlinePermission } from "./RenderPermission";
import { type ReflectionNoticeLabels, RenderReflectionNotice } from "./RenderReflectionNotice";
import { TokenFlowText } from "./TokenLines";
import { readExactDisplayBox, VListImage } from "./vlist-image";

// ─────────────────────────────────────────────────────────────────────────────
// i18n-facing labels, injected by the dispatch/registry layer (no i18n import
// across the vlist edge). Sensible English fallbacks keep this self-contained.
// ─────────────────────────────────────────────────────────────────────────────
export interface ToolCallLabels {
	/** Detail "Input" section label (generic / capped-with-label). */
	input?: string;
	/** Detail "Output" section label (generic / capped-with-label). */
	output?: string;
	/** Remote-execution header badge label. */
	remote?: string;
	/** Header badge label for a call blocked by a user takeover of its subagent. */
	takenOver?: string;
	/**
	 * Localized `_planFile` provenance template, e.g. `"Plan from {file}"`. The
	 * measure layer only carries the raw path (shared/ has no i18n), so the
	 * substitution happens here.
	 */
	planSource?: string;
	/**
	 * Localized text for every section label id. The measure layer carries only the
	 * semantic id (`shared/` has no i18n), so the wording is resolved here. The
	 * record is EXHAUSTIVE over `ToolSectionLabel`, making a missing translation a
	 * compile error instead of a silently English card.
	 */
	sections?: Partial<Record<ToolSectionLabel, string>>;
	/** Share-card action button labels. */
	download?: string;
	copy?: string;
	copied?: string;
	/** Terminate-running-tool button tooltip. */
	terminate?: string;
	/**
	 * Header timing popover + timeout editor strings. Absent → English fallbacks
	 * (DEFAULT_TIMING_LABELS). All of them live in a portal or a fixed-height row,
	 * so translating them cannot move a measured height.
	 */
	timing?: ToolTimingLabels;
	/** Placeholder line for a valid but EMPTY spec task document. */
	tasksEmpty?: string;
	/** Permission labels forwarded to RenderInlinePermission. */
	permission?: InlinePermissionLabels;
	/** Reflection-notice labels forwarded to RenderReflectionNotice. */
	reflection?: ReflectionNoticeLabels;
}

const DEFAULT_LABELS: Required<
	Pick<
		ToolCallLabels,
		| "input"
		| "output"
		| "remote"
		| "takenOver"
		| "planSource"
		| "download"
		| "copy"
		| "copied"
		| "terminate"
		| "tasksEmpty"
	>
> = {
	input: "Input",
	output: "Output",
	remote: "remote",
	takenOver: "Taken over by user",
	planSource: "Plan from {file}",
	download: "Download",
	copy: "Copy link",
	copied: "Copied",
	terminate: "Terminate",
	tasksEmpty: "Task list is empty",
};

/** English fallbacks for the section labels (overridden by injected labels). */
const DEFAULT_SECTION_LABELS: Record<ToolSectionLabel, string> = {
	input: "Input",
	output: "Output",
	command: "Command",
	message: "Message",
	delivery: "Delivery",
	reply: "Reply",
	result: "Result",
	rule: "Rule",
	captured: "Captured",
	files: "Files",
	plan: "Plan",
	error: "Error",
};

/** Fill the single `{file}` placeholder of the plan-source template. */
function formatPlanSource(template: string, file: string): string {
	return template.includes("{file}") ? template.replace("{file}", file) : `${template} ${file}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Category → colour (mirrors ToolCallCard getCategoryColor). Kept local to the
// vlist render layer so it never imports the heavy ToolCallCard module; exported
// so a subagent card's recent-call rows tint their chips from the same table the
// tool header and the trace rows use.
// ─────────────────────────────────────────────────────────────────────────────
export const CATEGORY_COLOR: Record<ToolCategory, string> = {
	read: "lime",
	file: "violet",
	bash: "orange",
	search: "cyan",
	webSearch: "teal",
	webFetch: "teal",
	tasks: "teal",
	taskOutput: "indigo",
	agent: "pink",
	await: "indigo",
	send: "blue",
	ask: "blue",
	plan: "grape",
	pipeline: "indigo",
	terminal: "yellow",
	share: "green",
	transfer: "blue",
	recall: "cyan",
	skill: "grape",
	browser: "teal",
	knowledge: "grape",
	generic: "gray",
};

const STATUS_COLOR: Record<ToolCallStatus, string> = {
	pending: "yellow",
	initializing: "blue",
	running: "blue",
	success: "green",
	fail: "red",
	cancelled: "orange",
};

function cssColor(color: string, shade: number): string {
	return `var(--mantine-color-${color}-${shade})`;
}

/** Mantine `-light` background variable (category-icon chip / subtle fills). */
function cssLight(color: string): string {
	return `var(--mantine-color-${color}-light)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared inline-line materialization (mirrors RenderMarkdown InlineBlockView).
// ─────────────────────────────────────────────────────────────────────────────
interface RenderedLine {
	fragments: Array<{ text: string; font: string; className: string; gapBefore: number }>;
}

function useInlineLines(block: PreparedInlineBlock, availableWidth: number): RenderedLine[] {
	return useMemo(() => {
		const lineWidth = Math.max(1, availableWidth - block.contentLeft);
		const out: RenderedLine[] = [];
		walkRichInlineLineRanges(block.flow, lineWidth, (range) => {
			const line = materializeRichInlineLineRange(block.flow, range);
			out.push({
				fragments: line.fragments.map((f) => ({
					text: f.text,
					font: block.fonts[f.itemIndex] ?? "",
					className: block.classNames[f.itemIndex] ?? "",
					gapBefore: f.gapBefore,
				})),
			});
		});
		return out;
	}, [block, availableWidth]);
}

function InlineLines({
	block,
	frame,
	availableWidth,
	color,
	leadingSlot,
	href,
}: {
	block: PreparedInlineBlock;
	frame: BlockFrame;
	availableWidth: number;
	color?: string;
	/** Optional glyph drawn in the reserved indent lane (spec-task status icon). */
	leadingSlot?: React.ReactNode;
	/**
	 * When set, the whole measured line box becomes an external link. Drawn as an
	 * overlay so the pretext line geometry stays the single source of truth (an
	 * <a> wrapper would let the browser re-lay out the fragments).
	 */
	href?: string | null;
}) {
	const lines = useInlineLines(block, availableWidth);
	return (
		<div
			style={{
				position: "absolute",
				top: frame.top,
				left: 0,
				width: availableWidth,
				height: frame.height,
			}}
		>
			{href ? (
				<a
					href={href}
					target="_blank"
					rel="noopener noreferrer"
					title={href}
					style={{
						position: "absolute",
						inset: 0,
						zIndex: 1,
						textDecoration: "none",
						cursor: "pointer",
					}}
				>
					{/* The visible text is painted by the measured fragments below; this
					    overlay only carries the link target, so its own label is
					    screen-reader-only (visually hidden, zero layout impact). */}
					<span
						style={{
							position: "absolute",
							width: 1,
							height: 1,
							overflow: "hidden",
							clip: "rect(0 0 0 0)",
							whiteSpace: "nowrap",
						}}
					>
						{href}
					</span>
				</a>
			) : null}
			{leadingSlot}
			{lines.map((line, lineIndex) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable ordered list
					key={lineIndex}
					style={{
						position: "absolute",
						left: block.contentLeft,
						top: lineIndex * block.lineHeight,
						height: block.lineHeight,
						display: "flex",
						alignItems: "center",
						width: "max-content",
					}}
				>
					<LineFragments>
						{line.fragments.map((frag, fi) => (
							<Fragment
								// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
								key={fi}
							>
								<FragmentGap gapBefore={frag.gapBefore} />
								<span
									className={frag.className}
									style={{
										...fragmentTextStyle({
											font: frag.font,
											gapBefore: frag.gapBefore,
											letterSpacing: letterSpacingForFont(frag.font),
										}),
										color,
									}}
								>
									{frag.text}
								</span>
							</Fragment>
						))}
					</LineFragments>
				</div>
			))}
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Header row.
// ─────────────────────────────────────────────────────────────────────────────
interface ToolHeaderRowProps {
	toolName: string;
	summary: string;
	category: ToolCategory;
	status: ToolCallStatus;
	/** Write/Edit line counts (`+12 -3`); null → nothing is drawn. */
	diffStats: DiffStatsValue | null;
	isRemoteTarget: boolean;
	/** Localized remote-execution badge label. */
	remoteLabel: string;
	/** The awaited subagent is taken over by the user → the call is parked. */
	isTakenOver: boolean;
	/** Localized takeover badge label. */
	takenOverLabel: string;
	opened: boolean;
	onToggle?: () => void;
	/** Optional category-icon override; falls back to a neutral tool glyph. */
	icon?: ComponentType<IconProps>;
	/** Final duration (ms) for a completed call — a static dimmed label. */
	durationMs?: number | null;
	/** Start epoch (ms) for a running call — drives the live elapsed timer. */
	startedAt?: number | null;
	/** Effective timeout (ms) — the `/ 30s` suffix after the duration. */
	timeoutMs?: number | null;
	/** Lifecycle stamps behind the timing popover (portaled → height-neutral). */
	timing?: ToolTimingStamps | null;
	/** Localized timing-popover strings. */
	timingLabels?: ToolTimingLabels;
	/** Commit a new timeout (ms) for this running call. Absent → read-only. */
	onUpdateTimeout?: (timeoutMs: number) => void;
	/** Terminate the running tool (bash / MCP). Absent → no button. */
	onTerminate?: () => void;
	/** Localized terminate tooltip / aria label. */
	terminateLabel: string;
}

function ToolHeaderRow({
	toolName,
	summary,
	category,
	status,
	diffStats,
	isRemoteTarget,
	remoteLabel,
	isTakenOver,
	takenOverLabel,
	opened,
	onToggle,
	icon: Icon = IconTool,
	durationMs,
	startedAt,
	timeoutMs,
	timing,
	timingLabels,
	onUpdateTimeout,
	onTerminate,
	terminateLabel,
}: ToolHeaderRowProps) {
	const color = CATEGORY_COLOR[category];
	const statusColor = STATUS_COLOR[status];
	const running = isRunningStatus(status);
	return (
		<Group
			data-nf-card-header
			// The header doubles as the card's selectable surface: Ctrl/Cmd/Shift+Click
			// must reach the row's selection wrapper (which ignores role="button"
			// targets) instead of being treated as an interactive island.
			{...{ [TOOL_HEADER_SELECT_ATTR]: "" }}
			gap={HEADER_CELL_GAP}
			wrap="nowrap"
			align="center"
			// A keyboard and a screen reader cannot use a bare `onClick` on a div. That
			// matters most for a DRILLED-IN trace row: its summary line (which did carry
			// these attributes) is not painted, so this header is the ONLY control that
			// can close the card again. ATTRIBUTES ONLY — the measured header height is
			// `HEADER_ROW_HEIGHT` either way.
			role={onToggle ? "button" : undefined}
			tabIndex={onToggle ? 0 : undefined}
			aria-expanded={onToggle ? opened : undefined}
			style={{
				height: HEADER_ROW_HEIGHT,
				cursor: onToggle ? "pointer" : "default",
				userSelect: "none",
			}}
			// A modified click selects the block; only a plain click toggles the card.
			onClick={onToggle ? swallowSelectionClick(onToggle) : undefined}
			onKeyDown={onToggle ? activateOnKey(onToggle) : undefined}
		>
			<span
				style={{
					// The SAME tile size a folded trace row uses, so drilling in or out does not
					// resize the chip mid-morph. Height-neutral: the header's 19px text line
					// dominates `max(icon, text)` at this size.
					width: HEADER_CATEGORY_ICON,
					height: HEADER_CATEGORY_ICON,
					minWidth: HEADER_CATEGORY_ICON,
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					borderRadius: "var(--mantine-radius-sm)",
					background: cssLight(color),
					color: cssColor(color, 6),
				}}
			>
				{/* Same glyph size a folded row's chip uses, so the icon does not change size
				    across the morph now that both tiles are the same 14px lane. */}
				<Icon size={CARD_HEADER_INNER_ICON} />
			</span>
			<span
				style={{
					fontSize: "var(--mantine-font-size-xs)",
					lineHeight: "var(--mantine-line-height)",
					fontFamily: "var(--mantine-font-family-monospace)",
					fontWeight: 600,
					color: "var(--mantine-color-dimmed)",
					flexShrink: 0,
				}}
			>
				{toolName}
			</span>
			<span
				style={{
					// `flex: 1` — the summary claims the header's slack, which pushes the diff
					// stats and the duration to the card's RIGHT edge. That is the card's
					// intended layout: a card is a wide, self-contained box where a right-hand
					// column of figures reads as a column, and there is no neighbouring row to
					// confuse it with.
					//
					// ⚠️ Do NOT change this to `0 1 auto` to make the drill morph easier. That
					// was tried: it does put those cells in the same place in both forms, but it
					// does so by breaking the card's own layout, which is backwards — the static
					// appearance is the requirement and the transition serves it. The morph
					// handles the difference itself (see `DRILL_MORPH_TAIL_*`).
					flex: 1,
					minWidth: 0,
					fontSize: "var(--mantine-font-size-xs)",
					lineHeight: "var(--mantine-line-height)",
					fontFamily: "var(--mantine-font-family-monospace)",
					color: "var(--mantine-color-dimmed)",
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap",
				}}
				title={summary}
			>
				{summary}
			</span>
			{/* `+N -N` for a Write/Edit. Placed right after the path so the two read as
			    one phrase ("this file, this much"), and before the badges so a remote
			    marker cannot separate the figure from what it describes. Height-neutral:
			    one nowrap span in this already-fixed row. */}
			{/* One wrapper around the whole tail cluster, marked for the drill morph.
			    These cells sit at the card's RIGHT edge but hug the title in a folded row,
			    and the distance between those two places depends on the rendered title
			    width — which the measure layer never computes. So the morph cross-fades
			    this node instead of moving it (see `drillTailKeyframes`), and a fade needs
			    ONE element: fading each cell separately would let them dissolve at
			    slightly different times.

			    ⚠️ NOT `display: contents`, which would leave the cells as direct flex
			    participants but generate NO BOX for the wrapper — and `opacity` on a
			    box-less element does nothing, so the fade would silently never appear. An
			    `inline-flex` carrying the header's own gap reproduces the same spacing and
			    alignment while being a real, fadeable box. `flexShrink: 0` keeps the
			    cluster intact when a long summary claims the slack. */}
			<span
				data-nf-card-tail
				style={{
					display: "inline-flex",
					alignItems: "center",
					gap: HEADER_CELL_GAP,
					flexShrink: 0,
				}}
			>
				<DiffStatsText stats={diffStats} />
				{isRemoteTarget ? (
					<Badge
						size="xs"
						variant="light"
						color="indigo"
						leftSection={<IconDevices size={10} />}
						style={{ flexShrink: 0 }}
					>
						{remoteLabel}
					</Badge>
				) : null}
				{/* An in-flight Await whose target got taken over never returns, and the
			    header would otherwise show nothing but a ticking timer. Grape matches
			    the `taken_over` substatus colour in status-registry.ts. */}
				{isTakenOver ? (
					<Badge
						data-testid="tool-taken-over"
						size="xs"
						variant="light"
						color="grape"
						style={{ flexShrink: 0 }}
					>
						{takenOverLabel}
					</Badge>
				) : null}
				<span
					style={{
						display: "inline-flex",
						alignItems: "center",
						color: cssColor(statusColor, 6),
						flexShrink: 0,
					}}
				>
					<StatusGlyph status={status} color={statusColor} />
				</span>
				{/* Timing lives INSIDE the existing single header row (height-neutral):
			    a live elapsed counter while running, else the final duration. The
			    breakdown popover and the timeout editor are portaled, so neither can
			    change the measured header height. */}
				<ToolTimingArea
					running={running}
					startedAt={startedAt}
					durationMs={durationMs}
					timeoutMs={timeoutMs}
					timing={timing}
					labels={timingLabels}
					onUpdateTimeout={onUpdateTimeout}
				/>
			</span>
			{running && onTerminate ? (
				<Tooltip label={terminateLabel} position="top" withArrow fz="xs">
					<UnstyledButton
						aria-label={terminateLabel}
						onClick={(e: React.MouseEvent) => {
							// Never let the terminate click toggle the card.
							e.stopPropagation();
							onTerminate();
						}}
						style={{
							display: "inline-flex",
							alignItems: "center",
							color: "var(--mantine-color-red-5)",
							flexShrink: 0,
						}}
					>
						<IconPlayerStop size={11} />
					</UnstyledButton>
				</Tooltip>
			) : null}
			<span
				style={{
					display: "inline-flex",
					alignItems: "center",
					color: "var(--mantine-color-dimmed)",
					flexShrink: 0,
				}}
			>
				{opened ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
			</span>
		</Group>
	);
}

/**
 * Live elapsed-seconds counter for a running tool.
 *
 * A local copy of ToolCallCard's ElapsedTimer rather than an import: importing it
 * would create a CYCLE (ToolCallCard → … → this render module), which surfaces as
 * a bogus "Export named 'ElapsedTimer' not found" at load time. Same reasoning as
 * `render/category-icons.tsx`, which re-declares the icon map for this reason.
 * Height-neutral: it renders one inline text run inside the fixed header row.
 */
function ElapsedTimer({ startedAt }: { startedAt: number }) {
	const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - startedAt) / 1000));
	useEffect(() => {
		setElapsed(Math.floor((Date.now() - startedAt) / 1000));
		const timer = setInterval(() => {
			setElapsed(Math.floor((Date.now() - startedAt) / 1000));
		}, 1000);
		return () => clearInterval(timer);
	}, [startedAt]);
	return <span>{formatDurationText(elapsed * 1000)}</span>;
}

/**
 * The header's timing text: a ticking elapsed counter while the tool runs, the
 * final duration once it finishes, plus the `/ timeout` suffix. Fixed single-line
 * slot, so nothing here can change the measured header height.
 */
function TimingText({
	running,
	startedAt,
	durationMs,
	timeoutMs,
	timeoutInteractive,
}: {
	running: boolean;
	startedAt?: number | null;
	durationMs?: number | null;
	timeoutMs?: number | null;
	/** Dim the timeout suffix a little less when it is a live editor target. */
	timeoutInteractive?: boolean;
}) {
	const showElapsed = running && startedAt != null && startedAt > 0;
	const showDuration = !running && durationMs != null && durationMs >= 0;
	if (!showElapsed && !showDuration && timeoutMs == null) return null;
	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 2,
				fontSize: "var(--mantine-font-size-xs)",
				fontFamily: "var(--mantine-font-family-monospace)",
				color: "var(--mantine-color-dimmed)",
				flexShrink: 0,
				whiteSpace: "nowrap",
			}}
		>
			{showElapsed ? <ElapsedTimer startedAt={startedAt as number} /> : null}
			{showDuration ? <span>{formatDurationText(durationMs as number)}</span> : null}
			{timeoutMs != null ? (
				<span style={{ opacity: timeoutInteractive ? 0.7 : 0.5 }}>
					/ {formatDurationText(timeoutMs, { style: "timeout" })}
				</span>
			) : null}
		</span>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Header timing area: breakdown popover + timeout editor.
//
// Parity target: ToolCallCard's ToolTimingArea (:1331) / ToolTimingPopoverLabel
// (:1212) / TimeoutEditorPopover (:1443). Reimplemented locally rather than
// imported for the same reason as ElapsedTimer above — importing ToolCallCard
// from here forms a module cycle.
//
// HEIGHT-NEUTRAL by construction: both popovers render `withinPortal`, and the
// only in-row change is that the duration text becomes a zero-padding button.
// ─────────────────────────────────────────────────────────────────────────────

/** Localized strings for the timing popover + timeout editor. */
export interface ToolTimingLabels {
	title: string;
	started: string;
	streamStarted: string;
	permissionStarted: string;
	executionStarted: string;
	completed: string;
	/** Carries a literal `{duration}` placeholder. */
	total: string;
	permissionWait: string;
	execution: string;
	/** Carries a literal `{time}` placeholder (aria-label / group tooltip). */
	startedAt: string;
	/** Timeout editor: numeric field label + commit button. */
	timeoutSeconds: string;
	timeoutUpdate: string;
}

const DEFAULT_TIMING_LABELS: ToolTimingLabels = {
	title: "Timing",
	started: "Started",
	streamStarted: "Tool streaming started",
	permissionStarted: "Permission wait started",
	executionStarted: "Execution started",
	completed: "Execution completed",
	total: "Total {duration}",
	permissionWait: "Permission wait {duration}",
	execution: "Execution {duration}",
	startedAt: "Started at {time}",
	timeoutSeconds: "Timeout (seconds)",
	timeoutUpdate: "Update",
};

/** Fill a single named placeholder, appending when the template lacks it. */
function fillLabel(template: string, token: string, value: string): string {
	const placeholder = `{${token}}`;
	return template.includes(placeholder)
		? template.replaceAll(placeholder, value)
		: `${template} ${value}`;
}

/** True when the card carries at least one stamp worth showing a breakdown for. */
function hasTimingDetails(timing: ToolTimingStamps | null | undefined): boolean {
	if (!timing) return false;
	return (
		timing.startedAt != null ||
		timing.createdAt != null ||
		timing.streamStartedAt != null ||
		timing.permissionStartedAt != null ||
		timing.executionStartedAt != null ||
		timing.completedAt != null
	);
}

/**
 * The lifecycle breakdown drawn inside the popover.
 *
 * Mirrors ToolTimingPopoverLabel exactly, including the two subtleties that make
 * the chunked version readable:
 *   - the generic "Started" row is SUPPRESSED when it coincides with one of the
 *     named phases (otherwise every card shows the same timestamp twice), and
 *   - `completed` falls back through executionStarted + displayed duration, then
 *     earliest start + final duration, so a card whose completion stamp never
 *     persisted still closes out its timeline.
 */
function ToolTimingBreakdown({
	timing,
	displayDurationMs,
	labels,
}: {
	timing: ToolTimingStamps;
	displayDurationMs?: number | null;
	labels: ToolTimingLabels;
}) {
	const resolvedStart = earliestToolStartMs(timing);
	const explicitCandidates = [timing.startedAt, timing.createdAt].filter(
		(value): value is number => value != null,
	);
	const explicitStarted = explicitCandidates.length > 0 ? Math.min(...explicitCandidates) : null;
	const { streamStartedAt, permissionStartedAt, executionStartedAt } = timing;
	const finalDurationMs = timing.durationMs ?? displayDurationMs ?? null;
	const completed =
		timing.completedAt ??
		(executionStartedAt != null && displayDurationMs != null
			? executionStartedAt + displayDurationMs
			: resolvedStart != null && finalDurationMs != null
				? resolvedStart + finalDurationMs
				: null);
	const genericStarted =
		explicitStarted != null &&
		explicitStarted !== streamStartedAt &&
		explicitStarted !== permissionStartedAt &&
		explicitStarted !== executionStartedAt
			? explicitStarted
			: null;

	const steps = (
		[
			{ key: "started", label: labels.started, time: genericStarted },
			{ key: "stream", label: labels.streamStarted, time: streamStartedAt },
			{ key: "permission", label: labels.permissionStarted, time: permissionStartedAt },
			{ key: "execution", label: labels.executionStarted, time: executionStartedAt },
			{ key: "completed", label: labels.completed, time: completed },
		] as Array<{ key: string; label: string; time: number | null }>
	).filter((step): step is { key: string; label: string; time: number } => step.time != null);

	if (steps.length === 0) return null;

	const precise = (ms: number) => formatDurationText(ms, { style: "precise" });

	return (
		<Stack gap={4} maw={360}>
			<Text size="xs" fw={600}>
				{labels.title}
			</Text>
			{steps.map((step, index) => {
				const previous = steps[index - 1]?.time;
				const delta = previous == null ? null : Math.max(0, step.time - previous);
				return (
					<Group key={step.key} gap={6} wrap="nowrap" justify="space-between">
						<Text size="xs" style={{ flex: 1 }}>
							{step.label}
						</Text>
						<Text size="xs" ff="monospace" c="dimmed">
							{formatFullLocaleDateTime(step.time)}
						</Text>
						{delta != null ? (
							<Text size="xs" ff="monospace" c="dimmed" style={{ textAlign: "right" }}>
								+{precise(delta)}
							</Text>
						) : null}
					</Group>
				);
			})}
			{resolvedStart != null && completed != null ? (
				<Text size="xs" c="dimmed">
					{fillLabel(labels.total, "duration", precise(Math.max(0, completed - resolvedStart)))}
				</Text>
			) : null}
			{permissionStartedAt != null && executionStartedAt != null ? (
				<Text size="xs" c="dimmed">
					{fillLabel(
						labels.permissionWait,
						"duration",
						precise(Math.max(0, executionStartedAt - permissionStartedAt)),
					)}
				</Text>
			) : null}
			{executionStartedAt != null && completed != null ? (
				<Text size="xs" c="dimmed">
					{fillLabel(
						labels.execution,
						"duration",
						precise(Math.max(0, completed - executionStartedAt)),
					)}
				</Text>
			) : null}
		</Stack>
	);
}

/** Timeout editor popover for a running call (mirrors TimeoutEditorPopover). */
function TimeoutEditor({
	timeoutMs,
	opened,
	onOpenedChange,
	onCommit,
	labels,
	children,
}: {
	timeoutMs: number;
	opened: boolean;
	onOpenedChange: (opened: boolean) => void;
	onCommit: (timeoutMs: number) => void;
	labels: ToolTimingLabels;
	children: React.ReactNode;
}) {
	const [value, setValue] = useState<number | string>(Math.round(timeoutMs / 1000));
	useEffect(() => {
		if (!opened) setValue(Math.round(timeoutMs / 1000));
	}, [timeoutMs, opened]);

	const commit = () => {
		const seconds = typeof value === "string" ? Number.parseFloat(value) : value;
		if (!seconds || seconds <= 0) return;
		onCommit(Math.round(seconds * 1000));
		onOpenedChange(false);
	};

	return (
		<Popover
			opened={opened}
			onChange={onOpenedChange}
			position="top"
			withArrow
			withinPortal
			shadow="md"
			trapFocus
		>
			<Popover.Target>{children as React.ReactElement}</Popover.Target>
			<Popover.Dropdown
				onPointerDown={(event) => event.stopPropagation()}
				onClick={(event) => event.stopPropagation()}
			>
				<Group gap={6} wrap="nowrap" align="flex-end">
					<NumberInput
						size="xs"
						w={130}
						min={1}
						label={labels.timeoutSeconds}
						value={value}
						onChange={setValue}
						onKeyDown={(event) => {
							event.stopPropagation();
							if (event.key === "Enter") commit();
						}}
					/>
					<Button size="compact-xs" onClick={commit}>
						{labels.timeoutUpdate}
					</Button>
				</Group>
			</Popover.Dropdown>
		</Popover>
	);
}

/**
 * The header's interactive timing slot: the duration/elapsed text, the optional
 * `/ timeout` suffix, a lifecycle breakdown popover, and (for a running call with
 * an editable timeout) the timeout editor.
 *
 * Pointer routing copies the chunked control: a MOUSE click on the text opens the
 * timeout editor when one is available (the common case for a running bash),
 * while touch — which has no hover affordance for the breakdown — opens the
 * breakdown instead. Every handler stops propagation, otherwise the click would
 * also toggle the card and be swallowed by the row's selection gestures.
 *
 * Exported so RenderSubagent can reuse the identical control in its header and
 * recent-call rows, exactly as SubagentCard reuses ToolCallCard's.
 */
export function ToolTimingArea({
	running,
	startedAt,
	durationMs,
	timeoutMs,
	timing,
	labels,
	onUpdateTimeout,
}: {
	running: boolean;
	startedAt?: number | null;
	durationMs?: number | null;
	timeoutMs?: number | null;
	timing?: ToolTimingStamps | null;
	labels?: ToolTimingLabels;
	onUpdateTimeout?: (timeoutMs: number) => void;
}) {
	const merged = labels ?? DEFAULT_TIMING_LABELS;
	const [breakdownOpened, setBreakdownOpened] = useState(false);
	const [editorOpened, setEditorOpened] = useState(false);
	const pointerTypeRef = useRef<string | null>(null);

	const canEditTimeout = running && timeoutMs != null && onUpdateTimeout != null;
	const showBreakdown = hasTimingDetails(timing);

	// A closed editor must not linger once the tool stops running.
	useEffect(() => {
		if (!canEditTimeout) setEditorOpened(false);
	}, [canEditTimeout]);

	const text = (
		<TimingText
			running={running}
			startedAt={startedAt}
			durationMs={durationMs}
			timeoutMs={timeoutMs}
			timeoutInteractive={canEditTimeout}
		/>
	);
	if (!text) return null;
	if (!showBreakdown && !canEditTimeout) return text;

	const startLabel = timing ? earliestToolStartMs(timing) : null;
	const ariaLabel =
		startLabel != null
			? fillLabel(merged.startedAt, "time", formatFullLocaleDateTime(startLabel))
			: merged.title;

	const trigger = (
		<UnstyledButton
			type="button"
			aria-label={ariaLabel}
			style={{
				display: "inline-flex",
				alignItems: "center",
				flexShrink: 0,
				font: "inherit",
				color: "inherit",
				padding: 0,
				margin: 0,
				cursor: "pointer",
			}}
			onPointerDown={(event: React.PointerEvent) => {
				event.stopPropagation();
				pointerTypeRef.current = event.pointerType;
			}}
			onPointerCancel={(event: React.PointerEvent) => {
				event.stopPropagation();
				pointerTypeRef.current = null;
			}}
			onKeyDown={(event: React.KeyboardEvent) => event.stopPropagation()}
			onClick={(event: React.MouseEvent) => {
				event.stopPropagation();
				const pointerType = pointerTypeRef.current;
				pointerTypeRef.current = null;
				if (pointerType === "mouse" && canEditTimeout) {
					setBreakdownOpened(false);
					setEditorOpened(true);
					return;
				}
				if (showBreakdown) setBreakdownOpened((open) => !open);
			}}
		>
			{text}
		</UnstyledButton>
	);

	const withBreakdown = showBreakdown ? (
		<Popover
			opened={breakdownOpened}
			onChange={setBreakdownOpened}
			position="top"
			withArrow
			withinPortal
			shadow="md"
		>
			<Popover.Target>{trigger}</Popover.Target>
			<Popover.Dropdown
				onPointerDown={(event) => event.stopPropagation()}
				onClick={(event) => event.stopPropagation()}
			>
				<ToolTimingBreakdown
					timing={timing as ToolTimingStamps}
					displayDurationMs={durationMs}
					labels={merged}
				/>
			</Popover.Dropdown>
		</Popover>
	) : (
		trigger
	);

	if (!canEditTimeout || timeoutMs == null || onUpdateTimeout == null) return withBreakdown;
	return (
		<TimeoutEditor
			timeoutMs={timeoutMs}
			opened={editorOpened}
			onOpenedChange={setEditorOpened}
			onCommit={onUpdateTimeout}
			labels={merged}
		>
			<span style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
				{withBreakdown}
			</span>
		</TimeoutEditor>
	);
}

/**
 * 12px status glyph — parity with ToolCallCard.StatusIcon: a spinning loader
 * while running/initializing, a check on success, an X on fail, a ban on
 * cancelled, and a small dot while pending. Height-neutral (fixed 12px slot).
 */
function StatusGlyph({ status, color }: { status: ToolCallStatus; color: string }) {
	const c = cssColor(color, 6);
	switch (status) {
		case "pending":
		case "running":
		case "initializing":
			return <IconLoader2 size={12} color={c} className="vlist-spin" />;
		case "success":
			return <IconCheck size={12} color={c} />;
		case "fail":
			return <IconX size={12} color={c} />;
		case "cancelled":
			return <IconBan size={12} color={c} />;
		default:
			return (
				<span
					style={{
						width: 8,
						height: 8,
						borderRadius: "50%",
						background: c,
						display: "inline-block",
					}}
				/>
			);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail region.
// ─────────────────────────────────────────────────────────────────────────────
/** Structured badge chip shape carried on the badge header block's data. */
interface StructBadge {
	label: string;
	color?: string;
}

/** Read the render-only badge list off a fixed badge-header block. */
function readBadges(data: Record<string, unknown> | undefined): StructBadge[] {
	if (!data || !Array.isArray(data.badges)) return [];
	const out: StructBadge[] = [];
	for (const b of data.badges as unknown[]) {
		const o = b as { label?: unknown; color?: unknown };
		if (typeof o?.label === "string") {
			out.push({ label: o.label, color: typeof o.color === "string" ? o.color : undefined });
		}
	}
	return out;
}

/** Read the render-only progress descriptor off a fixed progress-row block. */
function readProgress(data: Record<string, unknown> | undefined): ToolRowProgress | null {
	if (!data?.progress || typeof data.progress !== "object") return null;
	const p = data.progress as Record<string, unknown>;
	// `ratio` must be an explicit number to fill the bar; anything else (including
	// a missing field) is INDETERMINATE, which renders as an animated bar rather
	// than as 0% — a bar stuck at zero reads as a stalled transfer.
	const ratio = typeof p.ratio === "number" && Number.isFinite(p.ratio) ? p.ratio : null;
	return {
		ratio,
		...(typeof p.percent === "number" && Number.isFinite(p.percent) ? { percent: p.percent } : {}),
		...(Array.isArray(p.figures)
			? { figures: p.figures.filter((f): f is string => typeof f === "string") }
			: {}),
		...(typeof p.color === "string" ? { color: p.color } : {}),
		...(p.active === true ? { active: true } : {}),
	};
}

/**
 * A determinate (or animated indeterminate) progress bar on a meta row.
 *
 * The percent sits beside the track rather than above it so the whole control
 * fits the single fixed row the measure layer reserved (META_PROGRESS_ROW).
 */
function MetaProgress({ progress }: { progress: ToolRowProgress }) {
	const ratio = progress.ratio;
	const indeterminate = ratio === null;
	const color = progress.color ?? "blue";
	return (
		<Group gap={6} wrap="nowrap" style={{ alignItems: "center", width: "100%" }}>
			<Progress
				value={indeterminate ? 100 : Math.min(100, Math.max(0, ratio * 100))}
				color={color}
				size="sm"
				radius="xl"
				// Stripes animate while work continues. An indeterminate bar MUST animate:
				// it is painted full-width, so without motion it would claim completion.
				striped={indeterminate || progress.active === true}
				animated={indeterminate || progress.active === true}
				style={{ flex: 1, minWidth: 0 }}
				aria-label="progress"
			/>
			<Text size="xs" c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
				{progress.percent != null ? `${progress.percent}%` : "—"}
			</Text>
		</Group>
	);
}

/** Read the render-only action list off a fixed action-row block. */
function readActions(data: Record<string, unknown> | undefined): ToolRowAction[] {
	if (!data || !Array.isArray(data.actions)) return [];
	const out: ToolRowAction[] = [];
	for (const a of data.actions as unknown[]) {
		const o = a as { kind?: unknown; value?: unknown };
		if ((o?.kind === "download" || o?.kind === "copy") && typeof o.value === "string") {
			out.push({ kind: o.kind, value: o.value });
		}
	}
	return out;
}

/** Status glyph + tint for a spec task (parity with SPEC_TASK_STATUS_ICON). */
const SPEC_TASK_GLYPH: Record<string, { Icon: ComponentType<IconProps>; color: string }> = {
	done: { Icon: IconCheck, color: "green" },
	doing: { Icon: IconPlayerPlay, color: "blue" },
	blocked: { Icon: IconBan, color: "orange" },
	todo: { Icon: IconChevronRight, color: "yellow" },
};

/**
 * One spec-task row's leading lane: status icon plus, for a protected task, the
 * lock glyph.
 *
 * The lane is `SPEC_TASK_INDENT` wide (+ `SPEC_TASK_LOCK_LANE` when locked), and
 * the measure layer folded exactly that into the row's `contentLeft`. Pinning the
 * width here rather than letting the Group shrink-wrap is what keeps the two in
 * step: a wider intrinsic lane would overlap the text the measure pass placed.
 *
 * `live` is what makes a `doing` row animate, and it is false for every card but
 * one. A task board is a SNAPSHOT: each `spec://tasks.json` write keeps whatever
 * was in progress at the time, so spinning on the status alone set every
 * historical card spinning (chunked `SpecTasksDetail` gates the same spinner on
 * `isThinking && isLatestTasksCard`). A live row also becomes a LOADER — a
 * spinning play triangle reads as a control, not as work in flight.
 */
function SpecTaskIcon({
	status,
	protectedTask,
	live,
}: {
	status: string;
	protectedTask: boolean;
	live: boolean;
}) {
	const entry = SPEC_TASK_GLYPH[status] ?? SPEC_TASK_GLYPH.todo;
	const spinning = live && status === "doing";
	const Icon = spinning ? IconLoader2 : entry.Icon;
	return (
		<Group
			gap={SPEC_TASK_LOCK_GAP}
			wrap="nowrap"
			style={{
				alignItems: "center",
				width: SPEC_TASK_INDENT + (protectedTask ? SPEC_TASK_LOCK_LANE : 0),
			}}
		>
			<ThemeIcon size={SPEC_TASK_ICON} variant="light" color={entry.color} radius="xl">
				<Icon size={10} className={spinning ? "vlist-spin" : undefined} />
			</ThemeIcon>
			{protectedTask ? (
				<IconLock
					size={SPEC_TASK_LOCK}
					color="var(--mantine-color-yellow-6)"
					style={{ flexShrink: 0 }}
				/>
			) : null}
		</Group>
	);
}

/**
 * Empty task document placeholder (`{ tasks: [] }`) — the chunked card's bordered
 * "task list is empty" row, drawn at the height `SPEC_TASK_EMPTY_HEIGHT` reserved.
 */
function SpecTasksEmpty({ height, label }: { height: number; label: string }) {
	return (
		<Paper withBorder radius="sm" px="sm" style={{ height, boxSizing: "border-box" }}>
			<Group gap={6} wrap="nowrap" h="100%">
				<ThemeIcon size={SPEC_TASK_ICON} variant="light" color="gray" radius="xl">
					<IconListCheck size={10} />
				</ThemeIcon>
				<Text size="xs" c="dimmed" fs="italic">
					{label}
				</Text>
			</Group>
		</Paper>
	);
}

/** Resolved label bundle the detail renderers need. */
type DetailLabels = Required<
	Pick<
		ToolCallLabels,
		"input" | "output" | "planSource" | "download" | "copy" | "copied" | "tasksEmpty"
	>
> & { sections?: Partial<Record<ToolSectionLabel, string>> };

/** Localized section-label text (injected bundle wins over the English default). */
function sectionLabelText(labels: DetailLabels, label: ToolSectionLabel): string {
	return labels.sections?.[label] ?? DEFAULT_SECTION_LABELS[label];
}

/** Action controls on a meta row: the share card's download + copy-link buttons. */
function MetaActions({ actions, labels }: { actions: ToolRowAction[]; labels: DetailLabels }) {
	return (
		<Group gap="xs" wrap="nowrap" style={{ height: "100%", alignItems: "center" }}>
			{actions.map((action) =>
				action.kind === "download" ? (
					<Button
						key={`download-${action.value}`}
						component="a"
						href={action.value}
						size="xs"
						variant="light"
						color="green"
						leftSection={<IconDownload size={14} />}
					>
						{labels.download}
					</Button>
				) : (
					<CopyButton key={`copy-${action.value}`} value={action.value} timeout={2000}>
						{({ copied, copy }) => (
							<Button
								size="xs"
								variant="subtle"
								color={copied ? "teal" : "gray"}
								leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
								onClick={copy}
							>
								{copied ? labels.copied : labels.copy}
							</Button>
						)}
					</CopyButton>
				),
			)}
		</Group>
	);
}

/**
 * Resolve the Shiki language for a detail body from its render-only hints.
 *
 * `shared/pretext-layout` cannot import `getShikiLang` (frontend module, purity
 * guard), so it hands over either an explicit language id or the raw file path;
 * the extension → language mapping happens here.
 */
function resolveDetailLang(
	data: { codeLang?: string; codeLangPath?: string } | undefined,
): string | undefined {
	if (!data) return undefined;
	if (typeof data.codeLang === "string" && data.codeLang) return data.codeLang;
	if (typeof data.codeLangPath === "string" && data.codeLangPath) {
		const lang = getShikiLang(data.codeLangPath);
		return lang === "text" ? undefined : lang;
	}
	return undefined;
}

/**
 * A syntax-highlighted `pre-wrap` body. Colours only: the spans inherit the box's
 * font and white-space, so the BROWSER wraps exactly as it does for plain text and
 * the measured box height stays correct. Falls back to the raw text whenever
 * tokens are unavailable.
 */
function HighlightedBody({ text, lang }: { text: string; lang: string | undefined }) {
	const tokens = useShikiTokens(text, lang);
	return <TokenFlowText text={text} tokens={tokens} />;
}

/**
 * Test-only handle on the timing breakdown body. Mantine's Popover dropdown is
 * portaled and only mounts while open, so a static render of the header cannot
 * reach the breakdown — exported so RenderToolCall.timing.test.tsx can assert the
 * phase rows and summary lines directly.
 */
export const __TEST__ToolTimingBreakdown = ToolTimingBreakdown;

/**
 * Absolutely-positioned blocks for the pretext-measured detail kinds
 * (meta-rows / structured entries / spec-tasks / error). Shared by the top-level
 * region and the per-section path.
 */
function DetailBlocks({
	kind,
	blocks,
	frames,
	availableWidth,
	height,
	labels,
	narratorId,
	specTasksLive,
}: {
	kind: MeasuredToolBody["kind"];
	blocks: MeasuredToolBody["blocks"];
	frames: readonly BlockFrame[];
	availableWidth: number;
	height: number;
	labels: DetailLabels;
	narratorId?: string;
	/** This card is the newest task board of a RUNNING narrator (see SpecTaskIcon). */
	specTasksLive?: boolean;
}) {
	void narratorId;
	// `c="red"`: red-4 on dark, red-filled on light (red-4 washes out on white).
	const color = kind === "error" ? "var(--mantine-color-red-text)" : undefined;
	const isSpecTasks = kind === "spec-tasks";
	const isError = kind === "error";
	return (
		<div style={{ position: "relative", width: availableWidth, height }}>
			{blocks.map((block, index) => {
				const bf = frames[index];
				if (!bf) return null;
				if (block.kind === "inline") {
					const data = block.data ?? {};
					const taskStatus = isSpecTasks && typeof data.status === "string" ? data.status : null;
					const iconSlot = taskStatus ? (
						<div style={{ position: "absolute", left: 0, top: 0, height: block.lineHeight }}>
							<div style={{ display: "flex", alignItems: "center", height: block.lineHeight }}>
								<SpecTaskIcon
									status={taskStatus}
									protectedTask={data.protected === true}
									live={specTasksLive === true}
								/>
							</div>
						</div>
					) : null;
					// A row/entry whose text is a link paints an anchor overlay so the
					// measured line geometry stays authoritative.
					const href = typeof data.href === "string" ? data.href : null;
					const dimmed = data.dimmed === true;
					// A warning-toned error line is a DENIED PLAN's reviewer feedback: the
					// user's own note back to the model, not a tool failure. The chunked
					// PlanDetail paints it yellow, so red here would misreport it as an
					// error while showing the identical text.
					const toneColor =
						isError && data.tone === "warning" ? "var(--mantine-color-yellow-text)" : color;
					const lineColor =
						taskStatus === "done" || dimmed ? "var(--mantine-color-dimmed)" : toneColor;
					return (
						<InlineLines
							// biome-ignore lint/suspicious/noArrayIndexKey: blocks are a stable ordered list
							key={index}
							block={block}
							frame={bf}
							availableWidth={availableWidth}
							color={href ? "var(--mantine-color-teal-text)" : lineColor}
							leadingSlot={iconSlot}
							href={href}
						/>
					);
				}
				// An empty task document reserves one bordered placeholder row. Without
				// this branch the reserved box painted nothing, so a `{ tasks: [] }`
				// write showed as a blank gap under the header.
				if (block.kind === "fixed" && block.tag === "detail-spec-empty") {
					return (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: blocks are a stable ordered list
							key={index}
							style={{
								position: "absolute",
								top: bf.top,
								left: 0,
								width: availableWidth,
								height: bf.height,
							}}
						>
							<SpecTasksEmpty height={bf.height} label={labels.tasksEmpty} />
						</div>
					);
				}
				// Only fixed blocks carry the render-only badge / action / snippet data.
				const data = block.kind === "fixed" ? (block.data ?? {}) : {};
				const badges = readBadges(data);
				const actions = readActions(data);
				const progress = readProgress(data);
				const figures =
					block.kind === "fixed" && block.tag === "detail-meta-progress-figures"
						? (Array.isArray(data.figures) ? data.figures : []).filter(
								(f): f is string => typeof f === "string",
							)
						: [];
				const snippet =
					block.kind === "fixed" &&
					block.tag === "detail-entry-snippet" &&
					typeof data.text === "string"
						? data.text
						: null;
				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: blocks are a stable ordered list
						key={index}
						style={{
							position: "absolute",
							top: bf.top,
							left: 0,
							width: availableWidth,
							height: bf.height,
							overflow: "hidden",
						}}
					>
						{badges.length > 0 ? (
							<Group gap={4} wrap="wrap" style={{ alignItems: "center" }}>
								{badges.map((b, i) => (
									<Badge
										// biome-ignore lint/suspicious/noArrayIndexKey: badges are a stable ordered list
										key={i}
										size="xs"
										variant="light"
										color={b.color ?? "gray"}
									>
										{b.label}
									</Badge>
								))}
							</Group>
						) : null}
						{progress ? <MetaProgress progress={progress} /> : null}
						{figures.length > 0 ? (
							<Text size="xs" c="dimmed" ff="monospace" style={{ whiteSpace: "nowrap" }}>
								{figures.join("  ·  ")}
							</Text>
						) : null}
						{actions.length > 0 ? <MetaActions actions={actions} labels={labels} /> : null}
						{snippet != null ? (
							<Text
								size="xs"
								c="dimmed"
								lineClamp={ENTRY_SNIPPET_MAX_LINES}
								style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
							>
								{snippet}
							</Text>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

/**
 * A radio circle / checkbox square in the option's reserved indent lane, filled
 * when the submitted answer selected it. Purely decorative (aria-hidden): the
 * option text itself carries the meaning, and this is a read-only replay of a
 * decision the user already made.
 */
function AskOptionControl({
	control,
	selected,
	lineHeight,
}: {
	control: "checkbox" | "radio";
	selected: boolean;
	lineHeight: number;
}) {
	const size = OPTION_CONTROL_SIZE;
	return (
		<div
			aria-hidden
			style={{
				position: "absolute",
				left: 0,
				top: Math.max(0, (lineHeight - size) / 2),
				width: size,
				height: size,
				boxSizing: "border-box",
				borderRadius: control === "radio" ? size : "var(--mantine-radius-default)",
				border: selected
					? "1px solid var(--mantine-color-teal-filled)"
					: "1px solid var(--mantine-color-gray-6)",
				background: selected ? "var(--mantine-color-teal-filled)" : "transparent",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			{selected ? <IconCheck size={12} color="var(--mantine-color-white)" /> : null}
		</div>
	);
}

/**
 * Read-only AskUserQuestion replay: the completed question banner, drawn at the
 * measured geometry.
 *
 * Shared by BOTH detail paths — the top-level `DetailRegion` and the per-section
 * `SectionBody` (a denied/skipped question is wrapped into a `sections` detail
 * alongside its error line). Routing it explicitly in both places is required:
 * the generic `DetailBlocks` fallthrough ignores the `role` / `control` /
 * `selected` data these blocks carry, which would silently degrade the card to a
 * run of bare text lines at the correct height.
 */
function AskDetailBlocks({
	blocks,
	frames,
	availableWidth,
	height,
}: {
	blocks: MeasuredToolBody["blocks"];
	frames: readonly BlockFrame[];
	availableWidth: number;
	height: number;
}) {
	return (
		<div style={{ position: "relative", width: availableWidth, height }}>
			{blocks.map((block, index) => {
				const bf = frames[index];
				if (!bf || block.kind !== "inline") return null;
				const data = block.data ?? {};
				const role = typeof data.role === "string" ? data.role : "";
				const selected = data.selected === true;
				const control = data.control === "checkbox" ? "checkbox" : "radio";
				const leadingSlot =
					role === "ask-option-label" ? (
						<AskOptionControl control={control} selected={selected} lineHeight={block.lineHeight} />
					) : null;
				return (
					<InlineLines
						// biome-ignore lint/suspicious/noArrayIndexKey: blocks are a stable ordered list
						key={index}
						block={block}
						frame={bf}
						availableWidth={availableWidth}
						color={askRoleColor(role, selected)}
						leadingSlot={leadingSlot}
					/>
				);
			})}
		</div>
	);
}

/** Text colour per ask-replay row role (mirrors the classic banner's tints). */
function askRoleColor(role: string, selected: boolean): string | undefined {
	switch (role) {
		case "ask-option-desc":
			return "var(--mantine-color-dimmed)";
		case "ask-answer":
		case "ask-custom-answer":
			// `c="teal"` equivalent: teal-4 on dark, teal-filled on light.
			return "var(--mantine-color-teal-text)";
		case "ask-option-label":
			return selected ? "var(--mantine-color-text)" : "var(--mantine-color-dimmed)";
		default:
			return undefined;
	}
}

function DetailRegion({
	detail,
	availableWidth,
	labels,
	narratorId,
	viewTargets,
	viewControls,
	specTasksLive,
}: {
	detail: MeasuredToolDetail;
	availableWidth: number;
	labels: DetailLabels;
	narratorId?: string;
	viewTargets?: readonly VListViewTarget[];
	viewControls?: VListViewControls;
	specTasksLive?: boolean;
}) {
	return (
		<div style={{ position: "relative", width: availableWidth, height: detail.height }}>
			{detail.sections.map((section) => (
				<Fragment key={section.key}>
					{section.label ? (
						<Text
							size="xs"
							fw={500}
							style={{
								position: "absolute",
								top: section.top,
								left: 0,
								width: availableWidth,
								height: typographyMetrics().line.xs,
							}}
						>
							{sectionLabelText(labels, section.label)}
						</Text>
					) : null}
					<div
						style={{
							position: "absolute",
							top: section.bodyTop,
							left: 0,
							width: availableWidth,
							height: section.bodyHeight,
						}}
					>
						<RenderToolBody
							measured={section.measuredBody}
							labels={labels}
							narratorId={narratorId}
							viewTarget={
								section.measuredBody.model.kind === "capped"
									? findViewTarget(viewTargets, section.measuredBody.model.source)
									: undefined
							}
							viewControls={viewControls}
							specTasksLive={specTasksLive}
						/>
					</div>
				</Fragment>
			))}
		</div>
	);
}

/** One dispatch over the original model; measurement only supplies local geometry. */
export function RenderToolBody({
	measured,
	labels = DEFAULT_LABELS,
	narratorId,
	viewTarget,
	viewControls,
	specTasksLive,
}: {
	measured: MeasuredToolBody;
	labels?: DetailLabels;
	narratorId?: string;
	viewTarget?: VListViewTarget;
	viewControls?: VListViewControls;
	specTasksLive?: boolean;
}) {
	const { model, blocks, frame, contentWidth, height, appliedCap } = measured;
	if (model.kind === "ask")
		return (
			<AskDetailBlocks
				blocks={blocks}
				frames={frame.blocks}
				availableWidth={contentWidth}
				height={height}
			/>
		);
	if (model.kind !== "capped")
		return (
			<DetailBlocks
				kind={model.kind}
				blocks={blocks}
				frames={frame.blocks}
				availableWidth={contentWidth}
				height={height}
				labels={labels}
				specTasksLive={specTasksLive}
			/>
		);
	if (model.format === "media") {
		const block = blocks[0];
		return model.media ? (
			<VListImage
				media={model.media}
				narratorId={narratorId}
				maxHeight={height}
				{...(block?.kind === "fixed" ? readExactDisplayBox(block.data) : null)}
			/>
		) : null;
	}
	const wordWrap = viewTarget ? viewControls?.isWrapped(viewTarget) !== false : true;
	const showSource = !!viewTarget && viewControls?.isSourceShown(viewTarget) === true;
	const isMarkdown = model.format === "markdown";
	const sourceIndex = blocks.findIndex(
		(block) => block.kind === "fixed" && block.tag === "detail-plan-source",
	);
	const sourceFrame = sourceIndex >= 0 ? frame.blocks[sourceIndex] : undefined;
	return (
		<VListContentViewHost target={viewTarget} controls={viewControls}>
			{(onReaderProgress) => (
				<AutoFollowScroll
					bodyId={model.id}
					live={model.live}
					revision={model.revision}
					followTarget={model.followTarget.kind === "diff-row" ? "row" : "end"}
					layout={model.format === "diff" ? { width: contentWidth, height } : undefined}
					contentPadding={
						model.format === "diff"
							? { x: DETAIL_BOX_PADDING_X, y: DETAIL_BOX_PADDING_Y }
							: undefined
					}
					onReaderProgress={onReaderProgress}
					viewportStyle={{
						height,
						maxHeight: appliedCap ?? undefined,
						overflowX: wordWrap || (isMarkdown && !showSource) ? "hidden" : "auto",
						boxSizing: "border-box",
						background: "var(--vlist-detail-panel-bg)",
						borderRadius: 4,
					}}
					contentStyle={{
						padding: `${DETAIL_BOX_PADDING_Y}px ${DETAIL_BOX_PADDING_X}px`,
						boxSizing: "border-box",
						fontSize: detailBodyFontSize(),
						lineHeight: `${detailContentLineHeight()}px`,
						fontFamily: "var(--mantine-font-family-monospace)",
						color: "var(--vlist-detail-panel-fg)",
						...(wordWrap
							? { whiteSpace: "pre-wrap", wordBreak: "break-word" }
							: { whiteSpace: "pre" }),
					}}
				>
					{model.format === "diff" ? (
						<DiffContent
							document={model.diffDocument}
							language={resolveDetailLang(model)}
							wordWrap={wordWrap}
							contentWidth={contentWidth - DETAIL_BOX_PADDING_X * 2}
						/>
					) : isMarkdown && !showSource ? (
						<div data-tool-markdown style={{ position: "relative", width: contentWidth }}>
							{model.sourcePath && sourceFrame ? (
								<Text
									size="xs"
									c="dimmed"
									ff="monospace"
									truncate
									title={model.sourcePath}
									style={{
										position: "absolute",
										top: sourceFrame.top,
										left: 0,
										width: contentWidth,
										height: sourceFrame.height,
									}}
								>
									{formatPlanSource(labels.planSource, model.sourcePath)}
								</Text>
							) : null}
							<RenderMarkdown
								measured={{
									height: frame.contentHeight,
									blocks,
									frame,
									contentWidth,
									usedWidth: frame.usedWidth,
								}}
							/>
						</div>
					) : (
						<HighlightedBody
							text={model.text ?? ""}
							lang={showSource ? undefined : resolveDetailLang(model)}
						/>
					)}
				</AutoFollowScroll>
			)}
		</VListContentViewHost>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Single tool card.
// ─────────────────────────────────────────────────────────────────────────────
export interface RenderToolCallProps {
	measured: MeasuredToolCall;
	labels?: ToolCallLabels;
	/** Category-icon override (the real icon set lives outside vlist/). */
	icon?: ComponentType<IconProps>;
	/** Panel narrator id — forwarded to the detail region so media loads images. */
	narratorId?: string;
	/** Toggle expand/collapse (header click). */
	onToggle?: () => void;
	/**
	 * Terminate the running tool. Supplied by the integration layer for bash / MCP
	 * cards (the chunked header's InlineTerminateControl equivalent).
	 */
	onTerminate?: () => void;
	/**
	 * Commit a new timeout for a RUNNING call (the chunked TimeoutEditorPopover
	 * equivalent). The `update_timeout` WS message lives outside vlist/, so the
	 * integration layer supplies the sender; absent → the timeout is read-only.
	 */
	onUpdateTimeout?: (timeoutMs: number) => void;
	/** Permission approve/deny (forwarded to RenderInlinePermission). */
	onPermissionAllow?: () => void;
	onPermissionDeny?: () => void;
	/**
	 * Live permission form node (real InlinePermission / AskUserQuestionBanner)
	 * injected by the integration layer for a pending-permission card. When set,
	 * the expanded body renders it in place of the zero-DOM RenderInlinePermission
	 * copy; its height is corrected after paint via the shell's onUnknownHeight.
	 */
	permissionSlot?: ReactNode;
	/**
	 * Manual takeover of a RUNNING reflection gate (stop it and decide yourself).
	 * The API call lives outside vlist/, so the integration layer supplies it; the
	 * notice itself is measured + rendered on the pure path.
	 */
	onReflectionTakeOver?: () => void;
	/** Whether a takeover request is in flight (button shows a loader). */
	reflectionTakingOver?: boolean;
	/**
	 * Fullscreen-viewer wiring for this card's detail bodies.
	 *
	 * `viewTargets` is the ordered body list the shell derived from this measured
	 * card (`resolveToolDetailViewTargets`), positionally aligned with the detail's
	 * sections / blocks; `viewControls` owns the per-body wrap + source state and
	 * opens the shell's single modal. Both absent → the bodies render exactly as
	 * before, with no action bar (the pre-viewer behaviour).
	 *
	 * Height-neutral: the action bar is a zero-height absolute overlay and wrap
	 * only changes `white-space` inside an already fixed-height scrolling box.
	 */
	viewTargets?: readonly VListViewTarget[];
	viewControls?: VListViewControls;
	/**
	 * This card is the newest `spec://tasks.json` board AND the narrator is running,
	 * so its in-progress row is describing live work and may animate.
	 *
	 * Absent everywhere else on purpose: a task board is a snapshot, so animating on
	 * the recorded `doing` status alone set every historical card spinning. See
	 * `SpecTaskIcon`. Height-neutral (a glyph swap inside a reserved lane).
	 */
	specTasksLive?: boolean;
}

/** How long a one-shot outcome sweep stays mounted (600ms animation + a margin). */
const OUTCOME_FLASH_MS = 650;

/**
 * Resolve the sweep-shimmer class for a card: neutral while its input streams,
 * PURPLE while a reflection gate deliberates, blue while it executes, and a
 * one-shot green / red pass as it settles.
 *
 * The state decision lives in `@shared/tool-shimmer` because four surfaces make it
 * (both card paths and both folded-row paths) and they cannot share components.
 * Notably it is what fixed the reflecting case: a gate parks its tool at `pending`,
 * so asking `isRunningStatus` first painted a deliberating card BLUE — claiming
 * execution that had not started.
 *
 * The closing flash is a timed transition, so it needs component state: we track the
 * previous status and fire only on an observed in-flight → terminal flip. Unlike
 * ToolCallCard we have no startedAt/durationMs to consult here, so a fresh mount
 * (prev === null) never fires — that keeps scrolling through history quiet while
 * still animating real live completions.
 */
function useToolCardShimmerClass(
	status: ToolCallStatus,
	isStreaming: boolean,
	hasPermission: boolean,
	reflectionStatus: string | null,
): string | undefined {
	const prevStatusRef = useRef<ToolCallStatus | null>(null);
	const [flash, setFlash] = useState<ToolShimmerFlash | null>(null);
	useEffect(() => {
		const prev = prevStatusRef.current;
		prevStatusRef.current = status;
		const next = resolveToolShimmerFlash(prev, status);
		// ⚠️ A transition with no flash CLEARS the stored one; it must not just bail.
		// The 650ms timer is torn down by this effect's own cleanup, so a flash that
		// the live `phase` below outranked (a retry inside the window: running → fail
		// → running) survived and replayed on the NEXT quiet status — a red sweep on
		// `cancelled`, which must never flash, or a green one on a card sitting on an
		// approve/deny form.
		if (!next) {
			setFlash(null);
			return;
		}
		setFlash(next);
		const timer = setTimeout(() => setFlash(null), OUTCOME_FLASH_MS);
		return () => clearTimeout(timer);
	}, [status]);

	// A live phase outranks the closing flash: if a call went straight back to work
	// (a retry landing within the flash window) the current activity is the truer
	// thing to show.
	const phase = resolveToolShimmerPhase({
		isStreaming,
		status,
		reflectionStatus,
		hasPendingPermission: hasPermission,
	});
	if (phase) return CARD_SHIMMER_CLASS[phase];
	if (flash) return CARD_SHIMMER_CLASS[flash];
	return undefined;
}

export function RenderToolCall({
	measured,
	labels,
	icon,
	narratorId,
	onToggle,
	onTerminate,
	onUpdateTimeout,
	onPermissionAllow,
	onPermissionDeny,
	permissionSlot,
	onReflectionTakeOver,
	reflectionTakingOver,
	viewTargets,
	viewControls,
	specTasksLive,
}: RenderToolCallProps) {
	const merged = { ...DEFAULT_LABELS, ...labels };
	const {
		contentWidth,
		effectiveOpened,
		detail,
		permission,
		reflection,
		hasBorder,
		inRun,
		isLast,
		isStreaming,
		category,
		status,
	} = measured;
	// `reflection?.status` is what turns a deliberating gate purple instead of blue.
	// It is reliably present when it matters: a running gate parks its tool at
	// `pending`, which makes the card `lodExempt` → always measured expanded, and the
	// reflection notice is only measured inside that expanded branch.
	const shimmerClass = useToolCardShimmerClass(
		status,
		isStreaming,
		permission != null,
		reflection?.status ?? null,
	);
	const borderColor =
		permission != null
			? cssColor("yellow", 6)
			: status === "fail"
				? cssColor("red", 7)
				: status === "cancelled"
					? cssColor("orange", 7)
					: status === "running"
						? cssColor("blue", 7)
						: undefined;

	// A live form stays visible on a folded card, but it must not force the
	// measured command/output body, or the measured permission/reflection copy,
	// open. A reflection notice still replaces the permission area
	// (ToolCallCard.tsx:5419). The shell post-paints the slot.
	const liveSlot = reflection ? null : (permissionSlot ?? null);
	const measuredSlot = reflection ? (
		<RenderReflectionNotice
			measured={reflection}
			labels={merged.reflection}
			includeTopMargin
			onTakeOver={onReflectionTakeOver}
			takingOver={reflectionTakingOver}
		/>
	) : !permissionSlot && permission ? (
		<RenderInlinePermission
			measured={permission}
			labels={merged.permission}
			includeTopMargin
			onAllow={onPermissionAllow}
			onDeny={onPermissionDeny}
		/>
	) : null;
	const body = (
		<>
			<ToolHeaderRow
				toolName={measured.toolName}
				summary={measured.summary}
				category={category}
				status={status}
				diffStats={measured.diffStats}
				isRemoteTarget={measured.isRemoteTarget}
				remoteLabel={merged.remote}
				isTakenOver={measured.isTakenOver}
				takenOverLabel={merged.takenOver}
				opened={effectiveOpened}
				onToggle={onToggle}
				icon={icon ?? categoryIcon(category, measured.toolName)}
				durationMs={measured.displayDurationMs}
				startedAt={measured.startedAt}
				timeoutMs={measured.timeoutMs}
				timing={measured.timing}
				timingLabels={merged.timing}
				onUpdateTimeout={onUpdateTimeout}
				onTerminate={onTerminate}
				terminateLabel={merged.terminate}
			/>
			{effectiveOpened && detail ? (
				<Box mt={DETAIL_TOP_MARGIN} style={{ position: "relative" }}>
					{/* The detail region's own top block already carries the mt gap,
					    so we render it flush and let its frame own the spacing. */}
					<div style={{ marginTop: -DETAIL_TOP_MARGIN }}>
						<DetailRegion
							detail={detail}
							availableWidth={contentWidth}
							labels={merged}
							narratorId={narratorId}
							viewTargets={viewTargets}
							viewControls={viewControls}
							specTasksLive={specTasksLive}
						/>
					</div>
				</Box>
			) : null}
			{/* A reflection notice REPLACES the permission area (chunked precedence,
			    ToolCallCard.tsx:5419). It is fully MEASURED, so it renders on the
			    pure path — no slot, no post-paint height correction. */}
			{effectiveOpened ? measuredSlot : null}
			{liveSlot}
		</>
	);

	// In a run: no border, a trailing divider unless last. The shimmer overlay
	// sits on the inner padded box (not the outer wrapper) so the divider stays
	// outside the `overflow: hidden` sweep — mirrors ToolCallCard :6100.
	if (inRun) {
		return (
			<Box>
				<Box p="xs" className={shimmerClass} style={{ boxSizing: "border-box" }}>
					{body}
				</Box>
				{!isLast ? <Divider color="var(--mantine-color-default-border)" size={1} /> : null}
			</Box>
		);
	}

	// Standalone: bordered Paper.
	return (
		<Paper
			// The drill morph fades this element's BORDER COLOUR (a folded row has no border,
			// so it has to arrive and leave rather than travel). Marked rather than found by
			// tag so the fade cannot silently retarget if the card's markup changes.
			data-nf-card-surface
			withBorder={hasBorder}
			radius="sm"
			p="xs"
			className={shimmerClass}
			style={{
				backgroundColor: "color-mix(in srgb, var(--mantine-color-body) 50%, transparent)",
				boxSizing: "border-box",
				...(borderColor ? { borderColor } : {}),
			}}
		>
			{body}
		</Paper>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouped card.
// ─────────────────────────────────────────────────────────────────────────────
export interface RenderToolCallGroupProps {
	measured: MeasuredToolCallGroup;
	/** Group label (unique tool names joined; injected by the dispatch layer). */
	label?: string;
	/** Category-icon override for the header + children. */
	icon?: ComponentType<IconProps>;
	/** Status pill colour + text (resolved upstream from the child statuses). */
	statusColor?: string;
	statusLabel?: string;
	/** Toggle the group body. */
	onToggle?: () => void;
	/** Per-child render props (labels/icons/toggles), indexed by child order. */
	childProps?: (index: number) => Partial<RenderToolCallProps>;
	/** Panel narrator id — forwarded to child cards for media image resolution. */
	narratorId?: string;
	/**
	 * Timing strings for the header's aggregate duration tooltip. Only `startedAt`
	 * is read here; the full bundle is accepted so the dispatch layer can forward
	 * the same object it gives the single card.
	 */
	timingLabels?: ToolTimingLabels;
}

/**
 * The grouped header's aggregate duration.
 *
 * Mirrors ToolCallCard.tsx:5941 — while any child is still in progress the header
 * ticks from the earliest ACTIVE start; once all are done it shows the summed
 * duration. Both forms are tooltipped with the earliest start across all children
 * (`groupStartedAtLabel`, :5936). Renders nothing when there is neither a running
 * child nor any accumulated time, matching the chunked null cases.
 */
function GroupTiming({
	measured,
	labels,
}: {
	measured: MeasuredToolCallGroup;
	labels: ToolTimingLabels;
}) {
	const { totalDurationMs, earliestStartMs, earliestActiveStartMs } = measured;
	const node =
		earliestActiveStartMs != null ? (
			<Text size="xs" c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
				<ElapsedTimer startedAt={earliestActiveStartMs} />
			</Text>
		) : totalDurationMs > 0 ? (
			<Text size="xs" c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
				{formatDurationText(totalDurationMs, { style: "precise" })}
			</Text>
		) : null;
	if (!node) return null;
	if (earliestStartMs == null) return node;
	return (
		<Tooltip
			label={fillLabel(labels.startedAt, "time", formatFullLocaleDateTime(earliestStartMs))}
			position="top"
			withArrow
			fz="xs"
		>
			{node}
		</Tooltip>
	);
}

export function RenderToolCallGroup({
	measured,
	label,
	icon,
	statusColor = "yellow",
	statusLabel = "pending",
	onToggle,
	childProps,
	narratorId,
	timingLabels,
}: RenderToolCallGroupProps) {
	const { expanded, headerHeight, childCount, children, bodyLeft, contentWidth } = measured;
	// Child colour + glyph follow the first child's category (same as chunk mode).
	const firstChild = children[0];
	const groupColor = firstChild ? CATEGORY_COLOR[firstChild.category] : "gray";
	const Icon =
		icon ?? (firstChild ? categoryIcon(firstChild.category, firstChild.toolName) : IconTool);

	return (
		<Paper
			withBorder
			radius="sm"
			p="xs"
			style={{
				backgroundColor: "color-mix(in srgb, var(--mantine-color-body) 50%, transparent)",
				boxSizing: "border-box",
			}}
		>
			<Group
				gap={5}
				wrap="nowrap"
				align="center"
				// Selectable surface: a modified click selects the block (handled by the
				// row's interaction wrapper), only a plain click toggles the group.
				{...{ [TOOL_HEADER_SELECT_ATTR]: "" }}
				style={{
					height: headerHeight,
					cursor: onToggle ? "pointer" : "default",
					userSelect: "none",
				}}
				onClick={onToggle ? swallowSelectionClick(onToggle) : undefined}
			>
				<ThemeIcon size={16} variant="light" color={groupColor} radius="sm">
					<Icon size={10} />
				</ThemeIcon>
				<Text size="xs" fw={600} c="dimmed" style={{ flexShrink: 0 }}>
					{label ?? "Tools"}
				</Text>
				<Badge size="xs" variant="filled" color={groupColor}>
					×{childCount}
				</Badge>
				<Box style={{ flex: 1 }} />
				<Badge size="xs" variant="dot" color={statusColor}>
					{statusLabel}
				</Badge>
				{/* Aggregate timing (chunk parity, ToolCallCard.tsx:5941-5981): a live
				    timer while any child runs, else the summed duration, tooltipped with
				    the earliest start. Shares the fixed header row → height-neutral. */}
				<GroupTiming measured={measured} labels={timingLabels ?? DEFAULT_TIMING_LABELS} />
				{expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
			</Group>
			{expanded ? (
				<Box
					mt={GROUP_BODY_MARGIN_TOP}
					pl={GROUP_BODY_PADDING_LEFT}
					style={{ borderLeft: `${GROUP_BODY_BORDER_LEFT}px solid ${cssColor(groupColor, 4)}` }}
				>
					<div style={{ position: "relative", width: contentWidth - bodyLeft }}>
						{children.map((child, index) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: children are a stable ordered list
								key={index}
								style={{ marginBottom: 0 }}
							>
								<RenderToolCall
									measured={child}
									narratorId={narratorId}
									{...(childProps ? childProps(index) : {})}
								/>
							</div>
						))}
					</div>
				</Box>
			) : null}
		</Paper>
	);
}

export const RENDER_TOOL_CALL_CHROME = {
	CARD_PADDING,
	HEADER_ROW_HEIGHT,
	DETAIL_TOP_MARGIN,
} as const;
