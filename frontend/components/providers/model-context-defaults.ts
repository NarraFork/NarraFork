/**
 * Heuristics for auto-filling a model's default context window (token count)
 * after refreshing a provider's model list.
 *
 * Returns the recommended context window in tokens, or null when the model
 * does not match any special family (in which case it is left unset and the
 * runtime default applies).
 */

/** Extract the bare model id from a "provider:model" composite value. */
function bareModelId(idOrValue: string): string {
	const idx = idOrValue.indexOf(":");
	return idx >= 0 ? idOrValue.slice(idx + 1) : idOrValue;
}

/**
 * Parse a "major.minor" version from a string. Date-style suffixes like
 * "4-20250514" are intentionally NOT treated as a 4.20250514 version — we only
 * accept a minor segment of 1–3 digits so that dated legacy IDs fall through.
 */
function parseClaudeVersion(model: string): { major: number; minor: number } | null {
	// Match e.g. "sonnet-4.6", "opus-4-6", "sonnet-4" (minor defaults to 0).
	// The minor segment must NOT be followed by another digit, so date-style
	// suffixes like "4-20250514" do not parse as version 4.202.
	const m = model.match(/(?:sonnet|opus)[-_]?(\d+)(?:[._-](\d{1,3})(?!\d))?/);
	if (!m) return null;
	const major = Number(m[1]);
	const minor = m[2] != null ? Number(m[2]) : 0;
	if (!Number.isFinite(major)) return null;
	return { major, minor };
}

/**
 * Determine the default context window for a model based on its family.
 *
 * - mimo series → 1048576
 * - deepseek v4 series → 1000000
 * - gpt-5 series → 272000
 * - claude sonnet/opus >= 4.6 → 1000000
 * - otherwise → null (leave unset; runtime default applies)
 */
export function getModelDefaultContextWindow(idOrValue: string): number | null {
	const model = bareModelId(idOrValue).toLowerCase();
	if (!model) return null;

	// mimo series
	if (model.includes("mimo")) return 1_048_576;

	// deepseek v4 series (deepseek-v4, deepseek-v4-pro, deepseek-v4-flash, ...)
	if (/deepseek[-_]?v4/.test(model)) return 1_000_000;

	// gpt-5 series (gpt-5, gpt-5.1, gpt-5-codex, gpt-5.4-mini, ...)
	if (/^gpt-5(\b|[._-])/.test(model)) return 272_000;

	// claude sonnet/opus >= 4.6
	if (model.includes("claude") || /\b(sonnet|opus)\b/.test(model)) {
		const version = parseClaudeVersion(model);
		if (version && (version.major > 4 || (version.major === 4 && version.minor >= 6))) {
			return 1_000_000;
		}
	}

	return null;
}
