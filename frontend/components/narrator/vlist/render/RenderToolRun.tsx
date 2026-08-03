/**
 * RenderToolRun.tsx — Render copies for the tool-run "trace" family measured by
 * measure-tool-run.ts (batch-2 P9). Pairs 1:1 with the measure layer: the outer
 * box height equals the predicted height, and every part (header band, "show
 * earlier" toggle, rows, expanded markdown bodies) is drawn at the exact top
 * offset the measure layer resolved — zero DOM measurement.
 *
 * Visual parity targets (NOT imported — this is an isolated vlist copy):
 *   CollapsibleTrace.tsx / ToolRunSummary.tsx / ActivityTrace.tsx /
 *   ReasoningCountLine.tsx / ReasoningStepsTrace.tsx.
 *
 * The header icon / colour is chosen from the measured `variant` (tool traces
 * use a gray wrench, reasoning traces a grape brain). Row icons are optional and
 * caller-driven; if a row has no icon it shows the "•" dot like the original.
 * Expanded step bodies are painted by RenderMarkdown with the SAME fonts the
 * measure layer used, so wrapping matches the predicted height exactly.
 */

import { Box, Group, Text, ThemeIcon } from "@mantine/core";
import {
	IconBrain,
	IconChevronDown,
	IconChevronRight,
	IconDots,
	IconTool,
} from "@tabler/icons-react";
import type { ToolCategory } from "../measure/measure-tool-call";
import {
	type MeasuredCollapsibleTrace,
	type MeasuredTraceCountLine,
	type MeasuredTraceRow,
	TRACE_BODY_BORDER_LEFT,
	TRACE_BODY_PADDING_LEFT,
	TRACE_BODY_PADDING_Y,
	TRACE_CHEVRON,
	TRACE_HEADER_ICON,
	TRACE_HEADER_PADDING_Y,
	TRACE_ROW_GAP,
	TRACE_ROW_HEIGHT,
	TRACE_ROW_ICON,
	TRACE_ROW_PADDING_Y,
	type TraceCountLineKind,
	type TraceVariant,
} from "../measure/measure-tool-run";
import { categoryIcon } from "./category-icons";
import { RenderMarkdown } from "./RenderMarkdown";
import { CATEGORY_COLOR, ToolTimingArea, type ToolTimingLabels } from "./RenderToolCall";
import {
	hasToolRowStatusMark,
	isTerminalToolRowStatus,
	TRACE_ROW_STATUS_SLOT_STYLE,
	TraceRowStatusGlyph,
} from "./trace-row-status";

const CHEVRON_SLOT_WIDTH = 12;
const HEADER_INNER_ICON = 10;
const ROW_INNER_ICON = 9;
const DIMMED = "var(--mantine-color-dimmed)";

/** A row's chip tint from its category, via the vlist render layer's own table. */
function categoryColor(category: string | undefined): string {
	if (!category) return "gray";
	return CATEGORY_COLOR[category as ToolCategory] ?? "gray";
}

/** Header visual per variant (icon + tint). Tool traces gray, reasoning grape. */
function variantHeaderColor(variant: TraceVariant): string {
	return variant === "reasoning-steps" ? "grape" : "gray";
}
function VariantHeaderIcon({ variant }: { variant: TraceVariant }) {
	return variant === "reasoning-steps" ? (
		<IconBrain size={HEADER_INNER_ICON} />
	) : (
		<IconTool size={HEADER_INNER_ICON} />
	);
}

/**
 * Labels the dispatch/registry layer injects (no i18n import across the vlist
 * edge). Sensible English fallbacks keep the component self-contained.
 */
export interface TraceRenderLabels {
	/** "Show earlier N" builder. */
	showEarlier?: (hiddenCount: number) => string;
	/** "Hide earlier" text. */
	hideEarlier?: string;
	/**
	 * Timing popover strings for the per-row duration slot. Absent → the render
	 * layer's English fallbacks. Height-neutral (portaled popover, fixed rows).
	 */
	timing?: ToolTimingLabels;
}

