import { describe, expect, it } from "bun:test";
import {
	buildLodSnapshots,
	clipFor,
	diffLodSnapshots,
	LOD_MORPH_DURATION_MS,
	LOD_MORPH_MAX_GROUP_MEMBERS,
	LOD_MORPH_MAX_SHIFT_PX,
	type LodElementSource,
} from "./vlist-lod-morph";

/** A re-themed element: carries a `unitId` (a tool call / subagent card). */
function unit(unitId: string, top: number, height: number, kind = "tool-call"): LodElementSource {
	return { unitId, key: unitId, kind, top, height };
}

/**
 * A document-body element: NO `unitId`, pairs on its already level-invariant `key`
 * (markdown `${msgId}-b{n}`, bubbles `${msgId}-bubble`, system cards `${idBase}-sys`).
 */
function body(key: string, top: number, height: number, kind = "markdown"): LodElementSource {
	return { unitId: undefined, key, kind, top, height };
}

/**
 * A folded tool row INSIDE a trace: pairs only on `unitId`, and carries the clip its
 * trace element imposes (the shell clips a non-dynamic item to its arithmetic height).
 */
function row(
	unitId: string,
	top: number,
	height: number,
	clip: { top: number; bottom: number },
): LodElementSource {
	return { unitId, key: unitId, kind: "trace-row", top, height, clip, nested: true };
}

describe("buildLodSnapshots", () => {
	it("snapshots elements viewport-anchored, carrying their kind", () => {
		const next = buildLodSnapshots([unit("tool-a", 100, 40)], 0, 800);
		expect(next.get("tool-a")).toEqual({
			unitId: "tool-a",
			kind: "tool-call",
			viewportTop: 100,
			height: 40,
			clip: null,
		});
	});

	it("carries a nested row's clip into viewport space alongside its own top", () => {
		const next = buildLodSnapshots([row("tool-a", 240, 18.8, { top: 200, bottom: 400 })], 100, 800);
		expect(next.get("tool-a")).toEqual({
			unitId: "tool-a",
			kind: "trace-row",
			viewportTop: 140,
			height: 18.8,
			clip: { top: 100, bottom: 300 },
		});
	});

	/**
	 * A row key is scoped to its trace, so it is not a cross-level identity: falling
	 * back to it could pair a row with an unrelated top-level element that happens to
	 * share the string.
	 */
	it("skips a nested row with no unitId rather than pairing it on its key", () => {
		const next = buildLodSnapshots(
			[
				{
					unitId: undefined,
					key: "row-3",
					kind: "trace-row",
					top: 100,
					height: 18.8,
					clip: { top: 0, bottom: 400 },
					nested: true,
				},
			],
			0,
			800,
		);
		expect(next.size).toBe(0);
	});

	/**
	 * The whole point of the widened pairing: markdown bodies, user bubbles and system
	 * cards carry no `unitId` and used to be dropped here, so a level switch eased the
	 * cards into place while the document around them teleported.
	 */
	it("pairs a unitId-less element on its key (the document body)", () => {
		const next = buildLodSnapshots([body("m1-b0", 100, 240)], 0, 800);
		expect(next.get("m1-b0")).toEqual({
			unitId: "m1-b0",
			kind: "markdown",
			viewportTop: 100,
			height: 240,
			clip: null,
		});
	});

	it("prefers unitId over key when both are present", () => {
		const next = buildLodSnapshots(
			[
				{
					unitId: "tool-tu-1",
					key: "toolrun-count-tool-tu-1",
					kind: "tool-call",
					top: 0,
					height: 40,
				},
			],
			0,
			800,
		);
		expect([...next.keys()]).toEqual(["tool-tu-1"]);
	});

	it("skips an element with neither identity", () => {
		const next = buildLodSnapshots(
			[{ unitId: undefined, key: "", kind: "x", top: 0, height: 40 }],
			0,
			800,
		);
		expect(next.size).toBe(0);
	});

	it("crops to the viewport×3 window (one screen above + viewport + one below)", () => {
		// viewportHeight 800, scrollTop 1600 → window is [800, 3200).
		const elements = [
			unit("tool-before", 700, 40), // bottom 740 < minY 800 → out
			unit("tool-in-above", 770, 40), // bottom 810 > minY → in
			unit("tool-view", 1600, 40), // in
			unit("tool-in-below", 3199, 40), // top 3199 < maxY 3200 → in
			unit("tool-after", 3200, 40), // top >= maxY → out
		];
		const next = buildLodSnapshots(elements, 1600, 800);
		expect([...next.keys()].sort()).toEqual(["tool-in-above", "tool-in-below", "tool-view"]);
	});

	it("subtracts scrollTop so snapshots are viewport-anchored", () => {
		const a = buildLodSnapshots([unit("tool-a", 1000, 40)], 0, 800);
		const b = buildLodSnapshots([unit("tool-a", 1000, 40)], 480, 800);
		expect(b.get("tool-a")?.viewportTop).toBeCloseTo((a.get("tool-a")?.viewportTop ?? 0) - 480, 5);
	});

	it("keeps the first occurrence of a duplicated identity", () => {
		const next = buildLodSnapshots([unit("tool-a", 100, 40), unit("tool-a", 300, 40)], 0, 800);
		expect(next.get("tool-a")?.viewportTop).toBe(100);
	});
});

