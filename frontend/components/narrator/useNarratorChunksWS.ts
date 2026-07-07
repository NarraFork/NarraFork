import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarratorWS } from "../../hooks/useNarratorWS";
import type { ChunkManifestEntry, SideCarRecord, TreeMessage } from "../../lib/api";
import {
	buildStreamingMsg,
	clearToolBlockCache,
	findStreamingInsertIndex,
	mergeStreamingSnapshotBlocks,
	type StreamingBlock,
	upsertStreamingImageGenerationBlock,
	upsertStreamingWebSearchBlock,
} from "./message-segments";
import {
	findMsgByToolUseIdInTree,
	insertChildIntoCache,
	type MessageIndex,
	mergeFieldsByIndex,
	removeSubagentStreamingChunk,
	updateToolCallByIndex,
	upsertSubagentStreamingChunk,
} from "./message-tree-utils";
import {
	appendSideCarsToLatestAssistant,
	appendStreamingTextPreview,
	buildTopLevelStreamingChunksMsg,
	getStreamingFieldPreview,
	getToolOutputPreview,
	insertTopLevelMessageBySeq,
	preserveCompleteStreamedOutput,
	preserveLiveSideCars,
	type TopLevelStreamingChunk,
} from "./narrator-message-helpers";
import type { ContentBlock, NarratorMsg } from "./narrator-panel-types";

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
	/** Anchor for WS catch-up: deepest last child of the tail chunk (no synthetic). */
	lastMessageId: string | undefined;
	/** rAF-batched scheduler that folds updaters and commits via setState once per frame. */
	scheduleChunkUpdate: (updater: ChunkUpdater) => void;
	/** Synchronously flush queued chunk updaters (used to batch with streaming-version bumps). */
	flushChunkUpdatesSync: () => void;
	/** Latest loaded map (read inside updaters / dedupe scans). */
	loadedRef: React.RefObject<Map<string, TreeMessage[]>>;
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

