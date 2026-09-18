/**
 * panel-source.ts — the source text the narrator panel's source-text guards assert on.
 *
 * The narrator panel is guarded the same way the vlist shell is, and for the same
 * reason: several of its invariants have no runtime surface (an icon-only control must
 * carry an accessible name, a status label must route through `TruncatedText`, a drawer
 * must render the same viewer body the dock panel renders), and the component itself is
 * not unit-mountable — it owns a WebSocket subscription, a scroll container and a
 * composer. So the wiring is checked by reading it.
 *
 * Once part of the panel moves to a sibling module, a guard reading only
 * `NarratorPanel.tsx` breaks in two ways, the second of which is silent:
 *
 *   - a positive assertion fails for a reason unrelated to what it guards;
 *   - a NEGATIVE assertion starts passing VACUOUSLY — the forbidden thing still exists,
 *     just next door, and the guard now certifies a rule it no longer reads.
 *
 * `panelSource()` is therefore the panel AND the modules extracted from it.
 * `panelModule(name)` is one member, for guards that cut a region out with `indexOf`
 * (where concatenation could let a closing sentinel match another module's code first).
 *
 * Zero-runtime, filesystem-only: for tests, never imported by shipped code.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const NARRATOR_DIR = import.meta.dir;

/**
 * The panel's modules, in a FIXED order (entry first, then extracted siblings
 * alphabetically), so guards that use `indexOf`/`matchAll` over the concatenation get a
 * stable answer to "which match came first".
 *
 * A module extracted from the panel MUST be listed here; forgetting it produces exactly
 * the vacuous pass described above. `panel-source.test.ts` asserts the list matches what
 * the entry actually imports.
 */
export const PANEL_MODULES = [
	"NarratorPanel.tsx",
	"interaction/SetGlobalModelModal.tsx",
	"interaction/TurnElapsedTime.tsx",
	"narrator-panel-overrides.ts",
	"useNarratorAsyncQuestionSlots.ts",
] as const;

export type PanelModuleName = (typeof PANEL_MODULES)[number];

/** Read one file from the narrator component directory. */
export function readNarratorFile(relativePath: string): string {
	return readFileSync(join(NARRATOR_DIR, relativePath), "utf8");
}

/**
 * One member of the panel's module set.
 *
 * Typed against `PANEL_MODULES` so a rename that forgets a guard is a type error at the
 * call site rather than an ENOENT at test time.
 */
export function panelModule(name: PanelModuleName): string {
	return readNarratorFile(name);
}

/**
 * The whole panel as one string.
 *
 * Members are separated by a banner comment naming the file, so a failure can be traced
 * back to a module and a line-anchored regex cannot span the seam between two of them.
 */
export function panelSource(): string {
	return PANEL_MODULES.map(
		(name) => `/* ==== panel-source: ${name} ==== */\n${readNarratorFile(name)}`,
	).join("\n");
}
