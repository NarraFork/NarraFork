import type {
	ProviderBalanceAdapter,
	ProviderBalanceData,
	ProviderBalanceError,
	ProviderBalanceSnapshot,
	ProviderBalanceStatus,
} from "@shared/provider-balance";
import type { QuotaSnapshot } from "@shared/quota-snapshot";
import { selectProviderKey } from "./agent/pooled-provider";
import { isDeepSeekCustomApiProvider } from "./deepseek-balance-cache";
import { isKimiCustomApiProvider } from "./kimi-usage-cache";
import { logger } from "./logger";
import type { outboundFetch } from "./net/outbound-fetch";
import { isOpencodeCustomApiProvider } from "./opencode-usage-cache";
import {
	BalanceProbeRequestError,
	balanceErrorCode,
	balanceRootCandidates,
} from "./provider-balance-adapters";
import {
	getProviderBalanceEngine,
	type ProviderBalanceQueryEngine,
} from "./provider-balance-engine";
import type { UsageSubject } from "./provider-key-subjects";
import { getProviderKeyStore, withProviderKey } from "./provider-keys";
import { type CustomApiProviderConfig, settings } from "./settings";
import { importLegacyQuotaCache, QuotaStore, quotaStore } from "./sourcing/quota-store";

export const PROVIDER_BALANCE_STALE_MS = 60_000;
export const PROVIDER_BALANCE_MANUAL_THROTTLE_MS = 10_000;
/**
 * How long a stored allowance may still be shown after a *transient* failure.
 *
 * Anchored at the last real success, not at the failed attempt, so the displayed value ages
 * naturally. Past this window the stale number is withdrawn instead of being presented as
 * current — a network that is down for hours must not look like credit that never moves.
 */
export const PROVIDER_BALANCE_KEEP_LAST_GOOD_MS = 10 * 60_000;
const ROUND_TIMEOUT_MS = 20_000;
const MAX_CONCURRENT = 4;
const MAX_QUEUED = 128;

type Mode = "probe" | "refresh";
interface Task {
	entry: Entry;
	mode: Mode;
	controller: AbortController;
	promise: Promise<ProviderBalanceSnapshot | null>;
	resolve: (value: ProviderBalanceSnapshot | null) => void;
}
interface Entry {
	id: string;
	/** Where the snapshot is stored: the credential a new request would use. */
	credentialId: string;
	identity: string;
	config: CustomApiProviderConfig;
	generation: string;
	endpoint?: { adapter: ProviderBalanceAdapter; root: string };
	task?: Task;
	nextManualAt: number;
}
type Endpoint = NonNullable<Entry["endpoint"]>;

export function isProviderBalanceCandidate(config: CustomApiProviderConfig): boolean {
	return !!(
		!config.disabled &&
		config.apiKey &&
		config.baseUrl &&
		!isDeepSeekCustomApiProvider(config) &&
		!isKimiCustomApiProvider(config) &&
		!isOpencodeCustomApiProvider(config)
	);
}

/**
 * Kept server-side only. Public generations are random, not credential hashes.
 *
 * The site-account fields are part of the identity: rotating the access token or correcting
 * the site root must not leave the previous allowance on screen, because the cached value then
 * describes a different account.
 */
function connectionIdentity(config: CustomApiProviderConfig, globalProxy: unknown): string {
	return JSON.stringify([
		config.baseUrl,
		config.apiKey,
		config.protocol,
		config.proxy,
		config.tlsRejectUnauthorized,
		config.userAgentMode,
		config.customUserAgent,
		Object.entries(config.extraHeaders ?? {}).sort(([a], [b]) => a.localeCompare(b)),
		config.quotaSiteUrl,
		config.quotaAccessToken,
		config.quotaUserId,
		globalProxy,
	]);
}

