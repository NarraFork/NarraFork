/**
 * Pure helpers of the read-only outline pages: the URL search of a block page, a view as the
 * tree its folding is worked out on, and stepping through a page's timeline. No React, no
 * requests.
 */
import type {
	OutlineBlockViewResponse,
	OutlineCommitSummary,
	OutlineSpaceSummary,
	OutlineViewMode,
} from "@shared/outline-api";
import { buildFoldTree, type FoldSource, type FoldTree, type FoldView } from "@shared/outline-fold";
import { isOutlineReportContainer } from "@shared/outline-report-line";

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

/**
 * A view's blocks as the tree the default folding reads (`@shared/outline-fold`): the children a
 * read loaded, each block's task and whether it is a subagent report's container, and its own
 * marks (an unanswered question, a change waiting for confirmation, a lock).
 */
export function viewFoldSource(view: Pick<OutlineBlockViewResponse, "blocks">): FoldSource {
	const byId = new Map(view.blocks.map((block) => [block.id, block]));
	return {
		children: (id) => byId.get(id)?.childIds ?? [],
		task: (id) => byId.get(id)?.task?.status ?? null,
		report: (id) => {
			const block = byId.get(id);
			return !!block && isOutlineReportContainer(block.id, block.content);
		},
		heading: (id) => /^#{1,6}\s/.test(byId.get(id)?.content ?? ""),
		marks: (id) => {
			const block = byId.get(id);
			if (!block) return null;
			const question = block.question?.state === "open" ? 1 : 0;
			const pending = block.pending.length > 0 ? 1 : 0;
			const locked = block.lock ? 1 : 0;
			return question || pending || locked ? { question, pending, locked } : null;
		},
	};
}

/** The tree of a view with the reader's folding over the default (`@shared/outline-fold`). */
export function viewFoldTree(
	view: Pick<OutlineBlockViewResponse, "blocks" | "rootId" | "rootInTask">,
	source: FoldSource,
	fold: FoldView,
): FoldTree {
	return buildFoldTree(source, { rootId: view.rootId, rootDetail: view.rootInTask === true }, fold);
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
