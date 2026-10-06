import type {
	FieldSource,
	MatchRules,
	MetadataSource,
	ResolvedModelMetadata,
} from "./schema/catalog";
import { validateCatalog } from "./src/validation";

export type JSONValue =
	| null
	| boolean
	| number
	| string
	| JSONValue[]
	| { [key: string]: JSONValue };
export type RawMetadata = { [key: string]: JSONValue };
export interface RawModel {
	id: string;
	name?: string;
	vendor?: string;
	family?: string;
	notes?: string;
	matches?: MatchRules;
	metadata: RawMetadata;
	status?: "verified" | "unverified" | "legacy-unverified" | "deprecated";
	sources?: MetadataSource[];
}
export interface RawVariant extends RawModel {
	modelId: string;
	providerKey: string;
	upstreamModelIds: string[];
}
export interface RawCatalog {
	schemaVersion: 2;
	/** Format-qualified storage key; pinning uses sourceVersion, not this key. */
	catalogVersion: string;
	sourceVersion: string;
	publishedAt: string;
	models: RawModel[];
	variants: RawVariant[];
}
export interface CardField {
	key: string;
	group: "identity" | "limits" | "modalities" | "capabilities" | "reasoning";
	kind: "string" | "integer" | "number" | "boolean" | "strings";
	unit?: string;
}
export const cardFields: readonly CardField[] = [
	{ key: "mode", group: "identity", kind: "string" },
	{ key: "litellm_provider", group: "identity", kind: "string" },
	{ key: "deprecation_date", group: "identity", kind: "string" },
	{ key: "supported_endpoints", group: "identity", kind: "strings" },
	...[
		"max_input_tokens",
		"max_output_tokens",
		"context_window",
		"working_context_tokens",
		"legacy_context_window",
	].map((key) => ({ key, group: "limits" as const, kind: "integer" as const, unit: "token" })),
	...[
		"max_images_per_prompt",
		"max_audio_per_prompt",
		"max_videos_per_prompt",
		"output_vector_size",
	].map((key) => ({ key, group: "limits" as const, kind: "integer" as const })),
	{ key: "max_audio_length_hours", group: "limits", kind: "number", unit: "hour" },
	{ key: "max_pdf_size_mb", group: "limits", kind: "number", unit: "MB" },
	{ key: "supported_modalities", group: "modalities", kind: "strings" },
	{ key: "supported_output_modalities", group: "modalities", kind: "strings" },
	...[
		"supports_reasoning",
		"supports_adaptive_thinking",
		"supports_assistant_prefill",
		"supports_multimodal",
		"supports_output_config",
		"supports_system_messages",
		"supports_function_calling",
		"supports_parallel_function_calling",
		"supports_tool_choice",
		"supports_vision",
		"supports_audio_input",
		"supports_audio_output",
		"supports_video_input",
		"supports_pdf_input",
		"supports_web_search",
		"supports_response_schema",
		"supports_prompt_caching",
		"supports_computer_use",
		"supports_code_execution",
		"supports_file_search",
		"supports_url_context",
		"supports_native_streaming",
		"supports_service_tier",
		"supports_none_reasoning_effort",
		"supports_minimal_reasoning_effort",
		"supports_low_reasoning_effort",
		"supports_xhigh_reasoning_effort",
		"supports_max_reasoning_effort",
	].map((key) => ({ key, group: "capabilities" as const, kind: "boolean" as const })),
	{ key: "reasoning_mode", group: "reasoning", kind: "string" },
	{ key: "reasoning_effort_levels", group: "reasoning", kind: "strings" },
	{ key: "default_reasoning_effort", group: "reasoning", kind: "string" },
	{ key: "can_disable_reasoning", group: "reasoning", kind: "boolean" },
];
const fieldByKey = new Map(cardFields.map((field) => [field.key, field]));
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
// Model metadata is not an account response or a gateway charge configuration.
const operationalKeys = new Set([
	"billingmultiplier",
	"tokenspercredit",
	"tokenpercredit",
	"creditmultiplier",
	"billingrules",
	"actualpricing",
	"billingconfig",
	"credentials",
	"apikey",
	"accesskey",
	"accesstoken",
	"refreshtoken",
	"password",
	"authorization",
	"proxyurl",
	"proxyaddress",
]);
const priceDefinitions: Record<string, { component: string; modality: string; unit: string }> = {
	input_cost_per_token: { component: "input", modality: "text", unit: "token" },
	output_cost_per_token: { component: "output", modality: "text", unit: "token" },
	output_cost_per_reasoning_token: { component: "output", modality: "reasoning", unit: "token" },
	cache_read_input_token_cost: { component: "cacheRead", modality: "text", unit: "token" },
	cache_creation_input_token_cost: { component: "cacheWrite", modality: "text", unit: "token" },
	input_cost_per_image_token: { component: "input", modality: "image", unit: "token" },
	output_cost_per_image_token: { component: "output", modality: "image", unit: "token" },
	cache_read_input_image_token_cost: { component: "cacheRead", modality: "image", unit: "token" },
	input_cost_per_audio_token: { component: "input", modality: "audio", unit: "token" },
	output_cost_per_audio_token: { component: "output", modality: "audio", unit: "token" },
	cache_read_input_audio_token_cost: { component: "cacheRead", modality: "audio", unit: "token" },
	cache_read_input_token_cost_per_audio_token: {
		component: "cacheRead",
		modality: "audio",
		unit: "token",
	},
	cache_creation_input_audio_token_cost: {
		component: "cacheWrite",
		modality: "audio",
		unit: "token",
	},
	input_cost_per_image: { component: "input", modality: "image", unit: "image" },
	output_cost_per_image: { component: "output", modality: "image", unit: "image" },
	input_cost_per_audio_per_second: { component: "input", modality: "audio", unit: "second" },
	input_cost_per_video_per_second: { component: "input", modality: "video", unit: "second" },
	output_cost_per_second: { component: "output", modality: "media", unit: "second" },
	input_cost_per_character: { component: "input", modality: "text", unit: "character" },
};
export interface PriceRow {
	key: string;
	component: string;
	modality: string;
	unit: string;
	currency: string;
	tier: string;
	thresholdTokens: number | null;
	cacheDuration: "default" | "1h" | null;
	/** Exact decimal per source unit; null is explicit unknown. */
	rate: string | null;
	displayRate: string | null;
	displayQuantity: number;
	derived: boolean;
}
export interface PriceGroup {
	tier: string;
	rows: PriceRow[];
}
export interface ModelCardView {
	mode: string | null;
	category: string;
	limits: {
		maxInputTokens?: JSONValue;
		maxOutputTokens?: JSONValue;
		totalContextTokens?: JSONValue;
		workingContextTokens?: JSONValue;
	};
	fields: Array<CardField & { value: JSONValue }>;
	prices: PriceGroup[];
	pricingBasis: string | null;
	/** Source attributes not represented by registered controls/price rows. Never dropped. */
	attributes: RawMetadata;
}
export interface ModelCard {
	schemaVersion: 2;
	catalogVersion: string;
	localRevision: number;
	modelId?: string;
	variantId?: string;
	bindingId?: string;
	matchedVia: ResolvedModelMetadata["matchedVia"];
	metadata: RawMetadata;
	provenance: Record<string, FieldSource>;
	view: ModelCardView;
}

