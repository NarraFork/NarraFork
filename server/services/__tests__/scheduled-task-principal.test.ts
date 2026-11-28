import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators, projects, scheduledTasks, users } from "../../db/schema";
import { DbReadError } from "../../lib/db-worker/errors";
import { generateId } from "../../lib/id";
import { narratorService } from "../narrator-service";

// Exercise the persisted service/ACL path; never dispatch work to a model.
const realSession = { ...(await import("../narrator-session")) };
let sentTo: string | null = null;
mock.module("../narrator-session", () => ({
	...realSession,
	isLoopRunning: () => false,
	sendScheduledTaskMessage: async (input: { narratorId: string; runId: string }) => {
		sentTo = input.narratorId;
		await (await import("../scheduled-task-run-service")).finalizeScheduledRun(
			input.runId,
			"completed",
		);
	},
}));
const { scheduledTaskService } = await import("../scheduled-task-service");
const operator = { userId: generateId(), isAdmin: true };
const directories: string[] = [];
const projectIds: string[] = [];
const taskIds: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
	await db.insert(users).values({
		id: operator.userId,
		username: `scheduler-admin-${operator.userId}`,
		role: "admin",
		passwordHash: "test",
		createdAt: new Date().toISOString(),
	});
});
afterEach(async () => {
	for (const id of projectIds) await db.delete(narrators).where(eq(narrators.contextProjectId, id));
	for (const id of taskIds.splice(0))
		await db.delete(scheduledTasks).where(eq(scheduledTasks.id, id));
	for (const id of projectIds.splice(0)) await db.delete(projects).where(eq(projects.id, id));
	for (const id of userIds.splice(0)) await db.delete(users).where(eq(users.id, id));
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
afterAll(async () => {
	await db.delete(users).where(eq(users.id, operator.userId));
	mock.module("../narrator-session", () => realSession);
});

async function makeUser(role: "admin" | "user") {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `scheduler-${id}`,
		role,
		passwordHash: "test",
		createdAt: new Date().toISOString(),
	});
	userIds.push(id);
	return id;
}
async function environment(ownerUserId: string | null = null) {
	const cwd = mkdtempSync(join(tmpdir(), "nf-scheduled-principal-"));
	directories.push(cwd);
	const projectId = generateId();
	const narratorId = generateId();
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id: projectId,
		name: "Private legacy project",
		gitPath: cwd,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	projectIds.push(projectId);
	await db.insert(narrators).values({
		id: narratorId,
		title: "Existing task session",
		cwd,
		contextProjectId: projectId,
		type: "primary",
		variant: "primary",
		traits: ["standalone", "scheduled"],
		ownerUserId,
		visibility: "public",
		writeAudience: "owner",
		createdAt: now,
		updatedAt: now,
	});
	return { projectId, narratorId };
}
async function legacyTask(env: Awaited<ReturnType<typeof environment>>, createdBy: string | null) {
	const id = generateId();
	const now = new Date().toISOString();
	// Legacy row: no normalized schedule or owner column. The live creator is the fallback.
	await db.insert(scheduledTasks).values({
		id,
		name: "Nightly checks",
		cronExpr: "0 3 * * *",
		timezone: "UTC",
		prompt: "check",
		runContext: "project",
		projectId: env.projectId,
		narratorMode: "reuse",
		reuseNarratorId: env.narratorId,
		createdBy,
		createdAt: now,
		updatedAt: now,
	});
	taskIds.push(id);
	await db.update(narrators).set({ scheduledTaskId: id }).where(eq(narrators.id, env.narratorId));
	return id;
}
async function launch(id: string) {
	sentTo = null;
	await scheduledTaskService.runTask(id, { manual: true, principal: operator });
	return { target: sentTo as string | null, task: await scheduledTaskService.get(id) };
}

describe("scheduled execution resolves its owner's live principal", () => {
	test("an admin creator may reuse its ownerless legacy task session", async () => {
		const env = await environment();
		const id = await legacyTask(env, await makeUser("admin"));
		expect((await launch(id)).target).toBe(env.narratorId);
	});
	test("a failed reuse Worker read does not create or dispatch a replacement", async () => {
		const env = await environment();
		const id = await legacyTask(env, await makeUser("admin"));
		const read = spyOn(narratorService, "getById").mockRejectedValueOnce(
			new DbReadError("DB_READ_WORKER_EXIT", "reuse Worker unavailable"),
		);
		const create = spyOn(narratorService, "create");
		try {
			const result = await launch(id);
			expect(result.target).toBeNull();
			expect(result.task?.lastStatus).toBe("failed");
			expect(result.task?.lastError).toContain("reuse Worker unavailable");
			expect(read).toHaveBeenCalledWith(env.narratorId);
			expect(create).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
			create.mockRestore();
		}
	});
	test("a non-admin creator without project access is refused", async () => {
		const env = await environment(await makeUser("user"));
		const id = await legacyTask(env, await makeUser("user"));
		const result = await launch(id);
		expect(result.target).toBeNull();
		expect(result.task?.lastStatus).toBe("failed");
		const runs = await scheduledTaskService.listRuns(id, { principal: operator });
		expect(runs.runs[0]?.errorKind).toBe("acl");
	});
	test("refusal creates no narrator in the project", async () => {
		const env = await environment(await makeUser("user"));
		await launch(await legacyTask(env, await makeUser("user")));
		const rows = await db.query.narrators.findMany({
			where: eq(narrators.contextProjectId, env.projectId),
			columns: { id: true },
			limit: 10,
		});
		expect(rows.map((row) => row.id)).toEqual([env.narratorId]);
	});
	test("a missing owner fails closed even for an administrator's manual trigger", async () => {
		const env = await environment();
		const result = await launch(await legacyTask(env, null));
		expect(result.target).toBeNull();
		expect(result.task?.lastStatus).toBe("failed");
	});
	test("a demotion applies to the next run", async () => {
		const env = await environment();
		const owner = await makeUser("admin");
		const id = await legacyTask(env, owner);
		expect((await launch(id)).target).toBe(env.narratorId);
		await db.update(users).set({ role: "user" }).where(eq(users.id, owner));
		expect((await launch(id)).target).toBeNull();
	});
	test("a transferred owner is authoritative, never the original creator", async () => {
		const env = await environment();
		const id = await legacyTask(env, await makeUser("admin"));
		await db
			.update(scheduledTasks)
			.set({ ownerUserId: await makeUser("user") })
			.where(eq(scheduledTasks.id, id));
		expect((await launch(id)).target).toBeNull();
	});
});
