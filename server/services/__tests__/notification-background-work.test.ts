/**
 * `notification-service` listener gating on `backgroundWorkActive`.
 *
 * A `narrator:attention` done event raised while non-service background work is
 * still running must NOT fan out to IM webhooks (DingTalk/Feishu) — the session
 * is not actually finished. The unflagged event (e.g. the wake-up turn after the
 * last background task completes) still notifies exactly as before.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { cleanDb } from "../../../tests/setup";
import {
	narrators,
	userPreferences,
	userRecentTabs,
	userRecentTabsMeta,
	users,
} from "../../db/schema";
import {
	closeRuntimeTestDb,
	getRuntimeTestDb,
	prepareRuntimeTestDb,
} from "./agent-runtime-test-database";
// Rejections settle natively before matching: Bun's `.rejects` stalls on a reused read Worker.
import { captureWorkerRejectionThrower } from "./narrator-worker-fixture";

const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
const realDbModule = { ...(await import("../../db")) };
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWsModule,
	broadcastToUser: () => {},
	getNarratorPresenceBatch: () => new Map(),
}));

// Importing the service registers its `narrator:attention` listener as a
// module side effect — the gating under test lives in that listener.
const notifications = await import("../notification-service");
const { eventBus } = await import("../../lib/event-bus");
const pool = await import("../../lib/db-worker/pool");
const { logger } = await import("../../lib/logger");
const runReadTask = pool.runReadTask;
let expectedFailures = 0;
let fixtureClosed = false;

const NOW = "2026-10-19T00:00:00.000Z";
const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; init?: RequestInit }> = [];

function seedFixture(targetDb = db): void {
	targetDb
		.insert(users)
		.values({
			id: "bg-notify-user",
			username: "bg-notify-user",
			passwordHash: "test-password-hash",
			role: "user",
			createdAt: NOW,
		})
		.run();
	targetDb
		.insert(userPreferences)
		.values({
			id: "pref-bg-notify-user",
			userId: "bg-notify-user",
			recentTabs: "[]",
			notifyDingtalkEnabled: true,
			notifyDingtalkWebhook: "https://example.test/hook?access=1",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	targetDb
		.insert(narrators)
		.values({
			id: "narrator-bg-notify",
			title: "Background-work narrator",
			status: "idle",
			visibility: "public",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	targetDb
		.insert(userRecentTabsMeta)
		.values({
			userId: "bg-notify-user",
			revision: 1,
			migratedAt: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	targetDb
		.insert(userRecentTabs)
		.values({
			id: "recent-bg-notify",
			userId: "bg-notify-user",
			tabKey: "narrator:narrator-bg-notify",
			section: "work",
			type: "narrator",
			entityId: "narrator-bg-notify",
			representedNarratorId: "narrator-bg-notify",
			title: "Background-work narrator",
			lastVisitedAt: 1,
			sortOrder: 0,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

/** Observe the same whole-handler boundary used by shutdown and fixture teardown. */
async function settleListener(): Promise<void> {
	await notifications.drainNotificationBackgroundWork();
}

beforeEach(async () => {
	await prepareRuntimeTestDb(sqlite);
	expectedFailures = 0;
	requests.length = 0;
	globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), init });
		return new Response(JSON.stringify({ errcode: 0 }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
});

afterEach(async () => {
	if (!fixtureClosed)
		await notifications.resetNotificationBackgroundWorkForTests({ expectedFailures });
	await notifications.stopNotificationBackgroundWork();
	globalThis.fetch = originalFetch;
	mock.restore();
	if (!fixtureClosed) cleanDb(sqlite);
});

