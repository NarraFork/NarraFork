/**
 * On-disk store for plugin secret *values*.
 *
 * `plugin-secret-broker.ts` deliberately holds only opaque references and leases: it
 * decides *whether* a plugin may use a secret, never *what* the secret is. That left
 * the system with nowhere to actually keep a value, so a provider plugin could not own
 * an API key at all. This vault fills exactly that hole and nothing more.
 *
 * Design constraints that shaped it:
 *
 * - **Separate file from `state.json`.** Provider config is routinely read, diffed and
 *   returned to admin UIs; secrets must not ride along in those paths.
 * - **0600 on create.** The file is only as private as its mode, so the mode is set
 *   when the file is created rather than fixed up afterwards.
 * - **Values never appear in logs or errors.** Failures report the key, never the
 *   value, because plugin errors surface in diagnostics that admins can read.
 * - **Not encrypted at rest.** There is no key-management story to hang encryption on
 *   yet, and inventing one here would be security theatre: the decryption key would sit
 *   beside the ciphertext. This matches how built-in provider adapters already store
 *   `credentials.json`, so it is not a regression — but it does mean the file must be
 *   treated as sensitive, hence the mode and the separate path.
 *
 * Writes are serialized through a promise chain and go through a temp file + rename, so
 * a crash mid-write cannot leave a truncated vault.
 *
 * Once the instance is on `credentials.json`, a provider's secret fields are kept there
 * instead, one `opaque` credential per provider (docs/PROVIDER-SOURCING-DESIGN.md §15.7).
 * Only keys matching a field the plugin actually declares take that route — a vault key
 * is ambiguous on its own, because both contribution ids and field names may contain
 * dots — and every other secret stays here, so the plugin-facing keys do not change.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { backUpCredentialFiles } from "@server/lib/credential-backup";
import { type CredentialStore, getCredentialStore } from "@server/lib/credential-store";
import { ValidationError } from "@server/lib/errors";
import { logger } from "@server/lib/logger";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import {
	type ProviderSecretRef,
	pluginProviderSecrets,
	providerSecretKey,
	savePluginProviderSecrets,
} from "@server/lib/plugin-credentials";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_ENTRIES = 2_000;

export interface PluginSecretVaultOptions {
	root?: string;
	fileName?: string;
	/** Where provider secrets go when it is unified; without it every secret stays here. */
	credentials?: () => CredentialStore;
	/** The provider secret fields a plugin declares; wired by the platform services graph. */
	providerSecretFields?: (pluginId: string) => Iterable<ProviderSecretRef>;
}

interface VaultDocument {
	version: 1;
	/** `pluginId` → (`key` → value). */
	secrets: Record<string, Record<string, string>>;
}

