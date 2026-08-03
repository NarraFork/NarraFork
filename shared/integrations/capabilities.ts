import { z } from "zod";
import { PRINCIPAL_TYPES, type PrincipalType, principalTypeSchema } from "./principals";

export const CAPABILITY_ACTIONS = ["read", "write", "execute", "manage"] as const;
export type CapabilityAction = (typeof CAPABILITY_ACTIONS)[number];
export const capabilityActionSchema = z.enum(CAPABILITY_ACTIONS);

export const CAPABILITY_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type CapabilityRiskLevel = (typeof CAPABILITY_RISK_LEVELS)[number];
export const capabilityRiskLevelSchema = z.enum(CAPABILITY_RISK_LEVELS);

export const CAPABILITY_REDACTION_POLICIES = [
	"none",
	"secrets",
	"sensitive",
	"content",
	"metadata_only",
] as const;
export type CapabilityRedactionPolicy = (typeof CAPABILITY_REDACTION_POLICIES)[number];
export const capabilityRedactionPolicySchema = z.enum(CAPABILITY_REDACTION_POLICIES);

export const CAPABILITY_RATE_CLASSES = [
	"unmetered",
	"interactive",
	"standard",
	"background",
] as const;
export type CapabilityRateClass = (typeof CAPABILITY_RATE_CLASSES)[number];
export const capabilityRateClassSchema = z.enum(CAPABILITY_RATE_CLASSES);

/**
 * Resource categories used by integration capability descriptions and bound scopes.
 * These are canonical categories, not replacements for existing OAuth scope or plugin
 * capability strings.
 */
export const CAPABILITY_RESOURCE_TYPES = [
	"user",
	"session",
	"integration",
	"project",
	"workspace",
	"chapter",
	"narrator",
	"message",
	"review",
	"routine",
	"provider",
	"device",
	"permission",
	"audit",
	"settings",
	"event",
	"config",
	"secret",
	"storage",
	"ui",
	"network",
	"filesystem",
	"process",
	"schedule",
	"diagnostics",
] as const;
export type CapabilityResourceType = (typeof CAPABILITY_RESOURCE_TYPES)[number];
export const capabilityResourceTypeSchema = z.enum(CAPABILITY_RESOURCE_TYPES);

export const capabilityIdSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, "Invalid canonical capability id");

export const canonicalCapabilityDescriptorSchema = z
	.object({
		id: capabilityIdSchema,
		resourceType: capabilityResourceTypeSchema,
		action: capabilityActionSchema,
		riskLevel: capabilityRiskLevelSchema,
		persistentResource: z.boolean(),
		remoteExecution: z.boolean(),
		allowedSubjects: z
			.array(principalTypeSchema)
			.min(1)
			.max(PRINCIPAL_TYPES.length)
			.refine(
				(subjects) => new Set(subjects).size === subjects.length,
				"Allowed subjects must be unique",
			),
		defaultRedaction: capabilityRedactionPolicySchema,
		defaultRateClass: capabilityRateClassSchema,
		i18nKey: z
			.string()
			.min(1)
			.max(200)
			.regex(/^integrations\.capabilities\.[a-z0-9._-]+$/),
	})
	.strict()
	.superRefine((descriptor, context) => {
		if (descriptor.remoteExecution && !["execute", "manage"].includes(descriptor.action)) {
			context.addIssue({
				code: "custom",
				path: ["remoteExecution"],
				message: "Remote execution requires an execute or manage action",
			});
		}
	});
export type CanonicalCapabilityDescriptor = z.infer<typeof canonicalCapabilityDescriptorSchema>;

export interface CapabilityExecutionMetadata {
	allowedSubjects?: readonly PrincipalType[];
	defaultRedaction?: CapabilityRedactionPolicy;
	defaultRateClass?: CapabilityRateClass;
}

function defaultRedactionForRisk(riskLevel: CapabilityRiskLevel): CapabilityRedactionPolicy {
	if (riskLevel === "critical") return "content";
	if (riskLevel === "high") return "sensitive";
	if (riskLevel === "medium") return "secrets";
	return "none";
}

function defaultRateClassForAction(action: CapabilityAction): CapabilityRateClass {
	if (action === "execute") return "interactive";
	if (action === "read") return "standard";
	return "background";
}

function capability(
	id: string,
	resourceType: CapabilityResourceType,
	action: CapabilityAction,
	riskLevel: CapabilityRiskLevel,
	persistentResource: boolean,
	remoteExecution = false,
	metadata: CapabilityExecutionMetadata = {},
): CanonicalCapabilityDescriptor {
	return canonicalCapabilityDescriptorSchema.parse({
		id,
		resourceType,
		action,
		riskLevel,
		persistentResource,
		remoteExecution,
		allowedSubjects: metadata.allowedSubjects ?? PRINCIPAL_TYPES,
		defaultRedaction: metadata.defaultRedaction ?? defaultRedactionForRisk(riskLevel),
		defaultRateClass: metadata.defaultRateClass ?? defaultRateClassForAction(action),
		i18nKey: `integrations.capabilities.${id}`,
	});
}

/**
 * Canonical integration capability catalog. Existing protocol strings are mapped to
 * these descriptors by server-side adapters instead of being renamed or parsed.
 */
