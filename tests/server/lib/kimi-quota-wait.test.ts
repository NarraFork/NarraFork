import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	bucketNamedByText,
	clampKimiQuotaTarget,
	isKimiQuotaWallText,
	KIMI_QUOTA_MAX_WAIT_MS,
	KIMI_QUOTA_RESET_SKEW_MS,
	type KimiQuotaBucket,
	planKimiQuotaWait,
	selectKimiQuotaResetTarget,
	waitForKimiQuotaReset,
} from "../../../server/lib/kimi-quota-wait";
import type { KimiUsagePayload, KimiUsageWindow } from "../../../server/lib/kimi-usage-cache";

/**
 * The 403 body kimi.com's coding endpoint returns once the 5-hour window is spent,
 * verbatim from the report that motivated this path.
 */
const KIMI_403 =
	"Anthropic API error 403: You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota";

/**
 * The weekly variant, reported later against the same account: it names `weekly
 * (7-day)` rather than a 5-hour window, which is the wording the first
 * implementation mishandled by refusing to wait for a reset further out than its
 * budget.
 */
const WEEKLY_403 =
	"Anthropic API error 403: You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota";

const NOW = Date.parse("2026-09-16T12:00:00.000Z");

function window(overrides: Partial<KimiUsageWindow> = {}): KimiUsageWindow {
	return { used: null, limit: null, remaining: null, resetTime: null, ...overrides };
}

function payload(overrides: Partial<KimiUsagePayload> = {}): KimiUsagePayload {
	return { fiveHour: null, weekly: null, monthly: null, extraWindows: [], ...overrides };
}

describe("isKimiQuotaWallText", () => {
	test("recognizes the observed coding-plan 403", () => {
		expect(isKimiQuotaWallText(KIMI_403)).toBe(true);
	});

	test("recognizes the weekly variant of the same refusal", () => {
		expect(isKimiQuotaWallText(WEEKLY_403)).toBe(true);
	});

	test("recognizes Kimi's own phrasing even without the usage-limit noun family", () => {
		expect(isKimiQuotaWallText("Your quota will reset at 22:22")).toBe(true);
	});

	test("recognizes Kimi's own phrasing even without the usage-limit noun family", () => {
		expect(isKimiQuotaWallText("Your quota will reset at 22:22")).toBe(true);
	});

	test("recognizes a weekly-exhaustion variant", () => {
		expect(isKimiQuotaWallText("You've reached your weekly usage limit for this plan.")).toBe(true);
	});

	test("leaves billing, balance and unrelated failures to the terminal paths", () => {
		// These are NOT recoverable on a schedule: retrying or waiting must never be
		// chosen for them, so they must not enter this path at all.
		for (const text of [
			'insufficient_quota: "check your plan and billing details"',
			"insufficient balance",
			"payment required",
			"Anthropic API error 500: internal server error",
			"",
		]) {
			expect(isKimiQuotaWallText(text), text).toBe(false);
		}
	});
});

describe("bucketNamedByText", () => {
	test("reads the window the refusal names", () => {
		expect(bucketNamedByText(KIMI_403)).toBe("fiveHour");
		expect(bucketNamedByText("You've reached your weekly usage limit.")).toBe("weekly");
		expect(bucketNamedByText("已用尽月额度")).toBe("monthly");
	});

	test("takes whichever window is named FIRST, not whichever pattern is tested first", () => {
		// A weekly refusal often mentions the 5-hour window as background detail.
		expect(
			bucketNamedByText("Weekly usage limit reached. Your 5-hour window resets at 22:22."),
		).toBe("weekly");
	});

	test("reports null when no window is named", () => {
		expect(bucketNamedByText("usage limit exceeded")).toBeNull();
	});
});

