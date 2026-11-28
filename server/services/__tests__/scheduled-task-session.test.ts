import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import {
	fileChangeExecutionSegments,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	scheduledTaskRuns,
	scheduledTasks,
	users,
} from "../../db/schema";
import type { PermissionResult } from "../../lib/agent";
import { DbReadError } from "../../lib/db-worker/errors";
import * as readPool from "../../lib/db-worker/pool";
import { settings } from "../../lib/settings";
import { createAgentMessageDelivery } from "../agent-message-delivery";
import * as inbox from "../agent-runtime/inbox";
import * as orchestrator from "../agent-runtime/orchestrator";
import {
	getExecutionOwner,
	getLastExecutionEpoch,
	getRunControl,
	type RunControl,
	type RunResult,
	setExecutionSuspended,
	setRunControl,
	setRunHold,
	tryClaimExecution,
} from "../agent-runtime/ownership";
import * as runtime from "../agent-runtime/run";
import * as buffer from "../narrator-buffer";
import { handlePermission } from "../narrator-permission";
import { closePrefixSnapshotStore } from "../narrator-prefix-snapshots";
import { narratorService } from "../narrator-service";
import * as sessionModule from "../narrator-session";
import {
	cancelScheduledRunTarget,
	captureScheduledInterruptTarget,
	isScheduledInterruptTargetCurrent,
	prepareScheduledTaskSession,
	sendScheduledTaskMessage,
} from "../narrator-session";
import {
	type ActiveNarrator,
	activeNarrators,
	pendingDangerReflections,
	pendingPermissions,
	withNarratorStartAdmission,
} from "../narrator-session-state";
import {
	bindScheduledRunMember,
	getRegisteredScheduledRun,
	getScheduledRunMember,
	listRegisteredScheduledRuns,
	registerScheduledRun,
	type ScheduledRunRegistration,
	unregisterScheduledRun,
} from "../scheduled-run-registry";
import * as runService from "../scheduled-task-run-service";
import * as runTracker from "../scheduled-task-run-tracker";
import * as scheduledTarget from "../scheduled-task-target";
import { captureWorkerRejection, captureWorkerRejectionThrower } from "./narrator-worker-fixture";

// Session preparation uses the real isolated DB, history writer, ACL and admissions.
const { db, sqlite } = await import("../../db");
const TARGET = "scheduled-session-target";
const OWNER = "scheduled-session-owner";
const OTHER = "scheduled-session-other";
const ids = new Set<string>();
const completions: Array<() => void> = [];

beforeEach(async () => {
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	settings.agent.autoContinuationMode = "off";
	const now = new Date().toISOString();
	for (const id of [OWNER, OTHER])
		await db.insert(users).values({ id, username: id, passwordHash: "unused", createdAt: now });
});

afterEach(async () => {
	for (const complete of completions.splice(0)) complete();
	for (const id of ids) {
		getExecutionOwner(id)?.release();
		setRunHold(id, undefined);
		activeNarrators.get(id)?.abortController.abort();
		activeNarrators.delete(id);
	}
	ids.clear();
	pendingPermissions.clear();
	pendingDangerReflections.clear();
	for (const registration of listRegisteredScheduledRuns())
		unregisterScheduledRun(registration.runId);
	mock.restore();
	await closePrefixSnapshotStore();
});
afterAll(closePrefixSnapshotStore);

async function seed(id = TARGET) {
	ids.add(id);
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		title: "Existing conversation",
		ownerUserId: OWNER,
		visibility: "private",
		writeAudience: "owner",
		traits: ["standalone"],
		status: "idle",
		model: "openai:test-model",
		permissionMode: "readOnly",
		systemPrompt: "Keep this existing prompt",
		cwd: process.env.HOME,
		autoContinuationOverride: "off",
		createdAt: now,
		updatedAt: now,
	});
}

function registration(overrides: Partial<ScheduledRunRegistration> = {}) {
	return registerScheduledRun({
		runId: "session-scheduled-run",
		taskId: "session-scheduled-task",
		narratorId: TARGET,
		ownerUserId: OWNER,
		onBlocked: "auto",
		blockedWaitMinutes: 30,
		deadlineAt: null,
		permissionMode: "bypassPermissions",
		systemPrompt: "Task prompt must not replace target prompt",
		narratorMode: "existing",
		modelPolicy: "follow",
		model: null,
		...overrides,
	});
}

function input(reg: ScheduledRunRegistration) {
	return {
		narratorId: reg.narratorId,
		runId: reg.runId,
		userId: reg.ownerUserId,
		prompt: "Do work",
	};
}

