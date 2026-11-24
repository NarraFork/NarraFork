import { backgroundTaskService } from "@server/services/background-task-service";
import { assertOAuthNarratorRuntimeActive } from "@server/services/oauth-narrator-runtime-policy";
import { authorizeStopTask, resolveOwnedStopTask } from "@server/services/stop-task-policy";
import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

const parameters = z.object({
	type: z.enum(["bash", "agent"]).describe("The kind of background task to cancel."),
	id: z.string().trim().min(1).describe("The background task ID or alias owned by this narrator."),
});

export const stopTool: ToolDefinition = {
	name: "Stop",
	description:
		"Cancel a running background Bash task or agent owned by this narrator. " +
		'Provide both type ("bash" or "agent") and id (task ID or alias). ' +
		"This only cancels tracked background work; it cannot stop the NarraFork server or arbitrary PIDs. " +
		"Use Bash to launch commands, Agent to launch/archive/unarchive agents, and Watch to register non-blocking observations.",
	parameters,
	rawJsonSchema: {
		type: "object",
		properties: {
			type: {
				type: "string",
				enum: ["bash", "agent"],
				description: "The kind of background task to cancel.",
			},
			id: {
				type: "string",
				minLength: 1,
				description: "The background task ID or alias owned by this narrator. Must not be blank.",
			},
		},
		required: ["type", "id"],
		additionalProperties: false,
	},
	async execute(args, ctx): Promise<ToolResult> {
		// The executor validates input but passes the original, untransformed object.
		const parsed = parameters.safeParse(args);
		if (!parsed.success) {
			return { output: `Invalid Stop parameters: ${parsed.error.message}`, isError: true };
		}
		const { type, id } = parsed.data;
		try {
			const task = await resolveOwnedStopTask(ctx.narratorId, parsed.data);
			// Imports/child validation can yield after final admission. Re-read the live
			// OAuth ceiling immediately before cancellation, not from model input or cwd.
			const authorizeCancellation = async () => {
				await ctx.recheckAuthorization?.();
				const runtime = await assertOAuthNarratorRuntimeActive(ctx.narratorId, ctx.userId);
				if (runtime) {
					if (!runtime.allowedTools.has("Stop"))
						throw new Error("OAuth tool capability was revoked");
					const authorization = await authorizeStopTask(
						ctx.narratorId,
						{ type, id: task.id },
						{
							permissionMode: runtime.permissionMode,
							allowKnowledgeWrite: runtime.allowKnowledgeWrite,
							deviceAccess: runtime.policy.deviceAccess,
							oauthClientId: runtime.clientId,
							grantId: runtime.grantId,
						},
					);
					return () => {
						ctx.signal.throwIfAborted();
						authorization.assertStillCurrent();
					};
				}
				ctx.signal.throwIfAborted();
				return () => ctx.signal.throwIfAborted();
			};

			let cancelled: boolean;
			if (type === "agent") {
				// Never pass an arbitrary task/narrator ID to the cancellation registry: the
				// target must register this narrator as its controller for "stop".
				const { authorizeAgentControl } = await import("@server/services/narrator-control");
				const narratorId = task.subagentNarratorId;
				if (!narratorId)
					return {
						output: `Background agent task ${id} is not a direct child subagent of this narrator.`,
						isError: true,
					};
				// Hard OAuth ceiling first, then the control grant; the fence is re-asserted below.
				const assertAuthorized = await authorizeCancellation();
				const narrator = await authorizeAgentControl({
					callerNarratorId: ctx.narratorId,
					targetNarratorId: narratorId,
					action: "stop",
					userId: ctx.userId,
				}).catch((error: unknown) => error as Error);
				if (narrator instanceof Error) {
					return { output: `Stop error: ${narrator.message}`, isError: true };
				}
				// The task row is the run's cancellation handle; a run with no live task
				// handle is cancelled through the run service directly.
				const { controlRun, stopSubagentHelpers } = await import(
					"@server/services/agent-runtime/run"
				);
				// Re-asserted after the last await and before the first side effect.
				assertAuthorized();
				cancelled =
					(await backgroundTaskService.cancel(task.id, { assertAuthorized }).catch(() => false)) ||
					(await controlRun(narrator.id, { kind: "cancel", reason: "Cancelled by controller" }));
				// A worker may sit idle between turns while its helpers still run in the
				// background: stopping it stops them too (control on it is authorized above).
				// No-op for an agent without helpers; a cancelled run would cascade anyway. The
				// fence is re-asserted before each helper is cancelled, never after.
				const helpers = await stopSubagentHelpers(narrator.id, "Parent subagent stopped", {
					assertAuthorized,
				});
				if (!cancelled && helpers > 0)
					return {
						output: `Background agent task ${id} is not running; its ${helpers} running helper agent(s) were stopped.`,
					};
			} else {
				const assertAuthorized = await authorizeCancellation();
				assertAuthorized();
				cancelled = await backgroundTaskService.cancel(task.id, { assertAuthorized });
			}
			return cancelled
				? { output: `Background ${type} task ${id} has been cancelled.` }
				: {
						output: `Background ${type} task ${id} is not running (may have already completed, failed, or been cancelled).`,
						isError: true,
					};
		} catch (error) {
			return {
				output: `Stop error: ${error instanceof Error ? error.message : String(error)}`,
				isError: true,
			};
		}
	},
};
