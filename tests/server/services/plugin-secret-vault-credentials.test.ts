import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIAL_BACKUPS_DIR } from "@server/lib/credential-backup";
import {
	CREDENTIALS_FILE,
	type CredentialsFile,
	getCredentialStore,
	resetCredentialStoresForTests,
} from "@server/lib/credential-store";
import { savePluginProviderSecrets } from "@server/lib/plugin-credentials";
import { readSecretJSON, SecretStoreError } from "@server/lib/secret-store";
import {
	declaredProviderSecretFields,
	PluginProviderConfigService,
} from "@server/services/plugin-provider-config-service";
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
	const registry = new PluginProviderRegistry();
	const vault = new PluginSecretVault({
		root: join(dir, "plugins"),
		credentials: () => getCredentialStore(dir),
		providerSecretFields: (id) => declaredProviderSecretFields(registry, id),
	});
	return {
		dir,
		vault,
		registry,
		credentials: () =>
			(readSecretJSON(join(dir, CREDENTIALS_FILE)) as CredentialsFile).credentials.filter(
				(c) => c.auth.kind === "opaque",
			),
		vaultFile: () => (existsSync(vault.path) ? readFileSync(vault.path, "utf8") : ""),
		vaultJson: () => JSON.parse(readFileSync(vault.path, "utf8")),
		backups: () =>
			existsSync(join(dir, CREDENTIAL_BACKUPS_DIR))
				? readdirSync(join(dir, CREDENTIAL_BACKUPS_DIR))
				: [],
		restart: () => resetCredentialStoresForTests(),
	};
}

type Home = ReturnType<typeof home>;

/** Register a provider whose secret fields may contain dots, as may its contribution id. */
function provider(h: Home, localId = "demo", secretFields = ["apiKey"]) {
	h.registry.register({
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
				...Object.fromEntries(
					secretFields.map((field) => [field, { type: "string", format: "password" }]),
				),
			},
		},
	});
	return `${pluginId}/${localId}@1`;
}

function configService(h: Home) {
	return new PluginProviderConfigService({
		registry: h.registry,
		stateStore: new PluginStateStore({ root: join(h.dir, "plugins") }),
		secretStore: h.vault,
	});
}

