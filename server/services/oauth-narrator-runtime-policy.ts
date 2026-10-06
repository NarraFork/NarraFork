import { and, eq, inArray, isNull } from "drizzle-orm";
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

const BASE_EXTERNAL_TOOLS = [
	"Read",
	"Glob",
	"Grep",
	"SwitchDevice",
	"KnowledgeSearch",
	"KnowledgeRead",
] as const;
const KNOWLEDGE_WRITE_TOOLS = ["KnowledgeCreate", "KnowledgeEdit"] as const;
const REMOTE_SHELL_TOOLS = ["Bash"] as const;
const REMOTE_FILE_WRITE_TOOLS = ["Write", "Edit"] as const;
/**
 * Decision-only tools for the danger reflection loop. Admitted under bypassPermissions
 * because that mode routes risky calls into reflection instead of denying them, and the
 * loop fails closed (cancel) if it cannot call one of them.
 *
 * These reach no device, file, or network: each only settles one pending permission
 * decision, and dangerReflectionTools guard on ctx.reflectionLoop.kind, so calling them
 * from the main loop is inert. Admitting them does not widen the runtime's real reach.
 */
const DANGER_REFLECTION_DECISION_TOOLS = ["DangerConfirm", "DangerCancel"] as const;

export interface OAuthNarratorRuntimePolicy {
	grantId: string;
	clientId: string;
	userId: string;
	/** Legacy v2 snapshots carry a project anchor; v3 (project-less) grants do not. */
	projectId: string | null;
	defaultDeviceId: string;
	deviceIds: readonly string[];
	permissionMode: OAuthExternalPermissionMode;
	systemPrompt: string | undefined;
	/**
	 * Client-supplied business context appended to the danger reflection prompt. Only
	 * meaningful under bypassPermissions, where reflection actually runs.
	 */
	dangerReflectionPrompt: string | undefined;
	/**
	 * Whether the server-defined robot diagnostic read-only preset is merged into this
	 * narrator's allow-list, keeping routine inspection commands out of danger reflection.
	 */
	useRobotDiagnosticPreset: boolean;
	policy: OAuthClientPolicy;
	allowedTools: ReadonlySet<string>;
	/**
	 * Whether this narrator may execute on the NarraFork server itself, derived from
	 * policy.deviceAccess.host. Defaults to denied (false) but an administrator may widen
	 * it per OAuth client — this is no longer an unconditional false.
	 */
	allowLocalExecution: boolean;
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

/**
 * Strictest to most permissive. A snapshot mode the live policy no longer allows falls back
 * down this list, never up: tightening the policy can only shrink an existing narrator's
 * runtime.
 */
const PERMISSION_MODE_FALLBACK: readonly OAuthExternalPermissionMode[] = [
	"dontAsk",
	"readOnly",
	"bypassPermissions",
];

function resolvePermissionMode(
	snapshotMode: OAuthExternalPermissionMode,
	policy: OAuthClientPolicy,
): OAuthExternalPermissionMode {
	if (policy.allowedPermissionModes.includes(snapshotMode)) return snapshotMode;
	const snapshotRank = PERMISSION_MODE_FALLBACK.indexOf(snapshotMode);
	// Step down one rank at a time and take the first allowed mode, so tightening the policy
	// costs the narrator as little capability as the policy actually requires: a bypass
	// narrator prefers readOnly over dontAsk. Widening never happens because only ranks
	// below the snapshot are considered.
	for (let rank = snapshotRank - 1; rank >= 0; rank--) {
		const candidate = PERMISSION_MODE_FALLBACK[rank];
		if (policy.allowedPermissionModes.includes(candidate)) return candidate;
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
 * Resolve the frozen danger reflection appendix against the live policy.
 *
 * Unlike resolveSystemPrompt this drops the value instead of throwing. The appendix is
 * advisory context for a review loop, not a capability: if an administrator later revokes
 * allowDangerReflectionPrompt or lowers the ceiling, the safe outcome is reflection running
 * without the extra context, not an existing diagnostic session becoming unusable.
 */
function resolveDangerReflectionPrompt(
	snapshot: OAuthNarratorProvisionSnapshot,
	policy: OAuthClientPolicy,
): string | undefined {
	if (!policy.allowDangerReflectionPrompt) return undefined;
	const prompt = snapshot.dangerReflectionPrompt;
	if (!prompt) return undefined;
	if (prompt.length > policy.maxDangerReflectionPromptChars) return undefined;
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
	if (!provenance) {
		if (narrator.oauthPolicySnapshotJson !== null) {
			throw runtimeForbidden("OAuth narrator provenance is missing");
		}
		return null;
	}
	if (provenance.sourceType !== "oauth_client" || provenance.authorityType !== "oauth_grant") {
		if (narrator.oauthPolicySnapshotJson !== null) {
			throw runtimeForbidden("OAuth narrator provenance does not match its runtime snapshot");
		}
		return null;
	}
	if (provenance.state !== "active") {
		throw runtimeForbidden("OAuth narrator provenance is inactive");
	}

	const snapshot = parseSnapshot(narrator.oauthPolicySnapshotJson);
	// OAuth grants are no longer project-bound. Only assert the project binding
	// still matches for legacy v2 snapshots that captured a projectId; v3
	// (project-less) snapshots carry no projectId to compare.
	const snapshotProjectId = snapshot.projectId ?? null;
	if (snapshotProjectId !== null && narrator.contextProjectId !== snapshotProjectId) {
		throw runtimeForbidden("OAuth narrator bindings no longer match the provision snapshot");
	}
	if (!narrator.defaultDeviceId || !snapshot.deviceIds.includes(narrator.defaultDeviceId)) {
		throw runtimeForbidden("OAuth narrator default device is outside its provision snapshot");
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
	// Grant ownership is the boundary: require the send_message capability on the
	// authority (any scope) rather than a project-scoped grant.
	const executionGrant = authority.grants.some(
		(grant) => grant.capabilityId === "narrator.send_message",
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

	const deviceRows = await db.query.remoteDevices.findMany({
		where: and(inArray(remoteDevices.id, snapshot.deviceIds), isNull(remoteDevices.revokedAt)),
		columns: { id: true, scope: true, projectId: true },
	});
	const devicesById = new Map(deviceRows.map((device) => [device.id, device]));
	for (const deviceId of snapshot.deviceIds) {
		const device = devicesById.get(deviceId);
		const deviceProvenance = device
			? await integrationResourceBindingService.get("device", device.id)
			: null;
		// Device isolation is enforced by the resource binding belonging to the
		// same grant/client, not by matching a shared project anchor. For legacy
		// v2 snapshots (projectId present) the device project must still match.
		if (
			!device ||
			(snapshotProjectId !== null && device.projectId !== snapshotProjectId) ||
			!deviceProvenance ||
			deviceProvenance.state !== "active" ||
			deviceProvenance.sourceType !== "oauth_client" ||
			deviceProvenance.sourceId !== provenance.sourceId ||
			deviceProvenance.authorityType !== "oauth_grant" ||
			deviceProvenance.authorityId !== provenance.authorityId
		) {
			throw runtimeForbidden(`OAuth narrator device binding is inactive: ${deviceId}`);
		}
		// Grant ownership (device provenance matching the same grant/client,
		// verified above) is the isolation boundary; the device scope column no
		// longer gates access after de-projectization.
	}

	const allowKnowledgeWrite = policy.allowKnowledgeWrite;
	// Bash/Write/Edit are admitted into allowedTools if ANY device access group could
	// possibly grant them; the specific device a tool call targets is classified and
	// checked against the exact group level at runtime in handlePermission
	// (narrator-permission.ts), so this is a coarse candidate-set gate, not the final
	// per-device authorization.
	const deviceGroupsAllowExecution = Object.values(policy.deviceAccess).some(
		(level) => level !== "denied",
	);
	const deviceGroupsAllowFileWrite = Object.values(policy.deviceAccess).some(
		(level) => level === "readWrite",
	);
	const permissionMode = resolvePermissionMode(snapshot.permissionMode, policy);
	return {
		grantId: authority.authority.id,
		clientId: client.id,
		userId: authorityOwnerUserId,
		projectId: snapshotProjectId,
		defaultDeviceId: narrator.defaultDeviceId,
		deviceIds: [...snapshot.deviceIds],
		permissionMode,
		systemPrompt: resolveSystemPrompt(snapshot, policy),
		dangerReflectionPrompt: resolveDangerReflectionPrompt(snapshot, policy),
		useRobotDiagnosticPreset: policy.allowRobotDiagnosticPreset,
		policy,
		allowedTools: new Set([
			...BASE_EXTERNAL_TOOLS,
			...(allowKnowledgeWrite ? KNOWLEDGE_WRITE_TOOLS : []),
			...(deviceGroupsAllowExecution ? REMOTE_SHELL_TOOLS : []),
			...(deviceGroupsAllowFileWrite ? REMOTE_FILE_WRITE_TOOLS : []),
			...(permissionMode === "bypassPermissions" ? DANGER_REFLECTION_DECISION_TOOLS : []),
		]),
		allowLocalExecution: policy.deviceAccess.host !== "denied",
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
