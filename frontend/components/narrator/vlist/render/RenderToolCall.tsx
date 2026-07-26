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
import { formatDurationText } from "@frontend/lib/format";
import { getShikiLang } from "@frontend/lib/shiki-lang";
import {
	Badge,
	Box,
	Button,
	CopyButton,
	Divider,
	Group,
	Paper,
	Text,
	ThemeIcon,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	IconBan,
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconCopy,
	IconDevices,
	IconDownload,
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
	DETAIL_BODY_FONT_SIZE,
	DETAIL_BOX_PADDING_X,
	DETAIL_BOX_PADDING_Y,
	DETAIL_CONTENT_LINE_HEIGHT,
	DETAIL_TOP_MARGIN,
	ENTRY_SNIPPET_MAX_LINES,
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
	type ToolCallStatus,
	type ToolCategory,
	type ToolRowAction,
	type ToolSectionLabel,
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
	/** Permission labels forwarded to RenderInlinePermission. */
	permission?: InlinePermissionLabels;
	/** Reflection-notice labels forwarded to RenderReflectionNotice. */
	reflection?: ReflectionNoticeLabels;
}

const DEFAULT_LABELS: Required<
	Pick<
		ToolCallLabels,
		"input" | "output" | "remote" | "planSource" | "download" | "copy" | "copied" | "terminate"
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
			    a live elapsed counter while running, else the final duration. */}
			<TimingText
				running={running}
				startedAt={startedAt}
				durationMs={durationMs}
				timeoutMs={timeoutMs}
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
}: {
	running: boolean;
	startedAt?: number | null;
	durationMs?: number | null;
	timeoutMs?: number | null;
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
				<span>/ {formatDurationText(timeoutMs, { style: "timeout" })}</span>
			) : null}
		</span>
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

/** One spec-task row: status icon + optional lock in the reserved indent lane. */
function SpecTaskIcon({ status, protectedTask }: { status: string; protectedTask: boolean }) {
	const entry = SPEC_TASK_GLYPH[status] ?? SPEC_TASK_GLYPH.todo;
	const { Icon } = entry;
	const spinning = status === "doing";
	return (
		<Group gap={4} wrap="nowrap" style={{ alignItems: "center" }}>
			<ThemeIcon size={16} variant="light" color={entry.color} radius="xl">
				<Icon size={10} className={spinning ? "vlist-spin" : undefined} />
			</ThemeIcon>
			{protectedTask ? <IconLock size={11} color="var(--mantine-color-yellow-6)" /> : null}
		</Group>
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
				// text on near-black in light mode. gray-0 stays a shade lighter than
				// the fenced-code panel (--vlist-code-bg = gray-1) so blocks stay legible.
				background: "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))",
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

/** Resolved label bundle the detail renderers need. */
type DetailLabels = Required<
	Pick<ToolCallLabels, "input" | "output" | "planSource" | "download" | "copy" | "copied">
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
 * A `+`/`-` diff body: line-level red/green tint (as before) with Shiki syntax
 * colours layered onto the line content.
 *
 * The prefix column keeps the line tint so added/removed stays scannable, and the
 * source sent to Shiki has the prefixes stripped so the grammar sees plausible
 * code. Highlighting is per PHYSICAL line here (each line is its own `pre-wrap`
 * row), so no visual-line re-slicing is involved.
 */
function DiffLines({ text, lang }: { text: string; lang?: string | undefined }) {
	const lines = useMemo(() => text.split("\n"), [text]);
	// Strip the leading marker so the highlighter sees the underlying code.
	const source = useMemo(
		() => lines.map((line) => (/^[+\- ]/.test(line) ? line.slice(1) : line)).join("\n"),
		[lines],
	);
	const tokens = useShikiTokens(source, lang);
	return (
		<>
			{lines.map((line, i) => {
				const tint = line.startsWith("+")
					? "var(--mantine-color-green-4)"
					: line.startsWith("-")
						? "var(--mantine-color-red-4)"
						: undefined;
				const marker = /^[+\- ]/.test(line) ? line.slice(0, 1) : "";
				const body = marker ? line.slice(1) : line;
				const lineTokens = tokens?.[i];
				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable ordered list
						key={i}
						style={{ color: tint, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
					>
						{line.length > 0 ? (
							<>
								{marker}
								<TokenText text={body} tokens={lineTokens} />
							</>
						) : (
							"\u00a0"
						)}
					</div>
				);
			})}
		</>
	);
}

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
				background: "var(--mantine-color-dark-8)",
				color: "var(--mantine-color-gray-3)",
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
		return (
			<CappedBodyBox height={part.bodyHeight} cap={part.appliedCap}>
				{text == null ? null : isDiff ? (
					<DiffLines text={text} lang={lang} />
				) : (
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
				background: "var(--mantine-color-dark-8)",
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
	const color = kind === "error" ? "var(--mantine-color-red-4)" : undefined;
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
							color={href ? "var(--mantine-color-teal-4)" : lineColor}
							leadingSlot={iconSlot}
							href={href}
						/>
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
			return "var(--mantine-color-teal-4)";
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
										background: "var(--mantine-color-dark-8)",
										color: "var(--mantine-color-gray-3)",
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
									{bodyText == null ? null : isDiff ? (
										<DiffLines text={bodyText} lang={bodyLang} />
									) : (
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
	onPermissionAllow,
	onPermissionDeny,
	permissionSlot,
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
