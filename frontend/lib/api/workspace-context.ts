import type {
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

export const workspaceContextApi = {
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
