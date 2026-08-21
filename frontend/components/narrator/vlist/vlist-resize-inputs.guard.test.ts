/**
 * vlist-resize-inputs.guard.test.ts — Nothing may reach the layout build at pixel
 * resolution during a resize.
 *
 * This guard exists because the same bug shipped twice under two different
 * explanations. The width path was gated (deferred behind the pointer), but
 * `viewportHeight` was ALSO a build option and ALSO a dependency of the rebuild
 * effect — and a sash drag changes both dimensions, so every frame of height change
 * re-measured the whole document and the width gate did nothing. Counted against
 * the real coordinator over an 80-frame drag at 4000 messages:
 *
 *     height raw       → 80 rebuilds, 1267ms
 *     height bucketed  →  2 rebuilds,   35ms
 *
 * The failure is invisible to unit tests on the pure helpers (they all pass either
 * way) and to a rendering test (which cannot tell a fast rebuild from a skipped
 * one). It is a WIRING property, so it is asserted on the wiring.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sliceBracketedRegion } from "./source-slice";

const VLIST_DIR = import.meta.dir;

function read(relativePath: string): string {
	return readFileSync(join(VLIST_DIR, relativePath), "utf8");
}

/**
 * The `usePretextDocument({...})` call's option object in the shell.
 *
 * Brace-matched, NOT cut at a hardcoded `"\n\t});"`: that sentinel assumed the
 * call sits at one tab of indentation, so re-indenting the shell made this guard
 * fail for a reason that has nothing to do with viewport buckets (see
 * source-slice.ts).
 */
function documentHookOptions(source: string): string {
	const region = sliceBracketedRegion(source, "usePretextDocument(narratorId, {");
	if (region === null) throw new Error("usePretextDocument(narratorId, { … }) call not found");
	return region;
}

