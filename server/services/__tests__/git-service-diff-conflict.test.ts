/**
 * The three git-level questions NarraFork answers wrongly when it answers them
 * silently: "what changed?", "will this merge?" and "is it safe to save?".
 *
 * Each of these had a failure mode that produced a *plausible* answer rather than an
 * error — an empty diff, a clean merge preview, a successful commit — so the cases
 * here assert on the positive shape (non-empty diff, conflict reported, commit
 * refused) instead of merely checking that nothing threw. Every one of those bugs
 * would pass a test that only checked for absence of exceptions.
 *
 * Real repositories throughout: the behaviour under test *is* git's behaviour
 * (which options exist, what exit codes mean, how `add -A` treats an unmerged path),
 * and a mock would only encode the misunderstanding that caused the bugs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError } from "../../lib/errors";
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

/** Same as `git()` but tolerates a non-zero exit, for commands expected to conflict. */
async function gitAllowFail(args: string[], cwd: string): Promise<number> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	return result.exitCode;
}

const SEED_FILE = "app.txt";
const SEED_CONTENT = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n";

/** A repository with one commit on `main`, nothing else. */
async function createRepo(prefix: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), `nf-${prefix}-`));
	tempDirs.push(dir);
	// -b main so the tests never depend on the host's init.defaultBranch.
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.email", "test@example.com"], dir);
	await git(["config", "user.name", "Test"], dir);
	writeFileSync(join(dir, SEED_FILE), SEED_CONTENT);
	await git(["add", "-A"], dir);
	await git(["commit", "-m", "seed"], dir);
	return dir;
}

/** Bytes that are unambiguously binary to git: a NUL early in the file. */
function binaryBlob(marker: number): Buffer {
	return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, marker, 0xff, 0x00, 0xfe]);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("git's own diff contract", () => {
	test("rejects --no-binary outright, and hides binary content without it", async () => {
		// Pins the two git facts the diff fix rests on, so that anyone reintroducing
		// `--no-binary` as a 'safety' flag sees why it cannot work. Asserted against
		// the real binary rather than against our wrapper, because the wrapper's
		// `silent` mode swallows exit codes — which is exactly how this shipped.
		const repo = await createRepo("git-contract");
		writeFileSync(join(repo, "blob.bin"), binaryBlob(0x01));
		await git(["add", "-A"], repo);
		await git(["commit", "-m", "add binary"], repo);
		writeFileSync(join(repo, "blob.bin"), binaryBlob(0x02));

		const rejected = await safeSpawn({
			cmd: ["git", "diff", "HEAD", "--no-binary", "-D", "--no-color"],
			cwd: repo,
			timeout: 15_000,
		});
		// Usage error: the option does not exist, so *nothing* is diffed.
		expect(rejected.exitCode).toBe(129);
		expect(rejected.stdout).toBe("");

		const accepted = await safeSpawn({
			cmd: ["git", "diff", "HEAD", "-D", "--no-color"],
			cwd: repo,
			timeout: 15_000,
		});
		expect(accepted.exitCode).toBe(0);
		expect(accepted.stdout).toContain("Binary files");
		expect(accepted.stdout).not.toContain("GIT binary patch");
	});
});

