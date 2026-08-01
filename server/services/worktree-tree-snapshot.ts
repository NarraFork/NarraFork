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
import { homedir } from "node:os";
import { resolve } from "node:path";
import { db } from "../db";
import { worktreeTreeSnapshots } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { AsyncMutex } from "../lib/async-mutex";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";
import { normalizePathForComparison } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";

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
): Promise<GitResult & { stdoutTruncated?: boolean }> {
	const result = await safeSpawn({
		cmd: ["git", "--git-dir", gitDir, "--work-tree", workTree, ...args],
		timeout: GIT_TIMEOUT_MS,
		maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
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
): Promise<{ paths: string[]; exitCode: number; stderr: string }> {
	const result = await runGitRaw(args, gitDir, workTree);
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
 * Mirror the worktree's ignore rules into the shadow repo.
 *
 * The shadow repo has its own `info/exclude` because it never sees the user's
 * `.git`. Without this, `git add -A` would capture build output and dependency
 * directories, making every snapshot enormous.
 */
async function syncExcludes(dir: string, worktreePath: string): Promise<void> {
	const infoDir = resolve(dir, "info");
	mkdirSync(infoDir, { recursive: true });
	const parts: string[] = [];

	const gitignorePath = resolve(worktreePath, ".gitignore");
	if (existsSync(gitignorePath)) {
		parts.push(readFileSync(gitignorePath, "utf-8"));
	}

	// For a linked worktree, `.git` is a file pointing at the real gitdir, so the
	// per-repo exclude file has to be resolved through it.
	let userExclude = resolve(worktreePath, ".git", "info", "exclude");
	const dotGitPath = resolve(worktreePath, ".git");
	try {
		if (statSync(dotGitPath).isFile()) {
			const match = readFileSync(dotGitPath, "utf-8").match(/^gitdir:\s*(.+)$/m);
			if (match) userExclude = resolve(match[1].trim(), "info", "exclude");
		}
	} catch {
		// No .git (plain directory) — the .gitignore rules above are all we have.
	}
	if (existsSync(userExclude)) parts.push(readFileSync(userExclude, "utf-8"));

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

/** Re-sync ignore rules only when .gitignore or global gitignore changed. */
async function syncExcludesIfStale(dir: string, worktreePath: string): Promise<void> {
	const gitignorePath = resolve(worktreePath, ".gitignore");
	let localMtime = 0;
	try {
		if (existsSync(gitignorePath)) localMtime = statSync(gitignorePath).mtimeMs;
	} catch {
		// Unreadable .gitignore — fall through and reuse whatever we have.
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

	// Combine both mtimes into a single cache key for the shadow dir
	const combinedKey = `${localMtime}:${globalMtime}`;
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
 */
export interface TreeBoundaryPair {
	before: string;
	after: string;
}

/** A maximal run of boundary pairs with no foreign write between them. */
export interface TreeRevertSegment {
	/** Start state of the run — what this segment is merged back toward. */
	before: string;
	/** End state of the run — the merge base for this segment. */
	after: string;
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
 */
export function planTreeRevertSegments(pairs: TreeBoundaryPair[]): TreeRevertSegment[] {
	const segments: TreeRevertSegment[] = [];
	for (const pair of pairs) {
		if (pair.before === pair.after) continue;
		const open = segments[segments.length - 1];
		if (open && open.after === pair.before) {
			open.after = pair.after;
			continue;
		}
		segments.push({ before: pair.before, after: pair.after });
	}
	return segments;
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
 * Exit 0 means a clean merge, 1 means conflicts, anything else is a real failure.
 */
async function mergeTreeUnlocked(
	dir: string,
	worktreePath: string,
	base: string,
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
			`--merge-base=${base}`,
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
 * Reverse each segment out of the current state, newest segment first, without
 * touching the worktree.
 *
 * Reversing is a three-way merge per segment with `base = segment.after`,
 * `ours = the state accumulated so far` and `theirs = segment.before`: git keeps
 * `ours` wherever `base` and `theirs` agree, so only the bytes that segment
 * introduced are rolled back.
 *
 * Segments are applied newest first so each merge base is the state that segment
 * actually produced, and the intermediate trees are chained in memory — the
 * worktree is written at most once, by the caller.
 *
 * A conflict aborts the chain: it means another actor's change overlaps the region
 * being reversed, and a conflicted tree carries conflict markers that must never
 * reach the working tree.
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
		if (merged.conflicts.length > 0) {
			return {
				currentTree,
				mergedTree: accumulated,
				conflicts: merged.conflicts,
				changedPaths: [],
			};
		}
		accumulated = merged.tree;
	}

	if (accumulated === currentTree) {
		return { currentTree, mergedTree: accumulated, conflicts: [], changedPaths: [] };
	}
	const changed = await runGitPaths(
		["diff-tree", "-r", "--name-only", "--no-commit-id", "-z", accumulated, currentTree],
		dir,
		worktreePath,
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
 * Capture the worktree without taking the shadow lock.
 *
 * `AsyncMutex` is not reentrant — `acquire` always queues behind the current
 * tail — so a composite operation that already holds the lock must call this
 * instead of {@link worktreeTreeSnapshot.capture}, which would deadlock.
 */
async function captureUnlocked(
	dir: string,
	worktreePath: string,
	deviceId: string,
): Promise<string> {
	await ensureShadowRepo(dir, worktreePath);
	const added = await runGit(["add", "-A"], dir, worktreePath);
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
	);
	if (changed.exitCode !== 0) {
		throw new TreeSnapshotError(`restore diff-tree failed: ${changed.stderr}`);
	}
	const changedPaths = changed.paths;

	// Paths absent from the target tree were created after it and must go.
	const inTarget = await runGitPaths(
		["ls-tree", "-r", "--name-only", "-z", treeHash],
		dir,
		worktreePath,
	);
	if (inTarget.exitCode !== 0) {
		throw new TreeSnapshotError(`restore ls-tree failed: ${inTarget.stderr}`);
	}
	const targetPaths = new Set(inTarget.paths);
	for (const relPath of changedPaths) {
		if (targetPaths.has(relPath)) continue;
		const absolute = resolve(worktreePath, relPath);
		if (existsSync(absolute)) rmSync(absolute, { force: true });
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
	return changedPaths;
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
		const result = await runGitPaths(
			["ls-tree", "-r", "--name-only", "-z", treeHash],
			dir,
			worktreePath,
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

	/** Remove a worktree's shadow repository and its recorded hashes. */
	async destroy(worktreePath: string, deviceId: string = LOCAL_DEVICE_ID): Promise<void> {
		const dir = shadowDir(deviceId, worktreePath);
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		excludeMtimes.delete(dir);
	},

	/** Prune loose objects across every shadow repository. */
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
			const result = await runGit(["gc", "--prune=7.days", "--quiet"], dir, dir);
			if (result.exitCode !== 0) {
				logger.warn("Tree snapshot gc failed", { dir, stderr: result.stderr });
			}
		}
	},
};
