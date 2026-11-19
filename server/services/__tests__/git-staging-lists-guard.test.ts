import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testEnvironment } from "../../../tests/preload";
import { safeSpawn } from "../../lib/spawn";
import { gitService } from "../git-service";

let root: string;
let preserved: string;
async function git(...args: string[]) {
	const result = await safeSpawn({
		cmd: ["git", "-C", root, ...args],
		timeout: 10_000,
		maxOutputBytes: 32_768,
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "Fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.test",
			GIT_COMMITTER_NAME: "Fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.test",
		},
	});
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return result.stdout;
}
beforeEach(async () => {
	root = await realpath(await mkdtemp(join(testEnvironment.isolatedHome, "ordinary-changelists-")));
	await git("init", "--quiet", "--initial-branch=main");
	await writeFile(join(root, "a"), "base\n");
	await git("add", "--", "a");
	await git("commit", "--quiet", "-m", "Base");
	await mkdir(join(root, ".narrafork", "git-staging", "write.lock"), { recursive: true });
	preserved = join(root, ".narrafork", "git-staging", "lists.json");
	await writeFile(preserved, "{preserved old metadata");
	await writeFile(
		join(root, ".narrafork", "git-staging", "write.lock", "owner.json"),
		"preserved owner",
	);
	await mkdir(join(root, ".git", "narrafork", "changelists", "indexes"), { recursive: true });
	await writeFile(
		join(root, ".git", "narrafork", "changelists", "lists.json"),
		"{independent metadata",
	);
	await git("update-ref", "refs/narrafork/staging-files/retained", "HEAD");
	await writeFile(join(root, "a"), "edited\n");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

test("ordinary add and unstage use the native index independently of list metadata and locks", async () => {
	await gitService.stageFiles(root, ["a"]);
	expect(await git("diff", "--cached", "--name-only")).toBe("a\n");
	await gitService.unstageFiles(root, ["a"]);
	expect(await git("diff", "--cached", "--name-only")).toBe("");
	expect(await readFile(preserved, "utf8")).toBe("{preserved old metadata");
	expect(
		await readFile(join(root, ".narrafork", "git-staging", "write.lock", "owner.json"), "utf8"),
	).toBe("preserved owner");
});

test("ordinary add-all keeps reserved internal data out of its index", async () => {
	await mkdir(join(root, ".narrafork", "user"));
	await writeFile(join(root, ".narrafork", "user", "notes"), "user file\n");
	await gitService.stageAll(root);
	const paths = await git("diff", "--cached", "--name-only");
	expect(paths).toContain("a\n");
	expect(paths).toContain(".narrafork/user/notes");
	expect(paths).not.toContain("git-staging");
	await expect(gitService.stageFiles(root, [".narrafork/git-staging/lists.json"])).rejects.toThrow(
		"internal state",
	);
});

test("ordinary native commit and stash preserve old metadata and private refs", async () => {
	const ref = await git("rev-parse", "refs/narrafork/staging-files/retained");
	await gitService.stageFiles(root, ["a"]);
	await gitService.commit(root, "Ordinary", {
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.test",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.test",
	});
	await writeFile(join(root, "a"), "stash content\n");
	await gitService.stash(root);
	expect(await readFile(preserved, "utf8")).toBe("{preserved old metadata");
	expect(await git("rev-parse", "refs/narrafork/staging-files/retained")).toBe(ref);
});

test("ordinary Git still respects the native index lock", async () => {
	await writeFile(join(root, ".git", "index.lock"), "native writer");
	await expect(gitService.stageFiles(root, ["a"])).rejects.toThrow();
	expect(await readFile(join(root, ".git", "index.lock"), "utf8")).toBe("native writer");
	expect(await readFile(preserved, "utf8")).toBe("{preserved old metadata");
});
