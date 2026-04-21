import { settings } from "../settings";
import { StreamStaleError } from "../stream-timeout";

/** Patterns that indicate a transient API error worth retrying. */
const RETRYABLE_PATTERNS = [
	"MODEL_TEMPORARILY_UNAVAILABLE",
	"overloaded",
	"too many requests",
	"rate limit",
	"throttl",
	"service unavailable",
	"temporarily unavailable",
	"capacity",
	"try again",
	"socket connection was closed unexpectedly",
	"connection was closed unexpectedly",
	"socket hang up",
	"connection reset",
	"econnreset",
	"etimedout",
	"eai_again",
	"fetch failed",
	"failed to fetch",
	"network error",
	"unable to connect",
	"the operation timed out",
	"server_error",
	"internal_server_error",
	"the server had an error",
	"internal server error",
];

/** Error codes that represent transient network/transport failures. */
const RETRYABLE_ERROR_CODES = new Set([
	"ECONNRESET",
	"EPIPE",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"ENETDOWN",
	"ENETUNREACH",
	"ECONNREFUSED",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	// Bun-specific error codes (PascalCase instead of Node.js SCREAMING_SNAKE_CASE)
	"CONNECTIONREFUSED",
	"CONNECTIONRESET",
	"CONNECTIONABORTED",
]);

const NON_RETRYABLE_PATTERNS = [
	"usage_limit_reached",
	"usage limit has been reached",
	"insufficient_quota",
	"quota exceeded",
	'"plan_type":"free"',
];

/** Patterns that indicate the request exceeded model input context. */
const CONTEXT_OVERFLOW_PATTERNS = [
	"exceeds the context window",
	"context window",
	"context length",
	"maximum context length",
	"context_length_exceeded",
	"input is too long",
	"prompt is too long",
	"too many tokens",
];

/** HTTP status codes that indicate transient server-side issues. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);

/** Reasons from invalidState that indicate a transient server-side issue worth retrying. */
const RETRYABLE_INVALID_STATE_REASONS = new Set([
	"server_error",
	"internal_error",
	"internal_server_error",
	"service_unavailable",
	"temporarily_unavailable",
]);

/** Extract a human-readable message from any thrown value, including ErrorEvent objects. */
export function extractErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	// Handle ErrorEvent (Bun/browser WebSocket errors) which aren't Error instances
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string" && obj.message) return obj.message;
		if (typeof obj.error === "object" && obj.error instanceof Error) return obj.error.message;
		if (typeof obj.error === "string" && obj.error) return obj.error;
	}
	return String(err);
}

export function isRetryableInvalidStateReason(reason: string, message?: string): boolean {
	if (RETRYABLE_INVALID_STATE_REASONS.has(reason.toLowerCase())) return true;
	// Also check the message for retryable patterns (e.g. "Too many requests",
	// "status 429") — providers may use non-standard reason codes like
	// "stream_initialization_failed" while the message contains the real cause.
	if (message) {
		const m = message.toLowerCase();
		if (NON_RETRYABLE_PATTERNS.some((p) => m.includes(p))) return false;
		if (RETRYABLE_PATTERNS.some((p) => m.includes(p))) return true;
		// Check for HTTP status codes embedded in the message
		if (/\b(429|500|502|503|529)\b/.test(m)) return true;
	}
	return false;
}

export function isContextOverflowReason(reason: string): boolean {
	const r = reason.toLowerCase();
	return (
		r.includes("context_length") ||
		r.includes("context_window") ||
		r === "input_too_long" ||
		r === "prompt_too_long" ||
		r === "context_overflow"
	);
}

export function isOutputTruncationReason(reason: string): boolean {
	const r = reason.toLowerCase();
	return r === "max_tokens" || r === "max_output_tokens" || r === "length";
}

export function isContextOverflowMessage(message: string): boolean {
	const m = message.toLowerCase();
	return CONTEXT_OVERFLOW_PATTERNS.some((p) => m.includes(p));
}

export function isContextWindowExceededError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const obj = err as Record<string, unknown>;

	if (typeof obj.code === "string" && isContextOverflowReason(obj.code)) return true;
	if (typeof obj.reason === "string" && isContextOverflowReason(obj.reason)) return true;

	if (typeof obj.message === "string" && isContextOverflowMessage(obj.message)) return true;
	if (typeof obj.error === "string" && isContextOverflowMessage(obj.error)) return true;

	const nested = obj.error;
	if (nested && typeof nested === "object") {
		const n = nested as Record<string, unknown>;
		if (typeof n.code === "string" && isContextOverflowReason(n.code)) return true;
		if (typeof n.type === "string" && isContextOverflowReason(n.type)) return true;
		if (typeof n.message === "string" && isContextOverflowMessage(n.message)) return true;
	}

	return false;
}

