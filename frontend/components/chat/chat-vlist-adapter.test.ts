/**
 * chat-vlist-adapter.test.ts — ChatMessage → TreeMessage projection.
 *
 * The projection is the ONLY place chat semantics (grouping, reply states,
 * tombstone, attachment endpoints) meet the shared document shape. These pin it
 * so PretextExactMessageList renders exactly what the room API delivered.
 */

import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "../../lib/api/chat";
import {
	type ChatTreeProjectionLabels,
	projectChatDeletion,
	projectChatLiveMessage,
	projectChatMessagesToTree,
} from "./chat-vlist-adapter";

const LABELS: ChatTreeProjectionLabels = {
	messageDeleted: "该消息已删除",
	replyToDeleted: "回复的消息已删除",
	replyUnavailable: "回复的消息不在当前加载范围",
	guestMarker: "访客",
};

let seqCounter = 0;
function msg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
	return {
		roomId: "room-1",
		seq: ++seqCounter,
		kind: "text",
		contentText: `text of ${overrides.id}`,
		replyToMessageId: null,
		replyToSeq: null,
		replyToSender: null,
		replyToPreview: null,
		attachments: [],
		editedAt: null,
		deletedAt: null,
		createdAt: `2026-04-02T10:${String(seqCounter % 60).padStart(2, "0")}:00Z`,
		sender: { id: "user-1", username: "alice", avatarColor: null, avatarImageId: null },
		...overrides,
	};
}

