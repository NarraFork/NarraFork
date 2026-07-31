import { z } from "zod";

/**
 * Permission modes an external OAuth narrator may run under, ordered elsewhere from
 * strictest to most permissive (see OAUTH_PERMISSION_MODE_ORDER).
 *
 * "bypassPermissions" does not mean "unchecked": interactive approval is impossible for a
 * headless external client, so instead of denying every operation that would need
 * confirmation, the narrator falls back to the danger reflection loop
 * (see narrator-permission.ts). Catastrophic commands are still refused outright, and
 * deviceAccess remains an independent per-device ceiling.
 */
export const oauthExternalPermissionModeSchema = z.enum([
	"readOnly",
	"dontAsk",
	"bypassPermissions",
]);
export const OAUTH_NARRATOR_MAX_DEVICES = 16;
/** Ceiling for a client-supplied danger reflection appendix. */
export const OAUTH_MAX_DANGER_REFLECTION_PROMPT_CHARS = 4_000;

/**
 * The maximum operation level an OAuth client may reach on a device belonging to a
 * given access group. "denied" blocks Bash/Write/Edit entirely; "readOnly" allows only
 * operations the risk engine classifies as non-mutating (see resolveReadOnlyShellDecision
 * in narrator-permission.ts — the same directory/command allow-list machinery used
 * elsewhere, not a separate ad-hoc check); "readWrite" allows mutating operations subject
 * to the existing directory/command deny-lists and catastrophic-command detection.
 */
export const deviceOperationLevelSchema = z.enum(["denied", "readOnly", "readWrite"]);
export type DeviceOperationLevel = z.infer<typeof deviceOperationLevelSchema>;

const DEVICE_OPERATION_LEVEL_ORDER: readonly DeviceOperationLevel[] = [
	"denied",
	"readOnly",
	"readWrite",
];

/** The stricter (lower-privilege) of two device operation levels. */
export function stricterDeviceLevel(
	a: DeviceOperationLevel,
	b: DeviceOperationLevel,
): DeviceOperationLevel {
	return DEVICE_OPERATION_LEVEL_ORDER.indexOf(a) <= DEVICE_OPERATION_LEVEL_ORDER.indexOf(b) ? a : b;
}

/**
 * Device access is scoped to three fixed groups instead of one flat capability. Group
 * membership is a dynamic property of (deviceId, requesting grant) resolved at runtime by
 * classifyDeviceAccessGroup in narrator-permission.ts — it is never stored as a static
 * column on the device row, since the same device can belong to a different group
 * depending on which OAuth client is asking (e.g. a global device is "selfRegistered" for
 * the client that provisioned it, but merely "global" for another client that only has it
 * bound into a narrator's deviceIds).
 *
 * - host: the NarraFork server itself. Defaults to "denied"; an administrator may
 *   explicitly widen it per OAuth client. This directly drives allowLocalExecution in
 *   oauth-narrator-runtime-policy.ts.
 * - global: any device with scope "global" that this client did not itself register.
 * - selfRegistered: a device this OAuth client provisioned and owns via
 *   integration_resource_bindings. Device ownership is already the trust boundary, so
 *   this — like global — defaults to open.
 *
 * There is no separate "bound but not owned" group: requireOwnedExternalDevice
 * (oauth-resource-access.ts) unconditionally requires a device's
 * integration_resource_bindings.sourceId to equal the requesting client's own id before it
 * may be bound into that client's narrator deviceIds at all — External API v1 has no path
 * for a client to bind a device it does not own. Every device reachable from a narrator is
 * therefore always either "global" (scope=global, not self-provisioned) or
 * "selfRegistered" (self-provisioned, of either scope).
 */
export const deviceAccessPolicySchema = z
	.object({
		host: deviceOperationLevelSchema.default("denied"),
		global: deviceOperationLevelSchema.default("readWrite"),
		selfRegistered: deviceOperationLevelSchema.default("readWrite"),
	})
	.strict();
export type DeviceAccessPolicy = z.infer<typeof deviceAccessPolicySchema>;

/**
 * Concrete default device access policy. Note: passing a bare `{}` literal to
 * `.default()` would bypass deviceAccessPolicySchema's own per-field defaults (Zod does
 * not re-parse a `.default()` value through the schema), so this fully-resolved object is
 * used as the default instead of relying on nested defaulting.
 */
const DEFAULT_DEVICE_ACCESS_POLICY: DeviceAccessPolicy = deviceAccessPolicySchema.parse({});

