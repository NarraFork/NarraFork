import { parseOpencodeGoBaseUrl } from "@shared/opencode-go-endpoint";
import { epochOf, type QuotaSnapshot, type QuotaWindow } from "@shared/quota-snapshot";
import { identifyService } from "@shared/sourcing/identify";
import { outboundFetch } from "./net/outbound-fetch";
import { resolveProxyForUrl } from "./net/proxy";
import { shownSubjectId, type UsageSubject, usageSubjects } from "./provider-key-subjects";
import { type CustomApiProviderConfig, settings } from "./settings";
import { importLegacyQuotaCache, quotaStore } from "./sourcing/quota-store";

/**
 * OpenCode Go subscription usage cache.
 *
 * OpenCode Go (`https://opencode.ai/zen/go/v1`, the equivalent
 * `/inference/go/v1`, and the inference service's per-family roots) exposes the
 * account's plan allowance at `GET /zen/go/v1/usage` or `/inference/go/v1/usage`:
 *
 *   { "usage": { "rolling":  { "status", "percent", "resetsAt" },
 *                "weekly":   { ... },
 *                "monthly":  { ... } } }
 *
 * `percent` is how much of that window has already been spent, and the three
 * windows are not calendar periods — the rolling window is the last 5 hours
 * counted from the last request, the week runs from Monday 00:00 UTC, and the
 * month is anchored to the subscription's own anniversary. `resetsAt` is
 * therefore the only reliable statement of "when does this refill", which is
 * exactly what the status bar and the details popover need.
 *
 * The endpoint is not part of OpenCode's documented Console API surface, so the
 * parser tolerates a missing/renamed window and an unrecognized field value
 * instead of failing the whole refresh: a shape change costs that one window's
 * numbers rather than the other two.
 *
 * Known gap, shared with the Kimi indicator: the status bar renders its quota
 * block only when the bar text is non-null, and the bar text comes from `rolling`.
 * So an upstream that renamed `rolling` while keeping the other two windows would
 * leave the block hidden instead of showing weekly/monthly. The parser still
 * carries whatever windows it recognized, so fixing that is a display-layer
 * change (in both indicators), not a data-layer one.
 *
 * The numbers live in the shared quota store (sourcing/quota-store.ts), one snapshot per
 * key under its credential identity, because a percentage of a plan belongs to one
 * account: a restart never resurrects an allowance under a different key. This module
 * keeps the scheduling (staleness, failure backoff, post-request refreshes) and the
 * `generation` that stops a late response from an account the user has since replaced
 * from publishing into the current one.
 */

export interface OpencodeUsageWindow {
	status: "ok" | "rate-limited" | null;
	/** Share of the window's allowance already used, 0-100. */
	percent: number | null;
	/** ISO timestamp when the window resets, as reported upstream. */
	resetsAt: string | null;
	/**
	 * Absolute amounts, when upstream reports them. The documented response only
	 * carries `percent`, so these are optional extras read from whichever field
	 * names a given deployment uses (`used`/`limit`, `usage`/`quota`, …). Units are
	 * the plan's own (OpenCode meters Go in dollars); the UI shows them only as a
	 * ratio and never invents them from `percent`.
	 */
	used?: number | null;
	limit?: number | null;
}

export interface OpencodeUsagePayload {
	/** 5-hour rolling window; the status bar shows what is left of it. */
	rolling: OpencodeUsageWindow | null;
	weekly: OpencodeUsageWindow | null;
	/** Billing-anniversary month, not a calendar month. */
	monthly: OpencodeUsageWindow | null;
	/**
	 * Pay-as-you-go balance the account falls back to past its plan limits (the
	 * Console's "Use balance" option), when upstream reports it. Absent otherwise.
	 */
	balance?: number | null;
}

export interface OpencodeUsageCache extends OpencodeUsagePayload {
	generation: string;
	fetchedAt: number;
	error: string | null;
}

export const OPENCODE_USAGES_STALE_MS = 60_000;
/**
 * Floor between refreshes after a FAILED fetch. Without it a broken key or an
 * upstream outage would be retried on every read of the shared cache; with it,
 * consecutive failures back off 60s → 2m → 4m → … up to {@link FAILURE_BACKOFF_MAX_MS}.
 */
