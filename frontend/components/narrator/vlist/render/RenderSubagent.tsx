/**
 * RenderSubagent.tsx — Render copy for the SubagentCard (batch-2 P12).
 *
 * Pairs with measure-subagent.ts. Draws the composite card (header + recent
 * calls + LazyCollapse body) at the geometry the measure layer computed, with
 * zero DOM measurement. Visual parity target: SubagentCard.tsx.
 *
 * Regions (top → bottom), each an absolutely-positioned box at its measured top:
 *   - header       (always): badge row + description (truncate collapsed / wrap
 *                  expanded) + optional collapsed result preview.
 *   - recent calls (always when present): title row + ≤3 activity rows. Both the
 *                  title button and each row open the child session (parity with
 *                  SubagentCard, whose rows are UnstyledButtons).
 *   - body         (effectiveExpanded): selfPermission (RenderInlinePermission,
 *                  P11) + prompt toggle/body + pending cards (P10 placeholder) +
 *                  resolveOverride button + result (RenderMarkdown, maxHeight).
 *
 * Wrapping text (expanded description, result markdown) is materialized from the
 * SAME pretext flow the measure layer produced so rendered wrapping matches the
 * predicted height. This is a VISUAL copy: live interaction (navigation, detach,
 * cancel, i18n) lives in SubagentCard.tsx outside vlist/; callers inject handlers.
 *
 * Follows the RenderReasoning.tsx / RenderSystemSimple.tsx / RenderPermission.tsx
 * template.
 */

import {
	Badge,
	Box,
	Button,
	Group,
	Loader,
	Paper,
	Text,
	ThemeIcon,
	UnstyledButton,
} from "@mantine/core";
import {
	IconBan,
	IconChevronDown,
	IconChevronRight,
	IconCircleCheck,
	IconCircleX,
	IconRobot,
} from "@tabler/icons-react";
import type { CSSProperties, ReactNode } from "react";
import {
	BADGE_ROW_HEIGHT,
	BLOCK_PADDING_X,
	CARD_PADDING,
	CHEVRON_SIZE,
	DESC_LEFT,
	DESC_MARGIN_TOP,
	type MeasuredSubagent,
	PENDING_CARD_BORDER,
	PROMPT_BODY_MARGIN_TOP,
	PROMPT_TOGGLE_ROW_HEIGHT,
	RECENT_ROW_HEIGHT,
	RECENT_STACK_GAP,
	RECENT_TITLE_MARGIN_BOTTOM,
	RESULT_MD_PADDING_BLOCK,
	RESULT_MD_PADDING_INLINE,
	SELF_PERMISSION_MARGIN_X,
	STATUS_ICON_SIZE,
	THEME_ICON_SIZE,
	XS_LINE_HEIGHT,
} from "../measure/measure-subagent";
import type { ToolCategory } from "../measure/measure-tool-call";
// The recent-call rows ARE trace rows, so their lane geometry comes from the trace
// height model rather than a second set of numbers.
import { TRACE_CHEVRON, TRACE_ROW_GAP, TRACE_ROW_ICON } from "../measure/measure-tool-run";
import { VListContentViewHost, type VListViewControls } from "../VListContentViewHost";
import {
	findViewTarget,
	PROMPT_SLOT,
	RESULT_SLOT,
	type VListViewTarget,
} from "../vlist-content-view-target";
import { categoryIcon } from "./category-icons";
import { RenderMarkdown } from "./RenderMarkdown";
import { RenderInlinePermission } from "./RenderPermission";
import { CATEGORY_COLOR, ToolTimingArea, type ToolTimingLabels } from "./RenderToolCall";
import {
	hasToolRowStatusMark,
	isTerminalToolRowStatus,
	TRACE_ROW_STATUS_SLOT_STYLE,
	TraceRowStatusGlyph,
} from "./trace-row-status";

/** i18n-facing labels, injected by the dispatch/registry layer. English defaults
 * keep this self-contained (no i18n import across the vlist edge). */
