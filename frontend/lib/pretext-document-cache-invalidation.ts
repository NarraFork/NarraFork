/** Lightweight write-only boundary; invalidation must never load the lazy list. */
type CacheInvalidator = (narratorId: string) => void;

let owner: { invalidate: CacheInvalidator } | undefined;

/** The lazy cache installs its sole owner when (and only when) it is loaded. */
export function installPretextDocumentCacheInvalidator(invalidate: CacheInvalidator): () => void {
	const registration = { invalidate };
	owner = registration;
	return () => {
		// A stale HMR cleanup must not uninstall the replacement cache's owner.
		if (owner === registration) owner = undefined;
	};
}

/** With no loaded cache there is nothing to invalidate and no chunk to fetch. */
export function invalidateCachedPretextDocument(narratorId: string): void {
	owner?.invalidate(narratorId);
}
