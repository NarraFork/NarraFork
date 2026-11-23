/**
 * `credentials.json`: every model credential of this instance in one encrypted file
 * (docs/PROVIDER-SOURCING-DESIGN.md §15.3).
 *
 * Two owners keep credentials in memory: CodexManager (the `codex` group's accounts) and the
 * provider key store (API keys of every other group, plus the group secrets). Each hands its part here when it
 * saves; the file is written from both parts as they were last saved, so neither can write
 * over the other's changes. One instance per NarraFork home.
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
	| { kind: "agent_identity"; agentRuntimeId: string; agentPrivateKey: string; taskId?: string };

export interface Credential {
	id: string;
	target: { groupId: string };
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

/**
 * Codex accounts sign in; every other credential is an API key. Telling them apart by
 * sign-in kind rather than group id keeps a connection that happens to be called `codex`
 * with the keys.
 */
const isCodex = (credential: Credential) => credential.auth.kind !== "api_key";

function parseFile(raw: unknown): CredentialsFile {
	const value = (raw ?? {}) as Partial<CredentialsFile>;
	const credentials = Array.isArray(value.credentials)
		? value.credentials.filter(
				(c): c is Credential =>
					!!c &&
					typeof c.id === "string" &&
					!!c.id &&
					typeof c.target?.groupId === "string" &&
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
	private exists: boolean;
	private unreadable = false;

	constructor(dir: string) {
		this.path = resolve(dir, CREDENTIALS_FILE);
		this.exists = existsSync(this.path);
		if (!this.exists) return;
		try {
			const file = parseFile(readSecretJSON(this.path));
			this.codexPart = file.credentials.filter(isCodex);
			this.keyPart = {
				credentials: file.credentials.filter((c) => !isCodex(c)),
				groupSecrets: file.groupSecrets,
			};
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

	/** Ids are unique across both parts; an owner adding a given id asks here first. */
	hasId(id: string): boolean {
		return (
			this.codexPart.some((c) => c.id === id) || this.keyPart.credentials.some((c) => c.id === id)
		);
	}

	saveCodex(credentials: Credential[]): void {
		this.codexPart = structuredClone(credentials);
		this.write();
	}

	saveKeys(part: KeyPart): void {
		this.keyPart = structuredClone(part);
		this.write();
	}

	/** The migration's single write: from here on the instance uses this file. */
	create(file: CredentialsFile): void {
		if (this.exists) throw new Error(`${CREDENTIALS_FILE} already exists`);
		this.codexPart = file.credentials.filter(isCodex);
		this.keyPart = {
			credentials: file.credentials.filter((c) => !isCodex(c)),
			groupSecrets: file.groupSecrets,
		};
		this.write();
		this.exists = true;
	}

	/** Rewrite in the current encryption form. */
	rewrite(): void {
		if (this.exists && this.readable && existsSync(this.path)) this.write();
	}

	private write(): void {
		if (this.unreadable) {
			throw new SecretStoreError(
				"Credentials on this server could not be read; nothing was changed",
			);
		}
		const file: CredentialsFile = {
			version: 1,
			credentials: [...this.codexPart, ...this.keyPart.credentials],
			groupSecrets: this.keyPart.groupSecrets,
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
