/**
 * PretextExactMessageList.tsx — experimental exact-layout shell.
 *
 * Unlike the legacy PretextMessageList, this component has one scroll coordinate
 * system: the complete ordered document is measured at the current LOD/width,
 * the returned prefix index defines the canvas height, and mounted items are
 * absolutely positioned at those exact offsets. No band height, sparse spacer,
 * or server estimate participates in the history scroll height.
 *
 * It is intentionally opt-in while browser calibration and interaction parity are
 * completed. The existing PretextMessageList remains the default Virtual route.
 */

import { UserAvatar } from "@frontend/components/UserAvatar";
import { useLocalPref } from "@frontend/hooks/useLocalPref";
import { useNarratorWS } from "@frontend/hooks/useNarratorWS";
import { useUserPreferences } from "@frontend/hooks/useUserPreferences";
import { formatLocaleDateTime, formatLocaleTime } from "@frontend/lib/intl-format";
import { Box, Group, Loader, Text } from "@mantine/core";
import type { CatchUpCursor } from "@shared/narrator-catch-up";
import { type PretextLayoutIndex, resolveVisibleWindow } from "@shared/pretext-layout";
import type { LaidOutItem, ListLayout } from "@shared/pretext-layout/vlist-virtualization";
import {
	forwardRef,
	type MutableRefObject,
	memo,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { ChunkedMessageListHandle, ChunkTailMeta } from "../ChunkedMessageList";
import {
	resolveOlderHistoryAutoLoad,
	resolveOlderHistoryAutoLoadEnabled,
} from "../chunk-scroll-utils";
import { ManualOlderHistoryLoad } from "../ManualOlderHistoryLoad";
import { type MessageContextMenuActions, MessageContextMenuCtx } from "../MessageContextMenuCtx";
import { type MessageSelectionResolver, makeMessageBlockSelectionId } from "../MessageSelectionCtx";
import { findLatestSpecTasksToolUseId } from "../narrator-message-helpers";
import type { NarratorMsg, PermissionCallbacks } from "../narrator-panel-types";
import { useRenderLod } from "../RenderLodCtx";
import { recentRunSegmentMessageIds } from "../run-segments";
import { TraceRowInteraction } from "../TraceRowInteraction";
import { getCategory, getCategoryColor } from "../tool-display";
import type { TraceRowIdentity } from "../trace-row-identity";
import type { MeasuredTraceRow } from "./measure/measure-tool-run";
import type { RenderLod } from "./prepared-block";
import { buildPretextDocumentLayout } from "./pretext-document-layout";
import type { TraceRowInteractionSlot } from "./render/RenderToolRun";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { useExactStreamingTail } from "./useExactStreamingTail";
import { usePretextDocument } from "./usePretextDocument";
import { VListRowInteraction } from "./VListRowInteraction";
import { resolveVListBlockTarget, toolUseIdFromBlockId } from "./vlist-block-target";
import {
	hasEffectiveHeightOverride,
	layoutItemsWithOverrides,
	pruneHeightOverrides,
} from "./vlist-height-overrides";
import {
	createVListInteractionState,
	resetVListInteractionStateForLod,
	setVListExpanded,
	toggleVListLodUserOverride,
	toggleVListRow,
	toggleVListShowEarlier,
	type VListInteractionState,
} from "./vlist-interaction-state";
import {
	createLodStepThrottle,
	pinchDistance,
	resolvePinchLodStep,
	resolveWheelLodStep,
} from "./vlist-lod-gesture";
import { usePermissionSlots } from "./vlist-permission-bridge";
import type { VListItem } from "./vlist-pipeline";
import {
	buildRowCtxActions,
	buildRowToolActions,
	type VListRowHandlers,
	type VListRowToolActions,
} from "./vlist-row-actions";
import {
	buildSelectionIndex,
	computeSelectedRange,
	entriesToBlockMeta,
	entriesToMessageIds,
	entriesToText,
	type SelectionIndex,
} from "./vlist-selection";
import { buildTailMeta, type TailMetaMessage } from "./vlist-tail-meta";
import { buildToolMetaIndex, type VListToolMeta } from "./vlist-tool-meta";

const ITEM_OVERSCAN = 600;
const PAGE_PADDING = 16;
/** Tight gap between items INSIDE one render unit (content blocks / in-run cards). */
const ITEM_GAP = 4;
/**
 * Wider gap between top-level render units (a message, a whole tool-run, a
 * divider). Matches the classic ChunkedMessageList's 12px inter-message spacing;
 * the exact layout keeps intra-unit items at ITEM_GAP so runs stay compact.
 */
const SEGMENT_GAP = 12;
const CHAT_MAX_WIDTH = 860;
const BOTTOM_DISTANCE_EPSILON = 1;
const STREAMING_PLACEHOLDER_ID = "__streaming__";
/** Scroll distance from the top within which an upward gesture may auto-load older history. */
const OLDER_LOAD_TRIGGER_PX = 400;
/** Constant-height header that hosts the manual "load older" control (never resizes). */
const OLDER_HEADER_HEIGHT = 40;
/**
 * Tool-run frame chrome — parity with the legacy ToolRunFrame (MessageRenderer.tsx)
 * + the standalone RenderToolCall card. Inlined here (not imported from the heavy
 * ToolCallCard module) to keep vlist self-contained. A consecutive run (≥2) of
 * frameless in-run tool/subagent cards is wrapped in this decorative frame so it
 * reads as one grouped container, matching the non-virtual path.
 */
const TOOL_RUN_FRAME_BG = "color-mix(in srgb, var(--mantine-color-body) 50%, transparent)";
const TOOL_RUN_FRAME_BORDER = "1px solid var(--mantine-color-default-border)";

type ScrollRef = RefObject<HTMLElement | null> | ((node: HTMLDivElement | null) => void);

type PretextExactMessageListProps = {
	narratorId: string;
	isSubagent?: boolean;
	/** Narrator is working/waiting → render the live streaming tail overlay. */
	isActive?: boolean;
	scrollRef?: ScrollRef;
	contentRef?: RefObject<HTMLDivElement | null>;
	onAtBottomChange?: (atBottom: boolean) => void;
	onUnreadCountChange?: (count: number) => void;
	onTailMetaChange?: (meta: ChunkTailMeta) => void;
	onLodStep?: (dir: 1 | -1) => void;
	onSelectionResolverChange?: (resolver: MessageSelectionResolver | null) => void;
	/** Single-block action handlers (fork/rollback/delete/compact/askInPassing),
	 *  same names/signatures as ChunkedMessageList's props. Optional — an absent
	 *  handler hides the corresponding menu item. */
	rowHandlers?: VListRowHandlers;
	/** Permission decision callbacks + live pending permissions, same source as
	 *  the chunked path's `permCb` (renderPermCb). Absent → permission rows fall
	 *  back to the read-only zero-DOM copy (no interaction). */
	permCb?: PermissionCallbacks;
	pruneDividerLabel?: string;
	tailFooter?: ReactNode;
};

function getScrollBottomTarget(node: HTMLElement | null): number {
	return node ? Math.max(0, node.scrollHeight - node.clientHeight) : 0;
}

function getDistanceFromBottom(node: HTMLElement): number {
	return Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight);
}

function waitAnimationFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function setExternalRef<T>(ref: RefObject<T | null> | undefined, value: T | null): void {
	if (ref && "current" in ref) (ref as MutableRefObject<T | null>).current = value;
}

export function buildExactListLayout(
	index: PretextLayoutIndex | undefined,
): ListLayout | undefined {
	if (!index) return undefined;
	const items: LaidOutItem[] = index.itemStarts.map((top, itemIndex) => {
		const end = index.itemEnds[itemIndex] ?? top;
		return { top, height: Math.max(0, end - top), bottom: end };
	});
	return { items, totalHeight: index.totalHeight };
}

/**
 * True when a rendered item is a frameless in-run card (tool-call in a multi-card
 * run, or an in-run subagent card). These carry no border of their own and rely
 * on the grouping frame the legacy path draws around a whole tool-run.
 */
export function isFramedRunItem(item: VListItem | undefined): boolean {
	if (!item) return false;
	const m = item.measured as { inRun?: boolean; borderHeight?: number };
	if (item.spec.kind === "tool-call") return m.inRun === true;
	if (item.spec.kind === "subagent-card") return m.borderHeight === 0;
	return false;
}

/**
 * Maximal consecutive runs (length ≥ 2) of frameless in-run tool/subagent cards.
 * Each run is drawn inside one decorative frame — parity with the legacy
 * ToolRunFrame's `isMultiRun && lod >= 4` grouping. Single in-run items never
 * occur (a lone tool-run item renders standalone with its own border), but the
 * ≥ 2 guard keeps this defensive.
 */
