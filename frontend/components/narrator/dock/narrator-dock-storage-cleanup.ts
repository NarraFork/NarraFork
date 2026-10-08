/** Startup-only storage housekeeping: no panel, component or API runtime dependencies. */
export const STORAGE_KEY_PREFIX = "narrafork_ndock_";

/** Focus-dock layouts unopened for this long are swept at startup. */
export const DOCK_LAYOUT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Sweep stale focus-dock layouts from localStorage.
 * Unknown ages are kept; malformed entries are removed. Best-effort storage
 * failures must never prevent app startup. Returns the number of keys removed.
 */
export function cleanupStaleNarratorDockLayouts(
	now: number = Date.now(),
	maxAgeMs: number = DOCK_LAYOUT_MAX_AGE_MS,
	storage: Pick<Storage, "length" | "key" | "getItem" | "removeItem"> = localStorage,
): number {
	let removed = 0;
	try {
		// Collect before removing: deleting by index would skip shifted entries.
		const keys: string[] = [];
		for (let i = 0; i < storage.length; i++) {
			const key = storage.key(i);
			if (key?.startsWith(STORAGE_KEY_PREFIX)) keys.push(key);
		}
		for (const key of keys) {
			let drop = false;
			try {
				const raw = storage.getItem(key);
				if (raw == null) continue;
				const parsed = JSON.parse(raw) as { lastOpenedAt?: unknown };
				const ts = typeof parsed?.lastOpenedAt === "number" ? parsed.lastOpenedAt : null;
				if (ts != null && now - ts > maxAgeMs) drop = true;
			} catch {
				drop = true;
			}
			if (drop) {
				storage.removeItem(key);
				removed++;
			}
		}
	} catch {
		// localStorage unavailable / throwing — nothing to clean.
	}
	return removed;
}
