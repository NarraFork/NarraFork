/**
 * vlist-drill-morph-wiring.test.ts — Source-level guard for the drill-down header
 * morph's shell wiring.
 *
 * The pure planner (`vlist-drill-morph`) and the WAAPI edge
 * (`vlist-drill-morph-motion`) are covered by their own unit tests. What neither can
 * see is WHERE the two halves are wired into the shell, and that is where every
 * failure mode of this feature has lived:
 *
 *  - a single-slot capture that one toggle overwrites with the next (drops stacked
 *    activity);
 *  - a `getBoundingClientRect` read against the wrong coordinate frame (the
 *    "completely wrong position" bug);
 *  - a detached ghost node re-homed with `position:fixed` that outlived its
 *    animation and covered the rows above (the "rows vanished" bug);
 *  - a trace-level querySelector returning the FIRST row's line instead of the
 *    toggled one (the "animation applied to the row above" bug).
 *
 * These are assertions on the shell source because those failures are silent: the
 * morph still runs, just on the wrong node or at the wrong offset, and no unit test
 * on the pure functions would notice.
 */

import { describe, expect, it } from "bun:test";
import { shellModule, shellSource } from "./guard-source";

/**
 * The shell's whole module set. These rules are "this pattern exists NOWHERE in the
 * shell", so they must see every module it was split into — a forbidden ref that moved
 * to a sibling would otherwise satisfy the rule while reintroducing the very split
 * lifetime this consolidation removed, and nothing would go red.
 */
const SHELL = shellSource();

/** The body of the shell's drill-morph layout effect. */
function morphEffect(): string {
	// Slice from the SHELL ENTRY module, not the concatenated source: the LOD morph
	// effect further down the same file also uses `drillScope` / `motionRef.flush`,
	// and a two-tab closer never matches this effect's three-tab indent — so the
	// old `indexOf("\n\t\t});"` ran on into that later effect and made every negative
	// assertion fail on code that is not part of the drill morph path.
	const entry = shellModule("PretextExactMessageList.tsx");
	const buildIdx = entry.indexOf("buildDrillSnapshots(");
	expect(buildIdx).toBeGreaterThan(0);
	const end = entry.indexOf("drillScope(", buildIdx);
	expect(end).toBeGreaterThan(buildIdx);
	// End at the NEXT effect's banner comment (LOD morph), which sits immediately
	// after this effect's closing brace — more stable than counting indent tabs.
	const close = entry.indexOf("Play LOD-switch morphs", end);
	expect(close).toBeGreaterThan(end);
	return entry.slice(buildIdx, close);
}

describe("drill morph: diff-driven, not a click capture", () => {
	it("drives morphs off buildDrillSnapshots + diffDrillSnapshots, not a toggle-time capture", () => {
		// The whole point of the redo: the morph is derived from a before/after row
		// diff, so stacked activity (many rows flipping in one frame) is native.
		expect(SHELL).toContain("buildDrillSnapshots(");
		expect(SHELL).toContain("diffDrillSnapshots(");
		// Played through the shared scheduler, under this feature's own cancel scope.
		expect(SHELL).toContain("drillScope(");
	});

	it("has NO single-slot morph capture ref (the overwrite bug)", () => {
		expect(SHELL).not.toContain("headerMorphCaptureRef");
		expect(SHELL).not.toContain("planHeaderMorph(");
	});

	it("does NOT capture anything inside onToggleRow (state flip only)", () => {
		const start = SHELL.indexOf("onToggleRow: (rowIndex: number, rowKey?: string)");
		expect(start).toBeGreaterThan(0);
		const end = SHELL.indexOf("onToggleTranslation", start);
		const block = SHELL.slice(start, end);
		expect(block).not.toContain("Capture");
		expect(block).not.toContain("drillHeader");
	});
});

describe("drill morph: no DOM measurement, no detached ghost", () => {
	it("never reads getBoundingClientRect anywhere in the morph path", () => {
		expect(morphEffect()).not.toContain("getBoundingClientRect");
	});

	it("never re-homes a node (no appendChild onto the viewport, no position:fixed ghost)", () => {
		const effect = morphEffect();
		expect(effect).not.toContain("appendChild");
		expect(effect).not.toContain('position = "fixed"');
		expect(effect).not.toContain("position:fixed");
	});

	it("never removes a node (nothing detached to clean up)", () => {
		expect(morphEffect()).not.toContain(".remove(");
	});
});

describe("drill morph: per-row targeting (the row-above bug)", () => {
	it("resolves the animated node INSIDE the toggled row via data-nf-trace-row", () => {
		const effect = morphEffect();
		// A trace-level query returns the first row's line; the resolver MUST narrow to
		// the toggled row first, then to its header.
		expect(effect).toContain("data-nf-row-key");
		expect(effect).toContain("data-nf-trace-row");
		expect(effect).toContain("data-nf-card-header");
	});

	/**
	 * The CARD's header is the target in BOTH directions.
	 *
	 * The summary row is unusable on collapse: the card is retained for the duration of
	 * the close (see closingRowKeys), so `[data-nf-trace-titlerow]` is not rendered and the
	 * resolver returned null — the header the reader was looking at then jumped with no
	 * transition. Selecting on the plan's `kind` here is what reintroduced that.
	 */
	it("never targets the summary title row, which is absent during a close", () => {
		expect(morphEffect()).not.toContain("data-nf-trace-titlerow");
	});

	/**
	 * A COLLAPSE must hold its end state; an EXPAND must not.
	 *
	 * The collapsing card is unmounted by the same event that ends its morph (both 200ms),
	 * so `fill: "none"` dropped the transform on the final frame and the header snapped
	 * back for one frame before React removed it. An expand's node survives, and a
	 * retained transform there is exactly the residue `fill: "none"` prevents.
	 */
	it("holds the end state for a collapse only", () => {
		expect(morphEffect()).toContain('holdEndState: plan.kind === "collapse"');
	});

	it("splits rowUid into traceKey + rowKey for the two-level lookup", () => {
		expect(morphEffect()).toContain('indexOf("::")');
	});
});

