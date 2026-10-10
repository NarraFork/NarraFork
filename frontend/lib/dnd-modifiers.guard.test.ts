/**
 * dnd-modifiers.guard.test.ts — keeps every sortable list axis-restricted.
 *
 * WHY A STATIC GUARD
 * ------------------
 * `verticalListSortingStrategy` only decides how the OTHER rows make way while
 * sorting; it does not constrain the pointer. Without a modifier the dragged row
 * follows the pointer sideways in a vertical list, which reads as "this can be
 * dragged horizontally" and slides rows out of the menu.
 *
 * The failure is a missing prop on an individual `DndContext`, so nothing in the
 * normal pipeline can see it: the type-checker accepts `modifiers` as optional and
 * the behaviour only appears under a real pointer drag, which no unit test in this
 * repo performs (see `DirectoryPicker.new-target.test.tsx`, which mocks
 * `@dnd-kit/core` wholesale). A static scan is the only check that covers a list
 * added later.
 *
 * HOW IT WORKS
 * ------------
 * Scan `frontend/` for files containing `<DndContext`. For each one, find its
 * `SortableContext` strategy and require the matching modifier:
 *
 *   verticalListSortingStrategy    -> restrictToVerticalAxis
 *   horizontalListSortingStrategy  -> restrictToHorizontalAxis
 *
 * Two exclusions are deliberate, not oversights:
 *
 * - `rectSortingStrategy` (CodexSection) is a wrapped grid; both axes are correct.
 * - A `DndContext` with no `SortableContext` (RecentTabs) serves cross-panel drops
 *   and must stay free. Its pointer is derived from `origin + event.delta`, so an
 *   axis modifier would pin `delta.x` to 0 and break horizontal landing.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const FRONTEND_ROOT = resolve(import.meta.dir, "..");

const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
	"node_modules",
	"dist",
	"public",
	".git",
	"locales",
]);

const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);

/** Strategy identifier -> the modifier its lists must carry. */
const STRATEGY_MODIFIERS: ReadonlyMap<string, string> = new Map([
	["verticalListSortingStrategy", "restrictToVerticalAxis"],
	["horizontalListSortingStrategy", "restrictToHorizontalAxis"],
]);

interface Violation {
	file: string;
	strategy: string;
	required: string;
}

function walkFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIR_NAMES.has(entry)) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			walkFiles(full, out);
			continue;
		}
		const dot = entry.lastIndexOf(".");
		if (dot < 0 || !SCAN_EXTENSIONS.has(entry.slice(dot))) continue;
		// Guards are about our source, not the guard itself or its fixtures.
		if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
		out.push(full);
	}
	return out;
}

/**
 * Find `<DndContext ...>` tags and, for each, the strategy used within the same
 * file's following `SortableContext`.
 *
 * Text-based on purpose: a regex over source is what a reviewer can audit, and the
 * alternative (importing every component) would need a DOM to render them.
 */
function findViolations(source: string, file: string): Violation[] {
	const violations: Violation[] = [];
	// Every `<DndContext` opening tag, up to its matching `>`. Non-greedy so a tag
	// with many props does not swallow the next one.
	const tags = source.matchAll(/<DndContext\b[\s\S]*?>/g);

	for (const tag of tags) {
		const after = source.slice(tag.index + tag[0].length);
		const hasModifiers = /modifiers=\{/.test(tag[0]);
		for (const [strategy, required] of STRATEGY_MODIFIERS) {
			// Only the SortableContext that belongs to this DndContext: the nearest one
			// after it, before the next DndContext opens.
			const nextContext = after.indexOf("<DndContext");
			const scope = nextContext < 0 ? after : after.slice(0, nextContext);
			if (!scope.includes(strategy)) continue;
			if (hasModifiers && (tag[0].includes(required) || scope.includes(required))) continue;
			violations.push({ file, strategy, required });
		}
	}
	return violations;
}

function scanRoots(): Violation[] {
	const violations: Violation[] = [];
	for (const file of walkFiles(FRONTEND_ROOT)) {
		const source = readFileSync(file, "utf8");
		if (!source.includes("<DndContext")) continue;
		violations.push(...findViolations(source, relative(FRONTEND_ROOT, file).split(sep).join("/")));
	}
	return violations;
}

describe("dnd sortable lists carry an axis-restriction modifier", () => {
	it("every vertical/horizontal sortable DndContext is restricted", () => {
		const violations = scanRoots();
		const message = violations
			.map((v) => `${v.file}: ${v.strategy} without ${v.required}`)
			.join("\n");
		expect(violations, message).toHaveLength(0);
	});

	it("finds the sortable lists it is meant to guard", () => {
		// A guard that silently stops matching would pass forever while the real
		// lists go unchecked. Assert the scan still sees a representative sample.
		const files = walkFiles(FRONTEND_ROOT)
			.filter((f) => readFileSync(f, "utf8").includes("<DndContext"))
			.map((f) => relative(FRONTEND_ROOT, f).split(sep).join("/"));

		expect(files).toContain("components/terminal/TerminalTabBar.tsx");
		expect(files).toContain("components/common/DirectoryPicker.tsx");
		expect(files.length).toBeGreaterThanOrEqual(8);
	});
});
