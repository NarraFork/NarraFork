import { afterAll, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import {
	backgroundTasks,
	narratorBufferedMessages,
	narrators,
	runtimePublicationOutbox,
} from "../../db/schema";
import { MAILBOX_LIMITS as L } from "../agent-runtime/limits";

// Seed old accepted tasks BEFORE importing the producer captures its immutable upgrade watermark.
const { db, sqlite } = getTestDb();
const time = "2025-01-01T00:00:00.000Z";
db.insert(narrators).values({ id: "parent", createdAt: time, updatedAt: time }).run();
db.insert(backgroundTasks)
	.values([
		{
			id: "old-completed",
			parentNarratorId: "parent",
			type: "bash",
			status: "completed",
			command: "finished",
			output: "old done result",
			createdAt: time,
			updatedAt: time,
			startedAt: time,
			completedAt: time,
		},
		{
			id: "old-live",
			parentNarratorId: "parent",
			type: "bash",
			status: "running",
			command: "old process",
			createdAt: time,
			updatedAt: time,
			startedAt: time,
		},
		{
			id: "old-crashed",
			parentNarratorId: "parent",
			type: "bash",
			status: "running",
			command: "unknown old process",
			createdAt: time,
			updatedAt: time,
			startedAt: time,
		},
	])
	.run();
mock.module("../../db", () => ({ db, sqlite }));
const { backgroundTaskService: tasks } = await import("../background-task-service");
const { runtimePublication: publisher } = await import("../agent-runtime/publication");
publisher.stop();
tasks.setBroadcastFnForTests(() => {});
afterAll(async () => {
	await new Promise<void>((resolve) => setImmediate(resolve));
	sqlite.close();
	mock.restore();
});

test("real pre-upgrade live completion and unknown crash are grandfathered even at full new quota", async () => {
	const controller = new AbortController();
	tasks.registerAbortController("old-live", controller);
	for (let i = 0; i < L.publicationRecipientSlots; i++) {
		publisher.store.reserveRunSlots({
			producerKind: "bash",
			taskId: `quota-${i}`,
			logicalRunId: `quota-${i}`,
			recipientId: "parent",
		});
	}
	expect(await tasks.markCompleted("old-live", "actual old result", 0, controller)).toBe(true);
	const completed = await tasks.getById("old-live");
	expect(completed?.logicalRunId).toMatch(/^legacy:/);
	expect(completed?.status).toBe("completed");
	expect(completed?.output).toBe("actual old result");
	await expect(
		tasks.createBashTask({
			id: "new-refused",
			parentNarratorId: "parent",
			command: "must not run",
		}),
	).rejects.toThrow("publication capacity");
	expect(await tasks.recoverStaleTasksAfterRestart()).toBe(1);
	const unknown = await tasks.getById("old-crashed");
	expect(unknown?.logicalRunId).toMatch(/^legacy:unknown:/);
	expect(unknown?.status).toBe("failed");
	expect(unknown?.output).toContain("outcome unknown");
	const oldEntry = {
		kind: "bg_bash" as const,
		task: {
			id: "old-completed",
			type: "bash" as const,
			title: "finished",
			alias: "finished",
			status: "completed",
			outputPreview: "old done result",
		},
	};
	publisher.setLegacyCompletionAdmissionReader((source) =>
		source.taskId === oldEntry.task.id
			? { ...source, token: oldEntry, eventKind: "completed" }
			: undefined,
	);
	expect(publisher.migrateLegacyTaskNotice("parent", oldEntry)).toBe("migrated");
	expect(publisher.migrateLegacyTaskNotice("parent", oldEntry)).toBe("migrated");
	publisher.flushRecipient("parent");
	const notices = db
		.select()
		.from(narratorBufferedMessages)
		.all()
		.map((row) => JSON.parse(row.metadataJson ?? "{}"));
	expect(notices.map((row) => row.eventKind)).toEqual(["completed", "failed", "completed"]);
	expect(notices[0].taskId).toBe("old-live");
	expect(notices[1].taskId).toBe("old-crashed");
	expect(
		db
			.select()
			.from(runtimePublicationOutbox)
			.where(eq(runtimePublicationOutbox.state, "pending"))
			.all(),
	).toHaveLength(0);
});
