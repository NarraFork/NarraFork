/**
 * Read-only questions about commits and refs, shared by `gitService` and the narrator
 * worktree service.
 *
 * Each function takes a runner instead of spawning git itself, so every caller keeps
 * its own process bounds: `gitService` runs them through `execRead` (60 s, 1 MB), the
 * worktree service through its local-backend runner (10 s, killed process tree, its
 * test seam). The functions never write and never list directories; their output is
 * a handful of SHAs and counters, so a truncated result is treated as a failure rather
 * than parsed.
 *
 * Revisions are resolved once with `rev-parse --verify ... ^{commit}` and everything
 * after that takes full SHAs. A user-supplied ref therefore can never be read as an
 * option, a range or a pathspec by a later command.
 */
import { GitError, ValidationError } from "../lib/errors";

export interface GitQueryResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	/** Output exceeded the runner's capture limit; `stdout` is a prefix. */
	truncated?: boolean;
}

/** Runs one git command in the caller's bound working directory. */
export type GitQueryRunner = (
	args: string[],
	options?: { maxOutputBytes?: number },
) => Promise<GitQueryResult>;

export interface GitAheadBehind {
	/** Commits reachable from the ref but not from the base. */
	ahead: number;
	/** Commits reachable from the base but not from the ref. */
	behind: number;
}

export interface GitUncommittedChanges {
	/** Changed, staged, deleted and untracked paths (ignored files excluded). */
	count: number;
	/** False when the listing hit the output cap: `count` is then a lower bound. */
	exact: boolean;
}

export interface GitUpstream {
	/** Full ref name, e.g. `refs/remotes/origin/main`. */
	ref: string;
	sha: string;
}

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
/** Status listing cap. Enough for ~5,000 typical paths; past it the count is a lower bound. */
export const GIT_UNCOMMITTED_LISTING_MAX_BYTES = 256 * 1024;
const SMALL_OUTPUT_BYTES = 4096;

function clip(text: string): string {
	return text.length > 512 ? `${text.slice(0, 512)}…` : text;
}

function failure(what: string, result: GitQueryResult): GitError {
	const detail = (result.stderr || result.stdout).trim();
	return new GitError(
		`${what} failed${detail ? `: ${clip(detail)}` : ` (exit code ${result.exitCode})`}`,
	);
}

/**
 * Reject a ref git could read as something else.
 *
 * A leading `-` is an option, `..` is a range, and whitespace and control characters
 * never occur in a ref name. The remaining syntax (`HEAD~2`, `origin/main`, a SHA) is
 * git's to judge: {@link resolveCommit} accepts only a single commit.
 */
export function assertQueryRef(ref: string): void {
	if (
		typeof ref !== "string" ||
		ref.length === 0 ||
		ref.length > 256 ||
		ref.startsWith("-") ||
		ref.includes("..") ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point.
		/[\s\u0000-\u001f\u007f]/.test(ref)
	)
		throw new ValidationError("Invalid Git revision");
}

function assertSha(sha: string): void {
	if (!SHA.test(sha)) throw new ValidationError("Expected a full commit SHA");
}

