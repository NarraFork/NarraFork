import { CITATION_LIMITS } from "@shared/citations";
import { z } from "zod";
import { capabilityListSchema, invocationScopeSchema } from "./permissions";

/** Manifest schema major version accepted by the phase-0 contract. */
export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const manifestSchemaVersion = MANIFEST_SCHEMA_VERSION;
/** Content-Length framed backend RPC protocol. */
export const NARRAFORK_RPC_PROTOCOL = "narrafork.rpc/1" as const;
/** Provider business protocol negotiated on top of the RPC transport. */
export const PROVIDER_PROTOCOL_VERSION = "1.0" as const;
/** Bounded host-to-provider request budget; inbound events keep their smaller limits. */
export const PROVIDER_REQUEST_MAX_BYTES = 32 * 1024 * 1024;
/** MessageChannel UI bridge protocol. */
export const NARRAFORK_UI_PROTOCOL = "narrafork.ui/1" as const;

// Short aliases keep protocol constants convenient for transport adapters.
export const RPC_PROTOCOL = NARRAFORK_RPC_PROTOCOL;
export const UI_PROTOCOL = NARRAFORK_UI_PROTOCOL;
export const PROVIDER_PROTOCOL = PROVIDER_PROTOCOL_VERSION;
export const UI_RPC_PROTOCOL = NARRAFORK_UI_PROTOCOL;

/** Features a backend plugin may explicitly negotiate before calling the Host. */
export const PLUGIN_TO_HOST_FEATURES = [
	"host_api.requests",
	"host_api.notifications",
	"rpc.cancel",
	"stream.credit",
	"events.poll",
] as const;
export type PluginToHostFeature = (typeof PLUGIN_TO_HOST_FEATURES)[number];
export const pluginToHostFeatureSchema = z.enum(PLUGIN_TO_HOST_FEATURES);
export const pluginToHostFeatureListSchema = z
	.array(pluginToHostFeatureSchema)
	.max(PLUGIN_TO_HOST_FEATURES.length)
	.refine((features) => new Set(features).size === features.length, {
		message: "Plugin-to-Host features must be unique",
	});

/** First Plugin -> Host request surface. Unknown methods are dispatcher errors, not extensions. */
export const PLUGIN_TO_HOST_REQUEST_METHODS = [
	"queries.execute",
	"commands.execute",
	"events.subscribe",
	"events.unsubscribe",
	"events.poll",
	"storage.get",
	"storage.set",
	"storage.delete",
	"storage.list",
	"config.get",
	// Secrets are read/write for the owning plugin, mirroring VS Code's `secrets` API
	// (get/store/delete/keys, no declaration required). The `key` is namespaced by the host
	// using the calling plugin's identity, so there is no parameter through which one plugin
	// could name another's secret. `secrets.list` reports which keys exist without values.
	"secrets.get",
	"secrets.set",
	"secrets.delete",
	"secrets.list",
	"diagnostics.getOwn",
] as const;
export type PluginToHostRequestMethod = (typeof PLUGIN_TO_HOST_REQUEST_METHODS)[number];
export const pluginToHostRequestMethodSchema = z.enum(PLUGIN_TO_HOST_REQUEST_METHODS);

export const RPC_CANCEL_REQUEST_METHOD = "$/cancelRequest" as const;
export const RPC_CREDIT_METHOD = "$/credit" as const;

