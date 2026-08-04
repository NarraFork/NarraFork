import { Box, Group, Text, ThemeIcon } from "@mantine/core";
import { hasToolRowStatusMark } from "@shared/tool-row-status";
import {
	resolveToolShimmerFlash,
	resolveToolShimmerPhase,
	type ToolShimmerFlash,
	type ToolShimmerKind,
	TRACE_SHIMMER_CLASS,
} from "@shared/tool-shimmer";
import { IconChevronDown, IconChevronRight, IconDots } from "@tabler/icons-react";
import { type CSSProperties, memo, type ReactNode, useEffect, useRef, useState } from "react";
import { LazyCollapse } from "./LazyCollapse";
import type { MessageContextMenuActions } from "./MessageContextMenuCtx";
import { MessageContextMenuCtx } from "./MessageContextMenuCtx";
import { STATUS_COLORS, StatusIcon } from "./ToolCallCard";
import { isTraceRowSelectionClick, TraceRowInteraction } from "./TraceRowInteraction";
import type { TraceRowIdentity } from "./trace-row-identity";

// ---------------------------------------------------------------------------
// CollapsibleTrace — a content-agnostic "trace" block: a header line (icon +
// label + count), an optional "show earlier" fold, and a list of rows. Each
// row is a chevron (expandable) or a plain dot (not) + an optional icon + a
// single truncated title, with an optional collapsible body and an optional
// streaming shimmer. Distilled from ReasoningStepsTrace so reasoning traces,
// tool summaries, and the unified L1/L2 activity trace all share one structure —
// which keeps their look identical and lets item-level keys stay stable for
// future animated LOD transitions.
// ---------------------------------------------------------------------------

// --- Cross-remount persistence (LRU) ---------------------------------------
const MAX_STATE_ENTRIES = 1000;
export const TRACE_ROW_MIN_HEIGHT = 18;
export const TRACE_ROW_LINE_HEIGHT = "16px";
export const TRACE_CHEVRON_SLOT_WIDTH = 12;
export const TRACE_ICON_SLOT_SIZE = 14;
/** Trailing status glyph box (matches `StatusIcon`'s own 12px glyph). */
export const TRACE_STATUS_SLOT_SIZE = 12;
/** Gap between the cells of a trace row. */
export const TRACE_ROW_GAP = 6;
const expandState = new Map<string, boolean>();

/**
 * Fixed slot for the trailing status glyph.
 *
 * An auto-sized wrapper around an inline `<svg>` takes its line box from the ROOT
 * font size (16 × 1.55 = 24.8px) rather than from the 12px glyph, and `StatusIcon`
 * returns null for statuses outside its known set — so an unstyled wrapper both
 * INFLATED the row when it drew and collapsed to 0×0 when it did not. Sizing it
 * explicitly and laying it out as flex makes the glyph height-neutral either way,
 * which is what lets the row keep its 18px reservation.
 */
export const TRACE_STATUS_SLOT_STYLE = {
	width: TRACE_STATUS_SLOT_SIZE,
	height: TRACE_STATUS_SLOT_SIZE,
	flexShrink: 0,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
} as const satisfies CSSProperties;

function readState(key: string | undefined): boolean | undefined {
	if (!key) return undefined;
	const value = expandState.get(key);
	if (value !== undefined) {
		expandState.delete(key);
		expandState.set(key, value);
	}
	return value;
}

function writeState(key: string | undefined, value: boolean) {
	if (!key) return;
	expandState.delete(key);
	expandState.set(key, value);
	while (expandState.size > MAX_STATE_ENTRIES) {
		const oldest = expandState.keys().next().value;
		if (oldest === undefined) break;
		expandState.delete(oldest);
	}
}

