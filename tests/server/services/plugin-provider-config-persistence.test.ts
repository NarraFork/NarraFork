import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
	PluginProviderConfigService,
	providerSecretKey,
	SECRET_PLACEHOLDER,
} from "@server/services/plugin-provider-config-service";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";
import { PluginSecretVault } from "@server/services/plugin-secret-vault";
import { PluginStateStore } from "@server/services/plugin-state-store";
import { PluginToolRegistry } from "@server/services/plugin-tool-registry";

/**
 * Provider config has to survive three things that all previously lost it:
 *
 *   1. a host restart — config is re-applied at registration, not after;
 *   2. a package upgrade — config is keyed by contribution id, not instance id;
 *   3. a failed contribution refresh — rollback restores config, not blank entries.
 *
 * Secrets are the other axis: a `format: "password"` field must never be written to
 * `state.json` nor echoed back to a caller.
 */

const pluginId = "com.example.provider-config";
const hash = "d".repeat(64);

function manifestInput(
	overrides: {
		version?: string;
		withSecret?: boolean;
		/** Which secret spelling to declare. Defaults to `format: "password"`. */
		secretMarker?: Record<string, unknown>;
	} = {},
): ManifestInput {
	const configSchema: Record<string, unknown> = { apiMode: { type: "string" } };
	if (overrides.withSecret) {
		configSchema.apiKey = {
			type: "string",
			...(overrides.secretMarker ?? { format: "password" }),
		};
	}
	return {
		schemaVersion: 1,
		pluginId,
		version: overrides.version ?? "1.0.0",
		displayName: "Provider config fixture",
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
					providerPrefix: "demo",
					modelDiscovery: true,
					sessionMode: "stateless",
					capabilities: { chat: true },
					configSchema,
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
		generatedAt: "2026-08-01T00:00:00.000Z",
		plugins: [plugin],
		packages: [packageSummary],
		diagnostics: [],
	};
}

function lifecycle(): readonly PluginContributionLifecycleState[] {
	return [
		{ pluginId, desiredState: "enabled", runtimeState: "inactive", compatibility: "compatible" },
	];
}

