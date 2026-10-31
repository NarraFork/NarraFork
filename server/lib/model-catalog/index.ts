/**
 * NarraFork-owned model metadata storage and runtime integration.
 *
 * One representation end to end: the public catalog, the cached snapshots, the local
 * layer in settings.json, the in-memory state, every mutation and every resolution use
 * the raw source map. Data written by older versions is imported once, at the boundary
 * where it is read (see ./legacy-v1.ts); nothing converts back.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decimalValue, type ModelCard, type RawMetadata } from "@shared/model-catalog/card";
import {
	isConnectionKey,
	type ModelCardMutation,
	mutateRawLocal,
	normalizeRawLocalState,
	patchLocalCardMetadata,
} from "@shared/model-catalog/card-local";
import { createModelCardResolver } from "@shared/model-catalog/card-resolver";
import { type ModelProfile, modelProfile } from "@shared/model-catalog/profile";
import type { CatalogUpdateStatus, ModelCardSnapshot } from "@shared/model-catalog/schema/api";
import type {
	ModelQuery,
	RawCatalog,
	RawLocalState,
	RawModel,
} from "@shared/model-catalog/schema/catalog";
import {
	isValidModelContextWindow,
	normalizeModelContextWindowOverrides,
} from "@shared/model-context-window";
import { logger } from "../logger";
import { getNarraforkHome } from "../narrafork-home";
import { resolveNugModelMeta } from "../nug-model-cache";
import type { NarraForkSettings } from "../settings/types";
import { sanitizeCatalogErrorText } from "./error-text";
import {
	type LegacyLocalState,
	type LegacyModelCard,
	legacyCardMetadata,
	legacyLocalToRaw,
	legacyMetadataToRaw,
	liftWindowBindings,
} from "./legacy-v1";
import {
	CATALOG_ARCHIVE_BASE,
	CATALOG_REVISION_URL,
	catalogFromArchive,
	catalogSourceVersion,
	decodeBundledCatalog,
	decodeCatalog,
	MAX_CATALOG_BYTES,
	MAX_CATALOG_REVISION_BYTES,
	parseCatalogRevision,
} from "./source";

/** Stored verbatim in settings.json and held verbatim in memory. */
export interface ModelCatalogSettings {
	schemaVersion: 2;
	/** Kept for older binaries that still read it; no reader in this version branches on it. */
	migrationVersion: 2;
	local: RawLocalState;
	autoApply: boolean;
	pinnedVersion: string | null;
	/** Preserved verbatim for export/audit; never used as a second resolver. */
	legacyArchive?: {
		modelCards: LegacyModelCard[];
		modelContextWindows: Record<string, number>;
		pricingOverrides: unknown;
	};
}
const bundled = decodeBundledCatalog();
const directory = resolve(getNarraforkHome(), "model-catalog");
const cachePath = resolve(directory, "snapshots.json");
let active = bundled;
let pending: RawCatalog | undefined;
let history: RawCatalog[] = [];
let lastCheckedAt: string | undefined;
let lastError: string | undefined;
let etag: string | undefined;
let settingsRef: NarraForkSettings | undefined;
let persistSettings: (() => void) | undefined;
let checking: Promise<ModelCardSnapshot> | undefined;
const requestSnapshots = new AsyncLocalStorage<{
	catalog: RawCatalog;
	local: RawLocalState;
	cards: Map<string, ModelCard>;
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
		active = decodeCatalog(value.active);
		history = (value.history ?? []).map(decodeCatalog).slice(0, 5);
		if (value.pending) pending = decodeCatalog(value.pending);
		lastCheckedAt = value.lastCheckedAt;
		etag = value.etag;
	}
} catch (error) {
	// Snapshot `lastError` is visible to every session via GET /v2; scrub host paths.
	lastError = `Cached catalog rejected; using bundled snapshot: ${sanitizeCatalogErrorText(error)}`;
}

function providerConfigs(settings: NarraForkSettings | undefined) {
	return [
		...(settings?.customApiProviders ?? []),
		...(settings?.openaiProviders ?? []),
		...(settings?.anthropicProviders ?? []),
		...(settings?.geminiProviders ?? []),
		...(settings?.nugProviders ?? []),
	];
}

/** Context windows a provider's model listing reports, by full model value. */
type ListingWindows = (model: string) => number | undefined;
const listingWindows: ListingWindows[] = [];
/**
 * For providers whose listing reports an input limit but which have no gateway metadata
 * channel (e.g. Gemini). The value enters resolution as discovered metadata.
 */
export function registerListingWindows(lookup: ListingWindows): void {
	listingWindows.push(lookup);
}

