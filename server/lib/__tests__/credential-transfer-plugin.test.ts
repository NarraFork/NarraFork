import { afterEach, describe, expect, test } from "bun:test";
import { pluginProviderRegistry } from "../../services/plugin-provider-registry";
import { pluginSecretVault } from "../../services/plugin-secret-vault";
import { getCredentialStore } from "../credential-store";
import {
	applyCredentialImport,
	exportCredentials,
	listTransferableCredentials,
	previewCredentialImport,
} from "../credential-transfer";
import { type BundleItem, openBundle, sealBundle } from "../credential-transfer/bundle";
import {
	type CredentialTransferData,
	collectProviderTransferItems,
} from "../credential-transfer/kinds";
import { pluginCredentialId } from "../plugin-credentials";
import { getProviderKeyStore } from "../provider-keys";
import { settings } from "../settings";

const PLUGIN = "com.example.transfer";
const OTHER = "com.example.other";
const CONTRIBUTION = "demo.v2";
const ID = pluginCredentialId(PLUGIN, CONTRIBUTION);
const PASSPHRASE = "plugin transfer passphrase";
const actor = { userId: "admin" };

function declare(pluginId = PLUGIN, contributionId = CONTRIBUTION, version = "1") {
	pluginProviderRegistry.register({
		kind: "executable-plugin",
		pluginId,
		localId: contributionId,
		providerInstanceId: `${pluginId}/${contributionId}@${version}`,
		providerPrefix: pluginId === PLUGIN ? "transfer-demo" : "transfer-other",
		displayName: "Installed provider",
		capabilities: { chat: true },
		configSchema: {
			type: "object",
			properties: {
				"api.key": { type: "string", format: "password" },
				region: { type: "string", writeOnly: true },
				public: { type: "string" },
			},
		},
	});
}

async function source(fields = { "api.key": "source-secret", region: "private-region" }) {
	declare();
	await pluginSecretVault.replaceProviderSecrets(PLUGIN, CONTRIBUTION, fields);
	const result = await exportCredentials([{ kind: "credential", id: ID }], PASSPHRASE, actor);
	return result.text;
}

async function fields() {
	return pluginSecretVault.getProviderSecrets(PLUGIN, CONTRIBUTION);
}

async function apply(text: string, action: "import" | "replace" = "import") {
	return applyCredentialImport(text, PASSPHRASE, new Map([[0, action]]), actor);
}

afterEach(async () => {
	for (const plugin of [PLUGIN, OTHER]) {
		await pluginSecretVault.deletePlugin(plugin);
		pluginProviderRegistry.removePlugin(plugin);
	}
});

