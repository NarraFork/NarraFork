import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseManifest } from "@server/lib/plugins/manifest";
import { applyCommandSecretWrites } from "@server/services/plugin-command-secret-writes";
import { secretFieldsOf } from "@server/services/plugin-provider-config-service";
import { PluginProviderCredentialResolver } from "@server/services/plugin-provider-credential-resolver";
import { providerRegistrationsFromManifest } from "@server/services/plugin-provider-manifest";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";
import { PluginSecretVault } from "@server/services/plugin-secret-vault";
import { parseEnabledModels } from "../../../../examples/plugins/cline-external/src/credentials";
import { buildCatalog } from "../../../../examples/plugins/cline-external/src/models";

/**
 * The enabled-model round trip, driven through the host's real services.
 *
 * ## What this protects
 *
 * `enabledModels` is written by a plugin **command** and read by `provider.listModels`. Those
 * are two different transports, and nothing in the type system connects them: the command
 * returns `secretWrites` that the host validates and stores, and the value comes back injected
 * into `config` on a later provider call. If any link in that chain breaks — the field stops
 * being recognised as secret, the key falls outside the writable namespace, the schema type
 * changes from `string` — the failure is silent. The user picks models, the save reports
 * success, and the picker stays empty.
 *
 * So this exercises the whole chain with the host's own implementations rather than stubs:
 *
 *   configSchema → secretFieldsOf → applyCommandSecretWrites → vault
 *                → PluginProviderCredentialResolver → config → buildCatalog
 *
 * Every step is the production class. A stub anywhere would let the test agree with itself
 * while production disagreed.
 */

const PLUGIN_ROOT = resolve(import.meta.dir, "../../../../examples/plugins/cline-external");
const ENABLED_MODELS_KEY = "provider.cline.enabledModels";
const CREDENTIALS_KEY = "provider.cline.credentials";

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function loadManifest() {
	return parseManifest(JSON.parse(await readFile(join(PLUGIN_ROOT, "manifest.json"), "utf8")));
}

/** A registry with this plugin's provider registered, exactly as the host would register it. */
async function registeredProvider() {
	const manifest = await loadManifest();
	const registry = new PluginProviderRegistry();
	for (const registration of providerRegistrationsFromManifest({
		manifest,
		generation: `${manifest.version}:enabled-models-test`,
	})) {
		registry.register(registration);
	}
	const entry = registry.list()[0];
	return { manifest, registry, entry };
}

async function vault() {
	const root = await mkdtemp(join(tmpdir(), "nf-cline-enabled-"));
	roots.push(root);
	return new PluginSecretVault({ root });
}

describe("cline-external enabledModels: the schema makes injection possible", () => {
	test("both credentials and enabledModels are recognised as secret fields", async () => {
		// `secretFieldsOf` is what decides which fields the host injects. A field it does not
		// return is never merged into `config`, so `listModels` would never see it.
		const { entry } = await registeredProvider();
		expect(secretFieldsOf(entry.configSchema)).toEqual(["credentials", "enabledModels"]);
	});

	test("enabledModels is declared as a string, which is what secretFieldsOf requires", async () => {
		// The trap this pins down: `type: "array"` reads more naturally for a list, and
		// `secretFieldsOf` silently skips any non-string property. Declaring it as an array would
		// break injection with no error anywhere.
		// Note the shape: a manifest `configSchema` is the bare *properties map*, not a whole
		// JSON Schema document — `configSchemaFor` in `plugin-provider-manifest.ts` wraps it into
		// `{type:"object", properties, additionalProperties:false}`. Declaring the wrapper here
		// too produced a doubly-nested schema that `parseManifest` accepted and the registry then
		// rejected at registration with "schema node must be JSON object or boolean". This
		// assertion reads the map directly so that mistake cannot come back unnoticed.
		const manifest = (await Bun.file(join(PLUGIN_ROOT, "manifest.json")).json()) as {
			contributes: { providers: Array<{ configSchema: Record<string, { type?: string }> }> };
		};
		const properties = manifest.contributes.providers[0].configSchema;
		expect(properties.enabledModels.type).toBe("string");
		expect(properties.credentials.type).toBe("string");
		// The wrapper keys must not appear at this level.
		expect(properties.type).toBeUndefined();
		expect(properties.properties).toBeUndefined();
	});

	test("the provider contribution id matches the vault key namespace", async () => {
		// The key is `provider.<contributionId>.<field>`, derived from the registry rather than
		// from the request. A contribution id of `cline-ext` (the user-facing prefix) would put
		// every write outside the writable namespace.
		const { entry } = await registeredProvider();
		expect(entry.localId).toBe("cline");
		expect(ENABLED_MODELS_KEY).toBe(`provider.${entry.localId}.enabledModels`);
		// The prefix is deliberately different from the contribution id.
		expect(entry.providerPrefix).toBe("cline-ext");
	});
});

