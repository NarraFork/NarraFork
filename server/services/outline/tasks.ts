/**
 * Outline tasks seen from the system (design §2.2, §4.5, §4.8): who is doing what, what a task
 * waits for, which tasks a session continues with, and the lease that keeps a session's claim.
 *
 * Claims are taken and released by the write path itself (`write.ts`, TASK CLAIMS): setting a
 * task to in progress is the claim, in the same commit. This module adds what happens outside a
 * commit:
 *
 *   - RENEWAL: a running session moves the lease of its claims on
 *     ({@link renewOutlineTaskLeases}, every {@link OUTLINE_TASK_LEASE.renewEveryMs}), a lease of
 *     {@link OUTLINE_TASK_LEASE.leaseMs}: the runs of a server that crashed lose them soon.
 *   - IDLE (D41): when a run ends, the session's claims go on the idle lease
 *     ({@link OUTLINE_TASK_IDLE_LEASE_MS}), so a session waiting between turns (for its person to
 *     answer, D27b) keeps what it is doing; a subagent's claims pass to its root on that lease
 *     ({@link idleOutlineTaskClaims}). Its next run renews them back to the running lease.
 *   - EXPIRY: a background job ({@link expireOutlineTaskLeases}) reopens tasks whose session's
 *     lease ran out: back to to-do, a block under the task records why, the progress under it
 *     stays. One system commit per space and batch, bounded per run; a lease renewed in between
 *     is left alone. The same job reopens tasks in progress that nobody holds
 *     ({@link reopenUnclaimedOutlineTasks}: written before claims existed), a bounded slice of
 *     the in-progress index per run.
 *   - SESSION END: a session archived or deleted lets go of what it and its subagents hold at
 *     once ({@link releaseOutlineSessionTaskClaims}, on the narrator events), reopened the way
 *     the expiry job reopens a task; the job also sweeps for sessions that ended while nobody
 *     was listening ({@link releaseEndedOutlineSessionClaims}). An archived session holds
 *     nothing: the end of its runs releases too, and nothing is handed back to it.
 *   - WAITING (read time, never stored): a task waits for its prerequisites (`depends::`) until
 *     each is done or cancelled, for people while a question under it is unanswered, and for
 *     confirmation while an open pending change touches it (`pending.ts`).
 *   - CONTINUATION CANDIDATES (§4.8): the open tasks a session may continue with.
 *
 * Every read is indexed and bounded; nothing here scans a space.
 */
import { eventBus } from "@server/lib/event-bus";
import { logger } from "@server/lib/logger";
import { compareOrderKeys, isAlias, parseAddress, serializeBody } from "@shared/outline";
import { getNarratorMessageRefsPort } from "../narrator-refs/store";
import { readDisplayNames } from "./access-reads";
import { OutlineLeaseNotExpiredError } from "./errors";
import { isOutlineEnabled } from "./feature";
import { type OutlineHandoffSubject, planOutlineHandoffs } from "./handoff";
import { OUTLINE_TEXT } from "./messages";
import {
	OUTLINE_LIMITS,
	OUTLINE_TASK_IDLE_LEASE_MS,
	OUTLINE_TASK_LEASE,
	type OutlineTaskJson,
	outlineLeaseEnd,
} from "./model";
import { findTasksWaitingForConfirmation } from "./pending";
import {
	questionWaits,
	sweepOutlineAnswerDeliveries,
	watchArchivedSessionQuestions,
} from "./questions";
import { readSubtree } from "./read";
import { outlineStore } from "./store";
import {
	chunked,
	type OutlineBlockMeta,
	type OutlinePendingHead,
	type OutlineSpaceRow,
	type OutlineStore,
	type OutlineTaskClaimRow,
} from "./store/port";
import {
	hasHumanAssignee,
	isFinishedTask,
	isOpenTask,
	isPersonWork,
	isPlanningRoot,
} from "./task-json";
import type { OutlineNode } from "./tree";
import { type OutlineOp, writeOutline } from "./write";

export const OUTLINE_TASK_LIMITS = {
	/** Open tasks of the session space, and tasks the session holds, a candidate query reads. */
	candidateScan: 500,
	/** Candidates (and waiting tasks) a query returns by default. */
	candidates: 20,
	/** Prerequisite targets one wait derivation resolves; the rest do not make a task wait. */
	prerequisiteTargets: 2000,
	/** Distinct spaces prerequisites may name in one derivation. */
	prerequisiteSpaces: 50,
	/** Expired leases one run of the expiry job handles. */
	expiryBatch: 100,
	/** Tasks one expiry commit reopens (two operations each). */
	expiryPerCommit: 50,
	/** Tasks in progress one run reads looking for those nobody holds. */
	unclaimedScan: 200,
	/** Tasks nobody holds one run reopens. */
	unclaimedBatch: 50,
	/** Open tasks of one subtree a `within` read takes (a plan's limit). */
	withinBlocks: 2000,
	/** Claims of an archived or deleted session one round reads and releases. */
	releaseBatch: 100,
	/** Rounds one archived or deleted session gets; what is left runs out as a lease. */
	releaseRounds: 10,
	/** Holders of claims one sweep for ended sessions reads. */
	endedSessionScan: 200,
	/** Ended sessions one sweep releases. */
	endedSessionBatch: 20,
} as const;

/** The system actor of the lease expiry job's commits. */
export const OUTLINE_LEASE_ACTOR = "outline-lease";

// ─────────────────────────────────────────────────────────────────────────────
// Leases
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renew every claim a session holds: its lease runs {@link OUTLINE_TASK_LEASE.leaseMs} from now.
 * A running session calls this every {@link OUTLINE_TASK_LEASE.renewEveryMs}. One indexed
 * statement; returns how many claims it renewed. A lease that ran out but whose task the expiry
 * job has not reopened yet is renewed too: nobody else took it.
 */
export async function renewOutlineTaskLeases(
	narratorId: string,
	options: { store?: OutlineStore; now?: Date } = {},
): Promise<number> {
	const store = options.store ?? outlineStore;
	const now = (options.now ?? new Date()).toISOString();
	return await store.renewTaskClaims(narratorId, outlineLeaseEnd(now));
}

/**
 * A run of a session ended (D41): the claims it holds go on the idle lease
 * ({@link OUTLINE_TASK_IDLE_LEASE_MS} from now), so the session keeps what it is doing while it
 * waits for its next turn. A subagent's claims pass to its root on that lease instead, so the
 * session it belongs to carries on with them. Its next run renews them back to the running
 * lease: a renewal sets the lease to {@link OUTLINE_TASK_LEASE.leaseMs} from then, whatever it
 * was, and changes nothing else. Two indexed statements (the session and its root by primary
 * key, then its claims). Returns how many claims.
 *
 * An archived session holds nothing, whichever came first, the end of its run or its archiving:
 * when the session the narrator belongs to is archived, what that session holds is let go
 * ({@link releaseOutlineSessionTaskClaims}); when only the narrator is (a subagent archived on
 * its own), what it holds; when it no longer exists, likewise (deleted). Nothing is handed back
 * or kept on the idle lease then.
 */