describe("selectKimiQuotaResetTarget", () => {
	const fiveHour = window({
		used: 100,
		limit: 100,
		resetTime: new Date(NOW + 3 * 60 * 60 * 1000).toISOString(),
	});
	const weekly = window({
		used: 84,
		limit: 100,
		resetTime: new Date(NOW + 4 * 24 * 60 * 60 * 1000).toISOString(),
	});

	test("honors the window the error names", () => {
		const target = selectKimiQuotaResetTarget(payload({ fiveHour, weekly }), KIMI_403, NOW);
		expect(target?.bucket).toBe("fiveHour");
		expect(target?.resetAt).toBe(NOW + 3 * 60 * 60 * 1000);
	});

	test("falls back to the soonest future reset among exhausted windows", () => {
		// No window named: the weekly limit is not exhausted, so the 5-hour window is
		// the only usable source.
		const target = selectKimiQuotaResetTarget(
			payload({ fiveHour, weekly }),
			"usage limit exceeded",
			NOW,
		);
		expect(target?.bucket).toBe("fiveHour");
	});

	test("ignores a reset instant that already passed", () => {
		const stale = window({
			used: 100,
			limit: 100,
			resetTime: new Date(NOW - 60_000).toISOString(),
		});
		expect(selectKimiQuotaResetTarget(payload({ fiveHour: stale }), KIMI_403, NOW)).toBeNull();
	});

	test("does not invent a wait from a window that is not exhausted", () => {
		const fresh = window({
			used: 1,
			limit: 100,
			resetTime: new Date(NOW + 60_000).toISOString(),
		});
		expect(
			selectKimiQuotaResetTarget(payload({ fiveHour: fresh }), "usage limit exceeded", NOW),
		).toBeNull();
	});

	test("trusts the named window even when the cached numbers look unused", () => {
		// The refusal is first-hand evidence; the cache can be up to a minute old and
		// still show 99/100 while the request it describes was already refused.
		const justUnder = window({
			used: 99,
			limit: 100,
			resetTime: new Date(NOW + 60_000).toISOString(),
		});
		expect(selectKimiQuotaResetTarget(payload({ fiveHour: justUnder }), KIMI_403, NOW)).toEqual({
			bucket: "fiveHour",
			resetAt: NOW + 60_000,
		});
	});

	test("falls back to an unrecognized window rather than failing the resolution", () => {
		const extra = window({
			used: 5,
			limit: 5,
			resetTime: new Date(NOW + 120_000).toISOString(),
		});
		const target = selectKimiQuotaResetTarget(
			payload({ extraWindows: [{ label: "3d", ...extra }] }),
			"usage limit exceeded",
			NOW,
		);
		expect(target).toEqual({ bucket: "other", resetAt: NOW + 120_000 });
	});

	test("returns null with no payload at all", () => {
		expect(selectKimiQuotaResetTarget(undefined, KIMI_403, NOW)).toBeNull();
		expect(selectKimiQuotaResetTarget(null, KIMI_403, NOW)).toBeNull();
	});
});