/**
 * Per-row interaction surface supplied by the integration layer. Returning a
 * node wraps the row so it joins the selection / context-menu system; returning
 * null leaves the row plain. Injected (rather than imported) so this render
 * module stays free of hooks and panel wiring — same pattern as `rowIcon`.
 *
 * ⚠️ It receives the row's WHOLE body — the title line plus whatever the row
 * revealed (an expanded markdown body, or a drilled-in tool card) — not just the
 * title line. A drilled-in card is the same tool call the row summarizes, so the
 * two must be ONE interactive block: wrapping only the title line left the
 * revealed card with no right-click menu and no left-swipe, i.e. strictly fewer
 * affordances than the folded row it came from.
 */
export type TraceRowInteractionSlot = (
	row: MeasuredTraceRow,
	rowBody: React.ReactNode,
) => React.ReactNode | null;

/**
 * The nested tool card of a DRILLED-IN row, supplied by the integration layer.
 *
 * Injected rather than imported for the same reason as `rowIcon` / `rowInteraction`:
 * a real `RenderToolCall` needs localized labels, the panel narrator id, the
 * on-demand payload action and the fullscreen-viewer wiring — all shell concerns.
 * Keeping it a slot leaves this module hook-free and free of panel dependencies.
 *
 * Height is already reserved by `row.cardMeasured.height`, so the returned node
 * must render at exactly that height (which `RenderToolCall` does by construction).
 */
export type TraceRowCardSlot = (row: MeasuredTraceRow) => React.ReactNode | null;

interface RenderToolRunProps {
	measured: MeasuredCollapsibleTrace;
	labels?: TraceRenderLabels;
	/** Row icon slot injected by the caller (keeps @tabler category icons out of
	 * vlist). Falls back to a neutral square when a row hasIcon but no slot. */
	rowIcon?: (row: MeasuredTraceRow) => React.ReactNode;
	/** Toggle the whole folded list (ActivityTrace collapseItems header click). */
	onToggleItems?: () => void;
	/** Toggle "show earlier". */
	onToggleEarlier?: () => void;
	/** Toggle one expandable row's body. */
	onToggleRow?: (itemIndex: number) => void;
	/** Wraps each row's title line in an interaction surface (see the type doc). */
	rowInteraction?: TraceRowInteractionSlot;
	/** Renders a drilled-in row's nested tool card (see the type doc). */
	rowCard?: TraceRowCardSlot;
}

/**
 * Render a measured CollapsibleTrace. The outer box height equals the predicted
 * height; the header band, toggle row, and item rows (+ expanded bodies) are
 * absolutely positioned at their measured tops.
 */
