import { isCapacityRefusalText } from "@shared/agent-protocol/quota-exhausted";
import type { ApiRequestDiagnostics } from "@shared/agent-protocol/types";
import { isHardUsageLimitText } from "./agent/error-handling";
import { parseRetryAfterMs } from "./agent/retry-after";
import { logger } from "./logger";
import {
	getOpencodeCachedUsage,
	isOpencodeCustomApiProvider,
	OPENCODE_USAGES_STALE_MS,
	type OpencodeUsagePayload,
	type OpencodeUsageWindow,
	refreshOpencodeUsage,
} from "./opencode-usage-cache";
import { settings } from "./settings";

/**
 * Wake-up timing for an OpenCode Go refusal.
 *
 * OpenCode Go meters each model against three windows: a 5-hour rolling window
 * (20% of the monthly allowance), a week starting Monday 00:00 UTC (50%) and the
 * subscription month (100%). Once one is spent the gateway answers
 *
 *   429 { "error": { "type": "GoUsageLimitError",
 *                    "message": "Weekly usage limit reached. Resets in 4 days. …" } }
 *
 * usually with a `retry-after` header (observed: `374160`, ≈4.3 days). The same
 * body comes back from both roots: `/zen/go/v1/*` only proxies to
 * `/inference/go/*`, which owns quota accounting. Only the envelope differs by
 * wire family — `{ error }` for OpenAI-style routes, `{ type: "error", error }`
 * for `/messages`, `{ error: { code, status } }` for the Gemini route — and the
 * providers already normalize all three into `diagnostics.reason`/`message`.
 *
 * Two refusals are recoverable here and handled differently:
 *
 *  - quota wall (`GoUsageLimitError`, "usage limit reached"): the reset instant is
 *    resolved from, in order, the `retry-after` family of headers, the account's
 *    `GET …/usage` windows (cached; at most one refresh), the "Resets in …" text,
 *    and finally the documented window rule. The turn is parked until then.
 *  - rate limit (`FreeUsageLimitError` and plain 429 throttling): only parked when
 *    the upstream named a wait of at least {@link OPENCODE_RATE_LIMIT_SUSPEND_MIN_MS};
 *    shorter or absent hints stay with the in-loop transient retry.
 *
 * Billing walls (`CreditLimitExceeded`, 402, insufficient balance) are NOT
 * recoverable on a schedule and keep their terminal handling.
 */

/** Added to the reset instant before waking, absorbing clock skew. */
export const OPENCODE_QUOTA_RESET_SKEW_MS = 5_000;

/**
 * Longest wait this path accepts. Eight days covers a weekly window from any
 * point in the week (the wall that actually recurs on Go) with slack for skew;
 * a monthly reset further out than that is reported with its instant instead.
 */
export const OPENCODE_QUOTA_MAX_WAIT_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * A rate-limit hint shorter than this is left to the in-loop retry, whose
 * 5s→20s backoff already spans it. Suspending would cost a status flip and a
 * notification for a few seconds of waiting.
 */
export const OPENCODE_RATE_LIMIT_SUSPEND_MIN_MS = 30_000;

/** Length of the rolling window; also the upper bound of its reset. */
const ROLLING_WINDOW_MS = 5 * 60 * 60 * 1000;

export type OpencodeQuotaBucket =
	| "fiveHour"
	| "weekly"
	| "monthly"
	| "rateLimit"
	| "capacity"
	| "other";

/** Where a resolved reset instant came from, for logs. */
export type OpencodeResetSource = "retry-after" | "usage" | "message" | "window-rule";

export type OpencodeRefusalKind = "quota" | "rate_limit" | "capacity";

export interface OpencodeQuotaTarget {
	bucket: OpencodeQuotaBucket;
	/** The reset instant as published upstream (no skew applied). */
	resetAt: number;
	source: OpencodeResetSource;
}

export interface OpencodeQuotaWaitTarget extends OpencodeQuotaTarget {
	/** Epoch ms at which the turn may be replayed (`resetAt` + skew). */
	resumeAt: number;
	delayMs: number;
}

