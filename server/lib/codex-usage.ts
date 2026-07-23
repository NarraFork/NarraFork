// Codex Usage API — fetch ChatGPT account usage limits
// Based on https://chatgpt.com/backend-api/wham/usage

import { logger } from "./logger";

export type CodexUsageWindowType = "5h" | "weekly" | "monthly" | "unknown";

export interface CodexUsageApiWindow {
	used_percent: number;
	limit_window_seconds: number;
	reset_after_seconds: number;
	reset_at: number;
}

export interface CodexRateLimit {
	allowed: boolean;
	limit_reached: boolean;
	primary_window: CodexUsageApiWindow | null;
	secondary_window: CodexUsageApiWindow | null;
}

export interface CodexUsagePayload {
	plan_type: string;
	rate_limit: CodexRateLimit;
	code_review_rate_limit: CodexRateLimit;
	additional_rate_limits: CodexRateLimit[];
}

export interface CodexUsageWindow {
	used_percent: number;
	remaining_percent: number;
	reset_at: number;
	reset_after_seconds: number;
	window_type: CodexUsageWindowType;
	/** Optional for compatibility with cached results written before duration was persisted. */
	limit_window_seconds?: number;
}

export interface CodexUsageResult {
	plan_type: string;
	primary_window?: CodexUsageWindow;
	secondary_window?: CodexUsageWindow;
	code_review?: Omit<CodexUsageWindow, "window_type" | "limit_window_seconds">;
	queriedAt: string;
}

const USAGE_API_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_USAGE_FETCH_TIMEOUT_MS = 20_000;
const MAX_USAGE_RESPONSE_BYTES = 256 * 1024;
const MONTHLY_WINDOW_MIN_SECONDS = 28 * 24 * 60 * 60;
const MONTHLY_WINDOW_MAX_SECONDS = 31 * 24 * 60 * 60;

export class CodexUsageFetchError extends Error {
	readonly status?: number;
	readonly statusText?: string;
	/** Bounded upstream body retained for recovery decisions, but never included in the log message. */
	readonly responseBody?: string;

	constructor(message: string, status?: number, statusText?: string, responseBody?: string) {
		super(message);
		this.name = "CodexUsageFetchError";
		this.status = status;
		this.statusText = statusText;
		this.responseBody = responseBody;
	}
}

export function isUnauthorizedCodexUsageError(error: unknown): boolean {
	if (error instanceof CodexUsageFetchError) return error.status === 401;
	if (typeof error === "object" && error !== null && "status" in error) {
		const status = (error as { status?: unknown }).status;
		if (status === 401) return true;
	}
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /Failed to fetch usage:\s*401\b/i.test(message);
}

export function identifyCodexUsageWindowType(
	limitWindowSeconds: number | undefined,
): CodexUsageWindowType {
	if (limitWindowSeconds === 18_000) return "5h";
	if (limitWindowSeconds === 604_800) return "weekly";
	if (
		typeof limitWindowSeconds === "number" &&
		Number.isFinite(limitWindowSeconds) &&
		limitWindowSeconds >= MONTHLY_WINDOW_MIN_SECONDS &&
		limitWindowSeconds <= MONTHLY_WINDOW_MAX_SECONDS
	) {
		return "monthly";
	}
	return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function getQueriedAtSeconds(queriedAt: string | number | Date): number | undefined {
	const timestampMs =
		queriedAt instanceof Date
			? queriedAt.getTime()
			: typeof queriedAt === "number"
				? queriedAt
				: Date.parse(queriedAt);
	return Number.isFinite(timestampMs) ? Math.floor(timestampMs / 1000) : undefined;
}

export function normalizeCodexUsageWindow(
	value: unknown,
	queriedAt: string | number | Date = Date.now(),
): CodexUsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const usedPercent = finiteNumber(value.used_percent);
	const rawResetAt = finiteNumber(value.reset_at);
	const rawResetAfterSeconds = finiteNumber(value.reset_after_seconds);
	const resetAt = rawResetAt !== undefined && rawResetAt > 0 ? rawResetAt : undefined;
	const resetAfterSeconds =
		rawResetAfterSeconds !== undefined && rawResetAfterSeconds >= 0
			? rawResetAfterSeconds
			: undefined;
	if (usedPercent === undefined || (resetAt === undefined && resetAfterSeconds === undefined)) {
		return undefined;
	}
	const queriedAtSeconds = getQueriedAtSeconds(queriedAt);
	const normalizedResetAt =
		resetAt ??
		(queriedAtSeconds !== undefined && resetAfterSeconds !== undefined
			? queriedAtSeconds + resetAfterSeconds
			: undefined);
	const normalizedResetAfterSeconds =
		resetAfterSeconds ??
		(queriedAtSeconds !== undefined && resetAt !== undefined
			? Math.max(0, resetAt - queriedAtSeconds)
			: undefined);
	if (normalizedResetAt === undefined || normalizedResetAfterSeconds === undefined)
		return undefined;

	const normalizedUsedPercent = clampPercent(usedPercent);
	const rawLimitWindowSeconds = finiteNumber(value.limit_window_seconds);
	const limitWindowSeconds =
		rawLimitWindowSeconds !== undefined && rawLimitWindowSeconds > 0
			? rawLimitWindowSeconds
			: undefined;
	return {
		used_percent: normalizedUsedPercent,
		remaining_percent: 100 - normalizedUsedPercent,
		reset_at: normalizedResetAt,
		reset_after_seconds: normalizedResetAfterSeconds,
		window_type: identifyCodexUsageWindowType(limitWindowSeconds),
		...(limitWindowSeconds !== undefined ? { limit_window_seconds: limitWindowSeconds } : {}),
	};
}

