import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeSpawn } from "../lib/spawn";
import type { GitWorkspaceTarget } from "./git-workspace";
import { changedGitCategories, probeGitWatch } from "./git-workspace-watch";

test("real linked worktree: idle, equal-length edits, staging, commits and older stash removal", async () => {
	const directory = await mkdtemp(join(tmpdir(), "git-push-integration-"));
	const repository = join(directory, "repo");
	const linked = join(directory, "linked");
	const git = async (cwd: string, ...args: string[]) => {
		const result = await safeSpawn({
			cmd: ["git", "-C", cwd, ...args],
			timeout: 5000,
			maxOutputBytes: 32 * 1024,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Test",
				GIT_AUTHOR_EMAIL: "test@example.test",
				GIT_COMMITTER_NAME: "Test",
				GIT_COMMITTER_EMAIL: "test@example.test",
			},
		});
		if (result.exitCode !== 0) throw new Error(result.stderr);
	};
	try {
		await git(directory, "init", repository);
		await writeFile(join(repository, "file"), "base\n");
		await git(repository, "add", "file");
		await git(repository, "commit", "-m", "fixture");
		await git(repository, "worktree", "add", "-b", "linked", linked);
		const target = {
			workspace: { rootPath: linked },
			backend: { kind: "local" },
		} as GitWorkspaceTarget;
		const probe = () => probeGitWatch(target, new AbortController().signal);
		let previous = await probe();
		expect(changedGitCategories(previous, await probe())).toEqual([]);
		await writeFile(join(linked, "file"), "edit\n");
		let next = await probe();
		expect(changedGitCategories(previous, next)).toEqual(["worktree"]);
		previous = next;
		await writeFile(join(linked, "file"), "more\n");
		next = await probe();
		expect(changedGitCategories(previous, next)).toEqual(["worktree"]);
		previous = next;
		await git(linked, "add", "file");
		next = await probe();
		expect(changedGitCategories(previous, next)).toContain("index");
		expect(changedGitCategories(previous, next)).not.toContain("refs");
		previous = next;
		await git(linked, "commit", "-m", "linked change");
		next = await probe();
		expect(changedGitCategories(previous, next)).toContain("refs");
		for (const content of ["stash one\n", "stash two\n"]) {
			await writeFile(join(linked, "file"), content);
			await git(linked, "stash", "push", "-m", content.trim());
		}
		previous = await probe();
		await git(linked, "stash", "drop", "stash@{1}");
		expect(changedGitCategories(previous, await probe())).toEqual(["stash"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 20_000);
