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
import { formatDurationText, formatFullLocaleDateTime } from "@frontend/lib/format";
import { getShikiLang } from "@frontend/lib/shiki-lang";
import type { ShikiToken } from "@frontend/lib/shiki-token-cache";
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
	Stack,
	Text,
	ThemeIcon,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	buildDiffHighlightSource,
	type DiffLine,
	diffLineMarker,
	formatDiffGutter,
} from "@shared/pretext-layout/diff-core";
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
import { useEffect, useMemo, useRef, useState } from "react";
import "../vlist-markdown.css";
import { OPTION_CONTROL_SIZE } from "../measure/measure-permission";
import {
	CARD_PADDING,
	cappedUsefulLines,
	DETAIL_BODY_FONT_SIZE,
	DETAIL_BOX_PADDING_X,
	DETAIL_BOX_PADDING_Y,
	DETAIL_CONTENT_LINE_HEIGHT,
	DETAIL_TOP_MARGIN,
	ENTRY_SNIPPET_MAX_LINES,
	earliestToolStartMs,
	GROUP_BODY_BORDER_LEFT,
	GROUP_BODY_MARGIN_TOP,
	GROUP_BODY_PADDING_LEFT,
	HEADER_ROW_HEIGHT,
	isRunningStatus,
	type MeasuredToolCall,
	type MeasuredToolCallGroup,
	type MeasuredToolDetail,
	type MeasuredToolDetailSection,
	SECTION_LABEL_HEIGHT,
	SPEC_TASK_ICON,
	SPEC_TASK_INDENT,
	SPEC_TASK_LOCK,
	SPEC_TASK_LOCK_GAP,
	SPEC_TASK_LOCK_LANE,
	type ToolCallStatus,
	type ToolCategory,
	type ToolRowAction,
	type ToolSectionLabel,
	type ToolTimingStamps,
	TRUNCATION_NOTICE_MARGIN_TOP,
	XS_LINE_HEIGHT,
} from "../measure/measure-tool-call";
import type { BlockFrame, PreparedInlineBlock } from "../prepared-block";
import { useShikiTokens } from "../useShikiTokens";
import { categoryIcon } from "./category-icons";
import { RenderMarkdown } from "./RenderMarkdown";
import { type InlinePermissionLabels, RenderInlinePermission } from "./RenderPermission";
import { type ReflectionNoticeLabels, RenderReflectionNotice } from "./RenderReflectionNotice";
import { TokenFlowText, TokenText } from "./TokenLines";
import { VListImage, type VListImageRef } from "./vlist-image";

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
	/**
	 * Footer shown when a diff body has more rows than the render layer paints.
	 * Carries a literal `{count}` placeholder (the hidden row count is per body).
	 */
	diffTruncated?: string;
	/** Placeholder line for a valid but EMPTY spec task document. */
	tasksEmpty?: string;
	/**
	 * Truncation notice text. Carries `{{size}}` / `{{count}}` placeholders, filled
	 * in the row. The row is a FIXED single line, so its wording cannot move a
	 * measured height.
	 */
	truncatedPreview?: string;
	truncatedLoading?: string;
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
		| "planSource"
		| "download"
		| "copy"
		| "copied"
		| "terminate"
		| "diffTruncated"
		| "tasksEmpty"
		| "truncatedPreview"
		| "truncatedLoading"
	>
> = {
	input: "Input",
	output: "Output",
	remote: "remote",
	planSource: "Plan from {file}",
	download: "Download",
	copy: "Copy link",
	copied: "Copied",
	terminate: "Terminate",
	diffTruncated: "… {count} more rows not shown",
	tasksEmpty: "Task list is empty",
	truncatedPreview: "Content truncated ({size}) — click to load full data",
	truncatedLoading: "Loading full data ({size})…",
};

/** English fallback used when a diff body is rendered without injected labels. */
const DEFAULT_DIFF_TRUNCATED = DEFAULT_LABELS.diffTruncated;

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
// Category → colour (mirrors ToolCallCard getCategoryColor). Kept local so the
// renderer never imports the heavy ToolCallCard module.
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY_COLOR: Record<ToolCategory, string> = {
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
					{line.fragments.map((frag, fi) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
							key={fi}
							className={frag.className}
							style={{
								font: frag.font,
								marginLeft: frag.gapBefore,
								whiteSpace: "pre",
								display: "inline-block",
								color,
							}}
						>
							{frag.text}
						</span>
					))}
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
	isRemoteTarget: boolean;
	/** Localized remote-execution badge label. */
	remoteLabel: string;
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
	isRemoteTarget,
	remoteLabel,
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
			gap={4}
			wrap="nowrap"
			align="center"
			style={{
				height: HEADER_ROW_HEIGHT,
				cursor: onToggle ? "pointer" : "default",
				userSelect: "none",
			}}
			onClick={onToggle}
		>
			<span
				style={{
					width: 16,
					height: 16,
					minWidth: 16,
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					borderRadius: "var(--mantine-radius-sm)",
					background: cssLight(color),
					color: cssColor(color, 6),
				}}
			>
				<Icon size={10} />
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
 */
