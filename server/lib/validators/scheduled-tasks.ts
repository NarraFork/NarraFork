import { parseSchedule, type TaskSchedule } from "@shared/scheduled-task-schedule";
import {
	TASK_CONTEXT_POLICIES,
	TASK_MODEL_POLICIES,
	TASK_NARRATOR_MODES,
	TASK_ON_BLOCKED_POLICIES,
	TASK_ON_BUSY_POLICIES,
} from "@shared/scheduled-task-status";
import { z } from "zod";
import { permissionModeSchema } from "../permission-modes";
import { localeSchema } from "./common";

export const scheduledTaskCleanupPolicySchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("none") }),
	z.object({ mode: z.literal("keepLatestN"), keepLatestN: z.number().int().min(1).max(1000) }),
	z.object({ mode: z.literal("olderThanDays"), olderThanDays: z.number().int().min(1).max(3650) }),
]);

/** Structural parsing only; partial updates are validated with the persisted timezone in the service. */
export const taskScheduleSchema = z.unknown().transform((input, ctx): TaskSchedule => {
	const parsed = parseSchedule(input);
	if (parsed.ok) return parsed.schedule;
	ctx.addIssue({
		code: "custom",
		message: parsed.issue.code,
		path: parsed.issue.path.split(".").filter(Boolean),
	});
	return z.NEVER;
});

const baseFields = {
	name: z.string().trim().min(1).max(200),
	cronExpr: z.string().trim().min(1).max(200).optional(),
	schedule: taskScheduleSchema.optional(),
	timezone: z.string().trim().max(100).nullable().optional(),
	prompt: z
		.string()
		.min(1)
		.max(50000)
		.refine((s) => !!s.trim()),
	systemPrompt: z.string().max(10000).nullable().optional(),
	model: z.string().max(200).nullable().optional(),
	permissionMode: permissionModeSchema.optional(),
	locale: localeSchema.optional(),
	runContext: z.enum(["standalone", "project"]).optional(),
	cwd: z.string().max(4096).nullable().optional(),
	projectId: z.string().min(1).max(100).nullable().optional(),
	narratorMode: z.enum(TASK_NARRATOR_MODES).optional(),
	targetNarratorId: z.string().min(1).max(100).nullable().optional(),
	contextPolicy: z.enum(TASK_CONTEXT_POLICIES).optional(),
	onBusy: z.enum(TASK_ON_BUSY_POLICIES).optional(),
	busyWaitMinutes: z.number().int().min(1).max(1440).optional(),
	requireReport: z.boolean().optional(),
	cleanupPolicy: scheduledTaskCleanupPolicySchema.optional(),
	enabled: z.boolean().optional(),
	modelPolicy: z.enum(TASK_MODEL_POLICIES).optional(),
	onBlocked: z.enum(TASK_ON_BLOCKED_POLICIES).optional(),
	blockedWaitMinutes: z.number().int().min(1).max(1440).optional(),
	maxRunMinutes: z.number().int().min(5).max(1440).optional(),
	notifyOnSuccess: z.boolean().optional(),
};

export const createScheduledTaskSchema = z
	.object(baseFields)
	.refine((v) => v.schedule !== undefined || !!v.cronExpr, {
		message: "schedule or cronExpr is required",
		path: ["schedule"],
	})
	.refine((v) => v.narratorMode === "existing" || v.runContext !== "project" || !!v.projectId, {
		message: "project runContext requires projectId",
		path: ["projectId"],
	})
	.refine((v) => v.narratorMode !== "existing" || !!v.targetNarratorId, {
		message: "existing narratorMode requires targetNarratorId",
		path: ["targetNarratorId"],
	});

export const updateScheduledTaskSchema = z
	.object(baseFields)
	.partial()
	.refine((v) => Object.keys(v).length > 0, { message: "At least one task field is required" });
export const toggleScheduledTaskSchema = z.object({ enabled: z.boolean() });
export const scheduledTaskPreviewSchema = z.object({
	schedule: taskScheduleSchema,
	timezone: baseFields.timezone,
	count: z.number().int().min(1).max(20).optional(),
	firedCount: z.number().int().min(0).max(10000).optional(),
});
export const scheduledTaskFiltersSchema = z.object({
	lifecycle: z.enum(["active", "paused", "ended", "all"]).optional(),
	attention: z
		.enum(["true", "false"])
		.transform((v) => v === "true")
		.optional(),
	creator: z.enum(["user", "narrator", "mine"]).optional(),
	owner: z.string().max(100).optional(),
	projectId: z.string().max(100).optional(),
	kind: z.enum(["at", "repeat", "cron"]).optional(),
	result: z
		.enum([
			"succeeded",
			"waiting",
			"completed",
			"unconfirmed",
			"incomplete",
			"failed",
			"timed_out",
			"interrupted",
			"running",
			"blocked",
			"skipped",
			"missed",
			"dispatched",
		])
		.optional(),
	runContext: z.enum(["standalone", "project"]).optional(),
	q: z.string().trim().max(500).optional(),
	sort: z.enum(["nextRun", "lastRun", "createdAt", "name"]).optional(),
});

export const scheduledTaskTargetsQuerySchema = z.object({
	q: z.string().trim().max(200).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
	cursor: z.string().min(1).max(2048).optional(),
});
export const scheduledTaskAssociationsQuerySchema = scheduledTaskTargetsQuerySchema.omit({
	q: true,
});
