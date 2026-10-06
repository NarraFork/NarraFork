import {
	CAPABILITY_RESOURCE_TYPES,
	type CapabilityResourceType,
	capabilityResourceTypeSchema,
} from "@shared/integrations/capabilities";
import { z } from "zod";
import { type PrincipalRef, principalRefSchema } from "./principals";

export type { PrincipalRef } from "./principals";
export { principalRefSchema } from "./principals";

export const resourceIdSchema = z
	.string()
	.min(1)
	.max(128)
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

const globalResourceScopeSchema = z.object({ type: z.literal("global") }).strict();

/**
 * `global` never carries an id. Every non-global scope is an exact resource reference
 * and therefore always carries both a canonical resource type and a non-empty id.
 */
export const resourceScopeSchema = z.discriminatedUnion("type", [
	globalResourceScopeSchema,
	resourceRefSchema,
]);
export type ResourceScope = z.infer<typeof resourceScopeSchema>;

/**
 * The sole canonical resource-type to bound-context field mapping. Adapters should import
 * this map instead of maintaining parallel switch statements. `providerInstanceId` keeps
 * compatibility with the existing plugin invocation-scope field.
 */
export const RESOURCE_SCOPE_FIELD_BY_TYPE = {
	user: "userId",
	session: "sessionId",
	integration: "integrationId",
	project: "projectId",
	workspace: "workspaceId",
	chapter: "chapterId",
	narrator: "narratorId",
	message: "messageId",
	review: "reviewId",
	routine: "routineId",
	provider: "providerInstanceId",
	device: "deviceId",
	permission: "permissionId",
	audit: "auditId",
	settings: "settingsId",
	event: "eventId",
	config: "configId",
	secret: "secretId",
	storage: "storageId",
	ui: "uiId",
	network: "networkId",
	filesystem: "filesystemId",
	process: "processId",
	schedule: "scheduleId",
	diagnostics: "diagnosticsId",
} as const satisfies Record<CapabilityResourceType, string>;

export type ResourceScopeField =
	(typeof RESOURCE_SCOPE_FIELD_BY_TYPE)[keyof typeof RESOURCE_SCOPE_FIELD_BY_TYPE];

function buildReverseScopeFieldMap(): Readonly<Record<ResourceScopeField, CapabilityResourceType>> {
	const reverse: Partial<Record<ResourceScopeField, CapabilityResourceType>> = {};
	for (const type of CAPABILITY_RESOURCE_TYPES) {
		const field = RESOURCE_SCOPE_FIELD_BY_TYPE[type];
		if (reverse[field] !== undefined) {
			throw new Error(`Duplicate resource scope field mapping: ${field}`);
		}
		reverse[field] = type;
	}
	return Object.freeze(reverse as Record<ResourceScopeField, CapabilityResourceType>);
}

export const RESOURCE_TYPE_BY_SCOPE_FIELD = buildReverseScopeFieldMap();

export class ResourceScopeBindingError extends Error {
	readonly code = "RESOURCE_SCOPE_NOT_BOUND";

	constructor(
		readonly boundScope: ResourceScope,
		readonly requestedScope: ResourceScope,
	) {
		super("Requested resource scope is not contained by the bound scope");
		this.name = "ResourceScopeBindingError";
	}
}

export function assertResourceRef(value: unknown): ResourceRef {
	return resourceRefSchema.parse(value);
}

export function assertResourceScope(value: unknown): ResourceScope {
	return resourceScopeSchema.parse(value);
}

export function resourceToScope(resource: unknown): ResourceScope {
	return assertResourceRef(resource);
}

/**
 * Fail-closed containment: global contains every valid scope; otherwise containment
 * requires the exact same resource type and id. Cross-type ancestry (for example a
 * chapter belonging to a project) must be resolved by a trusted service before calling.
 */
export function scopeContains(container: unknown, candidate: unknown): boolean {
	const parsedContainer = assertResourceScope(container);
	const parsedCandidate = assertResourceScope(candidate);
	if (parsedContainer.type === "global") return true;
	if (parsedCandidate.type === "global") return false;
	return parsedContainer.type === parsedCandidate.type && parsedContainer.id === parsedCandidate.id;
}

/** Global intersects every valid scope; identified scopes intersect only on exact identity. */
export function scopeIntersects(left: unknown, right: unknown): boolean {
	const parsedLeft = assertResourceScope(left);
	const parsedRight = assertResourceScope(right);
	if (parsedLeft.type === "global" || parsedRight.type === "global") return true;
	return parsedLeft.type === parsedRight.type && parsedLeft.id === parsedRight.id;
}

/**
 * Validate and return a requested scope only when it is contained by the trusted bound scope.
 * Parameter order is intentionally `(boundScope, requestedScope)`.
 */
export function assertBoundScope(boundScope: unknown, requestedScope: unknown): ResourceScope {
	const parsedBoundScope = assertResourceScope(boundScope);
	const parsedRequestedScope = assertResourceScope(requestedScope);
	if (!scopeContains(parsedBoundScope, parsedRequestedScope)) {
		throw new ResourceScopeBindingError(parsedBoundScope, parsedRequestedScope);
	}
	return parsedRequestedScope;
}

export function scopeToFieldBinding(scope: unknown): Partial<Record<ResourceScopeField, string>> {
	const parsed = assertResourceScope(scope);
	if (parsed.type === "global") return {};
	return { [RESOURCE_SCOPE_FIELD_BY_TYPE[parsed.type]]: parsed.id };
}

export function fieldBindingToScope(field: ResourceScopeField, id: unknown): ResourceScope {
	return resourceScopeSchema.parse({
		type: RESOURCE_TYPE_BY_SCOPE_FIELD[field],
		id,
	});
}

/** Type-only assertion that the principal schema remains available at this boundary. */
export function assertScopedPrincipal(value: unknown): PrincipalRef {
	return principalRefSchema.parse(value);
}