export interface CollapsibleTraceItem {
	/** Stable React key + persist-key suffix (e.g. toolUseId / `seg${i}`). */
	key: string;
	/** Per-row icon node (tool category icon / brain). Omit for a plain row. */
	icon?: ReactNode;
	/** ThemeIcon tint for the row icon. */
	iconColor?: string;
	/** Single-line truncated row title. */
	title: string;
	/** Expandable body; null/undefined → non-expandable dot row. */
	body?: ReactNode | null;
	/**
	 * Neutral "streaming" shimmer for a row with NO lifecycle of its own — i.e. the
	 * latest live reasoning step.
	 *
	 * Rows that pass a `status` derive all five shimmer states from it instead
	 * (`@shared/tool-shimmer`), so this flag is only the fallback for rows the
	 * resolver has nothing to say about. Setting both is harmless: the status wins.
	 */
	shimmer?: boolean;
	/**
	 * Tool-call status for the trailing glyph (spinner in flight, then ✓/✗/⊘).
	 *
	 * A folded row used to say only WHAT ran — a failed call and a finished one read
	 * identically, and shimmer could only mean "something is live". Omit for rows
	 * that have no such lifecycle (reasoning steps): the slot is then not rendered at
	 * all, so those rows are unchanged.
	 */
	status?: string;
	/**
	 * A live reflection gate's status on this row's tool, when it has one.
	 *
	 * Picks the row's shimmer colour (purple while a gate deliberates) and nothing else.
	 * Without it a gated tool's `pending` status would read as "waiting on the user" and
	 * fall silent. See `@shared/tool-shimmer`.
	 */
	reflectionStatus?: string;
	/**
	 * Trailing node after the title, e.g. this row's `ToolTimingArea`.
	 *
	 * Injected rather than typed as a tool call so this component stays content
	 * agnostic — it must not know what a tool call is. Callers are responsible for
	 * keeping it height-neutral: a single line that shares the row's 18px
	 * reservation, with any popover portaled.
	 */
	trailing?: ReactNode;
	/** Persist-key override; defaults to `${persistKeyBase}:${key}`. */
	persistKey?: string;
	/**
	 * Localized name per shimmer state, for a reader who does not receive the colour.
	 *
	 * Supplied by the caller (this component stays i18n-free) and rendered as
	 * `title` + `aria-label` attributes only, so it cannot move the row.
	 */
	shimmerStateLabels?: Partial<Record<ToolShimmerKind, string>>;
	/**
	 * Selection / menu identity for this row. When present the row becomes an
	 * interactive block (right-click, left-swipe, Ctrl/Shift multi-select) just
	 * like an expanded card. Absent → the row renders exactly as before.
	 */
	identity?: TraceRowIdentity;
	/** Message-level actions for this row's message (paired with `identity`). */
	actions?: MessageContextMenuActions;
}

/** Panel context a trace needs to offer the row menus. */
export interface CollapsibleTraceRowContext {
	/** Owning narrator id — enables the tool-call inspector item. */
	narratorId?: string;
	/** Open a child narrator's session (subagent + resolved Await-agent rows). */
	onViewSubagentSession?: (narratorId: string) => void;
	/** Detach a running subagent to a background task. */
	onDetachSubagent?: (narratorId: string) => void;
	/** Cancel a background subagent task. */
	onCancelBackgroundTask?: (narratorId: string) => void;
	/** Open a file-oriented tool's path in a read-only dock panel. */
	onOpenFilePanel?: (filePath: string) => void;
}

export interface CollapsibleTraceProps {
	items: CollapsibleTraceItem[];
	headerIcon: ReactNode;
	headerColor: string;
	headerLabel: string;
	/** Pre-formatted count text ("N 步" / "N 次"), localized by the caller. */
	headerCount: string;
	/** Rows visible before "show earlier" folding (reasoning=5, tools=10). */
	maxVisible?: number;
	/** LRU persist-key base; undefined → no persistence. */
	persistKeyBase?: string;
	/** Localized labels (the component stays i18n-free). */
	showEarlierLabel: (hiddenCount: number) => string;
	hideEarlierLabel: string;
	/** Collapse the complete row list behind the clickable header. */
	collapseItems?: boolean;
	/** Panel context for the per-row menus (only used by rows with an identity). */
	rowContext?: CollapsibleTraceRowContext;
	/**
	 * Localized name per shimmer state (see `CollapsibleTraceItem.shimmerStateLabels`).
	 * Set here once for the whole trace; each row forwards it.
	 */
	shimmerStateLabels?: Partial<Record<ToolShimmerKind, string>>;
}

/**
 * Enter / Space handler for a row whose only affordance is an `onClick` on a div.
 *
 * Every fold here is a `Group` (a div) with a click handler: unreachable by keyboard
 * and unannounced by a screen reader. Paired with `role="button" tabIndex={0}` at each
 * call site — attributes only, so the row's reserved height is untouched.
 *
 * Space is `preventDefault`ed because its default action scrolls the page, which would
 * move the very rows being read.
 */
function activateOnKey(activate: () => void) {
	return (e: React.KeyboardEvent) => {
		if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
		e.preventDefault();
		e.stopPropagation();
		activate();
	};
}

/** English fallbacks, so a caller that supplies no labels still names the state. */
const DEFAULT_SHIMMER_STATE_LABELS: Readonly<Record<ToolShimmerKind, string>> = {
	streaming: "receiving input",
	reflecting: "under review",
	running: "running",
	success: "succeeded",
	failed: "failed",
};