describe("diffLodSnapshots", () => {
	it("plans a morph for a paired identity that moved", () => {
		const prev = buildLodSnapshots([unit("tool-a", 100, 40)], 0, 800);
		const next = buildLodSnapshots([unit("tool-a", 300, 40)], 0, 800);
		const plans = diffLodSnapshots(prev, next);
		expect(plans).toHaveLength(1);
		expect(plans[0]).toEqual({
			unitId: "tool-a",
			deltaY: -200, // before 100 − after 300 → slides down 200 into place
			fade: false, // same kind at both levels: nothing was swapped
			toKind: "tool-call",
			durationMs: LOD_MORPH_DURATION_MS,
		});
	});

	it("plans one morph per paired element (a level switch re-themes many at once)", () => {
		const prev = buildLodSnapshots(
			[unit("a", 100, 40), body("m1-b0", 200, 40), body("m1-bubble", 300, 40)],
			0,
			800,
		);
		const next = buildLodSnapshots(
			[unit("a", 110, 40), body("m1-b0", 240, 40), body("m1-bubble", 390, 40)],
			0,
			800,
		);
		const plans = diffLodSnapshots(prev, next);
		expect(plans.map((p) => p.unitId).sort()).toEqual(["a", "m1-b0", "m1-bubble"]);
		expect(plans.every((p) => p.durationMs === LOD_MORPH_DURATION_MS)).toBe(true);
	});

	/**
	 * The fade masks a COMPONENT SWAP. Applying it to content that merely moved makes
	 * unchanged prose blink once per zoom step, which reads as a glitch rather than a
	 * transition — so `kind` decides, not the mere existence of a morph.
	 */
	it("fades only when the element's kind changed", () => {
		const prev = buildLodSnapshots([unit("tool-a", 100, 400, "tool-call")], 0, 800);
		const swapped = buildLodSnapshots([unit("tool-a", 300, 19, "activity-trace")], 0, 800);
		expect(diffLodSnapshots(prev, swapped)[0]?.fade).toBe(true);

		const moved = buildLodSnapshots([unit("tool-a", 300, 400, "tool-call")], 0, 800);
		expect(diffLodSnapshots(prev, moved)[0]?.fade).toBe(false);
	});

	it("skips an identity present in only one frame (no counterpart to morph)", () => {
		const prev = buildLodSnapshots([unit("tool-a", 100, 40)], 0, 800);
		const next = buildLodSnapshots([unit("tool-b", 100, 40)], 0, 800);
		expect(diffLodSnapshots(prev, next)).toHaveLength(0);
	});

	it("skips sub-pixel moves (invisible, but still costs a layer)", () => {
		const prev = buildLodSnapshots([unit("tool-a", 100, 40)], 0, 800);
		const next = buildLodSnapshots([unit("tool-a", 100.4, 40)], 0, 800);
		expect(diffLodSnapshots(prev, next)).toHaveLength(0);
	});

	/**
	 * Collapsing L5 → L1 turns a multi-thousand-pixel card stack into 19px rows, so the
	 * elements below it can travel arbitrarily far. Sliding across that in 250ms is a
	 * blur that costs the reader their place — the same bound, and the same reasoning,
	 * as the fold transition's FOLD_MAX_SHIFT_PX.
	 */
	it("skips a displacement too large to read as motion", () => {
		const prev = buildLodSnapshots([unit("tool-a", 0, 40)], 0, 100_000);
		const tooFar = buildLodSnapshots([unit("tool-a", LOD_MORPH_MAX_SHIFT_PX + 1, 40)], 0, 100_000);
		expect(diffLodSnapshots(prev, tooFar)).toHaveLength(0);

		const atBound = buildLodSnapshots([unit("tool-a", LOD_MORPH_MAX_SHIFT_PX, 40)], 0, 100_000);
		expect(diffLodSnapshots(prev, atBound)).toHaveLength(1);
	});

	it("skips a non-finite delta rather than handing NaN to the DOM edge", () => {
		const prev = buildLodSnapshots([unit("tool-a", Number.NaN, 40)], 0, 100_000);
		const next = buildLodSnapshots([unit("tool-a", 100, 40)], 0, 100_000);
		expect(diffLodSnapshots(prev, next)).toHaveLength(0);
	});

	/**
	 * A re-theme IN PLACE is the one case a sub-pixel delta must still animate: an
	 * activity fold swaps the component without moving it, so gating on distance alone
	 * silently dropped the very transition the L2/L3 boundary needs.
	 */
	it("fades a re-theme that did not move", () => {
		const prev = buildLodSnapshots([unit("tool-a", 100, 400, "tool-call")], 0, 800);
		const next = buildLodSnapshots([unit("tool-a", 100, 19, "trace-row")], 0, 800);
		expect(diffLodSnapshots(prev, next)).toEqual([
			{
				unitId: "tool-a",
				deltaY: 0,
				fade: true,
				toKind: "trace-row",
				durationMs: LOD_MORPH_DURATION_MS,
			},
		]);
	});

	it("fades in place rather than losing the transition when travel is out of bounds", () => {
		const prev = buildLodSnapshots([unit("tool-a", 0, 400, "tool-call")], 0, 100_000);
		const next = buildLodSnapshots(
			[unit("tool-a", LOD_MORPH_MAX_SHIFT_PX + 500, 19, "trace-row")],
			0,
			100_000,
		);
		expect(diffLodSnapshots(prev, next)).toEqual([
			{
				unitId: "tool-a",
				deltaY: 0,
				fade: true,
				toKind: "trace-row",
				durationMs: LOD_MORPH_DURATION_MS,
			},
		]);
	});
});

