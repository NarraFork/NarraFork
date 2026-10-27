/**
 * Pure helpers of the read-only outline pages: the URL search of a block page, the rows a
 * collapsed tree shows, and stepping through a page's timeline. No React, no requests.
 */
import type {
	OutlineBlockViewResponse,
	OutlineCommitSummary,
	OutlineSpaceSummary,
	OutlineViewBlock,
	OutlineViewMode,
} from "@shared/outline-api";

export interface OutlineBlockSearch {
	/** Commit seq to show the page as of; absent for the current state. */
	asOf?: number;
	/** Absent means the facts view, the default. */
	view?: OutlineViewMode;
}

/** The block page's search params, keeping only well-formed values. */
export function parseOutlineBlockSearch(raw: Record<string, unknown>): OutlineBlockSearch {
	const out: OutlineBlockSearch = {};
	const asOf = typeof raw.asOf === "string" ? Number(raw.asOf) : raw.asOf;
	if (typeof asOf === "number" && Number.isSafeInteger(asOf) && asOf >= 0) out.asOf = asOf;
	if (raw.view === "all") out.view = "all";
	return out;
}

export interface OutlineRow {
	block: OutlineViewBlock;
	depth: number;
	/** The block has children in this view, shown or not. */
	hasChildren: boolean;
	collapsed: boolean;
}

/**
 * The rows of a view, depth first from its root, leaving out what is under a collapsed block.
 * The root itself is the page's heading and is not a row.
 */
export function visibleRows(
	view: Pick<OutlineBlockViewResponse, "blocks" | "rootId">,
	collapsed: ReadonlySet<string>,
): OutlineRow[] {
	const byId = new Map(view.blocks.map((block) => [block.id, block]));
	const root = byId.get(view.rootId);
	if (!root) return [];
	const rows: OutlineRow[] = [];
	// An explicit stack keeps deep outlines off the call stack.
	const stack: Array<{ id: string; depth: number }> = [];
	for (let i = root.childIds.length - 1; i >= 0; i--) {
		stack.push({ id: root.childIds[i] as string, depth: 0 });
	}
	while (stack.length > 0) {
		const { id, depth } = stack.pop() as { id: string; depth: number };
		const block = byId.get(id);
		if (!block) continue;
		const hasChildren = block.childIds.length > 0 || block.hidden > 0;
		const isCollapsed = hasChildren && collapsed.has(id);
		rows.push({ block, depth, hasChildren, collapsed: isCollapsed });
		if (isCollapsed) continue;
		for (let i = block.childIds.length - 1; i >= 0; i--) {
			stack.push({ id: block.childIds[i] as string, depth: depth + 1 });
		}
	}
	return rows;
}

/** Commits from newest-first pages, oldest first, without duplicates. */
export function timelineOldestFirst(
	pages: ReadonlyArray<{ commits: readonly OutlineCommitSummary[] }>,
): OutlineCommitSummary[] {
	const seen = new Set<number>();
	const out: OutlineCommitSummary[] = [];
	for (const page of pages) {
		for (const commit of page.commits) {
			if (seen.has(commit.seq)) continue;
			seen.add(commit.seq);
			out.push(commit);
		}
	}
	return out.sort((a, b) => a.seq - b.seq);
}

/**
 * The commit a view as of `seq` stands on (the newest at or before it), and its neighbours.
 * With no `seq` (the current state) the selected commit is the newest one.
 */
export function timelinePosition(
	commits: readonly OutlineCommitSummary[],
	seq: number | undefined,
): {
	selected: OutlineCommitSummary | null;
	previous: OutlineCommitSummary | null;
	next: OutlineCommitSummary | null;
} {
	let index = commits.length - 1;
	if (seq !== undefined) {
		index = -1;
		for (let i = 0; i < commits.length; i++) {
			if ((commits[i] as OutlineCommitSummary).seq <= seq) index = i;
			else break;
		}
	}
	return {
		selected: index >= 0 ? (commits[index] ?? null) : null,
		previous: index > 0 ? (commits[index - 1] ?? null) : null,
		next: index + 1 < commits.length ? (commits[index + 1] ?? null) : null,
	};
}

/** The i18n key and values naming a space: its owner's name when it has one. */
export function spaceLabelKey(
	space: Pick<OutlineSpaceSummary, "kind" | "label" | "mine" | "orphaned">,
): {
	key: string;
	values?: Record<string, string>;
} {
	if (space.kind === "personal") {
		return { key: space.mine ? "space.personalMine" : "space.personalOther" };
	}
	if (space.orphaned || !space.label) {
		return { key: space.kind === "project" ? "space.projectUnnamed" : "space.sessionUnnamed" };
	}
	return {
		key: space.kind === "project" ? "space.project" : "space.session",
		values: { name: space.label },
	};
}
