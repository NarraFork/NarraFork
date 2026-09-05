/**
 * Subagent takeover state.
 *
 * "Takeover" is an explicit, user-driven mode layered on top of the existing
 * manual_override mechanism. It is a claim on the RESULT, not on the current
 * turn: clicking "Take over" does NOT stop what the subagent is doing. The turn
 * in flight runs to its natural end, and only then — instead of handing the
 * result back — the subagent parks in `idle[taken_over]` waiting for the user,
 * who then operates it like an independent narrator (send / interrupt / queue /
 * continue).
 *   - Foreground subagent: the parent tool call stays blocked in
 *     waitForManualOverride for the entire takeover.
 *   - Background subagent: the task leaves background mode when its turn ends
 *     (without being marked completed/failed) and the user operates it directly.
 *     Await/Send/sidecar messages to the parent report "being taken over by the
 *     user" instead of completed/interrupted.
 *
 * Stopping the current turn is a SEPARATE wish with its own button: Stop is soft
 * during a takeover and keeps the hold (see the subagent branch of
 * `POST /:id/interrupt`).
 *
 * Stopping takeover returns the result to the parent (foreground: resolve the
 * blocked Promise; background: restore the normal background completion flow).
 *
 * State authority is in-memory (these Sets). The `taken_over` substatus tag
 * written to the DB is only a mirror used by the frontend to render the
 * takeover UI and recover it across reconnects. On server restart the Sets are
 * empty, so takeover naturally ends (working/waiting narrators are reset to
 * idle[interrupted] by the startup reconciler, matching manual_override).
 *
 * NOTE: `hydrateTakeoverState()` is an intentional extension point for a future
 * "restore everything on server restart" feature. It is currently a no-op.
 */

/** Substatus tag mirrored to the DB while a subagent is taken over. */
export const TAKEN_OVER_SUBSTATUS = "taken_over";

// Use `let` + lazy getters to avoid TDZ issues under Bun --hot reload, matching
// the pattern used by the other subagent state modules.

let _takenOverSubagents: Set<string> | undefined;
function getTakenOverSet(): Set<string> {
	if (!_takenOverSubagents) _takenOverSubagents = new Set();
	return _takenOverSubagents;
}

let _takenOverBackgroundSubagents: Set<string> | undefined;
function getTakenOverBackgroundSet(): Set<string> {
	if (!_takenOverBackgroundSubagents) _takenOverBackgroundSubagents = new Set();
	return _takenOverBackgroundSubagents;
}

/**
 * Pending stop-takeover marker. Set by the stop-takeover API when the subagent
 * is still working (its independent loop is running). When the loop finishes,
 * the conclusion-watcher path uses this to resolve the parent's blocked Promise
 * (instead of double-writing the tool_call) so the parent narrator's
 * runForegroundLoop finalizer returns the result exactly once.
 */
let _pendingStopTakeover: Set<string> | undefined;
function getPendingStopTakeoverSet(): Set<string> {
	if (!_pendingStopTakeover) _pendingStopTakeover = new Set();
	return _pendingStopTakeover;
}

/**
 * Pending background-finalize marker. Set when stop-takeover is requested for a
 * subagent that was taken over from BACKGROUND mode while it is still working.
 * When its loop ends, the result is finalized as a background completion
 * (notification + sidecar) rather than handed to a blocked parent tool call.
 */
let _pendingBackgroundFinalize: Set<string> | undefined;
function getPendingBackgroundFinalizeSet(): Set<string> {
	if (!_pendingBackgroundFinalize) _pendingBackgroundFinalize = new Set();
	return _pendingBackgroundFinalize;
}

// === Pending stop-takeover (working → resolve on loop end) ===

export function markPendingStopTakeover(subagentId: string): void {
	getPendingStopTakeoverSet().add(subagentId);
}

/** Atomically check-and-clear the pending stop-takeover marker. */
export function consumePendingStopTakeover(subagentId: string): boolean {
	const set = getPendingStopTakeoverSet();
	if (!set.has(subagentId)) return false;
	set.delete(subagentId);
	return true;
}

export function isPendingStopTakeover(subagentId: string): boolean {
	return getPendingStopTakeoverSet().has(subagentId);
}

// === Pending background finalize (background takeover stop, working) ===

export function markPendingBackgroundFinalize(subagentId: string): void {
	getPendingBackgroundFinalizeSet().add(subagentId);
}

/** Atomically check-and-clear the pending background-finalize marker. */
export function consumePendingBackgroundFinalize(subagentId: string): boolean {
	const set = getPendingBackgroundFinalizeSet();
	if (!set.has(subagentId)) return false;
	set.delete(subagentId);
	return true;
}

// === Takeover state ===

