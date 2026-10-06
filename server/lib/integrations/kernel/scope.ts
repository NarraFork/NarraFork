import {
	type ResourceRef,
	type ResourceRelationResolver,
	type ResourceRelationResult,
	type ResourceScope,
	resolveResourceContainment,
} from "@shared/integrations/resources";

export interface ScopeMatchResult {
	result: ResourceRelationResult;
	matchedScope?: ResourceScope;
}

export function scopeContainsScope(
	container: ResourceScope,
	candidate: ResourceScope,
	resolver?: ResourceRelationResolver,
): ResourceRelationResult {
	return resolveResourceContainment(container, candidate, resolver);
}

export function scopeContainsResource(
	container: ResourceScope,
	resource: ResourceRef,
	resolver?: ResourceRelationResolver,
): ResourceRelationResult {
	return resolveResourceContainment(container, resource, resolver);
}

/** Returns unknown only when no scope proves containment and at least one relation is unknown. */
export function matchAnyScope(
	containers: readonly ResourceScope[],
	candidate: ResourceScope,
	resolver?: ResourceRelationResolver,
): ScopeMatchResult {
	let sawUnknown = false;
	for (const container of containers) {
		const result = scopeContainsScope(container, candidate, resolver);
		if (result === "contains") return { result, matchedScope: container };
		if (result === "unknown") sawUnknown = true;
	}
	return { result: sawUnknown ? "unknown" : "not_contains" };
}

export function matchAnyScopeToResource(
	containers: readonly ResourceScope[],
	resource: ResourceRef,
	resolver?: ResourceRelationResolver,
): ScopeMatchResult {
	let sawUnknown = false;
	for (const container of containers) {
		const result = scopeContainsResource(container, resource, resolver);
		if (result === "contains") return { result, matchedScope: container };
		if (result === "unknown") sawUnknown = true;
	}
	return { result: sawUnknown ? "unknown" : "not_contains" };
}