function session(id = TARGET): ActiveNarrator {
	return {
		narratorId: id,
		conversationId: "old-provider-conversation",
		cwd: process.env.HOME as string,
		model: "openai:test-model",
		provider: "openai",
		systemPrompt: "cached old prefix",
		locale: "en",
		alive: true,
		abortController: new AbortController(),
		events: new EventEmitter(),
		_enabledOptionalTools: new Set(),
		_disabledTools: new Set(),
		_blockedSkills: { all: false, names: new Set() },
		_substatus: new Set(),
	};
}

function own(id = TARGET, logicalRunId = `logical-${id}`) {
	const owner = tryClaimExecution(id, "run");
	if (!owner) throw new Error("Fixture already owns target");
	const run: RunControl = {
		logicalRunId,
		startedAt: Date.now(),
		cancel: new AbortController(),
		timedOut: false,
		terminal: new Promise(() => {}),
	};
	setRunControl(owner, run);
	db.update(narrators).set({ logicalRunId }).where(eq(narrators.id, id)).run();
	return { owner, run };
}

async function legacyInterruptFixture() {
	await seed();
	await seed("legacy-worker-child");
	const root = own();
	const child = own("legacy-worker-child");
	const active = session();
	active._partialMessageId = "legacy-worker-message";
	activeNarrators.set(TARGET, active);
	const now = new Date().toISOString();
	await db.insert(narratorMessages).values({
		id: active._partialMessageId,
		narratorId: TARGET,
		role: "assistant",
		contentJson: [],
		createdAt: now,
	});
	await db.insert(narratorToolCalls).values({
		id: "legacy-worker-call",
		narratorId: TARGET,
		messageId: active._partialMessageId,
		toolUseId: "legacy-worker-use",
		toolName: "Agent",
		executionAttempt: 1,
		status: "running",
		createdAt: now,
	});
	child.run.cancelWith = { narratorId: TARGET, toolCallId: "legacy-worker-call", attempt: 1 };
	const target = await captureScheduledInterruptTarget(TARGET);
	if (!target) throw new Error("Expected current legacy target");
	return { root, child, active, target };
}

/** Stop at the runtime boundary while preserving real input/history persistence. */
function fakeRuntime(beforeClaim?: () => Promise<void>) {
	spyOn(runService, "bindScheduledRunTrigger").mockImplementation(async (_runId, id, messageId) => {
		const reg = getRegisteredScheduledRun(id);
		if (reg) reg.triggerMessageId = messageId;
	});
	return spyOn(runtime, "startNarratorRun").mockImplementation(async (request) => {
		await beforeClaim?.();
		request.admission?.check();
		const { owner, run } = own(request.narratorId, `dispatched-${completions.length}`);
		const reg = getRegisteredScheduledRun(request.narratorId);
		if (reg) {
			reg.logicalRunId = run.logicalRunId;
			reg.executionEpoch = owner.epoch;
		}
		const completion = Promise.withResolvers<RunResult>();
		completions.push(() => {
			owner.release();
			completion.resolve({
				started: true,
				logicalRunId: run.logicalRunId,
				output: "done",
				finalText: "done",
				hasError: false,
				interrupted: false,
				timedOut: false,
			});
		});
		request.admission?.onAdmitted();
		return {
			started: true,
			logicalRunId: run.logicalRunId,
			foreground: completion.promise,
			terminal: completion.promise,
			completion: completion.promise,
		};
	});
}

async function waitForParkedPass(passes: string[], count: number) {
	const deadline = Date.now() + 2000;
	while (passes.length < count || !getRunControl(TARGET)?.wake) {
		if (Date.now() >= deadline) throw new Error("Scheduled run did not park after its pass");
		await Bun.sleep(5);
	}
}

