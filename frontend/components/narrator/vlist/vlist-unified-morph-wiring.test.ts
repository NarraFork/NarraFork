/**
 * Wiring guards for the unified morph path.
 *
 * Read as source text, like the other `*-wiring` tests in this directory: the effects run
 * inside a component that needs a real layout to exercise, and the properties below are
 * structural (which reference is used, which order things happen in) rather than visual.
 *
 * These exist because the failures they guard are SILENT. A morph wired to the wrong
 * reference still produces plans, still animates something, and still passes every unit
 * test — the keyframe implementation did exactly that for several rounds while jumping
 * visibly on screen.
 */

import { describe, expect, it } from "bun:test";

const SHELL = await Bun.file(
	new URL("./PretextExactMessageList.tsx", import.meta.url).pathname,
).text();

/** The unified branch of the LOD morph effect. */
function unifiedBranch(): string {
	const start = SHELL.indexOf("if (unifiedMorph) {");
	expect(start).toBeGreaterThan(0);
	const end = SHELL.indexOf("const plans = diffLodSnapshots(", start);
	expect(end).toBeGreaterThan(start);
	return SHELL.slice(start, end);
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
		const branch = unifiedBranch();
		expect(branch).toContain("store.isMoving(plan.unitId)");
		expect(branch).not.toContain("if (!store.get(plan.unitId))");
	});

	it("retargets a moving element and re-seeds a settled one", () => {
		const branch = unifiedBranch();
		// Moving → target only, so the visual position is preserved.
		expect(branch).toContain("store.setTarget(plan.unitId, plan.target)");
		// Settled → startFrom, which is the only call that moves an existing element.
		expect(branch).toContain("store.startFrom(plan.unitId, initialStateFor(plan), plan.target)");
	});

	it("plans TARGETS, never keyframes", () => {
		const branch = unifiedBranch();
		expect(branch).toContain("planMorphTargets");
		expect(branch).not.toContain("Keyframes");
	});
});

describe("unified morph: reclamation", () => {
	it("retains the admitted set so unadmitted states can be swept", () => {
		// Without this the store grows for the life of the session: a level switch churns
		// elements constantly.
		expect(unifiedBranch()).toContain("store.retain(ids)");
	});

	it("kicks the driver, which is idempotent per commit", () => {
		expect(unifiedBranch()).toContain("morphDriverRef.current?.kick()");
	});
});

describe("unified morph: isolation from the keyframe path", () => {
	it("keeps its own previous-frame ref", () => {
		// Sharing `lodMorphPrevRef` would let a frame recorded by one path be diffed by the
		// other, whose admission rules differ — a silent mispairing, not an error.
		expect(SHELL).toContain("unifiedPrevRef");
	});

	/**
	 * THE BASELINE MUST ROLL FORWARD ON EVERY FRAME.
	 *
	 * Writing it inside the `unifiedMorph` branch put it AFTER the `isLodSwitch` guard, so it
	 * was unreachable on ordinary frames and only ever recorded a frame that was already
	 * mid-switch. Every switch then diffed against a stale, one-step-late snapshot and most
	 * elements failed to pair — a large number of rows silently lost their animation, which is
	 * the exact bug the rewrite exists to remove.
	 */
	it("admits and rolls the baseline BEFORE the isLodSwitch guard", () => {
		const rollAt = SHELL.indexOf("unifiedPrevRef.current = unifiedElements");
		const guardAt = SHELL.indexOf("if (!isLodSwitch || prefersReducedMotion()) return;");
		expect(rollAt).toBeGreaterThan(0);
		expect(guardAt).toBeGreaterThan(0);
		expect(rollAt).toBeLessThan(guardAt);
	});

	it("builds the baseline element list unconditionally, not lazily inside the branch", () => {
		const admitAt = SHELL.indexOf("const unifiedElements = toMorphElements(");
		const branchAt = SHELL.indexOf("if (unifiedMorph) {");
		expect(admitAt).toBeGreaterThan(0);
		expect(admitAt).toBeLessThan(branchAt);
	});

	it("returns before the keyframe planner runs", () => {
		// Both paths must never plan the same switch: the two would fight over the same nodes.
		expect(unifiedBranch().trimEnd().endsWith("}")).toBe(true);
		expect(unifiedBranch()).toContain("return;");
	});

	it("is behind a default-OFF preference", () => {
		expect(SHELL).toContain('useLocalPref("narrafork_unified_morph")');
	});

	/**
	 * FLIPPING THE PREFERENCE MUST HAND THE NODES OVER CLEANLY.
	 *
	 * `morphIdentitiesRef` is written ONLY inside the `unifiedMorph` branch. Turn the flag
	 * off while a switch is converging and it keeps naming the last switch's identities
	 * while the loop keeps writing their `transform` — at the same time the keyframe
	 * planner starts animating those very nodes. Two owners of one property is the failure
	 * `vlist-motion-scheduler.ts` exists to make impossible, and here it would be reached
	 * by a settings toggle rather than by any code path a test walks.
	 *
	 * Silent in every other suite: the driver's own tests never mount, and no component
	 * test toggles the preference mid-animation.
	 */
	it("clears the identity set and stops the driver when the preference flips", () => {
		const effectAt = SHELL.indexOf("morphIdentitiesRef.current = new Set();");
		expect(effectAt).toBeGreaterThan(0);
		const window = SHELL.slice(effectAt, effectAt + 200);
		expect(window).toContain("morphDriverRef.current?.stop()");
		// Keyed on the flag itself: an effect with `[]` would only run on mount and a
		// mid-session flip would go unnoticed, which is the whole case.
		expect(window).toContain("}, [unifiedMorph]);");
	});

	it("still honours reduced motion", () => {
		// The guard sits above the branch, so it covers both paths.
		const effectStart = SHELL.indexOf("const isLodSwitch =");
		const branchStart = SHELL.indexOf("if (unifiedMorph) {");
		const between = SHELL.slice(effectStart, branchStart);
		expect(between).toContain("prefersReducedMotion()");
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
		expect(SHELL).toContain("morphDriverRef.current?.kick()");
	});

	it("escapes the identity before putting it in a selector", () => {
		const resolveAt = SHELL.indexOf("resolve: (unitId) =>");
		expect(SHELL.slice(resolveAt, resolveAt + 900)).toContain("cssAttrEscape(unitId)");
	});
});
