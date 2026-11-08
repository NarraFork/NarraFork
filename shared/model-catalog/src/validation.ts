import { validateRawMetadata } from "../card";
import type { RawCatalog, RawMetadata, RawModel } from "../schema/catalog";
import schema from "../schema/catalog.schema.json";

type Schema = {
	$ref?: string;
	anyOf?: Schema[];
	enum?: unknown[];
	type?: string;
	properties?: Record<string, Schema>;
	additionalProperties?: boolean | Schema;
	required?: string[];
	items?: Schema;
	uniqueItems?: boolean;
	minLength?: number;
	pattern?: string;
	minimum?: number;
	maximum?: number;
	format?: string;
};
export function fail(message: string): never {
	throw new Error(message);
}
export function validateShape(value: unknown, name: string): void {
	const defs = schema.$defs as unknown as Record<string, Schema>;
	function check(v: unknown, s: Schema, p: string): void {
		if (s.$ref) {
			check(v, defs[s.$ref.split("/").pop()!]!, p);
			return;
		}
		if (s.anyOf) {
			for (const candidate of s.anyOf) {
				try {
					check(v, candidate, p);
					return;
				} catch {}
			}
			fail(`Invalid value at ${p}`);
		}
		if (s.enum && !s.enum.includes(v)) fail(`Invalid enum at ${p}`);
		if (s.type === "null" && v !== null) fail(`Expected null at ${p}`);
		if (s.type === "string") {
			if (
				typeof v !== "string" ||
				v.length < (s.minLength ?? 0) ||
				(s.pattern && !new RegExp(s.pattern).test(v))
			)
				fail(`Invalid string at ${p}`);
			if (
				s.format === "date-time" &&
				(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) ||
					!Number.isFinite(Date.parse(v)))
			)
				fail(`Invalid timestamp at ${p}`);
			if (s.format === "uri") {
				try {
					const url = new URL(v);
					if (!["https:", "http:"].includes(url.protocol)) fail("protocol");
				} catch {
					fail(`Invalid URL at ${p}`);
				}
			}
		}
		if (s.type === "boolean" && typeof v !== "boolean") fail(`Expected boolean at ${p}`);
		if (
			s.type === "integer" &&
			(typeof v !== "number" ||
				!Number.isSafeInteger(v) ||
				v < (s.minimum ?? -Infinity) ||
				v > (s.maximum ?? Infinity))
		)
			fail(`Invalid integer at ${p}`);
		if (s.type === "array") {
			if (!Array.isArray(v)) fail(`Expected array at ${p}`);
			if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length)
				fail(`Duplicate array item at ${p}`);
			v.forEach((x, i) => {
				check(x, s.items!, `${p}[${i}]`);
			});
		}
		if (s.type === "object") {
			if (
				!v ||
				typeof v !== "object" ||
				Array.isArray(v) ||
				![Object.prototype, null].includes(Object.getPrototypeOf(v))
			)
				fail(`Expected plain object at ${p}`);
			const obj = v as Record<string, unknown>;
			for (const k of s.required ?? [])
				if (!Object.hasOwn(obj, k) || obj[k] === undefined) fail(`Missing ${p}.${k}`);
			for (const [k, x] of Object.entries(obj)) {
				if (["__proto__", "constructor", "prototype"].includes(k)) fail(`Forbidden key ${p}.${k}`);
				if (s.properties && Object.hasOwn(s.properties, k)) {
					// In-memory TypeScript optional undefined is equivalent to an omitted JSON key.
					if (x !== undefined) check(x, s.properties[k]!, `${p}.${k}`);
				} else if (s.additionalProperties === false) fail(`Unknown field ${p}.${k}`);
				else if (typeof s.additionalProperties === "object")
					check(x, s.additionalProperties, `${p}.${k}`);
			}
		}
	}
	check(value, defs[name] ?? fail(`Unknown schema ${name}`), name);
}

/**
 * Field groups that `matches.fields` and `sources[].fields` may name. This is the
 * public catalog's grouping vocabulary, not a metadata shape: `fieldAllowed` in
 * resolve.ts maps each group onto the raw keys it covers.
 */
