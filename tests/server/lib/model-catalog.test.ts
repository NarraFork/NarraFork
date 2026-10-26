import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
	getEffectiveModelProfile,
	getModelCardSnapshot,
	mutateModelCard,
	rollbackModelCatalog,
	setModelCatalogUpdateSettings,
	setModelWindow,
	withModelMetadataSnapshot,
	withModelMetadataSnapshotIterator,
} from "../../../server/lib/model-catalog";
import type { LegacyResolvedEnvelope } from "../../../server/lib/model-catalog/legacy-v1";
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
import type { AuthSessionStore } from "../../../server/services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../../server/services/auth/store";
import { decimalValue } from "../../../shared/model-catalog/card";
import type { ModelCardMutation } from "../../../shared/model-catalog/card-local";
import * as cardResolvers from "../../../shared/model-catalog/card-resolver";

let local: NarraForkSettings;
let presetContextWindow: number;
const originalFetch = globalThis.fetch;
let restoreVersion: string | undefined;
beforeEach(() => {
	local = getDefaults();
	local.agent.modelCatalog = {
		schemaVersion: 2,
		migrationVersion: 2,
		local: { revision: 0 },
		autoApply: false,
		pinnedVersion: null,
	};
	bindModelCatalogSettings(local, () => {});
	_bindSettings(local);
	const window = profile("codex:gpt-5.5").contextWindow;
	if (typeof window !== "number") throw new Error("Expected GPT-5.5 preset context window");
	presetContextWindow = window;
	restoreVersion = undefined;
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
	if (restoreVersion && getModelCardSnapshot().catalog.catalogVersion !== restoreVersion)
		rollbackModelCatalog(restoreVersion);
	deleteNugCachedModels("nug-test");
	deleteNugCachedModels("nug-card-test");
	bindModelCatalogSettings(settings, () => saveSettings(settings));
	_bindSettings(settings);
});
const profile = (model: string) => getEffectiveModelProfile(model);
/** The per-model window map a settings file from an older build may carry. */
const storeWindowMap = (windows: Record<string, number>) => {
	(local.agent as Record<string, unknown>).modelContextWindows = windows;
};
const setOwnWindow = (model: string, contextWindow: number | null) =>
	setModelWindow({
		baseRevision: getModelCardSnapshot().local.revision,
		scope: "connection",
		target: model,
		contextWindow,
	});
