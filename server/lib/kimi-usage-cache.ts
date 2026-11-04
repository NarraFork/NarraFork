import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { logger } from "./logger";
import { getNarraforkHome } from "./narrafork-home";
import { outboundFetch } from "./net/outbound-fetch";
import { resolveProxyForUrl } from "./net/proxy";
import { registerKeyQuotaProbe } from "./provider-key-quota";
import { shownSubjectId, type UsageSubject, usageSubjects } from "./provider-key-subjects";
import { type CustomApiProviderConfig, settings } from "./settings";

/**
 * Kimi (kimi.com / kimi.ai coding plan) usage quota cache.
 *
 * Mirrors the NUG quota pattern: one global cache entry per provider, persisted
 * to ~/.narrafork/kimi-usages.json. Refresh is demand-driven — on startup, when
 * provider settings change, and stale-while-revalidate when the frontend reads
 * it — so nothing polls while no Kimi provider is in use. The status bar shows
 * the 5-hour window; the popover lists the weekly/monthly limits.
 *
 * The upstream endpoint `GET {origin}/coding/v1/usages` answers in two shapes
 * (both are parsed here):
 *   - `{ usage: {...}, limits: [{ window: { duration, timeUnit }, detail: {...} }] }`
 *     — `usage` is the weekly aggregate; `limits[]` carries per-window limits.
 *   - `{ data: [{ model_name: "all", used, limit, resetTime }, ...] }`
 *     — `model_name: "all"` is the weekly aggregate; other entries are windows.
 */

export interface KimiUsageWindow {
	used: number | null;
	limit: number | null;
	remaining: number | null;
	/** ISO timestamp when the window resets, as reported upstream. */
	resetTime: string | null;
}

export interface KimiUsagePayload {
	fiveHour: KimiUsageWindow | null;
	weekly: KimiUsageWindow | null;
	monthly: KimiUsageWindow | null;
	/** Windows that map to none of the known buckets, kept for the details popover. */
	extraWindows: Array<{ label: string } & KimiUsageWindow>;
}

export interface KimiUsageCache extends KimiUsagePayload {
	fetchedAt: number;
	/** Last fetch/parse error; stale window data is kept alongside it. */
	error: string | null;
}

const KIMI_USAGES_PATH = "/coding/v1/usages";
const KIMI_CLI_USER_AGENT = "KimiCLI/1.6";
const FETCH_TIMEOUT_MS = 15_000;
const SAVE_DEBOUNCE_MS = 250;

/**
 * Age at which a cached entry counts as stale, in ms.
 *
 * The app's global cadence for this endpoint: the HTTP route revalidates entries
 * older than this, so N readers polling at any rate cannot produce more than one
 * upstream call per provider per window. Exported because a second reader — the
 * quota-wall resolver in `kimi-quota-wait.ts` — must not raise that rate, and
 * sharing the number is what keeps the two from drifting apart.
 */
export const KIMI_USAGES_STALE_MS = 60_000;

const cacheDir = getNarraforkHome();
const cachePath = resolve(cacheDir, "kimi-usages.json");

const cachedUsageByProvider = new Map<string, KimiUsageCache>();
/**
 * Refreshes currently in flight, keyed by provider id.
 *
 * Required because staleness is judged by `fetchedAt`, which is only written once
 * a fetch RESOLVES. Without this map every request arriving during a refresh sees
 * the same stale (or absent) entry and starts its own upstream call: the first
 * page load has no cache at all, the frontend polls on a 60s interval, and a
 * NarratorPanel can be mounted several times over (workspace / dock) across
 * several tabs and users — so "one refresh per stale window" silently became "one
 * per reader per interval" against a third-party API.
 *
 * Joining the in-flight promise also means concurrent callers observe the same
 * result rather than racing to overwrite the cache in arrival order.
 */
