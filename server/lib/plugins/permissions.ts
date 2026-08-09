import { z } from "zod";

/**
 * There is no plugin trust tier.
 *
 * A `T0`–`T3` axis used to live here (`core-compiled` / `official-or-organization-trusted` /
 * `administrator-approved-third-party` / `unapproved-or-unknown`) and was removed as the
 * last piece of the "install is the trust decision" change recorded in
 * `docs/plugin-system/11-capability-policy.md`. It was the same species as the
 * `theme-only`/`frontend`/`backend` install tiers deleted in §3.6, but it sat in the state
 * store rather than the router, so it survived that pass.
 *
 * Why it could not work: one ordered axis encoded three uncorrelated things — provenance
 * (who signed it), isolation strength (process or container) and authorization breadth.
 * Isolation is decided by the manifest's `engine.runner`, breadth by
 * grants ∩ canonical adapter, and provenance by signature verification. Ranking them
 * T0<T1<T2<T3 made every tier a blend of all three.
 *
 * Two of the four tiers were also unreachable: core code is never installed as a plugin, and
 * `T1` needed a trust keyring that production never configures. The remaining pair was a
 * boolean ("admin approved" vs not) restating a decision the admin-only install route had
 * already made.
 *
 * The boundaries that actually hold are listed in `11-capability-policy.md` §4: admin-only
 * install, the canonical adapter gate, the grant list as live revocation state, the
 * manifest-declared runner, and the class-B liveness limits.
 */

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
		"event.subscribe",
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
		"command.narrator.send_subagent_message",
		"command.narrator.interrupt",
		"command.narrator.create",
		"command.narrator.delete",
		"command.narrator.spec_tasks_get",
		"command.narrator.spec_task_add",
		"command.permission.decide",
		"command.chapter.write",
		"command.chapter.merge",
		"command.review.write",
		"command.routine.write",
	],
	provider: ["provider.register", "provider.use", "provider.refresh_catalog"],
	/**
	 * Declarative only, like the rest of this taxonomy (see `capabilitySchema` below).
	 * `plugin-search-registry` does not call `capabilityBroker.authorize` before running a
	 * search, matching the provider execution path, which does not authorize either.
	 */
	search: ["search.provide"],
	config: ["config.read_self", "config.write_self"],
	secret: ["secret.use_self"],
	storage: ["storage.read_self", "storage.write_self", "storage.purge_self"],
	device: ["device.read", "device.command"],
	ui: ["ui.panel", "ui.notification", "ui.open_external", "ui.theme"],
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
	...CAPABILITY_TAXONOMY.search,
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
/**
 * Capability names are open strings, not a closed enum.
 *
 * This deliberately reverses the original design. A fixed 66-entry enum meant every new
 * integration point required editing the host before a plugin could even declare it, and
 * the taxonomy itself was speculative — `HIGH_RISK_CAPABILITIES` and
 * `DEFAULT_DENIED_CAPABILITIES` never acquired a single runtime consumer. VS Code, the most
 * widely used extension host, ships no permission system at all: an installed extension has
 * the full capability of its host process, with no manifest declaration and no gate.
 *
 * So `Capability` is now `string`. `CAPABILITY_TAXONOMY` and `CAPABILITIES` survive as
 * documentation of the *known* names (and for editor completion), not as an admission test.
 *
 * The format rule that remains is not a trust boundary: it keeps names loggable and
 * comparable, and rejects empty or control-character values that would corrupt audit
 * records. Wildcards and formerly "wide" tokens (`*`, `admin`, `network.any`,
 * `process.shell`) are accepted.
 */
export type Capability = string;
/**
 * Dot-separated segments, or a bare `*`.
 *
 * Segments start with a letter and may be camelCase, because the host's own taxonomy
 * already uses it (`diagnostics.readOwnLogs`, `ui.openExternal`). This rejects empty
 * strings, whitespace, and control characters so names stay loggable and comparable — it is
 * not a trust check.
 */
