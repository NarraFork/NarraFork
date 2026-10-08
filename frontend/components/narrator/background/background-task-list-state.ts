/**
 * Delta application for the background-task list.
 *
 * Pure so the decision "can this frame be applied in place, or must the client
 * refetch?" is testable without a socket, a query client, or a React tree. The
 * list used to be polled every few seconds; that request was replaced by these
 * frames, so the correctness of this function is what stands between the panel
 * and a silently stale list.
 */

import type {
	BackgroundTaskListDelta,
	BackgroundTaskListItem,
	BackgroundTaskListPage,
} from "@shared/background-task-list";
import {
	compareBackgroundTaskListItemsDesc,
	isBackgroundTaskActiveStatus,
} from "@shared/background-task-list";

/** The client's view of the list: the pages it holds plus the coordinate they sit at. */
export interface BackgroundTaskListState {
	listEpoch: string;
	version: number;
	activeCount: number;
	activeWorkCount?: number;
	activeServiceCount?: number;
	activeTasks: BackgroundTaskListItem[];
	activeTruncated: boolean;
	/** Cursor pages in load order (page 0 is newest). */
	pages: BackgroundTaskListPage[];
}

export type BackgroundTaskDeltaOutcome =
	| { kind: "applied"; state: BackgroundTaskListState }
	/** The frame carries no new information (exact duplicate). */
	| { kind: "ignored"; reason: "stale-version" | "unknown-task" }
	/** The frame cannot be applied incrementally; refetch the first page. */
	| { kind: "refetch"; reason: "epoch" | "gap" | "invalidate" | "version-reset" };

export function toBackgroundTaskListState(
	pages: BackgroundTaskListPage[],
): BackgroundTaskListState | null {
	const first = pages[0];
	if (!first) return null;
	return {
		listEpoch: first.listEpoch,
		version: first.version,
		activeCount: first.activeCount,
		activeWorkCount: first.activeWorkCount,
		activeServiceCount: first.activeServiceCount,
		activeTasks: first.activeTasks ?? [],
		activeTruncated: first.activeTruncated ?? false,
		pages,
	};
}

/** Flatten pages + active set into one de-duplicated, newest-first list. */
export function flattenBackgroundTaskList(
	state: BackgroundTaskListState | null,
): BackgroundTaskListItem[] {
	if (!state) return [];
	const byId = new Map<string, BackgroundTaskListItem>();
	// Active items come from a separate (unpaged) read and are the fresher view of
	// a row that also appears in page 0, so they are inserted first and win.
	for (const item of state.activeTasks) byId.set(item.id, item);
	for (const page of state.pages) {
		for (const item of page.tasks) if (!byId.has(item.id)) byId.set(item.id, item);
	}
	return [...byId.values()].sort(compareBackgroundTaskListItemsDesc);
}

function replaceInPages(
	pages: BackgroundTaskListPage[],
	item: BackgroundTaskListItem,
): { pages: BackgroundTaskListPage[]; found: boolean } {
	let found = false;
	const next = pages.map((page) => {
		if (!page.tasks.some((task) => task.id === item.id)) return page;
		found = true;
		return { ...page, tasks: page.tasks.map((task) => (task.id === item.id ? item : task)) };
	});
	return { pages: next, found };
}

function removeFromPages(
	pages: BackgroundTaskListPage[],
	ids: ReadonlySet<string>,
): BackgroundTaskListPage[] {
	return pages.map((page) =>
		page.tasks.some((task) => ids.has(task.id))
			? { ...page, tasks: page.tasks.filter((task) => !ids.has(task.id)) }
			: page,
	);
}

