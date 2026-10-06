import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
	buildCatalogPatch,
	metadataFromPatch,
} from "../../../frontend/components/settings/model-catalog-form";
import type { ModelCatalogSettings } from "../../../server/lib/model-catalog";
import {
	applyModelCatalogUpdate,
	bindModelCatalogSettings,
	checkModelCatalogUpdate,
	getEffectiveModelCard,
	getEffectiveModelMetadata,
	getModelCatalogSnapshot,
	markLegacyWindowSettingsSaved,
	mutateModelCatalog,
	previewModelCatalogDowngrade,
	reconcileLegacyWindowSettings,
	rollbackModelCatalog,
	saveLegacyModelCard,
	setModelCatalogUpdateSettings,
	withModelMetadataSnapshot,
	withModelMetadataSnapshotIterator,
} from "../../../server/lib/model-catalog";
import {
	CATALOG_ARCHIVE_BASE,
	CATALOG_REVISION_URL,
	MAX_CATALOG_BYTES,
	MAX_CATALOG_REVISION_BYTES,
} from "../../../server/lib/model-catalog/source";
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
	getModelMaxCompletionTokens,
	saveSettings,
	settings,
} from "../../../server/lib/settings";
import type { NarraForkSettings } from "../../../server/lib/settings/types";
import { modelCatalogRoutes } from "../../../server/routes/model-catalog";
import type { ModelCatalogMutation } from "../../../shared/model-catalog/schema/api";
import type { ResolvedModelMetadata } from "../../../shared/model-catalog/schema/catalog";

let local: NarraForkSettings;
let presetContextWindow: number;
const originalFetch = globalThis.fetch;
let restoreVersion: string | undefined;
beforeEach(() => {
	local = getDefaults();
	local.agent.modelCatalog = {
		schemaVersion: 1,
		migrationVersion: 1,
		local: { revision: 0 },
		autoApply: false,
		pinnedVersion: null,
	};
	bindModelCatalogSettings(local, () => {});
	_bindSettings(local);
	const window = getEffectiveModelMetadata("codex:gpt-5.5").metadata.limits?.contextWindow;
	if (typeof window !== "number") throw new Error("Expected GPT-5.5 preset context window");
	presetContextWindow = window;
	restoreVersion = undefined;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (restoreVersion && getModelCatalogSnapshot().catalog.catalogVersion !== restoreVersion)
		rollbackModelCatalog(restoreVersion);
	deleteNugCachedModels("nug-test");
	deleteNugCachedModels("nug-card-test");
	bindModelCatalogSettings(settings, () => saveSettings(settings));
	_bindSettings(settings);
});
function mutate(value: Omit<Extract<ModelCatalogMutation, { action: "patch" }>, "baseRevision">) {
	return mutateModelCatalog({ ...value, baseRevision: getModelCatalogSnapshot().local.revision });
}
function app(role: "admin" | "user" = "admin") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: "catalog-test", role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.route("/api/model-catalog", modelCatalogRoutes);
	return app;
}
async function mockCatalog(
	label: string,
	modify?: (doc: ReturnType<typeof getModelCatalogSnapshot>["catalog"]) => void,
) {
	const catalog = structuredClone(getModelCatalogSnapshot().catalog);
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
				commit: {
					sha: version,
					commit: { committer: { date: catalog.publishedAt } },
				},
			});
		if (String(url) === `${CATALOG_ARCHIVE_BASE}${version}`) return new Response(archive);
		throw new Error(`Unexpected catalog URL: ${url}`);
	}) as unknown as typeof fetch;
	return version;
}

