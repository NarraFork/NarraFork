/**
 * What an administrator does about the Dynamic Spec import (outline P2 PR 12b2): the admin page's
 * list of sessions by import state, a re-import (attention and failed attempts cleared, then
 * imported now), and a move back to Dynamic Spec of a session an import moved.
 *
 * MOVE BACK ({@link revertSpecImport})
 * ------------------------------------
 * Only for a root session an import moved into the outline (its state `imported`). Taken without
 * interrupting it (the admission the import takes; a running session or subagent: refused, try
 * again), with the import's guard held (spec writes refused, plugin commands wait, no import
 * starts meanwhile). Then:
 *   1. the state row says `reverted` (first: should the process stop right after the next step,
 *      no automatic trigger imports the session again);
 *   2. `narrators.task_backend` goes from `outline` to `spec`, conditionally (else the row is
 *      written back and the move back refused);
 *   3. the caches that read the column are dropped, and the session's clients hear `spec_changed`
 *      (source `revert`): the Spec panel shows its Dynamic Spec files again;
 *   4. SQLite: the old behavior fence, which the switch emptied (its text went to the behavior
 *      page, its SOP to the plugin's block), is written back as the revision the import read, a
 *      new revision; nothing of Dynamic Spec is deleted;
 *   5. what the session holds in the outline (its own space and any other) is let go at once:
 *      each task back to do with a note, as for an archived session (the lease keeper renews
 *      nothing for a moved-back session should one slip through); a marker block at the top of
 *      the task page and of the behavior page says the session was moved back and no longer
 *      reads them; nothing in the outline is deleted;
 *   6. a digest of the session's Dynamic Spec file pointers (after step 4) is kept: an
 *      administrator's re-import while it is unchanged moves the session forward again without
 *      writing (`importer.ts`), its markers removed.
 * An import in flight is never cut short: a session still being imported has not moved, so there
 * is nothing to move back (refused); one whose move is finishing holds the guard (refused, try
 * again).
 */
import { catalogError, NotFoundError } from "@server/lib/errors";
import { getUserLanguage } from "@server/lib/i18n";
import { logger } from "@server/lib/logger";
import type { Locale } from "@server/lib/prompt-i18n";
import type {
	OutlineSpecImportAdminItem,
	OutlineSpecImportAdminPage,
	OutlineSpecImportAdminState,
	OutlineSpecImportRevertResult,
} from "@shared/outline-spec-import";
import { beginSpecImport, invalidateTaskBackend, isSpecImporting } from "../../task-source/backend";
import { findBehaviorPage, resetOutlineBehaviorImport } from "../../task-source/outline-behavior";
import { resetOutlineFenceSopMove } from "../../task-source/outline-plugin-rules";
import { outlineAccessBackend } from "../access-reads";
import { forgetSpecImportLeftover } from "../lease-keeper";
import { OUTLINE_TASKS_PAGE_ALIAS } from "../model";
import { outlineStore } from "../store";
import { type OutlineOp, writeOutline } from "../write";
import {
	isSpecImportRunning,
	specImportMode,
	specImportSkipReason,
	specPointersDigest,
} from "./importer";
import { OUTLINE_SPEC_REVERT_ACTOR, SPEC_IMPORT_TEXT } from "./plan";
import {
	readSpecFilePointers,
	readSpecImportSession,
	readSpecRevisionContents,
	type SpecImportSession,
	switchSessionToSpec,
} from "./read-port";
import {
	countSpecImportStates,
	listSpecImportStates,
	readSpecImportState,
	SPEC_IMPORT_STATE_LIMITS,
	type SpecImportState,
	type SpecImportStateCursor,
	type SpecImportStateStatus,
	writeSpecImportState,
} from "./state";
import { requestSpecImport, type SpecImportStatus } from "./triggers";

// ─────────────────────────────────────────────────────────────────────────────
// The list
// ─────────────────────────────────────────────────────────────────────────────

function encodeCursor(cursor: SpecImportStateCursor | null): string | null {
	return cursor ? Buffer.from(JSON.stringify(cursor)).toString("base64url") : null;
}

