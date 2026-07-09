import { request } from "./client";
import type { ApiEntity } from "./types";

export const terminalsApi = {
	listTerminals: (chapterId: string) => {
		const params = new URLSearchParams({ chapterId });
		return request<ApiEntity[]>(`/terminals?${params}`);
	},
	listTerminalsByNarrator: (narratorId: string) => {
		const params = new URLSearchParams({ narratorId });
		return request<ApiEntity[]>(`/terminals?${params}`);
	},
	createTerminal: (data: {
		chapterId?: string;
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
	updateTerminalGraphState: (
		id: string,
		state: {
			graphOpened?: boolean;
			graphX?: number;
			graphY?: number;
			graphWidth?: number;
			graphHeight?: number;
		},
	) =>
		request<ApiEntity>(`/terminals/${id}`, {
			method: "PATCH",
			body: JSON.stringify(state),
		}),

	// Terminal Tabs
	listTerminalTabs: (opts: { chapterId?: string; narratorId?: string }) => {
		const params = new URLSearchParams();
		if (opts.chapterId) params.set("chapterId", opts.chapterId);
		if (opts.narratorId) params.set("narratorId", opts.narratorId);
		return request<ApiEntity[]>(`/terminals/tabs?${params}`);
	},
	createTerminalTab: (data: { chapterId?: string; narratorId?: string; name: string }) =>
		request<ApiEntity>("/terminals/tabs", { method: "POST", body: JSON.stringify(data) }),
	updateTerminalTab: (id: string, data: { name?: string }) =>
		request<ApiEntity>(`/terminals/tabs/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	deleteTerminalTab: (id: string) =>
		request<ApiEntity>(`/terminals/tabs/${id}`, { method: "DELETE" }),
	reorderTerminalTabs: (ids: string[]) =>
		request<ApiEntity>("/terminals/tabs/reorder", {
			method: "PUT",
			body: JSON.stringify({ ids }),
		}),

	// Terminal View State
	getTerminalViewState: (opts: { chapterId?: string; narratorId?: string }) => {
		const params = new URLSearchParams();
		if (opts.chapterId) params.set("chapterId", opts.chapterId);
		if (opts.narratorId) params.set("narratorId", opts.narratorId);
		return request<ApiEntity>(`/terminals/view-state?${params}`);
	},
	updateTerminalViewState: (data: {
		chapterId?: string;
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
