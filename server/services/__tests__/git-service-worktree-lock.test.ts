/**
 * The safety net for the unified worktree mutex.
 *
 * A worktree is guarded by exactly one lock: `worktreeLock` from `lib/async-mutex`. The
 * multi-step orchestrations (`chapter-merge`, `routes/ruler`, `snapshot-dirty-git-op`)
 * hold it across a whole sequence — settle, park, rebase, reapply — because each step
 * reads the state the previous one produced. `git-service`'s individual write methods
 * take the same lock.
 *
 * That makes nesting fatal. `AsyncMutex.acquire` chains behind the current tail with no
 * owner tracking, so a locked write method called from inside a held block waits on the
 * lock its own caller holds. It is a deterministic self-deadlock, not a race, and its
 * symptom is an HTTP request that never returns — nothing throws, nothing logs. Hence the
 * `*Unlocked` variants, which every lock-holding caller uses.
 *
 * Three properties are pinned here, because the refactor is only safe if all three hold:
 *
 *   1. Every `*Unlocked` variant completes, and does its work, while the lock is held.
 *      This is the exact shape of the production call sites.
 *   2. Every locked public method still works for callers that hold nothing — the plain
 *      `POST /api/git/...` routes must be unaffected.
 *   3. A locked method called from inside a held block *does* hang. This pins the hazard
 *      as real rather than hypothetical, so the unlocked variants cannot be "simplified"
 *      away by someone who assumes the mutex is re-entrant.
 *
 * Real repositories throughout: the behaviour under test is git's own (which options
 * exist, what exit codes mean), and a mock would encode whatever misunderstanding made
 * the deadlock possible. The bounded `Promise.race` is essential — a plain `await` on a
 * self-deadlock wedges the test runner instead of failing it, so a regression would look
 * like CI hanging rather than a red test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeLock } from "../../lib/async-mutex";
import { safeSpawn } from "../../lib/spawn";
import { gitService } from "../git-service";

const tempDirs: string[] = [];

async function git(args: string[], cwd: string): Promise<string> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
}

const SEED_FILE = "app.txt";

/** A repository with two commits on `main`, so `HEAD~1` and a revertable commit exist. */
async function createRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "nf-wtlock-"));
	tempDirs.push(dir);
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.email", "test@example.com"], dir);
	await git(["config", "user.name", "Test"], dir);
	writeFileSync(join(dir, SEED_FILE), "one\n");
	await git(["add", "-A"], dir);
	await git(["commit", "-m", "seed"], dir);
	writeFileSync(join(dir, SEED_FILE), "one\ntwo\n");
	await git(["add", "-A"], dir);
	await git(["commit", "-m", "second"], dir);
	return dir;
}

/**
 * How long a nested git write may take before we call it a deadlock.
 *
 * Pinned from both sides. It must exceed a slow-but-healthy run — these spawn real `git`
 * processes on whatever filesystem CI provides, and observed cases finish in under 120ms,
 * so 3s leaves over an order of magnitude of headroom. It must also stay *below* bun's 5s
 * per-test timeout, because otherwise bun kills the test first and reports a bare "timed
 * out" with no hint that a lock caused it.
 */
const NESTED_CALL_TIMEOUT_MS = 3_000;

/**
 * Deadline for the case that is *expected* to hang. Much shorter, since it is paid on
 * every green run, and no amount of waiting would change a self-deadlock's outcome.
 */
const EXPECTED_DEADLOCK_TIMEOUT_MS = 300;

class LockDeadlineError extends Error {}