export function RenderToolRun({
	measured,
	labels = {},
	rowIcon,
	onToggleItems,
	onToggleEarlier,
	onToggleRow,
	rowInteraction,
	rowCard,
}: RenderToolRunProps) {
	if (measured.itemCount === 0) return null;
	const { header, toggle, rows, variant } = measured;
	const headerColor = variantHeaderColor(variant);

	return (
		<div style={{ position: "relative", width: measured.contentWidth, height: measured.height }}>
			{/* ── Header band ── */}
			<Group
				gap={TRACE_ROW_GAP}
				wrap="nowrap"
				align="center"
				py={TRACE_HEADER_PADDING_Y}
				style={{
					position: "absolute",
					top: header.top,
					left: 0,
					right: 0,
					height: header.height,
					cursor: header.hasChevron ? "pointer" : "default",
					userSelect: "none",
				}}
				onClick={header.hasChevron ? onToggleItems : undefined}
			>
				{header.hasChevron ? (
					header.opened ? (
						<IconChevronDown size={TRACE_CHEVRON} style={{ color: DIMMED }} />
					) : (
						<IconChevronRight size={TRACE_CHEVRON} style={{ color: DIMMED }} />
					)
				) : null}
				<ThemeIcon size={TRACE_HEADER_ICON} variant="light" color={headerColor} radius="sm">
					<VariantHeaderIcon variant={variant} />
				</ThemeIcon>
				<Text size="xs" c="dimmed" fw={500} style={{ flexShrink: 0 }}>
					{header.label}
				</Text>
				<Text size="xs" c="dimmed" style={{ flexShrink: 0, opacity: 0.5 }}>
					{header.count}
				</Text>
			</Group>

			{/* ── "Show earlier" toggle ── */}
			{toggle ? (
				<Group
					gap={TRACE_ROW_GAP}
					wrap="nowrap"
					align="center"
					py={TRACE_ROW_PADDING_Y}
					style={{
						position: "absolute",
						top: toggle.top,
						left: 0,
						right: 0,
						height: toggle.height,
						cursor: "pointer",
						userSelect: "none",
					}}
					onClick={onToggleEarlier}
				>
					<Box style={chevronSlotStyle}>
						<IconDots size={TRACE_CHEVRON} style={{ color: DIMMED, opacity: 0.6 }} />
					</Box>
					<Text size="xs" c="dimmed" style={{ opacity: 0.7 }}>
						{toggle.showEarlier
							? (labels.hideEarlier ?? "Hide earlier")
							: (labels.showEarlier?.(toggle.hiddenCount) ?? `Show ${toggle.hiddenCount} earlier`)}
					</Text>
				</Group>
			) : null}

			{/* ── Rows (+ expanded bodies) ── */}
			{rows.map((row) => (
				<TraceRowView
					key={row.key}
					row={row}
					rowIcon={rowIcon}
					onToggleRow={onToggleRow}
					rowInteraction={rowInteraction}
					rowCard={rowCard}
					timingLabels={labels.timing}
				/>
			))}
		</div>
	);
}

const chevronSlotStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	width: CHEVRON_SLOT_WIDTH,
	justifyContent: "center",
	flexShrink: 0,
};