// Transport enforces the actual UTF-8 frame budget. These traversal guards must
// accommodate long provider histories within the 32 MiB outbound frame limit:
// even the smallest JSON array entry takes two bytes (value + separator).
const MAX_JSON_DEPTH = 128;
const MAX_JSON_NODES = 16 * 1024 * 1024;
const MAX_JSON_STRING_LENGTH = 32 * 1024 * 1024;
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

	// Track ancestors, not every object ever visited: shared history/content
	// objects are serializable JSON; only references back into the path are cycles.
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > MAX_JSON_NODES - nodes.count) return false;
			for (let index = 0; index < value.length; index++) {
				if (!isRestrictedJsonValue(value[index], seen, depth + 1, nodes)) return false;
			}
			return true;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		// Avoid allocating an entries array and a [key, value] tuple per history field.
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			if (
				FORBIDDEN_JSON_KEYS.has(key) ||
				!isRestrictedJsonValue((value as Record<string, unknown>)[key], seen, depth + 1, nodes)
			) {
				return false;
			}
		}
		return true;
	} finally {
		seen.delete(value);
	}
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
	.regex(
		/^(?:\$\/[A-Za-z0-9][A-Za-z0-9._:-]*|[A-Za-z0-9][A-Za-z0-9._:-]*)$/,
		"Invalid protocol method",
	);
export const jsonRpcIdSchema = z.union([nonEmptyIdSchema, z.number().finite()]);

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
	STORAGE_QUOTA_EXCEEDED: "STORAGE_QUOTA_EXCEEDED",
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
	"STORAGE_QUOTA_EXCEEDED",
] as const;
export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];
export const publicErrorCodeSchema = z.enum(PUBLIC_ERROR_CODES);

/** Event v1 is live source + bounded poll delivery; snapshot_live remains fail-closed. */
export const EVENT_SUBSCRIPTION_MODES = ["live"] as const;
export const EVENT_DELIVERY_TRANSPORTS = ["poll"] as const;
export const UNIMPLEMENTED_EVENT_SUBSCRIPTION_MODES = ["snapshot_live"] as const;
export const SNAPSHOT_LIVE_UNAVAILABLE = {
	mode: "snapshot_live",
	code: PLUGIN_ERROR_CODES.INCOMPATIBLE,
	retryable: false,
	message: "snapshot_live is not implemented; use live mode with events.poll resynchronization",
} as const;
export const eventDeliveryTransportSchema = z.enum(EVENT_DELIVERY_TRANSPORTS);
export const eventSubscriptionModeSchema = z
	.enum([...EVENT_SUBSCRIPTION_MODES, ...UNIMPLEMENTED_EVENT_SUBSCRIPTION_MODES])
	.superRefine((mode, context) => {
		if (mode === "snapshot_live") {
			context.addIssue({ code: "custom", message: SNAPSHOT_LIVE_UNAVAILABLE.message });
		}
	})
	.transform((mode) => mode as (typeof EVENT_SUBSCRIPTION_MODES)[number]);

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

function normalizeLegacyHelloParams(value: unknown): unknown {
	if (!isRestrictedJsonObject(value)) return value;
	const normalized: Record<string, JsonValue> = { ...value };
	const aliases = [
		["pluginId", "id"],
		["version", "pluginVersion"],
		["rpcProtocol", "protocol"],
		["rpcProtocol", "protocolVersion"],
	] as const;
	for (const [canonical, legacy] of aliases) {
		if (normalized[legacy] === undefined) continue;
		if (normalized[canonical] !== undefined) return value;
		normalized[canonical] = normalized[legacy];
		delete normalized[legacy];
	}
	return normalized;
}

const pluginHelloCanonicalParamsSchema = z
	.object({
		pluginId: nonEmptyIdSchema,
		version: nonEmptyIdSchema,
		rpcProtocol: z.literal(NARRAFORK_RPC_PROTOCOL),
		packageDigest: z.string().trim().min(1).max(256).optional(),
		features: pluginToHostFeatureListSchema.optional().default([]),
		sdk: z.object({ name: nonEmptyIdSchema, version: nonEmptyIdSchema }).strict().optional(),
		platform: z
			.object({
				os: z.enum(["linux", "darwin", "win32"]),
				arch: z.enum(["x64", "arm64", "ia32"]),
				runtime: nonEmptyIdSchema.optional(),
				runtimeVersion: nonEmptyIdSchema.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

/** hello accepts omitted features and the original identity aliases, but emits canonical fields only. */
export const pluginHelloParamsSchema = z.preprocess(
	normalizeLegacyHelloParams,
	pluginHelloCanonicalParamsSchema,
);
export const pluginHelloRequestSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		id: jsonRpcIdSchema,
		method: z.literal("hello"),
		params: pluginHelloParamsSchema,
	})
	.strict();
export const pluginHelloNotificationSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		method: z.literal("hello"),
		params: pluginHelloParamsSchema,
	})
	.strict();
