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

export interface SeqChunkRange {
	firstSeq: number;
	lastSeq: number;
	count: number;
}

/**
 * Estimate a centered scrollTop for a message seq within a chunk.
 *
 * Jumping to the chunk's first pixel creates a visible two-step motion (chunk
 * start first, exact message later). This estimates the seq's relative position
 * inside the chunk so the first programmatic scroll lands near the target before
 * the DOM node exists; a later scrollIntoView only performs a small correction.
 */
export function estimateSeqCenteredScrollTop(
	prefix: number[],
	chunkIndex: number,
	chunk: SeqChunkRange,
	seq: number,
	clientHeight: number,
): number {
	const chunkTop = prefix[chunkIndex] ?? 0;
	const chunkBottom = prefix[chunkIndex + 1] ?? chunkTop;
	const chunkHeight = Math.max(0, chunkBottom - chunkTop);
	if (chunkHeight <= 0) return Math.max(0, chunkTop - clientHeight / 2);

	const firstSeq = Math.min(chunk.firstSeq, chunk.lastSeq);
	const lastSeq = Math.max(chunk.firstSeq, chunk.lastSeq);
	const clampedSeq = Math.max(firstSeq, Math.min(lastSeq, seq));
	const seqSpan = Math.max(1, lastSeq - firstSeq + 1);
	const rawRatio =
		chunk.count <= 1 ? 0.5 : (clampedSeq - firstSeq + 0.5) / Math.max(seqSpan, chunk.count);
	const ratio = Math.max(0, Math.min(1, rawRatio));
	return Math.max(0, chunkTop + chunkHeight * ratio - clientHeight / 2);
}

/**
 * What the (rAF-throttled, direction-agnostic) scroll handler should do, given
 * only the distance from the bottom and the current pinned state.
 *
 * Deliberate user scroll-ups are NOT handled here — they are detached
 * synchronously in the wheel/touch/key event handlers so the follow loop stops
 * fighting the user immediately (otherwise the user "can't scroll"). This
 * handler only covers the two no-direction cases:
 *  - `"pin"`     — the view is at/again-near the bottom; (re)attach to the tail.
 *  - `"refollow"`— still pinned but the distance grew (streaming output / async
 *                  height re-measure / scroll anchoring pushed us off the
 *                  bottom); keep following instead of silently detaching.
 *  - `"none"`    — already detached; nothing to do (a real scroll-up already
 *                  detached us via the input handlers).
 */
export type BottomPinAction = "pin" | "refollow" | "none";

export function resolveBottomPinAction(
	distanceFromBottom: number,
	pinned: boolean,
): BottomPinAction {
	// No height threshold: detached views only re-pin at the real bottom, while
	// pinned views always keep following any positive bottom gap.
	if (distanceFromBottom <= 0) return "pin";
	return pinned ? "refollow" : "none";
}
