import { STORAGE_RETENTION_TARGETS } from "@shared/storage-retention";
import { activeDatabaseBackend } from "../db";
import { getDbPath } from "../db/connection";
import { runEphemeralReadTask, runReadTask, WorkersUnavailableError } from "../lib/db-worker/pool";
import type { StorageHistoryReadParams } from "../lib/db-worker/storage-history-query";
import { AppError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";
import { settings, subscribeSettingsChanges } from "../lib/settings";
import { withDatabaseMaintenance } from "./database-cleanup-service";
import { createStorageHistoryService } from "./storage-history-service";
import { invalidateStorageCache } from "./storage-service";

function assertRetentionAdmission(): void {
	if (runtime.stopping) throw new Error("History retention is stopping");
}

async function read<T>(params: StorageHistoryReadParams, signal?: AbortSignal): Promise<T> {
	assertRetentionAdmission();
	const options = { signal, timeoutMs: 120_000 };
	try {
		return await runReadTask<T>(getDbPath(), params, options);
	} catch (error) {
		if (!(error instanceof WorkersUnavailableError) || error.reason === "pool_shutdown")
			throw error;
		assertRetentionAdmission();
		return runEphemeralReadTask<T>(getDbPath(), params, options);
	}
}

const runtime = hotSafe("storage-history-retention:runtime", () => ({
	service: createStorageHistoryService({
		journalPath: getNarraforkPath("storage-history-jobs.json"),
		policies: () => settings.storageRetention,
		read,
		clear: async (input) => {
			assertRetentionAdmission();
			const { clearStorageHistoryCandidate } = await import("./storage-history-mutations");
			assertRetentionAdmission();
			return clearStorageHistoryCandidate(input);
		},
		maintenance: (work) => {
			assertRetentionAdmission();
			return withDatabaseMaintenance(() => {
				assertRetentionAdmission();
				return work();
			});
		},
		onChanged: invalidateStorageCache,
	}),
	unsubscribe: null as (() => void) | null,
	stopping: false,
	pending: new Set<Promise<unknown>>(),
	shutdown: null as Promise<void> | null,
	shutdownSettled: false,
	shutdownFailed: false,
}));
// Preserve the existing hot-safe service when these lifecycle fields are first introduced.
runtime.stopping ??= false;
runtime.pending ??= new Set();
runtime.shutdown ??= null;
runtime.shutdownSettled ??= false;
runtime.shutdownFailed ??= false;

function trackRetentionWork<T>(work: Promise<T>): Promise<T> {
	runtime.pending.add(work);
	work.then(
		() => runtime.pending.delete(work),
		() => runtime.pending.delete(work),
	);
	return work;
}

export function getStorageHistoryService() {
	if (activeDatabaseBackend !== "sqlite") {
		throw new AppError(
			"History cleanup is available for SQLite",
			501,
			"HISTORY_CLEANUP_UNAVAILABLE",
		);
	}
	return runtime.service;
}

/** Register after recovery, once. Policies can change independently while the server is running. */
export function startStorageHistoryRetention(): Promise<void> {
	if (activeDatabaseBackend !== "sqlite" || runtime.stopping) return Promise.resolve();
	const service = runtime.service;
	return trackRetentionWork(
		(async () => {
			try {
				await service.startScheduler();
				if (runtime.stopping || runtime.unsubscribe) return;
				let previous = structuredClone(settings.storageRetention);
				runtime.unsubscribe = subscribeSettingsChanges(() => {
					if (runtime.stopping) return;
					const current = structuredClone(settings.storageRetention);
					const changed = STORAGE_RETENTION_TARGETS.filter(
						(target) => JSON.stringify(previous[target]) !== JSON.stringify(current[target]),
					);
					previous = current;
					if (!changed.length) return;
					// The service re-reads live policy inside its job locks, including rapid off/on changes.
					void trackRetentionWork(service.automatic(true, changed)).catch((error) =>
						logger.warn("Storage retention policy update failed", { error: String(error) }),
					);
				});
			} finally {
				// startScheduler may have been awaiting its journal when shutdown froze admission.
				if (runtime.stopping) service.stop();
			}
		})(),
	);
}

/** Freeze admission synchronously, then finish already-owned jobs within the caller's deadline. */
export function stopStorageHistoryRetention(
	options: { deadlineAt?: number; signal?: AbortSignal } = {},
): Promise<void> {
	runtime.stopping = true;
	runtime.unsubscribe?.();
	runtime.unsubscribe = null;
	runtime.service.stop();
	if (!runtime.shutdown) {
		runtime.shutdown = (async () => {
			while (runtime.pending.size) await Promise.allSettled([...runtime.pending]);
			runtime.service.stop();
			await runtime.service.settled();
		})();
		runtime.shutdown.then(
			() => {
				runtime.shutdownSettled = true;
			},
			() => {
				runtime.shutdownSettled = true;
				runtime.shutdownFailed = true;
			},
		);
	}
	if (options.signal?.aborted)
		return Promise.reject(
			options.signal?.reason ?? new DOMException("History retention cancelled", "AbortError"),
		);
	const remaining = (options.deadlineAt ?? Date.now() + 4_000) - Date.now();
	if (remaining <= 0) return Promise.reject(new Error("History retention did not drain"));
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	return Promise.race([
		runtime.shutdown,
		new Promise<never>((_resolve, reject) => {
			abort = () =>
				reject(
					options.signal?.reason ?? new DOMException("History retention cancelled", "AbortError"),
				);
			options.signal?.addEventListener("abort", abort, { once: true });
			timer = setTimeout(() => reject(new Error("History retention did not drain")), remaining);
		}),
	]).finally(() => {
		clearTimeout(timer);
		if (abort) options.signal?.removeEventListener("abort", abort);
	});
}

/** Content-free audit remains available after the worker pool and database have closed. */
export function getStorageHistoryShutdownSnapshot(): {
	stopped: boolean;
	pending: number;
	failed: boolean;
} {
	return {
		stopped: runtime.stopping,
		pending: runtime.pending.size + Number(Boolean(runtime.shutdown && !runtime.shutdownSettled)),
		failed: runtime.shutdownFailed,
	};
}