/** Mark a subagent as taken over. */
export function markTakenOver(subagentId: string, options?: { background?: boolean }): void {
	getTakenOverSet().add(subagentId);
	if (options?.background) {
		getTakenOverBackgroundSet().add(subagentId);
	}
}

/** Clear all takeover state for a subagent. */
export function clearTakenOver(subagentId: string): void {
	getTakenOverSet().delete(subagentId);
	getTakenOverBackgroundSet().delete(subagentId);
	getPendingStopTakeoverSet().delete(subagentId);
	getPendingBackgroundFinalizeSet().delete(subagentId);
}

/** Whether a subagent is currently taken over (foreground or background). */
export function isTakenOver(subagentId: string): boolean {
	return getTakenOverSet().has(subagentId);
}

/** Whether a subagent was taken over while it was a background task. */
export function isBackgroundTakenOver(subagentId: string): boolean {
	return getTakenOverBackgroundSet().has(subagentId);
}

/**
 * Whether a subagent-only interrupt should suspend as a takeover rather than as a
 * plain manual_override.
 *
 * There is exactly one fact to read — is a takeover already established? — because
 * an interrupt is never itself the takeover request any more: `POST /:id/takeover`
 * records the hold and leaves the turn running. Every interrupt that arrives during
 * a takeover is the user stopping a turn they are driving themselves, and it must
 * suspend as `taken_over`; otherwise the takeover UI vanishes while `isTakenOver`
 * still holds and the parent stays blocked with no visible way to release it.
 *
 * Kept as a named function (rather than inlining `isTakenOver` at the call site)
 * because the answer decides which substatus the suspension is published under, and
 * the runner should not have to restate that rule.
 */
export function beginSubagentInterruptSuspension(subagentId: string): {
	heldByTakeover: boolean;
} {
	return { heldByTakeover: isTakenOver(subagentId) };
}

/**
 * Every subagent currently taken over.
 *
 * For batch callers (message loading) that would otherwise probe `isTakenOver`
 * once per candidate row. Synchronous and allocation-bounded by the number of
 * live takeovers (realistically 0-2), so it is safe on the main thread.
 *
 * ⚠️ This is the CONTROL-FLOW answer (who is still held), not the answer to
 * "whose badge should be lit" — see {@link isTakeoverReleasePending}.
 */
export function listTakenOverSubagents(): string[] {
	return [...getTakenOverSet()];
}

/**
 * The user has already pressed "Stop takeover", but the release cannot complete
 * yet because the subagent's own loop is still running: the result handoff
 * happens when that loop ends.
 *
 * Until then `isTakenOver` DELIBERATELY stays true — `clearTakenOver` wipes every
 * takeover set including the pending-release marker the loop must still consume
 * (see the deferred branches in the stop-takeover route). So the two questions
 * genuinely have different answers in this window:
 *
 *   isTakenOver()              → yes, still held (control flow)
 *   isTakeoverReleasePending() → yes, the USER has let go (display)
 *
 * Anything that PAINTS the takeover state must consult this too, otherwise a
 * page loaded during that window re-lights a badge the user already dismissed
 * and the card claims the session is waiting on a person who is not waiting.
 */
export function isTakeoverReleasePending(subagentId: string): boolean {
	return (
		getPendingStopTakeoverSet().has(subagentId) || getPendingBackgroundFinalizeSet().has(subagentId)
	);
}

/** Taken over AND not already released by the user — the badge's condition. */
export function isTakenOverForDisplay(subagentId: string): boolean {
	return isTakenOver(subagentId) && !isTakeoverReleasePending(subagentId);
}

/** Batch form of {@link isTakenOverForDisplay}. */
export function listDisplayTakenOverSubagents(): string[] {
	return [...getTakenOverSet()].filter((id) => !isTakeoverReleasePending(id));
}

// === Substatus preservation ===

/**
 * Ensure the `taken_over` substatus tag survives substatus overwrites while the
 * subagent is taken over. Injected into narratorPersistence.updateStatus and
 * compareAndSetStatus (the two full-status write paths that overwrite substatus
 * wholesale); mirrors preserveBackgroundCompactingSubstatus. The in-memory Set
 * remains the authoritative source of truth — this only keeps the persisted DB
 * mirror (and the broadcasts derived from it) in sync for those write paths.
 */
export function preserveTakenOverSubstatus(subagentId: string, next: string[]): string[] {
	if (isTakenOver(subagentId) && !next.includes(TAKEN_OVER_SUBSTATUS)) {
		return [...next, TAKEN_OVER_SUBSTATUS];
	}
	return next;
}

// === Future extension point ===

/**
 * Rehydrate takeover state on server startup. Intentionally a no-op for now —
 * reserved for a future "restore everything on restart" feature that would
 * repopulate the in-memory Sets from persisted state.
 */
export function hydrateTakeoverState(): void {
	// no-op
}
