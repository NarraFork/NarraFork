/**
 * Model metadata at runtime: the public catalog, gateway-discovered metadata and the
 * user's overrides, resolved into one card per model value.
 *
 * State lives in three small files under `~/.narrafork/model-catalog/`:
 *   - `catalog.json`  the downloaded catalog in use (absent = the bundled one);
 *   - `pending.json`  a downloaded catalog waiting to be applied (auto update off);
 *   - `overrides.json` the user's corrections, model-wide and per provider entry.
 * settings.json keeps only `agent.modelCatalog.autoUpdate`. Nothing here takes the
 * settings file lock, and an edit validates only the override it changes.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ModelCard, type RawMetadata, validateRawMetadata } from "@shared/model-catalog/card";
import {
	isEmptyOverride,
	type ModelOverride,
	normalizeOverride,
	OverrideValidationError,
	rawToOverride,
} from "@shared/model-catalog/override";
import { type ModelProfile, modelProfile } from "@shared/model-catalog/profile";
import {
	type CatalogIdentity,
	type CatalogQuery,
	identifyModel,
	resolveModelCard,
} from "@shared/model-catalog/resolve";
import type { CatalogStatus } from "@shared/model-catalog/schema/api";
import type { RawCatalog } from "@shared/model-catalog/schema/catalog";
import { logger } from "../logger";
import { getNarraforkHome } from "../narrafork-home";
import { resolveNugModelMeta } from "../nug-model-cache";
import type { NarraForkSettings } from "../settings/types";
import { sanitizeCatalogErrorText } from "./error-text";
import {
	type LegacyModelCard,
	legacyCardMetadata,
	legacyLocalToRaw,
	legacyMetadataToRaw,
	WINDOW_BINDING_PREFIX,
} from "./legacy-v1";
import {
	CATALOG_ARCHIVE_BASE,
	CATALOG_REVISION_URL,
	catalogFromArchive,
	decodeBundledCatalog,
	decodeCatalog,
	MAX_CATALOG_BYTES,
	MAX_CATALOG_REVISION_BYTES,
	parseCatalogRevision,
} from "./source";

/** Stored in settings.json. */
export interface ModelCatalogSettings {
	/** Apply a newer public catalog as soon as a check finds one. Default true. */
	autoUpdate: boolean;
}

export type { CatalogQuery } from "@shared/model-catalog/resolve";

/** Built-in providers whose prefix is also the catalog's channel key. */
const PUBLIC_PROVIDER_KEYS = ["codex", "anthropic", "openai", "gemini"];

export type { CatalogStatus } from "@shared/model-catalog/schema/api";

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const directory = resolve(getNarraforkHome(), "model-catalog");
const catalogPath = resolve(directory, "catalog.json");
const pendingPath = resolve(directory, "pending.json");
const statusPath = resolve(directory, "status.json");
const overridesPath = resolve(directory, "overrides.json");

