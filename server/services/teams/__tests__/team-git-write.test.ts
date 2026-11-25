/**
 * The git a team merge writes (M), against real repositories: `merge-tree` + `commit-tree` with
 * the person's identity and signing from the host's configuration only, the private ref, the
 * fast-forward of an unchecked-out base (refused when it is checked out or not a fast-forward),
 * and nothing of the repository's own (hooks, custom merge drivers, signing programs) running.
 * The host's global git configuration is replaced by a temporary one for the whole file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEAM_MERGE_CONFLICTS_MAX } from "@shared/project-teams";
import { GIT_NO_EXEC_CONFIG, setNoLazyFetchSupportForTests } from "../../../lib/git-exec-hardening";
import { safeSpawn } from "../../../lib/spawn";
import {
	assertNoReplacedHistory,
	assertTrueHistory,
	configuredPrograms,
	teamGit,
} from "../team-git";
import {
	type FastForwardCommands,
	fastForwardCheckout,
	fastForwardCommand,
	gitVersion,
	inspectCheckout,
	networkOverrides,
	PRIVATE_REFS_PAGE,
	type ScopedConfigEntry,
	signingConfig,
	sshSettings,
	supportsMergeTree,
	teamRepoGit,
	UnsafeRemoteConfigError,
} from "../team-git-write";

let temporary: string;
let repo: string;
let globalConfig: string;
const HOST_USER = "[user]\n\tname = Host\n\temail = host@e.test\n";
const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;

/** The commands for a path that has them (fails the test otherwise). */
function commandsFor(...args: Parameters<typeof fastForwardCommand>): FastForwardCommands {
	const commands = fastForwardCommand(...args);
	if (!commands) throw new Error(`no command for ${JSON.stringify(args[0])}`);
	return commands;
}

/**
 * The value of the PowerShell single-quoted string starting at `start`, read as PowerShell's
 * tokenizer does: any of ' U+2018 U+2019 U+201A U+201B ends it, two in a row are one literal
 * quote (the second). Returns where the string ended.
 */