function TraceRowView({
	row,
	rowIcon,
	onToggleRow,
	rowInteraction,
	rowCard,
	timingLabels,
}: {
	row: MeasuredTraceRow;
	rowIcon?: (row: MeasuredTraceRow) => React.ReactNode;
	onToggleRow?: (itemIndex: number) => void;
	rowInteraction?: TraceRowInteractionSlot;
	rowCard?: TraceRowCardSlot;
	timingLabels?: ToolTimingLabels;
}) {
	const icon = row.hasIcon ? (rowIcon?.(row) ?? <DefaultRowIcon row={row} />) : null;
	const interactive = !!row.identity && !!rowInteraction;
	// A modified click means "select this row", not "expand it" — the interaction
	// wrapper performs the selection, so swallow the toggle.
	const handleToggle = row.expandable
		? (e: React.MouseEvent) => {
				if (interactive && (e.metaKey || e.ctrlKey || e.shiftKey)) return;
				onToggleRow?.(row.itemIndex);
			}
		: undefined;
	const titleRow = (
		<Group
			gap={TRACE_ROW_GAP}
			wrap="nowrap"
			align="center"
			py={TRACE_ROW_PADDING_Y}
			style={{
				height: TRACE_ROW_HEIGHT,
				cursor: row.expandable ? "pointer" : "default",
				userSelect: "none",
			}}
			onClick={handleToggle}
		>
			<Box style={chevronSlotStyle}>
				{row.expandable ? (
					row.expanded ? (
						<IconChevronDown size={TRACE_CHEVRON} style={{ color: DIMMED }} />
					) : (
						<IconChevronRight size={TRACE_CHEVRON} style={{ color: DIMMED }} />
					)
				) : (
					<Text span size="xs" c="dimmed" style={{ opacity: 0.5, lineHeight: 1, fontSize: 10 }}>
						•
					</Text>
				)}
			</Box>
			{icon ? (
				// `data-trace-row-chip`: the marker every compact row's category chip
				// carries, so a parity test can find the SAME lane in a trace row and in a
				// subagent card's recent-call row instead of guessing at each one's markup.
				<ThemeIcon
					data-trace-row-chip
					size={TRACE_ROW_ICON}
					variant="light"
					// `iconColor` is the caller's explicit override (reasoning rows use grape).
					// Absent → derive the tint from the row's own CATEGORY, the same table the
					// tool header and a subagent card's recent-call rows read. Falling back to
					// grey here meant a row whose adapter supplied `category` but not
					// `iconColor` rendered a colourless chip — the one thing the chip exists
					// to avoid.
					color={row.iconColor ?? categoryColor(row.category)}
					radius="sm"
				>
					{icon}
				</ThemeIcon>
			) : null}
			{/* `flex: 0 1 auto` (not `flex: 1`) is what lets the status + duration HUG the
			    title instead of being flung to the row's right edge. A short title keeps
			    them adjacent; a long one truncates and they follow the ellipsis. The
			    trailing spacer below absorbs whatever is left. */}
			<Text
				size="xs"
				c="dimmed"
				truncate
				className={row.shimmer ? "reasoning-step-shimmer" : undefined}
				style={{ flex: "0 1 auto", minWidth: 0 }}
			>
				{row.title || "…"}
			</Text>
			{/* Status + duration, adjacent to the label rather than right-aligned: in a
			    column of rows a far-right number has to be traced back across the gap to
			    find its own row, which is exactly the misreading this avoids.

			    Both live inside the row's fixed 18.8px line — the glyph in a 12px slot,
			    the duration as one nowrap span, popover portaled — so `measure-tool-run`
			    needs no height change (asserted in its tests). */}
			{hasToolRowStatusMark(row.status) ? (
				<Box data-testid="trace-row-status-slot" style={TRACE_ROW_STATUS_SLOT_STYLE}>
					<TraceRowStatusGlyph status={row.status} />
				</Box>
			) : null}
			{row.timing ? (
				<ToolTimingArea
					running={!isTerminalToolRowStatus(row.status)}
					startedAt={row.timing.startedAt ?? row.timing.createdAt}
					durationMs={row.timing.durationMs}
					timing={row.timing}
					labels={timingLabels}
				/>
			) : null}
			{/* Eats the remaining width so the cells above stay left-packed. Zero-height,
			    so it cannot affect the measured row. */}
			<Box style={{ flex: 1, minWidth: 0 }} />
		</Group>
	);

	/**
	 * The row's WHOLE painted block: the fixed title line plus whatever it
	 * revealed. Handed to the interaction slot as one unit, so a drilled-in card
	 * shares the folded row's menu / swipe / selection outline instead of being an
	 * un-interactive sibling next to it.
	 *
	 * `position: relative` (with the measured block height) is what keeps that
	 * regrouping height-neutral: the revealed bodies stay absolutely positioned at
	 * `TRACE_ROW_HEIGHT`, and they now resolve against a box that starts at exactly
	 * the same place and is exactly as tall as the outer row box. It also makes the
	 * geometry independent of the interaction wrapper, which grows a `transform`
	 * (and thus a containing block of its own) the moment a swipe starts.
	 */
	const rowBody = (
		<div style={{ position: "relative", height: row.blockHeight }}>
			{titleRow}

			{/* Expanded markdown body (left-bordered, indented). */}
			{row.expanded && row.body ? (
				<Box
					py={TRACE_BODY_PADDING_Y}
					style={{
						position: "absolute",
						top: TRACE_ROW_HEIGHT,
						left: 0,
						right: 0,
						paddingLeft: TRACE_BODY_PADDING_LEFT,
						borderLeft: `${TRACE_BODY_BORDER_LEFT}px solid var(--mantine-color-grape-9)`,
						opacity: 0.75,
					}}
				>
					<RenderMarkdown measured={row.body} />
				</Box>
			) : null}

			{/* Drilled-in tool card. Same indented body box as the markdown branch, but
			    the rail is neutral (grape is the reasoning lane's colour) and there is
			    no dimming — this is the payload the reader explicitly asked for, and the
			    card draws its own border + status tint. */}
			{row.expanded && row.cardMeasured ? (
				<Box
					py={TRACE_BODY_PADDING_Y}
					style={{
						position: "absolute",
						top: TRACE_ROW_HEIGHT,
						left: 0,
						right: 0,
						paddingLeft: TRACE_BODY_PADDING_LEFT,
						borderLeft: `${TRACE_BODY_BORDER_LEFT}px solid var(--mantine-color-dark-4)`,
					}}
				>
					{rowCard?.(row) ?? null}
				</Box>
			) : null}
		</div>
	);

	return (
		<Box
			// LOD-independent identity of this row's content: the same value the full
			// card carries at L3+, so the two renderings of one tool call can be paired
			// across a level change. Height-neutral (a data attribute).
			data-nf-unit={row.unitId}
			style={{
				position: "absolute",
				top: row.top,
				left: 0,
				right: 0,
				height: row.blockHeight,
			}}
		>
			{(interactive ? rowInteraction?.(row, rowBody) : null) ?? rowBody}
		</Box>
	);
}

