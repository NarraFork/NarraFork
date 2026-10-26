import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import {
	NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
	NARRATOR_WS_SUBSCRIPTION_LIMIT_ERROR_CODE,
} from "../../shared/recent-tabs";
import { cleanDb, getTestDb } from "../../tests/setup";
import {
	backgroundTasks,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
} from "../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../db")) };
mock.module("../db", () => ({ db, sqlite }));

const { broadcastToNarrator, broadcastToUser, getNarratorConnections, handleNarratorWS } =
	await import("./narrator-ws");
const { eventBus } = await import("../lib/event-bus");
const { backgroundOccupancyStore } = await import("../services/background-occupancy-store");
const { backgroundTaskService } = await import("../services/background-task-service");

async function settleOccupancy(): Promise<void> {
	await backgroundOccupancyStore.flush();
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

type SentMessage = Record<string, unknown>;
type FakeNarratorWS = Parameters<typeof handleNarratorWS.open>[0];

const openedConnections: FakeNarratorWS[] = [];

function createFakeWs(
	options: { userId?: string; subscribedNarrators?: Set<string>; userRole?: string } = {},
) {
	const sent: SentMessage[] = [];
	let throwOnSend = false;
	const ws = {
		data: {
			channel: "narrator" as const,
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			subscribedNarrators: options.subscribedNarrators ?? new Set<string>(),
			catchingUpNarrators: new Map(),
			catchUpBuffers: new Map(),
			// Narrator subscribe/presence frames are authorized against this identity, so
			// a connection with no user is (correctly) refused everything. Default to a
			// real id here and gate visibility through the seeded rows instead.
			userId: options.userId ?? "ws-test-user",
			userRole: options.userRole,
		},
		send(payload: string) {
			if (throwOnSend) throw new Error("socket closed");
			sent.push(JSON.parse(payload) as SentMessage);
		},
		close() {},
	} as unknown as FakeNarratorWS;
	return {
		ws,
		sent,
		setThrowOnSend(value: boolean) {
			throwOnSend = value;
		},
	};
}

function openFakeWs(
	options: { userId?: string; subscribedNarrators?: Set<string>; userRole?: string } = {},
) {
	const connection = createFakeWs(options);
	handleNarratorWS.open(connection.ws);
	openedConnections.push(connection.ws);
	return connection;
}

async function seedNarrators() {
	const now = "2026-07-19T00:00:00.000Z";
	db.insert(projects)
		.values({
			id: "project-ws",
			name: "WebSocket Test",
			gitPath: "/tmp/narrafork-ws-test",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narrators)
		.values([
			{
				id: "narrator-working",
				contextProjectId: "project-ws",
				status: "working",
				substatus: '["reasoning"]',
				turnStartedAt: now,
				// These fixtures exercise subscription/presence plumbing, not access control
				// (narrator-acl.test.ts owns that), so they are readable on purpose.
				visibility: "public",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "narrator-idle",
				contextProjectId: "project-ws",
				status: "idle",
				substatus: "[]",
				visibility: "public",
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();
	await backgroundOccupancyStore.start();
	await settleOccupancy();
}

/** A readable standalone narrator, for frames that need an existing row. */
function seedReadableNarrator(id: string) {
	const now = "2026-07-19T00:00:00.000Z";
	db.insert(narrators)
		.values({
			id,
			status: "idle",
			substatus: "[]",
			visibility: "public",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

afterEach(() => {
	for (const ws of openedConnections.splice(0)) handleNarratorWS.close(ws);
	getNarratorConnections().clear();
	backgroundTaskService.resetListVersionsForTests();
	cleanDb(sqlite);
});

afterAll(() => {
	mock.module("../db", () => realDbModule);
	sqlite.close();
});

describe("HumanAttention global invalidation", () => {
	it("reaches authenticated clients without any narrator subscription and carries no source data", async () => {
		const first = openFakeWs({ userId: "attention-user-a" });
		const second = openFakeWs({ userId: "attention-user-b" });
		const anonymous = createFakeWs();
		anonymous.ws.data.userId = undefined;
		handleNarratorWS.open(anonymous.ws);
		openedConnections.push(anonymous.ws);

		for (let index = 0; index < 10; index++) {
			eventBus.emit({ type: "human_attention:changed" });
		}
		await new Promise((resolve) => setTimeout(resolve, 80));
		for (const { sent, ws } of [first, second]) {
			expect(ws.data.subscribedNarrators.size).toBe(0);
			expect(sent.filter((message) => message.type === "human_attention_changed")).toEqual([
				{ type: "human_attention_changed" },
			]);
		}
		expect(anonymous.sent.filter((message) => message.type === "human_attention_changed")).toEqual(
			[],
		);

		// A later committed change must not be swallowed by the previous batch.
		eventBus.emit({ type: "human_attention:changed" });
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(first.sent.filter((message) => message.type === "human_attention_changed")).toHaveLength(
			2,
		);
	});

	it("invalidates cascaded question deletion without exposing the private history frame", async () => {
		const { sent } = openFakeWs();
		eventBus.emit({
			type: "narrator:message_broadcast",
			narratorId: "private-owner",
			message: {
				type: "messages_deleted",
				narratorId: "private-owner",
				deletedMessageIds: ["private-question-message"],
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(sent.filter((message) => message.type === "human_attention_changed")).toEqual([
			{ type: "human_attention_changed" },
		]);
		expect(sent.some((message) => message.type === "messages_deleted")).toBe(false);
	});

	it("does not turn reflection progress or narrator working status into inbox scans", async () => {
		const { sent } = openFakeWs();
		eventBus.emit({
			type: "narrator:status_changed",
			narratorId: "unsubscribed-child",
			status: "waiting",
			substatus: ["reflecting"],
		});
		eventBus.emit({
			type: "narrator:message_broadcast",
			narratorId: "unsubscribed-child",
			message: {
				type: "reflection_progress",
				narratorId: "unsubscribed-child",
				requestId: "automatic-gate",
				toolUseId: "automatic-tool",
				kind: "danger_reflection",
				phase: "thinking",
				thinkingChars: 200,
				outputChars: 0,
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(sent.filter((message) => message.type === "human_attention_changed")).toEqual([]);
	});
});

describe("narrator WebSocket message snapshot subscribe", () => {
	it("restores state after a missed part even when the model message version is equal", async () => {
		seedReadableNarrator("state-reconnect");
		const { ws, sent } = openFakeWs();
		const { narratorService } = await import("../services/narrator-service");
		const version = await narratorService.getMessageVersion("state-reconnect");
		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "messages",
			narratorIds: ["state-reconnect"],
			version,
			restoreState: true,
			requestId: "restore-reader-state",
		});
		expect(
			sent.some(
				(frame) =>
					frame.type === "full_reload" && frame.subscriptionRequestId === "restore-reader-state",
			),
		).toBe(true);
		expect(sent.some((frame) => frame.type === "sync_ok")).toBe(false);
	});

	it("a translation frame exceeding the socket budget closes for bounded recovery", () => {
		const { ws } = openFakeWs({ subscribedNarrators: new Set(["state-backpressure"]) });
		const close = spyOn(ws, "close").mockImplementation(() => {});
		ws.getBufferedAmount = () => 256 * 1024;
		broadcastToNarrator("state-backpressure", {
			type: "reasoning_translation_patch",
			narratorId: "state-backpressure",
			ownerNarratorId: "state-backpressure",
			messageId: "m",
			blockId: "persisted",
			elementId: "reason",
			blockRevision: 1,
			stateRevision: 2,
			translationGeneration: "g",
			part: {
				id: "part",
				generation: "g",
				start: 0,
				end: 1,
				sourceText: "A",
				translatedText: "甲",
			},
		});
		expect(close).toHaveBeenCalledWith(1013, "Reasoning translation recovery required");
		expect(getNarratorConnections().has(ws)).toBe(false);
		close.mockRestore();
	});

	it("returns request-scoped sync_ok for a matching version-only empty snapshot", async () => {
		await seedNarrators();
		const { ws, sent } = openFakeWs();

		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "messages",
			narratorIds: ["narrator-idle"],
			version: 0,
			requestId: "messages-empty-current",
		});

		expect(sent).toContainEqual({
			type: "sync_ok",
			narratorId: "narrator-idle",
			version: 0,
			subscriptionRequestId: "messages-empty-current",
		});
		// Panel subscriptions own runtime state, independently of the message cursor.
		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "panel",
			narratorIds: ["narrator-idle"],
			requestId: "messages-empty-current",
		});
		// Reconnect must explicitly clear client queue tags even with no streaming snapshot.
		expect(sent).toContainEqual({
			type: "queue_status",
			narratorId: "narrator-idle",
			position: 0,
			queueDepth: 0,
			subscriptionRequestId: "messages-empty-current",
		});
		expect(ws.data.subscribedNarrators.has("narrator-idle")).toBe(true);
	});

	it("forces a request-scoped reload when a version-only empty snapshot is stale", async () => {
		await seedNarrators();
		db.update(narrators).set({ messageVersion: 1 }).where(eq(narrators.id, "narrator-idle")).run();
		const { ws, sent } = openFakeWs();

		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "messages",
			narratorIds: ["narrator-idle"],
			version: 0,
			requestId: "messages-empty-stale",
		});

		expect(sent).toContainEqual({
			type: "full_reload",
			narratorId: "narrator-idle",
			subscriptionRequestId: "messages-empty-stale",
		});
		expect(sent.some((message) => message.type === "sync_ok")).toBe(false);
		expect(ws.data.subscribedNarrators.has("narrator-idle")).toBe(true);
	});

	it("catches up a stale snapshot cursor instead of accepting sync_ok", async () => {
		await seedNarrators();
		const now = "2026-07-19T00:00:01.000Z";
		db.insert(narratorMessages)
			.values([
				{
					id: "message-1",
					narratorId: "narrator-idle",
					role: "user",
					contentJson: [{ type: "text", text: "first" }],
					contentText: "first",
					createdAt: now,
				},
				{
					id: "message-2",
					narratorId: "narrator-idle",
					role: "assistant",
					contentJson: [{ type: "text", text: "second" }],
					contentText: "second",
					createdAt: now,
				},
			])
			.run();
		db.insert(narratorMessageRefs)
			.values([
				{ id: "ref-1", narratorId: "narrator-idle", messageId: "message-1", seq: 1 },
				{ id: "ref-2", narratorId: "narrator-idle", messageId: "message-2", seq: 2 },
			])
			.run();
		db.update(narrators).set({ messageVersion: 2 }).where(eq(narrators.id, "narrator-idle")).run();
		const { ws, sent } = openFakeWs();

		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "messages",
			narratorIds: ["narrator-idle"],
			catchUpCursor: { parentLastMessageId: "message-1" },
			version: 1,
			requestId: "messages-cursor-stale",
		});
		// The catch-up query and its block conversion run after the subscribe returns.
		for (let waited = 0; waited < 2000; waited += 10) {
			if (sent.some((message) => message.type === "catch_up")) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		const catchUp = sent.find((message) => message.type === "catch_up");
		expect(catchUp).toMatchObject({
			narratorId: "narrator-idle",
			messageVersion: 2,
			subscriptionRequestId: "messages-cursor-stale",
		});
		// Catch-up arrives as envelopes + blocks (message protocol v2).
		expect(catchUp).toMatchObject({ protocol: 2, orphanMessageIds: [] });
		expect(
			(catchUp?.messages as Array<{ id?: string }> | undefined)?.map((message) => message.id),
		).toEqual(["message-2"]);
		expect(sent.some((message) => message.type === "sync_ok")).toBe(false);
	});
});

describe("narrator WebSocket RecentTabs scaling", () => {
	it("sends list initial state as one batch snapshot instead of status_change frames", async () => {
		await seedNarrators();
		const { ws, sent } = openFakeWs();

		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "list",
			narratorIds: ["narrator-idle", "narrator-working"],
		});

		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual({
			type: "list_state_snapshot",
			items: [
				{
					narratorId: "narrator-idle",
					status: "idle",
					substatus: [],
					activeBackgroundTaskCount: 0,
					activeBackgroundWorkCount: 0,
					activeBackgroundServiceCount: 0,
				},
				{
					narratorId: "narrator-working",
					status: "working",
					substatus: ["reasoning"],
					turnStartedAt: "2026-07-19T00:00:00.000Z",
					activeBackgroundTaskCount: 0,
					activeBackgroundWorkCount: 0,
					activeBackgroundServiceCount: 0,
				},
			],
		});
		expect(sent.some((message) => message.type === "status_change")).toBe(false);
	});

	it("initial and reconnect list snapshots include work that outlives the foreground", async () => {
		await seedNarrators();
		const { backgroundTasks } = await import("../db/schema");
		const now = new Date().toISOString();
		db.insert(backgroundTasks)
			.values({
				id: "snapshot-background-bash",
				parentNarratorId: "narrator-idle",
				type: "bash",
				status: "running",
				startedAt: now,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		backgroundOccupancyStore.refreshTask("snapshot-background-bash");
		await settleOccupancy();
		for (let attempt = 0; attempt < 2; attempt++) {
			const { ws, sent } = openFakeWs();
			await handleNarratorWS.message(ws, {
				type: "subscribe",
				kind: "list",
				narratorIds: ["narrator-idle"],
			});
			expect(sent[0]).toMatchObject({
				type: "list_state_snapshot",
				items: [{ narratorId: "narrator-idle", status: "idle", activeBackgroundTaskCount: 1 }],
			});
			handleNarratorWS.close(ws);
		}
	});

	it("an in-flight old count snapshot cannot overwrite a delivered live count", async () => {
		await seedNarrators();
		const { backgroundTaskService } = await import("../services/background-task-service");
		const original = backgroundTaskService.countActiveKindsByParentBatch;
		let releaseRead = () => {};
		let readStarted = () => {};
		let liveDelivered = () => {};
		const blockedRead = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const started = new Promise<void>((resolve) => {
			readStarted = resolve;
		});
		const delivered = new Promise<void>((resolve) => {
			liveDelivered = resolve;
		});
		let firstRead = true;
		backgroundTaskService.countActiveKindsByParentBatch = async (ids) => {
			const block = firstRead;
			firstRead = false;
			const oldCounts = await original.call(backgroundTaskService, ids);
			if (block) {
				readStarted();
				await blockedRead;
			}
			return oldCounts;
		};
		backgroundTaskService.setBroadcastFnForTests((id, message) => {
			broadcastToNarrator(id, message);
			if (
				id === "narrator-idle" &&
				message.type === "background_task_count_changed" &&
				message.activeBackgroundTaskCount === 1
			)
				liveDelivered();
		});
		const { ws, sent } = openFakeWs();
		const subscription = handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "list",
			narratorIds: ["narrator-idle", "narrator-working"],
		});
		try {
			await started;
			await backgroundTaskService.createBashTask({
				id: "snapshot-racing-bash",
				parentNarratorId: "narrator-idle",
				command: "long work",
			});
			await delivered;
			expect(sent.some((message) => message.type === "list_state_snapshot")).toBe(false);
			releaseRead();
			await subscription;
			const snapshot = sent.find((message) => message.type === "list_state_snapshot");
			const items = snapshot?.items as Record<string, unknown>[];
			expect(items.find((item) => item.narratorId === "narrator-idle")).not.toHaveProperty(
				"activeBackgroundTaskCount",
			);
			expect(items.find((item) => item.narratorId === "narrator-working")).toHaveProperty(
				"activeBackgroundTaskCount",
				0,
			);
			expect(
				sent.find((message) => message.type === "background_task_count_changed"),
			).toMatchObject({ narratorId: "narrator-idle", activeBackgroundTaskCount: 1 });
		} finally {
			releaseRead();
			await subscription;
			backgroundTaskService.countActiveKindsByParentBatch = original;
			backgroundTaskService.setBroadcastFnForTests(null);
		}
	});

	it("restores service and work counts together without treating a service as unfinished work", async () => {
		await seedNarrators();
		const { backgroundTasks } = await import("../db/schema");
		const now = new Date().toISOString();
		await db.insert(backgroundTasks).values({
			id: "snapshot-service",
			parentNarratorId: "narrator-idle",
			type: "bash",
			backgroundKind: "service",
			status: "running",
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		});
		backgroundOccupancyStore.refreshTask("snapshot-service");
		await settleOccupancy();
		const { ws, sent } = openFakeWs();
		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "list",
			narratorIds: ["narrator-idle"],
		});
		expect(sent[0]).toMatchObject({
			type: "list_state_snapshot",
			items: [
				{
					narratorId: "narrator-idle",
					activeBackgroundTaskCount: 1,
					activeBackgroundWorkCount: 0,
					activeBackgroundServiceCount: 1,
				},
			],
		});
	});

	it("keeps basic list status and omits unknown counts when occupancy loading fails", async () => {
		await seedNarrators();
		const { backgroundTaskService } = await import("../services/background-task-service");
		const original = backgroundTaskService.countActiveKindsByParentBatch;
		backgroundTaskService.countActiveKindsByParentBatch = async () => {
			throw new Error("occupancy unavailable");
		};
		try {
			const { ws, sent } = openFakeWs();
			await handleNarratorWS.message(ws, {
				type: "subscribe",
				kind: "list",
				narratorIds: ["narrator-idle", "narrator-working"],
			});
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({
				type: "list_state_snapshot",
				items: [
					{ narratorId: "narrator-idle", status: "idle", substatus: [] },
					{ narratorId: "narrator-working", status: "working", substatus: ["reasoning"] },
				],
			});
			for (const item of sent[0]?.items as Record<string, unknown>[]) {
				expect(item).not.toHaveProperty("activeBackgroundTaskCount");
				expect(item).not.toHaveProperty("activeBackgroundWorkCount");
				expect(item).not.toHaveProperty("activeBackgroundServiceCount");
			}
		} finally {
			backgroundTaskService.countActiveKindsByParentBatch = original;
		}
	});

	it("rejects subscriptions above the per-connection total without changing existing ones", async () => {
		const existing = new Set(
			Array.from(
				{ length: NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION - 1 },
				(_, index) => `existing-${index}`,
			),
		);
		existing.add("panel-existing");
		const { ws, sent } = openFakeWs({ subscribedNarrators: existing });

		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "list",
			narratorIds: ["new-1", "new-2"],
		});

		expect(ws.data.subscribedNarrators.size).toBe(NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION);
		expect(ws.data.subscribedNarrators.has("panel-existing")).toBe(true);
		expect(ws.data.subscribedNarrators.has("new-1")).toBe(false);
		expect(ws.data.subscribedNarrators.has("new-2")).toBe(false);
		expect(sent).toEqual([
			expect.objectContaining({
				type: "error",
				code: NARRATOR_WS_SUBSCRIPTION_LIMIT_ERROR_CODE,
				maxSubscriptions: NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
			}),
		]);
	});

	it("broadcasts an empty presence update when the last viewer explicitly leaves", async () => {
		const narratorId = "presence-leave-narrator";
		seedReadableNarrator(narratorId);
		const observer = openFakeWs({ subscribedNarrators: new Set([narratorId]) });
		const viewer = openFakeWs({
			userId: "viewer-leave",
			subscribedNarrators: new Set([narratorId]),
		});

		await handleNarratorWS.message(viewer.ws, { type: "presence_join", narratorId });
		observer.sent.length = 0;
		await handleNarratorWS.message(viewer.ws, { type: "presence_leave", narratorId });

		expect(observer.sent).toEqual([{ type: "presence_update", narratorId, viewers: [] }]);
	});

	it("broadcasts an empty presence update when the last viewer connection closes", async () => {
		const narratorId = "presence-close-narrator";
		seedReadableNarrator(narratorId);
		const observer = openFakeWs({ subscribedNarrators: new Set([narratorId]) });
		const viewer = openFakeWs({
			userId: "viewer-close",
			subscribedNarrators: new Set([narratorId]),
		});

		await handleNarratorWS.message(viewer.ws, { type: "presence_join", narratorId });
		observer.sent.length = 0;
		handleNarratorWS.close(viewer.ws);

		expect(observer.sent).toEqual([{ type: "presence_update", narratorId, viewers: [] }]);
	});

	it("indexes user connections and cleans the index on close and send errors", () => {
		const first = openFakeWs({ userId: "user-1" });
		const otherUser = openFakeWs({ userId: "user-2" });
		const unindexed = createFakeWs({ userId: "user-1" });
		getNarratorConnections().add(unindexed.ws);

		broadcastToUser("user-1", {
			type: "user:recent_tabs_snapshot",
			tabs: [],
			revision: 1,
		});
		expect(first.sent).toHaveLength(1);
		expect(otherUser.sent).toHaveLength(0);
		expect(unindexed.sent).toHaveLength(0);

		handleNarratorWS.close(first.ws);
		broadcastToUser("user-1", {
			type: "user:recent_tabs_snapshot",
			tabs: [],
			revision: 2,
		});
		expect(first.sent).toHaveLength(1);

		const broken = openFakeWs({ userId: "user-1" });
		broken.setThrowOnSend(true);
		broadcastToUser("user-1", {
			type: "user:recent_tabs_snapshot",
			tabs: [],
			revision: 3,
		});
		expect(getNarratorConnections().has(broken.ws)).toBe(false);

		broken.setThrowOnSend(false);
		broadcastToUser("user-1", {
			type: "user:recent_tabs_snapshot",
			tabs: [],
			revision: 4,
		});
		expect(broken.sent).toHaveLength(0);
	});
});

