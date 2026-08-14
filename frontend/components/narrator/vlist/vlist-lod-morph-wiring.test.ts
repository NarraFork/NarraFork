/**
 * vlist-lod-morph-wiring.test.ts — Source-level guard for the LOD-switch morph's
 * shell wiring.
 *
 * The pure planner (`vlist-lod-morph`) and the WAAPI edge (`vlist-lod-morph-motion`)
 * are unit-tested on their own. What neither can see is WHERE they are wired into
 * the shell — and that is where this feature's failure modes live:
 *
 *  - morphing on a NON-LOD rebuild (a live patch / page would animate a change the
 *    reader did not make);
 *  - forgetting to roll the snapshot forward when skipping, corrupting the next
 *    diff's baseline;
 *  - reading `getBoundingClientRect` against the wrong coordinate frame (the
 *    "completely wrong position" class of bug);
 *  - re-homing a detached ghost of the old (unmounted) element — there is none, the
 *    morph only ever animates the committed NEW node.
 *
 * These are source assertions because the failures are silent: the morph still
 * runs, just at the wrong time or on the wrong node.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
const SHELL = readFileSync(join(DIR, "PretextExactMessageList.tsx"), "utf8");

/** The body of the shell's LOD-morph layout effect. */
function morphEffect(): string {
	const buildIdx = SHELL.indexOf("buildLodSnapshots(");
	expect(buildIdx).toBeGreaterThan(0);
	const end = SHELL.indexOf("lodMorphRef.current.playAll(", buildIdx);
	expect(end).toBeGreaterThan(buildIdx);
	return SHELL.slice(buildIdx, SHELL.indexOf("\t});", end));
}

describe("LOD morph: diff-driven, keyed by unitId", () => {
	it("builds snapshots and diffs them (no toggle-time capture)", () => {
		expect(SHELL).toContain("buildLodSnapshots(");
		expect(SHELL).toContain("diffLodSnapshots(");
		expect(SHELL).toContain("lodMorphRef.current.playAll(");
	});

	it("resolves each morph to its node by data-nf-unit", () => {
		expect(morphEffect()).toContain("data-nf-unit");
	});
});

describe("LOD morph: the LOD-switch gate", () => {
	it("requires an unchanged document revision AND a moved lod", () => {
		const effect = morphEffect();
		expect(effect).toContain("isLodSwitch");
		// Same document revision as the previous frame…
		expect(effect).toContain("lodMorphDocRevRef.current === docRev");
		// …and a DIFFERENT lod.
		expect(effect).toContain("lodMorphLodRef.current !== lod");
	});

	it("rolls the snapshot + lod + revision forward even when it skips playing", () => {
		const effect = morphEffect();
		// The roll-forward assignments must precede the reduced-motion / non-LOD early
		// return, or the next diff compares against a stale baseline.
		const rollIdx = effect.indexOf("lodMorphPrevRef.current = next");
		const gateIdx = effect.indexOf("if (!isLodSwitch");
		expect(rollIdx).toBeGreaterThan(0);
		expect(gateIdx).toBeGreaterThan(rollIdx);
	});

	it("honours prefers-reduced-motion (skips playing, still rolls the snapshot)", () => {
		expect(morphEffect()).toContain("prefersReducedMotionLod()");
	});
});

describe("LOD morph: no DOM measurement, no detached ghost", () => {
	it("never reads getBoundingClientRect in the morph path", () => {
		expect(morphEffect()).not.toContain("getBoundingClientRect");
	});

	it("never re-homes or removes a node (the morph animates only the committed new node)", () => {
		const effect = morphEffect();
		expect(effect).not.toContain("appendChild");
		expect(effect).not.toContain(".remove(");
		expect(effect).not.toContain("position:fixed");
	});
});

describe("LOD morph: orthogonality with fold + drill morph", () => {
	it("runs in its own layout effect with its own controller", () => {
		expect(SHELL).toContain("lodMorphRef.current.playAll(");
		// Separate controllers for the three channels.
		expect(SHELL).toContain("createLodMorphController(");
		// The LOD morph effect must not invoke the fold or drill planners.
		expect(morphEffect()).not.toContain("planFoldMotion");
		expect(morphEffect()).not.toContain("diffDrillSnapshots");
	});
});
