/**
 * One-time move of model credentials into `credentials.json`
 * (docs/PROVIDER-SOURCING-DESIGN.md §15.8).
 *
 * Runs on the first settings load, before either credential owner is created. Without
 * `credentials.json`, Codex accounts (`codex-credentials.json`) and model keys
 * (`provider-keys.json`) are read, given the ids requests are already billed to, backed
 * up, and written to the new file in one atomic write. Its existence switches the
 * instance over; the old files are then emptied of model credentials (search keys stay in
 * `provider-keys.json`). A file that cannot be read, or two credentials that would share
 * an id, stop the migration before anything is written: the old files stay in use and
 * the next start tries again. Settings are not read: every owner id names its connection.
 *
 * On a unified instance, plugin provider secrets then move out of the plugin vault (§15.7).
 */
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import {
	CODEX_CREDENTIALS_FILE,
	codexToCredential,
	legacyCodexRuntimeState,
	parseStoredCodexCredentials,
} from "./codex-manager";
import { CREDENTIAL_STATE_FILE, CredentialStateStore } from "./credential-state";
import { CODEX_GROUP, type CredentialStore, getCredentialStore } from "./credential-store";
import { logger } from "./logger";
import { getNarraforkHome } from "./narrafork-home";
import {
	type PluginProviderSecretsChange,
	parseProviderSecretKey,
	pluginProviderSecrets,
	savePluginProviderSecrets,
} from "./plugin-credentials";
import {
	isSearchKeyOwner,
	keyOwnerGroup,
	keyPartOf,
	PROVIDER_KEYS_FILE,
	type ProviderKey,
	parseStoredProviderKeys,
} from "./provider-keys";
import { readSecretJSON, writeSecretJSON } from "./secret-store";

export const CREDENTIAL_BACKUPS_DIR = "credential-backups";
const BACKED_UP_FILES = [
	"settings.json",
	CODEX_CREDENTIALS_FILE,
	PROVIDER_KEYS_FILE,
	CREDENTIAL_STATE_FILE,
	"codex-stats.json",
];

/** What a credential belongs to: Codex, a custom API / NUG connection, or TokenDance / Command Code. */
export type CredentialSourceKind = "codex" | "api" | "nug" | "builtin";

export interface CredentialSource {
	groupId: string;
	kind: CredentialSourceKind;
	label?: string;
}

/** An id held by more than one credential, or a group id shared by different kinds of source. */
export interface CredentialIdConflict {
	id: string;
	sources: CredentialSource[];
}

export type CredentialMigrationResult =
	| "unified"
	| "migrated"
	| "nothing"
	| "unreadable"
	| "conflict"
	| "failed";

let lastConflicts: CredentialIdConflict[] = [];

/** Conflicts that stopped this start's migration; shown on the providers page. */
export function getCredentialMigrationConflicts(): readonly CredentialIdConflict[] {
	return lastConflicts;
}

const SECRET_OWNER = /^(quota|nug-oauth):/;

/**
 * Billing ids, by §15.3: Codex accounts and pooled keys keep theirs; a NUG, TokenDance or
 * Command Code key takes its group id; a connection whose requests are billed to the
 * connection itself (one enabled key, the first, without its own network identity — see
 * `registerCredentialProviderSource` in agent/provider.ts) gives that key the connection id,
 * unless another credential already has it.
 */
export function assignCredentialIds(
	accountIds: readonly string[],
	keys: readonly ProviderKey[],
): ProviderKey[] {
	const inference = keys.filter((k) => !SECRET_OWNER.test(k.providerId));
	const ids = new Map<ProviderKey, string>();
	for (const key of inference) {
		const group = keyOwnerGroup(key.providerId);
		ids.set(key, group === key.providerId ? key.id : group);
	}
	const connections = Map.groupBy(
		inference.filter((k) => keyOwnerGroup(k.providerId) === k.providerId),
		(k) => k.providerId,
	);
	for (const [connectionId, list] of connections) {
		const sorted = [...list].sort((a, b) => a.priority - b.priority);
		const usable = sorted.filter((k) => !k.disabled);
		const only = usable.length === 1 ? usable[0] : undefined;
		if (!only || only.network || only.apiKey !== sorted[0]?.apiKey) continue;
		if (only.id === connectionId) continue;
		const taken =
			accountIds.includes(connectionId) ||
			[...ids].some(([other, id]) => other !== only && id === connectionId);
		if (taken) {
			logger.warn("Credential migration kept a key's id: its connection id is taken", {
				connectionId,
				keyId: only.id,
			});
			continue;
		}
		ids.set(only, connectionId);
	}
	return keys.map((key) => ({ ...key, id: ids.get(key) ?? key.id }));
}

