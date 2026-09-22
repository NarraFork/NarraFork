/** NarraFork-owned model metadata storage and runtime integration. */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelCard } from "@shared/model-card";
import bundledJSON from "@shared/model-catalog/dist/catalog.json";
import type {
	CatalogUpdateStatus,
	ModelCatalogMutation,
	ModelCatalogSnapshot,
} from "@shared/model-catalog/schema/api";
import type {
	CatalogDocument,
	LocalCatalogState,
	ModelMetadata,
	ModelQuery,
	ResolvedModelMetadata,
} from "@shared/model-catalog/schema/catalog";
import {
	applyMetadataPatch,
	createModelMetadataResolver,
	resolveModelMetadata,
	validateCatalog,
	validateMetadata,
} from "@shared/model-catalog/src/index";
import { getNarraforkHome } from "../narrafork-home";
import { resolveNugModelMeta } from "../nug-model-cache";
import type { NarraForkSettings } from "../settings/types";
import {
	CATALOG_ARCHIVE_BASE,
	CATALOG_REVISION_URL,
	catalogFromArchive,
	MAX_CATALOG_BYTES,
	parseCatalogRevision,
} from "./source";

export interface ModelCatalogSettings {
	schemaVersion: 1;
	migrationVersion: 1;
	local: LocalCatalogState;
	autoApply: boolean;
	pinnedVersion: string | null;
	/** Preserved verbatim for export/audit; never used as a second resolver. */
	legacyArchive?: {
		modelCards: ModelCard[];
		modelContextWindows: Record<string, number>;
		pricingOverrides: unknown;
	};
}
const bundled = validateCatalog(bundledJSON);
const directory = resolve(getNarraforkHome(), "model-catalog");
const cachePath = resolve(directory, "snapshots.json");
let active = bundled;
let pending: CatalogDocument | undefined;
let history: CatalogDocument[] = [];
let lastCheckedAt: string | undefined;
let lastError: string | undefined;
let etag: string | undefined;
let settingsRef: NarraForkSettings | undefined;
let persistSettings: (() => void) | undefined;
let observedLegacyWindows: Record<string, number> = {};
let checking: Promise<ModelCatalogSnapshot> | undefined;
const requestSnapshots = new AsyncLocalStorage<{
	catalog: CatalogDocument;
	local: LocalCatalogState;
	resolved: Map<string, ResolvedModelMetadata>;
}>();

function atomicJSON(path: string, value: unknown): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
	renameSync(tmp, path);
}
function saveCache(next = active, nextHistory = history): void {
	atomicJSON(cachePath, {
		active: next,
		history: nextHistory,
		pending,
		lastCheckedAt,
		lastError,
		etag,
	});
}
try {
	if (existsSync(cachePath)) {
		const value = JSON.parse(readFileSync(cachePath, "utf8"));
		active = validateCatalog(value.active);
		history = (value.history ?? []).map(validateCatalog).slice(0, 5);
		if (value.pending) pending = validateCatalog(value.pending);
		lastCheckedAt = value.lastCheckedAt;
		etag = value.etag;
	}
} catch (error) {
	lastError = `Cached catalog rejected; using bundled snapshot: ${String(error)}`;
}

export function legacyCardMetadata(card: ModelCard): ModelMetadata {
	const metadata: ModelMetadata = {};
	if (card.contextWindow && card.contextWindow > 0)
		metadata.limits = { contextWindow: card.contextWindow };
	if (card.maxCompletionTokens && card.maxCompletionTokens > 0)
		metadata.limits = { ...metadata.limits, maxOutputTokens: card.maxCompletionTokens };
	if (card.effortLevels?.length)
		metadata.reasoning = {
			supported: true,
			mode: "levels",
			levels: card.effortLevels.filter((level) => level !== "none"),
		};
	if (card.officialPricing) {
		metadata.referencePricing = { currency: "USD", unit: "perMillionTokens" };
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const value = card.officialPricing[field];
			// Legacy card zero meant unset, unlike explicit decimal zero in the new contract.
			if (value != null && value > 0) metadata.referencePricing[field] = String(value);
		}
	}
	return metadata;
}

export function queryForModel(model: string): { query: ModelQuery; discovered?: ModelMetadata } {
	model = model.trim();
	const configs = [
		...(settingsRef?.customApiProviders ?? []),
		...(settingsRef?.openaiProviders ?? []),
		...(settingsRef?.anthropicProviders ?? []),
		...(settingsRef?.geminiProviders ?? []),
		...(settingsRef?.nugProviders ?? []),
	];
	const config = configs.find((c) => c.prefix && model.startsWith(`${c.prefix}:`));
	const knownPrefix =
		config?.prefix ??
		["codex", "anthropic", "openai", "gemini"].find((p) => model.startsWith(`${p}:`));
	const upstreamModelId = knownPrefix ? model.slice(knownPrefix.length + 1) : model;
	const query: ModelQuery = {
		upstreamModelId,
		providerId: config?.id ?? knownPrefix,
		// A local connection prefix is not a public channel type. Leaving it
		// unknown permits an explicit binding to identify the public variant.
		providerKey:
			knownPrefix && ["codex", "anthropic", "openai", "gemini"].includes(knownPrefix)
				? knownPrefix
				: undefined,
	};
	const nug = settingsRef?.nugProviders?.find((c) => c.id === config?.id);
	if (nug && knownPrefix) {
		try {
			const info = resolveNugModelMeta(nug.id, knownPrefix, model);
			query.channelId = info.channel;
			query.providerKey = info.channelType;
			query.upstreamModelId = info.bareModel;
			const discovered: ModelMetadata = info.metadata?.metadata ?? {
				...(info.contextWindow ? { limits: { contextWindow: info.contextWindow } } : {}),
				...(info.effortLevels
					? { reasoning: { levels: info.effortLevels, mode: "levels" as const } }
					: {}),
			};
			return { query, discovered };
		} catch {
			/* Old gateway without cache: keep opaque upstream identity. */
		}
	}
	return { query };
}

