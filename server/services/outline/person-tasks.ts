/**
 * People's tasks (design §4.8, plan §6; outline P2 PR 5): `/goal` and the task board's form add a
 * person-created task to a session, and the board changes a task on a person's behalf.
 *
 * ADDING (`/goal`, "Add")
 * -----------------------
 * The task goes on the session space's task page (alias {@link OUTLINE_TASKS_PAGE_ALIAS}, made on
 * first use), last: a session's own work lives in its session space (D37). It is a to-do whose
 * manager is the person and which is marked created by a person (`humanCreated`, what
 * `protectedOnly` continuation counts, D27a). By default it is locked by that person, with no
 * session confirming for them (D26b, D25), in the SAME commit that creates it: the agent never
 * reads the goal unlocked, and everything the commit wrote is the plan (`locks.ts`): the goal
 * and, when the text has more than one paragraph, the paragraphs after the first, which the write
 * path splits into child blocks (owner Q3 A). What the agent adds under it later is not the plan
 * and is written directly: the steps follow the agent (D26). The lock is the one
 * `lockOutlineTask` makes, and the commit meets that function's preconditions: the person writes
 * the session space (adding to a session takes its write access) and the task is new, so nobody
 * else holds a lock on it.
 *
 * Dedupe by body (as `/goal` did in Dynamic Spec, review round 1 S2): a task of the task page that
 * is not cancelled and holds the same text is not added again; done ones count too. "The same
 * text" is the whole body the person wrote, whitespace runs taken as one space: the task's own
 * block and the paragraphs written with it (its blocks created in the same commit, as they read
 * now), in order; steps added under it later are not part of it. The scan is bounded and
 * deterministic (the task page's last {@link DEDUPE_SCAN} children, last first); it compares
 * the heads it reads ({@link OUTLINE_PAGE_HEAD_CHARS} characters) first, and reads whole
 * contents only for the few whose head matches. Adds of one session run one at a time, so the
 * same text sent twice at once is added once.
 *
 * CHANGING (the board)
 * --------------------
 * Finish, cancel or reopen a task; hand it to a person (`@human:name`, who must be able to write
 * its space), to a session by name (`@agent:<its id>`, 「转交给会话」, outline P2 PR 10a: a root
 * session that could do the task, `transfer.ts`) or back to the session (no assignee). A task in
 * progress that someone else is doing
 * is stopped in the same commit (back to to-do, which releases the claim): handing it on means
 * the previous executor no longer does it. Every change is a person's commit, based on the
 * version the board read, so a change made since is refused (409) and the board reads again.
 *
 * A task of a SESSION space given to the team (「交给团队」), or by the session's owner to someone
 * who cannot work in the session space, is handed out instead (outline P2 PR 10c-3, `hand-out.ts`,
 * owner decision 2026-11-13): a copy goes to the project's task page and the task waits for it.
 * Anyone who can work there already is assigned in place.
 */
import { catalogError, ForbiddenError, NotFoundError, ValidationError } from "@server/lib/errors";
import { type BlockNode, normalizeBlock, serializeBody } from "@shared/outline";
import {
	OUTLINE_TASK_BOARD_LIMITS,
	type OutlineBoardAssignTarget,
} from "@shared/outline-task-board";
import { canWriteSpace, type OutlinePrincipal } from "./access";
import { readDisplayNames, readNarrator, readUserByUsername } from "./access-reads";
import { sessionAssignee } from "./assignee";
import {
	canWorkInSessionSpace,
	handOutPersonTarget,
	handOutTask,
	type OutlineHandOutResult,
	type OutlineHandOutTarget,
} from "./hand-out";
import { OUTLINE_TASKS_PAGE_ALIAS, type OutlineTaskJson } from "./model";
import { resolveSessionSpaceNarrator } from "./spaces";
import { outlineStore } from "./store";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";
import { OUTLINE_PAGE_HEAD_CHARS } from "./store/read-port";
import { isTransferSession } from "./transfer";
import { type OutlineTaskPatch, type OutlineWriteResult, writeOutline } from "./write";

