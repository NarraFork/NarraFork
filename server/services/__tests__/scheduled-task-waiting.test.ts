import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators, scheduledTaskRuns, scheduledTasks, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import {
	type ExecutionOwner,
	getExecutionOwner,
	getRunControl,
	type RunControl,
	setRunControl,
	tryClaimExecution,
} from "../agent-runtime/ownership";
import {
	bindScheduledRunMember,
	getRegisteredScheduledRun,
	unregisterScheduledRun,
} from "../scheduled-run-registry";
import type { ScheduledTaskPrincipal } from "../scheduled-task-acl";

const realSession = { ...(await import("../narrator-session")) };
const dispatches: Array<{ runId: string; narratorId: string }> = [];
const cancellations: string[] = [];
let onCancel: (() => void) | undefined;
let beforeCancel: (() => void) | undefined;
mock.module("../narrator-session", () => ({
	...realSession,
	sendScheduledTaskMessage: async (input: { runId: string; narratorId: string }) => {
		dispatches.push(input);
		return { id: generateId() };
	},
	cancelScheduledRunTarget: async (target: {
		narratorId: string;
		logicalRunId?: string;
		executionEpoch?: string;
	}) => {
		beforeCancel?.();
		const control = getRunControl(target.narratorId);
		const owner = getExecutionOwner(target.narratorId);
		if (
			!owner ||
			(target.executionEpoch && target.executionEpoch !== owner.epoch) ||
			(target.logicalRunId && target.logicalRunId !== control?.logicalRunId)
		)
			return false;
		cancellations.push(target.narratorId);
		control?.cancel.abort("scheduled_interrupt");
		onCancel?.();
		return true;
	},
}));
const { scheduledTaskService } = await import("../scheduled-task-service");
const { finalizeScheduledRun } = await import("../scheduled-task-run-service");
const { acceptScheduledTaskRun, advanceScheduledTaskRun, pollScheduledWaitingRuns } = await import(
	"../scheduled-task-waiting"
);
const { resolveScheduledTaskTarget } = await import("../scheduled-task-target");
let owner: ScheduledTaskPrincipal;
let admin: ScheduledTaskPrincipal;
const taskIds: string[] = [];
const targetIds: string[] = [];
const userIds: string[] = [];
const executionOwners: ExecutionOwner[] = [];
async function person(role: "user" | "admin" = "user") {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `waiting-${id}`,
		passwordHash: "test",
		role,
		createdAt: new Date().toISOString(),
	});
	userIds.push(id);
	return { userId: id, isAdmin: role === "admin" };
}
async function target() {
	const id = generateId();
	const ts = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		ownerUserId: owner.userId,
		cwd: process.cwd(),
		title: "Existing conversation",
		model: "__default__",
		visibility: "private",
		writeAudience: "owner",
		permissionMode: "readOnly",
		systemPrompt: "keep this prompt",
		createdAt: ts,
		updatedAt: ts,
	});
	targetIds.push(id);
	return id;
}
async function busy(id: string, logicalRunId = generateId()) {
	const execution = tryClaimExecution(id, "run");
	if (!execution) throw new Error("fixture target already occupied");
	executionOwners.push(execution);
	const run: RunControl = {
		startedAt: Date.now(),
		logicalRunId,
		cancel: new AbortController(),
		timedOut: false,
		terminal: new Promise(() => {}),
	};
	setRunControl(execution, run);
	await db.update(narrators).set({ logicalRunId }).where(eq(narrators.id, id));
	return { execution, run };
}
async function task(
	targetId: string,
	input: Partial<Parameters<typeof scheduledTaskService.create>[0]> = {},
) {
	const row = await scheduledTaskService.create(
		{
			name: "Waiting task",
			prompt: "Do the task",
			cronExpr: "0 9 * * *",
			timezone: "UTC",
			narratorMode: "existing",
			targetNarratorId: targetId,
			onBusy: "wait",
			...input,
		},
		owner,
	);
	taskIds.push(row.id);
	return row;
}
async function latest(taskId: string) {
	const row = await scheduledTaskService.get(taskId);
	if (!row?.lastRunId) throw new Error("missing accepted run");
	const run = await db.query.scheduledTaskRuns.findFirst({
		where: eq(scheduledTaskRuns.id, row.lastRunId),
	});
	if (!run) throw new Error("missing run");
	return run;
}
async function runNow(taskId: string) {
	await scheduledTaskService.runTask(taskId, { manual: true, principal: owner });
}
beforeEach(async () => {
	owner = await person();
	admin = await person("admin");
	dispatches.length = 0;
	cancellations.length = 0;
	onCancel = undefined;
	beforeCancel = undefined;
});
afterEach(async () => {
	for (const execution of executionOwners.splice(0)) execution.release();
	for (const taskId of taskIds.splice(0)) {
		const rows = await db.query.scheduledTaskRuns.findMany({
			where: eq(scheduledTaskRuns.taskId, taskId),
			columns: { id: true },
			limit: 80,
		});
		for (const row of rows) unregisterScheduledRun(row.id);
		await db.update(scheduledTasks).set({ activeRunId: null }).where(eq(scheduledTasks.id, taskId));
		await scheduledTaskService.delete(taskId, admin);
	}
	for (const id of targetIds.splice(0)) await db.delete(narrators).where(eq(narrators.id, id));
	for (const id of userIds.splice(0)) await db.delete(users).where(eq(users.id, id));
});

