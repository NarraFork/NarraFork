import { SUPPORTED_LOCALES } from "@shared/i18n-locales";
import { z } from "zod";
import { EXTERNAL_V1_MAX_MESSAGE_BYTES, EXTERNAL_V1_MAX_MESSAGE_CHARS } from "./external";

export const EXTERNAL_NARRATOR_WS_MAX_FRAME_BYTES = 160 * 1024;
export const EXTERNAL_NARRATOR_WS_MAX_CONNECTIONS = 100;
export const EXTERNAL_NARRATOR_WS_MAX_SUBSCRIPTIONS = 100;
export const EXTERNAL_NARRATOR_WS_MAX_BUFFERED_BYTES = 1024 * 1024;

const textEncoder = new TextEncoder();
const requestIdSchema = z.string().trim().min(1).max(128).optional();
const narratorIdSchema = z.string().trim().min(1).max(128);
const narratorIdsSchema = z
	.array(narratorIdSchema)
	.min(1)
	.max(EXTERNAL_NARRATOR_WS_MAX_SUBSCRIPTIONS)
	.refine((ids) => new Set(ids).size === ids.length, "narratorIds must be unique");

const pongSchema = z.object({ type: z.literal("pong") }).strict();
const subscribeSchema = z
	.object({
		type: z.literal("subscribe"),
		narratorIds: narratorIdsSchema,
		requestId: requestIdSchema,
	})
	.strict();
const unsubscribeSchema = z
	.object({
		type: z.literal("unsubscribe"),
		narratorIds: narratorIdsSchema,
		requestId: requestIdSchema,
	})
	.strict();
const syncCheckSchema = z
	.object({
		type: z.literal("sync_check"),
		narratorId: narratorIdSchema,
		requestId: requestIdSchema,
	})
	.strict();
const sendMessageSchema = z
	.object({
		type: z.literal("send_message"),
		narratorId: narratorIdSchema,
		message: z
			.string()
			.min(1)
			.max(EXTERNAL_V1_MAX_MESSAGE_CHARS)
			.refine((value) => textEncoder.encode(value).byteLength <= EXTERNAL_V1_MAX_MESSAGE_BYTES, {
				message: `message must not exceed ${EXTERNAL_V1_MAX_MESSAGE_BYTES} UTF-8 bytes`,
			}),
		/** Conversation locale for this turn; mirrors the REST body field. */
		locale: z.enum(SUPPORTED_LOCALES).optional(),
		requestId: requestIdSchema,
	})
	.strict();
const interruptSchema = z
	.object({
		type: z.literal("interrupt"),
		narratorId: narratorIdSchema,
		requestId: requestIdSchema,
	})
	.strict();

export const externalNarratorWsMessageSchema = z.discriminatedUnion("type", [
	pongSchema,
	subscribeSchema,
	unsubscribeSchema,
	syncCheckSchema,
	sendMessageSchema,
	interruptSchema,
]);
