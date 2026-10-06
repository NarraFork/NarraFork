import type { CanonicalCapabilityId } from "@shared/integrations/capabilities";
import type { CredentialRef, PrincipalRef } from "@shared/integrations/principals";
import {
	type ResourceRef,
	type ResourceRelationResolver,
	type ResourceScope,
	resourceScopeKey,
	resourceScopeSchema,
} from "@shared/integrations/resources";
import { AppError } from "../lib/errors";
import {
	type AuthorizationConstraints,
	type AuthorizationDecision,
	AuthorizationDecisionCache,
	type AuthorizationGrant,
	authorizationConstraintsSchema,
	bindExecutionContext,
	evaluateAuthorization,
	type RuntimeRef,
} from "../lib/integrations/kernel";
import { integrationAuditService } from "./integration-audit-service";
import { setIntegrationAuthorityInvalidationListener } from "./integration-authority-invalidation";
import {
	type IntegrationAuthoritySnapshot,
	integrationAuthorityService,
} from "./integration-authority-service";

export const INTEGRATION_AUTHORIZATION_DEADLINE_MS = 5_000;

export interface IntegrationAuthorizationRequest {
	authorityId: string;
	authorityRevision: number;
	operation: string;
	capability: CanonicalCapabilityId;
	scope: ResourceScope;
	resource: ResourceRef;
	boundScopes: ResourceScope[];
	runtime: RuntimeRef;
	permittedCapabilities?: readonly CanonicalCapabilityId[];
	constraints?: AuthorizationConstraints;
	deadlineAt?: number;
	resourceProjectId?: string | null;
	transport?: string;
	requestBytes?: number;
	/** Trusted proof that this exact requested scope contains the synthetic operation resource. */
	resourceContainerScope?: ResourceScope;
}

export interface IntegrationAuthorizationResult {
	decision: AuthorizationDecision;
	cacheHit: boolean;
	authorityRevision: number;
}

export class IntegrationAuthorizationError extends AppError {
	readonly decision: Exclude<AuthorizationDecision, { allowed: true }>;

	constructor(decision: Exclude<AuthorizationDecision, { allowed: true }>) {
		super("Integration operation was not authorized", 403, "INTEGRATION_AUTHORIZATION_DENIED");
		this.name = "IntegrationAuthorizationError";
		this.decision = decision;
	}
}

function authorityIdentity(snapshot: IntegrationAuthoritySnapshot): {
	subject: PrincipalRef;
	credential: CredentialRef;
} {
	const authority = snapshot.authority;
	switch (authority.kind) {
		case "oauth_grant":
			return {
				subject: { type: "oauth_client", id: authority.integrationId },
				credential: { type: "oauth_token", id: authority.id },
			};
		case "plugin_installation":
			return {
				subject: { type: "plugin_installation", id: authority.id },
				credential: { type: "plugin_credential", id: authority.id },
			};
	}
}

function grantScope(scopeType: string, scopeId: string | null): ResourceScope {
	return resourceScopeSchema.parse(
		scopeType === "global" ? { type: "global" } : { type: scopeType, id: scopeId },
	);
}

function normalizeGrantConstraints(value: Record<string, unknown> | null) {
	if (!value) return undefined;
	return authorizationConstraintsSchema.parse(value);
}

function authorizationGrants(
	snapshot: IntegrationAuthoritySnapshot,
	permittedCapabilities?: readonly CanonicalCapabilityId[],
): AuthorizationGrant[] {
	const permitted = permittedCapabilities ? new Set<string>(permittedCapabilities) : null;
	return snapshot.grants
		.filter((grant) => !permitted || permitted.has(grant.capabilityId as CanonicalCapabilityId))
		.map((grant) => ({
			id: grant.id,
			authorityId: snapshot.authority.id,
			authorityRevision: snapshot.authority.revision,
			capability: grant.capabilityId as CanonicalCapabilityId,
			scope: grantScope(grant.scopeType, grant.scopeId),
			constraints: normalizeGrantConstraints(grant.constraintsJson),
		}));
}

function relationResolver(
	request: Pick<
		IntegrationAuthorizationRequest,
		"resource" | "resourceProjectId" | "resourceContainerScope"
	>,
): ResourceRelationResolver | undefined {
	if (request.resourceProjectId === undefined && request.resourceContainerScope === undefined) {
		return undefined;
	}
	return {
		resolve(container, candidate) {
			if (candidate.type !== request.resource.type || candidate.id !== request.resource.id) {
				return "unknown";
			}
			if (
				request.resourceContainerScope?.type !== "global" &&
				request.resourceContainerScope &&
				resourceScopeKey(container) === resourceScopeKey(request.resourceContainerScope)
			) {
				return "contains";
			}
			if (container.type !== "project" || request.resourceProjectId === undefined) {
				return "unknown";
			}
			if (request.resourceProjectId === null) return "not_contains";
			return container.id === request.resourceProjectId ? "contains" : "not_contains";
		},
	};
}

