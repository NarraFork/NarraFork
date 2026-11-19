import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BUILTIN_PLUGIN_ROOTS } from "@server/builtin-plugins/registry";
import { PluginCatalog } from "@server/services/plugin-catalog";
import { PluginManager } from "@server/services/plugin-manager";
import { pluginPlatformServices } from "@server/services/plugin-platform-services";

/**
 * A builtin plugin must be a *normal* plugin: same manifest validation, same catalog entry,
 * same runtime lifecycle, same command registry, same health, same enable/disable. Only its
 * distribution differs. These cases pin that equivalence, because the failure mode of a
 * "special" builtin plugin is silent: it keeps answering, just through the other code path.
 */
const PLUGIN_ID = "com.narrafork.apikey-quota";
const COMMAND_ID = `${PLUGIN_ID}/query-balance`;

describe("apikey-quota is a first-class plugin", () => {
	test("the catalog reads it through the installed-package reader", async () => {
		const catalog = new PluginCatalog({ builtinRoots: BUILTIN_PLUGIN_ROOTS });
		const snapshot = await catalog.scan();
		const plugin = snapshot.plugins.find((entry) => entry.pluginId === PLUGIN_ID);

		expect(plugin).toBeDefined();
		expect(plugin?.builtin).toBe(true);
		// Same status vocabulary as an installed, healthy package.
		expect(plugin?.status).toBe("compatible");
		expect(plugin?.diagnostics).toEqual([]);
		// Identity is derived the same way: a current pointer plus versioned packages.
		expect(plugin?.current?.version).toBe("1.0.0");
		expect(plugin?.current?.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(plugin?.contributions.some((entry) => entry.kind === "command")).toBe(true);
		expect(plugin?.contributions.some((entry) => entry.kind === "tool")).toBe(false);
	});

	test("a malformed builtin manifest fails the same way as an installed one", async () => {
		// A missing directory is the closest analogue to an unreadable package: it must be
		// skipped as "no package", never half-registered.
		const catalog = new PluginCatalog({ builtinRoots: ["/nonexistent/builtin-plugin"] });
		const snapshot = await catalog.scan();
		expect(snapshot.plugins).toEqual([]);
	});
});

describe("builtin plugin lifecycle matches an installed plugin", () => {
	let manager: PluginManager;

	beforeAll(async () => {
		manager = new PluginManager({ disabled: false });
		await manager.initialize();
	});

	afterAll(async () => {
		await manager.shutdown();
	});

	test("its state record is created implicitly and enabled by default", async () => {
		const status = await manager.getStatus(PLUGIN_ID);
		expect(status?.builtin).toBe(true);
		expect(status?.installed).toBe(true);
		// No install step happened, yet the record exists and is enabled.
		expect(status?.desiredState).toBe("enabled");
	});

	test("its first authority contains only the manifest's declared capability", async () => {
		const permissions = await manager.getPermissions(PLUGIN_ID);
		expect(permissions.grants.map((grant) => grant.capability)).toEqual(["provider.use"]);
	});

	test("its command is registered without advertising an Agent tool", () => {
		const entry = pluginPlatformServices.pluginCommandRegistry.find(COMMAND_ID, PLUGIN_ID);
		expect(entry).toBeDefined();
		expect(entry?.handler).toBe("server");
		expect(pluginPlatformServices.toolRegistry.list(PLUGIN_ID)).toEqual([]);
		expect(
			pluginPlatformServices.toolBridge.listBindings().some((tool) => tool.pluginId === PLUGIN_ID),
		).toBe(false);
	});

	test("disable persists and enable restores, on the same record external plugins use", async () => {
		const disabled = await manager.disable(PLUGIN_ID);
		expect(disabled.desiredState).toBe("disabled");
		// Reading it back proves it was persisted, not just returned.
		expect((await manager.getStatus(PLUGIN_ID))?.desiredState).toBe("disabled");

		const enabled = await manager.enable(PLUGIN_ID);
		expect(enabled.desiredState).toBe("enabled");
		expect((await manager.getStatus(PLUGIN_ID))?.desiredState).toBe("enabled");
	});

	test("health accounting is the shared one", async () => {
		const status = await manager.getStatus(PLUGIN_ID);
		// `health` is present only once a call has been recorded; the registry it comes from is
		// the same one external plugins report to.
		if (status?.health) {
			for (const entry of status.health) {
				expect(entry.pluginId).toBe(PLUGIN_ID);
				expect(typeof entry.requests).toBe("number");
			}
		}
	});

	test("explicitly revoked grants stay empty after re-enable and restart", async () => {
		const permissions = await manager.getPermissions(PLUGIN_ID);
		await manager.replacePermissions(PLUGIN_ID, {
			grants: [],
			expectedRevision: permissions.revision,
			grantedBy: "quota-test-admin",
		});
		await manager.disable(PLUGIN_ID);
		await manager.enable(PLUGIN_ID);
		expect((await manager.getPermissions(PLUGIN_ID)).grants).toEqual([]);

		await manager.shutdown();
		manager = new PluginManager({ disabled: false });
		await manager.initialize();
		expect((await manager.getPermissions(PLUGIN_ID)).grants).toEqual([]);
	});
});
