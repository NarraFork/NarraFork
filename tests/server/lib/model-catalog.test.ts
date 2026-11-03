import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import {
	applyModelCatalogUpdate,
	bindModelCatalogSettings,
	checkModelCatalogUpdate,
	getEffectiveModelCard,
	getEffectiveModelProfile,
	getModelOverride,
	keepModelCatalogSettings,
	migrateModelCatalogSettings,
	replaceModelOverridesForTests,
	restoreBuiltinModelCatalog,
	rewriteConnectionOverrides,
	setModelCatalogAutoUpdate,
	setModelOverride,
	withModelMetadataSnapshot,
	withModelMetadataSnapshotIterator,
} from "../../../server/lib/model-catalog";
import type { LegacyResolvedEnvelope } from "../../../server/lib/model-catalog/legacy-v1";
import {
	CATALOG_ARCHIVE_BASE,
	CATALOG_REVISION_URL,
	decodeBundledCatalog,
	MAX_CATALOG_BYTES,
	MAX_CATALOG_REVISION_BYTES,
} from "../../../server/lib/model-catalog/source";
import { getNarraforkHome } from "../../../server/lib/narrafork-home";
import {
	deleteNugCachedModels,
	getNugCachedModelsByProvider,
	resolveNugModelMeta,
} from "../../../server/lib/nug-model-cache";
import { applyNugModelCatalogUpdate } from "../../../server/lib/nug-model-sync";
import {
	_bindSettings,
	getDefaults,
	getModelContextWindow,
	saveSettings,
	settings,
} from "../../../server/lib/settings";
import type { NarraForkSettings } from "../../../server/lib/settings/types";
import { modelCatalogRoutes } from "../../../server/routes/model-catalog";
import type { AuthSessionStore } from "../../../server/services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../../server/services/auth/store";