async function parkedScheduledRun() {
	await seed();
	const reg = registration();
	const now = new Date().toISOString();
	await db.insert(scheduledTasks).values({
		id: reg.taskId,
		name: "held scheduled run",
		cronExpr: "0 9 * * *",
		prompt: "keep scheduled authority across Send",
		ownerUserId: OWNER,
		lastRunId: reg.runId,
		activeRunId: reg.runId,
		lastStatus: "running",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(scheduledTaskRuns).values({
		id: reg.runId,
		taskId: reg.taskId,
		narratorId: TARGET,
		status: "running",
		runContext: "standalone",
		requireReport: true,
		startedAt: now,
		createdAt: now,
	});
	const active = session();
	activeNarrators.set(TARGET, active);
	setRunHold(TARGET, { released: false });
	const passes: string[] = [];
	// The real run, mailbox, scheduled attachment, permissions and terminal remain
	// in use. Only model passes and the unrelated periodic sweep are controlled.
	spyOn(orchestrator, "runAgentLoopUnlocked").mockImplementation(async (_active, owner) => {
		passes.push(owner.epoch);
		return { started: true, finalText: `pass ${passes.length}` };
	});
	spyOn(runTracker, "pollScheduledRuns").mockResolvedValue(undefined);
	const handle = await runtime.startNarratorRun({
		narratorId: TARGET,
		locale: "en",
		text: "held scheduled work",
		active,
		principal: OWNER,
		scheduledRunId: reg.runId,
		initiatedBy: "system",
	});
	await waitForParkedPass(passes, 1);
	return { reg, active, passes, handle };
}

function compactCount() {
	return db
		.select({ id: narratorMessageRefs.id })
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.isCompact, 1))
		.all().length;
}