export function computeToolRunFrames(
	items: readonly (VListItem | undefined)[],
): Array<{ start: number; end: number }> {
	const runs: Array<{ start: number; end: number }> = [];
	let i = 0;
	while (i < items.length) {
		if (isFramedRunItem(items[i])) {
			let j = i;
			while (j + 1 < items.length && isFramedRunItem(items[j + 1])) j++;
			if (j > i) runs.push({ start: i, end: j });
			i = j + 1;
		} else {
			i++;
		}
	}
	return runs;
}

function sourceIdsForItem(
	item: VListItem,
	manifestItem: { sourceMessageIds: readonly string[] } | undefined,
): string[] {
	const data = item.spec.data as { id?: unknown } | null;
	const ids = [
		typeof data?.id === "string" ? data.id : null,
		...(manifestItem?.sourceMessageIds ?? []),
	].filter((id): id is string => !!id);
	return [...new Set(ids)];
}

function domIdForItem(item: VListItem, sourceIds: readonly string[]): string | undefined {
	const data = item.spec.data as { id?: unknown } | null;
	const id = typeof data?.id === "string" ? data.id : sourceIds[0];
	return id ? `msg-${id}` : undefined;
}

function messageIdFromTarget(target: string): string {
	return target.startsWith("msg-") ? target.slice(4) : target;
}

/**
 * Render the live streaming tail as a relative-flow node list. Unlike the stable
 * canvas (absolutely positioned, so the frame is a decorative overlay), the tail
 * items grow with streaming deltas, so a consecutive in-run tool/subagent run is
 * wrapped in a real bordered Box that contains the cards — matching the grouped
 * frame of the committed canvas and the legacy path.
 */
function renderStreamingTailNodes(
	items: readonly VListItem[],
	animateStreaming: boolean,
	narratorId: string,
): ReactNode[] {
	const frameEndByStart = new Map<number, number>();
	for (const run of computeToolRunFrames(items)) frameEndByStart.set(run.start, run.end);

	const renderOne = (item: VListItem, marginBottom: number) => {
		const extra = resolveRenderExtra(item.spec);
		// Media / tool-call details resolve images against the panel narrator.
		extra.narratorId = narratorId;
		// Streaming tail only: per-grapheme fade-in for freshly-appended text when
		// advanced animation is on. Never applied to the stable exact rows, and
		// only to markdown / reasoning bodies (parity with the classic path).
		if (animateStreaming && (item.spec.kind === "markdown" || item.spec.kind === "reasoning")) {
			extra.animateStreaming = true;
			extra.animKeyBase = item.spec.key;
		}
		return (
			<div
				key={item.spec.key}
				style={{ position: "relative", minHeight: item.measured.height, marginBottom }}
			>
				{renderElement(item.spec.kind, item.measured, extra)}
			</div>
		);
	};

	const nodes: ReactNode[] = [];
	let i = 0;
	while (i < items.length) {
		const end = frameEndByStart.get(i);
		if (end !== undefined) {
			const group = items.slice(i, end + 1);
			const lastSegment = end === items.length - 1;
			nodes.push(
				<div
					key={`stream-frame-${group[0]?.spec.key ?? i}`}
					data-tool-run-frame
					style={{
						position: "relative",
						border: TOOL_RUN_FRAME_BORDER,
						borderRadius: "var(--mantine-radius-sm)",
						background: TOOL_RUN_FRAME_BG,
						overflow: "hidden",
						boxSizing: "border-box",
						marginBottom: lastSegment ? 0 : ITEM_GAP,
					}}
				>
					{group.map((groupItem, groupIndex) =>
						renderOne(groupItem, groupIndex < group.length - 1 ? ITEM_GAP : 0),
					)}
				</div>,
			);
			i = end + 1;
		} else {
			const item = items[i];
			if (item) nodes.push(renderOne(item, i === items.length - 1 ? 0 : ITEM_GAP));
			i++;
		}
	}
	return nodes;
}

/** Kinds whose card open/close is user-toggleable (needs onToggle). */
const TOGGLEABLE_CARD_KINDS = new Set(["reasoning", "tool-call", "subagent-card"]);
/** Trace-family kinds with header/earlier/row toggles. */
const TRACE_KINDS = new Set(["activity-trace", "tool-run-summary", "reasoning-steps"]);
/**
 * Folded traces whose individual ROWS get their own interaction surface.
 *
 * `reasoning-steps` is excluded on purpose: that element already receives an
 * element-level menu (it is in vlist-block-target's BLOCK_INDEXED_KINDS), and its
 * rows all belong to the same reasoning run — so a row menu would be a redundant
 * nested duplicate of the element's own.
 */
const TRACE_ROW_INTERACTION_KINDS = new Set(["activity-trace", "tool-run-summary"]);

/**
 * Resolve a measured trace row into the authoritative selection identity.
 *
 * The adapter attaches only message coordinates (and a toolUseId): it cannot know
 * whether a tool is filed under `tc-` or `sa-`, because that depends on the child
 * messages it never sees. The selection index does know, and registers both
 * aliases — so look the entry up and use its PRIMARY blockId. That matters
 * because `entriesToBlockMeta` / `computeSelectedRange` test membership against
 * the primary id; selecting a row under the wrong alias would highlight it but
 * make the selection toolbar silently skip it.
 *
 * Returns null when no selection entry exists (streaming / id-less rows), leaving
 * the row plain.
 */
function resolveTraceRowIdentity(
	row: MeasuredTraceRow,
	selectionIndex: SelectionIndex,
	toolMetaIndex: Map<string, VListToolMeta>,
): TraceRowIdentity | null {
	const rowIdentity = row.identity;
	if (!rowIdentity?.messageId) return null;

	const { messageId, toolUseId } = rowIdentity;
	// Tool rows resolve through either alias; content rows through msg-{id}-{index}.
	const lookupId = toolUseId
		? `tc-${toolUseId}`
		: makeMessageBlockSelectionId(messageId, rowIdentity.blockIndex);
	const entry = selectionIndex.byBlockId.get(lookupId);
	if (!entry) return null;

	const identity: TraceRowIdentity = {
		blockId: entry.blockId,
		messageId: entry.messageId,
		blockIndex: entry.blockIndex,
		blockIndices: entry.blockIndices ?? rowIdentity.blockIndices,
	};
	if (entry.copyText?.trim()) identity.copyText = entry.copyText;
	if (toolUseId) {
		const meta = toolMetaIndex.get(toolUseId);
		identity.tool = {
			toolName: rowIdentity.toolName ?? meta?.toolName ?? "",
			toolUseId,
			...(meta?.filePath ? { filePath: meta.filePath } : {}),
			...(meta?.isReadTool ? { isReadTool: true } : {}),
			// Embedded metadata only — never a per-row network lookup.
			...(meta?.awaitAgentNarratorId ? { awaitAgentNarratorId: meta.awaitAgentNarratorId } : {}),
		};
	}
	return identity;
}

/**
 * Compact signature of everything in the interaction state that can change a
 * single row's height/appearance. Rows whose signature is unchanged (and whose
 * item + geometry are unchanged) can skip re-rendering entirely during scroll.
 */
function rowInteractionSig(state: VListInteractionState, key: string): string {
	const expanded = state.expanded.get(key);
	const lodOverride = state.lodUserOverrides.has(key) ? 1 : 0;
	const showEarlier = state.showEarlier.has(key) ? 1 : 0;
	const rows = state.expandedRows.get(key);
	const rowsSig = rows && rows.size > 0 ? [...rows].sort((a, b) => a - b).join(",") : "";
	return `${expanded === undefined ? "u" : expanded ? "1" : "0"}:${lodOverride}:${showEarlier}:${rowsSig}`;
}

/** Stable per-key toggle callbacks, memoized so equal rows keep referential props. */
interface RowToggles {
	onToggle: () => void;
	onToggleItems: () => void;
	onToggleEarlier: () => void;
	onToggleRow: (rowIndex: number) => void;
}

/**
 * Referential-stable interaction payload for one row, cached by spec.key so the
 * ExactRow memo keeps skipping unchanged rows during scroll. `copyText` and the
 * context-menu actions close over the resolved selection entry.
 */
interface RowInteraction {
	blockId: string;
	messageId: string;
	blockIndex: number;
	blockIndices?: readonly number[];
	copyText?: string;
	actions: MessageContextMenuActions;
	/** Tool-call id for tc-/sa- rows (drives the inspector item). */
	toolUseId?: string;
	/** Row tool facts (file path, child narrator, background state). */
	toolMeta?: VListToolMeta;
	/** Card-specific actions bound to this row's tool. */
	toolActions?: VListRowToolActions;
}

