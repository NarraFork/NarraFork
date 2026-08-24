import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";
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
	compactLocks,
	isNarratorRuntimeBusy,
	type SavedBufferedFile,
} from "./narrator-session-state";

/** Maximum number of messages that can be queued per narrator. */
const MAX_BUFFERED_MESSAGES = 50;

/**
 * Whether this narrator can hold a queued message right now.
 *
 * An `activeNarrators` entry is NOT the only form of "there is a runtime that will
 * eventually consume this". Several parent-side stages drive a narrator with no
 * entry at all while legitimately holding it in `working`:
 * planned-update continuation recovery, the subagent recovery stages, and the
 * recovery Await batch (see `registerPlannedUpdateRecoveryController`, which claims
 * the runtime for exactly that reason).
 *
 * Rejecting those made the queue silently unavailable during the window right after
 * an update restart. The caller in `routes/narrators.ts` treats a rejection as
 * "narrator not active in memory" and falls through to a normal send, so a message
 * sent while recovery was still driving a foreground subagent started a SECOND agent
 * loop beside it — the parent then talked over its own running subagent.
 *
 * `isNarratorRuntimeBusy` is the authoritative in-memory answer to "is this narrator
 * busy", covering live loops, permission/danger pauses and loop-less runtime claims.
 *
 * A running compact is admitted too, and it is the one owner that is NOT "busy" in
 * the runtime sense: the narrator can be perfectly idle while its context is being
 * rebuilt. Queuing is still the right answer there, because a turn started against
 * the pre-compact history races the summary that is about to replace it. The
 * consumer for this case is `drainQueuedMessagesAfterCompact` (see
 * ./compact-queue-drain.ts), which runs when the compact lock is released on ANY
 * exit — success, failure, cancel or watchdog timeout.
 */
function canQueueForNarrator(narratorId: string): boolean {
	return (
		activeNarrators.has(narratorId) ||
		isNarratorRuntimeBusy(narratorId) ||
		compactLocks.has(narratorId)
	);
}

/** Directory under ~/.narrafork where buffered text files are persisted. */
function getBufferedFilesDir(): string {
	return getNarraforkPath("buffered-files");
}

/**
 * Save text files to a temp directory so they survive restarts. Returns metadata for DB.
 *
 * Names are made unique within the message's directory. Two same-named files
 * used to write to the same path, so one silently replaced the other's content
 * while both stayed listed — and once editing can add a file alongside kept
 * ones, a new upload could overwrite an attachment the user chose to keep.
 * `reserved` carries the names the message already holds on disk.
 */
async function persistBufferedTextFiles(
	messageId: string,
	files: File[],
	reserved: Iterable<string> = [],
): Promise<SavedBufferedFile[]> {
	if (files.length === 0) return [];
	const dir = join(getBufferedFilesDir(), messageId);
	mkdirSync(dir, { recursive: true });
	const taken = new Set(reserved);
	const result: SavedBufferedFile[] = [];
	for (const file of files) {
		const safeName = basename(file.name) || "unnamed";
		let uniqueName = safeName;
		if (taken.has(uniqueName)) {
			const ext = extname(safeName);
			const stem = ext ? safeName.slice(0, -ext.length) : safeName;
			uniqueName = `${stem}_${generateShortId()}${ext}`;
		}
		taken.add(uniqueName);
		const filePath = join(dir, uniqueName);
		await Bun.write(filePath, file);
		result.push({ filename: uniqueName, path: filePath, size: file.size });
	}
	return result;
}

/** Remove persisted text files for a buffered message. */
export function cleanupBufferedTextFiles(messageId: string): void {
	const dir = join(getBufferedFilesDir(), messageId);
	rmSync(dir, { recursive: true, force: true });
}

/**
 * Save additional text files onto an already-queued message.
 *
 * Exposed for the attachment-editing route: new files land in the SAME
 * `<messageId>/` directory as the ones the message already holds, so the
 * existing cleanup paths (`cleanupBufferedTextFiles`) keep covering them.
 */
export function persistAdditionalBufferedTextFiles(
	messageId: string,
	files: File[],
	reservedFilenames: Iterable<string>,
): Promise<SavedBufferedFile[]> {
	return persistBufferedTextFiles(messageId, files, reservedFilenames);
}

/**
 * Delete ONE persisted text file that an edit removed.
 *
 * Deliberately not `cleanupBufferedTextFiles`: the message keeps living with its
 * remaining attachments, so removing the whole directory would take the kept
 * files down with it.
 */
