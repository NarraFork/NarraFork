import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	ChunkManifestEntry,
	ChunkManifestTuple,
	ChunkRangeResult,
	TreeMessage,
} from "../../lib/api";
import { api } from "../../lib/api";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import type { NarratorMsg } from "./narrator-panel-types";
import { STREAMING_CHUNKS_MSG_ID } from "./narrator-panel-types";
import { type ChunkMutState, type ChunkUpdater, useNarratorChunksWS } from "./useNarratorChunksWS";

/**
 * Data layer for the chunk-virtualized message list.
 *
 * The manifest defines the full coordinate system — every chunk that exists,
 * with its seq range and message count — so the scroll container can be sized
 * to the entire history and the scrollbar maps to real positions. Chunk
 * *content* is loaded sparsely on demand into `loaded` (a Map keyed by chunk
 * id), so the user can jump the scrollbar anywhere and we fetch just that band.
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

/** Expand a compact wire tuple [id, firstSeq, lastSeq, count] into an entry. */
function decodeManifestTuples(tuples: ChunkManifestTuple[]): ChunkManifestEntry[] {
	const out = new Array<ChunkManifestEntry>(tuples.length);
	for (let i = 0; i < tuples.length; i++) {
		const t = tuples[i];
		out[i] = { id: t[0], firstSeq: t[1], lastSeq: t[2], count: t[3] };
	}
	return out;
}

function sameManifestEntry(a: ChunkManifestEntry | undefined, b: ChunkManifestEntry | undefined) {
	return (
		a != null &&
		b != null &&
		a.id === b.id &&
		a.firstSeq === b.firstSeq &&
		a.lastSeq === b.lastSeq &&
		a.count === b.count
	);
}

/**
 * First manifest index that may need content reload. The manifest currently does
 * not carry a per-chunk content hash, so when a tuple changes at i we step back
 * one chunk to cover within-chunk insert/delete cases whose first id stayed the
 * same but whose tail was pulled from the next chunk.
 */
function firstDirtyManifestIndex(
	prev: ChunkManifestEntry[],
	next: ChunkManifestEntry[],
): number | null {
	const len = Math.min(prev.length, next.length);
	for (let i = 0; i < len; i++) {
		if (!sameManifestEntry(prev[i], next[i])) return Math.max(0, i - 1);
	}
	if (prev.length === next.length) return null;
	return Math.max(0, len - 1);
}

export interface ChunkData extends ChunkManifestEntry {
	/** Loaded top-level messages for this chunk, or undefined if not yet loaded. */
	messages?: TreeMessage[];
}