let local: NarraForkSettings;
let restoreOverrides: () => void;
const originalFetch = globalThis.fetch;
beforeEach(() => {
	local = getDefaults();
	local.agent.modelCatalog = { autoUpdate: false };
	bindModelCatalogSettings(local, () => {});
	_bindSettings(local);
	restoreOverrides = replaceModelOverridesForTests({});
	const store: AuthSessionStore = {
		...authSessionStore,
		findSessionState: async (id) => ({
			id,
			role: id === "catalog-admin" ? "admin" : "user",
			tokenVersion: 0,
		}),
	};
	setAuthStores({ session: store, mfa: authMfaStore });
});
afterEach(() => {
	setAuthStores(undefined);
	globalThis.fetch = originalFetch;
	restoreBuiltinModelCatalog();
	restoreOverrides();
	deleteNugCachedModels("nug-test");
	deleteNugCachedModels("nug-card-test");
	bindModelCatalogSettings(settings, () => saveSettings(settings));
	_bindSettings(settings);
});
const profile = (model: string) => getEffectiveModelProfile(model);
function app(role: "admin" | "user" = "admin") {
	const app = new Hono();
	// Distinct subs per role: assertAdmin authorizes against the live store role.
	const sub = role === "admin" ? "catalog-admin" : "catalog-user";
	app.use("*", async (c, next) => {
		c.set("user", { sub, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.route("/api/model-catalog", modelCatalogRoutes);
	return app;
}
const json = (method: string, body: unknown) => ({
	method,
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});
/** Serve a catalog built from the bundled one through the GitHub URLs the updater uses. */
async function mockCatalog(
	label: string,
	modify?: (doc: ReturnType<typeof decodeBundledCatalog>) => void,
) {
	const catalog = structuredClone(decodeBundledCatalog());
	const version = createHash("sha1").update(label).digest("hex");
	modify?.(catalog);
	const files: Record<string, string> = {};
	for (const model of catalog.models) {
		files[`catalog-${version}/models/${model.id}.json`] = JSON.stringify({
			...model,
			variants: catalog.variants
				.filter((v) => v.modelId === model.id)
				.map(({ modelId: _, ...v }) => v),
		});
	}
	const archive = await new Bun.Archive(files, { compress: "gzip" }).bytes();
	globalThis.fetch = (async (url: string | URL | Request) => {
		if (String(url) === CATALOG_REVISION_URL)
			return Response.json({
				name: "main",
				commit: { sha: version, commit: { committer: { date: catalog.publishedAt } } },
			});
		if (String(url) === `${CATALOG_ARCHIVE_BASE}${version}`) return new Response(archive);
		throw new Error(`Unexpected catalog URL: ${url}`);
	}) as unknown as typeof fetch;
	return version;
}

describe("bundled catalog", () => {
	test("DeepSeek cards declare effective effort levels without upgrading retired aliases", () => {
		for (const model of [
			"deepseek-flash",
			"deepseek-v4.1-flash",
			"deepseek-v4.1-flash-1017",
			"deepseek-v4-flash",
			"deepseek-v4-pro",
			"deepseek-v4-flash-vision-exp",
		]) {
			const reasoning = profile(`openai:${model}`).reasoning;
			expect(reasoning.levels).toEqual(["low", "high", "max"]);
			expect(reasoning.canDisable).toBe(true);
			expect(reasoning.defaultLevel).toBe("high");
		}
		for (const model of ["deepseek-chat", "deepseek-reasoner"])
			expect(profile(`openai:${model}`).reasoning.levels).toBeUndefined();
	});

	test("Haiku 5.5 declares its xhigh tier without relying on Claude name heuristics", () => {
		expect(profile("anthropic:claude-haiku-5-5").reasoning.levels).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	test("covers routed aliases and vendor-prefixed ids", () => {
		for (const model of [
			"claude-haiku-5-5",
			"claude-opus-4-6-thinking",
			"claude-sonnet-4-5-20250929-v1:0",
			"gemini-3.1-pro-high",
			"gemini-4-argon",
			"gpt-image-2.5-flare-2026-09-08",
			"anthropic/claude-opus-4.6",
		])
			expect(profile(`openai:${model}`).card.matchedVia).not.toBe("none");
	});
});

describe("overrides", () => {
	test("a provider entry's own override applies by model value and clearing restores inheritance", () => {
		const preset = profile("codex:gpt-5.5").contextWindow;
		setModelOverride("connection", "codex:gpt-5.5", { contextWindow: 123_456 });
		expect(profile("codex:gpt-5.5").contextWindow).toBe(123_456);
		expect(profile("openai:gpt-5.5").contextWindow).toBe(preset);
		expect(getModelContextWindow("gpt-5.5", "codex")).toBe(123_456);
		setModelOverride("connection", "codex:gpt-5.5", null);
		expect(profile("codex:gpt-5.5").contextWindow).toBe(preset);
	});

	test("a model-wide override reaches every exact entry of that model", () => {
		setModelOverride("model", "gpt-5.5", { maxOutputTokens: 4_321 });
		expect(profile("codex:gpt-5.5").maxOutputTokens).toBe(4_321);
		expect(profile("openai:gpt-5.5").maxOutputTokens).toBe(4_321);
		expect(getModelOverride("model", "gpt-5.5")).toEqual({ maxOutputTokens: 4_321 });
	});

	test("saving validates only the edited override, with the field that failed", () => {
		expect(() => setModelOverride("model", "not-a-catalog-model", { contextWindow: 1 })).toThrow(
			"not a catalog model",
		);
		expect(() =>
			setModelOverride("connection", "openai:deepseek-v4-pro", { defaultReasoningLevel: "medium" }),
		).toThrow("not one this model offers");
		expect(getModelOverride("connection", "openai:deepseek-v4-pro")).toBeUndefined();
	});

	test("overrides persist to their own file, not settings.json", () => {
		restoreOverrides();
		setModelOverride("connection", "relay:persisted-model", { contextWindow: 70_000 });
		try {
			const path = resolve(getNarraforkHome(), "model-catalog", "overrides.json");
			expect(existsSync(path)).toBe(true);
			expect(JSON.parse(readFileSync(path, "utf8")).connections["relay:persisted-model"]).toEqual({
				contextWindow: 70_000,
			});
			expect(local.agent.modelCatalog).toEqual({ autoUpdate: false });
		} finally {
			setModelOverride("connection", "relay:persisted-model", null);
			restoreOverrides = replaceModelOverridesForTests({});
		}
	});

	test("renaming connection overrides moves them, and a collision is refused before writing", () => {
		replaceModelOverridesForTests({
			connections: { "old:m": { contextWindow: 1_000 }, "other:m": { contextWindow: 2_000 } },
		});
		expect(() =>
			rewriteConnectionOverrides((model) => model.replace(/^(old|other):/, "new:"), {
				dryRun: true,
			}),
		).toThrow("would both become");
		expect(getModelOverride("connection", "old:m")).toEqual({ contextWindow: 1_000 });
		expect(rewriteConnectionOverrides((model) => model.replace(/^old:/, "new:"))).toBe(true);
		expect(getModelOverride("connection", "new:m")).toEqual({ contextWindow: 1_000 });
		expect(getModelOverride("connection", "old:m")).toBeUndefined();
	});

	test("a request snapshot does not change under concurrent edits", async () => {
		await withModelMetadataSnapshot(async () => {
			const initial = profile("codex:gpt-5.5");
			setModelOverride("model", "gpt-5.5", { maxOutputTokens: 999 });
			await Promise.resolve();
			expect(profile("codex:gpt-5.5")).toEqual(initial);
		});
		expect(profile("codex:gpt-5.5").maxOutputTokens).toBe(999);
	});

	test("concurrent lazy generators keep independent snapshots across await/yield/return/throw", async () => {
		const price = () => profile("codex:gpt-5.5").referencePricing?.input;
		const setPrice = (value: string) =>
			setModelOverride("model", "gpt-5.5", { prices: { input: value } });
		let release: (() => void) | undefined;
		const gate = new Promise<void>((done) => {
			release = done;
		});
		const cleanup: Array<string | null | undefined> = [];
		async function* source(): AsyncGenerator<string | null | undefined, void> {
			try {
				yield price();
				await gate;
				yield price();
			} finally {
				cleanup.push(price());
			}
		}
		setPrice("0");
		const first = withModelMetadataSnapshotIterator(source);
		setPrice("1");
		const second = withModelMetadataSnapshotIterator(source);
		setPrice("2");
		expect((await first.next()).value).toBe("0");
		expect((await second.next()).value).toBe("1");
		const firstWaiting = first.next();
		const secondWaiting = second.next();
		setPrice("3");
		release?.();
		expect((await firstWaiting).value).toBe("0");
		expect((await secondWaiting).value).toBe("1");
		await first.return();
		await expect(second.throw(new Error("stop iterator"))).rejects.toThrow("stop iterator");
		await Promise.resolve();
		expect(cleanup).toEqual(["0", "1"]);
		expect(price()).toBe("3");
	});
});

describe("migration from settings.json", () => {
	test("an inline raw local layer moves to the overrides file and leaves only the preference", () => {
		local.openaiProviders = [
			{ id: "conn-1", name: "Relay", prefix: "relay", apiKey: "k", baseUrl: "", defaultModel: "" },
		];
		(local.agent as Record<string, unknown>).modelCatalog = {
			schemaVersion: 2,
			migrationVersion: 2,
			autoApply: false,
			pinnedVersion: null,
			local: {
				revision: 7,
				overrides: [
					{ target: "model", targetId: "gpt-5.5", metadata: { max_output_tokens: 8_000 } },
					{ target: "variant", targetId: "gpt-5.5@codex", metadata: { max_output_tokens: 1 } },
				],
				connections: { "relay:a": { working_context_tokens: 50_000, mode: "chat" } },
				bindings: [
					{
						id: "b1",
						providerId: "conn-1",
						upstreamModelId: "b",
						overrides: { input_cost_per_token: "0.000002" },
					},
					{
						id: "legacy-window:relay:c",
						upstreamModelId: "c",
						overrides: { working_context_tokens: 30_000 },
					},
				],
				models: [{ id: "custom", metadata: {} }],
			},
		};
		expect(migrateModelCatalogSettings(local)).toBe(true);
		expect(local.agent.modelCatalog).toEqual({ autoUpdate: true });
		expect(getModelOverride("model", "gpt-5.5")).toEqual({ maxOutputTokens: 8_000 });
		expect(getModelOverride("connection", "relay:a")).toEqual({ contextWindow: 50_000 });
		expect(getModelOverride("connection", "relay:b")).toEqual({ prices: { input: "2" } });
		expect(getModelOverride("connection", "relay:c")).toEqual({ contextWindow: 30_000 });
		// Already in the current shape: nothing to rewrite.
		expect(migrateModelCatalogSettings(local)).toBe(false);
	});

	test("a pinned catalog keeps auto update off", () => {
		(local.agent as Record<string, unknown>).modelCatalog = {
			schemaVersion: 2,
			autoApply: true,
			pinnedVersion: "abc",
			local: { revision: 0 },
		};
		migrateModelCatalogSettings(local);
		expect(local.agent.modelCatalog).toEqual({ autoUpdate: false });
	});

	test("a pre-catalog file imports exact cards, prices and windows only", () => {
		delete local.agent.modelCatalog;
		local.agent.modelCards = [
			{ modelKey: "claude-opus-4.6", contextWindow: 200_000 },
			{ modelKey: "claude-opus-4-6-custom-suffix", maxCompletionTokens: 1 },
		];
		local.pricing = {
			overrides: { "gpt-5.5": { input: 1.25, output: 10 } },
		} as typeof local.pricing;
		(local.agent as Record<string, unknown>).modelContextWindows = { "relay:x": 64_000 };
		migrateModelCatalogSettings(local);
		expect(getModelOverride("model", "claude-opus-4-6")).toEqual({ contextWindow: 200_000 });
		expect(getModelOverride("model", "gpt-5.5")).toEqual({
			prices: { input: "1.25", output: "10" },
		});
		expect(getModelOverride("connection", "relay:x")).toEqual({ contextWindow: 64_000 });
		expect((local.agent as Record<string, unknown>).modelContextWindows).toBeUndefined();
	});

	test("saving settings cannot change the catalog preference behind its back", () => {
		setModelCatalogAutoUpdate(true);
		const draft = structuredClone(local);
		(draft.agent as Record<string, unknown>).modelCatalog = {
			autoUpdate: false,
			local: { revision: 99 },
		};
		keepModelCatalogSettings(draft);
		expect(draft.agent.modelCatalog).toEqual({ autoUpdate: true });
	});
});

describe("discovered metadata", () => {
	test("NUG metadata wins presets, overrides win NUG, and an old gateway still works", () => {
		const config = {
			id: "nug-test",
			name: "NUG",
			prefix: "gateway",
			baseUrl: "https://example.invalid",
			apiKey: "unused",
			defaultModel: "",
		};
		local.nugProviders = [config];
		const metadata: LegacyResolvedEnvelope = {
			schemaVersion: 1,
			catalogVersion: "gateway-v1",
			localRevision: 2,
			matchedVia: "exact",
			metadata: {
				limits: { contextWindow: 333333, maxOutputTokens: 321 },
				modalities: { input: ["text"] },
				nativeSearch: { supported: false },
				referencePricing: { input: "0" },
			},
			provenance: {},
		};
		applyNugModelCatalogUpdate(
			config,
			[
				{
					id: "channel:gpt-5.5",
					model: "gpt-5.5",
					channel: "channel",
					channelType: "openai",
					metadata,
				},
			],
			"hash-v1",
			{ saveCache: false },
		);
		expect(getNugCachedModelsByProvider(config.id)[0]?.metadata).toEqual(metadata);
		expect(
			resolveNugModelMeta(config.id, config.prefix, "gateway:channel:gpt-5.5").metadata,
		).toEqual(metadata);
		expect(profile("gateway:channel:gpt-5.5").contextWindow).toBe(333333);
		expect(profile("gateway:channel:gpt-5.5").maxOutputTokens).toBe(321);
		expect(profile("gateway:channel:gpt-5.5").nativeSearch).toBe(false);
		setModelOverride("model", "gpt-5.5", { contextWindow: 250_000 });
		expect(getModelContextWindow("channel:gpt-5.5", "gateway")).toBe(250_000);
		setModelOverride("model", "gpt-5.5", null);
		expect(getModelContextWindow("channel:gpt-5.5", "gateway")).toBe(333333);
		applyNugModelCatalogUpdate(
			config,
			[
				{
					id: "channel:gpt-5.5",
					model: "gpt-5.5",
					channel: "channel",
					channelType: "openai",
					contextLength: 444444,
				},
			],
			"hash-v2",
			{ saveCache: false },
		);
		expect(profile("gateway:channel:gpt-5.5").contextWindow).toBe(444444);
	});

	test("a NUG card with operational keys is discarded; its old envelope still applies", () => {
		const config = {
			id: "nug-card-test",
			name: "NUG",
			prefix: "gw",
			baseUrl: "https://example.invalid",
			apiKey: "unused",
			defaultModel: "",
		};
		local.nugProviders = [config];
		const card = {
			schemaVersion: 2 as const,
			catalogVersion: "v2:gateway-v1",
			localRevision: 0,
			matchedVia: "exact" as const,
			metadata: { max_input_tokens: 128000, max_output_tokens: 32000 },
			provenance: {},
			view: {
				mode: "chat",
				category: "text",
				limits: {},
				fields: [],
				prices: [],
				pricingBasis: null,
				attributes: {},
			},
		};
		applyNugModelCatalogUpdate(
			config,
			[{ id: "ch:m", model: "m", channel: "ch", channelType: "openai", modelCard: card }],
			"hash-card",
			{ saveCache: false },
		);
		expect(profile("gw:ch:m").maxOutputTokens).toBe(32000);
		expect(getEffectiveModelCard("gw:ch:m").provenance.max_input_tokens?.layer).toBe("discovered");
		applyNugModelCatalogUpdate(
			config,
			[
				{
					id: "ch:m",
					model: "m",
					channel: "ch",
					channelType: "openai",
					metadata: {
						schemaVersion: 1 as const,
						catalogVersion: "g",
						localRevision: 0,
						matchedVia: "exact" as const,
						metadata: { limits: { contextWindow: 333333 } },
						provenance: {},
					},
					modelCard: {
						...card,
						metadata: { credentials: { apiKey: "leak" }, billingMultiplier: 2 },
					},
				},
			],
			"hash-unsafe",
			{ saveCache: false },
		);
		expect(resolveNugModelMeta(config.id, config.prefix, "gw:ch:m").modelCard).toBeUndefined();
		expect(profile("gw:ch:m").contextWindow).toBe(333333);
	});
});

describe("catalog updates", () => {
	test("auto update applies a newer catalog; restore returns to the built-in one", async () => {
		setModelCatalogAutoUpdate(true);
		const version = await mockCatalog("auto", (catalog) => {
			catalog.models[0]!.notes = "changed";
		});
		const status = await checkModelCatalogUpdate();
		expect(status.lastError).toBeUndefined();
		expect(status.source).toBe("downloaded");
		expect(status.version).toBe(version.slice(0, 7));
		expect(restoreBuiltinModelCatalog().source).toBe("builtin");
	});

	test("with auto update off a check stages the catalog until it is applied", async () => {
		await mockCatalog("staged", (catalog) => {
			catalog.models.push({ ...structuredClone(catalog.models[0]!), id: "brand-new-model" });
		});
		const staged = await checkModelCatalogUpdate();
		expect(staged.source).toBe("builtin");
		expect(staged.pending).toMatchObject({ added: 1, changed: 0 });
		const applied = applyModelCatalogUpdate();
		expect(applied.source).toBe("downloaded");
		expect(applied.pending).toBeUndefined();
		expect(profile("openai:brand-new-model").card.modelId).toBe("brand-new-model");
	});

	test("reuses the branch ETag and does not download again on 304", async () => {
		const version = await mockCatalog("branch-etag");
		const fixture = globalThis.fetch;
		const etag = '"catalog-branch-etag"';
		let revisionCalls = 0;
		let archiveCalls = 0;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url) === CATALOG_REVISION_URL) {
				revisionCalls++;
				if (revisionCalls > 1) {
					expect(new Headers(init?.headers).get("If-None-Match")).toBe(etag);
					return new Response(null, { status: 304 });
				}
				const response = await fixture(url, init);
				response.headers.set("etag", etag);
				return response;
			}
			archiveCalls++;
			return fixture(url, init);
		}) as unknown as typeof fetch;
		const first = await checkModelCatalogUpdate();
		expect(first.pending?.version).toBe(version.slice(0, 7));
		const second = await checkModelCatalogUpdate();
		expect(second.lastError).toBeUndefined();
		expect(second.pending).toEqual(first.pending);
		expect(revisionCalls).toBe(2);
		expect(archiveCalls).toBe(1);
	});

	test("corrupt downloads keep the catalog in use; concurrent checks are one flight", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response("not json");
		}) as unknown as typeof fetch;
		const a = checkModelCatalogUpdate();
		const b = checkModelCatalogUpdate();
		expect(a).toBe(b);
		const status = await a;
		expect(calls).toBe(1);
		expect(status.source).toBe("builtin");
		expect(status.lastError).toBeDefined();
	});

	test.each([
		["revision", MAX_CATALOG_REVISION_BYTES],
		["archive", MAX_CATALOG_BYTES],
	] as const)("rejects an oversized %s by its Content-Length", async (kind, max) => {
		const version = await mockCatalog(`oversized-${kind}`);
		const fixture = globalThis.fetch;
		const rejectedUrl =
			kind === "revision" ? CATALOG_REVISION_URL : `${CATALOG_ARCHIVE_BASE}${version}`;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url) !== rejectedUrl) return fixture(url, init);
			return new Response(new ReadableStream<Uint8Array>(), {
				headers: { "content-length": String(max + 1) },
			});
		}) as unknown as typeof fetch;
		const status = await checkModelCatalogUpdate();
		expect(status.lastError).toBe(
			`Catalog ${kind} download exceeds size limit (${max + 1} bytes; limit ${max} bytes)`,
		);
		expect(status.pending).toBeUndefined();
	});

	test("redirects and invalid revisions are refused, and errors carry no host paths", async () => {
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			expect(init?.redirect).toBe("error");
			return Response.json({ commit: { sha: "../../other-repo" } });
		}) as unknown as typeof fetch;
		expect((await checkModelCatalogUpdate()).lastError).toContain("Git revision");
		globalThis.fetch = (async () => {
			throw new Error(
				"ENOENT: no such file or directory, open '/home/someone-private/.narrafork/x.json'",
			);
		}) as unknown as typeof fetch;
		const status = await checkModelCatalogUpdate();
		expect(status.lastError).not.toContain("someone-private");
		expect(status.lastError).toContain("x.json");
		expect(status.source).toBe("builtin");
	});
});

