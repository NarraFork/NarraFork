/**
 * Plugin provider secrets as `credentials.json` entries (docs/PROVIDER-SOURCING-DESIGN.md
 * §15.7): one `opaque` credential per provider a plugin contributes, holding the secret
 * fields its config schema declares. Plugins keep addressing them as vault keys
 * (`provider.<contributionId>.<field>`); the vault maps those here on a unified instance.
 */
import type { Credential, CredentialStore } from "./credential-store";

/** The id requests to a plugin provider are billed to (§15.3), whatever the plugin reports. */
export function pluginCredentialId(pluginId: string, contributionId: string): string {
	return `plugin:${pluginId}:${contributionId}`;
}

/**
 * `provider.<contributionId>.<field>`. Provider ids may contain dots, schema field names
 * in practice do not, so the field is the last segment.
 */
const PROVIDER_SECRET_KEY = /^provider\.(.+)\.([^.]+)$/;

export function parseProviderSecretKey(
	key: string,
): { contributionId: string; field: string } | undefined {
	const match = PROVIDER_SECRET_KEY.exec(key);
	return match ? { contributionId: match[1] as string, field: match[2] as string } : undefined;
}

/** Secret fields of each provider of one plugin, by contribution id. */
export function pluginProviderSecrets(
	store: CredentialStore,
	pluginId: string,
): Map<string, Record<string, string>> {
	const prefix = `${pluginId}/`;
	const result = new Map<string, Record<string, string>>();
	for (const credential of store.pluginCredentials()) {
		const target = credential.target.pluginContributionId;
		if (credential.auth.kind !== "opaque" || !target?.startsWith(prefix)) continue;
		result.set(target.slice(prefix.length), credential.auth.fields);
	}
	return result;
}

export interface PluginProviderSecretsChange {
	pluginId: string;
	contributionId: string;
	/** The provider's whole field bag; empty removes its credential. */
	fields: Record<string, string>;
}

/** Apply the changes in one write. */
export function savePluginProviderSecrets(
	store: CredentialStore,
	changes: readonly PluginProviderSecretsChange[],
): void {
	const byId = new Map(store.pluginCredentials().map((c) => [c.id, c]));
	for (const { pluginId, contributionId, fields } of changes) {
		const id = pluginCredentialId(pluginId, contributionId);
		const existing = byId.get(id);
		if (!Object.keys(fields).length) {
			byId.delete(id);
			continue;
		}
		const credential: Credential = existing ?? {
			id,
			target: { pluginContributionId: `${pluginId}/${contributionId}` },
			ownerUserId: null,
			priority: 0,
			createdAt: Date.now(),
			auth: { kind: "opaque", fields: {} },
		};
		byId.set(id, { ...credential, auth: { kind: "opaque", fields: { ...fields } } });
	}
	store.savePlugins([...byId.values()]);
}
