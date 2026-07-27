import type { CatchUpChildAnchor, CatchUpCursor } from "@shared/narrator-catch-up";
import { MAX_CATCH_UP_CHILD_ANCHORS } from "@shared/narrator-catch-up";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChunkManifestEntry, ChunkRangeResult, TreeMessage } from "../../lib/api";
import { api } from "../../lib/api";
import { type MessageReconcileToken, narratorWSManager } from "../../lib/narrator-ws-manager";
import { decodeManifestTuples, firstDirtyManifestIndex } from "./chunk-manifest-utils";
import {
	invalidateCachedChunkSnapshot,
	peekCachedChunkSnapshot,
	writeCachedChunkSnapshot,
} from "./narrator-chunks-cache";
import type { NarratorMsg } from "./narrator-panel-types";
import { STREAMING_CHUNKS_MSG_ID } from "./narrator-panel-types";
import { type ChunkMutState, type ChunkUpdater, useNarratorChunksWS } from "./useNarratorChunksWS";

/**
 * Data layer for the chunk-virtualized message list.
 *
 * The manifest is a tail-anchored window over the history: on open only the
 * newest chunks' coordinates (id + seq range + count) are loaded, and older
 * bands are fetched lazily as the user scrolls toward the top (reverse infinite
 * scroll). Chunk *content* is loaded sparsely on demand into `loaded` (a Map
 * keyed by chunk id) on top of whatever manifest window is currently loaded.
 *
 * Phase 1 makes this layer the single source of truth for messages: it owns the
 * WebSocket subscription (via `useNarratorChunksWS`) and applies new messages /
 * streaming output directly to the chunk Map, never touching the TanStack Query
 * cache. The tail chunk is kept permanently resident as the landing spot for
 * new messages and streaming text.
 *
 * Alignment: a chunk's id is its first message id and `firstSeq`/`lastSeq`
 * bound its seq range. getNarratorChunks returns a flat seq-ascending message
 * list which we regroup into chunks by matching each message's seq against the
 * manifest ranges — the manifest and the content query use identical filters
 * (top-level only, no segment-compacted refs, subagent-aware), so seqs align.
 */

export interface ChunkData extends ChunkManifestEntry {
	/** Loaded top-level messages for this chunk, or undefined if not yet loaded. */
	messages?: TreeMessage[];
}

export interface NarratorChunksState {
	/** Narrator whose authoritative snapshot established this state. */
	ownerNarratorId: string | null;
	manifest: ChunkManifestEntry[];
	total: number;
	messageVersion: number;
	pruneBoundaryMessageId: string | null;
	prunedPercent: number | null;
	/** True when older chunks exist beyond the loaded manifest window (reverse
	 * infinite scroll: more manifest can be fetched toward the top). */
	hasOlderChunks: boolean;
	/** chunkId -> loaded messages. Sparse: only fetched chunks are present. */
	loaded: Map<string, TreeMessage[]>;
}

export interface UseNarratorChunksOptions {
	/** Called when a new tail message / catch-up lands while pinned to the bottom. */
	onTailFollow?: () => void;
	/** True when rendering a subagent's OWN page — realtime events must be routed
	 * as top-level (their parentToolUseId points at the parent narrator). */
	isSubagent?: boolean;
}

const INITIAL_RADIUS = 3; // center ±3 chunks
const INITIAL_BAND_CHUNKS = INITIAL_RADIUS * 2 + 1;
const INITIAL_CONTENT_CHUNKS = 1;
const INITIAL_LOAD_MAX_ATTEMPTS = 3;
/** Newest chunks whose manifest is loaded on open. The rest of the history's
 * manifest is fetched lazily as the user scrolls toward the top (reverse
 * infinite scroll), so opening a huge narrator no longer ships ~1.5k tuples. */
const INITIAL_MANIFEST_CHUNKS = 10;
/** Chunks of manifest fetched per upward expansion step. */
const OLDER_MANIFEST_BATCH_CHUNKS = 10;
const CHUNK_UPDATE_FALLBACK_MS = 250;
/** Server clamps /narrators/:id/chunks `count` to at most 20 chunks. */
const MAX_CHUNKS_PER_RANGE_REQUEST = 20;
/** Delay before evicting loaded chunk data after it leaves the retained range. */
const CHUNK_EVICT_DELAY_MS = 30_000;
const RECONCILE_MAX_RETRIES = 3;
const RECONCILE_RETRY_BASE_MS = 100;
const RECONCILE_RETRY_MAX_MS = 1_000;
export const MAX_REALTIME_UPDATER_LOG = 256;

/** A realtime updater with a monotonic sequence assigned at enqueue time. */
export interface SequencedChunkUpdater {
	seq: number;
	updater: ChunkUpdater;
}

export interface ChunkUpdaterReplay {
	updaters: ChunkUpdater[];
	/** Highest sequence represented by this replay window (or the checkpoint). */
	lastSeq: number;
	/** True when the bounded log no longer contains every required sequence. */
	overflowed: boolean;
}

/**
 * Select only the updater suffix that arrived after a reconcile checkpoint.
 * Sequence gaps are explicit overflow: callers must abandon incremental replay
 * and fetch an authoritative full snapshot rather than silently dropping events.
 */
export function selectChunkUpdaterReplay(
	log: readonly SequencedChunkUpdater[],
	checkpoint: number,
	throughSeq = Math.max(checkpoint, log[log.length - 1]?.seq ?? checkpoint),
): ChunkUpdaterReplay {
	let expected = checkpoint + 1;
	let overflowed = false;
	const updaters: ChunkUpdater[] = [];
	for (const entry of log) {
		if (entry.seq <= checkpoint) continue;
		if (entry.seq > throughSeq) break;
		if (entry.seq !== expected) overflowed = true;
		expected = entry.seq + 1;
		updaters.push(entry.updater);
	}
	if (expected <= throughSeq) overflowed = true;
	return {
		updaters,
		lastSeq: Math.max(checkpoint, throughSeq),
		overflowed,
	};
}

class ChunkUpdaterReplayOverflowError extends Error {
	constructor() {
		super("Realtime chunk updater log overflowed during reconcile");
		this.name = "ChunkUpdaterReplayOverflowError";
	}
}

type ReconcileMode = "diff" | "full";

export function getStructuralReconcileRetryDelay(failedAttempts: number): number | null {
	if (failedAttempts <= 0 || failedAttempts > RECONCILE_MAX_RETRIES) return null;
	return Math.min(RECONCILE_RETRY_BASE_MS * 2 ** (failedAttempts - 1), RECONCILE_RETRY_MAX_MS);
}

type ChunkRangeMeta = Pick<ChunkRangeResult, "pruneBoundaryMessageId" | "prunedPercent">;
type ChunkIndexRange = { start: number; end: number };

interface MergeLoadedOptions {
	/** Keep already-complete chunk message arrays by reference during lazy loads. */
	preserveCompleteExisting?: boolean;
}

interface FlushChunkUpdatesOptions {
	/** Reconcile barriers use an urgent commit so an older snapshot cannot overwrite it. */
	urgent?: boolean;
}

interface ManifestExtensionAuthority {
	generation: number;
	stateVersion: number;
	managerVersion: number | undefined;
	structuralEpoch: number;
	realtimeEpoch: number;
	updaterSeq: number;
}

interface ManifestExtensionPatch {
	manifest: ChunkManifestEntry[];
	incoming: Map<string, TreeMessage[]>;
	hasOlderChunks: boolean;
	meta: ChunkRangeMeta | null;
}

interface ManifestExtensionCommitResult {
	committed: boolean;
	addedChunks: number;
	manifest: ChunkManifestEntry[];
}

function manifestEntryMatches(a: ChunkManifestEntry, b: ChunkManifestEntry): boolean {
	return (
		a.id === b.id && a.firstSeq === b.firstSeq && a.lastSeq === b.lastSeq && a.count === b.count
	);
}

/**
 * Union an older manifest response into the latest committed window. Entries
 * already present in `latest` always win so a delayed response cannot roll back
 * a tail tuple that a newer transaction already published. Any contradictory
 * overlap is rejected rather than guessing across coordinate systems.
 */
function mergeManifestExtensionWindows(
	latest: readonly ChunkManifestEntry[],
	incoming: readonly ChunkManifestEntry[],
): ChunkManifestEntry[] | null {
	const merged = [...latest];
	for (const entry of incoming) {
		const sameId = merged.find((current) => current.id === entry.id);
		if (sameId) {
			if (!manifestEntryMatches(sameId, entry)) return null;
			continue;
		}
		const overlap = merged.find(
			(current) => entry.firstSeq <= current.lastSeq && entry.lastSeq >= current.firstSeq,
		);
		if (overlap) return null;
		merged.push(entry);
	}
	merged.sort((a, b) => a.firstSeq - b.firstSeq);
	return merged;
}

function manifestCoversSeq(manifest: readonly ChunkManifestEntry[], seq: number): boolean {
	return (
		manifest.length > 0 &&
		seq >= manifest[0].firstSeq &&
		seq <= manifest[manifest.length - 1].lastSeq
	);
}

function getChunkRangeMeta(range: ChunkRangeMeta): ChunkRangeMeta {
	return {
		pruneBoundaryMessageId: range.pruneBoundaryMessageId ?? null,
		prunedPercent: range.prunedPercent ?? null,
	};
}

/** Apply a captured realtime updater batch to a structural snapshot. */
export function applyChunkUpdaters(
	state: ChunkMutState,
	updaters: readonly ChunkUpdater[],
): ChunkMutState {
	let next = state;
	for (const updater of updaters) next = updater(next);
	return next;
}