describe("getFullDiff", () => {
	test("returns the actual patch for uncommitted work", async () => {
		const repo = await createRepo("diff");
		writeFileSync(join(repo, SEED_FILE), SEED_CONTENT.replace("l5", "l5-edited"));

		const diff = await gitService.getFullDiff(repo);

		// The `--no-binary` bug made git exit 129 with no stdout, so this whole method
		// returned "" for every possible input. An emptiness check is the regression test.
		expect(diff).not.toBe("");
		expect(diff).toContain(`--- a/${SEED_FILE}`);
		expect(diff).toContain("+l5-edited");
		expect(diff).toContain("-l5");
	});

	test("includes staged, unstaged and untracked changes together", async () => {
		const repo = await createRepo("diff-all");
		writeFileSync(join(repo, "staged.txt"), "staged content\n");
		await git(["add", "staged.txt"], repo);
		writeFileSync(join(repo, SEED_FILE), SEED_CONTENT.replace("l1", "l1-unstaged"));
		writeFileSync(join(repo, "untracked.txt"), "untracked content\n");

		const diff = await gitService.getFullDiff(repo);

		expect(diff).toContain("+staged content");
		expect(diff).toContain("+l1-unstaged");
		expect(diff).toContain("+untracked content");
	});

	test("names changed binary files without inlining their bytes", async () => {
		const repo = await createRepo("diff-bin");
		writeFileSync(join(repo, "tracked.bin"), binaryBlob(0x01));
		await git(["add", "-A"], repo);
		await git(["commit", "-m", "add binary"], repo);

		// One tracked binary modified, one untracked binary added: the two branches of
		// getFullDiff handle binaries by different code paths (diff HEAD vs --no-index).
		writeFileSync(join(repo, "tracked.bin"), binaryBlob(0x02));
		writeFileSync(join(repo, "fresh.bin"), binaryBlob(0x03));
		writeFileSync(join(repo, SEED_FILE), SEED_CONTENT.replace("l2", "l2-text-edit"));

		const diff = await gitService.getFullDiff(repo);

		// Text still comes through — the point is that dropping `--no-binary` did not
		// require giving up on excluding binary content.
		expect(diff).toContain("+l2-text-edit");
		expect(diff).toContain("tracked.bin");
		expect(diff).toContain("fresh.bin");
		expect(diff).toContain("Binary files");
		// Git's own marker for "content was emitted", produced by `--binary`.
		expect(diff).not.toContain("GIT binary patch");
		// No NUL byte can survive into the diff unless raw bytes were inlined.
		expect(diff.includes("\0")).toBe(false);
	});
});

describe("getDiffBetweenRefs", () => {
	test("returns the patch between two commits", async () => {
		const repo = await createRepo("refs");
		const base = await git(["rev-parse", "HEAD"], repo);
		writeFileSync(join(repo, SEED_FILE), SEED_CONTENT.replace("l3", "l3-later"));
		writeFileSync(join(repo, "added.txt"), "brand new\n");
		await git(["add", "-A"], repo);
		await git(["commit", "-m", "later"], repo);
		const head = await git(["rev-parse", "HEAD"], repo);

		const diff = await gitService.getDiffBetweenRefs(repo, base, head);

		expect(diff).not.toBe("");
		expect(diff).toContain("+l3-later");
		expect(diff).toContain("+brand new");
	});
});

