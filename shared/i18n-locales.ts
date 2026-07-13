export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type LocaleDirection = "ltr" | "rtl";

export const DEFAULT_LOCALE: Locale = "en";

interface LocaleDefinition {
	nativeName: string;
	englishName: string;
	direction: LocaleDirection;
	fallback: Locale | null;
	aliases: readonly string[];
	defaultForLanguage?: boolean;
}

export const LOCALE_DEFINITIONS: Readonly<Record<Locale, LocaleDefinition>> = {
	en: {
		nativeName: "English",
		englishName: "English",
		direction: "ltr",
		fallback: null,
		aliases: ["en-US", "en-GB"],
		defaultForLanguage: true,
	},
	"zh-CN": {
		nativeName: "简体中文",
		englishName: "Simplified Chinese",
		direction: "ltr",
		fallback: "en",
		aliases: ["zh", "zh-Hans", "zh-Hans-CN", "zh-SG"],
		defaultForLanguage: true,
	},
};

export type LocalizedValue<T> = { en: T } & Partial<Record<Exclude<Locale, "en">, T>>;

function canonicalizeLocaleTag(value: string): string {
	const normalized = value.trim().replaceAll("_", "-");
	if (!normalized) return "";
	try {
		return Intl.getCanonicalLocales(normalized)[0] ?? normalized;
	} catch {
		return normalized;
	}
}

function languageSubtag(value: string): string {
	return canonicalizeLocaleTag(value).split("-", 1)[0]?.toLowerCase() ?? "";
}

const localeLookup = new Map<string, Locale>();
const languageDefaults = new Map<string, Locale>();

for (const locale of SUPPORTED_LOCALES) {
	const definition = LOCALE_DEFINITIONS[locale];
	localeLookup.set(canonicalizeLocaleTag(locale).toLowerCase(), locale);
	for (const alias of definition.aliases) {
		localeLookup.set(canonicalizeLocaleTag(alias).toLowerCase(), locale);
	}
	if (definition.defaultForLanguage) {
		languageDefaults.set(languageSubtag(locale), locale);
	}
}

export function isSupportedLocale(value: string | null | undefined): value is Locale {
	if (!value) return false;
	const canonical = canonicalizeLocaleTag(value).toLowerCase();
	return SUPPORTED_LOCALES.some((locale) => locale.toLowerCase() === canonical);
}

export function normalizeLocale(
	value: string | null | undefined,
	fallback: Locale = DEFAULT_LOCALE,
): Locale {
	if (!value) return fallback;
	const canonical = canonicalizeLocaleTag(value);
	const exact = localeLookup.get(canonical.toLowerCase());
	if (exact) return exact;
	return languageDefaults.get(languageSubtag(canonical)) ?? fallback;
}

export function getLocaleFallbackChain(value: string | null | undefined): Locale[] {
	const result: Locale[] = [];
	const seen = new Set<Locale>();
	let current: Locale | null = normalizeLocale(value);

	while (current && !seen.has(current)) {
		result.push(current);
		seen.add(current);
		current = LOCALE_DEFINITIONS[current].fallback;
	}

	return result;
}

export function getLocaleDirection(value: string | null | undefined): LocaleDirection {
	return LOCALE_DEFINITIONS[normalizeLocale(value)].direction;
}

export function pickLocalizedValue<T>(
	value: LocalizedValue<T>,
	locale: string | null | undefined,
): T {
	for (const candidate of getLocaleFallbackChain(locale)) {
		const localized = value[candidate];
		if (localized !== undefined) return localized;
	}
	return value.en;
}

export const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string }> =
	SUPPORTED_LOCALES.map((locale) => ({
		value: locale,
		label: LOCALE_DEFINITIONS[locale].nativeName,
	}));
