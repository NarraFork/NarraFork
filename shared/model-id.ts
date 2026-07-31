/**
 * Model identifier parsing.
 *
 * A NarraFork model value is `${providerPrefix}:${modelId}` (e.g.
 * dependency on settings, the database or any other host state, so it lives in
 * `shared/` where both the host and bundled plugin code can use it.
 *
 * Keeping this out of `server/lib/settings/` matters for bundle purity: the
 * settings module graph reaches the Codex manager and the NUG model cache, so
 * importing `parseModelId` from there pulls ~370 modules into any bundle. See
 */

/**
 * Split a model value into its provider prefix and bare model ID.
 *
 * Only the first colon separates the two halves, so model IDs may themselves
 * contain colons. A leading colon is not treated as a separator (the prefix
 * would be empty), and a value without a colon is returned as a bare model.
 */
export function parseModelId(raw?: string): { provider?: string; model: string } {
	if (!raw) return { model: "" };
	const idx = raw.indexOf(":");
	if (idx > 0) {
		const prefix = raw.slice(0, idx);
		return { provider: prefix, model: raw.slice(idx + 1) };
	}
	return { model: raw };
}
