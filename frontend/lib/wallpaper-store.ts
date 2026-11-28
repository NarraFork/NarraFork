/**
 * Persists a user-picked wallpaper file so it survives a reload.
 *
 * localStorage cannot hold a multi-megabyte image (5 MB quota, shared with everything
 * else), so the blob goes to IndexedDB. Only one image is kept: picking a new one
 * replaces the previous, which is also how "remove" cleans up.
 */

const DB_NAME = "narrafork-wallpaper";
const STORE = "images";
const KEY = "current";

function openDb(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === "undefined") return Promise.resolve(null);
	return new Promise((resolve) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
		};
		request.onsuccess = () => resolve(request.result);
		// Private mode or a blocked upgrade: the caller falls back to "no stored file".
		request.onerror = () => resolve(null);
	});
}

export async function saveWallpaperBlob(blob: Blob): Promise<void> {
	const db = await openDb();
	if (!db) return;
	await new Promise<void>((resolve) => {
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).put(blob, KEY);
		tx.oncomplete = () => resolve();
		tx.onerror = () => resolve();
	});
	db.close();
}

export async function loadWallpaperBlob(): Promise<Blob | null> {
	const db = await openDb();
	if (!db) return null;
	const result = await new Promise<Blob | null>((resolve) => {
		const tx = db.transaction(STORE, "readonly");
		const request = tx.objectStore(STORE).get(KEY);
		request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
		request.onerror = () => resolve(null);
	});
	db.close();
	return result;
}

export async function clearWallpaperBlob(): Promise<void> {
	const db = await openDb();
	if (!db) return;
	await new Promise<void>((resolve) => {
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).delete(KEY);
		tx.oncomplete = () => resolve();
		tx.onerror = () => resolve();
	});
	db.close();
}