/** Shift an exact decimal, accepting JSON scientific notation without floating-point multiplication. */
export function decimalValue(value: unknown, power = 0): string {
	if (typeof value !== "number" && typeof value !== "string")
		throw new Error("Expected a decimal price");
	const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(value));
	if (!match) throw new Error("Expected a non-negative decimal price");
	let digits = (match[1]! + (match[2] ?? "")).replace(/^0+(?=\d)/, "");
	const shift = Number(match[3] ?? 0) - (match[2]?.length ?? 0) + power;
	if (!Number.isSafeInteger(shift) || Math.abs(shift) > 300 || digits.length > 300)
		throw new Error("Decimal price exceeds size limit");
	if (shift >= 0) return (digits + "0".repeat(shift)).replace(/^0+(?=\d)/, "");
	digits = digits.padStart(1 - shift, "0");
	return `${digits.slice(0, shift)}.${digits.slice(shift)}`.replace(/0+$/, "").replace(/\.$/, "");
}
export function multiplyDecimal(a: unknown, b: unknown): string {
	const x = decimalValue(a),
		y = decimalValue(b);
	const scale = (x.split(".")[1]?.length ?? 0) + (y.split(".")[1]?.length ?? 0);
	return decimalValue(String(BigInt(x.replace(".", "")) * BigInt(y.replace(".", ""))), -scale);
}
function priceIdentity(
	key: string,
): Omit<PriceRow, "rate" | "displayRate" | "displayQuantity" | "currency" | "derived"> | undefined {
	if (/^search_context_cost_per_query\.search_context_size_(low|medium|high)$/.test(key))
		return {
			key,
			component: "search",
			modality: key.slice(30),
			unit: "request",
			tier: "standard",
			thresholdTokens: null,
			cacheDuration: null,
		};
	let stem = key;
	let tier = "standard";
	const service = /_(batches|batch|flex|priority)$/.exec(stem);
	if (service) {
		tier = service[1] === "batches" ? "batch" : service[1]!;
		stem = stem.slice(0, -service[0].length);
	}
	let thresholdTokens: number | null = null;
	const threshold = /_above_(\d+)(k)?_tokens$/.exec(stem);
	if (threshold) {
		thresholdTokens = Number(threshold[1]) * (threshold[2] ? 1000 : 1);
		stem = stem.slice(0, -threshold[0].length);
	}
	let cacheDuration: PriceRow["cacheDuration"] = null;
	if (stem.endsWith("_above_1hr")) {
		cacheDuration = "1h";
		stem = stem.slice(0, -10);
	}
	const definition = priceDefinitions[stem];
	if (!definition) return undefined;
	if (definition.component === "cacheWrite" && cacheDuration === null) cacheDuration = "default";
	return { key, ...definition, tier, thresholdTokens, cacheDuration };
}
export function isRawPriceField(key: string): boolean {
	return (
		priceIdentity(key) !== undefined ||
		key.startsWith("long_context_") ||
		key.startsWith("reference_pricing_long_context") ||
		key.startsWith("provider_specific_entry") ||
		/(^|[_.])(cost|price|pricing|multiplier|rate)([_.]|$)/.test(key)
	);
}
function validateField(key: string, value: JSONValue): void {
	if (value === null) return;
	const field = fieldByKey.get(key);
	if (field) {
		if (
			field.kind === "integer" &&
			(typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
		)
			throw new Error(`${key}: expected a positive integer`);
		if (field.kind === "number" && (typeof value !== "number" || value < 0))
			throw new Error(`${key}: expected a non-negative number`);
		if (field.kind === "boolean" && typeof value !== "boolean")
			throw new Error(`${key}: expected boolean or null`);
		if (field.kind === "string" && typeof value !== "string")
			throw new Error(`${key}: expected string or null`);
		if (
			field.kind === "strings" &&
			(!Array.isArray(value) || value.some((item) => typeof item !== "string"))
		)
			throw new Error(`${key}: expected string array or null`);
	}
	if (
		priceIdentity(key) ||
		key === "long_context_input_cost_multiplier" ||
		key === "long_context_output_cost_multiplier"
	)
		decimalValue(value);
	if (
		key === "long_context_input_token_threshold" &&
		(typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
	)
		throw new Error(`${key}: expected a positive token threshold`);
	if (key === "long_context_pricing_basis" && !["full", "marginal"].includes(String(value)))
		throw new Error(`${key}: expected full or marginal`);
}
export function validateRawMetadata(value: unknown): RawMetadata {
	let count = 0;
	const visit = (item: unknown, depth: number) => {
		if (++count > 10000 || depth > 20) throw new Error("Model metadata exceeds structural limit");
		if (item === null || typeof item === "string" || typeof item === "boolean") return;
		if (typeof item === "number" && Number.isFinite(item)) return;
		if (Array.isArray(item)) {
			for (const child of item) visit(child, depth + 1);
			return;
		}
		if (
			!item ||
			typeof item !== "object" ||
			(Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
		)
			throw new Error("Model metadata must contain JSON values only");
		for (const [key, child] of Object.entries(item)) {
			if (forbidden.has(key) || operationalKeys.has(key.replace(/[_-]/g, "").toLowerCase()))
				throw new Error(`Unsafe or operational metadata key: ${key}`);
			visit(child, depth + 1);
		}
	};
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected model metadata object");
	visit(value, 0);
	if (JSON.stringify(value).length > 262144) throw new Error("Model metadata exceeds size limit");
	const raw = value as RawMetadata;
	for (const [key, item] of Object.entries(raw)) validateField(key, item);
	// Independent input and output limits are valid even when output is larger.
	if (
		typeof raw.context_window === "number" &&
		typeof raw.max_output_tokens === "number" &&
		raw.max_output_tokens > raw.context_window
	)
		throw new Error("Output exceeds explicitly declared total context");
	if (
		typeof raw.default_reasoning_effort === "string" &&
		Array.isArray(raw.reasoning_effort_levels) &&
		!raw.reasoning_effort_levels.includes(raw.default_reasoning_effort)
	)
		throw new Error("Default reasoning effort is not an allowed level");
	return structuredClone(raw);
}
export function patchRawMetadata(
	metadata: RawMetadata,
	patch: { set?: Record<string, JSONValue>; reset?: string[] },
): RawMetadata {
	const next = validateRawMetadata(metadata);
	const allowed = (path: string) => {
		if (path.split(".").some((part) => forbidden.has(part) || !part))
			throw new Error(`Unsafe patch path: ${path}`);
		if (
			!fieldByKey.has(path) &&
			!priceIdentity(path) &&
			![
				"long_context_input_token_threshold",
				"long_context_input_cost_multiplier",
				"long_context_output_cost_multiplier",
				"long_context_pricing_basis",
			].includes(path)
		)
			throw new Error(`Read-only or unknown metadata field: ${path}`);
	};
	for (const path of patch.reset ?? []) {
		allowed(path);
		if (path.startsWith("search_context_cost_per_query.")) {
			const parent = next.search_context_cost_per_query;
			if (parent && typeof parent === "object" && !Array.isArray(parent))
				delete parent[path.slice(30)];
		} else delete next[path];
	}
	for (const [path, value] of Object.entries(patch.set ?? {})) {
		allowed(path);
		validateField(path, value);
		if (path.startsWith("search_context_cost_per_query.")) {
			const parent = next.search_context_cost_per_query;
			const object = parent && typeof parent === "object" && !Array.isArray(parent) ? parent : {};
			object[path.slice(30)] = structuredClone(value);
			next.search_context_cost_per_query = object;
		} else next[path] = structuredClone(value);
	}
	return validateRawMetadata(next);
}
export function modelCardView(metadata: RawMetadata): ModelCardView {
	const raw = validateRawMetadata(metadata);
	const currency = typeof raw.currency === "string" ? raw.currency : "USD";
	const rows: PriceRow[] = [];
	const consumed = new Set<string>();
	const add = (key: string, value: JSONValue) => {
		const identity = priceIdentity(key);
		if (!identity) return;
		const rate = value === null ? null : decimalValue(value);
		rows.push({
			...identity,
			currency,
			rate,
			displayRate: rate === null ? null : decimalValue(rate, identity.unit === "token" ? 6 : 0),
			displayQuantity: identity.unit === "token" ? 1000000 : 1,
			derived: false,
		});
		consumed.add(key.split(".")[0]!);
	};
	for (const [key, value] of Object.entries(raw)) {
		if (
			key === "search_context_cost_per_query" &&
			value &&
			typeof value === "object" &&
			!Array.isArray(value)
		) {
			for (const [name, price] of Object.entries(value)) add(`${key}.${name}`, price);
		} else add(key, value);
	}
	const threshold = raw.long_context_input_token_threshold;
	if (typeof threshold === "number" && threshold > 0) {
		for (const base of [...rows]) {
			if (base.thresholdTokens !== null || base.unit !== "token") continue;
			if (
				rows.some(
					(row) =>
						row.tier === base.tier &&
						row.thresholdTokens === threshold &&
						row.component === base.component &&
						row.modality === base.modality &&
						row.cacheDuration === base.cacheDuration,
				)
			)
				continue;
			const multiplier =
				raw[
					base.component === "output"
						? "long_context_output_cost_multiplier"
						: "long_context_input_cost_multiplier"
				];
			if (typeof multiplier !== "number" && typeof multiplier !== "string") continue;
			const rate = base.rate === null ? null : multiplyDecimal(base.rate, multiplier);
			rows.push({
				...base,
				key: `${base.key}@above:${threshold}`,
				thresholdTokens: threshold,
				rate,
				displayRate: rate === null ? null : decimalValue(rate, 6),
				derived: true,
			});
		}
	}
	const tiers = ["standard", "batch", "flex", "priority"];
	const groups = [...new Set(rows.map((row) => row.tier))]
		.sort((a, b) => tiers.indexOf(a) - tiers.indexOf(b))
		.map((tier) => ({
			tier,
			rows: rows
				.filter((row) => row.tier === tier)
				.sort(
					(a, b) =>
						(a.thresholdTokens ?? -1) - (b.thresholdTokens ?? -1) ||
						(a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
				),
		}));
	const fields = cardFields
		.filter((field) => Object.hasOwn(raw, field.key))
		.map((field) => {
			consumed.add(field.key);
			return { ...field, value: raw[field.key]! };
		});
	const mode = typeof raw.mode === "string" ? raw.mode : null;
	const category =
		mode === null
			? "unknown"
			: ["chat", "responses", "completion"].includes(mode)
				? "text"
				: mode === "image_generation"
					? "image"
					: mode.startsWith("audio_")
						? "audio"
						: mode;
	const limits: ModelCardView["limits"] = {};
	for (const [target, key] of Object.entries({
		maxInputTokens: "max_input_tokens",
		maxOutputTokens: "max_output_tokens",
		totalContextTokens: "context_window",
		workingContextTokens: "working_context_tokens",
	}))
		if (Object.hasOwn(raw, key)) limits[target as keyof typeof limits] = raw[key];
	return {
		mode,
		category,
		limits,
		fields,
		prices: groups,
		pricingBasis:
			typeof raw.long_context_pricing_basis === "string"
				? raw.long_context_pricing_basis
				: rows.some((row) => row.thresholdTokens !== null)
					? "full"
					: null,
		attributes: Object.fromEntries(Object.entries(raw).filter(([key]) => !consumed.has(key))),
	};
}

export function rawCatalogFromModelFiles(
	files: Map<string, string>,
	sourceVersion: string,
	publishedAt: string,
): RawCatalog {
	const models: RawModel[] = [],
		variants: RawVariant[] = [];
	for (const [filename, text] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		if (!/^[a-z0-9][a-z0-9._-]*\.json$/.test(filename)) throw new Error("Invalid model filename");
		const entry = JSON.parse(text);
		if (
			!entry ||
			Array.isArray(entry) ||
			entry.id !== filename.slice(0, -5) ||
			!Array.isArray(entry.variants)
		)
			throw new Error(`Expected one model and nested variants in ${filename}`);
		const { variants: children, ...model } = entry;
		model.metadata = validateRawMetadata(model.metadata);
		models.push(model);
		for (const child of children) {
			if (!child || typeof child !== "object" || Array.isArray(child) || "modelId" in child)
				throw new Error("Variant parent must be its containing model");
			variants.push({ ...child, modelId: model.id, metadata: validateRawMetadata(child.metadata) });
		}
	}
	if (!models.length || models.length + variants.length > 20000)
		throw new Error("Invalid model count");
	// Reuse the existing identity/reference validation; raw field validation is separate.
	const identity = (entry: RawModel) => ({
		...entry,
		metadata: {},
		status:
			entry.status === "unverified" ? "legacy-unverified" : (entry.status ?? "legacy-unverified"),
	});
	validateCatalog({
		schemaVersion: 1,
		catalogVersion: sourceVersion,
		publishedAt,
		models: models.map(identity),
		variants: variants.map(identity),
	});
	return {
		schemaVersion: 2,
		catalogVersion: `v2:${sourceVersion}`,
		sourceVersion,
		publishedAt,
		models,
		variants,
	};
}
