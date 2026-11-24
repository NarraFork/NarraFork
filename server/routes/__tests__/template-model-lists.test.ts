import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const previousHome = process.env.NARRAFORK_HOME;
const home = mkdtempSync(join(tmpdir(), "nf-template-model-lists-"));
const originalFetch = globalThis.fetch;
const fixtures = {
	openai: [
		{ id: "second", object: "model", owned_by: "one", extra: { limit: 100 } },
		{ id: "first", object: "model", owned_by: "two" },
	],
	anthropic: [
		{ id: "second", display_name: "Second", created_at: "2026-01-01" },
		{ id: "first", display_name: "First" },
	],
	gemini: [{ id: "gemini-test", name: "models/gemini-test", contextLength: 65_536 }],
	nug: [{ id: "kiro:test", available: false, contextLength: 100_000, contextWindow: 100_000 }],
};
let app: Hono;
let settings: typeof import("../../lib/settings").settings;
let cachedByFamily: Record<keyof typeof fixtures, (id: string) => Array<{ id?: unknown }>>;

beforeAll(async () => {
	process.env.NARRAFORK_HOME = home;
	writeFileSync(
		join(home, "openai-models-providers.json"),
		JSON.stringify({ openai: fixtures.openai }),
	);
	writeFileSync(
		join(home, "anthropic-models-providers.json"),
		JSON.stringify({ anthropic: fixtures.anthropic }),
	);
	// Gemini keeps the narraforkDir captured by the settings module. The global test
	// preload has already isolated that directory; the other owners resolve home lazily.
	writeFileSync(
		join((await import("../../lib/settings")).narraforkDir, "gemini-models-providers.json"),
		JSON.stringify({
			gemini: { transport: "generate-content", models: fixtures.gemini },
		}),
	);
	({ settings } = await import("../../lib/settings"));
	const { openaiRoutes, getOpenaiCachedModelsByProvider } = await import("../openai");
	const { anthropicRoutes, getAnthropicCachedModelsByProvider } = await import("../anthropic");
	const { geminiRoutes, getGeminiCachedModelsByProvider } = await import("../gemini");
	const { nugRoutes } = await import("../nug");
	const { setNugCachedModels, getNugCachedModelsByProvider } = await import(
		"../../lib/nug-model-cache"
	);
	cachedByFamily = {
		openai: getOpenaiCachedModelsByProvider,
		anthropic: getAnthropicCachedModelsByProvider,
		gemini: getGeminiCachedModelsByProvider,
		nug: getNugCachedModelsByProvider,
	};
	setNugCachedModels("nug", fixtures.nug);
	app = new Hono();
	app.use("*", async (c, next) => {
		const user = { sub: "test-user", sid: "test-session", role: "admin" };
		c.set("user" as never, user as never);
		c.set("auth" as never, { type: "session", user } as never);
		await next();
	});
	app.route("/openai", openaiRoutes);
	app.route("/anthropic", anthropicRoutes);
	app.route("/gemini", geminiRoutes);
	app.route("/nug", nugRoutes);
});

beforeEach(async () => {
	const common = { name: "Test", apiKey: "fake", defaultModel: "m", disabled: true };
	// Do not save or bump the revision. The canonical arrays keep late normalization
	// from overwriting a derived fixture, while management GETs still see current config.
	settings.customApiProviders = [
		{
			...common,
			id: "openai",
			prefix: "test-openai",
			baseUrl: "https://relay.example/v1",
			protocol: "completions-compatible",
		},
		{
			...common,
			id: "anthropic",
			prefix: "test-anthropic",
			baseUrl: "https://api.kimi.com/coding/v1",
			protocol: "anthropic-messages",
		},
		{
			...common,
			id: "gemini",
			prefix: "test-gemini",
			baseUrl: "https://gemini.example/v1beta",
			protocol: "gemini-compatible",
		},
	];
	const { normalizeCustomApiProviderSettings } = await import(
		"../../lib/settings/custom-api-providers"
	);
	normalizeCustomApiProviderSettings(settings);
	expect(settings.geminiProviders).toHaveLength(1);
	settings.nugProviders = [
		{ ...common, id: "nug", prefix: "test-nug", baseUrl: "https://nug.example" },
	];
});
afterEach(() => {
	globalThis.fetch = originalFetch;
});
afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(home, { recursive: true, force: true });
});

describe("per-connection cached model GETs through templates", () => {
	test.each([
		"openai",
		"anthropic",
		"gemini",
		"nug",
	] as const)("%s keeps full objects and order for a disabled connection without fetching", async (family) => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			throw new Error("cached GET must not fetch");
		}) as unknown as typeof fetch;
		const res = await app.request(`/${family}/providers/${family}/models`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ models: fixtures[family], fromCache: true });
		expect(calls).toBe(0);
	});

	test.each([
		"openai",
		"anthropic",
		"gemini",
		"nug",
	] as const)("%s keeps an unknown connection as an empty cached list", async (family) => {
		const res = await app.request(`/${family}/providers/unknown/models`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ models: [], fromCache: true });
	});

	test("changing Gemini transport without a revision cannot expose the old cache", async () => {
		const config = settings.geminiProviders?.[0];
		if (!config) throw new Error("fixture missing");
		config.geminiTransport = "interactions";
		try {
			const res = await app.request("/gemini/providers/gemini/models");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ models: [], fromCache: true });
		} finally {
			delete config.geminiTransport;
		}
	});
});

test.each([
	["openai", "completions-compatible"],
	["anthropic", "anthropic-messages"],
	["gemini", "gemini-compatible"],
	["nug", "nug"],
] as const)("%s GET actually consults the frozen template's current reader", async (family, source) => {
	const { registerModelListReader } = await import("../../lib/sourcing/model-list-readers");
	const seen: string[] = [];
	const dispose = registerModelListReader(source, (group) => {
		seen.push(group.id);
		return [];
	});
	try {
		expect(cachedByFamily[family](family).length).toBeGreaterThan(0);
		const res = await app.request(`/${family}/providers/${family}/models`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ models: [], fromCache: true });
		expect(seen).toEqual([family]);
	} finally {
		dispose();
		registerModelListReader(source, (group) =>
			cachedByFamily[family](group.id).map((model) => String(model.id ?? "")),
		);
	}
});

test.each([
	"openai-responses",
	"completions-compatible",
] as const)("canonical OpenAI %s selects its matching reader after legacy projection", async (protocol) => {
	const configured = settings.customApiProviders?.find((config) => config.id === "openai");
	if (!configured) throw new Error("fixture missing");
	configured.protocol = protocol;
	const { normalizeCustomApiProviderSettings } = await import(
		"../../lib/settings/custom-api-providers"
	);
	normalizeCustomApiProviderSettings(settings);
	expect(settings.openaiProviders?.[0]?.apiMode).toBe(
		protocol === "openai-responses" ? "codex" : "completions",
	);
	const { registerModelListReader } = await import("../../lib/sourcing/model-list-readers");
	const reads: string[] = [];
	const sources = ["openai-responses", "completions-compatible"] as const;
	const disposers = sources.map((source) =>
		registerModelListReader(source, () => {
			reads.push(source);
			return fixtures.openai.map((model) => model.id);
		}),
	);
	try {
		const res = await app.request("/openai/providers/openai/models");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ models: fixtures.openai, fromCache: true });
		expect(reads).toEqual([protocol]);
	} finally {
		for (const dispose of disposers) dispose();
		for (const source of sources)
			registerModelListReader(source, (group) =>
				cachedByFamily.openai(group.id).map((model) => String(model.id ?? "")),
			);
	}
});
