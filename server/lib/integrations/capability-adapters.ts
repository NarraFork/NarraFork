import {
	type CanonicalCapabilityDescriptor,
	type CanonicalCapabilityId,
	getCanonicalCapabilityDescriptor,
} from "@shared/integrations/capabilities";

export const CAPABILITY_ADAPTER_VISIBILITIES = ["integration", "internal-only"] as const;
export type CapabilityAdapterVisibility = (typeof CAPABILITY_ADAPTER_VISIBILITIES)[number];

export interface CapabilityAdapterEntry {
	descriptorId: CanonicalCapabilityId;
	visibility: CapabilityAdapterVisibility;
	deprecated?: boolean;
}

export interface AdaptedCapabilityDescriptor extends CanonicalCapabilityDescriptor {
	source: "oauth" | "plugin";
	sourceId: string;
	visibility: CapabilityAdapterVisibility;
	deprecated: boolean;
}

/**
 * OAuth scope IDs are canonical capability IDs. This identity adapter remains only so
 * integration summaries can consume OAuth and plugin capabilities through one interface.
 */
export const OAUTH_SCOPE_CAPABILITY_ADAPTER = {
	"project.read": { descriptorId: "project.read", visibility: "integration" },
	"device.read": { descriptorId: "device.read", visibility: "integration" },
	"device.provision": { descriptorId: "device.provision", visibility: "integration" },
	"device.rotate": { descriptorId: "device.rotate", visibility: "integration" },
	"narrator.read": { descriptorId: "narrator.read", visibility: "integration" },
	"event.subscribe": { descriptorId: "event.subscribe", visibility: "integration" },
	"narrator.provision": { descriptorId: "narrator.provision", visibility: "integration" },
	"narrator.send_message": {
		descriptorId: "narrator.send_message",
		visibility: "integration",
	},
	"narrator.interrupt": { descriptorId: "narrator.interrupt", visibility: "integration" },
	"message.summary.read": {
		descriptorId: "message.summary.read",
		visibility: "integration",
	},
	"message.content.read": {
		descriptorId: "message.content.read",
		visibility: "integration",
	},
} as const satisfies Record<string, CapabilityAdapterEntry>;

/**
 * Explicit plugin adapter. Internal-only entries are still described canonically, but are
 * marked so future public integration surfaces cannot expose them accidentally.
 */
