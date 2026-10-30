/**
 * Outline tasks seen from the system (design §2.2, §4.5, §4.8): who is doing what, what a task
 * waits for, which tasks a session continues with, and the lease that keeps a session's claim.
 *
 * Claims are taken and released by the write path itself (`write.ts`, TASK CLAIMS): setting a
 * task to in progress is the claim, in the same commit. This module adds what happens outside a
 * commit:
 *
 *   - RENEWAL: a running session moves the lease of its claims on
 *     ({@link renewOutlineTaskLeases}, every {@link OUTLINE_TASK_LEASE.renewEveryMs}).
 *   - EXPIRY: a background job ({@link expireOutlineTaskLeases}) reopens tasks whose session's
 *     lease ran out: back to to-do, a block under the task records why, the progress under it
 *     stays. One system commit per space and batch, bounded per run; a lease renewed in between
 *     is left alone. The same job reopens tasks in progress that nobody holds
 *     ({@link reopenUnclaimedOutlineTasks}: written before claims existed), a bounded slice of
 *     the in-progress index per run.
 *   - HAND-BACK: a subagent's claims pass to its root when its run ends
 *     ({@link handBackOutlineTaskClaims}), so the session carries on with them.
 *   - WAITING (read time, never stored): a task waits for its prerequisites (`depends::`) until
 *     each is done or cancelled, and for people while a question under it is unanswered.
 *   - CONTINUATION CANDIDATES (§4.8): the open tasks a session may continue with.
 *
 * Every read is indexed and bounded; nothing here scans a space.
 */
import { logger } from "@server/lib/logger";
import { compareOrderKeys, isAlias, parseAddress, serializeBody } from "@shared/outline";
import { readDisplayNames } from "./access-reads";
import { OutlineLeaseNotExpiredError } from "./errors";
import { isOutlineEnabled } from "./feature";
import { OUTLINE_TEXT } from "./messages";
import { OUTLINE_LIMITS, OUTLINE_TASK_LEASE, type OutlineTaskJson, outlineLeaseEnd } from "./model";
import { outlineStore } from "./store";
import {
	chunked,
	type OutlineBlockMeta,
	type OutlineSpaceRow,
	type OutlineStore,
	type OutlineTaskClaimRow,
} from "./store/port";
import { hasHumanAssignee, isFinishedTask, isOpenTask } from "./task-json";
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
 * A subagent's run ended: the claims it holds pass to its root (with a new lease), so the
 * session it belongs to carries on with what it was doing and the root's runs renew them. Does
 * nothing for a session that is not a subagent. Returns how many claims moved.
 */
