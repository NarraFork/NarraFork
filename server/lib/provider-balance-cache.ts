import type {
	ProviderBalanceAdapter,
	ProviderBalanceData,
	ProviderBalanceSnapshot,
} from "@shared/provider-balance";
import { isDeepSeekCustomApiProvider } from "./deepseek-balance-cache";
import { isKimiCustomApiProvider } from "./kimi-usage-cache";
import { logger } from "./logger";
import type { outboundFetch } from "./net/outbound-fetch";
import { isOpencodeCustomApiProvider } from "./opencode-usage-cache";
import {
	createPersistedCredentialCache,
	type PersistedCredentialCache,
} from "./persisted-credential-cache";
import {
	BalanceProbeRequestError,
	balanceErrorCode,
	balanceRootCandidates,
} from "./provider-balance-adapters";
import {
	getProviderBalanceEngine,
	type ProviderBalanceQueryEngine,
} from "./provider-balance-engine";
import { type CustomApiProviderConfig, settings } from "./settings";

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
	identity: string;
	config: CustomApiProviderConfig;
	snapshot: ProviderBalanceSnapshot;
	endpoint?: { adapter: ProviderBalanceAdapter; root: string };
	task?: Task;
	nextManualAt: number;
}

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

interface CacheOptions {
	providers: () => CustomApiProviderConfig[];
	globalProxy: () => unknown;
	/** Survive restarts; values are only restored under the same connection identity. */
	persistence?: PersistedCredentialCache<PersistedProviderBalance>;
	fetch?: typeof outboundFetch;
	now?: () => number;
	requestTimeoutMs?: number;
	roundTimeoutMs?: number;
	maxQueued?: number;
	/** Resolved per round so a plugin engine can be installed or dropped at runtime. */
	engine?: () => ProviderBalanceQueryEngine;
}

/** Bounded background jobs. Read paths never await upstream IO. */
export class ProviderBalanceCache {
	private entries = new Map<string, Entry>();
	private queue: Task[] = [];
	private active = 0;
	private now: () => number;

	constructor(private options: CacheOptions) {
		this.now = options.now ?? Date.now;
	}

