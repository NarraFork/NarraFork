/**
 * Read/write path for plugin provider configuration.
 *
 * Config has three homes and this service is the only place that knows all three:
 *
 * - the provider registry holds the live, in-memory value the adapter uses;
 * - `plugin-state-store` persists it across restarts;
 * - the secret broker holds values a schema marks `format: "password"`.
 *
 * Splitting secrets out matters: `state.json` is plain text on disk, so an API key
 * written there would be readable by anything that can read the plugin directory.
 * Callers therefore never see a stored secret echoed back — only whether one is set.
 */

import { ValidationError } from "@server/lib/errors";
import type { JsonValue } from "@server/lib/plugins/protocol";
import type { PluginProviderRegistry, ProviderRegistryEntry } from "./plugin-provider-registry";
import type { PluginStateStore } from "./plugin-state-store";

/** Placeholder returned in place of a stored secret value. */
export const SECRET_PLACEHOLDER = "__narrafork_secret_set__";

export interface ProviderConfigView {
	providerInstanceId: string;
	providerTypeId: string;
	pluginId: string;
	contributionId: string;
	providerPrefix: string;
	displayName: string;
	/** JSON Schema for the form, or `true`/`false` for accept-all / reject-all. */
	configSchema: Readonly<Record<string, JsonValue>> | boolean;
	/** Current values with secrets replaced by a placeholder. */
	config: Record<string, JsonValue>;
	/** Field names the schema marks as secret. */
	secretFields: string[];
	/** Secret fields that currently have a stored value. */
	secretsSet: string[];
}

export interface ProviderSecretStore {
	setSecret(input: { pluginId: string; key: string; value: string }): Promise<void> | void;
	/** Return value is ignored; a `boolean` "was present" result is fine. */
	deleteSecret(input: { pluginId: string; key: string }): Promise<unknown> | unknown;
	hasSecret(input: { pluginId: string; key: string }): Promise<boolean> | boolean;
}

export interface PluginProviderConfigServiceOptions {
	registry: PluginProviderRegistry;
	stateStore: Pick<PluginStateStore, "setProviderConfig" | "setProviderPrefix" | "getCachedState">;
	/** Optional secret sink; without it, secret fields cannot be stored. */
	secretStore?: ProviderSecretStore;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Field names a schema marks as secret.
 *
 * Only top-level string properties with `format: "password"` qualify. Nested secrets
 * are intentionally unsupported: the flat key shape keeps secret-broker keys
 * predictable and the config form simple, and no real provider has needed more.
 */
export function secretFieldsOf(schema: ProviderRegistryEntry["configSchema"]): string[] {
	if (typeof schema === "boolean") return [];
	const properties = schema.properties;
	if (!isRecord(properties)) return [];
	const fields: string[] = [];
	for (const [name, definition] of Object.entries(properties)) {
		if (!isRecord(definition)) continue;
		if (definition.type === "string" && definition.format === "password") fields.push(name);
	}
	return fields;
}

/** Secret-broker key for one provider config field. */
export function providerSecretKey(contributionId: string, field: string): string {
	return `provider.${contributionId}.${field}`;
}

export class PluginProviderConfigService {
	private readonly registry: PluginProviderRegistry;
	private readonly stateStore: PluginProviderConfigServiceOptions["stateStore"];
	private readonly secretStore?: ProviderSecretStore;

	constructor(options: PluginProviderConfigServiceOptions) {
		this.registry = options.registry;
		this.stateStore = options.stateStore;
		this.secretStore = options.secretStore;
	}

	/**
	 * Change a provider's prefix.
	 *
	 * The registry is updated first because it owns conflict detection: a prefix already
	 * claimed by another provider must be rejected before anything reaches disk, or a
	 * restart would try to register a conflicting prefix and fail the whole plugin.
	 *
	 * There is deliberately no "revert to manifest" mode. The manifest prefix is not
	 * reachable from here, so a revert would clear the stored override while leaving the
	 * live registry on the old value until the next restart — a state where the UI and
	 * the running system disagree. Callers that want the manifest value pass it
	 * explicitly, which keeps both sides consistent at all times.
	 */
	async updatePrefix(
		pluginId: string,
		providerInstanceId: string,
		prefix: string,
	): Promise<ProviderConfigView> {
		const entry = this.registry.get(providerInstanceId);
		if (!entry || entry.pluginId !== pluginId) {
			throw new ValidationError(
				`Provider is not registered for this plugin: ${providerInstanceId}`,
			);
		}
		this.registry.setProviderPrefix(providerInstanceId, prefix);
		try {
			await this.stateStore.setProviderPrefix(pluginId, entry.localId, prefix);
		} catch (error) {
			// Roll the registry back so a failed write cannot leave the running prefix
			// ahead of what a restart would restore.
			this.registry.setProviderPrefix(providerInstanceId, entry.providerPrefix);
			throw error;
		}
		return this.viewFor(this.registry.get(providerInstanceId) ?? entry);
	}

	/** Config for every provider a plugin contributes, safe to send to the UI. */
	async list(pluginId: string): Promise<ProviderConfigView[]> {
		const views: ProviderConfigView[] = [];
		for (const entry of this.registry.list()) {
			if (entry.kind !== "executable-plugin" || entry.pluginId !== pluginId) continue;
			views.push(await this.viewFor(entry));
		}
		return views;
	}

