import { SUPPORTED_LOCALES } from "@shared/i18n-locales";
import { z } from "zod/v4";
import { PERMISSION_MODES } from "../../permission-modes";
import { SCHEDULED_TASK_ACTIONS } from "./scheduled-task-actions";

const wallTime = z.string().regex(/^\d{2}:\d{2}$/);
const wallDateTime = z.string().max(25);
const interval = z.number().int().min(1).max(10000);
const times = z.array(wallTime).min(1).max(24);
const end = z.discriminatedUnion("type", [
	z.object({ type: z.literal("never") }),
	z.object({ type: z.literal("count"), count: z.number().int().min(1).max(10000) }),
	z.object({ type: z.literal("until"), until: wallDateTime }),
]);
const rule = z.discriminatedUnion("unit", [
	z.object({ unit: z.literal("minute"), interval }),
	z.object({ unit: z.literal("hour"), interval, minute: z.number().int().min(0).max(59) }),
	z.object({ unit: z.literal("day"), interval, times }),
	z.object({
		unit: z.literal("week"),
		interval,
		times,
		weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
	}),
	z.object({
		unit: z.literal("month"),
		interval,
		times,
		monthDays: z
			.array(z.union([z.number().int().min(1).max(31), z.literal("last")]))
			.min(1)
			.max(32),
	}),
]);
export const scheduledTaskScheduleSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("at"), times: z.array(wallDateTime).min(1).max(50) }),
	z.object({
		kind: z.literal("repeat"),
		rule,
		end,
		startAt: wallDateTime.nullable().optional(),
		anchorAt: z
			.string()
			.max(40)
			.optional()
			.describe("Server-managed alignment anchor; omit on creation."),
	}),
	z.object({
		kind: z.literal("cron"),
		expr: z.string().min(1).max(200),
		end,
		startAt: wallDateTime.nullable().optional(),
	}),
]);

/** Only user-editable fields. Owner, provenance and capability grants never come from the model. */
export const scheduledTaskFieldsSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	schedule: scheduledTaskScheduleSchema.optional(),
	cronExpr: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe("Legacy shorthand for a cron schedule; use schedule for finite or calendar rules."),
	timezone: z
		.string()
		.min(1)
		.max(100)
		.nullable()
		.optional()
		.describe(
			"IANA timezone. Omitted/null uses the server timezone, explicitly reported in the result.",
		),
	prompt: z.string().min(1).max(50000).optional(),
	systemPrompt: z.string().max(10000).nullable().optional(),
	model: z.string().max(200).nullable().optional(),
	permissionMode: z
		.enum(PERMISSION_MODES)
		.optional()
		.describe(
			"Defaults to this session's effective mode. Any expansion requires explicit human approval; hard ceilings cannot be delegated.",
		),
	locale: z.enum(SUPPORTED_LOCALES).optional(),
	runContext: z.enum(["standalone", "project"]).optional(),
	cwd: z
		.string()
		.min(1)
		.max(4096)
		.nullable()
		.optional()
		.describe("Defaults to this session's working directory, not the server home."),
	projectId: z.string().min(1).max(100).nullable().optional(),
	narratorMode: z.enum(["new", "reuse"]).optional(),
	modelPolicy: z.enum(["follow", "temporary", "sync"]).optional(),
	onBlocked: z.enum(["auto", "wait"]).optional(),
	blockedWaitMinutes: z.number().int().min(1).max(1440).optional(),
	maxRunMinutes: z.number().int().min(5).max(1440).optional(),
	notifyOnSuccess: z.boolean().optional(),
	enabled: z.boolean().optional(),
});
export type ScheduledTaskFields = z.infer<typeof scheduledTaskFieldsSchema>;

export const scheduledTaskParametersSchema = z.object({
	action: z.enum(SCHEDULED_TASK_ACTIONS),
	id: z.string().min(1).max(100).optional(),
	task: scheduledTaskFieldsSchema
		.optional()
		.describe(
			"create requires name, prompt, and schedule or cronExpr. update changes only supplied fields. preview requires a schedule or cronExpr.",
		),
	limit: z.number().int().min(1).max(50).optional(),
	cursor: z.string().max(100).optional(),
	filters: z
		.object({
			lifecycle: z.enum(["active", "ended", "all"]).optional(),
			q: z.string().max(200).optional(),
			projectId: z.string().max(100).optional(),
			kind: z.enum(["at", "repeat", "cron"]).optional(),
		})
		.optional(),
});
export type ScheduledTaskParameters = z.infer<typeof scheduledTaskParametersSchema>;

export function validateScheduledTaskArguments(input: ScheduledTaskParameters): void {
	if (!["list", "preview", "create"].includes(input.action) && !input.id)
		throw new Error(`'id' is required for the ${input.action} action.`);
	if (input.action === "create") {
		const missing = [
			!input.task?.name && "task.name",
			!input.task?.prompt && "task.prompt",
			!input.task?.schedule && !input.task?.cronExpr && "task.schedule or task.cronExpr",
		].filter(Boolean);
		if (missing.length) throw new Error(`create requires ${missing.join(", ")}.`);
	}
	if (input.action === "preview" && !input.task?.schedule && !input.task?.cronExpr)
		throw new Error("preview requires task.schedule or task.cronExpr.");
	if (input.action === "update" && !Object.keys(input.task ?? {}).length)
		throw new Error("update requires at least one field in task.");
	if (input.task?.schedule && input.task.cronExpr)
		throw new Error("Provide either task.schedule or task.cronExpr, not both.");
}