describe("narrator WebSocket backgroundWorkActive snapshot flag", () => {
	/** Idle + unread narrator whose background occupancy we control per test. */
	function seedUnreadNarrator(id: string) {
		const now = "2026-07-19T00:00:00.000Z";
		db.insert(narrators)
			.values({
				id,
				status: "idle",
				substatus: '["unread"]',
				visibility: "public",
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}

	async function seedRunningTask(id: string, parentNarratorId: string, kind: "task" | "service") {
		const now = new Date().toISOString();
		db.insert(backgroundTasks)
			.values({
				id,
				parentNarratorId,
				type: "bash",
				backgroundKind: kind,
				status: "running",
				startedAt: now,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		backgroundOccupancyStore.refreshTask(id);
		await settleOccupancy();
	}

	async function seedRunningTransfer(id: string, parentNarratorId: string) {
		const now = new Date().toISOString();
		db.insert(backgroundTasks)
			.values({
				id,
				parentNarratorId,
				type: "transfer",
				status: "running",
				startedAt: now,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		backgroundOccupancyStore.refreshTask(id);
		await settleOccupancy();
	}

	it("flags an idle+unread list snapshot item whose background work is still running", async () => {
		await seedNarrators();
		seedUnreadNarrator("narrator-unread-work");
		await seedRunningTask("snapshot-flag-task", "narrator-unread-work", "task");

		const { ws, sent } = openFakeWs();
		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "list",
			narratorIds: ["narrator-unread-work"],
		});

		expect(sent[0]).toMatchObject({
			type: "list_state_snapshot",
			items: [
				{
					narratorId: "narrator-unread-work",
					status: "idle",
					substatus: ["unread"],
					activeBackgroundWorkCount: 1,
					backgroundWorkActive: true,
				},
			],
		});
	});

	it("does not flag an idle+unread list snapshot item with only a service running", async () => {
		await seedNarrators();
		seedUnreadNarrator("narrator-unread-service");
		await seedRunningTask("snapshot-flag-service", "narrator-unread-service", "service");

		const { ws, sent } = openFakeWs();
		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "list",
			narratorIds: ["narrator-unread-service"],
		});

		const item = (sent[0]?.items as Record<string, unknown>[])[0];
		expect(item).toMatchObject({
			narratorId: "narrator-unread-service",
			status: "idle",
			activeBackgroundServiceCount: 1,
		});
		expect(item).not.toHaveProperty("backgroundWorkActive");
	});

	it("flags the panel status_change snapshot for a done narrator with running work", async () => {
		await seedNarrators();
		seedUnreadNarrator("narrator-unread-panel");
		await seedRunningTask("snapshot-flag-panel-task", "narrator-unread-panel", "task");

		const { ws, sent } = openFakeWs();
		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "panel",
			narratorIds: ["narrator-unread-panel"],
		});

		const statusFrame = sent.find((message) => message.type === "status_change");
		expect(statusFrame).toMatchObject({
			narratorId: "narrator-unread-panel",
			status: "idle",
			substatus: ["unread"],
			backgroundWorkActive: true,
		});
	});

	it("omits the flag on panel snapshots when nothing runs in the background", async () => {
		await seedNarrators();
		seedUnreadNarrator("narrator-unread-quiet");

		const { ws, sent } = openFakeWs();
		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "panel",
			narratorIds: ["narrator-unread-quiet"],
		});

		const statusFrame = sent.find((message) => message.type === "status_change");
		expect(statusFrame).toMatchObject({
			narratorId: "narrator-unread-quiet",
			status: "idle",
			substatus: ["unread"],
		});
		expect(statusFrame).not.toHaveProperty("backgroundWorkActive");
	});

	it("never flags a running transfer — its completion has no wake-up turn to re-raise", async () => {
		await seedNarrators();
		seedUnreadNarrator("narrator-unread-transfer");
		await seedRunningTransfer("snapshot-flag-transfer", "narrator-unread-transfer");

		const { ws, sent } = openFakeWs();
		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "list",
			narratorIds: ["narrator-unread-transfer"],
		});

		const item = (sent[0]?.items as Record<string, unknown>[])[0];
		expect(item).toMatchObject({
			narratorId: "narrator-unread-transfer",
			status: "idle",
			// The badge still shows the transfer as work; only the notification
			// suppression flag must not.
			activeBackgroundWorkCount: 1,
		});
		expect(item).not.toHaveProperty("backgroundWorkActive");
	});

	it("keeps the suppression flag when badge counts go stale during the snapshot read", async () => {
		await seedNarrators();
		seedUnreadNarrator("narrator-unread-stale-counts");
		await seedRunningTask("snapshot-flag-stale", "narrator-unread-stale-counts", "task");

		const realGet = backgroundTaskService.getListVersion.bind(backgroundTaskService);
		const realCount =
			backgroundTaskService.countActiveKindsByParentBatch.bind(backgroundTaskService);
		let bumped = false;
		const versionSpy = spyOn(backgroundTaskService, "getListVersion").mockImplementation(
			(id: string) => {
				const current = realGet(id);
				// versionsAtRead runs before the count flush returns. A bump after that
				// flush is what a count frame published during the read looks like.
				return bumped ? current + 1 : current;
			},
		);
		const countSpy = spyOn(
			backgroundTaskService,
			"countActiveKindsByParentBatch",
		).mockImplementation(async (ids: string[]) => {
			const counts = await realCount(ids);
			bumped = true;
			return counts;
		});
		try {
			const { ws, sent } = openFakeWs();
			await handleNarratorWS.message(ws, {
				type: "subscribe",
				kind: "list",
				narratorIds: ["narrator-unread-stale-counts"],
			});

			const item = (sent[0]?.items as Record<string, unknown>[])[0];
			expect(item).toMatchObject({
				narratorId: "narrator-unread-stale-counts",
				status: "idle",
				substatus: ["unread"],
				backgroundWorkActive: true,
			});
			// Stale badge numbers are omitted so the live count frame wins.
			expect(item).not.toHaveProperty("activeBackgroundWorkCount");
		} finally {
			versionSpy.mockRestore();
			countSpy.mockRestore();
		}
	});
});