async function withStateStore<T>(run: (store: PluginStateStore, root: string) => Promise<T>) {
	const root = await mkdtemp(join(tmpdir(), "nf-provider-config-"));
	try {
		return await run(new PluginStateStore({ root }), root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function harness(
	manifest: Manifest,
	stateStore: PluginStateStore,
	secretVault?: PluginSecretVault,
) {
	const providerRegistry = new PluginProviderRegistry();
	const coordinator = new PluginContributionCoordinator({
		contributionRegistry: new PluginContributionRegistry(),
		toolRegistry: new PluginToolRegistry({
			capabilityBroker: { authorize: async () => ({ allowed: true as const }) },
		}),
		providerRegistry,
		manifestLoader: async () => manifest,
		providerConfigSource: (id) => stateStore.getCachedState(id)?.providerConfigs,
		providerPrefixSource: (id) => stateStore.getCachedState(id)?.providerPrefixes,
		// Mirrors the wiring in `plugin-platform-services.ts`.
		providerConfigPruner: async (id, keep) => {
			await stateStore.pruneProviderConfigs(id, keep);
			await secretVault?.pruneProviderSecrets(id, keep);
		},
	});
	return { providerRegistry, coordinator };
}

describe("provider config persistence", () => {
	test("re-applies stored config when providers are registered", async () => {
		await withStateStore(async (stateStore) => {
			const manifest = parseManifest(manifestInput());
			await stateStore.setProviderConfig(pluginId, "demo", { apiMode: "balanced" });

			const { providerRegistry, coordinator } = harness(manifest, stateStore);
			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });

			const [entry] = providerRegistry.list().filter((item) => item.pluginId === pluginId);
			expect(providerRegistry.getConfig(entry.providerInstanceId)).toEqual({
				apiMode: "balanced",
			});
		});
	});

	test("config survives a version upgrade because it is keyed by contribution id", async () => {
		await withStateStore(async (stateStore) => {
			const first = parseManifest(manifestInput({ version: "1.0.0" }));
			await stateStore.setProviderConfig(pluginId, "demo", { apiMode: "balanced" });

			const { providerRegistry, coordinator } = harness(first, stateStore);
			await coordinator.initialize(snapshotFor(first), { lifecycleStates: lifecycle() });
			const before = providerRegistry.list().find((item) => item.pluginId === pluginId);

			// A new version changes the generation, hence the providerInstanceId.
			const second = parseManifest(manifestInput({ version: "2.0.0" }));
			const upgraded = harness(second, stateStore);
			await upgraded.coordinator.initialize(snapshotFor(second), {
				lifecycleStates: lifecycle(),
			});
			const after = upgraded.providerRegistry.list().find((item) => item.pluginId === pluginId);

			expect(after).toBeDefined();
			expect(after?.providerInstanceId).not.toBe(before?.providerInstanceId);
			expect(upgraded.providerRegistry.getConfig(after?.providerInstanceId ?? "")).toEqual({
				apiMode: "balanced",
			});
		});
	});

	test("rollback restores config and adapter factory, not a blank entry", async () => {
		await withStateStore(async (stateStore) => {
			const manifest = parseManifest(manifestInput());
			await stateStore.setProviderConfig(pluginId, "demo", { apiMode: "balanced" });
			const { providerRegistry, coordinator } = harness(manifest, stateStore);
			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });

			const original = providerRegistry.list().find((item) => item.pluginId === pluginId);
			expect(original).toBeDefined();
			const instanceId = original?.providerInstanceId ?? "";

			// The adapter is built lazily from a registry-level factory; record the config
			// it observes so a lossy restore would show up as a changed/blank value.
			const seenConfig: Array<Readonly<Record<string, unknown>>> = [];
			providerRegistry.setRemoteProviderAdapterFactory((context) => {
				seenConfig.push(context.config);
				return { name: "stub" } as unknown as ReturnType<
					NonNullable<ReturnType<typeof providerRegistry.get>>["createAdapter"]
				>;
			});
			providerRegistry.get(instanceId)?.createAdapter();
			expect(seenConfig.at(-1)).toEqual({ apiMode: "balanced" });

			// Force the replace to fail: claim the prefix from a different plugin so
			// re-registration collides.
			const snapshot = providerRegistry.detachPlugin(pluginId);
			providerRegistry.register({
				kind: "executable-plugin",
				pluginId: "com.example.squatter",
				localId: "squat",
				providerInstanceId: "squatter-instance",
				providerPrefix: "demo",
				displayName: "Squatter",
				capabilities: { chat: true },
				configSchema: true,
			});
			expect(providerRegistry.restorePlugin(snapshot)).toBe(0);

			// Release the prefix and confirm a restore brings back a *working* entry.
			providerRegistry.removePlugin("com.example.squatter");
			expect(providerRegistry.restorePlugin(snapshot)).toBe(1);
			expect(providerRegistry.getConfig(instanceId)).toEqual({ apiMode: "balanced" });
			providerRegistry.get(instanceId)?.createAdapter();
			expect(seenConfig.at(-1)).toEqual({ apiMode: "balanced" });
		});
	});

	test("rejects invalid config before it reaches disk", async () => {
		await withStateStore(async (stateStore) => {
			const manifest = parseManifest(manifestInput());
			const { providerRegistry, coordinator } = harness(manifest, stateStore);
			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });
			const entry = providerRegistry.list().find((item) => item.pluginId === pluginId);
			const service = new PluginProviderConfigService({ registry: providerRegistry, stateStore });

			await expect(
				service.update(pluginId, entry?.providerInstanceId ?? "", { apiMode: 42 }),
			).rejects.toThrow(/invalid/i);

			expect(stateStore.getCachedState(pluginId)?.providerConfigs.demo).toBeUndefined();
		});
	});

	test("secrets go to the broker, never to state.json or back to the caller", async () => {
		await withStateStore(async (stateStore, root) => {
			const manifest = parseManifest(manifestInput({ withSecret: true }));
			const { providerRegistry, coordinator } = harness(manifest, stateStore);
			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });
			const entry = providerRegistry.list().find((item) => item.pluginId === pluginId);
			const instanceId = entry?.providerInstanceId ?? "";

			const secrets = new Map<string, string>();
			const service = new PluginProviderConfigService({
				registry: providerRegistry,
				stateStore,
				secretStore: {
					setSecret: ({ pluginId: id, key, value }) => void secrets.set(`${id}:${key}`, value),
					deleteSecret: ({ pluginId: id, key }) => void secrets.delete(`${id}:${key}`),
					hasSecret: ({ pluginId: id, key }) => secrets.has(`${id}:${key}`),
				},
			});

			const view = await service.update(pluginId, instanceId, {
				apiMode: "balanced",
				apiKey: "sk-super-secret",
			});

			expect(secrets.get(`${pluginId}:provider.demo.apiKey`)).toBe("sk-super-secret");
			expect(view.secretsSet).toEqual(["apiKey"]);
			// The caller sees a placeholder, never the value.
			expect(view.config.apiKey).toBe(SECRET_PLACEHOLDER);
			expect(view.config.apiMode).toBe("balanced");

			// Plain-text state must not contain the secret anywhere.
			const stateFile = await Bun.file(join(root, "state.json")).text();
			expect(stateFile).not.toContain("sk-super-secret");
			expect(stateStore.getCachedState(pluginId)?.providerConfigs.demo).toEqual({
				apiMode: "balanced",
			});

			// Round-tripping the placeholder keeps the stored secret intact.
			await service.update(pluginId, instanceId, {
				apiMode: "fast",
				apiKey: SECRET_PLACEHOLDER,
			});
			expect(secrets.get(`${pluginId}:provider.demo.apiKey`)).toBe("sk-super-secret");

			// Clearing it removes the stored secret.
			const cleared = await service.update(pluginId, instanceId, { apiMode: "fast", apiKey: "" });
			expect(secrets.has(`${pluginId}:provider.demo.apiKey`)).toBe(false);
			expect(cleared.secretsSet).toEqual([]);
			expect(cleared.config.apiKey).toBeUndefined();
		});
	});

	/**
	 * `04-server-rpc-and-provider.md` §8.2 specifies `writeOnly: true` plus
	 * `"x-narrafork-secret": true`, and `plugin-provider-rpc.ts` enforces that pair when
	 * rejecting secret defaults — but this service originally recognized only
	 * `format: "password"`. A plugin using the documented spelling therefore had its
	 * credential treated as an ordinary field and written to `state.json` in plain text.
	 *
	 * Each spelling is asserted against the file on disk, because that is where the leak
	 * actually appeared; checking only `secretsSet` would pass even if the value were
	 * also persisted.
	 */
	test("treats every documented secret marker as a secret, not plain config", async () => {
		for (const marker of [
			{ format: "password" },
			{ writeOnly: true },
			{ "x-narrafork-secret": true },
			// The documented pair, used together as a real plugin would.
			{ writeOnly: true, "x-narrafork-secret": true },
		]) {
			await withStateStore(async (stateStore, root) => {
				const manifest = parseManifest(manifestInput({ withSecret: true, secretMarker: marker }));
				const { providerRegistry, coordinator } = harness(manifest, stateStore);
				await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });
				const entry = providerRegistry.list().find((item) => item.pluginId === pluginId);
				const instanceId = entry?.providerInstanceId ?? "";

				const secrets = new Map<string, string>();
				const service = new PluginProviderConfigService({
					registry: providerRegistry,
					stateStore,
					secretStore: {
						setSecret: ({ pluginId: id, key, value }) => void secrets.set(`${id}:${key}`, value),
						deleteSecret: ({ pluginId: id, key }) => void secrets.delete(`${id}:${key}`),
						hasSecret: ({ pluginId: id, key }) => secrets.has(`${id}:${key}`),
					},
				});

				const view = await service.update(pluginId, instanceId, {
					apiMode: "balanced",
					apiKey: "sk-marker-secret",
				});

				const label = JSON.stringify(marker);
				expect(view.secretFields, label).toEqual(["apiKey"]);
				expect(secrets.get(`${pluginId}:provider.demo.apiKey`), label).toBe("sk-marker-secret");
				expect(view.config.apiKey, label).toBe(SECRET_PLACEHOLDER);
				// The decisive assertion: the value must not be on disk in plain text.
				expect(await Bun.file(join(root, "state.json")).text(), label).not.toContain(
					"sk-marker-secret",
				);
				expect(stateStore.getCachedState(pluginId)?.providerConfigs.demo, label).toEqual({
					apiMode: "balanced",
				});
			});
		}
	});

	test("prunes config for a provider the plugin stopped contributing", async () => {
		await withStateStore(async (stateStore) => {
			const manifest = parseManifest(manifestInput());
			await stateStore.setProviderConfig(pluginId, "demo", { apiMode: "balanced" });
			await stateStore.setProviderConfig(pluginId, "retired", { apiMode: "legacy" });

			const { coordinator } = harness(manifest, stateStore);
			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });

			const configs = stateStore.getCachedState(pluginId)?.providerConfigs;
			expect(configs?.demo).toEqual({ apiMode: "balanced" });
			// "retired" is no longer in contributes.providers, so its config is dropped.
			expect(configs?.retired).toBeUndefined();
		});
	});

	test("keeps config when the manifest fails to load", async () => {
		await withStateStore(async (stateStore) => {
			await stateStore.setProviderConfig(pluginId, "demo", { apiMode: "balanced" });
			const manifest = parseManifest(manifestInput());

			// A manifest that cannot be read must not be mistaken for "provider removed";
			// otherwise a transient failure would erase the user's settings.
			const providerRegistry = new PluginProviderRegistry();
			const coordinator = new PluginContributionCoordinator({
				contributionRegistry: new PluginContributionRegistry(),
				toolRegistry: new PluginToolRegistry({
					capabilityBroker: { authorize: async () => ({ allowed: true as const }) },
				}),
				providerRegistry,
				manifestLoader: async () => {
					throw new Error("manifest unreadable");
				},
				providerConfigSource: (id) => stateStore.getCachedState(id)?.providerConfigs,
				providerConfigPruner: async (id, keep) => {
					await stateStore.pruneProviderConfigs(id, keep);
				},
			});

			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });

			expect(stateStore.getCachedState(pluginId)?.providerConfigs.demo).toEqual({
				apiMode: "balanced",
			});
		});
	});
});

