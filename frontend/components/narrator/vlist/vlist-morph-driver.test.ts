/**
 * Tests for the single-loop morph driver.
 *
 * The property that matters most is the one `vlist-motion-scheduler.ts` was built to
 * guarantee and this driver must not lose: every element advances in the SAME frame by the
 * SAME dt, so one visual event cannot come apart into halves that finish at different times.
 * Here that is structural rather than enforced, and these tests pin it as such.
 */

import { describe, expect, it } from "bun:test";
import {
	createMorphDriver,
	MORPH_MAX_FRAME_MS,
	type MorphNode,
	resolveBorderColor,
	resolveTransform,
} from "./vlist-morph-driver";
import { createVisualStateStore, restingTarget, type VisualTarget } from "./vlist-visual-state";

function node(): MorphNode {
	return {
		style: {
			transform: "",
			opacity: "",
			borderColor: "",
			willChange: "",
			clipPath: "",
			top: "",
			height: "",
		},
	};
}

const at = (y: number, extra: Partial<VisualTarget> = {}): VisualTarget => ({
	x: 0,
	y,
	opacity: 1,
	cardness: 1,
	...extra,
});

/** A driver over `ids`, with a manual clock and rAF so frames are explicit. */
function harness(ids: string[]) {
	const store = createVisualStateStore();
	const roots = new Map(ids.map((id) => [id, node()]));
	const surfaces = new Map(ids.map((id) => [id, node()]));
	const tails = new Map(ids.map((id) => [id, node()]));
	let scheduled: ((now: number) => void) | null = null;
	let clock = 0;
	const driver = createMorphDriver({
		store,
		identities: () => ids,
		resolve: (id) => ({ root: roots.get(id), surface: surfaces.get(id), tail: tails.get(id) }),
		raf: (cb) => {
			scheduled = cb;
			return 1;
		},
		cancelRaf: () => {
			scheduled = null;
		},
		now: () => clock,
		isReducedMotion: () => false,
	});
	return {
		store,
		driver,
		roots,
		surfaces,
		tails,
		/** Run one scheduled frame, advancing the clock by `dt`. */
		frame(dt: number) {
			clock += dt;
			const cb = scheduled;
			scheduled = null;
			cb?.(clock);
		},
		hasScheduled: () => scheduled !== null,
	};
}

// ── Value mapping ─────────────────────────────────────────────────────────────
describe("resolveTransform", () => {
	it("writes nothing at rest, so a settled element is described by its own CSS", () => {
		expect(resolveTransform({ x: 0, y: 0, opacity: 1, cardness: 1 })).toBe("");
	});

	it("writes both axes together", () => {
		expect(resolveTransform({ x: 7, y: -11.5, opacity: 1, cardness: 1 })).toBe(
			"translate(7px, -11.5px)",
		);
	});
});

describe("resolveBorderColor", () => {
	it("clears the inline value at full cardness, leaving the committed colour", () => {
		expect(resolveBorderColor(1)).toBe("");
	});

	it("is fully transparent at zero", () => {
		expect(resolveBorderColor(0)).toBe("transparent");
	});

	it("mixes against the RENDERER's variable, not currentColor", () => {
		// `currentColor` is the element's TEXT colour, which on a card is nothing like its
		// border colour — mixing against it fades the border through the wrong hue. The
		// variable keeps the committed colour owned by the render layer, which matters because
		// some cards override the border to a status colour.
		const mid = resolveBorderColor(0.5);
		expect(mid).toContain("--nf-card-border");
		expect(mid).not.toContain("currentColor");
		expect(mid).toContain("50%");
	});

	it("falls back to the theme border when the variable is absent", () => {
		expect(resolveBorderColor(0.5)).toContain("--mantine-color-default-border");
	});
});

