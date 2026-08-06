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
import { and, eq } from "drizzle-orm";
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
	opts?: { maxOutputBytes?: number },
): Promise<GitResult & { stdoutTruncated?: boolean }> {
	const result = await safeSpawn({
		cmd: ["git", "--git-dir", gitDir, "--work-tree", workTree, ...args],
		timeout: GIT_TIMEOUT_MS,
		maxOutputBytes: opts?.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES,
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
		...(result.stdoutTruncated && { stdoutTruncated: true }),
	};
}

/** Run one git command against the shadow repo with the real worktree attached. */
async function runGit(args: string[], gitDir: string, workTree: string): Promise<GitResult> {
	const result = await runGitRaw(args, gitDir, workTree);
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
		env: { ...process.env, GIT_INDEX_FILE: indexFile },
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
		env: { ...process.env, ...SNAPSHOT_IDENTITY },
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

	// Never snapshot the shadow repos themselves or the user's git metadata.
	parts.push("/.git/\n");
	await Bun.write(resolve(infoDir, "exclude"), parts.join("\n"));
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

export async function supportsMergeTree(): Promise<boolean> {
	if (mergeTreeSupported !== null) return mergeTreeSupported;
	try {
		const result = await safeSpawn({
			cmd: ["git", "merge-tree", "--write-tree", "-h"],
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
		return claimed != null;
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
	const readTree = await runGit(["read-tree", baseTree], dir, worktreePath);
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
function reportCaptureCost(worktreePath: string, dir: string, elapsed: number, ok: boolean): void {
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
			timeoutMs: GIT_TIMEOUT_MS,
		});
		return;
	}
	// A failed capture is what actually costs revert precision, so it is reported
	// even when it failed quickly (a stale lock, a vanished worktree).
	logger.warn("Workspace snapshot scan did not complete", {
		worktreePath,
		elapsedMs: elapsed,
		timeoutMs: GIT_TIMEOUT_MS,
		timedOut: elapsed >= GIT_TIMEOUT_MS,
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
 * A timeout is already handled safely: `safeSpawn` kills the child and reports a
 * non-zero exit (it does not throw), this throws {@link TreeSnapshotError}, and
 * `tryCapture` turns that into null so the tool itself is unaffected and the
 * boundary is simply recorded as absent. Git removes its own `index.lock` when
 * killed, so the next capture recovers on its own. Slow filesystems are therefore
 * an observability problem, which is what {@link reportCaptureCost} addresses.
 */
async function captureUnlocked(
	dir: string,
	worktreePath: string,
	deviceId: string,
): Promise<string> {
	await ensureShadowRepo(dir, worktreePath);
	const startedAt = Date.now();
	const added = await runGit(["add", "-A"], dir, worktreePath);
	reportCaptureCost(worktreePath, dir, Date.now() - startedAt, added.exitCode === 0);
	if (added.exitCode !== 0) {
		throw new TreeSnapshotError(`snapshot add failed: ${added.stderr}`);
	}
	const written = await runGit(["write-tree"], dir, worktreePath);
	if (written.exitCode !== 0 || !written.stdout) {
		throw new TreeSnapshotError(`snapshot write-tree failed: ${written.stderr}`);
	}
	const treeHash = written.stdout;
	await recordTreeHash(deviceId, worktreePath, treeHash);
	return treeHash;
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

	// Snapshot the present state first so the set of paths to delete is exact.
	const added = await runGit(["add", "-A"], dir, worktreePath);
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
			// the target tree's view but a directory on disk now.
			rmSync(absolute, { force: true, recursive: true });
		}

		// Load the target tree into the index, then materialise it on disk.
		const readTree = await runGit(["read-tree", treeHash], dir, worktreePath);
		if (readTree.exitCode !== 0) {
			throw new TreeSnapshotError(`restore read-tree failed: ${readTree.stderr}`);
		}
		const checkout = await runGit(["checkout-index", "-a", "-f"], dir, worktreePath);
		if (checkout.exitCode !== 0) {
			throw new TreeSnapshotError(`restore checkout-index failed: ${checkout.stderr}`);
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
				rmSync(absolute, { force: true, recursive: true });
			} catch {
				// The very condition that failed the restore can also block this one path.
				// Keep going: the remaining paths are still worth restoring, and the tree
				// comparison below decides whether the result counts as compensated.
			}
		}
		const readBack = await runGit(["read-tree", capturedTree], dir, worktreePath);
		if (readBack.exitCode !== 0) return false;
		// Scoped to the paths the restore was going to touch, and issued in batches.
		// `checkout-index -a` would rewrite every file in the worktree, so whatever
		// blocked the restore (a locked file, a read-only directory) would block the
		// compensation too even when it lies outside the change set.
		for (const batch of batchArgs(changedPaths)) {
			await runGit(["checkout-index", "-f", "--", ...batch], dir, worktreePath);
		}
		// Verified by hash rather than by exit code: what matters is that the bytes are
		// back, and a per-path failure outside the change set does not change that.
		const added = await runGit(["add", "-A"], dir, worktreePath);
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

export const worktreeTreeSnapshot = {
	/**
	 * Capture the current worktree state and return its tree hash.
	 *
	 * Writes only a tree object: no commit, no branch, and no change to the user's
	 * index. Identical states yield the same hash, so repeated calls are cheap and
	 * deduplicate naturally.
	 */
	async capture(worktreePath: string, deviceId: string = LOCAL_DEVICE_ID): Promise<string> {
		assertLocal(deviceId);
		const dir = shadowDir(deviceId, worktreePath);
		return shadowLock.acquire(dir, () => captureUnlocked(dir, worktreePath, deviceId));
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
		return shadowLock.acquire(dir, () =>
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
		return shadowLock.acquire(dir, async () => {
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
		return shadowLock.acquire(dir, async () => {
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
		await shadowLock.acquire(sourceDir, async () => {
			// Hash the target as it is now, using a scratch index so the source repo's
			// own index — which tracks the *source* worktree — is left alone.
			//
			// Kept OUTSIDE the shadow repository: the `finally` below removes it, but a
			// killed process cannot run that, and `gcAll` only ever deletes a shadow
			// directory for a missing `HEAD` — so a residue here would persist
			// indefinitely inside a directory that is otherwise entirely git-managed.
			// The system temp directory is swept by the OS, which is the whole point.
			const scratchIndex = resolve(tmpdir(), `nf-restore-into-${generateId()}.index`);
			let currentTree: string | null = null;
			try {
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
			} finally {
				rmSync(scratchIndex, { force: true });
				// git guards index writes with a sibling lock file; an interrupted `add`
				// can leave it behind, and it would then block a later reuse of this name.
				rmSync(`${scratchIndex}.lock`, { force: true });
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
						// directory on disk.
						rmSync(absolute, { force: true, recursive: true });
					}
				}
			}

			const readTree = await runGit(["read-tree", treeHash], sourceDir, targetWorktreePath);
			if (readTree.exitCode !== 0) {
				throw new TreeSnapshotError(`fork read-tree failed: ${readTree.stderr}`);
			}
			const checkout = await runGit(["checkout-index", "-a", "-f"], sourceDir, targetWorktreePath);
			if (checkout.exitCode !== 0) {
				throw new TreeSnapshotError(`fork checkout-index failed: ${checkout.stderr}`);
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
		return shadowLock.acquire(dir, async () => {
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
			return await shadowLock.acquire(dir, async () => {
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
			return await shadowLock.acquire(dir, async () => {
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
		await shadowLock.acquire(dir, async () => {
			await ensureShadowRepo(dir, worktreePath);
			const result = await runGit(["update-ref", ref, commitSha], dir, worktreePath);
			if (result.exitCode !== 0) {
				throw new TreeSnapshotError(`snapshot update-ref failed: ${result.stderr}`);
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
		return shadowLock.acquire(dir, () => getRefUnlocked(dir, worktreePath, ref));
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
		return shadowLock.acquire(dir, async () => {
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
		return shadowLock.acquire(dir, async () => {
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
			return shadowLock.acquire(targetDir, runFetch);
		}
		// Locked in a canonical order (sorted by directory) because a fork and a merge
		// can run in opposite directions between the same pair; locking in call order
		// would let the two deadlock against each other.
		const [first, second] = [sourceDir, targetDir].sort();
		return shadowLock.acquire(first, () => shadowLock.acquire(second, runFetch));
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
		return shadowLock.acquire(dir, async () => {
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
		return shadowLock.acquire(dir, async () => {
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
		return shadowLock.acquire(dir, async () => {
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
		return shadowLock.acquire(dir, () =>
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
		excludeMtimes.delete(dir);
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
			if (!existsSync(resolve(dir, "HEAD"))) {
				logger.warn("Removing invalid tree-snapshot repo (missing HEAD)", { dir });
				rmSync(dir, { recursive: true, force: true });
				continue;
			}
			// Serialized against captures: `gc` rewrites the object store, and a
			// concurrent `add -A`/`write-tree` in the same repo can fail or race with
			// the repack.
			await shadowLock.acquire(dir, async () => {
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
