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

/** Run one git command against the shadow repo with the real worktree attached. */
async function runGit(args: string[], gitDir: string, workTree: string): Promise<GitResult> {
	const result = await safeSpawn({
		cmd: ["git", "--git-dir", gitDir, "--work-tree", workTree, ...args],
		timeout: GIT_TIMEOUT_MS,
		maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
	});
	return {
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
		exitCode: result.exitCode,
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
		return shadowLock.acquire(dir, async () => {
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
		const result = await runGit(["ls-tree", "-r", "--name-only", treeHash], dir, worktreePath);
		if (result.exitCode !== 0) {
			throw new TreeSnapshotError(`snapshot ls-tree failed: ${result.stderr}`);
		}
		return result.stdout.split("\n").filter(Boolean);
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
		const result = await runGit(
			["diff-tree", "-r", "--name-only", "--no-commit-id", fromTree, toTree],
			dir,
			worktreePath,
		);
		if (result.exitCode !== 0) {
			throw new TreeSnapshotError(`snapshot diff-tree failed: ${result.stderr}`);
		}
		return result.stdout.split("\n").filter(Boolean);
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
	): Promise<string[]> {
		assertLocal(deviceId);
		const dir = shadowDir(deviceId, worktreePath);
		return shadowLock.acquire(dir, async () => {
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
			if (currentTree.stdout === treeHash) return [];

			const changed = await runGit(
				["diff-tree", "-r", "--name-only", "--no-commit-id", treeHash, currentTree.stdout],
				dir,
				worktreePath,
			);
			if (changed.exitCode !== 0) {
				throw new TreeSnapshotError(`restore diff-tree failed: ${changed.stderr}`);
			}
			const changedPaths = changed.stdout.split("\n").filter(Boolean);

			// Paths absent from the target tree were created after it and must go.
			const inTarget = await runGit(["ls-tree", "-r", "--name-only", treeHash], dir, worktreePath);
			if (inTarget.exitCode !== 0) {
				throw new TreeSnapshotError(`restore ls-tree failed: ${inTarget.stderr}`);
			}
			const targetPaths = new Set(inTarget.stdout.split("\n").filter(Boolean));
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