export function chunkRangeVersionMatchesManifest(
	manifestVersion: number,
	rangeVersion: number,
): boolean {
	return manifestVersion === rangeVersion;
}

/** Build the canonical parent/child catch-up cursor represented by a loaded tail chunk. */
export function catchUpCursorFromLoadedTail(
	tailMessages: readonly TreeMessage[] | undefined,
): CatchUpCursor | undefined {
	if (!tailMessages?.length) return undefined;
	let parentLastMessageId: string | undefined;
	const childAnchors = new Map<string, CatchUpChildAnchor>();
	const upsertChildAnchor = (anchor: CatchUpChildAnchor) => {
		if (!anchor.parentToolUseId) return;
		const previous = childAnchors.get(anchor.parentToolUseId);
		childAnchors.delete(anchor.parentToolUseId);
		childAnchors.set(anchor.parentToolUseId, {
			parentToolUseId: anchor.parentToolUseId,
			narratorId: anchor.narratorId ?? previous?.narratorId,
			lastMessageId: anchor.lastMessageId ?? previous?.lastMessageId,
		});
	};
	const visit = (message: TreeMessage, topLevel: boolean) => {
		const persistedId =
			message.id && message.id !== STREAMING_CHUNKS_MSG_ID ? message.id : undefined;
		if (topLevel && persistedId) parentLastMessageId = persistedId;
		for (const toolCall of message.toolCalls ?? []) {
			if (toolCall.toolUseId) upsertChildAnchor({ parentToolUseId: toolCall.toolUseId });
		}
		if (!topLevel && message.parentToolUseId && persistedId) {
			upsertChildAnchor({
				parentToolUseId: message.parentToolUseId,
				narratorId: message.narratorId,
				lastMessageId: persistedId,
			});
		}
		for (const child of message.children ?? []) visit(child, false);
	};
	for (const message of tailMessages) visit(message, true);
	const anchors = [...childAnchors.values()].slice(-MAX_CATCH_UP_CHILD_ANCHORS);
	if (!parentLastMessageId && anchors.length === 0) return undefined;
	return {
		...(parentLastMessageId ? { parentLastMessageId } : {}),
		...(anchors.length > 0 ? { childAnchors: anchors } : {}),
	};
}

