/**
 * The report job (汇报, outline P2 PR 11): makes each person's report of each day, and the "today
 * so far" previews people ask for. It runs in the background, in slices; nothing here is on a
 * request path.
 *
 * WHOSE DAY (owner decisions Q1 = A, Q2 = B)
 * -----------------------------------------
 * One report per person per day, the day midnight to midnight in the person's time zone, made at
 * their report time on the next day (`digest-time.ts`). A person's spaces are those that concern
 * them: their personal space, the sessions they started, the projects they own or hold a grant of
 * their own on, and any space where they did something in the window (responsible for a commit,
 * or wrote one). Public projects count only through the last. Every space is checked against the
 * person's read access when the report is made, and again when it is shown.
 *
 * NO OVERLAP, NO GAP
 * ------------------
 * A day's window is a seq range `(from, to]` in each space: `to` is the last commit made before
 * the window's end (a search on the `(space_id, seq)` index), `from` is where the person's
 * previous report of that space ended (`ranges_json`) or, when it did not cover the space, the
 * last commit before the window's start. A report starts where the person's previous one ended
 * (`period_end`) when that one is the day before, so a change of time zone neither repeats nor
 * skips anything: the day after it is as much longer or shorter as the zones differ. Missed days
 * (the server was down) are made up, at most {@link OUTLINE_DIGEST_JOB.catchUpDays} of them,
 * oldest first; before those, nothing is made up. Every person gets a row for every day, an empty
 * one written as already read, so the next day always has the previous one to continue from.
 * Rows are unique per person, kind and day: running again, or two processes at once, adds no row.
 *
 * SLICES
 * ------
 * Before any report is made, every space committed to before `last_commit_at` existed is stamped
 * (once per process, in batches): an unstamped space would be invisible to the index below, and
 * its days lost. Then a sweep (every {@link OUTLINE_DIGEST_JOB.wakeEveryMs}) goes through people a
 * page at a time and gathers those with days due into a batch (at most `personDaysPerBatch`
 * person-days). A batch visits every space committed to since the earliest of its windows (the
 * `last_commit_at` index, a page at a time, each space once, however many there are),
 * summarizes the window of each person it concerns (bounded reads, `digest.ts`) and keeps their
 * part; then writes the batch's reports, person by person. A slice works at most
 * {@link OUTLINE_DIGEST_JOB.sliceBudgetMs}, yielding to the event loop after every space and every
 * person written, and the next slice carries on where it stopped. A restart starts over; reports
 * already written are not made again.
 *
 * FAILURES
 * --------
 * A space whose window cannot be read is tried once more, then left out of the batch's reports,
 * which are marked truncated (and it is logged). A person whose due days cannot be worked out, or
 * whose reports cannot be written (they were deleted meanwhile, say), is logged and skipped; their
 * later days of the batch are not written either, so a later sweep makes them again from the last
 * one that was. Such a person is left out of sweeps for a while, 5 minutes doubling up to 6 hours
 * (in memory: a restart tries again). A batch is done once every person was attempted, so one
 * failure never stops the job for anyone else. Logged errors are the driver's message, cut short,
 * never a whole failed statement with its parameters.
 *
 * SCALE
 * -----
 * Each batch (up to 200 people) reads every space active since its earliest window: whom a space
 * concerns is only known from its commits (acting in a public project counts). So the work grows
 * with people ÷ 200 × spaces active per day. That is fine for a team instance; for large ones,
 * working out once per sweep whom each active space concerns (or an index of who acted where)
 * would bound it, and is left for later.
 */
import { eventBus } from "@server/lib/event-bus";
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import type { OutlineDigestKind, OutlineDigestRanges } from "@shared/outline-digest";
import { canReadSpace } from "./access";
import {
	type DigestPersonRow,
	readDigestPeoplePage,
	readDigestPerson,
	readJudgedNarrator,
	readNarrator,
	readProject,
	readProjectGrantees,
} from "./access-reads";
import {
	assembleDigest,
	OUTLINE_DIGEST_LIMITS,
	type OutlineDigestLimits,
	type OutlinePersonContribution,
	type OutlineSpaceSummary,
	readWindowCommits,
	selectForPerson,
	spaceWeight,
	summarizeSpaceWindow,
} from "./digest";
import {
	addDays,
	canonicalTimeZone,
	dayWindow,
	latestDueDay,
	localDayOf,
	serverTimeZone,
} from "./digest-time";
import { isOutlineEnabled } from "./feature";
import { outlineStore } from "./store";
import type { OutlineDigestCursorRow, OutlineSpaceActivity } from "./store/digest-port";
import type { OutlineCommitRow, OutlineStore } from "./store/port";