/** Message creator carried on user bubbles (avatar + name). */
interface BubbleCreator {
	id?: string;
	username: string;
	avatarColor?: string | null;
	avatarImageId?: string | null;
}

/** Format a message timestamp like MessageBubble: today → HH:mm, else MM/DD HH:mm. */
function formatBubbleTime(createdAt: string): string {
	const d = new Date(createdAt);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const isToday =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	return isToday
		? formatLocaleTime(d, { hour: "2-digit", minute: "2-digit" })
		: formatLocaleDateTime(d, {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
			});
}

/**
 * User bubble header row (avatar + username + timestamp), injected into the vlist
 * message-bubble render via `extra.header`. Mirrors MessageBubble's user header so
 * the virtual list matches the classic renderer. Lives in the integration layer
 * (not render/) so the pure render templates never import UserAvatar.
 */
function UserBubbleHeader({
	creator,
	createdAt,
}: {
	creator?: BubbleCreator | null;
	createdAt?: string | null;
}) {
	const { t } = useTranslation("narrator");
	return (
		<Group gap={6} wrap="nowrap" h="100%" align="center">
			{creator && (
				<UserAvatar
					username={creator.username}
					avatarColor={creator.avatarColor}
					avatarImageId={creator.avatarImageId}
					userId={creator.id}
					size={20}
					showTooltip={false}
				/>
			)}
			<Text size="xs" fw={600} c="indigo" style={{ whiteSpace: "nowrap" }}>
				{creator?.username ?? t("you")}
			</Text>
			{createdAt ? (
				<Text size="xs" c="dimmed" ml="auto" style={{ whiteSpace: "nowrap" }}>
					{formatBubbleTime(createdAt)}
				</Text>
			) : null}
		</Group>
	);
}

interface ExactRowProps {
	item: VListItem;
	top: number;
	height: number;
	itemId: string | undefined;
	sourceIds: readonly string[];
	/** Interaction signature for this row's key; changes force a re-render. */
	interactionSig: string;
	toggles: RowToggles;
	/** Present when this row carries a single-block interaction menu. */
	interaction?: RowInteraction;
	/**
	 * Folded traces only: wraps each row INSIDE the trace in its own interaction
	 * surface. Referentially stable per key so the memo below keeps skipping.
	 */
	rowInteraction?: TraceRowInteractionSlot;
	/** Panel narrator id — injected into extra so media/tool details load images. */
	narratorId: string;
	/**
	 * Live permission form node for a pending-permission tool/subagent card. When
	 * present, the row hosts a real interactive component whose height is measured
	 * after paint (see `onUnknownHeight`) instead of predicted arithmetically.
	 */
	permissionSlot?: ReactNode;
	/**
	 * Report this row's settled real-pixel height. Provided only for rows whose
	 * height cannot be predicted (permission form / unknown blocks); recorded as a
	 * per-key override that re-derives the canvas geometry.
	 */
	onUnknownHeight?: (height: number) => void;
}

/**
 * One absolutely-positioned mounted row. Memoized: during scroll (window shift)
 * only rows entering/leaving the window render; rows still in view skip React
 * work unless their item, geometry, or interaction signature changed.
 */
const ExactRow = memo(
	function ExactRow({
		item,
		top,
		height,
		itemId,
		sourceIds,
		toggles,
		interaction,
		rowInteraction,
		narratorId,
		permissionSlot,
		onUnknownHeight,
	}: ExactRowProps) {
		const extra = resolveRenderExtra(item.spec);
		const kind = item.spec.kind;
		if (TOGGLEABLE_CARD_KINDS.has(kind)) {
			extra.onToggle = toggles.onToggle;
		}
		if (TRACE_KINDS.has(kind)) {
			extra.onToggleItems = toggles.onToggleItems;
			extra.onToggleEarlier = toggles.onToggleEarlier;
			extra.onToggleRow = toggles.onToggleRow;
			// Folded traces: give each ROW inside the trace its own menu / selection.
			if (rowInteraction) extra.rowInteraction = rowInteraction;
		}
		// Media / tool-call details resolve images against the panel narrator.
		extra.narratorId = narratorId;
		// Subagent card's in-card "open full session" button. RenderSubagent has
		// always accepted onOpenSession, but nothing supplied it — the button was
		// inert. Bind it to the same action the row menu uses.
		if (kind === "subagent-card" && interaction?.toolActions?.onViewSubagentSession) {
			extra.onOpenSession = interaction.toolActions.onViewSubagentSession;
		}
		// A live permission form (pending-permission tool/subagent card) is injected
		// as a slot; the pure renderer draws it in place of the zero-DOM copy.
		if (permissionSlot !== undefined) extra.permissionSlot = permissionSlot;
		const body = renderElement(kind, item.measured, extra);
		const interactiveBody = interaction ? (
			<MessageContextMenuCtx.Provider value={interaction.actions}>
				<VListRowInteraction
					blockId={interaction.blockId}
					messageId={interaction.messageId}
					blockIndex={interaction.blockIndex}
					blockIndices={interaction.blockIndices}
					copyText={interaction.copyText}
					actions={interaction.actions}
					narratorId={narratorId}
					toolUseId={interaction.toolUseId}
					toolMeta={interaction.toolMeta}
					toolActions={interaction.toolActions}
				>
					{body}
				</VListRowInteraction>
			</MessageContextMenuCtx.Provider>
		) : (
			body
		);
		// Rows with a dynamic (post-paint measured) height cannot be clipped to the
		// arithmetic `height`: the real content may exceed it until onUnknownHeight
		// corrects the geometry. Such rows use `minHeight` + a ResizeObserver that
		// reports the settled height. All other rows keep the fixed-height, clipped
		// box (unchanged behaviour, zero added cost).
		const isDynamic = onUnknownHeight !== undefined;
		return (
			<div
				id={itemId}
				data-message-id={sourceIds[0]}
				style={{
					position: "absolute",
					top,
					left: 0,
					width: "100%",
					...(isDynamic ? { minHeight: height } : { height, overflow: "hidden" }),
				}}
			>
				{sourceIds.slice(1).map((sourceId) => (
					<span
						key={sourceId}
						id={`msg-${sourceId}`}
						data-message-id={sourceId}
						aria-hidden
						style={{ position: "absolute", width: 0, height: 0, pointerEvents: "none" }}
					/>
				))}
				{isDynamic ? (
					<DynamicHeightReporter onHeight={onUnknownHeight}>
						{interactiveBody}
					</DynamicHeightReporter>
				) : (
					interactiveBody
				)}
			</div>
		);
	},
	(prev, next) =>
		prev.item === next.item &&
		prev.top === next.top &&
		prev.height === next.height &&
		prev.itemId === next.itemId &&
		prev.interactionSig === next.interactionSig &&
		prev.toggles === next.toggles &&
		prev.interaction === next.interaction &&
		prev.rowInteraction === next.rowInteraction &&
		prev.narratorId === next.narratorId &&
		prev.permissionSlot === next.permissionSlot &&
		prev.onUnknownHeight === next.onUnknownHeight,
);

/**
 * Wrap a dynamic-height row body in a ResizeObserver that reports the subtree's
 * real pixel height. This is the CONTRACT's controlled DOM-measurement exception
 * (permission forms / unknown blocks) — it lives in the shell/render layer, never
 * in the pure measure path scanned by the zero-DOM guard.
 */
function DynamicHeightReporter({
	onHeight,
	children,
}: {
	onHeight: (height: number) => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement | null>(null);
	const onHeightRef = useRef(onHeight);
	onHeightRef.current = onHeight;
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		const report = () => {
			const h = node.offsetHeight;
			if (h > 0) onHeightRef.current(h);
		};
		report();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(report);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	return <div ref={ref}>{children}</div>;
}

export function applyExactScrollCorrection(
	nextTop: number,
	anchorKind: "bottom" | "item",
	footerHeight: number,
): number {
	return nextTop + (anchorKind === "bottom" ? Math.max(0, footerHeight) : 0);
}

export function shouldReloadExactDocument(
	messageRevision: number,
	appliedRevision: number,
	hasIndex: boolean,
	pinnedToBottom: boolean,
): boolean {
	// A structural reload replaces the whole loaded window with the tail page, so
	// performing it while the reader has scrolled up (reading history, possibly
	// after loadOlder) would discard their loaded window and snap them back to the
	// bottom. Defer until the reader is pinned to the bottom again; the newest
	// content lives there, so the deferred rebuild lands exactly where it matters.
	return hasIndex && messageRevision > appliedRevision && pinnedToBottom;
}

export function hasRenderableExactLayout(
	index: PretextLayoutIndex | undefined,
	renderItemCount: number,
	manifestItemCount: number,
): boolean {
	return !!index && renderItemCount === manifestItemCount;
}

export function buildExactCatchUpCursor(
	messages: readonly { id?: unknown }[],
): CatchUpCursor | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const id = messages[index]?.id;
		if (typeof id === "string" && id.length > 0) return { parentLastMessageId: id };
	}
	return undefined;
}

