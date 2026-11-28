import type { ScheduledTask, ScheduledTaskInput } from "@frontend/lib/api/scheduled-tasks";
import { normalizeLocale } from "@shared/i18n-locales";
import { scheduleSignature, type TaskSchedule } from "@shared/scheduled-task-schedule";
import { taskSchedule } from "./schedule-presentation";

export interface TaskDraft
	extends Omit<
		ScheduledTaskInput,
		"schedule" | "cronExpr" | "timezone" | "systemPrompt" | "model" | "cwd" | "projectId"
	> {
	schedule: TaskSchedule;
	timezone: string;
	systemPrompt: string;
	model: string;
	cwd: string;
	projectId: string;
}

export function createTaskDraft(task?: ScheduledTask, copy = false, locale = "en"): TaskDraft {
	const base: TaskDraft = {
		name: "",
		prompt: "",
		systemPrompt: "",
		model: "",
		cwd: "",
		projectId: "",
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
		schedule: {
			kind: "repeat",
			rule: { unit: "day", interval: 1, times: ["09:00"] },
			end: { type: "never" },
		},
		permissionMode: "default",
		locale: normalizeLocale(locale),
		runContext: "standalone",
		narratorMode: "new",
		targetNarratorId: null,
		contextPolicy: "keep",
		onBusy: "skip",
		busyWaitMinutes: 30,
		requireReport: true,
		cleanupPolicy: { mode: "none" },
		enabled: true,
		modelPolicy: "sync",
		onBlocked: "auto",
		blockedWaitMinutes: 30,
		maxRunMinutes: 60,
		notifyOnSuccess: false,
	};
	if (!task) return base;
	const schedule = structuredClone(taskSchedule(task));
	if (copy && schedule.kind === "repeat") delete schedule.anchorAt;
	return normalizeTaskDraft({
		...base,
		name: task.name,
		prompt: task.prompt ?? "",
		systemPrompt: task.systemPrompt ?? "",
		model: task.model ?? "",
		cwd: task.cwd ?? "",
		projectId: task.projectId ?? "",
		timezone: task.timezone ?? (copy ? base.timezone : ""),
		schedule,
		permissionMode: task.permissionMode,
		locale: task.locale,
		runContext: task.runContext === "standalone" ? "standalone" : "project",
		narratorMode: task.narratorMode,
		targetNarratorId: task.targetNarratorId ?? null,
		contextPolicy: task.contextPolicy ?? "keep",
		onBusy: task.onBusy ?? "skip",
		busyWaitMinutes: task.busyWaitMinutes ?? 30,
		requireReport: task.requireReport ?? true,
		cleanupPolicy: task.cleanupPolicy ?? { mode: "none" },
		enabled: copy ? false : task.enabled,
		modelPolicy: task.modelPolicy ?? "follow",
		onBlocked: task.onBlocked ?? "auto",
		blockedWaitMinutes: task.blockedWaitMinutes ?? 30,
		maxRunMinutes: task.maxRunMinutes ?? 60,
		notifyOnSuccess: task.notifyOnSuccess ?? false,
	});
}

/** Keep hidden creation settings out of an existing target's execution configuration. */
export function normalizeTaskDraft(draft: TaskDraft): TaskDraft {
	if (draft.narratorMode === "existing")
		return {
			...draft,
			cwd: "",
			projectId: "",
			runContext: "standalone",
			permissionMode: "default",
			systemPrompt: "",
			cleanupPolicy: { mode: "none" },
			model: draft.modelPolicy === "follow" ? "" : draft.model,
		};
	return {
		...draft,
		targetNarratorId: null,
		contextPolicy: draft.narratorMode === "reuse" ? draft.contextPolicy : "keep",
		projectId: draft.runContext === "project" ? draft.projectId : "",
	};
}

export function updateTaskDraft(draft: TaskDraft, values: Partial<TaskDraft>): TaskDraft {
	const next = { ...draft, ...values };
	if (values.narratorMode && values.narratorMode !== draft.narratorMode) {
		next.targetNarratorId = null;
		next.contextPolicy = "keep";
		if (values.narratorMode === "existing") {
			next.modelPolicy = "follow";
			next.model = "";
		} else if (draft.narratorMode === "existing") {
			next.modelPolicy = "sync";
			next.model = "";
		}
	}
	return normalizeTaskDraft(next);
}

export function scheduleWasChanged(draft: TaskDraft, initial: TaskDraft): boolean {
	return (
		scheduleSignature(draft.schedule) !== scheduleSignature(initial.schedule) ||
		draft.timezone !== initial.timezone
	);
}

/** Changed cadence previews use a fresh host anchor; untouched edits keep the persisted sequence. */
export function taskPreviewSchedule(draft: TaskDraft, initial?: TaskDraft): TaskSchedule {
	if (draft.schedule.kind !== "repeat" || (initial && !scheduleWasChanged(draft, initial)))
		return draft.schedule;
	const schedule = { ...draft.schedule };
	delete schedule.anchorAt;
	return schedule;
}

/** Do not submit an untouched schedule: saving a prompt must not restart its sequence. */
export function taskDraftInput(draft: TaskDraft): ScheduledTaskInput;
export function taskDraftInput(draft: TaskDraft, initial: TaskDraft): Partial<ScheduledTaskInput>;
export function taskDraftInput(draft: TaskDraft, initial?: TaskDraft): Partial<ScheduledTaskInput> {
	draft = normalizeTaskDraft(draft);
	const { schedule, timezone, ...fields } = draft;
	const input: ScheduledTaskInput = {
		...fields,
		name: draft.name.trim(),
		prompt: draft.prompt.trim(),
		systemPrompt: draft.systemPrompt.trim() || null,
		model: draft.model || null,
		cwd: draft.cwd.trim() || null,
		projectId: draft.runContext === "project" ? draft.projectId : null,
		...(!initial || timezone !== initial.timezone ? { timezone: timezone || null } : {}),
		...(!initial || scheduleSignature(schedule) !== scheduleSignature(initial.schedule)
			? { schedule }
			: {}),
	};
	if (!initial) return input;
	const previous = taskDraftInput(initial);
	return Object.fromEntries(
		Object.entries(input).filter(
			([key, value]) =>
				JSON.stringify(value) !== JSON.stringify(previous[key as keyof ScheduledTaskInput]),
		),
	);
}
