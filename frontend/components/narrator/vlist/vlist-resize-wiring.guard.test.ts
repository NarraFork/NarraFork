/**
 * vlist-resize-wiring.guard.test.ts — Source-level guard on the resize handler.
 *
 * The behavioural test (`vlist-drag-freeze.test.tsx`) exercises a REPRODUCTION of
 * the handler, so it cannot notice if the real one drifts from it. That is exactly
 * how the height write escaped three rounds of fixes: every pure-function test
 * passed while the shell kept re-rendering 1601 DOM nodes per drag frame.
 *
 * So the wiring itself is asserted here: the height write must be gated, and the
 * gate must be the drag suppression.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shellModule } from "./guard-source";

const SHELL = join(import.meta.dir, "PretextExactMessageList.tsx");

function shell(): string {
	return readFileSync(SHELL, "utf8");
}

/**
 * The row component's own module, which owns the memo comparator asserted on below.
 *
 * Read separately from the shell (rather than through the concatenated module set)
 * because the comparator is located by cutting from `const ExactRow = memo(` to the
 * next `\n);` — sentinels that a concatenated source could satisfy from a different
 * module, silently moving the window off its subject.
 */
function row(): string {
	return shellModule("ExactRow.tsx");
}

/**
 * The body of the width/height ResizeObserver effect.
 *
 * Anchored on the effect's FIRST statement (`const node = viewportNode;`) rather than
 * on the `settleTimer` declaration below it. Anchoring on the latter silently excluded
 * the lines above it, so the "node comes from state" assertion looked outside its own
 * subject and failed even though the wiring was correct.
 */