const refreshInFlightByProvider = new Map<string, Promise<KimiUsageCache | null>>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveInFlight = false;
let saveRequested = false;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** True when the provider's baseUrl points at a kimi.com / kimi.ai host. */
export function isKimiCustomApiProvider(config: { baseUrl?: string; disabled?: boolean }): boolean {
	if (config.disabled || !config.baseUrl) return false;
	try {
		const host = new URL(config.baseUrl).hostname.toLowerCase();
		return (
			host === "kimi.com" ||
			host === "kimi.ai" ||
			host.endsWith(".kimi.com") ||
			host.endsWith(".kimi.ai")
		);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Response parsing (pure — unit tested)
// ---------------------------------------------------------------------------

function normalizeNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function normalizeResetTime(value: unknown): string | null {
	if (typeof value === "string" && value.trim()) return value.trim();
	// `reset_in` (seconds-until-reset) appears in some payload variants.
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
		return new Date(Date.now() + value * 1000).toISOString();
	}
	return null;
}

function normalizeWindow(record: unknown): KimiUsageWindow | null {
	if (!record || typeof record !== "object") return null;
	const r = record as Record<string, unknown>;
	const used = normalizeNumber(r.used);
	const limit = normalizeNumber(r.limit);
	const remaining = normalizeNumber(r.remaining ?? r.left);
	const resetTime = normalizeResetTime(r.resetTime ?? r.reset_time ?? r.reset_in);
	if (used == null && limit == null && remaining == null && resetTime == null) return null;
	return { used, limit, remaining, resetTime };
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const MINUTES_PER_MONTH = 30 * MINUTES_PER_DAY;

/** Convert `{ duration, timeUnit }` to minutes; null when unrecognized. */
function windowDurationMinutes(window: unknown): number | null {
	if (!window || typeof window !== "object") return null;
	const w = window as Record<string, unknown>;
	const duration = normalizeNumber(w.duration);
	if (duration == null || duration <= 0) return null;
	switch (String(w.timeUnit ?? "").toUpperCase()) {
		case "TIME_UNIT_MINUTE":
			return duration;
		case "TIME_UNIT_HOUR":
			return duration * MINUTES_PER_HOUR;
		case "TIME_UNIT_DAY":
			return duration * MINUTES_PER_DAY;
		case "TIME_UNIT_WEEK":
			return duration * MINUTES_PER_WEEK;
		case "TIME_UNIT_MONTH":
			return duration * MINUTES_PER_MONTH;
		default:
			return null;
	}
}

function formatWindowLabel(minutes: number): string {
	if (minutes % MINUTES_PER_MONTH === 0) return `${minutes / MINUTES_PER_MONTH}mo`;
	if (minutes % MINUTES_PER_WEEK === 0) return `${minutes / MINUTES_PER_WEEK}w`;
	if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}d`;
	if (minutes % MINUTES_PER_HOUR === 0) return `${minutes / MINUTES_PER_HOUR}h`;
	return `${minutes}min`;
}

/**
 * Map a window length to one of the three displayed buckets.
 *
 * The month bucket accepts any 28–31 day span, not exactly `MINUTES_PER_MONTH`.
 * That constant is a 30-day approximation, so an upstream reporting a calendar
 * month (`TIME_UNIT_DAY` × 31, or `TIME_UNIT_MONTH` normalized differently) missed
 * the equality test and landed in `extraWindows` — the "Monthly limit" row silently
 * disappeared and a `4w`-labelled extra row took its place. Weeks and the 5-hour
 * window are exact by nature and stay exact.
 */
function classifyWindowMinutes(minutes: number): "fiveHour" | "weekly" | "monthly" | null {
	if (minutes === 5 * MINUTES_PER_HOUR) return "fiveHour";
	if (minutes === MINUTES_PER_WEEK) return "weekly";
	if (minutes >= 28 * MINUTES_PER_DAY && minutes <= 31 * MINUTES_PER_DAY) return "monthly";
	return null;
}

function emptyPayload(): KimiUsagePayload {
	return { fiveHour: null, weekly: null, monthly: null, extraWindows: [] };
}

/**
 * Shape B: `{ usage: {...}, limits: [{ window, detail }] }`.
 *
 * `limits[]` is processed FIRST, and `usage` only fills a bucket still empty
 * afterwards. `usage` being the weekly aggregate is an OBSERVATION of the current
 * upstream payload, not a documented contract, whereas a `limits[]` entry states
 * its window explicitly (`{ duration, timeUnit }`). Trusting `usage` first meant a
 * real weekly limit from `limits[]` found `payload.weekly` taken and was demoted
 * into `extraWindows` — so the card showed the inferred number under the "Weekly"
 * label and the authoritative one as a nameless extra row.
 */
function parseWindowedShape(body: Record<string, unknown>, payload: KimiUsagePayload): boolean {
	let matched = false;
	if (Array.isArray(body.limits)) {
		for (const entry of body.limits) {
			if (!entry || typeof entry !== "object") continue;
			const e = entry as Record<string, unknown>;
			const window = normalizeWindow(e.detail ?? e.usage ?? e);
			if (!window) continue;
			matched = true;
			const minutes = windowDurationMinutes(e.window);
			const bucket = minutes == null ? null : classifyWindowMinutes(minutes);
			if (bucket === "fiveHour" && !payload.fiveHour) payload.fiveHour = window;
			else if (bucket === "weekly" && !payload.weekly) payload.weekly = window;
			else if (bucket === "monthly" && !payload.monthly) payload.monthly = window;
			else
				payload.extraWindows.push({
					label: minutes == null ? "?" : formatWindowLabel(minutes),
					...window,
				});
		}
	}
	const usage = normalizeWindow(body.usage);
	if (usage) {
		matched = true;
		// Only where `limits[]` said nothing. When it did, `usage` is a duplicate of a
		// window already bucketed, so it is dropped rather than added as an extra row.
		if (!payload.weekly) payload.weekly = usage;
	}
	return matched;
}

/** Shape A: `{ data: [{ model_name: "all" | window-name, used, limit, resetTime }] }`. */
function parseDataListShape(body: Record<string, unknown>, payload: KimiUsagePayload): boolean {
	if (!Array.isArray(body.data)) return false;
	let matched = false;
	for (const entry of body.data) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const window = normalizeWindow(e);
		if (!window) continue;
		matched = true;
		const name = String(e.model_name ?? e.modelName ?? "")
			.trim()
			.toLowerCase();
		if (name === "all") {
			if (!payload.weekly) payload.weekly = window;
		} else if (/5\s*h|five/.test(name)) {
			if (!payload.fiveHour) payload.fiveHour = window;
			else payload.extraWindows.push({ label: name, ...window });
		} else if (/week|周/.test(name)) {
			if (!payload.weekly) payload.weekly = window;
			else payload.extraWindows.push({ label: name, ...window });
		} else if (/month|月/.test(name)) {
			if (!payload.monthly) payload.monthly = window;
			else payload.extraWindows.push({ label: name, ...window });
		} else {
			payload.extraWindows.push({ label: name || "?", ...window });
		}
	}
	return matched;
}

/** Parse both documented response shapes into the normalized payload. */
export function parseKimiUsagesResponse(body: unknown): KimiUsagePayload {
	const payload = emptyPayload();
	if (!body || typeof body !== "object") return payload;
	const record = body as Record<string, unknown>;
	const matchedWindowed = parseWindowedShape(record, payload);
	if (!matchedWindowed) parseDataListShape(record, payload);
	return payload;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** Fetch and parse usages for one Kimi provider. Throws on transport/HTTP errors. */
export async function fetchKimiUsage(config: CustomApiProviderConfig): Promise<KimiUsagePayload> {
	const url = new URL(KIMI_USAGES_PATH, config.baseUrl);
	const response = await outboundFetch(
		url,
		{
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"User-Agent": KIMI_CLI_USER_AGENT,
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		},
		{
			proxyUrl: resolveProxyForUrl(url, config.proxy),
			tlsRejectUnauthorized: config.tlsRejectUnauthorized,
			retryPolicy: "idempotent-only",
		},
	);
	if (!response.ok) {
		throw new Error(`Kimi usages request failed with HTTP ${response.status}`);
	}
	return parseKimiUsagesResponse(await response.json());
}

// ---------------------------------------------------------------------------
// Cache persistence (same debounce pattern as custom-api-quota-cache)
// ---------------------------------------------------------------------------

function loadAllCachedUsages(): void {
	try {
		if (!existsSync(cachePath)) return;
		const data = JSON.parse(readFileSync(cachePath, "utf-8")) as Record<
			string,
			Partial<KimiUsageCache>
		>;
		for (const [providerId, cache] of Object.entries(data)) {
			cachedUsageByProvider.set(providerId, {
				fiveHour: cache.fiveHour ?? null,
				weekly: cache.weekly ?? null,
				monthly: cache.monthly ?? null,
				extraWindows: Array.isArray(cache.extraWindows) ? cache.extraWindows : [],
				fetchedAt: typeof cache.fetchedAt === "number" ? cache.fetchedAt : 0,
				error: typeof cache.error === "string" ? cache.error : null,
			});
		}
	} catch {
		// Corrupt or unreadable cache — ignore; the next refresh rebuilds it.
	}
}

function serializeCachedUsages(): string {
	const data: Record<string, KimiUsageCache> = {};
	for (const [providerId, cache] of cachedUsageByProvider) {
		data[providerId] = cache;
	}
	return JSON.stringify(data);
}

async function flushCachedUsages(): Promise<void> {
	if (saveInFlight) return;
	saveInFlight = true;
	try {
		while (saveRequested) {
			saveRequested = false;
			try {
				await mkdir(cacheDir, { recursive: true });
				await writeFile(cachePath, serializeCachedUsages());
			} catch {
				// Non-critical: failing to persist usage must not break anything.
			}
		}
	} finally {
		saveInFlight = false;
	}
}

function scheduleSaveAllCachedUsages(): void {
	saveRequested = true;
	if (saveTimer || saveInFlight) return;
	saveTimer = setTimeout(() => {
		saveTimer = null;
		void flushCachedUsages();
	}, SAVE_DEBOUNCE_MS);
	saveTimer.unref?.();
}

loadAllCachedUsages();

function setKimiCachedUsage(providerId: string, cache: KimiUsageCache): void {
	cachedUsageByProvider.set(providerId, cache);
	scheduleSaveAllCachedUsages();
}

// ---------------------------------------------------------------------------
// Public API
//
// Entries are per key (see provider-key-subjects.ts): a provider with several keys has
// one entry each, and a migrated first key keeps the provider's id, so older cache
// files still line up. Provider-level reads report the provider's first usable key.
// ---------------------------------------------------------------------------

const kimiSubjects = () => usageSubjects(isKimiCustomApiProvider);

function refreshSubject(subject: UsageSubject): Promise<KimiUsageCache | null> {
	const id = subject.id;
	const inFlight = refreshInFlightByProvider.get(id);
	if (inFlight) return inFlight;
	const config = subject.config;
	const run = (async (): Promise<KimiUsageCache | null> => {
		const existing = cachedUsageByProvider.get(id);
		try {
			const payload = await fetchKimiUsage(config);
			const cache: KimiUsageCache = { ...payload, fetchedAt: Date.now(), error: null };
			setKimiCachedUsage(id, cache);
			return cache;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Keep stale window data visible; only the error field advances.
			//
			// `fetchedAt` advances too when there was no previous entry, so a provider
			// that fails every time is not treated as permanently stale — otherwise the
			// staleness check would re-fetch it on every single request.
			setKimiCachedUsage(id, {
				fiveHour: existing?.fiveHour ?? null,
				weekly: existing?.weekly ?? null,
				monthly: existing?.monthly ?? null,
				extraWindows: existing?.extraWindows ?? [],
				fetchedAt: existing?.fetchedAt ?? Date.now(),
				error: message,
			});
			logger.debug("Kimi usage refresh failed", { provider: config.name, error: message });
			return cachedUsageByProvider.get(id) ?? null;
		} finally {
			// Cleared in `finally` so a thrown/rejected refresh cannot wedge the slot
			// shut and block every later attempt.
			refreshInFlightByProvider.delete(id);
		}
	})();
	refreshInFlightByProvider.set(id, run);
	return run;
}

/**
 * Refresh the usage a provider reports (its first usable key). No-op for non-Kimi
 * providers. Concurrent calls for the same key share ONE upstream request.
 */
export function refreshKimiUsage(providerId: string): Promise<KimiUsageCache | null> {
	const subjects = kimiSubjects();
	const subject = subjects.find((s) => s.id === shownSubjectId(subjects, providerId));
	return subject ? refreshSubject(subject) : Promise.resolve(null);
}

/** Refresh one key's usage (key list). */
export function refreshKimiKeyUsage(keyId: string): Promise<KimiUsageCache | null> {
	const subject = kimiSubjects().find((s) => s.id === keyId);
	return subject ? refreshSubject(subject) : Promise.resolve(null);
}

/** Refresh usage for every key of every configured Kimi provider. */
export async function refreshAllKimiUsages(): Promise<void> {
	await Promise.allSettled(kimiSubjects().map(refreshSubject));
}

/** Refresh keys whose cache is missing or older than maxAgeMs. */
export async function refreshStaleKimiUsages(maxAgeMs: number): Promise<void> {
	const now = Date.now();
	await Promise.allSettled(
		kimiSubjects()
			.filter((s) => now - (cachedUsageByProvider.get(s.id)?.fetchedAt ?? 0) > maxAgeMs)
			.map(refreshSubject),
	);
}

/** The usage a provider reports: that of its first usable key. */
export function getKimiCachedUsage(providerId: string): KimiUsageCache | undefined {
	const id = shownSubjectId(kimiSubjects(), providerId);
	return id ? cachedUsageByProvider.get(id) : undefined;
}

/** Provider id → the usage it reports (status bar). */
export function getAllKimiCachedUsages(): Record<string, KimiUsageCache> {
	const result: Record<string, KimiUsageCache> = {};
	const subjects = kimiSubjects();
	for (const providerId of new Set(subjects.map((s) => s.providerId))) {
		const id = shownSubjectId(subjects, providerId);
		const cache = id ? cachedUsageByProvider.get(id) : undefined;
		if (cache) result[providerId] = cache;
	}
	return result;
}

/** Key id → its usage (key list). */
export function getKimiKeyUsages(): Record<string, KimiUsageCache> {
	const result: Record<string, KimiUsageCache> = {};
	for (const subject of kimiSubjects()) {
		const cache = cachedUsageByProvider.get(subject.id);
		if (cache) result[subject.id] = cache;
	}
	return result;
}

/**
 * Drop cached usage of the given providers' keys (removed or changed identity), and
 * of keys that no longer exist.
 */
export function purgeKimiUsageCache(providerIds: string[]): void {
	const purge = new Set(providerIds);
	const live = new Map(kimiSubjects().map((s) => [s.id, s.providerId]));
	let changed = false;
	for (const id of [...cachedUsageByProvider.keys()]) {
		const providerId = live.get(id);
		if (providerId === undefined || purge.has(providerId) || purge.has(id)) {
			cachedUsageByProvider.delete(id);
			changed = true;
		}
	}
	if (changed) scheduleSaveAllCachedUsages();
}

function exhaustedUntil(window: KimiUsageWindow | null, now: number): number | undefined {
	if (!window?.resetTime) return undefined;
	const usedUp =
		window.remaining === 0 ||
		(window.limit != null &&
			window.used != null &&
			window.limit > 0 &&
			window.used >= window.limit);
	const reset = Date.parse(window.resetTime);
	return usedUp && Number.isFinite(reset) && reset > now ? reset : undefined;
}

// The key pool skips a key whose window this cache has seen used up, until it resets.
registerKeyQuotaProbe((keyId, now) => {
	const cache = cachedUsageByProvider.get(keyId);
	if (!cache) return undefined;
	const until = [cache.fiveHour, cache.weekly, cache.monthly, ...cache.extraWindows]
		.map((window) => exhaustedUntil(window, now))
		.filter((value): value is number => value !== undefined);
	return until.length ? Math.max(...until) : undefined;
});