function writeJSON(path: string, value: unknown): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
	renameSync(tmp, path);
}
function readJSON(path: string): unknown {
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

// ---------------------------------------------------------------------------
// Catalog state
// ---------------------------------------------------------------------------

const bundled = decodeBundledCatalog();
let active = bundled;
let pending: RawCatalog | undefined;
let lastCheckedAt: string | undefined;
let lastError: string | undefined;
let etag: string | undefined;

function loadCatalog(path: string): RawCatalog | undefined {
	try {
		const value = readJSON(path);
		return value === undefined ? undefined : decodeCatalog(value);
	} catch (error) {
		lastError = `Stored catalog rejected; using the built-in one: ${sanitizeCatalogErrorText(error)}`;
		return undefined;
	}
}
active = loadCatalog(catalogPath) ?? bundled;
pending = loadCatalog(pendingPath);
try {
	const status = readJSON(statusPath) as
		| { lastCheckedAt?: string; lastError?: string; etag?: string }
		| undefined;
	lastCheckedAt = status?.lastCheckedAt;
	lastError ??= status?.lastError;
	etag = status?.etag;
} catch {
	/* A broken status file only costs one unconditional check. */
}
if (pending && pending.catalogVersion === active.catalogVersion) pending = undefined;

function saveStatus(): void {
	try {
		writeJSON(statusPath, { lastCheckedAt, lastError, etag });
	} catch (error) {
		logger.warn("Model catalog status not saved", { error: sanitizeCatalogErrorText(error) });
	}
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

export type OverrideScope = "model" | "connection";

/** Immutable: every edit swaps in a new object, so request snapshots can hold a reference. */
interface OverrideState {
	revision: number;
	models: ReadonlyMap<string, ModelOverride>;
	connections: ReadonlyMap<string, ModelOverride>;
}

function parseOverrideMap(value: unknown, label: string): Map<string, ModelOverride> {
	const map = new Map<string, ModelOverride>();
	if (!value || typeof value !== "object") return map;
	for (const [key, raw] of Object.entries(value)) {
		try {
			const override = normalizeOverride(raw);
			if (key.trim() && !isEmptyOverride(override)) map.set(key.trim(), override);
		} catch (error) {
			logger.warn("Dropped an unreadable model override", {
				scope: label,
				key,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return map;
}

function loadOverrides(): OverrideState {
	try {
		const stored = readJSON(overridesPath) as
			| { revision?: number; models?: unknown; connections?: unknown }
			| undefined;
		return {
			revision: Number.isSafeInteger(stored?.revision) ? (stored!.revision as number) : 0,
			models: parseOverrideMap(stored?.models, "model"),
			connections: parseOverrideMap(stored?.connections, "connection"),
		};
	} catch (error) {
		logger.error("Model overrides file is unreadable; starting without overrides", {
			error: sanitizeCatalogErrorText(error),
		});
		return { revision: 0, models: new Map(), connections: new Map() };
	}
}
let overrides = loadOverrides();

function commitOverrides(next: Omit<OverrideState, "revision">): void {
	const state = { ...next, revision: overrides.revision + 1 };
	writeJSON(overridesPath, {
		revision: state.revision,
		models: Object.fromEntries(state.models),
		connections: Object.fromEntries(state.connections),
	});
	overrides = state;
}

/**
 * Tests only: replace the overrides in memory, without touching the overrides file.
 * Values are normalized like saved ones. Returns a function that restores the previous set.
 */
export function replaceModelOverridesForTests(input: {
	models?: Record<string, unknown>;
	connections?: Record<string, unknown>;
}): () => void {
	const previous = overrides;
	overrides = {
		revision: previous.revision + 1,
		models: parseOverrideMap(input.models, "model"),
		connections: parseOverrideMap(input.connections, "connection"),
	};
	return () => {
		overrides = previous;
	};
}

export function getModelOverridesRevision(): number {
	return overrides.revision;
}
export function getModelOverride(scope: OverrideScope, key: string): ModelOverride | undefined {
	return (scope === "model" ? overrides.models : overrides.connections).get(key.trim());
}

// ---------------------------------------------------------------------------
// Settings binding
// ---------------------------------------------------------------------------

let settingsRef: NarraForkSettings | undefined;
let persistSettings: (() => void) | undefined;

/**
 * The update preference. It is owned here, not read back from whatever settings object
 * is saved next: on load and hot reload the document on disk sets it, and only
 * `setModelCatalogAutoUpdate` changes it at runtime.
 */
let preference: boolean | undefined;

export function bindModelCatalogSettings(settings: NarraForkSettings, save: () => void): void {
	settingsRef = settings;
	persistSettings = save;
	const stored = settings.agent.modelCatalog?.autoUpdate;
	if (typeof stored === "boolean") preference = stored;
}

function autoUpdate(): boolean {
	return preference ?? true;
}

/** Merge imported overrides; per key, the incoming value replaces the stored one. */
function mergeOverrides(
	models: Map<string, ModelOverride>,
	connections: Map<string, ModelOverride>,
) {
	if (!models.size && !connections.size) return;
	commitOverrides({
		models: new Map([...overrides.models, ...models]),
		connections: new Map([...overrides.connections, ...connections]),
	});
}

/** An older settings.json kept its overrides as a raw local layer; import what still applies. */
function importLegacyLocal(stored: Record<string, unknown>): void {
	let local = stored.local as Record<string, unknown> | undefined;
	if (!local || typeof local !== "object") return;
	if (stored.schemaVersion === 1) local = legacyLocalToRaw(local as never) as never;
	const models = new Map<string, ModelOverride>();
	const connections = new Map<string, ModelOverride>();
	const add = (map: Map<string, ModelOverride>, key: string, raw: unknown) => {
		if (!key.trim() || !raw || typeof raw !== "object") return;
		const override = { ...map.get(key), ...rawToOverride(raw as RawMetadata) };
		if (!isEmptyOverride(override)) map.set(key.trim(), override);
	};
	for (const entry of (local.overrides as Array<Record<string, unknown>> | undefined) ?? [])
		if (entry.target === "model") add(models, String(entry.targetId), entry.metadata);
	for (const [key, raw] of Object.entries((local.connections as object | undefined) ?? {}))
		add(connections, key, raw);
	// A binding named a provider entry by its connection id; it becomes that entry's override.
	const providers = [
		...(settingsRef?.openaiProviders ?? []),
		...(settingsRef?.anthropicProviders ?? []),
		...(settingsRef?.geminiProviders ?? []),
		...(settingsRef?.nugProviders ?? []),
	];
	for (const binding of (local.bindings as Array<Record<string, unknown>> | undefined) ?? []) {
		// Provider-page windows were once stored as bindings named after the model value.
		const id = String(binding.id ?? "");
		if (id.startsWith(WINDOW_BINDING_PREFIX)) {
			add(connections, id.slice(WINDOW_BINDING_PREFIX.length), binding.overrides);
			continue;
		}
		// Built-in providers were named by their prefix rather than a connection id.
		const providerId = String(binding.providerId ?? "");
		const prefix =
			providers.find((p) => p.id === providerId)?.prefix ??
			(PUBLIC_PROVIDER_KEYS.includes(providerId) ? providerId : undefined);
		// A gateway binding named its channel apart from the bare upstream model.
		const channel = typeof binding.channelId === "string" ? `${binding.channelId}:` : "";
		if (prefix && typeof binding.upstreamModelId === "string")
			add(connections, `${prefix}:${channel}${binding.upstreamModelId}`, binding.overrides);
	}
	const dropped = ["models", "variants"].filter(
		(key) => Array.isArray(local![key]) && (local![key] as unknown[]).length,
	);
	if (dropped.length)
		logger.warn("User-defined catalog models are no longer supported and were not imported", {
			kinds: dropped,
		});
	mergeOverrides(models, connections);
}

/**
 * Import overrides from a stored or backed-up `modelCatalog` value: the current portable
 * form (`overrides`) or an older raw local layer (`local`). Per key, incoming wins.
 * `providers` resolves old bindings, which named a provider entry by its id.
 */
export function importModelCatalogSettings(
	stored: unknown,
	providers: NarraForkSettings | undefined = settingsRef,
): void {
	if (!stored || typeof stored !== "object") return;
	const value = stored as Record<string, unknown>;
	const ref = settingsRef;
	settingsRef = providers ?? ref;
	try {
		if (value.local) importLegacyLocal(value);
		if (value.overrides && typeof value.overrides === "object") {
			const incoming = value.overrides as { models?: unknown; connections?: unknown };
			mergeOverrides(
				parseOverrideMap(incoming.models, "model"),
				parseOverrideMap(incoming.connections, "connection"),
			);
		}
	} catch (error) {
		logger.error("Model overrides could not be imported", {
			error: sanitizeCatalogErrorText(error),
		});
	} finally {
		settingsRef = ref;
	}
}

/** A settings file from before the catalog: model cards, price overrides, window map. */
function importPreCatalogSettings(settings: NarraForkSettings): void {
	const models = new Map<string, ModelOverride>();
	const connections = new Map<string, ModelOverride>();
	// A look-alike (prefix/suffix) is a different model; only exact identities migrate.
	const catalogId = (key: string) => {
		const identity = identifyModel(active, { upstreamModelId: key });
		return identity.weak ? undefined : identity.modelId;
	};
	const merge = (map: Map<string, ModelOverride>, key: string, override: ModelOverride) => {
		if (!isEmptyOverride(override)) map.set(key, { ...map.get(key), ...override });
	};
	for (const card of (settings.agent.modelCards ?? []) as LegacyModelCard[]) {
		const id = !card.deleted && catalogId(card.modelKey);
		if (id) merge(models, id, rawToOverride(legacyCardMetadata(card)));
	}
	for (const [key, pricing] of Object.entries(settings.pricing?.overrides ?? {})) {
		const id = catalogId(key);
		const prices = Object.fromEntries(
			Object.entries(pricing ?? {})
				.filter(
					([field, value]) =>
						["input", "output", "cacheRead", "cacheWrite"].includes(field) &&
						typeof value === "number" &&
						Number.isFinite(value) &&
						value >= 0,
				)
				.map(([field, value]) => [field, String(value)]),
		);
		if (id && Object.keys(prices).length) merge(models, id, normalizeOverride({ prices }));
	}
	mergeOverrides(models, connections);
}

/**
 * The per-model window map older builds kept at `agent.modelContextWindows`, beside or
 * before the catalog. Where it disagrees with an imported override it is what the
 * provider page showed, so it wins. Hand-edited numeric strings are accepted.
 */
function importWindowMap(settings: NarraForkSettings): void {
	const windows = (settings.agent as { modelContextWindows?: Record<string, unknown> })
		.modelContextWindows;
	const connections = new Map<string, ModelOverride>();
	for (const [model, raw] of Object.entries(windows ?? {})) {
		const value = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
		try {
			const window = normalizeOverride({ contextWindow: value }).contextWindow;
			const key = model.trim();
			if (window && key.includes(":"))
				connections.set(key, { ...getModelOverride("connection", key), contextWindow: window });
		} catch {
			/* An unusable entry never stops startup. */
		}
	}
	mergeOverrides(new Map(), connections);
	delete (settings.agent as { modelContextWindows?: unknown }).modelContextWindows;
}

/**
 * On load: move overrides an older settings.json kept inline into `overrides.json` and
 * leave only the update preference. Returns true when the document must be rewritten.
 */
export function migrateModelCatalogSettings(settings: NarraForkSettings): boolean {
	const stored = settings.agent.modelCatalog as unknown as Record<string, unknown> | undefined;
	const hasWindowMap = "modelContextWindows" in settings.agent;
	const current =
		stored && Object.keys(stored).length === 1 && typeof stored.autoUpdate === "boolean";
	if (stored && !current) importModelCatalogSettings(stored, settings);
	else if (!stored) importPreCatalogSettings(settings);
	if (hasWindowMap) importWindowMap(settings);
	// A pinned catalog was a request not to move; anything else takes the new default.
	const legacyAuto = typeof stored?.autoApply === "boolean" ? !stored.pinnedVersion : undefined;
	preference = typeof stored?.autoUpdate === "boolean" ? stored.autoUpdate : (legacyAuto ?? true);
	settings.agent.modelCatalog = { autoUpdate: preference };
	return !current || hasWindowMap;
}

/**
 * On save: this module owns `agent.modelCatalog`. A settings draft written by any other
 * page carries whatever it read earlier, so it never changes the catalog preference.
 */
export function keepModelCatalogSettings(next: NarraForkSettings): void {
	if (!settingsRef) return;
	next.agent.modelCatalog = { autoUpdate: autoUpdate() };
	delete (next.agent as { modelContextWindows?: unknown }).modelContextWindows;
}

/** The portable form for backups: the update preference and every override. */
export function exportModelCatalogSettings(): Record<string, unknown> {
	return {
		autoUpdate: autoUpdate(),
		overrides: {
			models: Object.fromEntries(overrides.models),
			connections: Object.fromEntries(overrides.connections),
		},
	};
}

/**
 * Rename or drop provider entries' own overrides, e.g. when a provider prefix changes or
 * its models disappear. `rename` returns the new model value, or null to drop the entry.
 * Throws, before writing anything, when two entries would land on one key. `dryRun`
 * only performs that check.
 */
export function rewriteConnectionOverrides(
	rename: (model: string) => string | null,
	options: { dryRun?: boolean } = {},
): boolean {
	const next = new Map<string, ModelOverride>();
	const origins = new Map<string, string>();
	let changed = false;
	for (const [model, override] of overrides.connections) {
		const target = rename(model);
		if (target !== model) changed = true;
		if (target === null) continue;
		const existing = next.get(target);
		if (existing && JSON.stringify(existing) !== JSON.stringify(override))
			throw new Error(
				`Provider model overrides for "${origins.get(target)}" and "${model}" would both become "${target}"`,
			);
		next.set(target, override);
		origins.set(target, model);
	}
	if (changed && !options.dryRun) commitOverrides({ models: overrides.models, connections: next });
	return changed;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function providerConfigs() {
	return [
		...(settingsRef?.customApiProviders ?? []),
		...(settingsRef?.openaiProviders ?? []),
		...(settingsRef?.anthropicProviders ?? []),
		...(settingsRef?.geminiProviders ?? []),
		...(settingsRef?.nugProviders ?? []),
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

/** The catalog query and any discovered metadata for a full model value. */
export function queryForModel(model: string): { query: CatalogQuery; discovered?: RawMetadata } {
	const value = model.trim();
	const config = providerConfigs().find((c) => c.prefix && value.startsWith(`${c.prefix}:`));
	const prefix = config?.prefix ?? PUBLIC_PROVIDER_KEYS.find((p) => value.startsWith(`${p}:`));
	const query: CatalogQuery = {
		upstreamModelId: prefix ? value.slice(prefix.length + 1) : value,
		...(prefix && PUBLIC_PROVIDER_KEYS.includes(prefix) ? { providerKey: prefix } : {}),
	};
	const nug = settingsRef?.nugProviders?.find((c) => c.id === config?.id);
	if (nug && prefix) {
		try {
			const info = resolveNugModelMeta(nug.id, prefix, value);
			query.providerKey = info.channelType;
			query.upstreamModelId = info.bareModel;
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
			// The gateway's tier list (even `[]`) is what its menu offers; fill it in when the
			// card is silent so the same model never gets an effort the upstream rejects.
			if (info.effortLevels !== undefined && discovered.reasoning_effort_levels == null) {
				discovered.reasoning_effort_levels = info.effortLevels;
				if (discovered.reasoning_mode == null) discovered.reasoning_mode = "levels";
			}
			return { query, discovered };
		} catch {
			/* Old gateway without cache: keep the opaque upstream identity. */
		}
	}
	for (const lookup of listingWindows) {
		const window = lookup(value);
		if (window !== undefined) return { query, discovered: { max_input_tokens: window } };
	}
	return { query };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface Snapshot {
	catalog: RawCatalog;
	overrides: OverrideState;
	cards: Map<string, ModelCard>;
}
const requestSnapshots = new AsyncLocalStorage<Snapshot>();
const current = (): Snapshot => ({ catalog: active, overrides, cards: new Map() });

const rejectedDiscoveries = new Set<string>();
function checkedDiscovery(query: CatalogQuery, discovered?: RawMetadata): RawMetadata | undefined {
	if (discovered === undefined) return undefined;
	try {
		return validateRawMetadata(discovered);
	} catch (error) {
		const key = `${query.providerKey ?? ""}:${query.upstreamModelId}`;
		if (!rejectedDiscoveries.has(key)) {
			rejectedDiscoveries.add(key);
			logger.warn("Ignoring invalid gateway model metadata", {
				upstreamModelId: query.upstreamModelId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return undefined;
	}
}

/**
 * Resolve a card for a catalog query. `model` is the full model value the query came
 * from: that provider entry's own override applies by that name. `own: false` leaves
 * it out, which is what clearing it would leave.
 */
export function resolveEffectiveModelCard(
	query: CatalogQuery,
	discovered?: RawMetadata,
	model?: string,
	options: { own?: boolean } = {},
): ModelCard {
	const snapshot = requestSnapshots.getStore() ?? current();
	const connection = model?.trim();
	return resolveModelCard({
		catalog: snapshot.catalog,
		query,
		discovered: checkedDiscovery(query, discovered),
		modelOverrides: snapshot.overrides.models,
		connectionOverride:
			connection && options.own !== false
				? snapshot.overrides.connections.get(connection)
				: undefined,
		connection,
		overridesRevision: snapshot.overrides.revision,
	});
}

/** One resolution per model and request snapshot. Callers must not mutate the result. */
function effectiveCard(model: string, own = true): ModelCard {
	const snapshot = requestSnapshots.getStore();
	const cached = own ? snapshot?.cards.get(model) : undefined;
	if (cached) return cached;
	const { query, discovered } = queryForModel(model);
	const card = resolveEffectiveModelCard(query, discovered, model, { own });
	if (own) snapshot?.cards.set(model, card);
	return card;
}

export function getEffectiveModelCard(model: string): ModelCard & { resolvedQuery: CatalogQuery } {
	return { ...structuredClone(effectiveCard(model)), resolvedQuery: queryForModel(model).query };
}

/** Typed runtime reads for a full model value (`provider:model`); `card` is read-only. */
export function getEffectiveModelProfile(
	model: string,
	options: { own?: boolean } = {},
): ModelProfile & { card: Readonly<ModelCard> } {
	const card = effectiveCard(model, options.own ?? true);
	return { ...modelProfile(card), card };
}

/** Which catalog entry a model value is, without resolving its metadata. */
export function identifyModelValue(model: string): CatalogIdentity {
	return identifyModel(active, queryForModel(model).query);
}

/**
 * The catalog model id an `auto:<id>` names, by exact id or alias; null when the catalog
 * does not know it. Suffix and prefix matches are too loose to name a model on purpose.
 */
export function canonicalCatalogModelId(id: string): string | null {
	const identity = identifyModel(active, { upstreamModelId: id.trim() });
	return identity.modelId && (identity.matchedVia === "exact" || identity.matchedVia === "alias")
		? identity.modelId
		: null;
}

/** The catalog family of a model id (`gpt`, `claude`, …), when the catalog records one. */
export function catalogModelFamily(modelId: string): string | undefined {
	const family = active.models.find((entry) => entry.id === modelId)?.family;
	return typeof family === "string" && family ? family : undefined;
}

export function catalogModelName(modelId: string): string | undefined {
	return active.models.find((entry) => entry.id === modelId)?.name;
}

/** Freeze catalog and overrides for the duration of one request. */
export function withModelMetadataSnapshot<T>(work: () => T): T {
	if (requestSnapshots.getStore()) return work();
	return requestSnapshots.run(current(), work);
}

/** An async generator is lazy: bind every iterator operation, not just creation. */
export function withModelMetadataSnapshotIterator<T, R = unknown, N = unknown>(
	factory: () => AsyncGenerator<T, R, N>,
): AsyncGenerator<T, R, N> {
	const snapshot = current();
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
// Editing
// ---------------------------------------------------------------------------

/**
 * Set or clear (`null`) one override. A model-wide override needs a catalog model id;
 * a provider-entry override needs a `provider:model` value. Only this override is
 * validated, against what it would inherit.
 */
export function setModelOverride(
	scope: OverrideScope,
	key: string,
	input: unknown,
): ModelOverride | undefined {
	const target = key.trim();
	if (scope !== "model" && scope !== "connection")
		throw new OverrideValidationError("scope", "Unknown override scope");
	if (!target) throw new OverrideValidationError("key", "Missing model");
	if (scope === "model" && !active.models.some((entry) => entry.id === target))
		throw new OverrideValidationError("key", `"${target}" is not a catalog model`);
	if (scope === "connection" && !target.includes(":"))
		throw new OverrideValidationError("key", "Expected a provider:model value");
	const override = input === null ? undefined : normalizeOverride(input);
	if (override?.defaultReasoningLevel && !override.reasoningLevels) {
		const inherited =
			scope === "connection"
				? getEffectiveModelProfile(target, { own: false }).reasoning.levels
				: modelProfile(resolveModelCard({ catalog: active, query: { upstreamModelId: target } }))
						.reasoning.levels;
		if (inherited && !inherited.includes(override.defaultReasoningLevel))
			throw new OverrideValidationError(
				"defaultReasoningLevel",
				`Default reasoning level "${override.defaultReasoningLevel}" is not one this model offers (${inherited.join(", ") || "none"})`,
			);
	}
	const models = new Map(overrides.models);
	const connections = new Map(overrides.connections);
	const map = scope === "model" ? models : connections;
	if (!override || isEmptyOverride(override)) map.delete(target);
	else map.set(target, override);
	commitOverrides({ models, connections });
	return map.get(target);
}

// ---------------------------------------------------------------------------
// Catalog updates
// ---------------------------------------------------------------------------

function shortVersion(catalog: RawCatalog): string {
	// A commit sha or the bundled snapshot's content hash; seven characters identify either.
	return catalog.sourceVersion.replace(/^bundled-/, "").slice(0, 7);
}

function countChanges(next: RawCatalog): { added: number; changed: number } {
	const before = new Map(active.models.map((m) => [m.id, JSON.stringify(m)]));
	let added = 0;
	let changed = 0;
	for (const model of next.models) {
		const previous = before.get(model.id);
		if (previous === undefined) added++;
		else if (previous !== JSON.stringify(model)) changed++;
	}
	return { added, changed };
}

let pendingChanges: { added: number; changed: number } | undefined;
export function getModelCatalogStatus(): CatalogStatus {
	if (pending && !pendingChanges) pendingChanges = countChanges(pending);
	return {
		version: shortVersion(active),
		publishedAt: active.publishedAt,
		source: active === bundled ? "builtin" : "downloaded",
		models: active.models.length,
		autoUpdate: autoUpdate(),
		...(lastCheckedAt ? { lastCheckedAt } : {}),
		...(lastError ? { lastError } : {}),
		...(pending && pendingChanges
			? {
					pending: {
						version: shortVersion(pending),
						publishedAt: pending.publishedAt,
						...pendingChanges,
					},
				}
			: {}),
	};
}

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
	const tooLarge = (size: number) =>
		new Error(`Catalog ${kind} download exceeds size limit (${size} bytes; limit ${max} bytes)`);
	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		if (response.status === 304) return {};
		if (!response.ok) throw new Error(`Catalog ${kind} download failed: HTTP ${response.status}`);
		const declared = Number(response.headers.get("content-length"));
		if (declared > max) throw tooLarge(declared);
		if (!reader) throw new Error(`Catalog ${kind} download returned no body`);
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			total += result.value.byteLength;
			if (total > max) throw tooLarge(total);
			chunks.push(result.value);
		}
	} finally {
		// Release rejected bodies too; a failing cancel must not hide the real error.
		await reader?.cancel().catch(() => undefined);
	}
	return { bytes: Buffer.concat(chunks), etag: response.headers.get("etag") ?? undefined };
}

function activate(next: RawCatalog): void {
	if (next === bundled) rmSync(catalogPath, { force: true });
	else writeJSON(catalogPath, next);
	active = next;
	pending = undefined;
	pendingChanges = undefined;
	rmSync(pendingPath, { force: true });
}

let checking: Promise<CatalogStatus> | undefined;
/** Look for a newer public catalog; apply it right away when auto update is on. */
export function checkModelCatalogUpdate(): Promise<CatalogStatus> {
	checking ??= (async () => {
		try {
			const revision = await boundedDownload(
				CATALOG_REVISION_URL,
				MAX_CATALOG_REVISION_BYTES,
				"revision",
				etag ? { "If-None-Match": etag } : undefined,
			);
			if (revision.bytes) {
				const { version, publishedAt } = parseCatalogRevision(
					JSON.parse(new TextDecoder().decode(revision.bytes)),
				);
				if (
					!active.catalogVersion.endsWith(version) &&
					!pending?.catalogVersion.endsWith(version)
				) {
					const archive = await boundedDownload(
						`${CATALOG_ARCHIVE_BASE}${version}`,
						MAX_CATALOG_BYTES,
						"archive",
					);
					if (!archive.bytes) throw new Error("Catalog archive was empty");
					const next = await catalogFromArchive(archive.bytes, version, publishedAt);
					if (autoUpdate()) activate(next);
					else {
						pending = next;
						pendingChanges = undefined;
						writeJSON(pendingPath, next);
					}
				}
				etag = revision.etag;
			}
			lastCheckedAt = new Date().toISOString();
			lastError = undefined;
		} catch (error) {
			lastCheckedAt = new Date().toISOString();
			lastError = sanitizeCatalogErrorText(error);
		}
		saveStatus();
		return getModelCatalogStatus();
	})().finally(() => {
		checking = undefined;
	});
	return checking;
}

export function applyModelCatalogUpdate(): CatalogStatus {
	if (!pending) throw new Error("There is no downloaded catalog to apply");
	activate(pending);
	return getModelCatalogStatus();
}

export function restoreBuiltinModelCatalog(): CatalogStatus {
	activate(bundled);
	etag = undefined;
	saveStatus();
	return getModelCatalogStatus();
}

export function setModelCatalogAutoUpdate(value: boolean): CatalogStatus {
	if (typeof value !== "boolean") throw new Error("autoUpdate must be true or false");
	preference = value;
	if (settingsRef) {
		settingsRef.agent.modelCatalog = { autoUpdate: value };
		persistSettings?.();
	}
	if (value && pending) activate(pending);
	return getModelCatalogStatus();
}

let dailyTimer: ReturnType<typeof setInterval> | undefined;
export function startModelCatalogDailyCheck(): void {
	if (dailyTimer) return;
	const due = () => !lastCheckedAt || Date.now() - Date.parse(lastCheckedAt) >= 86_400_000;
	dailyTimer = setInterval(() => {
		if (due()) void checkModelCatalogUpdate();
	}, 3_600_000);
	dailyTimer.unref();
}
