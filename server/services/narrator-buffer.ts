import { AsyncLocalStorage } from "node:async_hooks";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import {
	type BufferQueueMode,
	bufferedModePatch,
	ordinaryBufferReorder,
	resolveBufferQueueMode,
} from "@shared/buffer-queue-mode";
import type { ComposerDocument } from "@shared/composer-document";
import type { FileReference, FileReferenceSnapshot } from "@shared/file-reference";
import type { MediaRef } from "@shared/media-attachments";
import { MAX_EDIT_TEXT_FILES_PER_MESSAGE, MAX_TEXT_FILE_SIZE } from "@shared/text-file-types";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { users as pgUsers } from "../db/postgres-schema";
import { narratorBufferedMessages as mailbox, narrators, users } from "../db/schema";
import { readQuery, readQueryFirst } from "../db/worker-read";
import {
	copyFileReference,
	freezeFileReferenceSnapshots,
} from "../lib/agent/file-reference-projection";
import { releaseStagedAttachment } from "../lib/attachment-staging";
import {
	parseOptionalComposerDocument,
	validateComposerAssets,
	validateComposerProjection,
} from "../lib/composer-document";
import { AppError } from "../lib/errors";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";
import type { ImageRef } from "../lib/uploads";
import { MAILBOX_LIMITS } from "./agent-runtime/limits";
import { createMailboxStore } from "./agent-runtime/mailbox";
import type { MailboxRow } from "./agent-runtime/mailbox-types";
import { RuntimeReadConflictError } from "./agent-runtime/read-conflict";
import {
	getRuntimeQueuePort,
	type RuntimeBufferedDeliveryReceipt,
	type RuntimeMailboxRow,
	type RuntimeMailboxStagingLookup,
	type RuntimeQueuePort,
} from "./agent-runtime/runtime-queue-port";
import { bufferEditHolds, isBufferConsumptionHeld } from "./buffer-edit-hold";
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
const STAGING_RECONCILE_ATTEMPTS = 3;
const STAGING_RECONCILE_DELAYS_MS = [0, 25, 100] as const;
const store = createMailboxStore(db);
const pending = ["queued", "failed"] as const;

export interface BufferReadOptions {
	signal?: AbortSignal;
	deadlineAt?: number;
	timeoutMs?: number;
}
function bufferReadOptions(options: BufferReadOptions = {}) {
	return {
		executionPolicy: "worker-required" as const,
		signal: options.signal,
		deadlineAt: options.deadlineAt,
		timeoutMs: Math.min(options.timeoutMs ?? 30_000, 30_000),
	};
}
type BufferTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type BufferObservation = Pick<
	RuntimeMailboxRow,
	| "id"
	| "narratorId"
	| "kind"
	| "state"
	| "deliveryId"
	| "contentRevision"
	| "metadataJson"
	| "textFilePathsJson"
>;
function assertBufferObservation(tx: BufferTx, row: BufferObservation | undefined, id: string) {
	const current = tx
		.select({
			id: mailbox.id,
			narratorId: mailbox.narratorId,
			kind: mailbox.kind,
			state: mailbox.state,
			deliveryId: mailbox.deliveryId,
			contentRevision: mailbox.contentRevision,
			metadataJson: mailbox.metadataJson,
			textFilePathsJson: mailbox.textFilePathsJson,
		})
		.from(mailbox)
		.where(eq(mailbox.id, id))
		.get();
	const fields = [
		"id",
		"narratorId",
		"kind",
		"state",
		"deliveryId",
		"contentRevision",
		"metadataJson",
		"textFilePathsJson",
	] as const;
	if (fields.some((key) => current?.[key] !== row?.[key])) throw new RuntimeReadConflictError();
}

/** Runtime callers can carry extra fields; only portable references enter the queue. */
function copyMediaRef(item: MediaRef, fallbackNarratorId?: string): MediaRef {
	const uploadNarratorId = item.uploadNarratorId || fallbackNarratorId;
	return {
		mediaId: item.mediaId,
		filename: item.filename,
		mediaType: item.mediaType,
		size: item.size,
		...(uploadNarratorId ? { uploadNarratorId } : {}),
	};
}

type StagingAwareMailbox = RuntimeQueuePort["mailbox"] & RuntimeMailboxStagingLookup;
type StagingResolution =
	| { kind: "owned"; row: RuntimeMailboxRow }
	| { kind: "absent" }
	| { kind: "unknown" };

/** The bound PostgreSQL queue port, or undefined on SQLite. Throws on explicit-PG-unbound. */
function pgQueue(): RuntimeQueuePort | undefined {
	return getRuntimeQueuePort();
}
/**
 * Synchronous staging/ownership reads have no PG read port in this stage. Under
 * PostgreSQL they fail closed with an explicit error — never a silent empty result.
 */
function assertSqliteBufferRead(operation: string): void {
	if (getRuntimeQueuePort())
		throw new Error(
			`narrator-buffer.${operation}: PostgreSQL staging read path is not wired in this stage; ` +
				"refusing to silently return an empty result",
		);
}
async function rowByIdRuntime(id: string): Promise<RuntimeMailboxRow | undefined> {
	const port = pgQueue();
	if (port) return port.mailbox.getById(id);
	return rowById(id);
}
/** Drop a staging directory that was never accepted into the mailbox (no ownership row exists). */
function discardUnownedStaging(stagingId: string): void {
	const path = stagingPath(stagingId);
	if (ownedPath(path)) rmSync(path, { recursive: true, force: true });
}
/** PG mirror of cleanupBufferedTextFiles: same ownership checks through the queue port. */
async function cleanupStagingPg(port: RuntimeQueuePort, id: string): Promise<void> {
	const row = await port.mailbox.getById(id);
	const stagingId = row
		? (json<{ stagingId?: string }>(row.metadataJson, {}).stagingId ?? row.id)
		: id;
	if (!stagingId) return;
	const path = stagingPath(stagingId);
	if (!ownedPath(path)) return;
	const marker = join(path, STAGING_OWNER_FILE);
	let ownerId: string | null = row?.id ?? stagingId;
	let stagingPending = false;
	if (!existsSync(marker) && (!row || row.kind !== "user_input")) return;
	if (existsSync(marker)) {
		if (!ownedPath(marker) || statSync(marker).size > 1024) return;
		try {
			const markerOwner = JSON.parse(readFileSync(marker, "utf8")).rowId;
			if (markerOwner === null) stagingPending = true;
			else ownerId = markerOwner ?? ownerId;
		} catch {
			return;
		}
		if (ownerId !== null && typeof ownerId !== "string") return;
	}
	// A null marker is the crash-safe pre-admission state. It is retained until the
	// producer has a successful DB answer; a DB row remains the ownership authority.
	if (stagingPending && !row) return;
	const owner = ownerId ? await port.mailbox.getById(ownerId) : undefined;
	if (owner && ["queued", "claimed", "failed"].includes(owner.state)) return;
	rmSync(path, { recursive: true, force: true });
}

