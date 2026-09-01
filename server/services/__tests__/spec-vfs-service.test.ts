/**
 * Integration tests for the Dynamic Spec VFS.
 *
 * Run with an isolated data dir, for example:
 * NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$HOME/.narrafork/perf-isolation/spec-vfs-test \
 *   bun test server/services/__tests__/spec-vfs-service.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators, specProtectedTasks } from "../../db/schema";
import { generateId } from "../../lib/id";
import {
	analyzeSpecWriteCandidate,
	appendProtectedSpecTask,
	appendSpecTaskForExternalActor,
	clearSpecTasks,
	deleteSpecFile,
	forkSpecNamespace,
	listSpecFiles,
	readSpecFile,
	readTasksFileForNarrator,
	resetSpecNamespace,
	summarizeSpecTasks,
	writeSpecFile,
} from "../spec-vfs-service";

const TAG = Date.now();
let parentNarratorId: string;
let childNarratorId: string;

function tasksContent(document: unknown): string {
	return `${JSON.stringify(document, null, "\t")}\n`;
}

async function createNarrator(id: string): Promise<void> {
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "default",
		permissionMode: "default",
		status: "idle",
		createdAt: now,
		updatedAt: now,
	});
}

beforeAll(async () => {
	parentNarratorId = `spec-parent-${TAG}`;
	childNarratorId = `spec-child-${TAG}`;
	await createNarrator(parentNarratorId);
	await createNarrator(childNarratorId);
});

describe("spec VFS built-ins", () => {
	test("reads built-in files and lists them", async () => {
		const index = await readSpecFile(parentNarratorId, "spec://index.md");
		expect(index.readonly).toBe(false);
		expect(index.content).toContain("tasks.json");

		const files = await listSpecFiles(parentNarratorId);
		const uris = files.map((file) => file.uri);
		expect(uris).toContain("spec://index.md");
		expect(uris).toContain("spec://tasks.json");
		expect(uris).toContain("spec://behavior_fence");
		expect(uris).not.toContain("spec://HOW_TO_USE_SPEC.md");
	});

	test("rejects agent writes to behavior_fence without a mutation grant", async () => {
		// Default actor is "agent"; behavior_fence is agent-readonly unless allowFenceMutation is set.
		expect(writeSpecFile(parentNarratorId, "spec://behavior_fence", "overwrite")).rejects.toThrow(
			/first tool call of the current user turn/,
		);
	});

	test("allows agent writes to behavior_fence when allowFenceMutation is granted", async () => {
		const body = "# Behavior Fence\n\nAlways run the linter before committing.\n";
		const written = await writeSpecFile(parentNarratorId, "spec://behavior_fence", body, {
			allowFenceMutation: true,
		});
		expect(written.content).toBe(body);
		const reread = await readSpecFile(parentNarratorId, "spec://behavior_fence");
		expect(reread.content).toBe(body);
	});

	test("behavior_fence default content is empty", async () => {
		// A fresh narrator's behavior_fence must be empty so nothing is injected by default.
		const freshId = generateId();
		await createNarrator(freshId);
		const fence = await readSpecFile(freshId, "spec://behavior_fence");
		expect(fence.content).toBe("");
	});

	test("behavior_fence exposes agent-readonly but UI-editable metadata", async () => {
		const fence = await readSpecFile(parentNarratorId, "spec://behavior_fence");
		expect(fence.readonly).toBe(true);
		expect(fence.uiEditable).toBe(true);
	});

	test("allows user (UI) writes to behavior_fence and persists content", async () => {
		const body = "# Behavior Fence\n\nDo not touch the auth module without approval.\n";
		const written = await writeSpecFile(parentNarratorId, "spec://behavior_fence", body, {
			actor: "user",
			createdBy: "user",
		});
		expect(written.readonly).toBe(true);
		expect(written.uiEditable).toBe(true);

		const reread = await readSpecFile(parentNarratorId, "spec://behavior_fence");
		expect(reread.content).toBe(body);
		expect(reread.readonly).toBe(true);
		expect(reread.uiEditable).toBe(true);
	});

	test("rejects deleting built-in behavior_fence", async () => {
		expect(deleteSpecFile(parentNarratorId, "spec://behavior_fence")).rejects.toThrow(
			/built-in file and cannot be deleted/,
		);
	});
});

describe("spec VFS tasks.json writes", () => {
	test("writes and reads spec://tasks.json", async () => {
		const content = JSON.stringify(
			{ tasks: [{ text: "Initial task", status: "doing" }] },
			null,
			"\t",
		);
		const written = await writeSpecFile(parentNarratorId, "spec://tasks.json", `${content}\n`, {
			sourceToolUseId: `tu-${generateId(6)}`,
		});

		expect(written.uri).toBe("spec://tasks.json");
		expect(written.content).toContain("Initial task");
		expect(written.revisionId).toBeTruthy();
	});

	test("creates protected locks and blocks protected completion without reflection", async () => {
		await writeSpecFile(
			parentNarratorId,
			"spec://tasks.json",
			tasksContent({
				tasks: [{ text: "Must verify before completion", status: "doing", protected: true }],
			}),
		);

		const analysis = await analyzeSpecWriteCandidate(
			parentNarratorId,
			"spec://tasks.json",
			tasksContent({
				tasks: [{ text: "Must verify before completion", status: "done", protected: true }],
			}),
		);
		expect(analysis.protectedMutations.map((mutation) => mutation.kind)).toEqual(["complete"]);
		expect(analysis.protectedMutations[0]?.createdBy).toBe("assistant");

		expect(
			writeSpecFile(
				parentNarratorId,
				"spec://tasks.json",
				tasksContent({
					tasks: [{ text: "Must verify before completion", status: "done", protected: true }],
				}),
			),
		).rejects.toThrow(/requires taskReflection/);
	});

	test("allows protected completion when taskReflection grants the mutation", async () => {
		const result = await writeSpecFile(
			parentNarratorId,
			"spec://tasks.json",
			tasksContent({
				tasks: [{ text: "Must verify before completion", status: "done", protected: true }],
			}),
			{ allowProtectedTaskMutation: true },
		);

		expect(result.content).toContain('"status": "done"');
		const namespaceId = result.namespaceId;
		const locks = await db.query.specProtectedTasks.findMany({
			where: eq(specProtectedTasks.namespaceId, namespaceId),
		});
		expect(
			locks.some((lock) => lock.text === "Must verify before completion" && lock.status === "done"),
		).toBe(true);
	});

	test("treats a missing first revision as unknown origin", async () => {
		const narratorId = `spec-origin-unknown-${TAG}`;
		await createNarrator(narratorId);
		const written = await writeSpecFile(
			narratorId,
			"spec://tasks.json",
			tasksContent({
				tasks: [{ text: "Legacy protected task", status: "doing", protected: true }],
			}),
			{ actor: "agent", createdBy: "assistant" },
		);
		await db
			.update(specProtectedTasks)
			.set({ firstRevisionId: null })
			.where(eq(specProtectedTasks.namespaceId, written.namespaceId));

		const analysis = await analyzeSpecWriteCandidate(
			narratorId,
			"spec://tasks.json",
			tasksContent({
				tasks: [{ text: "Legacy protected task", status: "done", protected: true }],
			}),
		);
		expect(analysis.protectedMutations[0]?.createdBy).toBe("unknown");
	});
});

describe("appendProtectedSpecTask (/goal command)", () => {
	test("appends a protected todo task and creates a protected lock", async () => {
		const narratorId = `spec-goal-${TAG}`;
		await createNarrator(narratorId);

		const { added, written } = await appendProtectedSpecTask(narratorId, "  Ship the release  ");
		expect(added).toBe(true);

		const doc = JSON.parse(written.content);
		const task = doc.tasks.find((t: { text: string }) => t.text === "Ship the release");
		expect(task).toMatchObject({ text: "Ship the release", status: "todo", protected: true });

		const locks = await db.query.specProtectedTasks.findMany({
			where: eq(specProtectedTasks.namespaceId, written.namespaceId),
		});
		expect(locks.some((lock) => lock.text === "Ship the release")).toBe(true);

		const analysis = await analyzeSpecWriteCandidate(
			narratorId,
			"spec://tasks.json",
			tasksContent({
				tasks: [{ text: "Ship the release", status: "done", protected: true }],
			}),
		);
		expect(analysis.protectedMutations[0]?.createdBy).toBe("user");
	});

	test("is idempotent — does not duplicate an existing task", async () => {
		const narratorId = `spec-goal-dup-${TAG}`;
		await createNarrator(narratorId);

		await appendProtectedSpecTask(narratorId, "Only once");
		const second = await appendProtectedSpecTask(narratorId, "Only once");
		expect(second.added).toBe(false);

		const file = await readTasksFileForNarrator(narratorId);
		const doc = JSON.parse(file.content);
		const matches = doc.tasks.filter((t: { text: string }) => t.text === "Only once");
		expect(matches).toHaveLength(1);
	});

	test("rejects an empty objective", async () => {
		const narratorId = `spec-goal-empty-${TAG}`;
		await createNarrator(narratorId);
		expect(appendProtectedSpecTask(narratorId, "   ")).rejects.toThrow(/must not be empty/);
	});
});

describe("appendSpecTaskForExternalActor (plugin dispatch)", () => {
	test("an agent-actor append defaults to an ordinary task with no protected lock", async () => {
		const narratorId = `spec-plugin-plain-${TAG}`;
		await createNarrator(narratorId);

		const result = await appendSpecTaskForExternalActor(narratorId, "  Run the sweep  ", {
			protected: false,
			actor: "agent",
		});
		expect(result.added).toBe(true);
		expect(result.protected).toBe(false);

		const doc = JSON.parse(result.written.content);
		const task = doc.tasks.find((t: { text: string }) => t.text === "Run the sweep");
		// `protected` is omitted rather than written as false: the queue format treats a
		// missing flag as unprotected, and an explicit false would read like a decision.
		expect(task).toMatchObject({ text: "Run the sweep", status: "todo" });
		expect(task.protected).toBeUndefined();

		// The decisive assertion: no protected lock row exists, so nothing auto-continues
		// the narrator and the narrator can close this task on its own.
		const locks = await db.query.specProtectedTasks.findMany({
			where: eq(specProtectedTasks.namespaceId, result.written.namespaceId),
		});
		expect(locks.some((lock) => lock.text === "Run the sweep")).toBe(false);
	});

	test("an agent-actor append can still opt in to a protected task, attributed to the agent", async () => {
		const narratorId = `spec-plugin-protected-${TAG}`;
		await createNarrator(narratorId);

		const result = await appendSpecTaskForExternalActor(narratorId, "Hold the line", {
			protected: true,
			actor: "agent",
		});
		expect(result.protected).toBe(true);

		const analysis = await analyzeSpecWriteCandidate(
			narratorId,
			"spec://tasks.json",
			tasksContent({ tasks: [{ text: "Hold the line", status: "done", protected: true }] }),
		);
		// Attributed to the assistant, NOT the user. A plugin-dispatched commitment must not
		// be indistinguishable from one the user made.
		expect(analysis.protectedMutations[0]?.createdBy).toBe("assistant");
	});

	test("re-appending reports the existing task's protection rather than the request", async () => {
		const narratorId = `spec-plugin-existing-${TAG}`;
		await createNarrator(narratorId);

		await appendSpecTaskForExternalActor(narratorId, "Already here", {
			protected: false,
			actor: "agent",
		});
		// Asking for protected on a task that already exists unprotected must not claim the
		// task is now protected — nothing was written, so the report has to match reality.
		const second = await appendSpecTaskForExternalActor(narratorId, "Already here", {
			protected: true,
			actor: "agent",
		});
		expect(second.added).toBe(false);
		expect(second.protected).toBe(false);
	});
});

describe("spec namespace fork", () => {
	test("forks namespace by sharing current revisions and copying protected locks", async () => {
		await writeSpecFile(
			parentNarratorId,
			"spec://tasks.json",
			tasksContent({
				tasks: [
					{ text: "Parent protected task", status: "doing", protected: true },
					{ text: "Parent normal task", status: "todo" },
				],
			}),
			{ allowProtectedTaskMutation: true },
		);

		await forkSpecNamespace(parentNarratorId, childNarratorId);
		const parentTasks = await readSpecFile(parentNarratorId, "spec://tasks.json");
		const childTasks = await readSpecFile(childNarratorId, "spec://tasks.json");
		expect(childTasks.content).toBe(parentTasks.content);
		expect(childTasks.revisionId).toBe(parentTasks.revisionId);

		await writeSpecFile(
			childNarratorId,
			"spec://index.md",
			"# Child-only notes\n\nThis should not affect the parent.\n",
		);
		const parentIndex = await readSpecFile(parentNarratorId, "spec://index.md");
		const childIndex = await readSpecFile(childNarratorId, "spec://index.md");
		expect(parentIndex.content).not.toBe(childIndex.content);

		const childCompletionCandidate = await analyzeSpecWriteCandidate(
			childNarratorId,
			"spec://tasks.json",
			tasksContent({
				tasks: [
					{ text: "Parent protected task", status: "done", protected: true },
					{ text: "Parent normal task", status: "todo" },
				],
			}),
		);
		expect(childCompletionCandidate.protectedMutations.map((mutation) => mutation.kind)).toEqual([
			"complete",
		]);
	});
});

describe("spec fork carryover helpers", () => {
	test("summarizeSpecTasks counts total / open / protected-open", async () => {
		const narratorId = `spec-summary-${TAG}`;
		await createNarrator(narratorId);
		await writeSpecFile(
			narratorId,
			"spec://tasks.json",
			tasksContent({
				tasks: [
					{ text: "Doing protected", status: "doing", protected: true },
					{ text: "Todo normal", status: "todo" },
					{ text: "Blocked one", status: "blocked" },
					{ text: "Done normal", status: "done" },
				],
			}),
			{ allowProtectedTaskMutation: true },
		);

		const summary = await summarizeSpecTasks(narratorId);
		expect(summary.total).toBe(4);
		expect(summary.open).toBe(3); // doing + todo + blocked
		expect(summary.protectedOpen).toBe(1); // the doing protected task
	});

	test("summarizeSpecTasks reports zero for a fresh namespace", async () => {
		const narratorId = `spec-summary-empty-${TAG}`;
		await createNarrator(narratorId);
		const summary = await summarizeSpecTasks(narratorId);
		expect(summary).toEqual({ total: 0, open: 0, protectedOpen: 0 });
	});

	test("clearSpecTasks empties tasks.json and releases protected locks", async () => {
		const narratorId = `spec-clear-${TAG}`;
		await createNarrator(narratorId);
		const written = await writeSpecFile(
			narratorId,
			"spec://tasks.json",
			tasksContent({
				tasks: [{ text: "Protected to clear", status: "doing", protected: true }],
			}),
			{ allowProtectedTaskMutation: true },
		);
		const namespaceId = written.namespaceId;

		const cleared = await clearSpecTasks(narratorId);
		const doc = JSON.parse(cleared.content);
		expect(doc.tasks).toEqual([]);

		const openLocks = await db.query.specProtectedTasks.findMany({
			where: eq(specProtectedTasks.namespaceId, namespaceId),
		});
		// Every prior open lock must now be deleted (released).
		expect(openLocks.every((lock) => lock.status === "deleted")).toBe(true);
	});

	test("clearSpecTasks on the child never affects the parent", async () => {
		const parentId = `spec-clear-parent-${TAG}`;
		const childId = `spec-clear-child-${TAG}`;
		await createNarrator(parentId);
		await createNarrator(childId);
		await writeSpecFile(
			parentId,
			"spec://tasks.json",
			tasksContent({ tasks: [{ text: "Parent keeps this", status: "todo" }] }),
		);
		await forkSpecNamespace(parentId, childId);

		await clearSpecTasks(childId);

		const parentTasks = await readTasksFileForNarrator(parentId);
		const parentDoc = JSON.parse(parentTasks.content);
		expect(parentDoc.tasks).toHaveLength(1);
		expect(parentDoc.tasks[0].text).toBe("Parent keeps this");

		const childTasks = await readTasksFileForNarrator(childId);
		expect(JSON.parse(childTasks.content).tasks).toEqual([]);
	});

	test("resetSpecNamespace restores built-ins, drops custom notes, releases locks", async () => {
		const narratorId = `spec-reset-${TAG}`;
		await createNarrator(narratorId);
		// Seed: protected task, custom index.md, and a custom note file.
		const seeded = await writeSpecFile(
			narratorId,
			"spec://tasks.json",
			tasksContent({ tasks: [{ text: "Reset me", status: "doing", protected: true }] }),
			{ allowProtectedTaskMutation: true },
		);
		const namespaceId = seeded.namespaceId;
		await writeSpecFile(narratorId, "spec://index.md", "# Custom index\n\nchanged\n");
		await writeSpecFile(narratorId, "spec://notes.md", "# Notes\n\nsome notes\n");

		await resetSpecNamespace(narratorId);

		// tasks.json falls back to the empty built-in.
		const tasks = await readTasksFileForNarrator(narratorId);
		expect(JSON.parse(tasks.content).tasks).toEqual([]);

		// index.md reverts to the built-in default (contains the tasks.json pointer).
		const index = await readSpecFile(narratorId, "spec://index.md");
		expect(index.builtin).toBe(true);
		expect(index.content).toContain("tasks.json");

		// The custom note file is gone.
		expect(readSpecFile(narratorId, "spec://notes.md")).rejects.toThrow(/not found/);
		const files = await listSpecFiles(narratorId);
		expect(files.map((f) => f.uri)).not.toContain("spec://notes.md");

		// All previously open protected locks are released.
		const locks = await db.query.specProtectedTasks.findMany({
			where: eq(specProtectedTasks.namespaceId, namespaceId),
		});
		expect(locks.every((lock) => lock.status === "deleted")).toBe(true);
	});

	test("resetSpecNamespace on the child never affects the parent", async () => {
		const parentId = `spec-reset-parent-${TAG}`;
		const childId = `spec-reset-child-${TAG}`;
		await createNarrator(parentId);
		await createNarrator(childId);
		await writeSpecFile(
			parentId,
			"spec://tasks.json",
			tasksContent({ tasks: [{ text: "Parent survives reset", status: "todo" }] }),
		);
		await writeSpecFile(parentId, "spec://notes.md", "# Parent notes\n\nkeep me\n");
		await forkSpecNamespace(parentId, childId);

		await resetSpecNamespace(childId);

		// Parent tasks + custom note intact.
		const parentTasks = await readTasksFileForNarrator(parentId);
		expect(JSON.parse(parentTasks.content).tasks[0].text).toBe("Parent survives reset");
		const parentNotes = await readSpecFile(parentId, "spec://notes.md");
		expect(parentNotes.content).toContain("keep me");

		// Child is reset.
		const childTasks = await readTasksFileForNarrator(childId);
		expect(JSON.parse(childTasks.content).tasks).toEqual([]);
		expect(readSpecFile(childId, "spec://notes.md")).rejects.toThrow(/not found/);
	});
});