export interface SubagentLabels {
	/** Recent-calls section title ("Recent calls"). */
	recentCalls?: string;
	/** "Open full session" button label. */
	openSession?: string;
	/** Prompt toggle label ("Prompt"). */
	prompt?: string;
	/** Pending-permission section title ("Waiting for permission"). */
	pendingTitle?: string;
	/** Resolve-override button label ("Resolve override"). */
	resolveOverride?: string;
	/** Waiting-permission badge label (header). */
	waitingBadge?: string;
	/** Background badge label. */
	backgroundBadge?: string;
	/**
	 * Timing popover strings for the header + recent-call rows. Absent → the render
	 * layer's English fallbacks. Height-neutral (portaled popover / fixed rows).
	 */
	timing?: ToolTimingLabels;
}

const DEFAULT_LABELS: Required<Omit<SubagentLabels, "timing">> = {
	recentCalls: "Recent calls",
	openSession: "Open full session",
	prompt: "Prompt",
	pendingTitle: "Waiting for permission",
	resolveOverride: "Resolve override",
	waitingBadge: "Awaiting permission",
	backgroundBadge: "Background",
};

/**
 * Labels after merging the defaults: every string is present, while `timing` stays
 * optional because ToolTimingArea owns its own English fallback bundle.
 */
type ResolvedSubagentLabels = Required<Omit<SubagentLabels, "timing">> &
	Pick<SubagentLabels, "timing">;

interface RenderSubagentProps {
	measured: MeasuredSubagent;
	/** Description line text (collapsed truncate / expanded wrap). */
	description: string;
	/** Agent-type badge label. */
	agentType?: string;
	/** Extra background badge. */
	isBackground?: boolean;
	/** Extra model badge. */
	model?: string;
	/** Extra thinking-effort badge (cyan), mirroring SubagentCard.tsx. */
	reasoningEffort?: string;
	/** Collapsed result preview text (first ~120 chars). */
	resultPreview?: string;
	/** Prompt body text (shown when the prompt block is open). */
	promptText?: string;
	/** Recent activity call tool names (≤3 drawn). */
	recentCallNames?: string[];
	/** Header status: active shows a Loader, else a status glyph (per `status`). */
	isActive?: boolean;
	/** Raw terminal status for the glyph (success/fail/cancelled). Render-only. */
	status?: string;
	labels?: SubagentLabels;
	/** Header + description toggle (expand/collapse). */
	onToggle?: () => void;
	/** Prompt toggle click. */
	onTogglePrompt?: () => void;
	/** "Open full session" click. */
	onOpenSession?: () => void;
	/** Resolve-override click. */
	onResolveOverride?: () => void;
	/**
	 * Live permission form node (real InlinePermission / AskUserQuestionBanner) for
	 * a subagent that is itself requesting permission. When set, the card grows to
	 * fit it (real height corrected after paint via the shell's onUnknownHeight)
	 * instead of clipping to the arithmetic height.
	 */
	permissionSlot?: ReactNode;
	/**
	 * Fullscreen-viewer wiring for this card's prompt / result bodies
	 * (`resolveSubagentViewTargets`) plus the shell's per-body wrap + source state.
	 * Both absent → the bodies render exactly as before, with no action bar.
	 *
	 * Height-neutral: the action bar is a zero-height absolute overlay, and both
	 * bodies already have measure-fixed heights that scroll internally.
	 */
	viewTargets?: readonly VListViewTarget[];
	viewControls?: VListViewControls;
}

function cssColor(color: string, shade: number): string {
	return `var(--mantine-color-${color}-${shade})`;
}

/**
 * Terminal-status glyph (StatusIcon parity): green check on success, red X on
 * fail/error, orange ban on cancelled. Falls back to a green check for unknown
 * terminal states. Height-neutral (fixed 14px header slot).
 */
function SubagentStatusGlyph({ status }: { status?: string }) {
	if (status === "fail" || status === "error") {
		return <IconCircleX size={STATUS_ICON_SIZE} style={{ color: cssColor("red", 6) }} />;
	}
	if (status === "cancelled") {
		return <IconBan size={STATUS_ICON_SIZE} style={{ color: cssColor("orange", 6) }} />;
	}
	return <IconCircleCheck size={STATUS_ICON_SIZE} style={{ color: cssColor("green", 6) }} />;
}

/**
 * The chevron/dot lane of a trace row. Restated here (rather than imported from
 * `RenderToolRun`) only because that module's copy is module-private; both derive
 * from the same `TRACE_CHEVRON` width, so they cannot disagree on geometry.
 */