function normalizeCodeReviewWindow(
	value: unknown,
	queriedAt: string | number | Date,
): CodexUsageResult["code_review"] | undefined {
	const window = normalizeCodexUsageWindow(value, queriedAt);
	if (!window) return undefined;
	return {
		used_percent: window.used_percent,
		remaining_percent: window.remaining_percent,
		reset_at: window.reset_at,
		reset_after_seconds: window.reset_after_seconds,
	};
}

export function parseCodexUsagePayload(
	value: unknown,
	queriedAt = new Date().toISOString(),
): CodexUsageResult {
	if (!isRecord(value)) throw new Error("Codex usage API returned an invalid payload");
	if (!isRecord(value.rate_limit)) {
		throw new Error("Codex usage API returned an invalid account rate_limit");
	}

	const planType = typeof value.plan_type === "string" ? value.plan_type : "unknown";
	const primaryWindow = normalizeCodexUsageWindow(value.rate_limit.primary_window, queriedAt);
	const secondaryWindow = normalizeCodexUsageWindow(value.rate_limit.secondary_window, queriedAt);
	if (
		(value.rate_limit.primary_window != null || value.rate_limit.secondary_window != null) &&
		!primaryWindow &&
		!secondaryWindow
	) {
		throw new Error("Codex usage API returned no valid account rate_limit windows");
	}

	const result: CodexUsageResult = {
		plan_type: planType,
		queriedAt,
		...(primaryWindow ? { primary_window: primaryWindow } : {}),
		...(secondaryWindow ? { secondary_window: secondaryWindow } : {}),
	};

	if (isRecord(value.code_review_rate_limit)) {
		const codeReview = normalizeCodeReviewWindow(
			value.code_review_rate_limit.primary_window,
			queriedAt,
		);
		if (codeReview) result.code_review = codeReview;
	}
	return result;
}

export function getCodexUsageWindows(usage?: CodexUsageResult): CodexUsageWindow[] {
	if (!usage) return [];
	return [usage.primary_window, usage.secondary_window].filter(
		(window): window is CodexUsageWindow => !!window,
	);
}

async function readResponseTextWithLimit(response: Response): Promise<string> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_USAGE_RESPONSE_BYTES) {
		throw new Error(`Codex usage API response exceeded ${MAX_USAGE_RESPONSE_BYTES} bytes`);
	}
	if (!response.body) return "";

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > MAX_USAGE_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error(`Codex usage API response exceeded ${MAX_USAGE_RESPONSE_BYTES} bytes`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/**
 * Fetch Codex usage from ChatGPT backend API.
 *
 * `accessToken` builds the default `Bearer` header. Pass `authorization` to
 * override it with a different scheme (e.g. Codex Agent Identity's
 * `AgentAssertion ...`), mirroring how sub2api authenticates the same usage
 * endpoint for Agent Identity accounts.
 */
export async function fetchCodexUsage(
	accessToken: string,
	accountId: string,
	proxy?: string,
	authorization?: string,
): Promise<CodexUsageResult> {
	const headers = {
		Authorization: authorization?.trim() || `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "narrafork/1.0.0 (Bun)",
		"Chatgpt-Account-Id": accountId,
	};

	const abortController = new AbortController();
	const timeout = setTimeout(() => {
		abortController.abort(
			new Error(`Codex usage fetch timed out after ${DEFAULT_USAGE_FETCH_TIMEOUT_MS}ms`),
		);
	}, DEFAULT_USAGE_FETCH_TIMEOUT_MS);

	const fetchOptions: RequestInit = {
		method: "GET",
		headers,
		signal: abortController.signal,
	};
	if (proxy) {
		// @ts-expect-error - Bun supports proxy option
		fetchOptions.proxy = proxy;
	}

	try {
		const response = await fetch(USAGE_API_URL, fetchOptions);
		if (!response.ok) {
			let responseBody: string | undefined;
			try {
				responseBody = await readResponseTextWithLimit(response);
			} catch {
				// Preserve the HTTP status even when an oversized or unreadable error body is discarded.
			}
			throw new CodexUsageFetchError(
				`Failed to fetch usage: ${response.status} ${response.statusText}`,
				response.status,
				response.statusText,
				responseBody,
			);
		}

		const raw = await readResponseTextWithLimit(response);
		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Codex usage API returned non-JSON payload: ${message}. body preview=${raw.slice(0, 500)}`,
			);
		}
		const result = parseCodexUsagePayload(data);
		logger.info("Fetched Codex usage", {
			accountId: accountId.slice(0, 8),
			planType: result.plan_type,
			windows: getCodexUsageWindows(result).map((window) => ({
				type: window.window_type,
				limitWindowSeconds: window.limit_window_seconds,
				usedPercent: window.used_percent,
				resetAt: window.reset_at,
			})),
		});
		return result;
	} catch (err) {
		logger.error("Failed to fetch Codex usage", {
			error: err instanceof Error ? err.message : String(err),
			accountId: accountId.slice(0, 8),
		});
		throw err;
	} finally {
		clearTimeout(timeout);
	}
}
