import { ApiError } from "@frontend/lib/api/client";
import { describeApiError } from "@frontend/lib/api-error";
import { formatFullLocaleDateTime } from "@frontend/lib/format";
import { extractPolicyViolationCode } from "@shared/agent-protocol/policy-violation";
import { KIMI_QUOTA_EXHAUSTED } from "@shared/agent-protocol/quota-exhausted";
import { ERROR_CATALOG } from "@shared/error-catalog";
import type { TFunction } from "i18next";

const EMPTY_RESPONSE_RE =
	/^(?:Error:\s*)?([^:]+): Provider returned an empty response\. This often indicates an API configuration error \(base URL, model, or credentials\)\.?$/;

/** Leading `"<provider>: "` tag the agent loop prefixes onto its own messages. */
const PROVIDER_PREFIX_RE = /^(?:Error:\s*)?([^:\s][^:]*): /;

function parseErrorMessagePayload(errorMessage: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(errorMessage);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Recover the provider label for a message.
 *
 * Prefers the structured `diagnostics.provider` and only falls back to parsing
 * the message prefix, so a provider name containing a colon cannot corrupt it.
 */
function resolveProvider(
	errorMessage: string,
	diagnostics: Record<string, unknown> | undefined,
): string | undefined {
	return nonEmptyString(diagnostics?.provider) ?? errorMessage.match(PROVIDER_PREFIX_RE)?.[1];
}

/**
 * Extract the provider-reported stop reason from the evidence snippet the agent
 * loop attaches (e.g. `events=1 contentless=1 usage=false stopReason=content_filter`).
 */
function resolveStopReason(diagnostics: Record<string, unknown> | undefined): string | undefined {
	const snippet = nonEmptyString(diagnostics?.responseSnippet);
	return snippet?.match(/stopReason=(\S+)/)?.[1];
}

/**
 * i18n keys for the empty-turn sub-reasons emitted by the agent loop. Each kind
 * gets its own explanation because the follow-up action differs: only a
 * genuinely empty body points at local API configuration, while the rest are
 * upstream or model-behaviour problems.
 */
const REASON_KEYS: Record<string, string> = {
	empty_response_no_events: "emptyResponseNoEvents",
	empty_response_usage_only: "emptyResponseUsageOnly",
	empty_response_nameless_tool_call: "emptyResponseNamelessToolCall",
	empty_response_stop_without_content: "emptyResponseStopWithoutContent",
	reasoning_only_exhausted: "reasoningOnlyExhausted",
};

const CONTEXT_KEYS: Record<string, string> = {
	context_too_long_compact_failed: "contextTooLongCompactFailed",
	context_too_long_no_compact_boundary: "contextTooLongNoCompactBoundary",
	context_too_long_recovery_exhausted: "contextTooLongRecoveryExhausted",
	context_too_long_compact_noop: "contextTooLongCompactNoop",
};

/**
 * Upstream policy-violation reason codes (e.g. Codex `cyber_policy`). These get
 * their own copy because the follow-up action is unique: the turn was refused
 * for its content, nothing was retried or failed over, and repeating the same
 * prompt risks the upstream account.
 */
const POLICY_VIOLATION_KEYS: Record<string, string> = {
	cyber_policy: "cyberPolicyViolation",
};

/**
 * Turn a narrator error/warning into user-facing text.
 *
 * `diagnostics` is preferred over the raw message: the server always ships a
 * structured `reason`, and relying on it keeps the UI from having to reverse
 * engineer English sentences it produced itself.
 */
export function localizeNarratorError(
	errorMessage: string | null | undefined,
	t: TFunction,
	errorCode?: string,
	diagnostics?: Record<string, unknown>,
): string | null | undefined {
	if (!errorMessage) return errorMessage;

	const payload = parseErrorMessagePayload(errorMessage);
	if (errorCode === "payment_required" || payload?.type === "payment_required") {
		return t("recharge.paymentRequired");
	}

	// A quota allowance that is spent and was NOT waited out (the reset is beyond the
	// wait budget, or this run already suspended on quota too often). The server put
	// the reset instant in the payload precisely so this can name it: without that,
	// the user gets an opaque upstream 403 and no idea when the model comes back —
	// which is what this branch exists to fix. Read from the payload, not from
	// `diagnostics`, because only `errorMessage` survives a page reload.
	if (payload?.type === KIMI_QUOTA_EXHAUSTED) {
		const resetAt = payload.quotaResetAt;
		return typeof resetAt === "number" && Number.isFinite(resetAt)
			? t("quotaExhaustedWaitNotPossible", {
					resetAt: formatFullLocaleDateTime(new Date(resetAt)),
				})
			: t("quotaExhaustedWaitNotPossibleNoReset");
	}

	const contextKey = errorCode ? CONTEXT_KEYS[errorCode] : undefined;
	if (contextKey) return t(contextKey);

	// errorMessage is the only persisted carrier available to the details panel.
	// Reuse the catalog renderer (including unknown-key and English fallbacks).
	if (payload?.type === "catalog_error" && typeof payload.error === "string") {
		return describeApiError(new ApiError(payload.error, 0, payload), t).message;
	}
	// Old sessions saved only English. Match the complete known message, never
	// arbitrary upstream prose which might quote or discuss tutorial retirement.
	const legacyTutorialMessage = ERROR_CATALOG.TUTORIAL_REMOVED.en;
	if (
		errorCode === "TUTORIAL_REMOVED" ||
		errorMessage === legacyTutorialMessage ||
		errorMessage === `Error: ${legacyTutorialMessage}`
	) {
		return t("errors:TUTORIAL_REMOVED", { defaultValue: legacyTutorialMessage });
	}

	// Check each structured carrier independently: a generic HTTP error type in
	// reason (or errorCode) must not hide diagnostics.code === "cyber_policy".
	const violationCode = extractPolicyViolationCode({ code: errorCode, diagnostics });
	const violationKey = violationCode ? POLICY_VIOLATION_KEYS[violationCode] : undefined;
	const requestId = nonEmptyString(diagnostics?.requestId);
	if (violationKey) {
		const provider = resolveProvider(errorMessage, diagnostics);
		const localized = t(violationKey, {
			provider: provider ?? t("emptyResponseProviderFallback"),
		});
		return requestId ? `${localized} ${t("errorRequestIdLabel", { requestId })}` : localized;
	}
	// Preserve precedence for the existing empty-response sub-reasons.
	const reason = errorCode ?? nonEmptyString(diagnostics?.reason);
	const reasonKey = reason ? REASON_KEYS[reason] : undefined;
	if (reasonKey) {
		const provider = resolveProvider(errorMessage, diagnostics);
		const localized = t(reasonKey, {
			provider: provider ?? t("emptyResponseProviderFallback"),
			stopReason: resolveStopReason(diagnostics) ?? "",
		});
		// The request id is what makes a report actionable against upstream logs.
		return requestId ? `${localized} ${t("errorRequestIdLabel", { requestId })}` : localized;
	}

	if (errorCode === "empty_response") {
		const match = errorMessage.match(EMPTY_RESPONSE_RE);
		if (match?.[1]) {
			return t("emptyResponseError", { provider: match[1] });
		}
		return t("emptyResponseErrorGeneric");
	}

	const emptyResponseMatch = errorMessage.match(EMPTY_RESPONSE_RE);
	if (emptyResponseMatch?.[1]) {
		return t("emptyResponseError", { provider: emptyResponseMatch[1] });
	}

	return errorMessage;
}