describe("provider prefix override", () => {
	test("re-registers with the stored prefix instead of the manifest one", async () => {
		await withStateStore(async (stateStore) => {
			const manifest = parseManifest(manifestInput());
			await stateStore.setProviderPrefix(pluginId, "demo", "mine");

			const { providerRegistry, coordinator } = harness(manifest, stateStore);
			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });

			const [entry] = providerRegistry.list().filter((item) => item.pluginId === pluginId);
			// The manifest says `demo`; the admin override wins.
			expect(entry.providerPrefix).toBe("mine");
		});
	});

	test("survives a version upgrade like config does", async () => {
		await withStateStore(async (stateStore) => {
			await stateStore.setProviderPrefix(pluginId, "demo", "mine");
			const second = parseManifest(manifestInput({ version: "2.0.0" }));
			const { providerRegistry, coordinator } = harness(second, stateStore);
			await coordinator.initialize(snapshotFor(second), { lifecycleStates: lifecycle() });
			const [entry] = providerRegistry.list().filter((item) => item.pluginId === pluginId);
			expect(entry.providerPrefix).toBe("mine");
		});
	});

	test("discards an invalid stored prefix rather than failing registration", async () => {
		await withStateStore(async (stateStore, root) => {
			const manifest = parseManifest(manifestInput());
			// Simulate a hand-edited state file: a colon is illegal in a prefix, and letting
			// it reach the registry would fail provider registration for the whole plugin.
			const statePath = join(root, "state.json");
			await stateStore.setProviderPrefix(pluginId, "demo", "ok");
			const raw = JSON.parse(await Bun.file(statePath).text());
			raw.plugins[pluginId].providerPrefixes.demo = "bad:prefix";
			await Bun.write(statePath, JSON.stringify(raw));

			const fresh = new PluginStateStore({ root });
			const { providerRegistry, coordinator } = harness(manifest, fresh);
			// Force the cache to load before registration reads it.
			await fresh.listStates();
			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });

			const [entry] = providerRegistry.list().filter((item) => item.pluginId === pluginId);
			expect(entry.providerPrefix).toBe("demo");
		});
	});

	test("setProviderPrefix rejects an invalid value before it reaches disk", async () => {
		await withStateStore(async (stateStore) => {
			await expect(stateStore.setProviderPrefix(pluginId, "demo", "has space")).rejects.toThrow();
			await expect(stateStore.setProviderPrefix(pluginId, "demo", "has:colon")).rejects.toThrow();
			await expect(stateStore.setProviderPrefix(pluginId, "demo", "")).rejects.toThrow();
			expect(stateStore.getCachedState(pluginId)?.providerPrefixes.demo).toBeUndefined();
		});
	});

	test("registry re-keys the prefix without losing config or the adapter", async () => {
		await withStateStore(async (stateStore) => {
			const manifest = parseManifest(manifestInput());
			await stateStore.setProviderConfig(pluginId, "demo", { apiMode: "balanced" });
			const { providerRegistry, coordinator } = harness(manifest, stateStore);
			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });
			const [entry] = providerRegistry.list().filter((item) => item.pluginId === pluginId);

			const seen: Array<Readonly<Record<string, unknown>>> = [];
			providerRegistry.setRemoteProviderAdapterFactory((context) => {
				seen.push(context.config);
				return { name: "stub" } as never;
			});

			providerRegistry.setProviderPrefix(entry.providerInstanceId, "renamed");

			const updated = providerRegistry.get(entry.providerInstanceId);
			expect(updated?.providerPrefix).toBe("renamed");
			// Looking up by the new prefix must work, and the old one must be released.
			expect(providerRegistry.get("renamed")?.providerInstanceId).toBe(entry.providerInstanceId);
			expect(providerRegistry.get("demo")).toBeUndefined();
			expect(providerRegistry.getConfig(entry.providerInstanceId)).toEqual({
				apiMode: "balanced",
			});
			updated?.createAdapter();
			expect(seen.at(-1)).toEqual({ apiMode: "balanced" });
		});
	});

	test("registry rejects a prefix another provider already claims", async () => {
		await withStateStore(async (stateStore) => {
			const manifest = parseManifest(manifestInput());
			const { providerRegistry, coordinator } = harness(manifest, stateStore);
			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });
			const [entry] = providerRegistry.list().filter((item) => item.pluginId === pluginId);

			providerRegistry.register({
				kind: "executable-plugin",
				pluginId: "com.example.other",
				localId: "other",
				providerInstanceId: "other-instance",
				providerPrefix: "taken",
				displayName: "Other",
				capabilities: { chat: true },
				configSchema: true,
			});

			expect(() => providerRegistry.setProviderPrefix(entry.providerInstanceId, "taken")).toThrow(
				/conflict/i,
			);
			// The failed attempt must not have moved anything.
			expect(providerRegistry.get(entry.providerInstanceId)?.providerPrefix).toBe("demo");
			expect(providerRegistry.get("taken")?.providerInstanceId).toBe("other-instance");
		});
	});

	test("prune drops prefix overrides for providers the plugin stopped contributing", async () => {
		await withStateStore(async (stateStore) => {
			const manifest = parseManifest(manifestInput());
			await stateStore.setProviderPrefix(pluginId, "demo", "keepme");
			await stateStore.setProviderPrefix(pluginId, "retired", "dropme");

			const { coordinator } = harness(manifest, stateStore);
			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });

			const prefixes = stateStore.getCachedState(pluginId)?.providerPrefixes;
			expect(prefixes?.demo).toBe("keepme");
			expect(prefixes?.retired).toBeUndefined();
		});
	});
});

