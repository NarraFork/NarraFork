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
import { canWriteSpace, type OutlinePrincipal } from "../access";
import { readProjectSessionSpacePage } from "../access-reads";
import { OutlineConflictError } from "../errors";
import { OUTLINE_BEHAVIOR_ALIAS } from "../model";
import { lockOutlineTask } from "../pending";
import { addPersonTask, changePersonTask, OUTLINE_TASKS_PAGE_ALIAS } from "../person-tasks";
import { ensureProjectSpace, ensureSessionSpace } from "../spaces";
import { outlineStore } from "../store";
import { readFinishedTasks, readProjectTaskBoard, readSessionTaskBoard } from "../task-board";
import { writeOutline } from "../write";

export interface BoardScenarioContext {
	/** A person; `suffix` ends their (otherwise generated) username. */
	user(options?: { admin?: boolean; suffix?: string }): Promise<{ id: string; username: string }>;
	project(options: { owner: string; visibility?: "private" | "public" }): Promise<string>;
	/** A root session, under `projectId` through its explicit project. */
	session(options: {
		owner: string;
		projectId?: string | null;
		visibility?: "private" | "project" | "public";
		archived?: boolean;
		/** Who besides its owner may write it (default `owner`). */
		writeAudience?: "owner" | "project" | "public";
	}): Promise<string>;
	/** A project grant to a person. */
	grant(projectId: string, userId: string, capability: "read" | "write"): Promise<void>;
	/** A session grant to a person. */
	grantSession(narratorId: string, userId: string, capability: "read" | "write"): Promise<void>;
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
		name: "a person's task: locked in the commit that adds it, on the task page, deduped",
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
		name: "dedupe compares the whole body: long first lines, the paragraphs written with it",
		async run(ctx) {
			const owner = await ctx.user();
			const session = await ctx.session({ owner: owner.id });
			const add = (text: string) =>
				addPersonTask({ narratorId: session, userId: owner.id, text, lock: true });
			// A first line longer than the head the scan reads (review round 1, P1).
			const long = `Fix ${"the login flow and ".repeat(30)}end`;
			expect(long.length).toBeGreaterThan(500);
			const first = await add(long);
			expect(first.added).toBe(true);
			expect(await add(long)).toMatchObject({ added: false, blockId: first.blockId });
			// The same beginning past the head, a different end: another task.
			expect((await add(`${long} too`)).added).toBe(true);
			// Same first paragraph, different acceptance: another goal; the same again: not.
			const a = await add("Ship the release\n\nAcceptance: the smoke tests pass");
			expect(a.added).toBe(true);
			const b = await add("Ship the release\n\nAcceptance: the docs are out");
			expect(b.added).toBe(true);
			expect(await add("Ship the release\n\nAcceptance:  the docs are out ")).toMatchObject({
				added: false,
				blockId: b.blockId,
			});
			// The first paragraph alone is a goal of its own.
			const c = await add("Ship the release");
			expect(c.added).toBe(true);
			// Steps the agent adds under a goal later are not its body.
			const space = await tasksOf(session);
			await writeOutline({
				spaceId: space.id,
				ops: [
					{
						op: "insert",
						parent: { id: a.blockId },
						content: "tag the build",
						task: { status: "todo" },
					},
				],
				actor: { kind: "agent", id: session },
				narratorId: session,
				responsibleUserId: owner.id,
			});
			expect(await add("Ship the release\n\nAcceptance: the smoke tests pass")).toMatchObject({
				added: false,
				blockId: a.blockId,
			});
		},
	},
	{
		name: "the task page's alias is reserved from agents in session spaces, not from people",
		async run(ctx) {
			const owner = await ctx.user();
			const session = await ctx.session({ owner: owner.id });
			const goal = await addPersonTask({
				narratorId: session,
				userId: owner.id,
				text: "Ship the release",
				lock: true,
			});
			const space = await tasksOf(session);
			const pageId = (await outlineStore.getBlock(goal.blockId))?.parentId as string;
			const agent = {
				actor: { kind: "agent" as const, id: session },
				narratorId: session,
				responsibleUserId: owner.id,
			};
			const refused = async (ops: Parameters<typeof writeOutline>[0]["ops"]) => {
				let code: string | undefined;
				try {
					await writeOutline({ spaceId: space.id, ops, ...agent });
				} catch (error) {
					code = (error as { code?: string }).code;
				}
				expect(code).toBe("OUTLINE_TASKS_PAGE_RESERVED");
			};
			// The agent writes under it: a step under the goal, a task of its own on the page.
			const steps = await writeOutline({
				spaceId: space.id,
				ops: [
					{
						op: "insert",
						parent: { id: goal.blockId },
						content: "tag it",
						task: { status: "todo" },
					},
					{
						op: "insert",
						parent: { id: pageId },
						content: "my own step",
						task: { status: "todo" },
					},
					{ op: "insert", tempId: "elsewhere", parent: null, content: "Notes" },
				],
				...agent,
			});
			const notes = steps.results[2]?.blockId as string;
			// It may not take the alias away, move the page under a block, or delete it.
			await refused([{ op: "update", block: { id: pageId }, alias: null }]);
			await refused([{ op: "move", block: { id: pageId }, parent: { id: notes } }]);
			await refused([{ op: "delete", block: { id: pageId } }]);
			// Nor give it to a page of its own in a session without one.
			const other = await ctx.session({ owner: owner.id });
			const otherSpace = await tasksOf(other);
			let code: string | undefined;
			try {
				await writeOutline({
					spaceId: otherSpace.id,
					ops: [{ op: "insert", parent: null, content: "Tasks", alias: OUTLINE_TASKS_PAGE_ALIAS }],
					actor: { kind: "agent", id: other },
					narratorId: other,
					responsibleUserId: owner.id,
				});
			} catch (error) {
				code = (error as { code?: string }).code;
			}
			expect(code).toBe("OUTLINE_TASKS_PAGE_RESERVED");
			expect((await outlineStore.getBlock(pageId))?.alias).toBe(OUTLINE_TASKS_PAGE_ALIAS);
			// A person may: the alias moves to another page, and the next goal goes there.
			await writeOutline({
				spaceId: space.id,
				ops: [
					{ op: "update", block: { id: pageId }, alias: null },
					{ op: "update", block: { id: notes }, alias: OUTLINE_TASKS_PAGE_ALIAS },
				],
				actor: { kind: "human", id: owner.id },
				responsibleUserId: owner.id,
			});
			const next = await addPersonTask({
				narratorId: session,
				userId: owner.id,
				text: "Write the notes",
				lock: true,
			});
			expect((await outlineStore.getBlock(next.blockId))?.parentId).toBe(notes);
			// In a project space the alias means nothing: an agent may hold it.
			const projectId = await ctx.project({ owner: owner.id });
			const projectSpace = await ensureProjectSpace(projectId);
			await writeOutline({
				spaceId: projectSpace.id,
				ops: [{ op: "insert", parent: null, content: "Tasks", alias: OUTLINE_TASKS_PAGE_ALIAS }],
				...agent,
			});
		},
	},
	{
		name: "hand to someone: names ending in -, and an admin without access answers as unknown",
		async run(ctx) {
			// SSO derives names such as `user-` or `<base>-<id>`: they can be named and hand to self.
			const owner = await ctx.user({ suffix: "-" });
			expect(owner.username).toEndWith("-");
			const admin = await ctx.user({ admin: true });
			const session = await ctx.session({ owner: owner.id });
			const goal = await addPersonTask({
				narratorId: session,
				userId: owner.id,
				text: "Hand me over",
				lock: false,
			});
			const version = async () => (await outlineStore.getBlock(goal.blockId))?.versionSeq as number;
			await changePersonTask({
				principal: as(owner.id),
				blockId: goal.blockId,
				baseVersionSeq: await version(),
				assign: { kind: "me" },
			});
			expect((await outlineStore.getBlock(goal.blockId))?.taskJson?.assignee).toBe(
				`human:${owner.username}`,
			);
			await changePersonTask({
				principal: as(owner.id),
				blockId: goal.blockId,
				baseVersionSeq: await version(),
				assign: { kind: "session" },
			});
			await changePersonTask({
				principal: as(owner.id),
				blockId: goal.blockId,
				baseVersionSeq: await version(),
				assign: { kind: "user", username: `@${owner.username}` },
			});
			expect((await outlineStore.getBlock(goal.blockId))?.taskJson?.assignee).toBe(
				`human:${owner.username}`,
			);
			// An admin who holds no grant here, and a name nobody has: the same refusal.
			const refusal = async (username: string) => {
				try {
					await changePersonTask({
						principal: as(owner.id),
						blockId: goal.blockId,
						baseVersionSeq: await version(),
						assign: { kind: "user", username },
					});
				} catch (error) {
					return (error as Error).message.replace(username, "<name>");
				}
				return "accepted";
			};
			const unknown = await refusal(`nobody${owner.id.replace(/[^A-Za-z0-9]/g, "")}`);
			expect(unknown).toContain("No one named <name> can work on this task");
			expect(await refusal(admin.username)).toBe(unknown);
		},
	},
	{
		name: "the project board's writable sections match the write rule for every kind of writer",
		async run(ctx) {
			const owner = await ctx.user();
			const writer = await ctx.user();
			const reader = await ctx.user();
			const granted = await ctx.user();
			const admin = await ctx.user({ admin: true });
			const projectId = await ctx.project({ owner: owner.id });
			await ctx.grant(projectId, writer.id, "write");
			await ctx.grant(projectId, reader.id, "read");
			await ctx.grant(projectId, granted.id, "read");
			const sessions = {
				open: await ctx.session({
					owner: owner.id,
					projectId,
					visibility: "project",
					writeAudience: "public",
				}),
				project: await ctx.session({
					owner: owner.id,
					projectId,
					visibility: "project",
					writeAudience: "project",
				}),
				ownerOnly: await ctx.session({ owner: owner.id, projectId, visibility: "project" }),
				grantedOnly: await ctx.session({ owner: owner.id, projectId, visibility: "project" }),
				writersOwn: await ctx.session({ owner: writer.id, projectId, visibility: "project" }),
			};
			await ctx.grantSession(sessions.grantedOnly, granted.id, "write");
			for (const narratorId of Object.values(sessions))
				await addPersonTask({ narratorId, userId: owner.id, text: "A task", lock: false });
			for (const person of [owner, writer, reader, granted, admin]) {
				const principal: OutlinePrincipal = {
					userId: person.id,
					isAdmin: person === admin,
				};
				const board = await readProjectTaskBoard(principal, projectId);
				expect(board.sections.length).toBeGreaterThanOrEqual(5);
				for (const section of board.sections) {
					const space = await outlineStore.getSpace(section.space.id);
					if (!space) throw new Error("expected the space");
					expect({ space: space.narratorId, canWrite: section.canWrite }).toEqual({
						space: space.narratorId,
						canWrite: await canWriteSpace(principal, space),
					});
				}
			}
		},
	},
	{
		name: "a space with more open tasks than shown shows the ones in progress or locked, and says which space",
		async run(ctx) {
			const owner = await ctx.user();
			const projectId = await ctx.project({ owner: owner.id });
			const space = await ensureProjectSpace(projectId);
			const human = {
				actor: { kind: "human" as const, id: owner.id },
				responsibleUserId: owner.id,
			};
			// The backlog first (the oldest rows), then a page placed first in document order.
			const backlog = OUTLINE_TASK_BOARD_LIMITS.projectOpen + 5;
			await writeOutline({
				spaceId: space.id,
				ops: [
					{ op: "insert", tempId: "b", parent: null, content: "Backlog" },
					...Array.from({ length: backlog }, (_, i) => ({
						op: "insert" as const,
						parent: { tempId: "b" },
						content: `backlog ${i}`,
						task: { status: "todo" as const },
					})),
				],
				...human,
			});
			const now = await writeOutline({
				spaceId: space.id,
				ops: [
					{ op: "insert", tempId: "n", parent: null, position: { first: true }, content: "Now" },
					{
						op: "insert",
						parent: { tempId: "n" },
						content: "URGENT in progress",
						task: { status: "doing" },
					},
					{
						op: "insert",
						parent: { tempId: "n" },
						content: "Locked goal",
						task: { status: "todo" },
					},
				],
				...human,
			});
			await lockOutlineTask({ blockId: now.results[2]?.blockId as string, userId: owner.id });
			const board = await readProjectTaskBoard(as(owner.id), projectId);
			const section = board.sections.find((s) => s.space.id === space.id);
			if (!section) throw new Error("expected the project space");
			expect(section.openTruncated).toBe(true);
			expect(section.open).toHaveLength(OUTLINE_TASK_BOARD_LIMITS.projectOpen);
			// In document order: the page placed first comes first.
			expect(titles(section.open).slice(0, 2)).toEqual(["URGENT in progress", "Locked goal"]);
			expect(titles(section.open).filter((t) => t.startsWith("backlog"))).toHaveLength(
				OUTLINE_TASK_BOARD_LIMITS.projectOpen - 2,
			);
			// A space within its cap is not cut.
			const session = await ctx.session({ owner: owner.id, projectId, visibility: "project" });
			await addPersonTask({ narratorId: session, userId: owner.id, text: "Small", lock: false });
			const again = await readProjectTaskBoard(as(owner.id), projectId);
			const small = again.sections.find((s) => s.space.narratorId === session);
			expect(small?.openTruncated).toBe(false);
			expect(again.sections.find((s) => s.space.id === space.id)?.openTruncated).toBe(true);
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