describe("unified metadata storage and runtime", () => {
	test("legacy empty optional card labels do not block startup migration", () => {
		delete local.agent.modelCatalog;
		local.agent.modelCards = [
			{
				modelKey: "custom-empty-label",
				displayName: "",
				family: "",
				notes: "",
				contextWindow: 32000,
			},
		];
		local.agent.modelContextWindows = { "custom-empty-label": 16000 };
		expect(() => bindModelCatalogSettings(local, () => {})).not.toThrow();
		const model = local.agent.modelCatalog!.local.models!.find(
			(m) => m.id === "custom-empty-label",
		);
		expect(model?.name).toBeUndefined();
		expect(model?.family).toBeUndefined();
		expect(model?.notes).toBeUndefined();
		expect(getEffectiveModelMetadata("custom-empty-label").metadata.limits?.contextWindow).toBe(
			16000,
		);
		expect(local.agent.modelCatalog!.legacyArchive?.modelCards[0]?.displayName).toBe("");
	});
	test("new patch changes runtime limits and reset really restores inheritance", () => {
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: {
				set: {
					"limits.contextWindow": 240000,
					"limits.maxOutputTokens": 1234,
					"referencePricing.input": "0",
					"nativeSearch.supported": false,
					"modalities.input": [],
				},
			},
		});
		expect(getModelContextWindow("gpt-5.5", "codex")).toBe(240000);
		expect(getModelMaxCompletionTokens("gpt-5.5", "codex")).toBe(1234);
		expect(getEffectiveModelMetadata("codex:gpt-5.5").metadata.referencePricing?.input).toBe("0");
		expect(getEffectiveModelMetadata("codex:gpt-5.5").metadata.modalities?.input).toEqual([]);
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: { reset: ["limits.contextWindow", "limits.maxOutputTokens"] },
		});
		expect(getModelContextWindow("gpt-5.5", "codex")).toBe(presetContextWindow);
	});
	test("no-op patch does not increment revision; stale patch and invalid effective values fail", () => {
		mutate({ action: "patch", target: "model", targetId: "gpt-5.5", patch: {} });
		expect(getModelCatalogSnapshot().local.revision).toBe(0);
		expect(() =>
			mutate({
				action: "patch",
				target: "model",
				targetId: "gpt-5.5",
				patch: { set: { "limits.contextWindow": 1 } },
			}),
		).toThrow();
		expect(getModelCatalogSnapshot().local.revision).toBe(0);
		expect(() =>
			mutateModelCatalog({
				action: "hide",
				target: "model",
				targetId: "gpt-5.5",
				baseRevision: 123,
			}),
		).toThrow();
	});
	test("failed settings persistence never publishes a local mutation", () => {
		const initial = getModelCatalogSnapshot();
		bindModelCatalogSettings(local, () => {
			throw new Error("disk unavailable");
		});
		expect(() =>
			mutate({
				action: "patch",
				target: "model",
				targetId: "gpt-5.5",
				patch: { set: { "referencePricing.input": "0" } },
			}),
		).toThrow("disk unavailable");
		expect(getModelCatalogSnapshot()).toEqual(initial);
	});
	test("legacy settings window edits create binding patches without re-pinning unchanged inputs", () => {
		local.agent.modelContextWindows = { "codex:gpt-5.5": 230000 };
		reconcileLegacyWindowSettings(local);
		markLegacyWindowSettingsSaved(local);
		expect(getEffectiveModelMetadata("codex:gpt-5.5").metadata.limits?.contextWindow).toBe(230000);
		mutate({
			action: "patch",
			target: "binding",
			targetId: "legacy-window:codex:gpt-5.5",
			patch: { reset: ["limits.contextWindow"] },
		});
		reconcileLegacyWindowSettings(local);
		expect(getEffectiveModelMetadata("codex:gpt-5.5").metadata.limits?.contextWindow).toBe(
			presetContextWindow,
		);
		local.agent.modelContextWindows = {};
		reconcileLegacyWindowSettings(local);
		expect(getModelCatalogSnapshot().local.bindings).toEqual([]);
	});
	test.each([
		"migrated",
		"patched",
	] as const)("deleting a %s binding atomically removes its overrides", (source) => {
		const id = source === "migrated" ? "legacy-window:codex:gpt-5.5" : "editable-binding";
		if (source === "migrated") {
			delete local.agent.modelCatalog;
			local.agent.modelContextWindows = { "codex:gpt-5.5": 199999 };
			bindModelCatalogSettings(local, () => {});
		} else {
			mutateModelCatalog({
				action: "upsert-binding",
				baseRevision: 0,
				binding: { id, upstreamModelId: "gpt-5.5", providerId: "codex", modelId: "gpt-5.5" },
			});
			mutate({
				action: "patch",
				target: "binding",
				targetId: id,
				patch: { set: { "limits.contextWindow": 199999 } },
			});
		}
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: { set: { "referencePricing.input": "0" } },
		});
		const before = getModelCatalogSnapshot();
		bindModelCatalogSettings(local, () => {
			throw new Error("disk unavailable");
		});
		const deletion = {
			action: "delete",
			target: "binding",
			targetId: id,
			baseRevision: before.local.revision,
		} as const;
		expect(() => mutateModelCatalog(deletion)).toThrow("disk unavailable");
		expect(getModelCatalogSnapshot()).toEqual(before);
		let saves = 0;
		bindModelCatalogSettings(local, () => saves++);
		const after = mutateModelCatalog(deletion);
		expect(saves).toBe(1);
		expect(after.local.revision).toBe(before.local.revision + 1);
		expect(after.local.bindings?.some((b) => b.id === id)).toBe(false);
		expect(after.local.overrides?.some((o) => o.target === "binding" && o.targetId === id)).toBe(
			false,
		);
		expect(getEffectiveModelMetadata("codex:gpt-5.5").metadata.limits?.contextWindow).toBe(
			presetContextWindow,
		);
		expect(getEffectiveModelMetadata("codex:gpt-5.5").metadata.referencePricing?.input).toBe("0");
	});
	test("form create/edit/inherit clears embedded metadata and resolves binding to variant to parent", () => {
		const form = (window: number) =>
			metadataFromPatch(
				buildCatalogPatch({
					"limits.contextWindow": { mode: "set", value: String(window) },
					"nativeSearch.supported": { mode: "set", value: "false" },
					"referencePricing.input": { mode: "set", value: "0" },
				}),
			);
		mutateModelCatalog({
			action: "upsert-model",
			baseRevision: 0,
			model: { id: "parent", metadata: form(600000) },
		});
		mutateModelCatalog({
			action: "upsert-variant",
			baseRevision: 1,
			variant: {
				id: "child",
				modelId: "parent",
				providerKey: "codex",
				upstreamModelIds: ["child"],
				metadata: form(500000),
			},
		});
		mutateModelCatalog({
			action: "upsert-binding",
			baseRevision: 2,
			binding: {
				id: "connection",
				upstreamModelId: "connected",
				providerId: "codex",
				variantId: "child",
				overrides: form(400000),
			},
		});
		const edit = (target: "model" | "variant" | "binding", targetId: string, window?: number) => {
			const patch = buildCatalogPatch({
				"limits.contextWindow":
					window === undefined ? { mode: "reset" } : { mode: "set", value: String(window) },
			});
			if (!patch) throw new Error("Expected form edit");
			return mutate({ action: "patch", target, targetId, patch });
		};
		for (const [target, id, window] of [
			["model", "parent", 700000],
			["variant", "child", 650000],
			["binding", "connection", 550000],
		] as const)
			edit(target, id, window);
		expect(getEffectiveModelMetadata("codex:connected").metadata.limits?.contextWindow).toBe(
			550000,
		);
		for (const [target, id, window, layer] of [
			["binding", "connection", 650000, "local-variant"],
			["variant", "child", 700000, "local-model"],
			["model", "parent", undefined, undefined],
		] as const) {
			const before = getModelCatalogSnapshot();
			const after = edit(target, id);
			expect(after.local.revision).toBe(before.local.revision + 1);
			const resolved = getEffectiveModelMetadata("codex:connected");
			expect(resolved.metadata.limits?.contextWindow).toBe(window);
			if (layer) expect(resolved.provenance["limits.contextWindow"]?.layer).toBe(layer);
			else expect(resolved.provenance["limits.contextWindow"]).toBeUndefined();
			// Reset only the requested field; false and zero are still explicit values.
			expect(resolved.metadata.nativeSearch?.supported).toBe(false);
			expect(resolved.metadata.referencePricing?.input).toBe("0");
		}
		expect(getModelCatalogSnapshot().local.models?.[0]?.metadata.limits).toBeUndefined();
		expect(getModelCatalogSnapshot().local.variants?.[0]?.metadata.limits).toBeUndefined();
		expect(getModelCatalogSnapshot().local.bindings?.[0]?.overrides?.limits).toBeUndefined();
	});
	test("inherit without an intermediate patch clears creation values atomically and restores preset", () => {
		mutateModelCatalog({
			action: "upsert-model",
			baseRevision: 0,
			model: {
				id: "gpt-5.5",
				metadata: { limits: { contextWindow: 300000 } },
			},
		});
		const before = getModelCatalogSnapshot();
		const reset = () =>
			mutate({
				action: "patch",
				target: "model",
				targetId: "gpt-5.5",
				patch: { reset: ["limits.contextWindow"] },
			});
		bindModelCatalogSettings(local, () => {
			throw new Error("disk unavailable");
		});
		expect(reset).toThrow("disk unavailable");
		expect(getModelCatalogSnapshot()).toEqual(before);
		let saves = 0;
		bindModelCatalogSettings(local, () => saves++);
		reset();
		expect(saves).toBe(1);
		expect(getEffectiveModelMetadata("gpt-5.5").metadata.limits?.contextWindow).toBe(
			presetContextWindow,
		);
		const inherited = getModelCatalogSnapshot();
		reset();
		expect(getModelCatalogSnapshot()).toEqual(inherited);
		expect(saves).toBe(1);
	});
	test("hide and restore preserve callable models but remove and restore metadata", () => {
		mutateModelCatalog({ action: "hide", target: "model", targetId: "gpt-5.5", baseRevision: 0 });
		expect(getEffectiveModelMetadata("codex:gpt-5.5").metadata.referencePricing).toBeUndefined();
		mutateModelCatalog({
			action: "restore",
			target: "model",
			targetId: "gpt-5.5",
			baseRevision: 1,
		});
		expect(getEffectiveModelMetadata("codex:gpt-5.5").metadata.referencePricing).toBeDefined();
	});
	test("request snapshot does not change under concurrent metadata edits", async () => {
		await withModelMetadataSnapshot(async () => {
			const initial = getEffectiveModelMetadata("codex:gpt-5.5");
			mutate({
				action: "patch",
				target: "model",
				targetId: "gpt-5.5",
				patch: { set: { "limits.maxOutputTokens": 999 } },
			});
			await Promise.resolve();
			expect(getEffectiveModelMetadata("codex:gpt-5.5")).toEqual(initial);
		});
		expect(getEffectiveModelMetadata("codex:gpt-5.5").metadata.limits?.maxOutputTokens).toBe(999);
	});
	test("concurrent lazy generators retain independent snapshots across await/yield/return/throw and restore caller context", async () => {
		const price = () => getEffectiveModelMetadata("codex:gpt-5.5").metadata.referencePricing?.input;
		const setPrice = (value: string) =>
			mutate({
				action: "patch",
				target: "model",
				targetId: "gpt-5.5",
				patch: { set: { "referencePricing.input": value } },
			});
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
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
	test("migration keeps weakly matched legacy card and pricing identities distinct", () => {
		delete local.agent.modelCatalog;
		local.agent.modelCards = [
			{ modelKey: "gpt-5.5", contextWindow: 240000, officialPricing: { input: 9 } },
			{ modelKey: "gpt-5.5-mini", contextWindow: 160000, officialPricing: { input: 1 } },
			{ modelKey: "gpt-5.5-20260901", contextWindow: 180000 },
		];
		local.pricing = { overrides: { "gpt-5.5-budget": { input: 0 } } };
		bindModelCatalogSettings(local, () => {});
		for (const [id, window, price] of [
			["gpt-5.5", 240000, "9"],
			["gpt-5.5-mini", 160000, "1"],
			["gpt-5.5-20260901", 180000, undefined],
			["gpt-5.5-budget", undefined, "0"],
		] as const) {
			const result = getEffectiveModelMetadata(id);
			expect(result.modelId).toBe(id);
			expect(result.metadata.limits?.contextWindow).toBe(window);
			expect(result.metadata.referencePricing?.input).toBe(price);
		}
		// Resolving and mutating both validate the complete migrated override set.
		mutate({ action: "patch", target: "model", targetId: "gpt-5.5-mini", patch: {} });
	});
	test.each([
		"migration",
		"save",
	] as const)("legacy window %s preserves weak-match pricing restrictions", (mode) => {
		local.agent.modelContextWindows = { "codex:gpt-5.5-mini": 160000 };
		if (mode === "migration") {
			delete local.agent.modelCatalog;
			bindModelCatalogSettings(local, () => {});
		} else {
			reconcileLegacyWindowSettings(local);
		}
		const resolved = getEffectiveModelMetadata("codex:gpt-5.5-mini");
		expect(resolved.metadata.limits?.contextWindow).toBe(160000);
		expect(resolved.metadata.referencePricing).toBeUndefined();
		expect(getModelCatalogSnapshot().local.bindings?.[0]?.modelId).toBeUndefined();
	});
	test("migration merges alias and duplicate cards once with canonical fields winning independent of order", () => {
		delete local.agent.modelCatalog;
		local.agent.modelCards = [
			{ modelKey: "claude-opus-4-6", contextWindow: 350000, displayName: "Canonical" },
			{
				modelKey: "claude-opus-4.6",
				contextWindow: 250000,
				maxCompletionTokens: 1234,
				displayName: "Alias",
			},
			{ modelKey: "claude-opus-4-6", officialPricing: { input: 3 } },
		];
		bindModelCatalogSettings(local, () => {});
		const result = getEffectiveModelMetadata("claude-opus-4.6");
		expect(result.modelId).toBe("claude-opus-4-6");
		expect(result.metadata.limits).toEqual({ contextWindow: 350000, maxOutputTokens: 1234 });
		expect(result.metadata.referencePricing?.input).toBe("3");
		const migrated = getModelCatalogSnapshot().local;
		expect(migrated.overrides?.filter((o) => o.targetId === "claude-opus-4-6")).toHaveLength(0);
		expect(
			migrated.models?.find((m) => m.id === "claude-opus-4-6")?.metadata.referencePricing?.input,
		).toBe("3");
		expect(migrated.models?.filter((m) => m.id === "claude-opus-4-6")).toHaveLength(1);
		expect(migrated.models?.find((m) => m.id === "claude-opus-4-6")?.name).toBe("Canonical");
		mutate({ action: "patch", target: "model", targetId: "claude-opus-4-6", patch: {} });
	});
	test("migration of a deleted prefix-only card does not hide its broader preset or resurrect it", () => {
		delete local.agent.modelCatalog;
		local.agent.modelCards = [{ modelKey: "gpt-5.5-mini", deleted: true }];
		bindModelCatalogSettings(local, () => {});
		expect(getEffectiveModelMetadata("gpt-5.5").metadata.limits?.contextWindow).toBe(
			presetContextWindow,
		);
		expect(getEffectiveModelMetadata("gpt-5.5-mini").metadata).toEqual({});
	});
	test("migration preserves zero semantics, legacy windows and archive; second bind is idempotent", () => {
		delete local.agent.modelCatalog;
		local.agent.modelCards = [
			{ modelKey: "gpt-5.5", officialPricing: { input: 0, output: 99 }, contextWindow: 222222 },
		];
		local.pricing = { overrides: { "gpt-5.5": { input: 0 } } };
		local.agent.modelContextWindows = { "codex:gpt-5.5": 199999 };
		let saves = 0;
		bindModelCatalogSettings(local, () => saves++);
		expect(getEffectiveModelMetadata("codex:gpt-5.5").metadata.limits?.contextWindow).toBe(199999);
		expect(getEffectiveModelMetadata("codex:gpt-5.5").metadata.referencePricing?.input).toBe("0");
		expect(
			(local.agent.modelCatalog as ModelCatalogSettings | undefined)?.legacyArchive?.modelCards,
		).toEqual(local.agent.modelCards);
		const snapshot = structuredClone(local.agent.modelCatalog);
		bindModelCatalogSettings(local, () => saves++);
		expect(local.agent.modelCatalog).toEqual(snapshot);
		expect(saves).toBe(1);
	});
	test("new NUG metadata survives normalization and wins presets; old gateway still works; never writes settings windows", () => {
		const config = {
			id: "nug-test",
			name: "NUG",
			prefix: "gateway",
			baseUrl: "https://example.invalid",
			apiKey: "unused",
			defaultModel: "",
		};
		local.nugProviders = [config];
		const metadata: ResolvedModelMetadata = {
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
		const applied = applyNugModelCatalogUpdate(
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
		expect(applied.changedContextWindows).toBe(false);
		expect(local.agent.modelContextWindows).toEqual({});
		expect(getNugCachedModelsByProvider(config.id)[0]?.metadata).toEqual(metadata);
		expect(
			resolveNugModelMeta(config.id, config.prefix, "gateway:channel:gpt-5.5").metadata,
		).toEqual(metadata);
		expect(
			getEffectiveModelMetadata("gateway:channel:gpt-5.5").metadata.limits?.contextWindow,
		).toBe(333333);
		expect(getModelContextWindow("channel:gpt-5.5", "gateway")).toBe(333333);
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: { set: { "limits.contextWindow": 250000 } },
		});
		expect(getModelContextWindow("channel:gpt-5.5", "gateway")).toBe(250000);
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: { reset: ["limits.contextWindow"] },
		});
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
		expect(
			getEffectiveModelMetadata("gateway:channel:gpt-5.5").metadata.limits?.contextWindow,
		).toBe(444444);
	});
	test("NUG modelCard is returned on resolve and rejects operational metadata", () => {
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
		const meta = resolveNugModelMeta(config.id, config.prefix, "gw:ch:m");
		expect(meta.modelCard).toEqual(card);
		// queryForModel projects the card into v1 when no envelope is present.
		expect(getEffectiveModelMetadata("gw:ch:m").metadata.limits?.maxOutputTokens).toBe(32000);

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
		const rejected = resolveNugModelMeta(config.id, config.prefix, "gw:ch:m");
		expect(rejected.modelCard).toBeUndefined();
		// The v1 projection remains usable when the card is discarded.
		expect(rejected.metadata?.metadata.limits?.contextWindow).toBe(333333);
		expect(getNugCachedModelsByProvider(config.id)[0]?.modelCard).toBeUndefined();
	});
	test("downgrade preflight rejects unknown metadata without writing and representable export re-upgrades losslessly", () => {
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: { set: { "referencePricing.input": "0", "limits.maxOutputTokens": 4321 } },
		});
		const preview = previewModelCatalogDowngrade();
		expect(preview.supported).toBe(true);
		const prior = getEffectiveModelMetadata("codex:gpt-5.5").metadata;
		const downgraded = getDefaults();
		downgraded.agent.modelCards = preview.legacy!.modelCards;
		downgraded.agent.modelContextWindows = preview.legacy!.modelContextWindows;
		downgraded.pricing = { overrides: preview.legacy!.pricingOverrides };
		bindModelCatalogSettings(downgraded, () => {});
		expect(getEffectiveModelMetadata("codex:gpt-5.5").metadata.limits).toEqual(prior.limits);
		expect(getEffectiveModelMetadata("codex:gpt-5.5").metadata.referencePricing).toEqual(
			prior.referencePricing,
		);
		bindModelCatalogSettings(local, () => {});
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: { set: { "nativeSearch.supported": null } },
		});
		const unchanged = getModelCatalogSnapshot();
		expect(previewModelCatalogDowngrade().supported).toBe(false);
		expect(getModelCatalogSnapshot()).toEqual(unchanged);
	});
	test("scope retains opaque colon ids on custom non-NUG providers", () => {
		local.openaiProviders = [
			{
				id: "opaque",
				prefix: "relay",
				name: "relay",
				baseUrl: "https://example.invalid",
				apiKey: "unused",
				defaultModel: "",
			},
		];
		mutateModelCatalog({
			action: "upsert-model",
			baseRevision: 0,
			model: {
				id: "opaque-model",
				matches: { ids: ["namespace:model:thinking"] },
				metadata: { limits: { contextWindow: 77777 } },
			},
		});
		expect(
			getEffectiveModelMetadata("relay:namespace:model:thinking").metadata.limits?.contextWindow,
		).toBe(77777);
	});
});

