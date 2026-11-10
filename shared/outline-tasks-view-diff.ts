/**
 * What changed between two injections of an outline session's current-tasks view.
 *
 * The view's `context_update` row used to say only "Current tasks updated" beside the list as it
 * is now. Each row now carries a small state table (`OutlineTasksViewDisplay.states`: the open
 * tasks by address under doing / delegated / waiting / to-do), and the next row is compared with
 * it: the comparison is between what the session was SHOWN, never with a read cache.
 *
 * Two steps, both pure and bounded by the tables (at most 60 addresses each):
 *
 *   1. {@link diffOutlineTasksViews}: the tasks whose state differs. A task that left the list is
 *      `gone`: the tables cannot say whether it was finished, cancelled or deleted.
 *   2. {@link settleOutlineTasksViewChanges}: with what the server read of a few of those tasks
 *      (their fate and title), the changes a row stores: the first few named, all of them counted.
 *
 * Identity is the task's address (`key/sid`), so a renamed or moved task is the same task: a move
 * is no change, a new title is `renamed` when both views listed the task.
 *
 * A table that is not every open task (`statesMore`) never proves absence: a task missing from a
 * cut PREVIOUS table is not reported as added, and one missing from a cut NEXT table is reported
 * only when its block says it is finished or gone.
 *
 * Zero DOM, no server imports.
 */

import {
	OUTLINE_TASKS_VIEW_CHANGE_KINDS,
	OUTLINE_TASKS_VIEW_DISPLAY_LIMITS,
	OUTLINE_TASKS_VIEW_STATES,
	type OutlineTasksViewChange,
	type OutlineTasksViewChangeKind,
	type OutlineTasksViewDisplay,
	type OutlineTasksViewState,
} from "./outline-task-notice";

/** One task whose state differs between the two views. */
export interface OutlineTasksViewDelta {
	address: string;
	/** `gone`: it left the list; its block says what became of it. */
	kind: OutlineTasksViewChangeKind | "gone";
	from?: OutlineTasksViewState;
	/** Its title, when one of the two views listed it. */
	title?: string;
	/**
	 * `gone` only: false when the next table is cut, so the task may simply be past the cut. It is
	 * then a change only if its block says so.
	 */
	sure?: boolean;
}

/** What the server read of a task a delta names. */
export interface OutlineTasksViewFact {
	/** `open`: still an open task; `removed`: deleted, or no longer a task. */
	fate?: "done" | "cancelled" | "removed" | "open";
	title?: string;
}

interface Table {
	states: Map<string, OutlineTasksViewState>;
	more: boolean;
	titles: Map<string, string>;
}

/** A view's table; null when it has none (a row written before tables existed). */
function tableOf(view: OutlineTasksViewDisplay | null): Table | null {
	const states = new Map<string, OutlineTasksViewState>();
	const titles = new Map<string, string>();
	// A removed view is a known, empty list.
	if (view === null) return { states, more: false, titles };
	if (!view.states) return null;
	for (const state of OUTLINE_TASKS_VIEW_STATES) {
		for (const address of view.states[state] ?? []) {
			if (!states.has(address)) states.set(address, state);
		}
	}
	for (const task of [...view.doing, ...(view.delegated ?? []), ...view.waiting, ...view.next]) {
		if (task.address && task.title) titles.set(task.address, task.title);
	}
	return { states, more: view.statesMore === true, titles };
}

/** What a task that was `from` and is now `to` did (they differ). */
function transition(
	from: OutlineTasksViewState,
	to: OutlineTasksViewState,
): OutlineTasksViewChangeKind {
	if (to === "delegated") return "delegated";
	if (to === "waiting") return "waiting";
	if (from === "delegated") return "returned";
	if (to === "doing") return "started";
	return from === "waiting" ? "unblocked" : "requeued";
}

/** What a task not listed before did by being `to` now; null when a cut table cannot tell. */
function arrival(to: OutlineTasksViewState, cut: boolean): OutlineTasksViewChangeKind | null {
	if (to === "doing") return "started";
	if (to === "delegated") return "delegated";
	// Past the cut of the previous table it was a to-do already, or it is new: only the cut knows.
	if (cut) return to === "waiting" ? "waiting" : null;
	return "added";
}