export function queryForModel(
	model: string,
	settings: NarraForkSettings | undefined = settingsRef,
): { query: ModelQuery; discovered?: RawMetadata } {
	model = model.trim();
	const config = providerConfigs(settings).find(
		(c) => c.prefix && model.startsWith(`${c.prefix}:`),
	);
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
	const nug = settings?.nugProviders?.find((c) => c.id === config?.id);
	if (nug && knownPrefix) {
		try {
			const info = resolveNugModelMeta(nug.id, knownPrefix, model);
			query.channelId = info.channel;
			query.providerKey = info.channelType;
			query.upstreamModelId = info.bareModel;
			// The complete card wins; an old gateway's grouped envelope is imported as-is,
			// and a gateway reporting neither still contributes its window and tiers.
			const discovered: RawMetadata = info.modelCard
				? structuredClone(info.modelCard.metadata)
				: info.metadata?.metadata
					? legacyMetadataToRaw(info.metadata.metadata)
					: {
							...(info.contextWindow ? { legacy_context_window: info.contextWindow } : {}),
							...(info.effortLevels
								? { reasoning_effort_levels: info.effortLevels, reasoning_mode: "levels" }
								: {}),
						};
			// The gateway's per-model tier list — including `[]`, which asserts "no thinking
			// tiers" — is an authority claim the frontend menu already acts on. A complete
			// card may omit the reasoning keys (or mark them unknown), so fill them here when
			// the card is silent, never over it. Without this, the same gateway model could
			// offer no menu and still receive an effort the upstream rejects.
			if (info.effortLevels !== undefined && discovered.reasoning_effort_levels == null) {
				discovered.reasoning_effort_levels = info.effortLevels;
				if (discovered.reasoning_mode == null) discovered.reasoning_mode = "levels";
			}
			return { query, discovered };
		} catch {
			/* Old gateway without cache: keep opaque upstream identity. */
		}
	}
	for (const lookup of listingWindows) {
		const window = lookup(model);
		if (window !== undefined) return { query, discovered: { max_input_tokens: window } };
	}
	return { query };
}

// ---------------------------------------------------------------------------
// Settings: decode once on every load (startup and hot reload alike)
// ---------------------------------------------------------------------------

const WORKING_WINDOW = "working_context_tokens";

/** Set one provider entry's working window, or clear it with null. Returns a new state. */
function withConnectionWindow(
	local: RawLocalState,
	model: string,
	value: number | null,
): RawLocalState {
	return patchLocalCardMetadata(
		active,
		local,
		"connection",
		model.trim(),
		value === null ? { reset: [WORKING_WINDOW] } : { set: { [WORKING_WINDOW]: value } },
	);
}

/**
 * The per-model window map older builds kept at `agent.modelContextWindows`. It is no
 * longer part of the settings type; a file written before this version may carry it.
 */
function storedWindowMap(settings: NarraForkSettings): unknown {
	return (settings.agent as { modelContextWindows?: unknown }).modelContextWindows;
}

/** Each entry of an old window map becomes its provider entry's working window. */
function importWindowMap(local: RawLocalState, input: unknown, legacy: boolean): RawLocalState {
	let next = local;
	for (const [model, value] of Object.entries(normalizeModelContextWindowOverrides(input))) {
		const key = model.trim();
		if (!isConnectionKey(key)) continue;
		next = withConnectionWindow(next, key, value);
		if (legacy)
			next.legacyFields = { ...next.legacyFields, [`connection:${key}`]: [WORKING_WINDOW] };
	}
	return next;
}

function backupLegacyCatalog(stored: unknown, kind = "local-v1"): void {
	const hash = createHash("sha256").update(JSON.stringify(stored)).digest("hex").slice(0, 20);
	const backup = resolve(directory, `${kind}-${hash}.json`);
	if (!existsSync(backup)) atomicJSON(backup, { modelCatalog: stored });
}

