/**
 * What is known about a key's allowance, for choosing keys.
 *
 * The quota store (sourcing/quota-store.ts) registers the one probe: a key whose snapshot
 * shows a window used up is blocked until that window refills, and the key pool skips it
 * until then instead of finding out from a failed request. Leaf module so the store and
 * the pool can both import it.
 */
type Probe = (keyId: string, now: number) => number | undefined;

const probes = new Set<Probe>();

export function registerKeyQuotaProbe(probe: Probe): () => void {
	probes.add(probe);
	return () => probes.delete(probe);
}

/** Epoch ms until which a key's allowance is known to be used up, if it is. */
export function keyQuotaBlockedUntil(keyId: string, now = Date.now()): number | undefined {
	let until: number | undefined;
	for (const probe of probes) {
		const value = probe(keyId, now);
		if (value !== undefined && value > now && (until === undefined || value > until)) until = value;
	}
	return until;
}
