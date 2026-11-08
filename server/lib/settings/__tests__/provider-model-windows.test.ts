import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelOverride } from "@shared/model-catalog/override";
import type { ModelDescription, ModelDescriptionsResponse } from "@shared/model-catalog/schema/api";
import { Hono } from "hono";
import { modelCatalogRoutes } from "../../../routes/model-catalog";
import type { AuthSessionStore } from "../../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../../services/auth/store";
import {
	getEffectiveModelCard,
	getEffectiveModelProfile,
	getModelOverride,
	getModelOverridesRevision,
	registerListingWindows,
	replaceModelOverridesForTests,
	rewriteConnectionOverrides,
} from "../../model-catalog";
import { deleteNugCachedModels, setNugCachedModels } from "../../nug-model-cache";
import {
	getModelContextWindow,
	narraforkDir,
	reloadSettings,
	saveSettings,
	settings,
} from "../index";

/**
 * A context window is set either for one provider entry (its full model value) or for
 * the model under every provider. Regression for "provider page set gpt-6-astra to
 * 272000 but the narrator still used 1.1M": an entry's own window applies to the model
 * value it was entered for, whatever else the catalog holds and however it resolves.
 */
const path = join(narraforkDir, "settings.json");
const original = readFileSync(path, "utf8");
let restoreOverrides: () => void = () => {};
beforeEach(() => {
	// assertAdmin reads the live store role, not the token claim, so the acting
	// admin must be reported as admin by the session store.
	const store: AuthSessionStore = {
		...authSessionStore,
		findSessionState: async (id) => ({ id, role: "admin", tokenVersion: 0 }),
	};
	setAuthStores({ session: store, mfa: authMfaStore });
	// Every test starts without overrides; edits made through the API are undone after.
	restoreOverrides = replaceModelOverridesForTests({});
});
afterEach(() => {
	setAuthStores(undefined);
	deleteNugCachedModels("window-nug");
	writeFileSync(path, original);
	reloadSettings();
	restoreOverrides();
});
const app = new Hono<{ Variables: { user: { sub: string; role: string } } }>();
app.use("*", async (c, next) => {
	c.set("user", { sub: "window-test", role: "admin" });
	await next();
});
app.route("/model-catalog", modelCatalogRoutes);

function putOverride(
	scope: "connection" | "model",
	key: string,
	fields: ModelOverride | null,
	model?: string,
) {
	return app.request("/model-catalog/overrides", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scope, key, fields, ...(model ? { model } : {}) }),
	});
}
const setWindow = (scope: "connection" | "model", key: string, contextWindow: number | null) =>
	putOverride(scope, key, contextWindow === null ? null : { contextWindow });
async function describeModels(...models: string[]): Promise<ModelDescription[]> {
	const response = await app.request("/model-catalog/models", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ models }),
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as ModelDescriptionsResponse;
	expect(body.revision).toBe(getModelOverridesRevision());
	return body.models;
}