/** The commit a ref names, or null when it does not resolve to a commit. */
export async function resolveCommit(run: GitQueryRunner, ref: string): Promise<string | null> {
	assertQueryRef(ref);
	const result = await run(
		["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
		{
			maxOutputBytes: SMALL_OUTPUT_BYTES,
		},
	);
	if (result.truncated) throw failure("git rev-parse", result);
	if (result.exitCode !== 0) {
		// `--quiet` answers "no such commit" with exit 1 and nothing on stderr.
		if (result.exitCode === 1) return null;
		throw failure("git rev-parse", result);
	}
	const sha = result.stdout.trim();
	if (!SHA.test(sha)) throw failure("git rev-parse", result);
	return sha;
}

/** Best common ancestor of two commits, or null for unrelated histories. */
export async function mergeBase(run: GitQueryRunner, a: string, b: string): Promise<string | null> {
	assertSha(a);
	assertSha(b);
	const result = await run(["merge-base", a, b], { maxOutputBytes: SMALL_OUTPUT_BYTES });
	if (result.truncated) throw failure("git merge-base", result);
	// Exit 1 with no output is git's answer for "no common ancestor".
	if (result.exitCode === 1 && !result.stdout.trim() && !result.stderr.trim()) return null;
	const sha = result.stdout.trim();
	if (result.exitCode !== 0 || !SHA.test(sha)) throw failure("git merge-base", result);
	return sha;
}

/** Whether `ancestor` is reachable from `descendant` (a commit is its own ancestor). */
export async function isAncestor(
	run: GitQueryRunner,
	ancestor: string,
	descendant: string,
): Promise<boolean> {
	assertSha(ancestor);
	assertSha(descendant);
	const result = await run(["merge-base", "--is-ancestor", ancestor, descendant], {
		maxOutputBytes: SMALL_OUTPUT_BYTES,
	});
	if (result.exitCode === 0) return true;
	// Exit 1 is the documented "no"; anything else (missing object, timeout kill) is not.
	if (result.exitCode === 1 && !result.stderr.trim()) return false;
	throw failure("git merge-base --is-ancestor", result);
}

function parseCount(text: string): number {
	if (!/^\d{1,15}$/.test(text)) throw new GitError("git rev-list printed an invalid count");
	return Number(text);
}

/**
 * How far a commit has moved relative to an arbitrary base, not only its upstream.
 *
 * `rev-list --left-right --count base...ref` walks only the two sides of the
 * symmetric difference and prints two integers, so the output is constant-size; the
 * runner's timeout bounds the walk itself.
 */
export async function aheadBehind(
	run: GitQueryRunner,
	ref: string,
	base: string,
): Promise<GitAheadBehind> {
	assertSha(ref);
	assertSha(base);
	const result = await run(["rev-list", "--left-right", "--count", `${base}...${ref}`], {
		maxOutputBytes: SMALL_OUTPUT_BYTES,
	});
	if (result.exitCode !== 0 || result.truncated) throw failure("git rev-list", result);
	const parts = result.stdout.trim().split(/\s+/);
	if (parts.length !== 2) throw new GitError("git rev-list printed an invalid count");
	return { behind: parseCount(parts[0] ?? ""), ahead: parseCount(parts[1] ?? "") };
}

/**
 * Number of commits reachable from `tip` that no commit in `reachableFrom` contains.
 *
 * Zero means every commit of the branch is already in the base or its upstream, so
 * removing the checkout and the branch loses no history.
 */
export async function countCommitsNotIn(
	run: GitQueryRunner,
	tip: string,
	reachableFrom: readonly string[],
): Promise<number> {
	assertSha(tip);
	for (const sha of reachableFrom) assertSha(sha);
	const result = await run(["rev-list", "--count", tip, "--not", ...reachableFrom], {
		maxOutputBytes: SMALL_OUTPUT_BYTES,
	});
	if (result.exitCode !== 0 || result.truncated) throw failure("git rev-list", result);
	return parseCount(result.stdout.trim());
}

/**
 * Commits reachable from `tip` and from no local branch, remote-tracking ref or tag:
 * what deleting a detached checkout at `tip` would make unreachable. None of the
 * excluded refs is caller-chosen, so this cannot be talked into reporting zero.
 */
export async function countCommitsOnlyReachableFrom(
	run: GitQueryRunner,
	tip: string,
): Promise<number> {
	assertSha(tip);
	const result = await run(
		["rev-list", "--count", tip, "--not", "--branches", "--remotes", "--tags"],
		{ maxOutputBytes: SMALL_OUTPUT_BYTES },
	);
	if (result.exitCode !== 0 || result.truncated) throw failure("git rev-list", result);
	return parseCount(result.stdout.trim());
}

/** The configured upstream of a local branch and its commit, or null without one. */
export async function branchUpstream(
	run: GitQueryRunner,
	branch: string,
): Promise<GitUpstream | null> {
	assertQueryRef(branch);
	const result = await run(
		["for-each-ref", "--count=1", "--format=%(upstream)", `refs/heads/${branch}`],
		{ maxOutputBytes: SMALL_OUTPUT_BYTES },
	);
	if (result.exitCode !== 0 || result.truncated) throw failure("git for-each-ref", result);
	const ref = result.stdout.trim();
	if (!ref) return null;
	// A configured upstream whose remote ref was never fetched (or was pruned) proves nothing.
	const sha = await resolveCommit(run, ref);
	return sha ? { ref, sha } : null;
}

/**
 * Count uncommitted paths in the runner's worktree.
 *
 * Untracked files are listed individually (`-uall`): a new directory is as many
 * losses as it has files, and ignored files are not losses. Records are NUL
 * separated; a rename or copy carries its original path as one extra field. When the
 * listing hits the cap the partial last record is dropped and `exact` is false.
 *
 * Blind spots, by Git's design: an edit to a file marked `--skip-worktree` or
 * `--assume-unchanged` is not reported (Git does not look at it), and ignored files are
 * never counted although deleting the directory deletes them.
 */
export async function uncommittedChanges(
	run: GitQueryRunner,
	maxOutputBytes = GIT_UNCOMMITTED_LISTING_MAX_BYTES,
): Promise<GitUncommittedChanges> {
	const result = await run(
		["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
		{ maxOutputBytes },
	);
	if (result.exitCode !== 0) throw failure("git status", result);
	const fields = result.stdout.split("\0");
	// Without truncation the output ends with NUL, leaving one empty trailing field.
	// With truncation the trailing field is a partial record and is not counted.
	fields.pop();
	let count = 0;
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index] ?? "";
		if (field.length < 4) continue;
		count++;
		if (field[0] === "R" || field[0] === "C") index++;
	}
	return { count, exact: !result.truncated };
}
