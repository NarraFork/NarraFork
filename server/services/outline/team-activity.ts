/**
 * Team activity (团队动态, outline P2 PR 10b, design §2.5): at the start of every run of an outline
 * session, and at most every {@link OUTLINE_TEAM_ACTIVITY_LIMITS.cadenceMs} at a tool boundary of a
 * long run, one `sys` row that says what OTHERS did since the session last looked, around what the
 * session works on. Nothing to say: no row. It never wakes a session.
 *
 * WHAT IT COVERS: {@link OUTLINE_TEAM_ACTIVITY_SCOPE}, the one place that decides (owner decision
 * Q5 is still open; this is the design note's recommendation A):
 *   1. the session's related task trees in project spaces: the trees (up to the topmost task below
 *      the page) of the tasks it holds, manages (`task_json.manager`), is assigned
 *      (`@agent:<its id or handle>`) or wrote in the last 7 days; in them, others' status changes,
 *      hand-overs, new subtasks, notes (counted), reports attached (counted), answers (counted);
 *   2. the project task page (alias `tasks`): task-level changes (new, started, done, cancelled,
 *      reopened, handed over, put in the claim pool) outside those trees, at most 8 lines;
 *   3. files it changed that another session's task in progress changed since (`overlap.ts`).
 *
 * WHAT IT LEAVES OUT (noise): the session's own commits and its subagents'; a person's change to a
 * task the session holds or held last (PR 5's notice already told it, `outline-task-edits.ts`);
 * people tidying (rewording, moving, reordering: not task events); session spaces (the session's
 * own place; people's changes there are PR 5's). The design's "what team rows already told it"
 * excludes nothing yet: the team channel is PR 10a.
 *
 * WHERE IT GOES (prompt cache): appended to the history as a persisted `sys` row
 * (`outline_team_activity`), never into the system prompt, the tool definitions or a named
 * context part. The text is deterministic (no relative times, no lease times): rebuilding the
 * history or retrying a request sends the same bytes, and the system prompt of two runs is
 * byte-identical whatever the team did.
 *   - Run start (`prepareOutlineRun`): written with `schedule: none` before the first prefix is
 *     prepared, so the run's history read already carries it.
 *   - Tool boundary (`drainInjectionsIntoHistory`): `onNextTurn`, only once
 *     {@link OUTLINE_TEAM_ACTIVITY_LIMITS.cadenceMs} passed since the last look, and only when there
 *     is something new.
 *
 * WINDOW: per (session, space) a seq cursor in memory. The first look (a new process, a new
 * session, a fork) starts at the end of the session's last finished run, or its creation, at most
 * {@link OUTLINE_TEAM_ACTIVITY_LIMITS.lookbackMs} back, found by a search over the commits' seq
 * index. A space whose `next_seq` is the cursor reads nothing.
 *
 * BUDGET: at most {@link OUTLINE_TEAM_ACTIVITY_LIMITS.bytes} UTF-8 bytes and
 * {@link OUTLINE_TEAM_ACTIVITY_LIMITS.lines} lines of model text, a tree at most
 * {@link OUTLINE_TEAM_ACTIVITY_LIMITS.linesPerTree} lines, titles cut at 80 characters; what does
 * not fit is counted in a last line that says where to read on.
 *
 * NAMES: another session by its title only where everyone who reads this session may read it
 * (`canSessionReadNarrator`), else "another session"; a person by their username; spaces only
 * when the session may read them.
 *
 * READS (bounded, indexed, SQLite and PostgreSQL alike): per space (at most
 * {@link OUTLINE_TEAM_ACTIVITY_LIMITS.spaces}) the newest
 * {@link OUTLINE_TEAM_ACTIVITY_LIMITS.commitsPerSpace} commits of the window at most, their
 * versions without content oldest first, {@link OUTLINE_TEAM_ACTIVITY_LIMITS.versionsPerRead} a read
 * and {@link OUTLINE_TEAM_ACTIVITY_LIMITS.readsPerSpace} reads at most (a read stops before a commit
 * it cannot take whole, so the next one starts there; one commit larger than a read is taken up to
 * the limit); when the reads run out first, the space's cursor stays after the last commit read
 * whole and the next look goes on from there. Then those commits, the related tasks (claims by
 * holder, open tasks, the session's recent writes), only the versions on the pages of the related
 * trees and the task page, the versions before them by primary key, ancestors by primary key,
 * claims of changed tasks, at most {@link OUTLINE_TEAM_ACTIVITY_LIMITS.heads} titles. Older commits
 * of a busy window are passed over, uncounted. The session runtime runs on SQLite only, so rows
 * are written there; the reads are shared with PostgreSQL and tested on both.
 */
import { hotSafe } from "@server/lib/hot-safe";
import type { Locale } from "@server/lib/i18n";
import { logger } from "@server/lib/logger";
import {
	getOutlineTeamActivityHeading,
	getOutlineTeamActivityMore,
	type OutlineTeamActor,
	type OutlineTeamEvent,
	type OutlineTeamLine,
	type OutlineTeamTask,
	outlineTeamLineText,
} from "@server/lib/prompts/outline-team";
import { blockTitle } from "@shared/outline";
import {
	boundOutlineTaskNoticeItem,
	type OutlineTaskNoticeChange,
	type OutlineTaskNoticeItem,
} from "@shared/outline-task-notice";
import type { SideCarBody } from "@shared/sidecar-body";
import { resolveNarratorProjectId } from "../narrator-project";
import { readTaskSession } from "../task-source/backend";
import { readDisplayNames, readNarrator, readTeamActivityFacts } from "./access-reads";
import { OUTLINE_DIGEST_REPORT_ACTOR, taskTransition } from "./digest";
import { seqBefore } from "./digest-job";
import { isOutlineEnabled } from "./feature";
import { OUTLINE_CHANGE, OUTLINE_TASKS_PAGE_ALIAS, type OutlineTaskJson } from "./model";
import { describeOutlineOverlaps, readOutlineFileOverlaps } from "./overlap";
import { canSessionReadNarrator, canSessionReadSpace } from "./session-scope";
import { outlineStore } from "./store";
import type { OutlineRangeChange } from "./store/digest-port";
import type {
	OutlineBlockMeta,
	OutlineCommitRow,
	OutlineSpaceRow,
	OutlineStore,
	OutlineTaskClaimRow,
} from "./store/port";

