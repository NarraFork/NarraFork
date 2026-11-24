/**
 * Recursion ceiling for the `ForkNarrator` tool.
 *
 * ## Why a ceiling is required
 *
 * A forked narrator receives `ForkNarrator` itself, and its first message is
 * written by the AI that forked it — no human approves the next hop. So "fork a
 * narrator to investigate X" is a step a model can take repeatedly without ever
 * returning to a user. Each hop is expensive and not merely a row: it starts a
 * loop that consumes provider tokens.
 *
 * Nothing else bounds this. The loop's own guards (turn caps, context limits) are
 * per-narrator — they cannot see a chain that escapes into a NEW narrator each time.
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
 * Lineage is recorded in `narrators.parent_narrator_id`. The walk is bounded by
 * {@link LINEAGE_WALK_MAX_STEPS} rather than trusting the data to be acyclic: it is a
 * self-referencing column with no constraint that prevents a cycle, and this runs on
 * the main thread.
 */

import { db } from "@server/db";
import { narrators } from "@server/db/schema";
import { readQuery } from "@server/db/worker-read";
import { eq } from "drizzle-orm";

/**
 * How many ancestors a new fork may have before the tool refuses.
 *
 * A depth of 8 accommodates any plausible human-directed nesting while stopping an
 * unattended chain long before it runs away.
 */
export const FORK_NARRATOR_MAX_DEPTH = 8;

/**
 * Hard stop for the ancestry walk, independent of the depth limit.
 *
 * Guards against a cycle in the self-referencing parent column. Comfortably above
 * `FORK_NARRATOR_MAX_DEPTH`, so it never decides a legitimate case.
 */
const LINEAGE_WALK_MAX_STEPS = 64;

/** Ancestor count for a narrator, following `parent_narrator_id`. */
async function narratorForkDepth(narratorId: string): Promise<number> {
	let depth = 0;
	let currentId: string | null = narratorId;
	const seen = new Set<string>();

	for (let step = 0; step < LINEAGE_WALK_MAX_STEPS && currentId; step++) {
		if (seen.has(currentId)) break;
		seen.add(currentId);
		const row: { parentNarratorId: string | null } | undefined = await readQuery(
			db.query.narrators.findFirst({
				where: eq(narrators.id, currentId),
				columns: { parentNarratorId: true },
			}),
			{ executionPolicy: "worker-required", maxRows: 1, timeoutMs: 30_000 },
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
 */
export async function resolveForkDepth(parent: { id: string }): Promise<number> {
	return await narratorForkDepth(parent.id);
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