describe("plugin provider secrets in credentials.json", () => {
	test("config save, read and clear go through the credential; other secrets stay in the vault", async () => {
		const h = home({ unified: true });
		const instanceId = provider(h);
		const service = configService(h);
		const resolver = new PluginProviderCredentialResolver({
			registry: h.registry,
			secretSource: h.vault,
		});

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

	test("dotted field names and contribution ids survive save, read and a catalog prune", async () => {
		const h = home({ unified: true });
		const dottedField = provider(h, "demo", ["api.key"]);
		const dottedId = provider(h, "demo.v2", ["apiKey"]);
		const service = configService(h);

		await service.update(pluginId, dottedField, { "api.key": "sk-dotted-field" });
		await service.update(pluginId, dottedId, { apiKey: "sk-dotted-id" });
		expect(h.credentials().map((c) => [c.id, c.auth])).toEqual([
			[`plugin:${pluginId}:demo`, { kind: "opaque", fields: { "api.key": "sk-dotted-field" } }],
			[`plugin:${pluginId}:demo.v2`, { kind: "opaque", fields: { apiKey: "sk-dotted-id" } }],
		]);
		expect(await h.vault.getSecret({ pluginId, key: "provider.demo.api.key" })).toBe(
			"sk-dotted-field",
		);

		// A refresh keeping both providers must not drop either credential.
		expect(await h.vault.pruneProviderSecrets(pluginId, ["demo", "demo.v2"])).toBe(0);
		expect(h.credentials()).toHaveLength(2);
		expect((await configService(h).list(pluginId)).map((v) => v.secretsSet)).toEqual([
			["api.key"],
			["apiKey"],
		]);
	});

	test("concurrent writes to one provider do not lose fields", async () => {
		const h = home({ unified: true });
		provider(h, "demo", ["a", "b", "c"]);
		await Promise.all(
			["a", "b", "c"].map((field) =>
				h.vault.setSecret({ pluginId, key: `provider.demo.${field}`, value: `v-${field}` }),
			),
		);
		expect(h.credentials()[0]?.auth).toEqual({
			kind: "opaque",
			fields: { a: "v-a", b: "v-b", c: "v-c" },
		});
	});

	test("a field dropped from the schema can still be read and cleared", async () => {
		const h = home({ unified: true });
		provider(h, "demo", []); // the provider no longer declares any secret field
		savePluginProviderSecrets(getCredentialStore(h.dir), [
			{ pluginId, contributionId: "demo", fields: { apiKey: "sk-1" } },
		]);
		expect(await h.vault.getSecret({ pluginId, key: "provider.demo.apiKey" })).toBe("sk-1");
		expect(await h.vault.listKeys(pluginId)).toEqual(["provider.demo.apiKey"]);
		expect(await h.vault.deleteSecret({ pluginId, key: "provider.demo.apiKey" })).toBe(true);
		expect(h.credentials()).toEqual([]);
	});

	test("pruning drops removed providers' credentials; uninstalling drops all of the plugin's", async () => {
		const h = home({ unified: true });
		provider(h, "demo", ["apiKey", "region"]);
		provider(h, "old.v2");
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
		expect(h.credentials().map((c) => c.id)).toEqual([`plugin:${pluginId}:demo`]);

		expect(await h.vault.deletePlugin(pluginId)).toBe(3);
		expect(h.credentials()).toEqual([]);
		expect(await h.vault.listKeys(pluginId)).toEqual([]);
	});

	test("an unreadable credentials.json is never written, and yields no provider secrets", async () => {
		const h = home({ unified: true });
		provider(h);
		await h.vault.setSecret({ pluginId, key: "provider.demo.apiKey", value: "sk-1" });
		h.restart();
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
		provider(h);
		mkdirSync(join(h.dir, "plugins"), { recursive: true });
		await h.vault.setSecret({ pluginId, key: "provider.demo.apiKey", value: "sk-1" });
		expect(h.vaultFile()).toContain("sk-1");
		expect(existsSync(join(h.dir, CREDENTIALS_FILE))).toBe(false);
		expect(await h.vault.getSecret({ pluginId, key: "provider.demo.apiKey" })).toBe("sk-1");
	});
});

describe("plugin provider secret migration", () => {
	/** A vault as a pre-unification instance left it, with one declared and one unknown key. */
	async function seeded(options: { unified?: boolean; vault?: string } = {}) {
		const h = home({ unified: options.unified !== false });
		provider(h, "demo", ["apiKey", "api.key"]);
		mkdirSync(join(h.dir, "plugins"), { recursive: true });
		writeFileSync(
			h.vault.path,
			options.vault ??
				JSON.stringify({
					version: 1,
					secrets: {
						[pluginId]: {
							"provider.demo.apiKey": "sk-a",
							"provider.demo.api.key": "sk-dotted",
							"provider.unknown.apiKey": "sk-unknown",
							"session.token": "t-1",
						},
					},
				}),
			{ mode: 0o600 },
		);
		return h;
	}

	test("moves declared fields after an owner-only backup, and leaves everything else", async () => {
		const h = await seeded();
		expect(await h.vault.migrateProviderSecrets(pluginId)).toBe(1);
		expect(h.credentials().map((c) => [c.id, c.auth])).toEqual([
			[
				`plugin:${pluginId}:demo`,
				{ kind: "opaque", fields: { apiKey: "sk-a", "api.key": "sk-dotted" } },
			],
		]);
		expect(h.vaultJson().secrets[pluginId]).toEqual({
			"provider.unknown.apiKey": "sk-unknown",
			"session.token": "t-1",
		});
		expect(statSync(h.vault.path).mode & 0o777).toBe(0o600);

		const [backup] = h.backups();
		expect(backup).toMatch(/^pre-plugin-credentials-/);
		const dir = join(h.dir, CREDENTIAL_BACKUPS_DIR, backup as string);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8"))).toMatchObject({
			secrets: { [pluginId]: { "provider.demo.apiKey": "sk-a" } },
		});
	});

	test("idempotent, and an existing credential wins over the vault's copy", async () => {
		const h = await seeded();
		await h.vault.migrateProviderSecrets(pluginId);
		const [credentials, vault, backups] = [h.credentials(), h.vaultFile(), h.backups()];
		expect(await h.vault.migrateProviderSecrets(pluginId)).toBe(0);
		expect([h.credentials(), h.vaultFile(), h.backups()]).toEqual([credentials, vault, backups]);

		// As after a crash between writing credentials and cleaning the vault.
		const crash = await seeded();
		savePluginProviderSecrets(getCredentialStore(crash.dir), [
			{ pluginId, contributionId: "demo", fields: { apiKey: "sk-new" } },
		]);
		expect(await crash.vault.migrateProviderSecrets(pluginId)).toBe(1);
		expect(crash.credentials()[0]?.auth).toEqual({
			kind: "opaque",
			fields: { apiKey: "sk-new", "api.key": "sk-dotted" },
		});
		expect(crash.vaultJson().secrets[pluginId]).toEqual({
			"provider.unknown.apiKey": "sk-unknown",
			"session.token": "t-1",
		});
	});

	test("a secret cleared after a failed vault clean-up does not come back", async () => {
		const h = await seeded();
		savePluginProviderSecrets(getCredentialStore(h.dir), [
			{ pluginId, contributionId: "demo", fields: { apiKey: "sk-a", "api.key": "sk-dotted" } },
		]);
		// Clearing removes both the credential and the vault copy the clean-up left behind.
		await h.vault.deleteSecret({ pluginId, key: "provider.demo.apiKey" });
		await h.vault.deleteSecret({ pluginId, key: "provider.demo.api.key" });
		expect(h.credentials()).toEqual([]);
		expect(await h.vault.migrateProviderSecrets(pluginId)).toBe(0);
		expect(h.credentials()).toEqual([]);
	});

	test("an unreadable vault or credentials.json means no writes", async () => {
		const brokenVault = await seeded({ vault: "{not json" });
		expect(await brokenVault.vault.migrateProviderSecrets(pluginId)).toBe(0);
		expect(brokenVault.vaultFile()).toBe("{not json");
		expect(brokenVault.credentials()).toEqual([]);
		expect(brokenVault.backups()).toEqual([]);

		const brokenStore = await seeded();
		brokenStore.restart();
		writeFileSync(join(brokenStore.dir, CREDENTIALS_FILE), "{not json");
		expect(await brokenStore.vault.migrateProviderSecrets(pluginId)).toBe(0);
		expect(brokenStore.vaultJson().secrets[pluginId]["provider.demo.apiKey"]).toBe("sk-a");
		expect(brokenStore.backups()).toEqual([]);
	});

	test("a field declared later is merged in without overwriting the stored fields", async () => {
		const h = home({ unified: true });
		provider(h, "demo", ["apiKey", "refreshToken"]);
		savePluginProviderSecrets(getCredentialStore(h.dir), [
			{ pluginId, contributionId: "demo", fields: { apiKey: "sk-current" } },
		]);
		mkdirSync(join(h.dir, "plugins"), { recursive: true });
		writeFileSync(
			h.vault.path,
			JSON.stringify({
				version: 1,
				secrets: {
					[pluginId]: { "provider.demo.apiKey": "sk-old", "provider.demo.refreshToken": "rt-1" },
				},
			}),
		);
		expect(await h.vault.migrateProviderSecrets(pluginId)).toBe(1);
		expect(h.credentials()[0]?.auth).toEqual({
			kind: "opaque",
			fields: { apiKey: "sk-current", refreshToken: "rt-1" },
		});
		expect(h.vaultJson().secrets[pluginId]).toEqual({});
	});

	test("migration then pruning keeps a dotted provider's undeclared keys, drops removed ones", async () => {
		const h = home({ unified: true });
		provider(h, "demo.v2", ["apiKey"]);
		mkdirSync(join(h.dir, "plugins"), { recursive: true });
		writeFileSync(
			h.vault.path,
			JSON.stringify({
				version: 1,
				secrets: {
					[pluginId]: {
						"provider.demo.v2.apiKey": "sk-1",
						"provider.demo.v2.sessionToken": "st-1",
						"provider.ghost.apiKey": "sk-ghost",
					},
				},
			}),
		);
		await h.vault.migrateProviderSecrets(pluginId);
		expect(await h.vault.pruneProviderSecrets(pluginId, ["demo.v2"])).toBe(1);
		expect(h.vaultJson().secrets[pluginId]).toEqual({ "provider.demo.v2.sessionToken": "st-1" });
		expect(h.credentials()[0]?.auth).toEqual({ kind: "opaque", fields: { apiKey: "sk-1" } });
	});

	test("a legacy instance keeps its vault", async () => {
		const h = await seeded({ unified: false });
		expect(await h.vault.migrateProviderSecrets(pluginId)).toBe(0);
		expect(h.vaultJson().secrets[pluginId]["provider.demo.apiKey"]).toBe("sk-a");
		expect(existsSync(join(h.dir, CREDENTIALS_FILE))).toBe(false);
	});
});
