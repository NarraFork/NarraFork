/**
 * Overlap hints (outline P2 PR 10b, design §2.6): which session's task in progress changed which
 * file, so a session writing the same file hears of it in the tool result, and its team activity
 * can say "session B is also changing a file you changed" (`team-activity.ts`).
 *
 * THE INDEX (memory only)
 * -----------------------
 * Keyed by (project id, repository-relative path): the path is taken relative to the git top level
 * of the session's working directory, so the same file in two worktrees of one repository is one
 * key. A remote workspace has no local top level: its key is the device and the execution
 * backend's identity of the absolute path. A session without a main project is not recorded (team
 * tasks live in the project's space anyway).
 *
 * Each key holds, per root session (a subagent's changes count for its root), the tasks in
 * progress the session held when it wrote the file (read from the claims holder index, cached per
 * session for {@link OUTLINE_OVERLAP_LIMITS.doingCacheMs}) and when. A write while it holds no
 * task in progress is still remembered for the session's own team activity, but tells nobody
 * else anything.
 *
 * Bounds: {@link OUTLINE_OVERLAP_LIMITS.filesPerSession} files a session, at most
 * {@link OUTLINE_OVERLAP_LIMITS.keys} keys and {@link OUTLINE_OVERLAP_LIMITS.sessions} sessions in
 * the process, the least recently written going first; a record older than
 * {@link OUTLINE_OVERLAP_LIMITS.ttlMs} no longer counts, nor one whose task left progress or
 * changed hands (checked against the claims when it would be named). A restart starts empty.
 *
 * THE HINT
 * --------
 * After a Write or an Edit (and a StructSed on a remote workspace: the tools that report through
 * `trackFileChange`), when another root session's task in progress also changed the file: one
 * line at the end of the result, naming the first such task and counting the rest. A (file, task)
 * pair is told to a session once an hour. Subagents of one session never hear of each other here
 * (TeamStatus covers that). Bash's file changes go into the index only: its changes are observed
 * after the fact and belong to no single command. Nobody is woken: the other session hears of it
 * in its own next write of the file, or in its team activity.
 *
 * Names follow what the session may read (`session-scope.ts`): the other session's title only
 * when everyone who reads this session may read that one, the task's address and title only when
 * this session may read its space.
 *
 * Every read is bounded and indexed: a session's claims (holder index), the tasks by primary key,
 * the claims and roots of the tasks to name, a space and a title or two.
 */
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { eventBus } from "@server/lib/event-bus";
import { hotOnce, hotSafe } from "@server/lib/hot-safe";
import type { Locale } from "@server/lib/i18n";
import { logger } from "@server/lib/logger";
import { toForwardSlash } from "@server/lib/platform-path";
import { getOutlineOverlapHint, type OutlineTeamTask } from "@server/lib/prompts/outline-team";
import { blockTitle } from "@shared/outline";
import { resolveNarratorProjectId } from "../narrator-project";
import { readTaskSession } from "../task-source/backend";
import { readDisplayNames, readNarrator } from "./access-reads";
import { isOutlineEnabled } from "./feature";
import { canSessionReadNarrator, canSessionReadSpace } from "./session-scope";
import { outlineStore } from "./store";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";

export const OUTLINE_OVERLAP_LIMITS = {
	/** Files one session's records keep; its least recently written go first. */
	filesPerSession: 500,
	/** Keys (project, path) in the process. */
	keys: 20_000,
	/** Sessions with records in the process. */
	sessions: 2_000,
	/** A record older than this no longer counts. */
	ttlMs: 24 * 60 * 60_000,
	/** How long a session's tasks in progress are reused before they are read again. */
	doingCacheMs: 30_000,
	/** Tasks in progress recorded per write. */
	tasksPerWrite: 8,
	/** Claims of a session read for its tasks in progress. */
	claimsRead: 50,
	/** A (file, task) pair is told to a session at most once in this long. */
	toldMs: 60 * 60_000,
	/** Pairs remembered as told per session. */
	toldPerSession: 1_000,
	/** Tasks of other sessions checked against their claims at once. */
	verifyTasks: 40,
	/** Working directories whose git top level is remembered, and for how long. */
	topLevels: 256,
	topLevelMs: 60_000,
	/** Files one Bash call adds to the index at most. */
	filesPerCall: 200,
} as const;

/** A task in progress a session held when it wrote a file. */
export interface OutlineSessionTask {
	taskId: string;
	spaceId: string;
}

