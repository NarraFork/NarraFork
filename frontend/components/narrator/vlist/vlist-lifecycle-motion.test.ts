import { describe, expect, it } from "bun:test";
import { planFoldMotion } from "./vlist-fold-animation";
import {
	buildLifecycleSnapshot,
	type LifecycleElementSource,
	lifecycleShapeSignature,
	planLifecycleMotion,
} from "./vlist-lifecycle-motion";

/** A tool card, open or closed, at a given top/height. */
function card(key: string, top: number, height: number, opened: boolean, form = 0) {
	return {
		key,
		kind: "tool-call",
		top,
		height,
		measured: { effectiveOpened: opened, permissionFormHeight: form },
	} satisfies LifecycleElementSource;
}

function body(key: string, top: number, height: number, lifecycleId?: string) {
	return {
		key,
		kind: "markdown",
		top,
		height,
		measured: {},
		...(lifecycleId ? { lifecycleId } : {}),
	} satisfies LifecycleElementSource;
}

function plan(before: LifecycleElementSource[], after: LifecycleElementSource[], scroll = [0, 0]) {
	return planLifecycleMotion({
		before: buildLifecycleSnapshot(before),
		after: buildLifecycleSnapshot(after),
		beforeScrollTop: scroll[0] ?? 0,
		afterScrollTop: scroll[1] ?? 0,
	});
}

describe("shape signatures", () => {
	it("only the enumerated kinds have one", () => {
		expect(lifecycleShapeSignature("markdown", { height: 10 })).toBeNull();
		expect(lifecycleShapeSignature("activity-trace", { rows: [] })).toBeNull();
		expect(lifecycleShapeSignature("tool-call", { effectiveOpened: true })).toBe("open|pf:0");
		expect(
			lifecycleShapeSignature("tool-call", { effectiveOpened: true, permissionFormHeight: 116 }),
		).toBe(
			lifecycleShapeSignature("tool-call", { effectiveOpened: true, permissionFormHeight: 149 }),
		);
		expect(lifecycleShapeSignature("reasoning", { form: "expanded" })).toBe("expanded");
		expect(lifecycleShapeSignature("subagent-card", { effectiveExpanded: false })).toBe("closed");
	});
});

describe("buildLifecycleSnapshot", () => {
	it("pairs none of the elements that share one identity, however many there are", () => {
		const shared = (key: string, top: number) => body(key, top, 20, "blk:dup");
		expect(buildLifecycleSnapshot([shared("a", 0), shared("b", 20)]).has("blk:dup")).toBe(false);
		// A third claimant must not slip back in once the first two cancelled out.
		expect(
			buildLifecycleSnapshot([shared("a", 0), shared("b", 20), shared("c", 40)]).has("blk:dup"),
		).toBe(false);
		// A unique identity alongside them still pairs.
		const snapshot = buildLifecycleSnapshot([shared("a", 0), shared("b", 20), body("d", 40, 20)]);
		expect(snapshot.has("d")).toBe(true);
	});
});

