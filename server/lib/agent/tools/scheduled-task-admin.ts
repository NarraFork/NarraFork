import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";
import { errorResult, isAdminUser, requestWritePermission, truncateText } from "./admin-common";

/**
 * ScheduledTaskAdmin — optional, admin-only agent tool for managing scheduled
 * narrator tasks (cron). Tasks launch (or reuse) narrators with a prompt,
 * potentially under bypassPermissions, so every mutation and manual run
 * requires admin identity + user approval.
 */

const taskActionSchema = z.enum([
	"list",
	"get",
	"create",
	"update",
	"toggle",
	"run",
	"delete",
	"runs",
]);

const taskFieldsSchema = {
	name: z.string().min(1).max(200).optional().describe("Task display name"),
	cronExpr: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe("Cron expression, e.g. '0 9 * * *' (5 or 6 fields)"),
	timezone: z
		.string()
		.max(100)
		.nullable()
		.optional()
		.describe("IANA timezone, e.g. 'Asia/Shanghai' (defaults to server timezone)"),
	prompt: z.string().min(1).max(50000).optional().describe("Prompt injected into the narrator run"),
	systemPrompt: z
		.string()
		.max(10000)
		.nullable()
		.optional()
		.describe("Optional override system prompt"),
	model: z.string().max(200).nullable().optional().describe("Optional narrator model"),
	permissionMode: z
		.string()
		.optional()
		.describe("Narrator permission mode (e.g. bypassPermissions)"),
	runContext: z
		.enum(["standalone", "chapter"])
		.optional()
		.describe("Run context (default standalone)"),
	cwd: z.string().max(4096).nullable().optional().describe("Working directory for the narrator"),
	projectId: z.string().max(100).nullable().optional().describe("Project id (chapter runContext)"),
	chapterId: z.string().max(100).nullable().optional().describe("Chapter id (chapter runContext)"),
	narratorMode: z
		.enum(["new", "reuse"])
		.optional()
		.describe("new = spawn narrator, reuse = reuse existing"),
	enabled: z.boolean().optional().describe("Whether the task is enabled"),
};

export interface ScheduledTaskAdminToolDeps {
	/** Test seam: scheduled task service-like object. Defaults to lazy import. */
	service?: ScheduledTaskServiceLike;
	/** Test seam: admin check. Defaults to DB role check. */
	isAdminUser?: (userId: string | null | undefined) => Promise<boolean> | boolean;
}

