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
import { backgroundTasks, deviceTransferTasks, narrators, remoteDevices } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const broadcasts: Array<{ narratorId: string; message: Record<string, unknown> }> = [];

const { backgroundTaskService } = await import("../background-task-service");
// Injected rather than `mock.module`d: the service caches its lazily-imported
// broadcast fn, so whichever test file resolves it first wins for the whole
// process. Another file mocking `narrator-ws` would silently swallow these frames
// depending on test ordering — and a captured-frames assertion that can go empty
// for unrelated reasons is worse than no assertion.
backgroundTaskService.setBroadcastFnForTests((narratorId, message) => {
	broadcasts.push({ narratorId, message: message as unknown as Record<string, unknown> });
});
const { isBackgroundTaskActiveStatus } = await import("@shared/background-task-list");
const { TRANSFER_RESTART_PAUSE_NOTICE } = await import("../device-transfer-task-store");
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

afterEach(() => {
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
}

/** An owning transfer row, with optional progress figures. */
async function seedTransfer(
	id: string,
	opts: {
		status?: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
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
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
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
		await flush();
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
