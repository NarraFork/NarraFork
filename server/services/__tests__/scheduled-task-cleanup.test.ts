import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import type { ScheduledTaskCleanupPolicy } from "@shared/scheduled-task-cleanup";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { db } from "../../db";
import {
	backgroundTasks,
	narratorMessages,
	narrators,
	scheduledTaskRuns,
	scheduledTasks,
	terminals,
	users,
} from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import {
	createScheduledTaskSchema,
	updateScheduledTaskSchema,
} from "../../lib/validators/scheduled-tasks";

const runningLoops = new Set<string>();
let failDispatch = false;
const realSession = { ...(await import("../narrator-session")) };
mock.module("../narrator-session", () => ({
	...realSession,
	isLoopRunning: (id: string) => runningLoops.has(id),
	sendScheduledTaskMessage: async () => {
		if (failDispatch) throw new Error("dispatch failed");
	},
}));
const admission = await import("../narrator-session-state");
const { narratorService } = await import("../narrator-service");
const { scheduledTaskService } = await import("../scheduled-task-service");
const { cleanupScheduledTaskNarrators, TASK_CLEANUP_ROOT_LIMIT } = await import(
	"../scheduled-task-cleanup"
);

const { scheduledTaskRoutes } = await import("../../routes/scheduled-tasks");

const taskIds: string[] = [];
const narratorIds: string[] = [];
const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
const principal = { userId: generateId(), isAdmin: false };
const outsiderId = generateId();
beforeAll(async () => {
	for (const id of [principal.userId, outsiderId])
		await db.insert(users).values({
			id,
			username: `retention-${id}`,
			passwordHash: "test",
			role: "user",
			createdAt: new Date().toISOString(),
		});
});
afterAll(async () => {
	for (const id of [principal.userId, outsiderId]) await db.delete(users).where(eq(users.id, id));
	mock.module("../narrator-session", () => realSession);
});

async function task(policy: ScheduledTaskCleanupPolicy = { mode: "none" }) {
	const row = await scheduledTaskService.create(
		{
			name: "retention test",
			prompt: "noop",
			cronExpr: "0 9 * * *",
			enabled: false,
			cleanupPolicy: policy,
		},
		principal,
	);
	taskIds.push(row.id);
	return row;
}

async function narrator(
	taskId: string | null,
	overrides: Partial<typeof narrators.$inferInsert> = {},
) {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		scheduledTaskId: taskId,
		ownerUserId: principal.userId,
		traits: taskId ? ["standalone", "scheduled"] : ["standalone"],
		createdAt: old,
		updatedAt: old,
		status: "idle",
		variant: "primary",
		...overrides,
	});
	narratorIds.push(id);
	return id;
}

async function exists(id: string) {
	return !!(await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
		columns: { id: true },
	}));
}

afterEach(async () => {
	runningLoops.clear();
	failDispatch = false;
	// Include sessions created by real scheduler dispatches, including failed ones.
	for (const taskId of taskIds) {
		const spawned = await db.query.narrators.findMany({
			where: eq(narrators.scheduledTaskId, taskId),
			columns: { id: true },
			limit: 200,
		});
		for (const n of spawned) if (await exists(n.id)) await narratorService.remove(n.id);
	}
	for (const id of narratorIds.splice(0)) if (await exists(id)) await narratorService.remove(id);
	for (const id of taskIds.splice(0)) {
		const row = await scheduledTaskService.get(id);
		if (row?.activeRunId)
			await (await import("../scheduled-task-run-service")).finalizeScheduledRun(
				row.activeRunId,
				"interrupted",
			);
		await scheduledTaskService.delete(id, principal);
	}
});

