/**
 * How an agent writes under a task (task tree readability, PR D; decision D53). The shape, top to
 * bottom — conclusion, then evidence, then detail:
 *
 *   - [/] A task title, one line                   ← says what "done" is
 *     - The conclusion in one line                 ← the task's first block: its result
 *       - The evidence: file:line, commands run    ← under the conclusion
 *         - Details worth keeping                  ← deeper still
 *     - Another conclusion …
 *     - [ ] A subtask
 *
 * A finished task folds to its title and ONE line, the first note under it
 * (`outline-fold.ts`, `foldPreview`), and every note under a task folds to one preview line: a
 * note that opens on its conclusion reads folded, a paragraph of process does not.
 *
 * Three things use these rules, with the same numbers ({@link OUTLINE_NOTE_RULES}, which takes
 * them from the plan format's table, `OUTLINE_PLAN_STRUCTURE`):
 *
 *   - the prompts state them (`server/lib/prompts/outline-tasks.ts`, the `OutlineEdit` tool's
 *     description, the instructions a delegated subagent gets);
 *   - `OutlineEdit` checks what a call WRITES under a task ({@link noteWriteIssues}): only the
 *     blocks the call adds or rewrites, never what was already there, and only an agent's writes;
 *   - ticking a task done or cancelled checks what is directly under it ({@link taskResultCheck})
 *     and asks for the one-line result when there is none.
 *
 * WARN OR REFUSE ({@link OUTLINE_NOTE_RULES.mode})
 * -----------------------------------------------
 * A write that is clearly over the limit (`clear` on its issue: a first-level note past
 * {@link OUTLINE_NOTE_RULES.clearNoteChars}, more than {@link OUTLINE_NOTE_RULES.maxChildren}
 * blocks added directly under one task by one call) is refused in mode `reject`: nothing is
 * written. In mode `warn` — the first version — it is written like any other, and the result
 * says what is over and how to restructure it. Everything else is only ever a hint. Ticking a
 * task done is never refused for want of a result line, in either mode.
 *
 * Text is counted as the plan format counts it (`planBlockText`, `planTextChars`): what a reader
 * sees, one per character whatever the script; code blocks and tables are not prose and are not
 * held to the length limits. One thing more than the plan format: a bare URL counts as a link's
 * label would ({@link OUTLINE_NOTE_RULES.urlChars} characters at most), since a reader takes it
 * in as one thing and an agent cannot shorten it ({@link noteTextChars}).
 *
 * HEADINGS
 * --------
 * A heading under a task is kept as written and named as an issue (never a clear one): under a
 * task the levels are the indentation, and a heading that stands first is a label, not the
 * task's result ({@link taskResultCheck} does not take it for one).
 *
 * Pure: no database, no DOM. Content is the block's canonical dialect markdown.
 */
import { parseBlock } from "./outline/dialect";
import { OUTLINE_PLAN_STRUCTURE, planBlockText, planTextChars } from "./outline-plan-structure";

/** What a clearly over-limit write gets: written with a warning, or refused. */
export type OutlineNoteRulesMode = "warn" | "reject";

export const OUTLINE_NOTE_RULES = {
	/**
	 * `warn`: every write succeeds and the result names what is over the limit. `reject`: a write
	 * with a `clear` issue writes nothing. Changing this one value is the whole switch.
	 */
	mode: "warn" as OutlineNoteRulesMode,
	/** Characters of a task's title, which is one line. */
	titleChars: OUTLINE_PLAN_STRUCTURE.pointChars,
	/** Characters of a note directly under a task (a conclusion: one line folded). */
	noteChars: OUTLINE_PLAN_STRUCTURE.pointChars,
	/** Characters of a block deeper under a task (evidence, detail). */
	detailChars: OUTLINE_PLAN_STRUCTURE.detailChars,
	/** Characters past which a note directly under a task is clearly over (five times its limit). */
	clearNoteChars: OUTLINE_PLAN_STRUCTURE.pointChars * 5,
	/** Blocks one call adds directly under one block. */
	maxChildren: OUTLINE_PLAN_STRUCTURE.maxChildren,
	/** Characters a bare URL counts as at most. */
	urlChars: 24,
	/** Issues one result names (the rest are counted). */
	listed: 8,
	/** Blocks a finished task's hint names. */
	tidyListed: 5,
	/** Direct children of a finished task that are looked at. */
	tidyChildren: 30,
	/** Characters of a child's content read for that (more is long whatever it says). */
	tidyHeadChars: 2000,
} as const;

