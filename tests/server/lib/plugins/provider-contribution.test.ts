import { describe, expect, it } from "bun:test";
import { providerPrefixSchema, safeParseManifest } from "@server/lib/plugins/manifest";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";

/**
 * The provider contribution is the manifest half of provider registration: the
 * host reads these fields to register a provider (and surface it in the model
 * picker) before the plugin process is ever started.
 *
 * Two invariants matter here:
 *
 * 1. The manifest's `providerPrefix` rule must match the registry's runtime
 *    `assertPrefix()` check. If they disagree, a manifest can validate at install
 *    time and then fail at registration — a failure mode with no good UI.
 * 2. Every new field stays optional, so manifests written before provider
 *    registration existed keep validating.
 */

const fixtureDirectory = new URL("../../../fixtures/plugins/", import.meta.url);

async function manifestWithProvider(provider: Record<string, unknown>): Promise<unknown> {
	const base = (await Bun.file(new URL("valid-manifest.json", fixtureDirectory)).json()) as Record<
		string,
		unknown
	>;
	const contributes = (base.contributes ?? {}) as Record<string, unknown>;
	return {
		...base,
		contributes: { ...contributes, providers: [{ id: "p1", ...provider }] },
		activationEvents: ["onProvider:p1"],
	};
}

async function accepts(provider: Record<string, unknown>): Promise<boolean> {
	return safeParseManifest(await manifestWithProvider(provider)).success;
}

/**
 * Registration only reports a prefix problem through `assertPrefix()`; any other
 * rejection means the prefix itself was accepted.
 */
function registryAcceptsPrefix(prefix: string): boolean {
	try {
		new PluginProviderRegistry().register({
			kind: "executable-plugin",
			pluginId: "com.example.parity",
			localId: "p1",
			providerInstanceId: "instance-1",
			providerPrefix: prefix,
			displayName: "Parity",
		});
		return true;
	} catch (error) {
		return !String(error).includes("Provider prefix must be");
	}
}

describe("provider contribution manifest fields", () => {
	it("keeps every added field optional so existing manifests still validate", async () => {
		expect(await accepts({})).toBe(true);
	});

	it("accepts the fields the host needs to register a provider", async () => {
		expect(
			await accepts({
				providerPrefix: "myprov",
				defaultModelId: "claude-sonnet-4.5",
				capabilities: { chat: true, generate: true, mayLeakXmlToolCalls: true },
				limits: { maxConcurrentChat: 4, maxModelPageSize: 50 },
			}),
		).toBe(true);
	});

	it("rejects prefixes that cannot survive the `provider:model` split", async () => {
		// A colon would make the model value ambiguous; whitespace and control
		// characters cannot round-trip through settings or the model picker.
		expect(await accepts({ providerPrefix: "my:prov" })).toBe(false);
		expect(await accepts({ providerPrefix: "my prov" })).toBe(false);
		expect(await accepts({ providerPrefix: "" })).toBe(false);
		expect(await accepts({ providerPrefix: "x".repeat(33) })).toBe(false);
		expect(await accepts({ providerPrefix: "x".repeat(32) })).toBe(true);
	});

	it("refuses host model sentinels as a default model", async () => {
		// These resolve dynamically in settings; a plugin must not claim them.
		expect(await accepts({ defaultModelId: "__default__" })).toBe(false);
		expect(await accepts({ defaultModelId: "__summary__" })).toBe(false);
		expect(await accepts({ defaultModelId: "claude-haiku-4.5" })).toBe(true);
	});

	it("rejects unknown or out-of-range capability and limit fields", async () => {
		expect(await accepts({ capabilities: { bogus: true } })).toBe(false);
		expect(await accepts({ limits: { bogus: 1 } })).toBe(false);
		expect(await accepts({ limits: { maxConcurrentChat: 0 } })).toBe(false);
		expect(await accepts({ limits: { maxConcurrentChat: 999 } })).toBe(false);
	});

	it("agrees with the registry's runtime prefix rule", () => {
		// Covers the ASCII boundary, the colon separator, whitespace, DEL and
		// non-ASCII — the cases where a regex and a codepoint loop tend to drift.
		const samples = [
			"ok",
			"my-prov",
			"my_prov",
			"a.b",
			"MyProv",
			"~",
			"!",
			"9",
			"x".repeat(32),
			"x".repeat(33),
			"",
			"a:b",
			"a b",
			"a\tb",
			"aéb",
			"é",
			"a\u007f",
		];
		for (const sample of samples) {
			expect(
				providerPrefixSchema.safeParse(sample).success,
				`manifest and registry disagree on ${JSON.stringify(sample)}`,
			).toBe(registryAcceptsPrefix(sample));
		}
	});
});
