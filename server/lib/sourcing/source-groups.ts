/**
 * Source groups as an in-memory view (docs/PROVIDER-SOURCING-DESIGN.md §15.2, §15.8).
 *
 * The 2026-11-23 decision keeps `settings.json` as it is until S5: each existing connection
 * already is one source group, so the view is derived from the old arrays — custom API
 * providers, NUG providers, the TokenDance / Command Code / Codex singletons and plugin
 * providers. Read-only; rebuilt only when the settings revision or the plugin registry
 * revision moves.
 */
import { identifyService, type SourceProtocol, type SourceRegion } from "@shared/sourcing/identify";
import { TOKENDANCE_PREFIX } from "@shared/tokendance";
import { pluginProviderRegistry } from "../../services/plugin-provider-registry";
import { COMMAND_CODE_PREFIX } from "../commandcode-protocol";
import { getSettingsRevision, settings } from "../settings";
import { getServiceTemplate, type ServiceTemplateId, type ServiceTemplateKind } from "./templates";

export interface SourceGroupView {
	/** The connection id; singletons use `codex` / `tokendance` / `CommandCode`. */
	id: string;
	templateId: ServiceTemplateId;
	kind: ServiceTemplateKind;
	prefix: string;
	name: string;
	disabled: boolean;
	endpoint: { baseUrl?: string; protocol?: SourceProtocol; region?: SourceRegion };
}

function group(
	templateId: ServiceTemplateId,
	fields: Omit<SourceGroupView, "templateId" | "kind">,
): SourceGroupView {
	return Object.freeze({
		...fields,
		templateId,
		kind: getServiceTemplate(templateId).kind,
		endpoint: Object.freeze(fields.endpoint),
	});
}

/**
 * A view of the caller's current connection, without the global settings snapshot.
 * Management reads also need disabled connections and drafts that were not saved yet.
 */
export function sourceGroupForConnection(
	config: { id: string; name: string; prefix: string; baseUrl?: string; disabled?: boolean },
	protocol: SourceProtocol | "nug",
): SourceGroupView {
	const { templateId, region } = identifyService({ baseUrl: config.baseUrl, protocol });
	return group(templateId, {
		id: config.id,
		prefix: config.prefix,
		name: config.name,
		disabled: !!config.disabled,
		endpoint: {
			...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
			...(protocol !== "nug" ? { protocol } : {}),
			...(region ? { region } : {}),
		},
	});
}

/** Singletons, then connections, then plugins; a plugin never wins a shared prefix. */
function buildSourceGroups(): readonly SourceGroupView[] {
	const groups: SourceGroupView[] = [
		group("codex", { id: "codex", prefix: "codex", name: "Codex", disabled: false, endpoint: {} }),
		group("tokendance", {
			id: TOKENDANCE_PREFIX,
			prefix: TOKENDANCE_PREFIX,
			name: "TokenDance",
			disabled: !!settings.tokendance?.disabled,
			endpoint: {},
		}),
		group("command-code", {
			id: COMMAND_CODE_PREFIX,
			prefix: COMMAND_CODE_PREFIX,
			name: "Command Code",
			disabled: !!settings.commandCode?.disabled,
			endpoint: settings.commandCode?.baseUrl ? { baseUrl: settings.commandCode.baseUrl } : {},
		}),
	];
	for (const config of settings.customApiProviders ?? []) {
		const { templateId, region } = identifyService(config);
		groups.push(
			group(templateId, {
				id: config.id,
				prefix: config.prefix,
				name: config.name,
				disabled: !!config.disabled,
				endpoint: { baseUrl: config.baseUrl, protocol: config.protocol, ...(region && { region }) },
			}),
		);
	}
	for (const config of settings.nugProviders ?? []) {
		groups.push(
			group("nug", {
				id: config.id,
				prefix: config.prefix,
				name: config.name,
				disabled: !!config.disabled,
				endpoint: { baseUrl: config.baseUrl },
			}),
		);
	}
	for (const entry of pluginProviderRegistry.list()) {
		if (entry.kind !== "executable-plugin") continue;
		groups.push(
			group("plugin", {
				id: entry.providerInstanceId,
				prefix: entry.providerPrefix,
				name: entry.displayName || entry.providerPrefix,
				disabled: entry.disabled,
				endpoint: {},
			}),
		);
	}
	return Object.freeze(groups);
}

interface Snapshot {
	settingsRevision: number;
	pluginRevision: number;
	groups: readonly SourceGroupView[];
	byId: Map<string, SourceGroupView>;
	byPrefix: Map<string, SourceGroupView>;
}

let snapshot: Snapshot | null = null;

function current(): Snapshot {
	const settingsRevision = getSettingsRevision();
	const pluginRevision = pluginProviderRegistry.revision;
	if (
		snapshot?.settingsRevision === settingsRevision &&
		snapshot.pluginRevision === pluginRevision
	) {
		return snapshot;
	}
	const groups = buildSourceGroups();
	const byId = new Map<string, SourceGroupView>();
	const byPrefix = new Map<string, SourceGroupView>();
	// A duplicate id or prefix keeps the first group.
	for (const entry of groups) {
		if (!byId.has(entry.id)) byId.set(entry.id, entry);
		if (!byPrefix.has(entry.prefix)) byPrefix.set(entry.prefix, entry);
	}
	snapshot = { settingsRevision, pluginRevision, groups, byId, byPrefix };
	return snapshot;
}

export function listSourceGroups(): readonly SourceGroupView[] {
	return current().groups;
}

export function getSourceGroup(id: string): SourceGroupView | undefined {
	return current().byId.get(id);
}

export function getSourceGroupByPrefix(prefix: string): SourceGroupView | undefined {
	return current().byPrefix.get(prefix);
}
