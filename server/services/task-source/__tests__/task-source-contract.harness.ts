/**
 * The task source contract: every task backend runs this same suite.
 *
 * It asserts only the semantics readers rely on (current, next, the open list, the
 * protected count, which task continues, promotion, the revision key, what the injected
 * text contains), never a backend's wording. Each backend pins its own wording in its own
 * tests (spec: `spec-task-source.test.ts`).
 *
 * Adding a backend: write a harness that turns a `SeedTask` into that backend's real data
 * (outline: `blocked` becomes an in-progress task waiting on a person or a prerequisite,
 * `protected` a human-created task), then call `describeTaskSourceContract`.
 */

import { describe, expect, test } from "bun:test";
import { taskSourceForNarrator } from "../index";
import type { ContinuationTask, OpenTaskView, TaskBackend, TaskStatus } from "../types";

export interface SeedTask {
	text: string;
	status: TaskStatus;
	protected?: boolean;
}

export interface TaskSourceContractHarness {
	backend: TaskBackend;
	/** A new narrator with no tasks and an empty fence, whose task source resolves to `backend`. */
	createNarrator(): Promise<string>;
	/** Replace the narrator's tasks with these, in this order. */
	seedTasks(narratorId: string, tasks: readonly SeedTask[]): Promise<void>;
	/** Write the narrator's behavior fence. */
	seedBehaviorFence(narratorId: string, text: string): Promise<void>;
	/**
	 * Optional: make this narrator's tasks and fence unreadable until the returned restore
	 * runs. Without it the failure-semantics tests are skipped.
	 */
	makeUnreadable?(narratorId: string): Promise<() => void>;
}

const texts = (tasks: readonly { text: string }[]) => tasks.map((task) => task.text);
const STANDALONE_SEVEN = /(?<![0-9])7(?![0-9])/;