describe("scheduled existing session admission", () => {
	test("preserves target owner, prompt, permissions, traits and plan preferences", async () => {
		await seed();
		await db
			.update(narrators)
			.set({
				traits: ["standalone", "plan", "bot"],
				planMode: true,
				planFileId: "retained-plan",
				previousPermissionMode: "acceptEdits",
				relaxedPlan: false,
			})
			.where(eq(narrators.id, TARGET));
		const before = await narratorService.getById(TARGET);
		await prepareScheduledTaskSession(input(registration()));
		const after = await narratorService.getById(TARGET);
		for (const field of [
			"ownerUserId",
			"permissionMode",
			"systemPrompt",
			"traits",
			"planMode",
			"planFileId",
			"previousPermissionMode",
			"relaxedPlan",
			"cwd",
			"model",
		] as const)
			expect(after[field]).toEqual(before[field]);
	});

	test.each([
		"follow",
		"temporary",
		"sync",
	] as const)("existing model policy %s retains its meaning", async (modelPolicy) => {
		await seed();
		await prepareScheduledTaskSession(input(registration({ modelPolicy, model: "openai:chosen" })));
		expect((await narratorService.getById(TARGET)).model).toBe(
			modelPolicy === "sync" ? "openai:chosen" : "openai:test-model",
		);
	});

	test("rechecks task owner's write ACL before changing or clearing history", async () => {
		await seed();
		await db
			.update(narrators)
			.set({ ownerUserId: OTHER, writeAudience: "public" })
			.where(eq(narrators.id, TARGET));
		const reg = registration({ contextPolicy: "clear" });
		await prepareScheduledTaskSession(input(reg));
		await db.update(narrators).set({ writeAudience: "owner" }).where(eq(narrators.id, TARGET));
		expect(await captureWorkerRejectionThrower(sendScheduledTaskMessage(input(reg)))).toThrow();
		expect(compactCount()).toBe(0);
		expect(reg.contextPrepared).not.toBe(true);
	});

	test("a registration cancelled during ACL resolution cannot clear the target", async () => {
		await seed();
		const reg = registration({ contextPolicy: "clear" });
		const checked = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const resolveTarget = scheduledTarget.resolveScheduledTaskTarget;
		spyOn(scheduledTarget, "resolveScheduledTaskTarget").mockImplementation(async (...args) => {
			const result = await resolveTarget(...args);
			checked.resolve();
			await release.promise;
			return result;
		});
		const dispatch = sendScheduledTaskMessage(input(reg));
		await checked.promise;
		unregisterScheduledRun(reg.runId);
		release.resolve();
		expect(await captureWorkerRejectionThrower(dispatch)).toThrow("registration expired");
		expect(compactCount()).toBe(0);
		expect(reg.contextPrepared).not.toBe(true);
	});

	test("clear happens once; a reporting reminder keeps the business history", async () => {
		await seed();
		await db
			.update(narrators)
			.set({ apiConversationId: "old-conversation", contextSummary: "old summary" })
			.where(eq(narrators.id, TARGET));
		const reg = registration({ contextPolicy: "clear" });
		const cached = session();
		activeNarrators.set(TARGET, cached);
		fakeRuntime();
		await sendScheduledTaskMessage(input(reg));
		expect(reg.contextPrepared).toBe(true);
		expect(compactCount()).toBe(1);
		expect(cached.abortController.signal.aborted).toBe(true);
		expect(activeNarrators.get(TARGET)).not.toBe(cached);
		expect((await narratorService.getById(TARGET)).apiConversationId).toBeNull();
		expect((await narratorService.getById(TARGET)).contextSummary).toBeNull();
		completions[0]?.();
		await sendScheduledTaskMessage({ ...input(reg), nudge: true, prompt: "Report once" });
		expect(compactCount()).toBe(1);
		expect(reg.reportOnly).toBe(true);
	});

	test("clear waits through actual runtime admission, but never waits for terminal", async () => {
		await seed();
		const reg = registration({ contextPolicy: "clear" });
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		fakeRuntime(async () => {
			reached.resolve();
			await release.promise;
		});
		const dispatch = sendScheduledTaskMessage(input(reg));
		await reached.promise;
		expect(compactCount()).toBe(1);
		let competingEntered = false;
		const competing = withNarratorStartAdmission(TARGET, async () => {
			competingEntered = true;
			return tryClaimExecution(TARGET, "run");
		});
		await Promise.resolve();
		expect(competingEntered).toBe(false);
		release.resolve();
		await dispatch;
		expect(await competing).toBeNull();
		expect(getRunControl(TARGET)).toBeDefined();
	});

	test("busy, reporting-disabled and recovered dispatches do not clear again", async () => {
		await seed();
		const reg = registration({ contextPolicy: "clear", requireReport: false });
		const { owner } = own();
		expect(await captureWorkerRejectionThrower(sendScheduledTaskMessage(input(reg)))).toThrow(
			"already running",
		);
		owner.release();
		expect(
			await captureWorkerRejectionThrower(sendScheduledTaskMessage({ ...input(reg), nudge: true })),
		).toThrow("does not require");
		expect(compactCount()).toBe(0);
		reg.recoveredAt = Date.now();
		fakeRuntime();
		await sendScheduledTaskMessage(input(reg));
		expect(compactCount()).toBe(0);
	});

	test("rejects a new execution that already ended, even if persisted logical id stayed old", async () => {
		await seed();
		const old = own();
		const target = await captureScheduledInterruptTarget(TARGET);
		if (!target) throw new Error("Expected current target");
		old.owner.release();
		const intervening = tryClaimExecution(TARGET, "tool-replay");
		intervening?.release();
		expect(getLastExecutionEpoch(TARGET)).not.toBe(target.executionEpoch);
		const reg = registration({ contextPolicy: "clear", interruptTarget: target });
		expect(await captureWorkerRejectionThrower(sendScheduledTaskMessage(input(reg)))).toThrow(
			"was replaced",
		);
		expect(compactCount()).toBe(0);
	});

	test("disabled reporting never requires the reporting tool in unattended denial text", async () => {
		await seed();
		const reg = registration({ requireReport: false });
		spyOn(runService, "lookupScheduledRun").mockResolvedValue(reg);
		spyOn(runService, "recordScheduledAutoHandled").mockResolvedValue(undefined);
		const result = await handlePermission(
			TARGET,
			new AbortController().signal,
			"AskUserQuestion",
			{ async: true },
			"question-without-report",
			process.cwd(),
			"en",
		);
		expect(result.behavior).toBe("deny");
		if (result.behavior !== "deny") throw new Error("Expected unattended denial");
		expect(result.message).toContain("final response");
		expect(result.message).not.toContain("ScheduledTaskReport");
	});

	test("allows the reserved target's unchanged idle identity", async () => {
		await seed();
		const old = own();
		const target = await captureScheduledInterruptTarget(TARGET);
		if (!target) throw new Error("Expected current target");
		old.owner.release();
		await prepareScheduledTaskSession(input(registration({ interruptTarget: target })));
	});
});

