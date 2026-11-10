import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import {
	modelTokenBudgets,
	resolveInputTokenBudget,
	resolveOutputTokenBudget,
} from "../../../server/lib/agent/provider-model-metadata";
import {
	bindModelCatalogSettings,
	getEffectiveModelProfile,
	getModelOverride,
	keepModelCatalogSettings,
	migrateModelCatalogSettings,
	replaceModelOverridesForTests,
	resolveEffectiveModelCard,
	setModelCatalogAutoUpdate,
	setModelOverride,
} from "../../../server/lib/model-catalog";
import { _bindSettings, getDefaults, saveSettings, settings } from "../../../server/lib/settings";
import type { NarraForkSettings } from "../../../server/lib/settings/types";
import { modelCatalogRoutes } from "../../../server/routes/model-catalog";
import type { AuthSessionStore } from "../../../server/services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../../server/services/auth/store";

let local: NarraForkSettings;
let persisted: string | undefined;
let restoreOverrides: () => void = () => {};

/**
 * The override route runs the real `requireAdmin`, which authorizes against the LIVE role
 * read through the session store, never the token's `role` claim. The admin-only test seeds
 * its principal with `c.get("user")` only, so this seam makes the store resolve the role by
 * actor id (the two principals carry distinct subs below). Without it the lookup would hit
 * the real (empty) database and 401 USER_GONE instead of 403/200.
 */
const CATALOG_ADMIN_ID = "catalog-admin";
const CATALOG_USER_ID = "catalog-user";
beforeEach(() => {
	const store: AuthSessionStore = {
		...authSessionStore,
		findSessionState: async (id) => ({
			id,
			role: id === CATALOG_ADMIN_ID ? "admin" : "user",
			tokenVersion: 0,
		}),
	};
	setAuthStores({ session: store, mfa: authMfaStore });
	local = getDefaults();
	local.agent.modelCatalog = { autoUpdate: true };
	persisted = undefined;
	bindModelCatalogSettings(local, () => {
		persisted = JSON.stringify(local);
	});
	_bindSettings(local);
	restoreOverrides = replaceModelOverridesForTests({});
});
afterEach(() => {
	restoreOverrides();
	setAuthStores(undefined);
	bindModelCatalogSettings(settings, () => saveSettings(settings));
	_bindSettings(settings);
});

/** An older settings.json with its overrides inline in `agent.modelCatalog.local`. */
function legacyDocument(localLayer: Record<string, unknown>): NarraForkSettings {
	const stored = getDefaults();
	(stored.agent as Record<string, unknown>).modelCatalog = {
		schemaVersion: 2,
		migrationVersion: 2,
		autoApply: false,
		pinnedVersion: null,
		local: { revision: 3, ...localLayer },
	};
	return stored;
}

test("input and output budgets stay separate and never invent a total context", () => {
	// gpt-5-pro declares an input ceiling below its output ceiling and no total.
	const budgets = modelTokenBudgets("openai:gpt-5-pro");
	expect(budgets).toEqual({ maxInputTokens: 128000, maxOutputTokens: 272000 });
	// No declared total context: the output ask is capped only by the output ceiling,
	// and a large prompt cannot be used to derive a combined limit.
	expect(resolveOutputTokenBudget(budgets, 300000, 120000)).toBe(272000);
	expect(resolveInputTokenBudget(budgets, 272000)).toBe(128000);

	// gpt-6.1-terra declares a total context; the entry adds its own working window.
	setModelOverride("connection", "openai:gpt-6.1-terra", { contextWindow: 150000 });
	const total = modelTokenBudgets("openai:gpt-6.1-terra");
	expect(total).toEqual({
		maxInputTokens: 922000,
		maxOutputTokens: 128000,
		totalContextTokens: 1050000,
		workingContextTokens: 150000,
	});
	expect(resolveInputTokenBudget(total, 128000)).toBe(150000);
	expect(resolveOutputTokenBudget(total, 128000, 1_000_000)).toBe(50000);
	// The working window is a local budget, so it never becomes an output ceiling.
	expect(resolveOutputTokenBudget(total, 128000)).toBe(128000);

	// Nothing declared is not a zero budget and not a constraint.
	const unknown = modelTokenBudgets("openai:not-a-catalog-model-xyz");
	expect(unknown).toEqual({});
	expect(resolveOutputTokenBudget(unknown, 8000)).toBe(8000);
	expect(resolveInputTokenBudget(unknown)).toBeUndefined();
});

test("an entry's context window is the prompt window: it never caps output or replaces the total", () => {
	setModelOverride("connection", "openai:working-window", {
		contextWindow: 150000,
		maxOutputTokens: 320000,
	});
	// The working window is this instance's prompt budget; the output ceiling stays
	// independent of it.
	const profile = getEffectiveModelProfile("openai:working-window");
	expect(profile.maxOutputTokens).toBe(320000);
	expect(profile.contextWindow).toBe(150000);
	expect(profile.contextWindowSource?.key).toBe("working_context_tokens");
	// Budgets keep the three facts distinct.
	const budgets = modelTokenBudgets("openai:working-window");
	expect(budgets).toEqual({ maxOutputTokens: 320000, workingContextTokens: 150000 });
	expect(resolveOutputTokenBudget(budgets, 400000)).toBe(320000);
});