export { OUTLINE_TASKS_PAGE_ALIAS };

/** Children of the task page the dedupe reads: the last ones, where tasks are added. */
const DEDUPE_SCAN = 500;
/** Tasks whose head matches that the dedupe reads whole. */
const DEDUPE_FULL_READS = 8;

/** The title of a session's task page when it is made (by `/goal`, the board or plan mode). */
export const OUTLINE_TASKS_PAGE_TITLE: Record<"en" | "zh-CN", string> = {
	en: "Tasks",
	"zh-CN": "任务",
};

export interface PersonTaskAdded {
	/** False when the task existed already: nothing was written. */
	added: boolean;
	blockId: string;
	/** `key/sid`. */
	address: string;
	spaceId: string;
	/** Whether the task (the new one, or the one found) is locked. */
	locked: boolean;
	/** The commit that added it; null when nothing was written. */
	commitId: string | null;
}

/** Adds of one session, one at a time (dedupe reads and the write must not interleave). */
const adding = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every add of session `key` before it (a person's here, a plugin's in
 * `plugin-tasks.ts`): the dedupe read and the write of one add never interleave with another's.
 */
export async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const before = adding.get(key) ?? Promise.resolve();
	const run = before.catch(() => {}).then(fn);
	const settled = run.catch(() => {});
	adding.set(key, settled);
	try {
		return await run;
	} finally {
		if (adding.get(key) === settled) adding.delete(key);
	}
}

/** A task's text: trimmed, not empty, within the limit. */
export function personTaskText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) throw new ValidationError("A task needs some text");
	if (trimmed.length > OUTLINE_TASK_BOARD_LIMITS.maxTaskChars)
		throw new ValidationError(
			`A task's text is limited to ${OUTLINE_TASK_BOARD_LIMITS.maxTaskChars} characters`,
		);
	return trimmed;
}

/** A block's text as dedupe compares it: whitespace runs as one space, trimmed. */
function bodyKey(content: string): string {
	return content.replace(/\s+/g, " ").trim();
}

/** The body a task written from `text` gets: its block, and the blocks split off it in order. */
export interface TaskBody {
	first: string;
	rest: string[];
}

export function bodyFromText(text: string): TaskBody {
	const normalized = normalizeBlock(text);
	const rest: string[] = [];
	const walk = (nodes: readonly BlockNode[]) => {
		for (const node of nodes) {
			rest.push(bodyKey(serializeBody(node.body)));
			walk(node.children);
		}
	};
	walk(normalized.children);
	return { first: bodyKey(normalized.content), rest };
}

/**
 * Add a person-created task to a session (`/goal`, the board's form). `narratorId` is the session
 * (a root narrator: a subagent has no tasks of its own, D27c, and is refused). The caller has
 * checked that the person may write the session.
 */
