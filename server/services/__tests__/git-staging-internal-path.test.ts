import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GIT_STAGING_EXCLUDE_PATHSPEC, isGitStagingInternalPath } from "../git-staging-files";

const exec = promisify(execFile);
for (const platform of ["darwin", "win32"]) {
	test(`the ${platform} exclusion omits case-variant metadata during ordinary staging`, async () => {
		const module = new URL("../git-staging-files.ts", import.meta.url).href;
		const { stdout } = await exec(
			process.execPath,
			[
				"-e",
				`Object.defineProperty(process, "platform", {value: ${JSON.stringify(platform)}}); console.log((await import(${JSON.stringify(module)})).GIT_STAGING_EXCLUDE_PATHSPEC);`,
			],
			{ timeout: 10_000, maxBuffer: 4096 },
		);
		const root = await mkdtemp(join(tmpdir(), "nf-case-exclusion-"));
		const git = (...args: string[]) =>
			exec("git", args, { cwd: root, timeout: 10_000, maxBuffer: 4096 });
		try {
			await git("init", "--quiet");
			await mkdir(join(root, ".NarraFork", "Git-Staging"), { recursive: true });
			await writeFile(join(root, ".NarraFork", "Git-Staging", "private"), "internal");
			await writeFile(join(root, ".NarraFork", "user.md"), "user data");
			await git("add", "--all", "--", ".", stdout.trim());
			expect((await git("diff", "--cached", "--name-only")).stdout.trim()).toBe(
				".NarraFork/user.md",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("ordinary Git keeps the root-anchored internal-data exclusion", () => {
	expect(GIT_STAGING_EXCLUDE_PATHSPEC).toBe(
		process.platform === "win32" || process.platform === "darwin"
			? ":(top,exclude,icase,glob)[.]narrafork/git-staging/**"
			: ":(top,exclude,glob)[.]narrafork/git-staging/**",
	);
	for (const path of [
		".narrafork/git-staging",
		".narrafork/git-staging/lists.json",
		"./.narrafork/git-staging/indexes/frozen.index",
		"././.narrafork/git-staging/execution/pending.json",
	])
		expect(isGitStagingInternalPath(path)).toBe(true);
});

test("the internal-data exclusion leaves other user files available", () => {
	for (const path of [
		".narrafork/plans/change.md",
		".narrafork/git-staging-notes.txt",
		"nested/.narrafork/git-staging/lists.json",
		"git-staging/lists.json",
		"file.txt",
	])
		expect(isGitStagingInternalPath(path)).toBe(false);
});