export async function idleOutlineTaskClaims(
	narratorId: string,
	options: { store?: OutlineStore; now?: Date } = {},
): Promise<number> {
	const store = options.store ?? outlineStore;
	const session = (await store.getNarratorRoots([narratorId])).get(narratorId);
	const release = async (id: string, reason: OutlineSessionEnd) =>
		(await releaseOutlineSessionTaskClaims(id, reason, options)).reopened;
	if (session === undefined) return await release(narratorId, "deleted");
	if (session.sessionArchived) return await release(session.root, "archived");
	if (session.archived) return await release(narratorId, "archived");
	const until = outlineLeaseEnd(
		(options.now ?? new Date()).toISOString(),
		OUTLINE_TASK_IDLE_LEASE_MS,
	);
	if (session.root === narratorId) return await store.renewTaskClaims(narratorId, until);
	return await store.handOverTaskClaims(narratorId, session.root, until);
}

/** The claim rows of tasks (released ones included), by task block id. */
export async function getOutlineTaskClaims(
	blockIds: readonly string[],
	options: { store?: OutlineStore } = {},
): Promise<Map<string, OutlineTaskClaimRow>> {
	const store = options.store ?? outlineStore;
	const rows = blockIds.length > 0 ? await store.getTaskClaims(blockIds) : [];
	return new Map(rows.map((row) => [row.taskBlockId, row]));
}

/** Whether a claim is held at `now`: by a person, or by a session whose lease is running. */
export function isClaimLive(claim: OutlineTaskClaimRow | null | undefined, now: string): boolean {
	if (!claim) return false;
	if (claim.holderUserId !== null) return true;
	return claim.holderNarratorId !== null && (claim.expiresAt === null || claim.expiresAt > now);
}

export interface OutlineLeaseExpiryResult {
	/** Tasks reopened. */
	reopened: number;
	/** Expired leases found renewed (or their task changed) by the time they were written. */
	skipped: number;
	/** Tasks that could not be reopened (logged once; left alone for a while, then tried again). */
	failed: number;
}