describe("a bad stored prefix must not break the whole refresh", () => {
	test("one plugin's prefix conflict does not abort registration for others", async () => {
		await withStateStore(async (stateStore) => {
			const manifest = parseManifest(manifestInput());
			// An admin-stored prefix that collides with a provider owned by another plugin.
			// This is reachable in production: the other plugin may be installed after the
			// prefix was chosen, or the same prefix may be stored for two plugins before
			// either registers.
			await stateStore.setProviderPrefix(pluginId, "demo", "taken");

			const providerRegistry = new PluginProviderRegistry();
			providerRegistry.register({
				kind: "executable-plugin",
				pluginId: "com.example.squatter",
				localId: "squat",
				providerInstanceId: "squatter-instance",
				providerPrefix: "taken",
				displayName: "Squatter",
				capabilities: { chat: true },
				configSchema: true,
			});

			const coordinator = new PluginContributionCoordinator({
				contributionRegistry: new PluginContributionRegistry(),
				toolRegistry: new PluginToolRegistry({
					capabilityBroker: { authorize: async () => ({ allowed: true as const }) },
				}),
				providerRegistry,
				manifestLoader: async () => manifest,
				providerConfigSource: (id) => stateStore.getCachedState(id)?.providerConfigs,
				providerPrefixSource: (id) => stateStore.getCachedState(id)?.providerPrefixes,
			});

			const report = await coordinator.initialize(snapshotFor(manifest), {
				lifecycleStates: lifecycle(),
			});

			// The refresh must survive: an unrelated plugin keeps its provider, and the
			// conflict is reported as a diagnostic rather than taking the platform down.
			expect(providerRegistry.get("squatter-instance")).toBeDefined();
			expect(report.diagnostics.some((item) => /prefix/i.test(item))).toBe(true);
		});
	});

	test("falls back to the manifest prefix so the plugin still loads", async () => {
		await withStateStore(async (stateStore) => {
			const manifest = parseManifest(manifestInput());
			await stateStore.setProviderPrefix(pluginId, "demo", "taken");

			const providerRegistry = new PluginProviderRegistry();
			providerRegistry.register({
				kind: "executable-plugin",
				pluginId: "com.example.squatter",
				localId: "squat",
				providerInstanceId: "squatter-instance",
				providerPrefix: "taken",
				displayName: "Squatter",
				capabilities: { chat: true },
				configSchema: true,
			});
			const coordinator = new PluginContributionCoordinator({
				contributionRegistry: new PluginContributionRegistry(),
				toolRegistry: new PluginToolRegistry({
					capabilityBroker: { authorize: async () => ({ allowed: true as const }) },
				}),
				providerRegistry,
				manifestLoader: async () => manifest,
				providerPrefixSource: (id) => stateStore.getCachedState(id)?.providerPrefixes,
			});

			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });

			// The plugin is registered under its manifest prefix rather than dropped.
			const entry = providerRegistry.list().find((item) => item.pluginId === pluginId);
			expect(entry?.providerPrefix).toBe("demo");
		});
	});

	test("pruning a removed provider also purges its stored secrets", async () => {
		await withStateStore(async (stateStore, root) => {
			const vault = new PluginSecretVault({ root });
			// A provider the plugin used to contribute, with a stored credential.
			await stateStore.setProviderConfig(pluginId, "retired", { apiMode: "legacy" });
			await vault.setSecret({
				pluginId,
				key: providerSecretKey("retired", "apiKey"),
				value: "sk-retired",
			});
			// And one it still contributes, whose secret must survive.
			await vault.setSecret({
				pluginId,
				key: providerSecretKey("demo", "apiKey"),
				value: "sk-current",
			});

			const manifest = parseManifest(manifestInput());
			const { coordinator } = harness(manifest, stateStore, vault);
			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });

			// A credential for a provider the plugin no longer declares is unreachable
			// config, but it is still a live secret on disk. Leaving it means an uninstall is
			// the only way to remove it, and a same-id provider added later would silently
			// inherit it.
			expect(await vault.hasSecret({ pluginId, key: providerSecretKey("retired", "apiKey") })).toBe(
				false,
			);
			expect(await vault.getSecret({ pluginId, key: providerSecretKey("demo", "apiKey") })).toBe(
				"sk-current",
			);
		});
	});

	test("a manifest-level prefix conflict still fails the refresh", async () => {
		await withStateStore(async (stateStore) => {
			const manifest = parseManifest(manifestInput());
			const providerRegistry = new PluginProviderRegistry();
			// The conflict is with the manifest prefix itself, so there is no override to
			// discard and nothing the host can silently fall back to.
			providerRegistry.register({
				kind: "executable-plugin",
				pluginId: "com.example.squatter",
				localId: "squat",
				providerInstanceId: "squatter-instance",
				providerPrefix: "demo",
				displayName: "Squatter",
				capabilities: { chat: true },
				configSchema: true,
			});
			const coordinator = new PluginContributionCoordinator({
				contributionRegistry: new PluginContributionRegistry(),
				toolRegistry: new PluginToolRegistry({
					capabilityBroker: { authorize: async () => ({ allowed: true as const }) },
				}),
				providerRegistry,
				manifestLoader: async () => manifest,
				providerPrefixSource: (id) => stateStore.getCachedState(id)?.providerPrefixes,
			});

			await expect(
				coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() }),
			).rejects.toThrow(/refresh failed/i);
		});
	});
});

