/**
 * The reads `OutlineEdit` makes for the note rules (`@shared/outline-note-structure`; task tree
 * readability PR D): where the blocks a call writes sit relative to a task, and what is directly
 * under a task the call ticks off. The rules themselves are pure and live in the shared module;
 * the wording is `OUTLINE_TOOL_TEXT.edit.noteRules`.
 *
 * WHO IS NOT HELD TO THEM ({@link NoteAnchor.skip})
 * ------------------------------------------------
 * Only an agent's `OutlineEdit` calls this at all: people's edits, the system's writes (a report
 * attached under a task, an import, a lease note) never pass here. Of an agent's writes, these
 * are left alone: blocks inside a plan still being planned (`ExitPlanMode` holds the plan to its
 * own format, `outline-plan-structure.ts`), blocks inside a subagent report, and blocks under a
 * question put to a person.
 *
 * MAIN THREAD
 * -----------
 * Small indexed reads only. The ancestor walk is one batched point read per level for all the
 * call's anchors (at most {@link NOTE_RULE_READS.maxLevels}); a ticked task reads the metas of at
 * most {@link OUTLINE_NOTE_RULES.tidyChildren} + 1 children and the first
 * {@link OUTLINE_NOTE_RULES.tidyHeadChars} characters of the notes among them, for at most
 * {@link NOTE_RULE_READS.maxTicked} tasks a call. No block body is read whole.
 */
import { compareOrderKeys } from "@shared/outline";
import {
	type NoteIssue,
	type NoteWriteReport,
	noteBlockLimit,
	OUTLINE_NOTE_RULES,
	taskResultCheck,
} from "@shared/outline-note-structure";
import { isOutlineReportBlockId } from "@shared/outline-report-line";
import { OUTLINE_TOOL_TEXT } from "./messages";
import type { OutlineBlockMeta, OutlineStore } from "./store/port";

export const NOTE_RULE_READS = {
	/** Levels walked up from a block; deeper than this, no task is looked for. */
	maxLevels: 64,
	/** Tasks ticked off in one call that get a hint. */
	maxTicked: 5,
} as const;

/** Where an existing block sits, for the blocks a call writes at it. */
export interface NoteAnchor {
	/** Distance to the nearest task: 0 when the block is one, null when no task is above it. */
	depth: number | null;
	/** Not held to the note rules (see the module header). */
	skip: boolean;
}

/** {@link NoteAnchor} of each of `blockIds` (blocks of `spaceId`). */
export async function noteAnchors(
	store: OutlineStore,
	spaceId: string,
	blockIds: readonly string[],
): Promise<Map<string, NoteAnchor>> {
	const metas = new Map<string, OutlineBlockMeta | null>();
	const walks = blockIds.map((id) => ({
		id,
		at: id as string | null,
		level: 0,
		anchor: { depth: null, skip: false } as NoteAnchor,
	}));
	for (let level = 0; level < NOTE_RULE_READS.maxLevels; level++) {
		const active = walks.filter((w) => w.at !== null && !w.anchor.skip);
		if (active.length === 0) break;
		const missing = [...new Set(active.map((w) => w.at as string))].filter((id) => !metas.has(id));
		if (missing.length > 0) {
			for (const id of missing) metas.set(id, null);
			for (const meta of await store.getBlockMetas(spaceId, { ids: missing }))
				metas.set(meta.id, meta);
		}
		for (const walk of active) {
			const meta = metas.get(walk.at as string);
			if (!meta) {
				walk.at = null;
				continue;
			}
			if (meta.askJson || isOutlineReportBlockId(meta.id)) walk.anchor.skip = true;
			if (meta.taskJson) {
				if (walk.anchor.depth === null) walk.anchor.depth = walk.level;
				if (meta.taskJson.plan?.state === "planning") walk.anchor.skip = true;
			}
			walk.at = meta.parentId;
			walk.level++;
		}
	}
	return new Map(walks.map((w) => [w.id, w.anchor]));
}

/** The lines of a note report, each naming its block with `at`. */
export function noteIssueLines(report: NoteWriteReport, at: (ref: string) => string): string[] {
	const text = OUTLINE_TOOL_TEXT.edit.noteRules;
	const line = (issue: NoteIssue): string => {
		if (issue.kind === "flat")
			return text.flat(at(issue.ref), issue.children, OUTLINE_NOTE_RULES.maxChildren, issue.clear);
		const limit = noteBlockLimit(issue.role);
		if (issue.role === "title")
			return text.longTitle(at(issue.ref), issue.chars, issue.lines, limit);
		return issue.role === "note"
			? text.longNote(at(issue.ref), issue.chars, limit)
			: text.longDetail(at(issue.ref), issue.chars, limit);
	};
	const lines = report.issues.map(line);
	const more = report.total - report.issues.length;
	if (more > 0) lines.push(text.more(more));
	return lines;
}

/** A task a call ticked done or cancelled. */
export interface TickedTask {
	id: string;
	sid: string;
	cancelled: boolean;
}

/**
 * What the result of a call says about the tasks it ticked off (read after the write, so a
 * result the same call added counts): a task with no result line, notes too long to fold, a
 * flat pile of notes. The write stands either way.
 */
export async function finishedTaskHints(
	store: OutlineStore,
	spaceId: string,
	tasks: readonly TickedTask[],
	/** How a block of the space is named. */
	id: (sid: string) => string,
): Promise<string[]> {
	const text = OUTLINE_TOOL_TEXT.edit.noteRules;
	const limit = OUTLINE_NOTE_RULES.tidyChildren;
	const hints: string[] = [];
	for (const task of tasks.slice(0, NOTE_RULE_READS.maxTicked)) {
		const read = await store.listChildMetas(spaceId, [task.id], limit + 1);
		const more = read.length > limit;
		const children = [...read]
			.sort((a, b) => compareOrderKeys(a.orderKey, b.orderKey) || (a.id < b.id ? -1 : 1))
			.slice(0, limit);
		const isOther = (m: OutlineBlockMeta) =>
			m.taskJson !== null || m.askJson !== null || isOutlineReportBlockId(m.id);
		const notes = children.filter((m) => !isOther(m));
		const heads =
			notes.length > 0
				? await store.getContentHeads(
						notes.map((m) => m.id),
						OUTLINE_NOTE_RULES.tidyHeadChars,
					)
				: new Map<string, string>();
		const report = taskResultCheck(
			children.map((m) => ({ ref: m.sid, head: heads.get(m.id) ?? "", other: isOther(m) })),
			more,
		);
		// Not all children were read, in no order: a result may be among the others.
		if (!report.hasResult && !more) {
			const first = children[0];
			hints.push(text.noResult(id(task.sid), task.cancelled, first ? id(first.sid) : null));
		}
		if (report.long.length > 0)
			hints.push(
				text.tidyLong(
					id(task.sid),
					report.long.map((b) => text.tidyBlock(id(b.ref), b.chars)),
					report.longTotal - report.long.length,
					OUTLINE_NOTE_RULES.noteChars,
				),
			);
		if (report.flat !== null)
			hints.push(text.tidyFlat(id(task.sid), report.flat, more, OUTLINE_NOTE_RULES.maxChildren));
	}
	return hints;
}
