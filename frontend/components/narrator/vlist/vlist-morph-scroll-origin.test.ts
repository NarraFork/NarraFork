import { describe, expect, test } from "bun:test";
import { shellModule } from "./guard-source";
import { sliceBracketedRegion } from "./source-slice";
import {
	buildDrillSnapshots,
	type DrillTraceSource,
	diffDrillSnapshots,
} from "./vlist-drill-morph";
import { buildLodSnapshots, diffLodSnapshots } from "./vlist-lod-morph";
import {
	createVListMorphScrollOrigin,
	type MorphScrollGeometry,
} from "./vlist-morph-scroll-origin";

function geometry(): MorphScrollGeometry {
	return {
		narratorId: "n1",
		viewport: {},
		items: [],
		layout: {},
		viewportHeight: 600,
		footerHeight: 0,
		footer: null,
	};
}

const forbiddenRead = () => {
	throw new Error("A classified, unchanged scroll frame must not reread DOM geometry");
};

describe("animation scroll-origin sample", () => {
	test("initial commits retain the live fallback", () => {
		const origin = createVListMorphScrollOrigin();
		let reads = 0;
		expect(
			origin.read(geometry(), () => {
				reads++;
				return 321;
			}),
		).toBe(321);
		expect(reads).toBe(1);
	});

	test("all animation channels reuse the classified native position without DOM reads", () => {
		const origin = createVListMorphScrollOrigin();
		const frame = geometry();
		origin.record(frame, 1024.5);
		for (let channel = 0; channel < 4; channel++) {
			expect(origin.read({ ...frame }, forbiddenRead)).toBe(1024.5);
		}
	});

	test("rolling samples follow in-window movement even without a React state update", () => {
		const origin = createVListMorphScrollOrigin();
		const frame = geometry();
		for (const top of [1000, 1080, 1160, 1120, 0]) {
			origin.record(frame, top);
			expect(origin.read(frame, forbiddenRead)).toBe(top);
		}
	});

	for (const [name, change] of [
		["narrator", { narratorId: "n2" }],
		["viewport replacement", { viewport: {} }],
		["semantic messages or measured items", { items: [] }],
		["layout or height overrides", { layout: {} }],
		["viewport height", { viewportHeight: 500 }],
		["footer height", { footerHeight: 60 }],
		["footer element before observer measurement", { footer: {} }],
	] as const) {
		test(`${name} changes cannot reuse an older position`, () => {
			const origin = createVListMorphScrollOrigin();
			const frame = geometry();
			origin.record(frame, 1000);
			let reads = 0;
			expect(
				origin.read({ ...frame, ...change }, () => {
					reads++;
					return 900;
				}),
			).toBe(900);
			expect(reads).toBe(1);
		});
	}

	for (const event of [
		"pending native scroll",
		"programmatic write",
		"resize observation",
		"viewport parking/replacement",
	]) {
		test(`${event} invalidation preserves the live fallback until resampled`, () => {
			const origin = createVListMorphScrollOrigin();
			const frame = geometry();
			origin.record(frame, 1000);
			origin.invalidate();
			expect(origin.read(frame, () => 750)).toBe(750);
			origin.record(frame, 750);
			expect(origin.read(frame, forbiddenRead)).toBe(750);
		});
	}

	test("two viewports have independent samples", () => {
		const left = createVListMorphScrollOrigin();
		const right = createVListMorphScrollOrigin();
		const frame = geometry();
		left.record(frame, 1000);
		right.record(frame, 2000);
		left.invalidate();
		expect(left.read(frame, () => 50)).toBe(50);
		expect(right.read(frame, forbiddenRead)).toBe(2000);
	});

	test("keeps only the newest sample, not a history of owner geometries", () => {
		const origin = createVListMorphScrollOrigin();
		const old = geometry();
		const next = geometry();
		origin.record(old, 10);
		origin.record(next, 20);
		expect(origin.read(old, () => 30)).toBe(30);
		expect(origin.read(next, forbiddenRead)).toBe(20);
	});

	test("nonfinite samples discard the previous sample", () => {
		const origin = createVListMorphScrollOrigin();
		const frame = geometry();
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			origin.record(frame, 10);
			origin.record(frame, value);
			expect(origin.read(frame, () => 30)).toBe(30);
		}
	});
});

describe("animation baseline roll-forward remains live", () => {
	test("a drill after scrolling uses the last committed viewport origin for all flipped rows", () => {
		const origin = createVListMorphScrollOrigin();
		const frame = geometry();
		const folded: DrillTraceSource[] = [
			{
				traceKey: "trace",
				top: 1200,
				rows: [0, 1].map((i) => ({
					key: `r${i}`,
					top: i * 100,
					drilled: false,
					rowHeight: 20,
					blockHeight: 100,
					drillHeader: null,
				})),
			},
		];
		origin.record(frame, 800);
		buildDrillSnapshots(folded, origin.read(frame, forbiddenRead));
		origin.record(frame, 1000);
		const before = buildDrillSnapshots(folded, origin.read(frame, forbiddenRead));
		const unfolded = folded.map((trace) => ({
			...trace,
			rows: trace.rows.map((row) => ({
				...row,
				drilled: true,
				drillHeader: { top: 10, height: 30 },
			})),
		}));
		const changed = { ...frame, items: [], layout: {} };
		const after = buildDrillSnapshots(
			unfolded,
			origin.read(changed, () => 1000),
		);
		const plans = diffDrillSnapshots(before, after);
		expect(plans).toHaveLength(2);
		expect(plans.map((p) => p.driftY)).toEqual([15, 15]);
		expect(plans.every((p) => p.kind === "expand")).toBe(true);
	});

	test("scrolling before an LOD switch preserves the new window's latest baseline", () => {
		const origin = createVListMorphScrollOrigin();
		const frame = geometry();
		const elements = [{ unitId: "tool-t1", key: "t1", kind: "trace-row", top: 2000, height: 20 }];
		origin.record(frame, 0);
		expect(buildLodSnapshots(elements, origin.read(frame, forbiddenRead), 600).size).toBe(0);
		origin.record(frame, 1800);
		const before = buildLodSnapshots(elements, origin.read(frame, forbiddenRead), 600);
		const switched = { ...frame, items: [], layout: {} };
		const after = buildLodSnapshots(
			[{ ...elements[0], kind: "tool-call", top: 2050, height: 200 }],
			origin.read(switched, () => 1800),
			600,
		);
		expect(diffLodSnapshots(before, after)).toHaveLength(1);
		expect(diffLodSnapshots(before, after)[0]?.fade).toBe(true);
	});

	test("pinned correction/clamping invalidates the cached origin before a collapse", () => {
		const origin = createVListMorphScrollOrigin();
		const frame = geometry();
		origin.record(frame, 1800);
		origin.invalidate();
		expect(origin.read(frame, () => 1200)).toBe(1200);
	});
});

