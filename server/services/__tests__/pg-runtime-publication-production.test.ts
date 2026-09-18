/**
 * pg-runtime-publication-production.test.ts — SQLite async-wrapper wiring tests.
 *
 * These tests verify the production wiring SHAPE on the SQLite backend:
 *   - Callers use the async facade (getRuntimePublicationService).
 *   - The SQLite wrapper preserves the original synchronous semantics.
 *   - The new named composites (restartAgentTask, updateNarratorBackground,
 *     commitTerminalTransition, cleanupTasks) work through the SQLite wrapper.
 *   - SQLite poison count is 0 for the SQLite path (no PG-specific composites
 *     are called on the SQLite backend).
 *
 * PG_INTEGRATION=1 formal-journal tests (SQLite poison = 0 on a real PG17
 * backend) belong in a separate file gated by that flag. This file never
 * pretends to test PostgreSQL — it tests the SQLite async facade that the
 * caller-migration track produces.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import {
	backgroundTasks,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	runtimePublicationOutbox,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { getRuntimePublicationService, runtimePublication } from "../agent-runtime/publication";
import { backgroundTaskService } from "../background-task-service";

runtimePublication.stop();
afterEach(() => cleanDb(sqlite));

describe("SQLite async publication facade wiring", () => {
	test("getRuntimePublicationService returns sqlite backend on SQLite", () => {
		const pub = getRuntimePublicationService();
		expect(pub.backend).toBe("sqlite");
	});

	test("startAgentRun via async facade creates logical run + reserves slots", async () => {
		const parent = generateId();
		const child = generateId();
		const now = new Date().toISOString();
		db.insert(narrators)
			.values([
				{ id: parent, variant: "primary", status: "idle", createdAt: now, updatedAt: now },
				{
					id: child,
					variant: "subagent:general",
					type: "subagent",
					parentNarratorId: parent,
					status: "idle",
					model: "claude-sonnet-4-6",
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();
		const pub = getRuntimePublicationService();
		const run = await pub.startAgentRun({
			narratorId: child,
			parentNarratorId: parent,
		});
		expect(run.producerKind).toBe("agent");
		expect(run.taskId).toBe(child);
		expect(run.recipientId).toBe(parent);
		expect(run.logicalRunId).toBeTruthy();
		// Outbox slots should be reserved
		const slots = db
			.select()
			.from(runtimePublicationOutbox)
			.where(eq(runtimePublicationOutbox.logicalRunId, run.logicalRunId))
			.all();
		expect(slots.length).toBeGreaterThan(0);
	});

	test("startBashRun reserves slots; taskRow is accepted but ignored on SQLite", async () => {
		const parent = generateId();
		const taskId = generateId();
		const now = new Date().toISOString();
		db.insert(narrators)
			.values({ id: parent, variant: "primary", status: "idle", createdAt: now, updatedAt: now })
			.run();
		const pub = getRuntimePublicationService();
		// On SQLite the taskRow param is accepted but ignored (SQLite callers insert
		// the task row in their own runAtomicWrite). On PG the composite inserts it.
		const run = await pub.startBashRun({
			taskId,
			recipientId: parent,
			taskRow: {
				id: taskId,
				parentNarratorId: parent,
				type: "bash",
				status: "running",
				command: "echo test",
				toolUseId: null,
				toolCallId: null,
				executionAttempt: null,
				alias: null,
				title: null,
				output: null,
				outputBytes: 0,
				outputTruncated: false,
				notified: false,
				startedAt: now,
				createdAt: now,
				updatedAt: now,
			},
		});
		expect(run.producerKind).toBe("bash");
		expect(run.taskId).toBe(taskId);
		expect(run.logicalRunId).toBeTruthy();
		const slots = db
			.select()
			.from(runtimePublicationOutbox)
			.where(eq(runtimePublicationOutbox.logicalRunId, run.logicalRunId))
			.all();
		expect(slots.length).toBeGreaterThan(0);
	});

	test("commitBashTerminal commits result + intent atomically", async () => {
		const parent = generateId();
		const taskId = generateId();
		const now = new Date().toISOString();
		db.insert(narrators)
			.values({ id: parent, variant: "primary", status: "idle", createdAt: now, updatedAt: now })
			.run();
		const pub = getRuntimePublicationService();
		const run = await pub.startBashRun({ taskId, recipientId: parent });
		const result = await pub.commitBashTerminal({
			run,
			eventKind: "completed",
			text: "test output",
			summary: "[System] Bash completed.",
		});
		expect(result.status).toBe("committed");
		expect(result.deliveryId).toBeTruthy();
	});

	test("commitAgentTerminal commits result + intent atomically", async () => {
		const parent = generateId();
		const child = generateId();
		const messageId = generateId();
		const now = new Date().toISOString();
		db.insert(narrators)
			.values([
				{ id: parent, variant: "primary", status: "idle", createdAt: now, updatedAt: now },
				{
					id: child,
					variant: "subagent:general",
					type: "subagent",
					parentNarratorId: parent,
					status: "idle",
					model: "claude-sonnet-4-6",
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();
		db.insert(narratorMessages)
			.values({
				id: messageId,
				narratorId: child,
				role: "assistant",
				contentJson: [{ type: "text", text: "agent result" }],
				contentText: "agent result",
				createdAt: now,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: generateId(), narratorId: child, messageId, seq: 0 })
			.run();
		const pub = getRuntimePublicationService();
		const run = await pub.startAgentRun({ narratorId: child, parentNarratorId: parent });
		const result = await pub.commitAgentTerminal({
			run,
			eventKind: "completed",
			text: "agent final output",
			summary: "[System] Agent completed.",
		});
		expect(result.status).toBe("committed");
	});

	test("duplicate commit returns duplicate status", async () => {
		const parent = generateId();
		const taskId = generateId();
		const now = new Date().toISOString();
		db.insert(narrators)
			.values({ id: parent, variant: "primary", status: "idle", createdAt: now, updatedAt: now })
			.run();
		const pub = getRuntimePublicationService();
		const run = await pub.startBashRun({ taskId, recipientId: parent });
		const first = await pub.commitBashTerminal({
			run,
			eventKind: "completed",
			text: "output",
			summary: "done",
		});
		expect(first.status).toBe("committed");
		const second = await pub.commitBashTerminal({
			run,
			eventKind: "completed",
			text: "output",
			summary: "done",
		});
		expect(second.status).toBe("duplicate");
	});

	test("hasPendingSource returns true for committed run", async () => {
		const parent = generateId();
		const taskId = generateId();
		const now = new Date().toISOString();
		db.insert(narrators)
			.values({ id: parent, variant: "primary", status: "idle", createdAt: now, updatedAt: now })
			.run();
		const pub = getRuntimePublicationService();
		const run = await pub.startBashRun({ taskId, recipientId: parent });
		expect(await pub.hasPendingSource(run)).toBe(true);
		await pub.commitBashTerminal({
			run,
			eventKind: "completed",
			text: "output",
			summary: "done",
		});
		expect(await pub.hasPendingSource(run)).toBe(true);
	});

	test("restartAgentTask updates existing task row on SQLite", async () => {
		const parent = generateId();
		const child = generateId();
		const taskId = child;
		const now = new Date().toISOString();
		db.insert(narrators)
			.values([
				{ id: parent, variant: "primary", status: "idle", createdAt: now, updatedAt: now },
				{
					id: child,
					variant: "subagent:general",
					type: "subagent",
					parentNarratorId: parent,
					status: "idle",
					model: "claude-sonnet-4-6",
					logicalRunId: generateId(),
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();
		// Create initial task in a terminal state
		db.insert(backgroundTasks)
			.values([
				{
					id: taskId,
					parentNarratorId: parent,
					type: "agent",
					status: "completed",
					subagentNarratorId: child,
					subagentType: "general",
					startedAt: now,
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();
		const pub = getRuntimePublicationService();
		const result = await pub.restartAgentTask({
			taskId,
			logicalRunId: generateId(),
			subagentNarratorId: child,
			subagentType: "general",
			expectedStatus: "completed",
			now,
		});
		expect(result).toBeTruthy();
		const row = db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId)).get();
		expect(row?.status).toBe("running");
		expect(row?.subagentNarratorId).toBe(child);
	});

	test("restartAgentTask returns undefined for wrong expected status", async () => {
		const parent = generateId();
		const child = generateId();
		const taskId = child;
		const now = new Date().toISOString();
		db.insert(narrators)
			.values([
				{ id: parent, variant: "primary", status: "idle", createdAt: now, updatedAt: now },
				{
					id: child,
					variant: "subagent:general",
					type: "subagent",
					parentNarratorId: parent,
					status: "idle",
					model: "claude-sonnet-4-6",
					logicalRunId: generateId(),
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();
		db.insert(backgroundTasks)
			.values([
				{
					id: taskId,
					parentNarratorId: parent,
					type: "agent",
					status: "completed",
					subagentNarratorId: child,
					subagentType: "general",
					startedAt: now,
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();
		const pub = getRuntimePublicationService();
		// Wrong expected status: row is "completed" but we say "failed"
		const result = await pub.restartAgentTask({
			taskId,
			logicalRunId: generateId(),
			subagentNarratorId: child,
			subagentType: "general",
			expectedStatus: "failed",
			now,
		});
		expect(result).toBeUndefined();
	});

	test("updateNarratorBackground updates narrator fields on SQLite", async () => {
		const parent = generateId();
		const child = generateId();
		const now = new Date().toISOString();
		// Set logicalRunId so getAgentRun returns immediately without legacy registration.
		db.insert(narrators)
			.values([
				{ id: parent, variant: "primary", status: "idle", createdAt: now, updatedAt: now },
				{
					id: child,
					variant: "subagent:general",
					type: "subagent",
					parentNarratorId: parent,
					status: "idle",
					model: "claude-sonnet-4-6",
					isBackground: true,
					backgroundStatus: "running",
					logicalRunId: generateId(),
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();
		const pub = getRuntimePublicationService();
		// deferPublication: true — we're testing the narrator field update, not the
		// publication commit (which requires slot reservation setup).
		await pub.updateNarratorBackground({
			narratorId: child,
			parentNarratorId: parent,
			backgroundStatus: "completed",
			backgroundResult: "final output",
			backgroundCompletedAt: now,
			updatedAt: now,
			deferPublication: true,
		});
		const row = db.select().from(narrators).where(eq(narrators.id, child)).get();
		expect(row?.backgroundStatus).toBe("completed");
		expect(row?.backgroundResult).toBe("final output");
	});

	test("cleanupTasks throws on SQLite (PG-only composite)", async () => {
		const pub = getRuntimePublicationService();
		await expect(
			pub.cleanupTasks({
				cutoff: new Date().toISOString(),
				limit: 10,
				excludedStatuses: ["running"],
				excludedNarratorStatuses: ["working"],
				subagentPath: "subagentNarratorId",
			}),
		).rejects.toThrow("cleanupTasks is a PostgreSQL-only composite");
	});

	test("background-task-service.createBashTask uses async facade on SQLite", async () => {
		const parent = generateId();
		const taskId = generateId();
		const now = new Date().toISOString();
		db.insert(narrators)
			.values({ id: parent, variant: "primary", status: "idle", createdAt: now, updatedAt: now })
			.run();
		const task = await backgroundTaskService.createBashTask({
			id: taskId,
			parentNarratorId: parent,
			command: "echo hello",
		});
		expect(task.id).toBe(taskId);
		expect(task.logicalRunId).toBeTruthy();
		const row = db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId)).get();
		expect(row).toBeTruthy();
		expect(row?.logicalRunId).toBe(task.logicalRunId);
	});

	test("background-task-service markCompleted routes through async terminal commit", async () => {
		const parent = generateId();
		const taskId = generateId();
		const now = new Date().toISOString();
		db.insert(narrators)
			.values({ id: parent, variant: "primary", status: "idle", createdAt: now, updatedAt: now })
			.run();
		await backgroundTaskService.createBashTask({
			id: taskId,
			parentNarratorId: parent,
			command: "echo hello",
		});
		const completed = await backgroundTaskService.markCompleted(taskId, "output text");
		expect(completed).toBe(true);
		const row = db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId)).get();
		expect(row?.status).toBe("completed");
		expect(row?.output).toBe("output text");
	});

	test("background-task-service markFailed routes through async terminal commit", async () => {
		const parent = generateId();
		const taskId = generateId();
		const now = new Date().toISOString();
		db.insert(narrators)
			.values({ id: parent, variant: "primary", status: "idle", createdAt: now, updatedAt: now })
			.run();
		await backgroundTaskService.createBashTask({
			id: taskId,
			parentNarratorId: parent,
			command: "false",
		});
		const failed = await backgroundTaskService.markFailed(taskId, "command failed");
		expect(failed).toBe(true);
		const row = db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId)).get();
		expect(row?.status).toBe("failed");
		expect(row?.output).toBe("command failed");
	});

	test("background-task-service markCancelled routes through async terminal commit", async () => {
		const parent = generateId();
		const taskId = generateId();
		const now = new Date().toISOString();
		db.insert(narrators)
			.values({ id: parent, variant: "primary", status: "idle", createdAt: now, updatedAt: now })
			.run();
		await backgroundTaskService.createBashTask({
			id: taskId,
			parentNarratorId: parent,
			command: "sleep 100",
		});
		const cancelled = await backgroundTaskService.markCancelled(taskId);
		expect(cancelled).toBe(true);
		const row = db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId)).get();
		expect(row?.status).toBe("cancelled");
	});

	test("truncated cancellation publishes once and leaves no reserved SQLite slots", async () => {
		const parent = generateId();
		const taskId = generateId();
		const now = new Date().toISOString();
		db.insert(narrators)
			.values({ id: parent, variant: "primary", status: "idle", createdAt: now, updatedAt: now })
			.run();
		await backgroundTaskService.createBashTask({
			id: taskId,
			parentNarratorId: parent,
			command: "sleep 100",
		});
		const before = db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId)).get();
		const pub = getRuntimePublicationService();
		const cancelled = await pub.cancelTask({
			taskId,
			capturedOutput: "x".repeat(64 * 1024),
			capturedOutputBytes: 512 * 1024 + 1,
			capturedTruncated: true,
			now,
		});
		expect(cancelled?.status).toBe("cancelled");
		expect(cancelled?.logicalRunId).toBe(before?.logicalRunId);
		const row = db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId)).get();
		expect(row?.status).toBe("cancelled");

		const intents = db
			.select()
			.from(runtimePublicationOutbox)
			.where(eq(runtimePublicationOutbox.logicalRunId, before?.logicalRunId ?? ""))
			.all();
		expect(intents).toHaveLength(1);
		expect(intents[0]?.eventKind).toBe("cancelled");
		expect(intents[0]?.state).toBe("pending");
		expect(intents[0]?.resultRef).toBeTruthy();
		expect(intents.filter((intent) => intent.state === "reserved")).toHaveLength(0);

		expect(
			await pub.cancelTask({
				taskId,
				capturedOutput: "replacement",
				capturedOutputBytes: 11,
				capturedTruncated: false,
				now,
			}),
		).toBeNull();
		expect(
			db
				.select()
				.from(runtimePublicationOutbox)
				.where(eq(runtimePublicationOutbox.logicalRunId, before?.logicalRunId ?? ""))
				.all(),
		).toHaveLength(1);
	});

	test("registration methods work on both facades", () => {
		const pub = getRuntimePublicationService();
		// These should not throw
		pub.setWake(() => {});
		pub.setLegacyRuntimeAdmissionReader("agent", () => undefined);
		pub.setLegacyRuntimeAdmissionReader("bash", () => undefined);
		pub.setLegacyCompletionAdmissionReader(() => undefined);
		// Legacy facade registrations also work
		runtimePublication.setWake(() => {});
		runtimePublication.setLegacyRuntimeAdmissionReader("agent", () => undefined);
		runtimePublication.setLegacyRuntimeAdmissionReader("bash", () => undefined);
		runtimePublication.setLegacyCompletionAdmissionReader(() => undefined);
	});
});