/**
 * The tasks whose state differs between `previous` and `next` (either may be `null`: the view was
 * removed, no task was open), in the order of `next` and then of `previous`. Null when either has
 * no state table: there is nothing to compare.
 */
export function diffOutlineTasksViews(
	previous: OutlineTasksViewDisplay | null,
	next: OutlineTasksViewDisplay | null,
): OutlineTasksViewDelta[] | null {
	const before = tableOf(previous);
	const after = tableOf(next);
	if (!before || !after) return null;
	const out: OutlineTasksViewDelta[] = [];
	for (const [address, to] of after.states) {
		const from = before.states.get(address);
		const title = after.titles.get(address);
		let kind: OutlineTasksViewChangeKind | null;
		if (from === undefined) kind = arrival(to, before.more);
		else if (from !== to) kind = transition(from, to);
		else {
			const old = before.titles.get(address);
			kind = old !== undefined && title !== undefined && old !== title ? "renamed" : null;
		}
		if (!kind) continue;
		out.push({
			address,
			kind,
			...(from !== undefined ? { from } : {}),
			...(title !== undefined ? { title } : {}),
		});
	}
	for (const [address, from] of before.states) {
		if (after.states.has(address)) continue;
		const title = before.titles.get(address);
		out.push({
			address,
			kind: "gone",
			from,
			...(title !== undefined ? { title } : {}),
			sure: !after.more,
		});
	}
	return out;
}

/**
 * The deltas whose blocks are worth reading, at most `limit`: the tasks that left the list first
 * (only their block says whether they were finished), then those no view titled.
 */
export function outlineTasksViewDeltasToRead(
	deltas: readonly OutlineTasksViewDelta[],
	limit: number = OUTLINE_TASKS_VIEW_DISPLAY_LIMITS.changes,
): string[] {
	const gone = deltas.filter((delta) => delta.kind === "gone");
	const untitled = deltas.filter((delta) => delta.kind !== "gone" && delta.title === undefined);
	return [...gone, ...untitled].slice(0, limit).map((delta) => delta.address);
}

const KIND_ORDER = new Map(OUTLINE_TASKS_VIEW_CHANGE_KINDS.map((kind, index) => [kind, index]));

/**
 * The changes a row stores: every delta settled with what was read of it, the most telling kinds
 * first; `changes` names the first few that have a title, `changed` counts them all.
 *
 * A task that left the list is `done` / `cancelled` / `removed` as its block says; still open, or
 * not read, it is `unlisted` when the next table is whole and no change at all when it is cut.
 */
export function settleOutlineTasksViewChanges(
	deltas: readonly OutlineTasksViewDelta[],
	facts: ReadonlyMap<string, OutlineTasksViewFact> = new Map(),
): { changes: OutlineTasksViewChange[]; changed: number } {
	const settled: Array<Omit<OutlineTasksViewChange, "title"> & { title?: string }> = [];
	for (const delta of deltas) {
		const fact = facts.get(delta.address);
		let kind: OutlineTasksViewChangeKind;
		if (delta.kind !== "gone") kind = delta.kind;
		else if (fact?.fate && fact.fate !== "open") kind = fact.fate;
		else if (delta.sure) kind = "unlisted";
		else continue;
		const title = fact?.title || delta.title;
		settled.push({
			address: delta.address,
			kind,
			...(delta.from ? { from: delta.from } : {}),
			...(title ? { title } : {}),
		});
	}
	const order = (kind: OutlineTasksViewChangeKind) => KIND_ORDER.get(kind) ?? KIND_ORDER.size;
	// Stable: within a kind, the order of the views.
	const ranked = settled
		.map((change, index) => ({ change, index }))
		.sort((a, b) => order(a.change.kind) - order(b.change.kind) || a.index - b.index)
		.map(({ change }) => change);
	return {
		changes: ranked
			.filter((change): change is OutlineTasksViewChange => !!change.title)
			.slice(0, OUTLINE_TASKS_VIEW_DISPLAY_LIMITS.changes),
		changed: ranked.length,
	};
}
