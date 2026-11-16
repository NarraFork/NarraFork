/**
 * The well-known blocks of a space (pageless outline, A1): places the system knows by a reserved
 * alias, addressed the same way wherever a space is named (`session/behavior`, `session/tasks`,
 * `project/tasks`).
 *
 *   - THE BEHAVIOR BOUNDARY of a session space: the block holding alias `behavior`
 *     (`OUTLINE_BEHAVIOR_ALIAS`), with everything under it: the person's standing rules.
 *   - THE TASK LIST of a session or project space: the block holding alias `tasks`
 *     (`OUTLINE_TASKS_PAGE_ALIAS`), where people and the system add tasks.
 *
 * The system creates each at the top level of its space, and only a block at the top level is
 * one: an alias a person gave to a nested block names no well-known place (as before, when the
 * alias had to be on a page). What belongs to a well-known block is decided by ANCESTRY: a block
 * is a rule when the behavior boundary is among its ancestors, wherever it sits below it.
 *
 * Reads here are one alias lookup, one primary-key read, and for ancestry one bounded walk up
 * (`readOutlineAncestry`: one recursive statement per 500 blocks whatever the depth).
 */
import { OUTLINE_BEHAVIOR_ALIAS, OUTLINE_TASKS_PAGE_ALIAS } from "./model";
import { outlineStore } from "./store";
import type { OutlineBlockMeta, OutlineStore } from "./store/port";
import { readOutlineAncestry } from "./subtree-marks";

async function wellKnown(
	spaceId: string,
	alias: string,
	store: OutlineStore,
): Promise<OutlineBlockMeta | null> {
	const [owner] = await store.findAliasOwners(spaceId, [alias]);
	if (!owner) return null;
	const [meta] = await store.getBlockMetas(spaceId, { ids: [owner.id] });
	return meta && !meta.deleted && meta.parentId === null ? meta : null;
}

/**
 * The behavior boundary of a session space: the live top-level block holding alias `behavior`.
 * Null when no block holds it, or the one that does is nested under another block.
 */
export async function findBehaviorBlock(
	spaceId: string,
	store: OutlineStore = outlineStore,
): Promise<OutlineBlockMeta | null> {
	return await wellKnown(spaceId, OUTLINE_BEHAVIOR_ALIAS, store);
}

/** The task list of a space: the live top-level block holding alias `tasks`; null when none. */
export async function findTasksBlock(
	spaceId: string,
	store: OutlineStore = outlineStore,
): Promise<OutlineBlockMeta | null> {
	return await wellKnown(spaceId, OUTLINE_TASKS_PAGE_ALIAS, store);
}

/** Rows one walk up reads at most (the blocks asked about and their ancestors). */
export const OUTLINE_WELL_KNOWN_WALK_ROWS = 4000;

/**
 * Which of the given live blocks of a space are `rootId` or under it, by ancestry as the tree
 * is now. A block whose walk up did not reach the top (deleted on the way, or the walk was cut
 * short at its row limit) is reported in `unknown` instead: the caller decides what that means.
 */
export async function blocksUnder(
	spaceId: string,
	rootId: string,
	blockIds: Iterable<string>,
	options: { store?: OutlineStore; maxRows?: number } = {},
): Promise<{ under: Set<string>; unknown: Set<string> }> {
	const ids = [...new Set(blockIds)];
	const under = new Set<string>();
	const unknown = new Set<string>();
	if (ids.length === 0) return { under, unknown };
	const ancestry = await readOutlineAncestry(spaceId, ids, {
		maxRows: options.maxRows ?? OUTLINE_WELL_KNOWN_WALK_ROWS,
		store: options.store,
	});
	for (const id of ids) {
		if (id === rootId) {
			under.add(id);
			continue;
		}
		const above = ancestry.above(id);
		if (above === null) unknown.add(id);
		else if (above.includes(rootId)) under.add(id);
	}
	return { under, unknown };
}
