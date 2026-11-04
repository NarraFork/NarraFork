/**
 * API keys of custom API providers (Kimi Code, OpenCode Go, DeepSeek, relays …).
 *
 * A provider can hold several keys; they live here, in `provider-keys.json` written
 * through the secret store, and no longer in settings.json. The settings module keeps a
 * projection: in memory, `customApiProviders[i].apiKey` is that provider's first key, so
 * code that reads a single key keeps working, and writing that field edits the first key
 * (see settings/provider-keys-projection.ts). Runtime selection among keys is in
 * agent/pooled-provider.ts.
 *
 * Leaf module: it must not import settings, which depends on it.
 */
import type { CredentialNetwork } from "@shared/credential-network";
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

const byPriority = (a: ProviderKey, b: ProviderKey) => a.priority - b.priority;

export class ProviderKeyStore {
	private keys: ProviderKey[] = [];
	private unreadable = false;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly path = getNarraforkPath(PROVIDER_KEYS_FILE)) {
		try {
			const raw = readSecretJSON(path);
			if (Array.isArray(raw)) {
				const seen = new Set<string>();
				for (const item of raw) {
					const key = normalize(item);
					if (key && !seen.has(key.id)) {
						seen.add(key.id);
						this.keys.push(key);
					}
				}
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
		return this.keys.filter((k) => k.providerId === providerId).sort(byPriority);
	}

	all(): readonly ProviderKey[] {
		return this.keys;
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
		const id = input.id && !this.get(input.id) ? input.id : generateShortId();
		const key: ProviderKey = {
			id,
			providerId,
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
		this.keys = this.keys.filter((k) => k.providerId !== providerId);
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
				this.keys.push({
					id: this.get(provider.id) ? generateShortId() : provider.id,
					providerId: provider.id,
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

	/** Rewrite in the current encryption form. */
	save(): void {
		this.assertWritable();
		writeSecretJSON(this.path, this.keys);
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

export function getProviderKeyStore(): ProviderKeyStore {
	if (!store) {
		store = new ProviderKeyStore();
		const current = store;
		stopRewrite = onSecretEncryptionChange(() => {
			if (current.readable && current.all().length) current.save();
		});
	}
	return store;
}

/** Tests only: forget the singleton so a different NARRAFORK_HOME is honoured. */
export function resetProviderKeyStoreForTests(): void {
	stopRewrite?.();
	stopRewrite = undefined;
	store = undefined;
}