const TRACE_CHEVRON_SLOT_STYLE = {
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	width: TRACE_CHEVRON,
	minWidth: TRACE_CHEVRON,
	flexShrink: 0,
} as const satisfies CSSProperties;

/** The "•" marker's own metrics (parity with RenderToolRun / CollapsibleTrace). */
const DOT_STYLE = { opacity: 0.5, lineHeight: 1, fontSize: 10 } as const satisfies CSSProperties;

/** Glyph inset inside the 14px category chip (parity with the trace row). */
const TRACE_ROW_GLYPH_SIZE = 9;

/** Row titles are capped so one long summary cannot dominate the card. */
const RECENT_TITLE_MAX_CHARS = 80;

/**
 * `Tool · summary` for one recent-call row — the same wording a folded trace row
 * uses (`truncateTitle` + `Task → Agent` in the adapter).
 *
 * Restated inside vlist/ rather than imported from `tool-display`: the isolation
 * guard forbids vlist from statically importing the chunk render path, which is
 * what keeps the flag-off bundle free of vlist and vice versa. The rule is small
 * enough that a copy is safe; the SUMMARY itself still comes from the one shared
 * formatter, through the resolver the shell injects.
 *
 * Height-neutral: the result is painted on a single truncating line.
 */
function recentCallTitle(toolName: string, summary: string | null): string {
	const name = toolName === "Task" ? "Agent" : toolName;
	const text = summary ? `${name} · ${summary}` : name;
	return text.length > RECENT_TITLE_MAX_CHARS
		? `${text.slice(0, RECENT_TITLE_MAX_CHARS - 3)}…`
		: text;
}

/**
 * A recent-call row's category chip — the SAME 14px tinted tile a folded trace row
 * shows, so one child tool call reads identically in both places.
 *
 * `category` is resolved by the adapter (the row carries no full tool input, so it
 * comes from the tool NAME alone, exactly as the chunked row does). Absent →
 * `categoryIcon`'s generic fallback, which keeps the slot occupied rather than
 * collapsing it and shortening the row.
 */
function RecentCallCategoryChip({
	category,
	toolName,
}: {
	category: string | null;
	toolName: string;
}) {
	const resolved = (category ?? "generic") as ToolCategory;
	const Icon = categoryIcon(resolved, toolName);
	return (
		// Same `data-trace-row-chip` marker a folded trace row's chip carries — the two
		// rows are one shape, so a parity test must be able to find both the same way.
		<ThemeIcon
			data-trace-row-chip
			size={TRACE_ROW_ICON}
			variant="light"
			color={CATEGORY_COLOR[resolved] ?? "gray"}
			radius="sm"
			data-testid="subagent-activity-category-chip"
		>
			<Icon size={TRACE_ROW_GLYPH_SIZE} />
		</ThemeIcon>
	);
}

/**
 * One recent-call row's timing slot.
 *
 * Absent when the measure layer carried no timing for that row (a header that
 * arrived without a `timing` payload), so an activity row without stamps looks
 * exactly as it does today.
 */
function RecentCallTiming({
	timing,
	labels,
}: {
	timing: MeasuredSubagent["recentCallTimings"][number] | undefined;
	labels?: ToolTimingLabels;
}) {
	if (!timing) return null;
	return (
		<ToolTimingArea
			running={!isTerminalToolRowStatus(timing.status)}
			startedAt={timing.startedAt ?? timing.createdAt}
			durationMs={timing.durationMs}
			timing={timing}
			labels={labels}
		/>
	);
}

