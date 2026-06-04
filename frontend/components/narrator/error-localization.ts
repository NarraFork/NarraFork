import type { TFunction } from "i18next";

const EMPTY_RESPONSE_RE =
	/^(?:Error:\s*)?([^:]+): Provider returned an empty response\. This often indicates an API configuration error \(base URL, model, or credentials\)\.?$/;

export function localizeNarratorError(
	errorMessage: string | null | undefined,
	t: TFunction,
	errorCode?: string,
): string | null | undefined {
	if (!errorMessage) return errorMessage;

	if (errorCode === "context_too_long_compact_failed") {
		return t("contextTooLongCompactFailed");
	}
	if (errorCode === "context_too_long_no_compact_boundary") {
		return t("contextTooLongNoCompactBoundary");
	}
	if (errorCode === "context_too_long_recovery_exhausted") {
		return t("contextTooLongRecoveryExhausted");
	}
	if (errorCode === "context_too_long_compact_noop") {
		return t("contextTooLongCompactNoop");
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
