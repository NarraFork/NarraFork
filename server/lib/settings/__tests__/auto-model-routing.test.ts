import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import "../../../services/tokendance-service";
import { autoSourceFacts } from "../../agent/auto-route-signals";
import { commandCodeAuthPath, invalidateCommandCodeAuthCache } from "../../commandcode-manager";
import {
	captureCommandCodeModelOptions,
	invalidateCommandCodeModelsCache,
	listCommandCodeModels,
} from "../../commandcode-models";
import { queryForModel, replaceModelOverridesForTests } from "../../model-catalog";
import { getNarraforkHome } from "../../narrafork-home";
import { getProviderKeyStore } from "../../provider-keys";
import { getSourceGroup } from "../../sourcing/source-groups";
import {
	AutoModelUnavailableError,
	expandAllowedPoolForDisplay,
	getSubagentVisibleModels,
	getVisibleModels,
	listAutoModelCandidates,
	listAutoModelIds,
	normalizeAutoModelValueForSave,
	orderedAutoModelCandidates,
	registerAutoSourceProbe,
	resolveAllowedModelCandidateMatch,
	resolveEffectiveModel,
	resolveProvider,
	saveSettings,
	settings,
} from "../index";
import type { ModelOption } from "../types";

// auto:<model> resolves among every visible provider model that is a strong catalog
// match for the logical model (docs/PROVIDER-SOURCING-DESIGN.md §4.1). Visible models
// are injected through customModels so nothing depends on provider caches or network.

const models = (...values: string[]): ModelOption[] =>
	values.map((value) => ({ value, label: value, provider: value.slice(0, value.indexOf(":")) }));

// The catalog splits a value into provider prefix and upstream id only for configured
// providers, so each test prefix needs a provider entry.
const PREFIXES = ["provA", "provB", "provC", "provD", "provE"];
const providers = (): NonNullable<typeof settings.customApiProviders> =>
	PREFIXES.map((prefix) => ({
		id: `autoTest${prefix}`,
		name: prefix,
		prefix,
		apiKey: "",
		baseUrl: "https://example.com/v1",
		defaultModel: "m",
		protocol: "completions-compatible",
	}));