describe("provider-model and model-wide context windows", () => {
	test("a provider entry's own window beats the model-wide one, which beats the preset", async () => {
		const codex = "codex:gpt-6-astra";
		const openai = "openai:gpt-6-astra";
		expect(getModelContextWindow("gpt-6-astra", "codex")).toBe(1_050_000);

		expect((await setWindow("model", "gpt-6-astra", 400_000)).status).toBe(200);
		expect(getModelContextWindow("gpt-6-astra", "codex")).toBe(400_000);
		expect(getModelContextWindow("gpt-6-astra", "openai")).toBe(400_000);

		expect((await setWindow("connection", codex, 272_000)).status).toBe(200);
		expect(getModelContextWindow("gpt-6-astra", "codex")).toBe(272_000);
		expect(getModelContextWindow("gpt-6-astra", "openai")).toBe(400_000);

		const [own, other] = await describeModels(codex, openai);
		expect(own).toMatchObject({
			model: codex,
			catalogModelId: "gpt-6-astra",
			modelWideEditable: true,
			effective: { contextWindow: { value: 272_000, origin: "connection" } },
			connectionOverride: { contextWindow: 272_000 },
			modelOverride: { contextWindow: 400_000 },
		});
		expect(other).toMatchObject({
			effective: { contextWindow: { value: 400_000, origin: "model" } },
			modelOverride: { contextWindow: 400_000 },
		});
		expect(other?.connectionOverride).toBeUndefined();

		// Clearing the entry falls back to the model-wide value, not to the preset.
		expect((await setWindow("connection", codex, null)).status).toBe(200);
		expect(getModelContextWindow("gpt-6-astra", "codex")).toBe(400_000);
		expect((await setWindow("model", "gpt-6-astra", null)).status).toBe(200);
		expect(getModelContextWindow("gpt-6-astra", "codex")).toBe(1_050_000);
		expect(getModelOverride("connection", codex)).toBeUndefined();
		expect(getModelOverride("model", "gpt-6-astra")).toBeUndefined();
	});

	test("an unknown model can only be set for its provider entry", async () => {
		const [info] = await describeModels("codex:not-a-catalog-model-xyz");
		expect(info?.catalogModelId).toBeUndefined();
		expect(info?.modelWideEditable).toBe(false);
		expect((await setWindow("connection", "codex:not-a-catalog-model-xyz", 64_000)).status).toBe(
			200,
		);
		expect(getModelContextWindow("not-a-catalog-model-xyz", "codex")).toBe(64_000);
		const rejected = await setWindow("model", "not-a-catalog-model-xyz", 64_000);
		expect(rejected.status).toBe(400);
		expect(await rejected.json()).toMatchObject({ code: "INVALID_OVERRIDE", field: "key" });
	});

	test("rejects out-of-range values and malformed keys with the offending field", async () => {
		for (const value of [0, 1.5, 200_000_000]) {
			const response = await setWindow("connection", "codex:gpt-6-astra", value);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				code: "INVALID_OVERRIDE",
				field: "contextWindow",
			});
		}
		const bare = await setWindow("connection", "gpt-6-astra", 272_000);
		expect(bare.status).toBe(400);
		expect(await bare.json()).toMatchObject({ field: "key" });
		expect(getModelOverride("connection", "codex:gpt-6-astra")).toBeUndefined();
		// A trimmed key names the same entry.
		expect((await setWindow("connection", " codex:gpt-6-astra", 272_000)).status).toBe(200);
		expect(getModelOverride("connection", "codex:gpt-6-astra")).toEqual({ contextWindow: 272_000 });
	});

	test("an entry's own window coexists with a model-wide override of other fields", async () => {
		const model = "codex:gpt-6-astra";
		expect(
			(
				await putOverride("model", "gpt-6-astra", {
					maxOutputTokens: 64_000,
					contextWindow: 500_000,
				})
			).status,
		).toBe(200);
		const response = await setWindow("connection", model, 272_000);
		expect(response.status).toBe(200);
		expect(getModelContextWindow("gpt-6-astra", "codex")).toBe(272_000);
		const profile = getEffectiveModelProfile(model);
		expect(profile.maxOutputTokens).toBe(64_000);
		expect(profile.contextWindowSource).toMatchObject({ layer: "local-connection", id: model });
		// What clearing the entry's own window would leave.
		expect(getEffectiveModelProfile(model, { own: false }).contextWindow).toBe(500_000);
		// Saving with `model` returns that entry re-described.
		const echoed = (await (
			await putOverride("connection", model, { contextWindow: 300_000 }, model)
		).json()) as ModelDescription;
		expect(echoed).toMatchObject({
			model,
			effective: {
				contextWindow: { value: 300_000, origin: "connection" },
				maxOutputTokens: { value: 64_000, origin: "model" },
			},
		});
	});

	test("follows the model value when its gateway route resolves differently later", async () => {
		const nug = {
			id: "window-nug",
			name: "Gateway",
			prefix: "gw",
			apiKey: "unused",
			baseUrl: "https://gateway.invalid",
			defaultModel: "",
		};
		const draft = structuredClone(settings);
		draft.nugProviders = [nug];
		saveSettings(draft);
		const model = "gw:chan:gpt-6-astra";
		// Saved before the gateway's model list is cached.
		expect((await setWindow("connection", model, 272_000)).status).toBe(200);
		setNugCachedModels(nug.id, [
			{
				id: "chan:gpt-6-astra",
				model: "gpt-6-astra",
				channel: "chan",
				channelType: "codex",
				contextLength: 1_050_000,
			},
		]);
		expect(getEffectiveModelCard(model).resolvedQuery).toEqual({
			upstreamModelId: "gpt-6-astra",
			providerKey: "codex",
		});
		expect(getModelContextWindow("chan:gpt-6-astra", "gw")).toBe(272_000);
		expect(getEffectiveModelProfile(model, { own: false }).contextWindowSource?.layer).toBe(
			"discovered",
		);
		const [info] = await describeModels(model);
		expect(info?.effective.contextWindow).toEqual({ value: 272_000, origin: "connection" });
	});

	test("an older inline layer is imported into provider-entry windows on load", () => {
		const model = "codex:gpt-6-astra";
		const stored = JSON.parse(readFileSync(path, "utf8"));
		stored.customApiProviders = [
			{
				id: "astra-relay",
				name: "Astra relay",
				prefix: "ar",
				protocol: "completions-compatible",
				baseUrl: "https://relay.invalid/v1",
				apiKey: "unused",
				defaultModel: "",
			},
		];
		stored.agent.modelCatalog = {
			schemaVersion: 2,
			migrationVersion: 2,
			autoApply: false,
			pinnedVersion: null,
			local: {
				revision: 4,
				connections: { "openai:gpt-6-astra": { working_context_tokens: 128_000 } },
				bindings: [
					// Provider-page windows from older builds, named after the model value.
					{
						id: `legacy-window:${model}`,
						upstreamModelId: "gpt-6-astra",
						providerId: "codex",
						modelId: "gpt-6-astra",
						overrides: { working_context_tokens: 272_000 },
					},
					// A catalog-editor binding named its provider entry by id.
					{
						id: "astra-editor",
						upstreamModelId: "gpt-6-astra",
						providerId: "astra-relay",
						modelId: "gpt-6-astra",
						overrides: { max_output_tokens: 64_000 },
					},
				],
				overrides: [
					{ target: "model", targetId: "gpt-6-astra", metadata: { max_input_tokens: 500_000 } },
				],
			},
		};
		writeFileSync(path, JSON.stringify(stored));
		const loaded = reloadSettings();
		expect(loaded.agent.modelCatalog).toEqual({ autoUpdate: true });
		expect(getModelOverride("connection", model)).toEqual({ contextWindow: 272_000 });
		expect(getModelOverride("connection", "openai:gpt-6-astra")).toEqual({
			contextWindow: 128_000,
		});
		expect(getModelOverride("connection", "ar:gpt-6-astra")).toEqual({ maxOutputTokens: 64_000 });
		expect(getModelOverride("model", "gpt-6-astra")).toEqual({ contextWindow: 500_000 });
		expect(getModelContextWindow("gpt-6-astra", "codex")).toBe(272_000);
		expect(getModelContextWindow("gpt-6-astra", "anthropic")).toBe(500_000);
		// The migrated document is written back holding only the preference.
		const disk = JSON.parse(readFileSync(path, "utf8"));
		expect(disk.agent.modelCatalog).toEqual({ autoUpdate: true });
	});

	test("a settings save never drops or resurrects override edits", async () => {
		expect((await setWindow("connection", "old:m", 64_000)).status).toBe(200);
		// A settings PATCH copies live settings, then awaits other work before saving it;
		// the copy may even carry an older inline catalog layer.
		const draft = structuredClone(settings);
		(draft.agent as { modelCatalog?: unknown }).modelCatalog = {
			schemaVersion: 2,
			local: { revision: 1, connections: { "old:m": { working_context_tokens: 1_000 } } },
		};
		// Meanwhile the provider page saves a window.
		expect((await setWindow("connection", "codex:gpt-6-astra", 272_000)).status).toBe(200);
		const before = getModelOverridesRevision();
		saveSettings(draft);
		expect(getModelOverride("connection", "codex:gpt-6-astra")?.contextWindow).toBe(272_000);
		expect(getModelOverride("connection", "old:m")?.contextWindow).toBe(64_000);
		expect(getModelOverridesRevision()).toBe(before);
		expect(Object.keys(settings.agent.modelCatalog ?? {})).toEqual(["autoUpdate"]);
		expect(getModelContextWindow("gpt-6-astra", "codex")).toBe(272_000);
	});

	test("prefix rewrites move entry overrides and refuse collisions before writing", async () => {
		expect((await setWindow("connection", "old:m", 64_000)).status).toBe(200);
		expect((await setWindow("connection", "old:n", 32_000)).status).toBe(200);
		expect((await setWindow("connection", "new:n", 16_000)).status).toBe(200);
		const rename = (model: string) => (model.startsWith("old:") ? `new:${model.slice(4)}` : model);
		const revision = getModelOverridesRevision();
		expect(() => rewriteConnectionOverrides(rename, { dryRun: true })).toThrow("would both become");
		expect(() => rewriteConnectionOverrides(rename)).toThrow("would both become");
		expect(getModelOverridesRevision()).toBe(revision);
		expect(getModelOverride("connection", "old:m")?.contextWindow).toBe(64_000);

		expect((await setWindow("connection", "new:n", null)).status).toBe(200);
		expect(rewriteConnectionOverrides(rename, { dryRun: true })).toBe(true);
		expect(getModelOverride("connection", "old:m")?.contextWindow).toBe(64_000);
		expect(rewriteConnectionOverrides(rename)).toBe(true);
		expect(getModelOverride("connection", "new:m")?.contextWindow).toBe(64_000);
		expect(getModelOverride("connection", "new:n")?.contextWindow).toBe(32_000);
		expect(getModelOverride("connection", "old:m")).toBeUndefined();
		// Dropping returns null.
		expect(rewriteConnectionOverrides((model) => (model === "new:m" ? null : model))).toBe(true);
		expect(getModelOverride("connection", "new:m")).toBeUndefined();
		expect(rewriteConnectionOverrides((model) => model)).toBe(false);
	});

	test("a listing-reported window is discovered metadata, below both user scopes", async () => {
		registerListingWindows((model) => (model === "codex:gpt-6-astra" ? 900_000 : undefined));
		const model = "codex:gpt-6-astra";
		expect(getModelContextWindow("gpt-6-astra", "codex")).toBe(900_000);
		expect(getEffectiveModelProfile(model).contextWindowSource?.layer).toBe("discovered");
		expect((await setWindow("model", "gpt-6-astra", 400_000)).status).toBe(200);
		expect(getModelContextWindow("gpt-6-astra", "codex")).toBe(400_000);
		expect((await setWindow("connection", model, 272_000)).status).toBe(200);
		expect(getModelContextWindow("gpt-6-astra", "codex")).toBe(272_000);
		// Clearing the entry's own value is not undone by the listing.
		expect((await setWindow("connection", model, null)).status).toBe(200);
		expect(getModelContextWindow("gpt-6-astra", "codex")).toBe(400_000);
		expect(getModelOverride("connection", model)).toBeUndefined();
	});
});