async function resolveStagingOwner(
	port: RuntimeQueuePort,
	narratorId: string,
	stagingId: string,
	knownOwnerId?: string,
): Promise<StagingResolution> {
	const mailbox = port.mailbox as StagingAwareMailbox;
	try {
		if (knownOwnerId) {
			const row = await mailbox.getById(knownOwnerId);
			if (row) return { kind: "owned", row };
			// A stale/lost owner id is not proof that the admission rolled back. Fall
			// through to the staging ownership probe before declaring an orphan.
		}
		const row = await mailbox.getByStagingId(narratorId, stagingId);
		return row ? { kind: "owned", row } : { kind: "absent" };
	} catch {
		return { kind: "unknown" };
	}
}

/**
 * Reconcile a null-owner staging directory after an admission acknowledgement was lost.
 * A successful DB lookup is authoritative; lookup failure is deliberately retryable and
 * never treated as proof that the mailbox row is absent.
 */
export async function reconcileBufferedStaging(
	narratorId: string,
	stagingId: string,
	knownOwnerId?: string,
): Promise<"removed" | "owned" | "unknown"> {
	const port = pgQueue();
	if (!port) {
		discardUnownedStaging(stagingId);
		return "removed";
	}
	for (let attempt = 0; attempt < STAGING_RECONCILE_ATTEMPTS; attempt++) {
		const delay = STAGING_RECONCILE_DELAYS_MS[attempt];
		if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
		const resolution = await resolveStagingOwner(port, narratorId, stagingId, knownOwnerId);
		if (resolution.kind === "owned") {
			try {
				if (existsSync(stagingPath(stagingId)))
					writeStagingOwnerMarker(stagingId, resolution.row.id);
				await cleanupStagingPg(port, resolution.row.id);
				return "owned";
			} catch {
				// Marker/cleanup I/O can fail independently of the DB read. Retry the
				// bounded reconciliation instead of deleting or losing ownership.
				continue;
			}
		}
		if (resolution.kind === "absent") {
			discardUnownedStaging(stagingId);
			return "removed";
		}
	}
	// Unknown is intentionally retained with rowId:null. A later explicit cleanup or
	// reconciliation can repeat the same DB-aware lookup without risking a committed payload.
	return "unknown";
}
// These are unaccepted preparation permits, never a second message authority.
let activePreparations = 0;
const preparationWaiters: Array<() => void> = [];
const pendingBufferedPreparations = new Set<Promise<unknown>>();
const bufferedPreparationScope = new AsyncLocalStorage<{ pending: number }>();
const acceptedPreparationScopes = new Set<{ pending: number }>();
let bufferedPreparationFailures = 0;
let firstBufferedPreparationFailure: unknown;
let bufferedPreparationAdmissionClosed = false;

function trackBufferedPreparation<T>(
	work: Promise<T>,
	scope = bufferedPreparationScope.getStore(),
): Promise<T> {
	if (scope) scope.pending++;
	pendingBufferedPreparations.add(work);
	const settled = () => {
		pendingBufferedPreparations.delete(work);
		if (scope && --scope.pending === 0) acceptedPreparationScopes.delete(scope);
	};
	void work.then(settled, (error) => {
		if (bufferedPreparationAdmissionClosed) {
			bufferedPreparationFailures++;
			firstBufferedPreparationFailure ??= error;
		}
		settled();
	});
	return work;
}

function withBufferedPreparationAdmission<T>(work: () => Promise<T>): Promise<T> {
	const inherited = bufferedPreparationScope.getStore();
	if (bufferedPreparationAdmissionClosed && !inherited?.pending)
		return Promise.reject(new Error("Buffered file preparation admission is closed"));
	if (
		!inherited?.pending &&
		acceptedPreparationScopes.size >= MAILBOX_LIMITS.prepareConcurrency + MAILBOX_LIMITS.userPending
	)
		return Promise.reject(new Error("Buffered preparation is full"));
	const scope = inherited?.pending ? inherited : { pending: 0 };
	acceptedPreparationScopes.add(scope);
	return trackBufferedPreparation(
		bufferedPreparationScope.run(scope, () => Promise.resolve().then(work)),
		scope,
	);
}

function trackBufferedCleanup<T>(work: () => Promise<T>): Promise<T> {
	return trackBufferedPreparation(Promise.resolve().then(work));
}

