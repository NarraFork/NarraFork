import type { ProviderBalanceData, ProviderBalanceSnapshot } from "@shared/provider-balance";
import { type ProviderQuotaSnapshot, providerQuotaDataSchema } from "@shared/provider-quota";
import { providerQuotaService } from "../services/provider-quota-service";
import { hasSiteQuotaConfig } from "../services/provider-quota-sites";
import { isDeepSeekCustomApiProvider } from "./deepseek-balance-cache";
import { isKimiCustomApiProvider } from "./kimi-usage-cache";
import { isOpencodeCustomApiProvider } from "./opencode-usage-cache";
import { getProviderKeyStore } from "./provider-keys";
import { type CustomApiProviderConfig, settings } from "./settings";

export const PROVIDER_BALANCE_STALE_MS = 60_000;
export const PROVIDER_BALANCE_MANUAL_THROTTLE_MS = 10_000;

export function isProviderBalanceCandidate(config: CustomApiProviderConfig): boolean {
	const store = getProviderKeyStore();
	const credential =
		config.apiKey ||
		hasSiteQuotaConfig(config) ||
		(store.readable && store.list(config.id).some((key) => !key.disabled));
	return !!(
		!config.disabled &&
		credential &&
		config.baseUrl &&
		!isDeepSeekCustomApiProvider(config) &&
		!isKimiCustomApiProvider(config) &&
		!isOpencodeCustomApiProvider(config)
	);
}

export function toProviderBalanceSnapshot(
	snapshot: ProviderQuotaSnapshot,
): ProviderBalanceSnapshot {
	const parsed = providerQuotaDataSchema.safeParse(snapshot.data);
	const data =
		snapshot.status === "unavailable" || snapshot.status === "unsupported" || !parsed.success
			? null
			: parsed.data;
	const adapter =
		data?.format === "sub2api" || data?.format === "new-api" || data?.format === "new-api-user"
			? data.format
			: undefined;
	let balance: ProviderBalanceData | null = null;
	if (
		data &&
		adapter &&
		(data.scope === "wallet" || data.scope === "key" || data.scope === "subscription") &&
		typeof data.unlimited === "boolean"
	) {
		balance = {
			scope: data.scope,
			unlimited: data.unlimited,
			amounts: data.amounts.map((amount) => ({
				unit: amount.unit,
				remaining: amount.remaining,
				...(amount.used != null ? { used: amount.used } : {}),
				...(amount.total != null ? { total: amount.total } : {}),
				...(amount.window ? { window: amount.window } : {}),
				...(amount.windowStart ? { windowStart: amount.windowStart } : {}),
			})),
			...(data.planName ? { planName: data.planName } : {}),
			...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
		};
	}
	const invalidData =
		snapshot.status !== "unavailable" &&
		snapshot.status !== "unsupported" &&
		snapshot.data !== null &&
		!parsed.success;
	const error =
		snapshot.status === "unavailable" || snapshot.error === "unavailable"
			? "plugin_not_enabled"
			: invalidData
				? "invalid_response"
				: snapshot.error === "auth_failed" ||
						snapshot.error === "invalid_response" ||
						snapshot.error === "invalid_configuration"
					? snapshot.error
					: snapshot.error
						? "request_failed"
						: null;
	return {
		generation: snapshot.generation,
		status: balance
			? "supported"
			: snapshot.status === "unavailable" || invalidData
				? "error"
				: snapshot.status,
		...(adapter ? { adapter } : {}),
		balance,
		fetchedAt: snapshot.fetchedAt,
		attemptedAt: snapshot.attemptedAt,
		error,
	};
}

function isLegacyProvider(id: string): boolean {
	const config = (settings.customApiProviders ?? []).find((provider) => provider.id === id);
	return !!config && isProviderBalanceCandidate(config);
}

/** Kept for older callers only. All state, jobs and throttles belong to the one quota service. */
export const providerBalanceCache = {
	sync(): void {
		providerQuotaService.sync();
	},
	generations(): Record<string, string> {
		return Object.fromEntries(
			Object.entries(providerQuotaService.generations()).filter(([id]) => isLegacyProvider(id)),
		);
	},
	peek(id: string): ProviderBalanceSnapshot | null {
		if (!isLegacyProvider(id)) return null;
		const snapshot = providerQuotaService.peek(id);
		return snapshot ? toProviderBalanceSnapshot(snapshot) : null;
	},
	read(providerId?: string): Record<string, ProviderBalanceSnapshot> {
		return Object.fromEntries(
			providerQuotaService
				.list({ providerId, visible: isLegacyProvider, limit: 100 })
				.snapshots.map((snapshot) => [snapshot.providerId, toProviderBalanceSnapshot(snapshot)]),
		);
	},
	discoverPending(): void {
		void providerQuotaService
			.refreshStale(
				(settings.customApiProviders ?? []).filter(isProviderBalanceCandidate).map(({ id }) => id),
			)
			.catch(() => {});
	},
	manualRetryAfterMs(id: string): number {
		return providerQuotaService.manualRetryAfterMs(id);
	},
	async request(
		id: string,
		mode: "probe" | "refresh" = "probe",
	): Promise<ProviderBalanceSnapshot | null> {
		if (!isLegacyProvider(id)) return null;
		const snapshot = await providerQuotaService.refresh(id, { mode, manual: true });
		return snapshot ? toProviderBalanceSnapshot(snapshot) : null;
	},
};

export const getProviderBalanceGenerations = () => providerBalanceCache.generations();
export const syncProviderBalanceCache = () => providerBalanceCache.sync();
export const discoverPendingProviderBalances = () => providerBalanceCache.discoverPending();