export const PLUGIN_CAPABILITY_ADAPTER = {
	"plugin.install": { descriptorId: "integration.install", visibility: "internal-only" },
	"plugin.enable": { descriptorId: "integration.enable", visibility: "internal-only" },
	"plugin.disable": { descriptorId: "integration.disable", visibility: "internal-only" },
	"plugin.upgrade": { descriptorId: "integration.upgrade", visibility: "internal-only" },
	"plugin.uninstall": { descriptorId: "integration.uninstall", visibility: "internal-only" },
	"plugin.grant": { descriptorId: "integration.grant", visibility: "internal-only" },
	"query.read.projects": { descriptorId: "project.read", visibility: "integration" },
	"query.read.chapters": { descriptorId: "chapter.read", visibility: "integration" },
	"query.read.narrators": { descriptorId: "narrator.read", visibility: "integration" },
	"query.read.message_summary": {
		descriptorId: "message.summary.read",
		visibility: "integration",
	},
	"query.read.message_content": {
		descriptorId: "message.content.read",
		visibility: "integration",
	},
	"query.read.audit_self": { descriptorId: "audit.self.read", visibility: "integration" },
	"query.read.audit_all": { descriptorId: "audit.all.read", visibility: "internal-only" },
	"query.read.host_settings": { descriptorId: "settings.read", visibility: "internal-only" },
	"event.subscribe.chapter": {
		descriptorId: "event.chapter.subscribe",
		visibility: "integration",
	},
	"event.subscribe.narrator": {
		descriptorId: "event.narrator.subscribe",
		visibility: "integration",
	},
	"event.subscribe": {
		descriptorId: "event.subscribe",
		visibility: "integration",
	},
	"event.subscribe.permission": {
		descriptorId: "event.permission.subscribe",
		visibility: "integration",
	},
	"event.subscribe.provider": {
		descriptorId: "event.provider.subscribe",
		visibility: "integration",
	},
	"event.subscribe.project": {
		descriptorId: "event.project.subscribe",
		visibility: "integration",
	},
	"event.subscribe.plugin": {
		descriptorId: "event.integration.subscribe",
		visibility: "integration",
	},
	"event.subscribe.device": {
		descriptorId: "event.device.subscribe",
		visibility: "integration",
	},
	"event.subscribe.public": {
		descriptorId: "event.public.subscribe",
		visibility: "integration",
	},
	"command.narrator.send_message": {
		descriptorId: "narrator.send_message",
		visibility: "integration",
	},
	"command.narrator.send_subagent_message": {
		descriptorId: "narrator.send_subagent_message",
		visibility: "integration",
	},
	"command.narrator.create": {
		descriptorId: "narrator.create",
		visibility: "integration",
	},
	"command.narrator.delete": {
		descriptorId: "narrator.delete",
		visibility: "integration",
	},
	"command.narrator.spec_tasks_get": {
		descriptorId: "narrator.spec_tasks.get",
		visibility: "integration",
	},
	"command.narrator.spec_task_add": {
		descriptorId: "narrator.spec_task.add",
		visibility: "integration",
	},
	"command.narrator.interrupt": {
		descriptorId: "narrator.interrupt",
		visibility: "integration",
	},
	"command.permission.decide": {
		descriptorId: "permission.decide",
		visibility: "internal-only",
	},
	"command.chapter.write": { descriptorId: "chapter.write", visibility: "integration" },
	"command.chapter.merge": { descriptorId: "chapter.merge", visibility: "integration" },
	"command.review.write": { descriptorId: "review.write", visibility: "integration" },
	"command.routine.write": { descriptorId: "routine.write", visibility: "integration" },
	"provider.register": { descriptorId: "provider.register", visibility: "integration" },
	"provider.use": { descriptorId: "provider.use", visibility: "integration" },
	"provider.refresh_catalog": {
		descriptorId: "provider.refresh_catalog",
		visibility: "integration",
	},
	// A search source executes against the provider contribution it binds to. It gets its own
	// canonical descriptor rather than reusing `provider.use`, because this adapter must stay
	// one-to-one reversible — two protocol strings mapping to one descriptor breaks that.
	"search.provide": { descriptorId: "provider.search", visibility: "integration" },
	"config.read_self": { descriptorId: "config.read", visibility: "integration" },
	"config.write_self": { descriptorId: "config.write", visibility: "integration" },
	"secret.use_self": { descriptorId: "secret.use", visibility: "integration" },
	"storage.read_self": { descriptorId: "storage.read", visibility: "integration" },
	"storage.write_self": { descriptorId: "storage.write", visibility: "integration" },
	"storage.purge_self": { descriptorId: "storage.purge", visibility: "integration" },
	"device.read": { descriptorId: "device.read", visibility: "integration" },
	"device.command": { descriptorId: "device.execute", visibility: "integration" },
	"ui.panel": { descriptorId: "ui.panel", visibility: "integration" },
	"ui.notification": { descriptorId: "ui.notification", visibility: "integration" },
	"ui.open_external": { descriptorId: "ui.open_external", visibility: "integration" },
	"ui.theme": { descriptorId: "ui.theme", visibility: "integration" },
	"network.egress.allowlist": { descriptorId: "network.egress", visibility: "integration" },
	"filesystem.workspace.read": {
		descriptorId: "filesystem.workspace.read",
		visibility: "integration",
	},
	"filesystem.workspace.write": {
		descriptorId: "filesystem.workspace.write",
		visibility: "integration",
	},
	"process.spawn.allowlist": { descriptorId: "process.spawn", visibility: "integration" },
	"schedule.register": { descriptorId: "schedule.register", visibility: "integration" },
	"diagnostics.readOwnLogs": { descriptorId: "diagnostics.read", visibility: "integration" },
} as const satisfies Record<string, CapabilityAdapterEntry>;

function adapt(
	source: AdaptedCapabilityDescriptor["source"],
	sourceId: string,
	entry: CapabilityAdapterEntry,
): AdaptedCapabilityDescriptor {
	return {
		...getCanonicalCapabilityDescriptor(entry.descriptorId),
		source,
		sourceId,
		visibility: entry.visibility,
		deprecated: entry.deprecated ?? false,
	};
}

export function adaptOAuthScope(scope: string): AdaptedCapabilityDescriptor | undefined {
	const entry = OAUTH_SCOPE_CAPABILITY_ADAPTER[
		scope as keyof typeof OAUTH_SCOPE_CAPABILITY_ADAPTER
	] as CapabilityAdapterEntry | undefined;
	return entry ? adapt("oauth", scope, entry) : undefined;
}

export function adaptPluginCapability(capability: string): AdaptedCapabilityDescriptor | undefined {
	const entry = PLUGIN_CAPABILITY_ADAPTER[capability as keyof typeof PLUGIN_CAPABILITY_ADAPTER] as
		| CapabilityAdapterEntry
		| undefined;
	return entry ? adapt("plugin", capability, entry) : undefined;
}
