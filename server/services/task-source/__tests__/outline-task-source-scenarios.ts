/**
 * The outline task source on its store: scenarios that run on SQLite (`outline-task-source.test.ts`)
 * and on PostgreSQL (`tests/server/services/outline/pg-outline-task-source.test.ts`), with the
 * outline store and access executor of that database injected.
 *
 * They cover what PR 3 reads and writes through the store: the session's task backend (a
 * subagent follows its root), the candidate reads behind current / next / open / protected, the
 * promotion claim through the write path, waiting as `blocked` and its revision key, and a
 * subagent having no tasks (D27c). Behaviour that goes through the narrator runtime (modes,
 * prompts, the end-to-end run) is SQLite-only and lives in the test file.
 */
import { expect } from "bun:test";
import { settings } from "../../../lib/settings";
import { newOutlineSid } from "../../outline/keys";
import { ensureSessionSpace } from "../../outline/spaces";
import { outlineStore } from "../../outline/store";
import { type OutlineOp, writeOutline } from "../../outline/write";
import { resolveTaskBackend, taskSourceForNarrator } from "../index";
import type { SeedTask } from "./task-source-contract.harness";

export interface OutlineScenarioContext {
	/** A root session with this task backend (default `outline`), owned by `owner`. */
	session(options?: { backend?: "spec" | "outline"; owner?: string | null }): Promise<string>;
	/** A subagent of `rootId`; its own column says `backend` (default `spec`: it must not matter). */
	subagent(rootId: string, options?: { backend?: "spec" | "outline" }): Promise<string>;
}

export interface OutlineScenario {
	name: string;
	run(ctx: OutlineScenarioContext): Promise<void>;
}

/** The sid of the person's task the last `blocked` seed of each session waits for. */
const prerequisites = new Map<string, string>();

/**
 * Replace the session's tasks with these, in this order, on one page of its session space:
 * `blocked` is a task in progress waiting on a prerequisite a person is doing (the session can
 * neither continue it nor the prerequisite), `protected` a task a person created. Written as the
 * session, so the tasks in progress are its claims.
 */
export async function seedOutlineTasks(
	narratorId: string,
	tasks: readonly SeedTask[],
): Promise<{ spaceKey: string }> {
	const space = await ensureSessionSpace(narratorId);
	const pages = await outlineStore.listChildMetas(space.id, [null], 100);
	const ops: OutlineOp[] = pages.map((page) => ({ op: "delete", block: { id: page.id } }));
	// A sid is unique in its space for good, deleted blocks included: each seed takes a new one.
	const prerequisite = newOutlineSid();
	if (tasks.some((task) => task.status === "blocked")) {
		prerequisites.set(narratorId, prerequisite);
		ops.push({ op: "insert", tempId: "pre", parent: null, content: "Prerequisites" });
		ops.push({
			op: "insert",
			sid: prerequisite,
			parent: { tempId: "pre" },
			content: "Someone else's step",
			task: { status: "todo", assignee: "human:pat" },
		});
	}
	ops.push({ op: "insert", tempId: "page", parent: null, content: "Tasks" });
	for (const task of tasks) {
		ops.push({
			op: "insert",
			parent: { tempId: "page" },
			content: task.text,
			task: {
				status: task.status === "blocked" ? "doing" : task.status,
				...(task.protected ? { humanCreated: true } : {}),
				...(task.status === "blocked"
					? { depends: [{ target: `${space.key}/${prerequisite}`, label: null }] }
					: {}),
			},
		});
	}
	await writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "agent", id: narratorId },
		narratorId,
		responsibleUserId: null,
	});
	return { spaceKey: space.key };
}

/** Finish the prerequisite `blocked` seeds wait for, as the person doing it. */
export async function finishPrerequisite(narratorId: string): Promise<void> {
	const space = await ensureSessionSpace(narratorId);
	await writeOutline({
		spaceId: space.id,
		ops: [
			{
				op: "setTask",
				block: { sid: prerequisites.get(narratorId) ?? "" },
				task: { status: "done" },
			},
		],
		actor: { kind: "human", id: "pat" },
		responsibleUserId: null,
	});
}

/** The stored task fields and claim of the session's block with this text. */
export async function taskState(narratorId: string, text: string) {
	const space = await ensureSessionSpace(narratorId);
	const pages = await outlineStore.listChildMetas(space.id, [null], 100);
	const blocks = await outlineStore.listChildMetas(
		space.id,
		pages.map((p) => p.id),
		1000,
	);
	const full = await outlineStore.getBlocks(blocks.map((b) => b.id));
	const block = full.find((b) => b.content === text && !b.deleted);
	if (!block) throw new Error(`no task ${JSON.stringify(text)}`);
	const [claim] = await outlineStore.getTaskClaims([block.id]);
	return { block, claim: claim ?? null, address: `${space.key}/${block.sid}` };
}