function findConflicts(sources: ReadonlyArray<CredentialSource & { id: string }>) {
	const conflicts: CredentialIdConflict[] = [];
	const describe = ({ id: _id, ...source }: CredentialSource & { id: string }) => source;
	for (const [id, list] of Map.groupBy(sources, (s) => s.id)) {
		if (list.length > 1) conflicts.push({ id, sources: list.map(describe) });
	}
	// Keys file under their group id alone, so two kinds of connection cannot share one.
	for (const [groupId, list] of Map.groupBy(sources, (s) => s.groupId)) {
		if (new Set(list.map((s) => s.kind)).size > 1 && !conflicts.some((c) => c.id === groupId)) {
			conflicts.push({ id: groupId, sources: list.map(describe) });
		}
	}
	return conflicts;
}

const sourceKind = (owner: string): CredentialSourceKind =>
	owner.startsWith("nug:") ? "nug" : owner.startsWith("builtin:") ? "builtin" : "api";

/** Copy the files a migration reads or changes; owner-only, like the originals. */
function backUp(home: string, label: string, files: readonly string[]): string {
	const root = resolve(home, CREDENTIAL_BACKUPS_DIR);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	// A retry after a failed attempt never writes into an earlier backup.
	let dir = resolve(root, `${label}-${stamp}`);
	for (let n = 2; existsSync(dir); n++) dir = resolve(root, `${label}-${stamp}-${n}`);
	mkdirSync(dir, { mode: 0o700 });
	for (const path of [root, dir]) chmodPrivate(path, 0o700);
	for (const name of files) {
		const source = resolve(home, name);
		if (!existsSync(source)) continue;
		const target = resolve(dir, basename(name));
		copyFileSync(source, target);
		chmodPrivate(target, 0o600);
	}
	return dir;
}

function chmodPrivate(path: string, mode: number): void {
	if (process.platform === "win32") return;
	try {
		chmodSync(path, mode);
	} catch {
		/* Network filesystems can reject chmod. */
	}
}

/** Usage and blocks an older Codex file still keeps inside credentials; credentials.json has no room. */
function moveCodexRuntimeState(
	home: string,
	accounts: ReturnType<typeof parseStoredCodexCredentials>,
) {
	const state = new CredentialStateStore(resolve(home, CREDENTIAL_STATE_FILE), 0);
	let moved = false;
	for (const account of accounts) {
		const legacy = legacyCodexRuntimeState(account);
		if (!legacy) continue;
		const existing = state.get(account.id);
		// As CodexManager loads it: the credential's own values win, a manual stop outranks a block.
		state.set(account.id, {
			...existing,
			usage: legacy.usage ?? existing?.usage,
			usageHistory: legacy.usageHistory ?? existing?.usageHistory,
			blocked: account.disabled ? legacy.blocked : existing?.blocked,
		});
		moved = true;
	}
	if (moved) state.flush();
}

