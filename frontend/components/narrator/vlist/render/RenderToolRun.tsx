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
 *
 * ── ON HOOKS IN THIS MODULE ──────────────────────────────────────────────────
 * This module is otherwise hook-free, which is why localized labels, row icons,
 * interaction surfaces and nested cards all arrive as injected slots. `TraceRowView`
 * is the one deliberate exception: a row's CLOSING shimmer is a timed transition
 * (in-flight → settled, then gone), so something must remember the previous status.
 * It resolves nothing but a `className` which it passes down to whichever label
 * branch the row renders, and it is height-neutral by construction — the row shimmer
 * only recolours text (see `frontend/styles/trace-shimmer.css`), so no state here can
 * move any geometry. Do not grow it into a general-purpose row hook; anything
 * touching layout belongs in a slot, as before.
 *
 * ⚠️ The hook lives at `TraceRowView`, ONE call per row, and must stay there. It used
 * to be called inside both label branches (`TraceRowTitle` and `LiveTailText`), which
 * gave one row two independent prev-status memories: a row switching between the
 * branches (a live tail appearing or ending) changed component type, remounted, and
 * lost the transition that was in flight — so the closing flash for the step that
 * just finished never played.
 */

import { Box, Group, Text, ThemeIcon } from "@mantine/core";
import {
	resolveToolShimmerFlash,
	resolveToolShimmerPhase,
	type ToolShimmerFlash,
	type ToolShimmerKind,
	TRACE_SHIMMER_CLASS,
} from "@shared/tool-shimmer";
import {
	IconBrain,
	IconChevronDown,
	IconChevronRight,
	IconDots,
	IconTool,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
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
import { activateOnKey } from "./key-activate";
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
	if (variant === "reasoning-steps") return "grape";
	return "gray";
}
function VariantHeaderIcon({ variant }: { variant: TraceVariant }) {
	if (variant === "reasoning-steps") return <IconBrain size={HEADER_INNER_ICON} />;
	return <IconTool size={HEADER_INNER_ICON} />;
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
	 * Size prefix of a live reasoning row's scrolling tail ("1234 字符"). A builder
	 * because the number is per-row; the renderer appends `…` + the tail itself.
	 */
	liveTailChars?: (formatted: string) => string;
	/**
	 * Timing popover strings for the per-row duration slot. Absent → the render
	 * layer's English fallbacks. Height-neutral (portaled popover, fixed rows).
	 */
	timing?: ToolTimingLabels;
	/**
	 * One name per shimmer state, for readers who cannot use the colour.
	 *
	 * The row's five shimmer states are carried by COLOUR ALONE, which reaches
	 * neither a screen reader nor a colour-blind reader — and two of them (green
	 * success / red failure) are the pair that matters most. The names go on the row
	 * as a `title` + `aria-label`, so they are attributes only and cannot move
	 * geometry.
	 */
	shimmerState?: Partial<Record<ToolShimmerKind, string>>;
}

/** English names for the five shimmer states, used when no labels are injected. */
const DEFAULT_SHIMMER_STATE_LABELS: Readonly<Record<ToolShimmerKind, string>> = {
	streaming: "receiving input",
	reflecting: "under review",
	running: "running",
	success: "succeeded",
	failed: "failed",
};

