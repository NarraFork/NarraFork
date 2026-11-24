/**
 * Quota snapshots by credential id (docs/PROVIDER-SOURCING-DESIGN.md §15.4).
 *
 * Every quota source (Kimi Code, OpenCode Go, DeepSeek, relay / site balances) keeps its
 * latest snapshot here instead of in a cache of its own. The sources still own scheduling —
 * TTLs, backoff, background and post-request refreshes — and only read and write snapshots.
 *
 * A snapshot belongs to one credential identity (the key, the endpoint and whatever else
 * decides which account answers). Reads name the live identity and get nothing back when it
 * differs, so a replaced key or endpoint never shows the previous account's numbers. On disk
 * the identity is kept only as a keyed fingerprint (`persisted-credential-cache`).
 */
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { type QuotaSnapshot, quotaExhaustedUntil } from "@shared/quota-snapshot";
import { getNarraforkPath } from "../narrafork-home";
import {
	createPersistedCredentialCache,
	type PersistedCredentialCache,
} from "../persisted-credential-cache";
import { registerKeyQuotaProbe } from "../provider-key-quota";

export const QUOTA_SNAPSHOTS_FILE = "quota-snapshots.json";
/** Stream-reported balances coexist with the same credential's direct quota probe. */
export const STREAM_QUOTA_SOURCE = "quota_balance";
const DEFAULT_QUOTA_SOURCE = "probe";

const SCOPES = new Set(["key", "account", "wallet", "subscription"]);
const WINDOW_KINDS = new Set(["5h", "weekly", "monthly", "other"]);

const finiteOrNull = (value: unknown): value is number | null =>
	value === null || (typeof value === "number" && Number.isFinite(value));

/** Shape check for a snapshot read from disk; sources re-derive it from `detail` anyway. */
export function parseQuotaSnapshot(raw: unknown): QuotaSnapshot | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt)) return null;
	if (!SCOPES.has(value.scope as string)) return null;
	if (!Array.isArray(value.windows) || !Array.isArray(value.balances)) return null;
	const windows = value.windows.filter(
		(w): w is QuotaSnapshot["windows"][number] =>
			!!w && WINDOW_KINDS.has(w.kind) && finiteOrNull(w.usedRatio) && finiteOrNull(w.resetsAt),
	);
	const balances = value.balances.filter(
		(b): b is QuotaSnapshot["balances"][number] =>
			!!b && typeof b.unit === "string" && finiteOrNull(b.remaining),
	);
	return {
		fetchedAt: value.fetchedAt,
		...(typeof value.error === "string" ? { error: value.error } : {}),
		scope: value.scope as QuotaSnapshot["scope"],
		windows,
		balances,
		...(typeof value.plan === "string" ? { plan: value.plan } : {}),
		...(value.detail !== undefined ? { detail: value.detail } : {}),
	};
}

export class QuotaStore {
	private held = new Map<string, { identity: string; snapshot: QuotaSnapshot }>();

	constructor(private persisted?: PersistedCredentialCache<QuotaSnapshot>) {}

	private heldKey(id: string, source: string): string {
		return `${source}\0${id}`;
	}

	private persistedKey(id: string, source: string): string {
		return source === DEFAULT_QUOTA_SOURCE ? id : `${source}:${id}`;
	}

	/**
	 * The snapshot saved under this identity, from memory or else from disk.
	 *
	 * `restore` rebuilds a snapshot read from disk from its validated `detail`, so a stale or
	 * hand-edited file degrades to "no snapshot" rather than to numbers its source cannot read.
	 */
	get(
		id: string,
		identity: string,
		restore?: (snapshot: QuotaSnapshot) => QuotaSnapshot | null,
		source = DEFAULT_QUOTA_SOURCE,
	): QuotaSnapshot | undefined {
		const heldKey = this.heldKey(id, source);
		const held = this.held.get(heldKey);
		if (held?.identity === identity) return held.snapshot;
		if (held) this.held.delete(heldKey);
		const stored = this.persisted?.restore(this.persistedKey(id, source), identity);
		const snapshot = stored && (restore ? (restore(stored) ?? undefined) : stored);
		if (snapshot) this.held.set(heldKey, { identity, snapshot });
		return snapshot;
	}

	/** Forget the in-memory copy only (an identity that changed, but may come back). */
	forget(id: string, source = DEFAULT_QUOTA_SOURCE): void {
		this.held.delete(this.heldKey(id, source));
	}

	/** The snapshot in memory, whatever identity it was saved under (key pool). */
	peek(id: string, source = DEFAULT_QUOTA_SOURCE): QuotaSnapshot | undefined {
		return this.held.get(this.heldKey(id, source))?.snapshot;
	}

	/** `persist: false` keeps the disk copy as it is (in-progress or never-fetched states). */
	set(
		id: string,
		identity: string,
		snapshot: QuotaSnapshot,
		persist = true,
		source = DEFAULT_QUOTA_SOURCE,
	): void {
		this.held.set(this.heldKey(id, source), { identity, snapshot });
		if (persist) this.persisted?.save(this.persistedKey(id, source), identity, snapshot);
	}

	/** Drop the disk copy only, so a restart cannot bring the value back. */
	unpersist(id: string, source = DEFAULT_QUOTA_SOURCE): void {
		this.persisted?.remove(this.persistedKey(id, source));
	}

	remove(id: string, source = DEFAULT_QUOTA_SOURCE): void {
		this.held.delete(this.heldKey(id, source));
		this.persisted?.remove(this.persistedKey(id, source));
	}

	flush(): Promise<void> {
		return this.persisted?.flush() ?? Promise.resolve();
	}
}

export const quotaStore = new QuotaStore(
	createPersistedCredentialCache(QUOTA_SNAPSHOTS_FILE, parseQuotaSnapshot),
);

/**
 * Move one pre-snapshot cache file into the store, then delete it.
 *
 * Old entries are fingerprinted with that file's own salt, so each is checked against the
 * live identity it would have been restored under; anything that does not match (or a file
 * that cannot be read) is simply dropped and the quota is probed again.
 *
 * Resolves once the old file is removed; callers fire-and-forget it, tests await it.
 */
export function importLegacyQuotaCache<T>(
	fileName: string,
	parse: (raw: unknown) => T | null,
	items: ReadonlyArray<{
		legacyKey: string;
		id: string;
		/** Identity the legacy entry was saved under. */
		identity: string;
		/** Identity to keep it under, when the live one is computed differently now. */
		storeIdentity?: string;
	}>,
	toSnapshot: (value: T) => QuotaSnapshot | null,
	store: QuotaStore = quotaStore,
): Promise<void> {
	const path = getNarraforkPath(fileName);
	if (!existsSync(path)) return Promise.resolve();
	const legacy = createPersistedCredentialCache(fileName, parse);
	for (const { legacyKey, id, identity, storeIdentity } of items) {
		const liveIdentity = storeIdentity ?? identity;
		if (store.get(id, liveIdentity)) continue;
		const value = legacy.restore(legacyKey, identity);
		const snapshot = value === undefined ? null : toSnapshot(value);
		if (snapshot) store.set(id, liveIdentity, snapshot);
	}
	return unlink(path).catch(() => {});
}

// The key pool skips a credential whose window a snapshot shows used up, until it refills.
registerKeyQuotaProbe((keyId, now) => quotaExhaustedUntil(quotaStore.peek(keyId), now));
