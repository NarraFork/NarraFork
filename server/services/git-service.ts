import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { worktreeLock } from "../lib/async-mutex";
import { GitAuthError, GitError } from "../lib/errors";
import type { GitIdentityEnv } from "../lib/git-identity";
import { logger } from "../lib/logger";
import { envWithAmbientProxy } from "../lib/net/proxy-env";
import { DEV_NULL } from "../lib/platform";
import { safeSpawn } from "../lib/spawn";
import { supportsMergeTree, WORKTREES_DIR_NAME } from "./worktree-tree-snapshot";

interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	/**
	 * Output exceeded the capture limit, so `stdout` is a prefix of what git printed.
	 *
	 * Exposed rather than hidden because for a parser the difference matters: a
	 * truncated `-z` listing ends mid-record and a truncated merge-tree result loses
	 * conflict paths. Callers that can be wrong silently must check this; callers
	 * that only show text to a human can ignore it.
	 */
	truncated?: boolean;
}

interface ExecOptions {
	silent?: boolean;
	optionalLocks?: boolean;
	/**
	 * Hard timeout in ms. Left undefined for write/network operations (clone, fetch,
	 * push) where a legitimate run can take minutes and killing it mid-way is worse
	 * than waiting.
	 */
	timeout?: number;
	maxOutputBytes?: number;
	/**
	 * `GIT_AUTHOR_*`/`GIT_COMMITTER_*` overrides that attribute a commit to the
	 * acting person instead of the host machine's global git config.
	 *
	 * Only meaningful for commands that write commit objects. Null/undefined is the
	 * documented "inherit the host identity" case and must remain byte-for-byte
	 * identical to the historical behaviour, so no env is passed at all in that case
	 * — see the note in {@link exec}.
	 */
	identity?: GitIdentityEnv | null;
}

/** Commit-writing methods take this to attribute the commit to a real person. */
export type GitCommitIdentity = GitIdentityEnv | null | undefined;

/**
 * Ceiling for read-only git commands.
 *
 * These all run on the server's single JS thread and are awaited by HTTP handlers,
 * so an unbounded `git log`/`diff` against a pathological repository stalls every
 * other request. 60 s is far above any healthy local invocation while still
 * guaranteeing the request eventually returns.
 */
const READ_TIMEOUT_MS = 60_000;
/**
 * Capture ceiling for read-only git commands, an order of magnitude below
 * safeSpawn's 10 MB default.
 *
 * Nothing here feeds a client more than ~100 KB (diffs are truncated, listings are
 * capped at 200 entries), so retaining megabytes only inflates peak heap. The
 * streams are still drained — only the retained string is bounded.
 */
const READ_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Depth of the walk behind {@link gitService.getLastCommitTimes}.
 *
 * Measured on this repository: 200 commits resolved 90 of 127 changed paths, and 400
 * and 800 resolved the same 90 — the walk stops finding new paths well before it stops
 * producing output (40 KB at 200, 88 KB at 800). Anything unresolved falls back to the
 * window boundary, which is safe by construction, so extra depth buys nothing.
 */
const COMMIT_BOUNDARY_MAX_COMMITS = 200;

/**
 * Path ceiling for one boundary walk.
 *
 * Matched to the 200-entry cap on `getStatusSummary().files`: the caller cannot show
 * more changed files than that, so a larger pathspec would describe rows nobody
 * renders. Also keeps the argument vector far below ARG_MAX (128 paths measured at
 * 5 KB here, against a 2 MB limit).
 */
const COMMIT_BOUNDARY_MAX_PATHS = 200;

/**
 * Prefix marking a commit line in the boundary walk.
 *
 * `--name-only` prints paths bare on their own lines, so commit lines need a sentinel
 * that cannot occur at the start of a repo-relative path. NUL is the one byte git
 * forbids in a path, which makes misparsing impossible rather than merely unlikely.
 *
 * It cannot be written literally in the format argument — spawn rejects an argv entry
 * containing NUL (`ERR_INVALID_ARG_VALUE`) — so the format uses git's `%x00` escape and
 * git emits the byte itself. Note that `String.prototype.trim` does NOT strip NUL, so
 * the marker survives line trimming.
 */
const COMMIT_BOUNDARY_MARKER = "\0";
/** The `%x00` escape that makes git print {@link COMMIT_BOUNDARY_MARKER}. */
const COMMIT_BOUNDARY_MARKER_FORMAT = "%x00";

/**
 * Convert a git ISO-8601 timestamp to the UTC `...Z` form.
 *
 * `%cI` carries the committer's local offset (`2026-08-14T18:19:20+08:00`) while
 * `file_attributions.changedAt` is stored as UTC with a `Z` suffix. These boundaries are
 * compared against that column as STRINGS, and lexicographic order across different
 * offsets is meaningless: the example above sorts after `2026-08-14T11:00:00Z` despite
 * being two hours earlier. Normalizing here keeps every consumer on one representation.
 *
 * Returns null for an unparseable value rather than a wrong instant, so a caller can
 * skip the boundary instead of silently filtering on garbage.
 */
function toUtcIso(raw: string): string | null {
	const ms = Date.parse(raw);
	if (Number.isNaN(ms)) return null;
	return new Date(ms).toISOString();
}

/**
 * Default depth for {@link gitService.findCommitLogIndex}.
 *
 * A cursor deeper than this means the client is asking for a position no user
 * scrolled to, and the caller already has a correct fallback (skip-based paging).
 */
const COMMIT_LOG_INDEX_SEARCH_LIMIT = 50_000;

/**
 * Bytes to retain for a `--format=%H` walk of `n` commits.
 *
 * One line is 41 bytes (40 hex + newline). The default `READ_MAX_OUTPUT_BYTES`
 * (1 MB) holds only ~25k of them, so a 50k-line request silently lost half its
 * depth: git walked the history, safeSpawn discarded the tail, and the scan
 * reported "not found" for commits that were in range. Sized from the line count
 * so the two budgets cannot drift apart again, plus a small slack for a trailing
 * newline and any truncation marker.
 */
function commitLogIndexMaxOutputBytes(searchLimit: number): number {
	return Math.max(READ_MAX_OUTPUT_BYTES, searchLimit * 41 + 1024);
}

/**
 * Serialize git write operations for one worktree.
 *
 * Read-only operations (status, diff, log, etc.) usually don't need this
 * application-level mutex, but Git may still refresh the index and briefly
 * create `.git/index.lock`. Use execRead() for those commands so Git disables
 * optional index writes via `--no-optional-locks`.
 *
 * This is `lib/async-mutex`'s shared {@link worktreeLock}, not a module-private
 * instance. It used to be private, which meant a worktree had two independent locks
 * over it: this one, and the one the multi-step orchestrations (`chapter-merge`,
 * `routes/ruler`) take around whole sequences. Two locks over one resource provide no
 * mutual exclusion between their holders — a merge holding the outer lock and a plain
 * `POST /api/git/.../commit` taking only this one could interleave their `git`
 * invocations on the same index, which is the class of corruption both locks exist to
 * prevent.
 *
 * Unifying them makes nesting fatal rather than merely redundant, which is what the
 * `*Unlocked` variants below address; see the note above them.
 */
async function withWorktreeLock<T>(worktreePath: string, fn: () => Promise<T>): Promise<T> {
	return worktreeLock.acquire(worktreePath, fn);
}

/**
 * Why every locked write method here has an `*Unlocked` twin.
 *
 * The multi-step orchestrations (`chapter-merge`, `routes/ruler`,
 * `snapshot-dirty-git-op`) must hold a worktree exclusively across a *sequence* of
 * commands — settle, park, rebase, reapply — because each step reads the state the
 * previous one produced. They take the worktree lock themselves and then call
 * individual write methods from inside it.
 *
 * No mutex here is re-entrant, and `AsyncMutex.acquire` chains behind the current tail
 * without checking who owns it, so such a nested call waits on a lock its own caller
 * holds. That is a deterministic self-deadlock, and its symptom is a request that hangs
 * forever rather than an error — nothing logs, nothing throws, the HTTP handler simply
 * never returns.
 *
 * The alternative of making the mutex re-entrant was rejected: `AsyncMutex` backs 20+
 * instances with unrelated semantics (`narratorTraitsLock`, plugin locks, draft locks),
 * and owner tracking would need an `AsyncLocalStorage` context threaded through all of
 * them, widening the blast radius of a lock bug from one subsystem to every one.
 *
 * So the split is explicit instead: `xxxUnlocked` holds the command sequence with no
 * locking, `xxx` is a thin `withWorktreeLock` wrapper around it. Callers that already
 * hold the lock call the former; everyone else keeps calling the latter and is
 * unaffected. This mirrors `worktree-tree-snapshot`'s `captureUnlocked` /
 * `restoreUnlocked` / `getRefUnlocked` convention.
 *
 * Adding a write method? Put the body in `xxxUnlocked` and wrap it. Calling one from
 * inside a `worktreeLock` block? Use the unlocked variant, and note in a comment that
 * the caller owns the lock. `git-service-worktree-lock.test.ts` fails on a deadline if
 * either rule is broken.
 */

export interface GitStatusFile {
	/** Two-character porcelain status, e.g. "M ", " M", "MM", "??". */
	status: string;
	path: string;
	/**
	 * Pre-rename path, for an `R`/`C` entry. Undefined for every other status.
	 *
	 * Porcelain already reports it (`R  old\0new`) and the parser already extracts it; it
	 * is surfaced here because consumers keyed on `path` alone cannot find anything
	 * recorded before the rename. File attribution is the concrete case: rows are written
	 * under the path that existed at the time, so a renamed file's entire history sits
	 * under a path that no longer appears in the diff.
	 */
	oldPath?: string;
	linesAdded: number;
	linesRemoved: number;
	stagedLinesAdded: number;
	stagedLinesRemoved: number;
	unstagedLinesAdded: number;
	unstagedLinesRemoved: number;
}

export interface GitStatusSummary {
	hasChanges: boolean;
	staged: number;
	unstaged: number;
	untracked: number;
	/** Capped at 200 entries. Use `totalFiles` for the real count. */
	files: GitStatusFile[];
	/** Total number of changed files (may exceed files.length). */
	totalFiles: number;
	headSha: string;
	branch: string;
	/** Total lines added across all uncommitted changes (staged + unstaged + untracked). */
	linesAdded: number;
	/** Total lines removed across all uncommitted changes (staged + unstaged + untracked). */
	linesRemoved: number;
}

const MAX_GIT_FAILURE_OUTPUT_CHARS = 4000;

function stripTrailingLineBreaks(text: string): string {
	return text.replace(/[\r\n]+$/, "");
}

function combinedCommandOutput(result: ExecResult): string {
	return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
}

