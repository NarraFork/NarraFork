/**
 * Branch management against real repositories: `getBranches`, `checkoutBranch`,
 * `push`, `fetch`.
 *
 * A bare repository stands in for the remote, so every case here is git's own
 * behaviour — upstream tracking, worktree occupancy, non-fast-forward refusal —
 * rather than a re-encoding of assumptions about it. No case touches the network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, GitAuthError, GitError } from "../../lib/errors";
import { safeSpawn } from "../../lib/spawn";
import { gitCheckoutSchema } from "../../lib/validators/git";
import { gitNetworkFailure, gitService } from "../git-service";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `nf-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

async function git(
	cwd: string,
	args: string[],
	allowFailure = false,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	if (result.exitCode !== 0 && !allowFailure)
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	return result;
}

async function gitOut(cwd: string, args: string[]): Promise<string> {
	return (await git(cwd, args)).stdout.trim();
}

async function configure(dir: string): Promise<void> {
	await gitOut(dir, ["config", "user.email", "test@example.com"]);
	await gitOut(dir, ["config", "user.name", "Test"]);
	await gitOut(dir, ["config", "commit.gpgsign", "false"]);
}

async function commitFile(dir: string, name: string): Promise<void> {
	writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
	await gitOut(dir, ["add", "-A"]);
	await gitOut(dir, ["commit", "-m", name]);
}

/** A bare origin plus a clone whose `main` is already pushed. */
async function createRemoteClone(prefix: string) {
	const remote = tempDir(`${prefix}-remote`);
	const work = tempDir(`${prefix}-work`);
	await gitOut(remote, ["init", "--bare", "-b", "main"]);
	await git(work, ["clone", remote, "."]);
	await configure(work);
	await commitFile(work, "seed");
	await gitOut(work, ["push", "-u", "origin", "main"]);
	return { remote, work };
}

/** A second clone of the same origin, used to move the remote independently. */
async function cloneInto(remote: string, prefix: string): Promise<string> {
	const dir = tempDir(prefix);
	await git(dir, ["clone", remote, "."]);
	await configure(dir);
	return dir;
}

async function errorOf(run: () => Promise<unknown>): Promise<AppError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof AppError) return error;
		throw error;
	}
	throw new Error("expected the operation to fail");
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("getBranches", () => {
	test("reports local and remote branches with upstream tracking", async () => {
		const { work } = await createRemoteClone("branches");
		const listing = await gitService.getBranches(work);
		expect(listing.branch).toBe("main");
		expect(listing.detached).toBe(false);
		expect(listing.headSha).toBe(await gitOut(work, ["rev-parse", "HEAD"]));
		expect(listing.remotes).toEqual(["origin"]);
		expect(listing.defaultRemote).toBe("origin");
		expect(listing.truncated).toBe(false);
		const main = listing.local.find((entry) => entry.name === "main");
		expect(main).toMatchObject({
			upstream: "origin/main",
			ahead: 0,
			behind: 0,
			upstreamGone: false,
			worktreePath: null,
			subject: "seed",
		});
		expect(listing.remote.map((entry) => entry.name)).toEqual(["origin/main"]);
	});

	test("counts both directions once each side has moved", async () => {
		const { remote, work } = await createRemoteClone("branches-distance");
		const other = await cloneInto(remote, "branches-other");
		await commitFile(other, "remote-ahead");
		await gitOut(other, ["push", "origin", "main"]);
		await commitFile(work, "local-ahead");
		await gitService.fetch(work);
		const listing = await gitService.getBranches(work);
		const main = listing.local.find((entry) => entry.name === "main");
		expect(main?.ahead).toBe(1);
		expect(main?.behind).toBe(1);
	});

	test("uses the sole remote when there is no origin", async () => {
		const { work } = await createRemoteClone("branches-sole");
		await gitOut(work, ["remote", "rename", "origin", "upstream"]);
		const listing = await gitService.getBranches(work);
		expect(listing.remotes).toEqual(["upstream"]);
		expect(listing.defaultRemote).toBe("upstream");
	});
});

