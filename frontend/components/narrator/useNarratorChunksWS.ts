import { notifications } from "@mantine/notifications";
import type { CatchUpCursor } from "@shared/narrator-catch-up";
import type { ProgressSnapshot } from "@shared/progress-phase";
import { useQueryClient } from "@tanstack/react-query";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type SubagentToolEventMeta, useNarratorWS } from "../../hooks/useNarratorWS";
import type {
	ChunkManifestEntry,
	SubagentActivitySummary,
	SubagentToolCallHeader,
	TreeMessage,
} from "../../lib/api";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import {
	buildStreamingMsg,
	clearToolBlockCache,
	mergeStreamingSnapshotBlocks,
	type StreamingBlock,
	upsertStreamingImageGenerationBlock,
	upsertStreamingWebSearchBlock,
} from "./message-segments";
import {
	findMsgByToolUseIdInTree,
	getNewestReflectionToolOccurrenceInTree,
	type MessageIndex,
	mergeFieldsByIndex,
	mergeFieldsIntoNewestToolOccurrenceInTree,
	normalizeSubagentModel,
	normalizeSubagentReasoningEffort,
	replaceSubagentActivitySnapshot,
	updateSubagentActivityInCache,
	updateToolCallByIndex,
	upsertSubagentToolCallHeader,
} from "./message-tree-utils";
import {
	buildTopLevelStreamingChunksMsg,
	getStreamingFieldPreview,
	getSyntheticTopLevelStreamingChunks,
	getToolOutputPreview,
	insertTopLevelMessageBySeq,
	preserveCompleteStreamedOutput,
	preserveLiveSubagentActivity,
	splitTopLevelStreamingChunksByPersistedToolUse,
	type TopLevelStreamingChunk,
	topLevelStreamingChunkMatchesPersistedTool,
	topLevelStreamingChunkToToolFields,
} from "./narrator-message-helpers";
import type { ContentBlock, NarratorMsg } from "./narrator-panel-types";
import { applyStreamingDelta, type StreamDeltaEvent } from "./streaming-delta-fold";

/**
 * WebSocket integration for the chunk data layer.
 *
 * The chunk list is the single source of truth for messages, so it subscribes
 * to the narrator WS itself rather than reading the TanStack Query cache. This
 * module owns the message-mutation logic that the legacy `useNarratorPanelWS`
 * applies to `{ pages }`, re-expressed against a `Map<chunkId, messages[]>`:
 *
 *  - new top-level messages are appended/replaced into the chunk that owns
 *    their seq (the tail chunk grows for brand-new tail seqs);
 *  - streaming text/reasoning deltas accumulate into a ref and are surfaced as a
 *    synthetic `streamingMsg` that the list injects into the tail render-chunk;
 *  - tool completion / tool streaming / subagent trees / reflections mutate the
 *    chunk that owns the relevant toolUseId (phase 2);
 *  - structural changes (compact / ask_in_passing mid-history inserts, deletes,
 *    catch-up reloads) are deferred to a manifest refetch via `onStructuralDirty`
 *    so seqs never drift out of sync with the manifest coordinate system.
 *
 * Phase 2 adds tool completion, fine-grained tool streaming, subagent trees and
 * reflection gates. Structural edits/deletes/compact still defer to a manifest
 * reconcile (phase 3).
 *
 * Performance: streaming deltas mutate a ref and bump a version at most once per
 * animation frame (rAF), never broadcasting a growing cumulative string. The
 * same rAF batching applies to tool_use_chunk and tool_output throttling so
 * high-frequency events never push a growing cumulative string per chunk.
 */

/** Mutable snapshot the chunk updaters operate on. */
export interface ChunkMutState {
	loaded: Map<string, TreeMessage[]>;
	manifest: ChunkManifestEntry[];
	total: number;
}

export type ChunkUpdater = (state: ChunkMutState) => ChunkMutState;

export interface UseNarratorChunksWSOptions {
	narratorId: string;
	/** True when rendering a subagent's OWN page. Realtime events for this
	 * narrator carry a parentToolUseId (pointing at the parent narrator's
	 * tool_use), but on the subagent's own page they must be routed as TOP-LEVEL
	 * — mirroring the server's isSubagent flattening in narrator-messages.ts.
	 * Without this, child-routing (applyToChunkContaining(ptu, …)) no-ops because
	 * the owning tool_use lives in the parent narrator, silently dropping events. */
	isSubagent?: boolean;
	/** Canonical initial cursor for WS catch-up. */
	initialCatchUpCursor: CatchUpCursor | undefined;
	/** rAF-batched scheduler that folds updaters and commits via setState once per frame. */
	scheduleChunkUpdate: (updater: ChunkUpdater) => void;
	/** Synchronously flush queued chunk updaters (used to batch with streaming-version bumps). */
	flushChunkUpdatesSync: (options?: { urgent?: boolean }) => void;
	/** Latest loaded map (read inside updaters / dedupe scans). */
	loadedRef: React.RefObject<Map<string, TreeMessage[]>>;
	/** Narrator whose authoritative snapshot owns `loaded`. */
	loadedOwnerNarratorId: string | null;
	/** Map identity used to re-render the synthetic-card dedupe after a range load. */
	loaded: Map<string, TreeMessage[]>;
	/** Latest manifest (read to locate the chunk owning a seq). */
	manifestRef: React.RefObject<ChunkManifestEntry[]>;
	/** Whether the viewport is pinned to the bottom (gates unread + follow). */
	isAtBottomRef: React.RefObject<boolean>;
	/** Called when a new assistant message arrives while not pinned to bottom. */
	onUnread: () => void;
	/** Called when a structural (mid-history) change requires a manifest refetch. */
	onStructuralDirty: (mode?: "diff" | "full") => void;
	/** Called after catch-up appends, when pinned to bottom, to follow the tail. */
	onTailFollow: () => void;
}

export interface UseNarratorChunksWSReturn {
	streamingMsg: NarratorMsg | null;
	connected: boolean;
	disconnected: boolean;
	reconnect: () => void;
}

const STREAMING_TOOL_OUTPUT_THROTTLE_MIN_CHARS = 12_000;
const STREAMING_TOOL_OUTPUT_THROTTLE_MS = 250;
/** Keep in sync with server/services/narrator-messages.ts CHUNK_SIZE. */
const CHUNK_SIZE = 20;

/** Empty index forces the {pages}-bound helpers down their DFS fallback. */
const EMPTY_INDEX: MessageIndex = new Map();

interface ToolOutputPreviewState {
	preview: string;
	lastFlushedPreview: string;
	lastFlushAt: number;
	timer: ReturnType<typeof setTimeout> | null;
}

/** Single-page cache wrapper so {pages}-bound tree helpers can run on one chunk. */
type OnePageCache = {
	pages: Array<{ messages: TreeMessage[]; hasMore?: boolean; nextCursor?: string | null }>;
	pageParams?: unknown[];
};

/**
 * Locate the loaded chunk whose message tree contains `locateToolUseId`, wrap
 * it as a 1-page cache, run a {pages}-bound tree helper on it (its empty-index
 * DFS fallback), and write the result back. No-ops (returns the same state) when
 * the toolUseId is not in any loaded chunk — a later manifest reconcile fills
 * the gap. The fn must return the same `pages[0].messages` reference when it
 * makes no change so we can skip the setState.
 */
function applyChunkReflection(
	cache: OnePageCache,
	toolUseId: string,
	requestId: string,
	reflectionType: string,
	phase: "started" | "terminal",
	fields: Record<string, unknown>,
): OnePageCache {
	const messages = cache.pages[0]?.messages ?? [];
	const occurrence = getNewestReflectionToolOccurrenceInTree(messages, toolUseId, reflectionType);
	if (!occurrence.found) return cache;
	const accepts =
		phase === "started"
			? occurrence.requestId == null || occurrence.requestId === requestId
			: occurrence.requestId === requestId;
	if (!accepts) return cache;
	const merged = mergeFieldsIntoNewestToolOccurrenceInTree(messages, toolUseId, fields);
	if (!merged.changed) return cache;
	return { ...cache, pages: [{ ...cache.pages[0], messages: merged.messages }] };
}

function applyToChunkContaining(
	state: ChunkMutState,
	locateToolUseId: string,
	fn: (cache: OnePageCache) => OnePageCache,
): ChunkMutState {
	for (const [chunkId, msgs] of state.loaded) {
		if (!findMsgByToolUseIdInTree(msgs, locateToolUseId)) continue;
		const wrapped: OnePageCache = {
			pages: [{ messages: msgs, hasMore: false, nextCursor: null }],
			pageParams: [undefined],
		};
		const result = fn(wrapped);
		const nextMsgs = result.pages[0]?.messages ?? msgs;
		if (nextMsgs === msgs) return state;
		const loaded = new Map(state.loaded);
		loaded.set(chunkId, nextMsgs);
		return { ...state, loaded };
	}
	return state;
}

/** Exported for tests: see `SubagentActivityLiveSummary.test.tsx`. */
export function subagentHeaderFromEvent(
	toolUseId: string,
	toolName: string,
	status: string,
	meta?: SubagentToolEventMeta,
): SubagentToolCallHeader {
	return {
		toolCallId: meta?.toolCallId ?? null,
		toolUseId,
		toolName,
		status,
		createdAt: meta?.createdAt ?? meta?.timing?.streamStartedAt ?? Date.now(),
		timing: meta?.timing ?? null,
		// Spread conditionally, never as `inputSummary: meta?.inputSummary ?? undefined`:
		// `upsertSubagentToolCallHeader` merges by spreading the incoming header over the
		// existing one, so a present-but-undefined key would erase a label an earlier
		// event already delivered. `tool_completed` legitimately omits it.
		...(meta?.inputSummary ? { inputSummary: meta.inputSummary } : {}),
	};
}