/** Conservative, idempotent migration. Old values are archived before any write. */
export function bindModelCatalogSettings(settings: NarraForkSettings, save: () => void): void {
	settingsRef = settings;
	persistSettings = save;
	observedLegacyWindows = structuredClone(settings.agent.modelContextWindows ?? {});
	if (settings.agent.modelCatalog && settings.agent.modelCatalog.schemaVersion !== 1)
		throw new Error("Unsupported model catalog storage schema; refusing downgrade");
	if (settings.agent.modelCatalog) return;
	const legacyArchive = {
		modelCards: structuredClone(settings.agent.modelCards ?? []),
		modelContextWindows: structuredClone(settings.agent.modelContextWindows ?? {}),
		pricingOverrides: structuredClone(settings.pricing?.overrides ?? {}),
	};
	atomicJSON(resolve(directory, "legacy-settings-backup.json"), settings);
	const local: Required<LocalCatalogState> = {
		revision: 0,
		models: [],
		variants: [],
		bindings: [],
		overrides: [],
		hiddenModelIds: [],
		hiddenVariantIds: [],
	};
	// Prefix/suffix matches borrow capabilities, not identity. Never migrate a
	// distinct legacy key (e.g. gpt-5.5-mini) onto its broader preset model.
	const identity = (key: string, layer?: LocalCatalogState): string => {
		// Identity lookup needs no metadata resolution/validation. In particular,
		// resolving the growing user layer once per card makes bulk migration costly.
		const models = new Map(active.models.map((model) => [model.id, model]));
		for (const model of layer?.models ?? []) models.set(model.id, model);
		const definitions = [...models.values()];
		const exact = definitions.filter(
			(model) => model.id === key || model.matches?.ids?.includes(key),
		);
		const candidates = exact.length
			? exact
			: definitions.filter((model) => model.matches?.aliases?.includes(key));
		if (candidates.length > 1) throw new Error(`Ambiguous legacy model identity: ${key}`);
		return candidates[0]?.id ?? key;
	};
	// Aliases may converge on one target. Merge their fields once, with canonical
	// cards taking precedence regardless of input order (last wins among duplicates).
	const cards = legacyArchive.modelCards
		.map((card) => ({ card, id: identity(card.modelKey) }))
		.sort((a, b) => Number(a.card.modelKey === a.id) - Number(b.card.modelKey === b.id));
	for (const { card, id } of cards) {
		const base = local.models.find((m) => m.id === id) ?? active.models.find((m) => m.id === id);
		local.hiddenModelIds = local.hiddenModelIds.filter((hidden) => hidden !== id);
		if (card.deleted) {
			// An exact tombstone must also participate in matching, or a weak preset
			// match could resurrect a deleted custom model.
			if (!base) local.models.push({ id, metadata: {} });
			local.hiddenModelIds.push(id);
			continue;
		}
		if (
			!base ||
			card.aliases ||
			card.matchPrefixes ||
			card.displayName ||
			card.family ||
			card.notes
		) {
			local.models = local.models.filter((model) => model.id !== id);
			local.models.push({
				...(base ?? { id }),
				metadata: {},
				name: card.displayName ?? base?.name,
				family: card.family ?? base?.family,
				notes: card.notes ?? base?.notes,
				matches: {
					...base?.matches,
					...(card.aliases ? { aliases: card.aliases } : {}),
					...(card.matchPrefixes
						? { prefixes: card.matchPrefixes, fields: ["limits", "reasoning"] }
						: {}),
				},
			});
		}
		const previous = local.overrides.find((o) => o.target === "model" && o.targetId === id);
		const incoming = legacyCardMetadata(card);
		const set: Record<string, unknown> = {};
		for (const [section, fields] of Object.entries(incoming))
			for (const [field, value] of Object.entries(fields ?? {})) set[`${section}.${field}`] = value;
		const contextWindow =
			incoming.limits?.contextWindow ?? previous?.metadata.limits?.contextWindow;
		const previousOutput =
			incoming.limits?.maxOutputTokens ??
			previous?.metadata.limits?.maxOutputTokens ??
			active.models.find((m) => m.id === id)?.metadata.limits?.maxOutputTokens;
		if (contextWindow && previousOutput && previousOutput > contextWindow)
			set["limits.maxOutputTokens"] = contextWindow;
		const metadata = applyMetadataPatch(previous?.metadata ?? {}, { set });
		local.overrides = local.overrides.filter((o) => o !== previous);
		local.overrides.push({ target: "model", targetId: id, metadata, source: "legacy-local" });
	}
	for (const [key, pricing] of Object.entries(settings.pricing?.overrides ?? {})) {
		const id = identity(key, local);
		if (!active.models.some((m) => m.id === id) && !local.models.some((m) => m.id === id))
			local.models.push({ id, metadata: {} });
		let override = local.overrides.find((o) => o.target === "model" && o.targetId === id);
		if (!override) {
			override = { target: "model", targetId: id, metadata: {}, source: "legacy-local" };
			local.overrides.push(override);
		}
		override.metadata.referencePricing ??= { currency: "USD", unit: "perMillionTokens" };
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const value = pricing[field];
			if (typeof value === "number" && Number.isFinite(value) && value >= 0)
				override.metadata.referencePricing[field] = String(value);
		}
	}
	for (const [model, window] of Object.entries(legacyArchive.modelContextWindows)) {
		if (!Number.isInteger(window) || window <= 0) continue;
		const { query } = queryForModel(model);
		const matched = resolveModelMetadata({ catalog: active, local, query });
		local.bindings.push({
			id: `legacy-window:${model}`,
			providerId: query.providerId,
			channelId: query.channelId,
			upstreamModelId: query.upstreamModelId,
			// A window override must not upgrade a weak match to an exact identity.
			...((matched.matchedVia === "exact" || matched.matchedVia === "alias") && {
				modelId: matched.modelId,
				variantId: matched.variantId,
			}),
		});
		local.overrides.push({
			target: "binding",
			targetId: `legacy-window:${model}`,
			metadata: {
				limits: {
					contextWindow: window,
					...(matched.metadata.limits?.maxOutputTokens &&
					matched.metadata.limits.maxOutputTokens > window
						? { maxOutputTokens: window }
						: {}),
				},
			},
			source: "legacy-local",
		});
	}
	settings.agent.modelCatalog = {
		schemaVersion: 1,
		migrationVersion: 1,
		local,
		autoApply: false,
		pinnedVersion: null,
		legacyArchive,
	};
	save();
}
/** Adapt the remaining legacy per-model window settings editor to binding patches.
 * Only changed inputs are considered; untouched legacy values never re-pin reset fields. */
