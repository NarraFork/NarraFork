import { z } from "zod";

/** Manifest schema major version accepted by the phase-0 contract. */
export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const manifestSchemaVersion = MANIFEST_SCHEMA_VERSION;
/** Content-Length framed backend RPC protocol. */
export const NARRAFORK_RPC_PROTOCOL = "narrafork.rpc/1" as const;
/** Provider business protocol negotiated on top of the RPC transport. */
export const PROVIDER_PROTOCOL_VERSION = "1.0" as const;
/** MessageChannel UI bridge protocol. */
export const NARRAFORK_UI_PROTOCOL = "narrafork.ui/1" as const;

// Short aliases keep protocol constants convenient for transport adapters.
export const RPC_PROTOCOL = NARRAFORK_RPC_PROTOCOL;
export const UI_PROTOCOL = NARRAFORK_UI_PROTOCOL;
export const PROVIDER_PROTOCOL = PROVIDER_PROTOCOL_VERSION;
export const UI_RPC_PROTOCOL = NARRAFORK_UI_PROTOCOL;

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_STRING_LENGTH = 1_000_000;
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function isRestrictedJsonValue(
	value: unknown,
	seen: Set<object>,
	depth: number,
	nodes: { count: number },
): value is JsonValue {
	if (nodes.count++ > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return typeof value !== "string" || value.length <= MAX_JSON_STRING_LENGTH;
	}
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || seen.has(value)) return false;

	seen.add(value);
	if (Array.isArray(value)) {
		if (value.length > MAX_JSON_NODES) return false;
		return value.every((item) => isRestrictedJsonValue(item, seen, depth + 1, nodes));
	}

	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		return false;
	}
	const entries = Object.entries(value);
	if (entries.length > MAX_JSON_NODES) return false;
	return entries.every(
		([key, item]) =>
			!FORBIDDEN_JSON_KEYS.has(key) && isRestrictedJsonValue(item, seen, depth + 1, nodes),
	);
}

function isRestrictedJsonObject(value: unknown): value is Record<string, JsonValue> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		isRestrictedJsonValue(value, new Set(), 0, { count: 0 })
	);
}

/** JSON-only payload value; rejects undefined, non-finite numbers, class instances and cycles. */
export const jsonValueSchema = z.custom<JsonValue>(
	(value) => isRestrictedJsonValue(value, new Set(), 0, { count: 0 }),
	{ message: "Expected a restricted JSON value" },
);
export const jsonObjectSchema = z.custom<Record<string, JsonValue>>(isRestrictedJsonObject, {
	message: "Expected a restricted JSON object",
});

const nonEmptyIdSchema = z.string().trim().min(1).max(128);
const methodNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9._:-]+$/, "Invalid protocol method");
const jsonRpcIdSchema = z.union([nonEmptyIdSchema, z.number().finite()]);

export const JSON_RPC_ERROR_CODES = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	PROTOCOL_VERSION_UNSUPPORTED: -32001,
	PROVIDER_NOT_INITIALIZED: -32002,
	CONFIG_INVALID: -32003,
	MODEL_UNAVAILABLE: -32004,
	PLUGIN_BUSY: -32005,
	OPERATION_ID_CONFLICT: -32006,
	PAYLOAD_TOO_LARGE: -32007,
	PERMISSION_DENIED: -32008,
	PLUGIN_UNAVAILABLE: -32009,
} as const;

export const PLUGIN_ERROR_CODES = {
	METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
	INVALID_PARAMS: "INVALID_PARAMS",
	INVALID_FILTER: "INVALID_FILTER",
	PERMISSION_DENIED: "PERMISSION_DENIED",
	CONTEXT_UNAVAILABLE: "CONTEXT_UNAVAILABLE",
	NOT_FOUND: "NOT_FOUND",
	NOT_FOUND_OR_DENIED: "NOT_FOUND_OR_DENIED",
	CONFLICT: "CONFLICT",
	RATE_LIMITED: "RATE_LIMITED",
	PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
	TIMEOUT: "TIMEOUT",
	CANCELLED: "CANCELLED",
	PLUGIN_DISABLED: "PLUGIN_DISABLED",
	HOST_UNAVAILABLE: "HOST_UNAVAILABLE",
	INTERNAL_ERROR: "INTERNAL_ERROR",
	UNKNOWN_RESULT: "UNKNOWN_RESULT",
	PLUGIN_BUSY: "PLUGIN_BUSY",
	PROTOCOL_ERROR: "PROTOCOL_ERROR",
	INCOMPATIBLE: "INCOMPATIBLE",
	CONFIG_CONFLICT: "CONFIG_CONFLICT",
	STORAGE_CONFLICT: "STORAGE_CONFLICT",
} as const;

