import { createExecutionTargetContext } from "@server/services/execution-policy/target-context";
import {
	consumePermissionRuleRequest,
	failPermissionRuleRequest,
	requestPermissionRuleSchema,
} from "@server/services/permission-rule-request-service";
import type { ToolDefinition } from "../types";

/**
 * Flat object schema for the tool description sent to the model.
 *
 * `requestPermissionRuleSchema` is a discriminated union, and the Zod→JSON Schema converter
 * emits that as a top-level `anyOf`. Anthropic's Messages API rejects a top-level
 * `oneOf`/`allOf`/`anyOf` with `input_schema does not support oneOf, allOf, or anyOf at the
 * top level`, and it rejects the WHOLE request — one such tool takes every other tool down
 * with it and the agent loop cannot start at all. (The previous `type: "object"` spread on
 * top of the converted union did not help: it produced `{type, anyOf}`, which is exactly
 * the shape the API refuses.)
 *
 * The variants stay distinguishable — `ruleType` keeps its four-value enum — while the
 * per-variant requirement moves into the field descriptions. Validation is untouched: the
 * call still goes through `parameters` (the Zod union) on the way in.
 */
const REQUEST_PERMISSION_RULE_JSON_SCHEMA = {
	type: "object",
	properties: {
		ruleType: {
			type: "string",
			enum: ["directoryWhitelist", "directoryBlacklist", "commandWhitelist", "commandBlacklist"],
			description: "Directory or command rule; it decides which of the fields below are required.",
		},
		reason: {
			type: "string",
			description: "Why this rule is needed. Required, 1-2000 characters.",
		},
		scope: {
			type: "string",
			enum: ["narrator"],
			default: "narrator",
			description: "Always narrator: this tool cannot create instance-wide rules.",
		},
		device: {
			type: "string",
			description:
				"Target device id; omitted means the device this call runs on. Rule evaluation then follows that device's execution boundary.",
		},
		path: {
			type: "string",
			description: "Required for directoryWhitelist and directoryBlacklist.",
		},
		accessLevel: {
			type: "string",
			enum: ["readOnly", "readWrite", "full"],
			default: "readOnly",
			description: "directoryWhitelist only.",
		},
		denyLevel: {
			type: "string",
			enum: ["denyWrite", "denyAll"],
			default: "denyAll",
			description: "directoryBlacklist only.",
		},
		pattern: {
			type: "string",
			description: "Required for commandWhitelist and commandBlacklist.",
		},
		denyPrompt: {
			type: "string",
			description: "commandBlacklist only: the reason shown when a command is blocked.",
		},
	},
	required: ["ruleType", "reason"],
} satisfies Record<string, unknown>;

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
	rawJsonSchema: REQUEST_PERMISSION_RULE_JSON_SCHEMA,
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