test("an entry's oversized output under a catalog total is clamped, not a request failure", () => {
	// Over a catalog total, the working window is still the prompt window and the total
	// remains its own fact, which still holds an oversized output.
	setModelOverride("connection", "openai:gpt-6.1-terra", {
		contextWindow: 150000,
		maxOutputTokens: 2_000_000,
	});
	const withTotal = getEffectiveModelProfile("openai:gpt-6.1-terra");
	expect(withTotal.contextWindow).toBe(150000);
	expect(withTotal.maxOutputTokens).toBe(1050000);
	expect(modelTokenBudgets("openai:gpt-6.1-terra")).toMatchObject({
		totalContextTokens: 1050000,
		workingContextTokens: 150000,
	});
});

test("override writes are admin-only, validate fields and enforce body limits", async () => {
	const app = (role: "admin" | "user") => {
		const app = new Hono();
		app.use("*", async (c, next) => {
			const sub = role === "admin" ? CATALOG_ADMIN_ID : CATALOG_USER_ID;
			c.set("user", { sub, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
			await next();
		});
		app.route("/api/model-catalog", modelCatalogRoutes);
		return app;
	};
	const request = (body: unknown) => ({
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	const body = {
		scope: "connection",
		key: "codex:gpt-5.5",
		fields: { nativeSearch: false },
		model: "codex:gpt-5.5",
	};
	expect((await app("user").request("/api/model-catalog/overrides", request(body))).status).toBe(
		403,
	);
	expect(getModelOverride("connection", "codex:gpt-5.5")).toBeUndefined();
	const saved = await app("admin").request("/api/model-catalog/overrides", request(body));
	expect(saved.status).toBe(200);
	expect(await saved.json()).toMatchObject({
		model: "codex:gpt-5.5",
		connectionOverride: { nativeSearch: false },
		effective: { nativeSearch: { value: false, origin: "connection" } },
	});
	const invalid = await app("admin").request(
		"/api/model-catalog/overrides",
		request({ ...body, fields: { reasoningLevels: ["low"], defaultReasoningLevel: "high" } }),
	);
	expect(invalid.status).toBe(400);
	expect(await invalid.json()).toMatchObject({
		code: "INVALID_OVERRIDE",
		field: "defaultReasoningLevel",
	});
	expect(getModelOverride("connection", "codex:gpt-5.5")).toEqual({ nativeSearch: false });
	expect(
		(
			await app("admin").request(
				"/api/model-catalog/overrides",
				request(" ".repeat(256 * 1024 + 1)),
			)
		).status,
	).toBe(413);
	// The models page reads descriptions without admin rights.
	const described = await app("user").request("/api/model-catalog/models", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ models: ["codex:gpt-5.5"] }),
	});
	expect(described.status).toBe(200);
});

// The provider page writes a provider entry's override by its model value; nothing in
// settings.json stores it.
test("provider-entry overrides are stored by model value and clear only their own key", () => {
	setModelOverride("connection", "foxcx:gpt-5.4", { contextWindow: 300000 });
	setModelOverride("connection", "foxcx:gpt-5.5", { contextWindow: 200000 });
	expect(persisted).toBeUndefined();
	// Saving an entry replaces its fields as a whole.
	setModelOverride("connection", "foxcx:gpt-5.4", { maxOutputTokens: 4096 });
	expect(getModelOverride("connection", "foxcx:gpt-5.4")).toEqual({ maxOutputTokens: 4096 });
	setModelOverride("connection", "foxcx:gpt-5.4", null);
	expect(getModelOverride("connection", "foxcx:gpt-5.4")).toBeUndefined();
	expect(getModelOverride("connection", "foxcx:gpt-5.5")).toEqual({ contextWindow: 200000 });
	// An empty override is the same as none.
	setModelOverride("connection", "foxcx:gpt-5.5", {});
	expect(getModelOverride("connection", "foxcx:gpt-5.5")).toBeUndefined();
});

test("an older inline layer becomes typed overrides and only the preference stays", () => {
	const stored = legacyDocument({
		connections: { "codex:gpt-5.5": { working_context_tokens: 150000, mode: "chat" } },
		overrides: [
			{
				target: "model",
				targetId: "gpt-5.5",
				metadata: { max_output_tokens: 1000, input_cost_per_token: 0.000002 },
			},
		],
		models: [{ id: "local-image", metadata: { mode: "image_generation" } }],
	});
	expect(migrateModelCatalogSettings(stored)).toBe(true);
	expect(stored.agent.modelCatalog).toEqual({ autoUpdate: true });
	expect(getModelOverride("connection", "codex:gpt-5.5")).toEqual({ contextWindow: 150000 });
	expect(getModelOverride("model", "gpt-5.5")).toEqual({
		maxOutputTokens: 1000,
		prices: { input: "2" },
	});
	expect(getEffectiveModelProfile("codex:gpt-5.5")).toMatchObject({
		contextWindow: 150000,
		maxOutputTokens: 1000,
	});
	// The current shape is left alone.
	expect(migrateModelCatalogSettings(stored)).toBe(false);
});

test("a pre-catalog window map imports and never stops startup", () => {
	const preCatalog = getDefaults();
	delete preCatalog.agent.modelCatalog;
	(preCatalog.agent as Record<string, unknown>).modelContextWindows = {
		"codex:gpt-5.5": 120000,
		"codex:broken": { nested: true },
	};
	expect(() => migrateModelCatalogSettings(preCatalog)).not.toThrow();
	expect(getModelOverride("connection", "codex:gpt-5.5")).toEqual({ contextWindow: 120000 });
	expect(getModelOverride("connection", "codex:broken")).toBeUndefined();
	expect(preCatalog.agent).not.toHaveProperty("modelContextWindows");
	expect(preCatalog.agent.modelCatalog as unknown).toEqual({ autoUpdate: true });
});

test("numeric-string windows in an old window map are imported", () => {
	// Older builds accepted hand-edited windows written as strings.
	const preCatalog = getDefaults();
	delete preCatalog.agent.modelCatalog;
	(preCatalog.agent as Record<string, unknown>).modelContextWindows = {
		"codex:gpt-5.4": "200000",
	};
	migrateModelCatalogSettings(preCatalog);
	expect(getModelOverride("connection", "codex:gpt-5.4")).toEqual({ contextWindow: 200000 });
});

test("an editor binding for a built-in provider becomes that entry's override", () => {
	// Older queries named a built-in provider by its prefix (`providerId: "codex"`).
	const stored = legacyDocument({
		bindings: [
			{
				id: "editor-binding",
				providerId: "codex",
				upstreamModelId: "gpt-5.5",
				overrides: { max_output_tokens: 1000 },
			},
		],
	});
	migrateModelCatalogSettings(stored);
	expect(getModelOverride("connection", "codex:gpt-5.5")).toEqual({ maxOutputTokens: 1000 });
});

test("a gateway channel binding becomes the override of its full model value", () => {
	// A gateway binding named the channel apart from the bare upstream model.
	const stored = legacyDocument({
		bindings: [
			{
				id: "gateway-binding",
				providerId: "gw-id",
				channelId: "chan",
				upstreamModelId: "gpt-6-astra",
				overrides: { max_output_tokens: 101 },
			},
		],
	});
	stored.nugProviders = [
		{
			id: "gw-id",
			name: "Gateway",
			prefix: "gw",
			apiKey: "unused",
			baseUrl: "https://gateway.invalid",
			defaultModel: "",
		},
	];
	migrateModelCatalogSettings(stored);
	expect(getModelOverride("connection", "gw:chan:gpt-6-astra")).toEqual({ maxOutputTokens: 101 });
	expect(getModelOverride("connection", "gw:gpt-6-astra")).toBeUndefined();
});

test("a settings save from a copy taken before a preference change does not undo it", () => {
	const stale = structuredClone(local);
	setModelCatalogAutoUpdate(false);
	expect(JSON.parse(persisted ?? "{}").agent?.modelCatalog).toEqual({ autoUpdate: false });
	keepModelCatalogSettings(stale);
	expect(stale.agent.modelCatalog).toEqual({ autoUpdate: false });
	// A document assembled without the catalog, or carrying an old inline layer, gets the
	// live preference and nothing else.
	const bare = getDefaults();
	delete bare.agent.modelCatalog;
	keepModelCatalogSettings(bare);
	expect(bare.agent.modelCatalog as unknown).toEqual({ autoUpdate: false });
	const old = legacyDocument({ connections: { "codex:gpt-5.5": { working_context_tokens: 1 } } });
	keepModelCatalogSettings(old);
	expect(old.agent.modelCatalog).toEqual({ autoUpdate: false });
	expect(getModelOverride("connection", "codex:gpt-5.5")).toBeUndefined();
});

test("gateway metadata that contradicts the catalog is ignored rather than failing requests", () => {
	const query = { upstreamModelId: "gpt-5.5", providerKey: "codex" };
	const card = resolveEffectiveModelCard(query, { context_window: 1000 });
	expect(() => card.view).not.toThrow();
	expect(card.metadata.context_window).toBeUndefined();
	expect(card.metadata.max_output_tokens).toBeGreaterThan(1000);
	expect(resolveEffectiveModelCard(query, { context_window: 900000 }).metadata.context_window).toBe(
		900000,
	);
});
