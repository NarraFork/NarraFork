import { z } from "zod/v4";
import type { ToolDefinition } from "../types";
import { executeScheduledTask } from "./scheduled-task";
import { SCHEDULED_TASK_ACTIONS } from "./scheduled-task-actions";
import { scheduledTaskFieldsSchema, scheduledTaskParametersSchema } from "./scheduled-task-schema";

/** One-release compatibility alias. Every action, including reads, still requires a live admin. */
export function createScheduledTaskAdminTool(): ToolDefinition {
	return {
		name: "ScheduledTaskAdmin",
		description:
			"Deprecated compatibility alias, replaced by ScheduledTask. Admin identity is checked live for every action, including list/get/runs/preview. Accepts historical flat task fields, toggle and run; all mutations require the same session approval and capability checks as ScheduledTask.",
		parameters: z.object({
			...scheduledTaskFieldsSchema.shape,
			...scheduledTaskParametersSchema.shape,
			action: z.enum([...SCHEDULED_TASK_ACTIONS, "toggle", "run"]),
		}),
		execute: (args, ctx) => executeScheduledTask(args, ctx, "ScheduledTaskAdmin"),
	};
}

export const scheduledTaskAdminTool = createScheduledTaskAdminTool();
