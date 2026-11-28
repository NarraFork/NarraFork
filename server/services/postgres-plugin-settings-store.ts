import { logger } from "@server/lib/logger";
import type { SQL } from "bun";
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

/** Only the injected PostgreSQL pool is used; no SQLite import or fallback. */
export function createPostgresPluginSettingsStore(client: SQL): PluginSettingsStore {
	async function run<T>(
		plan: PluginStorePlan<T>,
		write: boolean,
		options?: PluginStoreOperation,
	): Promise<T> {
		const guard = operationGuard(options),
			start = performance.now();
		let rejectAbort!: (reason: unknown) => void;
		const aborted = new Promise<never>((_resolve, reject) => {
			rejectAbort = reject;
		});
		const onAbort = () => rejectAbort(guard.signal.reason);
		guard.signal.addEventListener("abort", onAbort, { once: true });
		try {
			guard.check();
			const transaction = client.begin(async (tx) => {
				const query = async (
					text: string,
					params: (string | number | null)[] = [],
				): Promise<PluginStoreRows> => {
					guard.check();
					let index = 0;
					const pending = tx.unsafe(
						text.replace(/\?/g, () => `$${++index}`),
						params,
					);
					const cancel = () => {
						try {
							pending.cancel();
						} catch {
							/* Await rollback, never report an unfinished write as successful. */
						}
					};
					guard.signal.addEventListener("abort", cancel, { once: true });
					try {
						const rows = await pending;
						guard.check();
						return Array.from(rows) as PluginStoreRows;
					} finally {
						guard.signal.removeEventListener("abort", cancel);
					}
				};
				if (!write) await query("SET TRANSACTION READ ONLY");
				await query("SET LOCAL statement_timeout = '2000ms'");
				await query("SET LOCAL lock_timeout = '100ms'");
				await query("SET LOCAL idle_in_transaction_session_timeout = '2000ms'");
				let next = plan.next(),
					steps = 0;
				while (!next.done) {
					if (++steps > 12) throw new PluginSettingsStoreError("PLUGIN_SETTINGS_STORE_INVALID");
					next = plan.next(await query(next.value.text, next.value.params));
				}
				guard.check();
				return next.value;
			});
			// Pool admission is asynchronous too. A late admission observes the same
			// aborted guard before issuing SQL; there is no second backend or replay.
			return await Promise.race([transaction, aborted]);
		} catch (error) {
			if (guard.signal.aborted) throw guard.signal.reason;
			if (error instanceof PluginSettingsStoreError) throw error;
			if ((error as { code?: string })?.code === "23505")
				throw new PluginSettingsStoreError("PLUGIN_SETTINGS_REVISION_CONFLICT");
			throw new PluginSettingsStoreError("PLUGIN_SETTINGS_STORE_UNAVAILABLE");
		} finally {
			guard.signal.removeEventListener("abort", onAbort);
			guard.close();
			const elapsed = performance.now() - start;
			if (elapsed > 100)
				logger.warn("Slow plugin settings SQL operation", {
					backend: "postgres",
					write,
					durationMs: Math.round(elapsed),
				});
		}
	}
	return {
		getSetting: (address, options) => run(readSetting(address), false, options),
		listSettings: (pluginId, options) => run(pageSettings(pluginId, options), false, options),
		getResource: (scope, options) => run(readResource(scope), false, options),
		listResources: (scope, options) => run(pageResources(scope, options), false, options),
		commit: (input, options) => run(commitPluginData(input, "postgres"), true, options),
	};
}
