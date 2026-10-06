export type ShikiLanguageAliasMap = Readonly<Record<string, string>>;

export type ShikiLanguageImporter = (canonicalId: string) => Promise<unknown>;
export type ShikiLanguageRegistrar = (language: unknown) => Promise<void> | void;

/** Resolve only ids and aliases emitted by the build-time Shiki manifest. */
export function resolveShikiLanguage(
	language: string,
	aliases: ShikiLanguageAliasMap,
): string | null {
	const normalized = language.trim().toLowerCase();
	if (!normalized || normalized === "text" || normalized === "plaintext") return null;
	if (normalized.includes("/") || normalized.includes("\\")) return null;
	return Object.hasOwn(aliases, normalized) ? aliases[normalized] : null;
}

function unwrapDefault(module: unknown): unknown {
	if (module && typeof module === "object" && "default" in module) {
		return (module as { default: unknown }).default;
	}
	return module;
}

/**
 * Create a canonical-id keyed loader. Aliases share the same in-flight promise;
 * failed loads are evicted so a later request can retry.
 */
export function createShikiLanguageEnsurer(
	aliases: ShikiLanguageAliasMap,
	importLanguage: ShikiLanguageImporter,
	registerLanguage: ShikiLanguageRegistrar,
): (language: string) => Promise<string | null> {
	const promises = new Map<string, Promise<string | null>>();

	return (language: string) => {
		const canonicalId = resolveShikiLanguage(language, aliases);
		if (!canonicalId) return Promise.resolve(null);

		const existing = promises.get(canonicalId);
		if (existing) return existing;

		const promise = importLanguage(canonicalId)
			.then(unwrapDefault)
			.then(async (registration) => {
				await registerLanguage(registration);
				return canonicalId;
			})
			.catch(() => null);
		promises.set(canonicalId, promise);
		void promise.then((result) => {
			if (result === null && promises.get(canonicalId) === promise) {
				promises.delete(canonicalId);
			}
		});
		return promise;
	};
}
