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
 *   - recent calls (always when present): title row + ≤3 activity rows.
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

import { Badge, Box, Button, Group, Loader, Paper, Text, ThemeIcon } from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconCircleCheck, IconRobot } from "@tabler/icons-react";
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
import { RenderMarkdown } from "./RenderMarkdown";
import { RenderInlinePermission } from "./RenderPermission";

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
}

const DEFAULT_LABELS: Required<SubagentLabels> = {
	recentCalls: "Recent calls",
	openSession: "Open full session",
	prompt: "Prompt",
	pendingTitle: "Waiting for permission",
	resolveOverride: "Resolve override",
	waitingBadge: "Awaiting permission",
	backgroundBadge: "Background",
};

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
	/** Collapsed result preview text (first ~120 chars). */
	resultPreview?: string;
	/** Prompt body text (shown when the prompt block is open). */
	promptText?: string;
	/** Recent activity call tool names (≤3 drawn). */
	recentCallNames?: string[];
	/** Header status: active shows a Loader, else a check icon. */
	isActive?: boolean;
	labels?: SubagentLabels;
	/** Header + description toggle (expand/collapse). */
	onToggle?: () => void;
	/** Prompt toggle click. */
	onTogglePrompt?: () => void;
	/** "Open full session" click. */
	onOpenSession?: () => void;
	/** Resolve-override click. */
	onResolveOverride?: () => void;
}

function cssColor(color: string, shade: number): string {
	return `var(--mantine-color-${color}-${shade})`;
}

/** Render a SubagentCard from its MeasuredSubagent. */
export function RenderSubagent(props: RenderSubagentProps) {
	const { measured } = props;
	const labels = { ...DEFAULT_LABELS, ...props.labels };
	const inner = <SubagentInner {...props} labels={labels} />;

	// inRun (borderHeight 0) → no frame; else wrap in a bordered Paper.
	if (measured.borderHeight === 0) {
		return <div style={{ position: "relative", height: measured.height }}>{inner}</div>;
	}
	return (
		<Paper
			withBorder
			radius="sm"
			style={{
				overflow: "hidden",
				height: measured.height,
				boxSizing: "border-box",
				borderColor:
					measured.selfPermissionBlockHeight > 0 || measured.pendingBlockHeight > 0
						? cssColor("yellow", 6)
						: undefined,
			}}
		>
			<div style={{ position: "relative", height: measured.height - measured.borderHeight }}>
				{inner}
			</div>
		</Paper>
	);
}

function SubagentInner({
	measured,
	description,
	agentType = "agent",
	isBackground,
	model,
	resultPreview,
	promptText,
	recentCallNames = [],
	isActive,
	labels,
	onToggle,
	onTogglePrompt,
	onOpenSession,
	onResolveOverride,
}: RenderSubagentProps & { labels: Required<SubagentLabels> }) {
	const active = isActive === true;
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
				<ThemeIcon size={THEME_ICON_SIZE} variant="light" color="indigo" radius="sm">
					<IconRobot size={10} />
				</ThemeIcon>
				<Badge size="xs" variant="light" color="indigo">
					{agentType}
				</Badge>
				{isBackground ? (
					<Badge size="xs" variant="light" color="blue">
						{labels.backgroundBadge}
					</Badge>
				) : null}
				{model ? (
					<Badge size="xs" variant="light" color="violet">
						{model}
					</Badge>
				) : null}
				<Box style={{ flex: 1, minWidth: 0 }} />
				{active ? (
					<Loader size={STATUS_ICON_SIZE} color="blue" />
				) : (
					<IconCircleCheck size={STATUS_ICON_SIZE} style={{ color: cssColor("green", 6) }} />
				)}
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
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: recent rows are a stable ordered slice
							key={i}
							style={{
								height: RECENT_ROW_HEIGHT,
								padding: "5px 7px",
								borderRadius: "var(--mantine-radius-sm)",
								background: "var(--mantine-color-default-hover)",
								boxSizing: "border-box",
							}}
						>
							<Group gap={6} wrap="nowrap" h="100%" align="center">
								<IconCircleCheck
									size={STATUS_ICON_SIZE}
									style={{ color: cssColor("gray", 6), flexShrink: 0 }}
								/>
								<Text size="xs" truncate style={{ flex: 1 }}>
									{name}
								</Text>
							</Group>
						</div>
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
}: {
	measured: MeasuredSubagent;
	labels: Required<SubagentLabels>;
	promptText?: string;
	onTogglePrompt?: () => void;
	onResolveOverride?: () => void;
}) {
	let top = 0;
	const parts: React.ReactNode[] = [];

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
					<div
						style={{
							marginTop: PROMPT_BODY_MARGIN_TOP,
							maxHeight: measured.promptBlockHeight - PROMPT_TOGGLE_ROW_HEIGHT - BLOCK_PADDING_X,
							overflow: "auto",
							whiteSpace: "pre-wrap",
							fontSize: 11,
							fontFamily: "var(--mantine-font-family-monospace)",
						}}
					>
						{promptText ?? ""}
					</div>
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
				<div
					style={{
						maxHeight: measured.resultBlockHeight - BLOCK_PADDING_X,
						overflow: "auto",
						paddingInline: RESULT_MD_PADDING_INLINE,
						paddingBlock: RESULT_MD_PADDING_BLOCK,
						boxSizing: "border-box",
					}}
				>
					<RenderMarkdown measured={measured.resultMeasured} />
				</div>
			</div>,
		);
		top += measured.resultBlockHeight;
	}

	return <>{parts}</>;
}
