/**
 * Central resource authorization for the external OAuth API.
 *
 * Access tokens authenticate a user/client pair, but external resources are
 * owned by a durable grant and constrained to that grant's finite project
 * allow-list. This module is the single fail-closed boundary for resolving the
 * live grant/client context and for hiding unauthorized resource existence.
 */
import type { CanonicalCapabilityId } from "@shared/integrations/capabilities";
import type { ResourceRef } from "@shared/integrations/resources";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db";
import { narrators, oauthClients, oauthGrants, remoteDevices } from "../db/schema";
import { AppError, NotFoundError } from "../lib/errors";
import type { AuthorizationConstraints } from "../lib/integrations/kernel";
import {
	intersectOAuthClientPolicies,
	normalizeOAuthClientPolicy,
	type OAuthClientPolicy,
} from "../lib/oauth-client-policy";
import { getAuthPrincipal, type OAuthAuthPrincipal } from "../middleware/auth";
import { integrationAuthorityService } from "./integration-authority-service";
import { integrationAuthorizationService } from "./integration-authorization-service";
import { integrationResourceBindingService } from "./integration-resource-binding-service";

/** Frozen consent contract: grants may authorize at most this many projects. */
export const EXTERNAL_OAUTH_MAX_PROJECTS = 100;

export interface ExternalOAuthContext {
	principal: OAuthAuthPrincipal;
	userId: string;
	/** Durable oauth_grants.id that owns every externally provisioned resource. */
	grantId: string;
	/** Internal oauth_clients.id. */
	oauthClientId: string;
	/** Public OAuth client_id carried by the access token. */
	clientId: string;
	/** Live effective canonical capabilities: token ∩ authority grants ∩ active client. */
	scopes: readonly string[];
	/** Revision bound into authorization/cache/subscription decisions. */
	authorityRevision: number;
	/** Finite project scopes derived from canonical authority grants. */
	projectIds: readonly string[];
	allowedProjectIds: ReadonlySet<string>;
	/** Capability-specific project scopes; no capability inherits another capability's projects. */
	capabilityProjectIds: ReadonlyMap<string, ReadonlySet<string>>;
	/** Normalized policy snapshot captured on the durable grant. */
	policy: OAuthClientPolicy;
}

/** Minimal non-secret device projection needed for authorization and binding. */
export interface ExternalOAuthDeviceResource {
	id: string;
	scope: "global" | "project";
	projectId: string | null;
	revokedAt: string | null;
}

/** Minimal narrator projection needed for authorization and device binding. */
export interface ExternalOAuthNarratorResource {
	id: string;
	chapterId: string | null;
	contextProjectId: string | null;
	defaultDeviceId: string | null;
}

export type ExternalOAuthPrincipalSource = Context | OAuthAuthPrincipal;
export type ExternalOAuthDeviceBinding = Pick<
	ExternalOAuthDeviceResource,
	"id" | "scope" | "projectId"
>;

function oauthRequired(): AppError {
	return new AppError("OAuth access token required", 401, "OAUTH_REQUIRED");
}

function grantRequired(): AppError {
	return new AppError(
		"A grant-bound OAuth access token is required for external resources",
		403,
		"OAUTH_GRANT_REQUIRED",
	);
}

function grantForbidden(): AppError {
	return new AppError("OAuth grant is inactive or invalid", 403, "OAUTH_GRANT_FORBIDDEN");
}

function clientForbidden(): AppError {
	return new AppError("OAuth client is inactive or invalid", 403, "OAUTH_CLIENT_FORBIDDEN");
}

function policyForbidden(): AppError {
	return new AppError("OAuth policy has no permitted runtime mode", 403, "OAUTH_POLICY_FORBIDDEN");
}

function isOAuthPrincipal(source: ExternalOAuthPrincipalSource): source is OAuthAuthPrincipal {
	return (source as { type?: unknown }).type === "oauth";
}

function resolveOAuthPrincipal(source: ExternalOAuthPrincipalSource): OAuthAuthPrincipal {
	if (isOAuthPrincipal(source)) return source;
	const principal = getAuthPrincipal(source);
	if (!principal || principal.type !== "oauth") throw oauthRequired();
	return principal;
}

function intersectEffectiveScopes(
	principalScopes: readonly string[],
	grantScopes: readonly string[],
	clientScopes: readonly string[],
): string[] {
	const grantScopeSet = new Set(grantScopes);
	const clientScopeSet = new Set(clientScopes);
	return [
		...new Set(
			principalScopes
				.map((scope) => scope.trim())
				.filter(
					(scope) => scope.length > 0 && grantScopeSet.has(scope) && clientScopeSet.has(scope),
				),
		),
	];
}

/**
 * Resolve the live OAuth authorization context from a Hono request or an already
 * authenticated OAuth principal. Legacy grant-less/v1 tokens are explicitly
 * rejected instead of being interpreted as unscoped access.
 */