export const PUBLIC_ERROR_CODES = [
	"METHOD_NOT_FOUND",
	"INVALID_PARAMS",
	"INVALID_FILTER",
	"PERMISSION_DENIED",
	"CONTEXT_UNAVAILABLE",
	"NOT_FOUND",
	"NOT_FOUND_OR_DENIED",
	"CONFLICT",
	"RATE_LIMITED",
	"PAYLOAD_TOO_LARGE",
	"TIMEOUT",
	"CANCELLED",
	"PLUGIN_DISABLED",
	"HOST_UNAVAILABLE",
	"INTERNAL_ERROR",
	"UNKNOWN_RESULT",
	"PLUGIN_BUSY",
	"PROTOCOL_ERROR",
	"INCOMPATIBLE",
	"CONFIG_CONFLICT",
	"STORAGE_CONFLICT",
] as const;
export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];
export const publicErrorCodeSchema = z.enum(PUBLIC_ERROR_CODES);

export const jsonRpcErrorSchema = z
	.object({
		code: z.number().int(),
		message: z.string().trim().min(1).max(4_000),
		data: jsonValueSchema.optional(),
	})
	.strict();

export const jsonRpcRequestSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		id: jsonRpcIdSchema,
		method: methodNameSchema,
		params: jsonValueSchema.optional(),
	})
	.strict();

export const jsonRpcNotificationSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		method: methodNameSchema,
		params: jsonValueSchema.optional(),
	})
	.strict();

const jsonRpcResultResponseSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		id: jsonRpcIdSchema,
		result: jsonValueSchema,
	})
	.strict();
const jsonRpcErrorResponseSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		id: jsonRpcIdSchema,
		error: jsonRpcErrorSchema,
	})
	.strict();

export const jsonRpcResponseSchema = z.union([
	jsonRpcResultResponseSchema,
	jsonRpcErrorResponseSchema,
]);
/** v1 accepts one object only; an array therefore deliberately fails this schema. */
export const jsonRpcEnvelopeSchema = z.union([
	jsonRpcRequestSchema,
	jsonRpcResponseSchema,
	jsonRpcNotificationSchema,
]);
export const jsonRpcMessageSchema = jsonRpcEnvelopeSchema;
export const jsonRpcRequestEnvelopeSchema = jsonRpcRequestSchema;
export const jsonRpcResponseEnvelopeSchema = jsonRpcResponseSchema;
export const jsonRpcNotificationEnvelopeSchema = jsonRpcNotificationSchema;

export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;
export type JsonRpcEnvelope = z.infer<typeof jsonRpcEnvelopeSchema>;

const providerProtocolVersionSchema = z.literal(PROVIDER_PROTOCOL_VERSION);
const operationIdSchema = z.string().trim().min(1).max(128);
const positiveSequenceSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const outputIndexSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
const optionalTextSchema = z.string().max(4_000).optional();

export const providerUsageSchema = z
	.object({
		promptTokens: z.number().int().nonnegative().optional(),
		inputTokens: z.number().int().nonnegative().optional(),
		completionTokens: z.number().int().nonnegative().optional(),
		reasoningTokens: z.number().int().nonnegative().optional(),
		cachedInputTokens: z.number().int().nonnegative().optional(),
		cacheCreationInputTokens: z.number().int().nonnegative().optional(),
		cacheCreation5mTokens: z.number().int().nonnegative().optional(),
		cacheCreation1hTokens: z.number().int().nonnegative().optional(),
		contextWindow: z.number().int().nonnegative().optional(),
		contextUsagePercentage: z.number().min(0).max(100).optional(),
		metering: z
			.object({
				unit: z.string().trim().min(1).max(100),
				unitPlural: z.string().trim().min(1).max(100),
				usage: z.number().finite().nonnegative(),
			})
			.strict()
			.optional(),
	})
	.strict();

