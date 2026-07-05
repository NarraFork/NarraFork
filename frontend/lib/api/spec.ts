import { request } from "./client";

export interface SpecFileMeta {
	path: string;
	uri: string;
	readonly: boolean;
	builtin: boolean;
	revisionId: string | null;
}

export interface SpecFileDetail extends SpecFileMeta {
	content: string;
}

export interface SpecTaskItem {
	text: string;
	status: "todo" | "doing" | "done" | "blocked";
	protected?: true;
}

export interface SpecCompiledTasks {
	tasks: SpecTaskItem[];
	currentTask: SpecTaskItem | null;
	nextTask: SpecTaskItem | null;
	blocked: boolean;
	complete: boolean;
	protectedOpenCount: number;
}

export interface SpecTasksResponse {
	content: string;
	revisionId: string | null;
	document: { tasks: SpecTaskItem[] };
	compiled: SpecCompiledTasks;
}

export interface SpecWriteResult {
	path: string;
	uri: string;
	revisionId: string | null;
	readonly: boolean;
}

export const specApi = {
	listSpecFiles: (narratorId: string) =>
		request<{ files: SpecFileMeta[] }>(`/narrators/${narratorId}/spec/files`),

	readSpecFile: (narratorId: string, uri: string) =>
		request<SpecFileDetail>(`/narrators/${narratorId}/spec/file?uri=${encodeURIComponent(uri)}`),

	readSpecTasks: (narratorId: string) =>
		request<SpecTasksResponse>(`/narrators/${narratorId}/spec/tasks`),

	writeSpecFile: (
		narratorId: string,
		data: {
			uri: string;
			content: string;
			baseRevisionId?: string | null;
			notifyAgent?: boolean;
		},
	) =>
		request<SpecWriteResult>(`/narrators/${narratorId}/spec/file`, {
			method: "PUT",
			body: JSON.stringify(data),
		}),
};
