/* biome-ignore-all lint/style/noNonNullAssertion: beforeEach establishes these fixed settings and template fixtures. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import type { QuotaSnapshot } from "@shared/quota-snapshot";
import { pluginProviderRegistry } from "../../../services/plugin-provider-registry";
import { tokenDanceQuotaIdentity } from "../../../services/tokendance-service";
import { __setCodexManagerForTests } from "../../codex-manager";
import type { CodexUsageResult } from "../../codex-usage";
import { commandCodeQuotaIdentity } from "../../commandcode-usage";
import { getCredentialStore } from "../../credential-store";
import { customApiStreamQuotaIdentity } from "../../custom-api-quota-cache";
import { deepSeekQuotaIdentity } from "../../deepseek-balance-cache";
import { kimiQuotaIdentity } from "../../kimi-usage-cache";
import { setNugCachedModels } from "../../nug-model-cache";
import { nugQuotaIdentity } from "../../nug-quota-cache";
import { opencodeQuotaIdentity } from "../../opencode-usage-cache";
import { providerBalanceQuotaIdentity } from "../../provider-balance-cache";
import { getProviderKeyStore, type ProviderKey, withProviderKey } from "../../provider-keys";
import { type CustomApiProviderConfig, saveSettings, settings } from "../../settings";
import { quotaStore, STREAM_QUOTA_SOURCE } from "../../sourcing/quota-store";
import { getSourceGroup, listSourceGroups } from "../../sourcing/source-groups";
import { getServiceTemplate, listServiceTemplates } from "../../sourcing/templates";
import { autoSourceFacts, autoSourcePreview, installAutoRouteSignals } from "../auto-route-signals";
import { reportKeyFault, resetProviderKeyRuntimeForTests } from "../pooled-provider";
import { ApiError } from "../types";

// preload.ts owns HOME isolation; all snapshots below are deliberately memory-only.
const saved = structuredClone(settings);
const now = 1_800_000_000_000;
const pluginId = "com.example.template-routing";
const configs: CustomApiProviderConfig[] = [
	["kimi", "https://api.kimi.com/coding/v1", "completions-compatible"],
	["go", "https://opencode.ai/zen/go/v1", "openai-responses"],
	["ds", "https://api.deepseek.com/v1", "completions-compatible"],
	["openai", "https://api.openai.com/v1", "openai-responses"],
	["anthropic", "https://api.anthropic.com/v1", "anthropic-messages"],
	["gemini", "https://generativelanguage.googleapis.com/v1beta", "gemini-compatible"],
	["relay", "https://relay.example/v1", "completions-compatible"],
	["relay-ant", "https://relay.example/v1", "anthropic-messages"],
	["relay-gem", "https://relay.example/v1beta", "gemini-compatible"],
].map(([id, baseUrl, protocol]) => ({
	id: `route-${id}`,
	prefix: `route-${id}`,
	name: id,
	baseUrl,
	protocol: protocol as CustomApiProviderConfig["protocol"],
	apiKey: "",
	defaultModel: "m",
}));
const store = getProviderKeyStore();
const quotaIds = new Set<string>();
const groupIds = [...configs.map((config) => config.id), "route-nug", "tokendance", "CommandCode"];
const customConfig = (id: string) =>
	settings.customApiProviders!.find((config) => config.id === id)!;
function nextEndpoint(id: string, current: string): string {
	if (id === "route-go")
		return current.includes("/zen/")
			? "https://opencode.ai/inference/go/v1"
			: "https://opencode.ai/zen/go/v1";
	if (id === "route-ds")
		return current.endsWith("/anthropic/v1")
			? "https://api.deepseek.com/v1"
			: "https://api.deepseek.com/anthropic/v1";
	return `${current}/next`;
}

function source<T extends { apiKey: string }>(
	id: string,
	config: () => T,
	identity: (config: T) => string,
	templateId?: "nug" | "tokendance" | "command-code",
) {
	return {
		id,
		prefix: id,
		add: (label = "first") =>
			store.addGroupCredential(id, templateId, { apiKey: `sk-${id}-${label}`, label }),
		identity: (key: ProviderKey) => identity(withProviderKey(config(), key)),
	};
}
const customSources = [
	source("route-kimi", () => customConfig("route-kimi"), kimiQuotaIdentity),
	source("route-go", () => customConfig("route-go"), opencodeQuotaIdentity),
	source("route-ds", () => customConfig("route-ds"), deepSeekQuotaIdentity),
	source(
		"route-relay",
		() => customConfig("route-relay"),
		(config) => providerBalanceQuotaIdentity(config, settings.proxy),
	),
];
const nugSource = source("route-nug", () => settings.nugProviders![0]!, nugQuotaIdentity, "nug");
const walletSources = [
	source("tokendance", () => settings.tokendance!, tokenDanceQuotaIdentity, "tokendance"),
	source(
		"CommandCode",
		() => ({ ...settings.commandCode!, apiKey: settings.commandCode!.apiKey ?? "" }),
		commandCodeQuotaIdentity,
		"command-code",
	),
	customSources[2]!,
	nugSource,
];
const snapshot = (extra: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
	fetchedAt: now,
	scope: "key",
	windows: [],
	balances: [],
	...extra,
});
const emptyWallet = snapshot({ balances: [{ unit: "USD", remaining: 0 }] });
const fullWindow = (resetsAt: number | null) =>
	snapshot({ windows: [{ kind: "5h", usedRatio: 1, resetsAt }] });
function remember(id: string, identity: string, value: QuotaSnapshot, stream = false) {
	quotaIds.add(id);
	quotaStore.set(id, identity, value, false, stream ? STREAM_QUOTA_SOURCE : undefined);
}

beforeEach(() => {
	saveSettings({
		...settings,
		customApiProviders: structuredClone(configs),
		nugProviders: [
			{
				id: "route-nug",
				prefix: "route-nug",
				name: "NUG",
				baseUrl: "https://nug.example",
				apiKey: "",
				defaultModel: "kiro:m",
			},
		],
		tokendance: { apiKey: "", generation: 0, disabled: false },
		commandCode: { baseUrl: "https://cc.example", apiKey: "" },
	});
});
afterEach(() => {
	for (const id of quotaIds) {
		quotaStore.forget(id);
		quotaStore.forget(id, STREAM_QUOTA_SOURCE);
	}
	quotaIds.clear();
	for (const id of groupIds) store.removeGroup(id);
	setNugCachedModels("route-nug", []);
	pluginProviderRegistry.removePlugin(pluginId);
	__setCodexManagerForTests(undefined);
	resetProviderKeyRuntimeForTests();
	saveSettings(structuredClone(saved));
});

describe("template auto routing", () => {
	test("facts preserve each template's subscription policy, including custom protocols and plugins", () => {
		pluginProviderRegistry.register({
			kind: "executable-plugin",
			pluginId,
			localId: "demo",
			providerInstanceId: `${pluginId}/demo`,
			providerPrefix: "route-plugin",
			displayName: "Routing plugin",
			createAdapter: () => {
				throw new Error("routing must not construct an adapter");
			},
		});
		const groups = listSourceGroups();
		expect(new Set(groups.map((group) => group.templateId))).toEqual(
			new Set(listServiceTemplates().map((template) => template.id)),
		);
		for (const group of groups) {
			expect(autoSourceFacts(group.prefix, now).subscription).toBe(
				["codex", "kimi-code", "opencode-go"].includes(group.templateId),
			);
		}
		expect(autoSourceFacts("unknown-source", now)).toEqual({
			available: true,
			subscription: false,
		});
	});

	test("disabled groups and disabled keys never fall back to settings or Command Code CLI", () => {
		for (const entry of [customSources[0]!, ...walletSources]) {
			const key = entry.add();
			expect(autoSourceFacts(entry.prefix, now).available).toBe(true);
			store.update(key.id, { disabled: true });
			// Settings still projects the first key: it must not revive that disabled credential.
			expect(autoSourceFacts(entry.prefix, now).available).toBe(false);
		}
		const other = customSources[3]!.add();
		expect(other.disabled).toBeUndefined();
		saveSettings({
			...settings,
			customApiProviders: settings.customApiProviders!.map((config) => ({
				...config,
				disabled: true,
			})),
			nugProviders: settings.nugProviders!.map((config) => ({ ...config, disabled: true })),
			tokendance: { ...settings.tokendance!, disabled: true },
			commandCode: { ...settings.commandCode!, disabled: true },
		});
		for (const prefix of groupIds) {
			expect(autoSourceFacts(prefix, now).available).toBe(false);
			expect(autoSourcePreview(prefix, now)).toBeNull();
		}
	});

	test("config-only credentials remain usable; unconfigured TD is false and CC CLI is unknown/usable", () => {
		expect(autoSourceFacts("tokendance", now).available).toBe(false);
		expect(autoSourceFacts("CommandCode", now).available).toBe(true);
		for (const entry of [customSources[0]!, ...walletSources]) {
			const key = entry.add();
			const configKey = key.apiKey;
			// Simulate a legacy config without a stored row, after normal settings initialization.
			store.removeGroup(entry.id);
			if (entry.id === "tokendance") settings.tokendance!.apiKey = configKey;
			else if (entry.id === "CommandCode") settings.commandCode!.apiKey = configKey;
			else if (entry.id === "route-nug") settings.nugProviders![0]!.apiKey = configKey;
			else customConfig(entry.id).apiKey = configKey;
			expect(store.listGroup(entry.id)).toHaveLength(0);
			expect(autoSourceFacts(entry.prefix, now).available).toBe(true);
		}
	});

	test("429 keeps a source available; previews skip rate-limited keys and expose the earliest hard recovery", () => {
		const entry = customSources[3]!;
		const first = entry.add("first");
		const second = entry.add("second");
		expect(autoSourcePreview(entry.prefix, now)).toEqual({ label: "first" });
		reportKeyFault(first, new ApiError(429, "rate limited"), now);
		expect(autoSourcePreview(entry.prefix, now)).toEqual({ label: "second" });
		reportKeyFault(second, new ApiError(429, "rate limited"), now);
		expect(autoSourceFacts(entry.prefix, now).available).toBe(true);
		resetProviderKeyRuntimeForTests();
		reportKeyFault(first, new ApiError(402, "payment required"), now);
		reportKeyFault(second, new ApiError(403, "forbidden"), now + 10_000);
		expect(autoSourceFacts(entry.prefix, now).available).toBe(false);
		expect(autoSourcePreview(entry.prefix, now)).toEqual({
			label: "second",
			resetsAt: now + 610_000,
		});
		expect(autoSourceFacts(entry.prefix, now + 610_001).available).toBe(true);
	});

	for (const entry of walletSources) {
		test(`${entry.prefix}: balances distinguish exhausted, unknown, errors, unlimited and multiple currencies`, () => {
			const key = entry.add();
			for (const [value, available] of [
				[emptyWallet, false],
				[snapshot({ balances: [{ unit: "USD", remaining: -1 }] }), false],
				[snapshot(), true],
				[snapshot({ balances: [{ unit: "USD", remaining: null }] }), true],
				[snapshot({ ...emptyWallet, error: "probe failed" }), true],
				[snapshot({ balances: [{ unit: "USD", remaining: 0, unlimited: true }] }), true],
				[
					snapshot({
						balances: [
							{ unit: "USD", remaining: 0 },
							{ unit: "CNY", remaining: 1 },
						],
					}),
					true,
				],
			] as const) {
				remember(key.id, entry.identity(key), value);
				expect(autoSourceFacts(entry.prefix, now).available).toBe(available);
			}
			remember(key.id, entry.identity(key), emptyWallet);
			const second = entry.add("second");
			expect(autoSourceFacts(entry.prefix, now).available).toBe(true);
			expect(autoSourcePreview(entry.prefix, now)).toEqual({ label: "second" });
			remember(second.id, entry.identity(second), emptyWallet);
			expect(autoSourceFacts(entry.prefix, now).available).toBe(false);
			expect(autoSourcePreview(entry.prefix, now)).toEqual({ label: "first" });
		});
	}

	test("real NUG probe preserves unknown raw balances and recognizes numeric aliases before routing", async () => {
		const key = nugSource.add();
		const probe = getServiceTemplate("nug").probeQuota!;
		const network = spyOn(globalThis, "fetch");
		try {
			for (const [raw, remaining] of [
				[{}, null],
				[{ balance: null }, null],
				[{ balance: "" }, null],
				[{ balance: false }, null],
				[{ balance: "unknown" }, null],
				[{ quotaBalance: "0" }, 0],
				[{ remaining: "2" }, 2],
				[{ balance: -1 }, -1],
			] as const) {
				network.mockResolvedValueOnce(Response.json(raw));
				const result = await probe(
					getSourceGroup(nugSource.id)!,
					{
						id: key.id,
						providerId: nugSource.id,
						config: withProviderKey(settings.nugProviders![0]!, key),
					},
					new AbortController().signal,
				);
				expect(result.balances[0]?.remaining).toBe(remaining);
				remember(key.id, nugSource.identity(key), result);
				expect(autoSourceFacts(nugSource.prefix, now).available).toBe(
					remaining === null || remaining > 0,
				);
			}
			expect(network).toHaveBeenCalledTimes(8);
		} finally {
			network.mockRestore();
		}
	});

	test("real Command Code probe rejects unknown monthly credits rather than manufacturing exhausted quota", async () => {
		const entry = walletSources[1]!;
		const key = entry.add();
		const probe = getServiceTemplate("command-code").probeQuota!;
		const network = spyOn(globalThis, "fetch");
		try {
			for (const credits of [
				{},
				{ monthlyCredits: null },
				{ monthlyCredits: "" },
				{ monthlyCredits: false },
				{ monthlyCredits: "unknown" },
			]) {
				network.mockResolvedValueOnce(Response.json({ credits }));
				await expect(
					probe(
						getSourceGroup(entry.id)!,
						{
							id: key.id,
							providerId: entry.id,
							config: { ...settings.commandCode!, apiKey: key.apiKey },
						},
						new AbortController().signal,
					),
				).rejects.toThrow("invalid_response");
				expect(autoSourceFacts(entry.prefix, now).available).toBe(true);
			}
		} finally {
			network.mockRestore();
		}
	});

	test("quota windows choose the first key's latest reset, then the earliest key recovery; expired windows reopen", () => {
		const entry = customSources[0]!;
		const first = entry.add();
		const second = entry.add("second");
		remember(
			first.id,
			entry.identity(first),
			snapshot({
				windows: [
					{ kind: "5h", usedRatio: 1, resetsAt: now + 100 },
					{ kind: "weekly", usedRatio: 1, resetsAt: now + 300 },
				],
			}),
		);
		remember(second.id, entry.identity(second), fullWindow(now + 200));
		expect(autoSourceFacts(entry.prefix, now).available).toBe(false);
		expect(autoSourcePreview(entry.prefix, now)).toEqual({ label: "second", resetsAt: now + 200 });
		expect(autoSourceFacts(entry.prefix, now + 200).available).toBe(true);
		expect(autoSourcePreview(entry.prefix, now + 200)).toEqual({ label: "second" });
	});

	test("NUG availability accepts full prefixes and bare channel ids and never blocks unknown models", () => {
		nugSource.add();
		setNugCachedModels("route-nug", [
			{ id: "kiro:m", available: false },
			{ id: "other:m", available: true },
		]);
		for (const model of ["kiro:m", "route-nug:kiro:m"]) {
			expect(autoSourceFacts("route-nug", now, model).available).toBe(false);
		}
		for (const model of [undefined, "other:m", "route-nug:other:m", "new:m", "route-nug:new:m"]) {
			expect(autoSourceFacts("route-nug", now, model).available).toBe(true);
		}
	});

	test("Codex manager owns credit continuation and rotating preview; projection reads canonical usage separately", () => {
		const usage: CodexUsageResult = {
			plan_type: "plus",
			queriedAt: new Date(now).toISOString(),
			primary_window: {
				used_percent: 100,
				remaining_percent: 0,
				reset_at: (now + 1000) / 1000,
				reset_after_seconds: 1,
				window_type: "5h",
			},
			credits: { has_credits: true, unlimited: false, balance: "5" },
		};
		const manager = {
			availableCount: 1,
			routingPreview: { label: "credit account", rotating: true },
			usageOf: spyOn({ read: (id: string) => (id === "codex-credit" ? usage : undefined) }, "read"),
			dispose: () => {},
		};
		__setCodexManagerForTests(manager as never);
		remember("codex-credit", "irrelevant", fullWindow(now + 1000));
		expect(autoSourceFacts("codex", now)).toEqual({ available: true, subscription: true });
		expect(autoSourcePreview("codex", now)).toEqual({ label: "credit account", rotating: true });
		expect(manager.usageOf).not.toHaveBeenCalled();
		const template = getServiceTemplate("codex");
		expect(template.projectQuota?.("codex-credit")).toMatchObject({
			windows: [{ kind: "5h", usedRatio: 1, resetsAt: now + 1000 }],
			detail: usage,
		});
		expect(template.projectQuota?.("missing")).toBeUndefined();
		expect(manager.usageOf).toHaveBeenCalledWith("codex-credit");
		manager.availableCount = 0;
		expect(autoSourceFacts("codex", now).available).toBe(false);
	});

	for (const entry of [...customSources, nugSource]) {
		test(`${entry.prefix}: changed secret, endpoint and network invalidate old probe and stream snapshots`, () => {
			const key = entry.add();
			const streamIdentity = () =>
				entry.id === "route-nug"
					? entry.identity(key)
					: customApiStreamQuotaIdentity(withProviderKey(customConfig(entry.id), key));
			for (const stream of [false, true]) {
				for (const change of [
					"key",
					"endpoint",
					"proxy",
					"user-agent",
					"headers",
					"global-proxy",
				]) {
					const oldIdentity = stream ? streamIdentity() : entry.identity(key);
					remember(key.id, oldIdentity, emptyWallet, stream);
					expect(autoSourceFacts(entry.prefix, now).available).toBe(false);
					if (change === "key") store.update(key.id, { apiKey: `${key.apiKey}-rotated` });
					else if (change === "endpoint") {
						saveSettings({
							...settings,
							customApiProviders: settings.customApiProviders!.map((config) =>
								config.id === entry.id
									? {
											...config,
											baseUrl: nextEndpoint(entry.id, config.baseUrl),
										}
									: config,
							),
							nugProviders: settings.nugProviders!.map((config) =>
								config.id === entry.id
									? {
											...config,
											baseUrl: nextEndpoint(entry.id, config.baseUrl),
										}
									: config,
							),
						});
					} else if (change === "global-proxy") {
						saveSettings({
							...settings,
							proxy: { ...settings.proxy, mode: "custom", url: `http://proxy-${stream}:8080` },
						});
					} else
						store.update(key.id, {
							network: {
								...key.network,
								...(change === "proxy" && {
									proxy: { mode: "custom" as const, url: `http://key-proxy-${stream}:8080` },
								}),
								...(change === "user-agent" && {
									userAgentMode: "custom" as const,
									customUserAgent: `routing-${stream}`,
								}),
								...(change === "headers" && { extraHeaders: { "x-routing": `changed-${stream}` } }),
							},
						});
					expect(autoSourceFacts(entry.prefix, now).available).toBe(true);
					// A read must not evict the previous identity or accidentally restore it from disk.
					expect(
						quotaStore.peekForIdentity(
							key.id,
							oldIdentity,
							stream ? STREAM_QUOTA_SOURCE : undefined,
						),
					).toBe(emptyWallet);
					quotaStore.forget(key.id, stream ? STREAM_QUOTA_SOURCE : undefined);
				}
			}
		});
	}

	test("singleton key rotation, TD generation and same-origin CC endpoint paths invalidate old quotas", () => {
		for (const entry of walletSources.slice(0, 2)) {
			const key = entry.add();
			remember(key.id, entry.identity(key), emptyWallet);
			expect(autoSourceFacts(entry.prefix, now).available).toBe(false);
			store.update(key.id, { apiKey: `${key.apiKey}-rotated` });
			expect(autoSourceFacts(entry.prefix, now).available).toBe(true);
			remember(key.id, entry.identity(key), emptyWallet);
			expect(autoSourceFacts(entry.prefix, now).available).toBe(false);
			if (entry.id === "tokendance")
				saveSettings({
					...settings,
					tokendance: { ...settings.tokendance!, generation: settings.tokendance!.generation + 1 },
				});
			else
				saveSettings({
					...settings,
					commandCode: { ...settings.commandCode!, baseUrl: "https://cc.example/other-path" },
				});
			expect(autoSourceFacts(entry.prefix, now).available).toBe(true);
		}
	});

	test("probe and stream slots independently block without overwriting or reading another source", () => {
		const entry = customSources[3]!;
		const key = entry.add();
		const probe = entry.identity(key);
		const stream = customApiStreamQuotaIdentity(withProviderKey(customConfig(entry.id), key));
		remember(key.id, probe, emptyWallet);
		remember(key.id, stream, snapshot(), true);
		expect(autoSourceFacts(entry.prefix, now).available).toBe(false);
		remember(key.id, probe, snapshot());
		remember(key.id, stream, emptyWallet, true);
		expect(autoSourceFacts(entry.prefix, now).available).toBe(false);
		remember(key.id, `${stream}-stale`, emptyWallet, true);
		expect(autoSourceFacts(entry.prefix, now).available).toBe(true);
	});

	test("initialized facts and preview perform no disk IO, quota restoration, credential saves, auth.json reads or network", () => {
		for (const config of configs)
			store.addGroupCredential(config.id, undefined, { apiKey: `sk-${config.id}` });
		for (const entry of walletSources.filter((entry) => entry.id !== "CommandCode")) entry.add();
		// Leave Command Code unconfigured: even CLI readiness must never inspect auth.json.
		__setCodexManagerForTests({
			availableCount: 1,
			routingPreview: { rotating: true },
			dispose: () => {},
		} as never);
		installAutoRouteSignals();
		const prefixes = [...listSourceGroups().map((group) => group.prefix), "unknown-source"];
		const credentials = getCredentialStore();
		const denyIO = () => {
			throw new Error("routing attempted IO");
		};
		const fetchGuard = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(denyIO, { preconnect: denyIO }),
		);
		const guards = [
			spyOn(quotaStore, "get"),
			spyOn(store, "save"),
			spyOn(credentials, "saveKeys"),
			spyOn(credentials, "saveCodex"),
			spyOn(credentials, "savePlugins"),
			...[
				"readFileSync",
				"writeFileSync",
				"existsSync",
				"statSync",
				"readdirSync",
				"openSync",
				"mkdirSync",
				"renameSync",
				"unlinkSync",
			].map((method) => spyOn(fs, method as "readFileSync")),
		];
		for (const guard of guards)
			guard.mockImplementation(() => {
				throw new Error("routing attempted IO");
			});
		try {
			for (const prefix of prefixes) {
				expect(autoSourceFacts(prefix, now).available).toBe(true);
				autoSourcePreview(prefix, now);
			}
			for (const guard of guards) expect(guard).not.toHaveBeenCalled();
			expect(fetchGuard).not.toHaveBeenCalled();
		} finally {
			fetchGuard.mockRestore();
			for (const guard of guards) guard.mockRestore();
		}
	});
});
