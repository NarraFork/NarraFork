/**
 * Recognize errors that mean "this model reference cannot be served at all",
 * as opposed to a transient upstream failure (rate limit, overload, network).
 *
 * These errors come from `resolveProviderAndModel()` and mean the persisted
 * `provider:model` reference no longer maps to a usable provider:
 *   - `Provider "x" is not configured.`   — prefix removed from settings
 *   - `<Provider> is not available.`   — provider present but unusable
 *   - `<Provider> is disabled.`        — provider explicitly turned off
 *   - `DefaultModelNotConfiguredError`    — no default model has been chosen
 *
 * Retrying cannot fix any of them; the user has to pick a different model or
 * restore the provider. Callers use this to tell "offer a migration" apart from
 * "back off and retry".
 */
export function isProviderUnavailableError(err: unknown): boolean {
	// Matched by name rather than message so the wording stays free to change,
	// and so this module needs no import from the settings layer. Getting this
	// wrong is expensive but silent: the summary-model retry wrapper treats
	// anything unrecognized as transient, so an unconfigured default model was
	// retried with backoff for minutes before failing — the caller just appeared
	// to hang instead of reporting "no default model is configured".
	if (err instanceof Error && err.name === "DefaultModelNotConfiguredError") return true;

	const message = err instanceof Error ? err.message : typeof err === "string" ? err : null;
	if (!message) return false;
	const normalized = message.toLowerCase();
	return (
		normalized.includes("not configured") ||
		normalized.includes("not available") ||
		normalized.includes("is disabled")
	);
}