describe("a failed config write must not leave the registry ahead of disk", () => {
	test("rolls the live registry back when persistence fails", async () => {
		await withStateStore(async (stateStore) => {
			const manifest = parseManifest(manifestInput());
			await stateStore.setProviderConfig(pluginId, "demo", { apiMode: "balanced" });
			const { providerRegistry, coordinator } = harness(manifest, stateStore);
			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });
			const instanceId =
				providerRegistry.list().find((item) => item.pluginId === pluginId)?.providerInstanceId ??
				"";

			// A disk write can fail for reasons the caller cannot control: a full volume, a
			// permission change, or a corrupted journal. What must not happen is the running
			// provider using config that a restart would silently revert.
			const failing = {
				getCachedState: (id: string) => stateStore.getCachedState(id),
				setProviderPrefix: stateStore.setProviderPrefix.bind(stateStore),
				setProviderConfig: async () => {
					throw new Error("disk is full");
				},
			};
			const service = new PluginProviderConfigService({
				registry: providerRegistry,
				stateStore: failing as unknown as PluginStateStore,
			});

			await expect(service.update(pluginId, instanceId, { apiMode: "fast" })).rejects.toThrow(
				/disk is full/,
			);
			// The registry still reports what is actually on disk.
			expect(providerRegistry.getConfig(instanceId)).toEqual({ apiMode: "balanced" });
		});
	});

	test("a failed write leaves the stored secret untouched", async () => {
		await withStateStore(async (stateStore, root) => {
			const manifest = parseManifest(manifestInput({ withSecret: true }));
			const { providerRegistry, coordinator } = harness(manifest, stateStore);
			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });
			const instanceId =
				providerRegistry.list().find((item) => item.pluginId === pluginId)?.providerInstanceId ??
				"";

			const vault = new PluginSecretVault({ root });
			await vault.setSecret({
				pluginId,
				key: providerSecretKey("demo", "apiKey"),
				value: "sk-original",
			});

			const failing = {
				getCachedState: (id: string) => stateStore.getCachedState(id),
				setProviderPrefix: stateStore.setProviderPrefix.bind(stateStore),
				setProviderConfig: async () => {
					throw new Error("disk is full");
				},
			};
			const service = new PluginProviderConfigService({
				registry: providerRegistry,
				stateStore: failing as unknown as PluginStateStore,
				secretStore: vault,
			});

			// Clearing a secret is irreversible, so it must not happen when a later step in
			// the same update fails. Otherwise a full disk would destroy a working credential
			// while reporting the update as failed.
			await expect(
				service.update(pluginId, instanceId, { apiMode: "fast", apiKey: "" }),
			).rejects.toThrow(/disk is full/);
			expect(await vault.getSecret({ pluginId, key: providerSecretKey("demo", "apiKey") })).toBe(
				"sk-original",
			);
		});
	});

	test("a successful write leaves registry and disk in agreement", async () => {
		await withStateStore(async (stateStore) => {
			const manifest = parseManifest(manifestInput());
			const { providerRegistry, coordinator } = harness(manifest, stateStore);
			await coordinator.initialize(snapshotFor(manifest), { lifecycleStates: lifecycle() });
			const instanceId =
				providerRegistry.list().find((item) => item.pluginId === pluginId)?.providerInstanceId ??
				"";
			const service = new PluginProviderConfigService({
				registry: providerRegistry,
				stateStore,
			});

			await service.update(pluginId, instanceId, { apiMode: "fast" });
			expect(providerRegistry.getConfig(instanceId)).toEqual({ apiMode: "fast" });
			expect(stateStore.getCachedState(pluginId)?.providerConfigs.demo).toEqual({
				apiMode: "fast",
			});
		});
	});
});