describe("task-scoped narrator retention", () => {
	test("none is the safe default and manual cleanup is a no-op", async () => {
		const t = await task();
		const id = await narrator(t.id);
		expect(t.cleanupPolicy).toEqual({ mode: "none" });
		expect((await cleanupScheduledTaskNarrators(t.id)).deletedRoots).toBe(0);
		expect(await exists(id)).toBe(true);
	});

	test("existing mode ignores retained cleanup policies and preserves its former roots and target", async () => {
		const t = await task({ mode: "olderThanDays", olderThanDays: 1 });
		const formerRoot = await narrator(t.id);
		const target = await narrator(null);
		const child = await narrator(null, {
			parentNarratorId: target,
			type: "subagent",
			variant: "subagent:general",
		});
		await db
			.update(scheduledTasks)
			.set({ narratorMode: "existing", targetNarratorId: target })
			.where(eq(scheduledTasks.id, t.id));
		expect(await cleanupScheduledTaskNarrators(t.id)).toEqual({
			deletedRoots: 0,
			deletedNarrators: 0,
			blockedRoots: 0,
			limited: false,
		});
		for (const id of [formerRoot, target, child]) expect(await exists(id)).toBe(true);
	});

	test("rechecks existing mode when a task changes after cleanup observed its subtree", async () => {
		const t = await task({ mode: "olderThanDays", olderThanDays: 1 });
		const root = await narrator(t.id);
		const target = await narrator(null);
		const reserve = admission.withIdleNarratorCleanupAdmission;
		const hook = spyOn(admission, "withIdleNarratorCleanupAdmission").mockImplementation(
			async <T>(ids: string[], fn: () => Promise<T>) => {
				await db
					.update(scheduledTasks)
					.set({ narratorMode: "existing", targetNarratorId: target })
					.where(eq(scheduledTasks.id, t.id));
				return reserve(ids, fn);
			},
		);
		try {
			expect(await cleanupScheduledTaskNarrators(t.id)).toMatchObject({
				deletedRoots: 0,
				blockedRoots: 1,
			});
			expect(await exists(root)).toBe(true);
			expect(await exists(target)).toBe(true);
		} finally {
			hook.mockRestore();
		}
	});

	test("keepLatestN keeps precisely N created roots, deletes their subtree and preserves history", async () => {
		const t = await task({ mode: "keepLatestN", keepLatestN: 2 });
		const ids: string[] = [];
		for (let i = 0; i < 5; i++)
			ids.push(
				await narrator(t.id, { createdAt: new Date(Date.now() - (5 - i) * 1000).toISOString() }),
			);
		const child = await narrator(null, {
			parentNarratorId: ids[0],
			variant: "subagent:general",
			type: "subagent",
			status: "archived",
		});
		await db.insert(scheduledTaskRuns).values({
			id: generateId(),
			taskId: t.id,
			narratorId: ids[0],
			status: "failed",
			runContext: "standalone",
			createdAt: old,
		});
		const result = await cleanupScheduledTaskNarrators(t.id);
		expect(result.deletedRoots).toBe(3);
		expect(result.deletedNarrators).toBe(4);
		for (const id of ids.slice(0, 3)) expect(await exists(id)).toBe(false);
		for (const id of ids.slice(3)) expect(await exists(id)).toBe(true);
		expect(await exists(child)).toBe(false);
		expect((await scheduledTaskService.listRuns(t.id, { principal })).runs).toHaveLength(1);
	});

	test("olderThanDays protects recent creation, recent activity and recent descendants", async () => {
		const t = await task({ mode: "olderThanDays", olderThanDays: 30 });
		const recent = new Date().toISOString();
		const expired = await narrator(t.id, { status: "archived" });
		const created = await narrator(t.id, { createdAt: recent });
		const active = await narrator(t.id, { lastMessageAt: recent });
		const activeChildRoot = await narrator(t.id);
		await narrator(null, {
			parentNarratorId: activeChildRoot,
			type: "subagent",
			variant: "subagent:general",
			lastMessageAt: recent,
		});
		expect((await cleanupScheduledTaskNarrators(t.id)).deletedRoots).toBe(1);
		expect(await exists(expired)).toBe(false);
		for (const id of [created, active, activeChildRoot]) expect(await exists(id)).toBe(true);
	});

	test("does not touch other tasks, ordinary sessions or legacy scheduled sessions seen in runs", async () => {
		const a = await task({ mode: "olderThanDays", olderThanDays: 1 });
		const b = await task();
		const owned = await narrator(a.id);
		const other = await narrator(b.id);
		const ordinary = await narrator(null);
		const legacy = await narrator(null, { traits: ["scheduled"] });
		for (const id of [ordinary, legacy, other])
			await db.insert(scheduledTaskRuns).values({
				id: generateId(),
				taskId: a.id,
				narratorId: id,
				status: "success",
				runContext: "standalone",
				createdAt: old,
			});
		await cleanupScheduledTaskNarrators(a.id);
		expect(await exists(owned)).toBe(false);
		for (const id of [other, ordinary, legacy]) expect(await exists(id)).toBe(true);
	});

	test("protects running loops, status, terminals and background sessions, including children", async () => {
		const t = await task({ mode: "olderThanDays", olderThanDays: 1 });
		const loop = await narrator(t.id);
		runningLoops.add(loop);
		const status = await narrator(t.id, { status: "working" });
		const background = await narrator(t.id, { isBackground: true, backgroundStatus: "running" });
		const terminalRoot = await narrator(t.id);
		const terminalChild = await narrator(null, {
			parentNarratorId: terminalRoot,
			type: "subagent",
			variant: "subagent:general",
		});
		await db
			.insert(terminals)
			.values({ id: generateId(), narratorId: terminalChild, name: "running", createdAt: old });
		const result = await cleanupScheduledTaskNarrators(t.id);
		expect(result.deletedRoots).toBe(0);
		expect(result.blockedRoots).toBe(4);
		for (const id of [loop, status, background, terminalRoot, terminalChild])
			expect(await exists(id)).toBe(true);
	});

	test("protects running background Bash (including detach) and running/paused transfers in descendants", async () => {
		const t = await task({ mode: "olderThanDays", olderThanDays: 1 });
		for (const [type, status, command] of [
			["bash", "running", "sleep 30"],
			["bash", "running", "detached process"],
			["transfer", "running", null],
			["transfer", "paused", null],
		] as const) {
			const root = await narrator(t.id);
			const child = await narrator(null, {
				parentNarratorId: root,
				type: "subagent",
				variant: "subagent:general",
			});
			await db.insert(backgroundTasks).values({
				id: generateId(),
				parentNarratorId: child,
				type,
				status,
				command,
				startedAt: old,
				createdAt: old,
				updatedAt: old,
			});
		}
		const result = await cleanupScheduledTaskNarrators(t.id);
		expect(result.deletedRoots).toBe(0);
		expect(result.blockedRoots).toBe(4);
	});

	test("cleanup never interrupts admitted start/resume/fork work to acquire eligibility", async () => {
		const t = await task({ mode: "olderThanDays", olderThanDays: 1 });
		const root = await narrator(t.id);
		await admission.withNarratorStartAdmission(root, async () => {
			const result = await cleanupScheduledTaskNarrators(t.id);
			expect(result.deletedRoots).toBe(0);
			expect(result.blockedRoots).toBe(1);
			expect(await exists(root)).toBe(true);
		});
		expect((await cleanupScheduledTaskNarrators(t.id)).deletedRoots).toBe(1);
	});

	test("exclusive cleanup reservation rejects concurrent start, resume and fork without stopping work", async () => {
		const t = await task();
		const root = await narrator(t.id);
		await admission.withIdleNarratorCleanupAdmission([root], async () => {
			expect(() => admission.withNarratorStartAdmission(root, async () => {})).toThrow();
			await expect(admission.withNarratorMutationAdmission(root, async () => {})).rejects.toThrow();
			await expect(narratorService.forkNarrator(root, null)).rejects.toThrow();
			await expect(
				narratorService.createSubagent({
					parentNarratorId: root,
					subagentType: "general",
					model: "default",
					systemPrompt: "",
					cwd: "/unused",
				}),
			).rejects.toThrow();
			expect(await exists(root)).toBe(true);
		});
	});

	test("cleanup reservation rejects concurrent creation and update of explicit target references", async () => {
		const owner = await task({ mode: "olderThanDays", olderThanDays: 1 });
		const root = await narrator(owner.id);
		const child = await narrator(null, {
			parentNarratorId: root,
			aclRootNarratorId: root,
			type: "subagent",
			variant: "subagent:general",
		});
		const candidate = await task();
		await admission.withIdleNarratorCleanupAdmission([root, child], async () => {
			const create = scheduledTaskService
				.create(
					{
						name: "Concurrent reference",
						prompt: "noop",
						cronExpr: "0 9 * * *",
						enabled: false,
						narratorMode: "existing",
						targetNarratorId: child,
					},
					principal,
				)
				.then((row) => {
					taskIds.push(row.id);
					return row;
				});
			await expect(create).rejects.toMatchObject({ statusCode: 409 });
			await expect(
				scheduledTaskService.update(
					candidate.id,
					{ narratorMode: "existing", targetNarratorId: root },
					principal,
				),
			).rejects.toMatchObject({ statusCode: 409 });
		});
		expect((await scheduledTaskService.get(candidate.id))?.targetNarratorId).toBeNull();
		expect((await cleanupScheduledTaskNarrators(owner.id)).deletedNarrators).toBe(2);
	});

	test("revalidates a fork added between the observed subtree and exclusive deletion", async () => {
		const t = await task({ mode: "olderThanDays", olderThanDays: 1 });
		const root = await narrator(t.id);
		const reserve = admission.withIdleNarratorCleanupAdmission;
		const hook = spyOn(admission, "withIdleNarratorCleanupAdmission").mockImplementation(
			async <T>(ids: string[], fn: () => Promise<T>) => {
				const fork = await narratorService.forkNarrator(root, null);
				narratorIds.push(fork.id);
				return reserve(ids, fn);
			},
		);
		try {
			const result = await cleanupScheduledTaskNarrators(t.id);
			expect(result.deletedRoots).toBe(0);
			expect(result.blockedRoots).toBe(1);
			expect(await exists(root)).toBe(true);
		} finally {
			hook.mockRestore();
		}
	});

	test("lifecycle reservation remains held across awaits inside recursive removal", async () => {
		const t = await task({ mode: "olderThanDays", olderThanDays: 1 });
		const root = await narrator(t.id);
		const remove = narratorService.remove.bind(narratorService);
		const hook = spyOn(narratorService, "remove").mockImplementation(async (id) => {
			const starts = await Promise.allSettled([
				Promise.resolve().then(() =>
					admission.withNarratorStartAdmission(id, async () => {
						runningLoops.add(id);
					}),
				),
				narratorService.forkNarrator(id, null),
			]);
			expect(starts.every((result) => result.status === "rejected")).toBe(true);
			expect(runningLoops.has(id)).toBe(false);
			return remove(id);
		});
		try {
			expect((await cleanupScheduledTaskNarrators(t.id)).deletedRoots).toBe(1);
			expect(await exists(root)).toBe(false);
		} finally {
			hook.mockRestore();
		}
	});

	test("protects remembered reuse sessions and references from another task", async () => {
		const a = await task({ mode: "olderThanDays", olderThanDays: 1 });
		const b = await task();
		const reuse = await narrator(a.id);
		const shared = await narrator(a.id);
		await db
			.update(scheduledTasks)
			.set({ reuseNarratorId: reuse })
			.where(eq(scheduledTasks.id, a.id));
		await db
			.update(scheduledTasks)
			.set({ lastNarratorId: shared })
			.where(eq(scheduledTasks.id, b.id));
		expect((await cleanupScheduledTaskNarrators(a.id)).deletedRoots).toBe(0);
		expect(await exists(reuse)).toBe(true);
		expect(await exists(shared)).toBe(true);
	});

	for (const reference of ["root", "descendant", "self"] as const) {
		test(`protects explicit target references to a ${reference}, even from a disabled task`, async () => {
			const owner = await task({ mode: "olderThanDays", olderThanDays: 1 });
			const root = await narrator(owner.id);
			const child = await narrator(null, {
				parentNarratorId: root,
				type: "subagent",
				variant: "subagent:general",
			});
			const referring = reference === "self" ? owner : await task();
			await db
				.update(scheduledTasks)
				.set({
					targetNarratorId: reference === "root" ? root : child,
					...(reference === "self" ? {} : { narratorMode: "existing" as const }),
				})
				.where(eq(scheduledTasks.id, referring.id));
			expect(await cleanupScheduledTaskNarrators(owner.id)).toMatchObject({
				deletedRoots: 0,
				blockedRoots: 1,
			});
			expect(await exists(root)).toBe(true);
			expect(await exists(child)).toBe(true);
			await db
				.update(scheduledTasks)
				.set({ targetNarratorId: null })
				.where(eq(scheduledTasks.id, referring.id));
			expect((await cleanupScheduledTaskNarrators(owner.id)).deletedNarrators).toBe(2);
		});
	}

	test("bounded batches advance past protected roots rather than starving older sessions", async () => {
		const t = await task({ mode: "olderThanDays", olderThanDays: 1 });
		const older = await narrator(t.id, {
			createdAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
		});
		for (let i = 0; i < TASK_CLEANUP_ROOT_LIMIT; i++) await narrator(t.id, { status: "working" });
		const first = await cleanupScheduledTaskNarrators(t.id);
		expect(first.deletedRoots).toBe(0);
		expect(first.limited).toBe(true);
		expect(await exists(older)).toBe(true);
		expect((await cleanupScheduledTaskNarrators(t.id)).deletedRoots).toBe(1);
	});

	test("a giant subtree is never passed to recursive remove", async () => {
		const t = await task({ mode: "olderThanDays", olderThanDays: 1 });
		const root = await narrator(t.id);
		for (let i = 0; i < 100; i++)
			await narrator(null, {
				parentNarratorId: root,
				type: "subagent",
				variant: "subagent:general",
			});
		expect((await cleanupScheduledTaskNarrators(t.id)).blockedRoots).toBe(1);
		expect(await exists(root)).toBe(true);
	});

	test("oversized message payloads are protected without loading their contents", async () => {
		const t = await task({ mode: "olderThanDays", olderThanDays: 1 });
		const id = await narrator(t.id);
		await db.insert(narratorMessages).values({
			id: generateId(),
			narratorId: id,
			role: "assistant",
			contentJson: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }],
			createdAt: old,
		});
		const result = await cleanupScheduledTaskNarrators(t.id);
		expect(result.deletedRoots).toBe(0);
		expect(result.blockedRoots).toBe(1);
		expect(await exists(id)).toBe(true);
	});

	test("automatic cleanup runs after both successful and failed dispatches; creation attribution survives failure", async () => {
		for (const fail of [false, true]) {
			failDispatch = fail;
			const t = await task({ mode: "keepLatestN", keepLatestN: 1 });
			const previous = await narrator(t.id);
			await scheduledTaskService.runTask(t.id, { manual: true, principal });
			expect(await exists(previous)).toBe(false);
			const owned = await db.query.narrators.findMany({
				where: eq(narrators.scheduledTaskId, t.id),
				limit: 2,
			});
			expect(owned).toHaveLength(1);
			expect(owned[0]?.traits).toContain("scheduled");
			expect((await scheduledTaskService.get(t.id))?.lastStatus).toBe(fail ? "failed" : "running");
		}
	});

	test("deleting the task detaches provenance but preserves its sessions", async () => {
		const t = await task();
		const id = await narrator(t.id);
		await scheduledTaskService.delete(t.id, principal);
		taskIds.splice(taskIds.indexOf(t.id), 1);
		expect(await exists(id)).toBe(true);
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.scheduledTaskId,
		).toBeNull();
	});

	test("deleting an existing-target task leaves the ordinary target and its children untouched", async () => {
		const t = await task();
		const target = await narrator(null, { permissionMode: "readOnly", model: "ordinary-model" });
		const child = await narrator(null, {
			parentNarratorId: target,
			type: "subagent",
			variant: "subagent:general",
		});
		await db
			.update(scheduledTasks)
			.set({ narratorMode: "existing", targetNarratorId: target })
			.where(eq(scheduledTasks.id, t.id));
		const before = await db.query.narrators.findFirst({ where: eq(narrators.id, target) });
		await scheduledTaskService.delete(t.id, principal);
		taskIds.splice(taskIds.indexOf(t.id), 1);
		expect(await db.query.narrators.findFirst({ where: eq(narrators.id, target) })).toEqual(before);
		expect(await exists(child)).toBe(true);
	});

	test("manual cleanup and policy changes require the task creator or an admin", async () => {
		const t = await task({ mode: "olderThanDays", olderThanDays: 1 });
		const id = await narrator(t.id);
		let role: "user" | "admin" = "user";
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("user", { sub: outsiderId, role, iat: 0, exp: 0 });
			await next();
		});
		app.onError((err, c) =>
			c.json(
				{ error: err.message },
				(err instanceof AppError ? err.statusCode : 500) as ContentfulStatusCode,
			),
		);
		app.route("/tasks", scheduledTaskRoutes);
		expect((await app.request(`/tasks/${t.id}/cleanup`, { method: "POST" })).status).toBe(404);
		expect(
			(
				await app.request(`/tasks/${t.id}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ cleanupPolicy: { mode: "none" } }),
				})
			).status,
		).toBe(404);
		expect(await exists(id)).toBe(true);
		role = "admin";
		await db.update(users).set({ role }).where(eq(users.id, outsiderId));
		const response = await app.request(`/tasks/${t.id}/cleanup`, { method: "POST" });
		expect(response.status).toBe(200);
		expect((await response.json()).deletedRoots).toBe(1);
		expect(await exists(id)).toBe(false);
	});

	test("API validation rejects invalid limits and allows partial retention updates", () => {
		const base = { name: "test", prompt: "x", cronExpr: "0 9 * * *" };
		for (const policy of [
			{ mode: "keepLatestN", keepLatestN: 0 },
			{ mode: "olderThanDays", olderThanDays: 1.5 },
			{ mode: "keepLatestN", keepLatestN: 1001 },
			{ mode: "unknown" },
		]) {
			expect(createScheduledTaskSchema.safeParse({ ...base, cleanupPolicy: policy }).success).toBe(
				false,
			);
		}
		expect(
			updateScheduledTaskSchema.safeParse({
				cleanupPolicy: { mode: "keepLatestN", keepLatestN: 3 },
			}).success,
		).toBe(true);
	});
});
