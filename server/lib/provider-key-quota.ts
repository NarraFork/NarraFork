/**
 * What usage caches know about a key's allowance, for choosing keys.
 *
 * A cache that has seen a key's window used up registers a probe answering "blocked
 * until when"; the key pool skips that key until then instead of finding out from a
 * failed request. Leaf module so caches and the pool can both import it.
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
