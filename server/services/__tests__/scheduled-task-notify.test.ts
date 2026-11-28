import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { scheduledTaskRuns, scheduledTasks, userPreferences, users } from "../../db/schema";
import { logger } from "../../lib/logger";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const workerFixture = getNarratorWorkerTestDb();
const { db, sqlite } = workerFixture;
await workerFixture.ready;
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { notifyScheduledRunChanged, notifyScheduledTaskTransferred } = await import(
	"../scheduled-task-notify"
);
const { deliverNotification } = await import("../notification-delivery");
const {
	ensureNotificationsTableForTests,
	getUnreadCounts,
	listNotifications,
	onNotificationCenterChanged,
	recordNotificationOnce,
} = await import("../notification-center-service");
const { notificationListQuerySchema } = await import("../../lib/validators/notifications");
const originalFetch = globalThis.fetch;
const NOW = "2026-11-01T00:00:00.000Z";
const OWNER = "task-owner",
	NEXT = "next-owner";
const privateValues = ["prompt-secret", "system-secret", "error-secret", "summary-secret"];
const requests: Array<{ url: string; body: string }> = [];

function task(patch: Partial<typeof scheduledTasks.$inferInsert> = {}) {
	const id = patch.id ?? "task";
	db.insert(scheduledTasks)
		.values({
			id,
			name: `<@all> [task](link)\n${"x".repeat(300)}`,
			ownerUserId: OWNER,
			createdBy: OWNER,
			cronExpr: "0 * * * *",
			schedule: { kind: "cron", expr: "0 * * * *", end: { type: "never" } },
			prompt: privateValues[0],
			systemPrompt: privateValues[1],
			lastError: privateValues[2],
			lastSummary: privateValues[3],
			onBlocked: "wait",
			notifyOnSuccess: false,
			consecutiveFailures: 1,
			createdAt: NOW,
			updatedAt: NOW,
			...patch,
		})
		.run();
	return id;
}

function run(patch: Partial<typeof scheduledTaskRuns.$inferInsert> = {}) {
	const id = patch.id ?? "run";
	db.insert(scheduledTaskRuns)
		.values({
			id,
			taskId: "task",
			status: "failed",
			errorKind: "provider",
			error: privateValues[2],
			outcomeSummary: privateValues[3],
			runContext: "standalone",
			createdAt: NOW,
			...patch,
		})
		.run();
	return id;
}

function stored() {
	return sqlite
		.query<
			{ user_id: string; source_key: string; title: string; preview: string; link_json: string },
			[]
		>(
			"SELECT user_id,source_key,title,preview,link_json FROM notifications WHERE kind = 'scheduled_task' ORDER BY source_key",
		)
		.all();
}

beforeEach(() => {
	cleanDb(sqlite);
	ensureNotificationsTableForTests(sqlite);
	requests.length = 0;
	for (const id of [OWNER, NEXT]) {
		db.insert(users).values({ id, username: id, passwordHash: "x", createdAt: NOW }).run();
		db.insert(userPreferences)
			.values({
				id: `pref-${id}`,
				userId: id,
				notifyDingtalkEnabled: true,
				notifyDingtalkWebhook: `https://example.test/${id}/ding`,
				notifyFeishuEnabled: true,
				notifyFeishuWebhook: `https://example.test/${id}/fei`,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
	}
	globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
		requests.push({ url: String(url), body: String(init?.body) });
		return Response.json({ errcode: 0, code: 0 });
	}) as unknown as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	mock.restore();
});
afterAll(async () => {
	mock.module("../../db", () => realDb);
	await workerFixture.close();
});

