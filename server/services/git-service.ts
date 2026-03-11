import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { GitError } from "../lib/errors";
import { logger } from "../lib/logger";
import { DEV_NULL } from "../lib/platform";
import { safeSpawn } from "../lib/spawn";

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

export interface GitStatusFile {
	/** Two-character porcelain status, e.g. "M ", " M", "MM", "??". */
	status: string;
	path: string;
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
}

function stripTrailingLineBreaks(text: string): string {
	return text.replace(/[\r\n]+$/, "");
}

async function exec(args: string[], cwd: string, silent = false): Promise<ExecResult> {
	try {
		const result = await safeSpawn({ cmd: ["git", ...args], cwd });
		const trimmedStdout = stripTrailingLineBreaks(result.stdout);
		const trimmedStderr = stripTrailingLineBreaks(result.stderr);
		if (result.exitCode !== 0 && !silent) {
			logger.error("git command failed", {
				args: args.join(" "),
				cwd,
				stderr: trimmedStderr,
				exitCode: result.exitCode,
			});
		}
		return { stdout: trimmedStdout, stderr: trimmedStderr, exitCode: result.exitCode };
	} catch (err) {
		// When silent, swallow spawn errors (e.g. git not found) and return a
		// synthetic failure result so callers that check exitCode still work.
		if (silent) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.debug("git command spawn failed (silent)", { args: args.join(" "), cwd, error: msg });
			return { stdout: "", stderr: msg, exitCode: -1 };
		}
		throw err;
	}
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