export function describeTaskSourceContract(harness: TaskSourceContractHarness): void {
	async function sourceWith(tasks: readonly SeedTask[] = []) {
		const narratorId = await harness.createNarrator();
		if (tasks.length > 0) await harness.seedTasks(narratorId, tasks);
		const source = await taskSourceForNarrator(narratorId);
		return { narratorId, source };
	}

	describe(`task source contract (${harness.backend})`, () => {
		test("resolves to this backend, bound to the narrator", async () => {
			const { narratorId, source } = await sourceWith();
			expect(source.backend).toBe(harness.backend);
			expect(source.narratorId).toBe(narratorId);
		});

		describe("task data", () => {
			test("a narrator without tasks has nothing current, next, open or protected", async () => {
				const { source } = await sourceWith();
				expect(await source.currentTask()).toBeNull();
				expect(await source.nextTask()).toBeNull();
				expect((await source.openTasks()).tasks).toEqual([]);
				expect(await source.protectedOpenCount()).toBe(0);
			});

			test("current is the first doing task, wherever the todo tasks sit", async () => {
				const { source } = await sourceWith([
					{ text: "Alpha", status: "done" },
					{ text: "Bravo", status: "todo" },
					{ text: "Charlie", status: "doing" },
					{ text: "Delta", status: "blocked" },
					{ text: "Echo", status: "todo" },
					{ text: "Foxtrot", status: "doing" },
				]);
				expect(await source.currentTask()).toEqual({
					text: "Charlie",
					status: "doing",
					protected: false,
				});
			});

			// `nextTask` is pinned only where every reasonable reading agrees: no todo before the
			// current task (spec takes the first todo anywhere; a backend may take the first todo
			// after the current one).
			test("next is the first todo after the current task", async () => {
				const { source } = await sourceWith([
					{ text: "Alpha", status: "done" },
					{ text: "Charlie", status: "doing" },
					{ text: "Delta", status: "blocked" },
					{ text: "Echo", status: "todo" },
					{ text: "Foxtrot", status: "doing" },
					{ text: "Golf", status: "todo" },
				]);
				expect(await source.nextTask()).toEqual({ text: "Echo", status: "todo", protected: false });
			});

			test("with nothing in progress, next is the first todo", async () => {
				const { source } = await sourceWith([
					{ text: "Alpha", status: "done" },
					{ text: "Delta", status: "blocked" },
					{ text: "Echo", status: "todo", protected: true },
					{ text: "Golf", status: "todo" },
				]);
				expect(await source.currentTask()).toBeNull();
				expect(await source.nextTask()).toEqual({ text: "Echo", status: "todo", protected: true });
			});

			test("open tasks keep the source order and leave out finished ones", async () => {
				const { source } = await sourceWith([
					{ text: "Alpha", status: "done" },
					{ text: "Bravo", status: "todo" },
					{ text: "Charlie", status: "doing" },
					{ text: "Delta", status: "blocked" },
					{ text: "Echo", status: "done" },
					{ text: "Foxtrot", status: "todo" },
				]);
				const { tasks, revision } = await source.openTasks();
				expect(texts(tasks)).toEqual(["Bravo", "Charlie", "Delta", "Foxtrot"]);
				expect(tasks.map((task) => task.status)).toEqual(["todo", "doing", "blocked", "todo"]);
				// The interrupt guard dedupes on the key and treats null as a key: with open tasks
				// it must be a real one.
				expect(revision).not.toBeNull();
			});

			test("only unfinished protected tasks count as protected and open", async () => {
				const { source } = await sourceWith([
					{ text: "Guarded doing", status: "doing", protected: true },
					{ text: "Guarded done", status: "done", protected: true },
					{ text: "Guarded todo", status: "todo", protected: true },
					{ text: "Guarded blocked", status: "blocked", protected: true },
					{ text: "Plain todo", status: "todo" },
				]);
				expect(await source.protectedOpenCount()).toBe(3);
				const { tasks } = await source.openTasks();
				expect(tasks.map((task) => [task.text, task.protected])).toEqual([
					["Guarded doing", true],
					["Guarded todo", true],
					["Guarded blocked", true],
					["Plain todo", false],
				]);
			});

			test("the revision key is stable without writes and moves with the open tasks", async () => {
				const { narratorId, source } = await sourceWith([{ text: "Alpha", status: "todo" }]);
				const first = (await source.openTasks()).revision;
				expect(first).not.toBeNull();
				expect((await source.openTasks()).revision).toBe(first);
				await harness.seedTasks(narratorId, [
					{ text: "Alpha", status: "todo" },
					{ text: "Bravo", status: "todo" },
				]);
				const second = (await source.openTasks()).revision;
				expect(second).not.toBeNull();
				expect(second).not.toBe(first);
				// A status change alone (here: to blocked/waiting) is a change of the open tasks.
				await harness.seedTasks(narratorId, [
					{ text: "Alpha", status: "blocked" },
					{ text: "Bravo", status: "todo" },
				]);
				const third = (await source.openTasks()).revision;
				expect(third).not.toBeNull();
				expect(third).not.toBe(second);
			});
		});

		describe("continuation", () => {
			test("nothing to continue without tasks", async () => {
				const { source } = await sourceWith();
				expect(await source.prepareContinuation({ promoteTodo: true })).toEqual({
					openTask: null,
					protectedOpenCount: 0,
				});
			});

			test("continues the first doing task even when a blocked task comes first", async () => {
				const { source } = await sourceWith([
					{ text: "Waiting on access", status: "blocked" },
					{ text: "Write the parser", status: "doing" },
					{ text: "Write the printer", status: "doing" },
				]);
				expect(await source.prepareContinuation({ promoteTodo: true })).toEqual({
					openTask: { text: "Write the parser", protected: false, status: "doing" },
					protectedOpenCount: 0,
				});
			});

			test("falls back to the first blocked task when nothing can be in progress", async () => {
				const { source } = await sourceWith([
					{ text: "Done already", status: "done" },
					{ text: "Waiting on access", status: "blocked", protected: true },
					{ text: "Waiting on review", status: "blocked" },
				]);
				const before = (await source.openTasks()).revision;
				expect(await source.prepareContinuation({ promoteTodo: true })).toEqual({
					openTask: { text: "Waiting on access", protected: true, status: "blocked" },
					protectedOpenCount: 1,
				});
				expect((await source.openTasks()).revision).toBe(before);
			});

			test("without promotion a todo-only list has nothing to continue and is not written", async () => {
				const { source } = await sourceWith([
					{ text: "First step", status: "todo" },
					{ text: "Second step", status: "todo" },
				]);
				const before = (await source.openTasks()).revision;
				expect(await source.prepareContinuation({ promoteTodo: false })).toEqual({
					openTask: null,
					protectedOpenCount: 0,
				});
				expect(await source.currentTask()).toBeNull();
				expect((await source.openTasks()).revision).toBe(before);
			});

			test("promotion makes the first todo the current task and persists it", async () => {
				const { source } = await sourceWith([
					{ text: "Done already", status: "done" },
					{ text: "First step", status: "todo", protected: true },
					{ text: "Second step", status: "todo" },
				]);
				const before = (await source.openTasks()).revision;
				expect(await source.prepareContinuation({ promoteTodo: true })).toEqual({
					openTask: { text: "First step", protected: true, status: "doing" },
					protectedOpenCount: 1,
				});
				expect(await source.currentTask()).toEqual({
					text: "First step",
					status: "doing",
					protected: true,
				});
				expect(await source.nextTask()).toEqual({
					text: "Second step",
					status: "todo",
					protected: false,
				});
				expect((await source.openTasks()).revision).not.toBe(before);
			});

			test("promotion picks a todo over a blocked task", async () => {
				const { source } = await sourceWith([
					{ text: "Waiting on access", status: "blocked" },
					{ text: "First step", status: "todo" },
				]);
				expect((await source.prepareContinuation({ promoteTodo: true })).openTask).toEqual({
					text: "First step",
					protected: false,
					status: "doing",
				});
			});

			test("nothing is promoted while a task is in progress", async () => {
				const { source } = await sourceWith([
					{ text: "In flight", status: "doing" },
					{ text: "Queued", status: "todo" },
				]);
				const before = (await source.openTasks()).revision;
				expect((await source.prepareContinuation({ promoteTodo: true })).openTask).toEqual({
					text: "In flight",
					protected: false,
					status: "doing",
				});
				expect(await source.nextTask()).toEqual({
					text: "Queued",
					status: "todo",
					protected: false,
				});
				expect((await source.openTasks()).revision).toBe(before);
			});

			test("the prompt names the task and says the system sent it, in both locales", async () => {
				const { source } = await sourceWith();
				for (const status of ["doing", "blocked"] as const) {
					const task: ContinuationTask = { text: "Ship the migration", protected: false, status };
					for (const [locale, marker] of [
						["en", "system message"],
						["zh-CN", "系统消息"],
					] as const) {
						const open = source.continuationPrompt({ form: "open", task, locale });
						const bounded = source.continuationPrompt({
							form: "bounded",
							task,
							cause: "spec",
							passes: 2,
							maxPasses: 9,
							canAskUserQuestion: false,
							locale,
						});
						for (const prompt of [open, bounded]) {
							expect(prompt).toContain(task.text);
							expect(prompt).toContain(marker);
						}
						// A bounded run is told how many passes it has left (9 − 2 = 7) as a number of
						// its own; an open run has no budget to state. The exact wording is the
						// backend's (spec pins it in its own test).
						expect(bounded).toMatch(STANDALONE_SEVEN);
						expect(open).not.toMatch(STANDALONE_SEVEN);
					}
				}
			});
		});

		describe("injections", () => {
			test("the interrupt note lists the given tasks in order with their roles", async () => {
				const { source } = await sourceWith();
				const tasks: OpenTaskView[] = [
					{ text: "Write the parser", status: "doing", protected: true },
					{ text: "Waiting on access", status: "blocked", protected: false },
					{ text: "Write the printer", status: "todo", protected: false },
				];
				for (const locale of ["en", "zh-CN"] as const) {
					const note = source.interruptGuardNote(tasks, locale);
					const positions = tasks.map((task) => note.content.indexOf(task.text));
					expect(positions.every((position) => position >= 0)).toBe(true);
					expect([...positions].sort((a, b) => a - b)).toEqual(positions);
					expect(note.body.kind).toBe("tasks");
					if (note.body.kind !== "tasks") return;
					expect(
						(note.body.tasks ?? []).map((task) => [task.role, task.text, task.protected === true]),
					).toEqual([
						["doing", "Write the parser", true],
						["blocked", "Waiting on access", false],
						["todo", "Write the printer", false],
					]);
				}
			});

			test("an empty behavior fence injects nothing; a written one is returned", async () => {
				const { narratorId, source } = await sourceWith();
				expect(await source.behaviorFence()).toBeNull();
				await harness.seedBehaviorFence(narratorId, "  Never force-push the main branch.  ");
				const fence = await source.behaviorFence();
				expect(fence?.kind).toBe("prose");
				if (fence?.kind !== "prose") return;
				expect(fence.text).toContain("Never force-push the main branch.");
			});

			test("compact context is absent without tasks and lists every open task", async () => {
				const empty = await sourceWith();
				expect(await empty.source.compactContext("en")).toBeNull();
				expect(await empty.source.compactContext("zh-CN")).toBeNull();

				const { source } = await sourceWith([
					{ text: "Done already", status: "done" },
					{ text: "Write the parser", status: "doing" },
					{ text: "Waiting on access", status: "blocked" },
					{ text: "Write the printer", status: "todo" },
				]);
				for (const locale of ["en", "zh-CN"] as const) {
					const context = await source.compactContext(locale);
					for (const text of ["Write the parser", "Waiting on access", "Write the printer"]) {
						expect(context).toContain(text);
					}
				}
			});

			// Never null while readable: with the default fence settings the behavior fence is
			// injected only alongside a non-null digest, so a quiet digest would drop it too.
			test("a readable source always has a digest, led by the current task", async () => {
				const { source } = await sourceWith([
					{ text: "Write the parser", status: "doing" },
					{ text: "Write the printer", status: "todo" },
				]);
				const digest = await source.taskDigest();
				expect(digest?.kind).toBe("tasks");
				if (digest?.kind !== "tasks") return;
				expect(digest.tasks?.[0]).toMatchObject({ role: "doing", text: "Write the parser" });
			});

			test("without open tasks the digest is an empty variant, never null", async () => {
				const never = await sourceWith();
				expect(await never.source.taskDigest()).toEqual({ kind: "tasks", variant: "emptyNever" });

				const done = await sourceWith([
					{ text: "Write the parser", status: "done" },
					{ text: "Write the printer", status: "done" },
				]);
				expect(await done.source.taskDigest()).toEqual({ kind: "tasks", variant: "emptyDone" });
			});
		});

		describe("unreadable tasks", () => {
			const makeUnreadable = harness.makeUnreadable;
			test.skipIf(!makeUnreadable)(
				"data reads reject, injection reads resolve to null, continuation finds nothing",
				async () => {
					if (!makeUnreadable) return;
					const { narratorId, source } = await sourceWith([
						{ text: "Write the parser", status: "doing", protected: true },
					]);
					await harness.seedBehaviorFence(narratorId, "Never force-push the main branch.");
					const restore = await makeUnreadable.call(harness, narratorId);
					try {
						await expect(source.currentTask()).rejects.toThrow();
						await expect(source.nextTask()).rejects.toThrow();
						await expect(source.openTasks()).rejects.toThrow();
						await expect(source.protectedOpenCount()).rejects.toThrow();
						await expect(source.prepareContinuation({ promoteTodo: true })).rejects.toThrow();
						expect(await source.taskDigest()).toBeNull();
						expect(await source.behaviorFence()).toBeNull();
						expect(await source.compactContext("en")).toBeNull();
						// The continuation reader treats it as nothing to continue.
						const { readSpecContinuationState } = await import("../../narrator-session");
						expect(await readSpecContinuationState(narratorId)).toEqual({
							openTask: null,
							protectedOpenCount: 0,
						});
					} finally {
						restore();
					}
				},
			);
		});
	});
}
