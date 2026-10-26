/**
 * Content-addressed workspace snapshots.
 *
 * A snapshot is a git *tree* object written into a shadow repository that shares
 * no history with the user's repo: `git add -A` + `git write-tree` produces a
 * hash of the actual working-tree bytes, with no commit, branch, or index change
 * visible to the user.
 *
 * What the hashes are for: the narrator's tool hooks capture the workspace before
 * and after every file-mutating tool ({@link worktreeTreeSnapshot.tryCaptureHot}),
 * and the delta between the two ({@link worktreeTreeSnapshot.diffPathStatuses})
 * shows changes made by *any* actor — Bash, build scripts, external editors — that
 * no tool input describes. Edit previews read historical file contents back out of
 * a recorded tree ({@link worktreeTreeSnapshot.readFilePreviewAtTree}). Nothing in
 * this module writes to the workspace; file rollback is per-file and lives elsewhere.
 *
 * "Byte-exact" is an outcome that has to be engineered, not a property inherited from
 * using git. git's own content filters — `core.autocrlf`, `text=auto`, `filter=`,
 * `working-tree-encoding`, `ident` — will happily change bytes on the way in, so a
 * recorded tree would describe content that was never on disk, and a change confined
 * to what a filter normalises (line endings, an `$Id$` expansion) would be invisible
 * to the delta. {@link SHADOW_ATTRIBUTES} and {@link SHADOW_CONFIG_ENV} are what make
 * the promise true.
 *
 * Two exclusions are likewise load-bearing rather than housekeeping. `/.worktrees/` is
 * excluded because nested linked worktrees live there: when a workspace is a project's
 * repository root, `<root>/.worktrees/` holds other checkouts (including legacy ones
 * left on disk by older versions), and capturing them would attribute their writes to
 * this workspace. Conversely, files the real repository tracks *despite* an ignore rule
 * are force-added back in, because a file missing from the tree makes both boundaries
 * of a change identical and the change then reads as "nothing happened".
 *
 * Scope is `(deviceId, worktreePath)`, not a narrator: several narrators and their
 * subagents routinely share one workspace, and the snapshot describes the directory.
 *
 * Remote devices are not supported yet: the signature carries `deviceId` so the
 * call sites are already correct, and remote support becomes an implementation of
 * {@link runGit} over `ExecutionBackend.execCommand`.
 */

import { createHash } from "node:crypto";
import {
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	type Stats,
	statSync,
} from "node:fs";
import { lstat, open, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
	ToolEditPreviewSide,
	ToolEditPreviewUnavailableReason,
} from "@shared/tool-edit-preview";
import { db } from "../db";
import { worktreeTreeSnapshots } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { AsyncMutex } from "../lib/async-mutex";
import { canWriteOptionalDiskData, DiskSpaceError, guardDiskWrite } from "../lib/disk-safety";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";
import { normalizePathForComparison, pathsEqualForOS } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";
import { snapshotCaptureReceipts } from "./snapshot-capture-receipts";
import { treeSnapshotPhysicalDir as shadowDir, treeSnapshotKey } from "./tree-snapshot-paths";

export { treeSnapshotKey } from "./tree-snapshot-paths";

import {
	confirmLifecyclePathCreated,
	lifecycleCreationPath,
	revalidateLifecycleTarget,
	withLifecycleContext,
	withShadowCreationReservation,
} from "./worktree-lifecycle-guard";

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
 * returns null and the tool proceeds with that boundary recorded as absent.
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
 * toggle (`workspace.treeSnapshotsEnabled`) is the manual escape hatch.
 */
const WARMUP_FAILURE_COOLDOWN_MS = 15 * 60_000;

/** Cap on captured git output; tree hashes and status are tiny. */
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Cap on captured output for commands that list paths.
 *
 * A path listing is not "tiny": one line per file means a large change set or a
 * repository with many force-tracked paths blows past the 1 MB cap that suffices for
 * hashes, and the truncation guard would then turn an ordinary capture or diff into a
 * hard failure.
 */
const GIT_MAX_LISTING_BYTES = 32 * 1024 * 1024;

/**
 * Most paths passed to one git invocation, and the budget for that invocation's
 * argument bytes.
 *
 * The byte budget keeps a batched argv well under the platform's `ARG_MAX`
 * (≥256 KB even on the strictest supported systems).
 */
const ARGV_BATCH_PATHS = 256;
const ARGV_BATCH_BYTES = 96 * 1024;

/**
 * Most tracked-but-ignored paths force-added into one capture.
 *
 * The set is normally empty or a handful (`.env`, a checked-in build artefact), so
 * the cap only exists to stop a pathological repository — one that `git add -f`'d a
 * whole ignored dependency tree — from putting thousands of extra argv bytes and a
 * proportional index write on the tool-execution path. Past the cap the capture
 * fails: an omitted path must not be presented as absent in a complete tree.
 */
const MAX_TRACKED_IGNORED_PATHS = 5_000;

