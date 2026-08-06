import { Box } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { stringifyForDisplay } from "@shared/pretext-layout/tool-io-projection";
import {
	forwardRef,
	isValidElement,
	memo,
	type RefObject,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useTransition,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocalPref } from "../../hooks/useLocalPref";
import { useLodAnchor } from "../../hooks/useLodAnchor";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import type { RevertScope } from "../../lib/api/narrators";
import { resolveNarratorColumnMaxWidth } from "../../lib/narrator-content-column";
import {
	createForegroundBottomResumeIntent,
	estimateSeqCenteredScrollTop,
	resolveBottomPinAction,
	resolveChunkBandRadius,
	resolveMessageScrollerOverscrollBehavior,
	resolveOlderHistoryAutoLoad,
	resolveOlderHistoryAutoLoadEnabled,
	resolveScrollTargetIndex,
} from "./chunk-scroll-utils";
import {
	type ActivityRenderOverrides,
	buildCrossChunkActivityOverrides,
	buildCrossChunkActivityRenderPlan,
	computeChunkActivityUnits,
} from "./cross-chunk-activity";
import { DetachFromBottomProvider } from "./DetachFromBottomCtx";
import { ManualOlderHistoryLoad } from "./ManualOlderHistoryLoad";
import { type RenderTreeResolvePermFn, renderTreeMessages } from "./MessageRenderer";
import {
	type BlockMeta,
	type CollectedSelectedText,
	MAX_COLLECTED_SELECTED_TEXT_CHARS,
	type MessageSelectionResolver,
	makeMessageBlockSelectionId,
} from "./MessageSelectionCtx";
import { filterChildrenByToolUse } from "./message-segments";
import { findMsgByToolUseIdInTree } from "./message-tree-utils";
import { findLatestSpecTasksToolUseId } from "./narrator-message-helpers";
import {
	type ContentBlock,
	type NarratorMsg,
	type PermissionCallbacks,
	STREAMING_CHUNKS_MSG_ID,
} from "./narrator-panel-types";
import { useRenderLod } from "./RenderLodCtx";
import { groupReasoningRuns } from "./reasoning-segments";
import { ScrollbarUserMarkers } from "./ScrollbarUserMarkers";
import { type ChunkData, useNarratorChunks } from "./useNarratorChunks";

/**
 * Chunk-virtualized message list (route 1: manifest-driven).
 *
 * The full chunk set comes from the manifest, so the scroll container is sized
 * to the entire history and the native scrollbar maps to real positions. Chunk
 * content is loaded sparsely on demand; the visible window (center ± the
 * viewport-resolved band radius, see resolveChunkBandRadius) is mounted as real
 * DOM, everything else is a height spacer.
 *
 * Scrollbar jumps (drag) are handled by binary-searching the cumulative chunk
 * heights to find the chunk under the viewport, jumping the center there, and
 * ensuring that band's content is loaded — which per-chunk advancement alone
 * could not do.
 *
 * Performance:
 *  - Each mounted chunk is a React.memo subcomponent that memoizes its
 *    renderTreeMessages output, so scrolling never re-renders unchanged chunks.
 *  - Heights are measured via ResizeObserver into a ref and flushed at most once
 *    per frame, never in a measure→setState loop.
 *
 * Position stability on prepend/mount relies on native scroll anchoring; mount/
 * unmount happens ≥bandRadius chunks from the viewport.
 */

const DATA_RETAIN_DISTANCE = 10;
const PER_MESSAGE_ESTIMATE = 120; // px, rough seed for unmeasured chunks
/** No height tolerance: repin only at the real bottom; pinned always follows any gap. */
const BOTTOM_DISTANCE_ZERO = 0;
/** Firefox/overlay scrollbars may report zero layout width until hovered. */
const SCROLLBAR_HIT_TARGET_PX = 18;

/** Scroll distance from the top within which an upward manifest expansion is
 * triggered (reverse infinite scroll). */
const OLDER_LOAD_TRIGGER_PX = 600;
const JUMP_TARGET_TIMEOUT_MS = 3000;
const SOFT_RANGE_SELECT_CHUNKS = 30;
const HARD_RANGE_SELECT_CHUNKS = 120;
/** Vertical gap between adjacent message items. */
const ITEM_GAP = 12;
/** Horizontal gutter kept on each side of the content column. */
const CONTENT_PADDING_X = "var(--mantine-spacing-md)";
const CONTENT_PADDING = `var(--mantine-spacing-md) ${CONTENT_PADDING_X} 0`;

/**
 * Named import rather than a positional `Parameters<...>[n]` lookup: that index
 * silently re-points at a different parameter whenever the (28-argument) render
 * signature changes, which is how it once started describing `onAskInPassing`.
 */
type ResolvePermFn = RenderTreeResolvePermFn;
type ExternalScrollRef = RefObject<HTMLElement | null> | ((node: HTMLDivElement | null) => void);
interface FollowTailOptions {
	force?: boolean;
	immediate?: boolean;
}

interface JumpTargetResolution {
	domIds: string[];
	highlightId?: string;
	/** Message id used as a fallback locator. A tool-only assistant message has
	 *  no `msg-<id>` element — its blocks render as `tool-use-<toolUseId>` divs
	 *  that carry `data-message-id`. When the id-based lookup misses, the jump
	 *  falls back to `[data-message-id="<messageId>"]` so such messages still
	 *  resolve. */
	messageId?: string;
}

type JumpTargetResolver = () => JumpTargetResolution;

/** Locate a jump target element by id (`msg-<id>` / `tool-use-<id>`) or, as a
 *  fallback for tool-only messages that have no `msg-<id>` node, by the nearest
 *  element carrying `data-message-id`. */
function findJumpTargetEl(res: JumpTargetResolution): HTMLElement | null {
	for (const domId of res.domIds) {
		const el = document.getElementById(domId);
		if (el) return el;
	}
	if (res.messageId) {
		const escaped =
			typeof CSS !== "undefined" && CSS.escape ? CSS.escape(res.messageId) : res.messageId;
		const el = document.querySelector<HTMLElement>(`[data-message-id="${escaped}"]`);
		if (el) return el;
	}
	return null;
}

function getScrollBottomTarget(el: HTMLElement): number {
	return Math.max(0, el.scrollHeight - el.clientHeight);
}

function getDistanceFromBottom(el: HTMLElement): number {
	return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
}

export interface ChunkedMessageListHandle {
	scrollToMessageTarget: (args: {
		domIds: string[];
		targetIds: string[];
		highlightId?: string;
	}) => Promise<boolean>;
	scrollToBottom: (instant?: boolean) => void;
	refreshStructure: (mode?: "diff" | "full") => void;
	detachFromBottom: () => void;
}

export interface ChunkTailMeta {
	statusReady?: boolean;
	lastRealMessage: {
		id: string;
		role: NarratorMsg["role"];
	} | null;
	lastUserMessageId?: string;
	contextPercent?: number | null;
	turnUsageJson?: NarratorMsg["turnUsageJson"] | null;
	pruneBoundaryMessageId?: string | null;
	prunedPercent?: number | null;
	/** Tool-use id of the most recent spec://tasks.json op; drives SpecTasksDetail spinner. */
	latestSpecTasksToolUseId?: string | null;
}

function isErrorSystemMessage(msg: NarratorMsg): boolean {
	return (
		msg.role === "system" &&
		Array.isArray(msg.contentJson) &&
		msg.contentJson.some((block: { type?: unknown }) => block?.type === "error")
	);
}

/**
 * Latest spec://tasks.json tool-use id across chunks. Scans chunks tail-first and
 * stops at the first chunk that contains any tasks op (returning the last match
 * within it), so a long history is not fully traversed on every tail refresh.
 */
function findLatestSpecTasksToolUseIdInChunks(chunks: ChunkData[]): string | null {
	for (let chunkIndex = chunks.length - 1; chunkIndex >= 0; chunkIndex--) {
		const messages = chunks[chunkIndex]?.messages as NarratorMsg[] | undefined;
		if (!messages?.length) continue;
		const found = findLatestSpecTasksToolUseId(messages);
		if (found) return found;
	}
	return null;
}

function buildChunkTailMeta(
	chunks: ChunkData[],
	statusReady: boolean,
	pruneBoundaryMessageId: string | null,
	prunedPercent: number | null,
): ChunkTailMeta {
	const latestSpecTasksToolUseId = findLatestSpecTasksToolUseIdInChunks(chunks);
	let lastRealMessage: ChunkTailMeta["lastRealMessage"] = null;
	let lastUserMessageId: string | undefined;
	let contextPercent: number | null | undefined;
	let turnUsageJson: NarratorMsg["turnUsageJson"] | null | undefined;
	for (let chunkIndex = chunks.length - 1; chunkIndex >= 0; chunkIndex--) {
		const messages = chunks[chunkIndex]?.messages;
		if (!messages?.length) continue;
		for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
			const msg = messages[messageIndex] as NarratorMsg;
			const id = typeof msg.id === "string" ? msg.id : undefined;
			if (!id) continue;
			if (!lastRealMessage && id !== STREAMING_CHUNKS_MSG_ID && !isErrorSystemMessage(msg)) {
				lastRealMessage = { id, role: msg.role };
			}
			if (!lastUserMessageId && msg.role === "user" && !id.startsWith("optimistic-")) {
				lastUserMessageId = id;
			}
			if (contextPercent == null && msg.contextPercent != null) {
				contextPercent = msg.contextPercent;
				turnUsageJson = msg.turnUsageJson ?? null;
			}
			if (lastRealMessage && lastUserMessageId && contextPercent != null) {
				return {
					statusReady,
					lastRealMessage,
					lastUserMessageId,
					contextPercent,
					turnUsageJson,
					pruneBoundaryMessageId,
					prunedPercent,
					latestSpecTasksToolUseId,
				};
			}
		}
	}
	return {
		statusReady,
		lastRealMessage,
		lastUserMessageId,
		contextPercent,
		turnUsageJson,
		pruneBoundaryMessageId,
		latestSpecTasksToolUseId,
		prunedPercent,
	};
}

function assignExternalRef<T>(
	ref: RefObject<T | null> | ((node: T | null) => void) | undefined,
	node: T | null,
) {
	if (!ref) return;
	if (typeof ref === "function") {
		ref(node);
		return;
	}
	(ref as { current: T | null }).current = node;
}

function assignScrollRef(ref: ExternalScrollRef | undefined, node: HTMLDivElement | null) {
	if (!ref) return;
	if (typeof ref === "function") {
		ref(node);
		return;
	}
	(ref as { current: HTMLElement | null }).current = node;
}

function findMessageById(messages: NarratorMsg[], messageId: string): NarratorMsg | null {
	for (const msg of messages) {
		if (msg.id === messageId) return msg;
		if (msg.children?.length) {
			const child = findMessageById(msg.children, messageId);
			if (child) return child;
		}
	}
	return null;
}

function getMessageSeq(msg: NarratorMsg | null | undefined): number | null {
	const seq = msg?.seq;
	return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
}

function findUserMessageIdBySeq(chunks: ChunkData[], seq: number): string | undefined {
	for (const chunk of chunks) {
		for (const msg of chunk.messages ?? []) {
			if (msg.role === "user" && msg.id && getMessageSeq(msg) === seq) return msg.id;
		}
	}
	return undefined;
}

function waitAnimationFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

interface SelectionEntry extends BlockMeta {
	seq: number;
	chunkIndex: number;
	/** All original indices represented by this visual entry. */
	blockIndices: number[];
	copyText: string;
}

interface SelectionIndex {
	entries: SelectionEntry[];
	byBlockId: Map<string, SelectionEntry>;
}