function decodeCursor(cursor: string | null | undefined): SpecImportStateCursor | null {
	if (!cursor) return null;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof (parsed as SpecImportStateCursor).updatedAt === "string" &&
			typeof (parsed as SpecImportStateCursor).narratorId === "string"
		)
			return parsed as SpecImportStateCursor;
	} catch {
		// An unreadable cursor reads the first page.
	}
	return null;
}

function revertible(
	state: Pick<SpecImportState, "status" | "switchCount">,
	backend: string | null,
) {
	return backend === "outline" && state.status === "imported" && state.switchCount > 0;
}

/**
 * One page of the sessions in `state` (most recently changed first) and the count per state, each
 * capped. A `running` row no import of this process holds (the process stopped during it) reads
 * as `busy`, under `running` still (that is where it is stored).
 */
export async function specImportAdminPage(options: {
	state: OutlineSpecImportAdminState;
	cursor?: string | null;
	limit?: number;
}): Promise<OutlineSpecImportAdminPage> {
	const [counts, page] = await Promise.all([
		countSpecImportStates(),
		listSpecImportStates({
			status: options.state as SpecImportStateStatus,
			after: decodeCursor(options.cursor),
			limit: options.limit,
		}),
	]);
	const items: OutlineSpecImportAdminItem[] = page.items.map((item) => {
		const state: OutlineSpecImportAdminState =
			item.status === "running" && !isSpecImportRunning(item.narratorId) ? "busy" : item.status;
		return {
			narratorId: item.narratorId,
			title: item.title,
			ownerName: item.ownerName,
			taskBackend: item.taskBackend,
			state,
			trigger: item.trigger,
			attempts: item.attempts,
			reason: item.reason,
			error: item.error,
			switchedAt: item.switchedAt,
			switchCount: item.switchCount,
			revertedAt: item.revertedAt,
			revertCount: item.revertCount,
			updatedAt: item.updatedAt,
			canRevert: revertible(item, item.taskBackend),
			canReimport: item.taskBackend === "spec" && state !== "running",
		};
	});
	return {
		mode: specImportMode(),
		counts,
		countCap: SPEC_IMPORT_STATE_LIMITS.countCap,
		items,
		next: encodeCursor(page.next),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-import
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An administrator's re-import: the session's attention and failed attempts are cleared, then it
 * is imported now as the Spec panel's button would (a moved-back session too). Answers at once
 * with its state.
 */
export async function reimportSpecSession(
	narratorId: string,
	adminUserId: string,
): Promise<SpecImportStatus> {
	const session = await readSpecImportSession(narratorId);
	if (!session) throw new NotFoundError("Narrator", narratorId);
	if (specImportMode() === "off") throw catalogError("SPEC_IMPORT_OFF");
	if (specImportSkipReason(session) !== null) throw catalogError("SPEC_IMPORT_NOT_IMPORTABLE");
	if (!isSpecImportRunning(narratorId))
		await writeSpecImportState(narratorId, (current) => ({
			// A moved-back session stays so until the import moves it: the import reads it.
			status: current?.status === "reverted" ? "reverted" : "idle",
			attempts: 0,
			reason: null,
			error: null,
			attentionReason: null,
			lastActor: adminUserId,
		}));
	logger.info("An administrator re-imports a Dynamic Spec session", { narratorId, adminUserId });
	return await requestSpecImport(narratorId, { admin: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Move back
// ─────────────────────────────────────────────────────────────────────────────

/** Take the idle session without interrupting it (SQLite: the session runtime runs there only). */
async function admitIdle(narratorId: string): Promise<() => void> {
	if (outlineAccessBackend() === "postgres") return () => {};
	const { acquireNarratorRevertAdmission } = await import("../../narrator-session");
	try {
		return await acquireNarratorRevertAdmission(narratorId, {
			signal: new AbortController().signal,
			interrupt: false,
		});
	} catch (error) {
		if (error instanceof NotFoundError) throw error;
		throw catalogError("SPEC_IMPORT_SESSION_BUSY");
	}
}

/** See the module header. */
export async function revertSpecImport(
	narratorId: string,
	adminUserId: string,
): Promise<OutlineSpecImportRevertResult> {
	const session = await readSpecImportSession(narratorId);
	if (!session) throw new NotFoundError("Narrator", narratorId);
	if (session.type === "subagent") throw catalogError("SPEC_IMPORT_NOT_REVERTIBLE");
	if (isSpecImporting(narratorId) || isSpecImportRunning(narratorId))
		throw catalogError("SPEC_IMPORT_IN_PROGRESS");
	const release = await admitIdle(narratorId);
	try {
		if (isSpecImporting(narratorId)) throw catalogError("SPEC_IMPORT_IN_PROGRESS");
		const unguard = beginSpecImport(narratorId);
		try {
			return await revertHeld(session, adminUserId);
		} finally {
			unguard();
		}
	} finally {
		release();
	}
}

async function revertHeld(
	session: SpecImportSession,
	adminUserId: string,
): Promise<OutlineSpecImportRevertResult> {
	const { narratorId } = session;
	const before = await readSpecImportState(narratorId);
	if (!before || !revertible(before, session.taskBackend))
		throw catalogError("SPEC_IMPORT_NOT_REVERTIBLE");
	const now = new Date().toISOString();
	await writeSpecImportState(narratorId, {
		status: "reverted",
		revertCount: before.revertCount + 1,
		revertedAt: now,
		revertedBy: adminUserId,
		lastActor: adminUserId,
		revertSourceKey: null,
		revertNoteIds: [],
	});
	let moved = false;
	try {
		moved = await switchSessionToSpec(narratorId);
	} finally {
		if (!moved)
			await writeSpecImportState(narratorId, {
				status: before.status,
				revertCount: before.revertCount,
				revertedAt: before.revertedAt,
				revertedBy: before.revertedBy,
				lastActor: before.lastActor,
				revertSourceKey: before.revertSourceKey,
				revertNoteIds: before.revertNoteIds,
			}).catch((error: unknown) =>
				logger.warn("Could not write back the import state of a session not moved back", {
					narratorId,
					error: String(error),
				}),
			);
	}
	if (!moved) throw catalogError("SPEC_IMPORT_NOT_REVERTIBLE");
	invalidateTaskBackend(narratorId);
	forgetSpecImportLeftover(narratorId);
	// The run-start paths that move an old fence into the page look at the session again when it
	// is moved forward once more.
	resetOutlineBehaviorImport(narratorId);
	resetOutlineFenceSopMove(narratorId);
	await import("../../task-source/outline-views")
		.then(({ invalidateOutlineTasksView }) => invalidateOutlineTasksView(narratorId))
		.catch(() => {});
	const locale: Locale = session.ownerUserId
		? await getUserLanguage(session.ownerUserId).catch(() => "en" as const)
		: "en";
	const released = await releaseClaims(narratorId, locale);
	const fenceRestored = await restoreFence(narratorId, before.fenceRevisionId);
	const noteIds = await writeRevertNotes(session, locale, now);
	try {
		const pointers = session.namespaceId ? await readSpecFilePointers(session.namespaceId) : [];
		await writeSpecImportState(narratorId, {
			revertSourceKey: specPointersDigest(pointers),
			revertNoteIds: noteIds,
		});
	} catch (error) {
		// The next re-import then imports (nothing is lost; it may need attention).
		logger.warn("Could not record what a session moved back to Dynamic Spec holds", {
			narratorId,
			error: String(error),
		});
	}
	announceRevert(narratorId);
	logger.info("An administrator moved a session back to Dynamic Spec", {
		narratorId,
		adminUserId,
		released,
		fenceRestored,
		marked: noteIds.length,
	});
	return { reverted: true, marked: noteIds.length > 0, fenceRestored, released };
}

/**
 * Let go of what the session holds in the outline, in any space (12b2 review S2): a Dynamic Spec
 * session works on none of it, so each task is open again at once with a note saying why, as for
 * an archived session. Never rejects; the count reopened (what could not be is left to the
 * expiry job; the lease keeper renews nothing for a moved-back session).
 */
async function releaseClaims(narratorId: string, locale: Locale): Promise<number> {
	try {
		const { releaseOutlineSessionTaskClaims } = await import("../tasks");
		// Written as the move back's own system actor: the import counts those commits as its own,
		// so they keep no stale imported task from being cleared by a later re-import.
		return (
			await releaseOutlineSessionTaskClaims(narratorId, "reverted", {
				locale,
				actor: OUTLINE_SPEC_REVERT_ACTOR,
			})
		).reopened;
	} catch (error) {
		logger.warn("Could not let go of the tasks of a session moved back to Dynamic Spec", {
			narratorId,
			error: String(error),
		});
		return 0;
	}
}

/**
 * Write the old fence back as the revision the import read (SQLite: Dynamic Spec is written
 * through that handle; on PostgreSQL the import never emptied it). Nothing when it holds that
 * already, or when the import read none. Never rejects; false only when the fence should have
 * been written back and was not (its revision is gone, or the write failed): the admin page
 * warns then.
 */
async function restoreFence(narratorId: string, revisionId: string | null): Promise<boolean> {
	if (!revisionId || outlineAccessBackend() !== "sqlite") return true;
	try {
		const old = (await readSpecRevisionContents([revisionId])).get(revisionId);
		if (old === undefined) {
			logger.warn("The old behavior fence of a session moved back is gone; not restored", {
				narratorId,
				revisionId,
			});
			return false;
		}
		const [{ readSpecFileContentIfExists, writeSpecFile }, { BEHAVIOR_FENCE_URI }] =
			await Promise.all([
				import("../../spec-vfs-service"),
				import("../../task-source/outline-behavior"),
			]);
		const current = (await readSpecFileContentIfExists(narratorId, BEHAVIOR_FENCE_URI)) ?? "";
		if (current === old) return true;
		// The fence's system channel: the guard this move back holds lets it through.
		await writeSpecFile(narratorId, BEHAVIOR_FENCE_URI, old, {
			actor: "system",
			createdBy: "system",
			pluginSop: true,
		});
		return true;
	} catch (error) {
		logger.warn("Could not restore the old behavior fence of a session moved back", {
			narratorId,
			error: String(error),
		});
		return false;
	}
}

/**
 * One commit: a plain block at the top of the task page and of the behavior page saying the
 * session was moved back (owner's language). Returns the blocks written; never rejects.
 */
async function writeRevertNotes(
	session: SpecImportSession,
	locale: Locale,
	now: string,
): Promise<string[]> {
	const { narratorId } = session;
	try {
		const space = await outlineStore.findSpace({ kind: "session", narratorId });
		if (!space) return [];
		const [tasks] = await outlineStore.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
		const behavior = await findBehaviorPage(space.id);
		const text = SPEC_IMPORT_TEXT[locale];
		const day = now.slice(0, 10);
		const ops: OutlineOp[] = [];
		if (tasks)
			ops.push({
				op: "insert",
				parent: { id: tasks.id },
				position: { first: true },
				content: text.revertNote(day, "tasks"),
			});
		if (behavior)
			ops.push({
				op: "insert",
				parent: { id: behavior.id },
				position: { first: true },
				content: text.revertNote(day, "behavior"),
			});
		if (ops.length === 0) return [];
		const result = await writeOutline({
			spaceId: space.id,
			ops,
			actor: { kind: "system", id: OUTLINE_SPEC_REVERT_ACTOR },
			responsibleUserId: session.ownerUserId,
			narratorId,
			summary: text.summaryRevert,
		});
		return result.results
			.map((entry) => entry.blockId)
			.filter((id): id is string => typeof id === "string");
	} catch (error) {
		logger.warn("Could not mark the outline of a session moved back to Dynamic Spec", {
			narratorId,
			error: String(error),
		});
		return [];
	}
}

/** Tell the session's clients: the Spec panel shows its Dynamic Spec files again. */
function announceRevert(narratorId: string): void {
	void import("../../spec-broadcast")
		.then(({ broadcastSpecChanged }) =>
			broadcastSpecChanged(
				narratorId,
				{ uri: "spec://tasks.json", path: "tasks.json", revisionId: null },
				"revert",
				"system",
			),
		)
		.catch((error: unknown) =>
			logger.warn("Could not announce a session moved back", { narratorId, error: String(error) }),
		);
}
