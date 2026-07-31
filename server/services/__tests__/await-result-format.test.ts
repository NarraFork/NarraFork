import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";

// Use a functional in-memory test db rather than empty stubs. Bun's mock.module
// is process-global and leaks to later suites, so empty stubs ({}) would make
// `db.insert`/`db.delete` undefined in every subsequently-loaded real-db test.
const { db, sqlite } = getTestDb();
// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { appendSendReplyRequest, formatAgentAwaitResult } = await import("../agent-communication");
const { formatRecentSubagentActivity, summarizeSubagentToolCall } = await import(
	"../subagent-activity"
);
const { formatResult } = await import("../../lib/agent/tools/await");
const {
	backgroundTaskService,
	getBackgroundTaskTerminalVersion,
	resolveBackgroundTaskEffectiveStatus,
} = await import("../background-task-service");
const {
	claimSubagentUpdateExecutionLease,
	listRunningSubagentExecutions,
	registerRunningSubagentExecution,
	resolveBackgroundCompletionOutcome,
	resolveSubagentExecutionTiming,
} = await import("../subagent-runner");
const updateCoordinator = await import("../update-coordinator");

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

afterEach(() => {
	cleanDb(sqlite);
	updateCoordinator.resetUpdateCoordinationForTests();
});

const AGENT_ID = "-tLSXSnYCPV_Z9m6gyRgX";
const TASK_ID = "bg-task-123";

describe("Await agent result wording", () => {
	test("aborted wait makes clear the subagent is still running and can be awaited again", () => {
		const text = formatAgentAwaitResult(AGENT_ID, "aborted", null);
		// Must not look like the subagent itself was killed.
		expect(text).not.toMatch(/status: aborted/);
		expect(text).not.toMatch(/\(no output\)/);
		expect(text.toLowerCase()).toContain("still running");
		expect(text.toLowerCase()).toContain("await again");
		// Subagent id tag is preserved so the frontend can still resolve it.
		expect(text).toContain(`<subagent_id>${AGENT_ID}</subagent_id>`);
	});

	test("timeout/running wait reminds the caller to await again rather than implying failure", () => {
		for (const status of ["timeout", "running"]) {
			const text = formatAgentAwaitResult(AGENT_ID, status, null);
			expect(text.toLowerCase()).toContain("still running");
			expect(text.toLowerCase()).toContain("await again");
			expect(text).not.toMatch(/\(no output\)/);
		}
	});

	test("aborted wait surfaces real partial output but drops empty placeholders", () => {
		const withPartial = formatAgentAwaitResult(AGENT_ID, "aborted", "halfway through the task");
		expect(withPartial).toContain("Partial output so far:");
		expect(withPartial).toContain("halfway through the task");

		// Placeholder stand-ins must not be shown as if they were real output.
		const withPlaceholder = formatAgentAwaitResult(AGENT_ID, "aborted", "Await aborted.");
		expect(withPlaceholder).not.toContain("Partial output so far:");
	});

	test("timeout includes recent timestamped activity and discourages status polling", () => {
		const activity = formatRecentSubagentActivity(
			[
				{
					at: "2026-04-23T12:34:48.000Z",
					toolName: "Bash",
					status: "running",
					summary: "Run targeted tests",
				},
				{
					at: "2026-04-23T12:34:32.000Z",
					toolName: "Edit",
					status: "success",
					summary: "agent-communication.ts",
				},
			],
			Date.parse("2026-04-23T12:35:00.000Z"),
		);
		const text = formatAgentAwaitResult(AGENT_ID, "timeout", null, activity);

		expect(text).toContain("Recent subagent activity (UTC):");
		expect(text).toContain("2026-04-23T12:34:48.000Z (12s ago)");
		expect(text).toContain("Bash [running]: Run targeted tests");
		expect(text).toContain("Edit [completed]: agent-communication.ts");
		expect(text).toContain("Do not send a progress check or interrupt it");
	});

	test("empty recent activity explains that the subagent may still be reasoning", () => {
		const activity = formatRecentSubagentActivity([]);
		expect(activity).toContain("no tool calls have been recorded yet");
		expect(activity).toContain("may still be reasoning");
	});

	test("tool activity summaries ignore long parameters and cap safe hints", () => {
		const secretCommand = `bun test ${"very-long-secret-argument ".repeat(20)}`;
		const summary = summarizeSubagentToolCall("Bash", {
			description: "Run focused tests ".repeat(20),
			command: secretCommand,
		} as Parameters<typeof summarizeSubagentToolCall>[1] & { command: string });

		expect(summary).toBeDefined();
		expect(summary?.length).toBeLessThanOrEqual(96);
		expect(summary).not.toContain(secretCommand);
		expect(summary).not.toContain("very-long-secret-argument");
	});

	test("terminal statuses keep the explicit result wording", () => {
		const completed = formatAgentAwaitResult(AGENT_ID, "completed", "done");
		expect(completed).toContain(`Agent ${AGENT_ID} status: completed`);
		expect(completed).toContain("done");

		const failed = formatAgentAwaitResult(AGENT_ID, "failed", "boom");
		expect(failed).toContain(`Agent ${AGENT_ID} status: failed`);
	});

	test("execution timeout is terminal and does not suggest awaiting again", () => {
		const text = formatAgentAwaitResult(AGENT_ID, "timed_out", "30 minute limit reached");
		expect(text).toContain("execution time limit");
		expect(text).toContain("was stopped");
		expect(text).not.toContain("Await again");
		expect(text).not.toContain("still running");
	});
});

