/**
 * The `transfer` background-task projection: `paused` semantics and the
 * restart-recovery contract.
 *
 * A device transfer's durable state lives in `device_transfer_tasks` (resume
 * checkpoint, run generation, byte progress). The `background_tasks` row is a
 * PROJECTION that makes it visible to Await, the drawer and completion
 * notifications. `paused` exists only for these rows, and every consumer that
 * previously divided the world into "running" and "finished" now has a third
 * case — each of these tests pins one place where getting it wrong is silent.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	backgroundTasks,
	deviceTransferTasks,
	narratorBufferedMessages,
	narrators,
	remoteDevices,
	runtimeAwaitedTerminalConsumptions,
	runtimePublicationOutbox,
} from "../../db/schema";
import type { ToolContext } from "../../lib/agent/types";
import { eventBus } from "../../lib/event-bus";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const broadcasts: Array<{ narratorId: string; message: Record<string, unknown> }> = [];

const { backgroundTaskService, OUTPUT_TAIL_MAX_CHARS } = await import("../background-task-service");
const { runtimePublication, getRuntimePublicationService } = await import(
	"../agent-runtime/publication"
);
const { teamStatusTool } = await import("../../lib/agent/tools/team-status");
const { WATCH_COMMAND_PREFIX, TERMINAL_WATCH_COMMAND_PREFIX } = await import(
	"../terminal-watch-constants"
);
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
// Injected rather than `mock.module`d: the service caches its lazily-imported
// broadcast fn, so whichever test file resolves it first wins for the whole
// process. Another file mocking `narrator-ws` would silently swallow these frames
// depending on test ordering — and a captured-frames assertion that can go empty
// for unrelated reasons is worse than no assertion.
backgroundTaskService.setBroadcastFnForTests((narratorId, message) => {
	broadcasts.push({ narratorId, message: message as unknown as Record<string, unknown> });
});
const { isBackgroundTaskActiveStatus } = await import("@shared/background-task-list");
const { TRANSFER_RESTART_PAUSE_NOTICE, DeviceTransferTaskStore } = await import(
	"../device-transfer-task-store"
);
const transferStore = new DeviceTransferTaskStore(db);
const { eq } = await import("drizzle-orm");

afterAll(() => {
	backgroundTaskService.setBroadcastFnForTests(null);
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

beforeEach(() => {
	broadcasts.length = 0;
	backgroundTaskService.resetListVersionsForTests();
});

afterEach(async () => {
	if (backgroundOccupancyStore.isReady) await flush();
	await runtimePublication.flushRecipient(PARENT);
	backgroundTaskService.resetListVersionsForTests();
	cleanDb(sqlite);
});

const PARENT = "transfer-parent";
const DEVICE = "transfer-device";

async function seedParent(): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insert(narrators)
		.values({ id: PARENT, type: "primary", variant: "primary", createdAt: now, updatedAt: now });
	await db.insert(remoteDevices).values({
		id: DEVICE,
		name: "pad7s",
		slug: "pad7s",
		tokenHash: "hash",
		tokenPrefix: "rdev_test",
		createdBy: "transfer-test-user",
		createdAt: now,
		updatedAt: now,
	});
	await backgroundOccupancyStore.start();
}

/** An owning transfer row, with optional progress figures. */
async function seedTransfer(
	id: string,
	opts: {
		status?: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
		alias?: string;
		bytesTransferred?: number;
		totalBytes?: number;
		startedAt?: string;
		updatedAt?: string;
	} = {},
): Promise<string> {
	const now = new Date().toISOString();
	await db.insert(deviceTransferTasks).values({
		id,
		deviceId: DEVICE,
		direction: "upload",
		remotePath: `/remote/${id}.apk`,
		localPath: `/local/${id}.apk`,
		status: opts.status ?? "running",
		alias: opts.alias,
		bytesTransferred: opts.bytesTransferred ?? 0,
		...(opts.totalBytes != null ? { totalBytes: opts.totalBytes } : {}),
		parentNarratorId: PARENT,
		createdAt: now,
		startedAt: opts.startedAt ?? now,
		updatedAt: opts.updatedAt ?? now,
	});
	return id;
}

/** The projection row for a transfer. */
async function projectionOf(transferTaskId: string) {
	return backgroundTaskService.getByTransferTaskId(transferTaskId);
}

