import type { QuotaSnapshot } from "@shared/quota-snapshot";
import { identifyService } from "@shared/sourcing/identify";
import { outboundFetch } from "./net/outbound-fetch";
import { resolveProxyForUrl } from "./net/proxy";
import { firstCredential, type UsageSubject } from "./provider-key-subjects";
import { getProviderKeyStore, withProviderKey } from "./provider-keys";
import { type CustomApiProviderConfig, settings } from "./settings";
import { importLegacyQuotaCache, quotaStore } from "./sourcing/quota-store";

/**
 * DeepSeek account balances, stored and scheduled per credential. Omitting a credential id
 * preserves the historical first-key view; this module owns every request and identity check.
 */

export interface DeepSeekBalanceCache {
	isAvailable: boolean | null;
	balanceInfos: Array<{
		currency: string;
		totalBalance: string;
		grantedBalance: string;
		toppedUpBalance: string;
	}>;
	fetchedAt: number;
	error: string | null;
}

export const DEEPSEEK_BALANCES_STALE_MS = 60_000;
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const MAX_RESPONSE_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

interface Entry {
	identity: string;
	/** Opaque identity publication consumed by the existing model-options reader. */
	generation: string;
	providerId: string;
	credentialId: string;
	inFlight?: Promise<DeepSeekBalanceCache | null>;
	controller?: AbortController;
}

const entries = new Map<string, Entry>();

type PersistedBalance = Pick<
	DeepSeekBalanceCache,
	"isAvailable" | "balanceInfos" | "fetchedAt" | "error"
>;

function parsePersistedBalance(raw: unknown): PersistedBalance | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt)) return null;
	const parsed = parseDeepSeekBalanceResponse({
		is_available: value.isAvailable,
		balance_infos: Array.isArray(value.balanceInfos)
			? value.balanceInfos.map((info) => {
					const row = (info ?? {}) as Record<string, unknown>;
					return {
						currency: row.currency,
						total_balance: row.totalBalance,
						granted_balance: row.grantedBalance,
						topped_up_balance: row.toppedUpBalance,
					};
				})
			: value.balanceInfos,
	});
	return {
		...parsed,
		fetchedAt: value.fetchedAt,
		error: typeof value.error === "string" ? "DeepSeek balance request failed" : null,
	};
}

/** The file this cache used before the quota store; read once, then deleted. */
const LEGACY_FILE = "deepseek-balances.json";

function deepseekSnapshot(balance: PersistedBalance): QuotaSnapshot {
	const { isAvailable, balanceInfos, fetchedAt, error } = balance;
	return {
		fetchedAt,
		...(error !== null ? { error } : {}),
		scope: "wallet",
		windows: [],
		balances: balanceInfos.map((info) => ({
			unit: info.currency,
			remaining: Number(info.totalBalance),
		})),
		detail: { isAvailable, balanceInfos },
	};
}

/** A snapshot read from disk, rebuilt from its validated detail. */
function restoreSnapshot(snapshot: QuotaSnapshot): QuotaSnapshot | null {
	const balance = parsePersistedBalance({
		...(snapshot.detail as object),
		fetchedAt: snapshot.fetchedAt,
		error: snapshot.error ?? null,
	});
	return balance && deepseekSnapshot(balance);
}

function cacheOf(entry: Entry): DeepSeekBalanceCache {
	const snapshot = quotaStore.get(entry.credentialId, entry.identity, restoreSnapshot);
	const detail = snapshot?.detail as Pick<DeepSeekBalanceCache, "isAvailable" | "balanceInfos">;
	return {
		isAvailable: detail?.isAvailable ?? null,
		balanceInfos: detail?.balanceInfos ?? [],
		fetchedAt: snapshot?.fetchedAt ?? 0,
		error: snapshot?.error ?? null,
	};
}

function balanceSubject(providerId: string, credentialId?: string): UsageSubject | undefined {
	const config = settings.customApiProviders?.find((provider) => provider.id === providerId);
	if (!config || !isDeepSeekCustomApiProvider(config)) return;
	if (credentialId === undefined) return firstCredential(config);
	const keys = getProviderKeyStore().list(providerId);
	const key = keys.find((entry) => entry.id === credentialId);
	return key
		? { id: key.id, providerId, config: withProviderKey(config, key) }
		: keys.length === 0 && credentialId === providerId
			? { id: providerId, providerId, config }
			: undefined;
}

export function isDeepSeekQuotaRefreshing(providerId: string, credentialId?: string): boolean {
	syncDeepSeekBalanceCache();
	const subject = balanceSubject(providerId, credentialId);
	return !!subject && !!entries.get(subject.id)?.inFlight;
}