/** A refusal understood but not parked on; `resetAt` is absent when unknown. */
export interface OpencodeQuotaRefusalTarget {
	bucket: OpencodeQuotaBucket;
	resetAt?: number;
	waitMs?: number;
}

const BILLING_PATTERNS = [
	"creditlimitexceeded",
	"credit limit exceeded",
	"insufficient account funds",
	"insufficient balance",
	"invoice is overdue",
	"payment required",
];

const QUOTA_CODES = ["gousagelimiterror", "subscriptionusagelimiterror"];
const RATE_LIMIT_CODES = ["freeusagelimiterror", "ratelimiterror", "rate_limit_exceeded"];

function refusalText(errorText: string, diagnostics?: ApiRequestDiagnostics): string {
	return [
		errorText,
		diagnostics?.reason,
		diagnostics?.errorType,
		typeof diagnostics?.code === "string" ? diagnostics.code : undefined,
		diagnostics?.message,
		diagnostics?.responseSnippet,
	]
		.filter((part): part is string => typeof part === "string" && part.length > 0)
		.join("\n")
		.toLowerCase();
}

/**
 * Classify an OpenCode Go refusal. The caller has already established that the
 * provider is a Go endpoint, so this only reads the wording and status.
 */
export function classifyOpencodeRefusal(
	errorText: string,
	diagnostics?: ApiRequestDiagnostics,
): OpencodeRefusalKind | null {
	const text = refusalText(errorText, diagnostics);
	if (!text) return null;
	if (diagnostics?.statusCode === 402) return null;
	if (BILLING_PATTERNS.some((pattern) => text.includes(pattern))) return null;
	// Typed codes before wording: `FreeUsageLimitError` itself contains
	// "usagelimit" and its message says "limit exceeded", which the generic
	// usage-limit wording below would read as a plan wall.
	if (QUOTA_CODES.some((code) => text.includes(code))) return "quota";
	if (isCapacityRefusalText(text)) return "capacity";
	if (RATE_LIMIT_CODES.some((code) => text.includes(code))) return "rate_limit";
	if (isHardUsageLimitText(text) || /go usage limit/.test(text)) return "quota";
	if (
		diagnostics?.statusCode === 429 ||
		/\b429\b/.test(text) ||
		/rate[-_\s]?limit|too many requests/.test(text)
	) {
		return "rate_limit";
	}
	return null;
}

/** Which window the refusal names ("Weekly usage limit reached", …). */
export function opencodeBucketNamedByText(text: string): OpencodeQuotaBucket | null {
	const lower = text.toLowerCase();
	const patterns: Array<[OpencodeQuotaBucket, RegExp]> = [
		["fiveHour", /rolling|5\s*[-\s]?\s*(?:hour|h\b)|five[-\s]?hour|5\s*小时/],
		["weekly", /week|7\s*[-\s]?day|周/],
		["monthly", /month|月/],
	];
	let best: { bucket: OpencodeQuotaBucket; index: number } | null = null;
	for (const [bucket, pattern] of patterns) {
		const match = pattern.exec(lower);
		if (match && (!best || match.index < best.index)) best = { bucket, index: match.index };
	}
	return best?.bucket ?? null;
}

const TEXT_UNIT_MS: Array<[RegExp, number]> = [
	[/^(?:d|days?)$/, 86_400_000],
	[/^(?:h|hrs?|hours?)$/, 3_600_000],
	[/^(?:m|mins?|minutes?)$/, 60_000],
	[/^(?:s|secs?|seconds?)$/, 1_000],
];

/**
 * The reset instant the refusal text states, if any:
 * "Resets in 4 days", "resets in 2h 15m", "resets at 2026-10-20T00:00:00Z".
 *
 * Coarse on purpose: these phrases are typically rounded, so a wake computed
 * from them may be early. An early wake is refused again with a more precise
 * hint, and the run-scoped suspension budget bounds that.
 */
