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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const VLIST_DIR = import.meta.dir;

/**
 * The modules that MUST be pure (data → height/geometry), zero DOM.
 *
 * ⚠️ Only files with a real BODY belong here. The height kernel moved to
 * `shared/pretext-layout/`, leaving several vlist paths as two-line re-export shells
 * — and scanning a shell is indistinguishable from not scanning at all: the patterns
 * below match against `export * from "@shared/…"` and always pass, while the
 * arithmetic they are supposed to protect sits in another file. Those implementations
 * are covered by `shared/pretext-layout/shared-core.guard.test.ts`, which ENUMERATES
 * its directory (so a new module there is covered by default). `MIGRATED_SHELL_FILES`
 * below records the hand-off and asserts it is still true.
 *
 * `vlist-virtualization.ts` and `vlist-pipeline.ts` re-export from shared too, but
 * they are NOT shells: each adds frontend-side logic (`resolvePinnedRowIndices`, and
 * the measurement-registry injection), so they stay scanned here.
 */
const PURE_PATH_FILES = [
	"registry.ts",
	"vlist-tail-meta.ts",
	"vlist-selection.ts",
	"vlist-lod-gesture.ts",
	"vlist-virtualization.ts",
	"vlist-pipeline.ts",
	"vlist-permission-match.ts",
	"vlist-reflection-index.ts",
	"vlist-interaction-state.ts",
	// Fold transition PLANNING. It consumes geometry the layout already published and
	// decides what to animate; reading a real element's size here would make a
	// decoration a second source of truth for a height the pure path owns. (The DOM
	// edge that plays the plan is `vlist-fold-motion.ts`, deliberately not scanned:
	// it is a shell-level effect like vlist-highlight.)
	"vlist-fold-animation.ts",
	// Live lifecycle patching: rewrites the loaded document, then a rebuild derives
	// the new heights arithmetically. Reaching for a real element's size here would
	// make a server event (not a user action) the source of a measured height.
	"vlist-live-patch.ts",
	"vlist-live-events.ts",
	// Pure decisions consumed by the shell (streaming hand-off, reload
	// classification), the incremental streaming markdown preparation, and the
	// "latest spec://tasks.json call" identification the pin exemption is keyed on.
	"streaming-handoff.ts",
	"streaming-block-cache.ts",
	"vlist-reload-policy.ts",
	"vlist-spec-tasks-pin.ts",
	// Content-viewer geometry: the body-extraction rules, and the arithmetic that
	// floats a body's action bar with the viewport. The bar's offset is derived from
	// rectangles the RENDER layer reads and passes in; doing the reading here would
	// put DOM measurement on a path the guard is meant to keep clean.
	"vlist-content-view-target.ts",
	"vlist-content-view-float.ts",
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

/**
 * The migrated modules: `vlist/<shell>` → `shared/pretext-layout/<implementation>`.
 *
 * Removed from `PURE_PATH_FILES` because scanning a two-line re-export is empty
 * coverage. Listed here so the removal stays HONEST: the test below asserts each
 * really is a shell (nothing to scan) AND that the shared implementation it points at
 * exists in the enumerated directory — so no module can end up outside both guards.
 */
const MIGRATED_SHELL_FILES: ReadonlyArray<{ shell: string; implementation: string }> = [
	{ shell: "prepared-block.ts", implementation: "prepared-block.ts" },
	{ shell: "pretext-fonts.ts", implementation: "pretext-fonts.ts" },
	{ shell: "parse-markdown.ts", implementation: "parse-markdown.ts" },
	{ shell: "segment-adapter.ts", implementation: "segment-adapter.ts" },
	{ shell: "measure/pretext-metrics.ts", implementation: "pretext-metrics.ts" },
];

const SHARED_CORE_DIR = join(VLIST_DIR, "..", "..", "..", "..", "shared", "pretext-layout");

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

	it("every module dropped from the scan is a shell whose implementation IS covered", () => {
		// The hand-off, checked from both ends. If a "shell" ever grows a body it must
		// come back into PURE_PATH_FILES; if a shared implementation is renamed away, the
		// enumerated guard is no longer covering what this file stopped covering.
		const sharedModules = new Set(
			readdirSync(SHARED_CORE_DIR).filter(
				(name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
			),
		);
		for (const { shell, implementation } of MIGRATED_SHELL_FILES) {
			const source = readFileSync(join(VLIST_DIR, shell), "utf8");
			const code = source
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0 && !line.startsWith("/*") && !line.startsWith("*"))
				.filter((line) => !line.startsWith("//"));
			// A shell is exactly one statement: the re-export. Anything more is a body that
			// needs scanning again.
			expect(code, `${shell} is no longer a pure re-export shell`).toEqual([
				`export * from "@shared/pretext-layout/${implementation.replace(/\.ts$/, "")}";`,
			]);
			expect(
				sharedModules.has(implementation),
				`shared/pretext-layout/${implementation} is missing, so ${shell}'s implementation is unguarded`,
			).toBe(true);
		}
		// And a shell must never also be listed as a scanned pure path (double bookkeeping
		// would let a re-listed shell masquerade as coverage).
		for (const { shell } of MIGRATED_SHELL_FILES) {
			expect(PURE_PATH_FILES).not.toContain(shell);
		}
	});

	it("the migrated implementations are scanned with THIS file's full pattern set", () => {
		// The shared enumerated guard covers the whole directory, but with a narrower
		// regex (getBoundingClientRect / offset{Height,Width} / createElement, plus
		// `document.` / `window.`). It would not see `new ResizeObserver`,
		// `getComputedStyle`, `.getClientRects()`, `.scroll*` or `.client*`. Scanning the
		// five implementations here as well means moving a module to shared can never
		// LOSE a pattern — which is what "the shell hand-off is honest" has to mean.
		const offenders: Array<{ file: string; api: string; line: number }> = [];
		for (const { implementation } of MIGRATED_SHELL_FILES) {
			const code = stripCommentsAndStrings(
				readFileSync(join(SHARED_CORE_DIR, implementation), "utf8"),
			);
			const lines = code.split("\n");
			for (let i = 0; i < lines.length; i++) {
				for (const pattern of FORBIDDEN) {
					if (pattern.test(lines[i]!)) {
						offenders.push({ file: implementation, api: pattern.source, line: i + 1 });
					}
				}
			}
		}
		expect(offenders).toEqual([]);
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
