import {
	listNotificationChannels,
	NotificationSendForbiddenError,
	sendUserNotification,
} from "@server/services/notification-service";
import { z } from "zod/v4";
import type { ToolDefinition } from "../types";

const targetFields = {
	user_id: z
		.string()
		.min(1)
		.max(128)
		.refine((value) => value.trim().length > 0)
		.optional(),
	username: z
		.string()
		.min(1)
		.max(128)
		.refine((value) => value.trim().length > 0)
		.optional(),
};
const targetIsExclusive = (value: { user_id?: string; username?: string }) =>
	(value.user_id !== undefined) !== (value.username !== undefined);

export const notificationParameters = z
	.discriminatedUnion("action", [
		z.object({ action: z.literal("list_channels"), ...targetFields }).strict(),
		z
			.object({
				action: z.literal("send"),
				...targetFields,
				title: z
					.string()
					.min(1)
					.max(120)
					.refine((value) => value.trim().length > 0),
				message: z
					.string()
					.min(1)
					.max(4000)
					.refine((value) => value.trim().length > 0),
				channels: z
					.array(z.enum(["dingtalk", "feishu"]))
					.min(1)
					.max(2)
					.optional(),
			})
			.strict(),
	])
	.refine(targetIsExclusive, { message: "Specify exactly one of user_id or username" });

export const notificationTool: ToolDefinition = {
	name: "Notification",
	description:
		"Query configured DingTalk/Feishu channels for one exact user (list_channels), or proactively send a notification (send). Specify exactly one of user_id or username; users cannot be enumerated. No credentials are returned. Send requires title (max 120) and message (max 4000). Optional channels (max 2, deduplicated) select only those channels; unavailable selections are not sent or redirected. Omitted channels use all available channels. Explicit sends do not depend on automatic done/waiting switches. Inspect per-channel results: partial_failure is not complete success. No automatic retries.",
	parameters: notificationParameters,
	// Providers require an object root; the runtime discriminated union retains strict action validation.
	rawJsonSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: ["list_channels", "send"],
				description:
					"list_channels queries one exact user's channel states; send proactively delivers a notification. Specify exactly one of user_id or username for either action.",
			},
			user_id: {
				type: "string",
				minLength: 1,
				maxLength: 128,
				description:
					"Exact user ID. Required for either action unless username is provided; never provide both.",
			},
			username: {
				type: "string",
				minLength: 1,
				maxLength: 128,
				description:
					"Exact, case-sensitive username. Required for either action unless user_id is provided; never provide both. No prefix, wildcard or user enumeration.",
			},
			title: {
				type: "string",
				minLength: 1,
				maxLength: 120,
				description:
					"Required only for send. Nonblank title, at most 120 characters. Do not provide for list_channels.",
			},
			message: {
				type: "string",
				minLength: 1,
				maxLength: 4000,
				description:
					"Required only for send. Nonblank message, at most 4000 characters. Do not provide for list_channels.",
			},
			channels: {
				type: "array",
				minItems: 1,
				maxItems: 2,
				items: { type: "string", enum: ["dingtalk", "feishu"] },
				description:
					"Optional only for send. Select at most 2 channels (duplicates deduplicated). Omit to use all available channels. Explicit unavailable selections are not sent or redirected. Do not provide for list_channels.",
			},
		},
		required: ["action"],
		additionalProperties: false,
	},
	async execute(args, ctx) {
		const parsed = notificationParameters.safeParse(args);
		if (!parsed.success)
			return {
				output: "Invalid Notification input. Specify one exact user and valid action fields.",
				isError: true,
			};
		try {
			const input = parsed.data;
			if (input.action === "list_channels") {
				return { output: JSON.stringify(await listNotificationChannels(input)) };
			}
			const result = await sendUserNotification(input, {
				narratorId: ctx.narratorId,
				signal: ctx.signal,
			});
			return { output: JSON.stringify(result), isError: result.status !== "success" };
		} catch (error) {
			if (error instanceof NotificationSendForbiddenError) {
				return { output: error.message, isError: true };
			}
			// Database/network error strings can include queries, secrets or webhook URLs.
			return {
				output: "Notification operation failed or the exact user does not exist.",
				isError: true,
			};
		}
	},
};
