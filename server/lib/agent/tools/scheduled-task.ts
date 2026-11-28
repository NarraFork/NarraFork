import { DEFAULT_LOCALE } from "@shared/i18n-locales";
import { describeScheduleEn } from "@shared/scheduled-task-schedule";
import { z } from "zod/v4";
import { resolveTimeZone } from "../../schedule-engine";
import {
	createScheduledTaskSchema,
	updateScheduledTaskSchema,
} from "../../validators/scheduled-tasks";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";
import { callProvenance } from "./call-provenance";
import {
	assertScheduledTaskApprovalFresh,
	previewScheduledTask,
	resolveScheduledTaskApproval,
} from "./scheduled-task-policy";
import {
	scheduledTaskParametersSchema,
	validateScheduledTaskArguments,
} from "./scheduled-task-schema";

function jsonOut(title: string, value: unknown): ToolResult {
	return { output: JSON.stringify(value, null, 2), title };
}

/** The framework asks before EVERY mutation, including bypassPermissions sessions.
 * Execution re-resolves identity, ACL and delegation boundaries; approval is not a capability grant.
 */
async function executeScheduledTask(
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<ToolResult> {
	try {
		validateScheduledTaskArguments(scheduledTaskParametersSchema.parse(args));
		const resolved = await resolveScheduledTaskApproval(ctx, args);
		const { action, id, task, q, limit, cursor, filters } = scheduledTaskParametersSchema.parse(
			resolved.input,
		);
		if (Object.keys(resolved.approval).length)
			assertScheduledTaskApprovalFresh(args, resolved.approval);
		const { principal } = resolved;
		const { scheduledTaskService: service } = await import(
			"../../../services/scheduled-task-service"
		);
		ctx.signal.throwIfAborted();
		const taskId = id ?? "";
		const expectedUpdatedAt =
			typeof resolved.approval.expectedUpdatedAt === "string"
				? resolved.approval.expectedUpdatedAt
				: undefined;
		const version = {
			expectedUpdatedAt,
			...(resolved.approval.expectedTarget
				? { expectedTarget: resolved.approval.expectedTarget }
				: {}),
		};
		const taskDetail = async (id: string) => {
			const detail = await service.detail(id, principal);
			return {
				...detail,
				scheduleDescription: describeScheduleEn(detail.schedule, resolveTimeZone(detail.timezone)),
			};
		};
		const recheckMutation = async () => {
			await ctx.recheckAuthorization?.();
			ctx.signal.throwIfAborted();
			const live = await resolveScheduledTaskApproval(ctx, resolved.input);
			assertScheduledTaskApprovalFresh(resolved.input, live.approval);
			ctx.signal.throwIfAborted();
			ctx.assertFinalExecutionPermission?.();
		};
		switch (action) {
			case "list": {
				const result = await service.list(principal, filters);
				return jsonOut(
					`Scheduled tasks: ${result.tasks.length}${result.truncated ? "+ (truncated)" : ""}`,
					result,
				);
			}
			case "targets": {
				const { listScheduledTaskTargets } = await import(
					"../../../services/scheduled-task-targets"
				);
				const result = await listScheduledTaskTargets(principal, { q, limit, cursor });
				return jsonOut(`Writable target sessions: ${result.items.length}`, result);
			}
			case "get":
				return jsonOut("Scheduled task", await taskDetail(taskId));
			case "preview":
				return jsonOut("Schedule preview", previewScheduledTask(task ?? {}));
			case "runs":
				return jsonOut(
					"Scheduled task runs",
					await service.listRuns(taskId, { limit: limit ?? 10, cursor: cursor ?? null, principal }),
				);
			case "create":
			case "update": {
				const provenance = {
					kind: "narrator" as const,
					narratorId: ctx.narratorId,
					...(await callProvenance(ctx)),
				};
				const [{ db }, { narrators }, { eq }] = await Promise.all([
					import("@server/db"),
					import("@server/db/schema"),
					import("drizzle-orm"),
				]);
				const narrator = await db.query.narrators.findFirst({
					where: eq(narrators.id, ctx.narratorId),
					columns: { title: true },
				});
				await recheckMutation();
				const saved =
					action === "create"
						? await service.create(
								createScheduledTaskSchema.parse({
									...task,
									locale: task?.locale ?? ctx.locale ?? DEFAULT_LOCALE,
								}),
								principal,
								{ ...provenance, narratorTitle: narrator?.title ?? null },
								version,
							)
						: await service.update(
								taskId,
								updateScheduledTaskSchema.parse(task),
								principal,
								{ ...provenance, narratorTitle: narrator?.title ?? null },
								version,
							);
				return jsonOut(
					`${action === "create" ? "Created" : "Updated"}: ${saved.name}`,
					await taskDetail(saved.id),
				);
			}
			case "enable":
			case "disable": {
				await recheckMutation();
				await service.setEnabled(taskId, action === "enable", principal, version);
				return jsonOut(
					action === "enable" ? "Scheduled task enabled" : "Scheduled task disabled",
					await taskDetail(taskId),
				);
			}
			case "delete":
				await recheckMutation();
				await service.delete(taskId, principal, version);
				return { output: `Deleted scheduled task ${taskId}.`, title: "Scheduled task deleted" };
			case "run_now":
				await recheckMutation();
				await service.runTask(taskId, { manual: true, principal, ...version });
				return jsonOut("Manual dispatch requested (not task completion)", await taskDetail(taskId));
		}
	} catch (error) {
		return {
			isError: true,
			output:
				error instanceof z.ZodError
					? `Invalid ScheduledTask arguments: ${error.message}`
					: `ScheduledTask failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export const scheduledTaskTool: ToolDefinition = {
	name: "ScheduledTask",
	description:
		"Manage scheduled tasks visible to the current user: list, targets, get, preview, create, update, enable, disable, delete, run_now, runs. targets discovers writable sessions (q, limit <= 100, cursor); runs limit <= 50. Use structured schedules (at/repeat/cron), an explicit timezone and end condition; cronExpr is a shorthand. New/reuse tasks inherit this session's scope. Existing mode requires targetNarratorId (your own ID or another writable session), keeps the target's directory, project, system prompt and permissions, and defaults modelPolicy to follow. contextPolicy defaults keep (clear removes prior conversation from the scheduled turn); onBusy defaults skip (wait is bounded by busyWaitMinutes, interrupt requires normal controller authority). requireReport defaults true. Every mutation requires human approval even in bypass mode; hard restrictions cannot be delegated. Active scheduled runs can only read/disable their own task and use ScheduledTaskReport. A dispatch is not proof of completion.",
	parameters: scheduledTaskParametersSchema,
	execute: (args, ctx) => executeScheduledTask(args, ctx),
};
