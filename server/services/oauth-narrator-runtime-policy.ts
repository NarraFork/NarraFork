import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { narrators, oauthClients, remoteDevices } from "../db/schema";
import { AppError, NotFoundError } from "../lib/errors";
import {
	intersectOAuthClientPolicies,
	type OAuthClientPolicy,
	type OAuthExternalPermissionMode,
	type OAuthNarratorProvisionSnapshot,
	oauthClientPolicySchema,
	oauthNarratorProvisionSnapshotSchema,
} from "../lib/oauth-client-policy";
import { integrationAuthorityService } from "./integration-authority-service";
import { integrationResourceBindingService } from "./integration-resource-binding-service";

const BASE_EXTERNAL_TOOLS = ["Read", "Glob", "Grep", "KnowledgeSearch", "KnowledgeRead"] as const;
const KNOWLEDGE_WRITE_TOOLS = ["KnowledgeCreate", "KnowledgeEdit"] as const;

export interface OAuthNarratorRuntimePolicy {
	grantId: string;
	clientId: string;
	userId: string;
	projectId: string;
	deviceId: string;
	permissionMode: OAuthExternalPermissionMode;
	systemPrompt: string | undefined;
	policy: OAuthClientPolicy;
	allowedTools: ReadonlySet<string>;
	allowLocalExecution: false;
	allowKnowledgeWrite: boolean;
}

function runtimeForbidden(message: string): AppError {
	return new AppError(message, 403, "OAUTH_RUNTIME_FORBIDDEN");
}

function parsePolicy(value: unknown, source: string): OAuthClientPolicy {
	const parsed = oauthClientPolicySchema.safeParse(value);
	if (!parsed.success) throw runtimeForbidden(`Invalid ${source} OAuth policy`);
	return parsed.data;
}

function parseSnapshot(value: unknown): OAuthNarratorProvisionSnapshot {
	const parsed = oauthNarratorProvisionSnapshotSchema.safeParse(value);
	if (!parsed.success) {
		throw runtimeForbidden("OAuth narrator must be reprovisioned with a valid runtime snapshot");
	}
	return parsed.data;
}

function resolvePermissionMode(
	snapshotMode: OAuthExternalPermissionMode,
	policy: OAuthClientPolicy,
): OAuthExternalPermissionMode {
	if (policy.allowedPermissionModes.includes(snapshotMode)) return snapshotMode;
	// dontAsk is the strictest external mode. A readOnly narrator may be reduced to
	// dontAsk, but a dontAsk narrator is never widened to readOnly.
	if (snapshotMode === "readOnly" && policy.allowedPermissionModes.includes("dontAsk")) {
		return "dontAsk";
	}
	throw runtimeForbidden("OAuth narrator permission policy no longer permits execution");
}

function resolveSystemPrompt(
	snapshot: OAuthNarratorProvisionSnapshot,
	policy: OAuthClientPolicy,
): string | undefined {
	if (policy.systemPromptMode === "managed") return undefined;
	const prompt = snapshot.systemPrompt;
	if (!prompt) return undefined;
	if (prompt.length > policy.maxSystemPromptChars) {
		throw runtimeForbidden("OAuth narrator system prompt exceeds the current policy ceiling");
	}
	return prompt;
}

/**
 * Resolve the live, fail-closed policy for an OAuth-owned narrator.
 * Returns null for ordinary narrators so their existing runtime remains unchanged.
 */