/**
 * Exported (with the slots below) so every compact row in the chunk path — a
 * folded trace row here AND a subagent card's recent-call row — is assembled from
 * the SAME definitions rather than from two copies that happen to agree today.
 */
export function TraceChevronSlot({ children }: { children: ReactNode }) {
	return (
		<Box
			data-trace-chevron-slot
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				width: TRACE_CHEVRON_SLOT_WIDTH,
				minWidth: TRACE_CHEVRON_SLOT_WIDTH,
			}}
		>
			{children}
		</Box>
	);
}

/** The "not expandable" marker a plain trace row shows in its chevron slot. */
export function TraceRowDot() {
	return (
		<Text span size="xs" c="dimmed" style={{ opacity: 0.5, lineHeight: 1, fontSize: 10 }}>
			•
		</Text>
	);
}

export function TraceIconSlot({ icon, color = "gray" }: { icon?: ReactNode; color?: string }) {
	return (
		<Box
			data-trace-icon-slot
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				width: TRACE_ICON_SLOT_SIZE,
				minWidth: TRACE_ICON_SLOT_SIZE,
				height: TRACE_ICON_SLOT_SIZE,
			}}
		>
			{icon != null && (
				<ThemeIcon size={TRACE_ICON_SLOT_SIZE} variant="light" color={color} radius="sm">
					{icon}
				</ThemeIcon>
			)}
		</Box>
	);
}

/**
 * The trailing status glyph of a row, in its fixed height-neutral slot.
 *
 * Renders only for a status worth MARKING — in flight, failed, or cancelled. A
 * successful call draws nothing at all (not even a blank slot), because success is
 * the default expectation and a column of green checks is noise that costs the
 * reader exactly the attention a real failure needs. The rule itself lives in
 * `@shared/tool-row-status` so the vlist rows cannot diverge from these.
 *
 * `StatusIcon` is the same component the tool card's header paints, so a marked row
 * and the card it expands into cannot disagree about what "running" or "cancelled"
 * looks like. (The header still shows its check: it displays one call at a time, so
 * there is no column for a check to clutter.)
 */
/** How long a one-shot outcome sweep stays on a row (600ms animation + a margin). */
const ROW_FLASH_MS = 650;

/**
 * The shimmer STATE of one row, or null for a quiet row.
 *
 * Five states from `@shared/tool-shimmer` — neutral while a call's input streams,
 * purple while a reflection gate deliberates, blue while it executes, and a one-shot
 * green / red pass as it settles. The rule is shared with the vlist's own trace rows
 * and with both tool cards; the classes live in `frontend/styles/trace-shimmer.css`.
 *
 * Returns the KIND, not a class name, so the row can also NAME its state for a reader
 * who does not receive the colour (`shimmerStateLabels`) — colour was the only
 * carrier, and success/failure is exactly the pair that must not depend on it.
 *
 * `item.shimmer` stays the streaming signal for rows with NO lifecycle (reasoning
 * steps): callers set it on the live step, and those rows pass no status at all.
 *
 * A fresh mount never flashes — see `resolveToolShimmerFlash`.
 */
function useTraceRowShimmerKind(item: CollapsibleTraceItem): ToolShimmerKind | null {
	const status = item.status;
	const prevStatusRef = useRef<string | null>(null);
	const [flash, setFlash] = useState<ToolShimmerFlash | null>(null);
	useEffect(() => {
		const prev = prevStatusRef.current;
		prevStatusRef.current = status ?? null;
		const next = resolveToolShimmerFlash(prev, status);
		// ⚠️ A transition with no flash CLEARS the stored one; it must not just bail.
		// The 650ms timer is torn down by this effect's own cleanup, so a flash that
		// was outranked by a live `phase` below (a retry inside the window: running →
		// fail → running) survived and replayed on the NEXT quiet status —
		// `→ cancelled` flashed red, which is the one transition that must never
		// flash, and `→ pending` flashed green on a row awaiting the reader.
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
		reflectionStatus: item.reflectionStatus ?? null,
	});
	// A live phase outranks a pending flash (a retry that resumed inside the window).
	if (phase) return phase;
	if (flash) return flash;
	return item.shimmer ? "streaming" : null;
}

export function TraceStatusSlot({ status }: { status?: string }) {
	if (!hasToolRowStatusMark(status)) return null;
	const resolved = status as string;
	return (
		<Box
			data-testid="trace-row-status-slot"
			c={STATUS_COLORS[resolved] ?? "gray"}
			style={TRACE_STATUS_SLOT_STYLE}
		>
			<StatusIcon status={resolved} />
		</Box>
	);
}

