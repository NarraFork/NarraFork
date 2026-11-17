/**
 * Every git command the team lifecycle runs inside a work item's worktree (P3).
 *
 * The worktree is a directory agents write to without a person's approval, so its git
 * configuration is untrusted input: each command runs with `GIT_NO_EXEC_CONFIG` (no hooks, no
 * fsmonitor, no external diff, no signing program) and every configured filter driver emptied,
 * diffs with `--no-ext-diff --no-textconv`. Reads reuse G1's query functions through this
 * runner, with `gitService`'s read bounds (60 s, 1 MB). The one write, a base sync's merge, runs
 * only when no path it touches selects a configured filter or merge driver
 * (`pathsSelectingDrivers`: emptying a smudge filter would check raw content out, and a merge
 * driver cannot be emptied), with every filter emptied anyway, `--no-verify` and
 * `--no-gpg-sign`.
 */
import { isAbsolute, resolve } from "node:path";
import { worktreeLock } from "../../lib/async-mutex";
import { GitError, ValidationError } from "../../lib/errors";
import {
	DRIVER_CONFIG_QUERY,
	filterNeutralizers,
	GIT_NO_EXEC_CONFIG,
	type GitDrivers,
	gitConfigEnv,
	noExternalDiffArgs,
	parseDriverConfig,
} from "../../lib/git-exec-hardening";
import type { GitIdentityEnv } from "../../lib/git-identity";
import { safeSpawn } from "../../lib/spawn";
import {
	aheadBehind,
	changedPathsBetween,
	countCommitsNotIn,
	type GitChangedPaths,
	type GitQueryRunner,
	isAncestor,
	mergeBase,
	resolveCommit,
	uncommittedChanges,
} from "../git-ref-queries";

const READ_TIMEOUT_MS = 60_000;
const READ_MAX_OUTPUT_BYTES = 1024 * 1024;
/** A merge of a healthy repository takes seconds; a stuck one is killed and aborted. */
const MERGE_TIMEOUT_MS = 5 * 60_000;
const MERGE_MAX_OUTPUT_BYTES = 64 * 1024;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
/** Paths checked for driver attributes before a merge; past it the sync is handed off. */
export const ATTRIBUTE_PATHS_MAX = 2000;
const ATTRIBUTE_BATCH = 200;

function baseEnv(extra: Record<string, string>): Record<string, string | undefined> {
	return {
		...process.env,
		// Never redirected to another repository by the server's own environment.
		GIT_DIR: undefined,
		GIT_COMMON_DIR: undefined,
		GIT_WORK_TREE: undefined,
		GIT_INDEX_FILE: undefined,
		GIT_EXTERNAL_DIFF: undefined,
		GIT_EDITOR: ":",
		GIT_TERMINAL_PROMPT: "0",
		LC_ALL: "C",
		...extra,
	};
}

