/**
 * Pure scroll-coordinate helpers for the chunk-virtualized message list.
 *
 * Kept dependency-free (no React / UI imports) so the mapping logic is unit
 * testable in isolation under `bun test` (which cannot load the full component
 * tree, e.g. i18n's import.meta.glob).
 */

/** Distance (px) from the very top/bottom within which the scroll handler force-
 * centers on the first/last chunk regardless of estimated-height drift, so the
 * earliest (and latest) messages are always reachable. */
export const EDGE_CLAMP_THRESHOLD = 4;

/**
 * Map a scroll position to the chunk index that should become the mounted-window
 * center. Binary-searches the cumulative-height prefix for the chunk under the
 * viewport center, then applies deterministic edge clamping: within
 * `edgeThreshold` of the top → first chunk, of the bottom → last chunk.
 *
 * Edge clamping decouples "can the user reach the very first / last messages"
 * from estimated-height accuracy: tall chunks (large tool outputs, subagent
 * cards) make unmeasured top chunks' height estimates too small, so the raw
 * binary search can map scrollTop≈0 to a chunk several indices in, leaving the
 * earliest chunks permanently unmounted and unreachable.
 *
 * `prefix` has length chunkCount+1 (prefix[0]=0, prefix[i+1]=prefix[i]+height_i).
 */
export function resolveScrollTargetIndex(
	prefix: number[],
	chunkCount: number,
	scrollTop: number,
	clientHeight: number,
	scrollHeight: number,
	edgeThreshold = EDGE_CLAMP_THRESHOLD,
): number {
	if (chunkCount <= 0) return 0;
	const viewportCenter = scrollTop + clientHeight / 2;
	let lo = 0;
	let hi = chunkCount - 1;
	let target = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (prefix[mid] <= viewportCenter) {
			target = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	if (scrollTop <= edgeThreshold) return 0;
	const distanceFromBottom = Math.max(0, scrollHeight - scrollTop - clientHeight);
	if (distanceFromBottom <= edgeThreshold) return chunkCount - 1;
	return target;
}
