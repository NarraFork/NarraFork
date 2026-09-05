import { stripErrorDisplayPrefix } from "@shared/retry-rule-keyword";
import {
	isTransientTlsHandshakeError,
	TRANSIENT_TLS_HANDSHAKE_CODE,
} from "../net/tls-transport-error";
import { settings } from "../settings";
import { StreamStaleError } from "../stream-timeout";
import type { ApiRequestDiagnostics } from "./types";

/**
 * Hard cap on retry attempts for auxiliary (non-primary) AI calls — summaries,
 * titles, reflections, web-fetch smart mode, etc. These background helpers
 * follow the user-configured retry policy but must never retry excessively,
 * even when the main agent loop is set to infinite (-1) or a very large value.
 */
export const AUXILIARY_MAX_RETRIES_CAP = 10;
/** Base delay for exponential backoff on auxiliary retries (ms). */
export const AUXILIARY_RETRY_BASE_MS = 3_000;
/** Maximum backoff delay for auxiliary retries (ms). */
export const AUXILIARY_RETRY_MAX_MS = 15_000;

/**
 * Resolve the retry count for auxiliary AI calls. Follows the user-configured
 * `agent.maxTransientRetries` (so custom retry preferences apply here too), but
 * is hard-capped at {@link AUXILIARY_MAX_RETRIES_CAP}: infinite (-1) and any
 * value above the cap collapse to the cap, while a smaller non-negative value is
 * honored verbatim (0 disables retries). Custom retry *rules* still decide
 * whether a given error is retryable via {@link isRetryableError}; this only
 * bounds the *number* of attempts.
 */
export function getAuxiliaryMaxRetries(rawMax = settings.agent.maxTransientRetries): number {
	if (typeof rawMax !== "number" || !Number.isFinite(rawMax)) return AUXILIARY_MAX_RETRIES_CAP;
	if (rawMax < 0) return AUXILIARY_MAX_RETRIES_CAP;
	return Math.min(Math.floor(rawMax), AUXILIARY_MAX_RETRIES_CAP);
}

/** Exponential backoff delay for the given auxiliary retry attempt (0-indexed). */
export function auxiliaryRetryDelayMs(attempt: number): number {
	return Math.min(AUXILIARY_RETRY_BASE_MS * 2 ** attempt, AUXILIARY_RETRY_MAX_MS);
}

/** Patterns that indicate a transient API error worth retrying. */
const RETRYABLE_PATTERNS = [
	"MODEL_TEMPORARILY_UNAVAILABLE",
	"overload",
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
	"stream_read_error",
	"stream read error",
	"unable to connect",
	"the operation timed out",
	// A TLS handshake that failed without an attributable certificate defect —
	// a disturbed handshake (relay/VPN/interception), not a bad certificate.
	// Specific defects (CERT_HAS_EXPIRED, HOSTNAME_MISMATCH, ...) are deliberately
	// absent here so a real misconfiguration still fails fast.
	TRANSIENT_TLS_HANDSHAKE_CODE.toLowerCase(),
	"server_error",
	"internal_server_error",
	"the server had an error",
	"internal server error",
];

/**
 * 429 is only retryable by default when the message looks like rate limiting/load.
 *
 * Deliberately contains no bare `retry` / `retry-after` entry. A `Retry-After`
 * response header only says *when* a caller may try again — it says nothing about
 * the failure being transient, and hard quota responses carry it too (observed:
 * `retry-after: 374160`, i.e. 4.3 days, on a weekly-usage-limit 429). Matching the
 * header name turned that quota wall into an infinite retry loop. Phrases below
 * require the provider to actually be saying "try later"; a standalone `retry`
 * word is handled by {@link STANDALONE_RETRY_PATTERN}.
 */
const RETRYABLE_429_PATTERNS = [
	"overload",
	"overloaded",
	"capacity",
	"capacty",
	"too many requests",
	"rate limit",
	"throttl",
	"try again",
	"please retry",
	"retry later",
	// Trailing space keeps the `retry-after` / `retry_after` header name out.
	"retry after ",
	"retry in ",
];

/**
 * A standalone `retry` word. Hyphen/underscore neighbours are excluded so that
 * `retry-after` (header name), `retryable` (structured field name) and
 * `retryCount` (unrelated counter) are never mistaken for the upstream telling
 * us to try again.
 */
const STANDALONE_RETRY_PATTERN = /(?<![\w-])retry(?![\w-])/;

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
	"STREAM_READ_ERROR",
	// Bun-specific error codes (PascalCase instead of Node.js SCREAMING_SNAKE_CASE)
	"CONNECTIONREFUSED",
	"CONNECTIONRESET",
	"CONNECTIONABORTED",
	// See TRANSIENT_TLS_HANDSHAKE_CODE: an unattributable handshake failure, not a
	// certificate defect. Specific X509 codes stay out of this set on purpose.
	TRANSIENT_TLS_HANDSHAKE_CODE,
]);

