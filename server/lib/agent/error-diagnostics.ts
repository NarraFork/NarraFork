import type { ApiRequestDiagnostics } from "./types";

export const ERROR_DIAGNOSTICS_SCHEMA = "narrafork.error-diagnostics.v1" as const;
export const MAX_DIAGNOSTIC_TEXT_CHARS = 8192;
export const MAX_DIAGNOSTIC_HEADERS = 16;
export const MAX_DIAGNOSTIC_JSON_CHARS = 16 * 1024;

const DIAGNOSTIC_HEADER_ALLOWLIST = new Set([
	"x-request-id",
	"x-correlation-id",
	"request-id",
	"content-type",
	"retry-after",
	"server",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, max = MAX_DIAGNOSTIC_TEXT_CHARS): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length <= max
		? trimmed
		: `${trimmed.slice(0, Math.max(0, max - 32))} [...truncated]`;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function sanitizeHeaderValue(value: string): string {
	return stringValue(value, 512) ?? "";
}

export function normalizeDiagnosticHeaders(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, string> = {};
	for (const [name, rawValue] of Object.entries(value)) {
		if (Object.keys(result).length >= MAX_DIAGNOSTIC_HEADERS) break;
		if (!DIAGNOSTIC_HEADER_ALLOWLIST.has(name.toLowerCase())) continue;
		if (typeof rawValue !== "string") continue;
		result[name] = sanitizeHeaderValue(rawValue);
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function diagnosticJsonBytes(result: ApiRequestDiagnostics): number {
	return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function truncateDiagnosticUtf8(value: string, maxBytes: number): string {
	const encoded = new TextEncoder().encode(value);
	if (encoded.byteLength <= maxBytes) return value;
	return new TextDecoder().decode(encoded.slice(0, Math.max(0, maxBytes)));
}

function limitDiagnosticJsonSize(result: ApiRequestDiagnostics): ApiRequestDiagnostics {
	if (diagnosticJsonBytes(result) <= MAX_DIAGNOSTIC_JSON_CHARS) return result;

	// Headers are useful for correlation but lower priority than the request/status identity.
	if (result.responseHeaders) delete result.responseHeaders;

	// Shrink large fields first, then fall back to every remaining string field. The final
	// deletion pass guarantees the advertised byte ceiling even for unexpected provider fields.
	const preferredFields = [
		"responseSnippet",
		"cause",
		"message",
		"source",
		"requestId",
		"providerRequestId",
		"endpoint",
		"channelName",
		"channelType",
		"transport",
		"provider",
		"model",
		"phase",
		"reason",
		"errorType",
		"code",
	] as const;
	for (const field of preferredFields) {
		let value = result[field];
		if (typeof value !== "string") continue;
		while (diagnosticJsonBytes(result) > MAX_DIAGNOSTIC_JSON_CHARS && value.length > 0) {
			const overflow = diagnosticJsonBytes(result) - MAX_DIAGNOSTIC_JSON_CHARS;
			const currentBytes = Buffer.byteLength(value, "utf8");
			const nextBytes = Math.max(0, currentBytes - overflow - 32);
			const next = truncateDiagnosticUtf8(value, nextBytes);
			if (next === value) break;
			value = next;
			result[field] = value || undefined;
		}
		if (diagnosticJsonBytes(result) <= MAX_DIAGNOSTIC_JSON_CHARS) return result;
	}

	for (const field of preferredFields) {
		if (diagnosticJsonBytes(result) <= MAX_DIAGNOSTIC_JSON_CHARS) break;
		if (field !== "source" && field !== "requestId" && field !== "providerRequestId") {
			delete result[field];
		}
	}
	return result;
}

export function normalizeApiRequestDiagnostics(
	input: Partial<ApiRequestDiagnostics> | undefined,
): ApiRequestDiagnostics | undefined {
	if (!input) return undefined;
	const result: ApiRequestDiagnostics = { schema: ERROR_DIAGNOSTICS_SCHEMA };

	const stringFields = [
		"source",
		"phase",
		"reason",
		"errorType",
		"message",
		"responseSnippet",
		"requestId",
		"providerRequestId",
		"provider",
		"model",
		"channelName",
		"channelType",
		"endpoint",
		"transport",
		"cause",
	] as const;
	for (const field of stringFields) {
		const value = stringValue(input[field]);
		if (value !== undefined) result[field] = value;
	}

	if (typeof input.code === "string" || typeof input.code === "number") {
		const value = typeof input.code === "string" ? stringValue(input.code, 512) : input.code;
		if (value !== undefined) result.code = value;
	}
	const statusCode = numberValue(input.statusCode);
	if (statusCode != null && statusCode >= 100 && statusCode <= 599) result.statusCode = statusCode;
	const retryable = booleanValue(input.retryable);
	if (retryable !== undefined) result.retryable = retryable;
	const resumable = booleanValue(input.resumable);
	if (resumable !== undefined) result.resumable = resumable;
	const headers = normalizeDiagnosticHeaders(input.responseHeaders);
	if (headers) result.responseHeaders = headers;

	return Object.keys(result).length > 1 ? limitDiagnosticJsonSize(result) : undefined;
}

function firstValue(...values: unknown[]): unknown {
	return values.find((value) => value != null && value !== "");
}

/**
 * Extract the common error envelope emitted by NUG, Anthropic-compatible relays,
 * and OpenAI-compatible gateways without retaining arbitrary provider payloads.
 */
export function parseErrorDiagnostics(
	data: Record<string, unknown>,
	defaults: Partial<ApiRequestDiagnostics> = {},
): ApiRequestDiagnostics | undefined {
	const nested = isRecord(data.error) ? data.error : undefined;
	const supplied = isRecord(data.diagnostics) ? data.diagnostics : undefined;
	const suppliedError = supplied && isRecord(supplied.error) ? supplied.error : undefined;
	const statusCode = firstValue(
		supplied?.statusCode,
		supplied?.code,
		data.statusCode,
		data.code,
		nested?.statusCode,
		nested?.code,
		defaults.statusCode,
	);
	const code = firstValue(supplied?.code, data.code, nested?.code, suppliedError?.code);
	const reason = firstValue(
		supplied?.reason,
		data.reason,
		nested?.reason,
		nested?.type,
		suppliedError?.type,
		code,
	);
	const message = firstValue(
		supplied?.message,
		data.message,
		nested?.message,
		suppliedError?.message,
	);
	const responseSnippet = firstValue(
		supplied?.responseSnippet,
		data.responseSnippet,
		nested?.message,
		suppliedError?.message,
		message,
	);

	return normalizeApiRequestDiagnostics({
		...defaults,
		...supplied,
		statusCode: numberValue(statusCode),
		code: typeof code === "string" || typeof code === "number" ? code : undefined,
		reason: typeof reason === "string" ? reason : undefined,
		errorType: firstValue(supplied?.errorType, nested?.type, suppliedError?.type) as
			| string
			| undefined,
		message: message as string | undefined,
		responseSnippet: responseSnippet as string | undefined,
		requestId: firstValue(
			supplied?.requestId,
			data.requestId,
			data.request_id,
			nested?.requestId,
		) as string | undefined,
		providerRequestId: firstValue(supplied?.providerRequestId, data.providerRequestId) as
			| string
			| undefined,
		retryable: booleanValue(firstValue(supplied?.retryable, data.retryable)),
		resumable: booleanValue(firstValue(supplied?.resumable, data.resumable)),
		responseHeaders: normalizeDiagnosticHeaders(
			firstValue(supplied?.responseHeaders, data.responseHeaders),
		),
		cause: firstValue(supplied?.cause, data.cause) as string | undefined,
	});
}

export function diagnosticsFromError(error: unknown): ApiRequestDiagnostics | undefined {
	if (!isRecord(error) && !(error instanceof Error)) return undefined;
	const value = isRecord(error) ? error : {};
	const cause = isRecord(value.cause) ? value.cause : undefined;
	const message = error instanceof Error ? error.message : stringValue(value.message);
	const statusCode = firstValue(value.status, value.statusCode, cause?.status, cause?.statusCode);
	const diagnostics = isRecord(value.diagnostics) ? value.diagnostics : undefined;
	return normalizeApiRequestDiagnostics({
		...diagnostics,
		source: stringValue(diagnostics?.source) ?? "provider",
		phase: stringValue(diagnostics?.phase) ?? "request",
		statusCode: numberValue(statusCode),
		message: stringValue(diagnostics?.message) ?? message,
		cause: stringValue(diagnostics?.cause) ?? (cause ? stringValue(cause.message) : undefined),
		code:
			(typeof diagnostics?.code === "string" || typeof diagnostics?.code === "number"
				? diagnostics.code
				: undefined) ??
			(typeof value.code === "string" || typeof value.code === "number" ? value.code : undefined) ??
			(typeof cause?.code === "string" || typeof cause?.code === "number" ? cause.code : undefined),
		errorType:
			stringValue(diagnostics?.errorType) ??
			(typeof value.name === "string" ? value.name : undefined),
	});
}
