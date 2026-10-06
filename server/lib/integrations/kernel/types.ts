import { capabilityIdSchema } from "@shared/integrations/capabilities";
import {
	type CredentialRef,
	credentialRefSchema,
	type PrincipalRef,
	principalRefSchema,
} from "@shared/integrations/principals";
import {
	type ResourceRef,
	type ResourceRelationResolver,
	type ResourceScope,
	resourceRefSchema,
	resourceScopeKey,
	resourceScopeSchema,
} from "@shared/integrations/resources";
import { z } from "zod";
import {
	type AuthorizationConstraintKey,
	type AuthorizationConstraints,
	authorizationConstraintsSchema,
} from "./limits";

export const BOUND_SCOPES_MAX_ITEMS = 16;
export const AUTHORIZATION_GRANTS_MAX_ITEMS = 2_048;

const kernelIdSchema = z
	.string()
	.min(1)
	.max(128)
	.refine((value) => value === value.trim(), "Kernel id cannot contain surrounding whitespace");
const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const epochMillisecondsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const authorityRefSchema = z
	.object({
		id: kernelIdSchema,
		revision: revisionSchema,
	})
	.strict();
export type AuthorityRef = z.infer<typeof authorityRefSchema>;

export const RUNTIME_TYPES = ["server", "plugin", "device", "worker"] as const;
export const runtimeRefSchema = z
	.object({
		type: z.enum(RUNTIME_TYPES),
		id: kernelIdSchema,
		generation: revisionSchema,
	})
	.strict();
export type RuntimeRef = z.infer<typeof runtimeRefSchema>;

const boundScopesSchema = z
	.array(resourceScopeSchema)
	.min(1)
	.max(BOUND_SCOPES_MAX_ITEMS)
	.refine(
		(scopes) => new Set(scopes.map((scope) => resourceScopeKey(scope))).size === scopes.length,
		"Bound scopes must be unique",
	);

/** Untrusted wire context. Authority and runtime are attached only by trusted server code. */
export const wireExecutionContextSchema = z
	.object({
		subject: principalRefSchema,
		credential: credentialRefSchema,
		boundScopes: boundScopesSchema,
	})
	.strict();
export interface WireExecutionContext {
	subject: PrincipalRef;
	credential: CredentialRef;
	boundScopes: ResourceScope[];
}

export const executionContextSchema = wireExecutionContextSchema
	.extend({
		authority: authorityRefSchema,
		runtime: runtimeRefSchema,
	})
	.strict();
export interface ExecutionContext extends WireExecutionContext {
	authority: AuthorityRef;
	runtime: RuntimeRef;
}

export function bindExecutionContext(
	wire: WireExecutionContext,
	authority: AuthorityRef,
	runtime: RuntimeRef,
): ExecutionContext {
	return executionContextSchema.parse({
		...wireExecutionContextSchema.parse(wire),
		authority: authorityRefSchema.parse(authority),
		runtime: runtimeRefSchema.parse(runtime),
	});
}

export const AUTHORITY_STATES = ["active", "suspended", "revoked", "expired"] as const;
export type AuthorityState = (typeof AUTHORITY_STATES)[number];
export const authoritySnapshotSchema = z
	.object({
		id: kernelIdSchema,
		revision: revisionSchema,
		state: z.enum(AUTHORITY_STATES),
		subject: principalRefSchema,
		credential: credentialRefSchema,
	})
	.strict();
export interface AuthoritySnapshot {
	id: string;
	revision: number;
	state: AuthorityState;
	subject: PrincipalRef;
	credential: CredentialRef;
}

export const authorizationGrantSchema = z
	.object({
		id: kernelIdSchema,
		authorityId: kernelIdSchema,
		authorityRevision: revisionSchema,
		capability: capabilityIdSchema,
		scope: resourceScopeSchema,
		constraints: authorizationConstraintsSchema.optional(),
	})
	.strict();
export interface AuthorizationGrant {
	id: string;
	authorityId: string;
	authorityRevision: number;
	capability: string;
	scope: ResourceScope;
	constraints?: AuthorizationConstraints;
}

export const authorizationGrantListSchema = z
	.array(authorizationGrantSchema)
	.max(AUTHORIZATION_GRANTS_MAX_ITEMS)
	.refine((grants) => new Set(grants.map((grant) => grant.id)).size === grants.length, {
		message: "Authorization grant ids must be unique",
	});

export const operationRequirementSchema = z
	.object({
		operation: z
			.string()
			.min(1)
			.max(128)
			.regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
		capability: capabilityIdSchema,
		scope: resourceScopeSchema,
		resource: resourceRefSchema,
		constraints: authorizationConstraintsSchema.optional(),
		deadlineAt: epochMillisecondsSchema,
	})
	.strict();
export interface OperationRequirement {
	operation: string;
	capability: string;
	scope: ResourceScope;
	resource: ResourceRef;
	constraints?: AuthorizationConstraints;
	deadlineAt: number;
}

export const authorizationEvaluationDataSchema = z
	.object({
		context: executionContextSchema,
		authority: authoritySnapshotSchema,
		grants: authorizationGrantListSchema,
		requirement: operationRequirementSchema,
		now: epochMillisecondsSchema,
	})
	.strict();
export interface AuthorizationEvaluationInput {
	context: ExecutionContext;
	authority: AuthoritySnapshot;
	grants: AuthorizationGrant[];
	requirement: OperationRequirement;
	now: number;
	relationResolver?: ResourceRelationResolver;
}

export const AUTHORIZATION_STAGES = [
	"deadline",
	"state",
	"revision",
	"capability",
	"scope",
	"resource",
	"constraints",
] as const;
export type AuthorizationStage = (typeof AUTHORIZATION_STAGES)[number];

export const AUTHORIZATION_DENIAL_CODES = [
	"deadline_exceeded",
	"authority_inactive",
	"authority_revision_mismatch",
	"authority_subject_mismatch",
	"authority_credential_mismatch",
	"grant_revision_mismatch",
	"unknown_capability",
	"subject_not_allowed",
	"capability_not_granted",
	"scope_not_bound",
	"scope_not_granted",
	"scope_relation_unknown",
	"resource_type_mismatch",
	"resource_not_in_scope",
	"resource_relation_unknown",
	"constraints_not_satisfied",
] as const;
export type AuthorizationDenialCode = (typeof AUTHORIZATION_DENIAL_CODES)[number];

export type AuthorizationDecision =
	| {
			allowed: true;
			grantId: string;
	  }
	| {
			allowed: false;
			stage: AuthorizationStage;
			code: AuthorizationDenialCode;
			failedConstraint?: AuthorizationConstraintKey;
	  };
