import type { GitLineStats } from "@shared/git-line-stats";

/** Additive, shell-free Git management contract, mirrored by the Go executor. */
export const FEATURE_GIT_WORKSPACE_V1 = "git.workspace.v1";
export const FEATURE_GIT_WORKSPACE_WATCH_V1 = "git.workspace.watch.v1";
/** Status-only, bounded 10,000-record scan with early stop; legacy executors may compute numstat. */
export const FEATURE_GIT_WORKSPACE_STATUS_V1 = "git.workspace.status.v1";
export const FEATURE_GIT_LINE_STATS_V1 = "git.workspace.line-stats.v1";
/** Read-only `commitDetail`/`commitDiff` operations; older executors lack them. */
export const FEATURE_GIT_COMMIT_PREVIEW_V1 = "git.workspace.commit-preview.v1";
/**
 * `branches` returns the raw `for-each-ref`/`worktree list` listings under the keys
 * in GIT_BRANCH_OUTPUT_KEYS; the server parses them, so this stays a pure read.
 */
export const FEATURE_GIT_BRANCHES_V1 = "git.workspace.branches.v1";
/** The `checkout` write operation (switch, create, or track a remote branch). */
export const FEATURE_GIT_BRANCH_SWITCH_V1 = "git.workspace.branch-switch.v1";
/** The `push`/`fetch` write operations; both talk to a configured remote. */
export const FEATURE_GIT_REMOTE_SYNC_V1 = "git.workspace.remote-sync.v1";
export const GIT_WORKSPACE_TIMEOUT_MS = 30_000;
export const GIT_WORKSPACE_WRITE_TIMEOUT_MS = 120_000;
export const GIT_WORKSPACE_MAX_BYTES = 2 * 1024 * 1024;
export const GIT_WORKSPACE_AI_DIFF_BYTES = 100_000;

export type GitWorkspaceOperation =
	| "probe"
	| "watch"
	| "status"
	| "lineStats"
	| "diff"
	| "fullDiff"
	| "stage"
	| "unstage"
	| "commit"
	| "discard"
	| "log"
	| "stashList"
	| "stashPush"
	| "stashPop"
	| "stashDrop"
	| "reset"
	| "commitDetail"
	| "commitDiff"
	| "branches"
	| "checkout"
	| "push"
	| "fetch";

export interface GitWorkspaceRequest {
	cwd: string;
	operation: GitWorkspaceOperation;
	/** Required on every non-probe call; checked again on the target device. */
	expectedRoot?: string;
	files?: string[];
	all?: boolean;
	staged?: boolean;
	message?: string;
	identity?: Record<string, string>;
	limit?: number;
	skip?: number;
	/** log: revision to walk. checkout: existing local branch, or the ref to track. */
	branch?: string;
	/** checkout: create `branch` instead of switching to an existing one. */
	create?: boolean;
	/** checkout with create: revision the new branch starts from; defaults to HEAD. */
	startPoint?: string;
	/** push/fetch: configured remote name; the executor rejects an unknown one. */
	remote?: string;
	/** push: pass `--set-upstream` for a branch that has no upstream yet. */
	setUpstream?: boolean;
	/** fetch: pass `--prune` to drop remote-tracking refs the remote no longer has. */
	prune?: boolean;
	index?: number;
	target?: string;
	mode?: "soft" | "hard";
	/** commitDetail/commitDiff: full commit SHA. */
	commit?: string;
	/**
	 * commitDiff: historical repo-relative path. Deliberately NOT `files`: those are
	 * checked against the current filesystem, and a historical path may be gone.
	 */
	path?: string;
	oldPath?: string;
	maxBytes?: number;
	timeoutMs?: number;
}

export interface GitWorkspaceResult {
	state?:
		| "ready"
		| "not_git"
		| "missing_directory"
		| "git_unavailable"
		| "access_denied"
		| "unsupported";
	rootPath?: string;
	repositoryPath?: string;
	/** Additive probe HEAD label; older executors may omit it. */
	branch?: string | null;
	reason?: string;
	stdout?: string;
	/** Named bounded raw Git outputs (porcelain and numstat use NUL delimiters).
	 * watch returns SHA-256 worktree/index/head/stash fingerprints; uncertainWorktree="true"
	 * means the consumer must conservatively invalidate worktree data on every poll.
	 * A truncated watch result requires invalidating all categories, not trusting prefix hashes.
	 */
	outputs?: Record<string, string>;
	truncated?: boolean;
	lineStats?: GitLineStats;
	/** Status counts are exact only when the complete porcelain stream was scanned. */
	totalFilesExact?: boolean;
	hasConflicts?: boolean;
}
