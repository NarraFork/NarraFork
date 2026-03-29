// WebFetch proxy resolution — reads settings and returns the proxy URL (or undefined).

import { settings } from "../settings";

/**
 * Resolve the proxy URL for WebFetch based on the current settings.
 * - "direct" → undefined (no proxy)
 * - "system" → read HTTPS_PROXY / HTTP_PROXY / ALL_PROXY env vars
 * - "custom" → return the user-specified URL
 *
 * Default behaviour (when no proxy config exists) is "system".
 */
export function getWebFetchProxy(): string | undefined {
	const cfg = settings.agent.webFetchPolicy?.proxy;
	const mode = cfg?.mode ?? "system";

	switch (mode) {
		case "direct":
			return undefined;
		case "system":
			return detectSystemProxy();
		case "custom":
			return cfg?.url || undefined;
	}
}

/** Detect proxy from standard environment variables (case-insensitive). */
function detectSystemProxy(): string | undefined {
	return (
		process.env.HTTPS_PROXY ||
		process.env.https_proxy ||
		process.env.HTTP_PROXY ||
		process.env.http_proxy ||
		process.env.ALL_PROXY ||
		process.env.all_proxy ||
		undefined
	);
}