async function flush(): Promise<void> {
	await backgroundOccupancyStore.flush();
	for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * `createTransferTask` queues its list delta without awaiting it. Under CI load
 * that frame can land after the test has already cleared `broadcasts`, and then
 * it looks like the progress broadcast bumped the list version.
 */
async function waitForListDelta(): Promise<void> {
	for (let i = 0; i < 50; i++) {
		if (broadcasts.some((entry) => entry.message.type === "background_task_list_delta")) return;
		await flush();
	}
	throw new Error("timed out waiting for the transfer projection list delta");
}

describe("transfer projection lifecycle", () => {
	test("creates one row per transfer and REVIVES it on resume", async () => {
		// A resumed transfer claims again under a new generation. Inserting a second
		// row would give one transfer several drawer cards, all but one permanently
		// stale — and the resumed one would jump to the top of the list as though it
		// were new work.
		await seedParent();
		const transferId = await seedTransfer("tx-revive");
		const first = await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
		});
		await backgroundTaskService.markTransferPaused(transferId, "stopped");
		expect((await projectionOf(transferId))?.status).toBe("paused");

		const second = await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
		});
		expect(second.id).toBe(first.id);
		const rows = await db
			.select()
			.from(backgroundTasks)
			.where(eq(backgroundTasks.transferTaskId, transferId));
		expect(rows).toHaveLength(1);
		// The pause reason must not linger while bytes are moving again.
		expect(rows[0]?.status).toBe("running");
		expect(rows[0]?.output).toBeNull();
	});

	test("a paused row still transitions to a terminal state", async () => {
		// The mark* methods guard on `status = "running"` (so they cannot overwrite a
		// terminal row). Without lifting a paused row first, a cancelled or
		// restarted-then-cancelled transfer would sit at "paused" forever with no
		// error surfaced anywhere.
		await seedParent();
		const transferId = await seedTransfer("tx-paused-terminal");
		await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
		});
		await backgroundTaskService.markTransferPaused(transferId, "stopped");
		await backgroundTaskService.finishTransferTask(transferId, { status: "cancelled" });
		expect((await projectionOf(transferId))?.status).toBe("cancelled");
	});

	test("a completion records the summary the model will read", async () => {
		await seedParent();
		const transferId = await seedTransfer("tx-complete");
		await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
		});
		await backgroundTaskService.finishTransferTask(transferId, {
			status: "completed",
			summary: "Uploaded 10.0 MB — /local → /remote",
		});
		const row = await projectionOf(transferId);
		expect(row?.status).toBe("completed");
		expect(row?.output).toContain("Uploaded 10.0 MB");
	});
});

describe("paused is active, not finished", () => {
	test("the shared predicate treats paused as active", () => {
		// A paused transfer holds a resume checkpoint and awaits a decision. Treating
		// it as terminal drops it from the active set and the drawer's running count,
		// so a transfer the user deliberately paused would quietly disappear.
		expect(isBackgroundTaskActiveStatus("paused")).toBe(true);
	});

	test("a paused transfer stays in the active set and remains cancellable", async () => {
		await seedParent();
		const transferId = await seedTransfer("tx-active");
		await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
		});
		await backgroundTaskService.markTransferPaused(transferId, TRANSFER_RESTART_PAUSE_NOTICE);

		expect(await backgroundTaskService.countActiveByParent(PARENT)).toBe(1);
		const page = await backgroundTaskService.listPageByParent(PARENT, {});
		const row = page.activeTasks?.find((t) => t.type === "transfer");
		expect(row?.status).toBe("paused");
		// The owning row accepts `cancel` from `paused`, so reporting otherwise would
		// hide an action the backend supports and leave a stuck card.
		expect(row?.canCancelActiveWork).toBe(true);
	});

	test("a paused transfer is NOT announced as a completed task", async () => {
		// The drain used to select `status != "running"`. A paused transfer would be
		// notified as finished AND marked `notified`, so the real completion would
		// never be announced at all.
		await seedParent();
		const transferId = await seedTransfer("tx-notify");
		await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
		});
		await backgroundTaskService.markTransferPaused(transferId, "restarted");

		expect(await backgroundTaskService.drainCompletedNotifications(PARENT)).toHaveLength(0);

		// It IS announced once it genuinely completes.
		await backgroundTaskService.finishTransferTask(transferId, {
			status: "completed",
			summary: "Uploaded 1.0 KB",
		});
		const notifications = await backgroundTaskService.drainCompletedNotifications(PARENT);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.type).toBe("transfer");
	});

	test("a paused transfer is not reaped by the age-based cleanup", async () => {
		// `cleanupCompleted` filters on `completedAt` age. A paused row must carry no
		// completedAt, or a long-paused but resumable transfer would have its drawer
		// card deleted while the owning transfer survived.
		await seedParent();
		const transferId = await seedTransfer("tx-reap");
		await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
		});
		await backgroundTaskService.markTransferPaused(transferId, "restarted");
		const paused = await projectionOf(transferId);
		expect(paused?.completedAt).toBeNull();

		// Even with a stamped, long-past completedAt the reap must refuse a paused row.
		await db
			.update(backgroundTasks)
			.set({ completedAt: "2000-01-01T00:00:00.000Z" })
			.where(eq(backgroundTasks.id, paused?.id ?? ""));
		await backgroundTaskService.cleanupCompleted(0);
		expect(await projectionOf(transferId)).not.toBeNull();
	});
});

