import { unlink } from "node:fs/promises";
import type { QuotaSnapshot } from "@shared/quota-snapshot";
import { NugProvider } from "./agent/nug-provider";
import { getNarraforkPath } from "./narrafork-home";
import {
	streamQuotaCredential,
	streamQuotaIdentity,
	type UsageSubject,
} from "./provider-key-subjects";
import { getProviderKeyStore, nugKeyOwner, withProviderKey } from "./provider-keys";
import { type NUGProviderConfig, settings } from "./settings";
import { quotaNetworkIdentity } from "./sourcing/quota-identity";
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
	if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
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
		quotaBalance?: unknown;
		remaining?: unknown;
		totalGranted?: unknown;
		quotaTotalGranted?: unknown;
		total_granted?: unknown;
		total?: unknown;
		detailedQuotaBalance?: unknown;
		extra?: unknown;
	},
	existing?: NugQuotaCache,
): NugQuotaCache {
	const detailedQuotaBalance = nugQuotaDetailsFrom(data) ?? existing?.detailedQuotaBalance ?? null;
	return {
		balance:
			normalizeNullableNumber(data.balance ?? data.quotaBalance ?? data.remaining) ??
			existing?.balance ??
			null,
		totalGranted:
			normalizeNullableNumber(
				data.totalGranted ?? data.quotaTotalGranted ?? data.total_granted ?? data.total,
			) ??
			existing?.totalGranted ??
			null,
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

export const nugQuotaIdentity = (config: NUGProviderConfig): string =>
	JSON.stringify([config.baseUrl, config.apiKey, quotaNetworkIdentity(config, settings.proxy)]);
export type CapturedNugQuotaSubject = NugQuotaSubject & { identity: string };

/** The exact credential/network used by a route or startup request, captured before await. */
export function captureNugQuotaSubject(config: NUGProviderConfig): CapturedNugQuotaSubject {
	const credential = subject(config);
	return {
		...credential,
		config: structuredClone(credential.config),
		identity: nugQuotaIdentity(credential.config),
	};
}

const knownCredentialIds = new Map<string, Set<string>>();
function rememberCredential(providerId: string, credentialId: string): void {
	const ids = knownCredentialIds.get(providerId) ?? new Set<string>();
	ids.add(credentialId);
	knownCredentialIds.set(providerId, ids);
}

function snapshotOf(config: NUGProviderConfig): QuotaSnapshot | undefined {
	const credential = subject(config);
	rememberCredential(config.id, credential.id);
	return quotaStore.get(credential.id, nugQuotaIdentity(credential.config), restoreSnapshot);
}

export function setNugCachedQuota(
	providerId: string,
	cache: NugQuotaCache,
	expectedConfig?: NUGProviderConfig | CapturedNugQuotaSubject,
): void {
	const config = (settings.nugProviders ?? []).find((provider) => provider.id === providerId);
	if (!config) return;
	const credential = subject(config);
	if (expectedConfig) {
		const captured = "config" in expectedConfig;
		const expectedId = captured ? expectedConfig.id : subject(expectedConfig).id;
		const expectedIdentity = captured ? expectedConfig.identity : nugQuotaIdentity(expectedConfig);
		if (credential.id !== expectedId || nugQuotaIdentity(credential.config) !== expectedIdentity) {
			return;
		}
	}
	rememberCredential(providerId, credential.id);
	quotaStore.set(credential.id, nugQuotaIdentity(credential.config), nugQuotaSnapshot(cache));
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
	// Unlike the legacy HTTP response, a routing snapshot must not turn unknown into zero.
	return nugQuotaSnapshot(buildNugQuotaCache(data));
}

/** Update cached quota balance for a provider identified by prefix. */
export function updateNugQuotaByPrefix(
	prefix: string,
	quotaBalance: number | null,
	detailedQuotaBalance?: string | null,
	extra?: unknown,
	expectedProviderIdentity?: string,
	credentialId?: string,
): void {
	const config = (settings.nugProviders ?? []).find(
		(provider) => provider.prefix === prefix || provider.id === prefix,
	);
	if (!config || streamQuotaIdentity(config, credentialId) !== expectedProviderIdentity) return;
	const credential = streamQuotaCredential(config, credentialId);
	if (!credential) return;
	const identity = nugQuotaIdentity(credential.config);
	const snapshot = quotaStore.get(credential.id, identity, restoreSnapshot);
	const previous = snapshot && cacheFromSnapshot(snapshot);
	const cache = buildNugQuotaCache(
		{
			balance: quotaBalance,
			detailedQuotaBalance,
			...(extra !== undefined ? { extra } : {}),
		},
		previous,
	);
	rememberCredential(config.id, credential.id);
	quotaStore.set(credential.id, identity, nugQuotaSnapshot(cache));
}

function cacheFromSnapshot(snapshot: QuotaSnapshot): NugQuotaCache {
	return {
		...(snapshot.detail as Omit<NugQuotaCache, "fetchedAt">),
		fetchedAt: snapshot.fetchedAt,
	};
}

export function getNugCachedQuota(providerId: string): NugQuotaCache | undefined {
	const config = (settings.nugProviders ?? []).find((provider) => provider.id === providerId);
	const snapshot = config && snapshotOf(config);
	return snapshot && cacheFromSnapshot(snapshot);
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
		const credentialIds = new Set([
			...(knownCredentialIds.get(id) ?? []),
			...getProviderKeyStore()
				.list(nugKeyOwner(id))
				.map((key) => key.id),
			id,
		]);
		knownCredentialIds.delete(id);
		for (const credentialId of credentialIds) quotaStore.remove(credentialId);
	}
}
