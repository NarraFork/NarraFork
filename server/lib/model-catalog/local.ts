import { isDeepStrictEqual } from "node:util";
import {
	decimalValue,
	type JSONValue,
	type RawMetadata,
	validateRawMetadata,
} from "@shared/model-catalog/card";
import { normalizeRawLocalState } from "@shared/model-catalog/card-local";
import {
	legacyLocalToRaw,
	legacyPaths,
	type RawLocalState,
} from "@shared/model-catalog/card-resolver";
import type { LocalCatalogState, ModelMetadata } from "@shared/model-catalog/schema/catalog";
import { validateMetadata } from "@shared/model-catalog/src/index";
import { sourceMetadata } from "./source";

type Target = "model" | "variant" | "binding";
const keyOf = (target: Target, id: string) => `${target}:${id}`;
function flatten(value: object, prefix = ""): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (item && typeof item === "object" && !Array.isArray(item))
			Object.assign(out, flatten(item, path));
		else if (item !== undefined) out[path] = item;
	}
	return out;
}
function put(value: RawMetadata, path: string, item: JSONValue | undefined): void {
	const [key, ...rest] = path.split(".");
	if (!rest.length) {
		if (item === undefined) delete value[key!];
		else value[key!] = structuredClone(item);
		return;
	}
	const current = value[key!];
	if (!current || typeof current !== "object" || Array.isArray(current)) {
		if (item === undefined) return;
		value[key!] = {};
	}
	const child = value[key!] as RawMetadata;
	put(child, rest.join("."), item);
	if (!Object.keys(child).length) delete value[key!];
}

/** Narrow, explicitly derived compatibility projection. The original is never changed. */
export function projectLocalMetadata(original: RawMetadata): ModelMetadata {
	const raw = validateRawMetadata(original);
	const metadata = structuredClone(sourceMetadata(raw)) as ModelMetadata;
	// Total-context fields win and may constrain the output cap. `max_input_tokens` is
	// already mapped by `sourceMetadata` (and dropped there when output exceeds input).
	// `working_context_tokens` is this instance's history-assembly window — not a vendor
	// total and never an output ceiling.
	let totalContextSet = false;
	const setContextWindow = (value: number | null) => {
		metadata.limits ??= {};
		metadata.limits.contextWindow = value;
		totalContextSet = true;
	};
	if (Object.hasOwn(raw, "context_window")) setContextWindow(raw.context_window as number | null);
	else if (Object.hasOwn(raw, "legacy_context_window"))
		setContextWindow(raw.legacy_context_window as number | null);
	// Clamp output only when the window shares total semantics with the output ceiling.
	if (
		totalContextSet &&
		typeof metadata.limits?.contextWindow === "number" &&
		typeof metadata.limits.maxOutputTokens === "number" &&
		metadata.limits.maxOutputTokens > metadata.limits.contextWindow
	)
		metadata.limits.maxOutputTokens = metadata.limits.contextWindow;
	// Legacy local window edits are stored as `working_context_tokens` and must still
	// surface as v1 `contextWindow`. Expose that only when it does not invent a total
	// below an independent output ceiling; otherwise drop it (v1 has no working field).
	if (
		!totalContextSet &&
		metadata.limits?.contextWindow === undefined &&
		Object.hasOwn(raw, "working_context_tokens")
	) {
		const working = raw.working_context_tokens;
		const maxOut = metadata.limits?.maxOutputTokens;
		if (typeof working === "number" && (typeof maxOut !== "number" || maxOut <= working)) {
			metadata.limits ??= {};
			metadata.limits.contextWindow = working;
		}
	}
	if (
		metadata.reasoning?.mode &&
		!["levels", "fixed", "budget", "unknown"].includes(metadata.reasoning.mode)
	)
		delete metadata.reasoning.mode;
	for (const direction of ["input", "output"] as const) {
		const values = metadata.modalities?.[direction];
		if (Array.isArray(values))
			metadata.modalities![direction] = values.filter((item) =>
				["text", "image", "audio", "video"].includes(item),
			);
	}
	return validateMetadata(metadata);
}

