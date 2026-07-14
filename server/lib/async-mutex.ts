/**
 * Promise-based async mutex for single-process concurrency control.
 *
 * Follows the same pattern used in narrator-session.ts (sessionCreationLocks)
 * but generalised for any keyed resource.
 *
 * Usage:
 *   const lock = new AsyncMutex();
 *   await lock.acquire("chapter-123", async () => { ... });
 */
export class AsyncMutex {
	private locks = new Map<string, Promise<void>>();

	/**
	 * Acquire an exclusive lock for `key`, execute `fn`, then release.
	 * If other callers already hold or are waiting for the same key,
	 * this call chains behind them (FIFO order).
	 */
	async acquire<T>(key: string, fn: () => Promise<T>): Promise<T> {
		// Chain behind whatever is currently queued for this key
		const prev = this.locks.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((r) => {
			release = r;
		});
		// Always overwrite — each new waiter chains behind the *latest* tail,
		// which itself chains behind the previous tail, forming a FIFO queue.
		this.locks.set(key, current);

		// Wait for everything ahead of us to finish
		await prev;

		try {
			return await fn();
		} finally {
			// Only delete if we're still the tail (no one queued after us)
			if (this.locks.get(key) === current) {
				this.locks.delete(key);
			}
			release();
		}
	}

	/** Check whether a lock is currently held for `key`. */
	isLocked(key: string): boolean {
		return this.locks.has(key);
	}
}

/** Per-chapter mutex — guards state transitions (dormant, wake, remove, update). */
export const chapterLock = new AsyncMutex();

/** Per-worktree mutex — guards git operations (merge, cherry-pick, autoCommit). */
export const worktreeLock = new AsyncMutex();

/** Per-chapter mutex — guards container lifecycle operations (start, stop, pause, remove). */
export const containerLock = new AsyncMutex();

/** Per-narrator mutex — guards read-modify-write updates to narrator traits. */
export const narratorTraitsLock = new AsyncMutex();

/** Per-user+narrator mutex — guards draft transition checks and upserts. */
export const narratorDraftLock = new AsyncMutex();

/** Per-narrator mutex — guards read-modify-write updates to narrator substatus. */
export const narratorSubstatusLock = new AsyncMutex();

/** Global mutex — guards uniqueness check + assignment of named-narrator handles. */
export const narratorHandleLock = new AsyncMutex();

/** Per-user mutex — guards read-modify-write updates to user preference JSON blobs. */
export const userPreferencesLock = new AsyncMutex();
