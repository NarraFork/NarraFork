import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { testEnvironment } from "../../../tests/preload";
import { db, sqlite } from "../../db";
import { chatAttachments, chatRooms } from "../../db/schema";
import * as workerRead from "../../db/worker-read";
import { setChatAttachmentsDirForTests } from "../../lib/chat-attachments";
import { closeReadDatabase } from "../../lib/db-worker/pool";
import { generateId } from "../../lib/id";
import { cleanupOrphanedChatAttachments } from "../storage-service";

afterAll(() => closeReadDatabase(sqlite.filename));

test("a draft claimed after Worker pre-read keeps its database row and attachment file", async () => {
	const root = await mkdtemp(join(testEnvironment.isolatedHome, "chat-cleanup-worker-"));
	const roomId = generateId(),
		attachmentId = generateId();
	const roomPath = join(root, roomId),
		storedName = `${attachmentId}.bin`;
	await mkdir(roomPath);
	await writeFile(join(roomPath, storedName), "kept");
	setChatAttachmentsDirForTests(root);
	db.insert(chatRooms)
		.values({ id: roomId, kind: "dm", dmKey: roomId, createdAt: "2026-01-01T00:00:00.000Z" })
		.run();
	db.insert(chatAttachments)
		.values({
			id: attachmentId,
			roomId,
			kind: "file",
			filename: "kept.bin",
			mediaType: "application/octet-stream",
			sizeBytes: 4,
			storedName,
			createdAt: "2026-01-01T00:00:00.000Z",
		})
		.run();
	const original = workerRead.readQuery;
	let claimed = false;
	const hook = async <T>(
		query: PromiseLike<T> & { toSQL(): { sql: string; params: unknown[] } },
		options?: workerRead.ReadQueryOptions,
	): Promise<T> => {
		const result = await original<T>(query, options);
		if (
			!claimed &&
			query.toSQL().sql.includes("chat_attachments") &&
			Array.isArray(result) &&
			result.some((row: { id?: string }) => row.id === attachmentId)
		) {
			claimed = true;
			db.update(chatAttachments)
				.set({ messageId: "published-message", claimedAt: new Date().toISOString() })
				.where(eq(chatAttachments.id, attachmentId))
				.run();
		}
		return result;
	};
	const read = spyOn(workerRead, "readQuery").mockImplementation(hook);
	try {
		expect(await cleanupOrphanedChatAttachments()).toMatchObject({ removed: 0 });
		expect(claimed).toBe(true);
		expect(await readFile(join(roomPath, storedName), "utf8")).toBe("kept");
		expect(
			db
				.select({ messageId: chatAttachments.messageId })
				.from(chatAttachments)
				.where(eq(chatAttachments.id, attachmentId))
				.get()?.messageId,
		).toBe("published-message");
	} finally {
		read.mockRestore();
		setChatAttachmentsDirForTests(null);
		db.delete(chatRooms).where(eq(chatRooms.id, roomId)).run();
		await rm(root, { recursive: true, force: true });
	}
});