/**
 * The credential a *new* request would use for this provider.
 *
 * A custom API provider can now hold several keys, and settings only ever exposes the first
 * one (provider-keys-projection.ts). Probing that field would therefore report the balance —
 * and cache the discovered root — of a key the requests no longer use: a key that was
 * disabled or is cooling down keeps a stale number on screen while another key actually
 * serves. The pool's own choice for a new request is `selectProviderKey` without a session,
 * the same call the auto-source rows use for "the credential a new request uses".
 *
 * Use the same per-key network composition as inference requests: proxy, User-Agent and
 * headers are part of both the balance transport and its cache identity. Even the first key
 * can override them without changing the secret settings exposes.
 *
 * Falls back to the configured value only when the key store is unreadable or holds no key
 * for this provider, preserving pre-existing single-key behaviour. If stored keys exist but
 * none is usable, an empty credential makes the provider ineligible instead of probing a
 * disabled key projected into settings.
 */
function withSelectedCredential(config: CustomApiProviderConfig): UsageSubject {
	const store = getProviderKeyStore();
	const subject = { id: config.id, providerId: config.id, config };
	if (!store.readable || store.list(config.id).length === 0) return subject;
	const chosen = selectProviderKey(config.id);
	return chosen
		? { ...subject, id: chosen.id, config: withProviderKey(config, chosen) }
		: { ...subject, config: { ...config, apiKey: "" } };
}

/** What survives a restart: the discovery result and the last good balance. */
export interface PersistedProviderBalance {
	status: "supported" | "unsupported";
	endpoint?: { adapter: ProviderBalanceAdapter; root: string };
	balance: ProviderBalanceData | null;
	fetchedAt: number;
	attemptedAt: number;
}

export function parsePersistedProviderBalance(raw: unknown): PersistedProviderBalance | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	if (value.status !== "supported" && value.status !== "unsupported") return null;
	if (typeof value.fetchedAt !== "number" || typeof value.attemptedAt !== "number") return null;
	let endpoint: PersistedProviderBalance["endpoint"];
	if (value.endpoint && typeof value.endpoint === "object") {
		const e = value.endpoint as Record<string, unknown>;
		if (
			(e.adapter === "sub2api" || e.adapter === "new-api" || e.adapter === "new-api-user") &&
			typeof e.root === "string"
		) {
			endpoint = { adapter: e.adapter, root: e.root };
		}
	}
	if (value.status === "supported" && !endpoint) return null;
	let balance: ProviderBalanceData | null = null;
	if (value.balance && typeof value.balance === "object") {
		const b = value.balance as Record<string, unknown>;
		if (
			(b.scope === "wallet" || b.scope === "key" || b.scope === "subscription") &&
			typeof b.unlimited === "boolean" &&
			Array.isArray(b.amounts)
		) {
			const amounts = b.amounts.filter(
				(a): a is ProviderBalanceData["amounts"][number] =>
					!!a &&
					typeof a === "object" &&
					typeof (a as { unit?: unknown }).unit === "string" &&
					((a as { remaining?: unknown }).remaining === null ||
						typeof (a as { remaining?: unknown }).remaining === "number"),
			);
			balance = { scope: b.scope, unlimited: b.unlimited, amounts };
		}
	}
	return {
		status: value.status,
		...(endpoint ? { endpoint } : {}),
		balance,
		fetchedAt: value.fetchedAt,
		attemptedAt: value.attemptedAt,
	};
}

type BalanceState = Omit<ProviderBalanceSnapshot, "generation">;

/** Relay allowances in the shared shape; the original state stays in `detail`. */
function relaySnapshot(state: BalanceState, endpoint?: Endpoint): QuotaSnapshot {
	const { status, adapter, balance, fetchedAt, attemptedAt, error } = state;
	const unlimited = balance?.unlimited ? { unlimited: true } : {};
	const balances = (balance?.amounts ?? []).map((amount) => ({
		unit: amount.unit,
		remaining: amount.remaining,
		...(amount.total !== undefined ? { total: amount.total } : {}),
		...unlimited,
	}));
	if (balance?.unlimited && balances.length === 0) {
		balances.push({ unit: "", remaining: null, unlimited: true });
	}
	return {
		fetchedAt,
		...(error ? { error } : {}),
		scope: balance?.scope ?? "key",
		windows: [],
		balances,
		...(balance?.planName ? { plan: balance.planName } : {}),
		detail: {
			status,
			...(adapter ? { adapter } : {}),
			...(endpoint ? { endpoint } : {}),
			balance,
			attemptedAt,
		},
	};
}