/** Fixture prices are written per million tokens; the catalog stores per-token decimals. */
const perToken = (perMillion: string) => decimalValue(perMillion, -6);
function mutate(value: Omit<Extract<ModelCardMutation, { action: "patch" }>, "baseRevision">) {
	return mutateModelCard({ ...value, baseRevision: getModelCardSnapshot().local.revision });
}
function app(role: "admin" | "user" = "admin") {
	const app = new Hono();
	// Distinct subs per role: assertAdmin authorizes against the live store role
	// (not the token claim), and the seam below maps each sub to its role.
	const sub = role === "admin" ? "catalog-admin" : "catalog-user";
	app.use("*", async (c, next) => {
		c.set("user", { sub, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.route("/api/model-catalog", modelCatalogRoutes);
	return app;
}
async function mockCatalog(
	label: string,
	modify?: (doc: ReturnType<typeof getModelCardSnapshot>["catalog"]) => void,
) {
	const catalog = structuredClone(getModelCardSnapshot().catalog);
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
	test("bundled DeepSeek cards declare effective effort levels without upgrading retired aliases", () => {
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
		for (const model of ["deepseek-chat", "deepseek-reasoner"]) {
			expect(profile(`openai:${model}`).reasoning.levels).toBeUndefined();
		}
	});

	test("bundled Haiku 5.5 declares its xhigh tier without relying on Claude name heuristics", () => {
		expect(profile("anthropic:claude-haiku-5-5").reasoning.levels).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	test("bundled catalog covers new sub2api models and existing routed aliases", () => {
		for (const model of [
			"claude-haiku-5-5",
			"claude-opus-4-6-thinking",
			"claude-sonnet-4-5-20250929-v1:0",
			"gemini-3.1-pro-high",
			"gemini-3.1-pro-low",
			"gemini-4-argon",
			"gemini-4-argon-cyber-permissive",
			"gpt-image-2.5-flare-2026-09-08",
			"gpt-image-2.5-sunburst-2026-09-08",
		]) {
			expect(profile(`openai:${model}`).card.matchedVia).not.toBe("none");
		}
	});

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
		storeWindowMap({ "custom-empty-label": 16000 });
		expect(() => bindModelCatalogSettings(local, () => {})).not.toThrow();
		const model = local.agent.modelCatalog!.local.models!.find(
			(m) => m.id === "custom-empty-label",
		);
		expect(model?.name).toBeUndefined();
		expect(model?.family).toBeUndefined();
		expect(model?.notes).toBeUndefined();
		expect(profile("custom-empty-label").contextWindow).toBe(16000);
		expect(local.agent.modelCatalog!.legacyArchive?.modelCards[0]?.displayName).toBe("");
	});
	test("new patch changes runtime limits and reset really restores inheritance", () => {
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: {
				set: {
					working_context_tokens: 240000,
					max_output_tokens: 1234,
					input_cost_per_token: "0",
					supports_web_search: false,
					supported_modalities: [],
				},
			},
		});
		expect(getModelContextWindow("gpt-5.5", "codex")).toBe(240000);
		expect(getModelMaxCompletionTokens("gpt-5.5", "codex")).toBe(1234);
		expect(profile("codex:gpt-5.5").referencePricing?.input).toBe("0");
		expect(profile("codex:gpt-5.5").inputModalities).toEqual([]);
		expect(profile("codex:gpt-5.5").nativeSearch).toBe(false);
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: { reset: ["working_context_tokens", "max_output_tokens"] },
		});
		expect(getModelContextWindow("gpt-5.5", "codex")).toBe(presetContextWindow);
	});
	test("no-op patch does not increment revision; stale patch and invalid effective values fail", () => {
		mutate({ action: "patch", target: "model", targetId: "gpt-5.5", patch: {} });
		expect(getModelCardSnapshot().local.revision).toBe(0);
		// A total below the inherited output ceiling makes the effective card invalid.
		expect(() =>
			mutate({
				action: "patch",
				target: "model",
				targetId: "gpt-5.5",
				patch: { set: { context_window: 1 } },
			}),
		).toThrow();
		expect(getModelCardSnapshot().local.revision).toBe(0);
		expect(() =>
			mutateModelCard({
				action: "hide",
				target: "model",
				targetId: "gpt-5.5",
				baseRevision: 123,
			}),
		).toThrow();
	});
	test("failed settings persistence never publishes a local mutation", () => {
		const initial = getModelCardSnapshot();
		bindModelCatalogSettings(local, () => {
			throw new Error("disk unavailable");
		});
		expect(() =>
			mutate({
				action: "patch",
				target: "model",
				targetId: "gpt-5.5",
				patch: { set: { input_cost_per_token: "0" } },
			}),
		).toThrow("disk unavailable");
		expect(getModelCardSnapshot()).toEqual(initial);
	});
	test("provider-entry windows apply by model value and a reset restores inheritance", () => {
		setOwnWindow("codex:gpt-5.5", 230000);
		expect(profile("codex:gpt-5.5").contextWindow).toBe(230000);
		mutate({
			action: "patch",
			target: "connection",
			targetId: "codex:gpt-5.5",
			patch: { reset: ["working_context_tokens"] },
		});
		expect(profile("codex:gpt-5.5").contextWindow).toBe(presetContextWindow);
		expect(getModelCardSnapshot().local.connections).toBeUndefined();
	});
	test.each([
		"migrated",
		"patched",
	] as const)("deleting a %s window atomically removes its overrides", (source) => {
		const target = source === "migrated" ? "connection" : "binding";
		const id = source === "migrated" ? "codex:gpt-5.5" : "editable-binding";
		if (source === "migrated") {
			delete local.agent.modelCatalog;
			storeWindowMap({ "codex:gpt-5.5": 199999 });
			bindModelCatalogSettings(local, () => {});
		} else {
			mutateModelCard({
				action: "upsert-binding",
				baseRevision: 0,
				binding: { id, upstreamModelId: "gpt-5.5", providerId: "codex", modelId: "gpt-5.5" },
			});
			mutate({
				action: "patch",
				target: "binding",
				targetId: id,
				patch: { set: { working_context_tokens: 199999 } },
			});
		}
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: { set: { input_cost_per_token: "0" } },
		});
		const before = getModelCardSnapshot();
		bindModelCatalogSettings(local, () => {
			throw new Error("disk unavailable");
		});
		const deletion = {
			action: "delete",
			target,
			targetId: id,
			baseRevision: before.local.revision,
		} as const;
		expect(() => mutateModelCard(deletion)).toThrow("disk unavailable");
		expect(getModelCardSnapshot()).toEqual(before);
		let saves = 0;
		bindModelCatalogSettings(local, () => saves++);
		const after = mutateModelCard(deletion);
		expect(saves).toBe(1);
		expect(after.local.revision).toBe(before.local.revision + 1);
		expect(after.local.bindings?.some((b) => b.id === id)).toBe(false);
		expect(after.local.connections?.[id]).toBeUndefined();
		expect(after.local.overrides?.some((o) => o.target === "binding" && o.targetId === id)).toBe(
			false,
		);
		expect(profile("codex:gpt-5.5").contextWindow).toBe(presetContextWindow);
		expect(profile("codex:gpt-5.5").referencePricing?.input).toBe("0");
	});
	test("form create/edit/inherit clears embedded metadata and resolves binding to variant to parent", () => {
		const form = (window: number) =>
			metadataFromPatch(
				buildCatalogPatch({
					working_context_tokens: { mode: "set", value: String(window) },
					supports_web_search: { mode: "set", value: "false" },
					input_cost_per_token: { mode: "set", value: "0" },
				}),
			);
		mutateModelCard({
			action: "upsert-model",
			baseRevision: 0,
			model: { id: "parent", metadata: form(600000) },
		});
		mutateModelCard({
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
		mutateModelCard({
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
				working_context_tokens:
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
		expect(profile("codex:connected").contextWindow).toBe(550000);
		for (const [target, id, window, layer] of [
			["binding", "connection", 650000, "local-variant"],
			["variant", "child", 700000, "local-model"],
			["model", "parent", undefined, undefined],
		] as const) {
			const before = getModelCardSnapshot();
			const after = edit(target, id);
			expect(after.local.revision).toBe(before.local.revision + 1);
			const resolved = profile("codex:connected");
			expect(resolved.contextWindow).toBe(window);
			expect(resolved.contextWindowSource?.layer).toBe(layer);
			// Reset only the requested field; false and zero are still explicit values.
			expect(resolved.nativeSearch).toBe(false);
			expect(resolved.referencePricing?.input).toBe("0");
		}
		const snapshot = getModelCardSnapshot();
		expect(snapshot.local.models?.[0]?.metadata.working_context_tokens).toBeUndefined();
		expect(snapshot.local.variants?.[0]?.metadata.working_context_tokens).toBeUndefined();
		expect(snapshot.local.bindings?.[0]?.overrides?.working_context_tokens).toBeUndefined();
	});
	test("inherit clears a local value atomically and restores the preset", () => {
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: { set: { working_context_tokens: 300000 } },
		});
		const before = getModelCardSnapshot();
		const reset = () =>
			mutate({
				action: "patch",
				target: "model",
				targetId: "gpt-5.5",
				patch: { reset: ["working_context_tokens"] },
			});
		bindModelCatalogSettings(local, () => {
			throw new Error("disk unavailable");
		});
		expect(reset).toThrow("disk unavailable");
		expect(getModelCardSnapshot()).toEqual(before);
		let saves = 0;
		bindModelCatalogSettings(local, () => saves++);
		reset();
		expect(saves).toBe(1);
		expect(profile("gpt-5.5").contextWindow).toBe(presetContextWindow);
		const inherited = getModelCardSnapshot();
		reset();
		expect(getModelCardSnapshot()).toEqual(inherited);
		expect(saves).toBe(1);
	});
	test("hide and restore preserve callable models but remove and restore metadata", () => {
		mutateModelCard({ action: "hide", target: "model", targetId: "gpt-5.5", baseRevision: 0 });
		expect(profile("codex:gpt-5.5").referencePricing).toBeUndefined();
		mutateModelCard({
			action: "restore",
			target: "model",
			targetId: "gpt-5.5",
			baseRevision: 1,
		});
		expect(profile("codex:gpt-5.5").referencePricing).toBeDefined();
	});
	test("request snapshot does not change under concurrent metadata edits", async () => {
		await withModelMetadataSnapshot(async () => {
			const initial = profile("codex:gpt-5.5");
			mutate({
				action: "patch",
				target: "model",
				targetId: "gpt-5.5",
				patch: { set: { max_output_tokens: 999 } },
			});
			await Promise.resolve();
			expect(profile("codex:gpt-5.5")).toEqual(initial);
		});
		expect(profile("codex:gpt-5.5").maxOutputTokens).toBe(999);
	});
	test("concurrent lazy generators retain independent snapshots across await/yield/return/throw and restore caller context", async () => {
		const price = () => profile("codex:gpt-5.5").referencePricing?.input;
		const setPrice = (value: string) =>
			mutate({
				action: "patch",
				target: "model",
				targetId: "gpt-5.5",
				patch: { set: { input_cost_per_token: perToken(value) } },
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
			const result = profile(id);
			expect(result.card.modelId).toBe(id);
			expect(result.contextWindow).toBe(window);
			expect(result.referencePricing?.input).toBe(price);
		}
		// Resolving and mutating both validate the complete migrated override set.
		mutate({ action: "patch", target: "model", targetId: "gpt-5.5-mini", patch: {} });
	});
	test.each([
		"migration",
		"save",
	] as const)("legacy window %s preserves weak-match pricing restrictions", (mode) => {
		if (mode === "migration") {
			storeWindowMap({ "codex:gpt-5.5-mini": 160000 });
			delete local.agent.modelCatalog;
			bindModelCatalogSettings(local, () => {});
		} else {
			setOwnWindow("codex:gpt-5.5-mini", 160000);
		}
		const resolved = profile("codex:gpt-5.5-mini");
		expect(resolved.contextWindow).toBe(160000);
		expect(resolved.referencePricing).toBeUndefined();
		// A provider entry's own window never asserts an identity.
		expect(getModelCardSnapshot().local.bindings ?? []).toEqual([]);
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
		const result = profile("claude-opus-4.6");
		expect(result.card.modelId).toBe("claude-opus-4-6");
		expect(result.contextWindow).toBe(350000);
		expect(result.maxOutputTokens).toBe(1234);
		expect(result.referencePricing?.input).toBe("3");
		const migrated = getModelCardSnapshot().local;
		expect(migrated.overrides?.filter((o) => o.targetId === "claude-opus-4-6")).toHaveLength(0);
		expect(
			migrated.models?.find((m) => m.id === "claude-opus-4-6")?.metadata.input_cost_per_token,
		).toBe(perToken("3"));
		expect(migrated.models?.filter((m) => m.id === "claude-opus-4-6")).toHaveLength(1);
		expect(migrated.models?.find((m) => m.id === "claude-opus-4-6")?.name).toBe("Canonical");
		mutate({ action: "patch", target: "model", targetId: "claude-opus-4-6", patch: {} });
	});
	test("migration of a deleted prefix-only card does not hide its broader preset or resurrect it", () => {
		delete local.agent.modelCatalog;
		local.agent.modelCards = [{ modelKey: "gpt-5.5-mini", deleted: true }];
		bindModelCatalogSettings(local, () => {});
		expect(profile("gpt-5.5").contextWindow).toBe(presetContextWindow);
		expect(getEffectiveModelCard("gpt-5.5-mini").metadata).toEqual({});
	});
	test("migration preserves zero semantics, legacy windows and archive; second bind is idempotent", () => {
		delete local.agent.modelCatalog;
		local.agent.modelCards = [
			{ modelKey: "gpt-5.5", officialPricing: { input: 0, output: 99 }, contextWindow: 222222 },
		];
		local.pricing = { overrides: { "gpt-5.5": { input: 0 } } };
		storeWindowMap({ "codex:gpt-5.5": 199999 });
		let saves = 0;
		bindModelCatalogSettings(local, () => saves++);
		expect(profile("codex:gpt-5.5").contextWindow).toBe(199999);
		expect(profile("codex:gpt-5.5").referencePricing?.input).toBe("0");
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
		expect(local.agent.modelCatalog?.local.connections).toBeUndefined();
		expect(getNugCachedModelsByProvider(config.id)[0]?.metadata).toEqual(metadata);
		expect(
			resolveNugModelMeta(config.id, config.prefix, "gateway:channel:gpt-5.5").metadata,
		).toEqual(metadata);
		expect(profile("gateway:channel:gpt-5.5").contextWindow).toBe(333333);
		expect(profile("gateway:channel:gpt-5.5").maxOutputTokens).toBe(321);
		expect(profile("gateway:channel:gpt-5.5").nativeSearch).toBe(false);
		expect(getModelContextWindow("channel:gpt-5.5", "gateway")).toBe(333333);
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: { set: { working_context_tokens: 250000 } },
		});
		expect(getModelContextWindow("channel:gpt-5.5", "gateway")).toBe(250000);
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: { reset: ["working_context_tokens"] },
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
		expect(profile("gateway:channel:gpt-5.5").contextWindow).toBe(444444);
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
		// The gateway's complete card is the discovered layer as-is.
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
		const rejected = resolveNugModelMeta(config.id, config.prefix, "gw:ch:m");
		expect(rejected.modelCard).toBeUndefined();
		// An old gateway's envelope still applies when the card is discarded.
		expect(rejected.metadata?.metadata).toEqual({ limits: { contextWindow: 333333 } });
		expect(profile("gw:ch:m").contextWindow).toBe(333333);
		expect(getNugCachedModelsByProvider(config.id)[0]?.modelCard).toBeUndefined();
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
		mutateModelCard({
			action: "upsert-model",
			baseRevision: 0,
			model: {
				id: "opaque-model",
				matches: { ids: ["namespace:model:thinking"] },
				metadata: { working_context_tokens: 77777 },
			},
		});
		expect(profile("relay:namespace:model:thinking").contextWindow).toBe(77777);
	});
});