// ── One loop, one dt ──────────────────────────────────────────────────────────
describe("a single loop advances every element together", () => {
	it("writes all identities in the same frame", () => {
		const h = harness(["a", "b", "c"]);
		for (const id of ["a", "b", "c"]) {
			h.store.setTarget(id, at(0));
			h.store.setTarget(id, at(-100));
		}
		h.driver.tick(16);
		// Every element moved, and by the same amount — they cannot desynchronise because
		// there is no per-element timeline to desynchronise.
		const transforms = ["a", "b", "c"].map((id) => h.roots.get(id)?.style.transform);
		expect(new Set(transforms).size).toBe(1);
		expect(transforms[0]).toContain("translate(");
	});

	it("cannot let one element finish before another", () => {
		const h = harness(["a", "b"]);
		h.store.setTarget("a", at(0));
		h.store.setTarget("a", at(-100));
		h.store.setTarget("b", at(0));
		h.store.setTarget("b", at(-100));
		let frames = 0;
		while (h.driver.tick(16) && frames++ < 500) {
			// Identical states at every single frame.
			expect(h.store.get("a")?.y).toBe(h.store.get("b")?.y);
		}
		expect(frames).toBeGreaterThan(1);
	});
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────
describe("lifecycle", () => {
	it("stops scheduling once everything has settled", () => {
		const h = harness(["a"]);
		h.store.setTarget("a", at(0));
		h.store.setTarget("a", at(-50));
		h.driver.kick();
		expect(h.driver.isRunning()).toBe(true);
		let guard = 0;
		while (h.hasScheduled() && guard++ < 500) h.frame(16);
		expect(h.driver.isRunning()).toBe(false);
		expect(guard).toBeLessThan(500);
	});

	it("clears every inline style it wrote when it settles", () => {
		// The same guarantee `fill: "none"` gave the keyframe version: nothing left applied,
		// so no cleanup can be missed later.
		const h = harness(["a"]);
		h.store.setTarget("a", at(0));
		h.store.setTarget("a", at(-50, { opacity: 0.2, cardness: 0 }));
		h.driver.kick();
		let guard = 0;
		while (h.hasScheduled() && guard++ < 500) h.frame(16);
		const root = h.roots.get("a") as MorphNode;
		expect(root.style.transform).toBe("");
		expect(root.style.opacity).toBe("");
		expect(root.style.willChange).toBe("");
		expect(h.surfaces.get("a")?.style.borderColor).toBe("");
		expect(h.tails.get("a")?.style.opacity).toBe("");
	});

	it("is idempotent: kicking every commit never starts a second loop", () => {
		const h = harness(["a"]);
		h.store.setTarget("a", at(0));
		h.store.setTarget("a", at(-50));
		h.driver.kick();
		h.driver.kick();
		h.driver.kick();
		// One scheduled frame, not three — three loops would each advance the store by their
		// own dt, which is exactly the multi-owner bug.
		expect(h.driver.isRunning()).toBe(true);
		h.frame(16);
		expect(h.store.get("a")?.y).toBeGreaterThan(-50);
	});

	it("stop() clears styles even mid-flight", () => {
		const h = harness(["a"]);
		h.store.setTarget("a", at(0));
		h.store.setTarget("a", at(-100, { cardness: 0 }));
		h.driver.tick(16);
		expect(h.roots.get("a")?.style.transform).not.toBe("");
		h.driver.stop();
		expect(h.roots.get("a")?.style.transform).toBe("");
		expect(h.driver.isRunning()).toBe(false);
	});

	it("does not run at all under reduced motion", () => {
		// The committed geometry is then what the reader sees, which is correct degradation.
		const store = createVisualStateStore();
		const root = node();
		let scheduled = false;
		const driver = createMorphDriver({
			store,
			identities: () => ["a"],
			resolve: () => ({ root }),
			raf: () => {
				scheduled = true;
				return 1;
			},
			cancelRaf: () => {},
			now: () => 0,
			isReducedMotion: () => true,
		});
		store.setTarget("a", at(0));
		store.setTarget("a", at(-100));
		driver.kick();
		expect(scheduled).toBe(false);
		expect(driver.isRunning()).toBe(false);
	});
});

// ── Robustness ────────────────────────────────────────────────────────────────
describe("robustness", () => {
	it("clamps a huge frame instead of teleporting", () => {
		// A backgrounded tab hands back a multi-second dt; integrating it would jump every
		// element to its target, which is the opposite of a transition.
		const h = harness(["a"]);
		h.store.setTarget("a", at(0));
		h.store.setTarget("a", at(-10_000));
		h.driver.kick();
		h.frame(5_000);
		// Advanced by at most the clamp, so it is still visibly travelling.
		expect(h.store.get("a")?.y).toBeGreaterThan(-10_000);
		expect(MORPH_MAX_FRAME_MS).toBeLessThan(100);
	});

	it("survives an identity whose nodes are not mounted", () => {
		// A level switch unmounts elements constantly; a missing node must be skipped, not
		// throw and take the whole frame down with it.
		const store = createVisualStateStore();
		const driver = createMorphDriver({
			store,
			identities: () => ["ghost", "real"],
			resolve: (id) => (id === "real" ? { root: node() } : null),
			raf: () => 1,
			cancelRaf: () => {},
			now: () => 0,
			isReducedMotion: () => false,
		});
		store.setTarget("real", at(0));
		store.setTarget("real", at(-10));
		expect(() => driver.tick(16)).not.toThrow();
	});

	it("only marks will-change while actually transformed", () => {
		// Leaving it on keeps a composited layer alive for every row in the document.
		const h = harness(["a"]);
		h.store.setTarget("a", restingTarget(1));
		h.driver.tick(16);
		expect(h.roots.get("a")?.style.willChange).toBe("");
	});
});

// ── Fold's channels ───────────────────────────────────────────────────────────
/**
 * Fold needs three channels beyond a morph's offset: a `clip-path` inset (it expands by
 * UN-CLIPPING a box already at its final height, rather than growing it) and `top`/`height`
 * for the two documented cases that must animate layout — the decorative frame, whose 1px
 * border would smear under `scaleY`, and a nested block closing around a retained card,
 * whose siblings are glued to its bottom edge.
 *
 * These are optional on purpose. An element that does not use a channel must not have it
 * written at all: a stray `clip-path: inset(0 0 0 0)` creates a clipping context for every
 * row in the document, and a stray inline `height` would OVERRIDE the pure layout's own
 * geometry from then on — freezing the element at its animated size for the rest of the
 * session, which is far worse than a stale transform.
 */
describe("fold channels", () => {
	it("does not touch clip-path, top or height for an element that lacks them", () => {
		const h = harness(["a"]);
		h.store.setTarget("a", at(0));
		h.store.setTarget("a", at(-40));
		h.driver.tick(16);
		const root = h.roots.get("a") as MorphNode;
		expect(root.style.clipPath).toBe("");
		expect(root.style.top).toBe("");
		expect(root.style.height).toBe("");
	});

	it("writes the reveal inset while it is non-zero", () => {
		const h = harness(["a"]);
		h.store.setTarget("a", { ...at(0), insetBottom: 200 });
		h.store.setTarget("a", { ...at(0), insetBottom: 0 });
		h.driver.tick(16);
		expect(h.roots.get("a")?.style.clipPath).toContain("inset(0px 0px");
	});

	it("clears the inset rather than writing inset(0), which would clip needlessly", () => {
		const h = harness(["a"]);
		h.store.setTarget("a", { ...at(0), insetBottom: 0 });
		h.driver.tick(16);
		expect(h.roots.get("a")?.style.clipPath).toBe("");
	});

	it("animates top/height for the documented layout cases", () => {
		const h = harness(["a"]);
		h.store.setTarget("a", { ...at(0), boxTop: 0, boxHeight: 400 });
		h.store.setTarget("a", { ...at(0), boxTop: 0, boxHeight: 19 });
		h.driver.tick(16);
		const root = h.roots.get("a") as MorphNode;
		expect(root.style.height).toMatch(/^[\d.]+px$/);
		// Still travelling, not snapped to the end.
		expect(Number.parseFloat(root.style.height)).toBeGreaterThan(19);
		expect(Number.parseFloat(root.style.height)).toBeLessThan(400);
	});

	it("REMOVES inline layout on settle, so the pure layout owns geometry again", () => {
		// The dangerous case: a leftover inline height overrides the layout permanently.
		const h = harness(["a"]);
		h.store.setTarget("a", { ...at(0), boxTop: 0, boxHeight: 400, insetBottom: 100 });
		h.store.setTarget("a", { ...at(0), boxTop: 0, boxHeight: 19, insetBottom: 0 });
		h.driver.kick();
		let guard = 0;
		while (h.hasScheduled() && guard++ < 500) h.frame(16);
		const root = h.roots.get("a") as MorphNode;
		expect(root.style.height).toBe("");
		expect(root.style.top).toBe("");
		expect(root.style.clipPath).toBe("");
	});

	it("stop() also clears the layout channels mid-flight", () => {
		const h = harness(["a"]);
		h.store.setTarget("a", { ...at(0), boxHeight: 400 });
		h.store.setTarget("a", { ...at(0), boxHeight: 19 });
		h.driver.tick(16);
		expect(h.roots.get("a")?.style.height).not.toBe("");
		h.driver.stop();
		expect(h.roots.get("a")?.style.height).toBe("");
	});

	it("converges an optional channel from its target when newly acquired", () => {
		// Otherwise a box that merely gained the channel flies in from the origin.
		const h = harness(["a"]);
		h.store.setTarget("a", { ...at(0), boxHeight: 250 });
		expect(h.store.get("a")?.boxHeight).toBe(250);
		expect(h.store.isIdle()).toBe(true);
	});

	it("settles an optional channel exactly, and reports idle", () => {
		const h = harness(["a"]);
		h.store.setTarget("a", { ...at(0), boxHeight: 400 });
		h.store.setTarget("a", { ...at(0), boxHeight: 19 });
		let guard = 0;
		while (h.store.step(16) && guard++ < 500) {
			/* converge */
		}
		expect(h.store.get("a")?.boxHeight).toBe(19);
		expect(h.store.isIdle()).toBe(true);
	});

	it("does not keep the loop alive for a channel the element never uses", () => {
		// A channel converged but not settle-checked (or vice versa) would either spin forever
		// or freeze mid-animation. Absent means absent.
		const h = harness(["a"]);
		h.store.setTarget("a", at(0));
		expect(h.store.isIdle()).toBe(true);
	});
});

// ── The first frame ───────────────────────────────────────────────────────────
/**
 * `kick()` MUST write synchronously.
 *
 * It is called from a layout effect: the DOM is committed but not yet painted. Only
 * scheduling a frame means the first write lands on the NEXT frame, and the browser paints
 * the one in between with no transform at all — so the element appears at its FINAL position
 * for a frame, then jumps back to its start and converges from there. That reads as a flash,
 * not a transition.
 *
 * It is also invisible to a test that only checks end values, which is why it survived: every
 * value involved is eventually correct. And it explains why interrupting repeatedly appeared
 * to fix it — by then the loop was already running, so only newly-seeded elements flashed.
 */
describe("kick() paints the seeded state in the same commit", () => {
	it("writes the current offset before scheduling any frame", () => {
		const h = harness(["a"]);
		h.store.setTarget("a", at(-200)); // seeded start
		h.store.setTarget("a", at(0)); // resting target
		h.driver.kick();
		// Written already, without any frame having run.
		expect(h.roots.get("a")?.style.transform).toBe("translate(0px, -200px)");
	});

	it("writes on a later kick too, so a re-seeded element cannot flash", () => {
		const h = harness(["a", "b"]);
		h.store.setTarget("a", at(-100));
		h.store.setTarget("a", at(0));
		h.driver.kick();
		h.frame(16);
		// A second element joins mid-flight (a new group scrolled in).
		h.store.setTarget("b", at(-300));
		h.store.setTarget("b", at(0));
		h.driver.kick();
		expect(h.roots.get("b")?.style.transform).toBe("translate(0px, -300px)");
	});

	it("does not advance time when painting", () => {
		// Painting is not a frame: it must not consume any of the convergence.
		const h = harness(["a"]);
		h.store.setTarget("a", at(-200));
		h.store.setTarget("a", at(0));
		h.driver.kick();
		expect(h.store.get("a")?.y).toBe(-200);
	});

	it("paints the seeded cardness too, so the border does not start opaque", () => {
		const h = harness(["a"]);
		h.store.setTarget("a", { ...at(-50), cardness: 0 });
		h.store.setTarget("a", { ...at(0), cardness: 1 });
		h.driver.kick();
		expect(h.surfaces.get("a")?.style.borderColor).toBe("transparent");
	});
});

/**
 * The renderer also owns `top` / `height`, so the driver may only clear its OWN writes.
 *
 * Every row in this shell is `position: absolute` with a React-owned inline `top` and an
 * inline `height`; that inline value IS the committed layout, not a fallback for it.
 * `clearOne` used to blank both unconditionally "to hand control back to the committed
 * style", which instead DESTROYED it — the row lost its `top`, fell back to `auto`, and a
 * whole activity group collapsed into a stack at the container's origin while bodies pushed
 * out of view vanished.
 *
 * It only fired after a morph SETTLED (the one moment `clearOne` runs on a live element), so
 * the transition itself looked correct and everything broke the instant it completed.
 */
describe("layout channels are not stolen from the renderer", () => {
	it("leaves a committed top/height alone when it only animated a transform", () => {
		const h = harness(["body"]);
		const root = h.roots.get("body");
		if (!root) throw new Error("missing root");
		// What React committed for an absolutely positioned row.
		root.style.top = "2000px";
		root.style.height = "100px";
		h.store.startFrom("body", at(-400), at(0));
		h.driver.kick();
		for (let i = 0; i < 200 && h.hasScheduled(); i++) h.frame(16);
		expect(root.style.transform).toBe("");
		// The row must still know where it is, or it stacks at the origin.
		expect(root.style.top).toBe("2000px");
		expect(root.style.height).toBe("100px");
	});

	it("still clears a top/height the driver itself wrote", () => {
		const h = harness(["frame"]);
		const root = h.roots.get("frame");
		if (!root) throw new Error("missing root");
		// A layout-animating fold: the driver's value legitimately replaces the renderer's,
		// and leaving it behind would freeze the element at its animated size.
		h.store.startFrom(
			"frame",
			at(0, { boxTop: 100, boxHeight: 50 }),
			at(0, { boxTop: 100, boxHeight: 400 }),
		);
		h.driver.kick();
		expect(root.style.height).toBe("50px");
		for (let i = 0; i < 300 && h.hasScheduled(); i++) h.frame(16);
		expect(root.style.top).toBe("");
		expect(root.style.height).toBe("");
	});

	it("releases the layout channels as soon as they stop being driven", () => {
		// The channels can disappear while the element stays admitted (a fold finished and the
		// same node is now only translated). A fully-resting element paints nothing, so
		// `clearOne` may never run for it — the box would stay frozen for the session.
		const h = harness(["frame"]);
		const root = h.roots.get("frame");
		if (!root) throw new Error("missing root");
		h.store.startFrom("frame", at(0, { boxHeight: 400 }), at(0, { boxHeight: 400 }));
		h.driver.kick();
		expect(root.style.height).toBe("400px");
		h.store.startFrom("frame", at(0), at(0));
		h.driver.kick();
		for (let i = 0; i < 200 && h.hasScheduled(); i++) h.frame(16);
		expect(root.style.height).toBe("");
	});
});