/** V1 cannot express independent limits; this projection may constrain its output field. */
export function projectResolvedCard(
	card: import("@shared/model-catalog/card").ModelCard,
): import("@shared/model-catalog/schema/catalog").ResolvedModelMetadata {
	const metadata = projectLocalMetadata(card.metadata);
	const provenance: import("@shared/model-catalog/schema/catalog").ResolvedModelMetadata["provenance"] =
		{};
	for (const path of Object.keys(flatten(metadata))) {
		let key: string | undefined = legacyPaths[path];
		if (path === "limits.contextWindow")
			// Prefer true totals / input-cap over the working window; working is only
			// cited when it was the one field the projection actually kept.
			key = [
				"context_window",
				"legacy_context_window",
				"max_input_tokens",
				"working_context_tokens",
			].find((key) => Object.hasOwn(card.metadata, key));
		if (path.startsWith("referencePricing.longContext.")) {
			const field = path.slice("referencePricing.longContext.".length);
			const explicit = `reference_pricing_long_context.${field}`;
			const base = legacyPaths[`referencePricing.${field}`];
			const threshold = metadata.referencePricing?.longContext?.thresholdTokens;
			key = card.provenance[explicit]
				? explicit
				: base && threshold
					? `${base}_above_${threshold / 1000}k_tokens`
					: "long_context_input_token_threshold";
			if (!card.provenance[key] && base) key = base;
		}
		if (key && card.provenance[key]) provenance[path] = { ...card.provenance[key] };
	}
	const { view: _view, metadata: _metadata, provenance: _provenance, ...identity } = card;
	return { ...identity, schemaVersion: 1, metadata, provenance };
}

/** Runtime v1 DTOs carry immutable originals; only the raw document is written to disk. */
export function rawLocalToLegacy(input: RawLocalState): LocalCatalogState {
	const local = normalizeRawLocalState(input);
	const status = (value: string | undefined) =>
		value === "unverified"
			? ("legacy-unverified" as const)
			: (value as "verified" | "legacy-unverified" | "deprecated" | undefined);
	return {
		...local,
		models: local.models?.map(({ metadata, ...entry }) => ({
			...entry,
			status: status(entry.status),
			metadata: projectLocalMetadata(metadata),
			rawMetadata: structuredClone(metadata),
		})),
		variants: local.variants?.map(({ metadata, ...entry }) => ({
			...entry,
			status: status(entry.status),
			metadata: projectLocalMetadata(metadata),
			rawMetadata: structuredClone(metadata),
		})),
		bindings: local.bindings?.map(({ overrides, ...entry }) => ({
			...entry,
			...(overrides === undefined
				? {}
				: { overrides: projectLocalMetadata(overrides), rawMetadata: structuredClone(overrides) }),
		})),
		overrides: local.overrides?.map(({ metadata, ...entry }) => ({
			...entry,
			metadata: projectLocalMetadata(metadata),
			rawMetadata: structuredClone(metadata),
		})),
	};
}

interface Scope {
	target: Target;
	id: string;
	metadata: Record<string, unknown>;
}
function legacyScopes(local: LocalCatalogState): Map<string, Scope> {
	const out = new Map<string, Scope>();
	const add = (target: Target, id: string, metadata: object) => {
		const key = keyOf(target, id);
		out.set(key, { target, id, metadata: { ...out.get(key)?.metadata, ...flatten(metadata) } });
	};
	for (const m of local.models ?? []) add("model", m.id, m.metadata);
	for (const v of local.variants ?? []) add("variant", v.id, v.metadata);
	for (const b of local.bindings ?? []) add("binding", b.id, b.overrides ?? {});
	for (const o of local.overrides ?? []) add(o.target, o.targetId, o.metadata);
	return out;
}

