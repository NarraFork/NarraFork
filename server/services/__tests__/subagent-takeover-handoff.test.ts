import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { generateId } from "../../lib/id";
import { drainPendingInjections, takePendingInjectionBatch } from "../parent-injection-queue";
import { getDetachableMap } from "../subagent-detach";
import * as executor from "../subagent-executor";
import { clearManualOverrideRuntimes, isManualOverride } from "../subagent-manual-override";
import {
	executeBackgroundTask,
	startContinuedSubagent,
	startForegroundRun,
} from "../subagent-runner";
import {
	clearTakenOver,
	isTakenOver,
	markPendingBackgroundFinalize,
	markTakenOver,
} from "../subagent-takeover";

const ids: string[] = [];
afterEach(async () => {
	clearManualOverrideRuntimes();
	for (const id of ids) {
		clearTakenOver(id);
		drainPendingInjections(id);
	}
	if (ids.length) await db.delete(narrators).where(inArray(narrators.id, ids));
	ids.length = 0;
});

async function fixture() {
	const parentId = generateId();
	const childId = generateId();
	ids.push(childId, parentId);
	const now = new Date().toISOString();
	await db.insert(narrators).values([
		{ id: parentId, variant: "primary", status: "working", createdAt: now, updatedAt: now },
		{
			id: childId,
			variant: "subagent:general",
			type: "subagent",
			parentNarratorId: parentId,
			status: "idle",
			model: "claude-sonnet-4-6",
			createdAt: now,
			updatedAt: now,
		},
	]);
	return { parentId, childId };
}

// Attribution contract on the modern runtime: executor returns finalUserId, and
// durable task notices project that principal through the mailbox ledger.
describe("background result user attribution", () => {
	for (const finalUserId of ["B", null] as const) {
		test(`executor finalUserId ${finalUserId} is projected onto the parent batch`, async () => {
			const { parentId, childId } = await fixture();
			const { recordTaskNoticeUser } = await import("../parent-injection-queue");
			const { createMailboxStore } = await import("../agent-runtime/mailbox");
			const execute = spyOn(executor, "executeSubagent").mockResolvedValue({
				finalText: "final result",
				finalUserId,
				hasError: false,
				allowInboxWake: true,
			});
			try {
				const result = await executeSubagentForTest({
					narratorId: childId,
					parentNarratorId: parentId,
					userId: "A",
				});
				expect(result.finalUserId).toBe(finalUserId);
				// Production finalize/announce write the durable attribution ledger.
				recordTaskNoticeUser(childId, result.finalUserId);
				const store = createMailboxStore(db);
				const enqueued = store.enqueue({
					kind: "task_notice",
					noticeKind: "agent",
					narratorId: parentId,
					text: `[System] Background agent "${childId}" completed.`,
					projectedByteSize: 128,
					sourceKey: `test-notice:${childId}:attribution`,
					metadata: {
						producerKind: "agent",
						taskId: childId,
						logicalRunId: "run-attr",
						eventKind: "completed",
					},
				});
				expect(enqueued.status).toBe("accepted");
				const batch = await takePendingInjectionBatch(parentId);
				expect(batch?.userId).toBe(finalUserId);
				expect(batch?.entries).toHaveLength(1);
			} finally {
				execute.mockRestore();
			}
		});
	}

	test("runner forwards the dispatch user into executeSubagent", async () => {
		const { parentId, childId } = await fixture();
		const execute = spyOn(executor, "executeSubagent").mockResolvedValue({
			finalText: "ok",
			finalUserId: "B",
			hasError: false,
			allowInboxWake: true,
		});
		try {
			const run = startForegroundRun(
				{
					publicationRun: {
						producerKind: "agent",
						taskId: childId,
						logicalRunId: "run-fwd",
						recipientId: parentId,
					},
					subagentId: childId,
					parentNarratorId: parentId,
					toolUseId: "origin-tool",
					subagentType: "general",
					prompt: "finish",
					userId: "A",
					cwd: process.env.HOME as string,
					model: "anthropic:claude-sonnet-4-6",
					provider: "anthropic",
					locale: "en",
					signal: new AbortController().signal,
					systemPrompt: "test",
					initialHistory: [],
					customDef: null,
				},
				undefined,
			);
			await run.terminal.catch(() => undefined);
			expect(execute.mock.calls[0]?.[0].userId).toBe("A");
			expect((await run.terminal.catch(() => null))?.finalUserId).toBe("B");
		} finally {
			execute.mockRestore();
		}
	});
});

async function executeSubagentForTest(opts: {
	narratorId: string;
	parentNarratorId: string;
	userId: string | null;
}) {
	const { executeSubagent } = await import("../subagent-executor");
	return executeSubagent({
		narratorId: opts.narratorId,
		parentNarratorId: opts.parentNarratorId,
		toolUseId: "origin-tool",
		subagentType: "general",
		prompt: "finish",
		userId: opts.userId,
		cwd: process.env.HOME as string,
		model: "anthropic:claude-sonnet-4-6",
		provider: "anthropic",
		locale: "en",
		signal: new AbortController().signal,
		systemPrompt: "test",
		initialHistory: [],
		initialTrailingToolResults: [],
	});
}

describe("continued subagent completion ownership", () => {
	test("announceResumedBackgroundTask records the resuming user on the notice ledger", async () => {
		const { parentId, childId } = await fixture();
		const { announceResumedBackgroundTask } = await import("../subagent-runner");
		await announceResumedBackgroundTask({
			subagentId: childId,
			parentNarratorId: parentId,
			userId: "A",
			status: "completed",
			wakeParent: true,
			locale: "en",
		});
		const { createMailboxStore } = await import("../agent-runtime/mailbox");
		const store = createMailboxStore(db);
		store.enqueue({
			kind: "task_notice",
			noticeKind: "agent",
			narratorId: parentId,
			text: "[System] pointer",
			projectedByteSize: 64,
			sourceKey: `test-notice:${childId}:announce`,
			metadata: {
				producerKind: "agent",
				taskId: childId,
				logicalRunId: "run-ann",
				eventKind: "completed",
			},
		});
		const batch = await takePendingInjectionBatch(parentId);
		expect(batch?.userId).toBe("A");
		expect(await takePendingInjectionBatch(parentId, "B")).toBeNull();
	});
});
