import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { oauthClients, oauthGrantProjects, oauthGrants, remoteDevices } from "../db/schema";
import {
	intersectOAuthClientPolicies,
	normalizeOAuthClientPolicy,
	type OAuthClientPolicy,
} from "../lib/oauth-client-policy";
import type { RemoteDeviceRow } from "./device-service";

export interface OAuthDeviceRuntimeAuthorization {
	oauthOwned: boolean;
	allowed: boolean;
	reason?: string;
	grantId?: string;
	oauthClientId?: string;
	userId?: string;
	projectId?: string;
	policy?: OAuthClientPolicy;
}

type OAuthDeviceRuntimeResource = Pick<
	RemoteDeviceRow,
	"id" | "oauthOwnerGrantId" | "createdBy" | "scope" | "projectId" | "revokedAt"
>;

function denied(reason: string): OAuthDeviceRuntimeAuthorization {
	return { oauthOwned: true, allowed: false, reason };
}

/**
 * Resolve the live owner authorization for an OAuth-provisioned device.
 * Ordinary devices intentionally bypass this additional OAuth boundary.
 */
export async function resolveOAuthDeviceRuntimeAuthorization(
	device: OAuthDeviceRuntimeResource,
): Promise<OAuthDeviceRuntimeAuthorization> {
	if (!device.oauthOwnerGrantId) return { oauthOwned: false, allowed: true };
	const liveDevice = await db.query.remoteDevices.findFirst({
		where: eq(remoteDevices.id, device.id),
		columns: {
			id: true,
			oauthOwnerGrantId: true,
			createdBy: true,
			scope: true,
			projectId: true,
			revokedAt: true,
		},
	});
	if (!liveDevice || liveDevice.revokedAt) return denied("Device revoked");
	if (liveDevice.oauthOwnerGrantId !== device.oauthOwnerGrantId) {
		return denied("OAuth device owner binding is inactive");
	}
	if (!liveDevice.projectId) return denied("OAuth device project binding is missing");

	const grant = await db.query.oauthGrants.findFirst({
		where: and(eq(oauthGrants.id, liveDevice.oauthOwnerGrantId), isNull(oauthGrants.revokedAt)),
	});
	if (!grant || grant.legacyUnscoped) return denied("OAuth grant is inactive");
	if (grant.userId !== liveDevice.createdBy) {
		return denied("OAuth device owner no longer matches the grant");
	}

	const client = await db.query.oauthClients.findFirst({
		where: and(eq(oauthClients.id, grant.oauthClientId), isNull(oauthClients.revokedAt)),
	});
	if (!client) return denied("OAuth client is inactive");

	const projectBinding = await db.query.oauthGrantProjects.findFirst({
		where: and(
			eq(oauthGrantProjects.grantId, grant.id),
			eq(oauthGrantProjects.projectId, liveDevice.projectId),
		),
		columns: { id: true },
	});
	if (!projectBinding) return denied("OAuth device project access has been revoked");

	const policy = intersectOAuthClientPolicies(
		normalizeOAuthClientPolicy(grant.policyJson),
		normalizeOAuthClientPolicy(client.policyJson),
	);
	if (!policy) return denied("OAuth device policy intersection is empty");
	if (liveDevice.scope === "global" && !policy.allowGlobalDevice) {
		return denied("OAuth global device access has been revoked");
	}

	return {
		oauthOwned: true,
		allowed: true,
		grantId: grant.id,
		oauthClientId: client.id,
		userId: grant.userId,
		projectId: liveDevice.projectId,
		policy,
	};
}
