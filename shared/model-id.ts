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

/**
 * Date-suffix patterns safe to strip for family grouping.
 * Copied from model-pricing.ts to keep shared/ dependency-free.
 */
const FAMILY_DATE_SUFFIXES: readonly RegExp[] = [
	/-\d{4}-(?:0[1-9]|1[0-2])-\d{2}$/, // 2026-06-01
	/-20\d{2}(?:0[1-9]|1[0-2])\d{2}$/, // 20260601
	/-\d{2}(?:0[1-9]|1[0-2])\d{2}$/, // 260601
	/-latest$/,
	/-preview$/,
];

/**
 * Normalize a raw model identifier to a "family" key for grouping/clustering.
 *
 * Steps:
 * 1. Strip all provider prefixes by taking the last colon-separated segment
 * 2. Lower-case
 * 3. Normalize version separators: dots between digits → dashes (`claude-opus-4.6` → `claude-opus-4-6`)
 * 4. Strip volatile date suffixes (`claude-opus-4-6-20260514` → `claude-opus-4-6`)
 *
 */
export function normalizeModelFamily(raw: string | null | undefined): string {
	if (!raw) return "unknown";

	// Step 1: strip all provider prefixes — take the segment after the last colon
	// Model names themselves never contain colons; colons are always provider separators.
	let model = raw.trim();
	const lastColon = model.lastIndexOf(":");
	if (lastColon > 0) {
		model = model.slice(lastColon + 1);
	}

	// Step 2: lower-case
	model = model.toLowerCase();

	// Step 3: normalize dots between digits to dashes (4.6 → 4-6, 4.5 → 4-5)
	model = model.replace(/(\d)\.(\d)/g, "$1-$2");

	// Step 4: strip volatile date suffixes
	for (let round = 0; round < 4; round++) {
		let stripped = false;
		for (const pattern of FAMILY_DATE_SUFFIXES) {
			if (pattern.test(model)) {
				model = model.replace(pattern, "");
				stripped = true;
				break;
			}
		}
		if (!stripped) break;
	}

	return model || "unknown";
}