const FAILURE_BACKOFF_MAX_MS = 10 * 60_000;
/**
 * Shortest gap between the post-request refreshes {@link noteOpencodeUsageActivity}
 * schedules. A busy agent sends many requests a minute; the allowance does not
 * need to be re-read after every one of them.
 */
export const OPENCODE_ACTIVITY_REFRESH_MIN_MS = 20_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

interface Entry {
	identity: string;
	generation: string;
	inFlight?: Promise<OpencodeUsageCache | null>;
	controller?: AbortController;
	/** Consecutive failed refreshes, for the backoff. */
	failures: number;
	/** Pending post-request refresh, if one is scheduled. */
	activityTimer?: ReturnType<typeof setTimeout>;
}
const entries = new Map<string, Entry>();

type PersistedUsage = Omit<OpencodeUsageCache, "generation">;

/** The file this cache used before the quota store; read once, then deleted. */
const LEGACY_FILE = "opencode-usages.json";

function parsePersistedUsage(raw: unknown): PersistedUsage | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt)) return null;
	const windows = {
		rolling: normalizeWindow(value.rolling),
		weekly: normalizeWindow(value.weekly),
		monthly: normalizeWindow(value.monthly),
	};
	const balance = normalizeAmount(value.balance);
	return {
		...windows,
		...(balance != null ? { balance } : {}),
		fetchedAt: value.fetchedAt,
		error: typeof value.error === "string" ? "OpenCode usage request failed" : null,
	};
}

function usedRatio(window: OpencodeUsageWindow): number | null {
	if (window.status === "rate-limited") return 1;
	return window.percent == null ? null : window.percent / 100;
}

function opencodeSnapshot(usage: PersistedUsage): QuotaSnapshot {
	const window = (kind: QuotaWindow["kind"], w: OpencodeUsageWindow | null): QuotaWindow[] =>
		w ? [{ kind, usedRatio: usedRatio(w), resetsAt: epochOf(w.resetsAt) }] : [];
	const { rolling, weekly, monthly, balance, fetchedAt, error } = usage;
	return {
		fetchedAt,
		...(error !== null ? { error } : {}),
		scope: "subscription",
		windows: [...window("5h", rolling), ...window("weekly", weekly), ...window("monthly", monthly)],
		// OpenCode meters Go, and the balance it falls back to, in dollars.
		balances: balance != null ? [{ unit: "USD", remaining: balance }] : [],
		detail: { rolling, weekly, monthly, ...(balance != null ? { balance } : {}) },
	};
}

/** A snapshot read from disk, rebuilt from its validated detail. */
function restoreSnapshot(snapshot: QuotaSnapshot): QuotaSnapshot | null {
	const usage = parsePersistedUsage({
		...(snapshot.detail as object),
		fetchedAt: snapshot.fetchedAt,
		error: snapshot.error ?? null,
	});
	return usage && opencodeSnapshot(usage);
}

function cacheOf(id: string, entry: Entry): OpencodeUsageCache {
	const snapshot = quotaStore.get(id, entry.identity, restoreSnapshot);
	const detail = snapshot?.detail as OpencodeUsagePayload | undefined;
	return {
		generation: entry.generation,
		rolling: detail?.rolling ?? null,
		weekly: detail?.weekly ?? null,
		monthly: detail?.monthly ?? null,
		...(detail?.balance != null ? { balance: detail.balance } : {}),
		fetchedAt: snapshot?.fetchedAt ?? 0,
		error: snapshot?.error ?? null,
	};
}

/** One quota probe: fetch, then the shared snapshot shape. Throws on failure. */
export async function probeOpencodeQuota(
	credential: UsageSubject,
	signal: AbortSignal,
): Promise<QuotaSnapshot> {
	const usage = await fetchUsage(credential.config, signal);
	return opencodeSnapshot({ ...usage, fetchedAt: Date.now(), error: null });
}

