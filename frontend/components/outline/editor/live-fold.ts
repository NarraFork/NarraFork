/**
 * A live page as the tree the default folding reads (`@shared/outline-fold`): the live editor's
 * outline views and the mind map fold the page the read-only tree does, from the page's live
 * session instead of an HTTP read.
 *
 * Pure reads of the session's block store and texts; nothing is kept.
 */
import type { FoldMarks, FoldSource } from "@shared/outline-fold";
import { LIVE_STATUS_OF_TASK } from "@shared/outline-live-protocol";
import { isOutlineReportBlockId, isOutlineReportContainer } from "@shared/outline-report-line";
import type { BlockMark } from "./chrome";
import type { LiveClient } from "./live-client";

export interface LiveFoldOptions {
	/**
	 * Blocks the view leaves out (the facts view: tasks, and in the outline questions put to
	 * people): they and what is under them are not part of the tree.
	 */
	omit?: (id: string) => boolean;
	/** Locks, pending changes and unanswered questions of the page's blocks. */
	marks: ReadonlyMap<string, BlockMark>;
}

/** The page's live blocks as a fold source. */
export function liveFoldSource(client: LiveClient, options: LiveFoldOptions): FoldSource {
	const v = client.visible;
	const { omit, marks } = options;
	return {
		children: (id) => {
			const kids = v.children(id);
			return omit ? kids.filter((kid) => !omit(kid)) : kids;
		},
		task: (id) => {
			const task = v.get(id)?.task;
			return task ? LIVE_STATUS_OF_TASK[task] : null;
		},
		// By id first: the text is read only for a block that is not one by its id.
		report: (id) => isOutlineReportBlockId(id) || isOutlineReportContainer(id, client.textOf(id)),
		heading: (id) => /^#{1,6}\s/.test(client.textOf(id)),
		marks: (id) => {
			const mark = marks.get(id);
			if (!mark) return null;
			const own: Partial<FoldMarks> = {};
			if (mark.openQuestion) own.question = 1;
			if (mark.pending?.length) own.pending = 1;
			if (mark.lockedBy) own.locked = 1;
			return own;
		},
	};
}

/** Whether a block sits under a task or inside a subagent report (its ancestors say). */
export function liveUnderTask(client: LiveClient, id: string): boolean {
	const v = client.visible;
	let cur = v.get(id)?.parentId ?? null;
	for (let guard = 0; cur && guard < 10_000; guard++) {
		const rec = v.get(cur);
		if (!rec) return false;
		if (rec.task || isOutlineReportBlockId(cur)) return true;
		cur = rec.parentId;
	}
	return false;
}