describe("mergeTree", () => {
	/** Two branches off one base, each editing `SEED_FILE` at the given line. */
	async function createDivergence(
		prefix: string,
		ourLine: string,
		theirLine: string,
	): Promise<{ repo: string; base: string }> {
		const repo = await createRepo(prefix);
		const base = await git(["rev-parse", "HEAD"], repo);

		await git(["checkout", "-b", "ours"], repo);
		writeFileSync(join(repo, SEED_FILE), SEED_CONTENT.replace(ourLine, `${ourLine}-OURS`));
		await git(["commit", "-am", "ours"], repo);

		await git(["checkout", "main"], repo);
		await git(["checkout", "-b", "theirs"], repo);
		writeFileSync(join(repo, SEED_FILE), SEED_CONTENT.replace(theirLine, `${theirLine}-THEIRS`));
		await git(["commit", "-am", "theirs"], repo);

		return { repo, base };
	}

	test("reports the conflicting path when both sides edit the same line", async () => {
		// Same line on both sides: git cannot pick a winner.
		const { repo, base } = await createDivergence("mt-conflict", "l5", "l5");

		const result = await gitService.mergeTree(repo, base, "ours", "theirs");

		expect(result.hasConflicts).toBe(true);
		expect(result.conflictFiles).toContain(SEED_FILE);
	});

	test("agrees with what a real merge does", async () => {
		// The preview is only worth anything if it predicts the merge, so assert the
		// two against each other rather than trusting the preview on its own.
		const { repo, base } = await createDivergence("mt-agree", "l5", "l5");
		const preview = await gitService.mergeTree(repo, base, "ours", "theirs");

		await git(["checkout", "ours"], repo);
		const mergeExit = await gitAllowFail(["merge", "theirs"], repo);

		expect(preview.hasConflicts).toBe(true);
		expect(mergeExit).not.toBe(0);
		expect(await gitService.getConflictFiles(repo)).toEqual(preview.conflictFiles);
	});

	test("reports no conflict for edits git can combine", async () => {
		// Far-apart edits to the same file: mergeable, and the case the old parser got
		// right only by accident, since it reported "clean" no matter what.
		const { repo, base } = await createDivergence("mt-clean", "l1", "l10");

		const result = await gitService.mergeTree(repo, base, "ours", "theirs");

		expect(result.hasConflicts).toBe(false);
		expect(result.conflictFiles).toEqual([]);

		// And the real merge succeeds, which is the promise "no conflicts" makes.
		await git(["checkout", "ours"], repo);
		expect(await gitAllowFail(["merge", "theirs"], repo)).toBe(0);
	});

	test("reports a conflict when the two sides disagree about deleting a file", async () => {
		// Modify/delete has no content hunks at all, so it exercises conflict detection
		// through the exit code rather than through diff text.
		const repo = await createRepo("mt-delete");
		writeFileSync(join(repo, "doomed.txt"), "original\n");
		await git(["add", "-A"], repo);
		await git(["commit", "-m", "add doomed"], repo);
		const base = await git(["rev-parse", "HEAD"], repo);

		await git(["checkout", "-b", "ours"], repo);
		writeFileSync(join(repo, "doomed.txt"), "edited by ours\n");
		await git(["commit", "-am", "ours edits"], repo);

		await git(["checkout", "main"], repo);
		await git(["checkout", "-b", "theirs"], repo);
		await git(["rm", "doomed.txt"], repo);
		await git(["commit", "-m", "theirs deletes"], repo);

		const result = await gitService.mergeTree(repo, base, "ours", "theirs");

		expect(result.hasConflicts).toBe(true);
	});

	test("does not touch either worktree", async () => {
		const { repo, base } = await createDivergence("mt-pure", "l5", "l5");
		const before = await git(["rev-parse", "HEAD"], repo);

		await gitService.mergeTree(repo, base, "ours", "theirs");

		expect(await git(["rev-parse", "HEAD"], repo)).toBe(before);
		expect(await git(["status", "--porcelain"], repo)).toBe("");
	});
});

describe("autoCommit", () => {
	test("refuses to commit while conflicts are unresolved", async () => {
		const repo = await createRepo("auto-uu");
		await git(["checkout", "-b", "ours"], repo);
		writeFileSync(join(repo, SEED_FILE), SEED_CONTENT.replace("l5", "l5-OURS"));
		await git(["commit", "-am", "ours"], repo);
		await git(["checkout", "main"], repo);
		await git(["checkout", "-b", "theirs"], repo);
		writeFileSync(join(repo, SEED_FILE), SEED_CONTENT.replace("l5", "l5-THEIRS"));
		await git(["commit", "-am", "theirs"], repo);
		await git(["checkout", "ours"], repo);
		expect(await gitAllowFail(["merge", "theirs"], repo)).not.toBe(0);
		expect(await git(["status", "--porcelain"], repo)).toContain("UU");
		const headBefore = await git(["rev-parse", "HEAD"], repo);

		// Must throw, not return null: a caller that sees null concludes "nothing to
		// save", whereas the error tells it (and the user) why the save was skipped.
		await expect(gitService.autoCommit(repo, "dormant save")).rejects.toThrow(GitError);

		// And nothing was committed, so the markers stay visible for resolution.
		expect(await git(["rev-parse", "HEAD"], repo)).toBe(headBefore);
		expect(await git(["status", "--porcelain"], repo)).toContain("UU");
	});

	test("refuses when the conflict is a delete both sides disagree about", async () => {
		// UD/AA never produce `<<<<<<<` markers, so a marker-grep guard would miss them.
		const repo = await createRepo("auto-ud");
		writeFileSync(join(repo, "doomed.txt"), "original\n");
		await git(["add", "-A"], repo);
		await git(["commit", "-m", "add doomed"], repo);

		await git(["checkout", "-b", "ours"], repo);
		writeFileSync(join(repo, "doomed.txt"), "edited by ours\n");
		await git(["commit", "-am", "ours edits"], repo);
		await git(["checkout", "main"], repo);
		await git(["checkout", "-b", "theirs"], repo);
		await git(["rm", "doomed.txt"], repo);
		await git(["commit", "-m", "theirs deletes"], repo);
		await git(["checkout", "ours"], repo);
		expect(await gitAllowFail(["merge", "theirs"], repo)).not.toBe(0);

		await expect(gitService.autoCommit(repo, "dormant save")).rejects.toThrow(
			/unresolved merge conflicts/,
		);
	});

	test("names the unresolved files so the caller can explain the refusal", async () => {
		const repo = await createRepo("auto-names");
		await git(["checkout", "-b", "ours"], repo);
		writeFileSync(join(repo, "shared.txt"), "ours\n");
		await git(["add", "-A"], repo);
		await git(["commit", "-m", "ours"], repo);
		await git(["checkout", "main"], repo);
		await git(["checkout", "-b", "theirs"], repo);
		writeFileSync(join(repo, "shared.txt"), "theirs\n");
		await git(["add", "-A"], repo);
		await git(["commit", "-m", "theirs"], repo);
		await git(["checkout", "ours"], repo);
		await gitAllowFail(["merge", "theirs"], repo);

		await expect(gitService.autoCommit(repo, "dormant save")).rejects.toThrow(/shared\.txt/);
	});

	test("still commits ordinary dirty state", async () => {
		// The guard must not turn every unattended save into a failure.
		const repo = await createRepo("auto-clean");
		writeFileSync(join(repo, SEED_FILE), SEED_CONTENT.replace("l2", "l2-work"));
		writeFileSync(join(repo, "new.txt"), "new work\n");

		const sha = await gitService.autoCommit(repo, "dormant save");

		expect(sha).toBeTruthy();
		expect(await git(["status", "--porcelain"], repo)).toBe("");
		expect(await git(["log", "-1", "--pretty=%s"], repo)).toBe("dormant save");
	});

	test("returns null when there is nothing to save", async () => {
		const repo = await createRepo("auto-noop");
		expect(await gitService.autoCommit(repo, "dormant save")).toBeNull();
	});
});

