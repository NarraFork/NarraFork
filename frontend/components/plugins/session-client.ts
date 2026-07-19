import { z } from "zod";
import { ApiError, BASE, request } from "../../lib/api/client";
import type { PluginUiSessionContext } from "./PluginUiSurfaceContext";
import type { JsonValue, PluginDockPanelParams, UiRpcRequest } from "./protocol";
import { isJsonValue, uiRpcErrorCodeSchema, uiRpcErrorSchema } from "./protocol";
import type { PluginUiContribution } from "./types";

const hashPattern = /^[a-f0-9]{64}$/;
const sessionCreateResponseSchema = z.object({
	session: z.object({
		sessionId: z.string().min(1).max(256),
		connectNonce: z.string().min(20).max(128),
	}),
	sessionToken: z.string().min(20).max(512),
	assetToken: z.string().min(20).max(512),
});

/**
 * Response envelope used on the inbound backend path. The shared wire schema
 * accepts bounded open identifiers, so structured backend business codes (e.g.
 * STORAGE_QUOTA_EXCEEDED,
 * STORAGE_CONFLICT, PLUGIN_UI_PACKAGE_NOT_CURRENT) intact so it is never
 * silently collapsed into INTERNAL_ERROR.
 */
const backendResponseSchema = z.union([
	z
		.object({
			protocol: z.literal("narrafork.ui/1"),
			kind: z.literal("response"),
			id: z.string().min(1),
			result: z.custom<JsonValue>((value) => isJsonValue(value)),
		})
		.strict(),
	z
		.object({
			protocol: z.literal("narrafork.ui/1"),
			kind: z.literal("response"),
			id: z.string().min(1),
			error: z
				.object({
					code: uiRpcErrorCodeSchema,
					message: z.string().trim().min(1).max(4_000),
					retryable: z.boolean().optional(),
					details: z.custom<JsonValue>((value) => isJsonValue(value)).optional(),
				})
				.strict(),
		})
		.strict(),
]);

export type PluginUiApiRequest = <T>(
	path: string,
	options?: RequestInit & { signal?: AbortSignal },
) => Promise<T>;

export interface MaterializedPluginUiSession {
	backendSessionId: string;
	sessionToken: string;
	nonce: string;
	contribution: PluginUiContribution;
}

export function resolvePluginUiInvocationScope(
	contribution: PluginUiContribution,
	sessionContext: PluginUiSessionContext,
): {
	surfaceScope: "workspace" | "narrator" | "project" | "global";
	scope: Record<string, string>;
} {
	switch (contribution.scope) {
		case "workspace":
			if (!sessionContext.workspaceId) {
				throw new Error("Plugin UI workspace scope requires a live workspace id");
			}
			return {
				surfaceScope: "workspace",
				scope: { workspaceId: sessionContext.workspaceId },
			};
		case "project":
			if (!sessionContext.projectId) {
				throw new Error("Plugin UI project scope requires a live project id");
			}
			return { surfaceScope: "project", scope: { projectId: sessionContext.projectId } };
		case "narrator":
			if (!sessionContext.narratorId) {
				throw new Error("Plugin UI narrator scope requires a live narrator id");
			}
			return { surfaceScope: "narrator", scope: { narratorId: sessionContext.narratorId } };
		case "global":
			return { surfaceScope: "global", scope: {} };
		default:
			throw new Error("Plugin UI contribution scope is unavailable");
	}
}

function validateAssetPath(value: string | undefined, label: string): string {
	const path = value?.trim();
	if (
		!path ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		throw new Error(`Plugin UI ${label} path is unavailable`);
	}
	return path;
}

function encodeAssetPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function assetUrl(
	params: PluginDockPanelParams,
	contribution: PluginUiContribution,
	hash: string,
	sessionId: string,
	assetToken: string,
	path: string,
): string {
	return `${BASE}/plugins/ui/${encodeURIComponent(params.pluginId)}/${encodeURIComponent(contribution.version)}/${hash}/asset/${encodeURIComponent(sessionId)}/${encodeURIComponent(assetToken)}/${encodeAssetPath(path)}`;
}

