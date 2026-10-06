import { z } from "zod";
import { isValidCron } from "../cron";
import { permissionModeSchema } from "../permission-modes";
import { localeSchema } from "./common";

const runContextEnum = z.enum(["standalone", "chapter"]);
const narratorModeEnum = z.enum(["new", "reuse"]);

export const scheduledTaskCleanupPolicySchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("none") }),
	z.object({ mode: z.literal("keepLatestN"), keepLatestN: z.number().int().min(1).max(1000) }),
	z.object({ mode: z.literal("olderThanDays"), olderThanDays: z.number().int().min(1).max(3650) }),
]);

const baseFields = {
	name: z.string().min(1).max(200),
	cronExpr: z.string().min(1).max(200),
	timezone: z.string().max(100).optional().nullable(),
	prompt: z.string().min(1).max(50000),
	systemPrompt: z.string().max(10000).optional().nullable(),
	model: z.string().max(200).optional().nullable(),
	permissionMode: permissionModeSchema.optional(),
	locale: localeSchema.optional(),
	runContext: runContextEnum.optional(),
	cwd: z.string().max(4096).optional().nullable(),
	projectId: z.string().max(100).optional().nullable(),
	chapterId: z.string().max(100).optional().nullable(),
	narratorMode: narratorModeEnum.optional(),
	cleanupPolicy: scheduledTaskCleanupPolicySchema.optional(),
	enabled: z.boolean().optional(),
};

export const createScheduledTaskSchema = z
	.object({
		...baseFields,
		runContext: runContextEnum.default("standalone"),
		enabled: z.boolean().default(true),
	})
	.refine((d) => isValidCron(d.cronExpr, d.timezone), {
		message: "Invalid cron expression",
		path: ["cronExpr"],
	})
	// chapter runContext requires both projectId and chapterId; standalone ignores them.
	.refine((d) => d.runContext !== "chapter" || (!!d.projectId && !!d.chapterId), {
		message: "chapter runContext requires projectId and chapterId",
	});

export const updateScheduledTaskSchema = z
	.object({
		...baseFields,
	})
	.partial()
	.refine((d) => d.cronExpr === undefined || isValidCron(d.cronExpr, d.timezone), {
		message: "Invalid cron expression",
		path: ["cronExpr"],
	})
	.refine((d) => d.runContext !== "chapter" || (!!d.projectId && !!d.chapterId), {
		message: "chapter runContext requires projectId and chapterId",
	});

export const toggleScheduledTaskSchema = z.object({
	enabled: z.boolean(),
});
