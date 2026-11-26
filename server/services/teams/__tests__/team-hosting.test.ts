/**
 * Where origin lives (G): every push-URL form git accepts, `insteadOf` and `pushurl` applied by
 * `git remote get-url --push`, GitHub Enterprise only when gh knows the host, and the gh probe
 * against a fake gh on PATH that records its argv and replays JSON — missing, unauthenticated,
 * no permission, archived, success, a hung gh, and the cache. gh always runs in NarraFork's own
 * empty directory, never a repository, with a cleaned environment.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { safeSpawn } from "../../../lib/spawn";
import {
	ghNoRepository,
	ghVersion,
	ghWorkDir,
	readAuthStatusText,
	setGhTimeoutScaleForTests,
} from "../team-gh";
import { teamRepoGit } from "../team-git-write";
import {
	hostingOf,
	hostingOfUrl,
	parseRemoteUrl,
	peekHosting,
	resolveHosting,
	setHostingSourceForTests,
} from "../team-hosting";
import {
	authJson,
	type FakeGh,
	type FakeGhPlan,
	installFakeGh,
	olderGh,
	repoViewJson,
	usableGh,
} from "./fake-gh.fixture";

const posix = process.platform !== "win32";
let temporary: string;
let fake: FakeGh;
const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;

async function git(args: string[], cwd: string) {
	const result = await safeSpawn({
		cmd: ["git", "-C", cwd, ...args],
		env: { ...process.env },
		timeout: 20_000,
		maxOutputBytes: 1024 * 1024,
	});
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

beforeAll(async () => {
	temporary = await realpath(await mkdtemp(join(tmpdir(), "nf-team-hosting-")));
	fake = await installFakeGh(temporary);
	process.env.GIT_CONFIG_GLOBAL = join(temporary, "gitconfig");
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	await writeFile(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Host\n\temail = h@e.test\n");
});

afterAll(async () => {
	fake.restore();
	setHostingSourceForTests(null);
	if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
	if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
	else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
	await rm(temporary, { recursive: true, force: true });
});

beforeEach(async () => {
	fake.activate();
	await fake.clearCalls();
	await fake.setPlan(usableGh());
});

afterEach(() => {
	fake.restore();
	setHostingSourceForTests(null);
	setGhTimeoutScaleForTests(1);
});

describe("the push URL", () => {
	test("every form git accepts: scp, ssh (port 443 too), https with userinfo dropped", () => {
		const table: Array<[string, { host: string; owner: string; repo: string } | null]> = [
			["git@github.com:acme/app.git", { host: "github.com", owner: "acme", repo: "app" }],
			["github.com:acme/app", { host: "github.com", owner: "acme", repo: "app" }],
			["ssh://git@github.com/acme/app.git", { host: "github.com", owner: "acme", repo: "app" }],
			[
				"ssh://git@ssh.github.com:443/acme/app.git",
				{ host: "ssh.github.com", owner: "acme", repo: "app" },
			],
			[
				"https://x-access-token:s3cr3t@github.com/acme/app.git",
				{ host: "github.com", owner: "acme", repo: "app" },
			],
			["https://GitHub.com/Acme/App/", { host: "github.com", owner: "Acme", repo: "App" }],
			["git@ghe.acme.test:team/app.git", { host: "ghe.acme.test", owner: "team", repo: "app" }],
			["https://github.com/acme/app/extra", null],
			["https://github.com/acme", null],
			["file:///srv/git/app.git", null],
			["/srv/git/app.git", null],
			["ext::sh -c evil", null],
		];
		for (const [url, expected] of table)
			expect({ url, parsed: parseRemoteUrl(url) }).toEqual({ url, parsed: expected });
		// ssh over 443 is github.com; the userinfo never reaches the result.
		expect(hostingOfUrl("ssh://git@ssh.github.com:443/acme/app.git")).toMatchObject({
			kind: "github",
			host: "github.com",
		});
		expect(JSON.stringify(hostingOfUrl("https://u:s3cr3t@github.com/acme/app.git"))).not.toContain(
			"s3cr3t",
		);
	});

	test("origin from the raw configuration: the host's rewrites apply, the repository's own never do", async () => {
		const repo = await realpath(await mkdtemp(join(temporary, "repo-")));
		await git(["init", "-q", "-b", "main"], repo);
		await git(["remote", "add", "origin", "gh:acme/app"], repo);
		await writeFile(
			process.env.GIT_CONFIG_GLOBAL ?? "",
			'[user]\n\tname = Host\n\temail = h@e.test\n[url "git@github.com:"]\n\tinsteadOf = gh:\n',
		);
		try {
			// The host's shorthand resolves; the URL pushed to stays the configured one (git
			// applies the same host rewrite when it pushes).
			expect(await teamRepoGit(repo).originTarget()).toEqual({
				url: "gh:acme/app",
				resolved: "git@github.com:acme/app",
			});
			expect(hostingOfUrl("git@github.com:acme/app")).toMatchObject({ kind: "github" });
			// A push URL of the repository's own: refused, never followed.
			await git(["remote", "set-url", "--push", "origin", "https://evil.example/x/app.git"], repo);
			await expect(teamRepoGit(repo).originTarget()).rejects.toMatchObject({
				code: "TEAM_REMOTE_CONFIG_UNSAFE",
				key: "remote.origin.pushurl",
			});
			await git(["config", "--unset", "remote.origin.pushurl"], repo);
			// Its own rewrites of origin's URL: refused.
			for (const key of ["insteadOf", "pushInsteadOf"]) {
				await git(["config", `url.https://evil.example/.${key}`, "gh:"], repo);
				await expect(teamRepoGit(repo).originTarget()).rejects.toMatchObject({
					code: "TEAM_REMOTE_CONFIG_UNSAFE",
				});
				await git(["config", "--remove-section", "url.https://evil.example/"], repo);
			}
			// Two URLs: which one is meant cannot be told.
			await git(["config", "--add", "remote.origin.url", "git@github.com:evil/app"], repo);
			await expect(teamRepoGit(repo).originTarget()).rejects.toMatchObject({
				code: "TEAM_REMOTE_CONFIG_UNSAFE",
			});
			await git(["remote", "remove", "origin"], repo);
			expect(await teamRepoGit(repo).originTarget()).toBeNull();
		} finally {
			await writeFile(
				process.env.GIT_CONFIG_GLOBAL ?? "",
				"[user]\n\tname = Host\n\temail = h@e.test\n",
			);
		}
	});

	test("a shorthand the host rewrites to a URL git cannot be given (a password on ssh) is `unsafe`, never local (Devin)", async () => {
		const repo = await realpath(await mkdtemp(join(temporary, "repo-")));
		await git(["init", "-q", "-b", "main"], repo);
		await git(["remote", "add", "origin", "gh:acme/app.git"], repo);
		try {
			await writeFile(
				process.env.GIT_CONFIG_GLOBAL ?? "",
				'[user]\n\tname = Host\n\temail = h@e.test\n[url "ssh://git:pw@github.com/"]\n\tinsteadOf = gh:\n',
			);
			const hosting = await hostingOf(repo);
			expect(hosting).toMatchObject({ kind: "unsafe", key: "remote.origin.url" });
			// Never "not GitHub" (`other`), which would offer a local merge: the merge waits
			// (`remote_config_unsafe`).
			expect(hosting.kind).not.toBe("other");
		} finally {
			await writeFile(
				process.env.GIT_CONFIG_GLOBAL ?? "",
				"[user]\n\tname = Host\n\temail = h@e.test\n",
			);
		}
	});

	test("a redirected origin is `unsafe`: never GitHub, never local, read again soon", async () => {
		const repo = await realpath(await mkdtemp(join(temporary, "repo-")));
		await git(["init", "-q", "-b", "main"], repo);
		await git(["remote", "add", "origin", "git@github.com:acme/app.git"], repo);
		await git(["config", "remote.origin.pushurl", "git@github.com:evil/app.git"], repo);
		expect(await hostingOf(repo)).toMatchObject({ kind: "unsafe", key: "remote.origin.pushurl" });
	});
});

describe.skipIf(!posix)("gh (a fake on PATH)", () => {
	test("usable: logged in, may write; the methods the repository allows, its default first", async () => {
		const hosting = await resolveHosting("git@github.com:acme/app.git");
		expect(hosting).toEqual({
			kind: "github",
			host: "github.com",
			owner: "acme",
			repo: "app",
			gh: { ok: true, methods: ["squash", "merge"] },
		});
		const calls = await fake.calls();
		expect(calls.map((call) => call.args)).toEqual([
			["--version"],
			["auth", "status", "--hostname=github.com", "--json", "hosts"],
			[
				"repo",
				"view",
				"github.com/acme/app",
				"--json",
				"viewerPermission,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerDefaultMergeMethod,isArchived",
			],
		]);
	});

	test("missing, failing, logged out, read-only, archived, unreadable: each disables with its reason", async () => {
		fake.hideAll();
		expect(await resolveHosting("git@github.com:acme/app.git")).toMatchObject({
			kind: "github",
			gh: { ok: false, reason: "gh_missing" },
		});
		fake.activate();
		const cases: Array<[FakeGhPlan, string]> = [
			[{ "--version": { exit: 1, stderr: "broken" } }, "gh_missing"],
			[{ "auth status": { stdout: JSON.stringify({ hosts: {} }) } }, "gh_logged_out"],
			[{ "auth status": { stdout: authJson("github.com", "error") } }, "gh_logged_out"],
			[{ "repo view": { stdout: repoViewJson({ viewerPermission: "READ" }) } }, "gh_no_permission"],
			[
				{ "repo view": { stdout: repoViewJson({ viewerPermission: "TRIAGE" }) } },
				"gh_no_permission",
			],
			[{ "repo view": { stdout: repoViewJson({ isArchived: true }) } }, "gh_repo_archived"],
			[{ "repo view": { exit: 1, stderr: "Could not resolve to a Repository" } }, "gh_unavailable"],
			[{ "repo view": { stdout: "not json" } }, "gh_unavailable"],
		];
		for (const [answers, reason] of cases) {
			await fake.setPlan({ ...usableGh(), ...answers });
			const hosting = await resolveHosting("git@github.com:acme/app.git");
			expect({ answers, gh: hosting.kind === "github" ? hosting.gh : null }).toMatchObject({
				answers,
				gh: { ok: false, reason },
			});
			// Never "not GitHub": the PR flow stays, disabled (never a local merge).
			expect(hosting.kind).toBe("github");
		}
		for (const permission of ["MAINTAIN", "ADMIN"]) {
			await fake.setPlan({
				...usableGh(),
				"repo view": { stdout: repoViewJson({ viewerPermission: permission }) },
			});
			const hosting = await resolveHosting("git@github.com:acme/app.git");
			expect(hosting.kind === "github" && hosting.gh?.ok).toBe(true);
		}
	});

	test("a hung gh is killed at its timeout", async () => {
		setGhTimeoutScaleForTests(0.02);
		await fake.setPlan({ ...usableGh(), "auth status": { sleepMs: 5_000, stdout: "{}" } });
		const started = Date.now();
		const hosting = await resolveHosting("git@github.com:acme/app.git");
		expect(Date.now() - started).toBeLessThan(4_000);
		expect(hosting).toMatchObject({ kind: "github", gh: { ok: false, reason: "gh_unavailable" } });
	});

	test("GitHub Enterprise: GitHub only when gh knows the host; otherwise another host", async () => {
		await fake.setPlan({
			...usableGh("ghe.acme.test"),
			"auth status": { stdout: authJson("ghe.acme.test") },
		});
		expect(await resolveHosting("git@ghe.acme.test:team/app.git")).toEqual({
			kind: "github",
			host: "ghe.acme.test",
			owner: "team",
			repo: "app",
			gh: { ok: true, methods: ["squash", "merge"] },
		});
		const repoView = (await fake.calls()).find((call) => call.args[0] === "repo");
		expect(repoView?.args[2]).toBe("ghe.acme.test/team/app");
		// Known but logged out there: GitHub, disabled.
		await fake.setPlan({
			...usableGh(),
			"auth status": { stdout: authJson("ghe.acme.test", "error") },
		});
		expect(await resolveHosting("git@ghe.acme.test:team/app.git")).toMatchObject({
			kind: "github",
			gh: { ok: false, reason: "gh_logged_out" },
		});
		// Unknown to gh, or no gh at all: another host.
		await fake.setPlan({ ...usableGh(), "auth status": { stdout: JSON.stringify({ hosts: {} }) } });
		expect(await resolveHosting("git@gitlab.example:team/app.git")).toEqual({
			kind: "other",
			host: "gitlab.example",
		});
		fake.hideAll();
		expect(await resolveHosting("git@ghe.acme.test:team/app.git")).toEqual({
			kind: "other",
			host: "ghe.acme.test",
		});
	});

	test("an older gh without `auth status --json`: its text answer is read instead (Devin 2)", async () => {
		await fake.setPlan(olderGh());
		expect(await resolveHosting("git@github.com:acme/app.git")).toEqual({
			kind: "github",
			host: "github.com",
			owner: "acme",
			repo: "app",
			gh: { ok: true, methods: ["squash", "merge"] },
		});
		expect((await fake.calls()).map((call) => call.args.slice(0, 4))).toEqual([
			["--version"],
			["auth", "status", "--hostname=github.com", "--json"],
			["auth", "status", "--hostname=github.com"],
			["repo", "view", "github.com/acme/app", "--json"],
		]);
		// Logged out there, or gh does not know the host at all: disabled with the reason.
		await fake.setPlan(olderGh("github.com", "error"));
		expect(await resolveHosting("git@github.com:acme/app.git")).toMatchObject({
			kind: "github",
			gh: { ok: false, reason: "gh_logged_out" },
		});
		await fake.setPlan({
			...olderGh(),
			"auth status": {
				rejects: ["--json"],
				stderr: "You are not logged into any accounts on github.com\n",
				exit: 1,
			},
		});
		expect(await resolveHosting("git@github.com:acme/app.git")).toMatchObject({
			kind: "github",
			gh: { ok: false, reason: "gh_logged_out" },
		});
		// GitHub Enterprise still needs gh to know the host: listed when logged in or failing there.
		await fake.setPlan(olderGh("ghe.acme.test"));
		expect(await resolveHosting("git@ghe.acme.test:team/app.git")).toMatchObject({
			kind: "github",
			host: "ghe.acme.test",
			gh: { ok: true },
		});
		await fake.setPlan(olderGh("ghe.acme.test", "error"));
		expect(await resolveHosting("git@ghe.acme.test:team/app.git")).toMatchObject({
			kind: "github",
			gh: { ok: false, reason: "gh_logged_out" },
		});
		await fake.setPlan({
			...olderGh(),
			"auth status": {
				rejects: ["--json"],
				stderr: "You are not logged into any accounts on gitlab.example\n",
				exit: 1,
			},
		});
		expect(await resolveHosting("git@gitlab.example:team/app.git")).toEqual({
			kind: "other",
			host: "gitlab.example",
		});
	});

	test("the text answer is read defensively", () => {
		const read = (text: string, exitCode = 0, host = "ghe.acme.test") =>
			readAuthStatusText(host, { stdout: text, stderr: "", exitCode });
		// The pre-2.40 form.
		expect(read("ghe.acme.test\n  ✓ Logged in to ghe.acme.test as octo (oauth_token)\n")).toEqual({
			listed: true,
			loggedIn: true,
		});
		// Another host's login is not this host's (a longer name that starts with it).
		expect(read("ghe.acme.test.evil\n  ✓ Logged in to ghe.acme.test.evil account o\n", 1)).toEqual({
			listed: false,
			loggedIn: false,
		});
		expect(read("Timeout trying to log in to ghe.acme.test account o\n", 1)).toEqual({
			listed: true,
			loggedIn: false,
		});
		expect(
			read('hostname "ghe.acme.test" not found among authenticated GitHub hosts\n', 1),
		).toEqual({ listed: false, loggedIn: false });
	});

	test("gh runs in NarraFork's own empty directory, never a repository, with a cleaned environment", async () => {
		const saved = { ...process.env };
		Object.assign(process.env, {
			GH_TOKEN: "operator-token",
			GH_ENTERPRISE_TOKEN: "enterprise-token",
			GH_DEBUG: "api",
			GH_REPO: "evil/repo",
			GH_EDITOR: "evil-editor",
			EDITOR: "evil-editor",
			BROWSER: "evil-browser",
			GH_PAGER: "less",
			GIT_DIR: "/somewhere/else/.git",
			GIT_CONFIG_PARAMETERS: "'core.sshcommand=evil'",
			GIT_SSH_COMMAND: "evil-ssh",
		});
		try {
			await resolveHosting("git@github.com:acme/app.git");
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
		}
		const calls = await fake.calls();
		expect(calls.length).toBe(3);
		const dir = ghWorkDir();
		for (const call of calls) {
			expect(await realpath(call.cwd)).toBe(await realpath(dir));
			// No repository anywhere up from it, and git finds none through GIT_DIR.
			for (let at = call.cwd; ; at = dirname(at)) {
				expect({ at, git: existsSync(join(at, ".git")) }).toEqual({ at, git: false });
				if (dirname(at) === at) break;
			}
			expect(call.env.GIT_DIR).toBe(ghNoRepository(dir));
			expect(existsSync(call.env.GIT_DIR ?? "")).toBe(false);
			expect(call.env.GIT_CEILING_DIRECTORIES).toBe(dir);
			expect(call.env).toMatchObject({
				GH_PROMPT_DISABLED: "1",
				GH_NO_UPDATE_NOTIFIER: "1",
				GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
				GH_SPINNER_DISABLED: "1",
				GH_PAGER: "cat",
				NO_COLOR: "1",
				GIT_TERMINAL_PROMPT: "0",
				GH_TOKEN: "operator-token",
				GH_ENTERPRISE_TOKEN: "enterprise-token",
			});
			for (const key of [
				"GH_DEBUG",
				"GH_REPO",
				"GH_EDITOR",
				"EDITOR",
				"BROWSER",
				"GIT_CONFIG_PARAMETERS",
				"GIT_SSH_COMMAND",
			])
				expect({ key, present: key in call.env }).toEqual({ key, present: false });
			// Every repository named explicitly.
			if (call.args[0] === "repo") expect(call.args[2]).toBe("github.com/acme/app");
		}
	});

	test("a planted .git or no-repository in gh's directory: gh is not run", async () => {
		await resolveHosting("git@github.com:acme/app.git");
		for (const planted of [".git", "no-repository"]) {
			const path = join(ghWorkDir(), planted);
			await mkdir(path, { recursive: true });
			await fake.clearCalls();
			try {
				await expect(ghVersion()).rejects.toThrow(planted);
				expect(await fake.calls()).toEqual([]);
			} finally {
				await rm(path, { recursive: true, force: true });
			}
		}
	});

	test("the cache: one probe at a time, 5 minutes when usable, 60 seconds when not", async () => {
		let now = 1_000_000;
		setHostingSourceForTests(
			async () => "git@github.com:acme/app.git",
			() => now,
		);
		expect(peekHosting("/repo-a")).toBeNull();
		expect(peekHosting("/repo-a")).toBeNull();
		expect(await hostingOf("/repo-a")).toMatchObject({ kind: "github", gh: { ok: true } });
		const versions = async () =>
			(await fake.calls()).filter((call) => call.args[0] === "--version").length;
		expect(await versions()).toBe(1);
		now += 4 * 60_000;
		expect(peekHosting("/repo-a")).toMatchObject({ gh: { ok: true } });
		expect(await versions()).toBe(1);
		// Logged out: kept a minute only, so `gh auth login` on the host shows soon.
		await fake.setPlan({ ...usableGh(), "auth status": { stdout: JSON.stringify({ hosts: {} }) } });
		now += 2 * 60_000;
		expect(await hostingOf("/repo-a")).toMatchObject({
			gh: { ok: false, reason: "gh_logged_out" },
		});
		expect(await versions()).toBe(2);
		await fake.setPlan(usableGh());
		now += 30_000;
		expect(await hostingOf("/repo-a")).toMatchObject({ gh: { ok: false } });
		now += 31_000;
		expect(await hostingOf("/repo-a")).toMatchObject({ gh: { ok: true } });
		expect(await versions()).toBe(3);
	});
});
