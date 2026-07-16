import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../db";
import { narratorBufferedMessages } from "../db/schema";
import { generateShortId } from "../lib/id";
import { getNarraforkPath } from "../lib/narrafork-home";
import type { ImageRef } from "../lib/uploads";
import {
	activeNarrators,
	type BufferCreator,
	type BufferedMessage,
	bufferedMessages,
	type SavedBufferedFile,
} from "./narrator-session-state";

/** Maximum number of messages that can be queued per narrator. */
const MAX_BUFFERED_MESSAGES = 50;

/** Directory under ~/.narrafork where buffered text files are persisted. */
function getBufferedFilesDir(): string {
	return getNarraforkPath("buffered-files");
}

/** Save text files to a temp directory so they survive restarts. Returns metadata for DB. */
async function persistBufferedTextFiles(
	messageId: string,
	files: File[],
): Promise<SavedBufferedFile[]> {
	if (files.length === 0) return [];
	const dir = join(getBufferedFilesDir(), messageId);
	mkdirSync(dir, { recursive: true });
	const result: SavedBufferedFile[] = [];
	for (const file of files) {
		const safeName = basename(file.name) || "unnamed";
		const filePath = join(dir, safeName);
		await Bun.write(filePath, file);
		result.push({ filename: safeName, path: filePath, size: file.size });
	}
	return result;
}

/** Remove persisted text files for a buffered message. */
export function cleanupBufferedTextFiles(messageId: string): void {
	const dir = join(getBufferedFilesDir(), messageId);
	rmSync(dir, { recursive: true, force: true });
}

/** Reconstruct File objects from persisted paths. */
export function loadBufferedTextFiles(saved: SavedBufferedFile[]): File[] {
	const files: File[] = [];
	for (const s of saved) {
		if (!existsSync(s.path)) continue;
		const buf = readFileSync(s.path);
		files.push(new File([buf], s.filename, { type: "text/plain" }));
	}
	return files;
}

/** Write a single buffered message row to DB. */
function dbInsertBuffered(
	id: string,
	narratorId: string,
	text: string,
	seq: number,
	bufferedAt: string,
	images?: ImageRef[],
	commandText?: string | null,
	createdBy?: string | null,
	creator?: BufferCreator | null,
	savedFiles?: SavedBufferedFile[],
	priority = false,
	bashCommand?: string | null,
): void {
	db.insert(narratorBufferedMessages)
		.values({
			id,
			narratorId,
			text,
			seq,
			bufferedAt,
			imagesJson: images?.length ? JSON.stringify(images) : null,
			commandText: commandText ?? null,
			bashCommand: bashCommand ?? null,
			createdBy: createdBy ?? null,
			creatorJson: creator ? JSON.stringify(creator) : null,
			textFilePathsJson: savedFiles?.length ? JSON.stringify(savedFiles) : null,
			priority,
		})
		.run();
}

/** Rewrite seq values for all rows of a narrator to match the in-memory order. */
function dbRewriteSeqs(narratorId: string, orderedIds: string[]): void {
	sqlite.transaction(() => {
		const stmt = sqlite.prepare(
			"UPDATE narrator_buffered_messages SET seq = ? WHERE id = ? AND narrator_id = ?",
		);
		for (let i = 0; i < orderedIds.length; i++) {
			stmt.run(i, orderedIds[i], narratorId);
		}
	})();
}

/** Push a message onto the queue (or unshift to front when position is "front"). */
export async function pushBufferedMessage(
	narratorId: string,
	text: string,
	images?: ImageRef[],
	commandText?: string | null,
	createdBy?: string | null,
	creator?: BufferCreator | null,
	textFiles?: File[],
	position: "back" | "front" = "back",
	bashCommand?: string | null,
): Promise<{ ok: boolean; bufferedAt: string; id: string; full?: boolean }> {
	if (!activeNarrators.has(narratorId)) {
		return { ok: false, bufferedAt: "", id: "" };
	}
	const queue = bufferedMessages.get(narratorId) ?? [];
	if (queue.length >= MAX_BUFFERED_MESSAGES) {
		return { ok: false, bufferedAt: "", id: "", full: true };
	}
	const id = generateShortId();
	const bufferedAt = new Date().toISOString();

	let savedFiles: SavedBufferedFile[] | undefined;
	if (textFiles?.length) {
		savedFiles = await persistBufferedTextFiles(id, textFiles);
	}

	const priority = position === "front";
	const entry: BufferedMessage = {
		id,
		text,
		images,
		textFiles,
		bufferedAt,
		commandText,
		bashCommand: bashCommand ?? null,
		createdBy,
		creator,
		priority,
		_savedFiles: savedFiles,
	};
	if (position === "front") {
		queue.unshift(entry);
		sqlite.transaction(() => {
			const stmt = sqlite.prepare(
				"UPDATE narrator_buffered_messages SET seq = ? WHERE id = ? AND narrator_id = ?",
			);
			for (let i = 0; i < queue.length; i++) {
				stmt.run(i, queue[i].id, narratorId);
			}
			dbInsertBuffered(
				id,
				narratorId,
				text,
				0,
				bufferedAt,
				images,
				commandText,
				createdBy,
				creator,
				savedFiles,
				priority,
				bashCommand,
			);
		})();
	} else {
		queue.push(entry);
		dbInsertBuffered(
			id,
			narratorId,
			text,
			queue.length - 1,
			bufferedAt,
			images,
			commandText,
			createdBy,
			creator,
			savedFiles,
			priority,
			bashCommand,
		);
	}
	bufferedMessages.set(narratorId, queue);
	return { ok: true, bufferedAt, id };
}

