import { describe, expect, test } from "bun:test";
import { CapabilityBroker } from "@server/services/plugin-capability-broker";
import { PluginHostServices } from "@server/services/plugin-host-services";
import type { StoredPermissionGrant } from "@server/services/plugin-permission-store";

/**
 * `config.get` and the four `secrets.*` methods are how a provider plugin learns how it was
 * configured.
 *
 * Secrets are readable by value now (`docs/plugin-system/11-capability-policy.md`),
 * matching VS Code's `secrets` API. The earlier name-and-status-only rule prevented
 * nothing — a plugin's own backend could return the value regardless — while stopping a
 * settings view from showing which credential was configured.
 *
 * The isolation that remains is structural and is what these tests pin: the plugin id
 * always comes from the host-bound principal, so no parameter lets one plugin address
 * another's namespace.
 */

const pluginId = "com.example.host-config";
const otherPluginId = "com.example.other";
const runtimeId = "runtime-config-1";
const installationId = "installation-config-1";

function grant(
	capability: StoredPermissionGrant["capability"],
	revision = 4,
): StoredPermissionGrant {
	return {
		pluginId,
		installationId,
		grantId: `grant-${capability}`,
		capability,
		scope: { type: "global" },
		grantedBy: "admin-user-1",
		revision,
	};
}

function bind(
	hostServices: PluginHostServices,
	capabilities: StoredPermissionGrant["capability"][],
) {
	return hostServices.bindRuntime({
		pluginId,
		packageVersion: "1.0.0",
		installationId,
		runtimeId,
		runtimeGeneration: 3,
		grantRevision: 4,
		desiredState: "enabled",
		runtimeState: "active",
		compatibilityState: "compatible",
		manifestRequested: capabilities,
		grants: capabilities.map((capability) => grant(capability)),
	});
}

