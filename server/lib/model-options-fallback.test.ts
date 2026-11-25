import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	captureModelOptionsArray,
	optionInput,
	registerModelOptionsCapture,
} from "./model-options-contract";
import type { CustomApiProviderConfig } from "./settings/types";

const home = mkdtempSync(join(tmpdir(), "nf-options-fallback-"));
const previousHome = process.env.NARRAFORK_HOME;
process.env.NARRAFORK_HOME = home;
const { ModelOptionsClient, captureModelOptionsSnapshot } = await import("./model-options");
const { settings, saveSettings } = await import("./settings");
const { CodexManager, __setCodexManagerForTests } = await import("./codex-manager");
const { runtimeModelReadiness } = await import("./settings/runtime-readiness");
const saved = structuredClone(settings);
const originalFetch = globalThis.fetch;
let codex: InstanceType<typeof CodexManager>;
function installCodexFixture() {
	const managerHome = mkdtempSync(join(home, "codex-"));
	const directory = join(managerHome, ".narrafork");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "codex-credentials.json"),
		JSON.stringify(
			["a", "b"].map((id) => ({
				id,
				refreshToken: `rt-${id}`,
				accessToken: `at-${id}`,
				accountId: `account-${id}`,
				expiresAt: Date.now() + 60 * 60_000,
				priority: 0,
				disabled: true,
				disabledReason: "manual",
			})),
		),
	);
	codex = new CodexManager({ homeDir: managerHome, registerProcessHooks: false });
	__setCodexManagerForTests(codex);
}
function mockUsage(usedPercent: number) {
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				plan_type: "plus",
				rate_limit: {
					allowed: usedPercent < 100,
					limit_reached: usedPercent >= 100,
					primary_window: {
						used_percent: usedPercent,
						limit_window_seconds: 18_000,
						reset_after_seconds: 3600,
						reset_at: Math.floor(Date.now() / 1000) + 3600,
					},
					secondary_window: null,
				},
				additional_rate_limits: [],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		)) as unknown as typeof fetch;
}
const cache = new Map<string, string[]>();
const disposeCaptures = (
	["completions-compatible", "openai-responses", "anthropic-messages", "gemini-compatible"] as const
).map((source) =>
	registerModelOptionsCapture(source, (group) =>
		captureModelOptionsArray(cache.get(group.id), (id) => optionInput(group, id)),
	),
);
const clients: InstanceType<typeof ModelOptionsClient>[] = [];
function provider(
	id = "relay",
	extra: Partial<CustomApiProviderConfig> = {},
): CustomApiProviderConfig {
	return {
		id,
		prefix: id,
		name: id,
		apiKey: "fixture-key",
		baseUrl: "https://relay.invalid/v1",
		protocol: "completions-compatible",
		defaultModel: "configured-model",
		...extra,
	};
}
function configure(
	providers: CustomApiProviderConfig[],
	pins: { defaultModel?: string; summaryModel?: string } = {},
	disabledProviders: string[] = [],
) {
	saveSettings({
		...structuredClone(saved),
		customApiProviders: providers,
		nugProviders: [],
		tokendance: { apiKey: "", generation: 0, disabled: true },
		commandCode: { disabled: true },
		agent: {
			...structuredClone(saved.agent),
			customModels: [],
			hiddenModels: [],
			modelAggregations: [],
			disabledProviders,
			defaultModel: "",
			summaryModel: "",
			...pins,
		},
	});
}
function client() {
	const value = new ModelOptionsClient();
	clients.push(value);
	return value;
}
const query = { q: "", scope: "concrete" as const, limit: 100 };
beforeEach(() => {
	installCodexFixture();
	cache.clear();
	configure([]);
});
afterEach(async () => {
	await Promise.all(clients.splice(0).map((value) => value.close()));
	globalThis.fetch = originalFetch;
	__setCodexManagerForTests(undefined);
});
afterAll(() => {
	for (const dispose of disposeCaptures) dispose();
	saveSettings(saved);
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(home, { recursive: true, force: true });
});

test("empty discovery preserves provider default and two global pins without synthesizing auto sources", async () => {
	configure([provider()], {
		defaultModel: "relay:global-default",
		summaryModel: "relay:global-summary",
	});
	const instance = client();
	const first = captureModelOptionsSnapshot();
	expect(captureModelOptionsSnapshot().revision).toBe(first.revision);
	const page = await instance.query(query);
	expect(page.items.map((row) => row.value).sort()).toEqual([
		"relay:configured-model",
		"relay:global-default",
		"relay:global-summary",
	]);
	const auto = await instance.query({ ...query, scope: "auto" });
	expect(auto.items).toEqual([]);
});