describe("clipFor", () => {
	it("lets an unclipped node travel from anywhere", () => {
		expect(clipFor(null, -10_000, 40)).toBe(true);
	});

	it("accepts a start box that overlaps the clip, even partially", () => {
		const clip = { top: 100, bottom: 300 };
		expect(clipFor(clip, 150, 40)).toBe(true); // fully inside
		expect(clipFor(clip, 80, 40)).toBe(true); // straddles the top edge
		expect(clipFor(clip, 280, 40)).toBe(true); // straddles the bottom edge
	});

	it("rejects a start box wholly outside the clip (it would be invisible)", () => {
		const clip = { top: 100, bottom: 300 };
		expect(clipFor(clip, 20, 40)).toBe(false); // ends at 60, above the clip
		expect(clipFor(clip, 300, 40)).toBe(false); // starts at the bottom edge
	});
});

/**
 * The L2/L3 boundary — the switch with the largest visual change, because it is the one
 * where the component really differs: a tool call is a summary ROW inside an
 * activity-trace at L1/L2 and a full CARD at L3+. Both carry `tool-<toolUseId>`, so the
 * pairing is 1:1.
 *
 * The two directions are NOT symmetric, and the asymmetry is a property of the canvas:
 * a morph animates the NEW node, a nested row is clipped to its trace's box, and a
 * top-level card is clipped by nothing.
 */