export function deleteBufferedTextFile(saved: SavedBufferedFile): void {
	rmSync(saved.path, { force: true });
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
	if (!canQueueForNarrator(narratorId)) {
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

/**
 * Attachment replacement for an in-place queue edit.
 *
 * Every field is optional and `undefined` means "leave this alone", so the
 * long-standing text-only callers keep their exact behaviour. `textFiles` and
 * `savedFiles` are two halves of the same change (the reconstructed File objects
 * the consumer will feed to the worktree, and the on-disk metadata the DB row
 * carries across a restart) and must be passed together.
 */
export interface BufferedMessageAttachmentUpdate {
	images?: ImageRef[];
	textFiles?: File[];
	savedFiles?: SavedBufferedFile[];
}

/** Edit a queued message in-place (text and/or attachments). */
export function updateBufferedMessage(
	narratorId: string,
	messageId: string,
	text: string,
	opts?: BufferedMessageAttachmentUpdate,
): boolean {
	const queue = bufferedMessages.get(narratorId);
	if (!queue) return false;
	const msg = queue.find((m) => m.id === messageId);
	if (!msg) return false;
	const { images, textFiles, savedFiles } = opts ?? {};
	msg.text = text;
	if (images !== undefined) msg.images = images.length ? images : undefined;
	if (textFiles !== undefined) msg.textFiles = textFiles.length ? textFiles : undefined;
	if (savedFiles !== undefined) msg._savedFiles = savedFiles.length ? savedFiles : undefined;
	msg.bufferedAt = new Date().toISOString();
	db.update(narratorBufferedMessages)
		.set({
			text,
			bufferedAt: msg.bufferedAt,
			...(images !== undefined
				? { imagesJson: images.length ? JSON.stringify(images) : null }
				: {}),
			...(savedFiles !== undefined
				? { textFilePathsJson: savedFiles.length ? JSON.stringify(savedFiles) : null }
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

/** Image attachment of a queued message, as shown to clients. */
export interface BufferedImageSummary {
	imageId: string;
	filename: string;
	mediaType: string;
	width?: number;
	height?: number;
	/** Narrator that owns the uploaded file, for `/api/uploads/:narratorId/:imageId`. */
	uploadNarratorId?: string;
}

/**
 * Text-file attachment of a queued message, as shown to clients.
 *
 * `index` — not the filename — is the identity a client sends back when editing.
 * The primary queue persists files with `basename`, so a filename is unique
 * there, but a taken-over subagent's queue holds the original `File` objects and
 * two same-named files can coexist. Positional identity is exact for both.
 */
export interface BufferedTextFileSummary {
	index: number;
	filename: string;
	size: number;
}

export interface BufferMessageSummary {
	id: string;
	text: string;
	bufferedAt: string;
	imageCount: number;
	images: BufferedImageSummary[];
	textFiles: BufferedTextFileSummary[];
	creator?: BufferCreator | null;
	priority?: boolean;
}

/**
 * Project the text-file attachments of a queued message.
 *
 * `_savedFiles` is preferred because it carries the on-disk size; a subagent
 * queue has no persisted metadata, so its `File` objects are read directly.
 */
function toTextFileSummaries(
	msg: Pick<BufferedMessage, "textFiles" | "_savedFiles">,
): BufferedTextFileSummary[] {
	if (msg._savedFiles?.length) {
		return msg._savedFiles.map((file, index) => ({
			index,
			filename: file.filename,
			size: file.size,
		}));
	}
	if (msg.textFiles?.length) {
		return msg.textFiles.map((file, index) => ({
			index,
			filename: file.name,
			size: file.size,
		}));
	}
	return [];
}

/** Project a buffer queue to the shape needed for WS broadcast / REST responses. */
export function toBufferSummary(
	msgs: readonly Pick<
		BufferedMessage,
		"id" | "text" | "bufferedAt" | "images" | "textFiles" | "_savedFiles" | "creator" | "priority"
	>[],
): BufferMessageSummary[] {
	return msgs.map((m) => ({
		id: m.id,
		text: m.text,
		bufferedAt: m.bufferedAt,
		imageCount: m.images?.length ?? 0,
		images: (m.images ?? []).map((image) => ({
			imageId: image.imageId,
			filename: image.filename,
			mediaType: image.mediaType,
			...(image.width !== undefined ? { width: image.width } : {}),
			...(image.height !== undefined ? { height: image.height } : {}),
			...(image.uploadNarratorId !== undefined ? { uploadNarratorId: image.uploadNarratorId } : {}),
		})),
		textFiles: toTextFileSummaries(m),
		creator: m.creator ?? null,
		priority: m.priority || undefined,
	}));
}