/**
 * Decide what a delta means for the state in hand.
 *
 * Order matters, and each branch fails in the safe direction (an extra HTTP
 * request) rather than the unsafe one (a list that looks fine but is missing a
 * change nobody will ever correct):
 *
 * 1. Different epoch → the server restarted. Versions from two processes are
 *    incomparable, so nothing about the cached pages can be trusted.
 * 2. `invalidate` → the server said so (bulk reap, restart recovery).
 * 3. Same version → an exact duplicate of the frame already applied; drop it.
 * 4. LOWER version → the server's counter went backwards. Within one epoch that
 *    means its per-parent version was evicted from the bounded LRU and restarted
 *    at 1. Treating this as a duplicate would silently freeze the list forever:
 *    every subsequent frame would also be "lower" and also be dropped, with no
 *    signal at all. Refetching resynchronizes at the cost of one request.
 * 5. Version skipping → a frame was lost (disconnect, buffer drop). Applying it
 *    anyway would leave the list one or more changes behind FOREVER, with no
 *    signal, because every later delta would then also look like a gap.
 */
export function applyBackgroundTaskDelta(
	state: BackgroundTaskListState | null,
	delta: BackgroundTaskListDelta,
): BackgroundTaskDeltaOutcome {
	if (!state) return { kind: "refetch", reason: "gap" };
	if (delta.listEpoch !== state.listEpoch) return { kind: "refetch", reason: "epoch" };
	if (delta.invalidate) return { kind: "refetch", reason: "invalidate" };
	if (delta.version === state.version) return { kind: "ignored", reason: "stale-version" };
	if (delta.version < state.version) return { kind: "refetch", reason: "version-reset" };
	if (delta.version !== state.version + 1) return { kind: "refetch", reason: "gap" };

	let pages = state.pages;
	let activeTasks = state.activeTasks;

	if (delta.removeIds && delta.removeIds.length > 0) {
		const ids = new Set(delta.removeIds);
		pages = removeFromPages(pages, ids);
		activeTasks = activeTasks.filter((task) => !ids.has(task.id));
	}

	if (delta.upsert) {
		const item = delta.upsert;
		const replaced = replaceInPages(pages, item);
		pages = replaced.pages;
		const isActive = isBackgroundTaskActiveStatus(item.effectiveStatus);
		const wasActive = activeTasks.some((task) => task.id === item.id);
		if (isActive) {
			activeTasks = wasActive
				? activeTasks.map((task) => (task.id === item.id ? item : task))
				: [item, ...activeTasks].sort(compareBackgroundTaskListItemsDesc);
		} else if (wasActive) {
			activeTasks = activeTasks.filter((task) => task.id !== item.id);
		}
		if (!replaced.found) {
			// A row absent from every loaded page: either brand new, or older than the
			// window the client has scrolled. Insert into page 0 only when it sorts
			// within that page's range — appending an older row to page 0 would place
			// it before rows the client has not loaded yet, i.e. out of order.
			const firstPage = pages[0];
			if (firstPage) {
				const oldestLoaded = firstPage.tasks.at(-1);
				const belongsHere =
					!oldestLoaded ||
					compareBackgroundTaskListItemsDesc(item, oldestLoaded) <= 0 ||
					firstPage.nextCursor === null;
				if (belongsHere) {
					pages = [
						{
							...firstPage,
							tasks: [...firstPage.tasks, item].sort(compareBackgroundTaskListItemsDesc),
						},
						...pages.slice(1),
					];
				}
			}
		}
	}

	// Page 0 is the authoritative carrier of the list coordinate, because that is
	// where a refetch writes it. It is rewritten unconditionally — a state whose
	// version advanced while page 0 still reported the old one would make the next
	// `toBackgroundTaskListState` read (after any cache round-trip) regress.
	const nextPages = pages.map((page, index) =>
		index === 0
			? {
					...page,
					version: delta.version,
					activeCount: delta.activeCount,
					activeWorkCount: delta.activeWorkCount,
					activeServiceCount: delta.activeServiceCount,
					activeTasks,
					activeTruncated: state.activeTruncated,
				}
			: page,
	);

	return {
		kind: "applied",
		state: {
			...state,
			version: delta.version,
			activeCount: delta.activeCount,
			activeWorkCount: delta.activeWorkCount,
			activeServiceCount: delta.activeServiceCount,
			activeTasks,
			pages: nextPages,
		},
	};
}