describe("catalog update and API boundary", () => {
	test("deleting a base referenced by a local variant is rejected without revision or state changes", () => {
		mutateModelCatalog({
			action: "upsert-model",
			baseRevision: 0,
			model: { id: "local-parent", metadata: {} },
		});
		mutateModelCatalog({
			action: "upsert-variant",
			baseRevision: 1,
			variant: {
				id: "local-child",
				modelId: "local-parent",
				providerKey: "test",
				upstreamModelIds: ["child"],
				metadata: {},
			},
		});
		const before = getModelCatalogSnapshot();
		expect(() =>
			mutateModelCatalog({
				action: "delete",
				baseRevision: 2,
				target: "model",
				targetId: "local-parent",
			}),
		).toThrow();
		expect(getModelCatalogSnapshot()).toEqual(before);
	});
	test("preset removals retain locally referenced definitions through apply and rollback", async () => {
		const initial = getModelCatalogSnapshot();
		restoreVersion = initial.catalog.catalogVersion;
		mutateModelCatalog({
			action: "upsert-variant",
			baseRevision: 0,
			variant: {
				id: "local-preset-child",
				modelId: "gpt-5.5",
				providerKey: "test",
				upstreamModelIds: ["my-upstream"],
				metadata: {},
			},
		});
		await mockCatalog("removed-referenced-preset", (c) => {
			c.models = c.models.filter((m) => m.id !== "gpt-5.5");
			c.variants = c.variants.filter((v) => v.modelId !== "gpt-5.5");
		});
		const checked = await checkModelCatalogUpdate();
		expect(checked.update.lastError).toBeUndefined();
		applyModelCatalogUpdate();
		expect(getModelCatalogSnapshot().local.models?.find((m) => m.id === "gpt-5.5")?.status).toBe(
			"deprecated",
		);
		expect(
			getModelCatalogSnapshot().local.variants?.some((v) => v.id === "local-preset-child"),
		).toBe(true);
		rollbackModelCatalog(initial.catalog.catalogVersion);
		expect(
			getModelCatalogSnapshot().local.variants?.some((v) => v.id === "local-preset-child"),
		).toBe(true);
	});
	test("check stages only, apply preserves overlays, pin blocks and rollback preserves edits", async () => {
		const initial = getModelCatalogSnapshot();
		restoreVersion = initial.catalog.catalogVersion;
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: { set: { "referencePricing.input": "0" } },
		});
		const updateVersion = await mockCatalog("integration-update", (c) => {
			c.models.find((m) => m.id === "gpt-5.5")!.metadata.referencePricing!.input = "999";
		});
		const checked = await checkModelCatalogUpdate();
		expect(checked.update.lastError).toBeUndefined();
		expect(checked.catalog.catalogVersion).toBe(initial.catalog.catalogVersion);
		expect(checked.update.pendingVersion).toBe(`v2:${updateVersion}`);
		expect(
			(checked.update as typeof checked.update & { protectedFieldCount: number })
				.protectedFieldCount,
		).toBeGreaterThan(0);
		expect(
			checked.update.pendingDiff?.fields?.some(
				(field) =>
					field.id === "gpt-5.5" &&
					field.path === "referencePricing.input" &&
					field.after === "999",
			),
		).toBe(true);
		setModelCatalogUpdateSettings({ pinnedVersion: "different" });
		expect(() => applyModelCatalogUpdate()).toThrow();
		setModelCatalogUpdateSettings({ pinnedVersion: updateVersion });
		applyModelCatalogUpdate(updateVersion);
		expect(getModelCatalogSnapshot().update.pinnedVersion).toBe(updateVersion);
		setModelCatalogUpdateSettings({ pinnedVersion: null });
		expect(getEffectiveModelMetadata("codex:gpt-5.5").metadata.referencePricing?.input).toBe("0");
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: { set: { "referencePricing.output": "1" } },
		});
		rollbackModelCatalog(initial.catalog.catalogVersion);
		expect(getEffectiveModelMetadata("codex:gpt-5.5").metadata.referencePricing?.output).toBe("1");
	});
	test("download corruption retains last good; concurrent checks are single flight", async () => {
		const initial = getModelCatalogSnapshot().catalog.catalogVersion;
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response("not json");
		}) as unknown as typeof fetch;
		const a = checkModelCatalogUpdate();
		const b = checkModelCatalogUpdate();
		expect(a).toBe(b);
		await a;
		expect(calls).toBe(1);
		expect(getModelCatalogSnapshot().catalog.catalogVersion).toBe(initial);
		expect(getModelCatalogSnapshot().update.lastError).toBeDefined();
	});
	test("lastError and non-AppError bodies never contain host absolute paths", async () => {
		const home = "/home/someone-private/.narrafork/model-catalog/snapshots.json";
		globalThis.fetch = (async () => {
			throw new Error(`ENOENT: no such file or directory, open '${home}'`);
		}) as unknown as typeof fetch;
		const checked = await checkModelCatalogUpdate();
		expect(checked.update.lastError).toBeDefined();
		expect(checked.update.lastError).not.toContain("/home/someone-private");
		expect(checked.update.lastError).not.toContain(".narrafork");
		// Basename is retained so the failure stays diagnosable without the host path.
		expect(checked.update.lastError).toContain("snapshots.json");
		const member = await app("user").request("/api/model-catalog");
		const body = await member.json();
		expect(JSON.stringify(body.update.lastError)).not.toContain("/home/someone-private");
		expect(JSON.stringify(body)).not.toContain("someone-private");

		bindModelCatalogSettings(local, () => {
			throw new Error("EACCES: permission denied, open '/home/someone-private/.narrafork/x'");
		});
		const failed = await app().request("/api/model-catalog/mutate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "patch",
				target: "model",
				targetId: "gpt-5.5",
				patch: { set: { "referencePricing.input": "0" } },
				baseRevision: getModelCatalogSnapshot().local.revision,
			}),
		});
		expect(failed.status).toBe(400);
		const errorBody = await failed.json();
		expect(errorBody.code).toBe("CATALOG_IO_ERROR");
		expect(errorBody.error).toBe("Model catalog operation failed");
		expect(JSON.stringify(errorBody)).not.toContain("someone-private");
		// Intentional validation prose without paths is preserved.
		const missing = await app().request("/api/model-catalog/resolve");
		expect(missing.status).toBe(400);
		expect((await missing.json()).error).toContain("model is required");
	});
	test.each([
		true,
		false,
	])("accepts 1 MiB branch metadata without requesting commit patches (Content-Length: %s)", async (includeLength) => {
		expect(MAX_CATALOG_REVISION_BYTES).toBe(1024 * 1024);
		expect(MAX_CATALOG_BYTES).toBe(16 * 1024 * 1024);
		const initial = getModelCatalogSnapshot();
		const version = await mockCatalog(`large-branch-${includeLength}`);
		const fixture = globalThis.fetch;
		const urls: string[] = [];
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			urls.push(String(url));
			if (String(url).endsWith("/commits/main"))
				return new Response("x".repeat(MAX_CATALOG_REVISION_BYTES + 1));
			const response = await fixture(url, init);
			if (String(url) !== CATALOG_REVISION_URL) return response;
			const body = (await response.text()).padEnd(MAX_CATALOG_REVISION_BYTES, " ");
			return new Response(body, {
				headers: includeLength
					? { "content-length": String(MAX_CATALOG_REVISION_BYTES) }
					: undefined,
			});
		}) as unknown as typeof fetch;
		const checked = await checkModelCatalogUpdate();
		expect(checked.update.lastError).toBeUndefined();
		expect(checked.update.pendingVersion).toBe(`v2:${version}`);
		expect(checked.catalog).toEqual(initial.catalog);
		expect(checked.local).toEqual(initial.local);
		expect(urls).toEqual([
			"https://api.github.com/repos/NarraFork/narrafork-model-catalog/branches/main",
			`https://codeload.github.com/NarraFork/narrafork-model-catalog/tar.gz/${version}`,
		]);
	});
	test("reuses the branch ETag and preserves the staged catalog on 304", async () => {
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
		expect(first.update.lastError).toBeUndefined();
		expect(first.update.pendingVersion).toBe(`v2:${version}`);
		const second = await checkModelCatalogUpdate();
		expect(second.update.lastError).toBeUndefined();
		expect(second.update.pendingVersion).toBe(first.update.pendingVersion);
		expect(second.update.pendingDiff).toEqual(first.update.pendingDiff);
		expect(second.catalog).toEqual(first.catalog);
		expect(second.local).toEqual(first.local);
		expect(revisionCalls).toBe(2);
		expect(archiveCalls).toBe(1);
	});
	test.each([
		["revision", MAX_CATALOG_REVISION_BYTES],
		["archive", MAX_CATALOG_BYTES],
	] as const)("rejects oversized %s Content-Length even when cancellation fails", async (kind, max) => {
		const before = getModelCatalogSnapshot();
		const version = await mockCatalog(`oversized-header-${kind}`);
		const fixture = globalThis.fetch;
		const rejectedUrl =
			kind === "revision" ? CATALOG_REVISION_URL : `${CATALOG_ARCHIVE_BASE}${version}`;
		let cancellations = 0;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url) !== rejectedUrl) return fixture(url, init);
			return new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancellations++;
						throw new Error("cancel failed");
					},
				}),
				{ headers: { "content-length": String(max + 1) } },
			);
		}) as unknown as typeof fetch;
		const checked = await checkModelCatalogUpdate();
		expect(checked.update.lastError).toBe(
			`Catalog ${kind} download exceeds size limit (${max + 1} bytes; limit ${max} bytes)`,
		);
		expect(cancellations).toBe(1);
		expect(checked.catalog).toEqual(before.catalog);
		expect(checked.local).toEqual(before.local);
		expect(checked.update.pendingVersion).toBe(before.update.pendingVersion);
		expect(checked.update.pendingDiff).toEqual(before.update.pendingDiff);
	});
	test.each([
		["revision", MAX_CATALOG_REVISION_BYTES],
		["archive", MAX_CATALOG_BYTES],
	] as const)("cancels oversized %s streams without Content-Length", async (kind, max) => {
		const before = getModelCatalogSnapshot();
		const version = await mockCatalog(`oversized-stream-${kind}`);
		const fixture = globalThis.fetch;
		const rejectedUrl =
			kind === "revision" ? CATALOG_REVISION_URL : `${CATALOG_ARCHIVE_BASE}${version}`;
		let cancellations = 0;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url) !== rejectedUrl) return fixture(url, init);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(max));
						controller.enqueue(new Uint8Array(1));
					},
					cancel() {
						cancellations++;
					},
				}),
			);
		}) as unknown as typeof fetch;
		const checked = await checkModelCatalogUpdate();
		expect(checked.update.lastError).toBe(
			`Catalog ${kind} download exceeds size limit (${max + 1} bytes; limit ${max} bytes)`,
		);
		expect(cancellations).toBe(1);
		expect(checked.catalog).toEqual(before.catalog);
		expect(checked.local).toEqual(before.local);
		expect(checked.update.pendingVersion).toBe(before.update.pendingVersion);
	});
	test("invalid revisions, corrupt archives and redirects retain last good", async () => {
		const version = getModelCatalogSnapshot().catalog.catalogVersion;
		const urls: string[] = [];
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			urls.push(String(url));
			expect(init?.redirect).toBe("error");
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			if (String(url) === CATALOG_REVISION_URL)
				return Response.json({
					commit: {
						sha: "a".repeat(40),
						commit: { committer: { date: "2026-01-01T00:00:00Z" } },
					},
				});
			return new Response("corrupt archive");
		}) as unknown as typeof fetch;
		expect((await checkModelCatalogUpdate()).update.lastError).toBeDefined();
		expect(urls).toEqual([
			"https://api.github.com/repos/NarraFork/narrafork-model-catalog/branches/main",
			`https://codeload.github.com/NarraFork/narrafork-model-catalog/tar.gz/${"a".repeat(40)}`,
		]);
		globalThis.fetch = (async () =>
			Response.json({ commit: { sha: "../../other-repo" } })) as unknown as typeof fetch;
		expect((await checkModelCatalogUpdate()).update.lastError).toContain("Git revision");
		globalThis.fetch = (async () =>
			new Response(null, {
				status: 302,
				headers: { location: "http://127.0.0.1/secrets" },
			})) as unknown as typeof fetch;
		expect((await checkModelCatalogUpdate()).update.lastError).toContain("HTTP 302");
		expect(getModelCatalogSnapshot().catalog.catalogVersion).toBe(version);
	});
	test("forbidden patch paths are rejected without mutating local state", () => {
		const before = getModelCatalogSnapshot().local;
		expect(() =>
			mutate({
				action: "patch",
				target: "model",
				targetId: "gpt-5.5",
				patch: { set: { "__proto__.polluted": true } },
			}),
		).toThrow();
		expect(getModelCatalogSnapshot().local).toEqual(before);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
	test("legacy identity edits never turn complete preset metadata into local overrides", () => {
		saveLegacyModelCard("gpt-5.5", { modelKey: "gpt-5.5", displayName: "Local label" });
		expect(
			getModelCatalogSnapshot().local.models?.find((m) => m.id === "gpt-5.5")?.rawMetadata,
		).toEqual({});
		expect(getEffectiveModelCard("codex:gpt-5.5").provenance.input_cost_per_token?.layer).not.toBe(
			"local-model",
		);
		const migrated = getDefaults();
		delete migrated.agent.modelCatalog;
		migrated.agent.modelCards = [{ modelKey: "gpt-5.5", displayName: "Migrated label" }];
		bindModelCatalogSettings(migrated, () => {});
		expect(
			getModelCatalogSnapshot().local.models?.find((m) => m.id === "gpt-5.5")?.rawMetadata,
		).toEqual({});
		expect(getEffectiveModelCard("codex:gpt-5.5").provenance.input_cost_per_token?.layer).not.toBe(
			"local-model",
		);
	});
	test("API allows member reads, denies writes, reports conflicts and returns actual scope", async () => {
		expect((await app("user").request("/api/model-catalog")).status).toBe(200);
		const v2 = await app("user").request("/api/model-catalog/v2");
		expect(v2.status).toBe(200);
		const snapshot = await v2.json();
		expect(snapshot.schemaVersion).toBe(2);
		expect(snapshot.catalog.sourceVersion).toBe(
			snapshot.catalog.catalogVersion.replace(/^v2:/, ""),
		);
		const cardResponse = await app("user").request(
			"/api/model-catalog/v2/resolve?model=codex:gpt-5.5",
		);
		expect(cardResponse.status).toBe(200);
		const card = await cardResponse.json();
		expect(card.schemaVersion).toBe(2);
		expect(card.metadata).toHaveProperty("input_cost_per_token");
		expect(card.view.prices.length).toBeGreaterThan(0);
		expect(card.resolvedQuery.providerKey).toBe("codex");
		const body = JSON.stringify({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: {},
			baseRevision: 99,
		});
		const init = { method: "POST", headers: { "content-type": "application/json" }, body };
		expect((await app("user").request("/api/model-catalog/mutate", init)).status).toBe(403);
		expect((await app().request("/api/model-catalog/mutate", init)).status).toBe(409);
		const resolved = await (
			await app().request("/api/model-catalog/resolve?model=codex:gpt-5.5")
		).json();
		expect(resolved.resolvedQuery).toEqual({
			upstreamModelId: "gpt-5.5",
			providerId: "codex",
			providerKey: "codex",
		});
	});
});
