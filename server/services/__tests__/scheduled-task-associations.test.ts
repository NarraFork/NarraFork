import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { aclGrants, narrators, scheduledTaskRuns, scheduledTasks, users } from "../../db/schema";
import { eventBus } from "../../lib/event-bus";
import { generateId } from "../../lib/id";
import {
	createScheduledTaskSchema,
	updateScheduledTaskSchema,
} from "../../lib/validators/scheduled-tasks";
import {
	invalidateScheduledTaskAssociations,
	listNarratorScheduledTasks,
} from "../scheduled-task-associations";
import { listScheduledTaskTargets } from "../scheduled-task-targets";

const taskIds: string[] = [];
const narratorIds: string[] = [];
const userIds: string[] = [];
let owner: { userId: string; isAdmin: boolean };
let stranger: { userId: string; isAdmin: boolean };
const now = "2026-11-20T00:00:00.000Z";

async function person() {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `target-${id}`, passwordHash: "test", role: "user", createdAt: now });
	userIds.push(id);
	return { userId: id, isAdmin: false };
}
async function narrator(overrides: Partial<typeof narrators.$inferInsert> = {}) {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		ownerUserId: owner.userId,
		visibility: "private",
		writeAudience: "owner",
		type: "primary",
		variant: "primary",
		title: "Session target",
		cwd: process.cwd(),
		createdAt: now,
		updatedAt: now,
		...overrides,
	});
	narratorIds.push(id);
	return id;
}
async function task(
	targetNarratorId: string,
	overrides: Partial<typeof scheduledTasks.$inferInsert> = {},
) {
	const id = generateId();
	await db.insert(scheduledTasks).values({
		id,
		name: `Task ${id}`,
		prompt: "PRIVATE_PROMPT",
		systemPrompt: "PRIVATE_SYSTEM",
		cronExpr: "",
		schedule: {
			kind: "repeat",
			rule: { unit: "day", interval: 1, times: ["09:00"] },
			end: { type: "count", count: 12 },
		},
		timezone: "UTC",
		narratorMode: "existing",
		targetNarratorId,
		ownerUserId: owner.userId,
		createdBy: owner.userId,
		createdAt: now,
		updatedAt: now,
		firedCount: 7,
		...overrides,
	});
	taskIds.push(id);
	eventBus.emit({ type: "scheduled_task:changed" });
	return id;
}
async function run(
	taskId: string,
	narratorId: string,
	status: (typeof scheduledTaskRuns.$inferInsert)["status"],
) {
	const id = generateId();
	await db
		.insert(scheduledTaskRuns)
		.values({ id, taskId, narratorId, status, runContext: "standalone", createdAt: now });
	eventBus.emit({ type: "scheduled_task:changed" });
	return id;
}
beforeEach(async () => {
	owner = await person();
	stranger = await person();
	invalidateScheduledTaskAssociations();
});
afterEach(async () => {
	if (taskIds.length)
		await db.delete(scheduledTasks).where(inArray(scheduledTasks.id, taskIds.splice(0)));
	if (narratorIds.length) {
		await db.delete(aclGrants).where(inArray(aclGrants.scopeId, narratorIds));
		await db.delete(narrators).where(inArray(narrators.id, narratorIds.splice(0)));
	}
	if (userIds.length) await db.delete(users).where(inArray(users.id, userIds.splice(0)));
	invalidateScheduledTaskAssociations();
});

