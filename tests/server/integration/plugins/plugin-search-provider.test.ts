/**
 * `contributes.searchProviders` from manifest to dispatch.
 *
 * Covers the three things that decide whether a plugin search channel behaves:
 *
 * - the manifest contract, including the `providerId` binding that gives a search source its
 *   config and credentials (it has no vault namespace of its own);
 * - availability, which must be a synchronous read because it runs on a hot path;
 * - execution, which must forward the bound provider's resolved credentials.
 */

import { describe, expect, test } from "bun:test";
import { safeParseManifest } from "@server/lib/plugins/manifest";
import type { JsonValue } from "@server/lib/plugins/protocol";
import { pluginSearchChannelId } from "@server/lib/search/settings";
import type { PluginProviderRegistry } from "@server/services/plugin-provider-registry";
import type { ProviderSearchResult } from "@server/services/plugin-provider-rpc";
import {
	PluginSearchRegistry,
	type SearchProviderRegistration,
	type SearchRpcClientLike,
} from "@server/services/plugin-search-registry";
import { pluginSearchChannelSource } from "@server/services/plugin-search-source";

const PLUGIN_ID = "com.example.searcher";
const PROVIDER_ID = "engine";
const SEARCH_ID = "web-search";
const CHANNEL_ID = pluginSearchChannelId(PLUGIN_ID, SEARCH_ID);
const INSTANCE_ID = `${PLUGIN_ID}/${PROVIDER_ID}@1`;

function baseManifest(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		pluginId: PLUGIN_ID,
		version: "1.0.0",
		displayName: "Searcher",
		publisher: { id: "com.example", name: "Example" },
		engine: {
			runtime: "bun",
			runtimeVersion: ">=1.2 <2",
			hostApi: ">=1.0 <2",
			rpc: "narrafork.rpc/1",
			os: ["linux"],
			arch: ["x64"],
			runner: "local-process",
		},
		server: { entry: "server/index.js", transport: "stdio", protocol: "narrafork.rpc/1" },
		contributes: {
			providers: [{ id: PROVIDER_ID, title: "Engine" }],
			searchProviders: [{ id: SEARCH_ID, title: "Example web search", providerId: PROVIDER_ID }],
		},
		...overrides,
	};
}

/** Minimal provider registry stand-in: only `list` and `getConfig` are consumed. */
function providerRegistryStub(options: {
	config?: Record<string, JsonValue>;
	disabled?: boolean;
	status?: "available" | "unavailable";
	localId?: string;
	missing?: boolean;
}): Pick<PluginProviderRegistry, "list" | "getConfig"> {
	const entries = options.missing
		? []
		: [
				{
					pluginId: PLUGIN_ID,
					localId: options.localId ?? PROVIDER_ID,
					providerTypeId: `${PLUGIN_ID}/${PROVIDER_ID}`,
					providerInstanceId: INSTANCE_ID,
					disabled: options.disabled ?? false,
					status: options.status ?? "available",
				},
			];
	return {
		list: () => entries as unknown as ReturnType<PluginProviderRegistry["list"]>,
		getConfig: () => ({ ...(options.config ?? {}) }),
	};
}

function makeRegistry(options: {
	provider?: Parameters<typeof providerRegistryStub>[0];
	secretKeys?: string[] | undefined;
	search?: (params: Parameters<SearchRpcClientLike["search"]>[0]) => Promise<ProviderSearchResult>;
	credentialConfig?: Record<string, JsonValue>;
	registration?: Partial<SearchProviderRegistration>;
}) {
	const calls: Array<Parameters<SearchRpcClientLike["search"]>[0]> = [];
	const registry = new PluginSearchRegistry({
		providerRegistry: providerRegistryStub(options.provider ?? {}),
		...(options.credentialConfig
			? { credentialResolver: { resolve: async () => ({ ...options.credentialConfig }) } }
			: {}),
		secretPeek: { peekKeys: () => options.secretKeys },
		resolveClient: async () => ({
			search: async (params) => {
				calls.push(params);
				return options.search ? options.search(params) : { text: `results for ${params.query}` };
			},
		}),
	});
	const entry = registry.register({
		pluginId: PLUGIN_ID,
		contributionId: SEARCH_ID,
		title: "Example web search",
		providerId: PROVIDER_ID,
		...options.registration,
	});
	return { registry, entry, calls };
}