export const MATCH_FIELD_GROUPS: ReadonlySet<string> = new Set([
	"limits",
	"limits.contextWindow",
	"limits.maxOutputTokens",
	"modalities",
	"modalities.input",
	"modalities.output",
	"nativeSearch",
	"nativeSearch.supported",
	"reasoning",
	"reasoning.supported",
	"reasoning.mode",
	"reasoning.levels",
	"reasoning.canDisable",
	"reasoning.defaultLevel",
	"referencePricing",
	"referencePricing.currency",
	"referencePricing.unit",
	"referencePricing.input",
	"referencePricing.output",
	"referencePricing.cacheRead",
	"referencePricing.cacheWrite",
	"referencePricing.longContext",
	"referencePricing.longContext.thresholdTokens",
	"referencePricing.longContext.basis",
	"referencePricing.longContext.mode",
	"referencePricing.longContext.input",
	"referencePricing.longContext.output",
	"referencePricing.longContext.cacheRead",
	"referencePricing.longContext.cacheWrite",
]);

/** Leaf overlay used only to check that a variant composes validly with its model. */
function overlay(base: RawMetadata, patch: RawMetadata): RawMetadata {
	const out = structuredClone(base);
	for (const [key, value] of Object.entries(patch)) {
		const before = out[key];
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			before &&
			typeof before === "object" &&
			!Array.isArray(before)
		)
			out[key] = overlay(before, value);
		else out[key] = structuredClone(value);
	}
	return out;
}

/**
 * Identity and metadata checks for a set of model/variant definitions: unique ids,
 * unambiguous match keys per provider scope, known parents, valid field groups,
 * and verified entries that cite a verified source.
 */
function validateEntries(models: RawModel[], variants: RawCatalog["variants"]): void {
	const modelIds = new Map<string, RawModel>();
	const variantIds = new Set<string>();
	const matches = new Map<string, string>();
	for (const [entries, isVariant] of [
		[models, false],
		[variants, true],
	] as const) {
		for (const entry of entries) {
			if (isVariant ? variantIds.has(entry.id) : modelIds.has(entry.id))
				fail(`Duplicate id ${entry.id}`);
			if (isVariant) variantIds.add(entry.id);
			else modelIds.set(entry.id, entry);
			validateRawMetadata(entry.metadata);
			for (const path of entry.matches?.fields ?? [])
				if (!MATCH_FIELD_GROUPS.has(path)) fail(`Invalid match field ${path}`);
			for (const source of entry.sources ?? [])
				for (const path of source.fields ?? [])
					if (!MATCH_FIELD_GROUPS.has(path)) fail(`Invalid source field ${path}`);
			if (entry.status === "verified" && !entry.sources?.some((s) => s.url && s.verifiedAt))
				fail(`Verified entry lacks verified source: ${entry.id}`);
			const scope = "providerKey" in entry ? entry.providerKey : "";
			const exact = [
				entry.id,
				...("upstreamModelIds" in entry ? entry.upstreamModelIds : []),
				...(entry.matches?.ids ?? []),
			];
			for (const [kind, keys] of [
				["exact", exact],
				["alias", entry.matches?.aliases ?? []],
				["prefix", entry.matches?.prefixes ?? []],
			] as const) {
				for (const key of keys) {
					const token = JSON.stringify([scope, kind, key]);
					const previous = matches.get(token);
					if (previous && previous !== entry.id) fail(`Ambiguous ${kind} ${key} in scope ${scope}`);
					matches.set(token, entry.id);
				}
			}
		}
	}
	for (const variant of variants) {
		const base = modelIds.get(variant.modelId);
		if (!base) fail(`Unknown model ${variant.modelId} for variant ${variant.id}`);
		validateRawMetadata(overlay(base.metadata, variant.metadata));
	}
}

export function validateRawCatalog(value: unknown): RawCatalog {
	validateShape(value, "RawCatalog");
	const catalog = value as RawCatalog;
	if (catalog.catalogVersion !== `v2:${catalog.sourceVersion}`)
		fail("Catalog version does not match its source version");
	if (!catalog.models.length || catalog.models.length + catalog.variants.length > 20000)
		fail("Invalid model count");
	validateEntries(catalog.models, catalog.variants);
	return structuredClone(catalog);
}