describe("auto model routing", () => {
	let saved: {
		customModels: ModelOption[];
		hiddenModels: string[];
		disabledProviders?: string[];
		autoExcludedProviders?: string[];
		defaultModel: string;
		summaryModel: string;
		customApiProviders: typeof settings.customApiProviders;
	};

	beforeEach(() => {
		saved = {
			customModels: settings.agent.customModels,
			hiddenModels: settings.agent.hiddenModels,
			disabledProviders: settings.agent.disabledProviders,
			autoExcludedProviders: settings.agent.autoExcludedProviders,
			defaultModel: settings.agent.defaultModel,
			summaryModel: settings.agent.summaryModel,
			customApiProviders: settings.customApiProviders,
		};
		settings.agent.hiddenModels = [];
		settings.agent.disabledProviders = [];
		settings.agent.autoExcludedProviders = [];
		settings.customApiProviders = [...(saved.customApiProviders ?? []), ...providers()];
		settings.agent.customModels = models(
			"provA:claude-opus-4-6",
			"provB:claude-opus-4.6",
			"provC:claude-opus-4-6-20260101",
			"provD:claude-opus-4-6-foo",
			"provB:gpt-5.5",
			"provE:private-model-x",
		);
	});

	afterEach(() => {
		registerAutoSourceProbe(null);
		Object.assign(settings.agent, {
			customModels: saved.customModels,
			hiddenModels: saved.hiddenModels,
			disabledProviders: saved.disabledProviders,
			autoExcludedProviders: saved.autoExcludedProviders,
			defaultModel: saved.defaultModel,
			summaryModel: saved.summaryModel,
		});
		settings.customApiProviders = saved.customApiProviders;
	});

	test("candidates are the strong matches only, and catalog-less models have no auto", () => {
		expect(listAutoModelCandidates("claude-opus-4-6")).toEqual([
			"provA:claude-opus-4-6",
			"provB:claude-opus-4.6",
		]);
		const ids = listAutoModelIds();
		expect(ids).toContain("claude-opus-4-6");
		expect(ids).toContain("gpt-5.5");
		expect(ids.some((id) => id.includes("private-model-x"))).toBe(false);
	});

	test("resolves to the first provider, stays on the session's provider, and names it", () => {
		expect(resolveEffectiveModel("auto:claude-opus-4-6")).toBe("provA:claude-opus-4-6");
		expect(resolveEffectiveModel("auto:claude-opus-4-6", "provB")).toBe("provB:claude-opus-4.6");
		// A sticky provider that does not serve the model is ignored.
		expect(resolveEffectiveModel("auto:claude-opus-4-6", "provE")).toBe("provA:claude-opus-4-6");
		expect(resolveProvider("auto:claude-opus-4-6")).toBe("provA");
	});

	test("excluded and disabled providers leave auto but still serve pinned values", () => {
		settings.agent.autoExcludedProviders = ["provA"];
		expect(resolveEffectiveModel("auto:claude-opus-4-6")).toBe("provB:claude-opus-4.6");
		expect(resolveEffectiveModel("provA:claude-opus-4-6")).toBe("provA:claude-opus-4-6");
		settings.agent.disabledProviders = ["provB"];
		expect(() => resolveEffectiveModel("auto:claude-opus-4-6")).toThrow(AutoModelUnavailableError);
	});

	test("a model nobody serves is an error, never another model", () => {
		expect(() => resolveEffectiveModel("auto:no-such-model")).toThrow(AutoModelUnavailableError);
		settings.agent.defaultModel = "auto:claude-opus-4-6";
		expect(resolveEffectiveModel("__default__")).toBe("provA:claude-opus-4-6");
		// An unservable summary model follows the default, like an empty aggregation does.
		settings.agent.summaryModel = "auto:no-such-model";
		expect(resolveEffectiveModel("__summary__")).toBe("provA:claude-opus-4-6");
	});

	test("a source that takes fewer input kinds than another goes after it, never dropped", () => {
		// provA is listed first, but only takes text while provB also takes images.
		const restore = replaceModelOverridesForTests({
			connections: {
				"provA:claude-opus-4-6": { inputModalities: ["text"] },
				"provB:claude-opus-4.6": { inputModalities: ["text", "image"] },
			},
		});
		try {
			expect(orderedAutoModelCandidates("claude-opus-4-6")).toEqual([
				"provB:claude-opus-4.6",
				"provA:claude-opus-4-6",
			]);
			// A session on the text-only source moves to the one that can read its images.
			expect(resolveEffectiveModel("auto:claude-opus-4-6", "provA")).toBe("provB:claude-opus-4.6");
		} finally {
			restore();
		}
	});

	test("subscriptions first; a sticky source that cannot serve is left for the next one", () => {
		const facts: Record<string, { available: boolean; subscription: boolean }> = {
			provA: { available: true, subscription: false },
			provB: { available: true, subscription: true },
		};
		registerAutoSourceProbe(
			(provider) => facts[provider] ?? { available: true, subscription: false },
		);
		expect(orderedAutoModelCandidates("claude-opus-4-6")).toEqual([
			"provB:claude-opus-4.6",
			"provA:claude-opus-4-6",
		]);
		expect(resolveEffectiveModel("auto:claude-opus-4-6")).toBe("provB:claude-opus-4.6");
		// A session on provA stays there while provA can serve (keeps its cache) …
		expect(resolveEffectiveModel("auto:claude-opus-4-6", "provA")).toBe("provA:claude-opus-4-6");
		// … and moves once it cannot.
		facts.provA = { available: false, subscription: false };
		expect(resolveEffectiveModel("auto:claude-opus-4-6", "provA")).toBe("provB:claude-opus-4.6");
		// Nothing available: the best one is still returned, so its own error reaches the user …
		facts.provB = { available: false, subscription: true };
		expect(resolveEffectiveModel("auto:claude-opus-4-6")).toBe("provB:claude-opus-4.6");
		// … but a session already on a source stays there rather than move to one that also fails.
		expect(resolveEffectiveModel("auto:claude-opus-4-6", "provA")).toBe("provA:claude-opus-4-6");
	});

	test("saving an auto: value writes the catalog id and refuses ids the catalog lacks", () => {
		expect(normalizeAutoModelValueForSave("auto:claude-opus-4-6")).toBe("auto:claude-opus-4-6");
		// An alias is written as the catalog id, so pools and routing compare one spelling.
		expect(normalizeAutoModelValueForSave("auto:claude-opus-4.6")).toBe("auto:claude-opus-4-6");
		expect(() => normalizeAutoModelValueForSave("auto:private-model-x")).toThrow(/catalog/);
		// Only auto: values are checked; a named service may run models the catalog lacks.
		expect(normalizeAutoModelValueForSave("provE:private-model-x")).toBe("provE:private-model-x");
		expect(normalizeAutoModelValueForSave("__default__")).toBe("__default__");
		expect(normalizeAutoModelValueForSave(undefined)).toBeUndefined();
	});

	test("subagents see auto values, and a pool entry admits the providers that serve it", () => {
		const visible = getSubagentVisibleModels();
		expect(visible).toContain("auto:claude-opus-4-6");
		expect(visible).toContain("provA:claude-opus-4-6");
		expect(visible).not.toContain("auto:private-model-x");

		const pool = ["auto:claude-opus-4-6"];
		expect(resolveAllowedModelCandidateMatch("auto:claude-opus-4-6", pool)?.model).toBe(
			"auto:claude-opus-4-6",
		);
		expect(resolveAllowedModelCandidateMatch("provB:claude-opus-4.6", pool)?.model).toBe(
			"provB:claude-opus-4.6",
		);
		expect(resolveAllowedModelCandidateMatch("provC:claude-opus-4-6-20260101", pool)).toBeNull();
		expect(expandAllowedPoolForDisplay(pool)).toEqual([
			"auto:claude-opus-4-6 (currently provA:claude-opus-4-6, provB:claude-opus-4.6)",
		]);
	});

	test("an existing provider prefixed `auto` keeps its values until renamed", () => {
		settings.customApiProviders = [
			...(settings.customApiProviders ?? []),
			{
				id: "legacyAutoPrefix",
				name: "Legacy",
				prefix: "auto",
				apiKey: "",
				baseUrl: "https://example.com/v1",
				defaultModel: "m",
				protocol: "completions-compatible",
			},
		];
		expect(resolveEffectiveModel("auto:claude-opus-4-6")).toBe("auto:claude-opus-4-6");
		expect(resolveProvider("auto:claude-opus-4-6")).toBe("auto");
	});
});

