import type {
	ListNarratorDeviceWorkspacesResult,
	NarratorDeviceWorkspaceMutationResult,
	SelectNarratorDeviceWorkspaceRequest,
	SetNarratorDeviceWorkspaceRequest,
	SwitchWorkingDirectoryRequest,
	SwitchWorkingDirectoryResult,
	WorkspaceContext,
} from "@shared/workspace-context";
import { request } from "./client";

export interface WorkspaceDirectoryListing {
	path: string;
	parent: string | null;
	entries: Array<{
		name: string;
		path: string;
		isDirectory: boolean;
		isSymlink?: boolean;
		size?: number;
	}>;
	truncated: boolean;
	scanned: number;
	reason?: string;
	deviceId: string;
	contextKey: string;
	revision: number;
}

export interface DeviceWorkspaceRequestReceipt {
	requestId: string;
	kind: "set" | "select";
	result: NarratorDeviceWorkspaceMutationResult;
	installState: "pending" | "installed" | "superseded";
}

export const workspaceContextApi = {
	listNarratorDeviceWorkspaces: (
		narratorId: string,
		opts: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
	) => {
		const query = new URLSearchParams({ limit: String(opts.limit ?? 32) });
		if (opts.cursor) query.set("cursor", opts.cursor);
		return request<ListNarratorDeviceWorkspacesResult>(
			`/narrators/${encodeURIComponent(narratorId)}/device-workspaces?${query}`,
			{ signal: opts.signal },
		);
	},
	getWorkspaceSelectionStatus: (narratorId: string, signal?: AbortSignal) =>
		request<{ revision: number; installed: boolean }>(
			`/narrators/${encodeURIComponent(narratorId)}/device-workspaces/selection-status`,
			{ signal },
		),
	setNarratorDeviceWorkspace: (narratorId: string, input: SetNarratorDeviceWorkspaceRequest) => {
		const { deviceId, ...body } = input;
		return request<NarratorDeviceWorkspaceMutationResult>(
			`/narrators/${encodeURIComponent(narratorId)}/device-workspaces/${encodeURIComponent(deviceId)}`,
			{ method: "PUT", body: JSON.stringify(body) },
		);
	},
	selectNarratorDeviceWorkspace: (
		narratorId: string,
		input: SelectNarratorDeviceWorkspaceRequest,
	) =>
		request<NarratorDeviceWorkspaceMutationResult>(
			`/narrators/${encodeURIComponent(narratorId)}/device-workspaces/select`,
			{ method: "POST", body: JSON.stringify(input) },
		),
	getNarratorDeviceWorkspaceRequest: (narratorId: string, requestId: string) =>
		request<DeviceWorkspaceRequestReceipt>(
			`/narrators/${encodeURIComponent(narratorId)}/device-workspaces/requests/${encodeURIComponent(requestId)}`,
		),
	recoverNarratorDeviceWorkspaceRequest: (narratorId: string, requestId: string) =>
		request<NarratorDeviceWorkspaceMutationResult>(
			`/narrators/${encodeURIComponent(narratorId)}/device-workspaces/requests/${encodeURIComponent(requestId)}/recover`,
			{ method: "POST" },
		),
	browseNarratorWorkspace: (
		narratorId: string,
		context: WorkspaceContext,
		path: string | undefined,
		opts: { showHidden?: boolean; directoriesOnly?: boolean; signal?: AbortSignal } = {},
	) => {
		const query = new URLSearchParams({
			expectedRevision: String(context.revision),
			contextKey: context.contextKey,
			showHidden: opts.showHidden ? "1" : "0",
			directoriesOnly: opts.directoriesOnly ? "1" : "0",
		});
		if (path !== undefined) query.set("path", path);
		return request<WorkspaceDirectoryListing>(
			`/narrators/${encodeURIComponent(narratorId)}/workspace-browser?${query}`,
			{ signal: opts.signal },
		);
	},
	getWorkspaceSwitchRequest: (narratorId: string, requestId: string) =>
		request<{ requestId: string; result: SwitchWorkingDirectoryResult; installState: string }>(
			`/narrators/${encodeURIComponent(narratorId)}/workspace-context/requests/${encodeURIComponent(requestId)}`,
		),
	getWorkspaceContext: (narratorId: string, signal?: AbortSignal) =>
		request<WorkspaceContext>(`/narrators/${encodeURIComponent(narratorId)}/workspace-context`, {
			signal,
		}),
	switchWorkspaceContext: (narratorId: string, input: SwitchWorkingDirectoryRequest) =>
		request<SwitchWorkingDirectoryResult>(
			`/narrators/${encodeURIComponent(narratorId)}/workspace-context/switch`,
			{ method: "POST", body: JSON.stringify(input) },
		),
};