export const pluginHelloEnvelopeSchema = z.union([
	pluginHelloRequestSchema,
	pluginHelloNotificationSchema,
]);

/** initialize defaults features to [] so legacy Host -> Plugin lifecycle RPC remains compatible. */
export const hostInitializeParamsSchema = z
	.object({
		protocol: z.literal(NARRAFORK_RPC_PROTOCOL),
		hostApiVersion: nonEmptyIdSchema,
		pluginId: nonEmptyIdSchema,
		runtimeId: nonEmptyIdSchema,
		generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		capabilities: capabilityListSchema,
		features: pluginToHostFeatureListSchema.optional().default([]),
		limits: z
			.object({
				maxInboundFrameBytes: z
					.number()
					.int()
					.positive()
					.max(64 * 1024 * 1024),
				maxInFlight: z.number().int().positive().max(1_024),
				maxQueuedBytes: z
					.number()
					.int()
					.positive()
					.max(64 * 1024 * 1024)
					.optional(),
			})
			.strict(),
	})
	.strict();

export const pluginToHostRequestSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		id: jsonRpcIdSchema,
		method: pluginToHostRequestMethodSchema,
		params: jsonValueSchema.optional(),
	})
	.strict();
export type PluginToHostRequest = z.infer<typeof pluginToHostRequestSchema>;

export const PLUGIN_TO_HOST_METHOD_REQUIRED_FEATURES = {
	"queries.execute": ["host_api.requests"],
	"commands.execute": ["host_api.requests"],
	"events.subscribe": ["host_api.requests"],
	"events.unsubscribe": ["host_api.requests"],
	"events.poll": ["host_api.requests", "events.poll"],
	"storage.get": ["host_api.requests"],
	"storage.set": ["host_api.requests"],
	"storage.delete": ["host_api.requests"],
	"storage.list": ["host_api.requests"],
	"config.get": ["host_api.requests"],
	"secrets.get": ["host_api.requests"],
	"secrets.set": ["host_api.requests"],
	"secrets.delete": ["host_api.requests"],
	"secrets.list": ["host_api.requests"],
	"diagnostics.getOwn": ["host_api.requests"],
} as const satisfies Record<PluginToHostRequestMethod, readonly PluginToHostFeature[]>;

export function isPluginToHostRequestMethod(method: string): method is PluginToHostRequestMethod {
	return (PLUGIN_TO_HOST_REQUEST_METHODS as readonly string[]).includes(method);
}

export const rpcCancelRequestParamsSchema = z
	.object({
		requestId: jsonRpcIdSchema,
		reason: z.string().trim().min(1).max(500),
	})
	.strict();
export const rpcCancelRequestNotificationSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		method: z.literal(RPC_CANCEL_REQUEST_METHOD),
		params: rpcCancelRequestParamsSchema,
	})
	.strict();

export const rpcCreditParamsSchema = z
	.object({
		streamId: nonEmptyIdSchema,
		throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		grantEvents: z.number().int().nonnegative().max(1_000_000),
		grantBytes: z
			.number()
			.int()
			.nonnegative()
			.max(64 * 1024 * 1024),
	})
	.strict()
	.superRefine((credit, context) => {
		if (credit.grantEvents === 0 && credit.grantBytes === 0) {
			context.addIssue({ code: "custom", message: "Credit must grant events or bytes" });
		}
	});
export const rpcCreditNotificationSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		method: z.literal(RPC_CREDIT_METHOD),
		params: rpcCreditParamsSchema,
	})
	.strict();

const lifecycleNotificationParamsSchema = jsonObjectSchema.optional();
export const pluginInitializedNotificationSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		method: z.literal("initialized"),
		params: lifecycleNotificationParamsSchema,
	})
	.strict();
