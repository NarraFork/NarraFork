import { and, eq, isNull } from "drizzle-orm";
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
	type OAuthClientPolicy,
	type OAuthExternalPermissionMode,
	type OAuthNarratorProvisionSnapshot,
	oauthClientPolicySchema,
	oauthNarratorProvisionSnapshotSchema,
} from "../lib/oauth-client-policy";

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
			oauthOwnerGrantId: true,
			oauthPolicySnapshotJson: true,
			contextProjectId: true,
			defaultDeviceId: true,
		},
	});
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	if (!narrator.oauthOwnerGrantId) return null;

	const snapshot = parseSnapshot(narrator.oauthPolicySnapshotJson);
	if (
		narrator.contextProjectId !== snapshot.projectId ||
		narrator.defaultDeviceId !== snapshot.deviceId
	) {
		throw runtimeForbidden("OAuth narrator bindings no longer match the provision snapshot");
	}

	const grant = await db.query.oauthGrants.findFirst({
		where: and(eq(oauthGrants.id, narrator.oauthOwnerGrantId), isNull(oauthGrants.revokedAt)),
	});
	if (!grant || grant.legacyUnscoped) throw runtimeForbidden("OAuth grant is inactive");
	if (expectedUserId !== undefined && expectedUserId !== null && grant.userId !== expectedUserId) {
		throw runtimeForbidden("OAuth narrator trigger user does not own the grant");
	}

	const client = await db.query.oauthClients.findFirst({
		where: and(eq(oauthClients.id, grant.oauthClientId), isNull(oauthClients.revokedAt)),
	});
	if (!client) throw runtimeForbidden("OAuth client is inactive");
	if (!grant.scopes.includes("narrator:message") || !client.scopes.includes("narrator:message")) {
		throw runtimeForbidden("OAuth narrator execution scope has been revoked");
	}

	const projectBinding = await db.query.oauthGrantProjects.findFirst({
		where: and(
			eq(oauthGrantProjects.grantId, grant.id),
			eq(oauthGrantProjects.projectId, snapshot.projectId),
		),
		columns: { id: true },
	});
	if (!projectBinding) throw runtimeForbidden("OAuth narrator project access has been revoked");

	const policy = intersectOAuthClientPolicies(
		parsePolicy(client.policyJson, "client"),
		parsePolicy(grant.policyJson, "grant"),
		snapshot.policy,
	);
	if (!policy) throw runtimeForbidden("OAuth narrator policy intersection is empty");

	const device = await db.query.remoteDevices.findFirst({
		where: and(
			eq(remoteDevices.id, snapshot.deviceId),
			eq(remoteDevices.oauthOwnerGrantId, grant.id),
			isNull(remoteDevices.revokedAt),
		),
		columns: { id: true, scope: true, projectId: true },
	});
	if (!device || device.projectId !== snapshot.projectId) {
		throw runtimeForbidden("OAuth narrator device binding is inactive");
	}
	if (device.scope === "global" && !policy.allowGlobalDevice) {
		throw runtimeForbidden("OAuth narrator global device access has been revoked");
	}

	const allowKnowledgeWrite = policy.allowKnowledgeWrite;
	return {
		grantId: grant.id,
		clientId: client.id,
		userId: grant.userId,
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