/** The stored state, when it is one a restart may bring back (discovery settled). */
function persistedState(snapshot: QuotaSnapshot | undefined): PersistedProviderBalance | null {
	return snapshot
		? parsePersistedProviderBalance({
				...(snapshot.detail as object),
				fetchedAt: snapshot.fetchedAt,
			})
		: null;
}

/** A snapshot read from disk: only a settled discovery may come back. */
function restoreSnapshot(snapshot: QuotaSnapshot): QuotaSnapshot | null {
	const state = persistedState(snapshot);
	return (
		state &&
		relaySnapshot(
			{
				status: state.status,
				...(state.endpoint ? { adapter: state.endpoint.adapter } : {}),
				balance: state.balance,
				fetchedAt: state.fetchedAt,
				attemptedAt: state.attemptedAt,
				error: null,
			},
			state.endpoint,
		)
	);
}

/** One discovery round with the active engine, in the shared snapshot shape. */
export async function probeRelayQuota(
	credential: UsageSubject,
	signal: AbortSignal,
): Promise<QuotaSnapshot> {
	const found = await getProviderBalanceEngine().probe({ config: credential.config, signal });
	const now = Date.now();
	return relaySnapshot(
		{
			status: found ? "supported" : "unsupported",
			...(found ? { adapter: found.adapter } : {}),
			balance: found?.balance ?? null,
			fetchedAt: found ? now : 0,
			attemptedAt: now,
			error: null,
		},
		found ? { adapter: found.adapter, root: found.root } : undefined,
	);
}

interface CacheOptions {
	providers: () => CustomApiProviderConfig[];
	globalProxy: () => unknown;
	/**
	 * Where snapshots live; values are only restored under the same connection identity.
	 * Defaults to a private in-memory store.
	 */
	store?: QuotaStore;
	fetch?: typeof outboundFetch;
	now?: () => number;
	requestTimeoutMs?: number;
	roundTimeoutMs?: number;
	maxQueued?: number;
	/** Resolved per round so a plugin engine can be installed or dropped at runtime. */
	engine?: () => ProviderBalanceQueryEngine;
	/**
	 * Which credential each provider is probed with. Defaults to the pool's choice for a new
	 * request; injectable so a test can pin the credential without a real key store.
	 */
	resolveCredential?: (config: CustomApiProviderConfig) => UsageSubject;
	/** A pre-snapshot cache file to import on the first sync, then delete. */
	legacyFile?: string;
}

/** Bounded background jobs. Read paths never await upstream IO. */
export class ProviderBalanceCache {
	private entries = new Map<string, Entry>();
	private queue: Task[] = [];
	private active = 0;
	private now: () => number;
	private store: QuotaStore;
	private legacyImported = false;

	constructor(private options: CacheOptions) {
		this.now = options.now ?? Date.now;
		this.store = options.store ?? new QuotaStore();
	}

	sync(): void {
		const resolveCredential = this.options.resolveCredential ?? withSelectedCredential;
		const globalProxy = this.options.globalProxy();
		const providers = new Map(
			this.options
				.providers()
				.map(resolveCredential)
				.filter((credential) => isProviderBalanceCandidate(credential.config))
				.map((credential) => [
					credential.providerId,
					{ ...credential, identity: connectionIdentity(credential.config, globalProxy) },
				]),
		);
		if (this.options.legacyFile && !this.legacyImported) {
			this.legacyImported = true;
			void importLegacyQuotaCache(
				this.options.legacyFile,
				parsePersistedProviderBalance,
				[...providers.values()].map((p) => ({
					legacyKey: p.providerId,
					id: p.id,
					identity: p.identity,
				})),
				(state) =>
					relaySnapshot(
						{ ...state, adapter: state.endpoint?.adapter, error: null },
						state.endpoint,
					),
				this.store,
			);
		}
		for (const [id, entry] of this.entries) {
			const current = providers.get(id);
			if (!current || entry.identity !== current.identity || entry.credentialId !== current.id) {
				this.entries.delete(id);
				this.cancel(entry);
				if (!current) this.store.remove(entry.credentialId);
			}
		}
		for (const [id, { id: credentialId, config, identity }] of providers) {
			if (this.entries.has(id)) continue;
			let roots: string[] | null = null;
			try {
				roots = balanceRootCandidates(config);
			} catch {
				roots = null;
			}
			const restored = roots ? persistedState(this.store.get(credentialId, identity)) : null;
			// A restored endpoint must still be one this base URL would probe.
			const usable =
				restored && (!restored.endpoint || roots?.includes(restored.endpoint.root))
					? restored
					: undefined;
			const entry: Entry = {
				id,
				credentialId,
				identity,
				config: structuredClone(config),
				generation: crypto.randomUUID(),
				nextManualAt: 0,
				...(usable?.endpoint ? { endpoint: usable.endpoint } : {}),
			};
			this.entries.set(id, entry);
			this.put(
				entry,
				usable
					? {
							status: usable.status,
							...(usable.endpoint ? { adapter: usable.endpoint.adapter } : {}),
							balance: usable.balance,
							fetchedAt: usable.fetchedAt,
							attemptedAt: usable.attemptedAt,
							error: null,
						}
					: {
							status: roots ? "pending" : "error",
							balance: null,
							fetchedAt: 0,
							attemptedAt: 0,
							error: roots ? null : "invalid_configuration",
						},
			);
		}
	}

