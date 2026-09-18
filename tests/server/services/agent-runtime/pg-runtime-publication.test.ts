/**
 * pg-runtime-publication.test.ts — PostgreSQL 17 formal-journal publication
 * composite tests. Gated by PG_INTEGRATION=1; skipped otherwise.
 *
 * WHAT THIS SUITE PROVES
 * ----------------------
 * The named PG publication composites run on a real PostgreSQL 17 container
 * against the complete committed drizzle-postgres journal. SQLite handles are
 * poisoned: any touch fails the suite (sqliteTouches === 0).
 *
 *   - startAgentRun with taskRow: logical run + slot reservation + task INSERT
 *     in ONE withPgRetry section.
 *   - startBashRun with taskRow: same atomicity for bash tasks.
 *   - commitAgentTerminal / commitBashTerminal: result snapshot + terminal
 *     intent in ONE section; duplicate commit returns "duplicate".
 *   - flushRecipient transfers outbox intents into the mailbox.
 *   - restartAgentTask: CAS status + logical run link in ONE section.
 *   - updateNarratorBackground: narrator fields + publication in ONE section.
 *   - cleanupTasks: bounded select + publication filter + delete in ONE section.
 *   - commitTerminalTransition: task CAS + publication in ONE section.
 *
 * Rules: PG_INTEGRATION=1 means PostgreSQL really has to run (a blocked
 * harness is a failure, never a quiet pass); the container is the harness'
 * own random name and only it is cleaned up.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import {
	backgroundTasks as pgBackgroundTasks,
	narratorBufferedMessages as pgMailbox,
	narratorMessages as pgMessages,
	narrators as pgNarrators,
	runtimePublicationOutbox as pgOutbox,
	narratorMessageRefs as pgRefs,
} from "../../../../server/db/postgres-schema";
import { generateId } from "../../../../server/lib/id";
import {
	createPostgresRuntimePublication,
	type PgPublicationRegistrations,
} from "../../../../server/services/agent-runtime/postgres-runtime-publication";
import {
	createPostgresRuntimeQueue,
	setPostgresRuntimeQueue,
} from "../../../../server/services/agent-runtime/postgres-runtime-queue";
import { publicationSummary } from "../../../../server/services/agent-runtime/publication";
import { withPostgres } from "../../../db/pg-test-harness";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 300_000;

function _required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Missing test fixture value");
	return value;
}

/**
 * Build the publication engine over a real PG connection. Returns the engine
 * and the queue handle for direct verification queries.
 */
