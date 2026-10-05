/**
 * vlist-lod-morph-wiring.test.ts — Source-level guard for the LOD-switch morph's
 * shell wiring.
 *
 * `vlist-lod-morph-frame.test.ts` and `vlist-lod-morph-geometry.test.ts` call the
 * production commit entry directly; they do not mount the React shell. These guards
 * pin that shell's input/ref forwarding and the entry's production planner/player edges:
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
import { shellModule, shellSource } from "./guard-source";
import { sliceBracketedRegion } from "./source-slice";

const ENTRY = shellModule("PretextExactMessageList.tsx");
const COMMIT = shellModule("vlist-lod-morph-commit.ts");
const GEOMETRY = shellModule("vlist-lod-morph-geometry.ts");
const FRAME = shellModule("vlist-lod-morph-frame.ts");
/**
 * The shell's whole module set: the negative rules below forbid a per-feature morph
 * controller ANYWHERE in the shell, and a rule scoped to one file stops guarding as
 * soon as the thing it forbids can live next door.
 */
const SHELL = shellSource();

/** Only the React scheduling/input boundary remains in the shell. */
function morphEffect(): string {
	const callAt = ENTRY.indexOf("commitLodMorph(");
	expect(callAt).toBeGreaterThan(0);
	const start = ENTRY.lastIndexOf("useLayoutEffect(() => {", callAt);
	expect(start).toBeGreaterThan(0);
	const effect = sliceBracketedRegion(ENTRY.slice(start), "useLayoutEffect(() => {");
	if (!effect) throw new Error("Missing committed LOD morph layout effect");
	expect(effect).toContain("commitLodMorph(");
	return effect;
}

describe("LOD morph: diff-driven, keyed by unitId ?? key", () => {
	it("defaults the production entry to the real planners (no toggle-time capture)", () => {
		// Direct commit tests inject observing ports; production must select the same planners.
		for (const field of [
			"buildSnapshots: buildLodSnapshots",
			"diffSnapshots: diffLodSnapshots",
			"admit: admitPair",
			"planTargets: planMorphTargets",
			"planner: LodMorphCommitAlgorithms = algorithms",
		])
			expect(COMMIT).toContain(field);
	});

	/** Key/kind/unitId and nested geometry have direct helper/commit behavior tests. */
	it("forwards committed geometry and the persistent state/playback ports from a layout effect", () => {
		const effect = morphEffect();
		expect(effect).toContain("const node = viewportRef.current");
		expect(effect).toContain("const layout = exactLayoutRef.current");
		expect(effect).toContain("if (!node || !layout) return;");
		const call = sliceBracketedRegion(effect, "commitLodMorph(");
		expect(call).not.toBeNull();
		for (const field of [
			"narratorId,",
			"items: renderItemsRef.current",
			"layout,",
			"index: pretextDocument.index",
			"scrollTop: readMorphScrollTop()",
			"viewportHeight: viewportHeightRef.current",
			"documentRevision: foldRevisionOf(foldDocumentRevision)",
			"lod: pretextDocument.manifest?.lod ?? -1",
			"geometry: lodMorphGeometryRef",
			"frames: lodMorphFramesRef",
			"viewport: node",
			"unified: unifiedMorph",
			"prefersReducedMotion,",
			"visualState: visualStateRef.current",
			"identities: morphIdentitiesRef",
			"driver: morphDriverRef.current",
			"motion: motionRef.current",
		])
			expect(call).toContain(field);
	});

	/**
	 * Two attributes, because the two pairing identities are painted on different ones:
	 * a re-themed tool call carries `data-nf-unit`, while an element paired on its `key`
	 * only ever carries `data-nf-row-key`. Without the fallback every key-paired plan
	 * resolves to null — and nothing looks broken, because the plans are still produced.
	 */
	it("resolves a morph by data-nf-unit, falling back to data-nf-row-key", () => {
		expect(COMMIT).toContain("data-nf-unit");
		expect(COMMIT).toContain("data-nf-row-key");
	});
});