function SpecTaskIcon({ status, protectedTask }: { status: string; protectedTask: boolean }) {
	const entry = SPEC_TASK_GLYPH[status] ?? SPEC_TASK_GLYPH.todo;
	const { Icon } = entry;
	const spinning = status === "doing";
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

/**
 * Markdown detail body (ExitPlanMode plans) inside the capped scroll box.
 *
 * `detail.blocks`/`detail.frame` are the merged provenance+markdown list from
 * measureMarkdownDetail, whose geometry starts at y = DETAIL_TOP_MARGIN (the gap
 * lives outside the box). We therefore shift the frame up by that margin and give
 * the box `detail.height - DETAIL_TOP_MARGIN`.
 *
 * `onUnknownHeight` is deliberately NOT forwarded: mermaid/katex/image blocks sit
 * inside a maxHeight-clamped scroll box, so reporting their settled content
 * height would fight the cap that already fixed the outer height. Overflow simply
 * scrolls.
 */
function MarkdownDetailBody({
	detail,
	planSourceLabel,
}: {
	detail: MeasuredToolDetail;
	planSourceLabel: string;
}) {
	const boxHeight = Math.max(0, detail.height - DETAIL_TOP_MARGIN);
	const sourceBlockIndex = detail.blocks.findIndex(
		(b) => b.kind === "fixed" && b.tag === "detail-plan-source",
	);
	const sourceBlock = sourceBlockIndex >= 0 ? detail.blocks[sourceBlockIndex] : undefined;
	const sourcePath =
		sourceBlock?.kind === "fixed" && typeof sourceBlock.data?.sourcePath === "string"
			? sourceBlock.data.sourcePath
			: null;
	const sourceFrame = sourceBlockIndex >= 0 ? detail.frame.blocks[sourceBlockIndex] : undefined;
	// Re-base the measured frame onto the box's own coordinate space.
	const bodyFrame = useMemo(
		() => ({
			...detail.frame,
			contentHeight: Math.max(0, detail.frame.contentHeight - DETAIL_TOP_MARGIN),
			blocks: detail.frame.blocks.map((b) => ({ ...b, top: b.top - DETAIL_TOP_MARGIN })),
		}),
		[detail.frame],
	);
	return (
		<div
			style={{
				maxHeight: detail.appliedCap ?? undefined,
				height: boxHeight,
				overflow: "auto",
				boxSizing: "border-box",
				padding: `${DETAIL_BOX_PADDING_Y}px ${DETAIL_BOX_PADDING_X}px`,
				// Markdown body text inherits the theme foreground, so the surface must
				// follow the colour scheme too — a fixed dark-8 panel would render dark
				// text on near-black in light mode (see vlist-markdown.css).
				background: "var(--vlist-detail-panel-bg)",
				borderRadius: 4,
				position: "relative",
			}}
		>
			{sourcePath != null && sourceFrame ? (
				<Text
					size="xs"
					c="dimmed"
					ff="monospace"
					truncate
					title={sourcePath}
					style={{
						position: "absolute",
						top: sourceFrame.top - DETAIL_TOP_MARGIN + DETAIL_BOX_PADDING_Y,
						left: DETAIL_BOX_PADDING_X,
						width: detail.contentWidth,
						height: sourceFrame.height,
					}}
				>
					{formatPlanSource(planSourceLabel, sourcePath)}
				</Text>
			) : null}
			<RenderMarkdown
				measured={{
					height: bodyFrame.contentHeight,
					blocks: detail.blocks,
					frame: bodyFrame,
					contentWidth: detail.contentWidth,
					usedWidth: detail.frame.usedWidth,
				}}
			/>
		</div>
	);
}

/**
 * The truncated-payload notice: a fixed single-line row at the end of the detail
 * region, offering to load the un-truncated payload.
 *
 * Height-neutral by construction — the row's height comes from the measure pass
 * (`TRUNCATION_NOTICE_MARGIN_TOP + XS_LINE_HEIGHT`) and is pinned here, so nothing
 * inside it can move the card. Clicking is the ONLY thing that grows this card,
 * which is what keeps the "no height change without a user action" invariant.
 */
function TruncationNotice({
	height,
	leafCount,
	totalBytes,
	label,
	loadingLabel,
	loading,
	onLoadFull,
}: {
	height: number;
	leafCount: number;
	totalBytes: number;
	label: string;
	loadingLabel: string;
	loading: boolean;
	onLoadFull?: () => void;
}) {
	const size = totalBytes > 0 ? `${Math.max(1, Math.round(totalBytes / 1024))}KB` : "";
	const text = (loading ? loadingLabel : label)
		.replace("{size}", size)
		.replace("{count}", String(leafCount));
	return (
		<Box
			style={{
				height,
				paddingTop: TRUNCATION_NOTICE_MARGIN_TOP,
				boxSizing: "border-box",
				overflow: "hidden",
			}}
		>
			<UnstyledButton
				onClick={
					loading || !onLoadFull
						? undefined
						: (event) => {
								// The row sits inside the card's own click target, which toggles
								// the fold — loading the payload must not also collapse the card.
								event.stopPropagation();
								onLoadFull();
							}
				}
				style={{ display: "block", width: "100%", lineHeight: `${XS_LINE_HEIGHT}px` }}
			>
				<Text size="xs" c="dimmed" fs="italic" truncate>
					{text}
				</Text>
			</UnstyledButton>
		</Box>
	);
}

/** Resolved label bundle the detail renderers need. */
type DetailLabels = Required<
	Pick<
		ToolCallLabels,
		| "input"
		| "output"
		| "planSource"
		| "download"
		| "copy"
		| "copied"
		| "diffTruncated"
		| "tasksEmpty"
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
function resolveDetailLang(data: Record<string, unknown> | undefined): string | undefined {
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
 * Per-line and per-word diff backgrounds, matching the chunked DiffView.
 *
 * The two schemes are NOT the same colours (Mantine's `*-light` variants read
 * well on a dark surface but are too pale in light mode, where explicit rgba at a
 * higher opacity keeps syntax-highlighted text legible), but that split now lives
 * in vlist-markdown.css: the variables carry both schemes and the cascade picks
 * one. Reading them here means the palette follows a theme switch on its own,
 * without a `useComputedColorScheme` subscription in every diff body.
 */
const DIFF_COLORS = {
	removedLine: "var(--vlist-diff-removed-bg)",
	addedLine: "var(--vlist-diff-added-bg)",
	removedWord: "var(--vlist-diff-removed-word-bg)",
	addedWord: "var(--vlist-diff-added-word-bg)",
} as const;

/**
 * How many diff rows the render layer paints, and why it is bounded.
 *
 * A 500-row diff used to emit every row: 2 spans each, plus one span per word
 * chunk inside a modified pair — a few thousand nodes inside a 200px scroll box
 * whose visible window is ~13 rows. `maxHeight` clips the VISUAL height, not the
 * node count, so several expanded Edit cards in one viewport built thousands of
 * nodes nobody could see.
 *
 * Height safety: the box height comes from the measure layer
 * (`measureDiffContentHeight`), never from how many rows are painted, so a row
 * limit cannot desync the two. Better still, the limit is deliberately larger
 * than `cappedUsefulLines(cap)` — the point at which the measure layer stops
 * counting and returns `cap` — so truncation can only ever happen on a body that
 * measure ALREADY classified as overflowing. A short diff (the case where the
 * height is the exact row count) is never truncated.
 *
 * The rows past the limit are still reachable: the detail's plain `text` is the
 * unified-diff copy source, and the classic card renders the full body.
 */
const DIFF_ROW_OVERSCAN_SCREENS = 4;
/** Fallback visible-row estimate when the cap did not reach the render layer. */
const DIFF_ROW_FALLBACK_VISIBLE = 14;
/**
 * Node-count ceiling for an ordinary cap.
 *
 * NOT an absolute floor-free ceiling: see `diffRenderRowLimit`, which raises it when a cap grows
 * large enough that `cappedUsefulLines(cap)` would exceed it.
 */
const DIFF_ROW_SOFT_MAX = 200;

/**
 * Row budget for a diff body inside a box capped at `cap` px.
 *
 * The `Math.max` is what keeps the height-safety claim above true for EVERY cap rather than just
 * the current one. `DIFF_ROW_SOFT_MAX` is a constant while `cappedUsefulLines(cap)` grows with the
 * cap, so past cap ≈ 2986px the plain `min(200, …)` would fall BELOW the point where measure stops
 * counting: measure would return an exact row-count height (say 250 rows → 3754px) while render
 * painted 200 rows (~3000px), leaving a ~730px hole. Today diff details always get
 * `DETAIL_CAPS.diff` (200), so that regime is unreachable — but nothing enforces that, and a future
 * viewport-derived cap would hit it silently. Deriving the ceiling from the same function measure
 * uses makes the two provably consistent instead of consistent by coincidence.
 */
function diffRenderRowLimit(cap: number | undefined): number {
	const visible =
		cap != null && cap > 0
			? Math.ceil(cap / DETAIL_CONTENT_LINE_HEIGHT)
			: DIFF_ROW_FALLBACK_VISIBLE;
	const budget = Math.min(DIFF_ROW_SOFT_MAX, visible * DIFF_ROW_OVERSCAN_SCREENS);
	// The floor, not a second ceiling: `visible * overscan` can itself drop below
	// `cappedUsefulLines(cap)` once the cap is large (at cap=8000 the overscan budget is 2136 but
	// measure counts 535 — fine — while at the soft-max boundary the 200-row clamp is what bites).
	// Taking the max of the budget and measure's own threshold keeps the two provably consistent
	// without letting an ordinary 200px cap inflate its node count.
	if (cap == null || cap <= 0) return budget;
	return Math.max(budget, cappedUsefulLines(cap));
}

/** Fill the single `{count}` placeholder of the truncation notice template. */
function formatDiffTruncated(template: string, hidden: number): string {
	return template.includes("{count}")
		? template.replace("{count}", String(hidden))
		: `${template} (${hidden})`;
}

/** The "N rows are not painted" footer inside a truncated diff body. */
function DiffTruncatedNotice({ hidden, label }: { hidden: number; label: string }) {
	return (
		<div style={{ opacity: 0.6, fontStyle: "italic" }}>{formatDiffTruncated(label, hidden)}</div>
	);
}

/** Gutter text colour per row type (chunked DiffView parity). */
function diffGutterColor(type: DiffLine["type"]): string {
	return type === "removed"
		? "var(--mantine-color-red-text)"
		: type === "added"
			? "var(--mantine-color-green-text)"
			: "var(--mantine-color-dimmed)";
}

/**
 * A structured diff body: two-column line-number gutter, per-line +/- background,
 * word-level tints inside a modified pair, and Shiki syntax colours.
 *
 * Layering mirrors the chunked DiffView exactly:
 *   1. the row gets a full-width background (added / removed / none)
 *   2. the gutter shows `oldNo newNo±` at a FIXED width so code starts at the
 *      same column on every row
 *   3. the content shows word-level tints when the row is half of a modified
 *      pair, otherwise Shiki tokens, otherwise plain text
 *
 * Word tints and syntax colours are deliberately exclusive (same as chunked):
 * a modified line's value is "what changed", so the word highlight wins there.
 *
 * The gutter width is the SAME character count the measure layer subtracted (see
 * measureDiffContentHeight / diffGutterWidthChars), so the wrapping the height
 * model predicted is the wrapping the browser produces.
 */
function DiffBody({
	lines,
	lang,
	lineNoWidth,
	lineNumberPrefix,
	cap,
	truncatedLabel,
}: {
	lines: readonly DiffLine[];
	lang?: string | undefined;
	lineNoWidth?: number | undefined;
	lineNumberPrefix?: string | undefined;
	/** Measured box cap (px) — sets how many rows are worth painting. */
	cap?: number | undefined;
	/** Localized "N more rows" template carrying a literal `{count}`. */
	truncatedLabel?: string | undefined;
}) {
	const colors = DIFF_COLORS;
	const rowLimit = diffRenderRowLimit(cap);
	const painted = useMemo(
		() => (lines.length > rowLimit ? lines.slice(0, rowLimit) : lines),
		[lines, rowLimit],
	);
	const hidden = lines.length - painted.length;
	// Shiki sees the row CONTENT only (no markers, no gutter), so the grammar gets
	// plausible source. Only the painted rows are highlighted — tokens for rows
	// that are never drawn are pure waste, and `tokens[i]` stays aligned because
	// the slice keeps the original order from index 0.
	const source = useMemo(() => buildDiffHighlightSource(painted), [painted]);
	const tokens = useShikiTokens(source ?? "", lang);

	return (
		<>
			{painted.map((line, i) => {
				const background =
					line.type === "removed"
						? colors.removedLine
						: line.type === "added"
							? colors.addedLine
							: undefined;
				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: diff rows are a stable ordered list
						key={i}
						data-diff-row={line.type}
						style={{
							background,
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
						}}
					>
						<span
							data-diff-gutter
							style={{
								// `pre` keeps the padded alignment; inline-block would let the
								// gutter and content wrap as separate boxes.
								whiteSpace: "pre",
								userSelect: "none",
								opacity: lineNoWidth != null ? 0.4 : 0.6,
								color: diffGutterColor(line.type),
							}}
						>
							{lineNoWidth != null
								? formatDiffGutter(line, lineNoWidth, lineNumberPrefix)
								: diffLineMarker(line.type)}
						</span>
						<DiffRowContent
							line={line}
							tokens={tokens?.[i]}
							colors={colors}
							hasHighlight={source != null}
						/>
					</div>
				);
			})}
			{hidden > 0 ? (
				<DiffTruncatedNotice hidden={hidden} label={truncatedLabel ?? DEFAULT_DIFF_TRUNCATED} />
			) : null}
		</>
	);
}

/** One diff row's content: word tints, else Shiki tokens, else plain text. */
function DiffRowContent({
	line,
	tokens,
	colors,
	hasHighlight,
}: {
	line: DiffLine;
	tokens?: readonly ShikiToken[];
	colors: typeof DIFF_COLORS;
	hasHighlight: boolean;
}) {
	if (line.wordChanges && line.wordChanges.length > 0) {
		return (
			<>
				{line.wordChanges.map((change, j) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: word chunks have no stable id
						key={j}
						style={
							change.removed
								? { background: colors.removedWord, borderRadius: 2 }
								: change.added
									? { background: colors.addedWord, borderRadius: 2 }
									: undefined
						}
					>
						{change.value}
					</span>
				))}
			</>
		);
	}
	if (hasHighlight) return <TokenText text={line.content} tokens={tokens} />;
	return (
		<span style={line.type === "context" ? { color: "var(--mantine-color-dimmed)" } : undefined}>
			{line.content}
		</span>
	);
}