/**
 * "The allowance is used up" wording family. Requires both a usage-limit noun and
 * a consumed verb, so a merely informational "usage limit: 1000/min" is not swept
 * in while every exhausted phrasing is:
 *
 *   Weekly usage limit reached / usage_limit_reached / usage limit has been
 *   reached / usage limit exceeded / monthly usage limit hit
 *
 * The literal-string list below could not express this: the observed opencode 429
 * says "Weekly usage limit reached" (space-separated, no "has been"), which
 * matched neither `usage_limit_reached` nor `usage limit has been reached`.
 * `reason: "GoUsageLimitError"` supplies only the noun half, so the verb is
 * matched across the combined reason+message text.
 */
const USAGE_LIMIT_PATTERN = /usage[\s_-]*limit/;
const USAGE_CONSUMED_PATTERN = /reach|exceed|exhaust|hit/;

function isHardUsageLimitText(text: string): boolean {
	return USAGE_LIMIT_PATTERN.test(text) && USAGE_CONSUMED_PATTERN.test(text);
}

const NON_RETRYABLE_PATTERNS = [
	"insufficient_quota",
	"quota exceeded",
	"exceeded your current quota",
	"check your plan and billing",
	"billing details",
	"payment required",
	"insufficient balance",
	"out of balance",
	"credit balance",
	'"plan_type":"free"',
];

/**
 * Whether text describes a hard quota/billing/allowance wall — never retryable,
 * regardless of status code or how "try again later" the rest of the response
 * sounds. Single entry point so every caller shares the usage-limit wording
 * family instead of only the literal patterns above.
 */
function isHardNonRetryableText(text: string): boolean {
	return (
		NON_RETRYABLE_PATTERNS.some((pattern) => text.includes(pattern)) || isHardUsageLimitText(text)
	);
}

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
	"exceeds the maximum number of tokens",
	"input token count exceeds",
	"maximum number of tokens allowed",
];

/**
 * HTTP server/gateway failures are transient by default, including the non-standard
 * Cloudflare-style 520-529 range used by many compatible API gateways.
 */
function isDefaultRetryableStatus(statusCode: number): boolean {
	return statusCode >= 500 && statusCode <= 599;
}

/** Reasons from invalidState that indicate a transient server-side issue worth retrying. */
const RETRYABLE_INVALID_STATE_REASONS = new Set([
	"server_error",
	"internal_error",
	"internal_server_error",
	"service_unavailable",
	"temporarily_unavailable",
	"resource_exhausted",
	"rate_limit_exceeded",
	"overloaded_error",
	"stream_closed_before_response_completed",
	"stream_read_error",
]);

const REFUSAL_REASONS = new Set(["refusal", "refused", "safety_refusal"]);
const CONTENT_FILTER_REASONS = new Set([
	"content_filter",
	"content_filtered",
	"content_filter_error",
	"safety",
	"prohibited_content",
]);

export type InvalidStateCategory =
	| "transient"
	| "completion_limit"
	| "context_overflow"
	| "refusal"
	| "content_filter"
	| "non_retryable";

export interface InvalidStateClassification {
	category: InvalidStateCategory;
	retryable: boolean;
	/**
	 * True when this error occurred after client-visible partial output was
	 * already produced AND is a transient failure — safe to resume with a
	 * continuation turn instead of retrying the whole request or treating it
	 * as terminal. Independent of `retryable`; a hard non-retryable
	 * classification (quota/refusal/content_filter) always vetoes this.
	 */
	resumable: boolean;
	statusCode?: number;
}

export interface ProviderInvalidStateErrorOptions {
	diagnostics?: ApiRequestDiagnostics;
	providerRetryable?: boolean;
}

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

/** Error codes / message fragments that indicate the TCP connection was closed/reset mid-request. */
const CONNECTION_CLOSED_CODES = new Set([
	"ECONNRESET",
	"EPIPE",
	"CONNECTIONRESET",
	"CONNECTIONABORTED",
	"UND_ERR_SOCKET",
]);
const CONNECTION_CLOSED_PATTERNS = [
	"socket connection was closed unexpectedly",
	"connection was closed unexpectedly",
	"socket hang up",
	"connection reset",
	"econnreset",
];

/**
 * Detect whether an error represents the connection being closed/reset before a
 * response was received (as opposed to an HTTP error response). Used to trigger
 * the `/v1` base-URL fallback: when a gateway RSTs a large request on a wrong
 * path, `fetch()` throws instead of returning a non-ok response, so the normal
 * status-based fallback never runs.
 */