	/**
	 * Validate and store config for one provider.
	 *
	 * Secret fields are peeled off and routed to the secret broker; the remaining
	 * plain fields are validated against the provider's schema and persisted. A field
	 * left at the placeholder keeps whatever secret is already stored, so a UI can
	 * round-trip a form without ever holding the real value.
	 */
	async update(
		pluginId: string,
		providerInstanceId: string,
		input: Record<string, JsonValue>,
	): Promise<ProviderConfigView> {
		const entry = this.registry.get(providerInstanceId);
		if (!entry || entry.pluginId !== pluginId) {
			throw new ValidationError(
				`Provider is not registered for this plugin: ${providerInstanceId}`,
			);
		}
		if (!isRecord(input)) throw new ValidationError("Provider config must be a JSON object");

		const secretFields = new Set(secretFieldsOf(entry.configSchema));
		const plain: Record<string, JsonValue> = {};
		const secretWrites: Array<{ field: string; value: string | null }> = [];
		for (const [key, value] of Object.entries(input)) {
			if (!secretFields.has(key)) {
				plain[key] = value;
				continue;
			}
			if (value === SECRET_PLACEHOLDER) continue; // keep the stored secret
			if (value === "" || value === null) {
				secretWrites.push({ field: key, value: null });
				continue;
			}
			if (typeof value !== "string") {
				throw new ValidationError(`Provider config field must be a string: ${key}`);
			}
			secretWrites.push({ field: key, value });
		}

		if (secretWrites.length > 0 && !this.secretStore) {
			throw new ValidationError("This host cannot store provider secrets");
		}

		// Validate before writing anything so a rejected form leaves no partial state.
		// Secret fields are excluded from the payload the schema sees, because their
		// values live in the broker; a `required` secret is satisfied by a stored value.
		const validation = this.registry.validateConfig(
			providerInstanceId,
			this.withSecretPresence(plain, entry, secretWrites),
		);
		if (!validation.valid) {
			throw new ValidationError(
				`Provider config is invalid: ${validation.issues
					.map((issue) => `${issue.path}: ${issue.message}`)
					.join("; ")}`,
			);
		}

		// Registry first: it re-validates and is what the adapter reads. Persisting
		// afterwards means a rejected value never reaches disk.
		const previousConfig = this.registry.getConfig(providerInstanceId);
		this.registry.updateConfig(providerInstanceId, plain);
		try {
			await this.stateStore.setProviderConfig(pluginId, entry.localId, plain);
		} catch (error) {
			// A disk write can fail for reasons the caller does not control (full volume,
			// permission change, corrupted journal). Rolling the registry back keeps the
			// running provider on the config a restart would actually restore, rather than
			// leaving it silently ahead of disk until someone reboots the host.
			this.registry.updateConfig(providerInstanceId, { ...previousConfig });
			throw error;
		}

		// Secrets go last because these writes cannot be undone: a cleared secret is gone
		// for good (the host never reads a stored value back, so there is nothing to
		// restore from). Running them after every fallible step means a failure above
		// leaves the user's credentials exactly as they were.
		for (const write of secretWrites) {
			const key = providerSecretKey(entry.localId, write.field);
			if (write.value === null) await this.secretStore?.deleteSecret({ pluginId, key });
			else await this.secretStore?.setSecret({ pluginId, key, value: write.value });
		}
		return this.viewFor(this.registry.get(providerInstanceId) ?? entry);
	}

	/**
	 * Substitute a marker for each secret so schema validation can see the field as
	 * present. The marker never reaches disk or the plugin: only `plain` is persisted,
	 * and the plugin reads secrets through the secret host methods.
	 */
	private withSecretPresence(
		plain: Record<string, JsonValue>,
		entry: ProviderRegistryEntry,
		writes: Array<{ field: string; value: string | null }>,
	): Record<string, JsonValue> {
		const schema = entry.configSchema;
		if (typeof schema === "boolean") return plain;
		const required = Array.isArray(schema.required) ? schema.required : [];
		const result = { ...plain };
		for (const field of secretFieldsOf(schema)) {
			if (!required.includes(field)) continue;
			const write = writes.find((item) => item.field === field);
			// A cleared secret leaves the field genuinely absent, so validation fails as
			// it should for a required field.
			if (write?.value === null) continue;
			result[field] = SECRET_PLACEHOLDER;
		}
		return result;
	}

	private async viewFor(entry: ProviderRegistryEntry): Promise<ProviderConfigView> {
		const pluginId = entry.pluginId ?? "";
		const secretFields = secretFieldsOf(entry.configSchema);
		const stored = this.registry.getConfig(entry.providerInstanceId);
		const secretsSet: string[] = [];
		for (const field of secretFields) {
			const has = await this.secretStore?.hasSecret({
				pluginId,
				key: providerSecretKey(entry.localId, field),
			});
			if (has) secretsSet.push(field);
		}
		const config: Record<string, JsonValue> = { ...stored };
		// Never echo a secret back, even to an admin UI.
		for (const field of secretsSet) config[field] = SECRET_PLACEHOLDER;
		return {
			providerInstanceId: entry.providerInstanceId,
			providerTypeId: entry.providerTypeId,
			pluginId,
			contributionId: entry.localId,
			providerPrefix: entry.providerPrefix,
			displayName: entry.displayName,
			configSchema: entry.configSchema,
			config,
			secretFields,
			secretsSet,
		};
	}
}
