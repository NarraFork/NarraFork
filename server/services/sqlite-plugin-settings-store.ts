import type { Database } from "bun:sqlite";
import { logger } from "@server/lib/logger";
import {
	operationGuard,
	type PluginSettingsStore,
	PluginSettingsStoreError,
	type PluginStoreOperation,
} from "./plugin-settings-store";
import {
	commitPluginData,
	type PluginStorePlan,
	type PluginStoreRows,
	pageResources,
	pageSettings,
	readResource,
	readSetting,
} from "./plugin-settings-store-sql";

/** A caller-owned, guarded SQLite connection. Transactions contain only synchronous bounded SQL. */
export function createSqlitePluginSettingsStore(db: Database): PluginSettingsStore {
	function run<T>(plan: PluginStorePlan<T>, write: boolean, options?: PluginStoreOperation): T {
		const guard = operationGuard(options),
			start = performance.now();
		const drive = (): T => {
			guard.check();
			let next = plan.next(),
				steps = 0;
			while (!next.done) {
				if (++steps > 12) throw new PluginSettingsStoreError("PLUGIN_SETTINGS_STORE_INVALID");
				guard.check();
				const rows = db.query(next.value.text).all(...next.value.params) as PluginStoreRows;
				guard.check();
				next = plan.next(rows);
			}
			guard.check();
			return next.value;
		};
		try {
			return write ? db.transaction(drive).immediate() : drive();
		} catch (error) {
			if (error instanceof PluginSettingsStoreError || guard.signal.aborted) throw error;
			throw new PluginSettingsStoreError("PLUGIN_SETTINGS_STORE_UNAVAILABLE");
		} finally {
			guard.close();
			const elapsed = performance.now() - start;
			if (elapsed > 100)
				logger.warn("Slow plugin settings SQL operation", {
					backend: "sqlite",
					write,
					durationMs: Math.round(elapsed),
				});
		}
	}
	return {
		async getSetting(address, options) {
			return run(readSetting(address), false, options);
		},
		async listSettings(pluginId, options) {
			return run(pageSettings(pluginId, options), false, options);
		},
		async getResource(address, options) {
			return run(readResource(address), false, options);
		},
		async listResources(scope, options) {
			return run(pageResources(scope, options), false, options);
		},
		async commit(input, options) {
			return run(commitPluginData(input, "sqlite"), true, options);
		},
	};
}
