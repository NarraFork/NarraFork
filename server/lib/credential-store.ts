/**
 * `credentials.json`: every model credential of this instance in one encrypted file
 * (docs/PROVIDER-SOURCING-DESIGN.md §15.3).
 *
 * Three owners keep credentials in memory: CodexManager (the `codex` group's accounts), the
 * provider key store (API keys of every other group, plus the group secrets) and the plugin
 * secret vault (each plugin provider's secret fields, §15.7). Each hands its part here when
 * it saves; the file is written from every part as it was last saved, so none can write
 * over another's changes. One instance per NarraFork home.
 *
 * The file existing is the mode switch: without it both owners keep reading and writing
 * their old files (`codex-credentials.json`, `provider-keys.json`), and the startup
 * migration (credential-migration.ts) creates it once.
 *
 * Leaf module: it must not import settings or either owner.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CredentialNetwork } from "@shared/credential-network";
import { logger } from "./logger";
import { getNarraforkHome } from "./narrafork-home";
import {
	onSecretEncryptionChange,
	readSecretJSON,
	SecretStoreError,
	writeSecretJSON,
} from "./secret-store";

export const CREDENTIALS_FILE = "credentials.json";
export const CODEX_GROUP = "codex";

export type CredentialAuth =
	| { kind: "api_key"; apiKey: string }
	| { kind: "oauth"; refreshToken?: string; accessToken?: string; expiresAt?: number }
	| { kind: "pat"; accessToken: string }
	| { kind: "agent_identity"; agentRuntimeId: string; agentPrivateKey: string; taskId?: string }
	| { kind: "opaque"; fields: Record<string, string> };

export interface Credential {
	id: string;
	/**
	 * A plugin provider is not a source group of its own record: its group id (the provider
	 * instance id) changes with every plugin upgrade, so it is named by `<pluginId>/<contributionId>`.
	 */
	target:
		| { groupId: string; pluginContributionId?: never }
		| { pluginContributionId: string; groupId?: never };
	/** null = team credential; nothing else exists before personal sources. */
	ownerUserId: null;
	label?: string;
	/** Order within the group, smaller first. */
	priority: number;
	createdAt: number;
	archivedAt?: number;
	disabled?: boolean;
	disabledReason?: "manual" | "invalid" | "banned";
	network?: CredentialNetwork;
	auth: CredentialAuth;
	account?: { accountId?: string; email?: string; sub?: string; fedramp?: boolean };
	options?: { useCreditQuota?: boolean };
}

/** Secrets of a group that are not inference credentials. */
export interface GroupSecrets {
	quotaAccessToken?: string;
	oauthClientSecret?: string;
}

export interface CredentialsFile {
	version: 1;
	credentials: Credential[];
	groupSecrets: Record<string, GroupSecrets>;
}

export interface KeyPart {
	credentials: Credential[];
	groupSecrets: Record<string, GroupSecrets>;
}

type Part = "codex" | "keys" | "plugins";

/**
 * Codex accounts sign in, plugin providers hold a field bag, every other credential is an
 * API key. Telling them apart by sign-in kind rather than group id keeps a connection that
 * happens to be called `codex` with the keys.
 */
const partOf = (credential: Credential): Part =>
	credential.auth.kind === "api_key"
		? "keys"
		: credential.auth.kind === "opaque"
			? "plugins"
			: "codex";

function parseFile(raw: unknown): CredentialsFile {
	const value = (raw ?? {}) as Partial<CredentialsFile>;
	const credentials = Array.isArray(value.credentials)
		? value.credentials.filter(
				(c): c is Credential =>
					!!c &&
					typeof c.id === "string" &&
					!!c.id &&
					(typeof c.target?.groupId === "string" ||
						typeof c.target?.pluginContributionId === "string") &&
					!!c.auth &&
					typeof c.auth === "object",
			)
		: [];
	const groupSecrets =
		value.groupSecrets && typeof value.groupSecrets === "object" ? value.groupSecrets : {};
	return { version: 1, credentials, groupSecrets };
}

