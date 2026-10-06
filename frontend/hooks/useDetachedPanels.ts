/**
 * Server-persisted list of panels torn out of a chapter node's dock.
 *
 * Same transport discipline as `useChapterDockLayout`, and for the same reason:
 * the list arrives asynchronously, so a caller that acted before it landed would
 * write an empty list back and wipe the user's detached panels. Callers must gate
 * on `isReady`, and a failed read must never be read as "nothing is detached".
 *
 * Unlike the dock layout this list is also read by the canvas itself (to render the
 * nodes), so mutations go through explicit helpers that return the next list; the
 * hook owns debouncing and de-duplicating the writes.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
	type DetachedNode,
	parseDetachedNodes,
	serializeDetachedNodes,
} from "../components/graph/dock/detached-panels";
import { api } from "../lib/api";

const SAVE_DEBOUNCE_MS = 400;

const EMPTY: readonly DetachedNode[] = [];

export interface DetachedPanelsHandle {
	/** The chapter's detached canvas nodes; each hosts one or more tool panels. */
	panels: readonly DetachedNode[];
	/** True once the list is known; the canvas must not write before this. */
	isReady: boolean;
	isError: boolean;
	/**
	 * Replace the list. Updates the query cache immediately (the canvas renders
	 * from it) and schedules a debounced write.
	 */
	setPanels: (next: DetachedNode[]) => void;
}

export function useDetachedPanels(chapterId: string): DetachedPanelsHandle {
	const qc = useQueryClient();
	const queryKey = ["chapterDetachedPanels", chapterId] as const;

	const query = useQuery({
		queryKey,
		queryFn: () => api.getChapterDetachedPanels(chapterId),
		enabled: !!chapterId,
		// Only local interaction changes this list, so there is nothing to poll for,
		// and a refetch landing mid-drag would fight the user's own arrangement.
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});

	const mutation = useMutation({
		mutationFn: (panels: string | null) => api.updateChapterDetachedPanels(chapterId, panels),
		onError: (error) => {
			// A dropped write is not worth interrupting canvas work over; the next
			// mutation retries. Logged rather than notified.
			console.warn("Failed to persist detached panels", chapterId, error);
		},
	});
	const mutateRef = useRef(mutation.mutate);
	mutateRef.current = mutation.mutate;

	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastSentRef = useRef<string | null | undefined>(undefined);
	const pendingRef = useRef<string | null | undefined>(undefined);

	const flush = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		const pending = pendingRef.current;
		pendingRef.current = undefined;
		if (pending === undefined || pending === lastSentRef.current) return;
		lastSentRef.current = pending;
		mutateRef.current(pending);
	}, []);

	const setPanels = useCallback(
		(next: DetachedNode[]) => {
			const serialized = serializeDetachedNodes(next);
			if (serialized === null) {
				// Over the size cap: the request would be rejected, so drop the write
				// rather than fire it. The in-memory list is left untouched so the UI
				// does not claim a change that was not stored.
				console.warn("Detached panel list too large to persist", chapterId);
				return;
			}
			// The canvas renders from the cache, so update it first for an immediate
			// response, then persist.
			qc.setQueryData(queryKey, { panels: serialized });
			if (serialized === lastSentRef.current) return;
			pendingRef.current = serialized;
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
		},
		[chapterId, flush, qc, queryKey],
	);

	// Flush on unmount (canvas left, project switched) so the last arrangement is
	// not lost inside the debounce window.
	const flushRef = useRef(flush);
	flushRef.current = flush;
	useEffect(() => {
		return () => flushRef.current();
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on chapterId change
	useEffect(() => {
		lastSentRef.current = undefined;
		pendingRef.current = undefined;
	}, [chapterId]);

	// Memoized on the RAW string: parsing returns a fresh array every call, and an
	// unstable reference here would invalidate the canvas's node memoization on
	// every render (and could feed a render loop through its node-building effects).
	const raw = query.isSuccess ? (query.data?.panels ?? null) : undefined;
	const panels = useMemo(() => (raw === undefined ? EMPTY : parseDetachedNodes(raw)), [raw]);

	return {
		panels,
		isReady: query.isSuccess,
		isError: query.isError,
		setPanels,
	};
}
