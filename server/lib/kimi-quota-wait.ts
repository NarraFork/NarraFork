import { abortableSleep } from "./agent/abortable-sleep";
import { isHardUsageLimitText } from "./agent/error-handling";
import {
	getKimiCachedUsage,
	isKimiCustomApiProvider,
	KIMI_USAGES_STALE_MS,
	type KimiUsagePayload,
	type KimiUsageWindow,
	refreshKimiUsage,
} from "./kimi-usage-cache";
import { logger } from "./logger";
import { settings } from "./settings";

/**
 * Wake-up timing for a Kimi (kimi.com / kimi.ai) coding-plan quota wall.
 *
 * A 403 from the coding endpoint ("You've reached your 5-hour usage limit") is a
 * *recoverable* refusal: the allowance is exhausted but the window resets on a
 * published schedule, which `GET /coding/v1/usages` reports per window
 * (`resetTime`). So unlike the NUG path — which cannot know when a credential pool
 * comes back and therefore polls — the only thing this needs is the reset clock.
 *
 * Sleep to that timestamp, then let the caller replay the turn once. Costs one
 * request per window instead of one request per poll interval, and no request at
 * all while waiting.
 *
 * Untestable-by-accident parts (the wait loop and the refresh policy) live here as
 * exported functions so a unit test can drive them without a live narrator.
 */

/**
 * Added to the reported reset instant before waking.
 *
 * The reset timestamp is produced by a different machine's clock and the window
 * only frees up as that clock crosses it, so waking exactly on it can still be
 * refused. A few seconds absorbs skew in the cheap direction.
 */
export const KIMI_QUOTA_RESET_SKEW_MS = 5_000;

/**
 * Longest wait this path will accept. Above it the wall is reported instead of
 * being parked on.
 *
 * A flat day rather than a window-shaped rule, because the resets this must cover
 * are not shaped alike: a 5-hour window is hours away, a weekly window is commonly
 * most of a day away (17h in the case that motivated the number), and a monthly one
 * can be weeks away. One day keeps the weekly case — the one that actually recurs —
 * inside the wait, while still refusing to hold a session for the multi-day resets
 * where the user is better served by an error naming the reset moment.
 *
 * Alongside {@link MAX_QUOTA_WAITS_PER_RUN} this also bounds the worst case of a
 * reset time that keeps resolving to "inside the budget" while never actually
 * recovering.
 */
export const KIMI_QUOTA_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * Consecutive quota suspensions allowed within one run (one user turn).
 *
 * Every suspension costs a full history re-upload, so a reset time that repeatedly
 * resolves to "now-ish" must not become a tight replay loop. Three is generous
 * against the real case — one 5-hour window, or one weekly one — while capping the
 * worst case at three times {@link KIMI_QUOTA_MAX_WAIT_MS}.
 */
export const MAX_QUOTA_WAITS_PER_RUN = 3;

/** Sleep slices: re-read the wall clock instead of trusting one long timer. */
const WAIT_CHUNK_MS = 60_000;

/** Which quota bucket a reset belongs to, for logging and the UI label. */
export type KimiQuotaBucket = "fiveHour" | "weekly" | "monthly" | "other";

/** A resolved wait, addressed to the provider it belongs to. */
export interface KimiQuotaWait extends KimiQuotaWaitTarget {
	providerId: string;
	providerPrefix: string;
}

/**
 * A quota wall that was fully understood but deliberately not parked on.
 *
 * Distinct from "not a quota wall" on purpose: the reset instant IS known here, so
 * the caller can tell the user when the allowance returns instead of forwarding an
 * opaque upstream 403. That difference is the entire reason this variant exists —
 * collapsing it into "no result" is what made a real weekly refusal read as a
 * generic provider error.
 */
export interface KimiQuotaRefusal {
	providerId: string;
	providerPrefix: string;
	bucket: KimiQuotaBucket;
	/** The reset instant as published upstream (no skew applied). */
	resetAt: number;
	/** How long the reset is from the decision point, in ms. */
	waitMs: number;
}

/** The refusal facts before the provider identity is attached. */
export type KimiQuotaRefusalTarget = Omit<KimiQuotaRefusal, "providerId" | "providerPrefix">;

/**
 * What a Kimi quota refusal resolved to.
 *
 *  - `wait` — the reset is inside the budget; the caller sleeps to it.
 *  - `refuse` — the reset is known but beyond the budget; the caller reports it
 *    with the reset instant attached.
 *  - `none` — not a quota wall, not a Kimi endpoint, or no usable reset instant.
 */