const oauthClientPolicyShape = {
	defaultPermissionMode: oauthExternalPermissionModeSchema,
	allowedPermissionModes: z
		.array(oauthExternalPermissionModeSchema)
		.min(1)
		.max(oauthExternalPermissionModeSchema.options.length),
	systemPromptMode: z.enum(["managed", "append"]),
	maxSystemPromptChars: z.number().int().min(0).max(10_000),
	allowGlobalDevice: z.boolean(),
	allowKnowledgeWrite: z.boolean(),
	/**
	 * Whether this client may supply a danger reflection appendix at provision time.
	 * Mirrors the systemPrompt pair: a capability switch plus a length ceiling, both
	 * closed by default so an administrator must opt in per client.
	 */
	allowDangerReflectionPrompt: z.boolean(),
	maxDangerReflectionPromptChars: z
		.number()
		.int()
		.min(0)
		.max(OAUTH_MAX_DANGER_REFLECTION_PROMPT_CHARS),
	/**
	 * Merge the server-defined robot diagnostic read-only preset into this client's allow-list
	 * (see lib/robot-diagnostic-policy.ts). It keeps routine inspection commands out of the
	 * danger reflection loop so field diagnostics are not delayed one LLM turn per command.
	 * The preset only ever grants read; its contents are fixed in server code, so enabling
	 * this does not let the client define its own patterns.
	 */
	allowRobotDiagnosticPreset: z.boolean(),
	deviceAccess: deviceAccessPolicySchema,
};

const LEGACY_REMOTE_DEVICE_KEYS = [
	"allowRemoteShell",
	"remoteShellLevel",
	"allowRemoteFileWrite",
] as const;

/**
 * Migrates the pre-device-group fields (allowRemoteShell/remoteShellLevel/
 * allowRemoteFileWrite) into the new deviceAccess structure. The legacy model never
 * distinguished device provenance, so both configurable groups (global/selfRegistered)
 * inherit the same merged level — under the old model these device classes shared a
 * single capability ceiling. The host group is never touched by legacy fields and always
 * falls through to its schema default ("denied"): the old model never permitted local
 * execution either.
 *
 * Merge algorithm: shell capability (allowRemoteShell + remoteShellLevel) and file-write
 * capability (allowRemoteFileWrite) were two independent dimensions under the old model;
 * merging them into one level takes the stricter of the two, so the migrated effective
 * permission never exceeds what was granted before (the safety ceiling may only shrink).
 *
 * This runs as a z.preprocess step on oauthClientPolicySchema itself, so every consumer —
 * oauth_clients.policyJson, integration_authorities.policyJson, and the nested
 * narrator.oauthPolicySnapshotJson.policy (which embeds this same schema) — is migrated
 * transparently without any call site needing to remember to migrate first.
 */
function migrateLegacyDeviceAccessFields(input: unknown): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
	const obj = input as Record<string, unknown>;
	const hasLegacyKeys = LEGACY_REMOTE_DEVICE_KEYS.some((key) => key in obj);
	if (!hasLegacyKeys) return input;

	const { allowRemoteShell, remoteShellLevel, allowRemoteFileWrite, ...rest } = obj;
	const shellLevel: DeviceOperationLevel =
		allowRemoteShell === false
			? "denied"
			: remoteShellLevel === "readOnly"
				? "readOnly"
				: "readWrite";
	const fileLevel: DeviceOperationLevel = allowRemoteFileWrite === false ? "denied" : "readWrite";
	const mergedLevel = stricterDeviceLevel(shellLevel, fileLevel);

	return {
		...rest,
		deviceAccess: {
			global: mergedLevel,
			selfRegistered: mergedLevel,
		},
	};
}

export const oauthClientPolicySchema = z.preprocess(
	migrateLegacyDeviceAccessFields,
	z
		.object({
			defaultPermissionMode: oauthClientPolicyShape.defaultPermissionMode.default("readOnly"),
			allowedPermissionModes: oauthClientPolicyShape.allowedPermissionModes.default(["readOnly"]),
			systemPromptMode: oauthClientPolicyShape.systemPromptMode.default("managed"),
			maxSystemPromptChars: oauthClientPolicyShape.maxSystemPromptChars.default(0),
			allowGlobalDevice: oauthClientPolicyShape.allowGlobalDevice.default(false),
			allowKnowledgeWrite: oauthClientPolicyShape.allowKnowledgeWrite.default(false),
			allowDangerReflectionPrompt:
				oauthClientPolicyShape.allowDangerReflectionPrompt.default(false),
			maxDangerReflectionPromptChars:
				oauthClientPolicyShape.maxDangerReflectionPromptChars.default(0),
			allowRobotDiagnosticPreset: oauthClientPolicyShape.allowRobotDiagnosticPreset.default(false),
			deviceAccess: oauthClientPolicyShape.deviceAccess.default(DEFAULT_DEVICE_ACCESS_POLICY),
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
		}),
);

export const oauthClientPolicyPatchSchema = z.object(oauthClientPolicyShape).partial().strict();