/** A block a call writes, as the check sees it. */
export interface NoteWriteBlock {
	/** How the caller names the block (an id, an address): handed back on its issues. */
	ref: string;
	/** The block's dialect markdown as it will be stored. */
	content: string;
	/** It has a checkbox (as written, or kept from before on a rewrite). */
	task: boolean;
	/** The blocks the call adds under it. */
	children: readonly NoteWriteBlock[];
}

/**
 * One piece of what a call writes, with where it sits. `depth` is the distance to the nearest
 * task above: 0 for a task itself, 1 for a block directly under one, null when no task is above.
 */
export type NoteWrite =
	/** Blocks added under an existing block. */
	| {
			kind: "under";
			parent: { ref: string; depth: number | null };
			blocks: readonly NoteWriteBlock[];
	  }
	/** An existing block rewritten (its children: blocks the call adds under it). */
	| { kind: "self"; depth: number | null; block: NoteWriteBlock };

/** What a block under a task is, by where it sits (the limit its text is held to). */
export type NoteBlockRole = "title" | "note" | "detail";

export type NoteIssue =
	/** A block longer than its role allows (`lines` > 1: a title on several lines). */
	| { kind: "long"; ref: string; chars: number; lines: number; role: NoteBlockRole; clear: boolean }
	/** Too many blocks added directly under one block by this call (`ref`: that block). */
	| { kind: "flat"; ref: string; children: number; clear: boolean }
	/** A markdown heading under a task (kept as written; never clear). */
	| { kind: "heading"; ref: string; clear: false };

export interface NoteWriteReport {
	/** The first {@link OUTLINE_NOTE_RULES.listed} issues: the clear ones first, each in order. */
	issues: NoteIssue[];
	/** All issues found. */
	total: number;
	/** How many of them are clearly over the limit. */
	clear: number;
}

function limitOf(role: NoteBlockRole): number {
	if (role === "title") return OUTLINE_NOTE_RULES.titleChars;
	return role === "note" ? OUTLINE_NOTE_RULES.noteChars : OUTLINE_NOTE_RULES.detailChars;
}

/** The limit a block of `role` is held to. */
export function noteBlockLimit(role: NoteBlockRole): number {
	return limitOf(role);
}