/** Pure chunk-state reducer for one parent-owned child tool activity event. */
export function applySubagentToolActivity(
	state: ChunkMutState,
	parentToolUseId: string,
	header: SubagentToolCallHeader,
	meta?: Pick<SubagentToolEventMeta, "subagentNarratorId" | "model">,
): ChunkMutState {
	return applyToChunkContaining(state, parentToolUseId, (cache) =>
		updateSubagentActivityInCache(cache, parentToolUseId, (current) => {
			const next = upsertSubagentToolCallHeader(current, header);
			return {
				...next,
				subagentNarratorId:
					meta?.subagentNarratorId ?? current?.subagentNarratorId ?? next.subagentNarratorId,
				model:
					normalizeSubagentModel(meta?.model) ??
					normalizeSubagentModel(current?.model) ??
					normalizeSubagentModel(next.model),
			};
		}),
	);
}

/** Pure chunk-state reducer for authoritative catch-up activity snapshots. */
export function applySubagentActivitySnapshots(
	state: ChunkMutState,
	snapshots: Array<{ parentToolUseId: string; activity: SubagentActivitySummary }>,
): ChunkMutState {
	let next = state;
	for (const snapshot of snapshots) {
		next = applyToChunkContaining(next, snapshot.parentToolUseId, (cache) =>
			updateSubagentActivityInCache(cache, snapshot.parentToolUseId, (current) =>
				replaceSubagentActivitySnapshot(snapshot.activity, current),
			),
		);
	}
	return next;
}

export function shouldIgnoreParentChildMessage(
	parentToolUseId: string | null | undefined,
	isSubagentPage: boolean,
): boolean {
	return !!parentToolUseId && !isSubagentPage;
}

/** Does this message carry a mid-history structural block? */
export function isStructuralInsert(msg: NarratorMsg): boolean {
	if (msg.role !== "system" && msg.role !== "disp") return false;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return blocks.some(
		(b: ContentBlock) =>
			b.type === "compact" || b.type === "segment_compact" || b.type === "ask_in_passing",
	);
}

/**
 * Determine whether a catch-up contains a structural coordinate change.
 * This is intentionally synchronous: the result must be known before any queued
 * updater is flushed or the WS manager accepts the server messageVersion.
 */
export function getCatchUpStructuralMode(
	topLevel: TreeMessage[],
	loaded: Map<string, TreeMessage[]>,
): "diff" | "full" | undefined {
	let mode: "diff" | "full" | undefined;
	for (const message of topLevel) {
		if (!message?.id || !isStructuralInsert(message as NarratorMsg)) continue;
		const nextMode = loadedContainsMessageId(loaded, message.id) ? "diff" : "full";
		if (nextMode === "full" || mode === "full") mode = "full";
		else mode = "diff";
	}
	return mode;
}

/**
 * Mirror of applyTopLevelMessage's silent-drop paths, evaluated synchronously
 * BEFORE queueing the updater. A tail-append (3b: seq beyond the tail, or the
 * 3d no-seq fallback) while the tail chunk is not loaded returns the state
 * unchanged — and unlike a mid-manifest seq (3c), which ensureLoaded backfills
 * on demand, nothing ever retries the append. The frame is still counted by
 * the WS manager's messageVersion, so without a reconcile the message stays
 * invisible until some unrelated structural event happens to force one.
 */
export function willDropTopLevelMessage(
	msg: Pick<TreeMessage, "seq">,
	loaded: Map<string, TreeMessage[]>,
	manifest: ChunkManifestEntry[],
): boolean {
	if (manifest.length === 0) return false; // 3a seeds a fresh first chunk
	const tail = manifest[manifest.length - 1];
	if (loaded.has(tail.id)) return false; // tail resident: every append branch lands
	const seq = typeof msg.seq === "number" && Number.isFinite(msg.seq) ? msg.seq : undefined;
	if (seq == null) return true; // 3d fallback appends to the tail
	return seq > tail.lastSeq; // 3b appends to / extends the tail
}

function mergeUpdatedMessageById(
	messages: TreeMessage[],
	updatedMsg: TreeMessage,
): { messages: TreeMessage[]; changed: boolean } {
	let changed = false;
	const next = messages.map((msg) => {
		if (msg.id === updatedMsg.id) {
			changed = true;
			return { ...msg, ...updatedMsg, children: msg.children ?? updatedMsg.children ?? [] };
		}
		if (!msg.children?.length) return msg;
		const childResult = mergeUpdatedMessageById(msg.children, updatedMsg);
		if (!childResult.changed) return msg;
		changed = true;
		return { ...msg, children: childResult.messages };
	});
	return changed ? { messages: next, changed: true } : { messages, changed: false };
}

function loadedContainsMessageId(loaded: Map<string, TreeMessage[]>, messageId: string): boolean {
	for (const messages of loaded.values()) {
		if (findMessageById(messages, messageId)) return true;
	}
	return false;
}

function findMessageById(messages: TreeMessage[], messageId: string): TreeMessage | null {
	for (const msg of messages) {
		if (msg.id === messageId) return msg;
		if (msg.children?.length) {
			const child = findMessageById(msg.children, messageId);
			if (child) return child;
		}
	}
	return null;
}

export function applyUpdatedMessageById(
	state: ChunkMutState,
	updatedMsg: TreeMessage,
): ChunkMutState {
	for (const [chunkId, messages] of state.loaded) {
		const result = mergeUpdatedMessageById(messages, updatedMsg);
		if (!result.changed) continue;
		const loaded = new Map(state.loaded);
		loaded.set(chunkId, result.messages);
		return { ...state, loaded };
	}
	return state;
}

function updateCompactProgressInMessages(
	messages: TreeMessage[],
	messageId: string,
	progress: ProgressSnapshot,
	isSegment: boolean,
): { messages: TreeMessage[]; changed: boolean } {
	let changed = false;
	const expectedType = isSegment ? "segment_compact" : "compact";
	const next = messages.map((message) => {
		if (message.id === messageId) {
			const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
			let blockChanged = false;
			const contentJson = blocks.map((block) => {
				if (block.type !== expectedType || block.status !== "compacting") return block;
				// All three fields decide the label, so any of them moving is a change.
				// A server-loaded block carries none of them, and an older server sends no
				// phase — both normalize to output/0 (same rule as coerceProgressSnapshot)
				// so a duplicate output tick stays a no-op.
				if (
					block.outputChars === progress.outputChars &&
					(typeof block.thinkingChars === "number" ? block.thinkingChars : 0) ===
						progress.thinkingChars &&
					(block.progressPhase === "thinking" ? "thinking" : "output") === progress.phase
				) {
					return block;
				}
				blockChanged = true;
				return {
					...block,
					outputChars: progress.outputChars,
					thinkingChars: progress.thinkingChars,
					progressPhase: progress.phase,
				};
			});
			if (!blockChanged) return message;
			changed = true;
			return { ...message, contentJson };
		}
		if (!message.children?.length) return message;
		const childResult = updateCompactProgressInMessages(
			message.children,
			messageId,
			progress,
			isSegment,
		);
		if (!childResult.changed) return message;
		changed = true;
		return { ...message, children: childResult.messages };
	});
	return changed ? { messages: next, changed: true } : { messages, changed: false };
}

export function applyCompactProgressByMessageId(
	state: ChunkMutState,
	messageId: string,
	progress: ProgressSnapshot,
	isSegment: boolean,
): ChunkMutState {
	for (const [chunkId, messages] of state.loaded) {
		const result = updateCompactProgressInMessages(messages, messageId, progress, isSegment);
		if (!result.changed) continue;
		const loaded = new Map(state.loaded);
		loaded.set(chunkId, result.messages);
		return { ...state, loaded };
	}
	return state;
}

function removeMessagesById(
	messages: TreeMessage[],
	deletedIds: Set<string>,
): { messages: TreeMessage[]; changed: boolean } {
	let changed = false;
	const next: TreeMessage[] = [];
	for (const msg of messages) {
		if (msg.id && deletedIds.has(msg.id)) {
			changed = true;
			continue;
		}
		if (msg.children?.length) {
			const childResult = removeMessagesById(msg.children, deletedIds);
			if (childResult.changed) {
				changed = true;
				next.push({ ...msg, children: childResult.messages });
				continue;
			}
		}
		next.push(msg);
	}
	return changed ? { messages: next, changed: true } : { messages, changed: false };
}

export function removeDeletedMessagesFromLoaded(
	state: ChunkMutState,
	deletedMessageIds: string[],
): ChunkMutState {
	if (deletedMessageIds.length === 0) return state;
	const deletedIds = new Set(deletedMessageIds);
	let loaded: Map<string, TreeMessage[]> | null = null;
	for (const [chunkId, messages] of state.loaded) {
		const result = removeMessagesById(messages, deletedIds);
		if (!result.changed) continue;
		if (!loaded) loaded = new Map(state.loaded);
		loaded.set(chunkId, result.messages);
	}
	return loaded ? { ...state, loaded } : state;
}