describe("plugin host config and secret status", () => {
	test("returns the calling plugin's own config", async () => {
		const hostServices = new PluginHostServices({
			capabilityBroker: new CapabilityBroker(),
			providerConfigReader: (id) =>
				id === pluginId ? { demo: { apiMode: "balanced" } } : { demo: { apiMode: "WRONG" } },
		});
		const runtime = bind(hostServices, ["config.read_self"]);

		const response = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "config",
			method: "config.get",
			params: {},
		});

		expect(response).toMatchObject({ result: { demo: { apiMode: "balanced" } } });
	});

	test("ignores a pluginId supplied by the plugin", async () => {
		const requested: string[] = [];
		const hostServices = new PluginHostServices({
			capabilityBroker: new CapabilityBroker(),
			providerConfigReader: (id) => {
				requested.push(id);
				return {};
			},
		});
		const runtime = bind(hostServices, ["config.read_self"]);

		// A strict params schema rejects the spoof outright rather than quietly ignoring it.
		const response = (await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "config-spoof",
			method: "config.get",
			params: { pluginId: otherPluginId },
		})) as { error?: unknown };

		expect(response.error).toBeDefined();
		expect(requested).not.toContain(otherPluginId);
	});

	test("denies config.get without the config.read_self capability", async () => {
		const hostServices = new PluginHostServices({
			capabilityBroker: new CapabilityBroker(),
			providerConfigReader: () => ({ demo: { apiMode: "balanced" } }),
		});
		// Granted an unrelated capability, so the request is authenticated but unauthorized.
		const runtime = bind(hostServices, ["diagnostics.readOwnLogs"]);

		const response = (await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "config-denied",
			method: "config.get",
			params: {},
		})) as { error?: { message?: string }; result?: unknown };

		expect(response.result).toBeUndefined();
		expect(response.error).toBeDefined();
	});

	test("lists secret keys and status without values", async () => {
		const hostServices = new PluginHostServices({
			capabilityBroker: new CapabilityBroker(),
			secretKeyLister: () => ["provider.demo.apiKey"],
		});
		const runtime = bind(hostServices, ["secret.use_self"]);

		const response = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "secrets",
			method: "secrets.list",
			params: {},
		});

		// `list` stays an inventory: values come from `secrets.get`, so a plugin that only
		// wants to know whether setup is needed does not have to read credentials.
		expect(response).toMatchObject({
			result: { secrets: [{ key: "provider.demo.apiKey", configured: true }] },
		});
		expect(JSON.stringify(response)).not.toContain("value");
	});

	test("reads, writes, and deletes the calling plugin's own secrets", async () => {
		const store = new Map<string, string>([["provider.demo.apiKey", "sk-existing"]]);
		const hostServices = new PluginHostServices({
			capabilityBroker: new CapabilityBroker(),
			secretReader: (id, key) => (id === pluginId ? store.get(key) : "WRONG-PLUGIN"),
			secretWriter: (id, key, value) => {
				expect(id).toBe(pluginId);
				store.set(key, value);
			},
			secretDeleter: (id, key) => (id === pluginId ? store.delete(key) : false),
		});
		const runtime = bind(hostServices, ["secret.use_self"]);

		expect(
			await runtime.dispatcher.dispatch({
				jsonrpc: "2.0",
				id: "secret-get",
				method: "secrets.get",
				params: { key: "provider.demo.apiKey" },
			}),
		).toMatchObject({ result: { key: "provider.demo.apiKey", value: "sk-existing" } });

		expect(
			await runtime.dispatcher.dispatch({
				jsonrpc: "2.0",
				id: "secret-set",
				method: "secrets.set",
				params: { key: "provider.demo.token", value: "tok-new" },
			}),
		).toMatchObject({ result: { key: "provider.demo.token", stored: true } });
		expect(store.get("provider.demo.token")).toBe("tok-new");

		expect(
			await runtime.dispatcher.dispatch({
				jsonrpc: "2.0",
				id: "secret-delete",
				method: "secrets.delete",
				params: { key: "provider.demo.apiKey" },
			}),
		).toMatchObject({ result: { key: "provider.demo.apiKey", deleted: true } });
		expect(store.has("provider.demo.apiKey")).toBe(false);
	});

	test("reports an unset secret as null rather than failing", async () => {
		const hostServices = new PluginHostServices({
			capabilityBroker: new CapabilityBroker(),
			secretReader: () => undefined,
		});
		const runtime = bind(hostServices, ["secret.use_self"]);

		// Mirrors `secrets.get` returning `undefined` in VS Code: "not configured" is an
		// ordinary answer, not an error a plugin has to catch.
		expect(
			await runtime.dispatcher.dispatch({
				jsonrpc: "2.0",
				id: "secret-missing",
				method: "secrets.get",
				params: { key: "provider.demo.absent" },
			}),
		).toMatchObject({ result: { key: "provider.demo.absent", value: null } });
	});

	test("gives a plugin no parameter for naming another plugin's secret", async () => {
		const seen: string[] = [];
		const hostServices = new PluginHostServices({
			capabilityBroker: new CapabilityBroker(),
			secretReader: (id, key) => {
				seen.push(id);
				return `value-for-${key}`;
			},
		});
		const runtime = bind(hostServices, ["secret.use_self"]);

		// The strict params schema refuses the extra field outright; even if it did not, the
		// owner is read from the bound principal and never from the request.
		const spoofed = (await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "secret-spoof",
			method: "secrets.get",
			params: { key: "provider.demo.apiKey", pluginId: otherPluginId },
		})) as { error?: unknown };

		expect(spoofed.error).toBeDefined();
		expect(seen).not.toContain(otherPluginId);
	});

	test("rejects a secret value beyond the vault's 64KB ceiling", async () => {
		let written = false;
		const hostServices = new PluginHostServices({
			capabilityBroker: new CapabilityBroker(),
			secretWriter: () => {
				written = true;
			},
		});
		const runtime = bind(hostServices, ["secret.use_self"]);

		// Retained on purpose. Not a trust limit: the vault is a synchronous JSON
		// read/modify/write on the main thread, so an unbounded value stalls every request.
		const response = (await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "secret-oversize",
			method: "secrets.set",
			params: { key: "provider.demo.blob", value: "x".repeat(64 * 1024 + 1) },
		})) as { error?: unknown; result?: unknown };

		expect(response.result).toBeUndefined();
		expect(response.error).toBeDefined();
		expect(written).toBe(false);
	});

	test("denies every secret method without the secret.use_self capability", async () => {
		const hostServices = new PluginHostServices({
			capabilityBroker: new CapabilityBroker(),
			secretReader: () => "sk-should-not-be-reachable",
			secretWriter: () => undefined,
			secretDeleter: () => true,
		});
		const runtime = bind(hostServices, ["config.read_self"]);

		for (const [method, params] of [
			["secrets.get", { key: "provider.demo.apiKey" }],
			["secrets.set", { key: "provider.demo.apiKey", value: "sk-new" }],
			["secrets.delete", { key: "provider.demo.apiKey" }],
		] as const) {
			const response = (await runtime.dispatcher.dispatch({
				jsonrpc: "2.0",
				id: `denied-${method}`,
				method,
				params,
			})) as { error?: unknown; result?: unknown };

			expect(response.result).toBeUndefined();
			expect(response.error).toBeDefined();
		}
	});

	test("denies secrets.list without the secret.use_self capability", async () => {
		const hostServices = new PluginHostServices({
			capabilityBroker: new CapabilityBroker(),
			secretKeyLister: () => ["provider.demo.apiKey"],
		});
		const runtime = bind(hostServices, ["config.read_self"]);

		const response = (await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "secrets-denied",
			method: "secrets.list",
			params: {},
		})) as { error?: unknown; result?: unknown };

		expect(response.result).toBeUndefined();
		expect(response.error).toBeDefined();
	});

	test("returns empty shapes when the host wires no supplier", async () => {
		const hostServices = new PluginHostServices({ capabilityBroker: new CapabilityBroker() });
		const runtime = bind(hostServices, ["config.read_self", "secret.use_self"]);

		expect(
			await runtime.dispatcher.dispatch({
				jsonrpc: "2.0",
				id: "config-empty",
				method: "config.get",
				params: {},
			}),
		).toMatchObject({ result: {} });
		expect(
			await runtime.dispatcher.dispatch({
				jsonrpc: "2.0",
				id: "secrets-empty",
				method: "secrets.list",
				params: {},
			}),
		).toMatchObject({ result: { secrets: [] } });
	});
});