// These are host-wiring invariants, not substitutes for the behavioral tests above.
// Removing a native invalidation or the record call must not leave those tests green.
describe("production animation-origin wiring", () => {
	const source = shellModule("PretextExactMessageList.tsx");
	const region = (anchor: string) => {
		const result = sliceBracketedRegion(source, anchor);
		if (!result) throw new Error(`Missing host region: ${anchor}`);
		return result;
	};
	const before = (text: string, a: string, b: string) => {
		expect(text.indexOf(a)).toBeGreaterThanOrEqual(0);
		expect(text.indexOf(b)).toBeGreaterThan(text.indexOf(a));
	};

	test("samples settled native geometry before the window-state update", () => {
		const frame = region("const processScrollFrame = useCallback(");
		before(frame, "const nextTop = node.scrollTop", "morphScrollOrigin.record(");
		before(frame, "const settledTop = scrollTopRef.current", "morphScrollOrigin.record(");
		before(frame, "morphScrollOrigin.record(", "setScrollTop(settledTop)");
		expect(frame).toContain("resizeControllerRef.current?.isPending() !== true");
		expect(frame).toContain("liveViewportHeight === viewportHeightRef.current");
		expect(frame).toContain("Math.abs(settledTop - previousTop) > liveViewportHeight");
		expect(frame).toContain("items: renderItemsRef.current");
		expect(frame).toContain("footer: tailFooter");
	});

	for (const [anchor, guard] of [
		["const onScroll = useCallback(", "if (scrollRafRef.current) return"],
		["const writeScrollTopCore = useCallback(", "const node = viewportRef.current"],
		["const assignViewport = useCallback(", "viewportRef.current = node"],
	] as const) {
		test(`${anchor} invalidates before its early return/write`, () => {
			before(region(anchor), "morphScrollOrigin.invalidate()", guard);
		});
	}

	test("viewport and footer observers invalidate before visibility or size reads", () => {
		const resize = source.slice(
			source.indexOf("const controller = createVListResizeController("),
			source.indexOf("// A capped column"),
		);
		const footer = source.slice(
			source.indexOf("const hasTailFooter ="),
			source.indexOf("const scrollGeometryRevision ="),
		);
		for (const part of [resize, footer]) {
			const measure = sliceBracketedRegion(part, "const measure = () => {");
			if (!measure) throw new Error("Missing observer callback");
			before(
				measure,
				"morphScrollOrigin.invalidate()",
				"if (!visibleViewportRef.current.isVisible(",
			);
		}
	});

	test("all three baselines still roll before their play gates", () => {
		expect(source).toContain("buildDrillSnapshots(traces, readMorphScrollTop())");
		const lod = source.slice(
			source.indexOf("Play LOD-switch morphs"),
			source.indexOf("const pendingClosing = pendingLifecycleClosingRef.current"),
		);
		expect(lod).toContain("const scrollTop = readMorphScrollTop()");
		before(lod, "lodMorphPrevRef.current = next", "if (!isLodSwitch");
		before(source, "drillMorphPrevRef.current = next", "if (!revisionUnchanged");
		const life = source.slice(
			source.indexOf("const next = buildLifecycleSnapshot(sources)"),
			source.indexOf(
				"const ops: MotionOp[] = []",
				source.indexOf("const next = buildLifecycleSnapshot(sources)"),
			),
		);
		expect(life).toContain("scrollTop: readMorphScrollTop()");
		before(life, "lifecyclePrevContextRef.current = context", "!prevContext");
		before(
			life,
			"smoothFollowerRef.current?.snapToTarget()",
			"const afterScrollTop = pinnedToBottom",
		);
		expect(life).toMatch(
			/const afterScrollTop = pinnedToBottom\s*\?\s*getScrollBottomTarget\(node\)\s*:\s*readMorphScrollTop\(\)/,
		);
	});

	test("live fallback retains every viewport geometry discriminator", () => {
		const read = region("const readMorphScrollTop = useCallback(");
		for (const field of [
			"narratorId",
			"viewport: node",
			"items: renderItemsRef.current",
			"layout",
			"viewportHeight: viewportHeightRef.current",
			"footerHeight: footerHeightRef.current",
			"footer: tailFooter",
			"() => node.scrollTop",
		])
			expect(read).toContain(field);
	});
});