/** First run of the catalog on a pre-catalog settings file: import cards, windows and prices. */
function importPreCatalogSettings(settings: NarraForkSettings): ModelCatalogSettings {
	const legacyArchive = {
		modelCards: structuredClone((settings.agent.modelCards ?? []) as LegacyModelCard[]),
		modelContextWindows: normalizeModelContextWindowOverrides(storedWindowMap(settings)),
		pricingOverrides: structuredClone(settings.pricing?.overrides ?? {}),
	};
	const backup = resolve(directory, "legacy-settings-backup.json");
	if (!existsSync(backup)) atomicJSON(backup, settings);
	const local: RawLocalState = {
		revision: 0,
		models: [],
		variants: [],
		bindings: [],
		overrides: [],
		hiddenModelIds: [],
		hiddenVariantIds: [],
	};
	const overrides = local.overrides!;
	// Prefix/suffix matches borrow capabilities, not identity. Never migrate a
	// distinct legacy key (e.g. gpt-5.5-mini) onto its broader preset model.
	const identity = (key: string): string => {
		const models = new Map(active.models.map((model) => [model.id, model]));
		for (const model of local.models!) models.set(model.id, model);
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
	const override = (id: string) => {
		let entry = overrides.find((o) => o.target === "model" && o.targetId === id);
		if (!entry) {
			entry = { target: "model", targetId: id, metadata: {}, source: "legacy-local" };
			overrides.push(entry);
		}
		return entry;
	};
	// Aliases may converge on one target. Merge their fields once, with canonical
	// cards taking precedence regardless of input order (last wins among duplicates).
	const cards = legacyArchive.modelCards
		.map((card) => ({ card, id: identity(card.modelKey) }))
		.sort((a, b) => Number(a.card.modelKey === a.id) - Number(b.card.modelKey === b.id));
	for (const { card, id } of cards) {
		const base: RawModel | undefined =
			local.models!.find((m) => m.id === id) ?? active.models.find((m) => m.id === id);
		local.hiddenModelIds = local.hiddenModelIds!.filter((hidden) => hidden !== id);
		if (card.deleted) {
			// An exact tombstone must also participate in matching, or a weak preset
			// match could resurrect a deleted custom model.
			if (!base) local.models!.push({ id, metadata: {} });
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
			local.models = local.models!.filter((model) => model.id !== id);
			local.models.push({
				...structuredClone(base ?? { id }),
				// Identity edits must not pin the preset's metadata; overrides carry values.
				metadata: {},
				// Legacy editors allowed empty optional labels; the catalog requires
				// non-empty strings. Treat blanks as unset, retaining preset identity.
				name: card.displayName?.trim() || base?.name,
				family: card.family?.trim() || base?.family,
				notes: card.notes?.trim() || base?.notes,
				matches: {
					...base?.matches,
					...(card.aliases ? { aliases: card.aliases } : {}),
					...(card.matchPrefixes
						? { prefixes: card.matchPrefixes, fields: ["limits", "reasoning"] }
						: {}),
				},
			});
		}
		const entry = override(id);
		entry.metadata = { ...entry.metadata, ...legacyCardMetadata(card) };
	}
	const priceKeys = {
		input: "input_cost_per_token",
		output: "output_cost_per_token",
		cacheRead: "cache_read_input_token_cost",
		cacheWrite: "cache_creation_input_token_cost",
	} as const;
	for (const [key, pricing] of Object.entries(settings.pricing?.overrides ?? {})) {
		const id = identity(key);
		if (!active.models.some((m) => m.id === id) && !local.models!.some((m) => m.id === id))
			local.models!.push({ id, metadata: {} });
		const entry = override(id);
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const value = (pricing as Partial<Record<typeof field, unknown>>)[field];
			// Hand-written overrides are USD per 1M tokens; an explicit 0 means free.
			if (typeof value === "number" && Number.isFinite(value) && value >= 0)
				entry.metadata[priceKeys[field]] = decimalValue(String(value), -6);
		}
	}
	for (const model of local.models ?? [])
		for (const key of ["name", "family", "notes"] as const) if (!model[key]) delete model[key];
	// Windows imported from the archive keep their legacy provenance.
	const imported = importWindowMap(
		normalizeRawLocalState(local),
		legacyArchive.modelContextWindows,
		true,
	);
	return {
		schemaVersion: 2,
		migrationVersion: 2,
		local: imported,
		autoApply: false,
		pinnedVersion: null,
		legacyArchive,
	};
}

/**
 * Bring `settings.agent.modelCatalog` into its one form, as read from disk. Used by the
 * initial load and every hot reload, so no entry point can observe another shape.
 * Returns true when the stored document must be rewritten.
 */
