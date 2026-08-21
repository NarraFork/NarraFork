import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { logger } from "./logger";
import { getNarraforkHome } from "./narrafork-home";
import { outboundFetch } from "./net/outbound-fetch";
import { resolveProxyForUrl } from "./net/proxy";
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
// ---------------------------------------------------------------------------

/**
 * Refresh a single provider's usage cache. No-op for non-Kimi providers.
 *
 * Concurrent calls for the same provider share ONE upstream request (see
 * `refreshInFlightByProvider`); they all resolve with that request's result.
 */
export function refreshKimiUsage(providerId: string): Promise<KimiUsageCache | null> {
	const inFlight = refreshInFlightByProvider.get(providerId);
	if (inFlight) return inFlight;
	const config = (settings.customApiProviders ?? []).find((p) => p.id === providerId);
	if (!config || !isKimiCustomApiProvider(config) || !config.apiKey) return Promise.resolve(null);
	const run = (async (): Promise<KimiUsageCache | null> => {
		const existing = cachedUsageByProvider.get(providerId);
		try {
			const payload = await fetchKimiUsage(config);
			const cache: KimiUsageCache = { ...payload, fetchedAt: Date.now(), error: null };
			setKimiCachedUsage(providerId, cache);
			return cache;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Keep stale window data visible; only the error field advances.
			//
			// `fetchedAt` advances too when there was no previous entry, so a provider
			// that fails every time is not treated as permanently stale — otherwise the
			// staleness check would re-fetch it on every single request.
			setKimiCachedUsage(providerId, {
				fiveHour: existing?.fiveHour ?? null,
				weekly: existing?.weekly ?? null,
				monthly: existing?.monthly ?? null,
				extraWindows: existing?.extraWindows ?? [],
				fetchedAt: existing?.fetchedAt ?? Date.now(),
				error: message,
			});
			logger.debug("Kimi usage refresh failed", { provider: config.name, error: message });
			return cachedUsageByProvider.get(providerId) ?? null;
		} finally {
			// Cleared in `finally` so a thrown/rejected refresh cannot wedge the slot
			// shut and block every later attempt.
			refreshInFlightByProvider.delete(providerId);
		}
	})();
	refreshInFlightByProvider.set(providerId, run);
	return run;
}

/** Refresh usage for every configured Kimi provider. */
export async function refreshAllKimiUsages(): Promise<void> {
	const providers = (settings.customApiProviders ?? []).filter(
		(p) => isKimiCustomApiProvider(p) && p.apiKey,
	);
	await Promise.allSettled(providers.map((p) => refreshKimiUsage(p.id)));
}

/** Refresh providers whose cache is missing or older than maxAgeMs. */
export async function refreshStaleKimiUsages(maxAgeMs: number): Promise<void> {
	const now = Date.now();
	const providers = (settings.customApiProviders ?? []).filter(
		(p) => isKimiCustomApiProvider(p) && p.apiKey,
	);
	await Promise.allSettled(
		providers
			.filter((p) => now - (cachedUsageByProvider.get(p.id)?.fetchedAt ?? 0) > maxAgeMs)
			.map((p) => refreshKimiUsage(p.id)),
	);
}

export function getKimiCachedUsage(providerId: string): KimiUsageCache | undefined {
	return cachedUsageByProvider.get(providerId);
}

export function getAllKimiCachedUsages(): Record<string, KimiUsageCache> {
	const result: Record<string, KimiUsageCache> = {};
	for (const [providerId, cache] of cachedUsageByProvider) {
		result[providerId] = cache;
	}
	return result;
}

/** Drop cached usage for providers that were removed or changed identity. */
export function purgeKimiUsageCache(removedIds: string[]): void {
	let changed = false;
	for (const id of removedIds) {
		if (cachedUsageByProvider.delete(id)) changed = true;
	}
	if (changed) scheduleSaveAllCachedUsages();
}
