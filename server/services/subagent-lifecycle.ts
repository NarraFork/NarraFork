/**
 * subagent-lifecycle.ts — shared retire path for subagents whose card is gone.
 *
 * Used by:
 * - Agent tool `archive` / `unarchive`
 * - History delete / rollback when a parent Agent/Task tool block is removed
 *
 * A retired subagent must stop running work and stay out of TeamStatus broadcast
 * (`@all members`). Direct Send is already rejected for `status === "archived"`.
 */

import { logger } from "../lib/logger";
import { isSubagentVariant } from "../lib/narrator-utils";

export interface InterruptAndArchiveResult {
	ok: boolean;
	/** True when the row was already archived (no status write). */
	alreadyArchived: boolean;
	/** True when this call wrote `status = "archived"`. */
	archived: boolean;
	/** Best-effort: whether any running work was interrupted/cancelled. */
	interrupted: boolean;
	id: string;
	error?: string;
}

/**
 * Stop running work on a subagent and mark it archived.
 *
 * Never throws: history deletion must succeed even if a lifecycle side-effect fails.
 * Non-subagent ids are refused without touching status.
 */
export async function interruptAndArchiveSubagent(
	subagentId: string,
	options?: { parentNarratorId?: string },
): Promise<InterruptAndArchiveResult> {
	const base: InterruptAndArchiveResult = {
		ok: false,
		alreadyArchived: false,
		archived: false,
		interrupted: false,
		id: subagentId,
	};
	try {
		const { narratorService } = await import("./narrator-service");
		const narrator = await narratorService.getById(subagentId).catch(() => null);
		if (!narrator) {
			return { ...base, error: "not_found" };
		}
		if (!isSubagentVariant(narrator.variant) && narrator.type !== "subagent") {
			return { ...base, error: "not_subagent" };
		}
		if (
			options?.parentNarratorId &&
			narrator.parentNarratorId &&
			narrator.parentNarratorId !== options.parentNarratorId
		) {
			return { ...base, error: "not_direct_child" };
		}
		if (narrator.status === "archived") {
			return { ...base, ok: true, alreadyArchived: true };
		}

		const { cancelBackgroundTask } = await import("./subagent-runner");
		const { closeNarrator, isNarratorActive } = await import("./narrator-session");
		const { interruptForegroundSubagent } = await import("./narrator-subagent");

		let interrupted = false;
		try {
			if (await cancelBackgroundTask(narrator.id)) interrupted = true;
		} catch {
			// Background cancel is best-effort.
		}
		try {
			if (isNarratorActive(narrator.id)) {
				closeNarrator(narrator.id);
				interrupted = true;
			}
		} catch {
			// closeNarrator is best-effort.
		}
		try {
			// Hard interrupt: the card is gone, so this is a retire, not a turn stop.
			if (interruptForegroundSubagent(narrator.id, { hard: true })) interrupted = true;
		} catch {
			// Foreground interrupt is best-effort.
		}

		await narratorService.updateStatus(narrator.id, "archived");
		return { ok: true, alreadyArchived: false, archived: true, interrupted, id: narrator.id };
	} catch (err) {
		logger.warn("interruptAndArchiveSubagent failed", {
			subagentId,
			error: err instanceof Error ? err.message : String(err),
		});
		return {
			...base,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Best-effort batch used by history delete / rollback after a subagent card
 * (Agent/Task tool block) is removed from the parent timeline.
 */
export async function archiveRetiredSubagents(
	subagentIds: readonly string[],
): Promise<InterruptAndArchiveResult[]> {
	const unique = [...new Set(subagentIds.filter(Boolean))];
	const results: InterruptAndArchiveResult[] = [];
	for (const id of unique) {
		results.push(await interruptAndArchiveSubagent(id));
	}
	return results;
}
