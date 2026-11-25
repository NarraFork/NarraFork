/**
 * Public-share WebSocket access control.
 *
 * An anonymous share connection carries no user identity — its grant IS the
 * share record. These pin the three scoping rules:
 *
 *  1. narrator subscribe succeeds only for the share's own narrator (and is
 *     revalidated, so a revoked link cannot subscribe);
 *  2. chat subscribe succeeds only for the share's own discussion room;
 *  3. a revocation closes the open socket immediately;
 *  4. write frames stay refused (the pre-existing `!userId` guard).
 *
 * The fake-ws pattern mirrors narrator-ws-acl.test.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../tests/setup";
import { narratorPublicShares, narrators, users } from "../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../db")) };
mock.module("../db", () => ({ db, sqlite }));
afterAll(() => mock.module("../db", () => realDbModule));

const { eventBus } = await import("../lib/event-bus");
const { generateId } = await import("../lib/id");
const { ensureNarratorDiscussionRoomForShare } = await import("../services/chat-service");
const { revokePublicShare, hashPublicShareToken } = await import(
	"../services/public-narrator-share-service"
);
const {
	handleNarratorWS,
	broadcastToAll,
	broadcastToAdmins,
	broadcastToUser,
	broadcastToNarrator,
	broadcastToChatRoom,
} = await import("./narrator-ws");
const { PublicShareConnectionBudget } = await import(
	"../services/public-narrator-share-connections"
);

type SentMessage = Record<string, unknown>;
type FakeNarratorWS = Parameters<typeof handleNarratorWS.open>[0];

const NOW = "2026-07-19T00:00:00.000Z";
const openedConnections: Array<FakeNarratorWS & { closedWith?: [number, string] }> = [];
let restoreStatusCountReader: (() => void) | undefined;

function openShareWs(publicShare?: {
	shareId: string;
	tokenHash: string;
	narratorId: string;
	roomId: string;
}) {
	const sent: SentMessage[] = [];
	const ws = {
		data: {
			channel: "narrator" as const,
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			subscribedNarrators: new Set<string>(),
			catchingUpNarrators: new Map(),
			catchUpBuffers: new Map(),
			subscribedChatRooms: new Set<string>(),
			...(publicShare ? { publicShare: { ...publicShare, guestName: "访客" } } : {}),
		},
		send(payload: string) {
			sent.push(JSON.parse(payload) as SentMessage);
		},
		close(code: number, reason: string) {
			(ws as { closedWith?: [number, string] }).closedWith = [code, reason];
		},
	} as unknown as FakeNarratorWS & { closedWith?: [number, string] };
	handleNarratorWS.open(ws);
	openedConnections.push(ws);
	return { ws, sent };
}

async function waitForSent(
	sent: SentMessage[],
	predicate: (m: SentMessage) => boolean,
): Promise<boolean> {
	for (let i = 0; i < 50; i++) {
		if (sent.some(predicate)) return true;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return false;
}

async function shareFixture() {
	const owner = generateId();
	const narratorId = generateId();
	await db.insert(users).values({
		id: owner,
		username: `share-ws-${generateId()}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	await db.insert(narrators).values({
		id: narratorId,
		title: "Shared narrator",
		ownerUserId: owner,
		visibility: "private",
		type: "primary",
		createdAt: NOW,
		updatedAt: NOW,
	});
	const shareId = generateId();
	const tokenHash = hashPublicShareToken(generateId(43));
	await db.insert(narratorPublicShares).values({
		id: shareId,
		narratorId,
		tokenHash,
		guestName: "访客",
		createdByUserId: owner,
		createdAt: NOW,
	});
	const roomId = await ensureNarratorDiscussionRoomForShare(narratorId);
	return { owner, narratorId, shareId, tokenHash, roomId };
}

describe("public-share WebSocket scoping", () => {
	beforeEach(async () => {
		cleanDb(sqlite);
	});
	afterEach(async () => {
		restoreStatusCountReader?.();
		restoreStatusCountReader = undefined;
		for (const ws of openedConnections.splice(0)) handleNarratorWS.close(ws);
	});

	it("never receives global, admin, user or unrelated scoped broadcasts", async () => {
		const f = await shareFixture();
		const { ws, sent } = openShareWs(f);
		const regular = openShareWs();
		await handleNarratorWS.message(ws, {
			type: "subscribe",
			narratorIds: [f.narratorId],
			kind: "messages",
		});
		await handleNarratorWS.message(ws, { type: "chat_subscribe", roomIds: [f.roomId] });
		sent.length = 0;
		broadcastToAll({ type: "private-global", secret: "deployment" });
		broadcastToAdmins({ type: "private-admin" });
		broadcastToUser(f.owner, { type: "notification_center:changed" } as never);
		broadcastToNarrator("other", {
			type: "status_change",
			narratorId: "other",
			status: "idle",
		} as never);
		broadcastToChatRoom("other", { type: "chat:message_deleted", roomId: "other" } as never);
		expect(sent).toEqual([]);
		expect(regular.sent.some((message) => message.type === "private-global")).toBe(true);
		broadcastToNarrator(f.narratorId, {
			type: "status_change",
			narratorId: f.narratorId,
			status: "idle",
		} as never);
		broadcastToChatRoom(f.roomId, { type: "chat:message_deleted", roomId: f.roomId } as never);
		expect(sent).toHaveLength(2);
	});

	it("status snapshots and broadcasts keep committed fields private and preserve explicit null", async () => {
		// This projection fixture is in-memory; exact Worker reads are covered by the runtime fixture.
		const counts = await import("../services/narrator-message-count");
		const reader = spyOn(counts, "readNarratorMessageRefCountSnapshot").mockImplementation(
			async (_id, version) => ({ version: version ?? 0, count: 17 }),
		);
		restoreStatusCountReader = () => reader.mockRestore();
		const f = await shareFixture();
		const shared = openShareWs(f);
		const regular = openShareWs();
		regular.ws.data.userId = f.owner;
		const state = {
			status: "idle" as const,
			substatus: "[]",
			turnStartedAt: null,
			updatedAt: NOW,
			messageCount: 17,
			errorMessage: "private upstream details",
			errorRetryable: false,
			archivedWithNarratorId: f.narratorId,
		};
		await db.update(narrators).set(state).where(eq(narrators.id, f.narratorId));
		for (const { ws } of [shared, regular])
			await handleNarratorWS.message(ws, {
				type: "subscribe",
				narratorIds: [f.narratorId],
				kind: "panel",
			});
		const privateState = {
			type: "status_change" as const,
			narratorId: f.narratorId,
			...state,
			substatus: [],
			statusEpoch: "test-epoch",
			statusRevision: 10,
		};
		const publicState = {
			type: "status_change",
			narratorId: f.narratorId,
			status: "idle",
			substatus: [],
			turnStartedAt: null,
			updatedAt: NOW,
			messageCount: 17,
			statusEpoch: "test-epoch",
			statusRevision: 10,
		};
		expect(regular.sent.find((message) => message.type === "status_change")).toEqual({
			...privateState,
			statusEpoch: expect.any(String),
			statusRevision: expect.any(Number),
		});
		expect(shared.sent.find((message) => message.type === "status_change")).toEqual({
			...publicState,
			statusEpoch: expect.any(String),
			statusRevision: expect.any(Number),
		});
		regular.sent.length = 0;
		shared.sent.length = 0;
		broadcastToNarrator(f.narratorId, privateState);
		expect(regular.sent).toEqual([privateState]);
		expect(shared.sent).toEqual([publicState]);
		// Account-only clears remain explicit instead of becoming missing fields.
		broadcastToNarrator(f.narratorId, {
			...privateState,
			errorMessage: null,
			errorRetryable: null,
			archivedWithNarratorId: null,
		});
		expect(regular.sent.at(-1)).toMatchObject({
			errorMessage: null,
			errorRetryable: null,
			archivedWithNarratorId: null,
		});
		expect(shared.sent.at(-1)).toEqual(publicState);
		const substatus = { ...privateState, type: "substatus_change" as const };
		broadcastToNarrator(f.narratorId, substatus);
		expect(regular.sent.at(-1)).toEqual(substatus);
		expect(shared.sent.at(-1)).toEqual({ ...publicState, type: "substatus_change" });
	});

	it("public message broadcasts strip replay metadata while private subscribers keep it", async () => {
		const f = await shareFixture();
		const shared = openShareWs(f);
		const regular = openShareWs();
		regular.ws.data.userId = f.owner;
		for (const { ws } of [shared, regular]) {
			await handleNarratorWS.message(ws, {
				type: "subscribe",
				narratorIds: [f.narratorId],
				kind: "messages",
			});
		}
		const messageId = generateId();
		for (const [type, text, encrypted] of [
			["message", "Public initial reasoning", false],
			["message_updated", "Public updated reasoning", true],
			["message_updated", "Public replacement reasoning", false],
		] as const) {
			const providerMetadata = {
				openai: {
					itemId: "private-reasoning-id",
					reasoningContent: [{ type: "reasoning_text", text: "private-native-body" }],
					reasoningSummary: [{ type: "summary_text", text: "private-native-summary" }],
					...(encrypted ? { reasoningEncryptedContent: "private-ciphertext" } : {}),
				},
				anthropic: { signature: "private-anthropic-signature" },
				gemini: { thoughtSignature: "private-gemini-signature" },
				opaque: { payload: "private-opaque-replay" },
			};
			const event = {
				type,
				narratorId: f.narratorId,
				message: {
					id: messageId,
					narratorId: f.narratorId,
					role: "assistant",
					contentJson: [{ type: "reasoning", text, providerMetadata }],
				},
			};
			const original = structuredClone(event);
			shared.sent.length = 0;
			regular.sent.length = 0;
			broadcastToNarrator(f.narratorId, event);
			const publicFrame = shared.sent.find((frame) => frame.type === "message_upserted");
			const privateFrame = regular.sent.find((frame) => frame.type === "message_upserted");
			expect(publicFrame?.cause).toBe(type);
			expect(privateFrame?.cause).toBe(type);
			const publicBlocks = publicFrame?.blocks as Array<{ elements: unknown[] }>;
			const privateBlocks = privateFrame?.blocks as Array<{ elements: unknown[] }>;
			expect(publicBlocks.flatMap((block) => block.elements)).toEqual([
				{
					type: "reasoning",
					text,
					...(encrypted ? { providerMetadata: { hasEncryptedReasoning: true } } : {}),
				},
			]);
			expect(JSON.stringify(publicFrame)).not.toContain("private-");
			expect(privateBlocks.flatMap((block) => block.elements)).toEqual(event.message.contentJson);
			expect(event).toEqual(original);
		}
	});

	it("lifecycle invalidation sends only a marker and never reaches anonymous shares", async () => {
		const shared = openShareWs(await shareFixture());
		const regular = openShareWs();
		shared.sent.length = 0;
		regular.sent.length = 0;
		eventBus.emit({ type: "system:lifecycle_changed" });
		expect(shared.sent).toEqual([]);
		expect(regular.sent).toEqual([{ type: "system_lifecycle_changed" }]);
		regular.sent.length = 0;
		eventBus.emit({ type: "system:unattended_changed" });
		expect(shared.sent).toEqual([]);
		expect(regular.sent).toEqual([{ type: "unattended_mode_changed" }]);
	});

	it("device lifecycle invalidation is data-free and never reaches anonymous shares", async () => {
		const shared = openShareWs(await shareFixture());
		const regular = openShareWs();
		shared.sent.length = 0;
		regular.sent.length = 0;
		eventBus.emit({ type: "device:changed", deviceId: "private-device" });
		eventBus.emit({ type: "device:status", deviceId: "private-device", status: "offline" });
		await new Promise((resolve) => setTimeout(resolve, 130));
		expect(shared.sent).toEqual([]);
		expect(regular.sent).toEqual([{ type: "execution_devices_changed" }]);
	});

	it("refuses stats and unrelated workspace subscriptions", async () => {
		const { ws } = openShareWs(await shareFixture());
		await handleNarratorWS.message(ws, { type: "subscribe_stats" });
		expect(ws.data.subscribedStats).not.toBe(true);
	});

	it("releases the upgrade lease on socket close without double decrement", async () => {
		const f = await shareFixture();
		const budget = new PublicShareConnectionBudget();
		const { ws } = openShareWs(f);
		ws.data.publicShareConnectionLease = budget.reserve(f.shareId, "ip") ?? undefined;
		handleNarratorWS.open(ws);
		expect(budget.stats.connections).toBe(1);
		handleNarratorWS.close(ws);
		handleNarratorWS.close(ws);
		expect(budget.stats).toEqual({ connections: 0, shares: 0, ips: 0 });
	});

	it("closes a failed sender and releases its lease and room index", async () => {
		const f = await shareFixture();
		const budget = new PublicShareConnectionBudget();
		const { ws } = openShareWs(f);
		ws.data.publicShareConnectionLease = budget.reserve(f.shareId, "ip") ?? undefined;
		handleNarratorWS.open(ws);
		await handleNarratorWS.message(ws, { type: "chat_subscribe", roomIds: [f.roomId] });
		ws.send = (() => {
			throw new Error("socket closed");
		}) as typeof ws.send;
		broadcastToChatRoom(f.roomId, { type: "chat:message_deleted", roomId: f.roomId } as never);
		expect(budget.stats.connections).toBe(0);
		expect(ws.data.subscribedChatRooms.size).toBe(0);
		expect(ws.closedWith?.[0]).toBe(1001);
	});

	it("subscribes the share's own narrator and denies any other", async () => {
		const f = await shareFixture();
		const { ws, sent } = openShareWs(f);
		await handleNarratorWS.message(ws, {
			type: "subscribe",
			narratorIds: [f.narratorId, "someone-elses-narrator"],
			kind: "messages",
			requestId: "r1",
		});
		expect(
			await waitForSent(
				sent,
				(m) => m.type === "subscribe_denied" && m.narratorId === "someone-elses-narrator",
			),
		).toBe(true);
		expect(ws.data.subscribedNarrators.has(f.narratorId)).toBe(true);
		expect(ws.data.subscribedNarrators.has("someone-elses-narrator")).toBe(false);
	});

	it("rejects every narrator subscribe when the share was revoked", async () => {
		const f = await shareFixture();
		await db
			.update(narratorPublicShares)
			.set({ revokedAt: new Date().toISOString() })
			.where(eq(narratorPublicShares.id, f.shareId));
		// Revalidation is synchronous against the revoked row.
		const { ws, sent } = openShareWs({
			shareId: f.shareId,
			tokenHash: f.tokenHash,
			narratorId: f.narratorId,
			roomId: f.roomId,
		});
		await handleNarratorWS.message(ws, {
			type: "subscribe",
			narratorIds: [f.narratorId],
			kind: "messages",
		});
		expect(
			await waitForSent(
				sent,
				(m) => m.type === "subscribe_denied" && m.narratorId === f.narratorId,
			),
		).toBe(true);
		expect(ws.data.subscribedNarrators.size).toBe(0);
	});

	it("subscribes only the share's own discussion room", async () => {
		const f = await shareFixture();
		const { ws } = openShareWs(f);
		await handleNarratorWS.message(ws, {
			type: "chat_subscribe",
			roomIds: [f.roomId, "other-room"],
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ws.data.subscribedChatRooms.has(f.roomId)).toBe(true);
		expect(ws.data.subscribedChatRooms.has("other-room")).toBe(false);
	});

	it("refuses write frames (buffer_message) on a share connection", async () => {
		const f = await shareFixture();
		const { ws, sent } = openShareWs(f);
		// Subscribe first so the connection is fully established.
		await handleNarratorWS.message(ws, {
			type: "subscribe",
			narratorIds: [f.narratorId],
			kind: "messages",
		});
		await handleNarratorWS.message(ws, {
			type: "buffer_message",
			narratorId: f.narratorId,
			text: "inject this",
		});
		// The write guard (`!userId`) drops the frame silently — no error frame, no
		// state change. The observable contract is that NOTHING comes back.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(sent.filter((m) => m.type === "error" || m.type === "buffer_update")).toEqual([]);
	});

	it("closes the open socket when the share is revoked", async () => {
		const f = await shareFixture();
		const { ws } = openShareWs(f);
		// revokePublicShare(narratorId, shareId, principal) fires the post-commit
		// listener synchronously.
		await revokePublicShare(f.narratorId, f.shareId, { userId: f.owner, isAdmin: true });
		expect(ws.closedWith?.[0]).toBe(4001);
	});
});
