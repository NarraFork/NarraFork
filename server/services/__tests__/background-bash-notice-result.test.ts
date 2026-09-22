import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { backgroundTasks, narratorBufferedMessages, narrators } from "../../db/schema";
import { flushRuntimePublications, runtimePublication } from "../agent-runtime/publication";
import { discardBackgroundBashResult } from "../background-bash-result";
import { backgroundTaskService } from "../background-task-service";
import { projectPendingInjection } from "../parent-injection-queue";

const PARENT = "bash-notice-result-parent";
const paths = new Set<string>();
runtimePublication.stop();
backgroundTaskService.setBroadcastFnForTests(() => {});

beforeEach(() => {
	const now = new Date().toISOString();
	db.insert(narrators)
		.values({ id: PARENT, variant: "primary", status: "idle", createdAt: now, updatedAt: now })
		.run();
});
afterEach(async () => {
	for (const path of paths) await discardBackgroundBashResult(path);
	paths.clear();
	cleanDb(sqlite);
});

async function create(id = "bash-result") {
	await backgroundTaskService.createBashTask({
		id,
		parentNarratorId: PARENT,
		command: "fixture only",
		alias: id,
	});
	const controller = new AbortController();
	backgroundTaskService.registerAbortController(id, controller);
	return { id, controller };
}

async function notices() {
	await flushRuntimePublications(PARENT);
	return db
		.select()
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, PARENT))
		.all()
		.map((row) => {
			const projected = projectPendingInjection(row);
			if (projected.kind !== "bg_bash") throw new Error("Expected Bash notice");
			return projected.task;
		});
}

function outputPath(content: string) {
	const path = /captured output saved to: ([^\n]+)/.exec(content)?.[1];
	if (!path) throw new Error(`Missing output file in: ${content.slice(0, 200)}`);
	paths.add(path);
	return path;
}

describe("real Bash terminal publication result", () => {
	test("short completion includes exact multiline output and exit code", async () => {
		const task = await create();
		expect(
			await backgroundTaskService.markCompleted(task.id, "中文\nsecond line", 7, task.controller),
		).toBe(true);
		const delivered = await notices();
		expect(delivered).toHaveLength(1);
		expect(delivered[0].outputPreview).toBe("中文\nsecond line\n[exit code: 7]");
	});

	test("empty completion is explicit and retains zero exit code", async () => {
		const task = await create();
		await backgroundTaskService.markCompleted(task.id, "", 0, task.controller);
		expect((await notices())[0].outputPreview).toBe("(empty output)\n[exit code: 0]");
	});

	for (const terminal of ["completed", "failed", "timeout", "cancelled"] as const) {
		test(`${terminal} spills before the 512 KiB DB limit and publishes usable file`, async () => {
			const task = await create();
			const output = `${"中".repeat(200_000)}\nunique captured tail`;
			if (terminal === "completed")
				await backgroundTaskService.markCompleted(task.id, output, 0, task.controller);
			else if (terminal === "failed")
				await backgroundTaskService.markFailed(task.id, output, 23, task.controller);
			else if (terminal === "timeout")
				await backgroundTaskService.markTimedOut(task.id, output, 124, task.controller);
			else {
				backgroundTaskService.appendOutput(task.id, output);
				await backgroundTaskService.markCancelled(task.id, task.controller);
			}
			const delivered = await notices();
			expect(delivered).toHaveLength(1);
			expect(delivered[0].status).toBe(terminal);
			const content = delivered[0].outputPreview;
			const path = outputPath(content);
			expect(await fs.readFile(path, "utf8")).toBe(output);
			expect(content).toContain('device: "local"');
			expect(content).toContain("No Await is needed");
			expect(content).toContain("If Read reports that the file was cleaned up");
			expect(content).toContain("may retain only a preview");
			expect(content).toContain("does not guarantee complete output");
			expect(content).toContain("unique captured tail");
			expect(Buffer.byteLength(content)).toBeLessThan(5120);
			if (terminal !== "cancelled")
				expect(content).toContain(
					`[exit code: ${terminal === "completed" ? 0 : terminal === "failed" ? 23 : 124}]`,
				);
			const row = await backgroundTaskService.getById(task.id);
			expect(row?.output).toContain(path);
			expect(row?.outputBytes).toBe(Buffer.byteLength(output));
			expect(await backgroundTaskService.markCompleted(task.id, "duplicate", 0)).toBe(false);
			expect(await notices()).toHaveLength(1);
		});
	}

	test("exact 5120-byte threshold spills through publication", async () => {
		const task = await create();
		const output = "a".repeat(5120);
		await backgroundTaskService.markCompleted(task.id, output, 0, task.controller);
		expect(await fs.readFile(outputPath((await notices())[0].outputPreview), "utf8")).toBe(output);
	});

	test("failed spill retains original bounded DB output for Await", async () => {
		const task = await create();
		const mock = spyOn(fs, "writeFile").mockRejectedValue(new Error("disk unavailable"));
		try {
			await backgroundTaskService.markCompleted(task.id, "x".repeat(600_000), 2, task.controller);
			const row = await backgroundTaskService.getById(task.id);
			expect(row?.output).toBe("x".repeat(512 * 1024));
			const content = (await notices())[0].outputPreview;
			expect(content).toContain("captured output file unavailable");
			expect(content).toContain("Await");
			expect(content).toContain("[exit code: 2]");
			expect(Buffer.byteLength(content)).toBeLessThan(5120);
		} finally {
			mock.mockRestore();
		}
	});

	test("losing terminal CAS discards the already-written spill", async () => {
		const task = await create();
		const original = fs.writeFile;
		let spill = "";
		const mock = spyOn(fs, "writeFile").mockImplementation(async (path, data, options) => {
			spill = String(path);
			paths.add(spill);
			await original(path, data, options);
			// Competing finalizer wins after preparation but before the terminal CAS.
			db.update(backgroundTasks)
				.set({ status: "cancelled" })
				.where(eq(backgroundTasks.id, task.id))
				.run();
		});
		try {
			expect(
				await backgroundTaskService.markCompleted(task.id, "x".repeat(5120), 0, task.controller),
			).toBe(false);
			expect(spill).not.toBe("");
			expect(await Bun.file(spill).exists()).toBe(false);
			expect(await notices()).toHaveLength(0);
		} finally {
			mock.mockRestore();
		}
	});
});