function truncateGitFailureOutput(output: string): string {
	if (output.length <= MAX_GIT_FAILURE_OUTPUT_CHARS) return output;
	return `${output.slice(0, MAX_GIT_FAILURE_OUTPUT_CHARS)}\n...[truncated]`;
}

function gitFailureMessage(prefix: string, result: ExecResult): string {
	const output = combinedCommandOutput(result);
	if (!output) return `${prefix} (exit code ${result.exitCode})`;
	return `${prefix}: ${truncateGitFailureOutput(output)}`;
}

function commandOutputMentionsConflict(result: ExecResult): boolean {
	const output = combinedCommandOutput(result).toLowerCase();
	return output.includes("conflict") || output.includes("冲突");
}

function normalizeExecOptions(options: boolean | ExecOptions = {}): ExecOptions {
	if (typeof options === "boolean") return { silent: options, optionalLocks: true };
	return {
		silent: options.silent ?? false,
		optionalLocks: options.optionalLocks ?? true,
		timeout: options.timeout,
		maxOutputBytes: options.maxOutputBytes,
		identity: options.identity,
	};
}

/**
 * Marker safeSpawn appends to a truncated stream.
 *
 * Removed here instead of being left in place because git output is *parsed*: a
 * `-z` listing would gain the marker as a bogus path and a NUL-separated
 * merge-tree result would gain it as a bogus conflict. The fact of truncation is
 * carried by `ExecResult.truncated`, which is a signal a parser can act on.
 */
const SPAWN_TRUNCATION_MARKER = "[safeSpawn output truncated — exceeded capture limit]";

function stripTruncationMarker(text: string): string {
	const at = text.lastIndexOf(SPAWN_TRUNCATION_MARKER);
	return at === -1 ? text : text.slice(0, at);
}

async function exec(
	args: string[],
	cwd: string,
	options: boolean | ExecOptions = {},
): Promise<ExecResult> {
	const { silent, optionalLocks, timeout, maxOutputBytes, identity } =
		normalizeExecOptions(options);
	const cmd = optionalLocks ? ["git", ...args] : ["git", "--no-optional-locks", ...args];
	try {
		const result = await safeSpawn({
			cmd,
			cwd,
			timeout,
			maxOutputBytes,
			// `Bun.spawn`'s `env` REPLACES the environment rather than merging into it,
			// so an identity has to be layered over `process.env` explicitly — passing
			// the four `GIT_*` variables alone would strip PATH/HOME and break git.
			// Omitted entirely when there is no identity: that keeps the no-identity
			// path byte-for-byte identical to the behaviour before this existed.
			env: identity ? { ...process.env, ...identity } : undefined,
		});
		const truncated = result.stdoutTruncated === true || result.stderrTruncated === true;
		const trimmedStdout = stripTrailingLineBreaks(
			result.stdoutTruncated ? stripTruncationMarker(result.stdout) : result.stdout,
		);
		const trimmedStderr = stripTrailingLineBreaks(
			result.stderrTruncated ? stripTruncationMarker(result.stderr) : result.stderr,
		);
		if (result.exitCode !== 0 && !silent) {
			logger.error("git command failed", {
				args: args.join(" "),
				cwd,
				stdout: trimmedStdout ? truncateGitFailureOutput(trimmedStdout) : undefined,
				stderr: trimmedStderr ? truncateGitFailureOutput(trimmedStderr) : undefined,
				exitCode: result.exitCode,
				optionalLocks,
				truncated: truncated || undefined,
			});
		}
		if (truncated) {
			logger.warn("git command output truncated", {
				args: args.join(" "),
				cwd,
				limit: maxOutputBytes,
			});
		}
		return {
			stdout: trimmedStdout,
			stderr: trimmedStderr,
			exitCode: result.exitCode,
			truncated,
		};
	} catch (err) {
		// When silent, swallow spawn errors (e.g. git not found) and return a
		// synthetic failure result so callers that check exitCode still work.
		if (silent) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.debug("git command spawn failed (silent)", {
				args: args.join(" "),
				cwd,
				error: msg,
				optionalLocks,
			});
			return { stdout: "", stderr: msg, exitCode: -1 };
		}
		throw err;
	}
}

/**
 * Run a read-only git command.
 *
 * Read operations get a timeout and a capture ceiling by default; writes and network
 * operations deliberately do not, since a slow `clone` or `merge` is normal and
 * killing it half-done leaves the repository in a worse state than waiting does.
 */
function execRead(
	args: string[],
	cwd: string,
	silent = false,
	options?: { timeout?: number; maxOutputBytes?: number },
): Promise<ExecResult> {
	return exec(args, cwd, {
		silent,
		optionalLocks: false,
		timeout: options?.timeout ?? READ_TIMEOUT_MS,
		maxOutputBytes: options?.maxOutputBytes ?? READ_MAX_OUTPUT_BYTES,
	});
}

async function detectUnmergedFiles(worktreePath: string): Promise<string[]> {
	const statusResult = await execRead(
		["diff", "--name-only", "--diff-filter=U"],
		worktreePath,
		true,
	);
	if (statusResult.exitCode !== 0) return [];
	return statusResult.stdout.split("\n").filter(Boolean);
}

/**
 * Whether the repository has no commits at all (unborn HEAD).
 *
 * Distinguishes "brand new repository" from "git is broken or the ref is wrong",
 * which `rev-list` reports identically as exit 128. Checked with
 * `rev-parse --verify` because it exits 1 (not 128) for an unresolvable HEAD and
 * prints nothing, so a genuine spawn failure still surfaces as an error elsewhere.
 */
async function hasNoCommits(repoPath: string): Promise<boolean> {
	const result = await execRead(["rev-parse", "--verify", "--quiet", "HEAD"], repoPath, true);
	return result.exitCode === 1 && !result.stdout.trim();
}

/**
 * Whether `ref` names a branch/commit that simply is not in this repository.
 *
 * The companion to {@link hasNoCommits}, which only ever recognises an unborn HEAD: a
 * repository that *has* commits but not under the name being asked about is a different
 * situation, and `rev-list` reports both as exit 128. `rev-parse --verify --quiet` exits
 * 1 with no output for an unresolvable ref and 128 only when git itself could not answer,
 * so a probe of the ref separates "your ref is wrong" from "git is broken".
 *
 * A range (`<a>..<b>`) is deliberately never treated as a missing ref. Ranges reach
 * {@link gitService.getCommitCount} from cursor pagination, where an endpoint that no
 * longer resolves is a stale cursor the caller has to be *told* about — it falls back to
 * skip-based loading — whereas answering 0 would page the timeline from the wrong end.
 */