/**
 * Reserved directory holding a repository's nested linked worktrees.
 *
 * `<repository root>/.worktrees/<name>`: when a workspace *is* a repository root, a
 * capture of it would otherwise walk straight into every checkout nested there —
 * including legacy worktrees older versions left on disk, which are kept untouched.
 * See {@link syncExcludes} for why those must never be snapshotted.
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
	/** Kills the warm-up's current git process; used by preemption. */
	abort: AbortController;
	/**
	 * Set when a direct capture or maintenance claimed the shadow lock out from under
	 * the warm-up. A preempted warm-up is not evidence of a pathological worktree, so
	 * its failure must not start the failure cooldown.
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
 * shadow lock for its whole capture chain, so a direct capture or `gc` would
 * otherwise queue behind it for up to several git timeouts. Killing its `add -A` is
 * safe: git cleans up its own lock on SIGTERM, and the one hard-kill case (Windows)
 * is covered by removing the leftover lock below, once the shadow lock itself
 * proves no git can still be holding it.
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
 * Acquire the shadow lock for maintenance, preempting any warm-up first.
 *
 * Maintenance must never wait minutes behind a background scan whose only purpose
 * is to make *future* captures cheap.
 */
function acquireShadowPreemptingWarmup<T>(dir: string, fn: () => Promise<T>): Promise<T> {
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
	const timeoutMs = opts?.timeoutMs ?? GIT_TIMEOUT_MS;
	// safeSpawn currently returns the killed exit code but not its timeout cause.
	// Observe the same deadline without changing its process/cancellation behavior.
	let deadlineExpired = false;
	const deadline = setTimeout(() => {
		deadlineExpired = true;
	}, timeoutMs);
	try {
		const result = await safeSpawn({
			cmd: ["git", "--git-dir", gitDir, "--work-tree", workTree, ...args],
			timeout: timeoutMs,
			maxOutputBytes: opts?.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES,
			env: { ...process.env, ...SHADOW_CONFIG_ENV },
			...(opts?.signal && { signal: opts.signal }),
		});
		if (result.stdoutTruncated || result.stderrTruncated) {
			throw new TreeSnapshotError("snapshot git output exceeded the size limit");
		}
		return {
			stdout: result.stdout,
			stderr:
				deadlineExpired && result.exitCode !== 0
					? `snapshot git deadline exceeded (${timeoutMs}ms): ${result.stderr}`
					: result.stderr,
			exitCode: result.exitCode,
		};
	} finally {
		clearTimeout(deadline);
	}
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
 * Run a path-listing git command and return the paths verbatim.
 *
 * Every path-producing command must go through here with `-z`. Without it git
 * applies `core.quotePath`, which renders a non-ASCII name as an escaped, quoted
 * C string (`"\344\270\255..."`). That string is not a real path, so the file tree
 * would be told about a path that does not exist and show mojibake to the user.
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
 * That key is only sufficient while nothing but a capture's own `add` writes the
 * **shadow** index. Loading a tree into it (`read-tree`) would evict an introduced
 * entry without touching the real index, the key would still match, and the next
 * plain `add -A` would silently drop the path again — so any future code that rewrites
 * the shadow index must drop this memo first.
 */
const trackedIgnoredCache = new Map<string, { indexKey: string; paths: string[] }>();

/**
 * Locate the repository-level `info/exclude` that applies to a worktree.
 *
 * A workspace is often a *linked* worktree, where `.git` is a file pointing at
 * `<main>/.git/worktrees/<name>`. That per-worktree gitdir has no `info/` at all: the
 * repository-level exclude lives in the common dir, named by the `commondir` file next
 * to the pointer (relative to the gitdir, so it has to be resolved against it). Reading
 * `<gitdir>/info/exclude` therefore finds nothing in that shape, and the user's
 * repo-level ignore rules would silently never be mirrored — so build output would
 * enter snapshots and show up as a change on every build.
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
	// holds nested linked worktrees.
	//
	// `/.worktrees/` is not a convenience: when the workspace is a repository root, a
	// capture descends into `<root>/.worktrees/<name>` — other live checkouts, and
	// legacy worktrees older versions left on disk. A linked worktree enters the shadow
	// tree as a `160000 commit` gitlink, which makes the nested checkout's whole
	// directory a path in this workspace's tree, so its creation and removal would be
	// reported as this workspace's changes and attributed to whichever tool happened to
	// be running.
	//
	// Written here rather than relying on the user's `.gitignore` because that is a
	// file the user owns: an imported repository may never have had the entry, the
	// user may delete the line, and `.gitignore` is itself a snapshotted file. A rule
	// inside the shadow repo's own `info/exclude` is outside all of that.
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
 * The module's central promise is that a snapshot is *the bytes on disk*. git's
 * content filters break that promise, and the way they break it is uniquely
 * dangerous here: the difference is invisible to the tree hashes themselves. Measured
 * on git 2.47 with a shadow repo attached to a worktree via `--work-tree`:
 *
 *   - `* text=auto` in the *worktree's* `.gitattributes` applies, because attributes
 *     are read from the working tree. A CRLF file is stored as LF, so a recorded tree
 *     holds bytes that were never on disk and a line-ending-only rewrite produces the
 *     *same* tree — the change is invisible to the delta.
 *   - `core.autocrlf=true` inherited from the user's global config does the same to
 *     CRLF files even with no `.gitattributes` at all.
 *   - `filter=<name>` runs a clean filter, so a snapshot can store content that was
 *     never on disk.
 *   - `working-tree-encoding` is worse than lossy: `add -A` exits 128 outright when
 *     it cannot transcode, so the capture *fails* and the boundary is recorded as
 *     absent.
 *   - `ident` collapses an expanded `$Id: … $` to `$Id$`, which is a silent content
 *     change.
 *
 * `-text -filter -working-tree-encoding -ident` in `info/attributes` turns all of
 * that off. `info/attributes` is used rather than config because it out-ranks the
 * worktree's own `.gitattributes` in git's attribute precedence, which config cannot
 * do — a `.gitattributes` committed by the user would otherwise win.
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
	// Never translate line endings on the way in.
	["core.autocrlf", "false"],
	["core.eol", "lf"],
	// `safecrlf` only ever *rejects* content whose conversion would be irreversible;
	// with conversion disabled it has nothing to guard, and leaving it enabled would
	// turn an inherited `warn`/`true` into capture failures.
	["core.safecrlf", "false"],
	// A symlink must be recorded as a symlink. `core.symlinks=false` (inheritable on
	// Windows) tells git to treat links as small files holding the link text, which
	// is a different filesystem object than the one on disk.
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
	// could be missed by one capture, so that boundary pair would not report it.
	// git mitigates this with the same racy-clean re-validation the index stat
	// cache uses (entries at the tick boundary are re-scanned rather than trusted),
	// which is why this is on; the knob to disable the whole scan path on a
	// filesystem where it misbehaves is `workspace.treeSnapshotsEnabled`.
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
 * `tryCaptureHot` swallows into a null boundary, i.e. the whole workspace silently
 * losing every boundary. Counting the array cannot disagree with the array.
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

/** Inspect the directory entry, not a symlink's target. Only ENOENT proves absence. */
async function lstatIfPresent(absolute: string): Promise<Stats | null> {
	try {
		return await lstat(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new TreeSnapshotError(`snapshot could not inspect ${absolute}`, error);
	}
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

/** Cheap, bounded shape check: a lone HEAD or an arbitrary directory is not a repo. */
function hasShadowRepoLayout(dir: string, missingHead = false): boolean {
	try {
		if (!lstatSync(dir).isDirectory() || existsSync(resolve(dir, "commondir"))) return false;
		for (const name of ["objects", "refs"]) {
			if (!lstatSync(resolve(dir, name)).isDirectory()) return false;
		}
		for (const name of missingHead ? ["config"] : ["config", "HEAD"]) {
			const entry = lstatSync(resolve(dir, name));
			if (!entry.isFile() || entry.size > 64 * 1024) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** Validate without attaching a worktree (which would hide core.bare=false). */
async function validateShadowRepo(dir: string): Promise<void> {
	if (!hasShadowRepoLayout(dir)) throw new TreeSnapshotError("existing shadow repo is invalid");
	const before = lstatSync(dir);
	const canonical = realpathSync(dir);
	const result = await safeSpawn({
		cmd: ["git", "--git-dir", dir, "rev-parse", "--is-bare-repository", "--absolute-git-dir"],
		timeout: GIT_TIMEOUT_MS,
		maxOutputBytes: 4096,
		env: { ...process.env, ...SHADOW_CONFIG_ENV },
	});
	const after = lstatSync(dir);
	const [bare, gitDir] = result.stdout.trim().split("\n");
	// Windows realpath preserves the input casing, while Git reports the disk
	// spelling. Compare OS paths, but still require the exact directory identity.
	const reported = gitDir && existsSync(gitDir) ? lstatSync(gitDir) : null;
	if (
		result.exitCode !== 0 ||
		result.stdoutTruncated ||
		result.stderrTruncated ||
		bare !== "true" ||
		!gitDir ||
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		reported?.dev !== before.dev ||
		reported?.ino !== before.ino ||
		!pathsEqualForOS(realpathSync(dir), canonical, process.platform) ||
		!pathsEqualForOS(realpathSync(gitDir), canonical, process.platform)
	)
		throw new TreeSnapshotError("existing shadow repo is invalid or changed identity");
}

// Only a failed, exclusively created birth may resume init, including after restart.
// Fixed protocol, bounded to 256 bytes; not an ownership record for existing repos.
const SHADOW_INIT_MARKER = "nf-shadow-init";

function shadowInitMarkerContents(dir: string, worktreePath: string): string {
	const born = lstatSync(dir);
	const parent = lstatSync(resolve(dir, ".."));
	if (!born.isDirectory() || !parent.isDirectory())
		throw new TreeSnapshotError("shadow initialization directory identity is invalid");
	const key = createHash("sha256")
		.update(treeSnapshotKey(LOCAL_DEVICE_ID, worktreePath))
		.digest("hex");
	return `nf-shadow-init-v1\n${key}\n${born.dev}:${born.ino}\n${parent.dev}:${parent.ino}\n`;
}

async function hasValidShadowInitMarker(dir: string, worktreePath: string): Promise<boolean> {
	try {
		const expected = shadowInitMarkerContents(dir, worktreePath);
		const markerPath = resolve(dir, SHADOW_INIT_MARKER);
		const entry = await lstatIfPresent(markerPath);
		if (!entry?.isFile() || entry.size > 256) return false;
		const marker = await open(
			markerPath,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const stat = await marker.stat();
			if (!stat.isFile() || stat.size > 256 || stat.dev !== entry.dev || stat.ino !== entry.ino)
				return false;
			const buffer = Buffer.alloc(257);
			const { bytesRead } = await marker.read(buffer, 0, buffer.length, 0);
			return (
				buffer.subarray(0, bytesRead).toString("utf8") === expected &&
				shadowInitMarkerContents(dir, worktreePath) === expected
			);
		} finally {
			await marker.close();
		}
	} catch {
		return false;
	}
}

/** Create only an exclusively born shadow directory; never adopt unknown contents. */
async function ensureShadowRepo(dir: string, worktreePath: string): Promise<void> {
	// Shared checkout use freezes identities, not ownership. Keep the raw checkout
	// path for shadow keys; canonical paths are only lifecycle comparison identities.
	await withLifecycleContext([dir, worktreePath], async () => {
		// A retirement may take its final snapshot before removing the checkout.
		dir = await lifecycleCreationPath(dir);
		if (
			existsSync(resolve(dir, "HEAD")) &&
			!(await lstatIfPresent(resolve(dir, SHADOW_INIT_MARKER)))
		) {
			await validateShadowRepo(dir);
			dir = await revalidateLifecycleTarget(dir);
			await syncExcludesIfStale(dir, worktreePath);
			return;
		}
		// Only the physical cold birth is exclusive. The source checkout remains
		// shareable, and existing valid repos never need receipt migration here.
		await withShadowCreationReservation({ deviceId: LOCAL_DEVICE_ID, path: dir }, async () => {
			dir = await revalidateLifecycleTarget(dir);
			if (await lstatIfPresent(dir)) {
				if (!(await lstatIfPresent(resolve(dir, SHADOW_INIT_MARKER)))) {
					await validateShadowRepo(dir);
					dir = await revalidateLifecycleTarget(dir);
					await syncExcludesIfStale(dir, worktreePath);
					return;
				}
			} else {
				mkdirSync(resolve(dir, ".."), { recursive: true });
				dir = await revalidateLifecycleTarget(dir);
				// EEXIST is not permission to run git init against somebody else's directory.
				mkdirSync(dir);
				const born = lstatSync(dir);
				if (!born.isDirectory()) throw new TreeSnapshotError("shadow birth is not a directory");
				await confirmLifecyclePathCreated(dir, `${born.dev}:${born.ino}`);
				dir = await revalidateLifecycleTarget(dir);
				try {
					await writeFile(
						resolve(dir, SHADOW_INIT_MARKER),
						shadowInitMarkerContents(dir, worktreePath),
						{
							flag: "wx",
							mode: 0o600,
						},
					);
				} catch (error) {
					throw new TreeSnapshotError(
						`shadow initialization marker creation failed: ${String(error)}`,
					);
				}
			}
			dir = await revalidateLifecycleTarget(dir);
			if (!(await hasValidShadowInitMarker(dir, worktreePath)))
				throw new TreeSnapshotError("shadow initialization marker is invalid or changed identity");
			// `git init --bare` rejects --work-tree, so this cannot go through runGit.
			const result = await safeSpawn({
				cmd: ["git", "init", "--bare", dir],
				timeout: GIT_TIMEOUT_MS,
				maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
			});
			if (result.exitCode !== 0) {
				// Retain even our own failed birth: partial files are evidence, not garbage.
				throw new TreeSnapshotError(`shadow repo init failed: ${result.stderr.trim()}`);
			}
			dir = await revalidateLifecycleTarget(dir);
			if (!(await hasValidShadowInitMarker(dir, worktreePath)))
				throw new TreeSnapshotError("shadow initialization marker is invalid or changed identity");
			await validateShadowRepo(dir);
			dir = await revalidateLifecycleTarget(dir);
			await syncExcludes(dir, worktreePath);
			dir = await revalidateLifecycleTarget(dir);
			if (!(await hasValidShadowInitMarker(dir, worktreePath)))
				throw new TreeSnapshotError("shadow initialization marker is invalid or changed identity");
			await unlink(resolve(dir, SHADOW_INIT_MARKER));
			excludeMtimes.delete(dir);
		});
	});
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

/** Whether a background warm-up is registered for this worktree. Test-only observation. */
export function hasHotPathWarmupForTests(
	worktreePath: string,
	deviceId: string = LOCAL_DEVICE_ID,
): boolean {
	return warmupInFlight.has(shadowDir(deviceId, worktreePath));
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
		if (batch.length > 0 && (batch.length >= ARGV_BATCH_PATHS || bytes + size > ARGV_BATCH_BYTES)) {
			yield batch;
			batch = [];
			bytes = 0;
		}
		batch.push(value);
		bytes += size;
	}
	if (batch.length > 0) yield batch;
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
	// A failed capture is what actually costs a boundary, so it is reported even
	// when it failed quickly (a stale lock, a vanished worktree).
	logger.warn("Workspace snapshot scan did not complete", {
		worktreePath,
		elapsedMs: elapsed,
		timeoutMs,
		timedOut: elapsed >= timeoutMs,
	});
}

/**
 * Capture the worktree; the caller holds the shadow lock.
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
 *     boundary, and a Bash command's, build script's or external editor's writes in
 *     that window are then invisible: no tool input describes them, and the tree
 *     delta was the only thing that could.
 *
 * A timeout is handled safely: `safeSpawn` kills the child and reports a non-zero
 * exit (it does not throw), this throws {@link TreeSnapshotError}, and
 * `tryCaptureHot` turns that into null so the tool itself is unaffected and the
 * boundary is simply recorded as absent. Slow filesystems are therefore an
 * observability problem, which is what {@link reportCaptureCost} addresses.
 *
 * The residue a kill leaves behind is *not* self-healing. git removes its own
 * `index.lock` on `SIGTERM` because it installs a signal handler for it — but not on
 * `SIGKILL` or an OOM kill, where no userspace code runs at all. The lock then
 * survives forever, every subsequent `add -A` in that shadow repo exits 128,
 * `tryCaptureHot` returns null every time, and the whole workspace silently and
 * permanently loses its boundaries. That is why {@link recoverStaleIndexLock} exists.
 */
async function captureUnlocked(
	dir: string,
	worktreePath: string,
	deviceId: string,
	opts?: { gitTimeoutMs?: number; signal?: AbortSignal },
): Promise<string> {
	opts?.signal?.throwIfAborted();
	// Do not amplify a low-space condition with git objects/indexes or capture receipts.
	// tryCaptureHot already degrades this failure to a missing boundary.
	if (!(await canWriteOptionalDiskData(dir))) throw new DiskSpaceError(dir);
	await guardDiskWrite(dir);
	// One receipt per real scan, inside the shadow lock, never per hash/caller.
	// This observer acquires no workspace lock and cannot authorize a restore.
	const receipts = snapshotCaptureReceipts();
	const attempt = await receipts.begin(worktreePath, deviceId);
	let observedTree: string | undefined;
	let failed: unknown;
	try {
		opts?.signal?.throwIfAborted();
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
		const written = await runGit(
			["write-tree"],
			dir,
			worktreePath,
			opts?.gitTimeoutMs,
			opts?.signal,
		);
		if (written.exitCode !== 0 || !written.stdout) {
			throw new TreeSnapshotError(`snapshot write-tree failed: ${written.stderr}`);
		}
		opts?.signal?.throwIfAborted();
		const treeHash = written.stdout;
		await recordTreeHash(deviceId, worktreePath, treeHash);
		observedTree = treeHash;
		return treeHash;
	} catch (error) {
		failed = error;
		throw error;
	} finally {
		// A timed-out hot caller has already returned null. Finishing this receipt
		// never revisits its tool/message before/after fields or session cache.
		await receipts.finish(
			attempt,
			observedTree
				? { treeHash: observedTree }
				: {
						reason: opts?.signal?.aborted
							? "cancelled"
							: /timed?\s*out|timeout|deadline exceeded|output.*(?:limit|exceed|truncat)/i.test(
										String(failed),
									)
								? "budget_exceeded"
								: "capture_failed",
					},
		);
	}
}

/**
 * Stage every path that belongs in a snapshot.
 *
 * Two steps, because `add -A` alone has a blind spot that costs data. It honours the
 * shadow repo's mirrored ignore rules, and a file the *real* repository tracks
 * despite an ignore rule — `git add -f .env` with `.env` in `.gitignore`, a checked-in
 * `dist/` artefact — is therefore absent from every snapshot. Measured consequence:
 * a tool rewrites `.env`, the before and after boundary hashes come out *identical*
 * because neither contains the file, and the modification reads as "this call
 * changed nothing" with no warning anywhere.
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
 *     snapshots.
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
	const addArgs = ["add", "-A", "--no-warn-embedded-repo"];
	const added = await runGit(addArgs, dir, worktreePath, gitTimeoutMs, signal);
	// Never retry with --ignore-errors: a skipped path is unknown, not absent.
	// Publishing that index as a tree would report the path as deleted.
	if (added.exitCode !== 0) return added;
	// Git can exit zero after warning that an unreadable directory was skipped.
	// Suppress only the known, non-coverage embedded-repo advice above; all other
	// staging diagnostics leave coverage uncertain and must fail closed.
	if (added.stderr) {
		throw new TreeSnapshotError(`snapshot add coverage is incomplete: ${added.stderr}`);
	}

	try {
		const forced = await trackedButIgnoredPaths(dir, worktreePath);
		for (const batch of batchArgs(forced)) {
			const result = await runGit(
				[...addArgs, "--force", "--", ...batch],
				dir,
				worktreePath,
				gitTimeoutMs,
				signal,
			);
			if (result.exitCode !== 0) {
				// A failed introduction must be retried on the next real capture, not
				// hidden by the real-index memo. No partial tree may become a boundary.
				trackedIgnoredCache.delete(dir);
				return result;
			}
			if (result.stderr) {
				throw new TreeSnapshotError(`snapshot force-add coverage is incomplete: ${result.stderr}`);
			}
		}
		return added;
	} catch (error) {
		trackedIgnoredCache.delete(dir);
		throw error;
	}
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
 * Any failed or truncated query leaves coverage unknown and fails the capture.
 * Only a confirmed non-repository has no tracked paths by definition.
 */
async function trackedButIgnoredPaths(dir: string, worktreePath: string): Promise<string[]> {
	const indexKey = realIndexIdentity(worktreePath);
	const cached = trackedIgnoredCache.get(dir);
	if (indexKey !== null && cached?.indexKey === indexKey) return [];

	const result = await safeSpawn({
		cmd: ["git", "ls-files", "-i", "-c", "--exclude-standard", "-z"],
		cwd: worktreePath,
		timeout: GIT_TIMEOUT_MS,
		maxOutputBytes: GIT_MAX_LISTING_BYTES,
		env: { ...process.env, LC_ALL: "C" },
	});
	if (result.stdoutTruncated || result.stderrTruncated) {
		throw new TreeSnapshotError("snapshot tracked path listing exceeded the size limit");
	}
	if (result.exitCode !== 0) {
		if (result.exitCode === 128 && result.stderr.startsWith("fatal: not a git repository")) {
			return [];
		}
		throw new TreeSnapshotError(`snapshot tracked path listing failed: ${result.stderr}`);
	}
	if (result.stderr.trim()) {
		throw new TreeSnapshotError(`snapshot tracked path coverage is incomplete: ${result.stderr}`);
	}
	const paths = result.stdout.split("\0").filter(Boolean);
	if (paths.length > MAX_TRACKED_IGNORED_PATHS) {
		throw new TreeSnapshotError("snapshot tracked path count exceeded the size limit");
	}
	const present = paths.filter((relPath) => {
		try {
			// Unlike existsSync, lstat distinguishes unreadable from absent and keeps
			// dangling symlinks, whose link bytes still belong in the snapshot.
			lstatSync(resolve(worktreePath, relPath));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw new TreeSnapshotError("snapshot could not inspect a tracked path", error);
		}
	});
	// addAllUnlocked clears this tentative memo if any force-add fails or throws.
	// Do not memoize an omitted path: it can reappear without a real-index change.
	if (indexKey !== null && present.length === paths.length) {
		trackedIgnoredCache.set(dir, { indexKey, paths: present });
	}
	return present;
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
 * `tryCaptureHot` swallows that into null, so the user sees no error at all while
 * every boundary from then on is missing.
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
 * Put a missing `HEAD` back rather than deleting the repository around it.
 *
 * The orphan sweep used to treat a missing HEAD as "invalid, delete the directory". That is
 * a data-loss bug rather than a cleanup: `HEAD` is a 23-byte pointer whose *target*
 * is never read (every command names its object explicitly, and repositories written by
 * older versions keep their snapshot lineage under `refs/nf/`), while `objects/` beside it
 * holds every tree that `narrator_tool_calls`, `narrator_messages` and
 * `worktree_tree_snapshots` still reference. A truncated write, a full disk or an
 * interrupted `git init` therefore cost a workspace its entire recorded history.
 *
 * Unknown and incomplete directories are always retained. Recognizable bare repos
 * with objects or refs can have their missing HEAD restored under the shadow mutex;
 * git then verifies the result before maintenance continues.
 *
 * Returns whether the repository is usable afterwards.
 */
async function repairShadowHead(dir: string): Promise<boolean> {
	if (!hasShadowRepoLayout(dir, true) || !shadowDirHasContent(dir)) {
		logger.warn("Keeping an incomplete tree-snapshot directory with missing HEAD", { dir });
		return false;
	}
	try {
		const before = lstatSync(dir);
		const bare = await safeSpawn({
			cmd: ["git", "config", "--file", resolve(dir, "config"), "--bool", "--get", "core.bare"],
			timeout: GIT_TIMEOUT_MS,
			maxOutputBytes: 4096,
		});
		const after = lstatSync(dir);
		if (
			bare.exitCode !== 0 ||
			bare.stdout.trim() !== "true" ||
			bare.stdoutTruncated ||
			bare.stderrTruncated ||
			!after.isDirectory() ||
			before.dev !== after.dev ||
			before.ino !== after.ino
		)
			return false;
		await writeFile(resolve(dir, "HEAD"), "ref: refs/heads/main\n", { flag: "wx" });
	} catch (error) {
		logger.warn("Could not repair a tree-snapshot repo's missing HEAD; keeping it as is", {
			dir,
			error: String(error),
		});
		return false;
	}
	try {
		await validateShadowRepo(dir);
	} catch (error) {
		logger.warn("Tree-snapshot repo is still unusable after restoring HEAD; keeping it", {
			dir,
			error: String(error),
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
	// A ref whose objects are gone is still evidence the repo was in use (older versions
	// wrote snapshot lineage under `refs/nf/`), and the packed form lives in a file rather
	// than under `refs/`.
	return hasEntries(resolve(dir, "refs", "nf")) || existsSync(resolve(dir, "packed-refs"));
}

export const worktreeTreeSnapshot = {
	/**
	 * Capture the current worktree state and return its tree hash.
	 *
	 * Writes only a tree object: no commit, no branch, and no change to the user's
	 * index. Identical states yield the same hash, so repeated calls are cheap and
	 * deduplicate naturally.
	 *
	 * Production goes through {@link tryCaptureHot}, which calls this with a signal;
	 * the method stays separate because that is the seam the warm-up runs through.
	 */
	async capture(
		worktreePath: string,
		deviceId: string = LOCAL_DEVICE_ID,
		opts?: { gitTimeoutMs?: number; signal?: AbortSignal },
	): Promise<string> {
		assertLocal(deviceId);
		const dir = shadowDir(deviceId, worktreePath);
		// A caller carrying a signal is the warm-up itself (the thing that can BE
		// preempted); a caller without one is a direct capture and must not queue
		// behind a background scan for minutes.
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
	 *      like {@link capture}. Still running at the budget → return null and let
	 *      it finish in the background: a completed `add -A` writes the index that
	 *      makes every later capture cheap, so the worktree self-heals.
	 *
	 * Only a failure that outlived the budget starts the cooldown — a fast failure
	 * (a vanished worktree, a transient lock) keeps the retry-next-time behaviour it
	 * has always had, as does a preemption by a direct capture or maintenance.
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
			/** Never reuse a scan already in flight, including one started in the same ms. */
			requireFresh?: boolean;
		},
	): Promise<string | null> {
		const budgetMs = opts?.budgetMs ?? HOT_PATH_CAPTURE_BUDGET_MS;
		const warmupGitTimeoutMs = opts?.warmupGitTimeoutMs ?? WARMUP_GIT_TIMEOUT_MS;
		const cooldownMs = opts?.cooldownMs ?? WARMUP_FAILURE_COOLDOWN_MS;
		const minStartedAt = opts?.minStartedAt;
		const deadline = Date.now() + budgetMs;
		try {
			assertLocal(deviceId);
			const dir = shadowDir(deviceId, worktreePath);
			// Low space is recoverable on the disk-cache TTL, not the 15-minute warmup
			// failure cooldown. Refuse before launching a scan or creating a receipt.
			if (!(await raceBudget(canWriteOptionalDiskData(dir), Math.max(0, deadline - Date.now())))) {
				logger.warn("Workspace snapshot skipped: low disk space or disk check over budget", {
					worktreePath,
				});
				return null;
			}

			const cooldownUntil = warmupCooldownUntil.get(dir);
			if (cooldownUntil !== undefined) {
				if (Date.now() < cooldownUntil) {
					logger.debug("Workspace snapshot skipped: warm-up failure cooldown", {
						worktreePath,
						cooldownUntil,
					});
					return null;
				}
				warmupCooldownUntil.delete(dir);
			}

			let remainingMs = Math.max(0, deadline - Date.now());
			for (;;) {
				const inFlight = warmupInFlight.get(dir);
				if (!inFlight) break;
				if (
					!opts?.requireFresh &&
					(minStartedAt === undefined || inFlight.startedAt >= minStartedAt)
				) {
					return (await raceBudget(inFlight.promise, remainingMs)) ?? null;
				}
				// The shared scan started before the caller's cutoff: its tree may mix
				// bytes from before and after the writes being measured — a state that
				// never existed on disk, worthless (and misleading) as a boundary. Wait
				// for it to settle — it warms the index either way — then loop to
				// re-capture with what budget remains; a too-slow settle degrades to
				// null, exactly like any other over-budget capture.
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
				// A preempted warm-up was killed by a direct capture or maintenance, not by
				// a pathological worktree — its failure must not pause future captures.
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
				if (outcome.ok) return outcome.hash;
				// A fast failure keeps retry-next-time semantics, but its cause must be
				// visible: the caller only knows the boundary is missing.
				logger.warn("Workspace snapshot capture failed", {
					worktreePath,
					error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
				});
				return null;
			}
			sawBudgetExpiry = true;
			logger.warn("Workspace snapshot exceeded the hot-path budget; continuing in background", {
				worktreePath,
				budgetMs,
			});
			return null;
		} catch (error) {
			logger.warn("Hot-path tree snapshot capture failed", {
				worktreePath,
				deviceId,
				error: String(error),
			});
			return null;
		}
	},

	/** Bounded historical preview; an omitted tree path is not proof of disk absence. */
	async readFilePreviewAtTree(
		worktreePath: string,
		treeHash: string,
		relPath: string,
		deviceId: string,
		maxBytes: number,
		opts: { signal: AbortSignal; timeoutMs: number },
	): Promise<ToolEditPreviewSide> {
		const unavailable = (reason: ToolEditPreviewUnavailableReason): ToolEditPreviewSide => ({
			status: "unavailable",
			reason,
		});
		const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]);
		const aborted = () =>
			unavailable(signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled");
		if (signal.aborted) return aborted();
		if (deviceId !== LOCAL_DEVICE_ID) return unavailable("unsupported");
		if (
			!/^[a-f0-9]{40,64}$/.test(treeHash) ||
			!relPath ||
			relPath.startsWith("/") ||
			relPath.split("/").some((part) => part === ".." || part === ".")
		)
			return unavailable("unsupported");
		const dir = shadowDir(deviceId, worktreePath);
		const run = (args: string[], limit: number) =>
			safeSpawn({
				cmd: ["git", "--git-dir", dir, "--work-tree", worktreePath, ...args],
				timeout: opts.timeoutMs,
				signal,
				maxOutputBytes: limit,
				env: { ...process.env, ...SHADOW_CONFIG_ENV, GIT_LITERAL_PATHSPECS: "1" },
			});
		try {
			const entry = await run(["ls-tree", "-l", "-z", treeHash, "--", relPath], 16 * 1024);
			if (signal.aborted) return aborted();
			if (entry.exitCode !== 0) return unavailable("missing_evidence");
			if (entry.stdoutTruncated) return unavailable("too_large");
			// Snapshots exclude ignored paths. No entry can mean an existing file was
			// omitted, so neither current disk contents nor current ignore rules can
			// upgrade this historical coverage gap into proof of absence.
			if (!entry.stdout) return unavailable("missing_evidence");
			const tab = entry.stdout.indexOf("\t");
			const [mode, type, oid, sizeText] = entry.stdout.slice(0, tab).trim().split(/\s+/);
			if (tab < 0 || entry.stdout.slice(tab + 1) !== `${relPath}\0`)
				return unavailable("ambiguous");
			if (type !== "blob" || (mode !== "100644" && mode !== "100755"))
				return unavailable("unsupported");
			const size = Number(sizeText);
			if (!Number.isSafeInteger(size) || size < 0) return unavailable("unreadable");
			if (size > maxBytes) return unavailable("too_large");
			const body = await run(["cat-file", "blob", oid], maxBytes);
			if (signal.aborted) return aborted();
			if (body.stdoutTruncated) return unavailable("too_large");
			if (body.exitCode !== 0) return unavailable("unreadable");
			if (body.stdout.includes("\0")) return unavailable("binary");
			// safeSpawn decodes stdout. Verify the re-encoded Git blob identity so invalid
			// UTF-8 (or a stripped BOM) can never silently become plausible historic text.
			const actual = createHash(oid.length === 64 ? "sha256" : "sha1")
				.update(`blob ${size}\0`)
				.update(body.stdout, "utf8")
				.digest("hex");
			if (Buffer.byteLength(body.stdout, "utf8") !== size || actual !== oid)
				return unavailable("invalid_encoding");
			return { status: "available", content: body.stdout };
		} catch {
			return signal.aborted ? aborted() : unavailable("unreadable");
		}
	},

	/**
	 * Paths that differ between two snapshots, and HOW each changed.
	 *
	 * The per-tool-call change feed: the file tree patches from it and attribution
	 * derives a call's owned paths from it.
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
	 * every later reader could only report the snapshot as missing. `--no-prune` is
	 * what prevents that. Repositories written by older versions also carry snapshot
	 * lineage refs under `refs/nf/`; gc leaves those, and everything else in an
	 * existing repository, in place. The residue is bounded because identical content
	 * deduplicates by hash.
	 *
	 * Nothing here ever deletes a shadow repository: an invalid or incomplete one is
	 * kept as evidence and skipped.
	 */
	async gcAll(): Promise<void> {
		if (!existsSync(SHADOW_ROOT)) return;
		for (const entry of readdirSync(SHADOW_ROOT, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = resolve(SHADOW_ROOT, entry.name);
			// Serialized against captures: HEAD repair and `gc` both mutate the repo; a
			// concurrent `add -A`/`write-tree` in the same repo can fail or race with
			// the repack.
			await acquireShadowPreemptingWarmup(dir, async () => {
				// Initialization evidence is not a maintenance candidate, even if HEAD exists.
				if (await lstatIfPresent(resolve(dir, SHADOW_INIT_MARKER))) return;
				if (!existsSync(resolve(dir, "HEAD"))) {
					if (!(await repairShadowHead(dir))) return;
				} else {
					try {
						await validateShadowRepo(dir);
					} catch (error) {
						logger.warn("Keeping an invalid tree-snapshot repo without maintenance", {
							dir,
							error: String(error),
						});
						return;
					}
				}
				// `--no-prune` is the load-bearing flag. Repacking is the point; deleting
				// unreachable objects is not, because "unreachable" is the normal state of
				// every snapshot tree, and the database is the real reference for those.
				const result = await runGit(["gc", "--no-prune", "--quiet"], dir, dir);
				if (result.exitCode !== 0) {
					logger.warn("Tree snapshot gc failed", { dir, stderr: result.stderr });
				}
			});
		}
	},
};