async function spawnGit(
	cwd: string,
	args: readonly string[],
	config: ReadonlyArray<readonly [string, string]>,
	limits: { timeout: number; maxOutputBytes: number },
	identity?: GitIdentityEnv | null,
) {
	const result = await safeSpawn({
		cmd: ["git", "--no-optional-locks", "-C", cwd, ...noExternalDiffArgs(args)],
		env: baseEnv({ ...gitConfigEnv(config), ...(identity ?? {}) }),
		timeout: limits.timeout,
		maxOutputBytes: limits.maxOutputBytes,
		killProcessTree: true,
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
		truncated: result.stdoutTruncated === true || result.stderrTruncated === true,
	};
}

/** The filter and merge drivers configured for a checkout (all configuration scopes). */
export async function configuredDrivers(cwd: string): Promise<GitDrivers> {
	const result = await spawnGit(cwd, DRIVER_CONFIG_QUERY, GIT_NO_EXEC_CONFIG, {
		timeout: READ_TIMEOUT_MS,
		maxOutputBytes: 64 * 1024,
	});
	// Exit 1 without output: nothing matched.
	if (result.exitCode === 1 && !result.stdout) return { filters: [], mergeDrivers: [] };
	if (result.exitCode !== 0 || result.truncated)
		throw new GitError("git config could not list the configured drivers");
	return parseDriverConfig(result.stdout);
}

/** One worktree's hardened git: G1's queries plus the base-sync merge. */
export interface TeamGit {
	drivers(): Promise<GitDrivers>;
	resolveCommit(ref: string): Promise<string | null>;
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
	mergeBase(a: string, b: string): Promise<string | null>;
	aheadBehind(ref: string, base: string): Promise<{ ahead: number; behind: number }>;
	countCommitsNotIn(tip: string, reachableFrom: readonly string[]): Promise<number>;
	uncommittedChanges(): Promise<{ count: number; exact: boolean }>;
	changedPaths(from: string, to: string): Promise<GitChangedPaths>;
	/**
	 * Of these paths, the ones whose attributes (in the worktree, and in `source`'s tree when
	 * given) select a configured filter or merge driver. At most {@link ATTRIBUTE_PATHS_MAX}
	 * paths; more is an error the caller treats as "unknown".
	 */
	pathsSelectingDrivers(paths: readonly string[], source?: string): Promise<string[]>;
	mergeNoFastForward(
		sha: string,
		message: string,
		identity?: GitIdentityEnv | null,
	): Promise<{ merged: true; head: string } | { merged: false; conflict: boolean; detail: string }>;
}

export function teamGit(cwd: string): TeamGit {
	let drivers: Promise<GitDrivers> | null = null;
	const readDrivers = () => {
		drivers ??= configuredDrivers(cwd);
		return drivers;
	};
	const config = async () => [
		...GIT_NO_EXEC_CONFIG,
		...filterNeutralizers((await readDrivers()).filters),
	];
	const run: GitQueryRunner = async (args, options) =>
		spawnGit(cwd, args, await config(), {
			timeout: READ_TIMEOUT_MS,
			maxOutputBytes: Math.min(
				options?.maxOutputBytes ?? READ_MAX_OUTPUT_BYTES,
				READ_MAX_OUTPUT_BYTES,
			),
		});
	return {
		drivers: readDrivers,
		resolveCommit: (ref) => resolveCommit(run, ref),
		isAncestor: (ancestor, descendant) => isAncestor(run, ancestor, descendant),
		mergeBase: (a, b) => mergeBase(run, a, b),
		aheadBehind: (ref, base) => aheadBehind(run, ref, base),
		countCommitsNotIn: (tip, reachableFrom) => countCommitsNotIn(run, tip, reachableFrom),
		uncommittedChanges: () => uncommittedChanges(run),
		changedPaths: (from, to) => changedPathsBetween(run, from, to),
		async pathsSelectingDrivers(paths, source) {
			const found = await readDrivers();
			if (found.filters.length === 0 && found.mergeDrivers.length === 0) return [];
			if (paths.length > ATTRIBUTE_PATHS_MAX)
				throw new GitError("Too many paths to check their attributes");
			if (source !== undefined && !SHA.test(source))
				throw new ValidationError("Expected a full commit SHA");
			const filters = new Set(found.filters);
			const merges = new Set(found.mergeDrivers);
			const hits = new Set<string>();
			for (const sourceArgs of [[], ...(source ? [["--source", source]] : [])]) {
				for (let start = 0; start < paths.length; start += ATTRIBUTE_BATCH) {
					const batch = paths.slice(start, start + ATTRIBUTE_BATCH);
					const result = await run([
						"check-attr",
						"-z",
						...sourceArgs,
						"filter",
						"merge",
						"--",
						...batch,
					]);
					if (result.exitCode !== 0 || result.truncated)
						throw new GitError("git check-attr could not read the attributes");
					const fields = result.stdout.split("\0");
					for (let index = 0; index + 2 < fields.length; index += 3) {
						const [path, attribute, value] = [fields[index], fields[index + 1], fields[index + 2]];
						if (!path || !value) continue;
						if (
							(attribute === "filter" && filters.has(value)) ||
							(attribute === "merge" && merges.has(value))
						)
							hits.add(path);
					}
				}
			}
			return [...hits].sort();
		},
		async mergeNoFastForward(sha, message, identity) {
			if (!SHA.test(sha)) throw new ValidationError("Expected a full commit SHA");
			// The worktree mutex `gitService` writes take; only lock-free commands run inside.
			return worktreeLock.acquire(cwd, async () => {
				const before = await resolveCommit(run, "HEAD");
				const limits = { timeout: MERGE_TIMEOUT_MS, maxOutputBytes: MERGE_MAX_OUTPUT_BYTES };
				// Callers checked no touched path selects a driver; every filter is emptied anyway.
				const result = await spawnGit(
					cwd,
					[
						"merge",
						"--no-ff",
						"--no-edit",
						"--no-verify",
						"--no-gpg-sign",
						"-m",
						message,
						"--end-of-options",
						sha,
					],
					await config(),
					limits,
					identity,
				);
				if (result.exitCode === 0) {
					const head = await resolveCommit(run, "HEAD");
					if (!head) throw new GitError("git merge succeeded but HEAD does not resolve");
					return { merged: true as const, head };
				}
				const output = `${result.stdout}\n${result.stderr}`.trim();
				await spawnGit(cwd, ["merge", "--abort"], await config(), limits);
				if ((await resolveCommit(run, "HEAD")) !== before)
					throw new GitError("git merge failed and the branch head moved; inspect the worktree");
				return {
					merged: false as const,
					conflict: /\bCONFLICT\b/.test(output),
					detail: output.length > 1024 ? `${output.slice(0, 1024)}…` : output,
				};
			});
		},
	};
}

/**
 * The directory git takes hooks from for this worktree when `core.hooksPath` is set (relative
 * values resolve against the worktree, as git resolves them there), or null when unset. Read
 * with every program disabled; reading configuration runs nothing.
 */
export async function configuredHooksDir(worktree: string): Promise<string | null> {
	const result = await spawnGit(
		worktree,
		["config", "--type=path", "--get", "core.hooksPath"],
		// The command-scope override would answer this question itself: read the files' value.
		GIT_NO_EXEC_CONFIG.filter(([key]) => key !== "core.hooksPath"),
		{ timeout: READ_TIMEOUT_MS, maxOutputBytes: 16 * 1024 },
	);
	if (result.exitCode === 1 && !result.stdout.trim()) return null;
	const value = result.stdout.replace(/\r?\n$/, "");
	if (result.exitCode !== 0 || result.truncated || !value)
		throw new GitError("git config could not read core.hooksPath");
	return isAbsolute(value) ? resolve(value) : resolve(worktree, value);
}