export function isConnectionClosedError(err: unknown): boolean {
	if (err && typeof err === "object") {
		const code = (err as { code?: unknown }).code;
		if (typeof code === "string" && CONNECTION_CLOSED_CODES.has(code.toUpperCase())) {
			return true;
		}
		const cause = (err as { cause?: unknown }).cause;
		if (cause && cause !== err && isConnectionClosedError(cause)) return true;
	}
	const message = extractErrorMessage(err).toLowerCase();
	if (!message) return false;
	return CONNECTION_CLOSED_PATTERNS.some((p) => message.includes(p));
}

function numericStatus(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
}

function collectStatusCodes(obj: Record<string, unknown>): Set<number> {
	const statusCodes = new Set<number>();
	for (const field of [obj, obj.error, obj.cause, obj.response]) {
		if (field && typeof field === "object") {
			const f = field as Record<string, unknown>;
			const status = numericStatus(f.status);
			const statusCode = numericStatus(f.statusCode);
			if (status) statusCodes.add(status);
			if (statusCode) statusCodes.add(statusCode);
		}
	}
	return statusCodes;
}

function safeSerializeForMatching(value: unknown): string | undefined {
	const seen = new WeakSet<object>();
	try {
		const serialized = JSON.stringify(value, (_key, current) => {
			if (!current || typeof current !== "object") return current;
			if (seen.has(current)) return "[Circular]";
			seen.add(current);
			if (current instanceof Error) {
				const result: Record<string, unknown> = {
					name: current.name,
					message: current.message,
				};
				for (const prop of Object.getOwnPropertyNames(current)) {
					if (prop === "stack") continue;
					result[prop] = (current as unknown as Record<string, unknown>)[prop];
				}
				return result;
			}
			return current;
		});
		return serialized ? serialized.slice(0, 50_000) : undefined;
	} catch {
		return undefined;
	}
}

function has429Message(message: string): boolean {
	return /\b429\b/.test(message);
}

/** Whether text carries a genuine rate-limit/load signal (see RETRYABLE_429_PATTERNS). */
function hasRateLimitSignal(text: string): boolean {
	return (
		RETRYABLE_429_PATTERNS.some((pattern) => text.includes(pattern)) ||
		STANDALONE_RETRY_PATTERN.test(text)
	);
}

function isRetryable429Message(message: string): boolean {
	return has429Message(message) && hasRateLimitSignal(message);
}

function hasRetryable429(statusCodes: Set<number>, msgCandidates: string[]): boolean {
	return statusCodes.has(429) && msgCandidates.some(hasRateLimitSignal);
}

function inferInvalidStateStatus(
	reason: string,
	diagnostics?: Pick<ApiRequestDiagnostics, "statusCode">,
): number | undefined {
	const explicit = numericStatus(diagnostics?.statusCode);
	if (explicit != null) return explicit;
	const fromReason = numericStatus(reason);
	if (fromReason != null) return fromReason;
	const normalized = reason.toLowerCase();
	if (normalized === "resource_exhausted" || normalized.includes("rate_limit")) return 429;
	return undefined;
}

function isRefusalReason(reason: string): boolean {
	const normalized = reason.toLowerCase().replace(/[-\s]/g, "_");
	return REFUSAL_REASONS.has(normalized) || normalized.endsWith("_refusal");
}

function isContentFilterReason(reason: string): boolean {
	const normalized = reason.toLowerCase().replace(/[-\s]/g, "_");
	return (
		CONTENT_FILTER_REASONS.has(normalized) ||
		normalized.includes("content_filter") ||
		normalized.includes("prohibited_content")
	);
}

function isRefusalMessage(message: string): boolean {
	return /\b(refused|refusal|usage policy)\b/i.test(message);
}

function isContentFilterMessage(message: string): boolean {
	return /content[_ ]filter|blocked by (?:a )?(?:safety|content) filter|prohibited content/i.test(
		message,
	);
}

