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
	/** Independently versioned session/device binding; never an authorization grant. */
	binding?: WorkspaceBindingReference;
	/** Original v2 root evidence; legacy bindings cannot synthesize it from a new observation. */
	nativeRootDescriptor?: import("./target-native-path").NativePathDescriptorV2;
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

/** Invalidate actor-filtered summaries; no device/path/native evidence is broadcast. */
export interface DeviceWorkspaceBindingsChangedEvent {
	type: "device_workspace_bindings_changed";
	narratorId: string;
}

/** Binding identity is distinct from the default selection's workspaceRevision. */
export interface WorkspaceBindingReference {
	version: 1;
	bindingId: string;
	narratorId: string;
	deviceId: string;
	bindingRevision: number;
	bindingKey: string;
}

export interface NarratorDeviceWorkspaceBinding {
	id: string;
	narratorId: string;
	deviceId: string;
	bindingRevision: number;
	context: WorkspaceContext;
	createdAt: string;
	updatedAt: string;
}

/** List responses deliberately omit original native root evidence and large JSON. */
export interface NarratorDeviceWorkspaceSummary {
	id: string;
	deviceId: string;
	cwd: string;
	pathFlavor: WorkspaceContext["pathFlavor"];
	bindingRevision: number;
	selected: boolean;
	availability: WorkspaceContext["availability"];
	updatedAt: string;
}

export interface ListNarratorDeviceWorkspacesResult {
	items: NarratorDeviceWorkspaceSummary[];
	nextCursor: string | null;
}

export interface SetNarratorDeviceWorkspaceRequest {
	requestId: string;
	deviceId: string;
	cwd: string;
	/** Zero only when creating a binding that does not exist. */
	expectedBindingRevision: number;
	/** Required when the edited binding is also the selected endpoint. */
	expectedSelectionRevision?: number;
	expectedWorktreeKey?: string;
}

export interface SelectNarratorDeviceWorkspaceRequest {
	requestId: string;
	deviceId: string;
	expectedBindingRevision: number;
	expectedSelectionRevision: number;
}

export interface NarratorDeviceWorkspaceMutationResult {
	kind: "set" | "select";
	changed: boolean;
	binding: NarratorDeviceWorkspaceBinding;
	/** Present only if this operation updated the selected/default projection. */
	selection?: SwitchWorkingDirectoryResult;
}