describe("catalog update and API boundary", () => {
	test("deleting a base referenced by a local variant is rejected without revision or state changes", () => {
		mutateModelCard({
			action: "upsert-model",
			baseRevision: 0,
			model: { id: "local-parent", metadata: {} },
		});
		mutateModelCard({
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
		const before = getModelCardSnapshot();
		expect(() =>
			mutateModelCard({
				action: "delete",
				baseRevision: 2,
				target: "model",
				targetId: "local-parent",
			}),
		).toThrow();
		expect(getModelCardSnapshot()).toEqual(before);
	});
	test("preset removals retain locally referenced definitions through apply and rollback", async () => {
		const initial = getModelCardSnapshot();
		restoreVersion = initial.catalog.catalogVersion;
		mutateModelCard({
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
		expect(getModelCardSnapshot().local.models?.find((m) => m.id === "gpt-5.5")?.status).toBe(
			"deprecated",
		);
		expect(getModelCardSnapshot().local.variants?.some((v) => v.id === "local-preset-child")).toBe(
			true,
		);
		rollbackModelCatalog(initial.catalog.catalogVersion);
		expect(getModelCardSnapshot().local.variants?.some((v) => v.id === "local-preset-child")).toBe(
			true,
		);
	});
	test("check stages only, apply preserves overlays, pin blocks and rollback preserves edits", async () => {
		const initial = getModelCardSnapshot();
		restoreVersion = initial.catalog.catalogVersion;
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: { set: { input_cost_per_token: "0" } },
		});
		const updateVersion = await mockCatalog("integration-update", (c) => {
			c.models.find((m) => m.id === "gpt-5.5")!.metadata.input_cost_per_token = 0.000999;
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
					field.path === "input_cost_per_token" &&
					field.after === 0.000999,
			),
		).toBe(true);
		setModelCatalogUpdateSettings({ pinnedVersion: "different" });
		expect(() => applyModelCatalogUpdate()).toThrow();
		setModelCatalogUpdateSettings({ pinnedVersion: updateVersion });
		applyModelCatalogUpdate(updateVersion);
		expect(getModelCardSnapshot().update.pinnedVersion).toBe(updateVersion);
		setModelCatalogUpdateSettings({ pinnedVersion: null });
		expect(profile("codex:gpt-5.5").referencePricing?.input).toBe("0");
		mutate({
			action: "patch",
			target: "model",
			targetId: "gpt-5.5",
			patch: { set: { output_cost_per_token: perToken("1") } },
		});
		rollbackModelCatalog(initial.catalog.catalogVersion);
		expect(profile("codex:gpt-5.5").referencePricing?.output).toBe("1");
	});
	test("download corruption retains last good; concurrent checks are single flight", async () => {
		const initial = getModelCardSnapshot().catalog.catalogVersion;
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
		expect(getModelCardSnapshot().catalog.catalogVersion).toBe(initial);
		expect(getModelCardSnapshot().update.lastError).toBeDefined();
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
		const member = await app("user").request("/api/model-catalog/v2");
		const body = await member.json();
		expect(JSON.stringify(body.update.lastError)).not.toContain("/home/someone-private");
		expect(JSON.stringify(body)).not.toContain("someone-private");

		bindModelCatalogSettings(local, () => {
			throw new Error("EACCES: permission denied, open '/home/someone-private/.narrafork/x'");
		});
		const failed = await app().request("/api/model-catalog/v2/mutate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "patch",
				target: "model",
				targetId: "gpt-5.5",
				patch: { set: { input_cost_per_token: "0" } },
				baseRevision: getModelCardSnapshot().local.revision,
			}),
		});
		expect(failed.status).toBe(400);
		const errorBody = await failed.json();
		expect(errorBody.code).toBe("CATALOG_IO_ERROR");
		expect(errorBody.error).toBe("Model catalog operation failed");
		expect(JSON.stringify(errorBody)).not.toContain("someone-private");
		// Intentional validation prose without paths is preserved.
		const missing = await app().request("/api/model-catalog/v2/resolve");
		expect(missing.status).toBe(400);
		expect((await missing.json()).error).toContain("model is required");
	});
	test.each([
		true,
		false,
	])("accepts 1 MiB branch metadata without requesting commit patches (Content-Length: %s)", async (includeLength) => {
		expect(MAX_CATALOG_REVISION_BYTES).toBe(1024 * 1024);
		expect(MAX_CATALOG_BYTES).toBe(16 * 1024 * 1024);
		const initial = getModelCardSnapshot();
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
		const before = getModelCardSnapshot();
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
		const before = getModelCardSnapshot();
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
		const version = getModelCardSnapshot().catalog.catalogVersion;
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
		expect(getModelCardSnapshot().catalog.catalogVersion).toBe(version);
	});
	test("forbidden patch paths are rejected without mutating local state", () => {
		const before = getModelCardSnapshot().local;
		expect(() =>
			mutate({
				action: "patch",
				target: "model",
				targetId: "gpt-5.5",
				patch: { set: { "__proto__.polluted": true } },
			}),
		).toThrow();
		expect(getModelCardSnapshot().local).toEqual(before);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
	test("imported identity edits never turn complete preset metadata into local overrides", () => {
		const migrated = getDefaults();
		delete migrated.agent.modelCatalog;
		migrated.agent.modelCards = [{ modelKey: "gpt-5.5", displayName: "Migrated label" }];
		bindModelCatalogSettings(migrated, () => {});
		const model = getModelCardSnapshot().local.models?.find((m) => m.id === "gpt-5.5");
		expect(model?.name).toBe("Migrated label");
		expect(model?.metadata).toEqual({});
		expect(getEffectiveModelCard("codex:gpt-5.5").provenance.input_cost_per_token?.layer).not.toBe(
			"local-model",
		);
	});
	test("API allows member reads, denies writes, reports conflicts and returns actual scope", async () => {
		// The v1 surface is gone; only the raw contract is served.
		expect((await app("user").request("/api/model-catalog/resolve?model=x")).status).toBe(404);
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
		expect((await app("user").request("/api/model-catalog/v2/mutate", init)).status).toBe(403);
		expect((await app().request("/api/model-catalog/v2/mutate", init)).status).toBe(409);
		const resolved = await (
			await app().request("/api/model-catalog/v2/resolve?model=codex:gpt-5.5")
		).json();
		expect(resolved.resolvedQuery).toEqual({
			upstreamModelId: "gpt-5.5",
			providerId: "codex",
			providerKey: "codex",
		});
	});
});

describe("protected-field batch resolution", () => {
	test("hundreds of bindings prepare only three resolvers and preserve protection counts", async () => {
		const initial = getModelCardSnapshot();
		const version = await mockCatalog("batch-protection-398-bindings", (catalog) => {
			const model = catalog.models.find((entry) => entry.id === "gpt-5.5");
			if (typeof model?.metadata.max_input_tokens !== "number")
				throw new Error("Expected model limits");
			model.metadata.max_input_tokens = presetContextWindow + 1;
		});
		await checkModelCatalogUpdate();
		const cfg = local.agent.modelCatalog;
		if (!cfg) throw new Error("Expected initialized catalog");
		cfg.local.bindings = Array.from({ length: 398 }, (_, i) => ({
			id: `batch-binding-${i}`,
			upstreamModelId: "gpt-5.5",
			providerId: `batch-provider-${i}`,
			modelId: "gpt-5.5",
			overrides: { max_input_tokens: presetContextWindow * 2 },
		}));
		cfg.local.revision++;
		const prepare = spyOn(cardResolvers, "createModelCardResolver");
		try {
			const checked = getModelCardSnapshot();
			expect(checked.catalog.catalogVersion).toBe(initial.catalog.catalogVersion);
			expect(checked.update.pendingVersion).toBe(`v2:${version}`);
			expect(checked.update.protectedFieldCount).toBe(398);
			expect(prepare).toHaveBeenCalledTimes(3);
			const again = getModelCardSnapshot();
			expect(again).toEqual(checked);
			expect(prepare).toHaveBeenCalledTimes(3);
			// Neither a caller's view nor a cache hit may mutate future snapshots.
			if (again.update.pendingDiff?.fields) again.update.pendingDiff.fields.length = 0;
			expect(getModelCardSnapshot()).toEqual(checked);
		} finally {
			prepare.mockRestore();
		}
	});

	test("rebinding different local settings at the same revision invalidates the count", async () => {
		await mockCatalog("rebound-protection-cache", (catalog) => {
			const model = catalog.models.find((entry) => entry.id === "gpt-5.5");
			if (typeof model?.metadata.max_input_tokens !== "number")
				throw new Error("Expected model limits");
			model.metadata.max_input_tokens = presetContextWindow + 1;
		});
		const checked = await checkModelCatalogUpdate();
		expect(checked.update.protectedFieldCount).toBe(0);
		const rebound = structuredClone(local);
		const cfg = rebound.agent.modelCatalog;
		if (!cfg) throw new Error("Expected initialized catalog");
		cfg.local.bindings = [
			{
				id: "rebound-binding",
				upstreamModelId: "gpt-5.5",
				providerId: "rebound-provider",
				modelId: "gpt-5.5",
				overrides: { max_input_tokens: presetContextWindow * 2 },
			},
		];
		bindModelCatalogSettings(rebound, () => {});
		const after = getModelCardSnapshot();
		expect(after.local.revision).toBe(checked.local.revision);
		expect(after.update.pendingVersion).toBe(checked.update.pendingVersion);
		expect(after.update.protectedFieldCount).toBe(1);
	});
});