export interface NarratorChunksState {
	manifest: ChunkManifestEntry[];
	total: number;
	messageVersion: number;
	pruneBoundaryMessageId: string | null;
	prunedPercent: number | null;
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
const CHUNK_UPDATE_FALLBACK_MS = 250;
/** Server clamps /narrators/:id/chunks `count` to at most 20 chunks. */
const MAX_CHUNKS_PER_RANGE_REQUEST = 20;
/** Delay before evicting loaded chunk data after it leaves the retained range. */
const CHUNK_EVICT_DELAY_MS = 30_000;
type ReconcileMode = "diff" | "full";

type ChunkRangeMeta = Pick<ChunkRangeResult, "pruneBoundaryMessageId" | "prunedPercent">;

function getChunkRangeMeta(range: ChunkRangeMeta): ChunkRangeMeta {
	return {
		pruneBoundaryMessageId: range.pruneBoundaryMessageId ?? null,
		prunedPercent: range.prunedPercent ?? null,
	};
}

/** Deepest last descendant id of a message (skips synthetic streaming ids). */
function deepestLastChildId(message: TreeMessage | undefined): string | undefined {
	if (!message?.id || message.id === STREAMING_CHUNKS_MSG_ID) return undefined;
	let deepest: TreeMessage = message;
	while (deepest.children?.length) {
		deepest = deepest.children[deepest.children.length - 1];
	}
	return deepest.id;
}

export function useNarratorChunks(narratorId: string, options?: UseNarratorChunksOptions) {
	const [state, setState] = useState<NarratorChunksState>({
		manifest: [],
		total: 0,
		messageVersion: 0,
		pruneBoundaryMessageId: null,
		prunedPercent: null,
		loaded: new Map(),
	});
	const [loading, setLoading] = useState(true);
	// In-flight chunk loads, keyed by chunk id. The promise lets jump/selection
	// callers wait for an existing range request instead of racing React commits.
	const inFlightRef = useRef<Map<string, Promise<void>>>(new Map());
	// Bumped whenever the manifest coordinate system is rebuilt; stale range
	// requests from an older generation are ignored on arrival.
	const loadGenerationRef = useRef(0);
	const manifestRef = useRef<ChunkManifestEntry[]>([]);
	manifestRef.current = state.manifest;
	// Latest loaded map, read inside ensureLoaded to avoid stale-closure checks
	// and to keep the callback referentially stable.
	const loadedRef = useRef<Map<string, TreeMessage[]>>(state.loaded);
	loadedRef.current = state.loaded;
	const messageVersionRef = useRef(state.messageVersion);
	messageVersionRef.current = state.messageVersion;

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
	const regroup = useCallback((messages: TreeMessage[]): Map<string, TreeMessage[]> => {
		const manifest = manifestRef.current;
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
	}, []);

	const isChunkComplete = useCallback(
		(loaded: Map<string, TreeMessage[]>, chunk: ChunkManifestEntry) =>
			(loaded.get(chunk.id)?.length ?? 0) >= chunk.count,
		[],
	);

	const mergeLoaded = useCallback(
		(incoming: Map<string, TreeMessage[]>, meta?: ChunkRangeMeta | null) => {
			if (incoming.size === 0 && !meta) return;
			for (const chunkId of incoming.keys()) cancelEviction(chunkId);
			setState((prev) => {
				const loaded = incoming.size > 0 ? new Map(prev.loaded) : prev.loaded;
				for (const [chunkId, msgs] of incoming) loaded.set(chunkId, msgs);
				return { ...prev, ...(meta ? getChunkRangeMeta(meta) : {}), loaded };
			});
		},
		[cancelEviction],
	);

	// --- rAF-batched chunk-map updater (chunk-mode scheduleCacheUpdate) ---
	// WS events queue pure updaters that fold `{ loaded, manifest, total }` →
	// new state; they flush in a single setState per animation frame (with a
	// timeout fallback when the tab is hidden), collapsing N WS events into one
	// React commit. This NEVER writes the TanStack Query cache.
	const pendingUpdatersRef = useRef<ChunkUpdater[]>([]);
	const updateRafRef = useRef(0);
	const updateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const flushChunkUpdatesSync = useCallback(() => {
		if (updateRafRef.current) {
			cancelAnimationFrame(updateRafRef.current);
			updateRafRef.current = 0;
		}
		if (updateTimeoutRef.current) {
			clearTimeout(updateTimeoutRef.current);
			updateTimeoutRef.current = null;
		}
		const updaters = pendingUpdatersRef.current;
		if (updaters.length === 0) return;
		pendingUpdatersRef.current = [];
		startTransition(() => {
			setState((prev) => {
				let acc: ChunkMutState = {
					loaded: prev.loaded,
					manifest: prev.manifest,
					total: prev.total,
				};
				for (const updater of updaters) acc = updater(acc);
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
			});
		});
	}, []);
	const scheduleChunkUpdate = useCallback(
		(updater: ChunkUpdater) => {
			pendingUpdatersRef.current.push(updater);
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
	useEffect(() => {
		return () => {
			if (updateRafRef.current) cancelAnimationFrame(updateRafRef.current);
			if (updateTimeoutRef.current) clearTimeout(updateTimeoutRef.current);
		};
	}, []);

	// Initial load: manifest + newest tail chunk; neighbours are warmed after first paint.
	useEffect(() => {
		let cancelled = false;
		const generation = loadGenerationRef.current + 1;
		loadGenerationRef.current = generation;
		setLoading(true);
		manifestRef.current = [];
		setState({
			manifest: [],
			total: 0,
			messageVersion: 0,
			pruneBoundaryMessageId: null,
			prunedPercent: null,
			loaded: new Map(),
		});
		inFlightRef.current.clear();
		pendingUpdatersRef.current = [];
		(async () => {
			for (let attempt = 0; attempt < INITIAL_LOAD_MAX_ATTEMPTS; attempt++) {
				const [manifest, range] = await Promise.all([
					api.getChunkManifest(narratorId),
					api.getNarratorChunks(narratorId, {
						direction: "older",
						count: INITIAL_CONTENT_CHUNKS,
					}),
				]);
				if (cancelled || generation !== loadGenerationRef.current) return;
				if (manifest.messageVersion !== range.messageVersion) {
					if (attempt < INITIAL_LOAD_MAX_ATTEMPTS - 1) {
						await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
						continue;
					}
					throw new Error("Chunk manifest and range versions did not converge");
				}
				const manifestChunks = manifest.unchanged ? [] : decodeManifestTuples(manifest.chunks);
				manifestRef.current = manifestChunks;
				const loaded = regroup(range.messages);
				const meta = getChunkRangeMeta(range);
				setState({
					manifest: manifestChunks,
					total: manifest.unchanged ? 0 : manifest.total,
					messageVersion: range.messageVersion,
					pruneBoundaryMessageId: meta.pruneBoundaryMessageId ?? null,
					prunedPercent: meta.prunedPercent ?? null,
					loaded,
				});
				// Seed the WS manager's tracked version so reconnect catch-up diffs work.
				narratorWSManager.updateMessageVersion(narratorId, range.messageVersion);
				setLoading(false);
				return;
			}
		})().catch(() => {
			if (!cancelled) setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [narratorId, regroup]);

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

			// Find chunks that are missing. If they are already loading, wait for the
			// existing promise instead of returning early; jump callers depend on this
			// promise resolving before they start looking for the target DOM node.
			const loaded = loadedRef.current;
			const missing: ChunkManifestEntry[] = [];
			const existingLoads = new Set<Promise<void>>();
			for (let i = start; i <= end; i++) {
				const c = manifest[i];
				if (isChunkComplete(loaded, c)) continue;
				const inFlight = inFlightRef.current.get(c.id);
				if (inFlight) {
					existingLoads.add(inFlight);
				} else {
					missing.push(c);
				}
			}
			if (missing.length === 0) {
				await Promise.all(existingLoads);
				return;
			}

			// Load the whole [start,end] band in one request anchored just before
			// the first chunk's firstSeq (direction newer ⇒ seq >= firstSeq).
			const firstSeq = manifest[start].firstSeq;
			const bandChunkCount = end - start + 1;
			const ownedChunkIds: string[] = [];
			for (let i = start; i <= end; i++) ownedChunkIds.push(manifest[i].id);
			const loadPromise = (async () => {
				const range = await api.getNarratorChunks(narratorId, {
					direction: "newer",
					fromSeq: firstSeq - 1,
					count: bandChunkCount,
				});
				if (generation !== loadGenerationRef.current) return;
				mergeLoaded(regroup(range.messages), getChunkRangeMeta(range));
			})();
			for (const id of ownedChunkIds) inFlightRef.current.set(id, loadPromise);
			try {
				// This request covers the whole band, including chunks that may already
				// have another load in flight. A stale neighbouring request should not make
				// this caller fail after the fresh band load succeeds.
				await loadPromise;
			} finally {
				for (const id of ownedChunkIds) {
					if (inFlightRef.current.get(id) === loadPromise) inFlightRef.current.delete(id);
				}
			}
		},
		[narratorId, regroup, mergeLoaded, isChunkComplete],
	);

	// --- Tail-resident guarantee ---
	// The last manifest chunk must always be loaded so new messages / streaming
	// have a landing spot and `lastMessageId` can be computed. Whenever the
	// manifest changes and the tail isn't loaded, fetch it.
	useEffect(() => {
		if (state.manifest.length === 0) return;
		const tail = state.manifest[state.manifest.length - 1];
		if (isChunkComplete(state.loaded, tail)) return;
		if (inFlightRef.current.has(tail.id)) return;
		ensureLoaded(tail.id, 0);
	}, [state.manifest, state.loaded, ensureLoaded, isChunkComplete]);

	// --- Structural reconcile (mid-history insert / delete / compact / reload) ---
	// Diff reconcile keeps clean loaded chunks by reference and reloads only the
	// first dirty band plus the tail band. Full reload is kept as a hard fallback.
	const reconcileInFlightRef = useRef(false);
	const reconcilePendingModeRef = useRef<ReconcileMode | null>(null);

	const loadManifestBands = useCallback(
		async (
			manifestChunks: ChunkManifestEntry[],
			ranges: Array<{ start: number; end: number }>,
			generation: number,
		): Promise<{ incoming: Map<string, TreeMessage[]>; meta: ChunkRangeMeta | null } | null> => {
			const incoming = new Map<string, TreeMessage[]>();
			let meta: ChunkRangeMeta | null = null;
			if (manifestChunks.length === 0 || ranges.length === 0) return { incoming, meta };

			const merged = [...ranges]
				.filter((r) => r.start <= r.end)
				.sort((a, b) => a.start - b.start)
				.reduce<Array<{ start: number; end: number }>>((acc, range) => {
					const last = acc[acc.length - 1];
					if (last && range.start <= last.end + 1) {
						last.end = Math.max(last.end, range.end);
					} else {
						acc.push({ ...range });
					}
					return acc;
				}, []);

			manifestRef.current = manifestChunks;
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
					meta = getChunkRangeMeta(range);
					for (const [chunkId, messages] of regroup(range.messages)) {
						incoming.set(chunkId, messages);
					}
				}
			}
			return { incoming, meta };
		},
		[narratorId, regroup],
	);

	const onStructuralDirty = useCallback(
		(mode: ReconcileMode = "diff") => {
			if (reconcileInFlightRef.current) {
				reconcilePendingModeRef.current =
					mode === "full" || reconcilePendingModeRef.current === "full" ? "full" : "diff";
				return;
			}
			reconcileInFlightRef.current = true;
			(async () => {
				try {
					const previousManifest = manifestRef.current;
					const manifest = await api.getChunkManifest(
						narratorId,
						mode === "diff" ? messageVersionRef.current : undefined,
					);
					const manifestVersion = manifest.messageVersion;

					if (mode === "diff" && manifest.unchanged) {
						setState((prev) =>
							prev.messageVersion === manifestVersion
								? prev
								: { ...prev, messageVersion: manifestVersion },
						);
						narratorWSManager.updateMessageVersion(narratorId, manifestVersion);
						return;
					}

					const manifestChunks = manifest.unchanged
						? previousManifest
						: decodeManifestTuples(manifest.chunks);
					const nextTotal = manifest.unchanged
						? manifestChunks.reduce((sum, chunk) => sum + chunk.count, 0)
						: manifest.total;
					const generation = loadGenerationRef.current + 1;
					loadGenerationRef.current = generation;
					inFlightRef.current.clear();
					pendingUpdatersRef.current = [];
					retainedChunkIdsRef.current = new Set();
					cancelAllEvictions();
					manifestRef.current = manifestChunks;

					if (manifestChunks.length === 0) {
						setState({
							manifest: [],
							total: 0,
							messageVersion: manifestVersion,
							pruneBoundaryMessageId: null,
							prunedPercent: null,
							loaded: new Map(),
						});
						narratorWSManager.updateMessageVersion(narratorId, manifestVersion);
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
							setState((prev) => ({
								...prev,
								manifest: manifestChunks,
								total: nextTotal,
								messageVersion: manifestVersion,
							}));
							narratorWSManager.updateMessageVersion(narratorId, manifestVersion);
							return;
						}
						dirtyStart = firstDirty;
						ranges.unshift({
							start: dirtyStart,
							end: Math.min(manifestChunks.length - 1, dirtyStart + INITIAL_BAND_CHUNKS - 1),
						});
					}

					const bandResult = await loadManifestBands(manifestChunks, ranges, generation);
					if (!bandResult || generation !== loadGenerationRef.current) return;

					setState((prev) => {
						const loaded = new Map<string, TreeMessage[]>();
						if (mode === "diff") {
							const nextIndexById = new Map(manifestChunks.map((c, i) => [c.id, i]));
							for (const [chunkId, messages] of prev.loaded) {
								const idx = nextIndexById.get(chunkId);
								if (idx != null && idx < dirtyStart) loaded.set(chunkId, messages);
							}
						}
						for (const [chunkId, messages] of bandResult.incoming) loaded.set(chunkId, messages);
						const meta = bandResult.meta ? getChunkRangeMeta(bandResult.meta) : null;
						return {
							manifest: manifestChunks,
							total: nextTotal,
							messageVersion: manifestVersion,
							pruneBoundaryMessageId:
								meta?.pruneBoundaryMessageId ?? prev.pruneBoundaryMessageId ?? null,
							prunedPercent: meta?.prunedPercent ?? prev.prunedPercent ?? null,
							loaded,
						};
					});
					narratorWSManager.updateMessageVersion(narratorId, manifestVersion);
				} catch {
					// Swallow — a later WS event or remount will retry.
				} finally {
					reconcileInFlightRef.current = false;
					const pendingMode = reconcilePendingModeRef.current;
					reconcilePendingModeRef.current = null;
					if (pendingMode) onStructuralDirty(pendingMode);
				}
			})();
		},
		[narratorId, loadManifestBands, cancelAllEvictions],
	);

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
				const bandResult = await loadManifestBands(manifest, missingRanges, generation);
				if (!bandResult || generation !== loadGenerationRef.current) return;
				mergeLoaded(bandResult.incoming, bandResult.meta);
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
		[loadManifestBands, mergeLoaded, isChunkComplete],
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

					setState((prev) => {
						if (!prev.loaded.has(chunkId)) return prev;
						const loaded = new Map(prev.loaded);
						loaded.delete(chunkId);
						return { ...prev, loaded };
					});
				}, CHUNK_EVICT_DELAY_MS);
				evictionTimersRef.current.set(chunkId, timer);
			}
		},
		[cancelEviction],
	);

	const refreshStructure = useCallback(
		(mode: ReconcileMode = "diff") => onStructuralDirty(mode),
		[onStructuralDirty],
	);

	const onTailFollow = useCallback(() => {
		onTailFollowRef.current?.();
	}, []);
	const onUnread = useCallback(() => setUnreadCount((c) => c + 1), []);

	// --- lastMessageId anchor for WS catch-up ---
	// Deepest last descendant of the tail chunk's last message (skips synthetic
	// streaming ids). Used so reconnect catch-up only backfills what we're
	// missing.
	const lastMessageId = useMemo(() => {
		const manifest = state.manifest;
		if (manifest.length === 0) return undefined;
		const tail = manifest[manifest.length - 1];
		const tailMsgs = state.loaded.get(tail.id);
		if (!tailMsgs?.length) return undefined;
		for (let i = tailMsgs.length - 1; i >= 0; i--) {
			const id = deepestLastChildId(tailMsgs[i]);
			if (id) return id;
		}
		return undefined;
	}, [state.manifest, state.loaded]);

	// --- WebSocket integration (subscribe + catch-up + new messages + streaming) ---
	const { streamingMsg, connected, disconnected, reconnect } = useNarratorChunksWS({
		narratorId,
		isSubagent: options?.isSubagent,
		lastMessageId,
		scheduleChunkUpdate,
		flushChunkUpdatesSync,
		loadedRef,
		manifestRef,
		isAtBottomRef,
		onUnread,
		onStructuralDirty,
		onTailFollow,
	});

	// Expose chunks as the manifest full set, each with its loaded messages (if any).
	const chunks = useMemo<ChunkData[]>(
		() => state.manifest.map((c) => ({ ...c, messages: state.loaded.get(c.id) })),
		[state.manifest, state.loaded],
	);

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
