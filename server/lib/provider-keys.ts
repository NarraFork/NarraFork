/**
 * API keys of model and search providers, kept out of settings.json.
 *
 * A custom API provider (Kimi Code, OpenCode Go, DeepSeek, relays …) can hold several
 * keys, filed under its own id. NUG providers, TokenDance, Command Code and custom search
 * providers hold one key each, filed under a namespaced owner id (`nug:<id>`, …). They live
 * here, written through the secret store: model keys in `credentials.json` once the
 * instance uses it (credential-store.ts), search keys always in `provider-keys.json`;
 * before that, all of them in `provider-keys.json`. The settings module keeps a
 * projection: in memory each entry's `apiKey` is its first key, so code that reads a
 * single key keeps working, and writing that field edits the first key (see
 * settings/provider-keys-projection.ts). Runtime selection among keys is in
 * agent/pooled-provider.ts.
 *
 * Callers name owners the old way in both modes. In `credentials.json` a key belongs to
 * its group (`nug:<id>` → `<id>`, `builtin:tokendance` → `tokendance`), and the site
 * token / NUG OAuth secret are group secrets rather than credentials; that translation
 * stays in this module.
 *
 * Leaf module: it must not import settings, which depends on it.
 */
import { existsSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { CredentialNetwork } from "@shared/credential-network";
import {
	type Credential,
	type CredentialStore,
	type GroupSecrets,
	getCredentialStore,
	type KeyPart,
	resetCredentialStoresForTests,
} from "./credential-store";
import { generateShortId } from "./id";
import { logger } from "./logger";
import { getNarraforkPath } from "./narrafork-home";
import {
	onSecretEncryptionChange,
	readSecretJSON,
	SecretStoreError,
	writeSecretJSON,
} from "./secret-store";
import type { ProxyOverride } from "./settings/types";

export const PROVIDER_KEYS_FILE = "provider-keys.json";

// Custom API provider ids are nanoids, which never contain ":", so these cannot collide.
export const TOKENDANCE_KEY_OWNER = "builtin:tokendance";
export const COMMAND_CODE_KEY_OWNER = "builtin:CommandCode";
export const nugKeyOwner = (providerId: string) => `nug:${providerId}`;
export const nugOAuthKeyOwner = (providerId: string) => `nug-oauth:${providerId}`;
export const searchKeyOwner = (providerId: string) => `search:${providerId}`;
export const quotaKeyOwner = (providerId: string) => `quota:${providerId}`;

/** Owner prefixes of group secrets, by the field they fill. */
const SECRET_OWNERS = [
	["quota:", "quotaAccessToken"],
	["nug-oauth:", "oauthClientSecret"],
] as const satisfies ReadonlyArray<readonly [string, keyof GroupSecrets]>;

export const isSearchKeyOwner = (owner: string) => owner.startsWith("search:");

/** The credential group an owner id names; secret and search owners stay as they are. */
export function keyOwnerGroup(owner: string): string {
	if (owner.startsWith("nug:")) return owner.slice("nug:".length);
	if (owner === TOKENDANCE_KEY_OWNER) return "tokendance";
	if (owner === COMMAND_CODE_KEY_OWNER) return "CommandCode";
	return owner;
}

export type ProviderKeyDisabledReason = "manual" | "invalid";

export interface ProviderKey {
	id: string;
	providerId: string;
	apiKey: string;
	label?: string;
	/** Order within the provider; the first key is the one settings shows. */
	priority: number;
	disabled?: boolean;
	/** `invalid`: upstream rejected the key (401/403) and it stays off until edited. */
	disabledReason?: ProviderKeyDisabledReason;
	/** Proxy, client fingerprint and headers for this key; absent fields follow the provider. */
	network?: CredentialNetwork;
	createdAt: number;
}

function normalize(raw: unknown): ProviderKey | null {
	if (!raw || typeof raw !== "object") return null;
	const k = raw as Partial<ProviderKey>;
	if (typeof k.id !== "string" || !k.id) return null;
	if (typeof k.providerId !== "string" || !k.providerId) return null;
	if (typeof k.apiKey !== "string" || !k.apiKey) return null;
	return {
		id: k.id,
		providerId: k.providerId,
		apiKey: k.apiKey,
		...(typeof k.label === "string" && k.label ? { label: k.label } : {}),
		priority: Number.isFinite(k.priority) ? Number(k.priority) : 0,
		...(k.disabled ? { disabled: true } : {}),
		...(k.disabled && k.disabledReason ? { disabledReason: k.disabledReason } : {}),
		...(k.network && typeof k.network === "object" ? { network: k.network } : {}),
		createdAt: Number.isFinite(k.createdAt) ? Number(k.createdAt) : Date.now(),
	};
}

const byPriority = (a: ProviderKey, b: ProviderKey) => a.priority - b.priority;

/** The entries of a `provider-keys.json`, as loading keeps them. */
export function parseStoredProviderKeys(raw: unknown): ProviderKey[] {
	const keys: ProviderKey[] = [];
	if (!Array.isArray(raw)) return keys;
	const seen = new Set<string>();
	for (const item of raw) {
		const key = normalize(item);
		if (key && !seen.has(key.id)) {
			seen.add(key.id);
			keys.push(key);
		}
	}
	return keys;
}

function keyToCredential(key: ProviderKey, groupId = key.providerId): Credential {
	return {
		id: key.id,
		target: { groupId },
		ownerUserId: null,
		...(key.label ? { label: key.label } : {}),
		priority: key.priority,
		createdAt: key.createdAt,
		...(key.disabled ? { disabled: true } : {}),
		...(key.disabled && key.disabledReason ? { disabledReason: key.disabledReason } : {}),
		...(key.network ? { network: key.network } : {}),
		auth: { kind: "api_key", apiKey: key.apiKey },
	};
}

/** In memory a key's `providerId` is its group, or its secret owner for group secrets. */
function keysFromPart(part: KeyPart): ProviderKey[] {
	const keys: ProviderKey[] = [];
	for (const c of part.credentials) {
		if (c.auth.kind !== "api_key" || !c.target.groupId) continue;
		keys.push({
			id: c.id,
			providerId: c.target.groupId,
			apiKey: c.auth.apiKey,
			...(c.label ? { label: c.label } : {}),
			priority: c.priority,
			...(c.disabled ? { disabled: true } : {}),
			...(c.disabled && (c.disabledReason === "manual" || c.disabledReason === "invalid")
				? { disabledReason: c.disabledReason }
				: {}),
			...(c.network ? { network: c.network } : {}),
			createdAt: c.createdAt,
		});
	}
	for (const [groupId, secrets] of Object.entries(part.groupSecrets)) {
		for (const [prefix, field] of SECRET_OWNERS) {
			const apiKey = secrets[field];
			if (!apiKey) continue;
			const owner = `${prefix}${groupId}`;
			keys.push({ id: owner, providerId: owner, apiKey, priority: 0, createdAt: 0 });
		}
	}
	return keys;
}

/** The model keys as `credentials.json` holds them; search keys are left out. */
export function keyPartOf(keys: readonly ProviderKey[]): KeyPart {
	const part: KeyPart = { credentials: [], groupSecrets: {} };
	for (const key of keys) {
		if (isSearchKeyOwner(key.providerId)) continue;
		const secret = SECRET_OWNERS.find(([prefix]) => key.providerId.startsWith(prefix));
		if (!secret) {
			part.credentials.push(keyToCredential(key, keyOwnerGroup(key.providerId)));
			continue;
		}
		const groupId = key.providerId.slice(secret[0].length);
		const secrets = part.groupSecrets[groupId] ?? {};
		secrets[secret[1]] ??= key.apiKey;
		part.groupSecrets[groupId] = secrets;
	}
	return part;
}

/** A connection config that speaks for one key: its secret, and its own network identity. */
export function withProviderKey<
	T extends {
		apiKey: string;
		proxy?: ProxyOverride;
		userAgentMode?: string;
		customUserAgent?: string;
		extraHeaders?: Record<string, string>;
	},
>(config: T, key: { apiKey: string; network?: CredentialNetwork }): T {
	const network = key.network;
	return {
		...config,
		apiKey: key.apiKey,
		...(network?.proxy && network.proxy.mode !== "default" ? { proxy: network.proxy } : {}),
		...(network?.userAgentMode
			? { userAgentMode: network.userAgentMode, customUserAgent: network.customUserAgent }
			: {}),
		...(network?.extraHeaders
			? { extraHeaders: { ...config.extraHeaders, ...network.extraHeaders } }
			: {}),
	};
}

export class ProviderKeyStore {
	private keys: ProviderKey[] = [];
	private unreadable = false;
	private readonly listeners = new Set<() => void>();
	private readonly credentials: CredentialStore;
	/** Model keys live in `credentials.json`; fixed for the life of the store. */
	private readonly unified: boolean;

	constructor(private readonly path = getNarraforkPath(PROVIDER_KEYS_FILE)) {
		this.credentials = getCredentialStore(dirname(path));
		this.unified = this.credentials.unified;
		try {
			const stored = parseStoredProviderKeys(readSecretJSON(path));
			if (!this.unified) {
				this.keys = stored;
			} else if (this.credentials.readable) {
				// Anything else left here is the migration's, cleaned up at startup.
				const search = stored.filter((k) => isSearchKeyOwner(k.providerId));
				this.keys = [...search, ...keysFromPart(this.credentials.keyCredentials())];
			} else {
				this.unreadable = true;
			}
		} catch (error) {
			// Never write over a file we could not read: it is the only copy.
			this.unreadable = true;
			logger.error("Provider keys are unreadable; leaving the file untouched", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** False when the file exists but could not be read; nothing is saved then. */
	get readable(): boolean {
		return !this.unreadable;
	}

	/** Keys of one provider, first key first. */
	list(providerId: string): ProviderKey[] {
		const group = this.group(providerId);
		return this.keys.filter((k) => k.providerId === group).sort(byPriority);
	}

	all(): readonly ProviderKey[] {
		return this.keys;
	}

	/** Inference keys of a source group, independent of the storage mode's owner spelling. */
	listGroup(groupId: string): ProviderKey[] {
		return this.keys
			.filter(
				(key) => !isSearchKeyOwner(key.providerId) && keyOwnerGroup(key.providerId) === groupId,
			)
			.sort(byPriority);
	}

	firstGroupKey(groupId: string): string | undefined {
		return this.listGroup(groupId)[0]?.apiKey;
	}

	/** Add an inference key by source group; the facade maps legacy singleton/NUG owners. */
	addGroupCredential(
		groupId: string,
		templateId: "nug" | "tokendance" | "command-code" | undefined,
		input: { apiKey: string; label?: string; network?: CredentialNetwork },
	): ProviderKey {
		const owner =
			templateId === "nug"
				? nugKeyOwner(groupId)
				: templateId === "tokendance"
					? TOKENDANCE_KEY_OWNER
					: templateId === "command-code"
						? COMMAND_CODE_KEY_OWNER
						: groupId;
		return this.add(owner, input);
	}

	/** Non-inference secrets of one group (site token, NUG OAuth client secret). */
	groupSecrets(groupId: string): GroupSecrets {
		const secrets: GroupSecrets = {};
		for (const [prefix, field] of SECRET_OWNERS) {
			const value = this.firstKey(`${prefix}${groupId}`);
			if (value) secrets[field] = value;
		}
		return secrets;
	}

	setGroupSecrets(groupId: string, secrets: GroupSecrets): void {
		this.assertWritable();
		const owners = new Map(SECRET_OWNERS.map(([prefix, field]) => [`${prefix}${groupId}`, field]));
		const next = this.keys.filter((key) => !owners.has(key.providerId));
		for (const [owner, field] of owners) {
			const apiKey = secrets[field]?.trim();
			if (apiKey) next.push({ id: owner, providerId: owner, apiKey, priority: 0, createdAt: 0 });
		}
		this.keys = next;
		this.commit();
	}

	/** Remove inference keys and group secrets, never search-provider keys. */
	removeGroup(groupId: string): void {
		this.assertWritable();
		const before = this.keys.length;
		this.keys = this.keys.filter((key) => {
			if (isSearchKeyOwner(key.providerId)) return true;
			if (keyOwnerGroup(key.providerId) === groupId) return false;
			return !SECRET_OWNERS.some(([prefix]) => key.providerId === `${prefix}${groupId}`);
		});
		if (this.keys.length !== before) this.commit();
	}

	get(id: string): ProviderKey | undefined {
		return this.keys.find((k) => k.id === id);
	}

	/** The key settings shows for this provider. */
	firstKey(providerId: string): string | undefined {
		return this.list(providerId)[0]?.apiKey;
	}

	add(
		providerId: string,
		input: { apiKey: string; label?: string; network?: CredentialNetwork; id?: string },
	): ProviderKey {
		this.assertWritable();
		const apiKey = input.apiKey.trim();
		if (!apiKey) throw new Error("API key is empty");
		const existing = this.list(providerId);
		const id = input.id && !this.taken(input.id) ? input.id : generateShortId();
		const key: ProviderKey = {
			id,
			providerId: this.group(providerId),
			apiKey,
			...(input.label?.trim() ? { label: input.label.trim() } : {}),
			priority: (existing.at(-1)?.priority ?? -1) + 1,
			...(input.network ? { network: input.network } : {}),
			createdAt: Date.now(),
		};
		this.keys.push(key);
		this.commit();
		return key;
	}

	update(
		id: string,
		fields: {
			apiKey?: string;
			label?: string;
			disabled?: boolean;
			disabledReason?: ProviderKeyDisabledReason;
			/** `null` clears it. */
			network?: CredentialNetwork | null;
		},
	): ProviderKey {
		this.assertWritable();
		const key = this.get(id);
		if (!key) throw new Error(`Provider key not found: ${id}`);
		if (fields.apiKey !== undefined) {
			const apiKey = fields.apiKey.trim();
			if (!apiKey) throw new Error("API key is empty");
			if (apiKey !== key.apiKey && key.disabledReason === "invalid") {
				// A new secret is a fresh start for a key upstream had rejected.
				key.disabled = undefined;
				key.disabledReason = undefined;
			}
			key.apiKey = apiKey;
		}
		if (fields.label !== undefined) key.label = fields.label.trim() || undefined;
		if (fields.disabled !== undefined) {
			key.disabled = fields.disabled || undefined;
			key.disabledReason = fields.disabled ? (fields.disabledReason ?? "manual") : undefined;
		}
		if (fields.network !== undefined) key.network = fields.network ?? undefined;
		this.commit();
		return key;
	}

	remove(id: string): void {
		this.assertWritable();
		const before = this.keys.length;
		this.keys = this.keys.filter((k) => k.id !== id);
		if (this.keys.length !== before) this.commit();
	}

	removeProvider(providerId: string): void {
		this.assertWritable();
		const before = this.keys.length;
		const group = this.group(providerId);
		this.keys = this.keys.filter((k) => k.providerId !== group);
		if (this.keys.length !== before) this.commit();
	}

	/** `ids` in the new order; keys not listed keep their relative order after them. */
	reorder(providerId: string, ids: readonly string[]): void {
		this.assertWritable();
		const current = this.list(providerId);
		const rank = (k: ProviderKey) => {
			const i = ids.indexOf(k.id);
			return i < 0 ? ids.length + current.indexOf(k) : i;
		};
		current
			.sort((a, b) => rank(a) - rank(b))
			.forEach((k, i) => {
				k.priority = i;
			});
		this.commit();
	}

	/**
	 * Make each provider's first key match what settings hold for it: create it (with
	 * the provider's id, so usage already recorded under the provider stays with it),
	 * replace it, or — when settings cleared the key and `clearOnEmpty` — remove it.
	 * Settings read back from disk carry no keys, so loading passes `clearOnEmpty: false`.
	 * Returns whether anything changed.
	 */
	syncFirstKeys(
		providers: ReadonlyArray<{ id: string; apiKey?: string }>,
		options: { clearOnEmpty: boolean },
	): boolean {
		if (this.unreadable) return false;
		let changed = false;
		for (const provider of providers) {
			const apiKey = provider.apiKey?.trim() ?? "";
			const first = this.list(provider.id)[0];
			if (first?.apiKey === apiKey || (!apiKey && (!first || !options.clearOnEmpty))) continue;
			changed = true;
			if (!first) {
				const group = this.group(provider.id);
				this.keys.push({
					id: this.taken(group) ? generateShortId() : group,
					providerId: group,
					apiKey,
					priority: 0,
					createdAt: Date.now(),
				});
			} else if (apiKey) {
				first.apiKey = apiKey;
				if (first.disabledReason === "invalid") {
					first.disabled = undefined;
					first.disabledReason = undefined;
				}
			} else {
				this.keys = this.keys.filter((k) => k !== first);
			}
		}
		if (changed) this.commit();
		return changed;
	}

	/** Called after every change, e.g. to refresh the settings projection. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Write every key where it belongs. */
	save(): void {
		this.assertWritable();
		if (!this.unified) {
			writeSecretJSON(this.path, this.keys);
			return;
		}
		this.saveSearchKeys();
		this.credentials.saveKeys(keyPartOf(this.keys));
	}

	/** Rewrite this store's own file in the current encryption form. */
	rewrite(): void {
		if (!this.readable) return;
		if (!this.unified) {
			if (this.keys.length) this.save();
			return;
		}
		// The credential store rewrites credentials.json itself.
		this.saveSearchKeys();
	}

	private saveSearchKeys(): void {
		const search = this.keys.filter((k) => isSearchKeyOwner(k.providerId));
		if (search.length) writeSecretJSON(this.path, search);
		else if (existsSync(this.path)) unlinkSync(this.path);
	}

	/** How this store files an owner's keys: by group once credentials.json is in use. */
	private group(owner: string): string {
		return this.unified ? keyOwnerGroup(owner) : owner;
	}

	/** Ids are unique across all credentials, Codex accounts included. */
	private taken(id: string): boolean {
		return !!this.get(id) || (this.unified && this.credentials.hasId(id));
	}

	private assertWritable(): void {
		if (this.unreadable) {
			throw new SecretStoreError(
				"Provider keys on this server could not be read; nothing was changed",
			);
		}
	}

	private commit(): void {
		this.save();
		for (const listener of this.listeners) {
			try {
				listener();
			} catch (error) {
				logger.warn("Provider key change listener failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
}

let store: ProviderKeyStore | undefined;
let stopRewrite: (() => void) | undefined;

/** Routing never initializes a store (which would synchronously read credentials). */
export function peekProviderKeyStore(): ProviderKeyStore | undefined {
	return store;
}

export function getProviderKeyStore(): ProviderKeyStore {
	if (!store) {
		store = new ProviderKeyStore();
		const current = store;
		stopRewrite = onSecretEncryptionChange(() => current.rewrite());
	}
	return store;
}

/** Tests only: forget the singleton so a different NARRAFORK_HOME is honoured. */
export function resetProviderKeyStoreForTests(): void {
	stopRewrite?.();
	stopRewrite = undefined;
	store = undefined;
	resetCredentialStoresForTests();
}
