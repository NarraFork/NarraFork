import { createExecutionTargetContext } from "@server/services/execution-policy/target-context";
import {
	consumePermissionRuleRequest,
	failPermissionRuleRequest,
	requestPermissionRuleSchema,
} from "@server/services/permission-rule-request-service";
import { zodToJsonSchema } from "../tool-registry";
import type { ToolDefinition } from "../types";

export const requestPermissionRuleTool: ToolDefinition = {
	name: "RequestPermissionRule",
	executionRouting: {
		kind: "single",
		resolve(input) {
			return {
				key: "primary",
				operation: "write",
				...(typeof input.device === "string" ? { deviceId: input.device } : {}),
				...(typeof input.path === "string" ? { path: input.path } : {}),
			};
		},
	},
	description:
		"Request one new enabled narrator-only directory/command allow/deny rule with a required reason. " +
		"This cannot update/delete rules, select all devices, or change another narrator. Omitted device is frozen to this call's current device. " +
		"Rules never override inherited deny rules, protected paths, catastrophic commands, review or OAuth ceilings. " +
		"Human approval is required unless a human administrator has enabled permissionRuleAutoApprove in bypassPermissions, " +
		"which still requires strict dedicated reflection. This is an application guard, not an OS sandbox.",
	parameters: requestPermissionRuleSchema,
	// Compatible APIs require an explicit object root even for object-only unions.
	// Keep every union branch intact, including its strict field constraints.
	rawJsonSchema: { ...zodToJsonSchema(requestPermissionRuleSchema), type: "object" },
	async execute(args, ctx) {
		if (
			!ctx.toolCallBinding ||
			!ctx.currentToolUseId ||
			!ctx.executionTarget ||
			!ctx.resolveBackend ||
			!ctx.recheckAuthorization
		) {
			return {
				output: "Missing frozen execution binding for permission rule request",
				isError: true,
			};
		}
		try {
			ctx.signal.throwIfAborted();
			await ctx.recheckAuthorization();
			const context = await createExecutionTargetContext({
				backend: ctx.resolveBackend(ctx.executionTarget.deviceId),
				target: ctx.executionTarget,
			});
			const result = await consumePermissionRuleRequest(
				{
					narratorId: ctx.narratorId,
					toolUseId: ctx.currentToolUseId,
					binding: ctx.toolCallBinding,
				},
				args,
				context,
			);
			return { output: JSON.stringify(result), title: `Permission rule ${result.status}` };
		} catch (error) {
			try {
				failPermissionRuleRequest(
					`${ctx.toolCallBinding.toolCallId}:${ctx.toolCallBinding.attempt}`,
					error instanceof Error ? error.message : String(error),
					ctx.narratorId,
				);
			} catch {}
			return { output: error instanceof Error ? error.message : String(error), isError: true };
		}
	},
};
