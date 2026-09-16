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

/**
 * Commands that supply their own complete text.
 *
 * These are the only ones that can take `from_stash` as CONTENT, or create a file with
 * `create_if_missing`: the rest describe a transformation of existing text, so content
 * they were handed would have nowhere to go.
 */
export const CONTENT_COMMANDS = new Set<Command>(["replace", "insert", "append"]);

/**
 * Commands that can take `from_stash` as the RANGE to act on.
 *
 * Only `delete`, and deliberately so. It completes a cross-file move: the stash already
 * knows which lines its text occupies, so removing the original needs no second address —
 * and re-typing the address is precisely how the wrong lines got deleted when anything
 * above the range had shifted.
 *
 * `substitute` and `copy`/`move` are excluded. They transform or relocate within one file,
 * where a cross-file relay has no coherent meaning; accepting a handle there would only
 * widen the surface for mistakes.
 */
export const STASH_RANGE_COMMANDS = new Set<Command>(["delete"]);

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