const TraceRow = memo(function TraceRow({
	item,
	persistKeyBase,
	rowContext,
	shimmerStateLabels,
}: {
	item: CollapsibleTraceItem;
	persistKeyBase?: string;
	rowContext?: CollapsibleTraceRowContext;
	shimmerStateLabels?: Partial<Record<ToolShimmerKind, string>>;
}) {
	const persistKey =
		item.persistKey ?? (persistKeyBase ? `${persistKeyBase}:${item.key}` : undefined);
	const expandable = item.body != null;
	const [opened, setOpened] = useState(readState(persistKey) ?? false);
	const shimmerKind = useTraceRowShimmerKind(item);
	const shimmerClass = shimmerKind ? TRACE_SHIMMER_CLASS[shimmerKind] : undefined;
	const shimmerLabel = shimmerKind
		? (item.shimmerStateLabels?.[shimmerKind] ??
			shimmerStateLabels?.[shimmerKind] ??
			DEFAULT_SHIMMER_STATE_LABELS[shimmerKind])
		: undefined;

	const expand = () => {
		setOpened((v) => {
			const next = !v;
			writeState(persistKey, next);
			return next;
		});
	};

	const toggle = (e: React.MouseEvent) => {
		// A modified click means "select this row", not "expand it". The interaction
		// wrapper handles the selection; swallow the toggle so the row does not also
		// expand under the user's Ctrl/Shift+Click.
		if (item.identity && isTraceRowSelectionClick(e)) return;
		if (!expandable) return;
		expand();
	};

	const titleRow = (
		<Group
			data-testid="collapsible-trace-row"
			gap={TRACE_ROW_GAP}
			wrap="nowrap"
			align="center"
			py={1}
			// A div with an onClick reaches neither a keyboard nor a screen reader.
			// Attributes only — nothing here enters the box model, so the row keeps its
			// TRACE_ROW_MIN_HEIGHT reservation.
			role={expandable ? "button" : undefined}
			tabIndex={expandable ? 0 : undefined}
			aria-expanded={expandable ? opened : undefined}
			// The five shimmer states are carried by colour alone; this is the only
			// channel a non-visual or colour-blind reader has for them.
			aria-label={shimmerLabel ? `${item.title || "…"} — ${shimmerLabel}` : undefined}
			title={shimmerLabel}
			style={{
				cursor: expandable ? "pointer" : "default",
				userSelect: "none",
				minHeight: TRACE_ROW_MIN_HEIGHT,
			}}
			onClick={toggle}
			onKeyDown={expandable ? activateOnKey(expand) : undefined}
		>
			<TraceChevronSlot>
				{expandable ? (
					opened ? (
						<IconChevronDown size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
					) : (
						<IconChevronRight size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
					)
				) : (
					<TraceRowDot />
				)}
			</TraceChevronSlot>
			<TraceIconSlot icon={item.icon} color={item.iconColor} />
			{/* `flex: 0 1 auto` (not `flex: 1`) is what lets the status + duration HUG the
			    title. Right-aligning them meant the reader had to trace a far-right number
			    back across the gap to find its own row. */}
			<Text
				data-trace-title
				size="xs"
				c="dimmed"
				truncate
				className={shimmerClass}
				style={{ flex: "0 1 auto", minWidth: 0, lineHeight: TRACE_ROW_LINE_HEIGHT }}
			>
				{item.title || "…"}
			</Text>
			{/* Outcome + duration, adjacent to the label. Both are fixed-height cells
			    inside the row's existing 18px reservation (the glyph in a sized flex slot,
			    the timing a single nowrap line with a portaled popover), so adding them
			    does not move the row. Rows without a lifecycle pass neither. */}
			<TraceStatusSlot status={item.status} />
			{item.trailing}
			{/* Absorbs the remaining width so the cells above stay left-packed. */}
			<Box style={{ flex: 1, minWidth: 0 }} />
		</Group>
	);

	// Rows with an identity join the selection / context-menu system. The wrapper
	// only wraps the TITLE row so an expanded body keeps its own interactions.
	const interactiveTitleRow =
		item.identity && item.actions ? (
			<MessageContextMenuCtx.Provider value={item.actions}>
				<TraceRowInteraction
					identity={item.identity}
					actions={item.actions}
					narratorId={rowContext?.narratorId}
					onViewSubagentSession={rowContext?.onViewSubagentSession}
					onDetachSubagent={rowContext?.onDetachSubagent}
					onCancelBackgroundTask={rowContext?.onCancelBackgroundTask}
					onOpenFilePanel={rowContext?.onOpenFilePanel}
				>
					{titleRow}
				</TraceRowInteraction>
			</MessageContextMenuCtx.Provider>
		) : (
			titleRow
		);

	return (
		<Box>
			{interactiveTitleRow}
			{expandable && (
				<LazyCollapse in={opened}>
					<Box
						pl="lg"
						py={2}
						style={{
							borderLeft: "2px solid var(--mantine-color-grape-9)",
							opacity: 0.75,
							fontSize: "var(--mantine-font-size-xs)",
						}}
					>
						{item.body}
					</Box>
				</LazyCollapse>
			)}
		</Box>
	);
});

