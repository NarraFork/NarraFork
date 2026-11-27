/**
 * 删除用户时，指向它的无级联外键必须先被释放。
 *
 * 背景：线上库里 `narrator_messages.created_by`、`projects.owner_user_id` 等五列仍是
 * NO ACTION，删除用户会直接 `FOREIGN KEY constraint failed`。本仓的构建只能派生
 * `CREATE TABLE IF NOT EXISTS` 基线、无法重建已有表，所以约束修不进线上库，清理只能
 * 发生在代码里——本测试固定的是清理后的最终状态。
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
	gatewaySessionMappings,
	narratorMessages,
	narrators,
	projects,
	scheduledTaskRuns,
	scheduledTasks,
	userPluginThemes,
	users,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import {
	previewUserScheduledTaskTransfer,
	releaseUserForeignKeys,
	transferScheduledTasksBeforeUserDeletion,
	USER_TASK_TRANSFER_MAX,
	USER_TASK_TRANSFER_PAGE_SIZE,
} from "../user-deletion";

const now = "2026-10-10T00:00:00.000Z";
const userId = generateId();
const narratorId = generateId();
const projectId = generateId();
const messageId = generateId();
const themeId = generateId();
const mappingId = generateId();

beforeAll(async () => {
	await db.insert(users).values({
		id: userId,
		username: `doomed-${userId}`,
		passwordHash: "x",
		createdAt: now,
	});
	await db.insert(narrators).values({
		id: narratorId,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "default",
		permissionMode: "default",
		status: "idle",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(projects).values({
		id: projectId,
		name: "被删用户的项目",
		ownerUserId: userId,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "user",
		contentJson: [{ type: "text", text: "hi" }],
		createdBy: userId,
		editedBy: userId,
		createdAt: now,
	});
	await db
		.insert(userPluginThemes)
		.values({ id: themeId, userId, pluginId: "p", themeId: "t", createdAt: now, updatedAt: now });
	await db.insert(gatewaySessionMappings).values({
		id: mappingId,
		platform: "test",
		chatId: "c",
		userId: "platform-user",
		narratorId,
		appUserId: userId,
		createdAt: now,
		updatedAt: now,
	});
});

describe("releaseUserForeignKeys", () => {
	test("删除用户成功，且引用被释放而不是连带删掉对象", () => {
		const deleted = db.transaction((tx) => {
			releaseUserForeignKeys(tx, userId);
			return tx.delete(users).where(eq(users.id, userId)).returning().all();
		});

		expect(deleted).toHaveLength(1);
		expect(db.select().from(users).where(eq(users.id, userId)).all()).toHaveLength(0);

		// 消息与项目保留，只丢失归属。
		expect(
			db.select().from(projects).where(eq(projects.id, projectId)).get()?.ownerUserId,
		).toBeNull();
		const message = db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.id, messageId))
			.get();
		expect(message?.createdBy).toBeNull();
		expect(message?.editedBy).toBeNull();

		// 个人主题偏好没有可空形态，只能删行。
		expect(
			db.select().from(userPluginThemes).where(eq(userPluginThemes.id, themeId)).all(),
		).toHaveLength(0);

		// IM 会话映射保留，停用应用用户绑定。
		const mapping = db
			.select()
			.from(gatewaySessionMappings)
			.where(eq(gatewaySessionMappings.id, mappingId))
			.get();
		expect(mapping?.appUserId).toBeNull();
		expect(mapping?.narratorId).toBe(narratorId);
	});
});

function makeUser(role: "user" | "admin" = "user") {
	const id = generateId();
	db.insert(users)
		.values({ id, username: `transfer-${id}`, passwordHash: "x", role, createdAt: now })
		.run();
	return id;
}

function makeTask(owner: string, patch: Partial<typeof scheduledTasks.$inferInsert> = {}) {
	const id = generateId();
	db.insert(scheduledTasks)
		.values({
			id,
			name: "Owned task",
			cronExpr: "0 * * * *",
			prompt: "private prompt",
			systemPrompt: "private system",
			ownerUserId: owner,
			createdBy: owner,
			schedule: { kind: "cron", expr: "0 * * * *", end: { type: "never" } },
			permissionMode: "readOnly",
			createdAt: now,
			updatedAt: now,
			...patch,
		})
		.run();
	return patch.id ?? id;
}

function makeNarrator(owner: string, taskId: string | null = null) {
	const id = generateId();
	db.insert(narrators)
		.values({
			id,
			ownerUserId: owner,
			scheduledTaskId: taskId,
			permissionMode: "readOnly",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	return id;
}

function taskRow(id: string) {
	return db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).get();
}

function makeRun(taskId: string, patch: Partial<typeof scheduledTaskRuns.$inferInsert> = {}) {
	const id = generateId();
	db.insert(scheduledTaskRuns)
		.values({
			id,
			taskId,
			status: "waiting",
			runContext: "standalone",
			busyDeadlineAt: "2099-01-01T00:00:00.000Z",
			createdAt: now,
			...patch,
		})
		.run();
	return id;
}

function runRow(id: string) {
	return db.select().from(scheduledTaskRuns).where(eq(scheduledTaskRuns.id, id)).get();
}

function narratorOwner(id: string) {
	return db
		.select({ owner: narrators.ownerUserId })
		.from(narrators)
		.where(eq(narrators.id, id))
		.get()?.owner;
}

function deleteWithTransfer(target: string, actor: string, confirmed = true) {
	return db.transaction((tx) => {
		const result = transferScheduledTasksBeforeUserDeletion(tx, target, actor, confirmed);
		releaseUserForeignKeys(tx, target);
		tx.delete(users).where(eq(users.id, target)).run();
		return result;
	});
}

describe("scheduled tasks survive atomic account deletion", () => {
	test("transfers current and legacy owners, preserves snapshots, ceilings and in-flight runs", () => {
		const actor = makeUser("admin"),
			target = makeUser(),
			other = makeUser();
		const future = "2099-01-01T00:00:00.000Z";
		const snapshot = { username: "Original name", narratorTitle: "Creator session" };
		const owned = makeTask(target, {
			creatorSnapshot: snapshot,
			narratorMode: "reuse",
			updatedAt: future,
			activeRunId: "active-run",
			enabled: false,
			pauseReason: "circuit_breaker",
			consecutiveFailures: 3,
		});
		const dedicated = makeNarrator(target, owned);
		db.update(scheduledTasks)
			.set({ reuseNarratorId: dedicated })
			.where(eq(scheduledTasks.id, owned))
			.run();
		const legacy = makeTask(target, { ownerUserId: null, schedule: null });
		const creatorOnly = makeTask(other, { createdBy: target });
		const modernOwnerless = makeTask(target, { ownerUserId: null });
		const otherTask = makeTask(other);
		const runId = generateId();
		db.insert(scheduledTaskRuns)
			.values({
				id: runId,
				taskId: owned,
				narratorId: dedicated,
				status: "running",
				runContext: "standalone",
				logicalRunId: "original-execution",
				triggerMessageId: "original-message",
				createdAt: now,
			})
			.run();
		const runBefore = db
			.select()
			.from(scheduledTaskRuns)
			.where(eq(scheduledTaskRuns.id, runId))
			.get();
		const before = taskRow(owned);
		const result = deleteWithTransfer(target, actor);
		expect(new Set(result.taskIds)).toEqual(new Set([owned, legacy]));
		expect(result.narratorIds).toEqual([dedicated]);
		expect(narratorOwner(dedicated)).toBe(actor);
		expect(taskRow(owned)).toMatchObject({
			...before,
			ownerUserId: actor,
			createdBy: null,
			creatorSnapshot: snapshot,
			updatedAt: "2099-01-01T00:00:00.001Z",
			lastModifiedBy: {
				kind: "user",
				userId: actor,
				action: "transfer_owner_on_user_deletion",
				at: "2099-01-01T00:00:00.001Z",
			},
		});
		expect(taskRow(legacy)).toMatchObject({
			ownerUserId: actor,
			createdBy: null,
			creatorSnapshot: { username: `transfer-${target}` },
		});
		expect(taskRow(creatorOnly)).toMatchObject({
			ownerUserId: other,
			createdBy: null,
			creatorSnapshot: { username: `transfer-${target}` },
		});
		expect(taskRow(modernOwnerless)).toMatchObject({ ownerUserId: null, createdBy: null });
		expect(taskRow(otherTask)?.ownerUserId).toBe(other);
		expect(
			db.select().from(scheduledTaskRuns).where(eq(scheduledTaskRuns.id, runId)).get(),
		).toEqual(runBefore);
		expect(db.select().from(users).where(eq(users.id, target)).get()).toBeUndefined();
	});

	test("takes only matching dedicated reuse sessions owned by the deleted user", () => {
		const actor = makeUser("admin"),
			target = makeUser(),
			other = makeUser();
		const arbitrary = makeNarrator(target);
		makeTask(target, { narratorMode: "reuse", reuseNarratorId: arbitrary });
		const newTask = makeTask(target);
		const oldSession = makeNarrator(target, newTask);
		db.update(scheduledTasks)
			.set({ reuseNarratorId: oldSession })
			.where(eq(scheduledTasks.id, newTask))
			.run();
		const mismatchTask = makeTask(target, { narratorMode: "reuse" });
		const mismatch = makeNarrator(target, newTask);
		db.update(scheduledTasks)
			.set({ reuseNarratorId: mismatch })
			.where(eq(scheduledTasks.id, mismatchTask))
			.run();
		const foreignTask = makeTask(target, { narratorMode: "reuse" });
		const foreign = makeNarrator(other, foreignTask);
		db.update(scheduledTasks)
			.set({ reuseNarratorId: foreign })
			.where(eq(scheduledTasks.id, foreignTask))
			.run();
		expect(deleteWithTransfer(target, actor).narratorIds).toEqual([]);
		for (const id of [arbitrary, oldSession, mismatch]) expect(narratorOwner(id)).toBeNull();
		expect(narratorOwner(foreign)).toBe(other);
	});

	test("existing targets remain references and never transfer ordinary sessions or children", () => {
		const actor = makeUser("admin"),
			target = makeUser(),
			other = makeUser();
		const ordinary = makeNarrator(target);
		const foreign = makeNarrator(other);
		const child = makeNarrator(target);
		db.update(narrators)
			.set({ parentNarratorId: ordinary, type: "subagent", variant: "subagent:general" })
			.where(eq(narrators.id, child))
			.run();
		const taskId = makeTask(target, {
			narratorMode: "existing",
			targetNarratorId: ordinary,
			reuseNarratorId: ordinary,
			contextPolicy: "clear",
			onBusy: "interrupt",
			requireReport: false,
		});
		const foreignTask = makeTask(target, {
			narratorMode: "existing",
			targetNarratorId: foreign,
		});
		const rowsBefore = [ordinary, foreign, child].map((id) =>
			db.select().from(narrators).where(eq(narrators.id, id)).get(),
		);
		expect(deleteWithTransfer(target, actor).narratorIds).toEqual([]);
		expect(taskRow(taskId)).toMatchObject({
			ownerUserId: actor,
			narratorMode: "existing",
			targetNarratorId: ordinary,
			permissionMode: "readOnly",
			contextPolicy: "clear",
			onBusy: "interrupt",
			requireReport: false,
		});
		expect(taskRow(foreignTask)?.targetNarratorId).toBe(foreign);
		for (const row of rowsBefore) {
			if (!row) throw new Error("Expected the target fixture to exist");
			expect(db.select().from(narrators).where(eq(narrators.id, row.id)).get()).toEqual({
				...row,
				ownerUserId: row.ownerUserId === target ? null : other,
			});
		}
	});

	test("cancels accepted waits atomically without recharging occurrences or touching active runs", () => {
		const actor = makeUser("admin"),
			target = makeUser(),
			other = makeUser();
		const ordinary = makeNarrator(target);
		const taskId = makeTask(target, {
			narratorMode: "existing",
			targetNarratorId: ordinary,
			firedCount: 4,
			consecutiveFailures: 3,
			nextRunAt: "2099-01-01T00:00:00.000Z",
		});
		const active = makeRun(taskId, {
			narratorId: ordinary,
			status: "running",
			logicalRunId: "old-owner-execution",
			startedAt: now,
		});
		const pending = makeRun(taskId, {
			narratorId: ordinary,
			interruptTarget: { narratorId: ordinary, scheduledRunId: active },
			requireReport: false,
		});
		db.update(scheduledTasks)
			.set({ activeRunId: active, lastRunId: pending, lastStatus: "waiting" })
			.where(eq(scheduledTasks.id, taskId))
			.run();
		const legacyTask = makeTask(target, { ownerUserId: null, schedule: null, firedCount: 2 });
		const manual = makeRun(legacyTask, { manual: true, trigger: "manual" });
		const newer = makeRun(legacyTask, { status: "skipped", errorKind: "busy" });
		db.update(scheduledTasks)
			.set({ lastRunId: newer, lastStatus: "skipped", lastError: "Newer busy trigger" })
			.where(eq(scheduledTasks.id, legacyTask))
			.run();
		const creatorOnly = makeTask(other, { createdBy: target });
		const unrelated = makeRun(creatorOnly);
		const untouched = [active, newer, unrelated].map(runRow);
		const pendingBefore = runRow(pending);

		db.transaction((tx) => {
			transferScheduledTasksBeforeUserDeletion(tx, target, actor, true);
			const settled = runRow(pending);
			expect(settled).toMatchObject({
				...pendingBefore,
				status: "skipped",
				errorKind: "cancelled",
				error: "Task ownership changed before dispatch",
				finishedAt: expect.any(String),
				durationMs: null,
			});
			expect(transferScheduledTasksBeforeUserDeletion(tx, target, actor, true).taskIds).toEqual([]);
			expect(runRow(pending)).toEqual(settled);
			releaseUserForeignKeys(tx, target);
			tx.delete(users).where(eq(users.id, target)).run();
		});
		expect(taskRow(taskId)).toMatchObject({
			ownerUserId: actor,
			activeRunId: active,
			lastRunId: pending,
			lastStatus: "skipped",
			lastError: "Task ownership changed before dispatch",
			firedCount: 4,
			consecutiveFailures: 3,
			nextRunAt: "2099-01-01T00:00:00.000Z",
		});
		expect(runRow(manual)).toMatchObject({ status: "skipped", errorKind: "cancelled" });
		expect(taskRow(legacyTask)).toMatchObject({
			lastRunId: newer,
			lastStatus: "skipped",
			lastError: "Newer busy trigger",
			firedCount: 2,
		});
		expect([active, newer, unrelated].map(runRow)).toEqual(untouched);
	});

	test("cancellation completes exhausted schedules while paused or active tasks remain unfinished", () => {
		const actor = makeUser("admin"),
			target = makeUser();
		const taskIds = ["ended", "paused", "active"].map((kind) => {
			const taskId = makeTask(target, {
				firedCount: 1,
				nextRunAt: null,
				enabled: kind !== "paused",
				schedule: {
					kind: "cron",
					expr: "0 * * * *",
					end: kind === "paused" ? { type: "never" } : { type: "count", count: 1 },
				},
			});
			const pending = makeRun(taskId);
			db.update(scheduledTasks)
				.set({ lastRunId: pending, lastStatus: "waiting" })
				.where(eq(scheduledTasks.id, taskId))
				.run();
			if (kind === "active") {
				const active = makeRun(taskId, { status: "blocked", blockReason: "permission" });
				db.update(scheduledTasks)
					.set({ activeRunId: active })
					.where(eq(scheduledTasks.id, taskId))
					.run();
			}
			return taskId;
		});
		deleteWithTransfer(target, actor);
		expect(taskRow(taskIds[0])?.completedAt).toEqual(expect.any(String));
		for (const id of taskIds.slice(1)) expect(taskRow(id)?.completedAt).toBeNull();
		for (const id of taskIds) {
			expect(taskRow(id)).toMatchObject({ firedCount: 1, lastStatus: "skipped", nextRunAt: null });
		}
	});

	test("rolls back transfer, snapshots, legacy FK releases and deletion together", () => {
		const actor = makeUser("admin"),
			target = makeUser();
		const taskId = makeTask(target, { narratorMode: "reuse" });
		const session = makeNarrator(target, taskId);
		db.update(scheduledTasks)
			.set({ reuseNarratorId: session })
			.where(eq(scheduledTasks.id, taskId))
			.run();
		const pending = makeRun(taskId, { narratorId: session });
		db.update(scheduledTasks)
			.set({ lastRunId: pending, lastStatus: "waiting", firedCount: 1 })
			.where(eq(scheduledTasks.id, taskId))
			.run();
		const pendingBefore = runRow(pending);
		const before = taskRow(taskId);
		expect(() =>
			db.transaction((tx) => {
				transferScheduledTasksBeforeUserDeletion(tx, target, actor, true);
				releaseUserForeignKeys(tx, target);
				tx.delete(users).where(eq(users.id, target)).run();
				// A later persistence failure must not leave a half-transferred account.
				tx.insert(users)
					.values({ id: actor, username: "duplicate", passwordHash: "x", createdAt: now })
					.run();
			}),
		).toThrow();
		expect(taskRow(taskId)).toEqual(before);
		expect(runRow(pending)).toEqual(pendingBefore);
		expect(narratorOwner(session)).toBe(target);
		expect(db.select().from(users).where(eq(users.id, target)).get()).toBeDefined();
	});

	test("requires confirmation and an actual current administrator; FK release refuses an owner", () => {
		const actor = makeUser("admin"),
			target = makeUser(),
			ordinary = makeUser();
		const taskId = makeTask(target);
		expect(() => deleteWithTransfer(target, actor, false)).toThrow("Confirm takeover");
		expect(() => deleteWithTransfer(target, ordinary)).toThrow("administrator");
		expect(() => deleteWithTransfer(target, target)).toThrow("administrator");
		expect(() => db.transaction((tx) => releaseUserForeignKeys(tx, target))).toThrow("transferred");
		expect(taskRow(taskId)?.ownerUserId).toBe(target);
	});

	test("preview uses a bounded stable cursor, includes legacy ownership and omits sensitive fields", async () => {
		const target = makeUser(),
			other = makeUser();
		const ids: string[] = [];
		for (let i = 0; i < USER_TASK_TRANSFER_PAGE_SIZE + 3; i++) {
			ids.push(
				makeTask(target, {
					name: "x".repeat(400),
					...(i === 0 ? { ownerUserId: null, schedule: null } : {}),
				}),
			);
		}
		makeTask(other, { createdBy: target });
		makeTask(target, { ownerUserId: null });
		const first = await previewUserScheduledTaskTransfer(target);
		expect(first.items).toHaveLength(USER_TASK_TRANSFER_PAGE_SIZE);
		const lastItem = first.items.at(-1);
		if (!lastItem) throw new Error("Expected the first transfer preview page to be full");
		expect(first.nextCursor).toBe(lastItem.id);
		const second = await previewUserScheduledTaskTransfer(target, first.nextCursor ?? undefined);
		expect(second.items).toHaveLength(3);
		expect(second.nextCursor).toBeNull();
		expect([...first.items, ...second.items].map((task) => task.id)).toEqual(ids.sort());
		for (const task of first.items) {
			expect(Object.keys(task).sort()).toEqual(["completedAt", "enabled", "id", "name"]);
			expect(task.name).toHaveLength(200);
		}
		expect(JSON.stringify(first)).not.toContain("private");
		await expect(previewUserScheduledTaskTransfer(target, "")).rejects.toThrow("cursor");
		await expect(previewUserScheduledTaskTransfer(target, "x".repeat(65))).rejects.toThrow(
			"cursor",
		);
	});

	test("bounds synchronous transfer work and leaves an oversized account unchanged", () => {
		const actor = makeUser("admin"),
			target = makeUser();
		const first = makeTask(target);
		for (let i = 1; i <= USER_TASK_TRANSFER_MAX; i++) makeTask(target);
		expect(() => deleteWithTransfer(target, actor)).toThrow("Too many scheduled tasks");
		expect(taskRow(first)?.ownerUserId).toBe(target);
		expect(db.select().from(users).where(eq(users.id, target)).get()).toBeDefined();
	});
});
