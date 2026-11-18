/**
 * Subagents' terminals as people see them (Project Teams S2, plan §二.3).
 *
 * A terminal a subagent creates belongs to it: only that subagent's own Terminal tool calls
 * reach it (`assertTerminalAccess` in `tools/terminal.ts`). People reach it through the ACL of
 * the subagent, which is its ACL root's (`terminal-access.ts`):
 *
 * - **Listing** the tree's terminals is read access on the root: anyone who can see the
 *   coordinator's page sees which subagent runs which terminal (name, directory, since when),
 *   never its output.
 * - **Opening** one (watching its output, typing, resizing, renaming, closing) is write
 *   access on the root, the same authority as driving the session.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { narrators, terminals } from "../db/schema";

/** Running terminals listed for one tree: 16 subagents × 3 terminals fit with room to spare. */
export const TREE_TERMINAL_LIST_LIMIT = 100;

export interface TreeTerminal {
	id: string;
	name: string;
	cwd: string | null;
	createdAt: string;
	narratorId: string;
	narratorTitle: string | null;
	subagentType: string | null;
}

export interface TreeTerminalListing {
	terminals: TreeTerminal[];
	/** More running terminals exist than were listed. */
	truncated: boolean;
}

/**
 * The running terminals of the subagents below a narrator: for a primary, every subagent
 * judged on it (both levels); for a subagent, its own helpers. Bounded and indexed
 * (`idx_narrators_acl_root` / parent, `idx_terminals_narrator`); no output is read.
 */
export async function listTreeTerminals(narrator: {
	id: string;
	type: string;
}): Promise<TreeTerminalListing> {
	const scope =
		narrator.type === "subagent"
			? eq(narrators.parentNarratorId, narrator.id)
			: eq(narrators.aclRootNarratorId, narrator.id);
	const rows = await db
		.select({
			id: terminals.id,
			name: terminals.name,
			cwd: terminals.cwd,
			createdAt: terminals.createdAt,
			narratorId: narrators.id,
			narratorTitle: narrators.title,
			subagentType: narrators.subagentType,
		})
		.from(terminals)
		.innerJoin(narrators, eq(terminals.narratorId, narrators.id))
		.where(
			and(
				scope,
				eq(narrators.type, "subagent"),
				eq(terminals.status, "running"),
				isNull(terminals.worktreeResourceId),
			),
		)
		.orderBy(asc(terminals.createdAt), asc(terminals.id))
		.limit(TREE_TERMINAL_LIST_LIMIT + 1)
		.all();
	return {
		terminals: rows.slice(0, TREE_TERMINAL_LIST_LIMIT),
		truncated: rows.length > TREE_TERMINAL_LIST_LIMIT,
	};
}
