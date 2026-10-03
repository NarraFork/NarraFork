/** Execution workspace, deliberately distinct from UI layout workspaces. */
export interface WorkspaceContext {
	revision: number;
	deviceId: string;
	cwd: string;
	pathFlavor: "posix" | "windows";
	contextKey: string;
	contextProjectId?: string;
	git?: { workspaceKey: string; repositoryKey: string; rootPath: string };
	capabilities: { switchDirectory: boolean; reason?: string };
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
