/**
 * notification-fanout tests — WHO gets a notification-center row, and that
 * recordNotifications is never the thing that decides persistence policy.
 *
 * B (notification-center-service) may not exist yet; every case injects a
 * recording writer via `setRecordNotifications` and asserts the INPUTS. The
 * mock also simulates B's unique `(userId, kind, sourceKey)` constraint so
 * "重复 sourceKey 不双插" is observable without the real table.
 *
 * Run: bun test --isolate server/services/__tests__/notification-fanout.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
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
import { postMessage, resolveDmRoom, softDeleteMessage } from "../chat-service";
import {
	fanoutChatMessageNotifications,
	fanoutPermissionRequestNotifications,
	type RecordNotificationInput,
	setRecordNotifications,
} from "../notification-fanout";

/** In-memory stand-in for B: unique (userId, kind, sourceKey). */
function installRecordingWriter(): {
	rows: RecordNotificationInput[];
	calls: RecordNotificationInput[][];
} {
	const rows: RecordNotificationInput[] = [];
	const calls: RecordNotificationInput[][] = [];
	const seen = new Set<string>();
	setRecordNotifications(async (inputs) => {
		calls.push(inputs);
		for (const input of inputs) {
			const key = `${input.userId}|${input.kind}|${input.sourceKey}`;
			if (seen.has(key)) continue;
			seen.add(key);
			rows.push(input);
		}
	});
	return { rows, calls };
}

async function makeUser(label: string, role: "user" | "admin" = "user"): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `fanout-${label}-${generateId(6)}`,
		passwordHash: "x",
		role,
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

