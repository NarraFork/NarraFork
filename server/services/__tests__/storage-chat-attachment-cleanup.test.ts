import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanDb } from "../../../tests/setup";
import { setChatAttachmentsDirForTests } from "../../lib/chat-attachments";
import { DbReadError } from "../../lib/db-worker/errors";
import * as pool from "../../lib/db-worker/pool";
import { closeRuntimeTestDb, getRuntimeTestDb } from "./agent-runtime-test-database";

const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { cleanupOrphanedChatAttachments } = await import("../storage-service");

const OLD = "2020-01-01T00:00:00.000Z";
let root: string;

function seedRoom(id: string) {
	sqlite.run("INSERT INTO chat_rooms (id, kind, created_at) VALUES (?, 'dm', ?)", [id, OLD]);
}
function seedAttachment(id: string, roomId: string, messageId: string | null = null) {
	sqlite.run(
		"INSERT INTO chat_attachments (id, room_id, message_id, kind, filename, media_type, size_bytes, stored_name, created_at) VALUES (?, ?, ?, 'file', 'f.txt', 'text/plain', 4, ?, ?)",
		[id, roomId, messageId, `${id}.txt`, OLD],
	);
}
async function seedFile(roomId: string, storedName: string) {
	await mkdir(join(root, roomId), { recursive: true });
	await writeFile(join(root, roomId, storedName), "data");
}

/** Change the database right after the `nth` Worker read returns, before the cleanup acts. */
function afterRead(nth: number, change: () => void) {
	const run = pool.runReadTask;
	let reads = 0;
	spyOn(pool, "runReadTask").mockImplementation((async (path, params, options) => {
		const result = await run(path, params, options);
		if (++reads === nth) change();
		return result;
	}) as typeof pool.runReadTask);
}

beforeEach(async () => {
	cleanDb(sqlite);
	root = await mkdtemp(join(tmpdir(), "nf-chat-attachments-"));
	setChatAttachmentsDirForTests(root);
});
afterEach(async () => {
	mock.restore();
	setChatAttachmentsDirForTests(null);
	await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
	await closeRuntimeTestDb(sqlite);
	mock.module("../../db", () => realDbModule);
});

describe("chat attachment cleanup", () => {
	test("removes stale drafts, unreferenced files and rooms that no longer exist", async () => {
		seedRoom("room");
		seedAttachment("draft", "room");
		seedAttachment("kept", "room", "message");
		await seedFile("room", "draft.txt");
		await seedFile("room", "kept.txt");
		await seedFile("room", "stray.txt");
		await seedFile("gone-room", "x.txt");
		const result = await cleanupOrphanedChatAttachments();
		expect(result.removed).toBe(3);
		expect(existsSync(join(root, "room", "kept.txt"))).toBe(true);
		expect(existsSync(join(root, "room", "draft.txt"))).toBe(false);
		expect(existsSync(join(root, "room", "stray.txt"))).toBe(false);
		expect(existsSync(join(root, "gone-room"))).toBe(false);
		expect(sqlite.query("SELECT id FROM chat_attachments").all()).toEqual([{ id: "kept" }]);
	});

	test("a draft claimed by a message after the sweep read keeps its row and file", async () => {
		seedRoom("room");
		seedAttachment("draft", "room");
		await seedFile("room", "draft.txt");
		afterRead(1, () => sqlite.run("UPDATE chat_attachments SET message_id = 'claimed'"));
		await cleanupOrphanedChatAttachments();
		expect(sqlite.query("SELECT message_id AS messageId FROM chat_attachments").get()).toEqual({
			messageId: "claimed",
		});
		expect(existsSync(join(root, "room", "draft.txt"))).toBe(true);
	});

	test("a room created after the room read keeps its directory", async () => {
		await seedFile("new-room", "x.txt");
		// Reads: draft sweep, then the room page.
		afterRead(2, () => seedRoom("new-room"));
		await cleanupOrphanedChatAttachments();
		expect(existsSync(join(root, "new-room", "x.txt"))).toBe(false);
		// The room has no row for x.txt, so only the file is a stray; the directory stays.
		expect(existsSync(join(root, "new-room"))).toBe(true);
	});

	test("a file whose row is published after the room's row read is not removed", async () => {
		seedRoom("room");
		await seedFile("room", "late.txt");
		// Reads: draft sweep, room page, then that room's stored names.
		afterRead(3, () => seedAttachment("late", "room", "message"));
		await cleanupOrphanedChatAttachments();
		expect(existsSync(join(root, "room", "late.txt"))).toBe(true);
	});

	test("an unavailable Worker fails the cleanup before anything is deleted", async () => {
		seedRoom("room");
		seedAttachment("draft", "room");
		await seedFile("room", "draft.txt");
		await seedFile("gone-room", "x.txt");
		spyOn(pool, "runReadTask").mockRejectedValue(
			new DbReadError("DB_READ_UNAVAILABLE", "injected cleanup fault"),
		);
		await expect(cleanupOrphanedChatAttachments()).rejects.toMatchObject({
			code: "DB_READ_UNAVAILABLE",
		});
		expect(existsSync(join(root, "room", "draft.txt"))).toBe(true);
		expect(existsSync(join(root, "gone-room", "x.txt"))).toBe(true);
		expect(sqlite.query("SELECT count(*) AS n FROM chat_attachments").get()).toEqual({ n: 1 });
	});
});
