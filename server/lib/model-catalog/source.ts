import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { CatalogDocument } from "@shared/model-catalog/schema/catalog";
import { validateCatalog } from "@shared/model-catalog/src/index";

export const CATALOG_REVISION_URL =
	"https://api.github.com/repos/NarraFork/narrafork-model-catalog/commits/main";
export const CATALOG_ARCHIVE_BASE =
	"https://codeload.github.com/NarraFork/narrafork-model-catalog/tar.gz/";
export const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

export function parseCatalogRevision(value: unknown): { version: string; publishedAt: string } {
	const revision = value as { sha?: string; commit?: { committer?: { date?: string } } } | null;
	const version = revision?.sha;
	const publishedAt = revision?.commit?.committer?.date;
	if (
		typeof version !== "string" ||
		!/^[a-f0-9]{40}$/.test(version) ||
		typeof publishedAt !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(publishedAt) ||
		!Number.isFinite(Date.parse(publishedAt))
	)
		throw new Error("Invalid catalog Git revision");
	return { version, publishedAt };
}

const sourcePrices = {
	input: "input_cost_per_token",
	output: "output_cost_per_token",
	cacheRead: "cache_read_input_token_cost",
	cacheWrite: "cache_creation_input_token_cost",
} as const;

function sourcePrice(value: unknown, multiplier = 1): string | null {
	if (value === null) return null;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		!Number.isFinite(multiplier) ||
		multiplier < 0
	)
		throw new Error("Invalid per-token reference price");
	const parts = (number: number) => {
		const [mantissa, exponent = "0"] = String(number).toLowerCase().split("e");
		const [whole, fraction = ""] = mantissa!.split(".");
		return { digits: BigInt(whole! + fraction), scale: Number(exponent) - fraction.length };
	};
	const a = parts(value),
		b = parts(multiplier);
	let digits = String(a.digits * b.digits);
	const scale = a.scale + b.scale + 6;
	if (scale >= 0) return (digits + "0".repeat(scale)).replace(/^0+(?=\d)/, "");
	digits = digits.padStart(1 - scale, "0");
	return `${digits.slice(0, scale)}.${digits.slice(scale)}`.replace(/0+$/, "").replace(/\.$/, "");
}