export async function requireExternalOAuthContext(
	source: ExternalOAuthPrincipalSource,
): Promise<ExternalOAuthContext> {
	const principal = resolveOAuthPrincipal(source);
	const grantId = principal.oauth.grantId;
	if (!grantId) throw grantRequired();

	const [grant] = await db
		.select({
			id: oauthGrants.id,
			oauthClientId: oauthGrants.oauthClientId,
			userId: oauthGrants.userId,
			revokedAt: oauthGrants.revokedAt,
		})
		.from(oauthGrants)
		.where(eq(oauthGrants.id, grantId))
		.limit(1);
	if (!grant || grant.revokedAt || grant.userId !== principal.user.sub) throw grantForbidden();

	const [client, authority] = await Promise.all([
		db
			.select({
				id: oauthClients.id,
				clientId: oauthClients.clientId,
				scopes: oauthClients.scopes,
				policyJson: oauthClients.policyJson,
				publicClient: oauthClients.publicClient,
				revokedAt: oauthClients.revokedAt,
			})
			.from(oauthClients)
			.where(eq(oauthClients.id, grant.oauthClientId))
			.limit(1)
			.then((rows) => rows[0]),
		integrationAuthorityService.getSnapshot(grant.id),
	]);
	if (
		!client ||
		client.revokedAt ||
		!client.publicClient ||
		client.clientId !== principal.oauth.clientId
	) {
		throw clientForbidden();
	}
	if (
		!authority ||
		authority.authority.state !== "active" ||
		authority.authority.kind !== "oauth_grant" ||
		authority.authority.integrationType !== "oauth_client" ||
		authority.authority.integrationId !== client.id ||
		authority.authority.ownerUserId !== principal.user.sub
	) {
		throw grantForbidden();
	}

	const grantedCapabilities = [...new Set(authority.grants.map((grant) => grant.capabilityId))];
	const scopes = Object.freeze(
		intersectEffectiveScopes(principal.oauth.scopes, grantedCapabilities, client.scopes),
	);
	const policy = intersectOAuthClientPolicies(
		normalizeOAuthClientPolicy(authority.authority.policyJson),
		normalizeOAuthClientPolicy(client.policyJson),
	);
	if (!policy) throw policyForbidden();
	const capabilityProjects = new Map<string, Set<string>>();
	for (const item of authority.grants) {
		if (item.scopeType !== "project" || !item.scopeId) continue;
		const projects = capabilityProjects.get(item.capabilityId) ?? new Set<string>();
		projects.add(item.scopeId);
		if (projects.size > EXTERNAL_OAUTH_MAX_PROJECTS) throw grantForbidden();
		capabilityProjects.set(item.capabilityId, projects);
	}
	const projectIds = Object.freeze(
		[...new Set([...capabilityProjects.values()].flatMap((projects) => [...projects]))].sort(),
	);
	if (projectIds.length > EXTERNAL_OAUTH_MAX_PROJECTS) throw grantForbidden();
	return {
		principal,
		userId: principal.user.sub,
		grantId: grant.id,
		oauthClientId: client.id,
		clientId: client.clientId,
		scopes,
		authorityRevision: authority.authority.revision,
		projectIds,
		allowedProjectIds: new Set(projectIds),
		capabilityProjectIds: new Map(
			[...capabilityProjects].map(([capability, projects]) => [capability, new Set(projects)]),
		),
		policy,
	};
}

/** Require a live effective OAuth scope. */
export function assertExternalScope(ctx: ExternalOAuthContext, scope: string): void {
	const requiredScope = scope.trim();
	if (!requiredScope) {
		throw new AppError("Required scope must not be empty", 500, "INVALID_SCOPE");
	}
	if (!ctx.scopes.includes(requiredScope)) {
		throw new AppError(`Missing required scope: ${requiredScope}`, 403, "INSUFFICIENT_SCOPE");
	}
}

/** Synchronous alias for service/route code that prefers require* naming. */
export const requireExternalScope = assertExternalScope;

export function externalProjectIdsForCapability(
	ctx: ExternalOAuthContext,
	capability: CanonicalCapabilityId,
): readonly string[] {
	return [...(ctx.capabilityProjectIds.get(capability) ?? [])].sort();
}

export function assertExternalCapabilityProjectAllowed(
	ctx: ExternalOAuthContext,
	capability: CanonicalCapabilityId,
	projectId: string,
): void {
	if (!projectId || !ctx.capabilityProjectIds.get(capability)?.has(projectId)) {
		throw new AppError(
			`OAuth capability ${capability} does not allow access to this project`,
			403,
			"OAUTH_PROJECT_FORBIDDEN",
		);
	}
}

