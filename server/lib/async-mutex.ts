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
import { normalizePathForComparison } from "./platform-path";

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

/**
 * Mutex keyed by a filesystem path, normalizing the key for the caller.
 *
 * Exists because a raw path is not a usable identity: `/a/wt`, `/a/wt/`,
 * `/a/./wt` and (on Windows) `C:\A\WT` are the same directory but four distinct
 * Map keys, so two callers guarding "the same worktree" could both hold the lock
 * and interleave their git writes. Every path that reaches a lock originates
 * from `chapters.worktreePath`, a free-form string nobody canonicalizes on write,
 * so the variants are reachable rather than theoretical.
 *
 * The normalization is deliberately not exposed as "normalize, then call
 * acquire": that leaves each of ~20 call sites able to forget, and a forgotten
 * one fails silently (weaker mutual exclusion, no error). Taking the raw path
 * and deriving the key here makes the correct behaviour the only behaviour.
 *
 * The normalized value is a **key only**. It is never handed to git or
 * `safeSpawn` as a cwd: case folding is destructive on case-sensitive
 * filesystems, where `/srv/WT` and `/srv/wt` are different directories. Callers
 * keep passing their raw path to the work they run inside `fn`, mirroring the
 * `workspacePath`/`rawPath` split in `services/git-workspace.ts`.
 */
export class PathKeyedMutex {
	private readonly mutex = new AsyncMutex();

	/** The canonical lock key for `rawPath`. Exposed for tests and diagnostics. */
	key(rawPath: string): string {
		return normalizePathForComparison(rawPath);
	}

	/**
	 * Acquire the lock for the directory `rawPath` denotes, run `fn`, release.
	 *
	 * `fn` takes no arguments on purpose — it closes over the caller's raw path,
	 * so there is no normalized value in scope for it to accidentally use as a cwd.
	 */
	async acquire<T>(rawPath: string, fn: () => Promise<T>): Promise<T> {
		return this.mutex.acquire(this.key(rawPath), fn);
	}

	/** Bounded variant of {@link acquire}. See {@link AsyncMutex.tryAcquire}. */
	async tryAcquire<T>(
		rawPath: string,
		fn: () => Promise<T>,
		timeoutMs: number,
	): Promise<TryAcquireResult<T>> {
		return this.mutex.tryAcquire(this.key(rawPath), fn, timeoutMs);
	}

	/** Whether some caller currently holds the lock for `rawPath`. */
	isLocked(rawPath: string): boolean {
		return this.mutex.isLocked(this.key(rawPath));
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

/**
 * Lock hierarchy for the chapter/worktree subsystem — acquire in this order only:
 *
 *   `chapterLock` → `worktreeLock` → { shadow-repo lock, `containerLock` }
 *
 * Deadlock between two locks needs a cycle, and a cycle needs two callers acquiring the
 * same pair in opposite orders. A single global order makes that unrepresentable, which
 * is why the rule is about *order* rather than about which locks a function may take.
 *
 * The current shape, verified by inspection of every call site:
 *   - `chapterLock` (keyed by chapterId) is outermost. `chapter-cleanup`'s dormant path
 *     holds it and takes `worktreeLock` inside.
 *   - `worktreeLock` (keyed by normalized path) is the middle level. It is the only
 *     worktree mutex: `git-service`'s write methods take *this* one, which is why they
 *     also expose `*Unlocked` variants for callers that already hold it.
 *   - The shadow-repo mutex in `worktree-tree-snapshot` and `containerLock` are leaves:
 *     neither acquires anything else. `worktree-tree-snapshot` has no reference to
 *     `gitService` at all — it spawns git directly against a scratch index — so the
 *     tempting `shadow → git` edge does not exist.
 *
 * `worktreeWriteLock` sits outside this hierarchy: see its own note below.
 *
 * No runtime assertion enforces this. Detecting "which locks does this async call stack
 * hold" needs `AsyncLocalStorage` context threaded through `AsyncMutex`, and `AsyncMutex`
 * backs 20+ instances with unrelated semantics (narrator traits, drafts, plugins, user
 * preferences), several on hot paths. Adding a context read/write to every acquire in the
 * process to guard one subsystem's ordering was judged the wrong trade: the failure it
 * would catch is a code-review-visible nesting mistake, while the cost is borne by every
 * lock in the system and a bug in the tracking itself would be far worse than the bug it
 * prevents. `git-service-worktree-lock.test.ts` covers the concrete hazard instead.
 */

/** Per-chapter mutex — guards state transitions (dormant, wake, remove, update). */
export const chapterLock = new AsyncMutex();

/**
 * Per-worktree mutex — guards git operations (merge, cherry-pick, autoCommit).
 *
 * Path-keyed so that every caller lands on the same key regardless of how the
 * worktree path was spelled in the row it came from.
 */
export const worktreeLock = new PathKeyedMutex();

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
