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
 *   `credentials.json`, so it is not a regression — but it does mean the file must be
 *   treated as sensitive, hence the mode and the separate path.
 *
 * Writes are serialized through a promise chain and go through a temp file + rename, so
 * a crash mid-write cannot leave a truncated vault.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ValidationError } from "@server/lib/errors";
import { logger } from "@server/lib/logger";
import { getNarraforkPath } from "@server/lib/narrafork-home";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_ENTRIES = 2_000;

export interface PluginSecretVaultOptions {
	root?: string;
	fileName?: string;
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
	private document?: VaultDocument;
	private writeChain: Promise<unknown> = Promise.resolve();

	constructor(options: PluginSecretVaultOptions = {}) {
		const root = resolve(options.root ?? getNarraforkPath("plugins"));
		this.path = join(root, options.fileName ?? "secrets.json");
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
			const document = await this.load();
			const bucket = document.secrets[pluginId];
			const count = bucket ? Object.keys(bucket).length : 0;
			if (count === 0) return 0;
			const secrets = { ...document.secrets };
			delete secrets[pluginId];
			const next: VaultDocument = { version: 1, secrets };
			await this.persist(next);
			this.document = next;
			return count;
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
			const document = await this.load();
			const bucket = document.secrets[pluginId];
			if (!bucket) return 0;
			const nextBucket: Record<string, string> = {};
			let removed = 0;
			for (const [key, value] of Object.entries(bucket)) {
				const match = /^provider\.([^.]+)\./.exec(key);
				if (match && !keep.has(match[1])) {
					removed += 1;
					continue;
				}
				nextBucket[key] = value;
			}
			if (removed === 0) return 0;
			const next: VaultDocument = {
				version: 1,
				secrets: { ...document.secrets, [pluginId]: nextBucket },
			};
			await this.persist(next);
			this.document = next;
			return removed;
		});
	}

	async getSecret(input: { pluginId: string; key: string }): Promise<string | undefined> {
		assertKey(input.key);
		const document = await this.load();
		return document.secrets[input.pluginId]?.[input.key];
	}

	async hasSecret(input: { pluginId: string; key: string }): Promise<boolean> {
		return (await this.getSecret(input)) !== undefined;
	}

	/** Key names only — never values, so this is safe to surface to an admin UI. */
	async listKeys(pluginId: string): Promise<string[]> {
		const document = await this.load();
		return Object.keys(document.secrets[pluginId] ?? {}).sort();
	}
}

/** Shared vault instance used by the platform services graph. */
export const pluginSecretVault = new PluginSecretVault();