describe("drill morph: revision gate + snapshot roll", () => {
	it("only morphs across an unchanged document revision", () => {
		expect(morphEffect()).toContain("revisionUnchanged");
	});

	it("rolls the snapshot forward even when it skips playing (clean next baseline)", () => {
		const effect = morphEffect();
		// The snapshot assignment must happen BEFORE the revision/reduced-motion early
		// return, or the next diff compares against a stale baseline.
		const assign = effect.indexOf("drillMorphPrevRef.current = next");
		const earlyReturn = effect.indexOf("if (!revisionUnchanged");
		expect(assign).toBeGreaterThan(0);
		expect(earlyReturn).toBeGreaterThan(assign);
	});

	it("honours prefers-reduced-motion (skips playing, still rolls the snapshot)", () => {
		expect(morphEffect()).toContain("prefersReducedMotion()");
	});
});

/**
 * The morph and the fold remain SEPARATE PLANNERS on different nodes — but they are no
 * longer separate animation lifetimes, and that change is the point.
 *
 * `onToggleRow` captures a fold AND flips a trace row's drill state in one click, so
 * these two always play in the same frame. While each owned its own controller their
 * cancel boundaries were independent: re-toggling cancelled the fold's half wholesale
 * (that controller cancelled everything it had started) while this half kept running to
 * a different finish time, so one visual event visibly came apart. Both now push into
 * the shared scheduler, which cancels by scope.
 */
describe("drill morph: shares the fold's frame, keeps its own planner", () => {
	it("plans independently of the fold (no shared planner, no clip-path)", () => {
		expect(morphEffect()).not.toContain("planFoldMotion");
		expect(morphEffect()).not.toContain("clipPath");
	});

	it("plays through the same scheduler as the fold, under a distinct scope", () => {
		// One owner of every handle, so one visual event has one cancel boundary.
		expect(SHELL).toContain("motionRef.current.push(");
		expect(SHELL).toContain("drillScope(");
		expect(SHELL).toContain("rowScope(");
		// The per-feature controllers are gone; a reintroduced one would restore the
		// split lifetimes this consolidation removed.
		expect(SHELL).not.toContain("createDrillMorphController");
		expect(SHELL).not.toContain("drillMorphRef");
		expect(SHELL).not.toContain("createFoldMotionController");
	});

	it("joins the open batch rather than starting its own", () => {
		// `begin()` is idempotent within a commit: the first motion effect opens the
		// batch and the rest join it. A flush of its own here would put this half a
		// frame apart from the fold's.
		const effect = morphEffect();
		expect(effect).toContain("motionRef.current.begin()");
		expect(effect).not.toContain("motionRef.current.flush()");
	});
});

/**
 * The tail and border fades must resolve REAL marked nodes.
 *
 * A fade aimed at a node that does not exist is silent: nothing animates, nothing throws,
 * and the transition simply looks unfinished. So the markers are asserted on both sides —
 * the selector in the wiring, and the attribute in the renderer.
 */
describe("drill fades — markers exist on both sides", () => {
	const wiring = () => morphEffect();

	it("gives the tail and the border their OWN scopes", () => {
		// Separate scopes let an interrupted transition replace each independently of the
		// header's travel; sharing one would make a re-click cancel the wrong motion.
		expect(wiring()).toContain(":tail`");
		expect(wiring()).toContain(":border`");
	});

	it("targets the marked tail wrapper and card surface", () => {
		expect(wiring()).toContain("[data-nf-card-tail]");
		expect(wiring()).toContain("[data-nf-card-surface]");
	});

	it("renders those markers in RenderToolCall", async () => {
		const src = await Bun.file(
			new URL("./render/RenderToolCall.tsx", import.meta.url).pathname,
		).text();
		expect(src).toContain("data-nf-card-tail");
		expect(src).toContain("data-nf-card-surface");
	});

	it("keeps the tail wrapper a real box, since opacity needs one", () => {
		// `display: contents` generates NO box, and opacity on a box-less element does
		// nothing — the fade would never appear.
		const src = Bun.file(new URL("./render/RenderToolCall.tsx", import.meta.url).pathname);
		return src.text().then((text) => {
			const i = text.indexOf("data-nf-card-tail");
			const window = text.slice(i, i + 400);
			expect(window).toContain("inline-flex");
			expect(window).not.toContain("contents");
		});
	});

	it("holds the end state on collapse for the fades too", () => {
		// Their nodes are unmounted by the event that ends them, exactly like the header's.
		const text = wiring();
		const tailIdx = text.indexOf(":tail`");
		expect(text.slice(tailIdx, tailIdx + 700)).toContain('holdEndState: plan.kind === "collapse"');
	});
});