export const providerStreamEventSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("request_started"),
			credentialId: optionalTextSchema,
			upstreamRequestId: optionalTextSchema,
			reasoningSource: optionalTextSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("text.delta"),
			text: z.string().min(1).max(MAX_JSON_STRING_LENGTH),
			outputIndex: outputIndexSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("reasoning.delta"),
			blockId: nonEmptyIdSchema,
			text: z.string().min(1).max(MAX_JSON_STRING_LENGTH),
			outputIndex: outputIndexSchema,
			metadata: z
				.object({
					source: nonEmptyIdSchema,
					format: nonEmptyIdSchema,
					data: jsonValueSchema,
				})
				.strict()
				.optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("reasoning.metadata"),
			blockId: nonEmptyIdSchema,
			outputIndex: outputIndexSchema,
			metadata: z
				.object({
					source: nonEmptyIdSchema,
					format: nonEmptyIdSchema,
					data: jsonValueSchema,
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			type: z.literal("reasoning.redacted"),
			data: z.string().min(1).max(MAX_JSON_STRING_LENGTH),
			outputIndex: outputIndexSchema,
			source: optionalTextSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("tool_call.start"),
			toolUseId: nonEmptyIdSchema,
			name: nonEmptyIdSchema,
			outputIndex: outputIndexSchema,
			continuation: jsonValueSchema.optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("tool_call.delta"),
			toolUseId: nonEmptyIdSchema,
			argumentsDelta: z.string().min(1).max(MAX_JSON_STRING_LENGTH),
		})
		.strict(),
	z
		.object({
			type: z.literal("tool_call.end"),
			toolUseId: nonEmptyIdSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("tool_call.complete"),
			toolUseId: nonEmptyIdSchema,
			name: nonEmptyIdSchema,
			input: jsonObjectSchema,
			outputIndex: outputIndexSchema,
			continuation: jsonValueSchema.optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("usage"),
			usage: providerUsageSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("error"),
			error: z
				.object({
					classification: z.enum(["api", "transport", "invalid_state", "protocol", "cancelled"]),
					code: nonEmptyIdSchema,
					message: z.string().trim().min(1).max(4_000),
					reason: optionalTextSchema,
					statusCode: z.number().int().min(100).max(599).optional(),
					retryable: z.boolean().optional(),
					phase: z.enum(["prepare", "connect", "request", "stream", "parse", "cancel"]).optional(),
					requestId: optionalTextSchema,
					providerRequestId: optionalTextSchema,
					responseSnippet: z.string().max(16_384).optional(),
					responseHeaders: z.record(z.string().max(200), z.string().max(2_000)).optional(),
					details: jsonObjectSchema.optional(),
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			type: z.literal("done"),
			status: z.enum(["completed", "cancelled", "failed"]),
			stopReason: z.enum([
				"end_turn",
				"tool_use",
				"max_output_tokens",
				"content_filter",
				"cancelled",
				"error",
				"unknown",
			]),
			messageId: optionalTextSchema,
			conversationId: optionalTextSchema,
			responseId: optionalTextSchema,
			credentialId: optionalTextSchema,
			usage: providerUsageSchema.optional(),
		})
		.strict(),
]);

export const providerAcceptedSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		id: jsonRpcIdSchema,
		result: z
			.object({
				accepted: z.literal(true),
				operationId: operationIdSchema,
			})
			.strict(),
	})
	.strict();

export const providerEventSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		method: z.literal("provider.event"),
		params: z
			.object({
				protocolVersion: providerProtocolVersionSchema,
				operationId: operationIdSchema,
				seq: positiveSequenceSchema,
				event: providerStreamEventSchema,
			})
			.strict(),
	})
	.strict();

export const providerDoneSchema = providerEventSchema.refine(
	(message) => message.params.event.type === "done",
	{ message: "provider.event must contain a done event" },
);