describe("narrator WebSocket activity subscription", () => {
	it("sends a snapshot and only the activity projection of the stream", async () => {
		await seedNarrators();
		const { ws, sent } = openFakeWs();

		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "activity",
			narratorIds: ["narrator-idle"],
			requestId: "activity-1",
		});
		expect(sent).toContainEqual({
			type: "activity_snapshot",
			narratorId: "narrator-idle",
			toolCalls: [],
			subscriptionRequestId: "activity-1",
		});

		sent.length = 0;
		broadcastToNarrator("narrator-idle", {
			type: "text",
			narratorId: "narrator-idle",
			text: "streamed prose",
		} as never);
		broadcastToNarrator("narrator-idle", {
			type: "tool_started",
			narratorId: "narrator-idle",
			toolCallId: "call-1",
			toolUseId: "use-1",
			toolName: "Bash",
			input: { command: "bun test", content: "x".repeat(10_000) },
		});
		broadcastToNarrator("narrator-idle", {
			type: "tool_started",
			narratorId: "narrator-idle",
			toolCallId: "call-child",
			toolUseId: "use-child",
			toolName: "Read",
			parentToolUseId: "use-agent",
		});
		broadcastToNarrator("narrator-idle", {
			type: "tool_completed",
			narratorId: "narrator-idle",
			toolCallId: "call-1",
			toolUseId: "use-1",
			toolName: "Bash",
			status: "success",
			output: "y".repeat(10_000),
		});
		expect(sent).toEqual([
			{
				type: "tool_started",
				narratorId: "narrator-idle",
				toolCallId: "call-1",
				toolUseId: "use-1",
				toolName: "Bash",
				inputSummary: { command: "bun test" },
			},
			{
				type: "tool_completed",
				narratorId: "narrator-idle",
				toolCallId: "call-1",
				toolUseId: "use-1",
				toolName: "Bash",
				status: "success",
			},
		]);

		// Any fuller subscription upgrades the narrator back to the complete stream...
		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "list",
			narratorIds: ["narrator-idle"],
		});
		sent.length = 0;
		broadcastToNarrator("narrator-idle", {
			type: "text",
			narratorId: "narrator-idle",
			text: "streamed prose",
		} as never);
		expect(sent.map((message) => message.type)).toEqual(["text"]);

		// ...and a later plain activity frame only re-sends the snapshot.
		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "activity",
			narratorIds: ["narrator-idle"],
		});
		expect(ws.data.activityOnlyNarrators?.has("narrator-idle")).toBe(false);
		expect(sent.at(-1)).toMatchObject({ type: "activity_snapshot", narratorId: "narrator-idle" });

		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "activity",
			narratorIds: ["narrator-idle"],
			downgrade: true,
		});
		expect(ws.data.activityOnlyNarrators?.has("narrator-idle")).toBe(true);
	});
});
