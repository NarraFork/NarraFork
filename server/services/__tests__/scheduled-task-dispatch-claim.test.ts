/** Due reads are candidates. Only the atomic admission write may consume an occurrence. */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { narrators, scheduledTaskRuns, scheduledTasks, users } from "../../db/schema";

const realSession = { ...(await import("../narrator-session")) };
let launched: string[] = [];
let duringDispatch: (() => Promise<void>) | undefined;
mock.module("../narrator-session", () => ({
	...realSession,
	isLoopRunning: () => false,
	sendScheduledTaskMessage: async (input: { narratorId: string; runId: string }) => {
		launched.push(input.narratorId);
		await duringDispatch?.();
		await (await import("../scheduled-task-run-service")).finalizeScheduledRun(
			input.runId,
			"completed",
		);
	},
}));
const { scheduledTaskService } = await import("../scheduled-task-service");

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";
const OWNER = { userId: "dispatch-owner", isAdmin: false };

function seedTask(id: string, fields: { enabled?: boolean; nextRunAt?: string | null } = {}) {
	const due = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
	db.insert(narrators)
		.values({
			id,
			ownerUserId: OWNER.userId,
			cwd: tmpdir(),
			createdAt: PAST,
			updatedAt: PAST,
		})
		.run();
	db.insert(scheduledTasks)
		.values({
			id,
			name: id,
			enabled: fields.enabled ?? true,
			cronExpr: "* * * * *",
			timezone: "UTC",
			schedule: { kind: "cron", expr: "* * * * *", end: { type: "never" } },
			scheduleKind: "cron",
			scheduleCursorAt: new Date(Date.parse(due) - 1).toISOString(),
			prompt: "run",
			narratorMode: "existing",
			targetNarratorId: id,
			ownerUserId: OWNER.userId,
			createdBy: OWNER.userId,
			nextRunAt: fields.nextRunAt === undefined ? due : fields.nextRunAt,
			createdAt: PAST,
			updatedAt: PAST,
		})
		.run();
}

function row(id: string) {
	return sqlite
		.query(
			"SELECT next_run_at AS nextRunAt, last_status AS lastStatus, fired_count AS firedCount FROM scheduled_tasks WHERE id = ?",
		)
		.get(id) as { nextRunAt: string | null; lastStatus: string | null; firedCount: number };
}

beforeEach(() => {
	cleanDb(sqlite);
	launched = [];
	duringDispatch = undefined;
	db.insert(users)
		.values({ id: OWNER.userId, username: OWNER.userId, passwordHash: "test", createdAt: PAST })
		.run();
});
afterEach(() => mock.restore());
afterAll(() => mock.module("../narrator-session", () => realSession));

describe("automatic scheduled-task dispatch", () => {
	test("a due task launches once and is re-armed to a future run", async () => {
		seedTask("due");
		const due = await scheduledTaskService.listDue();
		await Promise.all(due.map((task) => scheduledTaskService.runTask(task.id)));
		await scheduledTaskService.runTask("due");
		expect(launched).toEqual(["due"]);
		const after = row("due");
		expect(after.lastStatus).toBe("completed");
		expect(after.firedCount).toBe(1);
		expect(after.nextRunAt !== null && after.nextRunAt > new Date().toISOString()).toBe(true);
	});

	test("a task disabled after the due read is not launched", async () => {
		seedTask("disabled");
		const due = await scheduledTaskService.listDue();
		expect(due.map((task) => task.id)).toEqual(["disabled"]);
		await scheduledTaskService.setEnabled("disabled", false, OWNER);
		await scheduledTaskService.runTask("disabled");
		expect(launched).toEqual([]);
		expect(row("disabled")).toEqual({ nextRunAt: null, lastStatus: null, firedCount: 0 });
	});

	test("a task rescheduled into the future after the due read is not launched", async () => {
		seedTask("moved");
		const due = await scheduledTaskService.listDue();
		expect(due.map((task) => task.id)).toEqual(["moved"]);
		sqlite.run("UPDATE scheduled_tasks SET next_run_at = ? WHERE id = 'moved'", [FUTURE]);
		await scheduledTaskService.runTask("moved");
		expect(launched).toEqual([]);
		expect(row("moved")).toEqual({ nextRunAt: FUTURE, lastStatus: null, firedCount: 0 });
	});

	for (const change of ["disable", "reschedule"] as const) {
		test(`a stale task read cannot claim after ${change} commits`, async () => {
			seedTask("stale");
			const stale = await scheduledTaskService.get("stale");
			if (change === "disable")
				sqlite.run("UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL WHERE id = 'stale'");
			else sqlite.run("UPDATE scheduled_tasks SET next_run_at = ? WHERE id = 'stale'", [FUTURE]);
			spyOn(scheduledTaskService, "get").mockResolvedValueOnce(stale);
			await scheduledTaskService.runTask("stale");
			expect(launched).toEqual([]);
			expect(row("stale")).toEqual({
				nextRunAt: change === "disable" ? null : FUTURE,
				lastStatus: null,
				firedCount: 0,
			});
			expect(
				await db.select({ id: scheduledTaskRuns.id }).from(scheduledTaskRuns).limit(1),
			).toEqual([]);
		});
	}

	test("a prompt-only edit read before the claim does not restore the old due time", async () => {
		seedTask("edited");
		const stale = await scheduledTaskService.get("edited");
		await scheduledTaskService.runTask("edited");
		const rearmed = row("edited").nextRunAt;
		expect(rearmed !== null && rearmed > new Date().toISOString()).toBe(true);
		spyOn(scheduledTaskService, "get").mockResolvedValueOnce(stale);
		await scheduledTaskService.update("edited", { prompt: "new prompt" }, OWNER);
		expect(row("edited").nextRunAt).toBe(rearmed);
		expect(row("edited").firedCount).toBe(1);
		expect((await scheduledTaskService.get("edited"))?.prompt).toBe("new prompt");
		expect(await scheduledTaskService.listDue()).toEqual([]);
		expect(launched).toEqual(["edited"]);
	});

	test("a schedule change during dispatch is preserved by completion", async () => {
		seedTask("during");
		duringDispatch = async () => {
			await db
				.update(scheduledTasks)
				.set({ nextRunAt: FUTURE })
				.where(eq(scheduledTasks.id, "during"));
		};
		await scheduledTaskService.runTask("during");
		expect(row("during").nextRunAt).toBe(FUTURE);
		expect(launched).toEqual(["during"]);
	});

	test("a manual run still launches a disabled task and leaves its schedule alone", async () => {
		seedTask("manual", { enabled: false, nextRunAt: null });
		await scheduledTaskService.runTask("manual", { manual: true, principal: OWNER });
		expect(launched).toEqual(["manual"]);
		expect(row("manual")).toEqual({ nextRunAt: null, lastStatus: "completed", firedCount: 0 });
	});
});