export function useNarratorChunks(narratorId: string, options?: UseNarratorChunksOptions) {
	// Restore the snapshot this narrator left behind on a previous MOUNT, so a
	// remount (desktop/mobile breakpoint switch, dockview panel move, route
	// back/forward) shows its history immediately instead of clearing the list and
	// refetching. `peek` is non-destructive, so StrictMode's double render is safe.
	// An in-place narratorId CHANGE deliberately keeps the existing behaviour: it
	// still clears and runs the full initial load.
	const restoredSnapshotRef = useRef<ReturnType<typeof peekCachedChunkSnapshot> | undefined>(
		undefined,
	);
	if (restoredSnapshotRef.current === undefined) {
		restoredSnapshotRef.current = narratorId ? peekCachedChunkSnapshot(narratorId) : null;
	}
	const restoredSnapshot = restoredSnapshotRef.current;
	/** The narrator the restored snapshot belongs to (null when nothing was restored). */
	const restoreNarratorIdRef = useRef<string | null>(restoredSnapshot?.narratorId ?? null);
	/** True until a full initial load supersedes the restored snapshot. */
	const restoreEligibleRef = useRef(restoredSnapshot != null);
	/** Set when a restored mount still owes a `diff` reconcile to verify its snapshot. */
	const pendingRestoreVerifyRef = useRef(false);
	/** Set when the local snapshot could not be validated, so it must not be cached. */
	const snapshotUntrustedRef = useRef(false);
	const [state, setState] = useState<NarratorChunksState>(() =>
		restoredSnapshot
			? {
					ownerNarratorId: restoredSnapshot.narratorId,
					manifest: restoredSnapshot.manifest,
					total: restoredSnapshot.total,
					messageVersion: restoredSnapshot.messageVersion,
					pruneBoundaryMessageId: restoredSnapshot.pruneBoundaryMessageId,
					prunedPercent: restoredSnapshot.prunedPercent,
					hasOlderChunks: restoredSnapshot.hasOlderChunks,
					loaded: restoredSnapshot.loaded,
				}
			: {
					ownerNarratorId: null,
					manifest: [],
					total: 0,
					messageVersion: 0,
					pruneBoundaryMessageId: null,
					prunedPercent: null,
					hasOlderChunks: false,
					loaded: new Map(),
				},
	);
	const [loading, setLoading] = useState(restoredSnapshot == null);
	// In-flight chunk loads, keyed by chunk id. The promise lets jump/selection
	// callers wait for an existing range request instead of racing React commits.
	const inFlightRef = useRef<Map<string, Promise<void>>>(new Map());
	// Bumped whenever the manifest coordinate system is rebuilt; stale range
	// requests from an older generation are ignored on arrival.
	const loadGenerationRef = useRef(0);
	// Keep one synchronous snapshot ahead of React's concurrent rendering. Chunk
	// updaters are materialized exactly once against this snapshot before their
	// state value is scheduled, so a transition cannot replay a non-idempotent
	// updater after a structural snapshot has already committed.
	const stateRef = useRef(state);
	const manifestRef = useRef<ChunkManifestEntry[]>(state.manifest);
	const loadedRef = useRef<Map<string, TreeMessage[]>>(state.loaded);
	const messageVersionRef = useRef(state.messageVersion);
	const hasOlderChunksRef = useRef(state.hasOlderChunks);
	const totalRef = useRef(state.total);
	const syncStateRefs = useCallback((next: NarratorChunksState) => {
		stateRef.current = next;
		manifestRef.current = next.manifest;
		loadedRef.current = next.loaded;
		messageVersionRef.current = next.messageVersion;
		hasOlderChunksRef.current = next.hasOlderChunks;
		totalRef.current = next.total;
	}, []);
	const commitState = useCallback(
		(
			update: NarratorChunksState | ((previous: NarratorChunksState) => NarratorChunksState),
			options?: FlushChunkUpdatesOptions,
		): NarratorChunksState => {
			const previous = stateRef.current;
			const next = typeof update === "function" ? update(previous) : update;
			if (next === previous) return previous;
			syncStateRefs(next);
			const commit = () => setState(next);
			if (options?.urgent) commit();
			else startTransition(commit);
			return next;
		},
		[syncStateRefs],
	);
	// Synchronous read of the optimistic live manifest window. Every local state
	// commit updates this ref before React renders, so concurrent lazy extensions
	// can merge against the newest window instead of a captured working copy.
	const getManifestSnapshot = useCallback(() => manifestRef.current, []);
	/** Shared in-flight registry for every older-manifest expansion entry point. */
	const manifestExtensionInFlightRef = useRef<{
		older: Promise<number> | null;
		jumps: Map<number, Promise<boolean>>;
	}>({ older: null, jumps: new Map() });
	/** Serialize only extension commits; network requests may still resolve out of order. */
	const manifestExtensionCommitQueueRef = useRef<Promise<void>>(Promise.resolve());
	/** Lazy range loaders can request a full reconcile without a declaration cycle. */
	const structuralReconcileRequestRef = useRef<(mode?: ReconcileMode) => void>(() => {});

	const onTailFollowRef = useRef(options?.onTailFollow);
	onTailFollowRef.current = options?.onTailFollow;

	// --- Delayed data eviction for far-away loaded chunks ---
	const evictionTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
	const retainedChunkIdsRef = useRef<Set<string>>(new Set());
	const cancelEviction = useCallback((chunkId: string) => {
		const timer = evictionTimersRef.current.get(chunkId);
		if (!timer) return;
		clearTimeout(timer);
		evictionTimersRef.current.delete(chunkId);
	}, []);
	const cancelAllEvictions = useCallback(() => {
		for (const timer of evictionTimersRef.current.values()) clearTimeout(timer);
		evictionTimersRef.current.clear();
	}, []);

	// --- Bottom tracking + unread (set by the list, read by the WS layer) ---
	const isAtBottomRef = useRef(true);
	const [unreadCount, setUnreadCount] = useState(0);
	const setIsAtBottom = useCallback((atBottom: boolean) => {
		isAtBottomRef.current = atBottom;
		if (atBottom) setUnreadCount(0);
	}, []);
	const resetUnread = useCallback(() => setUnreadCount(0), []);
	// Reset transient view state when switching narrators.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on narratorId change
	useEffect(() => {
		isAtBottomRef.current = true;
		setUnreadCount(0);
		retainedChunkIdsRef.current = new Set();
		cancelAllEvictions();
	}, [narratorId, cancelAllEvictions]);
	useEffect(() => () => cancelAllEvictions(), [cancelAllEvictions]);

	/**
	 * Regroup a flat seq-ascending message list into chunks by matching each
	 * message's seq against the manifest ranges. Returns a map of chunkId ->
	 * messages for every chunk that received at least one message.
	 */
	const regroup = useCallback(
		(
			messages: TreeMessage[],
			manifestOverride?: ChunkManifestEntry[],
		): Map<string, TreeMessage[]> => {
			const manifest = manifestOverride ?? manifestRef.current;
			const byChunk = new Map<string, TreeMessage[]>();
			if (manifest.length === 0) return byChunk;
			// Two-pointer walk: manifest is seq-ascending, messages are too.
			let mi = 0;
			for (const msg of messages) {
				const seq = msg.seq ?? -1;
				// Advance manifest pointer until msg falls within [firstSeq, lastSeq].
				while (mi < manifest.length && seq > manifest[mi].lastSeq) mi++;
				if (mi >= manifest.length) break;
				const chunk = manifest[mi];
				if (seq < chunk.firstSeq) continue; // gap (shouldn't happen with aligned filters)
				let arr = byChunk.get(chunk.id);
				if (!arr) {
					arr = [];
					byChunk.set(chunk.id, arr);
				}
				arr.push(msg);
			}
			return byChunk;
		},
		[],
	);

	const isChunkComplete = useCallback(
		(loaded: Map<string, TreeMessage[]>, chunk: ChunkManifestEntry) =>
			(loaded.get(chunk.id)?.length ?? 0) >= chunk.count,
		[],
	);

	const mergeLoaded = useCallback(
		(
			incoming: Map<string, TreeMessage[]>,
			meta?: ChunkRangeMeta | null,
			options?: MergeLoadedOptions,
		) => {
			if (incoming.size === 0 && !meta) return;
			for (const chunkId of incoming.keys()) cancelEviction(chunkId);
			commitState(
				(prev) => {
					let loaded = prev.loaded;
					const preserveCompleteExisting = options?.preserveCompleteExisting === true;
					const manifestById = preserveCompleteExisting
						? new Map(manifestRef.current.map((chunk) => [chunk.id, chunk]))
						: null;

					for (const [chunkId, msgs] of incoming) {
						const chunk = manifestById?.get(chunkId);
						if (chunk && isChunkComplete(prev.loaded, chunk)) continue;
						if (loaded === prev.loaded) loaded = new Map(prev.loaded);
						loaded.set(chunkId, msgs);
					}

					const metaPatch = meta ? getChunkRangeMeta(meta) : null;
					const metaUnchanged =
						!metaPatch ||
						(prev.pruneBoundaryMessageId === metaPatch.pruneBoundaryMessageId &&
							prev.prunedPercent === metaPatch.prunedPercent);
					if (loaded === prev.loaded && metaUnchanged) return prev;
					return { ...prev, ...(metaPatch ?? {}), loaded };
				},
				{ urgent: true },
			);
		},
		[cancelEviction, isChunkComplete, commitState],
	);

	const loadManifestBands = useCallback(
		async (
			manifestChunks: ChunkManifestEntry[],
			ranges: ChunkIndexRange[],
			generation: number,
			expectedMessageVersion?: number,
		): Promise<{ incoming: Map<string, TreeMessage[]>; meta: ChunkRangeMeta | null } | null> => {
			const incoming = new Map<string, TreeMessage[]>();
			let meta: ChunkRangeMeta | null = null;
			if (manifestChunks.length === 0 || ranges.length === 0) return { incoming, meta };

			const merged = [...ranges]
				.filter((r) => r.start <= r.end)
				.sort((a, b) => a.start - b.start)
				.reduce<ChunkIndexRange[]>((acc, range) => {
					const last = acc[acc.length - 1];
					if (last && range.start <= last.end + 1) {
						last.end = Math.max(last.end, range.end);
					} else {
						acc.push({ ...range });
					}
					return acc;
				}, []);

			for (const rangeIdx of merged) {
				for (
					let subStart = rangeIdx.start;
					subStart <= rangeIdx.end;
					subStart += MAX_CHUNKS_PER_RANGE_REQUEST
				) {
					const subEnd = Math.min(rangeIdx.end, subStart + MAX_CHUNKS_PER_RANGE_REQUEST - 1);
					const firstSeq = manifestChunks[subStart]?.firstSeq;
					if (firstSeq == null) continue;
					const range = await api.getNarratorChunks(narratorId, {
						direction: "newer",
						fromSeq: firstSeq - 1,
						count: subEnd - subStart + 1,
					});
					if (generation !== loadGenerationRef.current) return null;
					if (
						expectedMessageVersion != null &&
						!chunkRangeVersionMatchesManifest(expectedMessageVersion, range.messageVersion)
					) {
						throw new Error(
							`Chunk range version ${range.messageVersion} did not match manifest ${expectedMessageVersion}`,
						);
					}
					meta = getChunkRangeMeta(range);
					for (const [chunkId, messages] of regroup(range.messages, manifestChunks)) {
						incoming.set(chunkId, messages);
					}
				}
			}
			return { incoming, meta };
		},
		[narratorId, regroup],
	);

	// --- rAF-batched chunk-map updater (chunk-mode scheduleCacheUpdate) ---
	// WS events queue pure updaters that fold `{ loaded, manifest, total }` →
	// new state; they flush in a single setState per animation frame (with a
	// timeout fallback when the tab is hidden), collapsing N WS events into one
	// React commit. This NEVER writes the TanStack Query cache.
	const pendingUpdatersRef = useRef<SequencedChunkUpdater[]>([]);
	/** Bounded replay log: structural snapshots must not erase already-flushed live updates. */
	const realtimeUpdaterLogRef = useRef<SequencedChunkUpdater[]>([]);
	const nextUpdaterSeqRef = useRef(0);
	/** Highest updater sequence already represented by the live React state. */
	const appliedUpdaterSeqRef = useRef(0);
	/** Sequence checkpoint captured at reconcile request start, before queued updates flush. */
	const reconcileUpdaterCheckpointRef = useRef<number | null>(null);
	/** Set only when a required updater has fallen out of the bounded replay log. */
	const realtimeUpdaterLogOverflowedRef = useRef(false);
	const updateRafRef = useRef(0);
	const updateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const flushChunkUpdatesSync = useCallback(
		(options?: FlushChunkUpdatesOptions) => {
			if (updateRafRef.current) {
				cancelAnimationFrame(updateRafRef.current);
				updateRafRef.current = 0;
			}
			if (updateTimeoutRef.current) {
				clearTimeout(updateTimeoutRef.current);
				updateTimeoutRef.current = null;
			}
			const entries = pendingUpdatersRef.current;
			if (entries.length === 0) return;
			pendingUpdatersRef.current = [];
			const lastEntrySeq = entries[entries.length - 1]?.seq ?? appliedUpdaterSeqRef.current;
			const updaters = entries.map((entry) => entry.updater);
			// Materialize opaque updaters once, outside React's functional update queue.
			// Concurrent rendering may restart a transition, but it can only replay the
			// resulting value — never Date.now()/counter-bearing updater functions.
			commitState((prev) => {
				const acc = applyChunkUpdaters(
					{
						loaded: prev.loaded,
						manifest: prev.manifest,
						total: prev.total,
					},
					updaters,
				);
				if (
					acc.loaded === prev.loaded &&
					acc.manifest === prev.manifest &&
					acc.total === prev.total
				) {
					return prev;
				}
				return {
					...prev,
					loaded: acc.loaded,
					manifest: acc.manifest,
					total: acc.total,
				};
			}, options);
			appliedUpdaterSeqRef.current = Math.max(appliedUpdaterSeqRef.current, lastEntrySeq);
		},
		[commitState],
	);
	const scheduleChunkUpdate = useCallback(
		(updater: ChunkUpdater) => {
			const entry: SequencedChunkUpdater = {
				seq: ++nextUpdaterSeqRef.current,
				updater,
			};
			pendingUpdatersRef.current.push(entry);
			realtimeUpdaterLogRef.current.push(entry);
			if (realtimeUpdaterLogRef.current.length > MAX_REALTIME_UPDATER_LOG) {
				const dropped = realtimeUpdaterLogRef.current.shift();
				const checkpoint = reconcileUpdaterCheckpointRef.current;
				if (dropped && checkpoint != null && dropped.seq > checkpoint) {
					realtimeUpdaterLogOverflowedRef.current = true;
					// The incremental window can no longer be replayed safely. Queue an
					// authoritative full reconcile immediately; do not silently continue.
					structuralReconcileRequestRef.current("full");
				}
			}
			const visible = typeof document === "undefined" || document.visibilityState === "visible";
			if (visible && !updateRafRef.current) {
				updateRafRef.current = requestAnimationFrame(() => {
					updateRafRef.current = 0;
					flushChunkUpdatesSync();
				});
			}
			if (!updateTimeoutRef.current) {
				updateTimeoutRef.current = setTimeout(() => {
					updateTimeoutRef.current = null;
					flushChunkUpdatesSync();
				}, CHUNK_UPDATE_FALLBACK_MS);
			}
		},
		[flushChunkUpdatesSync],
	);
	const pruneRealtimeUpdaterLog = useCallback((throughSeq: number) => {
		realtimeUpdaterLogRef.current = realtimeUpdaterLogRef.current.filter(
			(entry) => entry.seq > throughSeq,
		);
	}, []);
	const commitReplayedUpdaterCheckpoint = useCallback(
		(replayedThroughSeq: number) => {
			// The replacement state and this checkpoint are published in the same
			// synchronous commit turn. A later reconcile must start after the replayed
			// suffix, especially once that suffix has been pruned from the bounded log.
			appliedUpdaterSeqRef.current = Math.max(appliedUpdaterSeqRef.current, replayedThroughSeq);
			pruneRealtimeUpdaterLog(replayedThroughSeq);
		},
		[pruneRealtimeUpdaterLog],
	);
	useEffect(() => {
		return () => {
			if (updateRafRef.current) cancelAnimationFrame(updateRafRef.current);
			if (updateTimeoutRef.current) clearTimeout(updateTimeoutRef.current);
		};
	}, []);

	// Initial load: newest manifest window + newest tail chunk; older manifest is
	// fetched lazily as the user scrolls up (see loadOlderManifest).
	useEffect(() => {
		let cancelled = false;
		// A restored mount already holds a committed snapshot, so it skips the REST
		// initial load entirely and instead schedules a cheap `diff` reconcile to
		// confirm the snapshot is still current (see the verification effect below).
		// The reconcile gate is opened here, BEFORE the WS subscription effect runs,
		// so catch-up coordinates stay staged until that diff commits.
		//
		// This runs on EVERY execution of this effect while eligible (not guarded by a
		// "handled once" flag) because StrictMode's simulated remount clears the gate
		// in the reconcile-lifecycle cleanup; the second mount must re-open it or the
		// restored snapshot would never be verified.
		if (restoreEligibleRef.current && narratorId === restoreNarratorIdRef.current) {
			narratorWSManager.markMessageReconcilePending(narratorId, { restart: true });
			pendingRestoreVerifyRef.current = true;
			return;
		}
		// Any full load — including an in-place narrator switch — permanently retires
		// the restore, so switching back to the original narrator can never re-apply a
		// snapshot that no longer matches the live state.
		restoreEligibleRef.current = false;
		snapshotUntrustedRef.current = false;
		const generation = loadGenerationRef.current + 1;
		loadGenerationRef.current = generation;
		setLoading(true);
		commitState(
			{
				ownerNarratorId: null,
				manifest: [],
				total: 0,
				messageVersion: 0,
				pruneBoundaryMessageId: null,
				prunedPercent: null,
				hasOlderChunks: false,
				loaded: new Map(),
			},
			{ urgent: true },
		);
		inFlightRef.current.clear();
		manifestExtensionInFlightRef.current = { older: null, jumps: new Map() };
		pendingUpdatersRef.current = [];
		realtimeUpdaterLogRef.current = [];
		const initialUpdaterCheckpoint = nextUpdaterSeqRef.current;
		appliedUpdaterSeqRef.current = initialUpdaterCheckpoint;
		reconcileUpdaterCheckpointRef.current = initialUpdaterCheckpoint;
		realtimeUpdaterLogOverflowedRef.current = false;
		// Treat the initial REST snapshot as the first reconcile transaction. Catch-up
		// anchors/version updates stay staged until manifest + range commit together.
		narratorWSManager.markMessageReconcilePending(narratorId, { restart: true });
		(async () => {
			for (let attempt = 0; attempt < INITIAL_LOAD_MAX_ATTEMPTS; attempt++) {
				const reconcileToken = narratorWSManager.getMessageReconcileToken(narratorId);
				const [manifest, range] = await Promise.all([
					api.getChunkManifest(narratorId, undefined, {
						limitChunks: INITIAL_MANIFEST_CHUNKS,
					}),
					api.getNarratorChunks(narratorId, {
						direction: "older",
						count: INITIAL_CONTENT_CHUNKS,
					}),
				]);
				if (cancelled || generation !== loadGenerationRef.current) return;
				if (!narratorWSManager.isMessageReconcileTokenCurrent(narratorId, reconcileToken)) {
					if (attempt < INITIAL_LOAD_MAX_ATTEMPTS - 1) continue;
					throw new Error("Chunk initial snapshot crossed a structural event");
				}
				if (manifest.messageVersion !== range.messageVersion) {
					if (attempt < INITIAL_LOAD_MAX_ATTEMPTS - 1) {
						await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
						continue;
					}
					throw new Error("Chunk manifest and range versions did not converge");
				}

				// Drain live updates, then replay only the suffix that arrived after the
				// initial snapshot request began. A missing suffix is an explicit overflow.
				flushChunkUpdatesSync({ urgent: true });
				const replay = selectChunkUpdaterReplay(
					realtimeUpdaterLogRef.current,
					initialUpdaterCheckpoint,
					nextUpdaterSeqRef.current,
				);
				if (realtimeUpdaterLogOverflowedRef.current || replay.overflowed) {
					throw new ChunkUpdaterReplayOverflowError();
				}
				if (
					!narratorWSManager.canCommitMessageReconcile(
						narratorId,
						range.messageVersion,
						reconcileToken,
					)
				) {
					if (attempt < INITIAL_LOAD_MAX_ATTEMPTS - 1) continue;
					throw new Error("Chunk initial snapshot commit was invalidated");
				}

				const manifestChunks = manifest.unchanged ? [] : decodeManifestTuples(manifest.chunks);
				const loaded = regroup(range.messages, manifestChunks);
				const replayed = applyChunkUpdaters(
					{
						manifest: manifestChunks,
						total: manifest.unchanged ? 0 : manifest.total,
						loaded,
					},
					replay.updaters,
				);
				const tailChunk = replayed.manifest[replayed.manifest.length - 1];
				const fallbackCursor = catchUpCursorFromLoadedTail(
					tailChunk ? replayed.loaded.get(tailChunk.id) : undefined,
				);
				const committed = narratorWSManager.commitMessageReconcile(
					narratorId,
					range.messageVersion,
					reconcileToken,
					fallbackCursor,
				);
				if (!committed) {
					if (attempt < INITIAL_LOAD_MAX_ATTEMPTS - 1) continue;
					throw new Error("Chunk initial snapshot commit was invalidated");
				}
				const meta = getChunkRangeMeta(range);
				commitState(
					{
						...replayed,
						ownerNarratorId: narratorId,
						messageVersion: range.messageVersion,
						pruneBoundaryMessageId: meta.pruneBoundaryMessageId ?? null,
						prunedPercent: meta.prunedPercent ?? null,
						hasOlderChunks: manifest.unchanged ? false : manifest.hasOlderChunks,
					},
					{ urgent: true },
				);
				commitReplayedUpdaterCheckpoint(replay.lastSeq);
				reconcileUpdaterCheckpointRef.current = null;
				realtimeUpdaterLogOverflowedRef.current = false;
				setLoading(false);
				return;
			}
		})().catch(() => {
			if (cancelled) return;
			// Never leave an exhausted initial load as a terminal empty state. Reuse the
			// structural reconcile path, which atomically replaces the snapshot and keeps
			// the WS catch-up gate recoverable if its own bounded retries also fail.
			structuralReconcileRequestRef.current("full");
			setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [narratorId, regroup, flushChunkUpdatesSync, commitState, commitReplayedUpdaterCheckpoint]);

	const captureManifestExtensionAuthority = useCallback((): ManifestExtensionAuthority | null => {
		if (narratorWSManager.isMessageReconcilePending(narratorId)) return null;
		flushChunkUpdatesSync({ urgent: true });
		const stateVersion = messageVersionRef.current;
		const managerVersion = narratorWSManager.getMessageVersion(narratorId);
		if (stateVersion <= 0 || (managerVersion != null && managerVersion !== stateVersion)) {
			structuralReconcileRequestRef.current("full");
			return null;
		}
		return {
			generation: loadGenerationRef.current,
			stateVersion,
			managerVersion,
			structuralEpoch: narratorWSManager.getStructuralEpoch(narratorId),
			realtimeEpoch: narratorWSManager.getRealtimeEpoch(narratorId),
			updaterSeq: nextUpdaterSeqRef.current,
		};
	}, [flushChunkUpdatesSync, narratorId]);

	const isManifestExtensionAuthorityCurrent = useCallback(
		(authority: ManifestExtensionAuthority, responseVersion?: number): boolean => {
			const expectedVersion = authority.managerVersion ?? authority.stateVersion;
			return (
				authority.generation === loadGenerationRef.current &&
				messageVersionRef.current === authority.stateVersion &&
				narratorWSManager.getMessageVersion(narratorId) === authority.managerVersion &&
				narratorWSManager.getStructuralEpoch(narratorId) === authority.structuralEpoch &&
				narratorWSManager.getRealtimeEpoch(narratorId) === authority.realtimeEpoch &&
				nextUpdaterSeqRef.current === authority.updaterSeq &&
				!narratorWSManager.isMessageReconcilePending(narratorId) &&
				(responseVersion == null || responseVersion === expectedVersion)
			);
		},
		[narratorId],
	);

	const requestManifestExtensionRecovery = useCallback(
		(authority: ManifestExtensionAuthority, responseVersion?: number) => {
			// A narrator switch or an already-running reconcile owns the recovery path;
			// a stale lazy request must not trigger a full reload in the new lifecycle.
			if (
				authority.generation !== loadGenerationRef.current ||
				narratorWSManager.isMessageReconcilePending(narratorId)
			)
				return;
			const managerChanged =
				narratorWSManager.getMessageVersion(narratorId) !== authority.managerVersion;
			const coordinatesChanged =
				messageVersionRef.current !== authority.stateVersion ||
				narratorWSManager.getStructuralEpoch(narratorId) !== authority.structuralEpoch;
			const expectedVersion = authority.managerVersion ?? authority.stateVersion;
			if (
				managerChanged ||
				coordinatesChanged ||
				(responseVersion != null && responseVersion !== expectedVersion)
			) {
				structuralReconcileRequestRef.current("full");
			}
		},
		[narratorId],
	);

	const withManifestExtensionCommitLock = useCallback(
		async <T>(commit: () => T | Promise<T>): Promise<T> => {
			const previous = manifestExtensionCommitQueueRef.current;
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			manifestExtensionCommitQueueRef.current = previous.then(
				() => gate,
				() => gate,
			);
			await previous.catch(() => {});
			try {
				return await commit();
			} finally {
				release();
			}
		},
		[],
	);

	const commitManifestExtension = useCallback(
		(
			authority: ManifestExtensionAuthority,
			responseVersion: number,
			patch: ManifestExtensionPatch,
		): Promise<ManifestExtensionCommitResult> =>
			withManifestExtensionCommitLock(() => {
				flushChunkUpdatesSync({ urgent: true });
				if (!isManifestExtensionAuthorityCurrent(authority, responseVersion)) {
					requestManifestExtensionRecovery(authority, responseVersion);
					return { committed: false, addedChunks: 0, manifest: manifestRef.current };
				}

				const previous = stateRef.current;
				const latestManifest = previous.manifest;
				const mergedManifest = mergeManifestExtensionWindows(latestManifest, patch.manifest);
				if (!mergedManifest) {
					structuralReconcileRequestRef.current("full");
					return { committed: false, addedChunks: 0, manifest: latestManifest };
				}

				const latestFirstSeq = latestManifest[0]?.firstSeq;
				const patchFirstSeq = patch.manifest[0]?.firstSeq;
				let hasOlderChunks = previous.hasOlderChunks;
				if (patchFirstSeq != null) {
					if (latestFirstSeq == null || patchFirstSeq < latestFirstSeq) {
						hasOlderChunks = patch.hasOlderChunks;
					} else if (patchFirstSeq === latestFirstSeq) {
						// Two same-version responses describe the same earliest boundary. Once
						// either proves that no older page exists, a delayed `true` cannot reopen it.
						hasOlderChunks = previous.hasOlderChunks && patch.hasOlderChunks;
					}
				}

				const mergedIds = new Set(mergedManifest.map((chunk) => chunk.id));
				let loaded = previous.loaded;
				for (const [chunkId, messages] of patch.incoming) {
					if (!mergedIds.has(chunkId) || previous.loaded.has(chunkId)) continue;
					if (loaded === previous.loaded) loaded = new Map(previous.loaded);
					loaded.set(chunkId, messages);
					cancelEviction(chunkId);
				}
				const metaPatch = patch.meta ? getChunkRangeMeta(patch.meta) : null;
				const next: NarratorChunksState = {
					...previous,
					...(metaPatch ?? {}),
					manifest: mergedManifest,
					hasOlderChunks,
					loaded,
				};
				commitState(next, { urgent: true });
				return {
					committed: true,
					addedChunks: Math.max(0, mergedManifest.length - latestManifest.length),
					manifest: mergedManifest,
				};
			}),
		[
			withManifestExtensionCommitLock,
			flushChunkUpdatesSync,
			isManifestExtensionAuthorityCurrent,
			requestManifestExtensionRecovery,
			cancelEviction,
			commitState,
		],
	);

	/**
	 * Ensure the given chunk (and `radius` neighbours on each side) are loaded.
	 * Cheap no-op when everything in range is already present; waits for any
	 * existing in-flight range request that covers missing chunks.
	 */
	const ensureLoaded = useCallback(
		async (chunkId: string, radius = INITIAL_RADIUS) => {
			const generation = loadGenerationRef.current;
			const manifest = manifestRef.current;
			if (manifest.length === 0) return;
			const centerIdx = manifest.findIndex((c) => c.id === chunkId);
			if (centerIdx < 0) return;
			const start = Math.max(0, centerIdx - radius);
			const end = Math.min(manifest.length - 1, centerIdx + radius);

			// Find missing contiguous ranges. If a missing chunk is already loading,
			// wait for that promise instead of issuing a duplicate request; jump callers
			// depend on this promise resolving before looking for target DOM nodes.
			const loaded = loadedRef.current;
			const missingRanges: ChunkIndexRange[] = [];
			const existingLoads = new Set<Promise<void>>();
			let rangeStart: number | null = null;
			for (let i = start; i <= end; i++) {
				const chunk = manifest[i];
				const missing = !isChunkComplete(loaded, chunk);
				const inFlight = missing ? inFlightRef.current.get(chunk.id) : undefined;
				if (inFlight) existingLoads.add(inFlight);
				const shouldLoad = missing && !inFlight;
				if (shouldLoad && rangeStart == null) rangeStart = i;
				if ((!shouldLoad || i === end) && rangeStart != null) {
					missingRanges.push({ start: rangeStart, end: shouldLoad ? i : i - 1 });
					rangeStart = null;
				}
			}
			if (missingRanges.length === 0) {
				await Promise.all(existingLoads);
				return;
			}

			const ownedChunkIds: string[] = [];
			for (const range of missingRanges) {
				for (let i = range.start; i <= range.end; i++) ownedChunkIds.push(manifest[i].id);
			}
			const loadPromise = (async () => {
				try {
					const expectedVersion =
						narratorWSManager.getMessageVersion(narratorId) ?? messageVersionRef.current;
					const bandResult = await loadManifestBands(
						manifest,
						missingRanges,
						generation,
						expectedVersion > 0 ? expectedVersion : undefined,
					);
					if (!bandResult || generation !== loadGenerationRef.current) return;
					mergeLoaded(bandResult.incoming, bandResult.meta, { preserveCompleteExisting: true });
				} catch {
					if (generation === loadGenerationRef.current)
						structuralReconcileRequestRef.current("full");
				}
			})();
			for (const id of ownedChunkIds) inFlightRef.current.set(id, loadPromise);
			try {
				await Promise.all([...existingLoads, loadPromise]);
			} finally {
				for (const id of ownedChunkIds) {
					if (inFlightRef.current.get(id) === loadPromise) inFlightRef.current.delete(id);
				}
			}
		},
		[loadManifestBands, mergeLoaded, isChunkComplete, narratorId],
	);

	/**
	 * Expand the loaded manifest window upward (reverse infinite scroll). Fetches
	 * the band of chunks immediately older than the current oldest loaded chunk,
	 * prepends their tuples to the manifest, and loads their content so the newly
	 * revealed band renders immediately. No-op when there is nothing older or an
	 * expansion is already in flight. Returns the number of chunks prepended (0
	 * when nothing was added) so the view can decide whether to keep going.
	 */
	const loadOlderManifest = useCallback((): Promise<number> => {
		const existing = manifestExtensionInFlightRef.current.older;
		if (existing) return existing;

		const request = (async (): Promise<number> => {
			if (!hasOlderChunksRef.current) return 0;
			const authority = captureManifestExtensionAuthority();
			if (!authority) return 0;
			const baseManifest = manifestRef.current.slice();
			if (baseManifest.length === 0) return 0;
			const beforeSeq = baseManifest[0].firstSeq;
			const manifestResult = await api.getChunkManifest(narratorId, undefined, {
				limitChunks: OLDER_MANIFEST_BATCH_CHUNKS,
				beforeSeq,
			});
			if (!isManifestExtensionAuthorityCurrent(authority, manifestResult.messageVersion)) {
				requestManifestExtensionRecovery(authority, manifestResult.messageVersion);
				return 0;
			}
			if (manifestResult.unchanged) return 0;

			const olderChunks = decodeManifestTuples(manifestResult.chunks);
			const working = mergeManifestExtensionWindows(baseManifest, olderChunks);
			if (!working) {
				structuralReconcileRequestRef.current("full");
				return 0;
			}
			const baseIds = new Set(baseManifest.map((chunk) => chunk.id));
			const newChunks = olderChunks.filter((chunk) => !baseIds.has(chunk.id));
			let incoming = new Map<string, TreeMessage[]>();
			let meta: ChunkRangeMeta | null = null;
			if (newChunks.length > 0) {
				const firstSeq = newChunks[0].firstSeq;
				const range = await api.getNarratorChunks(narratorId, {
					direction: "newer",
					fromSeq: firstSeq - 1,
					count: newChunks.length,
				});
				if (!isManifestExtensionAuthorityCurrent(authority, range.messageVersion)) {
					requestManifestExtensionRecovery(authority, range.messageVersion);
					return 0;
				}
				incoming = regroup(range.messages, working);
				meta = getChunkRangeMeta(range);
			}

			const committed = await commitManifestExtension(authority, manifestResult.messageVersion, {
				manifest: working,
				incoming,
				hasOlderChunks: manifestResult.hasOlderChunks,
				meta,
			});
			return committed.addedChunks;
		})().catch(() => 0);

		let tracked!: Promise<number>;
		tracked = request.finally(() => {
			if (manifestExtensionInFlightRef.current.older === tracked) {
				manifestExtensionInFlightRef.current.older = null;
			}
		});
		manifestExtensionInFlightRef.current.older = tracked;
		return tracked;
	}, [
		narratorId,
		regroup,
		captureManifestExtensionAuthority,
		isManifestExtensionAuthorityCurrent,
		requestManifestExtensionRecovery,
		commitManifestExtension,
	]);

	/**
	 * Bulk-expand the manifest window upward until it covers `seq` (a jump target
	 * older than the current window), then load that prepended range's content.
	 *
	 * Unlike loadOlderManifest (one 10-chunk scroll band at a time), this pulls
	 * the whole gap in large manifest batches (server caps at 200 chunks/req) and
	 * commits ONCE, so a deep search-result jump into a 30k-message history lands
	 * in a couple of requests instead of ~150 — and without the synchronous-ref
	 * vs committed-state race that stalled the old iterative loop.
	 */
	const ensureManifestCoversSeq = useCallback(
		(seq: number): Promise<boolean> => {
			if (manifestCoversSeq(manifestRef.current, seq)) return Promise.resolve(true);
			const existing = manifestExtensionInFlightRef.current.jumps.get(seq);
			if (existing) return existing;

			const request = (async (): Promise<boolean> => {
				const authority = captureManifestExtensionAuthority();
				if (!authority) return false;
				let working = manifestRef.current.slice();
				if (manifestCoversSeq(working, seq)) return true;
				let hasOlder = hasOlderChunksRef.current;

				// Walk metadata-only bands locally. Another extension may commit while
				// these requests are in flight; the shared commit lock unions this working
				// window into the newest manifestRef instead of replacing it.
				let guard = 0;
				while (
					!manifestCoversSeq(working, seq) &&
					hasOlder &&
					(working[0]?.firstSeq ?? 0) > seq &&
					guard++ < 64
				) {
					const beforeSeq = working[0].firstSeq;
					const manifestResult = await api.getChunkManifest(narratorId, undefined, {
						limitChunks: 200,
						beforeSeq,
					});
					if (!isManifestExtensionAuthorityCurrent(authority, manifestResult.messageVersion)) {
						requestManifestExtensionRecovery(authority, manifestResult.messageVersion);
						return false;
					}
					if (manifestResult.unchanged) break;
					const nextWorking = mergeManifestExtensionWindows(
						working,
						decodeManifestTuples(manifestResult.chunks),
					);
					if (!nextWorking) {
						structuralReconcileRequestRef.current("full");
						return false;
					}
					hasOlder = manifestResult.hasOlderChunks;
					if (nextWorking.length === working.length) break;
					working = nextWorking;
				}

				const targetIdx = working.findIndex(
					(chunk) => seq >= chunk.firstSeq && seq <= chunk.lastSeq,
				);
				const incomingAll = new Map<string, TreeMessage[]>();
				let meta: ChunkRangeMeta | null = null;
				if (targetIdx >= 0) {
					const loaded = loadedRef.current;
					let rangeStart = Math.max(0, targetIdx - 2);
					let spanEnd = Math.min(working.length - 1, targetIdx + 2);
					while (rangeStart < targetIdx && isChunkComplete(loaded, working[rangeStart])) {
						rangeStart++;
					}
					while (spanEnd > targetIdx && isChunkComplete(loaded, working[spanEnd])) spanEnd--;

					for (let i = rangeStart; i <= spanEnd; i += MAX_CHUNKS_PER_RANGE_REQUEST) {
						const batchStart = working[i];
						const batchCount = Math.min(MAX_CHUNKS_PER_RANGE_REQUEST, spanEnd - i + 1);
						const range = await api.getNarratorChunks(narratorId, {
							direction: "newer",
							fromSeq: batchStart.firstSeq - 1,
							count: batchCount,
						});
						if (!isManifestExtensionAuthorityCurrent(authority, range.messageVersion)) {
							requestManifestExtensionRecovery(authority, range.messageVersion);
							return false;
						}
						for (const [chunkId, messages] of regroup(range.messages, working)) {
							incomingAll.set(chunkId, messages);
						}
						meta = getChunkRangeMeta(range);
					}
				}

				const committed = await commitManifestExtension(authority, authority.stateVersion, {
					manifest: working,
					incoming: incomingAll,
					hasOlderChunks: hasOlder,
					meta,
				});
				return committed.committed && manifestCoversSeq(committed.manifest, seq);
			})().catch(() => false);

			let tracked!: Promise<boolean>;
			tracked = request.finally(() => {
				if (manifestExtensionInFlightRef.current.jumps.get(seq) === tracked) {
					manifestExtensionInFlightRef.current.jumps.delete(seq);
				}
			});
			manifestExtensionInFlightRef.current.jumps.set(seq, tracked);
			return tracked;
		},
		[
			narratorId,
			regroup,
			isChunkComplete,
			captureManifestExtensionAuthority,
			isManifestExtensionAuthorityCurrent,
			requestManifestExtensionRecovery,
			commitManifestExtension,
		],
	);

	// Keep the tail loaded so realtime messages have a landing spot and the initial
	// catch-up cursor can be seeded. Refetch it whenever the manifest tail changes.
	useEffect(() => {
		if (state.manifest.length === 0) return;
		const tail = state.manifest[state.manifest.length - 1];
		if (isChunkComplete(state.loaded, tail)) return;
		if (inFlightRef.current.has(tail.id)) return;
		ensureLoaded(tail.id, 0);
	}, [state.manifest, state.loaded, ensureLoaded, isChunkComplete]);

	// --- Structural reconcile (mid-history insert / delete / compact / reload) ---
	// Diff reconcile keeps clean loaded chunks by reference and reloads only the
	// first dirty band plus the tail band. Catch-up coordinates remain staged until
	// the manifest's authoritative version can be committed with them atomically.
	const reconcileInFlightRef = useRef(false);
	const reconcilePendingModeRef = useRef<ReconcileMode | null>(null);
	const reconcileFailedAttemptsRef = useRef(0);
	const reconcileRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconcileLifecycleRef = useRef(0);
	const reconcileMountedRef = useRef(false);
	const reconcileTokenRef = useRef<MessageReconcileToken | null>(null);

	const onStructuralDirty = useCallback(
		(mode: ReconcileMode = "diff") => {
			if (!reconcileMountedRef.current) return;
			const lifecycle = reconcileLifecycleRef.current;
			narratorWSManager.markMessageReconcilePending(narratorId, { restart: true });
			if (reconcileInFlightRef.current || reconcileRetryTimerRef.current) {
				reconcilePendingModeRef.current =
					mode === "full" || reconcilePendingModeRef.current === "full" ? "full" : "diff";
				return;
			}

			// Capture what the live React state already represents. Queued updates are
			// intentionally left in the replay suffix even when flushed before the REST
			// response, because a replacement snapshot would otherwise erase them.
			reconcileUpdaterCheckpointRef.current = appliedUpdaterSeqRef.current;
			realtimeUpdaterLogOverflowedRef.current = false;
			flushChunkUpdatesSync({ urgent: true });
			reconcileInFlightRef.current = true;
			reconcilePendingModeRef.current = null;
			const reconcileToken = narratorWSManager.getMessageReconcileToken(narratorId);
			reconcileTokenRef.current = reconcileToken;
			const captureReplayUpdaters = (): ChunkUpdaterReplay => {
				flushChunkUpdatesSync({ urgent: true });
				const checkpoint = reconcileUpdaterCheckpointRef.current ?? 0;
				const replay = selectChunkUpdaterReplay(
					realtimeUpdaterLogRef.current,
					checkpoint,
					nextUpdaterSeqRef.current,
				);
				if (realtimeUpdaterLogOverflowedRef.current || replay.overflowed) {
					throw new ChunkUpdaterReplayOverflowError();
				}
				return replay;
			};
			(async () => {
				let reconcileSucceeded = false;
				try {
					const previousManifest = manifestRef.current;
					// Preserve the window the user has expanded to: re-fetch the newest
					// N chunks where N matches the current window size, so a structural
					// change doesn't collapse it back to the initial window (nor creep it
					// larger on every reconcile). Older history stays lazily loadable.
					const windowChunks = Math.max(INITIAL_MANIFEST_CHUNKS, previousManifest.length);
					const sinceVersion =
						mode === "diff"
							? (narratorWSManager.getMessageVersion(narratorId) ?? messageVersionRef.current)
							: undefined;
					const manifest = await api.getChunkManifest(narratorId, sinceVersion, {
						limitChunks: windowChunks,
					});
					if (
						lifecycle !== reconcileLifecycleRef.current ||
						!narratorWSManager.isMessageReconcileTokenCurrent(narratorId, reconcileToken)
					) {
						throw new Error("Chunk manifest crossed a structural update");
					}
					const manifestVersion = manifest.messageVersion;
					const commitManifestVersion = (replayedThroughSeq: number) => {
						// A newer structural event arrived while this request was in flight. Its
						// staged cursor must wait for the next manifest, not this older snapshot.
						if (
							reconcilePendingModeRef.current ||
							lifecycle !== reconcileLifecycleRef.current ||
							!narratorWSManager.canCommitMessageReconcile(
								narratorId,
								manifestVersion,
								reconcileToken,
							)
						)
							return false;
						const committed = narratorWSManager.commitMessageReconcile(
							narratorId,
							manifestVersion,
							reconcileToken,
						);
						if (!committed) return false;
						commitReplayedUpdaterCheckpoint(replayedThroughSeq);
						reconcileUpdaterCheckpointRef.current = null;
						realtimeUpdaterLogOverflowedRef.current = false;
						reconcileFailedAttemptsRef.current = 0;
						return true;
					};

					if (mode === "diff" && manifest.unchanged) {
						// `unchanged` does not replace the local snapshot. The baseline and all
						// request-time updaters are already in React state after this flush, so
						// replaying the old log would apply Date.now()/counter fields twice.
						const replay = captureReplayUpdaters();
						if (
							reconcilePendingModeRef.current ||
							!narratorWSManager.canCommitMessageReconcile(
								narratorId,
								manifestVersion,
								reconcileToken,
							)
						)
							throw new Error("Chunk manifest commit was invalidated");
						commitState(
							(prev) =>
								prev.messageVersion === manifestVersion && prev.ownerNarratorId === narratorId
									? prev
									: {
											...prev,
											ownerNarratorId: narratorId,
											messageVersion: manifestVersion,
										},
							{ urgent: true },
						);
						reconcileSucceeded = commitManifestVersion(replay.lastSeq);
						if (!reconcileSucceeded) throw new Error("Chunk manifest commit was invalidated");
						return;
					}

					const manifestChunks = manifest.unchanged
						? previousManifest
						: decodeManifestTuples(manifest.chunks);
					const nextTotal = manifest.unchanged ? totalRef.current : manifest.total;
					const nextHasOlder = manifest.unchanged
						? hasOlderChunksRef.current
						: manifest.hasOlderChunks;
					const generation = loadGenerationRef.current + 1;
					loadGenerationRef.current = generation;
					inFlightRef.current.clear();
					// Do not clear ordinary realtime updaters here. They are drained and
					// replayed over the replacement snapshot immediately before commit.
					retainedChunkIdsRef.current = new Set();
					cancelAllEvictions();

					if (manifestChunks.length === 0) {
						const replay = captureReplayUpdaters();
						if (
							reconcilePendingModeRef.current ||
							!narratorWSManager.canCommitMessageReconcile(
								narratorId,
								manifestVersion,
								reconcileToken,
							)
						)
							throw new Error("Empty chunk manifest commit was invalidated");
						const replayed = applyChunkUpdaters(
							{ loaded: new Map(), manifest: [], total: 0 },
							replay.updaters,
						);
						commitState(
							(prev) => ({
								...prev,
								...replayed,
								ownerNarratorId: narratorId,
								messageVersion: manifestVersion,
								pruneBoundaryMessageId: null,
								prunedPercent: null,
								hasOlderChunks: false,
							}),
							{ urgent: true },
						);
						reconcileSucceeded = commitManifestVersion(replay.lastSeq);
						if (!reconcileSucceeded) throw new Error("Empty chunk manifest commit was invalidated");
						return;
					}

					const tailStart = Math.max(0, manifestChunks.length - INITIAL_BAND_CHUNKS);
					const ranges: Array<{ start: number; end: number }> = [
						{ start: tailStart, end: manifestChunks.length - 1 },
					];
					let dirtyStart = 0;
					if (mode === "full") {
						const loadedIds = new Set(loadedRef.current.keys());
						let loadedStart: number | null = null;
						for (let i = 0; i < manifestChunks.length; i++) {
							const isLoaded = loadedIds.has(manifestChunks[i].id);
							if (isLoaded && loadedStart == null) loadedStart = i;
							if ((!isLoaded || i === manifestChunks.length - 1) && loadedStart != null) {
								ranges.push({ start: loadedStart, end: isLoaded ? i : i - 1 });
								loadedStart = null;
							}
						}
					}
					if (mode === "diff") {
						const firstDirty = firstDirtyManifestIndex(previousManifest, manifestChunks);
						if (firstDirty == null) {
							const replay = captureReplayUpdaters();
							if (
								reconcilePendingModeRef.current ||
								!narratorWSManager.canCommitMessageReconcile(
									narratorId,
									manifestVersion,
									reconcileToken,
								)
							)
								throw new Error("Manifest coordinate commit was invalidated");
							// No loaded snapshot is replaced on this path. The urgent flush above
							// already materialized request-time updaters, so replaying them here
							// would execute non-idempotent Date.now()/counter logic twice.
							commitState(
								(prev) => ({
									...prev,
									ownerNarratorId: narratorId,
									manifest: manifestChunks,
									messageVersion: manifestVersion,
									hasOlderChunks: nextHasOlder,
								}),
								{ urgent: true },
							);
							reconcileSucceeded = commitManifestVersion(replay.lastSeq);
							if (!reconcileSucceeded)
								throw new Error("Manifest coordinate commit was invalidated");
							return;
						}
						dirtyStart = firstDirty;
						ranges.unshift({
							start: dirtyStart,
							end: Math.min(manifestChunks.length - 1, dirtyStart + INITIAL_BAND_CHUNKS - 1),
						});
					}

					const bandResult = await loadManifestBands(
						manifestChunks,
						ranges,
						generation,
						manifestVersion,
					);
					if (!bandResult || generation !== loadGenerationRef.current) {
						throw new Error("Chunk range generation was superseded");
					}
					if (
						lifecycle !== reconcileLifecycleRef.current ||
						!narratorWSManager.isMessageReconcileTokenCurrent(narratorId, reconcileToken)
					)
						throw new Error("Chunk range crossed a structural update");
					const replay = captureReplayUpdaters();
					if (
						reconcilePendingModeRef.current ||
						!narratorWSManager.canCommitMessageReconcile(
							narratorId,
							manifestVersion,
							reconcileToken,
						)
					)
						throw new Error("Chunk range commit was invalidated");
					const previous = stateRef.current;
					const loaded = new Map<string, TreeMessage[]>();
					if (mode === "diff") {
						const nextIndexById = new Map(manifestChunks.map((c, i) => [c.id, i]));
						for (const [chunkId, messages] of previous.loaded) {
							const idx = nextIndexById.get(chunkId);
							if (idx != null && idx < dirtyStart) loaded.set(chunkId, messages);
						}
					}
					for (const [chunkId, messages] of bandResult.incoming) loaded.set(chunkId, messages);
					const replayed = applyChunkUpdaters(
						{ loaded, manifest: manifestChunks, total: nextTotal },
						replay.updaters,
					);
					const meta = bandResult.meta ? getChunkRangeMeta(bandResult.meta) : null;
					commitState(
						{
							...replayed,
							ownerNarratorId: narratorId,
							messageVersion: manifestVersion,
							pruneBoundaryMessageId:
								meta?.pruneBoundaryMessageId ?? previous.pruneBoundaryMessageId ?? null,
							prunedPercent: meta?.prunedPercent ?? previous.prunedPercent ?? null,
							hasOlderChunks: nextHasOlder,
						},
						{ urgent: true },
					);
					reconcileSucceeded = commitManifestVersion(replay.lastSeq);
					if (!reconcileSucceeded) throw new Error("Chunk range commit was invalidated");
				} catch (error) {
					if (lifecycle !== reconcileLifecycleRef.current) return;
					if (
						error instanceof ChunkUpdaterReplayOverflowError ||
						realtimeUpdaterLogOverflowedRef.current
					) {
						// Incremental replay is no longer trustworthy. The finally block will
						// immediately start an authoritative full reconcile.
						reconcileFailedAttemptsRef.current = 0;
						reconcilePendingModeRef.current = "full";
						return;
					}
					const failedAttempts = reconcileFailedAttemptsRef.current + 1;
					reconcileFailedAttemptsRef.current = failedAttempts;
					const retryDelay = getStructuralReconcileRetryDelay(failedAttempts);
					if (retryDelay != null) {
						reconcilePendingModeRef.current =
							mode === "full" || reconcilePendingModeRef.current === "full" ? "full" : "diff";
						reconcileRetryTimerRef.current = setTimeout(() => {
							if (lifecycle !== reconcileLifecycleRef.current) return;
							reconcileRetryTimerRef.current = null;
							const retryMode = reconcilePendingModeRef.current ?? mode;
							reconcilePendingModeRef.current = null;
							onStructuralDirty(retryMode);
						}, retryDelay);
					} else if (mode !== "full") {
						// The committed cursor/version still describe the pre-catch-up tree. Drop
						// those old anchors and switch to one authoritative full-manifest reload.
						narratorWSManager.clearCommittedCatchUpAnchor(narratorId);
						reconcileFailedAttemptsRef.current = 0;
						reconcilePendingModeRef.current = "full";
						reconcileRetryTimerRef.current = setTimeout(() => {
							if (lifecycle !== reconcileLifecycleRef.current) return;
							reconcileRetryTimerRef.current = null;
							reconcilePendingModeRef.current = null;
							onStructuralDirty("full");
						}, RECONCILE_RETRY_BASE_MS);
					} else {
						// Full reload exhaustion is a bounded stop, not an endless retry loop:
						// release the pending gate so focus sync can recover independently.
						narratorWSManager.clearCatchUpState(narratorId);
						// The local snapshot could not be validated against the server (the
						// narrator may be deleted or its history rewritten). Drop it and stop
						// caching it, so the next mount does a full load rather than restoring
						// content we know we could not confirm.
						snapshotUntrustedRef.current = true;
						invalidateCachedChunkSnapshot(narratorId);
						reconcileFailedAttemptsRef.current = 0;
						reconcilePendingModeRef.current = null;
					}
				} finally {
					if (lifecycle === reconcileLifecycleRef.current) {
						reconcileInFlightRef.current = false;
						if (!reconcileRetryTimerRef.current && reconcilePendingModeRef.current) {
							const pendingMode = reconcilePendingModeRef.current;
							reconcilePendingModeRef.current = null;
							onStructuralDirty(pendingMode);
						} else if (reconcileSucceeded) {
							reconcilePendingModeRef.current = null;
						}
					}
				}
			})();
		},
		[
			narratorId,
			loadManifestBands,
			cancelAllEvictions,
			flushChunkUpdatesSync,
			commitState,
			commitReplayedUpdaterCheckpoint,
		],
	);
	structuralReconcileRequestRef.current = onStructuralDirty;

	useEffect(() => {
		reconcileLifecycleRef.current += 1;
		reconcileMountedRef.current = true;
		return () => {
			reconcileMountedRef.current = false;
			reconcileLifecycleRef.current += 1;
			if (reconcileRetryTimerRef.current) clearTimeout(reconcileRetryTimerRef.current);
			reconcileRetryTimerRef.current = null;
			reconcilePendingModeRef.current = null;
			reconcileTokenRef.current = null;
			reconcileInFlightRef.current = false;
			reconcileFailedAttemptsRef.current = 0;
			reconcileUpdaterCheckpointRef.current = null;
			realtimeUpdaterLogOverflowedRef.current = false;
			structuralReconcileRequestRef.current = () => {};
			narratorWSManager.clearMessageReconcilePending(narratorId);
		};
	}, [narratorId]);

	// Verify a restored snapshot against the server.
	//
	// MUST be declared AFTER the reconcile-lifecycle effect above: `onStructuralDirty`
	// returns early unless `reconcileMountedRef.current` is true, and effects run in
	// declaration order, so verifying any earlier would be silently swallowed and the
	// restored snapshot would never be refreshed.
	//
	// `diff` sends the restored `messageVersion` as `sinceVersion`, so an unchanged
	// narrator answers `{ unchanged: true }` and only the version is committed — the
	// snapshot is kept by reference. A changed narrator reloads the dirty band plus
	// the tail through the normal reconcile path.
	useEffect(() => {
		if (!pendingRestoreVerifyRef.current) return;
		pendingRestoreVerifyRef.current = false;
		onStructuralDirty("diff");
	}, [onStructuralDirty]);

	const ensureLoadedRange = useCallback(
		async (startIndex: number, endIndex: number) => {
			const manifest = manifestRef.current;
			if (manifest.length === 0) return;
			const start = Math.max(0, Math.min(startIndex, endIndex));
			const end = Math.min(manifest.length - 1, Math.max(startIndex, endIndex));
			if (start > end) return;

			const loaded = loadedRef.current;
			const missingRanges: Array<{ start: number; end: number }> = [];
			const existingLoads = new Set<Promise<void>>();
			let rangeStart: number | null = null;
			for (let i = start; i <= end; i++) {
				const chunk = manifest[i];
				const missing = !isChunkComplete(loaded, chunk);
				const inFlight = missing ? inFlightRef.current.get(chunk.id) : undefined;
				if (inFlight) existingLoads.add(inFlight);
				const shouldLoad = missing && !inFlight;
				if (shouldLoad && rangeStart == null) rangeStart = i;
				if ((!shouldLoad || i === end) && rangeStart != null) {
					missingRanges.push({ start: rangeStart, end: shouldLoad ? i : i - 1 });
					rangeStart = null;
				}
			}
			if (missingRanges.length === 0) {
				await Promise.all(existingLoads);
				return;
			}

			const generation = loadGenerationRef.current;
			const ownedChunkIds: string[] = [];
			for (const range of missingRanges) {
				for (let i = range.start; i <= range.end; i++) ownedChunkIds.push(manifest[i].id);
			}
			const loadPromise = (async () => {
				try {
					const expectedVersion =
						narratorWSManager.getMessageVersion(narratorId) ?? messageVersionRef.current;
					const bandResult = await loadManifestBands(
						manifest,
						missingRanges,
						generation,
						expectedVersion > 0 ? expectedVersion : undefined,
					);
					if (!bandResult || generation !== loadGenerationRef.current) return;
					mergeLoaded(bandResult.incoming, bandResult.meta, { preserveCompleteExisting: true });
				} catch {
					if (generation === loadGenerationRef.current)
						structuralReconcileRequestRef.current("full");
				}
			})();
			for (const id of ownedChunkIds) inFlightRef.current.set(id, loadPromise);
			try {
				await Promise.all([...existingLoads, loadPromise]);
			} finally {
				for (const id of ownedChunkIds) {
					if (inFlightRef.current.get(id) === loadPromise) inFlightRef.current.delete(id);
				}
			}
		},
		[loadManifestBands, mergeLoaded, isChunkComplete, narratorId],
	);

	const retainChunkRange = useCallback(
		(startIndex: number, endIndex: number) => {
			const manifest = manifestRef.current;
			if (manifest.length === 0) {
				retainedChunkIdsRef.current = new Set();
				return;
			}

			const start = Math.max(0, Math.min(startIndex, endIndex));
			const end = Math.min(manifest.length - 1, Math.max(startIndex, endIndex));
			const nextRetained = new Set<string>();
			for (let i = start; i <= end; i++) nextRetained.add(manifest[i].id);
			const tailId = manifest[manifest.length - 1]?.id;
			if (tailId) nextRetained.add(tailId);
			retainedChunkIdsRef.current = nextRetained;

			for (const chunkId of nextRetained) cancelEviction(chunkId);

			for (const chunkId of loadedRef.current.keys()) {
				if (nextRetained.has(chunkId) || evictionTimersRef.current.has(chunkId)) continue;
				const timer = setTimeout(() => {
					evictionTimersRef.current.delete(chunkId);
					const currentManifest = manifestRef.current;
					const currentTailId = currentManifest[currentManifest.length - 1]?.id;
					if (chunkId === currentTailId) return;
					if (retainedChunkIdsRef.current.has(chunkId)) return;
					if (inFlightRef.current.has(chunkId)) return;
					if (!loadedRef.current.has(chunkId)) return;

					commitState(
						(prev) => {
							if (!prev.loaded.has(chunkId)) return prev;
							const loaded = new Map(prev.loaded);
							loaded.delete(chunkId);
							return { ...prev, loaded };
						},
						{ urgent: true },
					);
				}, CHUNK_EVICT_DELAY_MS);
				evictionTimersRef.current.set(chunkId, timer);
			}
		},
		[cancelEviction, commitState],
	);

	const refreshStructure = useCallback(
		(mode: ReconcileMode = "diff") => onStructuralDirty(mode),
		[onStructuralDirty],
	);

	const onTailFollow = useCallback(() => {
		onTailFollowRef.current?.();
	}, []);
	const onUnread = useCallback(() => setUnreadCount((c) => c + 1), []);

	// Publish the snapshot on teardown so the next mount can restore it.
	//
	// React runs every cleanup before the next round of effects, so on an in-place
	// narrator switch `stateRef` still holds the OUTGOING narrator's state here.
	// Writing by `ownerNarratorId` therefore attributes the snapshot correctly for
	// both unmount and switch, and the cache's own validity gate rejects a state
	// that never finished its initial load.
	// biome-ignore lint/correctness/useExhaustiveDependencies: narratorId drives the cleanup that publishes the outgoing narrator's snapshot
	useEffect(() => {
		return () => {
			const snapshot = stateRef.current;
			if (!snapshot.ownerNarratorId) return;
			if (snapshotUntrustedRef.current) {
				invalidateCachedChunkSnapshot(snapshot.ownerNarratorId);
				return;
			}
			writeCachedChunkSnapshot({
				narratorId: snapshot.ownerNarratorId,
				manifest: snapshot.manifest,
				loaded: snapshot.loaded,
				total: snapshot.total,
				messageVersion: snapshot.messageVersion,
				hasOlderChunks: snapshot.hasOlderChunks,
				pruneBoundaryMessageId: snapshot.pruneBoundaryMessageId,
				prunedPercent: snapshot.prunedPercent,
			});
		};
	}, [narratorId]);

	// --- Initial canonical cursor for WS catch-up ---
	// Seed the parent tail plus loaded child-stream anchors (skipping synthetic
	// streaming ids); realtime updates subsequently maintain the full cursor.
	const initialCatchUpCursor = useMemo<CatchUpCursor | undefined>(() => {
		// React preserves hook state for an in-place narrator switch until effects run.
		// Never let that previous owner's loaded tail seed the new subscription.
		if (state.ownerNarratorId !== narratorId) return undefined;
		const tail = state.manifest[state.manifest.length - 1];
		return catchUpCursorFromLoadedTail(tail ? state.loaded.get(tail.id) : undefined);
	}, [narratorId, state.ownerNarratorId, state.manifest, state.loaded]);

	// --- WebSocket integration (subscribe + catch-up + new messages + streaming) ---
	const { streamingMsg, connected, disconnected, reconnect } = useNarratorChunksWS({
		narratorId,
		isSubagent: options?.isSubagent,
		initialCatchUpCursor,
		scheduleChunkUpdate,
		flushChunkUpdatesSync,
		loadedRef,
		loadedOwnerNarratorId: state.ownerNarratorId,
		loaded: state.loaded,
		manifestRef,
		isAtBottomRef,
		onUnread,
		onStructuralDirty,
		onTailFollow,
	});

	// Expose chunks as the manifest full set, each with its loaded messages (if any).
	// Reuse unchanged wrapper objects so ordinary loaded-map updates don't make
	// every chunk look new to downstream memo/effect code.
	const chunkDataCacheRef = useRef<Map<string, ChunkData>>(new Map());
	const chunks = useMemo<ChunkData[]>(() => {
		const cache = chunkDataCacheRef.current;
		const liveIds = new Set<string>();
		const next = state.manifest.map((entry) => {
			liveIds.add(entry.id);
			const messages = state.loaded.get(entry.id);
			const cached = cache.get(entry.id);
			if (
				cached &&
				cached.firstSeq === entry.firstSeq &&
				cached.lastSeq === entry.lastSeq &&
				cached.count === entry.count &&
				cached.messages === messages
			) {
				return cached;
			}
			const chunk: ChunkData = { ...entry, messages };
			cache.set(entry.id, chunk);
			return chunk;
		});
		for (const id of cache.keys()) {
			if (!liveIds.has(id)) cache.delete(id);
		}
		return next;
	}, [state.manifest, state.loaded]);

	const tailChunkId =
		state.manifest.length > 0 ? state.manifest[state.manifest.length - 1].id : null;

	return {
		chunks,
		total: state.total,
		messageVersion: state.messageVersion,
		pruneBoundaryMessageId: state.pruneBoundaryMessageId,
		prunedPercent: state.prunedPercent,
		loading,
		ensureLoaded,
		ensureLoadedRange,
		retainChunkRange,
		refreshStructure,
		// Windowed manifest (reverse infinite scroll toward the top)
		hasOlderChunks: state.hasOlderChunks,
		loadOlderManifest,
		getManifestSnapshot,
		ensureManifestCoversSeq,
		// Streaming / live state
		streamingMsg: streamingMsg as NarratorMsg | null,
		tailChunkId,
		// Bottom tracking + unread
		setIsAtBottom,
		isAtBottomRef,
		unreadCount,
		resetUnread,
		// WS connection
		connected,
		disconnected,
		reconnect,
	};
}
