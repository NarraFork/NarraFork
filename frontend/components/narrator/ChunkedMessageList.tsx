import { Box } from "@mantine/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderTreeMessages } from "./MessageRenderer";
import type { NarratorMsg, PermissionCallbacks } from "./narrator-panel-types";
import { useNarratorChunks } from "./useNarratorChunks";

/**
 * Phase 0 verification skeleton for the chunk-virtualized message list.
 *
 * Goal: measure (1) manifest query cost and (2) DOM node count + browser scroll
 * anchoring behavior when mounting ±3 chunks (worst case: chunks with large
 * subagent trees), across browsers including iOS Safari.
 *
 * Deliberately minimal: native scrollbar, no custom scrollbar, no
 * chunks_dirty reconciliation, no safe-boundary segmentation. Render chunks
 * are derived by slicing the contiguous loaded messages on CHUNK_SIZE
 * boundaries from the manifest's seq ranges.
 *
 * Three-section layout:
 *   [top spacer: Σ heights of unmounted chunks above]
 *   [mounted region: real renderTreeMessages output]
 *   [bottom spacer: Σ heights of unmounted chunks below]
 *
 * Position stability relies on the browser's native scroll anchoring; mounting
 * /unmounting always happens ≥3 chunks away from the viewport, so the anchor
 * node stays visible and the browser compensates for height changes above it.
 */

const CHUNK_SIZE = 20;
const PRELOAD_DISTANCE = 3;
const ESTIMATED_CHUNK_HEIGHT = 20 * 120; // 20 msgs × ~120px rough seed

interface RenderChunk {
	id: string;
	startSeq: number;
	messages: NarratorMsg[];
}

interface ChunkedMessageListProps {
	narratorId: string;
	permCb: PermissionCallbacks;
	hasChapter?: boolean;
}

export function ChunkedMessageList({ narratorId, permCb, hasChapter }: ChunkedMessageListProps) {
	const { state, loadOlder, loadNewer } = useNarratorChunks(narratorId);
	const heightsRef = useRef<Map<string, number>>(new Map());
	const [, forceRender] = useState(0);
	const bumpRender = useCallback(() => forceRender((n) => n + 1), []);

	// Group the contiguous loaded messages into render chunks on CHUNK_SIZE
	// boundaries. Chunk id = first message id (matches manifest id semantics).
	const chunks = useMemo<RenderChunk[]>(() => {
		const result: RenderChunk[] = [];
		const msgs = state.messages;
		for (let i = 0; i < msgs.length; i += CHUNK_SIZE) {
			const slice = msgs.slice(i, i + CHUNK_SIZE);
			if (slice.length === 0) continue;
			result.push({
				id: slice[0].id,
				startSeq: slice[0].seq ?? i,
				messages: slice,
			});
		}
		return result;
	}, [state.messages]);

	// Which chunk indices are currently mounted (real DOM). Center is the last
	// chunk initially (tail); preload ±PRELOAD_DISTANCE around the center.
	const [centerIndex, setCenterIndex] = useState(0);
	useEffect(() => {
		// On first load, center on the tail (last chunk).
		if (chunks.length > 0) setCenterIndex(chunks.length - 1);
	}, [chunks.length]);

	const mountedRange = useMemo(() => {
		const start = Math.max(0, centerIndex - PRELOAD_DISTANCE);
		const end = Math.min(chunks.length - 1, centerIndex + PRELOAD_DISTANCE);
		return { start, end };
	}, [centerIndex, chunks.length]);

	const estimateHeight = useCallback((chunk: RenderChunk) => {
		const measured = heightsRef.current.get(chunk.id);
		if (measured != null) return measured;
		return (chunk.messages.length / CHUNK_SIZE) * ESTIMATED_CHUNK_HEIGHT;
	}, []);

	const topSpacer = useMemo(() => {
		let h = 0;
		for (let i = 0; i < mountedRange.start; i++) h += estimateHeight(chunks[i]);
		return h;
	}, [chunks, mountedRange.start, estimateHeight]);

	const bottomSpacer = useMemo(() => {
		let h = 0;
		for (let i = mountedRange.end + 1; i < chunks.length; i++) h += estimateHeight(chunks[i]);
		return h;
	}, [chunks, mountedRange.end, estimateHeight]);

	// IntersectionObserver sentinels: observe each mounted chunk; when a chunk
	// near the mounted edge becomes visible, shift the center and load data.
	const scrollerRef = useRef<HTMLDivElement>(null);
	const sentinelRefs = useRef<Map<number, HTMLDivElement>>(new Map());

	useEffect(() => {
		const root = scrollerRef.current;
		if (!root) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const idxAttr = (entry.target as HTMLElement).dataset.chunkIndex;
					if (idxAttr == null) continue;
					const idx = Number.parseInt(idxAttr, 10);
					if (Number.isNaN(idx)) continue;
					// Recenter toward the visible chunk so the mounted window follows.
					setCenterIndex((prev) => (prev === idx ? prev : idx));
					// Extend loaded data when approaching either end.
					if (idx <= mountedRange.start + 1 && state.hasOlder) loadOlder();
					if (idx >= mountedRange.end - 1 && state.hasNewer) loadNewer();
				}
			},
			{ root, rootMargin: "200px 0px 200px 0px", threshold: 0 },
		);
		for (const el of sentinelRefs.current.values()) observer.observe(el);
		return () => observer.disconnect();
	}, [mountedRange.start, mountedRange.end, state.hasOlder, state.hasNewer, loadOlder, loadNewer]);

	const measureChunk = useCallback(
		(chunkId: string, node: HTMLDivElement | null) => {
			if (!node) return;
			const h = node.getBoundingClientRect().height;
			if (h > 0 && heightsRef.current.get(chunkId) !== h) {
				heightsRef.current.set(chunkId, h);
				bumpRender();
			}
		},
		[bumpRender],
	);

	return (
		<Box
			ref={scrollerRef}
			style={{ height: "100%", overflowY: "auto", overflowX: "hidden", overflowAnchor: "auto" }}
		>
			{topSpacer > 0 && <div style={{ height: topSpacer }} aria-hidden />}
			{chunks.map((chunk, idx) => {
				const mounted = idx >= mountedRange.start && idx <= mountedRange.end;
				if (!mounted) {
					return <div key={chunk.id} style={{ height: estimateHeight(chunk) }} aria-hidden />;
				}
				const { elements } = renderTreeMessages(
					chunk.messages,
					narratorId,
					undefined,
					null,
					permCb,
					undefined,
					false,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					hasChapter,
				);
				return (
					<div
						key={chunk.id}
						data-chunk-index={idx}
						ref={(node) => {
							if (node) sentinelRefs.current.set(idx, node);
							else sentinelRefs.current.delete(idx);
							measureChunk(chunk.id, node);
						}}
					>
						{elements}
					</div>
				);
			})}
			{bottomSpacer > 0 && <div style={{ height: bottomSpacer }} aria-hidden />}
		</Box>
	);
}
