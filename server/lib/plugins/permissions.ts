import { z } from "zod";

export const TRUST_TIERS = ["T0", "T1", "T2", "T3"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];
export const trustTierSchema = z.enum(TRUST_TIERS);
export const pluginTrustTierSchema = trustTierSchema;
export const TRUST_TIER_DESCRIPTIONS = {
	T0: "core-compiled",
	T1: "official-or-organization-trusted",
	T2: "administrator-approved-third-party",
	T3: "unapproved-or-unknown",
} as const satisfies Record<TrustTier, string>;

export const DESIRED_STATES = ["disabled", "enabled", "uninstalling"] as const;
export type DesiredState = (typeof DESIRED_STATES)[number];
export const desiredStateSchema = z.enum(DESIRED_STATES);
export const pluginDesiredStateSchema = desiredStateSchema;

export const RUNTIME_STATES = [
	"inactive",
	"starting",
	"handshaking",
	"activating",
	"active",
	"degraded",
	"draining",
	"deactivating",
	"stopped",
	"crashed",
	"backoff",
	"failed",
	"quarantine",
] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number];
export const runtimeStateSchema = z.enum(RUNTIME_STATES);
export const pluginRuntimeStateSchema = runtimeStateSchema;

export const COMPATIBILITY_STATES = ["unknown", "compatible", "incompatible"] as const;
export type CompatibilityState = (typeof COMPATIBILITY_STATES)[number];
export const compatibilityStateSchema = z.enum(COMPATIBILITY_STATES);

/** Storage includes a session scope; permission grants additionally use global and provider scopes. */
export const SCOPE_TYPES = [
	"global",
	"session",
	"user",
	"project",
	"workspace",
	"chapter",
	"narrator",
	"provider",
	"device",
] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];
export const scopeTypeSchema = z.enum(SCOPE_TYPES);
export const permissionScopeTypeSchema = scopeTypeSchema;

export const INVOCATION_SCOPE_TYPES = [
	"global",
	"user",
	"project",
	"workspace",
	"chapter",
	"narrator",
	"provider",
	"device",
] as const;
export type InvocationScopeType = (typeof INVOCATION_SCOPE_TYPES)[number];
export const invocationScopeTypeSchema = z.enum(INVOCATION_SCOPE_TYPES);

const scopeIdSchema = z.string().trim().min(1).max(128);
const scopeIdsSchema = z.array(scopeIdSchema).min(1).max(20);

export type PermissionScope = {
	type: ScopeType;
	id?: string;
};

export const permissionScopeSchema = z
	.object({
		type: scopeTypeSchema,
		id: scopeIdSchema.optional(),
	})
	.strict()
	.superRefine((scope, context) => {
		if (scope.type === "global" && scope.id !== undefined) {
			context.addIssue({
				code: "custom",
				path: ["id"],
				message: "Global scope cannot carry an id",
			});
		}
		if (scope.type !== "global" && scope.id === undefined) {
			context.addIssue({
				code: "custom",
				path: ["id"],
				message: "Scoped permissions require a scope id",
			});
		}
	});

export type InvocationScope = {
	userId?: string;
	projectId?: string;
	chapterId?: string;
	workspaceId?: string;
	narratorId?: string;
	deviceId?: string;
	providerInstanceId?: string;
};

export const invocationScopeSchema = z
	.object({
		userId: scopeIdSchema.optional(),
		projectId: scopeIdSchema.optional(),
		chapterId: scopeIdSchema.optional(),
		workspaceId: scopeIdSchema.optional(),
		narratorId: scopeIdSchema.optional(),
		deviceId: scopeIdSchema.optional(),
		providerInstanceId: scopeIdSchema.optional(),
	})
	.strict();

/**
 * Canonical capability taxonomy. This object is the single source used to derive
 * CAPABILITIES, Manifest validation and grant schemas.
 */
export const CAPABILITY_TAXONOMY = {
	plugin: [
		"plugin.install",
		"plugin.enable",
		"plugin.disable",
		"plugin.upgrade",
		"plugin.uninstall",
		"plugin.grant",
	],
	query: [
		"query.read.projects",
		"query.read.chapters",
		"query.read.narrators",
		"query.read.message_summary",
		"query.read.message_content",
		"query.read.audit_self",
		"query.read.audit_all",
		"query.read.host_settings",
	],
	event: [
		"event.subscribe.chapter",
		"event.subscribe.narrator",
		"event.subscribe.permission",
		"event.subscribe.provider",
		"event.subscribe.project",
		"event.subscribe.plugin",
		"event.subscribe.device",
		"event.subscribe.public",
	],
	command: [
		"command.narrator.send_message",
		"command.narrator.interrupt",
		"command.permission.decide",
		"command.chapter.write",
		"command.chapter.merge",
		"command.review.write",
		"command.routine.write",
	],
	provider: ["provider.register", "provider.use", "provider.refresh_catalog"],
	config: ["config.read_self", "config.write_self"],
	secret: ["secret.use_self"],
	storage: ["storage.read_self", "storage.write_self", "storage.purge_self"],
	device: ["device.read", "device.command"],
	ui: ["ui.panel", "ui.notification", "ui.open_external"],
	network: ["network.egress.allowlist"],
	filesystem: ["filesystem.workspace.read", "filesystem.workspace.write"],
	process: ["process.spawn.allowlist"],
	schedule: ["schedule.register"],
	diagnostics: ["diagnostics.readOwnLogs"],
} as const;