describe("API", () => {
	test("members read; only admins write; a rejected field is reported with its name", async () => {
		const card = await (
			await app("user").request("/api/model-catalog/card?model=codex:gpt-5.5")
		).json();
		expect(card.metadata).toHaveProperty("input_cost_per_token");
		expect(card.resolvedQuery).toEqual({ upstreamModelId: "gpt-5.5", providerKey: "codex" });
		expect((await app("user").request("/api/model-catalog/status")).status).toBe(200);
		const described = await (
			await app("user").request(
				"/api/model-catalog/models",
				json("POST", { models: ["codex:gpt-5.5"] }),
			)
		).json();
		expect(described.models[0]).toMatchObject({
			model: "codex:gpt-5.5",
			catalogModelId: "gpt-5.5",
			modelWideEditable: true,
		});
		expect(described.models[0].effective.contextWindow.origin).toBe("catalog");

		const body = {
			scope: "connection",
			key: "codex:gpt-5.5",
			fields: { contextWindow: 100_000 },
			model: "codex:gpt-5.5",
		};
		expect(
			(await app("user").request("/api/model-catalog/overrides", json("PUT", body))).status,
		).toBe(403);
		const saved = await (
			await app().request("/api/model-catalog/overrides", json("PUT", body))
		).json();
		expect(saved.effective.contextWindow).toEqual({ value: 100_000, origin: "connection" });
		expect(saved.connectionOverride).toEqual({ contextWindow: 100_000 });

		const rejected = await app().request(
			"/api/model-catalog/overrides",
			json("PUT", { ...body, fields: { prices: { input: "-1" } } }),
		);
		expect(rejected.status).toBe(400);
		expect(await rejected.json()).toMatchObject({
			code: "INVALID_OVERRIDE",
			field: "prices.input",
		});
		expect(
			(await app("user").request("/api/model-catalog/updates/check", json("POST", {}))).status,
		).toBe(403);
	});
});