export function parseOpencodeResetFromText(text: string, now: number): number | null {
	const at = /resets?\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}[t\s][\d:.]+(?:z|[+-]\d{2}:?\d{2})?)/i.exec(
		text,
	);
	if (at?.[1]) {
		const raw = at[1].replace(" ", "T");
		const parsed = Date.parse(/z|[+-]\d{2}:?\d{2}$/i.test(raw) ? raw : `${raw}Z`);
		if (Number.isFinite(parsed) && parsed > now) return parsed;
	}
	const inMatch =
		/resets?\s+in\s+(?:about\s+|approximately\s+|around\s+|~\s*)?((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(
			text,
		);
	if (!inMatch?.[1]) return null;
	let total = 0;
	for (const part of inMatch[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
		const unit = TEXT_UNIT_MS.find(([pattern]) => pattern.test((part[2] ?? "").toLowerCase()));
		if (!unit) break;
		total += Number(part[1]) * unit[1];
	}
	return total > 0 ? now + total : null;
}

/** Next Monday 00:00 UTC strictly after `now` (the Go week boundary). */
export function nextOpencodeWeekStart(now: number): number {
	const date = new Date(now);
	const day = date.getUTCDay(); // 0 = Sunday
	const daysUntilMonday = (8 - day) % 7 || 7;
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + daysUntilMonday);
}

function windowReset(window: OpencodeUsageWindow | null | undefined): number | null {
	if (!window?.resetsAt) return null;
	const parsed = Date.parse(window.resetsAt);
	return Number.isFinite(parsed) ? parsed : null;
}

function isExhausted(window: OpencodeUsageWindow): boolean {
	return window.status === "rate-limited" || (window.percent != null && window.percent >= 100);
}

/**
 * Pick the reset to wait for out of a usage payload.
 *
 * Candidates are the window the refusal named and every exhausted window; the
 * LATEST future reset among them wins, because the request is refused until
 * every spent window has refilled. Waking at an earlier one would only buy
 * another refusal.
 */
export function selectOpencodeUsageResetTarget(
	payload: OpencodeUsagePayload | null | undefined,
	messageText: string,
	now: number,
): OpencodeQuotaTarget | null {
	if (!payload) return null;
	const named = opencodeBucketNamedByText(messageText);
	const windows: Array<[OpencodeQuotaBucket, OpencodeUsageWindow | null]> = [
		["fiveHour", payload.rolling],
		["weekly", payload.weekly],
		["monthly", payload.monthly],
	];
	let best: OpencodeQuotaTarget | null = null;
	for (const [bucket, window] of windows) {
		if (!window) continue;
		const resetAt = windowReset(window);
		if (resetAt == null || resetAt <= now) continue;
		if (bucket !== named && !isExhausted(window)) continue;
		if (!best || resetAt > best.resetAt) best = { bucket, resetAt, source: "usage" };
	}
	return best;
}

/** The documented reset of a named window when nothing better is known. */
export function opencodeWindowRuleReset(
	bucket: OpencodeQuotaBucket | null,
	now: number,
): number | null {
	if (bucket === "weekly") return nextOpencodeWeekStart(now);
	if (bucket === "fiveHour") return now + ROLLING_WINDOW_MS;
	// The month is anchored to the subscription's own anniversary: not derivable.
	return null;
}

/** Apply skew and the wait budget; null past the budget (reported by the caller). */
export function clampOpencodeQuotaTarget(
	target: OpencodeQuotaTarget,
	now: number,
): OpencodeQuotaWaitTarget | null {
	const resumeAt = target.resetAt + OPENCODE_QUOTA_RESET_SKEW_MS;
	const delayMs = resumeAt - now;
	if (delayMs > OPENCODE_QUOTA_MAX_WAIT_MS) return null;
	return { ...target, resumeAt, delayMs: Math.max(delayMs, 0) };
}

/**
 * Resolve a quota wall's reset from everything that does not cost a request:
 * the headers, a usage cache entry, the text. Pure, so the precedence is
 * testable without a gateway.
 */
export function planOpencodeQuotaTarget(input: {
	messageText: string;
	headers?: Record<string, string>;
	cached?: OpencodeUsagePayload | null;
	now: number;
}): OpencodeQuotaTarget | null {
	const { messageText, now } = input;
	const named = opencodeBucketNamedByText(messageText);
	const hint = parseRetryAfterMs(input.headers, now);
	if (hint != null && hint > 0) {
		return { bucket: named ?? "other", resetAt: now + hint, source: "retry-after" };
	}
	const fromUsage = selectOpencodeUsageResetTarget(input.cached, messageText, now);
	if (fromUsage) return fromUsage;
	const fromText = parseOpencodeResetFromText(messageText, now);
	if (fromText != null) return { bucket: named ?? "other", resetAt: fromText, source: "message" };
	return null;
}

/**
 * Decide a rate-limit refusal: park only on an explicit, long-enough hint.
 * Returns null to leave the refusal to the in-loop retry.
 */
export function planOpencodeRateLimitWait(
	headers: Record<string, string> | undefined,
	now: number,
	kind: "rate_limit" | "capacity" = "rate_limit",
): OpencodeQuotaWaitTarget | OpencodeQuotaRefusalTarget | null {
	const hint = parseRetryAfterMs(headers, now);
	if (hint == null || hint < OPENCODE_RATE_LIMIT_SUSPEND_MIN_MS) return null;
	const target: OpencodeQuotaTarget = {
		bucket: kind === "capacity" ? "capacity" : "rateLimit",
		resetAt: now + hint,
		source: "retry-after",
	};
	return clampOpencodeQuotaTarget(target, now) ?? { ...target, waitMs: hint };
}

function toResult(
	target: OpencodeQuotaTarget,
	now: number,
	providerId: string,
): OpencodeQuotaWaitTarget | OpencodeQuotaRefusalTarget {
	const clamped = clampOpencodeQuotaTarget(target, now);
	if (clamped) return clamped;
	logger.info("OpenCode Go quota reset is too far out to wait for", {
		providerId,
		bucket: target.bucket,
		source: target.source,
		waitMinutes: Math.round((target.resetAt - now) / 60_000),
		maxWaitMinutes: Math.round(OPENCODE_QUOTA_MAX_WAIT_MS / 60_000),
	});
	return { bucket: target.bucket, resetAt: target.resetAt, waitMs: target.resetAt - now };
}

/**
 * Resolve what an OpenCode Go refusal means for one provider, or null when it
 * is not a recoverable Go refusal.
 *
 * Costs at most one `GET …/usage`, and only when the free sources are silent and
 * the cache entry is older than the app's own refresh cadence.
 */
export async function resolveOpencodeQuotaTarget(
	providerId: string,
	errorText: string,
	diagnostics: ApiRequestDiagnostics | undefined,
	now = Date.now(),
): Promise<OpencodeQuotaWaitTarget | OpencodeQuotaRefusalTarget | null> {
	const kind = classifyOpencodeRefusal(errorText, diagnostics);
	if (!kind) return null;
	const headers = diagnostics?.responseHeaders;
	if (kind !== "quota") return planOpencodeRateLimitWait(headers, now, kind);

	const messageText = refusalText(errorText, diagnostics);
	const cached = getOpencodeCachedUsage(providerId);
	const planned = planOpencodeQuotaTarget({ messageText, headers, cached, now });
	if (planned) return toResult(planned, now, providerId);

	const stale = !cached?.fetchedAt || now - cached.fetchedAt >= OPENCODE_USAGES_STALE_MS;
	if (stale) {
		const refreshed = await refreshOpencodeUsage(providerId);
		const fromUsage = selectOpencodeUsageResetTarget(refreshed, messageText, now);
		if (fromUsage) return toResult(fromUsage, now, providerId);
	}

	const named = opencodeBucketNamedByText(messageText);
	const ruled = opencodeWindowRuleReset(named, now);
	if (ruled != null && named) {
		return toResult({ bucket: named, resetAt: ruled, source: "window-rule" }, now, providerId);
	}
	logger.info("OpenCode Go quota wall without a resolvable reset", { providerId, bucket: named });
	return { bucket: named ?? "other" };
}

/** The enabled OpenCode Go provider a model prefix (or id) refers to. */
export function findOpencodeProvider(
	providerRef: string,
): { id: string; prefix: string } | undefined {
	const config = (settings.customApiProviders ?? []).find(
		(provider) =>
			!provider.disabled && (provider.prefix === providerRef || provider.id === providerRef),
	);
	if (!config || !isOpencodeCustomApiProvider(config)) return undefined;
	return { id: config.id, prefix: config.prefix ?? providerRef };
}
