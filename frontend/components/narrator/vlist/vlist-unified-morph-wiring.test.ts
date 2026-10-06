/**
 * Wiring guards for the unified morph path.
 *
 * Direct production-entry tests in `vlist-lod-morph-frame.test.ts` exercise admission,
 * origin/height arguments, interruption, reclamation and preference handover. The shell
 * still needs source guards for its persistent owners, React effects and DOM resolver.
 * Entry assertions below follow the extracted host; none execute source-text snippets.
 */

import { describe, expect, it } from "bun:test";
import { shellModule } from "./guard-source";
import { sliceBracketedRegion } from "./source-slice";

const SHELL = shellModule("PretextExactMessageList.tsx");
const COMMIT = shellModule("vlist-lod-morph-commit.ts");

/** The callable commit owns planning/playback; React lifecycle stays in the shell. */
function unifiedBranch(): string {
	const branch = sliceBracketedRegion(COMMIT, "if (playback.unified) {");
	if (!branch) throw new Error("Missing unified LOD commit branch");
	return branch;
}

describe("unified morph: one timing owner", () => {
	it("creates exactly one driver for the component's life", () => {
		// Two drivers would each advance the store by their own dt — the multi-owner bug that
		// `vlist-motion-scheduler.ts` was built to remove, reintroduced.
		const creations = SHELL.split("createMorphDriver(").length - 1;
		expect(creations).toBe(1);
	});

	it("guards the driver creation so a re-render cannot replace it", () => {
		expect(SHELL).toContain("if (!morphDriverRef.current)");
	});

	it("keeps ONE visual-state store, since it is the source of truth", () => {
		expect(SHELL.split("createVisualStateStore(").length - 1).toBe(1);
	});

	/**
	 * THE LOOP MUST BE STOPPED ON UNMOUNT.
	 *
	 * `tick()` returns false — and so ends the rAF chain — only once every element has
	 * SETTLED. An unmount mid-transition is therefore the one case the driver cannot end by
	 * itself, and it is the common one: switching narrator or closing the panel while
	 * anything is still converging. The orphaned loop then resolves identities against a
	 * viewport that no longer exists and writes nodes React has reclaimed.
	 *
	 * Silent in every other test: the driver's own suite drives `tick` directly and never
	 * mounts, and the component suites unmount from a settled state.
	 */
	it("stops the driver on unmount", () => {
		expect(SHELL).toContain("return () => driver?.stop();");
	});
});

describe("unified morph: interruption is structural", () => {
	/**
	 * The branch predicate must be `isMoving`, not "does the store know this element".
	 *
	 * A settled element is still retained, so keying on presence meant every switch after the
	 * FIRST applied no displacement and teleported — the "most rows don't animate" report.
	 */
	it("branches on isMoving, never on mere presence", () => {
		// Direct commit tests in frame.test exercise moving and settled entries.
		const branch = unifiedBranch();
		expect(branch).toContain("playback.visualState.isMoving(plan.unitId)");
		expect(branch).not.toContain(".get(plan.unitId)");
	});

	it("retargets a moving element and re-seeds a settled one", () => {
		const branch = unifiedBranch();
		// Moving → target only; settled → initial displacement on every switch.
		expect(branch).toContain("playback.visualState.setTarget(plan.unitId, plan.target)");
		expect(branch).toContain(
			"playback.visualState.startFrom(plan.unitId, initialStateFor(plan), plan.target)",
		);
	});

	it("plans TARGETS, never keyframes", () => {
		const branch = unifiedBranch();
		expect(branch).toContain("planner.planTargets(");
		expect(branch).not.toContain("Keyframes");
	});
});

describe("unified morph: reclamation", () => {
	it("retains the admitted set so unadmitted states can be swept", () => {
		// Without this the store grows for the life of the session: a level switch churns
		// elements constantly.
		expect(unifiedBranch()).toContain("playback.visualState.retain(ids)");
	});

	it("kicks the driver, which is idempotent per commit", () => {
		expect(unifiedBranch()).toContain("playback.driver?.kick()");
	});
});

