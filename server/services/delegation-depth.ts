/**
 * Delegation depth: how many subagent levels a narrator sits below a primary narrator.
 *
 * A primary is level 0, its subagents level 1, their helpers level 2. The depth is
 * stamped on a subagent's ceiling at creation (`withDelegationDepth`), but the backstops
 * do not trust that stamp alone: they also derive the level from the parent chain here,
 * so a row whose ceiling lost or never had the stamp still cannot nest deeper than
 * {@link MAX_DELEGATION_DEPTH}. The walk is a handful of primary-key reads.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { MAX_POLICY_SOURCE_DEPTH } from "../lib/runtime-source";
import { MAX_DELEGATION_DEPTH } from "./agent-runtime/policy";

export { MAX_DELEGATION_DEPTH };

/**
 * Subagent levels above and including `narratorId` along `parent_narrator_id`. A primary
 * narrator (or a fork, which is a primary with a parent link) is 0. A missing row is 0:
 * callers decide on the narrator they already loaded. A chain longer than any legal
 * nesting is refused rather than walked.
 */
export async function delegationDepthOf(narratorId: string): Promise<number> {
	let depth = 0;
	let currentId: string | null = narratorId;
	const seen = new Set<string>();
	while (currentId) {
		if (seen.has(currentId) || seen.size >= MAX_POLICY_SOURCE_DEPTH)
			throw new Error("Subagent parent chain is cyclic or too deep");
		seen.add(currentId);
		const row: { type: string; parentNarratorId: string | null } | undefined = await db
			.select({ type: narrators.type, parentNarratorId: narrators.parentNarratorId })
			.from(narrators)
			.where(eq(narrators.id, currentId))
			.get();
		if (row?.type !== "subagent") return depth;
		depth += 1;
		currentId = row.parentNarratorId;
	}
	return depth;
}

/** Message the backstops give when a narrator at the deepest level tries to orchestrate. */
export const DELEGATION_DEPTH_LIMIT_MESSAGE =
	`Subagents nest at most ${MAX_DELEGATION_DEPTH} levels below a primary narrator; ` +
	"a subagent at the deepest level cannot launch or control other agents.";
