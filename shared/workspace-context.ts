export interface WorkspaceFeatureCapability {
	available: boolean;
	reason?: string;
}

/** Execution workspace, deliberately distinct from UI layout workspaces. */
export interface WorkspaceContext {
	revision: number;
	deviceId: string;
	cwd: string;
	pathFlavor: "posix" | "windows";
	contextKey: string;
	contextProjectId?: string;
	git?: { workspaceKey: string; repositoryKey: string; rootPath: string };
	/** Runtime state is presentation only; it is never an authorization grant. */
	availability?: "ready" | "offline" | "needs_initialization" | "missing_directory";
	/** Legacy SwitchDevice return location; never used as the current execution cwd. */
	compatibility?: { version: 1; localCwd?: string };
	capabilities: {
		switchDirectory: boolean;
		reason?: string;
		browse?: WorkspaceFeatureCapability;
		edit?: WorkspaceFeatureCapability;
		git?: WorkspaceFeatureCapability;
		worktree?: WorkspaceFeatureCapability;
		terminal?: WorkspaceFeatureCapability;
		history?: WorkspaceFeatureCapability;
		share?: WorkspaceFeatureCapability;
	};
}

export interface SwitchWorkingDirectoryRequest {
	expectedRevision: number;
	requestId: string;
	target: { deviceId: string; cwd: string };
	expectedWorktreeKey?: string;
}

export interface SwitchWorkingDirectoryResult {
	changed: boolean;
	previous: WorkspaceContext;
	current: WorkspaceContext;
}

export interface WorkspaceContextChangedEvent {
	type: "workspace_context_changed";
	narratorId: string;
	previous: WorkspaceContext;
	current: WorkspaceContext;
}
