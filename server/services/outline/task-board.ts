/**
 * The task board (design §3.1, plan §6; outline P2 PR 5): the built-in view of the process
 * dimension, for one session (its dock tab) or one project (the project page). Reads only; the
 * board's changes are people's writes (`person-tasks.ts`).
 *
 * WHAT IT LISTS
 * -------------
 *   - SESSION: the tasks of the session's space (its behavior page left out: those checkboxes are
 *     rules, outline plan PR 4), and the open tasks the session holds in other spaces.
 *   - PROJECT: the project space, then the session spaces of the project's sessions the person
 *     may read (`readProjectSessionSpacePage`, filtered in SQL), a page of spaces at a time.
 *
 * Each space: its open tasks in document order (to do and in progress, with what they wait for,
 * derived as continuation derives it: D27b), and its latest finished ones (done or cancelled, the
 * finished-task index), paged per space. The client groups by executor, then status.
 *
 * WHO DOES A TASK (`OutlineBoardExecutor`)
 * ----------------------------------------
 * Whoever holds its claim (a session, by its root; a person); else whoever it is assigned to by
 * name; else, for an open task of a session space, that session (it will take it up: continuation
 * starts the first to-do, §4.8); else nobody. A finished task: whoever last held it, when known.
 *
 * NEWLY DONE FOR YOU (「新完成」, D50 ④; outline P2 PR 9b)
 * -----------------------------------------------------
 * A done task the reader manages (`task_json.manager` is them) that an agent finished is
 * `newlyDone` until they have seen it. The finish is the version that made it done (walked back
 * from the current one, at most {@link OUTLINE_BOARD_NEW_DONE.versionsBack} versions: later
 * edits of a done task leave it found; one edited more often since is not marked). Its commit is
 * an agent's (or a system commit for a session: a confirmation), or another person's while a
 * session was doing it (as the report counts it), never one the reader wrote; and it is within
 * {@link OUTLINE_BOARD_NEW_DONE.windowDays} days. A later version the reader wrote means they
 * have seen it. "Seen" is otherwise a row of `outline_task_seen` at the finish's version or later,
 * written when a board showed it to them ({@link markOutlineTasksSeen}); a task finished again
 * later is new again, an agent rewording it is not. Cost: nothing more for a board without such
 * a task; otherwise at most `versionsBack - 1` batched version reads (primary-key seeks, without
 * content), one commit read per space (by `(space_id, seq)`) and one read of the reader's rows
 * (primary key), all bounded by the finished tasks shown.
 *
 * COMPLETION (D26b)
 * -----------------
 * A locked task whose being done or cancelled waits for confirmation carries `completion`: the
 * pending change, and whether the person reading decides it (the locker). The board confirms or
 * rejects it through the pending routes (PR 6).
 *
 * COST
 * ----
 * Every read is indexed and bounded, and batched across the spaces of a page: a project board's
 * page costs a fixed number of statements, not a number per session. Open and finished tasks of
 * every space in one compound statement each (a bounded seek per space), ancestors one level at a
 * time for all of them, titles as the head of each block's content only, claims, names and the
 * open changes (by the tasks' lock roots) in one read each, and whether the person may write each
 * session space from the sessions' write facts and one grant read (`writableSpaces`). The one
 * exception is 「新完成」: the commits of the reader's own finished tasks are read per space that
 * has one (at most the page's spaces), and not at all when none does.
 */
import { NotFoundError, ValidationError } from "@server/lib/errors";
import { blockTitle } from "@shared/outline";
import type { OutlineBoardSeenRequest } from "@shared/outline-task-board";
import {
	OUTLINE_TASK_BOARD_LIMITS,
	type OutlineBoardExecutor,
	type OutlineBoardSection,
	type OutlineBoardTask,
	type OutlineTaskBoardResponse,
} from "@shared/outline-task-board";
import {
	canReadSpace,
	canWriteSpace,
	narratorVisibility,
	type OutlinePrincipal,
	projectUsersWith,
} from "./access";
import {
	readDisplayNames,
	readNarratorWriteGrants,
	readProject,
	readProjectSessionSpacePage,
	readSessionWriteFacts,
} from "./access-reads";
import { agentAssigneeName } from "./assignee";
import {
	OUTLINE_BEHAVIOR_ALIAS,
	OUTLINE_LIMITS,
	OUTLINE_PENDING_LIMITS,
	type OutlineTaskActorRef,
	type OutlineTaskJson,
} from "./model";
import { findCompletionsAwaitingConfirmation, pendingRightOf } from "./pending";
import { isOrphanedSpace, resolveSessionSpaceNarrator } from "./spaces";
import { outlineStore } from "./store";
import type { OutlineVersionMeta } from "./store/digest-port";
import type {
	OutlineBlockMeta,
	OutlineCommitRow,
	OutlinePendingHead,
	OutlineSpaceRow,
	OutlineStore,
	OutlineTaskClaimRow,
} from "./store/port";
import { deriveOutlineTaskWaits, inDocumentOrder, isClaimLive } from "./tasks";

