/**
 * Read-only ref questions on real temporary repositories: merge-base, is-ancestor,
 * ahead/behind against an arbitrary base, uncommitted changes, upstream reachability,
 * and the bounds (output cap, timeout) every one of them runs under.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError, ValidationError } from "../../lib/errors";
import { safeSpawn } from "../../lib/spawn";
import {
	assertQueryRef,
	countCommitsOnlyReachableFrom,
	type GitQueryRunner,
	isAncestor,
	uncommittedChanges,
} from "../git-ref-queries";
import { gitService } from "../git-service";

const tempDirs: string[] = [];

async function git(args: string[], cwd: string): Promise<string> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	if (result.exitCode !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

async function commit(dir: string, file: string, text: string, message: string) {
	writeFileSync(join(dir, file), text);
	await git(["add", "-A"], dir);
	await git(["commit", "-q", "-m", message], dir);
	return git(["rev-parse", "HEAD"], dir);
}

/**
 * main: seed ─ m1 ─ m2
 *          └─ f1 ─ f2 ─ f3   (feature)
 */
async function createRepo() {
	const dir = mkdtempSync(join(tmpdir(), "nf-refq-"));
	tempDirs.push(dir);
	await git(["init", "-q", "-b", "main"], dir);
	await git(["config", "user.email", "test@example.com"], dir);
	await git(["config", "user.name", "Test"], dir);
	const seed = await commit(dir, "seed.txt", "seed\n", "seed");
	await git(["checkout", "-q", "-b", "feature"], dir);
	await commit(dir, "f.txt", "1\n", "f1");
	await commit(dir, "f.txt", "2\n", "f2");
	const feature = await commit(dir, "f.txt", "3\n", "f3");
	await git(["checkout", "-q", "main"], dir);
	await commit(dir, "m.txt", "1\n", "m1");
	const main = await commit(dir, "m.txt", "2\n", "m2");
	return { dir, seed, feature, main };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ref queries", () => {
	test("resolveCommit resolves names and refuses option-shaped or range revisions", async () => {
		const { dir, feature } = await createRepo();
		expect(await gitService.resolveCommit(dir, "feature")).toBe(feature);
		expect(await gitService.resolveCommit(dir, "missing-branch")).toBeNull();
		for (const bad of ["--output=/tmp/x", "main..feature", "main feature", "a\nb", ""])
			await expect(gitService.resolveCommit(dir, bad)).rejects.toBeInstanceOf(ValidationError);
		expect(() => assertQueryRef("origin/main~2")).not.toThrow();
	});

	test("merge-base finds the fork point and reports unrelated histories as null", async () => {
		const { dir, seed, feature, main } = await createRepo();
		expect(await gitService.getMergeBase(dir, feature, main)).toBe(seed);
		await git(["checkout", "-q", "--orphan", "island"], dir);
		await git(["rm", "-rq", "--cached", "."], dir);
		const island = await commit(dir, "island.txt", "x\n", "island");
		expect(await gitService.getMergeBase(dir, island, main)).toBeNull();
		await expect(gitService.getMergeBase(dir, "main", main)).rejects.toBeInstanceOf(
			ValidationError,
		);
	});

	test("is-ancestor answers both ways and fails loudly on a missing object", async () => {
		const { dir, seed, feature, main } = await createRepo();
		expect(await gitService.isAncestor(dir, seed, feature)).toBe(true);
		expect(await gitService.isAncestor(dir, feature, feature)).toBe(true);
		expect(await gitService.isAncestor(dir, feature, main)).toBe(false);
		await expect(gitService.isAncestor(dir, "f".repeat(40), main)).rejects.toBeInstanceOf(GitError);
	});

	test("ahead/behind is measured against an arbitrary base, not the upstream", async () => {
		const { dir, seed, feature, main } = await createRepo();
		expect(await gitService.getAheadBehind(dir, feature, main)).toEqual({ ahead: 3, behind: 2 });
		expect(await gitService.getAheadBehind(dir, feature, seed)).toEqual({ ahead: 3, behind: 0 });
		expect(await gitService.getAheadBehind(dir, main, feature)).toEqual({ ahead: 2, behind: 3 });
	});

	test("commits not in the base or the upstream", async () => {
		const { dir, seed, feature, main } = await createRepo();
		expect(await gitService.countCommitsNotIn(dir, feature, [main])).toBe(3);
		expect(await gitService.countCommitsNotIn(dir, seed, [main])).toBe(0);
		expect(await gitService.getBranchUpstream(dir, "feature")).toBeNull();
		// A fake remote-tracking ref two commits into the feature branch.
		const f2 = await git(["rev-parse", "feature~1"], dir);
		await git(["remote", "add", "origin", join(dir, "unused-remote")], dir);
		await git(["update-ref", "refs/remotes/origin/feature", f2], dir);
		await git(["config", "branch.feature.remote", "origin"], dir);
		await git(["config", "branch.feature.merge", "refs/heads/feature"], dir);
		const upstream = await gitService.getBranchUpstream(dir, "feature");
		expect(upstream).toEqual({ ref: "refs/remotes/origin/feature", sha: f2 });
		expect(await gitService.countCommitsNotIn(dir, feature, [main, f2])).toBe(1);
		// An upstream that was never fetched is not evidence of anything.
		await git(["update-ref", "-d", "refs/remotes/origin/feature"], dir);
		expect(await gitService.getBranchUpstream(dir, "feature")).toBeNull();
	});

	test("commits only a detached tip reaches: no branch, remote ref or tag holds them", async () => {
		const { dir, feature, main } = await createRepo();
		const run = (args: string[]) =>
			safeSpawn({ cmd: ["git", ...args], cwd: dir, timeout: 15_000, maxOutputBytes: 4096 }).then(
				(result) => ({ ...result, truncated: false }),
			);
		expect(await countCommitsOnlyReachableFrom(run, feature)).toBe(0);
		await git(["checkout", "-q", "--detach", main], dir);
		const loose = await commit(dir, "loose.txt", "x\n", "loose");
		expect(await countCommitsOnlyReachableFrom(run, loose)).toBe(1);
		await git(["tag", "keep", loose], dir);
		expect(await countCommitsOnlyReachableFrom(run, loose)).toBe(0);
	});

	test("uncommitted changes count modified, staged, renamed and untracked paths", async () => {
		const { dir } = await createRepo();
		expect(await gitService.getUncommittedChanges(dir)).toEqual({ count: 0, exact: true });
		writeFileSync(join(dir, "m.txt"), "changed\n");
		await git(["mv", "seed.txt", "renamed.txt"], dir);
		mkdirSync(join(dir, "new-dir"));
		writeFileSync(join(dir, "new-dir", "a.txt"), "a\n");
		writeFileSync(join(dir, "new-dir", "b.txt"), "b\n");
		writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
		writeFileSync(join(dir, "ignored.log"), "not a loss\n");
		// m.txt, renamed.txt (one record with its origin), new-dir/a, new-dir/b, .gitignore
		expect(await gitService.getUncommittedChanges(dir)).toEqual({ count: 5, exact: true });
	});

	test("the output cap turns the count into a lower bound instead of a wrong number", async () => {
		const { dir } = await createRepo();
		for (let index = 0; index < 200; index++)
			writeFileSync(join(dir, `untracked-${String(index).padStart(3, "0")}.txt`), "x");
		const capped = await gitService.getUncommittedChanges(dir, { maxOutputBytes: 512 });
		expect(capped.exact).toBe(false);
		expect(capped.count).toBeGreaterThan(0);
		expect(capped.count).toBeLessThan(200);
		expect(await gitService.getUncommittedChanges(dir)).toEqual({ count: 200, exact: true });
	});

	test("a timed-out query throws instead of answering", async () => {
		const { dir, feature, main } = await createRepo();
		// A killed process exits with a signal status. That is never "not an ancestor".
		const killed: GitQueryRunner = async () => ({ stdout: "", stderr: "", exitCode: 143 });
		await expect(isAncestor(killed, feature, main)).rejects.toBeInstanceOf(GitError);
		await expect(uncommittedChanges(killed)).rejects.toBeInstanceOf(GitError);
		// A real stall: the fsmonitor hook keeps `git status` waiting well past the budget.
		await git(["config", "core.fsmonitor", "sleep 1; false"], dir);
		await expect(gitService.getUncommittedChanges(dir, { timeout: 100 })).rejects.toBeInstanceOf(
			GitError,
		);
	});

	test("a truncated scalar answer is rejected, not parsed", async () => {
		const { dir, feature } = await createRepo();
		await expect(
			gitService.resolveCommit(dir, feature, { maxOutputBytes: 8 }),
		).rejects.toBeInstanceOf(GitError);
	});
});