describe("owner-directed scheduled task notifications", () => {
	test("claims run+kind persistently before delivery, including concurrent repeats", async () => {
		task();
		run();
		await Promise.all(Array.from({ length: 8 }, () => notifyScheduledRunChanged("run", "failed")));
		expect(stored()).toHaveLength(1);
		expect(requests).toHaveLength(2);
		await notifyScheduledRunChanged("run", "failed");
		expect(requests).toHaveLength(2);
		expect(stored()[0]?.source_key).toBe("run:run:failed");
		expect(requests.every((request) => request.url.includes(OWNER))).toBe(true);
		expect((await getUnreadCounts(OWNER)).unreadActivities).toBe(1);
		expect(notificationListQuerySchema.safeParse({ kind: "scheduled_task" }).success).toBe(true);
	});

	test("never selects source secrets; stored and channel text are bounded and mention-safe", async () => {
		task();
		run();
		const select = spyOn(db, "select");
		const log = spyOn(logger, "info").mockImplementation(() => {});
		await notifyScheduledRunChanged("run", "failed");
		const fields = select.mock.calls.flatMap(([columns]) => Object.keys(columns ?? {}));
		for (const field of [
			"prompt",
			"systemPrompt",
			"error",
			"outcomeSummary",
			"lastSummary",
			"lastError",
		])
			expect(fields).not.toContain(field);
		const output = JSON.stringify({ rows: stored(), requests, logs: log.mock.calls });
		for (const secret of privateValues) expect(output).not.toContain(secret);
		const alert = stored()[0];
		expect(alert?.title.length).toBeLessThanOrEqual(120);
		expect(alert?.preview.length).toBeLessThanOrEqual(120);
		expect(alert?.title).not.toMatch(/[\n@<>[\]()]/);
		expect(requests[0]?.body).toContain("/scheduled-tasks/task?runId=run");
	});

	test("only successful opted-in completions and human wait blocks notify", async () => {
		task();
		run({ status: "completed" });
		await notifyScheduledRunChanged("run", "completed");
		expect(stored()).toHaveLength(0);
		db.update(scheduledTasks)
			.set({ notifyOnSuccess: true })
			.where(eq(scheduledTasks.id, "task"))
			.run();
		await notifyScheduledRunChanged("run", "completed");
		expect(stored()).toHaveLength(1);
		run({ id: "blocked", status: "blocked", blockReason: "provider_wait" });
		await notifyScheduledRunChanged("blocked", "blocked");
		db.update(scheduledTaskRuns)
			.set({ blockReason: "question" })
			.where(eq(scheduledTaskRuns.id, "blocked"))
			.run();
		db.update(scheduledTasks).set({ onBlocked: "auto" }).where(eq(scheduledTasks.id, "task")).run();
		await notifyScheduledRunChanged("blocked", "blocked");
		expect(stored()).toHaveLength(1);
		db.update(scheduledTasks).set({ onBlocked: "wait" }).where(eq(scheduledTasks.id, "task")).run();
		await notifyScheduledRunChanged("blocked", "blocked");
		expect(stored()).toHaveLength(2);
		expect(
			(await listNotifications({ userId: OWNER })).items.find(
				(item) => item.sourceKey === "run:blocked:blocked",
			)?.sourceState,
		).toBe("active");
	});

	test("alerts only once per consecutive failure streak and separately for the circuit breaker", async () => {
		task();
		run();
		await notifyScheduledRunChanged("run", "failed");
		db.update(scheduledTasks)
			.set({ consecutiveFailures: 2 })
			.where(eq(scheduledTasks.id, "task"))
			.run();
		run({ id: "repeat", createdAt: "2026-11-01T00:01:00.000Z" });
		await notifyScheduledRunChanged("repeat", "failed");
		expect(stored()).toHaveLength(1);
		run({ id: "different", errorKind: "acl", createdAt: "2026-11-01T00:02:00.000Z" });
		await notifyScheduledRunChanged("different", "failed");
		expect(stored()).toHaveLength(1);
		db.update(scheduledTasks)
			.set({ enabled: false, pauseReason: "circuit_breaker", consecutiveFailures: 3 })
			.where(eq(scheduledTasks.id, "task"))
			.run();
		await notifyScheduledRunChanged("different", "circuit_breaker");
		await notifyScheduledRunChanged("different", "circuit_breaker");
		expect(stored()).toHaveLength(2);
		expect(requests).toHaveLength(4);
	});

	test("current owner wins; cleared modern owners are not resurrected from createdBy", async () => {
		task({ ownerUserId: NEXT });
		run();
		await notifyScheduledRunChanged("run", "failed");
		expect(stored()[0]?.user_id).toBe(NEXT);
		expect(requests.every((request) => request.url.includes(NEXT))).toBe(true);
		task({ id: "ownerless", ownerUserId: null });
		run({ id: "ownerless-run", taskId: "ownerless" });
		await notifyScheduledRunChanged("ownerless-run", "failed");
		expect(stored()).toHaveLength(1);
		task({ id: "legacy", ownerUserId: null, schedule: null });
		run({ id: "legacy-run", taskId: "legacy" });
		await notifyScheduledRunChanged("legacy-run", "failed");
		expect(stored()).toHaveLength(2);
	});

	test("rechecks ownership after persistence and redacts unavailable links on list", async () => {
		task();
		run();
		const off = onNotificationCenterChanged(() => {
			db.update(scheduledTasks)
				.set({ ownerUserId: NEXT })
				.where(eq(scheduledTasks.id, "task"))
				.run();
		});
		try {
			await notifyScheduledRunChanged("run", "failed");
		} finally {
			off();
		}
		expect(requests).toHaveLength(0);
		const item = (await listNotifications({ userId: OWNER })).items[0];
		expect(item).toMatchObject({
			sourceState: "gone",
			title: "",
			preview: "",
			sourceKey: null,
			link: { type: "unavailable" },
		});
		expect((await getUnreadCounts(OWNER)).unreadActivities).toBe(0);
	});

	test("rechecks ownership after waiting for bounded channel admission", async () => {
		task();
		run();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		globalThis.fetch = mock(async (url: unknown) => {
			requests.push({ url: String(url), body: "" });
			await gate;
			return Response.json({ errcode: 0, code: 0 });
		}) as unknown as typeof fetch;
		const blockers = [1, 2].map((id) =>
			deliverNotification({
				channel: "dingtalk",
				webhook: `https://example.test/occupy-${id}`,
				secret: "",
				title: "",
				message: "",
				source: "test",
			}),
		);
		const pending = notifyScheduledRunChanged("run", "failed");
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(stored()).toHaveLength(1);
			expect(requests).toHaveLength(2);
			db.update(scheduledTasks)
				.set({ ownerUserId: NEXT })
				.where(eq(scheduledTasks.id, "task"))
				.run();
		} finally {
			release();
			await Promise.all([...blockers, pending]);
		}
		expect(requests).toHaveLength(2);
	});

	test("a failed durable claim never delivers and never logs SQL secrets", async () => {
		task();
		run();
		const insert = spyOn(db, "get").mockImplementation(() => {
			throw new Error(privateValues.join(" "));
		});
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		await notifyScheduledRunChanged("run", "failed");
		expect(insert).toHaveBeenCalledTimes(1);
		expect(requests).toHaveLength(0);
		expect(stored()).toHaveLength(0);
		for (const secret of privateValues)
			expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
	});

	test("transfer alerts are idempotent per persisted change; mismatched run links fail closed", async () => {
		task({
			lastModifiedBy: {
				kind: "user",
				userId: OWNER,
				action: "transfer_owner_on_user_deletion",
				at: NOW,
			},
		});
		await notifyScheduledTaskTransferred("task");
		await notifyScheduledTaskTransferred("task");
		expect(stored()).toHaveLength(1);
		// A second same-ms transfer has a new monotonic row revision.
		db.update(scheduledTasks)
			.set({ updatedAt: "2026-11-01T00:00:00.001Z" })
			.where(eq(scheduledTasks.id, "task"))
			.run();
		await notifyScheduledTaskTransferred("task");
		expect(stored()).toHaveLength(2);
		db.update(scheduledTasks)
			.set({
				lastModifiedBy: { kind: "user", userId: OWNER, action: "update", at: NOW },
				updatedAt: "2026-11-01T00:00:00.002Z",
			})
			.where(eq(scheduledTasks.id, "task"))
			.run();
		await notifyScheduledTaskTransferred("task");
		expect(stored()).toHaveLength(2);
		task({ id: "other" });
		run({ taskId: "other" });
		await recordNotificationOnce({
			userId: OWNER,
			kind: "scheduled_task",
			sourceKey: "bad-link",
			title: "hidden",
			preview: "hidden",
			link: { type: "scheduled_task", taskId: "task", runId: "run" },
		});
		const page = await listNotifications({ userId: OWNER, kind: "scheduled_task" });
		expect(page.items.find((item) => item.sourceState === "gone")).toMatchObject({
			title: "",
			preview: "",
			link: { type: "unavailable" },
		});
		db.delete(scheduledTasks).where(eq(scheduledTasks.id, "task")).run();
		expect(
			(await listNotifications({ userId: OWNER })).items.every(
				(item) => item.sourceState === "gone",
			),
		).toBe(true);
	});
});