describe("Send reply request wording", () => {
	test("explicitly asks for a reverse Send without asking the target to stop", () => {
		const text = appendSendReplyRequest("Please check the API shape.", AGENT_ID, "request-1", "en");
		expect(text).toContain(
			`Send({ id: "${AGENT_ID}", message: "<your reply>", replyTo: "request-1" })`,
		);
		expect(text).toContain("waiting for your Send reply, not for your task to finish");
		expect(text).toContain("do not interrupt ongoing work");
	});

	test("uses a localized reply instruction for Chinese sessions", () => {
		const text = appendSendReplyRequest("请检查 API。", AGENT_ID, "request-2", "zh-CN");
		expect(text).toContain("[请求回复 requestId=request-2]");
		expect(text).toContain(
			`Send({ id: "${AGENT_ID}", message: "<你的回复>", replyTo: "request-2" })`,
		);
		expect(text).toContain("不是等待你结束任务");
	});
});

describe("Await bash result wording", () => {
	test("aborted wait makes clear the task is still running and can be awaited again", () => {
		const text = formatResult(TASK_ID, "aborted", null);
		expect(text.toLowerCase()).toContain("still running");
		expect(text.toLowerCase()).toContain("await again");
		// The old wording implied the await/task was over.
		expect(text).not.toMatch(/await was aborted/i);
	});

	test("timeout/running wait keeps the task alive in the wording", () => {
		const text = formatResult(TASK_ID, "timeout", "partial log line");
		expect(text.toLowerCase()).toContain("still running");
		expect(text.toLowerCase()).toContain("await again");
		expect(text).toContain("partial log line");
	});

	test("completed/failed/cancelled keep their terminal wording", () => {
		expect(formatResult(TASK_ID, "completed", "ok")).toContain("completed");
		expect(formatResult(TASK_ID, "failed", "err")).toContain("failed");
		expect(formatResult(TASK_ID, "cancelled", null)).toContain("was cancelled");
	});

	test("execution timeout is distinct from an Await deadline", () => {
		const text = formatResult(TASK_ID, "timed_out", "command exceeded 30 minutes");
		expect(text).toContain("execution time limit");
		expect(text).toContain("was stopped");
		expect(text).not.toContain("Await again");
	});
});

