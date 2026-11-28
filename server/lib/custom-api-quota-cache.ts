import { unlink } from "node:fs/promises";
import type { QuotaSnapshot } from "@shared/quota-snapshot";
import { providerQuotaService } from "../services/provider-quota-service";
import { getNarraforkPath } from "./narrafork-home";
import { credentialForStream, firstCredential } from "./provider-key-subjects";
import { getProviderKeyStore, withProviderKey } from "./provider-keys";
import { type CustomApiProviderConfig, settings } from "./settings";
import { quotaNetworkIdentity } from "./sourcing/quota-identity";
import { quotaStore, STREAM_QUOTA_SOURCE } from "./sourcing/quota-store";

export interface CustomApiQuotaCache {
	generation?: string;
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

/** Store identity for stream snapshots, distinct from the request-time stale-event guard. */
export const customApiStreamQuotaIdentity = (config: CustomApiProviderConfig): string =>
	JSON.stringify([config.baseUrl, config.apiKey, quotaNetworkIdentity(config, settings.proxy)]);
const knownCredentialIds = new Map<string, Set<string>>();
function rememberCredential(providerId: string, credentialId: string): void {
	let ids = knownCredentialIds.get(providerId);
	if (!ids) {
		ids = new Set();
		knownCredentialIds.set(providerId, ids);
	}
	ids.add(credentialId);
}

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
			...(cache.generation ? { generation: cache.generation } : {}),
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
		...(typeof detail.generation === "string" ? { generation: detail.generation } : {}),
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
	generation?: string,
): void {
	const config = (settings.customApiProviders ?? []).find((provider) => provider.prefix === prefix);
	if (!config) return;
	const credential = credentialForStream(config, expectedProviderIdentity);
	if (!credential) return;
	rememberCredential(config.id, credential.id);
	quotaStore.set(
		credential.id,
		customApiStreamQuotaIdentity(credential.config),
		customApiQuotaSnapshot({
			quotaBalance: normalizeQuotaBalance(quotaBalance),
			detailedQuotaBalance: normalizeDetailedQuotaBalance(detailedQuotaBalance),
			fetchedAt: Date.now(),
			...(generation ? { generation } : {}),
		}),
		true,
		STREAM_QUOTA_SOURCE,
	);
}

/** Stream allowances never overwrite the credential's direct probe slot. */
export function getCustomApiQuotaSnapshot(
	providerId: string,
	credentialId: string,
	expectedGeneration?: string,
): QuotaSnapshot | undefined {
	const config = provider(providerId);
	if (!config) return undefined;
	const keys = getProviderKeyStore().list(config.id);
	const key = keys.find((entry) => entry.id === credentialId);
	const effective = key
		? withProviderKey(config, key)
		: keys.length === 0 && credentialId === config.id
			? config
			: undefined;
	const snapshot =
		effective && !key?.disabled
			? quotaStore.get(
					credentialId,
					customApiStreamQuotaIdentity(effective),
					restoreSnapshot,
					STREAM_QUOTA_SOURCE,
				)
			: undefined;
	if (
		expectedGeneration &&
		(snapshot?.detail as CustomApiQuotaCache | undefined)?.generation !== expectedGeneration
	)
		return undefined;
	return snapshot;
}

export function getCustomApiCachedQuota(providerId: string): CustomApiQuotaCache | undefined {
	const config = provider(providerId);
	if (!config) return undefined;
	const current = providerQuotaService.peek(providerId);
	if (
		!current ||
		current.status === "unavailable" ||
		current.error === "unavailable" ||
		current.pushCompatible === false
	)
		return undefined;
	const credentialId = current.keyId ?? config.id;
	rememberCredential(providerId, credentialId);
	const snapshot = getCustomApiQuotaSnapshot(providerId, credentialId, current.generation);
	return snapshot
		? {
				...(snapshot.detail as Omit<CustomApiQuotaCache, "fetchedAt">),
				fetchedAt: snapshot.fetchedAt,
			}
		: undefined;
}

export function getAllCustomApiCachedQuotas(): Record<string, CustomApiQuotaCache> {
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
		const credentialIds = knownCredentialIds.get(id) ?? new Set<string>();
		credentialIds.add(config ? firstCredential(config).id : id);
		knownCredentialIds.delete(id);
		for (const credentialId of credentialIds) quotaStore.remove(credentialId, STREAM_QUOTA_SOURCE);
	}
}
