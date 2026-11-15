/**
 * What is under a block, without reading what is under it (pageless outline, H2): the open
 * questions, open tasks, locks and changes waiting for confirmation in any subtree, and whether
 * anything there changed since a seq. What a closed row, a board column or a sidebar entry
 * shows of what it hides.
 *
 * CANDIDATES FIRST
 * ----------------
 * Walking a subtree costs its size (the history study: 10,000 blocks 42 ms, 100,000 blocks
 * 428 ms), and the things counted here are few in any space. So a read starts from them:
 *
 *   1. the space's open questions, open tasks, locked tasks (whatever their status: a finished
 *      task can still be locked) and open changes, each from its own index, at most
 *      {@link OUTLINE_SUBTREE_LIMITS.markCandidates} of each;
 *   2. every candidate is walked UP to the space by primary key, all of them together, in one
 *      recursive statement per 500 candidates whatever the depth (`listAncestryOf`), at most
 *      {@link OUTLINE_SUBTREE_LIMITS.markWalkRows} blocks in all;
 *   3. a candidate counts for each asked-for key among its ancestors.
 *
 * So the cost follows the number of open things and the depth of the tree, never the size of
 * the subtrees asked about, and one read answers for many keys. When the space has more
 * candidates than one read looks at, or the walk is cut short, the counts are lower bounds and
 * the result says so (`atLeast`); it never guesses.
 *
 * A candidate whose walk does not reach the top (a block on the way is deleted, missing, or of
 * another space) is not in the tree and counts nowhere.
 *
 * "Changed since" is the placements' change marks (`findSubtreeChanges`: two index probes per
 * key), and is refused like every read of history when the space cannot answer it.
 */
import { OUTLINE_SUBTREE_LIMITS, type OutlineSubtreeMarks } from "@shared/outline-subtree-api";
import { outlineStore } from "./store";
import { assertHistoryReadable } from "./store/history-port";
import type { OutlineBlockMeta, OutlineSpaceRow, OutlineStore } from "./store/port";
import { withOutlineHistory } from "./subtree-errors";

/** The live tree above some blocks, as far as a bounded walk read it. */
export interface OutlineAncestry {
	/**
	 * The strict ancestors of a block, nearest first; null when the block is not in the live
	 * tree of the space, or the walk did not reach the top.
	 */
	above(id: string): string[] | null;
	/** The block is a live block of the space (as far as the walk read). */
	has(id: string): boolean;
	/** The block is a locked task (as far as the walk read). */
	locked(id: string): boolean;
	/** The walk stopped at its row limit: some `above` are null for that reason alone. */
	cutShort: boolean;
}

/** Deeper than the tree may be (`OUTLINE_LIMITS.maxDepth`): a walk that long is a cycle. */
const MAX_WALK_DEPTH = 1024;

/**
 * Walk the given blocks up to the space, together: one recursive statement per 500 of them,
 * by primary key, whatever the depth (`listAncestryOf`), at most `maxRows` blocks in all.
 */
export async function readOutlineAncestry(
	spaceId: string,
	ids: Iterable<string>,
	options: { maxRows: number; store?: OutlineStore },
): Promise<OutlineAncestry> {
	const store = options.store ?? outlineStore;
	const asked = [...new Set(ids)];
	const parentOf = new Map<string, string | null>();
	const locked = new Set<string>();
	let cutShort = false;
	if (asked.length > 0) {
		const found = await store.listAncestryOf(spaceId, asked, options.maxRows);
		cutShort = found.truncated;
		for (const row of found.rows) {
			parentOf.set(row.id, row.parentId);
			if (row.locked) locked.add(row.id);
		}
	}
	const memo = new Map<string, string[] | null>();
	const above = (id: string): string[] | null => {
		const cached = memo.get(id);
		if (cached !== undefined) return cached;
		const chain: string[] = [];
		let result: string[] | null = parentOf.has(id) ? chain : null;
		for (let at = parentOf.get(id) ?? null; at !== null; at = parentOf.get(at) ?? null) {
			if (!parentOf.has(at) || chain.length >= MAX_WALK_DEPTH) {
				result = null;
				break;
			}
			chain.push(at);
		}
		memo.set(id, result);
		return result;
	};
	return {
		above,
		has: (id) => parentOf.has(id),
		locked: (id) => locked.has(id),
		cutShort,
	};
}

/** The things a marks read counts, as the space's indexes list them. */
interface Candidates {
	questions: string[];
	tasks: OutlineBlockMeta[];
	/** Locked tasks, whatever their status. */
	locked: string[];
	/** Per open change: the blocks it targets or adds blocks under. */
	pending: Array<{ id: string; blockIds: string[] }>;
	/** One of the lists was cut at the limit. */
	more: boolean;
}

/** The blocks an open change marks: those it targets, and those it adds blocks under. */
export function pendingTouched(row: {
	blockIdsJson: readonly string[];
	addsJson: ReadonlyArray<{ parentId: string | null }>;
}): string[] {
	return [
		...new Set([
			...row.blockIdsJson,
			...row.addsJson.flatMap((add) => (add.parentId ? [add.parentId] : [])),
		]),
	];
}