describe("recovered Agent execution deadline", () => {
	test("uses remaining wall time while preserving the original timeout label", () => {
		const timing = resolveSubagentExecutionTiming({
			now: Date.parse("2026-07-20T12:00:04.000Z"),
			timeoutMs: 6_000,
			executionDeadlineAt: "2026-07-20T12:00:10.000Z",
			executionTimeoutMs: 10_000,
		});

		expect(timing).toEqual({
			remainingTimeoutMs: 6_000,
			timeoutLabelMs: 10_000,
			executionDeadlineAt: "2026-07-20T12:00:10.000Z",
			expiredAtMount: false,
		});
	});

	test("mounts an expired recovered Agent as an immediate original timeout", () => {
		const timing = resolveSubagentExecutionTiming({
			now: Date.parse("2026-07-20T12:00:11.000Z"),
			timeoutMs: 0,
			executionDeadlineAt: "2026-07-20T12:00:10.000Z",
			executionTimeoutMs: 10_000,
		});

		expect(timing.remainingTimeoutMs).toBe(0);
		expect(timing.timeoutLabelMs).toBe(10_000);
		expect(timing.expiredAtMount).toBe(true);
	});
});

describe("subagent update execution lease", () => {
	test("reuses a transferred tool lease after final admission closes", () => {
		const coordinatorLease = updateCoordinator.tryAcquireFinalUpdateExecution(
			"resumable",
			"parent-agent",
		);
		expect(coordinatorLease).not.toBeNull();
		updateCoordinator.scheduleUpdate("9.9.9");
		updateCoordinator.beginQuiescingTools();
		expect(updateCoordinator.tryAcquireFinalUpdateExecution("resumable", "late-agent")).toBeNull();

		let transferCount = 0;
		let reboundNarratorId: string | undefined;
		const claimed = claimSubagentUpdateExecutionLease(
			{
				kind: "resumable",
				setNarratorId: (narratorId) => {
					reboundNarratorId = narratorId;
					coordinatorLease?.setNarratorId(narratorId);
				},
				transfer: () => {
					transferCount++;
					return true;
				},
				release: () => coordinatorLease?.release(),
			},
			"resumable",
			"resumed-agent",
		);

		expect(claimed).not.toBeNull();
		expect(transferCount).toBe(1);
		expect(reboundNarratorId).toBe("resumed-agent");
		claimed?.release();
	});

	test("self-admits only when no existing lease is supplied", () => {
		const claimed = claimSubagentUpdateExecutionLease(undefined, "ordinary", "manual-resume");
		expect(claimed?.kind).toBe("ordinary");
		claimed?.release();
	});

	test("exposes a running background Agent to planned-update checkpoint inventory", () => {
		const unregister = registerRunningSubagentExecution({
			subagentId: "background-checkpoint-agent",
			parentNarratorId: "parent-agent",
			toolUseId: "background-checkpoint-tool",
			timeoutMs: 300_000,
			executionDeadlineAt: "2026-07-20T12:05:00.000Z",
			background: true,
		});
		try {
			expect(listRunningSubagentExecutions()).toContainEqual(
				expect.objectContaining({
					subagentId: "background-checkpoint-agent",
					toolUseId: "background-checkpoint-tool",
					background: true,
				}),
			);
		} finally {
			unregister();
		}
		expect(
			listRunningSubagentExecutions().some(
				(entry) => entry.subagentId === "background-checkpoint-agent",
			),
		).toBe(false);
	});
});