export function isRetryableError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	// Stream stale timeout is always retryable
	if (err instanceof StreamStaleError) return true;

	const obj = err as Record<string, unknown>;
	const nested = obj.error;
	const nestedObj =
		nested && typeof nested === "object" ? (nested as Record<string, unknown>) : undefined;
	const cause = obj.cause;
	const causeObj =
		cause && typeof cause === "object" ? (cause as Record<string, unknown>) : undefined;

	const msgCandidates = [
		obj.message,
		typeof obj.error === "string" ? obj.error : undefined,
		nestedObj?.message,
		typeof nestedObj?.error === "string" ? nestedObj.error : undefined,
		causeObj?.message,
		typeof causeObj?.error === "string" ? causeObj.error : undefined,
	]
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.toLowerCase());

	// Message-based hard quota / plan restrictions should never retry.
	if (msgCandidates.some((msg) => NON_RETRYABLE_PATTERNS.some((p) => msg.includes(p)))) {
		return false;
	}

	// Check for known retryable reason/code fields.
	if (
		obj.reason === "MODEL_TEMPORARILY_UNAVAILABLE" ||
	) {
		return true;
	}

	const directCode =
		typeof obj.code === "string"
			? obj.code.toUpperCase()
			: typeof obj.reason === "string"
				? obj.reason.toUpperCase()
				: undefined;
	if (directCode && RETRYABLE_ERROR_CODES.has(directCode)) {
		return true;
	}

	const nestedCode =
		typeof nestedObj?.code === "string"
			? nestedObj.code.toUpperCase()
			: typeof nestedObj?.type === "string"
				? nestedObj.type.toUpperCase()
				: typeof nestedObj?.reason === "string"
					? nestedObj.reason.toUpperCase()
					: undefined;
	if (nestedCode && RETRYABLE_ERROR_CODES.has(nestedCode)) {
		return true;
	}

	const causeCode =
		typeof causeObj?.code === "string"
			? causeObj.code.toUpperCase()
			: typeof causeObj?.reason === "string"
				? causeObj.reason.toUpperCase()
				: undefined;
	if (causeCode && RETRYABLE_ERROR_CODES.has(causeCode)) {
		return true;
	}

	// Check HTTP status codes.
	if (typeof obj.status === "number" && RETRYABLE_STATUS_CODES.has(obj.status)) return true;
	if (typeof obj.statusCode === "number" && RETRYABLE_STATUS_CODES.has(obj.statusCode)) {
		return true;
	}
	if (typeof nestedObj?.status === "number" && RETRYABLE_STATUS_CODES.has(nestedObj.status)) {
		return true;
	}
	if (
		typeof nestedObj?.statusCode === "number" &&
		RETRYABLE_STATUS_CODES.has(nestedObj.statusCode)
	) {
		return true;
	}
	if (typeof causeObj?.status === "number" && RETRYABLE_STATUS_CODES.has(causeObj.status)) {
		return true;
	}
	if (typeof causeObj?.statusCode === "number" && RETRYABLE_STATUS_CODES.has(causeObj.statusCode)) {
		return true;
	}

	if (msgCandidates.some((msg) => RETRYABLE_PATTERNS.some((p) => msg.includes(p)))) {
		return true;
	}

	// Check user-defined custom retry rules from settings
	return matchesCustomRetryRules(obj, msgCandidates);
}

/** Match error against user-defined custom retry rules (AND within rule, OR across rules). */
export function matchesCustomRetryRules(
	obj: Record<string, unknown>,
	msgCandidates: string[],
): boolean {
	const rules = settings.agent.customRetryRules;
	if (!rules?.length) return false;

	const statusCodes = new Set<number>();
	for (const field of [obj, obj.error, obj.cause]) {
		if (field && typeof field === "object") {
			const f = field as Record<string, unknown>;
			if (typeof f.status === "number") statusCodes.add(f.status);
			if (typeof f.statusCode === "number") statusCodes.add(f.statusCode);
		}
	}

	const allText = msgCandidates.join(" ");

	for (const rule of rules) {
		if (rule.enabled === false) continue;
		let matched = true;
		let hasCondition = false;

		if (rule.domain) {
			hasCondition = true;
			if (!allText.includes(rule.domain.toLowerCase())) matched = false;
		}
		if (matched && rule.statusCode) {
			hasCondition = true;
			if (!statusCodes.has(rule.statusCode)) matched = false;
		}
		if (matched && rule.keyword) {
			hasCondition = true;
			if (!allText.includes(rule.keyword.toLowerCase())) matched = false;
		}

		if (hasCondition && matched) return true;
	}
	return false;
}
