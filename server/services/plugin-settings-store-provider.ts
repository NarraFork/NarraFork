import { selectReadBackend } from "@server/db/backend/read-selector";
import {
	assertWriteBackendMatchesRead,
	selectWriteBackend,
} from "@server/db/backend/write-selector";
import type { PluginSettingsStore } from "./plugin-settings-store";

let postgresStore: PluginSettingsStore | undefined;
let sqliteStore: Promise<PluginSettingsStore> | undefined;
/** Only the composition root supplies this backend. Does not create connections or migrate data. */
export function bindPostgresPluginSettingsStore(store: PluginSettingsStore | undefined): void {
	postgresStore = store;
}
export function selectPluginSettingsStoreBackend(
	config: { readBackend?: unknown; writeBackend?: unknown },
	pg?: PluginSettingsStore,
): "sqlite" | PluginSettingsStore {
	const selected = selectWriteBackend(config.writeBackend, { postgresAvailable: pg !== undefined });
	assertWriteBackendMatchesRead(selected, selectReadBackend(config.readBackend));
	if (selected.backend === "postgres") {
		if (!pg) throw new Error("Plugin settings PostgreSQL store is unavailable");
		return pg;
	}
	return "sqlite";
}
export async function getPluginSettingsStore(): Promise<PluginSettingsStore> {
	const selected = selectPluginSettingsStoreBackend(
		{ readBackend: process.env.NF_READ_BACKEND, writeBackend: process.env.NF_WRITE_BACKEND },
		postgresStore,
	);
	if (selected !== "sqlite") return selected;
	sqliteStore ??= (async () => {
		const [{ sqlite }, { createSqlitePluginSettingsStore }] = await Promise.all([
			import("@server/db"),
			import("./sqlite-plugin-settings-store"),
		]);
		return createSqlitePluginSettingsStore(sqlite);
	})();
	return sqliteStore;
}