/** Timing and limits of the job (design §3.1, §3.4). */
export const OUTLINE_DIGEST_JOB = {
	/** How often a sweep starts looking for days due. */
	wakeEveryMs: 5 * 60_000,
	/** Work one slice does at most before handing back. */
	sliceBudgetMs: 1500,
	/** Pause between slices while there is work left. */
	slicePauseMs: 2000,
	/** A space whose window takes longer is logged. */
	slowSpaceMs: 200,
	/** Missed days made up per person, oldest first. */
	catchUpDays: 3,
	/** People read per page of a sweep. */
	peoplePerPage: 200,
	/** Person-days one batch makes at most (a person's days are never split). */
	personDaysPerBatch: 200,
	/** Spaces read per page (a batch visits every page). */
	spacesPerPage: 200,
	/** People a project space concerns through grants, at most. */
	peoplePerSpace: 200,
	/** Spaces stamped with `last_commit_at` per slice until none are left. */
	stampBatch: 500,
	/** Daily reports kept per person. */
	keepDaily: 30,
	/** A person asks for a preview at most this often; a queue of at most this many people. */
	previewEveryMs: 60_000,
	previewQueue: 100,
	previewsPerBatch: 20,
	/** Commits one probe of the seq search reads. */
	seqProbes: 16,
	/** A person whose reports failed is left out of the sweep this long, doubling, up to the max. */
	retryFirstMs: 5 * 60_000,
	retryMaxMs: 6 * 60 * 60_000,
} as const;

/** One person's report of one day (or today so far), while the batch is gathered. */
interface PersonDay {
	kind: OutlineDigestKind;
	periodKey: string;
	timeZone: string;
	start: number;
	end: number;
	parts: OutlinePersonContribution[];
	/** Spaces left out early, being among the least busy (counted as spaces with changes). */
	dropped: number;
	/** Spaces whose window could not be read: the report says it is partial. */
	failed: number;
	ranges: OutlineDigestRanges;
}

/** A person's days of a batch, oldest first, and where each space's last one ended. */
interface PersonChain {
	person: DigestPersonRow;
	days: PersonDay[];
	lastTo: Map<string, number>;
}

interface Batch {
	chains: PersonChain[];
	since: string;
	after: { lastCommitAt: string; id: string } | null;
	visited: Set<string>;
	exhausted: boolean;
	/** Chains attempted so far when writing (the next slice goes on from there). */
	written: number;
	/** People whose inbox the batch changed. */
	attention: Set<string>;
}

interface JobState {
	batch: Batch | null;
	sweep: { after: string | null; done: boolean };
	/** People whose daily reports are written through a day, so the sweep need not ask. */
	doneThrough: Map<string, string>;
	previewQueue: string[];
	previewAt: Map<string, number>;
	stamped: boolean;
	/**
	 * People whose reports could not be made or written lately, and until when the sweep leaves
	 * them out (doubling from {@link OUTLINE_DIGEST_JOB.retryFirstMs} up to `retryMaxMs`).
	 * In memory: a restart tries everyone again.
	 */
	retryAfter: Map<string, { failures: number; until: number }>;
}

function freshState(): JobState {
	return {
		batch: null,
		sweep: { after: null, done: false },
		doneThrough: new Map(),
		previewQueue: [],
		previewAt: new Map(),
		stamped: false,
		retryAfter: new Map(),
	};
}

/** A person's reports failed: leave them out of sweeps for a while, longer each time. */
function failedFor(userId: string, now: number): void {
	const failures = (state.retryAfter.get(userId)?.failures ?? 0) + 1;
	const wait = Math.min(
		OUTLINE_DIGEST_JOB.retryMaxMs,
		OUTLINE_DIGEST_JOB.retryFirstMs * 2 ** Math.min(failures - 1, 20),
	);
	state.retryAfter.set(userId, { failures, until: now + wait });
}

/** Whether the sweep leaves the person out for now. */
function waitingFor(userId: string, now: number): boolean {
	const retry = state.retryAfter.get(userId);
	return retry !== undefined && retry.until > now;
}

/**
 * An error as a log line: the driver's own message (a failed statement's error carries the whole
 * query and its parameters, up to the size of a report), cut short.
 */
