/**
 * Tests for target-based planning.
 *
 * The regression these must hold is the one that motivated the rewrite's §3.5: a large
 * activity group lost animation on its later members because admission judged each element
 * on its own box, and the same content occupies ~190px folded but ~4000px expanded — so the
 * later members fell outside the window in ONE frame only and had nothing to pair with.
 */

import { describe, expect, it } from "bun:test";
import {
	admitElements,
	admitPair,
	initialStateFor,
	MORPH_MAX_SHIFT_PX,
	MORPH_MAX_UNIT_MEMBERS,
	type MorphElement,
	overlapsClip,
	planMorphTargets,
} from "./vlist-morph-plan";

const VH = 800;
/** Rows are the folded form (cardness 0); cards are the expanded one (cardness 1). */
const cardnessOf = (kind: string) => (kind === "tool-call" ? 1 : 0);

const top = (unitId: string, t: number, h: number, kind = "tool-call"): MorphElement => ({
	unitId,
	key: unitId,
	kind,
	top: t,
	height: h,
});

const member = (
	unitId: string,
	t: number,
	h: number,
	kind: string,
	unitBox: { top: number; height: number },
): MorphElement => ({ unitId, key: unitId, kind, top: t, height: h, nested: true, unitBox });

// ── Admission ─────────────────────────────────────────────────────────────────
describe("admission", () => {
	it("crops to the ×3 window", () => {
		const admitted = admitElements([top("near", 100, 40), top("far", 9000, 40)], 0, VH);
		expect([...admitted.keys()]).toEqual(["near"]);
	});

	it("admits a whole unit or none of it, however tall its expanded form", () => {
		// THE REGRESSION. Judged individually, cards past ~1600px prune themselves out of the
		// expanded frame while every folded row stays inside the window — so those members
		// could never pair, and the reader saw the first few rows animate while the rest
		// teleported.
		const unitBox = { top: 0, height: 4000 };
		const cards = [...Array(10)].map((_, i) => member(`t${i}`, i * 400, 400, "tool-call", unitBox));
		expect(admitElements(cards, 0, VH).size).toBe(10);
	});

	it("still rejects a unit that is nowhere near the viewport", () => {
		// Unit-anchoring widens WHICH box is consulted; it must not disable the window.
		const unitBox = { top: 50_000, height: 190 };
		const rows = [...Array(5)].map((_, i) =>
			member(`t${i}`, 50_000 + i * 19, 19, "trace-row", unitBox),
		);
		expect(admitElements(rows, 0, VH).size).toBe(0);
	});

	it("caps one unit so a pathological document cannot animate hundreds of nodes", () => {
		const unitBox = { top: 0, height: 40_000 };
		const many = [...Array(100)].map((_, i) => member(`t${i}`, i * 400, 400, "tool-call", unitBox));
		expect(admitElements(many, 0, VH).size).toBe(MORPH_MAX_UNIT_MEMBERS);
	});

	it("counts the cap per unit, not globally", () => {
		const a = { top: 0, height: 380 };
		const b = { top: 400, height: 380 };
		const rows = [
			...[...Array(20)].map((_, i) => member(`a${i}`, i * 19, 19, "trace-row", a)),
			...[...Array(20)].map((_, i) => member(`b${i}`, 400 + i * 19, 19, "trace-row", b)),
		];
		expect(admitElements(rows, 0, VH).size).toBe(40);
	});

	it("refuses to pair a nested element on its key, which is trace-scoped", () => {
		// A row key could collide with an unrelated top-level element's.
		const nameless: MorphElement = {
			unitId: null,
			key: "row-0",
			kind: "trace-row",
			top: 10,
			height: 19,
			nested: true,
			unitBox: { top: 0, height: 100 },
		};
		expect(admitElements([nameless], 0, VH).size).toBe(0);
	});

	it("lets a TOP-LEVEL element fall back to its key", () => {
		const noUnit: MorphElement = {
			unitId: null,
			key: "md-1",
			kind: "markdown",
			top: 10,
			height: 40,
		};
		expect([...admitElements([noUnit], 0, VH).keys()]).toEqual(["md-1"]);
	});

	it("converts geometry to viewport px", () => {
		const admitted = admitElements([top("a", 500, 40)], 200, VH);
		expect(admitted.get("a")?.viewportTop).toBe(300);
	});
});