/**
 * Legacy plain-text diff fallback: used when a `diff` cap somehow carries only
 * `text` (no structured rows) — e.g. a payload produced before the structured
 * diff existed. Keeps the +/- rows readable rather than rendering nothing.
 */
function DiffTextFallback({
	text,
	lang,
	cap,
	truncatedLabel,
}: {
	text: string;
	lang?: string | undefined;
	cap?: number | undefined;
	truncatedLabel?: string | undefined;
}) {
	// Same row budget as the structured path: the fallback had the identical
	// unbounded-node problem, and the box height is likewise measure-owned.
	const rowLimit = diffRenderRowLimit(cap);
	const all = useMemo(() => text.split("\n"), [text]);
	const lines = useMemo(
		() => (all.length > rowLimit ? all.slice(0, rowLimit) : all),
		[all, rowLimit],
	);
	const hidden = all.length - lines.length;
	const source = useMemo(
		() => lines.map((line) => (/^[+\- ]/.test(line) ? line.slice(1) : line)).join("\n"),
		[lines],
	);
	const tokens = useShikiTokens(source, lang);
	const colors = DIFF_COLORS;
	return (
		<>
			{lines.map((line, i) => {
				const added = line.startsWith("+");
				const removed = line.startsWith("-");
				const marker = /^[+\- ]/.test(line) ? line.slice(0, 1) : "";
				const body = marker ? line.slice(1) : line;
				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable ordered list
						key={i}
						style={{
							background: added ? colors.addedLine : removed ? colors.removedLine : undefined,
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
						}}
					>
						{line.length > 0 ? (
							<>
								<span style={{ whiteSpace: "pre", userSelect: "none", opacity: 0.6 }}>
									{marker}
								</span>
								<TokenText text={body} tokens={tokens?.[i]} />
							</>
						) : (
							"\u00a0"
						)}
					</div>
				);
			})}
			{hidden > 0 ? (
				<DiffTruncatedNotice hidden={hidden} label={truncatedLabel ?? DEFAULT_DIFF_TRUNCATED} />
			) : null}
		</>
	);
}

