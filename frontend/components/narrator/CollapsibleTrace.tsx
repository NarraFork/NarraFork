import { Box, Group, Text, ThemeIcon } from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconDots } from "@tabler/icons-react";
import { memo, type ReactNode, useState } from "react";
import { LazyCollapse } from "./LazyCollapse";
import type { MessageContextMenuActions } from "./MessageContextMenuCtx";
import { MessageContextMenuCtx } from "./MessageContextMenuCtx";
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
const TRACE_ROW_MIN_HEIGHT = 18;
const TRACE_ROW_LINE_HEIGHT = "16px";
const TRACE_CHEVRON_SLOT_WIDTH = 12;
const TRACE_ICON_SLOT_SIZE = 14;
const expandState = new Map<string, boolean>();

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
	/** Streaming shimmer on this row (the latest live item). */
	shimmer?: boolean;
	/** Persist-key override; defaults to `${persistKeyBase}:${key}`. */
	persistKey?: string;
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
}

function TraceChevronSlot({ children }: { children: ReactNode }) {
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

function TraceIconSlot({ icon, color = "gray" }: { icon?: ReactNode; color?: string }) {
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

const TraceRow = memo(function TraceRow({
	item,
	persistKeyBase,
	rowContext,
}: {
	item: CollapsibleTraceItem;
	persistKeyBase?: string;
	rowContext?: CollapsibleTraceRowContext;
}) {
	const persistKey =
		item.persistKey ?? (persistKeyBase ? `${persistKeyBase}:${item.key}` : undefined);
	const expandable = item.body != null;
	const [opened, setOpened] = useState(readState(persistKey) ?? false);

	const toggle = (e: React.MouseEvent) => {
		// A modified click means "select this row", not "expand it". The interaction
		// wrapper handles the selection; swallow the toggle so the row does not also
		// expand under the user's Ctrl/Shift+Click.
		if (item.identity && isTraceRowSelectionClick(e)) return;
		if (!expandable) return;
		setOpened((v) => {
			const next = !v;
			writeState(persistKey, next);
			return next;
		});
	};

	const titleRow = (
		<Group
			data-testid="collapsible-trace-row"
			gap={6}
			wrap="nowrap"
			align="center"
			py={1}
			style={{
				cursor: expandable ? "pointer" : "default",
				userSelect: "none",
				minHeight: TRACE_ROW_MIN_HEIGHT,
			}}
			onClick={toggle}
		>
			<TraceChevronSlot>
				{expandable ? (
					opened ? (
						<IconChevronDown size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
					) : (
						<IconChevronRight size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
					)
				) : (
					<Text span size="xs" c="dimmed" style={{ opacity: 0.5, lineHeight: 1, fontSize: 10 }}>
						•
					</Text>
				)}
			</TraceChevronSlot>
			<TraceIconSlot icon={item.icon} color={item.iconColor} />
			<Text
				data-trace-title
				size="xs"
				c="dimmed"
				truncate
				className={item.shimmer ? "reasoning-step-shimmer" : undefined}
				style={{ flex: 1, minWidth: 0, lineHeight: TRACE_ROW_LINE_HEIGHT }}
			>
				{item.title || "…"}
			</Text>
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
				style={{ cursor: collapseItems ? "pointer" : "default", userSelect: "none" }}
				onClick={collapseItems ? () => setItemsOpened((opened) => !opened) : undefined}
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
						style={{
							cursor: "pointer",
							userSelect: "none",
							minHeight: TRACE_ROW_MIN_HEIGHT,
						}}
						onClick={toggleEarlier}
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
					/>
				))}
			</LazyCollapse>
		</Box>
	);
});

// CSS keyframes — inject once. A subtle gradient text shimmer marks the latest
// live row while the model is still working. Shared by every trace kind.
if (typeof document !== "undefined") {
	const id = "reasoning-step-shimmer-style";
	if (!document.getElementById(id)) {
		const style = document.createElement("style");
		style.id = id;
		style.textContent = `
@keyframes reasoning-step-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.reasoning-step-shimmer {
  background: linear-gradient(
    90deg,
    var(--mantine-color-dimmed) 0%,
    var(--mantine-color-dimmed) 35%,
    light-dark(rgba(0,0,0,.85), rgba(255,255,255,.92)) 50%,
    var(--mantine-color-dimmed) 65%,
    var(--mantine-color-dimmed) 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: reasoning-step-shimmer 2.2s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .reasoning-step-shimmer { animation: none; -webkit-text-fill-color: currentColor; }
}
`;
		document.head.appendChild(style);
	}
}