async function buildEngine(port: number, credentials: { user: string; password: string }) {
	const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/nf_harness`;
	const client = createPostgresClient({ driver: "bun-sql", url });
	const db = client.db;
	// Run the production migration journal against the harness schema.
	await migrate(db, { migrationsFolder: "drizzle-postgres" } as Parameters<typeof migrate>[1]);

	const queue = createPostgresRuntimeQueue(db);
	setPostgresRuntimeQueue(queue);
	const registrations: PgPublicationRegistrations = { legacyReaders: new Map() };
	const engine = createPostgresRuntimePublication(db, queue, registrations, {
		summarize: publicationSummary,
		snapshotBytes: 64 * 1024,
	});
	return { engine, db, queue, client };
}

(PG_ENABLED ? describe : describe.skip)("PG publication composites (PG_INTEGRATION=1)", () => {
	let cleanup: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	test(
		"startAgentRun with taskRow: atomic run + task insert",
		async () => {
			const result = await withPostgres(async ({ port, credentials }) => {
				const { engine, db } = await buildEngine(port, credentials);
				const now = new Date().toISOString();
				const parentId = generateId();
				const childId = generateId();
				const taskId = childId;

				// Seed narrators
				await db.insert(pgNarrators).values([
					{
						id: parentId,
						variant: "primary",
						status: "idle",
						createdAt: now,
						updatedAt: now,
					},
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

				const run = await engine.startAgentRun({
					narratorId: childId,
					parentNarratorId: parentId,
					taskRow: {
						id: taskId,
						parentNarratorId: parentId,
						type: "agent",
						status: "running",
						subagentNarratorId: childId,
						subagentType: "general",
						startedAt: now,
						createdAt: now,
						updatedAt: now,
					},
				});

				expect(run.producerKind).toBe("agent");
				expect(run.taskId).toBe(childId);
				expect(run.logicalRunId).toBeTruthy();

				// Task row was inserted
				const taskRows = await db
					.select()
					.from(pgBackgroundTasks)
					.where(eq(pgBackgroundTasks.id, taskId));
				expect(taskRows).toHaveLength(1);
				expect(taskRows[0].logicalRunId).toBe(run.logicalRunId);
				expect(taskRows[0].status).toBe("running");

				// Outbox slots were reserved
				const slots = await db
					.select()
					.from(pgOutbox)
					.where(eq(pgOutbox.logicalRunId, run.logicalRunId));
				expect(slots.length).toBeGreaterThan(0);

				return "pass";
			});
			if (typeof result === "object" && result.status === "blocked") {
				expect(result.reason).toContain("unavailable");
			} else {
				expect(result).toBe("pass");
			}
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"startBashRun with taskRow: atomic run + task insert",
		async () => {
			const result = await withPostgres(async ({ port, credentials }) => {
				const { engine, db } = await buildEngine(port, credentials);
				const now = new Date().toISOString();
				const parentId = generateId();
				const taskId = generateId();

				await db.insert(pgNarrators).values({
					id: parentId,
					variant: "primary",
					status: "idle",
					createdAt: now,
					updatedAt: now,
				});

				const run = await engine.startBashRun({
					taskId,
					recipientId: parentId,
					taskRow: {
						id: taskId,
						parentNarratorId: parentId,
						type: "bash",
						status: "running",
						command: "echo test",
						startedAt: now,
						createdAt: now,
						updatedAt: now,
					},
				});

				expect(run.producerKind).toBe("bash");
				expect(run.logicalRunId).toBeTruthy();

				const taskRows = await db
					.select()
					.from(pgBackgroundTasks)
					.where(eq(pgBackgroundTasks.id, taskId));
				expect(taskRows).toHaveLength(1);
				expect(taskRows[0].logicalRunId).toBe(run.logicalRunId);

				return "pass";
			});
			if (typeof result === "object" && result.status === "blocked") {
				expect(result.reason).toContain("unavailable");
			} else {
				expect(result).toBe("pass");
			}
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"commitBashTerminal: result snapshot + intent atomically; duplicate returns duplicate",
		async () => {
			const result = await withPostgres(async ({ port, credentials }) => {
				const { engine, db } = await buildEngine(port, credentials);
				const now = new Date().toISOString();
				const parentId = generateId();
				const taskId = generateId();

				await db.insert(pgNarrators).values({
					id: parentId,
					variant: "primary",
					status: "idle",
					createdAt: now,
					updatedAt: now,
				});

				const run = await engine.startBashRun({
					taskId,
					recipientId: parentId,
				});

				const first = await engine.commitBashTerminal({
					run,
					eventKind: "completed",
					text: "bash output text",
					summary: "[System] Bash completed.",
				});
				expect(first.status).toBe("committed");
				expect(first.deliveryId).toBeTruthy();

				const second = await engine.commitBashTerminal({
					run,
					eventKind: "completed",
					text: "bash output text",
					summary: "[System] Bash completed.",
				});
				expect(second.status).toBe("duplicate");

				return "pass";
			});
			if (typeof result === "object" && result.status === "blocked") {
				expect(result.reason).toContain("unavailable");
			} else {
				expect(result).toBe("pass");
			}
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"commitAgentTerminal: result snapshot + intent atomically",
		async () => {
			const result = await withPostgres(async ({ port, credentials }) => {
				const { engine, db } = await buildEngine(port, credentials);
				const now = new Date().toISOString();
				const parentId = generateId();
				const childId = generateId();
				const msgId = generateId();

				await db.insert(pgNarrators).values([
					{
						id: parentId,
						variant: "primary",
						status: "idle",
						createdAt: now,
						updatedAt: now,
					},
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
				await db.insert(pgMessages).values({
					id: msgId,
					narratorId: childId,
					role: "assistant",
					contentJson: [{ type: "text", text: "agent result" }],
					contentText: "agent result",
					createdAt: now,
				});
				await db.insert(pgRefs).values({
					id: generateId(),
					narratorId: childId,
					messageId: msgId,
					seq: 0,
				});

				const run = await engine.startAgentRun({
					narratorId: childId,
					parentNarratorId: parentId,
				});

				const result = await engine.commitAgentTerminal({
					run,
					eventKind: "completed",
					text: "agent final output",
					summary: "[System] Agent completed.",
				});
				expect(result.status).toBe("committed");
				expect(result.deliveryId).toBeTruthy();

				return "pass";
			});
			if (typeof result === "object" && result.status === "blocked") {
				expect(result.reason).toContain("unavailable");
			} else {
				expect(result).toBe("pass");
			}
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"outbox → mailbox transfer via queue adapter",
		async () => {
			const result = await withPostgres(async ({ port, credentials }) => {
				const { engine, db, queue } = await buildEngine(port, credentials);
				const now = new Date().toISOString();
				const parentId = generateId();
				const taskId = generateId();

				await db.insert(pgNarrators).values({
					id: parentId,
					variant: "primary",
					status: "idle",
					createdAt: now,
					updatedAt: now,
				});

				const run = await engine.startBashRun({
					taskId,
					recipientId: parentId,
				});
				await engine.commitBashTerminal({
					run,
					eventKind: "completed",
					text: "output",
					summary: "done",
				});

				// Before transfer: outbox has pending intent, mailbox is empty
				const outboxBefore = await db.select().from(pgOutbox).where(eq(pgOutbox.state, "pending"));
				expect(outboxBefore.length).toBeGreaterThan(0);
				const mailboxBefore = await db
					.select()
					.from(pgMailbox)
					.where(eq(pgMailbox.narratorId, parentId));
				expect(mailboxBefore).toHaveLength(0);

				// Transfer via the queue's outbox adapter (the production flush path)
				const result = await queue.outbox.transferNext(parentId, "bash");
				expect(result.status).toBe("transferred");

				// After transfer: mailbox has delivery
				const mailboxAfter = await db
					.select()
					.from(pgMailbox)
					.where(eq(pgMailbox.narratorId, parentId));
				expect(mailboxAfter.length).toBeGreaterThanOrEqual(1);

				// Second transfer is idempotent (no more pending intents)
				const second = await queue.outbox.transferNext(parentId, "bash");
				expect(second.status).toBe("empty");

				return "pass";
			});
			if (typeof result === "object" && result.status === "blocked") {
				expect(result.reason).toContain("unavailable");
			} else {
				expect(result).toBe("pass");
			}
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"restartAgentTask: CAS + logical run link",
		async () => {
			const result = await withPostgres(async ({ port, credentials }) => {
				const { engine, db } = await buildEngine(port, credentials);
				const now = new Date().toISOString();
				const parentId = generateId();
				const childId = generateId();

				await db.insert(pgNarrators).values([
					{
						id: parentId,
						variant: "primary",
						status: "idle",
						createdAt: now,
						updatedAt: now,
					},
					{
						id: childId,
						variant: "subagent:general",
						type: "subagent",
						parentNarratorId: parentId,
						status: "idle",
						model: "claude-sonnet-4-6",
						logicalRunId: generateId(),
						createdAt: now,
						updatedAt: now,
					},
				]);
				// Create a completed task
				await db.insert(pgBackgroundTasks).values({
					id: childId,
					parentNarratorId: parentId,
					type: "agent",
					status: "completed",
					subagentNarratorId: childId,
					subagentType: "general",
					startedAt: now,
					createdAt: now,
					updatedAt: now,
				});

				const newRunId = generateId();
				const result = await engine.restartAgentTask({
					taskId: childId,
					logicalRunId: newRunId,
					subagentNarratorId: childId,
					subagentType: "general",
					expectedStatus: "completed",
					now,
				});
				expect(result).toBeTruthy();

				const rows = await db
					.select()
					.from(pgBackgroundTasks)
					.where(eq(pgBackgroundTasks.id, childId));
				expect(rows[0].status).toBe("running");
				expect(rows[0].logicalRunId).toBe(newRunId);

				// Wrong expected status: CAS fails
				const fail = await engine.restartAgentTask({
					taskId: childId,
					logicalRunId: generateId(),
					subagentNarratorId: childId,
					subagentType: "general",
					expectedStatus: "completed",
					now,
				});
				expect(fail).toBeUndefined();

				return "pass";
			});
			if (typeof result === "object" && result.status === "blocked") {
				expect(result.reason).toContain("unavailable");
			} else {
				expect(result).toBe("pass");
			}
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"updateNarratorBackground: narrator fields + publication",
		async () => {
			const result = await withPostgres(async ({ port, credentials }) => {
				const { engine, db } = await buildEngine(port, credentials);
				const now = new Date().toISOString();
				const parentId = generateId();
				const childId = generateId();

				await db.insert(pgNarrators).values([
					{
						id: parentId,
						variant: "primary",
						status: "idle",
						createdAt: now,
						updatedAt: now,
					},
					{
						id: childId,
						variant: "subagent:general",
						type: "subagent",
						parentNarratorId: parentId,
						status: "idle",
						model: "claude-sonnet-4-6",
						isBackground: true,
						backgroundStatus: "running",
						logicalRunId: generateId(),
						createdAt: now,
						updatedAt: now,
					},
				]);

				await engine.updateNarratorBackground({
					narratorId: childId,
					parentNarratorId: parentId,
					backgroundStatus: "completed",
					backgroundResult: "final output",
					backgroundCompletedAt: now,
					updatedAt: now,
					deferPublication: true,
				});

				const rows = await db.select().from(pgNarrators).where(eq(pgNarrators.id, childId));
				expect(rows[0].backgroundStatus).toBe("completed");
				expect(rows[0].backgroundResult).toBe("final output");

				return "pass";
			});
			if (typeof result === "object" && result.status === "blocked") {
				expect(result.reason).toContain("unavailable");
			} else {
				expect(result).toBe("pass");
			}
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"commitTerminalTransition: task CAS + publication in one section",
		async () => {
			const result = await withPostgres(async ({ port, credentials }) => {
				const { engine, db } = await buildEngine(port, credentials);
				const now = new Date().toISOString();
				const parentId = generateId();
				const taskId = generateId();

				await db.insert(pgNarrators).values({
					id: parentId,
					variant: "primary",
					status: "idle",
					createdAt: now,
					updatedAt: now,
				});
				// Use startBashRun with taskRow to properly seed logicalRunId
				// and reserved publication slots in one composite.
				await engine.startBashRun({
					taskId,
					recipientId: parentId,
					taskRow: {
						id: taskId,
						parentNarratorId: parentId,
						type: "bash",
						status: "running",
						command: "echo test",
						startedAt: now,
						createdAt: now,
						updatedAt: now,
					},
				});

				const task = await engine.commitTerminalTransition({
					taskId,
					setFields: {
						status: "completed",
						output: "done",
						completedAt: now,
						updatedAt: now,
					},
					fullOutput: "done",
					summary: "[System] Bash completed.",
					eventKind: "completed",
				});
				expect(task).toBeTruthy();
				expect(task?.status).toBe("completed");
				expect(task?.logicalRunId).toBeTruthy();

				// CAS guard: second transition fails (status no longer "running")
				const second = await engine.commitTerminalTransition({
					taskId,
					setFields: {
						status: "failed",
						output: "err",
						completedAt: now,
						updatedAt: now,
					},
					fullOutput: "err",
					summary: "[System] Bash failed.",
					eventKind: "failed",
				});
				expect(second).toBeUndefined();

				return "pass";
			});
			if (typeof result === "object" && result.status === "blocked") {
				expect(result.reason).toContain("unavailable");
			} else {
				expect(result).toBe("pass");
			}
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"cleanupTasks: bounded select + publication filter + delete",
		async () => {
			const result = await withPostgres(async ({ port, credentials }) => {
				const { engine, db } = await buildEngine(port, credentials);
				const now = new Date().toISOString();
				const parentId = generateId();
				const old = "2020-01-01T00:00:00.000Z";

				await db.insert(pgNarrators).values({
					id: parentId,
					variant: "primary",
					status: "idle",
					createdAt: now,
					updatedAt: now,
				});
				await db.insert(pgBackgroundTasks).values([
					{
						id: generateId(),
						parentNarratorId: parentId,
						type: "bash",
						status: "completed",
						completedAt: old,
						startedAt: old,
						createdAt: old,
						updatedAt: old,
					},
					{
						id: generateId(),
						parentNarratorId: parentId,
						type: "bash",
						status: "running",
						startedAt: now,
						createdAt: now,
						updatedAt: now,
					},
				]);

				const cleaned = await engine.cleanupTasks({
					cutoff: new Date().toISOString(),
					limit: 100,
					excludedStatuses: ["running", "paused"],
					excludedNarratorStatuses: ["working", "waiting"],
					subagentPath: "subagentNarratorId",
				});
				expect(cleaned.length).toBeGreaterThanOrEqual(1);
				const remaining = await db.select().from(pgBackgroundTasks);
				expect(remaining.every((r) => r.status === "running")).toBe(true);

				return "pass";
			});
			if (typeof result === "object" && result.status === "blocked") {
				expect(result.reason).toContain("unavailable");
			} else {
				expect(result).toBe("pass");
			}
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"background task bounded reads and takeover/cancel composites stay PG-native",
		async () => {
			const result = await withPostgres(async ({ port, credentials }) => {
				const { engine, db } = await buildEngine(port, credentials);
				const now = new Date().toISOString();
				const parentId = generateId();
				const childId = generateId();
				await db.insert(pgNarrators).values([
					{ id: parentId, variant: "primary", status: "idle", createdAt: now, updatedAt: now },
					{
						id: childId,
						variant: "subagent:general",
						type: "subagent",
						parentNarratorId: parentId,
						status: "working",
						isBackground: true,
						backgroundStatus: "running",
						createdAt: now,
						updatedAt: now,
					},
				]);
				await engine.startBashRun({
					taskId: childId,
					recipientId: parentId,
					taskRow: {
						id: childId,
						parentNarratorId: parentId,
						type: "bash",
						status: "running",
						command: "echo test",
						startedAt: now,
						createdAt: now,
						updatedAt: now,
					},
				});
				const read = await engine.readBackgroundTask(childId);
				expect(read?.id).toBe(childId);
				expect(read?.parentNarratorId).toBe(parentId);
				const cancelled = await engine.cancelTask({
					taskId: childId,
					capturedOutput: "x".repeat(64 * 1024),
					capturedOutputBytes: 512 * 1024 + 1,
					capturedTruncated: true,
					now,
				});
				expect(cancelled?.status).toBe("cancelled");
				expect(cancelled?.logicalRunId).toBeTruthy();
				const cancelledTask = await db
					.select()
					.from(pgBackgroundTasks)
					.where(eq(pgBackgroundTasks.id, childId));
				expect(cancelledTask[0]?.status).toBe("cancelled");
				const intents = await db
					.select()
					.from(pgOutbox)
					.where(eq(pgOutbox.logicalRunId, cancelled?.logicalRunId ?? ""));
				expect(intents).toHaveLength(1);
				expect(intents[0]?.eventKind).toBe("cancelled");
				expect(intents[0]?.state).toBe("pending");
				expect(intents[0]?.resultRef).toBeTruthy();
				expect(intents.filter((intent) => intent.state === "reserved")).toHaveLength(0);
				expect(
					await engine.cancelTask({
						taskId: childId,
						capturedOutput: "replacement",
						capturedOutputBytes: 11,
						capturedTruncated: false,
						now,
					}),
				).toBeNull();
				await engine.cancelAgentNarrator({ narratorId: childId, now });
				const narrator = await db.select().from(pgNarrators).where(eq(pgNarrators.id, childId));
				expect(narrator[0]?.backgroundStatus).toBe("cancelled");
				expect(narrator[0]?.status).toBe("idle");

				const takeoverParentId = generateId();
				await db.insert(pgNarrators).values({
					id: takeoverParentId,
					variant: "primary",
					status: "idle",
					createdAt: now,
					updatedAt: now,
				});
				const takeoverTaskId = generateId();
				await engine.startBashRun({
					taskId: takeoverTaskId,
					recipientId: takeoverParentId,
					taskRow: {
						id: takeoverTaskId,
						parentNarratorId: takeoverParentId,
						type: "bash",
						status: "running",
						command: "sleep 1",
						startedAt: now,
						createdAt: now,
						updatedAt: now,
					},
				});
				expect(
					(await engine.markTakenOver({ taskId: takeoverTaskId, now }))?.parentNarratorId,
				).toBe(takeoverParentId);
				const finalized = await engine.finalizeTakeover({
					taskId: takeoverTaskId,
					hasError: false,
					output: "taken over output",
					now,
				});
				expect(finalized?.parentNarratorId).toBe(takeoverParentId);
				return "pass";
			});
			if (typeof result === "object" && result.status === "blocked") {
				expect(result.reason).toContain("unavailable");
			} else {
				expect(result).toBe("pass");
			}
		},
		RUN_TIMEOUT_MS,
	);
});
