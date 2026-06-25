/**
 * Pure manifest-window helpers for the chunk-virtualized message list.
 *
 * Kept dependency-free (no React / UI imports) so the windowing / reconcile
 * boundary logic is unit testable in isolation under `bun test` (which cannot
 * load the full component tree, e.g. i18n's import.meta.glob).
 */

import type { ChunkManifestEntry, ChunkManifestTuple } from "../../lib/api";

/** Expand a compact wire tuple [id, firstSeq, lastSeq, count] into an entry. */
export function decodeManifestTuples(tuples: ChunkManifestTuple[]): ChunkManifestEntry[] {
	const out = new Array<ChunkManifestEntry>(tuples.length);
	for (let i = 0; i < tuples.length; i++) {
		const t = tuples[i];
		out[i] = { id: t[0], firstSeq: t[1], lastSeq: t[2], count: t[3] };
	}
	return out;
}

export function sameManifestEntry(
	a: ChunkManifestEntry | undefined,
	b: ChunkManifestEntry | undefined,
) {
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
 * First manifest index (into `next`) that may need content reload, comparing two
 * tail-anchored windows. The manifest does not carry a per-chunk content hash,
 * so when a tuple changes we step back one chunk to cover within-chunk
 * insert/delete cases whose first id stayed the same but whose tail was pulled
 * from the next chunk.
 *
 * Both windows are anchored at the newest chunk (the tail), so we walk backward
 * from the tail: the first divergence marks the boundary. Extra OLDER chunks at
 * the front of `next` (window expansion) are not "dirty" — they simply have no
 * prior loaded content and will be fetched on demand. Returns null when the
 * overlapping tail region is structurally identical.
 */
export function firstDirtyManifestIndex(
	prev: ChunkManifestEntry[],
	next: ChunkManifestEntry[],
): number | null {
	const overlap = Math.min(prev.length, next.length);
	for (let k = 1; k <= overlap; k++) {
		const pi = prev.length - k;
		const ni = next.length - k;
		if (!sameManifestEntry(prev[pi], next[ni])) {
			return Math.max(0, ni - 1);
		}
	}
	// Overlapping tail region matches. If `next` lost chunks relative to `prev`
	// (history shrank), treat the new front as the reload boundary; otherwise
	// nothing in the overlap changed.
	if (next.length < prev.length) return 0;
	return null;
}