describe("restart recovery keeps the two halves in agreement", () => {
	test("a running transfer projection recovers as PAUSED, never cancelled", async () => {
		// The owning row is recovered as `paused` (resumable). Cancelling the
		// projection would make the drawer — the half users actually read — claim the
		// transfer is over while it can still be resumed.
		await seedParent();
		const transferId = await seedTransfer("tx-restart");
		await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
		});

		await backgroundTaskService.recoverStaleTasksAfterRestart();

		const row = await projectionOf(transferId);
		expect(row?.status).toBe("paused");
		expect(row?.completedAt).toBeNull();
		expect(row?.output).toBe(TRANSFER_RESTART_PAUSE_NOTICE);
	});

	test("a bash task recovers as failed with unknown outcome and is not rerun", async () => {
		// The transfer carve-out must not soften recovery for the kinds that really
		// are destroyed by a restart: a dead child process has no resume path.
		await seedParent();
		await backgroundTaskService.createBashTask({
			id: "bash-restart",
			parentNarratorId: PARENT,
			command: "sleep 100",
		});
		await backgroundTaskService.recoverStaleTasksAfterRestart();
		expect(await backgroundTaskService.getById("bash-restart")).toMatchObject({
			status: "failed",
			output: "Execution outcome unknown after restart; the command was not rerun.",
		});
	});

	test("recovery does not emit a cancellation event for a paused transfer", async () => {
		// The `cancelled` event is what unblocks a waiting Await. Emitting it for a
		// merely paused transfer would hand the model a terminal answer for pending
		// work; an Await that waits out its timeout is recoverable, a wrong terminal
		// answer is not.
		await seedParent();
		const transferId = await seedTransfer("tx-no-event");
		await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
		});
		const { eventBus } = await import("../../lib/event-bus");
		const cancelledEvents: string[] = [];
		const onCancelled = (event: { taskId: string }) => cancelledEvents.push(event.taskId);
		eventBus.on("background_task:cancelled", onCancelled);
		try {
			await backgroundTaskService.recoverStaleTasksAfterRestart();
			await flush();
		} finally {
			eventBus.off("background_task:cancelled", onCancelled);
		}
		const projection = await projectionOf(transferId);
		expect(cancelledEvents).not.toContain(projection?.id ?? "");
	});
});