/**
 * Default row glyph: the real category icon for tool rows (from the row's
 * toolName/category), a grape brain for reasoning steps, else a neutral wrench.
 * Height-neutral — the icon sits in the fixed 9px inner lane of the 14px chip.
 */
function DefaultRowIcon({ row }: { row: MeasuredTraceRow }) {
	if (row.category) {
		const Icon = categoryIcon(row.category as ToolCategory, row.toolName);
		return <Icon size={ROW_INNER_ICON} />;
	}
	// Reasoning-step rows carry no category (grape icon color) → brain glyph.
	if (row.iconColor === "grape") return <IconBrain size={ROW_INNER_ICON} />;
	return <IconTool size={ROW_INNER_ICON} />;
}

// ── Count lines (single-row ToolRunCountLine / ReasoningCountLine) ───────────

/** Labels for a count line (height-neutral). */
export interface CountLineRenderLabels {
	/** Bold label, e.g. "Tool calls" / "Reasoning". */
	label?: string;
	/** Dimmed count text, e.g. "5 calls" / "5 steps". */
	count?: string;
}

interface RenderTraceCountLineProps {
	measured: MeasuredTraceCountLine;
	labels?: CountLineRenderLabels;
	/** Clicking expands to the full trace/reasoning view (caller override). */
	onExpand?: () => void;
}

function countLineColor(kind: TraceCountLineKind): string {
	return kind === "reasoning" ? "grape" : "gray";
}
function CountLineIcon({ kind }: { kind: TraceCountLineKind }) {
	return kind === "reasoning" ? (
		<IconBrain size={HEADER_INNER_ICON} />
	) : (
		<IconTool size={HEADER_INNER_ICON} />
	);
}

/**
 * Render a single-row count line (ToolRunCountLine / ReasoningCountLine). The
 * outer box height equals the predicted height (≈20.8px).
 */
export function RenderTraceCountLine({
	measured,
	labels = {},
	onExpand,
}: RenderTraceCountLineProps) {
	const { kind } = measured;
	return (
		<Group
			gap={TRACE_ROW_GAP}
			wrap="nowrap"
			align="center"
			py={TRACE_HEADER_PADDING_Y}
			style={{
				height: measured.height,
				cursor: onExpand ? "pointer" : "default",
				userSelect: "none",
			}}
			onClick={onExpand}
		>
			<ThemeIcon size={TRACE_HEADER_ICON} variant="light" color={countLineColor(kind)} radius="sm">
				<CountLineIcon kind={kind} />
			</ThemeIcon>
			<Text size="xs" c="dimmed" fw={500}>
				{labels.label ?? (kind === "reasoning" ? "Reasoning" : "Tool calls")}
			</Text>
			<Text size="xs" c="dimmed" style={{ opacity: 0.5 }}>
				{labels.count ?? `${measured.count}`}
			</Text>
			<Box style={{ flex: 1 }} />
			{onExpand ? <IconChevronRight size={TRACE_CHEVRON} style={{ color: DIMMED }} /> : null}
		</Group>
	);
}

export const RENDER_TOOL_RUN_CHROME = {
	CHEVRON_SLOT_WIDTH,
	HEADER_INNER_ICON,
	ROW_INNER_ICON,
} as const;