describe("scheduled authority across fresh passes", () => {
	test("withdrawn model override plus Send keeps exact scheduled identity and terminal attribution", async () => {
		const { reg, passes, handle } = await parkedScheduledRun();
		const oldTarget = await captureScheduledInterruptTarget(TARGET);
		if (!oldTarget) throw new Error("Expected original scheduled identity");
		const sameControl = getRunControl(TARGET);
		const member = getScheduledRunMember(TARGET);
		const queued = await buffer.enqueueBufferedMessage(
			TARGET,
			"withdraw this model override",
			undefined,
			undefined,
			OWNER,
			undefined,
			undefined,
			"back",
			undefined,
			undefined,
			"fifo",
			{ modelOverride: { model: "openai:other-model", mode: "temporary" } },
		);
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const prepare = sessionModule.prepareQueuedRunInput;
		spyOn(sessionModule, "prepareQueuedRunInput").mockImplementation(async (...args) => {
			entered.resolve();
			await resume.promise;
			return prepare(...args);
		});
		try {
			expect(runtime.wakeHeldRun(TARGET)).toBe(true);
			await entered.promise;
			await buffer.removeBufferedMessage(TARGET, queued.id);
			const senderId = "scheduled-send-source";
			await seed(senderId);
			const now = new Date().toISOString();
			await db.insert(narratorMessages).values({
				id: "fresh-send-message",
				narratorId: senderId,
				role: "assistant",
				contentJson: [],
				createdAt: now,
			});
			await db.insert(narratorMessageRefs).values({
				id: "fresh-send-ref",
				narratorId: senderId,
				messageId: "fresh-send-message",
				seq: 1,
			});
			await db.insert(narratorToolCalls).values({
				id: "fresh-send-call",
				narratorId: senderId,
				messageId: "fresh-send-message",
				toolUseId: "fresh-send-use",
				toolName: "Send",
				status: "running",
				executionIdentityVersion: 1,
				executionAttempt: 1,
				executionSegmentId: "fresh-send-segment",
				createdAt: now,
			});
			await db.insert(fileChangeExecutionSegments).values({
				id: "fresh-send-segment",
				narratorId: senderId,
				sourceToolCallId: "fresh-send-call",
				sourceExecutionAttempt: 1,
				createdAt: now,
			});
			const delivery = createAgentMessageDelivery(
				TARGET,
				{ id: senderId, title: "Sender", label: "sender", type: "general", isParent: false },
				"fresh-send-use",
				"Send replaces withdrawn input",
				{ toolCallId: "fresh-send-call", attempt: 1 },
			);
			await inbox.enqueueInboxAgent(delivery, delivery.text, { userId: OTHER });
			resume.resolve();
			await waitForParkedPass(passes, 2);
			expect(passes[1]).not.toBe(passes[0]);
			expect(getRunControl(TARGET)).toBe(sameControl);
			expect(getRunControl(TARGET)?.principal).toBe(OWNER);
			expect(getScheduledRunMember(TARGET)).toBe(member);
			expect(reg.executionEpoch).toBe(passes[1]);
			expect(member?.executionEpoch).toBe(passes[1]);
			expect(reg.turns).toBe(1);
			expect(await runService.lookupScheduledRun(TARGET)).toBe(reg);
			expect((await narratorService.getById(TARGET)).model).toBe("openai:test-model");

			const blocked = await handlePermission(
				TARGET,
				new AbortController().signal,
				"AskUserQuestion",
				{ async: true },
				"fresh-ask-use",
				process.cwd(),
				"en",
			);
			expect(blocked.behavior).toBe("deny");
			if (blocked.behavior !== "deny") throw new Error("Expected unattended question denial");
			expect(blocked.message).toContain("unattended");
			reg.reportOnly = true;
			const reportOnly = await handlePermission(
				TARGET,
				new AbortController().signal,
				"TeamStatus",
				{ action: "list" },
				"fresh-business-use",
				process.cwd(),
				"en",
			);
			expect(reportOnly.behavior).toBe("deny");
			if (reportOnly.behavior !== "deny") throw new Error("Expected report-only denial");
			expect(reportOnly.message).toContain("only call ScheduledTaskReport");
			expect(await runService.reportScheduledRun(TARGET, { outcome: "no_change" })).toMatchObject({
				runId: reg.runId,
			});

			expect(await cancelScheduledRunTarget(oldTarget, "stale cancellation")).toBe(false);
			expect(sameControl?.cancel.signal.aborted).toBe(false);
			const currentTarget = await captureScheduledInterruptTarget(TARGET);
			if (!currentTarget) throw new Error("Expected fresh scheduled identity");
			expect(currentTarget.executionEpoch).toBe(passes[1]);
			expect(currentTarget.scheduledRunId).toBe(reg.runId);
			expect(await cancelScheduledRunTarget(currentTarget, "cancel fresh scheduled pass")).toBe(
				true,
			);
			await handle.completion;
			expect(reg.terminal).toMatchObject({
				executionEpoch: passes[1],
				logicalRunId: sameControl?.logicalRunId,
				status: "interrupted",
			});
		} finally {
			resume.resolve();
			const target = await captureScheduledInterruptTarget(TARGET);
			if (target) await cancelScheduledRunTarget(target, "test cleanup");
			await handle.completion;
		}
	});

	test("adopting human input ends the scheduled binding after the same-control rotation", async () => {
		const { reg, passes, handle } = await parkedScheduledRun();
		try {
			await buffer.enqueueBufferedMessage(TARGET, "Human takes over", undefined, undefined, OWNER);
			expect(runtime.wakeHeldRun(TARGET)).toBe(true);
			await waitForParkedPass(passes, 2);
			expect(passes[1]).not.toBe(passes[0]);
			expect(getRegisteredScheduledRun(TARGET)).toBeUndefined();
			expect(getScheduledRunMember(TARGET)).toBeUndefined();
			expect(await runService.lookupScheduledRun(TARGET)).toBeUndefined();
			expect(
				await captureWorkerRejectionThrower(
					runService.reportScheduledRun(TARGET, { outcome: "no_change" }),
				),
			).toThrow("no active scheduled run");
			expect(
				await db.query.scheduledTaskRuns.findFirst({ where: eq(scheduledTaskRuns.id, reg.runId) }),
			).toMatchObject({
				status: "interrupted",
				errorKind: "user_interrupt",
			});
			const target = await captureScheduledInterruptTarget(TARGET);
			expect(target?.scheduledRunId).toBeUndefined();
		} finally {
			const target = await captureScheduledInterruptTarget(TARGET);
			if (target) await cancelScheduledRunTarget(target, "test cleanup");
			await handle.completion;
		}
	});

	test("a new human RunControl cannot inherit the previous run's scheduled receipt", async () => {
		const { reg, active, passes, handle } = await parkedScheduledRun();
		const previous = getRunControl(TARGET);
		await runtime.controlRun(TARGET, { kind: "release" });
		await handle.completion;
		expect(reg.terminal?.status).toBe("completed");
		setRunHold(TARGET, { released: false });
		const human = await runtime.startNarratorRun({
			narratorId: TARGET,
			locale: "en",
			text: "New human turn",
			active,
			principal: OWNER,
			initiatedBy: "person",
		});
		try {
			await waitForParkedPass(passes, 2);
			expect(getRunControl(TARGET)).not.toBe(previous);
			expect(getRunControl(TARGET)?.logicalRunId).not.toBe(previous?.logicalRunId);
			expect(getRegisteredScheduledRun(TARGET)).toBeUndefined();
			expect(getScheduledRunMember(TARGET)).toBeUndefined();
			expect(await runService.lookupScheduledRun(TARGET)).toBeUndefined();
		} finally {
			const target = await captureScheduledInterruptTarget(TARGET);
			if (target) await cancelScheduledRunTarget(target, "test cleanup");
			await human.completion;
		}
	});
});

