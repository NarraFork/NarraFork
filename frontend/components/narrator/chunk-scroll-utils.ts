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

export function resolveMessageScrollerOverscrollBehavior(
	isMobileViewport: boolean | undefined,
): "contain" | undefined {
	return isMobileViewport ? "contain" : undefined;
}

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

export interface ForegroundBottomResumeIntent {
	/** Capture the first state observed while the page is leaving the foreground. */
	suspend(pinned: boolean, atBottom: boolean): void;
	/** Consume the captured state once. True means tail-follow should be restored. */
	resume(): boolean;
}

/**
 * Preserve the user's bottom-follow intent across a browser foreground cycle.
 *
 * Browsers commonly emit blur, visibilitychange and touch events for the same
 * app/tab switch. Only the first suspend signal is authoritative: a later touch
 * detach from the OS switch gesture must not overwrite an already-captured
 * pinned state. Duplicate focus/pageshow signals consume the intent only once.
 */
export function createForegroundBottomResumeIntent(): ForegroundBottomResumeIntent {
	let suspended = false;
	let restoreBottom = false;
	return {
		suspend(pinned, atBottom) {
			if (suspended) return;
			suspended = true;
			restoreBottom = pinned || atBottom;
		},
		resume() {
			if (!suspended) return false;
			suspended = false;
			const shouldRestore = restoreBottom;
			restoreBottom = false;
			return shouldRestore;
		},
	};
}

/**
 * Chunks mounted/loaded on each side of the window centre on a desktop viewport.
 *
 * This is the band radius, so the window spans `radius * 2 + 1` chunks and, at
 * the server's 20 top-level messages per chunk, 7 chunks means up to 140 fully
 * rendered messages. Desktop absorbs that; a phone does not.
 */
export const DESKTOP_CHUNK_BAND_RADIUS = 3;

/**
 * Mobile band radius.
 *
 * Measured on an iPhone-class viewport (390x844, CPU throttled 4x) against a
 * 76.8k-message narrator: opening the page issued one manifest request plus a
 * `count=1` content request (20 messages, ~345KB) and then a *second* content
 * request for `count=3` (60 messages, ~750KB) purely to fill the desktop band —
 * ~1.1MB and 80 messages before the user touches anything. On a 390px-wide
 * viewport at most one chunk is visible, so the extra two chunks below the
 * centre are pure cost: they are parsed, rendered and measured on the main
 * thread during the worst part of first paint.
 *
 * 1 keeps a neighbour on each side, which is what makes short scrolls land on
 * mounted content instead of a spacer, so scrolling stays smooth while the
 * initial band drops from 7 chunks to 3.
 */
export const MOBILE_CHUNK_BAND_RADIUS = 1;

/**
 * Resolve the mount/load band radius for a viewport.
 *
 * Deliberately a single parameterized function rather than a mobile-specific
 * code path: the manual "load older" control regressed precisely because mobile
 * and desktop rendered through two different branches, so viewport differences
 * here are expressed as a *number* that one shared path consumes.
 *
 * `undefined` (viewport not yet known — `useMediaQuery` returns undefined on the
 * first render) resolves to the desktop radius so an unknown viewport never
 * silently degrades a desktop user's prefetch window; mobile detection commits
 * on the same first paint in practice, before any band request is issued.
 */
export function resolveChunkBandRadius(isMobileViewport: boolean | undefined): number {
	return isMobileViewport ? MOBILE_CHUNK_BAND_RADIUS : DESKTOP_CHUNK_BAND_RADIUS;
}

export const OLDER_HISTORY_INTENT_TIMEOUT_MS = 2_500;

/**
 * Resolve the persisted preference without briefly enabling auto-load while its
 * query is still pending. If the query has finished without data (for example a
 * request failure), fall back to the server/database default of enabled.
 */
export function resolveOlderHistoryAutoLoadEnabled(
	preference: boolean | undefined,
	preferenceLoading: boolean,
): boolean {
	return preference ?? !preferenceLoading;
}

export interface OlderHistoryAutoLoadInput {
	intentAt: number | null;
	now: number;
	autoLoadEnabled: boolean;
	hasOlder: boolean;
	expanding: boolean;
	atBottom: boolean;
	scrollTop: number;
	triggerPx: number;
	intentTimeoutMs?: number;
}

export interface OlderHistoryAutoLoadDecision {
	shouldLoad: boolean;
	/** Retained while the user is still travelling upward; cleared on expiry/bottom/load. */
	nextIntentAt: number | null;
}

/**
 * Decide whether a near-top scroll may expand older history. Scroll events alone
 * are insufficient: a recent explicit user gesture toward history is required.
 */
export function resolveOlderHistoryAutoLoad({
	intentAt,
	now,
	autoLoadEnabled,
	hasOlder,
	expanding,
	atBottom,
	scrollTop,
	triggerPx,
	intentTimeoutMs = OLDER_HISTORY_INTENT_TIMEOUT_MS,
}: OlderHistoryAutoLoadInput): OlderHistoryAutoLoadDecision {
	if (intentAt == null) return { shouldLoad: false, nextIntentAt: null };
	const intentAge = now - intentAt;
	if (intentAge < 0 || intentAge > intentTimeoutMs || atBottom) {
		return { shouldLoad: false, nextIntentAt: null };
	}
	if (!autoLoadEnabled || !hasOlder || expanding || scrollTop > triggerPx) {
		return { shouldLoad: false, nextIntentAt: intentAt };
	}
	return { shouldLoad: true, nextIntentAt: null };
}