describe("existing target admission", () => {
	test("normalizes inherited settings, defaults follow, and fences approved target changes", async () => {
		const id = await target();
		const resolved = await resolveScheduledTaskTarget(owner, id);
		const row = await task(id, {
			cwd: "ignored",
			projectId: "ignored",
			runContext: "project",
			systemPrompt: "ignored",
		});
		expect(row).toMatchObject({
			narratorMode: "existing",
			modelPolicy: "follow",
			cwd: null,
			projectId: null,
			runContext: "standalone",
			systemPrompt: null,
			requireReport: true,
		});
		await db.update(narrators).set({ model: "changed" }).where(eq(narrators.id, id));
		await expect(
			scheduledTaskService.runTask(row.id, {
				manual: true,
				principal: owner,
				expectedTarget: { id, fingerprint: resolved.fingerprint },
			}),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(dispatches).toHaveLength(0);
	});
	test("scheduled ACL failures notify and trip the existing failure circuit", async () => {
		const id = await target();
		const row = await task(id);
		await db.update(narrators).set({ ownerUserId: admin.userId }).where(eq(narrators.id, id));
		const { setScheduledRunNotifier } = await import("../scheduled-task-run-service");
		const notices: string[] = [];
		setScheduledRunNotifier(async (_runId, kind) => {
			notices.push(kind);
		});
		try {
			for (let i = 0; i < 5; i++) {
				const now = new Date();
				await db
					.update(scheduledTasks)
					.set({ nextRunAt: now.toISOString() })
					.where(eq(scheduledTasks.id, row.id));
				await scheduledTaskService.runTask(row.id, { at: now });
			}
		} finally {
			setScheduledRunNotifier(async () => {});
		}
		expect(await latest(row.id)).toMatchObject({
			status: "failed",
			errorKind: "acl",
			startedAt: null,
		});
		expect(await scheduledTaskService.get(row.id)).toMatchObject({
			enabled: false,
			pauseReason: "circuit_breaker",
			consecutiveFailures: 5,
		});
		expect(notices.filter((kind) => kind === "failed")).toHaveLength(5);
		expect(notices.filter((kind) => kind === "circuit_breaker")).toHaveLength(1);
	});
	test("owner revocation prevents dispatch even for an administrator", async () => {
		const id = await target();
		const row = await task(id);
		await db.update(narrators).set({ ownerUserId: admin.userId }).where(eq(narrators.id, id));
		await expect(
			scheduledTaskService.runTask(row.id, { manual: true, principal: admin }),
		).rejects.toMatchObject({ statusCode: 404 });
		await scheduledTaskService.setEnabled(row.id, false, admin);
		expect(dispatches).toHaveLength(0);
	});
	test("target disappearance never creates a replacement", async () => {
		const id = await target();
		const row = await task(id);
		await busy(id);
		await runNow(row.id);
		const pending = await latest(row.id);
		getExecutionOwner(id)?.release();
		await db.delete(narrators).where(eq(narrators.id, id));
		await advanceScheduledTaskRun(pending.id);
		expect((await latest(row.id)).status).toBe("failed");
		await scheduledTaskService.update(row.id, { name: "Target was deleted" }, owner);
		await scheduledTaskService.update(row.id, { enabled: false }, owner);
		expect((await scheduledTaskService.get(row.id))?.enabled).toBe(false);
		expect(dispatches).toHaveLength(0);
	});
});

describe("bounded waiting and lifecycle", () => {
	test("one pending occurrence per task, fixed wait deadline and dispatch-only execution clock", async () => {
		const id = await target();
		const occupied = await busy(id);
		const row = await task(id, { busyWaitMinutes: 5, maxRunMinutes: 5, requireReport: false });
		await runNow(row.id);
		const first = await latest(row.id);
		expect(first).toMatchObject({
			status: "waiting",
			startedAt: null,
			deadlineAt: null,
			requireReport: false,
		});
		expect((await scheduledTaskService.get(row.id))?.activeRunId).toBeNull();
		await runNow(row.id);
		expect((await latest(row.id)).errorKind).toBe("busy");
		expect(
			(await db.query.scheduledTaskRuns.findFirst({ where: eq(scheduledTaskRuns.id, first.id) }))
				?.busyDeadlineAt,
		).toBe(first.busyDeadlineAt);
		occupied.execution.release();
		await advanceScheduledTaskRun(first.id);
		const dispatched = await db.query.scheduledTaskRuns.findFirst({
			where: eq(scheduledTaskRuns.id, first.id),
		});
		expect(dispatched?.status).toBe("running");
		expect(dispatched?.startedAt).not.toBeNull();
		expect(Date.parse(dispatched?.deadlineAt ?? "") - Date.parse(dispatched?.startedAt ?? "")).toBe(
			300000,
		);
		expect(getRegisteredScheduledRun(id)?.requireReport).toBe(false);
	});
	test("normal waiters dispatch in acceptance order across tasks", async () => {
		const id = await target();
		const occupied = await busy(id);
		const first = await task(id);
		const second = await task(id);
		await db
			.update(scheduledTasks)
			.set({ updatedAt: new Date(Date.now() + 5000).toISOString() })
			.where(eq(scheduledTasks.id, first.id));
		await runNow(first.id);
		await runNow(second.id);
		const a = await latest(first.id);
		const b = await latest(second.id);
		expect(a.createdAt < b.createdAt).toBe(true);
		occupied.execution.release();
		await advanceScheduledTaskRun(b.id);
		expect(dispatches).toHaveLength(0);
		await advanceScheduledTaskRun(a.id);
		expect(dispatches.map((item) => item.runId)).toEqual([a.id]);
		await finalizeScheduledRun(a.id, "completed");
		await advanceScheduledTaskRun(b.id);
		expect(dispatches.map((item) => item.runId)).toEqual([a.id, b.id]);
	});
	test("skip does not become a waiter when a person wins dispatch admission", async () => {
		const id = await target();
		const row = await task(id, { onBusy: "skip" });
		const runId = await acceptScheduledTaskRun(row, { manual: true, at: new Date() });
		if (!runId) throw new Error("missing accepted run");
		await busy(id);
		await advanceScheduledTaskRun(runId);
		expect(await latest(row.id)).toMatchObject({ status: "skipped", errorKind: "busy" });
		expect(cancellations).toHaveLength(0);
		expect(dispatches).toHaveLength(0);
	});
	test("a wait deadline is rechecked after acquiring start admission", async () => {
		const id = await target();
		const row = await task(id);
		const runId = await acceptScheduledTaskRun(row, { manual: true, at: new Date() });
		if (!runId) throw new Error("missing waiter");
		const waiting = await latest(row.id);
		const sessionState = await import("../narrator-session-state");
		const original = sessionState.withNarratorStartAdmission;
		const now = spyOn(Date, "now");
		const admission = spyOn(sessionState, "withNarratorStartAdmission").mockImplementation(
			(narratorId, fn) =>
				original(narratorId, async () => {
					now.mockReturnValue(Date.parse(waiting.busyDeadlineAt ?? "") + 1);
					return fn();
				}),
		);
		try {
			await advanceScheduledTaskRun(runId);
		} finally {
			admission.mockRestore();
			now.mockRestore();
		}
		expect(await latest(row.id)).toMatchObject({ status: "skipped", errorKind: "busy_timeout" });
		expect(dispatches).toHaveLength(0);
	});
	test("waiting expiry skips without runtime or failure budget", async () => {
		const id = await target();
		await busy(id);
		const row = await task(id);
		await runNow(row.id);
		const pending = await latest(row.id);
		await db
			.update(scheduledTaskRuns)
			.set({ busyDeadlineAt: new Date(Date.now() - 1).toISOString() })
			.where(eq(scheduledTaskRuns.id, pending.id));
		await pollScheduledWaitingRuns();
		expect(await latest(row.id)).toMatchObject({
			status: "skipped",
			errorKind: "busy_timeout",
			startedAt: null,
		});
		expect((await scheduledTaskService.get(row.id))?.consecutiveFailures).toBe(0);
		expect(cancellations).toHaveLength(0);
	});
	test("pause cancels waiting and a name edit cannot complete its exhausted schedule", async () => {
		const id = await target();
		await busy(id);
		const row = await task(id);
		await runNow(row.id);
		await db
			.update(scheduledTasks)
			.set({
				nextRunAt: null,
				schedule: { kind: "at", times: ["2020-01-01T00:00"] },
				scheduleCursorAt: new Date().toISOString(),
			})
			.where(eq(scheduledTasks.id, row.id));
		await scheduledTaskService.update(row.id, { name: "Renamed" }, owner);
		await scheduledTaskService.reconcileCompletion(row.id);
		expect((await scheduledTaskService.get(row.id))?.completedAt).toBeNull();
		await scheduledTaskService.setEnabled(row.id, false, owner);
		expect((await latest(row.id)).errorKind).toBe("cancelled");
		expect(dispatches).toHaveLength(0);
	});
	test("the last planned occurrence waits without ending the task", async () => {
		const id = await target();
		await busy(id);
		const row = await task(id, {
			schedule: {
				kind: "repeat",
				rule: { unit: "minute", interval: 1 },
				end: { type: "count", count: 1 },
			},
		});
		const now = new Date();
		await db
			.update(scheduledTasks)
			.set({ nextRunAt: now.toISOString() })
			.where(eq(scheduledTasks.id, row.id));
		await scheduledTaskService.runTask(row.id, { at: now });
		expect((await latest(row.id)).status).toBe("waiting");
		expect(await scheduledTaskService.get(row.id)).toMatchObject({
			firedCount: 1,
			nextRunAt: null,
			completedAt: null,
			activeRunId: null,
		});
		await scheduledTaskService.reconcileCompletion(row.id);
		expect((await scheduledTaskService.get(row.id))?.completedAt).toBeNull();
		await expect(
			scheduledTaskService.update(row.id, { enabled: true }, owner),
		).rejects.toMatchObject({ statusCode: 400 });
		expect((await latest(row.id)).status).toBe("waiting");
	});
	test("a target holds at most 64 waiters", async () => {
		const id = await target();
		await busy(id);
		const now = new Date().toISOString();
		db.transaction((tx) => {
			for (let i = 0; i < 64; i++) {
				const taskId = generateId();
				taskIds.push(taskId);
				tx.insert(scheduledTasks)
					.values({
						id: taskId,
						name: "Already queued",
						prompt: "do",
						cronExpr: "0 9 * * *",
						ownerUserId: owner.userId,
						narratorMode: "existing",
						targetNarratorId: id,
						onBusy: "wait",
						createdAt: now,
						updatedAt: now,
					})
					.run();
				tx.insert(scheduledTaskRuns)
					.values({
						id: generateId(),
						taskId,
						narratorId: id,
						runContext: "standalone",
						status: "waiting",
						busyDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
						createdAt: now,
					})
					.run();
			}
		});
		const overflow = await task(id);
		await runNow(overflow.id);
		expect(await latest(overflow.id)).toMatchObject({
			status: "skipped",
			errorKind: "busy",
			startedAt: null,
		});
		expect(dispatches).toHaveLength(0);
	}, 15000);
	test("transferring cancels the old owner's waiter", async () => {
		const id = await target();
		await busy(id);
		const row = await task(id);
		await runNow(row.id);
		await scheduledTaskService.transfer(row.id, admin.userId, admin);
		expect(await latest(row.id)).toMatchObject({ status: "skipped", errorKind: "cancelled" });
		expect((await scheduledTaskService.get(row.id))?.ownerUserId).toBe(admin.userId);
		expect(dispatches).toHaveLength(0);
	});
	test("target changes revoke the original waiter", async () => {
		const oldTarget = await target();
		const newTarget = await target();
		await busy(oldTarget);
		const row = await task(oldTarget);
		await runNow(row.id);
		const pending = await latest(row.id);
		await scheduledTaskService.update(row.id, { targetNarratorId: newTarget }, owner);
		await advanceScheduledTaskRun(pending.id);
		expect((await latest(row.id)).errorKind).toBe("cancelled");
		expect(dispatches).toHaveLength(0);
	});
});

describe("exclusive next-start interrupt reservation", () => {
	test("interrupt overtakes normal waiters; another interrupter cancels nothing", async () => {
		const id = await target();
		const occupied = await busy(id);
		const normal = await task(id);
		const winner = await task(id, { onBusy: "interrupt" });
		const loser = await task(id, { onBusy: "interrupt" });
		await runNow(normal.id);
		await Promise.all([runNow(winner.id), runNow(loser.id)]);
		const accepted = [await latest(winner.id), await latest(loser.id)];
		const reservation = accepted.find((run) => run.status === "waiting");
		expect(reservation?.interruptTarget?.logicalRunId).toBe(occupied.run.logicalRunId);
		expect(accepted.filter((run) => run.status === "skipped")).toHaveLength(1);
		expect(cancellations).toEqual([id]);
		occupied.execution.release();
		await advanceScheduledTaskRun((await latest(normal.id)).id);
		expect(dispatches).toHaveLength(0);
		await advanceScheduledTaskRun(reservation?.id ?? "missing");
		expect(dispatches.map((item) => item.runId)).toEqual([reservation?.id ?? "missing"]);
	});
	test("interrupt reserves the available next start ahead of ordinary waiters", async () => {
		const id = await target();
		const original = await busy(id);
		const normal = await task(id);
		await runNow(normal.id);
		original.execution.release();
		const interrupt = await task(id, { onBusy: "interrupt" });
		await runNow(interrupt.id);
		expect(dispatches.map((entry) => entry.runId)).toEqual([(await latest(interrupt.id)).id]);
		expect((await latest(normal.id)).status).toBe("waiting");
		expect(cancellations).toHaveLength(0);
	});
	test("a later manual execution defeats takeover without being cancelled", async () => {
		const id = await target();
		const original = await busy(id);
		const row = await task(id, { onBusy: "interrupt" });
		await runNow(row.id);
		const waiting = await latest(row.id);
		original.execution.release();
		const manual = await busy(id);
		await advanceScheduledTaskRun(waiting.id);
		expect(await latest(row.id)).toMatchObject({ status: "skipped", errorKind: "busy" });
		expect(manual.run.cancel.signal.aborted).toBe(false);
		expect(cancellations).toHaveLength(1);
		expect(dispatches).toHaveLength(0);
	});
	test("interrupt timeout never retries cancellation and permits no dispatch", async () => {
		const id = await target();
		await busy(id);
		const row = await task(id, { onBusy: "interrupt", busyWaitMinutes: 120 });
		await runNow(row.id);
		const waiting = await latest(row.id);
		expect(
			Date.parse(waiting.busyDeadlineAt ?? "") - Date.parse(waiting.createdAt),
		).toBeLessThanOrEqual(15_000);
		await advanceScheduledTaskRun(waiting.id);
		expect(cancellations).toHaveLength(1);
		await db
			.update(scheduledTaskRuns)
			.set({ busyDeadlineAt: new Date(Date.now() - 1).toISOString() })
			.where(eq(scheduledTaskRuns.id, waiting.id));
		await advanceScheduledTaskRun(waiting.id);
		expect(await latest(row.id)).toMatchObject({ status: "skipped", errorKind: "busy_timeout" });
		expect(cancellations).toHaveLength(1);
		expect(dispatches).toHaveLength(0);
	});
	test("a pause after interrupt acceptance prevents its later dispatch", async () => {
		const id = await target();
		const original = await busy(id);
		const row = await task(id, { onBusy: "interrupt" });
		await runNow(row.id);
		const waiting = await latest(row.id);
		await scheduledTaskService.setEnabled(row.id, false, owner);
		original.execution.release();
		await advanceScheduledTaskRun(waiting.id);
		expect(await latest(row.id)).toMatchObject({ status: "skipped", errorKind: "cancelled" });
		expect(cancellations).toHaveLength(1);
		expect(dispatches).toHaveLength(0);
	});
	test("new mode interrupts its old target and prepares a different narrator", async () => {
		const unused = await target();
		const row = await task(unused, { narratorMode: "new", onBusy: "interrupt" });
		await runNow(row.id);
		const previous = await latest(row.id);
		const oldId = previous.narratorId;
		if (!oldId) throw new Error("missing generated narrator");
		targetIds.push(oldId);
		const occupied = await busy(oldId);
		const registration = getRegisteredScheduledRun(oldId);
		if (!registration) throw new Error("missing registration");
		registration.logicalRunId = occupied.run.logicalRunId;
		registration.executionEpoch = occupied.execution.epoch;
		await db
			.update(scheduledTaskRuns)
			.set({ logicalRunId: occupied.run.logicalRunId })
			.where(eq(scheduledTaskRuns.id, previous.id));
		await runNow(row.id);
		const waiting = await latest(row.id);
		occupied.execution.release();
		await advanceScheduledTaskRun(waiting.id);
		const next = await latest(row.id);
		const newId = next.narratorId;
		if (!newId || newId === oldId) throw new Error("expected a distinct narrator");
		targetIds.push(newId);
		expect(next.status).toBe("running");
		expect(getRegisteredScheduledRun(newId)?.interruptTarget).toBeUndefined();
		await realSession.prepareScheduledTaskSession({
			runId: next.id,
			narratorId: newId,
			userId: owner.userId,
		});
		expect(dispatches).toHaveLength(2);
	});
	test("a rejected exact cancel cannot settle the successor epoch", async () => {
		const id = await target();
		const row = await task(id, { onBusy: "interrupt" });
		await runNow(row.id);
		const previous = await latest(row.id);
		const occupied = await busy(id);
		const registration = getRegisteredScheduledRun(id);
		if (!registration) throw new Error("missing registration");
		registration.logicalRunId = occupied.run.logicalRunId;
		registration.executionEpoch = occupied.execution.epoch;
		await db
			.update(scheduledTaskRuns)
			.set({ logicalRunId: occupied.run.logicalRunId })
			.where(eq(scheduledTaskRuns.id, previous.id));
		beforeCancel = () => {
			beforeCancel = undefined;
			occupied.execution.release();
			const next = tryClaimExecution(id, "run");
			if (!next) throw new Error("expected successor owner");
			executionOwners.push(next);
			setRunControl(next, { ...occupied.run, cancel: new AbortController() });
			registration.executionEpoch = next.epoch;
		};
		await runNow(row.id);
		expect(cancellations).toHaveLength(0);
		expect(
			(await db.query.scheduledTaskRuns.findFirst({ where: eq(scheduledTaskRuns.id, previous.id) }))
				?.status,
		).toBe("running");
		expect((await scheduledTaskService.get(row.id))?.activeRunId).toBe(previous.id);
		expect(await latest(row.id)).toMatchObject({ status: "skipped", errorKind: "busy" });
		expect(getRegisteredScheduledRun(id)).toBe(registration);
	});
	test("interrupting a scheduled child leaves its root and sibling untouched", async () => {
		const rootId = await target();
		const childId = await target();
		const siblingId = await target();
		const rootTask = await task(rootId);
		await runNow(rootTask.id);
		const rootRun = await latest(rootTask.id);
		const root = await busy(rootId);
		const child = await busy(childId);
		const sibling = await busy(siblingId);
		const registration = getRegisteredScheduledRun(rootId);
		if (!registration) throw new Error("missing root registration");
		registration.logicalRunId = root.run.logicalRunId;
		registration.executionEpoch = root.execution.epoch;
		for (const [id, execution] of [
			[childId, child],
			[siblingId, sibling],
		] as const) {
			bindScheduledRunMember({
				runId: rootRun.id,
				narratorId: id,
				logicalRunId: execution.run.logicalRunId as string,
				executionEpoch: execution.execution.epoch,
				parentNarratorId: rootId,
			});
		}
		const interrupt = await task(childId, { onBusy: "interrupt" });
		await runNow(interrupt.id);
		expect(cancellations).toEqual([childId]);
		expect(root.run.cancel.signal.aborted).toBe(false);
		expect(sibling.run.cancel.signal.aborted).toBe(false);
		expect((await latest(rootTask.id)).status).toBe("running");
		child.execution.release();
		await advanceScheduledTaskRun((await latest(interrupt.id)).id);
		expect((await latest(interrupt.id)).status).toBe("running");
	});
	test("same-task active execution is interrupted with scheduled_interrupt", async () => {
		const id = await target();
		const row = await task(id, { onBusy: "interrupt" });
		await runNow(row.id);
		const previous = await latest(row.id);
		const occupied = await busy(id);
		const registration = getRegisteredScheduledRun(id);
		if (!registration) throw new Error("missing registration");
		registration.logicalRunId = occupied.run.logicalRunId;
		registration.executionEpoch = occupied.execution.epoch;
		await db
			.update(scheduledTaskRuns)
			.set({ logicalRunId: occupied.run.logicalRunId })
			.where(eq(scheduledTaskRuns.id, previous.id));
		await runNow(row.id);
		expect(
			(await db.query.scheduledTaskRuns.findFirst({ where: eq(scheduledTaskRuns.id, previous.id) }))
				?.errorKind,
		).toBe("scheduled_interrupt");
		expect((await latest(row.id)).status).toBe("waiting");
		expect(occupied.run.timedOut).toBe(false);
		occupied.execution.release();
		await advanceScheduledTaskRun((await latest(row.id)).id);
		expect(dispatches).toHaveLength(2);
	});
});