function stableStringify(value: unknown, maxChars = 4000): string {
	if (value == null) return "";
	// `stringifyForDisplay` renders any truncated LEAF as its preview text instead
	// of dumping the wrapper's own `{_truncated,preview,fullLength}` structure into
	// what the user copies.
	const text = typeof value === "string" ? value : stringifyForDisplay(value);
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function getBlockCopyText(block: ContentBlock): string {
	if (typeof block.text === "string") return block.text;
	if (typeof block.thinking === "string") return block.thinking;
	if (block.type === "text_file") {
		return [block.filename, typeof block.size === "number" ? `${block.size} bytes` : null]
			.filter(Boolean)
			.join(" ");
	}
	if (block.type === "web_search") {
		const query = typeof block.query === "string" ? block.query : undefined;
		const queries = Array.isArray(block.queries) ? block.queries.map(String).join(", ") : undefined;
		return ["Web search", query ?? queries, block.status].filter(Boolean).join(": ");
	}
	if (block.type === "image_generation") {
		return ["Image generation", block.revisedPrompt, block.savedPath ?? block.partialSavedPath]
			.filter(Boolean)
			.join("\n");
	}
	if (block.type === "image") return "[Image]";
	if (block.type === "tool_use") {
		return [`Tool: ${block.name ?? block.id ?? "unknown"}`, stableStringify(block.input)]
			.filter(Boolean)
			.join("\n");
	}
	return stableStringify(block);
}

function isSubagentTool(msg: NarratorMsg, block: ContentBlock): boolean {
	if (block.type !== "tool_use" || typeof block.id !== "string") return false;
	if (block.name === "Agent") return true;
	const children = filterChildrenByToolUse(msg.children ?? [], block.id);
	return children.length > 0;
}

function isSelectableBlock(block: ContentBlock): boolean {
	if (block.type === "text") return !!block.text?.trim();
	if (block.type === "reasoning" || block.type === "thinking") {
		return !!(block.text?.trim() || block.thinking?.trim());
	}
	return block.type === "web_search" || block.type === "tool_use";
}

function getReasoningRunCopyText(blocks: ContentBlock[]): string {
	return blocks
		.map((block) => block.text || block.thinking || "")
		.filter((text) => text.length > 0)
		.join("\n\n");
}

function getUserMessageCopyText(msg: NarratorMsg): string {
	if (msg.contentText?.trim()) return msg.contentText;
	const parts: string[] = [];
	for (const block of (msg.contentJson ?? []) as ContentBlock[]) {
		if (block.type === "text" && block.text?.trim()) parts.push(block.text);
	}
	return parts.join("\n\n");
}

function addSelectionAlias(
	index: SelectionIndex,
	alias: string | undefined,
	entry: SelectionEntry,
) {
	if (alias) index.byBlockId.set(alias, entry);
}

function buildSelectionIndex(chunks: ChunkData[]): SelectionIndex {
	const index: SelectionIndex = { entries: [], byBlockId: new Map() };
	for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
		const messages = chunks[chunkIndex]?.messages ?? [];
		for (const msg of messages) {
			const seq = getMessageSeq(msg);
			if (!msg.id || seq == null || !Array.isArray(msg.contentJson)) continue;
			const userCopyText = msg.role === "user" ? getUserMessageCopyText(msg) : "";
			const reasoningGrouping =
				msg.role === "user"
					? { runs: [], skip: new Set<number>() }
					: groupReasoningRuns(msg.contentJson);
			const reasoningRunByStart = new Map(
				reasoningGrouping.runs.map((run) => [run.startIndex, run] as const),
			);
			for (let blockIndex = 0; blockIndex < msg.contentJson.length; blockIndex++) {
				if (reasoningGrouping.skip.has(blockIndex)) continue;
				const block = msg.contentJson[blockIndex] as ContentBlock;
				if (!block || typeof block !== "object") continue;
				if (msg.role === "user" && blockIndex > 0) continue;

				const reasoningRun = reasoningRunByStart.get(blockIndex);
				const blockIndices = reasoningRun?.indices ?? [blockIndex];
				const representedBlocks = blockIndices.map(
					(index) => msg.contentJson[index] as ContentBlock,
				);
				if (
					msg.role !== "user" &&
					!(reasoningRun
						? representedBlocks.some((candidate) => isSelectableBlock(candidate))
						: isSelectableBlock(block))
				)
					continue;

				const isTool = block.type === "tool_use" && typeof block.id === "string";
				const primaryId = isTool
					? isSubagentTool(msg, block)
						? `sa-${block.id}`
						: `tc-${block.id}`
					: makeMessageBlockSelectionId(msg.id, blockIndex);
				const entry: SelectionEntry = {
					blockId: primaryId,
					messageId: msg.id,
					blockIndex,
					blockIndices,
					seq,
					chunkIndex,
					copyText:
						msg.role === "user"
							? userCopyText
							: reasoningRun
								? getReasoningRunCopyText(representedBlocks)
								: getBlockCopyText(block),
				};
				index.entries.push(entry);
				index.byBlockId.set(primaryId, entry);
				index.byBlockId.set(makeMessageBlockSelectionId(msg.id, blockIndex), entry);
				if (isTool) {
					addSelectionAlias(index, `tc-${block.id}`, entry);
					addSelectionAlias(index, `sa-${block.id}`, entry);
				}
			}
		}
	}
	index.entries.sort((a, b) => a.seq - b.seq || a.blockIndex - b.blockIndex);
	return index;
}