export type KimiQuotaDecision =
	| { kind: "wait"; wait: KimiQuotaWait }
	| { kind: "refuse"; refusal: KimiQuotaRefusal }
	| { kind: "none" };

/**
 * Kimi's own wording for an exhausted allowance. Matched in addition to the shared
 * usage-limit family because the observed 403 says "usage limit" but a relay (or a
 * future wording change) is not guaranteed to.
 */
const KIMI_QUOTA_HINTS = ["kimi.com/membership", "quota will reset", "purchase extra usage"];

/**
 * Whether this text describes a Kimi coding-plan allowance that is used up.
 *
 * Deliberately the SHARED usage-limit family (`usage limit` + a consumed verb) plus
 * Kimi's own phrases, and nothing wider: the caller has already established that the
 * provider is a Kimi endpoint, so billing/balance/plan walls for other providers keep
 * their existing terminal handling.
 */
export function isKimiQuotaWallText(text: string): boolean {
	if (!text) return false;
	const lower = text.toLowerCase();
	if (isHardUsageLimitText(lower)) return true;
	return KIMI_QUOTA_HINTS.some((hint) => lower.includes(hint));
}

function parseResetMs(window: KimiUsageWindow | null | undefined): number | null {
	if (!window?.resetTime) return null;
	const parsed = Date.parse(window.resetTime);
	return Number.isFinite(parsed) ? parsed : null;
}

/** A window is exhausted only when both numbers are known and the limit is met. */
function isExhaustedWindow(window: KimiUsageWindow | null | undefined): boolean {
	if (!window || window.used == null || window.limit == null || window.limit <= 0) return false;
	return window.used >= window.limit;
}

/**
 * The window named by the refusal text, if any.
 *
 * Used as a preference rather than a requirement: the error says WHICH limit was
 * hit ("your 5-hour usage limit", or the weekly one), and honoring that window's
 * reset is what makes the eventual retry meaningful. Position-based rather than
 * first-pattern-wins so a message that mentions both ("weekly limit reached, your
 * 5-hour window resets at …") is read as being about whichever it names first.
 */
export function bucketNamedByText(text: string): KimiQuotaBucket | null {
	const lower = text.toLowerCase();
	const patterns: Array<[KimiQuotaBucket, RegExp]> = [
		["fiveHour", /5\s*[-\s]?\s*(?:hour|h\b)|five[-\s]?hour|5\s*小时/],
		["weekly", /week|7\s*[-\s]?day|周/],
		["monthly", /month|月/],
	];
	let best: { bucket: KimiQuotaBucket; index: number } | null = null;
	for (const [bucket, pattern] of patterns) {
		const match = pattern.exec(lower);
		if (match && (!best || match.index < best.index)) best = { bucket, index: match.index };
	}
	return best?.bucket ?? null;
}

function listWindows(
	payload: KimiUsagePayload | null | undefined,
): Array<{ bucket: KimiQuotaBucket; window: KimiUsageWindow }> {
	if (!payload) return [];
	const named: Array<{ bucket: KimiQuotaBucket; window: KimiUsageWindow | null }> = [
		{ bucket: "fiveHour", window: payload.fiveHour },
		{ bucket: "weekly", window: payload.weekly },
		{ bucket: "monthly", window: payload.monthly },
	];
	const out: Array<{ bucket: KimiQuotaBucket; window: KimiUsageWindow }> = [];
	for (const entry of named) {
		if (entry.window) out.push({ bucket: entry.bucket, window: entry.window });
	}
	// `extraWindows` carry the same fields under a label the parser could not bucket.
	// Included so an unrecognized-but-real window is still usable as a reset source
	// instead of making the whole resolution fail.
	for (const extra of payload.extraWindows ?? []) {
		out.push({ bucket: "other", window: extra });
	}
	return out;
}

/**
 * Pick the reset instant to wait for out of a usage payload.
 *
 * Preference order:
 *  1. the window the refusal named, when it has a future reset,
 *  2. otherwise the SOONEST future reset among exhausted windows.
 *
 * (2) is opportunistic on purpose: with several windows exhausted, waiting for the
 * earliest reset may be refused again by a still-exhausted sibling, but the next
 * cycle reports that sibling and is bounded by {@link MAX_QUOTA_WAITS_PER_RUN}.
 * Waiting for the LATEST reset instead would almost always exceed
 * {@link KIMI_QUOTA_MAX_WAIT_MS} and turn a genuine 5-hour wall into an error.
 */