/** Read the structured diff payload a `diff` cap carries, if present. */
function readDiffPayload(data: Record<string, unknown> | undefined): {
	lines: readonly DiffLine[];
	lineNoWidth?: number;
	lineNumberPrefix?: string;
} | null {
	if (!data || !Array.isArray(data.diffLines) || data.diffLines.length === 0) return null;
	return {
		lines: data.diffLines as DiffLine[],
		...(typeof data.diffLineNoWidth === "number" ? { lineNoWidth: data.diffLineNoWidth } : {}),
		...(typeof data.diffLineNumberPrefix === "string"
			? { lineNumberPrefix: data.diffLineNumberPrefix }
			: {}),
	};
}

/**
 * A diff detail body: the structured renderer when rows are available, else the
 * plain +/- text fallback.
 */
function DiffLines({
	text,
	lang,
	data,
	truncatedLabel,
}: {
	text: string;
	lang?: string | undefined;
	data?: Record<string, unknown> | undefined;
	truncatedLabel?: string | undefined;
}) {
	const payload = readDiffPayload(data);
	// The cap the measure layer applied to this body: it decides how many rows can
	// ever be on screen, and therefore how many are worth building.
	const cap = typeof data?.cap === "number" ? data.cap : undefined;
	if (!payload) {
		return <DiffTextFallback text={text} lang={lang} cap={cap} truncatedLabel={truncatedLabel} />;
	}
	return (
		<DiffBody
			lines={payload.lines}
			lang={lang}
			lineNoWidth={payload.lineNoWidth}
			lineNumberPrefix={payload.lineNumberPrefix}
			cap={cap}
			truncatedLabel={truncatedLabel}
		/>
	);
}

