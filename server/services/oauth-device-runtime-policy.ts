import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { oauthClients, remoteDevices } from "../db/schema";
import {
	intersectOAuthClientPolicies,
	normalizeOAuthClientPolicy,
	type OAuthClientPolicy,
} from "../lib/oauth-client-policy";
import type { RemoteDeviceRow } from "./device-service";
import { integrationAuthorityService } from "./integration-authority-service";
import { integrationResourceBindingService } from "./integration-resource-binding-service";

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
	"id" | "createdBy" | "scope" | "projectId" | "revokedAt"
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
	const provenance = await integrationResourceBindingService.get("device", device.id);
	if (
		!provenance ||
		provenance.sourceType !== "oauth_client" ||
		provenance.authorityType !== "oauth_grant"
	) {
		return { oauthOwned: false, allowed: true };
	}
	if (provenance.state !== "active") {
		return denied("OAuth device provenance is inactive");
	}
	const liveDevice = await db.query.remoteDevices.findFirst({
		where: eq(remoteDevices.id, device.id),
		columns: {
			id: true,
			createdBy: true,
			scope: true,
			projectId: true,
			revokedAt: true,
		},
	});
	if (!liveDevice || liveDevice.revokedAt) return denied("Device revoked");
	// OAuth grants are no longer project-bound: the resource binding (grant
	// ownership) is the isolation boundary, so a missing projectId is allowed.

	const authority = await integrationAuthorityService.getSnapshot(provenance.authorityId);
	if (
		!authority ||
		authority.authority.kind !== "oauth_grant" ||
		authority.authority.integrationType !== "oauth_client" ||
		authority.authority.integrationId !== provenance.sourceId ||
		authority.authority.state !== "active"
	) {
		return denied("OAuth authority is inactive");
	}
	if (authority.authority.ownerUserId !== liveDevice.createdBy) {
		return denied("OAuth device owner no longer matches the authority");
	}

	const client = await db.query.oauthClients.findFirst({
		where: and(
			eq(oauthClients.id, authority.authority.integrationId),
			isNull(oauthClients.revokedAt),
		),
	});
	if (!client?.publicClient) return denied("OAuth client is inactive");

	// Grant ownership (verified above via the active resource binding + live
	// authority/client) is the isolation boundary. Project-scope grants are no
	// longer required; the authority being active suffices for access.

	const policy = intersectOAuthClientPolicies(
		normalizeOAuthClientPolicy(authority.authority.policyJson),
		normalizeOAuthClientPolicy(client.policyJson),
	);
	if (!policy) return denied("OAuth device policy intersection is empty");
	// Grant ownership (binding + active authority + owner match, all verified
	// above) is the isolation boundary for OAuth-owned devices; the device scope
	// column no longer gates runtime access after de-projectization.

	return {
		oauthOwned: true,
		allowed: true,
		grantId: authority.authority.id,
		oauthClientId: client.id,
		userId: authority.authority.ownerUserId ?? liveDevice.createdBy,
		projectId: liveDevice.projectId ?? undefined,
		policy,
	};
}
