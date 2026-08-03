/**
 * Resolves the config a provider plugin actually receives for one RPC call.
 *
 * `plugin-provider-config-service` splits a submitted form in two: plain fields go to
 * the registry and `state.json`, secret fields go to the vault. Nothing put the two
 * halves back together, so a provider plugin could have an API key stored and still be
 * unable to authenticate — the credential went in and never came out. This resolver is
 * that missing half.
 *
 * ## Why values travel in `config` rather than through a handle
 *
 * `04-server-rpc-and-provider.md` §25 assumption 2 states the config layer supplies
 * "解析后的临时值" at call time, and D-04 selects "RPC config 传值" as the injection
 * mechanism on the condition that logs are deeply redacted. `ProviderBaseParams.config`
 * is already sent with every chat/generate/listModels call, so the transport exists;
 * only the resolution step was missing. The comment at
 * `plugin-provider-catalog-refresh.ts` ("The plugin may need credentials from config")
 * describes exactly this behaviour and predates the implementation.
 *
 * ## Why this does not weaken the sandbox contract
 *
 * `07-security-and-sandbox.md` §13 forbids a provider plugin from enumerating host
 * secrets, reading another provider's config, or persisting credentials itself. This
 * resolver grants none of those: the plugin never asks for anything, it is handed the
 * fields its own schema declares, and it has no write path. In particular no
 * `secrets.get`-style host method is introduced, so the iframe method inventory — and
 * the parity assertion that freezes it — is untouched. A UI plugin still only ever sees
 * "configured / not configured".
 *
 * ## Deliberate non-behaviours
 *
 * - **No caching.** Every call re-reads, so revoking a plugin or rotating a key takes
 *   effect on the next request instead of at the next restart.
 * - **Absent, not empty.** An unset secret is omitted from the object entirely rather
 *   than sent as `""`, so a plugin can distinguish "not configured" from
 *   "configured as empty" and report a useful error.
 * - **Never logged.** Resolved values must not reach logs, error details or
 *   diagnostics. Failures below report the key name only. This is the precondition
 *   D-04 attaches to passing values in `config`, and a regression test asserts it.
 */

import { logger } from "@server/lib/logger";
import type { JsonValue } from "@server/lib/plugins/protocol";
import { providerSecretKey, secretFieldsOf } from "./plugin-provider-config-service";
import type { PluginProviderRegistry } from "./plugin-provider-registry";

/** The read side of the vault. Narrowed so tests can supply a trivial stub. */
export interface ProviderCredentialSource {
	getSecret(input: { pluginId: string; key: string }): Promise<string | undefined> | undefined;
}

export interface PluginProviderCredentialResolverOptions {
	registry: Pick<PluginProviderRegistry, "get" | "getConfig">;
	/** Omit to disable credential injection entirely (plain config is still returned). */
	secretSource?: ProviderCredentialSource;
}

export class PluginProviderCredentialResolver {
	private readonly registry: PluginProviderCredentialResolverOptions["registry"];
	private readonly secretSource?: ProviderCredentialSource;

	constructor(options: PluginProviderCredentialResolverOptions) {
		this.registry = options.registry;
		this.secretSource = options.secretSource;
	}

	/**
	 * Plain config for `providerInstanceId`, merged with the stored value of each secret
	 * field its schema declares.
	 *
	 * An unknown provider yields `{}` rather than throwing: this runs inside the request
	 * path, and a provider that disappeared mid-flight is better reported by the caller's
	 * own resolution error than by a failure here.
	 */
	async resolve(providerInstanceId: string): Promise<Record<string, JsonValue>> {
		const entry = this.registry.get(providerInstanceId);
		if (!entry) return {};
		const config = this.registry.getConfig(providerInstanceId);
		if (!this.secretSource) return config;

		const pluginId = entry.pluginId;
		// Only executable-plugin providers own vault entries; a builtin has no pluginId
		// and no secrets to merge.
		if (!pluginId) return config;

		// Derived from this entry's own schema, so a plugin cannot receive a field it did
		// not declare, and the key is namespaced by contribution id, so it cannot receive
		// a sibling provider's credential either.
		const secretFields = secretFieldsOf(entry.configSchema);
		if (secretFields.length === 0) return config;

		const resolved: Record<string, JsonValue> = { ...config };
		for (const field of secretFields) {
			const key = providerSecretKey(entry.localId, field);
			let value: string | undefined;
			try {
				value = await this.secretSource.getSecret({ pluginId, key });
			} catch (error) {
				// Degrade to "no credential" rather than failing the request outright: an
				// unreadable vault should surface as the provider's own auth error, which is
				// far easier to act on than a generic host failure. Key name only — never the
				// value, and never the raw error, which could quote file contents.
				logger.warn("Failed to resolve plugin provider credential", {
					pluginId,
					providerInstanceId,
					field,
					error: error instanceof Error ? error.name : "unknown",
				});
			}
			// An unset secret must stay absent so the plugin can tell it apart from a
			// deliberately empty value. The placeholder the UI sees must never leak here
			// either; it only ever exists in `ProviderConfigView`.
			if (typeof value === "string" && value.length > 0) resolved[field] = value;
			else delete resolved[field];
		}
		return resolved;
	}
}