/** The old files without model credentials. Idempotent: a crash mid-way is finished next start. */
function cleanUp(home: string): void {
	const keysPath = resolve(home, PROVIDER_KEYS_FILE);
	if (existsSync(keysPath)) {
		try {
			const keys = parseStoredProviderKeys(readSecretJSON(keysPath));
			const search = keys.filter((k) => isSearchKeyOwner(k.providerId));
			if (search.length !== keys.length) {
				if (search.length) writeSecretJSON(keysPath, search);
				else unlinkSync(keysPath);
			}
		} catch (error) {
			logger.warn("provider-keys.json still holds migrated keys; it could not be read", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const codexPath = resolve(home, CODEX_CREDENTIALS_FILE);
	if (existsSync(codexPath)) unlinkSync(codexPath);
}

export const PLUGIN_SECRETS_FILE = "plugins/secrets.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

/**
 * Move the plugin vault's provider secrets into `credentials.json`, other plugin secrets
 * stay. Backup, then credentials, then the vault without them: a crash in between is
 * finished next start, where a credential already present wins over the vault's copy.
 */
export function movePluginProviderSecrets(home: string, store: CredentialStore): number {
	const path = resolve(home, PLUGIN_SECRETS_FILE);
	if (!existsSync(path)) return 0;
	let vault: Record<string, unknown>;
	try {
		vault = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(vault) || !isRecord(vault.secrets)) throw new Error("not a plugin vault");
	} catch (error) {
		logger.error("Plugin provider secrets stay in the plugin vault: it could not be read", {
			error: error instanceof Error ? error.message : String(error),
		});
		return 0;
	}
	const secrets = vault.secrets as Record<string, unknown>;
	const found = new Map<string, PluginProviderSecretsChange>();
	const kept: Record<string, Record<string, unknown>> = {};
	for (const [pluginId, bucket] of Object.entries(secrets)) {
		if (!isRecord(bucket)) continue;
		const rest: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(bucket)) {
			const parsed = parseProviderSecretKey(key);
			if (!parsed || typeof value !== "string") {
				rest[key] = value;
				continue;
			}
			const id = `${pluginId}/${parsed.contributionId}`;
			const change = found.get(id) ?? {
				pluginId,
				contributionId: parsed.contributionId,
				fields: {},
			};
			change.fields[parsed.field] = value;
			found.set(id, change);
		}
		kept[pluginId] = rest;
	}
	if (!found.size) return 0;

	const backup = backUp(home, "pre-plugin-credentials", [PLUGIN_SECRETS_FILE]);
	const changes = [...found.values()].filter(
		(c) => !pluginProviderSecrets(store, c.pluginId).has(c.contributionId),
	);
	if (changes.length) savePluginProviderSecrets(store, changes);
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify({ ...vault, secrets: { ...secrets, ...kept } }), {
		mode: 0o600,
	});
	chmodPrivate(temp, 0o600);
	renameSync(temp, path);
	logger.info("Moved plugin provider secrets to credentials.json", {
		providers: changes.length,
		backup,
	});
	return changes.length;
}

function movePluginSecretsSafely(home: string, store: CredentialStore): void {
	try {
		movePluginProviderSecrets(home, store);
	} catch (error) {
		logger.error("Moving plugin provider secrets failed; they stay in the plugin vault", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function migrateCredentialFiles(home = getNarraforkHome()): CredentialMigrationResult {
	lastConflicts = [];
	try {
		const store = getCredentialStore(home);
		if (store.unified) {
			if (store.readable) {
				cleanUp(home);
				movePluginSecretsSafely(home, store);
			}
			return "unified";
		}

		let codexRaw: unknown;
		let keysRaw: unknown;
		try {
			codexRaw = readSecretJSON(resolve(home, CODEX_CREDENTIALS_FILE));
			keysRaw = readSecretJSON(resolve(home, PROVIDER_KEYS_FILE));
		} catch (error) {
			logger.error("Credential migration skipped: a credential file could not be read", {
				error: error instanceof Error ? error.message : String(error),
			});
			return "unreadable";
		}
		const accounts = parseStoredCodexCredentials(codexRaw);
		const keys = parseStoredProviderKeys(keysRaw).filter((k) => !isSearchKeyOwner(k.providerId));
		if (!accounts.length && !keys.length) return "nothing";

		const assigned = assignCredentialIds(
			accounts.map((a) => a.id),
			keys,
		);
		const conflicts = findConflicts([
			...accounts.map((a) => ({
				id: a.id,
				groupId: CODEX_GROUP,
				kind: "codex" as const,
				...(a.displayName ? { label: a.displayName } : {}),
			})),
			...assigned
				.filter((k) => !SECRET_OWNER.test(k.providerId))
				.map((k) => ({
					id: k.id,
					groupId: keyOwnerGroup(k.providerId),
					kind: sourceKind(k.providerId),
					...(k.label ? { label: k.label } : {}),
				})),
		]);
		if (conflicts.length) {
			lastConflicts = conflicts;
			logger.error("Credential migration stopped: credentials share an id", { conflicts });
			return "conflict";
		}

		const now = Date.now();
		const part = keyPartOf(assigned);
		const credentials = [
			...accounts.map((account) => codexToCredential(account, now)),
			...part.credentials,
		];
		const backup = backUp(home, "pre-sourcing", BACKED_UP_FILES);
		moveCodexRuntimeState(home, accounts);
		store.create({ version: 1, credentials, groupSecrets: part.groupSecrets });
		cleanUp(home);
		movePluginSecretsSafely(home, store);
		logger.info("Moved model credentials to credentials.json", {
			codex: credentials.filter((c) => c.target.groupId === CODEX_GROUP).length,
			keys: part.credentials.length,
			backup,
		});
		return "migrated";
	} catch (error) {
		logger.error("Credential migration failed; the old credential files stay in use", {
			error: error instanceof Error ? error.message : String(error),
		});
		return "failed";
	}
}