export function classifyInvalidState(
	reason: string,
	message?: string,
	diagnostics?: Pick<ApiRequestDiagnostics, "statusCode" | "retryable" | "resumable">,
	customRetryRules = settings.agent.customRetryRules,
	providerRetryable?: boolean,
): InvalidStateClassification {
	const normalizedReason = reason.toLowerCase().trim();
	const normalizedMessage = message?.toLowerCase() ?? "";
	const statusCode = inferInvalidStateStatus(reason, diagnostics);
	// Literal patterns are matched per-field (a pattern never spans reason+message),
	// but the usage-limit family legitimately splits across the two: opencode sends
	// reason `GoUsageLimitError` (noun) with message "Weekly usage limit reached"
	// (verb), so it is also matched against the joined text.
	const hardNonRetryable =
		NON_RETRYABLE_PATTERNS.some(
			(pattern) => normalizedMessage.includes(pattern) || normalizedReason.includes(pattern),
		) || isHardUsageLimitText(`${normalizedReason} ${normalizedMessage}`);
	// The provider/gateway explicitly flagged this failure as safe to resume
	// with a continuation turn (partial output was already produced). Any
	// hard non-retryable classification below (quota, refusal, content
	// filter, completion/context limits) still vetoes this — those are never
	// safe to blindly continue past.
	const providerResumable = diagnostics?.resumable === true;

	if (isCompletionLimitReason(normalizedReason)) {
		return { category: "completion_limit", retryable: false, resumable: false, statusCode };
	}
	if (isContextOverflowReason(normalizedReason) || isContextOverflowMessage(normalizedMessage)) {
		return { category: "context_overflow", retryable: false, resumable: false, statusCode };
	}
	if (isRefusalReason(normalizedReason)) {
		return { category: "refusal", retryable: false, resumable: false, statusCode };
	}
	if (isContentFilterReason(normalizedReason) || isContentFilterMessage(normalizedMessage)) {
		return { category: "content_filter", retryable: false, resumable: false, statusCode };
	}
	if (hardNonRetryable) {
		return { category: "non_retryable", retryable: false, resumable: false, statusCode };
	}

	// An executable-plugin provider may explicitly classify its own error. A hard
	// quota/billing message above still vetoes an optimistic plugin classification.
	if (providerRetryable === false || diagnostics?.retryable === false) {
		// A user-authored rule is an explicit override and outranks the provider's
		// own "do not retry" verdict — that is the entire point of adding one by
		// hand. Hard quota/billing/refusal/limit failures were already returned
		// above, so this can only flip a soft provider judgement.
		//
		// An explicitly resumable failure is exempt: partial output was already
		// produced, so the loop's continuation path is both safer and strictly more
		// recovery than a retry would be. Replaying the whole request instead could
		// duplicate visible output, and `retryable`/`resumable` are mutually
		// exclusive in this classification.
		if (
			!providerResumable &&
			matchesCustomRetryRules(
				{ reason, message, status: statusCode },
				[normalizedReason, normalizedMessage].filter(Boolean),
				statusCode ? new Set([statusCode]) : undefined,
				customRetryRules,
			)
		) {
			return { category: "transient", retryable: true, resumable: false, statusCode };
		}
		return {
			category: "non_retryable",
			retryable: false,
			resumable: providerResumable,
			statusCode,
		};
	}
	if (providerRetryable === true || diagnostics?.retryable === true) {
		return { category: "transient", retryable: true, resumable: false, statusCode };
	}

	// Server-side 5xx responses are transient by status, without requiring a
	// provider-specific message. 429 remains message/rule-sensitive unless the
	// provider uses the canonical resource-exhausted/rate-limit reason.
	if (statusCode != null && isDefaultRetryableStatus(statusCode)) {
		return { category: "transient", retryable: true, resumable: false, statusCode };
	}
	if (RETRYABLE_INVALID_STATE_REASONS.has(normalizedReason)) {
		return { category: "transient", retryable: true, resumable: false, statusCode };
	}

	const candidates = [normalizedReason, normalizedMessage].filter(Boolean);
	const combined = candidates.join(" ");
	if (statusCode === 429 || has429Message(combined)) {
		if (
			isRetryable429Message(combined) ||
			normalizedReason === "resource_exhausted" ||
			normalizedReason === "rate_limit_exceeded"
		) {
			return { category: "transient", retryable: true, resumable: false, statusCode: 429 };
		}
		const obj: Record<string, unknown> = { reason, message, status: statusCode };
		if (
			matchesCustomRetryRules(
				obj,
				candidates,
				statusCode ? new Set([statusCode]) : undefined,
				customRetryRules,
			)
		) {
			return { category: "transient", retryable: true, resumable: false, statusCode };
		}
		return {
			category: "non_retryable",
			retryable: false,
			resumable: providerResumable,
			statusCode,
		};
	}

	// Text-only refusal detection is deliberately narrow and lower priority than
	// structured retryability, retryable reasons, and HTTP 429/5xx diagnostics.
	if (isRefusalMessage(normalizedMessage)) {
		return { category: "refusal", retryable: false, resumable: false, statusCode };
	}

	if (
		RETRYABLE_PATTERNS.some(
			(pattern) => normalizedMessage.includes(pattern) || normalizedReason.includes(pattern),
		) ||
		/\b5\d\d\b/.test(combined)
	) {
		return { category: "transient", retryable: true, resumable: false, statusCode };
	}

	const obj: Record<string, unknown> = { reason, message, status: statusCode };
	const retryableByRule = matchesCustomRetryRules(
		obj,
		candidates,
		statusCode ? new Set([statusCode]) : undefined,
		customRetryRules,
	);
	return {
		category: retryableByRule ? "transient" : "non_retryable",
		retryable: retryableByRule,
		resumable: !retryableByRule && providerResumable,
		statusCode,
	};
}

export function isRetryableInvalidStateReason(
	reason: string,
	message?: string,
	customRetryRules = settings.agent.customRetryRules,
	providerRetryable?: boolean,
): boolean {
	return classifyInvalidState(reason, message, undefined, customRetryRules, providerRetryable)
		.retryable;
}

