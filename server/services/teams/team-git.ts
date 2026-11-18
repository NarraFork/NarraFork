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
 *
 * `changedPaths` (X) lists what a branch changed since its merge base with the base: a diff of
 * two commits, which never reads the working tree, the index or a filter.
 */
import { isAbsolute, resolve } from "node:path";
import {
	TEAM_CHANGED_DIR_SUFFIX,
	TEAM_CHANGED_PATHS_MAX,
	TEAM_CHANGED_PATHS_MAX_BYTES,
} from "@shared/project-teams";
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
	mergeBase,
	resolveCommit,
	uncommittedChanges,
} from "../git-ref-queries";

const READ_TIMEOUT_MS = 60_000;
const READ_MAX_OUTPUT_BYTES = 1024 * 1024;
/** Name-only listing cap: well past {@link TEAM_CHANGED_PATHS_MAX} typical paths. */
const CHANGED_LISTING_MAX_BYTES = 512 * 1024;
/** Top-level listing cap (one raw record per changed top-level entry). */
const TOP_LEVEL_LISTING_MAX_BYTES = 256 * 1024;

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

/** What a branch changed since its merge base with the base (committed changes only). */
export interface ChangedPaths {
	head: string;
	mergeBase: string;
	/** Sorted. When `collapsed`, top-level entries only, directories ending in `/`. */
	paths: string[];
	/** Over {@link TEAM_CHANGED_PATHS_MAX} paths or the byte budget: top-level entries kept. */
	collapsed: boolean;
}

/** One worktree's hardened, read-only git: G1's queries. */
export interface TeamGit {
	resolveCommit(ref: string): Promise<string | null>;
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
	countCommitsNotIn(tip: string, reachableFrom: readonly string[]): Promise<number>;
	uncommittedChanges(): Promise<{ count: number; exact: boolean }>;
	/**
	 * Paths changed between the merge base of HEAD and `baseRef`, and HEAD (`diff --name-only
	 * --no-renames`: a rename counts as both paths). Null when either does not resolve or the
	 * histories are unrelated.
	 */
	changedPaths(baseRef: string): Promise<ChangedPaths | null>;
}

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

/** NUL-separated records; a truncated listing drops its last, possibly partial, record. */
function nulRecords(stdout: string, truncated: boolean): string[] {
	const records = stdout.split("\0");
	records.pop();
	if (truncated) records.pop();
	return records;
}

async function changedPathsOf(run: GitQueryRunner, baseRef: string): Promise<ChangedPaths | null> {
	const head = await resolveCommit(run, "HEAD");
	const base = await resolveCommit(run, baseRef);
	if (!head || !base) return null;
	const fork = await mergeBase(run, head, base);
	if (!fork) return null;
	const listing = await run(["diff", "--name-only", "--no-renames", "-z", fork, head], {
		maxOutputBytes: CHANGED_LISTING_MAX_BYTES,
	});
	if (listing.exitCode !== 0) throw new GitError("git diff could not list the changed paths");
	const paths = nulRecords(listing.stdout, listing.truncated === true).filter(Boolean);
	if (
		!listing.truncated &&
		paths.length <= TEAM_CHANGED_PATHS_MAX &&
		utf8Bytes(JSON.stringify(paths)) <= TEAM_CHANGED_PATHS_MAX_BYTES
	)
		return { head, mergeBase: fork, paths: paths.sort(), collapsed: false };
	// Too many to keep: the top-level entries that changed (`diff-tree` without `-r` stops at
	// the first level; a tree's mode is 040000).
	const top = await run(["diff-tree", "--no-renames", "-z", fork, head], {
		maxOutputBytes: TOP_LEVEL_LISTING_MAX_BYTES,
	});
	if (top.exitCode !== 0 || top.truncated)
		throw new GitError("git diff-tree could not list the changed top-level entries");
	const records = nulRecords(top.stdout, false);
	const entries = new Set<string>();
	for (let index = 0; index + 1 < records.length; index += 2) {
		const meta = records[index] ?? "";
		const name = records[index + 1] ?? "";
		if (!meta.startsWith(":") || !name) continue;
		const [srcMode, dstMode] = meta.slice(1).split(" ");
		const isTree = srcMode === "040000" || dstMode === "040000";
		entries.add(isTree ? `${name}${TEAM_CHANGED_DIR_SUFFIX}` : name);
	}
	const collapsed = [...entries].sort();
	if (
		collapsed.length > TEAM_CHANGED_PATHS_MAX ||
		utf8Bytes(JSON.stringify(collapsed)) > TEAM_CHANGED_PATHS_MAX_BYTES
	)
		throw new GitError("The changed top-level entries do not fit the stored budget");
	return { head, mergeBase: fork, paths: collapsed, collapsed: true };
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
		changedPaths: (baseRef) => changedPathsOf(run, baseRef),
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
