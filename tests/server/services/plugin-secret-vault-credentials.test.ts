import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CREDENTIALS_FILE,
	type CredentialsFile,
	getCredentialStore,
	resetCredentialStoresForTests,
} from "@server/lib/credential-store";
import { readSecretJSON, SecretStoreError } from "@server/lib/secret-store";
import { PluginProviderConfigService } from "@server/services/plugin-provider-config-service";
import { PluginProviderCredentialResolver } from "@server/services/plugin-provider-credential-resolver";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";
import { PluginSecretVault } from "@server/services/plugin-secret-vault";
import { PluginStateStore } from "@server/services/plugin-state-store";

/**
 * On an instance that uses credentials.json, a plugin provider's secret fields live there as
 * one `opaque` credential (docs/PROVIDER-SOURCING-DESIGN.md §15.7). Plugins and the config
 * service keep addressing them as vault keys; every other plugin secret stays in the vault.
 */

const pluginId = "com.example.vaulted";
const dirs: string[] = [];
afterEach(() => {
	resetCredentialStoresForTests();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(options: { unified: boolean }) {
	const dir = mkdtempSync(join(tmpdir(), "nf-plugin-credentials-"));
	dirs.push(dir);
	if (options.unified) {
		getCredentialStore(dir).create({ version: 1, credentials: [], groupSecrets: {} });
	}
	const vault = new PluginSecretVault({
		root: join(dir, "plugins"),
		credentials: () => getCredentialStore(dir),
	});
	return {
		dir,
		vault,
		credentials: () =>
			(readSecretJSON(join(dir, CREDENTIALS_FILE)) as CredentialsFile).credentials.filter(
				(c) => c.auth.kind === "opaque",
			),
		vaultFile: () => (existsSync(vault.path) ? readFileSync(vault.path, "utf8") : ""),
	};
}

function provider(registry: PluginProviderRegistry, localId = "demo") {
	registry.register({
		kind: "executable-plugin",
		pluginId,
		localId,
		providerInstanceId: `${pluginId}/${localId}@1`,
		providerPrefix: localId,
		displayName: "Demo",
		capabilities: { chat: true },
		configSchema: {
			type: "object",
			properties: {
				apiMode: { type: "string" },
				apiKey: { type: "string", format: "password" },
			},
		},
	});
	return `${pluginId}/${localId}@1`;
}

describe("plugin provider secrets in credentials.json", () => {
	test("config save, read and clear go through the credential; other secrets stay in the vault", async () => {
		const h = home({ unified: true });
		const registry = new PluginProviderRegistry();
		const instanceId = provider(registry);
		const service = new PluginProviderConfigService({
			registry,
			stateStore: new PluginStateStore({ root: join(h.dir, "plugins") }),
			secretStore: h.vault,
		});
		const resolver = new PluginProviderCredentialResolver({ registry, secretSource: h.vault });

		const view = await service.update(pluginId, instanceId, { apiMode: "x", apiKey: "sk-1" });
		expect(view.secretsSet).toEqual(["apiKey"]);
		expect(h.credentials()).toEqual([
			{
				id: `plugin:${pluginId}:demo`,
				target: { pluginContributionId: `${pluginId}/demo` },
				ownerUserId: null,
				priority: 0,
				createdAt: expect.any(Number),
				auth: { kind: "opaque", fields: { apiKey: "sk-1" } },
			},
		]);
		expect(await resolver.resolve(instanceId)).toEqual({ apiMode: "x", apiKey: "sk-1" });
		expect(await h.vault.getSecret({ pluginId, key: "provider.demo.constructor" })).toBeUndefined();

		await h.vault.setSecret({ pluginId, key: "session.token", value: "t-1" });
		expect(h.vaultFile()).toContain("t-1");
		expect(h.vaultFile()).not.toContain("sk-1");
		expect(JSON.stringify(h.credentials())).not.toContain("t-1");
		expect(await h.vault.listKeys(pluginId)).toEqual(["provider.demo.apiKey", "session.token"]);
		await h.vault.warm();
		expect(h.vault.peekKeys(pluginId)?.sort()).toEqual(["provider.demo.apiKey", "session.token"]);

		const cleared = await service.update(pluginId, instanceId, { apiMode: "x", apiKey: "" });
		expect(cleared.secretsSet).toEqual([]);
		expect(h.credentials()).toEqual([]);
		expect(await h.vault.deleteSecret({ pluginId, key: "provider.demo.apiKey" })).toBe(false);
		expect(await resolver.resolve(instanceId)).toEqual({ apiMode: "x" });
	});

	test("pruning drops removed providers' credentials; uninstalling drops all of the plugin's", async () => {
		const h = home({ unified: true });
		await h.vault.setSecret({ pluginId, key: "provider.demo.apiKey", value: "sk-1" });
		await h.vault.setSecret({ pluginId, key: "provider.demo.region", value: "eu" });
		await h.vault.setSecret({ pluginId, key: "provider.old.v2.apiKey", value: "sk-old" });
		await h.vault.setSecret({ pluginId, key: "session.token", value: "t-1" });
		await h.vault.setSecret({
			pluginId: "com.example.other",
			key: "provider.demo.apiKey",
			value: "o",
		});

		expect(await h.vault.pruneProviderSecrets(pluginId, ["demo"])).toBe(1);
		expect(h.credentials().map((c) => c.id)).toEqual([
			`plugin:${pluginId}:demo`,
			"plugin:com.example.other:demo",
		]);

		expect(await h.vault.deletePlugin(pluginId)).toBe(3);
		expect(h.credentials().map((c) => c.id)).toEqual(["plugin:com.example.other:demo"]);
		expect(await h.vault.listKeys(pluginId)).toEqual([]);
		expect(
			await h.vault.getSecret({ pluginId: "com.example.other", key: "provider.demo.apiKey" }),
		).toBe("o");
	});

	test("an unreadable credentials.json is never written, and yields no provider secrets", async () => {
		const h = home({ unified: true });
		await h.vault.setSecret({ pluginId, key: "provider.demo.apiKey", value: "sk-1" });
		resetCredentialStoresForTests();
		const path = join(h.dir, CREDENTIALS_FILE);
		writeFileSync(path, "{not json");
		await expect(
			h.vault.setSecret({ pluginId, key: "provider.demo.apiKey", value: "sk-2" }),
		).rejects.toThrow(SecretStoreError);
		expect(await h.vault.getSecret({ pluginId, key: "provider.demo.apiKey" })).toBeUndefined();
		// Uninstalling still clears the vault's own secrets.
		await h.vault.setSecret({ pluginId, key: "session.token", value: "t-1" });
		expect(await h.vault.deletePlugin(pluginId)).toBe(1);
		expect(readFileSync(path, "utf8")).toBe("{not json");
	});

	test("an instance without credentials.json keeps every secret in the vault", async () => {
		const h = home({ unified: false });
		mkdirSync(join(h.dir, "plugins"), { recursive: true });
		await h.vault.setSecret({ pluginId, key: "provider.demo.apiKey", value: "sk-1" });
		expect(h.vaultFile()).toContain("sk-1");
		expect(existsSync(join(h.dir, CREDENTIALS_FILE))).toBe(false);
		expect(await h.vault.getSecret({ pluginId, key: "provider.demo.apiKey" })).toBe("sk-1");
	});
});
