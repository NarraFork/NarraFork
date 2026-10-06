/**
 * draft-image-attachments.ts — Pending composer attachments, across a reload.
 *
 * A file the user attached but has NOT sent yet only exists as a `File` in React
 * state, so a refresh or a narrator switch destroys it. Both are routine (every
 * `NarratorPanel` mount point keys on `narratorId`, so switching remounts), and
 * the loss is silent: nothing tells the user their screenshot is gone.
 *
 * Images live here as Blobs because there is nowhere else for them — unlike the
 * TEXT draft, which the server owns (see `narrator-draft-storage.ts`), an
 * unsent attachment has never been uploaded. IndexedDB rather than
 * `sessionStorage` for the same reason: it stores Blobs directly, off the main
 * thread, and is not competing for the ~5MB quota the session store rations.
 *
 * WHY EVICTION IS PART OF THIS MODULE
 * -----------------------------------
 * Before this, a record was only ever deleted when its own narrator's
 * attachments went back to empty. A user who attached one image in each of
 * fifty narrators and sent none of them kept fifty records forever, with
 * nothing in the codebase able to reclaim them — the same structural gap that
 * let `sessionStorage` fill up (see the note at the top of `session-store.ts`).
 * So the write path is also the prune trigger: growth and cleanup are the same
 * event, and a user who never attaches anything pays nothing.
 */

const DB_NAME = "narrafork-draft-image-attachments";
/**
 * v3 adds `textFiles`, `updatedAtMs` and `totalBytes` to each record.
 *
 * Unlike the v1 → v2 bump this must NOT drop the object store. That one was a
 * security fix (v1 keyed records by `narratorId` alone, so one account could
 * read another's pending images) and losing the data was the point. Here there
 * is no such motive, and deleting the store would throw away attachments users
 * are currently holding. Old records are read with defaults instead and get
 * their new fields on the next write.
 */
const DB_VERSION = 3;
const STORE_NAME = "drafts";

const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Largest single file mirrored into IndexedDB.
 *
 * Applies to BOTH kinds, which makes it stricter than the composer for text
 * files (`MAX_TEXT_FILE_SIZE` is 100MB). That is deliberate: a file over this
 * size stays in composer state and still sends normally — it just does not
 * survive a reload. Copying an 80MB log into browser storage to buy one refresh
 * is a bad trade, and the reload path reports what it could not restore
 * (`droppedCount`) rather than staying quiet about it.
 */
export const MAX_DRAFT_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Age after which a record is abandoned, regardless of how much room is left. */
export const DRAFT_ATTACHMENT_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** Total bytes across every record, all users and narrators in this browser. */
export const MAX_DRAFT_ATTACHMENT_TOTAL_BYTES = 100 * 1024 * 1024;

/**
 * Most records kept, oldest-first eviction beyond it.
 *
 * Higher than the session store's `narrator-draft` cap of 8 because the two
 * bound different things: that one bounds "narrators this tab has visited",
 * which grows just from reading, while a record here only exists if the user
 * deliberately attached a file and did not send it. 20 of those is already an
 * unusual amount of held work.
 */
export const MAX_DRAFT_ATTACHMENT_RECORDS = 20;

interface DraftAttachmentEntry {
	name: string;
	type: string;
	size: number;
	lastModified: number;
	blob: Blob;
}

interface DraftAttachmentRecord {
	draftKey: string;
	userId: string;
	narratorId: string;
	updatedAt: string;
	/**
	 * Same instant as `updatedAt`, as epoch millis.
	 *
	 * Duplicated because it is the eviction sort key and the index key path:
	 * IndexedDB can index it directly, and the prune pass never has to parse an
	 * ISO string per record.
	 */
	updatedAtMs: number;
	/** Sum of the stored blob sizes, so the budget pass never reads a Blob. */
	totalBytes: number;
	images: DraftAttachmentEntry[];
	textFiles: DraftAttachmentEntry[];
}

/** What `loadDraftAttachments` recovered, and what it could not. */
export interface LoadedDraftAttachments {
	images: File[];
	textFiles: File[];
	/**
	 * Entries present in the record but unusable (blob gone, invalid type).
	 *
	 * Surfaced rather than filtered away silently: an attachment that vanishes
	 * without a word reads as "I misremembered attaching that".
	 */
	droppedCount: number;
}

