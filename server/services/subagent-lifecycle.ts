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

import { narratorTraitsLock } from "../lib/async-mutex";
import { NotFoundError } from "../lib/errors";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import { readRuntimeRegistrationColumn } from "../lib/validators/runtime-registration";

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
		const { withNarratorMutationAdmission } = await import("./narrator-session-state");
		return await withNarratorMutationAdmission(subagentId, async () => {
			const narrator = await narratorService.getById(subagentId);
			if (!narrator) return { ...base, error: "not_found" };
			base.alreadyArchived = narrator.status === "archived";
			const { closeSubagentResources } = await import("./subagent-resources");
			try {
				base.interrupted = await prepareNarratorArchive(narrator);
				if (!base.alreadyArchived) {
					await narratorService.updateStatus(narrator.id, "archived");
					base.archived = true;
				}
				base.interrupted = (await repairArchivedNarrator(narrator)) || base.interrupted;
				return { ...base, ok: true };
			} finally {
				await closeSubagentResources(narrator.id);
			}
		});
	} catch (err) {
		logger.warn("interruptAndArchiveSubagent failed", {
			subagentId,
			error: err instanceof Error ? err.message : String(err),
		});
		return {
			...base,
			error:
				err instanceof NotFoundError
					? "not_found"
					: err instanceof Error
						? err.message
						: String(err),
		};
	}
}

/** Cancel work before archiving under the same mutation admission as the status write. */
export async function prepareNarratorArchive(narrator: {
	id: string;
	status: string;
	runtimeRegistrationJson?: unknown;
}) {
	const { closeNarrator, isNarratorActive } = await import("./narrator-session");
	const { controlRun, stopSubagentHelpers } = await import("./agent-runtime/run");
	let interrupted = await controlRun(narrator.id, { kind: "cancel", reason: "Retired" });
	await stopSubagentHelpers(narrator.id, "Parent subagent archived");
	if (isNarratorActive(narrator.id)) {
		closeNarrator(narrator.id);
		interrupted = true;
	}
	if (narrator.status !== "archived") await giveBackDelegatedTask(narrator);
	return interrupted;
}

/** Repeated archive can repair legacy claims; callers must still hold mutation admission. */
export async function repairArchivedNarrator(narrator: {
	id: string;
	type: string;
	backgroundStatus: string | null;
}) {
	return narrator.type === "subagent" && narrator.backgroundStatus === "running"
		? settleArchivedOrphan(narrator.id)
		: false;
}

/** Only a projection-less, unregistered legacy claim can be retired without a run terminal. */
async function settleArchivedOrphan(narratorId: string): Promise<boolean> {
	const [ownership, session, recovery, { getRuntimePublicationService }] = await Promise.all([
		import("./agent-runtime/ownership"),
		import("./narrator-session"),
		import("./recovery-handoff"),
		import("./agent-runtime/publication"),
	]);
	const hasDriver = () => {
		const hold = ownership.getRunHold(narratorId);
		// A manifest-only checkpoint need not have a logical run or continuation row.
		// Discovery must finish before an absent registry target proves abandonment.
		return (
			!!ownership.getExecutionOwner(narratorId) ||
			!!ownership.getRunControl(narratorId) ||
			session.isNarratorActive(narratorId) ||
			!!(hold && (!hold.released || hold.result)) ||
			recovery.isRecoveryDiscoveryActive() ||
			recovery.isRecoveryTargetPending(narratorId)
		);
	};
	const publication = getRuntimePublicationService();
	// Same lock order as background registration: admission -> traits -> short write.
	const settled = await narratorTraitsLock.acquire(narratorId, async () => {
		if (hasDriver()) return null;
		const claim = await publication.readArchivedOrphanBackgroundClaim(narratorId);
		if (
			!claim ||
			claim.type !== "subagent" ||
			claim.status !== "archived" ||
			claim.backgroundStatus !== "running" ||
			claim.logicalRunId !== null ||
			readRuntimeRegistrationColumn(
				claim.registrationText === null ? null : JSON.parse(claim.registrationText),
			)?.run ||
			parseSubstatus(claim.substatus).some(
				(tag) => tag === "taken_over" || tag.startsWith("terminal_run:"),
			) ||
			hasDriver()
		)
			return null;
		return (await publication.settleArchivedOrphanBackgroundClaim(claim, new Date().toISOString()))
			? claim
			: null;
	});
	if (!settled) return false;
	const { backgroundTaskService } = await import("./background-task-service");
	if (settled.parentNarratorId) {
		backgroundTaskService.notifyDerivedStatusChanged(settled.parentNarratorId, narratorId);
	} else {
		const { backgroundOccupancyStore } = await import("./background-occupancy-store");
		backgroundOccupancyStore.refreshNarrator(narratorId);
	}
	return true;
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
