import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import { narrators, scheduledTaskRuns, scheduledTasks } from "../../db/schema";
import type { RunControl } from "../agent-runtime/ownership";
import {
	bindScheduledRunMember,
	getRegisteredScheduledRun,
	getScheduledRunById,
	listRegisteredScheduledRuns,
	recordScheduledRunTerminal,
	registerScheduledRun,
	type ScheduledRunRegistration,
	scheduledRunModelOverride,
	unregisterScheduledRun,
} from "../scheduled-run-registry";

const { db, sqlite } = getTestDb();
const controls = new Map<string, RunControl>();
const pendingPermissions = new Map<string, { narratorId: string; toolName: string }>();
const pendingDangerReflections = new Map();
const inboxes = new Set<string>();
const notices: Array<{ runId: string; kind: string }> = [];
const reminders: Array<{ runId: string; narratorId: string; nudge?: boolean; prompt: string }> = [];
let activeWakeWork = 0;
let failReminder = false;
let sequence = 0;

mock.module("../../db", () => ({ db, sqlite }));
mock.module("../agent-runtime/ownership", () => ({
	getRunControl: (id: string) => controls.get(id),
}));
mock.module("../narrator-service", () => ({
	narratorService: {
		getById: (id: string) => db.query.narrators.findFirst({ where: eq(narrators.id, id) }),
	},
}));
mock.module("../narrator-session-state", () => ({ pendingPermissions, pendingDangerReflections }));
mock.module("../background-occupancy-store", () => ({
	backgroundOccupancyStore: {
		flush: async () => {},
		countActiveWakeWork: () => activeWakeWork,
	},
}));
mock.module("../agent-runtime/inbox", () => ({
	flushInboxPublicationBarrier: async () => {},
	peekInbox: async (id: string) => (inboxes.has(id) ? { id: "queued" } : undefined),
}));
mock.module("../scheduled-task-service", () => ({
	scheduledTaskService: { reconcileCompletion: async () => {} },
}));
mock.module("../narrator-session", () => ({
	sendScheduledTaskMessage: async (input: (typeof reminders)[number]) => {
		reminders.push(input);
		if (failReminder) throw new Error("simulated dispatch failure after nudge reservation");
		const registration = getScheduledRunById(input.runId);
		if (registration) registration.reportOnly = true;
	},
}));

const {
	attachScheduledRuntimeRun,
	bindScheduledRunTrigger,
	claimScheduledRunNudge,
	finalizeScheduledRun,
	lookupScheduledRun,
	markScheduledRunBlocked,
	recordScheduledAutoHandled,
	reportScheduledRun,
	scheduledTerminalStatus,
	setScheduledRunNotifier,
} = await import("../scheduled-task-run-service");
const {
	filterScheduledRecoveryNarrators,
	pollScheduledRuns,
	recoverScheduledRuns,
	scheduledRunDeadlineReason,
} = await import("../scheduled-task-run-tracker");
setScheduledRunNotifier(async (runId, kind) => {
	notices.push({ runId, kind });
});

function control(logicalRunId: string): RunControl {
	return {
		logicalRunId,
		startedAt: Date.now(),
		cancel: new AbortController(),
		timedOut: false,
		terminal: new Promise(() => {}),
	};
}

async function seed(overrides: Partial<ScheduledRunRegistration> = {}) {
	const index = ++sequence;
	const taskId = `task-${index}`;
	const runId = `run-${index}`;
	const narratorId = `narrator-${index}`;
	const logicalRunId = `logical-${index}`;
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: narratorId,
		logicalRunId,
		status: "idle",
		model: "saved:model",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(scheduledTasks).values({
		id: taskId,
		name: "run test",
		cronExpr: "0 9 * * *",
		prompt: "do business work once",
		lastRunId: runId,
		activeRunId: runId,
		lastStatus: "running",
		createdAt: now,
		updatedAt: now,
	});
	const registration = registerScheduledRun({
		runId,
		taskId,
		narratorId,
		logicalRunId,
		ownerUserId: null,
		onBlocked: "auto",
		blockedWaitMinutes: 30,
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		permissionMode: "default",
		modelPolicy: "temporary",
		model: "task:model",
		...overrides,
	});
	await db.insert(scheduledTaskRuns).values({
		id: runId,
		taskId,
		narratorId,
		logicalRunId,
		status: "running",
		runContext: "standalone",
		deadlineAt: registration.deadlineAt,
		startedAt: now,
		createdAt: now,
	});
	bindScheduledRunMember({ runId, narratorId, logicalRunId });
	controls.set(narratorId, control(logicalRunId));
	return registration;
}

