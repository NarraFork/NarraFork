/**
 * Host-side application of a plugin command's `secretWrites`.
 *
 * ## What is enforced, and why only this
 *
 * A plugin command may return `secretWrites` asking the host to persist credential material
 * it already holds. Two limits remain, and both are structural rather than trust-based:
 *
 * - **Namespace.** A key must be `provider.<contributionId>.<field>` for a contribution the
 *   requesting plugin actually owns. Derived from the registry, never from the request, so
 *   one plugin cannot write another's credentials. This mirrors VS Code, where
 *   `mainThreadSecretState` derives the storage key from a host-injected `extensionId`.
 * - **Per-value size.** 64KB. Not about trust: `plugin-secret-vault` is a synchronous JSON
 *   read/modify/write on the main thread, so an unbounded value stalls every other request.
 *   See CLAUDE.md on main-thread blocking.
 *
 * ## What was removed, and what that costs
 *
 * The field whitelist (requiring each key to be declared secret in a `configSchema`), the
 * entry-count ceiling, the batch-total ceiling, duplicate-key rejection, and batch
 * atomicity are all gone. They came from treating an installed plugin as untrusted, which
 * is not the model any more — installing a plugin already grants it arbitrary code
 * execution on the server.
 *
 * The real cost is worth stating plainly: **a batch is no longer atomic.** Writes are
 * applied in order, and an I/O failure partway through leaves earlier entries persisted. A
 * plugin rotating a credential set must therefore tolerate a partially-applied batch. The
 * previous validate-everything-first pass only protected against *policy* failures, which
 * no longer exist here; it never protected against a vault write failing halfway.
 *
 * Values are still never logged, and `secretWrites` is consumed by the host rather than
 * echoed back, so a command cannot use it to read state back out.
 */

import { ValidationError } from "@server/lib/errors";
import { logger } from "@server/lib/logger";
import {
	type CommandSecretWrite,
	MAX_COMMAND_SECRET_VALUE_BYTES,
} from "@server/lib/plugins/protocol";
import type { PluginProviderRegistry } from "./plugin-provider-registry";

/** The vault operations this module needs. Narrowed so tests can supply a stub. */
export interface CommandSecretSink {
	setSecret(input: { pluginId: string; key: string; value: string }): Promise<void> | void;
	deleteSecret(input: { pluginId: string; key: string }): Promise<unknown> | unknown;
}

export interface ApplyCommandSecretWritesInput {
	pluginId: string;
	writes: readonly CommandSecretWrite[];
	registry: Pick<PluginProviderRegistry, "list">;
	sink: CommandSecretSink;
}

export interface ApplyCommandSecretWritesResult {
	/** Keys written, for audit. Never includes values. */
	written: string[];
	/** Keys deleted, for audit. */
	deleted: string[];
}

/**
 * The `provider.<contributionId>.` prefixes this plugin may write under.
 *
 * Derived from the registry rather than the request: which contributions exist is a property
 * of what the plugin *contributed*, not of what it asks for. The field part is no longer
 * constrained, so a plugin can manage credential keys it could not have enumerated in a
 * static manifest — rotating tokens, or one entry per signed-in account.
 */
function ownedContributionIds(
	pluginId: string,
	registry: Pick<PluginProviderRegistry, "list">,
): Set<string> {
	const owned = new Set<string>();
	for (const entry of registry.list()) {
		if (entry.kind !== "executable-plugin" || entry.pluginId !== pluginId) continue;
		owned.add(entry.localId);
	}
	return owned;
}

/** Split `provider.<contributionId>.<field>`; anything else is not a provider secret key. */
function parseProviderSecretKey(
	key: string,
): { contributionId: string; field: string } | undefined {
	const match = /^provider\.([^.]+)\.(.+)$/.exec(key);
	if (!match?.[1] || !match[2]) return undefined;
	return { contributionId: match[1], field: match[2] };
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/**
 * Validate and apply a batch.
 *
 * Throws `ValidationError` on the first problem found, before any write. The message names
 * the offending key but never any value.
 */
export async function applyCommandSecretWrites(
	input: ApplyCommandSecretWritesInput,
): Promise<ApplyCommandSecretWritesResult> {
	const { pluginId, writes, registry, sink } = input;
	if (writes.length === 0) return { written: [], deleted: [] };

	const owned = ownedContributionIds(pluginId, registry);

	// Validate before writing anything. Only two rules remain, but both are cheap and
	// checking up front keeps a malformed key from landing after earlier entries applied.
	for (const write of writes) {
		const key = write.key.trim();
		const parsed = parseProviderSecretKey(key);
		if (!parsed || !owned.has(parsed.contributionId)) {
			// One message for both cases — a key outside the provider namespace, and a
			// contribution this plugin does not own. Kept indistinguishable so a plugin cannot
			// probe which contribution ids exist elsewhere in the host.
			throw new ValidationError(
				`Command may not write secret key: ${key}. Only provider.<contributionId>.<field> keys for this plugin's own contributions are writable.`,
			);
		}
		if (write.value !== null) {
			const size = byteLength(write.value);
			if (size > MAX_COMMAND_SECRET_VALUE_BYTES) {
				// Refused rather than truncated: a silently shortened credential fails
				// authentication later in a way that looks like a server fault.
				throw new ValidationError(
					`Secret value for ${key} is too large: ${size} > ${MAX_COMMAND_SECRET_VALUE_BYTES} bytes`,
				);
			}
		}
	}

	// Apply in order. Duplicate keys are allowed and last-write-wins; an I/O failure partway
	// through leaves earlier entries persisted (see the note on atomicity above).
	const written: string[] = [];
	const deleted: string[] = [];
	for (const write of writes) {
		const key = write.key.trim();
		if (write.value === null) {
			await sink.deleteSecret({ pluginId, key });
			deleted.push(key);
		} else {
			await sink.setSecret({ pluginId, key, value: write.value });
			written.push(key);
		}
	}

	// Key names and counts only. A length would leak information about the credential.
	logger.info("Applied plugin command secret writes", {
		pluginId,
		written: written.length,
		deleted: deleted.length,
		keys: [...written, ...deleted],
	});
	return { written, deleted };
}
