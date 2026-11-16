/** Sensitive search headers stay out of settings.json, without changing its in-memory shape. */
import { logger } from "../logger";
import { getNarraforkPath } from "../narrafork-home";
import { onSecretEncryptionChange, readSecretJSON, writeSecretJSON } from "../secret-store";
import type { NarraForkSettings } from "./types";

type Headers = Record<string, string>;

export function isSensitiveHeaderName(name: string): boolean {
	return /^(authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)$/i.test(name.trim());
}

function sensitiveHeaders(headers: Headers = {}): Headers {
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) => isSensitiveHeaderName(name)),
	);
}

function ordinaryHeaders(headers: Headers = {}): Headers {
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) => !isSensitiveHeaderName(name)),
	);
}

export class SearchHeaderSecrets {
	private headers = new Map<string, Headers>();
	readonly readable: boolean;

	constructor(private readonly path = getNarraforkPath("search-provider-secrets.json")) {
		try {
			const raw = readSecretJSON(path);
			if (raw !== undefined) {
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
					throw new Error("Expected a search provider header map");
				}
				for (const [id, headers] of Object.entries(raw)) {
					if (
						!headers ||
						typeof headers !== "object" ||
						Array.isArray(headers) ||
						Object.entries(headers).some(
							([name, value]) => !isSensitiveHeaderName(name) || typeof value !== "string",
						)
					) {
						throw new Error("Invalid search provider secret headers");
					}
					this.headers.set(id, { ...headers });
				}
			}
			this.readable = true;
		} catch (error) {
			// The unreadable file may be the only copy. Keep it and any unmigrated inline values.
			this.readable = false;
			logger.error("Search header secrets are unreadable; leaving the file untouched", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Load: absent inline headers mean already migrated, not explicitly cleared. */
	absorb(settings: NarraForkSettings): boolean {
		const hadSecrets = (settings.search?.customProviders ?? []).some(
			(provider) => Object.keys(sensitiveHeaders(provider.headers)).length > 0,
		);
		this.sync(settings, true);
		this.hydrate(settings);
		return hadSecrets && this.readable;
	}

	/** Save: an omitted/empty header map explicitly clears its stored sensitive headers. */
	sync(settings: NarraForkSettings, loading = false): void {
		if (!this.readable) return;
		const next = new Map(this.headers);
		for (const provider of settings.search?.customProviders ?? []) {
			const incoming = sensitiveHeaders(provider.headers);
			const headers = loading ? { ...next.get(provider.id), ...incoming } : incoming;
			if (Object.keys(headers).length) next.set(provider.id, headers);
			else next.delete(provider.id);
		}
		this.commit(next);
	}

	hydrate(settings: NarraForkSettings): void {
		if (!this.readable) return;
		for (const provider of settings.search?.customProviders ?? []) {
			const headers = this.headers.get(provider.id);
			if (headers) provider.headers = { ...provider.headers, ...headers };
		}
	}

	without(settings: NarraForkSettings): NarraForkSettings {
		if (!this.readable || !settings.search) return settings;
		return {
			...settings,
			search: {
				...settings.search,
				customProviders: (settings.search.customProviders ?? []).map((provider) => {
					const { headers: _headers, ...rest } = provider;
					const headers = ordinaryHeaders(provider.headers);
					return { ...rest, ...(Object.keys(headers).length ? { headers } : {}) };
				}),
			},
		};
	}

	/** Only after settings was saved: a deleted provider must not regain old headers. */
	prune(settings: NarraForkSettings): void {
		if (!this.readable) return;
		const kept = new Set((settings.search?.customProviders ?? []).map((provider) => provider.id));
		this.commit(new Map([...this.headers].filter(([id]) => kept.has(id))));
	}

	rewrite(): void {
		if (this.readable && this.headers.size) {
			writeSecretJSON(this.path, Object.fromEntries(this.headers));
		}
	}

	private commit(next: Map<string, Headers>): void {
		const value = Object.fromEntries(next);
		if (JSON.stringify(value) === JSON.stringify(Object.fromEntries(this.headers))) return;
		writeSecretJSON(this.path, value);
		this.headers = next;
	}
}

let store: SearchHeaderSecrets | undefined;
let stopRewrite: (() => void) | undefined;

export function getSearchHeaderSecrets(): SearchHeaderSecrets {
	if (!store) {
		store = new SearchHeaderSecrets();
		const current = store;
		stopRewrite = onSecretEncryptionChange(() => current.rewrite());
	}
	return store;
}

/** Tests only: forget the singleton when switching the isolated home. */
export function resetSearchHeaderSecretsForTests(): void {
	stopRewrite?.();
	stopRewrite = undefined;
	store = undefined;
}
