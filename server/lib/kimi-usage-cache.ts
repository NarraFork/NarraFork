import { unlink } from "node:fs/promises";
import { epochOf, type QuotaSnapshot, type QuotaWindow } from "@shared/quota-snapshot";
import { identifyService } from "@shared/sourcing/identify";
import { logger } from "./logger";
import { getNarraforkPath } from "./narrafork-home";
import { outboundFetch } from "./net/outbound-fetch";
import { resolveProxyForUrl } from "./net/proxy";
import { shownSubjectId, type UsageSubject, usageSubjects } from "./provider-key-subjects";
import type { CustomApiProviderConfig } from "./settings";
import { quotaStore } from "./sourcing/quota-store";

/**
 * Kimi (kimi.com / kimi.ai coding plan) usage quota cache.
 *
 * One quota snapshot per key in the shared quota store (sourcing/quota-store.ts), under
 * the key's (baseUrl, apiKey) identity. Refresh is demand-driven — on startup, when
 * provider settings change, and stale-while-revalidate when the frontend reads it — so
 * nothing polls while no Kimi provider is in use. The status bar shows the 5-hour
 * window; the popover lists the weekly/monthly limits.
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
/** Keys this module has read or written a snapshot for, so a purge can find dead ones. */
const knownIds = new Set<string>();

