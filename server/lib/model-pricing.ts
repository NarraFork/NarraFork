/** Reference prices only: these amounts never configure or replace NUG billing. */

import type { ReferencePricingSnapshot } from "@shared/agent-protocol/types";
import type { ModelMetadata, ResolvedModelMetadata } from "@shared/model-catalog/schema/catalog";
import { getEffectiveModelMetadata } from "./model-catalog";

export type PriceField = "input" | "output" | "cacheRead" | "cacheWrite";
export type ModelPricing = Record<PriceField, number | null>;
export interface ResolvedModelPricing extends ModelPricing {
	modelKey: string;
	matchedVia: ResolvedModelMetadata["matchedVia"];
	overridden: boolean;
	longContext?: NonNullable<ModelMetadata["referencePricing"]>["longContext"];
	provenance: ResolvedModelMetadata["provenance"];
}

/** Missing and explicit unknown prices remain null; only an explicit decimal zero is free. */
export function referencePriceNumber(value: unknown): number | null {
	if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) return null;
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Clone and freeze the price-only boundary value; null is an explicit captured unknown. */
export function cloneReferencePricingSnapshot(
	snapshot: ReferencePricingSnapshot,
): ReferencePricingSnapshot {
	const copy = structuredClone(snapshot);
	if (copy.referencePricing?.longContext) Object.freeze(copy.referencePricing.longContext);
	if (copy.referencePricing) Object.freeze(copy.referencePricing);
	return Object.freeze(copy);
}

export function captureReferencePricingSnapshot(model: string): ReferencePricingSnapshot {
	const resolved = getEffectiveModelMetadata(model);
	return cloneReferencePricingSnapshot({
		catalogVersion: resolved.catalogVersion,
		localRevision: resolved.localRevision,
		...(resolved.modelId ? { modelId: resolved.modelId } : {}),
		referencePricing: resolved.metadata.referencePricing ?? null,
	});
}

export function pricingFromReferenceSnapshot(
	snapshot: ReferencePricingSnapshot,
): (ModelPricing & Pick<ResolvedModelPricing, "longContext">) | null {
	const prices = snapshot.referencePricing;
	if (!prices) return null;
	return {
		input: referencePriceNumber(prices.input),
		output: referencePriceNumber(prices.output),
		cacheRead: referencePriceNumber(prices.cacheRead),
		cacheWrite: referencePriceNumber(prices.cacheWrite),
		longContext: prices.longContext,
	};
}

/** Identity, variants, user overrides and tombstones are resolved in exactly one place. */
export function resolveModelPricing(model?: string): ResolvedModelPricing | null {
	if (!model?.trim()) return null;
	const resolved = getEffectiveModelMetadata(model);
	const prices = resolved.metadata.referencePricing;
	if (!prices) return null;
	return {
		modelKey: resolved.modelId ?? model,
		matchedVia: resolved.matchedVia,
		overridden: Object.entries(resolved.provenance).some(
			([field, source]) =>
				field.startsWith("referencePricing.") && source.layer.startsWith("local-"),
		),
		input: referencePriceNumber(prices.input),
		output: referencePriceNumber(prices.output),
		cacheRead: referencePriceNumber(prices.cacheRead),
		cacheWrite: referencePriceNumber(prices.cacheWrite),
		longContext: prices.longContext,
		provenance: resolved.provenance,
	};
}
