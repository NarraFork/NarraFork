/**
 * Recursion ceiling for the `ForkNarrator` tool.
 *
 * ## Why a ceiling is required
 *
 * A forked narrator receives `ForkNarrator` itself, and its first message is
 * written by the AI that forked it — no human approves the next hop. So "fork a
 * narrator to investigate X" is a step a model can take repeatedly without ever
 * returning to a user. Each hop is expensive and not merely a row: a chapter-bound
 * fork creates a git worktree (a full checkout) plus a branch plus a narrator, and
 * starts a loop that consumes provider tokens.
 *
 * Nothing else bounds this. Chapter forks have no fan-out limit, and the loop's own
 * guards (turn caps, context limits) are per-narrator — they cannot see a chain that
 * escapes into a NEW narrator each time.
 *
 * ## Why depth and not total count
 *
 * A flat fan-out of ten investigation branches from one parent is a legitimate,
 * user-visible pattern; ten levels of narrator forking narrator is not something
 * anyone asked for. Depth targets the runaway shape specifically, and leaves
 * deliberate breadth alone.
 *
 * ## Where the chain is read from
 *
 * Lineage is already recorded, in two different columns depending on the fork kind,
 * so the walk follows whichever applies:
 *
 *  - chapter-bound → `chapters.parent_chapter_id`
 *  - standalone    → `narrators.parent_narrator_id`
 *
 * Both walks are bounded by {@link LINEAGE_WALK_MAX_STEPS} rather than trusting the
 * data to be acyclic: these are self-referencing columns with no constraint that
 * prevents a cycle, and this runs on the main thread.
 */

import { db } from "@server/db";
import { chapters, narrators } from "@server/db/schema";
import { eq } from "drizzle-orm";

/**
 * How many ancestors a new fork may have before the tool refuses.
 *
 * A depth of 8 accommodates any plausible human-directed nesting while stopping an
 * unattended chain long before it can fill a disk with worktrees.
 */
export const FORK_NARRATOR_MAX_DEPTH = 8;

/**
 * Hard stop for the ancestry walk, independent of the depth limit.
 *
 * Guards against a cycle in the self-referencing parent columns. Comfortably above
 * `FORK_NARRATOR_MAX_DEPTH`, so it never decides a legitimate case.
 */
const LINEAGE_WALK_MAX_STEPS = 64;

/** Ancestor count for a chapter, following `parent_chapter_id`. */
async function chapterForkDepth(chapterId: string): Promise<number> {
	let depth = 0;
	let currentId: string | null = chapterId;
	const seen = new Set<string>();

	for (let step = 0; step < LINEAGE_WALK_MAX_STEPS && currentId; step++) {
		if (seen.has(currentId)) break;
		seen.add(currentId);
		const row: { parentChapterId: string | null } | undefined = await db.query.chapters.findFirst({
			where: eq(chapters.id, currentId),
			columns: { parentChapterId: true },
		});
		currentId = row?.parentChapterId ?? null;
		if (currentId) depth++;
	}

	return depth;
}

/** Ancestor count for a standalone narrator, following `parent_narrator_id`. */
async function standaloneForkDepth(narratorId: string): Promise<number> {
	let depth = 0;
	let currentId: string | null = narratorId;
	const seen = new Set<string>();

	for (let step = 0; step < LINEAGE_WALK_MAX_STEPS && currentId; step++) {
		if (seen.has(currentId)) break;
		seen.add(currentId);
		const row: { parentNarratorId: string | null } | undefined = await db.query.narrators.findFirst(
			{
				where: eq(narrators.id, currentId),
				columns: { parentNarratorId: true },
			},
		);
		currentId = row?.parentNarratorId ?? null;
		if (currentId) depth++;
	}

	return depth;
}

/**
 * Depth of the fork chain the given narrator sits at.
 *
 * Counts ancestors, so an un-forked narrator is 0 and its first fork would be 1.
 * Chapter lineage wins when the narrator is chapter-bound, because that is the
 * column a chapter fork writes.
 */
export async function resolveForkDepth(parent: {
	id: string;
	chapterId: string | null;
}): Promise<number> {
	return parent.chapterId
		? await chapterForkDepth(parent.chapterId)
		: await standaloneForkDepth(parent.id);
}

/**
 * Whether forking from here would exceed the ceiling.
 *
 * The check is on the CHILD's depth (`parentDepth + 1`), since that is the thing
 * being created.
 */
export function exceedsForkDepthLimit(parentDepth: number): boolean {
	return parentDepth + 1 > FORK_NARRATOR_MAX_DEPTH;
}
