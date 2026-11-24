import { unlink } from "node:fs/promises";
import type { QuotaSnapshot } from "@shared/quota-snapshot";
import { NugProvider } from "./agent/nug-provider";
import { getNarraforkPath } from "./narrafork-home";
import { streamQuotaIdentity, type UsageSubject } from "./provider-key-subjects";
import { getProviderKeyStore, nugKeyOwner, withProviderKey } from "./provider-keys";
import { type NUGProviderConfig, settings } from "./settings";
import { quotaStore } from "./sourcing/quota-store";

export interface NugQuotaCache {
	balance: number | null;
	totalGranted: number | null;
	detailedQuotaBalance: string | null;
	extra?: unknown;
	fetchedAt: number;
}

export type NugQuotaSubject = UsageSubject<NUGProviderConfig>;

// The plaintext cache carried no credential identity; drop it and probe again, as for Kimi.
void unlink(getNarraforkPath("nug-quotas.json")).catch(() => {});

function normalizeNullableNumber(value: unknown): number | null {
	if (value == null) return null;
	const numericValue = typeof value === "number" ? value : Number(value);
	return Number.isFinite(numericValue) ? numericValue : null;
}

function normalizeNullableString(value: unknown): string | null {
	if (value == null) return null;
	const text = String(value).trim();
	return text ? text : null;
}

function formatQuotaDetails(value: unknown): string | null {
	if (value == null) return null;
	if (typeof value === "string") return normalizeNullableString(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const lines = Object.entries(value as Record<string, unknown>)
			.filter(([, entryValue]) => entryValue != null)
			.map(([key, entryValue]) => {
				const formatted =
					typeof entryValue === "string" ||
					typeof entryValue === "number" ||
					typeof entryValue === "boolean"
						? String(entryValue)
						: JSON.stringify(entryValue);
				return `${key}: ${formatted}`;
			});
		return lines.length > 0 ? lines.join("\n") : null;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return null;
	}
}

function nugQuotaDetailsFrom(value: unknown): string | null {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	return formatQuotaDetails(record.detailedQuotaBalance) ?? formatQuotaDetails(record.extra);
}

export function normalizeNugQuotaResponse<T extends Record<string, unknown>>(
	data: T,
): T & {
	balance: number;
	totalGranted: number;
	detailedQuotaBalance: string | null;
} {
	return {
		...data,
		balance: normalizeNullableNumber(data.balance ?? data.quotaBalance ?? data.remaining) ?? 0,
		totalGranted:
			normalizeNullableNumber(
				data.totalGranted ?? data.quotaTotalGranted ?? data.total_granted ?? data.total,
			) ?? 0,
		detailedQuotaBalance: nugQuotaDetailsFrom(data),
	};
}

export function buildNugQuotaCache(
	data: {
		balance?: unknown;
		totalGranted?: unknown;
		detailedQuotaBalance?: unknown;
		extra?: unknown;
	},
	existing?: NugQuotaCache,
): NugQuotaCache {
	const detailedQuotaBalance = nugQuotaDetailsFrom(data) ?? existing?.detailedQuotaBalance ?? null;
	return {
		balance: normalizeNullableNumber(data.balance) ?? existing?.balance ?? null,
		totalGranted: normalizeNullableNumber(data.totalGranted) ?? existing?.totalGranted ?? null,
		detailedQuotaBalance,
		...(data.extra !== undefined
			? { extra: data.extra }
			: existing?.extra !== undefined
				? { extra: existing.extra }
				: {}),
		fetchedAt: Date.now(),
	};
}

function nugQuotaSnapshot(cache: NugQuotaCache): QuotaSnapshot {
	const { fetchedAt, ...detail } = cache;
	return {
		fetchedAt,
		scope: "wallet",
		windows: [],
		balances: [
			{
				unit: "",
				remaining: cache.balance,
				...(cache.totalGranted !== null ? { total: cache.totalGranted } : {}),
			},
		],
		detail,
	};
}

function restoreSnapshot(snapshot: QuotaSnapshot): QuotaSnapshot | null {
	if (!snapshot.detail || typeof snapshot.detail !== "object") return null;
	const detail = snapshot.detail as Record<string, unknown>;
	return nugQuotaSnapshot({
		balance: normalizeNullableNumber(detail.balance),
		totalGranted: normalizeNullableNumber(detail.totalGranted),
		detailedQuotaBalance: normalizeNullableString(detail.detailedQuotaBalance),
		...(detail.extra !== undefined ? { extra: detail.extra } : {}),
		fetchedAt: snapshot.fetchedAt,
	});
}

