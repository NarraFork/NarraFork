/**
 * Read-only preview of one historical commit: metadata, changed files, and a
 * per-file patch fetched on demand. Shared by the server (local + remote Git
 * backends) and the Git panel.
 */

export type GitCommitFileStatus =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "copied"
	| "typechange"
	| "unmerged"
	| "unknown";

export interface GitCommitFile {
	path: string;
	/** Source path of a rename/copy. */
	oldPath?: string;
	status: GitCommitFileStatus;
	/** null when unknown: a binary file, or numstat was cut by its output budget. */
	linesAdded: number | null;
	linesRemoved: number | null;
	binary: boolean;
}

export interface GitCommitDetail {
	sha: string;
	shortSha: string;
	parents: string[];
	authorName: string;
	authorEmail: string;
	authoredAt: string;
	committerName: string;
	committerEmail: string;
	committedAt: string;
	message: string;
	messageTruncated: boolean;
	/** First parent the file list is compared against; null for a root commit. */
	comparedTo: string | null;
	files: GitCommitFile[];
	filesTruncated: boolean;
}

export interface GitCommitPatch {
	diff: string;
	truncated: boolean;
}

/** Full SHA-1 (40) or SHA-256 (64) object name. Refs and ranges are deliberately refused. */
export const GIT_COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export const GIT_COMMIT_PREVIEW_MAX_FILES = 1000;
export const GIT_COMMIT_PREVIEW_MESSAGE_MAX_BYTES = 64 * 1024;
export const GIT_COMMIT_PREVIEW_PATCH_MAX_BYTES = 200_000;

/** Error code when a remote executor predates the commit-preview operations. */
export const GIT_COMMIT_PREVIEW_UNSUPPORTED = "GIT_COMMIT_PREVIEW_UNSUPPORTED";
