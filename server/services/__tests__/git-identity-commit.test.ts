/**
 * Per-user commit attribution, asserted against real repositories.
 *
 * The behaviour under test IS git's behaviour — which identity wins between an env
 * variable and a config file, what happens to an empty ident, whether a cherry-pick
 * keeps its original author — so mocking `safeSpawn` would only encode our
 * assumptions about git rather than check them.
 *
 * Every repository here sets a repo-local `user.name`/`user.email` standing in for
 * the host machine's global config. That is what a mis-wired identity silently falls
 * back to, so each test can distinguish "attributed to the acting user" from
 * "attributed to the host" instead of merely observing that a commit happened.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGitIdentityEnv } from "../../lib/git-identity";
import { safeSpawn } from "../../lib/spawn";
import { gitService } from "../git-service";

const tempDirs: string[] = [];

const HOST_NAME = "Host Machine";
const HOST_EMAIL = "host@example.invalid";

const ALICE = buildGitIdentityEnv({ name: "Alice", email: "alice@example.com" });
const BOB = buildGitIdentityEnv({ name: "Bob", email: "bob@example.com" });

async function git(args: string[], cwd: string): Promise<string> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
}

/** author/committer of a commit, in a form that makes a wrong one obvious. */
async function identityOf(cwd: string, rev = "HEAD"): Promise<string> {
	return git(["log", "-1", "--format=author=%an <%ae> committer=%cn <%ce>", rev], cwd);
}

/**
 * A repository with one commit on `main` whose ONLY configured identity is the
 * stand-in for the host machine. Anything attributed to `Host Machine` afterwards
 * means the identity never reached git.
 */
