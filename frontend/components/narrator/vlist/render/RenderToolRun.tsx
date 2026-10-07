/**
 * RenderToolRun.tsx — Render copies for the tool-run "trace" family measured by
 * measure-tool-run.ts (batch-2 P9). Pairs 1:1 with the measure layer: the outer
 * box height equals the predicted height, and every part (header band, "show
 * earlier" toggle, rows, expanded markdown bodies) is drawn at the exact top
 * offset the measure layer resolved — zero DOM measurement.
 *
 * Visual parity targets (NOT imported — this is an isolated vlist copy):
 *   CollapsibleTrace.tsx / ActivityTrace.tsx /
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
	TOOL_SHIMMER_QUEUED_EXIT_MS,
	type ToolShimmerFlash,
	type ToolShimmerKind,
	TRACE_SHIMMER_CLASS,
	TRACE_SHIMMER_FLASH_HOLD_MS,
} from "@shared/tool-shimmer";
import {
	IconBrain,
	IconChevronDown,
	IconChevronRight,
	IconDots,
	IconTool,
} from "@tabler/icons-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "../vlist-markdown.css";
import { TOOL_HEADER_SELECT_ATTR } from "../../message/MessageSelectionCtx";
import {
	CARD_HEADER_INNER_ICON,
	HEADER_CELL_GAP,
	type ToolCategory,
} from "../measure/measure-tool-call";
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
	TRACE_ROW_ICON,
	TRACE_ROW_PADDING_Y,
	type TraceCountLineKind,
	type TraceVariant,
	traceMetrics,
} from "../measure/measure-tool-run";
import type { MeasuredElement } from "../prepared-block";
import { typographyMetrics } from "../pretext-fonts";
import {
	applyTraceUnknownHeights,
	isExpandedUnknownTraceBody,
	retainTraceUnknownHeights,
	type TraceUnknownBodyHeights,
} from "../vlist-trace-unknown-heights";
import { CategoryChip } from "./category-chip";
import { categoryIcon } from "./category-icons";
import { DiffStatsText } from "./diff-stats-text";
import { activateOnKey, swallowSelectionClick } from "./key-activate";
import { RenderTextPreview, type TextPreviewLabels } from "./RenderTextPreview";
import { CATEGORY_COLOR, ToolTimingArea, type ToolTimingLabels } from "./RenderToolCall";
import {
	isTerminalToolRowStatus,
	resolveToolRowStatusMark,
	type ToolRowStatusMark,
	TRACE_ROW_STATUS_SLOT_STYLE,
	TraceRowStatusGlyph,
} from "./trace-row-status";

const CHEVRON_SLOT_WIDTH = 12;
/**
 * Glyph inside a category chip — one value for BOTH forms, so the icon does not change
 * size across the morph now that the tiles are the same 14px lane. Defined in the measure
 * module so the card header can share it without an import cycle.
 */
const ROW_INNER_ICON = CARD_HEADER_INNER_ICON;
const HEADER_INNER_ICON = ROW_INNER_ICON;
const DIMMED = "var(--mantine-color-dimmed)";

/** One-shot opacity fade for a trace row label switching form (see `useLabelFormFade`). */
const LABEL_FADE_CLASS = "vlist-trace-label-in";

function joinClasses(...classes: (string | undefined)[]): string | undefined {
	const joined = classes.filter(Boolean).join(" ");
	return joined.length > 0 ? joined : undefined;
}

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
	 * Placeholder for a LIVE reasoning row that has no text yet ("思考中…"). Without it
	 * the row opened as a bare chip with an empty label, and its first words then popped
	 * into a line that had given no sign it was about to hold anything.
	 */
	reasoningPending?: string;
	/** A finished reasoning row whose provider supplied no visible summary. */
	reasoningEmpty?: string;
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
	/**
	 * One name per status MARK, for readers who do not get the glyph's colour or
	 * shape. Distinct from `shimmerState` on purpose: shimmer is silent for two of
	 * the states a mark does report (`pending` gets no sweep at all), so a row
	 * awaiting a decision would otherwise have no accessible name anywhere.
	 * Attributes only — height-neutral.
	 */
	statusMark?: Partial<Record<ToolRowStatusMark, string>>;
}

