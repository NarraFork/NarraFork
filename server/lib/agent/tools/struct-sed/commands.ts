/**
 * StructSed command vocabulary and the fixed budgets every part of the tool shares.
 *
 * Split out so `apply`, `resolve` and the tool shell can all import the command set and the
 * limits without depending on each other.
 */
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";

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
 *
 * The hard ceiling is the recorded input's field budget: a batch records one field per
 * operation plus the `operations` count, and `FILE_CHANGE_LIMITS.fileToolRequestFields`
 * admits 16 fields total. Exceeding it does not degrade — the write is refused outright —
 * so the cap is derived from that budget rather than set to a number that looks generous
 * and then fails at write time.
 */
export const MAX_BATCH_OPERATIONS = FILE_CHANGE_LIMITS.fileToolRequestFields - 1;

/** Context lines kept around each changed hunk in the card's diff. */
export const DIFF_CONTEXT_LINES = 3;

/**
 * Most hunks a card carries.
 *
 * A move or copy produces two, a batch up to one per operation; a substitute across a file
 * can produce one per match. Past this the diff stops being readable at a glance, so the
 * card keeps the first hunks and says how many were left out rather than dropping the diff.
 */
export const MAX_DIFF_HUNKS = 16;

/**
 * Line ceiling for one hunk's side.
 *
 * Hunks are only as long as the change itself plus context, so this bounds the one case
 * that is still large by nature: replacing or deleting a big block. Beyond it the hunk is
 * cut and flagged, which keeps the payload inside the per-field broadcast budget far more
 * often than the old single window, whose length was the DISTANCE between edits.
 */
export const MAX_DIFF_HUNK_LINES = 400;

/**
 * Edit-length ceiling for the line diff between the changed spans.
 *
 * Kept deterministic (no timeout) so the same call produces the same hunks on any
 * machine. Exceeding it falls back to one hunk spanning the changed region.
 */
export const MAX_DIFF_EDIT_LENGTH = 4_000;
