/**
 * Deciding how to present work a rebase parked and could not put back.
 *
 * The server distinguishes three situations that the UI used to collapse into one
 * yellow "changes are in a snapshot" toast:
 *
 *   - `conflict` — the parked side and the rebased workspace disagree. A user decision;
 *     retry / write-out / discard all make sense.
 *   - `failed` — a NarraFork or git fault. No user action addresses the cause, so it
 *     warrants different wording and more urgency, and it carries `reapplyError`.
 *   - `lostParkedSnapshot` — an earlier snapshot no longer resolves at all. Nothing is
 *     recoverable, so this only informs.
 *
 * Pure, so each state can be asserted without rendering the ruler: the mapping is the
 * part that regressed, not the notification plumbing.
 */

import type { ParkedWorkFields, ParkedWorkStatus } from "../../lib/api/projects";

/** Short prefix length used when quoting a snapshot id to the user. */
export const SNAPSHOT_DISPLAY_CHARS = 12;

export interface ParkedWorkNotice {
	kind: "lost" | "conflict" | "failed";
	color: "red" | "yellow";
	snapshot: string;
}

export interface ParkedWorkPresentation {
	/** Notices to show, in order. A lost snapshot can accompany a new parked one. */
	notices: ParkedWorkNotice[];
	/**
	 * Recovery panel state, or null when there is nothing actionable.
	 *
	 * Gated on `parkedWorkPending`: without it the server has already cleared the
	 * coordinates and would reject every recovery action, so offering them would only
	 * produce errors.
	 */
	recoverable: {
		snapshot: string;
		status: ParkedWorkStatus;
		conflictFiles: string[];
		error?: string;
	} | null;
	/** Whether the caller should also show its ordinary success toast. */
	showSuccess: boolean;
}

export function presentParkedWork(result: ParkedWorkFields): ParkedWorkPresentation {
	const notices: ParkedWorkNotice[] = [];

	if (result.lostParkedSnapshot) {
		notices.push({ kind: "lost", color: "red", snapshot: result.lostParkedSnapshot });
	}

	if (!result.parkedSnapshot) {
		return {
			notices,
			recoverable: null,
			// A lost snapshot is still bad news, so it must not be accompanied by a cheerful
			// "rebase completed" toast even though the rebase itself did succeed.
			showSuccess: notices.length === 0,
		};
	}

	const failed = result.parkedWorkStatus === "failed";
	notices.push({
		kind: failed ? "failed" : "conflict",
		color: failed ? "red" : "yellow",
		snapshot: result.parkedSnapshot,
	});

	return {
		notices,
		recoverable: result.parkedWorkPending
			? {
					snapshot: result.parkedSnapshot,
					// Default to conflict: it is the state that offers the user something to do,
					// so an unrecognised value degrades towards being actionable rather than
					// towards a dead end.
					status: result.parkedWorkStatus ?? "conflict",
					conflictFiles: result.reapplyConflictFiles ?? [],
					error: result.reapplyError,
				}
			: null,
		showSuccess: false,
	};
}

/** Trim a snapshot id for display, tolerating an already-short value. */
export function shortSnapshot(snapshot: string): string {
	return snapshot.slice(0, SNAPSHOT_DISPLAY_CHARS);
}
