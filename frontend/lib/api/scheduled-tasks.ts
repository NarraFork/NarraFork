import type { Locale } from "@shared/i18n-locales";
import { request } from "./client";

export type ScheduledTaskRunContext = "standalone" | "chapter";
export type ScheduledTaskNarratorMode = "new" | "reuse";
export type ScheduledTaskLocale = Locale;
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

export interface ScheduledTaskRun {
	id: string;
	taskId: string;
	narratorId: string | null;
	status: ScheduledTaskLastStatus;
	error: string | null;
	runContext: ScheduledTaskRunContext;
	manual: boolean;
	startedAt: string | null;
	finishedAt: string | null;
	durationMs: number | null;
	createdAt: string;
}

export interface ScheduledTaskRunsPage {
	runs: ScheduledTaskRun[];
	nextCursor: string | null;
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
	listScheduledTaskRuns: (id: string, opts?: { limit?: number; cursor?: string | null }) => {
		const params = new URLSearchParams();
		if (opts?.limit != null) params.set("limit", String(opts.limit));
		if (opts?.cursor) params.set("cursor", opts.cursor);
		const qs = params.toString();
		return request<ScheduledTaskRunsPage>(
			`/scheduled-tasks/${encodeURIComponent(id)}/runs${qs ? `?${qs}` : ""}`,
		);
	},
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
