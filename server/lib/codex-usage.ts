// Codex Usage API — fetch ChatGPT account usage limits
// Based on https://chatgpt.com/backend-api/wham/usage

import { logger } from "./logger";

export interface CodexUsageWindow {
	used_percent: number;
	limit_window_seconds: number;
	reset_after_seconds: number;
	reset_at: number;
}

export interface CodexRateLimit {
	allowed: boolean;
	limit_reached: boolean;
	primary_window: CodexUsageWindow | null;
	secondary_window: CodexUsageWindow | null;
}

export interface CodexUsagePayload {
	plan_type: string; // 'plus', 'team', 'free'
	rate_limit: CodexRateLimit;
	code_review_rate_limit: CodexRateLimit;
	additional_rate_limits: CodexRateLimit[];
}

export interface CodexUsageResult {
	plan_type: string;
	primary_window?: {
		used_percent: number;
		remaining_percent: number;
		reset_at: number;
		reset_after_seconds: number;
		window_type: "5h" | "weekly" | "unknown";
	};
	secondary_window?: {
		used_percent: number;
		remaining_percent: number;
		reset_at: number;
		reset_after_seconds: number;
		window_type: "5h" | "weekly" | "unknown";
	};
	code_review?: {
		used_percent: number;
		remaining_percent: number;
		reset_at: number;
		reset_after_seconds: number;
	};
	queriedAt: string;
}

const USAGE_API_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_USAGE_FETCH_TIMEOUT_MS = 20_000;

export class CodexUsageFetchError extends Error {
	readonly status?: number;
	readonly statusText?: string;

	constructor(message: string, status?: number, statusText?: string) {
		super(message);
		this.name = "CodexUsageFetchError";
		this.status = status;
		this.statusText = statusText;
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

function identifyWindowType(limitWindowSeconds: number): "5h" | "weekly" | "unknown" {
	if (limitWindowSeconds === 18000) return "5h"; // 5 hours
	if (limitWindowSeconds === 604800) return "weekly"; // 7 days
	return "unknown";
}

/**
 * Fetch Codex usage from ChatGPT backend API.
 * @param accessToken - ChatGPT access token
 * @param accountId - ChatGPT account ID
 * @param proxy - Optional proxy URL
 */
export async function fetchCodexUsage(
	accessToken: string,
	accountId: string,
	proxy?: string,
): Promise<CodexUsageResult> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
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

	// Add proxy if provided
	if (proxy) {
		// @ts-expect-error - Bun supports proxy option
		fetchOptions.proxy = proxy;
	}

	try {
		const response = await fetch(USAGE_API_URL, fetchOptions);

		if (!response.ok) {
			throw new CodexUsageFetchError(
				`Failed to fetch usage: ${response.status} ${response.statusText}`,
				response.status,
				response.statusText,
			);
		}

		const raw = await response.text();
		let data: CodexUsagePayload;
		try {
			data = JSON.parse(raw) as CodexUsagePayload;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Codex usage API returned non-JSON payload: ${message}. ` +
					`body preview=${raw.slice(0, 500)}`,
			);
		}

		// Debug: log the entire response
		logger.info("Codex usage API response", {
			accountId: accountId.slice(0, 8),
			response: JSON.stringify(data, null, 2),
		});

		// Parse primary and secondary windows
		const primaryWindow = data.rate_limit.primary_window;
		const secondaryWindow = data.rate_limit.secondary_window;

		const result: CodexUsageResult = {
			plan_type: data.plan_type,
			queriedAt: new Date().toISOString(),
		};

		// Add primary window if available
		if (primaryWindow) {
			result.primary_window = {
				used_percent: primaryWindow.used_percent,
				remaining_percent: 100 - primaryWindow.used_percent,
				reset_at: primaryWindow.reset_at,
				reset_after_seconds: primaryWindow.reset_after_seconds,
				window_type: identifyWindowType(primaryWindow.limit_window_seconds),
			};
		}

		// Add secondary window if available
		if (secondaryWindow) {
			result.secondary_window = {
				used_percent: secondaryWindow.used_percent,
				remaining_percent: 100 - secondaryWindow.used_percent,
				reset_at: secondaryWindow.reset_at,
				reset_after_seconds: secondaryWindow.reset_after_seconds,
				window_type: identifyWindowType(secondaryWindow.limit_window_seconds),
			};
		}

		// Add code review if available
		if (data.code_review_rate_limit?.primary_window) {
			const codeReviewWindow = data.code_review_rate_limit.primary_window;
			result.code_review = {
				used_percent: codeReviewWindow.used_percent,
				remaining_percent: 100 - codeReviewWindow.used_percent,
				reset_at: codeReviewWindow.reset_at,
				reset_after_seconds: codeReviewWindow.reset_after_seconds,
			};
		}

		logger.info("Fetched Codex usage", {
			accountId: accountId.slice(0, 8),
			planType: data.plan_type,
			primaryUsed: primaryWindow?.used_percent ?? null,
			secondaryUsed: secondaryWindow?.used_percent ?? null,
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