/** Does this message carry a mid-history structural block (compact / ask_in_passing)? */
function isStructuralInsert(msg: NarratorMsg): boolean {
	if (msg.role !== "system" && msg.role !== "disp") return false;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return blocks.some((b: ContentBlock) => b.type === "compact" || b.type === "ask_in_passing");
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

	// 1. De-dupe by id across every loaded chunk; merge live side-cars in place.
	for (const [chunkId, msgs] of loaded) {
		const idx = msgs.findIndex((m) => m.id === newMsg.id);
		if (idx !== -1) {
			const updated = [...msgs];
			updated[idx] = preserveLiveSideCars(updated[idx], newMsg);
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

export function useNarratorChunksWS(opts: UseNarratorChunksWSOptions): UseNarratorChunksWSReturn {
	const {
		narratorId,
		isSubagent,
		lastMessageId,
		scheduleChunkUpdate,
		flushChunkUpdatesSync,
		loadedRef,
		isAtBottomRef,
		onUnread,
		onStructuralDirty,
		onTailFollow,
	} = opts;
	const qc = useQueryClient();
	const { t } = useTranslation("narrator");

	// --- Streaming text/reasoning accumulation ---
	const streamingBlocksRef = useRef<StreamingBlock[]>([]);
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
			pendingToolChunkRef.current.clear();
			toolStreamingFieldRef.current.clear();
			for (const state of toolOutputPreviewRef.current.values()) {
				if (state.timer) clearTimeout(state.timer);
			}
			toolOutputPreviewRef.current.clear();
			topLevelStreamingChunkRef.current.clear();
			topLevelStreamingCreatedAtRef.current = null;
		};
	}, []);

	// Reset all streaming state when switching narrators.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on narratorId change
	useEffect(() => {
		streamingBlocksRef.current = [];
		pendingToolChunkRef.current.clear();
		toolStreamingFieldRef.current.clear();
		for (const state of toolOutputPreviewRef.current.values()) {
			if (state.timer) clearTimeout(state.timer);
		}
		toolOutputPreviewRef.current.clear();
		topLevelStreamingChunkRef.current.clear();
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

	// Discard all synthetic streaming state when the session stops working
	// (interrupted / error / done). The chunk list renders directly from these
	// refs, so leftover streaming text blocks and top-level tool chunks would
	// otherwise linger on screen after an interrupt until a full reload. Mirrors
	// the legacy useNarratorPanelWS.onStatusChange cleanup for this layer.
	const clearStreamingOnSessionEnd = useCallback(() => {
		if (streamingBlocksRef.current.length > 0) {
			streamingBlocksRef.current = [];
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
			scheduleChunkUpdate((s) =>
				applyToChunkContaining(s, toolUseId, (w) =>
					mergeFieldsByIndex(w, toolUseId, { _streamingOutput: preview }, EMPTY_INDEX),
				),
			);
		},
		[scheduleChunkUpdate],
	);
	const clearToolOutputPreviewState = useCallback((toolUseId: string) => {
		const state = toolOutputPreviewRef.current.get(toolUseId);
		if (state?.timer) clearTimeout(state.timer);
		toolOutputPreviewRef.current.delete(toolUseId);
	}, []);

	// Synthetic message carrying the currently-streaming top-level tool cards.
	const topLevelStreamingChunks = useMemo<NarratorMsg | null>(() => {
		void topLevelChunksVersion; // force re-read of the ref each version bump
		return buildTopLevelStreamingChunksMsg(
			[...topLevelStreamingChunkRef.current.values()],
			narratorId,
			topLevelStreamingCreatedAtRef.current,
		);
	}, [topLevelChunksVersion, narratorId]);

	const streamingMsg = useMemo<NarratorMsg | null>(() => {
		void streamingVersion; // force re-read of the ref each version bump
		return buildStreamingMsg({
			streamingBlocks:
				streamingBlocksRef.current.length > 0 ? streamingBlocksRef.current : undefined,
			toolChunksMsg: topLevelStreamingChunks,
			narratorId,
		});
	}, [streamingVersion, topLevelStreamingChunks, narratorId]);

	const { connected, disconnected, reconnect } = useNarratorWS(
		narratorId,
		{
			onStreamEvent: (wsData: Record<string, unknown>) => {
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				const ev = wsData.event as Record<string, any> | undefined;
				if (ev?.type !== "content_block_delta") return;
				// On a subagent's own page, the self-broadcast may still carry
				// subagentToolUseId (e.g. runAgentLoop takeover paths that don't
				// strip it). Treat such deltas as this page's top-level stream.
				if (!isSubagent && ev.subagentToolUseId) return;
				if (!ev.delta?.text) return;

				if (ev.delta.type === "text_delta") {
					const blocks = streamingBlocksRef.current;
					const outputIndex = typeof ev.outputIndex === "number" ? ev.outputIndex : undefined;
					const existingIdx =
						outputIndex != null
							? blocks.findIndex((b) => b.type === "text" && b.outputIndex === outputIndex)
							: -1;
					if (existingIdx !== -1) {
						const existing = blocks[existingIdx];
						if (existing.type === "text") {
							existing.text = appendStreamingTextPreview(existing.text, ev.delta.text);
						}
					} else {
						const lastBlock = blocks[blocks.length - 1];
						if (lastBlock?.type === "text" && outputIndex == null) {
							lastBlock.text = appendStreamingTextPreview(lastBlock.text, ev.delta.text);
						} else {
							blocks.splice(findStreamingInsertIndex(blocks, outputIndex), 0, {
								type: "text",
								text: appendStreamingTextPreview("", ev.delta.text),
								...(outputIndex != null ? { outputIndex } : {}),
							});
						}
					}
					flushStreamingVersion();
					return;
				}
				if (ev.delta.type === "reasoning_delta") {
					const blocks = streamingBlocksRef.current;
					const reasoningId =
						typeof ev.delta.id === "string" && ev.delta.id.length > 0 ? ev.delta.id : undefined;
					const outputIndex =
						typeof ev.delta.outputIndex === "number" ? ev.delta.outputIndex : undefined;
					const existingIdx = blocks.findIndex((b) => {
						if (b.type !== "reasoning") return false;
						if (reasoningId) return b.id === reasoningId;
						if (outputIndex != null) return b.outputIndex === outputIndex;
						return !b.id && b.outputIndex == null;
					});
					if (existingIdx !== -1) {
						const existing = blocks[existingIdx];
						if (existing.type === "reasoning") {
							existing.text = appendStreamingTextPreview(existing.text, ev.delta.text);
							if (reasoningId) existing.id = reasoningId;
							if (outputIndex != null) existing.outputIndex = outputIndex;
						}
					} else {
						blocks.splice(findStreamingInsertIndex(blocks, outputIndex), 0, {
							type: "reasoning",
							text: appendStreamingTextPreview("", ev.delta.text),
							...(reasoningId ? { id: reasoningId } : {}),
							...(outputIndex != null ? { outputIndex } : {}),
						});
					}
					flushStreamingVersion();
				}
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
					flushStreamingVersion();
				}
			},
			onMessage: (wsData: { message?: NarratorMsg; [key: string]: unknown }) => {
				const message = wsData.message;
				if (!message?.id || !message?.createdAt) return;
				const newMsg = { ...message, children: message.children ?? [] };

				// Subagent (child) messages land in their parent tool call's children.
				// Assistant children additionally clear the synthetic streaming chunk.
				// EXCEPTION: on a subagent's own page (isSubagent), these messages ARE
				// this narrator's own messages — their parentToolUseId points at the
				// parent narrator's tool_use, which doesn't exist here. Route them as
				// top-level, mirroring the server's isSubagent flattening.
				if (newMsg.parentToolUseId && !isSubagent) {
					const ptu = newMsg.parentToolUseId;
					const isAssistantChild = newMsg.role === "assistant";
					scheduleChunkUpdate((state) =>
						applyToChunkContaining(state, ptu, (w) => {
							let result = w;
							if (isAssistantChild) result = removeSubagentStreamingChunk(result, ptu);
							result = insertChildIntoCache(result, newMsg);
							return result;
						}),
					);
					return;
				}

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
				if (isAssistant) {
					streamingBlocksRef.current = [];
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
				if (isAtBottomRef.current) onTailFollow();
			},
			onUserMessage: (wsData: { message?: NarratorMsg; [key: string]: unknown }) => {
				const message = wsData.message;
				if (!message?.id || !message?.createdAt) return;
				const newMsg = { ...message, children: message.children ?? [] };

				// Subagent user messages insert into their parent tool call's children.
				// On a subagent's own page, route as top-level instead (see onMessage).
				if (newMsg.parentToolUseId && !isSubagent) {
					const ptu = newMsg.parentToolUseId;
					scheduleChunkUpdate((state) =>
						applyToChunkContaining(state, ptu, (w) => insertChildIntoCache(w, newMsg)),
					);
					return;
				}
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

				scheduleChunkUpdate((state) =>
					applyTopLevelMessage(
						state,
						newMsg,
						isAtBottomRef.current ?? false,
						onUnread,
						matchOptimistic,
					),
				);
				if (isAtBottomRef.current) onTailFollow();
			},
			onCatchUp: (orphanChildren, topLevel) => {
				// Persisted top-level messages supersede any restored streaming text.
				if (topLevel.length > 0) {
					streamingBlocksRef.current = [];
					bumpStreamingVersion();
				}
				// Subagent (orphan) children rejoin their parent tool call's tree.
				if (orphanChildren.length > 0) {
					scheduleChunkUpdate((state) => {
						let next = state;
						for (const raw of orphanChildren) {
							if (!raw?.id || !raw.parentToolUseId) continue;
							const child = { ...raw, children: raw.children ?? [] };
							const ptu = child.parentToolUseId as string;
							next = applyToChunkContaining(next, ptu, (w) => insertChildIntoCache(w, child));
						}
						return next;
					});
				}
				if (topLevel.length === 0) {
					if (isAtBottomRef.current) onTailFollow();
					return;
				}
				let structural = false;
				scheduleChunkUpdate((state) => {
					let next = state;
					for (const raw of topLevel) {
						if (!raw?.id || !raw?.createdAt) continue;
						const msg = { ...raw, children: raw.children ?? [] };
						// On a subagent's own page, topLevel items may still carry a
						// parentToolUseId (pointing at the parent narrator). The server
						// already flattens them, but guard defensively: treat as top-level.
						if (isSubagent && msg.parentToolUseId) msg.parentToolUseId = null;
						if (msg.parentToolUseId) continue;
						if (isStructuralInsert(msg)) {
							structural = true;
							next = applyUpdatedMessageById(next, msg);
							continue;
						}
						next = applyTopLevelMessage(next, msg, isAtBottomRef.current ?? false, onUnread);
					}
					return next;
				});
				if (structural) onStructuralDirty("full");
				if (isAtBottomRef.current) onTailFollow();
			},
			onFullReload: () => {
				streamingBlocksRef.current = [];
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
				scheduleChunkUpdate((state) => applyUpdatedMessageById(state, updatedMsg));
			},
			onSegmentCompactHide: () => {
				onStructuralDirty();
			},
			onCompactDone: () => {
				streamingBlocksRef.current = [];
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
				sideCars?: SideCarRecord[],
			) => {
				// On a subagent's own page, its tools are top-level (no parent here).
				const parentToolUseId = isSubagent ? undefined : rawParentToolUseId;
				const streamedOutput = toolOutputPreviewRef.current.get(toolUseId)?.preview;
				const completedOutput = preserveCompleteStreamedOutput(output, streamedOutput);

				// Discard any pending RAF chunk/output preview and accumulated raw input.
				pendingToolChunkRef.current.delete(toolUseId);
				toolStreamingFieldRef.current.delete(toolUseId);
				clearToolOutputPreviewState(toolUseId);

				// Promote the top-level streaming chunk to a completed card.
				if (!parentToolUseId) {
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
							_sideCars: sideCars,
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
						if (metadata) {
							result = mergeFieldsByIndex(result, toolUseId, { _metadata: metadata }, EMPTY_INDEX);
						}
						if (sideCars?.length) {
							result = mergeFieldsByIndex(result, toolUseId, { sideCars }, EMPTY_INDEX);
						}
						return result;
					}),
				);
			},
			onSideCars: (sideCars: SideCarRecord[], rawParentToolUseId?: string) => {
				const parentToolUseId = isSubagent ? undefined : rawParentToolUseId;
				const userSideCars = sideCars.filter((sc) => sc.target === "user_message");
				if (userSideCars.length === 0) return;
				scheduleChunkUpdate((state) => {
					for (const [chunkId, msgs] of state.loaded) {
						const result = appendSideCarsToLatestAssistant(msgs, userSideCars, parentToolUseId);
						if (result.changed) {
							const loaded = new Map(state.loaded);
							loaded.set(chunkId, result.messages);
							return { ...state, loaded };
						}
					}
					return state;
				});
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
			) => {
				const parentToolUseId = isSubagent ? undefined : rawParentToolUseId;
				pendingToolChunkRef.current.delete(toolUseId);

				if (!parentToolUseId) {
					const streamingEntry = topLevelStreamingChunkRef.current.get(toolUseId);
					if (streamingEntry) {
						topLevelStreamingChunkRef.current.set(toolUseId, {
							...streamingEntry,
							toolName,
							inputCharsTotal: -1, // sentinel: no longer streaming
							extractedFilePath: undefined,
							contentCharsReceived: undefined,
							_started: true,
							_input: input,
							_startedAt: streamStartedAt,
						});
						bumpTopLevelChunksVersion();
					}
				}

				scheduleChunkUpdate((state) => {
					const fields: Record<string, unknown> = {
						status: "running",
						startedAt: streamStartedAt ?? Date.now(),
					};
					if (parentToolUseId && input) fields.inputJson = input;
					if (input?.timeout != null && typeof input.timeout === "number") {
						fields._timeoutMs = input.timeout;
					}
					if (toolName === "Agent" && input?.model && typeof input.model === "string") {
						fields._resolvedModel = input.model;
					}
					return applyToChunkContaining(state, toolUseId, (w) =>
						mergeFieldsByIndex(w, toolUseId, fields, EMPTY_INDEX),
					);
				});
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
			) => {
				// On a subagent's own page, its tools are top-level (no parent here).
				const parentToolUseId = isSubagent ? undefined : rawParentToolUseId;
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
						const subagentChunks = chunks.filter((chunk) => !!chunk.parentToolUseId);
						if (subagentChunks.length > 0) {
							scheduleChunkUpdate((state) => {
								let next = state;
								for (const chunk of subagentChunks) {
									if (!chunk.parentToolUseId) continue;
									const ptu = chunk.parentToolUseId;
									const sf = toolStreamingFieldRef.current.get(chunk.toolUseId);
									next = applyToChunkContaining(next, ptu, (w) =>
										upsertSubagentStreamingChunk(
											w,
											ptu,
											narratorId,
											chunk.toolUseId,
											chunk.toolName,
											chunk.inputCharsTotal,
											undefined,
											chunk.extractedFilePath,
											chunk.contentCharsReceived,
											chunk.extractedFields,
											chunk.metadata,
											sf ? { name: sf.name, value: sf.value } : undefined,
										),
									);
								}
								return next;
							});
						}
						for (const chunk of chunks) {
							if (chunk.parentToolUseId) continue;
							if (!topLevelStreamingCreatedAtRef.current) {
								topLevelStreamingCreatedAtRef.current = new Date().toISOString();
							}
							const sf = toolStreamingFieldRef.current.get(chunk.toolUseId);
							topLevelStreamingChunkRef.current.set(chunk.toolUseId, {
								toolUseId: chunk.toolUseId,
								toolName: chunk.toolName,
								inputCharsTotal: chunk.inputCharsTotal,
								extractedFilePath: chunk.extractedFilePath,
								contentCharsReceived: chunk.contentCharsReceived,
								extractedFields: chunk.extractedFields,
								metadata: chunk.metadata,
								streamingFieldName: sf?.name,
								streamingFieldValue: sf?.value,
							});
							topLevelChanged = true;
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
			onSubagentStarted: (toolUseId: string, model?: string) => {
				if (!model) return;
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						mergeFieldsByIndex(w, toolUseId, { _resolvedModel: model }, EMPTY_INDEX),
					),
				);
			},
			onSubagentConclusionUpdated: (
				subagentNarratorId: string,
				toolUseId: string,
				output: unknown,
				hasError: boolean,
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
							{ outputJson: output, status: hasError ? "fail" : "success" },
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
						mergeFieldsByIndex(
							w,
							toolUseId,
							{
								status: "pending",
								permissionDecisionReason:
									typeof danger === "object" && danger && "summary" in danger
										? `Danger reflection: ${String((danger as { summary?: unknown }).summary ?? "")}`
										: "Danger reflection in progress",
								permissionSuggestions: [
									{ type: "danger_reflection", status: "running", danger, requestId },
								],
							},
							EMPTY_INDEX,
						),
					),
				);
			},
			onDangerReflectionStopped: ({ requestId, toolUseId, danger, inputJson, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						mergeFieldsByIndex(
							w,
							toolUseId,
							{
								status: "pending",
								...(inputJson ? { inputJson } : {}),
								permissionDecisionReason:
									reason ?? "Danger reflection stopped; awaiting user decision",
								permissionSuggestions: [
									{ type: "danger_reflection", status: "awaiting_user", danger, requestId, reason },
								],
							},
							EMPTY_INDEX,
						),
					),
				);
				qc.invalidateQueries({ queryKey: ["permissions", narratorId] });
			},
			onDangerReflectionResolved: ({ requestId, toolUseId, decision, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) => {
						const status = decision === "allow" ? "running" : "fail";
						return mergeFieldsByIndex(
							w,
							toolUseId,
							{
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
							},
							EMPTY_INDEX,
						);
					}),
				);
			},
			onPlanReflectionStarted: ({ requestId, toolUseId, inputJson, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						mergeFieldsByIndex(
							w,
							toolUseId,
							{
								status: "pending",
								...(inputJson ? { inputJson } : {}),
								permissionDecisionReason: reason ?? "Plan reflection in progress",
								permissionSuggestions: [
									{ type: "plan_reflection", status: "running", requestId, reason },
								],
							},
							EMPTY_INDEX,
						),
					),
				);
			},
			onPlanReflectionStopped: ({ requestId, toolUseId, inputJson, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						mergeFieldsByIndex(
							w,
							toolUseId,
							{
								status: "pending",
								...(inputJson ? { inputJson } : {}),
								permissionDecisionReason:
									reason ?? "Plan reflection stopped; awaiting user decision",
								permissionSuggestions: [
									{ type: "plan_reflection", status: "awaiting_user", requestId, reason },
								],
							},
							EMPTY_INDEX,
						),
					),
				);
				qc.invalidateQueries({ queryKey: ["permissions", narratorId] });
			},
			onPlanReflectionResolved: ({ requestId, toolUseId, decision, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) => {
						const status = decision === "allow" ? "running" : "fail";
						return mergeFieldsByIndex(
							w,
							toolUseId,
							{
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
							},
							EMPTY_INDEX,
						);
					}),
				);
			},
			onGoalReflectionStarted: ({ requestId, toolUseId, inputJson, activeGoal, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						mergeFieldsByIndex(
							w,
							toolUseId,
							{
								status: "pending",
								...(inputJson ? { inputJson } : {}),
								permissionDecisionReason: reason ?? "Goal completion reflection in progress",
								permissionSuggestions: [
									{ type: "goal_reflection", status: "running", requestId, reason, activeGoal },
								],
							},
							EMPTY_INDEX,
						),
					),
				);
			},
			onGoalReflectionResolved: ({ requestId, toolUseId, decision, reason, nextSteps }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) => {
						const status = decision === "allow" ? "running" : "fail";
						return mergeFieldsByIndex(
							w,
							toolUseId,
							{
								status,
								...(decision === "allow" ? { startedAt: Date.now() } : {}),
								...(decision !== "allow" ? { errorMessage: reason ?? null } : {}),
								permissionDecisionReason: reason ?? null,
								permissionSuggestions: [
									{
										type: "goal_reflection",
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
							},
							EMPTY_INDEX,
						);
					}),
				);
			},
			onQuestionReflectionStarted: ({ requestId, toolUseId, inputJson, reason }) => {
				scheduleChunkUpdate((state) =>
					applyToChunkContaining(state, toolUseId, (w) =>
						mergeFieldsByIndex(
							w,
							toolUseId,
							{
								status: "pending",
								...(inputJson ? { inputJson } : {}),
								permissionDecisionReason: reason ?? "Question reflection in progress",
								permissionSuggestions: [
									{ type: "question_reflection", status: "running", requestId, reason },
								],
							},
							EMPTY_INDEX,
						),
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
						return mergeFieldsByIndex(
							w,
							toolUseId,
							{
								status: decision === "allow" ? "running" : "pending",
								...(decision === "allow" ? { startedAt: Date.now() } : {}),
								permissionDecisionReason: reason ?? null,
								permissionSuggestions: [
									{ type: "question_reflection", status: reflectionStatus, requestId, reason },
								],
							},
							EMPTY_INDEX,
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
				for (const chunk of snapshot.toolChunks) {
					// On a subagent's own page, tool chunks are top-level (no parent here).
					const chunkParent = isSubagent ? undefined : chunk.parentToolUseId;
					if (chunkParent) {
						const ptu = chunkParent;
						scheduleChunkUpdate((state) =>
							applyToChunkContaining(state, ptu, (w) =>
								upsertSubagentStreamingChunk(
									w,
									ptu,
									narratorId,
									chunk.toolUseId,
									chunk.toolName,
									chunk.inputCharsTotal,
									undefined,
									chunk.extractedFilePath,
									chunk.contentCharsReceived,
									chunk.extractedFields,
									chunk.metadata,
								),
							),
						);
					} else if (chunk.started) {
						if (!topLevelStreamingCreatedAtRef.current) {
							topLevelStreamingCreatedAtRef.current = new Date().toISOString();
						}
						topLevelStreamingChunkRef.current.set(chunk.toolUseId, {
							toolUseId: chunk.toolUseId,
							toolName: chunk.toolName,
							inputCharsTotal: -1, // sentinel: no longer streaming
							_started: true,
							_input: chunk.input as Record<string, unknown> | undefined,
							_startedAt: chunk.streamStartedAt,
							_streamingOutput: chunk.streamingOutput,
							_metadata: chunk.metadata,
						});
						topLevelChanged = true;
					} else {
						if (!topLevelStreamingCreatedAtRef.current) {
							topLevelStreamingCreatedAtRef.current = new Date().toISOString();
						}
						topLevelStreamingChunkRef.current.set(chunk.toolUseId, {
							toolUseId: chunk.toolUseId,
							toolName: chunk.toolName,
							inputCharsTotal: chunk.inputCharsTotal,
							extractedFilePath: chunk.extractedFilePath,
							contentCharsReceived: chunk.contentCharsReceived,
							extractedFields: chunk.extractedFields,
							metadata: chunk.metadata,
						});
						topLevelChanged = true;
					}
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
		lastMessageId,
		{ kind: "messages" },
	);

	return useMemo(
		() => ({ streamingMsg, connected, disconnected, reconnect }),
		[streamingMsg, connected, disconnected, reconnect],
	);
}