async function getUntrackedLineStatsMap(
	worktreePath: string,
	files: string[],
): Promise<Map<string, LineStats>> {
	const entries = await Promise.all(
		files.map(async (file) => {
			try {
				const filePath = join(worktreePath, file);
				const content = await Bun.file(filePath).text();
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
		const result = await exec(["rev-parse", "--is-shallow-repository"], repoPath, true);
		return result.exitCode === 0 && result.stdout.trim() === "true";
	},

	async isGitRepo(path: string): Promise<boolean> {
		const result = await exec(["rev-parse", "--is-inside-work-tree"], path);
		return result.exitCode === 0;
	},

	async getHeadCommit(repoPath: string): Promise<string> {
		const result = await exec(["rev-parse", "HEAD"], repoPath);
		if (result.exitCode !== 0) throw new GitError(`Failed to get HEAD commit: ${result.stderr}`);
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
		const tracked = await exec(["diff", "HEAD", "--numstat", "-z"], worktreePath, true);
		// untracked files
		const untracked = await exec(
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

	async getMergeBase(repoPath: string, branchA: string, branchB: string): Promise<string> {
		const result = await exec(["merge-base", branchA, branchB], repoPath);
		if (result.exitCode !== 0) throw new GitError(`Failed to get merge base: ${result.stderr}`);
		return result.stdout;
	},

	/** Check if commitA is an ancestor of commitB (i.e. commitB contains commitA) */
	async isAncestor(repoPath: string, commitA: string, commitB: string): Promise<boolean> {
		const result = await exec(["merge-base", "--is-ancestor", commitA, commitB], repoPath, true);
		return result.exitCode === 0;
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
		options?: { fastForward?: boolean },
	): Promise<{
		success: boolean;
		commitSha?: string;
		conflictFiles?: string[];
		isFastForward?: boolean;
	}> {
		let args: string[];
		if (strategy === "squash") {
			args = ["merge", "--squash", sourceBranch];
		} else if (options?.fastForward) {
			args = ["merge", "--ff-only", sourceBranch];
		} else {
			args = ["merge", "--no-ff", "-m", message, sourceBranch];
		}

		const result = await exec(args, worktreePath);
		if (result.exitCode !== 0) {
			if (options?.fastForward) {
				// ff-only failed — fall back to --no-ff
				const fallbackArgs = ["merge", "--no-ff", "-m", message, sourceBranch];
				const fallbackResult = await exec(fallbackArgs, worktreePath);
				if (fallbackResult.exitCode !== 0) {
					if (
						fallbackResult.stdout.includes("CONFLICT") ||
						fallbackResult.stderr.includes("CONFLICT")
					) {
						const statusResult = await exec(
							["diff", "--name-only", "--diff-filter=U"],
							worktreePath,
						);
						const conflictFiles = statusResult.stdout.split("\n").filter(Boolean);
						return { success: false, conflictFiles };
					}
					throw new GitError(`Merge failed: ${fallbackResult.stderr}`);
				}
				if (strategy === "squash") {
					const commitResult = await exec(["commit", "-m", message], worktreePath);
					if (commitResult.exitCode !== 0)
						throw new GitError(`Squash commit failed: ${commitResult.stderr}`);
				}
				const sha = await this.getHeadCommit(worktreePath);
				return { success: true, commitSha: sha, isFastForward: false };
			}
			if (result.stdout.includes("CONFLICT") || result.stderr.includes("CONFLICT")) {
				const statusResult = await exec(["diff", "--name-only", "--diff-filter=U"], worktreePath);
				const conflictFiles = statusResult.stdout.split("\n").filter(Boolean);
				return { success: false, conflictFiles };
			}
			throw new GitError(`Merge failed: ${result.stderr}`);
		}

		if (strategy === "squash") {
			const commitResult = await exec(["commit", "-m", message], worktreePath);
			if (commitResult.exitCode !== 0)
				throw new GitError(`Squash commit failed: ${commitResult.stderr}`);
		}

		const sha = await this.getHeadCommit(worktreePath);
		return { success: true, commitSha: sha, isFastForward: !!options?.fastForward };
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
		if (logResult.exitCode !== 0) throw new GitError(`Failed to list commits: ${logResult.stderr}`);

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
				throw new GitError(`Cherry-pick failed: ${result.stderr}`);
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
			throw new GitError(`Merge failed: ${result.stderr}`);
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
			if (addResult.exitCode !== 0) throw new GitError(`git add failed: ${addResult.stderr}`);

			const commitResult = await exec(["commit", "-m", message], worktreePath);
			if (commitResult.exitCode !== 0)
				throw new GitError(`git commit failed: ${commitResult.stderr}`);

			return this.getHeadCommit(worktreePath);
		});
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
			exec(["status", "--porcelain", "-z"], worktreePath),
			exec(["rev-parse", "HEAD"], worktreePath),
			exec(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath),
			exec(["diff", "--cached", "--numstat", "-z"], worktreePath, true),
			exec(["diff", "--numstat", "-z"], worktreePath, true),
			exec(["ls-files", "--others", "--exclude-standard", "-z"], worktreePath, true),
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

		return {
			hasChanges: entries.length > 0,
			staged,
			unstaged,
			untracked,
			files,
			totalFiles: entries.length,
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
			const showResult = await exec(["diff", "--no-index", DEV_NULL, file], worktreePath, true);
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

	async initRepo(repoPath: string): Promise<void> {
		mkdirSync(repoPath, { recursive: true });
		const result = await exec(["init"], repoPath);
		if (result.exitCode !== 0) throw new GitError(`Failed to init repo: ${result.stderr}`);
		// Create initial empty commit so branches can be created
		const commitResult = await exec(["commit", "--allow-empty", "-m", "Initial commit"], repoPath);
		if (commitResult.exitCode !== 0) {
			throw new GitError(`Failed to create initial commit: ${commitResult.stderr}`);
		}
	},

	async stageAndCommit(repoPath: string, files: string[], message: string): Promise<void> {
		const addResult = await exec(["add", ...files], repoPath);
		if (addResult.exitCode !== 0) {
			throw new GitError(`Failed to stage files: ${addResult.stderr}`);
		}
		const commitResult = await exec(["commit", "-m", message], repoPath);
		if (commitResult.exitCode !== 0) {
			throw new GitError(`Failed to commit: ${commitResult.stderr}`);
		}
	},

	async commitGitignoreIfDirty(repoPath: string): Promise<void> {
		const statusResult = await exec(["status", "--porcelain", ".gitignore"], repoPath);
		if (statusResult.stdout.trim()) {
			await this.stageAndCommit(repoPath, [".gitignore"], "Update .gitignore for NarraFork");
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
	): Promise<void> {
		const args = ["clone", "--progress"];
		if (branch) args.push("--branch", branch);
		args.push(url, destPath);

		const proc = Bun.spawn(["git", ...args], {
			cwd: ".",
			stdout: "pipe",
			stderr: "pipe",
		});

		// Read stderr in streaming fashion — git progress uses \r for in-place updates
		const reader = proc.stderr.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

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
					if (trimmed) onProgress(trimmed);
				}
			}
			// Flush remaining
			const final = decoder.decode();
			buffer += final;
			if (buffer.trim()) onProgress(buffer.trim());
		} finally {
			reader.releaseLock();
		}

		// Drain stdout to avoid pipe deadlock
		await new Response(proc.stdout).text();

		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new GitError(`Failed to clone repo (exit code ${exitCode})`);
		}
	},

	// === Stage / Unstage ===

	async stageFiles(worktreePath: string, files: string[]): Promise<void> {
		if (files.length === 0) return;
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["add", "--", ...files], worktreePath);
			if (result.exitCode !== 0) throw new GitError(`git add failed: ${result.stderr}`);
		});
	},

	async stageAll(worktreePath: string): Promise<void> {
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["add", "-A"], worktreePath);
			if (result.exitCode !== 0) throw new GitError(`git add -A failed: ${result.stderr}`);
		});
	},

	async unstageFiles(worktreePath: string, files: string[]): Promise<void> {
		if (files.length === 0) return;
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["reset", "HEAD", "--", ...files], worktreePath);
			if (result.exitCode !== 0) throw new GitError(`git reset failed: ${result.stderr}`);
		});
	},

	async unstageAll(worktreePath: string): Promise<void> {
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["reset", "HEAD"], worktreePath);
			if (result.exitCode !== 0) throw new GitError(`git reset failed: ${result.stderr}`);
		});
	},

	async commit(worktreePath: string, message: string): Promise<string> {
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["commit", "-m", message], worktreePath);
			if (result.exitCode !== 0) throw new GitError(`git commit failed: ${result.stderr}`);
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
				if (r.exitCode !== 0) throw new GitError(`git checkout failed: ${r.stderr}`);
			}
			if (untracked.length > 0) {
				const r = await exec(["clean", "-f", "--", ...untracked], worktreePath);
				if (r.exitCode !== 0) throw new GitError(`git clean failed: ${r.stderr}`);
			}
		});
	},

	async discardAll(worktreePath: string): Promise<void> {
		return withWorktreeLock(worktreePath, async () => {
			const r1 = await exec(["checkout", "HEAD", "--", "."], worktreePath);
			if (r1.exitCode !== 0) throw new GitError(`git checkout failed: ${r1.stderr}`);
			const r2 = await exec(["clean", "-fd"], worktreePath);
			if (r2.exitCode !== 0) throw new GitError(`git clean failed: ${r2.stderr}`);
		});
	},

	async stash(worktreePath: string, message?: string): Promise<void> {
		return withWorktreeLock(worktreePath, async () => {
			const args = ["stash", "push", "--include-untracked"];
			if (message) args.push("-m", message);
			const result = await exec(args, worktreePath);
			if (result.exitCode !== 0) throw new GitError(`git stash failed: ${result.stderr}`);
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
				throw new GitError(`git stash pop failed: ${result.stderr}`);
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
			if (result.exitCode !== 0) throw new GitError(`git stash drop failed: ${result.stderr}`);
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
			const r = await exec(["diff", "--no-index", DEV_NULL, filePath], worktreePath, true);
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
			if (result.exitCode !== 0) throw new GitError(`git reset --soft failed: ${result.stderr}`);
		});
	},

	async resetHard(worktreePath: string, target: string): Promise<void> {
		return withWorktreeLock(worktreePath, async () => {
			const result = await exec(["reset", "--hard", target], worktreePath);
			if (result.exitCode !== 0) throw new GitError(`git reset --hard failed: ${result.stderr}`);
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
				throw new GitError(
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
				throw new GitError(
					`git revert produced conflicts — the merge cannot be automatically undone. ` +
						`Resolve manually with: git revert ${commitSha}`,
				);
			}
			const head = await exec(["rev-parse", "HEAD"], worktreePath);
			return head.stdout.trim();
		});
	},
};