	/** The entry's state as the routes serve it, read from the store. */
	private snapshot(entry: Entry): ProviderBalanceSnapshot {
		// Another source can hold this credential id after an endpoint edit; only a snapshot
		// saved under this entry's own identity describes its balance.
		const stored = this.store.get(entry.credentialId, entry.identity, restoreSnapshot);
		const detail = stored?.detail as
			| {
					status: ProviderBalanceStatus;
					adapter?: ProviderBalanceAdapter;
					balance: ProviderBalanceData | null;
					attemptedAt: number;
			  }
			| undefined;
		if (!stored || !detail) {
			return {
				generation: entry.generation,
				status: "pending",
				balance: null,
				fetchedAt: 0,
				attemptedAt: 0,
				error: null,
			};
		}
		return {
			generation: entry.generation,
			status: detail.status,
			...(detail.adapter ? { adapter: detail.adapter } : {}),
			balance: detail.balance,
			fetchedAt: stored.fetchedAt,
			attemptedAt: detail.attemptedAt,
			error: (stored.error ?? null) as ProviderBalanceError | null,
		};
	}

	/** Publish a new state (memory only; `persist` decides what reaches the disk). */
	private put(entry: Entry, state: BalanceState): void {
		if (this.entries.get(entry.id) !== entry) return;
		this.store.set(entry.credentialId, entry.identity, relaySnapshot(state, entry.endpoint), false);
	}

	private update(entry: Entry, patch: Partial<BalanceState>): void {
		const { generation: _generation, ...state } = this.snapshot(entry);
		this.put(entry, { ...state, ...patch });
	}

	/**
	 * Turn one failed round into the snapshot the UI reads.
	 *
	 * Two classes, decided by the failure *kind* and never by message text:
	 * - transient (`request_failed`, plus the transport-level `unsupported` that a legacy
	 *   endpoint returns when it stops answering): retryable, so the last good allowance stays
	 *   visible, but only for `PROVIDER_BALANCE_KEEP_LAST_GOOD_MS` after the last real success.
	 * - deterministic (`auth_failed`, `invalid_response`, `invalid_configuration`): retrying the
	 *   same configuration cannot help, so the value is surfaced at once and the cached
	 *   allowance — including the persisted one — is dropped. Keeping it would let a later
	 *   network blip revive credit belonging to a token that no longer works.
	 */
	private failureSnapshot(entry: Entry, error: unknown): Partial<BalanceState> {
		const kind = error instanceof BalanceProbeRequestError ? error.kind : "transient";
		if (kind === "transient" || kind === "unsupported") {
			const { balance: previous, fetchedAt } = this.snapshot(entry);
			const keep =
				previous !== null &&
				entry.endpoint !== undefined &&
				fetchedAt > 0 &&
				this.now() - fetchedAt <= PROVIDER_BALANCE_KEEP_LAST_GOOD_MS;
			return {
				status: keep ? "supported" : "error",
				balance: keep ? previous : null,
				error: "request_failed",
			};
		}
		this.store.unpersist(entry.credentialId);
		return { status: "error", balance: null, error: balanceErrorCode(kind) };
	}

