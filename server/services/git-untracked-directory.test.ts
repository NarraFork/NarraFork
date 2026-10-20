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
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError, UnbornHeadError } from "../lib/errors";
import { logger } from "../lib/logger";
import * as spawn from "../lib/spawn";
import { safeSpawn } from "../lib/spawn";
import { gitService, withGitRequestContext } from "./git-service";
import { getStatusSummaryCached } from "./git-status-cache";
import { clearGitStatusQueries } from "./git-status-query";

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

describe("status diagnostics", () => {
	for (const outcome of ["success", "error", "cancelled"] as const) {
		test(`diagnostics preserve service ${outcome} results`, async () => {
			clearGitStatusQueries();
			let now = 0;
			const clock = spyOn(performance, "now").mockImplementation(() => now);
			const warn = spyOn(logger, "warn").mockImplementation(() => {});
			const controller = new AbortController();
			const failure = new Error("diagnostic fixture failure");
			const spawnSpy = spyOn(spawn, "safeSpawn").mockImplementation(async (options) => {
				if (options.cmd.includes("status")) {
					now = 1500;
					if (outcome === "error") throw failure;
					if (outcome === "cancelled") controller.abort(failure);
					options.stdoutStream?.onChunk(new TextEncoder().encode("?? file\0"));
				}
				return {
					stdout: options.cmd.includes("symbolic-ref") ? "main" : "",
					stderr: "",
					exitCode: 0,
				};
			});
			try {
				const result = await withGitRequestContext(controller.signal, () =>
					gitService.getStatusSummary(process.cwd(), { ttlMs: 0 }),
				).catch((error: unknown) => error);
				// Cancellation rejects its reader before the underlying siblings finish.
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (outcome === "success") {
					expect(result).toMatchObject({ branch: "main", totalFiles: 1 });
					const detail = warn.mock.calls.find(
						([message]) => message === "Slow Git status query",
					)?.[1];
					expect(detail).toMatchObject({
						scopeId: expect.stringMatching(/^[0-9a-f]{16}$/),
						commandWallMs: {
							prefix: expect.any(Number),
							status: expect.any(Number),
							head: expect.any(Number),
							branch: expect.any(Number),
						},
						peakCommandTasks: 4,
						metadataMaxOutputBytes: 4096,
						stream: { parsedBytes: 8, maxBytes: 1024 * 1024 },
					});
				} else expect(result).toBe(failure);
				const coordinated = warn.mock.calls.find(
					([message]) => message === "Slow coordinated Git status",
				)?.[1];
				expect(coordinated).toMatchObject({ outcome, queueMs: 0, loaderMs: 1500 });
				expect(JSON.stringify(warn.mock.calls)).not.toContain(process.cwd());
			} finally {
				clearGitStatusQueries();
				spawnSpy.mockRestore();
				clock.mockRestore();
				warn.mockRestore();
			}
		});
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

	test("scopes lightweight paths to a narrator cwd below the repository root", async () => {
		const repo = await makeRepo();
		const subdir = join(repo, "sub");
		mkdirSync(subdir);
		writeFileSync(join(subdir, "inside.txt"), "base\n");
		writeFileSync(join(repo, "outside.txt"), "base\n");
		await git(["add", "."], repo);
		await git(["commit", "-q", "-m", "add scoped files"], repo);

		writeFileSync(join(subdir, "inside.txt"), "base\ninside\n");
		writeFileSync(join(subdir, "new.txt"), "one\ntwo\n");
		writeFileSync(join(repo, "outside.txt"), "base\noutside\n");

		const summary = await gitService.getStatusSummary(subdir);
		const paths = summary.files.map((file) => file.path).sort();

		expect(paths).toEqual(["inside.txt", "new.txt"]);
		expect(summary.files.find((file) => file.path === "inside.txt")).toEqual({
			status: " M",
			path: "inside.txt",
		});
		expect(summary.files.find((file) => file.path === "new.txt")).toEqual({
			status: "??",
			path: "new.txt",
		});
		expect(summary.linesAdded).toBeUndefined();
		expect(summary.linesRemoved).toBeUndefined();
		expect(summary.totalFiles).toBe(2);
		expect(summary.totalFilesExact).toBe(true);
	});

	test("a nested directory sharing the cwd name keeps its correct relative path", async () => {
		const repo = await makeRepo();
		const subdir = join(repo, "sub");
		mkdirSync(join(subdir, "sub"), { recursive: true });
		writeFileSync(join(subdir, "sub", "x.txt"), "one\ntwo\n");
		writeFileSync(join(subdir, "y.txt"), "three\n");

		const summary = await gitService.getStatusSummary(subdir);
		const paths = summary.files.map((file) => file.path).sort();

		// Porcelain paths are root-relative; remove the cwd prefix exactly once.
		expect(paths).toEqual(["sub/x.txt", "y.txt"]);
		expect(summary.files.find((file) => file.path === "sub/x.txt")).toEqual({
			status: "??",
			path: "sub/x.txt",
		});
	});

	test("cache and direct readers share real status processes and fresh overrides bypass settled results", async () => {
		const repo = await makeRepo();
		writeNested(repo);
		const spawnSpy = spyOn(Bun, "spawn");
		const statusCalls = () =>
			spawnSpy.mock.calls.filter(([cmd]) => Array.isArray(cmd) && cmd.includes("status")).length;
		try {
			const results = await Promise.all(
				Array.from({ length: 12 }, (_, index) =>
					index % 2 ? gitService.getStatusSummary(repo) : getStatusSummaryCached(repo),
				),
			);
			expect(statusCalls()).toBe(1);
			for (const summary of results) expect(summary.totalFiles).toBe(3);
			await getStatusSummaryCached(repo);
			expect(statusCalls()).toBe(1);
			writeFileSync(join(repo, "another.txt"), "new\n");
			expect((await gitService.getStatusSummary(repo)).totalFiles).toBe(3);
			expect(statusCalls()).toBe(1);
			expect((await gitService.getStatusSummary(repo, { ttlMs: 0 })).totalFiles).toBe(4);
			expect(statusCalls()).toBe(2);
		} finally {
			spawnSpy.mockRestore();
		}
	});

	test("a failed status waits for cancelled sibling subprocesses to finish", async () => {
		const repo = await makeRepo();
		const started = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let metadataCount = 0;
		let abortCount = 0;
		let settled = false;
		const spawnSpy = spyOn(spawn, "safeSpawn").mockImplementation(async (options) => {
			if (options.cmd.includes("status")) {
				await started.promise;
				throw new Error("status process failed");
			}
			metadataCount++;
			options.signal?.addEventListener(
				"abort",
				() => {
					if (++abortCount === 3) aborted.resolve();
				},
				{ once: true },
			);
			if (metadataCount === 3) started.resolve();
			await release.promise;
			return { stdout: "", stderr: "", exitCode: 143 };
		});
		const query = gitService.getStatusSummary(repo).then(
			() => {
				settled = true;
				return undefined;
			},
			(error: unknown) => {
				settled = true;
				return error;
			},
		);
		try {
			await aborted.promise;
			expect(abortCount).toBe(3);
			expect(settled).toBe(false);
			release.resolve();
			expect(await query).toEqual(new Error("status process failed"));
		} finally {
			release.resolve();
			await query;
			spawnSpy.mockRestore();
		}
	});

	test("summary launches only status and metadata and never reads file contents", async () => {
		const repo = await makeRepo();
		writeNested(repo);
		const commands: string[][] = [];
		const originalSpawn = spawn.safeSpawn;
		const spawnSpy = spyOn(spawn, "safeSpawn").mockImplementation((options) => {
			commands.push(options.cmd);
			return originalSpawn(options);
		});
		const readSpy = spyOn(Bun, "file").mockImplementation(() => {
			throw new Error("Status must not read file contents");
		});
		try {
			const summary = await gitService.getStatusSummary(repo);
			expect(summary.totalFiles).toBe(3);
			expect(readSpy).not.toHaveBeenCalled();
			expect(commands).toHaveLength(4);
			for (const cmd of commands) {
				expect(
					cmd.includes("status") || cmd.includes("rev-parse") || cmd.includes("symbolic-ref"),
				).toBe(true);
				expect(cmd).not.toContain("diff");
				expect(cmd).not.toContain("ls-files");
				expect(cmd).not.toContain("--numstat");
			}
		} finally {
			spawnSpy.mockRestore();
			readSpy.mockRestore();
		}
	});

	test("unborn repositories preserve branch and staged/untracked status without line counts", async () => {
		const repo = mkdtempSync(join(tmpdir(), "nf-unborn-status-"));
		tempDirs.push(repo);
		await git(["init", "-q", "-b", "fresh"], repo);
		writeFileSync(join(repo, "staged.txt"), "staged\n");
		writeFileSync(join(repo, "untracked.txt"), "untracked\n");
		await git(["add", "staged.txt"], repo);
		const summary = await gitService.getStatusSummary(repo);
		expect(summary).toMatchObject({
			headSha: "",
			branch: "fresh",
			staged: 1,
			untracked: 1,
			totalFilesExact: true,
		});
		expect(summary.files).toEqual([
			{ status: "A ", path: "staged.txt" },
			{ status: "??", path: "untracked.txt" },
		]);
		const errors = spyOn(logger, "error");
		try {
			expect(await gitService.getCurrentBranch(repo)).toBe("fresh");
			await expect(gitService.getHeadCommit(repo)).rejects.toBeInstanceOf(UnbornHeadError);
			expect(errors.mock.calls.some((call) => call[0] === "git command failed")).toBe(false);
		} finally {
			errors.mockRestore();
		}
	});

	test("a directory that is not a git repository is not an unborn HEAD", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nf-not-a-repo-"));
		tempDirs.push(dir);
		const errors = spyOn(logger, "error");
		const assertGitFailure = async (run: Promise<unknown>) => {
			const error = await run.then(
				() => {
					throw new Error("expected a git failure");
				},
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(GitError);
			expect(error).not.toBeInstanceOf(UnbornHeadError);
		};
		try {
			await assertGitFailure(gitService.getHeadCommit(dir));
			await assertGitFailure(gitService.getCurrentBranch(dir));
			expect(errors.mock.calls.filter((call) => call[0] === "git command failed")).toHaveLength(2);
		} finally {
			errors.mockRestore();
		}
	});

	test("subdirectory renames preserve both paths including UTF-8 and whitespace", async () => {
		const repo = await makeRepo();
		const subdir = join(repo, "sub");
		mkdirSync(subdir);
		writeFileSync(join(subdir, "旧 文件.txt"), "base\n");
		await git(["add", "."], repo);
		await git(["commit", "-q", "-m", "rename base"], repo);
		await git(["mv", "旧 文件.txt", "新 文件.txt"], subdir);
		const summary = await gitService.getStatusSummary(subdir);
		expect(summary.files).toEqual([{ status: "R ", path: "新 文件.txt", oldPath: "旧 文件.txt" }]);
		expect(summary.totalFilesExact).toBe(true);
	});

	test("detached HEAD still reports HEAD and a commit SHA", async () => {
		const repo = await makeRepo();
		await git(["checkout", "--detach", "-q"], repo);
		const summary = await gitService.getStatusSummary(repo);
		expect(summary.branch).toBe("HEAD");
		expect(summary.headSha).toMatch(/^[0-9a-f]{40}$/);
		expect(await gitService.getCurrentBranch(repo)).toBe("HEAD");
		expect(await gitService.getHeadCommit(repo)).toBe(summary.headSha);
		expect(summary.hasChanges).toBe(false);
		expect(summary.totalFilesExact).toBe(true);
	});

	test("details truncate at 200 while an exhaustive total remains exact", async () => {
		const repo = await makeRepo();
		for (let index = 0; index < 205; index++) writeFileSync(join(repo, `file-${index}`), "x\n");
		const summary = await gitService.getStatusSummary(repo);
		expect(summary.files).toHaveLength(200);
		expect(summary.totalFiles).toBe(205);
		expect(summary.untracked).toBe(205);
		expect(summary.truncated).toBe(true);
		expect(summary.totalFilesExact).toBe(true);
	});

	test("scan budget stops at 10000 files and exposes a lower bound", async () => {
		const repo = await makeRepo();
		for (let index = 0; index < 10005; index++) writeFileSync(join(repo, `file-${index}`), "x\n");
		const summary = await gitService.getStatusSummary(repo);
		expect(summary.files).toHaveLength(200);
		expect(summary.totalFiles).toBe(10000);
		expect(summary.truncated).toBe(true);
		expect(summary.totalFilesExact).toBe(false);
	});

	test("real merge conflicts retain their porcelain status", async () => {
		const repo = await makeRepo();
		await git(["checkout", "-q", "-b", "side"], repo);
		writeFileSync(join(repo, "tracked.txt"), "side\n");
		await git(["commit", "-qam", "side"], repo);
		await git(["checkout", "-q", "main"], repo);
		writeFileSync(join(repo, "tracked.txt"), "main\n");
		await git(["commit", "-qam", "main"], repo);
		await git(["merge", "side"], repo);
		const summary = await gitService.getStatusSummary(repo);
		expect(summary.files).toEqual([{ status: "UU", path: "tracked.txt" }]);
		expect(summary.totalFilesExact).toBe(true);
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