export type ProviderAccepted = z.infer<typeof providerAcceptedSchema>;
export type ProviderEvent = z.infer<typeof providerEventSchema>;
export type ProviderDone = z.infer<typeof providerDoneSchema>;
export type ProviderStreamEvent = z.infer<typeof providerStreamEventSchema>;
export const providerAcceptedEnvelopeSchema = providerAcceptedSchema;
export const providerEventEnvelopeSchema = providerEventSchema;
export const providerDoneEnvelopeSchema = providerDoneSchema;

export const UI_RPC_ERROR_CODES = [
	"METHOD_NOT_FOUND",
	"INVALID_PARAMS",
	"PERMISSION_DENIED",
	"CONTEXT_UNAVAILABLE",
	"NOT_FOUND",
	"CONFLICT",
	"RATE_LIMITED",
	"PAYLOAD_TOO_LARGE",
	"TIMEOUT",
	"CANCELLED",
	"PLUGIN_DISABLED",
	"HOST_UNAVAILABLE",
	"INTERNAL_ERROR",
] as const;
export type UiRpcErrorCode = (typeof UI_RPC_ERROR_CODES)[number];
export const uiRpcErrorSchema = z
	.object({
		code: z.enum(UI_RPC_ERROR_CODES),
		message: z.string().trim().min(1).max(4_000),
		retryable: z.boolean().optional(),
		details: jsonValueSchema.optional(),
	})
	.strict();

export const uiRpcRequestSchema = z
	.object({
		protocol: z.literal(NARRAFORK_UI_PROTOCOL),
		kind: z.literal("request"),
		id: nonEmptyIdSchema,
		method: methodNameSchema,
		params: jsonValueSchema.optional(),
	})
	.strict();
export const uiRpcNotificationSchema = z
	.object({
		protocol: z.literal(NARRAFORK_UI_PROTOCOL),
		kind: z.literal("notification"),
		method: methodNameSchema,
		params: jsonValueSchema.optional(),
	})
	.strict();
export const uiRpcResponseSchema = z.union([
	z
		.object({
			protocol: z.literal(NARRAFORK_UI_PROTOCOL),
			kind: z.literal("response"),
			id: nonEmptyIdSchema,
			result: jsonValueSchema,
		})
		.strict(),
	z
		.object({
			protocol: z.literal(NARRAFORK_UI_PROTOCOL),
			kind: z.literal("response"),
			id: nonEmptyIdSchema,
			error: uiRpcErrorSchema,
		})
		.strict(),
]);
export const uiRpcEnvelopeSchema = z.union([
	uiRpcRequestSchema,
	uiRpcResponseSchema,
	uiRpcNotificationSchema,
]);
export type UiRpcRequest = z.infer<typeof uiRpcRequestSchema>;
export type UiRpcResponse = z.infer<typeof uiRpcResponseSchema>;
export type UiRpcNotification = z.infer<typeof uiRpcNotificationSchema>;
export type UiRpcEnvelope = z.infer<typeof uiRpcEnvelopeSchema>;
export const uiRpcRequestEnvelopeSchema = uiRpcRequestSchema;
export const uiRpcResponseEnvelopeSchema = uiRpcResponseSchema;
export const uiRpcNotificationEnvelopeSchema = uiRpcNotificationSchema;

export const PUBLIC_EVENT_TOPICS = [
	"narrafork.project.changed",
	"narrafork.chapter.created",
	"narrafork.chapter.lifecycle",
	"narrafork.chapter.edge.changed",
	"narrafork.chapter.commits.changed",
	"narrafork.review.lifecycle",
	"narrafork.narrator.lifecycle",
	"narrafork.narrator.attention",
	"narrafork.narrator.message.changed",
	"narrafork.narrator.tool.changed",
	"narrafork.narrator.permission.changed",
	"narrafork.background-task.changed",
	"narrafork.terminal.changed",
	"narrafork.container.changed",
	"narrafork.device.changed",
	"narrafork.transfer.progress",
	"narrafork.provider.catalog.changed",
	"narrafork.provider.quota.changed",
	"narrafork.plugin.lifecycle",
	"narrafork.plugin.audit.summary",
	"narrafork.events.overflow",
	"narrafork.events.resync_required",
] as const;
export type PublicEventTopic = (typeof PUBLIC_EVENT_TOPICS)[number];
export const publicEventTopicSchema = z.enum(PUBLIC_EVENT_TOPICS);