function errorText(error: unknown): string {
	const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
	const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
	return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

let state = freshState();

export interface OutlineDigestJobOptions {
	store?: OutlineStore;
	/** The time it is (the windows, the rows' times). */
	now?: () => Date;
	/** Milliseconds for the slice's budget (a monotonic clock by default). */
	clock?: () => number;
	budgetMs?: number;
	/** The zone of people who chose none (the server's by default). */
	serverTimeZone?: string;
	limits?: OutlineDigestLimits;
}

function zoneOf(person: DigestPersonRow, fallback: string): string {
	return (person.timeZone && canonicalTimeZone(person.timeZone)) || fallback;
}

/** The person's daily reports due at `now`, chained to their last one; null when none is due. */
async function dailyChain(
	store: OutlineStore,
	person: DigestPersonRow,
	now: number,
	fallbackZone: string,
): Promise<PersonChain | null> {
	const timeZone = zoneOf(person, fallbackZone);
	const latest = latestDueDay(now, timeZone, person.time);
	const known = state.doneThrough.get(person.id);
	if (known !== undefined && known >= latest) return null;
	const cursor = await store.getLatestDigestCursor(person.id, "daily");
	if (cursor && cursor.periodKey >= latest) {
		state.doneThrough.set(person.id, cursor.periodKey);
		return null;
	}
	const keys: string[] = [];
	for (
		let key = latest;
		keys.length < OUTLINE_DIGEST_JOB.catchUpDays && (!cursor || key > cursor.periodKey);
		key = addDays(key, -1)
	)
		keys.unshift(key);
	return chainOf(person, "daily", keys, timeZone, cursor, null);
}

/** The person's "today so far", from their last daily report if it is yesterday's. */
async function previewChain(
	store: OutlineStore,
	person: DigestPersonRow,
	now: number,
	fallbackZone: string,
): Promise<PersonChain> {
	const timeZone = zoneOf(person, fallbackZone);
	const today = localDayOf(now, timeZone);
	const cursor = await store.getLatestDigestCursor(person.id, "daily");
	return chainOf(person, "today", [today], timeZone, cursor, now);
}

function chainOf(
	person: DigestPersonRow,
	kind: OutlineDigestKind,
	keys: readonly string[],
	timeZone: string,
	cursor: OutlineDigestCursorRow | null,
	nowEnd: number | null,
): PersonChain {
	const chain: PersonChain = { person, days: [], lastTo: new Map() };
	for (const [i, key] of keys.entries()) {
		const window = dayWindow(key, timeZone);
		const previous = i === 0 ? cursor : null;
		const adjacent = i > 0 || (previous !== null && previous.periodKey === addDays(key, -1));
		let start = window.start;
		if (i > 0) start = (chain.days[i - 1] as PersonDay).end;
		else if (adjacent && previous) {
			start = Date.parse(previous.periodEnd);
			for (const [spaceId, range] of Object.entries(previous.ranges))
				chain.lastTo.set(spaceId, range[1]);
		}
		const end = Math.max(nowEnd ?? window.end, start);
		chain.days.push({
			kind,
			periodKey: key,
			timeZone,
			start,
			end,
			parts: [],
			dropped: 0,
			failed: 0,
			ranges: {},
		});
	}
	return chain;
}

/** The next batch: queued previews first, then the sweep's next people with days due. */
async function nextBatch(
	store: OutlineStore,
	now: number,
	fallbackZone: string,
	over: () => boolean,
): Promise<Batch | null> {
	const chains: PersonChain[] = [];
	if (state.previewQueue.length > 0) {
		for (const userId of state.previewQueue.splice(0, OUTLINE_DIGEST_JOB.previewsPerBatch)) {
			const person = await readDigestPerson(userId);
			if (person) chains.push(await previewChain(store, person, now, fallbackZone));
		}
	} else {
		let days = 0;
		while (!state.sweep.done && days < OUTLINE_DIGEST_JOB.personDaysPerBatch && !over()) {
			const people = await readDigestPeoplePage(
				state.sweep.after,
				OUTLINE_DIGEST_JOB.peoplePerPage,
			);
			if (people.length < OUTLINE_DIGEST_JOB.peoplePerPage) state.sweep.done = true;
			for (const person of people) {
				state.sweep.after = person.id;
				if (waitingFor(person.id, now)) continue;
				// One person's trouble never holds up the people after them.
				let chain: PersonChain | null = null;
				try {
					chain = await dailyChain(store, person, now, fallbackZone);
				} catch (error) {
					failedFor(person.id, now);
					logger.warn("Outline report: the days due could not be worked out; left for later", {
						userId: person.id,
						error: errorText(error),
					});
				}
				if (chain && chain.days.length > 0) {
					chains.push(chain);
					days += chain.days.length;
				}
				if (days >= OUTLINE_DIGEST_JOB.personDaysPerBatch) {
					// The rest of the page comes next time.
					state.sweep.done = false;
					break;
				}
			}
		}
	}
	if (chains.length === 0) return null;
	let since = Number.POSITIVE_INFINITY;
	for (const chain of chains) for (const day of chain.days) since = Math.min(since, day.start);
	return {
		chains,
		since: new Date(since).toISOString(),
		after: null,
		visited: new Set(),
		exhausted: false,
		written: 0,
		attention: new Set(),
	};
}

/** The people a space concerns by what it is (its owner, the session's, a project's members). */
async function relatedPeople(space: OutlineSpaceActivity): Promise<Set<string>> {
	const out = new Set<string>();
	if (space.kind === "personal" && space.ownerUserId) out.add(space.ownerUserId);
	if (space.kind === "session" && space.narratorId) {
		const narrator = await readNarrator(space.narratorId);
		const judged = narrator ? await readJudgedNarrator(narrator) : null;
		if (judged?.ownerUserId) out.add(judged.ownerUserId);
	}
	if (space.kind === "project" && space.projectId) {
		const project = await readProject(space.projectId);
		if (project?.ownerUserId) out.add(project.ownerUserId);
		for (const id of await readProjectGrantees(space.projectId, OUTLINE_DIGEST_JOB.peoplePerSpace))
			out.add(id);
	}
	return out;
}

/**
 * The last seq of the space whose commit was made before `t` (0: none): a search over the
 * `(space_id, seq)` index, {@link OUTLINE_DIGEST_JOB.seqProbes} commits a step. Commit times grow
 * with seq within a space (a commit is planned again when another lands first).
 */
export async function seqBefore(
	store: OutlineStore,
	space: { id: string; nextSeq: number },
	t: number,
): Promise<number> {
	let lo = 0;
	let hi = space.nextSeq - 1;
	const k = OUTLINE_DIGEST_JOB.seqProbes;
	while (hi > lo) {
		const n = hi - lo;
		const probes: number[] = [];
		if (n <= k) for (let s = lo + 1; s <= hi; s++) probes.push(s);
		else for (let i = 1; i <= k; i++) probes.push(lo + Math.ceil((n * i) / k));
		const rows = await store.getCommitsBySeqs(space.id, probes);
		const timeOf = new Map(rows.map((r) => [r.seq, Date.parse(r.createdAt)]));
		let nextLo = lo;
		let nextHi = hi;
		for (const seq of probes) {
			const time = timeOf.get(seq);
			if (time === undefined) continue;
			if (time < t) nextLo = seq;
			else {
				nextHi = seq - 1;
				break;
			}
		}
		if (nextLo === lo && nextHi === hi) break;
		lo = nextLo;
		hi = Math.max(nextLo, nextHi);
	}
	return lo;
}

/** Keep a person-day's parts bounded: the least busy go first, counted (assembly keeps the busiest). */
function compactParts(day: PersonDay, limits: OutlineDigestLimits): void {
	if (day.parts.length <= limits.spacesPerDigest * 2) return;
	day.parts.sort((a, b) => spaceWeight(b) - spaceWeight(a));
	day.dropped += day.parts.length - limits.spacesPerDigest;
	day.parts.length = limits.spacesPerDigest;
}

/** What visiting a space does to a batch, applied only once the whole visit succeeded. */
interface VisitEffect {
	day: PersonDay;
	range: [number, number] | null;
	part: OutlinePersonContribution | null;
}

/** One space of a batch: the window of every person-day it concerns. Reads only. */
async function visitSpace(
	store: OutlineStore,
	space: OutlineSpaceActivity,
	wanted: readonly PersonChain[],
	limits: OutlineDigestLimits,
): Promise<VisitEffect[]> {
	const lastCommit = Date.parse(space.lastCommitAt);
	const effects: VisitEffect[] = [];
	const related = await relatedPeople(space);
	const bounds = new Map<number, Promise<number>>();
	const boundary = (t: number) => {
		let found = bounds.get(t);
		if (!found) {
			found = seqBefore(store, space, t);
			bounds.set(t, found);
		}
		return found;
	};
	const windows = new Map<string, Promise<{ commits: OutlineCommitRow[]; truncated: boolean }>>();
	const summaries = new Map<string, Promise<OutlineSpaceSummary>>();
	for (const chain of wanted) {
		const { person } = chain;
		let readable: boolean | undefined;
		// Where this space stands for the person, day after day of the chain.
		let lastTo = chain.lastTo.get(space.id);
		for (const day of chain.days) {
			if (lastCommit < day.start) continue;
			const from = lastTo ?? (await boundary(day.start));
			const to = Math.max(from, await boundary(day.end));
			if (to <= from) continue;
			const key = `${from}:${to}`;
			let window = windows.get(key);
			if (!window) {
				window = readWindowCommits(store, space.id, from, to, limits.commitsPerSpace);
				windows.set(key, window);
			}
			const read = await window;
			// The space moves on for the person whether this day concerns them or not: a later day
			// of the batch starts after this one, never again from an earlier day's end.
			lastTo = to;
			const concerned =
				related.has(person.id) ||
				read.commits.some(
					(c) =>
						c.responsibleUserId === person.id ||
						(c.actorKind === "human" && c.actorId === person.id),
				);
			if (!concerned) continue;
			if (readable === undefined)
				readable = await canReadSpace({ userId: person.id, isAdmin: person.isAdmin }, space);
			if (!readable) break;
			let summary = summaries.get(key);
			if (!summary) {
				summary = summarizeSpaceWindow(store, space, from, to, limits, read);
				summaries.set(key, summary);
			}
			const part = selectForPerson(
				await summary,
				{ userId: person.id, username: person.username },
				limits,
			);
			// A part with nothing in it is no space with changes.
			effects.push({ day, range: [from, to], part: spaceWeight(part) > 0 ? part : null });
		}
	}
	return effects;
}

function applyVisit(spaceId: string, effects: readonly VisitEffect[], limits: OutlineDigestLimits) {
	// `chain.lastTo` is not written here: it is read only when a space's visit starts, a batch
	// visits each space once, and the visit threads it from day to day itself. Writing it would only
	// grow the batch's state with people × spaces.
	for (const { day, range, part } of effects) {
		if (range && Object.keys(day.ranges).length < limits.rangesPerDigest)
			day.ranges[spaceId] = range;
		if (part) {
			day.parts.push(part);
			compactParts(day, limits);
		}
	}
}

/** Write one person's reports of the batch, oldest first; how many rows were written. */
async function writeChain(
	store: OutlineStore,
	chain: PersonChain,
	nowIso: string,
	limits: OutlineDigestLimits,
	attention: Set<string>,
): Promise<number> {
	let written = 0;
	const userId = chain.person.id;
	for (const day of chain.days) {
		const assembled = assembleDigest(day.parts, limits, { dropped: day.dropped });
		if (day.failed > 0) assembled.truncated = true;
		const row = {
			id: generateId(),
			userId,
			kind: day.kind,
			periodKey: day.periodKey,
			timeZone: day.timeZone,
			periodStart: new Date(day.start).toISOString(),
			periodEnd: new Date(day.end).toISOString(),
			counts: assembled.counts,
			itemCount: assembled.itemCount,
			items: assembled.items,
			ranges: day.ranges,
			truncated: assembled.truncated,
			createdAt: nowIso,
			// Nothing to read, or a preview the person asked for (they are looking at it): written
			// as read, so it never shows as unread in the inbox.
			seenAt: assembled.itemCount === 0 || day.kind === "today" ? nowIso : null,
		};
		if (day.kind === "daily") {
			if (await store.insertDigest(row)) {
				written++;
				if (row.itemCount > 0) attention.add(userId);
				// The day's report replaces its preview; only the latest days are kept.
				if ((await store.deleteDigests(userId, "today", { atMostKey: day.periodKey })) > 0)
					attention.add(userId);
				await store.pruneDigests(userId, "daily", OUTLINE_DIGEST_JOB.keepDaily);
			}
			const known = state.doneThrough.get(userId);
			if (known === undefined || known < day.periodKey)
				state.doneThrough.set(userId, day.periodKey);
		} else {
			// The preview keeps its id (a client may hold it); any other the person had goes.
			const id = await store.replaceDigest(row);
			await store.deleteDigests(userId, "today", { exceptId: id });
			written++;
			attention.add(userId);
		}
	}
	return written;
}

/**
 * Write the batch's reports person by person until the budget is spent. A person whose reports
 * fail is logged and skipped. `done` once every person was attempted.
 */
async function writeBatch(
	store: OutlineStore,
	batch: Batch,
	now: number,
	limits: OutlineDigestLimits,
	over: () => boolean,
): Promise<{ done: boolean; written: number }> {
	let written = 0;
	const nowIso = new Date(now).toISOString();
	while (batch.written < batch.chains.length) {
		if (over()) return { done: false, written };
		const chain = batch.chains[batch.written] as PersonChain;
		batch.written++;
		try {
			written += await writeChain(store, chain, nowIso, limits, batch.attention);
			state.retryAfter.delete(chain.person.id);
		} catch (error) {
			failedFor(chain.person.id, now);
			logger.warn("Outline report could not be written; tried again later", {
				userId: chain.person.id,
				error: errorText(error),
			});
		}
		await yieldToLoop();
	}
	if (batch.attention.size > 0)
		eventBus.emit({ type: "human_attention:changed", userIds: [...batch.attention] });
	return { done: true, written };
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * One slice of the job: stamp spaces written before `last_commit_at` existed (no report is made
 * until none are left), then gather or carry on a batch, visiting spaces and then writing its
 * reports until the budget is spent. `more`: there is work left (call again).
 */
export async function runOutlineDigestSlice(
	options: OutlineDigestJobOptions = {},
): Promise<{ more: boolean; written: number }> {
	const store = options.store ?? outlineStore;
	const now = options.now ?? (() => new Date());
	const clock = options.clock ?? (() => performance.now());
	const limits = options.limits ?? OUTLINE_DIGEST_LIMITS;
	const budget = options.budgetMs ?? OUTLINE_DIGEST_JOB.sliceBudgetMs;
	const fallbackZone = options.serverTimeZone ?? serverTimeZone();
	const started = clock();
	const over = () => clock() - started >= budget;

	while (!state.stamped) {
		const ids = await store.listUnstampedSpaces(OUTLINE_DIGEST_JOB.stampBatch);
		if (ids.length === 0) {
			state.stamped = true;
			break;
		}
		await store.stampSpaces(ids);
		await yieldToLoop();
		if (over()) return { more: true, written: 0 };
	}
	if (!state.batch) {
		state.batch = await nextBatch(store, now().getTime(), fallbackZone, over);
		if (!state.batch) return { more: !state.sweep.done, written: 0 };
	}
	const batch = state.batch;
	while (!batch.exhausted) {
		if (over()) return { more: true, written: 0 };
		const page = await store.listSpacesCommittedSince(batch.since, {
			after: batch.after,
			limit: OUTLINE_DIGEST_JOB.spacesPerPage,
		});
		// The last page once it is visited to its end (a slice may stop in the middle of it).
		if (page.length === 0) batch.exhausted = true;
		for (const space of page) {
			batch.after = { lastCommitAt: space.lastCommitAt, id: space.id };
			// A space committed to again moves along the index: it is visited once.
			if (batch.visited.has(space.id)) continue;
			batch.visited.add(space.id);
			const lastCommit = Date.parse(space.lastCommitAt);
			const wanted = batch.chains.filter((chain) => chain.days.some((d) => lastCommit >= d.start));
			if (wanted.length === 0) continue;
			const began = clock();
			let effects: VisitEffect[] | null = null;
			for (let attempt = 0; attempt < 2 && effects === null; attempt++) {
				try {
					effects = await visitSpace(store, space, wanted, limits);
				} catch (error) {
					if (attempt === 1)
						logger.warn("Outline report: a space could not be read; reports left partial", {
							spaceId: space.id,
							error: errorText(error),
						});
				}
			}
			if (effects) applyVisit(space.id, effects, limits);
			else
				for (const chain of wanted)
					for (const day of chain.days) if (lastCommit >= day.start) day.failed++;
			const took = clock() - began;
			if (took > OUTLINE_DIGEST_JOB.slowSpaceMs)
				logger.info("Outline report: slow space", { spaceId: space.id, ms: Math.round(took) });
			await yieldToLoop();
			if (over()) return { more: true, written: 0 };
		}
	}
	let outcome: { done: boolean; written: number };
	try {
		outcome = await writeBatch(store, batch, now().getTime(), limits, over);
	} catch (error) {
		// Never left half written for the next slice to fail on again.
		state.batch = null;
		throw error;
	}
	if (outcome.done) state.batch = null;
	return { more: true, written: outcome.written };
}

/**
 * Ask for the person's "today so far": queued for the job (one entry per person, at most
 * {@link OUTLINE_DIGEST_JOB.previewQueue}), at most once per {@link OUTLINE_DIGEST_JOB.previewEveryMs}.
 * `queued` false: asked too recently (`recent`), or the queue is full (`queue_full`); the current
 * preview stands.
 */
export function requestOutlineDigestPreview(
	userId: string,
	options: { now?: number; kick?: boolean } = {},
): { queued: true } | { queued: false; reason: "recent" | "queue_full" } {
	const now = options.now ?? Date.now();
	if (state.previewQueue.includes(userId)) return { queued: true };
	const last = state.previewAt.get(userId);
	if (last !== undefined && now - last < OUTLINE_DIGEST_JOB.previewEveryMs)
		return { queued: false, reason: "recent" };
	if (state.previewQueue.length >= OUTLINE_DIGEST_JOB.previewQueue)
		return { queued: false, reason: "queue_full" };
	if (state.previewAt.size > 10_000) {
		for (const [id, at] of state.previewAt)
			if (now - at >= OUTLINE_DIGEST_JOB.previewEveryMs) state.previewAt.delete(id);
	}
	state.previewAt.set(userId, now);
	state.previewQueue.push(userId);
	if (options.kick !== false) kickOutlineDigestJob();
	return { queued: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Running it
// ─────────────────────────────────────────────────────────────────────────────

const job: {
	timer: ReturnType<typeof setInterval> | null;
	running: Promise<void> | null;
	again: boolean;
	stopping: boolean;
	wake: (() => void) | null;
} = { timer: null, running: null, again: false, stopping: false, wake: null };

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			job.wake = null;
			resolve();
		}, ms);
		timer.unref?.();
		job.wake = () => {
			clearTimeout(timer);
			job.wake = null;
			resolve();
		};
	});
}