	/** Only settled discoveries survive a restart. */
	private persist(entry: Entry): void {
		const { generation: _generation, ...state } = this.snapshot(entry);
		if (state.status !== "supported" && state.status !== "unsupported") return;
		if (state.status === "supported" && !entry.endpoint) return;
		this.store.set(entry.credentialId, entry.identity, relaySnapshot(state, entry.endpoint));
	}

	private cancel(entry: Entry): void {
		const task = entry.task;
		if (!task) return;
		task.controller.abort();
		const index = this.queue.indexOf(task);
		if (index !== -1) {
			this.queue.splice(index, 1);
			entry.task = undefined;
			task.resolve(null);
		}
	}

	generations(): Record<string, string> {
		this.sync();
		return Object.fromEntries([...this.entries].map(([id, e]) => [id, e.generation]));
	}

	/** Does not schedule network activity; useful immediately after scheduling a mutation. */
	peek(id: string): ProviderBalanceSnapshot | null {
		this.sync();
		const entry = this.entries.get(id);
		return entry ? structuredClone(this.snapshot(entry)) : null;
	}

	/** Only pending entries qualify; unsupported and failed discoveries are not polled. */
	discoverPending(): void {
		this.sync();
		this.fillPending();
	}

	private fillPending(): void {
		for (const entry of this.entries.values()) {
			if (this.queue.length >= (this.options.maxQueued ?? MAX_QUEUED)) break;
			if (this.snapshot(entry).status === "pending" && !entry.task)
				void this.schedule(entry, "probe");
		}
	}

	read(providerId?: string): Record<string, ProviderBalanceSnapshot> {
		this.sync();
		const selected = [...this.entries].filter(([id]) => !providerId || id === providerId);
		for (const [, entry] of selected) {
			const snapshot = this.snapshot(entry);
			if (snapshot.status === "pending") void this.schedule(entry, "probe");
			else if (
				snapshot.status === "supported" &&
				this.now() - snapshot.attemptedAt >= PROVIDER_BALANCE_STALE_MS
			) {
				void this.schedule(entry, "refresh");
			} else if (
				// A transient failure with a known endpoint is retryable: without this the
				// entry would sit in its failure state forever once the keep-last-good
				// window expired. Deterministic failures are deliberately excluded.
				snapshot.error === "request_failed" &&
				entry.endpoint !== undefined &&
				this.now() - snapshot.attemptedAt >= PROVIDER_BALANCE_STALE_MS
			) {
				void this.schedule(entry, "refresh");
			} else if (
				// A disabled capability plugin is re-discovered rather than retried: the
				// answer is a configuration state that only an administrator can change, and
				// re-enabling it has to bring the value back without a manual probe. Active
				// discovery is cheap here — it is refused before any process is spawned.
				snapshot.error === "plugin_not_enabled" &&
				this.now() - snapshot.attemptedAt >= PROVIDER_BALANCE_STALE_MS
			) {
				void this.schedule(entry, "probe");
			}
		}
		return Object.fromEntries(
			selected.map(([id, entry]) => [id, structuredClone(this.snapshot(entry))]),
		);
	}

	/** Let HTTP callers report cooldown/backpressure instead of claiming a probe started. */
	manualRetryAfterMs(id: string): number {
		this.sync();
		const entry = this.entries.get(id);
		if (!entry || entry.task || this.snapshot(entry).error === "invalid_configuration") return 0;
		const cooldown = Math.max(0, entry.nextManualAt - this.now());
		return this.queue.length >= (this.options.maxQueued ?? MAX_QUEUED)
			? Math.max(1_000, cooldown)
			: cooldown;
	}

	/** Explicit, throttled admin action; defaults to discovering capability again. */
	request(id: string, mode: Mode = "probe"): Promise<ProviderBalanceSnapshot | null> {
		this.sync();
		const entry = this.entries.get(id);
		if (!entry) return Promise.resolve(null);
		if (entry.task) return entry.task.promise;
		const snapshot = this.snapshot(entry);
		if (snapshot.error === "invalid_configuration" || this.now() < entry.nextManualAt) {
			return Promise.resolve(structuredClone(snapshot));
		}
		return this.schedule(entry, entry.endpoint ? mode : "probe");
	}