describe("precise scheduled interruption", () => {
	test("rejects missing/stale identity without touching a newer run", async () => {
		await seed();
		expect(await captureScheduledInterruptTarget(TARGET)).toBeNull();
		const adopting = tryClaimExecution(TARGET, "tool-replay");
		expect(await captureScheduledInterruptTarget(TARGET)).toBeNull();
		adopting?.release();
		const first = own();
		const target = await captureScheduledInterruptTarget(TARGET);
		if (!target) throw new Error("Expected current target");
		first.owner.release();
		const next = own(TARGET, "new-logical");
		expect(await cancelScheduledRunTarget({ narratorId: TARGET }, "replace")).toBe(false);
		expect(await cancelScheduledRunTarget(target, "replace")).toBe(false);
		expect(next.run.cancel.signal.aborted).toBe(false);
	});

	test("wakes held run without waiting for its terminal or changing timeout attribution", async () => {
		await seed();
		const { owner, run } = own();
		setRunHold(TARGET, { released: false });
		setExecutionSuspended(owner, true);
		const wake = mock(() => {});
		run.wake = wake;
		const target = await captureScheduledInterruptTarget(TARGET);
		if (!target) throw new Error("Expected held target");
		expect(await isScheduledInterruptTargetCurrent(target)).toBe(true);
		expect(await cancelScheduledRunTarget(target, "scheduled takeover")).toBe(true);
		expect(run.cancel.signal.aborted).toBe(true);
		expect(run.timedOut).toBe(false);
		expect(wake).toHaveBeenCalledWith("cancel");
		// The whole-run finalizer still owns its slot; cancellation did not release it.
		expect(getExecutionOwner(TARGET)).toBe(owner);
		run.timedOut = true;
		await cancelScheduledRunTarget(target, "timeout");
		expect(run.timedOut).toBe(true);
	});

	test("a real held run persists interrupted rather than completed when cancelled", async () => {
		await seed();
		const active = session();
		activeNarrators.set(TARGET, active);
		setRunHold(TARGET, { released: false });
		spyOn(orchestrator, "runAgentLoopUnlocked").mockResolvedValue({
			started: true,
			finalText: "business turn already returned",
		});
		const handle = await runtime.startNarratorRun({
			narratorId: TARGET,
			locale: "en",
			text: "held run",
			active,
			principal: OWNER,
		});
		const deadline = Date.now() + 2000;
		while (!getRunControl(TARGET)?.wake && Date.now() < deadline) await Bun.sleep(5);
		expect(getRunControl(TARGET)?.wake).toBeDefined();
		const target = await captureScheduledInterruptTarget(TARGET);
		if (!target) throw new Error("Expected held target");
		expect(await cancelScheduledRunTarget(target, "scheduled takeover")).toBe(true);
		const terminal = await handle.terminal;
		expect(terminal.interrupted).toBe(true);
		expect(terminal.timedOut).toBe(false);
		expect(getExecutionOwner(TARGET)).toBeUndefined();
	});

	test("releases captured permission and reflection gates without holding admission", async () => {
		await seed();
		own();
		const permission = Promise.withResolvers<PermissionResult>();
		const reflection = Promise.withResolvers<PermissionResult>();
		const reflectionAbortController = new AbortController();
		pendingPermissions.set("held-permission", {
			narratorId: TARGET,
			toolName: "Write",
			toolUseId: "held-permission-use",
			broadcastTargetId: TARGET,
			cwd: process.cwd(),
			locale: "en",
			input: {},
			signal: new AbortController().signal,
			cleanup: () => {
				pendingPermissions.delete("held-permission");
			},
			resolve: permission.resolve,
		});
		pendingDangerReflections.set("held-reflection", {
			narratorId: TARGET,
			requestId: "held-reflection",
			toolCallId: "held-reflection",
			toolUseId: "held-reflection-use",
			toolName: "Bash",
			broadcastTargetId: TARGET,
			input: {},
			fingerprint: "held-reflection-fingerprint",
			danger: { severity: "high", summary: "test", consequences: [], saferAlternatives: [] },
			startedAt: Date.now(),
			reflectionAbortController,
			reflectionStoppedByUser: true,
			cleanup: () => {
				pendingDangerReflections.delete("held-reflection");
			},
			resolve: reflection.resolve,
		});
		const target = await captureScheduledInterruptTarget(TARGET);
		if (!target) throw new Error("Expected current target");
		await cancelScheduledRunTarget(target, "scheduled takeover");
		expect(await withNarratorStartAdmission(TARGET, async () => "available")).toBe("available");
		expect((await permission.promise).behavior).toBe("deny");
		expect((await reflection.promise).behavior).toBe("deny");
		expect(reflectionAbortController.signal.aborted).toBe(true);
		expect(pendingPermissions.size).toBe(0);
		expect(pendingDangerReflections.size).toBe(0);
	});

	test("recognizes a scheduled member without a root registration on its narrator", async () => {
		await seed();
		const reg = registration();
		await seed("scheduled-member");
		const child = own("scheduled-member");
		bindScheduledRunMember({
			runId: reg.runId,
			narratorId: "scheduled-member",
			logicalRunId: child.run.logicalRunId as string,
			executionEpoch: child.owner.epoch,
			parentNarratorId: TARGET,
		});
		const target = await captureScheduledInterruptTarget("scheduled-member");
		if (!target) throw new Error("Expected member target");
		expect(target.scheduledRunId).toBe(reg.runId);
		expect(await cancelScheduledRunTarget(target, "timeout")).toBe(true);
		expect(child.run.cancel.signal.aborted).toBe(true);
	});

	for (const replaced of ["root", "root-epoch", "child", "child-epoch"] as const) {
		test(`a ${replaced} replaced during the legacy Worker read keeps its new run and gates`, async () => {
			const fixture = await legacyInterruptFixture();
			const replaceRoot = replaced.startsWith("root");
			const replacedId = replaceRoot ? TARGET : "legacy-worker-child";
			const prior = replaceRoot ? fixture.root : fixture.child;
			// Legacy reservations may contain only a logical id; the runtime must still
			// freeze the current owner before it crosses a Worker boundary.
			if (replaced === "root-epoch") delete fixture.target.executionEpoch;
			const gateAbort = new AbortController();
			const read = readPool.runReadTask;
			let replacement: ReturnType<typeof own> | undefined;
			spyOn(readPool, "runReadTask").mockImplementation((async (path, params, options) => {
				const result = await read(path, params, options);
				if (
					!replacement &&
					(params.kind === "selectRows" || params.kind === "selectValues") &&
					params.sql.includes("narrator_tool_calls")
				) {
					prior.owner.release();
					if (replaced.endsWith("-epoch")) {
						const owner = tryClaimExecution(replacedId, "run");
						if (!owner) throw new Error("Expected replacement execution epoch");
						setRunControl(owner, prior.run);
						replacement = { owner, run: prior.run };
					} else replacement = own(replacedId, "replacement-logical");
					pendingPermissions.set("replacement-permission", {
						narratorId: replacedId,
						toolName: "Write",
						toolUseId: "replacement-permission-use",
						broadcastTargetId: replacedId,
						cwd: process.cwd(),
						locale: "en",
						input: {},
						signal: gateAbort.signal,
						questionReflectionAbort: gateAbort,
						cleanup: () => pendingPermissions.delete("replacement-permission"),
						resolve: () => {},
					});
				}
				return result;
			}) as typeof readPool.runReadTask);
			expect(await cancelScheduledRunTarget(fixture.target, "replace")).toBe(!replaceRoot);
			expect(replacement).toBeDefined();
			expect(replacement?.run.cancel.signal.aborted).toBe(false);
			expect(fixture.child.run.cancel.signal.aborted).toBe(false);
			expect(fixture.root.run.cancel.signal.aborted).toBe(!replaceRoot);
			expect(gateAbort.signal.aborted).toBe(false);
			expect(pendingPermissions.has("replacement-permission")).toBe(true);
		});
	}

	test("legacy relation Worker failure leaves the target and all descendants running", async () => {
		const { root, child, target } = await legacyInterruptFixture();
		const error = new DbReadError("DB_READ_UNAVAILABLE", "Injected legacy relation read failure");
		const worker = spyOn(readPool, "runReadTask").mockRejectedValue(error);
		const main = spyOn(sqlite, "prepare");
		expect(await captureWorkerRejection(cancelScheduledRunTarget(target, "replace"))).toBe(error);
		expect(worker).toHaveBeenCalled();
		expect(main).not.toHaveBeenCalled();
		expect(root.run.cancel.signal.aborted).toBe(false);
		expect(child.run.cancel.signal.aborted).toBe(false);
	});

	test("legacy foreground relations require the current caller message and tool attempt", async () => {
		await seed();
		own();
		const active = session();
		active._partialMessageId = "current-caller-message";
		activeNarrators.set(TARGET, active);
		const now = new Date().toISOString();
		const children = [];
		for (const id of ["current", "old"]) {
			await seed(`${id}-legacy-child`);
			await db.insert(narratorMessages).values({
				id: `${id}-caller-message`,
				narratorId: TARGET,
				role: "assistant",
				contentJson: [],
				createdAt: now,
			});
			await db.insert(narratorToolCalls).values({
				id: `${id}-caller-tool`,
				narratorId: TARGET,
				messageId: `${id}-caller-message`,
				toolUseId: `${id}-caller-use`,
				toolName: "Agent",
				executionAttempt: 2,
				status: "running",
				createdAt: now,
			});
			const child = own(`${id}-legacy-child`);
			child.run.cancelWith = { narratorId: TARGET, toolCallId: `${id}-caller-tool`, attempt: 2 };
			children.push(child.run);
		}
		const target = await captureScheduledInterruptTarget(TARGET);
		if (!target) throw new Error("Expected current target");
		await cancelScheduledRunTarget(target, "replace");
		expect(children[0]?.cancel.signal.aborted).toBe(true);
		expect(children[1]?.cancel.signal.aborted).toBe(false);
	});

	test("cancels captured foreground relations, leaving detached and previous-run children alone", async () => {
		await seed();
		const root = own();
		for (const id of ["current-child", "detached-child", "old-child"]) await seed(id);
		const current = own("current-child");
		const detached = own("detached-child");
		const old = own("old-child");
		current.run.cancelWith = {
			narratorId: TARGET,
			toolCallId: "current-call",
			attempt: 1,
			runId: root.run.logicalRunId,
		};
		old.run.cancelWith = {
			narratorId: TARGET,
			toolCallId: "old-call",
			attempt: 1,
			runId: "previous-logical",
		};
		const target = await captureScheduledInterruptTarget(TARGET);
		if (!target) throw new Error("Expected current target");
		await cancelScheduledRunTarget(target, "replace");
		expect(current.run.cancel.signal.aborted).toBe(true);
		expect(detached.run.cancel.signal.aborted).toBe(false);
		expect(old.run.cancel.signal.aborted).toBe(false);
	});
});