/**
 * Whether a provider points at an OpenCode Go plan root — `/zen/go/v1`,
 * `/inference/go/v1`, or one of the inference service's per-family roots. See
 * `shared/opencode-go-endpoint.ts` for the accepted set and why it is strict.
 */
export function isOpencodeCustomApiProvider(config: {
	baseUrl?: string;
	disabled?: boolean;
}): boolean {
	return !config.disabled && identifyService(config).templateId === "opencode-go";
}

/**
 * The usage endpoint for a configured Go base URL.
 *
 * Every Go root reports the same account, so the per-family inference roots
 * (`/inference/go/openai/v1`, …) map to `/inference/go/v1/usage`: they have no
 * `/usage` of their own.
 */
export function opencodeUsageUrl(baseUrl: string): string {
	const endpoint = parseOpencodeGoBaseUrl(baseUrl);
	if (!endpoint) throw new Error("Not an OpenCode Go endpoint");
	return endpoint.usageUrl;
}

/**
 * What the cached allowance is a function of.
 *
 * The usage endpoint is addressed by `baseUrl` and authenticated by `apiKey`. The
 * transport fields join them because a proxy or TLS change can decide whether the
 * next refresh reaches the endpoint at all, so dropping the entry and re-fetching is
 * the safe response there.
 *
 * `protocol` is deliberately NOT part of this: it selects the wire format for
 * INFERENCE calls, which the usage request never uses — and under the `opencode`
 * preset all three protocols share one `baseUrl`, so including it threw away a valid
 * cache every time an admin switched format. Same rule the repository already applies
 * to Kimi usage in `getCustomApiProviderIdsWithKimiIdentityChanges`
 * (`routes/settings.ts`).
 */
function identity(config: CustomApiProviderConfig): string {
	return JSON.stringify([
		config.baseUrl,
		config.apiKey,
		config.proxy,
		config.tlsRejectUnauthorized,
		settings.proxy,
	]);
}

let legacyImported = false;

/** Reconcile on every read/refresh as well as settings writes. Old requests lose
 * their entry token, so even an abort-ignoring transport cannot publish a result. */
export function syncOpencodeUsageCache(): void {
	// One entry per key (provider-key-subjects.ts); the identity below covers each key's
	// own secret and proxy, so editing a key drops its numbers.
	const subjects = opencodeSubjects();
	if (!legacyImported) {
		legacyImported = true;
		void importLegacyQuotaCache(
			LEGACY_FILE,
			parsePersistedUsage,
			subjects.map((s) => ({ legacyKey: s.id, id: s.id, identity: identity(s.config) })),
			opencodeSnapshot,
		);
	}
	const providers = new Map(subjects.map((s) => [s.id, s.config]));
	for (const [id, entry] of entries) {
		const config = providers.get(id);
		if (!config || identity(config) !== entry.identity) {
			entries.delete(id);
			entry.controller?.abort();
			clearTimeout(entry.activityTimer);
			// A different account's snapshot must stop steering the key pool at once; a
			// removed key's snapshot goes away entirely.
			if (config) quotaStore.forget(id);
			else quotaStore.remove(id);
		}
	}
	for (const [id, config] of providers) {
		if (!entries.has(id)) {
			entries.set(id, { identity: identity(config), generation: crypto.randomUUID(), failures: 0 });
			// Restore synchronously: the pool reads the snapshot before any refresh finishes.
			quotaStore.get(id, identity(config), restoreSnapshot);
		}
	}
}

function normalizePercent(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.max(0, Math.min(100, value));
}

function normalizeResetsAt(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		// Epoch seconds or milliseconds.
		return new Date(value < 1e12 ? value * 1000 : value).toISOString();
	}
	if (typeof value !== "string" || !value.trim()) return null;
	const raw = value.trim();
	return Number.isNaN(Date.parse(raw)) ? null : raw;
}

function normalizeAmount(value: unknown): number | null {
	if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
		return normalizeAmount(Number(value));
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	return value;
}

/** First present field among aliases; upstream naming is not part of a published contract. */
function pick(record: Record<string, unknown>, keys: string[]): unknown {
	for (const key of keys) {
		if (record[key] !== undefined && record[key] !== null) return record[key];
	}
	return undefined;
}

