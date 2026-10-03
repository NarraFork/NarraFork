import type {
	SwitchWorkingDirectoryRequest,
	SwitchWorkingDirectoryResult,
	WorkspaceContext,
} from "@shared/workspace-context";
import { request } from "./client";

export const workspaceContextApi = {
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