export const pluginActivatedNotificationSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		method: z.literal("activated"),
		params: lifecycleNotificationParamsSchema,
	})
	.strict();
export const pluginHealthyNotificationSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		method: z.literal("healthy"),
		params: lifecycleNotificationParamsSchema,
	})
	.strict();

export const pluginToHostCoreNotificationSchema = z.union([
	pluginHelloNotificationSchema,
	pluginInitializedNotificationSchema,
	pluginActivatedNotificationSchema,
	pluginHealthyNotificationSchema,
	rpcCancelRequestNotificationSchema,
	rpcCreditNotificationSchema,
]);

const providerProtocolVersionSchema = z.literal(PROVIDER_PROTOCOL_VERSION);
const operationIdSchema = z.string().trim().min(1).max(128);
const positiveSequenceSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const outputIndexSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
const optionalTextSchema = z.string().max(4_000).optional();
const citationIndexSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

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
	// Source citations for assistant text (native search). Additive: plugins that
	// never emit this keep working unchanged. Bounds mirror CITATION_LIMITS so a
	// plugin cannot push unbounded metadata through the stream.
	z
		.object({
			type: z.literal("text.citation"),
			citations: z
				.array(
					z
						.object({
							startIndex: citationIndexSchema.optional(),
							endIndex: citationIndexSchema,
							url: z.string().trim().min(1).max(CITATION_LIMITS.maxUrlLength).optional(),
							title: z.string().trim().min(1).max(CITATION_LIMITS.maxTitleLength).optional(),
							sourceRef: z
								.string()
								.trim()
								.min(1)
								.max(CITATION_LIMITS.maxSourceRefLength)
								.optional(),
							outputIndex: outputIndexSchema,
						})
						.strict(),
				)
				.min(1)
				.max(CITATION_LIMITS.maxCitations),
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

/** Provider v1 compatibility ACK; new generic streams use $/credit. */
export const providerStreamAckParamsSchema = z
	.object({
		protocolVersion: providerProtocolVersionSchema,
		operationId: operationIdSchema,
		throughSeq: positiveSequenceSchema,
		grantEvents: z.number().int().nonnegative().max(1_000_000),
		grantBytes: z
			.number()
			.int()
			.nonnegative()
			.max(64 * 1024 * 1024),
	})
	.strict()
	.superRefine((credit, context) => {
		if (credit.grantEvents === 0 && credit.grantBytes === 0) {
			context.addIssue({ code: "custom", message: "Credit must grant events or bytes" });
		}
	});
export const providerStreamAckSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		method: z.literal("provider.streamAck"),
		params: providerStreamAckParamsSchema,
	})
	.strict();
export const providerStreamAckNotificationSchema = providerStreamAckSchema;

export function adaptProviderStreamAckToRpcCredit(
	input: z.input<typeof providerStreamAckSchema>,
): z.output<typeof rpcCreditNotificationSchema> {
	const message = providerStreamAckSchema.parse(input);
	return rpcCreditNotificationSchema.parse({
		jsonrpc: "2.0",
		method: RPC_CREDIT_METHOD,
		params: {
			streamId: message.params.operationId,
			throughSeq: message.params.throughSeq,
			grantEvents: message.params.grantEvents,
			grantBytes: message.params.grantBytes,
		},
	});
}

export const PLUGIN_TO_HOST_NOTIFICATION_METHODS = [
	"hello",
	"initialized",
	"activated",
	"healthy",
	"provider.event",
	RPC_CANCEL_REQUEST_METHOD,
	RPC_CREDIT_METHOD,
] as const;
export type PluginToHostNotificationMethod = (typeof PLUGIN_TO_HOST_NOTIFICATION_METHODS)[number];
export const pluginToHostNotificationMethodSchema = z.enum(PLUGIN_TO_HOST_NOTIFICATION_METHODS);
export const PLUGIN_TO_HOST_NOTIFICATION_REQUIRED_FEATURES = {
	hello: [],
	initialized: [],
	activated: [],
	healthy: [],
	"provider.event": ["host_api.notifications"],
	[RPC_CANCEL_REQUEST_METHOD]: ["rpc.cancel"],
	[RPC_CREDIT_METHOD]: ["stream.credit"],
} as const satisfies Record<PluginToHostNotificationMethod, readonly PluginToHostFeature[]>;

