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

/** Writers whose last applied write is remembered (see {@link writeFoldState}). */
const MAX_WRITERS = 10_000;
/** The last write applied, by `user, space, writer`: an older one arriving later is ignored. */
const lastApplied = new Map<string, number>();

/** Whether write `n` of a writer is newer than every one applied; if so it is taken now. */
function takeTurn(userId: string, spaceId: string, writer: string, n: number): boolean {
	const key = `${userId}\u0000${spaceId}\u0000${writer}`;
	const last = lastApplied.get(key);
	if (last !== undefined && n <= last) return false;
	// (Re-inserted: the map's order is the order writers were last heard from.)
	lastApplied.delete(key);
	lastApplied.set(key, n);
	while (lastApplied.size > MAX_WRITERS) {
		const oldest = lastApplied.keys().next().value;
		if (oldest === undefined) break;
		lastApplied.delete(oldest);
	}
	return true;
}

/** Forget the writers seen (tests). */
export function resetFoldWritersForTests(): void {
	lastApplied.clear();
}

/** Blocks one reset walks up through at most, to tell which rows are under its block. */
const RESET_WALK_ROWS = 2 * OUTLINE_FOLD_STATE_LIMITS.maxPerSpace * 4;

/**
 * Which of the person's stored rows are a block of `unders` or under one: the rows (at most
 * {@link OUTLINE_FOLD_STATE_LIMITS.maxPerSpace}) are walked up together (`readOutlineAncestry`,
 * bounded). Rows of blocks no longer in the live tree are left alone (they apply to nothing).
 * `incomplete`: the walk stopped before placing every row.
 */
async function rowsUnder(
	userId: string,
	space: OutlineSpaceRow,
	unders: ReadonlySet<string>,
	store: OutlineStore,
): Promise<{ ids: string[]; incomplete: boolean }> {
	const rows = await store.listFoldState(userId, space.id, OUTLINE_FOLD_STATE_LIMITS.maxPerSpace);
	if (rows.length === 0 || unders.size === 0) return { ids: [], incomplete: false };
	const ancestry = await readOutlineAncestry(
		space.id,
		rows.map((row) => row.blockId),
		{ maxRows: RESET_WALK_ROWS, store },
	);
	const ids = rows
		.map((row) => row.blockId)
		.filter((id) => unders.has(id) || (ancestry.above(id)?.some((up) => unders.has(up)) ?? false));
	return { ids, incomplete: ancestry.cutShort };
}

/**
 * Apply a write to the person's folding of a space they may read, and answer with the state
 * after it. In ONE store transaction: first the resets (`reset`: null or the space's id puts
 * the whole space back to the default; a block, it and everything under it), then the changes.
 * A block named twice takes its last change; ids that are not live blocks of the space are
 * dropped (a removal of one is harmless and kept: it deletes at most the person's own row).
 *
 * ORDER: a client names itself (`writer`, one per view) and numbers its writes (`n`, rising).
 * A write numbered at or below one already applied for that person, space and writer is
 * ignored (`ignored: true`): a request sent as a page went away may overtake one still on its
 * way, and the older must not land last. Remembered in memory for the
 * {@link MAX_WRITERS} writers heard from last (a restart forgets: the window it leaves is a
 * request in flight across a restart). Writes without a writer are applied as they come.
 */
export async function writeFoldState(
	userId: string,
	space: OutlineSpaceRow,
	changes: ReadonlyArray<{ blockId: string; open: boolean | null }>,
	options: {
		reset?: ReadonlyArray<string | null>;
		writer?: string;
		n?: number;
		store?: OutlineStore;
		now?: string;
	} = {},
): Promise<OutlineFoldStateResponse & { ignored?: true }> {
	const store = options.store ?? outlineStore;
	if (
		options.writer !== undefined &&
		options.n !== undefined &&
		!takeTurn(userId, space.id, options.writer, options.n)
	) {
		return { ...(await readFoldState(userId, space, store)), ignored: true };
	}
	const resets = (options.reset ?? []).slice(0, OUTLINE_FOLD_STATE_LIMITS.maxResets);
	const all = resets.some((under) => under === null || under === space.id);
	const unders = new Set(
		resets.filter((under): under is string => under !== null && OUTLINE_BLOCK_ID_RE.test(under)),
	);
	const cleared = all
		? { ids: [], incomplete: false }
		: await rowsUnder(userId, space, unders, store);
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
	if (kept.length > 0 || all || cleared.ids.length > 0) {
		await store.putFoldState(
			userId,
			space.id,
			kept,
			options.now ?? new Date().toISOString(),
			OUTLINE_FOLD_STATE_LIMITS.maxPerSpace,
			all ? { all: true } : cleared.ids.length > 0 ? { ids: cleared.ids } : undefined,
		);
	}
	const after = await readFoldState(userId, space, store);
	return cleared.incomplete ? { ...after, incomplete: true } : after;
}

/**
 * Put the person's folding of a space back to the default: all of it (`under` null), or that
 * of a block and everything under it (see {@link rowsUnder}). Answers with the state after it;
 * `incomplete` when the bounded walk could not place every row.
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
	const gone = await rowsUnder(userId, space, new Set([under]), store);
	if (gone.ids.length > 0) await store.clearFoldState(userId, space.id, gone.ids);
	const after = await readFoldState(userId, space, store);
	return gone.incomplete ? { ...after, incomplete: true } : after;
}
