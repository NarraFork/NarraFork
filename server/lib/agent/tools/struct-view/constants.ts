/**
 * StructView's fixed budgets and its mode vocabulary.
 *
 * Split out so the tool shell and every mode file share one definition of the limits and
 * the `Mode` set without depending on each other.
 */

/** Cap on bytes read for structural inspection. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Cap on the tool's own output, independent of the file size. */
export const MAX_OUTPUT_CHARS = 60_000;

/** Default outline nesting depth: top level plus one (class → its methods). */
export const DEFAULT_DEPTH = 2;

/** Bound on `print` output so a broad regex cannot dump the file. */
export const MAX_PRINT_BLOCKS = 200;
export const MAX_PRINT_LINES = 2000;

/** Landmarks shown before suggesting a higher `limit`. */
export const MAX_LANDMARKS = 120;

/** Landmark kinds accepted by the `kind` filter. */
export const LANDMARK_KINDS = ["section", "region", "marker"] as const;

export type Mode =
	| "outline"
	| "extract"
	| "print"
	| "enclosing"
	| "api"
	| "imports"
	| "tree"
	| "refs"
	| "calls"
	| "report"
	| "landmarks"
	| "interface"
	| "usages";

export const MODES: Mode[] = [
	"outline",
	"extract",
	"print",
	"enclosing",
	"api",
	"imports",
	"tree",
	"refs",
	"calls",
	"report",
	"landmarks",
	"interface",
	"usages",
];

/** Rows shown by the ranking modes before the tail is summarized. */
export const MAX_RANKED_ROWS = 25;

/**
 * Reference positions shown per symbol before collapsing to "+N more".
 *
 * A hot identifier can appear hundreds of times; printing every line would bury the rows
 * that matter under one symbol's noise. The full list stays available in the stats for
 * range analysis, which needs all of them.
 */
export const MAX_REF_POSITIONS = 20;

/** Hard cap on report output; the point is to be cheaper than 6 separate calls. */
export const MAX_REPORT_LINES = 800;

/** A symbol occupying more than this share of the file is worth calling out. */
export const DOMINANT_SYMBOL_RATIO = 0.4;

/** Ceilings for the cross-file usage scan, so one call cannot fan out unbounded. */
export const MAX_USAGE_CANDIDATES = 200;
export const MAX_USAGE_FILE_BYTES = 2_000_000;
export const USAGE_GREP_TIMEOUT_MS = 15_000;
export const USAGE_GREP_MAX_BYTES = 4 * 1024 * 1024;
