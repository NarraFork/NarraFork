/**
 * Shared retire path for every session, including sessions whose Agent card is gone.
 *
 * Used by:
 * - Agent tool `archive` / `unarchive`
 * - History delete / rollback when a parent Agent/Task tool block is removed
 *
 * A retired subagent must stop running work and stay out of TeamStatus broadcast
 * (`@all members`). Direct Send is already rejected for `status === "archived"`.
 */

import { logger } from "../lib/logger";

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
 * Cancel a session's run and mark it archived. Callers enforce their control/write ACL.
 *
 * Never throws: history deletion must succeed even if a lifecycle side-effect fails.
 */
export async function interruptAndArchiveSubagent(
	subagentId: string,
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
		const { closeNarrator, isNarratorActive } = await import("./narrator-session");
		const { controlRun } = await import("./agent-runtime/run");

		// End the registered run (including any hold/task projection) before closing
		// the session. This mechanism does not depend on a delegation identity.
		let interrupted = await controlRun(narrator.id, { kind: "cancel", reason: "Retired" });
		try {
			if (isNarratorActive(narrator.id)) {
				closeNarrator(narrator.id);
				interrupted = true;
			}
		} catch {
			// closeNarrator is best-effort.
		}

		if (narrator.status === "archived") {
			return { ...base, ok: true, alreadyArchived: true, interrupted };
		}
		await giveBackDelegatedTask(narrator);
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
 * A subagent sent with an outline task (`Agent({ task })`, outline P2 PR 9a) gives the task back
 * to the session that sent it before it is archived, as the end of its run would (generation
 * unchanged, on the idle lease): archiving lets go of whatever an archived narrator still holds,
 * which would reopen the task, and the cancelled run ends only after this returns. Other
 * subagents keep the archive's rule (what they hold is let go).
 */
async function giveBackDelegatedTask(narrator: {
	id: string;
	runtimeRegistrationJson?: unknown;
}): Promise<void> {
	try {
		const { readRuntimeRegistrationColumn } = await import(
			"../lib/validators/runtime-registration"
		);
		if (!readRuntimeRegistrationColumn(narrator.runtimeRegistrationJson)?.delegatedTask) return;
		const { idleOutlineTaskClaims } = await import("./outline/tasks");
		await idleOutlineTaskClaims(narrator.id);
	} catch (error) {
		logger.warn("Delegated task could not be given back before archiving", {
			subagentId: narrator.id,
			error: error instanceof Error ? error.message : String(error),
		});
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
