/**
 * vlist-drill-morph-wiring.test.ts — Source-level guard for the drill-down header
 * morph's shell wiring.
 *
 * The pure planner (`vlist-drill-morph`) and the WAAPI edge
 * (`vlist-drill-morph-motion`) are covered by their own unit tests. What neither can
 * see is WHERE the two halves are wired into the shell, and that is where every
 * failure mode of this feature has lived:
 *
 *  - a single-slot capture that one toggle overwrites with the next (drops stacked
 *    activity);
 *  - a `getBoundingClientRect` read against the wrong coordinate frame (the
 *    "completely wrong position" bug);
 *  - a detached ghost node re-homed with `position:fixed` that outlived its
 *    animation and covered the rows above (the "rows vanished" bug);
 *  - a trace-level querySelector returning the FIRST row's line instead of the
 *    toggled one (the "animation applied to the row above" bug).
 *
 * These are assertions on the shell source because those failures are silent: the
 * morph still runs, just on the wrong node or at the wrong offset, and no unit test
 * on the pure functions would notice.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
const SHELL = readFileSync(join(DIR, "PretextExactMessageList.tsx"), "utf8");

/** The body of the shell's drill-morph layout effect. */
function morphEffect(): string {
	const start = SHELL.indexOf("drillMorphPrevRef.current;");
	// Find the useLayoutEffect that contains the snapshot build.
	const buildIdx = SHELL.indexOf("buildDrillSnapshots(");
	expect(buildIdx).toBeGreaterThan(0);
	const end = SHELL.indexOf("drillMorphRef.current.playAll(", buildIdx);
	expect(end).toBeGreaterThan(buildIdx);
	return SHELL.slice(buildIdx, SHELL.indexOf("\t});", end));
}

describe("drill morph: diff-driven, not a click capture", () => {
	it("drives morphs off buildDrillSnapshots + diffDrillSnapshots, not a toggle-time capture", () => {
		// The whole point of the redo: the morph is derived from a before/after row
		// diff, so stacked activity (many rows flipping in one frame) is native.
		expect(SHELL).toContain("buildDrillSnapshots(");
		expect(SHELL).toContain("diffDrillSnapshots(");
		expect(SHELL).toContain("drillMorphRef.current.playAll(");
	});

	it("has NO single-slot morph capture ref (the overwrite bug)", () => {
		expect(SHELL).not.toContain("headerMorphCaptureRef");
		expect(SHELL).not.toContain("planHeaderMorph(");
	});

	it("does NOT capture anything inside onToggleRow (state flip only)", () => {
		const start = SHELL.indexOf("onToggleRow: (rowIndex: number, rowKey?: string)");
		expect(start).toBeGreaterThan(0);
		const end = SHELL.indexOf("onToggleTranslation", start);
		const block = SHELL.slice(start, end);
		expect(block).not.toContain("Capture");
		expect(block).not.toContain("drillHeader");
	});
});

describe("drill morph: no DOM measurement, no detached ghost", () => {
	it("never reads getBoundingClientRect anywhere in the morph path", () => {
		expect(morphEffect()).not.toContain("getBoundingClientRect");
	});

	it("never re-homes a node (no appendChild onto the viewport, no position:fixed ghost)", () => {
		const effect = morphEffect();
		expect(effect).not.toContain("appendChild");
		expect(effect).not.toContain('position = "fixed"');
		expect(effect).not.toContain("position:fixed");
	});

	it("never removes a node (nothing detached to clean up)", () => {
		expect(morphEffect()).not.toContain(".remove(");
	});
});

describe("drill morph: per-row targeting (the row-above bug)", () => {
	it("resolves the incoming node INSIDE the toggled row via data-nf-trace-row", () => {
		const effect = morphEffect();
		// A trace-level query returns the first row's line; the resolver MUST narrow to
		// the toggled row first, then to its header / title line.
		expect(effect).toContain("data-nf-row-key");
		expect(effect).toContain("data-nf-trace-row");
		expect(effect).toContain("data-nf-card-header");
		expect(effect).toContain("data-nf-trace-titlerow");
	});

	it("splits rowUid into traceKey + rowKey for the two-level lookup", () => {
		expect(morphEffect()).toContain('indexOf("::")');
	});
});

describe("drill morph: revision gate + snapshot roll", () => {
	it("only morphs across an unchanged document revision", () => {
		expect(morphEffect()).toContain("revisionUnchanged");
	});

	it("rolls the snapshot forward even when it skips playing (clean next baseline)", () => {
		const effect = morphEffect();
		// The snapshot assignment must happen BEFORE the revision/reduced-motion early
		// return, or the next diff compares against a stale baseline.
		const assign = effect.indexOf("drillMorphPrevRef.current = next");
		const earlyReturn = effect.indexOf("if (!revisionUnchanged");
		expect(assign).toBeGreaterThan(0);
		expect(earlyReturn).toBeGreaterThan(assign);
	});

	it("honours prefers-reduced-motion (skips playing, still rolls the snapshot)", () => {
		expect(morphEffect()).toContain("prefersReducedMotionDrill()");
	});
});

describe("drill morph: orthogonality with the fold reveal", () => {
	it("morph and fold run in SEPARATE layout effects (different nodes, no shared planner)", () => {
		// fold plays through foldMotionRef + planFoldMotion on [data-nf-row-key];
		// morph plays through drillMorphRef + diffDrillSnapshots on a row's inner node.
		expect(SHELL).toContain("foldMotionRef.current.play(");
		expect(SHELL).toContain("drillMorphRef.current.playAll(");
		// The morph effect must not touch the fold's clip-path reveal planner.
		expect(morphEffect()).not.toContain("planFoldMotion");
		expect(morphEffect()).not.toContain("clipPath");
	});
});