function resizeEffect(source: string): string {
	const start = source.indexOf("const node = viewportNode;");
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf("const hasTailFooter", start);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe("resize handler wiring", () => {
	it("gates the viewport-height write behind the drag suppression", () => {
		const effect = resizeEffect(shell());
		// The ONLY per-frame height write must be guarded.
		expect(effect).toMatch(/if\s*\(\s*!suppressHeightWrite\(\)\s*\)\s*setViewportHeight\(/);
		// An unguarded per-frame write would re-render every mounted row.
		expect(effect).not.toMatch(/^\s*setViewportHeight\(node\.clientHeight\);\s*$/m);
	});

	it("defines the suppression from BOTH the deferral and the live pointer", () => {
		const effect = resizeEffect(shell());
		expect(effect).toMatch(
			/const\s+suppressHeightWrite\s*=\s*\(\)\s*=>\s*deferred\s*&&\s*pointerTracker\.isDown\(\)/,
		);
	});

	it("releases the withheld height inside the commit branch", () => {
		const effect = resizeEffect(shell());
		const commitIndex = effect.indexOf("if (decision.commit) {");
		expect(commitIndex).toBeGreaterThan(-1);
		const branch = effect.slice(commitIndex, effect.indexOf("return;", commitIndex));
		expect(branch).toMatch(/if\s*\(\s*deferred\s*\)\s*setViewportHeight\(/);
		expect(branch).toContain("setContentWidth(");
	});

	it("keeps exactly one height write per commit and one per observer frame", () => {
		const effect = resizeEffect(shell());
		const writes = effect.match(/setViewportHeight\(/g) ?? [];
		// One in the commit branch, one (guarded) in the observer callback.
		expect(writes.length).toBe(2);
	});

	it("guard self-check: the effect body is located and non-trivial", () => {
		const effect = resizeEffect(shell());
		expect(effect.length).toBeGreaterThan(500);
		expect(effect).toContain("ResizeObserver");
	});

	// The observed node must be an effect DEPENDENCY, not a ref read at mount.
	//
	// `assignViewport` is rebuilt whenever the host's `scrollRef` prop changes
	// identity (an inline arrow does that on every host render), and React answers a
	// changed ref callback by detaching with null then re-attaching the node. An
	// effect that merely read `viewportRef.current` does NOT re-run, so the observer
	// keeps watching a node that is no longer in the document: no further callback
	// arrives, the width freezes at the last committed value, and the pointer-release
	// path re-reads the same stale node so `resolveWidthSettle` answers NO_ACTION.
	//
	// A source guard, because the failure is structural: every pure-function test and
	// every "is the observer wired" assertion passes either way.
	it("observes the viewport node as a dependency, not a mount-time ref read", () => {
		const source = shell();
		const effect = resizeEffect(source);
		// The node comes from state...
		expect(effect).toMatch(/const\s+node\s*=\s*viewportNode\s*;/);
		expect(effect).not.toMatch(/const\s+node\s*=\s*viewportRef\.current\s*;/);
		// ...and the effect's dependency list names it, so a replaced node rebuilds
		// the observer.
		const depsIndex = source.indexOf("}, [viewportNode, centeredColumn]);");
		expect(depsIndex).toBeGreaterThan(-1);
	});

	it("mirrors the viewport node into state from the ref callback", () => {
		const source = shell();
		const assign = source.slice(
			source.indexOf("const assignViewport = useCallback("),
			source.indexOf("const assignContent = useCallback("),
		);
		expect(assign.length).toBeGreaterThan(100);
		// Both writes: the ref (read synchronously by scroll handlers) and the state
		// (the observer's dependency). Dropping either reopens the freeze.
		expect(assign).toContain("viewportRef.current = node;");
		expect(assign).toContain("setViewportNode(node);");
	});
});

/**
 * The row memo must compare RENDER identity, not the disposable wrapper.
 *
 * `items[i] = { spec, measured }` is freshly allocated by every layout build, so
 * comparing `prev.item === next.item` made the memo miss on every rebuild even when
 * the row's content was byte-identical (measured: on a height-only rebuild 300/300
 * `measured` objects are the same object, yet all 1601 spans of a 20-row window were
 * rebuilt — 40 wasted row renders across two rebuilds, versus 0 with the relaxed
 * comparator).
 */
describe("ExactRow memo identity", () => {
	/**
	 * The comparator's CODE, with comments stripped.
	 *
	 * Stripping matters: the comment explaining why `prev.item === next.item` was
	 * removed contains that very expression, so a naive scan finds it and the
	 * "wrapper comparison is gone" assertion fails on its own documentation.
	 */
	function comparator(source: string): string {
		const start = source.indexOf("\t(prev, next) =>");
		expect(start).toBeGreaterThan(-1);
		const end = source.indexOf("\n);", start);
		expect(end).toBeGreaterThan(start);
		return source
			.slice(start, end)
			.replace(/\/\*[\s\S]*?\*\//g, " ")
			.replace(/\/\/[^\n]*/g, " ");
	}

	it("compares measured + spec identity rather than the item wrapper", () => {
		const cmp = comparator(row());
		expect(cmp).toContain("prev.item.measured === next.item.measured");
		expect(cmp).toContain("prev.item.spec.key === next.item.spec.key");
		expect(cmp).toContain("prev.item.spec.kind === next.item.spec.kind");
		// The wrapper comparison must be gone: it can never be true after a rebuild.
		expect(cmp).not.toMatch(/prev\.item\s*===\s*next\.item/);
	});

	// Everything the row paints from `spec` must be compared, or a change would not
	// reach the DOM. Today that is `key` and `unitId` (`data-nf-unit`).
	//
	// `data` is exempt: it is measured INTO `measured` (the comparator's first
	// clause), so a different `data` already yields a different `measured` object
	// and never needs its own comparison — see ExactRow's comparator comment and
	// measure-cache.extractDataRevision. Reads of `spec.data.*` in the row body are
	// for interaction callbacks (e.g. the reply-quote jump target), not paint.
	it("compares every spec field the row renders", () => {
		const source = row();
		const rowBody = source.slice(
			source.indexOf("const ExactRow = memo("),
			source.indexOf("\t(prev, next) =>"),
		);
		const readFields = new Set(
			[...rowBody.matchAll(/item\.spec\.([a-zA-Z]+)/g)].map((match) => match[1]),
		);
		readFields.delete("data");
		expect(readFields.size).toBeGreaterThan(0);
		const cmp = comparator(source);
		for (const field of readFields) {
			expect(cmp).toContain(`prev.item.spec.${field} === next.item.spec.${field}`);
		}
	});
});
