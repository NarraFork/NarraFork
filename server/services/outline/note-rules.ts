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
 * are left alone: blocks inside a plan's tree, being planned or approved (`ExitPlanMode` holds
 * the plan to its own format, `outline-plan-structure.ts`), blocks inside a subagent report, and
 * blocks under a question put to a person.
 *
 * ONE CALL, IN ORDER ({@link NoteAnchorReader})
 * --------------------------------------------
 * The edits of a call apply in order, so each is judged where its blocks will sit once the
 * edits before it have applied: a block an earlier edit made a task (or a plain block), and a
 * block an earlier edit moved, are read as that edit leaves them.
 *
 * MAIN THREAD
 * -----------
 * Small indexed reads only. The ancestor walk is one batched point read per level for all the
 * call's anchors (at most {@link NOTE_RULE_READS.maxLevels}; a block moved by the call may add
 * single point reads); a ticked task reads the metas of at
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

/**
 * Where the existing blocks of one space sit relative to a task, as the edits of one call change
 * it (see the module header). {@link prefetch} reads the ancestors of the call's anchors level by
 * level; {@link anchor} then answers from what was read.
 */
export class NoteAnchorReader {
	private readonly metas = new Map<string, OutlineBlockMeta | null>();
	/** Blocks an earlier edit of the call gave a checkbox (true) or took it from (false). */
	private readonly tasks = new Map<string, boolean>();
	/** Blocks an earlier edit of the call moved: their parent now (null: a page). */
	private readonly parents = new Map<string, string | null>();

	constructor(
		private readonly store: OutlineStore,
		private readonly spaceId: string,
	) {}

	private async load(ids: readonly string[]): Promise<void> {
		const missing = [...new Set(ids)].filter((id) => !this.metas.has(id));
		if (missing.length === 0) return;
		for (const id of missing) this.metas.set(id, null);
		for (const meta of await this.store.getBlockMetas(this.spaceId, { ids: missing }))
			this.metas.set(meta.id, meta);
	}

	/** Read the ancestors of `blockIds` as stored: one batched read per level. */
	async prefetch(blockIds: readonly string[]): Promise<void> {
		let at = [...new Set(blockIds)];
		for (let level = 0; level < NOTE_RULE_READS.maxLevels && at.length > 0; level++) {
			await this.load(at);
			const up = new Set<string>();
			for (const id of at) {
				const parent = this.metas.get(id)?.parentId;
				if (parent && !this.metas.has(parent)) up.add(parent);
			}
			at = [...up];
		}
	}

	/** An earlier edit of the call gave the block a checkbox, or took it away. */
	setTask(blockId: string, task: boolean): void {
		this.tasks.set(blockId, task);
	}

	/** An earlier edit of the call moved the block under `parentId` (null: a page). */
	move(blockId: string, parentId: string | null): void {
		this.parents.set(blockId, parentId);
	}

	/** Where `blockId` sits now, the call's earlier edits applied. */
	async anchor(blockId: string): Promise<NoteAnchor> {
		const anchor: NoteAnchor = { depth: null, skip: false };
		let at: string | null = blockId;
		for (let level = 0; at !== null && level < NOTE_RULE_READS.maxLevels; level++) {
			await this.load([at]);
			const meta: OutlineBlockMeta | null = this.metas.get(at) ?? null;
			if (!meta) break;
			if (meta.askJson || isOutlineReportBlockId(meta.id)) return { ...anchor, skip: true };
			if (this.tasks.get(at) ?? meta.taskJson !== null) {
				if (anchor.depth === null) anchor.depth = level;
				// A plan's tree, being planned or approved: the plan format's, not the note rules'.
				if (meta.taskJson?.plan) return { ...anchor, skip: true };
			}
			at = this.parents.has(at) ? (this.parents.get(at) ?? null) : meta.parentId;
		}
		return anchor;
	}
}

/** The lines of a note report, each naming its block with `at`. */
export function noteIssueLines(report: NoteWriteReport, at: (ref: string) => string): string[] {
	const text = OUTLINE_TOOL_TEXT.edit.noteRules;
	const line = (issue: NoteIssue): string => {
		if (issue.kind === "flat")
			return text.flat(at(issue.ref), issue.children, OUTLINE_NOTE_RULES.maxChildren, issue.clear);
		if (issue.kind === "heading") return text.heading(at(issue.ref));
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
			hints.push(
				text.noResult(
					id(task.sid),
					task.cancelled,
					first ? id(first.sid) : null,
					report.heading === null ? null : id(report.heading),
				),
			);
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