/** Explicit allowlist; wildcard/admin/internal capabilities are intentionally absent. */
export const CAPABILITIES = [
	...CAPABILITY_TAXONOMY.plugin,
	...CAPABILITY_TAXONOMY.query,
	...CAPABILITY_TAXONOMY.event,
	...CAPABILITY_TAXONOMY.command,
	...CAPABILITY_TAXONOMY.provider,
	...CAPABILITY_TAXONOMY.config,
	...CAPABILITY_TAXONOMY.secret,
	...CAPABILITY_TAXONOMY.storage,
	...CAPABILITY_TAXONOMY.device,
	...CAPABILITY_TAXONOMY.ui,
	...CAPABILITY_TAXONOMY.network,
	...CAPABILITY_TAXONOMY.filesystem,
	...CAPABILITY_TAXONOMY.process,
	...CAPABILITY_TAXONOMY.schedule,
	...CAPABILITY_TAXONOMY.diagnostics,
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const capabilitySchema = z.enum(CAPABILITIES);
export const capabilityIdSchema = capabilitySchema;
export const capabilityListSchema = z
	.array(capabilitySchema)
	.max(CAPABILITIES.length)
	.refine((capabilities) => new Set(capabilities).size === capabilities.length, {
		message: "Capabilities must be unique",
	});

/**
 * Manifest-v1 compatibility aliases found in the original examples and design
 * documents. They are accepted only at explicit read boundaries and are never
 * emitted or accepted by capabilitySchema/grant authorization.
 */
export const LEGACY_CAPABILITY_ALIASES = {
	"query.chapters.read": "query.read.chapters",
	"query.projects.read": "query.read.projects",
	"command.chapters.read": "query.read.chapters",
	"command.chapters.create": "command.chapter.write",
	"command.reviews.create": "command.review.write",
	"event.subscribe.chapter.changed": "event.subscribe.chapter",
	"storage.workspace.read": "storage.read_self",
	"storage.workspace.write": "storage.write_self",
	"provider.models.read": "provider.register",
	"provider.sessions.create": "provider.use",
	"ui.openExternal": "ui.open_external",
} as const satisfies Record<string, Capability>;
export type LegacyCapabilityName = keyof typeof LEGACY_CAPABILITY_ALIASES;
export const LEGACY_CAPABILITY_ALIAS_POLICY = {
	status: "deprecated",
	acceptedAt: "manifest-v1-read-boundary",
	emitted: false,
	removeInManifestSchemaVersion: 2,
} as const;

const legacyCapabilityNames = Object.keys(LEGACY_CAPABILITY_ALIASES) as [
	LegacyCapabilityName,
	...LegacyCapabilityName[],
];
export const legacyCapabilityNameSchema = z.enum(legacyCapabilityNames);

/** Resolve a canonical or explicitly supported legacy name without widening unknown input. */
export function normalizeCapabilityName(value: unknown): Capability | undefined {
	const canonical = capabilitySchema.safeParse(value);
	if (canonical.success) return canonical.data;
	const legacy = legacyCapabilityNameSchema.safeParse(value);
	return legacy.success ? LEGACY_CAPABILITY_ALIASES[legacy.data] : undefined;
}

/**
 * Deprecated Manifest-v1 adapter. Its JSON/output contract is still the
 * authoritative canonical enum; preprocessing only preserves known old names.
 */
export const manifestCapabilitySchema = z.preprocess(
	(value) => normalizeCapabilityName(value) ?? value,
	capabilitySchema,
);
export const manifestCapabilityListSchema = z
	.array(manifestCapabilitySchema)
	.max(CAPABILITIES.length)
	.refine((capabilities) => new Set(capabilities).size === capabilities.length, {
		message: "Capabilities must be unique after legacy alias normalization",
	});

export const WIDE_PERMISSION_TOKENS = [
	"*",
	"all",
	"admin",
	"host.internal",
	"filesystem.full",
	"network.any",
	"process.shell",
] as const;

export function isWidePermission(permission: string): boolean {
	return (
		(WIDE_PERMISSION_TOKENS as readonly string[]).includes(permission) || permission.endsWith(".*")
	);
}

export const HIGH_RISK_CAPABILITIES = [
	"query.read.message_content",
	"query.read.audit_all",
	"command.permission.decide",
	"command.chapter.merge",
	"command.chapter.write",
	"secret.use_self",
	"device.command",
	"filesystem.workspace.write",
	"network.egress.allowlist",
	"process.spawn.allowlist",
] as const satisfies readonly Capability[];

export const DEFAULT_DENIED_CAPABILITIES = HIGH_RISK_CAPABILITIES;

export const permissionConstraintsSchema = z
	.object({
		topics: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
		resourceIds: scopeIdsSchema.optional(),
		fields: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
		methods: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
		paths: z.array(z.string().trim().min(1).max(4_096)).max(50).optional(),
		providerInstanceIds: scopeIdsSchema.optional(),
		maxRatePerSecond: z.number().finite().positive().max(10_000).optional(),
		maxBytes: z
			.number()
			.int()
			.positive()
			.max(64 * 1024 * 1024)
			.optional(),
	})
	.strict();

export type PermissionConstraints = z.infer<typeof permissionConstraintsSchema>;

export const permissionGrantSchema = z
	.object({
		capability: capabilitySchema,
		scope: permissionScopeSchema,
		constraints: permissionConstraintsSchema.optional(),
		expiresAt: z.string().datetime({ offset: true }).optional(),
		grantId: scopeIdSchema.optional(),
		grantedBy: scopeIdSchema.optional(),
	})
	.strict();
export const permissionGrantListSchema = z
	.array(permissionGrantSchema)
	.max(CAPABILITIES.length * 4);
export type PermissionGrant = z.infer<typeof permissionGrantSchema>;

export const PERMISSION_SOURCES = [
	"manifestRequested",
	"installationGrants",
	"hostPolicy",
	"currentUserAuthority",
	"currentInvocationScope",
	"contributionPolicy",
	"runnerEnforcement",
] as const;
export type PermissionSource = (typeof PERMISSION_SOURCES)[number];
export const permissionSourceSchema = z.enum(PERMISSION_SOURCES);

export const pluginLifecycleStateSchema = z
	.object({
		trustTier: trustTierSchema,
		desiredState: desiredStateSchema,
		runtimeState: runtimeStateSchema,
		compatibilityState: compatibilityStateSchema,
	})
	.strict();
export type PluginLifecycleState = z.infer<typeof pluginLifecycleStateSchema>;

export const effectivePermissionSchema = z
	.object({
		pluginId: scopeIdSchema,
		trustTier: trustTierSchema,
		desiredState: desiredStateSchema,
		runtimeState: runtimeStateSchema,
		compatibilityState: compatibilityStateSchema,
		manifestRequested: capabilityListSchema,
		installationGrants: permissionGrantListSchema,
		hostPolicy: capabilityListSchema,
		currentUserAuthority: capabilityListSchema,
		currentInvocationScope: invocationScopeSchema,
		contributionPolicy: capabilityListSchema,
		runnerEnforcement: capabilityListSchema,
		effectiveCapabilities: capabilityListSchema,
		grantRevision: z.number().int().positive().optional(),
		evaluatedAt: z.string().datetime({ offset: true }),
	})
	.strict()
	.superRefine((permission, context) => {
		const allowedByGrants = new Set(permission.installationGrants.map((grant) => grant.capability));
		const intersections = [
			permission.manifestRequested,
			permission.hostPolicy,
			permission.currentUserAuthority,
			permission.contributionPolicy,
			permission.runnerEnforcement,
		];
		const allowedByAllSources = (capability: Capability) =>
			allowedByGrants.has(capability) &&
			intersections.every((source) => source.includes(capability));

		for (const [index, capability] of permission.effectiveCapabilities.entries()) {
			if (!allowedByAllSources(capability)) {
				context.addIssue({
					code: "custom",
					path: ["effectiveCapabilities", index],
					message: "Effective capability is not present in every permission intersection",
				});
			}
		}
		if (permission.desiredState !== "enabled" && permission.effectiveCapabilities.length > 0) {
			context.addIssue({
				code: "custom",
				path: ["effectiveCapabilities"],
				message: "Disabled or uninstalling plugins cannot have effective capabilities",
			});
		}
		if (
			["failed", "crashed", "quarantine"].includes(permission.runtimeState) &&
			permission.effectiveCapabilities.length > 0
		) {
			context.addIssue({
				code: "custom",
				path: ["effectiveCapabilities"],
				message: "Failed or quarantined runtimes cannot have effective capabilities",
			});
		}
	});

export type EffectivePermission = z.infer<typeof effectivePermissionSchema>;
export type EffectivePermissions = EffectivePermission;
export const effectivePermissionsSchema = effectivePermissionSchema;
export const effectivePermissionSetSchema = effectivePermissionSchema;