export const pluginToHostNotificationSchema = z.union([
	pluginToHostCoreNotificationSchema,
	providerEventSchema,
]);
export const pluginToHostEnvelopeSchema = z.union([
	jsonRpcResponseSchema,
	pluginHelloRequestSchema,
	pluginToHostRequestSchema,
	pluginToHostNotificationSchema,
]);
export type PluginToHostNotification = z.infer<typeof pluginToHostNotificationSchema>;
export type PluginToHostEnvelope = z.infer<typeof pluginToHostEnvelopeSchema>;

/* -------------------------------------------------------------------------- */
/* Host → Plugin: commands.invoke                                             */
/* -------------------------------------------------------------------------- */

/**
 * `commands.invoke` dispatches a manifest command contribution to the plugin backend.
 *
 * A manifest may declare `commands[].handler: "server"`, but nothing consumed that:
 * `commands.execute` resolves against the *host's* `CommandRegistry`, whose handlers are
 * host functions, so a plugin-declared command was unreachable. This method is the missing
 * half, and is shaped exactly like `tools.invoke` — the established Host→Plugin dispatch
 * pattern — so timeouts, byte caps and cancellation behave identically.
 *
 * Note this is a *Host→Plugin* method. It does not appear in
 * `PLUGIN_TO_HOST_REQUEST_METHODS` or in the iframe's method inventory, and the parity
 * assertion that freezes those two lists is unaffected.
 */
export const COMMANDS_INVOKE_METHOD = "commands.invoke" as const;

/**
 * Max bytes for a single secret value. Matches the vault's own per-value ceiling.
 *
 * Retained where the entry-count and batch-total ceilings were removed, because this one is
 * not about trust: `plugin-secret-vault` is a synchronous JSON read/modify/write on the
 * main thread, so one unbounded value stalls every request. See CLAUDE.md.
 */
export const MAX_COMMAND_SECRET_VALUE_BYTES = 64 * 1024;

/**
 * One requested secret mutation returned by a plugin command.
 *
 * `value: null` deletes the key, matching the config form's clear-a-secret semantics.
 *
 * The host still derives the legal namespace from what the plugin contributed, so a command
 * cannot write another plugin's credentials. It no longer requires the field to be declared
 * in a `configSchema`: a plugin that manages its own credential set (rotating tokens,
 * multiple accounts) cannot enumerate those keys in a static manifest.
 */
export const commandSecretWriteSchema = z
	.object({
		key: z.string().trim().min(1).max(256),
		value: z.string().max(MAX_COMMAND_SECRET_VALUE_BYTES).nullable(),
	})
	.strict();

export const commandsInvokeParamsSchema = z
	.object({
		contributionId: z.string().trim().min(1).max(128),
		input: jsonValueSchema.optional(),
		context: z
			.object({
				requestId: z.string().trim().min(1).max(128),
				correlationId: z.string().trim().min(1).max(128).optional(),
				deadlineAt: z.string().trim().min(1).max(64).optional(),
				idempotencyKey: z.string().trim().min(1).max(128).optional(),
			})
			.strict(),
	})
	.strict();

/**
 * Max bytes for a single non-secret config value.
 *
 * Smaller than the secret ceiling on purpose: config is persisted through the provider config
 * service, which validates the whole object against the contribution's `configSchema` on every
 * write. These are settings — a mode, a region, a URL — not credential blobs.
 */
export const MAX_COMMAND_CONFIG_VALUE_BYTES = 16 * 1024;