// The plaintext cache this module kept before the quota store; its numbers carried no
// credential identity, so they are dropped and probed again rather than imported.
void unlink(getNarraforkPath("kimi-usages.json")).catch(() => {});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** True when an enabled provider's baseUrl points at a kimi.com / kimi.ai host. */
export function isKimiCustomApiProvider(config: { baseUrl?: string; disabled?: boolean }): boolean {
	return !config.disabled && identifyService(config).templateId === "kimi-code";
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
export async function fetchKimiUsage(
	config: CustomApiProviderConfig,
	signal?: AbortSignal,
): Promise<KimiUsagePayload> {
	const url = new URL(KIMI_USAGES_PATH, config.baseUrl);
	const response = await outboundFetch(
		url,
		{
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"User-Agent": KIMI_CLI_USER_AGENT,
				Accept: "application/json",
			},
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
				: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
// Quota snapshots
// ---------------------------------------------------------------------------

/** Share used; a window reporting nothing left counts as used up whatever its other fields. */
function usedRatio(window: KimiUsageWindow): number | null {
	if (window.remaining === 0) return 1;
	if (window.limit == null || window.limit <= 0) return null;
	if (window.used != null) return window.used / window.limit;
	return window.remaining == null ? null : 1 - window.remaining / window.limit;
}

function kimiSnapshot(
	payload: KimiUsagePayload,
	fetchedAt: number,
	error: string | null,
): QuotaSnapshot {
	const window = (
		kind: QuotaWindow["kind"],
		w: KimiUsageWindow | null,
		label?: string,
	): QuotaWindow[] =>
		w
			? [
					{
						kind,
						...(label !== undefined ? { label } : {}),
						usedRatio: usedRatio(w),
						resetsAt: epochOf(w.resetTime),
					},
				]
			: [];
	const { fiveHour, weekly, monthly, extraWindows } = payload;
	return {
		fetchedAt,
		...(error !== null ? { error } : {}),
		scope: "subscription",
		windows: [
			...window("5h", fiveHour),
			...window("weekly", weekly),
			...window("monthly", monthly),
			...extraWindows.flatMap((w) => window("other", w, w.label)),
		],
		balances: [],
		detail: { fiveHour, weekly, monthly, extraWindows } satisfies KimiUsagePayload,
	};
}

/** A snapshot read from disk, rebuilt from its validated detail. */
function restoreSnapshot(snapshot: QuotaSnapshot): QuotaSnapshot {
	const detail = (snapshot.detail ?? {}) as Record<string, unknown>;
	const extraWindows = Array.isArray(detail.extraWindows)
		? detail.extraWindows.flatMap((entry) => {
				const window = normalizeWindow(entry);
				const label = (entry as { label?: unknown }).label;
				return window && typeof label === "string" ? [{ label, ...window }] : [];
			})
		: [];
	return kimiSnapshot(
		{
			fiveHour: normalizeWindow(detail.fiveHour),
			weekly: normalizeWindow(detail.weekly),
			monthly: normalizeWindow(detail.monthly),
			extraWindows,
		},
		snapshot.fetchedAt,
		snapshot.error ?? null,
	);
}

/** The usage endpoint answers for (baseUrl, apiKey) and nothing else. */
const identity = (config: CustomApiProviderConfig) =>
	JSON.stringify([config.baseUrl, config.apiKey]);

/** One quota probe: fetch, then the shared snapshot shape. Throws on failure. */
export async function probeKimiQuota(
	credential: UsageSubject,
	signal?: AbortSignal,
): Promise<QuotaSnapshot> {
	return kimiSnapshot(await fetchKimiUsage(credential.config, signal), Date.now(), null);
}

function usageOf(subject: UsageSubject): KimiUsageCache | undefined {
	const snapshot = quotaStore.get(subject.id, identity(subject.config), restoreSnapshot);
	if (!snapshot) return undefined;
	knownIds.add(subject.id);
	const { fiveHour, weekly, monthly, extraWindows } = snapshot.detail as KimiUsagePayload;
	return {
		fiveHour,
		weekly,
		monthly,
		extraWindows,
		fetchedAt: snapshot.fetchedAt,
		error: snapshot.error ?? null,
	};
}

function setUsage(subject: UsageSubject, snapshot: QuotaSnapshot): void {
	knownIds.add(subject.id);
	quotaStore.set(subject.id, identity(subject.config), snapshot);
}

// ---------------------------------------------------------------------------
// Public API
//
// Entries are per key (see provider-key-subjects.ts): a provider with several keys has
// one entry each, and a migrated first key keeps the provider's id. Provider-level reads
// report the provider's first usable key.
// ---------------------------------------------------------------------------

const kimiSubjects = () => usageSubjects(isKimiCustomApiProvider);

function refreshSubject(subject: UsageSubject): Promise<KimiUsageCache | null> {
	const id = subject.id;
	const inFlight = refreshInFlightByProvider.get(id);
	if (inFlight) return inFlight;
	const run = (async (): Promise<KimiUsageCache | null> => {
		const existing = usageOf(subject);
		// A provider can be edited or re-purposed while the request is out; its late answer
		// must not publish into the snapshot another source now reads for this credential.
		const current = () =>
			kimiSubjects().some(
				(s) => s.id === subject.id && identity(s.config) === identity(subject.config),
			);
		try {
			const fresh = await probeKimiQuota(subject);
			if (current()) setUsage(subject, fresh);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (!current()) return null;
			// Keep stale window data visible; only the error field advances.
			//
			// `fetchedAt` advances too when there was no previous entry, so a provider
			// that fails every time is not treated as permanently stale — otherwise the
			// staleness check would re-fetch it on every single request.
			setUsage(
				subject,
				kimiSnapshot(
					{
						fiveHour: existing?.fiveHour ?? null,
						weekly: existing?.weekly ?? null,
						monthly: existing?.monthly ?? null,
						extraWindows: existing?.extraWindows ?? [],
					},
					existing?.fetchedAt ?? Date.now(),
					message,
				),
			);
			logger.debug("Kimi usage refresh failed", { provider: subject.config.name, error: message });
		} finally {
			// Cleared in `finally` so a thrown/rejected refresh cannot wedge the slot
			// shut and block every later attempt.
			refreshInFlightByProvider.delete(id);
		}
		return usageOf(subject) ?? null;
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
			.filter((s) => now - (usageOf(s)?.fetchedAt ?? 0) > maxAgeMs)
			.map(refreshSubject),
	);
}

/** The usage a provider reports: that of its first usable key. */
export function getKimiCachedUsage(providerId: string): KimiUsageCache | undefined {
	const subjects = kimiSubjects();
	const subject = subjects.find((s) => s.id === shownSubjectId(subjects, providerId));
	return subject ? usageOf(subject) : undefined;
}

/** Provider id → the usage it reports (status bar). */
export function getAllKimiCachedUsages(): Record<string, KimiUsageCache> {
	const result: Record<string, KimiUsageCache> = {};
	const seen = new Set<string>();
	for (const subject of kimiSubjects()) {
		// A provider reports its first subject, cached or not.
		if (seen.has(subject.providerId)) continue;
		seen.add(subject.providerId);
		const cache = usageOf(subject);
		if (cache) result[subject.providerId] = cache;
	}
	return result;
}

/** Key id → its usage (key list). */
export function getKimiKeyUsages(): Record<string, KimiUsageCache> {
	const result: Record<string, KimiUsageCache> = {};
	for (const subject of kimiSubjects()) {
		const cache = usageOf(subject);
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
	for (const id of [...knownIds, ...live.keys()]) {
		const providerId = live.get(id);
		if (providerId === undefined || purge.has(providerId) || purge.has(id)) {
			quotaStore.remove(id);
			knownIds.delete(id);
		}
	}
}