export type OAuthClientPolicy = z.infer<typeof oauthClientPolicySchema>;
export type OAuthExternalPermissionMode = z.infer<typeof oauthExternalPermissionModeSchema>;

/**
 * Immutable runtime ceiling captured when an OAuth narrator is provisioned.
 *
 * version 2 bound the narrator to a required project. version 3 removes the
 * project anchor: the OAuth grant ownership (integration_resource_bindings) is
 * the sole isolation boundary, so projectId is null/absent. Both versions parse
 * for backward compatibility with narrators provisioned before de-projectization.
 */
export const oauthNarratorProvisionSnapshotSchema = z
	.object({
		version: z.union([z.literal(2), z.literal(3)]),
		policy: oauthClientPolicySchema,
		permissionMode: oauthExternalPermissionModeSchema,
		systemPrompt: z.string().max(10_000).nullable(),
		/**
		 * Client-supplied appendix for the danger reflection prompt. Optional rather than
		 * version-gated: snapshots frozen before this field existed simply carry no value,
		 * so both version 2 and 3 snapshots keep parsing unchanged.
		 */
		dangerReflectionPrompt: z
			.string()
			.max(OAUTH_MAX_DANGER_REFLECTION_PROMPT_CHARS)
			.nullable()
			.optional(),
		projectId: z.string().min(1).nullable().optional(),
		defaultDeviceId: z.string().min(1),
		deviceIds: z.array(z.string().min(1)).min(1).max(OAUTH_NARRATOR_MAX_DEVICES),
	})
	.strict()
	.superRefine((snapshot, ctx) => {
		if (new Set(snapshot.deviceIds).size !== snapshot.deviceIds.length) {
			ctx.addIssue({
				code: "custom",
				path: ["deviceIds"],
				message: "deviceIds must not contain duplicates",
			});
		}
		if (!snapshot.deviceIds.includes(snapshot.defaultDeviceId)) {
			ctx.addIssue({
				code: "custom",
				path: ["defaultDeviceId"],
				message: "deviceIds must include defaultDeviceId",
			});
		}
		if (snapshot.version === 2 && !snapshot.projectId) {
			ctx.addIssue({
				code: "custom",
				path: ["projectId"],
				message: "version 2 snapshots require a projectId",
			});
		}
		if (snapshot.version === 3 && snapshot.projectId) {
			ctx.addIssue({
				code: "custom",
				path: ["projectId"],
				message: "version 3 snapshots must not bind a projectId",
			});
		}
	});

export type OAuthNarratorProvisionSnapshot = z.infer<typeof oauthNarratorProvisionSnapshotSchema>;

export const DEFAULT_OAUTH_CLIENT_POLICY: OAuthClientPolicy = oauthClientPolicySchema.parse({});

/**
 * Strictest to most permissive. Consumers rely on this ordering to pick the most
 * restrictive surviving mode after an intersection, so new modes must be appended
 * according to how much they widen the runtime, never inserted arbitrarily.
 */
const OAUTH_PERMISSION_MODE_ORDER: readonly OAuthExternalPermissionMode[] = [
	"dontAsk",
	"readOnly",
	"bypassPermissions",
];

const DEVICE_ACCESS_GROUPS = ["host", "global", "selfRegistered"] as const;

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
	const deviceAccess = Object.fromEntries(
		DEVICE_ACCESS_GROUPS.map((group) => [
			group,
			policies.reduce(
				(acc, policy) => stricterDeviceLevel(acc, policy.deviceAccess[group]),
				"readWrite" as DeviceOperationLevel,
			),
		]),
	) as DeviceAccessPolicy;
	return {
		defaultPermissionMode,
		allowedPermissionModes,
		systemPromptMode: policies.every((policy) => policy.systemPromptMode === "append")
			? "append"
			: "managed",
		maxSystemPromptChars: Math.min(...policies.map((policy) => policy.maxSystemPromptChars)),
		allowGlobalDevice: policies.every((policy) => policy.allowGlobalDevice),
		allowKnowledgeWrite: policies.every((policy) => policy.allowKnowledgeWrite),
		allowDangerReflectionPrompt: policies.every((policy) => policy.allowDangerReflectionPrompt),
		maxDangerReflectionPromptChars: Math.min(
			...policies.map((policy) => policy.maxDangerReflectionPromptChars),
		),
		allowRobotDiagnosticPreset: policies.every((policy) => policy.allowRobotDiagnosticPreset),
		deviceAccess,
	};
}

export function normalizeOAuthClientPolicy(
	policy: Record<string, unknown> | null | undefined,
): OAuthClientPolicy {
	const parsed = oauthClientPolicySchema.safeParse(policy ?? {});
	return parsed.success ? parsed.data : DEFAULT_OAUTH_CLIENT_POLICY;
}