export async function requireExternalOperation(
	ctx: ExternalOAuthContext,
	input: {
		operation: string;
		capability: CanonicalCapabilityId;
		resource: ResourceRef;
		projectId?: string;
		constraints?: AuthorizationConstraints;
		requestBytes?: number;
	},
): Promise<void> {
	assertExternalScope(ctx, input.capability);
	const projectId = input.projectId;
	if (projectId) assertExternalCapabilityProjectAllowed(ctx, input.capability, projectId);
	const scope = projectId
		? ({ type: "project", id: projectId } as const)
		: ({ type: "integration", id: ctx.grantId } as const);
	await integrationAuthorizationService.require({
		authorityId: ctx.grantId,
		authorityRevision: ctx.authorityRevision,
		operation: input.operation,
		capability: input.capability,
		scope,
		resource: input.resource,
		boundScopes: [scope],
		runtime: { type: "server", id: `external-v1:${ctx.oauthClientId}`, generation: 1 },
		permittedCapabilities: ctx.scopes as readonly CanonicalCapabilityId[],
		constraints: input.constraints,
		resourceProjectId: projectId,
		resourceContainerScope: projectId ? undefined : scope,
		transport: "external-v1",
		requestBytes: input.requestBytes,
	});
}

/** Require exact membership in the grant's finite project allow-list. */
export function assertExternalProjectAllowed(ctx: ExternalOAuthContext, projectId: string): void {
	if (!projectId || !ctx.allowedProjectIds.has(projectId)) {
		throw new AppError(
			"OAuth grant does not allow access to this project",
			403,
			"OAUTH_PROJECT_FORBIDDEN",
		);
	}
}

/** Synchronous alias for service/route code that prefers require* naming. */
export const requireExternalProjectAccess = assertExternalProjectAllowed;

function resourceNotFound(entity: string, id: string): NotFoundError {
	return new NotFoundError(entity, id);
}

async function requireActiveOAuthResourceBinding(
	ctx: ExternalOAuthContext,
	resourceType: "device" | "narrator",
	resourceId: string,
	entity: string,
) {
	const binding = await integrationResourceBindingService.get(resourceType, resourceId);
	if (
		!binding ||
		binding.state !== "active" ||
		binding.sourceType !== "oauth_client" ||
		binding.sourceId !== ctx.oauthClientId ||
		binding.authorityType !== "oauth_grant" ||
		binding.authorityId !== ctx.grantId
	) {
		throw resourceNotFound(entity, resourceId);
	}
	return binding;
}

function isOwnedDeviceProjectAuthorized(
	ctx: ExternalOAuthContext,
	device: ExternalOAuthDeviceBinding,
): boolean {
	if (device.scope === "global") {
		return (
			ctx.policy.allowGlobalDevice &&
			!!device.projectId &&
			ctx.allowedProjectIds.has(device.projectId)
		);
	}
	return !!device.projectId && ctx.allowedProjectIds.has(device.projectId);
}

/** Resolve an active device owned by this grant and visible in its project policy. */
export async function requireOwnedExternalDevice(
	ctx: ExternalOAuthContext,
	id: string,
): Promise<ExternalOAuthDeviceResource> {
	const [device] = await db
		.select({
			id: remoteDevices.id,
			scope: remoteDevices.scope,
			projectId: remoteDevices.projectId,
			revokedAt: remoteDevices.revokedAt,
		})
		.from(remoteDevices)
		.where(and(eq(remoteDevices.id, id), isNull(remoteDevices.revokedAt)))
		.limit(1);
	if (!device) throw resourceNotFound("Remote device", id);
	await requireActiveOAuthResourceBinding(ctx, "device", id, "Remote device");
	if (!isOwnedDeviceProjectAuthorized(ctx, device)) {
		throw resourceNotFound("Remote device", id);
	}
	return device;
}

/** Resolve a narrator owned by this grant and bound to an allowed project. */
export async function requireOwnedExternalNarrator(
	ctx: ExternalOAuthContext,
	id: string,
): Promise<ExternalOAuthNarratorResource> {
	const [narrator] = await db
		.select({
			id: narrators.id,
			chapterId: narrators.chapterId,
			contextProjectId: narrators.contextProjectId,
			defaultDeviceId: narrators.defaultDeviceId,
		})
		.from(narrators)
		.where(eq(narrators.id, id))
		.limit(1);
	if (!narrator) throw resourceNotFound("Narrator", id);
	await requireActiveOAuthResourceBinding(ctx, "narrator", id, "Narrator");
	if (!narrator.contextProjectId || !ctx.allowedProjectIds.has(narrator.contextProjectId)) {
		throw resourceNotFound("Narrator", id);
	}
	return narrator;
}

/**
 * Validate binding a device to a narrator/project. Any owner, allow-list, or
 * project-scope mismatch is returned as 404 to prevent cross-grant enumeration.
 */
export async function assertExternalDeviceBinding(
	ctx: ExternalOAuthContext,
	device: ExternalOAuthDeviceBinding,
	projectId: string,
): Promise<void> {
	await requireActiveOAuthResourceBinding(ctx, "device", device.id, "Remote device");
	if (!projectId || !ctx.allowedProjectIds.has(projectId)) {
		throw resourceNotFound("Remote device", device.id);
	}
	if (device.scope === "global") {
		if (!ctx.policy.allowGlobalDevice || device.projectId !== projectId) {
			throw resourceNotFound("Remote device", device.id);
		}
		return;
	}
	if (!device.projectId || device.projectId !== projectId) {
		throw resourceNotFound("Remote device", device.id);
	}
}