/** One record as the eviction pass sees it — no blobs, no DOM types. */
export interface DraftAttachmentRecordStat {
	draftKey: string;
	updatedAtMs: number;
	totalBytes: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function getIndexedDb(): IDBFactory | null {
	return typeof indexedDB === "undefined" ? null : indexedDB;
}

export function getDraftImageAttachmentKey(userId: string, narratorId: string): string {
	return `${userId.length}:${userId}:${narratorId}`;
}

function openDraftImageAttachmentDb(): Promise<IDBDatabase | null> {
	const idb = getIndexedDb();
	if (!idb) return Promise.resolve(null);
	if (dbPromise) return dbPromise;

	dbPromise = new Promise((resolve) => {
		const request = idb.open(DB_NAME, DB_VERSION);

		request.onupgradeneeded = (event) => {
			const db = request.result;

			// v1 keyed records only by narratorId and could expose one account's
			// pending images to another account. Drop that unscoped store.
			if (event.oldVersion < 2 && db.objectStoreNames.contains(STORE_NAME)) {
				db.deleteObjectStore(STORE_NAME);
			}

			// v2 → v3 adds fields only, so an existing store is kept as-is and its
			// records are read with defaults (see `resolveUpdatedAtMs` /
			// `resolveTotalBytes`). Recreating it here would delete attachments the
			// user is holding right now.
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME, { keyPath: "draftKey" });
			}
		};

		request.onerror = () => {
			dbPromise = null;
			resolve(null);
		};

		request.onblocked = () => {
			dbPromise = null;
			resolve(null);
		};

		request.onsuccess = () => {
			const db = request.result;
			db.onversionchange = () => {
				db.close();
				dbPromise = null;
			};
			resolve(db);
		};
	});

	return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
	});
}

function isBlob(value: unknown): value is Blob {
	return typeof Blob !== "undefined" && value instanceof Blob;
}

function getExtensionForType(type: string): string {
	switch (type) {
		case "image/jpeg":
			return ".jpg";
		case "image/gif":
			return ".gif";
		case "image/webp":
			return ".webp";
		default:
			return ".png";
	}
}

function getStoredFileName(file: File, index: number, kind: AttachmentKind): string {
	if (file.name) return file.name;
	return kind === "image"
		? `pasted-image-${index + 1}${getExtensionForType(file.type)}`
		: `attachment-${index + 1}.txt`;
}

type AttachmentKind = "image" | "text";

/**
 * Whether a file is worth mirroring.
 *
 * Images keep the MIME allowlist (they are rendered as thumbnails, and the
 * composer only accepts those types anyway). Text files deliberately do NOT get
 * a type filter: the server accepts any file the composer accepts, so screening
 * by MIME here would make persistence stricter than sending — producing files
 * that go out fine but disappear on reload, for no reason the user can see.
 */
function shouldPersistFile(file: File, kind: AttachmentKind): boolean {
	if (file.size > MAX_DRAFT_ATTACHMENT_BYTES) return false;
	return kind === "image" ? ACCEPTED_IMAGE_TYPES.has(file.type) : true;
}

function fileToEntry(file: File, index: number, kind: AttachmentKind): DraftAttachmentEntry {
	return {
		name: getStoredFileName(file, index, kind),
		type: file.type,
		size: file.size,
		lastModified: file.lastModified,
		blob: file.slice(0, file.size, file.type),
	};
}

function isDraftRecord(value: unknown): value is Partial<DraftAttachmentRecord> {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<DraftAttachmentRecord>;
	// `images` predates v3 and is the marker of a record this module wrote;
	// `textFiles` may legitimately be absent on a v2 record.
	return Array.isArray(record.images);
}

function readEntryList(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function entryToFile(entry: unknown, index: number, kind: AttachmentKind): File | null {
	if (!entry || typeof entry !== "object" || typeof File === "undefined") return null;
	const item = entry as Partial<DraftAttachmentEntry>;
	const blob = item.blob;
	if (!isBlob(blob)) return null;
	const type = typeof item.type === "string" ? item.type : blob.type;
	if (blob.size > MAX_DRAFT_ATTACHMENT_BYTES) return null;
	if (kind === "image" && (!type || !ACCEPTED_IMAGE_TYPES.has(type))) return null;
	const fallbackName =
		kind === "image"
			? `pasted-image-${index + 1}${getExtensionForType(type)}`
			: `attachment-${index + 1}.txt`;
	const name = typeof item.name === "string" && item.name.trim() ? item.name : fallbackName;
	const lastModified = typeof item.lastModified === "number" ? item.lastModified : Date.now();
	return new File([blob], name, { type, lastModified });
}

/** Epoch millis for a record, tolerating v2 records that only have `updatedAt`. */
function resolveUpdatedAtMs(record: Partial<DraftAttachmentRecord>): number {
	if (typeof record.updatedAtMs === "number" && Number.isFinite(record.updatedAtMs)) {
		return record.updatedAtMs;
	}
	if (typeof record.updatedAt === "string") {
		const parsed = Date.parse(record.updatedAt);
		if (!Number.isNaN(parsed)) return parsed;
	}
	// A record with no usable timestamp is treated as ancient rather than fresh:
	// the alternative is an entry that can never be evicted by age.
	return 0;
}

function sumEntryBytes(entries: unknown[]): number {
	let total = 0;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const size = (entry as Partial<DraftAttachmentEntry>).size;
		if (typeof size === "number" && Number.isFinite(size) && size > 0) total += size;
	}
	return total;
}