describe("live progress reaches the list without touching the delta sequence", () => {
	test("progress is JOINED from the owning row, not stored on the projection", async () => {
		await seedParent();
		const startedAt = new Date(Date.now() - 2000).toISOString();
		const transferId = await seedTransfer("tx-progress", {
			bytesTransferred: 4 * 1024 * 1024,
			totalBytes: 10 * 1024 * 1024,
			startedAt,
			updatedAt: new Date().toISOString(),
		});
		await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
		});

		const page = await backgroundTaskService.listPageByParent(PARENT, {});
		const row = page.tasks.find((t) => t.type === "transfer");
		expect(row?.progress?.completed).toBe(4 * 1024 * 1024);
		expect(row?.progress?.total).toBe(10 * 1024 * 1024);
		// The projection row itself stores nothing about progress.
		const stored = await projectionOf(transferId);
		expect(stored?.output).toBeNull();
	});

	test("a finished transfer carries no bar", async () => {
		// A completed transfer's bar would sit at 100% forever, saying nothing its
		// summary line does not already say.
		await seedParent();
		const transferId = await seedTransfer("tx-progress-done", {
			bytesTransferred: 100,
			totalBytes: 100,
		});
		await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
		});
		await backgroundTaskService.finishTransferTask(transferId, {
			status: "completed",
			summary: "Uploaded 100 B",
		});
		const page = await backgroundTaskService.listPageByParent(PARENT, {});
		expect(page.tasks.find((t) => t.type === "transfer")?.progress).toBeUndefined();
	});

	test("a progress broadcast is its OWN frame and does not bump the list version", async () => {
		// The delta channel refetches the whole first page whenever a version is
		// skipped. Progress fires ~2x/s per transfer, so routing it there would make
		// every dropped frame cost a refetch and every frame cost an activeCount query.
		await seedParent();
		const transferId = await seedTransfer("tx-frame", {
			bytesTransferred: 512,
			totalBytes: 2048,
		});
		await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
		});
		await waitForListDelta();
		const versionsBefore = broadcasts
			.filter((b) => b.message.type === "background_task_list_delta")
			.map((b) => b.message.version);

		broadcasts.length = 0;
		await backgroundTaskService.broadcastTransferProgress(transferId, {
			completed: 1024,
			total: 2048,
		});
		await flush();

		const frames = broadcasts.filter((b) => b.message.type === "background_task_progress");
		expect(frames).toHaveLength(1);
		expect(frames[0]?.message.progress).toMatchObject({ completed: 1024, total: 2048 });
		// No delta was emitted, so no version was consumed.
		expect(broadcasts.filter((b) => b.message.type === "background_task_list_delta")).toHaveLength(
			0,
		);
		expect(versionsBefore.length).toBeGreaterThan(0);
	});

	test("progress for a transfer with no projection is a silent no-op", async () => {
		// An admin transfer from the devices page has no projection. Broadcasting for
		// it must not throw — the runner calls this on every progress beat.
		await seedParent();
		const transferId = await seedTransfer("tx-unprojected");
		await backgroundTaskService.broadcastTransferProgress(transferId, { completed: 1, total: 2 });
		await flush();
		expect(broadcasts.filter((b) => b.message.type === "background_task_progress")).toHaveLength(0);
	});
});

describe("the handle the model was given must resolve", () => {
	// The TransferFile tool registers its alias against the OWNING
	// `device_transfer_tasks` id — the only id that exists when the turn hands the
	// work off, since the projection is created later by the runner. It then prints
	// `Await({ type: "transfer", id: "<alias>" })`. If Await can only look that up as
	// a `background_tasks` primary key, the tool's own instruction is unusable and the
	// answer is "not a valid background task ID" for every background transfer.

	test("a projection is reachable by its OWNING transfer id", async () => {
		await seedParent();
		const transferId = await seedTransfer("tx-resolve");
		const created = await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
		});
		// The two ids are genuinely different spaces; that is the whole hazard.
		expect(created.id).not.toBe(transferId);
		expect(await backgroundTaskService.getById(transferId)).toBeNull();
		expect((await backgroundTaskService.getByTransferTaskId(transferId))?.id).toBe(created.id);
	});

	test("the alias is PERSISTED, so it still resolves after a restart", async () => {
		// The in-memory alias registry dies with the process, and a transfer is the one
		// background kind that survives a restart — so the DB copy is the only thing
		// that can answer for the handle sitting in the model's transcript.
		await seedParent();
		const transferId = await seedTransfer("tx-alias");
		await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
			alias: "upload-app-apk",
		});
		const found = await backgroundTaskService.getByAlias("upload-app-apk", PARENT);
		expect(found?.transferTaskId).toBe(transferId);
	});

	test("a resume backfills a missing alias without overwriting an existing one", async () => {
		// Rows created before the alias was carried through have none, and a resume is
		// exactly when the handle must start resolving. An existing alias is left alone:
		// it is what the model already holds.
		await seedParent();
		const transferId = await seedTransfer("tx-alias-backfill");
		await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
		});
		expect((await projectionOf(transferId))?.alias).toBeNull();

		await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
			alias: "upload-app-apk",
		});
		expect((await projectionOf(transferId))?.alias).toBe("upload-app-apk");

		await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload → app.apk",
			alias: "upload-app-apk-2",
		});
		expect((await projectionOf(transferId))?.alias).toBe("upload-app-apk");
	});
});

async function queryTask(target: string, narratorId = PARENT) {
	return teamStatusTool.execute({ action: "get_task", target_id: target }, {
		narratorId,
	} as ToolContext);
}