describe("projectChatMessagesToTree", () => {
	it("live-row projection needs only predecessor and quote target, preserving full-window results", () => {
		const messages = [
			msg({ id: "target", seq: 1 }),
			msg({ id: "middle", seq: 20 }),
			msg({ id: "previous", seq: 40 }),
			msg({ id: "grouped", seq: 41 }),
			msg({ id: "reply", seq: 42, replyToMessageId: "target" }),
		];
		const loaded = new Map([...messages].reverse().map((message) => [message.id, message]));
		const full = projectChatMessagesToTree(messages, LABELS);
		for (const message of messages) {
			expect(projectChatLiveMessage(message, loaded, LABELS)).toEqual(
				full.find((row) => row.id === message.id),
			);
		}
	});
	it("explicitly opts chat bodies into Markdown without changing the user role", () => {
		const [row] = projectChatMessagesToTree(
			[msg({ id: "markdown", contentText: "**bold** [link](https://example.com)" })],
			LABELS,
		);
		expect(row?.bodyFormat).toBe("markdown");
		expect(row?.role).toBe("user");
	});

	it("upserts historical tombstones and legacy quotes in place, preserving seq and snapshots", () => {
		const target = msg({
			id: "old",
			seq: 1,
			attachments: [
				{
					id: "a",
					kind: "file",
					filename: "secret.txt",
					mediaType: "text/plain",
					sizeBytes: 10,
					width: null,
					height: null,
				},
			],
		});
		const legacy = msg({ id: "legacy", seq: 2, replyToMessageId: "old" });
		const snapshot = msg({
			id: "snapshot",
			seq: 3,
			replyToMessageId: "old",
			replyToPreview: "post-time quote",
		});
		const tail = msg({ id: "tail", seq: 90 });
		const result = projectChatDeletion(
			[target, legacy, snapshot, tail],
			"old",
			"2026-04-02T12:00:00Z",
			LABELS,
		);
		expect(result.messages.map((m) => [m.id, m.seq])).toEqual([
			["old", 1],
			["legacy", 2],
			["snapshot", 3],
			["tail", 90],
		]);
		expect(result.messages[0]?.contentText).toBe("");
		expect(result.messages[0]?.attachments).toEqual([]);
		expect(result.upserts.map((m) => m.id)).toEqual(["old", "legacy"]);
		expect(result.upserts[0]?.deletedLabel).toBe(LABELS.messageDeleted);
		expect(result.upserts[1]?.replyQuote?.state).toBe("deleted");
		expect(result.messages[2]?.replyToPreview).toBe("post-time quote");
		expect(target.contentText).not.toBe("");
		// The useChat cache subscriber can run first. Applying again is idempotent.
		expect(projectChatDeletion(result.messages, "old", "later", LABELS)).toEqual(result);
	});

	it("ignores unknown ids without emitting an unrelated first-row update", () => {
		const result = projectChatDeletion([msg({ id: "tail" })], "outside", "now", LABELS);
		expect(result.upserts).toEqual([]);
	});
	it("projects one user-role TreeMessage per chat message, keyed by id and seq", () => {
		const tree = projectChatMessagesToTree([msg({ id: "m1" }), msg({ id: "m2" })], LABELS);
		expect(tree.map((m) => [m.id, m.role, m.seq])).toEqual([
			["m1", "user", tree[0]?.seq],
			["m2", "user", tree[1]?.seq],
		]);
		expect(tree[0]?.contentJson).toEqual([{ type: "text", text: "text of m1" }]);
	});

	it("omits the header on a grouped follow-up (same author, inside the window)", () => {
		const base = Date.parse("2026-04-02T10:00:00Z");
		const tree = projectChatMessagesToTree(
			[
				msg({ id: "m1", createdAt: new Date(base).toISOString() }),
				msg({ id: "m2", createdAt: new Date(base + 60_000).toISOString() }),
				msg({
					id: "m3",
					createdAt: new Date(base + 120_000).toISOString(),
					sender: { id: "user-2", username: "bob", avatarColor: null, avatarImageId: null },
				}),
			],
			LABELS,
		);
		expect(tree.map((m) => m.omitHeader === true)).toEqual([false, true, false]);
	});

	it("maps a quoted reply onto the quote strip with jump coordinates", () => {
		const tree = projectChatMessagesToTree(
			[
				msg({
					id: "m1",
					replyToMessageId: "m0",
					replyToSeq: 41,
					replyToSender: { id: "user-2", username: "bob", avatarColor: null, avatarImageId: null },
					replyToPreview: "被引用的原文",
				}),
			],
			LABELS,
		);
		expect(tree[0]?.replyQuote).toEqual({
			authorName: "bob",
			text: "被引用的原文",
			state: "quoted",
			targetId: "m0",
			targetSeq: 41,
		});
	});

	it("distinguishes deleted and unavailable reply targets in the strip label", () => {
		const tree = projectChatMessagesToTree(
			[
				msg({ id: "m1", replyToMessageId: "x", replyToPreview: "" }),
				msg({ id: "m2", replyToMessageId: "y", replyToPreview: null, replyToSeq: null }),
			],
			LABELS,
		);
		expect(tree[0]?.replyQuote?.state).toBe("deleted");
		expect(tree[0]?.replyQuote?.text).toBe(LABELS.replyToDeleted);
		expect(tree[1]?.replyQuote?.state).toBe("unavailable");
		expect(tree[1]?.replyQuote?.text).toBe(LABELS.replyUnavailable);
	});

	it("collapses a soft-deleted message to the tombstone form (no text, no attachments)", () => {
		const tree = projectChatMessagesToTree(
			[
				msg({
					id: "m1",
					deletedAt: "2026-04-02T11:00:00Z",
					attachments: [
						{
							id: "a1",
							kind: "image",
							filename: "shot.png",
							mediaType: "image/png",
							sizeBytes: 100,
							width: 10,
							height: 10,
						},
					],
				}),
			],
			LABELS,
		);
		expect(tree[0]?.deletedLabel).toBe(LABELS.messageDeleted);
		expect(tree[0]?.contentJson).toEqual([{ type: "text", text: "" }]);
	});

	it("carries editedAt so an in-place edit re-keys the measure cache", () => {
		const tree = projectChatMessagesToTree(
			[msg({ id: "m1", editedAt: "2026-04-02T12:00:00Z" })],
			LABELS,
		);
		expect(tree[0]?.editedAt).toBe("2026-04-02T12:00:00Z");
	});

	it("projects attachments as fetchUrl-bearing blocks above the body", () => {
		const tree = projectChatMessagesToTree(
			[
				msg({
					id: "m1",
					attachments: [
						{
							id: "a1",
							kind: "image",
							filename: "shot.png",
							mediaType: "image/png",
							sizeBytes: 2048,
							width: 640,
							height: 480,
						},
						{
							id: "a2",
							kind: "file",
							filename: "notes.txt",
							mediaType: "text/plain",
							sizeBytes: 128,
							width: null,
							height: null,
						},
					],
				}),
			],
			LABELS,
		);
		const blocks = tree[0]?.contentJson as Array<Record<string, unknown>>;
		expect(blocks.map((b) => b.type)).toEqual(["image", "text_file", "text"]);
		expect(blocks[0]).toMatchObject({
			filename: "shot.png",
			width: 640,
			height: 480,
			fetchUrl: "/chat/attachments/a1",
		});
		expect(blocks[1]).toMatchObject({
			filename: "notes.txt",
			fetchUrl: "/chat/attachments/a2",
		});
	});

	it("forwards the sender snapshot as creator (guest authors flagged)", () => {
		const sender = {
			id: "user-9",
			username: "carol",
			avatarColor: "indigo",
			avatarImageId: null,
		};
		const tree = projectChatMessagesToTree([msg({ id: "m1", sender })], LABELS);
		expect(tree[0]?.creator).toMatchObject({ id: "user-9", username: "carol" });
		const guest = projectChatMessagesToTree(
			[
				msg({
					id: "m2",
					sender: {
						id: "guest-1",
						username: "访客甲",
						avatarColor: null,
						avatarImageId: null,
						isGuest: true,
					},
				}),
			],
			LABELS,
		);
		expect((guest[0]?.creator as { isGuest?: boolean } | null)?.isGuest).toBe(true);
	});
});