/** Byte total for a record, computed when a v2 record has no `totalBytes`. */
function resolveTotalBytes(record: Partial<DraftAttachmentRecord>): number {
	if (typeof record.totalBytes === "number" && Number.isFinite(record.totalBytes)) {
		return record.totalBytes;
	}
	return (
		sumEntryBytes(readEntryList(record.images)) + sumEntryBytes(readEntryList(record.textFiles))
	);
}

/**
 * Which records to delete, given every record's stats.
 *
 * Pure and exported so the policy is testable without IndexedDB: the three
 * rules and the protection below are the whole contract, and the surrounding
 * code is only the IDB call sequence.
 *
 * `protectKey` — the record being written right now — is never selected. Without
 * it a single large attachment could push the total over budget and then be
 * evicted by the very prune its own write triggered: stored successfully, gone
 * after a reload, with no signal anywhere. This mirrors why
 * `evictUntilFits(area, needed, protectedKey)` in `session-store.ts` takes the
 * key it is making room for.
 */
export function selectDraftAttachmentsToEvict(options: {
	records: readonly DraftAttachmentRecordStat[];
	now: number;
	protectKey: string | null;
	ttlMs?: number;
	maxTotalBytes?: number;
	maxRecords?: number;
}): string[] {
	const ttlMs = options.ttlMs ?? DRAFT_ATTACHMENT_TTL_MS;
	const maxTotalBytes = options.maxTotalBytes ?? MAX_DRAFT_ATTACHMENT_TOTAL_BYTES;
	const maxRecords = options.maxRecords ?? MAX_DRAFT_ATTACHMENT_RECORDS;

	const doomed = new Set<string>();
	const isProtected = (key: string) => key === options.protectKey;

	// (1) Age. Applied before the budget rules so an expired record's bytes do not
	// count against records that are still current.
	const cutoff = options.now - ttlMs;
	const survivors: DraftAttachmentRecordStat[] = [];
	for (const record of options.records) {
		if (!isProtected(record.draftKey) && record.updatedAtMs < cutoff) {
			doomed.add(record.draftKey);
		} else {
			survivors.push(record);
		}
	}

	// Oldest first: eviction order for both remaining rules.
	const byAge = [...survivors].sort((a, b) => a.updatedAtMs - b.updatedAtMs);

	// (2) Total bytes. The protected record's bytes still COUNT toward the total —
	// it is only exempt from being the victim — so a large current attachment
	// makes room by evicting older records rather than by being dropped itself.
	let totalBytes = byAge.reduce((sum, record) => sum + record.totalBytes, 0);
	for (const record of byAge) {
		if (totalBytes <= maxTotalBytes) break;
		if (isProtected(record.draftKey) || doomed.has(record.draftKey)) continue;
		doomed.add(record.draftKey);
		totalBytes -= record.totalBytes;
	}

	// (3) Record count.
	let remaining = byAge.filter((record) => !doomed.has(record.draftKey)).length;
	for (const record of byAge) {
		if (remaining <= maxRecords) break;
		if (isProtected(record.draftKey) || doomed.has(record.draftKey)) continue;
		doomed.add(record.draftKey);
		remaining--;
	}

	return [...doomed];
}

