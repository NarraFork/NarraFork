import { describe, expect, test } from "bun:test";
import { type Manifest, type ManifestInput, parseManifest } from "@server/lib/plugins/manifest";
import type {
	PluginCatalogPlugin,
	PluginCatalogSnapshot,
	PluginPackageSummary,
} from "@server/services/plugin-catalog";
import {
	PluginContributionCoordinator,
	type PluginContributionLifecycleState,
} from "@server/services/plugin-contribution-coordinator";
import { PluginContributionRegistry } from "@server/services/plugin-contribution-registry";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";
import { PluginToolRegistry } from "@server/services/plugin-tool-registry";

/**
 * Provider contributions must follow the same four lifecycle points the tool
 * registry already follows during a contribution refresh:
 *
 *   1. plugin left the catalog        → removed
 *   2. manifest unavailable/mismatch  → marked unavailable
 *   3. manifest generation changed    → replaced
 *   4. lifecycle available/disabled   → enabled / disabled
 *
 * Before this wiring existed, `pluginProviderRegistry.register()` was never called
 * from the plugin lifecycle at all, so provider plugins could be installed but
 * never resolved. These tests pin each transition.
 */

const pluginId = "com.example.provider-sync";
const hash = "c".repeat(64);

function manifestInput(
	overrides: { version?: string; providerPrefix?: string } = {},
): ManifestInput {
	return {
		schemaVersion: 1,
		pluginId,
		version: overrides.version ?? "1.0.0",
		displayName: "Provider sync fixture",
		engine: {
			runtime: "bun",
			hostApi: ">=1.0 <2",
			rpc: "narrafork.rpc/1",
			runner: "local-process",
		},
		server: {
			entry: "server/index.js",
			transport: "stdio",
			protocol: "narrafork.rpc/1",
			args: [],
			workingDirectory: "package",
		},
		activationEvents: ["onProvider:demo"],
		contributes: {
			providers: [
				{
					id: "demo",
					title: "Demo Provider",
					description: "Provider used to pin coordinator sync behaviour.",
					providerPrefix: overrides.providerPrefix ?? "demo",
					defaultModelId: "demo/base",
					modelDiscovery: true,
					sessionMode: "stateless",
					capabilities: { chat: true, generate: false, mayLeakXmlToolCalls: true },
					limits: { maxConcurrentChat: 3 },
					configSchema: { apiKey: { type: "string" } },
				},
			],
			tools: [],
			commands: [],
			events: [],
			views: [],
		},
		permissions: {
			host: ["provider.register", "provider.use"],
			network: { mode: "none", allow: [] },
			filesystem: { package: "readOnly", pluginData: "readWrite", workspace: "none" },
			process: { spawn: "none" },
		},
		secrets: [],
		dependencies: { plugins: {}, runtime: {} },
	};
}

function snapshotFor(manifest: Manifest): PluginCatalogSnapshot {
	const packageSummary: PluginPackageSummary = {
		pluginId,
		version: manifest.version,
		hash,
		path: `/virtual/plugins/${pluginId}/${manifest.version}`,
		status: "compatible",
		isCurrent: true,
		manifest: {
			schemaVersion: manifest.schemaVersion,
			pluginId,
			version: manifest.version,
			displayName: manifest.displayName,
			engine: manifest.engine,
			server: { entry: manifest.server?.entry ?? "server/index.js", protocol: "narrafork.rpc/1" },
			activationEvents: [...manifest.activationEvents],
		},
		contributions: [],
		diagnostics: [],
	};
	const plugin: PluginCatalogPlugin = {
		pluginId,
		status: "compatible",
		current: { version: manifest.version, hash },
		packages: [packageSummary],
		contributions: [],
		diagnostics: [],
	};
	return {
		generatedAt: "2026-07-30T00:00:00.000Z",
		plugins: [plugin],
		packages: [packageSummary],
		diagnostics: [],
	};
}

function emptySnapshot(): PluginCatalogSnapshot {
	return { generatedAt: "2026-07-30T00:00:01.000Z", plugins: [], packages: [], diagnostics: [] };
}

function lifecycle(
	desiredState: PluginContributionLifecycleState["desiredState"],
): readonly PluginContributionLifecycleState[] {
	return [{ pluginId, desiredState, runtimeState: "inactive", compatibility: "compatible" }];
}