/** Explicit keys are independent; callers without an id retain the first-key view. */
export function getDeepSeekQuotaSnapshot(
	providerId: string,
	credentialId?: string,
): QuotaSnapshot | undefined {
	syncDeepSeekBalanceCache();
	const subject = balanceSubject(providerId, credentialId);
	const entry = subject && entries.get(subject.id);
	return entry ? quotaStore.get(entry.credentialId, entry.identity, restoreSnapshot) : undefined;
}

/** Never-fetched numbers are not worth a disk write. */
function store(entry: Entry, balance: PersistedBalance): void {
	quotaStore.set(
		entry.credentialId,
		entry.identity,
		deepseekSnapshot(balance),
		balance.fetchedAt !== 0 && balance.isAvailable !== null,
	);
}

/** One quota probe: fetch, then the shared snapshot shape. Throws on failure. */
export async function probeDeepSeekQuota(
	credential: UsageSubject,
	signal: AbortSignal,
): Promise<QuotaSnapshot> {
	const balance = await fetchBalance(credential.config, signal);
	return deepseekSnapshot({ ...balance, fetchedAt: Date.now(), error: null });
}

export function isDeepSeekCustomApiProvider(config: {
	baseUrl?: string;
	disabled?: boolean;
}): boolean {
	return !config.disabled && identifyService(config).templateId === "deepseek";
}

function identity(config: CustomApiProviderConfig, credentialId?: string): string {
	const network = credentialId ? getProviderKeyStore().get(credentialId)?.network : undefined;
	return JSON.stringify([
		config.baseUrl,
		config.protocol,
		config.apiKey,
		config.proxy,
		config.tlsRejectUnauthorized,
		settings.proxy,
		...(network ? [network] : []),
	]);
}

let legacyImported = false;

/** Reconcile on every read/refresh as well as settings writes. Old requests lose
 * their entry token, so even an abort-ignoring transport cannot publish a result. */
export function syncDeepSeekBalanceCache(): void {
	const providers = (settings.customApiProviders ?? []).filter(isDeepSeekCustomApiProvider);
	const subjects = new Map<string, UsageSubject>(
		providers.flatMap((provider) => {
			const keys = getProviderKeyStore().list(provider.id);
			const selected = keys.length
				? keys.map((key) => ({
						id: key.id,
						providerId: provider.id,
						config: withProviderKey(provider, key),
					}))
				: provider.apiKey
					? [firstCredential(provider)]
					: [];
			return selected.map((subject) => [subject.id, subject] as const);
		}),
	);
	if (!legacyImported) {
		legacyImported = true;
		void importLegacyQuotaCache(
			LEGACY_FILE,
			parsePersistedBalance,
			providers
				.filter((provider) => provider.apiKey)
				.map((provider) => {
					const first = firstCredential(provider);
					return {
						legacyKey: provider.id,
						id: first.id,
						// Legacy files belong only to the historical first credential.
						identity: identity(provider),
						storeIdentity: identity(first.config, first.id),
					};
				}),
			(balance) => (balance.isAvailable === null ? null : deepseekSnapshot(balance)),
		);
	}
	for (const [id, entry] of entries) {
		const subject = subjects.get(id);
		if (
			!subject ||
			identity(subject.config, subject.id) !== entry.identity ||
			subject.providerId !== entry.providerId
		) {
			entries.delete(id);
			entry.controller?.abort();
			if (subject) quotaStore.forget(entry.credentialId);
			else quotaStore.remove(entry.credentialId);
		}
	}
	for (const [id, subject] of subjects) {
		if (!entries.has(id)) {
			entries.set(id, {
				identity: identity(subject.config, subject.id),
				generation: crypto.randomUUID(),
				providerId: subject.providerId,
				credentialId: subject.id,
			});
			// Restore synchronously, as the old entry-creation did.
			quotaStore.get(id, identity(subject.config, subject.id), restoreSnapshot);
		}
	}
}

export function parseDeepSeekBalanceResponse(
	body: unknown,
): Pick<DeepSeekBalanceCache, "isAvailable" | "balanceInfos"> {
	if (!body || typeof body !== "object") throw new Error("Invalid balance response");
	const value = body as Record<string, unknown>;
	if (typeof value.is_available !== "boolean" || !Array.isArray(value.balance_infos)) {
		throw new Error("Invalid balance response");
	}
	const balanceInfos = value.balance_infos.map((item: unknown) => {
		if (!item || typeof item !== "object") throw new Error("Invalid balance response");
		const row = item as Record<string, unknown>;
		if (
			(row.currency !== "CNY" && row.currency !== "USD") ||
			![row.total_balance, row.granted_balance, row.topped_up_balance].every(
				(amount) => typeof amount === "string" && /^-?\d+(?:\.\d+)?$/.test(amount),
			)
		) {
			throw new Error("Invalid balance response");
		}
		return {
			currency: row.currency as string,
			totalBalance: row.total_balance as string,
			grantedBalance: row.granted_balance as string,
			toppedUpBalance: row.topped_up_balance as string,
		};
	});
	return { isAvailable: value.is_available, balanceInfos };
}