describe("planLifecycleMotion", () => {
	it("L3: a card collapsing on completion resizes itself and slides what is below", () => {
		const result = plan(
			[card("tool-t1", 100, 167, true), body("m-b2", 275, 40)],
			[card("tool-t1", 100, 41, false), body("m-b2", 149, 40)],
		);
		expect(result.rows).toEqual([
			{ key: "tool-t1", kind: "resize", fromHeight: 167, toHeight: 41 },
			{ key: "m-b2", kind: "shift", fromOffset: 126 },
		]);
	});

	it("does nothing when only CONTENT grew (a running command's output)", () => {
		// Same open card, taller: new stdout. Must stay instant, or the list would
		// animate every delta.
		const result = plan(
			[card("tool-t1", 100, 120, true), body("m-b2", 228, 40)],
			[card("tool-t1", 100, 167, true), body("m-b2", 275, 40)],
		);
		expect(result.rows).toEqual([]);
	});

	it("reveals a reserved permission form when the request lands", () => {
		const result = plan([card("tool-t1", 100, 89, true)], [card("tool-t1", 100, 205, true, 116)]);
		expect(result.rows).toEqual([{ key: "tool-t1", kind: "reveal", fromInsetBottom: 116 }]);
	});

	it("keeps a reserved form's height correction instant (content, not shape)", () => {
		// The painted height replacing the prediction, or the reader typing a second line
		// of feedback, changes the reserve's size only — that must not animate.
		const result = plan(
			[card("tool-t1", 100, 205, true, 116), body("m-b2", 313, 40)],
			[card("tool-t1", 100, 238, true, 149), body("m-b2", 346, 40)],
		);
		expect(result.rows).toEqual([]);
	});

	it("pairs a reasoning card across the hand-off by its lifecycle id, not its key", () => {
		const reasoning = (key: string, height: number, form: string) => ({
			key,
			kind: "reasoning",
			lifecycleId: "blk:rs-1",
			top: 100,
			height,
			measured: { form },
		});
		const result = plan(
			[reasoning("__streaming__-b0", 69, "expanded")],
			[reasoning("a1-b0", 21, "collapsed"), body("__streaming__-b0", 125, 20, "blk:tx-1")],
		);
		// Resolved against the node committed NOW (the persisted key).
		expect(result.rows).toEqual([{ key: "a1-b0", kind: "resize", fromHeight: 69, toHeight: 21 }]);
	});

	it("never pairs two different kinds that share a key", () => {
		// The trap: after the hand-off the live TEXT inherits the streaming key the
		// reasoning held. Without a lifecycle id, key pairing alone would match them.
		const result = plan(
			[
				{
					key: "__streaming__-b0",
					kind: "reasoning",
					top: 100,
					height: 69,
					measured: { form: "expanded" },
				},
			],
			[body("__streaming__-b0", 100, 20)],
		);
		expect(result.rows).toEqual([]);
	});

	it("drills an activity-trace row open and closed with its siblings following", () => {
		const trace = (drilled: boolean) => ({
			key: "activity-t:t1",
			kind: "activity-trace",
			top: 50,
			height: drilled ? 230 : 60,
			measured: {
				rows: [
					{ key: "tool-t0", top: 2, blockHeight: 18.8, cardMeasured: null },
					{
						key: "tool-t1",
						top: 20.8,
						blockHeight: drilled ? 190 : 18.8,
						cardMeasured: drilled ? {} : null,
					},
					{ key: "tool-t2", top: drilled ? 210.8 : 39.6, blockHeight: 18.8, cardMeasured: null },
				],
			},
		});
		const open = plan([trace(false)], [trace(true)]);
		expect(open.nestedResizes).toEqual([
			{ traceKey: "activity-t:t1", rowKey: "tool-t1", kind: "reveal", fromInsetBottom: 190 - 18.8 },
		]);
		expect(open.nestedMotions.map((m) => m.rowKey)).toEqual(["tool-t2"]);
		expect(open.rows).toEqual([{ key: "activity-t:t1", kind: "reveal", fromInsetBottom: 170 }]);

		const close = plan([trace(true)], [trace(false)]);
		expect(close.nestedResizes).toEqual([
			{
				traceKey: "activity-t:t1",
				rowKey: "tool-t1",
				kind: "resize",
				fromHeight: 190,
				toHeight: 18.8,
			},
		]);
	});

	it("ignores an element present in only one frame", () => {
		expect(plan([], [card("tool-t1", 100, 89, true)]).rows).toEqual([]);
		expect(plan([card("tool-t1", 100, 89, true)], []).rows).toEqual([]);
	});

	it("measures displacement in viewport space (an anchored rebuild shows no shift)", () => {
		// The anchor absorbed the card's 126px shrink into scrollTop: nothing below moved
		// on screen, so nothing below should animate.
		const result = plan(
			[card("tool-t1", 100, 167, true), body("m-b2", 275, 40)],
			[card("tool-t1", 100, 41, false), body("m-b2", 149, 40)],
			[500, 374],
		);
		// (The card itself DID move on screen — pinned to the bottom, the shrink pulled it
		// down — so it may shift; the row below it stayed put and must not.)
		expect(result.rows.filter((m) => m.kind === "shift" && m.key === "m-b2")).toEqual([]);
	});
});

describe("planFoldMotion toggledKeys", () => {
	it("gives the same plan as a single toggledKey", () => {
		const before = new Map([
			["a", { top: 0, height: 40 }],
			["b", { top: 44, height: 20 }],
		]);
		const after = new Map([
			["a", { top: 0, height: 140 }],
			["b", { top: 144, height: 20 }],
		]);
		const single = planFoldMotion({
			before,
			after,
			toggledKey: "a",
			beforeScrollTop: 0,
			afterScrollTop: 0,
		});
		const set = planFoldMotion({
			before,
			after,
			toggledKeys: new Set(["a"]),
			beforeScrollTop: 0,
			afterScrollTop: 0,
		});
		expect(set).toEqual(single);
	});
});