describe("durable non-blocking task detail", () => {
	test.each([
		"queued",
		"paused",
	] as const)("cold %s transfer resolves its persisted alias without a projection or live device", async (status) => {
		await seedParent();
		const transferId = await seedTransfer(`tx-cold-${status}`, {
			status,
			alias: "cold-upload",
			bytesTransferred: 7,
			totalBytes: 12,
		});
		expect(await projectionOf(transferId)).toBeNull();
		for (const selector of [transferId, "cold-upload"]) {
			const result = await queryTask(selector);
			expect(result.isError).not.toBe(true);
			expect(JSON.parse(result.output)).toMatchObject({
				type: "transfer",
				transferTaskId: transferId,
				status,
				progress: { bytesTransferred: 7, totalBytes: 12 },
			});
		}
		expect((await queryTask("cold-upload", "other-parent")).isError).toBe(true);
		expect((await queryTask(transferId, "other-parent")).isError).toBe(true);
	});

	test("projection IDs and aliases are owned, bounded, and reads do not consume mailbox notices", async () => {
		await seedParent();
		const transferId = await seedTransfer("tx-detail", { alias: "upload-detail" });
		const projection = await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload",
			alias: "upload-detail",
		});
		const error = `${"x".repeat(OUTPUT_TAIL_MAX_CHARS + 100)}FAILURE TAIL`;
		await db
			.update(deviceTransferTasks)
			.set({ status: "failed", error })
			.where(eq(deviceTransferTasks.id, transferId));
		await backgroundTaskService.finishTransferTask(transferId, { status: "failed", error });
		await runtimePublication.flushRecipient(PARENT);
		const before = await db.select().from(narratorBufferedMessages);
		expect(before).toHaveLength(1);
		for (const selector of [projection.id, transferId, "upload-detail"]) {
			const result = await queryTask(selector);
			const task = JSON.parse(result.output);
			expect(task.status).toBe("failed");
			expect(task.output).toHaveLength(OUTPUT_TAIL_MAX_CHARS);
			expect(task.output).toEndWith("FAILURE TAIL");
			expect(task.outputTruncated).toBe(true);
			expect((await queryTask(selector, "other-parent")).isError).toBe(true);
		}
		expect(await db.select().from(narratorBufferedMessages)).toEqual(before);
		expect(await db.select().from(runtimeAwaitedTerminalConsumptions)).toHaveLength(0);
	});

	test("bash detail uses bounded live output and terminal stored output", async () => {
		await seedParent();
		await backgroundTaskService.createBashTask({
			id: "bash-detail",
			parentNarratorId: PARENT,
			command: "build",
			alias: "build-detail",
		});
		const output = `${"x".repeat(OUTPUT_TAIL_MAX_CHARS + 100)}TAIL`;
		backgroundTaskService.appendOutput("bash-detail", output);
		const running = JSON.parse((await queryTask("build-detail")).output);
		expect(running).toMatchObject({
			type: "bash",
			status: "running",
			live: true,
			outputTruncated: true,
		});
		expect(running.output).toHaveLength(OUTPUT_TAIL_MAX_CHARS);
		await backgroundTaskService.markCompleted("bash-detail", output);
		const terminal = JSON.parse((await queryTask("build-detail")).output);
		expect(terminal).toMatchObject({ status: "completed", live: false, outputTruncated: true });
		expect(terminal.output).toEndWith("TAIL");
	});
});

