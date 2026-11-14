import type { Locale } from "@shared/i18n-locales";
import type {
	ScheduledTaskCleanupPolicy,
	ScheduledTaskCleanupResult,
} from "@shared/scheduled-task-cleanup";
import type { TaskSchedule } from "@shared/scheduled-task-schedule";
import type {
	RunOutcome,
	RunVerdict,
	ScheduledRunStatus,
	TaskLifecycle,
	TaskModelPolicy,
	TaskOnBlockedPolicy,
} from "@shared/scheduled-task-status";
import type { ScheduledTaskSearch } from "../scheduled-task-search";
import { request } from "./client";

export type ScheduledTaskRunContext = "standalone" | "project";
export type ScheduledTaskNarratorMode = "new" | "reuse";
export type ScheduledTaskLocale = Locale;
export type ScheduledTaskLastStatus = ScheduledRunStatus;

export interface SchedulePreview {
	occurrences: string[];
	finite: boolean;
	total: number | null;
	remaining: number | null;
	endsAt: string | null;
	exhausted: boolean;
	schedule?: TaskSchedule;
}

export interface ScheduledTaskCapabilities {
	canEdit: boolean;
	canPause: boolean;
	canRun: boolean;
	canDelete: boolean;
	canSeePrompt: boolean;
	canTransfer?: boolean;
}

/** List responses are summaries. Prompt bodies exist only on authorized detail responses. */
export interface ScheduledTask {
	id: string;
	name: string;
	enabled: boolean;
	cronExpr: string;
	schedule: TaskSchedule | null;
	timezone: string | null;
	prompt?: string;
	systemPrompt?: string | null;
	model: string | null;
	permissionMode: string;
	locale: ScheduledTaskLocale;
	runContext: ScheduledTaskRunContext;
	cwd: string | null;
	projectId: string | null;
	narratorMode: ScheduledTaskNarratorMode;
	cleanupPolicy: ScheduledTaskCleanupPolicy;
	reuseNarratorId: string | null;
	createdBy: string | null;
	ownerUserId: string | null;
	creatorKind: "user" | "narrator";
	owner: { id: string; username: string } | null;
	creator: {
		kind: "user" | "narrator";
		username: string | null;
		narratorTitle: string | null;
		narratorId: string | null;
		messageId: string | null;
		toolCallId: string | null;
		deleted: boolean;
		canOpen: boolean;
	};
	capabilities: ScheduledTaskCapabilities;
	lifecycle: TaskLifecycle;
	firedCount: number;
	completedAt: string | null;
	pauseReason: string | null;
	modelPolicy: TaskModelPolicy;
	onBlocked: TaskOnBlockedPolicy;
	blockedWaitMinutes: number;
	maxRunMinutes: number;
	notifyOnSuccess: boolean;
	lastRunId: string | null;
	lastRunAt: string | null;
	nextRunAt: string | null;
	lastNarratorId: string | null;
	lastStatus: ScheduledTaskLastStatus | null;
	lastOutcome: RunOutcome | null;
	lastSummary: string | null;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
	preview?: SchedulePreview;
}

export interface ScheduledTaskRun {
	id: string;
	taskId: string;
	narratorId: string | null;
	status: ScheduledTaskLastStatus;
	outcome: RunOutcome | null;
	verdict: RunVerdict;
	outcomeSummary: string | null;
	blockReason: string | null;
	errorKind: string | null;
	error: string | null;
	model: string | null;
	scheduledFor: string | null;
	trigger: "schedule" | "manual";
	triggerMessageId: string | null;
	missedCount: number | null;
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
	cronExpr?: string;
	schedule?: TaskSchedule;
	timezone?: string | null;
	prompt: string;
	systemPrompt?: string | null;
	model?: string | null;
	permissionMode?: string;
	locale?: ScheduledTaskLocale;
	runContext?: ScheduledTaskRunContext;
	cwd?: string | null;
	projectId?: string | null;
	narratorMode?: ScheduledTaskNarratorMode;
	cleanupPolicy?: ScheduledTaskCleanupPolicy;
	enabled?: boolean;
	modelPolicy?: TaskModelPolicy;
	onBlocked?: TaskOnBlockedPolicy;
	blockedWaitMinutes?: number;
	maxRunMinutes?: number;
	notifyOnSuccess?: boolean;
}

export const scheduledTasksApi = {
	listScheduledTaskTransferUsers: (signal?: AbortSignal) =>
		request<Array<{ id: string; username: string }>>("/admin/users", { signal }),
	listScheduledTasks: (filters: ScheduledTaskSearch = {}, signal?: AbortSignal) => {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(filters)) {
			if (value !== undefined) params.set(key, String(value));
		}
		const qs = params.toString();
		return request<ScheduledTask[]>(`/scheduled-tasks${qs ? `?${qs}` : ""}`, { signal });
	},
	getScheduledTask: (id: string, signal?: AbortSignal) =>
		request<ScheduledTask>(`/scheduled-tasks/${encodeURIComponent(id)}`, { signal }),
	listScheduledTaskRuns: (
		id: string,
		opts?: { limit?: number; cursor?: string | null; result?: RunVerdict },
		signal?: AbortSignal,
	) => {
		const params = new URLSearchParams();
		if (opts?.limit != null) params.set("limit", String(opts.limit));
		if (opts?.cursor) params.set("cursor", opts.cursor);
		if (opts?.result) params.set("result", opts.result);
		const qs = params.toString();
		return request<ScheduledTaskRunsPage>(
			`/scheduled-tasks/${encodeURIComponent(id)}/runs${qs ? `?${qs}` : ""}`,
			{ signal },
		);
	},
	previewScheduledTask: (
		data: { schedule: TaskSchedule; timezone: string | null; count?: number; firedCount?: number },
		signal?: AbortSignal,
	) =>
		request<SchedulePreview>("/scheduled-tasks/preview-schedule", {
			method: "POST",
			body: JSON.stringify(data),
			signal,
		}),
	createScheduledTask: (data: ScheduledTaskInput) =>
		request<ScheduledTask>("/scheduled-tasks", { method: "POST", body: JSON.stringify(data) }),
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
		request<ScheduledTask>(`/scheduled-tasks/${encodeURIComponent(id)}/run`, { method: "POST" }),
	cleanupScheduledTask: (id: string) =>
		request<ScheduledTaskCleanupResult>(`/scheduled-tasks/${encodeURIComponent(id)}/cleanup`, {
			method: "POST",
		}),
	transferScheduledTask: (id: string, ownerUserId: string) =>
		request<ScheduledTask>(`/scheduled-tasks/${encodeURIComponent(id)}/transfer`, {
			method: "POST",
			body: JSON.stringify({ ownerUserId }),
		}),
	deleteScheduledTask: (id: string) =>
		request<{ ok: boolean }>(`/scheduled-tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
