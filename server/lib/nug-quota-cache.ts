import { unlink } from "node:fs/promises";
import type { QuotaSnapshot } from "@shared/quota-snapshot";
import { NugProvider } from "./agent/nug-provider";
import { getNarraforkPath } from "./narrafork-home";
import { credentialForStream, type UsageSubject } from "./provider-key-subjects";
import { getProviderKeyStore, nugKeyOwner, withProviderKey } from "./provider-keys";
import { type NUGProviderConfig, settings } from "./settings";
import { quotaStore, STREAM_QUOTA_SOURCE } from "./sourcing/quota-store";

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

function subject(config: NUGProviderConfig, credentialId?: string): NugQuotaSubject | undefined {
	const keys = getProviderKeyStore().list(nugKeyOwner(config.id));
	const key =
		credentialId === undefined ? keys[0] : keys.find((entry) => entry.id === credentialId);
	return key
		? { id: key.id, providerId: config.id, config: withProviderKey(config, key) }
		: keys.length === 0 && (credentialId === undefined || credentialId === config.id)
			? { id: config.id, providerId: config.id, config }
			: undefined;
}

function identity(config: NUGProviderConfig, credentialId?: string): string {
	const network = credentialId ? getProviderKeyStore().get(credentialId)?.network : undefined;
	const route = [
		config.proxy,
		settings.proxy?.mode === "direct" ? undefined : settings.proxy,
		network,
	];
	// Network-free snapshots from earlier releases still restore under their original identity.
	return JSON.stringify(
		route.some((value) => value !== undefined)
			? [config.baseUrl, config.apiKey, ...route]
			: [config.baseUrl, config.apiKey],
	);
}
const knownCredentialIds = new Map<string, string>();

function snapshotOf(
	config: NUGProviderConfig,
	credentialId?: string,
	source?: typeof STREAM_QUOTA_SOURCE,
): QuotaSnapshot | undefined {
	const credential = subject(config, credentialId);
	if (!credential) return;
	if (credentialId === undefined) knownCredentialIds.set(config.id, credential.id);
	const key = identity(credential.config, credential.id);
	if (source === STREAM_QUOTA_SOURCE)
		return quotaStore.get(credential.id, key, restoreSnapshot, STREAM_QUOTA_SOURCE);
	const probe = quotaStore.get(credential.id, key, restoreSnapshot);
	if (credentialId !== undefined) return probe;
	// Only the legacy source-level view merges the current first key's two slots.
	const stream = quotaStore.get(credential.id, key, restoreSnapshot, STREAM_QUOTA_SOURCE);
	return stream && (!probe || stream.fetchedAt >= probe.fetchedAt) ? stream : probe;
}

/** No polling here: NUG is updated by streams, startup and explicit refresh. */
export function getNugQuotaSnapshot(
	providerId: string,
	credentialId?: string,
	source?: typeof STREAM_QUOTA_SOURCE,
): { credentialId: string; snapshot: QuotaSnapshot | undefined } | undefined {
	const config = (settings.nugProviders ?? []).find((provider) => provider.id === providerId);
	const credential = config && subject(config, credentialId);
	return credential && config
		? { credentialId: credential.id, snapshot: snapshotOf(config, credentialId, source) }
		: undefined;
}

const refreshes = new Map<
	string,
	{ identity: string; controller: AbortController; task: Promise<void> }
>();

export function isNugQuotaRefreshing(providerId: string, credentialId?: string): boolean {
	const config = settings.nugProviders?.find((provider) => provider.id === providerId);
	const credential = config && subject(config, credentialId);
	return (
		!!credential &&
		refreshes.get(credential.id)?.identity === identity(credential.config, credential.id)
	);
}

