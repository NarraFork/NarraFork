import { identifyService } from "@shared/sourcing/identify";
import { outboundFetch } from "./net/outbound-fetch";
import { resolveProxyForUrl } from "./net/proxy";
import { createPersistedCredentialCache } from "./persisted-credential-cache";
import { type CustomApiProviderConfig, settings } from "./settings";

export interface DeepSeekBalanceCache {
	generation: string;
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
	cache: DeepSeekBalanceCache;
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

// Persisted across restarts, but only restored under the same credential identity
// (see persisted-credential-cache.ts); the identity itself is never written.
const persisted = createPersistedCredentialCache("deepseek-balances.json", parsePersistedBalance);

function persistEntry(id: string, entry: Entry): void {
	if (entry.cache.fetchedAt === 0 || entry.cache.isAvailable === null) return;
	const { isAvailable, balanceInfos, fetchedAt, error } = entry.cache;
	persisted.save(id, entry.identity, { isAvailable, balanceInfos, fetchedAt, error });
}

export function isDeepSeekCustomApiProvider(config: {
	baseUrl?: string;
	disabled?: boolean;
}): boolean {
	return !config.disabled && identifyService(config).templateId === "deepseek";
}

function identity(config: CustomApiProviderConfig): string {
	return JSON.stringify([
		config.baseUrl,
		config.protocol,
		config.apiKey,
		config.proxy,
		config.tlsRejectUnauthorized,
		settings.proxy,
	]);
}

/** Reconcile on every read/refresh as well as settings writes. Old requests lose
 * their entry token, so even an abort-ignoring transport cannot publish a result. */
export function syncDeepSeekBalanceCache(): void {
	const providers = new Map(
		(settings.customApiProviders ?? [])
			.filter((p) => isDeepSeekCustomApiProvider(p) && p.apiKey)
			.map((p) => [p.id, p]),
	);
	for (const [id, entry] of entries) {
		const config = providers.get(id);
		if (!config || identity(config) !== entry.identity) {
			entries.delete(id);
			entry.controller?.abort();
			if (!config) persisted.remove(id);
		}
	}
	for (const [id, config] of providers) {
		if (!entries.has(id)) {
			const key = identity(config);
			const restored = persisted.restore(id, key);
			entries.set(id, {
				identity: key,
				cache: {
					generation: crypto.randomUUID(),
					isAvailable: restored?.isAvailable ?? null,
					balanceInfos: restored?.balanceInfos ?? [],
					fetchedAt: restored?.fetchedAt ?? 0,
					error: restored?.error ?? null,
				},
			});
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
	controller: AbortController,
): Promise<Pick<DeepSeekBalanceCache, "isAvailable" | "balanceInfos">> {
	const response = await outboundFetch(
		BALANCE_URL,
		{
			headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
			redirect: "error",
			signal: controller.signal,
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
	controller.signal.addEventListener("abort", cancelReader, { once: true });
	if (controller.signal.aborted) cancelReader();
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
		controller.signal.removeEventListener("abort", cancelReader);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export function refreshDeepSeekBalance(providerId: string): Promise<DeepSeekBalanceCache | null> {
	syncDeepSeekBalanceCache();
	const entry = entries.get(providerId);
	const config = settings.customApiProviders?.find((p) => p.id === providerId);
	if (!entry || !config) return Promise.resolve(null);
	if (entry.inFlight) return entry.inFlight;
	const snapshot = structuredClone(config);
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
			const payload = await Promise.race([fetchBalance(snapshot, controller), cancelled]);
			syncDeepSeekBalanceCache();
			if (entries.get(providerId) !== entry) return null;
			entry.cache = {
				...payload,
				generation: entry.cache.generation,
				fetchedAt: Date.now(),
				error: null,
			};
			persistEntry(providerId, entry);
		} catch {
			syncDeepSeekBalanceCache();
			if (entries.get(providerId) !== entry) return null;
			// Never copy transport exceptions, response text, or credentials to logs/API.
			entry.cache = {
				...entry.cache,
				fetchedAt: Date.now(),
				error: "DeepSeek balance request failed",
			};
			persistEntry(providerId, entry);
		} finally {
			clearTimeout(timer);
			entry.inFlight = undefined;
			entry.controller = undefined;
		}
		return entry.cache;
	})();
	return entry.inFlight;
}

export function getAllDeepSeekCachedBalances(): Record<string, DeepSeekBalanceCache> {
	syncDeepSeekBalanceCache();
	return Object.fromEntries([...entries].map(([id, entry]) => [id, entry.cache]));
}

/** Opaque, random runtime tokens only; never expose or derive them from credentials. */
export function getDeepSeekBalanceGenerations(): Record<string, string> {
	syncDeepSeekBalanceCache();
	return Object.fromEntries([...entries].map(([id, entry]) => [id, entry.cache.generation]));
}

export async function refreshAllDeepSeekBalances(): Promise<void> {
	syncDeepSeekBalanceCache();
	await Promise.allSettled([...entries.keys()].map(refreshDeepSeekBalance));
}

export async function refreshStaleDeepSeekBalances(
	maxAgeMs = DEEPSEEK_BALANCES_STALE_MS,
): Promise<void> {
	syncDeepSeekBalanceCache();
	const now = Date.now();
	await Promise.allSettled(
		[...entries]
			.filter(([, entry]) => !entry.cache.fetchedAt || now - entry.cache.fetchedAt >= maxAgeMs)
			.map(([id]) => refreshDeepSeekBalance(id)),
	);
}
