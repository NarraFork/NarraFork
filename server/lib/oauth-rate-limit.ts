import type { Context, MiddlewareHandler } from "hono";
import { getClientIp } from "./client-ip";
import { RateLimitError } from "./errors";
import { hotSafe } from "./hot-safe";
import {
	countOAuthSecurityEvent,
	recordOAuthRateLimitTransition,
} from "./oauth-security-observability";

interface Bucket {
	tokens: number;
	updatedAt: number;
	lastSeenAt: number;
	limited: boolean;
}

interface RateLimitDecision {
	retryAfterMs: number;
	enteredLimitedState: boolean;
}

interface Policy {
	capacity: number;
	refillPerSecond: number;
}

export type OAuthRateLimitNamespace =
	| "authorize"
	| "token"
	| "revoke"
	| "external-read"
	| "external-write";

const POLICIES: Record<OAuthRateLimitNamespace, Policy> = {
	authorize: { capacity: 60, refillPerSecond: 1 },
	token: { capacity: 30, refillPerSecond: 0.5 },
	revoke: { capacity: 30, refillPerSecond: 0.5 },
	"external-read": { capacity: 240, refillPerSecond: 4 },
	"external-write": { capacity: 60, refillPerSecond: 1 },
};

const MAX_KEYS_PER_NAMESPACE = 4096;
const OVERFLOW_KEY = "__overflow__";
const stores = hotSafe(
	"narrafork.oauthRateLimit.stores",
	() => new Map<OAuthRateLimitNamespace, Map<string, Bucket>>(),
);
const counters = hotSafe<Record<OAuthRateLimitNamespace, { allowed: number; limited: number }>>(
	"narrafork.oauthRateLimit.counters",
	() => ({
		authorize: { allowed: 0, limited: 0 },
		token: { allowed: 0, limited: 0 },
		revoke: { allowed: 0, limited: 0 },
		"external-read": { allowed: 0, limited: 0 },
		"external-write": { allowed: 0, limited: 0 },
	}),
);

function storeFor(namespace: OAuthRateLimitNamespace): Map<string, Bucket> {
	let store = stores.get(namespace);
	if (!store) {
		store = new Map();
		stores.set(namespace, store);
	}
	return store;
}

function boundedKey(store: Map<string, Bucket>, requested: string): string {
	if (store.has(requested) || store.size < MAX_KEYS_PER_NAMESPACE) return requested;
	return OVERFLOW_KEY;
}

function consumeDecision(
	namespace: OAuthRateLimitNamespace,
	requestedKey: string,
	now = Date.now(),
): RateLimitDecision {
	const policy = POLICIES[namespace];
	const store = storeFor(namespace);
	const key = boundedKey(store, requestedKey.slice(0, 512) || "unknown");
	let bucket = store.get(key);
	if (!bucket) {
		bucket = { tokens: policy.capacity, updatedAt: now, lastSeenAt: now, limited: false };
		store.set(key, bucket);
	}
	const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1_000;
	bucket.tokens = Math.min(
		policy.capacity,
		bucket.tokens + elapsedSeconds * policy.refillPerSecond,
	);
	bucket.updatedAt = now;
	bucket.lastSeenAt = now;
	if (bucket.tokens >= 1) {
		bucket.tokens -= 1;
		bucket.limited = false;
		counters[namespace].allowed += 1;
		return { retryAfterMs: 0, enteredLimitedState: false };
	}
	const enteredLimitedState = !bucket.limited;
	bucket.limited = true;
	counters[namespace].limited += 1;
	countOAuthSecurityEvent("rate_limited");
	return {
		retryAfterMs: Math.ceil(((1 - bucket.tokens) / policy.refillPerSecond) * 1_000),
		enteredLimitedState,
	};
}

function requestKey(c: Context, includePrincipal: boolean): string {
	const ip = getClientIp(c) || "unknown";
	if (!includePrincipal) return `ip:${ip}`;
	const oauth = c.get("oauth");
	const user = c.get("user");
	return `ip:${ip}|client:${oauth?.clientId ?? "unknown"}|grant:${oauth?.grantId ?? "none"}|user:${user?.sub ?? "unknown"}`;
}

export function oauthRateLimit(
	namespace: OAuthRateLimitNamespace,
	options: { includePrincipal?: boolean } = {},
): MiddlewareHandler {
	return async (c, next) => {
		const includePrincipal = options.includePrincipal === true;
		const decision = consumeDecision(namespace, requestKey(c, includePrincipal));
		if (decision.retryAfterMs > 0) {
			if (decision.enteredLimitedState) {
				const oauth = includePrincipal ? c.get("oauth") : null;
				const user = includePrincipal ? c.get("user") : null;
				await recordOAuthRateLimitTransition({
					endpoint: namespace,
					bucketType: includePrincipal ? "principal" : "ip",
					clientId: oauth?.clientId,
					grantId: oauth?.grantId,
					userId: user?.sub,
					retryAfterSeconds: decision.retryAfterMs / 1_000,
				});
			}
			throw new RateLimitError(
				"OAUTH_RATE_LIMITED",
				decision.retryAfterMs,
				"OAuth request rate limited",
			);
		}
		await next();
	};
}

export function getOAuthRateLimitSnapshot() {
	return {
		maxKeysPerNamespace: MAX_KEYS_PER_NAMESPACE,
		namespaces: Object.fromEntries(
			(Object.keys(POLICIES) as OAuthRateLimitNamespace[]).map((namespace) => [
				namespace,
				{
					...counters[namespace],
					activeKeys: stores.get(namespace)?.size ?? 0,
				},
			]),
		),
	};
}

function resetNamespace(namespace: OAuthRateLimitNamespace): void {
	stores.delete(namespace);
	counters[namespace] = { allowed: 0, limited: 0 };
}

export const oauthRateLimitTesting = {
	consume: (namespace: OAuthRateLimitNamespace, requestedKey: string, now?: number): number =>
		consumeDecision(namespace, requestedKey, now).retryAfterMs,
	consumeDecision,
	resetNamespace,
};