export async function loadDraftImageAttachments(
	userId: string,
	narratorId: string,
): Promise<LoadedDraftAttachments> {
	const empty: LoadedDraftAttachments = { images: [], textFiles: [], droppedCount: 0 };
	const db = await openDraftImageAttachmentDb();
	if (!db || !userId || !narratorId) return empty;

	const draftKey = getDraftImageAttachmentKey(userId, narratorId);
	const transaction = db.transaction(STORE_NAME, "readonly");
	const store = transaction.objectStore(STORE_NAME);
	const record = await requestToPromise<unknown>(store.get(draftKey));
	if (!isDraftRecord(record)) return empty;

	// An expired record is reported as absent AND deleted here, not only by the
	// write-triggered prune. Otherwise "expires after 3 days" would really mean
	// "expires once something else writes", and a user returning to an old tab
	// would get back attachments the policy already considers abandoned.
	if (resolveUpdatedAtMs(record) < Date.now() - DRAFT_ATTACHMENT_TTL_MS) {
		void deleteDraftRecords(db, [draftKey]).catch(() => {
			// Best effort: the caller already treats the record as gone.
		});
		return empty;
	}

	const rawImages = readEntryList(record.images);
	const rawTextFiles = readEntryList(record.textFiles);
	const images = rawImages
		.map((entry, index) => entryToFile(entry, index, "image"))
		.filter((file): file is File => file != null);
	const textFiles = rawTextFiles
		.map((entry, index) => entryToFile(entry, index, "text"))
		.filter((file): file is File => file != null);

	return {
		images,
		textFiles,
		droppedCount: rawImages.length - images.length + (rawTextFiles.length - textFiles.length),
	};
}

async function deleteDraftRecords(db: IDBDatabase, keys: readonly string[]): Promise<void> {
	if (keys.length === 0) return;
	const transaction = db.transaction(STORE_NAME, "readwrite");
	const store = transaction.objectStore(STORE_NAME);
	for (const key of keys) store.delete(key);
	await transactionDone(transaction);
}

/**
 * Apply the eviction policy across every record in this browser.
 *
 * `getAll()` is acceptable here even though records hold blobs: a Blob read back
 * from IndexedDB is a lazy handle to the stored file, not its bytes, and rule (3)
 * caps the record count at `MAX_DRAFT_ATTACHMENT_RECORDS` anyway. `totalBytes`
 * lives on the record precisely so the budget pass never has to touch a blob to
 * learn its size.
 */
export async function pruneDraftAttachments(protectKey: string | null): Promise<number> {
	const db = await openDraftImageAttachmentDb();
	if (!db) return 0;

	const transaction = db.transaction(STORE_NAME, "readonly");
	const store = transaction.objectStore(STORE_NAME);
	const all = await requestToPromise<unknown[]>(store.getAll());
	const records: DraftAttachmentRecordStat[] = [];
	for (const value of all) {
		if (!isDraftRecord(value)) continue;
		const draftKey = value.draftKey;
		if (typeof draftKey !== "string" || !draftKey) continue;
		records.push({
			draftKey,
			updatedAtMs: resolveUpdatedAtMs(value),
			totalBytes: resolveTotalBytes(value),
		});
	}

	const doomed = selectDraftAttachmentsToEvict({ records, now: Date.now(), protectKey });
	await deleteDraftRecords(db, doomed);
	return doomed.length;
}

export async function saveDraftImageAttachments(
	userId: string,
	narratorId: string,
	files: File[],
	textFiles: File[] = [],
): Promise<void> {
	const db = await openDraftImageAttachmentDb();
	if (!db || !userId || !narratorId) return;

	const transaction = db.transaction(STORE_NAME, "readwrite");
	const store = transaction.objectStore(STORE_NAME);
	const images = files
		.filter((file) => shouldPersistFile(file, "image"))
		.map((file, index) => fileToEntry(file, index, "image"));
	const texts = textFiles
		.filter((file) => shouldPersistFile(file, "text"))
		.map((file, index) => fileToEntry(file, index, "text"));
	const draftKey = getDraftImageAttachmentKey(userId, narratorId);

	if (images.length === 0 && texts.length === 0) {
		store.delete(draftKey);
	} else {
		const now = new Date();
		store.put({
			draftKey,
			userId,
			narratorId,
			updatedAt: now.toISOString(),
			updatedAtMs: now.getTime(),
			totalBytes:
				images.reduce((sum, entry) => sum + entry.size, 0) +
				texts.reduce((sum, entry) => sum + entry.size, 0),
			images,
			textFiles: texts,
		} satisfies DraftAttachmentRecord);
	}

	await transactionDone(transaction);

	// The write is the only thing that grows this store, so it is also the prune
	// trigger — no timer, no startup scan, and nothing for a user who never
	// attaches a file. A prune failure must not fail the save: the attachment is
	// already stored, and the next write tries again.
	void pruneDraftAttachments(draftKey).catch(() => {
		// Ignore: eviction is opportunistic, and the record just written is safe.
	});
}

export async function clearDraftImageAttachments(
	userId: string,
	narratorId: string,
): Promise<void> {
	await saveDraftImageAttachments(userId, narratorId, [], []);
}