function shimmerStateLabel(
	kind: ToolShimmerKind | null,
	labels: TraceRenderLabels["shimmerState"],
): string | undefined {
	if (!kind) return undefined;
	return labels?.[kind] ?? DEFAULT_SHIMMER_STATE_LABELS[kind];
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
 * Live tails for streaming rows, keyed by row key, supplied by the integration
 * layer from the FRESHLY ADAPTED spec.
 *
 * Why not read it off `row` (the measured payload): a trace's measured result is
 * served from the measurement cache, whose key deliberately ignores the tail (a
 * per-delta key would mint one cache entry per frame — see
 * `shared/pretext-layout/reasoning-live-tail.ts`). So the measured row can be a
 * cache hit carrying a stale tail, while `spec.data` is rebuilt every frame. This
 * map is the fresh channel, exactly like `rowCard`.
 *
 * Height-neutral: the row is one fixed truncating line whatever text it shows.
 */
export type TraceRowLiveTails = ReadonlyMap<string, { charCount: number; tail: string }>;

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
	/**
	 * Toggle one expandable row's body.
	 *
	 * Reports BOTH the row's index and its key, because which one identifies the row
	 * depends on the element kind and this pure render layer does not decide that:
	 * a trace folding a live row list is re-numbered under the reader (one row per
	 * reasoning step, so a new step shifts everything below it) and must be addressed
	 * by key, while an append-only trace is fine with its index. The integration
	 * layer routes on kind — see `traceRowFoldChannel`.
	 */
	onToggleRow?: (itemIndex: number, rowKey: string) => void;
	/** Wraps each row's title line in an interaction surface (see the type doc). */
	rowInteraction?: TraceRowInteractionSlot;
	/** Renders a drilled-in row's nested tool card (see the type doc). */
	rowCard?: TraceRowCardSlot;
	/** Fresh live tails for streaming rows, by row key (see the type doc). */
	rowLiveTails?: TraceRowLiveTails;
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
	rowLiveTails,
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
				role={header.hasChevron ? "button" : undefined}
				tabIndex={header.hasChevron ? 0 : undefined}
				aria-expanded={header.hasChevron ? header.opened : undefined}
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
				onKeyDown={header.hasChevron && onToggleItems ? activateOnKey(onToggleItems) : undefined}
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
					role="button"
					tabIndex={0}
					aria-expanded={toggle.showEarlier}
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
					onKeyDown={onToggleEarlier ? activateOnKey(onToggleEarlier) : undefined}
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
					shimmerStateLabels={labels.shimmerState}
					liveTail={rowLiveTails?.get(row.key)}
					liveTailChars={labels.liveTailChars}
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

/** How long a one-shot outcome sweep stays on a row (600ms animation + a margin). */
const ROW_FLASH_MS = 650;

/**
 * The shimmer STATE of one row, or null for a quiet row.
 *
 * Five states, same rule the tool cards use (`@shared/tool-shimmer`): neutral while
 * a call's input streams, purple while a reflection gate deliberates, blue while it
 * executes, and a one-shot green / red pass as it settles. Before this, a folded row
 * could only say "something here is live" via `row.shimmer` — a failure and a
 * success looked identical, which is precisely what dropping to a low LOD used to
 * cost the reader.
 *
 * Returns the KIND rather than a class name so the caller can also name the state for
 * readers who do not get the colour (see `TraceRenderLabels.shimmerState`); the class
 * is one table lookup away.
 *
 * `row.shimmer` remains the streaming signal for rows with NO lifecycle (reasoning
 * steps): the adapter sets it on the live step, and those rows carry no status at
 * all, so the resolver has nothing to say about them.
 *
 * A fresh mount never flashes (`prev === null` in `resolveToolShimmerFlash`). That
 * matters more here than on a card: virtual-list rows mount and unmount constantly
 * while scrolling, so a mount-triggered flash would light up whole screens of
 * settled history.
 */
function useTraceRowShimmerKind(row: MeasuredTraceRow): ToolShimmerKind | null {
	const status = row.status;
	const prevStatusRef = useRef<string | null>(null);
	const [flash, setFlash] = useState<ToolShimmerFlash | null>(null);
	useEffect(() => {
		const prev = prevStatusRef.current;
		prevStatusRef.current = status;
		const next = resolveToolShimmerFlash(prev, status);
		// ⚠️ A transition with no flash CLEARS the stored one; it must not just bail.
		// The timer that would have cleared it is torn down by this effect's own
		// cleanup, so a flash that was outranked by a live `phase` below (a retry
		// landing inside the window: running → fail → running) survived indefinitely
		// and replayed on the NEXT quiet status. `running → fail → running →
		// cancelled` flashed red on the cancellation — precisely the transition that
		// must never flash — and `running → success → running → pending` flashed
		// green on a row waiting for the reader's approval.
		if (!next) {
			setFlash(null);
			return;
		}
		setFlash(next);
		const timer = setTimeout(() => setFlash(null), ROW_FLASH_MS);
		return () => clearTimeout(timer);
	}, [status]);

	const phase = resolveToolShimmerPhase({
		status,
		// The row's only disambiguation for a `pending` tool: without it a deliberating
		// gate would fall silent instead of turning purple.
		reflectionStatus: row.reflectionStatus ?? null,
	});
	// A live phase outranks a pending flash (a retry that resumed inside the window).
	if (phase) return phase;
	if (flash) return flash;
	// No lifecycle of its own: fall back to the adapter's live-row marker.
	return row.shimmer ? "streaming" : null;
}

/**
 * A settled row's title line — one truncating span carrying the row's shimmer.
 *
 * The class arrives as a prop: the state behind it lives once per row in
 * `TraceRowView`, because this component and `LiveTailText` are mutually exclusive
 * branches of the SAME row and two memories of one row's status is a bug (see the
 * module header).
 */
function TraceRowTitle({ row, shimmerClass }: { row: MeasuredTraceRow; shimmerClass?: string }) {
	return (
		<Text
			size="xs"
			c="dimmed"
			truncate
			className={shimmerClass}
			style={{ flex: "0 1 auto", minWidth: 0 }}
		>
			{row.title || "…"}
		</Text>
	);
}

/**
 * A live reasoning row's label: a fixed "1234 字符…" size prefix followed by the
 * scrolling tail of the accumulated text.
 *
 * ⚠️ The tail is anchored to its END. A plain `truncate` (`text-overflow: ellipsis`)
 * clips the RIGHT side, which on a live tail would hide precisely the newest
 * characters — the opposite of the point. `direction: rtl` on the CELL moves the
 * clip to the left, so the newest text stays pinned at the right edge and older
 * text slides out of view on the left.
 *
 * ⚠️ The cell HUGS its text (`flex: 0 1 auto`), so the right edge it anchors to is
 * the end of the TEXT, not the end of the row. That distinction only shows up on a
 * short tail: with a growing basis the cell spans the row's whole remainder, and a
 * tail that fits was flung to the far right with a gap between it and the size
 * readout it belongs to. Right-anchoring earns its keep only while the text
 * overflows — which is exactly when a shrinking cell is at full width anyway.
 *
 * ⚠️ The tail text itself must then sit in an ISOLATED inner run
 * (`direction: ltr; unicode-bidi: isolate`), and this pair is load-bearing:
 *
 *   - Isolation makes the whole tail ONE unit for the cell's bidi resolution, so
 *     the RTL cell places it at its inline start (the right edge) and lets the
 *     overflow hang off the left. Inside the unit, ordinary bidi resolution
 *     resumes at an LTR base, so mixed scripts still read correctly.
 *   - `unicode-bidi: plaintext` on the cell (what this used to do) is the exact
 *     opposite: plaintext DERIVES the paragraph direction from the content's first
 *     strong character and thereby IGNORES `direction: rtl`. Reasoning text starts
 *     with Han/latin (both Bidi_Class L), so the row resolved as an LTR paragraph —
 *     left-aligned, clipped on the right, hiding the newest characters. That is the
 *     bug this shape fixes, so plaintext must not come back here.
 *   - `<bdo dir="ltr">` (what `common/TruncatedPath` uses for file paths) would also
 *     right-anchor the run, but it is an OVERRIDE: it would force RTL scripts inside
 *     the reasoning text to render backwards. Isolation gets the same anchoring
 *     without touching the tail's own bidi.
 *
 * Height-neutral: both cells sit inside the row's existing fixed line lane, so the
 * measure layer needs no change (the row is `TRACE_ROW_HEIGHT` either way).
 */
function LiveTailText({
	tail,
	charsLabel,
	shimmerClass,
}: {
	tail: { charCount: number; tail: string };
	charsLabel?: (formatted: string) => string;
	/** Resolved once per row by `TraceRowView` — see `TraceRowTitle` on why. */
	shimmerClass?: string;
}) {
	const prefix = charsLabel?.(String(tail.charCount)) ?? `${tail.charCount} chars`;
	return (
		<>
			{/* The size readout. `flexShrink: 0` keeps it intact while the tail absorbs
			    the width pressure — it is the one part of the label that must never be
			    clipped, since it is what tells the reader the run is still growing. */}
			<Text size="xs" c="dimmed" style={{ flexShrink: 0, opacity: 0.6 }}>
				{prefix}…
			</Text>
			<Text
				size="xs"
				c="dimmed"
				className={shimmerClass}
				style={{
					// `0 1 auto` — HUG the tail's own text, shrinking only under pressure.
					// The same basis a settled title uses, and for the same reason.
					//
					// ⚠️ NOT `flex: 1`. Claiming the row's whole leftover width makes the cell
					// as wide as the row whatever the text measures, and since the text is
					// right-anchored inside it (`direction: rtl` below), a tail that FITS got
					// pushed to the far right edge — leaving a conspicuous gap between the
					// size readout and the words it belongs to. Right-anchoring is only
					// meaningful while the text OVERFLOWS; when it fits, the tail belongs
					// beside its prefix like any other row label.
					//
					// Shrinking preserves the overflow case exactly: a long tail compresses
					// the cell to the available width, so the box fills the row's remainder
					// and the clip below still hides the OLD end.
					flex: "0 1 auto",
					minWidth: 0,
					overflow: "hidden",
					whiteSpace: "nowrap",
					// Clip on the LEFT so the newest characters stay pinned at the right
					// edge of the cell. No `textAlign` override: under `direction: rtl` the
					// inline start IS the right edge, and with the hugging basis above the
					// cell is only wider than its text when nothing is being clipped anyway.
					direction: "rtl",
				}}
			>
				{/* Isolated LTR run — the tail is ONE unit for the RTL cell (so it anchors
				    right and overflows left) while keeping its own characters in natural
				    order. See the header note on why plaintext / bdo are both wrong here. */}
				<span style={{ direction: "ltr", unicodeBidi: "isolate" }}>{tail.tail}</span>
			</Text>
		</>
	);
}

function TraceRowView({
	row,
	rowIcon,
	onToggleRow,
	rowInteraction,
	rowCard,
	timingLabels,
	shimmerStateLabels,
	liveTail,
	liveTailChars,
}: {
	row: MeasuredTraceRow;
	rowIcon?: (row: MeasuredTraceRow) => React.ReactNode;
	onToggleRow?: (itemIndex: number, rowKey: string) => void;
	rowInteraction?: TraceRowInteractionSlot;
	rowCard?: TraceRowCardSlot;
	timingLabels?: ToolTimingLabels;
	shimmerStateLabels?: TraceRenderLabels["shimmerState"];
	liveTail?: { charCount: number; tail: string };
	liveTailChars?: (formatted: string) => string;
}) {
	// ONE call per row, deliberately above both label branches — see the module header
	// on why calling it inside each branch loses a transition.
	const shimmerKind = useTraceRowShimmerKind(row);
	const shimmerClass = shimmerKind ? TRACE_SHIMMER_CLASS[shimmerKind] : undefined;
	const shimmerLabel = shimmerStateLabel(shimmerKind, shimmerStateLabels);
	const icon = row.hasIcon ? (rowIcon?.(row) ?? <DefaultRowIcon row={row} />) : null;
	const interactive = !!row.identity && !!rowInteraction;
	// A modified click means "select this row", not "expand it" — the interaction
	// wrapper performs the selection, so swallow the toggle.
	const handleToggle = row.expandable
		? (e: React.MouseEvent) => {
				if (interactive && (e.metaKey || e.ctrlKey || e.shiftKey)) return;
				onToggleRow?.(row.itemIndex, row.key);
			}
		: undefined;
	// Enter / Space on a focused row, the keyboard equivalent of the click above.
	const handleKeyDown = row.expandable
		? activateOnKey(() => onToggleRow?.(row.itemIndex, row.key))
		: undefined;
	const titleRow = (
		<Group
			data-nf-trace-titlerow
			gap={TRACE_ROW_GAP}
			wrap="nowrap"
			align="center"
			py={TRACE_ROW_PADDING_Y}
			// A div with an onClick is invisible to a keyboard and to a screen reader.
			// These are ATTRIBUTES ONLY — no box, no font, nothing the measure layer
			// models — so the row's height is unchanged (asserted in
			// `measure-tool-run.test.ts`).
			role={row.expandable ? "button" : undefined}
			tabIndex={row.expandable ? 0 : undefined}
			aria-expanded={row.expandable ? row.expanded : undefined}
			// The shimmer's five states are carried by colour alone; this is the only
			// channel a non-visual reader has for them.
			aria-label={shimmerLabel ? `${row.title || "…"} — ${shimmerLabel}` : undefined}
			title={shimmerLabel}
			style={{
				height: TRACE_ROW_HEIGHT,
				cursor: row.expandable ? "pointer" : "default",
				userSelect: "none",
			}}
			onClick={handleToggle}
			onKeyDown={handleKeyDown}
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
			{liveTail ? (
				<LiveTailText tail={liveTail} charsLabel={liveTailChars} shimmerClass={shimmerClass} />
			) : (
				<TraceRowTitle row={row} shimmerClass={shimmerClass} />
			)}
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
			    so it cannot affect the measured row.

			    Present on a live-tail row too, now that the tail cell HUGS its text
			    (`flex: 0 1 auto`). It used to be omitted because the tail was `flex: 1`
			    and two growing siblings would have split the leftover width between them.
			    With a zero basis this spacer never competes for SHRINK either — shrink is
			    weighted by base size, so a long tail still compresses alone. */}
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
			{/* The summary title row is the card-header's morph SOURCE on drill-down:
			    once the card is in, its own header occupies the same visual slot, so
			    painting both would double the Name · summary line. Markdown bodies
			    (reasoning steps) keep the row — there is no card to take it over. */}
			{row.cardMeasured ? null : titleRow}

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

			{/* Drilled-in tool card. The card fills the WHOLE row block from its top
			    (full row width, no indent rail): the summary row above is gone, and
			    the card's own header morphs into its place. The measure layer reserved
			    `blockHeight === card.height` for exactly this box. */}
			{row.expanded && row.cardMeasured ? (
				<Box
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						right: 0,
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
			// Per-ROW key so the header-morph controller can find THIS row's title line
			// among the trace's many rows (a trace-level querySelector would return the
			// first row's, which is the collapse-morph-wrong-row bug). Height-neutral.
			data-nf-trace-row={row.key}
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
			role={onExpand ? "button" : undefined}
			tabIndex={onExpand ? 0 : undefined}
			aria-expanded={onExpand ? false : undefined}
			style={{
				height: measured.height,
				cursor: onExpand ? "pointer" : "default",
				userSelect: "none",
			}}
			onClick={onExpand}
			onKeyDown={onExpand ? activateOnKey(onExpand) : undefined}
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