export const OUTLINE_TASK_SOURCE_SCENARIOS: OutlineScenario[] = [
	{
		name: "the backend is the session's: a subagent follows its root, spec while switched off",
		async run(ctx) {
			const outline = await ctx.session();
			const spec = await ctx.session({ backend: "spec" });
			const sub = await ctx.subagent(outline, { backend: "spec" });
			const specSub = await ctx.subagent(spec, { backend: "outline" });
			expect(await resolveTaskBackend(outline)).toBe("outline");
			expect(await resolveTaskBackend(spec)).toBe("spec");
			expect(await resolveTaskBackend(sub)).toBe("outline");
			expect(await resolveTaskBackend(specSub)).toBe("spec");
			expect(await resolveTaskBackend(`missing-${outline}`)).toBe("spec");
			expect((await taskSourceForNarrator(sub)).backend).toBe("outline");
			const before = settings.outline.enabled;
			settings.outline.enabled = false;
			try {
				expect(await resolveTaskBackend(outline)).toBe("spec");
			} finally {
				settings.outline.enabled = before;
			}
		},
	},
	{
		name: "reads: document order, waiting as blocked, person-created as protected",
		async run(ctx) {
			const id = await ctx.session();
			await seedOutlineTasks(id, [
				{ text: "Alpha", status: "done" },
				{ text: "Bravo", status: "todo", protected: true },
				{ text: "Charlie", status: "doing" },
				{ text: "Delta", status: "blocked", protected: true },
				{ text: "Echo", status: "todo" },
			]);
			const source = await taskSourceForNarrator(id);
			expect(await source.currentTask()).toEqual({
				text: "Charlie",
				status: "doing",
				protected: false,
			});
			expect(await source.nextTask()).toEqual({ text: "Bravo", status: "todo", protected: true });
			const open = await source.openTasks();
			expect(open.tasks.map((t) => [t.text, t.status, t.protected])).toEqual([
				["Bravo", "todo", true],
				["Charlie", "doing", false],
				["Delta", "blocked", true],
				["Echo", "todo", false],
			]);
			expect(open.revision).toMatch(/^outline:/);
			expect((await source.openTasks()).revision).toBe(open.revision);
			expect(await source.protectedOpenCount()).toBe(2);
		},
	},
	{
		name: "promotion claims the first to-do through the write path, on a lease",
		async run(ctx) {
			const id = await ctx.session();
			await seedOutlineTasks(id, [
				{ text: "First step", status: "todo" },
				{ text: "Second step", status: "todo" },
			]);
			const source = await taskSourceForNarrator(id);
			expect(await source.prepareContinuation({ promoteTodo: false })).toEqual({
				openTask: null,
				protectedOpenCount: 0,
			});
			expect((await taskState(id, "First step")).claim).toBeNull();
			const target = await source.prepareContinuation({ promoteTodo: true });
			expect(target.openTask).toEqual({ text: "First step", protected: false, status: "doing" });
			const { block, claim } = await taskState(id, "First step");
			expect(block.taskJson?.status).toBe("doing");
			expect(claim?.holderNarratorId).toBe(id);
			expect(claim?.epoch).toBe(1);
			expect(claim?.expiresAt).not.toBeNull();
			// Promoting again changes nothing: the task is in progress already.
			await source.prepareContinuation({ promoteTodo: true });
			expect((await taskState(id, "First step")).claim?.epoch).toBe(1);
			expect((await taskState(id, "Second step")).block.taskJson?.status).toBe("todo");
		},
	},
	{
		name: "every task waiting: the target is blocked until the prerequisite finishes",
		async run(ctx) {
			const id = await ctx.session();
			await seedOutlineTasks(id, [{ text: "Ship it", status: "blocked" }]);
			const source = await taskSourceForNarrator(id);
			expect(await source.prepareContinuation({ promoteTodo: true })).toEqual({
				openTask: { text: "Ship it", protected: false, status: "blocked" },
				protectedOpenCount: 0,
			});
			expect(await source.currentTask()).toBeNull();
			const waiting = (await source.openTasks()).revision;
			// Nothing written to the task itself, yet the open list changed (D27b).
			await finishPrerequisite(id);
			const free = await source.openTasks();
			expect(free.tasks.map((t) => t.status)).toEqual(["doing"]);
			expect(free.revision).not.toBe(waiting);
			expect((await source.prepareContinuation({ promoteTodo: true })).openTask).toEqual({
				text: "Ship it",
				protected: false,
				status: "doing",
			});
		},
	},
	{
		name: "a subagent has no tasks of its own and continues on its turn budget only",
		async run(ctx) {
			const root = await ctx.session();
			await seedOutlineTasks(root, [
				{ text: "Root work", status: "doing", protected: true },
				{ text: "Root next", status: "todo" },
			]);
			const sub = await ctx.subagent(root);
			const source = await taskSourceForNarrator(sub);
			expect(source.backend).toBe("outline");
			expect(await source.currentTask()).toBeNull();
			expect(await source.nextTask()).toBeNull();
			expect((await source.openTasks()).tasks).toEqual([]);
			expect(await source.protectedOpenCount()).toBe(0);
			expect(await source.prepareContinuation({ promoteTodo: true })).toEqual({
				openTask: null,
				protectedOpenCount: 0,
				turnBudgetOnly: true,
			});
			expect(await source.taskDigest()).toBeNull();
			expect(await source.compactContext("en")).toBeNull();
			// Nothing of the root's was started for the subagent.
			expect((await taskState(root, "Root next")).block.taskJson?.status).toBe("todo");
		},
	},
	{
		name: "the digest names tasks by address in outline words",
		async run(ctx) {
			const id = await ctx.session();
			const { spaceKey } = await seedOutlineTasks(id, [
				{ text: "Write the parser", status: "doing", protected: true },
				{ text: "Waiting on access", status: "blocked" },
				{ text: "Write the printer", status: "todo" },
			]);
			const digest = await (await taskSourceForNarrator(id)).taskDigest();
			expect(digest?.kind).toBe("tasks");
			if (digest?.kind !== "tasks") return;
			expect(digest.variant).toBe("current");
			expect(digest.tasks?.map((t) => [t.role, t.text, t.protected === true])).toEqual([
				["doing", "Write the parser", true],
				["blocked", "Waiting on access", false],
				["todo", "Write the printer", false],
			]);
			for (const task of digest.tasks ?? [])
				expect(task.ref?.startsWith(`${spaceKey}/`)).toBe(true);
		},
	},
];