describe("plugin credential transfer", () => {
	test("exports only the field bag and stable identity, and maps across installed versions", async () => {
		await source();
		await pluginSecretVault.setSecret({
			pluginId: PLUGIN,
			key: "session.token",
			value: "non-provider-secret",
		});
		const { text } = await exportCredentials([{ kind: "credential", id: ID }], PASSPHRASE, actor);
		expect((await listTransferableCredentials()).find((item) => item.id === ID)).toEqual({
			kind: "credential",
			id: ID,
			label: "Installed provider",
		});
		const contents = await openBundle(text, PASSPHRASE);
		expect(contents.items).toHaveLength(1);
		const data = contents.items[0]?.data as CredentialTransferData;
		expect(data).toMatchObject({
			templateId: "plugin",
			group: { id: ID, pluginId: PLUGIN, contributionId: CONTRIBUTION },
			credential: {
				target: { pluginContributionId: `${PLUGIN}/${CONTRIBUTION}` },
				auth: { kind: "opaque" },
			},
		});
		expect(data.credential).not.toHaveProperty("id");
		expect(JSON.stringify(contents)).not.toContain("providerInstanceId");
		expect(JSON.stringify(contents)).not.toContain("@1");
		expect(JSON.stringify(contents)).not.toContain("non-provider-secret");
		for (const secret of ["source-secret", "private-region", "non-provider-secret"]) {
			expect(text).not.toContain(secret);
		}
		await pluginSecretVault.replaceProviderSecrets(PLUGIN, CONTRIBUTION, {});
		pluginProviderRegistry.removePlugin(PLUGIN);
		declare(PLUGIN, CONTRIBUTION, "new-hash");
		expect((await previewCredentialImport(text, PASSPHRASE)).items[0]).toMatchObject({
			kind: "credential",
			existingId: undefined,
		});
		expect(await apply(text)).toEqual({ added: 1, replaced: 0, skipped: 0 });
		expect(await fields()).toEqual({ "api.key": "source-secret", region: "private-region" });
		expect(await pluginSecretVault.getSecret({ pluginId: PLUGIN, key: "session.token" })).toBe(
			"non-provider-secret",
		);
		const stored = getCredentialStore()
			.pluginCredentials()
			.find((c) => c.id === ID);
		if (getCredentialStore().unified)
			expect(stored?.target).toEqual({ pluginContributionId: `${PLUGIN}/${CONTRIBUTION}` });
	});

	test("an existing bag requires explicit replace; identical bags dedupe through the template", async () => {
		const text = await source({ "api.key": "incoming", region: "incoming-region" });
		await pluginSecretVault.replaceProviderSecrets(PLUGIN, CONTRIBUTION, { "api.key": "local" });
		expect((await previewCredentialImport(text, PASSPHRASE)).items[0]?.existingId).toBe(ID);
		expect(await apply(text)).toEqual({ added: 0, replaced: 0, skipped: 1 });
		expect(await fields()).toEqual({ "api.key": "local" });
		expect(await apply(text, "replace")).toEqual({ added: 0, replaced: 1, skipped: 0 });
		expect(await fields()).toEqual({ "api.key": "incoming", region: "incoming-region" });
		expect(await apply(text, "replace")).toEqual({ added: 0, replaced: 0, skipped: 1 });
	});

	test("missing and incompatible installations are unsupported, never fabricated as API groups", async () => {
		const text = await source();
		const before = structuredClone(settings.customApiProviders);
		await pluginSecretVault.deletePlugin(PLUGIN);
		pluginProviderRegistry.removePlugin(PLUGIN);
		for (const incompatible of [false, true]) {
			if (incompatible) {
				declare();
				pluginProviderRegistry.markPluginIncompatible(PLUGIN);
			}
			expect((await previewCredentialImport(text, PASSPHRASE)).items[0]?.unsupported).toBe(true);
			expect(await apply(text)).toEqual({ added: 0, replaced: 0, skipped: 1 });
			expect(await fields()).toEqual({});
			expect(settings.customApiProviders).toEqual(before);
		}
	});

	test("rejects malformed identities, cross-plugin targets and undeclared/non-provider writes", async () => {
		const text = await source();
		declare(OTHER);
		await pluginSecretVault.replaceProviderSecrets(OTHER, CONTRIBUTION, {
			"api.key": "other-local",
		});
		const { items } = await openBundle(text, PASSPHRASE);
		const item = items[0] as BundleItem;
		const original = item.data as CredentialTransferData;
		const changes: Array<(data: CredentialTransferData) => void> = [
			(data) => {
				data.group.pluginId = OTHER;
			},
			(data) => {
				data.group.id = `${PLUGIN}/${CONTRIBUTION}@old-hash`;
			},
			(data) => {
				if (data.credential)
					data.credential.target = { pluginContributionId: `${OTHER}/${CONTRIBUTION}` };
			},
			(data) => {
				if (data.credential) data.credential.auth = { kind: "opaque", fields: { public: "leak" } };
			},
			(data) => {
				if (data.credential)
					data.credential.auth = { kind: "opaque", fields: { "session.token": "overwrite" } };
			},
			(data) => {
				if (data.credential)
					data.credential.auth = { kind: "opaque", fields: { "api.key": 123 } as never };
			},
			(data) => {
				if (data.credential) data.credential.auth = { kind: "opaque", fields: [] as never };
			},
			(data) => {
				data.groupSecrets = { quotaAccessToken: "injected" };
			},
		];
		for (const change of changes) {
			const data = structuredClone(original);
			change(data);
			const tampered = await sealBundle({ exportedAt: 1, items: [{ ...item, data }] }, PASSPHRASE);
			expect((await previewCredentialImport(tampered, PASSPHRASE)).items[0]?.unsupported).toBe(
				true,
			);
			expect(await apply(tampered, "replace")).toEqual({ added: 0, replaced: 0, skipped: 1 });
		}
		expect(await fields()).toEqual({ "api.key": "source-secret", region: "private-region" });
		expect(await pluginSecretVault.getProviderSecrets(OTHER, CONTRIBUTION)).toEqual({
			"api.key": "other-local",
		});
		expect(
			await pluginSecretVault.getSecret({ pluginId: PLUGIN, key: "session.token" }),
		).toBeUndefined();
	}, 20_000);

	test("ambiguous dotted names follow the Vault's declared ProviderSecretRef, not string splitting", async () => {
		declare();
		pluginProviderRegistry.register({
			kind: "executable-plugin",
			pluginId: PLUGIN,
			localId: "demo",
			providerInstanceId: `${PLUGIN}/demo@1`,
			providerPrefix: "transfer-dot",
			displayName: "Other declaration",
			capabilities: { chat: true },
			configSchema: {
				type: "object",
				properties: { "v2.api.key": { type: "string", format: "password" } },
			},
		});
		// The key provider.demo.v2.api.key resolves to demo.v2 / api.key, declared first.
		expect(
			pluginSecretVault.supportsProviderSecrets(PLUGIN, "demo", { "v2.api.key": "unsafe" }),
		).toBe(false);
		await expect(
			pluginSecretVault.replaceProviderSecrets(PLUGIN, "demo", { "v2.api.key": "unsafe" }),
		).rejects.toThrow("Unsupported provider secret fields");
		expect(await fields()).toEqual({});
	});

	test("old unsupported plugin items retain their index and do not affect valid entries", async () => {
		const text = await source();
		const contents = await openBundle(text, PASSPHRASE);
		await pluginSecretVault.replaceProviderSecrets(PLUGIN, CONTRIBUTION, {});
		const mixed = await sealBundle(
			{
				exportedAt: 1,
				items: [
					{
						kind: "plugin",
						id: "old",
						label: "Old unsupported format",
						data: { providerInstanceId: "unstable" },
					},
					...contents.items,
				],
			},
			PASSPHRASE,
		);
		const preview = await previewCredentialImport(mixed, PASSPHRASE);
		expect(preview.items.map((item) => [item.index, !!item.unsupported])).toEqual([
			[0, true],
			[1, false],
		]);
		expect(
			await applyCredentialImport(
				mixed,
				PASSPHRASE,
				new Map([
					[0, "import"],
					[1, "import"],
				]),
				actor,
			),
		).toEqual({ added: 1, replaced: 0, skipped: 1 });
	});

	test("data export stays provider-only and does not silently include executable plugin installs", async () => {
		await source();
		expect(collectProviderTransferItems({})).toEqual([]);
	});

	test("clearing providers removes imported fields but preserves search keys and other plugin secrets", async () => {
		await source();
		await pluginSecretVault.setSecret({
			pluginId: PLUGIN,
			key: "session.token",
			value: "keep-session",
		});
		const key = getProviderKeyStore().add("search:keep-search", { apiKey: "keep-search" });
		try {
			const { clearData } = await import("../../services/data-portability");
			await clearData("providers");
			expect(await fields()).toEqual({});
			expect(await pluginSecretVault.getSecret({ pluginId: PLUGIN, key: "session.token" })).toBe(
				"keep-session",
			);
			expect(getProviderKeyStore().get(key.id)?.apiKey).toBe("keep-search");
		} finally {
			getProviderKeyStore().remove(key.id);
		}
	});
});
