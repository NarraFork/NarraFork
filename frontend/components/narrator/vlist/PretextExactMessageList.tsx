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

import { useNarratorWS } from "@frontend/hooks/useNarratorWS";
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
import type { ChunkedMessageListHandle, ChunkTailMeta } from "../ChunkedMessageList";
import type { MessageSelectionResolver } from "../MessageSelectionCtx";
import { findLatestSpecTasksToolUseId } from "../narrator-message-helpers";
import type { NarratorMsg } from "../narrator-panel-types";
import { useRenderLod } from "../RenderLodCtx";
import { recentRunSegmentMessageIds } from "../run-segments";
import { getCategory, getCategoryColor } from "../tool-display";
import type { RenderLod } from "./prepared-block";
import { buildPretextDocumentLayout } from "./pretext-document-layout";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { useExactStreamingTail } from "./useExactStreamingTail";
import { usePretextDocument } from "./usePretextDocument";
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
import type { VListItem } from "./vlist-pipeline";
import {
	buildSelectionIndex,
	computeSelectedRange,
	entriesToBlockMeta,
	entriesToMessageIds,
	entriesToText,
	type SelectionIndex,
} from "./vlist-selection";
import { buildTailMeta, type TailMetaMessage } from "./vlist-tail-meta";

const ITEM_OVERSCAN = 600;
const PAGE_PADDING = 16;
const ITEM_GAP = 4;
const CHAT_MAX_WIDTH = 860;
const BOTTOM_DISTANCE_EPSILON = 1;
const STREAMING_PLACEHOLDER_ID = "__streaming__";

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

/** Kinds whose card open/close is user-toggleable (needs onToggle). */
const TOGGLEABLE_CARD_KINDS = new Set(["reasoning", "tool-call", "subagent-card"]);
/** Trace-family kinds with header/earlier/row toggles. */
const TRACE_KINDS = new Set(["activity-trace", "tool-run-summary", "reasoning-steps"]);

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

interface ExactRowProps {
	item: VListItem;
	top: number;
	height: number;
	itemId: string | undefined;
	sourceIds: readonly string[];
	/** Interaction signature for this row's key; changes force a re-render. */
	interactionSig: string;
	toggles: RowToggles;
}

/**
 * One absolutely-positioned mounted row. Memoized: during scroll (window shift)
 * only rows entering/leaving the window render; rows still in view skip React
 * work unless their item, geometry, or interaction signature changed.
 */
const ExactRow = memo(
	function ExactRow({ item, top, height, itemId, sourceIds, toggles }: ExactRowProps) {
		const extra = resolveRenderExtra(item.spec);
		const kind = item.spec.kind;
		if (TOGGLEABLE_CARD_KINDS.has(kind)) {
			extra.onToggle = toggles.onToggle;
		}
		if (TRACE_KINDS.has(kind)) {
			extra.onToggleItems = toggles.onToggleItems;
			extra.onToggleEarlier = toggles.onToggleEarlier;
			extra.onToggleRow = toggles.onToggleRow;
		}
		const body = renderElement(kind, item.measured, extra);
		return (
			<div
				id={itemId}
				data-message-id={sourceIds[0]}
				style={{
					position: "absolute",
					top,
					left: 0,
					width: "100%",
					height,
					overflow: "hidden",
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
				{body}
			</div>
		);
	},
	(prev, next) =>
		prev.item === next.item &&
		prev.top === next.top &&
		prev.height === next.height &&
		prev.itemId === next.itemId &&
		prev.interactionSig === next.interactionSig &&
		prev.toggles === next.toggles,
);

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
): boolean {
	return hasIndex && messageRevision > appliedRevision;
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
		pruneDividerLabel,
		tailFooter,
	} = props;
	const lod = useRenderLod() as RenderLod;
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

	const pretextDocument = usePretextDocument(narratorId, {
		lod,
		widthBucket: String(Math.round(contentWidth)),
		contentWidth,
		viewportHeight,
		scrollTop,
		pinnedToBottom,
		getCurrentView: readCurrentView,
		gap: ITEM_GAP,
		topPadding: PAGE_PADDING,
		bottomPadding: PAGE_PADDING,
		pruneDividerLabel,
		isExpanded: resolveExpanded,
		isLodUserOverride: resolveLodUserOverride,
		showEarlier: resolveShowEarlier,
		expandedRows: resolveExpandedRows,
		resolveToolCategory: getCategory,
		resolveToolColor: resolveExactToolColor,
		resolveRecentMessageIds,
		onScrollTopCorrection,
	});

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
	useEffect(() => {
		if (
			!shouldReloadExactDocument(
				messageRevision,
				appliedMessageRevisionRef.current,
				!!pretextDocument.index,
			)
		)
			return;
		appliedMessageRevisionRef.current = messageRevision;
		pretextDocument.reload();
	}, [messageRevision, pretextDocument.index, pretextDocument.reload]);

	const exactLayout = useMemo(
		() => buildExactListLayout(pretextDocument.index),
		[pretextDocument.index],
	);
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

		// Advance scrollTop state only when it changes the mounted window; this is
		// the sole re-render trigger for scrolling.
		const layout = exactLayoutRef.current;
		if (!layout) return;
		const nextWindow = resolveVisibleWindow(layout, nextTop, viewportHeight, ITEM_OVERSCAN);
		const cur = visibleRef.current;
		if (nextWindow.start !== cur.start || nextWindow.end !== cur.end) {
			setScrollTop(nextTop);
		}
	}, [onAtBottomChange, onUnreadCountChange, viewportHeight]);

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
		const onWheel = (event: WheelEvent) => {
			const dir = resolveWheelLodStep(event);
			if (dir === null) {
				if (event.deltaY < 0) detachFromBottom();
				return;
			}
			event.preventDefault();
			emit(dir);
		};
		const onTouchStart = (event: TouchEvent) => {
			if (event.touches.length !== 2) return;
			pinchActive = true;
			pinchBaseline = pinchDistance(Array.from(event.touches));
		};
		const onTouchMove = (event: TouchEvent) => {
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
						{renderItems.slice(visible.start, visible.end).map((item, offset) => {
							const itemIndex = visible.start + offset;
							const geometry = exactLayout.items[itemIndex];
							const manifestItem = manifestItems[itemIndex];
							if (!item || !geometry || !manifestItem) return null;
							const sourceIds = sourceIdsForItem(item, manifestItem);
							const itemId = domIdForItem(item, sourceIds);
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
					<div data-pretext-exact-streaming-tail style={{ position: "relative" }}>
						{streamingItems.map((item, index) => {
							const extra = resolveRenderExtra(item.spec);
							const body = renderElement(item.spec.kind, item.measured, extra);
							return (
								<div
									key={item.spec.key}
									style={{
										position: "relative",
										minHeight: item.measured.height,
										marginBottom: index < streamingItems.length - 1 ? ITEM_GAP : 0,
									}}
								>
									{body}
								</div>
							);
						})}
					</div>
				) : null}
				{tailFooter ? <div ref={footerNodeRef}>{tailFooter}</div> : null}
			</div>
		</div>
	);
});

PretextExactMessageList.displayName = "PretextExactMessageList";
