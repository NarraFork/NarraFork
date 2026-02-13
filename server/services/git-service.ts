import { logger } from "../lib/logger";

interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function exec(args: string[], cwd: string): Promise<ExecResult> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		logger.error("git command failed", { args: args.join(" "), cwd, stderr, exitCode });
	}
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export const gitService = {
	async getCurrentBranch(repoPath: string): Promise<string> {
		const result = await exec(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
		return result.stdout;
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
		const status = await this.getStatus(worktreePath);
		if (!status) return null;

		const addResult = await exec(["add", "-A"], worktreePath);
		if (addResult.exitCode !== 0) throw new Error(`git add failed: ${addResult.stderr}`);

		const commitResult = await exec(["commit", "-m", message], worktreePath);
		if (commitResult.exitCode !== 0) throw new Error(`git commit failed: ${commitResult.stderr}`);

		return this.getHeadCommit(worktreePath);
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
};
