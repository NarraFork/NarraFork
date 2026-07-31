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
/** Outcome of a bounded lock attempt. */
export type TryAcquireResult<T> =
	| { acquired: true; value: T }
	| { acquired: false; waitedMs: number };

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

	/**
	 * Try to acquire the lock within `timeoutMs`, running `fn` only if acquired.
	 *
	 * Intended for work that benefits from serialization but must never be blocked
	 * by it: the caller falls back to running unserialized when the attempt times
	 * out, so the worst case is the unlocked behaviour rather than a stall.
	 *
	 * Unlike {@link acquire}, a waiter is enqueued **only once it actually holds the
	 * lock**. Enqueueing first and bailing out on timeout would resolve this
	 * waiter's slot early, releasing anyone queued behind it while the current
	 * holder is still running — silently breaking their mutual exclusion.
	 */
	async tryAcquire<T>(
		key: string,
		fn: () => Promise<T>,
		timeoutMs: number,
	): Promise<TryAcquireResult<T>> {
		const startedAt = Date.now();
		const deadline = startedAt + Math.max(0, timeoutMs);

		// Wait for the queue to drain, re-checking because a new tail may appear
		// while we await the previous one.
		while (true) {
			const tail = this.locks.get(key);
			if (!tail) break;
			const remaining = deadline - Date.now();
			if (remaining <= 0) return { acquired: false, waitedMs: Date.now() - startedAt };
			const timedOut = await raceWithTimeout(tail, remaining);
			if (timedOut) return { acquired: false, waitedMs: Date.now() - startedAt };
		}

		// The lock is free and this is a synchronous claim — no await between the
		// check above and the set below, so no other caller can interleave.
		let release!: () => void;
		const current = new Promise<void>((r) => {
			release = r;
		});
		this.locks.set(key, current);
		try {
			return { acquired: true, value: await fn() };
		} finally {
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

/** Resolve to true when `timeoutMs` elapses before `promise` settles. */
async function raceWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => false),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(true), timeoutMs);
			}),
		]);
	} finally {
		// Always clear, otherwise a pending timer keeps the event loop alive.
		if (timer) clearTimeout(timer);
	}
}

/** Per-chapter mutex — guards state transitions (dormant, wake, remove, update). */
export const chapterLock = new AsyncMutex();

/** Per-worktree mutex — guards git operations (merge, cherry-pick, autoCommit). */
export const worktreeLock = new AsyncMutex();

/**
 * Per-worktree mutex for tool file writes, keyed by normalized worktree path.
 *
 * Separate from {@link worktreeLock} on purpose: git operations (merge, rebase)
 * can legitimately run for a long time, and making short tool writes queue behind
 * them — or vice versa — would either stall narrators or make merges wait on every
 * edit. Write/Edit hold this for their millisecond-long write window; Bash only
 * attempts it with a deadline and proceeds unserialized on timeout.
 */
export const worktreeWriteLock = new AsyncMutex();

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

/**
 * Per-narrator mutex — guards lazy backfill of inherited message refs.
 *
 * A fork only materializes the refs after the parent's last compact; scrolling
 * up copies older windows in on demand. Concurrent scroll/jump requests would
 * otherwise race on the same read-modify-write of `refsBackfillCursor`.
 */
export const narratorRefsBackfillLock = new AsyncMutex();