function runRow(id: string) {
	return db.query.scheduledTaskRuns.findFirst({ where: eq(scheduledTaskRuns.id, id) });
}
function taskRow(id: string) {
	return db.query.scheduledTasks.findFirst({ where: eq(scheduledTasks.id, id) });
}
function settled(
	registration: ScheduledRunRegistration,
	status: "completed" | "failed" = "completed",
) {
	if (!registration.logicalRunId) throw new Error("Expected a bound logical run");
	controls.delete(registration.narratorId);
	expect(
		recordScheduledRunTerminal(registration.runId, registration.narratorId, {
			logicalRunId: registration.logicalRunId,
			status,
			settledAt: Date.now() - 3000,
		}),
	).toBe(true);
}

afterEach(async () => {
	await pollScheduledRuns();
	for (const run of listRegisteredScheduledRuns()) unregisterScheduledRun(run.runId);
	controls.clear();
	pendingPermissions.clear();
	pendingDangerReflections.clear();
	inboxes.clear();
	notices.length = 0;
	reminders.length = 0;
	activeWakeWork = 0;
	failReminder = false;
	await db.delete(scheduledTaskRuns);
	await db.delete(scheduledTasks);
	await db.delete(narrators);
});
afterAll(() => sqlite.close());

describe("scheduled run identity and reporting", () => {
	test("temporary model is runtime-only and preserves a concurrent saved preference", async () => {
		const run = await seed();
		expect(scheduledRunModelOverride(run.narratorId, run.logicalRunId)).toBe("task:model");
		expect(scheduledRunModelOverride(run.narratorId, "unrelated-run")).toBeUndefined();
		await db
			.update(narrators)
			.set({ model: "person:new-model" })
			.where(eq(narrators.id, run.narratorId));
		expect(scheduledRunModelOverride(run.narratorId, run.logicalRunId)).toBe("task:model");
		run.model = null;
		expect(scheduledRunModelOverride(run.narratorId, run.logicalRunId)).toBe("__default__");
		await finalizeScheduledRun(run.runId, "interrupted");
		expect(scheduledRunModelOverride(run.narratorId)).toBeUndefined();
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, run.narratorId) }))?.model,
		).toBe("person:new-model");
	});

	test("follow and sync have no temporary runtime overlay", async () => {
		for (const modelPolicy of ["follow", "sync"] as const) {
			const run = await seed({ modelPolicy });
			expect(scheduledRunModelOverride(run.narratorId)).toBeUndefined();
		}
	});
	test("dispatch persistence and idle narrator are not evidence of completion", async () => {
		const run = await seed();
		await bindScheduledRunTrigger(run.runId, run.narratorId, "trigger-message");
		controls.clear();
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.status).toBe("running");
		expect(reminders).toHaveLength(0);
		await expect(bindScheduledRunTrigger(run.runId, run.narratorId, "duplicate")).rejects.toThrow();
	});

	test("trusted question-answer continuation stays associated, but a new person turn does not", async () => {
		const run = await seed({ onBlocked: "wait" });
		const answerRun = control("question-answer-run");
		controls.set(run.narratorId, answerRun);
		await attachScheduledRuntimeRun({
			narratorId: run.narratorId,
			run: answerRun,
			initiatedBy: "person",
			scheduledRunId: run.runId,
		});
		expect((await runRow(run.runId))?.logicalRunId).toBe("question-answer-run");
		expect((await lookupScheduledRun(run.narratorId))?.runId).toBe(run.runId);
		const personRun = control("new-chat-run");
		controls.set(run.narratorId, personRun);
		await attachScheduledRuntimeRun({
			narratorId: run.narratorId,
			run: personRun,
			initiatedBy: "person",
		});
		expect((await runRow(run.runId))?.status).toBe("interrupted");
		expect(scheduledRunModelOverride(run.narratorId)).toBeUndefined();
	});

	test("reports are advisory, overwrite while active, and reject missing exact ownership", async () => {
		const run = await seed();
		await reportScheduledRun(run.narratorId, { outcome: "done", summary: "finished work" });
		expect((await runRow(run.runId))?.status).toBe("running");
		expect((await taskRow(run.taskId))?.lastOutcome).toBe("done");
		await reportScheduledRun(run.narratorId, { outcome: "no_change" });
		expect((await runRow(run.runId))?.outcomeSummary).toBeNull();
		controls.set(run.narratorId, control("a-persons-next-run"));
		await expect(
			reportScheduledRun(run.narratorId, { outcome: "done", summary: "stale" }),
		).rejects.toThrow();
		expect((await runRow(run.runId))?.outcome).toBe("no_change");
	});

	test("a child needs real ancestry and the live delivery relationship, not a forged trait", async () => {
		const run = await seed();
		const now = new Date().toISOString();
		const child = `${run.narratorId}-child`;
		await db.insert(narrators).values({
			id: child,
			parentNarratorId: run.narratorId,
			traits: ["scheduled"],
			createdAt: now,
			updatedAt: now,
		});
		const childRun = control("child-logical");
		controls.set(child, childRun);
		await attachScheduledRuntimeRun({ narratorId: child, run: childRun });
		expect(await lookupScheduledRun(child)).toBeUndefined();
		childRun.deliverTo = {
			narratorId: run.narratorId,
			toolCallId: "parent-call",
			toolUseId: "parent-use",
		};
		await attachScheduledRuntimeRun({ narratorId: child, run: childRun });
		expect((await lookupScheduledRun(child))?.runId).toBe(run.runId);
		await reportScheduledRun(child, { outcome: "partial", summary: "child work" });
		await db.update(narrators).set({ parentNarratorId: null }).where(eq(narrators.id, child));
		expect(await lookupScheduledRun(child)).toBeUndefined();
	});

	test("old terminal receipts and finalizers cannot settle a later logical run", async () => {
		const run = await seed();
		const oldLogicalRunId = run.logicalRunId;
		if (!oldLogicalRunId) throw new Error("Expected a bound logical run");
		bindScheduledRunMember({
			runId: run.runId,
			narratorId: run.narratorId,
			logicalRunId: "new-logical",
		});
		await db
			.update(scheduledTaskRuns)
			.set({ logicalRunId: "new-logical" })
			.where(eq(scheduledTaskRuns.id, run.runId));
		expect(
			recordScheduledRunTerminal(run.runId, run.narratorId, {
				logicalRunId: oldLogicalRunId,
				status: "completed",
				settledAt: Date.now(),
			}),
		).toBe(false);
		expect(
			await finalizeScheduledRun(run.runId, "failed", { expectedLogicalRunId: oldLogicalRunId }),
		).toBe(false);
		expect((await runRow(run.runId))?.status).toBe("running");
	});

	test("terminal CAS prevents late report and duplicate failure accounting", async () => {
		const run = await seed();
		expect(await finalizeScheduledRun(run.runId, "failed", { errorKind: "provider" })).toBe(true);
		expect(await finalizeScheduledRun(run.runId, "completed")).toBe(false);
		await expect(
			reportScheduledRun(run.narratorId, { outcome: "done", summary: "late" }),
		).rejects.toThrow();
		expect((await taskRow(run.taskId))?.consecutiveFailures).toBe(1);
		expect((await runRow(run.runId))?.status).toBe("failed");
	});

	test("latest skipped projection does not lose actual-run failure or clear another admission", async () => {
		const run = await seed();
		const oldUpdatedAt = new Date(Date.now() + 60_000).toISOString();
		await db
			.update(scheduledTasks)
			.set({
				lastRunId: "later-skip",
				lastStatus: "skipped",
				activeRunId: "other-run",
				consecutiveFailures: 4,
				updatedAt: oldUpdatedAt,
				nextRunAt: oldUpdatedAt,
			})
			.where(eq(scheduledTasks.id, run.taskId));
		await finalizeScheduledRun(run.runId, "failed");
		const task = await taskRow(run.taskId);
		expect(task?.lastStatus).toBe("skipped");
		expect(task?.activeRunId).toBe("other-run");
		expect(task?.consecutiveFailures).toBe(5);
		expect(task?.enabled).toBe(false);
		expect(task?.pauseReason).toBe("circuit_breaker");
		expect(task?.nextRunAt).toBeNull();
		expect(task?.updatedAt).toBe(new Date(Date.parse(oldUpdatedAt) + 1).toISOString());
		expect(notices.filter((notice) => notice.kind === "circuit_breaker")).toHaveLength(1);
	});

	test("auto handling is bounded, concurrent-safe and immutable after terminal", async () => {
		const run = await seed();
		await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				recordScheduledAutoHandled(run.runId, "question", `question-${i}`),
			),
		);
		const handled = (await runRow(run.runId))?.autoHandled;
		expect(handled?.question).toBe(8);
		expect(handled?.notes).toHaveLength(5);
		await finalizeScheduledRun(run.runId, "interrupted");
		await recordScheduledAutoHandled(run.runId, "question", "too late");
		expect((await runRow(run.runId))?.autoHandled).toEqual(handled);
	});
});

