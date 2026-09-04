/**
 * Content-addressed worktree snapshots.
 *
 * A snapshot is a git *tree* object written into a shadow repository that shares
 * no history with the user's repo: `git add -A` + `git write-tree` produces a
 * hash of the actual working-tree bytes, with no commit, branch, or index change
 * visible to the user.
 *
 * Why this exists (and why it replaces forward-replaying recorded edits):
 *   - It captures changes made by *any* actor. Replay only knows about Write/Edit
 *     tool inputs, so Bash, external editors and build scripts were invisible.
 *   - It is byte-exact, so binary files and legacy charsets round-trip. Storing
 *     decoded text cannot represent either.
 *   - Restoring is one `read-tree` + `checkout-index`, so there is no chance of a
 *     partially-applied or diverged rebuild.
 *
 * "Byte-exact" is an outcome that has to be engineered, not a property inherited from
 * using git. git's own content filters — `core.autocrlf`, `text=auto`, `filter=`,
 * `working-tree-encoding`, `ident` — will happily change bytes in both directions, and
 * do it in the one way that defeats the engine's own checks: the restored file differs
 * on disk while re-hashing yields the *same* tree. {@link SHADOW_ATTRIBUTES} and
 * {@link SHADOW_CONFIG_ENV} are what make the promise true.
 *
 * Two exclusions are likewise load-bearing rather than housekeeping. `/.worktrees/` is
 * excluded because the root chapter's workspace *is* the project's git root, so a
 * capture there descends into every other chapter's live worktree and a rollback would
 * delete it. Conversely, files the real repository tracks *despite* an ignore rule are
 * force-added back in, because a file missing from the tree makes both boundaries of a
 * change identical and the revert planner then reads that as "nothing happened".
 *
 * Scope is `(deviceId, worktreePath)`. Tying snapshots to a chapter (as the older
 * chapter-scoped implementation did) breaks as soon as several narrators share a
 * worktree, which already happens for subagents and for the root chapter.
 *
 * Remote devices are not supported yet: the signature carries `deviceId` so the
 * call sites are already correct, and remote support becomes an implementation of
 * {@link runGit} over `ExecutionBackend.execCommand`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { chapters, worktreeTreeSnapshots } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { AsyncMutex } from "../lib/async-mutex";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";
import { normalizePathForComparison } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";
import { clearClaims } from "./worktree-write-claims";

const SHADOW_ROOT = getNarraforkPath("tree-snapshots");

/**
 * Hard timeout for a single shadow-repo git invocation.
 *
 * Snapshotting sits on the tool-execution path, so it must fail fast rather than
 * stall a narrator: a hung git (stale lock, huge tree, slow filesystem) has to
 * surface as "no snapshot" instead of blocking the turn.
 */
const GIT_TIMEOUT_MS = 15_000;

/**
 * Total budget a tool-boundary capture may spend on the hot path, including any
 * time queued on the shadow lock.
 *
 * The capture sits *inside* the narrator's event consumer (`onSnapshotBefore` is
 * awaited before `tool_started` is even broadcast), so an unbounded capture stalls
 * the whole session: no permission prompt, no execution, no tool timeout. On a
 * huge worktree on Windows (slow lstat + antivirus scanning) a cold `git add -A`
 * routinely exceeds {@link GIT_TIMEOUT_MS}; worse, killing it before the index is
 * written means *every* capture is a cold scan, so the stall never self-heals.
 *
 * Past this budget the capture is not killed — it keeps running in the background
 * as the worktree's single warm-up attempt (see {@link WARMUP_GIT_TIMEOUT_MS}) so
 * the index gets written once and later captures become cheap again. The hot path
 * returns null and the tool proceeds without a precise boundary, degrading to the
 * per-file replay path for that call.
 */
const HOT_PATH_CAPTURE_BUDGET_MS = 4_000;

/**
 * Per-git-invocation ceiling for a capture that may become a warm-up.
 *
 * Much larger than {@link GIT_TIMEOUT_MS} on purpose: the one thing a warm-up must
 * achieve is a *completed* `add -A`, because the index is only written at the end
 * of the scan. The 15 s kill was exactly what kept a huge worktree cold forever —
 * every capture restarted the full hash and died before persisting anything.
 * Bounded anyway so a genuinely wedged git cannot leak a process indefinitely.
 */
const WARMUP_GIT_TIMEOUT_MS = 10 * 60_000;

/**
 * How long hot-path captures are skipped after a warm-up attempt fails.
 *
 * Without a cooldown the next tool call would immediately launch another full
 * background scan, turning a hopeless tree into a permanent scan loop that keeps
 * the disk, CPU and antivirus busy forever. During the window the hot path returns
 * null instantly; the in-memory maps reset on process restart, and the settings
 * toggle (`chapters.treeSnapshotsEnabled`) is the manual escape hatch.
 */
const WARMUP_FAILURE_COOLDOWN_MS = 15 * 60_000;

/** Cap on captured git output; tree hashes and status are tiny. */
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Cap on captured output for commands that legitimately list a whole tree.
 *
 * A path listing is not "tiny": one line per file means a large repository blows
 * past the 1 MB cap that suffices for hashes, and the truncation guard then turns a
 * rollback into a hard failure. Restore avoids whole-tree listings entirely (it asks
 * only about the paths it is going to touch), so this applies to the explicitly
 * whole-tree API used by previews.
 */
const GIT_MAX_LISTING_BYTES = 32 * 1024 * 1024;

/**
 * Most paths written into the index in one `update-index` invocation, and the
 * budget for that invocation's argument bytes.
 *
 * One spawn per path meant 300 child processes for a 300-path owned set, all while
 * holding the shadow lock — every other capture on that worktree queues behind it.
 * The byte budget keeps the batched argv well under the platform's `ARG_MAX`
 * (≥256 KB even on the strictest supported systems).
 */
const UPDATE_INDEX_BATCH_PATHS = 256;
const UPDATE_INDEX_BATCH_BYTES = 96 * 1024;

/** Path count past which a snapshot operation is logged as slow. */
const SLOW_PATH_COUNT = 2_000;

/**
 * Most tracked-but-ignored paths force-added into one capture.
 *
 * The set is normally empty or a handful (`.env`, a checked-in build artefact), so
 * the cap only exists to stop a pathological repository — one that `git add -f`'d a
 * whole ignored dependency tree — from putting thousands of extra argv bytes and a
 * proportional index write on the tool-execution path. Past the cap the excess is
 * dropped with a warning rather than silently: those paths stay outside snapshots,
 * which is the pre-existing behaviour, and the warning is what makes it visible.
 */
const MAX_TRACKED_IGNORED_PATHS = 5_000;

/**
 * Reserved directory holding every chapter's linked worktree.
 *
 * `<project.gitPath>/.worktrees/<name>`, and the root chapter's own `worktreePath`
 * *is* `gitPath` — so a capture of the root workspace walks straight into every
 * other chapter's worktree. See {@link syncExcludes} for why that must never be
 * snapshotted and {@link isWorktreeRoot} for the second line of defence.
 */
export const WORKTREES_DIR_NAME = ".worktrees";

/**
 * Elapsed time past which one capture is reported as slow.
 *
 * Deliberately far below {@link GIT_TIMEOUT_MS}: a capture at this point still
 * succeeds, so the warning exists to surface the trend *before* the cap starts
 * being hit and boundaries start going missing. A warm capture re-stats the tree
 * against the shadow repo's persisted index and lands in the tens of milliseconds,
 * so this only fires on a genuinely expensive scan.
 */
const SLOW_CAPTURE_WARN_MS = 2_000;

/**
 * Least time between capture-cost warnings of the same severity for one shadow repo.
 *
 * Capture runs twice per file-mutating tool call, so an unthrottled warning on a
 * slow filesystem would itself become the hot-path cost it is reporting.
 */
const SLOW_CAPTURE_WARN_INTERVAL_MS = 60_000;

/** Last capture-cost warning per shadow repo and severity, to keep the log bounded. */
const captureWarnedAt = new Map<string, number>();

/**
 * The one in-flight warm-up capture per shadow repo.
 *
 * A hot-path capture that outlives {@link HOT_PATH_CAPTURE_BUDGET_MS} is not killed
 * — killing it before `add -A` finishes would discard the index write that makes
 * the *next* capture cheap, which is precisely the cycle that froze sessions on
 * huge Windows worktrees. It is instead promoted to the worktree's single warm-up:
 * later hot-path calls share its promise (with their own small budget) rather than
 * queueing a second full scan on the shadow lock.
 */
interface WarmupEntry {
	/** When the warm-up's scan started (its capture call was made). */
	startedAt: number;
	promise: Promise<string | null>;
	/** Kills the warm-up's current git process; used by structural preemption. */
	abort: AbortController;
	/**
	 * Set when a structural path claimed the shadow lock out from under the warm-up.
	 * A preempted warm-up is not evidence of a pathological worktree, so its failure
	 * must not start the failure cooldown.
	 */
	preempted: boolean;
}

const warmupInFlight = new Map<string, WarmupEntry>();

/**
 * Per-shadow-repo timestamp until which hot-path captures are skipped outright.
 * Set when a warm-up fails; absent (or expired) means the next call may try again.
 */
const warmupCooldownUntil = new Map<string, number>();

/**
 * Abort the shadow repo's in-flight warm-up capture, if any. Returns whether one
 * was preempted.
 *
 * A warm-up runs with the warm-up git timeout (minutes, not seconds) and holds the
 * shadow lock for its whole capture chain, so an unlucky structural call — restore,
 * merge, fork — would otherwise queue behind it for up to several git timeouts on
 * exactly the worktrees where the user most wants to roll back. Killing its
 * `add -A` is safe: git cleans up its own lock on SIGTERM, and the one hard-kill
 * case (Windows) is covered by removing the leftover lock below, once the shadow
 * lock itself proves no git can still be holding it.
 */
function preemptWarmCapture(dir: string): boolean {
	const entry = warmupInFlight.get(dir);
	if (!entry) return false;
	entry.preempted = true;
	entry.abort.abort();
	return true;
}

/**
 * Remove a shadow repo's leftover `index.lock` after a preemption.
 *
 * Only called while holding the shadow lock, which the preempted warm-up cannot
 * release before its killed git process has fully exited — so no live git can own
 * the lock file, and the age-based caution of {@link recoverStaleIndexLock} does
 * not apply. (Windows `taskkill` gives git no chance to clean up on its own.)
 */
function removeLeftoverIndexLockAfterPreemption(dir: string): void {
	try {
		rmSync(resolve(dir, "index.lock"), { force: true });
	} catch {
		// best effort — the age-based recovery path remains as a fallback
	}
}

/**
 * Acquire the shadow lock for a structural operation, preempting any warm-up first.
 *
 * Structural paths (capture/restore/merge/fork/gc) must never wait minutes behind a
 * background scan whose only purpose is to make *future* captures cheap.
 */
function acquireShadowStructural<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	const preempted = preemptWarmCapture(dir);
	return shadowLock.acquire(dir, async () => {
		if (preempted) removeLeftoverIndexLockAfterPreemption(dir);
		return fn();
	});
}

/**
 * Resolve `promise` if it settles within `budgetMs`, otherwise resolve `undefined`.
 * The loser is left running — callers rely on that (a losing capture becomes the
 * warm-up), so the timer is the only thing ever cancelled here.
 */
