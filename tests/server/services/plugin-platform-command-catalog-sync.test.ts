import { describe, expect, test } from "bun:test";
import {
	type PluginProviderCatalogRefresherLike,
	refreshCatalogsAfterCommandWrites,
} from "@server/services/plugin-platform-services";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";

function registryWithPluginProvider(pluginId = "com.example.demo") {
	const registry = new PluginProviderRegistry();
	registry.register({
		kind: "executable-plugin",
		pluginId,
		localId: "demo",
		providerTypeId: `${pluginId}/demo`,
		providerInstanceId: `${pluginId}/demo/1/hash`,
		providerPrefix: "demo",
		displayName: "Demo Provider",
		configSchema: {
			baseUrl: { type: "string" },
			credentials: { type: "string", writeOnly: true, "x-narrafork-secret": true },
		},
	});
	return registry;
}

function refresher(
	implementation: (providerInstanceId: string) => Promise<{ modelCount: number }>,
): { refresher: PluginProviderCatalogRefresherLike; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		refresher: {
			refresh: async (providerInstanceId) => {
				calls.push(providerInstanceId);
				const result = await implementation(providerInstanceId);
				return {
					providerInstanceId,
					providerPrefix: "demo",
					modelCount: result.modelCount,
					stale: false,
				};
			},
		},
	};
}

describe("refreshCatalogsAfterCommandWrites", () => {
	test("does nothing when no provider write was applied", async () => {
		const registry = registryWithPluginProvider();
		const { refresher: refresh, calls } = refresher(async () => ({ modelCount: 0 }));
		const results = await refreshCatalogsAfterCommandWrites({
			pluginId: "com.example.demo",
			appliedWrites: [],
			registry,
			refresher: refresh,
		});
		expect(results).toEqual([]);
		expect(calls).toEqual([]);
	});

	test("refreshes only the affected provider and deduplicates its writes", async () => {
		const registry = registryWithPluginProvider();
		registry.register({
			kind: "executable-plugin",
			pluginId: "com.example.other",
			localId: "demo",
			providerTypeId: "com.example.other/demo",
			providerInstanceId: "com.example.other/demo/1/hash",
			providerPrefix: "other-demo",
			displayName: "Other Provider",
		});
		const { refresher: refresh, calls } = refresher(async () => ({ modelCount: 3 }));
		const results = await refreshCatalogsAfterCommandWrites({
			pluginId: "com.example.demo",
			appliedWrites: [{ contributionId: "demo" }, { contributionId: "demo" }],
			registry,
			refresher: refresh,
		});
		expect(calls).toEqual(["com.example.demo/demo/1/hash"]);
		expect(results).toEqual([
			{ providerInstanceId: "com.example.demo/demo/1/hash", ok: true, modelCount: 3 },
		]);
	});

	test("reports a refresh failure without throwing away the applied write", async () => {
		const registry = registryWithPluginProvider();
		const { refresher: refresh, calls } = refresher(async () => {
			throw new Error("provider unavailable");
		});
		const results = await refreshCatalogsAfterCommandWrites({
			pluginId: "com.example.demo",
			appliedWrites: [{ contributionId: "demo" }],
			registry,
			refresher: refresh,
		});
		expect(calls).toEqual(["com.example.demo/demo/1/hash"]);
		expect(results).toEqual([
			{
				providerInstanceId: "com.example.demo/demo/1/hash",
				ok: false,
				error: "provider unavailable",
			},
		]);
	});

	test("an in-band refresh error is reported as a failure, not as ok with the old count", async () => {
		// This is the shape the production refresher actually produces for an unreachable
		// provider: it settles with { stale: true, error } and leaves the previous catalog
		// in place, so modelCount still holds the *pre-write* value. Reporting that as
		// ok: true would tell the UI the new list converged when nothing refreshed at all.
		const registry = registryWithPluginProvider();
		const calls: string[] = [];
		const refresh: PluginProviderCatalogRefresherLike = {
			refresh: async (providerInstanceId) => {
				calls.push(providerInstanceId);
				return {
					providerInstanceId,
					providerPrefix: "demo",
					modelCount: 7,
					stale: true,
					error: "provider unavailable",
				};
			},
		};
		const results = await refreshCatalogsAfterCommandWrites({
			pluginId: "com.example.demo",
			appliedWrites: [{ contributionId: "demo" }],
			registry,
			refresher: refresh,
		});
		expect(calls).toEqual(["com.example.demo/demo/1/hash"]);
		expect(results).toEqual([
			{
				providerInstanceId: "com.example.demo/demo/1/hash",
				ok: false,
				error: "provider unavailable",
			},
		]);
	});
});