/** The injection source of the row (`docs/INJECTION.md`). */
export const OUTLINE_TEAM_ACTIVITY_SOURCE = "outline_team_activity";

const DAY_MS = 24 * 60 * 60_000;

/**
 * WHAT TEAM ACTIVITY COVERS: the one place to change it (owner decision Q5 is open; this is the
 * design note's recommendation A). Each part can be switched off or narrowed here alone.
 */
export const OUTLINE_TEAM_ACTIVITY_SCOPE = {
	/** The trees of the session's related tasks in project spaces, and why a task is related. */
	trees: {
		/** Tasks the session (or a subagent of it) holds. */
		held: true,
		/** Open tasks it manages (`task_json.manager` is it or a subagent of it). */
		managed: true,
		/** Open tasks assigned to it (`@agent:<its id>` or `@agent:<its handle>`). */
		assigned: true,
		/** Tasks (or blocks under tasks) it wrote this recently; 0: none. */
		recentWorkMs: 7 * DAY_MS,
	},
	/** Task-level changes on the project task page outside those trees; 0 lines: off. */
	taskPage: { lines: 8 },
	/** Files the session changed that another session's task in progress changed since; 0: off. */
	files: { lines: 5 },
	/** Session spaces never: the session's own place, and people's changes there are PR 5's. */
	sessionSpaces: false,
} as const;

export const OUTLINE_TEAM_ACTIVITY_LIMITS = {
	/** UTF-8 bytes of the model text (design §7.2). */
	bytes: 4 * 1024,
	/** Lines listed (besides the heading and the count). */
	lines: 20,
	/** Lines one tree takes at most. */
	linesPerTree: 5,
	/** Characters of a title or a name. */
	titleChars: 80,
	/** Spaces read: the main project's, and those of tasks the session holds. */
	spaces: 3,
	/** Newest commits of a space read per look; older ones are counted. */
	commitsPerSpace: 50,
	/** Versions of those commits one read takes (without content), and reads a space gets a look. */
	versionsPerRead: 300,
	readsPerSpace: 3,
	/** Titles read per look. */
	heads: 30,
	/** Trees per space. */
	trees: 12,
	/** Ancestor levels walked, and blocks read doing it. */
	depth: 16,
	ancestors: 400,
	/** Claims of the session read; open tasks of a space read for managed or assigned ones. */
	claims: 50,
	openTasks: 200,
	/** The session's newest commits per space read for its recent work, and their versions. */
	recentCommits: 30,
	recentVersions: 200,
	/** How far back a first look goes. */
	lookbackMs: 2 * 60 * 60_000,
	/** A long run looks again at a tool boundary at most this often. */
	cadenceMs: 10 * 60_000,
	/** Sessions whose cursors are kept. */
	sessions: 2_000,
} as const;

/** One session's looks: per space the seq it has seen, and when it last looked. */
interface SessionState {
	cursors: Map<string, { seq: number; at: number }>;
	lastLookAt: number;
	/** Overlaps of files are told from this time on (ms). */
	filesSince: number;
}

const state = hotSafe("narrafork.outlineTeamActivity", () => ({
	sessions: new Map<string, SessionState>(),
}));

/** Forget every session's cursors (tests; a new process starts this way). */
export function resetOutlineTeamActivityForTests(): void {
	state.sessions.clear();
}

function sessionState(narratorId: string): SessionState | undefined {
	const found = state.sessions.get(narratorId);
	if (found) {
		state.sessions.delete(narratorId);
		state.sessions.set(narratorId, found);
	}
	return found;
}

