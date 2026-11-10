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

async function read<T>(params: StorageHistoryReadParams, signal?: AbortSignal): Promise<T> {
	const options = { signal, timeoutMs: 120_000 };
	try {
		return await runReadTask<T>(getDbPath(), params, options);
	} catch (error) {
		if (!(error instanceof WorkersUnavailableError) || error.reason === "pool_shutdown")
			throw error;
		return runEphemeralReadTask<T>(getDbPath(), params, options);
	}
}

const runtime = hotSafe("storage-history-retention:runtime", () => ({
	service: createStorageHistoryService({
		journalPath: getNarraforkPath("storage-history-jobs.json"),
		policies: () => settings.storageRetention,
		read,
		clear: async (input) => {
			const { clearStorageHistoryCandidate } = await import("./storage-history-mutations");
			return clearStorageHistoryCandidate(input);
		},
		maintenance: withDatabaseMaintenance,
		onChanged: invalidateStorageCache,
	}),
	unsubscribe: null as (() => void) | null,
}));

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
export async function startStorageHistoryRetention(): Promise<void> {
	if (activeDatabaseBackend !== "sqlite") return;
	const service = runtime.service;
	await service.startScheduler();
	if (runtime.unsubscribe) return;
	let previous = structuredClone(settings.storageRetention);
	runtime.unsubscribe = subscribeSettingsChanges(() => {
		const current = structuredClone(settings.storageRetention);
		const changed = STORAGE_RETENTION_TARGETS.filter(
			(target) => JSON.stringify(previous[target]) !== JSON.stringify(current[target]),
		);
		previous = current;
		if (!changed.length) return;
		// The service re-reads live policy inside its job locks, including rapid off/on changes.
		void service
			.automatic(true, changed)
			.catch((error) =>
				logger.warn("Storage retention policy update failed", { error: String(error) }),
			);
	});
}
