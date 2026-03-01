import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { logger } from "../lib/logger";

const SNAPSHOTS_DIR = resolve(homedir(), ".narrafork", "snapshots");

export interface PatchInfo {
	beforeHash: string;
	afterHash: string;
	files: string[];
}

/** Shadow git directory for a chapter */
function shadowDir(chapterId: string): string {
	return resolve(SNAPSHOTS_DIR, chapterId);
}

interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** Execute a git command with --git-dir and --work-tree pointing to the shadow repo */
async function execGit(
	args: string[],
	gitDir: string,
	workTree: string,
	silent = false,
): Promise<ExecResult> {
	const proc = Bun.spawn(["git", "--git-dir", gitDir, "--work-tree", workTree, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	if (exitCode !== 0 && !silent) {
		logger.error("snapshot git command failed", {
			args: args.join(" "),
			gitDir,
			stderr: stderr.trim(),
			exitCode,
		});
	}
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

// --- Per-chapter concurrency lock ---

const locks = new Map<string, Promise<unknown>>();

/** Tracks the last-seen mtime of .gitignore per chapter to avoid redundant syncs. */
const excludeMtimes = new Map<string, number>();

async function withLock<T>(chapterId: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(chapterId) ?? Promise.resolve();
	let release: () => void = () => {};
	const lock = new Promise<void>((r) => {
		release = r;
	});
	locks.set(chapterId, lock);
	await prev;
	try {
		return await fn();
	} finally {
		release();
		if (locks.get(chapterId) === lock) locks.delete(chapterId);
	}
}

// --- Snapshot service ---

export const snapshot = {
	/** Initialise the shadow bare repo (idempotent). */
	async init(chapterId: string, worktreePath: string): Promise<void> {
		const dir = shadowDir(chapterId);
		if (existsSync(resolve(dir, "HEAD"))) return;
		mkdirSync(dir, { recursive: true });
		// --git-dir is already set by execGit, so just pass --bare
		const result = await execGit(["init", "--bare"], dir, worktreePath);
		if (result.exitCode !== 0) {
			throw new Error(`snapshot init failed: ${result.stderr}`);
		}
		await this.syncExcludes(chapterId, worktreePath);
	},

	/**
	 * Copy the worktree's .gitignore into the shadow repo's info/exclude
	 * so the same ignore rules apply when staging files.
	 */
	async syncExcludes(chapterId: string, worktreePath: string): Promise<void> {
		const dir = shadowDir(chapterId);
		const infoDir = resolve(dir, "info");
		mkdirSync(infoDir, { recursive: true });
		const excludePath = resolve(infoDir, "exclude");

		// Merge .gitignore from worktree
		const gitignorePath = resolve(worktreePath, ".gitignore");
		if (existsSync(gitignorePath)) {
			copyFileSync(gitignorePath, excludePath);
		}

		// Also copy the user project's .git/info/exclude if it exists.
		// Note: for git worktrees, .git is a file (not a directory), so this
		// path won't exist — worktree excludes live in the main repo's
		// .git/worktrees/<name>/info/exclude which we don't attempt to resolve.
		const userExclude = resolve(worktreePath, ".git", "info", "exclude");
		if (existsSync(userExclude) && existsSync(gitignorePath)) {
			// Append user exclude to the shadow exclude
			const existing = readFileSync(excludePath, "utf-8");
			const extra = readFileSync(userExclude, "utf-8");
			writeFileSync(excludePath, `${existing}\n${extra}`);
		} else if (existsSync(userExclude)) {
			copyFileSync(userExclude, excludePath);
		}
	},

	/**
	 * Stage all files and write a tree object. Returns the tree hash.
	 * This is very lightweight — no commit is created.
	 * Syncs exclude rules on each call so .gitignore changes are picked up.
	 */
	async track(chapterId: string, worktreePath: string): Promise<string> {
		return withLock(chapterId, async () => {
			const dir = shadowDir(chapterId);

			// Re-sync excludes only when .gitignore has changed
			const gitignorePath = resolve(worktreePath, ".gitignore");
			try {
				const mtime = existsSync(gitignorePath)
					? statSync(gitignorePath).mtimeMs
					: 0;
				if (mtime !== (excludeMtimes.get(chapterId) ?? -1)) {
					await this.syncExcludes(chapterId, worktreePath);
					excludeMtimes.set(chapterId, mtime);
				}
			} catch {
				// Non-fatal — proceed with stale excludes
			}

			await execGit(["add", "-A"], dir, worktreePath);
			const result = await execGit(["write-tree"], dir, worktreePath);
			if (result.exitCode !== 0) {
				throw new Error(`snapshot write-tree failed: ${result.stderr}`);
			}
			return result.stdout;
		});
	},

	/** List files changed between two tree hashes. */
	async diffFiles(
		chapterId: string,
		worktreePath: string,
		fromHash: string,
		toHash: string,
	): Promise<string[]> {
		const dir = shadowDir(chapterId);
		const result = await execGit(
			["diff-tree", "-r", "--name-only", "--no-commit-id", fromHash, toHash],
			dir,
			worktreePath,
		);
		return result.stdout.split("\n").filter(Boolean);
	},

	/** Full unified diff between two tree hashes. */
	async diff(
		chapterId: string,
		worktreePath: string,
		fromHash: string,
		toHash: string,
	): Promise<string> {
		const dir = shadowDir(chapterId);
		const result = await execGit(
			["diff-tree", "-r", "-p", fromHash, toHash],
			dir,
			worktreePath,
		);
		return result.stdout;
	},

	/**
	 * Revert files to their state at each patch's beforeHash.
	 * Patches should be provided in reverse chronological order.
	 */
	async revert(chapterId: string, worktreePath: string, patches: PatchInfo[]): Promise<void> {
		return withLock(chapterId, async () => {
			const dir = shadowDir(chapterId);
			for (const patch of patches) {
				// Load the before-tree into the index once per patch
				await execGit(["read-tree", patch.beforeHash], dir, worktreePath);

				for (const file of patch.files) {
					const lsResult = await execGit(
						["ls-tree", patch.beforeHash, "--", file],
						dir,
						worktreePath,
						true,
					);
					if (lsResult.stdout) {
						// File existed in the before snapshot — restore it from index
						await execGit(["checkout-index", "-f", "--", file], dir, worktreePath);
					} else {
						// File was newly created — delete it
						const filePath = resolve(worktreePath, file);
						if (existsSync(filePath)) rmSync(filePath);
					}
				}
			}
		});
	},

	/** Restore the entire worktree to a specific tree hash. */
	async restore(chapterId: string, worktreePath: string, treeHash: string): Promise<void> {
		return withLock(chapterId, async () => {
			const dir = shadowDir(chapterId);
			await execGit(["read-tree", treeHash], dir, worktreePath);
			await execGit(["checkout-index", "-a", "-f"], dir, worktreePath);
		});
	},

	/** Garbage-collect loose objects older than 7 days. */
	async gc(chapterId: string): Promise<void> {
		const dir = shadowDir(chapterId);
		if (!existsSync(dir)) return;
		await execGit(["gc", "--prune=7.days"], dir, dir);
	},

	/** Remove the shadow repository entirely. */
	async destroy(chapterId: string): Promise<void> {
		const dir = shadowDir(chapterId);
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		excludeMtimes.delete(chapterId);
	},
};