// ── Pairing ───────────────────────────────────────────────────────────────────
describe("pairing produces a displacement, never a journey", () => {
	it("gives the element the offset it must travel BACK from", () => {
		// The layout has already placed it at the new position; the plan says where it was.
		const before = admitElements([top("a", 100, 40)], 0, VH);
		const after = admitElements([top("a", 300, 40)], 0, VH);
		const plans = planMorphTargets(before, after, cardnessOf);
		expect(plans).toHaveLength(1);
		expect(plans[0]?.fromOffset.y).toBe(-200);
		// And it settles at rest — the target never encodes a start.
		expect(plans[0]?.target).toEqual({ x: 0, y: 0, opacity: 1, cardness: 1 });
	});

	it("marks a component swap as a re-theme", () => {
		const before = admitElements([top("a", 100, 19, "trace-row")], 0, VH);
		const after = admitElements([top("a", 100, 400, "tool-call")], 0, VH);
		expect(planMorphTargets(before, after, cardnessOf)[0]?.reTheme).toBe(true);
	});

	it("applies the horizontal compensation only to a re-theme", () => {
		// The two forms start their content at different offsets; an element that merely moved
		// has no such difference to correct.
		const xOffset = () => 7;
		const swapBefore = admitElements([top("a", 100, 19, "trace-row")], 0, VH);
		const swapAfter = admitElements([top("a", 300, 400, "tool-call")], 0, VH);
		expect(planMorphTargets(swapBefore, swapAfter, cardnessOf, xOffset)[0]?.fromOffset.x).toBe(7);

		const moveBefore = admitElements([top("a", 100, 40)], 0, VH);
		const moveAfter = admitElements([top("a", 300, 40)], 0, VH);
		expect(planMorphTargets(moveBefore, moveAfter, cardnessOf, xOffset)[0]?.fromOffset.x).toBe(0);
	});

	it("skips an unpaired identity without disturbing its neighbours", () => {
		const before = admitElements([top("a", 100, 40)], 0, VH);
		const after = admitElements([top("a", 300, 40), top("new", 500, 40)], 0, VH);
		expect(planMorphTargets(before, after, cardnessOf).map((p) => p.unitId)).toEqual(["a"]);
	});

	it("settles a sub-pixel move in place, animating only a swap", () => {
		const before = admitElements([top("a", 100, 40)], 0, VH);
		const after = admitElements([top("a", 100.4, 40)], 0, VH);
		expect(planMorphTargets(before, after, cardnessOf)).toHaveLength(0);
	});

	it("drops the travel past the shift bound but keeps a re-theme's cardness change", () => {
		// A displacement that large does not read as motion; the swap still needs to be shown.
		const before = admitElements([top("a", 0, 19, "trace-row")], 0, VH);
		const after = admitElements(
			[top("a", MORPH_MAX_SHIFT_PX + 500, 400, "tool-call")],
			MORPH_MAX_SHIFT_PX + 500,
			VH,
		);
		const plans = planMorphTargets(before, after, cardnessOf);
		expect(plans).toHaveLength(1);
		expect(plans[0]?.fromOffset).toEqual({ x: 0, y: 0 });
		expect(plans[0]?.reTheme).toBe(true);
	});
});