describe("searchProviders manifest contract", () => {
	test("accepts a search contribution bound to a declared provider", () => {
		const result = safeParseManifest(baseManifest());
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.contributes.searchProviders[0]?.providerId).toBe(PROVIDER_ID);
	});

	test("rejects a providerId that names no declared provider", () => {
		const result = safeParseManifest(
			baseManifest({
				contributes: {
					providers: [{ id: PROVIDER_ID, title: "Engine" }],
					searchProviders: [{ id: SEARCH_ID, title: "S", providerId: "nope" }],
				},
			}),
		);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues.some((issue) => issue.path.includes("providerId"))).toBe(true);
	});

	test("requires providerId at all: search has no config namespace of its own", () => {
		const result = safeParseManifest(
			baseManifest({
				contributes: {
					providers: [{ id: PROVIDER_ID, title: "Engine" }],
					searchProviders: [{ id: SEARCH_ID, title: "S" }],
				},
			}),
		);
		expect(result.success).toBe(false);
	});

	test("a search contribution requires a backend server", () => {
		const manifest = baseManifest();
		delete (manifest as Record<string, unknown>).server;
		const result = safeParseManifest(manifest);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues.some((issue) => issue.path.includes("server"))).toBe(true);
	});

	test("a search id colliding with another contribution is rejected", () => {
		const result = safeParseManifest(
			baseManifest({
				contributes: {
					providers: [{ id: PROVIDER_ID, title: "Engine" }],
					searchProviders: [{ id: PROVIDER_ID, title: "S", providerId: PROVIDER_ID }],
				},
			}),
		);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(
			result.error.issues.some((issue) => /duplicate contribution id/.test(issue.message)),
		).toBe(true);
	});

	test("manifest defaults leave searchProviders present and empty", () => {
		const manifest = baseManifest({
			contributes: { providers: [{ id: PROVIDER_ID, title: "Engine" }] },
		});
		const result = safeParseManifest(manifest);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.contributes.searchProviders).toEqual([]);
	});
});

describe("plugin search availability", () => {
	test("a contribution with no config requirement is usable", () => {
		const { registry, entry } = makeRegistry({});
		expect(registry.isUsable(entry)).toBe(true);
	});

	test("a required plain config field must be populated", () => {
		const missing = makeRegistry({ registration: { requiresConfig: ["region"] } });
		expect(missing.registry.isUsable(missing.entry)).toBe(false);

		const present = makeRegistry({
			provider: { config: { region: "us-east-1" } },
			registration: { requiresConfig: ["region"] },
		});
		expect(present.registry.isUsable(present.entry)).toBe(true);
	});

	test("an empty string does not count as configured", () => {
		const { registry, entry } = makeRegistry({
			provider: { config: { region: "" } },
			registration: { requiresConfig: ["region"] },
		});
		expect(registry.isUsable(entry)).toBe(false);
	});

	test("a required secret is satisfied by a vault key, not by stored config", () => {
		// Secrets are absent from stored provider config by design, so without the vault
		// peek a credentialed channel would always look unconfigured.
		const withoutSecret = makeRegistry({
			registration: { requiresConfig: ["apiKey"] },
			secretKeys: [],
		});
		expect(withoutSecret.registry.isUsable(withoutSecret.entry)).toBe(false);

		const withSecret = makeRegistry({
			registration: { requiresConfig: ["apiKey"] },
			secretKeys: [`provider.${PROVIDER_ID}.apiKey`],
		});
		expect(withSecret.registry.isUsable(withSecret.entry)).toBe(true);
	});

	test("another contribution's secret does not satisfy the requirement", () => {
		const { registry, entry } = makeRegistry({
			registration: { requiresConfig: ["apiKey"] },
			secretKeys: ["provider.other.apiKey"],
		});
		expect(registry.isUsable(entry)).toBe(false);
	});

	test("an unread vault reports unconfigured rather than guessing", () => {
		const { registry, entry } = makeRegistry({
			registration: { requiresConfig: ["apiKey"] },
			secretKeys: undefined,
		});
		expect(registry.isUsable(entry)).toBe(false);
	});

	test("a disabled plugin makes its channels unusable but keeps them registered", () => {
		const { registry, entry } = makeRegistry({});
		registry.setPluginEnabled(PLUGIN_ID, false);
		expect(registry.isUsable(registry.get(CHANNEL_ID) ?? entry)).toBe(false);
		expect(registry.list()).toHaveLength(1);
	});

	test("a disabled or unavailable bound provider makes the channel unusable", () => {
		const disabled = makeRegistry({ provider: { disabled: true } });
		expect(disabled.registry.isUsable(disabled.entry)).toBe(false);

		const unavailable = makeRegistry({ provider: { status: "unavailable" } });
		expect(unavailable.registry.isUsable(unavailable.entry)).toBe(false);
	});

	test("a missing bound provider makes the channel unusable", () => {
		const { registry, entry } = makeRegistry({ provider: { missing: true } });
		expect(registry.isUsable(entry)).toBe(false);
	});

	test("unregistering a plugin drops its channels", () => {
		const { registry } = makeRegistry({});
		expect(registry.unregisterPlugin(PLUGIN_ID)).toBe(1);
		expect(registry.list()).toEqual([]);
	});
});

