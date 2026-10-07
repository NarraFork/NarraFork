import { execFileSync } from "node:child_process";

function normalizeRepoPath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function parseStatusLines(output: string): string[] {
	return output
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean);
}

/**
 * Return worktree changes outside the explicitly release-managed paths.
 * Uses Git pathspec exclusions so tracked, staged, and untracked files are all covered.
 */
export function getUnexpectedReleaseChanges(root: string, allowedPaths: string[] = []): string[] {
	const exclusions = allowedPaths
		.map(normalizeRepoPath)
		.filter((path) => path.length > 0 && !path.startsWith("../") && !path.startsWith("/"))
		.map((path) => `:(exclude)${path}`);
	const output = execFileSync(
		"git",
		["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ...exclusions],
		{
			cwd: root,
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
		},
	);
	return parseStatusLines(output);
}

/** Resolve a ref to its commit, returning null when it does not exist. */
export function resolveGitCommit(root: string, ref: string): string | null {
	try {
		return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
			cwd: root,
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}
