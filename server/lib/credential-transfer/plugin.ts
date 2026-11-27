/** Portable plugin provider credentials: declared local targets only, never executable config. */
import {
	type ProviderRegistryEntry,
	pluginProviderRegistry,
} from "../../services/plugin-provider-registry";
import { pluginSecretVault } from "../../services/plugin-secret-vault";
import { getCredentialStore } from "../credential-store";
import { pluginCredentialId } from "../plugin-credentials";
import { isContributionId, isPluginId } from "../plugins/manifest";
import { getServiceTemplate } from "../sourcing/templates";
import type { BundleItem } from "./bundle";
import type { CredentialTransferData, ImportDecision, TransferGroup } from "./kinds";

interface PluginTransferGroup extends TransferGroup {
	pluginId: string;
	contributionId: string;
}

/** Versions/hashes and providerInstanceId deliberately never leave the exporting instance. */
function portableGroup(entry: ProviderRegistryEntry & { pluginId: string }): PluginTransferGroup {
	return {
		id: pluginCredentialId(entry.pluginId, entry.localId),
		pluginId: entry.pluginId,
		contributionId: entry.localId,
		prefix: entry.providerPrefix,
		name: entry.displayName || entry.providerPrefix,
	};
}

export function asPluginTransferData(item: CredentialTransferData): CredentialTransferData | null {
	const group = item.group as Partial<PluginTransferGroup>;
	const credential = item.credential;
	if (
		typeof group.pluginId !== "string" ||
		!isPluginId(group.pluginId) ||
		typeof group.contributionId !== "string" ||
		!isContributionId(group.contributionId) ||
		group.id !== pluginCredentialId(group.pluginId, group.contributionId) ||
		item.groupSecrets ||
		credential?.auth?.kind !== "opaque" ||
		credential.target?.pluginContributionId !== `${group.pluginId}/${group.contributionId}` ||
		credential.target.groupId !== undefined
	) {
		return null;
	}
	const fields = credential.auth.fields;
	if (
		!fields ||
		typeof fields !== "object" ||
		Array.isArray(fields) ||
		Object.keys(fields).length === 0 ||
		Object.keys(fields).length > 2000 ||
		!Object.entries(fields).every(
			([field, value]) =>
				!!field &&
				!["__proto__", "constructor", "prototype"].includes(field) &&
				typeof value === "string" &&
				value.length > 0 &&
				Buffer.byteLength(value, "utf8") <= 64 * 1024,
		)
	) {
		return null;
	}
	// Whitelist the portable identity; ignore any untrusted installation/config hints.
	return {
		templateId: "plugin",
		group: {
			id: group.id,
			pluginId: group.pluginId,
			contributionId: group.contributionId,
			name: item.group.name,
			prefix: item.group.prefix,
		},
		credential: {
			target: { pluginContributionId: `${group.pluginId}/${group.contributionId}` },
			ownerUserId: null,
			priority: 0,
			createdAt: credential.createdAt ?? 0,
			auth: { kind: "opaque", fields: { ...fields } },
		},
	};
}

function installedTarget(item: CredentialTransferData) {
	const group = item.group as PluginTransferGroup;
	const entry = pluginProviderRegistry
		.list()
		.find(
			(entry) =>
				entry.kind === "executable-plugin" &&
				entry.pluginId === group.pluginId &&
				entry.localId === group.contributionId &&
				entry.compatible,
		);
	if (!entry || item.credential?.auth.kind !== "opaque") return undefined;
	return pluginSecretVault.supportsProviderSecrets(
		group.pluginId,
		group.contributionId,
		item.credential.auth.fields,
	)
		? entry
		: undefined;
}

export async function pluginCredentialItems(): Promise<BundleItem[]> {
	const items: BundleItem[] = [];
	for (const entry of pluginProviderRegistry.list()) {
		if (entry.kind !== "executable-plugin" || !entry.pluginId) continue;
		const group = portableGroup({ ...entry, pluginId: entry.pluginId });
		const fields = await pluginSecretVault.getProviderSecrets(group.pluginId, group.contributionId);
		if (!Object.keys(fields).length) continue;
		const stored = getCredentialStore()
			.pluginCredentials()
			.find((c) => c.id === group.id);
		items.push({
			kind: "credential",
			id: group.id,
			label: group.name,
			data: {
				group,
				templateId: "plugin",
				credential: {
					target: { pluginContributionId: `${group.pluginId}/${group.contributionId}` },
					ownerUserId: null,
					priority: 0,
					createdAt: stored?.createdAt ?? 0,
					auth: { kind: "opaque", fields },
				},
			} satisfies CredentialTransferData,
		});
	}
	return items;
}

/** Clear model-provider secrets in the legacy vault too; never delete other plugin features. */
export async function clearPluginCredentialSecrets(): Promise<void> {
	for (const entry of pluginProviderRegistry.list()) {
		if (entry.kind !== "executable-plugin" || !entry.pluginId) continue;
		await pluginSecretVault.replaceProviderSecrets(entry.pluginId, entry.localId, {});
	}
}

/** A field bag, even with different values, is an existing single-slot credential. */
export async function matchPluginCredential(
	item: CredentialTransferData,
): Promise<{ label: string; existingId?: string } | null> {
	const entry = installedTarget(item);
	if (!entry) return null;
	const group = item.group as PluginTransferGroup;
	const existing = await pluginSecretVault.getProviderSecrets(group.pluginId, group.contributionId);
	return {
		label: entry.displayName || entry.providerPrefix,
		existingId: Object.keys(existing).length ? group.id : undefined,
	};
}

export async function importPluginCredential(
	item: CredentialTransferData,
	decide: (existingId?: string) => ImportDecision,
): Promise<"added" | "replaced" | "skipped"> {
	const match = await matchPluginCredential(item);
	if (!match || item.credential?.auth.kind !== "opaque") return "skipped";
	const action = decide(match.existingId);
	if (action === "skip" || (match.existingId && action !== "replace")) return "skipped";
	const group = item.group as PluginTransferGroup;
	const existingFields = await pluginSecretVault.getProviderSecrets(
		group.pluginId,
		group.contributionId,
	);
	const template = getServiceTemplate("plugin");
	const current = { ...item.credential, auth: { kind: "opaque" as const, fields: existingFields } };
	const keys = new Set(template.dedupeKeys(current));
	if (template.dedupeKeys(item.credential).some((key) => keys.has(key))) return "skipped";
	const written = await pluginSecretVault.replaceProviderSecrets(
		group.pluginId,
		group.contributionId,
		item.credential.auth.fields,
		{ overwrite: action === "replace" },
	);
	return written ? (match.existingId ? "replaced" : "added") : "skipped";
}
