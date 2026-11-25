/**
 * Every git command the team lifecycle runs inside a work item's worktree (P3). All read-only:
 * the server never merges, commits or checks out there — a base sync is handed to the item's
 * worker, whose own git calls go through the ordinary permissions. (A member's merge of a ready
 * item into its base is computed in the object store by `team-git-write.ts`, never in a
 * worktree.)
 *
 * The worktree is a directory agents write to without a person's approval, so its git
 * configuration is untrusted input: each command runs with the overrides of
 * `git-exec-hardening.ts` (no hook of any kind, no fsmonitor, no external diff or textconv, no
 * index write, every configured filter emptied and every configuration-defined hook disabled by
 * name), after the once-per-process check that this git honors them. Reads reuse G1's query
 * functions with `gitService`'s read bounds (60 s, 1 MB).
 *
 * `changedPaths` (X) lists what a branch changed since its merge base with the base: a diff of
 * two commits, which never reads the working tree, the index or a filter. `branchFileChanges`,
 * `treeEntry`, `treeBlobs` and `readBlob` feed the knowledge check of `work.ready`
 * (`team-knowledge.ts`): the full, uncollapsed listing with what was added, one path of a commit,
 * the files (with blob ids and sizes) a commit holds under a directory, and one blob's bytes.
 * All of them read commits and objects only, never the working tree, and fail rather than return
 * a partial result. `work.ready` pins one head commit and passes it to every one of them.
 */
import { stat } from "node:fs/promises";
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
/** The work-tree probe answers a dialog's lookup: a stuck filesystem must not hold it a minute. */
const WORK_TREE_PROBE_TIMEOUT_MS = 10_000;
const READ_MAX_OUTPUT_BYTES = 1024 * 1024;
/** Name-only listing cap: well past {@link TEAM_CHANGED_PATHS_MAX} typical paths. */
const CHANGED_LISTING_MAX_BYTES = 512 * 1024;
/** Top-level listing cap (one raw record per changed top-level entry). */
const TOP_LEVEL_LISTING_MAX_BYTES = 256 * 1024;
/** Full name-status listing cap for the knowledge check: over it, the check fails. */
const FILE_CHANGES_MAX_BYTES = READ_MAX_OUTPUT_BYTES;
/** Tree listing cap for the knowledge check: over it, the check fails. */
const TREE_LISTING_MAX_BYTES = 512 * 1024;
/** One-path `ls-tree` cap (a single record). */
const TREE_ENTRY_MAX_BYTES = 16 * 1024;
/** Stderr kept from a blob read. */
const BLOB_STDERR_MAX_BYTES = 16 * 1024;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

