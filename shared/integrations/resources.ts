import { z } from "zod";
import {
	CAPABILITY_RESOURCE_TYPES,
	type CapabilityResourceType,
	capabilityResourceTypeSchema,
} from "./capabilities";

export const RESOURCE_ID_MAX_LENGTH = 128;

export const resourceIdSchema = z
	.string()
	.min(1)
	.max(RESOURCE_ID_MAX_LENGTH)
	.refine((value) => value === value.trim(), "Resource id cannot contain surrounding whitespace")
	.refine(
		(value) =>
			[...value].every((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return codePoint >= 0x20 && codePoint !== 0x7f;
			}),
		"Resource id cannot contain control characters",
	);

export const resourceRefSchema = z
	.object({
		type: capabilityResourceTypeSchema,
		id: resourceIdSchema,
	})
	.strict();
export type ResourceRef = z.infer<typeof resourceRefSchema>;

export const globalResourceScopeSchema = z.object({ type: z.literal("global") }).strict();
export const resourceScopeSchema = z.union([globalResourceScopeSchema, resourceRefSchema]);
export type ResourceScope = z.infer<typeof resourceScopeSchema>;

export const RESOURCE_RELATION_RESULTS = ["contains", "not_contains", "unknown"] as const;
export type ResourceRelationResult = (typeof RESOURCE_RELATION_RESULTS)[number];
export const resourceRelationResultSchema = z.enum(RESOURCE_RELATION_RESULTS);

/**
 * Resolves trusted cross-type containment from `container` to `candidate`.
 * Implementations must return `unknown` when they cannot prove either outcome.
 */
export interface ResourceRelationResolver {
	resolve(container: ResourceRef, candidate: ResourceRef): ResourceRelationResult;
}

export function resourceRefKey(resource: ResourceRef): string {
	const parsed = resourceRefSchema.parse(resource);
	return `${parsed.type}:${parsed.id}`;
}

export function resourceScopeKey(scope: ResourceScope): string {
	const parsed = resourceScopeSchema.parse(scope);
	return parsed.type === "global" ? "global" : resourceRefKey(parsed);
}

export function resolveResourceContainment(
	container: ResourceScope,
	candidate: ResourceScope,
	resolver?: ResourceRelationResolver,
): ResourceRelationResult {
	const parsedContainer = resourceScopeSchema.parse(container);
	const parsedCandidate = resourceScopeSchema.parse(candidate);
	if (parsedContainer.type === "global") return "contains";
	if (parsedCandidate.type === "global") return "not_contains";
	if (parsedContainer.type === parsedCandidate.type) {
		return parsedContainer.id === parsedCandidate.id ? "contains" : "not_contains";
	}
	return resolver?.resolve(parsedContainer, parsedCandidate) ?? "unknown";
}

export function resourceTypeIsCanonical(value: string): value is CapabilityResourceType {
	return (CAPABILITY_RESOURCE_TYPES as readonly string[]).includes(value);
}
