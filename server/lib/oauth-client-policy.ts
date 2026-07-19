import { z } from "zod";

export const oauthExternalPermissionModeSchema = z.enum(["readOnly", "dontAsk"]);

const oauthClientPolicyShape = {
	defaultPermissionMode: oauthExternalPermissionModeSchema,
	allowedPermissionModes: z.array(oauthExternalPermissionModeSchema).min(1).max(2),
	systemPromptMode: z.enum(["managed", "append"]),
	maxSystemPromptChars: z.number().int().min(0).max(10_000),
	allowGlobalDevice: z.boolean(),
	allowKnowledgeWrite: z.boolean(),
};

export const oauthClientPolicySchema = z
	.object({
		defaultPermissionMode: oauthClientPolicyShape.defaultPermissionMode.default("readOnly"),
		allowedPermissionModes: oauthClientPolicyShape.allowedPermissionModes.default(["readOnly"]),
		systemPromptMode: oauthClientPolicyShape.systemPromptMode.default("managed"),
		maxSystemPromptChars: oauthClientPolicyShape.maxSystemPromptChars.default(0),
		allowGlobalDevice: oauthClientPolicyShape.allowGlobalDevice.default(false),
		allowKnowledgeWrite: oauthClientPolicyShape.allowKnowledgeWrite.default(false),
	})
	.strict()
	.superRefine((policy, ctx) => {
		if (!policy.allowedPermissionModes.includes(policy.defaultPermissionMode)) {
			ctx.addIssue({
				code: "custom",
				path: ["allowedPermissionModes"],
				message: "allowedPermissionModes must include defaultPermissionMode",
			});
		}
	});

export const oauthClientPolicyPatchSchema = z.object(oauthClientPolicyShape).partial().strict();

export type OAuthClientPolicy = z.infer<typeof oauthClientPolicySchema>;
export type OAuthExternalPermissionMode = z.infer<typeof oauthExternalPermissionModeSchema>;

/** Immutable runtime ceiling captured when an OAuth narrator is provisioned. */
export const oauthNarratorProvisionSnapshotSchema = z
	.object({
		version: z.literal(1),
		policy: oauthClientPolicySchema,
		permissionMode: oauthExternalPermissionModeSchema,
		systemPrompt: z.string().max(10_000).nullable(),
		projectId: z.string().min(1),
		deviceId: z.string().min(1),
	})
	.strict();

export type OAuthNarratorProvisionSnapshot = z.infer<typeof oauthNarratorProvisionSnapshotSchema>;

export const DEFAULT_OAUTH_CLIENT_POLICY: OAuthClientPolicy = oauthClientPolicySchema.parse({});

const OAUTH_PERMISSION_MODE_ORDER: readonly OAuthExternalPermissionMode[] = ["dontAsk", "readOnly"];

/**
 * Intersect independent OAuth policy ceilings. Every dimension is monotonic:
 * later policy changes may only retain or reduce the effective capability.
 */
export function intersectOAuthClientPolicies(
	...policies: readonly OAuthClientPolicy[]
): OAuthClientPolicy | null {
	if (policies.length === 0) return null;
	const allowedPermissionModes = OAUTH_PERMISSION_MODE_ORDER.filter((mode) =>
		policies.every((policy) => policy.allowedPermissionModes.includes(mode)),
	);
	if (allowedPermissionModes.length === 0) return null;
	const defaultPermissionMode =
		OAUTH_PERMISSION_MODE_ORDER.find((mode) => allowedPermissionModes.includes(mode)) ??
		allowedPermissionModes[0];
	return {
		defaultPermissionMode,
		allowedPermissionModes,
		systemPromptMode: policies.every((policy) => policy.systemPromptMode === "append")
			? "append"
			: "managed",
		maxSystemPromptChars: Math.min(...policies.map((policy) => policy.maxSystemPromptChars)),
		allowGlobalDevice: policies.every((policy) => policy.allowGlobalDevice),
		allowKnowledgeWrite: policies.every((policy) => policy.allowKnowledgeWrite),
	};
}

export function normalizeOAuthClientPolicy(
	policy: Record<string, unknown> | null | undefined,
): OAuthClientPolicy {
	const parsed = oauthClientPolicySchema.safeParse(policy ?? {});
	return parsed.success ? parsed.data : DEFAULT_OAUTH_CLIENT_POLICY;
}
