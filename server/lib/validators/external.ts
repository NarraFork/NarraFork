import {
	EXTERNAL_MESSAGE_DETAIL_LEVELS,
	EXTERNAL_MESSAGE_LIMIT_BY_DETAIL,
	type ExternalMessageDetail,
} from "@shared/external/message-detail";
import { SUPPORTED_LOCALES } from "@shared/i18n-locales";
import { z } from "zod";
import {
	OAUTH_MAX_DANGER_REFLECTION_PROMPT_CHARS,
	OAUTH_NARRATOR_MAX_DEVICES,
	oauthExternalPermissionModeSchema,
} from "../oauth-client-policy";

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
 * projectId is optional: OAuth grants are no longer bound to projects, so the
 * grant ownership (integration_resource_bindings) is the sole isolation
 * boundary. When omitted the device is provisioned project-less. `scope:
 * "global"` remains an explicit caller decision for global visibility.
 */
export const externalDeviceProvisionBodySchema = z
	.object({
		projectId: externalResourceIdSchema.optional(),
		scope: z.enum(["project", "global"]).optional(),
		name: z.string().trim().min(1).max(120).optional(),
		description: z.string().trim().max(2_000).optional(),
	})
	.strict();

export const externalNarratorProvisionBodySchema = z
	.object({
		projectId: externalResourceIdSchema.optional(),
		/** Initial default execution device; must also be present in deviceIds. */
		deviceId: externalResourceIdSchema,
		deviceIds: z
			.array(externalResourceIdSchema)
			.min(1)
			.max(OAUTH_NARRATOR_MAX_DEVICES)
			.transform((deviceIds) => [...new Set(deviceIds)]),
		title: z.string().trim().min(1).max(200).optional(),
		systemPrompt: z.string().max(10_000).optional(),
		permissionMode: oauthExternalPermissionModeSchema.optional(),
		/**
		 * Business context appended to the danger reflection prompt. Only accepted when the
		 * client policy opts in (allowDangerReflectionPrompt); the effective ceiling is
		 * maxDangerReflectionPromptChars, this bound is just the hard protocol limit.
		 */
		dangerReflectionPrompt: z.string().max(OAUTH_MAX_DANGER_REFLECTION_PROMPT_CHARS).optional(),
	})
	.strict()
	.superRefine((input, ctx) => {
		if (!input.deviceIds.includes(input.deviceId)) {
			ctx.addIssue({
				code: "custom",
				path: ["deviceIds"],
				message: "deviceIds must include deviceId",
			});
		}
	});

export const externalSendMessageBodySchema = z
	.object({
		message: z
			.string()
			.min(1)
			.max(EXTERNAL_V1_MAX_MESSAGE_CHARS)
			.refine((value) => utf8ByteLength(value) <= EXTERNAL_V1_MAX_MESSAGE_BYTES, {
				message: `message must not exceed ${EXTERNAL_V1_MAX_MESSAGE_BYTES} UTF-8 bytes`,
			}),
		/**
		 * Conversation locale for this turn. Optional; falls back to `Accept-Language` and then to
		 * the server default. The schema is `.strict()`, so the field has to be declared here for
		 * clients to be able to send it at all.
		 */
		locale: z.enum(SUPPORTED_LOCALES).optional(),
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

/** Largest page size any tier permits; the per-tier ceiling is checked below. */
const EXTERNAL_MESSAGE_MAX_LIMIT_ANY_DETAIL = Math.max(
	...Object.values(EXTERNAL_MESSAGE_LIMIT_BY_DETAIL),
);

/**
 * Page size ceiling for a tier. A `full` page embeds projected tool payloads, so
 * its ceiling is far below the scalar tiers' — see EXTERNAL_MESSAGE_LIMIT_BY_DETAIL.
 */
export function externalMessageLimitCeiling(detail: ExternalMessageDetail): number {
	return EXTERNAL_MESSAGE_LIMIT_BY_DETAIL[detail];
}

/**
 * Message page query.
 *
 * `detail` defaults to `text`, the pre-existing bounded plain-text projection, so
 * a client written against the original endpoint keeps its exact behaviour and
 * needs none of the new scopes.
 *
 * There is ONE cursor, and `order` decides which way it walks: `asc` continues
 * into newer messages (the original behaviour), `desc` continues into older ones
 * — which is what a client rendering a tail-first view needs. A separate
 * `before` parameter was considered and rejected: it would admit four
 * cursor/order combinations, two of which have no coherent meaning.
 */
export const externalMessageListQuerySchema = z
	.object({
		cursor: externalCursorSchema,
		detail: z
			.enum(EXTERNAL_MESSAGE_DETAIL_LEVELS)
			.optional()
			.transform((value): ExternalMessageDetail => value ?? "text"),
		order: z
			.enum(["asc", "desc"])
			.optional()
			.transform((value) => value ?? "asc"),
		limit: createLimitSchema(EXTERNAL_MESSAGE_MAX_LIMIT_ANY_DETAIL).optional(),
	})
	.strict()
	.superRefine((query, ctx) => {
		const ceiling = externalMessageLimitCeiling(query.detail);
		if (query.limit != null && query.limit > ceiling) {
			ctx.addIssue({
				code: "custom",
				path: ["limit"],
				message: `limit must be an integer from 1 to ${ceiling} at detail=${query.detail}`,
			});
		}
	})
	.transform((query) => ({
		...query,
		limit: Math.min(
			query.limit ?? EXTERNAL_V1_DEFAULT_LIMIT,
			externalMessageLimitCeiling(query.detail),
		),
	}));

export type ExternalDeviceProvisionInput = z.infer<typeof externalDeviceProvisionBodySchema>;
export type ExternalNarratorProvisionInput = z.infer<typeof externalNarratorProvisionBodySchema>;
export type ExternalSendMessageInput = z.infer<typeof externalSendMessageBodySchema>;
export type ExternalListQuery = z.infer<typeof externalListQuerySchema>;
export type ExternalMessageListQuery = z.infer<typeof externalMessageListQuerySchema>;