describe("transfer generation publication on resume", () => {
	test.each([
		"completed",
		"failed",
	] as const)("failed → resume → %s publishes once per actual generation", async (status) => {
		await seedParent();
		const transferId = await seedTransfer(`tx-retry-${status}`);
		const input = {
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "retry upload",
			runGeneration: 0,
		};
		const first = await backgroundTaskService.createTransferTask(input);
		await transferStore.finishStoppedOrFailed({
			taskId: transferId,
			generation: 0,
			error: "first failure",
		});
		await backgroundTaskService.finishTransferTask(
			transferId,
			{ status: "failed", error: "first failure" },
			0,
		);
		await runtimePublication.flushRecipient(PARENT);
		expect(await db.select().from(narratorBufferedMessages)).toHaveLength(1);

		const resumed = await transferStore.resume(DEVICE, transferId);
		expect(resumed?.runGeneration).toBe(1);
		expect(await transferStore.claim(transferId, 1, new Date().toISOString())).not.toBeNull();
		const second = await backgroundTaskService.createTransferTask({ ...input, runGeneration: 1 });
		expect(second.id).toBe(first.id);
		expect(second.logicalRunId).not.toBe(first.logicalRunId);
		expect(second.logicalRunId).toBe(`transfer:${transferId}:1`);
		expect((await db.select().from(runtimePublicationOutbox)).map((row) => row.state)).toEqual([
			"reserved",
		]);
		// Duplicate/stale claim, pause and terminal callbacks cannot overwrite the new run.
		await backgroundTaskService.createTransferTask(input);
		await backgroundTaskService.markTransferPaused(transferId, "late pause", 0);
		await backgroundTaskService.finishTransferTask(
			transferId,
			{ status: "failed", error: "late failure" },
			0,
		);
		expect(await projectionOf(transferId)).toMatchObject({
			status: "running",
			logicalRunId: second.logicalRunId,
			output: null,
		});

		if (status === "completed")
			await transferStore.complete(transferId, 1, { filesTransferred: 1, bytesTransferred: 12 });
		else
			await transferStore.finishStoppedOrFailed({
				taskId: transferId,
				generation: 1,
				error: "second failure",
			});
		const outcome =
			status === "completed"
				? { status, summary: "Uploaded retry" }
				: { status, error: "second failure" };
		await Promise.all([
			backgroundTaskService.finishTransferTask(transferId, outcome, 1),
			backgroundTaskService.finishTransferTask(transferId, outcome, 1),
		]);
		await backgroundTaskService.createTransferTask({ ...input, runGeneration: 1 });
		await runtimePublication.flushRecipient(PARENT);
		await runtimePublication.flushRecipient(PARENT);
		const messages = await db.select().from(narratorBufferedMessages);
		expect(messages).toHaveLength(2);
		expect(new Set(messages.map((row) => row.dedupeKey)).size).toBe(2);
		expect(messages.filter((row) => row.text.includes(` ${status}.`))).toHaveLength(
			status === "failed" ? 2 : 1,
		);
		expect((await projectionOf(transferId))?.status).toBe(status);
	});

	test("paused → resume retains the unspent reservation and sends no intermediate terminal", async () => {
		await seedParent();
		const transferId = await seedTransfer("tx-paused-generation");
		const input = {
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "paused upload",
			runGeneration: 0,
		};
		const first = await backgroundTaskService.createTransferTask(input);
		await transferStore.pause(DEVICE, transferId);
		await backgroundTaskService.markTransferPaused(transferId, "paused", 0);
		const slots = await db.select().from(runtimePublicationOutbox);
		await transferStore.resume(DEVICE, transferId);
		await transferStore.claim(transferId, 1, new Date().toISOString());
		const resumed = await backgroundTaskService.createTransferTask({ ...input, runGeneration: 1 });
		expect(resumed.logicalRunId).toBe(first.logicalRunId);
		expect(await db.select().from(runtimePublicationOutbox)).toEqual(slots);
		await runtimePublication.flushRecipient(PARENT);
		expect(await db.select().from(narratorBufferedMessages)).toHaveLength(0);
		await transferStore.complete(transferId, 1, { filesTransferred: 1, bytesTransferred: 10 });
		await backgroundTaskService.finishTransferTask(
			transferId,
			{ status: "completed", summary: "resumed" },
			1,
		);
		await runtimePublication.flushRecipient(PARENT);
		expect(await db.select().from(narratorBufferedMessages)).toHaveLength(1);
	});

	test("failed revival and its new reservation roll back together", async () => {
		await seedParent();
		const transferId = await seedTransfer("tx-retry-atomic");
		const input = {
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "atomic upload",
			runGeneration: 0,
		};
		const first = await backgroundTaskService.createTransferTask(input);
		await transferStore.finishStoppedOrFailed({
			taskId: transferId,
			generation: 0,
			error: "failed",
		});
		await backgroundTaskService.finishTransferTask(
			transferId,
			{ status: "failed", error: "failed" },
			0,
		);
		await runtimePublication.flushRecipient(PARENT);
		await transferStore.resume(DEVICE, transferId);
		await transferStore.claim(transferId, 1, new Date().toISOString());
		sqlite.run(
			"CREATE TRIGGER reject_transfer_retry_slot BEFORE INSERT ON runtime_publication_outbox BEGIN SELECT RAISE(ABORT, 'retry slot failure'); END",
		);
		try {
			await expect(
				backgroundTaskService.createTransferTask({ ...input, runGeneration: 1 }),
			).rejects.toThrow("retry slot failure");
			expect(await projectionOf(transferId)).toMatchObject({
				status: "failed",
				logicalRunId: first.logicalRunId,
			});
		} finally {
			sqlite.run("DROP TRIGGER reject_transfer_retry_slot");
		}
		expect(
			(await backgroundTaskService.createTransferTask({ ...input, runGeneration: 1 })).status,
		).toBe("running");
	});
});

