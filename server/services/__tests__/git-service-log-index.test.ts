/**
 * Locating a commit for pagination: `git log` ORDER vs reachability COUNT.
 *
 * The ruler pages its commit backbone with `git log --skip=N`, and to continue from a
 * cursor it needs that cursor's index in the SAME walk. It used to compute the index as
 * `rev-list --count <cursor>..<branch>` — "how many commits are reachable from the branch
 * but not from the cursor". Those two numbers are not the same measurement:
 *
 *   - `git log` sorts by commit DATE by default.
 *   - `rev-list --count A..B` is the SIZE OF A SET (reachable from B, not from A).
 *
 * They agree only on a strictly linear history. Any merge brings in commits that are dated
 * BEFORE the cursor while not being its ancestors: `git log` places them after the cursor,
 * the range count includes them, and the count therefore overshoots the index. Paging with
 * the overshoot starts the next page too far in, and the skipped commits are returned by NO
 * page at all — in the Ruler that meant a chapter anchored to one of them had no tick and
 * was reported as "start commit is not on this branch", with no way to load it.
 *
 * A real repository throughout: the behaviour under test is git's own ordering, and a mock
 * would just re-encode the assumption that produced the bug. (The route test suite mocks
 * `getCommitCount` to a constant, which is exactly why it could not see this.)
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Commit with an explicit author/committer date, so the ordering under test is deterministic. */
async function commitAt(dir: string, message: string, isoDate: string): Promise<void> {
	writeFileSync(join(dir, `${message}.txt`), `${message}\n`);
	await git(["add", "-A"], dir);
	await git(
		["-c", `user.name=Test`, "-c", "user.email=test@example.com", "commit", "-m", message],
		dir,
	);
	// Rewrite both dates: `git log` reads the COMMITTER date for ordering, and `--date`
	// alone would only move the author date.
	await git(["commit", "--amend", "--no-edit", `--date=${isoDate}`], dir);
	await git(
		["-c", `user.name=Test`, "-c", "user.email=test@example.com", "commit", "--amend", "--no-edit"],
		dir,
	);
}

async function createRepo(prefix: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), `nf-${prefix}-`));
	tempDirs.push(dir);
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.email", "test@example.com"], dir);
	await git(["config", "user.name", "Test"], dir);
	await git(["config", "commit.gpgsign", "false"], dir);
	return dir;
}

/**
 * A history where date order and ancestry disagree.
 *
 *   main:  seed ── A(t3) ────────── M(t5, merge)
 *                    └─ side: S(t1), S2(t2) ──┘
 *
 * `git log main` orders by date: M, A, S2, S, seed. So A sits at index 1, while
 * `rev-list --count A..main` is 3 (M, S2, S) — S and S2 are dated BEFORE A but are not its
 * ancestors. That gap of 2 is the bug, reproduced at minimum size.
 */
async function createMergedHistory(): Promise<string> {
	const dir = await createRepo("logindex");
	await commitAt(dir, "seed", "2020-01-01T00:00:00Z");
	await git(["checkout", "-b", "side"], dir);
	await commitAt(dir, "S", "2020-01-02T00:00:00Z");
	await commitAt(dir, "S2", "2020-01-03T00:00:00Z");
	await git(["checkout", "main"], dir);
	await commitAt(dir, "A", "2020-01-04T00:00:00Z");
	// --no-ff so the merge commit exists even though the branches could fast-forward.
	await git(
		[
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"merge",
			"--no-ff",
			"-m",
			"M",
			"side",
		],
		dir,
	);
	return dir;
}