export function selectKimiQuotaResetTarget(
	payload: KimiUsagePayload | null | undefined,
	messageText: string,
	now: number,
): { bucket: KimiQuotaBucket; resetAt: number } | null {
	const windows = listWindows(payload);
	const future = windows.filter((entry) => {
		const resetMs = parseResetMs(entry.window);
		return resetMs != null && resetMs > now;
	});

	const named = bucketNamedByText(messageText);
	if (named) {
		const match = future.find((entry) => entry.bucket === named);
		if (match) return { bucket: match.bucket, resetAt: parseResetMs(match.window) as number };
	}

	const exhausted = future
		.filter((entry) => isExhaustedWindow(entry.window))
		.sort((a, b) => (parseResetMs(a.window) as number) - (parseResetMs(b.window) as number));
	const first = exhausted[0];
	if (!first) return null;
	return { bucket: first.bucket, resetAt: parseResetMs(first.window) as number };
}

/** A resolved wait: the instant to wake at, and the upstream reset it derives from. */
export interface KimiQuotaWaitTarget {
	bucket: KimiQuotaBucket;
	/** The reset instant as published upstream (no skew applied). */
	resetAt: number;
	/** Epoch ms at which the turn may be replayed (`resetAt` + skew). */
	resumeAt: number;
	/** How long the caller will actually wait, in ms. */
	delayMs: number;
}

/** Outcome of deciding what a cached payload can tell us about a quota wait. */
export interface KimiQuotaWaitPlan {
	/** A usable wait, or null when the cache resolved nothing. */
	target: KimiQuotaWaitTarget | null;
	/**
	 * Whether one usage-endpoint call is owed before giving up.
	 *
	 * False when the cached entry is young enough that the app's own cadence
	 * ({@link KIMI_USAGES_STALE_MS}) says another upstream call is not due — the
	 * error path must not raise the request rate the rest of the app holds.
	 */
	needsRefresh: boolean;
	/**
	 * Set when a reset WAS found but lies beyond the wait budget. Carried rather
	 * than logged here so this stays a pure decision; the caller turns it into a
	 * refusal it can explain to the user (with the reset instant), which is why
	 * `resetAt` travels with it.
	 */
	tooFarOut?: { bucket: KimiQuotaBucket; resetAt: number; waitMs: number };
}

/**
 * Apply the skew and the wait budget to a chosen reset instant.
 *
 * Returns null past {@link KIMI_QUOTA_MAX_WAIT_MS}; that case is reported through
 * {@link KimiQuotaWaitPlan.tooFarOut} by the caller rather than silently treated as
 * "no data", because the two need different log lines — and, for the user, different
 * messages.
 */
export function clampKimiQuotaTarget(
	target: { bucket: KimiQuotaBucket; resetAt: number } | null,
	now: number,
	tooFarOut?: (info: { bucket: KimiQuotaBucket; resetAt: number; waitMs: number }) => void,
): KimiQuotaWaitTarget | null {
	if (!target) return null;
	const resumeAt = target.resetAt + KIMI_QUOTA_RESET_SKEW_MS;
	const delayMs = resumeAt - now;
	if (delayMs > KIMI_QUOTA_MAX_WAIT_MS) {
		tooFarOut?.({ bucket: target.bucket, resetAt: target.resetAt, waitMs: delayMs });
		return null;
	}
	return {
		bucket: target.bucket,
		resetAt: target.resetAt,
		resumeAt,
		delayMs: Math.max(delayMs, 0),
	};
}

/**
 * Decide, from a cached payload alone, whether the wait is already known or one
 * usage-endpoint call is owed.
 *
 * Pure and exported because this is where the two product rules live: the reset
 * preference order (see {@link selectKimiQuotaResetTarget}) and the rate limit on
 * the one refresh the error path is allowed.
 */
export function planKimiQuotaWait(input: {
	cached: KimiUsagePayload | null | undefined;
	/** When `cached` was last written; null when there is no entry at all. */
	cachedFetchedAt: number | null;
	messageText: string;
	now: number;
}): KimiQuotaWaitPlan {
	let tooFarOut: KimiQuotaWaitPlan["tooFarOut"];
	const target = clampKimiQuotaTarget(
		selectKimiQuotaResetTarget(input.cached, input.messageText, input.now),
		input.now,
		(info) => {
			tooFarOut = info;
		},
	);
	if (target) return { target, needsRefresh: false };
	if (tooFarOut) return { target: null, needsRefresh: false, tooFarOut };
	const cacheIsFresh =
		input.cachedFetchedAt != null && input.now - input.cachedFetchedAt < KIMI_USAGES_STALE_MS;
	return { target: null, needsRefresh: !cacheIsFresh };
}

