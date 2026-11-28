import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { db } from "../../db";
import { narrators, projects, scheduledTaskRuns, scheduledTasks, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import type { ScheduledTaskPrincipal } from "../scheduled-task-acl";
import { captureWorkerRejection } from "./narrator-worker-fixture";

// No real provider calls; an accidental dispatch in a missed-only test is observable.
const realSession = { ...(await import("../narrator-session")) };
let dispatches = 0;
mock.module("../narrator-session", () => ({
	...realSession,
	isLoopRunning: () => false,
	sendScheduledTaskMessage: async () => {
		dispatches++;
		throw new Error("test dispatch failure");
	},
}));
const { scheduledTaskService } = await import("../scheduled-task-service");
const { scheduledTaskRoutes } = await import("../../routes/scheduled-tasks");
let owner: ScheduledTaskPrincipal;
let stranger: ScheduledTaskPrincipal;
let admin: ScheduledTaskPrincipal;
const taskIds: string[] = [];
const projectIds: string[] = [];
const userIds: string[] = [];
function taskSettings() {
	const config = settings.scheduledTasks;
	if (!config) throw new Error("missing scheduled task settings defaults");
	return config;
}
const originalQuota = taskSettings().maxActivePerOwner;

async function person(role: "user" | "admin" = "user") {
	const userId = generateId();
	await db.insert(users).values({
		id: userId,
		username: `scheduled-service-${userId}`,
		passwordHash: "test",
		role,
		createdAt: new Date().toISOString(),
	});
	userIds.push(userId);
	return { userId, isAdmin: role === "admin" };
}
beforeEach(async () => {
	owner = await person();
	stranger = await person();
	admin = await person("admin");
	dispatches = 0;
});
afterEach(async () => {
	taskSettings().maxActivePerOwner = originalQuota;
	for (const id of taskIds.splice(0)) {
		const task = await scheduledTaskService.get(id);
		if (!task) continue;
		if (task.activeRunId)
			await (await import("../scheduled-task-run-service")).finalizeScheduledRun(
				task.activeRunId,
				"interrupted",
			);
		const sessions = await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(eq(narrators.scheduledTaskId, id))
			.limit(10);
		await scheduledTaskService.delete(id, admin);
		for (const session of sessions)
			await (await import("../narrator-service")).narratorService.remove(session.id);
	}
	for (const id of projectIds.splice(0)) await db.delete(projects).where(eq(projects.id, id));
	for (const id of userIds.splice(0)) await db.delete(users).where(eq(users.id, id));
});

async function task(overrides: Partial<typeof scheduledTasks.$inferInsert> = {}) {
	const row = await scheduledTaskService.create(
		{
			name: "Daily review",
			cronExpr: "0 9 * * *",
			timezone: "UTC",
			prompt: "OWNER_ONLY_INSTRUCTION",
			systemPrompt: "OWNER_ONLY_SYSTEM",
			cwd: tmpdir(),
		},
		owner,
	);
	taskIds.push(row.id);
	if (Object.keys(overrides).length)
		await db.update(scheduledTasks).set(overrides).where(eq(scheduledTasks.id, row.id));
	const current = await scheduledTaskService.get(row.id);
	if (!current) throw new Error("missing fixture task");
	return current;
}
async function history(id: string) {
	return (await scheduledTaskService.listRuns(id, { principal: owner })).runs;
}
function appAs(principal: ScheduledTaskPrincipal) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", {
			sub: principal.userId,
			role: principal.isAdmin ? "admin" : "user",
			iat: 0,
			exp: 0,
		});
		await next();
	});
	app.onError((error, c) =>
		c.json(
			{ error: error.message },
			(error instanceof AppError ? error.statusCode : 500) as ContentfulStatusCode,
		),
	);
	app.route("/tasks", scheduledTaskRoutes);
	return app;
}