describe("unified morph: isolation from the keyframe path", () => {
	it("derives unified admission independently from the shared document-space frames", () => {
		const branch = unifiedBranch();
		expect(branch).toContain("frames.before.geometry.unifiedElements");
		expect(branch).toContain("frames.after.geometry.unifiedElements");
		// frame.test checks the actual arguments: current height, independent origins.
		for (const field of [
			"frames.after.scrollTop",
			"frames.after.viewportHeight",
			"frames.before.scrollTop",
		])
			expect(branch).toContain(field);
		expect(branch).not.toContain("planner.buildSnapshots(");
		expect(branch).not.toContain("planner.diffSnapshots(");
		const keyframeStart = COMMIT.indexOf("const before = planner.buildSnapshots(");
		expect(keyframeStart).toBeGreaterThan(COMMIT.indexOf(branch));
		const keyframe = COMMIT.slice(
			keyframeStart,
			COMMIT.indexOf("const plans = planner.diffSnapshots(", keyframeStart),
		);
		// Keyframes retain each frame's own origin AND height (not unified admission's policy).
		for (const side of ["before", "after"]) {
			for (const field of ["geometry.elements", "scrollTop", "viewportHeight"])
				expect(keyframe).toContain(`frames.${side}.${field}`);
		}
		expect(keyframe).not.toContain("unifiedElements");
	});

	it("commits the baseline BEFORE the playback gate and admits only inside the unified branch", () => {
		const rollAt = COMMIT.indexOf("state.frames.current.commit(");
		const guardAt = COMMIT.indexOf("if (!frames || playback.prefersReducedMotion())");
		const branchAt = COMMIT.indexOf("if (playback.unified) {");
		expect(rollAt).toBeGreaterThan(0);
		expect(guardAt).toBeGreaterThan(rollAt);
		expect(branchAt).toBeGreaterThan(guardAt);
		expect(unifiedBranch()).toContain("planner.admit(");
	});

	it("takes both complete geometry arrays from the committed cache before descriptor publication", () => {
		const getAt = COMMIT.indexOf("const geometry = state.geometry.current.get(source)");
		const rollAt = COMMIT.indexOf("state.frames.current.commit(");
		expect(getAt).toBeGreaterThan(0);
		expect(rollAt).toBeGreaterThan(getAt);
		for (const source of [SHELL, COMMIT]) expect(source).not.toContain("toMorphElements(");
	});

	it("returns before the keyframe planner runs", () => {
		// Both paths must never plan the same switch: the two would fight over the same nodes.
		expect(unifiedBranch().trimEnd().endsWith("}")).toBe(true);
		expect(unifiedBranch()).toMatch(/return frames;\s*}$/);
	});

	it("is behind a default-OFF preference", () => {
		expect(SHELL).toContain('useLocalPref("narrafork_unified_morph")');
	});

	/**
	 * FLIPPING THE PREFERENCE MUST HAND THE NODES OVER CLEANLY.
	 *
	 * The commit refreshes `morphIdentitiesRef` only in its unified branch. Turn the flag
	 * off while a switch is converging and it keeps naming the last switch's identities
	 * while the loop keeps writing their `transform` — at the same time the keyframe
	 * planner starts animating those very nodes. Two owners of one property is the failure
	 * `vlist-motion-scheduler.ts` exists to make impossible. Direct commit tests now cover
	 * the reset and descriptor preservation; this guard pins the React preference trigger
	 * and the actual identity/driver refs passed to that tested entry.
	 */
	it("hands the identity/driver ports to reset playback when the preference flips", () => {
		const resetAt = SHELL.indexOf("resetLodMorphPlayback(");
		expect(resetAt).toBeGreaterThan(0);
		const effectAt = SHELL.lastIndexOf("useEffect(() => {", resetAt);
		expect(effectAt).toBeGreaterThan(0);
		const effect = sliceBracketedRegion(SHELL.slice(effectAt), "useEffect(");
		expect(effect).toContain("resetLodMorphPlayback(morphIdentitiesRef, morphDriverRef.current)");
		// Keyed on the flag, not just mount. Direct frame.test verifies reset preserves frames.
		expect(effect).toContain("[unifiedMorph]");
		const reset = sliceBracketedRegion(COMMIT, "export function resetLodMorphPlayback(");
		expect(reset).toContain("identities: Slot<Set<string>>");
		// Reset owns playback only: the frame baseline is not even an input.
		expect(reset).not.toContain("frames");
		const body = COMMIT.slice(COMMIT.indexOf("identities.current = new Set();"));
		expect(body).toContain("driver?.stop()");
	});

	it("still honours reduced motion", () => {
		// The guard sits above the branch, so it covers both paths.
		const effectStart = COMMIT.indexOf("const frames = state.frames.current.commit(");
		const branchStart = COMMIT.indexOf("if (playback.unified) {");
		expect(effectStart).toBeGreaterThan(0);
		expect(branchStart).toBeGreaterThan(effectStart);
		expect(COMMIT.slice(effectStart, branchStart)).toContain("playback.prefersReducedMotion()");
	});
});