export function normalizeModelCatalogSettings(settings: NarraForkSettings): boolean {
	const stored = settings.agent.modelCatalog as unknown as
		| (Omit<ModelCatalogSettings, "schemaVersion" | "local"> & {
				schemaVersion: number;
				local: unknown;
		  })
		| undefined;
	let changed = false;
	if (!stored) {
		settings.agent.modelCatalog = importPreCatalogSettings(settings);
		delete (settings.agent as { modelContextWindows?: unknown }).modelContextWindows;
		changed = true;
	} else if (stored.schemaVersion === 1) {
		backupLegacyCatalog(stored);
		settings.agent.modelCatalog = {
			...(stored as unknown as ModelCatalogSettings),
			schemaVersion: 2,
			migrationVersion: 2,
			local: legacyLocalToRaw(stored.local as LegacyLocalState),
		};
		changed = true;
	} else if (stored.schemaVersion === 2) {
		const local = normalizeRawLocalState(stored.local as RawLocalState);
		if (!isDeepStrictEqual(local, stored.local)) changed = true;
		settings.agent.modelCatalog = {
			...(stored as unknown as ModelCatalogSettings),
			migrationVersion: 2,
			local,
		};
		if (stored.migrationVersion !== 2) changed = true;
	} else throw new Error("Unsupported model catalog storage schema; refusing downgrade");
	const cfg = settings.agent.modelCatalog!;
	// Builds before provider-model overrides stored provider-page windows as bindings.
	const lifted = liftWindowBindings(cfg.local);
	if (lifted !== cfg.local) {
		// Older builds reject the new `connections` field; keep what they can read.
		if (stored) backupLegacyCatalog(stored, "local-v2-window-bindings");
		cfg.local = { ...lifted, revision: cfg.local.revision + 1 };
		changed = true;
	}
	validateLocal(cfg.local);
	// A file from a build that kept the window map beside the catalog: where the two
	// disagree the map is what the page showed the user, so it is applied once. Absent
	// keys are left alone: absence is never evidence of a deletion.
	if (storedWindowMap(settings) !== undefined) {
		// Importing the old map is best effort: it must never stop the server from starting.
		try {
			const next = importWindowMap(cfg.local, storedWindowMap(settings), false);
			if (!isDeepStrictEqual(normalizeRawLocalState(cfg.local), next)) {
				validateLocal(next);
				cfg.local = { ...next, revision: cfg.local.revision + 1 };
			}
		} catch (error) {
			logger.warn("Stored provider-page context windows were not imported", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		delete (settings.agent as { modelContextWindows?: unknown }).modelContextWindows;
		changed = true;
	}
	return changed;
}

/** A pure edit of the local layer; undefined means it changes nothing. */
type LocalEdit = (local: RawLocalState) => RawLocalState | undefined;
/**
 * Edits made to a settings draft's catalog, and the live revision the draft was copied
 * at. If the live catalog moves before the draft is saved, the edits are replayed on top
 * of it instead of the draft's copy replacing it.
 */
const draftEdits = new WeakMap<RawLocalState, { base: number; edits: LocalEdit[] }>();

/**
 * Called on every settings save. The catalog has its own revisioned writers; a document
 * assembled without it (e.g. from defaults), copied before a catalog edit landed, or
 * edited while one landed must not erase or roll it back.
 */
export function keepLatestCatalog(nextSettings: NarraForkSettings): void {
	delete (nextSettings.agent as { modelContextWindows?: unknown }).modelContextWindows;
	const current = settingsRef?.agent.modelCatalog;
	const cfg = nextSettings.agent.modelCatalog;
	if (!current || cfg === current) return;
	const pending = cfg && draftEdits.get(cfg.local);
	if (pending && pending.base !== current.local.revision) {
		let local = current.local;
		for (const edit of pending.edits) local = edit(local) ?? local;
		if (local === current.local) {
			nextSettings.agent.modelCatalog = current;
			return;
		}
		validateLocal(local);
		nextSettings.agent.modelCatalog = {
			...current,
			local: { ...local, revision: current.local.revision + 1 },
		};
		return;
	}
	if (!cfg || cfg.local.revision < current.local.revision)
		nextSettings.agent.modelCatalog = current;
}

/** Apply an edit to a settings document (live or draft), bumping its revision. */
function editLocal(settings: NarraForkSettings, edit: LocalEdit): boolean {
	const cfg = settings.agent.modelCatalog;
	if (!cfg) return false;
	const next = edit(cfg.local);
	if (!next) return false;
	validateLocal(next);
	const pending = draftEdits.get(cfg.local);
	const local = { ...next, revision: cfg.local.revision + 1 };
	settings.agent.modelCatalog = { ...cfg, local };
	draftEdits.set(local, {
		base: pending?.base ?? cfg.local.revision,
		edits: [...(pending?.edits ?? []), edit],
	});
	return true;
}

/** Rename or drop provider entries' own overrides; throws when two land on one key. */
function renameConnections(
	local: RawLocalState,
	rename: (model: string) => string | null,
): RawLocalState | undefined {
	if (!local.connections) return undefined;
	const connections: Record<string, RawMetadata> = {};
	const origins: Record<string, string> = {};
	const legacyFields = { ...local.legacyFields };
	let changed = false;
	const place = (target: string, model: string, metadata: RawMetadata) => {
		if (connections[target] && !isDeepStrictEqual(connections[target], metadata))
			throw new Error(
				`Provider model overrides for "${origins[target]}" and "${model}" would both become "${target}"`,
			);
		connections[target] = metadata;
		origins[target] = model;
	};
	for (const [model, metadata] of Object.entries(local.connections)) {
		const target = rename(model);
		if (target === model) {
			place(target, model, metadata);
			continue;
		}
		changed = true;
		const provenance = legacyFields[`connection:${model}`];
		delete legacyFields[`connection:${model}`];
		if (target === null) continue;
		place(target, model, metadata);
		if (provenance) legacyFields[`connection:${target}`] = provenance;
	}
	return changed ? normalizeRawLocalState({ ...local, connections, legacyFields }) : undefined;
}

/**
 * Rename or drop provider entries' own overrides, e.g. when a provider prefix changes or
 * its models disappear. `rename` returns the new model value, or null to drop the entry.
 * Writes into `settings`, which may be a draft. Throws when two entries would land on one
 * key with different values.
 */
export function rewriteConnectionOverrides(
	settings: NarraForkSettings,
	rename: (model: string) => string | null,
): boolean {
	return editLocal(settings, (local) => renameConnections(local, rename));
}

export function bindModelCatalogSettings(settings: NarraForkSettings, save: () => void): void {
	settingsRef = settings;
	persistSettings = save;
	if (settings.agent.modelCatalog?.schemaVersion !== 2 && normalizeModelCatalogSettings(settings))
		save();
}
function state(): ModelCatalogSettings {
	if (!settingsRef?.agent.modelCatalog) throw new Error("Model catalog not initialized");
	return settingsRef.agent.modelCatalog;
}
export function isModelCatalogBound(): boolean {
	return !!settingsRef?.agent.modelCatalog;
}
/** Replace the local layer, persist, and roll back on failure. */
function commitLocal(next: RawLocalState): void {
	const cfg = state();
	const previous = cfg.local;
	cfg.local = next;
	try {
		persistSettings?.();
	} catch (error) {
		cfg.local = previous;
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const localKeys = new WeakMap<RawLocalState, string>();
function localKey(local: RawLocalState): string {
	let key = localKeys.get(local);
	if (key === undefined) {
		key = JSON.stringify(local);
		localKeys.set(local, key);
	}
	return key;
}
let cardResolverCache:
	| {
			catalog: RawCatalog;
			localKey: string;
			resolve: ReturnType<typeof createModelCardResolver>;
	  }
	| undefined;
function cardResolver(catalog: RawCatalog, local: RawLocalState) {
	const key = localKey(local);
	if (cardResolverCache?.catalog !== catalog || cardResolverCache.localKey !== key)
		cardResolverCache = {
			catalog,
			localKey: key,
			resolve: createModelCardResolver(catalog, local),
		};
	return cardResolverCache.resolve;
}
const rejectedDiscoveries = new Set<string>();
/**
 * `model` is the full model value the query came from. That provider entry's own
 * overrides apply by that name, not by whichever selector it resolves to today (gateway
 * caches and provider configs change).
 */
export function resolveEffectiveModelCard(
	query: ModelQuery,
	discovered?: RawMetadata,
	model?: string,
): ModelCard {
	const scope = requestSnapshots.getStore();
	const catalog = scope?.catalog ?? active;
	const local = scope?.local ?? settingsRef?.agent.modelCatalog?.local ?? { revision: 0 };
	const card = cardResolver(catalog, local);
	const connection = model?.trim();
	const resolve = (input?: RawMetadata) => card(query, input, undefined, connection);
	if (discovered === undefined) return resolve();
	try {
		return resolve(discovered);
	} catch (error) {
		// Gateway metadata is outside local validation. When it contradicts the catalog
		// (e.g. a total below the preset output cap), requests keep the catalog's card.
		const key = JSON.stringify(query);
		if (!rejectedDiscoveries.has(key)) {
			rejectedDiscoveries.add(key);
			logger.warn("Ignoring gateway model metadata that conflicts with the catalog", {
				upstreamModelId: query.upstreamModelId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return resolve();
	}
}
/**
 * One resolution per model and request snapshot. Callers must not mutate the result.
 * `own: false` resolves without the provider entry's own overrides: what it inherits.
 */
function effectiveCard(model: string, own = true): { card: ModelCard; query: ModelQuery } {
	const cache = own ? requestSnapshots.getStore()?.cards : undefined;
	const { query, discovered } = queryForModel(model);
	const card =
		cache?.get(model) ?? resolveEffectiveModelCard(query, discovered, own ? model : undefined);
	cache?.set(model, card);
	return { card, query };
}
export function getEffectiveModelCard(model: string): ModelCard & { resolvedQuery: ModelQuery } {
	const { card, query } = effectiveCard(model);
	return { ...structuredClone(card), resolvedQuery: query };
}
/** Typed runtime reads for a full model id (`provider:model`); `card` is read-only. */
export function getEffectiveModelProfile(
	model: string,
	options: { own?: boolean } = {},
): ModelProfile & { card: Readonly<ModelCard> } {
	const { card } = effectiveCard(model, options.own ?? true);
	return { ...modelProfile(card), card };
}

const positiveInteger = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
/** The model-wide working window the user set for a catalog or local model, if any. */
function modelWideWindow(local: RawLocalState, modelId: string): number | undefined {
	return positiveInteger(
		local.models?.find((m) => m.id === modelId)?.metadata[WORKING_WINDOW] ??
			local.overrides?.find((o) => o.target === "model" && o.targetId === modelId)?.metadata[
				WORKING_WINDOW
			],
	);
}

/** The two places a working window can be set for a provider entry, as the editor shows them. */
export interface ModelWindowScopes {
	/** This provider entry's own working window. */
	own?: number;
	/**
	 * The catalog model a model-wide window targets. Absent when the entry matches no
	 * model, or only by prefix/suffix (a model-wide value may not reach it).
	 */
	modelId?: string;
	/** The model-wide working window, when one is set. */
	modelWide?: number;
	/** Other provider entries of the same model that set their own window. */
	others: Array<{ model: string; contextWindow: number }>;
}
let connectionIdsCache:
	| { catalog: RawCatalog; local: RawLocalState; at: number; ids: Map<string, string | undefined> }
	| undefined;
/**
 * Which catalog model each provider entry with its own window resolves to. Cached per
 * local layer for a few seconds: a page load asks once per batch of rows.
 */
export function connectionModelIds(): Map<string, string | undefined> {
	const local = state().local;
	const now = Date.now();
	if (
		connectionIdsCache?.catalog === active &&
		connectionIdsCache.local === local &&
		now - connectionIdsCache.at < 5_000
	)
		return connectionIdsCache.ids;
	const ids = new Map<string, string | undefined>();
	connectionIdsCache = { catalog: active, local, at: now, ids };
	for (const [model, metadata] of Object.entries(local.connections ?? {})) {
		if (positiveInteger(metadata[WORKING_WINDOW]) === undefined) continue;
		try {
			ids.set(model, effectiveCard(model, false).card.modelId);
		} catch {
			/* An entry that no longer resolves cannot shadow any model. */
			ids.set(model, undefined);
		}
	}
	return ids;
}
export function getModelWindowScopes(
	model: string,
	connections = connectionModelIds(),
): ModelWindowScopes {
	const key = model.trim();
	const local = state().local;
	const card = effectiveCard(key).card;
	const strong =
		card.modelId !== undefined && card.matchedVia !== "prefix" && card.matchedVia !== "suffix";
	const scopes: ModelWindowScopes = { others: [] };
	const own = positiveInteger(local.connections?.[key]?.[WORKING_WINDOW]);
	if (own !== undefined) scopes.own = own;
	if (!strong || !card.modelId) return scopes;
	scopes.modelId = card.modelId;
	const wide = modelWideWindow(local, card.modelId);
	if (wide !== undefined) scopes.modelWide = wide;
	for (const [other, modelId] of connections) {
		const value = positiveInteger(local.connections?.[other]?.[WORKING_WINDOW]);
		if (other !== key && value !== undefined && modelId === card.modelId)
			scopes.others.push({ model: other, contextWindow: value });
	}
	return scopes;
}

/**
 * Set a working window in one scope: a provider entry's own (`connection`, keyed by its
 * model value) or model-wide (`model`, keyed by catalog id). `null` clears it.
 */
export function setModelWindow(input: {
	baseRevision: number;
	scope: "connection" | "model";
	target: string;
	contextWindow: number | null;
}): ModelCardSnapshot {
	const { contextWindow } = input;
	if (
		contextWindow !== null &&
		(!Number.isSafeInteger(contextWindow) || !isValidModelContextWindow(contextWindow))
	)
		throw new Error("Context window is out of range");
	if (input.scope !== "connection" && input.scope !== "model") throw new Error("Invalid scope");
	return mutateModelCard({
		baseRevision: input.baseRevision,
		action: "patch",
		target: input.scope,
		targetId: input.target,
		patch:
			contextWindow === null
				? { reset: [WORKING_WINDOW] }
				: { set: { [WORKING_WINDOW]: contextWindow } },
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
			cards: new Map(),
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
		cards: new Map<string, ModelCard>(),
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

// ---------------------------------------------------------------------------
// Snapshot, diff and protected fields
// ---------------------------------------------------------------------------

function leafMap(value: object, prefix = ""): Map<string, unknown> {
	const result = new Map<string, unknown>();
	for (const [key, entry] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (entry && typeof entry === "object" && !Array.isArray(entry))
			for (const [nested, item] of leafMap(entry, path)) result.set(nested, item);
		else result.set(path, entry);
	}
	return result;
}
function diffCatalog(next: RawCatalog) {
	const before = new Map(
		[...active.models, ...active.variants].map((m) => [m.id, JSON.stringify(m)]),
	);
	const after = new Map([...next.models, ...next.variants].map((m) => [m.id, JSON.stringify(m)]));
	const fields: NonNullable<CatalogUpdateStatus["pendingDiff"]>["fields"] = [];
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
			const oldLeaves = leafMap(previous.get(id) ?? {});
			const newLeaves = leafMap(incoming.get(id) ?? {});
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
let protectedCountCache:
	| {
			active: RawCatalog;
			next: RawCatalog;
			local: RawLocalState;
			revision: number;
			count: number;
	  }
	| undefined;
/** How many explicit local values would stop matching what an update changes underneath. */
function protectedFieldCount(next: RawCatalog, local: RawLocalState): number {
	if (
		protectedCountCache?.active === active &&
		protectedCountCache.next === next &&
		protectedCountCache.local === local &&
		protectedCountCache.revision === local.revision
	)
		return protectedCountCache.count;
	const inherited: RawLocalState = {
		...local,
		overrides: [],
		models: local.models?.map((model) => ({ ...model, metadata: {} })),
		variants: local.variants?.map((variant) => ({ ...variant, metadata: {} })),
		bindings: local.bindings?.map(({ overrides: _overrides, ...binding }) => binding),
	};
	const modelIds = new Set([
		...(local.overrides ?? []).filter((o) => o.target === "model").map((o) => o.targetId),
		...(local.models ?? []).filter((m) => Object.keys(m.metadata).length).map((m) => m.id),
	]);
	const variantIds = new Set([
		...(local.overrides ?? []).filter((o) => o.target === "variant").map((o) => o.targetId),
		...(local.variants ?? []).filter((v) => Object.keys(v.metadata).length).map((v) => v.id),
	]);
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
	// The three immutable input layers do not change within this comparison; build
	// each resolver once rather than revalidating the catalog per query.
	const prepare = (catalog: RawCatalog, state: RawLocalState) => {
		try {
			return queries.length ? createModelCardResolver(catalog, state) : undefined;
		} catch {
			return undefined;
		}
	};
	const currentResolver = prepare(active, local);
	const beforeResolver = prepare(active, inherited);
	const afterResolver = prepare(next, inherited);
	const resolveWith = (
		resolver: ReturnType<typeof createModelCardResolver> | undefined,
		query: ModelQuery,
	) => {
		try {
			return resolver?.(query);
		} catch {
			return undefined;
		}
	};
	let count = 0;
	for (const query of queries) {
		const current = resolveWith(currentResolver, query);
		if (!current) continue;
		const before = leafMap(resolveWith(beforeResolver, query)?.metadata ?? {});
		const after = leafMap(resolveWith(afterResolver, query)?.metadata ?? {});
		for (const [path, source] of Object.entries(current.provenance))
			if (source.explicit && JSON.stringify(before.get(path)) !== JSON.stringify(after.get(path)))
				count++;
	}
	protectedCountCache = { active, next, local, revision: local.revision, count };
	return count;
}
export function getModelCatalogRevision(): number {
	return state().local.revision;
}
export function getModelCardSnapshot(): ModelCardSnapshot {
	const started = performance.now();
	const cfg = state();
	const protectedFields = pending ? protectedFieldCount(pending, cfg.local) : 0;
	const protectionFinished = performance.now();
	const pendingDiff = pending ? diffCatalog(pending) : undefined;
	const diffFinished = performance.now();
	const update: CatalogUpdateStatus & { protectedFieldCount: number } = {
		activeVersion: active.catalogVersion,
		protectedFieldCount: protectedFields,
		bundledVersion: bundled.catalogVersion,
		lastCheckedAt,
		lastError,
		pendingVersion: pending?.catalogVersion,
		autoApply: cfg.autoApply,
		pinnedVersion: cfg.pinnedVersion,
		history: history.map((c) => ({ catalogVersion: c.catalogVersion, publishedAt: c.publishedAt })),
		...(pendingDiff ? { pendingDiff } : {}),
	};
	const snapshot = structuredClone({
		schemaVersion: 2 as const,
		catalog: active,
		local: cfg.local,
		update,
	});
	const finished = performance.now();
	if (finished - started >= 100) {
		const round = (ms: number) => Math.round(ms * 100) / 100;
		logger.warn("Model catalog snapshot computation slow", {
			durationMs: round(finished - started),
			protectedFieldsMs: round(protectionFinished - started),
			pendingDiffMs: round(diffFinished - protectionFinished),
			cloneMs: round(finished - diffFinished),
			modelCount: active.models.length,
			variantCount: active.variants.length,
			bindingCount: cfg.local.bindings?.length ?? 0,
			localRevision: cfg.local.revision,
			hasPendingUpdate: !!pending,
		});
	}
	return snapshot;
}
export class CatalogRevisionConflict extends Error {}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/** Every override names a definition that exists, and every identity resolves. */
function validateLocal(local: RawLocalState, catalog = active): void {
	const models = new Map(catalog.models.map((m) => [m.id, m]));
	const variants = new Map(catalog.variants.map((v) => [v.id, v]));
	for (const m of local.models ?? []) models.set(m.id, m);
	for (const v of local.variants ?? []) variants.set(v.id, v);
	const resolveCard = createModelCardResolver(catalog, local);
	for (const override of local.overrides ?? []) {
		if (
			override.target === "model"
				? !models.has(override.targetId)
				: override.target === "variant"
					? !variants.has(override.targetId)
					: !local.bindings?.some((b) => b.id === override.targetId)
		)
			throw new Error(`Unknown ${override.target} override target ${override.targetId}`);
	}
	for (const m of models.values())
		if (!local.hiddenModelIds?.includes(m.id))
			resolveCard({ upstreamModelId: m.id, modelId: m.id });
	for (const v of variants.values())
		if (!local.hiddenModelIds?.includes(v.modelId) && !local.hiddenVariantIds?.includes(v.id))
			resolveCard({
				upstreamModelId: v.upstreamModelIds[0] ?? v.id,
				variantId: v.id,
				providerKey: v.providerKey,
			});
	for (const b of local.bindings ?? [])
		resolveCard({
			upstreamModelId: b.upstreamModelId,
			providerId: b.providerId,
			channelId: b.channelId,
		});
}

export function mutateModelCard(mutation: ModelCardMutation): ModelCardSnapshot {
	const cfg = state();
	if (!Number.isSafeInteger(mutation.baseRevision) || mutation.baseRevision < 0)
		throw new Error("baseRevision is required");
	if (mutation.baseRevision !== cfg.local.revision)
		throw new CatalogRevisionConflict("Model metadata changed; reload before saving");
	const next = mutateRawLocal(active, cfg.local, mutation);
	validateLocal(next);
	if (isDeepStrictEqual(normalizeRawLocalState(cfg.local), next)) return getModelCardSnapshot();
	if (next.revision === Number.MAX_SAFE_INTEGER)
		throw new Error("Metadata revision limit exceeded");
	next.revision++;
	commitLocal(next);
	return getModelCardSnapshot();
}

// ---------------------------------------------------------------------------
// Catalog updates
// ---------------------------------------------------------------------------

async function boundedDownload(
	url: string,
	max: number,
	kind: "revision" | "archive",
	headers?: Record<string, string>,
): Promise<{ bytes?: Uint8Array; etag?: string }> {
	const response = await fetch(url, {
		headers: { "User-Agent": "NarraFork", ...headers },
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
	});
	const assertWithinLimit = (size: number) => {
		if (size > max)
			throw new Error(
				`Catalog ${kind} download exceeds size limit (${size} bytes; limit ${max} bytes)`,
			);
	};
	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		if (response.status === 304) return {};
		if (!response.ok) throw new Error(`Catalog ${kind} download HTTP ${response.status}`);
		assertWithinLimit(Number(response.headers.get("content-length")));
		if (!reader) throw new Error(`Empty catalog ${kind} response`);
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			total += result.value.byteLength;
			assertWithinLimit(total);
			chunks.push(result.value);
		}
	} finally {
		// Cancel header-rejected bodies too; cleanup must not hide the download error.
		await reader?.cancel().catch(() => undefined);
		reader?.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, etag: response.headers.get("etag") ?? undefined };
}
export function checkModelCatalogUpdate(): Promise<ModelCardSnapshot> {
	if (checking) return checking;
	checking = (async () => {
		try {
			const revisionDownload = await boundedDownload(
				CATALOG_REVISION_URL,
				MAX_CATALOG_REVISION_BYTES,
				"revision",
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
					"archive",
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
				(!state().pinnedVersion ||
					catalogSourceVersion(state().pinnedVersion!) ===
						catalogSourceVersion(pending.catalogVersion))
			)
				applyModelCatalogUpdate(pending.catalogVersion);
		} catch (error) {
			lastError = sanitizeCatalogErrorText(error);
			saveCache();
		}
		return getModelCardSnapshot();
	})().finally(() => {
		checking = undefined;
	});
	return checking;
}
/** Definitions the local layer still references survive a catalog that drops them. */
function archiveReferencedDefinitions(local: RawLocalState, next: RawCatalog): RawLocalState {
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
			archived.variants.push({ ...structuredClone(previous), status: "deprecated" });
			modelIds.add(previous.modelId);
		}
	}
	for (const id of modelIds) {
		if (next.models.some((v) => v.id === id) || archived.models?.some((v) => v.id === id)) continue;
		const previous = active.models.find((v) => v.id === id);
		if (previous) {
			archived.models ??= [];
			archived.models.push({
				...structuredClone(previous),
				status: "deprecated",
				notes:
					`${previous.notes ?? ""}\nArchived: removed from public catalog ${next.catalogVersion}`.trim(),
			});
		}
	}
	return normalizeRawLocalState(archived);
}
function activate(next: RawCatalog): ModelCardSnapshot {
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
	try {
		commitLocal({ ...nextLocal, revision: cfg.local.revision + 1 });
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
	return getModelCardSnapshot();
}
export function applyModelCatalogUpdate(version?: string): ModelCardSnapshot {
	if (
		!pending ||
		(version && catalogSourceVersion(pending.catalogVersion) !== catalogSourceVersion(version))
	)
		throw new Error("No checked catalog with this version");
	if (
		state().pinnedVersion &&
		catalogSourceVersion(state().pinnedVersion!) !== catalogSourceVersion(pending.catalogVersion)
	)
		throw new Error("Catalog is pinned to a different version");
	return activate(pending);
}
export function rollbackModelCatalog(version: string): ModelCardSnapshot {
	const previous = history.find((c) => c.catalogVersion === version);
	if (!previous) throw new Error("Catalog version is not retained");
	return activate(previous);
}
export function setModelCatalogUpdateSettings(value: {
	autoApply?: boolean;
	pinnedVersion?: string | null;
}): ModelCardSnapshot {
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
	return getModelCardSnapshot();
}
export function exportModelCatalogUserLayer() {
	return structuredClone({
		schemaVersion: 2,
		catalogVersion: active.catalogVersion,
		settings: state(),
	});
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