export interface ScheduledTaskServiceLike {
	list(): Promise<Array<Record<string, unknown>>>;
	get(id: string): Promise<Record<string, unknown> | undefined>;
	create(input: Record<string, unknown>): Promise<Record<string, unknown>>;
	update(id: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
	setEnabled(id: string, enabled: boolean): Promise<Record<string, unknown>>;
	delete(id: string): Promise<void>;
	runTask(id: string, opts?: { manual?: boolean }): Promise<void>;
	listRuns(
		taskId: string,
		opts?: { limit?: number; cursor?: string | null },
	): Promise<{ runs: Array<Record<string, unknown>>; nextCursor: string | null }>;
}

export function createScheduledTaskAdminTool(
	deps: ScheduledTaskAdminToolDeps = {},
): ToolDefinition {
	return {
		name: "ScheduledTaskAdmin",
		description:
			"Manage scheduled narrator tasks (admin only, mutating actions require approval). action=list/get/runs read tasks and run history; action=create schedules a cron task that launches a narrator with a prompt; action=update modifies one; action=toggle enables/disables; action=run triggers an immediate run; action=delete removes one.",
		parameters: z.object({
			action: taskActionSchema.describe("The scheduled task action to perform."),
			id: z
				.string()
				.min(1)
				.max(100)
				.optional()
				.describe("Task id (get/update/toggle/run/delete/runs)."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.describe("Max run-history rows (runs, default 50)"),
			cursor: z
				.string()
				.max(200)
				.optional()
				.describe("Run-history pagination cursor from a previous runs result"),
			...taskFieldsSchema,
		}),
		async execute(args, ctx): Promise<ToolResult> {
			const input = args as Record<string, unknown>;
			const action = input.action as string;
			const service = deps.service ?? (await loadTaskService());
			const isAdmin = deps.isAdminUser ?? isAdminUser;
			try {
				if (action === "list") {
					const tasks = await service.list();
					return {
						output:
							tasks.length === 0
								? "No scheduled tasks configured."
								: JSON.stringify(tasks.map(sanitizeTask), null, 2),
						title: "Scheduled tasks",
						metadata: { tool: "ScheduledTaskAdmin", action, count: tasks.length },
					};
				}

				if (action === "get" || action === "runs") {
					const id = input.id as string | undefined;
					if (!id) return errorResult("Error: 'id' is required for this action.");
					if (action === "get") {
						const task = await service.get(id);
						if (!task) return errorResult(`Scheduled task not found: ${id}`);
						return {
							output: JSON.stringify(sanitizeTask(task), null, 2),
							title: "Scheduled task",
							metadata: { tool: "ScheduledTaskAdmin", action, taskId: id },
						};
					}
					const result = await service.listRuns(id, {
						...(input.limit !== undefined && { limit: input.limit as number }),
						...(input.cursor !== undefined && { cursor: input.cursor as string }),
					});
					return {
						output: JSON.stringify(
							{
								runs: (result.runs ?? []).map(sanitizeRun),
								nextCursor: result.nextCursor,
							},
							null,
							2,
						),
						title: "Scheduled task runs",
						metadata: {
							tool: "ScheduledTaskAdmin",
							action,
							taskId: id,
							count: (result.runs ?? []).length,
						},
					};
				}

				if (!(await isAdmin(ctx.userId))) {
					return errorResult(
						"ScheduledTaskAdmin is restricted to administrators.",
						"ScheduledTaskAdmin denied",
					);
				}

				if (action === "create") {
					const denied = await requestWritePermission(ctx, "ScheduledTaskAdmin", {
						action,
						...(input.name !== undefined && { name: input.name }),
						...(input.cronExpr !== undefined && { cronExpr: input.cronExpr }),
						...(input.prompt !== undefined && { prompt: truncateText(input.prompt, 500) }),
						warning:
							"This will create a scheduled task that periodically launches a narrator with the given prompt (unattended, often under bypassPermissions).",
					});
					if (denied) return errorResult(denied, "ScheduledTaskAdmin denied");

					const { createScheduledTaskSchema } = await import("../../validators");
					const parsed = createScheduledTaskSchema.safeParse(input);
					if (!parsed.success) {
						return errorResult(`Invalid scheduled task: ${parsed.error.message}`);
					}
					const task = await service.create({ ...parsed.data, createdBy: ctx.userId ?? null });
					return {
						output: JSON.stringify(sanitizeTask(task), null, 2),
						title: "Scheduled task created",
						metadata: { tool: "ScheduledTaskAdmin", action, taskId: task.id },
					};
				}

				const id = input.id as string | undefined;
				if (!id) return errorResult("Error: 'id' is required for this action.");
				const existing = await service.get(id);
				if (!existing) return errorResult(`Scheduled task not found: ${id}`);

				const denied = await requestWritePermission(ctx, "ScheduledTaskAdmin", {
					action,
					id,
					name: existing.name,
					warning:
						action === "delete"
							? "This will permanently delete the scheduled task."
							: action === "run"
								? "This will immediately launch a narrator for this scheduled task (out of schedule)."
								: action === "toggle"
									? "This will enable or disable the scheduled task."
									: "This will modify the scheduled task configuration.",
				});
				if (denied) return errorResult(denied, "ScheduledTaskAdmin denied");

				if (action === "delete") {
					await service.delete(id);
					return {
						output: `Deleted scheduled task ${id}.`,
						title: "Scheduled task deleted",
						metadata: { tool: "ScheduledTaskAdmin", action, taskId: id },
					};
				}
				if (action === "run") {
					await service.runTask(id, { manual: true });
					const task = await service.get(id);
					if (!task) return errorResult(`Scheduled task not found: ${id}`);
					return {
						output: JSON.stringify(sanitizeTask(task), null, 2),
						title: "Scheduled task triggered",
						metadata: { tool: "ScheduledTaskAdmin", action, taskId: id },
					};
				}
				if (action === "toggle") {
					if (typeof input.enabled !== "boolean") {
						return errorResult("Error: 'enabled' (boolean) is required for toggle.");
					}
					const task = await service.setEnabled(id, input.enabled);
					return {
						output: JSON.stringify(sanitizeTask(task), null, 2),
						title: input.enabled ? "Scheduled task enabled" : "Scheduled task disabled",
						metadata: { tool: "ScheduledTaskAdmin", action, taskId: id, enabled: input.enabled },
					};
				}
				if (action === "update") {
					const { updateScheduledTaskSchema } = await import("../../validators");
					const parsed = updateScheduledTaskSchema.safeParse(input);
					if (!parsed.success) {
						return errorResult(`Invalid scheduled task update: ${parsed.error.message}`);
					}
					const task = await service.update(id, parsed.data as Record<string, unknown>);
					return {
						output: JSON.stringify(sanitizeTask(task), null, 2),
						title: "Scheduled task updated",
						metadata: { tool: "ScheduledTaskAdmin", action, taskId: id },
					};
				}

				return errorResult(`Unknown ScheduledTaskAdmin action: ${action}`);
			} catch (error) {
				return errorResult(
					`ScheduledTaskAdmin failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
	};
}

/** Project a task for model output: truncate long prompt fields. */
function sanitizeTask(task: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of [
		"id",
		"name",
		"enabled",
		"cronExpr",
		"timezone",
		"model",
		"permissionMode",
		"runContext",
		"cwd",
		"projectId",
		"chapterId",
		"narratorMode",
		"reuseNarratorId",
		"createdBy",
		"lastRunAt",
		"nextRunAt",
		"lastNarratorId",
		"lastStatus",
		"lastError",
		"createdAt",
		"updatedAt",
	]) {
		if (task[key] !== undefined) result[key] = task[key];
	}
	if (task.prompt !== undefined) result.prompt = truncateText(task.prompt, 1_000);
	if (task.systemPrompt !== undefined && task.systemPrompt !== null) {
		result.systemPrompt = truncateText(task.systemPrompt, 500);
	}
	return result;
}

function sanitizeRun(run: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of [
		"id",
		"taskId",
		"narratorId",
		"status",
		"runContext",
		"manual",
		"startedAt",
		"finishedAt",
		"durationMs",
		"createdAt",
	]) {
		if (run[key] !== undefined) result[key] = run[key];
	}
	if (run.error !== undefined && run.error !== null) result.error = truncateText(run.error, 500);
	return result;
}

async function loadTaskService(): Promise<ScheduledTaskServiceLike> {
	const mod = await import("../../../services/scheduled-task-service");
	return mod.scheduledTaskService as unknown as ScheduledTaskServiceLike;
}

export const scheduledTaskAdminTool: ToolDefinition = createScheduledTaskAdminTool();