/** Edit a queued message in-place. */
export function updateBufferedMessage(
	narratorId: string,
	messageId: string,
	text: string,
	images?: ImageRef[],
): boolean {
	const queue = bufferedMessages.get(narratorId);
	if (!queue) return false;
	const msg = queue.find((m) => m.id === messageId);
	if (!msg) return false;
	msg.text = text;
	if (images !== undefined) msg.images = images;
	msg.bufferedAt = new Date().toISOString();
	db.update(narratorBufferedMessages)
		.set({
			text,
			bufferedAt: msg.bufferedAt,
			...(images !== undefined
				? { imagesJson: images.length ? JSON.stringify(images) : null }
				: {}),
		})
		.where(eq(narratorBufferedMessages.id, messageId))
		.run();
	return true;
}

/** Remove a single queued message. */
export function removeBufferedMessage(narratorId: string, messageId: string): boolean {
	const queue = bufferedMessages.get(narratorId);
	if (!queue) return false;
	const idx = queue.findIndex((m) => m.id === messageId);
	if (idx === -1) return false;
	queue.splice(idx, 1);
	if (queue.length === 0) bufferedMessages.delete(narratorId);
	db.delete(narratorBufferedMessages).where(eq(narratorBufferedMessages.id, messageId)).run();
	cleanupBufferedTextFiles(messageId);
	return true;
}

/** Reorder the queue by a list of message ids. */
export function reorderBufferedMessages(narratorId: string, orderedIds: string[]): boolean {
	const queue = bufferedMessages.get(narratorId);
	if (!queue || queue.length === 0) return false;
	if (orderedIds.length !== queue.length) return false;
	const byId = new Map(queue.map((m) => [m.id, m]));
	const reordered: BufferedMessage[] = [];
	for (const id of orderedIds) {
		const msg = byId.get(id);
		if (!msg) return false;
		reordered.push(msg);
	}
	bufferedMessages.set(narratorId, reordered);
	dbRewriteSeqs(narratorId, orderedIds);
	return true;
}

/** Clear the entire queue. */
export function clearBufferedMessages(narratorId: string): void {
	const queue = bufferedMessages.get(narratorId);
	if (queue) {
		for (const msg of queue) cleanupBufferedTextFiles(msg.id);
	}
	bufferedMessages.delete(narratorId);
	db.delete(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, narratorId))
		.run();
}

/** Delete a single consumed message from DB + cleanup its files. */
export function dbConsumeBuffered(messageId: string): void {
	db.delete(narratorBufferedMessages).where(eq(narratorBufferedMessages.id, messageId)).run();
	cleanupBufferedTextFiles(messageId);
}

/** Delete all buffered messages for a narrator from DB + cleanup files. */
export function dbClearAllBuffered(narratorId: string): void {
	const rows = db
		.select({ id: narratorBufferedMessages.id })
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, narratorId))
		.all();
	if (rows.length === 0) return;
	for (const row of rows) cleanupBufferedTextFiles(row.id);
	db.delete(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, narratorId))
		.run();
}

/** Get the full queue (for REST hydration). */
export function getBufferedMessages(narratorId: string): BufferedMessage[] {
	return bufferedMessages.get(narratorId) ?? [];
}

/** Project a buffer queue to the minimal shape needed for WS broadcast / REST responses. */
export function toBufferSummary(
	msgs: readonly Pick<
		BufferedMessage,
		"id" | "text" | "bufferedAt" | "images" | "creator" | "priority"
	>[],
): Array<{
	id: string;
	text: string;
	bufferedAt: string;
	imageCount: number;
	creator?: BufferCreator | null;
	priority?: boolean;
}> {
	return msgs.map((m) => ({
		id: m.id,
		text: m.text,
		bufferedAt: m.bufferedAt,
		imageCount: m.images?.length ?? 0,
		creator: m.creator ?? null,
		priority: m.priority || undefined,
	}));
}