/** Explicit refresh, bounded and coalesced by the live credential identity. */
export function refreshNugQuota(providerId: string, credentialId?: string): Promise<void> {
	const config = (settings.nugProviders ?? []).find((provider) => provider.id === providerId);
	if (!config || config.disabled) return Promise.resolve();
	const credential = subject(config, credentialId);
	if (!credential?.config.apiKey) return Promise.resolve();
	const key = identity(credential.config, credential.id);
	const previous = refreshes.get(credential.id);
	if (previous?.identity === key) return previous.task;
	previous?.controller.abort();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	const current = () => {
		const liveConfig = (settings.nugProviders ?? []).find((p) => p.id === providerId);
		const live =
			liveConfig && !liveConfig.disabled ? subject(liveConfig, credential.id) : undefined;
		return (
			refreshes.get(credential.id)?.controller === controller &&
			!!live &&
			identity(live.config, live.id) === key
		);
	};
	const cancelled = new Promise<never>((_resolve, reject) => {
		controller.signal.addEventListener("abort", () => reject(new Error("quota_cancelled")), {
			once: true,
		});
	});
	const task = Promise.race([probeNugQuota(credential, controller.signal), cancelled])
		.then((snapshot) => {
			if (!controller.signal.aborted && current()) quotaStore.set(credential.id, key, snapshot);
		})
		.catch(() => {
			if (current()) {
				const old = quotaStore.get(credential.id, key, restoreSnapshot);
				quotaStore.set(
					credential.id,
					key,
					{
						scope: "wallet",
						windows: [],
						balances: [],
						...old,
						fetchedAt: Date.now(),
						error: "quota_unavailable",
					},
					false,
				);
			}
		})
		.finally(() => {
			clearTimeout(timer);
			if (refreshes.get(credential.id)?.controller === controller) refreshes.delete(credential.id);
		});
	refreshes.set(credential.id, { identity: key, controller, task });
	return task;
}

export function setNugCachedQuota(
	providerId: string,
	cache: NugQuotaCache,
	expectedConfig?: NUGProviderConfig,
): void {
	const config = (settings.nugProviders ?? []).find((provider) => provider.id === providerId);
	if (!config) return;
	const credential = subject(config);
	if (!credential) return;
	if (expectedConfig) {
		const expectedId =
			getProviderKeyStore().list(nugKeyOwner(expectedConfig.id))[0]?.id ?? expectedConfig.id;
		if (
			credential.id !== expectedId ||
			identity(credential.config, credential.id) !== identity(expectedConfig, credential.id)
		) {
			return;
		}
	}
	knownCredentialIds.set(providerId, credential.id);
	quotaStore.set(
		credential.id,
		identity(credential.config, credential.id),
		nugQuotaSnapshot(cache),
	);
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
	const connection = settings.nugProviders?.find((entry) => entry.id === credential.providerId);
	const data = await new NugProvider(credential.config, connection ?? credential.config).getQuota(
		signal,
	);
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
	if (!config) return;
	const credential = credentialForStream(config, expectedProviderIdentity, nugKeyOwner(config.id));
	if (!credential) return;
	const probe = quotaStore.get(
		credential.id,
		identity(credential.config, credential.id),
		restoreSnapshot,
	);
	const stream = quotaStore.get(
		credential.id,
		identity(credential.config, credential.id),
		restoreSnapshot,
		STREAM_QUOTA_SOURCE,
	);
	const previous = stream && (!probe || stream.fetchedAt >= probe.fetchedAt) ? stream : probe;
	quotaStore.set(
		credential.id,
		identity(credential.config, credential.id),
		nugQuotaSnapshot(
			buildNugQuotaCache(
				{
					balance: quotaBalance,
					detailedQuotaBalance,
					...(extra !== undefined ? { extra } : {}),
				},
				previous
					? {
							...(previous.detail as Omit<NugQuotaCache, "fetchedAt">),
							fetchedAt: previous.fetchedAt,
						}
					: undefined,
			),
		),
		true,
		STREAM_QUOTA_SOURCE,
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
		const ids = new Set([
			knownCredentialIds.get(id) ?? id,
			...getProviderKeyStore()
				.list(nugKeyOwner(id))
				.map((key) => key.id),
		]);
		knownCredentialIds.delete(id);
		for (const credentialId of ids) {
			const pending = refreshes.get(credentialId);
			refreshes.delete(credentialId);
			pending?.controller.abort();
			quotaStore.remove(credentialId);
			quotaStore.remove(credentialId, STREAM_QUOTA_SOURCE);
		}
	}
}