	private schedule(entry: Entry, mode: Mode): Promise<ProviderBalanceSnapshot | null> {
		if (entry.task) return entry.task.promise;
		if (this.queue.length >= (this.options.maxQueued ?? MAX_QUEUED)) {
			return Promise.resolve(null);
		}
		let resolve!: Task["resolve"];
		const promise = new Promise<ProviderBalanceSnapshot | null>((done) => {
			resolve = done;
		});
		const task: Task = { entry, mode, promise, resolve, controller: new AbortController() };
		entry.task = task;
		entry.nextManualAt = this.now() + PROVIDER_BALANCE_MANUAL_THROTTLE_MS;
		if (mode === "probe") this.update(entry, { status: "pending", error: null });
		this.queue.push(task);
		this.pump();
		return promise;
	}

	private pump(): void {
		while (this.active < MAX_CONCURRENT && this.queue.length) {
			const task = this.queue.shift();
			if (!task) break;
			this.active++;
			void this.execute(task).finally(() => {
				this.active--;
				this.pump();
				this.fillPending();
			});
		}
	}

	private async execute(task: Task): Promise<void> {
		const { entry, mode, controller } = task;
		const startedAt = performance.now();
		const timer = setTimeout(
			() => controller.abort(),
			this.options.roundTimeoutMs ?? ROUND_TIMEOUT_MS,
		);
		const current = () => {
			this.sync();
			// Transport rejects abort-ignoring IO. An optional public metadata timeout
			// may still legitimately return an already validated raw key allowance.
			return this.entries.get(entry.id) === entry;
		};
		try {
			this.update(entry, {
				status: mode === "probe" ? "probing" : "supported",
				attemptedAt: this.now(),
			});
			const engine = this.options.engine?.() ?? getProviderBalanceEngine();
			if (mode === "probe") {
				const found = await engine.probe({
					config: entry.config,
					signal: controller.signal,
					requestTimeoutMs: this.options.requestTimeoutMs,
					fetch: this.options.fetch,
				});
				if (!current()) return;
				entry.endpoint = found ? { adapter: found.adapter, root: found.root } : undefined;
				this.update(entry, {
					status: found ? "supported" : "unsupported",
					adapter: found?.adapter,
					balance: found?.balance ?? null,
					fetchedAt: found ? this.now() : 0,
					error: null,
				});
			} else if (entry.endpoint) {
				const balance = await engine.refresh({
					config: entry.config,
					signal: controller.signal,
					requestTimeoutMs: this.options.requestTimeoutMs,
					fetch: this.options.fetch,
					adapter: entry.endpoint.adapter,
					root: entry.endpoint.root,
				});
				if (!current()) return;
				this.update(entry, { balance, fetchedAt: this.now(), error: null });
			}
		} catch (error) {
			// An aborted round is a failure if this identity still exists. A superseded
			// request is instead discarded, even if its transport ignored cancellation.
			this.sync();
			if (this.entries.get(entry.id) === entry) {
				this.update(entry, this.failureSnapshot(entry, error));
			}
		} finally {
			clearTimeout(timer);
			if (entry.task === task) entry.task = undefined;
			if (this.entries.get(entry.id) === entry) this.persist(entry);
			const elapsed = performance.now() - startedAt;
			if (elapsed >= 2_000) {
				const safeId = /^[\w-]{1,64}$/.test(entry.id) ? entry.id : "custom-provider";
				logger.warn(
					`[provider-balance] slow operation provider=${safeId} mode=${mode} durationMs=${Math.round(elapsed)} status=${this.snapshot(entry).status}`,
				);
			}
			task.resolve(
				this.entries.get(entry.id) === entry ? structuredClone(this.snapshot(entry)) : null,
			);
		}
	}
}

export const providerBalanceCache = new ProviderBalanceCache({
	providers: () => settings.customApiProviders ?? [],
	globalProxy: () => settings.proxy,
	store: quotaStore,
	legacyFile: "provider-balances.json",
});

export const getProviderBalanceGenerations = () => providerBalanceCache.generations();
export const syncProviderBalanceCache = () => providerBalanceCache.sync();
export const discoverPendingProviderBalances = () => providerBalanceCache.discoverPending();
