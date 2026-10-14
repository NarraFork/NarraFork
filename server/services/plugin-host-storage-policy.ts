import { STEWARD_BINDING_KEY, STEWARD_PLUGIN_ID } from "./steward-narrator-constants";

/** Host-managed delegation state must not be writable through generic plugin RPC. */
export function isHostManagedPluginStorageKey(pluginId: string, key: unknown): boolean {
	return (
		pluginId === STEWARD_PLUGIN_ID && typeof key === "string" && key.trim() === STEWARD_BINDING_KEY
	);
}