async function createRepo(prefix: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), `nf-${prefix}-`));
	tempDirs.push(dir);
	// -b main so nothing depends on the host's init.defaultBranch.
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.name", HOST_NAME], dir);
	await git(["config", "user.email", HOST_EMAIL], dir);
	writeFileSync(join(dir, "seed.txt"), "seed\n");
	await git(["add", "-A"], dir);
	await git(["commit", "-m", "seed"], dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("gitService.commit identity", () => {
	test("an identity overrides the repo config for BOTH author and committer", async () => {
		const dir = await createRepo("commit-identity");
		writeFileSync(join(dir, "work.txt"), "work\n");
		await git(["add", "-A"], dir);

		await gitService.commit(dir, "alice work", ALICE);

		expect(await identityOf(dir)).toBe(
			"author=Alice <alice@example.com> committer=Alice <alice@example.com>",
		);
	});

	test("no identity inherits the host config, unchanged from before this existed", async () => {
		// The regression guard for the no-identity path: `exec` must pass no env at
		// all rather than an env it assembled, or every commit on a machine whose
		// PATH/HOME matter would behave differently than it used to.
		const dir = await createRepo("commit-host");
		writeFileSync(join(dir, "work.txt"), "work\n");
		await git(["add", "-A"], dir);

		await gitService.commit(dir, "host work");

		expect(await identityOf(dir)).toBe(
			`author=${HOST_NAME} <${HOST_EMAIL}> committer=${HOST_NAME} <${HOST_EMAIL}>`,
		);
	});

	test("two users committing in one repo produce two distinct authors", async () => {
		// The actual multi-user requirement: the same worktree, driven by different
		// people, must not collapse into a single author.
		const dir = await createRepo("commit-two-users");

		writeFileSync(join(dir, "a.txt"), "a\n");
		await git(["add", "-A"], dir);
		await gitService.commit(dir, "alice change", ALICE);

		writeFileSync(join(dir, "b.txt"), "b\n");
		await git(["add", "-A"], dir);
		await gitService.commit(dir, "bob change", BOB);

		expect(await git(["log", "-2", "--format=%an"], dir)).toBe("Bob\nAlice");
	});

	test("passing an env still leaves git runnable, i.e. PATH/HOME were not stripped", async () => {
		// `Bun.spawn`'s env REPLACES the parent environment. Handing git only the four
		// GIT_* variables would leave it without PATH/HOME; the failure mode is not a
		// wrong author but git failing or behaving oddly, so this asserts the commit
		// actually succeeded and is readable.
		const dir = await createRepo("commit-env-merge");
		writeFileSync(join(dir, "work.txt"), "work\n");
		await git(["add", "-A"], dir);

		const sha = await gitService.commit(dir, "env sanity", ALICE);

		expect(sha).toMatch(/^[0-9a-f]{40}$/);
		expect(await git(["log", "-1", "--format=%s"], dir)).toBe("env sanity");
	});
});

describe("gitService.autoCommit identity", () => {
	test("the dormant/pre-merge auto-save is attributed to the acting user", async () => {
		const dir = await createRepo("autocommit-identity");
		writeFileSync(join(dir, "dirty.txt"), "uncommitted\n");

		const sha = await gitService.autoCommit(dir, "auto-save before dormant", ALICE);

		expect(sha).toMatch(/^[0-9a-f]{40}$/);
		expect(await identityOf(dir)).toBe(
			"author=Alice <alice@example.com> committer=Alice <alice@example.com>",
		);
	});

	test("an unattended auto-save with no identity falls back to the host", async () => {
		// The scheduled dormant sweep passes no user on purpose: a timer firing is
		// nobody's authored change.
		const dir = await createRepo("autocommit-host");
		writeFileSync(join(dir, "dirty.txt"), "uncommitted\n");

		await gitService.autoCommit(dir, "auto-save before dormant");

		expect(await identityOf(dir)).toBe(
			`author=${HOST_NAME} <${HOST_EMAIL}> committer=${HOST_NAME} <${HOST_EMAIL}>`,
		);
	});
});

describe("gitService.merge identity", () => {
	test("the merge commit belongs to whoever asked for the merge", async () => {
		const dir = await createRepo("merge-identity");
		await git(["checkout", "-b", "feature"], dir);
		writeFileSync(join(dir, "feature.txt"), "feature\n");
		await git(["add", "-A"], dir);
		await gitService.commit(dir, "feature work", BOB);

		await git(["checkout", "main"], dir);
		writeFileSync(join(dir, "trunk.txt"), "trunk\n");
		await git(["add", "-A"], dir);
		await gitService.commit(dir, "trunk work", BOB);

		const result = await gitService.merge(dir, "feature", "merge", "merge feature", {
			identity: ALICE,
		});

		expect(result.success).toBe(true);
		expect(await identityOf(dir)).toBe(
			"author=Alice <alice@example.com> committer=Alice <alice@example.com>",
		);
	});

	test("a squash merge's synthesized commit is attributed too", async () => {
		// The squash path commits in a SECOND git invocation after the merge, which is
		// easy to leave un-threaded: the merge would carry the identity and the commit
		// that actually lands would not.
		const dir = await createRepo("merge-squash-identity");
		await git(["checkout", "-b", "feature"], dir);
		writeFileSync(join(dir, "feature.txt"), "feature\n");
		await git(["add", "-A"], dir);
		await gitService.commit(dir, "feature work", BOB);
		await git(["checkout", "main"], dir);

		const result = await gitService.merge(dir, "feature", "squash", "squashed feature", {
			identity: ALICE,
		});

		expect(result.success).toBe(true);
		expect(await identityOf(dir)).toBe(
			"author=Alice <alice@example.com> committer=Alice <alice@example.com>",
		);
	});
});

describe("gitService.cherryPick identity", () => {
	test("keeps the original author and records the acting user as committer", async () => {
		// git's own semantics, kept deliberately: Alice transplanted Bob's change, she
		// did not write it. Rewriting the author would misattribute Bob's work.
		const dir = await createRepo("cherry-pick-identity");
		const baseSha = await git(["rev-parse", "HEAD"], dir);

		await git(["checkout", "-b", "feature"], dir);
		writeFileSync(join(dir, "feature.txt"), "feature\n");
		await git(["add", "-A"], dir);
		await gitService.commit(dir, "bob work", BOB);
		await git(["checkout", "main"], dir);

		const result = await gitService.cherryPick(dir, dir, "feature", baseSha, ALICE);

		expect(result.success).toBe(true);
		expect(await identityOf(dir)).toBe(
			"author=Bob <bob@example.com> committer=Alice <alice@example.com>",
		);
	});
});

describe("gitService.revertCommit identity", () => {
	test("the revert is a new commit authored by whoever undid the change", async () => {
		const dir = await createRepo("revert-identity");
		writeFileSync(join(dir, "work.txt"), "work\n");
		await git(["add", "-A"], dir);
		const target = await gitService.commit(dir, "bob work", BOB);

		await gitService.revertCommit(dir, target, ALICE);

		expect(await identityOf(dir)).toBe(
			"author=Alice <alice@example.com> committer=Alice <alice@example.com>",
		);
	});
});

describe("gitService.initRepo / stageAndCommit identity", () => {
	test("project setup commits belong to the project creator", async () => {
		const parent = mkdtempSync(join(tmpdir(), "nf-init-identity-"));
		tempDirs.push(parent);
		const dir = join(parent, "repo");

		await gitService.initRepo(dir, ALICE);

		// A repo created this way has NO user.name/user.email of its own, so the
		// initial commit would fail outright without a usable identity — which is
		// exactly why buildGitIdentityEnv must never emit a half-filled env.
		expect(await identityOf(dir)).toBe(
			"author=Alice <alice@example.com> committer=Alice <alice@example.com>",
		);

		writeFileSync(join(dir, ".gitignore"), "node_modules\n");
		await gitService.stageAndCommit(dir, [".gitignore"], "Add .gitignore", ALICE);

		expect(await identityOf(dir)).toBe(
			"author=Alice <alice@example.com> committer=Alice <alice@example.com>",
		);
	});
});

describe("git's own identity contract", () => {
	test("an empty ident name is fatal, so a partial env cannot be a fallback", async () => {
		// The fact that makes buildGitIdentityEnv's atomicity load-bearing. If this
		// ever stopped being true, half-filled identities would merely mis-attribute
		// instead of breaking every commit — a much quieter bug.
		const dir = await createRepo("empty-ident");
		writeFileSync(join(dir, "work.txt"), "work\n");
		await git(["add", "-A"], dir);

		const result = await safeSpawn({
			cmd: ["git", "commit", "-m", "empty ident"],
			cwd: dir,
			timeout: 15_000,
			env: { ...process.env, GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "x@example.com" },
		});

		expect(result.exitCode).not.toBe(0);
	});
});
