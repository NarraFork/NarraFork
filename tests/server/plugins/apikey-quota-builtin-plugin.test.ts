import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import quotaManifest from "../../../plugins/provider-quota/manifest.json";
import {
	archivedQuotaFixture,
	closeQuotaTestPackage,
	quotaConfig,
	quotaTestPackage,
	required,
} from "../../../server/lib/__tests__/provider-quota-legacy-fixture";
import { CapabilityBroker } from "../../../server/services/plugin-capability-broker";
import { PluginCatalog } from "../../../server/services/plugin-catalog";
import { PluginManager } from "../../../server/services/plugin-manager";
import { PluginPermissionStore } from "../../../server/services/plugin-permission-store";
import { createPluginPlatformServices } from "../../../server/services/plugin-platform-services";
import { PluginProviderConnectionService } from "../../../server/services/plugin-provider-connection-service";
import { PluginProviderRegistry } from "../../../server/services/plugin-provider-registry";
import { RuntimeSupervisor } from "../../../server/services/plugin-runtime";
import { PluginStateStore } from "../../../server/services/plugin-state-store";
import { ProviderQuotaService } from "../../../server/services/provider-quota-service";

const PLUGIN_ID = "io.narrafork.provider-quota";
let fixture: Awaited<ReturnType<typeof archivedQuotaFixture>>;
beforeAll(async () => {
	fixture = await archivedQuotaFixture({
		approveSettings: false,
		fetch: async () =>
			Response.json({ isValid: true, mode: "unrestricted", unit: "USD", balance: 7 }),
	});
}, 60000);
afterAll(async () => {
	await fixture?.close();
	await closeQuotaTestPackage();
});