describe("transfer terminal mailbox publication", () => {
	test.each([
		"completed",
		"failed",
		"cancelled",
	] as const)("%s is published exactly once after pause/resume", async (status) => {
		await seedParent();
		const transferId = await seedTransfer(`tx-mailbox-${status}`);
		const projection = await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload",
			alias: "upload-terminal",
		});
		await backgroundTaskService.markTransferPaused(transferId, "offline");
		await runtimePublication.flushRecipient(PARENT);
		expect(await db.select().from(narratorBufferedMessages)).toHaveLength(0);
		expect((await db.select().from(runtimePublicationOutbox)).map((row) => row.state)).toEqual([
			"reserved",
		]);
		expect((await projectionOf(transferId))?.completedAt).toBeNull();
		await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload",
		});
		const outcome =
			status === "completed"
				? { status, summary: "Uploaded 12 bytes" }
				: status === "failed"
					? { status, error: "Device failed" }
					: { status };
		await Promise.all([
			backgroundTaskService.finishTransferTask(transferId, outcome),
			backgroundTaskService.finishTransferTask(transferId, outcome),
		]);
		await runtimePublication.flushRecipient(PARENT);
		await runtimePublication.flushRecipient(PARENT);
		await backgroundTaskService.finishTransferTask(transferId, outcome);
		const messages = await db.select().from(narratorBufferedMessages);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ kind: "task_notice", noticeKind: "bash", state: "queued" });
		expect(messages[0]?.text).toContain(`Background transfer`);
		expect(messages[0]?.text).toContain("get_task");
		expect(messages[0]?.text).not.toContain("Await");
		expect((await backgroundTaskService.getById(projection.id))?.status).toBe(status);
	});

	test("pending transfer publication protects its stored result from age cleanup", async () => {
		await seedParent();
		const transferId = await seedTransfer("tx-pending-cleanup");
		const projection = await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload",
		});
		await backgroundTaskService.finishTransferTask(transferId, {
			status: "completed",
			summary: "durable completion",
		});
		await db
			.update(backgroundTasks)
			.set({ completedAt: "2000-01-01T00:00:00.000Z" })
			.where(eq(backgroundTasks.id, projection.id));
		await backgroundTaskService.cleanupCompleted(0);
		expect(await backgroundTaskService.getById(projection.id)).not.toBeNull();
		await runtimePublication.flushRecipient(PARENT);
		await backgroundTaskService.cleanupCompleted(0);
		expect(await backgroundTaskService.getById(projection.id)).not.toBeNull();
	});

	test("facade terminal CAS publishes transfers through the same durable channel", async () => {
		await seedParent();
		const transferId = await seedTransfer("tx-facade");
		const projection = await backgroundTaskService.createTransferTask({
			parentNarratorId: PARENT,
			transferTaskId: transferId,
			title: "upload",
		});
		const now = new Date().toISOString();
		const input = {
			taskId: projection.id,
			setFields: { status: "completed", output: "complete", completedAt: now },
			fullOutput: "complete",
			summary: "transfer complete",
			eventKind: "completed" as const,
		};
		expect(await getRuntimePublicationService().commitTerminalTransition(input)).toBeDefined();
		expect(await getRuntimePublicationService().commitTerminalTransition(input)).toBeUndefined();
		await runtimePublication.flushRecipient(PARENT);
		expect(await db.select().from(narratorBufferedMessages)).toHaveLength(1);
	});
});