export const PretextExactMessageList = forwardRef<
	ChunkedMessageListHandle,
	PretextExactMessageListProps
>(function PretextExactMessageList(props, ref) {
	const {
		narratorId,
		isSubagent,
		isActive = false,
		scrollRef,
		contentRef,
		onAtBottomChange,
		onUnreadCountChange,
		onTailMetaChange,
		onLodStep,
		onSelectionResolverChange,
		rowHandlers,
		permCb,
		pruneDividerLabel,
		tailFooter,
	} = props;
	const lod = useRenderLod() as RenderLod;
	// Advanced-animation preference (same key AppRootLayout writes to <html>);
	// gates the streaming tail's per-grapheme fade-in. Reactive so toggling the
	// setting takes effect without a reload.
	const [advancedAnim] = useLocalPref("narrafork_advanced_anim");
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const contentNodeRef = useRef<HTMLDivElement | null>(null);
	const footerNodeRef = useRef<HTMLDivElement | null>(null);
	const pinnedToBottomRef = useRef(true);
	const suppressScrollStateRef = useRef(false);
	const [scrollTop, setScrollTop] = useState(0);
	// Always-current scrollTop (updated synchronously in onScroll) so anchor
	// capture / bottom detection read the live value without forcing a re-render
	// on every scroll pixel. React state (scrollTop) only advances when the
	// mounted window actually changes.
	const scrollTopRef = useRef(0);
	const scrollRafRef = useRef(0);
	const [viewportHeight, setViewportHeight] = useState(0);
	const viewportHeightRef = useRef(0);
	viewportHeightRef.current = viewportHeight;
	const [contentWidth, setContentWidth] = useState(CHAT_MAX_WIDTH);
	const [pinnedToBottom, setPinnedToBottom] = useState(true);
	const [footerHeight, setFooterHeight] = useState(0);
	const footerHeightRef = useRef(0);
	footerHeightRef.current = footerHeight;
	pinnedToBottomRef.current = pinnedToBottom;

	const assignViewport = useCallback(
		(node: HTMLDivElement | null) => {
			viewportRef.current = node;
			if (typeof scrollRef === "function") scrollRef(node);
			else setExternalRef(scrollRef, node);
		},
		[scrollRef],
	);
	const assignContent = useCallback(
		(node: HTMLDivElement | null) => {
			contentNodeRef.current = node;
			setExternalRef(contentRef, node);
		},
		[contentRef],
	);

	const writeScrollTop = useCallback((nextTop: number) => {
		const node = viewportRef.current;
		if (!node) return;
		suppressScrollStateRef.current = true;
		node.scrollTop = Math.max(0, nextTop);
		scrollTopRef.current = node.scrollTop;
		setScrollTop(node.scrollTop);
		requestAnimationFrame(() => {
			suppressScrollStateRef.current = false;
		});
	}, []);

	const onScrollTopCorrection = useCallback(
		(nextTop: number, anchorKind: "bottom" | "item") => {
			writeScrollTop(applyExactScrollCorrection(nextTop, anchorKind, footerHeightRef.current));
		},
		[writeScrollTop],
	);
	const [interaction, setInteraction] = useState<VListInteractionState>(() =>
		createVListInteractionState(lod),
	);
	if (interaction.lod !== lod) {
		setInteraction(resetVListInteractionStateForLod(interaction, lod));
	}
	// Per-key real-pixel height overrides for rows whose content cannot be
	// predicted arithmetically (mermaid / katex / unknown images, and the live
	// permission form). A row reports its settled height via `onUnknownHeight`;
	// the exact geometry is then re-derived with these overrides applied. Empty in
	// the common case (zero overhead — the base arithmetic layout is used as-is).
	const [heightOverrides, setHeightOverrides] = useState<ReadonlyMap<string, number>>(
		() => new Map(),
	);
	// Sub-pixel jitter guard: ignore reports within 1px of the recorded value so a
	// ResizeObserver settling animation cannot loop the layout.
	const setHeightOverride = useCallback((key: string, height: number) => {
		if (!Number.isFinite(height) || height < 0) return;
		const rounded = Math.round(height);
		setHeightOverrides((prev) => {
			const current = prev.get(key);
			if (current !== undefined && Math.abs(current - rounded) <= 1) return prev;
			const next = new Map(prev);
			next.set(key, rounded);
			return next;
		});
	}, []);
	// Stable per-key height reporter so a dynamic row keeps a referentially stable
	// onUnknownHeight prop and the ExactRow memo skips it during scroll.
	const unknownHeightReporterCacheRef = useRef<Map<string, (height: number) => void>>(new Map());
	const getUnknownHeightReporter = useCallback(
		(key: string): ((height: number) => void) => {
			const cached = unknownHeightReporterCacheRef.current.get(key);
			if (cached) return cached;
			const reporter = (height: number) => setHeightOverride(key, height);
			unknownHeightReporterCacheRef.current.set(key, reporter);
			return reporter;
		},
		[setHeightOverride],
	);
	const activeInteraction =
		interaction.lod === lod ? interaction : createVListInteractionState(lod);
	const resolveExpanded = useCallback(
		(key: string) => activeInteraction.expanded.get(key),
		[activeInteraction],
	);
	const resolveLodUserOverride = useCallback(
		(key: string) => activeInteraction.lodUserOverrides.has(key),
		[activeInteraction],
	);
	const resolveShowEarlier = useCallback(
		(key: string) => activeInteraction.showEarlier.has(key),
		[activeInteraction],
	);
	const resolveExpandedRows = useCallback(
		(key: string) => [...(activeInteraction.expandedRows.get(key) ?? [])],
		[activeInteraction],
	);
	const resolveExactToolColor = useCallback(
		(toolName: string, input?: unknown) => getCategoryColor(getCategory(toolName, input)),
		[],
	);
	const resolveRecentMessageIds = useCallback(
		(messages: readonly NarratorMsg[]) => recentRunSegmentMessageIds([...messages], 2),
		[],
	);
	const readCurrentView = useCallback(() => {
		const node = viewportRef.current;
		return {
			scrollTop: node?.scrollTop ?? scrollTopRef.current,
			viewportHeight: node?.clientHeight ?? viewportHeightRef.current,
			pinnedToBottom: node
				? getDistanceFromBottom(node) <= BOTTOM_DISTANCE_EPSILON
				: pinnedToBottomRef.current,
		};
	}, []);

	// Per-key measured lookup so stable toggle callbacks can read current state at
	// click time without depending on render-time closures. Populated below from
	// the current render items.
	const measuredByKeyRef = useRef<Map<string, VListItem["measured"]>>(new Map());
	const collapsesByLodByKeyRef = useRef<Map<string, boolean>>(new Map());
	// Stable RowToggles per key (memoized) so unchanged rows keep referential props
	// and skip React.memo re-render during scroll.
	const togglesCacheRef = useRef<Map<string, RowToggles>>(new Map());
	const getRowToggles = useCallback((key: string): RowToggles => {
		const cached = togglesCacheRef.current.get(key);
		if (cached) return cached;
		const toggles: RowToggles = {
			onToggle: () => {
				const measured = measuredByKeyRef.current.get(key) as
					| { effectiveOpened?: boolean; effectiveExpanded?: boolean; form?: string }
					| undefined;
				const current =
					measured?.effectiveOpened ?? measured?.effectiveExpanded ?? measured?.form === "expanded";
				if (collapsesByLodByKeyRef.current.get(key) === true) {
					setInteraction((prev) => toggleVListLodUserOverride(prev, key));
				} else {
					setInteraction((prev) => setVListExpanded(prev, key, !current));
				}
			},
			onToggleItems: () => {
				const measured = measuredByKeyRef.current.get(key) as
					| { header?: { opened?: boolean } }
					| undefined;
				setInteraction((prev) => setVListExpanded(prev, key, !(measured?.header?.opened ?? false)));
			},
			onToggleEarlier: () => setInteraction((prev) => toggleVListShowEarlier(prev, key)),
			onToggleRow: (rowIndex: number) =>
				setInteraction((prev) => toggleVListRow(prev, key, rowIndex)),
		};
		togglesCacheRef.current.set(key, toggles);
		return toggles;
	}, []);

	// The manual "load older" header lives in the exact canvas top padding, so its
	// height is part of totalHeight and needs no scroll-coordinate offset. It is
	// tracked as state (synced from hasPrev below) so it can be fed into the layout
	// input without a circular dependency on the hook's output. When it toggles
	// (older history exhausted), the anchor-preserving rebuild keeps the visible
	// content fixed while the reserved space changes off-screen above it.
	const [olderHeaderHeight, setOlderHeaderHeight] = useState(0);
	const { t } = useTranslation("narrator");
	const { t: tCommon } = useTranslation("common");
	// i18n labels forwarded to the pure adapter (which has no i18n import). Covers
	// the compact/segment-compact indicator lines (fixed in this change) plus the
	// system-card chrome the adapter otherwise renders in English. Only keys whose
	// adapter fallback name maps 1:1 to an existing translation are injected;
	// unmapped chrome keeps the adapter's English fallback. Interpolated labels
	// keep a literal `{count}` placeholder (the adapter substitutes the live
	// value), obtained by passing the placeholder string as the count.
	const countPlaceholder = "{count}" as unknown as number;
	const vlistLabels = useMemo<Record<string, string>>(
		() => ({
			compacting: t("compacting"),
			compacted: t("compacted"),
			compactFailed: t("compactFailed"),
			compactOutputChars: t("compactOutputChars", { count: countPlaceholder }),
			segmentCompacting: t("segmentCompacting"),
			segmentCompacted: t("segmentCompacted", { count: countPlaceholder }),
			segmentCompactFailed: t("segmentCompactFailed"),
			segmentCompactFailedDesc: t("segmentCompactFailedDesc"),
			dismiss: t("dismiss"),
			unknownError: tCommon("unknownError"),
			mergeSummaryLabel: t("mergeSummaryLabel"),
			reviewFeedbackLabel: t("reviewFeedbackLabel"),
			specProtectedBadge: t("specProtectedBadge"),
			specGoalAddedBadge: t("specGoalAddedBadge"),
			specGoalExistsBadge: t("specGoalExistsBadge"),
			specGoalViewTasks: t("specGoalViewTasks"),
			specContinuation: t("specContinuation"),
			specBlockedContinuation: t("specBlockedContinuation"),
		}),
		[t, tCommon],
	);
	// Pending-permission tool-use ids (from the live WS list). Feeds the adapter's
	// expand decision; its reference changes when the pending set changes, so the
	// document rebuilds (cards expand/collapse) as permissions come and go.
	const pendingPermissionToolUseIds = useMemo(() => {
		const ids = new Set<string>();
		for (const perm of permCb?.pendingPermissions ?? []) {
			if (perm.toolUseId) ids.add(perm.toolUseId);
		}
		return ids;
	}, [permCb?.pendingPermissions]);
	const resolveHasPendingPermission = useCallback(
		(toolUseId: string | undefined) =>
			toolUseId ? pendingPermissionToolUseIds.has(toolUseId) : false,
		[pendingPermissionToolUseIds],
	);
	const pretextDocument = usePretextDocument(narratorId, {
		lod,
		labels: vlistLabels,
		widthBucket: String(Math.round(contentWidth)),
		contentWidth,
		viewportHeight,
		scrollTop,
		pinnedToBottom,
		getCurrentView: readCurrentView,
		gap: ITEM_GAP,
		segmentGap: SEGMENT_GAP,
		topPadding: PAGE_PADDING + olderHeaderHeight,
		bottomPadding: PAGE_PADDING,
		pruneDividerLabel,
		isExpanded: resolveExpanded,
		isLodUserOverride: resolveLodUserOverride,
		showEarlier: resolveShowEarlier,
		expandedRows: resolveExpandedRows,
		resolveToolCategory: getCategory,
		resolveToolColor: resolveExactToolColor,
		resolveRecentMessageIds,
		resolveHasPendingPermission,
		onScrollTopCorrection,
	});

	// --- Reverse infinite scroll (load older) ---
	const {
		data: userPrefs,
		isLoading: userPrefsLoading,
		isFetched: userPrefsFetched,
	} = useUserPreferences();
	const autoLoadEnabled = resolveOlderHistoryAutoLoadEnabled(
		userPrefs?.autoLoadOlderMessages,
		userPrefsLoading,
	);
	const { hasPrev, loadingOlder, loadOlder } = pretextDocument;
	const hasPrevRef = useRef(hasPrev);
	hasPrevRef.current = hasPrev;
	const loadingOlderRef = useRef(loadingOlder);
	loadingOlderRef.current = loadingOlder;
	const autoLoadEnabledRef = useRef(autoLoadEnabled);
	autoLoadEnabledRef.current = autoLoadEnabled;
	const loadOlderRef = useRef(loadOlder);
	loadOlderRef.current = loadOlder;
	// A near-top scroll only auto-loads when it follows a recent upward gesture
	// (wheel/touch), mirroring the chunk list's intent gate so momentum settling
	// at the top does not endlessly page history.
	const olderHistoryIntentAtRef = useRef<number | null>(null);
	// Older history occupies a constant-height header reserved inside the exact
	// canvas top padding. It never changes height (button ↔ spinner ↔ empty all
	// reserve the same box in manual mode; auto mode shows a non-flow overlay), so
	// committed rows never shift when a page is (un)loading. Only its presence
	// toggles, and that is absorbed by the anchor-preserving rebuild off-screen.
	const showManualOlderLoad = userPrefsFetched && !autoLoadEnabled && hasPrev;
	const nextOlderHeaderHeight = showManualOlderLoad ? OLDER_HEADER_HEIGHT : 0;
	useEffect(() => {
		setOlderHeaderHeight(nextOlderHeaderHeight);
	}, [nextOlderHeaderHeight]);

	const [messageRevision, setMessageRevision] = useState(0);
	const appliedMessageRevisionRef = useRef(0);
	const initialRevisionSyncRef = useRef(true);
	const bumpMessageRevision = useCallback(() => {
		setMessageRevision((revision) => revision + 1);
	}, []);
	useEffect(() => {
		void narratorId;
		appliedMessageRevisionRef.current = 0;
		initialRevisionSyncRef.current = true;
		setMessageRevision(0);
	}, [narratorId]);

	const revisionSubscriptionId =
		pretextDocument.index && pretextDocument.status !== "loading" ? narratorId : undefined;
	const exactCatchUpCursor = useMemo(
		() => buildExactCatchUpCursor(pretextDocument.messages),
		[pretextDocument.messages],
	);
	useEffect(() => {
		if (!revisionSubscriptionId) return;
		initialRevisionSyncRef.current = true;
	}, [revisionSubscriptionId]);

	// The exact shell is stable-state only. Subscribe to the existing message
	// control stream once a complete document exists. Realtime mutations reload
	// the full exact input; reconnect catch-up reloads only when it reports data.
	useNarratorWS(
		revisionSubscriptionId,
		{
			onMessage: bumpMessageRevision,
			onUserMessage: bumpMessageRevision,
			onMessageUpdated: bumpMessageRevision,
			onMessagesDeleted: bumpMessageRevision,
			onPruneBoundary: bumpMessageRevision,
			onFullReload: bumpMessageRevision,
			// Live compact-progress ticks patch the loaded compact marker in place
			// (no refetch, no messageVersion bump) so the "…compacting · N chars"
			// label counts up smoothly during a blocking/background compaction.
			onCompactProgress: ({ messageId, outputChars, isSegment }) => {
				pretextDocument.applyCompactProgress(messageId, outputChars, !!isSegment);
			},
			onCatchUp: (orphanChildren, topLevel, subagentActivities) => {
				const initialSync = initialRevisionSyncRef.current;
				initialRevisionSyncRef.current = false;
				if (
					topLevel.length > 0 ||
					(!initialSync && (orphanChildren.length > 0 || subagentActivities.length > 0))
				) {
					bumpMessageRevision();
				}
			},
			onSyncOk: () => {
				initialRevisionSyncRef.current = false;
			},
		},
		exactCatchUpCursor,
		{ kind: "messages" },
	);
	// Structural reload gate. When the reader is pinned to the bottom, apply the
	// tail-first reload immediately (the newest content is exactly what they see).
	// When they have scrolled up, DEFER: leave appliedMessageRevisionRef behind so
	// the pending structural change is remembered, and rebuild only once they
	// return to the bottom (the effect below). This keeps a reader who is browsing
	// history — possibly deep into loadOlder pages — from being snapped back to the
	// tail every time a new message lands during active generation.
	useEffect(() => {
		if (
			!shouldReloadExactDocument(
				messageRevision,
				appliedMessageRevisionRef.current,
				!!pretextDocument.index,
				pinnedToBottom,
			)
		)
			return;
		appliedMessageRevisionRef.current = messageRevision;
		pretextDocument.reload();
	}, [messageRevision, pretextDocument.index, pretextDocument.reload, pinnedToBottom]);

	const exactLayout = useMemo(() => {
		const base = buildExactListLayout(pretextDocument.index);
		const index = pretextDocument.index;
		if (!base || !index) return base;
		const manifestItems = index.manifest.items;
		const keys = manifestItems.map((m) => m.itemKey);
		const heights = manifestItems.map((m) => m.height);
		// Skip the correction pass entirely when no override changes geometry.
		if (!hasEffectiveHeightOverride(keys, heights, heightOverrides)) return base;
		return layoutItemsWithOverrides(
			{
				heights,
				keys,
				gap: index.manifest.metrics.itemGap,
				topPadding: index.manifest.metrics.topPadding,
				bottomPadding: index.manifest.metrics.bottomPadding,
			},
			heightOverrides,
		);
	}, [pretextDocument.index, heightOverrides]);
	// The mounted window is derived from scrollTop, but scrollTop only advances
	// as React state when the window actually shifts (see onScroll), so in-window
	// scrolling triggers zero re-renders / reconciliation.
	const visible = useMemo(
		() =>
			exactLayout
				? resolveVisibleWindow(exactLayout, scrollTop, viewportHeight, ITEM_OVERSCAN)
				: { start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 },
		[exactLayout, scrollTop, viewportHeight],
	);
	const visibleRef = useRef(visible);
	visibleRef.current = visible;
	const exactLayoutRef = useRef(exactLayout);
	exactLayoutRef.current = exactLayout;

	// Live streaming tail: rendered as an overlay block below the stable exact
	// canvas (never injected into the document layout), so high-frequency deltas
	// never force a full-document layout recompute. Only active while working.
	const streamingMsg = useExactStreamingTail(narratorId, { enabled: isActive, isSubagent });
	const streamingItems = useMemo<readonly VListItem[]>(() => {
		if (!streamingMsg || !pretextDocument.index) return [];
		try {
			return buildPretextDocumentLayout([streamingMsg as unknown as NarratorMsg], {
				layoutRevision: "exact-streaming-tail",
				documentRevision: "streaming",
				lod,
				widthBucket: String(Math.round(contentWidth)),
				contentWidth,
				viewportHeight,
				gap: ITEM_GAP,
				topPadding: 0,
				bottomPadding: 0,
				labels: vlistLabels,
				isExpanded: resolveExpanded,
				isLodUserOverride: resolveLodUserOverride,
				showEarlier: resolveShowEarlier,
				expandedRows: resolveExpandedRows,
				resolveToolCategory: getCategory,
				resolveToolColor: resolveExactToolColor,
				recentMessageIds: streamingMsg.id ? new Set([streamingMsg.id]) : undefined,
			}).items;
		} catch {
			return [];
		}
	}, [
		streamingMsg,
		pretextDocument.index,
		lod,
		contentWidth,
		viewportHeight,
		vlistLabels,
		resolveExpanded,
		resolveLodUserOverride,
		resolveShowEarlier,
		resolveExpandedRows,
		resolveExactToolColor,
	]);
	const streamingTailHeight = useMemo(
		() => streamingItems.reduce((sum, item) => sum + item.measured.height + ITEM_GAP, 0),
		[streamingItems],
	);

	const selectionIndex = useMemo<SelectionIndex | null>(() => {
		if (pretextDocument.messages.length === 0) return null;
		return buildSelectionIndex(pretextDocument.messages as unknown as NarratorMsg[]);
	}, [pretextDocument.messages]);
	const selectionResolver = useMemo<MessageSelectionResolver | null>(() => {
		if (!selectionIndex) return null;
		return {
			resolveRange: (anchorBlockId, targetBlockId) => {
				const anchor = selectionIndex.byBlockId.get(anchorBlockId);
				const target = selectionIndex.byBlockId.get(targetBlockId);
				return anchor && target ? computeSelectedRange(selectionIndex, anchor, target) : null;
			},
			resolveSelectedMeta: (selectedIds) => entriesToBlockMeta(selectionIndex.entries, selectedIds),
			resolveSelectedMessageIds: (selectedIds) =>
				entriesToMessageIds(selectionIndex.entries, selectedIds),
			collectSelectedText: (selectedIds) => entriesToText(selectionIndex.entries, selectedIds),
		};
	}, [selectionIndex]);
	useEffect(() => {
		onSelectionResolverChange?.(selectionResolver);
		return () => onSelectionResolverChange?.(null);
	}, [onSelectionResolverChange, selectionResolver]);

	const tailMeta = useMemo(
		() =>
			buildTailMeta(pretextDocument.messages as readonly TailMetaMessage[], {
				statusReady: pretextDocument.status === "ready",
				pruneBoundaryMessageId: pretextDocument.pruneBoundaryMessageId,
				prunedPercent: pretextDocument.prunedPercent,
				streamingMsgId: STREAMING_PLACEHOLDER_ID,
				findSpecTasksToolUseId: (messages) =>
					findLatestSpecTasksToolUseId(messages as unknown as NarratorMsg[]),
			}),
		[
			pretextDocument.messages,
			pretextDocument.pruneBoundaryMessageId,
			pretextDocument.prunedPercent,
			pretextDocument.status,
		],
	);

	useEffect(() => {
		onTailMetaChange?.(tailMeta as ChunkTailMeta);
	}, [onTailMetaChange, tailMeta]);
	useEffect(() => {
		onUnreadCountChange?.(0);
	}, [onUnreadCountChange]);
	useEffect(() => {
		onAtBottomChange?.(pinnedToBottom);
	}, [onAtBottomChange, pinnedToBottom]);

	useLayoutEffect(() => {
		const node = viewportRef.current;
		if (!node) return;
		const measure = () => {
			setViewportHeight(node.clientHeight);
			setContentWidth(Math.max(1, Math.min(CHAT_MAX_WIDTH, node.clientWidth - PAGE_PADDING * 2)));
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	const hasTailFooter = tailFooter != null;
	useLayoutEffect(() => {
		const node = footerNodeRef.current;
		if (!hasTailFooter || !node) {
			setFooterHeight(0);
			return;
		}
		const measure = () => setFooterHeight(Math.max(0, node.offsetHeight));
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [hasTailFooter]);

	const scrollGeometryRevision = `${exactLayout?.totalHeight ?? 0}:${footerHeight}:${viewportHeight}:${Math.round(streamingTailHeight)}`;
	useEffect(() => {
		void scrollGeometryRevision;
		if (!pinnedToBottom || !exactLayout) return;
		const frame = requestAnimationFrame(() => {
			writeScrollTop(getScrollBottomTarget(viewportRef.current));
		});
		return () => cancelAnimationFrame(frame);
	}, [exactLayout, pinnedToBottom, scrollGeometryRevision, writeScrollTop]);

	// First-screen fill: the tail page alone may not cover the viewport (many
	// short messages). While pinned at the bottom with more history available,
	// keep pulling older pages until the canvas fills the viewport (or history is
	// exhausted). Each load grows totalHeight or clears hasPrev, so this settles.
	// Gated on !loadingOlder so one page is in flight at a time (no request storm).
	useEffect(() => {
		if (pretextDocument.status !== "ready") return;
		if (!hasPrev || loadingOlder) return;
		if (!pinnedToBottom) return;
		if (viewportHeight <= 0) return;
		const totalHeight = exactLayout?.totalHeight ?? 0;
		if (totalHeight > viewportHeight + ITEM_OVERSCAN) return;
		loadOlder();
	}, [
		exactLayout?.totalHeight,
		hasPrev,
		loadOlder,
		loadingOlder,
		pinnedToBottom,
		pretextDocument.status,
		viewportHeight,
	]);

	// Auto-load gate: a near-top scroll following a recent upward gesture extends
	// the loaded window. Manual mode (autoLoad off) never triggers here; the user
	// uses the header button instead. The exact rebuild anchors on the viewport
	// top, so the prepended page grows the canvas upward with zero visible shift.
	const maybeAutoLoadOlder = useCallback((scrollTopNow: number, atBottom: boolean) => {
		const decision = resolveOlderHistoryAutoLoad({
			intentAt: olderHistoryIntentAtRef.current,
			now: Date.now(),
			autoLoadEnabled: autoLoadEnabledRef.current,
			hasOlder: hasPrevRef.current,
			expanding: loadingOlderRef.current,
			atBottom,
			scrollTop: scrollTopNow,
			triggerPx: OLDER_LOAD_TRIGGER_PX,
		});
		olderHistoryIntentAtRef.current = decision.nextIntentAt;
		if (decision.shouldLoad) loadOlderRef.current();
	}, []);

	// Process a scroll frame: update the live scrollTop ref, keep bottom/pinned
	// state in sync, and ONLY advance scrollTop state (→ re-render) when the
	// mounted window changes. rAF-coalesced so multiple scroll events per frame
	// do at most one window computation.
	const processScrollFrame = useCallback(() => {
		scrollRafRef.current = 0;
		const node = viewportRef.current;
		if (!node) return;
		const nextTop = node.scrollTop;
		scrollTopRef.current = nextTop;

		const atBottom = getDistanceFromBottom(node) <= BOTTOM_DISTANCE_EPSILON;
		if (!suppressScrollStateRef.current && pinnedToBottomRef.current !== atBottom) {
			pinnedToBottomRef.current = atBottom;
			setPinnedToBottom(atBottom);
		}
		if (atBottom) onUnreadCountChange?.(0);
		onAtBottomChange?.(atBottom);
		maybeAutoLoadOlder(nextTop, atBottom);

		// Advance scrollTop state only when it changes the mounted window; this is
		// the sole re-render trigger for scrolling.
		const layout = exactLayoutRef.current;
		if (!layout) return;
		const nextWindow = resolveVisibleWindow(layout, nextTop, viewportHeight, ITEM_OVERSCAN);
		const cur = visibleRef.current;
		if (nextWindow.start !== cur.start || nextWindow.end !== cur.end) {
			setScrollTop(nextTop);
		}
	}, [maybeAutoLoadOlder, onAtBottomChange, onUnreadCountChange, viewportHeight]);

	const onScroll = useCallback(() => {
		if (scrollRafRef.current) return;
		scrollRafRef.current = requestAnimationFrame(processScrollFrame);
	}, [processScrollFrame]);
	useEffect(
		() => () => {
			if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
		},
		[],
	);

	const scrollToBottom = useCallback(
		(instant?: boolean) => {
			pinnedToBottomRef.current = true;
			setPinnedToBottom(true);
			if (instant) writeScrollTop(getScrollBottomTarget(viewportRef.current));
			else requestAnimationFrame(() => writeScrollTop(getScrollBottomTarget(viewportRef.current)));
		},
		[writeScrollTop],
	);
	const detachFromBottom = useCallback(() => {
		pinnedToBottomRef.current = false;
		setPinnedToBottom(false);
	}, []);

	const onLodStepRef = useRef(onLodStep);
	onLodStepRef.current = onLodStep;
	useEffect(() => {
		const node = viewportRef.current;
		if (!node) return;
		const throttle = createLodStepThrottle();
		let pinchActive = false;
		let pinchBaseline = 0;
		const emit = (dir: 1 | -1) => {
			if (!throttle.tryStep(Date.now())) return;
			onLodStepRef.current?.(dir);
		};
		// Record an upward gesture so the scroll handler's auto-load gate may fire
		// when it reaches the top. Intent expires (chunk-list parity) so momentum
		// alone never keeps paging.
		const markUpwardIntent = () => {
			olderHistoryIntentAtRef.current = Date.now();
		};
		const onWheel = (event: WheelEvent) => {
			const dir = resolveWheelLodStep(event);
			if (dir === null) {
				if (event.deltaY < 0) {
					detachFromBottom();
					markUpwardIntent();
				}
				return;
			}
			event.preventDefault();
			emit(dir);
		};
		let lastTouchY = 0;
		const onTouchStart = (event: TouchEvent) => {
			if (event.touches.length === 1) {
				lastTouchY = event.touches[0]?.clientY ?? 0;
				return;
			}
			if (event.touches.length !== 2) return;
			pinchActive = true;
			pinchBaseline = pinchDistance(Array.from(event.touches));
		};
		const onTouchMove = (event: TouchEvent) => {
			if (event.touches.length === 1) {
				// A finger dragging downward pulls earlier content into view (scroll
				// up): treat it as upward intent for the auto-load gate.
				const y = event.touches[0]?.clientY ?? 0;
				if (y - lastTouchY > 0) markUpwardIntent();
				lastTouchY = y;
				return;
			}
			if (!pinchActive || event.touches.length !== 2) return;
			const distance = pinchDistance(Array.from(event.touches));
			if (pinchBaseline <= 0) {
				pinchBaseline = distance;
				return;
			}
			const dir = resolvePinchLodStep(distance / pinchBaseline);
			if (dir === null) return;
			event.preventDefault();
			emit(dir);
			pinchBaseline = distance;
		};
		const onTouchEnd = (event: TouchEvent) => {
			if (event.touches.length < 2) pinchActive = false;
		};
		node.addEventListener("wheel", onWheel, { passive: false });
		node.addEventListener("touchstart", onTouchStart, { passive: true });
		node.addEventListener("touchmove", onTouchMove, { passive: false });
		node.addEventListener("touchend", onTouchEnd, { passive: true });
		return () => {
			node.removeEventListener("wheel", onWheel);
			node.removeEventListener("touchstart", onTouchStart);
			node.removeEventListener("touchmove", onTouchMove);
			node.removeEventListener("touchend", onTouchEnd);
		};
	}, [detachFromBottom]);

	const scrollToMessageTarget = useCallback(
		async ({ domIds, targetIds }: { domIds: string[]; targetIds: string[] }) => {
			const revealMounted = () => {
				const candidates = [
					...domIds,
					...targetIds.flatMap((target) => [target, `msg-${messageIdFromTarget(target)}`]),
				];
				for (const id of candidates) {
					const element = document.getElementById(id);
					if (!element) continue;
					pinnedToBottomRef.current = false;
					setPinnedToBottom(false);
					element.scrollIntoView?.({ block: "center" });
					return true;
				}
				return false;
			};
			if (revealMounted()) return true;
			const index = pretextDocument.index;
			const node = viewportRef.current;
			if (!index || !node) return false;
			for (const target of targetIds) {
				const messageId = messageIdFromTarget(target);
				const itemIndex = index.itemIndicesForSourceMessageId(messageId)[0];
				if (itemIndex == null) continue;
				const targetTop = index.itemStart(itemIndex) - Math.max(0, node.clientHeight / 2);
				pinnedToBottomRef.current = false;
				setPinnedToBottom(false);
				writeScrollTop(targetTop);
				await waitAnimationFrame();
				if (revealMounted()) return true;
			}
			return false;
		},
		[pretextDocument.index, writeScrollTop],
	);

	useImperativeHandle(
		ref,
		(): ChunkedMessageListHandle => ({
			scrollToBottom,
			refreshStructure: () => pretextDocument.reload(),
			detachFromBottom,
			scrollToMessageTarget,
		}),
		[detachFromBottom, pretextDocument.reload, scrollToBottom, scrollToMessageTarget],
	);

	const manifestItems = pretextDocument.manifest?.items ?? [];
	const renderItems = pretextDocument.items;
	const hasRenderableLayout = hasRenderableExactLayout(
		pretextDocument.index,
		renderItems.length,
		manifestItems.length,
	);

	// Decorative grouping frames for consecutive in-run tool/subagent card runs.
	// Rebuilt only when the document items change (not on scroll); drawn as
	// absolute overlays under the rows so the grouped run reads as one container.
	const toolRunFrames = useMemo(() => computeToolRunFrames(renderItems), [renderItems]);

	// Refresh the per-key measured lookup used by the stable toggle callbacks.
	// Rebuilt only when the document items change (not on scroll).
	useMemo(() => {
		const measuredMap = new Map<string, VListItem["measured"]>();
		const collapsesMap = new Map<string, boolean>();
		for (const item of renderItems) {
			if (!item) continue;
			measuredMap.set(item.spec.key, item.measured);
			collapsesMap.set(item.spec.key, item.spec.opts?.collapsesByLod === true);
		}
		measuredByKeyRef.current = measuredMap;
		collapsesByLodByKeyRef.current = collapsesMap;
		return null;
	}, [renderItems]);

	// Per-key interaction payloads (swipe/context menu + selection). Rebuilt only
	// when the selection index, the rendered items, or the panel handlers change
	// — never on scroll — so each row's payload stays referentially stable and
	// the ExactRow memo keeps skipping unchanged rows. Rows without a single-block
	// target (aggregates / non-interactive chrome) are absent and render plainly.
	const interactionsByKey = useMemo(() => {
		const map = new Map<string, RowInteraction>();
		if (!selectionIndex) return map;
		const manifestByKey = new Map(manifestItems.map((m) => [m.itemKey, m]));
		// Tool facts the layout spec deliberately drops (child narrator id, file
		// path, background state). Keyed by toolUseId — a tool/subagent row's
		// blockId is `tc-`/`sa-` + that id.
		const toolMetaIndex = buildToolMetaIndex(pretextDocument.messages as unknown as NarratorMsg[]);
		for (const item of renderItems) {
			if (!item) continue;
			const manifestItem = manifestByKey.get(item.spec.key);
			const sourceIds = manifestItem?.sourceMessageIds ?? [];
			const target = resolveVListBlockTarget(item.spec.kind, item.spec.key, sourceIds);
			if (!target) continue;
			const entry = selectionIndex.byBlockId.get(target.blockId);
			// Authoritative message id / block index come from the selection entry
			// when present (tool cards can't derive them from the spec); fall back
			// to the spec-derived values otherwise.
			const messageId = entry?.messageId ?? target.messageId;
			const blockIndex = target.blockIndex >= 0 ? target.blockIndex : (entry?.blockIndex ?? 0);
			const blockIndices = entry?.blockIndices ?? (blockIndex >= 0 ? [blockIndex] : undefined);
			// Copy is offered for text-bearing blocks; entry.copyText matches what
			// the chunked path copies. Tool cards expose no copy-text item (parity).
			const copyText = entry?.copyText?.trim() ? entry.copyText : undefined;
			const actions = buildRowCtxActions(
				{ messageId, blockIndex, blockIndices },
				rowHandlers ?? {},
			);
			// Tool / subagent rows carry the card-specific command items.
			const toolUseId = toolUseIdFromBlockId(target.blockId);
			const toolMeta = toolUseId ? toolMetaIndex.get(toolUseId) : undefined;
			const toolActions = toolMeta ? buildRowToolActions(toolMeta, rowHandlers ?? {}) : undefined;
			map.set(item.spec.key, {
				blockId: target.blockId,
				messageId,
				blockIndex,
				blockIndices,
				copyText,
				actions,
				toolUseId,
				toolMeta,
				toolActions,
			});
		}
		return map;
	}, [selectionIndex, renderItems, manifestItems, rowHandlers, pretextDocument.messages]);

	// Per-key ROW interaction slots for the folded traces (activity-trace /
	// tool-run-summary). This is a second, finer tier than `interactionsByKey`:
	// that one gives a whole list element its menu, this one gives each row INSIDE
	// a collapsed trace its own. Built in a memo that does NOT depend on scroll
	// state, so each slot stays referentially stable and the ExactRow memo keeps
	// skipping unchanged rows while scrolling.
	const rowInteractionByKey = useMemo(() => {
		const map = new Map<string, TraceRowInteractionSlot>();
		if (!selectionIndex) return map;
		const toolMetaIndex = buildToolMetaIndex(pretextDocument.messages as unknown as NarratorMsg[]);
		const handlers = rowHandlers ?? {};
		for (const item of renderItems) {
			if (!item || !TRACE_ROW_INTERACTION_KINDS.has(item.spec.kind)) continue;
			map.set(item.spec.key, (row, titleRow) => {
				const identity = resolveTraceRowIdentity(row, selectionIndex, toolMetaIndex);
				if (!identity) return null;
				const actions = buildRowCtxActions(
					{
						messageId: identity.messageId,
						blockIndex: identity.blockIndex,
						blockIndices: identity.blockIndices,
					},
					handlers,
				);
				return (
					<MessageContextMenuCtx.Provider value={actions}>
						<TraceRowInteraction
							identity={identity}
							actions={actions}
							narratorId={narratorId}
							onViewSubagentSession={handlers.onViewSubagentSession}
						>
							{titleRow}
						</TraceRowInteraction>
					</MessageContextMenuCtx.Provider>
				);
			});
		}
		return map;
	}, [selectionIndex, renderItems, rowHandlers, pretextDocument.messages, narratorId]);

	// Per-key live permission form nodes for pending-permission tool/subagent
	// cards. Built by the permission bridge (step 4); empty when no permission is
	// pending or `permCb` is absent, in which case every row renders normally.
	const permissionSlotByKey = usePermissionSlots({ renderItems, permCb });

	// Drop height overrides whose key no longer exists in the current manifest
	// (e.g. a permission resolved and its dynamic row collapsed back to a pure
	// arithmetic card). Keeps the override map bounded and prevents applying a
	// stale height to a recycled key.
	useEffect(() => {
		setHeightOverrides((prev) => {
			if (prev.size === 0) return prev;
			const liveKeys = new Set<string>();
			for (const item of renderItems) {
				if (item) liveKeys.add(item.spec.key);
			}
			return pruneHeightOverrides(prev, liveKeys) ?? prev;
		});
	}, [renderItems]);

	return (
		<div
			ref={assignViewport}
			onScroll={onScroll}
			style={{ position: "relative", height: "100%", overflow: "auto" }}
			data-pretext-exact-message-list
		>
			<div
				ref={assignContent}
				style={{ position: "relative", width: contentWidth, margin: "0 auto" }}
			>
				{hasRenderableLayout && exactLayout ? (
					<div
						style={{ position: "relative", height: exactLayout.totalHeight, overflow: "hidden" }}
						data-pretext-exact-canvas
					>
						{showManualOlderLoad ? (
							<div
								data-pretext-exact-older-header
								style={{
									position: "absolute",
									top: PAGE_PADDING,
									left: 0,
									width: "100%",
									height: OLDER_HEADER_HEIGHT,
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									overflow: "hidden",
								}}
							>
								<ManualOlderHistoryLoad
									autoLoadEnabled={autoLoadEnabled}
									hasOlder={hasPrev}
									loading={loadingOlder}
									label={t("loadOlderMessages")}
									onLoad={loadOlder}
								/>
							</div>
						) : null}
						{toolRunFrames.map((run) => {
							// Cull frames fully outside the mounted window.
							if (run.end < visible.start || run.start >= visible.end) return null;
							const topGeom = exactLayout.items[run.start];
							const bottomGeom = exactLayout.items[run.end];
							if (!topGeom || !bottomGeom) return null;
							return (
								<div
									key={`tool-run-frame-${run.start}`}
									data-tool-run-frame
									style={{
										position: "absolute",
										top: topGeom.top,
										left: 0,
										width: "100%",
										height: bottomGeom.bottom - topGeom.top,
										border: TOOL_RUN_FRAME_BORDER,
										borderRadius: "var(--mantine-radius-sm)",
										background: TOOL_RUN_FRAME_BG,
										boxSizing: "border-box",
										pointerEvents: "none",
									}}
								/>
							);
						})}
						{renderItems.slice(visible.start, visible.end).map((item, offset) => {
							const itemIndex = visible.start + offset;
							const geometry = exactLayout.items[itemIndex];
							const manifestItem = manifestItems[itemIndex];
							if (!item || !geometry || !manifestItem) return null;
							const sourceIds = sourceIdsForItem(item, manifestItem);
							const itemId = domIdForItem(item, sourceIds);
							const permissionSlot = permissionSlotByKey.get(item.spec.key);
							return (
								<ExactRow
									key={item.spec.key}
									item={item}
									top={geometry.top}
									height={geometry.height}
									itemId={itemId}
									sourceIds={sourceIds}
									interactionSig={rowInteractionSig(activeInteraction, item.spec.key)}
									toggles={getRowToggles(item.spec.key)}
									interaction={interactionsByKey.get(item.spec.key)}
									rowInteraction={rowInteractionByKey.get(item.spec.key)}
									narratorId={narratorId}
									permissionSlot={permissionSlot}
									onUnknownHeight={
										permissionSlot !== undefined
											? getUnknownHeightReporter(item.spec.key)
											: undefined
									}
								/>
							);
						})}
					</div>
				) : (
					<div data-pretext-exact-status style={{ minHeight: 64, padding: PAGE_PADDING }}>
						{pretextDocument.error?.message ?? "Loading exact message layout…"}
					</div>
				)}
				{streamingItems.length > 0 ? (
					<div
						data-pretext-exact-streaming-tail
						style={{ position: "relative", paddingBottom: PAGE_PADDING }}
					>
						{renderStreamingTailNodes(streamingItems, isActive && advancedAnim, narratorId)}
					</div>
				) : null}
				{tailFooter ? (
					<div ref={footerNodeRef} style={{ paddingBottom: PAGE_PADDING }}>
						{tailFooter}
					</div>
				) : null}
			</div>
			{/* Auto-load spinner: a non-flow overlay pinned to the viewport top so it
			    never participates in layout height (zero shift while paging). */}
			{autoLoadEnabled && loadingOlder ? (
				<Box
					data-pretext-exact-older-spinner
					style={{
						position: "sticky",
						top: 0,
						left: 0,
						width: "100%",
						height: 0,
						display: "flex",
						justifyContent: "center",
						pointerEvents: "none",
						zIndex: 2,
					}}
				>
					<Loader size="xs" mt={4} />
				</Box>
			) : null}
		</div>
	);
});

PretextExactMessageList.displayName = "PretextExactMessageList";