function keepSessionState(narratorId: string, value: SessionState): void {
	state.sessions.delete(narratorId);
	state.sessions.set(narratorId, value);
	while (state.sessions.size > OUTLINE_TEAM_ACTIVITY_LIMITS.sessions) {
		const oldest = state.sessions.keys().next().value;
		if (oldest === undefined) break;
		state.sessions.delete(oldest);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// What one look found
// ─────────────────────────────────────────────────────────────────────────────

/** A line before it is named: block ids and actor keys, resolved to text at the end. */
type Draft =
	| {
			where: "tree" | "page";
			spaceId: string;
			treeId: string | null;
			actor: string;
			event:
				| { kind: "done" | "cancelled" | "started" | "reopened"; taskId: string }
				| { kind: "assigned"; taskId: string; to: string }
				| { kind: "added"; taskId: string; claimable: boolean }
				| { kind: "claimable"; taskId: string }
				| { kind: "notes" | "reports" | "answers"; n: number };
			/** For the reader's chips: the status before and after. */
			from?: string | null;
			to?: string;
	  }
	| { where: "file"; spaceId: string; other: string; taskId: string; path: string };

/** `kind:id` of an actor: `s:<root session>`, `h:<user>`, `x` for the system. */
type ActorKey = string;

interface SpaceLook {
	drafts: Draft[];
	/** The last seq read whole: where the space's cursor goes. */
	readThrough: number;
	/** Blocks of this space that drafts name, with their metas. */
	metas: Map<string, OutlineBlockMeta>;
	/** The task page, for "read on". */
	taskPageId: string | null;
}

interface LookContext {
	store: OutlineStore;
	root: string;
	handle: string | null;
	/** Claims the session (or its subagents) holds: what it is doing, and where. */
	held: Array<{ claim: OutlineTaskClaimRow; spaceId: string }>;
	now: number;
}

/** Ancestors of blocks up to their page, by primary key level by level, bounded. */
async function withAncestors(
	store: OutlineStore,
	ids: Iterable<string>,
	metas: Map<string, OutlineBlockMeta>,
): Promise<void> {
	let frontier = [...new Set(ids)].filter((id) => !metas.has(id));
	for (let level = 0; level < OUTLINE_TEAM_ACTIVITY_LIMITS.depth && frontier.length > 0; level++) {
		const room = OUTLINE_TEAM_ACTIVITY_LIMITS.ancestors - metas.size;
		if (room <= 0) return;
		const read = await store.getBlockMetasByIds(frontier.slice(0, room));
		for (const meta of read) metas.set(meta.id, meta);
		frontier = [
			...new Set(
				read.flatMap((m) => (m.parentId !== null && !metas.has(m.parentId) ? [m.parentId] : [])),
			),
		];
	}
}

/**
 * The tree a block is in: its topmost task ancestor below the page (itself when it is that task),
 * or null when no task is above it (or the chain is not known).
 */
function treeOf(blockId: string, metas: Map<string, OutlineBlockMeta>): string | null {
	const meta = metas.get(blockId);
	return meta
		? treeFrom({ id: meta.id, parentId: meta.parentId, task: meta.taskJson !== null }, metas)
		: null;
}

/** {@link treeOf} of a block known by its parent (a version): only its ancestors are read. */
function treeFrom(
	block: { id: string; parentId: string | null; task: boolean },
	metas: Map<string, OutlineBlockMeta>,
): string | null {
	if (block.parentId === null) return null;
	let top: string | null = block.task ? block.id : null;
	let current = metas.get(block.parentId);
	for (let i = 0; current && i <= OUTLINE_TEAM_ACTIVITY_LIMITS.depth; i++) {
		if (current.parentId === null) return top;
		if (current.taskJson) top = current.id;
		current = metas.get(current.parentId);
	}
	return null;
}

/** The roots of these narrators (a subagent's session; anyone else themselves). */
async function rootsOf(store: OutlineStore, ids: Iterable<string>): Promise<Map<string, string>> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return new Map();
	const sessions = await store.getNarratorRoots(unique);
	return new Map(unique.map((id) => [id, sessions.get(id)?.root ?? id]));
}

/**
 * The session a commit is the work of: an agent's, or a system write made for a session. A
 * person's commit is the person's, even made for a session (a plan locked for it).
 */
function writerOf(commit: OutlineCommitRow): string | null {
	if (commit.actorKind === "human") return null;
	return commit.narratorId ?? (commit.actorKind === "agent" ? commit.actorId : null);
}

/** The session's related tasks in a space, most related first (see the scope). */
async function relatedTasks(ctx: LookContext, space: OutlineSpaceRow): Promise<string[]> {
	const { store, root } = ctx;
	const scope = OUTLINE_TEAM_ACTIVITY_SCOPE.trees;
	const out: string[] = [];
	if (scope.held)
		for (const h of ctx.held) if (h.spaceId === space.id) out.push(h.claim.taskBlockId);
	if (scope.managed || scope.assigned) {
		const open = await store.listOpenTasks(space.id, OUTLINE_TEAM_ACTIVITY_LIMITS.openTasks);
		const assignees = new Set([`agent:${root}`, ...(ctx.handle ? [`agent:${ctx.handle}`] : [])]);
		const managers = await rootsOf(
			store,
			open.flatMap((t) => (t.taskJson?.manager?.kind === "agent" ? [t.taskJson.manager.id] : [])),
		);
		for (const task of open) {
			const json = task.taskJson;
			if (!json) continue;
			if (scope.assigned && json.assignee && assignees.has(json.assignee)) out.push(task.id);
			else if (
				scope.managed &&
				json.manager?.kind === "agent" &&
				managers.get(json.manager.id) === root
			)
				out.push(task.id);
		}
	}
	if (scope.recentWorkMs > 0) {
		const writes = await store.listNarratorWrites(space.id, root, {
			commits: OUTLINE_TEAM_ACTIVITY_LIMITS.recentCommits,
			limit: OUTLINE_TEAM_ACTIVITY_LIMITS.recentVersions,
		});
		for (const w of writes)
			if (ctx.now - Date.parse(w.createdAt) <= scope.recentWorkMs) out.push(w.blockId);
	}
	return [...new Set(out)];
}

/** The version of a block before a seq: in the window, or before it (`prior`). */
function chainOf(
	versions: readonly OutlineRangeChange[],
	prior: OutlineTaskJson | null,
): Array<{ v: OutlineRangeChange; before: OutlineTaskJson | null; created: boolean }> {
	const out: Array<{ v: OutlineRangeChange; before: OutlineTaskJson | null; created: boolean }> =
		[];
	let before = prior;
	for (const v of versions) {
		const created = (v.changeFlags & OUTLINE_CHANGE.CREATE) !== 0;
		out.push({ v, before: created ? null : before, created });
		before = v.deleted ? null : v.taskJson;
	}
	return out;
}

/**
 * The versions of the commits `(from, to]` of a space, oldest first, in reads of at most
 * {@link OUTLINE_TEAM_ACTIVITY_LIMITS.versionsPerRead}, at most
 * {@link OUTLINE_TEAM_ACTIVITY_LIMITS.readsPerSpace} reads; and the last seq read whole.
 */
async function readWindow(
	store: OutlineStore,
	spaceId: string,
	from: number,
	to: number,
): Promise<{ rows: OutlineRangeChange[]; readThrough: number }> {
	const per = OUTLINE_TEAM_ACTIVITY_LIMITS.versionsPerRead;
	const rows: OutlineRangeChange[] = [];
	let after = from;
	for (let n = 0; n < OUTLINE_TEAM_ACTIVITY_LIMITS.readsPerSpace; n++) {
		const read = await store.listCommitRangeChanges(spaceId, after, to, per + 1);
		if (read.length <= per) {
			rows.push(...read);
			return { rows, readThrough: to };
		}
		// The read stopped inside the commit of its last row: take the commits before it whole and
		// start the next read at it. One commit larger than a read is taken up to the limit.
		const cut = (read[per] as OutlineRangeChange).seq;
		const whole = read.filter((r) => r.seq < cut);
		if (whole.length === 0) {
			rows.push(...read.slice(0, per));
			after = cut;
		} else {
			rows.push(...whole);
			after = cut - 1;
		}
	}
	return { rows, readThrough: after };
}

/** What one space's window says, for the session (see the module header). */
async function lookAtSpace(
	ctx: LookContext,
	space: OutlineSpaceRow,
	from: number,
	to: number,
): Promise<SpaceLook> {
	const { store, root } = ctx;
	const { rows: changes, readThrough } = await readWindow(store, space.id, from, to);
	const look: SpaceLook = { drafts: [], readThrough, metas: new Map(), taskPageId: null };
	if (changes.length === 0) return look;
	const commits = new Map(
		(await store.getCommitsBySeqs(space.id, [...new Set(changes.map((c) => c.seq))])).map((c) => [
			c.seq,
			c,
		]),
	);
	const writerRoots = await rootsOf(
		store,
		[...commits.values()].flatMap((c) => {
			const w = writerOf(c);
			return w ? [w] : [];
		}),
	);
	const actorOf = (commit: OutlineCommitRow): ActorKey | null => {
		const writer = writerOf(commit);
		if (writer) {
			const r = writerRoots.get(writer) ?? writer;
			return r === root ? null : `s:${r}`;
		}
		return commit.actorKind === "human" ? `h:${commit.actorId}` : "x";
	};
	// Others' versions only; the session's own (and its subagents') are not news to it.
	const others = changes.filter((c) => {
		const commit = commits.get(c.seq);
		return commit !== undefined && actorOf(commit) !== null;
	});
	if (others.length === 0) return look;

	const [taskPage] = await store.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
	look.taskPageId = taskPage?.id ?? null;
	const related = await relatedTasks(ctx, space);
	await withAncestors(store, related, look.metas);
	const trees = new Set<string>();
	for (const id of related) {
		if (trees.size >= OUTLINE_TEAM_ACTIVITY_LIMITS.trees) break;
		const tree = treeOf(id, look.metas);
		if (tree) trees.add(tree);
	}
	// Only the pages of those trees and the task page can say anything: the rest are not read on.
	const pages = new Set<string>();
	for (const tree of trees) {
		const page = look.metas.get(tree)?.pageId;
		if (page) pages.add(page);
	}
	if (look.taskPageId && OUTLINE_TEAM_ACTIVITY_SCOPE.taskPage.lines > 0) pages.add(look.taskPageId);
	const onPages = others.filter((c) => pages.has(c.pageId));
	if (onPages.length === 0) return look;
	// A changed block is placed by the parent its version had: only parents and their ancestors
	// are read (a commit of 400 notes under one task reads that task's chain once).
	await withAncestors(
		store,
		onPages.flatMap((c) => (c.parentId ? [c.parentId] : [])),
		look.metas,
	);
	const treeOfChange = (c: OutlineRangeChange): string | null => {
		const t = treeFrom(
			{ id: c.blockId, parentId: c.parentId, task: !c.deleted && c.taskJson !== null },
			look.metas,
		);
		return t !== null && trees.has(t) ? t : null;
	};
	const onTaskPage = (c: OutlineRangeChange) =>
		OUTLINE_TEAM_ACTIVITY_SCOPE.taskPage.lines > 0 &&
		look.taskPageId !== null &&
		c.pageId === look.taskPageId;
	const wanted = onPages.filter((c) => treeOfChange(c) !== null || onTaskPage(c));
	if (wanted.length === 0) return look;

	// Every version of the blocks wanted, in order, and the version before the window.
	const byBlock = new Map<string, OutlineRangeChange[]>();
	const wantedIds = new Set(wanted.map((c) => c.blockId));
	for (const c of changes) {
		if (!wantedIds.has(c.blockId)) continue;
		const list = byBlock.get(c.blockId);
		if (list) list.push(c);
		else byBlock.set(c.blockId, [c]);
	}
	const priorWanted = [...byBlock.entries()]
		.filter(
			([, list]) => ((list[0] as OutlineRangeChange).changeFlags & OUTLINE_CHANGE.CREATE) === 0,
		)
		.map(([blockId]) => ({ blockId, seq: from }));
	const prior = new Map(
		(from > 0 && priorWanted.length > 0 ? await store.listVersionMetasAt(priorWanted) : []).map(
			(m) => [m.blockId, m.deleted ? null : m.taskJson],
		),
	);
	// A person's change to a task the session holds or held last: PR 5 told it already.
	const claims = new Map(
		(await store.getTaskClaims([...byBlock.keys()])).map((c) => [c.taskBlockId, c]),
	);
	const holderRoots = await rootsOf(
		store,
		[...claims.values()].flatMap((c) => {
			const h = c.holderNarratorId ?? c.lastHolderNarratorId;
			return h ? [h] : [];
		}),
	);
	const toldByPeopleEdits = (taskId: string): boolean => {
		const claim = claims.get(taskId);
		const holder = claim ? (claim.holderNarratorId ?? claim.lastHolderNarratorId) : null;
		return holder !== null && (holderRoots.get(holder) ?? holder) === root;
	};

	const counts = new Map<string, { draft: Draft & { where: "tree" }; n: number }>();
	const statusAt = new Map<string, number>();
	for (const [blockId, list] of byBlock) {
		for (const { v, before, created } of chainOf(list, prior.get(blockId) ?? null)) {
			const commit = commits.get(v.seq);
			const actor = commit ? actorOf(commit) : null;
			if (!commit || !actor) continue;
			const tree = treeOfChange(v);
			const page = onTaskPage(v);
			if (tree === null && !page) continue;
			const where = tree !== null ? "tree" : "page";
			const after = v.deleted ? null : v.taskJson;
			const base = { where, spaceId: space.id, treeId: tree, actor } as const;
			const count = (kind: "notes" | "reports" | "answers") => {
				if (where !== "tree" || tree === null) return;
				const key = `${tree}\u0000${actor}\u0000${kind}`;
				const found = counts.get(key);
				if (found) found.n++;
				else {
					const draft = { ...base, where: "tree" as const, event: { kind, n: 1 } };
					counts.set(key, { draft, n: 1 });
					look.drafts.push(draft);
				}
			};
			if (v.hasAsk) {
				if (commit.kind === "answer") count("answers");
				continue;
			}
			if (created && !after) {
				if (!v.deleted)
					count(
						commit.actorKind === "system" && commit.actorId === OUTLINE_DIGEST_REPORT_ACTOR
							? "reports"
							: "notes",
					);
				continue;
			}
			if (!after && !before) continue;
			const person = commit.actorKind === "human";
			if (person && toldByPeopleEdits(blockId)) continue;
			if (created) {
				look.drafts.push({
					...base,
					event: { kind: "added", taskId: blockId, claimable: after?.claimable === true },
					to: after?.status ?? "todo",
				});
				continue;
			}
			const t = taskTransition(before, after, false);
			const status = t.event ?? (t.started ? "started" : null);
			if (status) {
				// One status line per (task, actor): the last one says where it ended.
				const key = `${blockId}\u0000${actor}`;
				const at = statusAt.get(key);
				const draft: Draft = {
					...base,
					event: { kind: status, taskId: blockId },
					from: before?.status ?? null,
					to: after?.status ?? "todo",
				};
				if (at !== undefined) look.drafts[at] = draft;
				else {
					statusAt.set(key, look.drafts.length);
					look.drafts.push(draft);
				}
			}
			if (t.assignedTo)
				look.drafts.push({
					...base,
					event: { kind: "assigned", taskId: blockId, to: t.assignedTo },
				});
			if (after?.claimable === true && before?.claimable !== true)
				look.drafts.push({ ...base, event: { kind: "claimable", taskId: blockId } });
		}
	}
	for (const { draft, n } of counts.values())
		if (
			draft.event.kind === "notes" ||
			draft.event.kind === "reports" ||
			draft.event.kind === "answers"
		)
			draft.event = { kind: draft.event.kind, n };
	return look;
}

// ─────────────────────────────────────────────────────────────────────────────
// Naming and the budget
// ─────────────────────────────────────────────────────────────────────────────

function clip(text: string, max: number = OUTLINE_TEAM_ACTIVITY_LIMITS.titleChars): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const utf8 = new TextEncoder();
const bytesOf = (text: string) => utf8.encode(text).length;

/** What a look made of the session's window: the row to write, or null for nothing to say. */
export interface OutlineTeamActivity {
	content: string;
	body: SideCarBody;
	/** Lines listed and changes counted without a line. */
	listed: number;
	more: number;
}

interface Named {
	text: OutlineTeamLine;
	item: OutlineTaskNoticeItem | null;
}

/**
 * Read what others did since the session's cursors (moving them on) and word it. Reads only the
 * outline and access facts; writes nothing but the cursors in memory.
 */
export async function readOutlineTeamActivity(
	narratorId: string,
	options: { locale: Locale; now?: number; store?: OutlineStore },
): Promise<OutlineTeamActivity | null> {
	const store = options.store ?? outlineStore;
	const now = options.now ?? Date.now();
	const locale = options.locale;
	const session = await readTaskSession(narratorId);
	if (!session || session.backend !== "outline" || session.subagent) return null;
	const root = narratorId;
	const [row, facts] = await Promise.all([readNarrator(root), readTeamActivityFacts(root)]);
	if (!row || !facts) return null;
	const lookback = now - OUTLINE_TEAM_ACTIVITY_LIMITS.lookbackMs;
	const previous = sessionState(root);
	const since = Math.max(lookback, Date.parse(facts.lastRunEndedAt ?? facts.createdAt) || lookback);
	const current: SessionState = previous ?? {
		cursors: new Map(),
		lastLookAt: 0,
		filesSince: since,
	};

	// Spaces: the main project's, then those of tasks the session holds (project spaces only).
	const held = await store.listSessionTaskClaims(root, OUTLINE_TEAM_ACTIVITY_LIMITS.claims);
	const projectId = await resolveNarratorProjectId(row);
	const spaces: OutlineSpaceRow[] = [];
	const main = projectId ? await store.findSpace({ kind: "project", projectId }) : null;
	if (main) spaces.push(main);
	for (const spaceId of new Set(held.map((h) => h.spaceId))) {
		if (spaces.length >= OUTLINE_TEAM_ACTIVITY_LIMITS.spaces) break;
		if (spaces.some((s) => s.id === spaceId)) continue;
		const space = await store.getSpace(spaceId);
		if (!space) continue;
		if (space.kind !== "project" && !OUTLINE_TEAM_ACTIVITY_SCOPE.sessionSpaces) continue;
		spaces.push(space);
	}
	const ctx: LookContext = { store, root, handle: facts.handle, held, now };
	const looks: Array<{ space: OutlineSpaceRow; look: SpaceLook }> = [];
	for (const space of spaces) {
		if (!(await canSessionReadSpace(root, space))) continue;
		const latest = space.nextSeq - 1;
		const cursor = current.cursors.get(space.id);
		let from =
			cursor && now - cursor.at <= OUTLINE_TEAM_ACTIVITY_LIMITS.lookbackMs
				? cursor.seq
				: await seqBefore(store, space, since);
		if (latest <= from) {
			current.cursors.set(space.id, { seq: Math.max(from, latest), at: now });
			continue;
		}
		// A busy window: its newest commits only; the older ones are passed over, uncounted.
		if (latest - from > OUTLINE_TEAM_ACTIVITY_LIMITS.commitsPerSpace)
			from = latest - OUTLINE_TEAM_ACTIVITY_LIMITS.commitsPerSpace;
		const look = await lookAtSpace(ctx, space, from, latest);
		// Up to what was read whole: a look cut short goes on from there next time.
		current.cursors.set(space.id, { seq: look.readThrough, at: now });
		looks.push({ space, look });
	}
	// Files, from the time of the last look on.
	const fileLines = OUTLINE_TEAM_ACTIVITY_SCOPE.files.lines;
	const overlaps =
		fileLines > 0
			? await readOutlineFileOverlaps(root, current.filesSince, {
					now,
					limit: fileLines + 1,
					store,
				})
			: [];
	current.filesSince = now;
	current.lastLookAt = now;
	keepSessionState(root, current);

	// A file's line names its task through `overlap.ts`, which reads the task's space itself.
	const drafts: Array<{ space: OutlineSpaceRow | null; draft: Draft }> = [];
	let more = 0;
	// Counted: changes read and found to concern the session that the limits leave out.
	for (const { space, look } of looks) {
		// Trees first, a tree at most `linesPerTree`; then the task page, at most its lines.
		const perTree = new Map<string, number>();
		let page = 0;
		for (const draft of look.drafts) {
			if (draft.where === "tree" && draft.treeId) {
				const n = perTree.get(draft.treeId) ?? 0;
				if (n >= OUTLINE_TEAM_ACTIVITY_LIMITS.linesPerTree) {
					more++;
					continue;
				}
				perTree.set(draft.treeId, n + 1);
			} else if (draft.where === "page") {
				if (page >= OUTLINE_TEAM_ACTIVITY_SCOPE.taskPage.lines) {
					more++;
					continue;
				}
				page++;
			}
			drafts.push({ space, draft });
		}
	}
	// Trees, then the task page, then files; a tree's lines together, trees in the order first met.
	const treeRank = new Map<string, number>();
	for (const { draft } of drafts)
		if (draft.where === "tree" && draft.treeId && !treeRank.has(draft.treeId))
			treeRank.set(draft.treeId, treeRank.size);
	const rank = (draft: Draft) =>
		draft.where === "tree" && draft.treeId ? (treeRank.get(draft.treeId) ?? 0) : 0;
	drafts.sort((a, b) => order(a.draft) - order(b.draft) || rank(a.draft) - rank(b.draft));
	for (const [index, o] of overlaps.entries()) {
		if (index >= fileLines) {
			more++;
			continue;
		}
		drafts.push({
			space: null,
			draft: { where: "file", spaceId: o.spaceId, other: o.other, taskId: o.taskId, path: o.path },
		});
	}
	if (drafts.length === 0) return null;

	const named = await nameDrafts(store, root, drafts, looks, overlaps, locale);
	// The budget: lines and bytes, the heading and a count line included.
	const heading = getOutlineTeamActivityHeading(locale);
	const taskPage = await taskPageOf(store, main, looks, locale);
	const lines: string[] = [];
	const items: OutlineTaskNoticeItem[] = [];
	let left = more + (named.length - named.filter(Boolean).length);
	const listed = named.filter((n): n is Named => n !== null);
	for (const [index, entry] of listed.entries()) {
		const text = outlineTeamLineText(entry.text, locale);
		const rest = listed.length - index - 1 + left;
		const tail = rest > 0 ? getOutlineTeamActivityMore(rest + 1, taskPage, locale) : "";
		const size = bytesOf([heading, ...lines, text, tail].filter(Boolean).join("\n"));
		if (
			lines.length >= OUTLINE_TEAM_ACTIVITY_LIMITS.lines ||
			size > OUTLINE_TEAM_ACTIVITY_LIMITS.bytes
		) {
			left += listed.length - index;
			break;
		}
		lines.push(text);
		if (entry.item) items.push(entry.item);
	}
	if (lines.length === 0) return null;
	const content = [
		heading,
		...lines,
		...(left > 0 ? [getOutlineTeamActivityMore(left, taskPage, locale)] : []),
	].join("\n");
	return {
		content,
		body: {
			kind: "outlineTasks",
			variant: "activity",
			items,
			...(left + (lines.length - items.length) > 0
				? { more: left + (lines.length - items.length) }
				: {}),
		},
		listed: lines.length,
		more: left,
	};
}

/** The main project's task page, where a count line says to read on (null: none). */
async function taskPageOf(
	store: OutlineStore,
	main: OutlineSpaceRow | null,
	looks: ReadonlyArray<{ space: OutlineSpaceRow; look: SpaceLook }>,
	locale: Locale,
): Promise<OutlineTeamTask | null> {
	if (!main) return null;
	const look = looks.find((l) => l.space.id === main.id)?.look;
	const pageId =
		look?.taskPageId ?? (await store.findAliasOwners(main.id, [OUTLINE_TASKS_PAGE_ALIAS]))[0]?.id;
	if (!pageId) return null;
	const sid =
		look?.metas.get(pageId)?.sid ?? (await store.getBlockMetasByIds([pageId]))[0]?.sid ?? null;
	return sid
		? { address: `${main.key}/${sid}`, title: locale === "zh-CN" ? "任务" : "tasks" }
		: null;
}

/** Trees, then the task page, then files. */
function order(draft: Draft): number {
	return draft.where === "tree" ? 0 : draft.where === "page" ? 1 : 2;
}

/** Name every draft (null: a draft that names a task without a title read: counted instead). */
async function nameDrafts(
	store: OutlineStore,
	root: string,
	drafts: ReadonlyArray<{ space: OutlineSpaceRow | null; draft: Draft }>,
	looks: ReadonlyArray<{ space: OutlineSpaceRow; look: SpaceLook }>,
	overlaps: Awaited<ReturnType<typeof readOutlineFileOverlaps>>,
	locale: Locale,
): Promise<Array<Named | null>> {
	const metas = new Map<string, OutlineBlockMeta>();
	for (const { look } of looks) for (const [id, meta] of look.metas) metas.set(id, meta);
	// Titles of the tasks the lines name, at most `heads`.
	const titleIds: string[] = [];
	for (const { draft } of drafts) {
		if (draft.where === "file") continue;
		if (draft.treeId) titleIds.push(draft.treeId);
		if ("taskId" in draft.event) titleIds.push(draft.event.taskId);
	}
	const wanted = [...new Set(titleIds)].slice(0, OUTLINE_TEAM_ACTIVITY_LIMITS.heads);
	const missing = wanted.filter((id) => !metas.has(id));
	if (missing.length > 0)
		for (const meta of await store.getBlockMetasByIds(missing)) metas.set(meta.id, meta);
	const titles = new Map(
		(wanted.length > 0 ? await store.getBlockHeads(wanted) : []).map((h) => [
			h.id,
			clip(blockTitle(h.contentHead)),
		]),
	);
	const spaceKeys = new Map(
		drafts.flatMap(({ space }) => (space ? [[space.id, space.key] as const] : [])),
	);
	const taskOf = (id: string, spaceId: string): OutlineTeamTask | null => {
		const meta = metas.get(id);
		const key = spaceKeys.get(spaceId);
		if (!meta || !key || !titles.has(id)) return null;
		return { address: `${key}/${meta.sid}`, title: titles.get(id) || meta.sid };
	};
	// Who: sessions this session may name, people by username.
	const sessionIds = new Set<string>();
	const userIds = new Set<string>();
	for (const { draft } of drafts) {
		const actor = draft.where === "file" ? `s:${draft.other}` : draft.actor;
		if (actor.startsWith("s:")) sessionIds.add(actor.slice(2));
		else if (actor.startsWith("h:")) userIds.add(actor.slice(2));
		if (draft.where !== "file" && draft.event.kind === "assigned") {
			const to = draft.event.to;
			if (to.startsWith("agent:")) sessionIds.add(to.slice("agent:".length));
		}
	}
	const names = await readDisplayNames({ narratorIds: [...sessionIds], userIds: [...userIds] });
	const nameable = new Map<string, string | null>();
	for (const id of sessionIds) {
		const title = names.narrators.get(id);
		nameable.set(
			id,
			title !== undefined && (await canSessionReadNarrator(root, id)) ? clip(title || id) : null,
		);
	}
	const actorOf = (key: string): OutlineTeamActor =>
		key.startsWith("s:")
			? { kind: "session", name: nameable.get(key.slice(2)) ?? null }
			: key.startsWith("h:")
				? { kind: "person", name: clip(names.users.get(key.slice(2)) ?? key.slice(2), 64) }
				: { kind: "system" };
	/** The reader's card names who in no language: a title, a username, or nothing. */
	const neutral = (actor: OutlineTeamActor) =>
		actor.kind === "session" || actor.kind === "person" ? (actor.name ?? undefined) : undefined;
	const zh = locale === "zh-CN";
	const assigneeText = (to: string): string => {
		if (to === `agent:${root}`) return zh ? "你" : "you";
		if (to.startsWith("agent:")) {
			const name = nameable.get(to.slice("agent:".length));
			if (name) return zh ? `会话「${name}」` : `session "${name}"`;
			return `@${to}`;
		}
		if (to.startsWith("human:")) return to.slice("human:".length);
		return `@${to}`;
	};
	const described = await describeOutlineOverlaps(root, overlaps, store);

	return drafts.map(({ draft }): Named | null => {
		if (draft.where === "file") {
			const d = described.get(`${draft.other}\u0000${draft.taskId}`);
			const by: OutlineTeamActor = { kind: "session", name: d?.session ?? null };
			const task = d?.task ?? null;
			return {
				text: { where: "file", by, task, path: draft.path },
				item: boundOutlineTaskNoticeItem({
					address: task?.address ?? "",
					title: task?.title ?? draft.path,
					...(neutral(by) ? { by: neutral(by) } : {}),
					changes: [{ kind: "overlap", path: draft.path }],
				}),
			};
		}
		const by = actorOf(draft.actor);
		const tree = draft.treeId ? taskOf(draft.treeId, draft.spaceId) : null;
		if (draft.where === "tree" && !tree) return null;
		const e = draft.event;
		let event: OutlineTeamEvent;
		let subject: OutlineTeamTask | null;
		let changes: OutlineTaskNoticeChange[];
		if (!("taskId" in e)) {
			event = { kind: e.kind, n: e.n };
			subject = tree;
			changes = [{ kind: e.kind, n: e.n }];
		} else {
			const task = taskOf(e.taskId, draft.spaceId);
			if (!task) return null;
			subject = task;
			switch (e.kind) {
				case "assigned":
					event = { kind: "assigned", task, to: assigneeText(e.to) };
					changes = [{ kind: "assigned", to: e.to.replace(/^(agent|human):/, "") }];
					break;
				case "added":
					event = { kind: "added", task, claimable: e.claimable };
					changes = [{ kind: "added" }, ...(e.claimable ? [{ kind: "claimable" as const }] : [])];
					break;
				case "claimable":
					event = { kind: "claimable", task };
					changes = [{ kind: "claimable" }];
					break;
				default:
					event = { kind: e.kind, task };
					changes = [
						{ kind: "status", from: (draft.from ?? null) as never, to: draft.to ?? "todo" },
					];
			}
		}
		const text: OutlineTeamLine =
			draft.where === "tree" && tree
				? { where: "tree", tree, by, event }
				: { where: "page", by, event };
		return {
			text,
			item: subject
				? boundOutlineTaskNoticeItem({
						address: subject.address,
						title: subject.title,
						...(neutral(by) ? { by: neutral(by) } : {}),
						changes,
					})
				: null,
		};
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing the row (the session runtime: SQLite)
// ─────────────────────────────────────────────────────────────────────────────

/** What writing needs from the session layer: a seam tests replace. */
export interface OutlineTeamActivityDelivery {
	deliver(
		narratorId: string,
		row: {
			content: string;
			body: SideCarBody;
			source: string;
			role: "sys";
			schedule: "none" | "onNextTurn";
			locale: Locale;
		},
	): Promise<{ messageId: string | null; turnText: string | null }>;
}

let deliverySeam: OutlineTeamActivityDelivery | null = null;

/** Replace the delivery (tests); null restores the real one. Returns the previous. */
export function setOutlineTeamActivityDelivery(
	next: OutlineTeamActivityDelivery | null,
): OutlineTeamActivityDelivery | null {
	const previous = deliverySeam;
	deliverySeam = next;
	return previous;
}

const realDelivery: OutlineTeamActivityDelivery = {
	async deliver(narratorId, row) {
		const { deliverInjection } = await import("../narrator-injection");
		const result = await deliverInjection(narratorId, row);
		return { messageId: result.messageId, turnText: result.turnText };
	},
};

/**
 * Write the session's team activity, when there is any: at the start of a run (`start`, a row
 * the run's history reads) or at a tool boundary of a long run (`boundary`, at most every
 * {@link OUTLINE_TEAM_ACTIVITY_LIMITS.cadenceMs}, handed to the running loop). Root outline
 * sessions only. Never throws; never wakes anything.
 */
export async function writeOutlineTeamActivity(
	narratorId: string,
	locale: Locale,
	when: "start" | "boundary",
	options: { now?: number; store?: OutlineStore } = {},
): Promise<{ messageId: string | null; turnText: string | null } | null> {
	try {
		if (!isOutlineEnabled()) return null;
		const now = options.now ?? Date.now();
		if (when === "boundary") {
			const last = state.sessions.get(narratorId)?.lastLookAt;
			// Nothing read between looks: a tool boundary costs a map lookup.
			if (last !== undefined && now - last < OUTLINE_TEAM_ACTIVITY_LIMITS.cadenceMs) return null;
		}
		// The session runtime runs on SQLite only so far (PR 7, PR 9b): no rows elsewhere.
		const { getNarratorMessageRefsPort } = await import("../narrator-refs/store");
		if (!options.store && getNarratorMessageRefsPort()) return null;
		const activity = await readOutlineTeamActivity(narratorId, {
			locale,
			now,
			store: options.store,
		});
		if (!activity) return null;
		return await (deliverySeam ?? realDelivery).deliver(narratorId, {
			content: activity.content,
			body: activity.body,
			source: OUTLINE_TEAM_ACTIVITY_SOURCE,
			role: "sys",
			schedule: when === "start" ? "none" : "onNextTurn",
			locale,
		});
	} catch (error) {
		logger.warn("Could not write a session's team activity", {
			narratorId,
			when,
			error: String(error),
		});
		return null;
	}
}