/** Render a SubagentCard from its MeasuredSubagent. */
export function RenderSubagent(props: RenderSubagentProps) {
	const { measured, permissionSlot } = props;
	const labels = { ...DEFAULT_LABELS, ...props.labels };
	const inner = <SubagentInner {...props} labels={labels} />;
	const hasPermission = permissionSlot !== undefined;

	// A live permission form is a relative-flow block appended below the absolutely
	// positioned card content, pushed down by the card's arithmetic height. It
	// grows the card naturally; the shell measures the resulting row height and
	// corrects geometry (onUnknownHeight), so the fixed-height/clip model is
	// dropped only while a permission is pending.
	const permissionRegion = hasPermission ? (
		<div style={{ position: "relative", padding: "0 var(--mantine-spacing-xs)" }}>
			{permissionSlot}
		</div>
	) : null;

	// inRun (borderHeight 0) → no frame; else wrap in a bordered Paper.
	if (measured.borderHeight === 0) {
		return (
			<div
				style={
					hasPermission
						? { position: "relative" }
						: { position: "relative", height: measured.height }
				}
			>
				<div style={{ position: "relative", height: measured.height }}>{inner}</div>
				{permissionRegion}
			</div>
		);
	}
	return (
		<Paper
			withBorder
			radius="sm"
			style={{
				overflow: hasPermission ? "visible" : "hidden",
				...(hasPermission ? { minHeight: measured.height } : { height: measured.height }),
				boxSizing: "border-box",
				borderColor:
					hasPermission || measured.selfPermissionBlockHeight > 0 || measured.pendingBlockHeight > 0
						? cssColor("yellow", 6)
						: undefined,
			}}
		>
			<div style={{ position: "relative", height: measured.height - measured.borderHeight }}>
				{inner}
			</div>
			{permissionRegion}
		</Paper>
	);
}