describe("wait budget", () => {
	test("adds the skew so the wake lands after the upstream clock crosses the window", () => {
		const target = clampKimiQuotaTarget({ bucket: "fiveHour", resetAt: NOW + 60_000 }, NOW);
		expect(target?.resetAt).toBe(NOW + 60_000);
		expect(target?.resumeAt).toBe(NOW + 60_000 + KIMI_QUOTA_RESET_SKEW_MS);
		expect(target?.delayMs).toBe(60_000 + KIMI_QUOTA_RESET_SKEW_MS);
	});

	test("accepts a 5-hour window and refuses a multi-day one", () => {
		const fiveHours = clampKimiQuotaTarget(
			{ bucket: "fiveHour", resetAt: NOW + 5 * 60 * 60 * 1000 },
			NOW,
		);
		expect(fiveHours).not.toBeNull();
		const reported: Array<{ bucket: KimiQuotaBucket; resetAt: number; waitMs: number }> = [];
		const monthly = clampKimiQuotaTarget(
			{ bucket: "monthly", resetAt: NOW + 10 * 24 * 60 * 60 * 1000 },
			NOW,
			(info) => reported.push(info),
		);
		expect(monthly).toBeNull();
		// The reset instant travels with the refusal: it is what the message names.
		expect(reported).toEqual([
			{
				bucket: "monthly",
				resetAt: NOW + 10 * 24 * 60 * 60 * 1000,
				waitMs: 10 * 24 * 60 * 60 * 1000 + 5_000,
			},
		]);
	});

	test("the cap spans a 5-hour window and the daily-ish weekly resets, but not multi-day ones", () => {
		// The cap is a flat day precisely so the WEEKLY window — the refusal this was
		// built for, observed at ~17h — stays inside it, while a monthly reset does not.
		expect(KIMI_QUOTA_MAX_WAIT_MS).toBeGreaterThan(5 * 60 * 60 * 1000);
		expect(KIMI_QUOTA_MAX_WAIT_MS).toBeGreaterThan(17 * 60 * 60 * 1000);
		expect(KIMI_QUOTA_MAX_WAIT_MS).toBeLessThan(2 * 24 * 60 * 60 * 1000);
	});

	/**
	 * The reported regression: a weekly refusal whose reset is most of a day out was
	 * classified correctly but then dropped by a 6-hour cap, so the user saw the raw
	 * 403. The classification never was the bug — the budget was.
	 */
	test("a weekly refusal 17h out is waited on, not dropped", () => {
		const weeklyResetAt = NOW + 17 * 60 * 60 * 1000 + 22 * 60 * 1000;
		const plan = planKimiQuotaWait({
			cached: payload({
				fiveHour: window({
					used: 100,
					limit: 100,
					resetTime: new Date(NOW + 4 * 60 * 60 * 1000).toISOString(),
				}),
				weekly: window({
					used: 100,
					limit: 100,
					resetTime: new Date(weeklyResetAt).toISOString(),
				}),
			}),
			cachedFetchedAt: NOW,
			messageText: WEEKLY_403,
			now: NOW,
		});
		expect(plan.tooFarOut).toBeUndefined();
		expect(plan.needsRefresh).toBe(false);
		// The window the refusal NAMED is the one waited for, even though the 5-hour
		// window resets sooner.
		expect(plan.target?.bucket).toBe("weekly");
		expect(plan.target?.resetAt).toBe(weeklyResetAt);
	});
});

describe("planKimiQuotaWait", () => {
	const exhaustedFiveHour = window({
		used: 100,
		limit: 100,
		resetTime: new Date(NOW + 3 * 60 * 60 * 1000).toISOString(),
	});

	test("a usable cache needs no refresh", () => {
		const plan = planKimiQuotaWait({
			cached: payload({ fiveHour: exhaustedFiveHour }),
			cachedFetchedAt: NOW - 10 * 60_000,
			messageText: KIMI_403,
			now: NOW,
		});
		expect(plan.needsRefresh).toBe(false);
		expect(plan.target?.bucket).toBe("fiveHour");
	});

	test("an unusable, OLD cache owes exactly one refresh", () => {
		const plan = planKimiQuotaWait({
			cached: payload(),
			cachedFetchedAt: NOW - 10 * 60_000,
			messageText: KIMI_403,
			now: NOW,
		});
		expect(plan).toEqual({ target: null, needsRefresh: true });
	});

	test("an unusable, JUST-WRITTEN cache does not — the app's cadence wins", () => {
		// The status bar can have refreshed seconds ago; an error path must not raise
		// the call rate above what the rest of the app already holds.
		const plan = planKimiQuotaWait({
			cached: payload(),
			cachedFetchedAt: NOW - 1_000,
			messageText: KIMI_403,
			now: NOW,
		});
		expect(plan).toEqual({ target: null, needsRefresh: false });
	});

	test("no cache at all owes a refresh", () => {
		const plan = planKimiQuotaWait({
			cached: undefined,
			cachedFetchedAt: null,
			messageText: KIMI_403,
			now: NOW,
		});
		expect(plan.needsRefresh).toBe(true);
	});

	test("a too-distant reset is reported as such, not as missing data", () => {
		const plan = planKimiQuotaWait({
			cached: payload({
				weekly: window({
					used: 100,
					limit: 100,
					resetTime: new Date(NOW + 5 * 24 * 60 * 60 * 1000).toISOString(),
				}),
			}),
			cachedFetchedAt: NOW,
			messageText: "You've reached your weekly usage limit.",
			now: NOW,
		});
		expect(plan.target).toBeNull();
		expect(plan.tooFarOut?.bucket).toBe("weekly");
		// Not a refresh candidate: the data was fine, the budget was not.
		expect(plan.needsRefresh).toBe(false);
	});
});