async function raceBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolvePromise) => {
				timer = setTimeout(() => resolvePromise(undefined), budgetMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Serializes snapshot work per shadow repository. */
const shadowLock = new AsyncMutex();

/** Tracks the last-seen ignore file mtimes per shadow repo to avoid redundant syncs. */
const excludeMtimes = new Map<string, string>();

export class TreeSnapshotError extends Error {
	constructor(
		message: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "TreeSnapshotError";
	}
}

/**
 * A restore that had already begun writing when it failed.
 *
 * Carries the tree captured immediately before the write started, which is what a
 * caller needs to register a compensation: without it, a failure mid-restore leaves
 * the caller holding no description of the pre-rollback state, so none of the three
 * capture-then-compensate exits can undo it. `compensated` says whether this module
 * already put that state back — `false` means the worktree may be half-applied and
 * the caller's compensation is the remaining line of defence.
 */
export class TreeRestoreError extends TreeSnapshotError {
	constructor(
		message: string,
		public readonly capturedTreeHash: string,
		public readonly compensated: boolean,
		cause?: unknown,
	) {
		super(message, cause);
		this.name = "TreeRestoreError";
	}
}

/** Canonical key for one worktree on one device. */
export function treeSnapshotKey(deviceId: string, worktreePath: string): string {
	return `${deviceId}\u0000${normalizePathForComparison(worktreePath)}`;
}

/**
 * Shadow repo location for a worktree.
 *
 * The directory name is a hash of the canonical key rather than the path itself:
 * worktree paths exceed filename limits, contain separators, and differ in case
 * across platforms.
 */
function shadowDir(deviceId: string, worktreePath: string): string {
	const digest = createHash("sha256").update(treeSnapshotKey(deviceId, worktreePath)).digest("hex");
	return resolve(SHADOW_ROOT, digest.slice(0, 32));
}

interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Run one git command against the shadow repo, preserving stdout byte-for-byte.
 *
 * Required for `-z` output, where trimming would eat the NUL delimiters that
 * separate records.
 */
async function runGitRaw(
	args: string[],
	gitDir: string,
	workTree: string,
	opts?: { maxOutputBytes?: number; timeoutMs?: number; signal?: AbortSignal },
): Promise<GitResult & { stdoutTruncated?: boolean }> {
	const result = await safeSpawn({
		cmd: ["git", "--git-dir", gitDir, "--work-tree", workTree, ...args],
		timeout: opts?.timeoutMs ?? GIT_TIMEOUT_MS,
		maxOutputBytes: opts?.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES,
		env: { ...process.env, ...SHADOW_CONFIG_ENV },
		...(opts?.signal && { signal: opts.signal }),
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
		...(result.stdoutTruncated && { stdoutTruncated: true }),
	};
}

/** Run one git command against the shadow repo with the real worktree attached. */
async function runGit(
	args: string[],
	gitDir: string,
	workTree: string,
	timeoutMs?: number,
	signal?: AbortSignal,
): Promise<GitResult> {
	const result = await runGitRaw(args, gitDir, workTree, { timeoutMs, signal });
	return {
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
		exitCode: result.exitCode,
	};
}

/**
 * Run a shadow-repo git command against a throwaway index.
 *
 * Needed when hashing a worktree that is *not* the one this shadow repo belongs to
 * (copying a snapshot into a fork). The repo's own index is a cache of the source
 * worktree's state, and reusing it would both corrupt that cache — making the next
 * capture there re-stat everything or report the wrong tree — and read the wrong
 * files' stat data.
 */
async function runGitWithIndex(
	args: string[],
	gitDir: string,
	workTree: string,
	indexFile: string,
): Promise<GitResult> {
	const result = await safeSpawn({
		cmd: ["git", "--git-dir", gitDir, "--work-tree", workTree, ...args],
		timeout: GIT_TIMEOUT_MS,
		maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
		env: { ...process.env, ...SHADOW_CONFIG_ENV, GIT_INDEX_FILE: indexFile },
	});
	return {
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
		exitCode: result.exitCode,
	};
}

/**
 * Run a path-listing git command and return the paths verbatim.
 *
 * Every path-producing command must go through here with `-z`. Without it git
 * applies `core.quotePath`, which renders a non-ASCII name as an escaped, quoted
 * C string (`"\344\270\255..."`). That string is not a real path, so resolving it
 * silently points at a file that does not exist — a rollback would then fail to
 * delete the file it claims to, and report mojibake back to the UI.
 *
 * The trailing NUL that `-z` emits after the final record is why the empty tail is
 * dropped rather than kept as a path.
 */
async function runGitPaths(
	args: string[],
	gitDir: string,
	workTree: string,
	opts?: { maxOutputBytes?: number },
): Promise<{ paths: string[]; exitCode: number; stderr: string }> {
	const result = await runGitRaw(args, gitDir, workTree, opts);
	if (result.stdoutTruncated) {
		throw new TreeSnapshotError("snapshot path listing exceeded the size limit");
	}
	return {
		paths: result.stdout.split("\0").filter(Boolean),
		exitCode: result.exitCode,
		stderr: result.stderr.trim(),
	};
}

/**
 * Pair up `git diff-tree --name-status -z` output.
 *
 * The stream is `STATUS\0PATH\0…`, so fields alternate. Parsed defensively because
 * a malformed pair must not shift every subsequent path onto the wrong status —
 * silently relabelling a delete as an add would make a file tree drop the wrong
 * directory. An unrecognised status is treated as `updated`: re-reading a parent is
 * always safe, whereas guessing `deleted` evicts loaded state.
 */
function parseNameStatusFields(
	fields: readonly string[],
): { path: string; kind: "added" | "updated" | "deleted" }[] {
	const out: { path: string; kind: "added" | "updated" | "deleted" }[] = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const status = fields[i];
		const path = fields[i + 1];
		if (!status || !path) continue;
		// Status is a letter, optionally followed by a similarity score (`R100`).
		const letter = status[0];
		const kind = letter === "A" ? "added" : letter === "D" ? "deleted" : "updated";
		out.push({ path, kind });
	}
	return out;
}

function assertLocal(deviceId: string): void {
	if (deviceId !== LOCAL_DEVICE_ID) {
		throw new TreeSnapshotError(
			`Tree snapshots are not implemented for remote device ${deviceId} yet.`,
		);
	}
}

/**
 * Namespace for every ref this module writes into a shadow repository.
 *
 * Refs exist for one reason: reachability. A bare tree written by `write-tree` is
 * unreachable from any ref, so `git gc` is entitled to delete it — and did, for
 * anything older than the prune window, while the database kept pointing at it.
 * Anchoring snapshots under one namespace makes them reachable, and makes
 * "everything NarraFork owns" a single prefix that {@link gcAll} can keep.
 */
const SNAPSHOT_REF_PREFIX = "refs/nf";

/** The ref tracking a worktree's latest snapshot commit. */
export const SNAPSHOT_HEAD_REF = `${SNAPSHOT_REF_PREFIX}/head`;

/** The ref recording the snapshot a chapter was forked from. */
export const SNAPSHOT_BASE_REF = `${SNAPSHOT_REF_PREFIX}/base`;

/** Ref for a snapshot lineage fetched in from another worktree's shadow repo. */
export function snapshotIncomingRef(key: string): string {
	return `${SNAPSHOT_REF_PREFIX}/incoming/${key}`;
}

/**
 * Reject a ref name that is not ours or that git would refuse.
 *
 * The name reaches `update-ref`/`fetch` as an argument, and a caller-supplied key
 * (a chapter id) flows into {@link snapshotIncomingRef}. Constraining it to the
 * namespace keeps a malformed or hostile id from writing outside `refs/nf/` — and
 * from being read as an option, since a leading `-` cannot pass this check.
 */
function assertSnapshotRef(ref: string): void {
	if (!ref.startsWith(`${SNAPSHOT_REF_PREFIX}/`)) {
		throw new TreeSnapshotError(`Refusing to touch a ref outside ${SNAPSHOT_REF_PREFIX}/: ${ref}`);
	}
	// `git check-ref-format` rules that matter here, checked locally so the failure
	// is a clear error rather than a git usage message.
	if (
		ref.includes("..") ||
		ref.endsWith("/") ||
		ref.endsWith(".lock") ||
		/[~^:?*[\\]/.test(ref) ||
		// Control characters and space are rejected by git too. Tested by code point
		// rather than a character-class range, which reads as a literal control
		// character in source.
		[...ref].some((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code <= 0x20 || code === 0x7f;
		})
	) {
		throw new TreeSnapshotError(`Invalid snapshot ref name: ${ref}`);
	}
}

/** A full 40-character hex object id, as git prints it. */
function assertObjectId(sha: string): void {
	if (!/^[0-9a-f]{40}$/.test(sha)) {
		throw new TreeSnapshotError(`Not a git object id: ${sha}`);
	}
}

/**
 * Identity used for snapshot commits.
 *
 * Set explicitly because the shadow repo has no configured user, and a missing
 * `user.email` makes `commit-tree` fail outright. It is also deliberately *not*
 * the user's identity: these commits are NarraFork's bookkeeping, never the
 * user's authored history, and they must be recognisable as such.
 *
 * The dates are fixed rather than "now" so that a snapshot commit is a pure
 * function of its tree, parents and message. Two captures of identical content
 * with identical lineage then produce the same commit hash, which keeps the DAG
 * deduplicated and makes the fork/merge tests deterministic.
 */
const SNAPSHOT_IDENTITY = {
	GIT_AUTHOR_NAME: "NarraFork Snapshot",
	GIT_AUTHOR_EMAIL: "snapshot@narrafork.local",
	GIT_COMMITTER_NAME: "NarraFork Snapshot",
	GIT_COMMITTER_EMAIL: "snapshot@narrafork.local",
	GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
} as const;

/**
 * Run a shadow-repo git command with the snapshot identity applied.
 *
 * Separate from {@link runGit} because only object-writing commands need it, and
 * because inheriting the ambient environment for every call would let a stray
 * `GIT_*` variable in the server's environment change what gets written.
 */
async function runGitAuthored(
	args: string[],
	gitDir: string,
	workTree: string,
): Promise<GitResult> {
	const result = await safeSpawn({
		cmd: ["git", "--git-dir", gitDir, "--work-tree", workTree, ...args],
		timeout: GIT_TIMEOUT_MS,
		maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
		env: { ...process.env, ...SHADOW_CONFIG_ENV, ...SNAPSHOT_IDENTITY },
	});
	return {
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
		exitCode: result.exitCode,
	};
}

/**
 * Resolve the effective global gitignore path. Priority:
 * 1. `git config --get core.excludesFile` (covers global + system config)
 * 2. $XDG_CONFIG_HOME/git/ignore (git's implicit default)
 * 3. ~/.config/git/ignore (XDG fallback)
 *
 * Returns null if none exists or git is not available.
 */
async function resolveGlobalGitignore(worktreePath: string): Promise<string | null> {
	try {
		// `git config --get` respects both global and system config files, which
		// is the same resolution order git itself uses.
		const result = await safeSpawn({
			cmd: ["git", "config", "--get", "core.excludesFile"],
			cwd: worktreePath,
			timeout: GIT_TIMEOUT_MS,
			maxOutputBytes: 4096,
		});
		if (result.exitCode === 0 && result.stdout.trim()) {
			const configured = result.stdout.trim();
			// Expand ~ prefix (git config returns it unexpanded)
			const expanded =
				configured.startsWith("~/") || configured === "~"
					? resolve(homedir(), configured.slice(2))
					: resolve(configured);
			if (existsSync(expanded)) return expanded;
		}
	} catch {
		// git not available or timed out — fall through to XDG defaults.
	}

	// Git's implicit default: $XDG_CONFIG_HOME/git/ignore or ~/.config/git/ignore
	const xdgHome = process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config");
	const xdgIgnore = resolve(xdgHome, "git", "ignore");
	if (existsSync(xdgIgnore)) return xdgIgnore;

	return null;
}

/** Cached global gitignore path + its mtime, to avoid re-resolving every snapshot. */
const globalIgnoreCache = new Map<string, { path: string | null; mtime: number }>();

/**
 * Per-shadow-repo memo of the tracked-but-ignored force-add, keyed on the real
 * repository's index identity.
 *
 * Both halves of that work are measurably expensive on the tool-execution path: on a
 * 5 000-file repository `git ls-files -i -c` costs ~18 ms and the force-add another
 * ~9 ms, against a ~26 ms warm capture — so doing them unconditionally nearly doubled
 * the hot path. Caching is sound because of what the second `add` is *for*: it only
 * ever needs to **introduce** an index entry. Once a path is in the shadow index, a
 * plain `add -A` keeps its content current and records its deletion (both verified),
 * so repeating the force-add on every capture buys nothing.
 *
 * The real repo's index mtime+size is the invalidation key because the set can only
 * change by the user running `git add -f`, `git rm --cached` or a checkout — all of
 * which write that index. One `stat` replaces two git subprocesses.
 *
 * That key alone is *not* sufficient, and the missing half is
 * {@link readTreeIntoShadowIndex}: what the memo records is "the force-add has already
 * introduced these entries", and the entries it is talking about live in the **shadow**
 * index, which `read-tree` rewrites without touching the real one. See that function for
 * the data loss the gap produced.
 */
const trackedIgnoredCache = new Map<string, { indexKey: string; paths: string[] }>();

/**
 * Load a tree into the shadow repository's own index, dropping the force-add memo.
 *
 * Every `read-tree` against the shadow index must go through here, because the memo in
 * {@link trackedIgnoredCache} is keyed on the *real* repository's index identity and
 * `read-tree` never writes that index. It does, however, replace every entry in the
 * shadow index with the target tree's — so a tracked-but-ignored path the force-add
 * introduced is **evicted** whenever the target tree does not contain it. The key is
 * then unchanged, {@link trackedButIgnoredPaths} reports a cache hit and returns `[]`,
 * and the next plain `add -A` silently drops the path again.
 *
 * Reproduced end to end in an isolated repository: capture `t0` without `.env`,
 * `git add -f .env`, capture `t1` containing it, restore `t0`, write new bytes into
 * `.env`, and the next capture comes back **equal to `t0`** — so the revert planner reads
 * the boundary as "nothing changed" and skips the segment, leaving the edit unrevertable
 * with no warning anywhere. The same workspace then fails `parkUncommittedWork`'s
 * coverage check permanently, with an error pointing at `.gitignore` that the user
 * cannot act on.
 *
 * So a read-tree counts as an invalidation event alongside a real-index write. Folding
 * the shadow index's own identity into the cache key was the alternative and is worse:
 * any capture that actually changes a file rewrites that index, so the memo would miss
 * on precisely the calls it exists to make cheap. Dropping the entry *before* running
 * the command is deliberate too — a failed `read-tree` may still have partially rewritten
 * the index, and the safe direction of a wrong guess is one extra `ls-files`.
 */
async function readTreeIntoShadowIndex(
	dir: string,
	worktreePath: string,
	treeHash: string,
): Promise<GitResult> {
	trackedIgnoredCache.delete(dir);
	return runGit(["read-tree", treeHash], dir, worktreePath);
}

/**
 * Locate the repository-level `info/exclude` that applies to a worktree.
 *
 * Every NarraFork chapter is a *linked* worktree under `.worktrees/`, where `.git`
 * is a file pointing at `<main>/.git/worktrees/<name>`. That per-worktree gitdir has
 * no `info/` at all: the repository-level exclude lives in the common dir, named by
 * the `commondir` file next to the pointer (relative to the gitdir, so it has to be
 * resolved against it). Reading `<gitdir>/info/exclude` therefore found nothing in
 * exactly the shape production runs, and the user's repo-level ignore rules were
 * silently never mirrored — so build output entered snapshots, and a rollback would
 * then delete files git itself considers ignored.
 *
 * Returns both candidates when they differ: git honours a per-worktree
 * `info/exclude` too when `extensions.worktreeConfig` is in play, and mirroring both
 * is strictly closer to git's own behaviour than picking one.
 */
function resolveRepoExcludeFiles(worktreePath: string): string[] {
	const dotGitPath = resolve(worktreePath, ".git");
	const candidates: string[] = [];
	try {
		const stat = statSync(dotGitPath);
		if (stat.isDirectory()) {
			candidates.push(resolve(dotGitPath, "info", "exclude"));
			return candidates;
		}
		if (!stat.isFile()) return candidates;
		const match = readFileSync(dotGitPath, "utf-8").match(/^gitdir:\s*(.+)$/m);
		if (!match) return candidates;
		const gitDir = resolve(worktreePath, match[1].trim());
		// The linked gitdir's own exclude, if this repo uses one.
		candidates.push(resolve(gitDir, "info", "exclude"));
		try {
			const commonRel = readFileSync(resolve(gitDir, "commondir"), "utf-8").trim();
			if (commonRel) {
				// `commondir` is relative to the gitdir (typically `../..`).
				candidates.push(resolve(gitDir, commonRel, "info", "exclude"));
			}
		} catch {
			// No commondir: this is a normal (non-linked) gitdir reached via a pointer
			// file, so its own info/exclude above is the repository-level one.
		}
	} catch {
		// No .git at all (plain directory) — only .gitignore rules apply.
	}
	return candidates;
}

/**
 * Mirror the worktree's ignore rules into the shadow repo.
 *
 * The shadow repo has its own `info/exclude` because it never sees the user's
 * `.git`. Without this, `git add -A` would capture build output and dependency
 * directories, making every snapshot enormous.
 *
 * Nested `.gitignore` files are deliberately *not* copied here. The shadow repo runs
 * every command with `--work-tree <worktree>`, so `git add -A` reads `.gitignore` at
 * each directory level straight from disk, with the correct per-directory scoping
 * that a flattened copy could not reproduce. Only the two sources that live inside
 * `.git` (repo-level exclude) or outside the tree (`core.excludesFile`) are
 * invisible to it and need mirroring.
 */
async function syncExcludes(dir: string, worktreePath: string): Promise<void> {
	const infoDir = resolve(dir, "info");
	mkdirSync(infoDir, { recursive: true });
	const parts: string[] = [];

	for (const excludePath of resolveRepoExcludeFiles(worktreePath)) {
		try {
			if (existsSync(excludePath)) parts.push(readFileSync(excludePath, "utf-8"));
		} catch {
			// Unreadable exclude file — the remaining sources still apply.
		}
	}

	// Read the global gitignore (core.excludesFile). Git checks, in order:
	// 1. The value of `core.excludesFile` from git config (global/system)
	// 2. $XDG_CONFIG_HOME/git/ignore (defaults to ~/.config/git/ignore)
	const globalIgnore = await resolveGlobalGitignore(worktreePath);
	if (globalIgnore) {
		try {
			parts.push(readFileSync(globalIgnore, "utf-8"));
		} catch {
			// File disappeared between resolution and read — graceful degradation.
		}
	}

	// Never snapshot the user's git metadata, and never snapshot the directory that
	// holds every *other* chapter's worktree.
	//
	// `/.worktrees/` is not a convenience: the root chapter's `worktreePath` is the
	// project's `gitPath` itself, so a capture of the root workspace descends into
	// `<gitPath>/.worktrees/<child>`. A linked worktree enters the shadow tree as a
	// `160000 commit` gitlink, which makes the child's whole directory a path in the
	// tree — and a rollback to a state predating that child then finds the path absent
	// from the target tree and takes it out with `rmSync(recursive)`, deleting a live
	// chapter's uncommitted work.
	//
	// Written here rather than relying on the user's `.gitignore` because that is a
	// file the user owns: the entry NarraFork adds on project create/update can fail
	// (the write is best-effort), an imported repository never had it, the user may
	// delete the line, and — worst of all — `.gitignore` is itself a snapshotted file,
	// so a rollback can remove the very rule protecting the rollback. A rule inside
	// the shadow repo's own `info/exclude` is outside all of that.
	//
	// Both the leading slash and the trailing slash are deliberate: anchored to the
	// workspace root so a legitimately-tracked `docs/.worktrees` elsewhere is
	// unaffected, and directory-only so a file literally named `.worktrees` is not
	// silently dropped.
	parts.push("/.git/\n");
	parts.push(`/${WORKTREES_DIR_NAME}/\n`);
	await Bun.write(resolve(infoDir, "exclude"), parts.join("\n"));
	await writeShadowAttributes(dir);
}

/**
 * Attributes forced on every path the shadow repository touches.
 *
 * The module's central promise is that a snapshot is *the bytes on disk*, and a
 * restore writes those bytes back. git's content filters break that promise, and the
 * way they break it is uniquely dangerous here: the corruption is invisible to the
 * engine's own consistency check. Measured on git 2.47 with a shadow repo attached
 * to a worktree via `--work-tree`:
 *
 *   - `* text=auto` in the *worktree's* `.gitattributes` applies, because attributes
 *     are read from the working tree. A CRLF file is stored as LF and written back as
 *     CRLF; a pure-LF file gets CRLF'd on the way out. Re-hashing afterwards yields
 *     the *same* tree, so the engine concludes the restore was exact while the file
 *     on disk has different bytes than it started with.
 *   - `core.autocrlf=true` inherited from the user's global config does the same to
 *     LF files even with no `.gitattributes` at all.
 *   - `filter=<name>` runs a clean/smudge filter, so a snapshot can store content
 *     that was never on disk.
 *   - `working-tree-encoding` is worse than lossy: `add -A` exits 128 outright when
 *     it cannot transcode, so the capture *fails* and the boundary is recorded as
 *     absent.
 *   - `ident` rewrites `$Id$`, which is a silent content change in both directions.
 *
 * `-text -filter -working-tree-encoding -ident` in `info/attributes` turns all of
 * that off. `info/attributes` is used rather than config because it out-ranks the
 * worktree's own `.gitattributes` in git's attribute precedence, which config cannot
 * do — a `.gitattributes` committed by the user would otherwise win.
 *
 * Verified not to cost anything the engine relies on: `merge-tree --write-tree` still
 * performs a line-level three-way merge under these attributes (only `-merge`/`-diff`
 * would force binary-style merging, so they are deliberately *not* set), and modes,
 * symlinks and the executable bit are tree metadata rather than attribute-driven.
 */
const SHADOW_ATTRIBUTES = "* -text -filter -working-tree-encoding -ident\n";

/**
 * Config forced onto every shadow-repo git invocation, via the environment.
 *
 * Belt to {@link SHADOW_ATTRIBUTES}' braces. `info/attributes` already neutralises
 * the attribute path, but `core.autocrlf` is a *config* knob, and the shadow repo
 * inherits the user's global and system config like any other repository. Passing it
 * per-invocation rather than writing it into the shadow repo's own config file means
 * a repository created by an older build is corrected the first time it is used,
 * without a migration step that has to find and rewrite every existing shadow repo.
 *
 * `GIT_CONFIG_COUNT` overrides all config files, so this also beats a `core.autocrlf`
 * set in the user's *system* config, which a repo-local setting would not.
 */
const SHADOW_CONFIG_ENTRIES: ReadonlyArray<readonly [key: string, value: string]> = [
	// Never translate line endings on the way in or out.
	["core.autocrlf", "false"],
	["core.eol", "lf"],
	// `safecrlf` only ever *rejects* content whose conversion would be irreversible;
	// with conversion disabled it has nothing to guard, and leaving it enabled would
	// turn an inherited `warn`/`true` into capture failures.
	["core.safecrlf", "false"],
	// A symlink must round-trip as a symlink. With `core.symlinks=false` (inheritable
	// on Windows) `checkout-index` writes a regular file containing the target path,
	// which is a different filesystem object than the one captured.
	["core.symlinks", "true"],
	// `add -A` must not be talked out of recording a file mode change.
	["core.fileMode", "true"],
	// Cache the untracked-directory scan in the index. On a large worktree the
	// untracked walk dominates a warm `add -A` (worst on Windows, where lstat and
	// antivirus scanning make it minutes rather than milliseconds), and the index
	// extension is what turns it back into an index read. This trusts directory
	// mtimes exactly the way the index's own stat cache already does for tracked
	// files, so it extends the existing trust model rather than adding a new one.
	//
	// Residual risk, kept deliberately: a file created within the same mtime tick
	// as the previous scan on a filesystem with coarse or lazily-updated mtimes
	// could be missed by one capture, and a rollback to that tree would then
	// delete the file via removePathNotInTree. git mitigates this with the same
	// racy-clean re-validation the index stat cache uses (entries at the tick
	// boundary are re-scanned rather than trusted), which is why this is on;
	// the knob to disable the whole scan path on a filesystem where it misbehaves
	// is `chapters.treeSnapshotsEnabled`.
	["core.untrackedCache", "true"],
	// Never let `add` trigger a spontaneous `gc --auto`. Shadow repositories are
	// repacked by gcAll() on a controlled maintenance path; an auto-gc firing in
	// the middle of a capture on a large object store is itself a multi-minute
	// stall (and on Windows spawns background children that outlive the timeout
	// kill that was supposed to bound the capture).
	["gc.auto", "0"],
];

/**
 * The above, in the numbered form git reads from the environment.
 *
 * Derived rather than written out, because `GIT_CONFIG_COUNT` and the `KEY_n`/`VALUE_n`
 * slots are one invariant expressed in two places: git exits 128 outright when the count
 * names a slot that is not set, so a hardcoded `"5"` turns "someone appended an entry
 * and did not also bump the literal" into every shadow-repo git call failing — which
 * `tryCapture` swallows into a null boundary, i.e. the whole workspace silently losing
 * precise reverts. Counting the array cannot disagree with the array.
 */
const SHADOW_CONFIG_ENV: Record<string, string> = Object.fromEntries([
	["GIT_CONFIG_COUNT", String(SHADOW_CONFIG_ENTRIES.length)],
	...SHADOW_CONFIG_ENTRIES.flatMap(([key, value], index) => [
		[`GIT_CONFIG_KEY_${index}`, key],
		[`GIT_CONFIG_VALUE_${index}`, value],
	]),
]);

/**
 * Write the forced attributes, creating `info/` if needed.
 *
 * Called from both {@link syncExcludes} paths on purpose. A shadow repository created
 * by an earlier build has an `info/exclude` but no `info/attributes`, and the
 * exclude's mtime cache would otherwise keep the file from ever being written — the
 * repo would stay byte-inexact for its whole life. Writing it alongside the exclude
 * means the same staleness trigger repairs both, and a first-time create gets it too.
 */
async function writeShadowAttributes(dir: string): Promise<void> {
	const attributesPath = resolve(dir, "info", "attributes");
	try {
		// Skipped when already correct: this sits behind the exclude staleness check,
		// which fires whenever the user edits any ignore source, and rewriting an
		// identical file would put a pointless write on the tool-execution path.
		if (existsSync(attributesPath) && readFileSync(attributesPath, "utf-8") === SHADOW_ATTRIBUTES) {
			return;
		}
	} catch {
		// Unreadable — fall through and overwrite it.
	}
	await Bun.write(attributesPath, SHADOW_ATTRIBUTES);
}

/**
 * Whether a directory is the root of a git worktree (or repository).
 *
 * The second line of defence for the deletion loops. `.git` present as either a file
 * (a linked worktree's pointer) or a directory (a nested clone) means the directory
 * belongs to a different repository, whose uncommitted contents this module has no
 * snapshot of and therefore cannot restore. Excluding `/.worktrees/` already keeps
 * NarraFork's own chapters out; this also covers a nested repository somewhere else
 * in the tree, and a worktree that predates the exclude rule and is still recorded
 * inside an old snapshot.
 */
function isWorktreeRoot(absolutePath: string): boolean {
	try {
		return existsSync(resolve(absolutePath, ".git"));
	} catch {
		return false;
	}
}

/**
 * Delete a path a target tree does not contain, refusing to take another
 * repository's worktree with it.
 *
 * Returns whether the path was removed; a refusal is logged, because "the rollback
 * did not fully apply" is something the caller's own tree comparison will notice and
 * a silent skip would make that comparison inexplicable.
 */
function removePathNotInTree(worktreePath: string, absolute: string): boolean {
	if (isWorktreeRoot(absolute)) {
		logger.warn("Refusing to delete a nested git worktree during a snapshot rollback", {
			worktreePath,
			nestedWorktree: absolute,
		});
		return false;
	}
	rmSync(absolute, { force: true, recursive: true });
	return true;
}

/**
 * Re-sync ignore rules only when a mirrored source changed.
 *
 * Only the mirrored sources belong in this key. Nested `.gitignore` files are read
 * from disk by git on every `add -A`, so they need no re-sync and stat'ing them all
 * would put a recursive directory walk on the tool-execution path.
 */
async function syncExcludesIfStale(dir: string, worktreePath: string): Promise<void> {
	const gitignorePath = resolve(worktreePath, ".gitignore");
	let localMtime = 0;
	try {
		if (existsSync(gitignorePath)) localMtime = statSync(gitignorePath).mtimeMs;
	} catch {
		// Unreadable .gitignore — fall through and reuse whatever we have.
	}

	// The repo-level exclude is mirrored, so editing it has to invalidate the copy;
	// otherwise a newly ignored build directory keeps entering snapshots until the
	// process restarts. Two or three stat calls, no directory walk.
	let repoExcludeMtime = 0;
	for (const excludePath of resolveRepoExcludeFiles(worktreePath)) {
		try {
			repoExcludeMtime += statSync(excludePath).mtimeMs;
		} catch {
			// Absent or unreadable — contributes nothing, and its later appearance
			// changes the sum.
		}
	}

	// Include global gitignore mtime in staleness check. Cache the resolved path
	// per worktree to avoid running `git config` on every snapshot.
	let globalMtime = 0;
	const cached = globalIgnoreCache.get(dir);
	if (!cached) {
		const resolved = await resolveGlobalGitignore(worktreePath);
		let mtime = 0;
		if (resolved) {
			try {
				mtime = statSync(resolved).mtimeMs;
			} catch {
				// Gone between resolve and stat — treat as absent.
			}
		}
		globalIgnoreCache.set(dir, { path: resolved, mtime });
		globalMtime = mtime;
	} else if (cached.path) {
		try {
			globalMtime = statSync(cached.path).mtimeMs;
			if (globalMtime !== cached.mtime) {
				cached.mtime = globalMtime;
			}
		} catch {
			// File removed — re-resolve next time
			globalIgnoreCache.delete(dir);
		}
	}

	// Combine every mirrored source's mtime into a single cache key for the shadow dir
	const combinedKey = `${localMtime}:${globalMtime}:${repoExcludeMtime}`;
	if (excludeMtimes.get(dir) === combinedKey) return;
	await syncExcludes(dir, worktreePath);
	excludeMtimes.set(dir, combinedKey);
}

/** Create the shadow bare repo if absent. */
async function ensureShadowRepo(dir: string, worktreePath: string): Promise<void> {
	if (existsSync(resolve(dir, "HEAD"))) {
		await syncExcludesIfStale(dir, worktreePath);
		return;
	}
	mkdirSync(dir, { recursive: true });
	// `git init --bare` rejects --work-tree, so this cannot go through runGit.
	const result = await safeSpawn({
		cmd: ["git", "init", "--bare", dir],
		timeout: GIT_TIMEOUT_MS,
		maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
	});
	if (result.exitCode !== 0) {
		// Remove the half-created directory so it is not mistaken for a valid repo.
		rmSync(dir, { recursive: true, force: true });
		throw new TreeSnapshotError(`shadow repo init failed: ${result.stderr.trim()}`);
	}
	await syncExcludes(dir, worktreePath);
	excludeMtimes.delete(dir);
}

/**
 * Whether the local git supports `merge-tree --write-tree` (git >= 2.38).
 *
 * Cached because it cannot change while the process runs, and the scoped-revert
 * preview would otherwise probe it on every request. `null` means "not probed
 * yet"; the probe itself never throws so a missing git degrades to "unsupported"
 * rather than breaking the caller.
 */
let mergeTreeSupported: boolean | null = null;

/**
 * The probe's argv, exactly. **No flag may be added to this array.**
 *
 * git only takes the "print usage and exit" shortcut when `-h` is the *sole*
 * argument (`git.c`: `help = argc == 2 && !strcmp(argv[1], "-h")`), which is also
 * what demotes merge-tree's RUN_SETUP to RUN_SETUP_GENTLY. With `--write-tree -h`
 * the argc check fails, so git insists on finding a repository first and dies with
 * "fatal: not a git repository" before printing anything — the probe then reads a
 * modern git as unsupported and caches that for the process lifetime, permanently
 * losing merge preview / scoped revert. Invisible in development (cwd is this
 * repo) and fatal for a binary launched from anywhere else.
 *
 * Exported so a test can pin the shape; that assertion is the only thing standing
 * between this comment and a well-meant "let's probe the actual flag" edit.
 */
export const MERGE_TREE_PROBE_ARGV: readonly string[] = ["git", "merge-tree", "-h"];

export async function supportsMergeTree(): Promise<boolean> {
	if (mergeTreeSupported !== null) return mergeTreeSupported;
	try {
		const result = await safeSpawn({
			cmd: [...MERGE_TREE_PROBE_ARGV],
			// Still pin a cwd that exists: an unset cwd inherits the process's, which may
			// have been removed under a long-running server.
			cwd: tmpdir(),
			timeout: GIT_TIMEOUT_MS,
			maxOutputBytes: 8192,
		});
		// `-h` exits non-zero by design; an unknown option is reported in the usage
		// text, so the flag's presence is what decides support.
		mergeTreeSupported = `${result.stdout}${result.stderr}`.includes("--write-tree");
	} catch {
		mergeTreeSupported = false;
	}
	return mergeTreeSupported;
}

/** Test-only: drop the cached probe result so a fresh probe runs. */
export function resetMergeTreeSupportCacheForTests(): void {
	mergeTreeSupported = null;
}

/**
 * Test-only: drop hot-path warm-up/cooldown state.
 *
 * Clearing the in-flight map does not cancel a capture that is actually running —
 * it only detaches the bookkeeping, so tests must use worktrees whose captures
 * complete on their own (any tmp repo qualifies).
 */
export function resetHotPathCaptureStateForTests(): void {
	warmupInFlight.clear();
	warmupCooldownUntil.clear();
}

/** Result of a three-way tree merge. */
export interface TreeMergeResult {
	/**
	 * The merged tree. Written to the object store even when conflicts exist, but
	 * a conflicted tree must never be checked out: it contains conflict markers.
	 */
	tree: string;
	/** Paths git could not merge automatically. Empty on a clean merge. */
	conflicts: string[];
}

/**
 * One recorded pre/post workspace boundary to reverse.
 *
 * `before`/`after` are tree hashes of real bytes, so `after === before` of the
 * next pair proves nothing else wrote in between — that is what lets consecutive
 * pairs be collapsed while a gap forces a separate segment.
 *
 * `ownedPaths` narrows the reversal to the paths the recorded call is attributable
 * for. It is needed because the hashes cover the *whole* worktree: in a shared
 * directory the span between them also contains writes from other narrators,
 * terminals and build scripts, and reversing the full span would discard them.
 * null means the range is unknown (a row recorded before owned sets existed), in
 * which case the whole-tree behaviour is kept.
 */
export interface TreeBoundaryPair {
	before: string;
	after: string;
	ownedPaths?: string[] | null;
}

/** A maximal run of boundary pairs with no foreign write between them. */
export interface TreeRevertSegment {
	/** Start state of the run — what this segment is merged back toward. */
	before: string;
	/** End state of the run — the merge base for this segment. */
	after: string;
	/**
	 * Union of the collapsed pairs' owned paths, or null when any of them was
	 * unknown. null keeps the legacy whole-tree reversal for that segment.
	 */
	ownedPaths: string[] | null;
}

/**
 * Collapse boundary pairs into the fewest segments that are safe to reverse.
 *
 * Two adjacent pairs may only be merged into one span when the earlier `after`
 * equals the later `before`. A mismatch means some other actor (another narrator,
 * a subagent, the user's editor) wrote to the worktree in between; spanning across
 * that gap would put the foreign change inside the range being reversed and
 * discard it. Splitting there keeps each segment describing this actor's bytes
 * only.
 *
 * Pairs where `before === after` are skipped: the call changed nothing on disk, so
 * it neither needs reversing nor may act as an anchor.
 *
 * Owned paths are unioned across a collapsed run, since the resulting span covers
 * every one of those calls. A single unknown range poisons the union to null: the
 * span then has to be reversed whole, because there is no statement of which paths
 * inside it belonged to the actor.
 */
export function planTreeRevertSegments(pairs: TreeBoundaryPair[]): TreeRevertSegment[] {
	const segments: TreeRevertSegment[] = [];
	for (const pair of pairs) {
		if (pair.before === pair.after) continue;
		const owned = pair.ownedPaths === undefined ? null : pair.ownedPaths;
		const open = segments[segments.length - 1];
		if (open && open.after === pair.before) {
			open.after = pair.after;
			open.ownedPaths =
				open.ownedPaths === null || owned === null
					? null
					: [...new Set([...open.ownedPaths, ...owned])];
			continue;
		}
		segments.push({
			before: pair.before,
			after: pair.after,
			ownedPaths: owned === null ? null : [...new Set(owned)],
		});
	}
	return segments;
}

/**
 * Whether a chapter still depends on this shadow repository.
 *
 * Keyed on `chapters.snapshotShadowKey` rather than `worktreePath`, because the
 * situation this protects against is precisely the one where `worktreePath` has
 * already been nulled (a dormant chapter) while the lineage is still wanted.
 *
 * Errs on the side of keeping data: a database error answers "claimed", so a
 * transient failure costs some disk rather than a chapter's snapshot history.
 */
async function isShadowRepoClaimed(deviceId: string, worktreePath: string): Promise<boolean> {
	const key = treeSnapshotKey(deviceId, worktreePath);
	try {
		const claimed = await db.query.chapters.findFirst({
			where: eq(chapters.snapshotShadowKey, key),
			columns: { id: true },
		});
		if (claimed != null) return true;
		// `snapshotShadowKey` is only written once something advances the lineage, so a
		// chapter that has never run a file-mutating tool has it NULL and would be read
		// as unclaimed — the very chapter whose *first* snapshot this repository is about
		// to become. The live `worktreePath` answers that case; it is checked second
		// because it is precisely what a dormant chapter lacks, which is why the key
		// exists at all. Together the two cover both shapes.
		//
		// Both the raw and the normalized spelling are tried, because `worktreePath` is
		// stored as the caller handed it over rather than normalized — a keeping-data
		// question should not turn on which spelling a row happens to hold.
		const normalized = normalizePathForComparison(worktreePath);
		const candidates = normalized === worktreePath ? [worktreePath] : [worktreePath, normalized];
		const byPath = await db.query.chapters.findFirst({
			where: inArray(chapters.worktreePath, candidates),
			columns: { id: true },
		});
		return byPath != null;
	} catch (error) {
		logger.warn("Could not verify tree-snapshot ownership; keeping the repository", {
			worktreePath,
			error: String(error),
		});
		return true;
	}
}

async function recordTreeHash(
	deviceId: string,
	worktreePath: string,
	treeHash: string,
): Promise<void> {
	await db
		.insert(worktreeTreeSnapshots)
		.values({
			id: generateId(),
			deviceId,
			worktreePath: normalizePathForComparison(worktreePath),
			treeHash,
			createdAt: new Date().toISOString(),
		})
		.onConflictDoNothing();
}

/**
 * Run a three-way tree merge without taking the shadow lock.
 *
 * `--no-messages -z` yields the most stable shape to parse: the merged tree hash,
 * then one NUL-terminated path per conflicted file. Without `-z` the paths are
 * newline-separated (unsafe for paths containing newlines) and the human-readable
 * message block is locale-dependent.
 *
 * `base` may be null, which omits `--merge-base` and lets git find the merge base
 * itself by walking the commits' ancestry. That only works for *commits*: bare
 * trees have no ancestry, so the rollback path always passes an explicit base while
 * the snapshot-DAG path relies on git's own computation. Getting this base wrong is
 * what produces spurious conflicts, so deferring to git is strictly safer wherever
 * a real DAG exists.
 *
 * Exit 0 means a clean merge, 1 means conflicts, anything else is a real failure.
 */
async function mergeTreeUnlocked(
	dir: string,
	worktreePath: string,
	base: string | null,
	ours: string,
	theirs: string,
): Promise<TreeMergeResult> {
	if (!(await supportsMergeTree())) {
		throw new TreeSnapshotError(
			"git merge-tree --write-tree is unavailable (requires git >= 2.38)",
		);
	}
	const result = await runGitRaw(
		[
			"merge-tree",
			"--write-tree",
			"--name-only",
			"--no-messages",
			"-z",
			...(base === null ? [] : [`--merge-base=${base}`]),
			ours,
			theirs,
		],
		dir,
		worktreePath,
	);
	if (result.exitCode !== 0 && result.exitCode !== 1) {
		throw new TreeSnapshotError(`snapshot merge-tree failed: ${result.stderr.trim()}`);
	}
	if (result.stdoutTruncated) {
		throw new TreeSnapshotError("snapshot merge-tree output exceeded the size limit");
	}
	const parts = result.stdout.split("\0").filter(Boolean);
	const tree = parts[0];
	if (!tree) {
		throw new TreeSnapshotError("snapshot merge-tree returned no tree");
	}
	return { tree, conflicts: parts.slice(1) };
}

/** Outcome of reversing a set of segments out of the current workspace state. */
export interface SegmentReversalPlan {
	/** Workspace state the reversal was computed from. */
	currentTree: string;
	/** Tree that results from reversing every segment. Equals `currentTree` when nothing changed. */
	mergedTree: string;
	/** Paths git could not merge automatically; non-empty means the plan is not applicable. */
	conflicts: string[];
	/** Paths that differ between `currentTree` and `mergedTree`. */
	changedPaths: string[];
}

/**
 * Split arguments into invocations bounded by both count and byte size.
 *
 * A single git call carrying thousands of paths risks exceeding the platform's
 * `ARG_MAX`, which surfaces as a spawn error rather than a git error and would be
 * read as "the snapshot failed".
 */
function* batchArgs(values: string[]): Generator<string[]> {
	let batch: string[] = [];
	let bytes = 0;
	for (const value of values) {
		const size = Buffer.byteLength(value, "utf-8") + 1;
		if (
			batch.length > 0 &&
			(batch.length >= UPDATE_INDEX_BATCH_PATHS || bytes + size > UPDATE_INDEX_BATCH_BYTES)
		) {
			yield batch;
			batch = [];
			bytes = 0;
		}
		batch.push(value);
		bytes += size;
	}
	if (batch.length > 0) yield batch;
}

/** One entry of a tree, as `ls-tree -z` reports it. */
interface TreeEntry {
	mode: string;
	objectId: string;
	path: string;
}

/**
 * Read specific paths out of a tree.
 *
 * `ls-tree` is given the paths explicitly rather than filtered afterwards, so the
 * cost is proportional to the requested set instead of the tree size. Paths absent
 * from the tree simply do not come back, which is how a deletion is detected.
 */
async function readTreeEntries(
	dir: string,
	worktreePath: string,
	treeHash: string,
	paths: string[],
): Promise<Map<string, TreeEntry>> {
	const entries = new Map<string, TreeEntry>();
	if (paths.length === 0) return entries;
	// Batched for the same reason the index writes are: a few thousand paths in one
	// argv can exceed the platform's ARG_MAX, which fails the spawn rather than git.
	for (const batch of batchArgs(paths)) {
		const result = await runGitRaw(
			["ls-tree", "-r", "-z", treeHash, "--", ...batch],
			dir,
			worktreePath,
			{ maxOutputBytes: GIT_MAX_LISTING_BYTES },
		);
		if (result.exitCode !== 0) {
			throw new TreeSnapshotError(`snapshot ls-tree failed: ${result.stderr.trim()}`);
		}
		if (result.stdoutTruncated) {
			throw new TreeSnapshotError("snapshot ls-tree output exceeded the size limit");
		}
		for (const record of result.stdout.split("\0").filter(Boolean)) {
			// `<mode> SP <type> SP <object> TAB <path>` — the tab is what separates the
			// path, which is why the path itself may contain spaces safely.
			const tabIndex = record.indexOf("\t");
			if (tabIndex < 0) continue;
			const meta = record.slice(0, tabIndex).split(" ");
			const path = record.slice(tabIndex + 1);
			if (meta.length < 3) continue;
			entries.set(path, { mode: meta[0], objectId: meta[2], path });
		}
	}
	return entries;
}

/**
 * Which of `paths` exist as blobs in a tree.
 *
 * Deliberately not "list the tree and intersect": a full `ls-tree -r` on a large
 * repository produces megabytes of path names, which is both wasted work and — once
 * it passed the captured-output cap — turned every rollback in a big repository into
 * a hard failure. Asking about the requested paths makes the cost proportional to
 * the change set instead of the repository.
 *
 * `-r` matters even with explicit paths: without it, a path that is a *directory* in
 * the target tree comes back as a tree entry, and a path nested under a directory
 * that changed shape would be missed.
 */
async function pathsPresentInTree(
	dir: string,
	worktreePath: string,
	treeHash: string,
	paths: string[],
): Promise<Set<string>> {
	const present = new Set<string>();
	if (paths.length === 0) return present;
	for (const batch of batchArgs(paths)) {
		const result = await runGitPaths(
			["ls-tree", "-r", "--name-only", "-z", treeHash, "--", ...batch],
			dir,
			worktreePath,
			{ maxOutputBytes: GIT_MAX_LISTING_BYTES },
		);
		if (result.exitCode !== 0) {
			throw new TreeSnapshotError(`restore ls-tree failed: ${result.stderr}`);
		}
		for (const path of result.paths) present.add(path);
	}
	return present;
}

/**
 * Produce a tree equal to `baseTree` except that `paths` take their state from
 * `sourceTree`.
 *
 * This is what confines a reversal to one actor's changes. A whole-tree merge
 * result cannot be adopted directly in a shared worktree: it also carries back the
 * paths other actors changed in the same window. Rebuilding the index from
 * `baseTree` and overwriting only the owned paths keeps everything else exactly as
 * it is on disk now.
 *
 * Modes are copied from the source entry, so an executable bit or a symlink
 * round-trips. A path missing from `sourceTree` is removed, which is how "this
 * file did not exist before the call" is expressed.
 */
async function adoptPathsUnlocked(
	dir: string,
	worktreePath: string,
	baseTree: string,
	sourceTree: string,
	paths: string[],
): Promise<string> {
	if (paths.length === 0) return baseTree;
	const readTree = await readTreeIntoShadowIndex(dir, worktreePath, baseTree);
	if (readTree.exitCode !== 0) {
		throw new TreeSnapshotError(`adopt read-tree failed: ${readTree.stderr}`);
	}
	const sourceEntries = await readTreeEntries(dir, worktreePath, sourceTree, paths);

	// Adds and removals are two different `update-index` modes, so they are
	// partitioned and each mode is issued in batches. One spawn per path meant a
	// 300-path owned set cost 300 child processes while holding the shadow lock,
	// blocking every other capture on this worktree for the duration.
	const additions: string[] = [];
	const removals: string[] = [];
	for (const path of paths) {
		const entry = sourceEntries.get(path);
		if (entry) additions.push(`${entry.mode},${entry.objectId},${path}`);
		else removals.push(path);
	}
	if (paths.length >= SLOW_PATH_COUNT) {
		logger.warn("Adopting a very large owned path set into a snapshot", {
			worktreePath,
			pathCount: paths.length,
		});
	}
	// Removals go first, and the order is load-bearing rather than cosmetic. A path
	// can be a file in one tree and a directory in the other (`foo` becoming
	// `foo/x.txt` or the reverse), and git's index cannot hold both at once: adding
	// `foo` as a blob while `foo/x.txt` is still indexed fails with "looks like both a
	// file and a directory". Clearing the stale side first is what makes either
	// direction of that transition adoptable.
	for (const batch of batchArgs(removals)) {
		// `--` terminates options, so a path starting with `-` stays a path.
		const updated = await runGit(
			["update-index", "--force-remove", "--", ...batch],
			dir,
			worktreePath,
		);
		if (updated.exitCode !== 0) {
			throw new TreeSnapshotError(`adopt update-index failed: ${updated.stderr}`);
		}
	}
	// `--cacheinfo <mode>,<oid>,<path>` is the comma form on purpose: the path is
	// part of one argument, so a path starting with `-` cannot be read as an option.
	for (const batch of batchArgs(additions)) {
		const args = ["update-index", "--add"];
		for (const spec of batch) args.push("--cacheinfo", spec);
		const updated = await runGit(args, dir, worktreePath);
		if (updated.exitCode !== 0) {
			throw new TreeSnapshotError(`adopt update-index failed: ${updated.stderr}`);
		}
	}
	const written = await runGit(["write-tree"], dir, worktreePath);
	if (written.exitCode !== 0 || !written.stdout) {
		throw new TreeSnapshotError(`adopt write-tree failed: ${written.stderr}`);
	}
	return written.stdout;
}

/**
 * Reverse each segment out of the current state, newest segment first, without
 * touching the worktree.
 *
 * Reversing is a three-way merge per segment with `base = segment.after`,
 * `ours = the state accumulated so far` and `theirs = segment.before`: git keeps
 * `ours` wherever `base` and `theirs` agree, so only the bytes that segment
 * introduced are rolled back. The merge is what allows two actors to have edited
 * the same file in non-overlapping regions and still have both survive.
 *
 * When the segment states which paths it owns, only those are adopted from the
 * merge result. The merge is computed over the whole tree, so without this step a
 * shared worktree would have another actor's concurrent writes reversed along with
 * the segment — the boundary hashes cannot distinguish them. Conflicts outside the
 * owned set are likewise not this reversal's problem.
 *
 * Segments are applied newest first so each merge base is the state that segment
 * actually produced, and the intermediate trees are chained in memory — the
 * worktree is written at most once, by the caller.
 *
 * A conflict inside the owned set aborts the chain: it means another actor's change
 * overlaps the very region being reversed, and a conflicted tree carries conflict
 * markers that must never reach the working tree.
 */
async function planSegmentReversalUnlocked(
	dir: string,
	worktreePath: string,
	currentTree: string,
	segments: TreeRevertSegment[],
): Promise<SegmentReversalPlan> {
	let accumulated = currentTree;
	for (const segment of [...segments].reverse()) {
		const merged = await mergeTreeUnlocked(
			dir,
			worktreePath,
			segment.after,
			accumulated,
			segment.before,
		);
		const owned = segment.ownedPaths;
		// Membership goes through a Set rather than `Array.includes`: both sides scale
		// with the change set, so a conflicted merge in a large window was O(n·m) — a
		// few thousand owned paths against a few thousand conflicts is millions of
		// string comparisons on the rollback path. The truthiness test is kept exactly
		// as it was: only null/undefined mean "unknown range, reverse the whole tree",
		// while an empty array remains a positive "owns nothing" and must still filter
		// every conflict away.
		const ownedLookup = owned ? new Set(owned) : null;
		const conflicts = ownedLookup
			? merged.conflicts.filter((path) => ownedLookup.has(path))
			: merged.conflicts;
		if (conflicts.length > 0) {
			return {
				currentTree,
				mergedTree: accumulated,
				conflicts,
				changedPaths: [],
			};
		}
		if (!owned) {
			accumulated = merged.tree;
		} else if (owned.length > 0) {
			// A conflicted merge tree is only safe to read at the paths that merged
			// cleanly, and every owned path did (checked above).
			accumulated = await adoptPathsUnlocked(dir, worktreePath, accumulated, merged.tree, owned);
		}
	}

	if (accumulated === currentTree) {
		return { currentTree, mergedTree: accumulated, conflicts: [], changedPaths: [] };
	}
	const changed = await runGitPaths(
		["diff-tree", "-r", "--name-only", "--no-commit-id", "-z", accumulated, currentTree],
		dir,
		worktreePath,
		{ maxOutputBytes: GIT_MAX_LISTING_BYTES },
	);
	if (changed.exitCode !== 0) {
		throw new TreeSnapshotError(`snapshot diff-tree failed: ${changed.stderr}`);
	}
	return {
		currentTree,
		mergedTree: accumulated,
		conflicts: [],
		changedPaths: changed.paths,
	};
}

/**
 * Report a capture whose `add -A` cost stands out, at most once a minute per repo.
 *
 * Throttled per shadow repo *and* severity so that a worktree crossing from "slow"
 * into "timed out" is always reported immediately rather than being swallowed by the
 * window a slow-capture warning just opened.
 */
function reportCaptureCost(
	worktreePath: string,
	dir: string,
	elapsed: number,
	ok: boolean,
	timeoutMs: number = GIT_TIMEOUT_MS,
): void {
	if (ok && elapsed < SLOW_CAPTURE_WARN_MS) return;
	const key = `${dir}\u0000${ok ? "slow" : "failed"}`;
	const now = Date.now();
	const last = captureWarnedAt.get(key) ?? 0;
	if (now - last < SLOW_CAPTURE_WARN_INTERVAL_MS) return;
	captureWarnedAt.set(key, now);
	if (ok) {
		logger.warn("Workspace snapshot scan is slow", {
			worktreePath,
			elapsedMs: elapsed,
			timeoutMs,
		});
		return;
	}
	// A failed capture is what actually costs revert precision, so it is reported
	// even when it failed quickly (a stale lock, a vanished worktree).
	logger.warn("Workspace snapshot scan did not complete", {
		worktreePath,
		elapsedMs: elapsed,
		timeoutMs,
		timedOut: elapsed >= timeoutMs,
	});
}

/**
 * Capture the worktree without taking the shadow lock.
 *
 * `AsyncMutex` is not reentrant — `acquire` always queues behind the current
 * tail — so a composite operation that already holds the lock must call this
 * instead of {@link worktreeTreeSnapshot.capture}, which would deadlock.
 *
 * ## Why the whole-tree `add -A` is kept on the hot path
 *
 * This runs before and after every file-mutating tool, and `add -A` walks the
 * worktree, so on a huge repository or a cold filesystem it can approach
 * {@link GIT_TIMEOUT_MS}. That cost is accepted rather than avoided by skipping
 * captures, because the two are not comparable in kind:
 *
 *   - The cost is bounded and self-limiting. The shadow repo keeps its index
 *     between captures, so only changed paths are re-hashed; a warm capture is
 *     milliseconds, and the expensive walk is the first one after a cold start.
 *   - Skipping is unbounded in consequence. A skipped capture records a null
 *     boundary, which sends a rollback to the per-file replay path — and replay
 *     only knows Write/Edit tool inputs, so a Bash command's, build script's or
 *     external editor's writes in that window become unrevertable. Trading a
 *     few seconds for silently losing the ability to undo is the wrong trade on a
 *     data-safety path.
 *
 * A timeout is handled safely: `safeSpawn` kills the child and reports a non-zero
 * exit (it does not throw), this throws {@link TreeSnapshotError}, and `tryCapture`
 * turns that into null so the tool itself is unaffected and the boundary is simply
 * recorded as absent. Slow filesystems are therefore an observability problem, which
 * is what {@link reportCaptureCost} addresses.
 *
 * The residue a kill leaves behind is *not* self-healing, contrary to what this
 * comment used to claim. git removes its own `index.lock` on `SIGTERM` because it
 * installs a signal handler for it — but not on `SIGKILL` or an OOM kill, where no
 * userspace code runs at all. The lock then survives forever, every subsequent
 * `add -A` in that shadow repo exits 128, `tryCapture` returns null every time, and
 * the whole workspace silently and permanently degrades to per-file replay. That is
 * why {@link recoverStaleIndexLock} exists.
 */
async function captureUnlocked(
	dir: string,
	worktreePath: string,
	deviceId: string,
	opts?: { gitTimeoutMs?: number; signal?: AbortSignal },
): Promise<string> {
	await ensureShadowRepo(dir, worktreePath);
	const startedAt = Date.now();
	let added = await addAllUnlocked(dir, worktreePath, opts?.gitTimeoutMs, opts?.signal);
	// A stale lock is indistinguishable from a live one by exit code alone, so the
	// retry is gated on the lock file's own age. Done here rather than in `ensure`
	// because the lock can also appear *between* two captures.
	if (added.exitCode !== 0 && recoverStaleIndexLock(dir, worktreePath, added.stderr)) {
		added = await addAllUnlocked(dir, worktreePath, opts?.gitTimeoutMs, opts?.signal);
	}
	reportCaptureCost(
		worktreePath,
		dir,
		Date.now() - startedAt,
		added.exitCode === 0,
		opts?.gitTimeoutMs,
	);
	if (added.exitCode !== 0) {
		throw new TreeSnapshotError(`snapshot add failed: ${added.stderr}`);
	}
	const written = await runGit(["write-tree"], dir, worktreePath, opts?.gitTimeoutMs, opts?.signal);
	if (written.exitCode !== 0 || !written.stdout) {
		throw new TreeSnapshotError(`snapshot write-tree failed: ${written.stderr}`);
	}
	const treeHash = written.stdout;
	await recordTreeHash(deviceId, worktreePath, treeHash);
	return treeHash;
}

/**
 * Stage every path that belongs in a snapshot.
 *
 * Two steps, because `add -A` alone has a blind spot that costs data. It honours the
 * shadow repo's mirrored ignore rules, and a file the *real* repository tracks
 * despite an ignore rule — `git add -f .env` with `.env` in `.gitignore`, a checked-in
 * `dist/` artefact — is therefore absent from every snapshot. Measured consequence:
 * a tool rewrites `.env`, the before and after boundary hashes come out *identical*
 * because neither contains the file, the revert planner sees `before === after` and
 * skips the segment as a no-op, and the modification is unrevertable with no warning
 * anywhere. The engine's own comment at `mergeTreesWithBase` already noted that the
 * shadow and the real repo disagree about such files; that disagreement is fixed
 * here, at the capture, rather than only warned about downstream.
 *
 * The fix is `--force` on exactly the paths the real repository tracks *and* the
 * shadow repo would exclude. Alternatives that were rejected:
 *
 *   - `!` negation lines in `info/exclude`: measured not to work. The worktree's own
 *     `.gitignore` out-ranks `info/exclude` in git's precedence, so a rule in
 *     `.gitignore` wins and the file stays excluded.
 *   - Force-adding the *whole* tracked set: correct but pointless. Non-ignored
 *     tracked files are already staged by `add -A`, so it is thousands of redundant
 *     argv bytes on a hot path.
 *   - Dropping the exclude mirroring entirely: that is what put `node_modules/` into
 *     snapshots and made a rollback delete files git itself ignores.
 *
 * `ls-files -i -c --exclude-standard` asks the real repository the question directly
 * and answers in ~20 ms on a 5 000-file repo, against a 12 ms warm `add -A`. The set
 * is empty in a normal repository, in which case no second git call runs at all.
 *
 * Deletions need no special handling: once a path is in the shadow index, a plain
 * `add -A` records its removal (verified), so the force-add is only ever needed to
 * *introduce* an entry.
 */
async function addAllUnlocked(
	dir: string,
	worktreePath: string,
	gitTimeoutMs?: number,
	signal?: AbortSignal,
): Promise<GitResult> {
	let added = await runGit(["add", "-A"], dir, worktreePath, gitTimeoutMs, signal);
	if (added.exitCode !== 0) {
		const partial = await addAllIgnoringUnreadable(dir, worktreePath, added, gitTimeoutMs, signal);
		if (!partial) return added;
		added = partial;
	}

	const forced = await trackedButIgnoredPaths(dir, worktreePath);
	if (forced.length === 0) return added;

	for (const batch of batchArgs(forced)) {
		// `--force` overrides the exclude rules for these paths only. `--ignore-errors`
		// keeps one unreadable file from failing the batch, and the missing-pathspec case
		// is handled by filtering to paths that exist: git aborts the *entire* `add` with
		// exit 128 on a pathspec that matches nothing, so a file deleted between the
		// `ls-files` and this call would otherwise cost the whole capture.
		const result = await runGit(
			["add", "-A", "--force", "--ignore-errors", "--", ...batch],
			dir,
			worktreePath,
			gitTimeoutMs,
			signal,
		);
		// Reported rather than fatal. The plain `add -A` already succeeded, so a tree
		// missing these paths is still the pre-existing behaviour and strictly better
		// than no snapshot at all — but it is a real loss of revert precision, so it
		// must not be silent.
		if (result.exitCode !== 0) {
			logger.warn("Could not snapshot tracked-but-ignored paths", {
				worktreePath,
				pathCount: batch.length,
				stderr: result.stderr.slice(0, 500),
			});
		}
	}
	return added;
}

/**
 * Retry a failed `add -A` with `--ignore-errors`, for a worktree containing a file
 * git cannot read.
 *
 * A plain `add -A` treats one unreadable path as fatal: it exits 128 and stages
 * *nothing*, so a single `chmod 000` file — a fixture, a root-owned artefact a
 * container wrote, a Windows file another process holds open — cost the capture
 * outright and every boundary in that workspace with it. The whole repository became
 * unrevertable because of one file.
 *
 * `--ignore-errors` skips just the unreadable paths and exits 1, having staged
 * everything else. That is a *partial* snapshot, which is why it is not the default:
 * a tree that silently omits paths would let a rollback delete a file it never
 * recorded. It is safe as a fallback because of what it omits — a path already in the
 * index keeps its previous entry (verified), so the omission is "this one file's
 * latest bytes are missing" rather than "this file does not exist", and the rollback
 * comparison sees no change for it instead of a deletion.
 *
 * Only accepted for exit 1, which is `--ignore-errors`' specific "some paths were
 * skipped" code. Any other failure (a vanished worktree, a stale lock, a timeout) is
 * a different problem and must keep failing the capture.
 *
 * Returns null when the retry did not help, so the caller reports the original error.
 */
async function addAllIgnoringUnreadable(
	dir: string,
	worktreePath: string,
	original: GitResult,
	gitTimeoutMs?: number,
	signal?: AbortSignal,
): Promise<GitResult | null> {
	// The stderr wording is locale-dependent, so this is not gated on the message.
	// Instead the *outcome* decides: a retry that also fails to make progress is
	// discarded, and a stale lock is handled by its own dedicated path.
	if (original.stderr.includes("index.lock")) return null;
	const retried = await runGit(
		["add", "-A", "--ignore-errors"],
		dir,
		worktreePath,
		gitTimeoutMs,
		signal,
	);
	if (retried.exitCode !== 0 && retried.exitCode !== 1) return null;
	logger.warn("Snapshot captured without paths git could not read", {
		worktreePath,
		stderr: original.stderr.slice(0, 500),
	});
	// Normalised to success: the caller only distinguishes "usable index" from "no
	// index", and the partial outcome has already been reported.
	return { ...retried, exitCode: 0 };
}

/**
 * Paths the real repository tracks even though an ignore rule covers them, or an
 * empty list when the answer is already staged.
 *
 * `-i -c --exclude-standard` is git's own answer to exactly this question, so the rule
 * evaluation is git's rather than a reimplementation — which matters, because the
 * rules involved are nested `.gitignore` files, `info/exclude` and `core.excludesFile`
 * with per-directory scoping and negation.
 *
 * Gated on {@link trackedIgnoredCache} so the two subprocesses this implies run once
 * per change to the user's index rather than twice per file-mutating tool. Returning
 * an empty list for a cache hit is the intended shape: the caller's only use for the
 * result is a force-add whose job is done.
 *
 * Filtered to paths that still exist on disk, because `git add --force -- <missing>`
 * aborts the whole invocation with exit 128 rather than skipping that one path. The
 * missing ones need no action anyway: a deletion is recorded by the plain `add -A`.
 *
 * Never throws. This is an enhancement layered on a capture that already succeeded, so
 * a failure degrades to the old behaviour instead of costing the boundary entirely.
 */
async function trackedButIgnoredPaths(dir: string, worktreePath: string): Promise<string[]> {
	try {
		const indexKey = realIndexIdentity(worktreePath);
		const cached = trackedIgnoredCache.get(dir);
		// A null key means the index could not be stat'ed (a non-git directory, or one
		// whose gitdir moved). Caching on it would pin a stale answer, so the query runs
		// every time — correct, and only reachable for a workspace that has no index for
		// the tracked-but-ignored notion to even apply to.
		if (indexKey !== null && cached?.indexKey === indexKey) return [];

		const result = await safeSpawn({
			cmd: ["git", "ls-files", "-i", "-c", "--exclude-standard", "-z"],
			cwd: worktreePath,
			timeout: GIT_TIMEOUT_MS,
			maxOutputBytes: GIT_MAX_LISTING_BYTES,
		});
		if (result.exitCode !== 0 || result.stdoutTruncated) return [];
		const paths = result.stdout.split("\0").filter(Boolean);
		if (paths.length > MAX_TRACKED_IGNORED_PATHS) {
			logger.warn("Too many tracked-but-ignored paths to snapshot; keeping the first batch", {
				worktreePath,
				pathCount: paths.length,
				cap: MAX_TRACKED_IGNORED_PATHS,
			});
			paths.length = MAX_TRACKED_IGNORED_PATHS;
		}
		const present = paths.filter((relPath) => existsSync(resolve(worktreePath, relPath)));
		// Recorded only once the paths are about to be staged, and only for a usable key,
		// so an interrupted capture cannot leave the cache claiming work that never ran.
		if (indexKey !== null) trackedIgnoredCache.set(dir, { indexKey, paths: present });
		return present;
	} catch {
		return [];
	}
}

/**
 * A cheap identity for the real repository's index: its size and mtime.
 *
 * The set of tracked-but-ignored paths can only change through a command that writes
 * this index (`add -f`, `rm --cached`, a checkout, a branch switch), so its identity is
 * a sound invalidation key — and one `stat` is ~0.04 ms against the ~27 ms the two git
 * calls it replaces cost on a 5 000-file repository.
 *
 * Size is folded in alongside mtime because a coarse filesystem timestamp can repeat
 * within the same second, and an index rewrite almost always changes its length.
 *
 * Returns null when there is no readable index, which the caller treats as "do not
 * cache" rather than as an empty set.
 */
function realIndexIdentity(worktreePath: string): string | null {
	try {
		const dotGit = resolve(worktreePath, ".git");
		const stat = statSync(dotGit);
		// A linked worktree's `.git` is a pointer file, and its index lives in the
		// per-worktree gitdir rather than the common dir — each worktree has its own.
		let gitDir = dotGit;
		if (stat.isFile()) {
			const match = readFileSync(dotGit, "utf-8").match(/^gitdir:\s*(.+)$/m);
			if (!match) return null;
			gitDir = resolve(worktreePath, match[1].trim());
		} else if (!stat.isDirectory()) {
			return null;
		}
		const index = statSync(resolve(gitDir, "index"));
		return `${index.mtimeMs}:${index.size}`;
	} catch {
		return null;
	}
}

/**
 * Remove a shadow repo's `index.lock` when nothing can still be holding it.
 *
 * Needed because the failure it fixes is permanent and silent. A `SIGKILL`ed or
 * OOM-killed git leaves the lock behind (it only cleans up on signals it can handle),
 * after which every `add -A` and `write-tree` in that repository exits 128 forever;
 * `tryCapture` swallows that into null, so the user sees no error at all while every
 * boundary from then on is missing and every rollback quietly falls back to per-file
 * replay.
 *
 * Age is the discriminator, not the exit code. Any live holder is a git process this
 * module spawned, and {@link GIT_TIMEOUT_MS} bounds how long one can run before
 * `safeSpawn` kills it — so a lock older than that timeout plus a margin cannot
 * belong to a live invocation of ours. Deleting a lock a *live* git holds would
 * corrupt its index write, which is why this is never unconditional.
 *
 * The shadow lock is held by the caller, so no other capture in this process can be
 * mid-`add` here either; the age check is what covers a *previous* process.
 *
 * Returns whether a retry is worthwhile.
 */
function recoverStaleIndexLock(dir: string, worktreePath: string, stderr: string): boolean {
	// The message is locale-dependent, so the path is what is matched on: git names the
	// lock file it could not create, and that name is not translated.
	if (!stderr.includes("index.lock")) return false;
	const lockPath = resolve(dir, "index.lock");
	try {
		const age = Date.now() - statSync(lockPath).mtimeMs;
		if (age < GIT_TIMEOUT_MS * 2) {
			// Young enough that a concurrent git could legitimately still be finishing.
			// Failing this capture is the safe outcome: the boundary is recorded as absent
			// and the next capture tries again, whereas removing a live lock corrupts the
			// index of whatever holds it.
			logger.debug("Shadow repo index.lock is too recent to reclaim", {
				worktreePath,
				ageMs: age,
			});
			return false;
		}
		rmSync(lockPath, { force: true });
		logger.warn("Removed a stale shadow-repo index.lock left by a killed git process", {
			worktreePath,
			ageMs: age,
		});
		return true;
	} catch {
		// Already gone, or unreadable. Either way there is nothing to reclaim.
		return false;
	}
}

/**
 * Materialise a tree onto the worktree without taking the shadow lock.
 * See {@link captureUnlocked} for why the unlocked variant exists.
 *
 * `expectedCurrentTree` guards against state drift: a composite caller that
 * computed something from an earlier capture passes it here, and a mismatch
 * aborts before any file is touched.
 */
async function restoreUnlocked(
	dir: string,
	worktreePath: string,
	treeHash: string,
	expectedCurrentTree?: string,
): Promise<string[]> {
	await ensureShadowRepo(dir, worktreePath);

	// Snapshot the present state first so the set of paths to delete is exact. Goes
	// through the same staging helper as a capture, not a bare `add -A`: the current
	// tree computed here is compared against `expectedCurrentTree` and diffed against
	// the target, so staging a *different* path set than a capture does would make an
	// unchanged workspace look like it had moved.
	const added = await addAllUnlocked(dir, worktreePath);
	if (added.exitCode !== 0) {
		throw new TreeSnapshotError(`restore add failed: ${added.stderr}`);
	}
	const currentTree = await runGit(["write-tree"], dir, worktreePath);
	if (currentTree.exitCode !== 0 || !currentTree.stdout) {
		throw new TreeSnapshotError(`restore write-tree failed: ${currentTree.stderr}`);
	}
	// The caller's plan was computed against a specific state; if the worktree moved
	// since then, applying that plan would write a result derived from stale input.
	if (expectedCurrentTree && currentTree.stdout !== expectedCurrentTree) {
		throw new TreeSnapshotError(
			`workspace changed during rollback (expected ${expectedCurrentTree.slice(0, 12)}, found ${currentTree.stdout.slice(0, 12)})`,
		);
	}
	if (currentTree.stdout === treeHash) return [];

	const changed = await runGitPaths(
		["diff-tree", "-r", "--name-only", "--no-commit-id", "-z", treeHash, currentTree.stdout],
		dir,
		worktreePath,
		{ maxOutputBytes: GIT_MAX_LISTING_BYTES },
	);
	if (changed.exitCode !== 0) {
		throw new TreeSnapshotError(`restore diff-tree failed: ${changed.stderr}`);
	}
	const changedPaths = changed.paths;
	if (changedPaths.length >= SLOW_PATH_COUNT) {
		logger.warn("Restoring a very large change set", {
			worktreePath,
			pathCount: changedPaths.length,
		});
	}

	// Everything past this point writes to the worktree, so a failure has to put the
	// captured state back. Deletion in particular can fail partway through — a path
	// that became a directory (EISDIR) or is locked by another process (EPERM/EBUSY)
	// throws while earlier files are already gone — and without this the caller sees
	// only "restore failed" over a half-applied worktree it has no way to describe.
	try {
		// Paths absent from the target tree were created after it and must go. Asked
		// about only the changed paths, so the cost tracks the change set rather than
		// the repository size.
		const targetPaths = await pathsPresentInTree(dir, worktreePath, treeHash, changedPaths);
		for (const relPath of changedPaths) {
			if (targetPaths.has(relPath)) continue;
			const absolute = resolve(worktreePath, relPath);
			if (!existsSync(absolute)) continue;
			// `recursive` covers the case the plain unlink cannot: the path is a file in
			// the target tree's view but a directory on disk now — and is exactly why the
			// nested-worktree guard is needed, since a gitlink recorded by an older
			// snapshot looks like precisely that.
			removePathNotInTree(worktreePath, absolute);
		}

		// Load the target tree into the index, then materialise it on disk.
		const readTree = await readTreeIntoShadowIndex(dir, worktreePath, treeHash);
		if (readTree.exitCode !== 0) {
			throw new TreeSnapshotError(`restore read-tree failed: ${readTree.stderr}`);
		}
		// Scoped to the changed paths, in batches, rather than `checkout-index -a -f`.
		// `-a` rewrites *every* file in the tree, so a rollback of three files reset the
		// mtime of the whole repository and every build tool downstream — tsc, vite,
		// make — then treated the entire project as needing a rebuild. It also widened
		// the blast radius of a failure to files the rollback had no business touching:
		// one read-only or locked file outside the change set could fail the whole
		// restore. `compensateRestore` was already scoped this way, so this makes a
		// restore and its own compensation touch exactly the same file set.
		//
		// Only paths the target tree actually contains are passed. The rest were deleted
		// just above, and `checkout-index` errors with "not in the cache" for a path it
		// has no entry for — so filtering keeps a real failure distinguishable from the
		// expected shape of a deletion instead of having to parse the message.
		const toWrite = changedPaths.filter((relPath) => targetPaths.has(relPath));
		for (const batch of batchArgs(toWrite)) {
			const checkout = await runGit(["checkout-index", "-f", "--", ...batch], dir, worktreePath);
			if (checkout.exitCode !== 0) {
				throw new TreeSnapshotError(`restore checkout-index failed: ${checkout.stderr}`);
			}
		}
	} catch (error) {
		// The same two steps as a normal restore, aimed back at the state captured
		// above, so a half-applied worktree does not survive the failure. Reported as a
		// failure either way: the caller must never treat a compensated rollback as one
		// that happened.
		const compensated = await compensateRestore(
			dir,
			worktreePath,
			currentTree.stdout,
			changedPaths,
		);
		if (!compensated) {
			logger.error("Snapshot restore failed and could not be undone", {
				worktreePath,
				capturedTree: currentTree.stdout,
				error: String(error),
			});
		}
		throw new TreeRestoreError(
			`${error instanceof Error ? error.message : String(error)}${
				compensated
					? " (the workspace was restored to its pre-rollback state)"
					: ` (WARNING: the workspace may be partially rolled back; snapshot ${currentTree.stdout.slice(0, 12)} holds the pre-rollback state)`
			}`,
			currentTree.stdout,
			compensated,
			error,
		);
	}
	return changedPaths;
}

/**
 * Put the worktree back to `capturedTree` after a failed restore.
 *
 * Mirrors the restore steps rather than only checking the tree out: a partially
 * applied restore can have *created* files that `capturedTree` does not contain
 * (the target tree held them), and `checkout-index` never removes anything. Scoped
 * to the paths the restore was going to touch, so nothing outside that set is
 * disturbed.
 *
 * Never throws — it runs from a catch block whose original error must be the one
 * that surfaces.
 */
async function compensateRestore(
	dir: string,
	worktreePath: string,
	capturedTree: string,
	changedPaths: string[],
): Promise<boolean> {
	try {
		const inCaptured = await pathsPresentInTree(dir, worktreePath, capturedTree, changedPaths);
		for (const relPath of changedPaths) {
			if (inCaptured.has(relPath)) continue;
			const absolute = resolve(worktreePath, relPath);
			if (!existsSync(absolute)) continue;
			try {
				removePathNotInTree(worktreePath, absolute);
			} catch {
				// The very condition that failed the restore can also block this one path.
				// Keep going: the remaining paths are still worth restoring, and the tree
				// comparison below decides whether the result counts as compensated.
			}
		}
		const readBack = await readTreeIntoShadowIndex(dir, worktreePath, capturedTree);
		if (readBack.exitCode !== 0) return false;
		// Scoped to the paths the restore was going to touch, and issued in batches.
		// `checkout-index -a` would rewrite every file in the worktree, so whatever
		// blocked the restore (a locked file, a read-only directory) would block the
		// compensation too even when it lies outside the change set.
		for (const batch of batchArgs(changedPaths)) {
			await runGit(["checkout-index", "-f", "--", ...batch], dir, worktreePath);
		}
		// Verified by hash rather than by exit code: what matters is that the bytes are
		// back, and a per-path failure outside the change set does not change that. Must
		// stage the same path set a capture does, or the hash comparison below would
		// declare a correctly-compensated workspace uncompensated.
		const added = await addAllUnlocked(dir, worktreePath);
		if (added.exitCode !== 0) return false;
		const nowTree = await runGit(["write-tree"], dir, worktreePath);
		return nowTree.exitCode === 0 && nowTree.stdout === capturedTree;
	} catch {
		return false;
	}
}

/**
 * Read a ref, without taking the shadow lock.
 * Returns null for a ref that does not exist — the normal state before the first
 * snapshot, not an error.
 */
async function getRefUnlocked(
	dir: string,
	worktreePath: string,
	ref: string,
): Promise<string | null> {
	// `--verify` makes an absent ref an error rather than an echo of the input, and
	// `--quiet` keeps that expected case out of stderr.
	const result = await runGit(
		["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
		dir,
		worktreePath,
	);
	if (result.exitCode !== 0 || !result.stdout) return null;
	return result.stdout;
}

/**
 * Write a snapshot commit, without taking the shadow lock.
 *
 * A commit is what gives a snapshot two things a bare tree cannot have: ancestry,
 * so git can compute a merge base between two independent lines of uncommitted
 * work, and reachability, so `gc` keeps it. Parents that do not resolve are
 * dropped rather than failing the write — a lineage with a hole is still far more
 * useful than no snapshot at all, and a missing parent is exactly what an older
 * pruned history looks like.
 */
async function commitSnapshotUnlocked(
	dir: string,
	worktreePath: string,
	treeHash: string,
	parents: string[],
	message: string,
): Promise<string> {
	assertObjectId(treeHash);
	const args = ["commit-tree", treeHash];
	for (const parent of parents) {
		assertObjectId(parent);
		// A parent that no longer exists (pruned, or a shadow repo restored from an
		// older state) would make commit-tree fail outright and cost the caller its
		// snapshot. Skipping it truncates the lineage instead.
		const exists = await runGit(["cat-file", "-e", `${parent}^{commit}`], dir, worktreePath);
		if (exists.exitCode !== 0) {
			logger.debug("Skipping an unresolvable snapshot parent", { worktreePath, parent });
			continue;
		}
		args.push("-p", parent);
	}
	// `-m` keeps the message out of stdin, so no partial-write path exists.
	args.push("-m", message);
	const result = await runGitAuthored(args, dir, worktreePath);
	if (result.exitCode !== 0 || !result.stdout) {
		throw new TreeSnapshotError(`snapshot commit-tree failed: ${result.stderr}`);
	}
	return result.stdout;
}

/**
 * Append a tree to the lineage and move the head ref onto it, without locking.
 *
 * Reusing the existing head when the tree is unchanged is what keeps the DAG
 * proportional to real change: snapshots are taken twice per file-mutating tool,
 * and a tool that wrote nothing (an Edit producing identical bytes, a read-only
 * shell command) would otherwise add a no-op link every time.
 */
async function linkSnapshotUnlocked(
	dir: string,
	worktreePath: string,
	treeHash: string,
	message: string,
): Promise<{ treeHash: string; commitSha: string }> {
	const parent = await getRefUnlocked(dir, worktreePath, SNAPSHOT_HEAD_REF);
	if (parent) {
		const parentTree = await runGit(
			["rev-parse", "--verify", "--quiet", `${parent}^{tree}`],
			dir,
			worktreePath,
		);
		if (parentTree.exitCode === 0 && parentTree.stdout === treeHash) {
			return { treeHash, commitSha: parent };
		}
	}
	const commitSha = await commitSnapshotUnlocked(
		dir,
		worktreePath,
		treeHash,
		parent ? [parent] : [],
		message,
	);
	const updated = await runGit(["update-ref", SNAPSHOT_HEAD_REF, commitSha], dir, worktreePath);
	if (updated.exitCode !== 0) {
		throw new TreeSnapshotError(`snapshot update-ref failed: ${updated.stderr}`);
	}
	return { treeHash, commitSha };
}

/**
 * Put a missing `HEAD` back rather than deleting the repository around it.
 *
 * `HEAD` is the only file this module probes to decide a shadow repo exists, and the
 * orphan sweep used to treat its absence as "invalid, delete the directory". That is
 * a data-loss bug rather than a cleanup: `HEAD` is a 23-byte pointer whose *target*
 * is never read (snapshots live under `refs/nf/`, and every command names its object
 * explicitly), while `objects/` beside it holds every tree and snapshot commit that
 * `narrator_tool_calls`, `narrator_messages` and `worktree_tree_snapshots` still
 * reference. A truncated write, a full disk or an interrupted `git init` therefore
 * cost a chapter its entire revert history.
 *
 * So the directory is only removed when there is demonstrably nothing to lose: no
 * objects and no refs. Otherwise `HEAD` is rewritten with what `git init` would have
 * produced, which is enough to make the repository usable again — and the result is
 * verified by asking git, so a directory broken in some *other* way is left in place
 * for a human instead of being silently deleted.
 *
 * Returns whether the repository is usable afterwards.
 */
async function repairShadowHead(dir: string): Promise<boolean> {
	if (!shadowDirHasContent(dir)) {
		logger.warn("Removing an empty tree-snapshot repo (missing HEAD, no objects or refs)", {
			dir,
		});
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Nothing to salvage either way; the next sweep tries again.
		}
		return false;
	}
	try {
		await Bun.write(resolve(dir, "HEAD"), "ref: refs/heads/main\n");
	} catch (error) {
		logger.warn("Could not repair a tree-snapshot repo's missing HEAD; keeping it as is", {
			dir,
			error: String(error),
		});
		return false;
	}
	// `rev-parse --git-dir` is git's own validity check, so a repo broken in a way this
	// repair does not cover is reported rather than repacked blindly.
	const check = await runGit(["rev-parse", "--git-dir"], dir, dir);
	if (check.exitCode !== 0) {
		logger.warn("Tree-snapshot repo is still unusable after restoring HEAD; keeping it", {
			dir,
			stderr: check.stderr,
		});
		return false;
	}
	logger.warn("Restored a missing HEAD in a tree-snapshot repo that still holds objects", { dir });
	return true;
}

/** Whether a shadow directory holds anything worth keeping: loose/packed objects, or refs. */
function shadowDirHasContent(dir: string): boolean {
	const hasEntries = (path: string): boolean => {
		try {
			return readdirSync(path).length > 0;
		} catch {
			return false;
		}
	};
	// `objects/` always contains `info/` and `pack/` from `git init`, so emptiness has
	// to be judged by looking inside rather than at the directory itself.
	try {
		for (const entry of readdirSync(resolve(dir, "objects"), { withFileTypes: true })) {
			if (entry.name === "info") continue;
			if (entry.name === "pack") {
				if (hasEntries(resolve(dir, "objects", "pack"))) return true;
				continue;
			}
			return true;
		}
	} catch {
		// No objects directory at all.
	}
	// A ref whose objects are gone is still evidence the repo was in use, and the
	// packed form lives in a file rather than under `refs/`.
	return hasEntries(resolve(dir, "refs", "nf")) || existsSync(resolve(dir, "packed-refs"));
}

export const worktreeTreeSnapshot = {
	/**
	 * Capture the current worktree state and return its tree hash.
	 *
	 * Writes only a tree object: no commit, no branch, and no change to the user's
	 * index. Identical states yield the same hash, so repeated calls are cheap and
	 * deduplicate naturally.
	 */
	async capture(
		worktreePath: string,
		deviceId: string = LOCAL_DEVICE_ID,
		opts?: { gitTimeoutMs?: number; signal?: AbortSignal },
	): Promise<string> {
		assertLocal(deviceId);
		const dir = shadowDir(deviceId, worktreePath);
		// A caller carrying a signal is the warm-up itself (the thing that can BE
		// preempted); everyone else is a structural path (fork/merge/restore flow
		// through here) and must not queue behind a background scan for minutes.
		const preempted = opts?.signal ? false : preemptWarmCapture(dir);
		return shadowLock.acquire(dir, async () => {
			if (preempted) removeLeftoverIndexLockAfterPreemption(dir);
			return captureUnlocked(dir, worktreePath, deviceId, {
				gitTimeoutMs: opts?.gitTimeoutMs,
				signal: opts?.signal,
			});
		});
	},

	/**
	 * Capture without throwing, for callers on the hot tool-execution path.
	 * Returns null when no snapshot could be taken; the caller then records a null
	 * tree hash, which marks that boundary as not precisely revertable.
	 */
	async tryCapture(
		worktreePath: string,
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<string | null> {
		try {
			return await this.capture(worktreePath, deviceId);
		} catch (error) {
			logger.debug("Tree snapshot capture failed", {
				worktreePath,
				deviceId,
				error: String(error),
			});
			return null;
		}
	},

	/**
	 * Capture with a hard wall-clock budget, for the tool-execution hot path.
	 *
	 * `onSnapshotBefore`/`onSnapshotAfter` are awaited inside the narrator's event
	 * consumer, so an unbounded capture stalls the whole session: the tool never
	 * reaches the permission gate, its timeout never starts, and every later event
	 * queues behind it. On a huge worktree on Windows a cold `git add -A` exceeds
	 * any budget a session can tolerate — and killing it before the index is
	 * written makes *every* capture cold, which is the cycle this breaks.
	 *
	 * Behaviour, in order:
	 *
	 *   1. A recent warm-up failure → return null immediately (cooldown).
	 *   2. A capture is already running → share its promise, bounded by the budget.
	 *      Exception: a caller passing `minStartedAt` (the tool-result hook, whose
	 *      boundary must describe the state *after* the tool finished) cannot share
	 *      a scan that started before that cutoff — its window may straddle the
	 *      tool's writes and produce a tree that never existed on disk. It waits
	 *      for the stale scan to settle (which warms the index either way), then
	 *      re-captures with the budget that remains.
	 *   3. Otherwise start one with the warm-up ceiling ({@link WARMUP_GIT_TIMEOUT_MS},
	 *      not {@link GIT_TIMEOUT_MS}). Finished within the budget → the hash, exactly
	 *      like {@link tryCapture}. Still running at the budget → return null and let
	 *      it finish in the background: a completed `add -A` writes the index that
	 *      makes every later capture cheap, so the worktree self-heals.
	 *
	 * Only a failure that outlived the budget starts the cooldown — a fast failure
	 * (a worktree removed mid-dormancy, a transient lock) keeps the retry-next-time
	 * behaviour it has always had, as does a preemption by a structural path.
	 *
	 * Never throws, and never takes longer than the budget.
	 */
	async tryCaptureHot(
		worktreePath: string,
		deviceId: string = LOCAL_DEVICE_ID,
		opts?: {
			budgetMs?: number;
			warmupGitTimeoutMs?: number;
			cooldownMs?: number;
			minStartedAt?: number;
		},
	): Promise<string | null> {
		const budgetMs = opts?.budgetMs ?? HOT_PATH_CAPTURE_BUDGET_MS;
		const warmupGitTimeoutMs = opts?.warmupGitTimeoutMs ?? WARMUP_GIT_TIMEOUT_MS;
		const cooldownMs = opts?.cooldownMs ?? WARMUP_FAILURE_COOLDOWN_MS;
		const minStartedAt = opts?.minStartedAt;
		try {
			assertLocal(deviceId);
			const dir = shadowDir(deviceId, worktreePath);

			const cooldownUntil = warmupCooldownUntil.get(dir);
			if (cooldownUntil !== undefined) {
				if (Date.now() < cooldownUntil) return null;
				warmupCooldownUntil.delete(dir);
			}

			const deadline = Date.now() + budgetMs;
			let remainingMs = budgetMs;
			for (;;) {
				const inFlight = warmupInFlight.get(dir);
				if (!inFlight) break;
				if (minStartedAt === undefined || inFlight.startedAt >= minStartedAt) {
					return (await raceBudget(inFlight.promise, remainingMs)) ?? null;
				}
				// The shared scan started before the caller's cutoff: its tree may mix
				// bytes from before and after the writes being measured — a state that
				// never existed on disk, worthless (and misleading) as a boundary. Wait
				// for it to settle — it warms the index either way — then loop to
				// re-capture with what budget remains; a too-slow settle degrades to
				// null (per-file replay), exactly like any other over-budget capture.
				const staleSettled = await raceBudget(
					inFlight.promise.then(
						() => true,
						() => true,
					),
					remainingMs,
				);
				if (!staleSettled) return null;
				remainingMs = deadline - Date.now();
				if (remainingMs <= 0) return null;
			}

			const abort = new AbortController();
			const entry: WarmupEntry = {
				startedAt: Date.now(),
				abort,
				preempted: false,
				promise: Promise.resolve(null),
			};
			const settled = this.capture(worktreePath, deviceId, {
				gitTimeoutMs: warmupGitTimeoutMs,
				signal: abort.signal,
			}).then(
				(hash) => ({ ok: true as const, hash }),
				(error: unknown) => ({ ok: false as const, error }),
			);

			// Registered *before* the budget race resolves, so concurrent hot calls
			// share this one scan instead of each queueing a full `add -A` of their own
			// on the shadow lock.
			let sawBudgetExpiry = false;
			const shared: Promise<string | null> = settled.then((result) => {
				warmupInFlight.delete(dir);
				if (result.ok) return result.hash;
				// A preempted warm-up was killed by a structural path, not by a
				// pathological worktree — its failure must not pause future captures.
				if (sawBudgetExpiry && !entry.preempted) {
					warmupCooldownUntil.set(dir, Date.now() + cooldownMs);
					logger.warn(
						"Workspace snapshot warm-up failed; hot-path captures paused until cooldown expires",
						{
							worktreePath,
							cooldownMs,
							error: result.error instanceof Error ? result.error.message : String(result.error),
						},
					);
				}
				return null;
			});
			entry.promise = shared;
			warmupInFlight.set(dir, entry);

			const outcome = await raceBudget(settled, remainingMs);
			if (outcome !== undefined) {
				return outcome.ok ? outcome.hash : null;
			}
			sawBudgetExpiry = true;
			logger.warn("Workspace snapshot exceeded the hot-path budget; continuing in background", {
				worktreePath,
				budgetMs,
			});
			return null;
		} catch (error) {
			logger.debug("Hot-path tree snapshot capture failed", {
				worktreePath,
				deviceId,
				error: String(error),
			});
			return null;
		}
	},

	/** Whether a tree object exists in this worktree's shadow repo. */
	async hasTree(
		worktreePath: string,
		treeHash: string,
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<boolean> {
		assertLocal(deviceId);
		const dir = shadowDir(deviceId, worktreePath);
		if (!existsSync(resolve(dir, "HEAD"))) return false;
		const result = await runGit(["cat-file", "-t", treeHash], dir, worktreePath);
		return result.exitCode === 0 && result.stdout === "tree";
	},

	/** All paths recorded in a snapshot. */
	async listPaths(
		worktreePath: string,
		treeHash: string,
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<string[]> {
		assertLocal(deviceId);
		const dir = shadowDir(deviceId, worktreePath);
		// The one genuinely whole-tree listing left, so it gets the listing cap rather
		// than the hash-sized one: a large repository's path names alone exceed 1 MB.
		const result = await runGitPaths(
			["ls-tree", "-r", "--name-only", "-z", treeHash],
			dir,
			worktreePath,
			{ maxOutputBytes: GIT_MAX_LISTING_BYTES },
		);
		if (result.exitCode !== 0) {
			throw new TreeSnapshotError(`snapshot ls-tree failed: ${result.stderr}`);
		}
		return result.paths;
	},

	/**
	 * Read one file's text as recorded in a snapshot, for diff previews.
	 *
	 * Returns null when the path is absent from the tree, exceeds `maxBytes`, or is
	 * not valid UTF-8 text — a preview must never stream a huge or binary blob into
	 * an API response.
	 */
	async readFileAtTree(
		worktreePath: string,
		treeHash: string,
		relPath: string,
		deviceId: string = LOCAL_DEVICE_ID,
		maxBytes = 512 * 1024,
	): Promise<string | null> {
		assertLocal(deviceId);
		const dir = shadowDir(deviceId, worktreePath);
		const spec = `${treeHash}:${relPath}`;
		const size = await runGit(["cat-file", "-s", spec], dir, worktreePath);
		if (size.exitCode !== 0) return null;
		if (Number(size.stdout) > maxBytes) return null;
		const result = await safeSpawn({
			cmd: ["git", "--git-dir", dir, "--work-tree", worktreePath, "cat-file", "blob", spec],
			timeout: GIT_TIMEOUT_MS,
			maxOutputBytes: maxBytes,
		});
		if (result.exitCode !== 0 || result.stdoutTruncated) return null;
		// A replacement character means the blob was not text; a diff of mojibake is
		// worse than reporting no preview.
		return result.stdout.includes("\uFFFD") ? null : result.stdout;
	},

	/**
	 * Which of `paths` a snapshot contains.
	 *
	 * The bounded counterpart of {@link listPaths}, for callers that only need to test
	 * a known set (does this changed path survive the rollback?). Cost tracks the
	 * requested set instead of the repository, so it stays usable on a large repo where
	 * a full listing would be megabytes of path names.
	 */
	async listPathsIn(
		worktreePath: string,
		treeHash: string,
		paths: string[],
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<string[]> {
		assertLocal(deviceId);
		if (paths.length === 0) return [];
		const dir = shadowDir(deviceId, worktreePath);
		return [...(await pathsPresentInTree(dir, worktreePath, treeHash, paths))];
	},

	/** Paths that differ between two snapshots. */
	async diffPaths(
		worktreePath: string,
		fromTree: string,
		toTree: string,
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<string[]> {
		assertLocal(deviceId);
		const dir = shadowDir(deviceId, worktreePath);
		const result = await runGitPaths(
			["diff-tree", "-r", "--name-only", "--no-commit-id", "-z", fromTree, toTree],
			dir,
			worktreePath,
			{ maxOutputBytes: GIT_MAX_LISTING_BYTES },
		);
		if (result.exitCode !== 0) {
			throw new TreeSnapshotError(`snapshot diff-tree failed: ${result.stderr}`);
		}
		return result.paths;
	},

	/**
	 * Like {@link diffPaths}, but reporting HOW each path changed.
	 *
	 * A separate method rather than a flag on `diffPaths`: that one's `string[]`
	 * return feeds attribution and rollback, which only ever ask "which paths", and
	 * widening it would make every caller destructure a shape it does not use.
	 *
	 * `--name-status -z` emits `STATUS\0PATH\0` pairs, so unlike the `--name-only`
	 * form the field count is doubled and a rename emits TWO paths after its status.
	 * Renames are not requested (`-M` is absent), so git reports them as a delete
	 * plus an add — which is what a file tree wants anyway, since both directories
	 * must be re-read.
	 */
	async diffPathStatuses(
		worktreePath: string,
		fromTree: string,
		toTree: string,
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<{ path: string; kind: "added" | "updated" | "deleted" }[]> {
		assertLocal(deviceId);
		const dir = shadowDir(deviceId, worktreePath);
		const result = await runGitPaths(
			["diff-tree", "-r", "--name-status", "--no-commit-id", "-z", fromTree, toTree],
			dir,
			worktreePath,
			{ maxOutputBytes: GIT_MAX_LISTING_BYTES },
		);
		if (result.exitCode !== 0) {
			throw new TreeSnapshotError(`snapshot diff-tree failed: ${result.stderr}`);
		}
		return parseNameStatusFields(result.paths);
	},

	/**
	 * Restore the worktree to a snapshot.
	 *
	 * `checkout-index` only writes paths present in the tree, so files created
	 * after the snapshot must be deleted explicitly. Their identity comes from
	 * diffing the target tree against the current state, which means only tracked,
	 * non-ignored paths are touched.
	 */
	async restore(
		worktreePath: string,
		treeHash: string,
		deviceId: string = LOCAL_DEVICE_ID,
		expectedCurrentTree?: string,
	): Promise<string[]> {
		assertLocal(deviceId);
		const dir = shadowDir(deviceId, worktreePath);
		return acquireShadowStructural(dir, () =>
			restoreUnlocked(dir, worktreePath, treeHash, expectedCurrentTree),
		);
	},

	/**
	 * Compute the reversal of a set of boundary pairs against the live workspace,
	 * without writing anything.
	 *
	 * Capture and merge share one critical section so the returned plan describes a
	 * state that actually existed. The preview and the rollback both go through this
	 * (the rollback re-computes it while holding the lock), so both report the same
	 * comparison for an unchanged workspace, and a workspace that moved in between is
	 * detected rather than silently applied.
	 */
	async planReversal(
		worktreePath: string,
		pairs: TreeBoundaryPair[],
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<SegmentReversalPlan> {
		assertLocal(deviceId);
		const dir = shadowDir(deviceId, worktreePath);
		return acquireShadowStructural(dir, async () => {
			await ensureShadowRepo(dir, worktreePath);
			const current = await captureUnlocked(dir, worktreePath, deviceId);
			return planSegmentReversalUnlocked(dir, worktreePath, current, planTreeRevertSegments(pairs));
		});
	},

	/**
	 * Reverse a set of boundary pairs and materialise the result, as a single atomic
	 * step against the shadow repository.
	 *
	 * Capture, merge and restore must share one critical section: the merge is
	 * computed from the captured state, so another writer landing in between would
	 * make the restore apply a plan derived from a state that no longer exists.
	 *
	 * Returns the pre-restore tree so the caller can undo this rollback, and leaves
	 * the worktree untouched when any segment conflicts.
	 */
	async reverseAndRestore(
		worktreePath: string,
		pairs: TreeBoundaryPair[],
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<{
		previousTreeHash: string;
		mergedTree: string;
		conflicts: string[];
		changedFiles: string[];
	}> {
		assertLocal(deviceId);
		const dir = shadowDir(deviceId, worktreePath);
		return acquireShadowStructural(dir, async () => {
			await ensureShadowRepo(dir, worktreePath);
			const current = await captureUnlocked(dir, worktreePath, deviceId);
			const plan = await planSegmentReversalUnlocked(
				dir,
				worktreePath,
				current,
				planTreeRevertSegments(pairs),
			);
			// A conflicted tree carries conflict markers; writing it out would corrupt
			// the files it claims to restore.
			if (plan.conflicts.length > 0) {
				return {
					previousTreeHash: current,
					mergedTree: plan.mergedTree,
					conflicts: plan.conflicts,
					changedFiles: [],
				};
			}
			if (plan.mergedTree === current) {
				return {
					previousTreeHash: current,
					mergedTree: current,
					conflicts: [],
					changedFiles: [],
				};
			}
			const changedFiles = await restoreUnlocked(dir, worktreePath, plan.mergedTree, current);
			return {
				previousTreeHash: current,
				mergedTree: plan.mergedTree,
				conflicts: [],
				changedFiles,
			};
		});
	},

	/**
	 * Copy a snapshot from one worktree onto another.
	 * Used when forking, so the new worktree starts from the exact state a message
	 * observed rather than from the nearest commit plus a best-effort rebuild.
	 *
	 * "Exact" requires deleting as well as writing. `checkout-index` only ever writes
	 * the paths a tree contains, and the target worktree was created from a commit, so
	 * anything the snapshot does *not* contain is still sitting there — a file the
	 * parent deleted without committing would come back from the dead in the fork.
	 * The files to remove are identified by comparing the target's current state
	 * against the snapshot, so only tracked, non-ignored paths are ever touched.
	 */
	async restoreInto(
		sourceWorktreePath: string,
		targetWorktreePath: string,
		treeHash: string,
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<void> {
		assertLocal(deviceId);
		const sourceDir = shadowDir(deviceId, sourceWorktreePath);
		if (!existsSync(resolve(sourceDir, "HEAD"))) {
			throw new TreeSnapshotError(`No snapshot repository for ${sourceWorktreePath}`);
		}
		await acquireShadowStructural(sourceDir, async () => {
			// Hash the target as it is now, using a scratch index so the source repo's
			// own index — which tracks the *source* worktree — is left alone.
			//
			// Kept OUTSIDE the shadow repository: the `finally` below removes it, but a
			// killed process cannot run that, and `gcAll` only ever deletes a shadow
			// directory for a missing `HEAD` — so a residue here would persist
			// indefinitely inside a directory that is otherwise entirely git-managed.
			// The system temp directory is swept by the OS, which is the whole point.
			const scratchIndex = resolve(tmpdir(), `nf-restore-into-${generateId()}.index`);
			try {
				let currentTree: string | null = null;
				const added = await runGitWithIndex(
					["add", "-A"],
					sourceDir,
					targetWorktreePath,
					scratchIndex,
				);
				if (added.exitCode === 0) {
					const written = await runGitWithIndex(
						["write-tree"],
						sourceDir,
						targetWorktreePath,
						scratchIndex,
					);
					if (written.exitCode === 0 && written.stdout) currentTree = written.stdout;
				}

				if (currentTree && currentTree !== treeHash) {
					const changed = await runGitPaths(
						["diff-tree", "-r", "--name-only", "--no-commit-id", "-z", treeHash, currentTree],
						sourceDir,
						targetWorktreePath,
						{ maxOutputBytes: GIT_MAX_LISTING_BYTES },
					);
					if (changed.exitCode === 0 && changed.paths.length > 0) {
						const inSnapshot = await pathsPresentInTree(
							sourceDir,
							targetWorktreePath,
							treeHash,
							changed.paths,
						);
						for (const relPath of changed.paths) {
							if (inSnapshot.has(relPath)) continue;
							const absolute = resolve(targetWorktreePath, relPath);
							if (!existsSync(absolute)) continue;
							// `recursive` covers a path that is a file in the snapshot's view but a
							// directory on disk, and the guard keeps that from eating a nested
							// worktree this module holds no snapshot of.
							removePathNotInTree(targetWorktreePath, absolute);
						}
					}
				}

				// The write phase uses the scratch index too, for the reason the hash phase
				// already documents: this repo's own index is a stat cache of the *source*
				// worktree. `read-tree` overwrote it with the fork's tree and `checkout-index`
				// re-stat'ed the *target*'s files into it, so every entry's stat data then
				// described the wrong worktree — the source's next capture had to re-hash the
				// entire repository, turning a 12 ms warm capture into a full cold scan on the
				// tool-execution path. Using the throwaway index leaves the source's cache
				// intact and costs nothing, since it is discarded either way.
				//
				// It is also why this `read-tree` does not go through
				// {@link readTreeIntoShadowIndex}: the eviction that invalidation exists for
				// happens to the *shadow* index, and this one never touches it.
				const readTree = await runGitWithIndex(
					["read-tree", treeHash],
					sourceDir,
					targetWorktreePath,
					scratchIndex,
				);
				if (readTree.exitCode !== 0) {
					throw new TreeSnapshotError(`fork read-tree failed: ${readTree.stderr}`);
				}
				// `-a` is correct here, unlike in `restore`: the target worktree is a fresh
				// fork being brought to a known state wholesale, so there is no "outside the
				// change set" whose mtime this could disturb.
				const checkout = await runGitWithIndex(
					["checkout-index", "-a", "-f"],
					sourceDir,
					targetWorktreePath,
					scratchIndex,
				);
				if (checkout.exitCode !== 0) {
					throw new TreeSnapshotError(`fork checkout-index failed: ${checkout.stderr}`);
				}
			} finally {
				rmSync(scratchIndex, { force: true });
				// git guards index writes with a sibling lock file; an interrupted `add`
				// can leave it behind, and it would then block a later reuse of this name.
				rmSync(`${scratchIndex}.lock`, { force: true });
			}
		});
	},

	// === Snapshot DAG ===
	//
	// The methods above treat a snapshot as an isolated tree, which is all a
	// rollback needs: it always knows both endpoints of the span it is reversing.
	// Forking and merging do not — they need to know what two diverging lines of
	// *uncommitted* work had in common. Chaining snapshots into commits supplies
	// exactly that, because a merge base is a property of ancestry, and ancestry is
	// something only commits have.
	//
	// These commits live solely in the shadow repository. They never enter the
	// user's object store, never become a branch, and never appear in `git log`.

	/**
	 * Record a tree as a snapshot commit and return its id.
	 *
	 * Distinct from {@link capture}, which only hashes bytes: this places that hash
	 * into a lineage. Pass the previous snapshot as the sole parent for ordinary
	 * progress, or two parents when the state resulted from combining two lines —
	 * a merge parent is not cosmetic, it is what stops the next merge from
	 * recomputing an ancestor that predates the combination and reporting conflicts
	 * that were already resolved.
	 */
	async commitSnapshot(
		worktreePath: string,
		treeHash: string,
		parents: string[] = [],
		message = "snapshot",
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<string> {
		assertLocal(deviceId);
		const dir = shadowDir(deviceId, worktreePath);
		return acquireShadowStructural(dir, async () => {
			await ensureShadowRepo(dir, worktreePath);
			return commitSnapshotUnlocked(dir, worktreePath, treeHash, parents, message);
		});
	},

	/**
	 * Capture the worktree and append it to the lineage in one critical section.
	 *
	 * The composite exists because the two halves must not interleave: between a
	 * separate `capture` and `commitSnapshot`, another capture could advance the ref
	 * and this commit would then be parented to a state that came *after* its own
	 * tree, inverting the lineage.
	 *
	 * Returns null rather than throwing. This runs on the tool-execution path, where
	 * the DAG is an enhancement layered on top of the boundary hashes that were
	 * already recorded — losing a link must never cost the user their tool call.
	 */
	async advanceSnapshotRef(
		worktreePath: string,
		message = "snapshot",
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<{ treeHash: string; commitSha: string } | null> {
		try {
			assertLocal(deviceId);
			const dir = shadowDir(deviceId, worktreePath);
			return await acquireShadowStructural(dir, async () => {
				await ensureShadowRepo(dir, worktreePath);
				const treeHash = await captureUnlocked(dir, worktreePath, deviceId);
				return linkSnapshotUnlocked(dir, worktreePath, treeHash, message);
			});
		} catch (error) {
			logger.debug("Failed to advance the snapshot lineage", {
				worktreePath,
				deviceId,
				error: String(error),
			});
			return null;
		}
	},

	/**
	 * Append an already-captured tree to the lineage.
	 *
	 * The counterpart of {@link advanceSnapshotRef} for callers that just captured
	 * the workspace for another purpose. The tool-execution hooks are the reason it
	 * exists: they capture a boundary hash on every file-mutating tool, and having
	 * the DAG re-run `add -A` would double the one cost on that path that is
	 * proportional to repository size.
	 *
	 * Returns null instead of throwing, for the same reason as
	 * {@link advanceSnapshotRef}.
	 */
	async linkSnapshot(
		worktreePath: string,
		treeHash: string,
		message = "snapshot",
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<{ treeHash: string; commitSha: string } | null> {
		try {
			assertLocal(deviceId);
			assertObjectId(treeHash);
			const dir = shadowDir(deviceId, worktreePath);
			return await acquireShadowStructural(dir, async () => {
				await ensureShadowRepo(dir, worktreePath);
				return linkSnapshotUnlocked(dir, worktreePath, treeHash, message);
			});
		} catch (error) {
			logger.debug("Failed to link a snapshot into the lineage", {
				worktreePath,
				deviceId,
				error: String(error),
			});
			return null;
		}
	},

	/** Point a snapshot ref at a commit. Refs outside `refs/nf/` are rejected. */
	async setRef(
		worktreePath: string,
		ref: string,
		commitSha: string,
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<void> {
		assertLocal(deviceId);
		assertSnapshotRef(ref);
		assertObjectId(commitSha);
		const dir = shadowDir(deviceId, worktreePath);
		await acquireShadowStructural(dir, async () => {
			await ensureShadowRepo(dir, worktreePath);
			const result = await runGit(["update-ref", ref, commitSha], dir, worktreePath);
			if (result.exitCode !== 0) {
				throw new TreeSnapshotError(`snapshot update-ref failed: ${result.stderr}`);
			}
		});
	},

	/**
	 * Remove a snapshot ref, if it is there.
	 *
	 * Exists because a ref is a garbage-collection root and this module had no way to
	 * give one up. `chapter-fork` writes `refs/nf/incoming/fork-<childId>` into the
	 * *parent's* shadow repository so the child can fetch that exact commit across, and
	 * nothing ever removed it: `setRef` cannot clear a ref (it demands a real object id)
	 * and `destroy` takes the whole repository, which the parent still needs. Since
	 * `gcAll` runs `gc --no-prune`, every such ref kept its commit and the entire tree
	 * beneath it alive forever — a chapter forked fifty times carried fifty object
	 * graphs it could never drop.
	 *
	 * Idempotent by design: a missing ref, and a shadow repository that was never
	 * created or has already been destroyed, are all "nothing to remove" rather than
	 * errors. The callers are clean-up paths, which must not fail because the thing they
	 * were cleaning up is already gone.
	 *
	 * {@link SNAPSHOT_HEAD_REF} and {@link SNAPSHOT_BASE_REF} are refused outright.
	 * Deleting `head` would sever a workspace's lineage — every later capture would
	 * start fresh ancestry and the existing chain would become unreachable, which is
	 * exactly the data loss the snapshot DAG exists to prevent. Only auxiliary refs
	 * (the `incoming/` namespace) are the caller's to remove.
	 */
	async deleteRef(
		worktreePath: string,
		ref: string,
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<void> {
		assertLocal(deviceId);
		assertSnapshotRef(ref);
		if (ref === SNAPSHOT_HEAD_REF || ref === SNAPSHOT_BASE_REF) {
			throw new TreeSnapshotError(`Refusing to delete the lineage ref ${ref}`);
		}
		const dir = shadowDir(deviceId, worktreePath);
		// Probed before taking the lock: `ensureShadowRepo` would otherwise *create* a
		// repository just to delete a ref that cannot exist in it.
		if (!existsSync(resolve(dir, "HEAD"))) return;
		await acquireShadowStructural(dir, async () => {
			const result = await runGit(["update-ref", "-d", ref], dir, worktreePath);
			// `update-ref -d` on an absent ref succeeds, so a non-zero exit is a real
			// failure. Logged rather than thrown: the caller is deleting something, and
			// failing that delete over a leftover ref would be worse than the leak.
			if (result.exitCode !== 0) {
				logger.debug("Could not delete a snapshot ref", {
					worktreePath,
					ref,
					stderr: result.stderr,
				});
			}
		});
	},

	/** Resolve a snapshot ref to a commit id, or null when it does not exist. */
	async getRef(
		worktreePath: string,
		ref: string,
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<string | null> {
		assertLocal(deviceId);
		assertSnapshotRef(ref);
		const dir = shadowDir(deviceId, worktreePath);
		if (!existsSync(resolve(dir, "HEAD"))) return null;
		return acquireShadowStructural(dir, () => getRefUnlocked(dir, worktreePath, ref));
	},

	/** The tree recorded by a snapshot commit, or null if it cannot be resolved. */
	async treeOfSnapshot(
		worktreePath: string,
		commitSha: string,
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<string | null> {
		assertLocal(deviceId);
		assertObjectId(commitSha);
		const dir = shadowDir(deviceId, worktreePath);
		if (!existsSync(resolve(dir, "HEAD"))) return null;
		return acquireShadowStructural(dir, async () => {
			const result = await runGit(
				["rev-parse", "--verify", "--quiet", `${commitSha}^{tree}`],
				dir,
				worktreePath,
			);
			return result.exitCode === 0 && result.stdout ? result.stdout : null;
		});
	},

	/**
	 * Import a commit from the user's real repository into a shadow repository.
	 *
	 * Needed because two chapters' snapshot lineages are frequently *unrelated*: a
	 * lineage begins the first time a workspace is captured, so two chapters created
	 * independently (rather than one forked from the other) have no common snapshot
	 * ancestor at all, and git refuses to merge unrelated histories. Their real
	 * branches do share history, and that shared commit is the correct merge base.
	 *
	 * `fetch` is used rather than an alternates link on purpose: it copies the objects,
	 * so the shadow repository stays self-contained and the user's own `git gc` cannot
	 * invalidate a base NarraFork still depends on.
	 *
	 * Returns null when the commit cannot be imported, leaving the caller to decide.
	 */
	async importCommitFromRepo(
		worktreePath: string,
		repoPath: string,
		commitSha: string,
		ref: string,
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<string | null> {
		assertLocal(deviceId);
		assertSnapshotRef(ref);
		assertObjectId(commitSha);
		const dir = shadowDir(deviceId, worktreePath);
		return acquireShadowStructural(dir, async () => {
			await ensureShadowRepo(dir, worktreePath);
			const result = await runGit(
				["fetch", "--no-tags", "--quiet", repoPath, `+${commitSha}:${ref}`],
				dir,
				worktreePath,
			);
			if (result.exitCode !== 0) {
				logger.debug("Could not import a repository commit into the shadow repo", {
					worktreePath,
					commitSha,
					stderr: result.stderr,
				});
				return null;
			}
			return getRefUnlocked(dir, worktreePath, ref);
		});
	},

	/**
	 * Copy a snapshot lineage from another worktree's shadow repository.
	 *
	 * Shadow repositories share no objects — deliberately, because the alternative
	 * (an `objects/info/alternates` link to the user's repository) makes snapshot
	 * durability depend on the user's own `git gc`, and a routine history rewrite
	 * then destroys snapshots NarraFork promised to keep. `fetch` copies the objects
	 * instead, so the receiving repository is self-contained afterwards and the
	 * source may be discarded.
	 *
	 * The fetched history is what makes a cross-worktree merge base computable: both
	 * sides then descend from a common snapshot commit inside one repository.
	 */
	async fetchSnapshotFrom(
		targetWorktreePath: string,
		sourceWorktreePath: string,
		sourceRef: string,
		targetRef: string,
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<string | null> {
		assertLocal(deviceId);
		assertSnapshotRef(sourceRef);
		assertSnapshotRef(targetRef);
		const sourceDir = shadowDir(deviceId, sourceWorktreePath);
		if (!existsSync(resolve(sourceDir, "HEAD"))) return null;
		const targetDir = shadowDir(deviceId, targetWorktreePath);

		const runFetch = async (): Promise<string | null> => {
			await ensureShadowRepo(targetDir, targetWorktreePath);
			const source = await getRefUnlocked(sourceDir, sourceWorktreePath, sourceRef);
			if (!source) return null;
			// `--no-tags` and an explicit refspec keep this to the one lineage asked
			// for; a bare fetch would also drag in whatever else the source holds.
			const result = await runGit(
				["fetch", "--no-tags", "--quiet", sourceDir, `+${sourceRef}:${targetRef}`],
				targetDir,
				targetWorktreePath,
			);
			if (result.exitCode !== 0) {
				throw new TreeSnapshotError(`snapshot fetch failed: ${result.stderr}`);
			}
			return getRefUnlocked(targetDir, targetWorktreePath, targetRef);
		};

		// Both repositories are touched, so both locks are needed — unless they are
		// the same repository, in which case taking it twice would deadlock: the mutex
		// queues every acquire behind the current tail and is not reentrant. Copying a
		// lineage within one repo is a legitimate call (aliasing a ref), so this is
		// handled rather than rejected.
		if (sourceDir === targetDir) {
			return acquireShadowStructural(targetDir, runFetch);
		}
		// Locked in a canonical order (sorted by directory) because a fork and a merge
		// can run in opposite directions between the same pair; locking in call order
		// would let the two deadlock against each other.
		const [first, second] = [sourceDir, targetDir].sort();
		return acquireShadowStructural(first, () => acquireShadowStructural(second, runFetch));
	},

	/**
	 * Three-way merge two snapshot commits, letting git derive the merge base.
	 *
	 * Both commits must already be present in this worktree's shadow repository —
	 * use {@link fetchSnapshotFrom} first for a lineage that came from elsewhere.
	 *
	 * Nothing is written to the worktree, including when the merge conflicts: the
	 * resulting tree then contains conflict markers, and checking it out would
	 * corrupt the very files it claims to merge. The caller decides whether to
	 * materialise the clean result or surface the conflicting paths.
	 *
	 * `fallbackBase` covers the case where the two commits share no ancestry at all,
	 * which is normal rather than exceptional: a lineage begins at a workspace's first
	 * capture, so two chapters created independently — as opposed to one forked from the
	 * other — have no common snapshot ancestor even though their git branches do share
	 * history. git refuses such a merge outright, and the branches' real merge base is
	 * the correct answer. It is consulted only after ancestry has been ruled out, so a
	 * genuine relationship is always preferred.
	 */
	async mergeSnapshots(
		worktreePath: string,
		ours: string,
		theirs: string,
		deviceId: string = LOCAL_DEVICE_ID,
		fallbackBase?: string,
	): Promise<TreeMergeResult> {
		assertLocal(deviceId);
		assertObjectId(ours);
		assertObjectId(theirs);
		if (fallbackBase) assertObjectId(fallbackBase);
		const dir = shadowDir(deviceId, worktreePath);
		return acquireShadowStructural(dir, async () => {
			await ensureShadowRepo(dir, worktreePath);
			const shared = await runGit(["merge-base", ours, theirs], dir, worktreePath);
			if (shared.exitCode === 0 && shared.stdout) {
				// Ancestry exists, so let git derive the base: a hand-computed base is what
				// produces spurious conflicts when a real relationship is available.
				return mergeTreeUnlocked(dir, worktreePath, null, ours, theirs);
			}
			if (!fallbackBase) {
				throw new TreeSnapshotError(
					"snapshot merge has no common ancestor and no fallback base was supplied",
				);
			}
			return mergeTreeUnlocked(dir, worktreePath, fallbackBase, ours, theirs);
		});
	},

	/**
	 * Roll one snapshot's contribution back out of another, keeping later work.
	 *
	 * A three-way merge with the base deliberately set to the snapshot being reversed:
	 * `base = contribution`, `ours = current state`, `theirs = state before it landed`.
	 * git preserves `ours` wherever `base` and `theirs` agree, so only the bytes that
	 * `contribution` introduced are undone — everything done afterwards survives.
	 *
	 * This is what undoing a commit-free merge needs. The commit-based equivalent has
	 * to choose between resetting (safe only if nothing followed) and reverting
	 * (needed once it has); one reverse merge covers both, because "what changed since"
	 * is exactly what a three-way merge already reasons about.
	 *
	 * A conflict means the current state edited the same region being rolled back. The
	 * tree is still returned but must not be written out.
	 */
	/**
	 * Three-way merge two trees against an explicitly given base.
	 *
	 * The tree-level counterpart of {@link mergeSnapshots}, for callers whose three
	 * sides are trees with no ancestry to derive a base from — reapplying uncommitted
	 * work after a rebase, where the base is "the state git was handed" rather than any
	 * common ancestor. Trees carry no parents, so the base has to be stated.
	 *
	 * All three arguments must come from the same shadow repository. Mixing in a tree
	 * read from the user's repository looks equivalent and is not: a shadow repository
	 * applies its own exclude rules, so the two disagree about any file git tracks
	 * despite an ignore rule, and a three-way merge reads that disagreement as a
	 * deletion.
	 *
	 * Nothing is written to the worktree, conflicts included; the returned tree then
	 * carries conflict markers and must not be checked out blindly.
	 */
	async mergeTreesWithBase(
		worktreePath: string,
		base: string,
		ours: string,
		theirs: string,
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<TreeMergeResult> {
		assertLocal(deviceId);
		assertObjectId(base);
		assertObjectId(ours);
		assertObjectId(theirs);
		const dir = shadowDir(deviceId, worktreePath);
		return acquireShadowStructural(dir, async () => {
			await ensureShadowRepo(dir, worktreePath);
			return mergeTreeUnlocked(dir, worktreePath, base, ours, theirs);
		});
	},

	async reverseMergeSnapshots(
		worktreePath: string,
		contribution: string,
		current: string,
		beforeContribution: string,
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<TreeMergeResult> {
		assertLocal(deviceId);
		assertObjectId(contribution);
		assertObjectId(current);
		assertObjectId(beforeContribution);
		const dir = shadowDir(deviceId, worktreePath);
		return acquireShadowStructural(dir, async () => {
			await ensureShadowRepo(dir, worktreePath);
			// The base is given explicitly here, unlike `mergeSnapshots`. Letting git
			// derive it would find the common ancestor of the two sides, which is not the
			// question being asked: the reversal is defined relative to the contribution
			// itself, so that is what has to be the base.
			return mergeTreeUnlocked(dir, worktreePath, contribution, current, beforeContribution);
		});
	},

	/**
	 * The merge base of two snapshot commits, or null when they share no ancestry.
	 *
	 * Exposed for diagnostics and tests; {@link mergeSnapshots} does not need it,
	 * since git computes the base internally.
	 */
	async snapshotMergeBase(
		worktreePath: string,
		a: string,
		b: string,
		deviceId: string = LOCAL_DEVICE_ID,
	): Promise<string | null> {
		assertLocal(deviceId);
		assertObjectId(a);
		assertObjectId(b);
		const dir = shadowDir(deviceId, worktreePath);
		if (!existsSync(resolve(dir, "HEAD"))) return null;
		return acquireShadowStructural(dir, async () => {
			const result = await runGit(["merge-base", a, b], dir, worktreePath);
			// Exit 1 means "no common ancestor", which is a legitimate answer for two
			// unrelated lineages rather than a failure.
			if (result.exitCode !== 0) return null;
			return result.stdout || null;
		});
	},

	/**
	 * Write a tree onto a worktree, deleting whatever the tree does not contain.
	 *
	 * The named counterpart of {@link restore} for callers that hold a tree rather
	 * than a snapshot boundary (a fork materialising its start state, a merge
	 * applying its result). Shares the same implementation, so it inherits the parts
	 * that make a partial write survivable: files created after the tree are removed
	 * explicitly, since `checkout-index` never deletes, and a failure mid-write is
	 * compensated back to the pre-write state.
	 */
	async materializeTree(
		worktreePath: string,
		treeHash: string,
		deviceId: string = LOCAL_DEVICE_ID,
		expectedCurrentTree?: string,
	): Promise<string[]> {
		assertLocal(deviceId);
		assertObjectId(treeHash);
		const dir = shadowDir(deviceId, worktreePath);
		return acquireShadowStructural(dir, () =>
			restoreUnlocked(dir, worktreePath, treeHash, expectedCurrentTree),
		);
	},

	/**
	 * Remove a worktree's shadow repository and its recorded hashes.
	 *
	 * Refuses when a chapter still claims this shadow repository, unless `force` is
	 * set. The guard exists because a worktree directory disappearing does *not*
	 * always mean its history is finished with:
	 *
	 *   - Making a chapter dormant removes the worktree and nulls `worktreePath`,
	 *     but waking it rebuilds the very same path, so the shadow repo is expected
	 *     to still be there.
	 *   - If that removal fails, the directory survives while the database already
	 *     reads as dormant — and the orphan sweep, which walks directories that no
	 *     active chapter claims, would then delete both the directory and this
	 *     repository, taking the chapter's whole snapshot lineage with it.
	 *
	 * `chapters.snapshotShadowKey` is what makes the second case distinguishable
	 * from a genuine orphan: it survives `worktreePath` being nulled. Callers that
	 * are deleting the chapter itself pass `force`.
	 */
	async destroy(
		worktreePath: string,
		deviceId: string = LOCAL_DEVICE_ID,
		options?: { force?: boolean },
	): Promise<boolean> {
		const dir = shadowDir(deviceId, worktreePath);
		if (!options?.force && (await isShadowRepoClaimed(deviceId, worktreePath))) {
			logger.warn("Kept a tree-snapshot repo that a chapter still references", {
				worktreePath,
			});
			return false;
		}
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		// A warm-up scanning the just-removed directory is pointless and its failure
		// would otherwise start a cooldown a recreated worktree at this path inherits.
		// Abort it, drop the in-flight entry so no caller shares a doomed scan, and
		// clear any cooldown set before the destroy was decided.
		preemptWarmCapture(dir);
		warmupInFlight.delete(dir);
		warmupCooldownUntil.delete(dir);
		excludeMtimes.delete(dir);
		// The force-add memo describes an index inside the directory just removed. A
		// recreated worktree at the same path hashes to the same shadow dir, so a leftover
		// entry would make its first capture skip staging tracked-but-ignored paths.
		trackedIgnoredCache.delete(dir);
		// The recorded hashes describe a repository that no longer exists, so leaving
		// them behind means every later reader has to probe the filesystem to discover
		// they are dangling. The doc comment always claimed this happened; it did not.
		await db
			.delete(worktreeTreeSnapshots)
			.where(
				and(
					eq(worktreeTreeSnapshots.deviceId, deviceId),
					eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(worktreePath)),
				),
			);
		// The in-memory write declarations describe this same directory, so they die
		// with it. Cleared here rather than at each call site because a leftover entry
		// would keep answering overlap questions for a path that no longer exists — and
		// a recreated worktree at the same path would inherit them.
		clearClaims(worktreePath);
		return true;
	},

	/**
	 * Repack every shadow repository, keeping everything still referenced.
	 *
	 * Repacking is necessary: each capture writes loose objects, so without it the
	 * repos grow with every tool call.
	 *
	 * What must *not* happen is pruning a snapshot the database still points at.
	 * Snapshot trees are unreachable by construction — `write-tree` creates no ref —
	 * so an unqualified prune is entitled to delete them, and did: with a 7-day
	 * window, any snapshot older than that disappeared while `narrator_tool_calls`,
	 * `narrator_messages` and `worktree_tree_snapshots` all still referenced it, and
	 * a rollback of older history could only report the snapshot as missing.
	 *
	 * Two changes fix that. Snapshots now live under `refs/nf/`, which makes them
	 * reachable and therefore exempt from pruning; and pruning is restricted to
	 * objects old enough to predate any lineage NarraFork would still be extending,
	 * so a repo written before refs existed is repacked without having its history
	 * deleted underneath it. The residue is bounded because identical content
	 * deduplicates by hash.
	 */
	async gcAll(): Promise<void> {
		if (!existsSync(SHADOW_ROOT)) return;
		for (const entry of readdirSync(SHADOW_ROOT, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = resolve(SHADOW_ROOT, entry.name);
			if (!existsSync(resolve(dir, "HEAD")) && !(await repairShadowHead(dir))) continue;
			// Serialized against captures: `gc` rewrites the object store, and a
			// concurrent `add -A`/`write-tree` in the same repo can fail or race with
			// the repack.
			await acquireShadowStructural(dir, async () => {
				// `--no-prune` is the load-bearing flag. Repacking is the point; deleting
				// unreachable objects is not, because "unreachable" is the normal state of
				// a snapshot recorded before the DAG existed, and the database is the real
				// reference for those.
				const result = await runGit(["gc", "--no-prune", "--quiet"], dir, dir);
				if (result.exitCode !== 0) {
					logger.warn("Tree snapshot gc failed", { dir, stderr: result.stderr });
				}
			});
		}
	},
};
