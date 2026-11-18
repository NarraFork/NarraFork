/**
 * Every git command the team lifecycle runs inside a work item's worktree (P3). All read-only:
 * the server never merges, commits or checks out there — a base sync is handed to the item's
 * worker, whose own git calls go through the ordinary permissions.
 *
 * The worktree is a directory agents write to without a person's approval, so its git
 * configuration is untrusted input: each command runs with the overrides of
 * `git-exec-hardening.ts` (no hook of any kind, no fsmonitor, no external diff or textconv, no
 * index write, every configured filter emptied and every configuration-defined hook disabled by
 * name), after the once-per-process check that this git honors them. Reads reuse G1's query
 * functions with `gitService`'s read bounds (60 s, 1 MB).
 */
import { isAbsolute, resolve } from "node:path";
import { GitError } from "../../lib/errors";
import {
	ensureConfigOverridesHonored,
	GIT_NO_EXEC_CONFIG,
	type GitConfiguredPrograms,
	gitConfigEnv,
	noExternalDiffArgs,
	PROGRAM_CONFIG_QUERY,
	parseProgramConfig,
	untrustedProgramOverrides,
} from "../../lib/git-exec-hardening";
import { safeSpawn } from "../../lib/spawn";
import {
	countCommitsNotIn,
	type GitQueryRunner,
	isAncestor,
	resolveCommit,
	uncommittedChanges,
} from "../git-ref-queries";

const READ_TIMEOUT_MS = 60_000;
const READ_MAX_OUTPUT_BYTES = 1024 * 1024;

async function spawnGit(
	cwd: string,
	args: readonly string[],
	config: ReadonlyArray<readonly [string, string]>,
	maxOutputBytes: number,
) {
	await ensureConfigOverridesHonored();
	const result = await safeSpawn({
		cmd: ["git", "--no-optional-locks", "-C", cwd, ...noExternalDiffArgs(args)],
		env: {
			...process.env,
			// Never redirected to another repository by the server's own environment.
			GIT_DIR: undefined,
			GIT_COMMON_DIR: undefined,
			GIT_WORK_TREE: undefined,
			GIT_INDEX_FILE: undefined,
			GIT_EXTERNAL_DIFF: undefined,
			GIT_TERMINAL_PROMPT: "0",
			LC_ALL: "C",
			...gitConfigEnv(config),
		},
		timeout: READ_TIMEOUT_MS,
		maxOutputBytes,
		killProcessTree: true,
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
		truncated: result.stdoutTruncated === true || result.stderrTruncated === true,
	};
}

/** The filters and configuration-defined hooks a checkout's configuration names (all scopes). */
export async function configuredPrograms(cwd: string): Promise<GitConfiguredPrograms> {
	const result = await spawnGit(cwd, PROGRAM_CONFIG_QUERY, GIT_NO_EXEC_CONFIG, 64 * 1024);
	// Exit 1 without output: nothing matched.
	if (result.exitCode === 1 && !result.stdout) return { filters: [], hooks: [] };
	if (result.exitCode !== 0 || result.truncated)
		throw new GitError("git config could not list the configured filters and hooks");
	return parseProgramConfig(result.stdout);
}

/** One worktree's hardened, read-only git: G1's queries. */
export interface TeamGit {
	resolveCommit(ref: string): Promise<string | null>;
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
	countCommitsNotIn(tip: string, reachableFrom: readonly string[]): Promise<number>;
	uncommittedChanges(): Promise<{ count: number; exact: boolean }>;
}

export function teamGit(cwd: string): TeamGit {
	let overrides: Promise<Array<readonly [string, string]>> | null = null;
	const config = () => {
		overrides ??= configuredPrograms(cwd).then((programs) => [
			...GIT_NO_EXEC_CONFIG,
			...untrustedProgramOverrides(programs),
		]);
		return overrides;
	};
	const run: GitQueryRunner = async (args, options) =>
		spawnGit(
			cwd,
			args,
			await config(),
			Math.min(options?.maxOutputBytes ?? READ_MAX_OUTPUT_BYTES, READ_MAX_OUTPUT_BYTES),
		);
	return {
		resolveCommit: (ref) => resolveCommit(run, ref),
		isAncestor: (ancestor, descendant) => isAncestor(run, ancestor, descendant),
		countCommitsNotIn: (tip, reachableFrom) => countCommitsNotIn(run, tip, reachableFrom),
		uncommittedChanges: () => uncommittedChanges(run),
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
		16 * 1024,
	);
	if (result.exitCode === 1 && !result.stdout.trim()) return null;
	const value = result.stdout.replace(/\r?\n$/, "");
	if (result.exitCode !== 0 || result.truncated || !value)
		throw new GitError("git config could not read core.hooksPath");
	return isAbsolute(value) ? resolve(value) : resolve(worktree, value);
}
