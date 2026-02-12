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
};
