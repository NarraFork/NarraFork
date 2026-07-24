import { NugProvider } from "./agent/nug-provider";
import { logger } from "./logger";
import { getNugCachedModelsByProvider } from "./nug-model-cache";
import { applyNugModelCatalogUpdate } from "./nug-model-sync";
import { type NUGProviderConfig, settings } from "./settings";

/**
 * Instance-level shared poller that waits for temporarily-unavailable NUG models
 * to recover.
 *
 * When a narrator's request fails because the model's whole credential pool is
 * disabled (recoverable exhaustion), the agent loop suspends the turn instead of
 * retrying the full request (which would re-upload the entire conversation
 * history every time). The suspended narrator registers a waiter here; this
 * poller then periodically fetches ONLY the lightweight `/v1/models` list (no
 * chat history) for the affected NUG providers and resolves each waiter as soon
 * as its model reports available again.
 *
 * The poller is shared across the whole process: N suspended narrators waiting
 * on the same (or different) models share a single polling cadence, so the extra
 * network traffic is independent of how many narrators are waiting. Polling only
 * runs while there is at least one waiter, and stops when the last waiter leaves.
 */

/** How often to poll `/v1/models` while there is at least one waiter (ms). */
const POLL_INTERVAL_MS = 15_000;
/** Random jitter added to each interval to avoid thundering-herd polling (ms). */
const POLL_JITTER_MS = 5_000;
/**
 * Shorter delay for the very first poll after a waiter registers, so a model
 * that recovers quickly is picked up in a few seconds instead of waiting a full
 * {@link POLL_INTERVAL_MS} cycle. Subsequent polls use the normal interval.
 */
const FIRST_POLL_DELAY_MS = 3_000;

export type WaitOutcome = "available" | "aborted";

interface Waiter {
	waiterId: number;
	providerId: string;
	/** `channel:bareModel` id as it appears in `/v1/models`. */
	nugModelId: string;
	resolve: (outcome: WaitOutcome) => void;
	signal: AbortSignal;
	onAbort: () => void;
}

export interface WaitForModelAvailableOptions {
	providerId: string;
	/** `channel:bareModel` id as it appears in `/v1/models`. */
	nugModelId: string;
	signal: AbortSignal;
	/** Optional callback invoked once when polling detects recovery (before resolve). */
	onRecovered?: () => void;
}

export interface NugAvailabilityPoller {
	waitForModelAvailable(options: WaitForModelAvailableOptions): Promise<WaitOutcome>;
	/** Test/introspection helper: number of active waiters. */
	waiterCount(): number;
}

/**
 * Resolve whether a model is currently available in the local NUG model cache.
 * Returns:
 *  - `true`  when the model exists and is not flagged unavailable,
 *  - `false` when the model exists and is flagged unavailable,
 *  - `undefined` when the model is not in the cache (unknown — treat as not yet recovered).
 */
function cachedModelAvailability(providerId: string, nugModelId: string): boolean | undefined {
	const models = getNugCachedModelsByProvider(providerId);
	const hit = models.find((m) => String(m.id ?? "") === nugModelId);
	if (!hit) return undefined;
	// `available` is optional in the cache; when absent, treat as available
	// (older gateways that never sent the flag).
	return hit.available !== false;
}

class NugAvailabilityPollerImpl implements NugAvailabilityPoller {
	private waiters = new Map<number, Waiter>();
	private nextWaiterId = 1;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private polling = false;
	/** Optional broadcast hook, wired by the server to notify the frontend on changes. */
	private onAvailabilityChanged?: (providerId: string) => void;

	setAvailabilityChangeListener(fn: (providerId: string) => void): void {
		this.onAvailabilityChanged = fn;
	}

	waiterCount(): number {
		return this.waiters.size;
	}

	waitForModelAvailable(options: WaitForModelAvailableOptions): Promise<WaitOutcome> {
		const { providerId, nugModelId, signal, onRecovered } = options;

		// Fast path: already aborted, or already available in the cache.
		if (signal.aborted) return Promise.resolve<WaitOutcome>("aborted");
		if (cachedModelAvailability(providerId, nugModelId) === true) {
			return Promise.resolve<WaitOutcome>("available");
		}

		return new Promise<WaitOutcome>((resolve) => {
			const waiterId = this.nextWaiterId++;
			let settled = false;
			const settle = (outcome: WaitOutcome) => {
				if (settled) return;
				settled = true;
				const waiter = this.waiters.get(waiterId);
				if (waiter) {
					waiter.signal.removeEventListener("abort", waiter.onAbort);
					this.waiters.delete(waiterId);
				}
				this.maybeStopPolling();
				if (outcome === "available") onRecovered?.();
				resolve(outcome);
			};
			const onAbort = () => settle("aborted");
			const waiter: Waiter = {
				waiterId,
				providerId,
				nugModelId,
				resolve: settle,
				signal,
				onAbort,
			};
			this.waiters.set(waiterId, waiter);
			signal.addEventListener("abort", onAbort, { once: true });
			this.ensurePolling();
		});
	}

	private ensurePolling(): void {
		if (this.timer || this.waiters.size === 0) return;
		// First poll after going idle→active uses a short delay so a quick
		// recovery is detected promptly; steady-state polls use the full interval.
		this.scheduleNextPoll(true);
	}

	private maybeStopPolling(): void {
		if (this.waiters.size === 0 && this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private scheduleNextPoll(first = false): void {
		const delay = first
			? FIRST_POLL_DELAY_MS + Math.floor(Math.random() * POLL_JITTER_MS)
			: POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_JITTER_MS);
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.pollOnce();
		}, delay);
		this.timer.unref?.();
	}

	private async pollOnce(): Promise<void> {
		if (this.polling) {
			// A previous poll is still running; reschedule and skip.
			if (this.waiters.size > 0) this.scheduleNextPoll();
			return;
		}
		this.polling = true;
		try {
			// Distinct provider ids that currently have waiters.
			const providerIds = new Set<string>();
			for (const waiter of this.waiters.values()) providerIds.add(waiter.providerId);
			if (providerIds.size === 0) return;

			const configs = settings.nugProviders ?? [];
			await Promise.allSettled(
				[...providerIds].map((providerId) => {
					const config = configs.find((p) => p.id === providerId && !p.disabled);
					if (!config) return Promise.resolve();
					return this.refreshProviderModels(config);
				}),
			);

			// Resolve any waiter whose model is now available.
			for (const waiter of [...this.waiters.values()]) {
				if (cachedModelAvailability(waiter.providerId, waiter.nugModelId) === true) {
					waiter.resolve("available");
				}
			}
		} finally {
			this.polling = false;
			// Keep polling while waiters remain unresolved.
			if (this.waiters.size > 0) this.scheduleNextPoll();
		}
	}

	private async refreshProviderModels(config: NUGProviderConfig): Promise<void> {
		try {
			const provider = new NugProvider(config);
			const { models, modelHash, usdRate } = await provider.getModels();
			applyNugModelCatalogUpdate(config, models, modelHash, { usdRate });
			this.onAvailabilityChanged?.(config.id);
		} catch (err) {
			// Non-critical: a failed poll just means we retry next tick. Log at
			// debug to avoid spamming while a gateway is fully down.
			logger.debug("NUG availability poll failed", {
				provider: config.name,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

export const nugAvailabilityPoller: NugAvailabilityPollerImpl = new NugAvailabilityPollerImpl();
