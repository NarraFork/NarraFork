import { unlink } from "node:fs/promises";
import type { QuotaSnapshot } from "@shared/quota-snapshot";
import { getNarraforkPath } from "./narrafork-home";
import { firstCredential, streamQuotaIdentity } from "./provider-key-subjects";
import { type CustomApiProviderConfig, settings } from "./settings";
import { quotaStore, STREAM_QUOTA_SOURCE } from "./sourcing/quota-store";

export interface CustomApiQuotaCache {
	quotaBalance: string | null;
	detailedQuotaBalance: string | null;
	fetchedAt: number;
}

// The plaintext file had no credential identity; future stream events rebuild the cache.
void unlink(getNarraforkPath("custom-api-quotas.json")).catch(() => {});

function normalizeQuotaBalance(value: unknown): string | null {
	if (value == null) return null;
	const balance = String(value).trim();
	return balance.length > 0 ? balance : null;
}

function normalizeDetailedQuotaBalance(value: unknown): string | null {
	return normalizeQuotaBalance(value);
}

const identity = (config: CustomApiProviderConfig) =>
	JSON.stringify([config.baseUrl, config.apiKey]);
const knownCredentialIds = new Map<string, string>();

function customApiQuotaSnapshot(cache: CustomApiQuotaCache): QuotaSnapshot {
	const remaining = cache.quotaBalance === null ? null : Number(cache.quotaBalance);
	return {
		fetchedAt: cache.fetchedAt,
		scope: "key",
		windows: [],
		balances:
			cache.quotaBalance === null
				? []
				: [
						{
							unit: "",
							remaining: remaining !== null && Number.isFinite(remaining) ? remaining : null,
						},
					],
		detail: {
			quotaBalance: cache.quotaBalance,
			detailedQuotaBalance: cache.detailedQuotaBalance,
		},
	};
}

function restoreSnapshot(snapshot: QuotaSnapshot): QuotaSnapshot | null {
	if (!snapshot.detail || typeof snapshot.detail !== "object") return null;
	const detail = snapshot.detail as Record<string, unknown>;
	return customApiQuotaSnapshot({
		quotaBalance: normalizeQuotaBalance(detail.quotaBalance),
		detailedQuotaBalance: normalizeDetailedQuotaBalance(detail.detailedQuotaBalance),
		fetchedAt: snapshot.fetchedAt,
	});
}

function provider(providerId: string): CustomApiProviderConfig | undefined {
	return (settings.customApiProviders ?? []).find((config) => config.id === providerId);
}

export function updateCustomApiQuotaByPrefix(
	prefix: string,
	quotaBalance: string | null,
	detailedQuotaBalance?: string | null,
	expectedProviderIdentity?: string,
): void {
	const config = (settings.customApiProviders ?? []).find((provider) => provider.prefix === prefix);
	if (!config || streamQuotaIdentity(config) !== expectedProviderIdentity) return;
	const credential = firstCredential(config);
	knownCredentialIds.set(config.id, credential.id);
	quotaStore.set(
		credential.id,
		identity(credential.config),
		customApiQuotaSnapshot({
			quotaBalance: normalizeQuotaBalance(quotaBalance),
			detailedQuotaBalance: normalizeDetailedQuotaBalance(detailedQuotaBalance),
			fetchedAt: Date.now(),
		}),
		true,
		STREAM_QUOTA_SOURCE,
	);
}

export function getCustomApiCachedQuota(providerId: string): CustomApiQuotaCache | undefined {
	const config = provider(providerId);
	if (!config) return undefined;
	const credential = firstCredential(config);
	knownCredentialIds.set(providerId, credential.id);
	const snapshot = quotaStore.get(
		credential.id,
		identity(credential.config),
		restoreSnapshot,
		STREAM_QUOTA_SOURCE,
	);
	return snapshot
		? {
				...(snapshot.detail as Omit<CustomApiQuotaCache, "fetchedAt">),
				fetchedAt: snapshot.fetchedAt,
			}
		: undefined;
}

export function getAllCustomApiCachedQuotas(): Record<
	string,
	{ quotaBalance: string | null; detailedQuotaBalance: string | null; fetchedAt: number }
> {
	const result: ReturnType<typeof getAllCustomApiCachedQuotas> = {};
	for (const config of settings.customApiProviders ?? []) {
		const cache = getCustomApiCachedQuota(config.id);
		if (cache) result[config.id] = cache;
	}
	return result;
}

export function purgeCustomApiQuotaCache(removedIds: string[]): void {
	for (const id of removedIds) {
		const config = provider(id);
		const credentialId = knownCredentialIds.get(id) ?? (config ? firstCredential(config).id : id);
		knownCredentialIds.delete(id);
		quotaStore.remove(credentialId, STREAM_QUOTA_SOURCE);
	}
}
