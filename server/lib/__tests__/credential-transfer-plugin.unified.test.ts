import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { seedUnifiedCredentials } from "../../../tests/unified-credentials";
import { pluginProviderRegistry } from "../../services/plugin-provider-registry";
import { pluginSecretVault } from "../../services/plugin-secret-vault";
import { getCredentialStore, resetCredentialStoresForTests } from "../credential-store";
import {
	applyCredentialImport,
	exportCredentials,
	previewCredentialImport,
} from "../credential-transfer";
import { pluginCredentialId, savePluginProviderSecrets } from "../plugin-credentials";
import { getProviderKeyStore } from "../provider-keys";
import { readSecretJSON } from "../secret-store";

seedUnifiedCredentials();
const PLUGIN = "com.example.transfer";
const CONTRIBUTION = "demo.v2";
const ID = pluginCredentialId(PLUGIN, CONTRIBUTION);
const PASSPHRASE = "plugin transfer passphrase";
const actor = { userId: "admin" };

function declare(version = "1") {
	pluginProviderRegistry.register({
		kind: "executable-plugin",
		pluginId: PLUGIN,
		localId: CONTRIBUTION,
		providerInstanceId: `${PLUGIN}/${CONTRIBUTION}@${version}`,
		providerPrefix: "transfer-demo",
		displayName: "Installed provider",
		capabilities: { chat: true },
		configSchema: {
			type: "object",
			properties: {
				"api.key": { type: "string", format: "password" },
				region: { type: "string", writeOnly: true },
			},
		},
	});
}

async function source() {
	declare();
	await pluginSecretVault.replaceProviderSecrets(PLUGIN, CONTRIBUTION, { "api.key": "source" });
	return (await exportCredentials([{ kind: "credential", id: ID }], PASSPHRASE, actor)).text;
}

const fields = () => pluginSecretVault.getProviderSecrets(PLUGIN, CONTRIBUTION);
const apply = (text: string, passphrase = PASSPHRASE) =>
	applyCredentialImport(text, passphrase, new Map([[0, "replace"]]), actor);

afterEach(async () => {
	await pluginSecretVault.deletePlugin(PLUGIN);
	pluginProviderRegistry.removePlugin(PLUGIN);
});

test("unified plugin transfer resolves stable dotted refs and preserves other credential owners", async () => {
	const text = await source();
	const store = getCredentialStore();
	expect(store.unified).toBe(true);
	store.saveCodex([
		{
			id: "keep-codex",
			target: { groupId: "codex" },
			ownerUserId: null,
			priority: 0,
			createdAt: 1,
			auth: { kind: "pat", accessToken: "keep-pat" },
		},
	]);
	const keys = getProviderKeyStore();
	keys.add("keep-group", { apiKey: "keep-key" });
	const search = keys.add("search:keep-search", { apiKey: "keep-search" });
	await pluginSecretVault.setSecret({
		pluginId: PLUGIN,
		key: "session.token",
		value: "keep-session",
	});
	await pluginSecretVault.replaceProviderSecrets(PLUGIN, CONTRIBUTION, {});
	pluginProviderRegistry.removePlugin(PLUGIN);
	declare("new-hash");
	expect((await previewCredentialImport(text, PASSPHRASE)).items[0]?.unsupported).toBeUndefined();
	expect(await apply(text)).toEqual({ added: 1, replaced: 0, skipped: 0 });
	expect(await fields()).toEqual({ "api.key": "source" });
	await Promise.all([
		pluginSecretVault.replaceProviderSecrets(PLUGIN, CONTRIBUTION, { "api.key": "replacement" }),
		pluginSecretVault.setSecret({
			pluginId: PLUGIN,
			key: "provider.demo.v2.region",
			value: "concurrent",
		}),
	]);
	expect(await fields()).toEqual({ "api.key": "replacement", region: "concurrent" });
	const file = readSecretJSON(store.path) as { credentials: Array<{ id: string }> };
	expect(file.credentials.map((c) => c.id)).toEqual(expect.arrayContaining(["keep-codex", ID]));
	expect(file.credentials).toHaveLength(3);
	expect(store.pluginCredentials()[0]?.target).toEqual({
		pluginContributionId: `${PLUGIN}/${CONTRIBUTION}`,
	});
	const { clearData } = await import("../../services/data-portability");
	await clearData("providers");
	expect(await fields()).toEqual({});
	expect(await pluginSecretVault.getSecret({ pluginId: PLUGIN, key: "session.token" })).toBe(
		"keep-session",
	);
	expect(keys.get(search.id)?.apiKey).toBe("keep-search");
});

test("stored retired provider fields remain routable and can be pruned", async () => {
	declare();
	savePluginProviderSecrets(getCredentialStore(), [
		{ pluginId: PLUGIN, contributionId: CONTRIBUTION, fields: { retired: "old-secret" } },
	]);
	expect(
		pluginSecretVault.supportsProviderSecrets(PLUGIN, CONTRIBUTION, { retired: "new-secret" }),
	).toBe(true);
	await pluginSecretVault.replaceProviderSecrets(PLUGIN, CONTRIBUTION, { retired: "new-secret" });
	expect(await fields()).toEqual({ retired: "new-secret" });
	await pluginSecretVault.pruneProviderSecrets(PLUGIN, []);
	expect(await fields()).toEqual({});
});

test("wrong passphrases and unreadable unified credentials never write", async () => {
	const text = await source();
	const store = getCredentialStore();
	const bytes = readFileSync(store.path);
	await expect(apply(text, "wrong passphrase")).rejects.toThrow();
	expect(readFileSync(store.path)).toEqual(bytes);
	try {
		writeFileSync(store.path, "{broken credentials");
		resetCredentialStoresForTests();
		await expect(apply(text)).rejects.toThrow("could not be read");
		expect(readFileSync(store.path, "utf8")).toBe("{broken credentials");
	} finally {
		writeFileSync(store.path, bytes);
		resetCredentialStoresForTests();
	}
});