/** The sha at a given `git log` index, read the same way the ruler's pages are. */
async function shaAtLogIndex(dir: string, index: number): Promise<string> {
	const log = await gitService.getLog(dir, { limit: 1, skip: index, branch: "main" });
	const sha = log[0]?.sha;
	if (!sha) throw new Error(`no commit at log index ${index}`);
	return sha;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("findCommitLogIndex", () => {
	test("[REGRESSION] returns the log position, not the reachability count", async () => {
		const dir = await createMergedHistory();
		const target = await shaAtLogIndex(dir, 1); // "A"

		const index = await gitService.findCommitLogIndex(dir, target, { branch: "main" });
		const rangeCount = await gitService.getCommitCount(dir, `${target}..main`);

		expect(index).toBe(1);
		// The two measurements genuinely disagree here — without that this test would pass
		// against the old implementation and prove nothing.
		expect(rangeCount).toBeGreaterThan(1);
	});

	test("agrees with the count on a linear history (why the bug hid so long)", async () => {
		const dir = await createRepo("linear");
		await commitAt(dir, "c1", "2020-01-01T00:00:00Z");
		await commitAt(dir, "c2", "2020-01-02T00:00:00Z");
		await commitAt(dir, "c3", "2020-01-03T00:00:00Z");
		const target = await shaAtLogIndex(dir, 1); // "c2"

		expect(await gitService.findCommitLogIndex(dir, target, { branch: "main" })).toBe(1);
		expect(await gitService.getCommitCount(dir, `${target}..main`)).toBe(1);
	});

	test("every index round-trips: index → sha → index", async () => {
		const dir = await createMergedHistory();
		const all = await gitService.getLog(dir, { limit: 100, skip: 0, branch: "main" });

		for (let i = 0; i < all.length; i++) {
			expect(await gitService.findCommitLogIndex(dir, all[i].sha, { branch: "main" })).toBe(i);
		}
	});

	test("paging from the resolved index loses no commit and repeats none", async () => {
		// The property the ruler actually needs: page 1 + page 2 == one continuous walk.
		const dir = await createMergedHistory();
		const pageSize = 2;
		const page1 = await gitService.getLog(dir, { limit: pageSize, skip: 0, branch: "main" });
		const cursor = page1.at(-1)?.sha;
		if (!cursor) throw new Error("empty first page");

		const cursorIndex = await gitService.findCommitLogIndex(dir, cursor, { branch: "main" });
		expect(cursorIndex).not.toBeNull();
		const page2 = await gitService.getLog(dir, {
			limit: pageSize,
			skip: (cursorIndex as number) + 1,
			branch: "main",
		});

		const continuous = await gitService.getLog(dir, {
			limit: pageSize * 2,
			skip: 0,
			branch: "main",
		});
		expect([...page1, ...page2].map((c) => c.sha)).toEqual(continuous.map((c) => c.sha));
	});

	test("a sha outside the walk is null, not a guessed position", async () => {
		// Rewritten history / another ref / a deleted branch all land here. The route keeps
		// its requested `skip` rather than paging from a position it does not have.
		const dir = await createMergedHistory();

		expect(await gitService.findCommitLogIndex(dir, "0".repeat(40), { branch: "main" })).toBeNull();
		expect(await gitService.findCommitLogIndex(dir, "", { branch: "main" })).toBeNull();
	});

	test("resolves an abbreviated sha, which would otherwise silently page from 0", async () => {
		const dir = await createMergedHistory();
		const full = await shaAtLogIndex(dir, 1);

		expect(await gitService.findCommitLogIndex(dir, full.slice(0, 8), { branch: "main" })).toBe(1);
	});

	test("stops at searchLimit instead of scanning an unbounded history", async () => {
		const dir = await createMergedHistory();
		const deep = await shaAtLogIndex(dir, 3);

		// Within the limit it resolves; with a limit that cannot reach it, null — the caller
		// then falls back to skip-based paging rather than paying an unbounded main-thread scan.
		expect(await gitService.findCommitLogIndex(dir, deep, { branch: "main" })).toBe(3);
		expect(
			await gitService.findCommitLogIndex(dir, deep, { branch: "main", searchLimit: 2 }),
		).toBeNull();
	});
});
