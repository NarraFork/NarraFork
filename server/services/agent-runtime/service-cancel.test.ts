import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	backgroundTasks,
	runtimeAwaitedTerminalConsumptions as consumptions,
	narratorBufferedMessages as mailbox,
	narrators,
	runtimePublicationOutbox as outbox,
} from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));
const { backgroundTaskService: tasks } = await import("../background-task-service");
const broadcasts: Array<{ narratorId: string; message: Record<string, unknown> }> = [];
tasks.setBroadcastFnForTests((narratorId, message) => {
	broadcasts.push({ narratorId, message: message as unknown as Record<string, unknown> });
});
const { getRuntimePublicationService, runtimePublication } = await import("./publication");
const publisher = getRuntimePublicationService();
publisher.stop();
const now = "2026-10-08T00:00:00.000Z";
let wakes = 0;
beforeEach(() => {
	cleanDb(sqlite);
	broadcasts.length = 0;
	tasks.resetListVersionsForTests();
	wakes = 0;
	publisher.setWake(() => {
		wakes++;
	});
	db.insert(narrators).values({ id: "parent", createdAt: now, updatedAt: now }).run();
});
afterAll(() => {
	publisher.stop();
	runtimePublication.stop();
	tasks.setBroadcastFnForTests(null);
	mock.module("../../db", () => realDbModule);
	sqlite.close();
	mock.restore();
});