/** Append / replace a top-level message into the chunk that owns its seq. */
function applyTopLevelMessage(
	state: ChunkMutState,
	newMsg: NarratorMsg,
	isAtBottom: boolean,
	onUnread: () => void,
	matchOptimistic?: (m: NarratorMsg) => boolean,
): ChunkMutState {
	const { loaded, manifest } = state;

	// 1. De-dupe by id across every loaded chunk, keeping live-only state in place.
	for (const [chunkId, msgs] of loaded) {
		const idx = msgs.findIndex((m) => m.id === newMsg.id);
		if (idx !== -1) {
			const updated = [...msgs];
			updated[idx] = preserveLiveSubagentActivity(updated[idx], newMsg);
			const nextLoaded = new Map(loaded);
			nextLoaded.set(chunkId, updated);
			return { ...state, loaded: nextLoaded };
		}
	}

	// 2. Optimistic replacement. Default matcher (role=user, contentText equal)
	//    covers the §2C path; callers can pass the richer §3 matcher.
	const matcher =
		matchOptimistic ??
		((m: NarratorMsg) =>
			newMsg.role === "user" &&
			String(m.id).startsWith("optimistic-") &&
			m.role === "user" &&
			m.contentText === newMsg.contentText);
	for (const [chunkId, msgs] of loaded) {
		const optimisticIdx = msgs.findIndex(matcher);
		if (optimisticIdx !== -1) {
			const withoutOptimistic = msgs.filter((_, idx) => idx !== optimisticIdx);
			const nextLoaded = new Map(loaded);
			nextLoaded.set(chunkId, insertTopLevelMessageBySeq(withoutOptimistic, newMsg));
			return { ...state, loaded: nextLoaded };
		}
	}

	// Unread bookkeeping: only assistant messages, only when scrolled away.
	if (!isAtBottom && newMsg.role === "assistant") onUnread();

	const seq =
		typeof newMsg.seq === "number" && Number.isFinite(newMsg.seq) ? newMsg.seq : undefined;

	// 3a. Empty narrator: seed the first chunk so something renders.
	if (manifest.length === 0) {
		const id = newMsg.id;
		const s = seq ?? 0;
		const nextLoaded = new Map(loaded);
		nextLoaded.set(id, [newMsg]);
		return {
			loaded: nextLoaded,
			manifest: [{ id, firstSeq: s, lastSeq: s, count: 1 }],
			total: state.total + 1,
		};
	}

	const tail = manifest[manifest.length - 1];

	// 3b. Brand-new tail seq: extend the (always-resident) tail chunk + manifest,
	// or start a new tail chunk when the current one already matches the server
	// chunk size.
	if (seq != null && seq > tail.lastSeq) {
		const tailMsgs = loaded.get(tail.id);
		if (tailMsgs) {
			const nextLoaded = new Map(loaded);
			const nextManifest = [...manifest];
			if (tail.count >= CHUNK_SIZE) {
				nextLoaded.set(newMsg.id, [newMsg]);
				nextManifest.push({ id: newMsg.id, firstSeq: seq, lastSeq: seq, count: 1 });
			} else {
				nextLoaded.set(tail.id, insertTopLevelMessageBySeq(tailMsgs, newMsg));
				nextManifest[nextManifest.length - 1] = {
					...tail,
					lastSeq: seq,
					count: tail.count + 1,
				};
			}
			return { loaded: nextLoaded, manifest: nextManifest, total: state.total + 1 };
		}
		// Tail not loaded (shouldn't happen with tail-resident guarantee) — leave
		// for the manifest reconcile to pick up.
		return state;
	}

	// 3c. Locate the chunk whose seq range contains this message.
	if (seq != null) {
		for (const chunk of manifest) {
			if (seq >= chunk.firstSeq && seq <= chunk.lastSeq) {
				const msgs = loaded.get(chunk.id);
				if (msgs) {
					const nextLoaded = new Map(loaded);
					nextLoaded.set(chunk.id, insertTopLevelMessageBySeq(msgs, newMsg));
					return { ...state, loaded: nextLoaded };
				}
				// Chunk not mounted/loaded — it will arrive via ensureLoaded on demand.
				return state;
			}
		}
	}

	// 3d. No usable seq: fall back to the resident tail chunk, but still honor
	// chunk boundaries so repeated realtime appends cannot grow the tail forever.
	const tailMsgs = loaded.get(tail.id);
	if (tailMsgs) {
		const nextLoaded = new Map(loaded);
		const nextManifest = [...manifest];
		const fallbackSeq = tail.lastSeq + 1;
		if (tail.count >= CHUNK_SIZE) {
			nextLoaded.set(newMsg.id, [newMsg]);
			nextManifest.push({
				id: newMsg.id,
				firstSeq: fallbackSeq,
				lastSeq: fallbackSeq,
				count: 1,
			});
		} else {
			nextLoaded.set(tail.id, [...tailMsgs, newMsg]);
			nextManifest[nextManifest.length - 1] = {
				...tail,
				lastSeq: fallbackSeq,
				count: tail.count + 1,
			};
		}
		return { loaded: nextLoaded, manifest: nextManifest, total: state.total + 1 };
	}
	return state;
}

function loadedContainsToolUseId(loaded: Map<string, TreeMessage[]>, toolUseId: string): boolean {
	for (const messages of loaded.values()) {
		if (findMsgByToolUseIdInTree(messages, toolUseId)) return true;
	}
	return false;
}

function collectLoadedSubagentActivityAnchors(
	messages: TreeMessage[],
	anchors: Map<string, string | undefined>,
): void {
	for (const message of messages) {
		for (const block of message.contentJson ?? []) {
			if (block.type !== "tool_use" || !block.id || !block._subagentActivity) continue;
			anchors.set(block.id, block._subagentActivity.subagentNarratorId ?? anchors.get(block.id));
		}
		for (const toolCall of message.toolCalls ?? []) {
			if (!toolCall._subagentActivity) continue;
			anchors.set(
				toolCall.toolUseId,
				toolCall._subagentActivity.subagentNarratorId ?? anchors.get(toolCall.toolUseId),
			);
		}
		if (message.children?.length) {
			collectLoadedSubagentActivityAnchors(message.children, anchors);
		}
	}
}

function mergeTopLevelStreamingChunkIntoState(
	state: ChunkMutState,
	chunk: TopLevelStreamingChunk,
): ChunkMutState {
	let found = false;
	for (const messages of state.loaded.values()) {
		if (!findMsgByToolUseIdInTree(messages, chunk.toolUseId)) continue;
		found = true;
		if (topLevelStreamingChunkMatchesPersistedTool(messages, chunk)) return state;
		break;
	}
	if (!found) return state;
	return applyToChunkContaining(state, chunk.toolUseId, (w) =>
		mergeFieldsByIndex(w, chunk.toolUseId, topLevelStreamingChunkToToolFields(chunk), EMPTY_INDEX),
	);
}