/**
 * One requested non-secret config mutation returned by a plugin command.
 *
 * Exists because `secretWrites` cannot carry it: the vault and the config store are different
 * places, and a value written to the vault would never reach `configSchema` validation or the
 * config the host passes back into `provider.chat`. Without this, a command could change a
 * setting on the live provider instance but not persist it, so the change silently reverted on
 * the next restart.
 *
 * `value: null` clears the field, matching the config form.
 *
 * The host derives the writable namespace from what the plugin contributed and refuses keys
 * that name a *secret* field, so the two channels stay disjoint rather than overlapping.
 */
export const commandConfigWriteSchema = z
	.object({
		key: z.string().trim().min(1).max(256),
		value: jsonValueSchema.nullable(),
	})
	.strict();

export const commandsInvokeResultSchema = z
	.object({
		/** Payload returned to the caller. Never includes secret values. */
		output: jsonValueSchema.optional(),
		/**
		 * Secret mutations the host should apply. Consumed by the host, never echoed to the UI.
		 *
		 * Bounded only so one response cannot carry an unbounded array into JSON parsing;
		 * this is an event-loop guard, not a policy on how many credentials a plugin may own.
		 */
		secretWrites: z.array(commandSecretWriteSchema).max(1_000).optional(),
		/**
		 * Non-secret config mutations. Also consumed by the host and never echoed back.
		 *
		 * Capped far lower than `secretWrites`: a config write goes through schema validation
		 * and rewrites the provider's stored config, so a large batch is a sign of misuse
		 * rather than a legitimate credential set.
		 */
		configWrites: z.array(commandConfigWriteSchema).max(64).optional(),
	})
	.strict();

export type CommandSecretWrite = z.infer<typeof commandSecretWriteSchema>;
export type CommandConfigWrite = z.infer<typeof commandConfigWriteSchema>;
export type CommandsInvokeParams = z.infer<typeof commandsInvokeParamsSchema>;
export type CommandsInvokeResult = z.infer<typeof commandsInvokeResultSchema>;

/* -------------------------------------------------------------------------- */
/* Host → Plugin: provider.search                                             */
/* -------------------------------------------------------------------------- */

/**
 * `provider.search` runs one web search through a `contributes.searchProviders` source.
 *
 * Deliberately **unary**, unlike `provider.chat`: there is no accepted/event/done triple and
 * no operation id. The host's search layer (`server/lib/search/router.ts`) awaits a single
 * text or result list per channel and falls through to the next channel on failure, so a
 * streaming protocol would have nothing to stream into. If incremental results are ever
 * wanted, that is a new method rather than an extension of this one.
 *
 * Like `commands.invoke` this is a *Host→Plugin* method: it does not belong in
 * `PLUGIN_TO_HOST_REQUEST_METHODS` or the iframe method inventory, so the parity assertion
 * that freezes those two lists is unaffected.
 *
 * Credentials arrive the same way they do for `provider.chat` — resolved from the vault by
 * the host and passed in `config` per request. The fields belong to the *bound provider*
 * contribution (`searchProviders[].providerId`), because search has no vault namespace of
 * its own; see `searchProviderContributionSchema` in `manifest.ts`.
 */
export const PROVIDER_SEARCH_METHOD = "provider.search" as const;

/**
 * Outbound network hints the host attaches to every provider method call.
 *
 * ## Design rationale
 *
 * The host resolves proxy config from its own settings and delivers it per-RPC-call rather than
 * via environment variables (`SAFE_ENV_KEYS`). The rejected alternative — adding `*_PROXY` to
 * `SAFE_ENV_KEYS` — grants all plugins unconditional proxy inheritance at process level, which
 * is a wider authorization surface that bypasses per-call control. The RPC-parameter approach
 * means the host decides *per request* whether proxy should apply, which fields carry
 * credentials are explicit, and no proxy appears in env dumps or diagnostics.
 *
 * ## Security: proxy URLs may contain credentials
 *
 * A proxy URL like `http://user:pass@host:port` is secret-grade. It MUST NOT appear in:
 * - Diagnostic dumps (`ProviderRpcDiagnostics`)
 * - Operation logs (request/response logging paths)
 * - `provider.event` stream (WebSocket broadcast)
 * - WebSocket or SSE payloads sent to the frontend
 *
 * The host strips `outbound` from any logged/diagnostic representation of the request.
 *
 * ## When absent
 *
 * When no proxy is configured, the field is omitted entirely. An absent field means
 * "the host has no proxy policy for you; use your own default". An explicit empty string
 * would mean "direct connect, bypass any default", which is a different semantic — so the
 * host never sends an empty string.
 */