function emptyDocument(): VaultDocument {
	return { version: 1, secrets: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse leniently: a corrupted vault degrades to "no secrets" rather than crashing the
 * host. Entries that are individually malformed are skipped so one bad record cannot
 * hide every other plugin's credentials.
 */
function parseDocument(raw: string): VaultDocument {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		logger.warn("Plugin secret vault is not valid JSON; treating it as empty");
		return emptyDocument();
	}
	if (!isRecord(parsed) || !isRecord(parsed.secrets)) return emptyDocument();
	const secrets: VaultDocument["secrets"] = {};
	for (const [pluginId, entries] of Object.entries(parsed.secrets)) {
		if (!isRecord(entries)) continue;
		const bucket: Record<string, string> = {};
		for (const [key, value] of Object.entries(entries)) {
			if (typeof value !== "string" || key.length > MAX_KEY_LENGTH) continue;
			bucket[key] = value;
		}
		secrets[pluginId] = bucket;
	}
	return { version: 1, secrets };
}

function assertKey(key: string): void {
	if (!key || key.length > MAX_KEY_LENGTH) {
		throw new ValidationError("Secret key is invalid");
	}
	// Keys land in a JSON object, so reject prototype-polluting names outright.
	if (key === "__proto__" || key === "prototype" || key === "constructor") {
		throw new ValidationError("Secret key is invalid");
	}
}

export class PluginSecretVault {
	readonly path: string;
	private readonly home: string;
	private document?: VaultDocument;
	private writeChain: Promise<unknown> = Promise.resolve();
	private readonly credentials?: () => CredentialStore;
	providerSecretFields?: (pluginId: string) => Iterable<ProviderSecretRef>;

	constructor(options: PluginSecretVaultOptions = {}) {
		const root = resolve(options.root ?? getNarraforkPath("plugins"));
		this.path = join(root, options.fileName ?? "secrets.json");
		this.home = dirname(root);
		this.credentials = options.credentials;
		this.providerSecretFields = options.providerSecretFields;
	}

	/** The store holding provider secrets, on an instance that uses `credentials.json`. */
	private providerStore(): CredentialStore | undefined {
		const store = this.credentials?.();
		return store?.unified ? store : undefined;
	}

	/** The declared provider field a key names, if any. */
	private declaredRef(pluginId: string, key: string): ProviderSecretRef | undefined {
		for (const ref of this.providerSecretFields?.(pluginId) ?? []) {
			if (providerSecretKey(ref) === key) return ref;
		}
		return undefined;
	}

	/**
	 * Where a provider secret lives when it is not in this file. A declared field routes
	 * there whether or not it is stored yet; a key that only matches a *stored* credential
	 * field still does, so a plugin that drops a field from its schema can read and clear
	 * the value it already saved.
	 */
	private providerSecret(pluginId: string, key: string) {
		const store = this.providerStore();
		if (!store) return undefined;
		const stored = pluginProviderSecrets(store, pluginId);
		let ref = this.declaredRef(pluginId, key);
		if (!ref) {
			for (const [contributionId, fields] of stored) {
				const field = Object.keys(fields).find(
					(name) => providerSecretKey({ contributionId, field: name }) === key,
				);
				if (field) {
					ref = { contributionId, field };
					break;
				}
			}
		}
		if (!ref) return undefined;
		const fields = stored.get(ref.contributionId) ?? {};
		const save = (next: Record<string, string>) =>
			savePluginProviderSecrets(store, [
				{ pluginId, contributionId: ref.contributionId, fields: next },
			]);
		return { field: ref.field, fields, save };
	}

	/** Remove the credentials of a plugin's providers that `keep` rejects; returns the fields removed. */
	private dropProviderCredentials(pluginId: string, keep: (contributionId: string) => boolean) {
		const store = this.providerStore();
		if (!store) return 0;
		const dropped = [...pluginProviderSecrets(store, pluginId)].filter(([id]) => !keep(id));
		if (dropped.length) {
			savePluginProviderSecrets(
				store,
				dropped.map(([contributionId]) => ({ pluginId, contributionId, fields: {} })),
			);
		}
		return dropped.reduce((count, [, fields]) => count + Object.keys(fields).length, 0);
	}

	/** This file's keys, with provider secrets taken from `credentials.json` when it holds them. */
	private keysOf(pluginId: string, document: VaultDocument): string[] {
		const keys = new Set(Object.keys(document.secrets[pluginId] ?? {}));
		const store = this.providerStore();
		if (!store) return [...keys];
		for (const [contributionId, fields] of pluginProviderSecrets(store, pluginId)) {
			for (const field of Object.keys(fields)) {
				keys.add(providerSecretKey({ contributionId, field }));
			}
		}
		return [...keys];
	}

	/** Drop vault copies of keys now held in `credentials.json`; returns whether any were there. */
	private async removeVaultKeys(
		document: VaultDocument,
		pluginId: string,
		keys: readonly string[],
	): Promise<boolean> {
		const bucket = document.secrets[pluginId];
		if (!bucket || !keys.some((key) => Object.hasOwn(bucket, key))) return false;
		const nextBucket = { ...bucket };
		for (const key of keys) delete nextBucket[key];
		const next: VaultDocument = {
			version: 1,
			secrets: { ...document.secrets, [pluginId]: nextBucket },
		};
		await this.persist(next);
		this.document = next;
		return true;
	}

	private async load(): Promise<VaultDocument> {
		if (this.document) return this.document;
		try {
			this.document = parseDocument(await readFile(this.path, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				logger.warn("Failed to read plugin secret vault; treating it as empty", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			this.document = emptyDocument();
		}
		return this.document;
	}

	/** Serialize writes so concurrent set/delete calls cannot interleave a lost update. */
	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.writeChain.then(task, task);
		// Swallow rejections on the chain itself; the caller still sees them via `run`.
		this.writeChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async persist(document: VaultDocument): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: DIR_MODE });
		const temp = `${this.path}.${process.pid}.tmp`;
		// `mode` on writeFile applies only at creation, which is what we need: the temp
		// file must never exist as world-readable, even briefly.
		await writeFile(temp, JSON.stringify(document), { encoding: "utf8", mode: FILE_MODE });
		try {
			await chmod(temp, FILE_MODE);
			await rename(temp, this.path);
		} catch (error) {
			await unlink(temp).catch(() => undefined);
			throw error;
		}
	}

	async setSecret(input: { pluginId: string; key: string; value: string }): Promise<void> {
		assertKey(input.key);
		if (typeof input.value !== "string" || input.value.length === 0) {
			throw new ValidationError("Secret value must be a non-empty string");
		}
		if (Buffer.byteLength(input.value, "utf8") > MAX_VALUE_BYTES) {
			throw new ValidationError("Secret value is too large");
		}
		await this.enqueue(async () => {
			const document = await this.load();
			const provider = this.providerSecret(input.pluginId, input.key);
			if (provider) {
				const stored = Object.hasOwn(provider.fields, provider.field);
				if (!stored && this.keysOf(input.pluginId, document).length >= MAX_ENTRIES) {
					throw new ValidationError("Too many secrets for this plugin");
				}
				provider.save({ ...provider.fields, [provider.field]: input.value });
				// A leftover vault copy would be imported again by a later migration.
				await this.removeVaultKeys(document, input.pluginId, [input.key]);
				return;
			}
			const bucket = { ...(document.secrets[input.pluginId] ?? {}) };
			if (!(input.key in bucket) && Object.keys(bucket).length >= MAX_ENTRIES) {
				throw new ValidationError("Too many secrets for this plugin");
			}
			bucket[input.key] = input.value;
			const next: VaultDocument = {
				version: 1,
				secrets: { ...document.secrets, [input.pluginId]: bucket },
			};
			await this.persist(next);
			this.document = next;
		});
	}

	async deleteSecret(input: { pluginId: string; key: string }): Promise<boolean> {
		assertKey(input.key);
		return this.enqueue(async () => {
			const document = await this.load();
			const provider = this.providerSecret(input.pluginId, input.key);
			if (provider) {
				const stored = Object.hasOwn(provider.fields, provider.field);
				if (stored) {
					const { [provider.field]: _removed, ...rest } = provider.fields;
					provider.save(rest);
				}
				const inVault = await this.removeVaultKeys(document, input.pluginId, [input.key]);
				return stored || inVault;
			}
			const bucket = document.secrets[input.pluginId];
			if (!bucket || !(input.key in bucket)) return false;
			const nextBucket = { ...bucket };
			delete nextBucket[input.key];
			const next: VaultDocument = {
				version: 1,
				secrets: { ...document.secrets, [input.pluginId]: nextBucket },
			};
			await this.persist(next);
			this.document = next;
			return true;
		});
	}

	/** Remove every secret for a plugin. Used when a plugin is uninstalled. */
	async deletePlugin(pluginId: string): Promise<number> {
		return this.enqueue(async () => {
			const credentials = this.dropProviderCredentials(pluginId, () => false);
			const document = await this.load();
			const bucket = document.secrets[pluginId];
			const count = bucket ? Object.keys(bucket).length : 0;
			if (count === 0) return credentials;
			const secrets = { ...document.secrets };
			delete secrets[pluginId];
			const next: VaultDocument = { version: 1, secrets };
			await this.persist(next);
			this.document = next;
			return credentials + count;
		});
	}

	/**
	 * Drop provider secrets whose contribution the plugin no longer declares.
	 *
	 * Provider config is pruned on every contribution refresh, but the credential lives
	 * here rather than in `state.json`. Without this, a secret for a removed provider
	 * would become unreachable config that only an uninstall can clear — and a provider
	 * later re-added under the same contribution id would silently inherit it.
	 *
	 * Only keys matching the `provider.<contributionId>.<field>` shape are considered.
	 * Anything else belongs to a different feature and is left untouched, because this
	 * method has no way to know whether it is still in use.
	 */
	async pruneProviderSecrets(
		pluginId: string,
		keepContributionIds: readonly string[],
	): Promise<number> {
		const keep = new Set(keepContributionIds);
		return this.enqueue(async () => {
			const credentials = this.dropProviderCredentials(pluginId, (id) => keep.has(id));
			const document = await this.load();
			const bucket = document.secrets[pluginId];
			if (!bucket) return credentials;
			const nextBucket: Record<string, string> = {};
			let removed = credentials;
			for (const [key, value] of Object.entries(bucket)) {
				// A key scoped to a retained provider stays, whatever its field is called;
				// the first segment alone cannot tell, because contribution ids may contain dots.
				const retained = keepContributionIds.some((id) => key.startsWith(`provider.${id}.`));
				const match = /^provider\.([^.]+)\./.exec(key);
				if (!retained && match && !keep.has(match[1])) {
					removed += 1;
					continue;
				}
				nextBucket[key] = value;
			}
			if (removed === credentials) return removed;
			const next: VaultDocument = {
				version: 1,
				secrets: { ...document.secrets, [pluginId]: nextBucket },
			};
			await this.persist(next);
			this.document = next;
			return removed;
		});
	}

	/**
	 * Move one plugin's provider secrets into `credentials.json`, once its contributions
	 * are registered and so can be told apart (startup calls this from the same pass that
	 * prunes provider config). Backup, then credentials, then the vault without them: a
	 * crash in between is finished on the next pass, where a credential already present
	 * wins over the vault's copy. Keys that name no declared field stay here.
	 */
	async migrateProviderSecrets(pluginId: string): Promise<number> {
		const store = this.providerStore();
		if (!store?.readable || !this.providerSecretFields) return 0;
		return this.enqueue(async () => {
			const document = await this.load();
			const bucket = document.secrets[pluginId];
			if (!bucket) return 0;
			const moved: Array<{ ref: ProviderSecretRef; key: string; value: string }> = [];
			for (const [key, value] of Object.entries(bucket)) {
				const ref = this.declaredRef(pluginId, key);
				if (ref) moved.push({ ref, key, value });
			}
			if (!moved.length) return 0;

			const backup = backUpCredentialFiles(this.home, "pre-plugin-credentials", [
				relative(this.home, this.path),
			]);
			// Merge field by field: an existing credential value wins, but a field the
			// plugin only just declared is still moved out of the vault.
			const existing = pluginProviderSecrets(store, pluginId);
			const changes = new Map<string, Record<string, string>>();
			for (const { ref, value } of moved) {
				const current = changes.get(ref.contributionId) ?? existing.get(ref.contributionId);
				if (current && Object.hasOwn(current, ref.field)) continue;
				const fields = changes.get(ref.contributionId) ?? { ...current };
				fields[ref.field] = value;
				changes.set(ref.contributionId, fields);
			}
			if (changes.size) {
				savePluginProviderSecrets(
					store,
					[...changes].map(([contributionId, fields]) => ({ pluginId, contributionId, fields })),
				);
			}
			await this.removeVaultKeys(
				document,
				pluginId,
				moved.map((m) => m.key),
			);
			logger.info("Moved plugin provider secrets to credentials.json", {
				pluginId,
				providers: changes.size,
				backup,
			});
			return changes.size;
		});
	}

	async getSecret(input: { pluginId: string; key: string }): Promise<string | undefined> {
		assertKey(input.key);
		const provider = this.providerSecret(input.pluginId, input.key);
		if (provider) {
			return Object.hasOwn(provider.fields, provider.field)
				? provider.fields[provider.field]
				: undefined;
		}
		const document = await this.load();
		return document.secrets[input.pluginId]?.[input.key];
	}

	async hasSecret(input: { pluginId: string; key: string }): Promise<boolean> {
		return (await this.getSecret(input)) !== undefined;
	}

	/** Key names only — never values, so this is safe to surface to an admin UI. */
	async listKeys(pluginId: string): Promise<string[]> {
		return this.keysOf(pluginId, await this.load()).sort();
	}

	/**
	 * Key names already in memory, or `undefined` when the vault has not been read yet.
	 *
	 * Exists for one caller shape: deciding whether a credential is present on a synchronous
	 * hot path. `getNormalizedSearchChannels()` runs on every tool execution and every
	 * provider request-body build, so the plugin search registry cannot await a vault read
	 * there. The document is loaded once and then kept (writes replace it), so after any
	 * earlier vault access this answers exactly; before that it answers "unknown" and the
	 * caller decides what to assume.
	 *
	 * Returns key names only, never values.
	 */
	peekKeys(pluginId: string): string[] | undefined {
		if (!this.document) return undefined;
		return this.keysOf(pluginId, this.document);
	}

	/** Load the vault into memory so `peekKeys` can answer. Safe to call repeatedly. */
	async warm(): Promise<void> {
		await this.load();
	}
}

/** Shared vault instance used by the platform services graph. */
export const pluginSecretVault = new PluginSecretVault({ credentials: () => getCredentialStore() });
