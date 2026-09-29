/**
 * Commit preview against real repositories: the behaviour under test is Git's own
 * output for root, merge, rename, binary and oddly named files, so a mock would
 * only restate the assumptions being checked.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeSpawn } from "../../lib/spawn";
import { gitService } from "../git-service";

const tempDirs: string[] = [];
afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function git(args: string[], cwd: string): Promise<string> {
	// Host GIT_AUTHOR_* variables outrank `-c user.name`, so pin the identity in env.
	const identity = {
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
	};
	const result = await safeSpawn({
		cmd: ["git", ...args],
		cwd,
		timeout: 15_000,
		env: { ...process.env, ...identity },
	});
	if (result.exitCode !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

async function commitAll(dir: string, message: string): Promise<string> {
	await git(["add", "-A"], dir);
	await git(["commit", "--allow-empty", "-m", message], dir);
	return git(["rev-parse", "HEAD"], dir);
}

async function repo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "nf-commit-preview-"));
	tempDirs.push(dir);
	await git(["init", "-b", "main"], dir);
	await git(["config", "core.autocrlf", "false"], dir);
	return dir;
}

describe("gitService.getCommitDetail", () => {
	test("root commit lists every file as added against the empty tree", async () => {
		const dir = await repo();
		writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
		writeFileSync(join(dir, "名 字 space.txt"), "x\n");
		const sha = await commitAll(dir, "root\n\nbody line");
		const detail = await gitService.getCommitDetail(dir, sha);
		expect(detail.sha).toBe(sha);
		expect(detail.parents).toEqual([]);
		expect(detail.comparedTo).toBeNull();
		expect(detail.message).toBe("root\n\nbody line");
		expect(detail.authorName).toBe("Test");
		expect(detail.files).toEqual([
			{ path: "a.txt", status: "added", linesAdded: 2, linesRemoved: 0, binary: false },
			{ path: "名 字 space.txt", status: "added", linesAdded: 1, linesRemoved: 0, binary: false },
		]);
		expect(detail.filesTruncated).toBe(false);
		const patch = await gitService.getCommitPatch(dir, sha, "名 字 space.txt");
		expect(patch.diff).toContain("+x");
		expect(patch.diff).toContain("名 字 space.txt");
	});

	test("rename, delete, binary and a later-deleted path remain previewable", async () => {
		const dir = await repo();
		writeFileSync(
			join(dir, "old.txt"),
			"same content that makes rename detection certain\n".repeat(5),
		);
		writeFileSync(join(dir, "gone.txt"), "bye\n");
		await commitAll(dir, "base");
		await git(["mv", "old.txt", "new.txt"], dir);
		rmSync(join(dir, "gone.txt"));
		writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
		const sha = await commitAll(dir, "change");
		// Delete the renamed file afterwards: history must not depend on the worktree.
		rmSync(join(dir, "new.txt"));
		await commitAll(dir, "later");

		const detail = await gitService.getCommitDetail(dir, sha);
		const byPath = Object.fromEntries(detail.files.map((file) => [file.path, file]));
		expect(byPath["new.txt"]).toMatchObject({ status: "renamed", oldPath: "old.txt" });
		expect(byPath["gone.txt"]).toMatchObject({ status: "deleted", linesRemoved: 1 });
		expect(byPath["blob.bin"]).toMatchObject({
			status: "added",
			binary: true,
			linesAdded: null,
			linesRemoved: null,
		});
		expect(byPath["old.txt"]).toBeUndefined();

		const rename = await gitService.getCommitPatch(dir, sha, "new.txt", "old.txt");
		expect(rename.diff).toContain("rename from old.txt");
		expect(rename.diff).toContain("rename to new.txt");
		const binary = await gitService.getCommitPatch(dir, sha, "blob.bin");
		expect(binary.diff).toContain("Binary files");
	});

	test("merge commit is compared with its first parent", async () => {
		const dir = await repo();
		writeFileSync(join(dir, "base.txt"), "base\n");
		await commitAll(dir, "base");
		await git(["checkout", "-b", "side"], dir);
		writeFileSync(join(dir, "side.txt"), "side\n");
		await commitAll(dir, "side");
		await git(["checkout", "main"], dir);
		writeFileSync(join(dir, "main.txt"), "main\n");
		const firstParent = await commitAll(dir, "main");
		await git(["merge", "--no-ff", "-m", "merge side", "side"], dir);
		const merge = await git(["rev-parse", "HEAD"], dir);

		const detail = await gitService.getCommitDetail(dir, merge);
		expect(detail.parents).toHaveLength(2);
		expect(detail.comparedTo).toBe(firstParent);
		expect(detail.files.map((file) => file.path)).toEqual(["side.txt"]);
		expect((await gitService.getCommitPatch(dir, merge, "side.txt")).diff).toContain("+side");
	});

	test("empty commit has metadata and no files", async () => {
		const dir = await repo();
		writeFileSync(join(dir, "a.txt"), "a\n");
		await commitAll(dir, "base");
		const sha = await commitAll(dir, "empty");
		const detail = await gitService.getCommitDetail(dir, sha);
		expect(detail.files).toEqual([]);
		expect(detail.message).toBe("empty");
	});

	test("unknown commits, foreign paths and directories are refused", async () => {
		const dir = await repo();
		writeFileSync(join(dir, "a.txt"), "a\n");
		const base = await commitAll(dir, "base");
		writeFileSync(join(dir, "dir-a.txt"), "x\n");
		await git(["add", "-A"], dir);
		await git(["commit", "-m", "two"], dir);
		const sha = await git(["rev-parse", "HEAD"], dir);
		await expect(gitService.getCommitDetail(dir, "0".repeat(40))).rejects.toMatchObject({
			statusCode: 404,
			code: "GIT_COMMIT_NOT_FOUND",
		});
		await expect(gitService.getCommitDetail(dir, "HEAD")).rejects.toMatchObject({
			statusCode: 400,
		});
		await expect(gitService.getCommitPatch(dir, sha, "a.txt")).rejects.toMatchObject({
			statusCode: 404,
			code: "GIT_COMMIT_FILE_NOT_FOUND",
		});
		// A tree object is not a commit.
		const tree = await git(["rev-parse", `${base}^{tree}`], dir);
		await expect(gitService.getCommitDetail(dir, tree)).rejects.toMatchObject({ statusCode: 404 });
		// Glob characters are literal, never a pattern over the commit.
		await expect(gitService.getCommitPatch(dir, sha, "*.txt")).rejects.toMatchObject({
			statusCode: 404,
		});
	});

	test("large patches are truncated at the output budget", async () => {
		const dir = await repo();
		writeFileSync(join(dir, "big.txt"), `${"line of text\n".repeat(30_000)}`);
		const sha = await commitAll(dir, "big");
		const patch = await gitService.getCommitPatch(dir, sha, "big.txt");
		expect(patch.truncated).toBe(true);
		expect(patch.diff.length).toBeLessThanOrEqual(200_000);
	});
});

describe("commit preview boundaries", () => {
	test("rejects directories and forged rename sources before producing any patch", async () => {
		const dir = await repo();
		mkdirSync(join(dir, "folder"));
		writeFileSync(join(dir, "folder/only.txt"), "one\n");
		writeFileSync(join(dir, "old.txt"), "rename content\n".repeat(20));
		await commitAll(dir, "base");
		await git(["mv", "old.txt", "new.txt"], dir);
		writeFileSync(join(dir, "folder/only.txt"), "changed\n");
		const sha = await commitAll(dir, "change");
		for (const path of ["folder", ".", "missing"])
			await expect(gitService.getCommitPatch(dir, sha, path)).rejects.toMatchObject({
				statusCode: 404,
			});
		await expect(
			gitService.getCommitPatch(dir, sha, "missing", "folder/only.txt"),
		).rejects.toMatchObject({ statusCode: 404 });
		await expect(
			gitService.getCommitPatch(dir, sha, "new.txt", "folder/only.txt"),
		).rejects.toMatchObject({ statusCode: 400 });
		// Caller need not supply the source: it is derived from the actual entry.
		expect((await gitService.getCommitPatch(dir, sha, "new.txt")).diff).toContain(
			"rename from old.txt",
		);
	});

	test("does not include descendants of a rename source that became a directory", async () => {
		const dir = await repo();
		writeFileSync(join(dir, "old"), "rename content\n".repeat(20));
		await commitAll(dir, "base");
		await git(["mv", "old", "new"], dir);
		mkdirSync(join(dir, "old"));
		writeFileSync(join(dir, "old/extra.txt"), "unrelated descendant\n");
		const sha = await commitAll(dir, "rename and new directory");
		await expect(gitService.getCommitPatch(dir, sha, "new", "old")).rejects.toMatchObject({
			statusCode: 400,
		});
	});

	test("keeps staged/unstaged changes and HEAD byte-identical", async () => {
		const dir = await repo();
		writeFileSync(join(dir, "file.txt"), "initial\n");
		const sha = await commitAll(dir, "base");
		writeFileSync(join(dir, "file.txt"), "staged\n");
		await git(["add", "--", "file.txt"], dir);
		writeFileSync(join(dir, "file.txt"), "worktree only\n");
		const index = readFileSync(join(dir, ".git/index"));
		await gitService.getCommitDetail(dir, sha);
		expect((await gitService.getCommitPatch(dir, sha, "file.txt")).diff).toContain("+initial");
		expect(readFileSync(join(dir, ".git/index"))).toEqual(index);
		expect(readFileSync(join(dir, "file.txt"), "utf8")).toBe("worktree only\n");
		expect(await git(["rev-parse", "HEAD"], dir)).toBe(sha);
	});

	test("mode-only change and a file list above 1000 have explicit results", async () => {
		const dir = await repo();
		writeFileSync(join(dir, "script.sh"), "exit 0\n");
		await commitAll(dir, "base");
		await git(["update-index", "--chmod=+x", "script.sh"], dir);
		await git(["commit", "-m", "mode only"], dir);
		const mode = await git(["rev-parse", "HEAD"], dir);
		expect((await gitService.getCommitPatch(dir, mode, "script.sh")).diff).toContain(
			"new mode 100755",
		);
		for (let i = 0; i < 1001; i++) writeFileSync(join(dir, `${i}.txt`), "x\n");
		const sha = await commitAll(dir, "many files");
		const result = await gitService.getCommitDetail(dir, sha);
		expect(result.files).toHaveLength(1000);
		expect(result.filesTruncated).toBe(true);
	}, 30000);
});