export function legacyScopeMetadata(
	local: LocalCatalogState,
	target: Target,
	id: string,
): ModelMetadata {
	const metadata: RawMetadata = {};
	for (const [path, value] of Object.entries(
		legacyScopes(local).get(keyOf(target, id))?.metadata ?? {},
	))
		put(metadata, path, value as JSONValue);
	return validateMetadata(metadata);
}
function rawScopes(local: RawLocalState): Map<string, RawMetadata> {
	const out = new Map<string, RawMetadata>();
	for (const m of local.models ?? []) out.set(keyOf("model", m.id), m.metadata);
	for (const v of local.variants ?? []) out.set(keyOf("variant", v.id), v.metadata);
	for (const b of local.bindings ?? []) out.set(keyOf("binding", b.id), b.overrides ?? {});
	for (const o of local.overrides ?? []) out.set(keyOf(o.target, o.targetId), o.metadata);
	return out;
}
function storeScope(local: RawLocalState, target: Target, id: string, metadata: RawMetadata): void {
	if (target === "binding") {
		const binding = local.bindings?.find((b) => b.id === id);
		if (!binding) throw new Error("Use the v2 editor to remove a binding with newer metadata");
		if (Object.keys(metadata).length) binding.overrides = metadata;
		else delete binding.overrides;
		return;
	}
	const definition = (target === "model" ? local.models : local.variants)?.find((m) => m.id === id);
	if (definition) {
		definition.metadata = metadata;
		return;
	}
	local.overrides = (local.overrides ?? []).filter((o) => o.target !== target || o.targetId !== id);
	if (Object.keys(metadata).length)
		local.overrides.push({ target, targetId: id, metadata, source: "user" });
}

/** Apply only v1-representable changes, never a replacement of the original v2 metadata. */
export function reconcileLegacyLocal(
	before: LocalCatalogState,
	after: LocalCatalogState,
	options: { deleted?: Set<string>; trustedSources?: boolean } = {},
): LocalCatalogState {
	if (!options.trustedSources) {
		for (const name of ["models", "variants", "bindings", "overrides"] as const) {
			for (const entry of after[name] ?? []) {
				const identity = "id" in entry ? entry.id : keyOf(entry.target, entry.targetId);
				const old = (before[name] ?? []).find(
					(item) => ("id" in item ? item.id : keyOf(item.target, item.targetId)) === identity,
				);
				if (
					entry.rawMetadata !== undefined &&
					!isDeepStrictEqual(entry.rawMetadata, old?.rawMetadata)
				)
					throw new Error("Original metadata is read-only in v1; use the v2 editor");
			}
		}
	}
	const original = legacyLocalToRaw(before);
	const output = legacyLocalToRaw(after);
	const previousScopes = legacyScopes(before),
		nextScopes = legacyScopes(after),
		originals = rawScopes(original);
	output.legacyFields = { ...original.legacyFields, ...output.legacyFields };
	for (const [key, previous] of previousScopes) {
		if (options.deleted?.has(key)) {
			delete output.legacyFields[key];
			continue;
		}
		const next = nextScopes.get(key);
		const metadata = structuredClone(originals.get(key) ?? {});
		const changed: string[] = [];
		for (const path of new Set([
			...Object.keys(previous.metadata),
			...Object.keys(next?.metadata ?? {}),
		])) {
			const value = next?.metadata[path];
			if (isDeepStrictEqual(previous.metadata[path], value)) continue;
			if (path === "referencePricing.currency" || path === "referencePricing.unit") continue;
			let rawPath = legacyPaths[path];
			if (path === "limits.contextWindow") rawPath = "working_context_tokens";
			if (path.startsWith("referencePricing.longContext."))
				rawPath = path.replace("referencePricing.longContext.", "reference_pricing_long_context.");
			if (!rawPath) throw new Error(`Cannot safely convert ${path}; use the v2 editor`);
			if (
				path === "limits.contextWindow" &&
				metadata.working_context_tokens === undefined &&
				(metadata.max_input_tokens !== undefined || metadata.context_window !== undefined)
			)
				throw new Error("This is a vendor limit, not a legacy working window; use the v2 editor");
			put(
				metadata,
				rawPath,
				value === undefined
					? undefined
					: path.startsWith("referencePricing.") &&
							!path.startsWith("referencePricing.longContext.") &&
							value !== null
						? decimalValue(value, -6)
						: (value as JSONValue),
			);
			changed.push(rawPath);
		}
		if (!next && Object.keys(metadata).length)
			throw new Error("This scope contains newer fields; remove it explicitly using the v2 editor");
		if (next) storeScope(output, next.target, next.id, validateRawMetadata(metadata));
		if (output.legacyFields[key]) {
			output.legacyFields[key] = output.legacyFields[key]!.filter(
				(field) =>
					!changed.some(
						(path) =>
							field === path || field.startsWith(`${path}.`) || path.startsWith(`${field}.`),
					),
			);
			if (!output.legacyFields[key]!.length) delete output.legacyFields[key];
		}
	}
	return rawLocalToLegacy(output);
}
