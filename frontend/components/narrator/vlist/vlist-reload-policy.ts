/**
 * vlist-reload-policy.ts — Decides how the exact shell answers a STRUCTURAL
 * change, now that lifecycle changes are handled by in-place patches instead.
 *
 * Three classes of realtime change, three different answers:
 *
 *   patch      tool completed / reflection resolved / permission decided …
 *              → in-place document patch, unconditional, zero network
 *                (useVListLivePatches; deliberately NOT decided here)
 *   append     a new message landed
 *              → structural reload, but COALESCED so a turn producing several
 *                messages costs one refetch instead of one per message
 *   structural edit / delete / prune / compact-done / full reload
 *              → structural reload
 *
 * A structural reload replaces the whole loaded window with the tail page, so it
 * is deferred while the reader has scrolled up — otherwise browsing history during
 * an active turn would repeatedly yank them back to the bottom and discard any
 * loadOlder pages. The deferral is only acceptable because it is VISIBLE: the
 * decision reports `deferred`, which drives the "new messages" affordance so a
 * reader knows the view is behind. (Lifecycle patches are exempt from all of this
 * — they neither re-window the document nor move the viewport.)
 *
 * Pure: no React, no DOM, no timers.
 */

export interface ExactReloadDecisionInput {
	/** Monotonic counter bumped by every structural WS event. */
	messageRevision: number;
	/** The revision already reflected in the loaded document. */
	appliedRevision: number;
	/** A complete document must exist; the initial load owns the empty case. */
	hasIndex: boolean;
	/** The reader is at the bottom, so replacing the window is safe. */
	pinnedToBottom: boolean;
}

export interface ExactReloadDecision {
	/** Apply the structural reload now. */
	reload: boolean;
	/**
	 * A structural change is pending but withheld because the reader scrolled up.
	 * Surface it (unread affordance) and re-evaluate when they return to the bottom.
	 */
	deferred: boolean;
}

/**
 * Resolve whether to apply, defer, or ignore a structural revision.
 *
 * Ignoring covers two cases that are NOT staleness: the revision is already
 * applied, or no document exists yet (the load path handles that).
 */
export function resolveExactReloadDecision(input: ExactReloadDecisionInput): ExactReloadDecision {
	const pending = input.messageRevision > input.appliedRevision;
	if (!pending || !input.hasIndex) return { reload: false, deferred: false };
	return input.pinnedToBottom
		? { reload: true, deferred: false }
		: { reload: false, deferred: true };
}

/**
 * Coalescing window for structural reloads, in milliseconds.
 *
 * One assistant turn commonly persists several messages in quick succession, and
 * each one used to trigger its own full tail refetch (40-100 messages plus a
 * complete re-measure). Batching them within one short window collapses that to a
 * single reload without making the update perceptibly late.
 *
 * Kept comfortably under a typical inter-message gap so a genuinely isolated
 * message is not delayed noticeably, yet long enough to absorb the burst a single
 * turn emits.
 */
export const EXACT_RELOAD_COALESCE_MS = 120;

/**
 * Hard upper bound on how long a pending structural reload may be held by the
 * coalescing window, in milliseconds.
 *
 * The window alone is a plain DEBOUNCE: every new revision restarts it. A
 * tool-dense turn emits structural events far closer together than
 * `EXACT_RELOAD_COALESCE_MS`, so the timer is reset before it ever fires and the
 * reload is postponed for as long as generation continues — the reader watches a
 * frozen document through an entire turn.
 *
 * The bound converts it into a coalescing window with a deadline: the batch still
 * commits early when the burst stops, but once this much time has passed since the
 * FIRST pending revision the reload is forced through regardless of new arrivals.
 *
 * 1s is chosen to be well above the burst it is meant to absorb (a turn's
 * back-to-back messages land within tens of ms of each other) while staying inside
 * the interval a reader perceives as "live". It also bounds the worst case to one
 * reload per second during sustained generation, which is the cost the coalescing
 * window exists to cap.
 */
export const EXACT_RELOAD_MAX_DELAY_MS = 1000;

/**
 * Remaining delay before a pending structural reload must commit.
 *
 * Returns the coalescing window normally, and whatever is left of the max-delay
 * budget when the pending batch is already close to the deadline (0 ⇒ commit on
 * the next tick). `pendingSince` is the timestamp of the FIRST revision in the
 * current pending batch, so the budget is not restarted by later arrivals.
 */
export function resolveReloadDelayMs(pendingSince: number, now: number): number {
	const elapsed = Math.max(0, now - pendingSince);
	const remaining = EXACT_RELOAD_MAX_DELAY_MS - elapsed;
	if (remaining <= 0) return 0;
	return Math.min(EXACT_RELOAD_COALESCE_MS, remaining);
}

/**
 * True when a pending structural reload should be surfaced to the reader.
 *
 * Only meaningful while deferred: once applied, the view IS current and an unread
 * badge would be a lie.
 */
export function shouldSurfaceDeferredReload(decision: ExactReloadDecision): boolean {
	return decision.deferred;
}