export function getBufferedFilePreparationStatus() {
	return {
		pending: pendingBufferedPreparations.size,
		active: activePreparations,
		waiting: preparationWaiters.length,
		batches: acceptedPreparationScopes.size,
		failed: bufferedPreparationFailures,
	};
}
export function stopBufferedFilePreparations(): void {
	bufferedPreparationAdmissionClosed = true;
}
export function hasPendingBufferedFilePreparations(): boolean {
	return (
		pendingBufferedPreparations.size > 0 || activePreparations > 0 || preparationWaiters.length > 0
	);
}
export async function drainBufferedFilePreparations(options: {
	deadlineAt: number;
	signal?: AbortSignal;
}): Promise<void> {
	options.signal?.throwIfAborted();
	while (hasPendingBufferedFilePreparations()) {
		options.signal?.throwIfAborted();
		const remaining = options.deadlineAt - Date.now();
		if (remaining <= 0) throw new Error("Buffered preparation drain deadline expired");
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			await Promise.race([
				Promise.allSettled([...pendingBufferedPreparations]),
				new Promise<never>((_, reject) => {
					onAbort = () =>
						reject(options.signal?.reason ?? new Error("Buffered preparation drain aborted"));
					options.signal?.addEventListener("abort", onAbort, { once: true });
					timer = setTimeout(
						() => reject(new Error("Buffered preparation drain deadline expired")),
						remaining,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
			if (onAbort) options.signal?.removeEventListener("abort", onAbort);
		}
	}
	options.signal?.throwIfAborted();
	if (bufferedPreparationFailures)
		throw new Error("Buffered preparation failed", { cause: firstBufferedPreparationFailure });
}
async function acquirePreparation(): Promise<() => void> {
	if (bufferedPreparationAdmissionClosed && !bufferedPreparationScope.getStore()?.pending)
		throw new Error("Buffered file preparation admission is closed");
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
/**
 * Slowest write throughput the preparation budget will wait for.
 *
 * `MAILBOX_LIMITS.prepareTimeoutMs` (30 s) was sized for the inline payloads
 * this used to carry — the REST text cap is 100k UTF-16 units. Attachments are
 * now streamed to disk and may be a gigabyte, where a slow-but-healthy disk
 * legitimately needs longer than 30 s; expiring mid-write deletes the copy and
 * fails an otherwise valid queued message. The budget therefore scales with the
 * payload and never drops below the original value.
 */
const PREPARE_MIN_THROUGHPUT_BYTES_PER_SEC = 10 * 1024 * 1024;

function preparationTimeoutMs(value: File | string): number {
	const bytes = typeof value === "string" ? Buffer.byteLength(value) : value.size;
	const scaled = Math.ceil((bytes / PREPARE_MIN_THROUGHPUT_BYTES_PER_SEC) * 1000);
	return Math.max(MAILBOX_LIMITS.prepareTimeoutMs, scaled);
}

async function writeBufferedFile(path: string, value: File | string): Promise<void> {
	const release = await acquirePreparation();
	const budgetMs = preparationTimeoutMs(value);
	const started = Date.now();
	let expired = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const write = Promise.resolve()
		.then(() => Bun.write(path, value))
		.finally(async () => {
			release();
			if (expired) {
				await deleteBufferedTextFile({ filename: basename(path), path, size: 0 });
				await cleanupBufferedTextFiles(basename(dirname(path)));
			}
		});
	trackBufferedPreparation(write);
	try {
		await Promise.race([
			write,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					expired = true;
					reject(new Error("Buffered file preparation timed out"));
				}, budgetMs);
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
function rowById(id: string, options?: BufferReadOptions): Promise<MailboxRow | undefined> {
	return readQueryFirst(
		db.select().from(mailbox).where(eq(mailbox.id, id)).limit(1),
		bufferReadOptions(options),
	);
}
function stagingOwnerById(id: string): Promise<BufferObservation | undefined> {
	return readQueryFirst(
		db
			.select({
				id: mailbox.id,
				narratorId: mailbox.narratorId,
				kind: mailbox.kind,
				state: mailbox.state,
				deliveryId: mailbox.deliveryId,
				contentRevision: mailbox.contentRevision,
				metadataJson: mailbox.metadataJson,
				textFilePathsJson: mailbox.textFilePathsJson,
			})
			.from(mailbox)
			.where(eq(mailbox.id, id))
			.limit(1),
		bufferReadOptions(),
	);
}
function writeStagingOwnerMarker(stagingId: string, rowId: string | null): void {
	const dir = stagingPath(stagingId);
	if (!ownedPath(dir)) throw new Error("Invalid buffered staging path");
	const marker = join(dir, STAGING_OWNER_FILE);
	const temporary = join(dir, `${STAGING_OWNER_FILE}.${generateShortId()}.tmp`);
	writeFileSync(temporary, JSON.stringify({ rowId }), { encoding: "utf8", mode: 0o600 });
	try {
		renameSync(temporary, marker);
	} catch (error) {
		if (ownedPath(temporary)) rmSync(temporary, { force: true });
		throw error;
	}
}
function ensureStagingDirectory(id: string): string {
	const dir = stagingPath(id);
	mkdirSync(dir, { recursive: true });
	if (!ownedPath(dir)) throw new Error("Invalid buffered staging path");
	const marker = join(dir, STAGING_OWNER_FILE);
	if (!existsSync(marker)) writeStagingOwnerMarker(id, null);
	return dir;
}
interface StagingMetadata {
	humanReplyContext?: import("@shared/reply-context").ReplyContext;
	composerDocumentPath?: string;
	queueMode?: BufferQueueMode;
	executionIntent?: BufferedMessage["executionIntent"];
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
function writeStagingText(id: string, prefix: string, text: string): Promise<string> {
	return withBufferedPreparationAdmission(() => writeStagingTextUntracked(id, prefix, text));
}

async function writeStagingTextUntracked(
	id: string,
	prefix: string,
	text: string,
): Promise<string> {
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
/**
 * Drop staged upload originals once a committed mailbox row owns its copies.
 *
 * Best effort: a failed delete only leaves bytes the TTL sweep reclaims, and must
 * never turn an accepted message into a reported failure. No-op for multipart
 * files, which never entered the staging area.
 */
export function releaseStagedFiles(files: readonly File[] | undefined): void {
	for (const file of files ?? []) {
		try {
			releaseStagedAttachment(file);
		} catch (error) {
			logger.warn("Failed to release staged attachment", { error: String(error) });
		}
	}
}

/** Save attachments once; both primary and subagent producers use this durable representation. */
export function persistBufferedTextFiles(
	...args: Parameters<typeof persistBufferedTextFilesUntracked>
): ReturnType<typeof persistBufferedTextFilesUntracked> {
	return withBufferedPreparationAdmission(() => persistBufferedTextFilesUntracked(...args));
}

async function persistBufferedTextFilesUntracked(
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
			saved.push({
				filename: name,
				path,
				size: file.size,
				originalName: file.name,
				sourceMimeType: file.type,
			});
			await writeBufferedFile(path, file);
			// Deliberately NOT releasing the staged original here: this copy only
			// becomes the message's attachment once the mailbox row commits. Callers
			// release after their commit (see `releaseStagedFiles`), so a full queue
			// or a DB error still leaves the upload claimable on retry.
		}
		return saved;
	} catch (error) {
		for (const file of saved) await deleteBufferedTextFile(file);
		throw error;
	}
}
/** Only clean a known, unreferenced mailbox staging directory, never uploads/history. */
export function cleanupBufferedTextFiles(id: string): Promise<void> {
	return trackBufferedCleanup(async () => {
		assertSqliteBufferRead("cleanupBufferedTextFiles");
		const row = await stagingOwnerById(id);
		await cleanupObservedBufferedTextFiles(id, row);
	});
}
async function cleanupObservedBufferedTextFiles(
	id: string,
	row: BufferObservation | undefined,
): Promise<void> {
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
	let stagingPending = false;
	if (!existsSync(marker) && (!row || row.kind !== "user_input")) return;
	if (existsSync(marker)) {
		if (!ownedPath(marker) || statSync(marker).size > 1024) return;
		try {
			const markerOwner = JSON.parse(readFileSync(marker, "utf8")).rowId;
			if (markerOwner === null) stagingPending = true;
			else if (typeof markerOwner === "string" && markerOwner) ownerId = markerOwner;
			else return;
		} catch {
			return;
		}
	}
	// A null marker without a row-id match is unknown ownership, not an orphan.
	if (stagingPending && !row) return;
	const owner = ownerId === id ? row : ownerId ? await stagingOwnerById(ownerId) : undefined;
	if (owner && ["queued", "claimed", "failed"].includes(owner.state)) return;
	db.transaction((tx) => {
		assertBufferObservation(tx, row, id);
		if (ownerId) assertBufferObservation(tx, owner, ownerId);
		rmSync(path, { recursive: true, force: true });
	});
}
/** Backend-neutral asynchronous cleanup used after mailbox consumption. */
export function cleanupBufferedTextFilesAsync(id: string): Promise<void> {
	return trackBufferedCleanup(() => cleanupBufferedTextFilesUntracked(id));
}

async function cleanupBufferedTextFilesUntracked(id: string): Promise<void> {
	const port = pgQueue();
	if (port) {
		await cleanupStagingPg(port, id);
		return;
	}
	await cleanupBufferedTextFiles(id);
}
export async function persistAdditionalBufferedTextFiles(
	messageId: string,
	files: File[],
	reserved: Iterable<string>,
): Promise<SavedBufferedFile[]> {
	assertSqliteBufferRead("persistAdditionalBufferedTextFiles");
	const row = await rowById(messageId);
	if (!row || row.kind !== "user_input" || !pending.includes(row.state as "queued" | "failed"))
		throw new Error("Buffered message is no longer editable");
	const id = json<{ stagingId?: string }>(row.metadataJson, {}).stagingId ?? row.id;
	if (files.length) {
		db.transaction((tx) => {
			assertBufferObservation(tx, row, row.id);
			mkdirSync(stagingPath(id), { recursive: true });
			writeStagingOwnerMarker(id, row.id);
		});
	}
	return persistBufferedTextFiles(id, files, reserved);
}
export function deleteBufferedTextFile(saved: SavedBufferedFile): Promise<void> {
	return trackBufferedCleanup(async () => {
		assertSqliteBufferRead("deleteBufferedTextFile");
		if (!ownedPath(saved.path)) return;
		const marker = join(dirname(saved.path), STAGING_OWNER_FILE);
		let ownerId: string | null = basename(dirname(saved.path));
		if (!existsSync(marker) && !(await stagingOwnerById(ownerId))) return;
		if (existsSync(marker)) {
			if (!ownedPath(marker) || statSync(marker).size > 1024) return;
			try {
				ownerId = JSON.parse(readFileSync(marker, "utf8")).rowId ?? ownerId;
			} catch {
				return;
			}
			if (ownerId !== null && typeof ownerId !== "string") return;
		}
		const owner = ownerId ? await stagingOwnerById(ownerId) : undefined;
		if (
			owner &&
			json<SavedBufferedFile[]>(owner.textFilePathsJson, []).some(
				(file) => resolve(file.path) === resolve(saved.path),
			)
		)
			return;
		db.transaction((tx) => {
			if (ownerId) assertBufferObservation(tx, owner, ownerId);
			rmSync(saved.path, { force: true });
		});
	});
}
export function loadBufferedTextFiles(saved: SavedBufferedFile[]): File[] {
	return saved.flatMap((s) => {
		if (!existsSync(s.path)) return [];
		if (statSync(s.path).size > MAX_TEXT_FILE_SIZE)
			throw new Error("Buffered attachment exceeds size limit");
		// Bun's file-backed Blob retains the path instead of synchronously loading a
		// potentially 100MB attachment into the request/event-loop heap.
		return [
			new File([Bun.file(s.path)], s.originalName ?? s.filename, {
				type: s.sourceMimeType ?? "text/plain",
			}),
		];
	});
}
/** These inputs must cross the old loop's finalizer (including temporary-model restore). */
export function mailboxInputRequiresFreshTurn(
	row: Pick<RuntimeMailboxRow, "metadataJson">,
): boolean {
	const intent = json<StagingMetadata>(row.metadataJson, {}).executionIntent;
	return !!(intent?.modelOverride || intent?.controlCommand);
}

export function projectMailboxUserMessage(row: RuntimeMailboxRow): BufferedMessage {
	if (row.kind !== "user_input") throw new Error("Expected user mailbox input");
	const saved = json<SavedBufferedFile[]>(row.textFilePathsJson, []);
	const payload = json<{ path: string } | null>(row.payloadRefJson, null);
	const metadata = json<StagingMetadata>(row.metadataJson, {});
	return {
		executionIntent: metadata.executionIntent,
		queueMode: resolveBufferQueueMode(metadata.queueMode, row.priority),
		id: row.id,
		state: row.state === "failed" ? "failed" : "queued",
		error: row.lastError,
		get text() {
			return payload ? readManagedText(payload.path) : row.text;
		},
		hasComposerDocument: !!metadata.composerDocumentPath,
		get composerDocument() {
			return metadata.composerDocumentPath
				? parseOptionalComposerDocument(
						JSON.parse(readManagedText(metadata.composerDocumentPath, 2 * 1024 * 1024)),
					)
				: undefined;
		},
		images: json<ImageRef[] | undefined>(row.imagesJson, undefined),
		media: json<MediaRef[] | undefined>(row.mediaJson, undefined)?.map((item) =>
			copyMediaRef(item, row.narratorId),
		),
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
export function getBufferedMessages(
	narratorId: string,
	options?: BufferReadOptions,
): Promise<BufferedMessage[]> {
	return getBufferedMessagesAsync(narratorId, options);
}

/** The callback must not suspend between validation and its dependent decision. */
export async function withCurrentBufferedGuidance<T extends boolean | undefined>(
	narratorId: string,
	apply: (pending: boolean) => T,
): Promise<T> {
	if (isBufferConsumptionHeld(narratorId)) return apply(false);
	assertSqliteBufferRead("withCurrentBufferedGuidance");
	const columns = {
		id: mailbox.id,
		state: mailbox.state,
		revision: mailbox.contentRevision,
		priority: mailbox.priority,
		seq: mailbox.seq,
		arrivalSeq: mailbox.arrivalSeq,
		metadataJson: mailbox.metadataJson,
	};
	const filter = and(
		eq(mailbox.narratorId, narratorId),
		eq(mailbox.kind, "user_input"),
		inArray(mailbox.state, pending),
	);
	const rows = await readQuery(
		db
			.select(columns)
			.from(mailbox)
			.where(filter)
			.orderBy(desc(mailbox.priority), asc(mailbox.seq), asc(mailbox.arrivalSeq))
			.limit(MAILBOX_LIMITS.userPending),
		bufferReadOptions(),
	);
	const hasGuidance = (snapshot: typeof rows) =>
		snapshot.some(
			(row) =>
				row.state !== "failed" &&
				resolveBufferQueueMode(
					json<{ queueMode?: BufferQueueMode }>(row.metadataJson, {}).queueMode,
					row.priority,
				) !== "turn",
		);
	const pendingGuidance = hasGuidance(rows);
	return db.transaction((tx) => {
		const current = tx
			.select(columns)
			.from(mailbox)
			.where(filter)
			.orderBy(desc(mailbox.priority), asc(mailbox.seq), asc(mailbox.arrivalSeq))
			.limit(MAILBOX_LIMITS.userPending)
			.all();
		if (hasGuidance(current) !== pendingGuidance) throw new RuntimeReadConflictError();
		return apply(!isBufferConsumptionHeld(narratorId) && pendingGuidance);
	});
}

/** Public user identity only; never read credentials or infer an author from a narrator owner. */
async function loadBufferCreators(
	createdBy: readonly string[],
	options?: BufferReadOptions,
): Promise<BufferCreator[]> {
	const ids = [...new Set(createdBy)].slice(0, MAILBOX_LIMITS.userPending);
	if (!ids.length) return [];
	const { postgresRuntime } = await import("../db");
	if (postgresRuntime) {
		return await postgresRuntime.client.db
			.select({
				id: pgUsers.id,
				username: pgUsers.username,
				avatarColor: pgUsers.avatarColor,
				avatarImageId: pgUsers.avatarImageId,
			})
			.from(pgUsers)
			.where(inArray(pgUsers.id, ids))
			.limit(ids.length);
	}
	return readQuery(
		db
			.select({
				id: users.id,
				username: users.username,
				avatarColor: users.avatarColor,
				avatarImageId: users.avatarImageId,
			})
			.from(users)
			.where(inArray(users.id, ids))
			.limit(ids.length),
		bufferReadOptions(options),
	);
}

export async function getBufferedMessagesAsync(
	narratorId: string,
	options?: BufferReadOptions,
): Promise<BufferedMessage[]> {
	const port = pgQueue();
	const rows = port
		? await port.mailbox.listPending(narratorId, {
				kinds: ["user_input"],
				includeFailed: true,
				limit: MAILBOX_LIMITS.userPending,
			})
		: await readQuery(
				db
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
					.limit(MAILBOX_LIMITS.userPending),
				bufferReadOptions(options),
			);
	const messages = rows.map(projectMailboxUserMessage);
	const missingAuthors = messages.flatMap((message) =>
		!message.creator && message.createdBy ? [message.createdBy] : [],
	);
	const creators = new Map(
		(await loadBufferCreators(missingAuthors, options)).map((creator) => [creator.id, creator]),
	);
	for (const message of messages) {
		if (!message.creator && message.createdBy)
			message.creator = creators.get(message.createdBy) ?? null;
	}
	return messages;
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
	executionIntent?: BufferedMessage["executionIntent"],
	queueMode?: BufferQueueMode,
	composerDocument?: ComposerDocument,
	media?: MediaRef[],
	humanReplyContext?: import("@shared/reply-context").ReplyContext,
): Promise<{ ok: boolean; bufferedAt: string; id: string; full?: boolean }> {
	humanReplyContext = humanReplyContext ? { ...humanReplyContext } : undefined;
	composerDocument = parseOptionalComposerDocument(composerDocument);
	validateComposerProjection(
		composerDocument,
		text,
		(fileReferences ?? []).map((snapshot) => snapshot.reference),
	);
	validateComposerAssets(composerDocument, images ?? [], textFiles ?? [], media ?? []);
	const stagingId = generateShortId();
	const refs = freezeFileReferenceSnapshots(fileReferences);
	images = images?.map((image) => ({ ...image }));
	media = media?.map((item) => copyMediaRef(item, narratorId));
	creator = creator ? { ...creator } : creator;
	textFiles = textFiles ? [...textFiles] : undefined;
	let saved: SavedBufferedFile[] = [];
	let admissionStarted = false;
	let port: RuntimeQueuePort | undefined;
	let admittedOwnerId: string | undefined;
	try {
		if (!creator && createdBy) creator = (await loadBufferCreators([createdBy]))[0] ?? null;
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
		const metadata: StagingMetadata = { stagingId, executionIntent, queueMode, humanReplyContext };
		if (composerDocument)
			metadata.composerDocumentPath = await writeStagingText(
				stagingId,
				"composer",
				JSON.stringify(composerDocument),
			);
		if (queueMode) frontOrder = queueMode === "interrupt" ? "stack" : "fifo";
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
		port = pgQueue();
		const input = {
			narratorId,
			kind: "user_input" as const,
			text: payloadRef ? "" : text,
			projectedByteSize: bytes,
			payloadRef,
			metadata: { ...metadata },
			createdBy,
			commandText,
			bashCommand,
			imagesJson: images?.length ? JSON.stringify(images) : null,
			mediaJson: media?.length ? JSON.stringify(media) : null,
			creatorJson: creator ? JSON.stringify(creator) : null,
			textFilePathsJson: saved.length ? JSON.stringify(saved) : null,
			fileReferencesJson,
		};
		// PostgreSQL: ONE named admission (seq computation + optional FIFO reorder + insert)
		// commits atomically in the adapter. SQLite: the original synchronous segment below.
		admissionStarted = true;
		const result = port
			? await port.mailbox.admitUserBuffered(input, { position, frontOrder })
			: db.transaction((tx) => {
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
							...input,
							priority: position === "front",
							seq,
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
						writeStagingOwnerMarker(stagingId, accepted.delivery.id);
					}
					return accepted;
				});
		if (port && result.status === "accepted") {
			admittedOwnerId = result.delivery.id;
			if (existsSync(stagingPath(stagingId))) {
				// Post-commit staging ownership marker (the SQLite path writes it inside the tx).
				writeStagingOwnerMarker(stagingId, result.delivery.id);
			}
		}
		if (result.status !== "accepted" && result.status !== "duplicate") {
			discardUnownedStaging(stagingId);
			return { ok: false, bufferedAt: "", id: "", full: true };
		}
		// The mailbox row now owns its own copy, so the staged originals can go.
		releaseStagedFiles(textFiles);
		return { ok: true, bufferedAt: result.delivery.bufferedAt, id: result.delivery.id };
	} catch (error) {
		if (!admissionStarted) {
			discardUnownedStaging(stagingId);
		} else if (port) {
			// The transaction may have rolled back, committed with a lost confirmation, or
			// committed before the marker write failed. Reconcile against DB authority; an
			// unknown read keeps the null marker and never guesses that the row is absent.
			try {
				await reconcileBufferedStaging(narratorId, stagingId, admittedOwnerId);
			} catch (reconcileError) {
				logger.warn("Buffered staging reconciliation deferred", {
					narratorId,
					stagingId,
					error: String(reconcileError),
				});
			}
		} else {
			// SQLite writes the marker inside the same transaction, so an admission error
			// proves that no mailbox row committed.
			discardUnownedStaging(stagingId);
		}
		throw error;
	}
}
export interface BufferedMessageAttachmentUpdate {
	signal?: AbortSignal;
	composerDocument?: ComposerDocument;
	images?: ImageRef[];
	media?: MediaRef[];
	textFiles?: File[];
	savedFiles?: SavedBufferedFile[];
	fileReferences?: FileReferenceSnapshot[];
}
export async function beginBufferedMessageEdit(
	narratorId: string,
	messageId: string,
	userId: string,
	token: string,
) {
	return bufferEditHolds.begin(narratorId, { messageId, userId, token }, () =>
		canEditBufferedMessage(narratorId, messageId),
	);
}
export async function canEditBufferedMessage(
	narratorId: string,
	messageId: string,
): Promise<boolean> {
	const row = await rowByIdRuntime(messageId);
	return (
		!!row &&
		row.narratorId === narratorId &&
		row.kind === "user_input" &&
		pending.includes(row.state as "queued" | "failed")
	);
}

export function updateBufferedMessage(
	narratorId: string,
	messageId: string,
	text: string,
	opts: BufferedMessageAttachmentUpdate = {},
): Promise<boolean> {
	return bufferEditHolds.mutate(narratorId, messageId, () =>
		updateBufferedMessageUnlocked(narratorId, messageId, text, opts),
	);
}
async function updateBufferedMessageUnlocked(
	narratorId: string,
	messageId: string,
	text: string,
	opts: BufferedMessageAttachmentUpdate = {},
): Promise<boolean> {
	const port = pgQueue();
	const row = port ? await port.mailbox.getById(messageId) : await rowById(messageId);
	if (
		!row ||
		row.narratorId !== narratorId ||
		row.kind !== "user_input" ||
		!pending.includes(row.state as "queued" | "failed")
	)
		return false;
	const current = projectMailboxUserMessage(row);
	opts.composerDocument = parseOptionalComposerDocument(opts.composerDocument);
	validateComposerProjection(
		opts.composerDocument,
		text,
		(opts.fileReferences ?? current.fileReferences ?? []).map((snapshot) => snapshot.reference),
	);
	validateComposerAssets(
		opts.composerDocument,
		opts.images ?? current.images ?? [],
		opts.textFiles ??
			(opts.savedFiles ? loadBufferedTextFiles(opts.savedFiles) : current.textFiles) ??
			[],
		opts.media ?? current.media ?? [],
	);
	const bytes = Buffer.byteLength(text);
	if (bytes > MAX_BUFFERED_PAYLOAD_BYTES)
		throw new Error("Edited input exceeds mailbox size limit");
	// Snapshot caller-owned arrays before the first asynchronous file write.
	opts = {
		...opts,
		images: opts.images?.map((image) => ({ ...image })),
		media: opts.media?.map((item) => copyMediaRef(item, narratorId)),
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
		if (metadata.composerDocumentPath) superseded.push(metadata.composerDocumentPath);
		delete metadata.composerDocumentPath;
		if (opts.composerDocument) {
			metadata.composerDocumentPath = await writeStagingText(
				stagingId,
				"composer",
				JSON.stringify(opts.composerDocument),
			);
			prepared.push(metadata.composerDocumentPath);
		}
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
		const mediaJson =
			opts.media === undefined
				? row.mediaJson
				: opts.media.length
					? JSON.stringify(opts.media)
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
				mediaJson,
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
		opts.signal?.throwIfAborted();
		bufferEditHolds.mutationSignal()?.throwIfAborted();
		const ok = port
			? await port.mailbox.updateUserBuffered(
					messageId,
					narratorId,
					{
						text: payloadRefJson ? "" : text,
						byteSize: bytes,
						payloadRefJson,
						imagesJson,
						mediaJson,
						textFilePathsJson,
						fileReferencesJson,
						metadataJson,
					},
					row.contentRevision,
				)
			: db.transaction((tx) => {
					assertBufferObservation(tx, row, messageId);
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
								mediaJson,
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
					if (changed && prepared.length) writeStagingOwnerMarker(stagingId, row.id);
					return changed;
				});
		if (ok && port && prepared.length)
			writeFileSync(
				join(stagingPath(stagingId), STAGING_OWNER_FILE),
				JSON.stringify({ rowId: row.id }),
			);
		if (!ok) {
			throw new RuntimeReadConflictError();
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
export function removeBufferedMessage(narratorId: string, messageId: string): Promise<boolean> {
	return bufferEditHolds.mutate(narratorId, messageId, () =>
		removeBufferedMessageUnlocked(narratorId, messageId),
	);
}
async function removeBufferedMessageUnlocked(
	narratorId: string,
	messageId: string,
): Promise<boolean> {
	const port = pgQueue();
	if (port) {
		await port.mailbox.initializeLegacy(narratorId);
		const row = await port.mailbox.getById(messageId);
		if (!row || row.narratorId !== narratorId || row.kind !== "user_input" || !row.deliveryId)
			return false;
		if (!(await port.mailbox.cancel(row.deliveryId, "Removed by user"))) return false;
		await cleanupStagingPg(
			port,
			json<{ stagingId?: string }>(row.metadataJson, {}).stagingId ?? row.id,
		);
		return true;
	}
	store.initializeLegacy(narratorId);
	const row = await rowById(messageId);
	if (!row || row.narratorId !== narratorId || row.kind !== "user_input" || !row.deliveryId)
		return false;
	const id = json<{ stagingId?: string }>(row.metadataJson, {}).stagingId ?? row.id;
	const deliveryId = row.deliveryId;
	const cancelled = db.transaction((tx) => {
		assertBufferObservation(tx, row, row.id);
		return store.cancel(deliveryId, "Removed by user");
	});
	if (!cancelled) return false;
	await cleanupBufferedTextFiles(id);
	return true;
}
export const BUFFER_INTERRUPT_DELIVERY_TIMEOUT_MS = 5_000;

export async function readBufferedMessageDeliveryReceipt(
	narratorId: string,
	messageId: string,
	options?: BufferReadOptions,
): Promise<RuntimeBufferedDeliveryReceipt | undefined> {
	const port = pgQueue();
	if (port) return port.mailbox.readUserBufferedDeliveryReceipt(narratorId, messageId);
	return readQueryFirst(
		db
			.select({
				id: mailbox.id,
				state: mailbox.state,
				recipientMessageId: mailbox.recipientMessageId,
				lastError: mailbox.lastError,
			})
			.from(mailbox)
			.where(
				and(
					eq(mailbox.id, messageId),
					eq(mailbox.narratorId, narratorId),
					eq(mailbox.kind, "user_input"),
				),
			)
			.limit(1),
		bufferReadOptions(options),
	);
}

/** Wait OUTSIDE mutation admission. A busy wake is not a delivery acknowledgement. */
export async function waitForBufferedMessageDelivery(
	narratorId: string,
	messageId: string,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		wake?: () => Promise<boolean>;
	} = {},
): Promise<{ delivered: true; messageId: string }> {
	const startedAt = Date.now();
	const timeoutMs = options.timeoutMs ?? BUFFER_INTERRUPT_DELIVERY_TIMEOUT_MS;
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), timeoutMs);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout.signal])
		: timeout.signal;
	const cancellation = () =>
		options.signal?.aborted
			? new AppError(
					"Interrupted input delivery wait cancelled; durable input retained",
					499,
					"BUFFER_DELIVERY_CANCELLED",
				)
			: new AppError(
					"Interrupted input has not been delivered within the deadline; durable input retained",
					504,
					"BUFFER_DELIVERY_TIMEOUT",
				);
	async function bounded<T>(operation: Promise<T>): Promise<T> {
		if (signal.aborted) throw cancellation();
		return new Promise<T>((resolve, reject) => {
			const abort = () => reject(cancellation());
			signal.addEventListener("abort", abort, { once: true });
			operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		});
	}
	try {
		const wake =
			options.wake ??
			(async () => {
				const { wakeInboxIfEligible } = await import("./agent-runtime/inbox");
				return wakeInboxIfEligible(narratorId);
			});
		while (true) {
			if (signal.aborted) throw cancellation();
			const receipt = await bounded(
				readBufferedMessageDeliveryReceipt(narratorId, messageId, {
					signal,
					deadlineAt: startedAt + timeoutMs,
				}),
			);
			if (!receipt)
				throw new AppError("Buffered input no longer exists", 409, "BUFFER_DELIVERY_MISSING");
			if (receipt.state === "materialized" && receipt.recipientMessageId) {
				return { delivered: true, messageId: receipt.recipientMessageId };
			}
			if (receipt.state === "failed") {
				throw new AppError(
					"Interrupted input delivery failed; explicit retry required",
					409,
					"BUFFER_DELIVERY_FAILED",
				);
			}
			if (receipt.state === "cancelled") {
				throw new AppError("Buffered input was cancelled", 409, "BUFFER_DELIVERY_CANCELLED");
			}
			// Never cancel again: a newer owner may already be consuming this exact input.
			await bounded(wake());
			await bounded(new Promise<void>((resolve) => setTimeout(resolve, 25)));
		}
	} catch (error) {
		if (error instanceof AppError && error.code === "BUFFER_DELIVERY_TIMEOUT") {
			logger.warn("Urgent buffered input delivery confirmation timed out; retained for retry", {
				narratorId,
				messageId,
				timeoutMs,
				durationMs: Date.now() - startedAt,
			});
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

export function updateBufferedMessageMode(
	narratorId: string,
	messageId: string,
	mode: BufferQueueMode,
): Promise<boolean> {
	return bufferEditHolds.mutate(narratorId, messageId, () =>
		updateBufferedMessageModeUnlocked(narratorId, messageId, mode),
	);
}
async function updateBufferedMessageModeUnlocked(
	narratorId: string,
	messageId: string,
	mode: BufferQueueMode,
): Promise<boolean> {
	const port = pgQueue();
	if (port) return port.mailbox.updateUserBufferedMode(narratorId, messageId, mode);
	return db.transaction((tx) => {
		const rows = tx
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
		const row = rows.find((row) => row.id === messageId);
		if (!row) return false;
		return (
			tx
				.update(mailbox)
				.set({
					...bufferedModePatch(row, rows, mode),
					contentRevision: row.contentRevision + 1,
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(mailbox.id, row.id),
						inArray(mailbox.state, pending),
						eq(mailbox.contentRevision, row.contentRevision),
					),
				)
				.returning({ id: mailbox.id })
				.all().length === 1
		);
	});
}

export function reorderBufferedMessages(narratorId: string, ids: string[]): Promise<boolean> {
	return bufferEditHolds.mutate(narratorId, undefined, () =>
		reorderBufferedMessagesUnlocked(narratorId, ids),
	);
}
async function reorderBufferedMessagesUnlocked(
	narratorId: string,
	ids: string[],
): Promise<boolean> {
	const port = pgQueue();
	if (port) return port.mailbox.reorderUserPending(narratorId, ids);
	return db.transaction((tx) => {
		const rows = tx
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
		const ordinary = ordinaryBufferReorder(rows, ids);
		if (!rows.length || !ordinary) return false;
		for (const [seq, id] of ordinary.entries())
			tx.update(mailbox).set({ seq }).where(eq(mailbox.id, id)).run();
		return true;
	});
}
const BUFFER_CLEAR_CLEANUP_PENDING = "Removed by user; attachment cleanup pending";
/** Authorization loss must cancel/settle in-flight edits, not fail on their UI hold. */
export function clearBufferedMessagesForAuthorizationLoss(
	narratorId: string,
	stop: () => void | Promise<void>,
): Promise<void> {
	return bufferEditHolds.quiesceForAuthorizationLoss(narratorId, stop, () =>
		clearBufferedMessagesUnlocked(narratorId),
	);
}

export function clearBufferedMessages(narratorId: string): Promise<void> {
	return bufferEditHolds.mutate(narratorId, undefined, () =>
		clearBufferedMessagesUnlocked(narratorId),
	);
}
async function clearBufferedMessagesUnlocked(narratorId: string): Promise<void> {
	const port = pgQueue();
	if (port) {
		await port.mailbox.initializeLegacy(narratorId);
		const rows = await port.mailbox.listPending(narratorId, {
			kinds: ["user_input"],
			includeFailed: true,
			limit: MAILBOX_LIMITS.userPending,
		});
		for (const row of rows) await removeBufferedMessage(narratorId, row.id);
		return;
	}
	store.initializeLegacy(narratorId);
	const rows = await readQuery(
		db
			.select()
			.from(mailbox)
			.where(
				and(
					eq(mailbox.narratorId, narratorId),
					eq(mailbox.kind, "user_input"),
					inArray(mailbox.state, pending),
				),
			)
			.limit(MAILBOX_LIMITS.userPending),
		bufferReadOptions(),
	);
	db.transaction((tx) => {
		for (const row of rows) {
			assertBufferObservation(tx, row, row.id);
			if (row.deliveryId && store.cancel(row.deliveryId, BUFFER_CLEAR_CLEANUP_PENDING)) {
				tx.update(mailbox)
					.set({
						dedupeExpiresAt: null,
						metadataJson: JSON.stringify({
							stagingId: json<{ stagingId?: string }>(row.metadataJson, {}).stagingId ?? row.id,
							cleanupDedupeExpiresAt: row.dedupeExpiresAt,
						}),
					})
					.where(eq(mailbox.id, row.id))
					.run();
			}
		}
	});
	for (;;) {
		const cleanupRows = await readQuery(
			db
				.select({
					id: mailbox.id,
					narratorId: mailbox.narratorId,
					kind: mailbox.kind,
					state: mailbox.state,
					deliveryId: mailbox.deliveryId,
					contentRevision: mailbox.contentRevision,
					metadataJson: mailbox.metadataJson,
					textFilePathsJson: mailbox.textFilePathsJson,
				})
				.from(mailbox)
				.where(
					and(
						eq(mailbox.narratorId, narratorId),
						eq(mailbox.kind, "user_input"),
						eq(mailbox.state, "cancelled"),
						eq(mailbox.lastError, BUFFER_CLEAR_CLEANUP_PENDING),
					),
				)
				.limit(MAILBOX_LIMITS.userPending),
			bufferReadOptions(),
		);
		if (!cleanupRows.length) return;
		for (let offset = 0; offset < cleanupRows.length; offset += 4) {
			const results = await Promise.allSettled(
				cleanupRows.slice(offset, offset + 4).map((row) =>
					trackBufferedCleanup(async () => {
						if (!row.metadataJson) throw new RuntimeReadConflictError();
						const metadata = json<{ cleanupDedupeExpiresAt?: string | null }>(row.metadataJson, {});
						await cleanupObservedBufferedTextFiles(row.id, row);
						db.update(mailbox)
							.set({
								metadataJson: null,
								lastError: "Removed by user",
								dedupeExpiresAt: metadata.cleanupDedupeExpiresAt ?? null,
							})
							.where(
								and(
									eq(mailbox.id, row.id),
									eq(mailbox.state, "cancelled"),
									eq(mailbox.lastError, BUFFER_CLEAR_CLEANUP_PENDING),
									eq(mailbox.metadataJson, row.metadataJson),
								),
							)
							.run();
					}),
				),
			);
			for (const result of results) if (result.status === "rejected") throw result.reason;
		}
	}
}
/** Explicit user intent only. Missing staging remains failed instead of spinning a new run. */
export function retryBufferedMessage(narratorId: string, messageId: string): Promise<boolean> {
	return bufferEditHolds.mutate(narratorId, messageId, () =>
		retryBufferedMessageUnlocked(narratorId, messageId),
	);
}
async function retryBufferedMessageUnlocked(
	narratorId: string,
	messageId: string,
): Promise<boolean> {
	const port = pgQueue();
	const row = await rowByIdRuntime(messageId);
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
	if (port) return port.mailbox.retryFailed(row.deliveryId);
	const deliveryId = row.deliveryId;
	return db.transaction((tx) => {
		assertBufferObservation(tx, row, row.id);
		return store.retryFailed(deliveryId);
	});
}
export const dbClearAllBuffered = clearBufferedMessages;
export async function releaseBufferedMessage(
	msg: BufferedMessage,
	error = "Dispatch interrupted",
): Promise<void> {
	const claim = msg._mailboxClaim;
	if (!claim) return;
	const row = await rowByIdRuntime(claim.id);
	// A downstream failure after materialization must not recreate a queued user
	// message; a stale owner must not release a newer generation's claim either.
	if (
		row?.state !== "claimed" ||
		row.claimToken !== claim.token ||
		row.claimEpoch !== claim.epoch ||
		row.narratorId !== claim.narratorId
	)
		return;
	const port = pgQueue();
	if (port) await port.mailbox.failClaim(claim, error);
	else store.failClaim(claim, error);
}
/**
 * Drop a claimed queued message the consumer refuses to deliver, without materializing it: the
 * row is cancelled through its exact claim (no other owner's claim is touched, nothing is
 * requeued) and its staged text files go with it. A message that is not claimed is not dropped:
 * the caller claims the exact row first, so what it drops is what it read. Returns whether a row
 * was dropped.
 */
export async function dropBufferedMessage(
	narratorId: string,
	msg: BufferedMessage,
	reason: string,
): Promise<boolean> {
	const claim = msg._mailboxClaim;
	if (!claim || claim.narratorId !== narratorId) return false;
	const stagingId = msg._stagingId ?? msg.id;
	const port = pgQueue();
	if (port) {
		if (!(await port.mailbox.cancelClaim(claim, reason))) return false;
		await cleanupStagingPg(port, stagingId);
		return true;
	}
	if (!store.cancelClaim(claim, reason)) return false;
	await cleanupBufferedTextFiles(stagingId);
	return true;
}

export async function restoreBufferedMessage(
	narratorId: string,
	msg: BufferedMessage,
): Promise<void> {
	if (msg._mailboxClaim?.narratorId !== narratorId) return;
	await releaseBufferedMessage(msg);
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
	hasComposerDocument?: boolean;
	queueMode?: BufferQueueMode;
	state?: "queued" | "failed";
	error?: string | null;
	id: string;
	text: string;
	bufferedAt: string;
	imageCount: number;
	images: BufferedImageSummary[];
	media: MediaRef[];
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
		| "media"
		| "textFiles"
		| "_savedFiles"
		| "creator"
		| "priority"
		| "queueMode"
		| "fileReferences"
		| "hasComposerDocument"
	>[],
): BufferMessageSummary[] {
	return msgs.map((m) => ({
		hasComposerDocument: m.hasComposerDocument || undefined,
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
		media: (m.media ?? []).map((item) => copyMediaRef(item)),
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
		queueMode: resolveBufferQueueMode(m.queueMode, m.priority),
	}));
}