async function fetchBalance(
	config: CustomApiProviderConfig,
	signal: AbortSignal,
): Promise<Pick<DeepSeekBalanceCache, "isAvailable" | "balanceInfos">> {
	const response = await outboundFetch(
		BALANCE_URL,
		{
			headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
			redirect: "error",
			signal,
		},
		{
			proxyUrl: resolveProxyForUrl(BALANCE_URL, config.proxy),
			tlsRejectUnauthorized: config.tlsRejectUnauthorized,
			retryPolicy: "never",
		},
	);
	if (!response.ok) {
		void response.body?.cancel().catch(() => {});
		throw new Error("Balance request failed");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Invalid balance response");
	const cancelReader = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancelReader, { once: true });
	if (signal.aborted) cancelReader();
	let size = 0;
	const chunks: Uint8Array[] = [];
	try {
		const declaredSize = Number(response.headers.get("content-length"));
		if (declaredSize > MAX_RESPONSE_BYTES) throw new Error("Balance response too large");
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_RESPONSE_BYTES) throw new Error("Balance response too large");
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return parseDeepSeekBalanceResponse(JSON.parse(new TextDecoder().decode(bytes)));
	} finally {
		signal.removeEventListener("abort", cancelReader);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export function refreshDeepSeekBalance(
	providerId: string,
	credentialId?: string,
): Promise<DeepSeekBalanceCache | null> {
	syncDeepSeekBalanceCache();
	const subject = balanceSubject(providerId, credentialId);
	const entry = subject && entries.get(subject.id);
	if (!entry || !subject?.config.apiKey) return Promise.resolve(null);
	if (entry.inFlight) return entry.inFlight;
	const credential = { ...subject, config: structuredClone(subject.config) };
	const controller = new AbortController();
	entry.controller = controller;
	entry.inFlight = (async () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cancelled = new Promise<never>((_, reject) => {
			controller.signal.addEventListener("abort", () => reject(new Error("Cancelled")), {
				once: true,
			});
			timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		});
		try {
			const fresh = await Promise.race([
				probeDeepSeekQuota(credential, controller.signal),
				cancelled,
			]);
			syncDeepSeekBalanceCache();
			if (entries.get(credential.id) !== entry) return null;
			quotaStore.set(entry.credentialId, entry.identity, fresh);
		} catch {
			syncDeepSeekBalanceCache();
			if (entries.get(credential.id) !== entry) return null;
			// Never copy transport exceptions, response text, or credentials to logs/API.
			const previous = cacheOf(entry);
			store(entry, {
				...previous,
				fetchedAt: Date.now(),
				error: "DeepSeek balance request failed",
			});
		} finally {
			clearTimeout(timer);
			entry.inFlight = undefined;
			entry.controller = undefined;
		}
		return cacheOf(entry);
	})();
	return entry.inFlight;
}

/** Targeted read of the published runtime token; no catalog or all-provider projection. */
export function peekDeepSeekBalanceGeneration(providerId: string): string | undefined {
	const config = settings.customApiProviders?.find((provider) => provider.id === providerId);
	if (!config || !isDeepSeekCustomApiProvider(config)) return undefined;
	const credential = firstCredential(config);
	const entry = entries.get(credential.id);
	return entry?.identity === identity(credential.config, credential.id)
		? entry.generation
		: undefined;
}
export async function refreshAllDeepSeekBalances(): Promise<void> {
	syncDeepSeekBalanceCache();
	await Promise.allSettled(
		[...entries.values()].map((entry) =>
			refreshDeepSeekBalance(entry.providerId, entry.credentialId),
		),
	);
}

export async function refreshStaleDeepSeekBalances(
	maxAgeMs = DEEPSEEK_BALANCES_STALE_MS,
): Promise<void> {
	syncDeepSeekBalanceCache();
	const now = Date.now();
	await Promise.allSettled(
		[...entries]
			.filter(([, entry]) => {
				const { fetchedAt } = cacheOf(entry);
				return !fetchedAt || now - fetchedAt >= maxAgeMs;
			})
			.map(([, entry]) => refreshDeepSeekBalance(entry.providerId, entry.credentialId)),
	);
}
