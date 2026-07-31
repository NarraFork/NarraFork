/**
 * Recognize errors that mean "this model reference cannot be served at all",
 * as opposed to a transient upstream failure (rate limit, overload, network).
 *
 * These errors come from `resolveProviderAndModel()` and mean the persisted
 * `provider:model` reference no longer maps to a usable provider:
 *   - `Provider "x" is not configured.`   — prefix removed from settings
 *
 * Retrying cannot fix any of them; the user has to pick a different model or
 * restore the provider. Callers use this to tell "offer a migration" apart from
 * "back off and retry".
 */
export function isProviderUnavailableError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : typeof err === "string" ? err : null;
	if (!message) return false;
	const normalized = message.toLowerCase();
	return (
		normalized.includes("not configured") ||
		normalized.includes("not available") ||
		normalized.includes("is disabled")
	);
}