const CAPABILITY_NAME_PATTERN = /^(?:\*|[a-zA-Z][a-zA-Z0-9_]*(?:\.(?:\*|[a-zA-Z][a-zA-Z0-9_]*))*)$/;
export const capabilitySchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(CAPABILITY_NAME_PATTERN, "Capability must be dot-separated alphanumeric segments");
export const capabilityIdSchema = capabilitySchema;
export const capabilityListSchema = z
	.array(capabilitySchema)
	// Bounded only to keep a manifest from carrying an unbounded list into audit records.
	.max(512)
	.refine((capabilities) => new Set(capabilities).size === capabilities.length, {
		message: "Capabilities must be unique",
	});

/** The names the host itself knows about. Not a gate — see `capabilitySchema`. */
export const KNOWN_CAPABILITIES: readonly string[] = CAPABILITIES;

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

/**
 * Rewrite a Manifest-v1 alias to its modern name, else pass the value through.
 *
 * The alias table is consulted *first* now. When capability names were a closed enum,
 * checking canonical-first was equivalent — an alias could never also be canonical. With
 * open strings every well-formed alias would parse as-is, so canonical-first would silently
 * stop rewriting them and `query.chapters.read` would survive into grants alongside
 * `query.read.chapters` as two distinct capabilities.
 *
 * Returns `undefined` only for malformed names (empty, spaces, uppercase), never for
 * merely-unknown ones.
 */
export function normalizeCapabilityName(value: unknown): Capability | undefined {
	const legacy = legacyCapabilityNameSchema.safeParse(value);
	if (legacy.success) return LEGACY_CAPABILITY_ALIASES[legacy.data];
	const canonical = capabilitySchema.safeParse(value);
	return canonical.success ? canonical.data : undefined;
}

/**
 * Manifest-facing capability schema: normalizes known v1 aliases, accepts anything else
 * that is well-formed. Unknown names are no longer an error — see `capabilitySchema`.
 */
export const manifestCapabilitySchema = z.preprocess(
	(value) => normalizeCapabilityName(value) ?? value,
	capabilitySchema,
);
export const manifestCapabilityListSchema = z
	.array(manifestCapabilitySchema)
	.max(512)
	.refine((capabilities) => new Set(capabilities).size === capabilities.length, {
		message: "Capabilities must be unique after legacy alias normalization",
	});

/**
 * Formerly-rejected "wide" tokens, kept for documentation and diagnostics only.
 *
 * These used to fail Manifest validation outright. They no longer do: a plugin may declare
 * any capability it likes, because the host does not gate on declarations. The list remains
 * so an admin UI can still *highlight* a broad request, which is information rather than
 * enforcement.
 */
export const WIDE_PERMISSION_TOKENS = [
	"*",
	"all",
	"admin",
	"host.internal",
	"filesystem.full",
	"network.any",
	"process.shell",
] as const;

/**
 * Whether a capability name is broad.
 *
 * **No longer a rejection test.** Callers use it to annotate or sort; nothing refuses a
 * plugin because of it.
 */
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

/**
 * Nothing is denied by default.
 *
 * This was `HIGH_RISK_CAPABILITIES`, which would have made ten capabilities — including
 * `secret.use_self` and `network.egress.allowlist` — unusable unless separately granted. It
 * never had a runtime consumer, so the practical effect of keeping it was to leave a
 * deny-by-default seed for whoever wired it up next.
 *
 * `HIGH_RISK_CAPABILITIES` is retained above as a *labelling* aid for admin UIs.
 */
export const DEFAULT_DENIED_CAPABILITIES: readonly Capability[] = [];

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
export const permissionGrantListSchema = z.array(permissionGrantSchema).max(2_048);
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
		desiredState: desiredStateSchema,
		runtimeState: runtimeStateSchema,
		compatibilityState: compatibilityStateSchema,
	})
	.strict();
export type PluginLifecycleState = z.infer<typeof pluginLifecycleStateSchema>;

export const effectivePermissionSchema = z
	.object({
		pluginId: scopeIdSchema,
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