export async function addPersonTask(args: {
	narratorId: string;
	userId: string;
	text: string;
	/** Lock it on the person's behalf (D26b); the board's form may leave it unlocked. */
	lock: boolean;
	locale?: "en" | "zh-CN";
	/** The message that asked for it (`/goal`): the commit's provenance. */
	messageId?: string | null;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<PersonTaskAdded> {
	const store = args.store ?? outlineStore;
	const text = personTaskText(args.text);
	const session = await resolveSessionSpaceNarrator(args.narratorId);
	if (!session) throw new NotFoundError("Narrator", args.narratorId);
	if (session.id !== args.narratorId) throw catalogError("GOAL_IN_OUTLINE_SESSION");
	return await oneAtATime(session.id, async () => {
		const at = args.now?.() ?? new Date();
		const space = await store.ensureSpace(
			{ kind: "session", narratorId: session.id },
			at.toISOString(),
		);
		const [owner] = await store.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
		if (owner) {
			const existing = await findSameTask(store, space, owner.id, bodyFromText(text));
			if (existing) {
				return {
					added: false,
					blockId: existing.id,
					address: `${space.key}/${existing.sid}`,
					spaceId: space.id,
					locked: existing.locked,
					commitId: null,
				};
			}
		}
		const result = await writeOutline(
			{
				spaceId: space.id,
				ops: [
					...(owner
						? []
						: [
								{
									op: "insert" as const,
									tempId: "page",
									parent: null,
									content: OUTLINE_TASKS_PAGE_TITLE[args.locale ?? "en"],
									alias: OUTLINE_TASKS_PAGE_ALIAS,
								},
							]),
					{
						op: "insert" as const,
						parent: owner ? { id: owner.id } : { tempId: "page" },
						content: text,
						task: {
							status: "todo" as const,
							humanCreated: true,
							manager: { kind: "human" as const, id: args.userId },
							...(args.lock ? { lock: { delegate: null } } : {}),
						},
					},
				],
				actor: { kind: "human", id: args.userId },
				responsibleUserId: args.userId,
				...(args.messageId ? { narratorId: session.id, messageId: args.messageId } : {}),
			},
			{ store, ...(args.now ? { now: args.now } : {}) },
		);
		const added = result.results[owner ? 0 : 1];
		if (!added) throw new Error("the task was not written");
		return {
			added: true,
			blockId: added.blockId,
			address: added.address,
			spaceId: space.id,
			locked: args.lock,
			commitId: result.commit?.id ?? null,
		};
	});
}

/**
 * A task directly under `pageId` (the task page, or the parent a plugin names) with this body that
 * is not cancelled, if any.
 */
export async function findSameTask(
	store: OutlineStore,
	space: OutlineSpaceRow,
	pageId: string,
	body: TaskBody,
): Promise<{ id: string; sid: string; locked: boolean; task: OutlineTaskJson } | null> {
	const children = (await store.listLastChildMetas(space.id, pageId, DEDUPE_SCAN)).filter(
		(meta) => meta.taskJson && meta.taskJson.status !== "cancelled",
	);
	if (children.length === 0) return null;
	const heads = new Map(
		(await store.getBlockHeads(children.map((c) => c.id))).map((h) => [h.id, h.contentHead]),
	);
	// Heads that match: the whole content when it is shorter than a head, else its beginning.
	const matching = children
		.filter((child) => {
			const head = heads.get(child.id);
			if (head === undefined) return false;
			// The head counts characters (code points), as the store cuts it.
			if ([...head].length < OUTLINE_PAGE_HEAD_CHARS) return bodyKey(head) === body.first;
			return body.first.startsWith(bodyKey(head));
		})
		.slice(0, DEDUPE_FULL_READS);
	for (const child of matching) {
		if ((await sameBody(store, child.id, body)) && child.taskJson)
			return {
				id: child.id,
				sid: child.sid,
				locked: !!child.taskJson.lock,
				task: child.taskJson,
			};
	}
	return null;
}

/** Whether task `taskId` holds `body`: its whole content, then the blocks written with it. */
async function sameBody(store: OutlineStore, taskId: string, body: TaskBody): Promise<boolean> {
	const [task] = await store.getBlocks([taskId]);
	if (!task || bodyKey(task.content) !== body.first) return false;
	// The blocks written with it: created under it in the commit that created it.
	const [created] = await store.getFirstVersions([taskId]);
	if (!created) return body.rest.length === 0;
	const versions = await store.listCommitVersions(created.commitId, body.rest.length + 50);
	const under = new Set([taskId]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const v of versions) {
			if (v.parentId && under.has(v.parentId) && !under.has(v.blockId)) {
				under.add(v.blockId);
				grew = true;
			}
		}
	}
	under.delete(taskId);
	if (under.size !== body.rest.length) return false;
	if (under.size === 0) return true;
	// As they read now, in document order.
	const rows = (await store.getBlocks([...under])).filter((row) => !row.deleted);
	const byParent = new Map<string, typeof rows>();
	for (const row of rows) {
		const siblings = byParent.get(row.parentId ?? "") ?? [];
		siblings.push(row);
		byParent.set(row.parentId ?? "", siblings);
	}
	const rest: string[] = [];
	const walk = (parentId: string) => {
		const siblings = (byParent.get(parentId) ?? []).sort((a, b) =>
			a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1,
		);
		for (const row of siblings) {
			rest.push(bodyKey(row.content));
			walk(row.id);
		}
	};
	walk(taskId);
	return rest.length === body.rest.length && rest.every((key, i) => key === body.rest[i]);
}

/**
 * A person's change to one task on the board: its checkbox, who it is handed to. Refused (403)
 * when the person may not write the task's space, and (409) when the task changed since the board
 * read it. Returns the write's result, or null when nothing would change.
 */
export async function changePersonTask(args: {
	principal: OutlinePrincipal;
	blockId: string;
	baseVersionSeq: number;
	status?: "todo" | "done" | "cancelled";
	assign?: OutlineBoardAssignTarget;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<{
	result: OutlineWriteResult | null;
	space: OutlineSpaceRow;
	/** The task was handed out (a task of a session space given to others). */
	handedOut?: OutlineHandOutResult;
}> {
	const store = args.store ?? outlineStore;
	const { principal } = args;
	const block = await store.getBlock(args.blockId);
	const space = block ? await store.getSpace(block.spaceId) : null;
	if (!block || block.deleted || !block.taskJson || !space)
		throw new NotFoundError("Outline task", args.blockId);
	if (!(await canWriteSpace(principal, space)))
		throw new ForbiddenError("You cannot change this task");
	const handOut = args.assign ? await handOutTargetOf(principal, space, args.assign, store) : null;
	if (handOut) {
		if (args.status) throw new ValidationError("Handing a task out changes nothing else");
		const handedOut = await handOutTask({
			taskId: block.id,
			by: { kind: "person", principal },
			target: handOut,
			baseVersionSeq: args.baseVersionSeq,
			store,
			...(args.now ? { now: args.now } : {}),
		});
		return { result: null, space, handedOut };
	}
	if (args.assign?.kind === "team")
		throw new ValidationError("Only a session's task goes to the team");
	const task = block.taskJson;
	const patch: OutlineTaskPatch = {};
	if (args.status && args.status !== task.status) patch.status = args.status;
	if (args.assign) {
		const assignee = await assigneeOf(principal, space, args.assign);
		if (assignee !== (task.assignee ?? null)) patch.assignee = assignee;
		// Handed on: whoever is doing it now stops (to-do releases the claim, write.ts), unless
		// the session it is handed to is the one doing it.
		const kept =
			args.assign.kind === "narrator" &&
			task.status === "doing" &&
			(await heldBySession(store, block.id, args.assign.narratorId));
		if (
			task.status === "doing" &&
			patch.status === undefined &&
			patch.assignee !== undefined &&
			!kept
		)
			patch.status = "todo";
	}
	if (Object.keys(patch).length === 0) return { result: null, space };
	const result = await writeOutline(
		{
			spaceId: space.id,
			ops: [
				{
					op: "setTask",
					block: { id: block.id },
					task: patch,
					baseVersionSeq: args.baseVersionSeq,
				},
			],
			actor: { kind: "human", id: principal.userId },
			responsibleUserId: principal.userId,
		},
		{ store, ...(args.now ? { now: args.now } : {}) },
	);
	return { result, space };
}

/**
 * Whom a task of a session space is handed out to (owner decision 2026-11-13, 「能写就原地指派」):
 * the team; or, when the person giving it is the session's owner, someone who cannot work in the
 * session space (a person who may not write it, a session whose person may not). Null when the
 * change is made in place: not a session space, back to the session, "me" (the person changing it
 * may write the space), anyone who can work there already, a name nobody has, and anything someone
 * other than the owner gives (checked in place, as before: who could not work there is refused).
 */
async function handOutTargetOf(
	principal: OutlinePrincipal,
	space: OutlineSpaceRow,
	target: OutlineBoardAssignTarget,
	store: OutlineStore,
): Promise<OutlineHandOutTarget | null> {
	if (space.kind !== "session" || !space.narratorId) return null;
	if (target.kind === "team") return { kind: "team" };
	if (target.kind === "session" || target.kind === "me") return null;
	const owner = (await readNarrator(space.narratorId))?.ownerUserId ?? null;
	if (owner === null || principal.userId !== owner) return null;
	let handOut: OutlineHandOutTarget | null;
	if (target.kind === "narrator") {
		handOut =
			target.narratorId === space.narratorId
				? null
				: { kind: "session", narratorId: target.narratorId };
	} else {
		const username = target.username.trim().replace(/^@/, "");
		if (!username || username.length > OUTLINE_TASK_BOARD_LIMITS.maxUsernameChars) return null;
		const person = await handOutPersonTarget(username);
		handOut = person && person.userId !== owner ? person : null;
	}
	if (!handOut || (await canWorkInSessionSpace(handOut, space, { store }))) return null;
	return handOut;
}

/** Whether session `narratorId` (or a subagent of it) holds the task, its lease running. */
async function heldBySession(
	store: OutlineStore,
	taskId: string,
	narratorId: string,
): Promise<boolean> {
	const [claim] = await store.getTaskClaims([taskId]);
	const holder = claim?.holderNarratorId ?? null;
	if (!claim || holder === null) return false;
	if (claim.expiresAt !== null && claim.expiresAt <= new Date().toISOString()) return false;
	return ((await store.getNarratorRoots([holder])).get(holder)?.root ?? holder) === narratorId;
}

/**
 * The assignee a hand-over writes: `human:name` of someone who can write the space,
 * `agent:<id>` of a session that could do the task, or none.
 */
async function assigneeOf(
	principal: OutlinePrincipal,
	space: OutlineSpaceRow,
	target: OutlineBoardAssignTarget,
): Promise<string | null> {
	if (target.kind === "session" || target.kind === "team") return null;
	if (target.kind === "narrator") {
		// A session the board's picker would list (`transfer.ts`: a root session of the task's
		// project that keeps its tasks in the outline, is not archived, that the person may read
		// and that could do the task there). Any other is the same answer as an unknown one.
		if (!(await isTransferSession(principal, space, target.narratorId)))
			throw new ValidationError("This session cannot work on this task");
		return sessionAssignee(target.narratorId);
	}
	if (target.kind === "me") {
		const name = (await readDisplayNames({ userIds: [principal.userId] })).users.get(
			principal.userId,
		);
		if (!name) throw new NotFoundError("User", principal.userId);
		return assigneeLabel(name);
	}
	const username = target.username.trim().replace(/^@/, "");
	if (!username || username.length > OUTLINE_TASK_BOARD_LIMITS.maxUsernameChars)
		throw new ValidationError("Invalid username");
	const user = await readUserByUsername(username);
	// Someone who cannot write the space could not do the task there: the same answer as unknown.
	// Their own grants decide, not an admin's reach everywhere: otherwise a writer of the space
	// could tell admins' names from everyone else's.
	if (!user || !(await canWriteSpace({ userId: user.id, isAdmin: false }, space)))
		throw new ValidationError(`No one named ${username} can work on this task`);
	return assigneeLabel(user.username);
}

/** `human:name`, when the name can be written as an assignee. */
export function assigneeLabel(username: string): string {
	const label = `human:${username}`;
	if (!/^human:[\p{L}\p{N}_.-]*[\p{L}\p{N}_-]$/u.test(label))
		throw new ValidationError(`${username} cannot be named as an assignee`);
	return label;
}