describe("background task status resolution", () => {
	test("execution timeout takes precedence over empty output or abort state", () => {
		expect(
			resolveBackgroundCompletionOutcome({
				timedOut: true,
				hasError: false,
				aborted: true,
			}),
		).toBe("timeout");
	});

	test("an aborted task is not treated as completed", () => {
		expect(
			resolveBackgroundCompletionOutcome({
				timedOut: false,
				hasError: false,
				aborted: true,
			}),
		).toBe("failed");
	});

	test("a completed historical run becomes continued while its narrator is active", () => {
		expect(
			resolveBackgroundTaskEffectiveStatus({
				taskStatus: "completed",
				currentNarratorStatus: "working",
			}),
		).toBe("continued");
	});

	test("active tracked child work remains visible after the agent run completes", () => {
		expect(
			resolveBackgroundTaskEffectiveStatus({
				taskStatus: "completed",
				currentNarratorStatus: "idle",
				activeChildTaskCount: 2,
			}),
		).toBe("child_running");
	});

	test("a stale timeout row becomes completed after the subagent finishes a resumed run", () => {
		expect(
			resolveBackgroundTaskEffectiveStatus({
				taskStatus: "timeout",
				currentNarratorStatus: "idle",
				currentNarratorIsBackground: false,
				currentNarratorSubstatus: ["unread"],
			}),
		).toBe("completed");
	});

	test("a genuine background execution timeout remains a timeout", () => {
		expect(
			resolveBackgroundTaskEffectiveStatus({
				taskStatus: "timeout",
				currentNarratorStatus: "idle",
				currentNarratorIsBackground: true,
				currentNarratorBackgroundStatus: "failed",
				currentNarratorSubstatus: ["error"],
				currentNarratorErrorMessage: "execution limit reached",
			}),
		).toBe("timeout");
	});

	test("a resumed subagent error supersedes the previous timeout", () => {
		expect(
			resolveBackgroundTaskEffectiveStatus({
				taskStatus: "timeout",
				currentNarratorStatus: "idle",
				currentNarratorIsBackground: false,
				currentNarratorSubstatus: ["error"],
				currentNarratorErrorMessage: "follow-up failed",
			}),
		).toBe("failed");
	});
});

async function seedAgentTaskEntities(suffix: string): Promise<{
	parentNarratorId: string;
	subagentNarratorId: string;
}> {
	const parentNarratorId = `bg-parent-${suffix}`;
	const subagentNarratorId = `bg-subagent-${suffix}`;
	const now = new Date().toISOString();
	await db.insert(narrators).values([
		{
			id: parentNarratorId,
			type: "primary",
			variant: "primary",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: subagentNarratorId,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId,
			createdAt: now,
			updatedAt: now,
		},
	]);
	return { parentNarratorId, subagentNarratorId };
}