export const CANONICAL_CAPABILITY_DESCRIPTORS = {
	"integration.install": capability(
		"integration.install",
		"integration",
		"manage",
		"critical",
		true,
	),
	"integration.enable": capability("integration.enable", "integration", "manage", "high", true),
	"integration.disable": capability("integration.disable", "integration", "manage", "high", true),
	"integration.upgrade": capability(
		"integration.upgrade",
		"integration",
		"manage",
		"critical",
		true,
	),
	"integration.uninstall": capability(
		"integration.uninstall",
		"integration",
		"manage",
		"critical",
		true,
	),
	"integration.grant": capability("integration.grant", "permission", "manage", "critical", true),
	"project.read": capability("project.read", "project", "read", "low", true),
	"chapter.read": capability("chapter.read", "chapter", "read", "low", true),
	"chapter.write": capability("chapter.write", "chapter", "write", "high", true),
	"chapter.merge": capability("chapter.merge", "chapter", "manage", "critical", true),
	"narrator.read": capability("narrator.read", "narrator", "read", "low", true),
	"narrator.subscribe": capability("narrator.subscribe", "narrator", "read", "medium", true),
	"narrator.provision": capability("narrator.provision", "narrator", "manage", "high", true),
	"narrator.send_message": capability(
		"narrator.send_message",
		"narrator",
		"execute",
		"high",
		true,
		true,
	),
	"narrator.interrupt": capability(
		"narrator.interrupt",
		"narrator",
		"execute",
		"medium",
		true,
		true,
	),
	"narrator.execute": capability("narrator.execute", "narrator", "execute", "critical", true, true),
	"message.summary.read": capability("message.summary.read", "message", "read", "medium", true),
	"message.content.read": capability("message.content.read", "message", "read", "high", true),
	"audit.self.read": capability("audit.self.read", "audit", "read", "medium", true),
	"audit.all.read": capability("audit.all.read", "audit", "read", "critical", true),
	"settings.read": capability("settings.read", "settings", "read", "high", true),
	"event.subscribe": capability("event.subscribe", "event", "read", "medium", false, false, {
		defaultRedaction: "sensitive",
		defaultRateClass: "standard",
	}),
	"event.chapter.subscribe": capability("event.chapter.subscribe", "event", "read", "low", false),
	"event.narrator.subscribe": capability(
		"event.narrator.subscribe",
		"event",
		"read",
		"medium",
		false,
	),
	"event.permission.subscribe": capability(
		"event.permission.subscribe",
		"event",
		"read",
		"high",
		false,
	),
	"event.provider.subscribe": capability(
		"event.provider.subscribe",
		"event",
		"read",
		"medium",
		false,
	),
	"event.project.subscribe": capability("event.project.subscribe", "event", "read", "low", false),
	"event.integration.subscribe": capability(
		"event.integration.subscribe",
		"event",
		"read",
		"medium",
		false,
	),
	"event.device.subscribe": capability("event.device.subscribe", "event", "read", "medium", false),
	"event.public.subscribe": capability("event.public.subscribe", "event", "read", "low", false),
	"permission.decide": capability("permission.decide", "permission", "manage", "critical", true),
	"review.write": capability("review.write", "review", "write", "high", true),
	"routine.write": capability("routine.write", "routine", "write", "high", true),
	"provider.register": capability("provider.register", "provider", "manage", "high", true),
	"provider.use": capability("provider.use", "provider", "execute", "high", true, true),
	"provider.refresh_catalog": capability(
		"provider.refresh_catalog",
		"provider",
		"execute",
		"medium",
		true,
	),
	/**
	 * Serving web search from a plugin's `contributes.searchProviders`.
	 *
	 * Separate from `provider.use` even though a search source reads a provider's
	 * credentials: the plugin adapter must stay one-to-one reversible, so the two protocol
	 * strings cannot share a descriptor. Risk sits below `provider.use` because a search call
	 * carries a query rather than conversation history.
	 */
	"provider.search": capability("provider.search", "provider", "execute", "medium", true, true),
	"config.read": capability("config.read", "config", "read", "low", true),
	"config.write": capability("config.write", "config", "write", "medium", true),
	"secret.use": capability("secret.use", "secret", "execute", "critical", true),
	"storage.read": capability("storage.read", "storage", "read", "low", true),
	"storage.write": capability("storage.write", "storage", "write", "medium", true),
	"storage.purge": capability("storage.purge", "storage", "manage", "high", true),
	"device.read": capability("device.read", "device", "read", "medium", true),
	"device.manage": capability("device.manage", "device", "manage", "critical", true, true),
	"device.provision": capability("device.provision", "device", "manage", "high", true),
	"device.rotate": capability("device.rotate", "device", "manage", "high", true),
	"device.execute": capability("device.execute", "device", "execute", "critical", true, true),
	"ui.panel": capability("ui.panel", "ui", "execute", "low", false),
	"ui.notification": capability("ui.notification", "ui", "execute", "low", false),
	"ui.open_external": capability("ui.open_external", "ui", "execute", "medium", false),
	"ui.theme": capability("ui.theme", "ui", "execute", "medium", false),
	"network.egress": capability("network.egress", "network", "execute", "high", false),
	"filesystem.workspace.read": capability(
		"filesystem.workspace.read",
		"filesystem",
		"read",
		"medium",
		true,
	),
	"filesystem.workspace.write": capability(
		"filesystem.workspace.write",
		"filesystem",
		"write",
		"high",
		true,
	),
	"process.spawn": capability("process.spawn", "process", "execute", "critical", false, true),
	"schedule.register": capability("schedule.register", "schedule", "manage", "high", true),
	"diagnostics.read": capability("diagnostics.read", "diagnostics", "read", "medium", false),
} as const;

export type CanonicalCapabilityId = keyof typeof CANONICAL_CAPABILITY_DESCRIPTORS;

export function getCanonicalCapabilityDescriptor(
	id: CanonicalCapabilityId,
): CanonicalCapabilityDescriptor {
	return CANONICAL_CAPABILITY_DESCRIPTORS[id];
}
