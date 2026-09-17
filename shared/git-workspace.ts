/** Git facts belong to a device/worktree, not a chapter or narrator. */
export type GitWorkspaceState =
	| "ready"
	| "not_git"
	| "missing_directory"
	| "git_unavailable"
	| "access_denied"
	| "device_offline"
	| "unsupported";

export interface GitWorkspace {
	workspaceKey: string | null;
	repositoryKey: string | null;
	deviceId: string;
	cwd: string;
	rootPath: string | null;
	state: GitWorkspaceState;
	capabilities: { read: boolean; write: boolean };
	reason?: string;
	narratorId?: string;
	/** Present only when the actual worktree matches this chapter. */
	chapterId?: string;
	projectId?: string;
}
