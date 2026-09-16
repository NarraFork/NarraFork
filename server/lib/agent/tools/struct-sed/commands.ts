/**
 * StructSed command vocabulary and the fixed budgets every part of the tool shares.
 *
 * Split out so `apply`, `resolve` and the tool shell can all import the command set and the
 * limits without depending on each other.
 */

export const COMMANDS = [
	"replace",
	"substitute",
	"delete",
	"insert",
	"append",
	"copy",
	"move",
] as const;
export type Command = (typeof COMMANDS)[number];

/** Commands that relocate a block rather than rewriting one in place. */
export const RELOCATION_COMMANDS = new Set<Command>(["copy", "move"]);

/** Same ceiling StructView uses, so an addressable file is always an editable one. */
export const MAX_FILE_BYTES = 2_000_000;

/** Preview budget: enough to see the change, not enough to flood the context. */
export const MAX_PREVIEW_LINES = 80;

/**
 * Cap on operations per batch.
 *
 * Bounds both the resolution work (each operation may run `locate`) and the preview size.
 * A larger refactor should be split into several calls, so a dry run stays readable.
 */
export const MAX_BATCH_OPERATIONS = 50;

/** Context lines kept around a change when building the card's diff. */
export const DIFF_CONTEXT_LINES = 3;

/**
 * Largest changed span (in lines) for which a diff card is built.
 *
 * Beyond this the diff is more overwhelming than the text preview — a move from the top of
 * a file to the bottom spans the whole file — so the card falls back to the preview instead.
 */
export const MAX_DIFF_SPAN_LINES = 400;