export class ProviderInvalidStateError extends Error {
	readonly reason: string;
	readonly classification: InvalidStateCategory;
	readonly retryable: boolean;
	/** See {@link InvalidStateClassification.resumable}. */
	readonly resumable: boolean;
	readonly diagnostics?: ApiRequestDiagnostics;
	readonly status?: number;
	readonly code: string;

	constructor(reason: string, message: string, options: ProviderInvalidStateErrorOptions = {}) {
		super(message);
		this.name = "ProviderInvalidStateError";
		this.reason = reason;
		this.diagnostics = options.diagnostics;
		const classification = classifyInvalidState(
			reason,
			message,
			options.diagnostics,
			settings.agent.customRetryRules,
			options.providerRetryable,
		);
		this.classification = classification.category;
		this.retryable = classification.retryable;
		this.resumable = classification.resumable;
		this.status = classification.statusCode;
		this.code = reason;
	}
}

export function isContextOverflowReason(reason: string): boolean {
	const r = reason.toLowerCase().replace(/[-\s]/g, "_");
	return (
		r.includes("context_length") ||
		r.includes("context_window") ||
		r === "input_too_long" ||
		r === "prompt_too_long" ||
		r === "context_overflow"
	);
}

export function isCompletionLimitReason(reason: string): boolean {
	const r = reason.toLowerCase().replace(/[-\s]/g, "_");
	return r === "max_tokens" || r === "max_output_tokens" || r === "length";
}

export function isContextOverflowMessage(message: string): boolean {
	const m = message.toLowerCase();
	return CONTEXT_OVERFLOW_PATTERNS.some((p) => m.includes(p));
}

export function isContextWindowExceededError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const obj = err as Record<string, unknown>;
	const diagnostics =
		obj.diagnostics && typeof obj.diagnostics === "object"
			? (obj.diagnostics as Record<string, unknown>)
			: undefined;
	const nested =
		obj.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : undefined;

	if (obj.classification === "completion_limit") return false;
	if (obj.classification === "context_overflow") return true;

	// A structured stop reason is authoritative. In particular, max_tokens may carry
	// provider text such as "maximum number of tokens allowed", which also resembles
	// an input-context error and must not be reclassified by the message fallback.
	for (const reason of [
		obj.reason,
		obj.code,
		diagnostics?.reason,
		nested?.reason,
		nested?.code,
		nested?.type,
	]) {
		if (typeof reason !== "string") continue;
		if (isCompletionLimitReason(reason)) return false;
		if (isContextOverflowReason(reason)) return true;
	}

	for (const message of [obj.message, obj.error, diagnostics?.message, nested?.message]) {
		if (typeof message === "string" && isContextOverflowMessage(message)) return true;
	}

	return false;
}

export interface PaymentRequiredErrorInfo {
	balance?: number;
	required?: number;
	message: string;
}

function parseEmbeddedJSON(message: string): Record<string, unknown> | null {
	const start = message.indexOf("{");
	const end = message.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(message.slice(start, end + 1));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function numberField(obj: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = obj?.[key];
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) ? n : undefined;
}

export function getPaymentRequiredErrorInfo(err: unknown): PaymentRequiredErrorInfo | null {
	const message = extractErrorMessage(err);
	const lower = message.toLowerCase();
	const statusCodes =
		err && typeof err === "object"
			? collectStatusCodes(err as Record<string, unknown>)
			: new Set<number>();
	const looksLikePaymentRequired =
		statusCodes.has(402) ||
		lower.includes("insufficient_quota") ||
		lower.includes("insufficient quota") ||
		lower.includes("payment required");
	if (!looksLikePaymentRequired) return null;

	const parsed = parseEmbeddedJSON(message);
	const parsedError = parsed?.error;
	const errorObj =
		parsedError && typeof parsedError === "object" && !Array.isArray(parsedError)
			? (parsedError as Record<string, unknown>)
			: undefined;
	return {
		message,
		balance: numberField(errorObj, "balance"),
		required: numberField(errorObj, "required"),
	};
}

/**
 * Whether a thrown error represents a transient failure that occurred after
 * client-visible partial output was already produced — safe to resume with a
 * continuation turn rather than retrying the whole request or surfacing a
 * terminal failure. Unlike {@link isRetryableError}, this deliberately does
 * NOT fall back to broad message/status heuristics: `resumable` is only
 * meaningful when a provider/gateway explicitly said so (it is a much
 * stronger claim — the request already had visible side effects — so guessing
 * from generic patterns is not safe here).
 */
export function isResumableError(err: unknown): boolean {
	if (err instanceof ProviderInvalidStateError) return err.resumable;
	if (!err || typeof err !== "object") return false;
	const obj = err as Record<string, unknown>;
	if (typeof obj.resumable === "boolean") return obj.resumable;
	const diagnostics =
		obj.diagnostics && typeof obj.diagnostics === "object"
			? (obj.diagnostics as Partial<ApiRequestDiagnostics>)
			: undefined;
	return diagnostics?.resumable === true;
}

