import { describe, expect, test } from "bun:test";
import { AsyncMutex, PathKeyedMutex } from "../async-mutex";
import { normalizePathForComparison } from "../platform-path";

/** A promise plus its resolver, for driving lock timing deterministically. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn`, rejecting instead of hanging if it does not settle in `ms`.
 *
 * Required for the re-entrancy case: `acquire` on a held key never resolves, so a plain
 * `await` would wedge the test runner rather than fail it. Kept under bun's 5s per-test
 * timeout so the assertion below reports the cause instead of a bare "timed out".
 */
async function settlesWithin<T>(ms: number, fn: () => Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			fn(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("AsyncMutex.acquire", () => {
	test("runs queued waiters in FIFO order", async () => {
		const mutex = new AsyncMutex();
		const holder = deferred();
		const order: string[] = [];

		const holding = mutex.acquire("k", async () => {
			order.push("holder");
			await holder.promise;
		});
		await sleep(5);

		// Enqueued in a known order while the holder is still running. Each chains behind
		// the current tail, so the completion order must match the enqueue order — the
		// property the merge/rebase orchestrations depend on to avoid starving a request
		// behind later arrivals.
		const waiters = ["first", "second", "third"].map((name) =>
			mutex.acquire("k", async () => {
				order.push(name);
			}),
		);

		holder.resolve();
		await holding;
		await Promise.all(waiters);
		expect(order).toEqual(["holder", "first", "second", "third"]);
	});

	test("waiters never overlap the holder", async () => {
		const mutex = new AsyncMutex();
		let active = 0;
		let maxActive = 0;
		const body = async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await sleep(5);
			active--;
		};

		await Promise.all(Array.from({ length: 5 }, () => mutex.acquire("k", body)));
		expect(maxActive).toBe(1);
		expect(mutex.isLocked("k")).toBe(false);
	});

	test("re-entering the same key deadlocks deterministically", async () => {
		const mutex = new AsyncMutex();
		let innerRan = false;

		// The reason `git-service`'s write methods need `*Unlocked` variants. `acquire`
		// queues behind the current tail unconditionally, with no owner tracking, so a
		// nested acquire on a key the caller already holds waits for itself. This is not a
		// race that sometimes fires — it hangs every time, which is why the production
		// symptom is a request that never returns rather than an error.
		await expect(
			settlesWithin(300, () =>
				mutex.acquire("k", async () => {
					await mutex.acquire("k", async () => {
						innerRan = true;
					});
				}),
			),
		).rejects.toThrow("did not settle");
		expect(innerRan).toBe(false);
	});

	test("nesting a different key is safe", async () => {
		const mutex = new AsyncMutex();
		// Establishes that the hazard is same-key re-entry, not nesting as such: the
		// two-level lock hierarchy (chapter → worktree → shadow/container) relies on this.
		const result = await settlesWithin(300, () =>
			mutex.acquire("outer", () => mutex.acquire("inner", async () => "ok")),
		);
		expect(result).toBe("ok");
		expect(mutex.isLocked("outer")).toBe(false);
		expect(mutex.isLocked("inner")).toBe(false);
	});

	test("a throwing waiter does not block the ones behind it", async () => {
		const mutex = new AsyncMutex();
		const order: string[] = [];
		const failing = mutex.acquire("k", async () => {
			order.push("failing");
			throw new Error("boom");
		});
		const after = mutex.acquire("k", async () => {
			order.push("after");
		});

		await expect(failing).rejects.toThrow("boom");
		await settlesWithin(300, () => after);
		expect(order).toEqual(["failing", "after"]);
		expect(mutex.isLocked("k")).toBe(false);
	});
});

describe("AsyncMutex.tryAcquire", () => {
	test("runs immediately when the lock is free", async () => {
		const mutex = new AsyncMutex();
		const result = await mutex.tryAcquire("k", async () => "done", 1000);
		expect(result).toEqual({ acquired: true, value: "done" });
		// The key is released, not leaked.
		expect(mutex.isLocked("k")).toBe(false);
	});

	test("waits for the current holder and then runs", async () => {
		const mutex = new AsyncMutex();
		const holder = deferred();
		const order: string[] = [];

		const holding = mutex.acquire("k", async () => {
			order.push("holder-start");
			await holder.promise;
			order.push("holder-end");
		});

		// Give the holder a chance to take the lock before the attempt starts.
		await sleep(5);
		const attempt = mutex.tryAcquire(
			"k",
			async () => {
				order.push("waiter");
				return "ok";
			},
			1000,
		);

		holder.resolve();
		await holding;
		expect(await attempt).toEqual({ acquired: true, value: "ok" });
		// Serialization held: the waiter never overlapped the holder.
		expect(order).toEqual(["holder-start", "holder-end", "waiter"]);
	});

	test("gives up without running fn when the holder outlasts the deadline", async () => {
		const mutex = new AsyncMutex();
		const holder = deferred();
		let ran = false;

		const holding = mutex.acquire("k", async () => {
			await holder.promise;
		});
		await sleep(5);

		const result = await mutex.tryAcquire(
			"k",
			async () => {
				ran = true;
			},
			30,
		);

		expect(result.acquired).toBe(false);
		// The whole point of the bounded attempt: the caller is not blocked, and the
		// guarded work is skipped rather than run out of order.
		expect(ran).toBe(false);

		holder.resolve();
		await holding;
	});

	test("a timed-out attempt does not release waiters queued behind the holder", async () => {
		const mutex = new AsyncMutex();
		const holder = deferred();
		const order: string[] = [];

		const holding = mutex.acquire("k", async () => {
			order.push("holder-start");
			await holder.promise;
			order.push("holder-end");
		});
		await sleep(5);

		// A regular waiter queues behind the holder.
		const queued = mutex.acquire("k", async () => {
			order.push("queued");
		});

		// A bounded attempt times out while both are still pending. If it had
		// enqueued itself first and then abandoned its slot, `queued` would have been
		// let through while the holder was still running.
		const timedOut = await mutex.tryAcquire("k", async () => order.push("should-not-run"), 30);
		expect(timedOut.acquired).toBe(false);
		expect(order).toEqual(["holder-start"]);

		holder.resolve();
		await holding;
		await queued;
		expect(order).toEqual(["holder-start", "holder-end", "queued"]);
	});

	test("concurrent attempts on a free lock still run one at a time", async () => {
		const mutex = new AsyncMutex();
		let active = 0;
		let maxActive = 0;

		const body = async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await sleep(10);
			active--;
		};

		const results = await Promise.all([
			mutex.tryAcquire("k", body, 1000),
			mutex.tryAcquire("k", body, 1000),
			mutex.tryAcquire("k", body, 1000),
		]);

		expect(results.every((r) => r.acquired)).toBe(true);
		expect(maxActive).toBe(1);
		expect(mutex.isLocked("k")).toBe(false);
	});

	test("releases the lock when fn throws", async () => {
		const mutex = new AsyncMutex();
		await expect(
			mutex.tryAcquire(
				"k",
				async () => {
					throw new Error("boom");
				},
				1000,
			),
		).rejects.toThrow("boom");
		expect(mutex.isLocked("k")).toBe(false);
		// A later attempt is not blocked by the failed one.
		expect(await mutex.tryAcquire("k", async () => "after", 1000)).toEqual({
			acquired: true,
			value: "after",
		});
	});

	test("different keys never contend", async () => {
		const mutex = new AsyncMutex();
		const holder = deferred();
		const holding = mutex.acquire("a", async () => {
			await holder.promise;
		});
		await sleep(5);

		// Zero timeout on an unrelated key must still succeed.
		expect(await mutex.tryAcquire("b", async () => "b-ok", 0)).toEqual({
			acquired: true,
			value: "b-ok",
		});

		holder.resolve();
		await holding;
	});

	test("a zero timeout fails fast on a held lock", async () => {
		const mutex = new AsyncMutex();
		const holder = deferred();
		const holding = mutex.acquire("k", async () => {
			await holder.promise;
		});
		await sleep(5);

		const started = Date.now();
		const result = await mutex.tryAcquire("k", async () => "nope", 0);
		expect(result.acquired).toBe(false);
		expect(Date.now() - started).toBeLessThan(50);

		holder.resolve();
		await holding;
	});
});