/**
 * Test-only handle on the diff body renderer. The diff gutter / row backgrounds /
 * word tints are the visual contract most at risk of silent regression, and they
 * are only reachable through a fully measured tool card otherwise. Exported so
 * DiffBody.test.tsx can assert the produced DOM directly.
 */
export const __TEST__DiffLines = DiffLines;

/**
 * Test-only handle on the timing breakdown body. Mantine's Popover dropdown is
 * portaled and only mounts while open, so a static render of the header cannot
 * reach the breakdown — exported so RenderToolCall.timing.test.tsx can assert the
 * phase rows and summary lines directly.
 */
export const __TEST__ToolTimingBreakdown = ToolTimingBreakdown;

/**
 * A capped body scroll box: the fixed-height, clamped container the measure layer
 * reserved. Shared by the single-block path and the per-section path so both keep
 * identical geometry.
 */
function CappedBodyBox({
	height,
	cap,
	children,
}: {
	height: number;
	cap?: number | null;
	children: ReactNode;
}) {
	return (
		<div
			style={{
				maxHeight: cap ?? undefined,
				height,
				overflow: "auto",
				fontSize: DETAIL_BODY_FONT_SIZE,
				// The measure layer counts INTEGER line boxes
				// (DETAIL_CONTENT_LINE_HEIGHT = round(11 × 1.4) = 15). Declaring the
				// ratio `1.4` here would make the browser use 15.4px instead, so every
				// wrapped line drifts 0.4px and a 15-line body renders 6px taller than
				// the box reserved for it — the overflow is silently clipped. Pinning
				// the same integer keeps measure and render byte-identical.
				lineHeight: `${DETAIL_CONTENT_LINE_HEIGHT}px`,
				fontFamily: "var(--mantine-font-family-monospace)",
				// Scheme-aware: a fixed dark-8 panel renders near-black text on
				// near-black in light mode (see vlist-markdown.css).
				background: "var(--vlist-detail-panel-bg)",
				color: "var(--vlist-detail-panel-fg)",
				borderRadius: 4,
				padding: `${DETAIL_BOX_PADDING_Y}px ${DETAIL_BOX_PADDING_X}px`,
				boxSizing: "border-box",
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
			}}
		>
			{children}
		</div>
	);
}

/**
 * A multi-part detail: the ordered section list the classifier produced.
 *
 * All sections share ONE flat block list (blocks[i] ↔ frame.blocks[i]); each
 * `MeasuredToolDetailSection` says which slice it owns and where its label /
 * body sit, so every piece is drawn at exactly the measured geometry.
 */
function SectionsDetailBody({
	detail,
	availableWidth,
	labels,
	narratorId,
}: {
	detail: MeasuredToolDetail;
	availableWidth: number;
	labels: DetailLabels;
	narratorId?: string;
}) {
	const sections = detail.sections ?? [];
	return (
		<div style={{ position: "relative", width: availableWidth, height: detail.height }}>
			{sections.map((part, index) => (
				<SectionView
					// biome-ignore lint/suspicious/noArrayIndexKey: sections are a stable ordered list
					key={index}
					detail={detail}
					part={part}
					availableWidth={availableWidth}
					labels={labels}
					narratorId={narratorId}
				/>
			))}
		</div>
	);
}

