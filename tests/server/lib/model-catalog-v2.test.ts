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
	getModelCardSnapshot,
	keepLatestCatalog,
	type ModelCatalogSettings,
	mutateModelCard,
	normalizeModelCatalogSettings,
	resolveEffectiveModelCard,
	setModelWindow,
} from "../../../server/lib/model-catalog";
import { _bindSettings, getDefaults, saveSettings, settings } from "../../../server/lib/settings";
import type { NarraForkSettings } from "../../../server/lib/settings/types";
import { modelCatalogRoutes } from "../../../server/routes/model-catalog";
import type { AuthSessionStore } from "../../../server/services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../../server/services/auth/store";

let local: NarraForkSettings;
let persisted: string | undefined;
const future = { flags: [0, false, null, []], units: "source-defined" };

/**
 * The v2 mutate route runs the real `requireAdmin`, which authorizes against the LIVE role
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
	local.agent.modelCatalog = {
		schemaVersion: 2,
		migrationVersion: 2,
		autoApply: false,
		pinnedVersion: null,
		local: {
			revision: 7,
			models: [
				{
					id: "local-image",
					name: "Image",
					metadata: {
						mode: "image_generation",
						input_cost_per_token: 0,
						output_cost_per_image: 0.04,
						future,
					},
				},
			],
		},
	} as unknown as ModelCatalogSettings;
	persisted = undefined;
	bindModelCatalogSettings(local, () => {
		persisted = JSON.stringify(local);
	});
	_bindSettings(local);
});
afterEach(() => {
	setAuthStores(undefined);
	bindModelCatalogSettings(settings, () => saveSettings(settings));
	_bindSettings(settings);
});
const revision = () => getModelCardSnapshot().local.revision;
const model = () => getModelCardSnapshot().local.models!.find((m) => m.id === "local-image")!;
const patch = (set: Record<string, string | number | boolean | null>) =>
	mutateModelCard({
		baseRevision: revision(),
		action: "patch",
		target: "model",
		targetId: "local-image",
		patch: { set },
	});

test("persists one raw v2 source and reloads all unknown fields", () => {
	patch({ supports_vision: false });
	const saved = JSON.parse(persisted!);
	expect(saved.agent.modelCatalog.schemaVersion).toBe(2);
	const raw = saved.agent.modelCatalog.local.models[0];
	expect(raw.rawMetadata).toBeUndefined();
	expect(raw.metadata.referencePricing).toBeUndefined();
	expect(raw.metadata.future).toEqual(future);
	expect(raw.metadata.output_cost_per_image).toBe(0.04);
	expect(raw.metadata.supports_vision).toBe(false);
	const before = getModelCardSnapshot();
	bindModelCatalogSettings(saved, () => {
		throw new Error("reload must not remigrate");
	});
	expect(getModelCardSnapshot().local).toEqual(before.local);
});

test("field patches and replacement-shaped upserts retain prices and unknown attributes", () => {
	patch({ input_cost_per_token: "0.000001" });
	expect(model().metadata.input_cost_per_token).toBe("0.000001");
	expect(model().metadata.output_cost_per_image).toBe(0.04);
	expect(model().metadata.future).toEqual(future);
	mutateModelCard({
		baseRevision: revision(),
		action: "upsert-model",
		model: { ...model(), name: "Renamed" },
	});
	expect(model().name).toBe("Renamed");
	expect(model().metadata.future).toEqual(future);
	expect(model().metadata.output_cost_per_image).toBe(0.04);
	expect(getModelCardSnapshot().local.overrides).toEqual([]);
});

test("no-op, stale revision, unsafe writes and persistence failure do not publish", () => {
	patch({ supports_vision: false });
	const before = getModelCardSnapshot();
	patch({ supports_vision: false });
	expect(revision()).toBe(before.local.revision);
	expect(() =>
		mutateModelCard({
			baseRevision: 0,
			action: "patch",
			target: "model",
			targetId: "local-image",
			patch: { set: { supports_vision: true } },
		}),
	).toThrow("changed");
	expect(() => patch({ "future.units": "changed" })).toThrow();
	expect(() => patch({ billingMultiplier: 5 })).toThrow();
	bindModelCatalogSettings(local, () => {
		throw new Error("disk full");
	});
	expect(() => patch({ supports_vision: true })).toThrow("disk full");
	expect(getModelCardSnapshot().local).toEqual(before.local);
});

test("independent input and output caps remain valid through write, read and reload", () => {
	mutateModelCard({
		baseRevision: revision(),
		action: "upsert-model",
		model: {
			id: "independent-caps",
			metadata: { mode: "responses", max_input_tokens: 128000, max_output_tokens: 272000 },
		},
	});
	const m = getModelCardSnapshot().local.models!.find((m) => m.id === "independent-caps")!;
	expect(m.metadata.max_input_tokens).toBe(128000);
	expect(m.metadata.max_output_tokens).toBe(272000);
	expect(getEffectiveModelProfile("independent-caps").maxOutputTokens).toBe(272000);
	bindModelCatalogSettings(JSON.parse(persisted!), () => {});
	expect(
		getModelCardSnapshot().local.models!.find((m) => m.id === "independent-caps")!.metadata,
	).toEqual(m.metadata);
});

test("input and output budgets stay separate and never invent a total context", () => {
	mutateModelCard({
		baseRevision: revision(),
		action: "upsert-model",
		model: {
			id: "budget-model",
			metadata: { mode: "responses", max_input_tokens: 128000, max_output_tokens: 272000 },
		},
	});
	const budgets = modelTokenBudgets("budget-model");
	expect(budgets).toEqual({ maxInputTokens: 128000, maxOutputTokens: 272000 });
	// No declared total context: the output ask is capped only by the output ceiling,
	// and a large prompt cannot be used to derive a combined limit.
	expect(resolveOutputTokenBudget(budgets, 300000, 120000)).toBe(272000);
	expect(resolveInputTokenBudget(budgets, 272000)).toBe(128000);

	// A declared total context does constrain both directions.
	mutateModelCard({
		baseRevision: revision(),
		action: "upsert-model",
		model: {
			id: "total-model",
			metadata: {
				mode: "responses",
				context_window: 200000,
				max_input_tokens: 190000,
				max_output_tokens: 64000,
				working_context_tokens: 150000,
			},
		},
	});
	const total = modelTokenBudgets("total-model");
	expect(resolveInputTokenBudget(total, 64000)).toBe(136000);
	expect(resolveOutputTokenBudget(total, 64000, 180000)).toBe(20000);
	// The working window is a local budget, so it never becomes an output ceiling.
	expect(resolveOutputTokenBudget(total, 64000)).toBe(64000);

	// An explicitly unknown limit is not a zero budget and not a constraint.
	mutateModelCard({
		baseRevision: revision(),
		action: "upsert-model",
		model: { id: "unknown-model", metadata: { mode: "chat", max_output_tokens: null } },
	});
	const unknown = modelTokenBudgets("unknown-model");
	expect(unknown).toEqual({});
	expect(resolveOutputTokenBudget(unknown, 8000)).toBe(8000);
	expect(resolveInputTokenBudget(unknown)).toBeUndefined();
});

test("working_context_tokens is the prompt window: it never caps output or replaces the total", () => {
	mutateModelCard({
		baseRevision: revision(),
		action: "upsert-model",
		model: {
			id: "working-window",
			metadata: {
				mode: "responses",
				working_context_tokens: 150000,
				max_output_tokens: 320000,
			},
		},
	});
	// The working window is this instance's prompt budget; the output ceiling stays
	// independent of it.
	const profile = getEffectiveModelProfile("working-window");
	expect(profile.maxOutputTokens).toBe(320000);
	expect(profile.contextWindow).toBe(150000);
	expect(profile.contextWindowSource?.key).toBe("working_context_tokens");
	// Budgets keep the three facts distinct.
	const budgets = modelTokenBudgets("working-window");
	expect(budgets).toEqual({ maxOutputTokens: 320000, workingContextTokens: 150000 });
	expect(resolveOutputTokenBudget(budgets, 400000)).toBe(320000);

	mutateModelCard({
		baseRevision: revision(),
		action: "upsert-model",
		model: {
			id: "working-plus-total",
			metadata: {
				mode: "responses",
				context_window: 400000,
				working_context_tokens: 150000,
				max_output_tokens: 320000,
			},
		},
	});
	// The working window is still the prompt window; the total remains its own fact.
	const withTotal = getEffectiveModelProfile("working-plus-total");
	expect(withTotal.contextWindow).toBe(150000);
	expect(withTotal.maxOutputTokens).toBe(320000);
	expect(modelTokenBudgets("working-plus-total")).toEqual({
		maxOutputTokens: 320000,
		totalContextTokens: 400000,
		workingContextTokens: 150000,
	});

	// A total context still clamps an oversized output (same total semantics).
	mutateModelCard({
		baseRevision: revision(),
		action: "upsert-model",
		model: {
			id: "legacy-total-clamp",
			metadata: {
				mode: "chat",
				legacy_context_window: 100000,
				max_output_tokens: 200000,
			},
		},
	});
	expect(getEffectiveModelProfile("legacy-total-clamp").maxOutputTokens).toBe(100000);
});

test("v2 writes are admin-only, return v2 conflicts and enforce body limits", async () => {
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
	const body = JSON.stringify({
		baseRevision: revision(),
		action: "patch",
		target: "model",
		targetId: "local-image",
		patch: { set: { supports_vision: false } },
	});
	const init = { method: "POST", headers: { "content-type": "application/json" }, body };
	expect((await app("user").request("/api/model-catalog/v2/mutate", init)).status).toBe(403);
	const saved = await app("admin").request("/api/model-catalog/v2/mutate", init);
	expect(saved.status).toBe(200);
	expect((await saved.json()).schemaVersion).toBe(2);
	const conflict = await app("admin").request("/api/model-catalog/v2/mutate", init);
	expect(conflict.status).toBe(409);
	expect((await conflict.json()).snapshot.schemaVersion).toBe(2);
	expect(
		(
			await app("admin").request("/api/model-catalog/v2/mutate", {
				...init,
				body: " ".repeat(1024 * 1024 + 1),
			})
		).status,
	).toBe(413);
});

// The provider page writes a provider entry's own window by its model value; nothing
// beside the catalog stores it.
test("provider-entry windows are stored by model value and reset only their own key", () => {
	setModelWindow({
		baseRevision: revision(),
		scope: "connection",
		target: "foxcx:gpt-5.4",
		contextWindow: 300000,
	});
	const stored = getModelCardSnapshot().local;
	expect(stored.revision).toBe(8);
	expect(stored.connections).toEqual({ "foxcx:gpt-5.4": { working_context_tokens: 300000 } });
	expect(JSON.parse(persisted!).agent).not.toHaveProperty("modelContextWindows");
	mutateModelCard({
		baseRevision: revision(),
		action: "patch",
		target: "connection",
		targetId: "foxcx:gpt-5.4",
		patch: { set: { max_output_tokens: 4096 } },
	});
	setModelWindow({
		baseRevision: revision(),
		scope: "connection",
		target: "foxcx:gpt-5.4",
		contextWindow: null,
	});
	expect(getModelCardSnapshot().local.connections).toEqual({
		"foxcx:gpt-5.4": { max_output_tokens: 4096 },
	});
	expect(() =>
		mutateModelCard({
			baseRevision: revision(),
			action: "hide",
			target: "connection",
			targetId: "foxcx:gpt-5.4",
		}),
	).toThrow();
});

test("an old window map imports beside editor bindings and never stops startup", () => {
	const stored = getDefaults();
	stored.agent.modelCatalog = {
		schemaVersion: 2,
		migrationVersion: 2,
		autoApply: false,
		pinnedVersion: null,
		local: {
			revision: 3,
			bindings: [
				{
					id: "editor-binding",
					providerId: "codex",
					upstreamModelId: "gpt-5.5",
					overrides: { max_output_tokens: 1000 },
				},
			],
		},
	};
	(stored.agent as Record<string, unknown>).modelContextWindows = {
		"codex:gpt-5.5": 150000,
		"codex:gpt-5.4": "200000",
	};
	expect(normalizeModelCatalogSettings(stored)).toBe(true);
	const local = stored.agent.modelCatalog!.local;
	expect(local.bindings).toEqual([
		{
			id: "editor-binding",
			providerId: "codex",
			upstreamModelId: "gpt-5.5",
			overrides: { max_output_tokens: 1000 },
		},
	]);
	expect(local.connections).toEqual({
		"codex:gpt-5.5": { working_context_tokens: 150000 },
		"codex:gpt-5.4": { working_context_tokens: 200000 },
	});
	expect(stored.agent).not.toHaveProperty("modelContextWindows");
	bindModelCatalogSettings(stored, () => {});
	expect(getEffectiveModelProfile("codex:gpt-5.5")).toMatchObject({
		contextWindow: 150000,
		maxOutputTokens: 1000,
	});

	const preCatalog = getDefaults();
	delete preCatalog.agent.modelCatalog;
	(preCatalog.agent as Record<string, unknown>).modelContextWindows = {
		"codex:gpt-5.5": "120000",
	};
	expect(() => normalizeModelCatalogSettings(preCatalog)).not.toThrow();
	expect(preCatalog.agent.modelCatalog!.local.connections).toEqual({
		"codex:gpt-5.5": { working_context_tokens: 120000 },
	});
	expect(preCatalog.agent.modelCatalog!.local.legacyFields).toMatchObject({
		"connection:codex:gpt-5.5": ["working_context_tokens"],
	});
	expect(preCatalog.agent).not.toHaveProperty("modelContextWindows");
});

test("a settings save from a copy taken before a catalog edit does not undo the edit", () => {
	const stale = structuredClone(local);
	patch({ supports_vision: false });
	keepLatestCatalog(stale);
	const live = stale.agent.modelCatalog!.local;
	expect(live.revision).toBe(revision());
	expect(live.models!.find((m) => m.id === "local-image")!.metadata.supports_vision).toBe(false);
	// A document assembled without the catalog keeps the live one too.
	const bare = getDefaults();
	delete bare.agent.modelCatalog;
	keepLatestCatalog(bare);
	expect(bare.agent.modelCatalog === local.agent.modelCatalog).toBe(true);
});

test("gateway metadata that contradicts the catalog is ignored rather than failing requests", () => {
	const query = { upstreamModelId: "gpt-5.5", providerKey: "codex" };
	const card = resolveEffectiveModelCard(query, { context_window: 1000 });
	expect(card.metadata.context_window).toBeUndefined();
	expect(card.metadata.max_output_tokens).toBeGreaterThan(1000);
	expect(resolveEffectiveModelCard(query, { context_window: 900000 }).metadata.context_window).toBe(
		900000,
	);
});