async function refIsMissing(repoPath: string, ref: string): Promise<boolean> {
	if (ref.includes("..")) return false;
	const result = await execRead(
		["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
		repoPath,
		true,
	);
	return result.exitCode === 1 && !result.stdout.trim();
}

async function detectConflictFilesAfterFailedGitCommand(
	worktreePath: string,
	result: ExecResult,
): Promise<string[] | null> {
	const conflictFiles = await detectUnmergedFiles(worktreePath);
	if (conflictFiles.length > 0) return conflictFiles;
	return commandOutputMentionsConflict(result) ? [] : null;
}

interface LineStats {
	added: number;
	removed: number;
}

function parseNulSeparatedPaths(output: string): string[] {
	return output.split("\0").filter(Boolean);
}

function countTextLines(content: string): number {
	if (!content) return 0;
	const lineCount = content.split("\n").length;
	return content.endsWith("\n") ? lineCount - 1 : lineCount;
}

/** Max file size (bytes) to read for untracked line counting. Skip larger / binary files. */
const MAX_UNTRACKED_FILE_SIZE = 1_000_000; // 1 MB
/** Max number of untracked files to count lines for. */
const MAX_UNTRACKED_LINE_COUNT_FILES = 200;
/**
 * Number of bytes to sample for binary detection.
 * Matches VSCode's approach: read first 4100 bytes, scan for null byte.
 * See: vscode/extensions/git/src/git.ts — detectObjectType()
 */
const BINARY_DETECT_BYTES = 4100;

/**
 * Detect whether a file is binary by reading its first bytes and scanning
 * for null (0x00) bytes — the same heuristic used by VSCode and git itself.
 * Returns true if the file appears to be binary.
 */
async function isBinaryFile(filePath: string, size: number): Promise<boolean> {
	const bytesToRead = Math.min(size, BINARY_DETECT_BYTES);
	try {
		const file = Bun.file(filePath);
		const slice = file.slice(0, bytesToRead);
		const ab = await slice.arrayBuffer();
		const view = new Uint8Array(ab);
		for (let i = 0; i < view.length; i++) {
			if (view[i] === 0) return true;
		}
		return false;
	} catch {
		return true; // If we can't read it, treat as binary
	}
}

async function getUntrackedLineStatsMap(
	worktreePath: string,
	files: string[],
): Promise<Map<string, LineStats>> {
	// Cap the number of files to avoid reading thousands of files into memory
	const capped = files.slice(0, MAX_UNTRACKED_LINE_COUNT_FILES);
	const entries = await Promise.all(
		capped.map(async (file) => {
			try {
				const filePath = join(worktreePath, file);
				const bunFile = Bun.file(filePath);
				const size = bunFile.size;
				// Skip files that are too large (likely binary or generated)
				if (size > MAX_UNTRACKED_FILE_SIZE) {
					return [file, { added: 0, removed: 0 }] as const;
				}
				// Binary detection: sample first bytes for null byte (VSCode approach)
				if (size > 0 && (await isBinaryFile(filePath, size))) {
					return [file, { added: 0, removed: 0 }] as const;
				}
				const content = await bunFile.text();
				return [file, { added: countTextLines(content), removed: 0 }] as const;
			} catch {
				return [file, { added: 0, removed: 0 }] as const;
			}
		}),
	);
	return new Map(entries);
}

function parseNumstatZ(
	output: string,
): Array<{ path: string; oldPath?: string; added: number; removed: number }> {
	const entries: Array<{ path: string; oldPath?: string; added: number; removed: number }> = [];
	let offset = 0;

	while (offset < output.length) {
		const recordEnd = output.indexOf("\0", offset);
		if (recordEnd === -1) break;
		const record = output.slice(offset, recordEnd);
		offset = recordEnd + 1;
		if (!record) continue;

		const firstTab = record.indexOf("\t");
		const secondTab = record.indexOf("\t", firstTab + 1);
		if (firstTab === -1 || secondTab === -1) continue;

		const addedStr = record.slice(0, firstTab);
		const removedStr = record.slice(firstTab + 1, secondTab);
		const pathField = record.slice(secondTab + 1);
		const added = addedStr === "-" ? 0 : Number.parseInt(addedStr, 10) || 0;
		const removed = removedStr === "-" ? 0 : Number.parseInt(removedStr, 10) || 0;

		if (pathField) {
			entries.push({ path: pathField, added, removed });
			continue;
		}

		const oldPathEnd = output.indexOf("\0", offset);
		if (oldPathEnd === -1) break;
		const oldPath = output.slice(offset, oldPathEnd);
		offset = oldPathEnd + 1;

		const newPathEnd = output.indexOf("\0", offset);
		if (newPathEnd === -1) break;
		const newPath = output.slice(offset, newPathEnd);
		offset = newPathEnd + 1;

		entries.push({ path: newPath, oldPath, added, removed });
	}

	return entries;
}

/**
 * Parse `--name-status -z` into a path -> raw status letter map.
 *
 * The record layout differs by status, which is why this cannot be a simple pairwise
 * split: `M\0path\0`, but `R085\0old\0new\0`. Rename/copy entries are keyed under the
 * new path, matching how numstat reports them.
 */
function parseNameStatusZ(output: string): Map<string, string> {
	const fields = output.split("\0");
	const statuses = new Map<string, string>();
	let i = 0;
	while (i < fields.length) {
		const status = fields[i++];
		if (!status) continue;
		const takesTwoPaths = status.startsWith("R") || status.startsWith("C");
		if (takesTwoPaths) {
			const newPath = fields[i + 1];
			i += 2;
			if (newPath) statuses.set(newPath, status);
			continue;
		}
		const path = fields[i++];
		if (path) statuses.set(path, status);
	}
	return statuses;
}

function buildLineStatsMap(output: string): Map<string, LineStats> {
	return new Map(
		parseNumstatZ(output).map(({ path, added, removed }) => [path, { added, removed }]),
	);
}

function parsePorcelainStatusZ(
	output: string,
): Array<{ status: string; path: string; oldPath?: string }> {
	const entries: Array<{ status: string; path: string; oldPath?: string }> = [];
	let offset = 0;

	while (offset < output.length) {
		const entryEnd = output.indexOf("\0", offset);
		if (entryEnd === -1) break;
		const entry = output.slice(offset, entryEnd);
		offset = entryEnd + 1;
		if (!entry) continue;

		const status = entry.slice(0, 2);
		const path = entry.slice(3);
		let oldPath: string | undefined;
		if (status.includes("R") || status.includes("C")) {
			const oldPathEnd = output.indexOf("\0", offset);
			if (oldPathEnd === -1) break;
			oldPath = output.slice(offset, oldPathEnd);
			offset = oldPathEnd + 1;
		}

		entries.push({ status, path, oldPath });
	}

	return entries;
}

/**
 * `git status --porcelain` arguments that list untracked files INDIVIDUALLY.
 *
 * ── The bug this closes ──────────────────────────────────────────────────────
 * By default git COLLAPSES an untracked directory into a single entry with a
 * trailing slash: a brand-new `src/feature/` holding three files is reported as
 * one line, `?? src/feature/`. That is a display convenience for the terminal,
 * and it is actively wrong for every consumer we have:
 *   - the panel's file tree splits on "/" and drops the trailing empty segment,
 *     so `src/feature/` became a FILE row named `feature` wearing an `A` badge,
 *     and the files inside it were nowhere at all;
 *   - `copyDirtyFiles` called `Bun.file()` on that path, which cannot read a
 *     directory, so a review worktree silently lost the whole new folder.
 * Both are the same root cause: a directory entry pretending to be a file.
 *
 * `-uall` makes git do the expansion itself, which is the only place it can be
 * done correctly — walking the directory in our own code would re-implement
 * gitignore semantics, and getting those subtly wrong is how ignored build
 * output ends up in a reviewer's diff.
 *
 * COST: on a repo with a huge untracked directory (a stray `node_modules`,
 * a build output folder that is not ignored) this enumerates every file instead
 * of one line. That is bounded where it matters — `files` is capped at
 * `MAX_FILES`, and the untracked line-count scan has its own cap — and it is the
 * honest number: those files ARE uncommitted, and the old single line simply hid
 * how many.
 */
const PORCELAIN_UNTRACKED_ALL = ["status", "--porcelain", "-uall"];

export const gitService = {
	async getCurrentBranch(repoPath: string): Promise<string> {
		const result = await execRead(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
		return result.stdout;
	},

	async branchExists(repoPath: string, branchName: string): Promise<boolean> {
		const result = await execRead(["rev-parse", "--verify", branchName], repoPath);
		return result.exitCode === 0;
	},

	async createBranch(repoPath: string, branchName: string, baseBranch: string): Promise<void> {
		const result = await exec(["branch", branchName, baseBranch], repoPath);
		if (result.exitCode !== 0) throw new GitError(`Failed to create branch: ${result.stderr}`);
	},

	async createWorktree(repoPath: string, worktreePath: string, branchName: string): Promise<void> {
		const result = await exec(["worktree", "add", worktreePath, branchName], repoPath);
		if (result.exitCode !== 0) {
			// Detect shallow clone as a likely cause of "unable to read tree" errors
			if (result.stderr.includes("unable to read tree")) {
				const shallow = await gitService.isShallowRepository(repoPath);
				if (shallow) {
					throw new Error(
						`Failed to create worktree: ${result.stderr}\n\n` +
							`This repository appears to be a shallow clone and is missing the required git objects. ` +
							`Run \`git fetch --unshallow\` in the repository to fetch the full history, then try again.`,
					);
				}
			}
			throw new Error(`Failed to create worktree: ${result.stderr}`);
		}
	},

	async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
		const result = await exec(["worktree", "remove", worktreePath, "--force"], repoPath);
		if (result.exitCode !== 0) throw new GitError(`Failed to remove worktree: ${result.stderr}`);
	},

	async pruneWorktrees(repoPath: string): Promise<void> {
		await exec(["worktree", "prune"], repoPath);
	},

	async deleteBranch(repoPath: string, branchName: string): Promise<void> {
		await exec(["branch", "-D", branchName], repoPath);
	},

	async isShallowRepository(repoPath: string): Promise<boolean> {
		const result = await execRead(["rev-parse", "--is-shallow-repository"], repoPath, true);
		return result.exitCode === 0 && result.stdout.trim() === "true";
	},

	async isGitRepo(path: string): Promise<boolean> {
		const result = await execRead(["rev-parse", "--is-inside-work-tree"], path);
		return result.exitCode === 0;
	},

	/**
	 * Get the content of a file at HEAD (last committed version).
	 * Returns null if the file is not tracked or HEAD doesn't exist.
	 */
	async getFileAtHead(cwd: string, filePath: string): Promise<string | null> {
		const result = await execRead(["show", `HEAD:${filePath}`], cwd, true);
		if (result.exitCode !== 0) return null;
		return result.stdout;
	},

	async getHeadCommit(repoPath: string): Promise<string> {
		const result = await execRead(["rev-parse", "HEAD"], repoPath);
		if (result.exitCode !== 0) throw new GitError(`Failed to get HEAD commit: ${result.stderr}`);
		return result.stdout;
	},

	async getRefCommit(repoPath: string, ref: string): Promise<string> {
		const result = await execRead(["rev-parse", ref], repoPath);
		if (result.exitCode !== 0)
			throw new GitError(`Failed to get commit for ${ref}: ${result.stderr}`);
		return result.stdout;
	},

	async getCommitsAhead(
		worktreePath: string,
		baseBranch: string,
	): Promise<{ count: number; baseBranch: string }> {
		const result = await execRead(
			["rev-list", "--count", `${baseBranch}..HEAD`],
			worktreePath,
			true,
		);
		return {
			count: result.exitCode === 0 ? Number.parseInt(result.stdout, 10) || 0 : 0,
			baseBranch,
		};
	},

	async getUncommittedLineStats(worktreePath: string): Promise<{ added: number; removed: number }> {
		// staged + unstaged diff against HEAD
		const tracked = await execRead(["diff", "HEAD", "--numstat", "-z"], worktreePath, true);
		// untracked files
		const untracked = await execRead(
			["ls-files", "--others", "--exclude-standard", "-z"],
			worktreePath,
			true,
		);

		let added = 0;
		let removed = 0;

		if (tracked.exitCode === 0 && tracked.stdout) {
			for (const entry of parseNumstatZ(tracked.stdout)) {
				added += entry.added;
				removed += entry.removed;
			}
		}

		if (untracked.exitCode === 0 && untracked.stdout) {
			const untrackedStats = await getUntrackedLineStatsMap(
				worktreePath,
				parseNulSeparatedPaths(untracked.stdout),
			);
			for (const stats of untrackedStats.values()) {
				added += stats.added;
				removed += stats.removed;
			}
		}

		return { added, removed };
	},

	/**
	 * `silent` is for callers that ASK about revisions which may legitimately not relate.
	 * Unrelated histories and a pruned sha both exit non-zero here, and for the Ruler's
	 * anchor fallback that is an expected answer ("no position for this chapter"), not a
	 * fault — logging it at error level put routine lines in the log that read as a broken
	 * repository. The throw is unchanged either way, so merge paths keep their diagnostics.
	 */
	async getMergeBase(
		repoPath: string,
		branchA: string,
		branchB: string,
		opts: { silent?: boolean } = {},
	): Promise<string> {
		const result = await execRead(["merge-base", branchA, branchB], repoPath, opts.silent ?? false);
		if (result.exitCode !== 0) throw new GitError(`Failed to get merge base: ${result.stderr}`);
		return result.stdout;
	},

	/** Check if commitA is an ancestor of commitB (i.e. commitB contains commitA) */
	async isAncestor(repoPath: string, commitA: string, commitB: string): Promise<boolean> {
		const result = await execRead(
			["merge-base", "--is-ancestor", commitA, commitB],
			repoPath,
			true,
		);
		return result.exitCode === 0;
	},

	/**
	 * Simulate a merge to detect conflicts without touching any worktree.
	 *
	 * Uses `merge-tree --write-tree` (git >= 2.38), whose contract is machine-readable:
	 * exit 0 means clean, exit 1 means conflicted, and with `--name-only -z` stdout is
	 * the result tree followed by the conflicting paths. The older three-argument form
	 * cannot be used for this: it exits 0 either way and describes conflicts by
	 * inlining `<<<<<<< .our` markers into a diff, so parsing it for `+++ b/` or
	 * `CONFLICT` lines — patterns that only the new form emits — reported "no
	 * conflicts" unconditionally and let the UI promise a clean merge that then failed.
	 *
	 * Throws on old git rather than falling back to the legacy form. A merge preview
	 * that cannot see conflicts is worse than no preview: the caller can surface "not
	 * checkable", but it cannot recover from being told a lie.
	 */
	async mergeTree(
		repoPath: string,
		baseSha: string,
		ourBranch: string,
		theirBranch: string,
	): Promise<{ hasConflicts: boolean; conflictFiles: string[] }> {
		if (!(await supportsMergeTree())) {
			throw new GitError(
				"Cannot check for merge conflicts: git merge-tree --write-tree is unavailable (requires git >= 2.38)",
			);
		}
		const result = await execRead(
			[
				"merge-tree",
				"--write-tree",
				"--name-only",
				"--no-messages",
				"-z",
				`--merge-base=${baseSha}`,
				ourBranch,
				theirBranch,
			],
			repoPath,
			// exit 1 is the documented "conflicts found" status, so it must not be logged
			// as a command failure.
			true,
		);
		if (result.exitCode !== 0 && result.exitCode !== 1) {
			throw new GitError(gitFailureMessage("Merge conflict check failed", result));
		}
		if (result.truncated) {
			// A cut-off list would understate the conflicts, which is the exact failure
			// this rewrite exists to remove.
			throw new GitError("Merge conflict check produced more output than can be read");
		}
		const parts = result.stdout.split("\0").filter(Boolean);
		// parts[0] is the merged tree — written to the object store even when
		// conflicted, and irrelevant here since nothing gets checked out.
		const [tree, ...conflictFiles] = parts;
		if (!tree) throw new GitError("Merge conflict check returned no tree");
		// Trust the exit code over the path list: `--name-only` omits paths for some
		// conflict kinds, so exit 1 with no names still means "do not promise clean".
		return { hasConflicts: result.exitCode === 1, conflictFiles };
	},

	/** Perform actual merge in a worktree */
	async merge(
		worktreePath: string,
		sourceBranch: string,
		strategy: "merge" | "squash",
		message: string,
		options?: { fastForward?: boolean; identity?: GitCommitIdentity },
	): Promise<{
		success: boolean;
		commitSha?: string;
		conflictFiles?: string[];
		isFastForward?: boolean;
	}> {
		const identity = options?.identity ?? null;
		let args: string[];
		if (strategy === "squash") {
			args = ["merge", "--squash", sourceBranch];
		} else if (options?.fastForward) {
			args = ["merge", "--ff-only", sourceBranch];
		} else {
			args = ["merge", "--no-ff", "-m", message, sourceBranch];
		}

		const result = await exec(args, worktreePath, { identity });
		if (result.exitCode !== 0) {
			if (options?.fastForward) {
				// ff-only failed — fall back to --no-ff
				const fallbackArgs = ["merge", "--no-ff", "-m", message, sourceBranch];
				const fallbackResult = await exec(fallbackArgs, worktreePath, { identity });
				if (fallbackResult.exitCode !== 0) {
					const conflictFiles = await detectConflictFilesAfterFailedGitCommand(
						worktreePath,
						fallbackResult,
					);
					if (conflictFiles) return { success: false, conflictFiles };
					throw new GitError(gitFailureMessage("Merge failed", fallbackResult));
				}
				if (strategy === "squash") {
					const commitResult = await exec(["commit", "-m", message], worktreePath, { identity });
					if (commitResult.exitCode !== 0)
						throw new GitError(gitFailureMessage("Squash commit failed", commitResult));
				}
				const sha = await this.getHeadCommit(worktreePath);
				return { success: true, commitSha: sha, isFastForward: false };
			}
			const conflictFiles = await detectConflictFilesAfterFailedGitCommand(worktreePath, result);
			if (conflictFiles) return { success: false, conflictFiles };
			throw new GitError(gitFailureMessage("Merge failed", result));
		}

		if (strategy === "squash") {
			const commitResult = await exec(["commit", "-m", message], worktreePath, { identity });
			if (commitResult.exitCode !== 0)
				throw new GitError(gitFailureMessage("Squash commit failed", commitResult));
		}

		const sha = await this.getHeadCommit(worktreePath);
		return { success: true, commitSha: sha, isFastForward: !!options?.fastForward };
	},

	/**
	 * Cherry-pick commits from source branch onto current branch.
	 *
	 * `identity` sets the COMMITTER only in practice: git preserves each picked
	 * commit's original author, which is the correct semantics — the acting user
	 * transplanted the change, they did not write it.
	 */
	async cherryPick(
		worktreePath: string,
		repoPath: string,
		sourceBranch: string,
		baseSha: string,
		identity?: GitCommitIdentity,
	): Promise<{ success: boolean; commitSha?: string; conflictFiles?: string[] }> {
		const logResult = await execRead(
			["rev-list", "--reverse", `${baseSha}..${sourceBranch}`],
			repoPath,
		);
		if (logResult.exitCode !== 0) throw new GitError(`Failed to list commits: ${logResult.stderr}`);

		const commits = logResult.stdout.split("\n").filter(Boolean);
		if (commits.length === 0) return { success: true };

		for (const commit of commits) {
			const result = await exec(["cherry-pick", commit], worktreePath, {
				identity: identity ?? null,
			});
			if (result.exitCode !== 0) {
				const conflictFiles = await detectConflictFilesAfterFailedGitCommand(worktreePath, result);
				if (conflictFiles) {
					await exec(["cherry-pick", "--abort"], worktreePath);
					return { success: false, conflictFiles };
				}
				throw new GitError(gitFailureMessage("Cherry-pick failed", result));
			}
		}

		const sha = await this.getHeadCommit(worktreePath);
		return { success: true, commitSha: sha };
	},

	async mergeAbort(worktreePath: string): Promise<void> {
		await exec(["merge", "--abort"], worktreePath);
	},

	/** Rebase current branch onto another branch. On conflict the worktree is left
	 *  in the middle of a rebase so the caller can decide to abort or resolve.
	 *
	 *  `identity` becomes the committer of every rewritten commit; git preserves the
	 *  original authors, same as cherry-pick. */
	async rebase(
		worktreePath: string,
		ontoBranch: string,
		identity?: GitCommitIdentity,
	): Promise<{
		success: boolean;
		commitSha?: string;
		conflictFiles?: Array<{ file: string; conflictLines: number }>;
	}> {
		const result = await exec(["rebase", ontoBranch], worktreePath, {
			identity: identity ?? null,
		});
		if (result.exitCode !== 0) {
			const conflictFiles = await detectConflictFilesAfterFailedGitCommand(worktreePath, result);
			if (conflictFiles) {
				return {
					success: false,
					conflictFiles: await this.getConflictFilesWithLines(worktreePath),
				};
			}
			throw new GitError(gitFailureMessage("Rebase failed", result));
		}
		const sha = await this.getHeadCommit(worktreePath);
		return { success: true, commitSha: sha };
	},

	async rebaseAbort(worktreePath: string): Promise<void> {
		await exec(["rebase", "--abort"], worktreePath);
	},

	async rebaseContinue(
		worktreePath: string,
		identity?: GitCommitIdentity,
	): Promise<{
		success: boolean;
		commitSha?: string;
		conflictFiles?: Array<{ file: string; conflictLines: number }>;
	}> {
		// Stage all resolved files then continue
		await exec(["add", "-A"], worktreePath);
		const result = await exec(["-c", "core.editor=true", "rebase", "--continue"], worktreePath, {
			identity: identity ?? null,
		});
		if (result.exitCode !== 0) {
			const conflictFiles = await detectConflictFilesAfterFailedGitCommand(worktreePath, result);
			if (conflictFiles) {
				return {
					success: false,
					conflictFiles: await this.getConflictFilesWithLines(worktreePath),
				};
			}
			throw new GitError(gitFailureMessage("Rebase continue failed", result));
		}
		const sha = await this.getHeadCommit(worktreePath);
		return { success: true, commitSha: sha };
	},

	/** Get conflict files with the number of conflict markers in each file */
	async getConflictFilesWithLines(
		worktreePath: string,
	): Promise<Array<{ file: string; conflictLines: number }>> {
		const files = await this.getConflictFiles(worktreePath);
		const result: Array<{ file: string; conflictLines: number }> = [];
		for (const file of files) {
			try {
				const grepResult = await safeSpawn({
					cmd: ["grep", "-c", "^<<<<<<<", file],
					cwd: worktreePath,
				});
				const count = Number.parseInt(grepResult.stdout.trim(), 10) || 0;
				result.push({ file, conflictLines: count });
			} catch {
				result.push({ file, conflictLines: 0 });
			}
		}
		return result;
	},

	/** Perform merge without committing — leaves conflicts in worktree for resolution */
	async mergeNoCommit(
		worktreePath: string,
		sourceBranch: string,
		strategy: "merge" | "squash",
	): Promise<{ hasConflicts: boolean; conflictFiles: string[] }> {
		const args =
			strategy === "squash"
				? ["merge", "--squash", "--no-commit", sourceBranch]
				: ["merge", "--no-ff", "--no-commit", sourceBranch];

		const result = await exec(args, worktreePath);
		if (result.exitCode !== 0) {
			const conflictFiles = await detectConflictFilesAfterFailedGitCommand(worktreePath, result);
			if (conflictFiles) return { hasConflicts: true, conflictFiles };
			throw new GitError(gitFailureMessage("Merge failed", result));
		}
		return { hasConflicts: false, conflictFiles: [] };
	},

	/** Get list of files with unresolved merge conflicts */
	async getConflictFiles(worktreePath: string): Promise<string[]> {
		return detectUnmergedFiles(worktreePath);
	},

	async getStatus(worktreePath: string): Promise<string> {
		// `-uall`: untracked directories are expanded to their files. A consumer
		// that receives `?? newdir/` cannot tell a directory from a file, and every
		// one of ours treats it as a file. See PORCELAIN_UNTRACKED_ALL.
		const result = await execRead(PORCELAIN_UNTRACKED_ALL, worktreePath);
		return result.stdout;
	},

	/**
	 * Stage everything and commit, for unattended saves (e.g. putting a chapter to sleep).
	 *
	 * Refuses to run mid-conflict. `git add -A` treats an unmerged path as *resolved*,
	 * so a worktree parked on `UU` would have its `<<<<<<<` markers committed as if
	 * they were the author's code — a commit nobody wrote, indistinguishable from real
	 * work afterwards. Skipping silently is not an option either: the caller would
	 * record a successful save. Throwing is safe because callers already treat an
	 * autoCommit failure as "fall back to a snapshot", and it gives them a reason to
	 * show the user.
	 */
	async autoCommit(
		worktreePath: string,
		message: string,
		identity?: GitCommitIdentity,
	): Promise<string | null> {
		return withWorktreeLock(worktreePath, () =>
			this.autoCommitUnlocked(worktreePath, message, identity),
		);
	},

	/** {@link autoCommit} for callers already holding the worktree lock. */
	async autoCommitUnlocked(
		worktreePath: string,
		message: string,
		identity?: GitCommitIdentity,
	): Promise<string | null> {
		const status = await this.getStatus(worktreePath);
		if (!status) return null;

		const unmerged = await detectUnmergedFiles(worktreePath);
		if (unmerged.length > 0) {
			const shown = unmerged.slice(0, 5).join(", ");
			const rest = unmerged.length > 5 ? `, +${unmerged.length - 5} more` : "";
			throw new GitError(
				`Refusing to auto-commit: ${unmerged.length} file(s) still have unresolved merge conflicts (${shown}${rest})`,
			);
		}

		const addResult = await exec(["add", "-A"], worktreePath);
		if (addResult.exitCode !== 0) throw new GitError(`git add failed: ${addResult.stderr}`);

		const commitResult = await exec(["commit", "-m", message], worktreePath, {
			identity: identity ?? null,
		});
		if (commitResult.exitCode !== 0)
			throw new GitError(`git commit failed: ${commitResult.stderr}`);

		return this.getHeadCommit(worktreePath);
	},

	async getStatusSummary(worktreePath: string): Promise<GitStatusSummary> {
		const [
			statusResult,
			headResult,
			branchResult,
			stagedNumstat,
			unstagedNumstat,
			untrackedResult,
		] = await Promise.all([
			execRead([...PORCELAIN_UNTRACKED_ALL, "-z"], worktreePath),
			execRead(["rev-parse", "HEAD"], worktreePath),
			execRead(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath),
			execRead(["diff", "--cached", "--numstat", "-z"], worktreePath, true),
			execRead(["diff", "--numstat", "-z"], worktreePath, true),
			execRead(["ls-files", "--others", "--exclude-standard", "-z"], worktreePath, true),
		]);

		const stagedLineStats =
			stagedNumstat.exitCode === 0
				? buildLineStatsMap(stagedNumstat.stdout)
				: new Map<string, LineStats>();
		const unstagedLineStats =
			unstagedNumstat.exitCode === 0
				? buildLineStatsMap(unstagedNumstat.stdout)
				: new Map<string, LineStats>();
		const untrackedPaths =
			untrackedResult.exitCode === 0 ? parseNulSeparatedPaths(untrackedResult.stdout) : [];
		const untrackedLineStats = await getUntrackedLineStatsMap(worktreePath, untrackedPaths);

		for (const [path, stats] of untrackedLineStats) {
			unstagedLineStats.set(path, stats);
		}

		const entries = parsePorcelainStatusZ(statusResult.stdout);
		let staged = 0;
		let unstaged = 0;
		let untracked = 0;
		const MAX_FILES = 200;
		const files: GitStatusFile[] = [];

		for (const entry of entries) {
			const x = entry.status[0]; // index status
			const y = entry.status[1]; // worktree status
			if (files.length < MAX_FILES) {
				const stagedStats = stagedLineStats.get(entry.path) ?? { added: 0, removed: 0 };
				const unstagedStats = unstagedLineStats.get(entry.path) ?? { added: 0, removed: 0 };
				files.push({
					status: entry.status,
					path: entry.path,
					// Only `R`/`C` entries carry one; `parsePorcelainStatusZ` leaves it
					// undefined otherwise, and the field is omitted rather than sent as
					// null so a JSON consumer sees the same shape it always did.
					...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
					linesAdded: stagedStats.added + unstagedStats.added,
					linesRemoved: stagedStats.removed + unstagedStats.removed,
					stagedLinesAdded: stagedStats.added,
					stagedLinesRemoved: stagedStats.removed,
					unstagedLinesAdded: unstagedStats.added,
					unstagedLinesRemoved: unstagedStats.removed,
				});
			}

			if (y === "?") {
				untracked++;
			} else {
				if (x !== " " && x !== "?") staged++;
				if (y !== " " && y !== "?") unstaged++;
			}
		}

		// Aggregate total line stats from the per-file maps we already computed
		let totalLinesAdded = 0;
		let totalLinesRemoved = 0;
		for (const stats of stagedLineStats.values()) {
			totalLinesAdded += stats.added;
			totalLinesRemoved += stats.removed;
		}
		for (const stats of unstagedLineStats.values()) {
			totalLinesAdded += stats.added;
			totalLinesRemoved += stats.removed;
		}

		return {
			hasChanges: entries.length > 0,
			staged,
			unstaged,
			untracked,
			files,
			totalFiles: entries.length,
			headSha: headResult.stdout,
			branch: branchResult.stdout,
			linesAdded: totalLinesAdded,
			linesRemoved: totalLinesRemoved,
		};
	},

	/** Get full diff of all uncommitted changes (staged + unstaged + untracked).
	 *  Truncates at ~100KB to avoid blowing up AI token budgets.
	 *  Binary file *content* never appears — see the note on binary handling below. */
	async getFullDiff(worktreePath: string, maxBytes = 100_000): Promise<string> {
		// Diff of tracked files (staged + unstaged combined against HEAD).
		//
		// Binary content is kept out by doing nothing: git's default is a single
		// "Binary files a/x and b/x differ" line, and only an explicit `--binary`
		// (or `--text`) makes it emit content. There is no `--no-binary` — passing
		// one makes git print usage and exit 129, which silently emptied every diff
		// this method produced, including the one the review agent reads.
		// -D/--irreversible-delete: omit full content of deleted files.
		const diffResult = await execRead(["diff", "HEAD", "-D", "--no-color"], worktreePath, true);
		const parts: string[] = [];
		let totalLen = 0;

		const addPart = (text: string): boolean => {
			if (totalLen + text.length > maxBytes) {
				const remaining = maxBytes - totalLen;
				if (remaining > 0) parts.push(text.slice(0, remaining));
				parts.push("\n\n[diff truncated — exceeded size limit]");
				return false;
			}
			parts.push(text);
			totalLen += text.length;
			return true;
		};

		if (diffResult.stdout && !addPart(diffResult.stdout)) {
			return parts.join("\n");
		}

		// List untracked files and show their content (skip binary files)
		const untrackedResult = await execRead(
			["ls-files", "--others", "--exclude-standard"],
			worktreePath,
			true,
		);
		const untrackedFiles = untrackedResult.stdout.split("\n").filter(Boolean);
		// Cap the number of untracked files we diff to avoid spawning too many processes
		const MAX_UNTRACKED_DIFFS = 50;
		const filesToDiff = untrackedFiles.slice(0, MAX_UNTRACKED_DIFFS);
		for (const file of filesToDiff) {
			// --no-index always exits 1 when diff is found — silence the expected error log.
			// Binary files again produce only a "Binary files ... differ" line by default.
			const showResult = await execRead(
				["diff", "--no-index", "--no-color", DEV_NULL, file],
				worktreePath,
				true,
			);
			if (showResult.stdout && !addPart(showResult.stdout)) break;
		}
		if (untrackedFiles.length > MAX_UNTRACKED_DIFFS) {
			addPart(
				`\n\n[... ${untrackedFiles.length - MAX_UNTRACKED_DIFFS} more untracked files omitted]`,
			);
		}

		return parts.join("\n");
	},

	/**
	 * Get diff between two refs (commits, branches, tags).
	 * Useful for review: shows all changes between a base and head.
	 * Truncates at maxBytes to avoid blowing up token budgets.
	 * Binary content is left out by git's default one-line summary, not by a flag.
	 */
	async getDiffBetweenRefs(
		repoPath: string,
		baseRef: string,
		headRef: string,
		maxBytes = 100_000,
	): Promise<string> {
		const result = await execRead(["diff", "--no-color", `${baseRef}..${headRef}`], repoPath, true);
		if (!result.stdout) return "";
		if (result.stdout.length > maxBytes) {
			return `${result.stdout.slice(0, maxBytes)}\n\n[diff truncated — exceeded size limit]`;
		}
		return result.stdout;
	},

	/**
	 * Get the file list for a specific commit (stats only, no diff content).
	 * Fast even for huge commits — only runs numstat + name-status.
	 *
	 * Both passes must agree on rename detection and quoting, so both get `-M -z`.
	 * Previously only name-status had `-M`, which made the two views disagree about
	 * what a rename even is: numstat split it into an add of the new path plus a
	 * delete of the old one, and since name-status keyed the rename under the new
	 * path only, the old path fell through to the default "modified" branch and the
	 * UI listed a phantom file that does not exist in the commit. `-z` additionally
	 * stops git from octal-escaping non-ASCII paths, which otherwise never matched
	 * between the two maps for CJK filenames.
	 */
	async getCommitFiles(
		repoPath: string,
		sha: string,
	): Promise<
		Array<{
			path: string;
			oldPath?: string;
			status: "added" | "modified" | "deleted" | "renamed";
			linesAdded: number;
			linesRemoved: number;
		}>
	> {
		const [numstat, nameStatus] = await Promise.all([
			execRead(["diff-tree", "--no-commit-id", "-r", "--numstat", "-M", "-z", sha], repoPath),
			execRead(["diff-tree", "--no-commit-id", "-r", "--name-status", "-M", "-z", sha], repoPath),
		]);

		const statusMap = parseNameStatusZ(nameStatus.stdout);
		return parseNumstatZ(numstat.stdout).map((entry) => {
			const rawStatus = statusMap.get(entry.path);
			// Fall back on the numstat record itself: it reports a rename as a pair of
			// paths, which is enough to classify without name-status agreeing.
			const status: "added" | "modified" | "deleted" | "renamed" =
				rawStatus === "A"
					? "added"
					: rawStatus === "D"
						? "deleted"
						: rawStatus?.startsWith("R") || entry.oldPath
							? "renamed"
							: "modified";

			return {
				path: entry.path,
				oldPath: entry.oldPath,
				status,
				linesAdded: entry.added,
				linesRemoved: entry.removed,
			};
		});
	},

	/**
	 * Get the diff for a single file in a specific commit.
	 * Returns the raw unified diff string, truncated if too large.
	 */
	async getCommitFileDiff(
		repoPath: string,
		sha: string,
		filePath: string,
		maxBytes = 200_000,
	): Promise<{ diff: string; truncated: boolean }> {
		const result = await execRead(
			["diff-tree", "--no-commit-id", "-p", sha, "--", filePath],
			repoPath,
			true,
		);
		let diff = result.stdout;
		let truncated = false;
		if (diff.length > maxBytes) {
			diff = diff.slice(0, maxBytes);
			truncated = true;
		}
		return { diff, truncated };
	},

	async copyFiles(srcDir: string, destDir: string, files: string[]): Promise<void> {
		for (const file of files) {
			const srcPath = join(srcDir, file);
			const destPath = join(destDir, file);
			try {
				mkdirSync(dirname(destPath), { recursive: true });
				cpSync(srcPath, destPath, { recursive: true });
			} catch (err) {
				logger.warn("Failed to copy file", { file, error: String(err) });
			}
		}
	},

	async initRepo(repoPath: string, identity?: GitCommitIdentity): Promise<void> {
		mkdirSync(repoPath, { recursive: true });
		const result = await exec(["init"], repoPath);
		if (result.exitCode !== 0) throw new GitError(`Failed to init repo: ${result.stderr}`);
		// Create initial empty commit so branches can be created
		const commitResult = await exec(["commit", "--allow-empty", "-m", "Initial commit"], repoPath, {
			identity: identity ?? null,
		});
		if (commitResult.exitCode !== 0) {
			throw new GitError(`Failed to create initial commit: ${commitResult.stderr}`);
		}
	},

	async stageAndCommit(
		repoPath: string,
		files: string[],
		message: string,
		identity?: GitCommitIdentity,
	): Promise<void> {
		const addResult = await exec(["add", ...files], repoPath);
		if (addResult.exitCode !== 0) {
			throw new GitError(`Failed to stage files: ${addResult.stderr}`);
		}
		const commitResult = await exec(["commit", "-m", message], repoPath, {
			identity: identity ?? null,
		});
		if (commitResult.exitCode !== 0) {
			throw new GitError(`Failed to commit: ${commitResult.stderr}`);
		}
	},

	async commitGitignoreIfDirty(repoPath: string, identity?: GitCommitIdentity): Promise<void> {
		const statusResult = await execRead(["status", "--porcelain", ".gitignore"], repoPath);
		if (statusResult.stdout.trim()) {
			await this.stageAndCommit(
				repoPath,
				[".gitignore"],
				"Update .gitignore for NarraFork",
				identity,
			);
		}
	},

	async cloneRepo(url: string, destPath: string, branch?: string): Promise<void> {
		const args = ["clone"];
		if (branch) args.push("--branch", branch);
		args.push(url, destPath);
		const result = await exec(args, ".");
		if (result.exitCode !== 0) throw new GitError(`Failed to clone repo: ${result.stderr}`);
	},

	/**
	 * Clone a repo with `--progress`, streaming stderr lines to a callback.
	 * Git writes progress (counting objects, compressing, receiving, resolving)
	 * to stderr using `\r` for in-place updates.
	 */
	async cloneRepoStreaming(
		url: string,
		destPath: string,
		branch: string | undefined,
		onProgress: (line: string) => void,
		credentials?: { username: string; password: string },
	): Promise<void> {
		// If credentials provided, use a temporary GIT_ASKPASS script so that
		// the password never appears in process arguments or git's stderr output.
		let askPassScript: string | undefined;
		if (credentials) {
			const id = Math.random().toString(36).slice(2, 10);
			askPassScript = join(tmpdir(), `narrafork-askpass-${id}.sh`);
			// Git calls GIT_ASKPASS with a single argument like "Username for '...': "
			// or "Password for '...': ". We match on the prompt to return the right value.
			const script = [
				"#!/bin/sh",
				`case "$1" in`,
				`  *[Uu]sername*) echo '${credentials.username.replace(/'/g, "'\\''")}';;`,
				`  *) echo '${credentials.password.replace(/'/g, "'\\''")}';;`,
				"esac",
			].join("\n");
			writeFileSync(askPassScript, script, { mode: 0o700 });
		}

		const args = ["clone", "--progress"];
		if (branch) args.push("--branch", branch);
		args.push(url, destPath);

		const proc = Bun.spawn(["git", ...args], {
			cwd: ".",
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			// git talks to the user's remotes, so it keeps the user's ambient proxy
			// configuration rather than NarraFork's blanked one.
			env: envWithAmbientProxy({
				GIT_TERMINAL_PROMPT: "0",
				...(askPassScript ? { GIT_ASKPASS: askPassScript } : {}),
			}),
		});

		// Read stderr in streaming fashion — git progress uses \r for in-place updates
		const reader = proc.stderr.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const recentStderrLines: string[] = [];

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				// Split on \r or \n — git uses \r for progress updates
				const parts = buffer.split(/[\r\n]+/);
				buffer = parts.pop() ?? "";
				for (const part of parts) {
					const trimmed = part.trim();
					if (trimmed) {
						onProgress(trimmed);
						recentStderrLines.push(trimmed);
						if (recentStderrLines.length > 5) recentStderrLines.shift();
					}
				}
			}
			// Flush remaining
			const final = decoder.decode();
			buffer += final;
			if (buffer.trim()) {
				onProgress(buffer.trim());
				recentStderrLines.push(buffer.trim());
				if (recentStderrLines.length > 5) recentStderrLines.shift();
			}
		} finally {
			reader.releaseLock();
		}

		// Drain stdout to avoid pipe deadlock
		await new Response(proc.stdout).text();

		// Clean up temporary askpass script before checking exit code
		if (askPassScript) {
			try {
				rmSync(askPassScript, { force: true });
			} catch {}
		}

		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const detail =
				recentStderrLines.find((l) => l.startsWith("fatal:")) ||
				recentStderrLines[recentStderrLines.length - 1] ||
				"";

			// Detect authentication failure
			const allStderr = recentStderrLines.join("\n").toLowerCase();
			if (
				allStderr.includes("authentication failed") ||
				allStderr.includes("could not read username") ||
				allStderr.includes("terminal prompts disabled") ||
				allStderr.includes("could not read password") ||
				allStderr.includes("invalid credentials") ||
				allStderr.includes("logon failed")
			) {
				throw new GitAuthError(detail || "Git authentication required");
			}

			const suffix = detail ? `: ${detail}` : "";
			throw new GitError(`Failed to clone repo (exit code ${exitCode})${suffix}`);
		}
	},

	// === Stage / Unstage ===

	async stageFiles(worktreePath: string, files: string[]): Promise<void> {
		if (files.length === 0) return;
		return withWorktreeLock(worktreePath, () => this.stageFilesUnlocked(worktreePath, files));
	},

	/** {@link stageFiles} for callers already holding the worktree lock. */
	async stageFilesUnlocked(worktreePath: string, files: string[]): Promise<void> {
		if (files.length === 0) return;
		const result = await exec(["add", "--", ...files], worktreePath);
		if (result.exitCode !== 0) throw new GitError(`git add failed: ${result.stderr}`);
	},

	async stageAll(worktreePath: string): Promise<void> {
		return withWorktreeLock(worktreePath, () => this.stageAllUnlocked(worktreePath));
	},

	/** {@link stageAll} for callers already holding the worktree lock. */
	async stageAllUnlocked(worktreePath: string): Promise<void> {
		const result = await exec(["add", "-A"], worktreePath);
		if (result.exitCode !== 0) throw new GitError(`git add -A failed: ${result.stderr}`);
	},

	async unstageFiles(worktreePath: string, files: string[]): Promise<void> {
		if (files.length === 0) return;
		return withWorktreeLock(worktreePath, () => this.unstageFilesUnlocked(worktreePath, files));
	},

	/** {@link unstageFiles} for callers already holding the worktree lock. */
	async unstageFilesUnlocked(worktreePath: string, files: string[]): Promise<void> {
		if (files.length === 0) return;
		const result = await exec(["reset", "HEAD", "--", ...files], worktreePath);
		if (result.exitCode !== 0) throw new GitError(`git reset failed: ${result.stderr}`);
	},

	async unstageAll(worktreePath: string): Promise<void> {
		return withWorktreeLock(worktreePath, () => this.unstageAllUnlocked(worktreePath));
	},

	/** {@link unstageAll} for callers already holding the worktree lock. */
	async unstageAllUnlocked(worktreePath: string): Promise<void> {
		const result = await exec(["reset", "HEAD"], worktreePath);
		if (result.exitCode !== 0) throw new GitError(`git reset failed: ${result.stderr}`);
	},

	async commit(
		worktreePath: string,
		message: string,
		identity?: GitCommitIdentity,
	): Promise<string> {
		return withWorktreeLock(worktreePath, () =>
			this.commitUnlocked(worktreePath, message, identity),
		);
	},

	/** {@link commit} for callers already holding the worktree lock. */
	async commitUnlocked(
		worktreePath: string,
		message: string,
		identity?: GitCommitIdentity,
	): Promise<string> {
		const result = await exec(["commit", "-m", message], worktreePath, {
			identity: identity ?? null,
		});
		if (result.exitCode !== 0) throw new GitError(`git commit failed: ${result.stderr}`);
		return this.getHeadCommit(worktreePath);
	},

	async discardFiles(worktreePath: string, files: string[]): Promise<void> {
		if (files.length === 0) return;
		return withWorktreeLock(worktreePath, () => this.discardFilesUnlocked(worktreePath, files));
	},

	/** {@link discardFiles} for callers already holding the worktree lock. */
	async discardFilesUnlocked(worktreePath: string, files: string[]): Promise<void> {
		if (files.length === 0) return;
		// `-uall` is a SAFETY requirement here, not just a display one. Collapsed
		// output would report `?? newdir/` for a request to discard
		// `newdir/one.txt`, and the `git clean` below would then delete the entire
		// directory — every sibling the user never asked to touch.
		const statusResult = await execRead([...PORCELAIN_UNTRACKED_ALL, "--", ...files], worktreePath);
		const tracked: string[] = [];
		const untracked: string[] = [];
		for (const line of statusResult.stdout.split("\n").filter(Boolean)) {
			const path = line.slice(3);
			if (line[0] === "?" && line[1] === "?") {
				untracked.push(path);
			} else {
				tracked.push(path);
			}
		}
		if (tracked.length > 0) {
			const r = await exec(["checkout", "HEAD", "--", ...tracked], worktreePath);
			if (r.exitCode !== 0) throw new GitError(`git checkout failed: ${r.stderr}`);
		}
		if (untracked.length > 0) {
			const r = await exec(["clean", "-f", "--", ...untracked], worktreePath);
			if (r.exitCode !== 0) throw new GitError(`git clean failed: ${r.stderr}`);
		}
	},

	async discardAll(worktreePath: string): Promise<void> {
		return withWorktreeLock(worktreePath, () => this.discardAllUnlocked(worktreePath));
	},

	/** {@link discardAll} for callers already holding the worktree lock. */
	async discardAllUnlocked(worktreePath: string): Promise<void> {
		const r1 = await exec(["checkout", "HEAD", "--", "."], worktreePath);
		if (r1.exitCode !== 0) throw new GitError(`git checkout failed: ${r1.stderr}`);
		const r2 = await exec(["clean", "-fd"], worktreePath);
		if (r2.exitCode !== 0) throw new GitError(`git clean failed: ${r2.stderr}`);
	},

	/** Stash the working tree. `identity` authors the underlying stash commit objects. */
	async stash(worktreePath: string, message?: string, identity?: GitCommitIdentity): Promise<void> {
		return withWorktreeLock(worktreePath, () =>
			this.stashUnlocked(worktreePath, message, identity),
		);
	},

	/** {@link stash} for callers already holding the worktree lock. */
	async stashUnlocked(
		worktreePath: string,
		message?: string,
		identity?: GitCommitIdentity,
	): Promise<void> {
		const args = ["stash", "push", "--include-untracked"];
		if (message) args.push("-m", message);
		const result = await exec(args, worktreePath, { identity: identity ?? null });
		if (result.exitCode !== 0) throw new GitError(`git stash failed: ${result.stderr}`);
	},

	async stashPop(worktreePath: string): Promise<{ hasConflicts: boolean }> {
		return withWorktreeLock(worktreePath, () => this.stashPopUnlocked(worktreePath));
	},

	/** {@link stashPop} for callers already holding the worktree lock. */
	async stashPopUnlocked(worktreePath: string): Promise<{ hasConflicts: boolean }> {
		const result = await exec(["stash", "pop"], worktreePath, true);
		if (result.exitCode !== 0) {
			const hasUnmerged = (await detectUnmergedFiles(worktreePath)).length > 0;
			if (hasUnmerged || commandOutputMentionsConflict(result)) {
				return { hasConflicts: true };
			}
			throw new GitError(gitFailureMessage("git stash pop failed", result));
		}
		return { hasConflicts: false };
	},

	async stashList(
		worktreePath: string,
	): Promise<Array<{ index: number; message: string; date: string }>> {
		const result = await execRead(
			["stash", "list", "--format=%gd%x00%gs%x00%ai"],
			worktreePath,
			true,
		);
		if (!result.stdout.trim()) return [];
		return result.stdout
			.trim()
			.split("\n")
			.map((line) => {
				const [ref, message, date] = line.split("\0");
				const index = Number.parseInt(ref?.replace("stash@{", "").replace("}", "") ?? "0", 10);
				return { index, message: message ?? "", date: date ?? "" };
			});
	},

	async stashDrop(worktreePath: string, index: number): Promise<void> {
		return withWorktreeLock(worktreePath, () => this.stashDropUnlocked(worktreePath, index));
	},

	/** {@link stashDrop} for callers already holding the worktree lock. */
	async stashDropUnlocked(worktreePath: string, index: number): Promise<void> {
		const result = await exec(["stash", "drop", `stash@{${index}}`], worktreePath);
		if (result.exitCode !== 0) throw new GitError(`git stash drop failed: ${result.stderr}`);
	},

	// === File diff (working tree) ===

	async getFileDiff(
		worktreePath: string,
		filePath: string,
		staged = false,
		maxBytes = 200_000,
	): Promise<{ diff: string; truncated: boolean }> {
		// Check if file is untracked. `-uall` so a file inside a brand-new directory
		// is reported as itself rather than as its collapsed parent directory.
		const statusResult = await execRead(
			[...PORCELAIN_UNTRACKED_ALL, "--", filePath],
			worktreePath,
			true,
		);
		const statusLine = statusResult.stdout.trim();

		let diff: string;
		if (statusLine.startsWith("??")) {
			// Untracked file — show full content as "new file" diff
			const r = await execRead(["diff", "--no-index", DEV_NULL, filePath], worktreePath, true);
			diff = r.stdout;
		} else if (staged) {
			const r = await execRead(["diff", "--cached", "--", filePath], worktreePath, true);
			diff = r.stdout;
		} else {
			const r = await execRead(["diff", "--", filePath], worktreePath, true);
			diff = r.stdout;
		}

		let truncated = false;
		if (diff.length > maxBytes) {
			diff = diff.slice(0, maxBytes);
			truncated = true;
		}
		return { diff, truncated };
	},

	// === Commit boundaries ===

	/**
	 * When each of `paths` was last committed, plus the walk's oldest boundary.
	 *
	 * This answers "where does the current uncommitted change to this file begin",
	 * which is what separates *this* round of edits from the file's whole history. A
	 * single repository-wide HEAD timestamp cannot answer it: in this repository 90 of
	 * 127 changed files were last committed BEFORE HEAD, by a median of 164 hours, so a
	 * global boundary silently discards real attributions.
	 *
	 * One bounded walk serves every path. `--max-count` caps the work: beyond a few
	 * hundred commits the walk stops finding new paths (200 and 800 both resolved the
	 * same 90 files here) while output keeps growing.
	 *
	 * A path absent from `byPath` has no commit in the window. That is either a file
	 * that was never committed (untracked — every attribution belongs to the current
	 * change) or one whose last commit is older than the window. The two are
	 * indistinguishable from the walk alone, so callers use `oldestInWindow` for
	 * tracked paths: being NEWER than the true boundary, it can only under-count, and
	 * over-crediting a file with unrelated history is the failure that matters.
	 *
	 * Precision caveat: `%cI` is second-resolution, so a change recorded in the SAME
	 * second as the commit cannot be placed on either side of it and will be counted as
	 * part of the current round. The error is bounded by one second and errs toward
	 * showing a contributor rather than hiding one, which is the safer direction for a
	 * display that answers "who touched this".
	 *
	 * @param paths  Repo-relative paths. Capped at {@link COMMIT_BOUNDARY_MAX_PATHS};
	 *               the excess simply falls back to `oldestInWindow`.
	 */
	async getLastCommitTimes(
		worktreePath: string,
		paths: string[],
	): Promise<{ byPath: Map<string, string>; oldestInWindow: string | null }> {
		const byPath = new Map<string, string>();
		if (paths.length === 0) return { byPath, oldestInWindow: null };
		// An unborn HEAD has nothing to walk, and `git log` would fail rather than
		// report zero commits.
		if (await hasNoCommits(worktreePath)) return { byPath, oldestInWindow: null };

		const capped = paths.slice(0, COMMIT_BOUNDARY_MAX_PATHS);
		const result = await execRead(
			[
				// Prevent git from quoting non-ASCII paths as octal escape sequences
				// (e.g. "\344\270\255..."). Without this, CJK and other non-ASCII filenames
				// won't match the bare path strings callers pass in, causing boundary misses
				// that fall back to the less precise `oldestInWindow`.
				"-c",
				"core.quotePath=false",
				"log",
				"HEAD",
				`--max-count=${COMMIT_BOUNDARY_MAX_COMMITS}`,
				// A commit line is prefixed so it cannot be confused with a file path;
				// `--name-only` prints paths bare.
				`--format=${COMMIT_BOUNDARY_MARKER_FORMAT}%cI`,
				"--name-only",
				"--",
				...capped,
			],
			worktreePath,
			true,
		);
		if (result.exitCode !== 0) return { byPath, oldestInWindow: null };

		let current: string | null = null;
		let oldestInWindow: string | null = null;
		for (const rawLine of result.stdout.split("\n")) {
			const line = rawLine.trim();
			if (!line) continue;
			if (line.startsWith(COMMIT_BOUNDARY_MARKER)) {
				current = toUtcIso(line.slice(COMMIT_BOUNDARY_MARKER.length));
				// Walk order is newest-first, so the last commit seen is the oldest.
				if (current) oldestInWindow = current;
				continue;
			}
			// First sighting wins: the newest commit that touched this path.
			if (current && !byPath.has(line)) byPath.set(line, current);
		}

		return { byPath, oldestInWindow };
	},

	// === Log ===

	async getLog(
		worktreePath: string,
		opts: { limit?: number; skip?: number; branch?: string } = {},
	): Promise<
		Array<{
			sha: string;
			shortSha: string;
			message: string;
			author: string;
			date: string;
		}>
	> {
		const args = [
			"log",
			`--max-count=${opts.limit ?? 50}`,
			`--skip=${opts.skip ?? 0}`,
			"--format=%H%x00%h%x00%s%x00%an%x00%aI",
		];
		if (opts.branch) args.push(opts.branch);
		const result = await execRead(args, worktreePath, true);
		if (!result.stdout.trim()) return [];
		return result.stdout
			.trim()
			.split("\n")
			.map((line) => {
				const [sha, shortSha, message, author, date] = line.split("\0");
				return {
					sha: sha ?? "",
					shortSha: shortSha ?? "",
					message: message ?? "",
					author: author ?? "",
					date: date ?? "",
				};
			});
	},

	/**
	 * Number of commits reachable from `branch` (default HEAD).
	 *
	 * Returns 0 for the two cases that legitimately mean zero — an unborn HEAD in a fresh
	 * repository, and a ref that does not exist — and throws for everything else (git
	 * missing, a broken repository, a timeout), because the previous `|| 0` made a broken
	 * git indistinguishable from an empty repository and callers rendered "0 commits".
	 *
	 * "The ref does not exist" has to be its own case rather than being folded into
	 * {@link hasNoCommits}, which only recognises an unborn *HEAD*. A repository with
	 * commits on `master` while `project.defaultBranch` says `main` — a renamed or deleted
	 * branch, or an import whose default differs — fails `rev-list --count main` with exit
	 * 128 while HEAD resolves fine, so `hasNoCommits` said false and this threw. The
	 * ruler timeline calls it inside a `Promise.all` with no catch, so the whole `/ruler`
	 * endpoint returned 500 and the page would not open at all; before the throw was
	 * introduced the same repository degraded to displaying 0.
	 *
	 * Probed with `rev-parse --verify --quiet` on the ref itself, which answers exactly
	 * this question: exit 1 with no output for an unresolvable ref (including a range
	 * whose endpoints do not resolve), exit 128 only when git could not run at all.
	 */
	async getCommitCount(worktreePath: string, branch?: string): Promise<number> {
		const ref = branch ?? "HEAD";
		const result = await execRead(["rev-list", "--count", ref], worktreePath, true);
		if (result.exitCode !== 0) {
			if (await hasNoCommits(worktreePath)) return 0;
			if (await refIsMissing(worktreePath, ref)) return 0;
			throw new GitError(gitFailureMessage(`Failed to count commits for ${ref}`, result));
		}
		const count = Number.parseInt(result.stdout.trim(), 10);
		if (!Number.isFinite(count)) {
			throw new GitError(`Unexpected commit count output for ${ref}: ${result.stdout.trim()}`);
		}
		return count;
	},

	/**
	 * Position of `sha` in `git log <branch>` order, or null when it is not in that walk.
	 *
	 * Exists because "how many commits are reachable from main but not from X"
	 * (`rev-list --count X..main`) is NOT X's index in `git log main`, and the two differ by
	 * exactly the commits that are ordered before X by DATE while not being its ancestors —
	 * i.e. anything that arrived through a merge. `git log` sorts by commit date by default;
	 * `rev-list --count A..B` measures a reachability set. On this repository the 200th
	 * commit sits at log index 199 while the range count says 202, so paging that trusted
	 * the count skipped three commits per page — and a chapter anchored to one of them lost
	 * its tick and was reported as "not on this branch".
	 *
	 * Implemented with the same `log` walk the pages come from, so the answer is in the same
	 * order by construction rather than by an assumed correspondence between two orders.
	 * `--format=%H` + a line scan rather than `--pretty=%H | grep -n`: the position must
	 * come from the array the caller pages against, and shelling out to grep would add a
	 * second process and a locale-dependent match for something this is already reading.
	 *
	 * Bounded by `searchLimit` (default {@link COMMIT_LOG_INDEX_SEARCH_LIMIT}): an unbounded
	 * scan on a huge repository is a main-thread cost with no ceiling, and a cursor that far
	 * back means the client is asking for something no user scrolled to. Returns null past
	 * the limit, which callers treat as "cursor not usable" and fall back to skip-based
	 * paging.
	 *
	 * The line budget and the byte budget are raised TOGETHER (see the constant): the
	 * capture ceiling is the real constraint, so a `--max-count` that exceeds what
	 * `maxOutputBytes` can retain just makes git walk history whose output is then thrown
	 * away, and silently halves the effective search depth.
	 */
	async findCommitLogIndex(
		worktreePath: string,
		sha: string,
		opts: { branch?: string; searchLimit?: number } = {},
	): Promise<number | null> {
		if (!sha) return null;
		const searchLimit = opts.searchLimit ?? COMMIT_LOG_INDEX_SEARCH_LIMIT;
		const args = ["log", `--max-count=${searchLimit}`, "--format=%H"];
		if (opts.branch) args.push(opts.branch);
		const result = await execRead(args, worktreePath, true, {
			maxOutputBytes: commitLogIndexMaxOutputBytes(searchLimit),
		});
		if (result.exitCode !== 0 || !result.stdout.trim()) return null;
		if (result.truncated) {
			// Not fatal — the scan below still answers for anything inside the retained
			// prefix — but it means the effective depth was smaller than requested, and a
			// null result may be "capture ran out" rather than "not on this branch".
			logger.warn("Commit log index scan hit its capture ceiling", {
				worktreePath,
				searchLimit,
			});
		}
		const lines = result.stdout.trim().split("\n");
		// An exact hit is unambiguous and wins immediately. An abbreviated sha is only
		// answered once the whole walk has been scanned, because a prefix that matches
		// two commits names neither: at 7 hex chars the birthday bound is roughly
		// 1/2000 over 50k commits, and this index drives Ruler's cursor pagination, so
		// a wrong hit silently shifts a page and drops the commits in between.
		//
		// Rejecting ambiguity rather than imposing a minimum prefix length: a length
		// floor is a guess about collision odds that still answers wrongly when the
		// collision does happen, and it breaks the legitimate short-sha callers this
		// method has always supported. Scanning to the end costs one extra pass over an
		// already-materialized, `--max-count`-bounded array.
		let prefixIndex: number | null = null;
		let prefixAmbiguous = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]?.trim();
			if (!line) continue;
			if (line === sha) return i;
			if (line.startsWith(sha)) {
				if (prefixIndex !== null) prefixAmbiguous = true;
				else prefixIndex = i;
			}
		}
		if (prefixAmbiguous) {
			logger.warn("Ambiguous abbreviated sha in commit log index scan", {
				worktreePath,
				shaLength: sha.length,
			});
			return null;
		}
		return prefixIndex;
	},

	// === Reset ===

	async resetSoft(worktreePath: string, target: string): Promise<void> {
		return withWorktreeLock(worktreePath, () => this.resetSoftUnlocked(worktreePath, target));
	},

	/** {@link resetSoft} for callers already holding the worktree lock. */
	async resetSoftUnlocked(worktreePath: string, target: string): Promise<void> {
		const result = await exec(["reset", "--soft", target], worktreePath);
		if (result.exitCode !== 0) throw new GitError(`git reset --soft failed: ${result.stderr}`);
	},

	async resetHard(worktreePath: string, target: string): Promise<void> {
		return withWorktreeLock(worktreePath, () => this.resetHardUnlocked(worktreePath, target));
	},

	/** {@link resetHard} for callers already holding the worktree lock. */
	async resetHardUnlocked(worktreePath: string, target: string): Promise<void> {
		const result = await exec(["reset", "--hard", target], worktreePath);
		if (result.exitCode !== 0) throw new GitError(`git reset --hard failed: ${result.stderr}`);
	},

	/**
	 * Abandon a conflicted merge while keeping unrelated uncommitted work.
	 *
	 * The clean-up a failed `--squash` merge needs. `git merge --abort` cannot do it:
	 * `--squash --no-commit` never writes MERGE_HEAD, so abort exits 128 and leaves the
	 * conflict markers on disk — where the next auto-commit happily commits them.
	 *
	 * `reset --hard` would clear the conflict, but it also discards every other
	 * uncommitted change in the worktree, which in a chapter someone is working in is
	 * the loss this whole path exists to prevent. `--merge` resets only the paths that
	 * differ between the index and the target commit, so the conflicted files are
	 * restored while an unrelated edit elsewhere survives.
	 *
	 * `target` is normally the pre-merge HEAD. Omitting it resets to HEAD, which is
	 * what a `--no-commit` merge wants since HEAD never moved.
	 */
	async resetMerge(worktreePath: string, target?: string): Promise<void> {
		return withWorktreeLock(worktreePath, () => this.resetMergeUnlocked(worktreePath, target));
	},

	/** {@link resetMerge} for callers already holding the worktree lock. */
	async resetMergeUnlocked(worktreePath: string, target?: string): Promise<void> {
		const result = await exec(["reset", "--merge", ...(target ? [target] : [])], worktreePath);
		if (result.exitCode !== 0) {
			throw new GitError(gitFailureMessage("git reset --merge failed", result));
		}
	},

	/**
	 * Delete untracked files and directories, leaving ignored ones and `.worktrees/` alone.
	 *
	 * Deliberately `-fd` without `-x`: ignored paths are build outputs, virtualenvs and
	 * dependency trees, which are excluded from snapshots by design. Removing them would
	 * be an unrecoverable loss dressed up as tidying, and nothing that needs a clean
	 * worktree cares about them — git's own checkout only ever collides with untracked,
	 * non-ignored paths.
	 *
	 * `-e /.worktrees/` is the same argument applied to the directory holding every other
	 * chapter's worktree, and it has to be stated here because the equivalent exclude the
	 * snapshot engine relies on lives in the *shadow* repository's `info/exclude`, which
	 * the user's `git clean` cannot see. A registered linked worktree is protected by git
	 * itself, but anything else under `.worktrees/` is not: measured on a root chapter
	 * (where `worktreePath` *is* `gitPath`) with no `.gitignore`, `clean -fd` removed
	 * `.worktrees/loose.txt` and the residue of an unregistered or broken worktree — and
	 * those are precisely the paths the shadow exclude keeps out of snapshots, so there is
	 * nothing to restore them from. A `.gitignore` entry covers this when it exists, and
	 * the write that adds it is best-effort (see project-db-sync), which is the window.
	 *
	 * Correct for every caller, not just the parking path: `.worktrees/` is NarraFork's
	 * own reserved directory, so no caller has a reason to want it deleted, and git will
	 * not check out over it either — it is not part of any tracked tree.
	 */
	async cleanUntracked(worktreePath: string): Promise<void> {
		return withWorktreeLock(worktreePath, () => this.cleanUntrackedUnlocked(worktreePath));
	},

	/** {@link cleanUntracked} for callers already holding the worktree lock. */
	async cleanUntrackedUnlocked(worktreePath: string): Promise<void> {
		// Anchored with a leading slash and directory-only, matching the shadow repo's
		// rule: a legitimately-tracked `docs/.worktrees` elsewhere stays cleanable, and
		// a plain file named `.worktrees` is not silently preserved.
		const result = await exec(["clean", "-fd", "-e", `/${WORKTREES_DIR_NAME}/`], worktreePath);
		if (result.exitCode !== 0) throw new GitError(`git clean failed: ${result.stderr}`);
	},

	// === Revert ===

	/** Check if a commit is a merge commit (has more than one parent) */
	async isMergeCommit(worktreePath: string, commitSha: string): Promise<boolean> {
		const result = await execRead(["cat-file", "-p", commitSha], worktreePath);
		if (result.exitCode !== 0) return false;
		const parentLines = result.stdout.split("\n").filter((l) => l.startsWith("parent "));
		return parentLines.length > 1;
	},

	/** Revert a merge commit (using -m 1 to specify the mainline parent) */
	async revertMergeCommit(
		worktreePath: string,
		commitSha: string,
		identity?: GitCommitIdentity,
	): Promise<string> {
		return withWorktreeLock(worktreePath, () =>
			this.revertMergeCommitUnlocked(worktreePath, commitSha, identity),
		);
	},

	/** {@link revertMergeCommit} for callers already holding the worktree lock. */
	async revertMergeCommitUnlocked(
		worktreePath: string,
		commitSha: string,
		identity?: GitCommitIdentity,
	): Promise<string> {
		const result = await exec(["revert", "-m", "1", "--no-edit", commitSha], worktreePath, {
			identity: identity ?? null,
		});
		if (result.exitCode !== 0) {
			// Abort the failed revert to leave worktree clean
			await exec(["revert", "--abort"], worktreePath);
			throw new GitError(
				`git revert produced conflicts — the merge cannot be automatically undone. ` +
					`Resolve manually with: git revert -m 1 ${commitSha}`,
			);
		}
		const head = await execRead(["rev-parse", "HEAD"], worktreePath);
		return head.stdout.trim();
	},

	/** Revert a regular (non-merge) commit */
	async revertCommit(
		worktreePath: string,
		commitSha: string,
		identity?: GitCommitIdentity,
	): Promise<string> {
		return withWorktreeLock(worktreePath, () =>
			this.revertCommitUnlocked(worktreePath, commitSha, identity),
		);
	},

	/** {@link revertCommit} for callers already holding the worktree lock. */
	async revertCommitUnlocked(
		worktreePath: string,
		commitSha: string,
		identity?: GitCommitIdentity,
	): Promise<string> {
		const result = await exec(["revert", "--no-edit", commitSha], worktreePath, {
			identity: identity ?? null,
		});
		if (result.exitCode !== 0) {
			await exec(["revert", "--abort"], worktreePath);
			throw new GitError(
				`git revert produced conflicts — the merge cannot be automatically undone. ` +
					`Resolve manually with: git revert ${commitSha}`,
			);
		}
		const head = await execRead(["rev-parse", "HEAD"], worktreePath);
		return head.stdout.trim();
	},
};