/**
 * Retained closing cards must not survive a narrator switch.
 *
 * A closing row is released by `MotionOp.onDone`, which only fires for animations this
 * shell still owns. The shell is deliberately NOT remounted per narrator (there is no
 * `key={narratorId}`), so a switch does not run the unmount cleanup that would
 * `cancel()` the scheduler — a fold interrupted by the switch leaves its entry behind.
 * The result is a retained card key for a trace that no longer exists, kept for the rest
 * of the session and painted onto whatever row later reuses that key.
 */
describe("closing-row retention is narrator-scoped", () => {
	it("resets closingRows in the narrator-switch effect", () => {
		// Located by the effect's existing cache-clearing calls rather than by line number,
		// so reordering the effect's body does not break the guard.
		const anchor = SHELL.indexOf("reflectionTakeOverCacheRef.current.clear();");
		expect(anchor).toBeGreaterThan(0);
		const window = SHELL.slice(anchor, anchor + 700);
		expect(window).toContain("setClosingRows(");
		// Must be the same effect that is keyed on the narrator, not a nearby one.
		expect(window).toContain("}, [narratorId]);");
	});
});

describe("unified morph: DOM resolution", () => {
	it("resolves the card surface and tail beneath the element's own root", () => {
		// A document-wide query would find the FIRST card in the list, not this element's —
		// the same class of bug as the collapse-morph-wrong-row one.
		const resolveAt = SHELL.indexOf("resolve: (unitId) =>");
		expect(resolveAt).toBeGreaterThan(0);
		const window = SHELL.slice(resolveAt, resolveAt + 1600);
		expect(window).toContain("root.querySelector");
		expect(window).toContain("data-nf-card-surface");
		expect(window).toContain("data-nf-card-tail");
	});

	/**
	 * The row-key FALLBACK must be present.
	 *
	 * Elements paired on their `key` rather than a `unitId` paint `data-nf-row-key`, not
	 * `data-nf-unit`. Querying only the latter resolved them to null and they simply never
	 * animated — silent, because the plan exists and the state converges; only the DOM write
	 * is missing. The keyframe path has always had this fallback.
	 */
	it("falls back to data-nf-row-key, like the keyframe path", () => {
		const resolveAt = SHELL.indexOf("resolve: (unitId) =>");
		const window = SHELL.slice(resolveAt, resolveAt + 1600);
		expect(window).toContain("data-nf-unit");
		expect(window).toContain("data-nf-row-key");
	});

	it("kicks the driver so the seeded state is painted in the same commit", () => {
		// See the driver's own tests: scheduling alone paints one frame at the final position.
		expect(COMMIT).toContain("playback.driver?.kick()");
	});

	it("escapes the identity before putting it in a selector", () => {
		const resolveAt = SHELL.indexOf("resolve: (unitId) =>");
		expect(SHELL.slice(resolveAt, resolveAt + 900)).toContain("cssAttrEscape(unitId)");
	});
});
