/**
 * vlist-reload-policy.test.ts — Pins the structural-reload classification.
 *
 * The key behavioural change these tests protect: deferring a structural reload
 * while the reader has scrolled up is only acceptable now that (a) lifecycle
 * updates bypass this path entirely as in-place patches, and (b) the deferral is
 * VISIBLE via the `deferred` flag. Before, deferring also froze tool/reflection
 * state and said nothing about it.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shellSource } from "./guard-source";
import {
	EXACT_RELOAD_COALESCE_MS,
	EXACT_RELOAD_MAX_DELAY_MS,
	resolveExactReloadDecision,
	resolveReloadDelayMs,
	shouldSurfaceDeferredReload,
} from "./vlist-reload-policy";

const decide = (overrides: Partial<Parameters<typeof resolveExactReloadDecision>[0]> = {}) =>
	resolveExactReloadDecision({
		messageRevision: 4,
		appliedRevision: 3,
		hasIndex: true,
		pinnedToBottom: true,
		...overrides,
	});

describe("resolveExactReloadDecision", () => {
	it("reloads a pending revision when the reader is at the bottom", () => {
		expect(decide()).toEqual({ reload: true, deferred: false });
	});

	it("defers (not ignores) a pending revision while the reader is scrolled up", () => {
		// The distinction matters: `deferred` is what tells the UI the view is behind.
		expect(decide({ pinnedToBottom: false })).toEqual({ reload: false, deferred: true });
	});

	it("neither reloads nor defers when the revision is already applied", () => {
		// Not staleness — nothing to do, so no unread affordance either.
		expect(decide({ messageRevision: 3, appliedRevision: 3 })).toEqual({
			reload: false,
			deferred: false,
		});
		expect(decide({ messageRevision: 3, appliedRevision: 3, pinnedToBottom: false })).toEqual({
			reload: false,
			deferred: false,
		});
	});

	it("stays out of the way before a document exists (the load path owns that)", () => {
		expect(decide({ hasIndex: false })).toEqual({ reload: false, deferred: false });
		expect(decide({ hasIndex: false, pinnedToBottom: false })).toEqual({
			reload: false,
			deferred: false,
		});
	});

	it("applies a revision that jumped several steps in one go (coalesced burst)", () => {
		expect(decide({ messageRevision: 12, appliedRevision: 3 })).toEqual({
			reload: true,
			deferred: false,
		});
	});
});

describe("shouldSurfaceDeferredReload", () => {
	it("surfaces only the deferred case", () => {
		expect(shouldSurfaceDeferredReload({ reload: false, deferred: true })).toBe(true);
		// Applied ⇒ the view IS current; an unread badge would be a lie.
		expect(shouldSurfaceDeferredReload({ reload: true, deferred: false })).toBe(false);
		expect(shouldSurfaceDeferredReload({ reload: false, deferred: false })).toBe(false);
	});
});

describe("EXACT_RELOAD_COALESCE_MS", () => {
	it("is short enough to feel immediate yet long enough to batch one turn's burst", () => {
		expect(EXACT_RELOAD_COALESCE_MS).toBeGreaterThan(0);
		expect(EXACT_RELOAD_COALESCE_MS).toBeLessThanOrEqual(250);
	});
});

/**
 * Without the bound the window is a plain DEBOUNCE: each new revision restarts the
 * timer, and a tool-dense turn emits structural events closer together than the
 * window, so the reload was postponed for the entire turn — the reader watched a
 * frozen document while generation continued.
 */