describe("silent observation completion", () => {
	test.each([
		WATCH_COMMAND_PREFIX,
		TERMINAL_WATCH_COMMAND_PREFIX,
	])("%s clears only its own reservation, without a completion event or source consumption", async (prefix) => {
		await seedParent();
		await backgroundTaskService.createBashTask({
			id: "source-task",
			parentNarratorId: PARENT,
			command: "build",
		});
		await backgroundTaskService.createBashTask({
			id: "observe-source",
			parentNarratorId: PARENT,
			command: `${prefix} source-task`,
		});
		const completions: string[] = [];
		const listener = (event: { taskId: string }) => completions.push(event.taskId);
		eventBus.on("background_task:completed", listener);
		try {
			await backgroundTaskService.markCompleted("source-task", "actual result");
			expect(
				await backgroundTaskService.finishObservationSilently("observe-source", "source completed"),
			).toBe(true);
			expect(
				await backgroundTaskService.finishObservationSilently("observe-source", "duplicate"),
			).toBe(false);
			expect(completions).toEqual(["source-task"]);
		} finally {
			eventBus.off("background_task:completed", listener);
		}
		expect(await backgroundTaskService.getById("observe-source")).toMatchObject({
			status: "completed",
			notified: true,
			output: "source completed",
		});
		expect(
			(await db.select().from(runtimePublicationOutbox)).some(
				(row) => row.taskId === "observe-source",
			),
		).toBe(false);
		expect(await db.select().from(runtimeAwaitedTerminalConsumptions)).toHaveLength(0);
		await runtimePublication.flushRecipient(PARENT);
		const messages = await db.select().from(narratorBufferedMessages);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.text).toContain("source-task");
		expect(
			(await backgroundTaskService.drainCompletedNotifications(PARENT)).map((row) => row.id),
		).toEqual(["source-task"]);
	});

	test.each([
		WATCH_COMMAND_PREFIX,
		TERMINAL_WATCH_COMMAND_PREFIX,
	])("%s shutdown preserves the row and legacy recovery reports observation interruption", async (prefix) => {
		await seedParent();
		const id = "restart-observation";
		await backgroundTaskService.createBashTask({
			id,
			parentNarratorId: PARENT,
			command: `${prefix} source-task`,
		});
		// Emulate an old row lacking a publication run without leaving a modern slot.
		await db.delete(runtimePublicationOutbox).where(eq(runtimePublicationOutbox.taskId, id));
		await db.update(backgroundTasks).set({ logicalRunId: null }).where(eq(backgroundTasks.id, id));
		let targetStopped = false;
		backgroundTaskService.registerKillHandler(id, () => {
			targetStopped = true;
		});
		await backgroundTaskService.killAll();
		expect(targetStopped).toBe(false);
		expect((await backgroundTaskService.getById(id))?.status).toBe("running");
		await backgroundTaskService.recoverStaleTasksAfterRestart();
		expect((await backgroundTaskService.getById(id))?.output).toContain("Observation interrupted");
		expect((await backgroundTaskService.getById(id))?.output).toContain("target was not stopped");
		await runtimePublication.flushRecipient(PARENT);
		const messages = await db.select().from(narratorBufferedMessages);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.text).toContain("Observation interrupted");
		expect(messages[0]?.text).not.toContain("Execution outcome unknown");
	});

	test("failed reservation cleanup rolls back the silent terminal CAS", async () => {
		await seedParent();
		const id = "rollback-observation";
		await backgroundTaskService.createBashTask({
			id,
			parentNarratorId: PARENT,
			command: `${WATCH_COMMAND_PREFIX} source`,
		});
		sqlite.run(
			"CREATE TRIGGER reject_silent_slot_cleanup BEFORE DELETE ON runtime_publication_outbox BEGIN SELECT RAISE(ABORT, 'slot cleanup failure'); END",
		);
		try {
			await expect(backgroundTaskService.finishObservationSilently(id, "done")).rejects.toThrow(
				"slot cleanup failure",
			);
			expect(await backgroundTaskService.getById(id)).toMatchObject({
				status: "running",
				notified: false,
			});
			expect(
				await db
					.select()
					.from(runtimePublicationOutbox)
					.where(eq(runtimePublicationOutbox.taskId, id)),
			).toHaveLength(1);
		} finally {
			sqlite.run("DROP TRIGGER reject_silent_slot_cleanup");
		}
	});

	test("ordinary bash tasks cannot be silently completed", async () => {
		await seedParent();
		await backgroundTaskService.createBashTask({
			id: "not-observation",
			parentNarratorId: PARENT,
			command: "build",
		});
		expect(
			await backgroundTaskService.finishObservationSilently("not-observation", "wrong target"),
		).toBe(false);
		expect((await backgroundTaskService.getById("not-observation"))?.status).toBe("running");
	});
});
