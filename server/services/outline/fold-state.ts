/**
 * One reader's own folding of the outline, by block (pageless outline, F1; `outline_fold_state`):
 * the blocks of a space they opened that are closed by default, and the ones they closed that
 * are open by default (`shared/outline-fold.ts`). It replaces the folding kept per page in
 * `outline_view_state` (`view-state.ts`, which the page editor still uses until it moves).
 * Personal: never part of the block model, never a commit, invisible to everyone else, the same
 * on every device.
 *
 * ACCESS: reading and writing need read access to the space (folding what one may only read is
 * still one's own view of it); a space one may not read answers like one that does not exist.
 * A person only ever reads and writes their own rows: the user id comes from the session, never
 * from the request.
 *
 * BOUNDED, because any reader may write for every space they can read: a write names at most
 * `maxChanges` blocks, only live blocks of the space are kept (looked up by primary key in
 * chunks), and a reader has at most `maxPerSpace` rows per space: writing more drops the ones
 * written longest ago, which go back to the default.
 *
 * A write carries CHANGES, not the whole state, so two tabs of one reader do not undo each
 * other; the last write of a block wins. "Back to the default" of a whole space or of
 * everything under a block is ONE request ({@link resetFoldState}), not a null per row.
 *
 * NOT EXPORTED by data portability, like `outline_view_state`: per-reader UI state that is
 * rebuilt by using the outline; an imported instance starts at the default folding.
 */

import { OUTLINE_BLOCK_ID_RE } from "@shared/outline-api";
import {
	OUTLINE_FOLD_STATE_LIMITS,
	type OutlineFoldStateResponse,
} from "@shared/outline-subtree-api";
import { outlineStore } from "./store";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";
import { readOutlineAncestry } from "./subtree-marks";

/** The reader's folding of a space as the two sets a folded read takes. */
export async function loadFoldSets(
	userId: string,
	spaceId: string,
	store: OutlineStore = outlineStore,
): Promise<{ expanded: Set<string>; collapsed: Set<string> }> {
	const rows = await store.listFoldState(userId, spaceId, OUTLINE_FOLD_STATE_LIMITS.maxPerSpace);
	const expanded = new Set<string>();
	const collapsed = new Set<string>();
	for (const row of rows) (row.open ? expanded : collapsed).add(row.blockId);
	return { expanded, collapsed };
}

/** The person's folding of a space they may read (the caller checked that). */
export async function readFoldState(
	userId: string,
	space: OutlineSpaceRow,
	store: OutlineStore = outlineStore,
): Promise<OutlineFoldStateResponse> {
	const sets = await loadFoldSets(userId, space.id, store);
	return { spaceId: space.id, expanded: [...sets.expanded], collapsed: [...sets.collapsed] };
}

/**
 * Apply changes to the person's folding of a space they may read, and answer with the state
 * after them. A block named twice takes its last change; ids that are not live blocks of the
 * space are dropped (a removal of one is harmless and kept: it deletes at most the person's
 * own row).
 */
export async function writeFoldState(
	userId: string,
	space: OutlineSpaceRow,
	changes: ReadonlyArray<{ blockId: string; open: boolean | null }>,
	options: { store?: OutlineStore; now?: string } = {},
): Promise<OutlineFoldStateResponse> {
	const store = options.store ?? outlineStore;
	const last = new Map<string, boolean | null>();
	for (const change of changes.slice(0, OUTLINE_FOLD_STATE_LIMITS.maxChanges)) {
		if (OUTLINE_BLOCK_ID_RE.test(change.blockId)) last.set(change.blockId, change.open);
	}
	const writes = [...last].flatMap(([id, open]) => (open === null ? [] : [id]));
	const live = new Set(
		writes.length === 0
			? []
			: (await store.getBlockMetas(space.id, { ids: writes }))
					.filter((block) => !block.deleted)
					.map((block) => block.id),
	);
	const kept = [...last]
		.filter(([id, open]) => open === null || live.has(id))
		.map(([blockId, open]) => ({ blockId, open }));
	if (kept.length > 0) {
		await store.putFoldState(
			userId,
			space.id,
			kept,
			options.now ?? new Date().toISOString(),
			OUTLINE_FOLD_STATE_LIMITS.maxPerSpace,
		);
	}
	return readFoldState(userId, space, store);
}

/** Blocks one reset walks up through at most, to tell which rows are under its block. */
const RESET_WALK_ROWS = 2 * OUTLINE_FOLD_STATE_LIMITS.maxPerSpace * 4;

/**
 * Put the person's folding of a space back to the default: all of it (`under` null), or that
 * of a block and everything under it. The person's own rows are at most
 * {@link OUTLINE_FOLD_STATE_LIMITS.maxPerSpace}; which of them are under the block is told by
 * walking them up together (`readOutlineAncestry`, bounded). Rows of blocks that are no longer
 * in the live tree are left alone (they apply to nothing). Answers with the state after it;
 * `incomplete` when the bounded walk could not place every row (some under the block may
 * remain).
 */
export async function resetFoldState(
	userId: string,
	space: OutlineSpaceRow,
	under: string | null,
	options: { store?: OutlineStore } = {},
): Promise<OutlineFoldStateResponse & { incomplete?: true }> {
	const store = options.store ?? outlineStore;
	if (under === null || under === space.id) {
		await store.clearFoldState(userId, space.id, null);
		return readFoldState(userId, space, store);
	}
	const rows = await store.listFoldState(userId, space.id, OUTLINE_FOLD_STATE_LIMITS.maxPerSpace);
	if (rows.length === 0) return readFoldState(userId, space, store);
	const ancestry = await readOutlineAncestry(
		space.id,
		rows.map((row) => row.blockId),
		{ maxRows: RESET_WALK_ROWS, store },
	);
	const gone = rows
		.map((row) => row.blockId)
		.filter((id) => id === under || (ancestry.above(id)?.includes(under) ?? false));
	if (gone.length > 0) await store.clearFoldState(userId, space.id, gone);
	const after = await readFoldState(userId, space, store);
	return ancestry.cutShort ? { ...after, incomplete: true } : after;
}