/** English names for the shimmer states, used when no labels are injected. */
const DEFAULT_SHIMMER_STATE_LABELS: Readonly<Record<ToolShimmerKind, string>> = {
	streaming: "receiving input",
	reflecting: "under review",
	running: "running",
	queued: "waiting for earlier tools",
	// Transient leave-fade of the queued wash; named only so the Record stays total.
	queued_out: "waiting for earlier tools",
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
	/** Controlled correction for fully expanded unpredictable markdown, including trace chrome. */
	onUnknownHeight?: (height: number) => void;
	textPreviewLabels?: TextPreviewLabels;
	onToggleTextExpanded?: (bodyKey?: string) => void;
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
	/**
	 * Row keys whose drill-down is CLOSING: keep painting the card for the duration of
	 * the fold transition, even though the measured row no longer has one.
	 *
	 * Without this the card — its header included — is unmounted in the very frame the
	 * fold commits, so it VANISHES instead of closing and the rows below appear to slide
	 * up from behind a clip line. The shell adds a key here in the click handler, animates
	 * the block's height down, and removes it when the scheduler reports the motion done
	 * (`MotionOp.onDone`).
	 *
	 * ⚠️ Height-neutral by construction, and that is what keeps it out of the height
	 * model: the block's box is still exactly `row.blockHeight` (the COLLAPSED value the
	 * layout just committed) and the retained card is clipped by it. Nothing is measured,
	 * no cached measurement or layout offset is consulted, and the extra paint disappears
	 * on its own. This is the same class of purely visual retention as the fold's
	 * `clip-path` — see CONTRACT §4.6.
	 */
	closingRowKeys?: ReadonlySet<string>;
	/** Fresh live tails for streaming rows, by row key (see the type doc). */
	rowLiveTails?: TraceRowLiveTails;
	/**
	 * Per-grapheme fade for the expanded body of a LIVE reasoning step.
	 *
	 * A titled reasoning run renders as `reasoning-steps` (this component), not as
	 * the plain `reasoning` card — so without this the two shapes of the same content
	 * behaved differently: an untitled run's body faded in, a titled one's did not.
	 * Since a `**title**` is what the model normally emits, the shape that fades was
	 * the rarer one.
	 *
	 * Only the expanded body participates. A collapsed row is one fixed truncating
	 * line whose text is a settled title, and its live end is already shown by
	 * `rowLiveTails` — a left-clipped scrolling window, where a per-grapheme fade has
	 * no stable start or end position.
	 */
	animateStreaming?: boolean;
	/** Stable per-element key base (the vlist item's spec.key) for anim memory. */
	animKeyBase?: string;
	/** The anim store's mount scope; see RenderMarkdown.animScope. */
	animScope?: string;
}

/**
 * Render a measured CollapsibleTrace. The outer box height equals the predicted
 * height; the header band, toggle row, and item rows (+ expanded bodies) are
 * absolutely positioned at their measured tops.
 */
export function RenderToolRun(props: RenderToolRunProps) {
	// Keep this dispatcher hook-free: ordinary traces are also rendered directly
	// by pure callers. Only this controlled exception mounts a stateful boundary.
	return props.measured.rows.some(isExpandedUnknownTraceBody) ? (
		<UnknownHeightTrace {...props} />
	) : (
		RenderMeasuredToolRun(props)
	);
}

function UnknownHeightTrace(props: RenderToolRunProps) {
	const [heights, setHeights] = useState<TraceUnknownBodyHeights>(() => new Map());
	const committedRef = useRef(props.measured);
	const observingRef = useRef(true);
	const callbackCache = useRef(
		new Map<string, { body: MeasuredElement; report: (height: number) => void }>(),
	);
	useLayoutEffect(() => {
		observingRef.current = true;
		committedRef.current = props.measured;
		setHeights((previous) => retainTraceUnknownHeights(props.measured, previous));
		return () => {
			observingRef.current = false;
		};
	}, [props.measured]);
	const report = useCallback((key: string, body: MeasuredElement, height: number) => {
		if (!observingRef.current) return;
		const current = committedRef.current;
		const row = current.rows.find((candidate) => candidate.key === key);
		if (
			row?.body !== body ||
			!isExpandedUnknownTraceBody(row) ||
			!Number.isFinite(height) ||
			height <= 0
		)
			return;
		const rounded = Math.round(height);
		setHeights((previous) => {
			const retained = retainTraceUnknownHeights(current, previous);
			const old = retained.get(key);
			if (Math.abs((old?.height ?? body.frame.contentHeight) - rounded) <= 1) return retained;
			const next = new Map(retained);
			next.set(key, { originalBodyRef: body, height: rounded });
			return next;
		});
	}, []);
	const reporters = useMemo(() => {
		const next = new Map<string, (height: number) => void>();
		const active = new Set<string>();
		for (const row of props.measured.rows) {
			if (!isExpandedUnknownTraceBody(row) || !row.body) continue;
			const body = row.body;
			active.add(row.key);
			let cached = callbackCache.current.get(row.key);
			if (cached?.body !== body) {
				cached = { body, report: (height) => report(row.key, body, height) };
				callbackCache.current.set(row.key, cached);
			}
			next.set(row.key, cached.report);
		}
		for (const key of callbackCache.current.keys()) {
			if (!active.has(key)) callbackCache.current.delete(key);
		}
		return next;
	}, [props.measured, report]);
	const measured = useMemo(
		() => applyTraceUnknownHeights(props.measured, heights),
		[props.measured, heights],
	);
	useLayoutEffect(() => {
		props.onUnknownHeight?.(measured.height);
	}, [measured.height, props.onUnknownHeight]);
	return RenderMeasuredToolRun({ ...props, measured, bodyHeightReporters: reporters });
}

