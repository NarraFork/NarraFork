/**
 * The task board and people's tasks on their store (outline P2 PR 5): scenarios that run on SQLite
 * (`task-board.test.ts`) and on PostgreSQL (`tests/server/services/outline/pg-outline-task-board.test.ts`),
 * with the outline store and access executor of that database injected.
 *
 * They cover what PR 5 reads and writes: the finished-task index and the head-of-content read; a
 * person's task added to a session (locked in its own commit, deduped); a session's board (open
 * tasks in document order with their waits and executors, finished ones paged, the behavior page
 * left out, what it holds elsewhere); a person's changes (finish, reopen, hand over, refusals);
 * a goal's completion waiting for its locker; and a project's board, which lists only the session
 * spaces the person may read, a page at a time.
 */
import { expect } from "bun:test";
import { OUTLINE_TASK_BOARD_LIMITS, type OutlineBoardTask } from "@shared/outline-task-board";
import type { OutlinePrincipal } from "../access";
import { readProjectSessionSpacePage } from "../access-reads";
import { OutlineConflictError } from "../errors";
import { OUTLINE_BEHAVIOR_ALIAS } from "../model";
import { addPersonTask, changePersonTask, OUTLINE_TASKS_PAGE_ALIAS } from "../person-tasks";
import { ensureProjectSpace, ensureSessionSpace } from "../spaces";
import { outlineStore } from "../store";
import { readFinishedTasks, readProjectTaskBoard, readSessionTaskBoard } from "../task-board";
import { writeOutline } from "../write";

export interface BoardScenarioContext {
	user(options?: { admin?: boolean }): Promise<{ id: string; username: string }>;
	project(options: { owner: string; visibility?: "private" | "public" }): Promise<string>;
	/** A root session, under `projectId` through its explicit project. */
	session(options: {
		owner: string;
		projectId?: string | null;
		visibility?: "private" | "project" | "public";
		archived?: boolean;
	}): Promise<string>;
	/** A project grant to a person. */
	grant(projectId: string, userId: string, capability: "read" | "write"): Promise<void>;
}

export interface BoardScenario {
	name: string;
	run(ctx: BoardScenarioContext): Promise<void>;
}

const as = (id: string): OutlinePrincipal => ({ userId: id, isAdmin: false });

async function tasksOf(narratorId: string) {
	const space = await ensureSessionSpace(narratorId);
	return space;
}

function titles(tasks: readonly OutlineBoardTask[]): string[] {
	return tasks.map((task) => task.title);
}