/**
 * Resolve the wait for one provider, using the cached usage payload and — only
 * when the cache cannot answer and its entry is old enough — ONE extra call to the
 * usage endpoint.
 *
 * `refreshKimiUsage` coalesces concurrent refreshes per provider, so even a burst
 * of refused turns shares a single upstream call. There is no polling loop here: a
 * resolution that needs more than that one call reports the wall instead.
 */
export async function resolveKimiQuotaResumeTarget(
	providerId: string,
	messageText: string,
	now = Date.now(),
): Promise<KimiQuotaWaitTarget | KimiQuotaRefusalTarget | null> {
	const cached = getKimiCachedUsage(providerId);
	const plan = planKimiQuotaWait({
		cached,
		cachedFetchedAt: cached?.fetchedAt ?? null,
		messageText,
		now,
	});
	if (plan.target) return plan.target;
	if (plan.tooFarOut) {
		logger.info("Kimi quota reset is too far out to wait for", {
			providerId,
			bucket: plan.tooFarOut.bucket,
			waitMinutes: Math.round(plan.tooFarOut.waitMs / 60_000),
			maxWaitMinutes: Math.round(KIMI_QUOTA_MAX_WAIT_MS / 60_000),
		});
		return {
			bucket: plan.tooFarOut.bucket,
			resetAt: plan.tooFarOut.resetAt,
			waitMs: plan.tooFarOut.waitMs,
		};
	}
	if (!plan.needsRefresh) return null;
	const refreshed = await refreshKimiUsage(providerId);
	let tooFarOut: KimiQuotaRefusalTarget | undefined;
	const target = clampKimiQuotaTarget(
		selectKimiQuotaResetTarget(refreshed ?? cached, messageText, now),
		now,
		(info) => {
			logger.info("Kimi quota reset (after refresh) is too far out to wait for", {
				providerId,
				bucket: info.bucket,
				waitMinutes: Math.round(info.waitMs / 60_000),
			});
			tooFarOut = info;
		},
	);
	return target ?? tooFarOut ?? null;
}

/**
 * Resolve what a refusal from the provider identified by its prefix (or id) means.
 *
 * Single entry point for the agent loop so the loop body carries one call instead
 * of the provider lookup, the wording check and the reset lookup.
 *
 * `refuse` is returned for a REAL quota wall whose reset is known but beyond the
 * budget — the caller must report it with the reset instant rather than drop it,
 * because "the allowance is spent and returns at T" is actionable and an opaque 403
 * is not.
 */
export async function resolveKimiQuotaWait(
	providerRef: string,
	errorText: string,
	now = Date.now(),
): Promise<KimiQuotaDecision> {
	if (!isKimiQuotaWallText(errorText)) return { kind: "none" };
	const config = (settings.customApiProviders ?? []).find(
		(provider) =>
			!provider.disabled && (provider.prefix === providerRef || provider.id === providerRef),
	);
	if (!config || !isKimiCustomApiProvider(config)) return { kind: "none" };
	const target = await resolveKimiQuotaResumeTarget(config.id, errorText, now);
	if (!target) return { kind: "none" };
	const providerId = config.id;
	const providerPrefix = config.prefix ?? providerRef;
	if ("resumeAt" in target) {
		return { kind: "wait", wait: { ...target, providerId, providerPrefix } };
	}
	return { kind: "refuse", refusal: { ...target, providerId, providerPrefix } };
}

/**
 * Sleep until the quota window resets, or until the turn is aborted.
 *
 * Resolves `"available"` when the reset instant has passed (the caller then replays
 * the turn once) and `"aborted"` when the signal fired. The wait is sliced rather
 * than handed to a single timer so it (a) never overflows `setTimeout`'s 32-bit
 * delay, (b) re-reads the wall clock instead of trusting one deadline across clock
 * jumps or machine suspend, and (c) keeps abort latency inside one slice.
 */
export async function waitForKimiQuotaReset(
	resumeAt: number,
	signal: AbortSignal,
): Promise<"available" | "aborted"> {
	while (!signal.aborted) {
		const remaining = resumeAt - Date.now();
		if (remaining <= 0) return "available";
		await abortableSleep(Math.min(remaining, WAIT_CHUNK_MS), signal);
	}
	return "aborted";
}