/**
 * Precise message fragments that indicate the NUG gateway (or its channels)
 * has NO usable credential for the requested model — a *recoverable*
 * exhaustion: the model's whole credential pool is currently disabled, but it
 * recovers automatically once a credential is re-enabled/added. This is
 * deliberately narrow so ordinary transient upstream blips (generic 503,
 * timeouts) are NOT misread as "all credentials dead" — those must keep going
 * through the normal transient-retry path, not the suspend-and-wait path.
 */
const MODEL_UNAVAILABLE_PATTERNS = [
	"no available credentials",
	"no available api keys",
	"no healthy nodes",
	"model upstream unavailable",
	"all credentials exhausted",
];

/**
 * Whether an error means the requested model is temporarily unavailable at the
 * gateway because its entire credential pool is disabled (recoverable
 * exhaustion). When true and the provider is NUG, the agent loop suspends the
 * turn and waits for the model to recover via the shared availability poller
 * instead of retrying the full request (with its whole history) over and over.
 *
 * Detection is intentionally strict: it requires an explicit
 * upstream-unavailable signal (a `diagnostics.reason` phrase or a precise
 * message phrase), never a bare 5xx/503. Hard non-retryable failures (quota/
 * billing/payment, refusal, content filter, context overflow) are excluded —
 * those must still surface as errors, not silent waits.
 */
export function isModelUnavailableError(err: unknown): boolean {
	if (err == null) return false;

	// Collect candidate messages + structured diagnostics from the error graph.
	const messages: string[] = [];
	let diagnostics: Partial<ApiRequestDiagnostics> | undefined;

	if (typeof err === "object") {
		const obj = err as Record<string, unknown>;
		diagnostics =
			obj.diagnostics && typeof obj.diagnostics === "object"
				? (obj.diagnostics as Partial<ApiRequestDiagnostics>)
				: undefined;
		const nested = obj.error;
		const nestedObj =
			nested && typeof nested === "object" ? (nested as Record<string, unknown>) : undefined;
		for (const m of [
			obj.message,
			typeof obj.error === "string" ? obj.error : undefined,
			nestedObj?.message,
			diagnostics?.message,
			diagnostics?.responseSnippet,
			diagnostics?.reason,
		]) {
			if (typeof m === "string" && m) messages.push(m.toLowerCase());
		}
	} else {
		messages.push(extractErrorMessage(err).toLowerCase());
	}

	const combined = messages.join(" ");

	// Never treat hard quota/billing/payment failures as a recoverable wait.
	if (isHardNonRetryableText(combined)) return false;

	// Structured signal from the gateway: an explicit upstream-unavailable
	// `reason`. This is normalized from the gateway/channel error envelope by
	// `parseErrorDiagnostics` (data.reason / nested.type / code), so it survives
	// `normalizeApiRequestDiagnostics` unlike ad-hoc fields.
	const reason = (diagnostics?.reason ?? "").toLowerCase();
	if (
		reason.includes("upstream_unavailable") ||
		reason.includes("no_credential") ||
		reason.includes("model_upstream_unavailable")
	) {
		return true;
	}

	// Precise message-phrase fallback (covers HTTP body text from the gateway).
	// A 402/payment path is already excluded above; require an explicit phrase
	// rather than a bare status code so generic 5xx blips are not swept in.
	if (MODEL_UNAVAILABLE_PATTERNS.some((p) => combined.includes(p))) {
		// A 503 alongside the phrase is expected (gateway returns 503 for
		// ErrModelUpstreamUnavailable); a 402/insufficient path was already
		// filtered out. No extra status gating needed here.
		return true;
	}

	return false;
}

/**
 * Phrases an endpoint uses to say "you may not turn reasoning off".
 *
 * Observed: `Anthropic API error 400: Reasoning is mandatory for this endpoint
 * and cannot be disabled.` Some gateways only serve reasoning-enabled traffic,
 * so an explicit `thinking: {type:"disabled"}` / `reasoning_effort: "none"` is a
 * hard 400 there — including on auxiliary calls (titles, summaries) which
 * deliberately ask for no reasoning to stay cheap.
 *
 * Kept to explicit "mandatory / cannot be disabled" wording. A looser rule (any
 * 400 mentioning reasoning) would also swallow genuine parameter errors, and the
 * caller's response to a match is to silently re-send with reasoning ON — the
 * opposite of what the user configured, so a false positive here is a silent
 * cost increase rather than a visible failure.
 */
