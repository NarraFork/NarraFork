/** Additive, shell-free Git management contract, mirrored by the Go executor. */
export const FEATURE_GIT_WORKSPACE_V1 = "git.workspace.v1";
export const GIT_WORKSPACE_TIMEOUT_MS = 30_000;
export const GIT_WORKSPACE_WRITE_TIMEOUT_MS = 120_000;
export const GIT_WORKSPACE_MAX_BYTES = 2 * 1024 * 1024;
export const GIT_WORKSPACE_AI_DIFF_BYTES = 100_000;

export type GitWorkspaceOperation =
	| "probe"
	| "status"
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
	| "reset";

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
	branch?: string;
	index?: number;
	target?: string;
	mode?: "soft" | "hard";
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
	reason?: string;
	stdout?: string;
	/** Named bounded raw Git outputs (porcelain and numstat use NUL delimiters). */
	outputs?: Record<string, string>;
	truncated?: boolean;
	hasConflicts?: boolean;
}
