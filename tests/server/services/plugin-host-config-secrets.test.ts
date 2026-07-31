import { describe, expect, test } from "bun:test";
import { CapabilityBroker } from "@server/services/plugin-capability-broker";
import { PluginHostServices } from "@server/services/plugin-host-services";
import type { StoredPermissionGrant } from "@server/services/plugin-permission-store";

/**
 * `config.get` and `secrets.list` are the two host methods a provider plugin needs to
 * know how it was configured. Both sit on a security boundary the sandbox contract
 * spells out (`docs/plugin-system/07-security-and-sandbox.md`):
 *
 * - config may be read, but must not carry secret values;
 * - secrets may be *enumerated by name and status only* — never by value.
 *
 * The plugin id is always taken from the host-bound principal, so these tests also pin
 * that a plugin cannot reach another plugin's data by passing parameters.
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
		trustTier: "T2",
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

	test("lists secret keys and status but never values", async () => {
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

		expect(response).toMatchObject({
			result: { secrets: [{ key: "provider.demo.apiKey", configured: true }] },
		});
		// No field anywhere in the payload may carry a value.
		expect(JSON.stringify(response)).not.toContain("value");
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