	sync(): void {
		const providers = new Map(
			this.options
				.providers()
				.filter(isProviderBalanceCandidate)
				.map((p) => [p.id, p]),
		);
		const globalProxy = this.options.globalProxy();
		for (const [id, entry] of this.entries) {
			const config = providers.get(id);
			if (!config || entry.identity !== connectionIdentity(config, globalProxy)) {
				this.entries.delete(id);
				this.cancel(entry);
				if (!config) this.options.persistence?.remove(id);
			}
		}
		for (const [id, config] of providers) {
			if (this.entries.has(id)) continue;
			let roots: string[] | null = null;
			try {
				roots = balanceRootCandidates(config);
			} catch {
				roots = null;
			}
			const identity = connectionIdentity(config, globalProxy);
			const restored = roots ? this.options.persistence?.restore(id, identity) : undefined;
			// A restored endpoint must still be one this base URL would probe.
			const usable =
				restored && (!restored.endpoint || roots?.includes(restored.endpoint.root))
					? restored
					: undefined;
			this.entries.set(id, {
				id,
				identity,
				config: structuredClone(config),
				nextManualAt: 0,
				...(usable?.endpoint ? { endpoint: usable.endpoint } : {}),
				snapshot: usable
					? {
							generation: crypto.randomUUID(),
							status: usable.status,
							...(usable.endpoint ? { adapter: usable.endpoint.adapter } : {}),
							balance: usable.balance,
							fetchedAt: usable.fetchedAt,
							attemptedAt: usable.attemptedAt,
							error: null,
						}
					: {
							generation: crypto.randomUUID(),
							status: roots ? "pending" : "error",
							balance: null,
							fetchedAt: 0,
							attemptedAt: 0,
							error: roots ? null : "invalid_configuration",
						},
			});
		}
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
	private failureSnapshot(entry: Entry, error: unknown): ProviderBalanceSnapshot {
		const kind = error instanceof BalanceProbeRequestError ? error.kind : "transient";
		if (kind === "transient" || kind === "unsupported") {
			const previous = entry.snapshot.balance;
			const keep =
				previous !== null &&
				entry.endpoint !== undefined &&
				entry.snapshot.fetchedAt > 0 &&
				this.now() - entry.snapshot.fetchedAt <= PROVIDER_BALANCE_KEEP_LAST_GOOD_MS;
			return {
				...entry.snapshot,
				status: keep ? "supported" : "error",
				balance: keep ? previous : null,
				error: "request_failed",
			};
		}
		this.options.persistence?.remove(entry.id);
		return {
			...entry.snapshot,
			status: "error",
			balance: null,
			error: balanceErrorCode(kind),
		};
	}

	private persist(entry: Entry): void {
		const { status, balance, fetchedAt, attemptedAt } = entry.snapshot;
		if (status !== "supported" && status !== "unsupported") return;
		if (status === "supported" && !entry.endpoint) return;
		this.options.persistence?.save(entry.id, entry.identity, {
			status,
			...(entry.endpoint ? { endpoint: entry.endpoint } : {}),
			balance,
			fetchedAt,
			attemptedAt,
		});
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
		return Object.fromEntries([...this.entries].map(([id, e]) => [id, e.snapshot.generation]));
	}

	/** Does not schedule network activity; useful immediately after scheduling a mutation. */
	peek(id: string): ProviderBalanceSnapshot | null {
		this.sync();
		const snapshot = this.entries.get(id)?.snapshot;
		return snapshot ? structuredClone(snapshot) : null;
	}

	/** Only pending entries qualify; unsupported and failed discoveries are not polled. */
	discoverPending(): void {
		this.sync();
		this.fillPending();
	}

	private fillPending(): void {
		for (const entry of this.entries.values()) {
			if (this.queue.length >= (this.options.maxQueued ?? MAX_QUEUED)) break;
			if (entry.snapshot.status === "pending" && !entry.task) void this.schedule(entry, "probe");
		}
	}

	read(providerId?: string): Record<string, ProviderBalanceSnapshot> {
		this.sync();
		const selected = [...this.entries].filter(([id]) => !providerId || id === providerId);
		for (const [, entry] of selected) {
			if (entry.snapshot.status === "pending") void this.schedule(entry, "probe");
			else if (
				entry.snapshot.status === "supported" &&
				this.now() - entry.snapshot.attemptedAt >= PROVIDER_BALANCE_STALE_MS
			) {
				void this.schedule(entry, "refresh");
			} else if (
				// A transient failure with a known endpoint is retryable: without this the
				// entry would sit in its failure state forever once the keep-last-good
				// window expired. Deterministic failures are deliberately excluded.
				entry.snapshot.error === "request_failed" &&
				entry.endpoint !== undefined &&
				this.now() - entry.snapshot.attemptedAt >= PROVIDER_BALANCE_STALE_MS
			) {
				void this.schedule(entry, "refresh");
			} else if (
				// A disabled capability plugin is re-discovered rather than retried: the
				// answer is a configuration state that only an administrator can change, and
				// re-enabling it has to bring the value back without a manual probe. Active
				// discovery is cheap here — it is refused before any process is spawned.
				entry.snapshot.error === "plugin_not_enabled" &&
				this.now() - entry.snapshot.attemptedAt >= PROVIDER_BALANCE_STALE_MS
			) {
				void this.schedule(entry, "probe");
			}
		}
		return Object.fromEntries(selected.map(([id, entry]) => [id, structuredClone(entry.snapshot)]));
	}

	/** Let HTTP callers report cooldown/backpressure instead of claiming a probe started. */
	manualRetryAfterMs(id: string): number {
		this.sync();
		const entry = this.entries.get(id);
		if (!entry || entry.task || entry.snapshot.error === "invalid_configuration") return 0;
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
		if (entry.snapshot.error === "invalid_configuration" || this.now() < entry.nextManualAt) {
			return Promise.resolve(structuredClone(entry.snapshot));
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
		if (mode === "probe") entry.snapshot = { ...entry.snapshot, status: "pending", error: null };
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
			entry.snapshot = {
				...entry.snapshot,
				status: mode === "probe" ? "probing" : "supported",
				attemptedAt: this.now(),
			};
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
				entry.snapshot = {
					...entry.snapshot,
					status: found ? "supported" : "unsupported",
					adapter: found?.adapter,
					balance: found?.balance ?? null,
					fetchedAt: found ? this.now() : 0,
					error: null,
				};
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
				entry.snapshot = { ...entry.snapshot, balance, fetchedAt: this.now(), error: null };
			}
		} catch (error) {
			// An aborted round is a failure if this identity still exists. A superseded
			// request is instead discarded, even if its transport ignored cancellation.
			this.sync();
			if (this.entries.get(entry.id) === entry) {
				entry.snapshot = this.failureSnapshot(entry, error);
			}
		} finally {
			clearTimeout(timer);
			if (entry.task === task) entry.task = undefined;
			if (this.entries.get(entry.id) === entry) this.persist(entry);
			const elapsed = performance.now() - startedAt;
			if (elapsed >= 2_000) {
				const safeId = /^[\w-]{1,64}$/.test(entry.id) ? entry.id : "custom-provider";
				logger.warn(
					`[provider-balance] slow operation provider=${safeId} mode=${mode} durationMs=${Math.round(elapsed)} status=${entry.snapshot.status}`,
				);
			}
			task.resolve(this.entries.get(entry.id) === entry ? structuredClone(entry.snapshot) : null);
		}
	}
}

export const providerBalanceCache = new ProviderBalanceCache({
	providers: () => settings.customApiProviders ?? [],
	globalProxy: () => settings.proxy,
	persistence: createPersistedCredentialCache(
		"provider-balances.json",
		parsePersistedProviderBalance,
	),
});

export const getProviderBalanceGenerations = () => providerBalanceCache.generations();
export const syncProviderBalanceCache = () => providerBalanceCache.sync();
export const discoverPendingProviderBalances = () => providerBalanceCache.discoverPending();