export class CredentialStore {
	readonly path: string;
	private codexPart: Credential[] = [];
	private keyPart: KeyPart = { credentials: [], groupSecrets: {} };
	private pluginPart: Credential[] = [];
	private exists: boolean;
	private unreadable = false;

	constructor(dir: string) {
		this.path = resolve(dir, CREDENTIALS_FILE);
		this.exists = existsSync(this.path);
		if (!this.exists) return;
		try {
			this.split(parseFile(readSecretJSON(this.path)));
		} catch (error) {
			// Never write over a file we could not read: it is the only copy.
			this.unreadable = true;
			logger.error("Credentials are unreadable; leaving the file untouched", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Whether `credentials.json` is in use; otherwise the owners use their old files. */
	get unified(): boolean {
		return this.exists;
	}

	get readable(): boolean {
		return !this.unreadable;
	}

	codexCredentials(): Credential[] {
		return structuredClone(this.codexPart);
	}

	keyCredentials(): KeyPart {
		return structuredClone(this.keyPart);
	}

	pluginCredentials(): Credential[] {
		return structuredClone(this.pluginPart);
	}

	/** Ids are unique across every part; an owner adding a given id asks here first. */
	hasId(id: string): boolean {
		return [...this.codexPart, ...this.keyPart.credentials, ...this.pluginPart].some(
			(c) => c.id === id,
		);
	}

	// Each save writes the proposed part first and only then publishes it: a failed write
	// must not leave an edit the caller saw rejected live in memory, where the next
	// owner's save would persist it.
	saveCodex(credentials: Credential[]): void {
		const next = structuredClone(credentials);
		this.write(next, this.keyPart, this.pluginPart);
		this.codexPart = next;
	}

	saveKeys(part: KeyPart): void {
		const next = structuredClone(part);
		this.write(this.codexPart, next, this.pluginPart);
		this.keyPart = next;
	}

	savePlugins(credentials: Credential[]): void {
		const next = structuredClone(credentials);
		this.write(this.codexPart, this.keyPart, next);
		this.pluginPart = next;
	}

	/** The migration's single write: from here on the instance uses this file. */
	create(file: CredentialsFile): void {
		if (this.exists) throw new Error(`${CREDENTIALS_FILE} already exists`);
		this.split(file);
		this.write(this.codexPart, this.keyPart, this.pluginPart);
		this.exists = true;
	}

	private split(file: CredentialsFile): void {
		const parts = Map.groupBy(file.credentials, partOf);
		this.codexPart = parts.get("codex") ?? [];
		this.keyPart = { credentials: parts.get("keys") ?? [], groupSecrets: file.groupSecrets };
		this.pluginPart = parts.get("plugins") ?? [];
	}

	/** Rewrite in the current encryption form. */
	rewrite(): void {
		if (this.exists && this.readable && existsSync(this.path)) {
			this.write(this.codexPart, this.keyPart, this.pluginPart);
		}
	}

	private write(codex: Credential[], keys: KeyPart, plugins: Credential[]): void {
		if (this.unreadable) {
			throw new SecretStoreError(
				"Credentials on this server could not be read; nothing was changed",
			);
		}
		const file: CredentialsFile = {
			version: 1,
			credentials: [...codex, ...keys.credentials, ...plugins],
			groupSecrets: keys.groupSecrets,
		};
		writeSecretJSON(this.path, file);
	}
}

const stores = new Map<string, { store: CredentialStore; stopRewrite: () => void }>();

/** The store of one NarraFork home (default: this instance's). */
export function getCredentialStore(dir = getNarraforkHome()): CredentialStore {
	const key = resolve(dir);
	let entry = stores.get(key);
	if (!entry) {
		const store = new CredentialStore(key);
		entry = { store, stopRewrite: onSecretEncryptionChange(() => store.rewrite()) };
		stores.set(key, entry);
	}
	return entry.store;
}

/** Tests only: forget every store so files written behind its back are read again. */
export function resetCredentialStoresForTests(): void {
	for (const entry of stores.values()) entry.stopRewrite();
	stores.clear();
}