export const providerOutboundHintsSchema = z
	.object({
		/**
		 * HTTP(S) proxy URL the plugin should use for upstream API calls.
		 *
		 * May contain credentials (userinfo). Treat as secret.
		 * Absent = no proxy policy from the host. Empty string is never sent.
		 */
		proxyUrl: z.string().trim().min(1).max(2_048).optional(),
	})
	.strict();

/**
 * Optional cooperative upstream-concurrency hint for provider methods.
 *
 * Provider concurrency has two distinct layers:
 *
 * 1. Host-owned generic IPC safety budgets (`maxInFlightOperations`, frame/queue/request bytes,
 *    and related time/output limits). The host enforces these budgets to protect the runtime and
 *    the host event loop.
 * 2. Provider-specific business concurrency (`descriptor.limits.maxConcurrentChat` /
 *    `maxConcurrentGenerate` and upstream connection limits). The plugin owns this policy,
 *    including queuing, throttling, and deciding when to return a provider-busy result. The host
 *    does not reject a request because of a plugin-declared provider concurrency value.
 *
 * This hint is only for the second layer: it tells the plugin how many concurrent upstream
 * connections it should target. The host cannot enforce it (the plugin process makes its own TCP
 * connections), so a well-behaved plugin should apply it to its own outbound semaphore/pool.
 *
 * ## When absent
 *
 * Absent means the host has no opinion on upstream concurrency. The plugin should fall back to
 * its own policy, including any defaults associated with its declared provider limits.
 */
export const providerConcurrencyBudgetSchema = z
	.object({
		/**
		 * Maximum concurrent upstream API connections this plugin should maintain.
		 *
		 * This is a hint, not enforcement. The host cannot prevent the plugin from exceeding it.
		 * A plugin sharing an account with the host's built-in provider should respect this to
		 * avoid aggregate 429s.
		 *
		 * ## Current delivery status
		 *
		 * The host does NOT currently populate this field. The only per-provider concurrency
		 * value the host knows is `descriptor.limits.maxConcurrentChat`, which is plugin-declared
		 * policy metadata rather than a host admission limit; sending it back would be pure noise.
		 *
		 * Meaningful delivery requires the host to know how much of a shared upstream quota is
		 * being consumed by OTHER paths (e.g. a built-in adapter sharing the same account). That
		 * information lives in provider-specific concurrency-control state and should not leak into
		 * the generic plugin protocol. When a cross-path budget coordination mechanism exists, this
		 * field becomes the delivery vehicle.
		 */
		maxConcurrentUpstream: z.number().int().min(1).max(1_000).optional(),
	})
	.strict();

/**
 * Combined host-provided hints attached to every provider method request.
 *
 * Optional at the top level: old plugins that do not understand these fields simply ignore them
 * (the schema is additive, .strict() is on the inner objects). The host omits the entire field
 * when there is nothing to communicate.
 */
export const providerHostHintsSchema = z
	.object({
		outbound: providerOutboundHintsSchema.optional(),
		concurrency: providerConcurrencyBudgetSchema.optional(),
	})
	.strict();

export type ProviderOutboundHints = z.infer<typeof providerOutboundHintsSchema>;
export type ProviderConcurrencyBudget = z.infer<typeof providerConcurrencyBudgetSchema>;
export type ProviderHostHints = z.infer<typeof providerHostHintsSchema>;

