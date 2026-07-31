import type { TFunction } from "i18next";

const EMPTY_RESPONSE_RE =
	/^(?:Error:\s*)?([^:]+): Provider returned an empty response\. This often indicates an API configuration error \(base URL, model, or credentials\)\.?$/;

/** Leading `"<provider>: "` tag the agent loop prefixes onto its own messages. */
const PROVIDER_PREFIX_RE = /^(?:Error:\s*)?([^:\s][^:]*): /;

function isPaymentRequiredPayload(errorMessage: string): boolean {
	try {
		const parsed = JSON.parse(errorMessage) as Record<string, unknown>;
		return parsed.type === "payment_required";
	} catch {
		return false;
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

	if (errorCode === "payment_required" || isPaymentRequiredPayload(errorMessage)) {
		return t("recharge.paymentRequired");
	}

	const contextKey = errorCode ? CONTEXT_KEYS[errorCode] : undefined;
	if (contextKey) return t(contextKey);

	// Prefer the explicit errorCode, then the structured diagnostics reason.
	const reason = errorCode ?? nonEmptyString(diagnostics?.reason);
	const reasonKey = reason ? REASON_KEYS[reason] : undefined;
	if (reasonKey) {
		const provider = resolveProvider(errorMessage, diagnostics);
		const localized = t(reasonKey, {
			provider: provider ?? t("emptyResponseProviderFallback"),
			stopReason: resolveStopReason(diagnostics) ?? "",
		});
		const requestId = nonEmptyString(diagnostics?.requestId);
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
