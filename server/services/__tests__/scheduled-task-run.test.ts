import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ScheduledRunInterruptTarget } from "@shared/scheduled-task-status";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import { narrators, scheduledTaskRuns, scheduledTasks } from "../../db/schema";
import type { RunControl, RunResult } from "../agent-runtime/ownership";
import {
	bindScheduledRunMember,
	getRegisteredScheduledRun,
	getScheduledRunById,
	getScheduledRunMember,
	listRegisteredScheduledRuns,
	recordScheduledRunTerminal,
	registerScheduledRun,
	rotateScheduledRunExecutionEpoch,
	type ScheduledRunRegistration,
	scheduledRunModelOverride,
	unregisterScheduledRun,
} from "../scheduled-run-registry";

const { db, sqlite } = getTestDb();
const controls = new Map<string, RunControl>();
const executionEpochs = new Map<string, string>();
const reconciledTasks: string[] = [];
const cancellations: ScheduledRunInterruptTarget[] = [];
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
	getExecutionOwner: (id: string) => {
		const epoch = executionEpochs.get(id);
		return epoch ? { epoch } : undefined;
	},
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
	scheduledTaskService: {
		reconcileCompletion: async (taskId: string) => {
			reconciledTasks.push(taskId);
		},
	},
}));
mock.module("../scheduled-task-waiting", () => ({ pollScheduledWaitingRuns: async () => {} }));
mock.module("../narrator-session", () => ({
	cancelScheduledRunTarget: async (target: ScheduledRunInterruptTarget, reason: string) => {
		const current = controls.get(target.narratorId);
		if (
			!current ||
			current.logicalRunId !== target.logicalRunId ||
			(target.executionEpoch !== undefined &&
				executionEpochs.get(target.narratorId) !== target.executionEpoch)
		)
			return false;
		cancellations.push(target);
		current.cancel.abort(reason);
		current.wake?.("cancel");
		return true;
	},
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
	cancelScheduledTaskWaitingRuns,
	claimScheduledRunNudge,
	finalizeScheduledRun,
	lookupScheduledRun,
	markScheduledRunBlocked,
	notifyScheduledRunAdmissionFailure,
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
		requireReport: registration.requireReport,
		startedAt: now,
		createdAt: now,
	});
	bindScheduledRunMember({
		runId,
		narratorId,
		logicalRunId,
		executionEpoch: registration.executionEpoch,
	});
	if (registration.executionEpoch) executionEpochs.set(narratorId, registration.executionEpoch);
	controls.set(narratorId, control(logicalRunId));
	return registration;
}

async function seedWaiting() {
	const run = await seed();
	unregisterScheduledRun(run.runId);
	controls.delete(run.narratorId);
	await db
		.update(scheduledTaskRuns)
		.set({
			status: "waiting",
			logicalRunId: null,
			startedAt: null,
			deadlineAt: null,
			busyDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
		})
		.where(eq(scheduledTaskRuns.id, run.runId));
	await db
		.update(scheduledTasks)
		.set({ activeRunId: null, lastStatus: "waiting" })
		.where(eq(scheduledTasks.id, run.taskId));
	return run;
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
			executionEpoch: registration.executionEpoch,
			status,
			settledAt: Date.now() - 3000,
		}),
	).toBe(true);
}