/** One section: its optional label row + its body drawn at the measured offset. */
function SectionView({
	detail,
	part,
	availableWidth,
	labels,
	narratorId,
}: {
	detail: MeasuredToolDetail;
	part: MeasuredToolDetailSection;
	availableWidth: number;
	labels: DetailLabels;
	narratorId?: string;
}) {
	// The slice of blocks owned by this section (skipping its own label row).
	const bodyStart = part.blockStart + (part.hasLabel ? 1 : 0);
	const bodyEnd = part.blockStart + part.blockCount;
	const blocks = detail.blocks.slice(bodyStart, bodyEnd);
	const frames = detail.frame.blocks.slice(bodyStart, bodyEnd);
	return (
		<>
			{part.label !== undefined ? (
				<Text
					size="xs"
					fw={500}
					style={{
						position: "absolute",
						top: part.top,
						left: 0,
						width: availableWidth,
						height: SECTION_LABEL_HEIGHT,
					}}
				>
					{sectionLabelText(labels, part.label)}
				</Text>
			) : null}
			<div
				style={{
					position: "absolute",
					top: part.bodyTop,
					left: 0,
					width: availableWidth,
					height: part.bodyHeight,
				}}
			>
				<SectionBody
					part={part}
					blocks={blocks}
					frames={frames}
					availableWidth={availableWidth}
					labels={labels}
					narratorId={narratorId}
				/>
			</div>
		</>
	);
}

/**
 * The body of one section, re-based onto its own origin. A capped body is drawn
 * inside its clamped scroll box (so overflow scrolls instead of growing the
 * card); the pretext-measured bodies are absolutely positioned lines.
 */
function SectionBody({
	part,
	blocks,
	frames,
	availableWidth,
	labels,
	narratorId,
}: {
	part: MeasuredToolDetailSection;
	blocks: MeasuredToolDetail["blocks"];
	frames: readonly BlockFrame[];
	availableWidth: number;
	labels: DetailLabels;
	narratorId?: string;
}) {
	// Section geometry is absolute within the region; shift it to a local origin.
	const origin = frames[0]?.top ?? 0;
	const localFrames = useMemo(
		() => frames.map((f) => ({ ...f, top: f.top - origin })),
		[frames, origin],
	);
	const inner: MeasuredToolDetail = useMemo(
		() => ({
			kind: part.kind,
			height: part.bodyContentHeight,
			blocks: [...blocks],
			frame: {
				blocks: localFrames,
				contentHeight: part.bodyContentHeight,
				usedWidth: availableWidth,
			},
			contentWidth: availableWidth,
			appliedCap: part.appliedCap,
			...(part.markdown ? { markdown: true } : {}),
		}),
		[part, blocks, localFrames, availableWidth],
	);

	if (part.kind === "capped" && part.markdown) {
		// A markdown body (plan / skill / knowledge) painted inside the capped box.
		return (
			<CappedMarkdownBody
				measured={inner}
				boxHeight={part.bodyHeight}
				cap={part.appliedCap}
				planSourceLabel={labels.planSource}
			/>
		);
	}
	if (part.kind === "capped") {
		const block = blocks[0];
		const media =
			block?.kind === "fixed" ? (block.data?.media as VListImageRef | undefined) : undefined;
		if (media) {
			return <VListImage media={media} narratorId={narratorId} maxHeight={part.bodyHeight} />;
		}
		const text =
			block?.kind === "fixed" && typeof block.data?.text === "string" ? block.data.text : null;
		const isDiff = block?.kind === "fixed" && block.tag === "detail-diff";
		const lang = block?.kind === "fixed" ? resolveDetailLang(block.data) : undefined;
		const blockData = block?.kind === "fixed" ? block.data : undefined;
		return (
			<CappedBodyBox height={part.bodyHeight} cap={part.appliedCap}>
				{isDiff ? (
					<DiffLines
						text={text ?? ""}
						lang={lang}
						data={blockData}
						truncatedLabel={labels.diffTruncated}
					/>
				) : text == null ? null : (
					<HighlightedBody text={text} lang={lang} />
				)}
			</CappedBodyBox>
		);
	}
	// A denied / skipped question arrives as `{ sections: [ask, error] }`, so the ask
	// replay must be routed here too. Letting it fall through to DetailBlocks below
	// keeps the height correct but drops the option glyphs and the selected
	// emphasis — the whole point of the card.
	if (part.kind === "ask") {
		return (
			<AskDetailBlocks
				blocks={blocks}
				frames={localFrames}
				availableWidth={availableWidth}
				height={part.bodyHeight}
			/>
		);
	}
	// meta-rows / structured / spec-tasks / error → absolutely positioned blocks.
	return (
		<DetailBlocks
			kind={part.kind}
			blocks={blocks}
			frames={localFrames}
			availableWidth={availableWidth}
			height={part.bodyHeight}
			labels={labels}
			narratorId={narratorId}
		/>
	);
}

