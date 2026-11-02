import type { ProviderBalanceAdapter, ProviderBalanceData } from "@shared/provider-balance";
import type { outboundFetch } from "./net/outbound-fetch";
import {
	type BalanceProbeResult,
	hasSiteQuotaConfig,
	NEW_API_USER_ADAPTER,
	probeProviderBalance,
	probeSiteQuota,
	refreshProviderBalance,
	refreshSiteQuota,
} from "./provider-balance-adapters";
import { createBalanceRequest } from "./provider-balance-transport";
import type { CustomApiProviderConfig } from "./settings";

/**
 * One key-balance query, expressed without the host's own transport.
 *
 * The cache owns scheduling, throttling, generations and persistence; the engine owns
 * "how do I ask this relay and how do I read its answer". Splitting them here is the
 * seam an out-of-process quota plugin uses: `builtinProviderBalanceEngine` is the
 * previous in-process behaviour, unchanged, and a plugin-backed engine can replace it
 * without the cache, the routes, the DTOs or the frontend knowing.
 */
export interface ProviderBalanceProbeInput {
	config: CustomApiProviderConfig;
	signal: AbortSignal;
	requestTimeoutMs?: number;
	fetch?: typeof outboundFetch;
}

export interface ProviderBalanceRefreshInput extends ProviderBalanceProbeInput {
	adapter: ProviderBalanceAdapter;
	root: string;
}

export interface ProviderBalanceQueryEngine {
	/** Stable, non-secret identifier used only for diagnostics. */
	readonly id: string;
	/** A `null` result means "this relay exposes no key allowance endpoint". */
	probe(input: ProviderBalanceProbeInput): Promise<BalanceProbeResult | null>;
	refresh(input: ProviderBalanceRefreshInput): Promise<ProviderBalanceData>;
}

/**
 * The historical in-process implementation: host transport (`outboundFetch`, proxy,
 * TLS flags, header filtering) plus the bundled sub2api/new-api adapters.
 *
 * A provider whose site-account credentials are configured takes the `/api/user/self` route
 * instead. That route is authoritative — it is the only one that answers with the account's
 * credit — so its failures propagate rather than falling back to the inference-key endpoints,
 * which would answer a different question.
 */
export const builtinProviderBalanceEngine: ProviderBalanceQueryEngine = {
	id: "builtin",
	probe({ config, signal, requestTimeoutMs, fetch }) {
		const request = createBalanceRequest(config, signal, { fetch, requestTimeoutMs });
		if (hasSiteQuotaConfig(config)) return probeSiteQuota(config, request);
		return probeProviderBalance(config.baseUrl, request);
	},
	refresh({ config, signal, requestTimeoutMs, fetch, adapter, root }) {
		const request = createBalanceRequest(config, signal, { fetch, requestTimeoutMs });
		if (adapter === NEW_API_USER_ADAPTER) return refreshSiteQuota(config, root, request);
		return refreshProviderBalance(adapter, root, request);
	},
};

let activeEngine: ProviderBalanceQueryEngine = builtinProviderBalanceEngine;

/** Composition root (`server/app.ts`) installs a plugin-backed engine when configured. */
export function setProviderBalanceEngine(engine: ProviderBalanceQueryEngine | null): void {
	activeEngine = engine ?? builtinProviderBalanceEngine;
}

export function getProviderBalanceEngine(): ProviderBalanceQueryEngine {
	return activeEngine;
}

export function resetProviderBalanceEngine(): void {
	activeEngine = builtinProviderBalanceEngine;
}
