import { clearTimeout, setTimeout } from "node:timers";
import { hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import { waitForShutdownWork } from "@server/lib/shutdown-activity";

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

type RetryScheduler = (retry: () => void, delayMs: number) => () => void;

function scheduleRetry(retry: () => void, delayMs: number): () => void {
	const timer = setTimeout(retry, delayMs);
	// Auxiliary recovery must not keep a shutting-down process alive.
	timer.unref();
	return () => clearTimeout(timer);
}

/** Explicit startup owner: request reads never initiate or retry a history scan. */
export class BackgroundOccupancyInitializer {
	private inFlight: Promise<boolean> | null = null;
	private cancelRetry: (() => void) | null = null;
	private failures = 0;
	private initialized = false;
	private stopped = false;
	private failureCount = 0;
	private firstError: unknown;

	getShutdownState(): { pending: number; failureCount: number; firstError: unknown } {
		return {
			pending: this.inFlight ? 1 : 0,
			failureCount: this.failureCount,
			firstError: this.firstError,
		};
	}

	async drainForShutdown(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		while (this.inFlight) {
			await waitForShutdownWork(this.inFlight, signal);
			signal.throwIfAborted();
		}
	}

	constructor(
		private readonly initialize: () => Promise<void>,
		private readonly schedule: RetryScheduler = scheduleRetry,
		private readonly onFailure: (error: unknown, delayMs: number, attempt: number) => void = (
			error,
			delayMs,
			attempt,
		) => {
			logger.warn("Background occupancy initialization will retry", {
				error: String(error),
				delayMs,
				attempt,
			});
		},
	) {}

	/** Await only the current attempt; backoff never holds the startup barrier. */
	start(): Promise<boolean> {
		if (this.stopped) return Promise.resolve(false);
		if (this.initialized) return Promise.resolve(true);
		if (this.inFlight) return this.inFlight;
		// Recovery success/failure exits and hot reload may all ask to start. Keep
		// one timer and do not let repeated callers bypass its backoff.
		if (this.cancelRetry) return Promise.resolve(false);
		const work = Promise.resolve()
			.then(() => {
				if (!this.stopped) return this.initialize();
			})
			.then(() => {
				if (this.stopped) return false;
				this.initialized = true;
				return true;
			})
			.catch((error: unknown) => {
				if (this.stopped) {
					if (this.failureCount++ === 0) this.firstError = error;
					return false;
				}
				this.failures++;
				const delayMs = Math.min(
					INITIAL_RETRY_MS * 2 ** Math.min(this.failures - 1, 5),
					MAX_RETRY_MS,
				);
				this.cancelRetry = this.schedule(() => {
					this.cancelRetry = null;
					void this.start();
				}, delayMs);
				try {
					this.onFailure(error, delayMs, this.failures);
				} catch {
					// Diagnostic hooks cannot cancel recovery or fail the main startup.
				}
				return false;
			})
			.finally(() => {
				if (this.inFlight === work) this.inFlight = null;
			});
		this.inFlight = work;
		return work;
	}

	stop(): void {
		this.stopped = true;
		this.cancelRetry?.();
		this.cancelRetry = null;
	}
}

/** Even failures before recoverNarrators must not skip auxiliary initialization. */
export async function withBackgroundOccupancyInitialization<T>(
	recover: () => Promise<T>,
	initializer: BackgroundOccupancyInitializer | undefined,
): Promise<T> {
	try {
		return await recover();
	} finally {
		await initializer?.start();
	}
}

export const backgroundOccupancyInitializer = hotSafe(
	"narrafork:background-occupancy-initializer",
	() =>
		new BackgroundOccupancyInitializer(async () => {
			const { backgroundOccupancyStore } = await import("./background-occupancy-store");
			await backgroundOccupancyStore.start();
		}),
);