/** Consume LiteLLM/sub2api fields locally; the public catalog retains the complete source row. */
function sourceMetadata(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const raw = value as Record<string, unknown>;
	// Existing application snapshots/API fixtures remain in the application's own format.
	if (
		!Object.keys(raw).length ||
		["limits", "modalities", "nativeSearch", "reasoning", "referencePricing"].some(
			(key) => key in raw,
		)
	)
		return value;
	if (
		!("litellm_provider" in raw) &&
		!Object.keys(raw).some((key) =>
			/^(max_|supported_|supports_|reasoning_|default_reasoning_|can_disable_reasoning|reference_pricing_|.*_cost_per_token|cache_.*_token_cost)/.test(
				key,
			),
		)
	)
		return value;
	const metadata: Record<string, Record<string, unknown>> = {};
	const set = (group: string, field: string, source: string) => {
		if (Object.hasOwn(raw, source)) (metadata[group] ??= {})[field] = raw[source];
	};
	set("limits", "contextWindow", "max_input_tokens");
	set("limits", "maxOutputTokens", "max_output_tokens");
	// Separate input/output caps are not necessarily a total-context limit. Preserve the
	// source row verbatim, but do not invent a total window smaller than its output cap.
	if (
		typeof raw.max_input_tokens === "number" &&
		typeof raw.max_output_tokens === "number" &&
		raw.max_output_tokens > raw.max_input_tokens
	)
		delete metadata.limits!.contextWindow;
	set("modalities", "input", "supported_modalities");
	set("modalities", "output", "supported_output_modalities");
	if (!("supported_modalities" in raw) && raw.supports_vision === true)
		(metadata.modalities ??= {}).input = ["text", "image"];
	set("nativeSearch", "supported", "supports_web_search");
	set("reasoning", "supported", "supports_reasoning");
	set("reasoning", "mode", "reasoning_mode");
	set("reasoning", "levels", "reasoning_effort_levels");
	set("reasoning", "defaultLevel", "default_reasoning_effort");
	set("reasoning", "canDisable", "supports_none_reasoning_effort");
	set("reasoning", "canDisable", "can_disable_reasoning");
	for (const [field, key] of Object.entries(sourcePrices)) {
		if (Object.hasOwn(raw, key)) (metadata.referencePricing ??= {})[field] = sourcePrice(raw[key]);
	}
	if (metadata.referencePricing)
		Object.assign(metadata.referencePricing, { currency: "USD", unit: "perMillionTokens" });
	const thresholds = Object.keys(raw).flatMap((key) => {
		const match =
			/^(?:input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)k_tokens$/.exec(
				key,
			);
		return match ? [Number(match[1]) * 1000] : [];
	});
	const threshold =
		typeof raw.long_context_input_token_threshold === "number"
			? raw.long_context_input_token_threshold
			: thresholds.length
				? Math.min(...thresholds)
				: undefined;
	if (threshold !== undefined && threshold > 0) {
		const tier: Record<string, unknown> = {
			thresholdTokens: threshold,
			basis: "promptTokens",
			mode: "full",
		};
		const suffix = `_above_${threshold / 1000}k_tokens`;
		let inputMultiplier =
			typeof raw.long_context_input_cost_multiplier === "number" &&
			raw.long_context_input_cost_multiplier > 0
				? raw.long_context_input_cost_multiplier
				: 1;
		if (
			inputMultiplier === 1 &&
			typeof raw.input_cost_per_token === "number" &&
			raw.input_cost_per_token > 0 &&
			typeof raw[`input_cost_per_token${suffix}`] === "number"
		)
			inputMultiplier = (raw[`input_cost_per_token${suffix}`] as number) / raw.input_cost_per_token;
		const outputMultiplier =
			typeof raw.long_context_output_cost_multiplier === "number" &&
			raw.long_context_output_cost_multiplier > 0
				? raw.long_context_output_cost_multiplier
				: 1;
		for (const [field, key] of Object.entries(sourcePrices)) {
			if (Object.hasOwn(raw, key + suffix)) tier[field] = sourcePrice(raw[key + suffix]);
			else if (Object.hasOwn(raw, key))
				tier[field] = sourcePrice(
					raw[key],
					field === "output" ? outputMultiplier : inputMultiplier,
				);
		}
		(metadata.referencePricing ??= {}).longContext = tier;
	}
	if (Object.hasOwn(raw, "reference_pricing_long_context"))
		(metadata.referencePricing ??= {}).longContext = raw.reference_pricing_long_context;
	return metadata;
}
/** The public repository is data only. This conversion belongs to NarraFork. */
export function catalogFromModelFiles(
	files: Map<string, string>,
	version: string,
	publishedAt: string,
): CatalogDocument {
	const models: unknown[] = [];
	const variants: unknown[] = [];
	for (const [filename, text] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		if (!/^[a-z0-9][a-z0-9._-]*\.json$/.test(filename)) throw new Error("Invalid model filename");
		const value = JSON.parse(text);
		if (
			!value ||
			Array.isArray(value) ||
			value.id !== filename.slice(0, -5) ||
			!Array.isArray(value.variants)
		) {
			throw new Error(`Expected one model and its variants in ${filename}`);
		}
		const { variants: nested, status = "unverified", ...model } = value;
		const internalStatus = status === "unverified" ? "legacy-unverified" : status;
		models.push({ ...model, metadata: sourceMetadata(model.metadata), status: internalStatus });
		for (const variant of nested) {
			if (
				!variant ||
				typeof variant !== "object" ||
				Array.isArray(variant) ||
				"modelId" in variant
			) {
				throw new Error(`Variant parent must be its containing model in ${filename}`);
			}
			variants.push({
				...variant,
				metadata: sourceMetadata(variant.metadata),
				modelId: model.id,
				status:
					variant.status === "unverified"
						? "legacy-unverified"
						: (variant.status ?? internalStatus),
			});
		}
	}
	if (!models.length || models.length + variants.length > 20_000)
		throw new Error("Invalid catalog model count");
	return validateCatalog({
		schemaVersion: 1,
		catalogVersion: version,
		publishedAt,
		models,
		variants,
	});
}

export async function catalogFromArchive(
	bytes: Uint8Array,
	version: string,
	publishedAt: string,
): Promise<CatalogDocument> {
	if (bytes.length > MAX_CATALOG_BYTES) throw new Error("Catalog exceeds size limit");
	const tar = gunzipSync(bytes, { maxOutputLength: MAX_CATALOG_BYTES });
	const entries = await new Bun.Archive(tar).files();
	const files = new Map<string, string>();
	for (const [path, file] of entries) {
		const match = /^[^/]+\/models\/([a-z0-9][a-z0-9._-]*\.json)$/.exec(path);
		if (!match) continue;
		if (files.has(match[1]!)) throw new Error("Duplicate model file");
		files.set(match[1]!, await file.text());
	}
	return catalogFromModelFiles(files, version, publishedAt);
}

// Refresh this application's offline snapshot from a catalog checkout, without a public SDK/build.
// bun server/lib/model-catalog/source.ts ../narrafork-model-catalog/models
if (import.meta.main) {
	const directory = process.argv[2];
	if (!directory) throw new Error("Usage: source.ts <catalog models directory>");
	const files = new Map(
		readdirSync(directory)
			.filter((name) => name.endsWith(".json"))
			.sort()
			.map((name) => [name, readFileSync(resolve(directory, name), "utf8")]),
	);
	const hash = createHash("sha256");
	for (const [name, text] of files) hash.update(name).update("\0").update(text).update("\0");
	const publishedAt = execFileSync(
		"git",
		["-C", directory, "log", "-1", "--format=%cI", "--", "."],
		{ encoding: "utf8" },
	).trim();
	const catalog = catalogFromModelFiles(files, `bundled-${hash.digest("hex")}`, publishedAt);
	writeFileSync(
		new URL("../../../shared/model-catalog/dist/catalog.json", import.meta.url),
		`${JSON.stringify(catalog, null, 2)}\n`,
	);
	console.log(`${catalog.models.length} models, ${catalog.variants.length} variants`);
}
