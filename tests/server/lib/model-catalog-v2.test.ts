import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import {
	modelTokenBudgets,
	resolveInputTokenBudget,
	resolveOutputTokenBudget,
} from "../../../server/lib/agent/provider-model-metadata";
import {
	bindModelCatalogSettings,
	getEffectiveModelMetadata,
	getModelCardSnapshot,
	getModelCatalogSnapshot,
	type ModelCatalogSettings,
	mutateModelCard,
	mutateModelCatalog,
	reconcileLegacyWindowSettings,
	settingsWithRawModelCatalog,
} from "../../../server/lib/model-catalog";
import { _bindSettings, getDefaults, saveSettings, settings } from "../../../server/lib/settings";
import type { NarraForkSettings } from "../../../server/lib/settings/types";
import { modelCatalogRoutes } from "../../../server/routes/model-catalog";

let local: NarraForkSettings;
let persisted: string | undefined;
const future = { flags: [0, false, null, []], units: "source-defined" };
beforeEach(() => {
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
		persisted = JSON.stringify(settingsWithRawModelCatalog(local));
	});
	_bindSettings(local);
});
afterEach(() => {
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

test("old field patches and replacement-shaped DTOs retain newer prices and attributes", () => {
	mutateModelCatalog({
		baseRevision: revision(),
		action: "patch",
		target: "model",
		targetId: "local-image",
		patch: { set: { "referencePricing.input": "1" } },
	});
	expect(model().metadata.input_cost_per_token).toBe("0.000001");
	expect(model().metadata.output_cost_per_image).toBe(0.04);
	expect(model().metadata.future).toEqual(future);
	const legacy = getModelCatalogSnapshot().local.models!.find((m) => m.id === "local-image")!;
	const { rawMetadata: _raw, ...oldClient } = legacy;
	mutateModelCatalog({
		baseRevision: revision(),
		action: "upsert-model",
		model: { ...oldClient, name: "Renamed" },
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
	expect(getEffectiveModelMetadata("independent-caps").metadata.limits?.maxOutputTokens).toBe(
		272000,
	);
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

test("working_context_tokens never clamps v1 maxOutput and does not overwrite total context", () => {
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
	// v1 projection must keep the independent output ceiling. The working window is
	// not a total context and has nowhere to live in v1, so it is dropped rather than
	// used as an output ceiling.
	const v1 = getEffectiveModelMetadata("working-window").metadata.limits;
	expect(v1?.maxOutputTokens).toBe(320000);
	expect(v1?.contextWindow).toBeUndefined();
	// v2 budgets keep the three facts distinct — contrast with the v1 clamp bug.
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
	// A real total context wins over the working window and may keep a larger output.
	const withTotal = getEffectiveModelMetadata("working-plus-total").metadata.limits;
	expect(withTotal?.contextWindow).toBe(400000);
	expect(withTotal?.maxOutputTokens).toBe(320000);
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
	expect(getEffectiveModelMetadata("legacy-total-clamp").metadata.limits?.maxOutputTokens).toBe(
		100000,
	);
});

test("v2 writes are admin-only, return v2 conflicts and enforce body limits", async () => {
	const app = (role: "admin" | "user") => {
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("user", { sub: "test", role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
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

// Startup migrations (a generated JWT secret, a renamed key) call saveSettings
// while agent.modelCatalog is still the raw v2 document read from disk, because
// bindModelCatalogSettings runs later in the settings module. The legacy window
// editor must stay out of that window: reconciling raw source fields through the
// schema-v1 view rejected them as unknown and made the whole process fail to boot.
test("legacy window reconciliation is inert before the catalog is bound", () => {
	const stored = {
		...getDefaults(),
		agent: {
			...getDefaults().agent,
			modelContextWindows: { "foxcx:gpt-5.4": 256000 },
			modelCatalog: {
				schemaVersion: 2,
				migrationVersion: 2,
				autoApply: false,
				pinnedVersion: null,
				local: {
					revision: 1,
					legacyFields: { "binding:legacy-window:foxcx:gpt-5.4": ["working_context_tokens"] },
					bindings: [
						{
							id: "legacy-window:foxcx:gpt-5.4",
							providerId: "m0hxkfw7",
							upstreamModelId: "gpt-5.4",
							overrides: { working_context_tokens: 256000 },
						},
					],
				},
			},
		},
	} as unknown as NarraForkSettings;
	const before = structuredClone(stored.agent.modelCatalog);
	// _bindSettings/bindModelCatalogSettings deliberately not called for `stored`:
	// this reproduces the pre-bind save, where the raw document must pass through
	// untouched rather than being read as a schema-v1 local layer.
	expect(() => reconcileLegacyWindowSettings(stored)).not.toThrow();
	expect(stored.agent.modelCatalog).toEqual(before);

	// Once bound, the same editor still adapts a real change into the binding.
	bindModelCatalogSettings(stored, () => {});
	stored.agent.modelContextWindows = { "foxcx:gpt-5.4": 300000 };
	reconcileLegacyWindowSettings(stored);
	const binding = stored.agent.modelCatalog!.local.bindings!.find(
		(b) => b.id === "legacy-window:foxcx:gpt-5.4",
	)!;
	expect(binding.rawMetadata).toEqual({ working_context_tokens: 300000 });
});
