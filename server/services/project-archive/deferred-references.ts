/**
 * The archive's forward-reference graph, stated once for every main-store backend.
 *
 * WHY THIS EXISTS
 * ---------------
 * `manifest.ts` orders the archive's TABLES parent-first, and that is sufficient for
 * every reference whose target is a strictly earlier table. It cannot order the rows
 * WITHIN a table (they page by primary key — a random nanoid), and it cannot fix a
 * reference whose target table comes LATER in the order. Both shapes exist:
 *
 *   - `chapters.parent_chapter_id` / `merged_into_chapter_id` / `review_source_chapter_id`
 *     point at the same table. A child whose parent happens to sort after it violates
 *     an immediately enforced FK the moment it is inserted.
 *   - `exploration_groups.base_chapter_id` / `decided_chapter_id` point at `chapters`,
 *     which is imported AFTER `exploration_groups`.
 *   - `narrators.parent_narrator_id` points at the same table, and
 *     `narrators.fork_message_id` points at `narrator_messages`, which is imported
 *     AFTER `narrators` (a narrator is forked from a message, but a message belongs
 *     to a narrator — the cycle is real, not an ordering mistake).
 *
 * SQLite never surfaced this because its FK checks happen per statement and the
 * affected imports simply failed — an unexercised latent hazard (no test ever
 * imported a chapter whose parent sorted later). PostgreSQL enforces the same
 * immediate FKs, so its import has to answer the question explicitly. Both main
 * stores therefore use the SAME two-phase shape:
 *
 *   1. insert every row with its forward-reference columns bound to NULL, recording
 *      the rows that were actually inserted (a conflict-skipped row keeps the
 *      existing row's references — the import's "keep what is already there" rule
 *      applies to them too);
 *   2. after every batch has been applied, restore the recorded references with one
 *      UPDATE per inserted row, still inside the same transaction.
 *
 * A genuinely DANGLING reference (the target row is in no batch and not in the main
 * database) still aborts the whole import at phase 2 — exactly the guarantee the
 * pre-existing order gave ("a bad order surfaces as a failed import, not as quietly
 * missing rows"). Only the failure's timing moved: from the row's own INSERT to the
 * reference-restoring UPDATE.
 *
 * This file imports nothing but the manifest's types: the graph above is a fact
 * about the ARCHIVE's columns, stated in the archive's own spelling, and both main
 * stores map those names to their schema's columns themselves.
 */

import type { ArchiveTable } from "./manifest";

/**
 * Columns an import must write AFTER all batches, per archive table. Absent tables
 * have no forward references at all.
 */
export const ARCHIVE_FORWARD_REFERENCES: Readonly<
	Partial<Record<ArchiveTable, readonly string[]>>
> = {
	exploration_groups: ["base_chapter_id", "decided_chapter_id"],
	chapters: ["parent_chapter_id", "merged_into_chapter_id", "review_source_chapter_id"],
	narrators: ["parent_narrator_id", "fork_message_id"],
};

/**
 * The forward-reference columns of `table` that are actually present in `columns`
 * (the three-way intersection the caller already computed), in declared order.
 */
export function forwardReferencesOf(
	table: ArchiveTable,
	columns: readonly string[],
): readonly string[] {
	const declared = ARCHIVE_FORWARD_REFERENCES[table];
	if (!declared) return [];
	const present = new Set(columns);
	return declared.filter((column) => present.has(column));
}
