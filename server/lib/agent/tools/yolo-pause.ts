import { z } from "zod/v4";
import type { ToolDefinition } from "../types";

export const YOLO_CONFIRM_TOOL_NAME = "YoloConfirm";
export const YOLO_CANCEL_TOOL_NAME = "YoloCancel";
export const YOLO_REFLECTION_TOOLS = new Set([YOLO_CONFIRM_TOOL_NAME, YOLO_CANCEL_TOOL_NAME]);

export const yoloConfirmTool: ToolDefinition = {
	name: YOLO_CONFIRM_TOOL_NAME,
	description:
		"Confirm the currently paused YOLO safety operation after reflecting on the warning. " +
		"Use this only when the exact high-risk operation is still necessary and the risks are acceptable.",
	parameters: z.object({
		confirm: z.literal(true).describe("Must be true to confirm the paused YOLO operation."),
		reflection: z
			.string()
			.optional()
			.describe("Brief explanation of why the operation remains necessary despite the warning."),
	}),
	execute: async (args, ctx) => {
		const requestId = ctx.yoloPauseRequestId;
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
	description:
		"Cancel the currently paused YOLO safety operation. Use this when a safer alternative is preferable " +
		"or when the operation is not worth the risk.",
	parameters: z.object({
		confirm: z.literal(true).describe("Must be true to cancel the paused YOLO operation."),
		reason: z.string().optional().describe("Brief reason for cancelling the high-risk operation."),
	}),
	execute: async (args, ctx) => {
		const requestId = ctx.yoloPauseRequestId;
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