const USED_KEYS = ["used", "usage", "spent", "usedAmount", "used_amount", "cost"];
const LIMIT_KEYS = ["limit", "quota", "total", "max", "limitAmount", "limit_amount"];
const RESETS_KEYS = ["resetsAt", "resetAt", "resets_at", "reset_at", "resetTime"];
const BALANCE_KEYS = ["balance", "credits", "creditBalance", "credit_balance"];

function normalizeWindow(record: unknown): OpencodeUsageWindow | null {
	if (!record || typeof record !== "object") return null;
	const r = record as Record<string, unknown>;
	const status = r.status === "ok" || r.status === "rate-limited" ? r.status : null;
	const resetsAt = normalizeResetsAt(pick(r, RESETS_KEYS));
	const used = normalizeAmount(pick(r, USED_KEYS));
	const limit = normalizeAmount(pick(r, LIMIT_KEYS));
	const usableLimit = limit != null && limit > 0 ? limit : null;
	// Derive the share only when upstream gave none and both amounts are real.
	const percent =
		normalizePercent(r.percent) ??
		(used != null && usableLimit != null ? normalizePercent((used / usableLimit) * 100) : null);
	if (status == null && percent == null && resetsAt == null) return null;
	return {
		status,
		percent,
		resetsAt,
		...(used != null && usableLimit != null ? { used, limit: usableLimit } : {}),
	};
}

function normalizeBalance(...sources: Record<string, unknown>[]): number | null {
	for (const source of sources) {
		const raw = pick(source, BALANCE_KEYS);
		if (raw && typeof raw === "object") {
			const nested = normalizeAmount(
				pick(raw as Record<string, unknown>, ["amount", "value", "total"]),
			);
			if (nested != null) return nested;
			continue;
		}
		const amount = normalizeAmount(raw);
		if (amount != null) return amount;
	}
	return null;
}

/**
 * Parse `GET …/go/v1/usage`. Tolerant by design: the endpoint is not a
 * published contract, so a missing or renamed window costs that window's
 * numbers (null) rather than the whole refresh, and optional extras (absolute
 * amounts, a pay-as-you-go balance) are read only when present.
 */