const REASONING_MANDATORY_PATTERNS = [
	"reasoning is mandatory",
	"thinking is mandatory",
	"reasoning cannot be disabled",
	"thinking cannot be disabled",
	"reasoning can not be disabled",
	"thinking can not be disabled",
	"cannot disable reasoning",
	"cannot disable thinking",
	"reasoning is required for this",
	"thinking is required for this",
];

/** Collect human-readable provider text from an error graph (bounded depth). */
function errorTextCandidates(err: unknown): string[] {
	if (err == null) return [];
	if (typeof err !== "object") return [extractErrorMessage(err).toLowerCase()];
	const obj = err as Record<string, unknown>;
	const nested =
		obj.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : undefined;
	const cause =
		obj.cause && typeof obj.cause === "object" ? (obj.cause as Record<string, unknown>) : undefined;
	const diagnostics =
		obj.diagnostics && typeof obj.diagnostics === "object"
			? (obj.diagnostics as Partial<ApiRequestDiagnostics>)
			: undefined;
	return [
		obj.message,
		typeof obj.error === "string" ? obj.error : undefined,
		nested?.message,
		cause?.message,
		diagnostics?.message,
		diagnostics?.responseSnippet,
		diagnostics?.reason,
	]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.map((value) => value.toLowerCase());
}

/**
 * Whether the upstream rejected the request specifically because reasoning was
 * switched off. Callers that force `reasoningEffort: "none"` use this to re-send
 * with a minimal reasoning tier instead of failing (see the auxiliary generate
 * paths in `agent/index.ts`).
 */
export function isReasoningMandatoryError(err: unknown): boolean {
	return errorTextCandidates(err).some((text) =>
		REASONING_MANDATORY_PATTERNS.some((pattern) => text.includes(pattern)),
	);
}

