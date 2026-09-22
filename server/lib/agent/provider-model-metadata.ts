import type { ModelMetadata } from "@shared/model-catalog/schema/catalog";
import {
	clampReasoningEffort,
	REASONING_EFFORT_VALUES,
	type ReasoningEffort,
} from "@shared/reasoning-effort";
import { getEffectiveModelMetadata } from "../model-catalog";

export function effectiveProviderMetadata(model: string): ModelMetadata {
	return getEffectiveModelMetadata(model).metadata;
}

/** Explicit requests replace defaults, but never exceed a declared model ceiling. */
export function resolveOutputTokenLimit(
	metadata: ModelMetadata,
	requested?: number,
	fallback?: number,
): number | undefined {
	const positive = (value: number | null | undefined) =>
		typeof value === "number" && Number.isFinite(value) && value > 0
			? Math.max(1, Math.floor(value))
			: undefined;
	const limit = positive(metadata.limits?.maxOutputTokens);
	const desired = positive(requested) ?? positive(fallback);
	return desired === undefined ? limit : limit === undefined ? desired : Math.min(desired, limit);
}

/** Metadata validates semantic levels; adapters retain ownership of the wire mapping. */
export function resolveMetadataReasoning(
	metadata: ModelMetadata,
	requested?: string,
): string | undefined {
	const reasoning = metadata.reasoning;
	if (reasoning?.supported === false) return undefined;
	let effort = requested ?? reasoning?.defaultLevel ?? undefined;
	if (!effort) return undefined;
	if (effort === "none" && reasoning?.canDisable !== false) return "none";
	if (reasoning?.mode === "fixed") return undefined;
	const levels = reasoning?.levels?.filter((level) => level !== "none");
	if (effort === "none")
		effort =
			reasoning?.defaultLevel && reasoning.defaultLevel !== "none"
				? reasoning.defaultLevel
				: levels?.[0];
	if (!effort) return undefined;
	if (levels?.length && !levels.includes(effort)) {
		const known = levels.filter((level): level is ReasoningEffort =>
			REASONING_EFFORT_VALUES.includes(level as ReasoningEffort),
		);
		if (known.length && REASONING_EFFORT_VALUES.includes(effort as ReasoningEffort))
			return clampReasoningEffort(effort as ReasoningEffort, known);
		return reasoning?.defaultLevel && levels.includes(reasoning.defaultLevel)
			? reasoning.defaultLevel
			: levels[0];
	}
	return effort;
}

/** Validate only actual image inputs, never image-generation outputs or tool schemas. */
export function assertModelInputModalities(
	model: string,
	values: unknown,
	metadata = effectiveProviderMetadata(model),
): void {
	const inputs = metadata.modalities?.input;
	if (!Array.isArray(inputs)) return;
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const part of value) visit(part);
			return;
		}
		const item = value as Record<string, unknown>;
		const inline = (item.inlineData ?? item.inline_data) as
			| { mimeType?: string; mime_type?: string }
			| undefined;
		const mime = inline?.mimeType ?? inline?.mime_type;
		const modality = mime?.startsWith("audio/")
			? "audio"
			: mime?.startsWith("video/")
				? "video"
				: mime?.startsWith("image/") ||
						["image", "image_url", "input_image"].includes(String(item.type))
					? "image"
					: undefined;
		if (modality && !inputs.includes(modality))
			throw new Error(
				`Model ${model} does not support ${modality} input according to its effective metadata.`,
			);
		for (const key of ["content", "parts", "messages", "input", "contents", "result"])
			visit(item[key]);
	};
	visit(values);
}