describe("scheduled settlement and reporting reminder", () => {
	test("classification distinguishes unstarted, interrupted, timed-out and failed executions", () => {
		const ok = { started: true, timedOut: false, interrupted: false, hasError: false };
		expect(scheduledTerminalStatus(ok)).toBe("completed");
		expect(scheduledTerminalStatus({ ...ok, started: false })).toBe("failed");
		expect(scheduledTerminalStatus({ ...ok, hasError: true })).toBe("failed");
		expect(scheduledTerminalStatus({ ...ok, interrupted: true })).toBe("interrupted");
		expect(scheduledTerminalStatus({ ...ok, timedOut: true })).toBe("timed_out");
	});

	test("terminal success waits for background work and queued inbox before settling", async () => {
		const run = await seed();
		await reportScheduledRun(run.narratorId, { outcome: "done", summary: "done" });
		settled(run);
		activeWakeWork = 1;
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.status).toBe("running");
		activeWakeWork = 0;
		inboxes.add(run.narratorId);
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.status).toBe("running");
		inboxes.clear();
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.status).toBe("completed");
		expect((await taskRow(run.taskId))?.activeRunId).toBeNull();
		expect(reminders).toHaveLength(0);
	});

	test("the nudge has one durable reservation and only asks for reporting", async () => {
		const run = await seed();
		settled(run);
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.nudged).toBe(true);
		expect(reminders).toHaveLength(1);
		expect(reminders[0]?.nudge).toBe(true);
		expect(reminders[0]?.prompt).toContain("Do not redo");
		expect(getRegisteredScheduledRun(run.narratorId)?.reportOnly).toBe(true);
		await pollScheduledRuns();
		expect(reminders).toHaveLength(1);
		expect((await runRow(run.runId))?.outcome).toBeNull();
	});

	test("parallel reminder claims and dispatch failure never resend", async () => {
		const run = await seed();
		const claims = await Promise.all(
			Array.from({ length: 8 }, () => claimScheduledRunNudge(run.runId)),
		);
		expect(claims.filter(Boolean)).toHaveLength(1);
		await db
			.update(scheduledTaskRuns)
			.set({ nudged: false })
			.where(eq(scheduledTaskRuns.id, run.runId));
		failReminder = true;
		settled(run);
		await pollScheduledRuns();
		await pollScheduledRuns();
		expect(reminders).toHaveLength(1);
		expect((await runRow(run.runId))?.status).toBe("completed");
		expect((await runRow(run.runId))?.outcome).toBeNull();
	});

	test("a continuation still preparing its identity is not mistaken for idle", async () => {
		const run = await seed();
		await reportScheduledRun(run.narratorId, { outcome: "done", summary: "done" });
		settled(run);
		const preparing = control("preparing");
		preparing.logicalRunId = undefined;
		controls.set(run.narratorId, preparing);
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.status).toBe("running");
		controls.clear();
	});

	test("failure never sends a success reminder", async () => {
		const run = await seed();
		settled(run, "failed");
		// A stale provider-wait projection must not hide a verified failure receipt.
		await db
			.update(narrators)
			.set({ substatus: JSON.stringify(["quota_exhausted"]) })
			.where(eq(narrators.id, run.narratorId));
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.status).toBe("failed");
		expect(reminders).toHaveLength(0);
	});
});