describe("background agent task lifecycle", () => {
	test("syncs a resumed completion over a previous timeout", async () => {
		const { parentNarratorId, subagentNarratorId } = await seedAgentTaskEntities("resume");
		await backgroundTaskService.createAgentTask({
			id: subagentNarratorId,
			parentNarratorId,
			subagentNarratorId,
			subagentType: "general",
			toolUseId: "origin-tool",
		});
		await backgroundTaskService.markTimedOut(subagentNarratorId, "old timeout");
		const timedOut = await backgroundTaskService.getById(subagentNarratorId);
		const version = getBackgroundTaskTerminalVersion(timedOut);
		expect(version).not.toBeNull();

		const reconciled = await backgroundTaskService.finalizeResumedAgentTask({
			taskId: subagentNarratorId,
			version: version as NonNullable<typeof version>,
			status: "completed",
			output: "actual completed result",
		});
		expect(reconciled).toBe(true);
		await expect(backgroundTaskService.getById(subagentNarratorId)).resolves.toMatchObject({
			status: "completed",
			output: "actual completed result",
		});
	});

	test("list summaries repair a stale timeout badge from the current narrator state", async () => {
		const { parentNarratorId, subagentNarratorId } = await seedAgentTaskEntities("summary");
		await backgroundTaskService.createAgentTask({
			id: subagentNarratorId,
			parentNarratorId,
			subagentNarratorId,
			subagentType: "general",
			toolUseId: "summary-tool",
		});
		await backgroundTaskService.markTimedOut(subagentNarratorId, "stale timeout");
		await db
			.update(narrators)
			.set({
				isBackground: false,
				backgroundStatus: null,
				status: "idle",
				substatus: JSON.stringify(["unread"]),
				errorMessage: null,
			})
			.where(eq(narrators.id, subagentNarratorId));

		const summaries = await backgroundTaskService.listSummariesByParent(parentNarratorId);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({ effectiveStatus: "completed", output: null });
	});

	test("reuses a terminal row and rejects an old continuation version", async () => {
		const { parentNarratorId, subagentNarratorId } = await seedAgentTaskEntities("reuse");
		await backgroundTaskService.createAgentTask({
			id: subagentNarratorId,
			parentNarratorId,
			subagentNarratorId,
			subagentType: "general",
			toolUseId: "first-tool",
		});
		await backgroundTaskService.markTimedOut(subagentNarratorId, "first timeout");
		const oldVersion = getBackgroundTaskTerminalVersion(
			await backgroundTaskService.getById(subagentNarratorId),
		);
		expect(oldVersion).not.toBeNull();

		const restarted = await backgroundTaskService.createAgentTask({
			id: subagentNarratorId,
			parentNarratorId,
			subagentNarratorId,
			subagentType: "general",
			toolUseId: "second-tool",
		});
		expect(restarted.status).toBe("running");
		expect(restarted.output).toBeNull();
		expect(
			await backgroundTaskService.finalizeResumedAgentTask({
				taskId: subagentNarratorId,
				version: oldVersion as NonNullable<typeof oldVersion>,
				status: "completed",
				output: "stale result",
			}),
		).toBe(false);
		await expect(backgroundTaskService.getById(subagentNarratorId)).resolves.toMatchObject({
			status: "running",
			toolUseId: "second-tool",
		});
	});

	test("cancelling a recovered Agent aborts its registered persistent controller", async () => {
		const { parentNarratorId, subagentNarratorId } = await seedAgentTaskEntities("cancel-resume");
		await db
			.update(narrators)
			.set({ isBackground: true, backgroundStatus: "running", status: "working" })
			.where(eq(narrators.id, subagentNarratorId));
		await backgroundTaskService.createAgentTask({
			id: subagentNarratorId,
			parentNarratorId,
			subagentNarratorId,
			subagentType: "general",
		});
		const staleController = new AbortController();
		const controller = new AbortController();
		backgroundTaskService.registerAbortController(subagentNarratorId, staleController);
		backgroundTaskService.registerAbortController(subagentNarratorId, controller);
		backgroundTaskService.unregisterAbortController(subagentNarratorId, staleController);

		expect(
			await backgroundTaskService.markFailed(
				subagentNarratorId,
				"stale runner failure",
				undefined,
				staleController,
			),
		).toBe(false);
		await expect(backgroundTaskService.getById(subagentNarratorId)).resolves.toMatchObject({
			status: "running",
		});

		expect(await backgroundTaskService.cancel(subagentNarratorId)).toBe(true);
		expect(staleController.signal.aborted).toBe(false);
		expect(controller.signal.aborted).toBe(true);
		await expect(backgroundTaskService.getById(subagentNarratorId)).resolves.toMatchObject({
			status: "cancelled",
		});
	});

	test("does not clean a terminal task while its subagent continues in foreground", async () => {
		const { parentNarratorId, subagentNarratorId } = await seedAgentTaskEntities("cleanup-guard");
		await backgroundTaskService.createAgentTask({
			id: subagentNarratorId,
			parentNarratorId,
			subagentNarratorId,
			subagentType: "general",
		});
		await backgroundTaskService.markTimedOut(subagentNarratorId, "old timeout");
		backgroundTaskService.beginAgentContinuation(subagentNarratorId);
		expect(await backgroundTaskService.cleanupCompleted(-1)).toBe(0);
		await expect(backgroundTaskService.getById(subagentNarratorId)).resolves.not.toBeNull();
		backgroundTaskService.endAgentContinuation(subagentNarratorId);
		expect(await backgroundTaskService.cleanupCompleted(-1)).toBe(1);
	});

	test("preserves protected running Agent rows during planned-update startup", async () => {
		const { parentNarratorId, subagentNarratorId } = await seedAgentTaskEntities("protected");
		await db
			.update(narrators)
			.set({ isBackground: true, backgroundStatus: "running", status: "working" })
			.where(eq(narrators.id, subagentNarratorId));
		await backgroundTaskService.createAgentTask({
			id: subagentNarratorId,
			parentNarratorId,
			subagentNarratorId,
			subagentType: "general",
		});

		expect(
			await backgroundTaskService.recoverStaleAgentTasksAfterRestart(new Set([subagentNarratorId])),
		).toBe(0);
		await expect(backgroundTaskService.getById(subagentNarratorId)).resolves.toMatchObject({
			status: "running",
		});
		const protectedNarrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, subagentNarratorId),
		});
		expect(protectedNarrator).toMatchObject({
			isBackground: true,
			backgroundStatus: "running",
		});
	});

	test("serves a bounded live tail for a running bash task, then the stored tail", async () => {
		const { parentNarratorId } = await seedAgentTaskEntities("tail");
		const taskId = "bash-tail-task";
		await backgroundTaskService.createBashTask({
			id: taskId,
			parentNarratorId,
			command: "echo hello && sleep 1",
			title: "tail probe",
		});

		// Nothing emitted yet: a running task reports an empty live tail, not the
		// (still null) stored column.
		await expect(backgroundTaskService.readOutputTail(taskId)).resolves.toMatchObject({
			status: "running",
			type: "bash",
			command: "echo hello && sleep 1",
			tail: "",
			totalChars: 0,
			truncated: false,
			live: true,
		});

		// Chunk boundaries must not leak into the tail: ask for fewer chars than the
		// last chunk contains and the result is still a clean suffix of the stream.
		backgroundTaskService.appendOutput(taskId, "aaaa");
		backgroundTaskService.appendOutput(taskId, "bbbb");
		backgroundTaskService.appendOutput(taskId, "cccc");
		const partial = await backgroundTaskService.readOutputTail(taskId, 6);
		expect(partial).toMatchObject({
			tail: "bbcccc",
			totalChars: 12,
			truncated: true,
			live: true,
		});

		// A tail wider than the buffer returns everything without duplication.
		await expect(backgroundTaskService.readOutputTail(taskId, 100)).resolves.toMatchObject({
			tail: "aaaabbbbcccc",
			totalChars: 12,
			truncated: false,
		});

		// Once terminal the live buffer is gone; the tail comes from the stored column.
		await backgroundTaskService.markCompleted(taskId, "aaaabbbbcccc\ndone", 0);
		const finished = await backgroundTaskService.readOutputTail(taskId, 5);
		expect(finished).toMatchObject({
			status: "completed",
			exitCode: 0,
			tail: "\ndone",
			totalChars: 17,
			truncated: true,
			live: false,
		});
	});

	test("readOutputTail reports a missing task as null", async () => {
		await expect(backgroundTaskService.readOutputTail("no-such-task")).resolves.toBeNull();
	});

	test("recovers stale running Agent rows after an unclean restart", async () => {
		const { parentNarratorId, subagentNarratorId } = await seedAgentTaskEntities("restart");
		await db
			.update(narrators)
			.set({ isBackground: true, backgroundStatus: "running" })
			.where(eq(narrators.id, subagentNarratorId));
		await backgroundTaskService.createAgentTask({
			id: subagentNarratorId,
			parentNarratorId,
			subagentNarratorId,
			subagentType: "general",
		});

		expect(await backgroundTaskService.recoverStaleAgentTasksAfterRestart()).toBe(1);
		await expect(backgroundTaskService.getById(subagentNarratorId)).resolves.toMatchObject({
			status: "cancelled",
		});
		const recoveredNarrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, subagentNarratorId),
		});
		expect(recoveredNarrator).toMatchObject({
			isBackground: false,
			backgroundStatus: "cancelled",
		});
	});
});