/**
 * Geometry assertions moved to vlist-lod-morph-geometry.test.ts as actual helper/planner
 * behavior: key-bound measured rows, document offsets, title (not block) heights, clips
 * and group admission. Only commit ownership/order remains a source-level contract here.
 */

describe("LOD morph: the LOD-switch gate", () => {
	// Gate behavior (owner/revision/moved level/initial -1) is executed in frame.test.
	// This guard protects the shell-to-helper input contract, not a copied predicate.
	it("publishes the supplied owner, revision, level, geometry and viewport descriptor", () => {
		const commit = sliceBracketedRegion(COMMIT, "state.frames.current.commit({");
		expect(commit).not.toBeNull();
		for (const field of [
			"narratorId: source.narratorId",
			"geometry,",
			"scrollTop: source.scrollTop",
			"viewportHeight: source.viewportHeight",
			"documentRevision: source.documentRevision",
			"lod: source.lod",
		])
			expect(commit).toContain(field);
	});

	it("reads geometry and rolls the descriptor before gating either planner", () => {
		// frame.test drives ordinary/reduced-motion commits and verifies zero planner calls.
		const getAt = COMMIT.indexOf("state.geometry.current.get(source)");
		const rollAt = COMMIT.indexOf("state.frames.current.commit(");
		const gateAt = COMMIT.indexOf("if (!frames || playback.prefersReducedMotion())");
		expect(getAt).toBeGreaterThan(0);
		expect(rollAt).toBeGreaterThan(getAt);
		expect(gateAt).toBeGreaterThan(rollAt);
		for (const planner of ["planner.admit(", "planner.buildSnapshots("])
			expect(COMMIT.indexOf(planner)).toBeGreaterThan(gateAt);
	});
});

describe("LOD morph: no DOM measurement, no detached ghost", () => {
	it("never reads getBoundingClientRect in the morph path", () => {
		expect(`${morphEffect()}\n${COMMIT}\n${GEOMETRY}\n${FRAME}`).not.toContain(
			"getBoundingClientRect",
		);
	});

	it("never re-homes or removes a node (the morph animates only the committed new node)", () => {
		const effect = `${morphEffect()}\n${COMMIT}\n${GEOMETRY}\n${FRAME}`;
		expect(effect).not.toContain("appendChild");
		expect(effect).not.toContain(".remove(");
		expect(effect).not.toContain("position:fixed");
	});
});

describe("LOD morph: own planner, shared scheduler", () => {
	it("delegates from its own layout effect without invoking fold or drill planners", () => {
		for (const source of [morphEffect(), COMMIT]) {
			expect(source).not.toContain("planFoldMotion");
			expect(source).not.toContain("diffDrillSnapshots");
		}
	});

	it("plays through the shared scheduler under its own scope", () => {
		expect(COMMIT).toContain("playback.motion.push(");
		expect(COMMIT).toContain("lodScope(");
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
		expect(COMMIT).toContain("LOD_MOTION_DURATION_MS");
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
		expect(COMMIT).toContain("lodMorphKeyframesFrom");
	});

	it("fades the tail and the border, on their own scopes", () => {
		expect(COMMIT).toContain("drillTailKeyframesFrom");
		expect(COMMIT).toContain("drillBorderKeyframesFrom");
		expect(COMMIT).toContain(":tail`");
		expect(COMMIT).toContain(":border`");
	});

	it("only fades those for a RE-THEME, never for an element that merely moved", () => {
		// Fading unchanged chrome would make it blink once per zoom step.
		expect(COMMIT).toContain("if (!plan.fade) return []");
	});

	it("derives the fade direction from toKind, not from `fade` alone", () => {
		// `fade` is true in BOTH directions, so using it to pick the direction would fade the
		// border in while collapsing to a row.
		expect(COMMIT).toContain('plan.toKind === "tool-call"');
	});
});
