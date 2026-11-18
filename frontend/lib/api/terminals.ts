import { request } from "./client";
import type { ApiEntity } from "./types";

export interface TreeTerminal {
	id: string;
	name: string;
	cwd: string | null;
	createdAt: string;
	narratorId: string;
	narratorTitle: string | null;
	subagentType: string | null;
}

export interface TreeTerminalListing {
	terminals: TreeTerminal[];
	truncated: boolean;
	canOpen: boolean;
}

export const terminalsApi = {
	listTerminalsByNarrator: (narratorId: string) => {
		const params = new URLSearchParams({ narratorId });
		return request<ApiEntity[]>(`/terminals?${params}`);
	},
	/**
	 * Running terminals of the subagents below a narrator (read-only list). `canOpen` is
	 * whether this user may open them: write access on the session's root.
	 */
	listTreeTerminals: (narratorId: string) => {
		const params = new URLSearchParams({ narratorId });
		return request<TreeTerminalListing>(`/terminals/tree?${params}`);
	},
	/** Whether the current user may open this narrator's terminals (write access). */
	getTerminalAccess: (narratorId: string) => {
		const params = new URLSearchParams({ narratorId });
		return request<{ canOpen: boolean }>(`/terminals/access?${params}`);
	},
	createTerminal: (data: {
		narratorId?: string;
		name?: string;
		cols?: number;
		rows?: number;
		deviceId?: string;
	}) => request<ApiEntity>("/terminals", { method: "POST", body: JSON.stringify(data) }),
	getTerminal: (id: string) => request<ApiEntity>(`/terminals/${id}`),
	getTerminalProcesses: (id: string) =>
		request<{ pid: number; command: string }[]>(`/terminals/${id}/processes`),
	deleteTerminal: (id: string) => request<ApiEntity>(`/terminals/${id}`, { method: "DELETE" }),
	renameTerminal: (id: string, name: string) =>
		request<ApiEntity>(`/terminals/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ name }),
		}),

	// Terminal Tabs: removed. Five clients (list/create/update/delete/reorder) named
	// `/terminals/tabs`, all with zero call sites; the routes, service and `terminal_tabs`
	// table are gone too. The live terminal UI derives tabs from running terminals and
	// stores only their order in `terminal_view_state` (below, which is in use).

	// Terminal View State
	getTerminalViewState: (opts: { narratorId?: string }) => {
		const params = new URLSearchParams();
		if (opts.narratorId) params.set("narratorId", opts.narratorId);
		return request<ApiEntity>(`/terminals/view-state?${params}`);
	},
	updateTerminalViewState: (data: {
		narratorId?: string;
		layout?: string;
		activeTabId?: string | null;
		panelAssignments?: Record<string, string | string[]> | null;
	}) =>
		request<ApiEntity>("/terminals/view-state", {
			method: "PUT",
			body: JSON.stringify(data),
		}),
};
