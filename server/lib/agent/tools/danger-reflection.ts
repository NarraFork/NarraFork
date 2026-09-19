import { z } from "zod/v4";
import type { ToolDefinition } from "../types";
import { describeReflectionOnlyTool } from "./reflection-description";

export const DANGER_CONFIRM_TOOL_NAME = "DangerConfirm";
export const DANGER_CANCEL_TOOL_NAME = "DangerCancel";
export const DANGER_REFLECTION_TOOLS = new Set([DANGER_CONFIRM_TOOL_NAME, DANGER_CANCEL_TOOL_NAME]);

function getActiveDangerReflectionRequestId(
	ctx: Parameters<ToolDefinition["execute"]>[1],
): string | null {
	if (ctx.reflectionLoop?.kind !== "dangerReflection") return null;
	return ctx.reflectionLoop.requestId ?? null;
}

export const dangerConfirmTool: ToolDefinition = {
	name: DANGER_CONFIRM_TOOL_NAME,
	reflectionOnly: true,
	description: describeReflectionOnlyTool(
		"Confirm the currently paused dangerous operation after reflecting on the warning. " +
			"This is only for an active danger reflection pause; it is not a general confirmation tool. " +
			"In an ordinary turn, do not call it — continue the task and let the permission system start " +
			"danger reflection if this operation requires review. Use it when conversation context shows the " +
			"operation is intentional and necessary enough that the concrete risk is acceptable, including " +
			"carefully justified dangerous operations and bounded read-only inspection wrapped in a " +
			"syntactically risky command.",
	),
	parameters: z.object({
		confirm: z
			.literal(true)
			.optional()
			.describe("Optional compatibility flag. When present it must be true."),
		reflection: z
			.string()
			.optional()
			.describe("Brief explanation of why the operation remains necessary despite the warning."),
	}),
	execute: async (args, ctx) => {
		const requestId = getActiveDangerReflectionRequestId(ctx);
		if (!requestId) {
			return {
				output: "No danger reflection pause is active for this reflection loop.",
				isError: true,
			};
		}
		const { confirmDangerReflection } = await import("@server/services/narrator-permission");
		const ok = await confirmDangerReflection(
			requestId,
			typeof args.reflection === "string" ? args.reflection : undefined,
		);
		return {
			output: ok
				? "Danger reflection pause confirmed. The original tool call will now continue."
				: "The danger reflection pause was already resolved by another decision path.",
			isError: !ok,
		};
	},
};

export const dangerCancelTool: ToolDefinition = {
	name: DANGER_CANCEL_TOOL_NAME,
	reflectionOnly: true,
	description: describeReflectionOnlyTool(
		"Cancel the currently paused dangerous operation. This is only for an active danger reflection " +
			"pause; it is not a general refusal or stop tool. In an ordinary turn, do not call it — continue " +
			"the task and let the permission system start danger reflection if this operation requires review. " +
			"Use it when conversation context does not clearly justify the operation, it may be accidental or " +
			"stale, the necessity is unclear, the risk-benefit tradeoff is not justified, or a materially safer " +
			"alternative preserves the task.",
	),
	parameters: z.object({
		confirm: z
			.literal(true)
			.optional()
			.describe("Optional compatibility flag. When present it must be true."),
		reason: z.string().optional().describe("Brief reason for cancelling the high-risk operation."),
	}),
	execute: async (args, ctx) => {
		const requestId = getActiveDangerReflectionRequestId(ctx);
		if (!requestId) {
			return {
				output: "No danger reflection pause is active for this reflection loop.",
				isError: true,
			};
		}
		const { cancelDangerReflection } = await import("@server/services/narrator-permission");
		const ok = await cancelDangerReflection(
			requestId,
			typeof args.reason === "string" ? args.reason : undefined,
		);
		return {
			output: ok
				? "Danger reflection pause cancelled. The original tool call will not execute."
				: "The danger reflection pause was already resolved by another decision path.",
			isError: !ok,
		};
	},
};
