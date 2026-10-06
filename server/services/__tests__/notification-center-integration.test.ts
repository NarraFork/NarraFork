/**
 * Notification center integration — DM fan-out → real recordNotifications →
 * listNotifications for the peer (task package F / C leftover).
 *
 * Unlike notification-fanout.test.ts (which injects a recording writer), this
 * file keeps production resolution: `setRecordNotifications(null)` so fan-out
 * calls B's real `recordNotifications`.
 *
 * DB path: tests/preload.ts points NARRAFORK_HOME at a temp directory and runs
 * the full Drizzle migration set (including 0181 notifications). Never touches
 * production `~/.narrafork/narrafork.db`.
 *
 * Run: bun test --isolate server/services/__tests__/notification-center-integration.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
	chatRoomMembers,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { postMessage, resolveDmRoom } from "../chat-service";
import {
	ensureNotificationsTableForTests,
	getUnreadCounts,
	listNotifications,
	markNotificationsRead,
	NOTIFICATION_PREVIEW_MAX_LENGTH,
	onNotificationCenterChanged,
	recordNotifications,
} from "../notification-center-service";
import {
	fanoutChatMessageNotifications,
	fanoutPermissionRequestNotifications,
	setRecordNotifications,
} from "../notification-fanout";

// Same handle as production modules (preload temp home).
const { db: rawDb } = await import("../../db");
const sqlite = (rawDb as { $client?: { run(sql: string): unknown } }).$client;

async function makeUser(label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${id.slice(0, 6)}`,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return id;
}

async function setMemberFlag(
	roomId: string,
	userId: string,
	patch: { muted?: boolean; lastReadSeq?: number },
): Promise<void> {
	const all = await db.select().from(chatRoomMembers);
	const target = all.find((row) => row.roomId === roomId && row.userId === userId);
	if (!target) throw new Error("membership not found");
	await db.update(chatRoomMembers).set(patch).where(eq(chatRoomMembers.id, target.id));
}

beforeEach(async () => {
	// Production path: fan-out must call B's real recordNotifications.
	setRecordNotifications(null);
	if (sqlite) {
		try {
			ensureNotificationsTableForTests(sqlite);
		} catch {
			// Migration 0181 may already have created the table.
		}
	}
});

afterEach(() => {
	setRecordNotifications(null);
});

afterAll(() => {
	setRecordNotifications(null);
});

describe("DM fan-out → recordNotifications → listNotifications (real service)", () => {
	test("peer sees the projected row; sender is excluded; sourceKey dedupes", async () => {
		const sender = await makeUser("int-sender");
		const peer = await makeUser("int-peer");
		const room = await resolveDmRoom(sender, peer);

		const posted = await postMessage({
			roomId: room.id,
			senderUserId: sender,
			text: "integration hello body",
		});

		const event = {
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
			roomKind: "dm" as const,
		};

		await fanoutChatMessageNotifications(event);
		// Replay must not create a second row (unique userId+kind+sourceKey).
		await fanoutChatMessageNotifications(event);

		const peerPage = await listNotifications({ userId: peer, status: "all" });
		expect(peerPage.items).toHaveLength(1);
		const row = peerPage.items[0];
		expect(row.kind).toBe("chat_message");
		expect(row.sourceKey).toBe(posted.id);
		expect(row.link).toEqual({ type: "chat_room", roomId: room.id });
		expect(row.preview).toContain("integration hello body");
		expect(row.readAt).toBeNull();
		expect(row.title.length).toBeGreaterThan(0);

		const senderPage = await listNotifications({ userId: sender, status: "all" });
		expect(senderPage.items).toHaveLength(0);

		const counts = await getUnreadCounts(peer);
		expect(counts.unreadConversations).toBe(1);
		expect(counts.unreadActivities).toBeGreaterThanOrEqual(1);
	});

	test("long preview is truncated at write time to the shared max", async () => {
		const sender = await makeUser("int-trunc-sender");
		const peer = await makeUser("int-trunc-peer");
		const room = await resolveDmRoom(sender, peer);
		const long = "z".repeat(400);
		const posted = await postMessage({
			roomId: room.id,
			senderUserId: sender,
			text: long,
		});

		await fanoutChatMessageNotifications({
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
		});

		const page = await listNotifications({ userId: peer, status: "all" });
		expect(page.items).toHaveLength(1);
		// Write-time clamp is ≤ shared max and keeps a visible ellipsis when truncated.
		expect(page.items[0].preview.length).toBeLessThanOrEqual(NOTIFICATION_PREVIEW_MAX_LENGTH);
		expect(page.items[0].preview.endsWith("…")).toBe(true);
		expect(page.items[0].preview.length).toBeLessThan(long.length);
		expect(page.items[0].preview).not.toBe(long);
	});

	test("muted peer gets no projected row even through the real writer", async () => {
		const sender = await makeUser("int-mute-sender");
		const peer = await makeUser("int-mute-peer");
		const room = await resolveDmRoom(sender, peer);
		await setMemberFlag(room.id, peer, { muted: true });

		const posted = await postMessage({
			roomId: room.id,
			senderUserId: sender,
			text: "muted should not see this",
		});
		await fanoutChatMessageNotifications({
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
		});

		const page = await listNotifications({ userId: peer, status: "all" });
		expect(page.items).toHaveLength(0);
	});

	test("markRead after integration write only moves the peer and fires change hook", async () => {
		const sender = await makeUser("int-read-sender");
		const peer = await makeUser("int-read-peer");
		const outsider = await makeUser("int-read-outsider");
		const room = await resolveDmRoom(sender, peer);

		const posted = await postMessage({
			roomId: room.id,
			senderUserId: sender,
			text: "mark me",
		});
		await fanoutChatMessageNotifications({
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
		});

		// Unrelated unread for outsider — must survive peer markRead.
		await recordNotifications([
			{
				userId: outsider,
				kind: "chat_message",
				sourceKey: `other-${posted.id}`,
				title: "other",
				preview: "other",
				link: { type: "chat_room", roomId: "room-x" },
			},
		]);

		const events: Array<{ userId: string; kinds?: string[] }> = [];
		const off = onNotificationCenterChanged((e) => events.push(e));
		const result = await markNotificationsRead({ userId: peer, scope: "all", before: Date.now() });
		off();

		expect(result.updated).toBe(1);
		expect(events.some((e) => e.userId === peer)).toBe(true);

		const peerPage = await listNotifications({ userId: peer, status: "all" });
		expect(peerPage.items[0].sourceState).toBe("active");
		expect(peerPage.items[0].readAt).not.toBeNull();

		const outsiderPage = await listNotifications({ userId: outsider, status: "all" });
		expect(outsiderPage.items[0].readAt).toBeNull();
	});
});

describe("permission fan-out → recordNotifications → listNotifications (real service)", () => {
	async function seedNarrator(opts: {
		id: string;
		ownerUserId: string | null;
		visibility: "private" | "public" | "project";
		title?: string;
	}): Promise<void> {
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: opts.id,
			title: opts.title ?? `Narrator ${opts.id.slice(0, 6)}`,
			ownerUserId: opts.ownerUserId,
			visibility: opts.visibility,
			writeAudience: "owner",
			type: "primary",
			aclRootNarratorId: null,
			createdAt: now,
			updatedAt: now,
		});
	}

	async function seedPendingToolCall(opts: {
		id: string;
		narratorId: string;
		toolName?: string;
		path?: string | null;
		status?: "pending" | "success";
		decidedAt?: string | null;
	}): Promise<void> {
		const now = new Date().toISOString();
		const messageId = generateId();
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId: opts.narratorId,
			role: "assistant",
			contentJson: [{ type: "text", text: "asking" }],
			createdAt: now,
		});
		await db.insert(narratorToolCalls).values({
			id: opts.id,
			narratorId: opts.narratorId,
			messageId,
			toolUseId: generateId(12),
			toolName: opts.toolName ?? "Bash",
			status: opts.status ?? "pending",
			canonicalFilePath: opts.path ?? null,
			permissionDecidedAt: opts.decidedAt ?? null,
			createdAt: now,
		});
	}

	test("owner sees durable row; stranger does not; replay dedupes; decided skips", async () => {
		const owner = await makeUser("int-perm-owner");
		const stranger = await makeUser("int-perm-stranger");
		const narratorId = generateId();
		await seedNarrator({ id: narratorId, ownerUserId: owner, visibility: "private" });
		const toolCallId = generateId();
		await seedPendingToolCall({
			id: toolCallId,
			narratorId,
			toolName: "Write",
			path: "/repo/src/feature.ts",
		});

		const event = { narratorId, requestId: toolCallId };
		await fanoutPermissionRequestNotifications(event);
		await fanoutPermissionRequestNotifications(event);

		const ownerPage = await listNotifications({ userId: owner, status: "all" });
		expect(ownerPage.items).toHaveLength(1);
		const row = ownerPage.items[0];
		expect(row.kind).toBe("permission_request");
		expect(row.sourceKey).toBe(toolCallId);
		expect(row.link).toEqual({ type: "narrator", narratorId });
		expect(row.preview).toContain("Write");
		expect(row.preview).toContain("feature.ts");
		expect(row.readAt).toBeNull();
		expect(row.sourceState).toBe("active");

		const strangerPage = await listNotifications({ userId: stranger, status: "all" });
		expect(strangerPage.items).toHaveLength(0);

		// Decided offer must not resurrect or re-project through the real writer.
		await db
			.update(narratorToolCalls)
			.set({ status: "success", permissionDecidedAt: new Date().toISOString() })
			.where(eq(narratorToolCalls.id, toolCallId));
		await fanoutPermissionRequestNotifications(event);
		const after = await listNotifications({ userId: owner, status: "all" });
		expect(after.items).toHaveLength(1);

		// List derivation: decided tool → resolved but still navigable (M1).
		const derived = after.items[0];
		expect(derived.sourceState).toBe("resolved");
		expect(derived.link.type).toBe("narrator");

		const counts = await getUnreadCounts(owner);
		expect(counts.unreadActivities).toBe(1);
		expect(counts.unreadConversations).toBe(0);
	});
});
