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
 * Dedupe (as `/goal` did in Dynamic Spec): a task of the task page that is not cancelled and has
 * the same title is not added again; done ones count too. Adds of one session run one at a time,
 * so the same text sent twice at once is added once.
 *
 * CHANGING (the board)
 * --------------------
 * Finish, cancel or reopen a task; hand it to a person (`@human:name`, who must be able to write
 * its space) or back to the session (no assignee). A task in progress that someone else is doing
 * is stopped in the same commit (back to to-do, which releases the claim): handing it on means
 * the previous executor no longer does it. Every change is a person's commit, based on the
 * version the board read, so a change made since is refused (409) and the board reads again.
 */
import { catalogError, ForbiddenError, NotFoundError, ValidationError } from "@server/lib/errors";
import { blockTitle, normalizeBlock, titleOf } from "@shared/outline";
import {
	OUTLINE_TASK_BOARD_LIMITS,
	type OutlineBoardAssignTarget,
} from "@shared/outline-task-board";
import { canWriteSpace, type OutlinePrincipal } from "./access";
import { readDisplayNames, readUserByUsername } from "./access-reads";
import { resolveSessionSpaceNarrator } from "./spaces";
import { outlineStore } from "./store";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";
import { type OutlineTaskPatch, type OutlineWriteResult, writeOutline } from "./write";

/** The alias of a session space's task page, where `/goal` and the board's form add tasks. */
export const OUTLINE_TASKS_PAGE_ALIAS = "tasks";

/** Children of the task page the dedupe reads (the newest are last; older ones are rarely sent again). */
const DEDUPE_SCAN = 500;

const TASKS_PAGE_TITLE: Record<"en" | "zh-CN", string> = { en: "Tasks", "zh-CN": "任务" };

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

async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
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

/** The title a task written from `text` gets: its first block's first line. */
function titleFromText(text: string): string {
	return titleOf(normalizeBlock(text).content).replace(/\s+/g, " ").trim();
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
		const title = titleFromText(text);
		if (owner) {
			const existing = await findSameTask(store, space, owner.id, title);
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
									content: TASKS_PAGE_TITLE[args.locale ?? "en"],
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

/** A task directly on the task page with this title that is not cancelled, if any. */
async function findSameTask(
	store: OutlineStore,
	space: OutlineSpaceRow,
	pageId: string,
	title: string,
): Promise<{ id: string; sid: string; locked: boolean } | null> {
	const children = (await store.listChildMetas(space.id, [pageId], DEDUPE_SCAN)).filter(
		(meta) => !meta.deleted && meta.taskJson && meta.taskJson.status !== "cancelled",
	);
	if (children.length === 0) return null;
	const heads = new Map(
		(await store.getBlockHeads(children.map((c) => c.id))).map((h) => [h.id, h.contentHead]),
	);
	for (const child of children) {
		const head = heads.get(child.id);
		if (head === undefined) continue;
		if (blockTitle(head).replace(/\s+/g, " ").trim() === title)
			return { id: child.id, sid: child.sid, locked: !!child.taskJson?.lock };
	}
	return null;
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
}): Promise<{ result: OutlineWriteResult | null; space: OutlineSpaceRow }> {
	const store = args.store ?? outlineStore;
	const { principal } = args;
	const block = await store.getBlock(args.blockId);
	const space = block ? await store.getSpace(block.spaceId) : null;
	if (!block || block.deleted || !block.taskJson || !space)
		throw new NotFoundError("Outline task", args.blockId);
	if (!(await canWriteSpace(principal, space)))
		throw new ForbiddenError("You cannot change this task");
	const task = block.taskJson;
	const patch: OutlineTaskPatch = {};
	if (args.status && args.status !== task.status) patch.status = args.status;
	if (args.assign) {
		const assignee = await assigneeOf(principal, space, args.assign);
		if (assignee !== (task.assignee ?? null)) patch.assignee = assignee;
		// Handed on: whoever is doing it now stops (to-do releases the claim, write.ts).
		if (task.status === "doing" && patch.status === undefined && patch.assignee !== undefined)
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

/** The assignee a hand-over writes: `human:name` of someone who can write the space, or none. */
async function assigneeOf(
	principal: OutlinePrincipal,
	space: OutlineSpaceRow,
	target: OutlineBoardAssignTarget,
): Promise<string | null> {
	if (target.kind === "session") return null;
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
	if (!user || !(await canWriteSpace({ userId: user.id, isAdmin: user.isAdmin }, space)))
		throw new ValidationError(`No one named ${username} can work on this task`);
	return assigneeLabel(user.username);
}

/** `human:name`, when the name can be written as an assignee. */
function assigneeLabel(username: string): string {
	const label = `human:${username}`;
	if (!/^human:[\p{L}\p{N}_.-]*[\p{L}\p{N}_]$/u.test(label))
		throw new ValidationError(`${username} cannot be named as an assignee`);
	return label;
}