export function reconcileLegacyWindowSettings(nextSettings: NarraForkSettings): void {
	const cfg = nextSettings.agent.modelCatalog;
	if (!cfg) return;
	const windows = nextSettings.agent.modelContextWindows ?? {};
	const changed = [
		...new Set([...Object.keys(observedLegacyWindows), ...Object.keys(windows)]),
	].filter((key) => observedLegacyWindows[key] !== windows[key]);
	if (!changed.length) return;
	const local = structuredClone(cfg.local);
	const oldSettings = settingsRef;
	settingsRef = nextSettings;
	try {
		for (const model of changed) {
			const id = `legacy-window:${model}`;
			const value = windows[model];
			local.bindings ??= [];
			local.overrides ??= [];
			const old = local.overrides.find((o) => o.target === "binding" && o.targetId === id);
			const metadata = applyMetadataPatch(old?.metadata ?? {}, {
				reset: ["limits.contextWindow", "limits.maxOutputTokens"],
			});
			if (value !== undefined) {
				if (!Number.isInteger(value) || value <= 0)
					throw new Error("Context window must be a positive integer");
				const { query } = queryForModel(model);
				const resolved = resolveModelMetadata({ catalog: active, local, query });
				if (!local.bindings.some((b) => b.id === id))
					local.bindings.push({
						id,
						providerId: query.providerId,
						channelId: query.channelId,
						upstreamModelId: query.upstreamModelId,
						...((resolved.matchedVia === "exact" || resolved.matchedVia === "alias") && {
							modelId: resolved.modelId,
							variantId: resolved.variantId,
						}),
					});
				metadata.limits = {
					contextWindow: value,
					...(resolved.metadata.limits?.maxOutputTokens &&
					resolved.metadata.limits.maxOutputTokens > value
						? { maxOutputTokens: value }
						: {}),
				};
			}
			local.overrides = local.overrides.filter((o) => o !== old);
			if (Object.keys(metadata).length)
				local.overrides.push({ target: "binding", targetId: id, metadata, source: "user" });
			else local.bindings = local.bindings.filter((b) => b.id !== id);
		}
		validateLocal(local);
		cfg.local = { ...local, revision: cfg.local.revision + 1 };
	} finally {
		settingsRef = oldSettings;
	}
}
export function markLegacyWindowSettingsSaved(value: NarraForkSettings): void {
	observedLegacyWindows = structuredClone(value.agent.modelContextWindows ?? {});
}
function state(): ModelCatalogSettings {
	if (!settingsRef?.agent.modelCatalog) throw new Error("Model catalog not initialized");
	return settingsRef.agent.modelCatalog;
}
export function isModelCatalogBound(): boolean {
	return !!settingsRef?.agent.modelCatalog;
}
export function getEffectiveModelMetadata(model: string): ResolvedModelMetadata {
	const cache = requestSnapshots.getStore()?.resolved;
	const cached = cache?.get(model);
	if (cached) return structuredClone(cached);
	const { query, discovered } = queryForModel(model);
	const resolved = resolveEffectiveMetadata(query, discovered);
	cache?.set(model, resolved);
	return structuredClone(resolved);
}
export function resolveEffectiveMetadata(
	query: ModelQuery,
	discovered?: ModelMetadata,
): ResolvedModelMetadata {
	const snapshot = requestSnapshots.getStore();
	return resolveModelMetadata({
		catalog: snapshot?.catalog ?? active,
		local: snapshot?.local ?? settingsRef?.agent.modelCatalog?.local,
		query,
		discovered,
	});
}
/** Immutable request-local snapshot, including local overlays. */
export function withModelMetadataSnapshot<T>(work: () => T): T {
	// Nested request trackers keep the iterator's already captured snapshot.
	if (requestSnapshots.getStore()) return work();
	return requestSnapshots.run(
		{
			catalog: active,
			local: structuredClone(settingsRef?.agent.modelCatalog?.local ?? { revision: 0 }),
			resolved: new Map(),
		},
		work,
	);
}
/** An async generator is lazy: bind EVERY iterator operation, not just creation.
 * AsyncLocalStorage.run isolates concurrent generators and restores caller context
 * even when next/return/throw rejects or executes finally blocks after a yield. */