export function useNarratorChunksWS(opts: UseNarratorChunksWSOptions): UseNarratorChunksWSReturn {
	const {
		narratorId,
		isSubagent,
		initialCatchUpCursor,
		scheduleChunkUpdate,
		flushChunkUpdatesSync,
		loadedRef,
		loadedOwnerNarratorId,
		loaded,
		manifestRef,
		isAtBottomRef,
		onUnread,
		onStructuralDirty,
		onTailFollow,
	} = opts;
	const qc = useQueryClient();
	const { t } = useTranslation("narrator");

	useEffect(() => {
		if (isSubagent || loadedOwnerNarratorId !== narratorId) return;
		const anchors = new Map<string, string | undefined>();
		for (const messages of loaded.values()) {
			collectLoadedSubagentActivityAnchors(messages, anchors);
		}
		for (const [parentToolUseId, subagentNarratorId] of anchors) {
			narratorWSManager.noteSubagentActivityAnchor(narratorId, parentToolUseId, subagentNarratorId);
		}
	}, [isSubagent, loadedOwnerNarratorId, loaded, narratorId]);

	// --- Streaming text/reasoning accumulation ---
	const streamingBlocksRef = useRef<StreamingBlock[]>([]);
	/**
	 * Which text/reasoning lane last received a delta, or -1 when the model has moved
	 * on to tool calls. Published on the synthetic row so a FINISHED reasoning run
	 * settles at once instead of staying live until the turn persists; array position
	 * cannot express it (see @shared/pretext-layout/streaming-live-blocks).
	 */
	const liveBlockIndexRef = useRef(-1);
	const [streamingVersion, setStreamingVersion] = useState(0);
	const bumpStreamingVersion = useCallback(() => {
		startTransition(() => setStreamingVersion((version) => version + 1));
	}, []);
	const streamingRafRef = useRef(0);
	const flushStreamingVersion = useCallback(() => {
		if (!streamingRafRef.current) {
			streamingRafRef.current = requestAnimationFrame(() => {
				streamingRafRef.current = 0;
				bumpStreamingVersion();
			});
		}
	}, [bumpStreamingVersion]);

	// --- Top-level streaming tool chunks (rendered as the tail streamingMsg) ---
	const [topLevelChunksVersion, bumpTopLevelStreamingChunksVersion] = useState(0);
	const bumpTopLevelChunksVersion = useCallback(() => {
		startTransition(() => bumpTopLevelStreamingChunksVersion((version) => version + 1));
	}, []);
	const topLevelStreamingChunkRef = useRef<Map<string, TopLevelStreamingChunk>>(new Map());
	const reconciledTopLevelToolUseIdsRef = useRef<Set<string>>(new Set());
	const topLevelStreamingCreatedAtRef = useRef<string | null>(null);

	// --- Fine-grained tool streaming refs (rAF-batched, never cumulative) ---
	const pendingToolChunkRef = useRef<
		Map<
			string,
			{
				toolUseId: string;
				toolName: string;
				inputCharsTotal: number;
				parentToolUseId?: string;
				extractedFilePath?: string;
				contentCharsReceived?: number;
				extractedFields?: Record<string, string>;
				metadata?: Record<string, unknown>;
			}
		>
	>(new Map());
	const toolChunkRafRef = useRef(0);
	/** Accumulated streaming field value per tool (persists across RAF frames). */
	const toolStreamingFieldRef = useRef<Map<string, { name: string; value: string }>>(new Map());
	const toolOutputPreviewRef = useRef<Map<string, ToolOutputPreviewState>>(new Map());

	// Cancel pending RAF handles and clear streaming caches on unmount.
	useEffect(() => {
		return () => {
			if (streamingRafRef.current) cancelAnimationFrame(streamingRafRef.current);
			if (toolChunkRafRef.current) cancelAnimationFrame(toolChunkRafRef.current);
			streamingBlocksRef.current = [];
			liveBlockIndexRef.current = -1;
			pendingToolChunkRef.current.clear();
			toolStreamingFieldRef.current.clear();
			for (const state of toolOutputPreviewRef.current.values()) {
				if (state.timer) clearTimeout(state.timer);
			}
			toolOutputPreviewRef.current.clear();
			topLevelStreamingChunkRef.current.clear();
			reconciledTopLevelToolUseIdsRef.current.clear();
			topLevelStreamingCreatedAtRef.current = null;
		};
	}, []);

	// Reset all streaming state when switching narrators.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on narratorId change
	useEffect(() => {
		streamingBlocksRef.current = [];
		liveBlockIndexRef.current = -1;
		pendingToolChunkRef.current.clear();
		toolStreamingFieldRef.current.clear();
		for (const state of toolOutputPreviewRef.current.values()) {
			if (state.timer) clearTimeout(state.timer);
		}
		toolOutputPreviewRef.current.clear();
		topLevelStreamingChunkRef.current.clear();
		reconciledTopLevelToolUseIdsRef.current.clear();
		topLevelStreamingCreatedAtRef.current = null;
		clearToolBlockCache();
		bumpStreamingVersion();
		bumpTopLevelChunksVersion();
	}, [bumpStreamingVersion, bumpTopLevelChunksVersion, narratorId]);

	// Cancel any pending tool-chunk RAF and clear temporary streaming tool state.
	// Only clears top-level chunks by default — subagent pending chunks (those
	// with parentToolUseId) are preserved so concurrent subagents don't lose
	// their streaming state. Pass includeSubagent=true for terminal cleanup.
	const cancelPendingToolChunks = useCallback(
		(notify = true, includeSubagent = false) => {
			if (includeSubagent) {
				pendingToolChunkRef.current.clear();
				toolStreamingFieldRef.current.clear();
				for (const state of toolOutputPreviewRef.current.values()) {
					if (state.timer) clearTimeout(state.timer);
				}
				toolOutputPreviewRef.current.clear();
			} else {
				for (const [key, chunk] of pendingToolChunkRef.current) {
					if (!chunk.parentToolUseId) {
						pendingToolChunkRef.current.delete(key);
						toolStreamingFieldRef.current.delete(key);
					}
				}
			}
			const hadTopLevelChunks = topLevelStreamingChunkRef.current.size > 0;
			topLevelStreamingChunkRef.current.clear();
			reconciledTopLevelToolUseIdsRef.current.clear();
			topLevelStreamingCreatedAtRef.current = null;
			if (toolChunkRafRef.current && pendingToolChunkRef.current.size === 0) {
				cancelAnimationFrame(toolChunkRafRef.current);
				toolChunkRafRef.current = 0;
			}
			if (notify && hadTopLevelChunks) {
				bumpTopLevelChunksVersion();
			}
		},
		[bumpTopLevelChunksVersion],
	);

	/** Remove terminal top-level chunks and their persisted-card ownership marker. */
	const discardTopLevelStreamingChunks = useCallback(
		(toolUseIds: Iterable<string>, notify = true) => {
			let changed = false;
			for (const toolUseId of new Set(toolUseIds)) {
				if (topLevelStreamingChunkRef.current.delete(toolUseId)) changed = true;
				if (reconciledTopLevelToolUseIdsRef.current.delete(toolUseId)) changed = true;
			}
			if (topLevelStreamingChunkRef.current.size === 0) {
				topLevelStreamingCreatedAtRef.current = null;
			}
			if (notify && changed) bumpTopLevelChunksVersion();
		},
		[bumpTopLevelChunksVersion],
	);

	/** Keep live fields for reconciliation, but permanently assign rendering to history. */
	const markTopLevelStreamingChunksReconciled = useCallback(
		(toolUseIds: Iterable<string>, notify = true) => {
			let changed = false;
			for (const toolUseId of new Set(toolUseIds)) {
				if (!reconciledTopLevelToolUseIdsRef.current.has(toolUseId)) {
					reconciledTopLevelToolUseIdsRef.current.add(toolUseId);
					changed = true;
				}
			}
			if (notify && changed) bumpTopLevelChunksVersion();
		},
		[bumpTopLevelChunksVersion],
	);

	// Discard all synthetic streaming state when the session stops working
	// (interrupted / error / done). The chunk list renders directly from these
	// refs, so leftover streaming text blocks and top-level tool chunks would
	// otherwise linger on screen after an interrupt until a full reload. Mirrors
	// the legacy useNarratorPanelWS.onStatusChange cleanup for this layer.
	const clearStreamingOnSessionEnd = useCallback(() => {
		if (streamingBlocksRef.current.length > 0) {
			streamingBlocksRef.current = [];
			liveBlockIndexRef.current = -1;
			if (streamingRafRef.current) {
				cancelAnimationFrame(streamingRafRef.current);
				streamingRafRef.current = 0;
			}
			bumpStreamingVersion();
		}
		clearToolBlockCache();
		// Include subagent chunks: the entire session is no longer working.
		cancelPendingToolChunks(true, true);
	}, [bumpStreamingVersion, cancelPendingToolChunks]);

	// Flush a bounded tool-output preview into the chunk that owns the tool.
	const flushToolOutputPreview = useCallback(
		(toolUseId: string, preview: string) => {
			const state = toolOutputPreviewRef.current.get(toolUseId);
			if (state) {
				if (preview === state.lastFlushedPreview) return;
				state.lastFlushedPreview = preview;
				state.lastFlushAt = Date.now();
			}
			const liveChunk = topLevelStreamingChunkRef.current.get(toolUseId);
			if (liveChunk && liveChunk._streamingOutput !== preview) {
				topLevelStreamingChunkRef.current.set(toolUseId, {
					...liveChunk,
					_streamingOutput: preview,
				});
				bumpTopLevelChunksVersion();
			}
			scheduleChunkUpdate((s) =>
				applyToChunkContaining(s, toolUseId, (w) =>
					mergeFieldsByIndex(w, toolUseId, { _streamingOutput: preview }, EMPTY_INDEX),
				),
			);
		},
		[bumpTopLevelChunksVersion, scheduleChunkUpdate],
	);
	const clearToolOutputPreviewState = useCallback((toolUseId: string) => {
		const state = toolOutputPreviewRef.current.get(toolUseId);
		if (state?.timer) clearTimeout(state.timer);
		toolOutputPreviewRef.current.delete(toolUseId);
	}, []);

	// Synthetic message carrying top-level tools that history has not claimed yet.
	const topLevelStreamingChunks = useMemo<NarratorMsg | null>(() => {
		void topLevelChunksVersion; // force re-read of both refs each version bump
		const chunks = getSyntheticTopLevelStreamingChunks(
			[...topLevelStreamingChunkRef.current.values()],
			[...loaded.values()].flat(),
			reconciledTopLevelToolUseIdsRef.current,
		);
		return buildTopLevelStreamingChunksMsg(
			chunks,
			narratorId,
			topLevelStreamingCreatedAtRef.current,
		);
	}, [topLevelChunksVersion, narratorId, loaded]);

	// Re-apply live runtime fields whenever loaded history changes. The merge helper
	// is field-idempotent, so the commit produced by this effect does not loop; a
	// later history replacement that drops runtime fields is repaired again.
	useEffect(() => {
		void topLevelChunksVersion; // live ref fields changed without replacing loaded history
		const chunks = [...topLevelStreamingChunkRef.current.values()];
		const { matched } = splitTopLevelStreamingChunksByPersistedToolUse(
			chunks,
			[...loaded.values()].flat(),
		);
		if (matched.length === 0) return;
		scheduleChunkUpdate((state) => {
			let next = state;
			for (const chunk of matched) next = mergeTopLevelStreamingChunkIntoState(next, chunk);
			return next;
		});
		markTopLevelStreamingChunksReconciled(matched.map((chunk) => chunk.toolUseId));
	}, [loaded, markTopLevelStreamingChunksReconciled, scheduleChunkUpdate, topLevelChunksVersion]);

	const streamingMsg = useMemo<NarratorMsg | null>(() => {
		void streamingVersion; // force re-read of the ref each version bump
		return buildStreamingMsg({
			streamingBlocks:
				streamingBlocksRef.current.length > 0 ? streamingBlocksRef.current : undefined,
			toolChunksMsg: topLevelStreamingChunks,
			narratorId,
			liveBlockIndex: liveBlockIndexRef.current,
		});
	}, [streamingVersion, topLevelStreamingChunks, narratorId]);

	const { connected, disconnected, reconnect } = useNarratorWS(
		narratorId,
		{
			// The fold itself lives in the shared accumulator so both message lists
			// derive identical blocks AND an identical live-lane stamp. Keeping a second
			// copy here is what let the two paths drift.
			onStreamEvent: (wsData: Record<string, unknown>) => {
				const result = applyStreamingDelta(
					streamingBlocksRef.current,
					wsData.event as StreamDeltaEvent | undefined,
					isSubagent === true,
				);
				if (!result.applied) return;
				// The lane this delta landed in is the one still being written. Assigned
				// (not advanced) because a reasoning delta after a tool call legitimately
				// reopens the text lane.
				liveBlockIndexRef.current = result.blockIndex;
				flushStreamingVersion();
			},
			onStreamingReset: (parentToolUseId) => {
				// A reasoning-only dead turn was discarded server-side. Drop any live
				// streaming blocks for this page so stale reasoning that will never be
				// persisted does not linger. The owning page (top-level narrator, or the
				// subagent's own page where dualBroadcast strips parentToolUseId) receives
				// it without parentToolUseId; the parent-page duplicate keeps it set and is
				// skipped here since subagent streaming lives in the message cache.
				if (parentToolUseId) return;
				if (streamingBlocksRef.current.length > 0) {
					streamingBlocksRef.current = [];
					liveBlockIndexRef.current = -1;
					flushStreamingVersion();
				}
			},
			// A replayed attempt abandoned these tool ids while their arguments were
			// still streaming. No tool-call row was ever created for them, so neither
			// `tool_completed` nor a persisted message will arrive to retire the cards —
			// they would spin forever. Also drop any not-yet-flushed chunk frame, or the
			// pending RAF would immediately republish what we just removed.
			onToolUseDiscarded: (toolUseIds, rawParentToolUseId) => {
				if (!isSubagent && rawParentToolUseId) return;
				for (const toolUseId of toolUseIds) {
					pendingToolChunkRef.current.delete(toolUseId);
					toolStreamingFieldRef.current.delete(toolUseId);
					clearToolOutputPreviewState(toolUseId);
				}
				discardTopLevelStreamingChunks(toolUseIds);
			},
			onMessage: (wsData: { message?: NarratorMsg; [key: string]: unknown }) => {
				const message = wsData.message;
				if (!message?.id || !message?.createdAt) return;
				const newMsg = { ...message, children: message.children ?? [] };

				// Parent pages render only the lightweight _subagentActivity summary.
				// Child message bodies belong exclusively to the subagent's own page.
				if (shouldIgnoreParentChildMessage(newMsg.parentToolUseId, !!isSubagent)) return;

				// Mid-history structural inserts (compact / ask_in_passing) shift every
				// downstream seq — reconcile the manifest. If this is a same-id update for
				// an already-loaded structural marker (e.g. compacting → compacted/failed),
				// merge it immediately first; manifest tuples do not include a content hash,
				// so a diff reconcile alone may correctly find no dirty chunk to reload.
				if (isStructuralInsert(newMsg)) {
					const alreadyLoaded = loadedContainsMessageId(loadedRef.current, newMsg.id);
					if (alreadyLoaded) {
						scheduleChunkUpdate((state) => applyUpdatedMessageById(state, newMsg));
						flushChunkUpdatesSync();
					}
					onStructuralDirty(alreadyLoaded ? "diff" : "full");
					if (isAtBottomRef.current) onTailFollow();
					return;
				}

				// On a subagent's own page, clear the (parent-pointing) parentToolUseId
				// so tree-building / rendering treats this as a real top-level message.
				if (isSubagent && newMsg.parentToolUseId) newMsg.parentToolUseId = null;

				// A top-level assistant message ends the current stream. Clear the
				// streaming blocks + top-level tool chunks WITHOUT bumping versions
				// yet, append the real message, then flush + bump in the same JS turn
				// so React batches it into one render (no frame where streaming text
				// and the real message both show).
				const isAssistant = newMsg.role === "assistant";
				// A tail-append that lands while the tail chunk is not loaded is silently
				// dropped by applyTopLevelMessage with no retry. The frame already advanced
				// the manager's messageVersion, so repair it with an authoritative manifest
				// reconcile instead of waiting for an unrelated structural event.
				const droppedByTail = willDropTopLevelMessage(
					newMsg,
					loadedRef.current,
					manifestRef.current,
				);
				if (isAssistant) {
					streamingBlocksRef.current = [];
					liveBlockIndexRef.current = -1;
					if (streamingRafRef.current) {
						cancelAnimationFrame(streamingRafRef.current);
						streamingRafRef.current = 0;
					}
					clearToolBlockCache();
					cancelPendingToolChunks(false);
				}

				scheduleChunkUpdate((state) =>
					applyTopLevelMessage(state, newMsg, isAtBottomRef.current ?? false, onUnread),
				);

				if (isAssistant) {
					flushChunkUpdatesSync();
					bumpStreamingVersion();
					bumpTopLevelChunksVersion();
				}
				if (droppedByTail) onStructuralDirty("diff");
				if (isAtBottomRef.current) onTailFollow();
			},
			onUserMessage: (wsData: { message?: NarratorMsg; [key: string]: unknown }) => {
				const message = wsData.message;
				if (!message?.id || !message?.createdAt) return;
				const newMsg = { ...message, children: message.children ?? [] };

				// Parent pages ignore child message bodies; the subagent page still flattens them.
				if (shouldIgnoreParentChildMessage(newMsg.parentToolUseId, !!isSubagent)) return;
				if (isSubagent && newMsg.parentToolUseId) newMsg.parentToolUseId = null;

				// §3 optimistic matching: contentText equal, commandText equal (slash
				// commands expand server-side), or contentText prefix with an appended
				// <attached_files> hint.
				const matchOptimistic = (m: NarratorMsg) =>
					String(m.id).startsWith("optimistic-") &&
					m.role === "user" &&
					(m.contentText === newMsg.contentText ||
						(!!m.commandText && !!newMsg.commandText && m.commandText === newMsg.commandText) ||
						(!!m.contentText &&
							!!newMsg.contentText?.startsWith(m.contentText) &&
							newMsg.contentText.includes("<attached_files>")));

				// Same tail-drop guard as onMessage: the version is already counted, so
				// a silently dropped append must be repaired by an authoritative reconcile.
				const droppedByTail = willDropTopLevelMessage(
					newMsg,
					loadedRef.current,
					manifestRef.current,
				);
				scheduleChunkUpdate((state) =>
					applyTopLevelMessage(
						state,
						newMsg,
						isAtBottomRef.current ?? false,
						onUnread,
						matchOptimistic,
					),
				);
				if (droppedByTail) onStructuralDirty("diff");
				if (isAtBottomRef.current) onTailFollow();
			},
			onCatchUp: (_orphanChildren, topLevel, subagentActivities) => {
				// Compute the structural result synchronously, before queueing any updater.
				// Reading a flag written inside scheduleChunkUpdate() races with the flush.
				const structuralMode = getCatchUpStructuralMode(topLevel, loadedRef.current);
				// The replayed top-level messages go through the same applyTopLevelMessage
				// tail-drop paths as realtime frames. A catch-up usually arrives right after
				// a (re)subscribe — exactly when the tail chunk may still be loading — so
				// detect the drop synchronously and repair via the same reconcile gate.
				let tailDropped = false;
				for (const raw of topLevel) {
					if (!raw?.id || !raw?.createdAt) continue;
					if (!isSubagent && raw.parentToolUseId) continue;
					if (isStructuralInsert(raw as NarratorMsg)) continue;
					if (willDropTopLevelMessage(raw, loadedRef.current, manifestRef.current)) {
						tailDropped = true;
						break;
					}
				}

				// Persisted top-level messages supersede any restored streaming text.
				if (topLevel.length > 0) {
					streamingBlocksRef.current = [];
					liveBlockIndexRef.current = -1;
					bumpStreamingVersion();
				}

				// A snapshot can legitimately contain the same toolUseId as catch-up
				// history. Reconcile by identity instead of treating the two sources as
				// separate cards. Newly inserted history hides its matching synthetic card
				// at render time; only already-loaded matches are removed eagerly, so a
				// running tool cannot disappear if a catch-up message lands outside the
				// currently loaded chunk window.
				const liveTopLevelChunks = [...topLevelStreamingChunkRef.current.values()];
				const reconciledToolUseIds = new Set<string>();
				for (const chunk of liveTopLevelChunks) {
					if (loadedContainsToolUseId(loadedRef.current, chunk.toolUseId)) {
						reconciledToolUseIds.add(chunk.toolUseId);
					}
				}

				// Fold authoritative subagent activity snapshots, persisted history, and live
				// top-level streaming fields into one updater. Child bodies are intentionally
				// excluded from the parent cache.
				if (subagentActivities.length > 0 || topLevel.length > 0 || reconciledToolUseIds.size > 0) {
					scheduleChunkUpdate((state) => {
						let next = applySubagentActivitySnapshots(state, subagentActivities);
						for (const raw of topLevel) {
							if (!raw?.id || !raw?.createdAt) continue;
							const msg = { ...raw, children: raw.children ?? [] };
							// On a subagent's own page, topLevel items may still carry a
							// parentToolUseId (pointing at the parent narrator). The server
							// already flattens them, but guard defensively: treat as top-level.
							if (isSubagent && msg.parentToolUseId) msg.parentToolUseId = null;
							if (msg.parentToolUseId) continue;
							if (isStructuralInsert(msg)) {
								next = applyUpdatedMessageById(next, msg);
								continue;
							}
							next = applyTopLevelMessage(next, msg, isAtBottomRef.current ?? false, onUnread);
						}
						for (const chunk of liveTopLevelChunks) {
							next = mergeTopLevelStreamingChunkIntoState(next, chunk);
						}
						return next;
					});
					flushChunkUpdatesSync();
					if (reconciledToolUseIds.size > 0) {
						markTopLevelStreamingChunksReconciled(reconciledToolUseIds);
					}
				}

				if (structuralMode) onStructuralDirty(structuralMode);
				else if (tailDropped) onStructuralDirty("diff");
				if (isAtBottomRef.current) onTailFollow();
				// Defer the coordinate commit whenever a reconcile gate was opened above,
				// so the staged cursor/version publish atomically with the authoritative
				// manifest that re-fetches the dropped messages.
				return structuralMode !== undefined || tailDropped;
			},
			onFullReload: () => {
				streamingBlocksRef.current = [];
				liveBlockIndexRef.current = -1;
				cancelPendingToolChunks(true, true);
				bumpStreamingVersion();
				onStructuralDirty("full");
			},
			onSyncOk: () => {
				// Server confirmed we are in sync; messageVersion is tracked by the
				// WS manager. Nothing to reconcile.
			},
			onMessagesDeleted: (deletedMessageIds) => {
				if (deletedMessageIds.length > 0) {
					scheduleChunkUpdate((state) => removeDeletedMessagesFromLoaded(state, deletedMessageIds));
					flushChunkUpdatesSync();
				}
				onStructuralDirty();
			},
			onMessageUpdated: (updatedMsg) => {
				if (!updatedMsg?.id) return;
				const structural = isStructuralInsert(updatedMsg);
				const alreadyLoaded = loadedContainsMessageId(loadedRef.current, updatedMsg.id);
				if (alreadyLoaded) {
					scheduleChunkUpdate((state) => applyUpdatedMessageById(state, updatedMsg));
					flushChunkUpdatesSync();
				}
				if (structural) {
					// A message_updated event can arrive after the placeholder was evicted or
					// while the user was offline. Manifest tuples do not carry content hashes,
					// so always reconcile structural updates even when the ID is not loaded.
					onStructuralDirty(alreadyLoaded ? "diff" : "full");
					if (isAtBottomRef.current) onTailFollow();
				}
			},
			onSegmentCompactHide: () => {
				onStructuralDirty();
			},
			onCompactProgress: ({ messageId, isSegment, ...progress }) => {
				scheduleChunkUpdate((state) =>
					applyCompactProgressByMessageId(state, messageId, progress, isSegment),
				);
			},
			onCompactDone: () => {
				streamingBlocksRef.current = [];
				liveBlockIndexRef.current = -1;
				cancelPendingToolChunks(true, true);
				bumpStreamingVersion();
				onStructuralDirty("full");
			},
			onWebSearch: (id, status, query, queries, outputIndex, rawParentToolUseId) => {
				const parentToolUseId = isSubagent ? undefined : rawParentToolUseId;
				// Subagent native searches are delivered to the parent for bookkeeping,
				// but must not populate the parent's top-level streaming message.
				if (parentToolUseId) return;
				upsertStreamingWebSearchBlock(streamingBlocksRef.current, {
					id,
					status,
					query,
					queries,
					outputIndex,
				});
				flushStreamingVersion();
			},
			onImageGeneration: (
				id,
				status,
				revisedPrompt,
				outputIndex,
				partialImageIndex,
				partialSavedPath,
				savedPath,
				width,
				height,
				rawParentToolUseId,
			) => {
				const parentToolUseId = isSubagent ? undefined : rawParentToolUseId;
				// Subagent native image-generation events are delivered to the parent for
				// bookkeeping, but should render only in the subagent's own top-level stream.
				if (parentToolUseId) return;
				upsertStreamingImageGenerationBlock(streamingBlocksRef.current, {
					id,
					status,
					revisedPrompt,
					outputIndex,
					partialImageIndex,
					partialSavedPath,
					savedPath,
					width,
					height,
				});
				flushStreamingVersion();
			},
			// --- Tool lifecycle ---------------------------------------------------
			onToolCompleted: (
				toolUseId: string,
				status: string,
				output?: unknown,
				durationMs?: number,
				updatedInput?: Record<string, unknown>,
				metadata?: Record<string, unknown>,
				rawParentToolUseId?: string,
				activityMeta?: SubagentToolEventMeta,
			) => {
				// On a subagent's own page, its tools are top-level (no parent here).
				const parentToolUseId = isSubagent ? undefined : rawParentToolUseId;
				if (parentToolUseId) {
					scheduleChunkUpdate((state) =>
						applySubagentToolActivity(
							state,
							parentToolUseId,
							subagentHeaderFromEvent(
								toolUseId,
								activityMeta?.toolName ?? "Tool",
								status,
								activityMeta,
							),
							activityMeta,
						),
					);
					return;
				}
				const streamedOutput = toolOutputPreviewRef.current.get(toolUseId)?.preview;
				const completedOutput = preserveCompleteStreamedOutput(output, streamedOutput);

				// Discard any pending RAF chunk/output preview and accumulated raw input.
				pendingToolChunkRef.current.delete(toolUseId);
				toolStreamingFieldRef.current.delete(toolUseId);
				clearToolOutputPreviewState(toolUseId);

				const hasPersistedTool = loadedContainsToolUseId(loadedRef.current, toolUseId);

				// Promote the top-level streaming chunk to a completed card only while
				// history does not contain this tool yet. Once a partial assistant message
				// exists, the persisted card is the single render owner.
				if (!parentToolUseId && !hasPersistedTool) {
					const streamingEntry = topLevelStreamingChunkRef.current.get(toolUseId);
					if (streamingEntry) {
						topLevelStreamingChunkRef.current.set(toolUseId, {
							...streamingEntry,
							inputCharsTotal: -1,
							extractedFilePath: undefined,
							contentCharsReceived: undefined,
							_started: true,
							_input: updatedInput ?? streamingEntry._input,
							_status: status,
							_output: completedOutput.output,
							_durationMs: durationMs,
							_metadata: metadata,
							_streamingOutput: undefined,
							_streamedFullOutput: completedOutput.preserved || undefined,
						});
						bumpTopLevelChunksVersion();
					}
				}

				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) => {
						let result = updateToolCallByIndex(
							w,
							toolUseId,
							status,
							completedOutput.output,
							EMPTY_INDEX,
							durationMs,
						);
						result = mergeFieldsByIndex(
							result,
							toolUseId,
							{
								_streamingOutput: undefined,
								...(completedOutput.preserved && { _streamedFullOutput: true }),
							},
							EMPTY_INDEX,
						);
						if (updatedInput) {
							result = mergeFieldsByIndex(
								result,
								toolUseId,
								{ inputJson: updatedInput },
								EMPTY_INDEX,
							);
						}
						if (durationMs != null) {
							result = mergeFieldsByIndex(result, toolUseId, { durationMs }, EMPTY_INDEX);
						}
						if (metadata) {
							result = mergeFieldsByIndex(result, toolUseId, { _metadata: metadata }, EMPTY_INDEX);
						}
						return result;
					}),
				);
				if (hasPersistedTool && !parentToolUseId) {
					flushChunkUpdatesSync();
					discardTopLevelStreamingChunks([toolUseId]);
				}
			},
			/**
			 * Execution actually began (permission granted + final admission).
			 *
			 * The positive evidence that `running` is true. `onToolStarted` only means the
			 * INPUT finished parsing, so before this event the card had to assume execution
			 * and consequently animated an approval prompt as though work were under way.
			 *
			 * Creates the live entry when absent: eager execution means this can arrive
			 * BEFORE `tool_started`, and dropping it would lose the only fact it carries.
			 */
			onToolExecuting: (toolUseId: string, _executionStartedAt: number, rawParent?: string) => {
				const parentToolUseId = isSubagent ? undefined : rawParent;
				if (!parentToolUseId) {
					const streamingEntry = topLevelStreamingChunkRef.current.get(toolUseId);
					if (!loadedContainsToolUseId(loadedRef.current, toolUseId)) {
						topLevelStreamingChunkRef.current.set(toolUseId, {
							...(streamingEntry ?? { toolUseId, toolName: "Tool", inputCharsTotal: -1 }),
							_started: true,
							_status: "running",
						});
						bumpTopLevelChunksVersion();
					}
				}
				// The persisted half: a card already in the loaded document needs the same
				// correction, mirroring permissionResolvedPatch's allow branch.
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						mergeFieldsByIndex(w, toolUseId, { status: "running" }, EMPTY_INDEX),
					),
				);
			},
			onToolLongRunning: (toolUseId: string, _elapsed: number, rawParentToolUseId?: string) => {
				const parentToolUseId = isSubagent ? undefined : rawParentToolUseId;
				if (!parentToolUseId) {
					const streamingEntry = topLevelStreamingChunkRef.current.get(toolUseId);
					if (streamingEntry) {
						topLevelStreamingChunkRef.current.set(toolUseId, {
							...streamingEntry,
							_longRunning: true,
						});
						bumpTopLevelChunksVersion();
					}
				}
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						mergeFieldsByIndex(w, toolUseId, { _longRunning: true }, EMPTY_INDEX),
					),
				);
			},
			onToolOutput: (toolUseId: string, output: string, _parentToolUseId?: string) => {
				const preview = getToolOutputPreview(output);
				const shouldThrottle = output.length >= STREAMING_TOOL_OUTPUT_THROTTLE_MIN_CHARS;
				const now = Date.now();
				let state = toolOutputPreviewRef.current.get(toolUseId);
				if (!state) {
					state = { preview: "", lastFlushedPreview: "", lastFlushAt: 0, timer: null };
					toolOutputPreviewRef.current.set(toolUseId, state);
				}
				if (preview === state.preview) return;
				state.preview = preview;

				if (!shouldThrottle) {
					if (state.timer) {
						clearTimeout(state.timer);
						state.timer = null;
					}
					flushToolOutputPreview(toolUseId, preview);
					return;
				}

				const elapsed = now - state.lastFlushAt;
				if (elapsed >= STREAMING_TOOL_OUTPUT_THROTTLE_MS) {
					if (state.timer) {
						clearTimeout(state.timer);
						state.timer = null;
					}
					flushToolOutputPreview(toolUseId, preview);
					return;
				}

				if (!state.timer) {
					state.timer = setTimeout(() => {
						const latest = toolOutputPreviewRef.current.get(toolUseId);
						if (!latest) return;
						latest.timer = null;
						flushToolOutputPreview(toolUseId, latest.preview);
					}, STREAMING_TOOL_OUTPUT_THROTTLE_MS - elapsed);
				}
			},
			onToolStarted: (
				toolUseId: string,
				toolName: string,
				streamStartedAt?: number,
				input?: Record<string, unknown>,
				rawParentToolUseId?: string,
				activityMeta?: SubagentToolEventMeta,
			) => {
				const parentToolUseId = isSubagent ? undefined : rawParentToolUseId;
				pendingToolChunkRef.current.delete(toolUseId);
				if (parentToolUseId) {
					scheduleChunkUpdate((state) =>
						applySubagentToolActivity(
							state,
							parentToolUseId,
							subagentHeaderFromEvent(toolUseId, toolName, "running", activityMeta),
							activityMeta,
						),
					);
					return;
				}
				// A tool of THIS row started, so no text lane is open: whatever reasoning or
				// text preceded it is finished and must settle now.
				liveBlockIndexRef.current = -1;
				const hasPersistedTool = loadedContainsToolUseId(loadedRef.current, toolUseId);

				if (!parentToolUseId) {
					const streamingEntry = topLevelStreamingChunkRef.current.get(toolUseId);
					topLevelStreamingChunkRef.current.set(toolUseId, {
						...(streamingEntry ?? { toolUseId, toolName, inputCharsTotal: -1 }),
						toolName,
						inputCharsTotal: -1, // sentinel: no longer streaming
						extractedFilePath: undefined,
						contentCharsReceived: undefined,
						_started: true,
						_input: input,
						_startedAt: streamStartedAt,
						// ⚠️ Preserve a status that is already further along. Eager execution means
						// `tool_executing` (→ `running`) can land BEFORE this frame, and letting the
						// promotion default reset it would demote a demonstrably executing tool back
						// to the neutral phase. `_input` above still merges — that is the whole point
						// of guarding only this one field. See streaming-tool-chunks.ts's
						// `resolveLiveToolStatus` for the shared rule.
						...(streamingEntry?._status === "running" ? { _status: "running" } : {}),
					});
					if (!topLevelStreamingCreatedAtRef.current) {
						topLevelStreamingCreatedAtRef.current = new Date().toISOString();
					}
					bumpTopLevelChunksVersion();
				}

				scheduleChunkUpdate((state) => {
					const fields: Record<string, unknown> = {
						status: "running",
						startedAt: streamStartedAt ?? Date.now(),
						...(streamStartedAt != null ? { streamStartedAt } : {}),
						...(input ? { inputJson: input } : {}),
					};
					if (input?.timeout != null && typeof input.timeout === "number") {
						fields._timeoutMs = input.timeout;
					}
					return applyToChunkContaining(state, toolUseId, (w) =>
						mergeFieldsByIndex(w, toolUseId, fields, EMPTY_INDEX),
					);
				});
				if (hasPersistedTool && !parentToolUseId) {
					flushChunkUpdatesSync();
					markTopLevelStreamingChunksReconciled([toolUseId]);
				}
			},
			onToolUseChunk: (
				toolUseId: string,
				toolName: string,
				inputCharsTotal: number,
				rawParentToolUseId?: string,
				extractedFilePath?: string,
				contentCharsReceived?: number,
				extractedFields?: Record<string, string>,
				metadata?: Record<string, unknown>,
				streamingField?: { name: string; delta: string },
				activityMeta?: SubagentToolEventMeta,
			) => {
				// On a subagent's own page, its tools are top-level (no parent here).
				const parentToolUseId = isSubagent ? undefined : rawParentToolUseId;
				if (parentToolUseId) {
					scheduleChunkUpdate((state) =>
						applySubagentToolActivity(
							state,
							parentToolUseId,
							subagentHeaderFromEvent(toolUseId, toolName, "streaming", activityMeta),
							activityMeta,
						),
					);
					return;
				}
				// The model is writing tool arguments → no text lane is open (see the note
				// in onToolStarted).
				liveBlockIndexRef.current = -1;
				// Accumulate streaming field value across frames (not cleared per RAF).
				if (streamingField) {
					const prev = toolStreamingFieldRef.current.get(toolUseId);
					if (prev && prev.name === streamingField.name) {
						prev.value = getStreamingFieldPreview(prev.value + streamingField.delta);
					} else {
						toolStreamingFieldRef.current.set(toolUseId, {
							name: streamingField.name,
							value: getStreamingFieldPreview(streamingField.delta),
						});
					}
				}
				// Accumulate the latest state per toolUseId; flush once per frame.
				pendingToolChunkRef.current.set(toolUseId, {
					toolUseId,
					toolName,
					inputCharsTotal,
					parentToolUseId,
					extractedFilePath,
					contentCharsReceived,
					extractedFields,
					metadata,
				});
				if (!toolChunkRafRef.current) {
					toolChunkRafRef.current = requestAnimationFrame(() => {
						toolChunkRafRef.current = 0;
						const pending = pendingToolChunkRef.current;
						if (pending.size === 0) return;
						const chunks = [...pending.values()];
						pending.clear();

						let topLevelChanged = false;
						const reconciledToolUseIds = new Set<string>();
						for (const chunk of chunks) {
							if (chunk.parentToolUseId) continue;
							const sf = toolStreamingFieldRef.current.get(chunk.toolUseId);
							const liveChunk: TopLevelStreamingChunk = {
								toolUseId: chunk.toolUseId,
								toolName: chunk.toolName,
								inputCharsTotal: chunk.inputCharsTotal,
								extractedFilePath: chunk.extractedFilePath,
								contentCharsReceived: chunk.contentCharsReceived,
								extractedFields: chunk.extractedFields,
								metadata: chunk.metadata,
								streamingFieldName: sf?.name,
								streamingFieldValue: sf?.value,
							};
							topLevelStreamingChunkRef.current.set(chunk.toolUseId, liveChunk);
							topLevelChanged = true;
							if (loadedContainsToolUseId(loadedRef.current, chunk.toolUseId)) {
								scheduleChunkUpdate((state) =>
									mergeTopLevelStreamingChunkIntoState(state, liveChunk),
								);
								reconciledToolUseIds.add(chunk.toolUseId);
								continue;
							}
							if (!topLevelStreamingCreatedAtRef.current) {
								topLevelStreamingCreatedAtRef.current = new Date().toISOString();
							}
						}
						if (reconciledToolUseIds.size > 0) {
							flushChunkUpdatesSync();
							markTopLevelStreamingChunksReconciled(reconciledToolUseIds);
						}
						if (topLevelChanged) {
							bumpTopLevelChunksVersion();
						}
					});
				}
			},
			onTimeoutUpdated: (toolUseId: string, timeoutMs: number) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						mergeFieldsByIndex(w, toolUseId, { _timeoutMs: timeoutMs }, EMPTY_INDEX),
					),
				);
			},
			// --- Subagents --------------------------------------------------------
			onSubagentStarted: (
				toolUseId: string,
				model?: string,
				subagentNarratorId?: string,
				reasoningEffort?: string,
			) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (cache) => {
						return updateSubagentActivityInCache(cache, toolUseId, (current) => {
							const effectiveReasoningEffort =
								normalizeSubagentReasoningEffort(reasoningEffort) ??
								normalizeSubagentReasoningEffort(current?.reasoningEffort);
							return {
								subagentNarratorId: subagentNarratorId ?? current?.subagentNarratorId ?? null,
								model: normalizeSubagentModel(model) ?? normalizeSubagentModel(current?.model),
								...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
								latestToolCalls: current?.latestToolCalls ?? [],
							};
						});
					}),
				);
			},
			onSubagentConclusionUpdated: (
				subagentNarratorId: string,
				toolUseId: string,
				output: unknown,
				hasError: boolean,
				completedAt?: string | number,
				durationMs?: number,
			) => {
				// Clean up client-only _retryInfo from the subagent narrator cache.
				qc.setQueryData(
					["narrators", subagentNarratorId],
					// biome-ignore lint/suspicious/noExplicitAny: dynamic narrator shape
					(old: any) => (old ? { ...old, _retryInfo: undefined } : old),
				);
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						mergeFieldsByIndex(
							w,
							toolUseId,
							{
								outputJson: output,
								status: hasError ? "fail" : "success",
								...(completedAt != null ? { completedAt } : {}),
								...(durationMs != null ? { durationMs } : {}),
							},
							EMPTY_INDEX,
						),
					),
				);
			},
			// --- Permission gates (card status only; perms UI is phase 4) ---------
			onPermissionRequest: (request) => {
				const tuId = request.toolUseId;
				if (!tuId) return;
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, tuId, (w) =>
						mergeFieldsByIndex(w, tuId, { status: "pending" }, EMPTY_INDEX),
					),
				);
			},
			onPermissionResolved: (
				_requestId,
				toolUseId,
				updatedInput,
				decision,
				feedbackText,
				subagentNarratorId,
			) => {
				if (!toolUseId) return;
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) => {
						if (decision === "deny") {
							return mergeFieldsByIndex(
								w,
								toolUseId,
								{ status: "fail", permissionDenyMessage: feedbackText?.trim() || null },
								EMPTY_INDEX,
							);
						}
						if (decision !== "allow") return w;
						return mergeFieldsByIndex(
							w,
							toolUseId,
							{
								status: "running",
								startedAt: Date.now(),
								...(updatedInput ? { inputJson: updatedInput } : {}),
							},
							EMPTY_INDEX,
						);
					}),
				);
				if (subagentNarratorId) {
					qc.invalidateQueries({ queryKey: ["narrators", subagentNarratorId] });
				}
			},
			// --- Reflection gates (card status only) ------------------------------
			onDangerReflectionStarted: ({ requestId, toolUseId, danger }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						applyChunkReflection(w, toolUseId, requestId, "danger_reflection", "started", {
							status: "pending",
							permissionDecisionReason:
								typeof danger === "object" && danger && "summary" in danger
									? `Danger reflection: ${String((danger as { summary?: unknown }).summary ?? "")}`
									: "Danger reflection in progress",
							permissionSuggestions: [
								{ type: "danger_reflection", status: "running", danger, requestId },
							],
						}),
					),
				);
			},
			onDangerReflectionStopped: ({ requestId, toolUseId, danger, inputJson, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						applyChunkReflection(w, toolUseId, requestId, "danger_reflection", "terminal", {
							status: "pending",
							...(inputJson ? { inputJson } : {}),
							permissionDecisionReason:
								reason ?? "Danger reflection stopped; awaiting user decision",
							permissionSuggestions: [
								{ type: "danger_reflection", status: "awaiting_user", danger, requestId, reason },
							],
						}),
					),
				);
				qc.invalidateQueries({ queryKey: ["permissions", narratorId] });
			},
			onDangerReflectionResolved: ({ requestId, toolUseId, decision, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) => {
						const status = decision === "allow" ? "running" : "fail";
						return applyChunkReflection(w, toolUseId, requestId, "danger_reflection", "terminal", {
							status,
							...(decision === "allow" ? { startedAt: Date.now() } : {}),
							...(decision !== "allow" ? { errorMessage: reason ?? null } : {}),
							permissionDecisionReason: reason ?? null,
							permissionSuggestions: [
								{
									type: "danger_reflection",
									status:
										decision === "allow"
											? "confirmed"
											: decision === "aborted"
												? "aborted"
												: "cancelled",
									requestId,
									reason,
								},
							],
						});
					}),
				);
			},
			onPlanReflectionStarted: ({ requestId, toolUseId, inputJson, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						applyChunkReflection(w, toolUseId, requestId, "plan_reflection", "started", {
							status: "pending",
							...(inputJson ? { inputJson } : {}),
							permissionDecisionReason: reason ?? "Plan reflection in progress",
							permissionSuggestions: [
								{ type: "plan_reflection", status: "running", requestId, reason },
							],
						}),
					),
				);
			},
			onPlanReflectionStopped: ({ requestId, toolUseId, inputJson, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						applyChunkReflection(w, toolUseId, requestId, "plan_reflection", "terminal", {
							status: "pending",
							...(inputJson ? { inputJson } : {}),
							permissionDecisionReason: reason ?? "Plan reflection stopped; awaiting user decision",
							permissionSuggestions: [
								{ type: "plan_reflection", status: "awaiting_user", requestId, reason },
							],
						}),
					),
				);
				qc.invalidateQueries({ queryKey: ["permissions", narratorId] });
			},
			onPlanReflectionResolved: ({ requestId, toolUseId, decision, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) => {
						const status = decision === "allow" ? "running" : "fail";
						return applyChunkReflection(w, toolUseId, requestId, "plan_reflection", "terminal", {
							status,
							...(decision === "allow" ? { startedAt: Date.now() } : {}),
							...(decision !== "allow" ? { errorMessage: reason ?? null } : {}),
							permissionDecisionReason: reason ?? null,
							permissionSuggestions: [
								{
									type: "plan_reflection",
									status:
										decision === "allow"
											? "confirmed"
											: decision === "aborted"
												? "aborted"
												: "cancelled",
									requestId,
									reason,
								},
							],
						});
					}),
				);
			},
			onTaskReflectionStarted: ({ requestId, toolUseId, inputJson, mutations, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						applyChunkReflection(w, toolUseId, requestId, "task_reflection", "started", {
							status: "pending",
							...(inputJson ? { inputJson } : {}),
							permissionDecisionReason: reason ?? "Task reflection in progress",
							permissionSuggestions: [
								{ type: "task_reflection", status: "running", requestId, reason, mutations },
							],
						}),
					),
				);
			},
			onTaskReflectionResolved: ({ requestId, toolUseId, decision, reason, nextSteps }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) => {
						const status = decision === "allow" ? "running" : "fail";
						return applyChunkReflection(w, toolUseId, requestId, "task_reflection", "terminal", {
							status,
							...(decision === "allow" ? { startedAt: Date.now() } : {}),
							...(decision !== "allow" ? { errorMessage: reason ?? null } : {}),
							permissionDecisionReason: reason ?? null,
							permissionSuggestions: [
								{
									type: "task_reflection",
									status:
										decision === "allow"
											? "confirmed"
											: decision === "aborted"
												? "aborted"
												: "cancelled",
									requestId,
									reason,
									nextSteps,
								},
							],
						});
					}),
				);
			},
			onTaskReflectionStopped: ({ requestId, toolUseId, mutations, inputJson, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						applyChunkReflection(w, toolUseId, requestId, "task_reflection", "terminal", {
							status: "pending",
							...(inputJson ? { inputJson } : {}),
							permissionDecisionReason: reason ?? "Task reflection stopped; awaiting user decision",
							permissionSuggestions: [
								{
									type: "task_reflection",
									status: "awaiting_user",
									requestId,
									reason,
									mutations,
								},
							],
						}),
					),
				);
				qc.invalidateQueries({ queryKey: ["permissions", narratorId] });
			},
			onQuestionReflectionStarted: ({ requestId, toolUseId, inputJson, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						applyChunkReflection(w, toolUseId, requestId, "question_reflection", "started", {
							status: "pending",
							...(inputJson ? { inputJson } : {}),
							permissionDecisionReason: reason ?? "Question reflection in progress",
							permissionSuggestions: [
								{ type: "question_reflection", status: "running", requestId, reason },
							],
						}),
					),
				);
			},
			onQuestionReflectionResolved: ({ requestId, toolUseId, decision, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) => {
						const reflectionStatus =
							decision === "allow"
								? "confirmed"
								: decision === "aborted"
									? "awaiting_user"
									: "cancelled";
						return applyChunkReflection(
							w,
							toolUseId,
							requestId,
							"question_reflection",
							"terminal",
							{
								status: decision === "allow" ? "running" : "pending",
								...(decision === "allow" ? { startedAt: Date.now() } : {}),
								permissionDecisionReason: reason ?? null,
								permissionSuggestions: [
									{ type: "question_reflection", status: reflectionStatus, requestId, reason },
								],
							},
						);
					}),
				);
			},
			// --- Background tasks -------------------------------------------------
			onBackgroundTaskCompleted: (_taskNarratorId, toolUseId, resultPreview) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						updateToolCallByIndex(
							w,
							toolUseId,
							"success",
							[{ type: "text", text: resultPreview }],
							EMPTY_INDEX,
						),
					),
				);
				qc.invalidateQueries({ queryKey: ["background-tasks", narratorId] });
				notifications.show({
					title: t("backgroundTasks.completed"),
					message: resultPreview?.slice(0, 100) || "",
					color: "green",
					autoClose: 5000,
				});
			},
			onBackgroundTaskFailed: (_taskNarratorId, toolUseId, error) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) => {
						let result = updateToolCallByIndex(
							w,
							toolUseId,
							"fail",
							[{ type: "text", text: error }],
							EMPTY_INDEX,
						);
						result = mergeFieldsByIndex(result, toolUseId, { errorMessage: error }, EMPTY_INDEX);
						return result;
					}),
				);
				qc.invalidateQueries({ queryKey: ["background-tasks", narratorId] });
				notifications.show({
					title: t("backgroundTasks.failed"),
					message: error?.slice(0, 100) || "",
					color: "red",
					autoClose: 8000,
				});
			},
			onBackgroundTaskCancelled: (_taskNarratorId, toolUseId) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						updateToolCallByIndex(
							w,
							toolUseId,
							"cancelled",
							[{ type: "text", text: "Cancelled" }],
							EMPTY_INDEX,
						),
					),
				);
				qc.invalidateQueries({ queryKey: ["background-tasks", narratorId] });
			},
			// --- Streaming snapshot (reconnect restore) ---------------------------
			onStreamingSnapshot: (snapshot) => {
				if (snapshot.streamingBlocks.length > 0) {
					// Merge rather than replace: a snapshot may arrive slightly after a
					// realtime delta on the same subscription, so it must fill gaps
					// without letting already-shown streaming text/reasoning regress.
					if (mergeStreamingSnapshotBlocks(streamingBlocksRef.current, snapshot.streamingBlocks)) {
						flushStreamingVersion();
					}
				}
				if (snapshot.toolChunks.length === 0) return;
				let topLevelChanged = false;
				const reconciledToolUseIds = new Set<string>();
				for (const chunk of snapshot.toolChunks) {
					// On a subagent's own page, tool chunks are top-level (no parent here).
					const chunkParent = isSubagent ? undefined : chunk.parentToolUseId;
					if (chunkParent) {
						const activityMeta: SubagentToolEventMeta = {
							toolCallId: chunk.toolCallId,
							toolName: chunk.toolName,
							createdAt: chunk.createdAt,
							timing: chunk.timing,
							subagentNarratorId: chunk.subagentNarratorId,
							model: chunk.model,
							...(chunk.inputSummary ? { inputSummary: chunk.inputSummary } : {}),
						};
						scheduleChunkUpdate((state) =>
							applySubagentToolActivity(
								state,
								chunkParent,
								subagentHeaderFromEvent(
									chunk.toolUseId,
									chunk.toolName,
									// `executing` is the only field that proves the tool is running;
									// `started` merely means its input finished parsing, so a
									// reconnect mid-approval used to be restored as "running".
									chunk.executing ? "running" : chunk.started ? "initializing" : "streaming",
									activityMeta,
								),
								activityMeta,
							),
						);
						continue;
					}

					const liveChunk: TopLevelStreamingChunk = chunk.started
						? {
								toolUseId: chunk.toolUseId,
								toolName: chunk.toolName,
								inputCharsTotal: -1,
								_started: true,
								// Restore the tool's real phase. Without `executing` the only signal was
								// `started` ("input parsed"), so reconnecting while a tool waited for
								// approval brought it back as though it were running.
								_status: chunk.executing ? "running" : "initializing",
								_input: chunk.input as Record<string, unknown> | undefined,
								_startedAt: chunk.streamStartedAt,
								_streamingOutput: chunk.streamingOutput,
								_metadata: chunk.metadata,
							}
						: {
								toolUseId: chunk.toolUseId,
								toolName: chunk.toolName,
								inputCharsTotal: chunk.inputCharsTotal,
								extractedFilePath: chunk.extractedFilePath,
								contentCharsReceived: chunk.contentCharsReceived,
								extractedFields: chunk.extractedFields,
								metadata: chunk.metadata,
							};
					topLevelStreamingChunkRef.current.set(chunk.toolUseId, liveChunk);
					topLevelChanged = true;
					if (loadedContainsToolUseId(loadedRef.current, chunk.toolUseId)) {
						scheduleChunkUpdate((state) => mergeTopLevelStreamingChunkIntoState(state, liveChunk));
						reconciledToolUseIds.add(chunk.toolUseId);
						continue;
					}

					if (!topLevelStreamingCreatedAtRef.current) {
						topLevelStreamingCreatedAtRef.current = new Date().toISOString();
					}
				}
				if (reconciledToolUseIds.size > 0) {
					flushChunkUpdatesSync();
					markTopLevelStreamingChunksReconciled(reconciledToolUseIds);
				}
				if (topLevelChanged) {
					bumpTopLevelChunksVersion();
				}
			},
			// --- Session lifecycle ------------------------------------------------
			// When the narrator stops working (interrupted / done / error), discard
			// any half-streamed text blocks and top-level tool chunks so they don't
			// linger on screen after an interrupt.
			onStatusChange: (status) => {
				if (status === "working" || status === "waiting") return;
				clearStreamingOnSessionEnd();
			},
			onNarratorError: () => {
				clearStreamingOnSessionEnd();
			},
		},
		initialCatchUpCursor,
		{ kind: "messages" },
	);

	return useMemo(
		() => ({ streamingMsg, connected, disconnected, reconnect }),
		[streamingMsg, connected, disconnected, reconnect],
	);
}
