import { z } from "zod";

export const PLUGIN_UI_PROTOCOL = "narrafork.ui/1" as const;
export const PLUGIN_UI_PROTOCOL_MAJOR = 1 as const;
export const PLUGIN_UI_REQUEST_MAX_BYTES = 256 * 1024;
export const PLUGIN_UI_RESPONSE_MAX_BYTES = 1024 * 1024;
export const PLUGIN_UI_DEFAULT_TIMEOUT_MS = 10_000;
export const PLUGIN_UI_MAX_VIEW_STATE_BYTES = 16 * 1024;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

export function isJsonValue(
	value: unknown,
	depth = 0,
	seen = new Set<object>(),
): value is JsonValue {
	if (depth > 32 || value === undefined) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1, seen));
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		return false;
	}
	return Object.entries(value).every(
		([key, item]) => !forbiddenKeys.has(key) && isJsonValue(item, depth + 1, seen),
	);
}

export function jsonByteLength(value: unknown): number {
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch {
		return Number.POSITIVE_INFINITY;
	}
	if (json === undefined) return Number.POSITIVE_INFINITY;
	return new TextEncoder().encode(json).byteLength;
}

const idSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const methodSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9._:-]+$/);
const jsonValueSchema = z.custom<JsonValue>((value) => isJsonValue(value));
const nonceSchema = z.string().min(20).max(128);
export const uiBootstrapSchema = z
	.object({
		type: z.literal("narrafork:ui-connect"),
		nonce: nonceSchema,
		protocol: z.literal(PLUGIN_UI_PROTOCOL),
		hostProtocolRange: z.object({ min: z.literal(1), max: z.literal(1) }).strict(),
		pluginId: idSchema,
		contributionId: idSchema,
		panelInstanceId: idSchema,
	})
	.strict();

export const uiHandshakeParamsSchema = z
	.object({
		nonce: nonceSchema,
		protocolVersion: z.literal(PLUGIN_UI_PROTOCOL_MAJOR),
		pluginId: idSchema,
		contributionId: idSchema,
		panelInstanceId: idSchema,
	})
	.strict();

export const uiRpcErrorSchema = z
	.object({
		code: z.enum([
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
			"INCOMPATIBLE",
		]),
		message: z.string().trim().min(1).max(4_000),
		retryable: z.boolean().optional(),
		details: jsonValueSchema.optional(),
	})
	.strict();

export const uiRpcRequestSchema = z
	.object({
		protocol: z.literal(PLUGIN_UI_PROTOCOL),
		kind: z.literal("request"),
		id: idSchema,
		method: methodSchema,
		params: jsonValueSchema.optional(),
	})
	.strict();

export const uiRpcNotificationSchema = z
	.object({
		protocol: z.literal(PLUGIN_UI_PROTOCOL),
		kind: z.literal("notification"),
		method: methodSchema,
		params: jsonValueSchema.optional(),
	})
	.strict();

export const uiRpcResponseSchema = z.union([
	z
		.object({
			protocol: z.literal(PLUGIN_UI_PROTOCOL),
			kind: z.literal("response"),
			id: idSchema,
			result: jsonValueSchema,
		})
		.strict(),
	z
		.object({
			protocol: z.literal(PLUGIN_UI_PROTOCOL),
			kind: z.literal("response"),
			id: idSchema,
			error: uiRpcErrorSchema,
		})
		.strict(),
]);

export const uiRpcEnvelopeSchema = z.union([
	uiRpcRequestSchema,
	uiRpcNotificationSchema,
	uiRpcResponseSchema,
]);

export type UiBootstrapMessage = z.infer<typeof uiBootstrapSchema>;
export type UiRpcRequest = z.infer<typeof uiRpcRequestSchema>;
export type UiRpcNotification = z.infer<typeof uiRpcNotificationSchema>;
export type UiRpcResponse = z.infer<typeof uiRpcResponseSchema>;
export type UiRpcEnvelope = z.infer<typeof uiRpcEnvelopeSchema>;
export type UiRpcError = z.infer<typeof uiRpcErrorSchema>;

export type PluginPanelBinding =
	| { kind: "focus-current-narrator" }
	| { kind: "workspace"; workspaceId: string }
	| { kind: "workspace-narrator"; workspaceId: string; ownerNarratorId: string }
	| { kind: "global" };

const bindingSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("focus-current-narrator") }).strict(),
	z.object({ kind: z.literal("workspace"), workspaceId: idSchema }).strict(),
	z
		.object({
			kind: z.literal("workspace-narrator"),
			workspaceId: idSchema,
			ownerNarratorId: idSchema,
		})
		.strict(),
	z.object({ kind: z.literal("global") }).strict(),
]);

export const pluginDockPanelParamsSchema = z
	.object({
		panelType: z.literal("plugin"),
		schemaVersion: z.literal(1),
		pluginId: idSchema,
		contributionId: idSchema,
		panelInstanceId: idSchema,
		binding: bindingSchema,
		viewState: jsonValueSchema.optional(),
		viewStateVersion: z.number().int().nonnegative().max(10_000).optional(),
		fallback: z
			.object({
				title: z.string().max(200).optional(),
				pluginName: z.string().max(200).optional(),
				pluginVersion: z.string().max(100).optional(),
			})
			.strict()
			.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (
			value.viewState !== undefined &&
			jsonByteLength(value.viewState) > PLUGIN_UI_MAX_VIEW_STATE_BYTES
		) {
			context.addIssue({
				code: "custom",
				path: ["viewState"],
				message: "viewState exceeds 16 KiB",
			});
		}
	});

export type PluginDockPanelParams = z.infer<typeof pluginDockPanelParamsSchema>;

export function parsePluginDockPanelParams(value: unknown): PluginDockPanelParams | null {
	const result = pluginDockPanelParamsSchema.safeParse(value);
	return result.success ? result.data : null;
}

export function validateUiEnvelope(
	value: unknown,
	maxBytes = PLUGIN_UI_RESPONSE_MAX_BYTES,
): UiRpcEnvelope | null {
	if (jsonByteLength(value) > maxBytes) return null;
	const result = uiRpcEnvelopeSchema.safeParse(value);
	return result.success ? result.data : null;
}

let requestSequence = 0;
export function createUiRequestId(): string {
	requestSequence = (requestSequence + 1) % Number.MAX_SAFE_INTEGER;
	const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 12);
	return `ui_${random ?? "local"}_${requestSequence.toString(36)}`;
}

export function makeUiRequest(method: string, params?: JsonValue): UiRpcRequest {
	return {
		protocol: PLUGIN_UI_PROTOCOL,
		kind: "request",
		id: createUiRequestId(),
		method,
		...(params === undefined ? {} : { params }),
	};
}

export function makeUiNotification(method: string, params?: JsonValue): UiRpcNotification {
	return {
		protocol: PLUGIN_UI_PROTOCOL,
		kind: "notification",
		method,
		...(params === undefined ? {} : { params }),
	};
}

export function makeUiResponse(
	id: string,
	result: JsonValue | undefined,
	error?: UiRpcError,
): UiRpcResponse {
	if (error) return { protocol: PLUGIN_UI_PROTOCOL, kind: "response", id, error };
	return { protocol: PLUGIN_UI_PROTOCOL, kind: "response", id, result: result ?? null };
}
