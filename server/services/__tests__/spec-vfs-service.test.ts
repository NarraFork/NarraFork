/**
 * Integration tests for the Living Work Spec VFS.
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
	forkSpecNamespace,
	listSpecFiles,
	readSpecFile,
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
		const help = await readSpecFile(parentNarratorId, "spec://HOW_TO_USE_SPEC.md");
		expect(help.readonly).toBe(true);
		expect(help.content).toContain("tasks.json");

		const files = await listSpecFiles(parentNarratorId);
		expect(files.map((file) => file.uri)).toContain("spec://tasks.json");
		expect(files.map((file) => file.uri)).toContain("spec://protected_requirements");
	});

	test("rejects writes to read-only built-ins", async () => {
		expect(
			writeSpecFile(parentNarratorId, "spec://protected_requirements", "overwrite"),
		).rejects.toThrow(/read-only/);
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