describe("diffLodSnapshots — the L2/L3 row ↔ card boundary", () => {
	/** L2: one folded row at y=300, inside a trace spanning 280..480. */
	const foldedRow = () =>
		buildLodSnapshots([row("tool-a", 300, 18.8, { top: 280, bottom: 480 })], 0, 800);
	/** L3: the same call as a 400px card at y=300. */
	const expandedCard = () => buildLodSnapshots([unit("tool-a", 300, 400, "tool-call")], 0, 800);

	it("pairs the folded row with the card it becomes", () => {
		const plans = diffLodSnapshots(foldedRow(), expandedCard());
		expect(plans.map((p) => p.unitId)).toEqual(["tool-a"]);
		expect(plans[0]?.fade).toBe(true);
	});

	/**
	 * L2 → L3. The new node is the top-level card, which nothing clips, so it may
	 * travel the whole way from wherever the row was.
	 */
	it("slides the incoming CARD from the row's position (row → card)", () => {
		const before = buildLodSnapshots([row("tool-a", 300, 18.8, { top: 280, bottom: 480 })], 0, 800);
		const after = buildLodSnapshots([unit("tool-a", 520, 400, "tool-call")], 0, 800);
		const plan = diffLodSnapshots(before, after)[0];
		expect(plan).toMatchObject({ deltaY: -220, fade: true });
	});

	/**
	 * L3 → L2. The new node is the nested row, clipped to its trace. Its counterpart
	 * card sat far outside that box, so a slide would put the row under the clip and
	 * make it vanish for the duration — a blink. The fade survives, the travel does not.
	 */
	it("keeps the fade but drops the travel for the incoming ROW (card → row)", () => {
		const before = buildLodSnapshots([unit("tool-a", 1200, 400, "tool-call")], 0, 800);
		const after = buildLodSnapshots([row("tool-a", 300, 18.8, { top: 280, bottom: 480 })], 0, 800);
		const plan = diffLodSnapshots(before, after)[0];
		// Start would be y=1200, far below the clip's 480 bottom → unslidable.
		expect(plan).toEqual({
			unitId: "tool-a",
			deltaY: 0,
			fade: true,
			toKind: "trace-row",
			durationMs: LOD_MORPH_DURATION_MS,
		});
	});

	/**
	 * The clip test is "no overlap at all", not "fully inside": a row arriving from a
	 * partially clipped start is still visible travelling, which is the point.
	 */
	it("still slides an incoming row whose start box overlaps its clip", () => {
		const before = buildLodSnapshots([unit("tool-a", 340, 40, "tool-call")], 0, 800);
		const after = buildLodSnapshots([row("tool-a", 300, 18.8, { top: 280, bottom: 480 })], 0, 800);
		const plan = diffLodSnapshots(before, after)[0];
		expect(plan).toMatchObject({ deltaY: 40, fade: true });
	});

	/**
	 * A trace shows at most `ACTIVITY_MAX_VISIBLE` rows, so a call folded behind the
	 * "earlier" toggle contributes no row snapshot. It has no counterpart to morph from
	 * and must simply appear — never be animated from a position it never occupied.
	 */
	it("does not morph a call whose folded form is hidden behind the fold", () => {
		const before = buildLodSnapshots([], 0, 800);
		const after = buildLodSnapshots([unit("tool-a", 300, 400, "tool-call")], 0, 800);
		expect(diffLodSnapshots(before, after)).toHaveLength(0);
	});
});

/**
 * EVERY MEMBER of an activity group must morph, not just the group.
 *
 * At L1/L2 a group's members are NESTED trace rows; at L3+ each becomes its own top-level
 * card. They pair on `unitId` (a row key is trace-scoped and unusable across levels), so if
 * the shell stopped feeding nested rows the intersection would be empty exactly at the
 * switch that changes the most — and nothing would animate, silently, because the planner
 * still returns cleanly.
 */
describe("activity group members each morph", () => {
	const nested = (id: string, top: number, height: number, kind: string): LodElementSource => ({
		unitId: id,
		key: id,
		kind,
		top,
		height,
		nested: true,
		clip: { top: 0, bottom: 4000 },
	});

	it("plans one morph per member, each marked as a re-theme", () => {
		const prev = buildLodSnapshots(
			[
				nested("t1", 100, 19, "trace-row"),
				nested("t2", 120, 19, "trace-row"),
				nested("t3", 140, 19, "trace-row"),
			],
			0,
			800,
		);
		const next = buildLodSnapshots(
			[
				nested("t1", 200, 400, "tool-call"),
				nested("t2", 620, 400, "tool-call"),
				nested("t3", 1040, 400, "tool-call"),
			],
			0,
			800,
		);
		const plans = diffLodSnapshots(prev, next);
		expect(plans.map((p) => p.unitId).sort()).toEqual(["t1", "t2", "t3"]);
		// Each is a component swap, so each fades; and each carries the direction.
		for (const p of plans) {
			expect(p.fade).toBe(true);
			expect(p.toKind).toBe("tool-call");
		}
		// Distinct travel per member: they do not share one displacement.
		expect(new Set(plans.map((p) => p.deltaY)).size).toBe(3);
	});

	it("carries the reverse direction when collapsing back to rows", () => {
		const prev = buildLodSnapshots([nested("t1", 200, 400, "tool-call")], 0, 800);
		const next = buildLodSnapshots([nested("t1", 100, 19, "trace-row")], 0, 800);
		const plans = diffLodSnapshots(prev, next);
		expect(plans).toHaveLength(1);
		// `fade` alone cannot tell the two directions apart — `toKind` is what lets the
		// border and tail fade OUT here rather than in.
		expect(plans[0]?.toKind).toBe("trace-row");
	});

	it("still morphs a member whose identity is missing at one level", () => {
		// An unpaired identity has nothing to morph between and must simply appear, without
		// dragging its neighbours' plans down with it.
		const prev = buildLodSnapshots([nested("t1", 100, 19, "trace-row")], 0, 800);
		const next = buildLodSnapshots(
			[nested("t1", 200, 400, "tool-call"), nested("t9", 700, 400, "tool-call")],
			0,
			800,
		);
		const plans = diffLodSnapshots(prev, next);
		expect(plans.map((p) => p.unitId)).toEqual(["t1"]);
	});
});