describe("scheduled target associations", () => {
	test("multiple tasks carry independent finite progress and paused tasks remain visible", async () => {
		const id = await narrator();
		await task(id);
		await task(id, { enabled: false, firedCount: 3 });
		const page = await listNarratorScheduledTasks(id, owner);
		expect(page.tasks).toHaveLength(2);
		expect(page.tasks.map((t) => t.firedCount).sort()).toEqual([3, 7]);
		expect(page.tasks.every((t) => t.total === 12)).toBe(true);
		expect(page.tasks.some((t) => t.lifecycle === "paused")).toBe(true);
		expect(JSON.stringify(page)).not.toContain("PRIVATE_");
	});

	test("moving A to B drops old borrowing once its precise run ends, even with cached IDs", async () => {
		const a = await narrator();
		const b = await narrator();
		const first = await task(a);
		const second = await task(a);
		const oldRun = await run(first, a, "running");
		expect((await listNarratorScheduledTasks(a, owner)).tasks).toHaveLength(2);
		await db
			.update(scheduledTasks)
			.set({ targetNarratorId: b })
			.where(eq(scheduledTasks.id, first));
		expect((await listNarratorScheduledTasks(a, owner)).tasks).toHaveLength(2);
		await db
			.update(scheduledTaskRuns)
			.set({ status: "completed" })
			.where(eq(scheduledTaskRuns.id, oldRun));
		expect((await listNarratorScheduledTasks(a, owner)).tasks.map((t) => t.id)).toEqual([second]);
		expect((await listNarratorScheduledTasks(b, owner)).tasks.map((t) => t.id)).toEqual([first]);
		await db
			.update(scheduledTasks)
			.set({ narratorMode: "new", targetNarratorId: null })
			.where(eq(scheduledTasks.id, first));
		expect((await listNarratorScheduledTasks(b, owner)).tasks).toHaveLength(0);
	});

	test("creation provenance survives mode changes, but ended tasks disappear after last live run", async () => {
		const target = await narrator();
		const taskId = await task(target, {
			narratorMode: "new",
			targetNarratorId: null,
			firedCount: 12,
			completedAt: now,
		});
		const created = await narrator({ scheduledTaskId: taskId });
		const waiting = await run(taskId, created, "waiting");
		const page = await listNarratorScheduledTasks(created, owner);
		expect(page.tasks[0]).toMatchObject({
			id: taskId,
			firedCount: 12,
			total: 12,
			hasUnfinishedRun: true,
		});
		await db
			.update(scheduledTaskRuns)
			.set({ status: "completed" })
			.where(eq(scheduledTaskRuns.id, waiting));
		expect((await listNarratorScheduledTasks(created, owner)).tasks).toHaveLength(0);
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, created) }))?.scheduledTaskId,
		).toBe(taskId);
	});

	test("task ACL is independent of narrator visibility and cache never preserves revoked access", async () => {
		const id = await narrator({ visibility: "public" });
		const taskId = await task(id);
		expect((await listNarratorScheduledTasks(id, stranger)).tasks).toHaveLength(0);
		expect((await listNarratorScheduledTasks(id, owner)).tasks).toHaveLength(1);
		await db
			.update(scheduledTasks)
			.set({ ownerUserId: stranger.userId })
			.where(eq(scheduledTasks.id, taskId));
		expect((await listNarratorScheduledTasks(id, owner)).tasks).toHaveLength(0);
		await db.update(narrators).set({ visibility: "private" }).where(eq(narrators.id, id));
		await expect(listNarratorScheduledTasks(id, stranger)).rejects.toMatchObject({
			statusCode: 404,
		});
	});

	test("pagination is stable and survives cache invalidation", async () => {
		const id = await narrator();
		for (let i = 0; i < 3; i++) await task(id);
		const one = await listNarratorScheduledTasks(id, owner, { limit: 2 });
		expect(one.tasks).toHaveLength(2);
		expect(one.nextCursor).not.toBeNull();
		invalidateScheduledTaskAssociations();
		const two = await listNarratorScheduledTasks(id, owner, {
			limit: 2,
			cursor: one.nextCursor as string,
		});
		expect(two.tasks).toHaveLength(1);
		expect(two.nextCursor).toBeNull();
		expect(new Set([...one.tasks, ...two.tasks].map((t) => t.id)).size).toBe(3);
	});
});

describe("target discovery and HTTP validation", () => {
	test("search exposes writable summaries, escapes wildcards and ignores forged admin flags", async () => {
		const marker = `target_${generateId()}%`;
		const id = await narrator({ title: marker });
		await narrator({ title: marker.replaceAll("_", "X").replaceAll("%", "many") });
		expect((await listScheduledTaskTargets(owner, { q: marker })).items.map((n) => n.id)).toEqual([
			id,
		]);
		expect(
			(await listScheduledTaskTargets({ ...stranger, isAdmin: true }, { q: marker })).items,
		).toHaveLength(0);
		await db
			.update(narrators)
			.set({ visibility: "public", writeAudience: "public" })
			.where(eq(narrators.id, id));
		const page = await listScheduledTaskTargets(stranger, { q: marker });
		expect(page.items.map((n) => n.id)).toEqual([id]);
		expect(Object.keys(page.items[0]).sort()).toEqual([
			"cwd",
			"id",
			"model",
			"projectId",
			"status",
			"title",
		]);
		await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, id));
		expect((await listScheduledTaskTargets(owner, { q: marker })).items).toHaveLength(0);
	});

	test("existing targets need no project directory, but must explicitly name a target", () => {
		const input = {
			name: "target",
			prompt: "work",
			cronExpr: "0 9 * * *",
			narratorMode: "existing",
			runContext: "project",
		};
		expect(
			createScheduledTaskSchema.safeParse({
				...input,
				targetNarratorId: "n1",
				contextPolicy: "clear",
				onBusy: "wait",
				busyWaitMinutes: 15,
				requireReport: false,
			}).success,
		).toBe(true);
		expect(createScheduledTaskSchema.safeParse(input).success).toBe(false);
		expect(
			createScheduledTaskSchema.safeParse({ ...input, targetNarratorId: "n1", busyWaitMinutes: 0 })
				.success,
		).toBe(false);
		expect(updateScheduledTaskSchema.parse({ requireReport: false })).toEqual({
			requireReport: false,
		});
	});
});