function SubagentInner({
	measured,
	description,
	agentType = "agent",
	isBackground,
	model,
	reasoningEffort,
	resultPreview,
	promptText,
	recentCallNames = [],
	isActive,
	status,
	labels,
	onToggle,
	onTogglePrompt,
	onOpenSession,
	onResolveOverride,
	viewTargets,
	viewControls,
}: RenderSubagentProps & { labels: ResolvedSubagentLabels }) {
	const active = isActive === true;
	// Agent-type badge colour (mirrors SubagentCard.tsx agentBadgeColor).
	const agentBadgeColor = ["explore", "plan", "general", "agent", "send"].includes(agentType)
		? "indigo"
		: "teal";
	let top = 0;

	// ── Header ──────────────────────────────────────────────────────────────
	const header = (
		// Visual copy: the header is a click-to-toggle region (like RenderReasoning's
		// Group onClick). The live keyboard/ARIA affordances live in SubagentCard.tsx
		// outside vlist/. A Mantine Box (not a raw div) keeps the interactive handler
		// off a static host element and avoids invalid nested-interactive HTML when
		// the expanded description renders markdown links.
		<Box
			key="header"
			onClick={onToggle}
			style={{
				position: "absolute",
				top,
				left: 0,
				right: 0,
				height: measured.headerHeight,
				padding: CARD_PADDING,
				boxSizing: "border-box",
				cursor: "pointer",
			}}
		>
			<Group gap={5} wrap="nowrap" style={{ height: BADGE_ROW_HEIGHT }}>
				<ThemeIcon size={THEME_ICON_SIZE} variant="light" color={agentBadgeColor} radius="sm">
					<IconRobot size={10} />
				</ThemeIcon>
				<Badge size="xs" variant="light" color={agentBadgeColor}>
					{agentType}
				</Badge>
				{isBackground ? (
					<Badge size="xs" variant="light" color="blue">
						{labels.backgroundBadge}
					</Badge>
				) : null}
				{model ? (
					<Badge data-testid="subagent-model" size="xs" variant="light" color="violet">
						{model}
					</Badge>
				) : null}
				{reasoningEffort ? (
					<Badge data-testid="subagent-reasoning-effort" size="xs" variant="light" color="cyan">
						{reasoningEffort}
					</Badge>
				) : null}
				<Box style={{ flex: 1, minWidth: 0 }} />
				{active ? (
					<Loader size={STATUS_ICON_SIZE} color="blue" />
				) : (
					<SubagentStatusGlyph status={status} />
				)}
				{/* Header timing (SubagentCard.tsx:623 parity): elapsed while the child is
				    still working, else its total duration, with the lifecycle breakdown in
				    a portaled popover. Shares the fixed badge row → height-neutral. */}
				<ToolTimingArea
					running={active}
					startedAt={measured.timing.startedAt ?? measured.timing.createdAt}
					durationMs={measured.timing.durationMs}
					timing={measured.timing}
					labels={labels.timing}
				/>
				{measured.effectiveExpanded ? (
					<IconChevronDown size={CHEVRON_SIZE} />
				) : (
					<IconChevronRight size={CHEVRON_SIZE} />
				)}
			</Group>

			{/* Description: expanded → wrapped markdown-like inline; collapsed → truncate. */}
			<div
				style={{
					marginTop: DESC_MARGIN_TOP,
					marginLeft: DESC_LEFT,
					height: measured.descriptionHeight,
				}}
			>
				{measured.effectiveExpanded && measured.descriptionMeasured ? (
					<RenderMarkdown measured={measured.descriptionMeasured} />
				) : (
					<Text size="xs" c="dimmed" truncate>
						{description}
					</Text>
				)}
			</div>

			{measured.hasResultPreview ? (
				<Text size="xs" c="dimmed" mt={2} ml={DESC_LEFT} truncate opacity={0.7}>
					→ {resultPreview}
				</Text>
			) : null}
		</Box>
	);
	top += measured.headerHeight;

	// ── Recent calls ──────────────────────────────────────────────────────────
	let recentCalls: React.ReactNode = null;
	if (measured.recentCallsHeight > 0) {
		const rows = recentCallNames.slice(0, measured.recentRowCount);
		recentCalls = (
			<div
				key="recent"
				style={{
					position: "absolute",
					top,
					left: 0,
					right: 0,
					height: measured.recentCallsHeight,
					paddingLeft: BLOCK_PADDING_X,
					paddingRight: BLOCK_PADDING_X,
					paddingBottom: BLOCK_PADDING_X,
					boxSizing: "border-box",
				}}
			>
				<Group justify="space-between" mb={RECENT_TITLE_MARGIN_BOTTOM} wrap="nowrap">
					<Text size="xs" c="dimmed" fw={500}>
						{labels.recentCalls}
					</Text>
					{measured.hasRecentCallsButton ? (
						<Button
							size="compact-xs"
							variant="subtle"
							onClick={(e) => {
								e.stopPropagation();
								onOpenSession?.();
							}}
						>
							{labels.openSession}
						</Button>
					) : null}
				</Group>
				<div style={{ display: "flex", flexDirection: "column", gap: RECENT_STACK_GAP }}>
					{rows.map((name, i) => (
						// A TRACE ROW, not a tinted button: dot + category chip + one
						// `Tool · summary` line + status + timing, at the trace row's own height
						// (RECENT_ROW_HEIGHT === TRACE_ROW_HEIGHT). Still a button, because
						// clicking opens the child session — disabled (plain surface) when no
						// child is known, so the affordance never no-ops. Fixed height either
						// way, so the measured geometry is unaffected.
						<UnstyledButton
							// biome-ignore lint/suspicious/noArrayIndexKey: recent rows are a stable ordered slice
							key={i}
							data-testid="subagent-activity"
							disabled={!onOpenSession}
							onClick={
								onOpenSession
									? (e) => {
											e.stopPropagation();
											onOpenSession();
										}
									: undefined
							}
							style={{
								display: "block",
								width: "100%",
								height: RECENT_ROW_HEIGHT,
								boxSizing: "border-box",
								cursor: onOpenSession ? "pointer" : "default",
							}}
						>
							<Group gap={TRACE_ROW_GAP} wrap="nowrap" h="100%" align="center">
								{/* Dot, not a chevron: an activity row has nothing to expand. */}
								<Box style={TRACE_CHEVRON_SLOT_STYLE}>
									<Text span size="xs" c="dimmed" style={DOT_STYLE}>
										•
									</Text>
								</Box>
								<RecentCallCategoryChip
									category={measured.recentCallCategories[i]}
									toolName={name}
								/>
								{/* `flex: 0 1 auto` (not `flex: 1`) keeps the status + duration HUGGING
								    this label rather than pinned to the row's right edge — see the
								    trace row, whose layout this mirrors. */}
								<Text
									data-testid="subagent-activity-label"
									size="xs"
									c="dimmed"
									truncate
									style={{ flex: "0 1 auto", minWidth: 0 }}
								>
									{recentCallTitle(name, measured.recentCallSummaries[i] ?? null)}
								</Text>
								{/* Only DEVIATION is marked (in flight / failed / cancelled); a
								    successful call draws nothing, so the slot is absent rather than
								    blank — see @shared/tool-row-status. */}
								{hasToolRowStatusMark(measured.recentCallTimings[i]?.status) ? (
									<Box data-testid="trace-row-status-slot" style={TRACE_ROW_STATUS_SLOT_STYLE}>
										<TraceRowStatusGlyph status={measured.recentCallTimings[i]?.status} />
									</Box>
								) : null}
								{/* Per-row timing (SubagentCard.tsx:684 parity). `recentCallTimings`
								    is sliced to the drawn rows by the measure layer, so index i
								    pairs with this row's name. */}
								<RecentCallTiming timing={measured.recentCallTimings[i]} labels={labels.timing} />
								{/* Absorbs the slack so the cells above stay left-packed. */}
								<Box style={{ flex: 1, minWidth: 0 }} />
							</Group>
						</UnstyledButton>
					))}
				</div>
			</div>
		);
		top += measured.recentCallsHeight;
	}

	// ── LazyCollapse body ───────────────────────────────────────────────────────
	let body: React.ReactNode = null;
	if (measured.effectiveExpanded && measured.expandedHeight > 0) {
		body = (
			<div
				key="body"
				style={{
					position: "absolute",
					top,
					left: 0,
					right: 0,
					height: measured.expandedHeight,
				}}
			>
				<SubagentBody
					measured={measured}
					labels={labels}
					promptText={promptText}
					onTogglePrompt={onTogglePrompt}
					onResolveOverride={onResolveOverride}
					viewTargets={viewTargets}
					viewControls={viewControls}
				/>
			</div>
		);
		top += measured.expandedHeight;
	}

	// ── Divider (inRun && !isLast) ───────────────────────────────────────────────
	const divider =
		measured.dividerHeight > 0 ? (
			<div
				key="divider"
				style={{
					position: "absolute",
					top,
					left: 0,
					right: 0,
					height: measured.dividerHeight,
					background: "var(--mantine-color-default-border)",
				}}
			/>
		) : null;

	return (
		<>
			{header}
			{recentCalls}
			{body}
			{divider}
		</>
	);
}