/** Reject rather than hang if `fn` does not settle, so a deadlock fails the test. */
async function withinDeadline<T>(
	label: string,
	fn: () => Promise<T>,
	ms = NESTED_CALL_TIMEOUT_MS,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			fn(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new LockDeadlineError(
								`${label} did not settle within ${ms}ms while worktreeLock was held — ` +
									"a nested gitService write is waiting on a lock its own caller holds; " +
									"lock-holding callers must use the *Unlocked variant",
							),
						),
					ms,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Run `fn` the way production does: inside `worktreeLock` for the same worktree.
 *
 * The lock is taken with the *raw* path, matching every real caller, which is what makes
 * the key-normalization change part of what is under test.
 */
async function whileHoldingWorktreeLock<T>(
	worktreePath: string,
	label: string,
	fn: () => Promise<T>,
): Promise<T> {
	return worktreeLock.acquire(worktreePath, () => withinDeadline(label, fn));
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("gitService *Unlocked writes called while worktreeLock is held", () => {
	// One case per write method. Listed individually rather than looped over a name array
	// so each can set up the state its command requires — a `stashPop` with nothing
	// stashed or a `revertCommit` on an empty history would exit non-zero for reasons
	// unrelated to locking and mask the property under test.
	//
	// Each asserts a positive outcome, not merely that nothing threw: a no-op that
	// returned would satisfy a timeout check while doing none of the work.

	test("autoCommitUnlocked", async () => {
		const dir = await createRepo();
		writeFileSync(join(dir, SEED_FILE), "dirty\n");
		const sha = await whileHoldingWorktreeLock(dir, "autoCommitUnlocked", () =>
			gitService.autoCommitUnlocked(dir, "nested auto-commit"),
		);
		expect(sha).toBeTruthy();
		expect(await gitService.getStatus(dir)).toBe("");
	});

	test("stageAllUnlocked and unstageAllUnlocked", async () => {
		const dir = await createRepo();
		writeFileSync(join(dir, SEED_FILE), "dirty\n");
		await whileHoldingWorktreeLock(dir, "stageAll/unstageAll", async () => {
			await gitService.stageAllUnlocked(dir);
			expect(await git(["diff", "--cached", "--name-only"], dir)).toBe(SEED_FILE);
			await gitService.unstageAllUnlocked(dir);
			expect(await git(["diff", "--cached", "--name-only"], dir)).toBe("");
		});
	});

	test("stageFilesUnlocked and unstageFilesUnlocked", async () => {
		const dir = await createRepo();
		writeFileSync(join(dir, SEED_FILE), "dirty\n");
		await whileHoldingWorktreeLock(dir, "stageFiles/unstageFiles", async () => {
			await gitService.stageFilesUnlocked(dir, [SEED_FILE]);
			expect(await git(["diff", "--cached", "--name-only"], dir)).toBe(SEED_FILE);
			await gitService.unstageFilesUnlocked(dir, [SEED_FILE]);
			expect(await git(["diff", "--cached", "--name-only"], dir)).toBe("");
		});
	});

	test("commitUnlocked", async () => {
		const dir = await createRepo();
		writeFileSync(join(dir, SEED_FILE), "dirty\n");
		await git(["add", "-A"], dir);
		const sha = await whileHoldingWorktreeLock(dir, "commitUnlocked", () =>
			gitService.commitUnlocked(dir, "nested commit"),
		);
		expect(sha).toBeTruthy();
		expect(await git(["log", "-1", "--format=%s"], dir)).toBe("nested commit");
	});

	test("discardFilesUnlocked", async () => {
		const dir = await createRepo();
		writeFileSync(join(dir, SEED_FILE), "dirty\n");
		await whileHoldingWorktreeLock(dir, "discardFilesUnlocked", () =>
			gitService.discardFilesUnlocked(dir, [SEED_FILE]),
		);
		expect(await gitService.getStatus(dir)).toBe("");
	});

	test("discardAllUnlocked", async () => {
		const dir = await createRepo();
		writeFileSync(join(dir, SEED_FILE), "dirty\n");
		writeFileSync(join(dir, "extra.txt"), "untracked\n");
		await whileHoldingWorktreeLock(dir, "discardAllUnlocked", () =>
			gitService.discardAllUnlocked(dir),
		);
		expect(await gitService.getStatus(dir)).toBe("");
	});

	test("stashUnlocked, stashPopUnlocked and stashDropUnlocked", async () => {
		const dir = await createRepo();
		writeFileSync(join(dir, SEED_FILE), "dirty\n");
		await whileHoldingWorktreeLock(dir, "stash/stashPop/stashDrop", async () => {
			await gitService.stashUnlocked(dir, "nested stash");
			expect(await gitService.getStatus(dir)).toBe("");
			const popped = await gitService.stashPopUnlocked(dir);
			expect(popped.hasConflicts).toBe(false);
			// Re-stash so there is an entry for drop to remove.
			await gitService.stashUnlocked(dir, "nested stash again");
			await gitService.stashDropUnlocked(dir, 0);
			expect(await gitService.stashList(dir)).toEqual([]);
		});
	});

	test("resetSoftUnlocked", async () => {
		const dir = await createRepo();
		await whileHoldingWorktreeLock(dir, "resetSoftUnlocked", () =>
			gitService.resetSoftUnlocked(dir, "HEAD~1"),
		);
		expect(await git(["log", "-1", "--format=%s"], dir)).toBe("seed");
	});

	test("resetHardUnlocked", async () => {
		const dir = await createRepo();
		writeFileSync(join(dir, SEED_FILE), "dirty\n");
		const head = (await gitService.getHeadCommit(dir)).trim();
		await whileHoldingWorktreeLock(dir, "resetHardUnlocked", () =>
			gitService.resetHardUnlocked(dir, head),
		);
		expect(await gitService.getStatus(dir)).toBe("");
	});

	test("resetMergeUnlocked", async () => {
		const dir = await createRepo();
		// No target: resets to HEAD, which is what the `--no-commit` merge cleanup does.
		await whileHoldingWorktreeLock(dir, "resetMergeUnlocked", () =>
			gitService.resetMergeUnlocked(dir),
		);
		expect(await gitService.getStatus(dir)).toBe("");
	});

	test("cleanUntrackedUnlocked", async () => {
		const dir = await createRepo();
		writeFileSync(join(dir, "junk.txt"), "untracked\n");
		await whileHoldingWorktreeLock(dir, "cleanUntrackedUnlocked", () =>
			gitService.cleanUntrackedUnlocked(dir),
		);
		expect(await gitService.getStatus(dir)).toBe("");
	});

	test("revertCommitUnlocked", async () => {
		const dir = await createRepo();
		const head = (await gitService.getHeadCommit(dir)).trim();
		const sha = await whileHoldingWorktreeLock(dir, "revertCommitUnlocked", () =>
			gitService.revertCommitUnlocked(dir, head),
		);
		expect(sha).toBeTruthy();
		expect(await git(["show", `HEAD:${SEED_FILE}`], dir)).toBe("one");
	});

	test("revertMergeCommitUnlocked", async () => {
		const dir = await createRepo();
		// Build a real merge commit: the method passes `-m 1`, which git rejects outright
		// on a single-parent commit, so this cannot be faked.
		await git(["checkout", "-b", "side", "HEAD~1"], dir);
		writeFileSync(join(dir, "side.txt"), "side\n");
		await git(["add", "-A"], dir);
		await git(["commit", "-m", "side work"], dir);
		await git(["checkout", "main"], dir);
		await git(["merge", "--no-ff", "-m", "merge side", "side"], dir);

		const mergeSha = (await gitService.getHeadCommit(dir)).trim();
		const sha = await whileHoldingWorktreeLock(dir, "revertMergeCommitUnlocked", () =>
			gitService.revertMergeCommitUnlocked(dir, mergeSha),
		);
		expect(sha).toBeTruthy();
	});

	test("the full park sequence: resetHard then cleanUntracked under one holder", async () => {
		// The shape `snapshot-dirty-git-op.parkUncommittedWork` relies on. These two must
		// run adjacently under a single holder: a write landing between them would be
		// deleted by the clean without ever having been snapshotted.
		const dir = await createRepo();
		writeFileSync(join(dir, SEED_FILE), "dirty\n");
		writeFileSync(join(dir, "untracked.txt"), "junk\n");
		const head = (await gitService.getHeadCommit(dir)).trim();
		await whileHoldingWorktreeLock(dir, "park sequence", async () => {
			await gitService.resetHardUnlocked(dir, head);
			await gitService.cleanUntrackedUnlocked(dir);
		});
		expect(await gitService.getStatus(dir)).toBe("");
	});

	test("a path variant of the held worktree is still serialized, not deadlocked", async () => {
		// Both halves of the refactor interact here: normalization must make a
		// differently-spelled path hit the *same* key (so it queues instead of running
		// concurrently), while the nested unlocked write must still complete (so unifying
		// the instances did not turn queueing into self-deadlock).
		const dir = await createRepo();
		const variant = `${dir}/`;
		expect(worktreeLock.key(variant)).toBe(worktreeLock.key(dir));

		const order: string[] = [];
		const outer = worktreeLock.acquire(dir, async () => {
			order.push("outer-start");
			writeFileSync(join(dir, SEED_FILE), "dirty\n");
			await withinDeadline("autoCommitUnlocked under held lock", () =>
				gitService.autoCommitUnlocked(dir, "outer auto-commit"),
			);
			order.push("outer-end");
		});
		// Queued behind the holder via the variant spelling.
		const queued = worktreeLock.acquire(variant, async () => {
			order.push("variant");
		});

		await withinDeadline("outer holder", () => outer);
		await withinDeadline("queued variant", () => queued);
		expect(order).toEqual(["outer-start", "outer-end", "variant"]);
	});
});

describe("gitService locked writes for callers holding no lock", () => {
	// The public API must be unchanged for the plain route handlers, which take no lock of
	// their own. Splitting the methods could have left a wrapper calling the wrong body or
	// dropping the early-return guards, and none of that shows up in the tests above.

	test("locked wrappers still perform their work", async () => {
		const dir = await createRepo();
		writeFileSync(join(dir, SEED_FILE), "dirty\n");
		await gitService.stageAll(dir);
		expect(await git(["diff", "--cached", "--name-only"], dir)).toBe(SEED_FILE);
		const sha = await gitService.commit(dir, "locked commit");
		expect(sha).toBeTruthy();
		expect(await git(["log", "-1", "--format=%s"], dir)).toBe("locked commit");
		expect(await gitService.getStatus(dir)).toBe("");
	});

	test("empty file lists remain no-ops rather than staging everything", async () => {
		const dir = await createRepo();
		writeFileSync(join(dir, SEED_FILE), "dirty\n");
		// The early return lives in both the wrapper and the unlocked body. If the split had
		// dropped it from the body, `git add --` with no pathspec would stage the whole
		// worktree — a silent behaviour change rather than an error.
		await gitService.stageFiles(dir, []);
		await gitService.stageFilesUnlocked(dir, []);
		expect(await git(["diff", "--cached", "--name-only"], dir)).toBe("");
		await gitService.unstageFiles(dir, []);
		await gitService.unstageFilesUnlocked(dir, []);
		await gitService.discardFiles(dir, []);
		await gitService.discardFilesUnlocked(dir, []);
		// Nothing was discarded either.
		expect(await gitService.getStatus(dir)).not.toBe("");
	});

	test("concurrent locked writes on one worktree do not interleave", async () => {
		const dir = await createRepo();
		// What the lock is actually for. Two commits racing on one index would otherwise
		// produce `index.lock` contention or a commit containing the other's staged state.
		writeFileSync(join(dir, "a.txt"), "a\n");
		writeFileSync(join(dir, "b.txt"), "b\n");
		const results = await Promise.all([
			gitService.autoCommit(dir, "concurrent one"),
			gitService.autoCommit(dir, "concurrent two"),
		]);
		// Exactly one had changes to commit; the other found a clean tree and returned null.
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await gitService.getStatus(dir)).toBe("");
	});

	test("two distinct worktrees are not serialized against each other", async () => {
		const a = await createRepo();
		const b = await createRepo();
		// Normalization must not over-merge keys: serializing unrelated chapters' merges
		// would be a throughput regression invisible to every other test here.
		const holder = worktreeLock.acquire(a, () => new Promise<void>((r) => setTimeout(r, 200)));
		writeFileSync(join(b, SEED_FILE), "dirty\n");
		const sha = await withinDeadline("autoCommit on an unrelated worktree", () =>
			gitService.autoCommit(b, "independent"),
		);
		expect(sha).toBeTruthy();
		await holder;
	});
});

describe("the hazard the unlocked variants exist for", () => {
	test("a locked write makes no progress while its own caller holds the lock", async () => {
		const dir = await createRepo();
		writeFileSync(join(dir, SEED_FILE), "dirty\n");
		let innerSettled = false;

		// Deliberately the wrong call, to pin that the danger is real rather than
		// hypothetical. If someone makes `AsyncMutex` re-entrant or re-splits these methods,
		// this test fails and says so — at which point the `*Unlocked` variants can be
		// reconsidered on purpose instead of removed on an assumption.
		//
		// The waiter is *launched* inside the block and awaited outside it, which is what
		// makes the mechanism visible: the nested call is queued behind its own caller, so
		// it can only proceed once that caller returns. Production code awaits it inline
		// instead, so the caller never returns and the wait never ends — an HTTP request
		// that hangs forever with nothing thrown and nothing logged.
		let inner!: Promise<string | null>;
		await worktreeLock.acquire(dir, async () => {
			inner = gitService.autoCommit(dir, "queued behind its own caller");
			void inner.then(() => {
				innerSettled = true;
			});
			// Long enough that a non-blocked call would have finished several times over:
			// the *Unlocked cases above complete in well under 120ms.
			await new Promise((r) => setTimeout(r, EXPECTED_DEADLOCK_TIMEOUT_MS));
			expect(innerSettled).toBe(false);
		});

		// Only now, with the holder gone, can it run. Note this also means the orphaned
		// call is not cancelled — it eventually performs its write, out of order with
		// respect to whatever the holder did afterwards, which is its own hazard.
		expect(
			await withinDeadline("the queued write, after its caller returned", () => inner),
		).toBeTruthy();
	});
});