async function spawnGit(
	cwd: string,
	args: readonly string[],
	config: ReadonlyArray<readonly [string, string]>,
	maxOutputBytes: number,
	timeout = READ_TIMEOUT_MS,
	stdoutStream?: { maxBytes: number; onChunk: (chunk: Uint8Array) => boolean | undefined },
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
		timeout,
		maxOutputBytes,
		...(stdoutStream ? { stdoutStream, maxStderrBytes: BLOB_STDERR_MAX_BYTES } : {}),
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

/**
 * Whether `dir` is an existing directory inside a local git work tree: what a team needs from its
 * project's directory (a project may be associated with any existing folder). A bare repository,
 * a `.git` directory, a missing path, a timeout or any other failure all answer false. Asking
 * runs no program of the repository's configuration.
 */
export async function isGitWorkTree(dir: string): Promise<boolean> {
	const info = await stat(dir).catch(() => null);
	if (!info?.isDirectory()) return false;
	const result = await spawnGit(
		dir,
		["rev-parse", "--is-inside-work-tree"],
		GIT_NO_EXEC_CONFIG,
		1024,
		WORK_TREE_PROBE_TIMEOUT_MS,
	).catch(() => null);
	return (
		result !== null && result.exitCode === 0 && !result.truncated && result.stdout.trim() === "true"
	);
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

/** Every file a branch changed since its merge base with the base, uncollapsed. */
export interface BranchFileChanges {
	head: string;
	mergeBase: string;
	/** Sorted; a rename counts as both paths (`--no-renames`). */
	changed: string[];
	/** Sorted; the paths the branch added, the new side of a rename included. */
	added: string[];
}

/** One entry of a commit's tree (`ls-tree -l`). */
export interface TreeEntry {
	path: string;
	/** `100644`, `100755`, `120000` (symlink), `040000` (tree), `160000` (submodule). */
	mode: string;
	type: string;
	oid: string;
	/** Bytes of a blob; null for a tree or a submodule. */
	size: number | null;
}

/** A regular file of a commit: blob mode 100644 or 100755 (no symlink, no submodule). */
export interface TreeBlob {
	path: string;
	oid: string;
	size: number;
}

/** One worktree's hardened, read-only git: G1's queries. */
export interface TeamGit {
	resolveCommit(ref: string): Promise<string | null>;
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
	countCommitsNotIn(tip: string, reachableFrom: readonly string[]): Promise<number>;
	uncommittedChanges(): Promise<{ count: number; exact: boolean }>;
	/**
	 * Paths changed between the merge base of the head and `baseRef`, and the head (`diff
	 * --name-only --no-renames`: a rename counts as both paths). The head is `at` (a full commit
	 * SHA) when given, else HEAD as it is now. Null when either does not resolve or the histories
	 * are unrelated.
	 */
	changedPaths(baseRef: string, at?: string): Promise<ChangedPaths | null>;
	/**
	 * Every path changed between the merge base of `head` (a full commit SHA) and `baseRef`, and
	 * `head`, with the added ones (`diff --name-status --no-renames`). Null when the base does not
	 * resolve or the histories are unrelated; throws when git fails or the listing is over its
	 * byte cap.
	 */
	branchFileChanges(baseRef: string, head: string): Promise<BranchFileChanges | null>;
	/**
	 * The entry at exactly `path` (repository-relative, no trailing `/`) of a commit, or null
	 * when the commit has nothing there. Lists one level only, whatever `path` is.
	 */
	treeEntry(commit: string, path: string): Promise<TreeEntry | null>;
	/**
	 * The regular files (blob modes 100644/100755; no symlink or submodule) a commit holds under
	 * `dir` (a repository-relative directory ending in `/`), with blob ids and sizes, sorted by
	 * path. Throws when git fails or the listing is over its byte cap.
	 */
	treeBlobs(commit: string, dir: string): Promise<TreeBlob[]>;
	/**
	 * The bytes of one blob (`cat-file blob`, no filter or textconv), decoded as UTF-8. `size` is
	 * the blob's size from a listing: reading stops past it, and any other length throws.
	 */
	readBlob(oid: string, size: number): Promise<string>;
	/** The best common ancestor of two full commit SHAs, or null when they share no history. */
	mergeBase(a: string, b: string): Promise<string | null>;
	/**
	 * Lines added and removed per file between two full commit SHAs (`diff --numstat
	 * --no-renames`), in git's order. The listing is capped: past it `truncated` is set and the
	 * counts cover the files read. Throws when git fails.
	 */
	numstat(from: string, to: string): Promise<BranchNumstat>;
	/**
	 * The unified diff of one repository-relative path between two full commit SHAs, cut off at
	 * `maxBytes` (reading stops there). Throws when git fails.
	 */
	fileDiff(
		from: string,
		to: string,
		path: string,
		maxBytes: number,
	): Promise<{ text: string; truncated: boolean }>;
}

/** {@link TeamGit.numstat}: per-file counts (null for a binary file) and the totals. */
export interface BranchNumstat {
	files: { path: string; added: number | null; removed: number | null }[];
	added: number;
	removed: number;
	binaryFiles: number;
	truncated: boolean;
}

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

/** NUL-separated records; a truncated listing drops its last, possibly partial, record. */
function nulRecords(stdout: string, truncated: boolean): string[] {
	const records = stdout.split("\0");
	records.pop();
	if (truncated) records.pop();
	return records;
}

/** `at` (a full commit SHA) when given, else HEAD as it is now. */
async function headAt(run: GitQueryRunner, at: string | undefined): Promise<string | null> {
	if (at === undefined) return resolveCommit(run, "HEAD");
	if (!SHA.test(at)) throw new GitError("Expected a full commit SHA");
	return at;
}

async function changedPathsOf(
	run: GitQueryRunner,
	baseRef: string,
	at?: string,
): Promise<ChangedPaths | null> {
	const head = await headAt(run, at);
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

async function branchFileChangesOf(
	run: GitQueryRunner,
	baseRef: string,
	at: string,
): Promise<BranchFileChanges | null> {
	const head = await headAt(run, at);
	const base = await resolveCommit(run, baseRef);
	if (!head || !base) return null;
	const fork = await mergeBase(run, head, base);
	if (!fork) return null;
	const listing = await run(["diff", "--name-status", "--no-renames", "-z", fork, head], {
		maxOutputBytes: FILE_CHANGES_MAX_BYTES,
	});
	if (listing.exitCode !== 0) throw new GitError("git diff could not list the changed files");
	if (listing.truncated)
		throw new GitError("The branch changes more files than the knowledge check reads");
	// `-z --name-status`: a status record, then its path, each NUL-terminated.
	const records = nulRecords(listing.stdout, false);
	const changed = new Set<string>();
	const added = new Set<string>();
	for (let index = 0; index + 1 < records.length; index += 2) {
		const status = records[index] ?? "";
		const path = records[index + 1] ?? "";
		if (!status || !path) throw new GitError("git diff returned an unreadable listing");
		changed.add(path);
		if (status === "A") added.add(path);
	}
	if (records.length % 2 !== 0) throw new GitError("git diff returned an unreadable listing");
	return { head, mergeBase: fork, changed: [...changed].sort(), added: [...added].sort() };
}

function assertRelativePath(path: string): void {
	if (!path || path.startsWith("/") || path.startsWith("-") || path.split("/").includes(".."))
		throw new GitError("Expected a repository-relative path");
}

/** `<mode> SP <type> SP <object> SP+ <size> TAB <path>` (`ls-tree -l -z`). */
function treeEntryOf(record: string): TreeEntry {
	const tab = record.indexOf("\t");
	const [mode, type, oid, size, extra] = record.slice(0, Math.max(0, tab)).split(/ +/);
	if (tab < 0 || !mode || !type || !oid || !size || extra !== undefined || !SHA.test(oid))
		throw new GitError("git ls-tree returned an unreadable listing");
	const bytes = size === "-" ? null : Number(size);
	if (bytes !== null && !(Number.isSafeInteger(bytes) && bytes >= 0))
		throw new GitError("git ls-tree returned an unreadable listing");
	return { path: record.slice(tab + 1), mode, type, oid, size: bytes };
}

const isRegularBlob = (entry: TreeEntry): entry is TreeEntry & { size: number } =>
	entry.type === "blob" &&
	(entry.mode === "100644" || entry.mode === "100755") &&
	entry.size !== null;

async function treeEntryAt(
	run: GitQueryRunner,
	commit: string,
	path: string,
): Promise<TreeEntry | null> {
	if (!SHA.test(commit)) throw new GitError("Expected a full commit SHA");
	assertRelativePath(path);
	if (path.endsWith("/")) throw new GitError("Expected a path without a trailing /");
	// Without `-r` a directory is listed as its own entry, never descended into.
	const listing = await run(["ls-tree", "-l", "-z", "--full-tree", commit, "--", path], {
		maxOutputBytes: TREE_ENTRY_MAX_BYTES,
	});
	if (listing.exitCode !== 0) throw new GitError(`git ls-tree could not read ${path}`);
	if (listing.truncated) throw new GitError(`git ls-tree listed more than ${path}`);
	const entries = nulRecords(listing.stdout, false).map(treeEntryOf);
	return entries.find((entry) => entry.path === path) ?? null;
}

async function treeBlobsOf(run: GitQueryRunner, commit: string, dir: string): Promise<TreeBlob[]> {
	if (!SHA.test(commit)) throw new GitError("Expected a full commit SHA");
	assertRelativePath(dir);
	if (!dir.endsWith("/")) throw new GitError("Expected a repository-relative directory");
	const listing = await run(["ls-tree", "-r", "-l", "-z", "--full-tree", commit, "--", dir], {
		maxOutputBytes: TREE_LISTING_MAX_BYTES,
	});
	if (listing.exitCode !== 0) throw new GitError(`git ls-tree could not list ${dir}`);
	if (listing.truncated) throw new GitError(`${dir} holds more files than the listing reads`);
	const files: TreeBlob[] = [];
	for (const record of nulRecords(listing.stdout, false)) {
		const entry = treeEntryOf(record);
		if (isRegularBlob(entry)) files.push({ path: entry.path, oid: entry.oid, size: entry.size });
	}
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function readBlobOf(
	cwd: string,
	config: ReadonlyArray<readonly [string, string]>,
	oid: string,
	size: number,
): Promise<string> {
	if (!SHA.test(oid)) throw new GitError("Expected a full object id");
	if (!Number.isSafeInteger(size) || size < 0) throw new GitError("Expected a blob size");
	const chunks: Buffer[] = [];
	// Raw bytes, at most one past the size: a longer blob is cut off and refused.
	const result = await spawnGit(cwd, ["cat-file", "blob", oid], config, 0, READ_TIMEOUT_MS, {
		maxBytes: size + 1,
		onChunk: (chunk) => {
			chunks.push(Buffer.from(chunk));
			return true;
		},
	});
	const bytes = Buffer.concat(chunks);
	if (result.exitCode !== 0 || result.truncated || bytes.byteLength !== size)
		throw new GitError(`git cat-file could not read blob ${oid}`);
	return bytes.toString("utf8");
}

/** Numstat listing cap: some thousands of files; past it the counts are a lower bound. */
const NUMSTAT_MAX_BYTES = 512 * 1024;

async function numstatOf(run: GitQueryRunner, from: string, to: string): Promise<BranchNumstat> {
	if (!SHA.test(from) || !SHA.test(to)) throw new GitError("Expected full commit SHAs");
	// Paths relative to the repository root wherever git runs (a coordinator may work in a
	// subdirectory), whatever `diff.relative` says.
	const listing = await run(
		["diff", "--numstat", "--no-renames", "--no-relative", "-z", from, to],
		{
			maxOutputBytes: NUMSTAT_MAX_BYTES,
		},
	);
	const truncated = listing.truncated === true;
	if (listing.exitCode !== 0 && !truncated)
		throw new GitError("git diff could not count the changed lines");
	// `-z --numstat --no-renames`: `<added>\t<removed>\t<path>` records, NUL-terminated.
	const files: BranchNumstat["files"] = [];
	let added = 0;
	let removed = 0;
	let binaryFiles = 0;
	for (const record of nulRecords(listing.stdout, truncated)) {
		const first = record.indexOf("\t");
		const second = first < 0 ? -1 : record.indexOf("\t", first + 1);
		if (second < 0) continue;
		const plus = record.slice(0, first);
		const minus = record.slice(first + 1, second);
		const path = record.slice(second + 1);
		if (!path) continue;
		if (plus === "-" || minus === "-") {
			binaryFiles++;
			files.push({ path, added: null, removed: null });
			continue;
		}
		const a = Number(plus);
		const r = Number(minus);
		if (!Number.isSafeInteger(a) || !Number.isSafeInteger(r)) continue;
		added += a;
		removed += r;
		files.push({ path, added: a, removed: r });
	}
	return { files, added, removed, binaryFiles, truncated };
}

async function fileDiffOf(
	cwd: string,
	config: ReadonlyArray<readonly [string, string]>,
	from: string,
	to: string,
	path: string,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
	if (!SHA.test(from) || !SHA.test(to)) throw new GitError("Expected full commit SHAs");
	assertRelativePath(path);
	const chunks: Buffer[] = [];
	let size = 0;
	// Raw bytes, at most one past the budget: reading stops there and the text is cut off.
	const result = await spawnGit(
		cwd,
		// `:(top,literal)`: a file name from the repository root (as numstat lists it, whatever
		// directory git runs in), never a pattern (`*.txt` is that file only).
		[
			"diff",
			"--no-renames",
			"--no-relative",
			"--no-color",
			"-U3",
			from,
			to,
			"--",
			`:(top,literal)${path}`,
		],
		config,
		0,
		READ_TIMEOUT_MS,
		{
			maxBytes: maxBytes + 1,
			onChunk: (chunk) => {
				chunks.push(Buffer.from(chunk));
				size += chunk.byteLength;
				return true;
			},
		},
	);
	const truncated = size > maxBytes || result.truncated;
	if (result.exitCode !== 0 && !truncated) throw new GitError(`git diff could not read ${path}`);
	const bytes = Buffer.concat(chunks).subarray(0, maxBytes);
	// A cut may split a UTF-8 sequence: the decoder replaces the broken tail.
	return { text: bytes.toString("utf8"), truncated };
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
		changedPaths: (baseRef, at) => changedPathsOf(run, baseRef, at),
		branchFileChanges: (baseRef, head) => branchFileChangesOf(run, baseRef, head),
		treeEntry: (commit, path) => treeEntryAt(run, commit, path),
		treeBlobs: (commit, dir) => treeBlobsOf(run, commit, dir),
		readBlob: async (oid, size) => readBlobOf(cwd, await config(), oid, size),
		mergeBase: (a, b) => mergeBase(run, a, b),
		numstat: (from, to) => numstatOf(run, from, to),
		fileDiff: async (from, to, path, maxBytes) =>
			fileDiffOf(cwd, await config(), from, to, path, maxBytes),
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