test("fallback requires an enabled configured prefix and credentials", async () => {
	configure(
		[
			provider("missing", { apiKey: " " }),
			provider("disabled", { disabled: true }),
			provider("blocked"),
			provider("enabled"),
		],
		{ defaultModel: "ghost:not-configured", summaryModel: "missing:global-pin" },
		["blocked"],
	);
	const page = await client().query(query);
	expect(page.items.map((row) => row.value)).toEqual(["enabled:configured-model"]);
});

test("legacy OpenAI/Anthropic/Gemini arrays normalize into configured cold fallback owners", async () => {
	saveSettings({
		...settings,
		customApiProviders: undefined,
		openaiProviders: [provider("legacy-oai")],
		anthropicProviders: [provider("legacy-ant")],
		geminiProviders: [provider("legacy-gem")],
	});
	expect(settings.customApiProviders?.map((value) => value.prefix).sort()).toEqual([
		"legacy-ant",
		"legacy-gem",
		"legacy-oai",
	]);
	const page = await client().query(query);
	expect(page.items.map((row) => row.value).sort()).toEqual([
		"legacy-ant:configured-model",
		"legacy-gem:configured-model",
		"legacy-oai:configured-model",
	]);
});

test("explicit custom declarations win over fallback label and auto participation", async () => {
	configure([provider("relay", { defaultModel: "gpt-6-astra" })]);
	saveSettings({
		...settings,
		agent: {
			...settings.agent,
			customModels: [
				{ value: "relay:gpt-6-astra", label: "Explicit supported model", provider: "relay" },
			],
		},
	});
	const instance = client();
	expect((await instance.query(query)).items[0]?.label).toBe("Explicit supported model");
	const auto = await instance.query({ ...query, scope: "auto" });
	expect(auto.items[0]?.sourceCount).toBe(1);
});

test("NUG cold fallback preserves channel-qualified defaults and its own global pin", async () => {
	saveSettings({
		...settings,
		nugProviders: [
			{
				id: "gateway",
				prefix: "gateway",
				name: "Gateway",
				apiKey: "fixture-key",
				baseUrl: "https://gateway.invalid",
				defaultModel: "codex:gpt-6-astra",
			},
		],
		agent: {
			...settings.agent,
			defaultModel: "gateway:anthropic:claude",
			summaryModel: "unknown:pin",
		},
	});
	const page = await client().query(query);
	expect(page.items.map((row) => row.value).sort()).toEqual([
		"gateway:anthropic:claude",
		"gateway:codex:gpt-6-astra",
	]);
});

test("nonempty discovery does not promote known-delisted defaults or pins", async () => {
	configure([provider()], { defaultModel: "relay:delisted", summaryModel: "relay:also-delisted" });
	cache.set("relay", ["discovered"]);
	const page = await client().query(query);
	expect(page.items.map((row) => row.value)).toEqual(["relay:discovered"]);
});

test("worker deduplicates the bounded default/global fallback inputs", async () => {
	configure([provider()], {
		defaultModel: "relay:configured-model",
		summaryModel: "relay:configured-model",
	});
	const page = await client().query({ ...query, limit: 1 });
	expect(page.items.map((row) => row.value)).toEqual(["relay:configured-model"]);
	expect(page.hasMore).toBe(false);
});

test("fallback with a strong catalog identity is still not an auto source", async () => {
	configure([provider("relay", { defaultModel: "gpt-6-astra" })]);
	const instance = client();
	expect((await instance.query(query)).items.map((row) => row.value)).toEqual([
		"relay:gpt-6-astra",
	]);
	expect((await instance.query({ ...query, scope: "auto" })).items).toEqual([]);
});

test("credentialless Codex is excluded including explicit custom models and pins", async () => {
	configure([], { defaultModel: "codex:gpt-6-astra", summaryModel: "codex:gpt-6.1-sol" });
	saveSettings({
		...settings,
		agent: {
			...settings.agent,
			customModels: [{ value: "codex:manual", label: "manual", provider: "codex" }],
		},
	});
	const snapshot = captureModelOptionsSnapshot();
	expect(snapshot.codex).toBe(false);
	expect((await client().query({ ...query, q: "codex" })).items).toEqual([]);
});