describe("waitForKimiQuotaReset", () => {
	test("a reset already in the past resolves immediately", async () => {
		await expect(
			waitForKimiQuotaReset(Date.now() - 1_000, new AbortController().signal),
		).resolves.toBe("available");
	});

	test("an abort during the wait resolves as aborted", async () => {
		const controller = new AbortController();
		const waiting = waitForKimiQuotaReset(Date.now() + 60_000, controller.signal);
		controller.abort();
		await expect(waiting).resolves.toBe("aborted");
	});

	test("an already-aborted signal never waits", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(waitForKimiQuotaReset(Date.now() + 60_000, controller.signal)).resolves.toBe(
			"aborted",
		);
	});
});

/**
 * Source-level wiring guards, in the style of `model-availability-wait.test.ts`.
 *
 * The functions above can all be correct while the loop or the orchestrator never
 * calls them — and the loop has TWO refusal paths (an in-stream `invalidState`
 * event and a thrown HTTP error) that must both emit the same suspension. A
 * one-sided wiring is silent: the turn simply keeps failing on one of the two
 * paths, which is precisely what these guards exist to catch.
 */
describe("kimi quota wait wiring", () => {
	const loopSource = readFileSync(
		new URL("../../../server/lib/agent/loop.ts", import.meta.url),
		"utf8",
	);
	const orchestratorSource = readFileSync(
		new URL("../../../server/services/agent-runtime/orchestrator.ts", import.meta.url),
		"utf8",
	);

	test("two refusal paths in the agent loop each resolve a quota decision", () => {
		expect(loopSource.match(/resolveKimiQuotaWait\(/g)?.length).toBe(2);
		expect(loopSource.match(/waitKind: "quota"/g)?.length).toBe(2);
	});

	test("the suspension carries both the wake instant and the upstream reset", () => {
		// `resumeAt` is what the orchestrator sleeps to; `quotaResetAt` is what it
		// names in the message when it declines to wait. A path that set only one of
		// them would silently lose either the wait or the explanation.
		expect(loopSource.match(/resumeAt: kimiQuota\.kind === "wait"/g)?.length).toBe(2);
		expect(loopSource.match(/quotaResetAt: resetAt/g)?.length).toBe(2);
	});

	test("the decision distinguishes a wait from a refusal", () => {
		expect(loopSource).toContain('kimiQuota.kind !== "none"');
		expect(loopSource).toContain('kimiQuota.kind === "wait" ? kimiQuota.wait : kimiQuota.refusal');
	});

	test("the run-scoped wait budget is enforced before parking again", () => {
		expect(orchestratorSource).toContain("MAX_QUOTA_WAITS_PER_RUN");
		expect(orchestratorSource).toContain("runState.recovery.quotaWaits += 1");
	});

	test("a refusal is reported with its reset instant, not only as an error", () => {
		// The user-visible half: a wall that is not waited on must still say when the
		// allowance returns. `errorMessage` is the only carrier that survives a page
		// reload, so the payload goes there.
		expect(orchestratorSource).toContain("errorMessage: JSON.stringify({");
		expect(orchestratorSource).toContain("quotaResetAt,");
		expect(orchestratorSource).toContain("KIMI_QUOTA_EXHAUSTED");
	});

	test("a quota wait is not polled", () => {
		// The whole point of this path over the NUG one: recovery is known, so no
		// request is issued while waiting. A poller reference next to these lines
		// would mean the two mechanisms were conflated.
		const quotaBranch = orchestratorSource.slice(
			orchestratorSource.indexOf("const quotaResumeAt ="),
			orchestratorSource.indexOf("await waitForModelAvailabilityOrChange({"),
		);
		expect(quotaBranch).not.toContain("nugAvailabilityPoller");
	});
});
