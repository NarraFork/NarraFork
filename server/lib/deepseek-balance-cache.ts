import { type ProviderQuotaSnapshot, providerQuotaDataSchema } from "@shared/provider-quota";
import { providerQuotaService } from "../services/provider-quota-service";
import { settings } from "./settings";

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

/** Legacy route selection only; the source catalog owns discovery and transport. */
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
				// Exact decimal text is a validated generic amount field, not a raw provider payload.
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

function providerIds(): string[] {
	return (settings.customApiProviders ?? [])
		.filter((provider) => provider.apiKey && isDeepSeekCustomApiProvider(provider))
		.map(({ id }) => id);
}

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

export async function refreshDeepSeekBalance(
	providerId: string,
): Promise<DeepSeekBalanceCache | null> {
	if (!providerIds().includes(providerId)) return null;
	const snapshot = await providerQuotaService.refresh(providerId);
	return snapshot ? toDeepSeekBalanceCache(snapshot) : null;
}

export async function refreshAllDeepSeekBalances(options?: { manual?: boolean }): Promise<void> {
	// A sweep submits one job at a time rather than overflowing the shared bounded queue.
	for (const id of providerIds()) {
		const snapshot = await providerQuotaService.refresh(id, options);
		if (!snapshot && providerQuotaService.peek(id))
			throw new Error("Quota refresh did not complete");
	}
}

export function refreshStaleDeepSeekBalances(
	_maxAgeMs = DEEPSEEK_BALANCES_STALE_MS,
): Promise<void> {
	return providerQuotaService.refreshStale(providerIds());
}