export const CollapsibleTrace = memo(function CollapsibleTrace({
	items,
	headerIcon,
	headerColor,
	headerLabel,
	headerCount,
	maxVisible = 5,
	persistKeyBase,
	showEarlierLabel,
	hideEarlierLabel,
	collapseItems = false,
	rowContext,
	shimmerStateLabels,
}: CollapsibleTraceProps) {
	const earlierKey = persistKeyBase ? `${persistKeyBase}:earlier` : undefined;
	const [showEarlier, setShowEarlier] = useState(readState(earlierKey) ?? false);
	const [itemsOpened, setItemsOpened] = useState(false);
	const [previousCollapseItems, setPreviousCollapseItems] = useState(collapseItems);
	if (previousCollapseItems !== collapseItems) {
		setPreviousCollapseItems(collapseItems);
		setItemsOpened(false);
	}

	if (items.length === 0) return null;

	const hiddenCount = Math.max(0, items.length - maxVisible);
	const visibleStart = showEarlier ? 0 : hiddenCount;
	const rowsOpened = !collapseItems || itemsOpened;

	const toggleEarlier = () => {
		setShowEarlier((v) => {
			const next = !v;
			writeState(earlierKey, next);
			return next;
		});
	};

	return (
		<Box py={2}>
			<Group
				gap={6}
				wrap="nowrap"
				align="center"
				py={2}
				role={collapseItems ? "button" : undefined}
				tabIndex={collapseItems ? 0 : undefined}
				aria-expanded={collapseItems ? itemsOpened : undefined}
				style={{ cursor: collapseItems ? "pointer" : "default", userSelect: "none" }}
				onClick={collapseItems ? () => setItemsOpened((opened) => !opened) : undefined}
				onKeyDown={
					collapseItems ? activateOnKey(() => setItemsOpened((opened) => !opened)) : undefined
				}
			>
				{collapseItems &&
					(itemsOpened ? (
						<IconChevronDown size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
					) : (
						<IconChevronRight size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
					))}
				<ThemeIcon size={16} variant="light" color={headerColor} radius="sm">
					{headerIcon}
				</ThemeIcon>
				<Text size="xs" c="dimmed" fw={500} style={{ flexShrink: 0 }}>
					{headerLabel}
				</Text>
				<Text size="xs" c="dimmed" style={{ flexShrink: 0, opacity: 0.5 }}>
					{headerCount}
				</Text>
			</Group>

			<LazyCollapse in={rowsOpened}>
				{hiddenCount > 0 && (
					<Group
						data-testid="collapsible-trace-earlier-row"
						gap={6}
						wrap="nowrap"
						align="center"
						py={1}
						role="button"
						tabIndex={0}
						aria-expanded={showEarlier}
						style={{
							cursor: "pointer",
							userSelect: "none",
							minHeight: TRACE_ROW_MIN_HEIGHT,
						}}
						onClick={toggleEarlier}
						onKeyDown={activateOnKey(toggleEarlier)}
					>
						<TraceChevronSlot>
							<IconDots size={12} style={{ color: "var(--mantine-color-dimmed)", opacity: 0.6 }} />
						</TraceChevronSlot>
						<TraceIconSlot />
						<Text
							data-trace-title
							size="xs"
							c="dimmed"
							style={{ opacity: 0.7, lineHeight: TRACE_ROW_LINE_HEIGHT }}
						>
							{showEarlier ? hideEarlierLabel : showEarlierLabel(hiddenCount)}
						</Text>
					</Group>
				)}

				{items.slice(visibleStart).map((item) => (
					<TraceRow
						key={item.key}
						item={item}
						persistKeyBase={persistKeyBase}
						rowContext={rowContext}
						shimmerStateLabels={shimmerStateLabels}
					/>
				))}
			</LazyCollapse>
		</Box>
	);
});

// ⚠️ The row shimmer's CSS used to be injected here as a runtime <style>. It now
// lives in `frontend/styles/trace-shimmer.css` (loaded by main.tsx), because the
// VLIST rows reference the same classes and vlist may not import this module — so
// the injection only worked by accident, via NarratorPanel's static import of
// MessageRenderer dragging this path into the graph. See that stylesheet's header.