function entriesToBlockMeta(entries: SelectionEntry[], selectedIds: Set<string>): BlockMeta[] {
	const seen = new Set<string>();
	const out: BlockMeta[] = [];
	for (const entry of entries) {
		if (!selectedIds.has(entry.blockId)) continue;
		for (const blockIndex of entry.blockIndices) {
			const key = `${entry.messageId}:${blockIndex}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ blockId: entry.blockId, messageId: entry.messageId, blockIndex });
		}
	}
	return out;
}

function entriesToMessageIds(entries: SelectionEntry[], selectedIds: Set<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of entries) {
		if (!selectedIds.has(entry.blockId) || seen.has(entry.messageId)) continue;
		seen.add(entry.messageId);
		out.push(entry.messageId);
	}
	return out;
}

function readMountedBlockMeta(blockId: string): BlockMeta | null {
	const nodes = document.querySelectorAll<HTMLElement>("[data-block-id]");
	for (const node of nodes) {
		if (node.getAttribute("data-block-id") !== blockId) continue;
		const messageId = node.getAttribute("data-message-id");
		const blockIndexText = node.getAttribute("data-block-index");
		const blockIndex = blockIndexText == null ? Number.NaN : Number(blockIndexText);
		if (!messageId || !Number.isInteger(blockIndex) || blockIndex < 0) return null;
		return { blockId, messageId, blockIndex };
	}
	return null;
}

function entriesToText(entries: SelectionEntry[], selectedIds: Set<string>): CollectedSelectedText {
	const parts: string[] = [];
	let remaining = MAX_COLLECTED_SELECTED_TEXT_CHARS;
	let truncated = false;
	for (const entry of entries) {
		if (!selectedIds.has(entry.blockId)) continue;
		const text = entry.copyText.trim();
		if (!text) continue;
		const separator = parts.length > 0 ? "\n\n" : "";
		const available = remaining - separator.length;
		if (available <= 0) {
			truncated = true;
			break;
		}
		parts.push(separator);
		if (text.length > available) {
			parts.push(text.slice(0, available));
			truncated = true;
			break;
		}
		parts.push(text);
		remaining -= separator.length + text.length;
	}
	return { text: parts.join(""), truncated };
}

// ── Permission keying (fine-grained, avoids re-render on unrelated perm churn) ──

function collectToolUseIds(messages: NarratorMsg[], out: Set<string>): void {
	for (const msg of messages) {
		const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
		for (const b of blocks) {
			if (b?.type === "tool_use" && typeof b.id === "string") out.add(b.id);
		}
		for (const tc of msg.toolCalls ?? []) {
			if (tc.toolUseId) out.add(tc.toolUseId);
		}
		if (msg.children?.length) collectToolUseIds(msg.children, out);
	}
}

function getPermissionSignature(permCb: PermissionCallbacks): string {
	const single = permCb.pendingPermission?.toolUseId ?? "";
	const perms = permCb.pendingPermissions;
	if (perms.length === 0 && !single) return "";
	const keys = perms.map((p) => p.toolUseId).sort();
	return `${single}|${keys.join(",")}`;
}

function computePermKey(messages: NarratorMsg[], permCb: PermissionCallbacks): string {
	const perms = permCb.pendingPermissions;
	const single = permCb.pendingPermission?.toolUseId;
	if (perms.length === 0 && !single) return "";
	const ids = new Set<string>();
	collectToolUseIds(messages, ids);
	if (ids.size === 0) return "";
	const permIds = new Set(perms.map((p) => p.toolUseId));
	const hits: string[] = [];
	for (const id of ids) {
		if (permIds.has(id) || id === single) hits.push(id);
	}
	if (hits.length === 0) return "";
	hits.sort();
	return hits.join(",");
}

// ── Mounted chunk (memoized) ───────────────────────────────────────────────

interface MountedChunkProps {
	chunkId: string;
	messages: NarratorMsg[];
	narratorId: string;
	permCb: PermissionCallbacks;
	permKey: string;
	hasChapter?: boolean;
	onForkFromMessage?: (messageId: string) => void;
	highlightedId?: string | null;
	showTokenUsage?: boolean;
	pruneBoundaryMessageId?: string | null;
	pruneDividerLabel?: string;
	onCompactBeforeMessage?: (messageId: string) => void;
	onClearContextBefore?: (messageId: string) => void;
	onManualSummarize?: (messageId: string) => void;
	onDeleteBlock?: (messageId: string, blockIndex: number) => void;
	onRollbackToBlock?: (messageId: string, blockIndex: number) => void;
	onEditAndRegenerate?: (
		messageId: string,
		newContent: string,
		revertOpts: { skipRevert: boolean; scope?: RevertScope },
		opts?: {
			keepImageIds: string[];
			newImages: File[];
			keepTextFilePaths: string[];
			newTextFiles: File[];
		},
	) => Promise<boolean>;
	onEditAssistantMessage?: (messageId: string, newContent: string) => void;
	onRestoreAssistantMessage?: (messageId: string) => void;
	lastUserMessageId?: string;
	onViewSubagentSession?: (narratorId: string) => void;
	/** Open a child session from a folded trace row (falls back to the above). */
	onViewSubagentSessionFolded?: (narratorId: string) => void;
	/** Detach a running subagent to a background task (folded trace rows only). */
	onDetachSubagent?: (narratorId: string) => void;
	/** Cancel a background subagent task (folded trace rows only). */
	onCancelBackgroundTask?: (narratorId: string) => void;
	/** Open a file-oriented tool's path (or a text attachment) in a file panel. */
	onOpenFilePanel?: (filePath: string) => void;
	resolvePerm?: ResolvePermFn;
	onAskInPassing?: (messageUuid: string | null, messageId: string) => void;
	/** Synthetic streaming message injected into the tail render-chunk only. */
	streamingMsg?: NarratorMsg | null;
	onMeasure: (chunkId: string, height: number) => void;
	/** Cross-chunk owner/continuation overrides for this chunk's activity units. */
	activityOverrides?: ActivityRenderOverrides;
}

const MountedChunk = memo(function MountedChunk({
	chunkId,
	messages,
	narratorId,
	permCb,
	permKey,
	hasChapter,
	onForkFromMessage,
	highlightedId,
	showTokenUsage,
	pruneBoundaryMessageId,
	pruneDividerLabel,
	onCompactBeforeMessage,
	onClearContextBefore,
	onManualSummarize,
	onDeleteBlock,
	onRollbackToBlock,
	onEditAndRegenerate,
	onEditAssistantMessage,
	onRestoreAssistantMessage,
	lastUserMessageId,
	onViewSubagentSession,
	onViewSubagentSessionFolded,
	onDetachSubagent,
	onCancelBackgroundTask,
	onOpenFilePanel,
	resolvePerm,
	onAskInPassing,
	streamingMsg,
	onMeasure,
	activityOverrides,
}: MountedChunkProps) {
	const ref = useRef<HTMLDivElement>(null);
	const onMeasureRef = useRef(onMeasure);
	onMeasureRef.current = onMeasure;
	const permCbRef = useRef(permCb);
	permCbRef.current = permCb;
	// Current render LOD — drives the L1/L2 unified activity fold inside
	// renderTreeMessages. Read here (context) so a level change re-renders this
	// chunk and recomputes its segments.
	const renderLod = useRenderLod();

	// Render once per stable `messages` reference; re-render only when this chunk's
	// render-affecting props change. `permKey` captures permission relevance
	// without making every chunk rerender on unrelated permission churn.
	// biome-ignore lint/correctness/useExhaustiveDependencies: permCb read via ref; permKey captures permission relevance
	const elements = useMemo(
		() =>
			renderTreeMessages(
				messages,
				narratorId,
				onForkFromMessage,
				highlightedId ?? null,
				permCbRef.current,
				showTokenUsage,
				pruneBoundaryMessageId,
				pruneDividerLabel,
				onCompactBeforeMessage,
				onClearContextBefore,
				onManualSummarize,
				onDeleteBlock,
				onRollbackToBlock,
				onEditAndRegenerate,
				onEditAssistantMessage,
				onRestoreAssistantMessage,
				lastUserMessageId,
				hasChapter,
				onViewSubagentSession,
				streamingMsg ?? null,
				resolvePerm,
				onAskInPassing,
				false,
				renderLod,
				activityOverrides,
				{
					onViewSubagentSession: onViewSubagentSessionFolded,
					onDetachSubagent,
					onCancelBackgroundTask,
					onOpenFilePanel,
				},
			).elements,
		[
			messages,
			narratorId,
			onForkFromMessage,
			highlightedId,
			permKey,
			showTokenUsage,
			pruneBoundaryMessageId,
			pruneDividerLabel,
			onCompactBeforeMessage,
			onClearContextBefore,
			onManualSummarize,
			onDeleteBlock,
			onRollbackToBlock,
			onEditAndRegenerate,
			onEditAssistantMessage,
			onRestoreAssistantMessage,
			lastUserMessageId,
			hasChapter,
			onViewSubagentSession,
			onViewSubagentSessionFolded,
			onDetachSubagent,
			onCancelBackgroundTask,
			onOpenFilePanel,
			streamingMsg,
			resolvePerm,
			onAskInPassing,
			renderLod,
			activityOverrides,
		],
	);

	useEffect(() => {
		const node = ref.current;
		if (!node) return;
		const report = () => {
			const h = node.getBoundingClientRect().height;
			if (h > 0) onMeasureRef.current(chunkId, h);
		};
		report();
		const ro = new ResizeObserver(report);
		ro.observe(node);
		return () => ro.disconnect();
	}, [chunkId]);

	return (
		<div ref={ref}>
			{elements.map((element, index) => (
				<div
					key={isValidElement(element) && element.key != null ? element.key : index}
					style={{ paddingBottom: ITEM_GAP }}
				>
					{element}
				</div>
			))}
		</div>
	);
});

// ── List ───────────────────────────────────────────────────────────────────

interface ChunkedMessageListProps {
	narratorId: string;
	/** True when this list renders a subagent's OWN page (messages carry a
	 * parentToolUseId pointing at the parent narrator's tool_use, but must be
	 * treated as top-level here — mirrors the server's isSubagent flattening). */
	isSubagent?: boolean;
	/** Mobile uses a fixed layout control above the scroller because the virtual top spacer
	 * can keep the in-flow manifest-origin control far outside the visible window. */
	isMobileViewport?: boolean;
	permCb: PermissionCallbacks;
	hasChapter?: boolean;
	onForkFromMessage?: (messageId: string) => void;
	highlightedId?: string | null;
	highlightMessageId?: string;
	onHighlightTarget?: (id: string, delayMs: number) => void;
	showTokenUsage?: boolean;
	pruneBoundaryMessageId?: string | null;
	pruneDividerLabel?: string;
	onCompactBeforeMessage?: (messageId: string) => void;
	onClearContextBefore?: (messageId: string) => void;
	onManualSummarize?: (messageId: string) => void;
	onDeleteBlock?: (messageId: string, blockIndex: number) => void;
	onRollbackToBlock?: (messageId: string, blockIndex: number) => void;
	onEditAndRegenerate?: (
		messageId: string,
		newContent: string,
		revertOpts: { skipRevert: boolean; scope?: RevertScope },
		opts?: {
			keepImageIds: string[];
			newImages: File[];
			keepTextFilePaths: string[];
			newTextFiles: File[];
		},
	) => Promise<boolean>;
	onEditAssistantMessage?: (messageId: string, newContent: string) => void;
	onRestoreAssistantMessage?: (messageId: string) => void;
	lastUserMessageId?: string;
	onViewSubagentSession?: (narratorId: string) => void;
	/**
	 * Open a child session from a FOLDED trace row (low LOD). Distinct from
	 * `onViewSubagentSession` because the expanded SubagentCard owns its own
	 * routing fallback while a folded row has none — a standalone panel supplies
	 * the plain routing handler here. Falls back to `onViewSubagentSession`.
	 */
	onViewSubagentSessionFolded?: (narratorId: string) => void;
	/**
	 * Detach a running subagent to a background task. Needed only by the FOLDED
	 * trace rows (low LOD) — the expanded SubagentCard calls the api itself.
	 */
	onDetachSubagent?: (narratorId: string) => void;
	/** Cancel a background subagent task (folded rows only, see above). */
	onCancelBackgroundTask?: (narratorId: string) => void;
	/**
	 * Open a file path in a read-only dock panel — used by file-oriented tool rows
	 * and by user text-file attachments. Supplied only by hosts that own a dockview
	 * surface (focus page / workspace); absent → those affordances are hidden.
	 */
	onOpenFilePanel?: (filePath: string) => void;
	resolvePerm?: ResolvePermFn;
	onAskInPassing?: (messageUuid: string | null, messageId: string) => void;
	scrollRef?: ExternalScrollRef;
	contentRef?: RefObject<HTMLDivElement | null>;
	onSelectionResolverChange?: (resolver: MessageSelectionResolver | null) => void;
	onAtBottomChange?: (atBottom: boolean) => void;
	onUnreadCountChange?: (count: number) => void;
	onTailMetaChange?: (meta: ChunkTailMeta) => void;
	/** Optional footer element rendered at the absolute bottom after all chunks. */
	tailFooter?: React.ReactNode;
	/**
	 * Step the render LOD up (1 = more detail) or down (-1 = less detail).
	 * Wired to alt+wheel and pinch gestures on the scroll container.
	 */
	onLodStep?: (dir: 1 | -1) => void;
}

const ChunkedMessageListImpl = forwardRef<ChunkedMessageListHandle, ChunkedMessageListProps>(
	function ChunkedMessageList(
		{
			narratorId,
			isSubagent,
			isMobileViewport,
			permCb,
			hasChapter,
			onForkFromMessage,
			highlightedId,
			highlightMessageId,
			onHighlightTarget,
			showTokenUsage,
			pruneBoundaryMessageId,
			pruneDividerLabel,
			onCompactBeforeMessage,
			onClearContextBefore,
			onManualSummarize,
			onDeleteBlock,
			onRollbackToBlock,
			onEditAndRegenerate,
			onEditAssistantMessage,
			onRestoreAssistantMessage,
			lastUserMessageId,
			onViewSubagentSession,
			onViewSubagentSessionFolded,
			onDetachSubagent,
			onCancelBackgroundTask,
			onOpenFilePanel,
			resolvePerm,
			onAskInPassing,
			scrollRef,
			contentRef,
			onSelectionResolverChange,
			onAtBottomChange,
			onUnreadCountChange,
			onTailMetaChange,
			tailFooter,
			onLodStep,
		},
		ref,
	) {
		// Follow the tail when a new message lands and the viewport is pinned to the
		// bottom. WS can fire before React commits DOM, so the actual controller below
		// is also driven by ResizeObserver/MutationObserver on the rendered content.
		const scrollerRef = useRef<HTMLDivElement>(null);
		const contentNodeRef = useRef<HTMLDivElement>(null);
		// Render LOD: read the current level (drives the anchor-restore effect) and
		// expose a stable ref to the step handler for the `[]` gesture effect below.
		const renderLod = useRenderLod();
		const onLodStepRef = useRef<((dir: 1 | -1) => void) | undefined>(onLodStep);
		onLodStepRef.current = onLodStep;
		const { captureAnchor } = useLodAnchor(scrollerRef, renderLod);
		const captureAnchorRef = useRef(captureAnchor);
		captureAnchorRef.current = captureAnchor;
		const setScrollerNode = useCallback(
			(node: HTMLDivElement | null) => {
				scrollerRef.current = node;
				assignScrollRef(scrollRef, node);
			},
			[scrollRef],
		);
		const setContentNode = useCallback(
			(node: HTMLDivElement | null) => {
				contentNodeRef.current = node;
				assignExternalRef(contentRef, node);
			},
			[contentRef],
		);
		const setIsAtBottomRef = useRef<(atBottom: boolean) => void>(() => {});
		const pinnedToBottomRef = useRef(true);
		const followRafRef = useRef(0);
		const followingRef = useRef(false);
		const scheduleFollowTailRef = useRef<(options?: FollowTailOptions) => void>(() => {});
		const stopFollowTailRef = useRef<() => void>(() => {});
		/** Synchronously detach from the bottom (stop the follow loop + unpin).
		 * Called directly from wheel/touch/key input handlers so a deliberate
		 * scroll-up takes effect immediately instead of waiting for the rAF-throttled
		 * scroll handler — otherwise the follow loop keeps yanking scrollTop back to
		 * the bottom and the user "can't scroll up". */
		const detachFromBottomRef = useRef<() => void>(() => {});
		const followTail = useCallback(() => {
			scheduleFollowTailRef.current();
		}, []);
		const { t } = useTranslation("narrator");
		// Reading-width preference: OFF (default) fills the viewport, ON caps the
		// content column at a centered reading width (same option the vlist reads).
		const [centeredColumn] = useLocalPref("narrafork_narrator_centered_column");
		const contentColumnStyle = useMemo(
			() => ({
				padding: CONTENT_PADDING,
				maxWidth: resolveNarratorColumnMaxWidth(centeredColumn, CONTENT_PADDING_X),
				marginInline: "auto",
			}),
			[centeredColumn],
		);

		// How many chunks are mounted/loaded on each side of the window centre. One
		// shared code path, parameterized by viewport: a phone renders a much smaller
		// band because the desktop band costs ~750KB and 60 extra messages of
		// main-thread work at first paint (see resolveChunkBandRadius).
		const bandRadius = resolveChunkBandRadius(isMobileViewport);
		const bandRadiusRef = useRef(bandRadius);
		bandRadiusRef.current = bandRadius;
		const {
			data: userPrefs,
			isFetched: userPrefsFetched,
			isLoading: userPrefsLoading,
		} = useUserPreferences();
		// Do not transiently auto-load while the authoritative preference is still
		// loading: a persisted `false` must win before any mobile scroll gesture can
		// expand history. On request failure, preserve the server default (`true`).
		const autoLoadEnabled = resolveOlderHistoryAutoLoadEnabled(
			userPrefs?.autoLoadOlderMessages,
			userPrefsLoading,
		);
		const {
			chunks,
			loading,
			ensureLoaded,
			ensureLoadedRange,
			retainChunkRange,
			refreshStructure,
			streamingMsg,
			tailChunkId,
			hasOlderChunks,
			loadOlderManifest,
			getManifestSnapshot,
			ensureManifestCoversSeq,
			pruneBoundaryMessageId: chunkPruneBoundaryMessageId,
			prunedPercent: chunkPrunedPercent,
			setIsAtBottom,
			unreadCount,
			resetUnread,
		} = useNarratorChunks(narratorId, { onTailFollow: followTail, isSubagent });
		const showManualOlderHistoryLoad =
			userPrefsFetched && userPrefs?.autoLoadOlderMessages === false && hasOlderChunks;
		const tailMetaNarratorIdRef = useRef(narratorId);
		const tailMetaSwitchingNarrator = tailMetaNarratorIdRef.current !== narratorId;
		if (tailMetaSwitchingNarrator) tailMetaNarratorIdRef.current = narratorId;
		const tailLoadedForMeta =
			tailChunkId == null
				? !loading
				: chunks.length > 0 && chunks[chunks.length - 1]?.messages != null;
		const tailMeta = useMemo<ChunkTailMeta>(
			() =>
				tailMetaSwitchingNarrator
					? { statusReady: false, lastRealMessage: null }
					: buildChunkTailMeta(
							chunks,
							tailLoadedForMeta,
							chunkPruneBoundaryMessageId,
							chunkPrunedPercent,
						),
			[
				chunks,
				tailMetaSwitchingNarrator,
				tailLoadedForMeta,
				chunkPruneBoundaryMessageId,
				chunkPrunedPercent,
			],
		);
		useEffect(() => {
			onTailMetaChange?.(tailMeta);
		}, [onTailMetaChange, tailMeta]);
		const heightsRef = useRef<Map<string, number>>(new Map());
		// Running per-message height derived from measured chunks. Unmeasured
		// chunks are seeded with this (when available) instead of the fixed
		// PER_MESSAGE_ESTIMATE, so tall histories (big tool outputs / subagent
		// cards) don't systematically under-size the top spacer — which would
		// otherwise let the scroll position bottom-out before the earliest chunks
		// are reachable.
		const measuredPerMsgRef = useRef<number | null>(null);

		const estimateHeight = useCallback((chunk: ChunkData) => {
			const measured = heightsRef.current.get(chunk.id);
			if (measured != null) return measured;
			const perMsg = measuredPerMsgRef.current ?? PER_MESSAGE_ESTIMATE;
			return chunk.count * perMsg;
		}, []);

		// Center of the mounted window, anchored by chunk ID so it survives the
		// manifest growing/shifting. `null` = follow the tail (newest chunk).
		const [centerChunkId, setCenterChunkId] = useState<string | null>(null);
		// Continuous-scroll center updates mount a whole chunk band (~CHUNK_SIZE
		// heavy messages) in one commit, which blocks the main thread for ~2s when
		// crossing unmounted history. Mark *only the scroll-driven* recenter as a
		// transition so React can time-slice that band render and keep scrolling
		// responsive. Jump/follow/init recenter stay synchronous (need immediate
		// positioning). Tradeoff: during fast scroll the band may show its
		// height-reserved spacer until the transition commits.
		const [, startCenterTransition] = useTransition();
		const chunkIndexById = useMemo(() => {
			const m = new Map<string, number>();
			for (let i = 0; i < chunks.length; i++) m.set(chunks[i].id, i);
			return m;
		}, [chunks]);
		const chunkIndexByIdRef = useRef(chunkIndexById);
		chunkIndexByIdRef.current = chunkIndexById;
		const centerIndex =
			centerChunkId != null && chunkIndexById.has(centerChunkId)
				? (chunkIndexById.get(centerChunkId) as number)
				: Math.max(0, chunks.length - 1);

		const mountedRange = useMemo(() => {
			const start = Math.max(0, centerIndex - bandRadius);
			const end = Math.min(chunks.length - 1, centerIndex + bandRadius);
			return { start, end };
		}, [centerIndex, chunks.length, bandRadius]);
		useEffect(() => {
			if (chunks.length === 0) return;
			retainChunkRange(
				Math.max(0, centerIndex - DATA_RETAIN_DISTANCE),
				Math.min(chunks.length - 1, centerIndex + DATA_RETAIN_DISTANCE),
			);
		}, [centerIndex, chunks.length, retainChunkRange]);

		// Measurement flush: write heights into ref, bump a version at most once per
		// frame so spacer heights / prefix sums recompute without a measure loop.
		const [heightVersion, setHeightVersion] = useState(0);
		const flushRafRef = useRef(0);
		const pendingFlushRef = useRef(false);
		const onMeasure = useCallback((chunkId: string, height: number) => {
			const prev = heightsRef.current.get(chunkId);
			if (prev != null && Math.abs(prev - height) < 1) return;
			heightsRef.current.set(chunkId, height);
			// Recompute the running per-message height from all measured chunks so
			// unmeasured chunks get a realistic estimate (see measuredPerMsgRef).
			{
				let totalHeight = 0;
				let totalCount = 0;
				const byId = chunkIndexByIdRef.current;
				const list = chunksRef.current;
				for (const [id, h] of heightsRef.current) {
					const idx = byId.get(id);
					const count = idx != null ? list[idx]?.count : undefined;
					if (count && count > 0) {
						totalHeight += h;
						totalCount += count;
					}
				}
				if (totalCount > 0) measuredPerMsgRef.current = totalHeight / totalCount;
			}
			if (pendingFlushRef.current) return;
			pendingFlushRef.current = true;
			flushRafRef.current = requestAnimationFrame(() => {
				pendingFlushRef.current = false;
				setHeightVersion((v) => v + 1);
				if (pinnedToBottomRef.current) scheduleFollowTailRef.current();
			});
		}, []);
		useEffect(() => () => cancelAnimationFrame(flushRafRef.current), []);

		// Prefix sums of chunk heights for O(log n) scroll→chunk lookup and exact
		// spacer sizing. Recomputed when chunks or measured heights change.
		// biome-ignore lint/correctness/useExhaustiveDependencies: heightVersion forces recompute after a measurement flush
		const prefix = useMemo(() => {
			const arr = new Array(chunks.length + 1);
			arr[0] = 0;
			for (let i = 0; i < chunks.length; i++) arr[i + 1] = arr[i] + estimateHeight(chunks[i]);
			return arr as number[];
		}, [chunks, estimateHeight, heightVersion]);

		const topSpacer = prefix[mountedRange.start] ?? 0;
		const bottomSpacer = (prefix[chunks.length] ?? 0) - (prefix[mountedRange.end + 1] ?? 0);

		const chunksRef = useRef(chunks);
		chunksRef.current = chunks;
		const prefixRef = useRef(prefix);
		prefixRef.current = prefix;
		const ensureLoadedRef = useRef(ensureLoaded);
		ensureLoadedRef.current = ensureLoaded;
		const hasOlderChunksRef = useRef(hasOlderChunks);
		hasOlderChunksRef.current = hasOlderChunks;
		const loadOlderManifestRef = useRef(loadOlderManifest);
		loadOlderManifestRef.current = loadOlderManifest;
		const getManifestSnapshotRef = useRef(getManifestSnapshot);
		getManifestSnapshotRef.current = getManifestSnapshot;
		const ensureManifestCoversSeqRef = useRef(ensureManifestCoversSeq);
		ensureManifestCoversSeqRef.current = ensureManifestCoversSeq;
		// Guards an upward manifest expansion + its scroll-position compensation,
		// so a single trigger doesn't stack while the prepended band mounts.
		const expandingOlderRef = useRef(false);
		// Auto expansion requires a recent explicit user gesture toward older history.
		// Programmatic scrolls (initial bottom snap, jump settling, prepend compensation)
		// therefore cannot recursively pull more manifest pages on their own.
		const olderHistoryIntentAtRef = useRef<number | null>(null);
		// Drives the manual "load older" button's loading state (only meaningful
		// when auto-load is disabled).
		const [loadingOlder, setLoadingOlder] = useState(false);
		const updateAtBottom = useCallback(
			(atBottom: boolean) => {
				setIsAtBottom(atBottom);
				onAtBottomChange?.(atBottom);
			},
			[onAtBottomChange, setIsAtBottom],
		);
		setIsAtBottomRef.current = updateAtBottom;
		const stopFollowTail = useCallback(() => {
			followingRef.current = false;
			if (followRafRef.current) {
				cancelAnimationFrame(followRafRef.current);
				followRafRef.current = 0;
			}
		}, []);
		stopFollowTailRef.current = stopFollowTail;
		const setPinnedToBottom = useCallback(
			(pinned: boolean) => {
				pinnedToBottomRef.current = pinned;
				updateAtBottom(pinned);
			},
			[updateAtBottom],
		);
		// Synchronous detach used by the input handlers. Idempotent: a no-op once
		// already detached, so repeated wheel ticks don't thrash state.
		const detachFromBottom = useCallback(() => {
			if (!pinnedToBottomRef.current && !followingRef.current) return;
			stopFollowTail();
			setPinnedToBottom(false);
		}, [setPinnedToBottom, stopFollowTail]);
		detachFromBottomRef.current = detachFromBottom;
		const scheduleFollowTail = useCallback(
			(options: FollowTailOptions = {}) => {
				const el = scrollerRef.current;
				if (!el) return;
				const force = options.force === true;
				if (force) {
					setCenterChunkId(null);
					setPinnedToBottom(true);
					resetUnread();
					onUnreadCountChange?.(0);
				} else if (!pinnedToBottomRef.current && getDistanceFromBottom(el) > BOTTOM_DISTANCE_ZERO) {
					return;
				} else {
					setPinnedToBottom(true);
				}
				if (followingRef.current) {
					if (!force) return;
					stopFollowTail();
				}
				followingRef.current = true;

				const step = () => {
					const node = scrollerRef.current;
					if (!node) {
						followingRef.current = false;
						followRafRef.current = 0;
						return;
					}
					const distance = getDistanceFromBottom(node);
					// Deliberate scroll-ups detach synchronously in the input handlers
					// (which cancel this loop), so we do NOT detach on a scrollTop decrease
					// here — that would misread browser scroll-anchoring (after an
					// above-viewport height re-measure) as a user scroll-up. The only exit
					// is "someone unpinned us" (e.g. the synchronous detach just ran).
					if (!pinnedToBottomRef.current && distance > BOTTOM_DISTANCE_ZERO) {
						followingRef.current = false;
						followRafRef.current = 0;
						return;
					}
					const target = getScrollBottomTarget(node);
					const gap = target - node.scrollTop;
					if (gap <= 1) {
						node.scrollTop = target;
						followingRef.current = false;
						followRafRef.current = 0;
						setPinnedToBottom(true);
						return;
					}
					node.scrollTop = options.immediate ? target : node.scrollTop + Math.max(gap * 0.35, 2);
					followRafRef.current = requestAnimationFrame(step);
				};

				followRafRef.current = requestAnimationFrame(step);
			},
			[onUnreadCountChange, resetUnread, setPinnedToBottom, stopFollowTail],
		);
		scheduleFollowTailRef.current = scheduleFollowTail;
		useEffect(() => () => stopFollowTail(), [stopFollowTail]);
		useEffect(() => {
			onUnreadCountChange?.(unreadCount);
		}, [onUnreadCountChange, unreadCount]);
		const permissionSignature = useMemo(() => getPermissionSignature(permCb), [permCb]);
		const permKeyCacheRef = useRef(
			new Map<string, { messages: NarratorMsg[]; signature: string; key: string }>(),
		);
		useEffect(() => {
			const loadedIds = new Set(chunks.filter((chunk) => chunk.messages).map((chunk) => chunk.id));
			for (const chunkId of permKeyCacheRef.current.keys()) {
				if (!loadedIds.has(chunkId)) permKeyCacheRef.current.delete(chunkId);
			}
		}, [chunks]);
		const getChunkPermKey = useCallback(
			(chunk: ChunkData) => {
				const messages = chunk.messages;
				if (!messages || !permissionSignature) return "";
				const cached = permKeyCacheRef.current.get(chunk.id);
				if (cached?.messages === messages && cached.signature === permissionSignature) {
					return cached.key;
				}
				const key = computePermKey(messages, permCb);
				permKeyCacheRef.current.set(chunk.id, { messages, signature: permissionSignature, key });
				return key;
			},
			[permCb, permissionSignature],
		);
		const selectionIndexRef = useRef<SelectionIndex>({ entries: [], byBlockId: new Map() });
		const selectionIndexChunksRef = useRef<ChunkData[] | null>(null);
		useEffect(() => {
			void chunks;
			selectionIndexChunksRef.current = null;
			selectionIndexRef.current = { entries: [], byBlockId: new Map() };
		}, [chunks]);
		const getSelectionIndex = useCallback((force = false) => {
			const currentChunks = chunksRef.current;
			if (force || selectionIndexChunksRef.current !== currentChunks) {
				selectionIndexRef.current = buildSelectionIndex(currentChunks);
				selectionIndexChunksRef.current = currentChunks;
			}
			return selectionIndexRef.current;
		}, []);
		const jumpTokenRef = useRef(0);

		const waitForJumpTarget = useCallback(
			(resolveTarget: JumpTargetResolver, token: number, timeoutMs = JUMP_TARGET_TIMEOUT_MS) =>
				new Promise<boolean>((resolve) => {
					const start = performance.now();
					let rafId = 0;
					let done = false;
					let observer: MutationObserver | null = null;
					// Two-phase: first FIND the target (it mounts after the estimate-based
					// scroll + band load), then SETTLE it. While the ~40 heavy messages in
					// the mounted band measure their real heights, prefix sums + spacers
					// recompute and the target drifts far off-screen. So once found we keep
					// re-centering (instant) until its viewport position is stable across a
					// few consecutive frames, or a settle deadline passes.
					let found = false;
					let settleStart = 0;
					let lastTop = Number.NaN;
					let stableFrames = 0;
					const SETTLE_MS = 1200;
					const STABLE_FRAMES_NEEDED = 4;
					const STABLE_EPS = 2;
					let highlighted = false;

					const cleanup = () => {
						if (rafId) cancelAnimationFrame(rafId);
						observer?.disconnect();
					};
					const finish = (ok: boolean) => {
						if (done) return;
						done = true;
						cleanup();
						resolve(ok);
					};
					const schedule = () => {
						if (done || rafId) return;
						rafId = requestAnimationFrame(check);
					};
					const centerInstant = (el: HTMLElement) => {
						el.scrollIntoView({ block: "center" });
					};
					const check = () => {
						rafId = 0;
						if (token !== jumpTokenRef.current) {
							finish(false);
							return;
						}
						const target = resolveTarget();
						const el = findJumpTargetEl(target);

						if (!found) {
							if (el) {
								found = true;
								settleStart = performance.now();
								// Fire the highlight once, on first find.
								if (target.highlightId && !highlighted) {
									highlighted = true;
									onHighlightTarget?.(target.highlightId, 400);
								}
								centerInstant(el);
								schedule();
								return;
							}
							if (performance.now() - start >= timeoutMs) {
								finish(false);
								return;
							}
							schedule();
							return;
						}

						// Settle phase: element is mounted. Re-center until stable.
						if (!el) {
							// Got unmounted (recenter churn). Go back to finding.
							found = false;
							schedule();
							return;
						}
						const top = el.getBoundingClientRect().top;
						if (Number.isFinite(lastTop) && Math.abs(top - lastTop) <= STABLE_EPS) {
							stableFrames++;
						} else {
							stableFrames = 0;
						}
						lastTop = top;
						centerInstant(el);
						if (
							stableFrames >= STABLE_FRAMES_NEEDED ||
							performance.now() - settleStart >= SETTLE_MS
						) {
							finish(true);
							return;
						}
						schedule();
					};

					const content = contentNodeRef.current;
					if (content) {
						observer = new MutationObserver(schedule);
						observer.observe(content, { childList: true, subtree: true });
					}
					schedule();
				}),
			[onHighlightTarget],
		);

		const getChunkIndexForSeq = useCallback((seq: number) => {
			const list = chunksRef.current;
			return list.findIndex((chunk) => seq >= chunk.firstSeq && seq <= chunk.lastSeq);
		}, []);

		const findLoadedTargetSeq = useCallback((targetIds: string[]): number | null => {
			for (const targetId of targetIds) {
				for (const chunk of chunksRef.current) {
					const messages = chunk.messages ?? [];
					const byId = findMessageById(messages, targetId);
					const byIdSeq = getMessageSeq(byId);
					if (byIdSeq != null) return byIdSeq;
					const byTool = findMsgByToolUseIdInTree(messages, targetId) as NarratorMsg | null;
					const byToolSeq = getMessageSeq(byTool);
					if (byToolSeq != null) return byToolSeq;
				}
			}
			return null;
		}, []);

		const resolveMessageSeq = useCallback(
			async (messageId: string): Promise<number | null> => {
				const location = await api.getMessageLocation(narratorId, messageId);
				return typeof location.seq === "number" && Number.isFinite(location.seq)
					? location.seq
					: null;
			},
			[narratorId],
		);

		const resolveTargetSeq = useCallback(
			async (targetIds: string[]): Promise<number | null> => {
				const loaded = findLoadedTargetSeq(targetIds);
				if (loaded != null) return loaded;
				for (const targetId of targetIds) {
					try {
						const seq = await resolveMessageSeq(targetId);
						if (seq != null) return seq;
					} catch {
						// Not a message id (or not visible in this narrator); try as a tool id below.
					}
					try {
						const detail = await api.getToolCallDetail(narratorId, targetId);
						const messageId = typeof detail?.messageId === "string" ? detail.messageId : undefined;
						if (!messageId) continue;
						const seq = await resolveMessageSeq(messageId);
						if (seq != null) return seq;
					} catch {
						// Ignore unresolved ids; another targetId may resolve.
					}
				}
				return null;
			},
			[findLoadedTargetSeq, narratorId, resolveMessageSeq],
		);

		const resolveSelectionEntry = useCallback(
			async (blockId: string): Promise<SelectionEntry | null> => {
				const index = getSelectionIndex();
				const direct = index.byBlockId.get(blockId);
				if (direct) return direct;

				const mounted = readMountedBlockMeta(blockId);
				if (mounted) {
					const stableId = makeMessageBlockSelectionId(mounted.messageId, mounted.blockIndex);
					const loaded = index.byBlockId.get(stableId);
					if (loaded) return loaded;
					const seq = await resolveMessageSeq(mounted.messageId).catch(() => null);
					const chunkIndex = seq == null ? -1 : getChunkIndexForSeq(seq);
					if (seq != null && chunkIndex >= 0)
						return {
							...mounted,
							blockIndices: [mounted.blockIndex],
							seq,
							chunkIndex,
							copyText: "",
						};
				}

				const toolUseId =
					blockId.startsWith("tc-") || blockId.startsWith("sa-") ? blockId.slice(3) : null;
				if (!toolUseId) return null;
				try {
					const detail = await api.getToolCallDetail(narratorId, toolUseId);
					const messageId = typeof detail?.messageId === "string" ? detail.messageId : undefined;
					if (!messageId) return null;
					const seq = await resolveMessageSeq(messageId);
					const chunkIndex = seq == null ? -1 : getChunkIndexForSeq(seq);
					if (seq == null || chunkIndex < 0) return null;
					// The exact block index will be refreshed from the loaded chunk after
					// ensureLoadedRange(). Use 0 only as a temporary ordering fallback.
					return {
						blockId,
						messageId,
						blockIndex: 0,
						blockIndices: [0],
						seq,
						chunkIndex,
						copyText: "",
					};
				} catch {
					return null;
				}
			},
			[getChunkIndexForSeq, getSelectionIndex, narratorId, resolveMessageSeq],
		);

		const resolveSelectionRange = useCallback(
			async (anchorBlockId: string, targetBlockId: string): Promise<Set<string> | null> => {
				const anchor = await resolveSelectionEntry(anchorBlockId);
				const target = await resolveSelectionEntry(targetBlockId);
				if (!anchor || !target) return null;

				const startChunk = Math.min(anchor.chunkIndex, target.chunkIndex);
				const endChunk = Math.max(anchor.chunkIndex, target.chunkIndex);
				const chunkCount = endChunk - startChunk + 1;
				if (chunkCount > HARD_RANGE_SELECT_CHUNKS) {
					notifications.show({
						color: "yellow",
						message: `Selection spans ${chunkCount} chunks. Please narrow the range.`,
					});
					return null;
				}
				if (chunkCount > SOFT_RANGE_SELECT_CHUNKS) {
					const ok = window.confirm(
						`This selection spans ${chunkCount} chunks and may load more history. Continue?`,
					);
					if (!ok) return null;
				}

				await ensureLoadedRange(startChunk, endChunk);
				await waitAnimationFrame();
				await waitAnimationFrame();

				const index = getSelectionIndex(true);
				const refreshedAnchor = index.byBlockId.get(anchorBlockId) ?? anchor;
				const refreshedTarget = index.byBlockId.get(targetBlockId) ?? target;
				const anchorBeforeTarget =
					refreshedAnchor.seq < refreshedTarget.seq ||
					(refreshedAnchor.seq === refreshedTarget.seq &&
						refreshedAnchor.blockIndex <= refreshedTarget.blockIndex);
				const start = anchorBeforeTarget ? refreshedAnchor : refreshedTarget;
				const end = anchorBeforeTarget ? refreshedTarget : refreshedAnchor;
				const selected = new Set<string>();
				for (const entry of index.entries) {
					if (entry.seq < start.seq || entry.seq > end.seq) continue;
					if (entry.seq === start.seq && entry.blockIndex < start.blockIndex) continue;
					if (entry.seq === end.seq && entry.blockIndex > end.blockIndex) continue;
					selected.add(entry.blockId);
				}
				return selected.size > 0 ? selected : null;
			},
			[ensureLoadedRange, getSelectionIndex, resolveSelectionEntry],
		);

		const selectionResolver = useMemo<MessageSelectionResolver>(
			() => ({
				resolveRange: resolveSelectionRange,
				resolveSelectedMeta: (selectedIds) =>
					entriesToBlockMeta(getSelectionIndex().entries, selectedIds),
				resolveSelectedMessageIds: (selectedIds) =>
					entriesToMessageIds(getSelectionIndex().entries, selectedIds),
				collectSelectedText: (selectedIds) =>
					entriesToText(getSelectionIndex().entries, selectedIds),
			}),
			[getSelectionIndex, resolveSelectionRange],
		);

		useEffect(() => {
			onSelectionResolverChange?.(selectionResolver);
			return () => onSelectionResolverChange?.(null);
		}, [onSelectionResolverChange, selectionResolver]);

		const scrollToSeqTarget = useCallback(
			async (seq: number, resolveTarget: JumpTargetResolver, token = ++jumpTokenRef.current) => {
				// The target may be older than the currently loaded manifest window.
				// Expand the window upward until it covers `seq` (or no older history
				// remains). The window is tail-anchored, so a seq below the window's
				// first chunk means we must pull more older manifest.
				// Progress is tracked against the hook's SYNCHRONOUS manifest snapshot,
				// not the committed `chunks`/`chunksRef` (which only update on the next
				// React commit). loadOlderManifest advances manifestRef immediately, so
				// gating the loop on committed state would stall after one batch: the
				// stale window's firstSeq never moves within the loop and the next
				// loadOlderManifest reports 0 new chunks (they're already in the ref),
				// tripping the `added <= 0` break far above the target.
				const manifestCoversSeq = () => {
					const m = getManifestSnapshotRef.current();
					if (m.length === 0) return false;
					return seq >= m[0].firstSeq && seq <= m[m.length - 1].lastSeq;
				};
				const manifestFirstSeq = () => getManifestSnapshotRef.current()[0]?.firstSeq ?? 0;
				// One bulk expansion loads every older chunk from the target seq down to
				// the current window in as few requests as possible (server allows up to
				// 200 chunks/req), updating state once. This replaces the previous
				// per-10-chunk iterative loadOlderManifest loop, which both crawled
				// (~155 round trips for a 31k-message history) and stalled on the
				// synchronous-ref vs committed-state race.
				if (!manifestCoversSeq() && hasOlderChunksRef.current && manifestFirstSeq() > seq) {
					await ensureManifestCoversSeqRef.current(seq);
					if (token !== jumpTokenRef.current) return false;
				}
				// Resolve the chunk index from the synchronous manifest; fall back to the
				// committed chunks lookup once they align.
				const snapshot = getManifestSnapshotRef.current();
				let chunkIndex = snapshot.findIndex((c) => seq >= c.firstSeq && seq <= c.lastSeq);
				if (chunkIndex < 0) chunkIndex = getChunkIndexForSeq(seq);
				if (chunkIndex < 0) return false;
				// The committed `chunks` array may still lag the manifest snapshot by one
				// commit. Wait for it to catch up so setCenterChunkId + scroll math below
				// operate on the same coordinate system the render uses.
				{
					let sync = 0;
					while (getChunkIndexForSeq(seq) < 0 && token === jumpTokenRef.current && sync++ < 60) {
						await waitAnimationFrame();
					}
					if (token !== jumpTokenRef.current) return false;
					const committedIndex = getChunkIndexForSeq(seq);
					if (committedIndex >= 0) chunkIndex = committedIndex;
				}
				const chunk = chunksRef.current[chunkIndex];
				if (!chunk) return false;

				stopFollowTailRef.current();
				setPinnedToBottom(false);
				setCenterChunkId(chunkIndex === chunksRef.current.length - 1 ? null : chunk.id);

				const el = scrollerRef.current;
				if (el) {
					el.scrollTop = estimateSeqCenteredScrollTop(
						prefixRef.current,
						chunkIndex,
						chunk,
						seq,
						el.clientHeight,
					);
				}

				try {
					await ensureLoadedRef.current(chunk.id, bandRadiusRef.current);
				} catch {
					return false;
				}
				if (token !== jumpTokenRef.current) return false;
				return waitForJumpTarget(resolveTarget, token);
			},
			[getChunkIndexForSeq, setPinnedToBottom, waitForJumpTarget],
		);

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
				const token = ++jumpTokenRef.current;
				// A tool-only assistant message renders under `tool-use-<id>` divs (no
				// `msg-<id>` node), so the highlight/message id is carried as `messageId`
				// for the data-message-id fallback locator.
				const messageId =
					highlightId ?? (domIds[0]?.startsWith("msg-") ? domIds[0].slice(4) : undefined);
				const resolution: JumpTargetResolution = { domIds, highlightId, messageId };
				// Fast path: already mounted. Detach from the bottom-follow loop first
				// (otherwise, for a near-tail target, follow-tail re-pins to the bottom
				// right after the settle centres it), then run the settle loop (not a
				// one-shot smooth scroll) so height reconciliation of neighbouring chunks
				// can't drift the target back off-screen.
				if (findJumpTargetEl(resolution)) {
					stopFollowTailRef.current();
					setPinnedToBottom(false);
					return waitForJumpTarget(() => resolution, token);
				}
				const seq = await resolveTargetSeq(targetIds).catch(() => null);
				if (seq == null || token !== jumpTokenRef.current) return false;
				return scrollToSeqTarget(seq, () => resolution, token);
			},
			[resolveTargetSeq, scrollToSeqTarget, waitForJumpTarget, setPinnedToBottom],
		);

		const scrollToBottom = useCallback(
			(instant?: boolean) => {
				void (async () => {
					setCenterChunkId(null);
					scheduleFollowTail({ force: true, immediate: instant ?? true });
					const tail = chunksRef.current[chunksRef.current.length - 1];
					if (tail) await ensureLoadedRef.current(tail.id, bandRadiusRef.current);
					for (let i = 0; i < 4; i++) await waitAnimationFrame();
					scheduleFollowTail({ force: true, immediate: instant ?? true });
				})();
			},
			[scheduleFollowTail],
		);

		useImperativeHandle(
			ref,
			() => ({ scrollToMessageTarget, scrollToBottom, refreshStructure, detachFromBottom }),
			[refreshStructure, scrollToBottom, scrollToMessageTarget, detachFromBottom],
		);
		// Set once the initial scroll-to-bottom has settled; until then the scroll
		// handler must not recenter (the programmatic scroll + unsettled heights
		// could otherwise yank the window off the tail).
		const initialScrollDoneRef = useRef(false);
		useEffect(() => {
			const resumeIntent = createForegroundBottomResumeIntent();
			let restoreRaf = 0;
			const suspend = () => {
				const el = scrollerRef.current;
				resumeIntent.suspend(
					pinnedToBottomRef.current,
					el != null && getDistanceFromBottom(el) <= BOTTOM_DISTANCE_ZERO,
				);
			};
			const resume = () => {
				if (document.visibilityState !== "visible" || !resumeIntent.resume()) return;
				// Initial loading owns its own bottom snap. Once initialized, rebuild the
				// follow loop because a frozen tab may discard its pending rAF while leaving
				// `followingRef` true, and app-switch touch gestures may have detached it.
				if (!initialScrollDoneRef.current) return;
				stopFollowTailRef.current();
				scheduleFollowTailRef.current({ force: true, immediate: true });
				cancelAnimationFrame(restoreRaf);
				restoreRaf = requestAnimationFrame(() => {
					restoreRaf = 0;
					scheduleFollowTailRef.current({ force: true, immediate: true });
				});
			};
			const onVisibilityChange = () => {
				if (document.visibilityState === "hidden") suspend();
				else resume();
			};

			window.addEventListener("blur", suspend);
			window.addEventListener("pagehide", suspend);
			document.addEventListener("visibilitychange", onVisibilityChange);
			window.addEventListener("focus", resume);
			window.addEventListener("pageshow", resume);
			return () => {
				cancelAnimationFrame(restoreRaf);
				window.removeEventListener("blur", suspend);
				window.removeEventListener("pagehide", suspend);
				document.removeEventListener("visibilitychange", onVisibilityChange);
				window.removeEventListener("focus", resume);
				window.removeEventListener("pageshow", resume);
			};
		}, []);
		useEffect(() => {
			const root = scrollerRef.current;
			const content = contentNodeRef.current;
			if (!root || !content) return;
			let followRaf = 0;
			const scheduleFromDomChange = () => {
				if (!initialScrollDoneRef.current || !pinnedToBottomRef.current) return;
				cancelAnimationFrame(followRaf);
				followRaf = requestAnimationFrame(() => {
					followRaf = 0;
					scheduleFollowTailRef.current();
				});
			};
			const contentResizeObserver = new ResizeObserver(scheduleFromDomChange);
			contentResizeObserver.observe(content);
			const viewportResizeObserver = new ResizeObserver(scheduleFromDomChange);
			viewportResizeObserver.observe(root);
			const mutationObserver = new MutationObserver(scheduleFromDomChange);
			mutationObserver.observe(content, {
				childList: true,
				subtree: true,
				characterData: true,
			});
			return () => {
				cancelAnimationFrame(followRaf);
				contentResizeObserver.disconnect();
				viewportResizeObserver.disconnect();
				mutationObserver.disconnect();
			};
		}, []);

		const centerChunkForLoad = chunks[centerIndex];

		// Ensure the mounted band's content is loaded whenever the window moves.
		// Loads exactly the band that is mounted: a wider load radius would fetch
		// (and parse) chunks that no spacer-free region can ever show.
		useEffect(() => {
			if (centerChunkForLoad) ensureLoadedRef.current(centerChunkForLoad.id, bandRadius);
		}, [centerChunkForLoad, bandRadius]);

		// Reverse infinite scroll: expand the manifest window toward the top when the
		// user scrolls near the start of the loaded history. Compensates scrollTop by
		// the height the prepended band adds so the viewport stays visually anchored
		// (native scroll anchoring is unreliable across the spacer/measure churn here).
		const expandOlderWindow = useCallback(() => {
			if (expandingOlderRef.current) return;
			if (!hasOlderChunksRef.current) return;
			const el = scrollerRef.current;
			if (!el) return;
			expandingOlderRef.current = true;
			setLoadingOlder(true);
			const prevScrollTop = el.scrollTop;
			const prevScrollHeight = el.scrollHeight;
			void (async () => {
				try {
					const added = await loadOlderManifestRef.current();
					if (added <= 0) return;
					// After React commits the prepended band, restore the visual position
					// by adding the height delta to scrollTop.
					await waitAnimationFrame();
					await waitAnimationFrame();
					const node = scrollerRef.current;
					if (!node) return;
					const delta = node.scrollHeight - prevScrollHeight;
					if (delta > 0) node.scrollTop = prevScrollTop + delta;
				} finally {
					expandingOlderRef.current = false;
					setLoadingOlder(false);
				}
			})();
		}, []);
		// Scroll-driven trigger. Gated on the auto-load preference: when disabled the
		// user must use the manual "load older" button at the top of the list.
		const autoLoadEnabledRef = useRef(autoLoadEnabled);
		autoLoadEnabledRef.current = autoLoadEnabled;
		const maybeLoadOlder = useCallback(() => {
			const el = scrollerRef.current;
			if (!el) return;
			const decision = resolveOlderHistoryAutoLoad({
				intentAt: olderHistoryIntentAtRef.current,
				now: Date.now(),
				autoLoadEnabled: autoLoadEnabledRef.current,
				hasOlder: hasOlderChunksRef.current,
				expanding: expandingOlderRef.current,
				atBottom: getDistanceFromBottom(el) <= BOTTOM_DISTANCE_ZERO,
				scrollTop: el.scrollTop,
				triggerPx: OLDER_LOAD_TRIGGER_PX,
			});
			olderHistoryIntentAtRef.current = decision.nextIntentAt;
			if (decision.shouldLoad) expandOlderWindow();
		}, [expandOlderWindow]);
		// Stable ref so the `[]` scroll-handler effect can call it without
		// re-subscribing (it accesses all live values through refs).
		const maybeLoadOlderRef = useRef(maybeLoadOlder);
		maybeLoadOlderRef.current = maybeLoadOlder;

		// Scroll handler: binary-search the chunk under the viewport center and jump
		// the mounted window there (+ load its band). This handles both continuous
		// scrolling and arbitrary scrollbar-drag jumps uniformly.
		useEffect(() => {
			const root = scrollerRef.current;
			if (!root) return;
			let ticking = false;
			// True while the user is actively driving the scroll — holding the scrollbar
			// thumb OR mid touch-gesture. Suppresses the scroll handler's auto
			// pin/refollow so the follow loop can't fight the drag; pointerup / touchend
			// re-evaluate once when the gesture ends.
			let pointerDownOnScrollbar = false;
			let touchActive = false;
			const recordOlderHistoryIntent = () => {
				olderHistoryIntentAtRef.current = Date.now();
			};
			const onScroll = () => {
				if (ticking) return;
				ticking = true;
				requestAnimationFrame(() => {
					ticking = false;
					const el = scrollerRef.current;
					if (!el) return;
					if (!initialScrollDoneRef.current) return; // don't fight the initial scroll
					const list = chunksRef.current;
					if (list.length === 0) return;
					// Keep scrollbar takeover intent fresh throughout a potentially long drag.
					if (pointerDownOnScrollbar) recordOlderHistoryIntent();
					// Reverse infinite scroll: expand older manifest when near the top, but only
					// after a recent explicit user gesture toward history.
					maybeLoadOlderRef.current();
					const pre = prefixRef.current;
					// Binary-search the chunk under the viewport center, with deterministic
					// edge clamping so the first/last chunks are always reachable even when
					// estimated heights drift from real ones (see resolveScrollTargetIndex).
					const target = resolveScrollTargetIndex(
						pre,
						list.length,
						el.scrollTop,
						el.clientHeight,
						el.scrollHeight,
					);
					const targetChunk = list[target];
					if (!targetChunk) return;
					const isTail = target === list.length - 1;
					startCenterTransition(() => setCenterChunkId(isTail ? null : targetChunk.id));
					ensureLoadedRef.current(targetChunk.id, bandRadiusRef.current);
					// During active manual gestures, keep virtual-window updates above but skip
					// all auto pin/refollow decisions so follow never fights the user's drag.
					if (pointerDownOnScrollbar || touchActive) return;
					// While the follow loop is animating toward the bottom, leave pin state
					// to it. (Deliberate scroll-ups already stopped the loop synchronously in
					// the input handlers, so if we're here and still following, this is the
					// loop's own downward motion.)
					if (followingRef.current) return;
					// Otherwise decide from DISTANCE only — never from a scrollTop decrease.
					// Deliberate scroll-ups are detached synchronously by the input handlers;
					// here a scrollTop decrease would just be browser scroll-anchoring after a
					// height re-measure, which must NOT detach. Remaining cases:
					//  - reached the bottom (e.g. scrollbar drag down) ⇒ re-pin
					//  - still pinned but content growth pushed us off the bottom ⇒ re-follow
					const action = resolveBottomPinAction(
						getDistanceFromBottom(el),
						pinnedToBottomRef.current,
					);
					switch (action) {
						case "pin":
							pinnedToBottomRef.current = true;
							setIsAtBottomRef.current(true);
							break;
						case "refollow":
							// Still pinned but the distance grew (streaming output / height
							// re-measure / anchoring). Re-follow instead of silently detaching.
							scheduleFollowTailRef.current();
							break;
						default:
							// Detached and not at the bottom: a real scroll-up already handled it.
							break;
					}
				});
			};
			root.addEventListener("scroll", onScroll, { passive: true });
			// Deliberate user inputs that mean "leave the bottom" detach SYNCHRONOUSLY
			// (stop the follow loop + unpin) so the follow loop stops yanking scrollTop
			// back to the bottom on the same frame — otherwise the user can't scroll up.
			// Only directional inputs (wheel up, scroll-up keys, touch drag, scrollbar
			// grab) qualify; a wheel-DOWN at the bottom must keep following.
			// LOD gesture state: throttle step changes so one wheel flick / pinch doesn't
			// skip multiple levels (each change triggers a wide re-render).
			let lastLodStepAt = 0;
			const LOD_STEP_THROTTLE_MS = 140;
			const stepLod = (dir: 1 | -1, clientX: number, clientY: number) => {
				const now = Date.now();
				if (now - lastLodStepAt < LOD_STEP_THROTTLE_MS) return;
				const step = onLodStepRef.current;
				if (!step) return;
				lastLodStepAt = now;
				// Capture the anchor BEFORE the level changes so the restore effect can
				// keep this point visually stable.
				captureAnchorRef.current(clientX, clientY);
				step(dir);
			};
			const onWheel = (e: WheelEvent) => {
				// Alt+wheel steps the render LOD instead of scrolling. Non-passive so we
				// can suppress the scroll; detached-from-bottom logic is skipped.
				if (e.altKey) {
					e.preventDefault();
					stepLod(e.deltaY > 0 ? -1 : 1, e.clientX, e.clientY);
					return;
				}
				if (e.deltaY < 0) {
					recordOlderHistoryIntent();
					detachFromBottomRef.current();
				}
			};
			// Touch gestures drive the scroll directly, so handle them like the
			// scrollbar grab: a finger moving DOWN drags content down = scrolls UP, so
			// detach immediately (even while pinned) — otherwise the follow loop fights
			// the finger and the user can't scroll. `touchActive` suppresses the scroll
			// handler's auto pin/refollow for the gesture's duration; touchend re-pins
			// if it ended back at the bottom (or the touch never really moved).
			let touchStartX = 0;
			let lastTouchY = 0;
			// Pinch (two-finger) LOD gesture state.
			let pinchActive = false;
			let pinchLastDist = 0;
			const pinchDistance = (e: TouchEvent) => {
				const a = e.touches[0];
				const b = e.touches[1];
				if (!a || !b) return 0;
				return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
			};
			const pinchCenter = (e: TouchEvent) => {
				const a = e.touches[0];
				const b = e.touches[1];
				return {
					x: ((a?.clientX ?? 0) + (b?.clientX ?? 0)) / 2,
					y: ((a?.clientY ?? 0) + (b?.clientY ?? 0)) / 2,
				};
			};
			const onTouchStart = (e: TouchEvent) => {
				if (e.touches.length === 2) {
					// Enter pinch mode: two fingers down. Suppress single-finger detach.
					pinchActive = true;
					pinchLastDist = pinchDistance(e);
					return;
				}
				touchActive = true;
				const touch = e.touches[0];
				touchStartX = touch?.clientX ?? 0;
				lastTouchY = touch?.clientY ?? 0;
			};
			const onTouchMove = (e: TouchEvent) => {
				if (pinchActive && e.touches.length === 2) {
					// Suppress the browser's native pinch-zoom / scroll while driving LOD.
					e.preventDefault();
					// Pinch: spread = more detail (step up), pinch-in = less detail (step
					// down). Reset the baseline each step for continuous adjustment.
					const dist = pinchDistance(e);
					if (pinchLastDist > 0) {
						const ratio = dist / pinchLastDist;
						if (ratio > 1.2 || ratio < 1 / 1.2) {
							const center = pinchCenter(e);
							stepLod(ratio > 1 ? 1 : -1, center.x, center.y);
							pinchLastDist = dist;
						}
					} else {
						pinchLastDist = dist;
					}
					return;
				}
				const touch = e.touches[0];
				const x = touch?.clientX ?? touchStartX;
				const y = touch?.clientY ?? lastTouchY;
				// finger DOWN = content scrolls UP; finger LEFT = reveal left-swipe menu.
				// Both are user inspection gestures and must immediately release pinned, but
				// only the downward drag is explicit intent to load older history.
				if (y > lastTouchY) {
					recordOlderHistoryIntent();
					detachFromBottomRef.current();
				} else if (touchStartX - x > 10) {
					detachFromBottomRef.current();
				}
				lastTouchY = y;
			};
			const onTouchEnd = (e: TouchEvent) => {
				// A pinch ends when fewer than two fingers remain — reset pinch state and
				// skip the single-finger re-pin path for this gesture.
				if (pinchActive) {
					if (e.touches.length < 2) {
						pinchActive = false;
						pinchLastDist = 0;
					}
					return;
				}
				if (!touchActive) return;
				touchActive = false;
				const el = scrollerRef.current;
				if (!el) return;
				// Pin-only re-evaluation (no follow loop / no snap) so we never fight
				// momentum: if the gesture ended at the real bottom, re-pin;
				// otherwise stay detached. With momentum still rolling, the scroll handler
				// (re-enabled now that touchActive is false) keeps re-evaluating frame by
				// frame and pins exactly when it settles at the bottom — or leaves it
				// detached if momentum stops higher up.
				if (getDistanceFromBottom(el) <= BOTTOM_DISTANCE_ZERO) {
					pinnedToBottomRef.current = true;
					setIsAtBottomRef.current(true);
				}
			};
			const onKeyDown = (e: KeyboardEvent) => {
				if (
					e.key === "ArrowUp" ||
					e.key === "PageUp" ||
					e.key === "Home" ||
					(e.key === " " && e.shiftKey)
				) {
					recordOlderHistoryIntent();
					detachFromBottomRef.current();
				}
			};
			// Grabbing the scrollbar thumb means the user is taking over scrolling, so
			// detach immediately — even while pinned at the bottom. Otherwise the follow
			// loop keeps yanking scrollTop back to the bottom every frame and the thumb
			// won't drag. Firefox/overlay scrollbars can report layout width 0 until
			// hovered, so use a right-edge hit target fallback instead of trusting
			// offsetWidth-clientWidth alone. `pointerup` re-pins only if the drag ended at
			// the real bottom.
			const isVerticalScrollbarHit = (clientX: number) => {
				if (root.scrollHeight <= root.clientHeight) return false;
				const rect = root.getBoundingClientRect();
				const scrollbarWidth = Math.max(
					root.offsetWidth - root.clientWidth,
					SCROLLBAR_HIT_TARGET_PX,
				);
				return clientX >= rect.right - scrollbarWidth && clientX <= rect.right;
			};
			const onScrollbarPress = (clientX: number) => {
				if (!isVerticalScrollbarHit(clientX)) return;
				pointerDownOnScrollbar = true;
				recordOlderHistoryIntent();
				detachFromBottomRef.current();
			};
			const onPointerDown = (e: PointerEvent) => onScrollbarPress(e.clientX);
			const onMouseDown = (e: MouseEvent) => onScrollbarPress(e.clientX);
			const onPointerUp = () => {
				if (!pointerDownOnScrollbar) return;
				pointerDownOnScrollbar = false;
				const el = scrollerRef.current;
				if (el && getDistanceFromBottom(el) <= BOTTOM_DISTANCE_ZERO) {
					scheduleFollowTailRef.current({ force: true, immediate: true });
				}
			};
			const onContextMenu = () => detachFromBottomRef.current();
			const onSelectionChange = () => {
				const selection = document.getSelection();
				if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
				const range = selection.getRangeAt(0);
				const container = range.commonAncestorContainer;
				const node = container.nodeType === Node.ELEMENT_NODE ? container : container.parentNode;
				if (node && root.contains(node)) detachFromBottomRef.current();
			};
			root.addEventListener("wheel", onWheel, { passive: false });
			root.addEventListener("touchstart", onTouchStart, { passive: true });
			root.addEventListener("touchmove", onTouchMove, { passive: false });
			root.addEventListener("keydown", onKeyDown);
			root.addEventListener("pointerdown", onPointerDown);
			root.addEventListener("mousedown", onMouseDown);
			root.addEventListener("contextmenu", onContextMenu, true);
			document.addEventListener("selectionchange", onSelectionChange);
			window.addEventListener("pointerup", onPointerUp);
			window.addEventListener("pointercancel", onPointerUp);
			window.addEventListener("mouseup", onPointerUp);
			window.addEventListener("touchend", onTouchEnd);
			window.addEventListener("touchcancel", onTouchEnd);
			return () => {
				root.removeEventListener("scroll", onScroll);
				root.removeEventListener("wheel", onWheel);
				root.removeEventListener("touchstart", onTouchStart);
				root.removeEventListener("touchmove", onTouchMove);
				root.removeEventListener("keydown", onKeyDown);
				root.removeEventListener("pointerdown", onPointerDown);
				root.removeEventListener("mousedown", onMouseDown);
				root.removeEventListener("contextmenu", onContextMenu, true);
				document.removeEventListener("selectionchange", onSelectionChange);
				window.removeEventListener("pointerup", onPointerUp);
				window.removeEventListener("pointercancel", onPointerUp);
				window.removeEventListener("mouseup", onPointerUp);
				window.removeEventListener("touchend", onTouchEnd);
				window.removeEventListener("touchcancel", onTouchEnd);
			};
		}, []);

		// Initial scroll-to-bottom: follow-tail center + scroll the container to the
		// end so the newest messages are visible on open.
		const lastNarratorRef = useRef(narratorId);
		if (lastNarratorRef.current !== narratorId) {
			lastNarratorRef.current = narratorId;
			initialScrollDoneRef.current = false;
			olderHistoryIntentAtRef.current = null;
			pinnedToBottomRef.current = true;
			setCenterChunkId(null);
			// Reset measured heights so the per-message average and spacer sizing
			// start fresh for the new narrator (chunk ids are message ids, so stale
			// entries wouldn't collide, but the running average must not carry over).
			heightsRef.current.clear();
			measuredPerMsgRef.current = null;
		}
		const tailLoaded =
			tailChunkId != null && chunks.length > 0 && chunks[chunks.length - 1]?.messages != null;
		useLayoutEffect(() => {
			if (initialScrollDoneRef.current) return;
			const el = scrollerRef.current;
			if (!el || loading || chunks.length === 0 || !tailLoaded) return;
			setCenterChunkId(null);
			pinnedToBottomRef.current = true;
			el.scrollTop = getScrollBottomTarget(el);
			setIsAtBottomRef.current(true);
			initialScrollDoneRef.current = true;
			scheduleFollowTail({ force: true, immediate: true });
		}, [loading, chunks.length, tailLoaded, scheduleFollowTail]);

		const lastHighlightTargetRef = useRef<string | null>(null);
		useEffect(() => {
			if (!highlightMessageId || chunks.length === 0) return;
			const key = `${narratorId}:${highlightMessageId}`;
			if (lastHighlightTargetRef.current === key) return;
			lastHighlightTargetRef.current = key;
			void scrollToMessageTarget({
				domIds: [`msg-${highlightMessageId}`],
				targetIds: [highlightMessageId],
				highlightId: highlightMessageId,
			}).then((ok) => {
				if (!ok && lastHighlightTargetRef.current === key) lastHighlightTargetRef.current = null;
			});
		}, [chunks.length, highlightMessageId, narratorId, scrollToMessageTarget]);

		const mountedChunks = useMemo(
			() => chunks.slice(mountedRange.start, mountedRange.end + 1),
			[chunks, mountedRange.start, mountedRange.end],
		);
		// Persistent chunk units and their cross-boundary overrides are independent
		// of streaming deltas. Memoize both bases so live tail updates can preserve
		// references for every unaffected MountedChunk.
		const baseChunkActivityUnits = useMemo(() => {
			if (renderLod > 2) return [];
			const options = { pruneBoundaryMessageId, pruneDividerLabel, renderLod };
			return mountedChunks.map((chunk) =>
				computeChunkActivityUnits(chunk.id, chunk.messages, options),
			);
		}, [mountedChunks, pruneBoundaryMessageId, pruneDividerLabel, renderLod]);
		const baseCrossChunkActivityOverrides = useMemo(
			() =>
				renderLod > 2
					? new Map<string, ActivityRenderOverrides>()
					: buildCrossChunkActivityOverrides(baseChunkActivityUnits),
			[baseChunkActivityUnits, renderLod],
		);
		const mountedTailChunk = useMemo(
			() =>
				mountedChunks.find((chunk) => chunk.id === tailChunkId && chunk.messages != null) ?? null,
			[mountedChunks, tailChunkId],
		);
		const crossChunkActivityOverrides = useMemo(
			() =>
				buildCrossChunkActivityRenderPlan(
					baseChunkActivityUnits,
					baseCrossChunkActivityOverrides,
					mountedTailChunk
						? {
								chunkId: mountedTailChunk.id,
								messages: mountedTailChunk.messages ?? [],
								streamingMsg,
							}
						: null,
					{ pruneBoundaryMessageId, pruneDividerLabel, renderLod },
				).overrides,
			[
				baseChunkActivityUnits,
				baseCrossChunkActivityOverrides,
				mountedTailChunk,
				pruneBoundaryMessageId,
				pruneDividerLabel,
				renderLod,
				streamingMsg,
			],
		);
		// Inject the synthetic streaming message into the tail render-chunk only,
		// and only when that chunk is actually mounted (it is kept resident).
		const tailMounted = mountedChunks.some((c) => c.id === tailChunkId && c.messages != null);
		const firstManifestSeq = chunks[0]?.firstSeq ?? 0;
		const totalSeqCount =
			chunks.length > 0
				? (chunks[chunks.length - 1]?.lastSeq ?? firstManifestSeq) - firstManifestSeq + 1
				: 0;
		const userMessageMarkers = useMemo(() => {
			if (totalSeqCount <= 0) return [];
			const markers: { index: number; id: string }[] = [];
			for (const chunk of chunks) {
				for (const msg of chunk.messages ?? []) {
					const seq = getMessageSeq(msg);
					if (msg.role === "user" && msg.id && seq != null) {
						markers.push({ index: seq - firstManifestSeq, id: msg.id });
					}
				}
			}
			return markers;
		}, [chunks, firstManifestSeq, totalSeqCount]);
		const handleUserMarkerJump = useCallback(
			(index: number) => {
				const seq = firstManifestSeq + index;
				void scrollToSeqTarget(seq, () => {
					const messageId = findUserMessageIdBySeq(chunksRef.current, seq);
					return {
						domIds: messageId ? [`msg-${messageId}`] : [],
						highlightId: messageId,
					};
				});
			},
			[firstManifestSeq, scrollToSeqTarget],
		);

		return (
			<Box
				style={{
					height: "100%",
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
				}}
			>
				<Box
					style={{
						position: "relative",
						flex: "1 1 auto",
						minHeight: 0,
						overflow: "hidden",
					}}
				>
					<DetachFromBottomProvider value={detachFromBottom}>
						<Box
							ref={setScrollerNode}
							style={{
								height: "100%",
								overflowY: "auto",
								overflowX: "hidden",
								overflowAnchor: "auto",
								overscrollBehaviorY: resolveMessageScrollerOverscrollBehavior(isMobileViewport),
							}}
						>
							<div ref={setContentNode} style={contentColumnStyle}>
								{/* Inside the scroller, above the first chunk, on every viewport. Mobile used to
								    render this as a flex sibling *outside* the scroller, which pinned it to the
								    top of the panel permanently instead of only when scrolled to the top. */}
								{showManualOlderHistoryLoad && (
									<ManualOlderHistoryLoad
										autoLoadEnabled={autoLoadEnabled}
										hasOlder={hasOlderChunks}
										loading={loadingOlder}
										label={t("loadOlderMessages")}
										onLoad={expandOlderWindow}
									/>
								)}
								{topSpacer > 0 && <div style={{ height: topSpacer }} aria-hidden />}
								{mountedChunks.map((chunk) => {
									return chunk.messages ? (
										<MountedChunk
											key={chunk.id}
											chunkId={chunk.id}
											messages={chunk.messages}
											narratorId={narratorId}
											permCb={permCb}
											permKey={getChunkPermKey(chunk)}
											hasChapter={hasChapter}
											onForkFromMessage={onForkFromMessage}
											highlightedId={highlightedId}
											showTokenUsage={showTokenUsage}
											pruneBoundaryMessageId={pruneBoundaryMessageId}
											pruneDividerLabel={pruneDividerLabel}
											onCompactBeforeMessage={onCompactBeforeMessage}
											onClearContextBefore={onClearContextBefore}
											onManualSummarize={onManualSummarize}
											onDeleteBlock={onDeleteBlock}
											onRollbackToBlock={onRollbackToBlock}
											onEditAndRegenerate={onEditAndRegenerate}
											onEditAssistantMessage={onEditAssistantMessage}
											onRestoreAssistantMessage={onRestoreAssistantMessage}
											lastUserMessageId={lastUserMessageId}
											onViewSubagentSession={onViewSubagentSession}
											onViewSubagentSessionFolded={onViewSubagentSessionFolded}
											onDetachSubagent={onDetachSubagent}
											onCancelBackgroundTask={onCancelBackgroundTask}
											onOpenFilePanel={onOpenFilePanel}
											resolvePerm={resolvePerm}
											onAskInPassing={onAskInPassing}
											streamingMsg={chunk.id === tailChunkId ? streamingMsg : null}
											onMeasure={onMeasure}
											activityOverrides={crossChunkActivityOverrides.get(chunk.id)}
										/>
									) : (
										// Mounted but content not yet loaded — reserve estimated height
										// so layout/scroll position stays stable until it arrives.
										<div key={chunk.id} style={{ height: estimateHeight(chunk) }} aria-hidden />
									);
								})}
								{bottomSpacer > 0 && <div style={{ height: bottomSpacer }} aria-hidden />}
								{/* Empty narrator: render streaming output even before any chunk exists. */}
								{!tailMounted && streamingMsg && chunks.length === 0 && (
									<MountedChunk
										key="__streaming_only__"
										chunkId="__streaming_only__"
										messages={[]}
										narratorId={narratorId}
										permCb={permCb}
										permKey=""
										hasChapter={hasChapter}
										onForkFromMessage={onForkFromMessage}
										highlightedId={highlightedId}
										showTokenUsage={showTokenUsage}
										pruneBoundaryMessageId={pruneBoundaryMessageId}
										pruneDividerLabel={pruneDividerLabel}
										onCompactBeforeMessage={onCompactBeforeMessage}
										onClearContextBefore={onClearContextBefore}
										onManualSummarize={onManualSummarize}
										onDeleteBlock={onDeleteBlock}
										onRollbackToBlock={onRollbackToBlock}
										onEditAndRegenerate={onEditAndRegenerate}
										onEditAssistantMessage={onEditAssistantMessage}
										onRestoreAssistantMessage={onRestoreAssistantMessage}
										lastUserMessageId={lastUserMessageId}
										onViewSubagentSession={onViewSubagentSession}
										onViewSubagentSessionFolded={onViewSubagentSessionFolded}
										onDetachSubagent={onDetachSubagent}
										onCancelBackgroundTask={onCancelBackgroundTask}
										onOpenFilePanel={onOpenFilePanel}
										resolvePerm={resolvePerm}
										onAskInPassing={onAskInPassing}
										streamingMsg={streamingMsg}
										onMeasure={onMeasure}
									/>
								)}
								{tailFooter}
							</div>
						</Box>
					</DetachFromBottomProvider>
					<ScrollbarUserMarkers
						markers={userMessageMarkers}
						totalCount={totalSeqCount}
						onJump={handleUserMarkerJump}
						scrollContainerRef={scrollerRef}
					/>
				</Box>
			</Box>
		);
	},
);
ChunkedMessageListImpl.displayName = "ChunkedMessageList";

export const ChunkedMessageList = memo(ChunkedMessageListImpl);
ChunkedMessageList.displayName = "ChunkedMessageList";