export function withModelMetadataSnapshotIterator<T, R = unknown, N = unknown>(
	factory: () => AsyncGenerator<T, R, N>,
): AsyncGenerator<T, R, N> {
	const snapshot = {
		catalog: active,
		local: structuredClone(settingsRef?.agent.modelCatalog?.local ?? { revision: 0 }),
		resolved: new Map<string, ResolvedModelMetadata>(),
	};
	const iterator = requestSnapshots.run(snapshot, factory);
	const wrapped = new Proxy(iterator, {
		get(target, property) {
			if (property === Symbol.asyncIterator) return () => wrapped;
			if (property === "next")
				return (...args: [] | [N]) => requestSnapshots.run(snapshot, () => target.next(...args));
			if (property === "return")
				return (value: R | PromiseLike<R>) =>
					requestSnapshots.run(snapshot, () => target.return(value));
			if (property === "throw")
				return (error: unknown) => requestSnapshots.run(snapshot, () => target.throw(error));
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return wrapped;
}
function diffCatalog(next: CatalogDocument) {
	const before = new Map(
		[...active.models, ...active.variants].map((m) => [m.id, JSON.stringify(m)]),
	);
	const after = new Map([...next.models, ...next.variants].map((m) => [m.id, JSON.stringify(m)]));
	const fields: Array<{
		target: "model" | "variant";
		id: string;
		path: string;
		before?: unknown;
		after?: unknown;
	}> = [];
	const leaves = (value: object, prefix = ""): Map<string, unknown> => {
		const result = new Map<string, unknown>();
		for (const [key, entry] of Object.entries(value)) {
			const path = prefix ? `${prefix}.${key}` : key;
			if (entry && typeof entry === "object" && !Array.isArray(entry))
				for (const [nested, item] of leaves(entry, path)) result.set(nested, item);
			else result.set(path, entry);
		}
		return result;
	};
	for (const target of ["model", "variant"] as const) {
		const previous = new Map(
			(target === "model" ? active.models : active.variants).map((entry) => [
				entry.id,
				entry.metadata,
			]),
		);
		const incoming = new Map(
			(target === "model" ? next.models : next.variants).map((entry) => [entry.id, entry.metadata]),
		);
		for (const id of new Set([...previous.keys(), ...incoming.keys()])) {
			const oldLeaves = leaves(previous.get(id) ?? {});
			const newLeaves = leaves(incoming.get(id) ?? {});
			for (const path of new Set([...oldLeaves.keys(), ...newLeaves.keys()]))
				if (JSON.stringify(oldLeaves.get(path)) !== JSON.stringify(newLeaves.get(path)))
					fields.push({
						target,
						id,
						path,
						before: oldLeaves.get(path),
						after: newLeaves.get(path),
					});
		}
	}
	return {
		fields,
		added: [...after.keys()].filter((k) => !before.has(k)),
		changed: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)),
		removed: [...before.keys()].filter((k) => !after.has(k)),
	};
}
let protectedCountCache: { version: string; revision: number; count: number } | undefined;
function protectedFieldCount(next: CatalogDocument, local: LocalCatalogState): number {
	if (
		protectedCountCache?.version === next.catalogVersion &&
		protectedCountCache.revision === local.revision
	)
		return protectedCountCache.count;
	const inherited: LocalCatalogState = {
		...local,
		overrides: [],
		models: local.models?.map((model) => ({ ...model, metadata: {} })),
		variants: local.variants?.map((variant) => ({ ...variant, metadata: {} })),
		bindings: local.bindings?.map((binding) => ({ ...binding, overrides: undefined })),
	};
	const modelIds = new Set([
		...(local.overrides ?? []).filter((o) => o.target === "model").map((o) => o.targetId),
		...(local.models ?? []).filter((m) => Object.keys(m.metadata).length).map((m) => m.id),
	]);
	const variantIds = new Set([
		...(local.overrides ?? []).filter((o) => o.target === "variant").map((o) => o.targetId),
		...(local.variants ?? []).filter((v) => Object.keys(v.metadata).length).map((v) => v.id),
	]);
	const bindingIds = new Set(
		(local.overrides ?? []).filter((o) => o.target === "binding").map((o) => o.targetId),
	);
	const queries: ModelQuery[] = [
		...active.models
			.filter((model) => modelIds.has(model.id) && !local.hiddenModelIds?.includes(model.id))
			.map((model) => ({ upstreamModelId: model.id, modelId: model.id })),
		...active.variants
			.filter(
				(variant) =>
					(modelIds.has(variant.modelId) || variantIds.has(variant.id)) &&
					!local.hiddenModelIds?.includes(variant.modelId) &&
					!local.hiddenVariantIds?.includes(variant.id),
			)
			.map((variant) => ({
				upstreamModelId: variant.upstreamModelIds[0] ?? variant.id,
				variantId: variant.id,
				providerKey: variant.providerKey,
			})),
		...(local.bindings ?? [])
			.filter(
				(binding) =>
					bindingIds.has(binding.id) ||
					Object.keys(binding.overrides ?? {}).length ||
					(binding.modelId && modelIds.has(binding.modelId)) ||
					(binding.variantId && variantIds.has(binding.variantId)),
			)
			.map((binding) => ({
				upstreamModelId: binding.upstreamModelId,
				providerId: binding.providerId,
				channelId: binding.channelId,
			})),
	];
	const valueAt = (metadata: ModelMetadata, path: string): unknown =>
		path
			.split(".")
			.reduce<unknown>(
				(value, key) =>
					value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined,
				metadata,
			);
	const resolve = (catalog: CatalogDocument, state: LocalCatalogState, query: ModelQuery) => {
		try {
			return resolveModelMetadata({ catalog, local: state, query });
		} catch {
			return undefined;
		}
	};
	let count = 0;
	for (const query of queries) {
		const current = resolve(active, local, query);
		if (!current) continue;
		const before = resolve(active, inherited, query)?.metadata ?? {};
		const after = resolve(next, inherited, query)?.metadata ?? {};
		for (const [path, source] of Object.entries(current.provenance))
			if (
				source.explicit &&
				JSON.stringify(valueAt(before, path)) !== JSON.stringify(valueAt(after, path))
			)
				count++;
	}
	protectedCountCache = { version: next.catalogVersion, revision: local.revision, count };
	return count;
}
export function getModelCatalogSnapshot(): ModelCatalogSnapshot {
	const cfg = state();
	const update: CatalogUpdateStatus & { protectedFieldCount: number } = {
		activeVersion: active.catalogVersion,
		protectedFieldCount: pending ? protectedFieldCount(pending, cfg.local) : 0,
		bundledVersion: bundled.catalogVersion,
		lastCheckedAt,
		lastError,
		pendingVersion: pending?.catalogVersion,
		autoApply: cfg.autoApply,
		pinnedVersion: cfg.pinnedVersion,
		history: history.map((c) => ({ catalogVersion: c.catalogVersion, publishedAt: c.publishedAt })),
		...(pending ? { pendingDiff: diffCatalog(pending) } : {}),
	};
	return structuredClone({ catalog: active, local: cfg.local, update });
}
export class CatalogRevisionConflict extends Error {}

/** Compatibility view only: never used for metadata resolution or cost matching. */
export function getLegacyModelCards(): {
	cards: ModelCard[];
	provenance: Record<string, string[]>;
} {
	const cfg = state();
	const models = new Map(active.models.map((m) => [m.id, m]));
	for (const model of cfg.local.models ?? []) models.set(model.id, model);
	const cards: ModelCard[] = [];
	const provenance: Record<string, string[]> = {};
	const scope = requestSnapshots.getStore();
	const resolve = createModelMetadataResolver(scope?.catalog ?? active, scope?.local ?? cfg.local);
	for (const model of models.values()) {
		if (cfg.local.hiddenModelIds?.includes(model.id)) continue;
		const result = resolve({ upstreamModelId: model.id, modelId: model.id });
		const m = result.metadata;
		const card: ModelCard = {
			modelKey: model.id,
			displayName: model.name,
			family: model.family,
			notes: model.notes,
			aliases: model.matches?.aliases,
			matchPrefixes: model.matches?.prefixes,
			builtin: active.models.some((v) => v.id === model.id),
			contextWindow: m.limits?.contextWindow ?? undefined,
			maxCompletionTokens: m.limits?.maxOutputTokens ?? undefined,
		};
		if (m.reasoning?.levels)
			card.effortLevels = m.reasoning.levels.filter(
				(v): v is NonNullable<ModelCard["effortLevels"]>[number] =>
					["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(v),
			);
		if (m.referencePricing) {
			card.officialPricing = {};
			for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
				if (m.referencePricing[key] != null)
					card.officialPricing[key] = Number(m.referencePricing[key]);
		}
		cards.push(card);
		provenance[model.id] = Object.entries(result.provenance)
			.filter(([, source]) => source.explicit)
			.map(([path]) => path);
	}
	return { cards, provenance };
}

/** Old clients can edit only old leaves; all new capability fields survive. */
export function saveLegacyModelCard(key: string, card: ModelCard | null, reset = false): void {
	const cfg = state();
	const local = structuredClone(cfg.local);
	const id =
		resolveModelMetadata({ catalog: active, query: { upstreamModelId: key } }).modelId ?? key;
	if (!card && !reset) {
		if (active.models.some((m) => m.id === id))
			local.hiddenModelIds = [...new Set([...(local.hiddenModelIds ?? []), id])];
		else {
			local.models = local.models?.filter((m) => m.id !== id);
			local.overrides = local.overrides?.filter((o) => o.target !== "model" || o.targetId !== id);
		}
	} else {
		local.hiddenModelIds = local.hiddenModelIds?.filter((v) => v !== id);
		const old = local.overrides?.find((o) => o.target === "model" && o.targetId === id);
		const legacyPaths = [
			"limits.contextWindow",
			"limits.maxOutputTokens",
			"reasoning.levels",
			"reasoning.mode",
			"reasoning.supported",
			"referencePricing.input",
			"referencePricing.output",
			"referencePricing.cacheRead",
			"referencePricing.cacheWrite",
		];
		let metadata = applyMetadataPatch(old?.metadata ?? {}, { reset: legacyPaths });
		if (card) {
			const incoming = legacyCardMetadata(card);
			// Legacy forms allowed shrinking context independently of the displayed output.
			// Preserve the requested window and constrain the executable output to it.
			const inheritedOutput = active.models.find((m) => m.id === id)?.metadata.limits
				?.maxOutputTokens;
			if (
				incoming.limits?.contextWindow &&
				inheritedOutput &&
				inheritedOutput > incoming.limits.contextWindow &&
				!incoming.limits.maxOutputTokens
			)
				incoming.limits.maxOutputTokens = incoming.limits.contextWindow;
			const set: Record<string, unknown> = {};
			for (const [section, fields] of Object.entries(incoming))
				for (const [field, value] of Object.entries(fields ?? {}))
					set[`${section}.${field}`] = value;
			metadata = applyMetadataPatch(metadata, { set });
			const base = active.models.find((m) => m.id === id);
			const existing = local.models?.find((m) => m.id === id);
			local.models = [
				...(local.models ?? []).filter((m) => m.id !== id),
				{
					...(base ?? existing ?? { id }),
					metadata: existing?.metadata ?? {},
					name: card.displayName,
					family: card.family,
					notes: card.notes,
					matches: {
						ids: base?.matches?.ids,
						aliases: card.aliases,
						prefixes: card.matchPrefixes,
						volatileSuffixes: base?.matches?.volatileSuffixes,
						fields: base?.matches?.fields ?? ["limits", "reasoning"],
					},
				},
			];
		} else if (reset) local.models = local.models?.filter((m) => m.id !== id);
		local.overrides = (local.overrides ?? []).filter(
			(o) => o.target !== "model" || o.targetId !== id,
		);
		if (Object.keys(metadata).length)
			local.overrides.push({ target: "model", targetId: id, metadata, source: "user" });
	}
	validateLocal(local);
	local.revision++;
	const previous = cfg.local;
	cfg.local = local;
	try {
		persistSettings?.();
	} catch (error) {
		cfg.local = previous;
		throw error;
	}
}
function validateLocal(local: LocalCatalogState, catalog = active): void {
	const models = new Map(catalog.models.map((m) => [m.id, m]));
	for (const model of local.models ?? []) models.set(model.id, model);
	const variants = new Map(catalog.variants.map((v) => [v.id, v]));
	for (const variant of local.variants ?? []) variants.set(variant.id, variant);
	const resolve = createModelMetadataResolver(catalog, local);
	for (const o of local.overrides ?? []) {
		validateMetadata(o.metadata);
		const exists =
			o.target === "model"
				? models.has(o.targetId)
				: o.target === "variant"
					? variants.has(o.targetId)
					: local.bindings?.some((b) => b.id === o.targetId);
		if (!exists) throw new Error(`Unknown ${o.target} override target ${o.targetId}`);
	}
	for (const m of models.values())
		if (!local.hiddenModelIds?.includes(m.id)) resolve({ upstreamModelId: m.id, modelId: m.id });
	for (const v of variants.values())
		if (!local.hiddenModelIds?.includes(v.modelId) && !local.hiddenVariantIds?.includes(v.id))
			resolve({
				upstreamModelId: v.upstreamModelIds[0] ?? v.id,
				variantId: v.id,
				providerKey: v.providerKey,
			});
	for (const b of local.bindings ?? [])
		resolve({
			upstreamModelId: b.upstreamModelId,
			providerId: b.providerId,
			channelId: b.channelId,
		});
}
export function mutateModelCatalog(mutation: ModelCatalogMutation): ModelCatalogSnapshot {
	const cfg = state();
	if (mutation.baseRevision !== cfg.local.revision)
		throw new CatalogRevisionConflict("Model metadata changed; reload before saving");
	const local = structuredClone(cfg.local);
	const upsert = <T extends { id: string }>(items: T[] | undefined, item: T): T[] => [
		...(items ?? []).filter((v) => v.id !== item.id),
		item,
	];
	switch (mutation.action) {
		case "upsert-model":
			local.models = upsert(local.models, mutation.model);
			break;
		case "upsert-variant":
			local.variants = upsert(local.variants, mutation.variant);
			break;
		case "upsert-binding":
			local.bindings = upsert(local.bindings, mutation.binding);
			break;
		case "patch": {
			const old = local.overrides?.find(
				(o) => o.target === mutation.target && o.targetId === mutation.targetId,
			);
			const metadata = applyMetadataPatch(old?.metadata ?? {}, mutation.patch);
			// "Inherit" removes every local value at this target, including values
			// supplied at creation. Do this in the same revision/persistence transaction
			// as the patch so an old definition cannot reappear beneath an override.
			if (mutation.patch.reset?.length) {
				const reset = { reset: mutation.patch.reset };
				if (mutation.target === "binding") {
					const binding = local.bindings?.find((b) => b.id === mutation.targetId);
					if (binding?.overrides) binding.overrides = applyMetadataPatch(binding.overrides, reset);
				} else {
					const entries = mutation.target === "model" ? local.models : local.variants;
					const entry = entries?.find((item) => item.id === mutation.targetId);
					if (entry) entry.metadata = applyMetadataPatch(entry.metadata, reset);
				}
			}
			if (JSON.stringify(metadata) !== JSON.stringify(old?.metadata ?? {})) {
				local.overrides = (local.overrides ?? []).filter((o) => o !== old);
				if (Object.keys(metadata).length)
					local.overrides.push({
						target: mutation.target,
						targetId: mutation.targetId,
						metadata,
						source: "user",
					});
			}
			break;
		}
		case "hide":
		case "restore":
		case "delete": {
			if (mutation.target === "binding") {
				local.bindings = (local.bindings ?? []).filter((b) => b.id !== mutation.targetId);
				local.overrides = local.overrides?.filter(
					(o) => o.target !== "binding" || o.targetId !== mutation.targetId,
				);
			} else {
				const field = mutation.target === "model" ? "hiddenModelIds" : "hiddenVariantIds";
				local[field] = (local[field] ?? []).filter((id) => id !== mutation.targetId);
				if (mutation.action === "hide") local[field]!.push(mutation.targetId);
				if (mutation.action === "delete") {
					if (mutation.target === "model")
						local.models = local.models?.filter((m) => m.id !== mutation.targetId);
					else local.variants = local.variants?.filter((m) => m.id !== mutation.targetId);
					local.overrides = local.overrides?.filter(
						(o) => o.target !== mutation.target || o.targetId !== mutation.targetId,
					);
				}
			}
			break;
		}
		default:
			throw new Error("Unknown catalog mutation");
	}
	validateLocal(local);
	if (JSON.stringify(local) === JSON.stringify(cfg.local)) return getModelCatalogSnapshot();
	local.revision++;
	const previous = cfg.local;
	cfg.local = local;
	try {
		persistSettings?.();
	} catch (error) {
		cfg.local = previous;
		throw error;
	}
	return getModelCatalogSnapshot();
}
async function boundedDownload(
	url: string,
	max: number,
	headers?: Record<string, string>,
): Promise<{ bytes?: Uint8Array; etag?: string }> {
	const response = await fetch(url, {
		headers: { "User-Agent": "NarraFork", ...headers },
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
	});
	if (response.status === 304) return {};
	if (!response.ok) throw new Error(`Catalog download HTTP ${response.status}`);
	if (Number(response.headers.get("content-length")) > max)
		throw new Error("Catalog download exceeds size limit");
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Empty catalog response");
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			total += result.value.byteLength;
			if (total > max) throw new Error("Catalog download exceeds size limit");
			chunks.push(result.value);
		}
	} finally {
		await reader.cancel();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, etag: response.headers.get("etag") ?? undefined };
}
export function checkModelCatalogUpdate(): Promise<ModelCatalogSnapshot> {
	if (checking) return checking;
	checking = (async () => {
		try {
			const revisionDownload = await boundedDownload(
				CATALOG_REVISION_URL,
				64 * 1024,
				etag ? { "If-None-Match": etag } : undefined,
			);
			lastCheckedAt = new Date().toISOString();
			if (revisionDownload.bytes) {
				const revision = parseCatalogRevision(
					JSON.parse(new TextDecoder().decode(revisionDownload.bytes)),
				);
				const archive = await boundedDownload(
					`${CATALOG_ARCHIVE_BASE}${revision.version}`,
					MAX_CATALOG_BYTES,
				);
				if (!archive.bytes) throw new Error("Empty catalog archive");
				const candidate = await catalogFromArchive(
					archive.bytes,
					revision.version,
					revision.publishedAt,
				);
				validateLocal(archiveReferencedDefinitions(state().local, candidate), candidate);
				pending = candidate.catalogVersion === active.catalogVersion ? undefined : candidate;
				etag = revisionDownload.etag;
			}
			lastError = undefined;
			saveCache();
			if (
				pending &&
				state().autoApply &&
				(!state().pinnedVersion || state().pinnedVersion === pending.catalogVersion)
			)
				applyModelCatalogUpdate(pending.catalogVersion);
		} catch (error) {
			lastError = String(error);
			saveCache();
		}
		return getModelCatalogSnapshot();
	})().finally(() => {
		checking = undefined;
	});
	return checking;
}
function archiveReferencedDefinitions(
	local: LocalCatalogState,
	next: CatalogDocument,
): LocalCatalogState {
	const archived = structuredClone(local);
	const modelIds = new Set(
		(local.overrides ?? []).filter((o) => o.target === "model").map((o) => o.targetId),
	);
	const variantIds = new Set(
		(local.overrides ?? []).filter((o) => o.target === "variant").map((o) => o.targetId),
	);
	for (const binding of local.bindings ?? []) {
		if (binding.modelId) modelIds.add(binding.modelId);
		if (binding.variantId) variantIds.add(binding.variantId);
	}
	for (const variant of local.variants ?? []) modelIds.add(variant.modelId);
	for (const id of variantIds) {
		if (next.variants.some((v) => v.id === id) || archived.variants?.some((v) => v.id === id))
			continue;
		const previous = active.variants.find((v) => v.id === id);
		if (previous) {
			archived.variants ??= [];
			archived.variants.push({ ...previous, status: "deprecated" });
			modelIds.add(previous.modelId);
		}
	}
	for (const id of modelIds) {
		if (next.models.some((v) => v.id === id) || archived.models?.some((v) => v.id === id)) continue;
		const previous = active.models.find((v) => v.id === id);
		if (previous) {
			archived.models ??= [];
			archived.models.push({
				...previous,
				status: "deprecated",
				notes:
					`${previous.notes ?? ""}\nArchived: removed from public catalog ${next.catalogVersion}`.trim(),
			});
		}
	}
	return archived;
}
function activate(next: CatalogDocument): ModelCatalogSnapshot {
	const cfg = state();
	const nextLocal = archiveReferencedDefinitions(cfg.local, next);
	validateLocal(nextLocal, next);
	const nextHistory = [
		active,
		...history.filter(
			(c) => c.catalogVersion !== active.catalogVersion && c.catalogVersion !== next.catalogVersion,
		),
	].slice(0, 5);
	const previous = { active, history, pending, local: cfg.local };
	saveCache(next, nextHistory); // persist before exposing to running readers
	active = next;
	history = nextHistory;
	pending = undefined;
	cfg.local = { ...nextLocal, revision: cfg.local.revision + 1 };
	try {
		persistSettings?.();
		saveCache();
	} catch (error) {
		active = previous.active;
		history = previous.history;
		pending = previous.pending;
		cfg.local = previous.local;
		try {
			saveCache();
		} catch {
			/* Runtime stays on last good even if disk is unavailable. */
		}
		throw error;
	}
	return getModelCatalogSnapshot();
}
export function applyModelCatalogUpdate(version?: string): ModelCatalogSnapshot {
	if (!pending || (version && pending.catalogVersion !== version))
		throw new Error("No checked catalog with this version");
	if (state().pinnedVersion && state().pinnedVersion !== pending.catalogVersion)
		throw new Error("Catalog is pinned to a different version");
	return activate(pending);
}
export function rollbackModelCatalog(version: string): ModelCatalogSnapshot {
	const previous = history.find((c) => c.catalogVersion === version);
	if (!previous) throw new Error("Catalog version is not retained");
	return activate(previous);
}
export function setModelCatalogUpdateSettings(value: {
	autoApply?: boolean;
	pinnedVersion?: string | null;
}): ModelCatalogSnapshot {
	if (value.autoApply !== undefined && typeof value.autoApply !== "boolean")
		throw new Error("autoApply must be boolean");
	if (
		value.pinnedVersion !== undefined &&
		value.pinnedVersion !== null &&
		typeof value.pinnedVersion !== "string"
	)
		throw new Error("pinnedVersion must be string or null");
	const cfg = state();
	if (value.autoApply !== undefined) cfg.autoApply = value.autoApply;
	if (value.pinnedVersion !== undefined) cfg.pinnedVersion = value.pinnedVersion;
	persistSettings?.();
	return getModelCatalogSnapshot();
}
export function exportModelCatalogUserLayer() {
	return structuredClone({
		schemaVersion: 1,
		catalogVersion: active.catalogVersion,
		settings: state(),
	});
}
/** Offline downgrade preflight: never mutates storage or activates an old writer. */
export function previewModelCatalogDowngrade(): {
	supported: boolean;
	reasons: string[];
	legacy?: {
		modelCards: ModelCard[];
		modelContextWindows: Record<string, number>;
		pricingOverrides: Record<string, Record<string, number>>;
	};
} {
	const local = state().local;
	const reasons: string[] = [];
	if (local.variants?.length) reasons.push("Local variants cannot be represented by legacy cards");
	if (local.hiddenVariantIds?.length)
		reasons.push("Variant tombstones cannot be represented by legacy cards");
	const supportedPaths = new Set([
		"limits.contextWindow",
		"limits.maxOutputTokens",
		"reasoning.levels",
		"reasoning.mode",
		"reasoning.supported",
		"referencePricing.input",
		"referencePricing.output",
		"referencePricing.cacheRead",
		"referencePricing.cacheWrite",
		"referencePricing.currency",
		"referencePricing.unit",
	]);
	const inspect = (value: ModelMetadata, owner: string) => {
		for (const [section, fields] of Object.entries(value))
			for (const [field, item] of Object.entries(fields ?? {})) {
				const path = `${section}.${field}`;
				if (!supportedPaths.has(path) || item === null || (Array.isArray(item) && !item.length))
					reasons.push(`${owner}: ${path} cannot be represented losslessly`);
				if (path === "reasoning.mode" && item !== "levels")
					reasons.push(`${owner}: fixed/budget reasoning cannot be represented`);
				if (path === "reasoning.supported" && item !== true)
					reasons.push(`${owner}: explicit disabled reasoning cannot be represented`);
			}
	};
	for (const model of local.models ?? []) {
		inspect(model.metadata, model.id);
		if (model.matches?.ids?.length)
			reasons.push(
				`${model.id}: explicit additional ids cannot be represented by the legacy matching contract`,
			);
		if (
			model.metadata.reasoning?.levels?.some(
				(level) => !["minimal", "low", "medium", "high", "xhigh", "max"].includes(level),
			)
		)
			reasons.push(`${model.id}: unsupported legacy reasoning level`);
	}
	for (const override of local.overrides ?? []) inspect(override.metadata, override.targetId);
	const windows: Record<string, number> = {};
	for (const binding of local.bindings ?? []) {
		const override =
			local.overrides?.find((o) => o.target === "binding" && o.targetId === binding.id)?.metadata ??
			binding.overrides ??
			{};
		if (
			binding.variantId ||
			Object.keys(override).some((k) => k !== "limits") ||
			Object.keys(override.limits ?? {}).some((k) => k !== "contextWindow")
		)
			reasons.push(`${binding.id}: scoped metadata is not a legacy window override`);
		const window = override.limits?.contextWindow;
		if (window) {
			const configs = [
				...(settingsRef?.customApiProviders ?? []),
				...(settingsRef?.openaiProviders ?? []),
				...(settingsRef?.anthropicProviders ?? []),
				...(settingsRef?.geminiProviders ?? []),
				...(settingsRef?.nugProviders ?? []),
			];
			const prefix = configs.find((c) => c.id === binding.providerId)?.prefix ?? binding.providerId;
			const upstream = binding.channelId
				? `${binding.channelId}:${binding.upstreamModelId}`
				: binding.upstreamModelId;
			windows[prefix ? `${prefix}:${upstream}` : upstream] = window;
		}
	}
	if (reasons.length) return { supported: false, reasons };
	const { cards } = getLegacyModelCards();
	// Freeze the complete effective legacy view: an old binary may bundle different presets.
	const pricingOverrides: Record<string, Record<string, number>> = {};
	for (const card of cards)
		if (card.officialPricing)
			pricingOverrides[card.modelKey] = { ...card.officialPricing } as Record<string, number>;
	for (const id of local.hiddenModelIds ?? []) cards.push({ modelKey: id, deleted: true });
	return {
		supported: true,
		reasons: [],
		legacy: { modelCards: cards, modelContextWindows: windows, pricingOverrides },
	};
}
let dailyTimer: ReturnType<typeof setInterval> | undefined;
export function startModelCatalogDailyCheck(): void {
	if (dailyTimer) return;
	dailyTimer = setInterval(
		() => {
			if (!lastCheckedAt || Date.now() - Date.parse(lastCheckedAt) >= 86_400_000)
				void checkModelCatalogUpdate();
		},
		60 * 60 * 1000,
	);
	dailyTimer.unref();
}