export async function handBackOutlineTaskClaims(
	narratorId: string,
	options: { store?: OutlineStore; now?: Date } = {},
): Promise<number> {
	const store = options.store ?? outlineStore;
	const root = (await store.getNarratorRoots([narratorId])).get(narratorId);
	if (root === undefined || root === narratorId) return 0;
	const now = (options.now ?? new Date()).toISOString();
	return await store.handOverTaskClaims(narratorId, root, outlineLeaseEnd(now));
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
	return serializeBody({
		type: "paragraph",
		content: [
			{ type: "text", text: OUTLINE_TEXT.leaseExpired.lead(title), marks: [] },
			{ type: "text", text: narratorId, marks: [{ type: "code" }] },
			{ type: "text", text: OUTLINE_TEXT.leaseExpired.tail, marks: [] },
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
	return await reopenTasks(
		store,
		expired.map(({ claim, spaceId }) => {
			const holder = claim.holderNarratorId as string;
			return {
				taskBlockId: claim.taskBlockId,
				spaceId,
				note: outlineLeaseExpiredNote(holder, names.get(holder) ?? null),
			};
		}),
		nowDate,
	);
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
	unclaimedCursor = found.next;
	const due = found.tasks.filter((t) => !resting(t.blockId, nowMs)).slice(0, limit);
	if (due.length === 0) return { reopened: 0, skipped: 0, failed: 0 };
	const note = outlineUnclaimedNote();
	return await reopenTasks(
		store,
		due.map((t) => ({ taskBlockId: t.blockId, spaceId: t.spaceId, note })),
		nowDate,
	);
}

/** Test hook: start the next scan for unclaimed tasks from the beginning. */
export function resetOutlineUnclaimedScanForTests(): void {
	unclaimedCursor = null;
}

function resting(taskId: string, nowMs: number): boolean {
	return (expiryBackoff.get(taskId)?.until ?? 0) > nowMs;
}

interface Reopening {
	taskBlockId: string;
	spaceId: string;
	/** The block written last under the task: why it is open again. */
	note: string;
}

/**
 * Reopen tasks for the lease job: one system commit per space and batch of
 * {@link OUTLINE_TASK_LIMITS.expiryPerCommit}. A task the planner finds held after all (renewed or
 * claimed in between) is left out and counted in `skipped`; a batch failing for another reason
 * is written task by task, a task that cannot take its note is reopened without it, and one that
 * cannot be reopened at all is left alone for a while (`failed`, logged once).
 */
async function reopenTasks(
	store: OutlineStore,
	items: readonly Reopening[],
	nowDate: Date,
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
				task: { status: "todo" },
			};
			if (!withNote) return [setTodo];
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
				actor: { kind: "system", id: OUTLINE_LEASE_ACTOR },
				responsibleUserId: null,
				summary: OUTLINE_TEXT.leaseExpiredSummary(batch.length),
			},
			{ store, leaseExpiry: { blockIds: batch.map((c) => c.taskBlockId), now } },
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

const leaseJob: { timer: ReturnType<typeof setInterval> | null; running: Promise<void> | null } = {
	timer: null,
	running: null,
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
	};
	leaseJob.running = run()
		.catch((error) => logger.warn("Outline lease expiry failed", { error: String(error) }))
		.finally(() => {
			leaseJob.running = null;
		});
}

/**
 * Start the lease expiry job: a run every minute while the outline is switched on, each bounded
 * by {@link OUTLINE_TASK_LIMITS.expiryBatch}; runs never overlap. Idempotent.
 */
export function startOutlineTaskLeaseJob(): void {
	if (leaseJob.timer) return;
	leaseJob.timer = setInterval(runLeaseExpiry, EXPIRY_INTERVAL_MS);
	leaseJob.timer.unref?.();
	runLeaseExpiry();
}

/** Stop the job and wait for a run in progress (shutdown). */
export async function stopOutlineTaskLeaseJob(): Promise<void> {
	if (leaseJob.timer) clearInterval(leaseJob.timer);
	leaseJob.timer = null;
	await leaseJob.running;
}

// ─────────────────────────────────────────────────────────────────────────────
// Waiting (derived at read time)
// ─────────────────────────────────────────────────────────────────────────────

/** What an open task waits for. Neither is stored: both are read from the outline. */
export interface OutlineTaskWait {
	/** Prerequisites (`depends::`) that are tasks not done or cancelled yet, by block id. */
	prerequisites: string[];
	/** A question under the task is unanswered (always false until `Ask` exists, plan PR 7). */
	people: boolean;
}

export function isWaiting(wait: OutlineTaskWait | undefined): boolean {
	return !!wait && (wait.prerequisites.length > 0 || wait.people);
}

/** A task as the derivations read it. */
export interface OutlineTaskSubject {
	id: string;
	spaceId: string;
	taskJson: OutlineTaskJson | null;
}

/**
 * Of the given tasks, those with an unanswered question under them. Questions are plan PR 7
 * (`Ask`); until they exist, no task waits for people.
 */
export async function findTasksWaitingForPeople(
	_taskIds: readonly string[],
	_options: { store?: OutlineStore } = {},
): Promise<Set<string>> {
	// TODO(outline P2 PR 7): an `Ask` under a task (or under its steps) that has no answer yet.
	return new Set();
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
	options: { store?: OutlineStore } = {},
): Promise<Map<string, OutlineTaskWait>> {
	const store = options.store ?? outlineStore;
	const out = new Map<string, OutlineTaskWait>(
		tasks.map((t) => [t.id, { prerequisites: [], people: false }]),
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

	const people = await findTasksWaitingForPeople(
		tasks.map((t) => t.id),
		{ store },
	);
	for (const id of people) {
		const wait = out.get(id);
		if (wait) wait.people = true;
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
	/** The task's claim, when it has a row (it may be released or someone's expired lease). */
	claim: OutlineTaskClaimRow | null;
}

export interface OutlineContinuationCandidates {
	/** Tasks the session can continue with, in document order. */
	candidates: OutlineTaskRef[];
	/** Tasks that would be candidates but wait (for prerequisites or people), in document order. */
	waiting: Array<OutlineTaskRef & { wait: OutlineTaskWait }>;
	/** More tasks than {@link OUTLINE_TASK_LIMITS.candidateScan} were found; the rest were not read. */
	truncated: boolean;
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
 */
export async function findContinuationCandidates(options: {
	narratorId: string;
	/** The session's space (a subagent's is its root's, D31); null when it has none yet. */
	sessionSpaceId: string | null;
	store?: OutlineStore;
	now?: Date;
	limit?: number;
}): Promise<OutlineContinuationCandidates> {
	const store = options.store ?? outlineStore;
	const now = (options.now ?? new Date()).toISOString();
	const limit = options.limit ?? OUTLINE_TASK_LIMITS.candidates;
	const scan = OUTLINE_TASK_LIMITS.candidateScan;

	const claimed = await store.listClaimedTasks(options.narratorId, scan + 1);
	const own = options.sessionSpaceId
		? await store.listOpenTasks(options.sessionSpaceId, scan + 1)
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

	const open = [...metas.values()].filter((block) => {
		if (block.deleted || !isOpenTask(block.taskJson) || hasHumanAssignee(block.taskJson))
			return false;
		const claim = claims.get(block.id);
		if (!claim || claim.holderNarratorId === options.narratorId) return true;
		return !isClaimLive(claim, now);
	});
	if (open.length === 0) return { candidates: [], waiting: [], truncated };

	const waits = await deriveOutlineTaskWaits(open, { store });
	const ordered = await inDocumentOrder(store, open, options.sessionSpaceId);
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
		claim: claims.get(block.id) ?? null,
	});
	const candidates: OutlineTaskRef[] = [];
	const waiting: OutlineContinuationCandidates["waiting"] = [];
	for (const block of ordered) {
		const wait = waits.get(block.id);
		if (isWaiting(wait)) {
			if (waiting.length < limit) waiting.push({ ...ref(block), wait: wait as OutlineTaskWait });
		} else if (candidates.length < limit) candidates.push(ref(block));
	}
	return { candidates, waiting, truncated };
}

/**
 * Sort blocks into document order: `first` space before the others (by key), then by the path of
 * sibling positions from the page down. Ancestors are read level by level, one indexed query per
 * space and level, at most {@link OUTLINE_LIMITS.maxDepth} levels.
 */
async function inDocumentOrder(
	store: OutlineStore,
	blocks: readonly OutlineBlockMeta[],
	first: string | null,
): Promise<OutlineBlockMeta[]> {
	const known = new Map(blocks.map((b) => [b.id, b]));
	for (let depth = 0; ; depth++) {
		const missing = new Map<string, Set<string>>();
		for (const block of known.values()) {
			if (block.parentId !== null && !known.has(block.parentId)) {
				const set = missing.get(block.spaceId);
				if (set) set.add(block.parentId);
				else missing.set(block.spaceId, new Set([block.parentId]));
			}
		}
		if (missing.size === 0 || depth >= OUTLINE_LIMITS.maxDepth) break;
		let found = 0;
		for (const [spaceId, ids] of missing) {
			for (const meta of await store.getBlockMetas(spaceId, { ids: [...ids] })) {
				known.set(meta.id, meta);
				found++;
			}
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
		keys.set(spaceId, spaceId === first ? "" : ((await store.getSpace(spaceId))?.key ?? spaceId));
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