describe("builtin catalog identities in Auto routing", () => {
	const modelId = "claude-opus-4-6";
	const fallback = "catalog-fallback";
	const baseUrl = "https://cc-catalog.example/provider/v1";
	const cliPath = join(getNarraforkHome(), ".commandcode", "auth.json");
	let saved: typeof settings;
	let restoreHome: () => void;

	beforeEach(() => {
		saved = structuredClone(settings);
		const home = spyOn(os, "homedir").mockReturnValue(getNarraforkHome());
		restoreHome = () => home.mockRestore();
		// Never let CLI discovery inspect the real home, even in the negative case.
		expect(commandCodeAuthPath()).toBe(cliPath);
		invalidateCommandCodeAuthCache();
		invalidateCommandCodeModelsCache();
		saveSettings({
			...settings,
			agent: {
				...settings.agent,
				customModels: models(`${fallback}:${modelId}`),
				hiddenModels: [],
				disabledProviders: [],
				autoExcludedProviders: [],
			},
			customApiProviders: [
				{
					id: fallback,
					prefix: fallback,
					name: "Fallback",
					baseUrl: "https://fallback.example/v1",
					apiKey: "sk-fallback",
					defaultModel: modelId,
					protocol: "completions-compatible",
				},
			],
			nugProviders: [],
			tokendance: {
				apiKey: "",
				generation: 0,
				disabled: false,
				modelCollectionInitialized: true,
				models: [
					{
						id: modelId,
						name: modelId,
						context_length: 200_000,
						supported_protocols: ["anthropic:messages"],
					},
				],
			},
			commandCode: { apiKey: "", baseUrl, disabled: false },
		});
		registerAutoSourceProbe((provider, value) => autoSourceFacts(provider, Date.now(), value));
	});

	afterEach(() => {
		registerAutoSourceProbe(null);
		for (const id of [fallback, "tokendance", "CommandCode"]) getProviderKeyStore().removeGroup(id);
		saveSettings(saved);
		fs.rmSync(cliPath, { force: true });
		invalidateCommandCodeAuthCache();
		invalidateCommandCodeModelsCache();
		restoreHome();
	});

	async function publishCommandCodeCatalog(apiKey?: string) {
		const network = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				data: [{ id: modelId, supported_endpoints: ["/messages"] }],
			}),
		);
		try {
			expect(await listCommandCodeModels(apiKey, baseUrl)).toEqual({ models: [modelId], ok: true });
		} finally {
			network.mockRestore();
		}
	}

	for (const [prefix, template] of [
		["tokendance", "tokendance"],
		["CommandCode", "command-code"],
	] as const) {
		test(`${prefix}: a healthy sticky source stays; an all-disabled pool moves to a real fallback`, async () => {
			const store = getProviderKeyStore();
			const first = store.addGroupCredential(prefix, template, { apiKey: `sk-${prefix}-first` });
			const second = store.addGroupCredential(prefix, template, { apiKey: `sk-${prefix}-second` });
			if (prefix === "CommandCode") await publishCommandCodeCatalog(first.apiKey);
			const value = `${prefix}:${modelId}`;
			expect(listAutoModelCandidates(modelId)).toContain(value);
			const read = spyOn(fs, "readFileSync").mockImplementation(() => {
				throw new Error("routing read a file");
			});
			const network = spyOn(globalThis, "fetch").mockRejectedValue(
				new Error("routing fetched a directory"),
			);
			try {
				expect(queryForModel(value).query).toEqual({
					providerKey: prefix,
					upstreamModelId: modelId,
				});
				expect(resolveEffectiveModel(`auto:${modelId}`, prefix)).toBe(value);
				expect(read).not.toHaveBeenCalled();
				expect(network).not.toHaveBeenCalled();
			} finally {
				read.mockRestore();
				network.mockRestore();
			}
			store.update(first.id, { disabled: true });
			expect(resolveEffectiveModel(`auto:${modelId}`, prefix)).toBe(value);
			store.update(second.id, { disabled: true });
			expect(resolveEffectiveModel(`auto:${modelId}`, prefix)).toBe(`${fallback}:${modelId}`);
		});
	}

	test("unconfigured Command Code static models cannot enter Auto or inherit a settings-key directory", async () => {
		settings.agent.customModels.push(...models(`CommandCode:${modelId}`));
		expect(listAutoModelCandidates(modelId)).not.toContain(`CommandCode:${modelId}`);
		await publishCommandCodeCatalog("previous-settings-key");
		expect(listAutoModelCandidates(modelId)).not.toContain(`CommandCode:${modelId}`);
		expect(resolveEffectiveModel(`auto:${modelId}`, "CommandCode")).toBe(`${fallback}:${modelId}`);
	});

	test("CLI directory stays memory-only after auth and model TTLs expire, without admitting static ids", async () => {
		fs.mkdirSync(dirname(cliPath), { recursive: true });
		fs.writeFileSync(cliPath, JSON.stringify({ apiKey: "cli-catalog-key" }));
		const publishedAt = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(publishedAt);
		try {
			await publishCommandCodeCatalog();
			// Beyond the 5s auth TTL and 10min model TTL: no wall-clock grace period.
			clock.mockReturnValue(publishedAt + 11 * 60_000);
			settings.agent.customModels.push(...models("CommandCode:gpt-5.5"));
			const read = spyOn(fs, "readFileSync").mockImplementation(() => {
				throw new Error("catalog read CLI auth");
			});
			const network = spyOn(globalThis, "fetch").mockRejectedValue(
				new Error("catalog refreshed models"),
			);
			try {
				expect(queryForModel(`CommandCode:${modelId}`).query).toEqual({
					providerKey: "CommandCode",
					upstreamModelId: modelId,
				});
				expect(getVisibleModels()).toContain(`CommandCode:${modelId}`);
				expect(resolveEffectiveModel(`auto:${modelId}`, "CommandCode")).toBe(
					`CommandCode:${modelId}`,
				);
				expect(listAutoModelCandidates("gpt-5.5")).not.toContain("CommandCode:gpt-5.5");
				const group = getSourceGroup("CommandCode");
				if (!group) throw new Error("missing Command Code group");
				expect(
					captureCommandCodeModelOptions(group, undefined, baseUrl).readSlice(0, 10),
				).toMatchObject([{ value: `CommandCode:${modelId}` }]);
				expect(read).not.toHaveBeenCalled();
				expect(network).not.toHaveBeenCalled();
			} finally {
				read.mockRestore();
				network.mockRestore();
			}
			// Explicit refresh still re-reads expired CLI auth and publishes the new owner result.
			fs.writeFileSync(cliPath, JSON.stringify({ apiKey: "cli-rotated-key" }));
			const refresh = spyOn(globalThis, "fetch").mockResolvedValue(
				Response.json({
					data: [{ id: "gpt-5.5", supported_endpoints: ["/chat/completions"] }],
				}),
			);
			try {
				expect(await listCommandCodeModels(undefined, baseUrl)).toEqual({
					models: ["gpt-5.5"],
					ok: true,
				});
				expect(
					refresh.mock.calls.some(
						([, init]) =>
							new Headers(init?.headers).get("Authorization") === "Bearer cli-rotated-key",
					),
				).toBe(true);
				expect(getVisibleModels()).not.toContain(`CommandCode:${modelId}`);
			} finally {
				refresh.mockRestore();
			}
		} finally {
			clock.mockRestore();
		}
	});
});