async function readCandidates(store: OutlineStore, spaceId: string): Promise<Candidates> {
	const limit = OUTLINE_SUBTREE_LIMITS.markCandidates;
	const [questions, tasks, locked, pending] = await Promise.all([
		store.listOpenQuestionsBySpaces([spaceId], limit + 1),
		store.listOpenTasks(spaceId, limit + 1),
		store.listLockedOfSpace(spaceId, limit + 1),
		store.listOpenPendingBySpace(spaceId, limit + 1),
	]);
	return {
		questions: questions.slice(0, limit).map((row) => row.blockId),
		tasks: tasks.slice(0, limit),
		locked: locked.slice(0, limit).map((row) => row.id),
		pending: pending.slice(0, limit).map((row) => ({ id: row.id, blockIds: pendingTouched(row) })),
		more:
			questions.length > limit ||
			tasks.length > limit ||
			locked.length > limit ||
			pending.length > limit,
	};
}

/**
 * The blocks of a space that have something nobody must miss strictly under them: an
 * unanswered question, a locked task (finished or not), a change waiting for confirmation.
 * What a folded read keeps open. Candidates first, as the header says; `atLeast` when it may
 * be missing some.
 */
export async function readOutlineAttention(
	space: Pick<OutlineSpaceRow, "id">,
	options: { store?: OutlineStore } = {},
): Promise<{ over: Set<string>; atLeast: boolean }> {
	const store = options.store ?? outlineStore;
	const found = await readCandidates(store, space.id);
	const starts = [
		...found.questions,
		...found.locked,
		...found.pending.flatMap((change) => change.blockIds),
	];
	const ancestry = await readOutlineAncestry(space.id, starts, {
		maxRows: OUTLINE_SUBTREE_LIMITS.markWalkRows,
		store,
	});
	const over = new Set<string>();
	for (const id of starts) for (const ancestor of ancestry.above(id) ?? []) over.add(ancestor);
	return { over, atLeast: found.more || ancestry.cutShort };
}

export interface OutlineMarksRequest {
	space: OutlineSpaceRow;
	/** Block ids of the space, or the space's id for the whole space. */
	keys: readonly string[];
	/** Also say what changed in `(since, the space's last commit]`. */
	since?: number;
	store?: OutlineStore;
}

export interface OutlineMarksResult {
	seq: number;
	marks: OutlineSubtreeMarks[];
	atLeast: boolean;
}

/**
 * What is under each of the given blocks (see the header). Keys that are not live blocks of
 * the space are left out of the result. With `since`: rejects with
 * `OutlineHistoryNotAvailableError` when the space cannot say what changed since then.
 */
export async function readOutlineMarks(request: OutlineMarksRequest): Promise<OutlineMarksResult> {
	const store = request.store ?? outlineStore;
	const { space } = request;
	const seq = space.nextSeq - 1;
	const keys = [...new Set(request.keys)].slice(0, OUTLINE_SUBTREE_LIMITS.maxMarkKeys);
	const blockKeys = keys.filter((key) => key !== space.id);
	const found = await readCandidates(store, space.id);
	const ancestry = await readOutlineAncestry(
		space.id,
		[
			...blockKeys,
			...found.questions,
			...found.tasks.map((task) => task.id),
			...found.locked,
			...found.pending.flatMap((change) => change.blockIds),
		],
		{ maxRows: OUTLINE_SUBTREE_LIMITS.markWalkRows, store },
	);

	const byKey = new Map<string, OutlineSubtreeMarks>();
	for (const key of keys) {
		if (key !== space.id && !ancestry.has(key)) continue;
		byKey.set(key, { key, questions: 0, tasks: { todo: 0, doing: 0 }, locked: 0, pending: 0 });
	}
	/** The asked-for keys a live block counts for: the space, and its ancestors among them. */
	const holders = (id: string): OutlineSubtreeMarks[] => {
		const above = ancestry.above(id);
		if (!above) return [];
		const out: OutlineSubtreeMarks[] = [];
		const whole = byKey.get(space.id);
		if (whole) out.push(whole);
		for (const ancestor of above) {
			const marks = byKey.get(ancestor);
			if (marks) out.push(marks);
		}
		return out;
	};
	for (const id of found.questions) for (const marks of holders(id)) marks.questions++;
	for (const task of found.tasks) {
		const status = task.taskJson?.status;
		for (const marks of holders(task.id)) {
			if (status === "doing") marks.tasks.doing++;
			else if (status === "todo") marks.tasks.todo++;
		}
	}
	for (const id of found.locked) for (const marks of holders(id)) marks.locked++;
	for (const change of found.pending) {
		const counted = new Set<OutlineSubtreeMarks>();
		for (const id of change.blockIds) for (const marks of holders(id)) counted.add(marks);
		for (const marks of counted) marks.pending++;
	}

	if (request.since !== undefined) {
		const since = request.since;
		await withOutlineHistory(async () => {
			const state = (await store.getHistoryStates([space.id])).get(space.id);
			if (state) assertHistoryReadable(space.id, state, since);
			const changes = await store.findSubtreeChanges(
				space.id,
				blockKeys.filter((key) => byKey.has(key)),
				{ after: since, upTo: seq },
			);
			for (const marks of byKey.values()) marks.changed = { self: false, below: false };
			for (const change of changes) {
				const marks = byKey.get(change.blockId);
				if (marks) marks.changed = { self: change.self, below: change.below };
			}
			const whole = byKey.get(space.id);
			if (whole) whole.changed = { self: false, below: seq > since };
		});
	}
	return {
		seq,
		marks: keys.flatMap((key) => {
			const marks = byKey.get(key);
			return marks ? [marks] : [];
		}),
		atLeast: found.more || ancestry.cutShort,
	};
}