const publicEventClassSchema = z.enum(["state", "lifecycle", "progress", "attention", "audit"]);
const publicResourceTypeSchema = z.enum([
	"project",
	"chapter",
	"narrator",
	"review",
	"terminal",
	"container",
	"background_task",
	"provider",
	"plugin",
]);
const publicEventResourceSchema = z
	.object({
		type: publicResourceTypeSchema,
		id: nonEmptyIdSchema,
		projectId: nonEmptyIdSchema.optional(),
		chapterId: nonEmptyIdSchema.optional(),
		narratorId: nonEmptyIdSchema.optional(),
		resourceVersion: z.number().int().nonnegative().optional(),
	})
	.strict();
const publicEventActorSchema = z
	.object({
		kind: z.enum(["user", "system", "plugin"]),
		id: nonEmptyIdSchema.optional(),
		role: z.enum(["admin", "user"]).optional(),
	})
	.strict();

export const publicEventSchema = z
	.object({
		schema: z.literal("narrafork.public-event"),
		schemaVersion: z.literal(1),
		eventId: nonEmptyIdSchema,
		topic: publicEventTopicSchema,
		eventClass: publicEventClassSchema,
		occurredAt: z.string().datetime({ offset: true }),
		deliverySeq: z.number().int().positive().optional(),
		resource: publicEventResourceSchema.optional(),
		actor: publicEventActorSchema.optional(),
		data: jsonObjectSchema,
		redaction: z.enum(["public", "user_scoped", "admin_scoped"]),
		resyncHint: z
			.object({
				queryId: nonEmptyIdSchema,
				resourceVersion: z.number().int().nonnegative().optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type PublicEvent = z.infer<typeof publicEventSchema>;
export const publicEventEnvelopeSchema = publicEventSchema;

export type PublicEventFilter = {
	all?: PublicEventFilter[];
	any?: PublicEventFilter[];
	topic?: PublicEventTopic[];
	eventClass?: Array<"state" | "lifecycle" | "progress" | "attention" | "audit">;
	projectIds?: string[];
	chapterIds?: string[];
	narratorIds?: string[];
	resourceTypes?: Array<
		| "project"
		| "chapter"
		| "narrator"
		| "review"
		| "terminal"
		| "container"
		| "background_task"
		| "provider"
		| "plugin"
	>;
	statuses?: string[];
	actorKinds?: Array<"user" | "system" | "plugin">;
};

const filterIdsSchema = z.array(nonEmptyIdSchema).max(20);
const publicEventFilterNodeSchema: z.ZodType<PublicEventFilter> = z.lazy(() =>
	z
		.object({
			all: z.array(publicEventFilterNodeSchema).min(1).max(20).optional(),
			any: z.array(publicEventFilterNodeSchema).min(1).max(20).optional(),
			topic: z.array(publicEventTopicSchema).min(1).max(20).optional(),
			eventClass: z.array(publicEventClassSchema).min(1).max(5).optional(),
			projectIds: filterIdsSchema.optional(),
			chapterIds: filterIdsSchema.optional(),
			narratorIds: filterIdsSchema.optional(),
			resourceTypes: z.array(publicResourceTypeSchema).min(1).max(20).optional(),
			statuses: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
			actorKinds: z
				.array(z.enum(["user", "system", "plugin"]))
				.min(1)
				.max(3)
				.optional(),
		})
		.strict(),
);

function filterDepth(filter: PublicEventFilter, depth = 1): number {
	const nested = [...(filter.all ?? []), ...(filter.any ?? [])];
	return nested.length === 0
		? depth
		: Math.max(...nested.map((child) => filterDepth(child, depth + 1)));
}

/** Structured predicates only; arbitrary data paths and unknown topics are rejected. */
export const publicEventFilterSchema = publicEventFilterNodeSchema.superRefine((value, context) => {
	if (filterDepth(value) > 3) {
		context.addIssue({
			code: "custom",
			message: "Public event filters may be nested at most three levels",
		});
	}
});
