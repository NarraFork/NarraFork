import { z } from "zod/v4";
import type { ToolDefinition } from "../types";

export const YOLO_CONFIRM_TOOL_NAME = "YoloConfirm";
export const YOLO_CANCEL_TOOL_NAME = "YoloCancel";
export const YOLO_REFLECTION_TOOLS = new Set([YOLO_CONFIRM_TOOL_NAME, YOLO_CANCEL_TOOL_NAME]);

function getActiveYoloPauseRequestId(ctx: Parameters<ToolDefinition["execute"]>[1]): string | null {
	if (ctx.reflectionLoop?.kind !== "yoloPause") return null;
	return ctx.reflectionLoop.requestId ?? null;
}

export const yoloConfirmTool: ToolDefinition = {
	name: YOLO_CONFIRM_TOOL_NAME,
	reflectionOnly: true,
	description:
		"Confirm the currently paused YOLO safety operation after reflecting on the warning. " +
		"Use this when conversation context shows the operation is intentional and necessary enough that " +
		"the concrete risk is acceptable, including carefully justified dangerous operations and bounded " +
		"read-only inspection wrapped in a syntactically risky command.",
	parameters: z.object({
		confirm: z.literal(true).describe("Must be true to confirm the paused YOLO operation."),
		reflection: z
			.string()
			.optional()
			.describe("Brief explanation of why the operation remains necessary despite the warning."),
	}),
	execute: async (args, ctx) => {
		const requestId = getActiveYoloPauseRequestId(ctx);
		if (!requestId) {
			return {
				output: "No YOLO safety pause is active for this reflection loop.",
				isError: true,
			};
		}
		const { confirmYoloPause } = await import("@server/services/narrator-permission");
		const ok = await confirmYoloPause(
			requestId,
			typeof args.reflection === "string" ? args.reflection : undefined,
		);
		return {
			output: ok
				? "YOLO safety pause confirmed. The original tool call will now continue."
				: "The YOLO safety pause was already resolved by another decision path.",
			isError: !ok,
		};
	},
};

export const yoloCancelTool: ToolDefinition = {
	name: YOLO_CANCEL_TOOL_NAME,
	reflectionOnly: true,
	description:
		"Cancel the currently paused YOLO safety operation. Use this when conversation context does not " +
		"clearly justify the operation, it may be accidental or stale, the necessity is unclear, the " +
		"risk-benefit tradeoff is not justified, or a materially safer alternative preserves the task.",
	parameters: z.object({
		confirm: z.literal(true).describe("Must be true to cancel the paused YOLO operation."),
		reason: z.string().optional().describe("Brief reason for cancelling the high-risk operation."),
	}),
	execute: async (args, ctx) => {
		const requestId = getActiveYoloPauseRequestId(ctx);
		if (!requestId) {
			return {
				output: "No YOLO safety pause is active for this reflection loop.",
				isError: true,
			};
		}
		const { cancelYoloPause } = await import("@server/services/narrator-permission");
		const ok = await cancelYoloPause(
			requestId,
			typeof args.reason === "string" ? args.reason : undefined,
		);
		return {
			output: ok
				? "YOLO safety pause cancelled. The original tool call will not execute."
				: "The YOLO safety pause was already resolved by another decision path.",
			isError: !ok,
		};
	},
};