describe("task ACL and safe projections", () => {
	test("missing principals and forged admin flags do not grant access", async () => {
		const row = await task();
		expect(await captureWorkerRejection(scheduledTaskService.list())).toMatchObject({
			statusCode: 403,
		});
		expect(
			await captureWorkerRejection(
				scheduledTaskService.detail(row.id, { ...stranger, isAdmin: true }),
			),
		).toMatchObject({ statusCode: 404 });
		expect((await scheduledTaskService.list(stranger)).tasks).toHaveLength(0);
	});
	test("all mutation and history endpoints hide private task existence", async () => {
		const row = await task();
		const app = appAs(stranger);
		for (const [method, suffix, body] of [
			["GET", "", undefined],
			["GET", "/runs", undefined],
			["POST", "/run", undefined],
			["POST", "/cleanup", undefined],
			["POST", "/toggle", { enabled: false }],
			["PUT", "", { prompt: "changed" }],
			["DELETE", "", undefined],
		] as const) {
			const response = await app.request(`/tasks/${row.id}${suffix}`, {
				method,
				...(body
					? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
					: {}),
			});
			expect(response.status).toBe(404);
		}
	});
	test("a readable project exposes metadata, never prompt or run output", async () => {
		const projectId = generateId();
		const now = new Date().toISOString();
		await db.insert(projects).values({
			id: projectId,
			name: "Public metadata",
			gitPath: process.cwd(),
			ownerUserId: owner.userId,
			visibility: "public",
			createdAt: now,
			updatedAt: now,
		});
		projectIds.push(projectId);
		const row = await task({
			runContext: "project",
			projectId,
			lastError: "SECRET_ERROR",
			lastSummary: "SECRET_SUMMARY",
		});
		const privateTarget = generateId();
		await db.insert(narrators).values({
			id: privateTarget,
			ownerUserId: owner.userId,
			visibility: "private",
			type: "primary",
			variant: "primary",
			scheduledTaskId: row.id,
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(scheduledTaskRuns).values({
			id: generateId(),
			taskId: row.id,
			narratorId: privateTarget,
			triggerMessageId: "PRIVATE_TRIGGER",
			status: "failed",
			runContext: "project",
			error: "SECRET_ERROR",
			outcomeSummary: "SECRET_SUMMARY",
			createdAt: now,
		});
		const detail = await scheduledTaskService.detail(row.id, stranger);
		expect(detail.capabilities.canEdit).toBe(false);
		expect(detail.capabilities.canSeePrompt).toBe(false);
		const all = JSON.stringify([
			detail,
			await scheduledTaskService.list(stranger),
			await scheduledTaskService.listRuns(row.id, { principal: stranger }),
		]);
		expect(all).not.toContain("OWNER_ONLY");
		expect(all).not.toContain("SECRET_");
		expect(all).not.toContain(privateTarget);
		expect(all).not.toContain("PRIVATE_TRIGGER");
		expect(
			(await scheduledTaskService.list(stranger, { q: "OWNER_ONLY_INSTRUCTION" })).tasks,
		).toHaveLength(0);
	});
	test("owner lists also omit full prompt bodies and literal search escapes wildcards", async () => {
		await task({ name: "literal %_ token" });
		await task({ name: "another task" });
		const list = await scheduledTaskService.list(owner);
		for (const row of list.tasks) {
			expect(row).not.toHaveProperty("prompt");
			expect(row).not.toHaveProperty("systemPrompt");
		}
		expect((await scheduledTaskService.list(owner, { q: "%_" })).tasks).toHaveLength(1);
		expect(
			(await scheduledTaskService.list(owner, { q: "OWNER_ONLY_INSTRUCTION" })).tasks,
		).toHaveLength(2);
	});
});

describe("approval version and task lifecycle", () => {
	test("stale approval blocks edit, toggle, delete and immediate run", async () => {
		const row = await task();
		const expectedUpdatedAt = row.updatedAt;
		const changed = await scheduledTaskService.update(
			row.id,
			{ name: "Changed since approval" },
			owner,
		);
		expect(changed.updatedAt > expectedUpdatedAt).toBe(true);
		expect(
			await captureWorkerRejection(
				scheduledTaskService.update(row.id, { prompt: "stale" }, owner, undefined, {
					expectedUpdatedAt,
				}),
			),
		).toMatchObject({ statusCode: 409 });
		expect(
			await captureWorkerRejection(
				scheduledTaskService.setEnabled(row.id, false, owner, { expectedUpdatedAt }),
			),
		).toMatchObject({ statusCode: 409 });
		expect(
			await captureWorkerRejection(
				scheduledTaskService.delete(row.id, owner, { expectedUpdatedAt }),
			),
		).toMatchObject({ statusCode: 409 });
		expect(
			await captureWorkerRejection(
				scheduledTaskService.runTask(row.id, { manual: true, principal: owner, expectedUpdatedAt }),
			),
		).toMatchObject({ statusCode: 409 });
		expect(dispatches).toBe(0);
	});
	test("only one concurrent mutation can use the same approved snapshot", async () => {
		const row = await task();
		const results = await Promise.allSettled(
			["first", "second"].map((name) =>
				scheduledTaskService.update(row.id, { name }, owner, undefined, {
					expectedUpdatedAt: row.updatedAt,
				}),
			),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
	});
	test("a paused repeat is not ended and consumes no missed occurrences", async () => {
		const row = await task({
			enabled: false,
			scheduleCursorAt: "2020-01-01T00:00:00.000Z",
			nextRunAt: null,
		});
		await scheduledTaskService.recoverOnStartup();
		const paused = await scheduledTaskService.get(row.id);
		expect(paused?.completedAt).toBeNull();
		expect(paused?.firedCount).toBe(0);
		const resumed = await scheduledTaskService.setEnabled(row.id, true, owner);
		expect(resumed.firedCount).toBe(0);
		expect(Date.parse(resumed.nextRunAt ?? "") > Date.now()).toBe(true);
		expect(await history(row.id)).toHaveLength(0);
	});
	test("a paused calendar end expires without consuming repeat count", async () => {
		const row = await task({
			enabled: false,
			schedule: {
				kind: "cron",
				expr: "0 9 * * *",
				end: { type: "until", until: "2020-01-03T09:00" },
			},
			scheduleKind: "cron",
			scheduleCursorAt: "2020-01-01T00:00:00.000Z",
			nextRunAt: null,
		});
		await scheduledTaskService.reconcilePausedTasks();
		const result = await scheduledTaskService.get(row.id);
		expect(result?.completedAt).not.toBeNull();
		expect(result?.firedCount).toBe(0);
		expect(await history(row.id)).toHaveLength(0);
	});
	test("a name-only edit preserves consumed count and interval anchor", async () => {
		const schedule = {
			kind: "repeat" as const,
			rule: { unit: "minute" as const, interval: 7 },
			anchorAt: "2020-01-01T00:00:00.000Z",
			startAt: null,
			end: { type: "count" as const, count: 50 },
		};
		const row = await task({
			schedule,
			scheduleKind: "repeat",
			firedCount: 3,
			scheduleCursorAt: "2020-01-01T00:21:00.000Z",
			nextRunAt: "2020-01-01T00:28:00.000Z",
		});
		const updated = await scheduledTaskService.update(row.id, { name: "renamed" }, owner);
		expect(updated.firedCount).toBe(3);
		expect(updated.schedule).toEqual(schedule);
		expect(updated.nextRunAt).toBe(row.nextRunAt);
	});
	test("unfinished quota counts paused tasks too", async () => {
		taskSettings().maxActivePerOwner = 1;
		await task({ enabled: false });
		expect(
			await captureWorkerRejection(
				scheduledTaskService.create(
					{ name: "overflow", prompt: "x", cronExpr: "0 8 * * *" },
					owner,
				),
			),
		).toMatchObject({ statusCode: 400 });
	});
});

describe("missed occurrences are never replayed", () => {
	test("startup drains more than one bounded wall-clock slice, including the last minute", async () => {
		const end = new Date(Math.floor(Date.now() / 60_000) * 60_000);
		const first = new Date(end.getTime() - 129 * 60_000);
		const row = await task({
			schedule: { kind: "cron", expr: "* * * * *", end: { type: "count", count: 130 } },
			scheduleKind: "cron",
			nextRunAt: first.toISOString(),
			scheduleCursorAt: new Date(first.getTime() - 60_000).toISOString(),
		});
		await scheduledTaskService.recoverOnStartup();
		const result = await scheduledTaskService.get(row.id);
		expect(result?.firedCount).toBe(130);
		expect(result?.nextRunAt).toBeNull();
		expect(result?.completedAt).not.toBeNull();
		const runs = await history(row.id);
		expect(runs.reduce((sum, run) => sum + (run.missedCount ?? 0), 0)).toBe(130);
		expect(runs.every((run) => run.status === "missed")).toBe(true);
		expect(dispatches).toBe(0);
	});
	test("paused explicit dates record missed times and keep a future wake-up", async () => {
		const row = await task({
			enabled: false,
			schedule: { kind: "at", times: ["2020-01-01T00:00", "2040-01-01T00:00"] },
			scheduleKind: "at",
			scheduleCursorAt: "2019-01-01T00:00:00.000Z",
			nextRunAt: "2020-01-01T00:00:00.000Z",
		});
		expect((await scheduledTaskService.listDue()).some((due) => due.id === row.id)).toBe(true);
		await scheduledTaskService.runTask(row.id);
		const result = await scheduledTaskService.get(row.id);
		expect(result?.enabled).toBe(false);
		expect(result?.firedCount).toBe(1);
		expect(result?.nextRunAt).toBe("2040-01-01T00:00:00.000Z");
		expect((await history(row.id))[0]?.status).toBe("missed");
		expect(dispatches).toBe(0);
	});
	test("resuming a paused explicit schedule skips past dates immediately", async () => {
		const row = await task({
			enabled: false,
			schedule: { kind: "at", times: ["2020-01-01T00:00", "2040-01-01T00:00"] },
			scheduleKind: "at",
			scheduleCursorAt: "2019-01-01T00:00:00.000Z",
			nextRunAt: null,
		});
		const result = await scheduledTaskService.setEnabled(row.id, true, owner);
		expect(result.firedCount).toBe(1);
		expect(result.nextRunAt).toBe("2040-01-01T00:00:00.000Z");
		expect((await history(row.id))[0]?.status).toBe("missed");
	});
	test("an exhausted paused one-shot ends, rather than becoming runnable again", async () => {
		const row = await task({
			enabled: false,
			schedule: { kind: "at", times: ["2020-01-01T00:00"] },
			scheduleKind: "at",
			scheduleCursorAt: "2019-01-01T00:00:00.000Z",
			nextRunAt: null,
		});
		expect(
			await captureWorkerRejection(scheduledTaskService.setEnabled(row.id, true, owner)),
		).toMatchObject({
			statusCode: 400,
		});
		expect((await scheduledTaskService.get(row.id))?.completedAt).not.toBeNull();
		expect(dispatches).toBe(0);
	});
	test("manual runs do not consume schedule count or move the next occurrence", async () => {
		const row = await task();
		await scheduledTaskService.runTask(row.id, { manual: true, principal: owner });
		const result = await scheduledTaskService.get(row.id);
		expect(result?.firedCount).toBe(row.firedCount);
		expect(result?.nextRunAt).toBe(row.nextRunAt);
		expect((await history(row.id))[0]?.trigger).toBe("manual");
		expect(dispatches).toBe(1);
	});
	test("overlap consumes one planned occurrence without replacing the active run", async () => {
		const now = new Date().toISOString();
		const active = generateId();
		const row = await task({
			nextRunAt: now,
			activeRunId: active,
			scheduleCursorAt: new Date(Date.now() - 60_000).toISOString(),
		});
		await db.insert(scheduledTaskRuns).values({
			id: active,
			taskId: row.id,
			status: "running",
			runContext: "standalone",
			createdAt: now,
		});
		await scheduledTaskService.runTask(row.id, { at: new Date(now) });
		const result = await scheduledTaskService.get(row.id);
		expect(result?.firedCount).toBe(1);
		expect(result?.activeRunId).toBe(active);
		expect(
			(await history(row.id)).some((run) => run.status === "skipped" && run.errorKind === "busy"),
		).toBe(true);
		expect(dispatches).toBe(0);
		expect(await captureWorkerRejection(scheduledTaskService.delete(row.id, owner))).toMatchObject({
			statusCode: 409,
		});
	});
	test("run history keyset pagination has no duplicates when timestamps tie", async () => {
		const row = await task();
		const at = new Date().toISOString();
		for (let i = 0; i < 5; i++)
			await db.insert(scheduledTaskRuns).values({
				id: generateId(),
				taskId: row.id,
				status: "missed",
				runContext: "standalone",
				createdAt: at,
			});
		const first = await scheduledTaskService.listRuns(row.id, { principal: owner, limit: 2 });
		const second = await scheduledTaskService.listRuns(row.id, {
			principal: owner,
			limit: 3,
			cursor: first.nextCursor,
		});
		expect(new Set([...first.runs, ...second.runs].map((run) => run.id)).size).toBe(5);
		expect(second.nextCursor).toBeNull();
	});
});
