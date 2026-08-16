/**
 * file-attribution-shadow.test.ts — the in-memory "recently written by a tool" map.
 *
 * The worktree watcher fires on every file change, including terminal and external editor
 * edits. This map is what stops a write the AI tools just made from being reported as
 * external, so the behaviour under test is twofold:
 *
 *   1. the shadow holds for its TTL and lapses afterwards, and
 *   2. it does not accumulate. Every tool call that touches a file adds entries, and
 *      expiry used to happen only when the watcher asked about that exact path — so a path
 *      written once and never queried, or a workspace that was deleted, stayed for the
 *      process's lifetime.
 *
 * (2) is a leak rather than a correctness bug, which is why it is asserted on the tracked
 * size rather than on any observable answer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	dropRecentlyAttributed,
	markRecentlyAttributed,
	RECENT_ATTRIBUTION_SWEEP_WRITES,
	RECENT_ATTRIBUTION_WINDOW_MS,
	recentlyAttributedSize,
	recentlyAttributedTesting,
	wasRecentlyAttributed,
} from "./file-attribution-service";

const WS = "/tmp/nf-attr-shadow/wt";

/** Enough writes in `workspace` to trip one sweep, without touching any other workspace. */
function tripSweep(workspace: string): number {
	const paths = Array.from({ length: RECENT_ATTRIBUTION_SWEEP_WRITES }, (_, i) => `f-${i}.ts`);
	markRecentlyAttributed(workspace, paths);
	return paths.length;
}

beforeEach(() => {
	recentlyAttributedTesting.clear();
});

afterEach(() => {
	recentlyAttributedTesting.clear();
});

describe("attribution shadow — the behaviour the watcher depends on", () => {
	test("a freshly marked path is shadowed", () => {
		markRecentlyAttributed(WS, ["src/app.ts"]);
		expect(wasRecentlyAttributed(WS, "src/app.ts")).toBe(true);
	});

	test("an unmarked path in a marked workspace is not shadowed", () => {
		// The whole point: everything else in that directory is still classified external.
		markRecentlyAttributed(WS, ["src/app.ts"]);
		expect(wasRecentlyAttributed(WS, "src/other.ts")).toBe(false);
	});

	test("a path in an unknown workspace is not shadowed", () => {
		expect(wasRecentlyAttributed("/tmp/nf-attr-shadow/never", "src/app.ts")).toBe(false);
	});
});

describe("attribution shadow — it must not accumulate", () => {
	test("the periodic sweep reclaims expired entries nobody queried", () => {
		// The case the lazy path could not reach: paths written and never asked about.
		// Back-dating is equivalent to time passing for every reader (both the lazy check and
		// the sweep compare against `Date.now()`) and keeps the test instant.
		markRecentlyAttributed(WS, ["stale-a.ts", "stale-b.ts"]);
		expect(recentlyAttributedSize().paths).toBe(2);
		recentlyAttributedTesting.ageBy(RECENT_ATTRIBUTION_WINDOW_MS + 1);

		// The sweep is tripped from a DIFFERENT workspace, so the stale entries are reachable
		// only by the sweep and not incidentally by these writes.
		const written = tripSweep("/tmp/nf-attr-shadow/other");

		// The stale workspace is gone entirely — its inner map was emptied and then removed,
		// rather than being left behind as an empty Map per dead workspace.
		expect(wasRecentlyAttributed(WS, "stale-a.ts")).toBe(false);
		expect(recentlyAttributedSize()).toEqual({ workspaces: 1, paths: written });
	});

	test("the sweep keeps entries that are still within their window", () => {
		// Reclaiming must be TTL-driven, not "clear everything when the counter trips":
		// dropping a live shadow would reclassify an AI write as external.
		markRecentlyAttributed(WS, ["live.ts"]);
		tripSweep("/tmp/nf-attr-shadow/other");

		expect(wasRecentlyAttributed(WS, "live.ts")).toBe(true);
	});

	test("an entry past its window stops shadowing even before a sweep runs", () => {
		// The lazy check is still the authority on the ANSWER; the sweep only reclaims. A
		// path that has aged out must read as external immediately, without waiting for the
		// write counter to trip.
		markRecentlyAttributed(WS, ["aged.ts"]);
		recentlyAttributedTesting.ageBy(RECENT_ATTRIBUTION_WINDOW_MS + 1);

		expect(recentlyAttributedTesting.writesUntilSweep()).toBeGreaterThan(0);
		expect(wasRecentlyAttributed(WS, "aged.ts")).toBe(false);
	});

	test("dropping a workspace forgets its paths immediately", () => {
		// Called where a worktree is destroyed. Exact and cheap, unlike the amortized sweep:
		// once the directory is gone nothing will ever query those paths again.
		markRecentlyAttributed(WS, ["a.ts", "b.ts"]);
		markRecentlyAttributed("/tmp/nf-attr-shadow/keep", ["c.ts"]);

		dropRecentlyAttributed(WS);

		expect(wasRecentlyAttributed(WS, "a.ts")).toBe(false);
		expect(recentlyAttributedSize()).toEqual({ workspaces: 1, paths: 1 });
	});

	test("re-marking the same path does not add a second entry", () => {
		// Repeated writes to one file are the common case; the map is keyed by path, so the
		// timestamp is refreshed in place.
		for (let i = 0; i < 50; i++) markRecentlyAttributed(WS, ["src/app.ts"]);
		expect(recentlyAttributedSize()).toEqual({ workspaces: 1, paths: 1 });
	});

	test("re-marking refreshes the window rather than keeping the first timestamp", () => {
		// Otherwise a file written repeatedly over a long tool run would age out mid-run and
		// its later writes would be misreported as external.
		markRecentlyAttributed(WS, ["src/app.ts"]);
		recentlyAttributedTesting.ageBy(RECENT_ATTRIBUTION_WINDOW_MS + 1);
		markRecentlyAttributed(WS, ["src/app.ts"]);

		expect(wasRecentlyAttributed(WS, "src/app.ts")).toBe(true);
	});
});
