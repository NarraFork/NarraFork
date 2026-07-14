const DB_NAME = "narrafork-draft-image-attachments";
const DB_VERSION = 2;
const STORE_NAME = "drafts";

const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_DRAFT_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

interface DraftImageAttachmentEntry {
	name: string;
	type: string;
	size: number;
	lastModified: number;
	blob: Blob;
}

interface DraftImageAttachmentRecord {
	draftKey: string;
	userId: string;
	narratorId: string;
	updatedAt: string;
	images: DraftImageAttachmentEntry[];
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

		request.onupgradeneeded = () => {
			const db = request.result;
			// Version 1 keyed records only by narratorId and could expose one account's
			// pending images to another account. Drop that unscoped store on upgrade.
			if (db.objectStoreNames.contains(STORE_NAME)) db.deleteObjectStore(STORE_NAME);
			db.createObjectStore(STORE_NAME, { keyPath: "draftKey" });
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

function getStoredFileName(file: File, index: number): string {
	return file.name || `pasted-image-${index + 1}${getExtensionForType(file.type)}`;
}

function shouldPersistFile(file: File): boolean {
	return ACCEPTED_IMAGE_TYPES.has(file.type) && file.size <= MAX_DRAFT_IMAGE_ATTACHMENT_BYTES;
}

function fileToEntry(file: File, index: number): DraftImageAttachmentEntry {
	return {
		name: getStoredFileName(file, index),
		type: file.type,
		size: file.size,
		lastModified: file.lastModified,
		blob: file.slice(0, file.size, file.type),
	};
}

function isDraftRecord(value: unknown): value is DraftImageAttachmentRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<DraftImageAttachmentRecord>;
	return Array.isArray(record.images);
}

function entryToFile(entry: unknown, index: number): File | null {
	if (!entry || typeof entry !== "object" || typeof File === "undefined") return null;
	const item = entry as Partial<DraftImageAttachmentEntry>;
	const blob = item.blob;
	if (!isBlob(blob)) return null;
	const type = typeof item.type === "string" ? item.type : blob.type;
	if (!type || !ACCEPTED_IMAGE_TYPES.has(type)) return null;
	if (blob.size > MAX_DRAFT_IMAGE_ATTACHMENT_BYTES) return null;
	const name =
		typeof item.name === "string" && item.name.trim()
			? item.name
			: `pasted-image-${index + 1}${getExtensionForType(type)}`;
	const lastModified = typeof item.lastModified === "number" ? item.lastModified : Date.now();
	return new File([blob], name, { type, lastModified });
}

export async function loadDraftImageAttachments(
	userId: string,
	narratorId: string,
): Promise<File[]> {
	const db = await openDraftImageAttachmentDb();
	if (!db || !userId || !narratorId) return [];

	const transaction = db.transaction(STORE_NAME, "readonly");
	const store = transaction.objectStore(STORE_NAME);
	const record = await requestToPromise<unknown>(
		store.get(getDraftImageAttachmentKey(userId, narratorId)),
	);
	if (!isDraftRecord(record)) return [];

	return record.images
		.map((entry, index) => entryToFile(entry, index))
		.filter((file): file is File => file != null);
}

export async function saveDraftImageAttachments(
	userId: string,
	narratorId: string,
	files: File[],
): Promise<void> {
	const db = await openDraftImageAttachmentDb();
	if (!db || !userId || !narratorId) return;

	const transaction = db.transaction(STORE_NAME, "readwrite");
	const store = transaction.objectStore(STORE_NAME);
	const images = files.filter(shouldPersistFile).map(fileToEntry);
	const draftKey = getDraftImageAttachmentKey(userId, narratorId);

	if (images.length === 0) {
		store.delete(draftKey);
	} else {
		store.put({
			draftKey,
			userId,
			narratorId,
			updatedAt: new Date().toISOString(),
			images,
		} satisfies DraftImageAttachmentRecord);
	}

	await transactionDone(transaction);
}

export async function clearDraftImageAttachments(
	userId: string,
	narratorId: string,
): Promise<void> {
	await saveDraftImageAttachments(userId, narratorId, []);
}
