/**
 * zero-dom-measure.guard.test.ts — Enforces the persistent protected invariant:
 *   "After the migration, list-element heights never depend on DOM measurement;
 *    everything becomes a preparedBlock."
 *
 * Mechanism: the vlist MEASURE/LAYOUT path (the modules that turn data into
 * heights + geometry) must contain zero DOM-measurement API calls
 * (getBoundingClientRect / offset* / scroll* / client* / ResizeObserver /
 * getComputedStyle). Heights come only from pretext pure arithmetic + fixed
 * constants.
 *
 * Controlled exceptions (NOT scanned) — these are not the height model:
 *   - PretextMessageList.tsx: the scroll CONTAINER shell may read its own
 *     clientHeight/scrollTop + a viewport ResizeObserver (container sizing +
 *     scroll position, never per-element height).
 *   - render/*: the render layer positions pre-measured geometry; the single
 *     allowed local measurement is the PreparedUnknownBlock (mermaid/katex)
 *     refinement, out of scope for the pure height model.
 *   - VListHarness.tsx: dev-only calibration (the one place DOM measurement is
 *     intentional, to validate predictions).
 *   - *.test.ts / test-canvas-stub.ts: test scaffolding.
 *
 * This turns CONTRACT.md §0 rule 2 into a CI-enforced guard: if any pure-path
 * module reaches for a DOM measurement, this test goes red.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const VLIST_DIR = import.meta.dir;

/** The modules that MUST be pure (data → height/geometry), zero DOM. */
const PURE_PATH_FILES = [
	"prepared-block.ts",
	"pretext-fonts.ts",
	"parse-markdown.ts",
	"segment-adapter.ts",
	"registry.ts",
	"vlist-tail-meta.ts",
	"vlist-selection.ts",
	"vlist-lod-gesture.ts",
	"vlist-virtualization.ts",
	"vlist-pipeline.ts",
	"vlist-permission-match.ts",
	"vlist-reflection-index.ts",
	"vlist-interaction-state.ts",
	// Live lifecycle patching: rewrites the loaded document, then a rebuild derives
	// the new heights arithmetically. Reaching for a real element's size here would
	// make a server event (not a user action) the source of a measured height.
	"vlist-live-patch.ts",
	"vlist-live-events.ts",
	// Pure decisions consumed by the shell (streaming hand-off, reload
	// classification) and the incremental streaming markdown preparation.
	"streaming-handoff.ts",
	"streaming-block-cache.ts",
	"vlist-reload-policy.ts",
	// Content-viewer geometry: the body-extraction rules, and the arithmetic that
	// floats a body's action bar with the viewport. The bar's offset is derived from
	// rectangles the RENDER layer reads and passes in; doing the reading here would
	// put DOM measurement on a path the guard is meant to keep clean.
	"vlist-content-view-target.ts",
	"vlist-content-view-float.ts",
	"measure/pretext-metrics.ts",
	"measure/measure-markdown.ts",
	"measure/measure-message-bubble.ts",
	"measure/measure-media.ts",
	"measure/measure-web-search.ts",
	"measure/measure-reasoning.ts",
	"measure/measure-system-simple.ts",
	"measure/measure-system-text.ts",
	"measure/measure-system-list.ts",
	"measure/measure-plan-card.ts",
	"measure/measure-ask-in-passing.ts",
	"measure/measure-tool-run.ts",
	"measure/measure-tool-call.ts",
	"measure/measure-permission.ts",
	"measure/measure-reflection-notice.ts",
	"measure/measure-subagent.ts",
	"measure/measure-subagent-recovery.ts",
	"measure/measure-misc.ts",
];

/** DOM-measurement API patterns that must never appear in a pure-path module. */
const FORBIDDEN = [
	/\.getBoundingClientRect\s*\(/,
	/\.getClientRects\s*\(/,
	/\.offsetHeight\b/,
	/\.offsetWidth\b/,
	/\.offsetTop\b/,
	/\.scrollHeight\b/,
	/\.scrollWidth\b/,
	/\.clientHeight\b/,
	/\.clientWidth\b/,
	/\bnew\s+ResizeObserver\b/,
	/\bgetComputedStyle\s*\(/,
];

/** Strip line + block comments and string literals so only real code is scanned. */
function stripCommentsAndStrings(source: string): string {
	let out = source
		// block comments
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		// line comments
		.replace(/\/\/[^\n]*/g, " ");
	// string/template literals (coarse but sufficient — forbidden tokens in
	// strings, e.g. doc URLs, must not trip the guard).
	out = out
		.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\]|\\.)*'/g, "''")
		.replace(/`(?:[^`\\]|\\.)*`/g, "``");
	return out;
}

describe("zero-DOM-measurement guard (protected invariant)", () => {
	it("no pure-path module calls a DOM-measurement API", () => {
		const offenders: Array<{ file: string; api: string; line: number }> = [];

		for (const rel of PURE_PATH_FILES) {
			const full = join(VLIST_DIR, rel);
			const raw = readFileSync(full, "utf8");
			const code = stripCommentsAndStrings(raw);
			const lines = code.split("\n");
			for (let i = 0; i < lines.length; i++) {
				for (const pattern of FORBIDDEN) {
					if (pattern.test(lines[i]!)) {
						offenders.push({ file: rel, api: pattern.source, line: i + 1 });
					}
				}
			}
		}

		if (offenders.length > 0) {
			const detail = offenders.map((o) => `  ${o.file}:${o.line} → ${o.api}`).join("\n");
			throw new Error(
				`Pure vlist measure/layout modules must not use DOM measurement (heights come from pretext arithmetic + constants).\nOffending calls:\n${detail}`,
			);
		}
		expect(offenders).toHaveLength(0);
	});

	it("guard self-check: the forbidden patterns actually match real API usage", () => {
		// Guard against a broken regex silently passing everything.
		const sample =
			"const h = node.getBoundingClientRect().height; const ro = new ResizeObserver(fn);";
		const matched = FORBIDDEN.filter((p) => p.test(sample));
		expect(matched.length).toBeGreaterThanOrEqual(2);
	});

	it("guard self-check: parameter names like scrollTop are NOT flagged", () => {
		// vlist-pipeline / vlist-virtualization take `scrollTop` as a pure numeric
		// PARAM — that must not be mistaken for a DOM read (there is no `.scrollTop`
		// member access). Confirm the member-access anchor prevents false positives.
		const sample =
			"function f(scrollTop: number, viewportHeight: number) { return scrollTop + 1; }";
		const matched = FORBIDDEN.filter((p) => p.test(sample));
		expect(matched).toHaveLength(0);
	});
});
