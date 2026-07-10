import { request } from "./client";

export type ScheduledTaskRunContext = "standalone" | "chapter";
export type ScheduledTaskNarratorMode = "new" | "reuse";
export type ScheduledTaskLocale = "en" | "zh-CN";
export type ScheduledTaskLastStatus = "success" | "failed" | "skipped";

export interface ScheduledTask {
	id: string;
	name: string;
	enabled: boolean;
	cronExpr: string;
	timezone: string | null;
	prompt: string;
	systemPrompt: string | null;
	model: string | null;
	permissionMode: string;
	locale: ScheduledTaskLocale;
	runContext: ScheduledTaskRunContext;
	cwd: string | null;
	projectId: string | null;
	chapterId: string | null;
	narratorMode: ScheduledTaskNarratorMode;
	reuseNarratorId: string | null;
	createdBy: string | null;
	lastRunAt: string | null;
	nextRunAt: string | null;
	lastNarratorId: string | null;
	lastStatus: ScheduledTaskLastStatus | null;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ScheduledTaskInput {
	name: string;
	cronExpr: string;
	timezone?: string | null;
	prompt: string;
	systemPrompt?: string | null;
	model?: string | null;
	permissionMode?: string;
	locale?: ScheduledTaskLocale;
	runContext?: ScheduledTaskRunContext;
	cwd?: string | null;
	projectId?: string | null;
	chapterId?: string | null;
	narratorMode?: ScheduledTaskNarratorMode;
	enabled?: boolean;
}

export const scheduledTasksApi = {
	listScheduledTasks: () => request<ScheduledTask[]>("/scheduled-tasks"),
	getScheduledTask: (id: string) =>
		request<ScheduledTask>(`/scheduled-tasks/${encodeURIComponent(id)}`),
	createScheduledTask: (data: ScheduledTaskInput) =>
		request<ScheduledTask>("/scheduled-tasks", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateScheduledTask: (id: string, data: Partial<ScheduledTaskInput>) =>
		request<ScheduledTask>(`/scheduled-tasks/${encodeURIComponent(id)}`, {
			method: "PUT",
			body: JSON.stringify(data),
		}),
	toggleScheduledTask: (id: string, enabled: boolean) =>
		request<ScheduledTask>(`/scheduled-tasks/${encodeURIComponent(id)}/toggle`, {
			method: "POST",
			body: JSON.stringify({ enabled }),
		}),
	runScheduledTask: (id: string) =>
		request<ScheduledTask>(`/scheduled-tasks/${encodeURIComponent(id)}/run`, {
			method: "POST",
		}),
	deleteScheduledTask: (id: string) =>
		request<{ ok: boolean }>(`/scheduled-tasks/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}),
};