afterEach(async () => {
	await pollScheduledRuns();
	for (const run of listRegisteredScheduledRuns()) unregisterScheduledRun(run.runId);
	controls.clear();
	executionEpochs.clear();
	reconciledTasks.length = 0;
	cancellations.length = 0;
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

	test("a late terminal callback cannot settle a replacement execution with the same logical id", async () => {
		const run = await seed({ executionEpoch: "epoch-old", requireReport: false });
		if (!run.logicalRunId) throw new Error("Expected a logical run");
		const oldTerminal = Promise.withResolvers<RunResult>();
		const oldControl = { ...control(run.logicalRunId), terminal: oldTerminal.promise };
		controls.set(run.narratorId, oldControl);
		await attachScheduledRuntimeRun({ narratorId: run.narratorId, run: oldControl });
		const newTerminal = Promise.withResolvers<RunResult>();
		const newControl = { ...control(run.logicalRunId), terminal: newTerminal.promise };
		controls.set(run.narratorId, newControl);
		executionEpochs.set(run.narratorId, "epoch-new");
		expect(await lookupScheduledRun(run.narratorId)).toBeUndefined();
		await attachScheduledRuntimeRun({ narratorId: run.narratorId, run: newControl });
		expect(getScheduledRunMember(run.narratorId)?.executionEpoch).toBe("epoch-new");
		expect((await lookupScheduledRun(run.narratorId))?.requireReport).toBe(false);
		const result: RunResult = {
			started: true,
			output: "",
			finalText: "",
			hasError: false,
			interrupted: false,
			timedOut: false,
		};
		oldTerminal.resolve({ ...result, hasError: true });
		await oldTerminal.promise;
		await pollScheduledRuns();
		expect(run.terminal).toBeUndefined();
		expect((await runRow(run.runId))?.status).toBe("running");
		expect(
			await finalizeScheduledRun(run.runId, "failed", {
				expectedLogicalRunId: run.logicalRunId,
				expectedExecutionEpoch: "epoch-old",
			}),
		).toBe(false);
		controls.delete(run.narratorId);
		newTerminal.resolve(result);
		await newTerminal.promise;
		await pollScheduledRuns();
		if (!run.terminal) throw new Error("Expected the replacement terminal receipt");
		run.terminal.settledAt = Date.now() - 3000;
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.status).toBe("completed");
	});

	test("a fresh pass keeps membership and terminal delivery through an epoch rotation", async () => {
		const run = await seed({ executionEpoch: "first-pass", requireReport: false });
		if (!run.logicalRunId) throw new Error("Expected a logical run");
		const terminal = Promise.withResolvers<RunResult>();
		const active = { ...control(run.logicalRunId), terminal: terminal.promise };
		controls.set(run.narratorId, active);
		await attachScheduledRuntimeRun({ narratorId: run.narratorId, run: active });
		const member = getScheduledRunMember(run.narratorId);
		const turns = run.turns;
		executionEpochs.set(run.narratorId, "fresh-pass");
		expect(
			rotateScheduledRunExecutionEpoch({
				narratorId: run.narratorId,
				logicalRunId: run.logicalRunId,
				previousEpoch: "first-pass",
				executionEpoch: "fresh-pass",
			}),
		).toBe(true);
		expect(getScheduledRunMember(run.narratorId)).toBe(member);
		expect(member?.executionEpoch).toBe("fresh-pass");
		expect(run.executionEpoch).toBe("fresh-pass");
		expect(run.turns).toBe(turns);
		expect(await lookupScheduledRun(run.narratorId)).toBe(run);
		await reportScheduledRun(run.narratorId, {
			outcome: "done",
			summary: "Continued work finished",
		});
		controls.delete(run.narratorId);
		terminal.resolve({
			started: true,
			output: "",
			finalText: "",
			hasError: false,
			interrupted: false,
			timedOut: false,
		});
		await terminal.promise;
		await pollScheduledRuns();
		expect(run.terminal?.executionEpoch).toBe("fresh-pass");
		if (!run.terminal) throw new Error("Expected the rotated execution's terminal receipt");
		run.terminal.settledAt = Date.now() - 3000;
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.status).toBe("completed");
	});

	test("epoch rotation rejects stale identity and preserves terminal receipts and turn counts", async () => {
		const run = await seed({ executionEpoch: "current-epoch" });
		if (!run.logicalRunId) throw new Error("Expected a logical run");
		const member = getScheduledRunMember(run.narratorId);
		const turns = run.turns;
		const terminal = {
			logicalRunId: run.logicalRunId,
			executionEpoch: "current-epoch",
			status: "completed" as const,
			settledAt: Date.now(),
		};
		run.terminal = terminal;
		const input = {
			narratorId: run.narratorId,
			logicalRunId: run.logicalRunId,
			previousEpoch: "current-epoch",
			executionEpoch: "next-epoch",
		};
		expect(rotateScheduledRunExecutionEpoch({ ...input, logicalRunId: "another-run" })).toBe(false);
		expect(rotateScheduledRunExecutionEpoch({ ...input, previousEpoch: "stale-epoch" })).toBe(
			false,
		);
		run.executionEpoch = "replaced-root";
		expect(rotateScheduledRunExecutionEpoch(input)).toBe(false);
		expect(member?.executionEpoch).toBe("current-epoch");
		run.executionEpoch = "current-epoch";
		expect(rotateScheduledRunExecutionEpoch(input)).toBe(true);
		expect(rotateScheduledRunExecutionEpoch(input)).toBe(false);
		expect(run.terminal).toBe(terminal);
		expect(run.turns).toBe(turns);
	});

	test("a child epoch rotation preserves the parent execution identity", async () => {
		const run = await seed({ executionEpoch: "parent-epoch" });
		const child = `${run.narratorId}-rotating-child`;
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: child,
			parentNarratorId: run.narratorId,
			createdAt: now,
			updatedAt: now,
		});
		const childControl = control("child-logical");
		childControl.deliverTo = {
			narratorId: run.narratorId,
			toolCallId: "child-call",
			toolUseId: "child-use",
		};
		controls.set(child, childControl);
		executionEpochs.set(child, "child-original");
		await attachScheduledRuntimeRun({ narratorId: child, run: childControl });
		const turns = run.turns;
		executionEpochs.set(child, "child-next");
		expect(
			rotateScheduledRunExecutionEpoch({
				narratorId: child,
				logicalRunId: "child-logical",
				previousEpoch: "child-original",
				executionEpoch: "child-next",
			}),
		).toBe(true);
		expect(getScheduledRunMember(child)?.executionEpoch).toBe("child-next");
		expect(run.executionEpoch).toBe("parent-epoch");
		expect(run.turns).toBe(turns);
		expect(await lookupScheduledRun(child)).toBe(run);
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

	test("optional reporting completes without a nudge even if the task now requires reports", async () => {
		const run = await seed({ requireReport: false });
		await db
			.update(scheduledTasks)
			.set({ requireReport: true })
			.where(eq(scheduledTasks.id, run.taskId));
		expect(await claimScheduledRunNudge(run.runId)).toBe(false);
		settled(run);
		await pollScheduledRuns();
		expect(await runRow(run.runId)).toMatchObject({
			status: "completed",
			requireReport: false,
			nudged: false,
			outcome: null,
		});
		expect(reminders).toHaveLength(0);
	});

	test("optional reporting still records volunteered reports and preserves their verdict", async () => {
		const run = await seed({ requireReport: false });
		await reportScheduledRun(run.narratorId, { outcome: "partial", summary: "Some work remains" });
		settled(run);
		await pollScheduledRuns();
		expect(await runRow(run.runId)).toMatchObject({
			status: "completed",
			outcome: "partial",
			outcomeSummary: "Some work remains",
			nudged: false,
		});
		expect((await taskRow(run.taskId))?.lastOutcome).toBe("partial");
		expect(reminders).toHaveLength(0);
	});

	test("a required report remains required when task edits disable future reports", async () => {
		const run = await seed();
		expect(run.requireReport).toBe(true);
		await db
			.update(scheduledTasks)
			.set({ requireReport: false })
			.where(eq(scheduledTasks.id, run.taskId));
		settled(run);
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.nudged).toBe(true);
		expect(reminders).toHaveLength(1);
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

	test("scheduled takeover keeps its attribution when the terminal callback settles first", async () => {
		const run = await seed({ executionEpoch: "interrupted-epoch" });
		if (!run.logicalRunId) throw new Error("Expected a logical run");
		const terminal = Promise.withResolvers<RunResult>();
		const active = { ...control(run.logicalRunId), terminal: terminal.promise };
		controls.set(run.narratorId, active);
		await attachScheduledRuntimeRun({ narratorId: run.narratorId, run: active });
		run.interruptionReason = "scheduled_interrupt";
		active.cancel.abort("scheduled_interrupt");
		controls.delete(run.narratorId);
		terminal.resolve({
			started: true,
			output: "",
			finalText: "",
			hasError: false,
			interrupted: true,
			timedOut: false,
		});
		await terminal.promise;
		await pollScheduledRuns();
		expect(await runRow(run.runId)).toMatchObject({
			status: "interrupted",
			errorKind: "scheduled_interrupt",
		});
		expect(
			await finalizeScheduledRun(run.runId, "interrupted", { errorKind: "scheduled_interrupt" }),
		).toBe(false);
		expect(active.timedOut).toBe(false);
		expect((await taskRow(run.taskId))?.consecutiveFailures).toBe(0);
		expect(reminders).toHaveLength(0);
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

describe("accepted waiting run ledger", () => {
	test("waiting contention cannot report or nudge and never increments failure accounting", async () => {
		for (const status of ["skipped", "failed", "interrupted", "timed_out"] as const) {
			const run = await seedWaiting();
			await db
				.update(scheduledTasks)
				.set({ consecutiveFailures: 4 })
				.where(eq(scheduledTasks.id, run.taskId));
			expect(await claimScheduledRunNudge(run.runId)).toBe(false);
			await expect(
				reportScheduledRun(run.narratorId, { outcome: "done", summary: "not dispatched" }),
			).rejects.toThrow();
			expect(await finalizeScheduledRun(run.runId, "completed")).toBe(false);
			expect(await finalizeScheduledRun(run.runId, status, { errorKind: "busy_timeout" })).toBe(
				true,
			);
			expect(await runRow(run.runId)).toMatchObject({ status, durationMs: null, startedAt: null });
			expect(await taskRow(run.taskId)).toMatchObject({
				consecutiveFailures: 4,
				enabled: true,
				lastStatus: status,
			});
		}
		expect(notices.filter((notice) => notice.kind === "circuit_breaker")).toHaveLength(0);
		expect(reminders).toHaveLength(0);
	});

	test("waiting ACL and missing-target failures count once and publish circuit-breaker notices", async () => {
		for (const errorKind of ["acl", "target_missing"] as const) {
			const run = await seedWaiting();
			await db
				.update(scheduledTasks)
				.set({
					consecutiveFailures: 4,
					activeRunId: "another-running-occurrence",
					nextRunAt: new Date(Date.now() + 60_000).toISOString(),
				})
				.where(eq(scheduledTasks.id, run.taskId));
			const results = await Promise.all(
				Array.from({ length: 2 }, () =>
					finalizeScheduledRun(run.runId, "failed", { errorKind, expectedStatus: "waiting" }),
				),
			);
			expect(results.filter(Boolean)).toHaveLength(1);
			expect(await runRow(run.runId)).toMatchObject({
				status: "failed",
				errorKind,
				startedAt: null,
				durationMs: null,
			});
			expect(await taskRow(run.taskId)).toMatchObject({
				consecutiveFailures: 5,
				enabled: false,
				pauseReason: "circuit_breaker",
				nextRunAt: null,
				activeRunId: "another-running-occurrence",
			});
			expect(notices.filter((notice) => notice.runId === run.runId)).toEqual([
				{ runId: run.runId, kind: "failed" },
				{ runId: run.runId, kind: "circuit_breaker" },
			]);
		}
		expect(reminders).toHaveLength(0);
	});

	test("admission failure notifications include a circuit breaker only when requested", async () => {
		await notifyScheduledRunAdmissionFailure("admission-failed");
		await notifyScheduledRunAdmissionFailure("admission-paused", true);
		expect(notices).toEqual([
			{ runId: "admission-failed", kind: "failed" },
			{ runId: "admission-paused", kind: "failed" },
			{ runId: "admission-paused", kind: "circuit_breaker" },
		]);
	});

	test("cancelling waiting work updates its summary once and leaves another active run alone", async () => {
		const run = await seedWaiting();
		await db
			.update(scheduledTasks)
			.set({ activeRunId: "another-running-occurrence", firedCount: 1 })
			.where(eq(scheduledTasks.id, run.taskId));
		expect(await cancelScheduledTaskWaitingRuns(run.taskId, "Task paused")).toBe(1);
		expect(await cancelScheduledTaskWaitingRuns(run.taskId, "Repeated pause")).toBe(0);
		expect(await runRow(run.runId)).toMatchObject({
			status: "skipped",
			errorKind: "cancelled",
			outcomeSummary: "Task paused",
		});
		expect(await taskRow(run.taskId)).toMatchObject({
			activeRunId: "another-running-occurrence",
			firedCount: 1,
			lastRunId: run.runId,
			lastStatus: "skipped",
			lastSummary: "Task paused",
		});
	});

	test("a dispatch between the waiting lookup and settlement defeats cancellation", async () => {
		const run = await seedWaiting();
		const originalTransaction = db.transaction.bind(db);
		const transaction = spyOn(db, "transaction").mockImplementationOnce((callback, config) => {
			db.update(scheduledTaskRuns)
				.set({ status: "running", startedAt: new Date().toISOString() })
				.where(eq(scheduledTaskRuns.id, run.runId))
				.run();
			db.update(scheduledTasks)
				.set({ activeRunId: run.runId, lastStatus: "running" })
				.where(eq(scheduledTasks.id, run.taskId))
				.run();
			return originalTransaction(callback, config);
		});
		try {
			expect(await cancelScheduledTaskWaitingRuns(run.taskId, "Target changed")).toBe(0);
			expect(transaction).toHaveBeenCalledTimes(1);
		} finally {
			transaction.mockRestore();
		}
		expect((await runRow(run.runId))?.status).toBe("running");
		expect((await taskRow(run.taskId))?.activeRunId).toBe(run.runId);
		expect(reconciledTasks).toHaveLength(0);
	});

	test("waiting cancellation does not overwrite a newer last-run projection", async () => {
		const run = await seedWaiting();
		await db
			.update(scheduledTasks)
			.set({ lastRunId: "newer-run", lastStatus: "running", lastSummary: "Newer result" })
			.where(eq(scheduledTasks.id, run.taskId));
		expect(await cancelScheduledTaskWaitingRuns(run.taskId, "Owner changed")).toBe(1);
		expect(await taskRow(run.taskId)).toMatchObject({
			lastRunId: "newer-run",
			lastStatus: "running",
			lastSummary: "Newer result",
		});
	});

	test("another waiting occurrence prevents a settled task from being marked complete", async () => {
		const run = await seed();
		await db.insert(scheduledTaskRuns).values({
			id: `${run.runId}-waiting`,
			taskId: run.taskId,
			status: "waiting",
			runContext: "standalone",
			createdAt: new Date().toISOString(),
		});
		expect(await finalizeScheduledRun(run.runId, "completed")).toBe(true);
		expect(reconciledTasks).toHaveLength(0);
		expect((await taskRow(run.taskId))?.completedAt).toBeNull();
		expect(await cancelScheduledTaskWaitingRuns(run.taskId, "Cancelled remaining wait")).toBe(1);
		expect(reconciledTasks).toEqual([run.taskId]);
	});

	test("a failed waiting occurrence does not fence an unstarted target conversation", async () => {
		const run = await seedWaiting();
		await db.update(narrators).set({ logicalRunId: null }).where(eq(narrators.id, run.narratorId));
		expect(
			await finalizeScheduledRun(run.runId, "failed", {
				errorKind: "acl",
				expectedStatus: "waiting",
			}),
		).toBe(true);
		expect(await filterScheduledRecoveryNarrators([run.narratorId])).toEqual(
			new Set([run.narratorId]),
		);
	});

	test("recovery leaves waiting work and its unrelated target conversation untouched", async () => {
		const run = await seedWaiting();
		const existing = control("existing-user-execution");
		controls.set(run.narratorId, existing);
		expect(await recoverScheduledRuns()).toEqual(new Set());
		expect(getRegisteredScheduledRun(run.narratorId)).toBeUndefined();
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.status).toBe("waiting");
		expect(existing.cancel.signal.aborted).toBe(false);
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

	test("timeout preserves a replacement epoch even when it kept the same logical id", async () => {
		const run = await seed({
			executionEpoch: "old-execution",
			deadlineAt: new Date(Date.now() - 1).toISOString(),
		});
		if (!run.logicalRunId) throw new Error("Expected a logical run");
		const replacement = control(run.logicalRunId);
		controls.set(run.narratorId, replacement);
		executionEpochs.set(run.narratorId, "replacement-execution");
		await pollScheduledRuns();
		expect(replacement.cancel.signal.aborted).toBe(false);
		expect(replacement.timedOut).toBe(false);
		expect(cancellations).toHaveLength(0);
		expect((await runRow(run.runId))?.status).toBe("timed_out");
	});

	test("timeout delegates the captured epoch and wakes the exact held execution", async () => {
		const run = await seed({
			executionEpoch: "held-execution",
			deadlineAt: new Date(Date.now() - 1).toISOString(),
		});
		const active = controls.get(run.narratorId);
		if (!active) throw new Error("Expected a run control");
		const wake = mock();
		active.wake = wake;
		await pollScheduledRuns();
		expect(cancellations).toEqual([
			{
				narratorId: run.narratorId,
				logicalRunId: run.logicalRunId,
				executionEpoch: "held-execution",
				scheduledRunId: run.runId,
			},
		]);
		expect(wake).toHaveBeenCalledWith("cancel");
		expect(active.timedOut).toBe(true);
	});

	test("recovery keeps the accepted report snapshot after the task configuration changes", async () => {
		const run = await seed({ requireReport: false });
		controls.clear();
		unregisterScheduledRun(run.runId);
		await db
			.update(scheduledTasks)
			.set({ requireReport: true, contextPolicy: "clear" })
			.where(eq(scheduledTasks.id, run.taskId));
		await recoverScheduledRuns();
		const recovered = getRegisteredScheduledRun(run.narratorId);
		expect(recovered?.requireReport).toBe(false);
		expect(recovered?.contextPrepared).toBe(true);
		if (!recovered) throw new Error("Expected a recovered run");
		recovered.recoveredAt = Date.now() - 31_000;
		await pollScheduledRuns();
		expect((await runRow(run.runId))?.errorKind).toBe("restart");
		expect(reminders).toHaveLength(0);
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

	test("a newer epoch permission wait is not attributed through a reused logical id", async () => {
		const run = await seed({ onBlocked: "wait", executionEpoch: "prior-epoch" });
		executionEpochs.set(run.narratorId, "current-epoch");
		pendingPermissions.set("new-permission", { narratorId: run.narratorId, toolName: "Write" });
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