describe("checkoutBranch", () => {
	test("switches to an existing local branch", async () => {
		const { work } = await createRemoteClone("checkout");
		await gitOut(work, ["branch", "side"]);
		await gitService.checkoutBranch(work, { branch: "side" });
		expect(await gitOut(work, ["symbolic-ref", "--short", "HEAD"])).toBe("side");
	});

	test("creates a branch and switches to it, from HEAD or a start point", async () => {
		const { work } = await createRemoteClone("checkout-create");
		await gitService.checkoutBranch(work, { branch: "feature/new", create: true });
		expect(await gitOut(work, ["symbolic-ref", "--short", "HEAD"])).toBe("feature/new");
		await gitService.checkoutBranch(work, {
			branch: "feature/from-main",
			create: true,
			startPoint: "main",
		});
		expect(await gitOut(work, ["symbolic-ref", "--short", "HEAD"])).toBe("feature/from-main");
		expect(await gitOut(work, ["rev-parse", "HEAD"])).toBe(
			await gitOut(work, ["rev-parse", "main"]),
		);
	});

	test("a remote start point sets upstream even when autoSetupMerge is off", async () => {
		const { remote, work } = await createRemoteClone("checkout-track-force");
		const other = await cloneInto(remote, "checkout-track-force-other");
		await gitOut(other, ["checkout", "-b", "remote-only"]);
		await commitFile(other, "remote-only");
		await gitOut(other, ["push", "-u", "origin", "remote-only"]);
		await gitService.fetch(work);
		await gitOut(work, ["config", "branch.autoSetupMerge", "false"]);
		await gitService.checkoutBranch(work, {
			branch: "remote-only",
			create: true,
			startPoint: "origin/remote-only",
		});
		expect(await gitOut(work, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
			"origin/remote-only",
		);
	});

	test("accepts plus and non-ASCII start points, and ordinary revisions", () => {
		expect(
			gitCheckoutSchema.safeParse({
				branch: "from-cjk",
				create: true,
				startPoint: "origin/功能",
			}).success,
		).toBe(true);
		expect(
			gitCheckoutSchema.safeParse({
				branch: "from-plus",
				create: true,
				startPoint: "origin/feature+x",
			}).success,
		).toBe(true);
		expect(
			gitCheckoutSchema.safeParse({ branch: "next", create: true, startPoint: "HEAD~1" }).success,
		).toBe(true);
		expect(
			gitCheckoutSchema.safeParse({ branch: "bad", create: true, startPoint: "--force" }).success,
		).toBe(false);
	});

	test("tracks a remote branch under its short name", async () => {
		const { remote, work } = await createRemoteClone("checkout-track");
		const other = await cloneInto(remote, "checkout-track-other");
		await gitOut(other, ["checkout", "-b", "remote-only"]);
		await commitFile(other, "remote-only");
		await gitOut(other, ["push", "origin", "remote-only"]);
		await gitService.fetch(work);
		await gitService.checkoutBranch(work, { branch: "origin/remote-only" });
		expect(await gitOut(work, ["symbolic-ref", "--short", "HEAD"])).toBe("remote-only");
		expect(await gitOut(work, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
			"origin/remote-only",
		);
	});

	test("names the missing branch with 404 GIT_BRANCH_NOT_FOUND", async () => {
		const { work } = await createRemoteClone("checkout-missing");
		const error = await errorOf(() => gitService.checkoutBranch(work, { branch: "nope" }));
		expect(error).toBeInstanceOf(AppError);
		expect([error.statusCode, error.code]).toEqual([404, "GIT_BRANCH_NOT_FOUND"]);
	});

	test("refuses a name git would reject before running checkout", async () => {
		const { work } = await createRemoteClone("checkout-invalid");
		const error = await errorOf(() => gitService.checkoutBranch(work, { branch: "not..valid" }));
		expect([error.statusCode, error.code]).toEqual([400, "VALIDATION_ERROR"]);
	});

	test("surfaces git's refusal when another worktree holds the branch", async () => {
		const { work } = await createRemoteClone("checkout-worktree");
		await gitOut(work, ["branch", "shared"]);
		const sibling = tempDir("checkout-worktree-sibling");
		await gitOut(work, ["worktree", "add", sibling, "shared"]);
		const error = await errorOf(() => gitService.checkoutBranch(work, { branch: "shared" }));
		expect(error).toBeInstanceOf(GitError);
		expect(error.message).toMatch(/already (checked out|used by worktree)/);
		expect(error.message).toContain(sibling);
	});
});

describe("push", () => {
	test("establishes the upstream on a first push, then has nothing ahead", async () => {
		const { work } = await createRemoteClone("push-upstream");
		await gitService.checkoutBranch(work, { branch: "feature/log", create: true });
		await commitFile(work, "feature-work");
		const before = await gitService.getBranches(work);
		expect(before.local.find((entry) => entry.name === "feature/log")?.upstream).toBeNull();
		await gitService.push(work, { setUpstream: true });
		const after = await gitService.getBranches(work);
		const pushed = after.local.find((entry) => entry.name === "feature/log");
		expect(pushed).toMatchObject({ upstream: "origin/feature/log", ahead: 0, behind: 0 });
		expect(after.remote.map((entry) => entry.name)).toContain("origin/feature/log");
	});

	test("refuses a detached HEAD and a repository without a remote", async () => {
		const { work } = await createRemoteClone("push-detached");
		await gitOut(work, ["checkout", "--detach"]);
		const detached = await errorOf(() => gitService.push(work));
		expect([detached.statusCode, detached.code]).toEqual([409, "GIT_DETACHED_HEAD"]);

		const bare = tempDir("push-no-remote");
		await gitOut(bare, ["init", "-b", "main"]);
		await configure(bare);
		await commitFile(bare, "lonely");
		const noRemote = await errorOf(() => gitService.push(bare));
		expect([noRemote.statusCode, noRemote.code]).toEqual([422, "GIT_NO_REMOTE"]);
	});

	test("updates the tracked upstream branch when its name differs from the local branch", async () => {
		const { remote, work } = await createRemoteClone("push-renamed");
		await gitOut(work, ["branch", "-m", "main", "develop"]);
		expect(await gitOut(work, ["config", "--get", "branch.develop.merge"])).toBe("refs/heads/main");
		await commitFile(work, "develop-work");
		await gitService.push(work);
		expect(await gitOut(remote, ["rev-parse", "--verify", "refs/heads/main"])).toBe(
			await gitOut(work, ["rev-parse", "HEAD"]),
		);
		const created = await git(remote, ["rev-parse", "--verify", "refs/heads/develop"], true);
		expect(created.exitCode).not.toBe(0);
	});

	test("refuses to guess among several remotes when the branch has no upstream", async () => {
		const { work } = await createRemoteClone("push-ambiguous");
		await gitOut(work, ["remote", "rename", "origin", "upstream"]);
		const fork = tempDir("push-ambiguous-fork");
		await gitOut(fork, ["init", "--bare", "-b", "main"]);
		await gitOut(work, ["remote", "add", "fork", fork]);
		await gitOut(work, ["checkout", "-b", "feature"]);
		const error = await errorOf(() => gitService.push(work));
		expect([error.statusCode, error.code]).toEqual([422, "GIT_REMOTE_AMBIGUOUS"]);
		expect(error.message).toContain("Cannot choose a Git remote");
		expect(await gitOut(work, ["remote"])).toContain("upstream");
	});

	test("rejects a remote that is not configured", async () => {
		const { work } = await createRemoteClone("push-unknown-remote");
		const error = await errorOf(() => gitService.push(work, { remote: "elsewhere" }));
		expect([error.statusCode, error.code]).toEqual([400, "VALIDATION_ERROR"]);
	});

	test("passes a non-fast-forward refusal through instead of forcing it", async () => {
		const { remote, work } = await createRemoteClone("push-rejected");
		const other = await cloneInto(remote, "push-rejected-other");
		await commitFile(other, "theirs");
		await gitOut(other, ["push", "origin", "main"]);
		await commitFile(work, "ours");
		const error = await errorOf(() => gitService.push(work));
		expect(error).toBeInstanceOf(GitError);
		expect(error.message).toMatch(/non-fast-forward|\[rejected\]/);
		// The local commit is still there: nothing was forced or rewritten.
		expect(await gitOut(work, ["log", "-1", "--format=%s"])).toBe("ours");
	});
});

describe("fetch", () => {
	test("brings a new remote branch in, and prunes one the remote dropped", async () => {
		const { remote, work } = await createRemoteClone("fetch");
		const other = await cloneInto(remote, "fetch-other");
		await gitOut(other, ["checkout", "-b", "ephemeral"]);
		await commitFile(other, "ephemeral");
		await gitOut(other, ["push", "origin", "ephemeral"]);
		await gitService.fetch(work);
		let listing = await gitService.getBranches(work);
		expect(listing.remote.map((entry) => entry.name)).toContain("origin/ephemeral");

		await gitOut(other, ["push", "origin", "--delete", "ephemeral"]);
		await gitService.fetch(work, { prune: true });
		listing = await gitService.getBranches(work);
		expect(listing.remote.map((entry) => entry.name)).not.toContain("origin/ephemeral");
	});
});

describe("gitNetworkFailure", () => {
	const failed = (stderr: string) => ({ stdout: "", stderr, exitCode: 128 });

	test("maps credential failures to GitAuthError with git's own fatal line", () => {
		for (const stderr of [
			"remote: Invalid username or password.\nfatal: Authentication failed for 'https://example.test/r.git/'",
			"fatal: could not read Username for 'https://example.test': terminal prompts disabled",
			"git@example.test: Permission denied (publickey).\nfatal: Could not read from remote repository.",
			"fatal: Authentication failed for 'https://example.test/r.git/'",
		]) {
			const error = gitNetworkFailure("git push failed", failed(stderr));
			expect(error).toBeInstanceOf(GitAuthError);
			expect(error.statusCode).toBe(401);
		}
		const fatal = gitNetworkFailure(
			"git push failed",
			failed("warning: something\nfatal: Authentication failed for 'https://example.test/r.git/'"),
		);
		expect(fatal.message).toBe("fatal: Authentication failed for 'https://example.test/r.git/'");
	});

	test("keeps a non-fast-forward refusal verbatim as a GitError", () => {
		const stderr = [
			" ! [rejected]        main -> main (non-fast-forward)",
			"error: failed to push some refs to 'origin'",
			"hint: Updates were rejected because the tip of your current branch is behind",
		].join("\n");
		const error = gitNetworkFailure("git push failed", failed(stderr));
		expect(error).toBeInstanceOf(GitError);
		expect(error).not.toBeInstanceOf(GitAuthError);
		expect(error.message).toContain("non-fast-forward");
		expect(error.message).toContain("hint: Updates were rejected");
	});

	test("bounds a huge failure output", () => {
		const error = gitNetworkFailure("git fetch failed", failed("x".repeat(10_000)));
		expect(error.message.length).toBeLessThan(1200);
		expect(error.message).toContain("truncated");
	});
});
