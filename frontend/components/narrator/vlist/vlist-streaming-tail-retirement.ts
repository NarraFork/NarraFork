/**
 * vlist-streaming-tail-retirement.ts — Decides WHEN the live streaming tail may
 * be discarded, so the hand-off to the persisted message has no blank frame.
 *
 * The flicker this fixes
 * ---------------------
 * The exact shell renders streaming output as an overlay below the stable canvas.
 * Originally the tail was cleared the instant the persisted assistant message
 * arrived, while the real card only appeared after a document refetch:
 *
 *   t1  message arrives → tail cleared          ← blank window opens
 *   t2  reload() issued
 *   t3  document commits → real card painted    ← blank window closes
 *
 * `t1..t3` is a whole HTTP round-trip of empty space. The fix is to keep the tail
 * alive until its replacement is actually present.
 *
 * Why the judgement is "is the message in the document" and NOT "has a commit
 * happened"
 * ---------------------------------------------------------------------------
 * A commit COUNTER would be wrong. Live lifecycle patches (tool completion,
 * reflection resolution — see useVListLivePatches) also commit layouts, and one
 * of those firing mid-hand-off would advance the counter and retire the tail
 * early, reproducing the exact blank frame this module removes. Membership of the
 * awaited message id is immune: a field patch never makes a missing message
 * appear, so only a real replacement can retire the tail.
 *
 * Pure: no React, no DOM, no timers (the caller owns the clock).
 */

/** Why the tail is being released — useful for both wiring and diagnostics. */
export type StreamingTailRetirementReason =
	/** The awaited persisted message is now part of the committed document. */
	| "replaced"
	/** The replacement never arrived (failed/aborted reload); release defensively. */
	| "timeout";

export interface StreamingTailRetirementInput {
	/** Id of the persisted assistant message that supersedes the tail, if any. */
	pendingRetireMessageId: string | null;
	/** Top-level message ids present in the CURRENTLY COMMITTED document. */
	committedMessageIds: ReadonlySet<string>;
	/** Milliseconds since retirement was requested (caller-supplied clock). */
	elapsedMs: number;
	/** Defensive upper bound before releasing without a replacement. */
	timeoutMs: number;
}

export interface StreamingTailRetirementDecision {
	retire: boolean;
	reason?: StreamingTailRetirementReason;
}

const KEEP: StreamingTailRetirementDecision = { retire: false };

/**
 * Resolve whether the streaming tail may be dropped now.
 *
 * - No pending request → keep (the tail is still the only view of live output).
 * - Awaited id present in the committed document → retire as `replaced`. The real
 *   card exists, so releasing the overlay in the SAME commit yields one clean
 *   frame with neither a gap nor a duplicate.
 * - Past the timeout → retire as `timeout`. Without this a failed reload (e.g. a
 *   409 version conflict) would leave the overlay pinned forever, since the id it
 *   waits for can never appear.
 */
export function resolveStreamingTailRetirement(
	input: StreamingTailRetirementInput,
): StreamingTailRetirementDecision {
	const { pendingRetireMessageId, committedMessageIds, elapsedMs, timeoutMs } = input;
	if (!pendingRetireMessageId) return KEEP;
	if (committedMessageIds.has(pendingRetireMessageId)) return { retire: true, reason: "replaced" };
	if (elapsedMs >= timeoutMs) return { retire: true, reason: "timeout" };
	return KEEP;
}

/**
 * Default defensive bound. Long enough that a slow tail refetch still completes
 * (keeping the hand-off seamless on a loaded server), short enough that a genuine
 * failure does not leave stale streaming text on screen for noticeably long.
 */
export const STREAMING_TAIL_RETIRE_TIMEOUT_MS = 3_000;

/**
 * Collect the top-level message ids of a committed document.
 *
 * Only the top level is walked: the retirement id always names a top-level
 * assistant message (a child message belongs to a subagent's own page and never
 * supersedes this page's tail).
 */
export function collectCommittedMessageIds(
	messages: readonly { id?: unknown }[],
): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (typeof message?.id === "string" && message.id.length > 0) ids.add(message.id);
	}
	return ids;
}