export const providerSearchParamsSchema = z
	.object({
		protocolVersion: z.string().trim().min(1).max(32),
		/** Search contribution to run. Namespaced by the plugin's own manifest. */
		contributionId: z.string().trim().min(1).max(128),
		/** Resolved config of the bound provider contribution, secrets included. */
		config: jsonObjectSchema.optional(),
		query: z.string().trim().min(1).max(4_000),
		/** Present only for channels the host runs with a stated research goal. */
		purpose: z.string().max(4_000).optional(),
		allowedDomains: z.array(z.string().trim().min(1).max(253)).max(64).optional(),
		blockedDomains: z.array(z.string().trim().min(1).max(253)).max(64).optional(),
		recencyDays: z.number().int().min(1).max(3_650).optional(),
		maxResults: z.number().int().min(1).max(100).optional(),
		locale: z.string().trim().min(1).max(32).optional(),
		/** Host-provided network and concurrency hints. Absent = no hints. */
		hostHints: providerHostHintsSchema.optional(),
	})
	.strict();

/**
 * A single search hit. Field names mirror the host's own `SearchResultItem`
 * (`server/lib/search/types.ts`) so the host can render them with the same helper it uses
 * for built-in adapters.
 */
export const providerSearchResultItemSchema = z
	.object({
		title: z.string().max(1_000).optional(),
		url: z.string().max(2_048).optional(),
		snippet: z.string().max(8_000).optional(),
		publishedAt: z.string().max(64).optional(),
		source: z.string().max(200).optional(),
	})
	.strict();

export const providerSearchResultSchema = z
	.object({
		/** Rendered answer. Optional when `results` is present: the host can render those itself. */
		text: z.string().max(1_000_000).optional(),
		results: z.array(providerSearchResultItemSchema).max(100).optional(),
	})
	.strict()
	.refine((result) => !!result.text?.length || !!result.results?.length, {
		// An empty response would otherwise register as a successful search with no content,
		// stopping the router's fallback chain at a channel that returned nothing.
		message: "provider.search result must carry text or results",
	});

export type ProviderSearchParams = z.infer<typeof providerSearchParamsSchema>;
export type ProviderSearchResultItem = z.infer<typeof providerSearchResultItemSchema>;
export type ProviderSearchResult = z.infer<typeof providerSearchResultSchema>;

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
	"STORAGE_QUOTA_EXCEEDED",
	"STORAGE_CONFLICT",
	"PLUGIN_BUSY",
	"UNKNOWN_RESULT",
	"INCOMPATIBLE",
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
	"narrafork.narrator.spec.changed",
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

/** Canonical v1 subscribe contract: live source, poll delivery, no snapshot callback payload. */
export const eventsSubscribeParamsSchema = z
	.object({
		topics: z
			.array(publicEventTopicSchema)
			.min(1)
			.max(20)
			.refine((topics) => new Set(topics).size === topics.length, "Topics must be unique"),
		filter: publicEventFilterSchema.optional(),
		scope: invocationScopeSchema.optional(),
		mode: eventSubscriptionModeSchema.optional().default("live"),
		delivery: z
			.object({
				transport: eventDeliveryTransportSchema.optional().default("poll"),
				maxRatePerSecond: z.number().finite().positive().max(1_000).optional(),
				queueEvents: z.number().int().positive().max(1_000).optional(),
				queueBytes: z
					.number()
					.int()
					.positive()
					.max(2 * 1024 * 1024)
					.optional(),
			})
			.strict()
			.optional()
			.default({ transport: "poll" }),
	})
	.strict();

export const eventsPollParamsSchema = z
	.object({
		subscriptionId: nonEmptyIdSchema,
		limit: z.number().int().positive().max(100).optional().default(100),
	})
	.strict();
export const eventsPollResultSchema = z
	.object({
		subscriptionId: nonEmptyIdSchema,
		events: z.array(publicEventSchema).max(100),
		hasMore: z.boolean(),
		resyncRequired: z.boolean().optional(),
	})
	.strict();