// ── Initial state ─────────────────────────────────────────────────────────────
describe("initialStateFor", () => {
	it("starts a re-theme at the OPPOSITE cardness, so the chrome fades across the swap", () => {
		const before = admitElements([top("a", 100, 19, "trace-row")], 0, VH);
		const after = admitElements([top("a", 300, 400, "tool-call")], 0, VH);
		const plan = planMorphTargets(before, after, cardnessOf)[0];
		expect(plan).toBeDefined();
		const initial = initialStateFor(plan as NonNullable<typeof plan>);
		// Target cardness is 1 (a card), so it starts at 0 (a row).
		expect(initial.cardness).toBe(0);
		expect(initial.y).toBe(-200);
	});

	it("never fades the LINE itself", () => {
		// The two forms carry the same text at the same place; fading it reads as a blur
		// rather than a replacement, and fights the height animation underneath.
		const before = admitElements([top("a", 100, 19, "trace-row")], 0, VH);
		const after = admitElements([top("a", 300, 400, "tool-call")], 0, VH);
		const plan = planMorphTargets(before, after, cardnessOf)[0];
		expect(initialStateFor(plan as NonNullable<typeof plan>).opacity).toBe(1);
	});

	it("leaves a plain move at its committed cardness", () => {
		const before = admitElements([top("a", 100, 40)], 0, VH);
		const after = admitElements([top("a", 300, 40)], 0, VH);
		const plan = planMorphTargets(before, after, cardnessOf)[0];
		const initial = initialStateFor(plan as NonNullable<typeof plan>);
		expect(initial.cardness).toBe(1);
	});
});

describe("overlapsClip", () => {
	it("treats an absent clip as unbounded", () => {
		expect(overlapsClip(null, -5000, 10)).toBe(true);
	});

	it("is 'any overlap', not 'fully inside'", () => {
		// A row arriving from above is partly visible and must still animate.
		expect(overlapsClip({ top: 0, bottom: 100 }, -10, 20)).toBe(true);
		expect(overlapsClip({ top: 0, bottom: 100 }, -30, 20)).toBe(false);
	});
});

// ── Paired admission ──────────────────────────────────────────────────────────
/**
 * Visibility is a property of the CONTENT, not of one of its two forms.
 *
 * Admitting each frame on its own geometry loses whole groups, not stray rows: a 12-row
 * activity fold is ~228px while its expanded form is ~4800px, so a scroll position inside
 * the region that only exists when expanded puts the folded unit entirely above the window.
 * Every row is then unpaired and the entire group silently loses its animation.
 */
describe("admitPair", () => {
	const rows = (box: { top: number; height: number }) =>
		[...Array(12)].map((_, i) => member(`t${i}`, box.top + i * 19, 19, "trace-row", box));
	const cards = (box: { top: number; height: number }) =>
		[...Array(12)].map((_, i) => member(`t${i}`, box.top + i * 400, 400, "tool-call", box));

	const FOLDED = { top: 1000, height: 228 };
	const EXPANDED = { top: 1000, height: 4800 };

	it("pairs every member at a scroll position only the EXPANDED form reaches", () => {
		// window at scrollTop 3000 is 2200…4600; the folded unit ends at 1228 and would be
		// dropped on its own, taking all 12 rows' animation with it.
		const { before, after } = admitPair(cards(EXPANDED), rows(FOLDED), 3000, VH);
		expect(planMorphTargets(before, after, cardnessOf)).toHaveLength(12);
	});

	it("pairs every member across a range of scroll positions, both directions", () => {
		for (const scrollTop of [0, 1500, 3000, 5000]) {
			const collapse = admitPair(cards(EXPANDED), rows(FOLDED), scrollTop, VH);
			expect(planMorphTargets(collapse.before, collapse.after, cardnessOf)).toHaveLength(12);
			const expand = admitPair(rows(FOLDED), cards(EXPANDED), scrollTop, VH);
			expect(planMorphTargets(expand.before, expand.after, cardnessOf)).toHaveLength(12);
		}
	});

	it("still admits nothing when the content is genuinely far off-screen", () => {
		// The union widens which frame may admit; it must not disable the window.
		const { before, after } = admitPair(cards(EXPANDED), rows(FOLDED), 20_000, VH);
		expect(before.size).toBe(0);
		expect(after.size).toBe(0);
	});

	it("keeps each frame's OWN geometry for the rescued elements", () => {
		// A rescued element must report where it is in ITS frame, or the displacement would be
		// computed against the wrong position.
		const { before, after } = admitPair(cards(EXPANDED), rows(FOLDED), 3000, VH);
		expect(before.get("t0")?.kind).toBe("tool-call");
		expect(after.get("t0")?.kind).toBe("trace-row");
		expect(before.get("t0")?.height).toBe(400);
		expect(after.get("t0")?.height).toBe(19);
	});

	it("does not invent an element that exists in only one frame", () => {
		const onlyBefore = [top("gone", 1000, 40)];
		const { before, after } = admitPair(onlyBefore, [], 1000, VH);
		expect(before.size).toBe(1);
		expect(after.size).toBe(0);
		expect(planMorphTargets(before, after, cardnessOf)).toHaveLength(0);
	});
});

