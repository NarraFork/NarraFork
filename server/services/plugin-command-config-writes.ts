/**
 * Host-side application of a plugin command's `configWrites`.
 *
 * ## Why this exists next to `secretWrites`
 *
 * A command could already ask the host to persist *secrets*, but a provider's non-secret
 * settings live somewhere else entirely: the provider config store, which feeds
 * `registry.validateConfig()` and the `config` object the host passes into every
 * `provider.chat` / `commands.invoke` call. A value written to the vault never reaches any of
 * that.
 *
 * that changed the live manager, but nothing persisted it, so the setting reverted on restart.
 * The switch worked and then quietly un-worked — worse than not offering it.
 *
 * ## What is enforced
 *
 * - **Namespace.** `provider.<contributionId>.<field>` for a contribution the requesting plugin
 *   owns, derived from the registry rather than the request. Same rule as `secretWrites`, and
 *   the error message is likewise indistinguishable between "malformed" and "not yours" so a
 *   plugin cannot probe for other contribution ids.
 * - **Not a secret field.** A key naming a `configSchema` secret is refused. The two channels
 *   must stay disjoint: writing a credential here would put it in plaintext config, which is
 *   then readable via `config.get` and echoed into provider calls.
 * - **Declared in the schema.** Unlike `secretWrites`, the field must exist in the
 *   contribution's `configSchema`. That restriction is dropped for secrets because a plugin
 *   managing rotating tokens cannot enumerate its keys statically; config is the opposite —
 *   it is a fixed set of settings the manifest declares, and `validateConfig` would reject an
 *   unknown field on the next write anyway.
 * - **Value size.** 16KB per value, so one write cannot stall the main thread in the config
 *   store's synchronous JSON round trip.
 *
 * ## Merge, not replace
 *
 * `PluginProviderConfigService.update()` takes the *whole* config object. A command that
 * returns one key must therefore be merged over the stored config, or every unrelated setting
 * would be wiped. Merging also means the write goes through the same schema validation as the
 * host's own config form, with no second validation path to keep in sync.
 */

import { ValidationError } from "@server/lib/errors";
import { logger } from "@server/lib/logger";
import type { JsonValue } from "@server/lib/plugins/protocol";
import {
	type CommandConfigWrite,
	MAX_COMMAND_CONFIG_VALUE_BYTES,
} from "@server/lib/plugins/protocol";
import { secretFieldsOf } from "./plugin-provider-config-service";
import type { PluginProviderRegistry } from "./plugin-provider-registry";

/** The config operations this module needs. Narrowed so tests can supply a stub. */
export interface CommandConfigSink {
	update(
		pluginId: string,
		providerInstanceId: string,
		config: Record<string, JsonValue>,
	): Promise<unknown>;
}

export interface ApplyCommandConfigWritesInput {
	pluginId: string;
	writes: readonly CommandConfigWrite[];
	registry: Pick<PluginProviderRegistry, "list" | "getConfig">;
	sink: CommandConfigSink;
}

export interface ApplyCommandConfigWritesResult {
	/** Field keys written, for audit. */
	written: string[];
	/** Field keys cleared, for audit. */
	cleared: string[];
}

/** Split `provider.<contributionId>.<field>`. */
function parseProviderConfigKey(
	key: string,
): { contributionId: string; field: string } | undefined {
	const match = /^provider\.([^.]+)\.(.+)$/.exec(key);
	if (!match?.[1] || !match[2]) return undefined;
	return { contributionId: match[1], field: match[2] };
}

function byteLength(value: JsonValue): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function declaredFields(schema: unknown): Set<string> {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return new Set();
	const properties = (schema as { properties?: unknown }).properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) return new Set();
	return new Set(Object.keys(properties as Record<string, unknown>));
}

/**
 * Validate and apply a batch.
 *
 * Everything is validated before the first write, and writes are grouped per provider so a
 * multi-key batch results in one config update rather than one per key.
 */
export async function applyCommandConfigWrites(
	input: ApplyCommandConfigWritesInput,
): Promise<ApplyCommandConfigWritesResult> {
	const { pluginId, writes, registry, sink } = input;
	if (writes.length === 0) return { written: [], cleared: [] };

	// Own contributions only, keyed by the local id the namespace uses.
	const owned = new Map<string, { providerInstanceId: string; configSchema: unknown }>();
	for (const entry of registry.list()) {
		if (entry.kind !== "executable-plugin" || entry.pluginId !== pluginId) continue;
		owned.set(entry.localId, {
			providerInstanceId: entry.providerInstanceId,
			configSchema: entry.configSchema,
		});
	}

	const written: string[] = [];
	const cleared: string[] = [];
	// contributionId → merged patch, so several keys for one provider become one update.
	const patches = new Map<string, Record<string, JsonValue | undefined>>();

	for (const write of writes) {
		const key = write.key.trim();
		const parsed = parseProviderConfigKey(key);
		const target = parsed ? owned.get(parsed.contributionId) : undefined;
		if (!parsed || !target) {
			throw new ValidationError(
				`Command may not write config key: ${key}. Only provider.<contributionId>.<field> keys for this plugin's own contributions are writable.`,
			);
		}
		if (secretFieldsOf(target.configSchema as never).includes(parsed.field)) {
			// Secrets belong in `secretWrites`, which stores them in the vault. Accepting one
			// here would persist a credential as plaintext config, where `config.get` can read
			// it back.
			throw new ValidationError(
				`Config key ${key} names a secret field. Use secretWrites for secret values.`,
			);
		}
		if (!declaredFields(target.configSchema).has(parsed.field)) {
			throw new ValidationError(
				`Config key ${key} is not declared in the provider's configSchema.`,
			);
		}
		if (write.value !== null) {
			const size = byteLength(write.value);
			if (size > MAX_COMMAND_CONFIG_VALUE_BYTES) {
				throw new ValidationError(
					`Config value for ${key} is too large: ${size} > ${MAX_COMMAND_CONFIG_VALUE_BYTES} bytes`,
				);
			}
		}

		const patch = patches.get(parsed.contributionId) ?? {};
		// `undefined` marks a removal, which is how the merge below drops the field.
		patch[parsed.field] = write.value === null ? undefined : write.value;
		patches.set(parsed.contributionId, patch);
		if (write.value === null) cleared.push(key);
		else written.push(key);
	}

	for (const [contributionId, patch] of patches) {
		const target = owned.get(contributionId);
		if (!target) continue;
		// Merge over the stored config: `update()` replaces the whole object, so sending only
		// the changed keys would delete every other setting.
		const current = registry.getConfig(target.providerInstanceId) ?? {};
		const next: Record<string, JsonValue> = { ...current };
		for (const [field, value] of Object.entries(patch)) {
			if (value === undefined) delete next[field];
			else next[field] = value;
		}
		// Validation and persistence both happen inside `update()`, so a rejected value never
		// reaches disk and the running provider is rolled back on an I/O failure.
		await sink.update(pluginId, target.providerInstanceId, next);
	}

	logger.info("Applied plugin command config writes", {
		pluginId,
		written: written.length,
		cleared: cleared.length,
		keys: [...written, ...cleared],
	});
	return { written, cleared };
}
