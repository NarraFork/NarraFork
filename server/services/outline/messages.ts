/**
 * Agent-facing text of the outline read, search, resolution and revert services, in one place
 * and in English. Tools and their tests use these instead of spelling their own, so wording
 * changes in one edit and nothing parses prose it did not write.
 *
 * Annotations inside a rendered outline are wrapped in `‹…›` so they read as notes, not
 * content; `render.ts` places them where the outline parser can tell them apart and strips
 * them again (`stripReadAnnotations`).
 */

function blocks(n: number): string {
	return n === 1 ? "1 block" : `${n} blocks`;
}

export const OUTLINE_TEXT = {
	/** Under a block whose further blocks did not fit the read's budget. */
	more: (n: number) => `‹… ${n} more›`,
	/** After a facts view that left process blocks out. */
	factsOnly: (n: number) =>
		`‹facts only: ${blocks(n)} under tasks not shown; read with view "all" to include them›`,
	/** After a read of a page with more blocks than one read loads. */
	pageTruncated: (n: number) =>
		`‹the page has more blocks than one read loads; only ${n} were read: read a smaller part›`,

	/** Why a revert left a block as it is. */
	revertSkipped: {
		"changed-later": "changed by a later commit",
		"parent-gone": "the block it belonged under is deleted now",
		"later-children": "blocks added under it later would be deleted with it",
		cycle: "it would end up under itself",
	} as const,
	/** A restored or reverted alias that another block holds now. */
	aliasDropped: (alias: string, holder: string) =>
		`alias ${alias} is used by ${holder} now; the block was restored without it`,
	/** A restored or moved-back block whose old place among its siblings is taken. */
	orderKeyMoved: (wanted: string) =>
		`its old position (${wanted}) is taken; it was placed right after the block holding it`,
	/** Summary of a compensating commit. */
	revertSummary: (seq: number, summary: string) => `revert #${seq}: ${summary}`,

	/** Why a read or search was refused. */
	errors: {
		pageTooLarge: (pageId: string, max: number) =>
			`outline page ${pageId} has more than ${max} blocks; read a smaller part of it`,
		badSeq: (field: string) => `${field} must be a commit seq (a non-negative integer)`,
		badTime: "not a valid time",
		tooManySpaces: (max: number, got: number) =>
			`a search covers at most ${max} spaces (got ${got})`,
	},
} as const;

export type OutlineRevertSkipReason = keyof typeof OUTLINE_TEXT.revertSkipped;