describe("getCommitCount", () => {
	test("counts commits on the requested ref", async () => {
		const repo = await createRepo("count");
		writeFileSync(join(repo, "second.txt"), "second\n");
		await git(["add", "-A"], repo);
		await git(["commit", "-m", "second"], repo);

		expect(await gitService.getCommitCount(repo)).toBe(2);
	});

	test("reports 0 for a repository with no commits", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nf-count-empty-"));
		tempDirs.push(dir);
		await git(["init", "-b", "main"], dir);

		expect(await gitService.getCommitCount(dir)).toBe(0);
		// The named-branch form too: a freshly imported project is queried by its
		// default branch, which does not exist yet as a ref. Treating that as an error
		// would make every empty project fail to load.
		expect(await gitService.getCommitCount(dir, "main")).toBe(0);
	});

	test("counts a <sha>..<branch> range, which cursor pagination relies on", async () => {
		// The ruler timeline passes a range, not a plain ref, to locate a cursor's
		// absolute position. Making failures throw must not turn that ordinary call
		// into an error, so the range form is pinned here.
		const repo = await createRepo("count-range");
		const first = await git(["rev-parse", "HEAD"], repo);
		for (const n of [2, 3]) {
			writeFileSync(join(repo, `c${n}.txt`), `commit ${n}\n`);
			await git(["add", "-A"], repo);
			await git(["commit", "-m", `commit ${n}`], repo);
		}

		expect(await gitService.getCommitCount(repo, `${first}..main`)).toBe(2);
		// An empty range is a real answer, not a failure.
		expect(await gitService.getCommitCount(repo, "main..main")).toBe(0);
	});

	test("throws for an unreachable cursor rather than reporting position zero", async () => {
		// A bogus cursor would otherwise silently resolve to index 0 and page the
		// timeline from the wrong end. ruler.ts catches this and falls back to
		// skip-based loading, which it can only do if it is told.
		const repo = await createRepo("count-badrange");

		await expect(gitService.getCommitCount(repo, "deadbeef..main")).rejects.toThrow(GitError);
	});

	test("reports 0 for a branch that does not exist in a repository that has commits", async () => {
		// Previously threw, and the throw was reached by real projects rather than by
		// mistakes: `project.defaultBranch` says `main` while the repository's commits are
		// on `master` (an import, a rename, a deleted branch). `hasNoCommits` only
		// recognises an unborn HEAD, so it said false and this became a GitError — inside a
		// `Promise.all` in `routes/ruler.ts` with no catch, so the whole `/ruler` endpoint
		// returned 500 and the timeline would not open at all. Answering 0 restores the
		// pre-throw behaviour for this case (a page that opens showing no commits) without
		// giving up the distinction from a broken git, which still throws below.
		const repo = await createRepo("count-otherbranch");
		await git(["branch", "-m", "main", "master"], repo);

		expect(await gitService.getCommitCount(repo, "main")).toBe(0);
		// The repository itself is fine, which is the whole point of separating the cases.
		expect(await gitService.getCommitCount(repo, "master")).toBe(1);
		expect(await gitService.getCommitCount(repo, "no/such/branch")).toBe(0);
	});

	test("throws when git cannot answer at all, rather than reporting zero", async () => {
		// The distinction the old `|| 0` erased and that the missing-ref case must not
		// re-erase: a directory that is not a repository fails every command, and reporting
		// "0 commits" for it is a plausible-looking lie.
		const notARepo = mkdtempSync(join(tmpdir(), "nf-count-notrepo-"));
		tempDirs.push(notARepo);

		await expect(gitService.getCommitCount(notARepo, "main")).rejects.toThrow(GitError);
		await expect(gitService.getCommitCount(notARepo)).rejects.toThrow(GitError);
	});
});

