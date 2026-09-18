/**
 * Seeding order for the shared read fixtures, expressed once for both backends.
 *
 * Kept separate from the row data so each backend only supplies an `insert` that maps a
 * logical table name onto its own Drizzle table. Chapters are written in two batches
 * because `c_review.review_source_chapter_id` references `c_a`, which must already exist.
 */

import {
	aclGrantRows,
	bulkChapterRows,
	bulkProjectRows,
	caseMixChapterRows,
	caseMixEdgeRows,
	chapterEdgeRows,
	chapterRowsFirst,
	chapterRowsSecond,
	containerRows,
	narratorRows,
	projectRows,
	userRows,
} from "./read-fixtures";

export type FixtureTable =
	| "users"
	| "projects"
	| "chapters"
	| "chapterEdges"
	| "narrators"
	| "containerInstances"
	| "aclGrants";

/** How one backend inserts a batch. Rows are backend-agnostic property bags. */
export type FixtureInsert = (
	table: FixtureTable,
	rows: Array<Record<string, unknown>>,
) => Promise<void>;

/** Chunked so neither driver hits a bound-parameter ceiling on the 205-row batches. */
async function insertChunked(
	insert: FixtureInsert,
	table: FixtureTable,
	rows: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
	for (let index = 0; index < rows.length; index += 40) {
		await insert(table, rows.slice(index, index + 40));
	}
}

export async function seedFixtures(insert: FixtureInsert): Promise<void> {
	await insertChunked(insert, "users", userRows);
	await insertChunked(insert, "projects", [...projectRows, ...bulkProjectRows()]);
	await insertChunked(insert, "chapters", chapterRowsFirst);
	await insertChunked(insert, "chapters", chapterRowsSecond);
	await insertChunked(insert, "chapters", bulkChapterRows());
	await insertChunked(insert, "chapters", caseMixChapterRows());
	await insertChunked(insert, "chapterEdges", chapterEdgeRows);
	// After the mixed-case chapters they reference: both endpoints must already exist.
	await insertChunked(insert, "chapterEdges", caseMixEdgeRows());
	await insertChunked(insert, "narrators", narratorRows);
	await insertChunked(insert, "containerInstances", containerRows);
	await insertChunked(insert, "aclGrants", aclGrantRows);
}
