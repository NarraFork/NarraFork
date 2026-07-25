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
import { Badge, Box, Divider, Group, Paper, Text, ThemeIcon } from "@mantine/core";
import {
	IconBan,
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconDevices,
	IconLoader2,
	IconLock,
	IconPlayerPlay,
	type IconProps,
	IconTool,
	IconX,
} from "@tabler/icons-react";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import "../vlist-markdown.css";
import {
	CARD_PADDING,
	DETAIL_TOP_MARGIN,
	GROUP_BODY_BORDER_LEFT,
	GROUP_BODY_MARGIN_TOP,
	GROUP_BODY_PADDING_LEFT,
	HEADER_ROW_HEIGHT,
	isRunningStatus,
	type MeasuredToolCall,
	type MeasuredToolCallGroup,
	type MeasuredToolDetail,
	type ToolCallStatus,
	type ToolCategory,
} from "../measure/measure-tool-call";
import type { BlockFrame, PreparedInlineBlock } from "../prepared-block";
import { categoryIcon } from "./category-icons";
import { type InlinePermissionLabels, RenderInlinePermission } from "./RenderPermission";
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
	/** Permission labels forwarded to RenderInlinePermission. */
	permission?: InlinePermissionLabels;
}

const DEFAULT_LABELS: Required<Pick<ToolCallLabels, "input" | "output">> = {
	input: "Input",
	output: "Output",
};

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
}: {
	block: PreparedInlineBlock;
	frame: BlockFrame;
	availableWidth: number;
	color?: string;
	/** Optional glyph drawn in the reserved indent lane (spec-task status icon). */
	leadingSlot?: React.ReactNode;
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
	opened: boolean;
	onToggle?: () => void;
	/** Optional category-icon override; falls back to a neutral tool glyph. */
	icon?: ComponentType<IconProps>;
}

function ToolHeaderRow({
	toolName,
	summary,
	category,
	status,
	isRemoteTarget,
	opened,
	onToggle,
	icon: Icon = IconTool,
}: ToolHeaderRowProps) {
	const color = CATEGORY_COLOR[category];
	const statusColor = STATUS_COLOR[status];
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
					remote
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

function DetailRegion({
	detail,
	availableWidth,
	labels,
	narratorId,
}: {
	detail: MeasuredToolDetail;
	availableWidth: number;
	labels: Required<Pick<ToolCallLabels, "input" | "output">>;
	narratorId?: string;
}) {
	// Capped / generic kinds are fixed blocks → a clamped scroll container each.
	if (detail.kind === "capped" || detail.kind === "generic") {
		return (
			<div style={{ position: "relative", width: availableWidth, height: detail.height }}>
				{detail.blocks.map((block, index) => {
					const bf = detail.frame.blocks[index]!;
					if (block.kind !== "fixed") return null;
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
										fontSize: 11,
										lineHeight: 1.4,
										fontFamily: "var(--mantine-font-family-monospace)",
										background: "var(--mantine-color-dark-8)",
										color: "var(--mantine-color-gray-3)",
										borderRadius: 4,
										padding: "2px 6px",
										boxSizing: "border-box",
										whiteSpace: "pre-wrap",
										wordBreak: "break-word",
										// The scroll body fills the block minus the label chrome.
										height: bf.height - (hasLabel ? 19 : 0),
									}}
								>
									{/* Real body text (code/command/diff/output). Diffs get +/- line
									    tinting; other bodies stay plain monospace. Height-capped so
									    content never shifts layout. */}
									{isDiff && bodyText != null ? <DiffLines text={bodyText} /> : bodyText}
								</div>
							)}
						</div>
					);
				})}
			</div>
		);
	}

	// Pretext-measured kinds (spec-tasks / structured / error) → inline lines.
	const color = detail.kind === "error" ? "var(--mantine-color-red-4)" : undefined;
	const isSpecTasks = detail.kind === "spec-tasks";
	return (
		<div style={{ position: "relative", width: availableWidth, height: detail.height }}>
			{detail.blocks.map((block, index) => {
				const bf = detail.frame.blocks[index]!;
				if (block.kind === "inline") {
					// Spec-task rows carry a status glyph in the reserved indent lane.
					const taskStatus =
						isSpecTasks && typeof block.data?.status === "string" ? block.data.status : null;
					const iconSlot = taskStatus ? (
						<div style={{ position: "absolute", left: 0, top: 0, height: block.lineHeight }}>
							<div style={{ display: "flex", alignItems: "center", height: block.lineHeight }}>
								<SpecTaskIcon status={taskStatus} protectedTask={block.data?.protected === true} />
							</div>
						</div>
					) : null;
					return (
						<InlineLines
							// biome-ignore lint/suspicious/noArrayIndexKey: blocks are a stable ordered list
							key={index}
							block={block}
							frame={bf}
							availableWidth={availableWidth}
							color={taskStatus === "done" ? "var(--mantine-color-dimmed)" : color}
							leadingSlot={iconSlot}
						/>
					);
				}
				// Fixed rows: badge header (draw chips) or empty-task placeholder.
				const badges =
					block.kind === "fixed" && block.tag === "detail-struct-badges"
						? readBadges(block.data)
						: [];
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
					</div>
				);
			})}
		</div>
	);
}

/** Render a +/- diff body with per-line green/red tint (plain monospace). */
function DiffLines({ text }: { text: string }) {
	return (
		<>
			{text.split("\n").map((line, i) => {
				const tint = line.startsWith("+")
					? "var(--mantine-color-green-4)"
					: line.startsWith("-")
						? "var(--mantine-color-red-4)"
						: undefined;
				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable ordered list
						key={i}
						style={{ color: tint, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
					>
						{line.length > 0 ? line : "\u00a0"}
					</div>
				);
			})}
		</>
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
	onPermissionAllow,
	onPermissionDeny,
	permissionSlot,
}: RenderToolCallProps) {
	const merged = { ...DEFAULT_LABELS, ...labels };
	const {
		contentWidth,
		effectiveOpened,
		detail,
		permission,
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
				opened={effectiveOpened}
				onToggle={onToggle}
				icon={icon ?? categoryIcon(category, measured.toolName)}
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
					{/* Live permission form (integration layer) takes precedence over the
					    zero-DOM copy: it is the real interactive component whose height is
					    corrected after paint. The component carries its own top margin. */}
					{permissionSlot ??
						(permission ? (
							<RenderInlinePermission
								measured={permission}
								labels={merged.permission}
								includeTopMargin
								onAllow={onPermissionAllow}
								onDeny={onPermissionDeny}
							/>
						) : null)}
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
