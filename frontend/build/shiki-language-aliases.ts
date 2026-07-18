export interface ShikiLanguageInfo {
	aliases?: readonly string[];
	id: string;
	import: unknown;
}

/**
 * Reduce Shiki's build-time loader registries to a tiny serializable
 * alias/id -> canonical asset id map for the browser bundle.
 */
export function createShikiLanguageAliasMap(
	languages: readonly ShikiLanguageInfo[],
	aliases: Readonly<Record<string, unknown>>,
): Record<string, string> {
	const canonicalByImporter = new Map<unknown, string>();
	const result: Record<string, string> = Object.create(null);

	for (const language of languages) {
		result[language.id.toLowerCase()] = language.id;
		canonicalByImporter.set(language.import, language.id);
	}

	for (const [alias, importer] of Object.entries(aliases)) {
		const canonical = canonicalByImporter.get(importer);
		if (canonical) result[alias.toLowerCase()] = canonical;
	}

	// The public alias registry is authoritative. Use info aliases only to map an
	// alias whose registry loader was wrapped and therefore lost function identity.
	for (const language of languages) {
		for (const alias of language.aliases ?? []) {
			if (Object.hasOwn(aliases, alias)) result[alias.toLowerCase()] = language.id;
		}
	}

	return Object.fromEntries(
		Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
	);
}