afterAll(async () => {
	await notifications.stopNotificationBackgroundWork();
	if (!fixtureClosed) await closeRuntimeTestDb(sqlite);
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

describe("notification-service backgroundWorkActive gating", () => {
	it("suppresses the IM webhook when the done event carries backgroundWorkActive", async () => {
		seedFixture();

		eventBus.emit({
			type: "narrator:attention",
			narratorId: "narrator-bg-notify",
			reason: "done",
			backgroundWorkActive: true,
		});
		await settleListener();

		expect(requests).toHaveLength(0);
	});

	it("still notifies on an unflagged done event", async () => {
		seedFixture();

		eventBus.emit({
			type: "narrator:attention",
			narratorId: "narrator-bg-notify",
			reason: "done",
		});
		await settleListener();

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toContain("https://example.test/hook?access=1");
	});
});

function attention(): void {
	eventBus.emit({
		type: "narrator:attention",
		narratorId: "narrator-bg-notify",
		reason: "done",
	});
}

/** Delay actual Worker reads without replacing their SQL, rows, ACL or webhook behavior. */
function holdQueries(needles: string[]) {
	const barriers = needles.map((needle) => ({
		needle,
		entered: Promise.withResolvers<void>(),
		release: Promise.withResolvers<void>(),
	}));
	let next = 0;
	spyOn(pool, "runReadTask").mockImplementation(
		async <T>(...args: Parameters<typeof pool.runReadTask>): Promise<T> => {
			const barrier = barriers[next];
			const params = args[1];
			if (barrier && "sql" in params && params.sql.includes(barrier.needle)) {
				next++;
				barrier.entered.resolve();
				await barrier.release.promise;
			}
			return runReadTask<T>(...args);
		},
	);
	return barriers;
}

describe("automatic attention background lifecycle", () => {
	it("stop closes admission synchronously and joins subsequent reads across the whole handler", async () => {
		seedFixture();
		const barriers = holdQueries(['"narrators"', '"notify_on_done"']);
		let settled = false;
		let stopping: Promise<void> | undefined;
		try {
			attention();
			await barriers[0].entered.promise;
			expect(notifications.getNotificationBackgroundWorkSnapshot()).toEqual({
				stopped: false,
				pending: 1,
				failed: 0,
			});
			stopping = notifications.stopNotificationBackgroundWork().then(() => {
				settled = true;
			});
			expect(notifications.getNotificationBackgroundWorkSnapshot().stopped).toBe(true);
			attention();
			expect(notifications.getNotificationBackgroundWorkSnapshot().pending).toBe(1);
			barriers[0].release.resolve();
			await barriers[1].entered.promise;
			expect(settled).toBe(false);
			expect(requests).toHaveLength(0);
			barriers[1].release.resolve();
			await stopping;
			expect(requests).toHaveLength(1);
			expect(notifications.getNotificationBackgroundWorkSnapshot()).toEqual({
				stopped: true,
				pending: 0,
				failed: 0,
			});
			await notifications.stopNotificationBackgroundWork();
			attention();
			await settleListener();
			expect(requests).toHaveLength(1);
		} finally {
			for (const barrier of barriers) barrier.release.resolve();
			await stopping;
		}
	});

	it("drain waits for delivery without closing automatic admission", async () => {
		seedFixture();
		const [barrier] = holdQueries(['"notify_on_done"']);
		let draining: Promise<void> | undefined;
		let settled = false;
		try {
			attention();
			await barrier.entered.promise;
			draining = notifications.drainNotificationBackgroundWork().then(() => {
				settled = true;
			});
			expect(settled).toBe(false);
			expect(notifications.getNotificationBackgroundWorkSnapshot().stopped).toBe(false);
			barrier.release.resolve();
			await draining;
			attention();
			await settleListener();
			expect(requests).toHaveLength(2);
			expect(notifications.getNotificationBackgroundWorkSnapshot().pending).toBe(0);
		} finally {
			barrier.release.resolve();
			await draining;
		}
	});

	it("deadline and test reset retain a live handler and keep stop closed", async () => {
		seedFixture();
		const [barrier] = holdQueries(['"narrators"']);
		try {
			attention();
			await barrier.entered.promise;
			expect(
				await captureWorkerRejectionThrower(
					notifications.stopNotificationBackgroundWork({ deadlineAt: Date.now() - 1 }),
				),
			).toThrow("did not drain before its deadline");
			expect(
				await captureWorkerRejectionThrower(
					notifications.resetNotificationBackgroundWorkForTests({ deadlineAt: Date.now() - 1 }),
				),
			).toThrow("did not drain before its deadline");
			attention();
			expect(notifications.getNotificationBackgroundWorkSnapshot()).toEqual({
				stopped: true,
				pending: 1,
				failed: 0,
			});
			barrier.release.resolve();
			await notifications.stopNotificationBackgroundWork();
			expect(requests).toHaveLength(1);
			expect(notifications.getNotificationBackgroundWorkSnapshot()).toEqual({
				stopped: true,
				pending: 0,
				failed: 0,
			});
		} finally {
			barrier.release.resolve();
			await notifications.stopNotificationBackgroundWork();
		}
	});

	it("records a later query failure and rejects every drain or stop until explicitly acknowledged", async () => {
		seedFixture();
		const marker = new Error("fixture automatic notification query failed");
		const errors = spyOn(logger, "error");
		spyOn(pool, "runReadTask").mockImplementation(
			async <T>(...args: Parameters<typeof pool.runReadTask>): Promise<T> => {
				if ("sql" in args[1] && args[1].sql.includes('"notify_on_done"')) throw marker;
				return runReadTask<T>(...args);
			},
		);
		attention();
		expect(
			await captureWorkerRejectionThrower(notifications.drainNotificationBackgroundWork()),
		).toThrow("Notification background work failed");
		expect(notifications.getNotificationBackgroundWorkSnapshot()).toEqual({
			stopped: false,
			pending: 0,
			failed: 1,
		});
		expectedFailures = 1;
		expect(errors).toHaveBeenCalledWith("Notification handler error", {
			narratorId: "narrator-bg-notify",
			error: marker.message,
		});
		expect(
			await captureWorkerRejectionThrower(notifications.stopNotificationBackgroundWork()),
		).toThrow("Notification background work failed");
		expect(
			await captureWorkerRejectionThrower(notifications.stopNotificationBackgroundWork()),
		).toThrow("Notification background work failed");
		attention();
		expect(notifications.getNotificationBackgroundWorkSnapshot()).toEqual({
			stopped: true,
			pending: 0,
			failed: 1,
		});
		expect(requests).toHaveLength(0);
	});

	it("keeps explicit sends and HTTP failure results available after automatic stop", async () => {
		seedFixture();
		await notifications.stopNotificationBackgroundWork();
		const input = {
			user_id: "bg-notify-user",
			title: "Explicit fixture notification",
			message: "Manual sending remains independent of automatic shutdown",
			channels: ["dingtalk"] as ["dingtalk"],
		};
		expect(
			await notifications.sendUserNotification(input, { narratorId: "narrator-bg-notify" }),
		).toMatchObject({ status: "success" });
		globalThis.fetch = mock(
			async () => new Response("unavailable", { status: 503 }),
		) as unknown as typeof fetch;
		expect(
			await notifications.sendUserNotification(input, { narratorId: "narrator-bg-notify" }),
		).toMatchObject({ status: "failed", results: [{ channel: "dingtalk", status: "failed" }] });
		expect(notifications.getNotificationBackgroundWorkSnapshot()).toEqual({
			stopped: true,
			pending: 0,
			failed: 0,
		});
	});

	it("runtime fixture teardown closes attention admission before reader exit and rearms a new fixture", async () => {
		seedFixture();
		const errors = spyOn(logger, "error");
		const barriers = holdQueries(['"narrators"', '"notify_on_done"']);
		const closeEntered = Promise.withResolvers<void>();
		const releaseClose = Promise.withResolvers<void>();
		// The fixture's reader exit (Worker pool shutdown) is held open here.
		const shutdownDbWorkerPool = pool.shutdownDbWorkerPool;
		spyOn(pool, "shutdownDbWorkerPool").mockImplementation(async (...args) => {
			closeEntered.resolve();
			await releaseClose.promise;
			await shutdownDbWorkerPool(...args);
		});
		let closing: Promise<void> | undefined;
		let nextFixture: ReturnType<typeof getRuntimeTestDb> | undefined;
		let nextClosed = false;
		try {
			attention();
			await barriers[0].entered.promise;
			closing = closeRuntimeTestDb(sqlite).then(() => {
				fixtureClosed = true;
			});
			barriers[0].release.resolve();
			await barriers[1].entered.promise;
			expect(fixtureClosed).toBe(false);
			expect(notifications.getNotificationBackgroundWorkSnapshot().pending).toBe(1);
			barriers[1].release.resolve();
			await closeEntered.promise;
			expect(notifications.getNotificationBackgroundWorkSnapshot()).toEqual({
				stopped: true,
				pending: 0,
				failed: 0,
			});
			// Native reader exit is still held, so a late attention would otherwise reopen work.
			attention();
			expect(notifications.getNotificationBackgroundWorkSnapshot().pending).toBe(0);
			expect(requests).toHaveLength(1);
			releaseClose.resolve();
			await closing;
			expect(fixtureClosed).toBe(true);

			nextFixture = getRuntimeTestDb();
			await nextFixture.ready;
			const mounted = nextFixture;
			mock.module("../../db", () => ({ ...realDbModule, db: mounted.db, sqlite: mounted.sqlite }));
			seedFixture(mounted.db);
			await prepareRuntimeTestDb(mounted.sqlite);
			attention();
			expect(notifications.getNotificationBackgroundWorkSnapshot()).toEqual({
				stopped: false,
				pending: 1,
				failed: 0,
			});
			await settleListener();
			expect(requests).toHaveLength(2);
			expect(errors).not.toHaveBeenCalled();
			await closeRuntimeTestDb(mounted.sqlite);
			nextClosed = true;
			expect(notifications.getNotificationBackgroundWorkSnapshot()).toEqual({
				stopped: true,
				pending: 0,
				failed: 0,
			});
		} finally {
			for (const barrier of barriers) barrier.release.resolve();
			releaseClose.resolve();
			await closing;
			if (nextFixture && !nextClosed) await closeRuntimeTestDb(nextFixture.sqlite);
		}
	});
});
