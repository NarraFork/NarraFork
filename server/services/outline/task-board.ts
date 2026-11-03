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
 * COMPLETION (D26b)
 * -----------------
 * A locked task whose being done or cancelled waits for confirmation carries `completion`: the
 * pending change, and whether the person reading decides it (the locker). The board confirms or
 * rejects it through the pending routes (PR 6).
 *
 * Every read is indexed and bounded: open tasks through the open-task index, finished ones
 * through the finished-task index, titles as the head of each block's content only, claims,
 * waits and open changes per space with their own limits.
 */
import { NotFoundError, ValidationError } from "@server/lib/errors";
import { blockTitle } from "@shared/outline";
import {
	OUTLINE_TASK_BOARD_LIMITS,
	type OutlineBoardExecutor,
	type OutlineBoardSection,
	type OutlineBoardTask,
	type OutlineTaskBoardResponse,
} from "@shared/outline-task-board";
import { canReadSpace, canWriteSpace, type OutlinePrincipal } from "./access";
import { readDisplayNames, readProjectSessionSpacePage } from "./access-reads";
import { OUTLINE_BEHAVIOR_ALIAS, type OutlineTaskActorRef, type OutlineTaskJson } from "./model";
import { findCompletionsAwaitingConfirmation, pendingRightOf } from "./pending";
import { resolveSessionSpaceNarrator } from "./spaces";
import { outlineStore } from "./store";
import type {
	OutlineBlockMeta,
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
// Describing tasks
// ─────────────────────────────────────────────────────────────────────────────

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
 * Board entries for blocks of known spaces. `open` ones are read with their waits and in
 * document order (`first` space first); the others as given.
 */
async function describe(
	ctx: Context,
	metas: readonly OutlineBlockMeta[],
	options: { open: boolean; first?: string | null },
): Promise<OutlineBoardTask[]> {
	if (metas.length === 0) return [];
	const { store } = ctx;
	const ordered = options.open
		? await inDocumentOrder(store, metas, options.first ?? null)
		: [...metas];
	const ids = ordered.map((m) => m.id);
	const now = new Date().toISOString();
	const [heads, claimRows, waits, completions] = await Promise.all([
		store.getBlockHeads(ids),
		store.getTaskClaims(ids),
		options.open ? deriveOutlineTaskWaits(ordered, { store }) : Promise.resolve(new Map()),
		options.open
			? findCompletionsAwaitingConfirmation(ordered, { store })
			: Promise.resolve(new Map()),
	]);
	const titles = new Map(heads.map((h) => [h.id, blockTitle(h.contentHead)]));
	const claims = new Map<string, OutlineTaskClaimRow>(claimRows.map((c) => [c.taskBlockId, c]));

	// Holders as sessions (a subagent's claim is its root's work), and the names to show.
	const holderNarrators = new Set<string>();
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
		if (task.assignee?.startsWith("agent:"))
			return { kind: "agent", name: task.assignee.slice("agent:".length) };
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
		});
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sections
// ─────────────────────────────────────────────────────────────────────────────

/** The pages of a space whose checkboxes are not tasks: a session's behavior page. */
async function excludedPages(store: OutlineStore, space: OutlineSpaceRow): Promise<string[]> {
	if (space.kind !== "session") return [];
	return (await store.findAliasOwners(space.id, [OUTLINE_BEHAVIOR_ALIAS])).map((o) => o.id);
}

async function describeSpace(space: OutlineSpaceRow) {
	const names = await readDisplayNames({
		projectIds: space.kind === "project" && space.projectId ? [space.projectId] : [],
		narratorIds: space.kind === "session" && space.narratorId ? [space.narratorId] : [],
	});
	return {
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
	};
}

/** One space's own section: open tasks (up to `openLimit`) and the latest finished ones. */
async function ownSection(
	ctx: Context,
	space: OutlineSpaceRow,
	limits: { open: number; finished: number },
): Promise<OutlineBoardSection> {
	const { store } = ctx;
	ctx.spaces.set(space.id, space);
	const exclude = await excludedPages(store, space);
	const open = await store.listOpenTasks(space.id, limits.open + 1, { excludePageIds: exclude });
	const excluded = new Set(exclude);
	// The cursor follows the rows read, whether or not the behavior page's were left out.
	const finishedRows = await store.listFinishedTasks(space.id, { limit: limits.finished + 1 });
	const window = finishedRows.slice(0, limits.finished);
	const finished = window.filter((m) => !excluded.has(m.pageId));
	const last = window.at(-1);
	return {
		space: await describeSpace(space),
		canWrite: await canWriteSpace(ctx.principal, space),
		role: "own",
		open: await describe(ctx, open.slice(0, limits.open), { open: true, first: space.id }),
		openTruncated: open.length > limits.open,
		finished: await describe(ctx, finished, { open: false }),
		finishedCursor:
			finishedRows.length > limits.finished && last ? encodeFinishedCursor(last) : null,
	};
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
	const sections: OutlineBoardSection[] = [];
	if (space) {
		sections.push(
			await ownSection(ctx, space, {
				open: OUTLINE_TASK_BOARD_LIMITS.sessionOpen,
				finished: OUTLINE_TASK_BOARD_LIMITS.sessionFinished,
			}),
		);
	}
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
	for (const [spaceId, blocks] of bySpace) {
		const other = await store.getSpace(spaceId);
		// A space the person may not read is not shown, not even as a name.
		if (!other || !(await canReadSpace(principal, other))) continue;
		ctx.spaces.set(other.id, other);
		sections.push({
			space: await describeSpace(other),
			canWrite: await canWriteSpace(principal, other),
			role: "claimed",
			open: await describe(ctx, blocks, { open: true, first: other.id }),
			openTruncated: claimed.length > OUTLINE_TASK_BOARD_LIMITS.claimedElsewhere,
			finished: [],
			finishedCursor: null,
		});
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
	const limits = {
		open: OUTLINE_TASK_BOARD_LIMITS.projectOpen,
		finished: OUTLINE_TASK_BOARD_LIMITS.projectFinished,
	};
	const sections: OutlineBoardSection[] = [];
	const after = options.cursor ? decodeSpaceCursor(options.cursor) : undefined;
	if (after === undefined) {
		const projectSpace = await store.findSpace({ kind: "project", projectId });
		if (projectSpace && (await canReadSpace(principal, projectSpace)))
			sections.push(await ownSection(ctx, projectSpace, limits));
	}
	const page = await readProjectSessionSpacePage(principal, projectId, {
		afterNarratorId: after,
		limit: OUTLINE_TASK_BOARD_LIMITS.projectSpaces + 1,
	});
	const spaces = page.slice(0, OUTLINE_TASK_BOARD_LIMITS.projectSpaces);
	for (const space of spaces) sections.push(await ownSection(ctx, space, limits));
	const last = spaces.at(-1);
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
	const excluded = new Set(await excludedPages(store, space));
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