test("aggregation Codex pins cannot bypass the credential gate", async () => {
	saveSettings({
		...settings,
		agent: {
			...settings.agent,
			modelAggregations: [
				{ id: "pinned", name: "Pinned group", models: ["codex:manual"], routingMode: "priority" },
			],
		},
	});
	const page = await client().query({ ...query, aggregationId: "pinned" });
	expect(page.items).toHaveLength(1);
	expect(page.items[0]?.value).toBe("__agg__:pinned:codex:manual");
	expect(page.items[0]?.available).toBe(false);
});

test("real quota exhaustion and recovery preserve configured readiness and the same client index", async () => {
	codex.setDisabled("a", false);
	const { connectCompiledWorker } = await import("./compiled-worker");
	let starts = 0;
	const instance = new ModelOptionsClient({
		capture: captureModelOptionsSnapshot,
		connect: (...args) => {
			starts++;
			return connectCompiledWorker(...args);
		},
	});
	clients.push(instance);
	const initial = captureModelOptionsSnapshot();
	const first = await instance.query({ ...query, q: "codex", limit: 1 });
	expect(first.items).toHaveLength(1);
	mockUsage(100);
	await codex.getUsage("a");
	expect(codex.availableCount).toBe(0);
	expect(runtimeModelReadiness(settings, "codex:gpt-6-astra")).toBe(true);
	expect(captureModelOptionsSnapshot().revision).toBe(initial.revision);
	expect((await instance.query({ ...query, q: "codex", limit: 1 })).items).toHaveLength(1);
	mockUsage(20);
	await codex.getUsage("a");
	expect(codex.availableCount).toBe(1);
	expect(runtimeModelReadiness(settings, "codex:gpt-6-astra")).toBe(true);
	expect(captureModelOptionsSnapshot().revision).toBe(initial.revision);
	const continued = await instance.query({
		...query,
		q: "codex",
		limit: 1,
		cursor: first.nextCursor ?? undefined,
	});
	expect(continued.items).toHaveLength(1);
	expect(starts).toBe(1);
});

test("real manual stops and archival update configured presence for the same client", async () => {
	codex.setDisabled("a", false);
	const instance = client();
	const initial = captureModelOptionsSnapshot();
	expect((await instance.query({ ...query, q: "codex", limit: 1 })).items).toHaveLength(1);
	codex.setDisabled("a", true);
	expect(runtimeModelReadiness(settings, "codex:gpt-6-astra")).toBe(false);
	expect(captureModelOptionsSnapshot().revision).not.toBe(initial.revision);
	expect((await instance.query({ ...query, q: "codex", limit: 1 })).items).toEqual([]);
	codex.setDisabled("a", false);
	expect(captureModelOptionsSnapshot().revision).toBe(initial.revision);
	expect((await instance.query({ ...query, q: "codex", limit: 1 })).items).toHaveLength(1);
	codex.archiveCredential("a");
	expect(runtimeModelReadiness(settings, "codex:gpt-6-astra")).toBe(false);
	expect((await instance.query({ ...query, q: "codex", limit: 1 })).items).toEqual([]);
	codex.unarchiveCredential("a");
	expect(runtimeModelReadiness(settings, "codex:gpt-6-astra")).toBe(true);
	expect(captureModelOptionsSnapshot().revision).toBe(initial.revision);
	expect((await instance.query({ ...query, q: "codex", limit: 1 })).items).toHaveLength(1);
});

test("enabled credential presence updates before paging; positive count fluctuations keep a stable generation", async () => {
	configure([provider()]);
	const instance = client();
	const absent = await instance.query({ ...query, q: "codex", limit: 1 });
	expect(absent.items).toEqual([]);
	expect(absent.hasMore).toBe(false);
	codex.setDisabled("a", false);
	const available = captureModelOptionsSnapshot();
	expect(available.codex).toBe(true);
	codex.setDisabled("b", false);
	expect(captureModelOptionsSnapshot().revision).toBe(available.revision);
	expect((await instance.query({ ...query, q: "codex", limit: 1 })).items).toHaveLength(1);
	codex.setDisabled("a", true);
	codex.setDisabled("b", true);
	expect(captureModelOptionsSnapshot().revision).not.toBe(available.revision);
	const codexPage = await instance.query({ ...query, q: "codex", limit: 1 });
	expect(codexPage.items).toEqual([]);
	expect(codexPage.hasMore).toBe(false);
	const first = await instance.query({ ...query, limit: 1 });
	expect(first.items.map((row) => row.value)).toEqual(["relay:configured-model"]);
	expect(first.hasMore).toBe(false);
});