/**
 * Each frame converts DOCUMENT px with ITS OWN scroll origin.
 *
 * A gesture-driven LOD switch rewrites `scrollTop`: the LOD anchor holds the pointed-at
 * content at a fixed screen position while the document's height changes drastically
 * around it. The two frames are therefore expressed in different scroll origins, and
 * converting the baseline's document offsets with the NEW origin charges the entire
 * scroll correction to every element as apparent travel.
 *
 * The visible result is that the zoom appears centred somewhere other than the pointer:
 * the anchored content — which by construction did not move on screen — gets displaced by
 * the correction and animates back from it, while everything else is off by the same
 * amount. Nothing errors, and the elements do end up in the right place, so only the
 * motion is wrong.
 */
describe("scroll-origin correctness across a corrected switch", () => {
	// A body at document 2000 with scrollTop 1600 sits at screen +400. After the switch the
	// group above it expanded, pushing it to 6000, and the anchor moved scrollTop to 5600 —
	// so it is STILL at screen +400 and must not animate.
	const anchoredBefore: MorphElement[] = [
		{ unitId: "body", key: "body", kind: "markdown", top: 2000, height: 100 },
	];
	const anchoredAfter: MorphElement[] = [
		{ unitId: "body", key: "body", kind: "markdown", top: 6000, height: 100 },
	];

	it("gives anchored content no travel when the switch corrected scrollTop", () => {
		const { before, after } = admitPair(anchoredBefore, anchoredAfter, 5600, VH, 1600);
		expect(before.get("body")?.viewportTop).toBe(400);
		expect(after.get("body")?.viewportTop).toBe(400);
		// Same screen position at both levels ⇒ nothing to travel ⇒ no plan.
		expect(planMorphTargets(before, after, cardnessOf)).toHaveLength(0);
	});

	it("still reports real travel for content that actually moved", () => {
		// A row inside the group becomes a card 300px further down the screen.
		const rowBefore: MorphElement[] = [
			{ unitId: "t0", key: "t0", kind: "trace-row", top: 2100, height: 19 },
		];
		const cardAfter: MorphElement[] = [
			{ unitId: "t0", key: "t0", kind: "tool-call", top: 6400, height: 400 },
		];
		const { before, after } = admitPair(rowBefore, cardAfter, 5600, VH, 1600);
		const plans = planMorphTargets(before, after, cardnessOf);
		expect(plans).toHaveLength(1);
		expect(plans[0]?.fromOffset.y).toBe(-300);
	});

	it("defaults to one origin, so an uncorrected switch is unaffected", () => {
		// Omitting the argument must behave exactly as before for callers whose scroll
		// position did not move between the frames.
		const { before, after } = admitPair(anchoredBefore, anchoredBefore, 1600, VH);
		expect(before.get("body")?.viewportTop).toBe(400);
		expect(after.get("body")?.viewportTop).toBe(400);
	});

	it("converts a RESCUED counterpart with its own frame's origin too", () => {
		// The rescue path reads from the full element list when one frame's window
		// disagreed. It shares the conversion, so a single origin there would reintroduce
		// the phantom travel for exactly the elements the window disagreed about.
		const farBefore: MorphElement[] = [
			{ unitId: "x", key: "x", kind: "markdown", top: 200, height: 50 },
		];
		const nearAfter: MorphElement[] = [
			{ unitId: "x", key: "x", kind: "markdown", top: 5800, height: 50 },
		];
		const { before, after } = admitPair(farBefore, nearAfter, 5600, VH, 100);
		// Admitted in the after frame; rescued into the before frame from `farBefore`.
		expect(after.get("x")?.viewportTop).toBe(200);
		expect(before.get("x")?.viewportTop).toBe(100);
	});
});