// ── expanded body: stacks the sub-blocks at their measured heights ───────────
function SubagentBody({
	measured,
	labels,
	promptText,
	onTogglePrompt,
	onResolveOverride,
	viewTargets,
	viewControls,
}: {
	measured: MeasuredSubagent;
	labels: ResolvedSubagentLabels;
	promptText?: string;
	onTogglePrompt?: () => void;
	onResolveOverride?: () => void;
	/** The card's viewer bodies (prompt / result) + the shell's view controls. */
	viewTargets?: readonly VListViewTarget[];
	viewControls?: VListViewControls;
}) {
	let top = 0;
	const parts: React.ReactNode[] = [];
	const promptTarget = findViewTarget(viewTargets, PROMPT_SLOT);
	const promptWrapped = promptTarget ? viewControls?.isWrapped(promptTarget) !== false : true;
	const resultTarget = findViewTarget(viewTargets, RESULT_SLOT);

	// selfPermission (Box mx="xs" mb="xs" + InlinePermission).
	if (measured.selfPermissionBlockHeight > 0 && measured.selfPermissionMeasured) {
		parts.push(
			<div
				key="self-perm"
				style={{
					position: "absolute",
					top,
					left: SELF_PERMISSION_MARGIN_X,
					right: SELF_PERMISSION_MARGIN_X,
					height: measured.selfPermissionBlockHeight,
				}}
			>
				<RenderInlinePermission
					measured={measured.selfPermissionMeasured}
					includeTopMargin={false}
				/>
			</div>,
		);
		top += measured.selfPermissionBlockHeight;
	}

	// prompt (toggle row + optional ContentViewer body).
	if (measured.promptBlockHeight > 0) {
		const promptOpen = measured.promptMeasured != null;
		parts.push(
			<div
				key="prompt"
				style={{
					position: "absolute",
					top,
					left: 0,
					right: 0,
					height: measured.promptBlockHeight,
					paddingLeft: BLOCK_PADDING_X,
					paddingRight: BLOCK_PADDING_X,
					paddingBottom: BLOCK_PADDING_X,
					boxSizing: "border-box",
				}}
			>
				<Group
					data-testid="subagent-prompt-toggle"
					gap={4}
					wrap="nowrap"
					style={{ height: PROMPT_TOGGLE_ROW_HEIGHT, cursor: "pointer" }}
					onClick={onTogglePrompt}
				>
					{promptOpen ? (
						<IconChevronDown size={CHEVRON_SIZE} />
					) : (
						<IconChevronRight size={CHEVRON_SIZE} />
					)}
					<Text size="xs" c="dimmed" fw={500}>
						{labels.prompt}
					</Text>
				</Group>
				{promptOpen && measured.promptMeasured ? (
					<VListContentViewHost target={promptTarget} controls={viewControls}>
						<div
							style={{
								marginTop: PROMPT_BODY_MARGIN_TOP,
								maxHeight: measured.promptBlockHeight - PROMPT_TOGGLE_ROW_HEIGHT - BLOCK_PADDING_X,
								overflow: "auto",
								// Wrap only changes the scroll axis: the box height is already
								// fixed by measure-subagent's prompt cap.
								...(promptWrapped ? { whiteSpace: "pre-wrap" } : { whiteSpace: "pre" }),
								fontSize: 11,
								fontFamily: "var(--mantine-font-family-monospace)",
							}}
						>
							{promptText ?? ""}
						</div>
					</VListContentViewHost>
				) : null}
			</div>,
		);
		top += measured.promptBlockHeight;
	}

	// pendingPermissions (title + placeholder cards — P10 dependency).
	if (measured.pendingBlockHeight > 0) {
		parts.push(
			<div
				key="pending"
				style={{
					position: "absolute",
					top,
					left: 0,
					right: 0,
					height: measured.pendingBlockHeight,
					paddingLeft: BLOCK_PADDING_X,
					paddingRight: BLOCK_PADDING_X,
					paddingBottom: BLOCK_PADDING_X,
					boxSizing: "border-box",
				}}
			>
				<Text size="xs" c="yellow" fw={500} mb={4}>
					{labels.pendingTitle}
				</Text>
				<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
					{Array.from({ length: measured.pendingCardCount }).map((_, i) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: pending cards are a stable ordered list
							key={i}
							style={{
								border: `${PENDING_CARD_BORDER}px solid ${cssColor("yellow", 6)}`,
								borderRadius: 4,
								minHeight: XS_LINE_HEIGHT,
							}}
						/>
					))}
				</div>
			</div>,
		);
		top += measured.pendingBlockHeight;
	}

	// resolveOverride button.
	if (measured.resolveOverrideHeight > 0) {
		parts.push(
			<div
				key="resolve"
				style={{
					position: "absolute",
					top,
					left: 0,
					right: 0,
					height: measured.resolveOverrideHeight,
					paddingLeft: BLOCK_PADDING_X,
					paddingRight: BLOCK_PADDING_X,
					paddingBottom: BLOCK_PADDING_X,
					boxSizing: "border-box",
				}}
			>
				<Button
					size="compact-xs"
					variant="light"
					color="yellow"
					onClick={(e) => {
						e.stopPropagation();
						onResolveOverride?.();
					}}
				>
					{labels.resolveOverride}
				</Button>
			</div>,
		);
		top += measured.resolveOverrideHeight;
	}

	// resultText (ContentViewer maxHeight:300 markdown).
	if (measured.resultBlockHeight > 0 && measured.resultMeasured) {
		parts.push(
			<div
				key="result"
				style={{
					position: "absolute",
					top,
					left: 0,
					right: 0,
					height: measured.resultBlockHeight,
					paddingLeft: BLOCK_PADDING_X,
					paddingRight: BLOCK_PADDING_X,
					paddingBottom: BLOCK_PADDING_X,
					boxSizing: "border-box",
				}}
			>
				<VListContentViewHost target={resultTarget} controls={viewControls}>
					<div
						style={{
							maxHeight: measured.resultBlockHeight - BLOCK_PADDING_X,
							overflow: "auto",
							paddingInline: RESULT_MD_PADDING_INLINE,
							paddingBlock: RESULT_MD_PADDING_BLOCK,
							boxSizing: "border-box",
						}}
					>
						{/* Source view shows the raw markdown in the same fixed-height box,
						    so switching cannot move the card. */}
						{resultTarget && viewControls?.isSourceShown(resultTarget) ? (
							<div
								style={{
									fontSize: 11,
									fontFamily: "var(--mantine-font-family-monospace)",
									whiteSpace: "pre-wrap",
									wordBreak: "break-word",
								}}
							>
								{resultTarget.text}
							</div>
						) : (
							<RenderMarkdown measured={measured.resultMeasured} />
						)}
					</div>
				</VListContentViewHost>
			</div>,
		);
		top += measured.resultBlockHeight;
	}

	return <>{parts}</>;
}