function harness(manifest: Manifest) {
	const providerRegistry = new PluginProviderRegistry();
	const coordinator = new PluginContributionCoordinator({
		contributionRegistry: new PluginContributionRegistry(),
		toolRegistry: new PluginToolRegistry({
			capabilityBroker: { authorize: async () => ({ allowed: true as const }) },
		}),
		providerRegistry,
		manifestLoader: async () => manifest,
	});
	return { providerRegistry, coordinator };
}

function pluginEntries(registry: PluginProviderRegistry) {
	return registry.list().filter((entry) => entry.pluginId === pluginId);
}

describe("provider contribution sync", () => {
	test("registers manifest providers on the first refresh", async () => {
		const manifest = parseManifest(manifestInput());
		const { providerRegistry, coordinator } = harness(manifest);

		const report = await coordinator.initialize(snapshotFor(manifest), {
			lifecycleStates: lifecycle("enabled"),
		});

		expect(report.providerCount).toBe(1);
		const [entry] = pluginEntries(providerRegistry);
		expect(entry.kind).toBe("executable-plugin");
		expect(entry.providerPrefix).toBe("demo");
		expect(entry.localId).toBe("demo");
		expect(entry.providerTypeId).toBe(`${pluginId}/demo`);
		expect(entry.defaultModelId).toBe("demo/base");
		// Static manifest capabilities reach the registry without starting the plugin.
		expect(entry.capabilities.chat).toBe(true);
		expect(entry.capabilities.generate).toBe(false);
		expect(entry.capabilities.mayLeakXmlToolCalls).toBe(true);
		expect(entry.limits?.maxConcurrentChat).toBe(3);
		// A manifest configSchema is a properties map; the host wraps it for validation.
		expect(providerRegistry.validateConfig(entry.providerInstanceId, { apiKey: "k" }).valid).toBe(
			true,
		);
		expect(providerRegistry.validateConfig(entry.providerInstanceId, { nope: 1 }).valid).toBe(
			false,
		);
	});

	test("resolves a model value through the registered prefix", async () => {
		const manifest = parseManifest(manifestInput());
		const { providerRegistry, coordinator } = harness(manifest);
		await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle("enabled") });

		// The point of registration: `prefix:model` now resolves to this plugin.
		const resolution = providerRegistry.resolveProvider("demo:demo/base", {
			createAdapter: false,
		});
		expect(resolution.providerTypeId).toBe(`${pluginId}/demo`);
		expect(resolution.modelId).toBe("demo/base");
	});

	test("removes providers when the plugin leaves the catalog", async () => {
		const manifest = parseManifest(manifestInput());
		const { providerRegistry, coordinator } = harness(manifest);
		await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle("enabled") });
		expect(pluginEntries(providerRegistry)).toHaveLength(1);

		const report = await coordinator.uninstall(emptySnapshot(), {
			lifecycleStates: [],
		});

		expect(report.providerCount).toBe(0);
		expect(pluginEntries(providerRegistry)).toHaveLength(0);
	});

	test("reports providers unavailable while the plugin is disabled", async () => {
		const manifest = parseManifest(manifestInput());
		const { providerRegistry, coordinator } = harness(manifest);
		await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle("enabled") });

		await coordinator.disable(snapshotFor(manifest), { lifecycleStates: lifecycle("disabled") });

		const [disabled] = pluginEntries(providerRegistry);
		expect(disabled.status).toBe("unavailable");
		// Resolution must fail rather than hand back an adapter for a disabled plugin.
		expect(() => providerRegistry.resolveProvider("demo:demo/base")).toThrow();

		await coordinator.enable(snapshotFor(manifest), { lifecycleStates: lifecycle("enabled") });
		const [enabled] = pluginEntries(providerRegistry);
		expect(enabled.status).toBe("available");
	});

	test.each([
		"active",
		"disabled",
	] as const)("uses lifecycle state after manifest loading when it changes to %s", async (nextState) => {
		const manifest = parseManifest(manifestInput());
		const providerRegistry = new PluginProviderRegistry();
		let states: readonly PluginContributionLifecycleState[] = lifecycle("enabled");
		let blockLoad = false;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const coordinator = new PluginContributionCoordinator({
			contributionRegistry: new PluginContributionRegistry(),
			toolRegistry: new PluginToolRegistry({
				capabilityBroker: { authorize: async () => ({ allowed: true as const }) },
			}),
			providerRegistry,
			lifecycleStates: () => states,
			manifestLoader: async () => {
				if (blockLoad) {
					entered.resolve();
					await release.promise;
				}
				return manifest;
			},
		});
		await coordinator.initialize(snapshotFor(manifest));
		states = [
			{
				...lifecycle("enabled")[0],
				runtimeState: nextState === "active" ? "failed" : "active",
			},
		];
		blockLoad = true;
		const refreshing = coordinator.refresh(snapshotFor(manifest), { force: true });
		try {
			await entered.promise;
			states = [
				{
					...lifecycle(nextState === "disabled" ? "disabled" : "enabled")[0],
					runtimeState: "active",
				},
			];
			// Mirrors active recovery while the older refresh is awaiting disk I/O.
			if (nextState === "active") providerRegistry.enablePlugin(pluginId);
			else providerRegistry.disablePlugin(pluginId);
		} finally {
			release.resolve();
		}
		await refreshing;
		const [entry] = pluginEntries(providerRegistry);
		if (nextState === "active") {
			expect(entry.status).toBe("available");
			expect(
				providerRegistry.resolveProvider("demo:demo/base", { createAdapter: false }).modelId,
			).toBe("demo/base");
		} else {
			expect(entry.status).toBe("unavailable");
			expect(entry.unavailableReason).toBe("Plugin is disabled");
		}
		// The stored fingerprint must use the same latest state as availability.
		expect((await coordinator.refresh(snapshotFor(manifest))).changed).toBe(false);
	});

	test("marks providers unavailable when the manifest cannot be loaded", async () => {
		const manifest = parseManifest(manifestInput());
		const providerRegistry = new PluginProviderRegistry();
		let failLoad = false;
		const coordinator = new PluginContributionCoordinator({
			contributionRegistry: new PluginContributionRegistry(),
			toolRegistry: new PluginToolRegistry({
				capabilityBroker: { authorize: async () => ({ allowed: true as const }) },
			}),
			providerRegistry,
			manifestLoader: async () => {
				if (failLoad) throw new Error("manifest is unreadable");
				return manifest;
			},
		});
		await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle("enabled") });
		expect(pluginEntries(providerRegistry)[0].status).toBe("available");

		failLoad = true;
		await coordinator.refresh(snapshotFor(manifest), {
			force: true,
			lifecycleStates: lifecycle("enabled"),
		});

		// The entry is kept (so the prefix stays claimed) but must not resolve.
		expect(pluginEntries(providerRegistry)[0].status).toBe("unavailable");
	});

	test("replaces providers when the package generation changes", async () => {
		const first = parseManifest(manifestInput({ version: "1.0.0", providerPrefix: "demo" }));
		const providerRegistry = new PluginProviderRegistry();
		let current = first;
		const coordinator = new PluginContributionCoordinator({
			contributionRegistry: new PluginContributionRegistry(),
			toolRegistry: new PluginToolRegistry({
				capabilityBroker: { authorize: async () => ({ allowed: true as const }) },
			}),
			providerRegistry,
			manifestLoader: async () => current,
		});
		await coordinator.initialize(snapshotFor(first), { lifecycleStates: lifecycle("enabled") });
		const firstInstance = pluginEntries(providerRegistry)[0].providerInstanceId;

		// A renamed prefix in a new package generation must not leave the old entry
		// behind, or the freed prefix could never be re-claimed.
		current = parseManifest(manifestInput({ version: "2.0.0", providerPrefix: "demo2" }));
		await coordinator.refresh(snapshotFor(current), { lifecycleStates: lifecycle("enabled") });

		const entries = pluginEntries(providerRegistry);
		expect(entries).toHaveLength(1);
		expect(entries[0].providerPrefix).toBe("demo2");
		expect(entries[0].providerInstanceId).not.toBe(firstInstance);
		expect(providerRegistry.get("demo")).toBeUndefined();
	});

	test("leaves provider registration untouched when no provider registry is supplied", async () => {
		const manifest = parseManifest(manifestInput());
		const coordinator = new PluginContributionCoordinator({
			contributionRegistry: new PluginContributionRegistry(),
			toolRegistry: new PluginToolRegistry({
				capabilityBroker: { authorize: async () => ({ allowed: true as const }) },
			}),
			manifestLoader: async () => manifest,
		});

		const report = await coordinator.initialize(snapshotFor(manifest), {
			lifecycleStates: lifecycle("enabled"),
		});

		expect(report.providerCount).toBe(0);
	});
});