export function parseOpencodeUsageResponse(body: unknown): OpencodeUsagePayload {
	if (!body || typeof body !== "object") throw new Error("Invalid usage response");
	const root = body as Record<string, unknown>;
	const usage = root.usage;
	if (!usage || typeof usage !== "object") throw new Error("Invalid usage response");
	const record = usage as Record<string, unknown>;
	const balance = normalizeBalance(record, root);
	return {
		rolling: normalizeWindow(record.rolling ?? record.fiveHour ?? record.five_hour),
		weekly: normalizeWindow(record.weekly ?? record.week),
		monthly: normalizeWindow(record.monthly ?? record.month),
		...(balance != null ? { balance } : {}),
	};
}
async function fetchUsage(
	config: CustomApiProviderConfig,
	signal: AbortSignal,
): Promise<OpencodeUsagePayload> {
	const endpoint = opencodeUsageUrl(config.baseUrl);
	const response = await outboundFetch(
		endpoint,
		{
			headers: {
				// Both credential headers: the `zen` proxy and the `inference` service read
				// the key from different headers depending on the route (`/messages` only
				// honours `x-api-key` on zen), and a per-family Anthropic root is the one a
				// user configured with that convention in mind. Same key either way.
				Authorization: `Bearer ${config.apiKey}`,
				"x-api-key": config.apiKey,
				Accept: "application/json",
			},
			redirect: "error",
			signal,
		},
		{
			proxyUrl: resolveProxyForUrl(endpoint, config.proxy),
			tlsRejectUnauthorized: config.tlsRejectUnauthorized,
			retryPolicy: "never",
		},
	);
	if (!response.ok) {
		void response.body?.cancel().catch(() => {});
		throw new Error("Usage request failed");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Invalid usage response");
	const cancelReader = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancelReader, { once: true });
	if (signal.aborted) cancelReader();
	let size = 0;
	const chunks: Uint8Array[] = [];
	try {
		const declaredSize = Number(response.headers.get("content-length"));
		if (declaredSize > MAX_RESPONSE_BYTES) throw new Error("Usage response too large");
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_RESPONSE_BYTES) throw new Error("Usage response too large");
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return parseOpencodeUsageResponse(JSON.parse(new TextDecoder().decode(bytes)));
	} finally {
		signal.removeEventListener("abort", cancelReader);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

const opencodeSubjects = () => usageSubjects(isOpencodeCustomApiProvider);

/** The entry a provider-level view reports: its first usable key's. */
function shownEntryId(providerId: string): string | undefined {
	return shownSubjectId(opencodeSubjects(), providerId);
}

/** Refresh the usage a provider reports (its first usable key). */
export function refreshOpencodeUsage(providerId: string): Promise<OpencodeUsageCache | null> {
	const id = shownEntryId(providerId);
	return id ? refreshOpencodeKeyUsage(id) : Promise.resolve(null);
}

/** Refresh one key's usage. */
export function refreshOpencodeKeyUsage(keyId: string): Promise<OpencodeUsageCache | null> {
	syncOpencodeUsageCache();
	const entry = entries.get(keyId);
	const subject = opencodeSubjects().find((s) => s.id === keyId);
	if (!entry || !subject) return Promise.resolve(null);
	if (entry.inFlight) return entry.inFlight;
	const snapshot = structuredClone(subject);
	const controller = new AbortController();
	entry.controller = controller;
	entry.inFlight = (async () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cancelled = new Promise<never>((_, reject) => {
			controller.signal.addEventListener("abort", () => reject(new Error("Cancelled")), {
				once: true,
			});
			timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		});
		try {
			const fresh = await Promise.race([
				probeOpencodeQuota(snapshot, controller.signal),
				cancelled,
			]);
			syncOpencodeUsageCache();
			if (entries.get(keyId) !== entry) return null;
			quotaStore.set(keyId, entry.identity, fresh);
			entry.failures = 0;
		} catch {
			syncOpencodeUsageCache();
			if (entries.get(keyId) !== entry) return null;
			// Never copy transport exceptions, response text, or credentials to logs/API.
			// The last good numbers stay so the UI can show them as stale.
			const { generation: _generation, ...previous } = cacheOf(keyId, entry);
			quotaStore.set(
				keyId,
				entry.identity,
				opencodeSnapshot({
					...previous,
					fetchedAt: Date.now(),
					error: "OpenCode usage request failed",
				}),
			);
			entry.failures += 1;
		} finally {
			clearTimeout(timer);
			entry.inFlight = undefined;
			entry.controller = undefined;
		}
		return cacheOf(keyId, entry);
	})();
	return entry.inFlight;
}

/** The allowance a provider reports (its first usable key), or null when it is not a Go provider. */
export function getOpencodeCachedUsage(providerId: string): OpencodeUsageCache | null {
	syncOpencodeUsageCache();
	const id = shownEntryId(providerId);
	const entry = id ? entries.get(id) : undefined;
	return id && entry ? cacheOf(id, entry) : null;
}

/** Provider id → `pick(entry)` of the key it reports. */
function byProvider<T>(pick: (id: string, entry: Entry) => T): Record<string, T> {
	syncOpencodeUsageCache();
	const result: Record<string, T> = {};
	const subjects = opencodeSubjects();
	for (const providerId of new Set(subjects.map((s) => s.providerId))) {
		const id = shownSubjectId(subjects, providerId) ?? "";
		const entry = entries.get(id);
		if (entry) result[providerId] = pick(id, entry);
	}
	return result;
}

/** Provider id → the allowance it reports (status bar). */
export function getAllOpencodeCachedUsages(): Record<string, OpencodeUsageCache> {
	return byProvider(cacheOf);
}

/** Key id → its allowance (key list). */
export function getOpencodeKeyUsages(): Record<string, OpencodeUsageCache> {
	syncOpencodeUsageCache();
	return Object.fromEntries([...entries].map(([id, entry]) => [id, cacheOf(id, entry)]));
}

