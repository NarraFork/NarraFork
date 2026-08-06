import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import {
	NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
	NARRATOR_WS_SUBSCRIPTION_LIMIT_ERROR_CODE,
} from "../../shared/recent-tabs";
import { cleanDb, getTestDb } from "../../tests/setup";
import { chapters, narrators, projects } from "../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../db")) };
mock.module("../db", () => ({ db, sqlite }));

const { broadcastToUser, getNarratorConnections, handleNarratorWS } = await import("./narrator-ws");

type SentMessage = Record<string, unknown>;
type FakeNarratorWS = Parameters<typeof handleNarratorWS.open>[0];

const openedConnections: FakeNarratorWS[] = [];

function createFakeWs(options: { userId?: string; subscribedNarrators?: Set<string> } = {}) {
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
			userId: options.userId,
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

function openFakeWs(options: { userId?: string; subscribedNarrators?: Set<string> } = {}) {
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
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "narrator-idle",
				chapterId: "chapter-ws",
				status: "idle",
				substatus: "[]",
				createdAt: now,
				updatedAt: now,
			},
		])
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
				},
				{
					narratorId: "narrator-working",
					status: "working",
					substatus: ["reasoning"],
					turnStartedAt: "2026-07-19T00:00:00.000Z",
				},
			],
		});
		expect(sent.some((message) => message.type === "status_change")).toBe(false);
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
