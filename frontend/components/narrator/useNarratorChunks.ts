import { useCallback, useEffect, useRef, useState } from "react";
import type { ChunkManifestEntry, TreeMessage } from "../../lib/api";
import { api } from "../../lib/api";

/**
 * Phase 0 data layer for the chunk-virtualized message list.
 *
 * Responsibilities (verification slice only):
 *  - Load the lightweight chunk manifest (fingerprints + estimated structure).
 *  - Load a contiguous window of chunk *content* around the tail (or a target).
 *  - Expose loadOlder / loadNewer to extend the contiguous loaded window.
 *
 * NOT in scope for Phase 0 (deferred to Phase 1+):
 *  - Safe-boundary segmentation / render-chunk packing.
 *  - chunks_dirty incremental reconciliation.
 *  - Custom scrollbar integration.
 *
 * The loaded messages are kept as a single seq-ascending array; the consumer
 * groups them into render chunks using the manifest boundaries.
 */

export interface LoadedChunkState {
	manifest: ChunkManifestEntry[];
	total: number;
	messageVersion: number;
	/** Contiguous, seq-ascending top-level messages currently in memory. */
	messages: TreeMessage[];
	minLoadedSeq: number | null;
	maxLoadedSeq: number | null;
	hasOlder: boolean;
	hasNewer: boolean;
}

const INITIAL_CHUNK_COUNT = 7; // center ±3

export function useNarratorChunks(narratorId: string) {
	const [state, setState] = useState<LoadedChunkState>({
		manifest: [],
		total: 0,
		messageVersion: 0,
		messages: [],
		minLoadedSeq: null,
		maxLoadedSeq: null,
		hasOlder: false,
		hasNewer: false,
	});
	const [loading, setLoading] = useState(true);
	const loadingOlderRef = useRef(false);
	const loadingNewerRef = useRef(false);

	// Initial load: manifest + tail window.
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		(async () => {
			const [manifest, range] = await Promise.all([
				api.getChunkManifest(narratorId),
				api.getNarratorChunks(narratorId, { direction: "older", count: INITIAL_CHUNK_COUNT }),
			]);
			if (cancelled) return;
			setState({
				manifest: manifest.unchanged ? [] : manifest.chunks,
				total: manifest.unchanged ? 0 : manifest.total,
				messageVersion: range.messageVersion,
				messages: range.messages,
				minLoadedSeq: range.minSeq,
				maxLoadedSeq: range.maxSeq,
				hasOlder: range.hasOlder,
				hasNewer: false, // tail window — nothing newer
			});
			setLoading(false);
		})().catch(() => {
			if (!cancelled) setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [narratorId]);

	const loadOlder = useCallback(async () => {
		if (loadingOlderRef.current) return;
		const fromSeq = state.minLoadedSeq;
		if (fromSeq == null || !state.hasOlder) return;
		loadingOlderRef.current = true;
		try {
			const range = await api.getNarratorChunks(narratorId, {
				direction: "older",
				fromSeq,
				count: 3,
			});
			setState((prev) => {
				// Prepend, dedupe by id.
				const existingIds = new Set(prev.messages.map((m) => m.id));
				const incoming = range.messages.filter((m) => !existingIds.has(m.id));
				return {
					...prev,
					messages: [...incoming, ...prev.messages],
					minLoadedSeq: range.minSeq ?? prev.minLoadedSeq,
					hasOlder: range.hasOlder,
				};
			});
		} finally {
			loadingOlderRef.current = false;
		}
	}, [narratorId, state.minLoadedSeq, state.hasOlder]);

	const loadNewer = useCallback(async () => {
		if (loadingNewerRef.current) return;
		const fromSeq = state.maxLoadedSeq;
		if (fromSeq == null || !state.hasNewer) return;
		loadingNewerRef.current = true;
		try {
			const range = await api.getNarratorChunks(narratorId, {
				direction: "newer",
				fromSeq,
				count: 3,
			});
			setState((prev) => {
				const existingIds = new Set(prev.messages.map((m) => m.id));
				const incoming = range.messages.filter((m) => !existingIds.has(m.id));
				return {
					...prev,
					messages: [...prev.messages, ...incoming],
					maxLoadedSeq: range.maxSeq ?? prev.maxLoadedSeq,
					hasNewer: range.hasNewer,
				};
			});
		} finally {
			loadingNewerRef.current = false;
		}
	}, [narratorId, state.maxLoadedSeq, state.hasNewer]);

	return { state, loading, loadOlder, loadNewer };
}
