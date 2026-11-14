import { z } from "zod/v4";
import type { ToolDefinition } from "../types";

const parameters = z
	.object({
		outcome: z.enum(["done", "partial", "blocked", "no_change"]),
		summary: z
			.string()
			.trim()
			.min(1)
			.max(2000)
			.describe(
				"Concise evidence of completion, remaining work or the blocking condition. This is a self-report, not the system execution status.",
			),
	})
	.strict();

export const scheduledTaskReportTool: ToolDefinition = {
	name: "ScheduledTaskReport",
	description:
		"Report the outcome of YOUR CURRENT scheduled run: done, partial, blocked or no_change, with a brief evidence-based summary. The server binds the report to the active run; never supply a taskId or runId. Reporting does not itself end the run, change its schedule, or assert system success. Not available outside a current scheduled execution.",
	parameters,
	async execute(args, ctx) {
		try {
			const input = parameters.parse(args);
			const { resolveTaskPrincipal } = await import("../../../services/scheduled-task-acl");
			await resolveTaskPrincipal(ctx.userId);
			const { reportScheduledRun } = await import("../../../services/scheduled-task-run-service");
			ctx.signal.throwIfAborted();
			const result = await reportScheduledRun(ctx.narratorId, input);
			return { output: JSON.stringify(result), title: `Scheduled run reported: ${input.outcome}` };
		} catch (error) {
			return {
				isError: true,
				output: `ScheduledTaskReport failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	},
};