function RenderMeasuredToolRun({
	measured,
	labels = {},
	rowIcon,
	onToggleItems,
	onToggleEarlier,
	onToggleRow,
	rowInteraction,
	rowCard,
	closingRowKeys,
	rowLiveTails,
	animateStreaming,
	animKeyBase,
	animScope,
	textPreviewLabels,
	onToggleTextExpanded,
	bodyHeightReporters,
}: RenderToolRunProps & { bodyHeightReporters?: ReadonlyMap<string, (height: number) => void> }) {
	if (measured.itemCount === 0) return null;
	const { header, toggle, rows, variant } = measured;
	const headerColor = variantHeaderColor(variant);

	return (
		<div style={{ position: "relative", width: measured.contentWidth, height: measured.height }}>
			{/* ── Header band (omitted when the measure layer reserved no height) ──
			    `header.visible` is false for an activity fold showing its rows: the band
			    is decoration there, and the measure layer gave it height 0. Painting it
			    anyway would overlap the first row. See `isTraceHeaderVisible`. */}
			{header.visible ? (
				<Group
					gap={TRACE_ROW_GAP}
					wrap="nowrap"
					align="center"
					py={TRACE_HEADER_PADDING_Y}
					// Selectable surface: the row interaction wrapper ignores role="button"
					// targets, so mark the header as part of the block's selection region.
					{...{ [TOOL_HEADER_SELECT_ATTR]: "" }}
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
					// A modified click selects the block; only a plain click toggles the rows.
					onClick={
						header.hasChevron && onToggleItems ? swallowSelectionClick(onToggleItems) : undefined
					}
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
			) : null}

			{/* ── "Show earlier" toggle ── */}
			{toggle ? (
				<Group
					gap={TRACE_ROW_GAP}
					wrap="nowrap"
					align="center"
					py={TRACE_ROW_PADDING_Y}
					{...{ [TOOL_HEADER_SELECT_ATTR]: "" }}
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
					// A modified click selects the block; only a plain click reveals rows.
					onClick={onToggleEarlier ? swallowSelectionClick(onToggleEarlier) : undefined}
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
					onBodyUnknownHeight={bodyHeightReporters?.get(row.key)}
					textPreviewLabels={textPreviewLabels}
					onToggleTextExpanded={onToggleTextExpanded}
					rowIcon={rowIcon}
					onToggleRow={onToggleRow}
					rowInteraction={rowInteraction}
					rowCard={rowCard}
					closing={closingRowKeys?.has(row.key) === true}
					timingLabels={labels.timing}
					shimmerStateLabels={labels.shimmerState}
					statusMarkLabels={labels.statusMark}
					liveTail={rowLiveTails?.get(row.key)}
					liveTailChars={labels.liveTailChars}
					reasoningPending={labels.reasoningPending}
					reasoningEmpty={labels.reasoningEmpty}
					// Only the row still being written may fade. `row.shimmer` is the
					// adapter's own live marker, so a run that the answer text or a tool
					// call already followed settles here too — the same moment its shimmer
					// stops, rather than when the turn eventually persists.
					animateStreaming={animateStreaming === true && row.shimmer}
					// Namespaced per ROW: sibling steps are different content, and a shared
					// key would make step N+1's first frame read as a rewrite of step N.
					animKeyBase={animKeyBase != null ? `${animKeyBase}:${row.key}` : undefined}
					animScope={animScope}
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

/**
 * How long a one-shot outcome sweep stays on a row.
 *
 * From `@shared/tool-shimmer` so this path, the chunk path and the stylesheet cannot
 * disagree: dropping the class before the animation ends cuts the highlight off
 * wherever it happens to be, and the row shimmer has already shipped looking broken
 * in exactly that way.
 */
const ROW_FLASH_MS = TRACE_SHIMMER_FLASH_HOLD_MS;

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
type LabelForm = "pending" | "tail" | "title";

/**
 * Whether the label should fade in on THIS render: true only when an already-mounted row
 * switched label form. A row mounting (scrolling into the window, a new row arriving)
 * keeps its label still — fading every row as it scrolls in would be motion the reader
 * did not cause.
 *
 * No state needed: the switch is detected in the SAME render that mounts the new form's
 * keyed node, so that node carries the class on its first paint. The next form-stable
 * render removes the class again, which does not restart (or cut) an animation that is
 * already running — a CSS animation plays once per class application.
 */
function useLabelFormFade(form: LabelForm): boolean {
	const previous = useRef<LabelForm | null>(null);
	const switched = previous.current !== null && previous.current !== form;
	previous.current = form;
	return switched;
}

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
		// Parked slate mark when an earlier same-turn call still owns the slot. The
		// adapter resolved this from the real sibling prefix; a folded row cannot see
		// its peers, so it passes the verdict rather than a synthesized peer list.
		queuedBehindUpstream: row.queuedBehindUpstream,
	});
	// Leaving queued dissolves the slate tint instead of cutting the pulse mid-cycle
	// (see CARD path and `TOOL_SHIMMER_QUEUED_EXIT_MS`).
	const isQueued = phase === "queued";
	const prevQueuedRef = useRef(false);
	const [queuedExit, setQueuedExit] = useState(false);
	useEffect(() => {
		const wasQueued = prevQueuedRef.current;
		prevQueuedRef.current = isQueued;
		if (isQueued) {
			setQueuedExit(false);
			return;
		}
		if (wasQueued) {
			setQueuedExit(true);
			const timer = setTimeout(() => setQueuedExit(false), TOOL_SHIMMER_QUEUED_EXIT_MS);
			return () => clearTimeout(timer);
		}
		// Non-queued phase changes must not cancel the exit timer (e.g. running → success).
	}, [isQueued]);
	// The leave-fade outranks a live phase for one short window: the parked mark
	// must finish dissolving before the next sweep paints over it. A re-entry into
	// queued cancels the fade (handled above).
	if (queuedExit && phase !== "queued") return "queued_out";
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
function TraceRowTitle({
	row,
	shimmerClass,
	fadeIn = false,
}: {
	row: MeasuredTraceRow;
	shimmerClass?: string;
	/** Play the one-shot label fade (a label-form switch on a mounted row). */
	fadeIn?: boolean;
}) {
	const split = splitTraceRowTitle(row.title, row.toolName);
	const typo = typographyMetrics();
	return (
		<Text
			// Keep Mantine's dimmed colour, but paint the LINE BOX from the live
			// typography snapshot — the same numbers `bareRowMetrics()` reserved.
			// A bare `size="xs"` stays at 12/1.4 after the appearance panel moved,
			// so the folded row grew while its title stayed neutral-sized.
			c="dimmed"
			truncate
			className={joinClasses(shimmerClass, fadeIn ? LABEL_FADE_CLASS : undefined)}
			style={{
				flex: "0 1 auto",
				minWidth: 0,
				fontSize: `${typo.size.xs}px`,
				lineHeight: `${typo.line.xs}px`,
				letterSpacing: typo.letterSpacing.xs || undefined,
				// Monospace, matching the card header's own title span. The two are the SAME
				// line in two forms, so a font change between them cannot be masked by the
				// morph's translate — the glyphs simply re-shape mid-flight.
				fontFamily: "var(--mantine-font-family-monospace)",
			}}
		>
			{split ? (
				<>
					{/* BOLD name, no separator — the same device the card header uses (its own
					    tool-name span is `fontWeight: 600`). A middle dot spends a glyph and a
					    gap on saying what weight already says, and it had no counterpart in the
					    card, so the morph had to make it appear from nothing. */}
					{/* `marginRight` rather than a SPACE CHARACTER: a space is as wide as the
					    font's space advance (~7.2px in the monospace face at xs, and it scales
					    with the reader's font size), where the card header separates the same two
					    cells with a flat `gap={4}`. The identical label therefore had visibly
					    different spacing in the two forms. Width-only — no height effect. */}
					<span
						style={{
							fontWeight: 600,
							...(split.detail ? { marginRight: HEADER_CELL_GAP } : {}),
						}}
					>
						{split.name}
					</span>
					{split.detail || null}
				</>
			) : (
				row.title || "…"
			)}
		</Text>
	);
}

/**
 * Split a row title into its BOLD tool name and the rest.
 *
 * The adapter joins them as `"Name · summary"` (`toolTraceItem`), and the measured row
 * carries `toolName` alongside, so the split is a prefix check rather than a parse of the
 * separator — a summary containing its own `·` cannot confuse it.
 *
 * Returns null when the title is not that shape (a reasoning step, a caller-supplied
 * `resolveToolTitle`, a truncated title whose name was cut), in which case the title is
 * drawn verbatim. Height-neutral either way: same text, same single line.
 */
export function splitTraceRowTitle(
	title: string | undefined,
	toolName: string | undefined,
): { name: string; detail: string } | null {
	if (!title || !toolName) return null;
	// `Task` is displayed as `Agent`, so match what the adapter actually wrote.
	const displayName = toolName === "Task" ? "Agent" : toolName;
	if (!title.startsWith(displayName)) return null;
	const rest = title.slice(displayName.length);
	if (rest.length === 0) return { name: displayName, detail: "" };
	// The adapter's separator, and nothing else, may follow the name.
	if (!rest.startsWith(" · ")) return null;
	return { name: displayName, detail: rest.slice(3) };
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
	fadeIn = false,
}: {
	tail: { charCount: number; tail: string };
	charsLabel?: (formatted: string) => string;
	/** Resolved once per row by `TraceRowView` — see `TraceRowTitle` on why. */
	shimmerClass?: string;
	/** Play the one-shot label fade (a label-form switch on a mounted row). */
	fadeIn?: boolean;
}) {
	const prefix = charsLabel?.(String(tail.charCount)) ?? `${tail.charCount} chars`;
	const fade = fadeIn ? LABEL_FADE_CLASS : undefined;
	return (
		<>
			{/* The size readout. `flexShrink: 0` keeps it intact while the tail absorbs
			    the width pressure — it is the one part of the label that must never be
			    clipped, since it is what tells the reader the run is still growing.
			    Monospace keeps digit advances equal so a growing count does not shove
			    the tail on every digit-width change (streaming jitter). */}
			<Text
				size="xs"
				c="dimmed"
				ff="monospace"
				className={fade}
				style={{ flexShrink: 0, opacity: 0.6 }}
			>
				{prefix}…
			</Text>
			<Text
				size="xs"
				c="dimmed"
				className={joinClasses(shimmerClass, fade)}
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
	closing = false,
	timingLabels,
	shimmerStateLabels,
	statusMarkLabels,
	liveTail,
	liveTailChars,
	reasoningPending,
	reasoningEmpty,
	animateStreaming,
	animKeyBase,
	animScope,
	textPreviewLabels,
	onToggleTextExpanded,
	onBodyUnknownHeight,
}: {
	onBodyUnknownHeight?: (height: number) => void;
	textPreviewLabels?: TextPreviewLabels;
	onToggleTextExpanded?: (bodyKey?: string) => void;
	row: MeasuredTraceRow;
	rowIcon?: (row: MeasuredTraceRow) => React.ReactNode;
	onToggleRow?: (itemIndex: number, rowKey: string) => void;
	rowInteraction?: TraceRowInteractionSlot;
	rowCard?: TraceRowCardSlot;
	/** This row's drill-down is closing; keep painting its card (see closingRowKeys). */
	closing?: boolean;
	timingLabels?: ToolTimingLabels;
	shimmerStateLabels?: TraceRenderLabels["shimmerState"];
	statusMarkLabels?: TraceRenderLabels["statusMark"];
	liveTail?: { charCount: number; tail: string };
	liveTailChars?: (formatted: string) => string;
	/** Placeholder label for a live reasoning row with no text yet. */
	reasoningPending?: string;
	/** Finished reasoning without a visible summary. */
	reasoningEmpty?: string;
	/** This row is the live one AND the fade is enabled (see RenderToolRunProps). */
	animateStreaming?: boolean;
	animKeyBase?: string;
	animScope?: string;
}) {
	/**
	 * The card node from the last render that HAD one, kept so a closing drill-down can
	 * be animated shut around it (see `closingRowKeys`).
	 *
	 * A ref, not state: retaining a node is a purely visual concern and must not trigger
	 * a render of its own. It is only ever READ while `closing` is true, and the shell
	 * clears that flag when the scheduler reports the motion done, so the retained node
	 * cannot outlive the transition.
	 *
	 * ⚠️ No height is stored alongside it, deliberately. The wrapper stretches to the
	 * animating block (`bottom: 0`) instead of holding the height the card used to have —
	 * pinning that height is what let the shrinking block cut through the card's body and
	 * slice its border off.
	 */
	const retainedCardRef = useRef<React.ReactNode>(null);
	// Built ONCE per render: the slot does real work (payload resolution, render extras),
	// so calling it again for the retention would double that cost on every drilled row.
	const liveCard = row.expanded && row.cardMeasured ? (rowCard?.(row) ?? null) : null;
	if (liveCard !== null) {
		retainedCardRef.current = liveCard;
	} else if (!closing) {
		// Neither drilled nor closing: drop it, so a later close cannot resurrect a card
		// belonging to a different interaction.
		retainedCardRef.current = null;
	}
	// The live card while drilled; the previous frame's card while closing.
	const cardToPaint = liveCard ?? (closing ? retainedCardRef.current : null);

	// ONE call per row, deliberately above both label branches — see the module header
	// on why calling it inside each branch loses a transition.
	const shimmerKind = useTraceRowShimmerKind(row);
	// The row's status mark, resolved ONCE from the same two facts the shimmer above
	// reads. Passing them here is what stops a parked call from spinning beside text
	// that says it is waiting (see `@shared/tool-row-status`).
	const statusMark = resolveToolRowStatusMark(row.status, {
		queuedBehindUpstream: row.queuedBehindUpstream,
		reflectionStatus: row.reflectionStatus ?? null,
	});
	const shimmerClass = shimmerKind ? TRACE_SHIMMER_CLASS[shimmerKind] : undefined;
	const shimmerLabel = shimmerStateLabel(shimmerKind, shimmerStateLabels);
	const icon = row.hasIcon ? (rowIcon?.(row) ?? <DefaultRowIcon row={row} />) : null;
	// Which form the label takes: the live tail, a placeholder for a live row with no
	// text yet (reasoning rows carry no status — that is how a tool row is told apart),
	// or the ordinary title. `fadeLabel` is true only on a commit where the form CHANGED
	// on an already-mounted row (see useLabelFormFade).
	const labelForm: LabelForm = liveTail
		? "tail"
		: row.shimmer && !row.title.trim() && row.status == null
			? "pending"
			: "title";
	// Empty summaries are legitimate (e.g. encrypted Codex reasoning). Keep the
	// live indicator distinct from a finished row; never animate settled history.
	const displayRow =
		labelForm === "pending"
			? { ...row, title: reasoningPending ?? "Thinking" }
			: row.status == null && row.iconColor === "grape" && !row.title.trim()
				? { ...row, title: reasoningEmpty ?? "Thought complete (no visible summary)" }
				: row;
	const fadeLabel = useLabelFormFade(labelForm);
	const interactive = !!row.identity && !!rowInteraction;
	// A row the SYSTEM drilled open for a live permission form cannot be folded by the
	// reader (see `MeasuredTraceRow.pinnedOpen`): a click would store an explicit
	// expansion that outlives the request and leave the row open after the decision.
	const togglable = row.expandable && row.pinnedOpen !== true;
	// A modified click means "select this row", not "expand it" — the interaction
	// wrapper performs the selection, so swallow the toggle.
	const handleToggle = togglable
		? (e: React.MouseEvent) => {
				if (interactive && (e.metaKey || e.ctrlKey || e.shiftKey)) return;
				onToggleRow?.(row.itemIndex, row.key);
			}
		: undefined;
	// Enter / Space on a focused row, the keyboard equivalent of the click above.
	const handleKeyDown = togglable
		? activateOnKey(() => onToggleRow?.(row.itemIndex, row.key))
		: undefined;
	const titleRow = (
		<Group
			data-nf-trace-titlerow
			// Selectable surface: the row interaction wrapper (TraceRowInteraction)
			// ignores role="button" targets, so mark the title line as part of the
			// row's selection region — a modified click here selects the row's block.
			{...{ [TOOL_HEADER_SELECT_ATTR]: "" }}
			gap={TRACE_ROW_GAP}
			wrap="nowrap"
			align="center"
			py={TRACE_ROW_PADDING_Y}
			// A div with an onClick is invisible to a keyboard and to a screen reader.
			// These are ATTRIBUTES ONLY — no box, no font, nothing the measure layer
			// models — so the row's height is unchanged (asserted in
			// `measure-tool-run.test.ts`).
			role={togglable ? "button" : undefined}
			tabIndex={togglable ? 0 : undefined}
			aria-expanded={togglable ? row.expanded : undefined}
			// The shimmer's five states are carried by colour alone; this is the only
			// channel a non-visual reader has for them.
			aria-label={shimmerLabel ? `${displayRow.title || "…"} — ${shimmerLabel}` : undefined}
			title={shimmerLabel}
			style={{
				height: traceMetrics().rowHeight,
				cursor: togglable ? "pointer" : "default",
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
				// carries, so a parity test can find the SAME lane in a trace row, a
				// subagent card's recent-call row, and an expanded tool card header.
				// `iconColor` is the caller's explicit override (reasoning rows use grape);
				// absent → the row's own CATEGORY via the shared table.
				<CategoryChip
					data-trace-row-chip
					size={TRACE_ROW_ICON}
					color={row.iconColor ?? categoryColor(row.category)}
				>
					{icon}
				</CategoryChip>
			) : null}
			{/* `flex: 0 1 auto` (not `flex: 1`) is what lets the status + duration HUG the
			    title instead of being flung to the row's right edge. A short title keeps
			    them adjacent; a long one truncates and they follow the ellipsis. The
			    trailing spacer below absorbs whatever is left. */}
			{/* The label has three FORMS on a live reasoning row — the placeholder before any
			    text, the scrolling tail while a long step is written, the settled title — and
			    switching between them used to be a hard cut in place. Each form is keyed, so
			    React remounts the label only when the FORM changes and the one-shot CSS fade
			    (`vlist-trace-label-in`, opacity only, height-neutral) plays exactly on that
			    switch; a tail advancing or a title growing keeps its key and never re-fades.
			    A row that mounted in its current form (scrolling into the window) is not a
			    switch, so `fadeLabel` stays false for it. */}
			{labelForm === "tail" && liveTail ? (
				<LiveTailText
					key="tail"
					tail={liveTail}
					charsLabel={liveTailChars}
					shimmerClass={shimmerClass}
					fadeIn={fadeLabel}
				/>
			) : labelForm === "pending" ? (
				<TraceRowTitle key="pending" row={displayRow} shimmerClass={shimmerClass} />
			) : (
				<TraceRowTitle
					key="title"
					row={displayRow}
					shimmerClass={shimmerClass}
					fadeIn={fadeLabel}
				/>
			)}
			{/* Status + duration, adjacent to the label rather than right-aligned: in a
			    column of rows a far-right number has to be traced back across the gap to
			    find its own row, which is exactly the misreading this avoids.

			    Both live inside the row's fixed 18.8px line — the glyph in a 12px slot,
			    the duration as one nowrap span, popover portaled — so `measure-tool-run`
			    needs no height change (asserted in its tests). */}
			{/* `+N -N` for a Write/Edit row, in the same lane as the status glyph and
			    duration beside it (fixed line, nowrap, height-neutral). Before the
			    status so it stays adjacent to the path it describes. */}
			<DiffStatsText stats={row.diffStats} />
			{statusMark ? (
				<Box data-testid="trace-row-status-slot" style={TRACE_ROW_STATUS_SLOT_STYLE}>
					<TraceRowStatusGlyph mark={statusMark} labels={statusMarkLabels} />
				</Box>
			) : null}
			{/* ⚠️ `running` is narrowed past "not terminal": a QUEUED or AWAITING row has
			    not executed for a single millisecond, and an elapsed counter there
			    measures from the moment the model began writing the call's arguments —
			    a row that had never run showed "17s", which reads as time the tool
			    spent working. With `running` false and no final duration yet, the whole
			    timing text is omitted (see `TimingText`), which is the honest output.

			    Narrowed HERE rather than in `isTerminalToolRowStatus`: that predicate
			    also gates the card's timeout editor, and a call awaiting approval must
			    keep it. */}
			{row.timing ? (
				<ToolTimingArea
					running={
						!isTerminalToolRowStatus(row.status) &&
						statusMark !== "queued" &&
						statusMark !== "awaiting"
					}
					startedAt={row.timing.startedAt ?? row.timing.createdAt}
					durationMs={row.displayDurationMs ?? row.timing.durationMs}
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
		// `overflow: hidden` so the drill-down can be animated CLOSED. The fold controller
		// animates this block's `height` from the card's down to the summary row's (see
		// nestedResizeKeyframes); without clipping, the card would simply hang out of the
		// shrinking box instead of being progressively covered. Height-neutral: the box's
		// own height is still exactly what the measure layer reserved, and every swipe /
		// context menu overlay portals to the body rather than overflowing this box.
		<div
			// The node whose HEIGHT the fold animates when a drill-down closes. The outer
			// Box cannot serve: it is the row's positioning box (the controller resolves it
			// by `data-nf-trace-row` for the row's own translate), and animating height
			// there would fight that transform's node. Height-neutral data attribute.
			data-nf-trace-block={row.key}
			style={{ position: "relative", height: row.blockHeight, overflow: "hidden" }}
		>
			{/* The summary title row is the card-header's morph SOURCE on drill-down:
			    once the card is in, its own header occupies the same visual slot, so
			    painting both would double the Name · summary line. Markdown bodies
			    (reasoning steps) keep the row — there is no card to take it over.

			    While CLOSING, the retained card still occupies that slot, so the summary
			    row stays hidden until the transition ends. Painting both would double the
			    line for the duration — and the drill morph is already sliding the incoming
			    line into exactly this position. */}
			{cardToPaint ? null : titleRow}

			{/* Expanded markdown body (left-bordered, indented). */}
			{row.expanded && row.body ? (
				<Box
					py={TRACE_BODY_PADDING_Y}
					style={{
						position: "absolute",
						top: traceMetrics().rowHeight,
						left: 0,
						right: 0,
						paddingLeft: TRACE_BODY_PADDING_LEFT,
						borderLeft: `${TRACE_BODY_BORDER_LEFT}px solid var(--mantine-color-grape-9)`,
						opacity: 0.75,
					}}
				>
					<RenderTextPreview
						textPreviewLabels={textPreviewLabels}
						onToggleTextExpanded={onToggleTextExpanded}
						bodyKey={row.key ?? String(row.itemIndex)}
						measured={row.body}
						onUnknownHeight={onBodyUnknownHeight}
						animateStreaming={animateStreaming}
						sealOnMount
						animKeyBase={animKeyBase}
						animScope={animScope}
					/>
				</Box>
			) : null}

			{/* Drilled-in tool card. The card fills the WHOLE row block from its top
			    (full row width, no indent rail): the summary row above is gone, and
			    the card's own header morphs into its place. The measure layer reserved
			    `blockHeight === card.height` for exactly this box.

			    `cardToPaint` is the previous frame's node while CLOSING, kept so the block
			    can be animated shut around it (see closingRowKeys).

			    ⚠️ While closing it is stretched to FILL the block (`inset: 0`), not pinned
			    to the height it used to have. Pinning it meant the shrinking block cut
			    straight through the card's body, so its rounded border was sliced off and
			    the reader saw a raw truncated edge instead of a box closing. Filling makes
			    the card's own bordered `Paper` shrink WITH the block, so all four edges stay
			    joined for the whole transition. The card's inner content keeps its own
			    height and is clipped by that Paper — cropped, never scaled, so no text
			    deforms. */}
			{cardToPaint ? (
				<Box
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						right: 0,
						...(liveCard
							? {}
							: {
									// Stretch to the animating block so the CARD's OWN border shrinks
									// with it (`height: 100%` on the card below). The card's `Paper`
									// wraps its content and has no height of its own, so without this
									// the shrinking block cut straight through the card body and sliced
									// its border off.
									//
									// ⚠️ This wrapper must NOT paint a border of its own. It did
									// briefly, to carry the shrinking outline, and the result was TWO
									// visible outlines during every close — the retained card still
									// renders its own `Paper withBorder`. Stretching the card is the
									// fix; a second border is not.
									bottom: 0,
									overflow: "hidden",
									// The card fills this box, so its own `Paper` (and therefore its
									// own single border) is what shrinks. `> *` rather than a prop:
									// the card arrives as an already-built node from the shell's slot.
									display: "grid",
									gridTemplateRows: "100%",
								}),
					}}
				>
					{cardToPaint}
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
			{...{ [TOOL_HEADER_SELECT_ATTR]: "" }}
			role={onExpand ? "button" : undefined}
			tabIndex={onExpand ? 0 : undefined}
			aria-expanded={onExpand ? false : undefined}
			style={{
				height: measured.height,
				cursor: onExpand ? "pointer" : "default",
				userSelect: "none",
			}}
			// A modified click selects the block; only a plain click expands the trace.
			onClick={onExpand ? swallowSelectionClick(onExpand) : undefined}
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
