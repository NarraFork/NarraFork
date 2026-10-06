import type { MetadataPatch, ModelMetadata } from "@shared/model-catalog";

export type FieldEdit = { mode: "set"; value: string } | { mode: "unknown" } | { mode: "reset" };
export type CatalogEdits = Record<string, FieldEdit>;
export const catalogFields = [
	{ path: "limits.contextWindow", section: "capabilities", kind: "integer" },
	{ path: "limits.maxOutputTokens", section: "capabilities", kind: "integer" },
	{ path: "modalities.input", section: "capabilities", kind: "modalities" },
	{ path: "modalities.output", section: "capabilities", kind: "modalities" },
	{ path: "nativeSearch.supported", section: "capabilities", kind: "boolean" },
	{ path: "reasoning.supported", section: "capabilities", kind: "boolean" },
	{ path: "reasoning.mode", section: "capabilities", kind: "mode" },
	{ path: "reasoning.levels", section: "capabilities", kind: "list" },
	{ path: "reasoning.canDisable", section: "capabilities", kind: "boolean" },
	{ path: "reasoning.defaultLevel", section: "capabilities", kind: "string" },
	...["input", "output", "cacheRead", "cacheWrite"].map((key) => ({
		path: `referencePricing.${key}`,
		section: "prices",
		kind: "price",
	})),
	{ path: "referencePricing.longContext.thresholdTokens", section: "prices", kind: "integer" },
	{ path: "referencePricing.longContext.mode", section: "prices", kind: "longMode" },
	...["input", "output", "cacheRead", "cacheWrite"].map((key) => ({
		path: `referencePricing.longContext.${key}`,
		section: "prices",
		kind: "price",
	})),
] as const;

export function metadataValue(metadata: ModelMetadata, path: string): unknown {
	let value: unknown = metadata;
	for (const key of path.split("."))
		value =
			value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
	return value;
}
export function fieldText(value: unknown): string {
	return value === undefined || value === null
		? ""
		: Array.isArray(value)
			? value.join(", ")
			: String(value);
}

/** Only explicit user operations enter a patch. Rendering effective values is never a write. */
export function buildCatalogPatch(edits: CatalogEdits): MetadataPatch | null {
	const set: Record<string, unknown> = {};
	const reset: string[] = [];
	for (const [path, edit] of Object.entries(edits)) {
		const field = catalogFields.find((candidate) => candidate.path === path);
		if (!field) throw new Error(`Unknown field: ${path}`);
		if (edit.mode === "reset") {
			reset.push(path);
			continue;
		}
		if (edit.mode === "unknown") {
			set[path] = null;
			continue;
		}
		const text = edit.value.trim();
		switch (field.kind) {
			case "integer": {
				const value = Number(text);
				if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value <= 0)
					throw new Error(path);
				set[path] = value;
				break;
			}
			case "price":
				if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(text)) throw new Error(path);
				set[path] = text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
				break;
			case "boolean":
				if (text !== "true" && text !== "false") throw new Error(path);
				set[path] = text === "true";
				break;
			case "list":
			case "modalities": {
				const values = text
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean);
				if (
					field.kind === "modalities" &&
					values.some((v) => !["text", "image", "audio", "video"].includes(v))
				)
					throw new Error(path);
				set[path] = values;
				break;
			}
			case "mode":
				if (!["levels", "fixed", "budget", "unknown"].includes(text)) throw new Error(path);
				set[path] = text;
				break;
			case "longMode":
				if (!["full", "marginal"].includes(text)) throw new Error(path);
				set[path] = text;
				break;
			default:
				set[path] = text;
		}
	}
	if (!Object.keys(set).length && !reset.length) return null;
	return { ...(Object.keys(set).length ? { set } : {}), ...(reset.length ? { reset } : {}) };
}

export function metadataFromPatch(patch: MetadataPatch | null): ModelMetadata {
	const metadata: Record<string, unknown> = {};
	for (const [path, value] of Object.entries(patch?.set ?? {})) {
		const keys = path.split(".");
		let parent = metadata;
		for (const key of keys.slice(0, -1)) {
			parent[key] ??= {};
			parent = parent[key] as Record<string, unknown>;
		}
		parent[keys[keys.length - 1]] = value;
	}
	return metadata as ModelMetadata;
}