for (const backgroundKind of ["service", "task"] as const) {
	test(`core ${backgroundKind} cancel settles active and later Await callers and broadcasts cancelled list state`, async () => {
		const id = `core-${backgroundKind}`;
		await tasks.createBashTask({ id, parentNarratorId: "parent", command: "test", backgroundKind });
		tasks.appendOutput(id, "saved live output");
		const controller = new AbortController();
		tasks.registerAbortController(id, controller);
		const waiting = tasks.waitForCompletion(id, 1000);
		// Drain the initial read so this exercises the subscribed waiter, not just the settled read.
		await Promise.resolve();
		expect(await tasks.cancel(id)).toBe(true);
		expect(controller.signal.aborted).toBe(true);
		const activeWait = await waiting;
		expect(activeWait.status).toBe("cancelled");
		expect(activeWait.output).toBe("saved live output");
		expect(activeWait.terminalResultReceived).toBe(true);
		expect(activeWait.publicationRun?.taskId).toBe(id);
		const laterWait = await tasks.waitForCompletion(id, 1000);
		expect(laterWait.status).toBe("cancelled");
		expect(laterWait.output).toBe("saved live output");
		expect(laterWait.terminalResultReceived).toBe(true);
		await publisher.flushRecipient("parent");
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
		expect(
			broadcasts.some(
				({ narratorId, message }) =>
					narratorId === "parent" &&
					message.type === "background_task_list_delta" &&
					(message.upsert as { id?: string; status?: string } | undefined)?.id === id &&
					(message.upsert as { status?: string }).status === "cancelled",
			),
		).toBe(true);
		expect(
			broadcasts.some(
				({ message }) =>
					message.type === "background_task_count_changed" &&
					message.activeBackgroundTaskCount === 0,
			),
		).toBe(true);
		expect(wakes).toBe(0);
		if (backgroundKind === "service") {
			expect(db.select().from(mailbox).all()).toHaveLength(0);
			expect(db.select().from(outbox).all()).toHaveLength(0);
			expect(db.select().from(consumptions).all()).toHaveLength(1);
		} else {
			expect(db.select().from(mailbox).all()).toHaveLength(1);
			expect(db.select().from(consumptions).all()).toHaveLength(0);
		}
	});

	test(`${backgroundKind} explicit stop preserves cancelled output and controls durable publication`, async () => {
		const run = await publisher.newBashRun("bash", "parent");
		runtimePublication.store.reserveRunSlots(run);
		db.insert(backgroundTasks)
			.values({
				id: run.taskId,
				type: "bash",
				backgroundKind,
				parentNarratorId: "parent",
				logicalRunId: run.logicalRunId,
				status: "running",
				command: "test",
				startedAt: now,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		const cancelled = await publisher.cancelTask({
			taskId: run.taskId,
			now,
			capturedOutput: "saved service output",
			capturedOutputBytes: 20,
			capturedTruncated: false,
		});
		expect(cancelled?.status).toBe("cancelled");
		expect((await publisher.readTaskDetail(run.taskId))?.output).toBe("saved service output");
		await publisher.flushRecipient("parent");
		expect(wakes).toBe(0);
		if (backgroundKind === "service") {
			expect(db.select().from(consumptions).all()).toHaveLength(1);
			expect(db.select().from(outbox).all()).toHaveLength(0);
			expect(db.select().from(mailbox).all()).toHaveLength(0);
			// A delayed producer callback cannot re-create an automatic parent notification.
			expect(
				(
					await publisher.commit({
						...run,
						eventKind: "failed",
						resultRef: "saved",
						summary: "late callback",
					})
				).status,
			).toBe("duplicate");
			await publisher.flushRecipient("parent");
			expect(db.select().from(mailbox).all()).toHaveLength(0);
		} else {
			expect(db.select().from(consumptions).all()).toHaveLength(0);
			expect(db.select().from(mailbox).all()).toHaveLength(1);
		}
		expect(
			await publisher.cancelTask({
				taskId: run.taskId,
				now,
				capturedOutput: null,
				capturedOutputBytes: 0,
				capturedTruncated: false,
			}),
		).toBeNull();
	});
}

test("service stop revokes an already queued cancellation notice, without discarding the result", async () => {
	const run = await publisher.newBashRun("bash", "parent");
	runtimePublication.store.reserveRunSlots(run);
	db.insert(backgroundTasks)
		.values({
			id: run.taskId,
			type: "bash",
			backgroundKind: "service",
			parentNarratorId: "parent",
			logicalRunId: run.logicalRunId,
			status: "running",
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	await publisher.commit({
		...run,
		eventKind: "cancelled",
		resultRef: "saved",
		summary: "old notice",
	});
	await publisher.flushRecipient("parent");
	expect(db.select().from(mailbox).all()[0]?.state).toBe("queued");
	await publisher.cancelTask({
		taskId: run.taskId,
		now,
		capturedOutput: "final output",
		capturedOutputBytes: 12,
		capturedTruncated: false,
	});
	expect(db.select().from(mailbox).all()[0]?.state).toBe("cancelled");
	expect(db.select().from(mailbox).all()[0]?.text).toBe("");
	expect(db.select().from(outbox).all()).toHaveLength(0);
	expect(
		db.select().from(backgroundTasks).where(eq(backgroundTasks.id, run.taskId)).get()?.output,
	).toBe("final output");
	await publisher.flushRecipient("parent");
	expect(wakes).toBe(0);
});

test("failed service suppression rolls back cancellation and keeps its reserved terminal slot", async () => {
	const run = publisher.newBashRun("bash", "parent");
	runtimePublication.store.reserveRunSlots(run);
	db.insert(backgroundTasks)
		.values({
			id: run.taskId,
			type: "bash",
			backgroundKind: "service",
			parentNarratorId: "parent",
			logicalRunId: run.logicalRunId,
			status: "running",
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	sqlite.run(
		"CREATE TRIGGER reject_service_receipt BEFORE INSERT ON runtime_awaited_terminal_consumptions BEGIN SELECT RAISE(ABORT, 'receipt failure'); END",
	);
	try {
		await expect(
			publisher.cancelTask({
				taskId: run.taskId,
				now,
				capturedOutput: "cancelled output",
				capturedOutputBytes: 16,
				capturedTruncated: false,
			}),
		).rejects.toThrow("receipt failure");
		expect((await publisher.readTaskDetail(run.taskId))?.status).toBe("running");
		expect((await publisher.readTaskDetail(run.taskId))?.output).toBeNull();
		expect(db.select().from(outbox).all()[0]?.state).toBe("reserved");
		expect(db.select().from(consumptions).all()).toHaveLength(0);
	} finally {
		sqlite.run("DROP TRIGGER reject_service_receipt");
	}
});

for (const eventKind of ["completed", "failed", "timed_out"] as const) {
	test(`service spontaneous ${eventKind} still publishes and wakes`, async () => {
		const run = await publisher.newBashRun("bash", "parent");
		runtimePublication.store.reserveRunSlots(run);
		db.insert(backgroundTasks)
			.values({
				id: run.taskId,
				type: "bash",
				backgroundKind: "service",
				parentNarratorId: "parent",
				logicalRunId: run.logicalRunId,
				status: "running",
				startedAt: now,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		await publisher.commitBashTerminal({ run, eventKind, text: "exit", summary: "service exited" });
		await publisher.flushRecipient("parent");
		expect(db.select().from(mailbox).all()).toHaveLength(1);
		expect(wakes).toBe(1);
		expect(db.select().from(consumptions).all()).toHaveLength(0);
	});
}