describe("resolveReloadDelayMs", () => {
	it("waits the full coalescing window at the start of a batch", () => {
		expect(resolveReloadDelayMs(1_000, 1_000)).toBe(EXACT_RELOAD_COALESCE_MS);
	});

	it("keeps returning the window while the batch is young", () => {
		expect(resolveReloadDelayMs(1_000, 1_200)).toBe(EXACT_RELOAD_COALESCE_MS);
	});

	it("shortens the wait so the batch cannot overrun the deadline", () => {
		// 60ms of budget left ⇒ wait 60, not the full 120.
		const now = 1_000 + EXACT_RELOAD_MAX_DELAY_MS - 60;
		expect(resolveReloadDelayMs(1_000, now)).toBe(60);
	});

	it("commits immediately once the max delay has elapsed", () => {
		expect(resolveReloadDelayMs(1_000, 1_000 + EXACT_RELOAD_MAX_DELAY_MS)).toBe(0);
		expect(resolveReloadDelayMs(1_000, 1_000 + EXACT_RELOAD_MAX_DELAY_MS + 5_000)).toBe(0);
	});

	it("never exceeds the coalescing window or goes negative", () => {
		for (let elapsed = 0; elapsed <= EXACT_RELOAD_MAX_DELAY_MS + 500; elapsed += 37) {
			const delay = resolveReloadDelayMs(0, elapsed);
			expect(delay).toBeGreaterThanOrEqual(0);
			expect(delay).toBeLessThanOrEqual(EXACT_RELOAD_COALESCE_MS);
		}
	});

	it("tolerates a clock that appears to run backwards", () => {
		expect(resolveReloadDelayMs(2_000, 1_000)).toBe(EXACT_RELOAD_COALESCE_MS);
	});

	it("bounds a sustained burst: repeated restarts still commit within the max delay", () => {
		// Simulate an event every 20ms (well inside the 120ms window) and confirm the
		// helper drives a commit rather than deferring forever. Each step re-derives
		// the delay from the FIRST pending revision, which is what the shell does.
		const pendingSince = 0;
		let now = 0;
		let committedAt: number | null = null;
		for (let step = 0; step < 200; step++) {
			const delay = resolveReloadDelayMs(pendingSince, now);
			if (delay === 0) {
				committedAt = now;
				break;
			}
			// The next event arrives before the timer fires, restarting it.
			now += Math.min(20, delay);
			if (delay <= 20) {
				committedAt = now;
				break;
			}
		}
		expect(committedAt).not.toBeNull();
		expect(committedAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(EXACT_RELOAD_MAX_DELAY_MS);
	});
});

describe("EXACT_RELOAD_MAX_DELAY_MS", () => {
	it("sits above the coalescing window yet inside a 'live' interval", () => {
		expect(EXACT_RELOAD_MAX_DELAY_MS).toBeGreaterThan(EXACT_RELOAD_COALESCE_MS);
		expect(EXACT_RELOAD_MAX_DELAY_MS).toBeLessThanOrEqual(2_000);
	});
});

/**
 * Two facts about the shell that have no runtime surface to observe from a pure
 * test (the component needs a full narrator + WS + DOM to mount): that it routes
 * the reload through the bounded window at all, and that it no longer hardcodes an
 * unread count. Kept as source assertions for that reason; the behaviour of the
 * pieces they name is covered above and in vlist-live-wiring.test.ts.
 */
describe("reload policy wiring", () => {
	// Whole module set: the negative rule below forbids the old constant-count
	// expression anywhere in the shell, not merely in its entry file.
	const SHELL = shellSource();

	it("routes the shell's structural reload through the bounded coalescing window", () => {
		expect(SHELL).toContain("resolveExactReloadDecision({");
		expect(SHELL).toContain("resolveReloadDelayMs(");
		// The batch must be anchored on the FIRST pending revision, or the bound is
		// restarted by every arrival and the debounce is back.
		expect(SHELL).toContain("reloadPendingSinceRef");
	});

	it("reports a deferred reload as a COUNT, not a hardcoded flag", () => {
		// The old code reported a constant (first 0, then 1), so a reader scrolled up
		// either had no signal at all or was told "1 new" while 50 were withheld. The
		// consumer renders this as a count ("99+" past its cap), so it must be derived
		// from the revision delta. (The unconditional `?.(0)` on reaching the bottom is
		// a different call site and stays: at the bottom there IS nothing unread.)
		expect(SHELL).toContain("shouldSurfaceDeferredReload(reloadDecision)");
		expect(SHELL).toContain("messageRevision - appliedMessageRevisionRef.current");
		expect(SHELL).not.toContain("hasDeferredReload ? 1 : 0");
	});
});
