import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import {
	NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
	NARRATOR_WS_SUBSCRIPTION_LIMIT_ERROR_CODE,
} from "../../shared/recent-tabs";
import { cleanDb, getTestDb } from "../../tests/setup";
import { chapters, narratorMessageRefs, narratorMessages, narrators, projects } from "../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../db")) };
mock.module("../db", () => ({ db, sqlite }));

const { broadcastToNarrator, broadcastToUser, getNarratorConnections, handleNarratorWS } =
	await import("./narrator-ws");
const { eventBus } = await import("../lib/event-bus");

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

function seedNarrators() {
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
	db.insert(chapters)
		.values({
			id: "chapter-ws",
			projectId: "project-ws",
			title: "WebSocket Test",
			branch: "chapter/ws-test",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narrators)
		.values([
			{
				id: "narrator-working",
				chapterId: "chapter-ws",
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
				chapterId: "chapter-ws",
				status: "idle",
				substatus: "[]",
				visibility: "public",
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();
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
	it("returns request-scoped sync_ok for a matching version-only empty snapshot", async () => {
		seedNarrators();
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
		seedNarrators();
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
		seedNarrators();
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
		await new Promise((resolve) => setTimeout(resolve, 20));

		const catchUp = sent.find((message) => message.type === "catch_up");
		expect(catchUp).toMatchObject({
			narratorId: "narrator-idle",
			messageVersion: 2,
			subscriptionRequestId: "messages-cursor-stale",
		});
		expect(
			(catchUp?.topLevel as Array<{ id?: string }> | undefined)?.map((message) => message.id),
		).toEqual(["message-2"]);
		expect(sent.some((message) => message.type === "sync_ok")).toBe(false);
	});
});

describe("narrator WebSocket RecentTabs scaling", () => {
	it("sends list initial state as one batch snapshot instead of status_change frames", async () => {
		seedNarrators();
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
		seedNarrators();
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
		seedNarrators();
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
		seedNarrators();
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
		seedNarrators();
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