async function holderNames(narratorIds: readonly string[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	try {
		const names = await readDisplayNames({ narratorIds });
		for (const [id, title] of names.narrators) if (title) out.set(id, title);
	} catch (error) {
		logger.warn("Outline lease expiry: session names unavailable", { error: String(error) });
	}
	return out;
}

/** The block written under a reopened task nobody was holding. */
export function outlineUnclaimedNote(): string {
	return serializeBody({
		type: "paragraph",
		content: [{ type: "text", text: OUTLINE_TEXT.unclaimedReopened, marks: [] }],
	});
}

/**
 * The block written under a reopened task: why it is open again. Built as a body, so a session
 * title that holds outline syntax (`[[…]]`, emphasis, …) is written as plain text.
 */
export function outlineLeaseExpiredNote(narratorId: string, title: string | null): string {
	return sessionNote(
		OUTLINE_TEXT.leaseExpired.lead(title),
		narratorId,
		OUTLINE_TEXT.leaseExpired.tail,
	);
}

/** The block written under a task reopened because its session was archived or deleted. */
export function outlineSessionEndedNote(
	narratorId: string,
	title: string | null,
	reason: OutlineSessionEnd,
): string {
	return sessionNote(
		OUTLINE_TEXT.sessionEnded.lead(reason, title),
		narratorId,
		OUTLINE_TEXT.sessionEnded.tail,
	);
}

function sessionNote(lead: string, narratorId: string, tail: string): string {
	return serializeBody({
		type: "paragraph",
		content: [
			{ type: "text", text: lead, marks: [] },
			{ type: "text", text: narratorId, marks: [{ type: "code" }] },
			{ type: "text", text: tail, marks: [] },
		],
	});
}

/**
 * Tasks the expiry job could not reopen, by task id: left alone until `until`, with the delay
 * doubling each time (in memory; a restart tries them again). Bounded: the oldest entry goes
 * when it is full.
 */
const expiryBackoff = new Map<string, { until: number; delayMs: number }>();
const EXPIRY_BACKOFF = { firstMs: 10 * 60_000, maxMs: 6 * 60 * 60_000, entries: 1000 } as const;

function backOff(taskId: string, nowMs: number, error: unknown): void {
	const previous = expiryBackoff.get(taskId);
	const delayMs = previous
		? Math.min(EXPIRY_BACKOFF.maxMs, previous.delayMs * 2)
		: EXPIRY_BACKOFF.firstMs;
	expiryBackoff.delete(taskId);
	if (expiryBackoff.size >= EXPIRY_BACKOFF.entries) {
		const oldest = expiryBackoff.keys().next().value;
		if (oldest !== undefined) expiryBackoff.delete(oldest);
	}
	expiryBackoff.set(taskId, { until: nowMs + delayMs, delayMs });
	// Said once per task, not every run.
	if (!previous)
		logger.warn("Outline lease expiry: a task could not be reopened; trying again later", {
			taskBlockId: taskId,
			retryInMs: delayMs,
			error: String(error),
		});
}

/** Test hook: forget the tasks the expiry job is leaving alone. */
export function resetOutlineLeaseExpiryBackoffForTests(): void {
	expiryBackoff.clear();
}

/**
 * Reopen tasks whose session's lease ran out (the background job, also callable directly): at
 * most `limit` expired claims, oldest first, one system commit per space and batch. Each task
 * goes back to to-do, keeps everything under it, and gets a last child recording that the
 * previous executor's lease expired; its claim is released. `now` decides what has expired; the
 * commit is dated when it is written.
 *
 * A claim renewed between the read and the commit is left alone (counted in `skipped`). A batch
 * that fails for another reason is written task by task, so one bad task does not hold up the
 * others; a task that cannot take the note is reopened without it, and one that cannot be
 * reopened at all is left alone for a while (counted in `failed`, logged once).
 */
export async function expireOutlineTaskLeases(
	options: { store?: OutlineStore; now?: Date; limit?: number } = {},
): Promise<OutlineLeaseExpiryResult> {
	const store = options.store ?? outlineStore;
	const nowDate = options.now ?? new Date();
	const limit = options.limit ?? OUTLINE_TASK_LIMITS.expiryBatch;
	const nowMs = nowDate.getTime();
	// Tasks being left alone are read past, not in place of, the ones that are due.
	const listed = await store.listExpiredTaskClaims(
		nowDate.toISOString(),
		limit + Math.min(expiryBackoff.size, limit),
	);
	const expired = listed.filter((e) => !resting(e.claim.taskBlockId, nowMs)).slice(0, limit);
	if (expired.length === 0) return { reopened: 0, skipped: 0, failed: 0 };
	const names = await holderNames([
		...new Set(expired.map((e) => e.claim.holderNarratorId as string)),
	]);
	// A task of a project space comes back with a handoff, as one given back at a run's end does
	// (outline P2 PR 10c-2); any other task with the plain note.
	const handoffs = await leaseHandoffs(store, expired, nowDate);
	return await reopenTasks(
		store,
		expired.map(({ claim, spaceId }) => {
			const holder = claim.holderNarratorId as string;
			const handoff = handoffs.get(claim.taskBlockId);
			return {
				taskBlockId: claim.taskBlockId,
				spaceId,
				note: outlineLeaseExpiredNote(holder, names.get(holder) ?? null),
				...(handoff ? { ops: handoff.ops, clearAssignee: handoff.clearAssignee } : {}),
			};
		}),
		nowDate,
		{ summary: OUTLINE_TEXT.leaseExpiredSummary },
	);
}

/**
 * Whether sessions run on this store (they do not on PostgreSQL): where they do not, nothing of
 * the release and handoff of outline P2 PR 10c-2 happens, and the lease job writes what it
 * always wrote. A binding that cannot be resolved counts as "no".
 */
export function outlineSessionsRunHere(): boolean {
	try {
		return !getNarratorMessageRefsPort();
	} catch {
		return false;
	}
}

/** The handoffs of expired claims on tasks of project spaces; none when they cannot be planned. */
async function leaseHandoffs(
	store: OutlineStore,
	expired: ReadonlyArray<{ claim: OutlineTaskClaimRow; spaceId: string }>,
	at: Date,
): Promise<Awaited<ReturnType<typeof planOutlineHandoffs>>> {
	if (!outlineSessionsRunHere()) return new Map();
	try {
		const spaces = new Map<string, OutlineSpaceRow | null>();
		for (const spaceId of new Set(expired.map((e) => e.spaceId)))
			spaces.set(spaceId, await store.getSpace(spaceId));
		const subjects = expired.flatMap(({ claim, spaceId }): OutlineHandoffSubject[] => {
			const space = spaces.get(spaceId);
			return space?.kind === "project" ? [{ claim, space }] : [];
		});
		return await planOutlineHandoffs(store, subjects, { reason: "lease", at });
	} catch (error) {
		logger.warn("Outline lease expiry: handoffs unavailable", { error: String(error) });
		return new Map();
	}
}

/** Where the next scan for tasks nobody holds starts (in memory; a restart starts over). */
let unclaimedCursor: string | null = null;

/**
 * Reopen tasks in progress that nobody holds (no claim, or a released one: written before
 * claims existed, or any hole in the rule that a task in progress has a holder), as if their
 * lease had run out: back to to-do with a note saying why. Each run reads at most `scan` tasks
 * of the in-progress index, continuing where the last run stopped, and reopens at most `limit`
 * of those it finds; one claimed in between is left alone. Bounded like the lease expiry.
 */
export async function reopenUnclaimedOutlineTasks(
	options: { store?: OutlineStore; now?: Date; limit?: number; scan?: number } = {},
): Promise<OutlineLeaseExpiryResult> {
	const store = options.store ?? outlineStore;
	const nowDate = options.now ?? new Date();
	const nowMs = nowDate.getTime();
	const limit = options.limit ?? OUTLINE_TASK_LIMITS.unclaimedBatch;
	const found = await store.listUnclaimedDoingTasks({
		after: unclaimedCursor,
		scan: options.scan ?? OUTLINE_TASK_LIMITS.unclaimedScan,
	});
	const candidates = found.tasks.filter((t) => !resting(t.blockId, nowMs));
	const due = candidates.slice(0, limit);
	// Cut by the limit: the next run starts right after the last one handled, not past the rest.
	unclaimedCursor = candidates.length > limit ? (due.at(-1)?.blockId ?? found.next) : found.next;
	if (due.length === 0) return { reopened: 0, skipped: 0, failed: 0 };
	const note = outlineUnclaimedNote();
	return await reopenTasks(
		store,
		due.map((t) => ({ taskBlockId: t.blockId, spaceId: t.spaceId, note })),
		nowDate,
		{ summary: OUTLINE_TEXT.unclaimedReopenedSummary },
	);
}

export type OutlineSessionEnd = "archived" | "deleted";

/**
 * A session was archived or deleted: what it and its subagents hold is let go at once, not when
 * the lease runs out. Each task goes back to to-do the way the expiry job reopens one (the
 * progress under it stays, a last child says the session was archived or deleted, one system
 * commit per space and batch, through the write path and its live barrier), whatever its lease.
 * Bounded: rounds of {@link OUTLINE_TASK_LIMITS.releaseBatch} claims, at most
 * {@link OUTLINE_TASK_LIMITS.releaseRounds} of them; a task the rounds do not reach, or that
 * cannot be written, keeps its lease and is reopened by the expiry job when it runs out.
 *
 * A subagent of the session passing its claims to the session meanwhile changes nothing: both
 * are let go. A claim someone else took in between is left alone (`skipped`).
 *
 * The note names the session by its title: `title` when the caller has it (a deleted session's,
 * read before its row went), else read now.
 */
export async function releaseOutlineSessionTaskClaims(
	narratorId: string,
	reason: OutlineSessionEnd,
	options: { store?: OutlineStore; now?: Date; title?: string | null } = {},
): Promise<OutlineLeaseExpiryResult> {
	const store = options.store ?? outlineStore;
	const nowDate = options.now ?? new Date();
	const nowMs = nowDate.getTime();
	const batch = OUTLINE_TASK_LIMITS.releaseBatch;
	const result: OutlineLeaseExpiryResult = { reopened: 0, skipped: 0, failed: 0 };
	let note: string | null = null;
	for (let round = 0; round < OUTLINE_TASK_LIMITS.releaseRounds; round++) {
		// Tasks being left alone are read past, as the expiry job does.
		const listed = await store.listSessionTaskClaims(
			narratorId,
			batch + Math.min(expiryBackoff.size, batch),
		);
		const held = listed.filter((e) => !resting(e.claim.taskBlockId, nowMs)).slice(0, batch);
		if (held.length === 0) break;
		if (note === null) {
			const title =
				options.title !== undefined
					? options.title
					: ((await holderNames([narratorId])).get(narratorId) ?? null);
			note = outlineSessionEndedNote(narratorId, title, reason);
		}
		const sessions = [narratorId, ...new Set(held.map((e) => e.claim.holderNarratorId as string))];
		const done = await reopenTasks(
			store,
			held.map(({ claim, spaceId }) => ({
				taskBlockId: claim.taskBlockId,
				spaceId,
				note: note as string,
			})),
			nowDate,
			{ sessions, summary: (n) => OUTLINE_TEXT.sessionEndedSummary(reason, n) },
		);
		result.reopened += done.reopened;
		result.skipped += done.skipped;
		result.failed += done.failed;
		if (done.reopened === 0 || listed.length < batch) break;
	}
	return result;
}

/** Where the next sweep for claims of ended sessions starts (in memory; a restart starts over). */
let endedCursor: string | null = null;

/**
 * Let go of what sessions hold that were archived or deleted while nobody was listening (before
 * the server started, while the outline was switched off, or whose release failed): the lease
 * job's sweep, bounded like its other parts. Each run reads at most `scan` distinct holders of
 * claims (the holder index, continuing where the last run stopped) and their sessions (primary
 * keys), and releases at most `limit` of the sessions it finds ended, each the way archiving or
 * deleting it does ({@link releaseOutlineSessionTaskClaims}): a holder that no longer exists as
 * deleted, one archived (or whose session is) as archived.
 */
export async function releaseEndedOutlineSessionClaims(
	options: { store?: OutlineStore; now?: Date; limit?: number; scan?: number } = {},
): Promise<OutlineLeaseExpiryResult> {
	const store = options.store ?? outlineStore;
	const limit = options.limit ?? OUTLINE_TASK_LIMITS.endedSessionBatch;
	const found = await store.listTaskClaimHolders({
		after: endedCursor,
		limit: options.scan ?? OUTLINE_TASK_LIMITS.endedSessionScan,
	});
	const sessions = await store.getNarratorRoots(found.holders);
	const ended: Array<{ holder: string; release: string; reason: OutlineSessionEnd }> = [];
	for (const holder of found.holders) {
		const session = sessions.get(holder);
		if (session === undefined) ended.push({ holder, release: holder, reason: "deleted" });
		else if (session.sessionArchived)
			ended.push({ holder, release: session.root, reason: "archived" });
		else if (session.archived) ended.push({ holder, release: holder, reason: "archived" });
	}
	const due = ended.slice(0, limit);
	// Cut by the limit: the next run starts right after the last one handled.
	endedCursor = ended.length > limit ? (due.at(-1)?.holder ?? found.next) : found.next;
	const result: OutlineLeaseExpiryResult = { reopened: 0, skipped: 0, failed: 0 };
	const released = new Set<string>();
	for (const { release, reason } of due) {
		if (released.has(release)) continue;
		released.add(release);
		const done = await releaseOutlineSessionTaskClaims(release, reason, {
			store,
			...(options.now ? { now: options.now } : {}),
		});
		result.reopened += done.reopened;
		result.skipped += done.skipped;
		result.failed += done.failed;
	}
	return result;
}

/** Test hook: start the next scans (unclaimed tasks, ended sessions) from the beginning. */
export function resetOutlineUnclaimedScanForTests(): void {
	endedCursor = null;
	unclaimedCursor = null;
}

function resting(taskId: string, nowMs: number): boolean {
	return (expiryBackoff.get(taskId)?.until ?? 0) > nowMs;
}

export interface Reopening {
	taskBlockId: string;
	spaceId: string;
	/** The block written last under the task: why it is open again. */
	note: string;
	/**
	 * Written in place of `note` (a handoff, `handoff.ts`; none at all for a task under another
	 * one given back with it). When they cannot be written, the task is reopened without them.
	 */
	ops?: readonly OutlineOp[];
	/** The task's assignment (to the session giving it back, by name) is cleared with it. */
	clearAssignee?: boolean;
}

/**
 * Reopen tasks for the lease job: one system commit per space and batch of
 * {@link OUTLINE_TASK_LIMITS.expiryPerCommit}. A task the planner finds held after all (renewed or
 * claimed in between) is left out and counted in `skipped`; a batch failing for another reason
 * is written task by task, a task that cannot take its note is reopened without it, and one that
 * cannot be reopened at all is left alone for a while (`failed`, logged once).
 */
export async function reopenTasks(
	store: OutlineStore,
	items: readonly Reopening[],
	nowDate: Date,
	how: {
		/** Sessions whose claims are released whatever their lease (archived or deleted). */
		sessions?: readonly string[];
		summary: (n: number) => string;
		/** The system actor of the commits; the lease job's by default. */
		actor?: string;
		/** The person the commits are written for (a session's owner giving its tasks back). */
		responsibleUserId?: string | null;
	},
): Promise<OutlineLeaseExpiryResult> {
	const now = nowDate.toISOString();
	const nowMs = nowDate.getTime();
	const result: OutlineLeaseExpiryResult = { reopened: 0, skipped: 0, failed: 0 };

	const reopen = async (
		spaceId: string,
		batch: readonly Reopening[],
		withNote: boolean,
	): Promise<void> => {
		const ops: OutlineOp[] = batch.flatMap((item): OutlineOp[] => {
			const setTodo: OutlineOp = {
				op: "setTask",
				block: { id: item.taskBlockId },
				task: { status: "todo", ...(item.clearAssignee ? { assignee: null } : {}) },
			};
			if (!withNote) return [setTodo];
			if (item.ops) return [setTodo, ...item.ops];
			return [
				setTodo,
				{
					op: "insert",
					parent: { id: item.taskBlockId },
					position: { last: true },
					content: item.note,
				},
			];
		});
		await writeOutline(
			{
				spaceId,
				ops,
				actor: { kind: "system", id: how.actor ?? OUTLINE_LEASE_ACTOR },
				responsibleUserId: how.responsibleUserId ?? null,
				summary: how.summary(batch.length),
			},
			{
				store,
				leaseExpiry: {
					blockIds: batch.map((c) => c.taskBlockId),
					now,
					...(how.sessions ? { sessions: how.sessions } : {}),
				},
			},
		);
	};
	/** Reopen `batch`, leaving out those found held; true when done, false on another error. */
	const attempt = async (
		spaceId: string,
		batch: Reopening[],
		withNote: boolean,
	): Promise<{ done: boolean; error?: unknown }> => {
		let pending = batch;
		while (pending.length > 0) {
			try {
				await reopen(spaceId, pending, withNote);
				result.reopened += pending.length;
				for (const item of pending) expiryBackoff.delete(item.taskBlockId);
				return { done: true };
			} catch (error) {
				if (!(error instanceof OutlineLeaseNotExpiredError)) return { done: false, error };
				const held = new Set(error.blockIds);
				const left = pending.filter((c) => !held.has(c.taskBlockId));
				result.skipped += pending.length - left.length;
				// Nothing named that was pending: do not loop on it.
				if (left.length === pending.length) return { done: false, error };
				pending = left;
			}
		}
		return { done: true };
	};

	const bySpace = new Map<string, Reopening[]>();
	for (const item of items) {
		const list = bySpace.get(item.spaceId);
		if (list) list.push(item);
		else bySpace.set(item.spaceId, [item]);
	}
	for (const [spaceId, list] of bySpace) {
		for (const batch of chunked(list, OUTLINE_TASK_LIMITS.expiryPerCommit)) {
			if ((await attempt(spaceId, batch, true)).done) continue;
			// Something in the batch keeps the commit from being written: one task at a time.
			for (const item of batch) {
				if ((await attempt(spaceId, [item], true)).done) continue;
				const bare = await attempt(spaceId, [item], false);
				if (bare.done) continue;
				result.failed++;
				backOff(item.taskBlockId, nowMs, bare.error);
			}
		}
	}
	return result;
}

/** Interval of the expiry job. */
const EXPIRY_INTERVAL_MS = 60_000;

const leaseJob: {
	timer: ReturnType<typeof setInterval> | null;
	running: Promise<void> | null;
	sessionEnds: OutlineSessionEndWatch | null;
	questionEnds: { stop(): Promise<void> } | null;
} = {
	timer: null,
	running: null,
	sessionEnds: null,
	questionEnds: null,
};

function runLeaseExpiry(): void {
	if (leaseJob.running || !isOutlineEnabled()) return;
	const run = async () => {
		const expired = await expireOutlineTaskLeases();
		if (expired.reopened || expired.skipped || expired.failed)
			logger.info("Outline task leases expired", { ...expired });
		const unclaimed = await reopenUnclaimedOutlineTasks();
		if (unclaimed.reopened || unclaimed.skipped || unclaimed.failed)
			logger.info("Outline tasks nobody was doing reopened", { ...unclaimed });
		const ended = await releaseEndedOutlineSessionClaims();
		if (ended.reopened || ended.skipped || ended.failed)
			logger.info("Outline tasks of sessions archived or deleted earlier reopened", { ...ended });
		// Answers a crash left undelivered to their askers (outline P2 PR 7).
		const answers = await sweepOutlineAnswerDeliveries();
		if (answers) logger.info("Outline answers delivered late", { delivered: answers });
	};
	leaseJob.running = run()
		.catch((error) => logger.warn("Outline lease expiry failed", { error: String(error) }))
		.finally(() => {
			leaseJob.running = null;
		});
}

/**
 * Start the lease expiry job: a run every minute while the outline is switched on, each bounded
 * by {@link OUTLINE_TASK_LIMITS.expiryBatch}; runs never overlap. Also starts letting go of the
 * claims of sessions archived or deleted ({@link watchOutlineSessionEnds}). Idempotent.
 */
export function startOutlineTaskLeaseJob(): void {
	if (leaseJob.timer) return;
	leaseJob.timer = setInterval(runLeaseExpiry, EXPIRY_INTERVAL_MS);
	leaseJob.timer.unref?.();
	leaseJob.sessionEnds = watchOutlineSessionEnds();
	leaseJob.questionEnds = watchArchivedSessionQuestions();
	runLeaseExpiry();
}

/** Stop the job and wait for a run (and session releases) in progress (shutdown). */
export async function stopOutlineTaskLeaseJob(): Promise<void> {
	if (leaseJob.timer) clearInterval(leaseJob.timer);
	leaseJob.timer = null;
	const sessionEnds = leaseJob.sessionEnds;
	const questionEnds = leaseJob.questionEnds;
	leaseJob.sessionEnds = null;
	leaseJob.questionEnds = null;
	await Promise.all([leaseJob.running, sessionEnds?.stop(), questionEnds?.stop()]);
}

/** Wait before retrying a session's release that failed, once. */
export const OUTLINE_SESSION_END_RETRY_MS = 5_000;

export interface OutlineSessionEndWatch {
	/** Releases started and not finished yet, settled (tests). */
	settled(): Promise<void>;
	/** Stop listening, then wait for the releases in progress. */
	stop(): Promise<void>;
}

/**
 * Let go of the claims of a session when it is archived (`narrator:status_changed` to
 * `archived`) or deleted (`narrator:deleted`, which comes once per narrator removed, so a
 * session's subagents each get theirs): the one place the outline hooks into the end of a
 * session, whichever way it was archived or deleted. Each release
 * ({@link releaseOutlineSessionTaskClaims}) runs after the event, not inside the request that
 * archived or deleted the session; one that fails is tried again once after a short wait, then
 * logged and left to the lease job's sweep ({@link releaseEndedOutlineSessionClaims}), which also
 * catches sessions archived or deleted while nobody was listening. With the outline switched
 * off, an event reads nothing.
 */
export function watchOutlineSessionEnds(
	options: {
		store?: OutlineStore;
		enabled?: () => boolean;
		now?: () => Date;
		/** Wait before the one retry of a release that failed. */
		retryMs?: number;
	} = {},
): OutlineSessionEndWatch {
	const enabled = options.enabled ?? isOutlineEnabled;
	const store = options.store ? { store: options.store } : {};
	const retryMs = options.retryMs ?? OUTLINE_SESSION_END_RETRY_MS;
	const pending = new Set<Promise<void>>();
	/** Waits for a retry, cut short by `stop` (the lease job's sweep catches up then). */
	const waits = new Set<() => void>();
	let stopped = false;
	const pause = () =>
		new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				waits.delete(done);
				resolve();
			};
			const timer = setTimeout(done, retryMs);
			timer.unref?.();
			waits.add(done);
		});
	const attempt = (narratorId: string, reason: OutlineSessionEnd, title?: string | null) =>
		releaseOutlineSessionTaskClaims(narratorId, reason, {
			...store,
			...(options.now ? { now: options.now() } : {}),
			...(title !== undefined ? { title } : {}),
		});
	const release = (narratorId: string, reason: OutlineSessionEnd, title?: string | null) => {
		if (!enabled()) return;
		const run: Promise<void> = (async () => {
			let result: OutlineLeaseExpiryResult;
			try {
				result = await attempt(narratorId, reason, title);
			} catch (error) {
				// Tried once more after a short wait; then left to the lease job's sweep.
				logger.warn("Outline tasks of an ended session could not be released; trying again", {
					narratorId,
					reason,
					retryInMs: retryMs,
					error: String(error),
				});
				await pause();
				if (stopped) return;
				try {
					result = await attempt(narratorId, reason, title);
				} catch (again) {
					logger.warn("Outline tasks of an ended session could not be released", {
						narratorId,
						reason,
						error: String(again),
					});
					return;
				}
			}
			if (result.reopened || result.skipped || result.failed)
				logger.info("Outline tasks of an ended session reopened", {
					narratorId,
					reason,
					...result,
				});
		})().finally(() => {
			pending.delete(run);
		});
		pending.add(run);
	};
	const onStatus = (event: { narratorId: string; status: string }) => {
		if (event.status === "archived") release(event.narratorId, "archived");
	};
	const onDeleted = (event: { narratorId: string; title: string | null }) =>
		release(event.narratorId, "deleted", event.title);
	eventBus.on("narrator:status_changed", onStatus);
	eventBus.on("narrator:deleted", onDeleted);
	const settled = async () => {
		while (pending.size > 0) await Promise.allSettled([...pending]);
	};
	return {
		settled,
		async stop() {
			stopped = true;
			eventBus.off("narrator:status_changed", onStatus);
			eventBus.off("narrator:deleted", onDeleted);
			for (const done of [...waits]) done();
			await settled();
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Waiting (derived at read time)
// ─────────────────────────────────────────────────────────────────────────────

/** What an open task waits for. None is stored: each is read from the outline. */
export interface OutlineTaskWait {
	/** Prerequisites (`depends::`) that are tasks not done or cancelled yet, by block id. */
	prerequisites: string[];
	/**
	 * A question under the task is unanswered (`Ask`, plan PR 7): the question's nearest task
	 * waits, unless its asker went ahead with its recommendation (`proceed`).
	 */
	people: boolean;
	/**
	 * A change to it waits for confirmation (a locked plan, design §2.2): an open pending change
	 * touches the task, or the plan's being done waits for its locker. The agent does something
	 * else meanwhile; continuation skips it.
	 */
	confirmation: boolean;
}

export function isWaiting(wait: OutlineTaskWait | undefined): boolean {
	return !!wait && (wait.prerequisites.length > 0 || wait.people || wait.confirmation);
}

/** A task as the derivations read it. */
export interface OutlineTaskSubject {
	id: string;
	spaceId: string;
	taskJson: OutlineTaskJson | null;
}

/**
 * Of the given tasks, those an unanswered question waits under (`Ask`, plan PR 7): a question
 * makes its nearest task above it wait, unless its asker went ahead with its recommendation
 * (`proceed`). One bounded read of each space's open questions (`questions.ts`).
 */
export async function findTasksWaitingForPeople(
	tasks: readonly OutlineTaskSubject[],
	options: { store?: OutlineStore } = {},
): Promise<Set<string>> {
	return await questionWaits(tasks, options);
}

/**
 * What each task waits for. A prerequisite is resolved the way it is written: `key/sid` (or
 * `key/alias`) names a block of that space; a bare alias names one in the task's own space; a
 * title is not resolved here (searching titles is not bounded enough for a read path), so it
 * never makes a task wait, and neither does a prerequisite that is deleted or not a task. The
 * result names prerequisites by id only: what the caller may show of them is its decision.
 */
export async function deriveOutlineTaskWaits(
	tasks: readonly OutlineTaskSubject[],
	options: {
		store?: OutlineStore;
		/**
		 * The open pending changes that may touch these tasks, already read by the caller (the task
		 * board reads them by lock root for many spaces at once); read per space when absent.
		 */
		openPending?: readonly OutlinePendingHead[];
	} = {},
): Promise<Map<string, OutlineTaskWait>> {
	const store = options.store ?? outlineStore;
	const out = new Map<string, OutlineTaskWait>(
		tasks.map((t) => [t.id, { prerequisites: [], people: false, confirmation: false }]),
	);

	// The targets, grouped by the space they are looked up in.
	type Lookup = { taskId: string; key: string | null; ref: string };
	const lookups: Lookup[] = [];
	for (const task of tasks) {
		for (const dep of task.taskJson?.depends ?? []) {
			if (lookups.length >= OUTLINE_TASK_LIMITS.prerequisiteTargets) break;
			const address = parseAddress(dep.target);
			if (address) lookups.push({ taskId: task.id, key: address.space, ref: address.sid });
			else if (isAlias(dep.target.trim()))
				lookups.push({ taskId: task.id, key: null, ref: dep.target.trim() });
		}
	}
	if (lookups.length > 0) {
		const spaceOfTask = new Map(tasks.map((t) => [t.id, t.spaceId]));
		const keys = [...new Set(lookups.flatMap((l) => (l.key === null ? [] : [l.key])))].slice(
			0,
			OUTLINE_TASK_LIMITS.prerequisiteSpaces,
		);
		const spaceByKey = new Map<string, string>();
		for (const key of keys) {
			const space = await store.getSpaceByKey(key);
			if (space) spaceByKey.set(key, space.id);
		}
		// (space id, sid or alias) of each lookup.
		const wanted = new Map<string, { sids: Set<string>; aliases: Set<string> }>();
		const where = (l: Lookup): string | undefined =>
			l.key === null ? spaceOfTask.get(l.taskId) : spaceByKey.get(l.key);
		for (const l of lookups) {
			const spaceId = where(l);
			if (!spaceId) continue;
			let entry = wanted.get(spaceId);
			if (!entry) {
				entry = { sids: new Set(), aliases: new Set() };
				wanted.set(spaceId, entry);
			}
			if (l.key !== null) entry.sids.add(l.ref);
			if (isAlias(l.ref)) entry.aliases.add(l.ref);
		}
		const bySid = new Map<string, OutlineBlockMeta>();
		const byAlias = new Map<string, OutlineBlockMeta>();
		for (const [spaceId, entry] of wanted) {
			for (const meta of await store.getBlockMetas(spaceId, { sids: [...entry.sids] }))
				bySid.set(`${spaceId}\u0000${meta.sid}`, meta);
			const owners = await store.findAliasOwners(spaceId, [...entry.aliases]);
			const metas = await store.getBlockMetas(spaceId, { ids: owners.map((o) => o.id) });
			const metaById = new Map(metas.map((m) => [m.id, m]));
			for (const owner of owners) {
				const meta = metaById.get(owner.id);
				if (meta) byAlias.set(`${spaceId}\u0000${owner.alias}`, meta);
			}
		}
		for (const l of lookups) {
			const spaceId = where(l);
			if (!spaceId) continue;
			const key = `${spaceId}\u0000${l.ref}`;
			const meta = (l.key !== null ? bySid.get(key) : undefined) ?? byAlias.get(key);
			if (!meta || meta.deleted || meta.id === l.taskId || meta.taskJson === null) continue;
			if (isFinishedTask(meta.taskJson)) continue;
			const wait = out.get(l.taskId) as OutlineTaskWait;
			if (!wait.prerequisites.includes(meta.id)) wait.prerequisites.push(meta.id);
		}
	}

	const people = await findTasksWaitingForPeople(tasks, { store });
	for (const id of people) {
		const wait = out.get(id);
		if (wait) wait.people = true;
	}
	for (const id of await findTasksWaitingForConfirmation(tasks, {
		store,
		openPending: options.openPending,
	})) {
		const wait = out.get(id);
		if (wait) wait.confirmation = true;
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Continuation candidates (design §4.8)
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlineTaskRef {
	blockId: string;
	spaceId: string;
	sid: string;
	/** `key/sid`. */
	address: string;
	status: "todo" | "doing";
	assignee: string | null;
	/** The task's `version_seq` as read: a write that starts it names it as its base. */
	versionSeq: number;
	/** The task's fields as read (`manager`, `humanCreated`, …). */
	taskJson: OutlineTaskJson;
	/** The task's claim, when it has a row (it may be released or someone's expired lease). */
	claim: OutlineTaskClaimRow | null;
	/**
	 * It has unfinished tasks under it (outline P2 PR 8, D48 Q2): its work is theirs, so it is not
	 * the one continuation names or starts; it is named again once they are finished.
	 */
	container: boolean;
	/** The tasks it is under, nearest first (within the read). */
	taskAncestorIds: string[];
	/**
	 * A task it is under is in progress: it belongs to the tree being worked, whose steps
	 * continuation starts before any other to-do (D48 Q2).
	 */
	inWorkedTree: boolean;
}

export interface OutlineContinuationCandidates {
	/**
	 * Tasks the session can continue with, in document order: at most `limit` (plus the work in
	 * progress past it, with `keepWorkInProgress`).
	 */
	candidates: OutlineTaskRef[];
	/** Tasks that would be candidates but wait (for prerequisites or people), in document order. */
	waiting: Array<OutlineTaskRef & { wait: OutlineTaskWait }>;
	/**
	 * `candidates` and `waiting` together, in document order (`wait` null for a candidate): the
	 * session's open tasks as one list.
	 */
	ordered: Array<OutlineTaskRef & { wait: OutlineTaskWait | null }>;
	/** More tasks than {@link OUTLINE_TASK_LIMITS.candidateScan} were found; the rest were not read. */
	truncated: boolean;
	/**
	 * Every task read that is work a person wants of the session (`isPersonWork`: their own, or
	 * the root of a plan they approved), however many come before it (review round 1 S3): what
	 * `protectedOnly` counts. With its wait.
	 */
	personWork: Array<OutlineTaskRef & { wait: OutlineTaskWait | null }>;
}

/**
 * The tasks a session continues with (design §4.8), read from the database whatever the agent's
 * context holds: the tasks the session holds a claim on and the open tasks of its session space,
 * that are to do or in progress, whose prerequisites are all finished, with no unanswered
 * question under them, and that no person is doing (assigned to a person, or claimed by one).
 * Tasks another session is doing (its lease running) are left out; one whose lease ran out is a
 * candidate, since continuing it takes it over.
 *
 * Order is document order: the session space first, then other spaces by key; within a space by
 * page, then depth first by sibling order. At most `limit` of each list.
 *
 * A task with unfinished tasks under it is a `container`: listed (it is still open, and counts as
 * the person's work when it is theirs) but never the one continuation names or starts. A plan that
 * is not approved yet (`task_json.plan.state = planning`) is left out with every task under it: it
 * is never executed (D48 Q3). So is every task under a task a subagent of this session is doing
 * (a delegation, outline P2 PR 9a): that tree is the subagent's while it runs, and comes back
 * when its claim does.
 */
export async function findContinuationCandidates(options: {
	narratorId: string;
	/** The session's space (a subagent's is its root's, D31); null when it has none yet. */
	sessionSpaceId: string | null;
	/**
	 * Pages whose blocks are never the session's tasks, checkbox or not: its behavior page holds
	 * rules, which the agent may not tick (outline plan PR 4).
	 */
	excludePageIds?: readonly string[];
	/**
	 * Only the tasks of this block's subtree (a tree a person asked to start, an approved plan;
	 * review round 1 S3): read from its page's structure, so tasks elsewhere neither crowd it out
	 * nor show. At most {@link OUTLINE_TASK_LIMITS.withinBlocks} of its open tasks.
	 */
	within?: string;
	/**
	 * Keep the work in progress past `limit` (review round 1 S3): the tasks the session holds and
	 * the open tasks under a task in progress, so to-dos before them cannot crowd them out.
	 */
	keepWorkInProgress?: boolean;
	store?: OutlineStore;
	now?: Date;
	limit?: number;
}): Promise<OutlineContinuationCandidates> {
	const store = options.store ?? outlineStore;
	const now = (options.now ?? new Date()).toISOString();
	const limit = options.limit ?? OUTLINE_TASK_LIMITS.candidates;
	const scan = OUTLINE_TASK_LIMITS.candidateScan;
	const empty = (truncated: boolean): OutlineContinuationCandidates => ({
		candidates: [],
		waiting: [],
		ordered: [],
		truncated,
		personWork: [],
	});

	let subtree: Set<string> | null = null;
	if (options.within) {
		const read = await readSubtree(options.within, { store });
		if (!read) return empty(false);
		subtree = new Set();
		const stack = [read.root];
		while (stack.length > 0 && subtree.size < OUTLINE_TASK_LIMITS.withinBlocks) {
			const node = stack.pop() as OutlineNode;
			if (node.task && isOpenTask(node.task)) subtree.add(node.id);
			for (const child of node.children) stack.push(child);
		}
	}
	const claimedAll = await store.listClaimedTasks(options.narratorId, scan + 1);
	const inTree = subtree;
	const claimed = inTree ? claimedAll.filter(({ block }) => inTree.has(block.id)) : claimedAll;
	// Excluded pages are left out inside the scan, so their checkboxes cannot use it up.
	const own = inTree
		? await store.getBlockMetasByIds([...inTree])
		: options.sessionSpaceId
			? await store.listOpenTasks(options.sessionSpaceId, scan + 1, {
					excludePageIds: options.excludePageIds,
				})
			: [];
	const truncated = claimed.length > scan || own.length > scan;
	const metas = new Map<string, OutlineBlockMeta>();
	const claims = new Map<string, OutlineTaskClaimRow>();
	for (const { claim, block } of claimed.slice(0, scan)) {
		metas.set(block.id, block);
		claims.set(block.id, claim);
	}
	for (const block of own.slice(0, scan)) metas.set(block.id, block);
	const unread = [...metas.keys()].filter((id) => !claims.has(id));
	for (const [id, claim] of await getOutlineTaskClaims(unread, { store })) claims.set(id, claim);

	const excluded = new Set(options.excludePageIds ?? []);
	// Every open task read: what makes a task a container (a person's step under it counts too)
	// and what a plan being planned hides.
	const live = [...metas.values()].filter(
		(block) => !block.deleted && isOpenTask(block.taskJson) && !excluded.has(block.pageId),
	);
	if (live.length === 0) return empty(truncated);
	const ancestors = new Map<string, OutlineBlockMeta>();
	const inOrder = await inDocumentOrder(store, live, options.sessionSpaceId, { ancestors });
	const known = new Map<string, OutlineBlockMeta>(ancestors);
	for (const block of live) known.set(block.id, block);
	/** Ancestors of a block, nearest first. */
	const above = (block: OutlineBlockMeta): OutlineBlockMeta[] => {
		const out: OutlineBlockMeta[] = [];
		let parent = block.parentId === null ? undefined : known.get(block.parentId);
		while (parent && out.length <= OUTLINE_LIMITS.maxDepth) {
			out.push(parent);
			parent = parent.parentId === null ? undefined : known.get(parent.parentId);
		}
		return out;
	};
	const chains = new Map(live.map((block) => [block.id, above(block)]));
	const delegated = await delegatedTasksAbove(store, chains, claims, options.narratorId, now);
	const hidden = (block: OutlineBlockMeta): boolean =>
		isPlanningRoot(block.taskJson) ||
		(chains.get(block.id) ?? []).some((a) => isPlanningRoot(a.taskJson) || delegated.has(a.id));
	const shown = inOrder.filter((block) => !hidden(block));
	const containers = new Set<string>();
	for (const block of shown) {
		for (const ancestor of chains.get(block.id) ?? []) {
			if (ancestor.taskJson && isOpenTask(ancestor.taskJson)) containers.add(ancestor.id);
		}
	}
	const open = shown.filter((block) => {
		if (hasHumanAssignee(block.taskJson)) return false;
		const claim = claims.get(block.id);
		if (!claim || claim.holderNarratorId === options.narratorId) return true;
		return !isClaimLive(claim, now);
	});
	if (open.length === 0) return empty(truncated);

	const waits = await deriveOutlineTaskWaits(open, { store });
	const ordered = open;
	const spaces = new Map<string, OutlineSpaceRow>();
	for (const spaceId of new Set(open.map((b) => b.spaceId))) {
		const space = await store.getSpace(spaceId);
		if (space) spaces.set(spaceId, space);
	}
	const ref = (block: OutlineBlockMeta): OutlineTaskRef => ({
		blockId: block.id,
		spaceId: block.spaceId,
		sid: block.sid,
		address: `${spaces.get(block.spaceId)?.key ?? "?"}/${block.sid}`,
		status: (block.taskJson as OutlineTaskJson).status as "todo" | "doing",
		assignee: block.taskJson?.assignee ?? null,
		versionSeq: block.versionSeq,
		taskJson: block.taskJson as OutlineTaskJson,
		claim: claims.get(block.id) ?? null,
		container: containers.has(block.id),
		taskAncestorIds: (chains.get(block.id) ?? []).filter((a) => a.taskJson).map((a) => a.id),
		inWorkedTree: (chains.get(block.id) ?? []).some((a) => a.taskJson?.status === "doing"),
	});
	const candidates: OutlineTaskRef[] = [];
	const waiting: OutlineContinuationCandidates["waiting"] = [];
	const all: OutlineContinuationCandidates["ordered"] = [];
	// With `keepWorkInProgress` the work in progress is not cut by the window (P2 PR 8 review S3):
	// a task the session holds, and the open tasks of a tree being worked (a goal, an approved
	// plan), are kept past `limit`, however many to-dos come before them; the scan bounds them.
	const inProgress = (block: OutlineBlockMeta) =>
		options.keepWorkInProgress === true &&
		(claims.get(block.id)?.holderNarratorId === options.narratorId ||
			(chains.get(block.id) ?? []).some((a) => a.taskJson?.status === "doing"));
	for (const block of ordered) {
		const wait = waits.get(block.id);
		if (isWaiting(wait)) {
			if (waiting.length >= limit && !inProgress(block)) continue;
			const entry = { ...ref(block), wait: wait as OutlineTaskWait };
			waiting.push(entry);
			all.push(entry);
		} else if (candidates.length < limit || inProgress(block)) {
			const entry = ref(block);
			candidates.push(entry);
			all.push({ ...entry, wait: null });
		}
	}
	const personWork = open
		.filter((block) => isPersonWork(block.taskJson, options.narratorId))
		.map((block) => ({
			...ref(block),
			wait: isWaiting(waits.get(block.id)) ? (waits.get(block.id) as OutlineTaskWait) : null,
		}));
	return { candidates, waiting, ordered: all, truncated, personWork };
}

/**
 * Of the open tasks above the blocks read, those a subagent of `narratorId`'s session is doing
 * (its lease running): what is under them is the subagent's work while it runs. Their claims are
 * read in one indexed batch (those not read already), and the holders' sessions in one more; at
 * most {@link OUTLINE_TASK_LIMITS.candidateScan} tasks are considered.
 */
async function delegatedTasksAbove(
	store: OutlineStore,
	chains: ReadonlyMap<string, readonly OutlineBlockMeta[]>,
	claims: Map<string, OutlineTaskClaimRow>,
	narratorId: string,
	now: string,
): Promise<Set<string>> {
	const ids = new Set<string>();
	for (const chain of chains.values()) {
		for (const a of chain) {
			if (ids.size >= OUTLINE_TASK_LIMITS.candidateScan) break;
			if (a.taskJson && isOpenTask(a.taskJson)) ids.add(a.id);
		}
	}
	if (ids.size === 0) return new Set();
	const unread = [...ids].filter((id) => !claims.has(id));
	for (const [id, claim] of await getOutlineTaskClaims(unread, { store })) claims.set(id, claim);
	const held = new Map<string, string>();
	for (const id of ids) {
		const claim = claims.get(id);
		const holder = claim?.holderNarratorId;
		if (holder && holder !== narratorId && isClaimLive(claim, now)) held.set(id, holder);
	}
	if (held.size === 0) return new Set();
	const roots = await store.getNarratorRoots([...new Set(held.values())]);
	const out = new Set<string>();
	for (const [id, holder] of held) if (roots.get(holder)?.root === narratorId) out.add(id);
	return out;
}

/**
 * Sort blocks into document order: `first` space before the others (by key), then by the path of
 * sibling positions from the page down. Ancestors are read level by level, one indexed query per
 * space and level, at most {@link OUTLINE_LIMITS.maxDepth} levels. Also the task board's order.
 */
export async function inDocumentOrder(
	store: OutlineStore,
	blocks: readonly OutlineBlockMeta[],
	first: string | null,
	options: {
		/** Space keys the caller has already read, by space id (the rest are read here). */
		keys?: ReadonlyMap<string, string>;
		/** Ancestors read on the way, by id, for a caller that needs them too. */
		ancestors?: Map<string, OutlineBlockMeta>;
	} = {},
): Promise<OutlineBlockMeta[]> {
	const known = new Map(blocks.map((b) => [b.id, b]));
	for (let depth = 0; ; depth++) {
		// Every space's missing parents of this level in one read (by primary key).
		const missing = new Set<string>();
		for (const block of known.values()) {
			if (block.parentId !== null && !known.has(block.parentId)) missing.add(block.parentId);
		}
		if (missing.size === 0 || depth >= OUTLINE_LIMITS.maxDepth) break;
		let found = 0;
		for (const meta of await store.getBlockMetasByIds([...missing])) {
			known.set(meta.id, meta);
			options.ancestors?.set(meta.id, meta);
			found++;
		}
		if (found === 0) break;
	}
	const pathOf = (block: OutlineBlockMeta): OutlineBlockMeta[] => {
		const path: OutlineBlockMeta[] = [];
		let current: OutlineBlockMeta | undefined = block;
		while (current && path.length <= OUTLINE_LIMITS.maxDepth) {
			path.push(current);
			current = current.parentId === null ? undefined : known.get(current.parentId);
		}
		return path.reverse();
	};
	const keys = new Map<string, string>();
	for (const spaceId of new Set(blocks.map((b) => b.spaceId))) {
		const known = options.keys?.get(spaceId);
		keys.set(
			spaceId,
			spaceId === first ? "" : (known ?? (await store.getSpace(spaceId))?.key ?? spaceId),
		);
	}
	const paths = new Map(blocks.map((b) => [b.id, pathOf(b)]));
	return [...blocks].sort((a, b) => {
		if (a.spaceId !== b.spaceId) {
			const ka = keys.get(a.spaceId) as string;
			const kb = keys.get(b.spaceId) as string;
			return ka < kb ? -1 : ka > kb ? 1 : a.spaceId < b.spaceId ? -1 : 1;
		}
		const pa = paths.get(a.id) as OutlineBlockMeta[];
		const pb = paths.get(b.id) as OutlineBlockMeta[];
		for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
			const x = pa[i] as OutlineBlockMeta;
			const y = pb[i] as OutlineBlockMeta;
			if (x.id === y.id) continue;
			return compareOrderKeys(x.orderKey, y.orderKey) || (x.id < y.id ? -1 : 1);
		}
		return pa.length - pb.length;
	});
}

export { OUTLINE_TASK_LEASE };