export const OUTLINE_TASK_BOARD_SCENARIOS: BoardScenario[] = [
	{
		name: "finished tasks come latest change first, paged, and their heads only",
		async run(ctx) {
			const owner = await ctx.user();
			const session = await ctx.session({ owner: owner.id });
			const space = await tasksOf(session);
			const long = `Long ${"x".repeat(2000)}`;
			const written = await writeOutline({
				spaceId: space.id,
				ops: [
					{ op: "insert", tempId: "p", parent: null, content: "Work" },
					{ op: "insert", parent: { tempId: "p" }, content: "a", task: { status: "todo" } },
					{ op: "insert", parent: { tempId: "p" }, content: "b", task: { status: "todo" } },
					{ op: "insert", parent: { tempId: "p" }, content: "c", task: { status: "todo" } },
					{ op: "insert", parent: { tempId: "p" }, content: long, task: { status: "todo" } },
				],
				actor: { kind: "human", id: owner.id },
				responsibleUserId: owner.id,
			});
			const [, a, b, c, d] = written.results.map((r) => r.blockId);
			const finish = async (id: string, status: "done" | "cancelled") =>
				await writeOutline({
					spaceId: space.id,
					ops: [{ op: "setTask", block: { id }, task: { status } }],
					actor: { kind: "human", id: owner.id },
					responsibleUserId: owner.id,
				});
			await finish(a as string, "done");
			await finish(b as string, "cancelled");
			await finish(d as string, "done");
			const all = await outlineStore.listFinishedTasks(space.id, { limit: 10 });
			expect(all.map((m) => m.id)).toEqual([d, b, a] as string[]);
			const page = await outlineStore.listFinishedTasks(space.id, {
				limit: 1,
				before: { versionSeq: all[0]?.versionSeq as number, id: all[0]?.id as string },
			});
			expect(page.map((m) => m.id)).toEqual([b as string]);
			expect(c).toBeDefined();
			const heads = await outlineStore.getBlockHeads([d as string, a as string]);
			const head = heads.find((h) => h.id === d)?.contentHead ?? "";
			expect(head.length).toBeLessThan(long.length);
			expect(long.startsWith(head)).toBe(true);
			expect(heads.find((h) => h.id === a)?.contentHead).toBe("a");
			// The board's finished list pages the same way.
			const first = await readFinishedTasks(as(owner.id), space, { limit: 2 });
			expect(titles(first.tasks)).toEqual([long.slice(0, first.tasks[0]?.title.length), "b"]);
			const next = await readFinishedTasks(as(owner.id), space, {
				limit: 2,
				cursor: first.nextCursor,
			});
			expect(titles(next.tasks)).toEqual(["a"]);
			expect(next.nextCursor).toBeNull();
		},
	},
	{
		name: "a person's task: locked in the commit that adds it, on the task page, deduped by title",
		async run(ctx) {
			const owner = await ctx.user();
			const session = await ctx.session({ owner: owner.id });
			const added = await addPersonTask({
				narratorId: session,
				userId: owner.id,
				text: "Ship the release",
				lock: true,
			});
			expect(added).toMatchObject({ added: true, locked: true });
			const block = await outlineStore.getBlock(added.blockId);
			expect(block?.taskJson).toMatchObject({
				status: "todo",
				humanCreated: true,
				manager: { kind: "human", id: owner.id },
				lock: { by: { kind: "human", id: owner.id }, delegate: null },
			});
			expect(block?.taskJson?.lock?.versionSeq).toBe(block?.versionSeq);
			const page = await outlineStore.getBlock(block?.parentId as string);
			expect(page?.alias).toBe(OUTLINE_TASKS_PAGE_ALIAS);
			const again = await addPersonTask({
				narratorId: session,
				userId: owner.id,
				text: "  Ship the release ",
				lock: true,
			});
			expect(again).toMatchObject({ added: false, blockId: added.blockId, commitId: null });
			const unlocked = await addPersonTask({
				narratorId: session,
				userId: owner.id,
				text: "Write the notes",
				lock: false,
			});
			expect((await outlineStore.getBlock(unlocked.blockId))?.taskJson?.lock).toBeUndefined();
			// Two adds at once of the same text: one task.
			const [x, y] = await Promise.all([
				addPersonTask({ narratorId: session, userId: owner.id, text: "Tag it", lock: true }),
				addPersonTask({ narratorId: session, userId: owner.id, text: "Tag it", lock: true }),
			]);
			expect([x.added, y.added].sort()).toEqual([false, true]);
			expect(x.blockId).toBe(y.blockId);
		},
	},
	{
		name: "a session's board: open in document order with waits and executors, finished paged",
		async run(ctx) {
			const owner = await ctx.user();
			const session = await ctx.session({ owner: owner.id });
			const space = await tasksOf(session);
			const written = await writeOutline({
				spaceId: space.id,
				ops: [
					{ op: "insert", tempId: "p", parent: null, content: "Plan" },
					{
						op: "insert",
						tempId: "a",
						parent: { tempId: "p" },
						content: "first",
						task: { status: "todo" },
					},
					{
						op: "insert",
						tempId: "b",
						parent: { tempId: "p" },
						content: "second",
						task: { status: "todo", assignee: `human:${owner.username}` },
					},
					{
						op: "insert",
						tempId: "c",
						parent: { tempId: "p" },
						content: "third",
						task: { status: "todo" },
					},
					{
						op: "insert",
						tempId: "rules",
						parent: null,
						content: "Rules",
						alias: OUTLINE_BEHAVIOR_ALIAS,
					},
					{
						op: "insert",
						parent: { tempId: "rules" },
						content: "a rule",
						task: { status: "done" },
					},
				],
				actor: { kind: "human", id: owner.id },
				responsibleUserId: owner.id,
			});
			const [, first, , third] = written.results.map((r) => r.blockId) as string[];
			// The session takes up the third one (its claim); the first waits for the second.
			await writeOutline({
				spaceId: space.id,
				ops: [
					{ op: "setTask", block: { id: third as string }, task: { status: "doing" } },
					{
						op: "setTask",
						block: { id: first as string },
						task: { depends: [{ target: `${space.key}/${written.results[2]?.sid}`, label: null }] },
					},
				],
				actor: { kind: "agent", id: session },
				narratorId: session,
				responsibleUserId: owner.id,
			});
			for (let i = 0; i < OUTLINE_TASK_BOARD_LIMITS.sessionFinished + 1; i++) {
				await writeOutline({
					spaceId: space.id,
					ops: [{ op: "insert", parent: null, content: `done ${i}`, task: { status: "done" } }],
					actor: { kind: "human", id: owner.id },
					responsibleUserId: owner.id,
				});
			}
			const board = await readSessionTaskBoard(as(owner.id), session, { canAdd: true });
			expect(board.scope).toEqual({ kind: "session", narratorId: session });
			expect(board.me).toEqual({ userId: owner.id, name: owner.username });
			const own = board.sections[0];
			expect(own?.role).toBe("own");
			expect(own?.canWrite).toBe(true);
			expect(titles(own?.open ?? [])).toEqual(["first", "second", "third"]);
			const [a, b, c] = own?.open ?? [];
			expect(a?.waiting).toEqual({ prerequisites: 1, people: false, confirmation: false });
			expect(a?.executor).toMatchObject({ kind: "session", narratorId: session });
			expect(b?.executor).toEqual({ kind: "human", userId: null, name: owner.username });
			expect(c?.executor).toMatchObject({ kind: "session", narratorId: session });
			expect(c?.status).toBe("doing");
			// Finished: latest first, the behavior page's checkbox left out, the rest paged.
			expect(own?.finished).toHaveLength(OUTLINE_TASK_BOARD_LIMITS.sessionFinished);
			expect(own?.finished[0]?.title).toBe(`done ${OUTLINE_TASK_BOARD_LIMITS.sessionFinished}`);
			expect(own?.finishedCursor).not.toBeNull();
			const more = await readFinishedTasks(as(owner.id), space, { cursor: own?.finishedCursor });
			expect(titles(more.tasks)).toEqual(["done 0"]);
		},
	},
	{
		name: "what a session holds in a project shows on its board, in that space's section",
		async run(ctx) {
			const owner = await ctx.user();
			const project = await ctx.project({ owner: owner.id });
			const session = await ctx.session({ owner: owner.id, projectId: project });
			const projectSpace = await ensureProjectSpace(project);
			await writeOutline({
				spaceId: projectSpace.id,
				ops: [{ op: "insert", parent: null, content: "team task", task: { status: "doing" } }],
				actor: { kind: "agent", id: session },
				narratorId: session,
				responsibleUserId: owner.id,
			});
			const board = await readSessionTaskBoard(as(owner.id), session);
			const claimed = board.sections.find((section) => section.role === "claimed");
			expect(claimed?.space.id).toBe(projectSpace.id);
			expect(titles(claimed?.open ?? [])).toEqual(["team task"]);
			expect(claimed?.open[0]?.executor).toMatchObject({ kind: "session", narratorId: session });
		},
	},
	{
		name: "a person's changes: finish, reopen, hand over; a stale version or a reader is refused",
		async run(ctx) {
			const owner = await ctx.user();
			const reader = await ctx.user();
			const project = await ctx.project({ owner: owner.id });
			await ctx.grant(project, reader.id, "read");
			const session = await ctx.session({
				owner: owner.id,
				projectId: project,
				visibility: "project",
			});
			const space = await tasksOf(session);
			const written = await writeOutline({
				spaceId: space.id,
				ops: [{ op: "insert", parent: null, content: "do it", task: { status: "todo" } }],
				actor: { kind: "agent", id: session },
				narratorId: session,
				responsibleUserId: owner.id,
			});
			const id = written.results[0]?.blockId as string;
			const version = async () => (await outlineStore.getBlock(id))?.versionSeq as number;
			// The session is doing it; handing it to the person stops that (back to to do).
			await writeOutline({
				spaceId: space.id,
				ops: [{ op: "setTask", block: { id }, task: { status: "doing" } }],
				actor: { kind: "agent", id: session },
				narratorId: session,
				responsibleUserId: owner.id,
			});
			await changePersonTask({
				principal: as(owner.id),
				blockId: id,
				baseVersionSeq: await version(),
				assign: { kind: "me" },
			});
			let task = (await outlineStore.getBlock(id))?.taskJson;
			expect(task).toMatchObject({ status: "todo", assignee: `human:${owner.username}` });
			expect((await outlineStore.getTaskClaims([id]))[0]?.holderNarratorId ?? null).toBeNull();
			// Back to the session.
			await changePersonTask({
				principal: as(owner.id),
				blockId: id,
				baseVersionSeq: await version(),
				assign: { kind: "session" },
			});
			expect((await outlineStore.getBlock(id))?.taskJson?.assignee).toBeNull();
			// Finish, then reopen.
			await changePersonTask({
				principal: as(owner.id),
				blockId: id,
				baseVersionSeq: await version(),
				status: "done",
			});
			expect((await outlineStore.getBlock(id))?.taskJson?.status).toBe("done");
			await changePersonTask({
				principal: as(owner.id),
				blockId: id,
				baseVersionSeq: await version(),
				status: "todo",
			});
			task = (await outlineStore.getBlock(id))?.taskJson;
			expect(task?.status).toBe("todo");
			// Handing it to someone who cannot write the space is refused, like an unknown name.
			await expect(
				changePersonTask({
					principal: as(owner.id),
					blockId: id,
					baseVersionSeq: await version(),
					assign: { kind: "user", username: reader.username },
				}),
			).rejects.toThrow(/can work on this task/);
			// A version the board read before a change is refused.
			const stale = (await version()) - 1;
			await expect(
				changePersonTask({
					principal: as(owner.id),
					blockId: id,
					baseVersionSeq: stale,
					status: "cancelled",
				}),
			).rejects.toBeInstanceOf(OutlineConflictError);
			// Someone who may only read the session may not change its tasks.
			await expect(
				changePersonTask({
					principal: as(reader.id),
					blockId: id,
					baseVersionSeq: await version(),
					status: "cancelled",
				}),
			).rejects.toThrow(/cannot change/);
			// Nothing changes: no commit.
			const unchanged = await changePersonTask({
				principal: as(owner.id),
				blockId: id,
				baseVersionSeq: await version(),
				status: "todo",
			});
			expect(unchanged.result).toBeNull();
		},
	},
	{
		name: "a goal ticked done by the agent waits for its locker, who decides it on the board",
		async run(ctx) {
			const owner = await ctx.user();
			const reader = await ctx.user();
			const project = await ctx.project({ owner: owner.id });
			await ctx.grant(project, reader.id, "read");
			const session = await ctx.session({
				owner: owner.id,
				projectId: project,
				visibility: "project",
			});
			const goal = await addPersonTask({
				narratorId: session,
				userId: owner.id,
				text: "Ship it",
				lock: true,
			});
			const done = await writeOutline({
				spaceId: goal.spaceId,
				ops: [{ op: "setTask", block: { id: goal.blockId }, task: { status: "done" } }],
				actor: { kind: "agent", id: session },
				narratorId: session,
				responsibleUserId: owner.id,
			});
			expect(done.results[0]?.pending).toBe(true);
			const mine = (await readSessionTaskBoard(as(owner.id), session)).sections[0]?.open[0];
			expect(mine?.status).toBe("todo");
			expect(mine?.waiting?.confirmation).toBe(true);
			expect(mine?.completion).toEqual({
				pendingId: done.pending?.id as string,
				status: "done",
				canDecide: true,
			});
			expect(mine?.lock?.by).toMatchObject({ kind: "human", id: owner.id, name: owner.username });
			const theirs = (await readSessionTaskBoard(as(reader.id), session)).sections[0];
			expect(theirs?.canWrite).toBe(false);
			expect(theirs?.open[0]?.completion?.canDecide).toBe(false);
		},
	},
	{
		name: "a project's board: its space, then the session spaces the person may read, paged",
		async run(ctx) {
			const owner = await ctx.user();
			const member = await ctx.user();
			const admin = await ctx.user({ admin: true });
			const project = await ctx.project({ owner: owner.id });
			await ctx.grant(project, member.id, "read");
			const projectSpace = await ensureProjectSpace(project);
			await writeOutline({
				spaceId: projectSpace.id,
				ops: [{ op: "insert", parent: null, content: "team task", task: { status: "todo" } }],
				actor: { kind: "human", id: owner.id },
				responsibleUserId: owner.id,
			});
			const shared = await ctx.session({
				owner: owner.id,
				projectId: project,
				visibility: "project",
			});
			const priv = await ctx.session({
				owner: owner.id,
				projectId: project,
				visibility: "private",
			});
			const gone = await ctx.session({
				owner: owner.id,
				projectId: project,
				visibility: "project",
				archived: true,
			});
			const elsewhere = await ctx.session({ owner: owner.id, visibility: "project" });
			for (const [narratorId, text] of [
				[shared, "shared task"],
				[priv, "private task"],
				[gone, "archived task"],
				[elsewhere, "other project's task"],
			] as const) {
				await addPersonTask({ narratorId, userId: owner.id, text, lock: false });
			}
			const sessionsOf = async (principal: OutlinePrincipal) =>
				(await readProjectSessionSpacePage(principal, project, { limit: 10 }))
					.map((space) => space.narratorId)
					.sort();
			expect(await sessionsOf(as(owner.id))).toEqual([shared, priv].sort());
			expect(await sessionsOf(as(member.id))).toEqual([shared]);
			expect(await sessionsOf({ userId: admin.id, isAdmin: true })).toEqual([shared, priv].sort());
			// A page at a time, in narrator id order.
			const firstPage = await readProjectSessionSpacePage(as(owner.id), project, { limit: 1 });
			const nextPage = await readProjectSessionSpacePage(as(owner.id), project, {
				limit: 1,
				afterNarratorId: firstPage[0]?.narratorId as string,
			});
			expect([firstPage[0]?.narratorId, nextPage[0]?.narratorId]).toEqual([shared, priv].sort());
			const board = await readProjectTaskBoard(as(member.id), project);
			expect(board.scope).toEqual({ kind: "project", projectId: project });
			expect(board.sections.map((s) => s.space.id)).toEqual([
				projectSpace.id,
				(await ensureSessionSpace(shared)).id,
			]);
			expect(titles(board.sections[0]?.open ?? [])).toEqual(["team task"]);
			expect(board.sections[0]?.open[0]?.executor).toEqual({ kind: "none" });
			expect(titles(board.sections[1]?.open ?? [])).toEqual(["shared task"]);
			expect(board.sections[1]?.open[0]?.executor).toMatchObject({
				kind: "session",
				narratorId: shared,
			});
			expect(board.sections.every((s) => !s.canWrite)).toBe(true);
			expect(board.nextCursor).toBeNull();
			const ownerBoard = await readProjectTaskBoard(as(owner.id), project);
			expect(ownerBoard.sections).toHaveLength(3);
			expect(ownerBoard.sections.every((s) => s.canWrite)).toBe(true);
		},
	},
];