// ─────────────────────────────────────────────────────────────────────────────
// Cursors
// ─────────────────────────────────────────────────────────────────────────────

const CURSOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

function encodeFinishedCursor(meta: Pick<OutlineBlockMeta, "versionSeq" | "id">): string {
	return Buffer.from(JSON.stringify([meta.versionSeq, meta.id]), "utf8").toString("base64url");
}

/** A finished-list cursor; a malformed one is a 400. */
export function decodeFinishedCursor(cursor: string): { versionSeq: number; id: string } {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (
			Array.isArray(parsed) &&
			parsed.length === 2 &&
			Number.isSafeInteger(parsed[0]) &&
			typeof parsed[1] === "string" &&
			CURSOR_ID.test(parsed[1])
		) {
			return { versionSeq: parsed[0] as number, id: parsed[1] };
		}
	} catch {
		// fall through
	}
	throw new ValidationError("Invalid cursor");
}

function encodeSpaceCursor(narratorId: string): string {
	return Buffer.from(narratorId, "utf8").toString("base64url");
}

function decodeSpaceCursor(cursor: string): string {
	const id = Buffer.from(cursor, "base64url").toString("utf8");
	if (!CURSOR_ID.test(id)) throw new ValidationError("Invalid cursor");
	return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Newly done for the reader (「新完成」)
// ─────────────────────────────────────────────────────────────────────────────

export const OUTLINE_BOARD_NEW_DONE = {
	/** Tasks finished longer ago than this are never marked. */
	windowDays: 14,
	/**
	 * Versions of a done task looked at, newest first, to find the one that finished it. Each
	 * step back past the first two is one batched keyed read, only for the tasks still looking
	 * (at most the finished tasks a board shows).
	 */
	versionsBack: 8,
	/** A person's seen rows older than this are pruned when they write more. */
	keepSeenDays: 30,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether the commit that wrote a task's current version finished it as an agent's work. */
function finishedByAgent(
	commit: OutlineCommitRow,
	claim: OutlineTaskClaimRow | undefined,
	readerId: string,
): boolean {
	if (commit.actorKind === "agent") return true;
	if (commit.actorKind === "system") return commit.narratorId !== null;
	// A person's commit: the reader's own never is; another person's when a session was doing it.
	if (commit.actorId === readerId) return false;
	return !!(claim?.holderNarratorId ?? claim?.lastHolderNarratorId);
}

/**
 * The versions of each task, newest first, back to the one that made it done (or
 * {@link OUTLINE_BOARD_NEW_DONE.versionsBack} of them): one batched read per step back, only for
 * the tasks still looking.
 */
async function finishingChains(
	store: OutlineStore,
	tasks: readonly OutlineBlockMeta[],
): Promise<Map<string, OutlineVersionMeta[]>> {
	const chains = new Map<string, OutlineVersionMeta[]>(tasks.map((m) => [m.id, []]));
	const found = (chain: readonly OutlineVersionMeta[]) => {
		const last = chain.at(-1);
		const before = chain.at(-2);
		return !!before && isFinishVersion(before) && !!last && !isFinishVersion(last);
	};
	// First the current version and the one before it, then one more each step.
	let keys = tasks.flatMap((m) =>
		m.versionSeq > 1
			? [
					{ blockId: m.id, seq: m.versionSeq },
					{ blockId: m.id, seq: m.versionSeq - 1 },
				]
			: [{ blockId: m.id, seq: m.versionSeq }],
	);
	for (let step = 0; keys.length > 0 && step < OUTLINE_BOARD_NEW_DONE.versionsBack; step++) {
		const grew = new Set<string>();
		for (const version of await store.listVersionMetasAt(keys)) {
			const chain = chains.get(version.blockId);
			if (!chain || chain.some((v) => v.fromSeq === version.fromSeq)) continue;
			chain.push(version);
			grew.add(version.blockId);
		}
		for (const chain of chains.values()) chain.sort((a, b) => b.fromSeq - a.fromSeq);
		keys = [];
		for (const [blockId, chain] of chains) {
			// Nothing older was found: the start of the block's history.
			if (!grew.has(blockId)) continue;
			const last = chain.at(-1);
			// Stop at the finish, at the start of the block's history, or at the bound.
			if (!last || found(chain) || chain.length >= OUTLINE_BOARD_NEW_DONE.versionsBack) continue;
			if (last.fromSeq <= 1 || last.deleted || last.taskJson?.status !== "done") continue;
			keys.push({ blockId, seq: last.fromSeq - 1 });
		}
	}
	return chains;
}

/** A version whose task is done (a finish, when the version before it is not). */
function isFinishVersion(version: OutlineVersionMeta): boolean {
	return !version.deleted && version.taskJson?.status === "done";
}

/**
 * Of the given finished tasks, those newly done for the reader (see the module header): read only
 * when one of them is done and theirs.
 */
async function newlyDoneFor(
	ctx: Context,
	metas: readonly OutlineBlockMeta[],
	claims: ReadonlyMap<string, OutlineTaskClaimRow>,
	now: Date,
): Promise<Set<string>> {
	const readerId = ctx.principal.userId;
	const candidates = metas.filter(
		(m) =>
			!m.deleted &&
			m.taskJson?.status === "done" &&
			m.taskJson.manager?.kind === "human" &&
			m.taskJson.manager.id === readerId,
	);
	const out = new Set<string>();
	if (candidates.length === 0) return out;
	const { store } = ctx;
	const chains = await finishingChains(store, candidates);
	// Each task's finish, and the versions written after it.
	const finishes = new Map<string, { finish: OutlineVersionMeta; after: OutlineVersionMeta[] }>();
	for (const m of candidates) {
		const chain = chains.get(m.id) ?? [];
		for (let i = 0; i + 1 < chain.length; i++) {
			const version = chain[i] as OutlineVersionMeta;
			if (!isFinishVersion(version)) break;
			if (isFinishVersion(chain[i + 1] as OutlineVersionMeta)) continue;
			// The one before was not done (to do, in progress, cancelled; not deleted): the finish.
			if (!(chain[i + 1] as OutlineVersionMeta).deleted)
				finishes.set(m.id, { finish: version, after: chain.slice(0, i) });
			break;
		}
	}
	if (finishes.size === 0) return out;
	const seqsBySpace = new Map<string, Set<number>>();
	for (const m of candidates) {
		const found = finishes.get(m.id);
		if (!found) continue;
		const seqs = seqsBySpace.get(m.spaceId) ?? new Set<number>();
		for (const version of [found.finish, ...found.after]) seqs.add(version.fromSeq);
		seqsBySpace.set(m.spaceId, seqs);
	}
	const commits = new Map<string, OutlineCommitRow>();
	for (const [spaceId, seqs] of seqsBySpace)
		for (const commit of await store.getCommitsBySeqs(spaceId, [...seqs]))
			commits.set(`${spaceId}:${commit.seq}`, commit);
	const seen = new Map(
		(await store.getTaskSeen(readerId, [...finishes.keys()])).map((row) => [
			row.taskBlockId,
			row.seenSeq,
		]),
	);
	const since = new Date(now.getTime() - OUTLINE_BOARD_NEW_DONE.windowDays * DAY_MS).toISOString();
	const byReader = (commit: OutlineCommitRow | undefined) =>
		commit?.actorKind === "human" && commit.actorId === readerId;
	for (const m of candidates) {
		const found = finishes.get(m.id);
		if (!found) continue;
		const commit = commits.get(`${m.spaceId}:${found.finish.fromSeq}`);
		if (!commit || commit.createdAt < since) continue;
		if ((seen.get(m.id) ?? -1) >= found.finish.fromSeq) continue;
		// The reader wrote it since: they have seen it.
		if (found.after.some((v) => byReader(commits.get(`${m.spaceId}:${v.fromSeq}`)))) continue;
		if (finishedByAgent(commit, claims.get(m.id), readerId)) out.add(m.id);
	}
	return out;
}

/**
 * The reader saw these tasks on a board (「新完成」 shown to them): one row each, at the version
 * the board showed. Only tasks that are done and theirs (they manage them), in a space they may
 * read, are recorded; the rest are ignored (nothing is said about them). Returns how many were
 * recorded.
 */
export async function markOutlineTasksSeen(
	principal: OutlinePrincipal,
	request: OutlineBoardSeenRequest,
	options: { store?: OutlineStore; now?: Date } = {},
): Promise<number> {
	const store = options.store ?? outlineStore;
	const wanted = new Map<string, number>();
	for (const task of request.tasks.slice(0, OUTLINE_TASK_BOARD_LIMITS.seenPerRequest))
		wanted.set(task.id, Math.max(wanted.get(task.id) ?? 0, task.versionSeq));
	if (wanted.size === 0) return 0;
	const metas = await store.getBlockMetasByIds([...wanted.keys()]);
	const readable = new Map<string, boolean>();
	const rows: Array<{ taskBlockId: string; seenSeq: number }> = [];
	for (const m of metas) {
		const manager = m.taskJson?.manager;
		if (m.deleted || m.taskJson?.status !== "done") continue;
		if (manager?.kind !== "human" || manager.id !== principal.userId) continue;
		if (!readable.has(m.spaceId)) {
			const space = await store.getSpace(m.spaceId);
			readable.set(m.spaceId, !!space && (await canReadSpace(principal, space)));
		}
		if (!readable.get(m.spaceId)) continue;
		// Never past the task's version now: a version the board could not have shown.
		const seenSeq = Math.min(wanted.get(m.id) ?? 0, m.versionSeq);
		rows.push({ taskBlockId: m.id, seenSeq });
	}
	// Nothing to record: no write, no prune.
	if (rows.length === 0) return 0;
	const now = options.now ?? new Date();
	await store.putTaskSeen(
		principal.userId,
		rows,
		now.toISOString(),
		new Date(now.getTime() - OUTLINE_BOARD_NEW_DONE.keepSeenDays * DAY_MS).toISOString(),
	);
	return rows.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Describing tasks
// ─────────────────────────────────────────────────────────────────────────────

/** Distinct `@agent:` names of one board read that are checked for being a readable session. */
const ASSIGNED_SESSIONS_READ = 50;

interface Context {
	store: OutlineStore;
	principal: OutlinePrincipal;
	spaces: Map<string, OutlineSpaceRow>;
}

/** The space of a session: its root narrator's, by id. */
function sessionOfSpace(space: OutlineSpaceRow | undefined): string | null {
	return space?.kind === "session" ? space.narratorId : null;
}

/**
 * The open changes that may touch the given open tasks: those on each task's nearest locked
 * ancestor (or itself), the lock that applies to it. One read by root, whatever the spaces.
 */
async function openPendingOf(
	store: OutlineStore,
	tasks: readonly OutlineBlockMeta[],
	known: ReadonlyMap<string, OutlineBlockMeta>,
): Promise<OutlinePendingHead[]> {
	const roots = new Set<string>();
	for (const task of tasks) {
		let current: OutlineBlockMeta | undefined = task;
		for (let depth = 0; current && depth <= OUTLINE_LIMITS.maxDepth; depth++) {
			if (current.taskJson?.lock) {
				roots.add(current.id);
				break;
			}
			current = current.parentId === null ? undefined : known.get(current.parentId);
		}
	}
	if (roots.size === 0) return [];
	return await store.listOpenPendingByRoots([...roots], OUTLINE_PENDING_LIMITS.scanPerSpace);
}

/**
 * Board entries for blocks of known spaces (`ctx.spaces`), of any number of spaces at once.
 * `open` ones are read with their waits and in document order (`first` space first); the others
 * as given.
 */
async function describe(
	ctx: Context,
	metas: readonly OutlineBlockMeta[],
	options: { open: boolean; first?: string | null },
): Promise<OutlineBoardTask[]> {
	if (metas.length === 0) return [];
	const { store } = ctx;
	const known = new Map<string, OutlineBlockMeta>(metas.map((m) => [m.id, m]));
	const keys = new Map([...ctx.spaces.values()].map((space) => [space.id, space.key]));
	const ordered = options.open
		? await inDocumentOrder(store, metas, options.first ?? null, { keys, ancestors: known })
		: [...metas];
	const ids = ordered.map((m) => m.id);
	const nowDate = new Date();
	const now = nowDate.toISOString();
	const openPending = options.open ? await openPendingOf(store, ordered, known) : [];
	const [heads, claimRows, waits, completions] = await Promise.all([
		store.getBlockHeads(ids),
		store.getTaskClaims(ids),
		options.open
			? deriveOutlineTaskWaits(ordered, { store, openPending })
			: Promise.resolve(new Map()),
		options.open
			? findCompletionsAwaitingConfirmation(ordered, { store, openPending })
			: Promise.resolve(new Map()),
	]);
	const titles = new Map(heads.map((h) => [h.id, blockTitle(h.contentHead)]));
	const claims = new Map<string, OutlineTaskClaimRow>(claimRows.map((c) => [c.taskBlockId, c]));
	const newlyDone = options.open
		? new Set<string>()
		: await newlyDoneFor(ctx, ordered, claims, nowDate);

	// Holders as sessions (a subagent's claim is its root's work), and the names to show.
	const holderNarrators = new Set<string>();
	const assignedNames = new Set<string>();
	const userIds = new Set<string>();
	for (const meta of ordered) {
		const claim = claims.get(meta.id);
		const narrator = claim?.holderNarratorId ?? claim?.lastHolderNarratorId;
		if (narrator) holderNarrators.add(narrator);
		const user = claim?.holderUserId ?? claim?.lastHolderUserId;
		if (user) userIds.add(user);
		const lock = meta.taskJson?.lock;
		if (lock?.by.kind === "human") userIds.add(lock.by.id);
		else if (lock) holderNarrators.add(lock.by.id);
		// Handed to a session by its id (the board's 「转交给会话」, outline P2 PR 10a): shown as
		// that session where the viewer may read it. Read with the holders, by primary key; a
		// name that is no narrator's id (a handle, a label) stays a name.
		const assigned = agentAssigneeName(meta.taskJson?.assignee);
		if (assigned) assignedNames.add(assigned);
	}
	// Anyone who writes the space can type `@agent:<any id>`: the session's title is shown only to
	// a viewer who may read that session, never because the id was written there.
	const visible = narratorVisibility(ctx.principal);
	const assignedSessions = new Set<string>();
	for (const name of [...assignedNames].slice(0, ASSIGNED_SESSIONS_READ))
		if (await visible(name)) {
			assignedSessions.add(name);
			holderNarrators.add(name);
		}
	const roots = await store.getNarratorRoots([...holderNarrators]);
	const narratorIds = new Set<string>([...holderNarrators]);
	for (const session of roots.values()) narratorIds.add(session.root);
	for (const space of ctx.spaces.values()) if (space.narratorId) narratorIds.add(space.narratorId);
	const names = await readDisplayNames({ narratorIds: [...narratorIds], userIds: [...userIds] });
	const session = (narratorId: string): OutlineBoardExecutor => {
		const root = roots.get(narratorId)?.root ?? narratorId;
		return { kind: "session", narratorId: root, title: names.narrators.get(root) ?? null };
	};
	const actorName = (by: OutlineTaskActorRef): string | null =>
		by.kind === "human"
			? (names.users.get(by.id) ?? null)
			: by.kind === "agent"
				? (names.narrators.get(roots.get(by.id)?.root ?? by.id) ?? null)
				: null;

	const executorOf = (meta: OutlineBlockMeta, task: OutlineTaskJson): OutlineBoardExecutor => {
		const claim = claims.get(meta.id);
		const open = task.status === "todo" || task.status === "doing";
		if (open && claim) {
			if (claim.holderUserId)
				return {
					kind: "human",
					userId: claim.holderUserId,
					name: names.users.get(claim.holderUserId) ?? claim.holderUserId,
				};
			// A lapsed lease still names who was doing it, until the expiry job reopens the task.
			if (claim.holderNarratorId && (task.status === "doing" || isClaimLive(claim, now)))
				return session(claim.holderNarratorId);
		}
		if (task.assignee?.startsWith("human:"))
			return { kind: "human", userId: null, name: task.assignee.slice("human:".length) };
		if (task.assignee?.startsWith("agent:")) {
			const name = task.assignee.slice("agent:".length);
			// A root session's id the viewer may read: that session will do it. Anything else is
			// a name, as written.
			if (assignedSessions.has(name) && roots.get(name)?.root === name) return session(name);
			return { kind: "agent", name };
		}
		if (!open && claim) {
			if (claim.lastHolderUserId)
				return {
					kind: "human",
					userId: claim.lastHolderUserId,
					name: names.users.get(claim.lastHolderUserId) ?? claim.lastHolderUserId,
				};
			if (claim.lastHolderNarratorId) return session(claim.lastHolderNarratorId);
		}
		const owner = sessionOfSpace(ctx.spaces.get(meta.spaceId));
		return owner ? session(owner) : { kind: "none" };
	};

	const out: OutlineBoardTask[] = [];
	for (const meta of ordered) {
		const task = meta.taskJson;
		if (!task) continue;
		const space = ctx.spaces.get(meta.spaceId);
		const wait = waits.get(meta.id);
		const waiting =
			wait && (wait.prerequisites.length > 0 || wait.people || wait.confirmation)
				? {
						prerequisites: wait.prerequisites.length,
						people: wait.people,
						confirmation: wait.confirmation,
					}
				: null;
		const completion = completions.get(meta.id);
		const lock = task.lock ?? null;
		out.push({
			id: meta.id,
			spaceId: meta.spaceId,
			sid: meta.sid,
			address: `${space?.key ?? "?"}/${meta.sid}`,
			pageId: meta.pageId,
			title: titles.get(meta.id) || meta.sid,
			status: task.status,
			waiting,
			assignee: task.assignee ?? null,
			executor: executorOf(meta, task),
			humanCreated: task.humanCreated === true,
			plan: task.plan ? { state: task.plan.state, round: task.plan.round } : null,
			lock: lock ? { by: { kind: lock.by.kind, id: lock.by.id, name: actorName(lock.by) } } : null,
			completion: completion
				? {
						pendingId: completion.row.id,
						status: completion.status,
						canDecide:
							(await pendingRightOf(
								completion.row,
								{ kind: "human", userId: ctx.principal.userId },
								{ store, lock },
							)) === "decider",
					}
				: null,
			versionSeq: meta.versionSeq,
			...(newlyDone.has(meta.id) ? { newlyDone: true as const } : {}),
		});
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sections
// ─────────────────────────────────────────────────────────────────────────────

/** Spaces as the board names them: the project's name or the session's title, in one read. */
async function describeSpaces(spaces: readonly OutlineSpaceRow[]) {
	const names = await readDisplayNames({
		projectIds: spaces.flatMap((s) => (s.kind === "project" && s.projectId ? [s.projectId] : [])),
		narratorIds: spaces.flatMap((s) =>
			s.kind === "session" && s.narratorId ? [s.narratorId] : [],
		),
	});
	return new Map(
		spaces.map((space) => [
			space.id,
			{
				id: space.id,
				key: space.key,
				kind: space.kind,
				projectId: space.projectId,
				narratorId: space.narratorId,
				label:
					space.kind === "project" && space.projectId
						? (names.projects.get(space.projectId) ?? null)
						: space.kind === "session" && space.narratorId
							? (names.narrators.get(space.narratorId) ?? null)
							: null,
			},
		]),
	);
}

/**
 * Which of the spaces the person may write, as `canWriteSpace` answers it, with session spaces
 * judged together: the sessions' write facts in one read, then by the narrator write rule
 * (`narratorUsersWith`) for the ones whose project gate is the board's project, which the person
 * reads (the route checked): the owner; everyone past the gate when the write audience is public;
 * the project's writers when it is the project; otherwise a write grant (one read for all). Any
 * other space, and a session filed under another project, is asked of `canWriteSpace` itself.
 * `task-board-scenarios.ts` holds the answers to `canWriteSpace`'s.
 */
export async function writableSpaces(
	principal: OutlinePrincipal,
	spaces: readonly OutlineSpaceRow[],
	boardProjectId: string | null,
): Promise<Set<string>> {
	const out = new Set<string>();
	const sessions = spaces.filter(
		(space) => space.kind === "session" && space.narratorId !== null && !isOrphanedSpace(space),
	);
	const sessionSet = new Set(sessions);
	const fallback = spaces.filter((space) => !sessionSet.has(space));
	if (sessions.length > 0 && principal.isAdmin) for (const space of sessions) out.add(space.id);
	else if (sessions.length > 0) {
		const facts = await readSessionWriteFacts(sessions.map((s) => s.narratorId as string));
		let projectWriter: boolean | undefined;
		const byGrant: OutlineSpaceRow[] = [];
		for (const space of sessions) {
			const fact = facts.get(space.narratorId as string);
			if (!fact) continue;
			if (fact.ownerUserId !== null && fact.ownerUserId === principal.userId) {
				out.add(space.id);
				continue;
			}
			if (
				fact.type === "subagent" ||
				boardProjectId === null ||
				fact.gateProjectId !== boardProjectId
			) {
				fallback.push(space);
				continue;
			}
			if (fact.writeAudience === "public") out.add(space.id);
			else if (fact.writeAudience === "project") {
				if (projectWriter === undefined) {
					const project = await readProject(boardProjectId);
					projectWriter =
						project !== null &&
						(await projectUsersWith(project, [principal.userId], "write")).has(principal.userId);
				}
				if (projectWriter) out.add(space.id);
				else byGrant.push(space);
			} else byGrant.push(space);
		}
		if (byGrant.length > 0) {
			const granted = await readNarratorWriteGrants(
				byGrant.map((s) => s.narratorId as string),
				principal.userId,
			);
			for (const space of byGrant) if (granted.has(space.narratorId as string)) out.add(space.id);
		}
	}
	for (const space of fallback) if (await canWriteSpace(principal, space)) out.add(space.id);
	return out;
}

/**
 * The own sections of the given spaces, in that order: each space's open tasks (up to
 * `limits.open`, in document order) and its latest finished ones (up to `limits.finished`), its
 * behavior page left out. Every read is one for all the spaces.
 */
async function ownSections(
	ctx: Context,
	spaces: readonly OutlineSpaceRow[],
	limits: { open: number; finished: number },
	boardProjectId: string | null,
): Promise<OutlineBoardSection[]> {
	if (spaces.length === 0) return [];
	const { store } = ctx;
	for (const space of spaces) ctx.spaces.set(space.id, space);
	const sessionSpaces = spaces.filter((space) => space.kind === "session").map((s) => s.id);
	const excluded = new Map<string, string[]>();
	if (sessionSpaces.length > 0) {
		for (const owner of await store.findAliasOwnersInSpaces(sessionSpaces, OUTLINE_BEHAVIOR_ALIAS))
			excluded.set(owner.spaceId, [...(excluded.get(owner.spaceId) ?? []), owner.id]);
	}
	const [openRows, finishedRows, described, writable] = await Promise.all([
		store.listOpenTasksOfSpaces(
			spaces.map((space) => ({ spaceId: space.id, excludePageIds: excluded.get(space.id) })),
			limits.open + 1,
		),
		store.listFinishedTasksOfSpaces(
			spaces.map((space) => space.id),
			limits.finished + 1,
		),
		describeSpaces(spaces),
		writableSpaces(ctx.principal, spaces, boardProjectId),
	]);
	const bySpace = <T extends { spaceId: string }>(rows: readonly T[]) => {
		const map = new Map<string, T[]>();
		for (const row of rows) map.set(row.spaceId, [...(map.get(row.spaceId) ?? []), row]);
		return map;
	};
	const openOf = bySpace(openRows);
	const finishedOf = bySpace(finishedRows);
	const shownOpen: OutlineBlockMeta[] = [];
	const shownFinished: OutlineBlockMeta[] = [];
	const cursors = new Map<string, string | null>();
	for (const space of spaces) {
		// A space with more open tasks than shown shows the ones in progress or locked first (who
		// does what, a goal waiting for its person), then other to-dos; document order after.
		const openRows = openOf.get(space.id) ?? [];
		const byKey = (a: OutlineBlockMeta, b: OutlineBlockMeta) =>
			a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1;
		const active = openRows.filter(isActiveTask).sort(byKey);
		const rest = openRows.filter((row) => !isActiveTask(row)).sort(byKey);
		shownOpen.push(...[...active, ...rest].slice(0, limits.open));
		// The cursor follows the rows read, whether or not the behavior page's were left out.
		const rows = finishedOf.get(space.id) ?? [];
		const window = rows.slice(0, limits.finished);
		const pages = new Set(excluded.get(space.id) ?? []);
		shownFinished.push(...window.filter((m) => !pages.has(m.pageId)));
		const last = window.at(-1);
		cursors.set(
			space.id,
			rows.length > limits.finished && last ? encodeFinishedCursor(last) : null,
		);
	}
	const [open, finished] = await Promise.all([
		describe(ctx, shownOpen, { open: true, first: spaces[0]?.id ?? null }),
		describe(ctx, shownFinished, { open: false }),
	]);
	const openBySpace = bySpace(open);
	const finishedBySpace = bySpace(finished);
	return spaces.map((space) => ({
		space: described.get(space.id) as OutlineBoardSection["space"],
		canWrite: writable.has(space.id),
		role: "own" as const,
		open: openBySpace.get(space.id) ?? [],
		openTruncated: (openOf.get(space.id)?.length ?? 0) > limits.open,
		finished: finishedBySpace.get(space.id) ?? [],
		finishedCursor: cursors.get(space.id) ?? null,
	}));
}

/** An open task the board always shows of its space: in progress, or locked. */
function isActiveTask(meta: OutlineBlockMeta): boolean {
	return meta.taskJson?.status === "doing" || !!meta.taskJson?.lock;
}

/** The caller's name, for "assign to me". */
async function meOf(principal: OutlinePrincipal) {
	const names = await readDisplayNames({ userIds: [principal.userId] });
	return { userId: principal.userId, name: names.users.get(principal.userId) ?? principal.userId };
}

/**
 * The board of a session (its dock tab). The caller has checked that the person may read the
 * narrator; a subagent's board is its root's (it has no tasks of its own, D27c).
 */
export async function readSessionTaskBoard(
	principal: OutlinePrincipal,
	narratorId: string,
	options: { store?: OutlineStore; canAdd?: boolean } = {},
): Promise<OutlineTaskBoardResponse> {
	const store = options.store ?? outlineStore;
	const root = await resolveSessionSpaceNarrator(narratorId);
	if (!root) throw new NotFoundError("Narrator", narratorId);
	const ctx: Context = { store, principal, spaces: new Map() };
	const space = await store.findSpace({ kind: "session", narratorId: root.id });
	const sections: OutlineBoardSection[] = space
		? await ownSections(
				ctx,
				[space],
				{
					open: OUTLINE_TASK_BOARD_LIMITS.sessionOpen,
					finished: OUTLINE_TASK_BOARD_LIMITS.sessionFinished,
				},
				null,
			)
		: [];
	// What the session holds elsewhere (a project's tasks it took up), grouped by space.
	const claimed = (
		await store.listClaimedTasks(root.id, OUTLINE_TASK_BOARD_LIMITS.claimedElsewhere + 1)
	).filter(
		({ block }) =>
			block.spaceId !== space?.id &&
			!block.deleted &&
			(block.taskJson?.status === "todo" || block.taskJson?.status === "doing"),
	);
	const bySpace = new Map<string, OutlineBlockMeta[]>();
	for (const { block } of claimed.slice(0, OUTLINE_TASK_BOARD_LIMITS.claimedElsewhere)) {
		const list = bySpace.get(block.spaceId) ?? [];
		list.push(block);
		bySpace.set(block.spaceId, list);
	}
	const others: OutlineSpaceRow[] = [];
	for (const spaceId of bySpace.keys()) {
		const other = await store.getSpace(spaceId);
		// A space the person may not read is not shown, not even as a name.
		if (other && (await canReadSpace(principal, other))) others.push(other);
	}
	if (others.length > 0) {
		for (const other of others) ctx.spaces.set(other.id, other);
		const [described, writable, open] = await Promise.all([
			describeSpaces(others),
			writableSpaces(principal, others, null),
			describe(
				ctx,
				others.flatMap((other) => bySpace.get(other.id) ?? []),
				{ open: true, first: others[0]?.id ?? null },
			),
		]);
		for (const other of others) {
			sections.push({
				space: described.get(other.id) as OutlineBoardSection["space"],
				canWrite: writable.has(other.id),
				role: "claimed",
				open: open.filter((task) => task.spaceId === other.id),
				openTruncated: claimed.length > OUTLINE_TASK_BOARD_LIMITS.claimedElsewhere,
				finished: [],
				finishedCursor: null,
			});
		}
	}
	return {
		scope: { kind: "session", narratorId: root.id },
		sections,
		canAdd: options.canAdd ?? false,
		nextCursor: null,
		me: await meOf(principal),
	};
}

/**
 * The board of a project (the project page): the project space on the first page, then the
 * session spaces of its sessions that the person may read, a page at a time. The caller has
 * checked that the person may read the project.
 */
export async function readProjectTaskBoard(
	principal: OutlinePrincipal,
	projectId: string,
	options: { cursor?: string | null; store?: OutlineStore } = {},
): Promise<OutlineTaskBoardResponse> {
	const store = options.store ?? outlineStore;
	const ctx: Context = { store, principal, spaces: new Map() };
	const after = options.cursor ? decodeSpaceCursor(options.cursor) : undefined;
	const spaces: OutlineSpaceRow[] = [];
	if (after === undefined) {
		const projectSpace = await store.findSpace({ kind: "project", projectId });
		if (projectSpace && (await canReadSpace(principal, projectSpace))) spaces.push(projectSpace);
	}
	const page = await readProjectSessionSpacePage(principal, projectId, {
		afterNarratorId: after,
		limit: OUTLINE_TASK_BOARD_LIMITS.projectSpaces + 1,
	});
	const sessions = page.slice(0, OUTLINE_TASK_BOARD_LIMITS.projectSpaces);
	spaces.push(...sessions);
	const sections = await ownSections(
		ctx,
		spaces,
		{
			open: OUTLINE_TASK_BOARD_LIMITS.projectOpen,
			finished: OUTLINE_TASK_BOARD_LIMITS.projectFinished,
		},
		projectId,
	);
	const last = sessions.at(-1);
	return {
		scope: { kind: "project", projectId },
		sections,
		canAdd: false,
		nextCursor:
			page.length > OUTLINE_TASK_BOARD_LIMITS.projectSpaces && last?.narratorId
				? encodeSpaceCursor(last.narratorId)
				: null,
		me: await meOf(principal),
	};
}

/**
 * The next finished tasks of a space after `cursor`. The caller has checked that the person may
 * read the space.
 */
export async function readFinishedTasks(
	principal: OutlinePrincipal,
	space: OutlineSpaceRow,
	options: { cursor?: string | null; limit?: number; store?: OutlineStore } = {},
): Promise<{ tasks: OutlineBoardTask[]; nextCursor: string | null }> {
	const store = options.store ?? outlineStore;
	const limit = Math.min(
		Math.max(Math.trunc(options.limit ?? OUTLINE_TASK_BOARD_LIMITS.sessionFinished), 1),
		OUTLINE_TASK_BOARD_LIMITS.maxFinishedPage,
	);
	const ctx: Context = { store, principal, spaces: new Map([[space.id, space]]) };
	const excluded = new Set(
		space.kind === "session"
			? (await store.findAliasOwners(space.id, [OUTLINE_BEHAVIOR_ALIAS])).map((o) => o.id)
			: [],
	);
	const rows = await store.listFinishedTasks(space.id, {
		before: options.cursor ? decodeFinishedCursor(options.cursor) : null,
		limit: limit + 1,
	});
	const window = rows.slice(0, limit);
	const last = window.at(-1);
	return {
		tasks: await describe(
			ctx,
			window.filter((m) => !excluded.has(m.pageId)),
			{ open: false },
		),
		nextCursor: rows.length > limit && last ? encodeFinishedCursor(last) : null,
	};
}
