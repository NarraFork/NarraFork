/**
 * Central resource authorization for the external OAuth API.
 *
 * Access tokens authenticate a user/client pair, but external resources are
 * owned by a durable grant and constrained to that grant's finite project
 * allow-list. This module is the single fail-closed boundary for resolving the
 * live grant/client context and for hiding unauthorized resource existence.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db";
import {
	narrators,
	oauthClients,
	oauthGrantProjects,
	oauthGrants,
	remoteDevices,
} from "../db/schema";
import { AppError, NotFoundError } from "../lib/errors";
import {
	intersectOAuthClientPolicies,
	normalizeOAuthClientPolicy,
	type OAuthClientPolicy,
} from "../lib/oauth-client-policy";
import { getAuthPrincipal, type OAuthAuthPrincipal } from "../middleware/auth";

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
	/** Live effective scopes: token principal ∩ grant ∩ active client. */
	scopes: readonly string[];
	/** Finite grant allow-list. An empty array means deny-all, never unrestricted. */
	projectIds: readonly string[];
	allowedProjectIds: ReadonlySet<string>;
	/** Normalized policy snapshot captured on the durable grant. */
	policy: OAuthClientPolicy;
}

export interface ExternalOAuthOwnedResource {
	id: string;
	oauthOwnerGrantId: string | null;
}

/** Minimal non-secret device projection needed for authorization and binding. */
export interface ExternalOAuthDeviceResource extends ExternalOAuthOwnedResource {
	scope: "global" | "project";
	projectId: string | null;
	revokedAt: string | null;
}

/** Minimal narrator projection needed for authorization and device binding. */
export interface ExternalOAuthNarratorResource extends ExternalOAuthOwnedResource {
	chapterId: string | null;
	contextProjectId: string | null;
	defaultDeviceId: string | null;
}

export type ExternalOAuthPrincipalSource = Context | OAuthAuthPrincipal;
export type ExternalOAuthDeviceBinding = Pick<
	ExternalOAuthDeviceResource,
	"id" | "oauthOwnerGrantId" | "scope" | "projectId"
>;

function oauthRequired(): AppError {
	return new AppError("OAuth access token required", 401, "OAUTH_REQUIRED");
}

function legacyGrantForbidden(): AppError {
	return new AppError(
		"Legacy OAuth v1 grants cannot access external resources; authorize the client again",
		403,
		"OAUTH_LEGACY_GRANT_FORBIDDEN",
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
	if (!grantId) throw legacyGrantForbidden();

	const [grant] = await db
		.select({
			id: oauthGrants.id,
			oauthClientId: oauthGrants.oauthClientId,
			userId: oauthGrants.userId,
			scopes: oauthGrants.scopes,
			policyJson: oauthGrants.policyJson,
			legacyUnscoped: oauthGrants.legacyUnscoped,
			revokedAt: oauthGrants.revokedAt,
		})
		.from(oauthGrants)
		.where(eq(oauthGrants.id, grantId))
		.limit(1);
	if (!grant || grant.revokedAt || grant.userId !== principal.user.sub) throw grantForbidden();
	if (grant.legacyUnscoped) throw legacyGrantForbidden();

	const [client] = await db
		.select({
			id: oauthClients.id,
			clientId: oauthClients.clientId,
			scopes: oauthClients.scopes,
			policyJson: oauthClients.policyJson,
			revokedAt: oauthClients.revokedAt,
		})
		.from(oauthClients)
		.where(eq(oauthClients.id, grant.oauthClientId))
		.limit(1);
	if (!client || client.revokedAt || client.clientId !== principal.oauth.clientId) {
		throw clientForbidden();
	}

	const projectRows = await db
		.select({ projectId: oauthGrantProjects.projectId })
		.from(oauthGrantProjects)
		.where(eq(oauthGrantProjects.grantId, grant.id))
		.orderBy(oauthGrantProjects.projectId)
		.limit(EXTERNAL_OAUTH_MAX_PROJECTS + 1);
	if (projectRows.length > EXTERNAL_OAUTH_MAX_PROJECTS) throw grantForbidden();

	const scopes = Object.freeze(
		intersectEffectiveScopes(principal.oauth.scopes, grant.scopes, client.scopes),
	);
	const policy = intersectOAuthClientPolicies(
		normalizeOAuthClientPolicy(grant.policyJson),
		normalizeOAuthClientPolicy(client.policyJson),
	);
	if (!policy) throw policyForbidden();
	const projectIds = Object.freeze(projectRows.map((row) => row.projectId));
	return {
		principal,
		userId: principal.user.sub,
		grantId: grant.id,
		oauthClientId: client.id,
		clientId: client.clientId,
		scopes,
		projectIds,
		allowedProjectIds: new Set(projectIds),
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

/**
 * Enforce durable grant ownership without revealing whether a resource owned by
 * another grant exists.
 */
export function requireExternalResourceOwner<T extends ExternalOAuthOwnedResource>(
	ctx: ExternalOAuthContext,
	resource: T | null | undefined,
	entity: string,
	id: string,
): T {
	if (!resource || resource.oauthOwnerGrantId !== ctx.grantId) {
		throw resourceNotFound(entity, id);
	}
	return resource;
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
			oauthOwnerGrantId: remoteDevices.oauthOwnerGrantId,
			scope: remoteDevices.scope,
			projectId: remoteDevices.projectId,
			revokedAt: remoteDevices.revokedAt,
		})
		.from(remoteDevices)
		.where(
			and(
				eq(remoteDevices.id, id),
				eq(remoteDevices.oauthOwnerGrantId, ctx.grantId),
				isNull(remoteDevices.revokedAt),
			),
		)
		.limit(1);
	const owned = requireExternalResourceOwner(ctx, device, "Remote device", id);
	if (!isOwnedDeviceProjectAuthorized(ctx, owned)) {
		throw resourceNotFound("Remote device", id);
	}
	return owned;
}

/** Resolve a narrator owned by this grant and bound to an allowed project. */
export async function requireOwnedExternalNarrator(
	ctx: ExternalOAuthContext,
	id: string,
): Promise<ExternalOAuthNarratorResource> {
	const [narrator] = await db
		.select({
			id: narrators.id,
			oauthOwnerGrantId: narrators.oauthOwnerGrantId,
			chapterId: narrators.chapterId,
			contextProjectId: narrators.contextProjectId,
			defaultDeviceId: narrators.defaultDeviceId,
		})
		.from(narrators)
		.where(and(eq(narrators.id, id), eq(narrators.oauthOwnerGrantId, ctx.grantId)))
		.limit(1);
	const owned = requireExternalResourceOwner(ctx, narrator, "Narrator", id);
	if (!owned.contextProjectId || !ctx.allowedProjectIds.has(owned.contextProjectId)) {
		throw resourceNotFound("Narrator", id);
	}
	return owned;
}

/**
 * Validate binding a device to a narrator/project. Any owner, allow-list, or
 * project-scope mismatch is returned as 404 to prevent cross-grant enumeration.
 */
export function assertExternalDeviceBinding(
	ctx: ExternalOAuthContext,
	device: ExternalOAuthDeviceBinding,
	projectId: string,
): void {
	requireExternalResourceOwner(ctx, device, "Remote device", device.id);
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
