/**
 * vlist-head-trim.ts — Decides when the loaded window may DROP its oldest
 * messages, so a session that keeps appending does not grow without bound.
 *
 * Why this exists
 * ---------------
 * The exact list virtualizes its DOM (only `[visible.start, visible.end)` plus an
 * overscan band is mounted), but the DATA layer never shrank: within one narrator
 * session `input.messages` only ever grew, and every streaming delta rebuilds the
 * WHOLE window (segment → group → adapt → measure scan). Measured cost of one
 * streaming frame against window size, with the measure cache warm:
 *
 *     90 msgs → 3.4ms   900 → 5.3ms   1800 → 10.6ms   3600 → 20.8ms   6000 → 35.7ms
 *
 * Linear, unbounded, and that is pure computation — before React reconcile, style
 * recalc and paint. The build products for a 1200-message window also held ~157MB
 * RSS. Trimming the head bounds both curves.
 *
 * Why the trimmed history is not lost
 * -----------------------------------
 * Exactly the contract `pretext-document-cache.ts`'s `truncateInput` already
 * relies on: the loaded window is tail-anchored, so cutting the head is
 * recoverable as long as `oldestLoadedSeq` retreats to the oldest SURVIVING seq
 * and `hasPrev` is forced true. Upward pagination then re-fetches what was
 * dropped. Getting the cursor wrong is the one way to lose history for real — see
 * `trimLoadedHead`.
 *
 * Pure: no React, no DOM, no timers, no network.
 */

/** The subset of a message this module reads. */
export interface TrimCandidate {
	id?: unknown;
	seq?: unknown;
}

/**
 * Messages kept after a trim.
 *
 * Sized so the retained window stays comfortably cheap to rebuild (≈5ms per
 * streaming frame at this count, measured) while still holding several screens of
 * scrollback above the viewport.
 */
export const TRIM_TARGET_MESSAGES = 800;

/**
 * Message count above which a trim is considered at all.
 *
 * Deliberately well above {@link TRIM_TARGET_MESSAGES}: the gap is HYSTERESIS. If
 * the trigger equalled the target, every single append would sit exactly at the
 * boundary and trim one message, paying a full rebuild per message forever. With
 * the gap, one trim buys ~400 quiet appends.
 */
export const TRIM_TRIGGER_MESSAGES = 1200;

/**
 * How many viewport-plus-overscan bands of canvas must remain after a trim.
 *
 * This is the guard against the shell's first-screen fill loop, NOT a cosmetic
 * margin. That effect re-fetches older pages whenever
 * `totalHeight <= viewportHeight + overscan` while pinned to the bottom, so a trim
 * that cut the canvas near that threshold would be answered by an immediate
 * re-fetch, which grows it again, which lets the next trim fire: an endless
 * trim/refetch loop, each round issuing a network request. Requiring the survivors
 * to still cover several bands keeps the result far from the trigger.
 */
export const TRIM_KEEP_HEIGHT_FACTOR = 4;

/**
 * How long after a trim the AUTOMATIC first-screen fill loop stands down (ms).
 *
 * Secondary guard to {@link TRIM_KEEP_HEIGHT_FACTOR}, covering the case where the
 * rebuilt canvas comes out shorter than the average-height estimate predicted. A
 * reader's own upward scroll and the manual load button are never gated.
 */
export const TRIM_FILL_COOLDOWN_MS = 500;

/**
 * The clock both sides of the cooldown must read.
 *
 * Shared rather than each site calling its own `performance.now()` / `Date.now()`:
 * the two epochs differ by ~13 orders of magnitude, so mixing them makes the
 * comparison either always true or always false — and either way silently.
 */
