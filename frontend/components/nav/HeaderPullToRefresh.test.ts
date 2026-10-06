/**
 * HeaderPullToRefresh — gesture geometry + wiring contract.
 *
 * The geometry is what decides whether the gesture feels right and, more
 * importantly, whether it fires by ACCIDENT: this one reloads the page, so a
 * sideways swipe across the header's tab strip or a short downward nudge must never
 * arm it. Those thresholds are invisible in a render test, so they are tested
 * directly through the pure classifier.
 *
 * The rest is a source-level contract for the two properties that would be
 * expensive to reproduce with a synthetic touch stream but easy to break silently.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyPullStep } from "./HeaderPullToRefresh";

const SOURCE = readFileSync(join(import.meta.dir, "HeaderPullToRefresh.tsx"), "utf8");

/** Source lines that are not comments. */
function codeLines(source: string): string[] {
	return source.split("\n").filter((line) => {
		const trimmed = line.trim();
		return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
	});
}

/** Mirrors ARM_DISTANCE_PX / HORIZONTAL_ABORT_PX in the component. */
const ARM_DISTANCE_PX = 64;
const HORIZONTAL_ABORT_PX = 24;

describe("classifyPullStep — when the gesture arms", () => {
	it("arms only once the finger has travelled the full arm distance", () => {
		expect(classifyPullStep(0, ARM_DISTANCE_PX - 1)).toMatchObject({ phase: "pulling" });
		expect(classifyPullStep(0, ARM_DISTANCE_PX)).toMatchObject({ phase: "armed" });
		expect(classifyPullStep(0, ARM_DISTANCE_PX * 3)).toMatchObject({ phase: "armed" });
	});

	it("aborts on an upward or stationary drag", () => {
		expect(classifyPullStep(0, 0)).toEqual({ kind: "abort" });
		expect(classifyPullStep(0, -80)).toEqual({ kind: "abort" });
	});

	it("aborts a sideways drag even when it travels far enough downward", () => {
		// The header hosts a horizontally scrollable tab strip; a diagonal swipe
		// there must stay a swipe rather than reloading the app.
		expect(classifyPullStep(HORIZONTAL_ABORT_PX + 1, ARM_DISTANCE_PX * 2)).toEqual({
			kind: "abort",
		});
		expect(classifyPullStep(-(HORIZONTAL_ABORT_PX + 1), ARM_DISTANCE_PX * 2)).toEqual({
			kind: "abort",
		});
	});

	it("tolerates slop within the horizontal budget", () => {
		expect(classifyPullStep(HORIZONTAL_ABORT_PX, ARM_DISTANCE_PX)).toMatchObject({
			phase: "armed",
		});
	});
});

describe("classifyPullStep — indicator travel", () => {
	it("grows monotonically with the pull", () => {
		const offsets = [8, 24, 48, 96, 240].map((dy) => {
			const step = classifyPullStep(0, dy);
			if (step.kind !== "track") throw new Error(`unexpected abort at dy=${dy}`);
			return step.offsetPx;
		});
		for (let i = 1; i < offsets.length; i++) {
			expect(offsets[i]).toBeGreaterThan(offsets[i - 1] as number);
		}
	});

	it("stays bounded no matter how far the finger travels (damped, not linear)", () => {
		const step = classifyPullStep(0, 5_000);
		if (step.kind !== "track") throw new Error("unexpected abort");
		// A linear mapping would put the indicator thousands of px down the screen.
		expect(step.offsetPx).toBeLessThanOrEqual(48);
	});
});

describe("HeaderPullToRefresh — wiring contract", () => {
	it("clears the PWA cache before reloading", () => {
		// Skipping this would let an installed PWA answer the reload from its own
		// cache: the user pulls down, the page blinks, and nothing changes.
		expect(SOURCE).toContain("clearPwaCache()");
		expect(SOURCE).toContain("window.location.reload()");
		// The teardown must not be able to strand the user on a spinner.
		expect(SOURCE).toContain("CACHE_CLEAR_TIMEOUT_MS");
	});

	it("registers its touch listeners passively", () => {
		// The header does not scroll, so the gesture never calls preventDefault; a
		// non-passive listener here could stall scrolling elsewhere.
		expect(SOURCE).toContain("{ passive: true }");
		// Comments legitimately mention the API, so only CODE lines are checked.
		expect(codeLines(SOURCE).filter((line) => line.includes("preventDefault"))).toEqual([]);
	});

	it("keeps the indicator out of layout so it cannot shift the header", () => {
		expect(SOURCE).toContain('position: "absolute"');
		expect(SOURCE).toContain('pointerEvents: "none"');
	});

	it("ignores multi-touch and re-entrant pulls", () => {
		// A pinch is not a pull, and a reload is one-way: a second pull must not queue
		// another navigation while the teardown runs.
		expect(SOURCE).toContain("event.touches.length !== 1");
		expect(SOURCE).toContain("if (reloadingRef.current) return;");
	});
});