describe("cline-external enabledModels: the write survives host validation", () => {
	test("a selection written by a command lands in the vault", async () => {
		const { manifest, registry } = await registeredProvider();
		const sink = await vault();
		const models = ["anthropic/claude-sonnet-4.6", "deepseek/deepseek-chat"];

		// The shape `config.setEnabledModels` returns.
		const result = await applyCommandSecretWrites({
			pluginId: manifest.pluginId,
			writes: [{ key: ENABLED_MODELS_KEY, value: JSON.stringify(models) }],
			registry,
			sink,
		});

		expect(result.written).toEqual([ENABLED_MODELS_KEY]);
		expect(await sink.getSecret({ pluginId: manifest.pluginId, key: ENABLED_MODELS_KEY })).toBe(
			JSON.stringify(models),
		);
	});

	test("a key outside the plugin's namespace is rejected", async () => {
		// Confirms the namespace check is live rather than assumed: the plugin can only propose
		// writes under contributions it actually registered.
		const { manifest, registry } = await registeredProvider();
		const sink = await vault();
		await expect(
			applyCommandSecretWrites({
				pluginId: manifest.pluginId,
				registry,
				sink,
			}),
		).rejects.toThrow();
	});

	test("signing out deletes the credential and leaves the selection intact", async () => {
		// The selection is a preference, not part of the session. Making the user rebuild it after
		// every sign-out would be gratuitous.
		const { manifest, registry } = await registeredProvider();
		const sink = await vault();
		await applyCommandSecretWrites({
			pluginId: manifest.pluginId,
			writes: [
				{ key: ENABLED_MODELS_KEY, value: '["a/b"]' },
				{ key: CREDENTIALS_KEY, value: '{"accessToken":"at","refreshToken":"rt"}' },
			],
			registry,
			sink,
		});

		// What `auth.logout` returns.
		await applyCommandSecretWrites({
			pluginId: manifest.pluginId,
			writes: [{ key: CREDENTIALS_KEY, value: null }],
			registry,
			sink,
		});

		expect(
			await sink.getSecret({ pluginId: manifest.pluginId, key: CREDENTIALS_KEY }),
		).toBeUndefined();
		expect(await sink.getSecret({ pluginId: manifest.pluginId, key: ENABLED_MODELS_KEY })).toBe(
			'["a/b"]',
		);
	});
});

describe("cline-external enabledModels: the value comes back as config", () => {
	test("the resolver injects the stored selection into provider config", async () => {
		const { manifest, registry, entry } = await registeredProvider();
		const sink = await vault();
		const models = ["anthropic/claude-opus-4.6", "x-ai/grok-4"];

		await applyCommandSecretWrites({
			pluginId: manifest.pluginId,
			writes: [{ key: ENABLED_MODELS_KEY, value: JSON.stringify(models) }],
			registry,
			sink,
		});

		const resolver = new PluginProviderCredentialResolver({ registry, secretSource: sink });
		const config = await resolver.resolve(entry.providerInstanceId);
		expect(config.enabledModels).toBe(JSON.stringify(models));
	});

	test("the full loop ends with listModels serving exactly what was saved", async () => {
		// The assertion the whole file exists for: a save in the settings view becomes models in
		// the picker.
		const { manifest, registry, entry } = await registeredProvider();
		const sink = await vault();
		const models = ["anthropic/claude-sonnet-4.6", "deepseek/deepseek-chat"];

		await applyCommandSecretWrites({
			pluginId: manifest.pluginId,
			writes: [{ key: ENABLED_MODELS_KEY, value: JSON.stringify(models) }],
			registry,
			sink,
		});

		const resolver = new PluginProviderCredentialResolver({ registry, secretSource: sink });
		const config = await resolver.resolve(entry.providerInstanceId);
		const catalog = buildCatalog(parseEnabledModels(config.enabledModels));

		expect(catalog.models.map((model) => model.id)).toEqual(models);
		expect(catalog.stale).toBeUndefined();
	});

	test("a later save replaces the selection rather than merging with it", async () => {
		const { manifest, registry, entry } = await registeredProvider();
		const sink = await vault();
		const resolver = new PluginProviderCredentialResolver({ registry, secretSource: sink });

		for (const models of [["a/one", "b/two"], ["c/three"]]) {
			await applyCommandSecretWrites({
				pluginId: manifest.pluginId,
				writes: [{ key: ENABLED_MODELS_KEY, value: JSON.stringify(models) }],
				registry,
				sink,
			});
		}

		const config = await resolver.resolve(entry.providerInstanceId);
		expect(parseEnabledModels(config.enabledModels)).toEqual(["c/three"]);
	});

	test("an unset selection is absent from config, and the catalog reports stale", async () => {
		// The host omits an unset secret rather than sending an empty string, so "never chosen"
		// and "chosen nothing" look the same here — both must yield a stale, empty catalog rather
		// than an error.
		const { registry, entry } = await registeredProvider();
		const sink = await vault();
		const resolver = new PluginProviderCredentialResolver({ registry, secretSource: sink });

		const config = await resolver.resolve(entry.providerInstanceId);
		expect("enabledModels" in config).toBe(false);

		const catalog = buildCatalog(parseEnabledModels(config.enabledModels));
		expect(catalog.models).toEqual([]);
		expect(catalog.stale).toBe(true);
	});

	test("the credential is injected by the same mechanism", async () => {
		// Same chain, so a break in it would take sign-in down with the model list. Asserted
		// together because they share the failure mode.
		const { manifest, registry, entry } = await registeredProvider();
		const sink = await vault();
		const credentials = JSON.stringify({
			accessToken: "at",
			refreshToken: "rt",
			expiresAt: 4_000_000_000,
			email: "a@b.c",
			displayName: "N",
			startedAt: 1,
		});

		await applyCommandSecretWrites({
			pluginId: manifest.pluginId,
			writes: [{ key: CREDENTIALS_KEY, value: credentials }],
			registry,
			sink,
		});

		const resolver = new PluginProviderCredentialResolver({ registry, secretSource: sink });
		const config = await resolver.resolve(entry.providerInstanceId);
		expect(config.credentials).toBe(credentials);
	});
});