function subject(config: NUGProviderConfig): NugQuotaSubject {
	const key = getProviderKeyStore().list(nugKeyOwner(config.id))[0];
	return key
		? { id: key.id, providerId: config.id, config: withProviderKey(config, key) }
		: { id: config.id, providerId: config.id, config };
}

const identity = (config: NUGProviderConfig) => JSON.stringify([config.baseUrl, config.apiKey]);
const knownCredentialIds = new Map<string, string>();

function snapshotOf(config: NUGProviderConfig): QuotaSnapshot | undefined {
	const credential = subject(config);
	knownCredentialIds.set(config.id, credential.id);
	return quotaStore.get(credential.id, identity(credential.config), restoreSnapshot);
}

export function setNugCachedQuota(
	providerId: string,
	cache: NugQuotaCache,
	expectedConfig?: NUGProviderConfig,
): void {
	const config = (settings.nugProviders ?? []).find((provider) => provider.id === providerId);
	if (!config) return;
	const credential = subject(config);
	if (expectedConfig) {
		const expectedId =
			getProviderKeyStore().list(nugKeyOwner(expectedConfig.id))[0]?.id ?? expectedConfig.id;
		if (credential.id !== expectedId || identity(credential.config) !== identity(expectedConfig)) {
			return;
		}
	}
	knownCredentialIds.set(providerId, credential.id);
	quotaStore.set(credential.id, identity(credential.config), nugQuotaSnapshot(cache));
}

/** Fetch quota from a single NUG provider. */
export async function fetchNugQuota(config: NUGProviderConfig): Promise<{
	balance: number;
	totalGranted: number;
	detailedQuotaBalance?: string | null;
	extra?: unknown;
} | null> {
	const baseUrl = config.baseUrl
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/(?:api\/v1|api|v1)$/i, "");
	if (!baseUrl || !config.apiKey) return null;
	try {
		return await new NugProvider(config).getQuota();
	} catch {
		return null;
	}
}

/** One template probe; callers decide when to merge partial legacy responses. */
export async function probeNugQuota(
	credential: NugQuotaSubject,
	signal: AbortSignal,
): Promise<QuotaSnapshot> {
	const data = await new NugProvider(credential.config).getQuota(signal);
	return nugQuotaSnapshot(
		buildNugQuotaCache(normalizeNugQuotaResponse(data as unknown as Record<string, unknown>)),
	);
}

/** Update cached quota balance for a provider identified by prefix. */
export function updateNugQuotaByPrefix(
	prefix: string,
	quotaBalance: number | null,
	detailedQuotaBalance?: string | null,
	extra?: unknown,
	expectedProviderIdentity?: string,
): void {
	const config = (settings.nugProviders ?? []).find(
		(provider) => provider.prefix === prefix || provider.id === prefix,
	);
	if (!config || streamQuotaIdentity(config) !== expectedProviderIdentity) return;
	setNugCachedQuota(
		config.id,
		buildNugQuotaCache(
			{
				balance: quotaBalance,
				detailedQuotaBalance,
				...(extra !== undefined ? { extra } : {}),
			},
			getNugCachedQuota(config.id),
		),
	);
}

export function getNugCachedQuota(providerId: string): NugQuotaCache | undefined {
	const config = (settings.nugProviders ?? []).find((provider) => provider.id === providerId);
	const snapshot = config && snapshotOf(config);
	if (!snapshot) return undefined;
	return {
		...(snapshot.detail as Omit<NugQuotaCache, "fetchedAt">),
		fetchedAt: snapshot.fetchedAt,
	};
}

export function getAllNugCachedQuotas(): Record<
	string,
	{
		balance: number | null;
		totalGranted: number | null;
		detailedQuotaBalance: string | null;
		extra?: unknown;
	}
> {
	const result: ReturnType<typeof getAllNugCachedQuotas> = {};
	for (const config of settings.nugProviders ?? []) {
		const cache = getNugCachedQuota(config.id);
		if (!cache) continue;
		result[config.id] = {
			balance: cache.balance,
			totalGranted: cache.totalGranted,
			detailedQuotaBalance: cache.detailedQuotaBalance,
			...(cache.extra !== undefined ? { extra: cache.extra } : {}),
		};
	}
	return result;
}

export function purgeNugQuotaCache(removedIds: string[]): void {
	for (const id of removedIds) {
		const credentialId =
			knownCredentialIds.get(id) ?? getProviderKeyStore().list(nugKeyOwner(id))[0]?.id ?? id;
		knownCredentialIds.delete(id);
		quotaStore.remove(credentialId);
	}
}