const BARE_URL = /\bhttps?:\/\/[^\s<>"'）)\]]+/g;

/**
 * Characters of a block's text (`planBlockText`) as the note rules count them: as a reader
 * counts, with a bare URL no longer than a link's label.
 */
export function noteTextChars(text: string): number {
	let chars = planTextChars(text);
	if (!text.includes("://")) return chars;
	for (const url of text.match(BARE_URL) ?? []) {
		const length = planTextChars(url);
		if (length > OUTLINE_NOTE_RULES.urlChars) chars -= length - OUTLINE_NOTE_RULES.urlChars;
	}
	return chars;
}

/** Whether a block's content is a markdown heading. */
export function isNoteHeading(content: string): boolean {
	// Every heading starts with `#` (canonical content has no leading space).
	return content.startsWith("#") && parseBlock(content).body.type === "heading";
}

function longIssue(block: NoteWriteBlock, role: NoteBlockRole): NoteIssue | null {
	const limit = limitOf(role);
	const content = block.content;
	// Fast path: no longer than the limit in UTF-16 units is within it in characters too.
	if (content.length <= limit && (role !== "title" || !content.includes("\n"))) return null;
	const { text, prose } = planBlockText(content);
	if (!prose) return null;
	const chars = noteTextChars(text);
	const lines = role === "title" ? text.split("\n").length : 1;
	if (chars <= limit && lines <= 1) return null;
	return {
		kind: "long",
		ref: block.ref,
		chars,
		lines,
		role,
		clear: role === "note" && chars > OUTLINE_NOTE_RULES.clearNoteChars,
	};
}

/**
 * What a call's writes break of the note rules, in the order written. Blocks with no task above
 * them (facts) are not looked at, except that a task's own title always is.
 */
export function noteWriteIssues(writes: readonly NoteWrite[]): NoteWriteReport {
	const found: NoteIssue[] = [];
	/** Blocks added directly under an existing block, over all the call's writes. */
	const added = new Map<string, { children: number; task: boolean; at: number }>();
	const flat = (ref: string, children: number, task: boolean): NoteIssue | null =>
		children > OUTLINE_NOTE_RULES.maxChildren ? { kind: "flat", ref, children, clear: task } : null;
	const push = (issue: NoteIssue | null) => {
		if (issue) found.push(issue);
	};
	const walk = (start: NoteWriteBlock, startDepth: number | null) => {
		const stack: Array<{ block: NoteWriteBlock; depth: number | null }> = [
			{ block: start, depth: startDepth },
		];
		while (stack.length > 0) {
			const { block, depth: at } = stack.pop() as { block: NoteWriteBlock; depth: number | null };
			const depth = block.task ? 0 : at;
			if (depth !== null) {
				push(longIssue(block, depth === 0 ? "title" : depth === 1 ? "note" : "detail"));
				if (depth > 0 && isNoteHeading(block.content))
					push({ kind: "heading", ref: block.ref, clear: false });
				push(flat(block.ref, block.children.length, depth === 0));
			}
			for (let i = block.children.length - 1; i >= 0; i--)
				stack.push({
					block: block.children[i] as NoteWriteBlock,
					depth: depth === null ? null : depth + 1,
				});
		}
	};
	for (const write of writes) {
		if (write.kind === "self") {
			walk(write.block, write.depth);
			continue;
		}
		const { ref, depth } = write.parent;
		if (depth !== null) {
			const entry = added.get(ref) ?? { children: 0, task: depth === 0, at: found.length };
			entry.children += write.blocks.length;
			added.set(ref, entry);
		}
		for (const block of write.blocks) walk(block, depth === null ? null : depth + 1);
	}
	// A flat level under an existing block is said where its first blocks were written.
	const flats = [...added.entries()]
		.map(([ref, entry]) => ({ at: entry.at, issue: flat(ref, entry.children, entry.task) }))
		.filter((f): f is { at: number; issue: NoteIssue } => f.issue !== null)
		.sort((a, b) => b.at - a.at);
	for (const f of flats) found.splice(f.at, 0, f.issue);
	const clear = found.filter((issue) => issue.clear);
	const ordered = [...clear, ...found.filter((issue) => !issue.clear)];
	return {
		issues: ordered.slice(0, OUTLINE_NOTE_RULES.listed),
		total: found.length,
		clear: clear.length,
	};
}

/** Whether a report's write is refused: only a clear issue, and only in mode `reject`. */
export function noteWriteRefused(
	report: Pick<NoteWriteReport, "clear">,
	mode: OutlineNoteRulesMode = OUTLINE_NOTE_RULES.mode,
): boolean {
	return mode === "reject" && report.clear > 0;
}

/** A block directly under a task being ticked off, as {@link taskResultCheck} sees it. */
export interface TaskResultChild {
	ref: string;
	/** The start of its content: at most {@link OUTLINE_NOTE_RULES.tidyHeadChars} characters. */
	head: string;
	/** It is a task, a question put to a person, or a subagent report's container. */
	other: boolean;
}

export interface TaskResultReport {
	/**
	 * The first note with text under the task is its result: the line a folded finished task
	 * shows. False without a note, and when that first note is a heading (a label, not a result).
	 */
	hasResult: boolean;
	/** The heading that stands where the result should, when that is why there is none. */
	heading: string | null;
	/** Notes over a note's limit, at most {@link OUTLINE_NOTE_RULES.tidyListed} (`chars` null: past what was read). */
	long: Array<{ ref: string; chars: number | null }>;
	/** Notes over the limit in all. */
	longTotal: number;
	/** Notes directly under the task, when more than a level holds; else null. */
	flat: number | null;
}

/**
 * What a task being ticked done or cancelled lacks or should tidy, from its direct children in
 * order (the first {@link OUTLINE_NOTE_RULES.tidyChildren} of them; `more`: there are others).
 */
export function taskResultCheck(
	children: readonly TaskResultChild[],
	more = false,
): TaskResultReport {
	let hasResult = false;
	let heading: string | null = null;
	let notes = 0;
	let longTotal = 0;
	const long: TaskResultReport["long"] = [];
	for (const child of children) {
		if (child.other) continue;
		const cut = child.head.length >= OUTLINE_NOTE_RULES.tidyHeadChars;
		const { text, prose } = planBlockText(child.head);
		if (!text.trim()) continue;
		notes++;
		// The first note is what a folded task shows.
		if (notes === 1) {
			if (isNoteHeading(child.head)) heading = child.ref;
			else hasResult = true;
		}
		if (!prose) continue;
		const chars = noteTextChars(text);
		if (!cut && chars <= OUTLINE_NOTE_RULES.noteChars) continue;
		longTotal++;
		if (long.length < OUTLINE_NOTE_RULES.tidyListed)
			long.push({ ref: child.ref, chars: cut ? null : chars });
	}
	return {
		hasResult,
		heading,
		long,
		longTotal,
		flat: more || notes > OUTLINE_NOTE_RULES.maxChildren ? notes : null,
	};
}