/** Markdown body inside a clamped scroll box (shared by plan / skill / knowledge). */
function CappedMarkdownBody({
	measured,
	boxHeight,
	cap,
	planSourceLabel,
}: {
	measured: MeasuredToolDetail;
	boxHeight: number;
	cap: number | null;
	planSourceLabel: string;
}) {
	const sourceIndex = measured.blocks.findIndex(
		(b) => b.kind === "fixed" && b.tag === "detail-plan-source",
	);
	const sourceBlock = sourceIndex >= 0 ? measured.blocks[sourceIndex] : undefined;
	const sourcePath =
		sourceBlock?.kind === "fixed" && typeof sourceBlock.data?.sourcePath === "string"
			? sourceBlock.data.sourcePath
			: null;
	const sourceFrame = sourceIndex >= 0 ? measured.frame.blocks[sourceIndex] : undefined;
	return (
		<div
			style={{
				maxHeight: cap ?? undefined,
				height: boxHeight,
				overflow: "auto",
				boxSizing: "border-box",
				padding: `${DETAIL_BOX_PADDING_Y}px ${DETAIL_BOX_PADDING_X}px`,
				// Markdown body text inherits the theme foreground, so the surface
				// must follow the colour scheme too (see vlist-markdown.css).
				background: "var(--vlist-detail-panel-bg)",
				borderRadius: 4,
				position: "relative",
			}}
		>
			{sourcePath != null && sourceFrame ? (
				<Text
					size="xs"
					c="dimmed"
					ff="monospace"
					truncate
					title={sourcePath}
					style={{
						position: "absolute",
						top: sourceFrame.top + DETAIL_BOX_PADDING_Y,
						left: DETAIL_BOX_PADDING_X,
						width: measured.contentWidth,
						height: sourceFrame.height,
					}}
				>
					{formatPlanSource(planSourceLabel, sourcePath)}
				</Text>
			) : null}
			<RenderMarkdown
				measured={{
					height: measured.frame.contentHeight,
					blocks: measured.blocks,
					frame: measured.frame,
					contentWidth: measured.contentWidth,
					usedWidth: measured.frame.usedWidth,
				}}
			/>
		</div>
	);
}

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
}: {
	kind: MeasuredToolDetail["kind"];
	blocks: MeasuredToolDetail["blocks"];
	frames: readonly BlockFrame[];
	availableWidth: number;
	height: number;
	labels: DetailLabels;
	narratorId?: string;
}) {
	void narratorId;
	// `c="red"`: red-4 on dark, red-filled on light (red-4 washes out on white).
	const color = kind === "error" ? "var(--mantine-color-red-text)" : undefined;
	const isSpecTasks = kind === "spec-tasks";
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
								<SpecTaskIcon status={taskStatus} protectedTask={data.protected === true} />
							</div>
						</div>
					) : null;
					// A row/entry whose text is a link paints an anchor overlay so the
					// measured line geometry stays authoritative.
					const href = typeof data.href === "string" ? data.href : null;
					const dimmed = data.dimmed === true;
					const lineColor = taskStatus === "done" || dimmed ? "var(--mantine-color-dimmed)" : color;
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
	blocks: MeasuredToolDetail["blocks"];
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
}: {
	detail: MeasuredToolDetail;
	availableWidth: number;
	labels: DetailLabels;
	narratorId?: string;
}) {
	// Multi-part detail: the meta header + labelled body sections the classic card
	// draws. This is the shape whose absence made whole blocks disappear.
	if (detail.kind === "sections") {
		return (
			<SectionsDetailBody
				detail={detail}
				availableWidth={availableWidth}
				labels={labels}
				narratorId={narratorId}
			/>
		);
	}
	// Read-only AskUserQuestion replay: needs the option glyphs / selected emphasis
	// the generic block renderer knows nothing about.
	if (detail.kind === "ask") {
		return (
			<AskDetailBlocks
				blocks={detail.blocks}
				frames={detail.frame.blocks}
				availableWidth={availableWidth}
				height={detail.height}
			/>
		);
	}
	// Markdown-bodied capped detail (plans): real prepared blocks, not one opaque
	// fixed block. Rendered with RenderMarkdown inside the same clamped box.
	if (detail.kind === "capped" && detail.markdown) {
		return <MarkdownDetailBody detail={detail} planSourceLabel={labels.planSource} />;
	}
	// Capped / generic kinds are fixed blocks → a clamped scroll container each.
	if (detail.kind === "capped" || detail.kind === "generic") {
		return (
			<div style={{ position: "relative", width: availableWidth, height: detail.height }}>
				{detail.blocks.map((block, index) => {
					const bf = detail.frame.blocks[index];
					if (!bf || block.kind !== "fixed") return null;
					const isOutput = block.tag === "detail-generic-output";
					const hasLabel =
						block.tag === "detail-generic-input" ||
						block.tag === "detail-generic-output" ||
						block.data?.hasLabel === true;
					// Media caps paint an actual image inside the reserved box.
					const media = block.data?.media as VListImageRef | undefined;
					const isMedia = block.tag === "detail-media" && media != null;
					const bodyText = typeof block.data?.text === "string" ? block.data.text : null;
					const isDiff = block.tag === "detail-diff";
					const bodyLang = resolveDetailLang(block.data);
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
							{hasLabel ? (
								<Text size="xs" fw={500} mb={2}>
									{isOutput ? labels.output : labels.input}
								</Text>
							) : null}
							{isMedia ? (
								<VListImage
									media={media}
									narratorId={narratorId}
									maxHeight={bf.height - (hasLabel ? 19 : 0)}
								/>
							) : (
								<div
									style={{
										maxHeight: typeof block.data?.cap === "number" ? block.data.cap : undefined,
										overflow: "auto",
										fontSize: DETAIL_BODY_FONT_SIZE,
										// Integer line box, not the 1.4 ratio — see CappedBodyBox.
										lineHeight: `${DETAIL_CONTENT_LINE_HEIGHT}px`,
										fontFamily: "var(--mantine-font-family-monospace)",
										// Scheme-aware — see CappedBodyBox.
										background: "var(--vlist-detail-panel-bg)",
										color: "var(--vlist-detail-panel-fg)",
										borderRadius: 4,
										padding: `${DETAIL_BOX_PADDING_Y}px ${DETAIL_BOX_PADDING_X}px`,
										boxSizing: "border-box",
										whiteSpace: "pre-wrap",
										wordBreak: "break-word",
										// The scroll body fills the block minus the label chrome.
										height: bf.height - (hasLabel ? 19 : 0),
									}}
								>
									{/* Real body text (code/command/diff/output). Diffs get +/- line
									    tinting plus syntax colours; other bodies get syntax colours
									    when a language is known. Height-capped so content never
									    shifts layout. */}
									{isDiff ? (
										<DiffLines
											text={bodyText ?? ""}
											lang={bodyLang}
											data={block.data}
											truncatedLabel={labels.diffTruncated}
										/>
									) : bodyText == null ? null : (
										<HighlightedBody text={bodyText} lang={bodyLang} />
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>
		);
	}

	// Pretext-measured kinds (meta-rows / spec-tasks / structured / error).
	return (
		<DetailBlocks
			kind={detail.kind}
			blocks={detail.blocks}
			frames={detail.frame.blocks}
			availableWidth={availableWidth}
			height={detail.height}
			labels={labels}
			narratorId={narratorId}
		/>
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
	/** Load this card's un-truncated payload (the truncation notice's action). */
	onLoadFullPayload?: () => void;
	/** The requested full payload is in flight. */
	fullPayloadLoading?: boolean;
	/**
	 * Manual takeover of a RUNNING reflection gate (stop it and decide yourself).
	 * The API call lives outside vlist/, so the integration layer supplies it; the
	 * notice itself is measured + rendered on the pure path.
	 */
	onReflectionTakeOver?: () => void;
	/** Whether a takeover request is in flight (button shows a loader). */
	reflectionTakingOver?: boolean;
}

/**
 * Resolve the sweep-shimmer class for a card (parity with ToolCallCard :5937):
 *   - streaming input            → neutral card shimmer (looping)
 *   - running (no permission)    → blue running shimmer (looping)
 *   - running → success just now → one-shot green done shimmer (650ms)
 *
 * The done shimmer is a timed transition, so it needs component state: we track
 * the previous status and only fire when we actually observe a running → success
 * flip. Unlike ToolCallCard we have no startedAt/durationMs here, so we DON'T
 * fire on a fresh mount (prev === null) — that keeps history loads from flashing
 * while still animating real live completions.
 */
function useToolCardShimmerClass(
	status: ToolCallStatus,
	isStreaming: boolean,
	hasPermission: boolean,
): string | undefined {
	const prevStatusRef = useRef<ToolCallStatus | null>(null);
	const [doneShimmer, setDoneShimmer] = useState(false);
	useEffect(() => {
		const prev = prevStatusRef.current;
		prevStatusRef.current = status;
		const wasRunning = prev != null && isRunningStatus(prev);
		if (status === "success" && wasRunning) {
			setDoneShimmer(true);
			const timer = setTimeout(() => setDoneShimmer(false), 650);
			return () => clearTimeout(timer);
		}
	}, [status]);

	if (isStreaming) return "vlist-tool-card-shimmer";
	if (doneShimmer) return "vlist-tool-done-shimmer";
	if (isRunningStatus(status) && !hasPermission) return "vlist-tool-running-shimmer";
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
	onLoadFullPayload,
	fullPayloadLoading,
	onReflectionTakeOver,
	reflectionTakingOver,
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
	const shimmerClass = useToolCardShimmerClass(status, isStreaming, permission != null);
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

	const body = (
		<>
			<ToolHeaderRow
				toolName={measured.toolName}
				summary={measured.summary}
				category={category}
				status={status}
				isRemoteTarget={measured.isRemoteTarget}
				remoteLabel={merged.remote}
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
			{effectiveOpened ? (
				<>
					{detail ? (
						<Box mt={DETAIL_TOP_MARGIN} style={{ position: "relative" }}>
							{/* The detail region's own top block already carries the mt gap,
							    so we render it flush and let its frame own the spacing. */}
							<div style={{ marginTop: -DETAIL_TOP_MARGIN }}>
								<DetailRegion
									detail={detail}
									availableWidth={contentWidth}
									labels={merged}
									narratorId={narratorId}
								/>
							</div>
						</Box>
					) : null}
					{/* Truncation notice: ONE row covering every still-previewed field of this
					    payload, drawn at exactly the height the measure pass reserved. */}
					{measured.truncationNoticeHeight > 0 ? (
						<TruncationNotice
							height={measured.truncationNoticeHeight}
							leafCount={measured.truncatedLeafCount}
							totalBytes={measured.truncatedTotalBytes}
							label={merged.truncatedPreview}
							loadingLabel={merged.truncatedLoading}
							loading={fullPayloadLoading === true}
							onLoadFull={onLoadFullPayload}
						/>
					) : null}
					{/* A reflection notice REPLACES the permission area (chunked precedence,
					    ToolCallCard.tsx:5419). It is fully MEASURED, so it renders on the
					    pure path — no slot, no post-paint height correction. */}
					{reflection ? (
						<RenderReflectionNotice
							measured={reflection}
							labels={merged.reflection}
							includeTopMargin
							onTakeOver={onReflectionTakeOver}
							takingOver={reflectionTakingOver}
						/>
					) : (
						/* Live permission form (integration layer) takes precedence over the
						   zero-DOM copy: it is the real interactive component whose height is
						   corrected after paint. The component carries its own top margin. */
						(permissionSlot ??
						(permission ? (
							<RenderInlinePermission
								measured={permission}
								labels={merged.permission}
								includeTopMargin
								onAllow={onPermissionAllow}
								onDeny={onPermissionDeny}
							/>
						) : null))
					)}
				</>
			) : null}
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
				style={{
					height: headerHeight,
					cursor: onToggle ? "pointer" : "default",
					userSelect: "none",
				}}
				onClick={onToggle}
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
