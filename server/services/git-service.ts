import { logger } from "../lib/logger";

interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Per-worktree mutex to prevent concurrent git write operations.
 * Read-only operations (status, diff, log) don't need locking.
 */
const worktreeLocks = new Map<string, Promise<unknown>>();

async function withWorktreeLock<T>(worktreePath: string, fn: () => Promise<T>): Promise<T> {
	const prev = worktreeLocks.get(worktreePath) ?? Promise.resolve();
	let resolve: () => void = () => {};
	const lock = new Promise<void>((r) => {
		resolve = r;
	});
	worktreeLocks.set(worktreePath, lock);
	await prev;
	try {
		return await fn();
	} finally {
		resolve();
		if (worktreeLocks.get(worktreePath) === lock) {
			worktreeLocks.delete(worktreePath);
		}
	}
}

export interface GitStatusSummary {
	hasChanges: boolean;
	staged: number;
	unstaged: number;
	untracked: number;
	/** Capped at 200 entries. Use `totalFiles` for the real count. */
	files: Array<{ status: string; path: string }>;
	/** Total number of changed files (may exceed files.length). */
	totalFiles: number;
	headSha: string;
	branch: string;
}

async function exec(args: string[], cwd: string, silent = false): Promise<ExecResult> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	if (exitCode !== 0 && !silent) {
		logger.error("git command failed", { args: args.join(" "), cwd, stderr, exitCode });
	}
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export const gitService = {
	async getCurrentBranch(repoPath: string): Promise<string> {
		const result = await exec(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
		return result.stdout;
	},

	async branchExists(repoPath: string, branchName: string): Promise<boolean> {
		const result = await exec(["rev-parse", "--verify", branchName], repoPath);
		return result.exitCode === 0;
	},

	async createBranch(repoPath: string, branchName: string, baseBranch: string): Promise<void> {
		const result = await exec(["branch", branchName, baseBranch], repoPath);
		if (result.exitCode !== 0) throw new Error(`Failed to create branch: ${result.stderr}`);
	},

	async createWorktree(repoPath: string, worktreePath: string, branchName: string): Promise<void> {
		const result = await exec(["worktree", "add", worktreePath, branchName], repoPath);
		if (result.exitCode !== 0) throw new Error(`Failed to create worktree: ${result.stderr}`);
	},

	async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
		const result = await exec(["worktree", "remove", worktreePath, "--force"], repoPath);
		if (result.exitCode !== 0) throw new Error(`Failed to remove worktree: ${result.stderr}`);
	},

	async pruneWorktrees(repoPath: string): Promise<void> {
		await exec(["worktree", "prune"], repoPath);
	},

	async deleteBranch(repoPath: string, branchName: string): Promise<void> {
		await exec(["branch", "-D", branchName], repoPath);
	},

	async isGitRepo(path: string): Promise<boolean> {
		const result = await exec(["rev-parse", "--is-inside-work-tree"], path);
		return result.exitCode === 0;
	},

	async getHeadCommit(repoPath: string): Promise<string> {
		const result = await exec(["rev-parse", "HEAD"], repoPath);
		if (result.exitCode !== 0) throw new Error(`Failed to get HEAD commit: ${result.stderr}`);
		return result.stdout;
	},

	async getCommitsAhead(
		worktreePath: string,
		baseBranch: string,
	): Promise<{ count: number; baseBranch: string }> {
		const result = await exec(["rev-list", "--count", `${baseBranch}..HEAD`], worktreePath, true);
		return {
			count: result.exitCode === 0 ? Number.parseInt(result.stdout, 10) || 0 : 0,
			baseBranch,
		};
	},

	async getUncommittedLineStats(worktreePath: string): Promise<{ added: number; removed: number }> {
		// staged + unstaged diff against HEAD
		const tracked = await exec(["diff", "HEAD", "--numstat"], worktreePath, true);
		// untracked files
		const untracked = await exec(
			["ls-files", "--others", "--exclude-standard"],
			worktreePath,
			true,
		);

		let added = 0;
		let removed = 0;

		if (tracked.exitCode === 0 && tracked.stdout) {
			for (const line of tracked.stdout.split("\n").filter(Boolean)) {
				const [a, r] = line.split("\t");
				if (a !== "-") added += Number.parseInt(a, 10) || 0;
				if (r !== "-") removed += Number.parseInt(r, 10) || 0;
			}
		}

		// count lines in untracked files
		if (untracked.exitCode === 0 && untracked.stdout) {
			const files = untracked.stdout.split("\n").filter(Boolean);
			for (const file of files) {
				try {
					const proc = Bun.spawn(["wc", "-l", file], {
						cwd: worktreePath,
						stdout: "pipe",
						stderr: "pipe",
					});
					const out = await new Response(proc.stdout).text();
					added += Number.parseInt(out.trim(), 10) || 0;
				} catch {
					// skip unreadable files
				}
			}
		}

		return { added, removed };
	},

	async getMergeBase(repoPath: string, branchA: string, branchB: string): Promise<string> {
		const result = await exec(["merge-base", branchA, branchB], repoPath);
		if (result.exitCode !== 0) throw new Error(`Failed to get merge base: ${result.stderr}`);
		return result.stdout;
	},

	/** Simulate merge using merge-tree to detect conflicts without modifying worktree */
	async mergeTree(
		repoPath: string,
		baseSha: string,
		ourBranch: string,
		theirBranch: string,
	): Promise<{ hasConflicts: boolean; conflictFiles: string[] }> {
		const result = await exec(["merge-tree", baseSha, ourBranch, theirBranch], repoPath);
		const conflictFiles: string[] = [];
		const lines = result.stdout.split("\n");
		for (const line of lines) {
			// merge-tree "changed in both" sections contain conflict file paths
			const match = line.match(/^\+\+\+ b\/(.+)$/);
			if (match) conflictFiles.push(match[1]);
		}
		for (const line of lines) {
			const conflictMatch = line.match(/^CONFLICT \(.+\): .+ (.+)$/);
			if (conflictMatch && !conflictFiles.includes(conflictMatch[1])) {
				conflictFiles.push(conflictMatch[1]);
			}
		}
		return { hasConflicts: conflictFiles.length > 0, conflictFiles };
	},

	/** Perform actual merge in a worktree */
	async merge(
		worktreePath: string,
		sourceBranch: string,
		strategy: "merge" | "squash",
		message: string,
	): Promise<{ success: boolean; commitSha?: string; conflictFiles?: string[] }> {
		const args =
			strategy === "squash"
				? ["merge", "--squash", sourceBranch]
				: ["merge", "--no-ff", "-m", message, sourceBranch];

		const result = await exec(args, worktreePath);
		if (result.exitCode !== 0) {
			if (result.stdout.includes("CONFLICT") || result.stderr.includes("CONFLICT")) {
				const statusResult = await exec(["diff", "--name-only", "--diff-filter=U"], worktreePath);
				const conflictFiles = statusResult.stdout.split("\n").filter(Boolean);
				return { success: false, conflictFiles };
			}
			throw new Error(`Merge failed: ${result.stderr}`);
		}

		if (strategy === "squash") {
			const commitResult = await exec(["commit", "-m", message], worktreePath);
			if (commitResult.exitCode !== 0)
				throw new Error(`Squash commit failed: ${commitResult.stderr}`);
		}

		const sha = await this.getHeadCommit(worktreePath);
		return { success: true, commitSha: sha };
	},

	/** Cherry-pick commits from source branch onto current branch */
	async cherryPick(
		worktreePath: string,
		repoPath: string,
		sourceBranch: string,
		baseSha: string,
	): Promise<{ success: boolean; commitSha?: string; conflictFiles?: string[] }> {
		const logResult = await exec(
			["rev-list", "--reverse", `${baseSha}..${sourceBranch}`],
			repoPath,
		);
		if (logResult.exitCode !== 0) throw new Error(`Failed to list commits: ${logResult.stderr}`);

		const commits = logResult.stdout.split("\n").filter(Boolean);
		if (commits.length === 0) return { success: true };

		for (const commit of commits) {
			const result = await exec(["cherry-pick", commit], worktreePath);
			if (result.exitCode !== 0) {
				if (result.stdout.includes("CONFLICT") || result.stderr.includes("CONFLICT")) {
					const statusResult = await exec(["diff", "--name-only", "--diff-filter=U"], worktreePath);
					const conflictFiles = statusResult.stdout.split("\n").filter(Boolean);
					await exec(["cherry-pick", "--abort"], worktreePath);
					return { success: false, conflictFiles };
				}
				throw new Error(`Cherry-pick failed: ${result.stderr}`);
			}
		}

		const sha = await this.getHeadCommit(worktreePath);
		return { success: true, commitSha: sha };
	},

	async mergeAbort(worktreePath: string): Promise<void> {
		await exec(["merge", "--abort"], worktreePath);
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
			if (result.stdout.includes("CONFLICT") || result.stderr.includes("CONFLICT")) {
				const conflictFiles = await this.getConflictFiles(worktreePath);
				return { hasConflicts: true, conflictFiles };
			}
			throw new Error(`Merge failed: ${result.stderr}`);
		}
		return { hasConflicts: false, conflictFiles: [] };
	},

	/** Get list of files with unresolved merge conflicts */
	async getConflictFiles(worktreePath: string): Promise<string[]> {
		const result = await exec(["diff", "--name-only", "--diff-filter=U"], worktreePath);
		return result.stdout.split("\n").filter(Boolean);
	},

	async getStatus(worktreePath: string): Promise<string> {
		const result = await exec(["status", "--porcelain"], worktreePath);
		return result.stdout;
	},

	async autoCommit(worktreePath: string, message: string): Promise<string | null> {
		return withWorktreeLock(worktreePath, async () => {
			const status = await this.getStatus(worktreePath);
			if (!status) return null;

			const addResult = await exec(["add", "-A"], worktreePath);
			if (addResult.exitCode !== 0) throw new Error(`git add failed: ${addResult.stderr}`);

			const commitResult = await exec(["commit", "-m", message], worktreePath);
			if (commitResult.exitCode !== 0) throw new Error(`git commit failed: ${commitResult.stderr}`);

			return this.getHeadCommit(worktreePath);
		});
	},

	async getStatusSummary(worktreePath: string): Promise<GitStatusSummary> {
		const [statusResult, headResult, branchResult] = await Promise.all([
			exec(["status", "--porcelain"], worktreePath),
			exec(["rev-parse", "HEAD"], worktreePath),
			exec(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath),
		]);

		const lines = statusResult.stdout.split("\n").filter(Boolean);
		let staged = 0;
		let unstaged = 0;
		let untracked = 0;
		const MAX_FILES = 200;
		const files: Array<{ status: string; path: string }> = [];

		for (const line of lines) {
			const x = line[0]; // index status
			const y = line[1]; // worktree status
			const path = line.slice(3);
			if (files.length < MAX_FILES) {
				files.push({ status: line.slice(0, 2).trim(), path });
			}

			if (y === "?") {
				untracked++;
			} else {
				if (x !== " " && x !== "?") staged++;
				if (y !== " " && y !== "?") unstaged++;
			}
		}

		return {
			hasChanges: lines.length > 0,
			staged,
			unstaged,
			untracked,
			files,
			totalFiles: lines.length,
			headSha: headResult.stdout,
			branch: branchResult.stdout,
		};
	},

	/** Get full diff of all uncommitted changes (staged + unstaged + untracked).
	 *  Truncates at ~100KB to avoid blowing up AI token budgets. */
	async getFullDiff(worktreePath: string, maxBytes = 100_000): Promise<string> {
		// Diff of tracked files (staged + unstaged combined against HEAD)
		const diffResult = await exec(["diff", "HEAD"], worktreePath);
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

		// List untracked files and show their content
		const untrackedResult = await exec(
			["ls-files", "--others", "--exclude-standard"],
			worktreePath,
		);
		const untrackedFiles = untrackedResult.stdout.split("\n").filter(Boolean);
		for (const file of untrackedFiles) {
			// --no-index always exits 1 when diff is found — silence the expected error log
			const showResult = await exec(["diff", "--no-index", "/dev/null", file], worktreePath, true);
			if (showResult.stdout && !addPart(showResult.stdout)) break;
		}

		return parts.join("\n");
	},

	/**
	 * Get the file list for a specific commit (stats only, no diff content).
	 * Fast even for huge commits — only runs numstat + name-status.
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
		// Get numstat for per-file stats
		const numstat = await exec(["diff-tree", "--no-commit-id", "-r", "--numstat", sha], repoPath);
		// Get name-status for file status (A/M/D/R)
		const nameStatus = await exec(
			["diff-tree", "--no-commit-id", "-r", "--name-status", "-M", sha],
			repoPath,
		);

		const statusMap = new Map<string, { status: string; oldPath?: string }>();
		for (const line of nameStatus.stdout.split("\n").filter(Boolean)) {
			const parts = line.split("\t");
			const st = parts[0];
			if (st.startsWith("R")) {
				statusMap.set(parts[2], { status: "renamed", oldPath: parts[1] });
			} else {
				statusMap.set(parts[1], { status: st });
			}
		}

		const statLines = numstat.stdout.split("\n").filter(Boolean);
		return statLines.map((line) => {
			const [addStr, delStr, filePath] = line.split("\t");
			const linesAdded = addStr === "-" ? 0 : Number.parseInt(addStr, 10) || 0;
			const linesRemoved = delStr === "-" ? 0 : Number.parseInt(delStr, 10) || 0;

			const info = statusMap.get(filePath);
			const rawStatus = info?.status ?? "M";
			const status =
				rawStatus === "A" || rawStatus === "added"
					? "added"
					: rawStatus === "D" || rawStatus === "deleted"
						? "deleted"
						: rawStatus === "renamed"
							? "renamed"
							: "modified";

			return {
				path: filePath,
				oldPath: info?.oldPath,
				status: status as "added" | "modified" | "deleted" | "renamed",
				linesAdded,
				linesRemoved,
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
		const result = await exec(
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
			const srcPath = `${srcDir}/${file}`;
			const destPath = `${destDir}/${file}`;
			try {
				const destParent = destPath.substring(0, destPath.lastIndexOf("/"));
				await Bun.spawn(["mkdir", "-p", destParent]).exited;
				await Bun.spawn(["cp", "-r", srcPath, destPath]).exited;
			} catch (err) {
				logger.warn("Failed to copy file", { file, error: String(err) });
			}
		}
	},

	async initRepo(path: string): Promise<void> {
		await Bun.spawn(["mkdir", "-p", path]).exited;
		const result = await exec(["init"], path);
		if (result.exitCode !== 0) throw new Error(`Failed to init repo: ${result.stderr}`);
		// Create initial empty commit so branches can be created
		const commitResult = await exec(["commit", "--allow-empty", "-m", "Initial commit"], path);
		if (commitResult.exitCode !== 0) {
			throw new Error(`Failed to create initial commit: ${commitResult.stderr}`);
		}
	},

	async cloneRepo(url: string, destPath: string, branch?: string): Promise<void> {
		const args = ["clone"];
		if (branch) args.push("--branch", branch);
		args.push(url, destPath);
		const result = await exec(args, ".");
		if (result.exitCode !== 0) throw new Error(`Failed to clone repo: ${result.stderr}`);
	},

	// === Stage / Unstage ===

	async stageFiles(worktreePath: string, files: string[]): Promise<void> {
		if (files.length === 0) return;
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["add", "--", ...files], worktreePath);
			if (result.exitCode !== 0) throw new Error(`git add failed: ${result.stderr}`);
		});
	},

	async stageAll(worktreePath: string): Promise<void> {
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["add", "-A"], worktreePath);
			if (result.exitCode !== 0) throw new Error(`git add -A failed: ${result.stderr}`);
		});
	},

	async unstageFiles(worktreePath: string, files: string[]): Promise<void> {
		if (files.length === 0) return;
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["reset", "HEAD", "--", ...files], worktreePath);
			if (result.exitCode !== 0) throw new Error(`git reset failed: ${result.stderr}`);
		});
	},

	async unstageAll(worktreePath: string): Promise<void> {
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["reset", "HEAD"], worktreePath);
			if (result.exitCode !== 0) throw new Error(`git reset failed: ${result.stderr}`);
		});
	},

	async commit(worktreePath: string, message: string): Promise<string> {
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["commit", "-m", message], worktreePath);
			if (result.exitCode !== 0) throw new Error(`git commit failed: ${result.stderr}`);
			return this.getHeadCommit(worktreePath);
		});
	},

	async discardFiles(worktreePath: string, files: string[]): Promise<void> {
		if (files.length === 0) return;
		return withWorktreeLock(worktreePath, async () => {
			const statusResult = await exec(["status", "--porcelain", "--", ...files], worktreePath);
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
				if (r.exitCode !== 0) throw new Error(`git checkout failed: ${r.stderr}`);
			}
			if (untracked.length > 0) {
				const r = await exec(["clean", "-f", "--", ...untracked], worktreePath);
				if (r.exitCode !== 0) throw new Error(`git clean failed: ${r.stderr}`);
			}
		});
	},

	async discardAll(worktreePath: string): Promise<void> {
		return withWorktreeLock(worktreePath, async () => {
			const r1 = await exec(["checkout", "HEAD", "--", "."], worktreePath);
			if (r1.exitCode !== 0) throw new Error(`git checkout failed: ${r1.stderr}`);
			const r2 = await exec(["clean", "-fd"], worktreePath);
			if (r2.exitCode !== 0) throw new Error(`git clean failed: ${r2.stderr}`);
		});
	},

	async stash(worktreePath: string, message?: string): Promise<void> {
		return withWorktreeLock(worktreePath, async () => {
			const args = ["stash", "push", "--include-untracked"];
			if (message) args.push("-m", message);
			const result = await exec(args, worktreePath);
			if (result.exitCode !== 0) throw new Error(`git stash failed: ${result.stderr}`);
		});
	},

	async stashPop(worktreePath: string): Promise<{ hasConflicts: boolean }> {
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["stash", "pop"], worktreePath, true);
			if (result.exitCode !== 0) {
				// Check for conflicts via string matching + porcelain status fallback
				if (result.stdout.includes("CONFLICT") || result.stderr.includes("CONFLICT")) {
					return { hasConflicts: true };
				}
				const statusResult = await exec(["status", "--porcelain"], worktreePath, true);
				const hasUnmerged = statusResult.stdout
					.split("\n")
					.some((l) => l.startsWith("UU") || l.startsWith("AA") || l.startsWith("DD"));
				if (hasUnmerged) {
					return { hasConflicts: true };
				}
				throw new Error(`git stash pop failed: ${result.stderr}`);
			}
			return { hasConflicts: false };
		});
	},

	async stashList(
		worktreePath: string,
	): Promise<Array<{ index: number; message: string; date: string }>> {
		const result = await exec(["stash", "list", "--format=%gd%x00%gs%x00%ai"], worktreePath, true);
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
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["stash", "drop", `stash@{${index}}`], worktreePath);
			if (result.exitCode !== 0) throw new Error(`git stash drop failed: ${result.stderr}`);
		});
	},

	// === File diff (working tree) ===

	async getFileDiff(
		worktreePath: string,
		filePath: string,
		staged = false,
		maxBytes = 200_000,
	): Promise<{ diff: string; truncated: boolean }> {
		// Check if file is untracked
		const statusResult = await exec(["status", "--porcelain", "--", filePath], worktreePath, true);
		const statusLine = statusResult.stdout.trim();

		let diff: string;
		if (statusLine.startsWith("??")) {
			// Untracked file — show full content as "new file" diff
			const r = await exec(["diff", "--no-index", "/dev/null", filePath], worktreePath, true);
			diff = r.stdout;
		} else if (staged) {
			const r = await exec(["diff", "--cached", "--", filePath], worktreePath, true);
			diff = r.stdout;
		} else {
			const r = await exec(["diff", "--", filePath], worktreePath, true);
			diff = r.stdout;
		}

		let truncated = false;
		if (diff.length > maxBytes) {
			diff = diff.slice(0, maxBytes);
			truncated = true;
		}
		return { diff, truncated };
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
		const result = await exec(args, worktreePath, true);
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

	// === Reset ===

	async resetSoft(worktreePath: string, target: string): Promise<void> {
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["reset", "--soft", target], worktreePath);
			if (result.exitCode !== 0) throw new Error(`git reset --soft failed: ${result.stderr}`);
		});
	},

	async resetHard(worktreePath: string, target: string): Promise<void> {
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["reset", "--hard", target], worktreePath);
			if (result.exitCode !== 0) throw new Error(`git reset --hard failed: ${result.stderr}`);
		});
	},

	// === Revert ===

	/** Check if a commit is a merge commit (has more than one parent) */
	async isMergeCommit(worktreePath: string, commitSha: string): Promise<boolean> {
		const result = await exec(["cat-file", "-p", commitSha], worktreePath);
		if (result.exitCode !== 0) return false;
		const parentLines = result.stdout.split("\n").filter((l) => l.startsWith("parent "));
		return parentLines.length > 1;
	},

	/** Revert a merge commit (using -m 1 to specify the mainline parent) */
	async revertMergeCommit(worktreePath: string, commitSha: string): Promise<string> {
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["revert", "-m", "1", "--no-edit", commitSha], worktreePath);
			if (result.exitCode !== 0) {
				// Abort the failed revert to leave worktree clean
				await exec(["revert", "--abort"], worktreePath);
				throw new Error(
					`git revert produced conflicts — the merge cannot be automatically undone. ` +
						`Resolve manually with: git revert -m 1 ${commitSha}`,
				);
			}
			const head = await exec(["rev-parse", "HEAD"], worktreePath);
			return head.stdout.trim();
		});
	},

	/** Revert a regular (non-merge) commit */
	async revertCommit(worktreePath: string, commitSha: string): Promise<string> {
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["revert", "--no-edit", commitSha], worktreePath);
			if (result.exitCode !== 0) {
				await exec(["revert", "--abort"], worktreePath);
				throw new Error(
					`git revert produced conflicts — the merge cannot be automatically undone. ` +
						`Resolve manually with: git revert ${commitSha}`,
				);
			}
			const head = await exec(["rev-parse", "HEAD"], worktreePath);
			return head.stdout.trim();
		});
	},
};