/**
 * A LARGE activity group must animate every member, not just its first few.
 *
 * The admission window is `scrollTop − vh … scrollTop + 2·vh`, and one group's content
 * occupies wildly different extents at the two levels:
 *
 *   folded:   10 rows  × ~19px  =  190px  → every row inside the window
 *   expanded: 10 cards × ~400px = 4000px → only the first few inside it
 *
 * Judged on their own boxes the later members were absent from the EXPANDED frame, so the
 * diff found no counterpart and planned nothing for them — silently. The reader saw the
 * first rows animate while the rest teleported. Anchoring every member to its unit's box
 * admits the whole group or none of it.
 */
describe("group-anchored admission", () => {
	const VH = 800;
	const folded = (n: number, groupBox: { top: number; height: number }): LodElementSource[] =>
		[...Array(n)].map((_, i) => ({
			unitId: `t${i}`,
			key: `t${i}`,
			kind: "trace-row",
			top: groupBox.top + i * 19,
			height: 19,
			nested: true,
			groupBox,
		}));
	const expanded = (n: number, unitBox: { top: number; height: number }): LodElementSource[] =>
		[...Array(n)].map((_, i) => ({
			unitId: `t${i}`,
			key: `t${i}`,
			kind: "tool-call",
			top: unitBox.top + i * 400,
			height: 400,
			groupBox: unitBox,
			unitAnchored: true,
		}));

	it("plans a morph for EVERY member of a group whose expanded form overflows the window", () => {
		const prev = buildLodSnapshots(folded(10, { top: 0, height: 190 }), 0, VH);
		const next = buildLodSnapshots(expanded(10, { top: 0, height: 4000 }), 0, VH);
		const plans = diffLodSnapshots(prev, next);
		// Was 4 of 10 before the anchor: cards past ~1600px pruned themselves.
		expect(plans).toHaveLength(10);
		expect(plans.map((p) => p.unitId).sort()).toEqual([...Array(10)].map((_, i) => `t${i}`).sort());
	});

	it("anchors the EXPANDED side too, since a pair needs both frames", () => {
		// Fixing only the folded side changes nothing: a card is top-level with its own tall
		// box, so it would still be missing from the expanded snapshot.
		const withoutAnchor = expanded(10, { top: 0, height: 4000 }).map(
			({ unitAnchored: _unused, ...rest }) => rest,
		);
		const next = buildLodSnapshots(withoutAnchor, 0, VH);
		expect(next.size).toBeLessThan(10);
	});

	it("caps one group so a pathological document cannot animate hundreds of nodes", () => {
		const prev = buildLodSnapshots(folded(50, { top: 0, height: 950 }), 0, VH);
		const next = buildLodSnapshots(expanded(50, { top: 0, height: 20_000 }), 0, VH);
		expect(diffLodSnapshots(prev, next)).toHaveLength(LOD_MORPH_MAX_GROUP_MEMBERS);
	});

	it("counts the cap PER GROUP, not globally", () => {
		// A global budget would let an early group starve a later one for no perceptible
		// reason. Two groups of 20 must both be fully admitted.
		const a = folded(20, { top: 0, height: 380 });
		const b = folded(20, { top: 400, height: 380 }).map((el) => ({
			...el,
			unitId: `b-${el.unitId}`,
			key: `b-${el.key}`,
		}));
		expect(buildLodSnapshots([...a, ...b], 0, VH).size).toBe(40);
	});

	it("still crops a group that is nowhere near the viewport", () => {
		// The anchor widens WHICH box is consulted; it must not disable the window.
		expect(buildLodSnapshots(folded(5, { top: 50_000, height: 190 }), 0, VH).size).toBe(0);
	});

	it("leaves an element without a groupBox judged on its own box", () => {
		const plain: LodElementSource[] = [
			{ unitId: "p1", key: "p1", kind: "markdown", top: 100, height: 40 },
			{ unitId: "p2", key: "p2", kind: "markdown", top: 9000, height: 40 },
		];
		expect([...buildLodSnapshots(plain, 0, VH).keys()]).toEqual(["p1"]);
	});
});
