import { RateLimitError } from "../lib/errors";
import { PUBLIC_SHARE_LIMITS as L } from "./public-narrator-share-limits";

const policies = {
	ip: { capacity: 120, refill: 2 },
	read: { capacity: 240, refill: 4 },
	post: { capacity: 20, refill: 0.2 },
	connect: { capacity: 30, refill: 0.5 },
} as const;
export type PublicShareRateKind = keyof typeof policies;

/** Separate IP and link buckets: changing either cannot reset the other. */
export class PublicShareRateLimiter {
	private stores = new Map<PublicShareRateKind, Map<string, { tokens: number; at: number }>>();
	private sweptAt = 0;

	consume(kind: PublicShareRateKind, requestedKey: string, now = Date.now()): void {
		if (now - this.sweptAt >= 60_000) {
			for (const store of this.stores.values()) {
				for (const [key, bucket] of store) {
					if (now - bucket.at >= L.rateExpiryMs) store.delete(key);
				}
			}
			this.sweptAt = now;
		}
		let store = this.stores.get(kind);
		if (!store) {
			store = new Map();
			this.stores.set(kind, store);
		}
		// Reserve one shared overflow bucket; never evict an attacker's exhausted key.
		const requested = requestedKey.slice(0, 128) || "unknown";
		const key = store.has(requested) || store.size < L.rateKeys - 1 ? requested : "overflow";
		const policy = policies[kind];
		const bucket = store.get(key) ?? { tokens: policy.capacity, at: now };
		bucket.tokens = Math.min(
			policy.capacity,
			bucket.tokens + (Math.max(0, now - bucket.at) * policy.refill) / 1000,
		);
		bucket.at = now;
		store.set(key, bucket);
		if (bucket.tokens < 1) {
			throw new RateLimitError(
				"PUBLIC_SHARE_RATE_LIMITED",
				((1 - bucket.tokens) * 1000) / policy.refill,
				"Too many sharing requests",
			);
		}
		bucket.tokens -= 1;
	}

	get size(): number {
		return [...this.stores.values()].reduce((sum, store) => sum + store.size, 0);
	}
}

export const publicShareRateLimiter = new PublicShareRateLimiter();