function readPowerShellQuoted(source: string, start: number): { value: string; end: number } {
	const quote = (c: string | undefined) => c !== undefined && /['‘-‛]/.test(c);
	if (!quote(source[start])) throw new Error(`no quoted string at ${start}`);
	let value = "";
	let i = start + 1;
	while (i < source.length) {
		const c = source[i] as string;
		if (quote(c)) {
			if (!quote(source[i + 1])) return { value, end: i + 1 };
			value += source[i + 1];
			i += 2;
			continue;
		}
		value += c;
		i++;
	}
	throw new Error("unterminated string");
}

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
		expect(await write.listPrivateRefs()).toEqual({
			refs: [
				{ itemId: "item-a", commit: base },
				{ itemId: "item-b", commit: head },
			],
			more: false,
		});
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
		const config = await signingConfig(repo);
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

	test("the copyable command asserts the branch and names the prepared commit, for sh and PowerShell (Devin 2, 4)", async () => {
		const sha = "a".repeat(40);
		const plain = fastForwardCommand("/repo/main", "main", sha, "linux");
		expect(plain).toEqual({
			sh: `[ "$(git --no-replace-objects -C /repo/main symbolic-ref --quiet HEAD)" = refs/heads/main ] && git --no-replace-objects -C /repo/main merge --ff-only --no-autostash --no-overwrite-ignore ${sha}`,
			powershell: `if ((git --no-replace-objects -C '/repo/main' symbolic-ref --quiet HEAD) -ceq 'refs/heads/main') { git --no-replace-objects -C '/repo/main' merge --ff-only --no-autostash --no-overwrite-ignore ${sha} } else { Write-Error 'Not on main: nothing was changed' }`,
			preferred: "sh",
		});
		// Spaces and quotes: one word each way (sh closes and reopens the quote, PowerShell doubles it).
		const quoted = commandsFor("C:\\My Repo\\it's", "main", sha, "win32");
		expect(quoted.preferred).toBe("powershell");
		expect(quoted.powershell).toContain(
			"git --no-replace-objects -C 'C:\\My Repo\\it''s' symbolic-ref",
		);
		expect(quoted.sh).toContain("git --no-replace-objects -C 'C:\\My Repo\\it'\\''s' symbolic-ref");
		// Run the sh form for real, from a directory with a space and a quote in its name.
		const spaced = join(temporary, `my repo it's ${Math.random().toString(36).slice(2)}`);
		await rm(repo, { recursive: true, force: true });
		repo = spaced;
		await mkdir(repo, { recursive: true });
		await git(["init", "-q", "-b", "main"]);
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
		const command = commandsFor(repo, "main", commit).sh;
		await git(["checkout", "-q", "-b", "elsewhere"]);
		const off = await safeSpawn({
			cmd: ["sh", "-c", command],
			timeout: 20_000,
			maxOutputBytes: 4096,
		});
		expect(off.exitCode).not.toBe(0);
		expect(await git(["rev-parse", "elsewhere"])).toBe(base);
		await git(["checkout", "-q", "main"]);
		const on = await safeSpawn({
			cmd: ["sh", "-c", command],
			timeout: 20_000,
			maxOutputBytes: 4096,
		});
		expect(on.exitCode).toBe(0);
		expect(await git(["rev-parse", "main"])).toBe(commit);
		// The PowerShell form is checked as text (no pwsh is started: its start-up alone can take
		// seconds on a loaded runner): see the quoting test below.
	});

	test("every PowerShell quote is doubled: a path's quotes never end its string (Devin 3)", async () => {
		const sha = "b".repeat(40);
		// The exact escaping, for the plain quote and a typographic one.
		expect(commandsFor("/srv/';Remove-Item x;'", "main", sha, "win32").powershell).toBe(
			`if ((git --no-replace-objects -C '/srv/'';Remove-Item x;''' symbolic-ref --quiet HEAD) -ceq 'refs/heads/main') { git --no-replace-objects -C '/srv/'';Remove-Item x;''' merge --ff-only --no-autostash --no-overwrite-ignore ${sha} } else { Write-Error 'Not on main: nothing was changed' }`,
		);
		expect(commandsFor("/srv/a\u2019;Remove-Item x;\u2018", "main", sha).powershell).toContain(
			"git --no-replace-objects -C '/srv/a\u2019\u2019;Remove-Item x;\u2018\u2018' symbolic-ref",
		);
		const paths = ["'", "\u2018", "\u2019", "\u201a", "\u201b"].flatMap((q) => [
			`/srv/${q};Remove-Item x;${q}`,
			`C:\\it${q}s ${q}${q} $(evil) \`$x`,
		]);
		paths.push("/srv/\u2018';\u201b\u2019Remove-Item x;\u201a'");
		// Read back with PowerShell's own quoting rules (readPowerShellQuoted), not by starting pwsh.
		for (const path of paths) {
			const ps = commandsFor(path, "main", sha).powershell;
			let at = ps.indexOf("git --no-replace-objects -C ");
			let words = 0;
			while (at !== -1) {
				const word = readPowerShellQuoted(ps, at + "git --no-replace-objects -C ".length);
				expect(word.value).toBe(path);
				// The string ends exactly where the argument does: the subcommand follows.
				expect(ps.slice(word.end)).toMatch(/^ (symbolic-ref|merge) /);
				words++;
				at = ps.indexOf("git --no-replace-objects -C ", word.end);
			}
			expect(words).toBe(2);
		}
	});

	test("the sh form passes such a path to git as one inert argument (Devin 3)", async () => {
		const sha = "c".repeat(40);
		const bin = join(temporary, `fake-git-${Math.random().toString(36).slice(2)}`);
		await mkdir(bin, { recursive: true });
		const log = join(bin, "args.log");
		const marker = join(bin, "PWNED");
		// A git that records the directory it was given (after `--no-replace-objects -C`) and
		// fails, so nothing else runs.
		await writeFile(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$3" >> '${log}'\nexit 1\n`);
		await chmod(join(bin, "git"), 0o755);
		const paths = ["'", "\u2018", "\u2019", "\u201a", "\u201b"].map(
			(q) => `/srv/${q};touch ${marker};${q} $(touch ${marker}) \`touch ${marker}\``,
		);
		for (const path of paths) {
			await rm(log, { force: true });
			const run = await safeSpawn({
				cmd: ["sh", "-c", commandsFor(path, "main", sha, "linux").sh],
				env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
				timeout: 20_000,
				maxOutputBytes: 4096,
			});
			expect(run.exitCode).not.toBe(0);
			expect((await readFile(log, "utf8")).split("\n").filter(Boolean)).toEqual([path]);
			expect(existsSync(marker)).toBe(false);
		}
	});

	test("a path with a line break or control character gets no command and is not fast-forwarded (Devin 3)", async () => {
		const sha = "d".repeat(40);
		for (const bad of ["\n", "\r", "\0", "\t", "\u001b", "\u007f", "\u0085", "\u2028", "\u2029"]) {
			const path = `/srv/repo${bad}Remove-Item x`;
			expect(fastForwardCommand(path, "main", sha, "linux")).toBeNull();
			expect(fastForwardCommand(path, "main", sha, "win32")).toBeNull();
			expect(await inspectCheckout(path, "main", sha)).toBe("unsafe_path");
		}
		expect(fastForwardCommand("/srv/r\u00e9po \u2019x", "main", sha)).not.toBeNull();
	});

	test("without lazy-fetch protection a promisor repository is refused before any object is read (Devin)", async () => {
		const head = await commitFile("a.txt", "a\n", "base");
		// A promisor remote, and a replacement ref (an agent can write one) naming a missing object.
		const marker = join(temporary, `promisor-ran-${Math.random().toString(36).slice(2)}`);
		const helper = join(temporary, `upload-pack-${Math.random().toString(36).slice(2)}`);
		await writeFile(helper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
		await chmod(helper, 0o755);
		for (const [key, value] of [
			["core.repositoryformatversion", "1"],
			["extensions.partialClone", "evil"],
			["remote.evil.url", join(temporary, "nowhere.git")],
			["remote.evil.promisor", "true"],
			["remote.evil.uploadpack", helper],
		] as const)
			await git(["config", key, value]);
		const missing = "e".repeat(40);
		await git(["update-ref", `refs/replace/${missing}`, head]);
		const trace = join(temporary, `trace-${Math.random().toString(36).slice(2)}`);
		setNoLazyFetchSupportForTests(false);
		process.env.GIT_TRACE = trace;
		try {
			const refused = expect.objectContaining({ code: "GIT_TOO_OLD_FOR_PARTIAL_CLONE" });
			for (const attempt of [
				() => assertNoReplacedHistory(repo, [head]),
				() => assertTrueHistory(repo),
				() => teamGit(repo).isAncestor(head, head),
				() => teamGit(repo).resolveCommit("HEAD"),
				() => teamRepoGit(repo).resolve("HEAD"),
				() => teamRepoGit(repo).isAncestor(head, head),
				() => teamRepoGit(repo).mergeTree(head, head),
			])
				await expect(attempt()).rejects.toEqual(refused);
			expect(await inspectCheckout(repo, "main", head, { repo })).toBe("unreadable");
			// Only configuration was read: no command that reads objects ran, nothing was fetched.
			const commands = (await readFile(trace, "utf8"))
				.split("\n")
				.map((line) => /trace: built-in: git (\S+)/.exec(line)?.[1])
				.filter(Boolean);
			expect(commands.length).toBeGreaterThan(0);
			expect([...new Set(commands)]).toEqual(["config"]);
			expect(existsSync(marker)).toBe(false);
		} finally {
			delete process.env.GIT_TRACE;
			setNoLazyFetchSupportForTests(null);
		}
	});
});

// ── Review fixes: nothing from the repository's own configuration runs or chooses ──────────

/** A marker file a program would create if it ran. */
const marker = (name: string) => join(temporary, `${name}-${Math.random().toString(36).slice(2)}`);
async function script(name: string, body: string) {
	const path = join(temporary, `${name}-${Math.random().toString(36).slice(2)}.sh`);
	await writeFile(path, `#!/bin/sh\n${body}\n`);
	await chmod(path, 0o755);
	return path;
}

describe("the work-start fetch (review 1, 4)", () => {
	test("credential helpers and askpass of the repository never run; the host's helper does", async () => {
		// The reviewer's 401 server (scratchpad/merge-review/srv.ts): every request asks for a login.
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () =>
				new Response("no", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="x"' } }),
		});
		try {
			await commitFile("a.txt", "a\n", "base");
			const origin = `http://127.0.0.1:${server.port}/o/r.git`;
			await git(["remote", "add", "origin", origin]);
			const repoHelper = marker("repo-helper");
			const repoUrlHelper = marker("repo-url-helper");
			const repoAskpass = marker("repo-askpass");
			const hostHelper = marker("host-helper");
			await git(["config", "credential.helper", `!f() { touch ${repoHelper}; }; f`]);
			await git([
				"config",
				`credential.http://127.0.0.1:${server.port}.helper`,
				`!f() { touch ${repoUrlHelper}; }; f`,
			]);
			await git([
				"config",
				"core.askPass",
				await script("askpass", `touch ${repoAskpass}; echo x`),
			]);
			await writeFile(
				globalConfig,
				`${HOST_USER}[credential]\n\thelper = "!f() { touch ${hostHelper}; }; f"\n`,
			);
			const result = await teamRepoGit(repo).fetchBaseFromOrigin("main");
			expect(result.ok).toBe(false);
			expect(existsSync(repoHelper)).toBe(false);
			expect(existsSync(repoUrlHelper)).toBe(false);
			expect(existsSync(repoAskpass)).toBe(false);
			expect(existsSync(hostHelper)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	test("a repository insteadOf that rewrites origin, or a transport helper, refuses the fetch", async () => {
		await commitFile("a.txt", "a\n", "base");
		const ran = marker("ext");
		await git(["remote", "add", "origin", "mine:o/r.git"]);
		await git(["config", `url.ext::sh -c touch% ${ran}.insteadOf`, "mine:"]);
		const refused = await teamRepoGit(repo).fetchBaseFromOrigin("main");
		expect(refused).toMatchObject({ ok: false });
		if (!refused.ok) expect(refused.message).toContain(".insteadof");
		expect(existsSync(ran)).toBe(false);
		await git(["config", "--remove-section", `url.ext::sh -c touch% ${ran}`]);
		await git(["config", "remote.origin.vcs", "ext"]);
		const helper = await teamRepoGit(repo).fetchBaseFromOrigin("main");
		expect(helper).toMatchObject({ ok: false });
		if (!helper.ok) expect(helper.message).toContain("remote.origin.vcs");
		// Even without a rewrite, ext:: is never a transport.
		await git(["config", "--unset", "remote.origin.vcs"]);
		await git(["config", "protocol.ext.allow", "always"]);
		await git(["remote", "set-url", "origin", `ext::sh -c touch% ${ran}`]);
		expect((await teamRepoGit(repo).fetchBaseFromOrigin("main")).ok).toBe(false);
		expect(existsSync(ran)).toBe(false);
	});

	test("ssh: the host's core.sshCommand is used, the repository's never", async () => {
		const saved = { command: process.env.GIT_SSH_COMMAND, ssh: process.env.GIT_SSH };
		delete process.env.GIT_SSH_COMMAND;
		delete process.env.GIT_SSH;
		try {
			await commitFile("a.txt", "a\n", "base");
			const hostRan = marker("host-ssh");
			const repoRan = marker("repo-ssh");
			await writeFile(
				globalConfig,
				`${HOST_USER}[core]\n\tsshCommand = ${await script("host-ssh", `touch ${hostRan}; exit 1`)}\n`,
			);
			await git([
				"config",
				"core.sshCommand",
				await script("repo-ssh", `touch ${repoRan}; exit 1`),
			]);
			await git(["remote", "add", "origin", "ssh://git@127.0.0.1:1/o/r.git"]);
			expect((await teamRepoGit(repo).fetchBaseFromOrigin("main")).ok).toBe(false);
			expect(existsSync(hostRan)).toBe(true);
			expect(existsSync(repoRan)).toBe(false);
		} finally {
			if (saved.command !== undefined) process.env.GIT_SSH_COMMAND = saved.command;
			if (saved.ssh !== undefined) process.env.GIT_SSH = saved.ssh;
		}
	});

	test("the overrides: host values kept, repository values neutralised or refused", () => {
		const entry = (scope: string, key: string, value: string): ScopedConfigEntry => ({
			scope,
			key,
			value,
		});
		const { overrides, env } = networkOverrides(
			[
				entry("local", "remote.origin.url", "https://example.com/o/r.git"),
				entry("global", "credential.helper", "store"),
				entry("local", "credential.helper", "!evil"),
				entry("local", "credential.username", "mallory"),
				entry("local", "http.sslverify", "false"),
				entry("global", "http.proxy", "http://host-proxy:3128"),
				entry("local", "http.proxy", "http://evil:1"),
				entry("local", "http.https://example.com.extraheader", "Authorization: x"),
			],
			{ HTTPS_PROXY: "http://ambient:8080" },
		);
		expect(overrides).toContainEqual(["credential.helper", ""]);
		expect(overrides).toContainEqual(["credential.helper", "store"]);
		expect(overrides.findIndex(([k, v]) => k === "credential.helper" && v === "")).toBeLessThan(
			overrides.findIndex(([k, v]) => k === "credential.helper" && v === "store"),
		);
		expect(overrides).toContainEqual(["credential.username", ""]);
		expect(overrides).toContainEqual(["http.sslverify", "true"]);
		expect(overrides).toContainEqual(["http.proxy", "http://host-proxy:3128"]);
		// Extra headers: the list reset (no host header to add back).
		expect(overrides).toContainEqual(["http.extraHeader", ""]);
		expect(overrides.some(([key]) => key === "http.https://example.com.extraheader")).toBe(false);
		expect(overrides).toContainEqual(["protocol.ext.allow", "never"]);
		expect(overrides).toContainEqual(["protocol.allow", "never"]);
		expect(env).toEqual({ GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
		// A proxy only the repository names becomes the server's own.
		expect(
			networkOverrides([entry("local", "http.proxy", "http://evil:1")], {
				HTTPS_PROXY: "http://ambient:8080",
			}).overrides,
		).toContainEqual(["http.proxy", "http://ambient:8080"]);
		// A repository CA file has no neutral value: refused.
		expect(() => networkOverrides([entry("local", "http.sslcainfo", "/tmp/evil.pem")], {})).toThrow(
			UnsafeRemoteConfigError,
		);
		// ssh: an operator's environment wins, then the host's config, then batch mode.
		expect(sshSettings([entry("local", "core.sshcommand", "evil")], {})).toEqual({
			overrides: [["core.sshCommand", ""]],
			env: { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
		});
		expect(
			sshSettings(
				[entry("global", "core.sshcommand", "ssh -i k"), entry("local", "core.sshcommand", "evil")],
				{},
			),
		).toEqual({ overrides: [["core.sshCommand", "ssh -i k"]], env: {} });
		expect(sshSettings([], { GIT_SSH_COMMAND: "ssh -F op" }).env).toEqual({});
	});
});

describe("identity, signing and the local fetch (review nits, 12)", () => {
	test("without a NarraFork identity the host's global one commits, never the repository's", async () => {
		const { head, base } = await forkedRepo();
		await git(["config", "user.name", "Mallory"]);
		await git(["config", "user.email", "mallory@e.test"]);
		// Signing turned on by the repository alone is not the host's choice.
		await git(["config", "commit.gpgsign", "true"]);
		const write = teamRepoGit(repo);
		const merged = await write.mergeTree(base, head);
		if (!merged.clean) throw new Error("expected a clean merge");
		const commit = await write.commitTree({
			tree: merged.tree,
			parents: [base, head],
			message: "m",
			identity: null,
		});
		expect(await git(["log", "-1", "--format=%an <%ae>|%cn <%ce>", commit])).toBe(
			"Host <host@e.test>|Host <host@e.test>",
		);
		expect(await git(["cat-file", "-p", commit])).not.toContain("gpgsig");
		await writeFile(globalConfig, "[commit]\n\tgpgsign = false\n");
		await expect(
			write.commitTree({ tree: merged.tree, parents: [base, head], message: "m", identity: null }),
		).rejects.toMatchObject({ code: "TEAM_MERGE_IDENTITY_UNKNOWN" });
	});

	test("fetch . never takes a transport: an ext:: insteadOf on . runs nothing", async () => {
		const { head } = await forkedRepo();
		await git(["checkout", "-q", "--detach"]);
		const ran = marker("ext-dot");
		await git(["config", `url.ext::sh -c touch% ${ran}.insteadOf`, "."]);
		await git(["config", "protocol.ext.allow", "always"]);
		await expect(teamRepoGit(repo).fastForwardBase(head, "main")).rejects.toThrow();
		expect(existsSync(ran)).toBe(false);
	});

	test("a filter configured after the program list was first read still never runs", async () => {
		const { head, base } = await forkedRepo();
		const write = teamRepoGit(repo);
		expect((await write.mergeTree(base, head)).clean).toBe(true);
		// Configuration changes between two commands of one job: the second reads it again.
		const ran = marker("driver-later");
		await writeFile(join(repo, ".gitattributes"), "*.txt merge=later\n");
		await git(["config", "merge.later.driver", `touch ${ran}; cp %B %A`]);
		await git(["add", ".gitattributes"]);
		await git(["commit", "-qm", "attributes"]);
		await git(["checkout", "-q", "feature"]);
		await writeFile(join(repo, "main.txt"), "feature side\n");
		await git(["add", "main.txt"]);
		await git(["commit", "-qm", "feature edits main.txt"]);
		const theirs = await git(["rev-parse", "HEAD"]);
		await git(["checkout", "-q", "main"]);
		const ours = await commitFile("main.txt", "main side\n", "main edits main.txt");
		const result = await write.mergeTree(ours, theirs);
		expect(result.clean).toBe(false);
		expect(existsSync(ran)).toBe(false);
	});

	test("more private refs than one page: listed a page at a time, never refused", async () => {
		const { head } = await forkedRepo();
		const lines = Array.from(
			{ length: PRIVATE_REFS_PAGE * 3 },
			(_, index) =>
				`create refs/narrafork/team-merges/item-${String(index).padStart(5, "0")} ${head}\n`,
		).join("");
		const stdin = join(temporary, "refs.txt");
		await writeFile(stdin, lines);
		await safeSpawn({
			cmd: ["sh", "-c", `git -C '${repo}' update-ref --stdin < '${stdin}'`],
			timeout: 30_000,
			maxOutputBytes: 4096,
		});
		const page = await teamRepoGit(repo).listPrivateRefs();
		expect(page.refs).toHaveLength(PRIVATE_REFS_PAGE);
		expect(page.more).toBe(true);
		expect(page.refs[0]?.itemId).toBe("item-00000");
	});
});

describe("the fast-forward of a person's checkout (review 2, 3, 7)", () => {
	/** main checked out, a prepared merge of feature at the private ref. */
	async function prepared() {
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
		await write.setPrivateRef("item1", commit, null);
		return { commit, base, ref: "refs/narrafork/team-merges/item1" };
	}

	test("autostash never kicks in: a local edit in the way is a clean refusal, no stash, no markers", async () => {
		const { commit, ref } = await prepared();
		await git(["config", "merge.autostash", "true"]);
		await writeFile(join(repo, "feature.txt"), "my own edit\n");
		const result = await fastForwardCheckout(repo, ref, { base: "main", mergeCommit: commit });
		expect(result).toMatchObject({ ok: false, kind: "refused" });
		expect(await git(["stash", "list"])).toBe("");
		expect(await git(["ls-files", "-u"])).toBe("");
		expect(await git(["status", "--porcelain"])).toBe("?? feature.txt");
	});

	test("no signing program, fsmonitor or hook of the checkout runs; the merge is checked after", async () => {
		const { commit, ref } = await prepared();
		const gpg = marker("evil-gpg");
		const fsmonitor = marker("evil-fsmonitor");
		const hook = marker("evil-hook");
		await git(["config", "merge.verifySignatures", "true"]);
		await git(["config", "gpg.program", await script("gpg", `touch ${gpg}; exit 1`)]);
		await git(["config", "core.fsmonitor", await script("fsmonitor", `touch ${fsmonitor}`)]);
		await git(["config", "hook.audit.event", "post-merge"]);
		await git(["config", "hook.audit.command", `touch ${hook}`]);
		const result = await fastForwardCheckout(repo, ref, { base: "main", mergeCommit: commit });
		expect(result).toEqual({ ok: true });
		expect(existsSync(gpg)).toBe(false);
		expect(existsSync(fsmonitor)).toBe(false);
		expect(existsSync(hook)).toBe(false);
		expect(await git(["rev-parse", "HEAD"])).toBe(commit);
	});

	test("HEAD off the base right before is refused; a checkout of another repository is not offered", async () => {
		const { commit, ref, base } = await prepared();
		await git(["checkout", "-q", "-b", "elsewhere"]);
		expect(
			await fastForwardCheckout(repo, ref, { base: "main", mergeCommit: commit }),
		).toMatchObject({ ok: false, kind: "moved" });
		expect(await git(["rev-parse", "main"])).toBe(base);
		await git(["checkout", "-q", "main"]);
		const other = await mkdtemp(join(temporary, "other-"));
		await git(["init", "-q", "-b", "main"], other);
		await git(["commit", "-q", "--allow-empty", "-m", "x"], other);
		const otherBase = await git(["rev-parse", "HEAD"], other);
		expect(await inspectCheckout(other, "main", otherBase, { repo })).toBe("other_repository");
		expect(await inspectCheckout(repo, "main", base, { repo })).toBeNull();
	});
});

// ── Devin review and security re-check ─────────────────────────────────────────

/** A prepared merge of `feature` into `main` (checked out), parked at the private ref. */
async function preparedMerge() {
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
	await write.setPrivateRef("item1", commit, null);
	return { commit, base, head, ref: "refs/narrafork/team-merges/item1" };
}

describe("the fast-forward re-checks right before it runs (Devin 1, 4; security 4, 5)", () => {
	test("a filter added after the inspection refuses the merge; it never runs", async () => {
		const { commit, base, ref } = await preparedMerge();
		expect(await inspectCheckout(repo, "main", base, { repo })).toBeNull();
		// Between the inspection and the merge, a repository writer plants a filter.
		const ran = marker("late-filter");
		await git(["config", "filter.evil.smudge", `touch ${ran}; cat`]);
		await writeFile(join(repo, ".git", "info", "attributes"), "* filter=evil\n");
		const result = await fastForwardCheckout(repo, ref, { base: "main", mergeCommit: commit });
		expect(result).toMatchObject({ ok: false, kind: "unsafe" });
		expect(existsSync(ran)).toBe(false);
		expect(await git(["rev-parse", "main"])).toBe(base);
	});

	test("an ignored local file is never overwritten by a tracked one", async () => {
		await writeFile(join(repo, ".gitignore"), "local.env\n");
		await commitFile("a.txt", "a\n", "base");
		await git(["add", ".gitignore"]);
		await git(["commit", "-qm", "ignore local.env"]);
		await git(["checkout", "-qb", "feature"]);
		await git(["rm", "-q", "--cached", ".gitignore"]);
		await writeFile(join(repo, ".gitignore"), "");
		await writeFile(join(repo, "local.env"), "TRACKED=1\n");
		await git(["add", "-f", "local.env", ".gitignore"]);
		await git(["commit", "-qm", "track local.env"]);
		const head = await git(["rev-parse", "HEAD"]);
		await git(["checkout", "-q", "main"]);
		const base = await git(["rev-parse", "HEAD"]);
		await writeFile(join(repo, "local.env"), "SECRET=mine\n");
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
		const result = await fastForwardCheckout(repo, "refs/narrafork/team-merges/item1", {
			base: "main",
			mergeCommit: commit,
		});
		expect(result).toMatchObject({ ok: false, kind: "refused" });
		expect(await readFile(join(repo, "local.env"), "utf8")).toBe("SECRET=mine\n");
		expect(await git(["rev-parse", "main"])).toBe(base);
	});

	test("a working tree of its own (core.worktree) is refused; nothing lands elsewhere", async () => {
		const { commit, base, ref } = await preparedMerge();
		const elsewhere = await mkdtemp(join(temporary, "elsewhere-"));
		await git(["config", "core.worktree", elsewhere]);
		expect(await inspectCheckout(repo, "main", base, { repo })).toBe("local_config");
		expect(
			await fastForwardCheckout(repo, ref, { base: "main", mergeCommit: commit }),
		).toMatchObject({ ok: false, kind: "unsafe" });
		expect(await git(["rev-parse", "main"])).toBe(base);
		expect(existsSync(join(elsewhere, "feature.txt"))).toBe(false);
	});

	test("no automatic maintenance runs after the fast-forward", async () => {
		const { commit, ref } = await preparedMerge();
		await git(["config", "gc.auto", "1"]);
		await git(["config", "gc.autoDetach", "false"]);
		await git(["config", "maintenance.auto", "true"]);
		const loose = async () => (await git(["count-objects"])).split(" ")[0];
		const before = await loose();
		expect(Number(before)).toBeGreaterThan(1);
		expect(await fastForwardCheckout(repo, ref, { base: "main", mergeCommit: commit })).toEqual({
			ok: true,
		});
		expect(await loose()).toBe(before);
		expect(GIT_NO_EXEC_CONFIG).toContainEqual(["maintenance.auto", "false"]);
		expect(GIT_NO_EXEC_CONFIG).toContainEqual(["gc.auto", "0"]);
	});
});

describe("programs a repository can name (security 1, 2)", () => {
	test("a promisor remote never runs: missing objects are not fetched lazily", async () => {
		await commitFile("a.txt", "base\n", "base");
		await git(["checkout", "-qb", "feature"]);
		const head = await commitFile("a.txt", "feature\n", "feature");
		const blob = await git(["rev-parse", `${head}:a.txt`]);
		await git(["checkout", "-q", "main"]);
		const base = await commitFile("a.txt", "main\n", "main");
		await rm(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
		const ran = marker("promisor");
		const uploadpack = await script("uploadpack", `touch ${ran}; exit 1`);
		await git(["config", "core.repositoryformatversion", "1"]);
		await git(["config", "extensions.partialClone", "evil"]);
		await git(["config", "remote.evil.url", repo]);
		await git(["config", "remote.evil.promisor", "true"]);
		await git(["config", "remote.evil.uploadpack", uploadpack]);
		await expect(teamRepoGit(repo).mergeTree(base, head)).rejects.toThrow();
		await expect(teamGit(repo).readBlob(blob, 8)).rejects.toThrow();
		expect(existsSync(ran)).toBe(false);
		// A git that cannot be told so refuses the repository outright.
		setNoLazyFetchSupportForTests(false);
		try {
			await expect(teamRepoGit(repo).mergeTree(base, head)).rejects.toMatchObject({
				code: "GIT_TOO_OLD_FOR_PARTIAL_CLONE",
			});
		} finally {
			setNoLazyFetchSupportForTests(null);
		}
		expect(existsSync(ran)).toBe(false);
	});

	test("a promisor remote without extensions.partialClone is refused on a git that cannot stop lazy fetching", async () => {
		await commitFile("a.txt", "base\n", "base");
		await git(["checkout", "-qb", "feature"]);
		const head = await commitFile("a.txt", "feature\n", "feature");
		const blob = await git(["rev-parse", `${head}:a.txt`]);
		await git(["checkout", "-q", "main"]);
		const base = await commitFile("a.txt", "main\n", "main");
		await rm(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
		const ran = marker("promisor-only");
		await git(["config", "remote.evil.url", repo]);
		await git(["config", "remote.evil.promisor", "true"]);
		await git(["config", "remote.evil.partialclonefilter", "blob:none"]);
		await git(["config", "remote.evil.uploadpack", await script("up", `touch ${ran}; exit 1`)]);
		setNoLazyFetchSupportForTests(false);
		try {
			await expect(teamRepoGit(repo).mergeTree(base, head)).rejects.toMatchObject({
				code: "GIT_TOO_OLD_FOR_PARTIAL_CLONE",
			});
			await expect(teamGit(repo).readBlob(blob, 8)).rejects.toMatchObject({
				code: "GIT_TOO_OLD_FOR_PARTIAL_CLONE",
			});
		} finally {
			setNoLazyFetchSupportForTests(null);
		}
		expect(existsSync(ran)).toBe(false);
	});

	test("core.alternateRefsCommand never runs on a fetch", async () => {
		const { base } = await forkedRepo();
		const head = await git(["commit-tree", `${base}^{tree}`, "-p", base, "-m", "next"]);
		const other = await mkdtemp(join(temporary, "alternate-"));
		await git(["init", "-q", "--bare", other], temporary);
		await writeFile(
			join(repo, ".git", "objects", "info", "alternates"),
			`${join(other, "objects")}\n`,
		);
		const ran = marker("alternate-refs");
		await git(["config", "core.alternateRefsCommand", await script("alt", `touch ${ran}`)]);
		await git(["checkout", "-q", "--detach"]);
		expect(await teamRepoGit(repo).fastForwardBase(head, "main")).toEqual({ outcome: "updated" });
		expect(existsSync(ran)).toBe(false);
	});
});

describe("the work-start fetch, second round (Devin 3; security 3, 5)", () => {
	async function originWithUpstream() {
		await commitFile("a.txt", "a\n", "base");
		const origin = join(temporary, `origin-${Math.random().toString(36).slice(2)}.git`);
		await git(["init", "-q", "--bare", "-b", "main", origin], temporary);
		await git(["push", "-q", origin, "main"]);
		const other = await mkdtemp(join(temporary, "clone-"));
		await git(["clone", "-q", origin, other], temporary);
		const upstream = await commitFile("b.txt", "b\n", "upstream", other);
		await git(["push", "-q", "origin", "main"], other);
		await git(["remote", "add", "origin", origin]);
		return { origin, upstream };
	}

	test("only the given refspec moves: a configured forced mapping onto a local branch does not", async () => {
		const { upstream } = await originWithUpstream();
		const local = await git(["rev-parse", "main"]);
		await git(["branch", "victim", local]);
		await git(["config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/heads/victim"]);
		expect(await teamRepoGit(repo).fetchBaseFromOrigin("main")).toEqual({ ok: true });
		expect(await git(["rev-parse", "refs/remotes/origin/main"])).toBe(upstream);
		expect(await git(["rev-parse", "victim"])).toBe(local);
	});

	test("a repository upload-pack never runs; a repository git proxy refuses the fetch", async () => {
		await originWithUpstream();
		const ran = marker("uploadpack");
		await git(["config", "remote.origin.uploadpack", await script("up", `touch ${ran}; exit 1`)]);
		expect(await teamRepoGit(repo).fetchBaseFromOrigin("main")).toEqual({ ok: true });
		expect(existsSync(ran)).toBe(false);
		await git(["config", "--unset", "remote.origin.uploadpack"]);
		await git(["config", "core.gitProxy", await script("proxy", `touch ${ran}; exit 1`)]);
		const refused = await teamRepoGit(repo).fetchBaseFromOrigin("main");
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.message).toContain("core.gitproxy");
		expect(existsSync(ran)).toBe(false);
	});

	test("GIT_SSH alone, extra headers and credential safety defaults", () => {
		const entry = (scope: string, key: string, value: string): ScopedConfigEntry => ({
			scope,
			key,
			value,
		});
		expect(sshSettings([], { GIT_SSH: "/opt/my ssh" })).toEqual({
			overrides: [["core.sshCommand", ""]],
			env: { GIT_SSH_COMMAND: "'/opt/my ssh'" },
		});
		const { overrides } = networkOverrides(
			[
				entry("global", "http.extraheader", "X-Host: 1"),
				entry("local", "http.extraheader", "Authorization: evil"),
				entry("local", "credential.protectprotocol", "false"),
				entry("local", "credential.sanitizeprompt", "false"),
			],
			{},
		);
		const headers = overrides.filter(([key]) => key.toLowerCase().endsWith(".extraheader"));
		expect(headers).toEqual([
			["http.extraHeader", ""],
			["http.extraheader", "X-Host: 1"],
		]);
		expect(overrides).toContainEqual(["credential.protectprotocol", "true"]);
		expect(overrides).toContainEqual(["credential.sanitizeprompt", "true"]);
		expect(() => networkOverrides([entry("local", "core.gitproxy", "evil")], {})).toThrow(
			UnsafeRemoteConfigError,
		);
	});
});

describe("the copyable command and a same-named tag (Devin)", () => {
	test("a branch named like a tag still fast-forwards: the full ref is compared", async () => {
		await commitFile("a.txt", "a\n", "base");
		await git(["branch", "-m", "release"]);
		await git(["tag", "release"]);
		await git(["checkout", "-qb", "feature"]);
		const head = await commitFile("b.txt", "b\n", "feature");
		await git(["checkout", "-q", "release"]);
		const base = await git(["rev-parse", "HEAD"]);
		// What --short would have printed: an ambiguous name.
		expect(await git(["symbolic-ref", "--short", "HEAD"])).toBe("heads/release");
		const write = teamRepoGit(repo);
		const merged = await write.mergeTree(base, head);
		if (!merged.clean) throw new Error("expected a clean merge");
		const commit = await write.commitTree({
			tree: merged.tree,
			parents: [base, head],
			message: "m",
			identity: null,
		});
		const command = commandsFor(repo, "release", commit);
		expect(command.sh).toContain("= refs/heads/release ]");
		expect(command.powershell).toContain("-ceq 'refs/heads/release'");
		const run = await safeSpawn({
			cmd: ["sh", "-c", command.sh],
			timeout: 20_000,
			maxOutputBytes: 4096,
		});
		expect(run.exitCode).toBe(0);
		expect(await git(["rev-parse", "refs/heads/release"])).toBe(commit);
	});
});
