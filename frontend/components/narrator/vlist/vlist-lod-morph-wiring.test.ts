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
import { shellSource } from "./guard-source";

const DIR = import.meta.dir;
/**
 * The shell's whole module set: the negative rules below forbid a per-feature morph
 * controller ANYWHERE in the shell, and a rule scoped to one file stops guarding as
 * soon as the thing it forbids can live next door.
 */
const SHELL = shellSource();

/**
 * The body of the shell's LOD-morph layout effect.
 *
 * Anchored at the effect's own opening rather than at `buildLodSnapshots(`: the
 * snapshot SOURCE is assembled in a loop above that call, so a slice starting there
 * cannot see what the snapshot is actually fed — which is half of what this file
 * guards.
 */
function morphEffect(): string {
	const buildIdx = SHELL.indexOf("buildLodSnapshots(");
	expect(buildIdx).toBeGreaterThan(0);
	const start = SHELL.lastIndexOf("useLayoutEffect(() => {", buildIdx);
	expect(start).toBeGreaterThan(0);
	// Ends at the push of this effect's ops into the shared motion scheduler, which
	// replaced the per-feature controller (see vlist-motion-scheduler.ts).
	const end = SHELL.indexOf("lodScope(", buildIdx);
	expect(end).toBeGreaterThan(buildIdx);
	return SHELL.slice(start, SHELL.indexOf("\t});", end));
}

describe("LOD morph: diff-driven, keyed by unitId ?? key", () => {
	it("builds snapshots and diffs them (no toggle-time capture)", () => {
		expect(SHELL).toContain("buildLodSnapshots(");
		expect(SHELL).toContain("diffLodSnapshots(");
		// Played through the shared scheduler, under this feature's own cancel scope.
		expect(SHELL).toContain("lodScope(");
	});

	/**
	 * The planner pairs on `unitId ?? key` and reads `kind` to decide whether to fade.
	 * Feeding it only `unitId` (the original shape) silently narrows the morph back to
	 * tool cards: the document body — markdown, bubbles, system cards — carries no
	 * `unitId`, so it would be dropped from every snapshot and teleport again.
	 */
	it("feeds the snapshot spec.key and spec.kind alongside spec.unitId", () => {
		const effect = morphEffect();
		expect(effect).toContain("unitId: item.spec.unitId");
		expect(effect).toContain("key: item.spec.key");
		expect(effect).toContain("kind: item.spec.kind");
	});

	/**
	 * Two attributes, because the two pairing identities are painted on different ones:
	 * a re-themed tool call carries `data-nf-unit`, while an element paired on its `key`
	 * only ever carries `data-nf-row-key`. Without the fallback every key-paired plan
	 * resolves to null — and nothing looks broken, because the plans are still produced.
	 */
	it("resolves a morph by data-nf-unit, falling back to data-nf-row-key", () => {
		const effect = morphEffect();
		expect(effect).toContain("data-nf-unit");
		expect(effect).toContain("data-nf-row-key");
	});
});

/**
 * The L2/L3 boundary is the switch that changes the most — a tool call is a folded ROW
 * at L1/L2 and a full CARD at L3+ — and it is the one that fails SILENTLY: drop the
 * nested rows from the snapshot and the two frames simply have an empty intersection,
 * so no plan is produced, no error is raised, and the boundary stops animating while
 * every other level pair still works.
 */
describe("LOD morph: the L2/L3 boundary is snapshotted", () => {
	it("walks each trace's measured rows into the snapshot source", () => {
		const effect = morphEffect();
		// Reached through the measured payload, keyed by the item's spec key.
		expect(effect).toContain("measuredByKeyRef.current.get(item.spec.key)");
		expect(effect).toContain("measured?.rows");
		expect(effect).toContain("nested: true");
	});

	it("lifts a row's geometry into document space", () => {
		// A row's `top` is relative to its trace element; pairing it against a top-level
		// card requires the same coordinate space as the layout's own offsets.
		expect(morphEffect()).toContain("geo.top + row.top");
	});

	/**
	 * Without the clip the planner cannot tell the two directions apart, and the L3 → L2
	 * one animates a row from far outside its trace's box — invisible for the duration,
	 * i.e. a blink rather than a morph.
	 */
	it("passes the clipping box so the planner can drop unslidable travel", () => {
		const effect = morphEffect();
		expect(effect).toContain("bottom: geo.top + geo.height");
		expect(effect).toContain("clip,");
	});

	/**
	 * A drilled-in row's block is a whole card tall; the thing the reader perceives as
	 * moving is the summary LINE. Snapshotting `blockHeight` would make the clip test
	 * (and the pairing geometry) describe a box the eye never tracks.
	 */
	it("snapshots the row's title line height, not its whole block", () => {
		const effect = morphEffect();
		expect(effect).toContain("height: row.rowHeight");
		expect(effect).not.toContain("height: row.blockHeight");
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
		expect(morphEffect()).toContain("prefersReducedMotion()");
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

describe("LOD morph: own planner, shared scheduler", () => {
	it("plans in its own layout effect, invoking neither the fold nor the drill planner", () => {
		expect(morphEffect()).not.toContain("planFoldMotion");
		expect(morphEffect()).not.toContain("diffDrillSnapshots");
	});

	it("plays through the shared scheduler under its own scope", () => {
		expect(SHELL).toContain("motionRef.current.push(");
		expect(SHELL).toContain("lodScope(");
		expect(SHELL).not.toContain("createLodMorphController");
		expect(SHELL).not.toContain("lodMorphRef");
	});

	/**
	 * The LOD switch is the ONE legitimate deviation from the shared time base: it
	 * re-themes the whole document at once, so the eye needs longer than a single card's
	 * fold. It is applied as an EVENT-level override so every element of one switch
	 * shares it — a per-op duration would let paired elements finish at different times.
	 */
	it("carries the longer LOD duration as an event-level override", () => {
		expect(morphEffect()).toContain("LOD_MOTION_DURATION_MS");
	});
});

/**
 * The LOD switch reuses the drill morph's two fades for a RE-THEME.
 *
 * A re-theme is the same `trace-row ↔ tool-call` pair, so the tail cluster (whose travel
 * distance is unknowable without measuring rendered text) and the border (which exists in
 * only one of the two forms) need the same treatment there as in a drill.
 */
describe("LOD re-theme: tail + border fades", () => {
	it("resumes an interrupted switch instead of restarting it", () => {
		// Holding a zoom shortcut re-triggers the switch mid-flight; with `fill: "none"` a
		// plain keyframe array would restart from the committed geometry.
		expect(morphEffect()).toContain("lodMorphKeyframesFrom");
	});

	it("fades the tail and the border, on their own scopes", () => {
		const effect = morphEffect();
		expect(effect).toContain("drillTailKeyframesFrom");
		expect(effect).toContain("drillBorderKeyframesFrom");
		expect(effect).toContain(":tail`");
		expect(effect).toContain(":border`");
	});

	it("only fades those for a RE-THEME, never for an element that merely moved", () => {
		// Fading unchanged chrome would make it blink once per zoom step.
		expect(morphEffect()).toContain("if (!plan.fade) return []");
	});

	it("derives the fade direction from toKind, not from `fade` alone", () => {
		// `fade` is true in BOTH directions, so using it to pick the direction would fade the
		// border in while collapsing to a row.
		expect(morphEffect()).toContain('plan.toKind === "tool-call"');
	});
});