export async function resolveOAuthNarratorRuntimePolicy(
	narratorId: string,
	expectedUserId?: string | null,
): Promise<OAuthNarratorRuntimePolicy | null> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: {
			id: true,
			oauthPolicySnapshotJson: true,
			contextProjectId: true,
			defaultDeviceId: true,
		},
	});
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	const provenance = await integrationResourceBindingService.get("narrator", narrator.id);
	if (
		!provenance ||
		provenance.sourceType !== "oauth_client" ||
		provenance.authorityType !== "oauth_grant"
	) {
		return null;
	}
	if (provenance.state !== "active") {
		throw runtimeForbidden("OAuth narrator provenance is inactive");
	}

	const snapshot = parseSnapshot(narrator.oauthPolicySnapshotJson);
	if (
		narrator.contextProjectId !== snapshot.projectId ||
		narrator.defaultDeviceId !== snapshot.deviceId
	) {
		throw runtimeForbidden("OAuth narrator bindings no longer match the provision snapshot");
	}

	const authority = await integrationAuthorityService.getSnapshot(provenance.authorityId);
	if (
		!authority ||
		authority.authority.kind !== "oauth_grant" ||
		authority.authority.integrationType !== "oauth_client" ||
		authority.authority.integrationId !== provenance.sourceId ||
		authority.authority.state !== "active"
	) {
		throw runtimeForbidden("OAuth authority is inactive");
	}
	const authorityOwnerUserId = authority.authority.ownerUserId;
	if (!authorityOwnerUserId) throw runtimeForbidden("OAuth authority owner is missing");
	if (
		expectedUserId !== undefined &&
		expectedUserId !== null &&
		authorityOwnerUserId !== expectedUserId
	) {
		throw runtimeForbidden("OAuth narrator trigger user does not own the authority");
	}

	const client = await db.query.oauthClients.findFirst({
		where: and(
			eq(oauthClients.id, authority.authority.integrationId),
			isNull(oauthClients.revokedAt),
		),
	});
	if (!client?.publicClient) throw runtimeForbidden("OAuth client is inactive");
	const executionGrant = authority.grants.some(
		(grant) =>
			grant.capabilityId === "narrator.send_message" &&
			grant.scopeType === "project" &&
			grant.scopeId === snapshot.projectId,
	);
	if (!executionGrant || !client.scopes.includes("narrator.send_message")) {
		throw runtimeForbidden("OAuth narrator execution capability has been revoked");
	}

	const policy = intersectOAuthClientPolicies(
		parsePolicy(client.policyJson, "client"),
		parsePolicy(authority.authority.policyJson, "authority"),
		snapshot.policy,
	);
	if (!policy) throw runtimeForbidden("OAuth narrator policy intersection is empty");

	const device = await db.query.remoteDevices.findFirst({
		where: and(eq(remoteDevices.id, snapshot.deviceId), isNull(remoteDevices.revokedAt)),
		columns: { id: true, scope: true, projectId: true },
	});
	const deviceProvenance = device
		? await integrationResourceBindingService.get("device", device.id)
		: null;
	if (
		!device ||
		device.projectId !== snapshot.projectId ||
		!deviceProvenance ||
		deviceProvenance.state !== "active" ||
		deviceProvenance.sourceType !== "oauth_client" ||
		deviceProvenance.sourceId !== provenance.sourceId ||
		deviceProvenance.authorityType !== "oauth_grant" ||
		deviceProvenance.authorityId !== provenance.authorityId
	) {
		throw runtimeForbidden("OAuth narrator device binding is inactive");
	}
	if (device.scope === "global" && !policy.allowGlobalDevice) {
		throw runtimeForbidden("OAuth narrator global device access has been revoked");
	}

	const allowKnowledgeWrite = policy.allowKnowledgeWrite;
	return {
		grantId: authority.authority.id,
		clientId: client.id,
		userId: authorityOwnerUserId,
		projectId: snapshot.projectId,
		deviceId: snapshot.deviceId,
		permissionMode: resolvePermissionMode(snapshot.permissionMode, policy),
		systemPrompt: resolveSystemPrompt(snapshot, policy),
		policy,
		allowedTools: new Set([
			...BASE_EXTERNAL_TOOLS,
			...(allowKnowledgeWrite ? KNOWLEDGE_WRITE_TOOLS : []),
		]),
		allowLocalExecution: false,
		allowKnowledgeWrite,
	};
}

/** Fail if an OAuth-owned narrator no longer has a live execution envelope. */
export async function assertOAuthNarratorRuntimeActive(
	narratorId: string,
	expectedUserId?: string | null,
): Promise<OAuthNarratorRuntimePolicy | null> {
	return resolveOAuthNarratorRuntimePolicy(narratorId, expectedUserId);
}