export function trimClockNow(): number {
	return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Whether the "live row just cleared" edge may run a trim now, and what the edge
 * bookkeeping should become.
 *
 * The shell evaluates trimming when the streaming row disappears, because that used
 * to mean exactly one thing: the turn ended and the session is momentarily idle.
 * It no longer does. The per-block hand-off (`streaming-block-supersede.ts`) also
 * empties the row MID-turn — the moment a reconnect catch-up delivers the partial
 * message whose blocks the row was still holding.
 *
 * A trim at that point is the failure mode {@link TrimRejection} `"streaming"` guards
 * against, except invisible to it: by then the row is already gone, so
 * `hasStreamingRow` is false, and with a pinned reader and a long window nothing else
 * declines. Keep the active turn's loaded evidence and scroll anchors stable instead
 * of treating a checkpoint as an idle maintenance window.
 *
 * So the intent ("the turn ended") is stated directly via `isActive` instead of being
 * inferred from the row. The pending edge is DEFERRED rather than consumed: a session
 * whose rows always clear mid-turn must still trim eventually, so the caller keeps its
 * "had a row" bookkeeping until an edge actually fires.
 */
export function resolveStreamingClearedTrimEdge(input: {
	/** The caller's bookkeeping: a row was published on the previous evaluation. */
	hadStreamingRow: boolean;
	/** A row is published now. */
	hasStreamingRow: boolean;
	/** The narrator is working/waiting, i.e. the turn has NOT ended. */
	isActive: boolean;
}): { fire: boolean; nextHadStreamingRow: boolean } {
	const justCleared = input.hadStreamingRow && !input.hasStreamingRow;
	// Mid-turn clear: hold the edge open so a later evaluation (once idle) can use it.
	if (justCleared && input.isActive) return { fire: false, nextHadStreamingRow: true };
	return { fire: justCleared, nextHadStreamingRow: input.hasStreamingRow };
}

export type TrimRejection =
	/** The reader has scrolled up; rows above the viewport are being read. */
	| "not-pinned"
	/** A live streaming row is published; defer head maintenance until idle. */
	| "streaming"
	/** Not enough messages, or not enough canvas, to trim safely. */
	| "below-threshold"
	/** The computed drop count came out at zero. */
	| "nothing-to-trim"
	/**
	 * A message that must stay loaded (an open inline editor's draft, the original
	 * content modal, an active selection) falls inside the range that would be cut.
	 */
	| "protected-in-range";

export interface HeadTrimDecisionInput {
	/** Loaded top-level messages, oldest first. */
	messages: readonly TrimCandidate[];
	/** Current canvas height (px). */
	totalHeight: number;
	viewportHeight: number;
	/** The shell's mounted-window overscan band (px). */
	overscan: number;
	/** The reader is at the bottom, so rows above the viewport are not being read. */
	pinnedToBottom: boolean;
	/**
	 * True while a live streaming row is published. Checked HERE rather than at the
	 * call site so no caller can forget it — the failure is silent output loss.
	 */
	hasStreamingRow: boolean;
	/** Messages that must not be dropped (editor draft, modal, active selection). */
	protectedMessageIds?: readonly string[];
	/** Override for tests. */
	targetMessages?: number;
	/** Override for tests. */
	triggerMessages?: number;
	/** Override for tests. */
	keepHeightFactor?: number;
}

export interface HeadTrimDecision {
	trim: boolean;
	/** Messages to drop from the head (0 when `trim` is false). */
	dropCount: number;
	reason?: TrimRejection;
}

function reject(reason: TrimRejection): HeadTrimDecision {
	return { trim: false, dropCount: 0, reason };
}

/**
 * Decide whether — and by how much — the loaded window's head may be dropped.
 *
 * The count and the pixel conditions must BOTH hold, and the pixel one is
 * evaluated against the survivors rather than the current canvas: a window can
 * hold 2000 short messages that together barely fill two screens, and trimming
 * that to 800 would leave a canvas the fill loop immediately re-grows.
 *
 * Height is apportioned by average row height rather than by real geometry. That
 * is an approximation on purpose: the caller has the exact per-item layout, but
 * feeding it in would couple this decision to the layout index for a bound whose
 * only job is to stay FAR from a threshold. The estimate is conservative in the
 * direction that matters — it can decline a trim that would have been safe, never
 * allow one that is not, because declining costs only a delay.
 */
export function resolveHeadTrim(input: HeadTrimDecisionInput): HeadTrimDecision {
	if (input.hasStreamingRow) return reject("streaming");
	if (!input.pinnedToBottom) return reject("not-pinned");

	const target = Math.max(1, Math.trunc(input.targetMessages ?? TRIM_TARGET_MESSAGES));
	const trigger = Math.max(target, Math.trunc(input.triggerMessages ?? TRIM_TRIGGER_MESSAGES));
	const total = input.messages.length;
	if (total <= trigger) return reject("below-threshold");

	const dropCount = total - target;
	if (dropCount <= 0) return reject("nothing-to-trim");

	// The survivors must still cover several viewport bands (see the constant).
	const factor = Math.max(1, input.keepHeightFactor ?? TRIM_KEEP_HEIGHT_FACTOR);
	const band = Math.max(0, input.viewportHeight) + Math.max(0, input.overscan);
	if (band > 0) {
		const averageRowHeight = input.totalHeight / total;
		const keptHeight = averageRowHeight * target;
		if (keptHeight <= band * factor) return reject("below-threshold");
	}

	const protectedIds = input.protectedMessageIds;
	if (protectedIds && protectedIds.length > 0) {
		const guarded = new Set(protectedIds.filter((id) => typeof id === "string" && id.length > 0));
		if (guarded.size > 0) {
			for (let index = 0; index < dropCount; index++) {
				const id = input.messages[index]?.id;
				if (typeof id === "string" && guarded.has(id)) return reject("protected-in-range");
			}
		}
	}

	return { trim: true, dropCount };
}

/**
 * Drop `dropCount` messages off the head.
 *
 * `oldestKeptSeq` is what `oldestLoadedSeq` MUST become. This is the opposite of
 * what `removeLoadedMessages` does, and the difference is load-bearing: a deletion
 * does not change what the server holds, so its cursor ("I have fetched everything
 * from seq X up") stays put. A trim gives fetched history BACK, so leaving the
 * cursor forward would make the next upward page start below the gap it just
 * created — a silent hole in history that no later fetch repairs.
 *
 * Returns the same array identity when nothing is dropped, so a caller can skip
 * the rebuild by identity.
 */
export function trimLoadedHead<T extends TrimCandidate>(
	messages: readonly T[],
	dropCount: number,
): { messages: readonly T[]; oldestKeptSeq: number | null } {
	const drop = Math.trunc(dropCount);
	if (drop <= 0) return { messages, oldestKeptSeq: oldestSeqOf(messages) };
	if (drop >= messages.length) {
		// Never produce an empty document: the shell's load path owns that state.
		return { messages, oldestKeptSeq: oldestSeqOf(messages) };
	}
	const kept = messages.slice(drop);
	return { messages: kept, oldestKeptSeq: oldestSeqOf(kept) };
}

function oldestSeqOf(messages: readonly TrimCandidate[]): number | null {
	let min: number | null = null;
	for (const message of messages) {
		const seq = message.seq;
		if (typeof seq !== "number" || !Number.isFinite(seq)) continue;
		if (min == null || seq < min) min = seq;
	}
	return min;
}

/**
 * Delete every entry whose key is not in `liveKeys`, across several caches.
 *
 * The shell keeps per-row handler caches keyed by `spec.key` (stable toggles,
 * height reporters, …) that are only cleared on a narrator switch, so a trim would
 * leave one dead closure per dropped row and the map would grow for the whole
 * session.
 *
 * Deliberately expressed as "keep what is still alive" rather than "delete what
 * was dropped". Spec keys are DERIVED and take several shapes (`tool-<id>`,
 * `<msgId>-b3`, `activity-t:<toolUseId>`, `toolrun-summary-…`; see
 * `buildSourceResolver`), so reconstructing the dropped keys from message ids
 * would mean reimplementing that derivation and drifting from it. The surviving
 * manifest already enumerates every live key, which is the same direction
 * `pruneHeightOverrides` takes.
 *
 * Returns the number of entries removed, so a test can assert the sweep happened
 * rather than trusting it.
 */
export function retainKeysInPlace(
	caches: readonly Pick<Map<string, unknown>, "size" | "keys" | "delete">[],
	liveKeys: ReadonlySet<string>,
): number {
	let removed = 0;
	for (const cache of caches) {
		if (cache.size === 0) continue;
		for (const key of [...cache.keys()]) {
			if (liveKeys.has(key)) continue;
			cache.delete(key);
			removed++;
		}
	}
	return removed;
}
