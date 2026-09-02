/**
 * Translation lookup for plugin panels, and the rules it follows.
 *
 * ## Why the host provides this
 *
 * A panel runs in its own document and cannot reach the host's i18n instance. Left to
 * themselves, panels each grow a private string table plus a private notion of what the
 * `navigator.language` because a stale comment claimed the host locale was a placeholder.
 * Meanwhile `cline-external` simply stayed English.
 *
 * The dictionaries stay with the plugin: only the plugin knows its own copy. What the host owns
 * is the part that is identical for everyone — which language is active, and how to fall back
 * when a key is missing.
 *
 * ## What is deliberately NOT exposed
 *
 * The host's own translation resources. Its `settings` namespace keys are internal and get
 * renamed by ordinary refactors; letting plugins read them would turn every such rename into a
 * broken third-party panel. Copying the host's *wording* into a plugin dictionary is fine and
 * dependency.
 */

import { getLocaleFallbackChain, normalizeLocale } from "@shared/i18n-locales";

/**
 * A plugin's string tables: locale tag → key → text.
 *
 * `en` is required because it terminates every fallback chain (see `LOCALE_DEFINITIONS`), so a
 * table without it can produce a lookup that resolves to nothing for reasons the plugin author
 * cannot see from their own file.
 */
export interface PluginStringTables {
	en: Readonly<Record<string, string>>;
	[locale: string]: Readonly<Record<string, string>> | undefined;
}

export type PluginTranslateParams = Readonly<Record<string, string | number>>;

/**
 * Resolve one key against the tables for `locale`.
 *
 * Fallback order is the host's own chain (`getLocaleFallbackChain`), reused rather than
 * reimplemented: it already encodes that `zh-Hans` and `zh-SG` mean `zh-CN`, and that every
 * chain ends at `en`. A second copy of those rules here would be free to drift from the one the
 * rest of the app uses, and the symptom — a plugin showing English where the host shows
 * Chinese — would look like a plugin bug.
 *
 * A key present in no table returns THE KEY ITSELF, not an empty string. A missing translation
 * should read as `signIn` on the button, which is obviously a missing string; an empty button is
 * indistinguishable from a rendering fault and gets debugged as one.
 */
export function translatePluginString(
	tables: PluginStringTables,
	locale: string,
	key: string,
	params?: PluginTranslateParams,
): string {
	let template: string | undefined;
	for (const candidate of getLocaleFallbackChain(locale)) {
		const found = tables[candidate]?.[key];
		if (typeof found === "string") {
			template = found;
			break;
		}
	}
	// The chain always ends at `en`, but a table may omit the key there too.
	return interpolate(template ?? key, params);
}

/**
 * Substitute `{name}` placeholders.
 *
 * An unknown placeholder is left verbatim rather than blanked, for the same reason a missing key
 * returns the key: a visible `{count}` says "a parameter was not passed", while a blank says
 * nothing at all. Substitution is single-pass, so a value containing `{other}` is not itself
 * scanned for placeholders — otherwise translated text could interpolate parameters the caller
 * never intended to expose.
 */
function interpolate(template: string, params?: PluginTranslateParams): string {
	if (!params) return template;
	return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
		const value = params[name];
		return value === undefined ? match : String(value);
	});
}

/** Normalize a raw language tag to one the tables can be keyed by. */
export function normalizePluginLocale(value: string | null | undefined): string {
	return normalizeLocale(value);
}
