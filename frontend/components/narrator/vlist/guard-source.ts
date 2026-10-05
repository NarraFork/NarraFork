/**
 * guard-source.ts — the source text the vlist's source-text guards assert on.
 *
 * ## Why this exists
 *
 * Dozens of guards in this directory assert on the SHELL'S SOURCE TEXT because what
 * they protect is a wiring rule with no runtime surface: an option that must be the
 * bucketed height, a capture that must not read the DOM, a row that must carry a key
 * attribute. The component is not unit-mountable (it owns a scroll container, a
 * ResizeObserver and a document pipeline), so the wiring is checked by reading it.
 *
 * That worked while "the shell" was one file. The moment part of the shell moves to a
 * sibling module, a guard reading only `PretextExactMessageList.tsx` fails in the two
 * ways that are WORSE than a red test:
 *
 *   - a positive assertion (`toContain`) fails for a reason unrelated to what it
 *     guards, and the next person re-anchors it to whatever makes it pass;
 *   - a NEGATIVE assertion (`not.toContain("getBoundingClientRect")`) starts passing
 *     VACUOUSLY — the forbidden call is still there, just in another file, and the
 *     guard now certifies a rule it no longer checks. Nothing goes red. That is how a
 *     guard becomes decoration.
 *
 * So the unit a guard reads is not "a file" but "the shell's module set". `shellSource()`
 * returns all of it; `shellModule()` returns one member when a guard needs to be exact
 * about WHERE something lives.
 *
 * ## Choosing between them
 *
 * - Use `shellSource()` for rules about the shell AS A WHOLE — above all every
 *   negative assertion, which must keep seeing every place the forbidden thing could
 *   hide. A negative assertion narrowed to one module is a negative assertion that
 *   stopped guarding the others.
 * - Use `shellModule(name)` when the rule is about a specific module, or when a guard
 *   cuts a REGION out with `indexOf`/`sliceBracketedRegion`: concatenation can put a
 *   second, unrelated match of the closing sentinel in front of the real one, which is
 *   exactly the over-running slice `source-slice.ts` was written to prevent.
 *
 * Zero-runtime, filesystem-only: this module is for tests, never imported by shipped
 * code (it reads from disk with `node:fs`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const VLIST_DIR = import.meta.dir;

/**
 * The exact-layout shell's modules, in a FIXED order (entry first, then the extracted
 * siblings alphabetically).
 *
 * Order is fixed rather than incidental because `shellSource()` is fed to `indexOf`
 * and `matchAll` by some guards: a set whose order shifted between runs would make
 * "which match came first" — and therefore those guards' verdicts — unstable.
 *
 * A module extracted from the shell MUST be added here. That is the one manual step
 * this design keeps, and the cost of forgetting it is precisely the vacuous pass
 * described above, so it is also asserted: `guard-source.test.ts` checks every sibling
 * the entry imports is listed.
 */
export const SHELL_MODULES = [
	"PretextExactMessageList.tsx",
	"ExactRow.tsx",
	"useVListWindowRows.tsx",
	"vlist-exact-document.ts",
	"vlist-exact-layout.ts",
	"vlist-exact-row-state.ts",
	"vlist-exact-scroll.ts",
	"vlist-interaction-admission-context.tsx",
	"vlist-interaction-admission.ts",
	"vlist-live-resize.ts",
	"vlist-lod-morph-commit.ts",
	"vlist-lod-morph-frame.ts",
	"vlist-lod-morph-geometry.ts",
	"vlist-morph-scroll-origin.ts",
	"vlist-resize-permission.ts",
	"vlist-resize-preview.ts",
	"vlist-window-row-reuse.ts",
] as const;

export type ShellModuleName = (typeof SHELL_MODULES)[number];

/** Read one file from the vlist directory. */
export function readVlistFile(relativePath: string): string {
	return readFileSync(join(VLIST_DIR, relativePath), "utf8");
}

/**
 * One member of the shell's module set.
 *
 * Typed against `SHELL_MODULES` so a rename that forgets a guard is a type error at
 * the call site rather than a `readFileSync` throw at test time.
 */
export function shellModule(name: ShellModuleName): string {
	return readVlistFile(name);
}

/**
 * The whole shell as one string.
 *
 * Members are separated by a banner comment carrying the file name, so a guard failure
 * message can be traced back to a file, and so a regex anchored on a line start cannot
 * accidentally span the seam between two modules.
 */
export function shellSource(): string {
	return SHELL_MODULES.map(
		(name) => `/* ==== guard-source: ${name} ==== */\n${readVlistFile(name)}`,
	).join("\n");
}