export async function createPluginUiBackendSession(
	params: PluginDockPanelParams,
	contribution: PluginUiContribution,
	sessionContext: PluginUiSessionContext,
	signal?: AbortSignal,
	apiRequest: PluginUiApiRequest = request,
): Promise<MaterializedPluginUiSession> {
	if (
		params.pluginId !== contribution.pluginId ||
		params.contributionId !== contribution.contributionId
	) {
		throw new Error("Plugin UI contribution identity mismatch");
	}
	const hash = contribution.packageHash ?? contribution.contentHash;
	if (!hash || !hashPattern.test(hash)) throw new Error("Plugin UI package hash is unavailable");
	const entryPath = validateAssetPath(contribution.entryPath, "entry");
	const stylePath = contribution.stylePath
		? validateAssetPath(contribution.stylePath, "style")
		: undefined;
	const invocation = resolvePluginUiInvocationScope(contribution, sessionContext);
	const raw = await apiRequest<unknown>("/plugins/ui/sessions", {
		method: "POST",
		body: JSON.stringify({
			pluginId: params.pluginId,
			version: contribution.version,
			hash,
			contributionId: params.contributionId,
			panelInstanceId: params.panelInstanceId,
			surface: sessionContext.surface,
			surfaceScope: invocation.surfaceScope,
			scope: invocation.scope,
		}),
		signal,
	});
	const parsed = sessionCreateResponseSchema.safeParse(raw);
	if (!parsed.success) throw new Error("Plugin UI session response is invalid");
	const { session, sessionToken, assetToken } = parsed.data;
	return {
		backendSessionId: session.sessionId,
		sessionToken,
		nonce: session.connectNonce,
		contribution: {
			...contribution,
			entryUrl: assetUrl(params, contribution, hash, session.sessionId, assetToken, entryPath),
			...(stylePath
				? {
						styleUrl: assetUrl(
							params,
							contribution,
							hash,
							session.sessionId,
							assetToken,
							stylePath,
						),
					}
				: { styleUrl: undefined }),
			status: "available",
			unavailableReason: undefined,
		},
	};
}

export interface PluginUiBackendRequestInput {
	sessionId: string;
	sessionToken: string;
	request: UiRpcRequest;
	signal?: AbortSignal;
}

/**
 * Structured error surfaced to plugin iframe code. Mirrors the UiRpcError wire
 * shape ({code, message, retryable?, details?}) so HTTP and RPC failures are
 * indistinguishable to the plugin. The original transport code is preserved
 * under `details.originalCode`.
 */
export class PluginUiRpcError extends Error {
	readonly code: string;
	readonly retryable?: boolean;
	readonly details?: JsonValue;

