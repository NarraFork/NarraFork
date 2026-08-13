/**
 * Untracked DIRECTORIES must never reach a consumer as a single entry.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 * `git status --porcelain` collapses an untracked directory by default: a new
 * `src/feature/` holding three files is reported as ONE line, `?? src/feature/`.
 * Every consumer in this codebase treats a porcelain entry as a file path, so
 * that single line became:
 *   - a FILE row named `feature` with an `A` badge in the git panel, with the
 *     three real files missing entirely (the tree splits on "/" and discards the
 *     empty trailing segment);
 *   - an unreadable `Bun.file()` target in `copyDirtyFiles`, silently dropping
 *     the whole folder from a review worktree;
 *   - a `git clean -f -- src/feature/` target in `discardFiles`, which deletes
 *     every sibling when the user asked to discard one file.
 *
 * These run against real git repositories because the behaviour under test is
 * git's own listing semantics — a mocked `execRead` would just assert that we
 * pass a flag, not that the flag does what we believe.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeSpawn } from "../lib/spawn";
import { gitService } from "./git-service";

// Windows' first `safeSpawn` performs the one-time inheritable-handle scan. On a
// busy machine that alone can exceed Bun's 5-second default test timeout; killing
// the setup command mid-`git init` would turn the following assertions into noise.
setDefaultTimeout(30_000);

const tempDirs: string[] = [];

async function git(args: string[], cwd: string): Promise<string> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	return result.stdout.trim();
}

/** A repo with one commit, so HEAD exists and status has a baseline. */
async function makeRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "nf-untracked-dir-"));
	tempDirs.push(dir);
	await git(["init", "-q", "-b", "main"], dir);
	await git(["config", "user.email", "test@example.com"], dir);
	await git(["config", "user.name", "Test"], dir);
	writeFileSync(join(dir, "tracked.txt"), "base\n");
	await git(["add", "tracked.txt"], dir);
	await git(["commit", "-q", "-m", "init"], dir);
	return dir;
}

function writeNested(repo: string) {
	mkdirSync(join(repo, "newdir", "sub"), { recursive: true });
	writeFileSync(join(repo, "newdir", "a.txt"), "a\n");
	writeFileSync(join(repo, "newdir", "sub", "b.txt"), "b\n");
	writeFileSync(join(repo, "loose.txt"), "loose\n");
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
});

describe("untracked directories are expanded to files", () => {
	test("git itself collapses them without -uall (the behaviour being defended against)", async () => {
		const repo = await makeRepo();
		writeNested(repo);

		const collapsed = await git(["status", "--porcelain"], repo);

		// This is the raw git behaviour the service must not expose. If a future git
		// changes its default, this assertion fails and the guard below can be
		// revisited rather than silently becoming a no-op.
		expect(collapsed.split("\n")).toContain("?? newdir/");
	});

	test("getStatus lists every file inside a new directory, never the directory", async () => {
		const repo = await makeRepo();
		writeNested(repo);

		const paths = (await gitService.getStatus(repo))
			.split("\n")
			.filter(Boolean)
			.map((line) => line.slice(3));

		expect(paths).toContain("newdir/a.txt");
		expect(paths).toContain("newdir/sub/b.txt");
		expect(paths).toContain("loose.txt");
		// The directory entry itself must be gone: it is what the panel rendered as
		// a file, and what `Bun.file()` could not read.
		expect(paths).not.toContain("newdir/");
		expect(paths.some((path) => path.endsWith("/"))).toBe(false);
	});

	test("getStatusSummary counts and lists the files, not one directory", async () => {
		const repo = await makeRepo();
		writeNested(repo);

		const summary = await gitService.getStatusSummary(repo);
		const paths = summary.files.map((file) => file.path);

		expect(paths).toContain("newdir/a.txt");
		expect(paths).toContain("newdir/sub/b.txt");
		expect(paths).not.toContain("newdir/");
		// Three untracked FILES, not two entries (`loose.txt` + a folder).
		expect(summary.untracked).toBe(3);
		expect(summary.totalFiles).toBe(3);
	});

	test("still honours .gitignore, so expansion cannot leak ignored output", async () => {
		const repo = await makeRepo();
		writeNested(repo);
		mkdirSync(join(repo, "build"), { recursive: true });
		writeFileSync(join(repo, "build", "out.js"), "generated\n");
		writeFileSync(join(repo, ".gitignore"), "build/\n");

		const paths = (await gitService.getStatus(repo))
			.split("\n")
			.filter(Boolean)
			.map((line) => line.slice(3));

		// Enumerating a directory ourselves would have required reimplementing these
		// semantics; letting git expand keeps them for free.
		expect(paths.some((path) => path.startsWith("build/"))).toBe(false);
		expect(paths).toContain("newdir/a.txt");
	});

	test("getFileDiff resolves a file inside a brand-new directory as untracked", async () => {
		const repo = await makeRepo();
		writeNested(repo);

		const { diff } = await gitService.getFileDiff(repo, "newdir/a.txt");

		// Collapsed status would not identify this path as untracked, so the service
		// would fall through to `git diff --` and return nothing at all.
		expect(diff).not.toBe("");
		expect(diff).toContain("+a");
	});

	test("discarding one file in a new directory leaves its siblings alone", async () => {
		const repo = await makeRepo();
		writeNested(repo);

		await gitService.discardFiles(repo, ["newdir/a.txt"]);

		const remaining = (await gitService.getStatus(repo))
			.split("\n")
			.filter(Boolean)
			.map((line) => line.slice(3));

		expect(remaining).not.toContain("newdir/a.txt");
		// The destructive version of this bug: `git clean -f -- newdir/` would have
		// taken this file too.
		expect(remaining).toContain("newdir/sub/b.txt");
	});
});
