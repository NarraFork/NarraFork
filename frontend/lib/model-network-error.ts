const NETWORK_ERROR_CODE_PATTERN =
	/\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETDOWN|ENETUNREACH|UND_ERR_[A-Z_]+|CONNECTIONRESET|CONNECTIONREFUSED|CONNECTIONABORTED)\b/i;

const NETWORK_ERROR_MESSAGE_PATTERN =
	/(?:network request failed|network error|socket connection was closed|connection was closed unexpectedly|connection reset|connection refused|socket hang up|fetch failed|failed to fetch|unable to connect|could not resolve host|name resolution|dns lookup|first token timeout|stream[_ ]read error|stream_read_error|service unavailable|tls handshake|certificate verification|certificate verify failed)/i;

const UPSTREAM_HTTP_ERROR_PATTERN =
	/(?:(?:api|provider|upstream|gateway|http|server[_ ]error).{0,80}\b(?:500|502|503|504|529)\b|\b(?:500|502|503|504|529)\b.{0,80}(?:api|provider|upstream|gateway|http|server[_ ]error))/i;

/** Whether a narrator error is actionable through the provider model-test flow. */
export function isModelNetworkError(message: string | null | undefined): boolean {
	const value = message?.trim();
	if (!value) return false;
	return (
		NETWORK_ERROR_CODE_PATTERN.test(value) ||
		NETWORK_ERROR_MESSAGE_PATTERN.test(value) ||
		UPSTREAM_HTTP_ERROR_PATTERN.test(value)
	);
}

/** Prefer the concrete member used by the failed turn; otherwise keep the original model reference. */
export function resolveModelTestTarget(
	selectedModel: string | null | undefined,
	runtimeModel?: { provider?: unknown; model?: unknown } | null,
): string {
	const provider = typeof runtimeModel?.provider === "string" ? runtimeModel.provider.trim() : "";
	const model = typeof runtimeModel?.model === "string" ? runtimeModel.model.trim() : "";
	return provider && model ? `${provider}:${model}` : (selectedModel?.trim() ?? "");
}
