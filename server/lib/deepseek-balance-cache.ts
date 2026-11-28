import { type ProviderQuotaSnapshot, providerQuotaDataSchema } from "@shared/provider-quota";
import type { QuotaSnapshot } from "@shared/quota-snapshot";
import { providerQuotaService, toQuotaSnapshot } from "../services/provider-quota-service";
import { usageSubjects } from "./provider-key-subjects";
import { type CustomApiProviderConfig, settings } from "./settings";
import { quotaNetworkIdentity } from "./sourcing/quota-identity";

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

/** Legacy view selection only; the source catalog owns discovery and transport. */
export function isDeepSeekCustomApiProvider(config: {
	baseUrl?: string;
	disabled?: boolean;
}): boolean {
	if (config.disabled || !config.baseUrl) return false;
	try {
		const url = new URL(config.baseUrl);
		return (
			url.protocol === "https:" &&
			url.hostname === "api.deepseek.com" &&
			!url.port &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			["/", "/v1", "/anthropic"].includes(url.pathname.replace(/\/$/, "") || "/")
		);
	} catch {
		return false;
	}
}

export function deepSeekQuotaIdentity(config: CustomApiProviderConfig): string {
	return JSON.stringify([
		config.baseUrl,
		config.protocol,
		config.apiKey,
		quotaNetworkIdentity(config, settings.proxy),
	]);
}

export function toDeepSeekBalanceCache(snapshot: ProviderQuotaSnapshot): DeepSeekBalanceCache {
	const parsed = providerQuotaDataSchema.safeParse(snapshot.data);
	const data =
		snapshot.status === "unavailable" || snapshot.status === "unsupported" || !parsed.success
			? null
			: parsed.data;
	const amounts = data?.amounts ?? [];
	return {
		generation: snapshot.generation,
		isAvailable: data?.available ?? null,
		balanceInfos: amounts
			.filter(
				(amount) =>
					(amount.unit === "CNY" || amount.unit === "USD") &&
					amount.id === `balance:${amount.unit}` &&
					amount.remaining !== null,
			)
			.map((amount) => ({
				currency: amount.unit,
				totalBalance: amount.remainingText ?? String(amount.remaining),
				grantedBalance: (() => {
					const detail = amounts.find(
						(item) => item.id === `granted:${amount.unit}` && item.unit === amount.unit,
					);
					return detail?.remainingText ?? String(detail?.remaining ?? "");
				})(),
				toppedUpBalance: (() => {
					const detail = amounts.find(
						(item) => item.id === `topped-up:${amount.unit}` && item.unit === amount.unit,
					);
					return detail?.remainingText ?? String(detail?.remaining ?? "");
				})(),
			})),
		fetchedAt: snapshot.fetchedAt,
		error:
			snapshot.error ||
			snapshot.status === "unavailable" ||
			snapshot.status === "unsupported" ||
			(snapshot.data !== null && !parsed.success)
				? "DeepSeek balance unavailable"
				: null,
	};
}

const deepSeekSubjects = () => usageSubjects(isDeepSeekCustomApiProvider);
const providerIds = () => [...new Set(deepSeekSubjects().map((subject) => subject.providerId))];

export function syncDeepSeekBalanceCache(): void {
	providerQuotaService.sync();
}

export function getAllDeepSeekCachedBalances(): Record<string, DeepSeekBalanceCache> {
	return Object.fromEntries(
		providerIds().flatMap((id) => {
			const snapshot = providerQuotaService.peek(id);
			return snapshot ? [[id, toDeepSeekBalanceCache(snapshot)]] : [];
		}),
	);
}

export function getDeepSeekBalanceGenerations(): Record<string, string> {
	const generations = providerQuotaService.generations();
	return Object.fromEntries(
		providerIds().flatMap((id) => (generations[id] ? [[id, generations[id]]] : [])),
	);
}

export const peekDeepSeekBalanceGeneration = (providerId: string): string | undefined =>
	providerQuotaService.peekGeneration(providerId);

export function getDeepSeekQuotaSnapshot(
	providerId: string,
	credentialId?: string,
): QuotaSnapshot | undefined {
	const snapshot = credentialId
		? providerQuotaService.peekKey(credentialId)
		: providerQuotaService.peek(providerId);
	return snapshot?.providerId === providerId ? toQuotaSnapshot(snapshot) : undefined;
}

export function isDeepSeekQuotaRefreshing(providerId: string, credentialId?: string): boolean {
	const snapshot = credentialId
		? providerQuotaService.peekKey(credentialId)
		: providerQuotaService.peek(providerId);
	return snapshot?.providerId === providerId && snapshot.status === "probing";
}

export async function refreshDeepSeekBalance(
	providerId: string,
	credentialId?: string,
): Promise<DeepSeekBalanceCache | null> {
	if (!providerIds().includes(providerId)) return null;
	if (
		credentialId &&
		!deepSeekSubjects().some((s) => s.id === credentialId && s.providerId === providerId)
	)
		return null;
	const snapshot = credentialId
		? await providerQuotaService.refreshKey(credentialId)
		: await providerQuotaService.refresh(providerId);
	return snapshot ? toDeepSeekBalanceCache(snapshot) : null;
}

export async function refreshAllDeepSeekBalances(options?: { manual?: boolean }): Promise<void> {
	for (const subject of deepSeekSubjects()) {
		const snapshot = await providerQuotaService.refreshKey(subject.id, options);
		if (!snapshot && providerQuotaService.peekKey(subject.id))
			throw new Error("Quota refresh did not complete");
	}
}

export function refreshStaleDeepSeekBalances(
	_maxAgeMs = DEEPSEEK_BALANCES_STALE_MS,
): Promise<void> {
	return providerQuotaService.refreshStale(providerIds());
}
