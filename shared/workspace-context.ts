/** Execution workspace, deliberately distinct from UI layout workspaces. */
export interface WorkspaceContext {
	revision: number;
	deviceId: string;
	cwd: string;
	pathFlavor: "posix" | "windows";
	contextKey: string;
	contextProjectId?: string;
	git?: {
		workspaceKey: string;
		repositoryKey: string;
		rootPath: string;
		/** Canonical Git common directory; optional for pre-cache contexts. */
		repositoryPath?: string;
	};
	capabilities: { switchDirectory: boolean; reason?: string };
}

/** Stable JSON for small workspace metadata, independent of discovery/DB key order. */
export function serializeWorkspaceContext(context: WorkspaceContext): string {
	return JSON.stringify(context, (_key, value: unknown) => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, record[key]]),
		);
	});
}

export interface SwitchWorkingDirectoryRequest {
	expectedRevision: number;
	requestId: string;
	target: { deviceId: string; cwd: string };
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