async function seedNarrator(opts: {
	id: string;
	ownerUserId: string | null;
	visibility: "private" | "public" | "project";
	title?: string;
}): Promise<void> {
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: opts.id,
		title: opts.title ?? `Narrator ${opts.id}`,
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
	status?: "pending" | "initializing" | "success" | "fail";
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

afterEach(() => {
	setRecordNotifications(null);
});

describe("DM chat_message fan-out", () => {
	test("sender does not receive; non-muted unread peer does", async () => {
		const recorder = installRecordingWriter();
		const sender = await makeUser("dm-sender");
		const peer = await makeUser("dm-peer");
		const room = await resolveDmRoom(sender, peer);
		const posted = await postMessage({
			roomId: room.id,
			senderUserId: sender,
			text: "hello notification",
		});

		await fanoutChatMessageNotifications({
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
			roomKind: "dm",
		});

		expect(recorder.rows).toHaveLength(1);
		expect(recorder.rows[0].userId).toBe(peer);
		expect(recorder.rows[0].kind).toBe("chat_message");
		expect(recorder.rows[0].sourceKey).toBe(posted.id);
		expect(recorder.rows[0].link).toEqual({ type: "chat_room", roomId: room.id });
		expect(recorder.rows[0].preview).toContain("hello notification");
	});

	test("muted member is not notified", async () => {
		const recorder = installRecordingWriter();
		const sender = await makeUser("mute-sender");
		const peer = await makeUser("mute-peer");
		const room = await resolveDmRoom(sender, peer);
		await setMemberFlag(room.id, peer, { muted: true });
		const posted = await postMessage({
			roomId: room.id,
			senderUserId: sender,
			text: "should not reach muted",
		});

		await fanoutChatMessageNotifications({
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
		});

		expect(recorder.rows).toHaveLength(0);
	});

	test("non-member receives nothing", async () => {
		const recorder = installRecordingWriter();
		const sender = await makeUser("nm-sender");
		const peer = await makeUser("nm-peer");
		const outsider = await makeUser("nm-outsider");
		const room = await resolveDmRoom(sender, peer);
		const posted = await postMessage({
			roomId: room.id,
			senderUserId: sender,
			text: "members only",
		});

		await fanoutChatMessageNotifications({
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
		});

		const userIds = recorder.rows.map((row) => row.userId);
		expect(userIds).toContain(peer);
		expect(userIds).not.toContain(outsider);
		expect(userIds).not.toContain(sender);
	});

	test("already-read watermark produces no row", async () => {
		const recorder = installRecordingWriter();
		const sender = await makeUser("read-sender");
		const peer = await makeUser("read-peer");
		const room = await resolveDmRoom(sender, peer);
		const second = await postMessage({
			roomId: room.id,
			senderUserId: sender,
			text: "two",
		});
		await setMemberFlag(room.id, peer, { lastReadSeq: second.seq });

		await fanoutChatMessageNotifications({
			roomId: room.id,
			messageId: second.id,
			seq: second.seq,
			senderUserId: sender,
		});

		expect(recorder.rows).toHaveLength(0);
	});

	test("soft-deleted body is not projected", async () => {
		const recorder = installRecordingWriter();
		const sender = await makeUser("del-sender");
		const peer = await makeUser("del-peer");
		const room = await resolveDmRoom(sender, peer);
		const posted = await postMessage({
			roomId: room.id,
			senderUserId: sender,
			text: "oops",
		});
		await softDeleteMessage(room.id, posted.id, sender, false);

		await fanoutChatMessageNotifications({
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
		});

		expect(recorder.rows).toHaveLength(0);
	});

	test("preview is truncated to the shared max length", async () => {
		const recorder = installRecordingWriter();
		const sender = await makeUser("trunc-sender");
		const peer = await makeUser("trunc-peer");
		const room = await resolveDmRoom(sender, peer);
		const long = "x".repeat(400);
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

		expect(recorder.rows).toHaveLength(1);
		expect(recorder.rows[0].preview.length).toBeLessThanOrEqual(121);
		expect(recorder.rows[0].preview.endsWith("…")).toBe(true);
	});

	test("replaying the same message does not double-insert (sourceKey unique)", async () => {
		const recorder = installRecordingWriter();
		const sender = await makeUser("dup-sender");
		const peer = await makeUser("dup-peer");
		const room = await resolveDmRoom(sender, peer);
		const posted = await postMessage({
			roomId: room.id,
			senderUserId: sender,
			text: "dup",
		});

		const event = {
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
		};
		await fanoutChatMessageNotifications(event);
		await fanoutChatMessageNotifications(event);

		expect(recorder.rows).toHaveLength(1);
		expect(recorder.rows[0].sourceKey).toBe(posted.id);
	});
});

describe("permission_request fan-out", () => {
	test("only users who can read the narrator receive the offer", async () => {
		const recorder = installRecordingWriter();
		const owner = await makeUser("perm-owner");
		const stranger = await makeUser("perm-stranger");
		const narratorId = generateId();
		await seedNarrator({ id: narratorId, ownerUserId: owner, visibility: "private" });
		const toolCallId = generateId();
		await seedPendingToolCall({ id: toolCallId, narratorId });

		await fanoutPermissionRequestNotifications({ narratorId, requestId: toolCallId });

		const userIds = recorder.rows.map((row) => row.userId);
		expect(userIds).toContain(owner);
		expect(userIds).not.toContain(stranger);
		expect(recorder.rows[0].kind).toBe("permission_request");
		expect(recorder.rows[0].sourceKey).toBe(toolCallId);
		expect(recorder.rows[0].link).toEqual({ type: "narrator", narratorId });
	});

	test("preview is toolName + path hint, never full tool input", async () => {
		const recorder = installRecordingWriter();
		const owner = await makeUser("preview-owner");
		const narratorId = generateId();
		await seedNarrator({ id: narratorId, ownerUserId: owner, visibility: "private" });
		const toolCallId = generateId();
		await seedPendingToolCall({
			id: toolCallId,
			narratorId,
			toolName: "Write",
			path: "/worktree/src/secret-plan.ts",
		});

		await fanoutPermissionRequestNotifications({ narratorId, requestId: toolCallId });

		expect(recorder.rows).toHaveLength(1);
		expect(recorder.rows[0].preview).toContain("Write");
		expect(recorder.rows[0].preview).toContain("secret-plan.ts");
		expect(recorder.rows[0].preview).not.toContain("inputJson");
	});

	test("decided tool calls are not re-notified", async () => {
		const recorder = installRecordingWriter();
		const owner = await makeUser("decided-owner");
		const narratorId = generateId();
		await seedNarrator({ id: narratorId, ownerUserId: owner, visibility: "private" });
		const toolCallId = generateId();
		await seedPendingToolCall({
			id: toolCallId,
			narratorId,
			status: "success",
			decidedAt: new Date().toISOString(),
		});

		await fanoutPermissionRequestNotifications({ narratorId, requestId: toolCallId });
		expect(recorder.rows).toHaveLength(0);
	});

	test("repeat offers with the same toolCallId do not double-insert", async () => {
		const recorder = installRecordingWriter();
		const owner = await makeUser("reoffer-owner");
		const narratorId = generateId();
		await seedNarrator({ id: narratorId, ownerUserId: owner, visibility: "private" });
		const toolCallId = generateId();
		await seedPendingToolCall({ id: toolCallId, narratorId });

		await fanoutPermissionRequestNotifications({ narratorId, requestId: toolCallId });
		await fanoutPermissionRequestNotifications({ narratorId, requestId: toolCallId });

		expect(recorder.rows).toHaveLength(1);
		expect(recorder.rows[0].sourceKey).toBe(toolCallId);
		// Two delivery attempts, one durable row — unique(sourceKey) wins.
		expect(recorder.calls).toHaveLength(2);
	});

	test("record failure does not throw back to the permission path", async () => {
		setRecordNotifications(async () => {
			throw new Error("db down");
		});
		const owner = await makeUser("fail-owner");
		const narratorId = generateId();
		await seedNarrator({ id: narratorId, ownerUserId: owner, visibility: "private" });
		const toolCallId = generateId();
		await seedPendingToolCall({ id: toolCallId, narratorId });

		await expect(
			fanoutPermissionRequestNotifications({ narratorId, requestId: toolCallId }),
		).resolves.toBeUndefined();
	});
});