/** Opaque, random runtime tokens only; never expose or derive them from credentials. */
export function getOpencodeUsageGenerations(): Record<string, string> {
	return byProvider((_id, entry) => entry.generation);
}

export async function refreshAllOpencodeUsages(): Promise<void> {
	syncOpencodeUsageCache();
	await Promise.allSettled([...entries.keys()].map(refreshOpencodeKeyUsage));
}

/**
 * Whether one cache entry is due for a refresh.
 *
 *  - never fetched → due;
 *  - last fetch failed → due only after an exponential backoff (60s, 2m, 4m, …
 *    capped at 10m), so a broken key does not hammer upstream on every read;
 *  - a window's `resetsAt` has passed since the fetch → due now, because the
 *    numbers on screen describe a window that no longer exists;
 *  - otherwise → due once older than `maxAgeMs`.
 *
 * Exported for tests; pure in its inputs.
 */
export function isOpencodeUsageDue(
	entry: { cache: OpencodeUsageCache; failures: number },
	now: number,
	maxAgeMs = OPENCODE_USAGES_STALE_MS,
): boolean {
	const { cache, failures } = entry;
	if (!cache.fetchedAt) return true;
	const age = now - cache.fetchedAt;
	if (failures > 0) {
		const backoff = Math.min(maxAgeMs * 2 ** (failures - 1), FAILURE_BACKOFF_MAX_MS);
		return age >= backoff;
	}
	for (const window of [cache.rolling, cache.weekly, cache.monthly]) {
		const reset = window?.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
		if (Number.isFinite(reset) && reset > cache.fetchedAt && reset <= now) return true;
	}
	return age >= maxAgeMs;
}

export async function refreshStaleOpencodeUsages(
	maxAgeMs = OPENCODE_USAGES_STALE_MS,
): Promise<void> {
	syncOpencodeUsageCache();
	const now = Date.now();
	await Promise.allSettled(
		[...entries]
			.filter(([id, entry]) =>
				isOpencodeUsageDue({ cache: cacheOf(id, entry), failures: entry.failures }, now, maxAgeMs),
			)
			.map(([id]) => refreshOpencodeKeyUsage(id)),
	);
}

/**
 * Note that a request just went to an OpenCode Go provider, so the allowance on
 * screen is about to be out of date.
 *
 * Schedules ONE background refresh per provider, no sooner than
 * {@link OPENCODE_ACTIVITY_REFRESH_MIN_MS} after the last fetch: a burst of
 * agent requests collapses into a single `/usage` call, and an idle provider
 * costs nothing. Fire-and-forget by contract: never awaited by the caller and
 * never throws, so the inference path cannot be slowed or failed by it.
 */
export function noteOpencodeUsageActivity(providerRef: string): void {
	try {
		const config = (settings.customApiProviders ?? []).find(
			(p) => p.prefix === providerRef || p.id === providerRef,
		);
		if (!config || !isOpencodeCustomApiProvider(config) || !config.apiKey) return;
		syncOpencodeUsageCache();
		// The request may have gone out on any of the provider's keys.
		for (const subject of opencodeSubjects()) {
			if (subject.providerId !== config.id) continue;
			const id = subject.id;
			const entry = entries.get(id);
			if (!entry || entry.activityTimer || entry.inFlight) continue;
			const elapsed = Date.now() - cacheOf(id, entry).fetchedAt;
			const delay = Math.max(0, OPENCODE_ACTIVITY_REFRESH_MIN_MS - elapsed);
			const timer = setTimeout(() => {
				if (entry.activityTimer === timer) entry.activityTimer = undefined;
				if (entries.get(id) !== entry) return;
				const due = isOpencodeUsageDue(
					{ cache: cacheOf(id, entry), failures: entry.failures },
					Date.now(),
				);
				if (entry.failures > 0 && !due) return;
				void refreshOpencodeKeyUsage(id).catch(() => {});
			}, delay);
			// Never keep the process alive for a cosmetic refresh.
			(timer as { unref?: () => void }).unref?.();
			entry.activityTimer = timer;
		}
	} catch {
		// Display-only bookkeeping; the request that triggered it must not care.
	}
}