interface Touch {
	taskIds: string[];
	at: number;
}

const state = hotSafe("narrafork.outlineOverlap", () => ({
	/** `projectId \0 path` → root session → its latest write. Least recently written first. */
	files: new Map<string, Map<string, Touch>>(),
	/** Root session → its keys → when written. Least recently active session first. */
	sessions: new Map<string, Map<string, number>>(),
	/** Root session → `key \0 taskId` → when told. */
	told: new Map<string, Map<string, number>>(),
	/** Root session → its tasks in progress, as last read. */
	doing: new Map<string, { at: number; tasks: Promise<OutlineSessionTask[]> }>(),
	/** Working directory → its git top level (null: none). */
	tops: new Map<string, { at: number; top: Promise<string | null> }>(),
	/** Root session → its main project, as last read. */
	projects: new Map<string, { at: number; projectId: Promise<string | null> }>(),
}));

const SEP = "\u0000";

function keyOf(projectId: string, path: string): string {
	return `${projectId}${SEP}${path}`;
}

function pathOf(key: string): string {
	return key.slice(key.indexOf(SEP) + 1);
}

/** Forget everything (tests; a new process starts this way). */
export function resetOutlineOverlapForTests(): void {
	state.files.clear();
	state.sessions.clear();
	state.told.clear();
	state.doing.clear();
	state.tops.clear();
	state.projects.clear();
}

/** Sizes, for tests and diagnostics. */
export function outlineOverlapStats(): { keys: number; sessions: number } {
	return { keys: state.files.size, sessions: state.sessions.size };
}

// ─────────────────────────────────────────────────────────────────────────────
// Where a file is: (project, repository-relative path)
// ─────────────────────────────────────────────────────────────────────────────

