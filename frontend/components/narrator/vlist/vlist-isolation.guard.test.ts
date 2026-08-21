/**
 * vlist-isolation.guard.test.ts — Keeps the exact virtual list behind its lazy
 * loading boundary.
 *
 * The narrator virtual list is THE message renderer; NarratorPanel loads it via a
 * dynamic `import()` purely for bundle splitting (the initial payload must not
 * carry the ~4.6MB vlist module graph before it is needed). Mechanism: NO file
 * outside frontend/components/narrator/vlist/ may STATICALLY import from vlist/.
 * The only allowed entry is a dynamic `import()` (lazy chunk).
 *
 * Historically this guarded the Chunk/Virtual feature flag (the OFF path must not
 * even fetch vlist code); the flag is gone, but the loading boundary is worth
 * keeping and worth a CI guard, so the rule survives with a new rationale.
 *
 * Zero-runtime, filesystem-only; no DOM, no canvas.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// This test lives at frontend/components/narrator/vlist/. Walk up to `frontend`.
const VLIST_DIR = import.meta.dir;
const FRONTEND_ROOT = resolve(VLIST_DIR, "..", "..", "..");

const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "public", ".git"]);

/** Recursively collect .ts/.tsx files under `dir`, excluding SKIP_DIRS and vlist itself. */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (SKIP_DIRS.has(entry)) continue;
			// Exclude the vlist directory itself — internal imports are fine.
			if (resolve(full) === VLIST_DIR) continue;
			collectSourceFiles(full, out);
		} else {
			const dot = entry.lastIndexOf(".");
			if (dot >= 0 && SCAN_EXTENSIONS.has(entry.slice(dot))) out.push(full);
		}
	}
	return out;
}

/**
 * Detect a STATIC import/export that resolves into the vlist directory.
 * Allows dynamic `import(...)` (lazy) — those don't pull vlist into the caller's
 * synchronous graph, so the OFF path never loads it.
 *
 * Static forms matched:
 *   import ... from "<spec>"
 *   export ... from "<spec>"
 *   import "<spec>"          (side-effect import)
 * where <spec> points at the vlist directory (relative "…/vlist" or containing
 * "components/narrator/vlist").
 */
function findStaticVlistImports(source: string, fromFile: string): string[] {
	const hits: string[] = [];
	// Strip dynamic imports so `import("…/vlist/…")` is never flagged. The
	// replacement must NOT contain the word "import" (otherwise the static
	// `\bimport\b` regex still matches the neutralized token and misflags a
	// flag-guarded lazy `import(...)` as a static import).
	const withoutDynamic = source.replace(/\bimport\s*\(/g, "__DYNIMPORT__(");

	// Match: import ... from "spec"  |  export ... from "spec"  |  import "spec"
	// Use [^;] (not [^\n;]) so multi-line named imports — biome's standard fold for
	// several named bindings — are still matched. A newline-restricted pattern would
	// let `import {\n  X,\n} from "./vlist/…"` slip through (false negative).
	const stmtRe = /(?:^|\n)\s*(?:import|export)\b[^;]*?(?:from\s*)?["']([^"']+)["']/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec loop
	while ((m = stmtRe.exec(withoutDynamic)) !== null) {
		const spec = m[1]!;
		if (resolvesIntoVlist(spec, fromFile)) hits.push(spec);
	}
	return hits;
}

function resolvesIntoVlist(spec: string, fromFile: string): boolean {
	// Relative specifier: resolve against the importing file's directory.
	if (spec.startsWith(".")) {
		const resolved = resolve(dirname(fromFile), spec);
		const rel = relative(VLIST_DIR, resolved);
		// Inside vlist iff the relative path doesn't escape upward.
		return !rel.startsWith("..") && !resolve(rel).startsWith("..");
	}
	// Alias / bare specifier mentioning the vlist path segment.
	return spec.includes("components/narrator/vlist");
}

describe("vlist isolation guard (protected invariant)", () => {
	it("no file outside vlist/ statically imports vlist/", () => {
		const files = collectSourceFiles(FRONTEND_ROOT);
		const offenders: Array<{ file: string; specs: string[] }> = [];

		for (const file of files) {
			const source = readFileSync(file, "utf8");
			if (!source.includes("vlist")) continue; // fast path
			const specs = findStaticVlistImports(source, file);
			if (specs.length > 0) {
				offenders.push({ file: relative(FRONTEND_ROOT, file), specs });
			}
		}

		if (offenders.length > 0) {
			const detail = offenders.map((o) => `  ${o.file} → ${o.specs.join(", ")}`).join("\n");
			throw new Error(
				"vlist must not be statically imported from outside vlist/ (use a flag-guarded dynamic import() so the OFF path never loads it).\n" +
					`Offending static imports:\n${detail}`,
			);
		}
		expect(offenders).toHaveLength(0);
	});

	it("guard self-check: correctly classifies static vs dynamic specifiers", () => {
		// A sibling file two levels above vlist that statically imports it → offender.
		const fakeFrom = join(FRONTEND_ROOT, "components", "narrator", "NarratorPanel.tsx");
		expect(
			findStaticVlistImports('import { X } from "./vlist/PretextExactMessageList";', fakeFrom),
		).toHaveLength(1);
		// Multi-line named import (biome's fold for several bindings) must also be caught.
		expect(
			findStaticVlistImports(
				'import {\n\tX,\n\tY,\n} from "./vlist/PretextExactMessageList";',
				fakeFrom,
			),
		).toHaveLength(1);
		expect(
			findStaticVlistImports(
				'import { X } from "@frontend/components/narrator/vlist/x";',
				fakeFrom,
			),
		).toHaveLength(1);
		// Dynamic import of vlist is allowed (lazy, flag-guarded).
		expect(
			findStaticVlistImports(
				'const m = await import("./vlist/PretextExactMessageList");',
				fakeFrom,
			),
		).toHaveLength(0);
		// React.lazy(() => import(...)) — the exact NarratorPanel integration form.
		expect(
			findStaticVlistImports(
				'const C = lazy(() => import("./vlist/PretextExactMessageList").then((m) => ({ default: m.PretextExactMessageList })));',
				fakeFrom,
			),
		).toHaveLength(0);
		// Unrelated imports are not flagged.
		expect(findStaticVlistImports('import { Box } from "@mantine/core";', fakeFrom)).toHaveLength(
			0,
		);
	});
});