function authorityState(snapshot: IntegrationAuthoritySnapshot, now: number) {
	if (
		snapshot.authority.state === "active" &&
		snapshot.authority.expiresAt !== null &&
		Date.parse(snapshot.authority.expiresAt) <= now
	) {
		return "expired" as const;
	}
	return snapshot.authority.state;
}

export class IntegrationAuthorizationService {
	readonly #cache = new AuthorizationDecisionCache({ maxEntries: 4_096, ttlMs: 30_000 });

	async authorize(
		request: IntegrationAuthorizationRequest,
	): Promise<IntegrationAuthorizationResult> {
		const now = Date.now();
		const snapshot = await integrationAuthorityService.getSnapshot(request.authorityId);
		if (!snapshot) {
			const decision = {
				allowed: false as const,
				stage: "state" as const,
				code: "authority_inactive" as const,
			};
			await integrationAuditService.record({
				principal: { type: "system" },
				authorityId: request.authorityId,
				transport: request.transport ?? "server",
				operationId: request.operation,
				capabilityId: request.capability,
				resource: request.resource,
				scope: request.scope,
				outcome: "denied",
				reasonCode: decision.code,
				requestBytes: request.requestBytes,
			});
			return {
				decision,
				cacheHit: false,
				authorityRevision: request.authorityRevision,
			};
		}
		const identity = authorityIdentity(snapshot);
		const context = bindExecutionContext(
			{
				subject: identity.subject,
				credential: identity.credential,
				boundScopes: request.boundScopes,
			},
			{ id: snapshot.authority.id, revision: request.authorityRevision },
			request.runtime,
		);
		const requirement = {
			operation: request.operation,
			capability: request.capability,
			scope: request.scope,
			resource: request.resource,
			constraints: request.constraints,
			deadlineAt: request.deadlineAt ?? now + INTEGRATION_AUTHORIZATION_DEADLINE_MS,
		};
		if (
			snapshot.authority.revision === request.authorityRevision &&
			authorityState(snapshot, now) === "active"
		) {
			const cached = this.#cache.get({ context, requirement });
			if (cached) {
				return {
					decision: cached,
					cacheHit: true,
					authorityRevision: snapshot.authority.revision,
				};
			}
		}
		const decision = evaluateAuthorization({
			context,
			authority: {
				id: snapshot.authority.id,
				revision: snapshot.authority.revision,
				state: authorityState(snapshot, now),
				subject: identity.subject,
				credential: identity.credential,
			},
			grants: authorizationGrants(snapshot, request.permittedCapabilities),
			requirement,
			now,
			relationResolver: relationResolver(request),
		});
		if (!decision.allowed || request.operation !== "event.deliver") {
			await integrationAuditService.record({
				principal: identity.subject,
				credential: identity.credential,
				authorityId: snapshot.authority.id,
				transport: request.transport ?? "server",
				operationId: request.operation,
				capabilityId: request.capability,
				resource: request.resource,
				scope: request.scope,
				outcome: decision.allowed ? "allowed" : "denied",
				reasonCode: decision.allowed ? null : decision.code,
				requestBytes: request.requestBytes,
				metadata: { authorityRevision: snapshot.authority.revision },
			});
		}
		if (decision.allowed) this.#cache.set({ context, requirement }, decision);
		return {
			decision,
			cacheHit: false,
			authorityRevision: snapshot.authority.revision,
		};
	}

	async require(request: IntegrationAuthorizationRequest): Promise<IntegrationAuthorizationResult> {
		const result = await this.authorize(request);
		if (!result.decision.allowed) throw new IntegrationAuthorizationError(result.decision);
		return result;
	}

	invalidateAuthority(authorityId: string): number {
		return this.#cache.invalidateAuthority(authorityId);
	}

	invalidateRuntime(runtime: Pick<RuntimeRef, "type" | "id">): number {
		return this.#cache.invalidateRuntime(runtime);
	}

	clear(): void {
		this.#cache.clear();
	}
}

export const integrationAuthorizationService = new IntegrationAuthorizationService();

setIntegrationAuthorityInvalidationListener("authorization-cache", (event) => {
	integrationAuthorizationService.invalidateAuthority(event.authorityId);
});
