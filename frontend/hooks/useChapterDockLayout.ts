/**
 * Server-persisted dockview layout for a graph node's embedded surface.
 *
 * Read once per node, written back debounced. Two properties matter more than
 * they do for the focus page's localStorage equivalent, because this transport is
 * asynchronous:
 *
 *  1. The caller MUST NOT mount its Dockview until `isSuccess` — otherwise the
 *     surface builds a default layout before the saved one arrives, and the
 *     resulting layout-change event overwrites the user's saved panels with the
 *     default. `ChapterNodeDock` renders a skeleton until then.
 *  2. A failed read must NOT be treated as "no layout". Returning null on error
 *     is exactly the path that would clobber good data with a default, so the
 *     query's error state is surfaced and the surface stays unmounted.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import type { SerializedDockview } from "dockview-react";
import { useCallback, useEffect, useRef } from "react";
import { parseChapterDockLayout } from "../components/graph/dock/graph-node-dock-layout";
import { api } from "../lib/api";

/** Matches the focus dock's persistence cadence. */
const SAVE_DEBOUNCE_MS = 400;

export interface ChapterDockLayoutHandle {
	/** Parsed layout, or null when this node has never been customized. */
	layout: SerializedDockview | null;
	/** True once the layout is known and a surface may be mounted. */
	isReady: boolean;
	isError: boolean;
	retry: () => void;
	/** Queue a debounced write. Identical consecutive payloads are dropped. */
	save: (serialized: string | null) => void;
}

export function useChapterDockLayout(chapterId: string): ChapterDockLayoutHandle {
	const query = useQuery({
		queryKey: ["chapterDockLayout", chapterId],
		queryFn: () => api.getChapterDockLayout(chapterId),
		enabled: !!chapterId,
		// The layout only changes through local interaction on this surface, so
		// there is nothing to poll for, and a refetch that returned an older value
		// mid-edit would fight the user's live layout.
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});

	const mutation = useMutation({
		mutationFn: (layout: string | null) => api.updateChapterDockLayout(chapterId, layout),
		// Deliberately no query invalidation: the live Dockview IS the truth here.
		// Refetching would only risk pulling the surface back to a stale snapshot.
		onError: (error) => {
			// A dropped layout save is not worth interrupting canvas work with a
			// notification; the next layout change retries anyway.
			console.warn("Failed to persist chapter dock layout", chapterId, error);
		},
	});

	const mutateRef = useRef(mutation.mutate);
	mutateRef.current = mutation.mutate;

	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** Last payload handed to the server, to skip equivalent repeat writes. */
	const lastSentRef = useRef<string | null | undefined>(undefined);
	/** Payload waiting on the debounce timer (flushed on unmount). */
	const pendingRef = useRef<string | null | undefined>(undefined);

	const flush = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		const pending = pendingRef.current;
		pendingRef.current = undefined;
		if (pending === undefined) return;
		if (pending === lastSentRef.current) return;
		lastSentRef.current = pending;
		mutateRef.current(pending);
	}, []);

	const save = useCallback(
		(serialized: string | null) => {
			// Dragging a sash emits a stream of layout-change events that serialize
			// to the same string; sending each one would be pure noise.
			if (serialized === lastSentRef.current) return;
			pendingRef.current = serialized;
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
		},
		[flush],
	);

	// Flush on unmount (node collapsed, canvas left) so the final arrangement is
	// not lost inside the debounce window. `flush` is stable, and the refs it
	// reads hold the latest values.
	const flushRef = useRef(flush);
	flushRef.current = flush;
	useEffect(() => {
		return () => flushRef.current();
	}, []);

	// Reset the send-dedup state when the hook is pointed at another chapter, so
	// the new node's first write is never mistaken for a duplicate of the old one's.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on chapterId change
	useEffect(() => {
		lastSentRef.current = undefined;
		pendingRef.current = undefined;
	}, [chapterId]);

	const refetch = query.refetch;
	const retry = useCallback(() => {
		void refetch();
	}, [refetch]);

	return {
		layout: query.isSuccess ? parseChapterDockLayout(query.data?.layout ?? null) : null,
		isReady: query.isSuccess,
		isError: query.isError,
		retry,
		save,
	};
}