export function isRetryableError(
	err: unknown,
	customRetryRules = settings.agent.customRetryRules,
): boolean {
	// Stream stale timeout is always retryable
	if (err instanceof StreamStaleError) return true;
	if (err instanceof ProviderInvalidStateError) return err.retryable;
	if (!err || typeof err !== "object") {
		const message = extractErrorMessage(err).toLowerCase();
		if (!message) return false;
		const primitiveClassification = classifyInvalidState("", message, undefined, customRetryRules);
		if (primitiveClassification.category !== "non_retryable") {
			return primitiveClassification.retryable;
		}
		if (isHardNonRetryableText(message)) return false;
		if (isRetryable429Message(message)) return true;
		if (RETRYABLE_PATTERNS.some((p) => message.includes(p))) return true;
		if (/\b5\d\d\b/.test(message)) return true;
		return matchesCustomRetryRules({ message }, [message], undefined, customRetryRules);
	}

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
		safeSerializeForMatching(obj),
	]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.map((value) => value.toLowerCase());
	const statusCodes = collectStatusCodes(obj);
	const diagnostics =
		obj.diagnostics && typeof obj.diagnostics === "object"
			? (obj.diagnostics as Partial<ApiRequestDiagnostics>)
			: undefined;

	/**
	 * Human-readable provider text only — no serialized object blob.
	 *
	 * The built-in retry heuristics must judge what the provider *said*, not the
	 * shape of the error object. `msgCandidates` above deliberately includes the
	 * whole serialized error so user-authored keyword rules can reach nested
	 * fields, but feeding that blob to the 429 heuristic made field and header
	 * NAMES act as upstream signals: a `retry-after` response header (present on
	 * hard quota walls, observed at 374160s ≈ 4.3 days) matched the rate-limit
	 * keyword list and turned a weekly-usage-limit 429 into an infinite retry
	 * loop. `retryable: false` and an unrelated `retryCount` field had the same
	 * effect. Custom rules keep the full candidate list; heuristics get this one.
	 */
	const narrowCandidates = [
		obj.message,
		typeof obj.error === "string" ? obj.error : undefined,
		nestedObj?.message,
		typeof nestedObj?.error === "string" ? nestedObj.error : undefined,
		causeObj?.message,
		typeof causeObj?.error === "string" ? causeObj.error : undefined,
		diagnostics?.message,
		diagnostics?.responseSnippet,
		diagnostics?.reason,
	]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.map((value) => value.toLowerCase());

	const invalidStateReason =
		typeof obj.reason === "string"
			? obj.reason
			: typeof diagnostics?.reason === "string"
				? diagnostics.reason
				: undefined;
	if (invalidStateReason) {
		const classification = classifyInvalidState(
			invalidStateReason,
			narrowCandidates.join(" "),
			diagnostics,
			customRetryRules,
			typeof obj.retryable === "boolean" ? obj.retryable : diagnostics?.retryable,
		);
		if (
			classification.category === "completion_limit" ||
			classification.category === "context_overflow" ||
			classification.category === "refusal" ||
			classification.category === "content_filter" ||
			isCompletionLimitReason(invalidStateReason) ||
			isContextOverflowReason(invalidStateReason) ||
			isRefusalReason(invalidStateReason) ||
			isContentFilterReason(invalidStateReason)
		) {
			return false;
		}
		if (classification.category !== "non_retryable") return classification.retryable;
	}

	// Message-based hard quota / plan restrictions should never retry. Matched
	// against the joined narrow text too, since the usage-limit wording family can
	// split its noun and verb across `reason` and `message`.
	if (
		msgCandidates.some(isHardNonRetryableText) ||
		isHardUsageLimitText(narrowCandidates.join(" "))
	) {
		return false;
	}

	// Preserve an explicit provider decision before any generic status/code heuristic.
	// In particular, a thrown vendor error may expose only `retryable: false` plus a
	// top-level 503; allowing the status fallback to run would incorrectly retry it.
	const structuredRetryable =
		typeof obj.retryable === "boolean"
			? obj.retryable
			: typeof diagnostics?.retryable === "boolean"
				? diagnostics.retryable
				: typeof nestedObj?.retryable === "boolean"
					? nestedObj.retryable
					: typeof causeObj?.retryable === "boolean"
						? causeObj.retryable
						: undefined;
	if (structuredRetryable === true) return true;
	if (structuredRetryable === false) {
		// A hand-written rule is a deliberate user override and outranks the
		// provider's "do not retry". Hard quota/billing patterns already returned
		// above, so only a soft provider judgement can be flipped here. An
		// explicitly resumable failure stays out of it: the loop continues from the
		// partial output it already produced, which beats replaying the request.
		if (isResumableError(err)) return false;
		return matchesCustomRetryRules(obj, msgCandidates, statusCodes, customRetryRules);
	}

	// Check for known retryable reason/code fields.
	if (obj.reason === "MODEL_TEMPORARILY_UNAVAILABLE") {
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

	// The code checks above only reach two levels of nesting. A transport-level
	// handshake failure can sit deeper once a provider wraps it, so scan the whole
	// bounded cause chain for the one TLS code that is transient rather than a
	// certificate misconfiguration.
	if (isTransientTlsHandshakeError(err)) return true;

	// Check HTTP status codes. 429 needs a rate-limit/load keyword to avoid retrying billing/quota failures;
	// every 5xx status is treated as a transient upstream failure.
	//
	// The 429 keyword checks read `narrowCandidates`, never the serialized blob: a
	// `retry-after` header or a `retryable` field name is not the upstream saying
	// "try again later". A plain 429 still falls through to custom rules, which do
	// see the full candidate list.
	if ([...statusCodes].some(isDefaultRetryableStatus)) return true;
	if (hasRetryable429(statusCodes, narrowCandidates)) return true;
	if (narrowCandidates.some(isRetryable429Message)) return true;
	// Plain 429 errors must not fall through to broader transient keywords. Detection
	// stays broad (a 429 buried anywhere in the error still counts as a 429) while the
	// retryable signal above stays narrow — narrowing detection instead would let a
	// deeply-nested 429 reach RETRYABLE_PATTERNS and be retried for the wrong reason.
	if (statusCodes.has(429) || msgCandidates.some(has429Message)) {
		return matchesCustomRetryRules(obj, msgCandidates, statusCodes, customRetryRules);
	}

	if (msgCandidates.some((msg) => RETRYABLE_PATTERNS.some((p) => msg.includes(p)))) {
		return true;
	}

	// Check user-defined custom retry rules from settings
	return matchesCustomRetryRules(obj, msgCandidates, statusCodes, customRetryRules);
}

/** Match error against user-defined custom retry rules (AND within rule, OR across rules). */
export function matchesCustomRetryRules(
	obj: Record<string, unknown>,
	msgCandidates: string[],
	statusCodesArg?: Set<number>,
	rules = settings.agent.customRetryRules,
): boolean {
	if (!rules?.length) return false;

	const statusCodes = statusCodesArg ?? collectStatusCodes(obj);

	const allText = msgCandidates.join(" ").toLowerCase();

	for (const rule of rules) {
		if (rule.enabled === false) continue;
		let matched = true;
		let hasCondition = false;

		// Keywords are routinely copied out of the rendered error card, which carries
		// a `[Error] ` / `Error: ` display prefix that never exists in the raw provider
		// message this matcher searches. Strip it so such a rule can match at all
		// (see shared/retry-rule-keyword.ts).
		const domain = stripErrorDisplayPrefix(rule.domain ?? "").toLowerCase();
		const keyword = stripErrorDisplayPrefix(rule.keyword ?? "").toLowerCase();
		if (domain) {
			hasCondition = true;
			if (!allText.includes(domain)) matched = false;
		}
		if (matched && rule.statusCode) {
			hasCondition = true;
			if (!statusCodes.has(rule.statusCode)) matched = false;
		}
		if (matched && keyword) {
			hasCondition = true;
			if (!allText.includes(keyword)) matched = false;
		}

		if (hasCondition && matched) return true;
	}
	return false;
}
