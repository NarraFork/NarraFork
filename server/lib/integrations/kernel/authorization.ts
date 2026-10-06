import { credentialRefKey, principalRefKey } from "@shared/integrations/principals";
import type { ResourceRelationResult } from "@shared/integrations/resources";
import { type CapabilityCatalog, canonicalCapabilityCatalog } from "./catalog";
import { constraintsAllow } from "./limits";
import { matchAnyScope, matchAnyScopeToResource, scopeContainsResource } from "./scope";
import {
	type AuthorizationDecision,
	type AuthorizationDenialCode,
	type AuthorizationEvaluationInput,
	type AuthorizationGrant,
	type AuthorizationStage,
	authorizationEvaluationDataSchema,
} from "./types";

function deny(stage: AuthorizationStage, code: AuthorizationDenialCode): AuthorizationDecision {
	return { allowed: false, stage, code };
}

function relationDenial(
	stage: "scope" | "resource",
	result: Exclude<ResourceRelationResult, "contains">,
	closedCode: AuthorizationDenialCode,
): AuthorizationDecision {
	if (result === "unknown") {
		return deny(stage, stage === "scope" ? "scope_relation_unknown" : "resource_relation_unknown");
	}
	return deny(stage, closedCode);
}

function grantsContainingScope(
	grants: readonly AuthorizationGrant[],
	input: AuthorizationEvaluationInput,
): { grants: AuthorizationGrant[]; sawUnknown: boolean } {
	const matching: AuthorizationGrant[] = [];
	let sawUnknown = false;
	for (const grant of grants) {
		const result = matchAnyScope(
			[grant.scope],
			input.requirement.scope,
			input.relationResolver,
		).result;
		if (result === "contains") matching.push(grant);
		if (result === "unknown") sawUnknown = true;
	}
	return { grants: matching, sawUnknown };
}

function grantsContainingResource(
	grants: readonly AuthorizationGrant[],
	input: AuthorizationEvaluationInput,
): { grants: AuthorizationGrant[]; sawUnknown: boolean } {
	const matching: AuthorizationGrant[] = [];
	let sawUnknown = false;
	for (const grant of grants) {
		const result = matchAnyScopeToResource(
			[grant.scope],
			input.requirement.resource,
			input.relationResolver,
		).result;
		if (result === "contains") matching.push(grant);
		if (result === "unknown") sawUnknown = true;
	}
	return { grants: matching, sawUnknown };
}

/** Deterministic, side-effect-free authorization over caller-provided in-memory snapshots. */
export class AuthorizationEvaluator {
	constructor(private readonly catalog: CapabilityCatalog = canonicalCapabilityCatalog) {}

	evaluate(input: AuthorizationEvaluationInput): AuthorizationDecision {
		const parsed = authorizationEvaluationDataSchema.parse({
			context: input.context,
			authority: input.authority,
			grants: input.grants,
			requirement: input.requirement,
			now: input.now,
		});
		const evaluation: AuthorizationEvaluationInput = {
			...parsed,
			relationResolver: input.relationResolver,
		};

		// 1. deadline
		if (evaluation.now > evaluation.requirement.deadlineAt) {
			return deny("deadline", "deadline_exceeded");
		}

		// 2. state
		if (evaluation.authority.state !== "active") {
			return deny("state", "authority_inactive");
		}

		// 3. revision and snapshot binding
		if (
			evaluation.context.authority.id !== evaluation.authority.id ||
			evaluation.context.authority.revision !== evaluation.authority.revision
		) {
			return deny("revision", "authority_revision_mismatch");
		}
		if (
			principalRefKey(evaluation.context.subject) !== principalRefKey(evaluation.authority.subject)
		) {
			return deny("revision", "authority_subject_mismatch");
		}
		if (
			credentialRefKey(evaluation.context.credential) !==
			credentialRefKey(evaluation.authority.credential)
		) {
			return deny("revision", "authority_credential_mismatch");
		}
		if (
			evaluation.grants.some(
				(grant) =>
					grant.authorityId !== evaluation.authority.id ||
					grant.authorityRevision !== evaluation.authority.revision,
			)
		) {
			return deny("revision", "grant_revision_mismatch");
		}

		// 4. capability
		const descriptor = this.catalog.get(evaluation.requirement.capability);
		if (!descriptor) return deny("capability", "unknown_capability");
		if (!descriptor.allowedSubjects.includes(evaluation.context.subject.type)) {
			return deny("capability", "subject_not_allowed");
		}
		const capabilityGrants = evaluation.grants.filter(
			(grant) => grant.capability === evaluation.requirement.capability,
		);
		if (capabilityGrants.length === 0) {
			return deny("capability", "capability_not_granted");
		}

		// 5. requested scope
		const boundScopeMatch = matchAnyScope(
			evaluation.context.boundScopes,
			evaluation.requirement.scope,
			evaluation.relationResolver,
		);
		if (boundScopeMatch.result !== "contains") {
			return relationDenial("scope", boundScopeMatch.result, "scope_not_bound");
		}
		const scopeGrants = grantsContainingScope(capabilityGrants, evaluation);
		if (scopeGrants.grants.length === 0) {
			return scopeGrants.sawUnknown
				? deny("scope", "scope_relation_unknown")
				: deny("scope", "scope_not_granted");
		}

		// 6. exact resource
		if (descriptor.resourceType !== evaluation.requirement.resource.type) {
			return deny("resource", "resource_type_mismatch");
		}
		const requestedScopeRelation = scopeContainsResource(
			evaluation.requirement.scope,
			evaluation.requirement.resource,
			evaluation.relationResolver,
		);
		if (requestedScopeRelation !== "contains") {
			return relationDenial("resource", requestedScopeRelation, "resource_not_in_scope");
		}
		const boundResourceMatch = matchAnyScopeToResource(
			evaluation.context.boundScopes,
			evaluation.requirement.resource,
			evaluation.relationResolver,
		);
		if (boundResourceMatch.result !== "contains") {
			return relationDenial("resource", boundResourceMatch.result, "resource_not_in_scope");
		}
		const resourceGrants = grantsContainingResource(scopeGrants.grants, evaluation);
		if (resourceGrants.grants.length === 0) {
			return resourceGrants.sawUnknown
				? deny("resource", "resource_relation_unknown")
				: deny("resource", "resource_not_in_scope");
		}

		// 7. constraints
		let failedConstraint: ReturnType<typeof constraintsAllow>["failedConstraint"];
		for (const grant of resourceGrants.grants) {
			const result = constraintsAllow(grant.constraints, evaluation.requirement.constraints);
			if (result.allowed) return { allowed: true, grantId: grant.id };
			failedConstraint ??= result.failedConstraint;
		}
		return {
			allowed: false,
			stage: "constraints",
			code: "constraints_not_satisfied",
			...(failedConstraint ? { failedConstraint } : {}),
		};
	}
}

const defaultAuthorizationEvaluator = new AuthorizationEvaluator();

export function evaluateAuthorization(input: AuthorizationEvaluationInput): AuthorizationDecision {
	return defaultAuthorizationEvaluator.evaluate(input);
}
