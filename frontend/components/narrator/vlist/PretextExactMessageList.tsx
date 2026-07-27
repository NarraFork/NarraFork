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

import { useLocalPref } from "@frontend/hooks/useLocalPref";
import { useInterruptNarrator, useResumeRecoverySubagents } from "@frontend/hooks/useNarrator";
import { useNarratorWS } from "@frontend/hooks/useNarratorWS";
import { useUserPreferences } from "@frontend/hooks/useUserPreferences";
import { narratorsApi } from "@frontend/lib/api/narrators";
import type { TreeMessage } from "@frontend/lib/api/types";
import {
	NARRATOR_CENTERED_COLUMN_MAX_WIDTH,
	resolveNarratorColumnWidth,
} from "@frontend/lib/narrator-content-column";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { Anchor, Box, Group, Loader, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { CatchUpCursor } from "@shared/narrator-catch-up";
import { type PretextLayoutIndex, resolveVisibleWindow } from "@shared/pretext-layout";
import type { LaidOutItem, ListLayout } from "@shared/pretext-layout/vlist-virtualization";
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
import { resolveEditorInitialText } from "../message-edit-text";
import { NarratorMessageListSkeleton } from "../NarratorMessageListSkeleton";
import { findLatestSpecTasksToolUseId } from "../narrator-message-helpers";
import type { NarratorMsg, PermissionCallbacks } from "../narrator-panel-types";
import { useRenderLod } from "../RenderLodCtx";
import { recentRunSegmentMessageIds } from "../run-segments";
import { TraceRowInteraction } from "../TraceRowInteraction";
import { getCategory, getCategoryColor, getSummary } from "../tool-display";
import type { TraceRowIdentity } from "../trace-row-identity";
import { isRunningStatus, type MeasuredToolCall } from "./measure/measure-tool-call";
import type { MeasuredTraceRow } from "./measure/measure-tool-run";
import type { RenderLod } from "./prepared-block";
import { buildPretextDocumentLayout } from "./pretext-document-layout";
import { CaretFiller } from "./render/caret-filler";
import type { SpecCarryoverActions } from "./render/RenderSystemText";
import type { TraceRowInteractionSlot } from "./render/RenderToolRun";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { useExactStreamingTail } from "./useExactStreamingTail";
import { usePretextDocument } from "./usePretextDocument";
import { renderLabelsForKind, useVListLabels, type VListRenderLabels } from "./useVListLabels";
import { useVListLivePatches } from "./useVListLivePatches";
import { useVListToolDetails } from "./useVListToolDetails";
import { VListRowInteraction } from "./VListRowInteraction";
import { resolveVListBlockTarget, toolUseIdFromBlockId } from "./vlist-block-target";
import { useVListCompactActions, type VListCompactRowActions } from "./vlist-compact-bridge";
import {
	hasEditableTextBlock,
	resolveVListEditedMeta,
	resolveVListEditTarget,
	type VListEditRole,
} from "./vlist-edit-target";
import {
	hasEffectiveHeightOverride,
	layoutItemsWithOverrides,
	pruneHeightOverrides,
} from "./vlist-height-overrides";
import {
	createVListInteractionState,
	isUserExpandedRow,
	resetVListInteractionStateForLod,
	setVListExpanded,
	toggleVListLodUserOverride,
	toggleVListRow,
	toggleVListShowEarlier,
	toggleVListShowOriginal,
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
import { buildReflectionSourceIndex } from "./vlist-reflection-index";
import {
	resolveExactReloadDecision,
	resolveReloadDelayMs,
	shouldSurfaceDeferredReload,
} from "./vlist-reload-policy";
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
import {
	resolveSpecCarryoverActions,
	useSpecCarryoverActions,
} from "./vlist-spec-carryover-actions";
import { collectCommittedMessageIds } from "./vlist-streaming-tail-retirement";
import { buildTailMeta, type TailMetaMessage } from "./vlist-tail-meta";
import { buildToolMetaIndex, type VListToolMeta } from "./vlist-tool-meta";
import { injectUserBubbleHeader } from "./vlist-user-bubble-header";
import { resolvePinnedRowIndices } from "./vlist-virtualization";

// Editing chrome is lazy: a list that is only being read never pays for the
// editor's module graph (attachment thumbs, upload flow) or the modal.
const MessageEditorPanel = lazy(() =>
	import("../MessageEditorPanel").then((m) => ({ default: m.MessageEditorPanel })),
);
const OriginalContentModal = lazy(() =>
	import("../MessageOriginalContent").then((m) => ({ default: m.OriginalContentModal })),
);

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
	/** Narrator is bound to a chapter (git) → user-edit offers the rollback option. */
	hasChapter?: boolean;
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

/** `[start, end)` as an index list (mounted-window enumeration). */
function range(start: number, end: number): number[] {
	const out: number[] = [];
	for (let i = start; i < end; i++) out.push(i);
	return out;
}

/**
 * Order-sensitive equality for two id lists. Used to keep the truncated-tool-use
 * state referentially stable: a fresh array of the SAME ids must not retrigger the
 * fetch (which would rebuild the document in a loop).
 */
function sameIdList(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
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

/** Shell-runnable tools whose execution can be interrupted mid-flight. */
const TERMINABLE_TOOLS = new Set(["Bash", "Shell", "Execute"]);

/**
 * True when a running tool can be stopped from the header — shell commands and
 * MCP tools, mirroring the chunked InlineTerminateControl's own test.
 */
function canTerminateTool(toolName: string): boolean {
	return TERMINABLE_TOOLS.has(toolName) || toolName.startsWith("mcp__");
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
 * Height of a row's HIT box — the row's own height PLUS the gap below it, so
 * consecutive rows tile the canvas with no bare strip between them.
 *
 * Why this exists: every row and every text line inside it is absolutely
 * positioned (the zero-DOM height model), so the inter-item gaps are bare canvas
 * with no in-flow line box. During a drag-selection the browser cannot resolve a
 * caret position over such a strip and falls back to the container's FIRST
 * position — the selection focus snaps to the top of the history mid-drag. Making
 * the hit boxes tile removes those dead strips; an inner clip box keeps the exact
 * arithmetic height, so geometry and visuals are unchanged.
 *
 * The returned value is never smaller than the row's own height, and the last row
 * extends to the bottom of the canvas (absorbing the trailing padding).
 */
export function resolveRowHitHeight(
	items: readonly LaidOutItem[],
	index: number,
	totalHeight: number,
): number {
	const current = items[index];
	if (!current) return 0;
	const own = Math.max(0, current.height);
	const next = items[index + 1];
	const boundary = next ? next.top : totalHeight;
	if (!Number.isFinite(boundary)) return own;
	return Math.max(own, boundary - current.top);
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
 * Total laid-out height of the streaming tail, matching exactly what
 * `renderStreamingTailNodes` produces: every item contributes its measured
 * height, plus one ITEM_GAP per boundary that actually renders a gap. Boundaries
 * INSIDE a run of frameless cards contribute none (the trailing divider each
 * non-last card carries is the separator), and the final boundary never does.
 */
export function measureStreamingTailHeight(items: readonly VListItem[]): number {
	const frameEndByStart = new Map<number, number>();
	for (const run of computeToolRunFrames(items)) frameEndByStart.set(run.start, run.end);
	// Index → the last index of the run it belongs to (frames are maximal, so a
	// boundary is intra-run iff both sides share the same run end).
	const runEndByIndex = new Map<number, number>();
	for (const [start, end] of frameEndByStart) {
		for (let i = start; i <= end; i++) runEndByIndex.set(i, end);
	}
	let total = 0;
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (!item) continue;
		total += item.measured.height;
		if (i === items.length - 1) continue;
		const runEnd = runEndByIndex.get(i);
		// Inside a run: no gap. At a run's last card (or outside any run): one gap.
		if (runEnd !== undefined && i < runEnd) continue;
		total += ITEM_GAP;
	}
	return total;
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
	renderLabels: VListRenderLabels,
): ReactNode[] {
	const frameEndByStart = new Map<number, number>();
	for (const run of computeToolRunFrames(items)) frameEndByStart.set(run.start, run.end);

	const renderOne = (item: VListItem, marginBottom: number) => {
		const extra = resolveRenderExtra(item.spec);
		injectRenderLabels(item.spec.kind, extra, renderLabels);
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
					{/* Cards inside a run stack flush: each non-last card already carries
					    its own trailing 1px divider, so an extra gap would both stripe the
					    frame background and make the per-divider cells unequal (parity with
					    the committed canvas, whose intra-run gapAfter is 0). */}
					{group.map((groupItem) => renderOne(groupItem, 0))}
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

/**
 * Attach the localized chrome bundle for this element kind to the render extra.
 *
 * The adapter already supplies label-derived TEXT for kinds whose strings are
 * measured (system cards, trace headers) via `spec.opts.labels`; that value is
 * preserved when present so a per-spec override always wins. Kinds that draw
 * their own chrome (buttons, badges, placeholders, section titles) get the
 * shell's bundle here — without it they fall back to the render layer's English
 * defaults. Height-neutral: every render label sits in a fixed-height row.
 */
function injectRenderLabels(
	kind: string,
	extra: Record<string, unknown>,
	renderLabels: VListRenderLabels,
): void {
	if (extra.labels === undefined) {
		const labels = renderLabelsForKind(kind, renderLabels);
		if (labels !== undefined) extra.labels = labels;
	}
	if (kind === "plan-card" && extra.label === undefined) extra.label = renderLabels.planCard;
	if (kind === "tool-call-group") {
		if (extra.label === undefined) extra.label = renderLabels.toolCallGroup.label;
		if (extra.statusLabel === undefined) extra.statusLabel = renderLabels.toolCallGroup.statusLabel;
		// The grouped header tooltips its aggregate duration with the earliest start;
		// it reuses the tool card's timing bundle rather than owning a second copy.
		if (extra.timingLabels === undefined) extra.timingLabels = renderLabels.toolCall.timing;
	}
	if (kind === "prune-divider" && extra.fallbackLabel === undefined) {
		extra.fallbackLabel = renderLabels.pruneDivider;
	}
}

/** Kinds whose card open/close is user-toggleable (needs onToggle). */
const TOGGLEABLE_CARD_KINDS = new Set([
	"reasoning",
	"tool-call",
	"subagent-card",
	// Slash-command bubbles fold their expanded prompt behind a toggle. Plain user
	// bubbles carry no `commandText`, so the render layer ignores the callback.
	"message-bubble",
]);
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
			// Subagent lifecycle facts (open session / detach / cancel), matching the
			// three items the expanded SubagentCard offers.
			...(meta?.subagentNarratorId ? { subagentNarratorId: meta.subagentNarratorId } : {}),
			...(meta?.isBackground ? { isBackground: true } : {}),
			...(meta?.isTerminal ? { isTerminal: true } : {}),
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
	/** Flip a translated body between its translation and the original. */
	onToggleTranslation: () => void;
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
	/**
	 * Reveal this message's pre-edit text. Present only when the owning message
	 * carries `editedAt`; the modal itself is a single shell-level instance.
	 */
	onViewOriginal?: () => void;
}

interface ExactRowProps {
	item: VListItem;
	top: number;
	height: number;
	/**
	 * Height of the row's outer HIT box (own height + the gap below it), so rows
	 * tile the canvas and a drag-selection never crosses a caret-less strip. See
	 * resolveRowHitHeight.
	 */
	hitHeight: number;
	/** Width of the centered content column drawn inside the full-width row. */
	contentWidth: number;
	itemId: string | undefined;
	sourceIds: readonly string[];
	/** Interaction signature for this row's key; changes force a re-render. */
	interactionSig: string;
	toggles: RowToggles;
	/** Localized chrome bundles for the render layer (stable across renders). */
	renderLabels: VListRenderLabels;
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
	 * Inline message editor for THIS row. When present it REPLACES the row body
	 * entirely (no zero-DOM copy, no interaction wrapper — editing has no context
	 * menu, matching the chunked path) and the row switches to the post-paint
	 * measured height like a permission form.
	 */
	editorSlot?: ReactNode;
	/**
	 * Report this row's settled real-pixel height. Provided only for rows whose
	 * height cannot be predicted (permission form / inline editor / unknown
	 * blocks); recorded as a per-key override that re-derives the canvas geometry.
	 */
	onUnknownHeight?: (height: number) => void;
	/** Interrupt the narrator, stopping a running shell / MCP tool. */
	onTerminate?: () => void;
	/**
	 * Resolve the timeout sender for a tool card's own `toolUseId`. Passed as a
	 * resolver rather than a bound callback so the row can gate on the measured
	 * card's state without the shell knowing which rows are tool cards.
	 */
	resolveUpdateTimeout?: (toolUseId: string) => (timeoutMs: number) => void;
	/**
	 * Stop a RUNNING reflection gate on this row and take the decision over. Bound
	 * per row because the request id lives in the row's reflection.
	 */
	onReflectionTakeOver?: () => void;
	/** Submit the subagent-recovery card's selection (mutation lives outside vlist/). */
	onResumeSubagentRecovery?: (messageId: string, specKey: string, mode: "notify" | "await") => void;
	/**
	 * Live handlers for a Dynamic Spec notice card's buttons (view tasks / clear
	 * tasks / reset spec). Present only on those rows; absent → the buttons render
	 * disabled instead of silently inert.
	 */
	specCarryoverActions?: SpecCarryoverActions;
	/**
	 * Compact-marker callbacks for THIS row (open summary / cancel a running
	 * compaction). Absent for every non-marker row; referentially stable per key so
	 * the memo below keeps skipping.
	 */
	compactActions?: VListCompactRowActions;
	/** Localized tooltip for the cancel affordance (shared by every marker row). */
	compactCancelTitle?: string;
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
		hitHeight,
		contentWidth,
		itemId,
		sourceIds,
		toggles,
		renderLabels,
		interaction,
		rowInteraction,
		narratorId,
		permissionSlot,
		editorSlot,
		onUnknownHeight,
		onTerminate,
		resolveUpdateTimeout,
		onReflectionTakeOver,
		onResumeSubagentRecovery,
		specCarryoverActions,
		compactActions,
		compactCancelTitle,
	}: ExactRowProps) {
		const extra = resolveRenderExtra(item.spec);
		const kind = item.spec.kind;
		// User bubbles: build the avatar/name/time header node from the forwarded
		// creator data (the pure render layer cannot construct it itself).
		injectUserBubbleHeader(kind, extra);
		injectRenderLabels(kind, extra, renderLabels);
		if (TOGGLEABLE_CARD_KINDS.has(kind)) {
			extra.onToggle = toggles.onToggle;
		}
		// A translated reasoning run paints a language toggle inside its expanded
		// body. Without this binding the row drew the control but nothing happened
		// on click — the render layer only draws what it is handed.
		if (kind === "reasoning") {
			extra.onToggleTranslation = toggles.onToggleTranslation;
		}
		if (TRACE_KINDS.has(kind)) {
			extra.onToggleItems = toggles.onToggleItems;
			extra.onToggleEarlier = toggles.onToggleEarlier;
			extra.onToggleRow = toggles.onToggleRow;
			// Folded traces: give each ROW inside the trace its own menu / selection.
			if (rowInteraction) extra.rowInteraction = rowInteraction;
		}
		// The recovery card owns a checkbox list plus two submit buttons. Its rows
		// reuse the generic per-row toggle; the submit itself is a mutation living
		// outside vlist/, injected by the panel.
		if (kind === "subagent-recovery") {
			extra.onToggleRow = toggles.onToggleRow;
			// System cards carry no `-b{n}` suffix, so they never get a RowInteraction.
			// The owning message comes from the manifest source ids instead.
			const messageId = sourceIds[0];
			if (messageId && onResumeSubagentRecovery) {
				const specKey = item.spec.key;
				extra.onResume = (mode: "notify" | "await") =>
					onResumeSubagentRecovery(messageId, specKey, mode);
			}
		}
		// Dynamic Spec notice cards (fork carryover / context cleared / goal added)
		// own real buttons whose mutations live outside vlist/, so the shell injects
		// them. Without this the buttons paint but do nothing — the chunked path's
		// SpecForkCarryoverCard drives the same three actions itself.
		if (specCarryoverActions) extra.specCarryoverActions = specCarryoverActions;
		// Compact / segment-compact markers: the row itself is the affordance — it
		// opens the summary modal, or cancels a compaction still in flight. Both live
		// outside vlist/ (modal + API), so they arrive as bound callbacks.
		if (compactActions) {
			if (compactActions.onOpenCompact) extra.onOpenCompact = compactActions.onOpenCompact;
			if (compactActions.onCancelCompact) {
				extra.onCancelCompact = compactActions.onCancelCompact;
				extra.cancelCompactTitle = compactCancelTitle;
			}
		}
		// Media / tool-call details resolve images against the panel narrator.
		extra.narratorId = narratorId;
		// Subagent card's in-card "open full session" button. RenderSubagent has
		// always accepted onOpenSession, but nothing supplied it — the button was
		// inert. Bind it to the same action the row menu uses.
		if (kind === "subagent-card" && interaction?.toolActions?.onViewSubagentSession) {
			extra.onOpenSession = interaction.toolActions.onViewSubagentSession;
		}
		// Long-running bash / MCP tools get the header terminate control (parity with
		// the chunked InlineTerminateControl). Only cards that can actually be stopped
		// receive the callback, so the button never appears where it would no-op.
		if (kind === "tool-call" && onTerminate) {
			const measured = item.measured as MeasuredToolCall;
			if (canTerminateTool(measured.toolName)) {
				extra.onTerminate = onTerminate;
			}
		}
		// Editable timeout: only a RUNNING card that actually has a deadline can be
		// extended, so the sender is bound just for those (mirroring the chunked
		// `canEditTimeout`). The renderer treats an absent callback as read-only.
		if (kind === "tool-call" && resolveUpdateTimeout) {
			const measured = item.measured as MeasuredToolCall;
			if (isRunningStatus(measured.status) && measured.timeoutMs != null && measured.toolUseId) {
				extra.onUpdateTimeout = resolveUpdateTimeout(measured.toolUseId);
			}
		}
		// A live permission form (pending-permission tool/subagent card) is injected
		// as a slot; the pure renderer draws it in place of the zero-DOM copy.
		if (permissionSlot !== undefined) extra.permissionSlot = permissionSlot;
		// Manual takeover of a RUNNING reflection gate. The notice itself is measured
		// + rendered on the pure path; only this action needs the app layer.
		if (kind === "tool-call" && onReflectionTakeOver) {
			const measured = item.measured as MeasuredToolCall;
			if (measured.reflection?.hasTakeOver) extra.onReflectionTakeOver = onReflectionTakeOver;
		}
		// While editing, the editor REPLACES the row: no measured body, no menu /
		// selection surface. The chunked path behaves the same way (its edit branch
		// returns before ContentViewer), so the row temporarily has no
		// data-block-id — expected, and it comes back when editing ends.
		const body = editorSlot ?? renderElement(kind, item.measured, extra);
		const interactiveBody =
			interaction && editorSlot === undefined ? (
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
						onViewOriginal={interaction.onViewOriginal}
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
		// Two layers, deliberately:
		//
		//  - OUTER (full width, height = hitHeight): tiles the canvas so no bare,
		//    caret-less strip is left between rows or beside the centered column.
		//    A drag-selection crossing this area resolves a real caret position
		//    instead of falling back to the container's first position (which is
		//    what made the selection snap to the top of the history mid-drag).
		//    It carries NO event handlers, so a click / right-click landing on the
		//    extended part triggers nothing — only text selection benefits.
		//  - INNER (centered column, exact arithmetic height, clipped): the real
		//    row body plus its interaction surface. Geometry, visuals and the
		//    selection outline stay bound to the measured height.
		return (
			<div
				id={itemId}
				data-message-id={sourceIds[0]}
				style={{
					position: "absolute",
					top,
					left: 0,
					width: "100%",
					...(isDynamic ? { minHeight: hitHeight } : { height: hitHeight }),
				}}
			>
				<div
					style={{
						width: contentWidth,
						margin: "0 auto",
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
				{/* The extended part of the hit box (the gap below this row) carries no
				    text of its own, so a drag-selection crossing it would still fail to
				    resolve a caret. Fill it with a selectable, invisible strip. */}
				{!isDynamic ? (
					<CaretFiller top={height} height={hitHeight - height} width={contentWidth} centered />
				) : null}
			</div>
		);
	},
	(prev, next) =>
		prev.item === next.item &&
		prev.top === next.top &&
		prev.height === next.height &&
		prev.hitHeight === next.hitHeight &&
		prev.contentWidth === next.contentWidth &&
		prev.itemId === next.itemId &&
		prev.interactionSig === next.interactionSig &&
		prev.toggles === next.toggles &&
		prev.interaction === next.interaction &&
		prev.rowInteraction === next.rowInteraction &&
		prev.narratorId === next.narratorId &&
		prev.permissionSlot === next.permissionSlot &&
		prev.editorSlot === next.editorSlot &&
		prev.onUnknownHeight === next.onUnknownHeight &&
		prev.onTerminate === next.onTerminate &&
		prev.resolveUpdateTimeout === next.resolveUpdateTimeout &&
		prev.onReflectionTakeOver === next.onReflectionTakeOver &&
		prev.onResumeSubagentRecovery === next.onResumeSubagentRecovery &&
		prev.specCarryoverActions === next.specCarryoverActions &&
		prev.compactActions === next.compactActions &&
		prev.compactCancelTitle === next.compactCancelTitle,
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

/**
 * Thin boolean view of {@link resolveExactReloadDecision}, retained so existing
 * callers/tests keep a stable entry point. The shell itself uses the full decision
 * because it also needs the `deferred` flag to drive the unread affordance.
 */
export function shouldReloadExactDocument(
	messageRevision: number,
	appliedRevision: number,
	hasIndex: boolean,
	pinnedToBottom: boolean,
): boolean {
	return resolveExactReloadDecision({
		messageRevision,
		appliedRevision,
		hasIndex,
		pinnedToBottom,
	}).reload;
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
		hasChapter,
		tailFooter,
	} = props;
	const lod = useRenderLod() as RenderLod;
	// Advanced-animation preference (same key AppRootLayout writes to <html>);
	// gates the streaming tail's per-grapheme fade-in. Reactive so toggling the
	// setting takes effect without a reload.
	const [advancedAnim] = useLocalPref("narrafork_advanced_anim");
	// Reading-width preference: OFF (default) lets the content column fill the
	// viewport like the chunked path; ON caps it at a centered reading width.
	const [centeredColumn] = useLocalPref("narrafork_narrator_centered_column");
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
	const [contentWidth, setContentWidth] = useState(NARRATOR_CENTERED_COLUMN_MAX_WIDTH);
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
	const resolveShowOriginal = useCallback(
		(key: string) => activeInteraction.showOriginal.has(key),
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
	const resolveExactToolSummary = useCallback((tc: unknown) => {
		const call = (tc ?? {}) as {
			toolName?: unknown;
			inputJson?: unknown;
			_metadata?: unknown;
			outputJson?: unknown;
		};
		if (typeof call.toolName !== "string") return "";
		const outputMetadata =
			call.outputJson && typeof call.outputJson === "object" && !Array.isArray(call.outputJson)
				? (call.outputJson as { _metadata?: unknown })._metadata
				: undefined;
		const metadata = outputMetadata ?? call._metadata;
		return getSummary(
			call.toolName,
			call.inputJson,
			metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : undefined,
		);
	}, []);
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
					| {
							effectiveOpened?: boolean;
							effectiveExpanded?: boolean;
							form?: string;
							expanded?: boolean;
					  }
					| undefined;
				// A slash-command bubble reports its fold state on `expanded` (its `form`
				// is the literal "command", so the generic checks below cannot see it).
				const current =
					measured?.form === "command"
						? measured.expanded === true
						: (measured?.effectiveOpened ??
							measured?.effectiveExpanded ??
							measured?.form === "expanded");
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
			onToggleTranslation: () => setInteraction((prev) => toggleVListShowOriginal(prev, key)),
		};
		togglesCacheRef.current.set(key, toggles);
		return toggles;
	}, []);

	// Subagent-recovery card submit. The card's row set tracks DESELECTED indices
	// (it starts fully selected), so the payload is derived by subtracting them
	// from the measured row list.
	const resumeRecovery = useResumeRecoverySubagents();
	const handleResumeSubagentRecovery = useCallback(
		(messageId: string, specKey: string, mode: "notify" | "await") => {
			const measured = measuredByKeyRef.current.get(specKey) as
				| { blocks?: Array<{ data?: { subagents?: Array<{ id?: string }> } }> }
				| undefined;
			const rows = measured?.blocks?.[0]?.data?.subagents ?? [];
			const deselected = new Set(activeInteraction.expandedRows.get(specKey) ?? []);
			const subagentIds = rows
				.map((row, index) => (deselected.has(index) ? null : row?.id))
				.filter((id): id is string => typeof id === "string" && id.length > 0);
			if (subagentIds.length === 0) return;
			resumeRecovery.mutate({ narratorId, messageId, subagentIds, mode });
		},
		[activeInteraction, narratorId, resumeRecovery],
	);

	// Dynamic Spec notice cards: "View tasks" opens the Spec task board. The panel
	// owns that panel, and the chunked card reaches it by bubbling a DOM
	// CustomEvent up to the NarratorPanel scroll viewport — which IS this shell's
	// scroll node, so dispatching from it hits the same listener.
	const openSpecTasks = useCallback(() => {
		viewportRef.current?.dispatchEvent(new CustomEvent("spec-open-tasks", { bubbles: true }));
	}, []);
	const resolveSpecActions = useSpecCarryoverActions(narratorId, openSpecTasks);

	// The manual "load older" header lives in the exact canvas top padding, so its
	// height is part of totalHeight and needs no scroll-coordinate offset. It is
	// tracked as state (synced from hasPrev below) so it can be fed into the layout
	// input without a circular dependency on the hook's output. When it toggles
	// (older history exhausted), the anchor-preserving rebuild keeps the visible
	// content fixed while the reserved space changes off-screen above it.
	const [olderHeaderHeight, setOlderHeaderHeight] = useState(0);
	const { t, i18n } = useTranslation("narrator");
	const { t: tCommon } = useTranslation("common");
	// Every localized string the vlist paints comes from one place (the vlist
	// layers themselves import no i18n — see CONTRACT.md §0). `adapterLabels` feeds
	// the pure adapter's measured card / trace text; `renderLabels` supplies each
	// RenderXxx's chrome (buttons, badges, section titles, placeholders).
	const { adapterLabels: vlistLabels, renderLabels } = useVListLabels();
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
	// Truncated payloads on expanded cards, fetched in full on demand (the chunked
	// path's LazyDetailRenderer equivalent). The id list is published by an effect
	// AFTER the build below, so this render uses the previous list — one build
	// behind is exactly right: the row must already be expanded to need its body.
	const [truncatedToolUseIds, setTruncatedToolUseIds] = useState<readonly string[]>([]);
	const { resolveFullToolInput, resolveFullToolOutput } = useVListToolDetails(
		narratorId,
		truncatedToolUseIds,
	);
	// Header terminate control: interrupting the narrator is what actually stops a
	// running shell / MCP tool (the chunked control does the same).
	const interruptMutation = useInterruptNarrator();
	const terminateRunningTool = useCallback(() => {
		if (narratorId && !interruptMutation.isPending) interruptMutation.mutate(narratorId);
	}, [narratorId, interruptMutation]);
	// Manual takeover of a running reflection gate. The measured notice supplies the
	// kind + requestId; only the API call lives out here (parity with the chunked
	// ReflectionNotice, which drives api.stopXReflection itself).
	const takeOverReflection = useCallback((kind: string | undefined, requestId: string) => {
		if (!requestId) return;
		if (kind === "danger_reflection") void narratorsApi.stopDangerReflection(requestId);
		else if (kind === "plan_reflection") void narratorsApi.stopPlanReflection(requestId);
		else if (kind === "task_reflection") void narratorsApi.stopTaskReflection(requestId);
		else if (kind === "question_reflection") void narratorsApi.stopQuestionReflection(requestId);
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
	const pretextDocument = usePretextDocument(narratorId, {
		lod,
		labels: vlistLabels,
		labelsRevision,
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
		showOriginal: resolveShowOriginal,
		resolveToolCategory: getCategory,
		resolveToolColor: resolveExactToolColor,
		resolveToolSummary: resolveExactToolSummary,
		resolveRecentMessageIds,
		resolveHasPendingPermission,
		resolvePendingPlan,
		resolvePendingPermissionSuggestions,
		resolveFullToolInput,
		resolveFullToolOutput,
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
		// The shell is NOT remounted per narrator (no `key={narratorId}`), so the
		// per-row handler caches keyed by spec.key would otherwise accumulate every
		// row of every narrator visited in this session, each entry pinning a closure.
		// The keys are narrator-scoped, so nothing survives the switch usefully.
		unknownHeightReporterCacheRef.current.clear();
		togglesCacheRef.current.clear();
		reflectionTakeOverCacheRef.current.clear();
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
	});

	// Structural reload gate. When the reader is pinned to the bottom, apply the
	// tail-first reload (the newest content is exactly what they see). When they
	// have scrolled up, DEFER: leave appliedMessageRevisionRef behind so the pending
	// structural change is remembered, and rebuild only once they return to the
	// bottom. This keeps a reader who is browsing history — possibly deep into
	// loadOlder pages — from being snapped back to the tail every time a message
	// lands during active generation.
	//
	// The reload is COALESCED over a short window: one turn commonly persists
	// several messages back to back, and each used to trigger its own full tail
	// refetch (40-100 messages + a complete re-measure). Batching collapses that
	// burst into a single reload.
	//
	// Lifecycle changes never reach here — they are patched in place above, which is
	// why deferring this path no longer freezes tool/reflection state.
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

	// Tool uses whose payload is STILL a truncated preview on an EXPANDED card.
	// These are the only rows worth fetching in full: a collapsed card shows no
	// body, and an untruncated one already has everything. Publishing the list into
	// state (rather than reading it during the build) keeps the data flow one-way —
	// the fetched payloads feed the NEXT build through the resolvers above.
	const truncatedExpandedToolUseIds = useMemo(() => {
		const ids: string[] = [];
		for (const item of renderItems) {
			if (!item || item.spec.kind !== "tool-call") continue;
			const measured = item.measured as MeasuredToolCall;
			if (!measured.hasTruncatedPayload || !measured.effectiveOpened) continue;
			// Only rows the USER expanded may fetch here. A card that opened by itself
			// (computeDefaultOpen / LOD 6) has its body prefetched before the layout is
			// built (see PretextLayoutCoordinator.prepareToolDetails); fetching it again
			// on this path would reintroduce the very post-paint growth that path
			// exists to avoid — the row would settle short, then jump taller while the
			// reader is only scrolling.
			if (!isUserExpandedRow(activeInteraction, item.spec.key)) continue;
			if (measured.toolUseId) ids.push(measured.toolUseId);
		}
		return ids;
	}, [renderItems, activeInteraction]);
	useEffect(() => {
		setTruncatedToolUseIds((prev) =>
			sameIdList(prev, truncatedExpandedToolUseIds) ? prev : truncatedExpandedToolUseIds,
		);
	}, [truncatedExpandedToolUseIds]);

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
	const permissionSlotByKey = usePermissionSlots({
		renderItems,
		permCb,
		reflections: reflectionIndex,
	});

	// Keys that currently host a dynamic (post-paint measured) body — rows carrying
	// a live permission FORM, plus the row being edited inline. Only these may hold
	// a height override; every other row is pure arithmetic.
	//
	// Reflection rows are deliberately NOT here: the notice is measured
	// (measure-reflection-notice), so putting it on the dynamic path would let a
	// ResizeObserver move a committed row's height with no user action behind it.
	const dynamicRowKeys = useMemo(() => {
		const keys = new Set<string>();
		for (const item of renderItems) {
			if (item && permissionSlotByKey.has(item.spec.key)) keys.add(item.spec.key);
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
		if (effectiveHeightOverrides !== heightOverrides) setHeightOverrides(effectiveHeightOverrides);
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

	// Live streaming tail: rendered as an overlay block below the stable exact
	// canvas (never injected into the document layout), so high-frequency deltas
	// never force a full-document layout recompute. Only active while working.
	// Top-level ids of the COMMITTED document. This is the tail's hand-off signal:
	// it holds its content until the persisted message that replaces it is actually
	// present, so the swap costs no blank frame. Derived from the message list (not
	// a commit counter) so a live lifecycle patch — which also commits a layout —
	// cannot retire the tail early and reopen the gap.
	const committedMessageIds = useMemo(
		() => collectCommittedMessageIds(pretextDocument.messages),
		[pretextDocument.messages],
	);
	const streamingMsg = useExactStreamingTail(narratorId, {
		enabled: isActive,
		isSubagent,
		committedMessageIds,
	});
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
				labelsRevision,
				isExpanded: resolveExpanded,
				isLodUserOverride: resolveLodUserOverride,
				showEarlier: resolveShowEarlier,
				expandedRows: resolveExpandedRows,
				showOriginal: resolveShowOriginal,
				resolveToolCategory: getCategory,
				resolveToolColor: resolveExactToolColor,
				resolveToolSummary: resolveExactToolSummary,
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
		labelsRevision,
		resolveExpanded,
		resolveLodUserOverride,
		resolveShowEarlier,
		resolveExpandedRows,
		resolveShowOriginal,
		resolveExactToolColor,
		resolveExactToolSummary,
	]);
	// Tail height must match what renderStreamingTailNodes actually lays out:
	// intra-run boundaries between frameless cards carry no gap (the divider is
	// the separator), so counting one gap per item would over-reserve the bottom
	// scroll room and make the pinned-to-bottom target overshoot.
	const streamingTailHeight = useMemo(
		() => measureStreamingTailHeight(streamingItems),
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
	// (a reconnect catch-up page), and an edit/delete/prune bumps the revision without
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
	useLayoutEffect(() => {
		const node = viewportRef.current;
		if (!node) return;
		const measure = () => {
			setViewportHeight(node.clientHeight);
			setContentWidth(resolveNarratorColumnWidth(node.clientWidth, PAGE_PADDING, centeredColumn));
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [centeredColumn]);

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
	const interactionsByKey = useMemo(() => {
		const map = new Map<string, RowInteraction>();
		if (!selectionIndex) return map;
		const manifestByKey = new Map(manifestItems.map((m) => [m.itemKey, m]));
		// Tool facts the layout spec deliberately drops (child narrator id, file
		// path, background state). Keyed by toolUseId — a tool/subagent row's
		// blockId is `tc-`/`sa-` + that id.
		const toolMetaIndex = buildToolMetaIndex(pretextDocument.messages as unknown as NarratorMsg[]);
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
			const actions = buildRowCtxActions(
				{ messageId, blockIndex, blockIndices, editable: !!editTarget },
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
				...(editedMeta ? { onViewOriginal: () => setOriginalModalMessageId(messageId) } : {}),
			});
		}
		return map;
	}, [
		selectionIndex,
		renderItems,
		manifestItems,
		rowHandlers,
		pretextDocument.messages,
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
							onDetachSubagent={handlers.onDetachSubagent}
							onCancelBackgroundTask={handlers.onCancelBackgroundTask}
						>
							{titleRow}
						</TraceRowInteraction>
					</MessageContextMenuCtx.Provider>
				);
			});
		}
		return map;
	}, [selectionIndex, renderItems, rowHandlers, pretextDocument.messages, narratorId]);

	// Item index of the row being edited, so it can be pinned into the mounted
	// window. -1 → not in the loaded document (nothing to pin).
	const editingRowIndex = useMemo(() => {
		if (!editingRow) return null;
		const index = renderItems.findIndex((item) => item?.spec.key === editingRow.key);
		return index >= 0 ? index : null;
	}, [editingRow, renderItems]);

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
		[messagesById, rowHandlers, narratorId, tailMeta.lastUserMessageId, hasChapter, closeEditor],
	);

	const originalModalMessage = originalModalMessageId
		? messagesById.get(originalModalMessageId)
		: undefined;
	const originalModalEdited = resolveVListEditedMeta(originalModalMessage);
	const onRestoreAssistantMessage = rowHandlers?.onRestoreAssistantMessage;

	return (
		<div
			ref={assignViewport}
			onScroll={onScroll}
			style={{ position: "relative", height: "100%", overflow: "auto" }}
			data-pretext-exact-message-list
		>
			{/* Full width on purpose: each row centers its own `contentWidth` column
			    instead of relying on a narrow, centered parent. A centered parent
			    left the space beside it as bare scroll container with no in-flow
			    line box, and a drag-selection passing over it snapped the selection
			    focus back to the top of the history (same root cause as the
			    inter-row gaps — see resolveRowHitHeight). */}
			<div ref={assignContent} style={{ position: "relative", width: "100%" }}>
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
							// The row being edited stays mounted even after scrolling out of
							// the window — unmounting would destroy the draft.
							...resolvePinnedRowIndices(visible, editingRowIndex),
						].map((itemIndex) => {
							const item = renderItems[itemIndex];
							const geometry = exactLayout.items[itemIndex];
							const manifestItem = manifestItems[itemIndex];
							if (!item || !geometry || !manifestItem) return null;
							const sourceIds = sourceIdsForItem(item, manifestItem);
							const itemId = domIdForItem(item, sourceIds);
							const permissionSlot = permissionSlotByKey.get(item.spec.key);
							const editorSlot =
								editingRow?.key === item.spec.key ? renderEditorSlot(editingRow) : undefined;
							const isDynamicRow = permissionSlot !== undefined || editorSlot !== undefined;
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
									interactionSig={rowInteractionSig(activeInteraction, item.spec.key)}
									toggles={getRowToggles(item.spec.key)}
									renderLabels={renderLabels}
									interaction={interactionsByKey.get(item.spec.key)}
									rowInteraction={rowInteractionByKey.get(item.spec.key)}
									narratorId={narratorId}
									permissionSlot={permissionSlot}
									editorSlot={editorSlot}
									onTerminate={terminateRunningTool}
									resolveUpdateTimeout={getUpdateTimeout}
									onReflectionTakeOver={resolveReflectionTakeOver(item, getReflectionTakeOver)}
									onUnknownHeight={
										isDynamicRow ? getUnknownHeightReporter(item.spec.key) : undefined
									}
									onResumeSubagentRecovery={handleResumeSubagentRecovery}
									specCarryoverActions={resolveSpecCarryoverActions(
										item,
										sourceIds,
										resolveSpecActions,
									)}
									compactActions={compact.byKey.get(item.spec.key)}
									compactCancelTitle={compact.cancelTitle}
								/>
							);
						})}
					</div>
				) : (
					// Loading / error placeholder. While the document is being fetched and
					// laid out we keep the SAME message-shaped skeleton the panel showed
					// before this list mounted, so the transition reads as one continuous
					// placeholder instead of a skeleton followed by a bare text line.
					<div
						data-pretext-exact-status
						style={{
							minHeight: 64,
							padding: PAGE_PADDING,
							width: contentWidth,
							margin: "0 auto",
						}}
					>
						{pretextDocument.error ? (
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
						) : (
							<NarratorMessageListSkeleton />
						)}
					</div>
				)}
				{streamingItems.length > 0 ? (
					<div
						data-pretext-exact-streaming-tail
						style={{
							position: "relative",
							paddingBottom: PAGE_PADDING,
							width: contentWidth,
							margin: "0 auto",
						}}
					>
						{renderStreamingTailNodes(
							streamingItems,
							isActive && advancedAnim,
							narratorId,
							renderLabels,
						)}
					</div>
				) : null}
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
		</div>
	);
});

PretextExactMessageList.displayName = "PretextExactMessageList";