describe("getCommitFiles", () => {
	test("reports a rename as one entry, not an add plus a delete", async () => {
		const repo = await createRepo("files-rename");
		await git(["mv", SEED_FILE, "renamed.txt"], repo);
		writeFileSync(join(repo, "renamed.txt"), `${SEED_CONTENT}l11\n`);
		await git(["add", "-A"], repo);
		await git(["commit", "-m", "rename with a tweak"], repo);
		const sha = await git(["rev-parse", "HEAD"], repo);

		const files = await gitService.getCommitFiles(repo, sha);

		expect(files).toHaveLength(1);
		expect(files[0].status).toBe("renamed");
		expect(files[0].path).toBe("renamed.txt");
		expect(files[0].oldPath).toBe(SEED_FILE);
		// The phantom entry the mismatched flags produced: the old path listed as a
		// separate "modified" file that no longer exists in the commit.
		expect(files.map((f) => f.path)).not.toContain(SEED_FILE);
	});

	test("classifies add, modify and delete in one commit", async () => {
		const repo = await createRepo("files-mixed");
		writeFileSync(join(repo, "gone.txt"), "will be deleted\n");
		await git(["add", "-A"], repo);
		await git(["commit", "-m", "add gone"], repo);

		writeFileSync(join(repo, SEED_FILE), SEED_CONTENT.replace("l4", "l4-changed"));
		writeFileSync(join(repo, "fresh.txt"), "added\n");
		await git(["rm", "gone.txt"], repo);
		await git(["add", "-A"], repo);
		await git(["commit", "-m", "mixed"], repo);
		const sha = await git(["rev-parse", "HEAD"], repo);

		const byPath = new Map(
			(await gitService.getCommitFiles(repo, sha)).map((f) => [f.path, f.status]),
		);

		expect(byPath.get(SEED_FILE)).toBe("modified");
		expect(byPath.get("fresh.txt")).toBe("added");
		expect(byPath.get("gone.txt")).toBe("deleted");
	});

	test("keeps non-ASCII paths intact", async () => {
		// Without `-z` git octal-escapes these, so the numstat and name-status maps
		// never matched and the status fell back to "modified".
		const repo = await createRepo("files-cjk");
		writeFileSync(join(repo, "中文文件.txt"), "内容\n");
		await git(["add", "-A"], repo);
		await git(["commit", "-m", "cjk"], repo);
		const sha = await git(["rev-parse", "HEAD"], repo);

		const files = await gitService.getCommitFiles(repo, sha);

		expect(files).toHaveLength(1);
		expect(files[0].path).toBe("中文文件.txt");
		expect(files[0].status).toBe("added");
	});
});
