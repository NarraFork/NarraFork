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

import { useCurrentUser } from "@frontend/hooks/useAuth";
import { useLocalPref } from "@frontend/hooks/useLocalPref";
import { useInterruptNarrator, useResumeRecoverySubagents } from "@frontend/hooks/useNarrator";
import { useNarratorWS } from "@frontend/hooks/useNarratorWS";
import { useNarratorPermissionsCapability } from "@frontend/hooks/usePlatform";
import { useUserPreferences } from "@frontend/hooks/useUserPreferences";
import { narratorsApi } from "@frontend/lib/api/narrators";
import type { TreeMessage } from "@frontend/lib/api/types";
import { subscribeAskInPassingEvents } from "@frontend/lib/ask-in-passing-events";
import { formatLocaleNumber } from "@frontend/lib/intl-format";
import {
	NARRATOR_COLUMN_GUTTER_PX,
	narratorColumnPlaceholderStyle,
	resolveNarratorColumnWidth,
} from "@frontend/lib/narrator-content-column";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import {
	createSmoothFollower,
	type SmoothFollower,
	shouldSmoothFollow,
} from "@frontend/lib/smooth-scroll";
import { Anchor, Box, Group, Loader, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { resolveVisibleWindow } from "@shared/pretext-layout";
import { liveTailSignature } from "@shared/pretext-layout/reasoning-live-tail";
import type { ToolCappedDetail } from "@shared/pretext-layout/tool-detail";
import { normalizeSubagentToolInputSummary } from "@shared/subagent-tool-summary";
import {
	forwardRef,
	lazy,
	type MutableRefObject,
	memo,
	type ReactNode,
	type RefObject,
	Suspense,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { HistoryRecoveryPanel } from "../HistoryRecoveryPanel";
import { ManualOlderHistoryLoad } from "../history/ManualOlderHistoryLoad";
import {
	resolveOlderHistoryAutoLoad,
	resolveOlderHistoryAutoLoadEnabled,
} from "../history/older-history-auto-load";
import { useRenderLod } from "../lod/RenderLodCtx";
import { type MessageSelectionResolver, useMessageSelection } from "../message/MessageSelectionCtx";
import { resolveEditorInitialText } from "../message/message-edit-text";
import type { MessageListHandle, MessageListTailMeta } from "../message/message-list-handle";
import { NarratorMessageListSkeleton } from "../NarratorMessageListSkeleton";
import { findLatestSpecTasksToolUseId } from "../narrator-message-helpers";
import type { NarratorMsg, PermissionCallbacks } from "../narrator-panel-types";
import { getGlobalSwipeAnchor, subscribeGlobalSwipeAnchor } from "../scroll/swipeState";
import {
	getCategory,
	getCategoryColor,
	getSummary,
	subagentRecentCallSummary,
} from "../tool-call/tool-display";
import { recentRunSegmentMessageIds } from "../trace/run-segments";
import {
	clearAllCompactProgress,
	clearCompactProgress,
	clearCompactProgressAliases,
	setCompactProgress,
} from "./compact-progress-store";
import { ExactRow } from "./ExactRow";
import type { InlinePermissionData } from "./measure/measure-permission";
import type { MeasuredSubagent } from "./measure/measure-subagent";
import { type MeasuredToolCall, toolCardInnerWidth } from "./measure/measure-tool-call";
import type { MeasuredCollapsibleTrace } from "./measure/measure-tool-run";
import type { RenderLod } from "./prepared-block";
import { resolveRenderExtra } from "./render-registry";
import { type UsePretextDocumentResult, usePretextDocument } from "./usePretextDocument";
import { useVListContentView } from "./useVListContentView";
import { useVListLabels } from "./useVListLabels";
import { useVListLivePatches } from "./useVListLivePatches";
import { useVListStreamingMessage } from "./useVListStreamingMessage";
import {
	sameToolDetailRequests,
	toolDetailRequestFromData,
	useVListToolDetails,
	type VListToolDetailRequest,
} from "./useVListToolDetails";
import { useVListTraceBindings } from "./useVListTraceBindings";
import { VListContentViewModal } from "./VListContentViewModal";
import { VListUserMarkers } from "./VListUserMarkers";
import { useVListAskInPassing } from "./vlist-ask-in-passing-bridge";
import { askInPassingBlock } from "./vlist-ask-in-passing-sync";
import { resolveVListBlockTarget, toolUseIdFromBlockId } from "./vlist-block-target";
import { useVListCompactActions } from "./vlist-compact-bridge";
import type { VListViewOwner, VListViewTarget } from "./vlist-content-view-target";
import { installVListCopyHandler } from "./vlist-copy-text";
import {
	buildDrillSnapshots,
	DRILL_MORPH_X_OFFSET,
	type DrillRowSnapshot,
	diffDrillSnapshots,
} from "./vlist-drill-morph";
import {
	drillBorderKeyframesFrom,
	drillMorphKeyframesFrom,
	drillTailKeyframesFrom,
} from "./vlist-drill-morph-motion";
import {
	hasEditableTextBlock,
	resolveVListEditedMeta,
	resolveVListEditTarget,
	type VListEditRole,
} from "./vlist-edit-target";
import { resolveErrorNoticeActions, useVListErrorNoticeActions } from "./vlist-error-actions";
import {
	buildExactMessageSnapshot,
	hasRenderableExactLayout,
	isCompactMarkerMessage,
	resolveExactCatchUpRevisionDelta,
} from "./vlist-exact-document";
import {
	buildExactListLayout,
	closingRowSig,
	computeToolRunFrames,
	cssAttrEscape,
	domIdForItem,
	foldRevisionOf,
	resolveRowHitHeight,
	sourceIdsForItem,
} from "./vlist-exact-layout";
import {
	ownerRequestKey,
	type RowInteraction,
	type RowToggles,
	resolveItemViewTargets,
	resolveRowOpenState,
	resolveTraceRowCardData,
	resolveTraceRowViewTargets,
	rowInteractionSig,
	rowSelectionBlockIds,
	sameRowInteraction,
	TRACE_ROW_INTERACTION_KINDS,
} from "./vlist-exact-row-state";
import {
	applyExactScrollCorrection,
	getDistanceFromBottom,
	getScrollBottomTarget,
	isBottomLostToContentGrowth,
	isSuppressedScrollEcho,
	isUpwardHistoryScroll,
} from "./vlist-exact-scroll";
import {
	type FoldRowGeometry,
	isFoldCaptureUsable,
	planFoldFrameMotion,
	planFoldMotion,
	planFoldNestedRowMotion,
	planFoldNestedRowResize,
} from "./vlist-fold-animation";
import {
	captureFoldFrameGeometry,
	captureFoldGeometry,
	captureFoldNestedRows,
	foldRowKeyframes,
	frameKeyframes,
	nestedResizeKeyframes,
	revealKeyframes,
	shiftKeyframes,
} from "./vlist-fold-motion";
import {
	resolveHeadTrim,
	resolveStreamingClearedTrimEdge,
	retainKeysInPlace,
	TRIM_FILL_COOLDOWN_MS,
	trimClockNow,
} from "./vlist-head-trim";
import {
	hasEffectiveHeightOverride,
	layoutItemsWithOverrides,
	pruneHeightOverrides,
} from "./vlist-height-overrides";
import { createHighlightController } from "./vlist-highlight";
import {
	resolveInterruptGuardActions,
	useInterruptGuardActions,
} from "./vlist-injection-guard-actions";
import type { InjectionNavigation } from "./vlist-injection-header";
import {
	createVListInteractionState,
	isFileChangesOpenRow,
	isFullPayloadRequestedRow,
	isPromptOpenRow,
	isTraceRowExpanded,
	markVListFullPayloadRequested,
	resetVListInteractionStateForLod,
	setVListExpanded,
	toggleVListFileChangesOpen,
	toggleVListLodUserOverride,
	toggleVListPromptOpen,
	toggleVListRow,
	toggleVListShowEarlier,
	toggleVListShowOriginal,
	toggleVListTraceRow,
	type VListInteractionState,
} from "./vlist-interaction-state";
import {
	jumpTargetItemIndex,
	jumpTargetMessageId,
	jumpTargetScrollTop,
	mountedJumpTarget,
	resolveJumpTargetSeq,
} from "./vlist-jump-target";
import { resolveJumpWindowDecision } from "./vlist-jump-window";
import {
	buildLifecycleSnapshot,
	type LifecycleElementSource,
	type LifecycleSnapshot,
	planLifecycleMotion,
} from "./vlist-lifecycle-motion";
import {
	createLodFocusPoint,
	createLodStepThrottle,
	type LodFocusPoint,
	pinchCenterY,
	pinchDistance,
	resolveLodFocusOffset,
	resolvePinchLodStep,
	resolveWheelLodStep,
} from "./vlist-lod-gesture";
import {
	buildLodSnapshots,
	diffLodSnapshots,
	type LodElementSnapshot,
	type LodElementSource,
} from "./vlist-lod-morph";
import { lodMorphKeyframesFrom } from "./vlist-lod-morph-motion";
import { createMorphDriver, type MorphDriver } from "./vlist-morph-driver";
import {
	admitPair,
	initialStateFor,
	type MorphElement,
	planMorphTargets,
} from "./vlist-morph-plan";
import {
	createMotionScheduler,
	drillScope,
	frameScope,
	LOD_MOTION_DURATION_MS,
	lifecycleScope,
	lodScope,
	type MotionOp,
	prefersReducedMotion,
	rowScope,
} from "./vlist-motion-scheduler";
import {
	toolUseIdFromSpecKey,
	usePermissionSlots,
	useTracePermissionSlots,
} from "./vlist-permission-bridge";
import { predictInlinePermission } from "./vlist-permission-prediction";
import type { VListItem } from "./vlist-pipeline";
import { createPointerDragTracker } from "./vlist-pointer-drag";
import { buildReflectionSourceIndex } from "./vlist-reflection-index";
import {
	resolveExactReloadDecision,
	resolveReloadDelayMs,
	shouldSurfaceDeferredReload,
} from "./vlist-reload-policy";
import {
	resolveReviewFeedbackActions,
	useReviewFeedbackActions,
} from "./vlist-review-feedback-actions";
import {
	buildRowCtxActions,
	buildRowToolActions,
	rowActionHandlerDependencies,
	type VListRowHandlers,
} from "./vlist-row-actions";
import {
	beginRowPayloadFrame,
	commitRowPayloadFrame,
	type RowPayloadReuseState,
	reuseRowPayload,
} from "./vlist-row-payload-reuse";
import {
	buildSelectionIndex,
	computeSelectedRange,
	entriesToBlockMeta,
	entriesToMessageIds,
	entriesToText,
	type SelectionIndex,
} from "./vlist-selection";
import {
	resolveSpecCarryoverActions,
	useSpecCarryoverActions,
} from "./vlist-spec-carryover-actions";
import { isSpecTaskLiveItem, resolveSpecTaskLiveGate } from "./vlist-spec-task-live";
import { nextStreamAnimEpoch } from "./vlist-stream-anim-extra";
import { resolveSwipeAnchorRowIndex } from "./vlist-swipe-anchor";
import { buildTailMeta, type TailMetaMessage } from "./vlist-tail-meta";
import { buildToolMetaIndex } from "./vlist-tool-meta";
import { hostsUnpredictableBlock } from "./vlist-unpredictable-blocks";
import {
	collectVListCompactMarkers,
	collectVListUserMarkers,
	resolveVListUserMarkerScrollTop,
	type VListCompactMarker,
	type VListUserMarker,
} from "./vlist-user-markers";
import { mergePinnedRowIndices, resolvePinnedRowIndices } from "./vlist-virtualization";
import { createVisualStateStore } from "./vlist-visual-state";

/**
 * Reuse the keyframe path's element list for the unified planner.
 *
 * Only the unit-box field name differs (`groupBox` → `unitBox`); `MorphElement` needs no
 * `unitAnchored` flag because it always prefers a unit box when one is present. Module-level
 * so the per-frame roll-forward does not re-allocate a closure on every commit.
 */
function toMorphElements(src: readonly LodElementSource[]): MorphElement[] {
	return src.map((el) => ({
		unitId: el.unitId,
		key: el.key,
		kind: el.kind,
		top: el.top,
		height: el.height,
		clip: el.clip ?? null,
		nested: el.nested,
		unitBox: el.groupBox ?? null,
	}));
}

import {
	bucketViewportHeight,
	isExternalGeometryChange,
	pushCommittedWidth,
	resolveWidthSettle,
	type WidthSettleTrigger,
} from "./vlist-width-settle";

// Editing chrome is lazy: a list that is only being read never pays for the
// editor's module graph (attachment thumbs, upload flow) or the modal.
const MessageEditorPanel = lazy(() =>
	import("../message/MessageEditorPanel").then((m) => ({ default: m.MessageEditorPanel })),
);
const OriginalContentModal = lazy(() =>
	import("../message/MessageOriginalContent").then((m) => ({ default: m.OriginalContentModal })),
);

const ITEM_OVERSCAN = 600;
/**
 * Horizontal (and canvas vertical) gutter of the content column.
 *
 * Read from the shared constant rather than declared locally: the loading
 * placeholders lay their column out with the same number, so a local literal here
 * would let the two drift and reintroduce a width jump when the real rows replace
 * the skeleton.
 */
const PAGE_PADDING = NARRATOR_COLUMN_GUTTER_PX;
/** Tight gap between items INSIDE one render unit (content blocks / in-run cards). */
const ITEM_GAP = 4;
/**
 * Wider gap between top-level render units (a message, a whole tool-run, a
 * divider). Matches the classic ChunkedMessageList's 12px inter-message spacing;
 * the exact layout keeps intra-unit items at ITEM_GAP so runs stay compact.
 */
const SEGMENT_GAP = 12;
/**
 * Breathing room (px) left above a user turn when jumping to it from the marker
 * index. Matches the canvas top padding, so the turn reads as the top of a page
 * rather than being flush against the viewport edge.
 */
const VLIST_USER_MARKER_JUMP_LEAD = PAGE_PADDING;
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
	onTailMetaChange?: (meta: MessageListTailMeta) => void;
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
	/** Narrator is bound to a chapter (git) → user-edit offers the rollback option. */
	hasChapter?: boolean;
	/**
	 * Deep-link / search target: jump to this message once and flash it.
	 *
	 * Only the target ID is needed. The chunked path additionally takes
	 * `highlightedId` + `onHighlightTarget` because it renders the flash from panel
	 * state; here the flash is a local, imperative DOM effect (see vlist-highlight),
	 * so no state crosses the boundary and no row re-renders for it.
	 */
	highlightMessageId?: string;
	/** A new request repeats the jump while retaining this list's loaded window. */
	highlightRequestId?: string;
	tailFooter?: ReactNode;
};

/**
 * The scrollTop that puts the very bottom of the content in view.
 *
 * Deliberately read from the DOM rather than derived from `exactLayout.totalHeight`:
 * the scrollable content is the canvas PLUS things the layout does not describe — the
 * tail footer, the older-history header, and any row whose real height was corrected
 * after paint (`heightOverrides`). Computing this from the layout would leave those
 * out and stop just short of the bottom.
 *
 * Correctness here does not depend on the DOM being in sync with the layout: this is
 * only ever used while pinned, where the goal is literally "the end of whatever is
 * currently rendered".
 */
function waitAnimationFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** `[start, end)` as an index list (mounted-window enumeration). */
function range(start: number, end: number): number[] {
	const out: number[] = [];
	for (let i = start; i < end; i++) out.push(i);
	return out;
}

/**
 * Resolve a row's reflection-takeover callback, or undefined when the row has no
 * RUNNING gate to take over. Kept as a pure helper so the render loop stays flat
 * and the "only running gates get the button" rule has one home.
 */
export function resolveReflectionTakeOver(
	item: VListItem,
	getHandler: (key: string, kind: string | undefined, requestId: string) => () => void,
): (() => void) | undefined {
	if (item.spec.kind !== "tool-call") return undefined;
	const reflection = (item.measured as MeasuredToolCall).reflection;
	if (!reflection?.hasTakeOver) return undefined;
	const requestId = reflection.requestId;
	if (!requestId) return undefined;
	return getHandler(item.spec.key, reflection.kind, requestId);
}

function setExternalRef<T>(ref: RefObject<T | null> | undefined, value: T | null): void {
	if (ref && "current" in ref) (ref as MutableRefObject<T | null>).current = value;
}

/**
 * Re-export of the jump module's id normalizer, so the DOM-locator path and the
 * seq-resolution path cannot disagree about what "msg-abc" means.
 */
const messageIdFromTarget = jumpTargetMessageId;

/**
 * True for a row belonging to the live streaming message.
 *
 * Its spec keys are derived from the synthetic message id, so the prefix is the
 * reliable test. Used only to scope the append animation to live content.
 */
function isStreamingRowKey(key: string): boolean {
	return key.startsWith(STREAMING_PLACEHOLDER_ID);
}

export const PretextExactMessageList = memo(
	forwardRef<MessageListHandle, PretextExactMessageListProps>(
		function PretextExactMessageList(props, ref) {
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
				hasChapter,
				highlightMessageId,
				highlightRequestId,
				tailFooter,
			} = props;
			const lod = useRenderLod() as RenderLod;
			// Advanced-animation preference (same key AppRootLayout writes to <html>);
			// gates the streaming tail's per-grapheme fade-in. Reactive so toggling the
			// setting takes effect without a reload.
			const [advancedAnim] = useLocalPref("narrafork_advanced_anim");
			/**
			 * Unified morph driver instead of the keyframe planners. Default OFF — see the key's
			 * note in `useLocalPref.ts` on why this needs a real browser comparison before it
			 * becomes the default.
			 */
			const [unifiedMorph] = useLocalPref("narrafork_unified_morph");
			// Reading-width preference: OFF (default) lets the content column fill the
			// viewport like the chunked path; ON caps it at a centered reading width.
			const [centeredColumn] = useLocalPref("narrafork_narrator_centered_column");
			// Alt+wheel LOD stepping. OFF makes alt+wheel behave like a plain wheel (no
			// preventDefault, so the list scrolls); the toolbar's detail-level menu then
			// becomes the entry point. Touch pinch is unaffected — it involves no Alt and
			// cannot be triggered accidentally while scrolling with a modifier held.
			const [lodAltGesture] = useLocalPref("narrafork_lod_alt_gesture");
			const viewportRef = useRef<HTMLDivElement | null>(null);
			/**
			 * The SAME node as `viewportRef.current`, held in state so effects that observe
			 * it can depend on it.
			 *
			 * A ref cannot be an effect dependency, and the resize effect below reads the
			 * node once on mount. `assignViewport` is rebuilt whenever the host's `scrollRef`
			 * prop changes identity (an inline arrow does that every render), and React
			 * answers a changed ref callback by detaching with `null` and re-attaching the
			 * node — WITHOUT re-running an effect that merely read the ref. The observer
			 * would then keep watching whatever node it captured first, so a later width
			 * change never arrives and the column freezes at its last committed width (the
			 * `!changed` early-out in resolveWidthSettle makes the pointer-release path a
			 * no-op too, since it re-reads the same stale node).
			 *
			 * Keeping the node in state makes "the node changed → rebuild the observer" a
			 * type-level fact rather than a property of how the host writes its props.
			 */
			const [viewportNode, setViewportNode] = useState<HTMLDivElement | null>(null);
			const contentNodeRef = useRef<HTMLDivElement | null>(null);
			const footerNodeRef = useRef<HTMLDivElement | null>(null);
			// One-flash-at-a-time jump highlight. A ref (not state) on purpose: the flash is
			// a decoration written straight to the revealed row's node, so it must not
			// invalidate a single row's memo or the measurement cache.
			const highlightRef = useRef(createHighlightController());
			/**
			 * Monotonic id of the newest jump, so a jump that pages through history across
			 * awaits can tell it has been superseded (another search hit clicked, the reader
			 * navigating away) and stop scrolling instead of fighting the new target.
			 */
			const jumpTokenRef = useRef(0);
			/**
			 * Compact-progress keys this panel has written into the module store.
			 * `compact_done` often carries no marker id (non-retry path), so cleanup
			 * cannot rely on the event payload alone — clear what we observed, plus
			 * every COW alias when the event does name replacement identities.
			 */
			const compactProgressKeysRef = useRef<Map<string, boolean>>(new Map());
			const pinnedToBottomRef = useRef(true);
			const suppressScrollStateRef = useRef(false);
			/**
			 * The scrollTop our own last programmatic write settled on, while its suppression
			 * window is open. A scroll event reporting a DIFFERENT value came from the reader,
			 * so it must be honoured rather than suppressed (see writeScrollTop).
			 */
			const suppressedScrollTopRef = useRef<number | null>(null);
			const [scrollTop, setScrollTop] = useState(0);
			// Always-current scrollTop (updated synchronously in onScroll) so anchor
			// capture / bottom detection read the live value without forcing a re-render
			// on every scroll pixel. React state (scrollTop) only advances when the
			// mounted window actually changes.
			const scrollTopRef = useRef(0);
			const scrollRafRef = useRef(0);
			// Where the in-flight LOD gesture is pointing (mouse / pinch center), captured
			// by the gesture handlers and read back by readCurrentView when the rebuild
			// captures its anchor. Expires (LOD_FOCUS_TTL_MS) so an unrelated later rebuild
			// keeps anchoring on the viewport top.
			const lodFocusRef = useRef<LodFocusPoint | null>(null);
			const [viewportHeight, setViewportHeight] = useState(0);
			const viewportHeightRef = useRef(0);
			viewportHeightRef.current = viewportHeight;
			// 0 = NOT YET MEASURED, and it is a sentinel rather than a plausible width on
			// purpose.
			//
			// It used to start at NARRATOR_CENTERED_COLUMN_MAX_WIDTH, which the loading
			// placeholder then PAINTED: every mount showed an 860px centered skeleton before
			// the first measurement landed, even for a reader who never enabled the centered
			// reading width. A sentinel cannot be mistaken for a real width, and nothing
			// paints from it — the placeholder lays itself out in CSS
			// (narratorColumnPlaceholderStyle) and the rows only render once
			// `hasRenderableLayout` is true, by which time the layout effect below has
			// committed the measured width.
			const [contentWidth, setContentWidth] = useState(0);
			// The width the LAYOUT was last built with. Distinct from `contentWidth` state
			// only for one frame (the setter is async), but the resize handler runs outside
			// render and must compare against the committed value synchronously — reading
			// state there would re-defer against a stale width on every observer callback.
			const committedContentWidthRef = useRef(0);

			const [pinnedToBottom, setPinnedToBottom] = useState(true);
			const [footerHeight, setFooterHeight] = useState(0);
			const footerHeightRef = useRef(0);
			footerHeightRef.current = footerHeight;
			pinnedToBottomRef.current = pinnedToBottom;

			const assignViewport = useCallback(
				(node: HTMLDivElement | null) => {
					viewportRef.current = node;
					// Mirror into state so the ResizeObserver effect re-runs when the node is
					// replaced (see viewportNode). Written unconditionally: React calls this
					// with null on detach and the real node on attach, and a state write with
					// the same value is a no-op React bails on.
					setViewportNode(node);
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

			/**
			 * Write scrollTop programmatically, suppressing the pinned-state update for the
			 * scroll event OUR OWN write produces.
			 *
			 * The suppression has to be value-based, not just time-based. A time-only window
			 * (a flag cleared on the next frame) also swallowed the reader's real scrolling:
			 * while output streamed, the pin effect wrote scrollTop every frame, so the window
			 * was effectively always open and a gentle upward drag was discarded — then the
			 * next frame's write pulled them back to the bottom. Recording the value we wrote
			 * lets `processScrollFrame` tell "this event is the echo of our write" from "the
			 * reader moved", and honour the latter immediately.
			 *
			 * `advanceState`: the full write also pushes the settled value into React state.
			 * The smooth-follow chase uses `false` for its per-frame writes so the shell
			 * re-renders only when the mounted WINDOW changes (the scroll event each write
			 * generates flows through `processScrollFrame`'s existing window gate) instead
			 * of once per animation frame; the chase's exact landing still uses the full
			 * write so state converges to the true position.
			 */
			const writeScrollTopCore = useCallback((nextTop: number, advanceState: boolean) => {
				const node = viewportRef.current;
				if (!node) return;
				const target = Math.max(0, nextTop);
				node.scrollTop = target;
				// Read back: the container clamps, so the settled value is what future scroll
				// events will report for this write.
				const settled = node.scrollTop;
				suppressScrollStateRef.current = true;
				suppressedScrollTopRef.current = settled;
				scrollTopRef.current = settled;
				if (advanceState) setScrollTop(settled);
				requestAnimationFrame(() => {
					suppressScrollStateRef.current = false;
					suppressedScrollTopRef.current = null;
				});
			}, []);
			const writeScrollTop = useCallback(
				(nextTop: number) => writeScrollTopCore(nextTop, true),
				[writeScrollTopCore],
			);
			const writeChaseScrollTop = useCallback(
				(nextTop: number) => writeScrollTopCore(nextTop, false),
				[writeScrollTopCore],
			);

			/**
			 * The smooth bottom-follow chase (vlist-smooth-follow). Held in a ref like the
			 * fold-motion and highlight controllers: it is a decoration-layer driver, and
			 * letting it into state would re-render the window for an animation.
			 *
			 * Reached through a getter so the instance is created lazily on first use —
			 * the deps close over `writeScrollTop`/`writeChaseScrollTop`, which are stable.
			 */
			const smoothFollowerRef = useRef<SmoothFollower | null>(null);
			const getSmoothFollower = useCallback((): SmoothFollower => {
				let follower = smoothFollowerRef.current;
				if (!follower) {
					follower = createSmoothFollower({
						readCurrent: () => viewportRef.current?.scrollTop ?? 0,
						readTarget: () => getScrollBottomTarget(viewportRef.current),
						getViewportHeight: () => viewportRef.current?.clientHeight ?? 0,
						writeInstant: (value) => writeScrollTop(value),
						writeChase: (value) => writeChaseScrollTop(value),
						canAnimate: shouldSmoothFollow,
					});
					smoothFollowerRef.current = follower;
				}
				return follower;
			}, [writeScrollTop, writeChaseScrollTop]);
			// A chase in flight never survives the shell going away.
			useEffect(() => () => smoothFollowerRef.current?.cancel(), []);

			const onScrollTopCorrection = useCallback(
				(nextTop: number, anchorKind: "bottom" | "item", smoothFollow?: boolean) => {
					// A bottom correction stamped smooth answers TAIL GROWTH (streaming row,
					// appended message, live patch at the tail): glide the pinned viewport to
					// the live bottom instead of snapping every committed row up a delta per
					// frame. The follower re-reads the target itself, and its gate falls back
					// to this exact instant write for loads/switches/shrinks/reduced motion.
					if (anchorKind === "bottom" && smoothFollow === true) {
						getSmoothFollower().ensure();
						return;
					}
					// Every other correction owns geometry (anchored rebuild, fold, LOD,
					// removal): it must land in the same commit, so a chase in flight dies here.
					getSmoothFollower().cancel();
					writeScrollTop(applyExactScrollCorrection(nextTop, anchorKind, footerHeightRef.current));
				},
				[getSmoothFollower, writeScrollTop],
			);
			const [interaction, setInteraction] = useState<VListInteractionState>(() =>
				createVListInteractionState(lod),
			);
			if (interaction.lod !== lod) {
				setInteraction(resetVListInteractionStateForLod(interaction, lod));
			}
			// The row currently in inline edit mode (at most one). The shell owns this so
			// the editor survives a re-render, and so the row can be pinned into the
			// mounted window while the reader scrolls away (an unmount would lose the
			// draft). `key` is the row's spec.key; the editor itself is the shared
			// MessageEditorPanel, mounted in place of the row body.
			const [editingRow, setEditingRow] = useState<{
				key: string;
				messageId: string;
				role: VListEditRole;
				initialText: string;
			} | null>(null);
			/** Message whose pre-edit original text the (single) shell modal reveals. */
			const [originalModalMessageId, setOriginalModalMessageId] = useState<string | null>(null);
			// Per-key real-pixel height overrides for rows whose content cannot be
			// predicted arithmetically (mermaid / katex / unknown images, the live
			// permission form, and the inline editor). A row reports its settled height via
			// `onUnknownHeight`; the exact geometry is then re-derived with these overrides
			// applied. Empty in the common case (zero overhead — the base arithmetic layout
			// is used as-is).
			const [heightOverrides, setHeightOverrides] = useState<ReadonlyMap<string, number>>(
				() => new Map(),
			);
			// Keys whose row currently hosts a dynamic body (assigned during render from
			// `dynamicRowKeys` below). Read at report time so a reporter that fires after
			// its row already reverted to the pure-arithmetic form cannot re-introduce a
			// stale override.
			const dynamicRowKeysRef = useRef<ReadonlySet<string>>(new Set<string>());
			// Sub-pixel jitter guard: ignore reports within 1px of the recorded value so a
			// ResizeObserver settling animation cannot loop the layout.
			const setHeightOverride = useCallback((key: string, height: number) => {
				if (!dynamicRowKeysRef.current.has(key)) return;
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
			const unknownHeightReporterCacheRef = useRef<Map<string, (height: number) => void>>(
				new Map(),
			);
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
			// Latest-value refs for the two callbacks that are handed to EVERY mounted row.
			// The ExactRow memo compares those callbacks identity-wise, so they must not be
			// rebuilt per render; they read the current interaction / narrator id from here
			// instead of listing them as dependencies.
			const activeInteractionRef = useRef(activeInteraction);
			activeInteractionRef.current = activeInteraction;
			const narratorIdRef = useRef(narratorId);
			narratorIdRef.current = narratorId;
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
			// Folded traces resolve their drill-down by ROW KEY; the adapter derives the
			// indices from the rows it emits (see AdapterContext.isRowExpanded).
			const resolveTraceRowExpanded = useCallback(
				(traceKey: string, rowKey: string) =>
					isTraceRowExpanded(activeInteraction, traceKey, rowKey),
				[activeInteraction],
			);
			const resolveShowOriginal = useCallback(
				(key: string) => activeInteraction.showOriginal.has(key),
				[activeInteraction],
			);
			const resolvePromptOpen = useCallback(
				(key: string) => isPromptOpenRow(activeInteraction, key),
				[activeInteraction],
			);
			const resolveFileChangesOpen = useCallback(
				(key: string) => isFileChangesOpenRow(activeInteraction, key),
				[activeInteraction],
			);
			const resolveExactToolColor = useCallback(
				(toolName: string, input?: unknown) => getCategoryColor(getCategory(toolName, input)),
				[],
			);
			// The AUTHORITATIVE header summary, identical to the chunked ToolCallCard's
			// (`getSummary(toolName, inputJson, _metadata)`). The pure adapter can only read
			// plain input fields, so every tool whose input was truncated server-side into
			// `{_truncated, preview, _hints}` produced an EMPTY header summary — the reason
			// Edit/Read rows showed just the tool name while their expanded detail (which
			// fetches the full payload) looked fine.
			const { t, i18n } = useTranslation("narrator");
			const resolveExactToolSummary = useCallback(
				(tc: unknown) => {
					const call = (tc ?? {}) as {
						toolName?: unknown;
						inputJson?: unknown;
						_metadata?: unknown;
						outputJson?: unknown;
						status?: string;
						_sendDeliveryTargets?: unknown;
						_sendDeliveryTargetCount?: number;
						_streamingOutput?: unknown;
					};
					if (typeof call.toolName !== "string") return "";
					const outputMetadata =
						call.outputJson &&
						typeof call.outputJson === "object" &&
						!Array.isArray(call.outputJson)
							? (call.outputJson as { _metadata?: unknown })._metadata
							: undefined;
					const sourceMetadata = outputMetadata ?? call._metadata;
					const metadata =
						sourceMetadata && typeof sourceMetadata === "object"
							? (sourceMetadata as Record<string, unknown>)
							: undefined;
					// Lift `_streamingOutput` the same way segment-adapter's resolveToolMetadata
					// does: ContextAsk's live char counter (and any other streaming body) lives
					// on the call record, not inside `_metadata`.
					const baseMetadata =
						metadata || call._streamingOutput != null
							? {
									...metadata,
									...(call._streamingOutput != null &&
									(metadata as Record<string, unknown> | undefined)?._streamingOutput === undefined
										? { _streamingOutput: call._streamingOutput }
										: {}),
								}
							: undefined;
					const summaryMetadata =
						call.toolName === "Send"
							? {
									...baseMetadata,
									status: call.status,
									_sendDeliveryTargets: call._sendDeliveryTargets,
									targetCount: call._sendDeliveryTargetCount ?? metadata?.targetCount,
								}
							: baseMetadata;
					return getSummary(call.toolName, call.inputJson, summaryMetadata, {
						communicationRunning: t("communicationRunning"),
						communicationNoRecipients: t("communicationNoRecipients"),
						communicationSuccess: t("communicationSuccess"),
						communicationReceived: t("communicationReceived"),
						communicationWaiting: t("communicationWaiting"),
						communicationReplyReceived: t("communicationReplyReceived"),
						communicationTimeout: t("communicationTimeout"),
						communicationCancelled: t("communicationCancelled"),
						communicationError: t("communicationError"),
						contextAskOutputChars: t("contextAskOutputChars", { count: "{count}" }),
						contextAskQuestions: t("contextAskQuestions", { count: "{count}" }),
						contextAskStatusSummary: t("contextAskStatusSummary"),
					});
				},
				[t],
			);
			// A subagent recent-call row's label detail. Same shared helper the chunked
			// `SubagentActivityRow` calls, so one child call is worded identically in both
			// render paths. It takes the projected `inputSummary` rather than a tool call
			// because that is all these rows ever carry.
			const resolveExactSubagentRecentSummary = useCallback(
				(toolName: string, inputSummary: unknown) =>
					subagentRecentCallSummary(toolName, normalizeSubagentToolInputSummary(inputSummary)),
				[],
			);
			const resolveRecentMessageIds = useCallback(
				(messages: readonly NarratorMsg[]) => recentRunSegmentMessageIds([...messages], 2),
				[],
			);
			const readCurrentView = useCallback(() => {
				const node = viewportRef.current;
				const scrollTop = node?.scrollTop ?? scrollTopRef.current;
				return {
					scrollTop,
					viewportHeight: node?.clientHeight ?? viewportHeightRef.current,
					// Mid-chase the viewport lags BEHIND the bottom by the glide residual, so
					// the raw geometric reading would report "not pinned" while the reader is
					// in fact following — every streaming commit would then capture an ITEM
					// anchor, and its correction would cancel the chase it should feed. An
					// active chase IS the bottom pin in motion.
					pinnedToBottom: node
						? getDistanceFromBottom(node) <= BOTTOM_DISTANCE_EPSILON ||
							smoothFollowerRef.current?.isActive() === true
						: pinnedToBottomRef.current,
					// Document offset of the point the LOD gesture is centered on, so the
					// rebuild anchors THAT content instead of the viewport top. Stale points
					// are dropped by resolveLodFocusOffset (see the gesture wiring below).
					focusOffset: resolveLodFocusOffset(lodFocusRef.current, Date.now(), scrollTop),
				};
			}, []);

			// Per-key measured lookup so stable toggle callbacks can read current state at
			// click time without depending on render-time closures. Populated below from
			// the current render items.
			const measuredByKeyRef = useRef<Map<string, VListItem["measured"]>>(new Map());
			const collapsesByLodByKeyRef = useRef<Map<string, boolean>>(new Map());
			/**
			 * Fold transition (see vlist-fold-animation.ts).
			 *
			 * The exact canvas has no flow layout to transition, so an expand/collapse is a
			 * FLIP: the pre-toggle geometry of the MOUNTED rows is captured here, in the click
			 * handler, and the layout effect below plays each row from where it used to be
			 * back to where the rebuild put it.
			 *
			 * A ref, not state, on purpose — the same reason `highlightRef` is one. This is a
			 * decoration written straight to the row nodes; putting it in state would
			 * invalidate every row's memo and (worse) make a purely visual concern part of the
			 * render that produces the geometry it animates.
			 */
			/**
			 * The ONE owner of every decorative animation on this canvas (see
			 * vlist-motion-scheduler.ts).
			 *
			 * Four things animate here — the fold's rows, its decorative tool-run frames, the
			 * drill-down header morph and the LOD-switch morph — and they are not independent
			 * events: `onToggleRow` produces a fold AND a drill flip in one click. While each
			 * had its own controller their lifetimes were independent, so a re-toggle could
			 * cancel one half and leave the other running to a different finish time. All four
			 * now push ops into the current frame and one flush effect starts them together.
			 */
			const motionRef = useRef(createMotionScheduler());
			/**
			 * UNIFIED MORPH (behind `narrafork_unified_morph`).
			 *
			 * The visual-state store is the single source of truth for where a morphing element
			 * VISUALLY is, which is what makes interruption structural: a new LOD step just points
			 * the store at a new target, and the element continues from wherever it currently is
			 * rather than from a committed snapshot it had already snapped back to.
			 *
			 * The store outlives individual commits on purpose — that persistence IS the mechanism.
			 * Reclamation is its own concern (`retain` + `sweep`), so a level switch churning
			 * elements cannot leak.
			 */
			const visualStateRef = useRef(createVisualStateStore());
			/** Identities the driver should write this frame; refreshed by the morph effect. */
			const morphIdentitiesRef = useRef<Set<string>>(new Set());
			/**
			 * Previous admitted frame for the UNIFIED path.
			 *
			 * Deliberately separate from `lodMorphPrevRef`: while the flag can be toggled at
			 * runtime, sharing one ref would let a frame recorded by one path be diffed by the
			 * other, whose admission rules differ — a silent mispairing rather than an error.
			 */
			const unifiedPrevRef = useRef<MorphElement[] | null>(null);
			/**
			 * `scrollTop` of the frame `unifiedPrevRef` was captured in.
			 *
			 * Element geometry is DOCUMENT px, so turning it into screen space needs the scroll
			 * origin of ITS OWN frame. A gesture-driven LOD switch rewrites `scrollTop` (the LOD
			 * anchor keeps the pointed-at content at a fixed screen position), so using the new
			 * frame's origin for the old frame's geometry charges the entire scroll correction to
			 * every element as travel it never made — the anchored content is displaced by the
			 * correction and animates back from it, which reads as the zoom being centred on the
			 * wrong place.
			 */
			const unifiedPrevScrollTopRef = useRef(0);
			/**
			 * THE ONE TIMING OWNER for unified morphs.
			 *
			 * Created lazily and kept for the component's life. A single loop is not an
			 * optimisation: `vlist-motion-scheduler.ts` records that fold and morph once held
			 * separate controllers and "a re-toggle could cancel one half and leave the other
			 * running to a different finish time", i.e. one visual event came apart. With one loop
			 * advancing every element by the same dt from the same store, that cannot happen —
			 * there is no per-element timeline to desynchronise.
			 */
			const morphDriverRef = useRef<MorphDriver | null>(null);
			if (!morphDriverRef.current) {
				morphDriverRef.current = createMorphDriver({
					store: visualStateRef.current,
					identities: () => morphIdentitiesRef.current,
					resolve: (unitId) => {
						const escaped = cssAttrEscape(unitId);
						// `data-nf-unit` first, then `data-nf-row-key` — the SAME fallback the keyframe
						// path uses. Without it every element paired on its `key` rather than a `unitId`
						// resolved to null and simply never animated, which is silent: the plan exists,
						// the state converges, and only the DOM write is missing.
						const root =
							viewportRef.current?.querySelector<HTMLElement>(`[data-nf-unit="${escaped}"]`) ??
							viewportRef.current?.querySelector<HTMLElement>(`[data-nf-row-key="${escaped}"]`);
						if (!root) return null;
						return {
							root,
							// Present only in the CARD form; absent for a row, in which case the driver
							// simply has no border or tail to fade.
							surface: root.querySelector<HTMLElement>("[data-nf-card-surface]"),
							tail: root.querySelector<HTMLElement>("[data-nf-card-tail]"),
						};
					},
				});
			}

			// The rAF loop stops on its own only when every element has SETTLED, so an unmount
			// mid-transition (switching narrator, closing the panel) is exactly the case it
			// cannot end by itself: the loop keeps resolving identities against a viewport that
			// no longer exists and writing nodes React has already reclaimed. Stopped explicitly
			// for the same reason `motionRef` is — a decorative animation always outlives the
			// click that started it.
			useEffect(() => {
				const driver = morphDriverRef.current;
				return () => driver?.stop();
			}, []);

			// Turning the unified path OFF mid-flight hands the same nodes to the keyframe
			// planner while this driver is still running: `morphIdentitiesRef` is only ever
			// written inside the `unifiedMorph` branch, so it keeps naming the identities of
			// the last switch and the loop keeps writing their `transform` — the exact
			// "two owners of one property" failure `vlist-motion-scheduler.ts` was built to
			// make impossible. Stopping also clears the inline styles the driver applied, so
			// the keyframe path starts from a clean element rather than one frozen mid-morph.
			//
			// Runs on the flip in BOTH directions: switching the flag on while the keyframe
			// path holds animations is handled by the scheduler's own scope cancellation, and
			// clearing the identity set here means the driver cannot resume against a set
			// recorded under the other path's admission rules.
			useEffect(() => {
				// Referenced only to declare the dependency: the flag is the TRIGGER, not an input
				// the body reads. Same idiom as the narrator-switch reset effect below, and it is
				// what stops the linter from "simplifying" the dep list to `[]` — which would make
				// this run on mount only and miss every mid-session flip, i.e. the entire case.
				void unifiedMorph;
				morphIdentitiesRef.current = new Set();
				morphDriverRef.current?.stop();
			}, [unifiedMorph]);

			const foldCaptureRef = useRef<{
				toggledKey: string;
				documentRevision: number;
				capturedAt: number;
				/**
				 * The effective level the capture was taken at.
				 *
				 * An LOD switch changes no document revision (it is a build option, like a fold),
				 * so without this a fold followed by a pinch inside the age bound would consume
				 * this capture on the commit where the level moved — putting the fold controller
				 * and the LOD morph controller on the same node's `transform` in one frame. See
				 * `isFoldCaptureUsable`.
				 */
				lod: number;
				scrollTop: number;
				geometry: Map<string, FoldRowGeometry>;
				/**
				 * Boxes of the decorative tool-run frames, captured in the same breath as the
				 * rows. A frame's border is only correct while it agrees with the cards inside
				 * it, so the two geometries must come from ONE snapshot — capturing them at
				 * different moments is how a border ends up animating from a box its contents
				 * never occupied.
				 */
				frames: Map<string, FoldRowGeometry>;
				/**
				 * LOCAL tops of the rows nested inside each mounted trace element.
				 *
				 * At L1/L2 a whole activity run is ONE list item, so drilling one of its tool
				 * rows open moves that row's siblings without moving any top-level item — the
				 * row map above cannot see them, and they used to teleport while everything
				 * below the run slid correctly. See `FoldNestedRowMotion`.
				 */
				nested: Map<string, { rows: Map<string, { top: number; height: number }> }>;
			} | null>(null);
			/**
			 * Reads the geometry of the CURRENTLY mounted rows.
			 *
			 * Assigned during render (below, once the layout and the window are known) rather
			 * than closed over here, because this callback is created before either exists. It
			 * is the same render-time ref assignment `resumeRecoveryRef` uses, and it keeps the
			 * capture reading the committed values instead of a stale copy.
			 */
			const readFoldGeometryRef = useRef<
				| (() => {
						geometry: Map<string, FoldRowGeometry>;
						frames: Map<string, FoldRowGeometry>;
						nested: Map<string, { rows: Map<string, { top: number; height: number }> }>;
						documentRevision: number;
						/**
						 * The COMMITTED manifest's level, travelling with the geometry it belongs to.
						 * Read through this one channel (rather than a second ref) so the capture's
						 * revision and level can never come from different frames.
						 */
						lod: number;
				  })
				| null
			>(null);
			/**
			 * The committed grouping frames, for the two consumers that run OUTSIDE render: the
			 * click-time capture and the play effect. Assigned during render further down, where
			 * the runs are actually computed.
			 */
			const toolRunFramesRef = useRef<ReturnType<typeof computeToolRunFrames>>([]);
			/**
			 * Drill-down header morph (see vlist-drill-morph.ts).
			 *
			 * DECLARATIVE and diff-driven, not a click capture: after every committed rebuild
			 * the layout effect below snapshots every visible trace row's drill state, diffs
			 * it against the previous frame, and morphs each row whose drill flag flipped.
			 * Any number of rows can flip in one frame (stacked activity), so the controller
			 * is keyed per-row — there is no single-slot capture to overwrite. Pure data in
			 * the ref, never React state, never the measure cache.
			 */
			/**
			 * Trace rows whose drill-down is CLOSING, as `traceKey` → set of row keys.
			 *
			 * A closing card must keep painting for the duration of the fold, or React unmounts
			 * it in the very frame the fold commits and it VANISHES instead of closing (see
			 * `closingRowKeys` in RenderToolRun). The shell marks the row when the toggle fires
			 * and clears it from `MotionOp.onDone`.
			 *
			 * State rather than a ref, because the RENDER layer consumes it — but scoped per
			 * trace and compared by identity below, so only the traces that actually have a
			 * closing row re-render.
			 */
			const [closingRows, setClosingRows] = useState<ReadonlyMap<string, ReadonlySet<string>>>(
				new Map(),
			);
			/**
			 * Read by `resolveRenderExtra`, which runs outside this component's render scope.
			 * Assigned every render so the extras always describe the current closing set.
			 */
			const closingRowsRef = useRef(closingRows);
			closingRowsRef.current = closingRows;
			const releaseClosingRow = useCallback((traceKey: string, rowKey: string) => {
				setClosingRows((prev) => {
					const rows = prev.get(traceKey);
					if (!rows?.has(rowKey)) return prev;
					const nextRows = new Set(rows);
					nextRows.delete(rowKey);
					const next = new Map(prev);
					// Drop the whole trace entry when its last closing row is released, so the
					// map returns to being empty and every row keeps its memo identity.
					if (nextRows.size === 0) next.delete(traceKey);
					else next.set(traceKey, nextRows);
					return next;
				});
			}, []);
			/**
			 * Rows the LIFECYCLE channel marked closing on this commit, as `traceKey` → row
			 * keys. The lifecycle effect either plans a resize whose `onDone` releases them, or
			 * releases them itself — a retained card must never outlive its transition.
			 */
			const pendingLifecycleClosingRef = useRef<{
				marks: Map<string, Set<string>>;
				/**
				 * The `renderItems` the marks were taken against. The marking effect runs on the
				 * commit the request list changed, BEFORE the document rebuilds (that happens in
				 * usePretextDocument's passive effect). The lifecycle effect on that same commit
				 * sees no shape change yet, so it must not release the marks until it runs
				 * against a DIFFERENT item array — otherwise the release cancels the mark in one
				 * batched update and the card unmounts with the rebuild instead of closing.
				 */
				items: readonly unknown[];
			} | null>(null);
			const drillMorphPrevRef = useRef<Map<string, DrillRowSnapshot>>(new Map());
			/**
			 * The document revision the last snapshot was taken under. A morph only plays when
			 * two consecutive snapshots share a revision — a revision move means a live patch
			 * / page / reload rebuilt the window, and diffing across it would animate a change
			 * the reader did not make. The snapshot still rolls forward (see the effect).
			 */
			const drillMorphRevisionRef = useRef<number>(-1);
			/**
			 * LOD-switch morph (see vlist-lod-morph.ts). Diff-driven off the committed layout,
			 * keyed by `unitId` — the one identity that survives a level switch. The snapshot
			 * rolls forward every commit so the next diff has a clean baseline; a morph only
			 * plays when the document revision is unchanged AND the lod moved (pure re-theme).
			 */
			const lodMorphPrevRef = useRef<Map<string, LodElementSnapshot> | null>(null);
			const lodMorphLodRef = useRef<number>(-1);
			const lodMorphDocRevRef = useRef<number>(-1);
			/**
			 * LIFECYCLE transition (see vlist-lifecycle-motion.ts): the previous committed
			 * frame of the mounted window, and the frame context it was taken under. Pure
			 * data in refs, like the drill/LOD baselines — never React state.
			 */
			const lifecyclePrevRef = useRef<LifecycleSnapshot | null>(null);
			const lifecyclePrevContextRef = useRef<{
				lod: number;
				widthBucket: string;
				scrollTop: number;
			} | null>(null);
			/**
			 * Set by the fold play effect when it consumed the reader's capture on THIS
			 * commit, and cleared by the lifecycle effect. A reader's fold and a lifecycle
			 * flip landing on the same commit would otherwise both animate the same node.
			 */
			const foldPlayedThisCommitRef = useRef(false);
			/**
			 * Snapshot the mounted rows' current geometry so the commit this click produces
			 * can be animated from it.
			 *
			 * Reads the LAYOUT (not the DOM): the offsets are already known to the pixel, and
			 * calling getBoundingClientRect on every mounted row inside a click handler would
			 * force a synchronous layout for information we already have.
			 */
			const captureFoldBefore = useCallback((key: string) => {
				// A fold owns its own FLIP geometry, planned (while pinned) against the
				// PREDICTED bottom scrollTop — a chase still gliding towards it would
				// move the rows under the running animation. Land the chase first.
				smoothFollowerRef.current?.snapToTarget();
				// Reduced motion: no capture, so the layout effect below finds nothing to play
				// and the fold applies instantly (the committed geometry).
				foldCaptureRef.current = null;
				if (prefersReducedMotion()) return;
				const read = readFoldGeometryRef.current?.();
				if (!read || read.geometry.size === 0) {
					foldCaptureRef.current = null;
					return;
				}
				foldCaptureRef.current = {
					toggledKey: key,
					documentRevision: read.documentRevision,
					capturedAt: Date.now(),
					lod: read.lod,
					scrollTop: scrollTopRef.current,
					geometry: read.geometry,
					frames: read.frames,
					nested: read.nested,
				};
			}, []);
			// Stable RowToggles per key (memoized) so unchanged rows keep referential props
			// and skip React.memo re-render during scroll.
			const togglesCacheRef = useRef<Map<string, RowToggles>>(new Map());
			const getRowToggles = useCallback(
				(key: string): RowToggles => {
					const cached = togglesCacheRef.current.get(key);
					if (cached) return cached;
					const toggles: RowToggles = {
						onToggle: () => {
							const current = resolveRowOpenState(
								measuredByKeyRef.current.get(key),
								activeInteractionRef.current,
								key,
							);
							captureFoldBefore(key);
							// A per-key OVERRIDE of the level's default fold — NOT an LOD step, and the
							// distinction is load-bearing.
							//
							// Three controllers animate this canvas and two of them write `transform`
							// on the SAME element: the fold resolves a row through `data-nf-row-key`
							// and the LOD morph through `data-nf-unit` OR `data-nf-row-key`, which ride
							// on one node. They have independent cancel boundaries, so if both ever
							// planned in one commit the two animations would fight over that property.
							//
							// Two things keep them apart, and both are needed:
							//
							//  1. THIS rebuild cannot move the level. `toggleVListLodUserOverride`
							//     adds/removes one key in `lodUserOverrides`, which reaches the build as
							//     a per-card opt (`isLodUserOverride`), while `manifest.lod` comes from
							//     `useRenderLod()` and only a zoom step / pinch changes that. So the
							//     LOD morph's gate (revision unchanged AND lod moved) rejects it: the
							//     fold plays, the morph returns early.
							//  2. A LATER rebuild cannot revive this fold's capture. A fold followed by
							//     a pinch inside the capture's age bound is the one commit where both
							//     could plan, because an LOD switch advances no document revision
							//     either — so the capture also records its level and
							//     `isFoldCaptureUsable` rejects it once the level moves.
							//
							// Which means this branch must NOT be turned into a real level step (nor
							// gain one alongside the override) without giving the two controllers a
							// shared cancel boundary. Pinned by vlist-fold-wiring.test.ts.
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
							captureFoldBefore(key);
							setInteraction((prev) =>
								setVListExpanded(prev, key, !(measured?.header?.opened ?? false)),
							);
						},
						onToggleEarlier: () => {
							captureFoldBefore(key);
							setInteraction((prev) => toggleVListShowEarlier(prev, key));
						},
						onToggleRow: (rowIndex: number, rowKey?: string) => {
							captureFoldBefore(key);
							// CLOSING a drilled card: keep it painted for the transition, or React
							// unmounts it in the frame the fold commits and it vanishes instead of
							// closing. Marked here (while the card is still the committed state) and
							// released from the resize op's `onDone`.
							//
							// Only when this row currently HAS a card: opening one, or toggling a
							// reasoning body, has nothing to retain.
							if (rowKey !== undefined) {
								const measured = measuredByKeyRef.current.get(key) as
									| { rows?: readonly { key: string; cardMeasured?: unknown }[] }
									| undefined;
								const row = measured?.rows?.find((r) => r.key === rowKey);
								// Without a capture (reduced motion or unavailable geometry), no
								// resize op will run and no onDone will release the card. Commit
								// the summary directly instead of retaining it in the short row.
								if (row?.cardMeasured != null && foldCaptureRef.current !== null) {
									setClosingRows((prev) => {
										const next = new Map(prev);
										const rows = new Set(prev.get(key) ?? []);
										rows.add(rowKey);
										next.set(key, rows);
										return next;
									});
								}
							}
							// The caller decides the channel by whether it passes a key, and the
							// TRACE_KINDS binding picks that per element kind (traceRowFoldChannel).
							// A key means the element folds a LIVE row list, where a reasoning step
							// arriving above the reader's row makes the index they clicked address a
							// different tool one frame later (see expandedTraceRows).
							//
							// No morph capture here: the drill-down header morph is diff-driven off
							// the committed rebuild (see the drill-morph layout effect), so this
							// handler only flips the interaction state — nothing to record.
							if (rowKey !== undefined) {
								setInteraction((prev) => toggleVListTraceRow(prev, key, rowKey));
								return;
							}
							setInteraction((prev) => toggleVListRow(prev, key, rowIndex));
						},
						onToggleTranslation: () => {
							// A fold, despite the name. The two texts wrap to different line counts at
							// the same width (`measureReasoning` measures `displayText`, and
							// `showOriginal` is part of the measure cache key), so flipping to the
							// original resizes the row and moves everything below it. Measured against
							// `measureReasoning` at 860px wide: an expanded run is 70px showing its
							// translation and 90px showing its original.
							//
							// This handler was the one height-affecting toggle with no capture, so the
							// flip teleported the rest of the document while every other toggle eased.
							// Growing to the original also plays the reveal, which reads correctly here:
							// the box holds its final height while the taller text unrolls into it.
							captureFoldBefore(key);
							setInteraction((prev) => toggleVListShowOriginal(prev, key));
						},
						onTogglePrompt: () => {
							captureFoldBefore(key);
							setInteraction((prev) => toggleVListPromptOpen(prev, key));
						},
						onToggleFileChanges: () => {
							captureFoldBefore(key);
							setInteraction((prev) => toggleVListFileChangesOpen(prev, key));
						},
					};
					togglesCacheRef.current.set(key, toggles);
					return toggles;
				},
				[captureFoldBefore],
			);
			// Prompt fold for a card that is NOT its own list element: a drilled-in
			// subagent card inside a trace row. The open state lives under the CARD's key
			// (the same `tool-<toolUseId>` the standalone card uses, so the fold survives
			// an LOD change), while the geometry capture belongs to the trace element that
			// actually resizes.
			const togglePromptForKey = useCallback(
				(elementKey: string, cardKey: string) => {
					captureFoldBefore(elementKey);
					setInteraction((prev) => toggleVListPromptOpen(prev, cardKey));
				},
				[captureFoldBefore],
			);

			// Subagent-recovery card submit. The card's row set tracks DESELECTED indices
			// (it starts fully selected), so the payload is derived by subtracting them
			// from the measured row list.
			//
			// Same referential-stability requirement as `terminateRunningTool`: this is
			// handed to EVERY mounted row, and the ExactRow memo compares it identity-wise.
			// `useMutation`'s result object and `activeInteraction` both change identity on
			// render, so they are read through refs at call time instead of captured as
			// dependencies — otherwise a one-row window shift re-renders the whole window.
			const resumeRecovery = useResumeRecoverySubagents();
			const resumeRecoveryRef = useRef(resumeRecovery);
			resumeRecoveryRef.current = resumeRecovery;
			const handleResumeSubagentRecovery = useCallback(
				(messageId: string, specKey: string, mode: "notify" | "await") => {
					const measured = measuredByKeyRef.current.get(specKey) as
						| { blocks?: Array<{ data?: { subagents?: Array<{ id?: string }> } }> }
						| undefined;
					const rows = measured?.blocks?.[0]?.data?.subagents ?? [];
					const deselected = new Set(activeInteractionRef.current.expandedRows.get(specKey) ?? []);
					const subagentIds = rows
						.map((row, index) => (deselected.has(index) ? null : row?.id))
						.filter((id): id is string => typeof id === "string" && id.length > 0);
					if (subagentIds.length === 0) return;
					const id = narratorIdRef.current;
					if (!id) return;
					resumeRecoveryRef.current.mutate({ narratorId: id, messageId, subagentIds, mode });
				},
				[],
			);

			// Dynamic Spec notice cards: "View tasks" opens the Spec task board. The panel
			// owns that panel, and the chunked card reaches it by bubbling a DOM
			// CustomEvent up to the NarratorPanel scroll viewport — which IS this shell's
			// scroll node, so dispatching from it hits the same listener.
			const openSpecTasks = useCallback(() => {
				viewportRef.current?.dispatchEvent(new CustomEvent("spec-open-tasks", { bubbles: true }));
			}, []);
			const resolveSpecActions = useSpecCarryoverActions(narratorId, openSpecTasks);

			// Review feedback cards: the button hands the conclusion to this narrator as a user
			// turn. A concluded review does not wake an idle narrator by design, so this is how
			// the findings get acted on.
			const resolveReviewActions = useReviewFeedbackActions(narratorId);

			// Error notice cards: "mark as retryable" opens the shared rule dialog, the
			// close button deletes the notice. The dialog is one shell-level instance
			// (rows are zero-DOM copies and cannot own a modal); rows only carry the bound
			// callbacks.
			const errorNotice = useVListErrorNoticeActions(narratorId);

			// Interrupt task-guard reminder cards: the heading-row close button deletes
			// the notice. No dialog, so the resolver alone is all the shell needs.
			const resolveGuardActions = useInterruptGuardActions(narratorId);

			// The manual "load older" header lives in the exact canvas top padding, so its
			// height is part of totalHeight and needs no scroll-coordinate offset. It is
			// tracked as state (synced from hasPrev below) so it can be fed into the layout
			// input without a circular dependency on the hook's output. When it toggles
			// (older history exhausted), the anchor-preserving rebuild keeps the visible
			// content fixed while the reserved space changes off-screen above it.
			const [olderHeaderHeight, setOlderHeaderHeight] = useState(0);
			const { t: tCommon } = useTranslation("common");
			// Every localized string the vlist paints comes from one place (the vlist
			// layers themselves import no i18n — see CONTRACT.md §0). `adapterLabels` feeds
			// the pure adapter's measured card / trace text; `renderLabels` supplies each
			// RenderXxx's chrome (buttons, badges, section titles, placeholders).
			const { adapterLabels: vlistLabels, renderLabels } = useVListLabels();
			// Tooltip / aria label for a clickable text-file attachment. Height-neutral
			// chrome, so it does NOT participate in the measurement cache key.
			const openAttachmentLabel = t("contextMenu_openFilePanel");
			// "…was truncated" note inside an injection bubble. Height-neutral: the measure
			// pass reserves a fixed line whenever `hasNote` holds, whatever the wording.
			const injectionNoteLabel = t("sidecar.body.tasksDoneTruncated");
			// Same shape for a review card whose body hit the markdown parse ceiling: the note
			// sits in the card's already-reserved header row, so the wording is height-neutral.
			const reviewTruncatedLabel = t("reviewFeedbackTruncated");
			// Tooltip / aria label per navigable target kind. Height-neutral chrome, and
			// memoized because it feeds the row memo's identity comparison.
			const injectionTargetLabels = useMemo(
				() => ({
					narrator: t("openFullSubagentSession"),
					knowledge: t("injectionTarget.openKnowledge"),
					spec: t("injectionTarget.openSpecFile"),
					chapter: t("injectionTarget.openChapter"),
				}),
				[t],
			);
			// Who is reading. Decides whether a user bubble is drawn as the reader's own turn
			// or a teammate's — this is a shared deployment, so `role: "user"` alone does not
			// mean "you". Height-neutral, so it stays out of the measurement cache key.
			const { data: currentUser } = useCurrentUser();
			const currentUserId = currentUser?.id ?? null;
			// Language identity for the measurement cache: localized text is baked into
			// measured content, so a switch must invalidate cached heights (see
			// buildPretextDocumentLayout's labelsRevision).
			const labelsRevision = i18n.language;
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
			// ⚠️ The pinned latest-tasks card is NOT resolved here.
			//
			// The shell tracks its own `latestSpecTasksToolUseId` (the `LatestTodosToolUseIdCtx`
			// value the chunked path's task-board spinner keys on), and passing it down as a
			// build option was tempting. It would be wrong: the shell's value is derived from a
			// DIFFERENT message list (the tail-meta scan) than the one the layout builds over
			// (persisted window + live streaming row), so the two can disagree — and a value
			// deliberately kept out of the build deps could never correct itself once stale.
			// `buildPretextDocumentLayout` therefore derives the id itself, from exactly the
			// messages it is laying out, using the same rule (`vlist-spec-tasks-pin.ts`).
			// Plan bodies carried by pending ExitPlanMode permissions. A file-based plan is
			// resolved server-side into the permission payload and never enters the streamed
			// tool_use input, so the card's own inputJson stays empty until a reload. The Map
			// (and therefore the resolver below) gets a new identity when the plan text
			// arrives, which is what triggers the document rebuild that makes it visible.
			const pendingPlansByToolUseId = useMemo(() => {
				const map = new Map<string, string>();
				for (const perm of permCb?.pendingPermissions ?? []) {
					if (perm.toolName !== "ExitPlanMode" || !perm.toolUseId) continue;
					const plan = perm.inputJson?.plan;
					if (typeof plan === "string" && plan.trim()) map.set(perm.toolUseId, plan);
				}
				return map;
			}, [permCb?.pendingPermissions]);
			const resolvePendingPlan = useCallback(
				(toolUseId: string | undefined) =>
					toolUseId ? pendingPlansByToolUseId.get(toolUseId) : undefined,
				[pendingPlansByToolUseId],
			);
			// A live permission's `suggestions` win over the tool call's persisted
			// `permissionSuggestions` when the adapter resolves a reflection gate (same
			// precedence as the chunked getToolCallReflection). Only the in-flight window
			// needs this — a resolved gate's state is already in the loaded message tree.
			const pendingSuggestionsByToolUseId = useMemo(() => {
				const map = new Map<string, unknown[]>();
				for (const perm of permCb?.pendingPermissions ?? []) {
					if (!perm.toolUseId || !Array.isArray(perm.suggestions)) continue;
					map.set(perm.toolUseId, perm.suggestions);
				}
				return map;
			}, [permCb?.pendingPermissions]);
			const resolvePendingPermissionSuggestions = useCallback(
				(toolUseId: string | undefined) =>
					toolUseId ? pendingSuggestionsByToolUseId.get(toolUseId) : undefined,
				[pendingSuggestionsByToolUseId],
			);
			// The live InlinePermission form's box, reserved ARITHMETICALLY on the request's
			// first frame (see vlist-permission-prediction). Predicted against the standalone
			// card's inner width: a drilled-in card is measured standalone too, so one width
			// serves both hosts.
			const permissionCapability = useNarratorPermissionsCapability();
			const canDecidePermissions =
				permissionCapability.supported && permissionCapability.approveDeny;
			const permissionPredictionsByToolUseId = useMemo(() => {
				const map = new Map<string, InlinePermissionData>();
				const innerWidth = toolCardInnerWidth(contentWidth, false);
				for (const perm of permCb?.pendingPermissions ?? []) {
					if (!perm.toolUseId) continue;
					const prediction = predictInlinePermission(perm, {
						innerWidth,
						canDecide: canDecidePermissions,
					});
					if (prediction) map.set(perm.toolUseId, prediction);
				}
				return map;
			}, [permCb?.pendingPermissions, contentWidth, canDecidePermissions]);
			const resolvePermissionFormPrediction = useCallback(
				(toolUseId: string | undefined) =>
					toolUseId ? permissionPredictionsByToolUseId.get(toolUseId) : undefined,
				[permissionPredictionsByToolUseId],
			);
			// The form's PAINTED height, reported by the card once it has mounted. Keyed by
			// the request id as well as the tool-use id: a retried request is a new form, and
			// its first frame must start from the prediction rather than the previous form's
			// reading. Entries for requests that are gone are dropped with the list.
			const [permissionFormHeights, setPermissionFormHeights] = useState<
				ReadonlyMap<string, { requestId: string; height: number }>
			>(() => new Map());
			const pendingRequestIdByToolUseId = useMemo(() => {
				const map = new Map<string, string>();
				for (const perm of permCb?.pendingPermissions ?? []) {
					if (perm.toolUseId) map.set(perm.toolUseId, perm.id);
				}
				return map;
			}, [permCb?.pendingPermissions]);
			// Read by the (stable) reporter, which must not change identity per request.
			const pendingRequestIdByToolUseIdRef = useRef(pendingRequestIdByToolUseId);
			pendingRequestIdByToolUseIdRef.current = pendingRequestIdByToolUseId;
			const reportPermissionFormHeight = useCallback((toolUseId: string, height: number) => {
				const requestId = pendingRequestIdByToolUseIdRef.current.get(toolUseId);
				if (!requestId || !Number.isFinite(height) || height <= 0) return;
				const rounded = Math.round(height);
				setPermissionFormHeights((prev) => {
					const current = prev.get(toolUseId);
					if (current && current.requestId === requestId && Math.abs(current.height - rounded) <= 1)
						return prev;
					const next = new Map(prev);
					next.set(toolUseId, { requestId, height: rounded });
					return next;
				});
			}, []);
			const resolvePermissionFormHeight = useCallback(
				(toolUseId: string | undefined) => {
					if (!toolUseId) return undefined;
					const entry = permissionFormHeights.get(toolUseId);
					if (!entry) return undefined;
					// A reading from a previous request for the same call is not this form's.
					return pendingRequestIdByToolUseId.get(toolUseId) === entry.requestId
						? entry.height
						: undefined;
				},
				[permissionFormHeights, pendingRequestIdByToolUseId],
			);
			// Drop readings whose request is gone, so the map cannot grow for the session.
			useEffect(() => {
				setPermissionFormHeights((prev) => {
					if (prev.size === 0) return prev;
					let changed = false;
					const next = new Map(prev);
					for (const [toolUseId, entry] of prev) {
						if (pendingRequestIdByToolUseId.get(toolUseId) !== entry.requestId) {
							next.delete(toolUseId);
							changed = true;
						}
					}
					return changed ? next : prev;
				});
			}, [pendingRequestIdByToolUseId]);
			// Truncated payloads on expanded cards, fetched in full on demand (the chunked
			// path's LazyDetailRenderer equivalent). The id list is published by an effect
			// AFTER the build below, so this render uses the previous list — one build
			// behind is exactly right: the row must already be expanded to need its body.
			const [truncatedToolCalls, setTruncatedToolCalls] = useState<{
				narratorId: string;
				requests: readonly VListToolDetailRequest[];
			}>({ narratorId, requests: [] });
			const { resolveFullToolInput, resolveFullToolOutput } = useVListToolDetails(
				narratorId,
				truncatedToolCalls.narratorId === narratorId ? truncatedToolCalls.requests : [],
			);
			// Header terminate control: interrupting the narrator is what actually stops a
			// running shell / MCP tool (the chunked control does the same).
			//
			// `useMutation` returns a FRESH result object on every render, so depending on it
			// directly would rebuild this callback each render and break every mounted row's
			// ExactRow memo (which compares `onTerminate` identity-wise) — a one-row window
			// shift would re-render the whole window. Read the mutation through a ref so the
			// callback identity is constant for the life of the list.
			const interruptMutation = useInterruptNarrator();
			const interruptMutationRef = useRef(interruptMutation);
			interruptMutationRef.current = interruptMutation;
			const terminateRunningTool = useCallback(() => {
				const mutation = interruptMutationRef.current;
				const id = narratorIdRef.current;
				if (id && !mutation.isPending) mutation.mutate({ id });
			}, []);
			// Manual takeover of a running reflection gate. The measured notice supplies the
			// kind + requestId; only the API call lives out here (parity with the chunked
			// ReflectionNotice, which drives api.stopXReflection itself).
			const takeOverReflection = useCallback((kind: string | undefined, requestId: string) => {
				if (!requestId) return;
				if (kind === "danger_reflection") void narratorsApi.stopDangerReflection(requestId);
				else if (kind === "plan_reflection") void narratorsApi.stopPlanReflection(requestId);
				else if (kind === "task_reflection") void narratorsApi.stopTaskReflection(requestId);
				else if (kind === "question_reflection")
					void narratorsApi.stopQuestionReflection(requestId);
			}, []);
			// Header timeout editor: the chunked TimeoutEditorPopover sends this exact WS
			// message (ToolCallCard.tsx:1468), so a running bash can have its deadline
			// extended from either render path. Cached per toolUseId to keep the row's props
			// referentially stable (the ExactRow memo compares them identity-wise).
			const updateTimeoutCacheRef = useRef<{
				narratorId: string | null;
				byToolUseId: Map<string, (timeoutMs: number) => void>;
			}>({ narratorId: null, byToolUseId: new Map() });
			const getUpdateTimeout = useCallback(
				(toolUseId: string): ((timeoutMs: number) => void) => {
					const cache = updateTimeoutCacheRef.current;
					// The senders close over narratorId, so a narrator switch retires all of
					// them (and keeps the map from growing across sessions).
					if (cache.narratorId !== narratorId) {
						cache.narratorId = narratorId;
						cache.byToolUseId.clear();
					}
					const cached = cache.byToolUseId.get(toolUseId);
					if (cached) return cached;
					const handler = (timeoutMs: number) => {
						if (!narratorId) return;
						narratorWSManager.send({ type: "update_timeout", narratorId, toolUseId, timeoutMs });
					};
					cache.byToolUseId.set(toolUseId, handler);
					return handler;
				},
				[narratorId],
			);
			// Stable per-key takeover callbacks so a row keeps referential props and the
			// ExactRow memo can keep skipping during scroll.
			const reflectionTakeOverCacheRef = useRef<Map<string, () => void>>(new Map());
			// Latest-value ref for the in-place append. The WS handlers below are registered
			// once, so they must not close over one render's callback. Declared before
			// usePretextDocument because the assignment reads that hook's result.
			const upsertMessageRef = useRef<(message: TreeMessage) => boolean>(() => false);
			// Same latest-value contract as upsertMessageRef, for the mid-window structural
			// insert (a compact marker the append path declines) and the two in-place
			// history mutations (delete / trailing-block truncation).
			const insertMessageRef = useRef<(message: TreeMessage) => boolean>(() => false);
			const removeMessagesRef = useRef<(deletedIds: readonly string[]) => boolean>(() => false);
			const replaceMessageRef = useRef<
				(
					message: TreeMessage,
					aliases?: {
						oldMessageId?: string;
						replacedMessageId?: string;
						messageId?: string;
						replacementMessageId?: string;
					},
				) => boolean
			>(() => false);
			// And for the generic live-patch channel, which applies a compact marker's
			// status flip (compacting → compacted/failed) in place: the marker row's status
			// is folded into the measure cache key, so the patched card re-measures and
			// every other row is served from cache.
			const applyLivePatchRef = useRef<UsePretextDocumentResult["applyLivePatch"]>(() => false);
			const getReflectionTakeOver = useCallback(
				(key: string, kind: string | undefined, requestId: string): (() => void) => {
					const cacheKey = `${key}|${kind ?? ""}|${requestId}`;
					const cached = reflectionTakeOverCacheRef.current.get(cacheKey);
					if (cached) return cached;
					const handler = () => takeOverReflection(kind, requestId);
					reflectionTakeOverCacheRef.current.set(cacheKey, handler);
					return handler;
				},
				[takeOverReflection],
			);
			// Read before the document hook: `showTokenUsage` is a build input (the adapter
			// emits the usage rows only when it is on), and the older-history controls below
			// consume the same query.
			const {
				data: userPrefs,
				isLoading: userPrefsLoading,
				isFetched: userPrefsFetched,
			} = useUserPreferences();
			const showTokenUsage = userPrefs?.showTokenUsage ?? false;
			// The chunked path splits the trailing usage summary with CSS breakpoints, which
			// a zero-DOM height model cannot see — so the breakpoint is resolved here and
			// becomes an explicit measure input (one line vs two).
			const isMobileViewport = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
			// Height as the LAYOUT sees it (see the buildOptions comment below). Derived here
			// so the value handed to the document hook only changes at bucket boundaries.
			const layoutViewportHeight = bucketViewportHeight(viewportHeight);
			// FOLD-ORDER MARKER — must stay ABOVE the fold-play layout effect.
			//
			// This hook owns the anchored rebuild's scroll correction, and it applies it in a
			// LAYOUT effect. The fold play below reads the resulting scrollTop as its
			// `afterScrollTop`, so it is only correct while that correction has already run —
			// which within one component is decided purely by DECLARATION ORDER. Moving this
			// call below the fold effect would silently plan every fold from an uncorrected
			// scroll position (rows sliding by the anchor's own Δ), with nothing throwing.
			// vlist-fold-wiring.test.ts asserts this marker precedes the play effect.
			const pretextDocument = usePretextDocument(narratorId, {
				lod,
				labels: vlistLabels,
				labelsRevision,
				widthBucket: String(Math.round(contentWidth)),
				contentWidth,
				// BUCKETED on purpose. Height reaches the build for exactly one reason (the
				// plan-detail cap), but at pixel resolution it made every frame of a sash drag
				// re-measure the whole document — bypassing the width gate entirely, which is
				// why continuous dragging still janked. The exact height is still used for the
				// mounted window, scroll anchoring and bottom-pinning; those read
				// `viewportHeight` directly and never go through a rebuild.
				viewportHeight: layoutViewportHeight,
				scrollTop,
				pinnedToBottom,
				getCurrentView: readCurrentView,
				gap: ITEM_GAP,
				segmentGap: SEGMENT_GAP,
				topPadding: PAGE_PADDING + olderHeaderHeight,
				bottomPadding: PAGE_PADDING,
				isExpanded: resolveExpanded,
				isLodUserOverride: resolveLodUserOverride,
				showEarlier: resolveShowEarlier,
				expandedRows: resolveExpandedRows,
				isRowExpanded: resolveTraceRowExpanded,
				showOriginal: resolveShowOriginal,
				isPromptOpen: resolvePromptOpen,
				isFileChangesOpen: resolveFileChangesOpen,
				resolveToolCategory: getCategory,
				resolveToolColor: resolveExactToolColor,
				resolveToolSummary: resolveExactToolSummary,
				// The provider fix is a labelled button on its own row, so whether an error
				// card offers it changes that card's HEIGHT and must be resolved during
				// adaptation rather than painted in afterwards.
				canOfferProviderFix: errorNotice.canOfferProviderFix,
				canOfferModelTest: errorNotice.canOfferModelTest,
				resolveSubagentRecentSummary: resolveExactSubagentRecentSummary,
				resolveRecentMessageIds,
				resolveHasPendingPermission,
				resolvePermissionFormPrediction,
				resolvePermissionFormHeight,
				resolvePendingPlan,
				resolvePendingPermissionSuggestions,
				resolveFullToolInput,
				resolveFullToolOutput,
				showTokenUsage,
				compactUsageLines: isMobileViewport,
				formatUsageNumber: formatLocaleNumber,
				onScrollTopCorrection,
				isSubagent,
			});
			upsertMessageRef.current = pretextDocument.upsertMessage;
			insertMessageRef.current = pretextDocument.insertMessage;
			removeMessagesRef.current = pretextDocument.removeMessages;
			replaceMessageRef.current = pretextDocument.replaceMessage;
			applyLivePatchRef.current = pretextDocument.applyLivePatch;
			// Read by the jump loop, which spans awaits and must see the CURRENT document
			// (its `readWindow` reads the coordinator snapshot synchronously, so it is also
			// correct between a commit and the React re-render it triggers).
			const pretextDocumentRef = useRef(pretextDocument);
			pretextDocumentRef.current = pretextDocument;

			// --- Reverse infinite scroll (load older) ---
			const autoLoadEnabled = resolveOlderHistoryAutoLoadEnabled(
				userPrefs?.autoLoadOlderMessages,
				userPrefsLoading,
			);
			const { hasPrev, loadingOlder, loadOlder, loadOlderAsync, oldestLoadedSeq, getLastTrimAt } =
				pretextDocument;
			const hasPrevRef = useRef(hasPrev);
			hasPrevRef.current = hasPrev;
			const loadingOlderRef = useRef(loadingOlder);
			loadingOlderRef.current = loadingOlder;
			const autoLoadEnabledRef = useRef(autoLoadEnabled);
			autoLoadEnabledRef.current = autoLoadEnabled;
			const loadOlderRef = useRef(loadOlder);
			loadOlderRef.current = loadOlder;
			// Read through refs by the jump loop, which pages upward across awaits and must
			// see the CURRENT window (not the values captured when the jump started).
			const loadOlderAsyncRef = useRef(loadOlderAsync);
			loadOlderAsyncRef.current = loadOlderAsync;
			const oldestLoadedSeqRef = useRef(oldestLoadedSeq);
			oldestLoadedSeqRef.current = oldestLoadedSeq;
			// A near-top scroll only auto-loads after recent upward reader movement.
			// Wheel/touch handlers and non-programmatic scroll frames both record intent;
			// consuming it prevents an idle top or a prepend correction from paging again.
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

			const forgetAskInPassingRef = useRef<((messageId: string) => void) | null>(null);
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
				// The shell is NOT remounted per narrator (no `key={narratorId}`), so the
				// per-row handler caches keyed by spec.key would otherwise accumulate every
				// row of every narrator visited in this session, each entry pinning a closure.
				// The keys are narrator-scoped, so nothing survives the switch usefully.
				unknownHeightReporterCacheRef.current.clear();
				togglesCacheRef.current.clear();
				reflectionTakeOverCacheRef.current.clear();
				// Closing rows are released by `MotionOp.onDone`, which only runs for
				// animations this shell still owns. A narrator switch is not an unmount, so
				// `cancel()` does not fire and a fold interrupted by the switch leaves its
				// entry behind — a retained card key belonging to a trace that no longer
				// exists, kept alive for the rest of the session.
				setClosingRows((prev) => (prev.size === 0 ? prev : new Map()));
			}, [narratorId]);

			const revisionSubscriptionId =
				pretextDocument.index && pretextDocument.status !== "loading" ? narratorId : undefined;
			// Cursor AND version travel together: the server needs both to decide whether this
			// subscriber is behind. Passing a bare cursor made `useNarratorWS` read `.cursor`
			// off a `CatchUpCursor` and get `undefined`, silently disabling catch-up for this
			// list while a shared panel subscription's newer coordinate won instead.
			const exactMessageSnapshot = useMemo(
				() => buildExactMessageSnapshot(pretextDocument.messages, pretextDocument.messageVersion),
				[pretextDocument.messages, pretextDocument.messageVersion],
			);
			useEffect(() => {
				if (!revisionSubscriptionId) return;
				initialRevisionSyncRef.current = true;
			}, [revisionSubscriptionId]);

			// An ambiguous middle insertion must not use the normal tail reload gate.
			// Coalesce acknowledgements; allow one retry if an in-flight page lost its
			// generation race. Failure keeps the current window and explicitly reports it.
			const askRefreshRef = useRef<{ narratorId: string } | null>(null);
			const refreshAskInPassingWindow = useCallback(() => {
				if (askRefreshRef.current?.narratorId === narratorId) return;
				const scope = { narratorId };
				askRefreshRef.current = scope;
				void (async () => {
					for (let attempt = 0; attempt < 2; attempt++) {
						if (narratorIdRef.current !== narratorId || !viewportRef.current) return;
						if (await pretextDocumentRef.current.refreshAskInPassing().catch(() => false)) return;
					}
					if (narratorIdRef.current === narratorId && viewportRef.current) {
						notifications.show({
							id: `ask-in-passing-sync-${narratorId}`,
							message: t("askInPassing_syncFailed"),
							color: "yellow",
						});
					}
				})().finally(() => {
					if (askRefreshRef.current === scope) askRefreshRef.current = null;
				});
			}, [narratorId, t]);

			// Every realtime/catch-up message is a canonical projection, not a one-shot
			// append. Upsert by id + seq first so a duplicate event cannot create a second
			// bubble, while a later delivery-state or edit event still replaces the loaded row.
			// New mid-window rows fall back to the structural reload; compact markers keep
			// their existing exact insert fast path.
			const upsertOrReload = useCallback(
				(message: TreeMessage | undefined) => {
					if (message && upsertMessageRef.current(message)) {
						appliedMessageRevisionRef.current += 1;
					} else if (message && askInPassingBlock(message)) {
						refreshAskInPassingWindow();
						return;
					} else if (
						message &&
						isCompactMarkerMessage(message) &&
						insertMessageRef.current(message)
					) {
						appliedMessageRevisionRef.current += 1;
					}
					bumpMessageRevision();
				},
				[bumpMessageRevision, refreshAskInPassingWindow],
			);

			// A deletion is applied to the loaded window IN PLACE for the same reason an
			// append is — the ids arrive in the event, so a refetch buys nothing — but here
			// the deferral was the actual bug rather than just latency. A structural reload
			// waits for the reader to be at the bottom, and a reader who right-clicked a
			// message in history never is, so their rollback appeared not to happen until
			// they scrolled back down. `removeMessages` returning false means the removal was
			// declined (nothing loaded matched, or it would empty the document), which falls
			// through to the reload exactly as an unappendable message does.
			const removeOrReload = useCallback(
				(deletedMessageIds: string[]) => {
					for (const id of deletedMessageIds) forgetAskInPassingRef.current?.(id);
					if (removeMessagesRef.current(deletedMessageIds)) {
						// Keep the applied revision in step so the reload gate does not treat this
						// as still pending — that would surface a false "new messages" affordance
						// and then refetch what is already correct on screen.
						appliedMessageRevisionRef.current += 1;
					}
					bumpMessageRevision();
				},
				[bumpMessageRevision],
			);

			// The other half of a rollback: the boundary message keeps its blocks up to the
			// rollback point and loses the rest, arriving as `message_updated`. Applying that
			// truncation in place is what stops a rollback from looking half-done (messages
			// below gone, the clicked card's tail blocks still there). Anything that is NOT a
			// trailing truncation is declined by `replaceMessage` — with one exception: a
			// compact marker's status flip (compacting → compacted/failed) keeps every block
			// in place and changes only the marker's fields, and the marker row folds its
			// status into the measure cache key, so the live-patch channel applies it safely
			// (anchor-preserving, since a segment marker's FAILED card is taller). Every
			// other update reloads, since a version-neutral rebuild would serve the
			// surviving blocks' cached heights for changed content.
			const replaceOrReload = useCallback(
				(
					message: TreeMessage | undefined,
					aliases?: {
						oldMessageId?: string;
						replacedMessageId?: string;
						messageId?: string;
						replacementMessageId?: string;
					},
				) => {
					// Same-id updates (including queued → claimed/materialized/failed and
					// canonical user edits) use the id+seq upsert path. Alias-bearing COW
					// replacements still use the legacy replacement guard below.
					if (message && !aliases && upsertMessageRef.current(message)) {
						appliedMessageRevisionRef.current += 1;
					} else if (message && askInPassingBlock(message)) {
						refreshAskInPassingWindow();
						return;
					} else if (message && replaceMessageRef.current(message, aliases)) {
						appliedMessageRevisionRef.current += 1;
					} else if (
						message &&
						isCompactMarkerMessage(message) &&
						applyLivePatchRef.current((messages) => {
							const index = messages.findIndex((existing) => existing.id === message.id);
							if (index < 0) return { messages, changed: false };
							const patched = [...messages];
							patched[index] = message;
							return { messages: patched, changed: true };
						})
					) {
						appliedMessageRevisionRef.current += 1;
					}
					bumpMessageRevision();
				},
				[bumpMessageRevision, refreshAskInPassingWindow],
			);

			// The exact shell is stable-state only. Subscribe to the existing message
			// control stream once a complete document exists. Realtime mutations reload
			// the full exact input; reconnect catch-up reloads only when it reports data.
			useNarratorWS(
				revisionSubscriptionId,
				{
					onMessage: (wsData: { message?: TreeMessage; [key: string]: unknown }) =>
						upsertOrReload(wsData.message),
					onUserMessage: (wsData: { message?: TreeMessage; [key: string]: unknown }) =>
						upsertOrReload(wsData.message),
					onMessageUpdated: replaceOrReload,
					onMessagesDeleted: removeOrReload,
					// A segment compact hides its compressed messages through this dedicated
					// event rather than `messages_deleted` (they are not gone — their summary
					// lives behind the marker). The ids arrive in the event, so the in-place
					// removal applies exactly as a deletion does: the run the reader just
					// selected collapses immediately, wherever they are scrolled.
					onSegmentCompactHide: (hiddenMessageIds: string[]) => {
						if (removeMessagesRef.current(hiddenMessageIds)) {
							appliedMessageRevisionRef.current += 1;
						}
						bumpMessageRevision();
					},
					// Completion (and failure — the dispatcher folds `compact_failed` into this
					// callback) carries no message body: the content already arrived via
					// `message` / `message_updated`, both applied in place above. It is kept
					// for two things the in-place paths cannot cover:
					//
					//   1. Paths that broadcast a BARE compact_done with no preceding message
					//      frame (narrator-recovery does, in several places). Without this
					//      handler the document had no signal at all and stayed stale until the
					//      reader reloaded the page — the reported bug's second half.
					//   2. Converging the local seq numbering. `insertMessage` deliberately
					//      does not shift the following seqs (see vlist-message-insert), and
					//      this reload adopts the server's.
					//
					// It does NOT exist to shrink the window: the document page filters only on
					// `segmentCompactId` (server-side), so a full-history compact leaves every
					// older message readable and a segment compact's hidden rows are already
					// gone via `onSegmentCompactHide` above.
					onCompactDone: (_contextPercentAfter, isSegment, _mode, replacement) => {
						// COW retries may name old and/or new marker ids; the non-retry
						// path often names none. Always clear aliases when present, then
						// every key this panel wrote (progress is keyed by the id that
						// `compact_progress` broadcast, which is not always on the done
						// payload). Do not clearAll here — another narrator may still be
						// compacting.
						clearCompactProgressAliases(replacement, isSegment);
						const observed = compactProgressKeysRef.current;
						for (const [messageId, wasSegment] of observed) {
							if (isSegment != null && wasSegment !== isSegment) continue;
							clearCompactProgress(messageId, wasSegment);
							observed.delete(messageId);
						}
						bumpMessageRevision();
					},
					onCompactFailed: (_error, _mode, messageId) => {
						clearCompactProgress(messageId);
						if (messageId) compactProgressKeysRef.current.delete(messageId);
					},
					onFullReload: () => {
						clearAllCompactProgress();
						compactProgressKeysRef.current.clear();
						bumpMessageRevision();
					},
					// Live compact-progress ticks repaint only the mounted fixed-height marker.
					// They never enter the pretext document or its measurement cache.
					onCompactProgress: ({
						messageId,
						isSegment,
						phase,
						thinkingChars,
						outputChars,
						retryCount,
					}) => {
						if (!messageId) return;
						const segment = !!isSegment;
						setCompactProgress(messageId, segment, {
							phase,
							thinkingChars,
							outputChars,
							retryCount,
						});
						compactProgressKeysRef.current.set(messageId, segment);
					},
					onCatchUp: (orphanChildren, topLevel, subagentActivities) => {
						const initialSync = initialRevisionSyncRef.current;
						initialRevisionSyncRef.current = false;
						let applied = false;
						for (const message of topLevel) {
							if (upsertMessageRef.current(message)) applied = true;
						}
						const revisionDelta = resolveExactCatchUpRevisionDelta({
							initialSync,
							topLevelCount: topLevel.length,
							applied,
							orphanChildrenCount: orphanChildren.length,
							subagentActivitiesCount: subagentActivities.length,
						});
						appliedMessageRevisionRef.current += revisionDelta.appliedRevisionDelta;
						if (revisionDelta.messageRevisionDelta > 0) bumpMessageRevision();
					},
					onSyncOk: () => {
						initialRevisionSyncRef.current = false;
					},
					// Access was refused or revoked: no snapshot or catch-up is coming. Clear the
					// pending initial sync so the view stops waiting on a stream it will never
					// receive, and refetch — the REST call now answers 404 and the surrounding
					// route renders its "not found" state instead of an endless spinner.
					onSubscribeDenied: () => {
						initialRevisionSyncRef.current = false;
						bumpMessageRevision();
					},
				},
				exactMessageSnapshot,
				{ kind: "messages" },
			);
			// Live LIFECYCLE updates (tool started/completed, reflection gates, permission
			// decisions, background terminals, subagent activity). These mutate an
			// already-loaded message in place, so they are applied as anchor-preserving
			// document patches instead of reloading — the server never re-broadcasts the
			// owning message for them, and reflections do not even bump messageVersion, so
			// without this channel a finished tool renders as "running" forever.
			//
			// Unlike the structural reload below this is NOT gated on pinnedToBottom: a
			// patch neither changes the loaded window nor moves the viewport, so a reader
			// browsing history still sees tool/reflection state advance correctly.
			useVListLivePatches(revisionSubscriptionId, {
				enabled: !!revisionSubscriptionId,
				isSubagent: !!isSubagent,
				applyLivePatch: pretextDocument.applyLivePatch,
				// A terminal event can race the initial exact-document load: the synthetic
				// streaming row has the completed output, but the persisted message is not
				// in the coordinator yet, so an in-place patch necessarily misses. Re-run
				// the normal authoritative load instead of leaving the later expansion with
				// the pre-completion empty detail.
				onUnappliedToolCompletion: bumpMessageRevision,
			});

			// Structural reload gate — now the FALLBACK, not the normal path.
			//
			// A plain landed message is appended in place (see appendOrReload), and a
			// lifecycle change is patched in place, so what still reaches here is only what
			// genuinely restructures the loaded window: an edit, a delete, a compact
			// marker, a mid-window insert, or a reconnect catch-up.
			//
			// For those the reload still defers while the reader has scrolled up — replacing
			// the window would yank them back to the tail and discard their loadOlder pages —
			// and the deferral stays VISIBLE through the unread affordance. That deferral is
			// far less costly than it used to be: it no longer withholds ordinary new
			// messages, because those never take this path any more.
			//
			// It remains COALESCED so a burst of restructuring events costs one refetch.
			const reloadDecision = resolveExactReloadDecision({
				messageRevision,
				appliedRevision: appliedMessageRevisionRef.current,
				hasIndex: !!pretextDocument.index,
				pinnedToBottom,
			});
			const reloadRef = useRef(pretextDocument.reload);
			reloadRef.current = pretextDocument.reload;
			// Timestamp of the FIRST revision in the current pending batch. The coalescing
			// window is restarted by each new revision, so without this the window would be
			// an unbounded debounce: a tool-dense turn emits structural events closer
			// together than the window and the reload would be postponed for the whole turn.
			// Anchoring the max-delay budget here instead means later arrivals shorten the
			// remaining wait rather than extending it.
			const reloadPendingSinceRef = useRef(0);
			useEffect(() => {
				if (!reloadDecision.reload) {
					reloadPendingSinceRef.current = 0;
					return;
				}
				const now = Date.now();
				if (reloadPendingSinceRef.current === 0) reloadPendingSinceRef.current = now;
				const timer = setTimeout(
					() => {
						reloadPendingSinceRef.current = 0;
						appliedMessageRevisionRef.current = messageRevision;
						reloadRef.current();
					},
					resolveReloadDelayMs(reloadPendingSinceRef.current, now),
				);
				// A newer revision arriving inside the window restarts the timer (so the batch
				// commits once at the latest revision rather than once per message) but NOT the
				// deadline — once EXACT_RELOAD_MAX_DELAY_MS has elapsed since the first pending
				// revision the delay resolves to 0 and the batch commits on the next tick.
				return () => clearTimeout(timer);
			}, [reloadDecision.reload, messageRevision]);

			const renderItems = pretextDocument.items;
			// Read by the fold capture (a click handler), which must see the committed items
			// without being rebuilt on every document change.
			const renderItemsRef = useRef(renderItems);
			renderItemsRef.current = renderItems;

			// Tool uses whose full payload the USER asked for — by reading past the halfway
			// mark of a prefix body, or by opening one in fullscreen. Publishing the list
			// into state rather than reading it during the build keeps the data flow
			// one-way — the fetched payloads feed the NEXT build through the resolvers above.
			//
			// The gate is `fullPayloadRequested`, NOT `expanded`: fetching for a committed
			// row is only acceptable when the reader actually engaged with that body. Merely
			// expanding a card shows the (already measured) preview, which is why the two
			// signals are separate sets.
			// A subagent card's PROMPT is the same kind of request through a different
			// affordance: unfolding the prompt IS the click that asks for those bytes, so
			// `promptOpen` gates the fetch (never mere card expansion, and never a card the
			// reader only scrolled past).
			//
			// ⚠️ The landing payload DOES resize the row, and deliberately gets no fold
			// transition. A truncated body reserves the whole cap (`cappedBodyHeight`), so a
			// body whose real content is shorter than the cap shrinks when it lands —
			// measured on a `plan` detail at 600px wide: 901px reserved, 123.9px once the
			// real text arrived. (An earlier note here claimed the reservation meant "the row
			// does not resize"; that is only true for the common case where the real body
			// still overflows the cap.)
			//
			// It gets no capture for a structural reason rather than an oversight: the bytes
			// land asynchronously, long past the fold capture's ~400ms age bound, so a
			// capture taken at request time would always be rejected. The rebuild is ANCHORED
			// instead (`usePretextDocument` captures before every rebuild), which is the
			// correct treatment for a change the reader did not just click: the content they
			// are looking at holds its screen position and nothing below it appears to move.
			const truncatedExpandedToolUseIds = useMemo(() => {
				const ids: VListToolDetailRequest[] = [];
				for (const item of renderItems) {
					if (!item) continue;
					if (item.spec.kind === "communication-bubble") {
						const source = item.spec.data as { toolUseId?: string; messageBody?: ToolCappedDetail };
						if (
							source.toolUseId &&
							source.messageBody?.textTruncated &&
							isFullPayloadRequestedRow(activeInteraction, item.spec.key)
						) {
							ids.push(toolDetailRequestFromData(source.toolUseId, source));
						}
						continue;
					}
					if (item.spec.kind === "tool-call") {
						const measured = item.measured as MeasuredToolCall;
						if (measured.truncatedLeafCount <= 0) continue;
						if (!isFullPayloadRequestedRow(activeInteraction, item.spec.key)) continue;
						if (measured.toolUseId)
							ids.push(toolDetailRequestFromData(measured.toolUseId, item.spec.data));
						continue;
					}
					if (item.spec.kind === "subagent-card") {
						const measured = item.measured as MeasuredSubagent;
						const source = item.spec.data as {
							promptBody?: ToolCappedDetail;
							resultBody?: ToolCappedDetail;
						};
						const requested = isFullPayloadRequestedRow(activeInteraction, item.spec.key);
						if (
							!measured.promptTruncated &&
							!(requested && (source.promptBody?.textTruncated || source.resultBody?.textTruncated))
						)
							continue;
						if (measured.toolUseId)
							ids.push(toolDetailRequestFromData(measured.toolUseId, item.spec.data));
						continue;
					}
					// A drilled-in trace row hosts a real tool card, so it reaches the same
					// truncated payloads. Gated per ROW (several rows of one trace can be open),
					// and — like the standalone card — only on an explicit request: the card
					// already reserves the full cap while truncated, so the landing payload
					// measures to the same box, never a surprise growth.
					if (TRACE_ROW_INTERACTION_KINDS.has(item.spec.kind)) {
						const measured = item.measured as MeasuredCollapsibleTrace;
						for (const row of measured.rows) {
							if (!row.cardMeasured) continue;
							// A drilled-in SUBAGENT card reaches its truncated PROMPT through the
							// same affordance the standalone card uses: `promptTruncated` is only set
							// while the prompt is OPEN, so unfolding it is the request — and the
							// block already reserves the full cap, so the landing body cannot resize
							// the row.
							if (row.cardKind === "subagent-card") {
								const subCard = row.cardMeasured as MeasuredSubagent;
								const source = resolveTraceRowCardData(item, row.itemIndex) as {
									promptBody?: ToolCappedDetail;
									resultBody?: ToolCappedDetail;
								};
								const requested = isFullPayloadRequestedRow(
									activeInteraction,
									ownerRequestKey({ specKey: item.spec.key, traceItemIndex: row.itemIndex }),
								);
								if (
									!subCard.toolUseId ||
									(!subCard.promptTruncated &&
										!(
											requested &&
											(source.promptBody?.textTruncated || source.resultBody?.textTruncated)
										))
								)
									continue;
								ids.push(toolDetailRequestFromData(subCard.toolUseId, source));
								continue;
							}
							const card = row.cardMeasured as MeasuredToolCall;
							if (card.truncatedLeafCount <= 0 || !card.toolUseId) continue;
							const rowOwner = { specKey: item.spec.key, traceItemIndex: row.itemIndex };
							const rowKey = ownerRequestKey(rowOwner);
							if (!isFullPayloadRequestedRow(activeInteraction, rowKey)) continue;
							ids.push(
								toolDetailRequestFromData(
									card.toolUseId,
									resolveTraceRowCardData(item, row.itemIndex),
								),
							);
						}
					}
				}
				return ids;
			}, [renderItems, activeInteraction]);
			useEffect(() => {
				setTruncatedToolCalls((prev) =>
					prev.narratorId === narratorId &&
					sameToolDetailRequests(prev.requests, truncatedExpandedToolUseIds)
						? prev
						: { narratorId, requests: truncatedExpandedToolUseIds },
				);
			}, [narratorId, truncatedExpandedToolUseIds]);

			// Mark a row as having asked for its full payload. This must mark
			// SYNCHRONOUSLY: the channel below treats `requestFullPayload` as fire-and-
			// forget, so handing it a thunk factory (as the removed per-row notice-line
			// prop once consumed) marks nothing and the fetch never starts.
			const requestRowFullPayload = useCallback((owner: VListViewOwner) => {
				setInteraction((prev) => markVListFullPayloadRequested(prev, ownerRequestKey(owner)));
			}, []);

			// Fullscreen content viewer: per-body wrap / source state plus the single open
			// target. Deliberately NOT part of `VListInteractionState` — that object feeds
			// computeLayout, and these are pure render state (see useVListContentView).
			//
			// `requestFullPayload` is how a prefix body reaches its real bytes: reading past
			// the halfway mark of an inline body, or opening one in fullscreen. Both are
			// user actions on the grow-only interaction channel, which is what lets a
			// committed row's payload change at all.
			const contentView = useVListContentView({ requestFullPayload: requestRowFullPayload });

			// The open modal's body, re-derived from the CURRENT document.
			//
			// `openFullscreen` stores a snapshot (targets are rebuilt with the document, so
			// a live reference would dangle), which means a body opened while still a
			// server-side prefix would keep showing that prefix even after the fetch above
			// resolved. Re-deriving the same id closes that loop.
			//
			// It also yields the modal's loading state: a target that is STILL flagged
			// truncated on a row the reader has already requested is one whose bytes are in
			// flight, which is what the modal reports instead of silently showing a prefix.
			//
			// Scoped to an open modal — with nothing open this short-circuits before the
			// scan, so a scrolling list pays nothing.
			const openTarget = contentView.openTarget;
			const openTargetState = useMemo<{ target?: VListViewTarget; loading: boolean }>(() => {
				if (!openTarget) return { loading: false };
				const match = (item: VListItem, traceItemIndex?: number) => {
					const targets =
						traceItemIndex == null
							? resolveItemViewTargets(item, renderLabels, resolveRenderExtra(item.spec), true)
							: resolveTraceRowViewTargets(item, traceItemIndex, renderLabels, true);
					return targets.find((candidate) => candidate.id === openTarget.id);
				};
				const owner = openTarget.owner;
				const item = renderItems.find((candidate) => candidate?.spec.key === owner.specKey);
				let target = item ? match(item, owner.traceItemIndex) : undefined;
				// Location can change at an LOD/trace transition; content identity cannot.
				// This fallback only runs for the ONE open modal after its old owner moved.
				if (!target) {
					for (const candidate of renderItems) {
						if (!candidate) continue;
						target = match(candidate);
						if (!target && TRACE_ROW_INTERACTION_KINDS.has(candidate.spec.kind)) {
							const rows = (candidate.measured as MeasuredCollapsibleTrace).rows ?? [];
							for (const row of rows) {
								target = match(candidate, row.itemIndex);
								if (target) break;
							}
						}
						if (target) break;
					}
				}
				return {
					...(target ? { target } : {}),
					loading:
						target?.truncated === true &&
						isFullPayloadRequestedRow(activeInteraction, ownerRequestKey(target.owner)),
				};
			}, [openTarget, renderItems, renderLabels, activeInteraction]);
			const refreshOpenTarget = contentView.refreshOpenTarget;
			const refreshedTarget = openTargetState.target;
			useEffect(() => {
				// The hook ignores an unchanged body, so this settles after one pass.
				if (refreshedTarget) refreshOpenTarget(refreshedTarget);
			}, [refreshedTarget, refreshOpenTarget]);

			// Reflection facts (danger / plan / task / question gates) the layout spec drops.
			// Same source as toolMetaIndex; keyed by toolUseId. Empty for the overwhelming
			// majority of narrators, in which case the bridge short-circuits.
			const reflectionIndex = useMemo(
				() => buildReflectionSourceIndex(pretextDocument.messages as unknown as NarratorMsg[]),
				[pretextDocument.messages],
			);

			// Per-key live permission form nodes for tool + subagent cards. Empty when
			// nothing is pending, in which case every row renders with its normal zero-DOM
			// body. `reflections` only decides precedence: a row whose permission area is
			// owned by the MEASURED reflection notice must not also mount a form.
			//
			// Derived BEFORE the layout because the set of rows hosting a live form decides
			// which height overrides may still apply (see below).
			const rowToolMetaIndex = useMemo(
				() => buildToolMetaIndex(pretextDocument.messages as unknown as NarratorMsg[]),
				[pretextDocument.messages],
			);
			const permissionSlotByKey = usePermissionSlots({
				renderItems,
				tools: rowToolMetaIndex,
				permCb,
				reflections: reflectionIndex,
				asyncQuestions: permCb?.asyncQuestions,
			});
			// The same forms for calls that stayed a row of their L1/L2 activity trace and
			// were drilled open onto their card (see useTracePermissionSlots).
			const tracePermissionSlotsByKey = useTracePermissionSlots({ renderItems, permCb });
			/**
			 * Keep an ANSWERED form's card painted while its drilled block closes.
			 *
			 * When a request leaves the list (the reader answered, or another client did),
			 * the next rebuild commits the row's short height and React would unmount the
			 * card in that very frame — it would vanish instead of closing, exactly the
			 * failure `closingRowKeys` was built for on a manual un-drill. This runs on the
			 * commit where the list changed, which is BEFORE the rebuild (the document
			 * rebuilds in usePretextDocument's effect off the new resolver identity), so the
			 * rendered rows are still the pinned ones and can be marked here.
			 *
			 * The lifecycle effect then either plans the block's resize (whose `onDone`
			 * releases the row) or releases it at once.
			 */
			const previousPendingIdsRef = useRef<ReadonlySet<string>>(new Set());
			useLayoutEffect(() => {
				const current = new Set<string>();
				for (const perm of permCb?.pendingPermissions ?? []) {
					if (perm.toolUseId) current.add(perm.toolUseId);
				}
				const previous = previousPendingIdsRef.current;
				previousPendingIdsRef.current = current;
				if (previous.size === 0 || prefersReducedMotion()) return;
				const marks = new Map<string, Set<string>>();
				for (const item of renderItemsRef.current) {
					if (item?.spec.kind !== "activity-trace") continue;
					const rows = (
						item.measured as {
							rows?: readonly { key: string; pinnedOpen?: boolean; cardMeasured?: unknown }[];
						}
					).rows;
					for (const row of rows ?? []) {
						if (row.pinnedOpen !== true || row.cardMeasured == null) continue;
						const toolUseId = toolUseIdFromSpecKey(row.key);
						if (!toolUseId || !previous.has(toolUseId) || current.has(toolUseId)) continue;
						let set = marks.get(item.spec.key);
						if (!set) {
							set = new Set();
							marks.set(item.spec.key, set);
						}
						set.add(row.key);
					}
				}
				if (marks.size === 0) return;
				// Merge with any marks still waiting for their rebuild (two answers in a row).
				const waiting = pendingLifecycleClosingRef.current?.marks;
				if (waiting) {
					for (const [traceKey, rows] of waiting) {
						const set = marks.get(traceKey) ?? new Set<string>();
						for (const rowKey of rows) set.add(rowKey);
						marks.set(traceKey, set);
					}
				}
				pendingLifecycleClosingRef.current = { marks, items: renderItemsRef.current };
				setClosingRows((prev) => {
					const next = new Map(prev);
					for (const [traceKey, rows] of marks) {
						next.set(traceKey, new Set([...(prev.get(traceKey) ?? []), ...rows]));
					}
					return next;
				});
			}, [permCb?.pendingPermissions]);

			// Keys that currently host a dynamic (post-paint measured) body — rows carrying
			// a live permission FORM, a row hosting an intrinsically unpredictable block
			// (mermaid / unknown-size image), plus the row being edited inline. Only these
			// may hold a height override; every other row is pure arithmetic.
			//
			// Reflection rows are deliberately NOT here: the notice is measured
			// (measure-reflection-notice), so putting it on the dynamic path would let a
			// ResizeObserver move a committed row's height with no user action behind it.
			const dynamicRowKeys = useMemo(() => {
				const keys = new Set<string>();
				for (const item of renderItems) {
					if (!item) continue;
					// A card that RESERVED its form arithmetically stays a fixed, clipped row: the
					// form reports its own height through `permissionFormHeight`. Only a form the
					// card could not reserve (AskUserQuestion's banner, a subagent card's) keeps
					// the whole row on the post-paint path.
					if (
						permissionSlotByKey.has(item.spec.key) &&
						!(
							item.spec.kind === "tool-call" &&
							(item.measured as MeasuredToolCall).permissionFormHeight > 0
						)
					)
						keys.add(item.spec.key);
					// A mermaid diagram (or an image of unknown intrinsic size) only reserves a
					// conservative PLACEHOLDER, so its row must be allowed to report the settled
					// height. This is the CONTRACT's controlled exception, not a new one: the
					// render layer already switches such an element to a flowing layout and runs
					// a ResizeObserver — it just had nowhere to report to, so the row stayed
					// clipped to the placeholder and a diagram switched to "actual size" hid
					// every row below it.
					else if (hostsUnpredictableBlock(item.spec.kind, item.measured)) keys.add(item.spec.key);
				}
				if (editingRow) keys.add(editingRow.key);
				return keys;
			}, [renderItems, permissionSlotByKey, editingRow]);
			dynamicRowKeysRef.current = dynamicRowKeys;

			// Drop overrides that must no longer apply. The decisive case is a RESOLVED
			// PERMISSION: the tool card keeps its `tool-<id>` key but its live form
			// unmounts, so the row falls back to a much shorter arithmetic height. Pruning
			// only by manifest presence left the old form height pinned to the row, which
			// rendered the card floating at the top of a tall empty box with every
			// following row pushed down past the gap.
			//
			// Applied DURING render (not in an effect) so the corrected geometry lands in
			// the same commit the form disappears; an effect-based prune would paint one
			// frame with the stale height first.
			const effectiveHeightOverrides = useMemo(() => {
				if (heightOverrides.size === 0) return heightOverrides;
				return pruneHeightOverrides(heightOverrides, dynamicRowKeys) ?? heightOverrides;
			}, [heightOverrides, dynamicRowKeys]);
			// Commit the pruned map back to state so stale entries do not linger in memory
			// and later reports compare against the current value.
			useEffect(() => {
				if (effectiveHeightOverrides !== heightOverrides)
					setHeightOverrides(effectiveHeightOverrides);
			}, [effectiveHeightOverrides, heightOverrides]);

			const exactLayout = useMemo(() => {
				const base = buildExactListLayout(pretextDocument.index);
				const index = pretextDocument.index;
				if (!base || !index) return base;
				const manifestItems = index.manifest.items;
				const keys = manifestItems.map((m) => m.itemKey);
				const heights = manifestItems.map((m) => m.height);
				// Skip the correction pass entirely when no override changes geometry.
				if (!hasEffectiveHeightOverride(keys, heights, effectiveHeightOverrides)) return base;
				return layoutItemsWithOverrides(
					{
						heights,
						keys,
						gap: index.manifest.metrics.itemGap,
						topPadding: index.manifest.metrics.topPadding,
						bottomPadding: index.manifest.metrics.bottomPadding,
					},
					effectiveHeightOverrides,
				);
			}, [pretextDocument.index, effectiveHeightOverrides]);
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

			/**
			 * Identity of the currently committed DOCUMENT (not its geometry).
			 *
			 * `manifest.documentRevision` advances on every structural change — a new message,
			 * an edit, a live patch, an older page — but NOT on a fold, which only changes
			 * build options. That is exactly the discriminator the FLIP needs: a capture taken
			 * before a click is valid only if the commit it is consumed by came from that
			 * click. `layoutRevision` would be wrong here (it moves with width/LOD too, and a
			 * fold does change the manifest identity).
			 */
			const foldDocumentRevision = pretextDocument.manifest?.documentRevision;
			// Serve the click handler's capture from the committed layout + mounted window.
			// Assigned every render so the capture always reads current values (the callback
			// itself is created long before either exists).
			readFoldGeometryRef.current = () => {
				const layout = exactLayoutRef.current;
				const items = renderItemsRef.current;
				const window = visibleRef.current;
				const revision = foldRevisionOf(foldDocumentRevision);
				// The COMMITTED level, not `useRenderLod()`: the capture describes the geometry
				// this manifest produced, and a pinch that has re-rendered but not yet rebuilt
				// the document would otherwise stamp the capture with a level its boxes are not
				// from — inverting the check in isFoldCaptureUsable.
				const committedLod = pretextDocument.manifest?.lod ?? -1;
				if (!layout)
					return {
						geometry: new Map<string, FoldRowGeometry>(),
						frames: new Map<string, FoldRowGeometry>(),
						nested: new Map<string, { rows: Map<string, { top: number; height: number }> }>(),
						documentRevision: revision,
						lod: committedLod,
					};
				// Only the MOUNTED rows: an unmounted row has no node to animate, and bounding
				// the map here is what keeps a fold O(window) rather than O(history).
				const keys: string[] = [];
				const indices: number[] = [];
				for (let index = window.start; index < window.end; index++) {
					const item = items[index];
					if (!item || !layout.items[index]) continue;
					keys.push(item.spec.key);
					indices.push(index);
				}
				return {
					geometry: captureFoldGeometry(keys, (position) => {
						const index = indices[position];
						return index === undefined ? undefined : layout.items[index];
					}),
					// The grouping frames, derived from the SAME layout in the same snapshot, so
					// a border and the cards it wraps can never be planned from disagreeing
					// geometry. Not window-bounded: a frame can span the whole window and still
					// be mounted (see captureFoldFrameGeometry).
					frames: captureFoldFrameGeometry(
						toolRunFramesRef.current,
						(index) => layout.items[index],
					),
					// Rows nested INSIDE a trace element (L1/L2 activity runs). Drilling one open
					// moves its siblings without moving any top-level item, so without this they
					// teleported while everything below the run slid correctly. Same snapshot as
					// the rows above, so the two can never disagree.
					nested: captureFoldNestedRows(keys, (key) => {
						const measured = measuredByKeyRef.current.get(key) as
							| { rows?: readonly { key: string; top: number; blockHeight: number }[] }
							| undefined;
						return measured?.rows;
					}),
					documentRevision: revision,
					lod: committedLod,
				};
			};

			/**
			 * Play the fold transition for the commit a toggle just produced.
			 *
			 * A LAYOUT effect, not a passive one: it must start the animations in the same
			 * frame the new geometry is written, before the browser paints. A passive effect
			 * runs after paint, so the reader would see the jumped-to state for one frame and
			 * then watch it animate back — a flicker instead of a transition.
			 *
			 * `afterScrollTop` is read from the container rather than from state because the
			 * anchored rebuild's scroll correction is itself applied in a layout effect; the
			 * live value is what the reader will actually see (see planFoldMotion's note on
			 * viewport coordinates). That correction runs BEFORE this effect only because
			 * `usePretextDocument` is called earlier in this component — an ordering guarded
			 * at the source level by vlist-fold-wiring.test.ts.
			 *
			 * ## Why the pinned case PREDICTS its scrollTop instead of reading it
			 *
			 * While pinned to the bottom, `node.scrollTop` in this layout phase is not yet the
			 * value the reader will see. Two writers push the viewport back to the end of the
			 * content — the anchored "bottom" correction (a layout effect, keyed on the
			 * coordinator's computed scrollTop) and the geometry-revision pin effect (a passive
			 * effect writing in the NEXT frame) — and neither is guaranteed to have landed here:
			 * the correction is skipped when its computed value did not change, and the pin is a
			 * frame late by construction. Reading the raw value in either case plans the FLIP
			 * from a position that is about to be corrected, so expanding a card at the bottom
			 * started the animation off by the growth it was answering.
			 *
			 * `getScrollBottomTarget` is the exact value both writers converge on, and it is
			 * already correct in this phase: React has committed the canvas's new
			 * `height: totalHeight` and the tail footer, so `scrollHeight - clientHeight` is the
			 * post-correction bottom. Predicting it makes the plan agree with the frame the
			 * reader actually sees, whichever writer gets there.
			 *
			 * `pinnedToBottom` is render state, read from THIS commit's scope: the commit whose
			 * geometry is being animated. A fold cannot unpin (our own scroll writes are
			 * recognised as echoes, see writeScrollTop), so this is still the reader's state at
			 * click time — which is the state the correction will be applied under.
			 */
			useLayoutEffect(() => {
				const capture = foldCaptureRef.current;
				if (!capture) return;
				const node = viewportRef.current;
				const layout = exactLayoutRef.current;
				if (!node || !layout) return;
				if (
					!isFoldCaptureUsable(
						capture,
						foldRevisionOf(foldDocumentRevision),
						Date.now(),
						pretextDocument.manifest?.lod ?? -1,
					)
				) {
					// Something other than this fold rebuilt the document in between, the level
					// moved under it (a pinch right after a fold — see isFoldCaptureUsable), or
					// the rebuild never came. Dropping the capture is the whole point: animating
					// that delta would move rows for a change the reader did not make.
					foldCaptureRef.current = null;
					return;
				}
				const read = readFoldGeometryRef.current?.();
				if (!read) return;
				// PREDICTED while pinned, live otherwise (see the note above). One value serves
				// both plans so a border can never be planned against a different scroll pair
				// than the cards inside it.
				const afterScrollTop = pinnedToBottom ? getScrollBottomTarget(node) : node.scrollTop;
				const motions = planFoldMotion({
					before: capture.geometry,
					after: read.geometry,
					toggledKey: capture.toggledKey,
					beforeScrollTop: capture.scrollTop,
					afterScrollTop,
				});
				// The decorative grouping borders, planned from the same before/after snapshot
				// and the same scroll pair as the rows. Without this the frame was written at
				// its final box on the commit frame while the cards inside it were still 200ms
				// from arriving, so the border visibly detached from its own contents.
				const frameMotions = planFoldFrameMotion({
					before: capture.frames,
					after: read.frames,
					beforeScrollTop: capture.scrollTop,
					// Same predicted value as the rows: two scroll pairs would let a border
					// animate from a box its own contents never occupied.
					afterScrollTop,
				});
				// NOTHING TO PLAY IS NOT THE SAME AS DONE, and conflating the two is why an
				// earlier version of this never animated at all. `setInteraction` re-renders
				// FIRST; the document rebuild happens in usePretextDocument's passive effect
				// afterwards. So this effect runs once on the pre-rebuild commit, where the
				// geometry is still identical to the capture — consuming the capture there
				// would throw it away one commit before the geometry it was taken for.
				//
				// Keeping it costs nothing and is bounded from both ends: the revision check
				// above rejects a capture whose document changed underneath it, and the age
				// bound expires one whose rebuild never arrived.
				//
				// Rows nested inside a trace element (L1/L2 activity runs), planned from the same
				// snapshot pair. Local coordinates, so no scroll pair is involved — the trace's
				// own displacement is already carried by its element `shift` and adding it here
				// would animate these rows twice (see FoldNestedRowMotion).
				const nestedMotions = planFoldNestedRowMotion({
					before: capture.nested,
					after: read.nested,
				});
				// The other half of a drill-down: the row's own BLOCK changed size (a drilled
				// block IS the card, `blockHeight === card.height`). Without this React commits
				// the short height in frame one, so the card vanished instead of closing and the
				// rows below slid up from outside the already-shortened box — visible as content
				// emerging from a clip line and never catching up. See FoldNestedRowResize.
				const nestedResizes = planFoldNestedRowResize({
					before: capture.nested,
					after: read.nested,
				});
				// Every plan is consulted: a frame is derived from its rows, so in practice it
				// cannot move alone — but gating on the rows only would make that an assumption
				// this effect silently depends on. The nested plan genuinely CAN be the only
				// non-empty one: drilling a row inside a trace that is the document's last item
				// moves nothing at the top level at all.
				if (
					motions.length === 0 &&
					frameMotions.length === 0 &&
					nestedMotions.length === 0 &&
					nestedResizes.length === 0
				)
					return;
				foldCaptureRef.current = null;
				const ops: MotionOp[] = [];
				// This commit's geometry now belongs to the reader's fold; the lifecycle
				// channel must not plan a second animation over the same nodes.
				foldPlayedThisCommitRef.current = true;
				for (const motion of motions) {
					// A `reveal` clips, and an inset is measured from the bottom of the node it
					// plays on — so it MUST target the row's inner content box, whose height is
					// the layout's `height`. The outer row box is `hitHeight` tall (its own
					// height plus the gap to the next row, see resolveRowHitHeight), so playing
					// the clip there starts it a gap's worth of pixels below the card's real
					// bottom edge and the first frame uncovers content that should still be
					// hidden. A `shift` translates the whole row and belongs on the outer box.
					// A `reveal` CLIPS and a `resize` animates HEIGHT, so both must target the
					// row's inner content box — the only box whose height is the layout's
					// `height` and which carries the `overflow: hidden` that does the cropping.
					// A `shift` translates the whole row and belongs on the outer box.
					const selector =
						motion.kind === "shift"
							? `[data-nf-row-key="${cssAttrEscape(motion.key)}"]`
							: `[data-nf-row-body="${cssAttrEscape(motion.key)}"]`;
					ops.push({
						// Reveal and shift can BOTH be planned for the toggled row (expanding while
						// pinned to the bottom), on two different nodes and two different
						// properties. They are one movement, so they must not share a scope — the
						// scheduler cancels a scope before starting it, so the second would cancel
						// the first before it ever ran.
						scope: `${rowScope(motion.key)}:${motion.kind}`,
						resolve: () => node.querySelector<HTMLElement>(selector),
						keyframes: foldRowKeyframes(motion),
					});
				}
				// Rows nested INSIDE a trace element. At L1/L2 a whole activity run is ONE list
				// item, so drilling one of its tool rows open moves that row's siblings without
				// moving any top-level item: the row plan above cannot express it, and those
				// siblings teleported while everything below the run slid correctly.
				for (const nestedMotion of nestedMotions) {
					ops.push({
						// Scoped per ROW, and disjoint from the trace's own `row:` scope: the trace
						// element is itself animating (it grew), and cancelling one must not cancel
						// the other — they are different nodes moving by different amounts.
						scope: `${rowScope(nestedMotion.traceKey)}:nested:${nestedMotion.rowKey}`,
						resolve: () =>
							node
								.querySelector<HTMLElement>(
									`[data-nf-row-key="${cssAttrEscape(nestedMotion.traceKey)}"]`,
								)
								?.querySelector<HTMLElement>(
									`[data-nf-trace-row="${cssAttrEscape(nestedMotion.rowKey)}"]`,
								),
						keyframes: shiftKeyframes(nestedMotion.fromOffset),
					});
				}
				// Close (or open) the drilled block itself, so the card does not vanish in one
				// frame and the rows below stay glued to its bottom edge.
				for (const resize of nestedResizes) {
					ops.push({
						// Its own scope: this row is BOTH resizing and (usually) shifting, on the
						// same node but different properties. Sharing a scope would cancel one
						// before it started.
						scope: `${rowScope(resize.traceKey)}:nested-size:${resize.rowKey}`,
						// The BLOCK, not the row's positioning box: the latter carries the row's
						// own translate, and two animations on one node fight over it. Expand uses
						// clip-path on the final-height block; collapse uses height on the retained
						// card block so the CSS clip and the JS geometry stay in the same box.
						resolve: () =>
							node
								.querySelector<HTMLElement>(`[data-nf-row-key="${cssAttrEscape(resize.traceKey)}"]`)
								?.querySelector<HTMLElement>(
									`[data-nf-trace-block="${cssAttrEscape(resize.rowKey)}"]`,
								),
						keyframes:
							resize.kind === "reveal"
								? revealKeyframes(resize.fromInsetBottom)
								: nestedResizeKeyframes(resize.fromHeight, resize.toHeight),
						// Release the retained card once the block has finished closing around
						// it. Guaranteed exactly once on every exit path (finish, re-toggle,
						// teardown, never-started) — see MotionOp.onDone.
						onDone: () => releaseClosingRow(resize.traceKey, resize.rowKey),
					});
				}
				for (const frameMotion of frameMotions) {
					ops.push({
						scope: frameScope(frameMotion.key),
						resolve: () =>
							node.querySelector<HTMLElement>(
								`[data-tool-run-frame="${cssAttrEscape(frameMotion.key)}"]`,
							),
						keyframes: frameKeyframes(frameMotion),
					});
				}
				motionRef.current.begin();
				motionRef.current.push(ops);
			});

			// Every decorative animation outlives the click that started it (the reader can
			// scroll away or switch narrator mid-transition), so the one scheduler that owns
			// all of them is stopped explicitly on unmount.
			useEffect(() => {
				const scheduler = motionRef.current;
				return () => scheduler.cancel();
			}, []);

			/**
			 * Play drill-down header morphs, driven by a row-level diff of the committed
			 * rebuild.
			 *
			 * DECLARATIVE, not a click capture: every commit rebuilds a snapshot of each
			 * visible trace row's drill state, diffs it against the previous frame, and
			 * morphs each row whose drill flag flipped. Any number of rows can flip in one
			 * frame (stacked activity), and the per-row controller plays them all without one
			 * overwriting another — the failure mode of the old single-slot capture.
			 *
			 * A LAYOUT effect (same discipline as the fold above): it must run in the same
			 * frame the rebuild commits, before paint. All geometry is pure layout/measured
			 * arithmetic — no DOM measurement, no React state.
			 */
			useLayoutEffect(() => {
				const node = viewportRef.current;
				const layout = exactLayoutRef.current;
				if (!node || !layout) return;
				// Assemble the visible traces' row-level sources from the layout + measured
				// payloads. Only kinds that actually nest a drill-down card can flip.
				const items = renderItemsRef.current;
				const window = visibleRef.current;
				const traces: {
					traceKey: string;
					top: number;
					rows: {
						key: string;
						top: number;
						drilled: boolean;
						rowHeight?: number;
						blockHeight?: number;
						drillHeader: { top: number; height: number } | null;
					}[];
				}[] = [];
				for (let index = window.start; index < window.end; index++) {
					const item = items[index];
					const geo = layout.items[index];
					if (!item || !geo) continue;
					const measured = measuredByKeyRef.current.get(item.spec.key) as
						| {
								rows?: {
									key: string;
									top: number;
									rowHeight?: number;
									blockHeight: number;
									cardMeasured: unknown | null;
									drillHeader: { top: number; height: number } | null;
								}[];
						  }
						| undefined;
					if (!measured?.rows) continue;
					traces.push({
						traceKey: item.spec.key,
						top: geo.top,
						rows: measured.rows.map((r) => ({
							key: r.key,
							top: r.top,
							rowHeight: r.rowHeight,
							blockHeight: r.blockHeight,
							drilled: r.cardMeasured != null,
							drillHeader: r.drillHeader,
						})),
					});
				}
				const next = buildDrillSnapshots(traces, node.scrollTop);
				const prev = drillMorphPrevRef.current;
				// Only morph across a USER-driven fold: if the document revision moved, a live
				// patch / page / reload rebuilt the window and the diff would mix the reader's
				// toggle with a change they did not make. The snapshot still rolls forward so
				// the NEXT diff has a clean baseline.
				const revisionUnchanged =
					foldRevisionOf(foldDocumentRevision) === drillMorphRevisionRef.current;
				drillMorphRevisionRef.current = foldRevisionOf(foldDocumentRevision);
				drillMorphPrevRef.current = next;
				if (!revisionUnchanged || prefersReducedMotion()) return;
				const plans = diffDrillSnapshots(prev, next);
				if (plans.length === 0) return;
				// Same frame as the fold: this morph rides along with one (`onToggleRow` does
				// both), so its ops join the fold's batch instead of starting a second one.
				motionRef.current.begin();
				/**
				 * The card whose header this plan morphs, or null.
				 *
				 * Shared by the header op and the two fades below so all three resolve against the
				 * SAME card. Looking it up three times independently would let them disagree if the
				 * DOM changed between calls, and a fade on a stale node is invisible rather than
				 * wrong — the kind of failure nobody notices.
				 */
				const resolveDrillCard = (rowUid: string): HTMLElement | null => {
					const sep = rowUid.indexOf("::");
					const traceKey = rowUid.slice(0, sep);
					const rowKey = rowUid.slice(sep + 2);
					const rowNode = node.querySelector<HTMLElement>(
						`[data-nf-row-key="${cssAttrEscape(traceKey)}"]`,
					);
					return (
						rowNode?.querySelector<HTMLElement>(`[data-nf-trace-row="${cssAttrEscape(rowKey)}"]`) ??
						null
					);
				};
				motionRef.current.push(
					plans.map((plan) => ({
						scope: drillScope(plan.rowUid),
						resolve: () => {
							const sep = plan.rowUid.indexOf("::");
							const traceKey = plan.rowUid.slice(0, sep);
							const rowKey = plan.rowUid.slice(sep + 2);
							const rowNode = node.querySelector<HTMLElement>(
								`[data-nf-row-key="${cssAttrEscape(traceKey)}"]`,
							);
							const toggled = rowNode?.querySelector<HTMLElement>(
								`[data-nf-trace-row="${cssAttrEscape(rowKey)}"]`,
							);
							// ALWAYS the CARD's header, in both directions.
							//
							// The summary row is not a usable target on collapse: the card is retained
							// for the duration of the close (see closingRowKeys), so `titleRow` is not
							// rendered yet and this resolved to null — the header the reader is actually
							// looking at then jumped to its new place with no transition at all.
							//
							// Moving the CARD's header is also the right thing semantically: it is the
							// line that is on screen and must travel to where the summary line will be.
							// The summary row takes over only after the card is released, already at the
							// committed position, so it needs no motion of its own.
							return toggled?.querySelector<HTMLElement>("[data-nf-card-header]");
						},
						// A builder, not an array: when this replaces a morph still in flight (the
						// reader clicked the same row twice quickly) it resumes from where that
						// motion visually got to. Without it `fill: "none"` snaps the line to its
						// committed spot the instant the old animation is cancelled, and the second
						// click starts with a visible jump.
						keyframes: (previous) => drillMorphKeyframesFrom(plan, previous),
						// COLLAPSE only: this animates the card header, and the card is unmounted by
						// the same event that ends the motion (both are 200ms). With `fill: "none"`
						// the transform is dropped on the final frame, so the header snaps back to
						// its un-morphed position for exactly one frame before React removes it —
						// the "one frame dislocated downward" flash. Holding the end state bridges
						// that, and leaks nothing because the node is gone immediately after.
						//
						// An EXPAND must not hold: its node survives, and a retained transform there
						// is exactly the residue `fill: "none"` exists to prevent.
						holdEndState: plan.kind === "collapse",
					})),
				);
				// The tail cluster and the border, each on their OWN scope so an interrupted
				// transition replaces them independently of the header's travel.
				//
				// Both are cross-fades rather than movements, for different reasons: the cluster's
				// travel distance is unknowable without measuring rendered text (see
				// `drillTailKeyframes`), and the border exists only in the card form so it has
				// nothing to travel between. Both are exact mirrors between expand and collapse,
				// which is what makes a mid-flight flip reverse cleanly instead of restarting.
				motionRef.current.push(
					plans.flatMap((plan) => {
						const card = resolveDrillCard(plan.rowUid);
						if (!card) return [];
						return [
							{
								scope: `${drillScope(plan.rowUid)}:tail`,
								resolve: () => card.querySelector<HTMLElement>("[data-nf-card-tail]"),
								keyframes: (previous: { progress: number } | null) =>
									drillTailKeyframesFrom(plan.kind, previous),
								// Same reason as the header's: on collapse this node is unmounted by the
								// event that ends the fade, so dropping the final opacity would flash the
								// cluster back to full for one frame.
								holdEndState: plan.kind === "collapse",
							},
							{
								scope: `${drillScope(plan.rowUid)}:border`,
								// The card's own bordered `Paper` — the header's ancestor, not a child.
								resolve: () => card.querySelector<HTMLElement>("[data-nf-card-surface]"),
								keyframes: (previous: { progress: number } | null) =>
									drillBorderKeyframesFrom(plan.kind, previous),
								holdEndState: plan.kind === "collapse",
							},
						];
					}),
				);
			});

			/**
			 * Play LOD-switch morphs, driven by an element-level diff keyed by `unitId ?? key`.
			 *
			 * An LOD switch re-themes elements into different components (a card folds into a
			 * trace row, a row expands into a card), so neither the fold nor the drill morph is
			 * planned across it. This effect snapshots the viewport×3 window, diffs against the
			 * previous commit, and morphs each pair from its old screen position to its new one
			 * — all in one frame.
			 *
			 * Pairing covers the WHOLE document, not just the re-themed cards: a tool call pairs
			 * on the LOD-independent `unitId` the adapter attaches, while everything else
			 * (markdown, bubbles, system cards, usage rows) pairs on its `spec.key`, which is
			 * already level-invariant. Only the cards used to pair, which is what made a switch
			 * half-smooth — they eased into place while the body they sit in teleported.
			 * Correspondingly, only a morph whose `kind` changed cross-fades; a body that merely
			 * moved would blink. See vlist-lod-morph.ts.
			 *
			 * Gate: the morph only plays when the document revision is UNCHANGED and the lod
			 * MOVED (a pure re-theme). A revision move means a live patch / page / reload
			 * rebuilt the window; diffing across it would animate a change the reader did not
			 * make. The snapshot rolls forward either way so the next diff has a clean
			 * baseline. Pure layout arithmetic throughout — no DOM measurement, no React state.
			 */
			useLayoutEffect(() => {
				const node = viewportRef.current;
				const layout = exactLayoutRef.current;
				if (!node || !layout) return;
				const items = renderItemsRef.current;
				const scrollTop = node.scrollTop;
				const vh = viewportHeightRef.current;
				// Assemble the unitId-bearing elements straight from the layout + specs. The
				// whole committed document is read here (geometry is O(n) plain numbers, cheap);
				// the viewport×3 crop happens inside buildLodSnapshots.
				const elements: LodElementSource[] = [];
				/**
				 * Box of the render-UNIT each item belongs to, spanning all of its specs.
				 *
				 * The admission window has to judge one unit's content the same way at both levels,
				 * and the two forms differ enormously: at L1/L2 an activity unit is a single short
				 * fold, at L3+ it is a stack of full cards spanning thousands of pixels. Judged on
				 * their own boxes, the unit's later CARDS fall outside the window in the expanded
				 * frame while its ROWS all sit inside it in the folded one — so those members have
				 * no counterpart and are planned nothing, silently.
				 *
				 * Grouping comes from `spec.morphGroupId`, which the layout assigns from the
				 * activity grouping that applies at a low LOD — computed at every level, so both
				 * sides agree on the membership. See the note on the loop below.
				 */
				const unitBoxes: Array<{ top: number; height: number } | null> = new Array(
					items.length,
				).fill(null);
				{
					// One SHARED, mutable box per unit: every index in a unit points at the same
					// object, so growing it as later specs are seen retroactively widens the box the
					// earlier ones already reference.
					//
					// ⚠️ Grouped by `spec.morphGroupId`, NOT by `spec.unitStart`.
					//
					// `unitStart` marks the first spec of each RENDER unit, and at L3+ grouping is
					// off (`groupRenderUnits(segments, lod <= 2)`), so every spec starts its own
					// unit and the flag is true for all of them. The box then degenerated to each
					// element's OWN box — exactly what it exists to avoid. Measured on a 12-tool
					// group at scrollTop 9500: 3 of 12 members paired with the degenerate box
					// versus all 12 with the real group box.
					//
					// `morphGroupId` is computed from the activity grouping that would apply at a
					// low LOD regardless of the current level (see buildPretextDocumentLayout), so
					// the members of one group share it at BOTH levels and the box spans the whole
					// group on each side. Specs outside any activity group have none and fall back
					// to their own box, which is correct for them: their two forms are the same
					// element.
					const boxes = new Map<string, { top: number; height: number }>();
					for (let i = 0; i < items.length; i++) {
						const it = items[i];
						const g = layout.items[i];
						if (!it || !g) continue;
						const groupId = it.spec.morphGroupId;
						if (!groupId) {
							unitBoxes[i] = { top: g.top, height: g.height };
							continue;
						}
						const existing = boxes.get(groupId);
						if (!existing) {
							const box = { top: g.top, height: g.height };
							boxes.set(groupId, box);
							unitBoxes[i] = box;
							continue;
						}
						// Mutated in place so the members already pointing at this box widen with it.
						existing.height = Math.max(existing.height, g.top + g.height - existing.top);
						unitBoxes[i] = existing;
					}
				}
				for (let index = 0; index < items.length; index++) {
					const item = items[index];
					const geo = layout.items[index];
					if (!item || !geo) continue;
					// `key` and `kind` travel with `unitId`: the planner pairs on `unitId ?? key`
					// (so the document body — markdown, bubbles, system cards — is no longer
					// skipped for want of a unitId) and reads `kind` to decide whether the morph
					// is a component swap worth cross-fading. See vlist-lod-morph.ts.
					elements.push({
						unitId: item.spec.unitId,
						key: item.spec.key,
						kind: item.spec.kind,
						top: geo.top,
						height: geo.height,
						// Anchored to the whole unit, so a tool CARD at L3+ is admitted on the same
						// basis as the folded ROW it pairs with at L1/L2. Without this the fix on the
						// folded side alone changes nothing: the card is a top-level element with its
						// own tall box, so the unit's later cards still prune themselves out of the
						// expanded frame and still have no counterpart.
						groupBox: unitBoxes[index],
						unitAnchored: true,
					});
					// The L2/L3 boundary: a tool call is a summary ROW inside this trace at L1/L2
					// and a top-level CARD at L3+, both carrying the same `unitId`. Without the
					// nested rows the pairing has an empty intersection exactly at the switch that
					// changes the most, so nothing animates where it matters.
					//
					// `clip` is the item's own painted box: the shell clips a non-dynamic row to
					// its arithmetic height, so a nested row animated from far outside that box
					// would be invisible mid-flight. The planner drops the travel (keeping the
					// fade) for that case — see clipFor.
					const measured = measuredByKeyRef.current.get(item.spec.key) as
						| { rows?: { top: number; rowHeight: number; unitId?: string }[] }
						| undefined;
					if (!measured?.rows) continue;
					const clip = { top: geo.top, bottom: geo.top + geo.height };
					for (const row of measured.rows) {
						if (!row.unitId) continue;
						elements.push({
							unitId: row.unitId,
							// A row key is scoped to its trace, so it is not a usable cross-level
							// identity; `nested` tells the builder not to fall back to it.
							key: row.unitId,
							// The kind the ROW is, not the trace's: pairing it against the card's
							// `tool-call` is what marks this morph as a re-theme worth fading.
							kind: "trace-row",
							top: geo.top + row.top,
							// The title LINE, not the row block: a drilled-in row's block is a whole
							// card tall, and the perceived thing that moves is the summary line.
							height: row.rowHeight,
							clip,
							nested: true,
							// Admission is decided by the GROUP's box, not this row's. At L3+ the same
							// content spans an order of magnitude more height (10 rows of 19px become
							// 10 cards of ~400px), so judged on their own boxes the later members fall
							// outside the ×3 window in the expanded frame only — no counterpart, no
							// plan, and the reader sees the first few rows animate while the rest
							// teleport. The group's box is short and stable at both levels.
							groupBox: { top: geo.top, height: geo.height },
						});
					}
				}
				const next = buildLodSnapshots(elements, scrollTop, vh);
				const prev = lodMorphPrevRef.current;
				const docRev = foldRevisionOf(foldDocumentRevision);
				const lod = pretextDocument.manifest?.lod ?? -1;
				const isLodSwitch =
					prev != null &&
					lodMorphDocRevRef.current === docRev &&
					lodMorphLodRef.current !== -1 &&
					lodMorphLodRef.current !== lod;
				// Roll forward BEFORE the early returns, so the next diff compares against this
				// frame even when the morph is skipped (non-LOD rebuild, reduced motion, first
				// paint).
				lodMorphPrevRef.current = next;
				lodMorphDocRevRef.current = docRev;
				lodMorphLodRef.current = lod;
				/**
				 * The unified baseline must roll forward on EVERY frame, exactly like the keyframe
				 * path's `prev` above — and for the same reason.
				 *
				 * ⚠️ This was originally written inside the `unifiedMorph` branch below, i.e. AFTER the
				 * `isLodSwitch` guard. That made the baseline unreachable on ordinary frames, so it
				 * only ever recorded the layout of a frame that was ALREADY mid-switch: every switch
				 * then diffed against a stale, one-step-late snapshot and most elements failed to pair
				 * at all. The symptom was a large number of rows losing their animation — the very bug
				 * the rewrite set out to remove, reintroduced by putting the roll-forward on the wrong
				 * side of a `return`.
				 *
				 * Computed unconditionally rather than lazily: an admitted snapshot is plain numbers
				 * over the already-built element list, and skipping it on non-switch frames is exactly
				 * what broke it.
				 */
				// Raw element list, not an admitted snapshot: admission needs BOTH frames (see
				// `admitPair`), so the decision cannot be taken until the next frame arrives.
				const unifiedElements = toMorphElements(elements);
				const unifiedPrev = unifiedPrevRef.current;
				const unifiedPrevScrollTop = unifiedPrevScrollTopRef.current;
				unifiedPrevRef.current = unifiedElements;
				// Rolled forward with the elements it describes, on EVERY frame, or the pair would
				// be converted with mismatched scroll origins (see the ref's note).
				unifiedPrevScrollTopRef.current = scrollTop;
				if (!isLodSwitch || prefersReducedMotion()) return;
				if (unifiedMorph) {
					// UNIFIED PATH. Targets, not keyframes: the element is already laid out at its new
					// position, so it is handed the displacement it must travel back from and a resting
					// target of zero. Nothing here names a START, which is precisely why an interrupted
					// switch needs no special handling — the store already holds the visual position.
					if (!unifiedPrev) return;
					// Admitted as a PAIR: an element visible at either level is kept at both. Judging
					// each frame on its own geometry drops whole units, because one level's unit box can
					// miss the window entirely while the other's spans it.
					const { before: unifiedBefore, after: unifiedAfter } = admitPair(
						unifiedPrev,
						unifiedElements,
						scrollTop,
						vh,
						// The baseline frame's own scroll origin. A gesture-driven switch corrects
						// `scrollTop` to hold the pointed-at content still, so passing only the current
						// value would turn that correction into travel for every element.
						unifiedPrevScrollTop,
					);
					const targets = planMorphTargets(
						unifiedBefore,
						unifiedAfter,
						// A card is fully "cardness"; every folded form is not. This is the only place
						// the kind vocabulary is interpreted, keeping the planner generic.
						(kind) => (kind === "tool-call" || kind === "subagent-card" ? 1 : 0),
						// The two forms start their content at different offsets; the drill morph already
						// derives this from the shared row metrics and card padding.
						() => DRILL_MORPH_X_OFFSET,
					);
					const store = visualStateRef.current;
					const ids = new Set<string>();
					for (const plan of targets) {
						ids.add(plan.unitId);
						// Seed the new displacement UNLESS the element is still moving.
						//
						// ⚠️ The predicate is `isMoving`, NOT "does the store know this element". A
						// settled element is still retained, so keying on existence meant every switch
						// after the first one applied no displacement at all and the element teleported —
						// which is exactly the "most rows don't animate" report. It also explains why
						// interrupting repeatedly appeared to help: an interrupted element IS still
						// moving, so it happened to take the right branch.
						//
						//   moving  → retarget only, continuing from the current visual position;
						//   settled → seed the fresh displacement, or there is nothing to animate.
						if (store.isMoving(plan.unitId)) {
							// Mid-flight: keep the visual position and only change where it is heading. This
							// is the interruption property — the element continues from where it is.
							store.setTarget(plan.unitId, plan.target);
						} else {
							// Settled (or new): displace it back to where it was and let it travel home.
							// `startFrom` rather than `setTarget`, because the latter deliberately never
							// moves an existing element — using it here left every switch after the first
							// with no displacement at all, i.e. no animation.
							store.startFrom(plan.unitId, initialStateFor(plan), plan.target);
						}
					}
					morphIdentitiesRef.current = ids;
					store.retain(ids);
					morphDriverRef.current?.kick();
					return;
				}
				const plans = diffLodSnapshots(prev, next);
				if (plans.length === 0) return;
				motionRef.current.begin();
				motionRef.current.push(
					plans.map((plan) => ({
						scope: lodScope(plan.unitId),
						resolve: () => {
							const escaped = cssAttrEscape(plan.unitId);
							// `data-nf-unit` first, then `data-nf-row-key` — the only attribute an
							// element paired on its `key` paints. Without the fallback every
							// key-paired plan would resolve to null and the document body would go
							// back to teleporting, silently: the plans are still produced, so nothing
							// looks broken from the planner's side.
							//
							// One selector serves both forms of a tool call, because `data-nf-unit` is
							// painted on the top-level card wrapper AND on the folded trace row, and
							// the two never coexist: at L3+ only the card is mounted, at L1/L2 only
							// the row. (A drilled-in card inside a row paints no `data-nf-unit` of its
							// own, so it cannot shadow its row here.)
							return (
								node.querySelector<HTMLElement>(`[data-nf-unit="${escaped}"]`) ??
								node.querySelector<HTMLElement>(`[data-nf-row-key="${escaped}"]`)
							);
						},
						// A builder, so a switch re-triggered mid-flight (holding a zoom shortcut, or a
						// pinch crossing two thresholds) resumes from where the previous motion
						// visually got to. With `fill: "none"` the plain array restarts from the
						// committed geometry the cancelled animation snapped back to — a visible jump.
						keyframes: (previous) => lodMorphKeyframesFrom(plan, previous),
					})),
					// A level switch re-themes the whole document at once, so it gets the longer
					// base. The override is event-level, applied to every op in this batch.
					LOD_MOTION_DURATION_MS,
				);
				// A RE-THEMED element (`plan.fade`) is the same trace-row ↔ tool-call pair a drill
				// morph handles, so it gets the same two extra fades — the tail cluster, whose
				// travel distance is unknowable without measuring rendered text, and the border,
				// which exists in only one of the two forms.
				//
				// Only re-themes: an element that merely MOVED keeps its component, so its tail and
				// border are already correct and animating them would make unchanged chrome blink
				// once per zoom step.
				motionRef.current.push(
					plans.flatMap((plan) => {
						if (!plan.fade) return [];
						const escaped = cssAttrEscape(plan.unitId);
						const host =
							node.querySelector<HTMLElement>(`[data-nf-unit="${escaped}"]`) ??
							node.querySelector<HTMLElement>(`[data-nf-row-key="${escaped}"]`);
						if (!host) return [];
						// The card form's kind: fade the border IN when arriving at it, OUT when
						// leaving. `plan.fade` guarantees the two kinds differ.
						const kind = plan.toKind === "tool-call" ? "expand" : "collapse";
						return [
							{
								scope: `${lodScope(plan.unitId)}:tail`,
								resolve: () => host.querySelector<HTMLElement>("[data-nf-card-tail]"),
								keyframes: (previous: { progress: number } | null) =>
									drillTailKeyframesFrom(kind, previous),
							},
							{
								scope: `${lodScope(plan.unitId)}:border`,
								resolve: () => host.querySelector<HTMLElement>("[data-nf-card-surface]"),
								keyframes: (previous: { progress: number } | null) =>
									drillBorderKeyframesFrom(kind, previous),
							},
						];
					}),
					LOD_MOTION_DURATION_MS,
				);
			});

			/**
			 * LIFECYCLE transition — an element changing SHAPE because its content moved to
			 * another phase (a running card collapsing on completion, a live reasoning card
			 * settling, an L1/L2 row drilled open for a permission form and closed again).
			 * See vlist-lifecycle-motion.ts for what qualifies and why it is enumerated.
			 *
			 * Declared after the fold, drill and LOD effects and before MOTION FLUSH, so its
			 * ops join the same burst. It snapshots on EVERY commit (a baseline that only
			 * rolls on some commits diffs against a stale frame — the LOD morph's lesson),
			 * and plays only when the frame context is unchanged:
			 *
			 *  - same LOD and width bucket (those re-theme the whole document; the LOD morph
			 *    owns that transition);
			 *  - no reader fold on this commit (the fold effect already animated these nodes);
			 *  - no reduced motion.
			 *
			 * The document revision is deliberately NOT part of the gate: every lifecycle
			 * change arrives through a live patch or a structural rebuild, and requiring a
			 * stable revision would reject precisely the commits this channel exists for.
			 * The signature diff is what keeps ordinary rebuilds out — a reload or a page
			 * that changes no element's shape plans nothing.
			 */
			useLayoutEffect(() => {
				const node = viewportRef.current;
				const layout = exactLayoutRef.current;
				const foldPlayed = foldPlayedThisCommitRef.current;
				foldPlayedThisCommitRef.current = false;
				if (!node || !layout) return;
				const items = renderItemsRef.current;
				const window = visibleRef.current;
				const sources: LifecycleElementSource[] = [];
				for (let index = window.start; index < window.end; index++) {
					const item = items[index];
					const geo = layout.items[index];
					if (!item || !geo) continue;
					sources.push({
						key: item.spec.key,
						kind: item.spec.kind,
						...(item.spec.lifecycleId ? { lifecycleId: item.spec.lifecycleId } : {}),
						top: geo.top,
						height: geo.height,
						measured: item.measured,
					});
				}
				const next = buildLifecycleSnapshot(sources);
				const context = {
					lod: pretextDocument.manifest?.lod ?? -1,
					widthBucket: String(pretextDocument.manifest?.widthBucket ?? ""),
					scrollTop: node.scrollTop,
				};
				const prev = lifecyclePrevRef.current;
				const prevContext = lifecyclePrevContextRef.current;
				lifecyclePrevRef.current = next;
				lifecyclePrevContextRef.current = context;
				// Retained closing cards (an answered request) wait for the commit that
				// actually carries the rebuilt document; on the marking commit itself the rows
				// have not changed shape yet, and releasing them there would cancel the mark in
				// the same batched update. Once the items moved on, every mark whose resize did
				// not get planned (the block left the window, the delta was unreadable, a
				// guard below skipped the plan) is released NOW — no op means no onDone.
				const pendingClosing = pendingLifecycleClosingRef.current;
				const settleClosing = pendingClosing !== null && pendingClosing.items !== items;
				const releaseUnplanned = (planned: ReadonlySet<string>) => {
					if (!settleClosing || !pendingClosing) return;
					pendingLifecycleClosingRef.current = null;
					for (const [traceKey, rows] of pendingClosing.marks) {
						for (const rowKey of rows) {
							if (!planned.has(`${traceKey}::${rowKey}`)) releaseClosingRow(traceKey, rowKey);
						}
					}
				};
				if (
					!prev ||
					!prevContext ||
					foldPlayed ||
					prefersReducedMotion() ||
					prevContext.lod !== context.lod ||
					prevContext.widthBucket !== context.widthBucket
				) {
					releaseUnplanned(new Set());
					return;
				}
				// Land a running chase first: the plan's pinned afterScrollTop is the PREDICTED
				// bottom, and a glide still heading there would move rows under the animation.
				smoothFollowerRef.current?.snapToTarget();
				const afterScrollTop = pinnedToBottom ? getScrollBottomTarget(node) : node.scrollTop;
				const plan = planLifecycleMotion({
					before: prev,
					after: next,
					beforeScrollTop: prevContext.scrollTop,
					afterScrollTop,
				});
				releaseUnplanned(
					new Set(
						plan.nestedResizes
							.filter((resize) => resize.kind === "resize")
							.map((resize) => `${resize.traceKey}::${resize.rowKey}`),
					),
				);
				if (
					plan.rows.length === 0 &&
					plan.nestedMotions.length === 0 &&
					plan.nestedResizes.length === 0
				) {
					return;
				}
				// Own cancel domain (`life:`), disjoint from the fold's `row:`: a lifecycle
				// replay cancels only its previous lifecycle motion. The two channels cannot plan
				// on the same commit (`foldPlayedThisCommitRef`); if a reader's click lands while
				// a lifecycle motion is still running, the later WAAPI animation composites over
				// the earlier one on the same property, so the click's motion is what shows.
				const ops: MotionOp[] = [];
				for (const motion of plan.rows) {
					// Same node targeting as the fold: `shift` on the outer row box, `reveal` /
					// `resize` on the inner content box (the one whose height is the layout's).
					const selector =
						motion.kind === "shift"
							? `[data-nf-row-key="${cssAttrEscape(motion.key)}"]`
							: `[data-nf-row-body="${cssAttrEscape(motion.key)}"]`;
					ops.push({
						scope: `${lifecycleScope(motion.key)}:${motion.kind}`,
						resolve: () => node.querySelector<HTMLElement>(selector),
						keyframes: foldRowKeyframes(motion),
					});
				}
				for (const nestedMotion of plan.nestedMotions) {
					ops.push({
						scope: `${lifecycleScope(nestedMotion.traceKey)}:nested:${nestedMotion.rowKey}`,
						resolve: () =>
							node
								.querySelector<HTMLElement>(
									`[data-nf-row-key="${cssAttrEscape(nestedMotion.traceKey)}"]`,
								)
								?.querySelector<HTMLElement>(
									`[data-nf-trace-row="${cssAttrEscape(nestedMotion.rowKey)}"]`,
								),
						keyframes: shiftKeyframes(nestedMotion.fromOffset),
					});
				}
				for (const resize of plan.nestedResizes) {
					ops.push({
						scope: `${lifecycleScope(resize.traceKey)}:nested-size:${resize.rowKey}`,
						resolve: () =>
							node
								.querySelector<HTMLElement>(`[data-nf-row-key="${cssAttrEscape(resize.traceKey)}"]`)
								?.querySelector<HTMLElement>(
									`[data-nf-trace-block="${cssAttrEscape(resize.rowKey)}"]`,
								),
						keyframes:
							resize.kind === "reveal"
								? revealKeyframes(resize.fromInsetBottom)
								: nestedResizeKeyframes(resize.fromHeight, resize.toHeight),
						// A retained card (a request answered) is released once its block closes.
						// A no-op for rows that were never marked closing.
						onDone: () => releaseClosingRow(resize.traceKey, resize.rowKey),
					});
				}
				motionRef.current.begin();
				motionRef.current.push(ops);
			});

			/**
			 * MOTION FLUSH — must stay the LAST of the motion layout effects.
			 *
			 * The fold play, the drill diff and the LOD diff each push their ops into the
			 * current frame rather than starting them. Layout effects within one component run
			 * in DECLARATION order, so declaring this after all three is what makes one
			 * commit's ops start in a single synchronous burst. Move it above any of them and
			 * that effect's contribution lands in the NEXT event (or never), which is silent:
			 * the plans are still produced and only the timing comes apart.
			 *
			 * Pinned by vlist-fold-wiring.test.ts.
			 */
			useLayoutEffect(() => {
				motionRef.current.flush();
			});

			// Live streaming output is the document's LAST ROW, not an overlay.
			//
			// It used to be rendered as a separate block below the canvas to keep
			// high-frequency deltas out of the layout. That trade never paid off: the cost of
			// streaming was re-measuring the growing text (now incremental, see
			// streaming-block-cache.ts), not the rebuild — while the overlay bought a second
			// render path, a second scroll-height source, and a retirement handshake that
			// could clear live output for a reader who had scrolled up.
			//
			// Hand-off is structural: the row retires when the committed document already
			// contains its content, so no timer can drop it while its replacement is missing.
			/**
			 * Generation of THIS mount of the live row, for the streaming fade's store scope.
			 *
			 * A fresh epoch means the animation store cannot warm off the previous visit, so
			 * the first frame after a narrator switch (or any remount) SEALS instead of
			 * re-fading text the reader already watched. Advanced per narrator as well as per
			 * mount, because the shell is deliberately NOT remounted per narrator (see the
			 * cache-clearing effect keyed on `narratorId`) — without the switch case the
			 * scope would stay warm across the very transition this exists for.
			 *
			 * `useState` + an effect rather than a ref assigned during render: minting inside
			 * render runs twice under StrictMode and on any discarded render, so the epoch the
			 * committed tree animates under would not be the one the store was warmed with.
			 */
			const [streamAnimMountEpoch, setStreamAnimMountEpoch] = useState(() => nextStreamAnimEpoch());
			// biome-ignore lint/correctness/useExhaustiveDependencies: a narrator switch is a new mount for the fade
			useEffect(() => {
				setStreamAnimMountEpoch(nextStreamAnimEpoch());
			}, [narratorId]);
			const streamingMsg = useVListStreamingMessage(narratorId, {
				enabled: isActive,
				isSubagent,
				committedMessages: pretextDocument.messages,
			});
			const publishStreamingMessage = pretextDocument.setStreamingMessage;
			useEffect(() => {
				publishStreamingMessage((streamingMsg ?? null) as TreeMessage | null);
			}, [publishStreamingMessage, streamingMsg]);
			// --- Head trim: bound the loaded window in a long session ---
			//
			// A checkpoint can empty the live projection mid-turn. Keep the existing
			// active-session protection: trim only after the narrator becomes idle,
			// never infer turn completion from an empty synthetic row.
			const hadStreamingRowRef = useRef(false);
			const trimHead = pretextDocument.trimHead;
			// Latest-value refs: the effect must not re-run when these change (they change
			// every frame during a turn), it only reads them at the edge it fires on.
			const trimInputsRef = useRef({
				messages: pretextDocument.messages,
				totalHeight: 0,
				pinnedToBottom: true,
				editingMessageId: null as string | null,
				originalModalMessageId: null as string | null,
				selectedMessageIds: [] as string[],
			});
			/** Set by a trim, consumed by the layout effect that sweeps per-row caches. */
			const pendingTrimSweepRef = useRef(false);
			useEffect(() => {
				const hasStreamingRow = streamingMsg != null;
				const edge = resolveStreamingClearedTrimEdge({
					hadStreamingRow: hadStreamingRowRef.current,
					hasStreamingRow,
					isActive,
				});
				hadStreamingRowRef.current = edge.nextHadStreamingRow;
				if (!edge.fire) return;
				const inputs = trimInputsRef.current;
				const decision = resolveHeadTrim({
					messages: inputs.messages as readonly { id?: unknown; seq?: unknown }[],
					totalHeight: inputs.totalHeight,
					viewportHeight: viewportHeightRef.current,
					overscan: ITEM_OVERSCAN,
					pinnedToBottom: inputs.pinnedToBottom,
					hasStreamingRow,
					protectedMessageIds: [
						inputs.editingMessageId,
						inputs.originalModalMessageId,
						...inputs.selectedMessageIds,
					].filter((id): id is string => typeof id === "string" && id.length > 0),
				});
				if (!decision.trim) return;
				if (trimHead(decision.dropCount)) pendingTrimSweepRef.current = true;
			}, [streamingMsg, trimHead, isActive]);
			// Append animation applies to the live row only, and only while output is
			// actually arriving (parity with the classic path's streaming fade-in).
			const animateStreamingRows = isActive && advancedAnim;

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
					resolveSelectedMeta: (selectedIds) =>
						entriesToBlockMeta(selectionIndex.entries, selectedIds),
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
						streamingMsgId: STREAMING_PLACEHOLDER_ID,
						findSpecTasksToolUseId: (messages) =>
							findLatestSpecTasksToolUseId(messages as unknown as NarratorMsg[]),
					}),
				[pretextDocument.messages, pretextDocument.status],
			);

			useEffect(() => {
				onTailMetaChange?.(tailMeta as MessageListTailMeta);
			}, [onTailMetaChange, tailMeta]);
			// Surface a DEFERRED structural reload. While the reader is scrolled up we
			// deliberately withhold the reload (so they are not yanked to the tail), which
			// means the view is knowingly behind — reporting 0 unread there would tell them
			// the opposite.
			//
			// The consumer (NarratorPanel) renders this as a COUNT ("99+" past its cap), the
			// same as the chunked path, so a constant 1 would claim "1 new message" while 50
			// were withheld. The revision delta is the closest count available here: each
			// structural WS event bumps `messageRevision` by exactly one, so the difference
			// from the applied revision is the number of structural events withheld.
			//
			// It is an APPROXIMATION, deliberately: one event can carry more than one message
			// (a reconnect catch-up page), and an edit/delete bumps the revision without
			// adding anything to read. It is right for the common case (one landed message per
			// event) and never reports 0 while the view is behind, which is what the affordance
			// needs. `appliedMessageRevisionRef` is a ref, but the render pass already reads it
			// for `reloadDecision`, so both see the same snapshot.
			// Read the values OUTSIDE the effect: `reloadDecision` is a fresh object every
			// render, so depending on it would re-run this on every render.
			const hasDeferredReload = shouldSurfaceDeferredReload(reloadDecision);
			const deferredUnreadCount = hasDeferredReload
				? Math.max(1, messageRevision - appliedMessageRevisionRef.current)
				: 0;
			useEffect(() => {
				onUnreadCountChange?.(deferredUnreadCount);
			}, [onUnreadCountChange, deferredUnreadCount]);
			useEffect(() => {
				onAtBottomChange?.(pinnedToBottom);
			}, [onAtBottomChange, pinnedToBottom]);

			// Re-runs when the reading-width preference flips so the column width (and the
			// layout keyed on it) is recomputed without a reload.
			//
			// WIDTH is answered through `resolveWidthSettle` rather than written straight to
			// state. A width change re-measures EVERY item (the exact list needs a precise
			// total height), which is O(items) — 102ms at 8000 messages. A pointer drag emits
			// one observer callback per frame, so on a long session every frame would try to
			// spend that. When a measured rebuild proves too slow, the new width is held and
			// committed once the drag settles; the committed geometry keeps painting in the
			// meantime. HEIGHT is unaffected and always applied immediately: it does not
			// change wrapping, so it costs nothing to honour.
			//
			// Depends on `viewportNode` (state), NOT `viewportRef.current`: a ref read at
			// mount time silently outlives the node it read. See the viewportNode comment.
			useLayoutEffect(() => {
				const node = viewportNode;
				if (!node) return;
				let settleTimer: ReturnType<typeof setTimeout> | undefined;
				// Whether a deferral is currently held open, so the pointer-release handler
				// knows if it has anything to commit. Without it every unrelated click in the
				// app would run a decision pass.
				let deferred = false;
				// The last few committed widths, feeding the settle decision's cycle guard.
				//
				// A measurement feedback loop (commit → re-measure → the vertical scrollbar
				// appears or disappears → clientWidth moves ~15px → commit) alternates between
				// exactly two widths and never terminates on its own; the guard recognises that
				// alternation and stops committing. Reset on `gesture-end` because a pointer
				// drag is EXTERNAL input: dragging the sash back to a previous width must apply
				// even if feedback had just pinned it.
				let recentCommittedWidths: readonly number[] = [];
				/**
				 * The viewport's OUTER width at the last commit, so a host-driven resize can be
				 * told apart from scrollbar feedback WITHOUT a pointer gesture.
				 *
				 * A vertical scrollbar moves `clientWidth` and leaves `offsetWidth` alone, so a
				 * changed outer box means something outside this list resized it — a dock panel
				 * toggled from a button, a restored layout, a window resize. That distinction is
				 * what keeps the cycle guard from mistaking repeated panel toggles (which flip
				 * between exactly two widths, the A B A B shape it matches on) for a measurement
				 * loop and pinning the column from the fifth toggle onwards.
				 *
				 * `undefined` until the first commit records one, which reads as "cannot tell"
				 * and leaves the guard in charge.
				 */
				let committedBoxWidth: number | undefined;

				const applyWidth = (trigger: WidthSettleTrigger) => {
					const nextWidth = resolveNarratorColumnWidth(
						node.clientWidth,
						PAGE_PADDING,
						centeredColumn,
					);
					const boxWidth = node.offsetWidth;
					// FIRST MEASUREMENT — commit immediately, bypassing the settle decision.
					//
					// This is not a width CHANGE, it is this list learning how wide it is. Routed
					// through `resolveWidthSettle` it read as an ordinary observer callback with no
					// pointer down, so it DEFERRED for WIDTH_SETTLE_DELAY_MS: the placeholder
					// painted a frame at the sentinel geometry and the column then jumped to its
					// real width 140ms later. That was the first of the mount-time jumps.
					//
					// Running inside the layout effect's synchronous `measure()` means the width is
					// final before the browser paints, so the first painted frame is already
					// correct. `recentCommittedWidths` is deliberately NOT touched: the cycle guard
					// tracks widths that could oscillate, and a first measurement has no prior hop
					// to alternate with.
					if (committedContentWidthRef.current === 0) {
						committedContentWidthRef.current = nextWidth;
						committedBoxWidth = boxWidth;
						setContentWidth(nextWidth);
						return;
					}
					const decision = resolveWidthSettle({
						nextWidth,
						committedWidth: committedContentWidthRef.current,
						trigger,
						// Read LIVE: the gesture may have started or ended between the observer
						// callback that armed the deferral and this evaluation.
						pointerDown: pointerTracker.isDown(),
						recentCommittedWidths,
						boxWidth,
						committedBoxWidth,
					});
					if (settleTimer !== undefined) {
						clearTimeout(settleTimer);
						settleTimer = undefined;
					}
					if (decision.commit) {
						// Release the withheld height with the width, so every commit path (a
						// gesture end, the quiet period, the backstop) lands one consistent
						// geometry instead of leaving a stale height behind.
						if (deferred) setViewportHeight(node.clientHeight);
						deferred = false;
						// EXTERNAL INPUT starts the cycle history over, so a width the guard had
						// pinned can be reached again. Two shapes count, and both must:
						//  - a gesture: the user may be dragging back to a pinned width.
						//  - a resized outer box: a dock panel toggle / window resize / layout
						//    restore, which carries no gesture at all. Without this the ring kept
						//    the panel's two widths forever (`gesture-end` being its only reset),
						//    so repeated toggles filled it and the fifth one pinned the column.
						// Feedback never takes either path: it leaves `offsetWidth` untouched.
						const externalGeometry = isExternalGeometryChange(boxWidth, committedBoxWidth);
						recentCommittedWidths =
							trigger === "gesture-end" || externalGeometry
								? []
								: pushCommittedWidth(recentCommittedWidths, nextWidth);
						committedContentWidthRef.current = nextWidth;
						committedBoxWidth = boxWidth;
						setContentWidth(nextWidth);
						return;
					}
					if (!decision.defer) {
						deferred = false;
						return;
					}
					deferred = true;
					settleTimer = setTimeout(() => {
						settleTimer = undefined;
						applyWidth("timer");
					}, decision.deferForMs);
				};

				// A pointer release is the commit point for a drag-held deferral. Created
				// before the observer so the first callback can already read its state.
				const pointerTracker = createPointerDragTracker(() => {
					// `applyWidth` releases the withheld height as part of its commit branch.
					if (deferred) applyWidth("gesture-end");
				});

				/**
				 * Whether this frame's height write must be withheld.
				 *
				 * True only while a deferral is actually open AND a pointer is down — i.e.
				 * exactly during a drag on an expensive document. A cheap document never
				 * defers, so it keeps its per-frame live height as before; a non-pointer resize
				 * settles on the short quiet period rather than being frozen.
				 */
				const suppressHeightWrite = () => deferred && pointerTracker.isDown();

				const measure = () => {
					// HEIGHT is a React state write, and that is the expensive part — not the
					// arithmetic. A re-render of the shell re-runs `adaptRenderUnits`, which
					// mints fresh `{ spec, measured }` objects, so `ExactRow`'s
					// `prev.item === next.item` fails for EVERY mounted row and their absolutely
					// positioned spans are all rebuilt (measured: 20 prose rows = 1601 DOM
					// nodes, 22.3ms to re-render in linkedom, which has no style/layout/paint —
					// a browser is strictly slower).
					//
					// So while a deferral is in force the height write is suppressed too.
					// Otherwise the width gate would hold back the rebuild while the height
					// write kept re-rendering the same 1601 nodes every frame, which is the
					// jank that survived three rounds of measurement-side fixes.
					//
					// Nothing is lost by waiting: `viewportHeight` state feeds the mounted
					// window, bottom-pinning and the plan cap, and all three are recomputed on
					// the commit. Anything needing the live height mid-drag reads
					// `node.clientHeight` directly (see readCurrentView).
					if (!suppressHeightWrite()) setViewportHeight(node.clientHeight);
					applyWidth("observer");
				};
				measure();
				if (typeof ResizeObserver === "undefined") return () => pointerTracker.dispose();
				const observer = new ResizeObserver(measure);
				observer.observe(node);
				return () => {
					observer.disconnect();
					pointerTracker.dispose();
					if (settleTimer !== undefined) clearTimeout(settleTimer);
				};
			}, [viewportNode, centeredColumn]);

			// Rebuild the copied text from the vlist's own structure instead of letting the
			// browser serialize the absolute-positioned boxes. Every visual line and every
			// blank-strip caret filler is a block-level box, so the native serializer turns
			// soft wraps into hard newlines and paragraph gaps into a doubled newline holding
			// an invisible U+200B. See vlist-copy-text.ts.
			//
			// Keyed on `viewportNode` (state) for the same reason as the effect above: a ref
			// read at mount time outlives the node it read.
			useEffect(() => installVListCopyHandler(viewportNode), [viewportNode]);

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

			// The streaming row now grows `exactLayout.totalHeight` like any other row, so
			// the geometry revision no longer needs a separate tail-height term.
			const scrollGeometryRevision = `${exactLayout?.totalHeight ?? 0}:${footerHeight}:${viewportHeight}`;
			useEffect(() => {
				void scrollGeometryRevision;
				if (!pinnedToBottom || !exactLayout) return;
				const frame = requestAnimationFrame(() => {
					// SNAPS, and must keep snapping. This effect is the catch-all for EVERY
					// geometry change, so most of what reaches it is a document being
					// ESTABLISHED or SETTLING rather than content arriving for a reader who is
					// watching: a fresh load, a narrator switch (restore commits, then the
					// background reload replaces the window), a prepend re-pin, a row reporting
					// its real height after paint, a footer resolving, the viewport resizing.
					//
					// Routing this through the chase is what made a narrator switch scroll DOWN
					// into place: each of those settle steps is a small delta, so it passed the
					// glide gate and animated a journey the reader never took. The list is
					// supposed to OPEN at the bottom.
					//
					// The one thing it must not do is fight a glide the correction path started:
					// an unconditional write here would land at the bottom on the very next
					// frame and cut every streaming glide short. While a chase is active this
					// yields to it — the chase re-reads the live bottom every frame, so the
					// growth this effect is answering is already part of its target.
					if (smoothFollowerRef.current?.isActive() === true) return;
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
				// Cooldown after a head trim. A trim sets `hasPrev` true and shortens the
				// canvas, which is exactly this effect's trigger — so without the cooldown a
				// trim could be answered by an immediate re-fetch, which re-grows the window,
				// which permits the next trim: an endless trim/refetch loop, one request per
				// round. `resolveHeadTrim`'s height factor is the primary guard (survivors must
				// still cover several viewport bands); this covers the case where a rebuild
				// lands a shorter canvas than the average-height estimate predicted.
				//
				// Only the AUTOMATIC fill path is gated. A reader's own upward scroll or the
				// manual button still pages immediately: asking for history must always work.
				const lastTrimAt = getLastTrimAt();
				if (lastTrimAt > 0 && trimClockNow() - lastTrimAt < TRIM_FILL_COOLDOWN_MS) return;
				loadOlder();
			}, [
				exactLayout?.totalHeight,
				getLastTrimAt,
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
				const previousTop = scrollTopRef.current;
				const nextTop = node.scrollTop;
				scrollTopRef.current = nextTop;

				const atBottom = getDistanceFromBottom(node) <= BOTTOM_DISTANCE_EPSILON;
				// The bottom moved away from a pinned reader who never scrolled — a row grew
				// beneath them (the classic case: a pending permission form settling its
				// height after paint). Keeping the pin here is what stops that growth from
				// silently cancelling auto-follow; see isBottomLostToContentGrowth.
				const grewBeneathReader =
					!atBottom && isBottomLostToContentGrowth(pinnedToBottomRef.current, previousTop, nextTop);
				// What the pin actually IS after this frame, which is what the rest of the
				// frame must reason about: reporting the raw `atBottom` while staying pinned
				// would flash the scroll-to-bottom affordance and make the panel count unread
				// messages for a reader who is being followed.
				const effectiveAtBottom = atBottom || grewBeneathReader;
				// Suppress the pinned-state update ONLY for the echo of our own write. A
				// different value means the reader scrolled, and their intent wins immediately
				// (see writeScrollTop / isSuppressedScrollEcho).
				const isEcho = isSuppressedScrollEcho(
					suppressScrollStateRef.current,
					suppressedScrollTopRef.current,
					nextTop,
				);
				// Scrollbar drags and keyboard scrolling have no wheel/touch event to arm
				// the history gate. Record their actual upward travel before testing it.
				if (isUpwardHistoryScroll(previousTop, nextTop, isEcho)) {
					olderHistoryIntentAtRef.current = Date.now();
				}
				if (!isEcho) {
					// The reader moved during our suppression window: close it so nothing else
					// in this frame treats their scrolling as programmatic.
					suppressScrollStateRef.current = false;
					suppressedScrollTopRef.current = null;
					if (pinnedToBottomRef.current !== effectiveAtBottom) {
						// Losing the pin to a real upward gesture also kills any chase in
						// flight — otherwise its next frame writes again and drags the reader
						// back down (the chase only ever runs while pinned).
						if (!effectiveAtBottom) getSmoothFollower().cancel();
						pinnedToBottomRef.current = effectiveAtBottom;
						setPinnedToBottom(effectiveAtBottom);
					}
				}
				// Re-glue in THIS frame rather than leaving it to the geometry-revision pin
				// effect. That effect is keyed on `exactLayout.totalHeight`, which only moves
				// once a reported height lands in `heightOverrides` — a report inside the 1px
				// jitter guard, or one for a row that is no longer on the dynamic path, grows
				// the real DOM box without changing the layout, so the effect would never run
				// and the view would sit a form's height short of the bottom.
				//
				// SNAPS, for the same reason as the pin effect above: what reaches here is a
				// row SETTLING its post-paint height (a permission form's textarea, an image,
				// a reflection notice), not content arriving. Gliding those animated the list
				// during mount/settle, which is how a narrator switch ended up scrolling down
				// into place. Yields to an active chase so it cannot cut a streaming glide
				// short (the chase's live target already covers this growth).
				if (grewBeneathReader && smoothFollowerRef.current?.isActive() !== true) {
					writeScrollTop(getScrollBottomTarget(node));
				}
				if (effectiveAtBottom) onUnreadCountChange?.(0);
				onAtBottomChange?.(effectiveAtBottom);
				maybeAutoLoadOlder(nextTop, effectiveAtBottom);

				// Advance scrollTop state only when it changes the mounted window; this is
				// the sole re-render trigger for scrolling.
				//
				// Read back from the ref rather than reusing `nextTop`: the re-glue above may
				// have moved the position, and the window must be resolved for where the
				// viewport now IS (a stale value would mount the band the reader just left).
				const settledTop = scrollTopRef.current;
				const layout = exactLayoutRef.current;
				if (!layout) return;
				const nextWindow = resolveVisibleWindow(layout, settledTop, viewportHeight, ITEM_OVERSCAN);
				const cur = visibleRef.current;
				if (nextWindow.start !== cur.start || nextWindow.end !== cur.end) {
					setScrollTop(settledTop);
				}
			}, [
				maybeAutoLoadOlder,
				onAtBottomChange,
				onUnreadCountChange,
				viewportHeight,
				getSmoothFollower,
				writeScrollTop,
			]);

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
					// An explicit jump-to-bottom lands where it was told to, instantly — a
					// chase drifting in afterwards would fight the write.
					getSmoothFollower().cancel();
					pinnedToBottomRef.current = true;
					setPinnedToBottom(true);
					if (instant) writeScrollTop(getScrollBottomTarget(viewportRef.current));
					else
						requestAnimationFrame(() => writeScrollTop(getScrollBottomTarget(viewportRef.current)));
				},
				[getSmoothFollower, writeScrollTop],
			);
			const detachFromBottom = useCallback(() => {
				// Reader intent (wheel-up): the chase must die with the pin, or its next
				// frame re-writes scrollTop and pulls the reader back down.
				getSmoothFollower().cancel();
				pinnedToBottomRef.current = false;
				setPinnedToBottom(false);
			}, [getSmoothFollower]);

			// Quick index of user turns beside the scrollbar (parity with the chunked
			// path's ScrollbarUserMarkers). Positions come from the exact layout's real
			// document offsets rather than a seq ordinal, so a mark lands on the turn it
			// points at regardless of how much output surrounds it.
			//
			// The fractions are taken against the FULL scrollable height (canvas + tail
			// footer) so the track shares the scrollbar's coordinate system.
			const scrollableHeight = (exactLayout?.totalHeight ?? 0) + footerHeight;
			const userMarkers = useMemo(
				() => collectVListUserMarkers(renderItems, exactLayout?.items ?? [], scrollableHeight),
				[renderItems, exactLayout?.items, scrollableHeight],
			);
			// Compact indicators ride the same track: a failed compact stays visible
			// (red) even when the reader has scrolled far away from the marker row.
			const compactMarkers = useMemo(
				() => collectVListCompactMarkers(renderItems, exactLayout?.items ?? [], scrollableHeight),
				[renderItems, exactLayout?.items, scrollableHeight],
			);
			const handleUserMarkerJump = useCallback(
				(marker: VListUserMarker) => {
					// A jump is an explicit reading action: unpin so streaming output cannot
					// immediately pull the reader back to the tail.
					getSmoothFollower().cancel();
					pinnedToBottomRef.current = false;
					setPinnedToBottom(false);
					writeScrollTop(resolveVListUserMarkerScrollTop(marker.top, VLIST_USER_MARKER_JUMP_LEAD));
				},
				[getSmoothFollower, writeScrollTop],
			);
			const handleCompactMarkerJump = useCallback(
				(marker: VListCompactMarker) => {
					getSmoothFollower().cancel();
					pinnedToBottomRef.current = false;
					setPinnedToBottom(false);
					writeScrollTop(resolveVListUserMarkerScrollTop(marker.top, VLIST_USER_MARKER_JUMP_LEAD));
				},
				[getSmoothFollower, writeScrollTop],
			);
			const resolveUserMarkerLabel = useCallback(
				(ordinal: number) =>
					t("jumpToUserMessage", { ordinal, defaultValue: `Jump to message #${ordinal}` }),
				[t],
			);
			const resolveCompactMarkerLabel = useCallback(
				(marker: VListCompactMarker) =>
					t("jumpToCompactMarker", {
						status: marker.tooltip,
						defaultValue: "Jump to compact marker",
					}),
				[t],
			);

			const onLodStepRef = useRef(onLodStep);
			onLodStepRef.current = onLodStep;
			useEffect(() => {
				const node = viewportRef.current;
				if (!node) return;
				const throttle = createLodStepThrottle();
				let pinchActive = false;
				let pinchBaseline = 0;
				// Remember WHERE the gesture is pointing before the level changes, so the
				// rebuild (one commit later, via readCurrentView → captureCoordinatorAnchor)
				// re-anchors that point instead of the viewport top. Stored screen-relative
				// to this scroll container; the document offset is derived at rebuild time.
				const emit = (dir: 1 | -1, clientY: number | null) => {
					const now = Date.now();
					if (!throttle.tryStep(now)) return;
					// The LOD morph diffs viewport geometry across the level switch; a chase
					// still gliding through the rebuild would move rows under the morph.
					smoothFollowerRef.current?.snapToTarget();
					lodFocusRef.current =
						clientY == null
							? null
							: createLodFocusPoint(clientY, node.getBoundingClientRect().top, now);
					onLodStepRef.current?.(dir);
				};
				// Record an upward gesture so the scroll handler's auto-load gate may fire
				// when it reaches the top. Intent expires (chunk-list parity) so momentum
				// alone never keeps paging.
				const markUpwardIntent = () => {
					olderHistoryIntentAtRef.current = Date.now();
				};
				const onWheel = (event: WheelEvent) => {
					const dir = resolveWheelLodStep(event, lodAltGesture);
					if (dir === null) {
						if (event.deltaY < 0) {
							detachFromBottom();
							markUpwardIntent();
						}
						return;
					}
					event.preventDefault();
					emit(dir, event.clientY);
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
					// The pinch CENTER is the gesture's focus, the same point a map keeps fixed
					// while zooming.
					emit(dir, pinchCenterY(Array.from(event.touches)));
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
			}, [detachFromBottom, lodAltGesture]);

			const scrollToMessageTarget = useCallback(
				async ({
					domIds,
					targetIds,
					highlightId,
				}: {
					domIds: string[];
					targetIds: string[];
					highlightId?: string;
				}) => {
					// One jump at a time. A second jump (another search hit clicked while the
					// first is still paging through history) invalidates the first, which must
					// then stop scrolling and stop paging rather than fight the new target.
					const token = ++jumpTokenRef.current;
					const cancelled = () => token !== jumpTokenRef.current;
					// A jump navigates AWAY from the bottom: any chase still gliding towards
					// it would fight the reveal's scrollIntoView / layout writes.
					getSmoothFollower().cancel();
					// The row that was actually revealed, so the flash lands on the node the
					// reader is now looking at rather than on a guessed id. Unlike the chunked
					// path — which arms a 400ms timer and hopes the scroll finished — the flash
					// is driven by the reveal itself, so it can never fire on a failed jump or
					// on a row that has since scrolled away.
					const revealMounted = () => {
						const node = viewportRef.current;
						if (!node) return false;
						const element = mountedJumpTarget(node, domIds, targetIds);
						if (!element) return false;
						pinnedToBottomRef.current = false;
						setPinnedToBottom(false);
						// Restrict the reveal to this list, including repeated jumps to a mounted
						// row. Native scrollIntoView can also scroll the panel/page ancestors.
						writeScrollTop(jumpTargetScrollTop(node, element));
						// Highlight the exact tool row, not its message's earlier text/alias.
						if (highlightId) highlightRef.current.flash(element);
						return true;
					};
					// Scroll to a message that HAS a layout item, then let the mounted-window
					// recomputation (one frame) produce the node the flash needs.
					const revealByLayout = async (messageIds: readonly string[]) => {
						for (const messageId of messageIds) {
							if (!messageId) continue;
							const index = pretextDocumentRef.current.readWindow().index;
							const node = viewportRef.current;
							if (!index || !node) return false;
							const itemIndex = jumpTargetItemIndex(index, messageId);
							if (itemIndex == null) continue;
							const targetTop = index.itemStart(itemIndex) - Math.max(0, node.clientHeight / 2);
							pinnedToBottomRef.current = false;
							setPinnedToBottom(false);
							writeScrollTop(targetTop);
							await waitAnimationFrame();
							if (cancelled()) return false;
							if (revealMounted()) return true;
						}
						return false;
					};
					if (revealMounted()) return true;
					const localIds = targetIds.map(messageIdFromTarget);
					if (await revealByLayout(localIds)) return true;
					if (cancelled()) return false;

					// Not in the loaded window.
					//
					// The exact list loads the newest page and extends UPWARD only, so a search
					// hit / deep link older than the loaded window has no layout item and no DOM
					// node — the case that used to make the jump silently do nothing. Resolve the
					// target's seq on the server, then page older until the window covers it.
					const resolved = await resolveJumpTargetSeq(targetIds, {
						fetchMessageLocation: (messageId) =>
							narratorsApi.getMessageLocation(narratorId, messageId),
						fetchToolMessage: async (toolUseId) => {
							const detail = await narratorsApi.getToolCallDetail(narratorId, toolUseId);
							return {
								messageId: typeof detail?.messageId === "string" ? detail.messageId : undefined,
							};
						},
					});
					if (!resolved || cancelled()) return false;
					// The top-level message that RENDERS the target may be an ancestor (a
					// message inside a subagent tree), so try it too when locating the row.
					const revealIds = resolved.topLevelMessageId
						? [...localIds, resolved.topLevelMessageId]
						: localIds;

					for (let expansions = 0; ; expansions++) {
						const loaded = pretextDocumentRef.current.readWindow();
						const decision = resolveJumpWindowDecision({
							targetSeq: resolved.seq,
							oldestLoadedSeq: loaded.oldestLoadedSeq,
							hasPrev: loaded.hasPrev,
							expansions,
						});
						if (decision.kind === "in-window") break;
						if (decision.kind === "unreachable") {
							// Say so rather than looking broken: the reader clicked a result and
							// nothing moved, and the two reasons (history genuinely does not contain
							// it / this jump hit its page budget) are both worth distinguishing from
							// a frozen UI.
							notifications.show({
								color: "yellow",
								message:
									decision.reason === "budget-exhausted"
										? t("jumpTargetTooFar")
										: t("jumpTargetUnavailable"),
							});
							return false;
						}
						// Paging upward while pinned to the bottom would re-snap the canvas to the
						// tail on every commit (commitPrependLayout's pinned branch), fighting the
						// jump. A jump is an explicit reading action, so unpin first.
						pinnedToBottomRef.current = false;
						setPinnedToBottom(false);
						const added = await loadOlderAsyncRef.current().catch(() => 0);
						if (cancelled()) return false;
						// A page that prepended nothing while still claiming `hasPrev` would spin
						// this loop against an unchanged window; treat it as the end of history.
						if (added <= 0 && pretextDocumentRef.current.readWindow().hasPrev) {
							notifications.show({ color: "yellow", message: t("jumpTargetUnavailable") });
							return false;
						}
					}
					// The window now covers the target; wait for the layout commit the last page
					// produced before reading item offsets from it.
					await waitAnimationFrame();
					if (cancelled()) return false;
					return revealByLayout(revealIds);
				},
				[narratorId, t, getSmoothFollower, writeScrollTop],
			);

			// UI-driven LOD changes (the indicator's notches / steppers) never pass through
			// the wheel/pinch handlers, so they publish their focus point here instead —
			// same field the gesture writes, same TTL, so the rebuild path is identical.
			const prepareLodChange = useCallback((clientY: number) => {
				const node = viewportRef.current;
				if (!node) return;
				// Same landing the gesture path does: the morph diffs viewport geometry
				// across the switch and a gliding chase would move rows under it.
				// snapToTarget stops the chase AND settles the residual in one write.
				smoothFollowerRef.current?.snapToTarget();
				lodFocusRef.current = createLodFocusPoint(
					clientY,
					node.getBoundingClientRect().top,
					Date.now(),
				);
			}, []);

			useImperativeHandle(
				ref,
				(): MessageListHandle => ({
					scrollToBottom,
					refreshStructure: () => pretextDocument.reload(),
					detachFromBottom,
					scrollToMessageTarget,
					prepareLodChange,
				}),
				[
					detachFromBottom,
					pretextDocument.reload,
					prepareLodChange,
					scrollToBottom,
					scrollToMessageTarget,
				],
			);

			// Deep-link / search jump: once per (narrator, target, request). A new request
			// repeats the jump without remounting the panel or discarding loaded history.
			// Wait for a READY document; missing history is paged by the jump itself.
			// Latch each attempt so intermediate rebuilds do not duplicate fetches/notices.
			const jumpedHighlightRef = useRef<string | null>(null);
			const documentReady = pretextDocument.status === "ready";
			useEffect(() => {
				if (!highlightMessageId) {
					jumpedHighlightRef.current = null;
					return;
				}
				if (!documentReady) return;
				const key = JSON.stringify([narratorId, highlightMessageId, highlightRequestId]);
				if (jumpedHighlightRef.current === key) return;
				// Latch BEFORE awaiting: a failed deep-link jump has already told the reader
				// why (the notice inside scrollToMessageTarget), and re-running it on the next
				// commit would repeat both the fetch and the notice.
				jumpedHighlightRef.current = key;
				void scrollToMessageTarget({
					domIds: [`msg-${highlightMessageId}`],
					targetIds: [highlightMessageId],
					highlightId: highlightMessageId,
				});
			}, [
				documentReady,
				highlightMessageId,
				highlightRequestId,
				narratorId,
				scrollToMessageTarget,
			]);

			// A flash outlives its row's mount (the reader can scroll away mid-animation),
			// so the controller is stopped explicitly on unmount.
			useEffect(() => {
				const controller = highlightRef.current;
				return () => controller.cancel();
			}, []);

			const manifestItems = pretextDocument.manifest?.items ?? [];
			const hasRenderableLayout = hasRenderableExactLayout(
				pretextDocument.index,
				renderItems.length,
				manifestItems.length,
			);

			// Sweep per-row handler caches after a trim, keyed off the POST-trim manifest.
			//
			// Expressed as "keep what is still in the manifest" rather than "delete the
			// dropped rows' keys": spec keys are derived and take several shapes
			// (`tool-<id>`, `<msgId>-b3`, `activity-t:<toolUseId>`, `toolrun-summary-…`), so
			// reconstructing them from message ids would duplicate that derivation and drift
			// from it. Same direction pruneHeightOverrides takes. Without this, each trimmed
			// row leaves a dead closure behind for the rest of the session — the very growth
			// the trim exists to stop.
			useEffect(() => {
				if (!pendingTrimSweepRef.current) return;
				pendingTrimSweepRef.current = false;
				const liveKeys = new Set(manifestItems.map((item) => item.itemKey));
				retainKeysInPlace(
					[
						unknownHeightReporterCacheRef.current,
						togglesCacheRef.current,
						reflectionTakeOverCacheRef.current,
					],
					liveKeys,
				);
			}, [manifestItems]);

			// Decorative grouping frames for consecutive in-run tool/subagent card runs.
			// Rebuilt only when the document items change (not on scroll); drawn as
			// absolute overlays under the rows so the grouped run reads as one container.
			const toolRunFrames = useMemo(() => computeToolRunFrames(renderItems), [renderItems]);
			// Read by the fold capture and its play effect, both of which run outside render.
			toolRunFramesRef.current = toolRunFrames;

			// The one row whose Dynamic Spec task state may ANIMATE.
			//
			// A task's `doing` is a recorded status, so animating on it alone set every task
			// bubble in the scrollback spinning at once (see vlist-spec-task-live). Only the
			// newest task surface of a RUNNING narrator is live; a settled session has none.
			//
			// Two identities because the two surfaces are addressed differently: an injection
			// bubble by its spec key (the last spec-task bubble in the document) and a task
			// board by its tool-use id — the same pin the fold exemption already derives, so
			// the spinner and the pinned card can never name different calls.
			const specTaskLiveGate = useMemo(
				() => resolveSpecTaskLiveGate(renderItems, isActive, tailMeta.latestSpecTasksToolUseId),
				[renderItems, isActive, tailMeta.latestSpecTasksToolUseId],
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

			// Full messages by id — the inline editor and the original-content modal need
			// the raw payload (contentJson / creator / narratorId / editedAt), which the
			// measured layout spec deliberately drops.
			const messagesById = useMemo(() => {
				const map = new Map<string, TreeMessage>();
				for (const msg of pretextDocument.messages) {
					if (typeof msg.id === "string" && msg.id) map.set(msg.id, msg);
				}
				return map;
			}, [pretextDocument.messages]);
			const messagesByIdRef = useRef(messagesById);
			messagesByIdRef.current = messagesById;

			// Feed the head-trim evaluator (see the effect near publishStreamingMessage).
			// Assigned during render rather than listed as effect deps on purpose: every one
			// of these changes on most frames of a live turn, and the trim must run only at
			// the streaming-cleared edge, not whenever its inputs move.
			//
			// An active selection protects its messages: dropping a row mid-selection would
			// leave the toolbar acting on ids the document no longer holds.
			const messageSelection = useMessageSelection();
			const selectedMessageIds = useMemo(() => {
				if (!selectionIndex || messageSelection.selectedBlockIds.size === 0) return [];
				return entriesToMessageIds(selectionIndex.entries, messageSelection.selectedBlockIds);
			}, [selectionIndex, messageSelection.selectedBlockIds]);
			trimInputsRef.current = {
				messages: pretextDocument.messages,
				totalHeight: exactLayout?.totalHeight ?? 0,
				pinnedToBottom,
				editingMessageId: editingRow?.messageId ?? null,
				originalModalMessageId,
				selectedMessageIds,
			};

			// Enter inline edit mode. Reads the message at click time (through the ref) so
			// the callback identity stays stable across document rebuilds. A message too
			// large to edit safely is refused with the same notice as the chunked path.
			const openEditor = useCallback(
				(key: string, messageId: string, role: VListEditRole) => {
					const msg = messagesByIdRef.current.get(messageId);
					if (!msg) return;
					const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
					const preview = resolveEditorInitialText(blocks, role);
					if (preview.truncated) {
						notifications.show({ color: "yellow", message: t("editMessageTooLarge") });
						return;
					}
					setEditingRow({ key, messageId, role, initialText: preview.text });
				},
				[t],
			);
			const closeEditor = useCallback(() => setEditingRow(null), []);

			// The edited message may disappear (narrator switch, structural reload, delete)
			// while its editor is open; drop the stale editing row rather than rendering an
			// editor for a message that no longer exists.
			useEffect(() => {
				if (editingRow && !messagesById.has(editingRow.messageId)) setEditingRow(null);
			}, [editingRow, messagesById]);
			useEffect(() => {
				if (originalModalMessageId && !messagesById.has(originalModalMessageId)) {
					setOriginalModalMessageId(null);
				}
			}, [originalModalMessageId, messagesById]);

			// Per-key interaction payloads (swipe/context menu + selection). Rebuilt only
			// when the selection index, the rendered items, or the panel handlers change
			// — never on scroll — so each row's payload stays referentially stable and
			// the ExactRow memo keeps skipping unchanged rows. Rows without a single-block
			// target (aggregates / non-interactive chrome) are absent and render plainly.
			// Payload REUSE across rebuilds. See vlist-row-payload-reuse.ts: `renderItems`
			// is a fresh array on every commit — including the one each streaming delta
			// produces — so without this every mounted row's `interaction` prop changed
			// identity per frame and the whole window re-rendered while a turn streamed.
			//
			// Tool facts the layout spec deliberately drops (child narrator id, file path,
			// background state), keyed by toolUseId — a tool/subagent row's blockId is
			// `tc-`/`sa-` + that id. ONE index shared by every per-row consumer: the
			// element interactions below, the trace-row interaction slot, and the
			// drilled-in card's action bindings.
			const interactionReuseRef = useRef<RowPayloadReuseState<RowInteraction> | null>(null);
			const interactionsByKey = useMemo(() => {
				// Indices are inputs to the per-row projection, not captured by its actions.
				// Rebuilding them for one message must not evict every historical payload.
				const generation = [narratorId, openEditor, ...rowActionHandlerDependencies(rowHandlers)];
				const previous = beginRowPayloadFrame(interactionReuseRef.current, generation);
				const map = new Map<string, RowInteraction>();
				if (!selectionIndex) {
					commitRowPayloadFrame(interactionReuseRef, generation, map);
					return map;
				}
				const manifestByKey = new Map(manifestItems.map((m) => [m.itemKey, m]));
				// The shared per-document index (built above) — never rebuilt per memo.
				const toolMetaIndex = rowToolMetaIndex;
				const handlers = rowHandlers ?? {};
				// Editing capabilities mirror the chunked path's ctxActions gating: the
				// user flow needs onEditAndRegenerate, the assistant flow needs
				// onEditAssistantMessage plus an editable text block.
				const canEditUser = !!handlers.onEditAndRegenerate;
				const canEditAssistant = !!handlers.onEditAssistantMessage;
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
					// Editable rows: a user bubble (whole message) or an assistant markdown
					// body (its text). The edit handler is the SHELL's own — it opens the
					// inline editor for this row rather than calling the API directly.
					const msg = messagesById.get(messageId);
					const editTarget = resolveVListEditTarget(
						item.spec.kind,
						(item.spec.data as { role?: unknown } | null)?.role as string | undefined,
						messageId,
						{
							canEditUser,
							canEditAssistant,
							hasEditableText: hasEditableTextBlock(msg?.contentJson),
						},
					);
					const specKey = item.spec.key;
					const queued = handlers.resolveQueuedMessage?.(messageId);
					const actions = buildRowCtxActions(
						{ messageId, blockIndex, blockIndices, editable: !!editTarget, queued },
						editTarget
							? {
									...handlers,
									onEditMessage: (id) => openEditor(specKey, id, editTarget.role),
								}
							: handlers,
					);
					// Tool / subagent rows carry the card-specific command items.
					const toolUseId = toolUseIdFromBlockId(target.blockId);
					const toolMeta = toolUseId ? toolMetaIndex.get(toolUseId) : undefined;
					const toolActions = toolMeta ? buildRowToolActions(toolMeta, handlers) : undefined;
					// An edited message offers "view original"; the modal is a single
					// shell-level instance, so the row only carries the open callback.
					const editedMeta = resolveVListEditedMeta(msg);
					// An injection bubble speaks FOR somebody; its spec carries the verbatim
					// model-facing copy (`modelFacing`) plus the speaker/source label, which the
					// inspector shows so the reader can audit what the agent actually received.
					const injectionData =
						item.spec.kind === "injection-bubble"
							? (item.spec.data as {
									modelFacing?: unknown;
									speaker?: unknown;
									source?: unknown;
								} | null)
							: null;
					const modelFacing =
						typeof injectionData?.modelFacing === "string" ? injectionData.modelFacing : "";
					const inspectContent =
						modelFacing.trim().length > 0
							? {
									text: modelFacing,
									title:
										(typeof injectionData?.speaker === "string" && injectionData.speaker.trim()) ||
										(typeof injectionData?.source === "string" && injectionData.source) ||
										"injection",
								}
							: undefined;
					const next: RowInteraction = {
						blockId: target.blockId,
						messageId,
						blockIndex,
						blockIndices,
						copyText,
						actions,
						editRole: editTarget?.role,
						queuedActions: queued ? { ...queued } : undefined,
						toolUseId,
						toolDetailRef: toolUseId
							? toolDetailRequestFromData(toolUseId, item.spec.data)
							: undefined,
						toolMeta,
						toolActions,
						...(editedMeta ? { onViewOriginal: () => setOriginalModalMessageId(messageId) } : {}),
						...(inspectContent ? { inspectContent } : {}),
					};
					map.set(
						item.spec.key,
						reuseRowPayload(previous, item.spec.key, next, sameRowInteraction),
					);
				}
				commitRowPayloadFrame(interactionReuseRef, generation, map);
				return map;
				// `pretextDocument.messages` is no longer listed: the tool facts it fed are
				// read through `rowToolMetaIndex`, which is memoized on that same array —
				// so it already re-keys this memo when the document changes.
			}, [
				narratorId,
				selectionIndex,
				renderItems,
				manifestItems,
				rowHandlers,
				rowToolMetaIndex,
				messagesById,
				openEditor,
			]);

			// System cards (compact markers included) carry no `-b{n}` suffix in their spec
			// key, so their owning message comes from the manifest's source ids. Indexed
			// once here because the compact bridge resolves markers by spec key.
			const sourceIdsByKey = useMemo(() => {
				const map = new Map<string, readonly string[]>();
				for (const manifestItem of manifestItems) {
					map.set(manifestItem.itemKey, manifestItem.sourceMessageIds);
				}
				return map;
			}, [manifestItems]);

			// Compact-marker interactions (open summary / cancel a running compaction) —
			// the vlist parity of the chunked CompactIndicator's own click handling. The
			// dialog is one shell-level instance; rows only carry the bound callbacks.
			const compact = useVListCompactActions({ narratorId, renderItems, sourceIdsByKey });

			// List-owned drafts/actions survive virtual row unmounts. Rows receive only
			// controlled form props; their geometry remains entirely precomputed.
			const askInPassing = useVListAskInPassing({
				narratorId,
				renderItems,
				sourceIdsByKey,
				messages: pretextDocument.messages,
			});
			forgetAskInPassingRef.current = askInPassing.forget;

			// HTTP acknowledgements and WS projections use the same idempotent
			// document paths. An acknowledgement must not wait for tail reload.
			useEffect(
				() =>
					subscribeAskInPassingEvents((event) => {
						if (event.narratorId !== narratorId) return;
						if (event.kind === "deleted") removeOrReload([event.messageId]);
						else upsertOrReload(event.message);
					}),
				[narratorId, upsertOrReload, removeOrReload],
			);

			// Each trace group owns only its projected row bindings. Rebuilding a
			// document index must not replace callbacks belonging to unchanged groups.
			const traceBindingsByKey = useVListTraceBindings({
				narratorId,
				renderItems,
				selectionIndex,
				rowToolMetaIndex,
				rowHandlers,
			});

			// Item index of the row being edited, so it can be pinned into the mounted
			// window. -1 → not in the loaded document (nothing to pin).
			const editingRowIndex = useMemo(() => {
				if (!editingRow) return null;
				const index = renderItems.findIndex((item) => item?.spec.key === editingRow.key);
				return index >= 0 ? index : null;
			}, [editingRow, renderItems]);

			/**
			 * The row holding the touch swipe ANCHOR, so it too can be pinned.
			 *
			 * Touch range-selection spans two gestures: the first left-swipe reveals a row's
			 * menu and registers it as the anchor, a left-swipe on another row then selects
			 * everything between them. `useSwipeMenu` keeps that anchor (and its close
			 * handler) alive only while the anchor's hook is MOUNTED — so in a virtualized
			 * list scrolling the anchor past the overscan band unmounted it, silently
			 * dropping the anchor and turning the second swipe into "open my own menu".
			 *
			 * Read through `useSyncExternalStore` because the anchor lives in a module-level
			 * store that `useSwipeMenu` writes from a touch handler; without a subscription
			 * this list would never re-render to pin the row. `null` for every non-touch
			 * session, where the store is never written at all.
			 */
			const swipeAnchorBlockId = useSyncExternalStore(
				subscribeGlobalSwipeAnchor,
				getGlobalSwipeAnchor,
				// SSR / hydration: no gesture can be in flight before the first paint.
				() => null,
			);
			const swipeAnchorRowIndex = useMemo(() => {
				// Scanning the document is gated on an anchor EXISTING, so a plain read /
				// desktop session never walks the list at all.
				if (!swipeAnchorBlockId) return null;
				return resolveSwipeAnchorRowIndex(swipeAnchorBlockId, renderItems.length, (index) => {
					const item = renderItems[index];
					if (!item) return null;
					return rowSelectionBlockIds(item, interactionsByKey.get(item.spec.key)?.blockId);
				});
			}, [swipeAnchorBlockId, renderItems, interactionsByKey]);

			/** Mount the shared editor for the row currently in edit mode. */
			const renderEditorSlot = useCallback(
				(row: NonNullable<typeof editingRow>): ReactNode => {
					const msg = messagesById.get(row.messageId);
					if (!msg) return null;
					const handlers = rowHandlers ?? {};
					return (
						<Suspense fallback={null}>
							<MessageEditorPanel
								messageRole={row.role}
								narratorId={narratorId}
								messageId={row.messageId}
								imageNarratorId={msg.narratorId ?? narratorId}
								blocks={Array.isArray(msg.contentJson) ? msg.contentJson : []}
								creator={msg.creator ?? null}
								initialText={row.initialText}
								isLastUserMessage={row.messageId === tailMeta.lastUserMessageId}
								hasChapter={hasChapter}
								onEditAndRegenerate={handlers.onEditAndRegenerate}
								onEditAssistantMessage={handlers.onEditAssistantMessage}
								onClose={closeEditor}
							/>
						</Suspense>
					);
				},
				[
					messagesById,
					rowHandlers,
					narratorId,
					tailMeta.lastUserMessageId,
					hasChapter,
					closeEditor,
				],
			);

			const originalModalMessage = originalModalMessageId
				? messagesById.get(originalModalMessageId)
				: undefined;
			const originalModalEdited = resolveVListEditedMeta(originalModalMessage);
			const onRestoreAssistantMessage = rowHandlers?.onRestoreAssistantMessage;

			/**
			 * What an injection bubble's speaker row can open on this host.
			 *
			 * Assembled here (not per row) and memoized, because the row memo compares this by
			 * identity: rebuilding it every render would defeat the comparison and repaint every
			 * mounted injection row on each commit.
			 *
			 * Each opener is passed through only if the host supplied it, so a surface that
			 * cannot reach a destination leaves those rows inert instead of offering a dead
			 * control.
			 */
			const injectionNavigation = useMemo<InjectionNavigation>(
				() => ({
					onOpenNarrator: rowHandlers?.onViewSubagentSession,
					onOpenKnowledge: rowHandlers?.onOpenKnowledgeEntry,
					onOpenSpec: rowHandlers?.onOpenSpecFile,
					onOpenChapter: rowHandlers?.onOpenChapter,
					labels: injectionTargetLabels,
				}),
				[
					rowHandlers?.onViewSubagentSession,
					rowHandlers?.onOpenKnowledgeEntry,
					rowHandlers?.onOpenSpecFile,
					rowHandlers?.onOpenChapter,
					injectionTargetLabels,
				],
			);

			return (
				<div
					ref={assignViewport}
					onScroll={onScroll}
					style={{
						position: "relative",
						height: "100%",
						overflow: "auto",
						// Reserve the vertical scrollbar's track from the very first frame.
						//
						// Without it, `clientWidth` drops ~15px the moment the loaded document
						// becomes taller than the viewport, so the column was measured once
						// without a scrollbar and again with one — the last of the mount-time
						// width jumps. It also removes the (commit → re-measure → scrollbar
						// toggles → width changes again) feedback pair at its source, leaving
						// `isWidthFeedbackCycle` as a pure backstop instead of a routine path.
						//
						// `stable`, not `both-edges`: a session that stays shorter than the
						// viewport pays a constant ~15px (under 2% of the reading cap, and
						// exactly the width it takes on as soon as it grows), whereas
						// `both-edges` costs ~30px to buy back a fixed ~7.5px of horizontal
						// centering that has no reference point to be noticed against. Overlay
						// scrollbars (macOS) reserve nothing either way.
						scrollbarGutter: "stable",
						// This list owns its scroll position: every geometry change is answered
						// with an explicit anchored write (captureCoordinatorAnchor →
						// restorePretextLayoutAnchor → writeScrollTop). The browser's own scroll
						// anchoring would silently adjust scrollTop for the same size changes,
						// competing with those writes — and the streaming row grows every frame,
						// which is exactly when the two would fight.
						overflowAnchor: "none",
					}}
					data-pretext-exact-message-list
				>
					{/* User-turn quick index, pinned to the viewport's right edge. A zero-height
			    sticky box, so it indexes the document without adding to it. Placed
			    BEFORE the canvas so its marks paint above the rows. */}
					<VListUserMarkers
						markers={userMarkers}
						compactMarkers={compactMarkers}
						documentHeight={scrollableHeight}
						trackHeight={viewportHeight}
						onJump={handleUserMarkerJump}
						onJumpCompact={handleCompactMarkerJump}
						viewportRef={viewportRef}
						resolveLabel={resolveUserMarkerLabel}
						resolveCompactLabel={resolveCompactMarkerLabel}
					/>
					{/* Full width on purpose: each row centers its own `contentWidth` column
			    instead of relying on a narrow, centered parent. A centered parent
			    left the space beside it as bare scroll container with no in-flow
			    line box, and a drag-selection passing over it snapped the selection
			    focus back to the top of the history (same root cause as the
			    inter-row gaps — see resolveRowHitHeight). */}
					<div ref={assignContent} style={{ position: "relative", width: "100%" }}>
						{hasRenderableLayout && exactLayout ? (
							<div
								style={{
									position: "relative",
									height: exactLayout.totalHeight,
									overflow: "hidden",
								}}
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
											key={run.key}
											// Addressable so the fold transition can animate this border in step
											// with the cards it wraps. A data attribute, like data-nf-row-key:
											// it cannot affect layout and never reaches spec.opts (the measure
											// cache key).
											data-tool-run-frame={run.key}
											style={{
												position: "absolute",
												top: topGeom.top,
												// The canvas is full width now, so the decorative frame centers
												// itself on the same column the rows draw into.
												left: "50%",
												marginLeft: -contentWidth / 2,
												width: contentWidth,
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
								{[
									...range(visible.start, visible.end),
									// Rows that must survive scrolling out of the window. Merged (not
									// spread back to back) because the two reasons can name the SAME
									// index — the reader may swipe the row they are editing — and that
									// would mint two children under one key.
									...mergePinnedRowIndices(
										// The row being edited: unmounting would destroy the draft.
										resolvePinnedRowIndices(visible, editingRowIndex),
										// The swipe anchor's row: unmounting drops the anchor and its
										// close handler, which is what silently broke touch
										// range-selection once the first swiped row scrolled away.
										resolvePinnedRowIndices(visible, swipeAnchorRowIndex),
									),
								].map((itemIndex) => {
									const item = renderItems[itemIndex];
									const geometry = exactLayout.items[itemIndex];
									const manifestItem = manifestItems[itemIndex];
									if (!item || !geometry || !manifestItem) return null;
									const sourceIds = sourceIdsForItem(item, manifestItem);
									const itemId = domIdForItem(item, sourceIds);
									const traceBinding = traceBindingsByKey.get(item.spec.key);
									const permissionSlot = permissionSlotByKey.get(item.spec.key);
									const editorSlot =
										editingRow?.key === item.spec.key ? renderEditorSlot(editingRow) : undefined;
									const askInPassingPending = askInPassing.pendingByKey.get(item.spec.key);
									// Must agree with `dynamicRowKeys` above: that set gates which keys may
									// HOLD an override, this decides which rows get a reporter and the
									// unclipped box. A row in one but not the other is either clipped with
									// no way to report, or reports into a set that drops it.
									const isDynamicRow = dynamicRowKeys.has(item.spec.key);
									return (
										<ExactRow
											key={item.spec.key}
											item={item}
											top={geometry.top}
											height={geometry.height}
											hitHeight={resolveRowHitHeight(
												exactLayout.items,
												itemIndex,
												exactLayout.totalHeight,
											)}
											contentWidth={contentWidth}
											itemId={itemId}
											sourceIds={sourceIds}
											// Layout-affecting interaction state PLUS the viewer's pure render
											// state, so a wrap / source toggle re-renders just this row.
											//
											// The live reasoning tail rides here too. It is read at DRAW time from
											// `spec.data` (never measured — see reasoning-live-tail), so none of the
											// three things the memo compares below moves when it advances: a folded
											// trace's `measured` is the SAME cached object, its key is constant, and
											// the tail is height-neutral. Without this term the memo skips the
											// re-render and the newest characters never reach the DOM. Empty string
											// for every settled row, so scroll-time memo hits are unaffected.
											// The closing set rides here too: it is read at DRAW time through a ref
											// (so `measured` and the keys are unchanged), and without a term in
											// this signature the memo would skip the re-render that mounts — and
											// later unmounts — a closing card. Empty for every trace with nothing
											// closing, so scroll-time memo hits are unaffected.
											interactionSig={`${rowInteractionSig(activeInteraction, item.spec.key)}|${contentView.rowSig(item.spec.key)}|${liveTailSignature(item.spec.data)}|${closingRowSig(closingRows, item.spec.key)}`}
											toggles={getRowToggles(item.spec.key)}
											renderLabels={renderLabels}
											interaction={interactionsByKey.get(item.spec.key)}
											rowInteraction={traceBinding?.rowInteraction}
											closingRowKeys={closingRows.get(item.spec.key)}
											narratorId={narratorId}
											onOpenFilePanel={rowHandlers?.onOpenFilePanel}
											openAttachmentLabel={openAttachmentLabel}
											injectionNoteLabel={injectionNoteLabel}
											reviewTruncatedLabel={reviewTruncatedLabel}
											injectionNavigation={injectionNavigation}
											currentUserId={currentUserId}
											permissionSlot={permissionSlot}
											traceRowPermissionSlots={tracePermissionSlotsByKey.get(item.spec.key)}
											onPermissionFormHeight={reportPermissionFormHeight}
											editorSlot={editorSlot}
											onTerminate={terminateRunningTool}
											resolveUpdateTimeout={getUpdateTimeout}
											onReflectionTakeOver={resolveReflectionTakeOver(item, getReflectionTakeOver)}
											// Unresolved on purpose: a drilled-in card binds its OWN gate (see
											// rowCard). Referentially stable (useCallback), so the memo is unaffected.
											getReflectionTakeOver={getReflectionTakeOver}
											// A drilled-in SUBAGENT card's own controls: the prompt fold (keyed by
											// the card, not the trace) and the session/lifecycle actions a trace
											// element has no interaction payload for. Both stable.
											onTogglePromptForKey={togglePromptForKey}
											resolveRowToolActions={traceBinding?.resolveRowToolActions}
											onUnknownHeight={
												isDynamicRow ? getUnknownHeightReporter(item.spec.key) : undefined
											}
											onResumeSubagentRecovery={handleResumeSubagentRecovery}
											specCarryoverActions={resolveSpecCarryoverActions(
												item,
												sourceIds,
												resolveSpecActions,
											)}
											errorNoticeActions={resolveErrorNoticeActions(
												item,
												sourceIds,
												errorNotice.resolve,
											)}
											injectionGuardActions={resolveInterruptGuardActions(
												item,
												sourceIds,
												resolveGuardActions,
											)}
											reviewFeedbackActions={resolveReviewFeedbackActions(
												item,
												sourceIds,
												resolveReviewActions,
											)}
											compactActions={compact.byKey.get(item.spec.key)}
											compactCancelTitle={compact.cancelTitle}
											askInPassingPending={askInPassingPending}
											onOpenAskInPassingTarget={askInPassing.openByKey.get(item.spec.key)}
											viewControls={contentView.controls}
											animateStreaming={animateStreamingRows && isStreamingRowKey(item.spec.key)}
											streamAnimMountEpoch={streamAnimMountEpoch}
											// Read from the committed document, NEVER streamingMsg: that hook
											// can already hold the next snapshot while these items are still old.
											streamAnimSnapshotEpoch={
												isStreamingRowKey(item.spec.key)
													? pretextDocument.streamingMessage?._streamAnimSnapshotEpoch
													: undefined
											}
											// The task spinner gate. Two identities, one flag: the newest
											// framed task bubble (by spec key) and the newest task board (by
											// tool-use id). Both are null unless the narrator is running.
											specTaskLive={isSpecTaskLiveItem(item, specTaskLiveGate)}
										/>
									);
								})}
							</div>
						) : (
							// Loading / error placeholder. While the document is being fetched and
							// laid out we keep the SAME message-shaped skeleton the panel showed
							// before this list mounted, so the transition reads as one continuous
							// placeholder instead of a skeleton followed by a bare text line.
							//
							// Laid out in CSS, NOT from `contentWidth`: reading the measured width
							// here is what painted the sentinel geometry for a frame on every mount.
							// The shared helper reproduces the row column's arithmetic in px, so the
							// skeleton and the rows that replace it occupy the same column.
							<div
								data-pretext-exact-status
								style={{
									minHeight: 64,
									...narratorColumnPlaceholderStyle(centeredColumn),
								}}
							>
								{pretextDocument.error ? (
									<HistoryRecoveryPanel
										narratorId={narratorId}
										loadError={pretextDocument.error}
										onRecovered={() => pretextDocument.reload()}
									/>
								) : null}
								{pretextDocument.error &&
								(pretextDocument.error as { data?: { code?: string } }).data?.code !==
									"HISTORY_AGGREGATE_UNAVAILABLE" ? (
									<Group gap="xs" align="center">
										<Text size="sm" c="red">
											{pretextDocument.error.message || tCommon("unknownError")}
										</Text>
										<Anchor
											component="button"
											type="button"
											size="sm"
											onClick={() => pretextDocument.reload()}
										>
											{tCommon("retry")}
										</Anchor>
									</Group>
								) : null}
								{!pretextDocument.error ? <NarratorMessageListSkeleton /> : null}
							</div>
						)}
						{tailFooter ? (
							<div
								ref={footerNodeRef}
								style={{ paddingBottom: PAGE_PADDING, width: contentWidth, margin: "0 auto" }}
							>
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
					{/* Original-content reveal for an edited message. ONE instance for the whole
			    list (rows only supply the open callback), mounted lazily and only while
			    open, so a scrolling list pays nothing for it. */}
					{originalModalEdited && originalModalMessageId ? (
						<Suspense fallback={null}>
							<OriginalContentModal
								opened
								onClose={() => setOriginalModalMessageId(null)}
								originalContentJson={originalModalEdited.originalContentJson}
								editedAt={originalModalEdited.editedAt}
								onRestore={
									onRestoreAssistantMessage
										? () => onRestoreAssistantMessage(originalModalMessageId)
										: undefined
								}
							/>
						</Suspense>
					) : null}
					{/* Cancel-compaction confirm dialog — ONE instance for the whole list; a
			    marker row only carries the callback that opens it. */}
					{compact.cancelDialog}
					{/* "Mark as retryable" rule dialog — ONE instance for the whole list; an
			    error row only carries the callback that opens it with its own text. */}
					{errorNotice.ruleModal}
					{/* Fullscreen content viewer — ONE instance for the whole list, mounted only
			    while a body is open. Rows (and their action bars) only report which
			    target to show, so a scrolling list never builds a modal per body. */}
					{contentView.openTarget ? (
						<VListContentViewModal
							target={contentView.openTarget}
							wordWrap={contentView.openWrapped}
							showSource={contentView.openSourceShown}
							// Opening a prefix body requests its full payload; until it lands the
							// modal says so rather than presenting the prefix as the whole thing.
							loadingFullPayload={openTargetState.loading}
							onToggleWrap={() => {
								if (contentView.openTarget) contentView.controls.toggleWrap(contentView.openTarget);
							}}
							onToggleSource={() => {
								if (contentView.openTarget)
									contentView.controls.toggleSource(contentView.openTarget);
							}}
							onClose={contentView.close}
						/>
					) : null}
				</div>
			);
		},
	),
);

PretextExactMessageList.displayName = "PretextExactMessageList";
