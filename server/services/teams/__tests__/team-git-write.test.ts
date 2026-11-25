/**
 * The git a team merge writes (M), against real repositories: `merge-tree` + `commit-tree` with
 * the person's identity and signing from the host's configuration only, the private ref, the
 * fast-forward of an unchecked-out base (refused when it is checked out or not a fast-forward),
 * and nothing of the repository's own (hooks, custom merge drivers, signing programs) running.
 * The host's global git configuration is replaced by a temporary one for the whole file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEAM_MERGE_CONFLICTS_MAX } from "@shared/project-teams";
import { safeSpawn } from "../../../lib/spawn";
import { configuredPrograms, teamGit } from "../team-git";
import {
	fastForwardCommand,
	gitVersion,
	signingConfig,
	supportsMergeTree,
	teamRepoGit,
} from "../team-git-write";

let temporary: string;
let repo: string;
let globalConfig: string;
const HOST_USER = "[user]\n\tname = Host\n\temail = host@e.test\n";
const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;

async function git(args: string[], cwd = repo) {
	const result = await safeSpawn({
		cmd: ["git", "-C", cwd, ...args],
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "T",
			GIT_AUTHOR_EMAIL: "t@e.test",
			GIT_COMMITTER_NAME: "T",
			GIT_COMMITTER_EMAIL: "t@e.test",
		},
		timeout: 20_000,
		maxOutputBytes: 1024 * 1024,
	});
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

async function commitFile(file: string, text: string, message: string, cwd = repo) {
	await mkdir(join(cwd, file, ".."), { recursive: true });
	await writeFile(join(cwd, file), text);
	await git(["add", "--", file], cwd);
	await git(["commit", "-qm", message], cwd);
	return git(["rev-parse", "HEAD"], cwd);
}

/** main with one commit, a feature branch with its own commit; main checked out. */
async function forkedRepo() {
	await commitFile("a.txt", "a\n", "base");
	await git(["checkout", "-qb", "feature"]);
	const head = await commitFile("feature.txt", "feature\n", "feature");
	await git(["checkout", "-q", "main"]);
	const base = await commitFile("main.txt", "main\n", "main moves");
	return { head, base };
}