describe("Provider Quota is an ordinary archived plugin, not a retired builtin tool", () => {
	test("catalog validates the actual installed package, pointer, hash and four quota contributions", async () => {
		const snapshot = await new PluginCatalog({
			root: fixture.platform.stateStore.root,
			builtinRoots: [],
		}).scan();
		const plugin = snapshot.plugins.find(({ pluginId }) => pluginId === PLUGIN_ID);
		expect(plugin).toBeDefined();
		expect(plugin?.status).toBe("compatible");
		expect(plugin?.diagnostics).toEqual([]);
		expect(plugin?.current?.version).toBe(quotaManifest.version);
		expect(plugin?.current?.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(plugin?.contributions.filter(({ kind }) => kind === "quotaSource")).toHaveLength(4);
		expect(
			plugin?.contributions.filter(
				({ kind }) => kind === "tool" || kind === "command" || kind === "provider",
			),
		).toEqual([]);
	});
	test("missing/unreadable package directory never half-registers contributions", async () => {
		const catalog = new PluginCatalog({
			root: join(fixture.root, "missing-store"),
			builtinRoots: [join(fixture.root, "missing-package")],
		});
		expect((await catalog.scan()).plugins).toEqual([]);
	});
	test("the archive creates an installed state and only explicit enable makes it active", async () => {
		const status = await fixture.manager.getStatus(PLUGIN_ID);
		expect(status?.installed).toBe(true);
		expect(status?.desiredState).toBe("enabled");
		expect(status?.compatibility).toBe("compatible");
		expect((await quotaTestPackage()).archivePath).not.toContain(
			"server/builtin-plugins/apikey-quota",
		);
	});
	test("initial authority keeps the two quota capabilities without approving provider settings", async () => {
		expect(
			(await fixture.manager.getPermissions(PLUGIN_ID)).grants
				.map(({ capability }) => capability)
				.sort(),
		).toEqual(["provider.connection.request", "quota.provide"]);
	});
	test("quota contributions register in the actual quota registry, with no provider.describe/tool detour", () => {
		expect(
			fixture.platform.quotaRegistry
				.listSources()
				.map(({ id }) => id)
				.sort(),
		).toEqual(["relay", "kimi", "deepseek", "opencode"].map((id) => `${PLUGIN_ID}/${id}`).sort());
		expect(fixture.platform.providerRegistry.list()).toEqual([]);
		expect(fixture.platform.toolRegistry.list(PLUGIN_ID)).toEqual([]);
		expect(
			fixture.platform.toolBridge.listBindings().some((tool) => tool.pluginId === PLUGIN_ID),
		).toBe(false);
		expect(fixture.supervisor.get(PLUGIN_ID)?.pid).toBeGreaterThan(0);
	});
	test("disable and re-enable persist through the normal manager state record", async () => {
		await fixture.approveSettings();
		expect((await fixture.manager.disable(PLUGIN_ID)).desiredState).toBe("disabled");
		expect((await fixture.manager.getStatus(PLUGIN_ID))?.desiredState).toBe("disabled");
		expect(fixture.platform.quotaRegistry.listSources()).toEqual([]);
		expect((await fixture.manager.enable(PLUGIN_ID)).desiredState).toBe("enabled");
		expect((await fixture.manager.getStatus(PLUGIN_ID))?.desiredState).toBe("enabled");
		await fixture.manager.activate(PLUGIN_ID);
		expect((await fixture.rpc(quotaConfig()))?.status).toBe("supported");
	});
	test("health is measured by the actual runtime after a real quota request", async () => {
		const runtime = required(fixture.supervisor.get(PLUGIN_ID));
		expect(await runtime.request("health", {}, { timeoutMs: 3000 })).toMatchObject({
			healthy: true,
		});
		expect(runtime.getDiagnostics()).toMatchObject({
			pluginId: PLUGIN_ID,
			pluginVersion: quotaManifest.version,
			inFlight: 0,
		});
	});
	test("explicitly revoked grants survive re-enable and a new manager initialization", async () => {
		const set = await fixture.manager.getPermissions(PLUGIN_ID);
		await fixture.manager.replacePermissions(PLUGIN_ID, {
			grants: [],
			expectedRevision: set.revision,
			grantedBy: "quota-builtin-test",
		});
		await fixture.manager.disable(PLUGIN_ID);
		await fixture.manager.enable(PLUGIN_ID);
		await fixture.manager.activate(PLUGIN_ID);
		expect((await fixture.manager.getPermissions(PLUGIN_ID)).grants).toEqual([]);
		expect(fixture.platform.quotaRegistry.listSources()).toEqual([]);
		fixture.service.stop();
		try {
			await fixture.manager.shutdown();
		} catch (error) {
			throw new Error("Revocation restart: original manager shutdown failed", { cause: error });
		}
		const stateStore = new PluginStateStore(fixture.platform.stateStore.root);
		const permissionStore = new PluginPermissionStore({ root: stateStore.root, stateStore });
		const supervisor = new RuntimeSupervisor();
		const quota = new ProviderQuotaService({ directory: fixture.directory, onChanged: () => {} });
		let calls = 0;
		const connection = new PluginProviderConnectionService({
			directory: fixture.directory,
			fetch: async () => {
				calls++;
				throw new Error("Revoked authority must never reach HTTP");
			},
		});
		const platform = createPluginPlatformServices({
			stateStore,
			permissionStore,
			runtimeSupervisor: supervisor,
			capabilityBroker: new CapabilityBroker({ kernelEnforcement: true }),
			quotaService: quota,
			providerConnectionService: connection,
			providerRegistry: new PluginProviderRegistry(),
			secretVault: fixture.platform.secretVault,
		});
		const manager = new PluginManager({
			root: stateStore.root,
			disabled: false,
			stateStore,
			permissionStore,
			runtimeSupervisor: supervisor,
			hostServices: platform.hostServices,
			quotaRegistry: platform.quotaRegistry,
			contributionRegistry: platform.contributionRegistry,
			contributionCoordinator: platform.contributionCoordinator,
			lifecycleRevokeCoordinator: platform.lifecycleRevokeCoordinator,
			restorePluginLifecycle: platform.restorePlugin,
		});
		const failures: unknown[] = [];
		try {
			await manager.initialize();
			// Complete the restarted process handshake before measuring authority/shutdown;
			// initialization may have just queued its onStartup activation.
			await manager.activate(PLUGIN_ID);
			const runtime = required(supervisor.get(PLUGIN_ID));
			expect(await runtime.request("health", {}, { timeoutMs: 3000 })).toMatchObject({
				healthy: true,
			});
			expect((await manager.getPermissions(PLUGIN_ID)).grants).toEqual([]);
			expect(platform.quotaRegistry.listSources()).toEqual([]);
			expect(calls).toBe(0);
		} catch (error) {
			failures.push(
				new Error("Revocation restart: new manager initialization/read failed", { cause: error }),
			);
		} finally {
			try {
				await manager.shutdown();
			} catch (error) {
				failures.push(
					new Error("Revocation restart: new manager shutdown failed", { cause: error }),
				);
			}
			try {
				await supervisor.shutdown();
			} catch (error) {
				failures.push(error);
			}
			quota.dispose();
			connection.dispose();
		}
		if (failures.length) throw new AggregateError(failures, "Revocation restart did not complete");
	});
});