async function findTopLevel(dir: string): Promise<string | null> {
	let current = resolve(dir);
	for (let depth = 0; depth < 64; depth++) {
		// A checkout has `.git` as a directory, a linked worktree as a file: either marks its top.
		const found = await stat(join(current, ".git")).then(
			() => true,
			() => false,
		);
		if (found) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return null;
}

/** The git top level of a local directory (the nearest ancestor holding `.git`), cached. */
function topLevelOf(dir: string, now: number): Promise<string | null> {
	const hit = state.tops.get(dir);
	if (hit && now - hit.at < OUTLINE_OVERLAP_LIMITS.topLevelMs) return hit.top;
	const top = findTopLevel(dir).catch(() => null);
	state.tops.delete(dir);
	state.tops.set(dir, { at: now, top });
	while (state.tops.size > OUTLINE_OVERLAP_LIMITS.topLevels) {
		const oldest = state.tops.keys().next().value;
		if (oldest === undefined) break;
		state.tops.delete(oldest);
	}
	return top;
}

/** What `trackFileChange` knows of the execution backend. */
export interface OutlineOverlapBackend {
	kind: string;
	deviceId: string;
	paths: { identityKey(path: string): string };
}

/**
 * The path a key names: repository-relative for a local file under the working directory's top
 * level; the device and the backend's identity of the path for a remote one; null otherwise.
 */
export async function outlineOverlapPath(
	backend: OutlineOverlapBackend,
	cwd: string,
	filePath: string,
	now = Date.now(),
): Promise<string | null> {
	if (backend.kind !== "local") {
		const identity = backend.paths.identityKey(filePath);
		return identity ? `@${backend.deviceId}:${identity}` : null;
	}
	const top = await topLevelOf(cwd, now);
	if (!top) return null;
	const rel = toForwardSlash(relative(top, resolve(cwd, filePath)));
	if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
	return rel;
}

// ─────────────────────────────────────────────────────────────────────────────
// The index
// ─────────────────────────────────────────────────────────────────────────────

function dropTouch(key: string, root: string): void {
	const entries = state.files.get(key);
	if (!entries) return;
	entries.delete(root);
	if (entries.size === 0) state.files.delete(key);
}

/** Record that `root` wrote the file at `key` while holding `taskIds` in progress. */
export function recordOutlineTouch(
	root: string,
	key: string,
	taskIds: readonly string[],
	now: number,
): void {
	let entries = state.files.get(key);
	if (entries) state.files.delete(key);
	else entries = new Map();
	state.files.set(key, entries);
	entries.set(root, { taskIds: taskIds.slice(0, OUTLINE_OVERLAP_LIMITS.tasksPerWrite), at: now });
	let mine = state.sessions.get(root);
	if (mine) state.sessions.delete(root);
	else mine = new Map();
	state.sessions.set(root, mine);
	mine.delete(key);
	mine.set(key, now);
	while (mine.size > OUTLINE_OVERLAP_LIMITS.filesPerSession) {
		const oldest = mine.keys().next().value;
		if (oldest === undefined) break;
		mine.delete(oldest);
		dropTouch(oldest, root);
	}
	while (state.sessions.size > OUTLINE_OVERLAP_LIMITS.sessions) {
		const oldest = state.sessions.entries().next();
		if (oldest.done) break;
		const [session, keys] = oldest.value;
		for (const k of keys.keys()) dropTouch(k, session);
		state.sessions.delete(session);
		state.told.delete(session);
		state.doing.delete(session);
	}
	while (state.files.size > OUTLINE_OVERLAP_LIMITS.keys) {
		const oldest = state.files.entries().next();
		if (oldest.done) break;
		const [k, roots] = oldest.value;
		for (const session of roots.keys()) state.sessions.get(session)?.delete(k);
		state.files.delete(k);
	}
}

/** A (file, task) pair of another session that the index names. */
interface Candidate {
	key: string;
	other: string;
	taskId: string;
	at: number;
}

/** Other sessions' records with tasks on these keys, written at or after `since`, newest first. */
function candidatesOn(
	root: string,
	keys: Iterable<string>,
	since: number,
	now: number,
): Candidate[] {
	const from = Math.max(since, now - OUTLINE_OVERLAP_LIMITS.ttlMs);
	const out: Candidate[] = [];
	for (const key of keys) {
		const entries = state.files.get(key);
		if (!entries) continue;
		for (const [other, touch] of entries) {
			if (other === root || touch.at < from) continue;
			for (const taskId of touch.taskIds) out.push({ key, other, taskId, at: touch.at });
		}
	}
	return out.sort((a, b) => b.at - a.at);
}

/** A pair checked against the claims: the task is still in progress, held by that session. */
export interface OutlineOverlap {
	path: string;
	/** The other root session. */
	other: string;
	taskId: string;
	spaceId: string;
	at: number;
}

/**
 * Of the candidates (at most {@link OUTLINE_OVERLAP_LIMITS.verifyTasks} tasks), those whose task
 * is live, in progress, and held by the session (or a subagent of it) that recorded it.
 */
async function verify(store: OutlineStore, candidates: Candidate[]): Promise<OutlineOverlap[]> {
	const ids = [...new Set(candidates.map((c) => c.taskId))].slice(
		0,
		OUTLINE_OVERLAP_LIMITS.verifyTasks,
	);
	if (ids.length === 0) return [];
	const [metas, claims] = await Promise.all([
		store.getBlockMetasByIds(ids),
		store.getTaskClaims(ids),
	]);
	const holders = new Map<string, string>();
	for (const claim of claims)
		if (claim.holderNarratorId) holders.set(claim.taskBlockId, claim.holderNarratorId);
	const roots = await store.getNarratorRoots([...new Set(holders.values())]);
	const live = new Map<string, string>();
	for (const meta of metas)
		if (!meta.deleted && meta.taskJson?.status === "doing") live.set(meta.id, meta.spaceId);
	const out: OutlineOverlap[] = [];
	for (const c of candidates) {
		const spaceId = live.get(c.taskId);
		const holder = holders.get(c.taskId);
		if (!spaceId || !holder) continue;
		const session = roots.get(holder);
		if (!session || session.sessionArchived || session.root !== c.other) continue;
		out.push({ path: pathOf(c.key), other: c.other, taskId: c.taskId, spaceId, at: c.at });
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// A session's tasks in progress and project
// ─────────────────────────────────────────────────────────────────────────────

async function readDoing(store: OutlineStore, root: string): Promise<OutlineSessionTask[]> {
	const claims = await store.listSessionTaskClaims(root, OUTLINE_OVERLAP_LIMITS.claimsRead);
	const ids = claims.map((c) => c.claim.taskBlockId);
	if (ids.length === 0) return [];
	const metas = await store.getBlockMetasByIds(ids);
	return metas
		.filter((m) => !m.deleted && m.taskJson?.status === "doing")
		.slice(0, OUTLINE_OVERLAP_LIMITS.tasksPerWrite)
		.map((m) => ({ taskId: m.id, spaceId: m.spaceId }));
}

/** The tasks in progress a root session (or its subagents) holds, cached briefly. */
export function outlineSessionDoing(
	root: string,
	now = Date.now(),
	store: OutlineStore = outlineStore,
): Promise<OutlineSessionTask[]> {
	const hit = state.doing.get(root);
	if (hit && now - hit.at < OUTLINE_OVERLAP_LIMITS.doingCacheMs) return hit.tasks;
	const tasks = readDoing(store, root).catch((error) => {
		logger.debug("Overlap index: could not read a session's tasks", {
			narratorId: root,
			error: String(error),
		});
		return [] as OutlineSessionTask[];
	});
	state.doing.set(root, { at: now, tasks });
	if (state.doing.size > OUTLINE_OVERLAP_LIMITS.sessions) {
		const oldest = state.doing.keys().next().value;
		if (oldest !== undefined) state.doing.delete(oldest);
	}
	return tasks;
}

function projectOf(root: string, now: number): Promise<string | null> {
	const hit = state.projects.get(root);
	if (hit && now - hit.at < OUTLINE_OVERLAP_LIMITS.doingCacheMs) return hit.projectId;
	const projectId = readNarrator(root)
		.then((row) => (row ? resolveNarratorProjectId(row) : null))
		.catch(() => null);
	state.projects.set(root, { at: now, projectId });
	if (state.projects.size > OUTLINE_OVERLAP_LIMITS.sessions) {
		const oldest = state.projects.keys().next().value;
		if (oldest !== undefined) state.projects.delete(oldest);
	}
	return projectId;
}

/** The root session of an outline session or subagent; null when its tasks are not outline ones. */
async function outlineRootOf(narratorId: string): Promise<string | null> {
	const session = await readTaskSession(narratorId);
	if (!session || session.backend !== "outline") return null;
	return session.sessionNarratorId ?? narratorId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Naming
// ─────────────────────────────────────────────────────────────────────────────

/** The other session's task and title as this session may name them (see the module header). */
export async function describeOutlineOverlaps(
	root: string,
	overlaps: readonly OutlineOverlap[],
	store: OutlineStore = outlineStore,
): Promise<Map<string, { task: OutlineTeamTask | null; session: string | null }>> {
	const out = new Map<string, { task: OutlineTeamTask | null; session: string | null }>();
	if (overlaps.length === 0) return out;
	const spaces = new Map<string, OutlineSpaceRow | null>();
	for (const id of new Set(overlaps.map((o) => o.spaceId)))
		spaces.set(id, await store.getSpace(id));
	const taskIds = [...new Set(overlaps.map((o) => o.taskId))];
	const [metas, heads, names] = await Promise.all([
		store.getBlockMetasByIds(taskIds),
		store.getBlockHeads(taskIds),
		readDisplayNames({ narratorIds: [...new Set(overlaps.map((o) => o.other))] }),
	]);
	const sids = new Map(metas.map((m) => [m.id, m.sid]));
	const titles = new Map(heads.map((h) => [h.id, blockTitle(h.contentHead)]));
	for (const o of overlaps) {
		const space = spaces.get(o.spaceId);
		const readable = space ? await canSessionReadSpace(root, space) : false;
		const sid = sids.get(o.taskId);
		const task =
			readable && space && sid
				? { address: `${space.key}/${sid}`, title: clip(titles.get(o.taskId) ?? "") || sid }
				: null;
		const title = names.narrators.get(o.other);
		const session = (await canSessionReadNarrator(root, o.other)) && title ? clip(title) : null;
		out.set(`${o.other}${SEP}${o.taskId}`, { task, session });
	}
	return out;
}

function clip(text: string, max = 80): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ─────────────────────────────────────────────────────────────────────────────
// What tools and team activity call
// ─────────────────────────────────────────────────────────────────────────────

function wasTold(root: string, pair: string, now: number): boolean {
	const at = state.told.get(root)?.get(pair);
	return at !== undefined && now - at < OUTLINE_OVERLAP_LIMITS.toldMs;
}

function markTold(root: string, pairs: readonly string[], now: number): void {
	let told = state.told.get(root);
	if (!told) {
		told = new Map();
		state.told.set(root, told);
	}
	for (const pair of pairs) {
		told.delete(pair);
		told.set(pair, now);
	}
	for (const [pair, at] of told) {
		if (
			told.size <= OUTLINE_OVERLAP_LIMITS.toldPerSession &&
			now - at < OUTLINE_OVERLAP_LIMITS.toldMs
		)
			break;
		told.delete(pair);
	}
}

export interface OutlineFileChange {
	/** The narrator whose tool wrote (a session or a subagent). */
	narratorId: string;
	/** Its main project, when the caller knows it (the tool context does). */
	projectId?: string | null;
	/** The working directory the path is relative to (the session's, or the remote target's). */
	cwd: string;
	filePaths: readonly string[];
	backend: OutlineOverlapBackend;
	locale: Locale | string;
	/** Answer with the hint (Write, Edit); false records only (Bash). */
	hint: boolean;
	now?: number;
	store?: OutlineStore;
}

/**
 * Record files a session's tool changed and, for a single file when `hint` is set, the line its
 * result ends with (null: nothing to say). Never throws: the index is a convenience.
 */
export async function noteOutlineFileChange(change: OutlineFileChange): Promise<string | null> {
	try {
		if (!isOutlineEnabled()) return null;
		const store = change.store ?? outlineStore;
		const now = change.now ?? Date.now();
		const root = await outlineRootOf(change.narratorId);
		if (!root) return null;
		const projectId = change.projectId ?? (await projectOf(root, now));
		if (!projectId) return null;
		const keys: string[] = [];
		for (const filePath of change.filePaths.slice(0, OUTLINE_OVERLAP_LIMITS.filesPerCall)) {
			const path = await outlineOverlapPath(change.backend, change.cwd, filePath, now);
			if (path) keys.push(keyOf(projectId, path));
		}
		if (keys.length === 0) return null;
		const doing = await outlineSessionDoing(root, now, store);
		for (const key of keys)
			recordOutlineTouch(
				root,
				key,
				doing.map((t) => t.taskId),
				now,
			);
		if (!change.hint || keys.length !== 1) return null;
		const fresh = candidatesOn(root, keys, 0, now).filter(
			(c) => !wasTold(root, `${c.key}${SEP}${c.taskId}`, now),
		);
		if (fresh.length === 0) return null;
		const verified = await verify(store, fresh);
		if (verified.length === 0) return null;
		const key = keys[0] as string;
		markTold(
			root,
			verified.map((o) => `${key}${SEP}${o.taskId}`),
			now,
		);
		const first = verified[0] as OutlineOverlap;
		const named = (await describeOutlineOverlaps(root, [first], store)).get(
			`${first.other}${SEP}${first.taskId}`,
		);
		const locale: Locale = change.locale === "zh-CN" ? "zh-CN" : "en";
		return getOutlineOverlapHint(
			{
				task: named?.task ?? null,
				session: named?.session ?? null,
				path: first.path,
				more: verified.length - 1,
			},
			locale,
		);
	} catch (error) {
		logger.debug("Overlap index: a file change was not recorded", {
			narratorId: change.narratorId,
			error: String(error),
		});
		return null;
	}
}

/**
 * Files `root` changed that another root session's task in progress also changed at or after
 * `since` (ms), checked against the claims, newest first, at most `limit`: the files part of the
 * team activity (`team-activity.ts`).
 */
export async function readOutlineFileOverlaps(
	root: string,
	since: number,
	options: { now?: number; limit?: number; store?: OutlineStore } = {},
): Promise<OutlineOverlap[]> {
	const mine = state.sessions.get(root);
	if (!mine || mine.size === 0) return [];
	const now = options.now ?? Date.now();
	const candidates = candidatesOn(root, mine.keys(), since, now);
	if (candidates.length === 0) return [];
	const verified = await verify(options.store ?? outlineStore, candidates);
	// One line per (file, other task).
	const seen = new Set<string>();
	const out: OutlineOverlap[] = [];
	for (const o of verified) {
		const pair = `${o.path}${SEP}${o.taskId}`;
		if (seen.has(pair)) continue;
		seen.add(pair);
		out.push(o);
		if (out.length >= (options.limit ?? 5)) break;
	}
	return out;
}

if (hotOnce("narrafork.outlineOverlap.listeners")) {
	// A session's own commit may have started or ended a task: its tasks in progress are read again
	// at its next write rather than after the cache runs out.
	eventBus.on("outline:committed", (event) => {
		const writer = event.narratorId;
		if (!writer) return;
		state.doing.delete(writer);
		void readTaskSession(writer)
			.then((session) => {
				if (session?.sessionNarratorId) state.doing.delete(session.sessionNarratorId);
			})
			.catch(() => {});
	});
}