describe("blocking, deadlines and crash recovery", () => {
	test("a wait-policy permission blocks durably and clears when the real wait ends", async () => {
		const run = await seed({ onBlocked: "wait" });
		pendingPermissions.set("permission", { narratorId: run.narratorId, toolName: "ExitPlanMode" });
		await pollScheduledRuns();
		const first = await runRow(run.runId);
		expect(first?.status).toBe("blocked");
		expect(first?.blockReason).toBe("plan");
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.blockedAt).toBe(first?.blockedAt);
		expect(notices.filter((notice) => notice.kind === "blocked")).toHaveLength(1);
		pendingPermissions.clear();
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.status).toBe("running");
		expect((await runRow(run.runId))?.blockedAt).toBeNull();
	});

	test("changing block reason preserves the original blocked-wait deadline", async () => {
		const run = await seed();
		await markScheduledRunBlocked(run.runId, "question");
		const started = (await runRow(run.runId))?.blockedAt;
		await markScheduledRunBlocked(run.runId, "permission");
		expect((await runRow(run.runId))?.blockedAt).toBe(started);
		const now = Date.now();
		expect(
			scheduledRunDeadlineReason(
				{
					deadlineAt: null,
					blockedAt: new Date(now - 60_000).toISOString(),
					blockedWaitMinutes: 1,
				},
				now,
			),
		).toBe("blocked_timeout");
		expect(
			scheduledRunDeadlineReason(
				{ deadlineAt: new Date(now).toISOString(), blockedAt: null, blockedWaitMinutes: 1 },
				now,
			),
		).toBe("timeout");
	});

	test("deadline cancellation never aborts a newer human run sharing the narrator", async () => {
		const run = await seed({ deadlineAt: new Date(Date.now() - 1).toISOString() });
		const newHumanRun = control("person-run");
		controls.set(run.narratorId, newHumanRun);
		await pollScheduledRuns();
		expect(newHumanRun.cancel.signal.aborted).toBe(false);
		expect((await runRow(run.runId))?.status).toBe("timed_out");
	});

	test("deadline cancellation reaches exactly the associated live run", async () => {
		const run = await seed({ deadlineAt: new Date(Date.now() - 1).toISOString() });
		const active = controls.get(run.narratorId);
		if (!active) throw new Error("Expected the current run control");
		await pollScheduledRuns();
		expect(active.cancel.signal.aborted).toBe(true);
		expect(active.timedOut).toBe(true);
	});

	test("cold restart never infers success or replays a possibly side-effecting request", async () => {
		const run = await seed();
		controls.clear();
		unregisterScheduledRun(run.runId);
		const excluded = await recoverScheduledRuns();
		expect(excluded.has(run.narratorId)).toBe(true);
		expect((await runRow(run.runId))?.status).toBe("running");
		const recovered = getRegisteredScheduledRun(run.narratorId);
		if (!recovered) throw new Error("Expected a recovered run registration");
		expect(recovered.deadlineAt).toBe(run.deadlineAt);
		recovered.recoveredAt = Date.now() - 31_000;
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.status).toBe("interrupted");
		expect((await runRow(run.runId))?.errorKind).toBe("restart");
		expect(reminders).toHaveLength(0);
	});

	test("a crash before runtime attachment still fences the persisted identity on later restarts", async () => {
		const run = await seed();
		controls.clear();
		unregisterScheduledRun(run.runId);
		await db
			.update(scheduledTaskRuns)
			.set({ logicalRunId: null })
			.where(eq(scheduledTaskRuns.id, run.runId));
		await recoverScheduledRuns();
		expect((await runRow(run.runId))?.logicalRunId).toBe(run.logicalRunId);
		const recovered = getRegisteredScheduledRun(run.narratorId);
		if (!recovered) throw new Error("Expected a recovered run registration");
		recovered.recoveredAt = Date.now() - 31_000;
		await pollScheduledRuns();
		expect(await filterScheduledRecoveryNarrators([run.narratorId])).toEqual(new Set());
	});

	test("a newly-created narrator without any logical identity remains fenced after recovery", async () => {
		const run = await seed();
		controls.clear();
		unregisterScheduledRun(run.runId);
		await db
			.update(scheduledTaskRuns)
			.set({ logicalRunId: null })
			.where(eq(scheduledTaskRuns.id, run.runId));
		await db.update(narrators).set({ logicalRunId: null }).where(eq(narrators.id, run.narratorId));
		await recoverScheduledRuns();
		await finalizeScheduledRun(run.runId, "interrupted", { errorKind: "restart" });
		expect(await filterScheduledRecoveryNarrators([run.narratorId])).toEqual(new Set());
	});

	test("timed-out runs also fence stale automatic recovery after later restarts", async () => {
		const run = await seed();
		await finalizeScheduledRun(run.runId, "timed_out", { errorKind: "timeout" });
		expect(await filterScheduledRecoveryNarrators([run.narratorId])).toEqual(new Set());
	});

	test("a person's newer permission wait is not attributed to the previous task run", async () => {
		const run = await seed({ onBlocked: "wait" });
		controls.set(run.narratorId, control("person-run"));
		pendingPermissions.set("person-permission", { narratorId: run.narratorId, toolName: "Write" });
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.status).toBe("running");
		expect(notices).toHaveLength(0);
	});

	test("restart fence includes descendants and survives a second server restart", async () => {
		const run = await seed();
		const now = new Date().toISOString();
		const child = `${run.narratorId}-child`;
		await db
			.insert(narrators)
			.values({ id: child, parentNarratorId: run.narratorId, createdAt: now, updatedAt: now });
		await finalizeScheduledRun(run.runId, "interrupted", { errorKind: "restart" });
		expect(await filterScheduledRecoveryNarrators([run.narratorId, child])).toEqual(new Set());
		await db
			.update(narrators)
			.set({ logicalRunId: "new-human-run" })
			.where(eq(narrators.id, run.narratorId));
		expect(await filterScheduledRecoveryNarrators([run.narratorId])).toEqual(
			new Set([run.narratorId]),
		);
	});
});