describe("resize inputs cannot reach the layout at pixel resolution", () => {
	it("passes a BUCKETED viewport height to the document hook, never the raw state", () => {
		const options = documentHookOptions(read("PretextExactMessageList.tsx"));
		// The bucketed value must be what is handed over...
		expect(options).toMatch(/viewportHeight:\s*layoutViewportHeight/);
		// ...and the raw state variable must not be, in any shorthand or explicit form.
		expect(options).not.toMatch(/viewportHeight:\s*viewportHeight\b/);
		expect(options).not.toMatch(/^\s*viewportHeight,\s*$/m);
	});

	it("derives the layout height through bucketViewportHeight", () => {
		const source = read("PretextExactMessageList.tsx");
		expect(source).toMatch(
			/const\s+layoutViewportHeight\s*=\s*bucketViewportHeight\(\s*viewportHeight\s*\)/,
		);
	});

	// The exact height is still required for virtualization, anchoring and
	// bottom-pinning. If those started reading the bucketed value the mounted window
	// would be wrong by up to a bucket, so the raw state must remain in use.
	it("keeps using the EXACT height for the mounted window", () => {
		const source = read("PretextExactMessageList.tsx");
		expect(source).toMatch(/resolveVisibleWindow\(\s*exactLayout,\s*scrollTop,\s*viewportHeight/);
	});

	it("keeps using the EXACT height for scroll anchoring", () => {
		const source = read("PretextExactMessageList.tsx");
		// readCurrentView feeds captureCoordinatorAnchor.
		expect(source).toMatch(/viewportHeight:\s*node\?\.clientHeight\s*\?\?\s*viewportHeightRef/);
	});

	// A width write outside the settle decision would re-open the original bug.
	//
	// TWO writes are legitimate, and only two:
	//   1. the FIRST measurement, which is not a change but this list learning its
	//      width. Deferring it made the placeholder paint a frame at the sentinel
	//      geometry and jump 140ms later (the mount-time width step).
	//   2. the settle decision's commit branch, which owns every subsequent change.
	// Anything else — a raw write from an observer callback, an effect, a prop — is
	// what the gate exists to prevent, so each write is matched to one of the two
	// sanctioned guards rather than merely counted.
	it("commits contentWidth only from the first measurement or the settle decision", () => {
		const source = read("PretextExactMessageList.tsx");
		const applyWidthIndex = source.indexOf("const applyWidth = (trigger: WidthSettleTrigger)");
		expect(applyWidthIndex).toBeGreaterThan(-1);
		const writes = [...source.matchAll(/setContentWidth\(/g)];
		expect(writes.length).toBe(2);
		for (const write of writes) {
			// Every write lives in the resize handler, never in a render path or effect.
			expect(write.index).toBeGreaterThan(applyWidthIndex);
			// Which branch a write sits in is decided by its NEAREST preceding guard, so
			// this needs no window constant to tune (and cannot pass merely because a
			// guard appears somewhere far above an ungated write).
			const before = source.slice(0, write.index);
			const sentinelAt = before.lastIndexOf("committedContentWidthRef.current === 0");
			const commitAt = before.lastIndexOf("decision.commit");
			expect(Math.max(sentinelAt, commitAt)).toBeGreaterThan(applyWidthIndex);
		}
		// And the two writes belong to DIFFERENT branches: one first-measurement, one
		// settled. Both landing in the same branch would mean a guard went missing.
		const nearestGuard = (index: number) => {
			const before = source.slice(0, index);
			return before.lastIndexOf("committedContentWidthRef.current === 0") >
				before.lastIndexOf("decision.commit")
				? "first-measurement"
				: "settled";
		};
		expect(writes.map((w) => nearestGuard(w.index)).sort()).toEqual([
			"first-measurement",
			"settled",
		]);
	});

	// The first-measurement fast path must stay SYNCHRONOUS with the layout effect's
	// own measure pass, or the sentinel geometry gets painted for a frame after all.
	it("commits the first measurement before consulting the settle decision", () => {
		const source = read("PretextExactMessageList.tsx");
		const effect = source.slice(source.indexOf("const applyWidth = (trigger: WidthSettleTrigger)"));
		const sentinelIndex = effect.indexOf("committedContentWidthRef.current === 0");
		const decisionIndex = effect.indexOf("resolveWidthSettle({");
		expect(sentinelIndex).toBeGreaterThan(-1);
		expect(decisionIndex).toBeGreaterThan(-1);
		expect(sentinelIndex).toBeLessThan(decisionIndex);
	});

	// The sentinel itself: a plausible starting width is what made the placeholder
	// paint an 860px centered column on every mount, whatever the reader's
	// preference. 0 cannot be mistaken for a measurement.
	it("starts from an unmeasured sentinel, not a plausible width", () => {
		const source = read("PretextExactMessageList.tsx");
		expect(source).toMatch(/const\s*\[contentWidth,\s*setContentWidth\]\s*=\s*useState\(0\)/);
		expect(source).toMatch(/const\s+committedContentWidthRef\s*=\s*useRef\(0\)/);
	});

	it("gates the resize handler through resolveWidthSettle", () => {
		const source = read("PretextExactMessageList.tsx");
		expect(source).toContain("resolveWidthSettle({");
		expect(source).toMatch(/pointerDown:\s*pointerTracker\.isDown\(\)/);
	});

	// The OUTER-BOX measurement, without which a gesture-free host resize (a dock panel
	// toggled from a button) is indistinguishable from scrollbar feedback — the ring
	// filled with the panel's two widths and pinned the column from the FIFTH toggle
	// onwards, permanently, because `gesture-end` was its only reset.
	//
	// A wiring guard because the pure-function tests pass either way: the exemption is
	// only reachable if the shell actually measures and threads both widths.
	it("threads the outer box width into the settle decision", () => {
		const source = read("PretextExactMessageList.tsx");
		const call = source.slice(
			source.indexOf("resolveWidthSettle({"),
			source.indexOf("});", source.indexOf("resolveWidthSettle({")),
		);
		expect(call).toMatch(/boxWidth[,:]/);
		expect(call).toMatch(/committedBoxWidth[,:]/);
		// Measured from the OUTER box. `clientWidth` excludes the scrollbar, so reading
		// it here would make feedback look like a host resize and release the guard on
		// exactly the loop it bounds.
		expect(source).toMatch(/const\s+boxWidth\s*=\s*node\.offsetWidth\s*;/);
	});

	// A host resize must also RESET the cycle history, not merely bypass the guard once:
	// leaving the alternation in the ring would pin the very next toggle instead.
	it("clears the cycle history on a host resize as well as a gesture", () => {
		const source = read("PretextExactMessageList.tsx");
		const effect = source.slice(source.indexOf("const applyWidth = (trigger: WidthSettleTrigger)"));
		const commitIndex = effect.indexOf("if (decision.commit) {");
		expect(commitIndex).toBeGreaterThan(-1);
		const branch = effect.slice(commitIndex, effect.indexOf("\t\t\treturn;", commitIndex));
		expect(branch).toMatch(/isExternalGeometryChange\(\s*boxWidth\s*,\s*committedBoxWidth\s*\)/);
		expect(branch).toMatch(/trigger\s*===\s*"gesture-end"\s*\|\|\s*externalGeometry/);
		// And the reference the next comparison reads must advance with the commit, or
		// every later frame would keep reporting the same resize as still external.
		expect(branch).toMatch(/committedBoxWidth\s*=\s*boxWidth\s*;/);
	});

	// INVERTED from an earlier version of this guard, which REQUIRED cost inputs.
	//
	// Two cost predictors were tried and both silently disabled the freeze:
	//   - `lastBuildMs > 12ms` timed the measurement pass only. A realistic window
	//     measures ~2ms, so every real session looked "cheap" and committed per frame
	//     while its ~1600 mounted DOM nodes were rebuilt on each one.
	//   - `mountedRowCount > 12` ignored that a row's cost varies ~30x with content
	//     (prose ~60 DOM units, code ~22, a one-line card ~2), so two panels either
	//     side of a splitter landed on opposite sides of the threshold — one froze, the
	//     other did not, which is exactly what the user saw.
	//
	// The decision now takes no cost input at all. This guard keeps one from creeping
	// back in, because the failure mode is silent: the gate still exists, still looks
	// wired, and simply never engages.
	it("passes NO cost estimate to the settle decision", () => {
		const source = read("PretextExactMessageList.tsx");
		const call = source.slice(
			source.indexOf("resolveWidthSettle({"),
			source.indexOf("});", source.indexOf("resolveWidthSettle({")),
		);
		expect(call.length).toBeGreaterThan(40);
		expect(call).not.toContain("lastBuildMs");
		expect(call).not.toContain("mountedRowCount");
		expect(call).not.toMatch(/Budget|budget|cost|Cost/);
		// Only the four inputs the decision actually takes (shorthand or explicit).
		for (const field of ["nextWidth", "committedWidth", "trigger", "pointerDown"]) {
			expect(call).toMatch(new RegExp(`${field}[,:]`));
		}
	});

	it("keeps no cost-tracking refs in the shell", () => {
		const source = read("PretextExactMessageList.tsx");
		expect(source).not.toContain("lastBuildMsRef");
		expect(source).not.toContain("mountedRowCountRef");
	});

	// Guard self-check: the extractor must actually find the option block, or every
	// assertion above would vacuously pass on an empty string.
	it("guard self-check: the option block is located and non-trivial", () => {
		const options = documentHookOptions(read("PretextExactMessageList.tsx"));
		expect(options.length).toBeGreaterThan(200);
		expect(options).toContain("contentWidth");
	});
});
