/**
 * An automatic run claims the task in the write that re-arms it.
 *
 * `listDue` reads on a Worker, so a disable or reschedule can commit between that read and
 * dispatch. The due list is only a set of candidates: `runTask` must launch only while the
 * current row is still enabled and due. Manual runs are exempt.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanDb } from "../../../tests/setup";
import { scheduledTasks } from "../../db/schema";
import { closeRuntimeTestDb, getRuntimeTestDb } from "./agent-runtime-test-database";

const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { scheduledTaskService } = await import("../scheduled-task-service");

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

function seedTask(id: string, fields: { enabled?: boolean; nextRunAt?: string | null } = {}) {
	db.insert(scheduledTasks)
		.values({
			id,
			name: id,
			enabled: fields.enabled ?? true,
			cronExpr: "0 3 * * *",
			prompt: "run",
			nextRunAt: fields.nextRunAt === undefined ? PAST : fields.nextRunAt,
			createdAt: PAST,
			updatedAt: PAST,
		})
		.run();
}

function row(id: string) {
	return sqlite
		.query(
			"SELECT next_run_at AS nextRunAt, last_status AS lastStatus FROM scheduled_tasks WHERE id = ?",
		)
		.get(id) as { nextRunAt: string | null; lastStatus: string | null };
}

let launched: string[];

beforeEach(() => {
	cleanDb(sqlite);
	launched = [];
	spyOn(scheduledTaskService, "launchNarrator").mockImplementation(async (task) => {
		launched.push(task.id);
		return { status: "success", narratorId: null };
	});
});
afterEach(() => mock.restore());
afterAll(async () => {
	await closeRuntimeTestDb(sqlite);
	mock.module("../../db", () => realDbModule);
});

describe("automatic scheduled-task dispatch", () => {
	test("a due task launches once and is re-armed to a future run", async () => {
		seedTask("due");
		const due = await scheduledTaskService.listDue();
		await Promise.all(due.map((task) => scheduledTaskService.runTask(task.id)));
		expect(launched).toEqual(["due"]);
		const after = row("due");
		expect(after.lastStatus).toBe("success");
		expect(after.nextRunAt !== null && after.nextRunAt > new Date().toISOString()).toBe(true);
	});

	test("a task disabled after the due read is not launched", async () => {
		seedTask("disabled");
		const due = await scheduledTaskService.listDue();
		expect(due.map((task) => task.id)).toEqual(["disabled"]);
		await scheduledTaskService.setEnabled("disabled", false);
		await scheduledTaskService.runTask("disabled");
		expect(launched).toEqual([]);
		expect(row("disabled")).toEqual({ nextRunAt: null, lastStatus: null });
	});

	test("a task rescheduled into the future after the due read is not launched", async () => {
		seedTask("moved");
		const due = await scheduledTaskService.listDue();
		expect(due.map((task) => task.id)).toEqual(["moved"]);
		sqlite.run("UPDATE scheduled_tasks SET next_run_at = ? WHERE id = 'moved'", [FUTURE]);
		await scheduledTaskService.runTask("moved");
		expect(launched).toEqual([]);
		expect(row("moved")).toEqual({ nextRunAt: FUTURE, lastStatus: null });
	});

	test("a prompt-only edit read before the claim does not restore the old due time", async () => {
		seedTask("edited");
		const stale = await scheduledTaskService.get("edited");
		await scheduledTaskService.runTask("edited");
		const rearmed = row("edited").nextRunAt;
		expect(rearmed !== null && rearmed > new Date().toISOString()).toBe(true);
		// The edit's Worker read returned before the claim committed.
		spyOn(scheduledTaskService, "get").mockResolvedValueOnce(stale);
		await scheduledTaskService.update("edited", { prompt: "new prompt" });
		expect(row("edited").nextRunAt).toBe(rearmed);
		expect(await scheduledTaskService.listDue()).toEqual([]);
		expect(launched).toEqual(["edited"]);
	});

	test("a manual run still launches a disabled task and leaves its schedule alone", async () => {
		seedTask("manual", { enabled: false, nextRunAt: null });
		await scheduledTaskService.runTask("manual", { manual: true });
		expect(launched).toEqual(["manual"]);
		expect(row("manual")).toEqual({ nextRunAt: null, lastStatus: "success" });
	});
});