/** Run slices until there is no work left (a run in progress takes the request along). */
export function kickOutlineDigestJob(): void {
	if (job.running) {
		job.again = true;
		return;
	}
	job.running = (async () => {
		do {
			job.again = false;
			let more = true;
			while (more && !job.stopping && isOutlineEnabled()) {
				more = (await runOutlineDigestSlice()).more;
				if (more && !job.stopping) await pause(OUTLINE_DIGEST_JOB.slicePauseMs);
			}
		} while (job.again && !job.stopping);
	})()
		.catch((error) => logger.warn("Outline report job failed", { error: String(error) }))
		.finally(() => {
			job.running = null;
		});
}

function wake(): void {
	if (state.sweep.done && !state.batch) state.sweep = { after: null, done: false };
	kickOutlineDigestJob();
}

/** Start the job: a sweep every {@link OUTLINE_DIGEST_JOB.wakeEveryMs} while the outline is on. */
export function startOutlineDigestJob(): void {
	if (job.timer) return;
	job.stopping = false;
	job.timer = setInterval(wake, OUTLINE_DIGEST_JOB.wakeEveryMs);
	job.timer.unref?.();
	wake();
}

/** Stop the job and wait for the slice in progress (shutdown). */
export async function stopOutlineDigestJob(): Promise<void> {
	if (job.timer) clearInterval(job.timer);
	job.timer = null;
	job.stopping = true;
	job.wake?.();
	await job.running;
	job.stopping = false;
}

/**
 * Sizes of the batch in progress (tests): its people, and the entries of their space positions
 * (`lastTo`), which must not grow with the spaces visited.
 */
export function outlineDigestBatchSizesForTests(): { chains: number; lastTo: number } | null {
	const batch = state.batch;
	if (!batch) return null;
	return {
		chains: batch.chains.length,
		lastTo: batch.chains.reduce((n, chain) => n + chain.lastTo.size, 0),
	};
}

/** Forget everything the job holds in memory (tests). */
export function resetOutlineDigestJobForTests(): void {
	state = freshState();
}

/** Start a new sweep at the next slice (tests: as the timer would). */
export function startOutlineDigestSweepForTests(): void {
	state.sweep = { after: null, done: false };
	state.doneThrough.clear();
}
