import { NugProvider } from "./agent/nug-provider";
import { logger } from "./logger";
import { applyNugModelCatalogUpdate } from "./nug-model-sync";
import type { NUGProviderConfig } from "./settings";

/**
 * Process-wide coordinator for opportunistic NUG model-catalog refreshes.
 *
 * The model picker refreshes a gateway's catalog when it opens, because that is
 * what clears a stale "temporarily unavailable" flag (a refresh replaces the
 * cached list wholesale). Opening a menu is a cheap, frequent, implicit action
 * though, and every browser tab / narrator panel / user would otherwise hit the
 * upstream `/v1/models` independently.
 *
 * So the cooldown lives here, in the server process, not in the browser: this is
 * the only place all clients share. A per-tab guard can only deduplicate that
 * tab's own requests. Clients may still keep a local guard to avoid a pointless
 * HTTP round-trip, but this coordinator is authoritative.
 *
 * Two invariants matter:
 *  - The cooldown is consumed when an attempt *starts*, not when it succeeds, so
 *    a dead gateway is not hammered once per menu open.
 *  - Concurrent callers for the same provider share one in-flight promise, so a
 *    burst of menu opens produces exactly one upstream request.
 */

/** Minimum spacing between opportunistic refreshes of the same provider (ms). */
export const NUG_MODEL_REFRESH_COOLDOWN_MS = 60_000;

/** Upper bound on one opportunistic `/v1/models` fetch (ms). */
const NUG_MODEL_REFRESH_TIMEOUT_MS = 10_000;

export interface NugModelRefreshOutcome {
	providerId: string;
	/** True when this call actually issued an upstream request (success or failure). */
	attempted: boolean;
	/** Why no request was issued. */
	skipped?: "cooldown" | "not-configured";
	/** Milliseconds until this provider may be refreshed again. */
	retryAfterMs: number;
	/** Number of models in the refreshed catalog (only when `attempted` succeeded). */
	modelCount?: number;
	/** Upstream failure message (only when `attempted` failed). */
	error?: string;
}

interface FetchedNugCatalog {
	models: Array<Record<string, unknown>>;
	modelHash?: string;
	usdRate?: number;
}

export interface NugModelRefreshCoordinatorDeps {
	fetchModels: (config: NUGProviderConfig, signal: AbortSignal) => Promise<FetchedNugCatalog>;
	applyCatalog: (config: NUGProviderConfig, catalog: FetchedNugCatalog) => number;
	now?: () => number;
	cooldownMs?: number;
	timeoutMs?: number;
}

export interface NugModelRefreshCoordinator {
	/**
	 * Refresh one provider unless it is still inside its cooldown window.
	 * Concurrent calls for the same provider share a single upstream request.
	 */
	refreshIfStale(config: NUGProviderConfig): Promise<NugModelRefreshOutcome>;
	/** Refresh every enabled, fully-configured provider that is out of cooldown. */
	refreshAllIfStale(configs: NUGProviderConfig[]): Promise<NugModelRefreshOutcome[]>;
	/** Test helper: forget all cooldown/in-flight bookkeeping. */
	reset(): void;
}

interface ProviderRefreshState {
	lastAttemptAt: number;
	inflight?: Promise<NugModelRefreshOutcome>;
}

/**
 * A provider can only be refreshed when it has the credentials the request
 * needs. Skipping here keeps a half-configured gateway from burning its cooldown
 * on a request that is guaranteed to fail.
 */
function isRefreshable(config: NUGProviderConfig): boolean {
	return !config.disabled && !!config.apiKey?.trim() && !!config.baseUrl?.trim();
}

export function createNugModelRefreshCoordinator(
	deps: NugModelRefreshCoordinatorDeps,
): NugModelRefreshCoordinator {
	const now = deps.now ?? Date.now;
	const cooldownMs = deps.cooldownMs ?? NUG_MODEL_REFRESH_COOLDOWN_MS;
	const timeoutMs = deps.timeoutMs ?? NUG_MODEL_REFRESH_TIMEOUT_MS;
	const states = new Map<string, ProviderRefreshState>();

	const runRefresh = async (config: NUGProviderConfig): Promise<NugModelRefreshOutcome> => {
		try {
			const catalog = await deps.fetchModels(config, AbortSignal.timeout(timeoutMs));
			const modelCount = deps.applyCatalog(config, catalog);
			return { providerId: config.id, attempted: true, retryAfterMs: cooldownMs, modelCount };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			// Non-critical: the picker still renders the cached catalog. Log at debug
			// so a fully-down gateway does not spam the log once per menu open.
			logger.debug("NUG opportunistic model refresh failed", { provider: config.name, error });
			return { providerId: config.id, attempted: true, retryAfterMs: cooldownMs, error };
		}
	};

	const refreshIfStale = (config: NUGProviderConfig): Promise<NugModelRefreshOutcome> => {
		if (!isRefreshable(config)) {
			return Promise.resolve({
				providerId: config.id,
				attempted: false,
				skipped: "not-configured",
				retryAfterMs: 0,
			});
		}

		const state = states.get(config.id);
		// Join an in-flight refresh rather than starting a second upstream request.
		if (state?.inflight) return state.inflight;

		const elapsed = state ? now() - state.lastAttemptAt : Number.POSITIVE_INFINITY;
		if (elapsed < cooldownMs) {
			return Promise.resolve({
				providerId: config.id,
				attempted: false,
				skipped: "cooldown",
				retryAfterMs: Math.max(0, cooldownMs - elapsed),
			});
		}

		// Consume the cooldown before awaiting, so a failing or slow gateway cannot
		// be re-entered by the next caller.
		const nextState: ProviderRefreshState = { lastAttemptAt: now() };
		states.set(config.id, nextState);
		const inflight = runRefresh(config).finally(() => {
			// Only clear our own marker; a `reset()` mid-flight must not be undone.
			if (states.get(config.id) === nextState) nextState.inflight = undefined;
		});
		nextState.inflight = inflight;
		return inflight;
	};

	return {
		refreshIfStale,
		async refreshAllIfStale(configs) {
			const settled = await Promise.allSettled(configs.map((config) => refreshIfStale(config)));
			const outcomes: NugModelRefreshOutcome[] = [];
			for (const [index, result] of settled.entries()) {
				if (result.status === "fulfilled") {
					outcomes.push(result.value);
					continue;
				}
				// `refreshIfStale` converts upstream failures into outcomes, so a
				// rejection here means an unexpected bug; surface it without failing
				// the whole batch.
				const config = configs[index];
				outcomes.push({
					providerId: config?.id ?? "",
					attempted: true,
					retryAfterMs: cooldownMs,
					error: result.reason instanceof Error ? result.reason.message : String(result.reason),
				});
			}
			return outcomes;
		},
		reset() {
			states.clear();
		},
	};
}

export const nugModelRefreshCoordinator: NugModelRefreshCoordinator =
	createNugModelRefreshCoordinator({
		fetchModels: async (config, signal) => {
			const provider = new NugProvider(config);
			const { models, modelHash, hash, usdRate } = await provider.getModels({ signal });
			return { models, modelHash: modelHash ?? hash, usdRate };
		},
		applyCatalog: (config, catalog) => {
			const applied = applyNugModelCatalogUpdate(config, catalog.models, catalog.modelHash, {
				usdRate: catalog.usdRate,
			});
			return applied.models.length;
		},
	});