describe("PathKeyedMutex", () => {
	// Every variant below is reachable in production: `chapters.worktreePath` is a
	// free-form string, and callers build paths by concatenation. Under the previous
	// raw-string keying each spelling was its own key, so two callers guarding the
	// same worktree could run `git` concurrently.
	test.each([
		["trailing slash", "/srv/repo/.worktrees/wt", "/srv/repo/.worktrees/wt/"],
		["dot segment", "/srv/repo/.worktrees/wt", "/srv/repo/.worktrees/./wt"],
		["parent segment", "/srv/repo/.worktrees/wt", "/srv/repo/other/../.worktrees/wt"],
		["duplicate separators", "/srv/repo/.worktrees/wt", "/srv/repo//.worktrees//wt"],
	])("%s collapses to one key", async (_label, a, b) => {
		const lock = new PathKeyedMutex();
		expect(lock.key(a)).toBe(lock.key(b));

		const order: string[] = [];
		const holder = deferred();
		const holding = lock.acquire(a, async () => {
			order.push("a-start");
			await holder.promise;
			order.push("a-end");
		});
		await sleep(5);
		// Mutual exclusion, not just key equality: the variant must actually queue.
		expect(lock.isLocked(b)).toBe(true);
		const queued = lock.acquire(b, async () => {
			order.push("b");
		});

		holder.resolve();
		await holding;
		await queued;
		expect(order).toEqual(["a-start", "a-end", "b"]);
	});

	// Skipped off Windows, matching the existing `isInsideWorktree` case-folding test.
	// The fold is not reachable on POSIX: `resolvePath` runs `resolve()` first, which
	// prefixes the cwd onto `C:/...`, so the drive-letter branch in
	// `normalizePathForComparison` never fires and asserting the fold here would be
	// asserting something false about the host.
	test.skipIf(process.platform !== "win32")("Windows drive-letter case folds to one key", () => {
		const lock = new PathKeyedMutex();
		expect(lock.key("C:/repo/.worktrees/WT")).toBe(lock.key("c:/repo/.worktrees/wt"));
	});

	test("case folding is delegated, not reimplemented", () => {
		const lock = new PathKeyedMutex();
		// Pins the contract that matters cross-platform: the key is exactly
		// `normalizePathForComparison`, so Windows semantics come from the one
		// platform-aware helper the rest of the codebase already uses (write lock,
		// shadow-repo keys, `normalizeWorkspacePath`) instead of a second copy that
		// could drift from it.
		const raw = "/srv/repo/.worktrees/wt/";
		expect(lock.key(raw)).toBe(normalizePathForComparison(raw));
	});

	test("distinct worktrees still run concurrently", async () => {
		const lock = new PathKeyedMutex();
		const holder = deferred();
		const holding = lock.acquire("/srv/repo/.worktrees/a", async () => {
			await holder.promise;
		});
		await sleep(5);

		// Normalization must not over-merge: sibling worktrees are independent, and
		// making them contend would serialize unrelated chapters' merges.
		expect(lock.isLocked("/srv/repo/.worktrees/b")).toBe(false);
		expect(await lock.tryAcquire("/srv/repo/.worktrees/b", async () => "ok", 0)).toEqual({
			acquired: true,
			value: "ok",
		});

		holder.resolve();
		await holding;
	});

	test("a case-sensitive POSIX path is not folded", () => {
		const lock = new PathKeyedMutex();
		// The inverse guard: on POSIX these are genuinely different directories, so
		// folding them would make one chapter's lock silently cover another's worktree.
		expect(lock.key("/srv/repo/WT")).not.toBe(lock.key("/srv/repo/wt"));
	});

	test("the key is never a substitute for the caller's raw path", async () => {
		const lock = new PathKeyedMutex();
		// `fn` is nullary by design, so no normalized string is in scope to be
		// mistakenly handed to git as a cwd. This test pins that signature.
		const raw = "/srv/repo/.worktrees/WT/";
		let seen: string | undefined;
		await lock.acquire(raw, async () => {
			seen = raw;
		});
		expect(seen).toBe(raw);
		expect(lock.key(raw)).not.toBe(raw);
	});

	test("releases the key when fn throws", async () => {
		const lock = new PathKeyedMutex();
		await expect(
			lock.acquire("/srv/repo/wt", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(lock.isLocked("/srv/repo/wt/")).toBe(false);
	});
});