	constructor(
		code: string,
		message: string,
		options: { retryable?: boolean; details?: JsonValue } = {},
	) {
		super(message);
		this.name = "PluginUiRpcError";
		this.code = code;
		this.retryable = options.retryable;
		this.details = options.details;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Map an HTTP status to a stable UiRpcError code when the body has no usable one. */
function httpStatusToCode(status: number): { code: string; retryable: boolean } {
	switch (status) {
		case 400:
			return { code: "INVALID_PARAMS", retryable: false };
		case 401:
			return { code: "PLUGIN_UI_SESSION_INVALID", retryable: true };
		case 403:
			return { code: "PERMISSION_DENIED", retryable: false };
		case 404:
			return { code: "NOT_FOUND", retryable: false };
		case 409:
			return { code: "CONFLICT", retryable: true };
		case 413:
			return { code: "PAYLOAD_TOO_LARGE", retryable: false };
		case 429:
			return { code: "RATE_LIMITED", retryable: true };
		default:
			return status >= 500
				? { code: "HOST_UNAVAILABLE", retryable: true }
				: { code: "INTERNAL_ERROR", retryable: false };
	}
}

/**
 * Normalize an HTTP-layer ApiError into a PluginUiRpcError. Prefers a structured
 * `code` in the response body (validated against the UiRpcError schema), then
 * falls back to the HTTP status mapping. The original transport code/status is
 * preserved in details.originalCode; retryable is always a concrete boolean.
 */
export function mapHttpErrorToUiRpcError(error: ApiError): PluginUiRpcError {
	const data = asRecord(error.data);
	const bodyCode = typeof data?.code === "string" ? data.code : undefined;
	const bodyMessage =
		typeof data?.message === "string"
			? data.message
			: typeof data?.error === "string"
				? data.error
				: undefined;
	const retryableFromBody = typeof data?.retryable === "boolean" ? data.retryable : undefined;

	// If the body already carries a valid UiRpcError code, keep it; otherwise map by status.
	let code: string;
	let retryable: boolean;
	if (bodyCode) {
		const parsed = uiRpcErrorSchema.safeParse({
			code: bodyCode,
			message: bodyMessage ?? error.message,
			...(retryableFromBody === undefined ? {} : { retryable: retryableFromBody }),
		});
		if (parsed.success) {
			code = parsed.data.code;
			retryable = parsed.data.retryable ?? httpStatusToCode(error.status).retryable;
		} else {
			({ code, retryable } = httpStatusToCode(error.status));
		}
	} else {
		({ code, retryable } = httpStatusToCode(error.status));
	}

	const details: Record<string, JsonValue> = {
		originalCode: bodyCode ?? `HTTP_${error.status}`,
		httpStatus: error.status,
	};
	if (isJsonValue(data?.details)) details.details = data.details;

	return new PluginUiRpcError(code, bodyMessage ?? error.message, { retryable, details });
}

/**
 * Normalize any backend request failure (HTTP ApiError, abort, or RPC error
 * body) into a structured PluginUiRpcError so the plugin always observes the
 * same {code, message, retryable, details} shape.
 */
function toPluginUiRpcError(error: unknown): PluginUiRpcError {
	if (error instanceof PluginUiRpcError) return error;
	if (error instanceof ApiError) return mapHttpErrorToUiRpcError(error);
	if (error instanceof DOMException && error.name === "AbortError") {
		return new PluginUiRpcError("CANCELLED", "Plugin UI request was cancelled", {
			retryable: false,
			details: { originalCode: "AbortError" },
		});
	}
	// RPC error body thrown from requestPluginUiBackend below (already structured).
	const record = asRecord(error);
	if (record && typeof record.code === "string") {
		const parsed = uiRpcErrorSchema.safeParse({
			code: record.code,
			message: typeof record.message === "string" ? record.message : "Plugin UI request failed",
			...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
			...(isJsonValue(record.details) ? { details: record.details } : {}),
		});
		if (parsed.success) {
			return new PluginUiRpcError(parsed.data.code, parsed.data.message, {
				retryable: parsed.data.retryable ?? false,
				...(parsed.data.details === undefined ? {} : { details: parsed.data.details }),
			});
		}
	}
	return new PluginUiRpcError(
		"INTERNAL_ERROR",
		error instanceof Error ? error.message : "Plugin UI request failed",
		{ retryable: false },
	);
}

export async function requestPluginUiBackend(
	input: PluginUiBackendRequestInput,
	apiRequest: PluginUiApiRequest = request,
): Promise<JsonValue> {
	let raw: unknown;
	try {
		raw = await apiRequest<unknown>(
			`/plugins/ui/sessions/${encodeURIComponent(input.sessionId)}/request`,
			{
				method: "POST",
				headers: { "X-NarraFork-Plugin-Session": input.sessionToken },
				body: JSON.stringify(input.request),
				signal: input.signal,
			},
		);
	} catch (error) {
		throw toPluginUiRpcError(error);
	}
	const parsed = backendResponseSchema.safeParse(raw);
	if (!parsed.success) {
		throw new PluginUiRpcError("INTERNAL_ERROR", "Plugin UI host response is invalid", {
			retryable: false,
		});
	}
	if ("error" in parsed.data) {
		throw new PluginUiRpcError(parsed.data.error.code, parsed.data.error.message, {
			retryable: parsed.data.error.retryable ?? false,
			...(parsed.data.error.details === undefined ? {} : { details: parsed.data.error.details }),
		});
	}
	return parsed.data.result;
}

export async function revokePluginUiBackendSession(
	sessionId: string,
	apiRequest: PluginUiApiRequest = request,
): Promise<void> {
	await apiRequest(`/plugins/ui/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}