describe("plugin search execution", () => {
	test("forwards the request and returns the plugin's text", async () => {
		const { registry, calls } = makeRegistry({});
		const result = await registry.execute(
			CHANNEL_ID,
			{
				query: "latest news",
				purpose: "verify",
				allowedDomains: ["example.com"],
				recencyDays: 7,
				maxResults: 5,
				locale: "zh-CN",
			},
			new AbortController().signal,
		);
		expect(result.text).toBe("results for latest news");
		expect(result.channelId).toBe(CHANNEL_ID);
		expect(calls[0]).toMatchObject({
			contributionId: SEARCH_ID,
			query: "latest news",
			purpose: "verify",
			allowedDomains: ["example.com"],
			recencyDays: 7,
			maxResults: 5,
			locale: "zh-CN",
		});
	});

	test("omits optional fields the request did not carry", async () => {
		const { registry, calls } = makeRegistry({});
		await registry.execute(CHANNEL_ID, { query: "q" }, new AbortController().signal);
		expect(calls[0]).not.toHaveProperty("purpose");
		expect(calls[0]).not.toHaveProperty("recencyDays");
		expect(calls[0]).not.toHaveProperty("allowedDomains");
	});

	test("sends the bound provider's resolved credentials", async () => {
		// The whole point of the providerId binding: the plugin receives the credential the
		// user entered once for the provider, without search owning a vault namespace.
		const { registry, calls } = makeRegistry({
			credentialConfig: { apiKey: "secret-value", region: "us-east-1" },
		});
		await registry.execute(CHANNEL_ID, { query: "q" }, new AbortController().signal);
		expect(calls[0]?.config).toEqual({ apiKey: "secret-value", region: "us-east-1" });
	});

	test("passes the manifest timeout through", async () => {
		const { registry, calls } = makeRegistry({ registration: { limits: { timeoutMs: 12_000 } } });
		await registry.execute(CHANNEL_ID, { query: "q" }, new AbortController().signal);
		expect(calls[0]?.timeoutMs).toBe(12_000);
	});

	test("keeps structured results when the plugin returns them", async () => {
		const { registry } = makeRegistry({
			search: async () => ({
				results: [{ title: "Result", url: "https://example.com", snippet: "text" }],
			}),
		});
		const result = await registry.execute(CHANNEL_ID, { query: "q" }, new AbortController().signal);
		expect(result.results).toHaveLength(1);
		expect(result.results?.[0]?.url).toBe("https://example.com");
	});

	test("an unknown channel fails rather than silently returning nothing", async () => {
		const { registry } = makeRegistry({});
		await expect(
			registry.execute("plugin:ghost:s", { query: "q" }, new AbortController().signal),
		).rejects.toThrow(/Unknown plugin search channel/);
	});

	test("a disabled plugin refuses to execute", async () => {
		const { registry } = makeRegistry({});
		registry.setPluginEnabled(PLUGIN_ID, false);
		await expect(
			registry.execute(CHANNEL_ID, { query: "q" }, new AbortController().signal),
		).rejects.toThrow(/disabled/);
	});

	test("a missing bound provider is reported as such", async () => {
		const { registry } = makeRegistry({ provider: { missing: true } });
		await expect(
			registry.execute(CHANNEL_ID, { query: "q" }, new AbortController().signal),
		).rejects.toThrow(/not registered/);
	});
});

describe("search channel source adapter", () => {
	test("translates registry entries into channels the search layer understands", () => {
		const { registry } = makeRegistry({ registration: { limits: { timeoutMs: 30_000 } } });
		const channels = pluginSearchChannelSource(registry).listChannels();
		expect(channels).toEqual([
			{ id: CHANNEL_ID, label: "Example web search", available: true, timeoutMs: 30_000 },
		]);
	});

	test("reports availability rather than hiding unusable channels", () => {
		const { registry } = makeRegistry({ registration: { requiresConfig: ["apiKey"] } });
		const channels = pluginSearchChannelSource(registry).listChannels();
		expect(channels).toHaveLength(1);
		expect(channels[0]?.available).toBe(false);
	});

	test("falls back to the contribution id when a title is missing", () => {
		const { registry } = makeRegistry({ registration: { title: "" } });
		expect(pluginSearchChannelSource(registry).listChannels()[0]?.label).toBe(SEARCH_ID);
	});
});