beforeAll(async () => {
	temporary = await mkdtemp(join(tmpdir(), "nf-team-git-write-"));
	globalConfig = join(temporary, "gitconfig");
	await writeFile(globalConfig, `${HOST_USER}[commit]\n\tgpgsign = false\n`);
	process.env.GIT_CONFIG_GLOBAL = globalConfig;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(async () => {
	if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
	if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
	else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
	await rm(temporary, { recursive: true, force: true });
});

beforeEach(async () => {
	await writeFile(globalConfig, `${HOST_USER}[commit]\n\tgpgsign = false\n`);
	repo = await mkdtemp(join(temporary, "repo-"));
	await git(["init", "-q", "-b", "main"]);
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

describe("team git writes", () => {
	test("this git computes merges in the object store", async () => {
		expect(supportsMergeTree(await gitVersion())).toBe(true);
		expect(supportsMergeTree([2, 37, 9])).toBe(false);
		expect(supportsMergeTree([2, 38, 0])).toBe(true);
		expect(supportsMergeTree([3, 0, 0])).toBe(true);
		expect(supportsMergeTree(null)).toBe(false);
	});

	test("a clean merge: a merge commit with both parents and the person's identity, nothing checked out", async () => {
		const { head, base } = await forkedRepo();
		const status = await git(["status", "--porcelain=v2", "--branch"]);
		const write = teamRepoGit(repo);
		const merged = await write.mergeTree(base, head);
		expect(merged.clean).toBe(true);
		if (!merged.clean) return;
		const commit = await write.commitTree({
			tree: merged.tree,
			parents: [base, head],
			message: "Merge team work item: Feature (feature)",
			identity: {
				GIT_AUTHOR_NAME: "Alice",
				GIT_AUTHOR_EMAIL: "alice@e.test",
				GIT_COMMITTER_NAME: "Alice",
				GIT_COMMITTER_EMAIL: "alice@e.test",
			},
		});
		expect(await git(["log", "-1", "--format=%P|%an <%ae>|%cn|%s", commit])).toBe(
			`${base} ${head}|Alice <alice@e.test>|Alice|Merge team work item: Feature (feature)`,
		);
		expect(await git(["ls-tree", "--name-only", commit])).toBe("a.txt\nfeature.txt\nmain.txt");
		// The checkout, its index and HEAD are as they were.
		expect(await git(["status", "--porcelain=v2", "--branch"])).toBe(status);
		expect(await git(["rev-parse", "HEAD"])).toBe(base);
	});

	test("conflicts list at most 50 files and say there are more, leaving no state behind", async () => {
		const files = Array.from(
			{ length: 60 },
			(_, index) => `f${String(index).padStart(2, "0")}.txt`,
		);
		for (const file of files) await writeFile(join(repo, file), "base\n");
		await git(["add", "."]);
		await git(["commit", "-qm", "base"]);
		await git(["checkout", "-qb", "feature"]);
		for (const file of files) await writeFile(join(repo, file), "feature\n");
		await git(["commit", "-qam", "feature"]);
		const head = await git(["rev-parse", "HEAD"]);
		await git(["checkout", "-q", "main"]);
		for (const file of files) await writeFile(join(repo, file), "main\n");
		await git(["commit", "-qam", "main"]);
		const base = await git(["rev-parse", "HEAD"]);
		const merged = await teamRepoGit(repo).mergeTree(base, head);
		expect(merged.clean).toBe(false);
		if (merged.clean) return;
		expect(merged.conflicts).toHaveLength(TEAM_MERGE_CONFLICTS_MAX);
		expect(merged.conflicts[0]).toBe("f00.txt");
		expect(merged.more).toBe(true);
		expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
		expect(await git(["status", "--porcelain"])).toBe("");
	});

	test("a custom merge driver of the repository never runs: the file counts as a conflict", async () => {
		const marker = join(temporary, "driver-ran");
		await rm(marker, { force: true });
		await writeFile(join(repo, ".gitattributes"), "*.txt merge=evil\n");
		await commitFile("x.txt", "base\n", "base");
		await git(["config", "merge.evil.driver", `touch ${marker}; cp %B %A`]);
		await git(["checkout", "-qb", "feature"]);
		const head = await commitFile("x.txt", "feature\n", "feature");
		await git(["checkout", "-q", "main"]);
		const base = await commitFile("x.txt", "main\n", "main");
		const programs = await configuredPrograms(repo);
		expect(programs.drivers).toEqual(["evil"]);
		const merged = await teamRepoGit(repo).mergeTree(base, head);
		expect(existsSync(marker)).toBe(false);
		expect(merged).toEqual({ clean: false, conflicts: ["x.txt"], more: false });
		// The hardened reads of the same checkout still work with the driver configured.
		const changed = await teamGit(repo).changedPaths("main", head);
		expect(changed?.paths).toEqual(["x.txt"]);
	});

	test("hooks never run: neither the hooks directory nor configuration-defined ones", async () => {
		const { head, base } = await forkedRepo();
		await git(["checkout", "-q", "--detach"]);
		const marker = join(temporary, "hook-ran");
		await rm(marker, { force: true });
		const hook = join(repo, ".git", "hooks", "reference-transaction");
		await writeFile(hook, `#!/bin/sh\ntouch ${marker}\n`);
		await chmod(hook, 0o755);
		await git(["config", "hook.audit.event", "reference-transaction"]);
		await git(["config", "hook.audit.command", `touch ${marker}-config`]);
		const write = teamRepoGit(repo);
		const merged = await write.mergeTree(base, head);
		if (!merged.clean) throw new Error("expected a clean merge");
		const commit = await write.commitTree({
			tree: merged.tree,
			parents: [base, head],
			message: "m",
			identity: null,
		});
		await write.setPrivateRef("item1", commit, null);
		expect(await write.fastForwardBase(commit, "main")).toEqual({ outcome: "updated" });
		expect(await write.deletePrivateRef("item1", commit)).toBe(true);
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(`${marker}-config`)).toBe(false);
		expect(await git(["rev-parse", "main"])).toBe(commit);
	});

	test("the private ref is created only if absent, moved only from the value read, and listed", async () => {
		const { head, base } = await forkedRepo();
		const write = teamRepoGit(repo);
		await write.setPrivateRef("item-a", head, null);
		await expect(write.setPrivateRef("item-a", base, null)).rejects.toThrow("update-ref");
		await write.setPrivateRef("item-a", base, head);
		await write.setPrivateRef("item-b", head, null);
		expect(await write.listPrivateRefs()).toEqual([
			{ itemId: "item-a", commit: base },
			{ itemId: "item-b", commit: head },
		]);
		expect(await write.deletePrivateRef("item-a", head)).toBe(false);
		expect(await write.deletePrivateRef("item-a", base)).toBe(true);
		expect(await git(["branch", "--list"])).not.toContain("team-merges");
		await expect(write.setPrivateRef("../x", head, null)).rejects.toThrow("work item id");
	});

	test("a checked-out base is refused, naming its checkout; nothing moves", async () => {
		const { head, base } = await forkedRepo();
		const write = teamRepoGit(repo);
		const merged = await write.mergeTree(base, head);
		if (!merged.clean) throw new Error("expected a clean merge");
		const commit = await write.commitTree({
			tree: merged.tree,
			parents: [base, head],
			message: "m",
			identity: null,
		});
		const moved = await write.fastForwardBase(commit, "main");
		expect(moved).toEqual({ outcome: "checked_out", path: await realpath(repo) });
		expect(await git(["rev-parse", "main"])).toBe(base);
		expect(await write.checkedOutAt("main")).toBe(await realpath(repo));
		expect(await write.checkedOutAt("feature")).toBeNull();
	});

	test("a base that moved meanwhile is not a fast-forward", async () => {
		const { head, base } = await forkedRepo();
		const write = teamRepoGit(repo);
		const merged = await write.mergeTree(base, head);
		if (!merged.clean) throw new Error("expected a clean merge");
		const commit = await write.commitTree({
			tree: merged.tree,
			parents: [base, head],
			message: "m",
			identity: null,
		});
		await commitFile("later.txt", "later\n", "main moves again");
		const moved = await git(["rev-parse", "main"]);
		await git(["checkout", "-q", "--detach"]);
		expect(await write.fastForwardBase(commit, "main")).toEqual({ outcome: "non_fast_forward" });
		expect(await git(["rev-parse", "main"])).toBe(moved);
	});

	test("signing follows commit.gpgsign with the host's program; the repository's own never runs", async () => {
		const { head, base } = await forkedRepo();
		const hostSigner = join(temporary, "host-signer.sh");
		const repoSigner = join(temporary, "repo-signer.sh");
		const signed = join(temporary, "signed");
		const evil = join(temporary, "evil-signer-ran");
		await rm(signed, { force: true });
		await rm(evil, { force: true });
		await writeFile(
			hostSigner,
			`#!/bin/sh\ncat >/dev/null\ntouch ${signed}\necho "[GNUPG:] SIG_CREATED D 1 8 00 0 0" >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'\n`,
		);
		await writeFile(repoSigner, `#!/bin/sh\ntouch ${evil}\nexit 1\n`);
		await chmod(hostSigner, 0o755);
		await chmod(repoSigner, 0o755);
		await writeFile(
			globalConfig,
			`${HOST_USER}[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${hostSigner}\n`,
		);
		await git(["config", "gpg.program", repoSigner]);
		const write = teamRepoGit(repo);
		const config = await signingConfig(repo, []);
		expect(config.sign).toBe(true);
		expect(config.overrides).toEqual([["gpg.program", hostSigner]]);
		const merged = await write.mergeTree(base, head);
		if (!merged.clean) throw new Error("expected a clean merge");
		const commit = await write.commitTree({
			tree: merged.tree,
			parents: [base, head],
			message: "m",
			identity: null,
		});
		expect(existsSync(signed)).toBe(true);
		expect(existsSync(evil)).toBe(false);
		expect(await git(["cat-file", "-p", commit])).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
		// Signing off: no -S, nothing runs.
		await writeFile(globalConfig, `${HOST_USER}[commit]\n\tgpgsign = false\n`);
		await rm(signed, { force: true });
		const unsigned = await write.commitTree({
			tree: merged.tree,
			parents: [base, head],
			message: "m2",
			identity: null,
		});
		expect(existsSync(signed)).toBe(false);
		expect(await git(["cat-file", "-p", unsigned])).not.toContain("gpgsig");
	});

	test("origin/<base> is fetched into the remote-tracking ref only; the local base stays", async () => {
		const origin = join(temporary, `origin-${Date.now()}.git`);
		await commitFile("a.txt", "a\n", "base");
		const local = await git(["rev-parse", "main"]);
		await git(["init", "-q", "--bare", "-b", "main", origin], temporary);
		await git(["push", "-q", origin, "main"]);
		const other = await mkdtemp(join(temporary, "clone-"));
		await git(["clone", "-q", origin, other], temporary);
		const upstream = await commitFile("b.txt", "b\n", "upstream", other);
		await git(["push", "-q", "origin", "main"], other);
		await git(["remote", "add", "origin", origin]);
		const write = teamRepoGit(repo);
		expect(await write.originPushUrl()).toBe(origin);
		expect(await write.fetchBaseFromOrigin("main")).toEqual({ ok: true });
		expect(await git(["rev-parse", "refs/remotes/origin/main"])).toBe(upstream);
		expect(await git(["rev-parse", "main"])).toBe(local);
		expect(await git(["status", "--porcelain"])).toBe("");
		expect(existsSync(join(repo, ".git", "FETCH_HEAD"))).toBe(false);
		await git(["remote", "remove", "origin"]);
		expect(await write.originPushUrl()).toBeNull();
		await rm(other, { recursive: true, force: true });
		await rm(origin, { recursive: true, force: true });
	});

	test("the copyable command quotes the checkout path", () => {
		expect(fastForwardCommand("/repo/main", "abc")).toBe(
			"git -C /repo/main merge --ff-only refs/narrafork/team-merges/abc",
		);
		expect(fastForwardCommand("/my repo/it's", "abc")).toBe(
			"git -C '/my repo/it'\\''s' merge --ff-only refs/narrafork/team-merges/abc",
		);
	});
});
