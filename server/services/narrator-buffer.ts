import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { FileReference, FileReferenceSnapshot } from "@shared/file-reference";
import { MAX_EDIT_TEXT_FILES_PER_MESSAGE, MAX_TEXT_FILE_SIZE } from "@shared/text-file-types";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { narratorBufferedMessages as mailbox, narrators } from "../db/schema";
import {
	copyFileReference,
	freezeFileReferenceSnapshots,
} from "../lib/agent/file-reference-projection";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";
import type { ImageRef } from "../lib/uploads";
import { MAILBOX_LIMITS } from "./agent-runtime/limits";
import { createMailboxStore } from "./agent-runtime/mailbox";
import type { MailboxRow } from "./agent-runtime/mailbox-types";
import {
	activeNarrators,
	type BufferCreator,
	type BufferedMessage,
	compactLocks,
	isNarratorRuntimeBusy,
	type SavedBufferedFile,
} from "./narrator-session-state";

// REST text input is capped at 100k UTF-16 units; this also covers internal producers.
const MAX_BUFFERED_PAYLOAD_BYTES = 2 * 1024 * 1024;
const STAGING_OWNER_FILE = ".mailbox-owner.json";
const store = createMailboxStore(db);
const pending = ["queued", "failed"] as const;
// These are unaccepted preparation permits, never a second message authority.
let activePreparations = 0;
const preparationWaiters: Array<() => void> = [];
async function acquirePreparation(): Promise<() => void> {
	if (activePreparations >= MAILBOX_LIMITS.prepareConcurrency) {
		if (preparationWaiters.length >= MAILBOX_LIMITS.userPending)
			throw new Error("Buffered preparation is full");
		await new Promise<void>((resolve, reject) => {
			const ready = () => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				const index = preparationWaiters.indexOf(ready);
				if (index >= 0) preparationWaiters.splice(index, 1);
				reject(new Error("Buffered preparation timed out"));
			}, MAILBOX_LIMITS.prepareTimeoutMs);
			preparationWaiters.push(ready);
		});
	} else activePreparations++;
	return () => {
		const next = preparationWaiters.shift();
		if (next) next();
		else activePreparations--;
	};
}
async function writeBufferedFile(path: string, value: File | string): Promise<void> {
	const release = await acquirePreparation();
	const started = Date.now();
	let expired = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const write = Promise.resolve()
		.then(() => Bun.write(path, value))
		.finally(() => {
			release();
			if (expired) {
				deleteBufferedTextFile({ filename: basename(path), path, size: 0 });
				cleanupBufferedTextFiles(basename(dirname(path)));
			}
		});
	try {
		await Promise.race([
			write,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					expired = true;
					reject(new Error("Buffered file preparation timed out"));
				}, MAILBOX_LIMITS.prepareTimeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
		if (Date.now() - started > 1000)
			logger.warn("Slow buffered file preparation", {
				durationMs: Date.now() - started,
				timedOut: expired,
			});
	}
}
function getBufferedFilesDir(): string {
	return getNarraforkPath("buffered-files");
}
function stagingPath(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid buffered staging identity");
	return join(getBufferedFilesDir(), id);
}
function ownedPath(path: string): boolean {
	const root = resolve(getBufferedFilesDir());
	const target = resolve(path);
	if (!target.startsWith(`${root}${sep}`)) return false;
	try {
		return realpathSync(target).startsWith(`${realpathSync(root)}${sep}`);
	} catch {
		return false;
	}
}
function json<T>(value: string | null, fallback: T): T {
	return value ? JSON.parse(value) : fallback;
}
function rowById(id: string): MailboxRow | undefined {
	return db.select().from(mailbox).where(eq(mailbox.id, id)).get();
}
function ensureStagingDirectory(id: string): string {
	const dir = stagingPath(id);
	mkdirSync(dir, { recursive: true });
	if (!ownedPath(dir)) throw new Error("Invalid buffered staging path");
	const marker = join(dir, STAGING_OWNER_FILE);
	if (!existsSync(marker)) writeFileSync(marker, JSON.stringify({ rowId: null }));
	return dir;
}
interface StagingMetadata {
	stagingId?: string;
	fileReferencesPath?: string;
	commandTextPath?: string;
	bashCommandPath?: string;
}
function readManagedText(path: string, max = MAX_BUFFERED_PAYLOAD_BYTES): string {
	if (!ownedPath(path) || statSync(path).size > max)
		throw new Error("Invalid buffered payload file");
	return readFileSync(path, "utf8");
}
async function writeStagingText(id: string, prefix: string, text: string): Promise<string> {
	if (Buffer.byteLength(text) > MAX_BUFFERED_PAYLOAD_BYTES)
		throw new Error("Buffered payload exceeds size limit");
	const dir = ensureStagingDirectory(id);
	const path = join(dir, `${prefix}-${generateShortId()}.json`);
	try {
		await writeBufferedFile(path, text);
		return path;
	} catch (error) {
		if (ownedPath(path)) rmSync(path, { force: true });
		throw error;
	}
}
/** Save attachments once; both primary and subagent producers use this durable representation. */
export async function persistBufferedTextFiles(
	id: string,
	files: File[],
	reserved: Iterable<string> = [],
): Promise<SavedBufferedFile[]> {
	if (!files.length) return [];
	if (files.length > MAX_EDIT_TEXT_FILES_PER_MESSAGE)
		throw new Error("Too many buffered attachments");
	const dir = ensureStagingDirectory(id);
	const taken = new Set([STAGING_OWNER_FILE, ...reserved]);
	const saved: SavedBufferedFile[] = [];
	try {
		for (const file of files) {
			if (file.size > MAX_TEXT_FILE_SIZE) throw new Error("Buffered attachment exceeds size limit");
			const namePart = basename(file.name);
			const safe = !namePart || namePart === "." || namePart === ".." ? "unnamed" : namePart;
			let name = safe;
			while (taken.has(name) || existsSync(join(dir, name))) {
				const ext = extname(safe);
				name = `${ext ? safe.slice(0, -ext.length) : safe}_${generateShortId()}${ext}`;
			}
			taken.add(name);
			const path = join(dir, name);
			// Register before write so a partial write is cleaned after failure too.
			saved.push({ filename: name, path, size: file.size });
			await writeBufferedFile(path, file);
		}
		return saved;
	} catch (error) {
		for (const file of saved) deleteBufferedTextFile(file);
		throw error;
	}
}
/** Only clean a known, unreferenced mailbox staging directory, never uploads/history. */
export function cleanupBufferedTextFiles(id: string): void {
	const row = rowById(id);
	const stagingId = row
		? (json<{ stagingId?: string }>(row.metadataJson, {}).stagingId ?? row.id)
		: id;
	if (!stagingId) return;
	const path = stagingPath(stagingId);
	if (!ownedPath(path)) return;
	// A small on-disk ownership pointer avoids scanning every narrator's mailbox.
	// It is not a message registry: the DB row still decides whether files are leased.
	const marker = join(path, STAGING_OWNER_FILE);
	let ownerId: string | null = row?.id ?? stagingId;
	if (!existsSync(marker) && (!row || row.kind !== "user_input")) return;
	if (existsSync(marker)) {
		if (!ownedPath(marker) || statSync(marker).size > 1024) return;
		try {
			ownerId = JSON.parse(readFileSync(marker, "utf8")).rowId ?? ownerId;
		} catch {
			return;
		}
		if (ownerId !== null && typeof ownerId !== "string") return;
	}
	const owner = ownerId ? rowById(ownerId) : undefined;
	if (owner && ["queued", "claimed", "failed"].includes(owner.state)) return;
	rmSync(path, { recursive: true, force: true });
}
export function persistAdditionalBufferedTextFiles(
	messageId: string,
	files: File[],
	reserved: Iterable<string>,
): Promise<SavedBufferedFile[]> {
	const row = rowById(messageId);
	if (!row || row.kind !== "user_input" || !pending.includes(row.state as "queued" | "failed"))
		throw new Error("Buffered message is no longer editable");
	const id = json<{ stagingId?: string }>(row.metadataJson, {}).stagingId ?? row.id;
	if (files.length) {
		mkdirSync(stagingPath(id), { recursive: true });
		writeFileSync(join(stagingPath(id), STAGING_OWNER_FILE), JSON.stringify({ rowId: row.id }));
	}
	return persistBufferedTextFiles(id, files, reserved);
}
export function deleteBufferedTextFile(saved: SavedBufferedFile): void {
	if (!ownedPath(saved.path)) return;
	const marker = join(dirname(saved.path), STAGING_OWNER_FILE);
	let ownerId: string | null = basename(dirname(saved.path));
	if (!existsSync(marker) && !rowById(ownerId)) return;
	if (existsSync(marker)) {
		if (!ownedPath(marker) || statSync(marker).size > 1024) return;
		try {
			ownerId = JSON.parse(readFileSync(marker, "utf8")).rowId ?? ownerId;
		} catch {
			return;
		}
		if (ownerId !== null && typeof ownerId !== "string") return;
	}
	const owner = ownerId ? rowById(ownerId) : undefined;
	if (
		owner &&
		json<SavedBufferedFile[]>(owner.textFilePathsJson, []).some(
			(file) => resolve(file.path) === resolve(saved.path),
		)
	)
		return;
	rmSync(saved.path, { force: true });
}
export function loadBufferedTextFiles(saved: SavedBufferedFile[]): File[] {
	return saved.flatMap((s) => {
		if (!existsSync(s.path)) return [];
		if (statSync(s.path).size > MAX_TEXT_FILE_SIZE)
			throw new Error("Buffered attachment exceeds size limit");
		// Bun's file-backed Blob retains the path instead of synchronously loading a
		// potentially 100MB attachment into the request/event-loop heap.
		return [new File([Bun.file(s.path)], s.filename, { type: "text/plain" })];
	});
}
export function projectMailboxUserMessage(row: MailboxRow): BufferedMessage {
	if (row.kind !== "user_input") throw new Error("Expected user mailbox input");
	const saved = json<SavedBufferedFile[]>(row.textFilePathsJson, []);
	const payload = json<{ path: string } | null>(row.payloadRefJson, null);
	const metadata = json<StagingMetadata>(row.metadataJson, {});
	return {
		id: row.id,
		state: row.state === "failed" ? "failed" : "queued",
		error: row.lastError,
		get text() {
			return payload ? readManagedText(payload.path) : row.text;
		},
		images: json<ImageRef[] | undefined>(row.imagesJson, undefined),
		get fileReferences() {
			return freezeFileReferenceSnapshots(
				metadata.fileReferencesPath
					? JSON.parse(readManagedText(metadata.fileReferencesPath))
					: json<FileReferenceSnapshot[]>(row.fileReferencesJson, []),
			);
		},
		get textFiles() {
			return saved.length ? loadBufferedTextFiles(saved) : undefined;
		},
		_savedFiles: saved.length ? saved : undefined,
		_stagingId: json<{ stagingId?: string }>(row.metadataJson, {}).stagingId ?? row.id,
		_recipientMessageId: row.recipientMessageId ?? undefined,
		bufferedAt: row.bufferedAt,
		get commandText() {
			return metadata.commandTextPath ? readManagedText(metadata.commandTextPath) : row.commandText;
		},
		get bashCommand() {
			return metadata.bashCommandPath ? readManagedText(metadata.bashCommandPath) : row.bashCommand;
		},
		createdBy: row.createdBy,
		creator: json<BufferCreator | null>(row.creatorJson, null),
		priority: row.priority,
		...(row.state === "claimed" && row.claimToken && row.claimEpoch
			? {
					_mailboxClaim: {
						id: row.id,
						narratorId: row.narratorId,
						token: row.claimToken,
						epoch: row.claimEpoch,
					},
				}
			: {}),
	};
}
export function getBufferedMessages(narratorId: string): BufferedMessage[] {
	return db
		.select()
		.from(mailbox)
		.where(
			and(
				eq(mailbox.narratorId, narratorId),
				eq(mailbox.kind, "user_input"),
				inArray(mailbox.state, pending),
			),
		)
		.orderBy(desc(mailbox.priority), asc(mailbox.seq), asc(mailbox.arrivalSeq))
		.limit(MAILBOX_LIMITS.userPending)
		.all()
		.map(projectMailboxUserMessage);
}
/** Busy admission is intentionally outside the shared durable producer. */
export async function pushBufferedMessage(
	...args: Parameters<typeof enqueueBufferedMessage>
): ReturnType<typeof enqueueBufferedMessage> {
	const id = args[0];
	if (!activeNarrators.has(id) && !isNarratorRuntimeBusy(id) && !compactLocks.has(id))
		return { ok: false, bufferedAt: "", id: "" };
	return enqueueBufferedMessage(...args);
}
export async function enqueueBufferedMessage(
	narratorId: string,
	text: string,
	images?: ImageRef[],
	commandText?: string | null,
	createdBy?: string | null,
	creator?: BufferCreator | null,
	textFiles?: File[],
	position: "back" | "front" = "back",
	bashCommand?: string | null,
	fileReferences?: FileReferenceSnapshot[],
	frontOrder: "stack" | "fifo" = "stack",
): Promise<{ ok: boolean; bufferedAt: string; id: string; full?: boolean }> {
	const stagingId = generateShortId();
	const refs = freezeFileReferenceSnapshots(fileReferences);
	images = images?.map((image) => ({ ...image }));
	creator = creator ? { ...creator } : creator;
	textFiles = textFiles ? [...textFiles] : undefined;
	let saved: SavedBufferedFile[] = [];
	try {
		saved = await persistBufferedTextFiles(stagingId, textFiles ?? []);
		const bytes = Buffer.byteLength(text);
		if (bytes > MAX_BUFFERED_PAYLOAD_BYTES) throw new Error("Buffered input exceeds size limit");
		let payloadRef:
			| { storage: "buffered_file"; path: string; byteSize: number; ownership: "mailbox" }
			| undefined;
		if (bytes > MAILBOX_LIMITS.inlineBytes) {
			const path = await writeStagingText(stagingId, "body", text);
			payloadRef = { storage: "buffered_file", path, byteSize: bytes, ownership: "mailbox" };
		}
		let fileReferencesJson = refs.length ? JSON.stringify(refs) : null;
		const metadata: StagingMetadata = { stagingId };
		if (commandText && Buffer.byteLength(commandText) > MAILBOX_LIMITS.metadataBytes / 8) {
			metadata.commandTextPath = await writeStagingText(stagingId, "command", commandText);
			commandText = null;
		}
		if (bashCommand && Buffer.byteLength(bashCommand) > MAILBOX_LIMITS.metadataBytes / 8) {
			metadata.bashCommandPath = await writeStagingText(stagingId, "bash", bashCommand);
			bashCommand = null;
		}
		if (
			fileReferencesJson &&
			Buffer.byteLength(fileReferencesJson) > MAILBOX_LIMITS.metadataBytes / 2
		) {
			metadata.fileReferencesPath = await writeStagingText(
				stagingId,
				"references",
				fileReferencesJson,
			);
			fileReferencesJson = null;
		}
		const result = db.transaction((tx) => {
			const rows = tx
				.select({ id: mailbox.id, seq: mailbox.seq, priority: mailbox.priority })
				.from(mailbox)
				.where(
					and(
						eq(mailbox.narratorId, narratorId),
						eq(mailbox.kind, "user_input"),
						inArray(mailbox.state, pending),
					),
				)
				.limit(MAILBOX_LIMITS.userPending)
				.all();
			rows.sort((a, b) => a.seq - b.seq);
			const recipient = tx
				.select({ sequence: narrators.inboxSequence })
				.from(narrators)
				.where(eq(narrators.id, narratorId))
				.get();
			const fifoPriority = position === "front" && frontOrder === "fifo";
			const seq =
				position === "front"
					? Math.min(0, ...rows.map((r) => r.seq)) - 1
					: Math.max(recipient?.sequence ?? 0, ...rows.map((r) => r.seq)) + 1;
			const accepted = store.enqueue(
				{
					narratorId,
					kind: "user_input",
					text: payloadRef ? "" : text,
					projectedByteSize: bytes,
					payloadRef,
					metadata: { ...metadata },
					createdBy,
					priority: position === "front",
					seq,
					commandText,
					bashCommand,
					imagesJson: images?.length ? JSON.stringify(images) : null,
					creatorJson: creator ? JSON.stringify(creator) : null,
					textFilePathsJson: saved.length ? JSON.stringify(saved) : null,
					fileReferencesJson,
				},
				tx,
			);
			if (accepted.status === "accepted" && fifoPriority) {
				// Subagent priority inputs historically preserve FIFO within the priority
				// group. Publish their order atomically with acceptance, never afterward.
				const orderedIds = [
					...rows.filter((row) => row.priority).map((row) => row.id),
					accepted.delivery.id,
				];
				const priorityBase = Math.min(0, ...rows.map((row) => row.seq)) - orderedIds.length;
				for (const [order, id] of orderedIds.entries()) {
					tx.update(mailbox)
						.set({ seq: priorityBase + order })
						.where(
							and(
								eq(mailbox.id, id),
								eq(mailbox.narratorId, narratorId),
								eq(mailbox.kind, "user_input"),
								inArray(mailbox.state, pending),
							),
						)
						.run();
				}
			}
			if (accepted.status === "accepted" && existsSync(stagingPath(stagingId))) {
				writeFileSync(
					join(stagingPath(stagingId), STAGING_OWNER_FILE),
					JSON.stringify({ rowId: accepted.delivery.id }),
				);
			}
			return accepted;
		});
		if (result.status !== "accepted" && result.status !== "duplicate") {
			cleanupBufferedTextFiles(stagingId);
			return { ok: false, bufferedAt: "", id: "", full: true };
		}
		return { ok: true, bufferedAt: result.delivery.bufferedAt, id: result.delivery.id };
	} catch (error) {
		cleanupBufferedTextFiles(stagingId);
		throw error;
	}
}
export interface BufferedMessageAttachmentUpdate {
	images?: ImageRef[];
	textFiles?: File[];
	savedFiles?: SavedBufferedFile[];
	fileReferences?: FileReferenceSnapshot[];
}
export async function updateBufferedMessage(
	narratorId: string,
	messageId: string,
	text: string,
	opts: BufferedMessageAttachmentUpdate = {},
): Promise<boolean> {
	const row = rowById(messageId);
	if (
		!row ||
		row.narratorId !== narratorId ||
		row.kind !== "user_input" ||
		!pending.includes(row.state as "queued" | "failed")
	)
		return false;
	const bytes = Buffer.byteLength(text);
	if (bytes > MAX_BUFFERED_PAYLOAD_BYTES)
		throw new Error("Edited input exceeds mailbox size limit");
	// Snapshot caller-owned arrays before the first asynchronous file write.
	opts = {
		...opts,
		images: opts.images?.map((image) => ({ ...image })),
		savedFiles: opts.savedFiles?.map((file) => ({ ...file })),
		fileReferences:
			opts.fileReferences === undefined
				? undefined
				: freezeFileReferenceSnapshots(opts.fileReferences),
	};
	const metadata = json<StagingMetadata>(row.metadataJson, {});
	const stagingId = metadata.stagingId ?? row.id;
	const prepared: string[] = [];
	const superseded: string[] = [];
	try {
		let payloadRefJson: string | null = null;
		if (bytes > MAILBOX_LIMITS.inlineBytes) {
			const path = await writeStagingText(stagingId, "body", text);
			prepared.push(path);
			payloadRefJson = JSON.stringify({
				storage: "buffered_file",
				ownership: "mailbox",
				path,
				byteSize: bytes,
			});
		}
		let fileReferencesJson = row.fileReferencesJson;
		if (opts.fileReferences !== undefined) {
			const refs = freezeFileReferenceSnapshots(opts.fileReferences);
			fileReferencesJson = refs.length ? JSON.stringify(refs) : null;
			if (metadata.fileReferencesPath) superseded.push(metadata.fileReferencesPath);
			delete metadata.fileReferencesPath;
			if (
				fileReferencesJson &&
				Buffer.byteLength(fileReferencesJson) > MAILBOX_LIMITS.metadataBytes / 2
			) {
				metadata.fileReferencesPath = await writeStagingText(
					stagingId,
					"references",
					fileReferencesJson,
				);
				prepared.push(metadata.fileReferencesPath);
				fileReferencesJson = null;
			}
		}
		const imagesJson =
			opts.images === undefined
				? row.imagesJson
				: opts.images.length
					? JSON.stringify(opts.images)
					: null;
		const textFilePathsJson =
			opts.savedFiles === undefined
				? row.textFilePathsJson
				: opts.savedFiles.length
					? JSON.stringify(opts.savedFiles)
					: null;
		const metadataJson = JSON.stringify({ ...metadata, stagingId });
		if (
			[
				imagesJson,
				textFilePathsJson,
				fileReferencesJson,
				metadataJson,
				payloadRefJson,
				row.creatorJson,
				row.commandText,
				row.bashCommand,
			].reduce((size, item) => size + Buffer.byteLength(item ?? ""), 0) >
			MAILBOX_LIMITS.metadataBytes
		)
			throw new Error("Attachment metadata exceeds mailbox budget");
		const ok = db.transaction((tx) => {
			const changed =
				tx
					.update(mailbox)
					.set({
						text: payloadRefJson ? "" : text,
						payloadRefJson,
						byteSize: bytes,
						projectedByteSize: bytes,
						bufferedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						imagesJson,
						textFilePathsJson,
						fileReferencesJson,
						metadataJson,
						contentRevision: row.contentRevision + 1,
					})
					.where(
						and(
							eq(mailbox.id, messageId),
							eq(mailbox.narratorId, narratorId),
							eq(mailbox.kind, "user_input"),
							inArray(mailbox.state, pending),
							eq(mailbox.contentRevision, row.contentRevision),
						),
					)
					.returning({ id: mailbox.id })
					.all().length === 1;
			if (changed && prepared.length)
				writeFileSync(
					join(stagingPath(stagingId), STAGING_OWNER_FILE),
					JSON.stringify({ rowId: row.id }),
				);
			return changed;
		});
		if (!ok) {
			for (const path of prepared) if (ownedPath(path)) rmSync(path, { force: true });
			return false;
		}
		const oldBody = json<{ path: string } | null>(row.payloadRefJson, null);
		if (oldBody) superseded.push(oldBody.path);
		for (const path of superseded) if (ownedPath(path)) rmSync(path, { force: true });
		return true;
	} catch (error) {
		for (const path of prepared) if (ownedPath(path)) rmSync(path, { force: true });
		throw error;
	}
}
export function removeBufferedMessage(narratorId: string, messageId: string): boolean {
	store.initializeLegacy(narratorId);
	const row = rowById(messageId);
	if (!row || row.narratorId !== narratorId || row.kind !== "user_input" || !row.deliveryId)
		return false;
	const id = json<{ stagingId?: string }>(row.metadataJson, {}).stagingId ?? row.id;
	if (!store.cancel(row.deliveryId, "Removed by user")) return false;
	cleanupBufferedTextFiles(id);
	return true;
}
export function reorderBufferedMessages(narratorId: string, ids: string[]): boolean {
	return db.transaction((tx) => {
		const rows = tx
			.select({ id: mailbox.id })
			.from(mailbox)
			.where(
				and(
					eq(mailbox.narratorId, narratorId),
					eq(mailbox.kind, "user_input"),
					inArray(mailbox.state, pending),
				),
			)
			.limit(MAILBOX_LIMITS.userPending)
			.all();
		if (
			!rows.length ||
			ids.length !== rows.length ||
			new Set(ids).size !== ids.length ||
			rows.some((row) => !ids.includes(row.id))
		)
			return false;
		// Explicit user ordering supersedes front-insertion priority. Clear the badge
		// too, so display, peek and claim agree without changing other input kinds.
		for (const [seq, id] of ids.entries())
			tx.update(mailbox).set({ seq, priority: false }).where(eq(mailbox.id, id)).run();
		return true;
	});
}
export function clearBufferedMessages(narratorId: string): void {
	store.initializeLegacy(narratorId);
	const rows = db
		.select()
		.from(mailbox)
		.where(
			and(
				eq(mailbox.narratorId, narratorId),
				eq(mailbox.kind, "user_input"),
				inArray(mailbox.state, pending),
			),
		)
		.limit(MAILBOX_LIMITS.userPending)
		.all();
	for (const row of rows) removeBufferedMessage(narratorId, row.id);
}
/** Explicit user intent only. Missing staging remains failed instead of spinning a new run. */
export function retryBufferedMessage(narratorId: string, messageId: string): boolean {
	const row = rowById(messageId);
	if (
		!row ||
		row.narratorId !== narratorId ||
		row.kind !== "user_input" ||
		row.state !== "failed" ||
		!row.deliveryId
	)
		return false;
	const message = projectMailboxUserMessage(row);
	// Force all durable payload validation before the atomic state transition.
	void message.text;
	void message.fileReferences;
	void message.commandText;
	void message.bashCommand;
	for (const file of message._savedFiles ?? []) {
		if (!existsSync(file.path) || statSync(file.path).size > MAX_TEXT_FILE_SIZE)
			throw new Error(
				"Buffered attachment is missing or too large; edit or remove it before retrying",
			);
	}
	return store.retryFailed(row.deliveryId);
}
export const dbClearAllBuffered = clearBufferedMessages;
export function releaseBufferedMessage(msg: BufferedMessage, error = "Dispatch interrupted"): void {
	const claim = msg._mailboxClaim;
	if (!claim) return;
	const row = rowById(claim.id);
	// A downstream failure after materialization must not recreate a queued user
	// message; a stale owner must not release a newer generation's claim either.
	if (
		row?.state !== "claimed" ||
		row.claimToken !== claim.token ||
		row.claimEpoch !== claim.epoch ||
		row.narratorId !== claim.narratorId
	)
		return;
	store.failClaim(claim, error);
}
export function restoreBufferedMessage(narratorId: string, msg: BufferedMessage): void {
	if (msg._mailboxClaim?.narratorId !== narratorId) return;
	releaseBufferedMessage(msg);
}

export interface BufferedImageSummary {
	imageId: string;
	filename: string;
	mediaType: string;
	width?: number;
	height?: number;
	uploadNarratorId?: string;
}
export interface BufferedTextFileSummary {
	index: number;
	filename: string;
	size: number;
}
export interface BufferMessageSummary {
	state?: "queued" | "failed";
	error?: string | null;
	id: string;
	text: string;
	bufferedAt: string;
	imageCount: number;
	images: BufferedImageSummary[];
	textFiles: BufferedTextFileSummary[];
	fileReferences: FileReference[];
	creator?: BufferCreator | null;
	priority?: boolean;
}
export function toBufferSummary(
	msgs: readonly Pick<
		BufferedMessage,
		| "state"
		| "error"
		| "id"
		| "text"
		| "bufferedAt"
		| "images"
		| "textFiles"
		| "_savedFiles"
		| "creator"
		| "priority"
		| "fileReferences"
	>[],
): BufferMessageSummary[] {
	return msgs.map((m) => ({
		id: m.id,
		state: m.state,
		error: m.error,
		text: (() => {
			try {
				return m.text;
			} catch {
				return "";
			}
		})(),
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
		textFiles: m._savedFiles?.length
			? m._savedFiles.map((file, index) => ({ index, filename: file.filename, size: file.size }))
			: (m.textFiles ?? []).map((file, index) => ({ index, filename: file.name, size: file.size })),
		fileReferences: (() => {
			try {
				return (m.fileReferences ?? []).map((snapshot) => copyFileReference(snapshot.reference));
			} catch {
				return [];
			}
		})(),
		creator: m.creator ?? null,
		priority: m.priority || undefined,
	}));
}
