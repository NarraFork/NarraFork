import { z } from "zod";
import { oauthExternalPermissionModeSchema } from "../oauth-client-policy";

export const EXTERNAL_V1_DEFAULT_LIMIT = 50;
export const EXTERNAL_V1_MAX_LIMIT = 100;
export const EXTERNAL_V1_MAX_CURSOR_BYTES = 4_096;
export const EXTERNAL_V1_MAX_MESSAGE_CHARS = 10_000;
export const EXTERNAL_V1_MAX_MESSAGE_BYTES = 128 * 1_024;
export const EXTERNAL_WS_TICKET_LENGTH = 43;

/** 32 random bytes encoded as unpadded base64url. */
export const externalWsTicketSchema = z
	.string()
	.length(EXTERNAL_WS_TICKET_LENGTH)
	.regex(/^[A-Za-z0-9_-]+$/, "Invalid WebSocket ticket");

export const externalWsTicketResponseSchema = z
	.object({
		ticket: externalWsTicketSchema,
		expiresIn: z.number().int().min(30).max(60),
	})
	.strict();

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
	return textEncoder.encode(value).byteLength;
}

const externalResourceIdSchema = z.string().trim().min(1).max(128);

/** URL-path-safe idempotency key supplied by an external OAuth client. */
export const externalProvisionKeySchema = z
	.string()
	.min(1)
	.max(80)
	.regex(
		/^[A-Za-z0-9._~-]+$/,
		"provisionKey may only contain letters, digits, '.', '_', '~' and '-'",
	);

/**
 * Project scope is the default and therefore always requires projectId. Global
 * provisioning must be an explicit caller decision (`scope: "global"`), while
 * projectId remains the OAuth grant anchor used by the service authorization layer.
 */
export const externalDeviceProvisionBodySchema = z
	.object({
		projectId: externalResourceIdSchema,
		scope: z.enum(["project", "global"]).optional(),
		name: z.string().trim().min(1).max(120).optional(),
		description: z.string().trim().max(2_000).optional(),
	})
	.strict();

export const externalNarratorProvisionBodySchema = z
	.object({
		projectId: externalResourceIdSchema,
		deviceId: externalResourceIdSchema,
		title: z.string().trim().min(1).max(200).optional(),
		systemPrompt: z.string().max(10_000).optional(),
		permissionMode: oauthExternalPermissionModeSchema.optional(),
	})
	.strict();

export const externalSendMessageBodySchema = z
	.object({
		message: z
			.string()
			.min(1)
			.max(EXTERNAL_V1_MAX_MESSAGE_CHARS)
			.refine((value) => utf8ByteLength(value) <= EXTERNAL_V1_MAX_MESSAGE_BYTES, {
				message: `message must not exceed ${EXTERNAL_V1_MAX_MESSAGE_BYTES} UTF-8 bytes`,
			}),
	})
	.strict();

function createLimitSchema(max: number) {
	return z
		.string()
		.regex(/^\d+$/, `limit must be an integer from 1 to ${max}`)
		.transform(Number)
		.refine((value) => Number.isSafeInteger(value) && value >= 1 && value <= max, {
			message: `limit must be an integer from 1 to ${max}`,
		});
}

const externalCursorSchema = z
	.string()
	.min(1)
	.max(EXTERNAL_V1_MAX_CURSOR_BYTES)
	.refine((value) => utf8ByteLength(value) <= EXTERNAL_V1_MAX_CURSOR_BYTES, {
		message: `cursor must not exceed ${EXTERNAL_V1_MAX_CURSOR_BYTES} UTF-8 bytes`,
	})
	.optional();

export const externalListQuerySchema = z
	.object({
		cursor: externalCursorSchema,
		limit: createLimitSchema(EXTERNAL_V1_MAX_LIMIT)
			.optional()
			.transform((value) => value ?? EXTERNAL_V1_DEFAULT_LIMIT),
	})
	.strict();

export const externalMessageListQuerySchema = z
	.object({
		cursor: externalCursorSchema,
		limit: createLimitSchema(50)
			.optional()
			.transform((value) => value ?? EXTERNAL_V1_DEFAULT_LIMIT),
	})
	.strict();

export type ExternalDeviceProvisionInput = z.infer<typeof externalDeviceProvisionBodySchema>;
export type ExternalNarratorProvisionInput = z.infer<typeof externalNarratorProvisionBodySchema>;
export type ExternalSendMessageInput = z.infer<typeof externalSendMessageBodySchema>;
export type ExternalListQuery = z.infer<typeof externalListQuerySchema>;
