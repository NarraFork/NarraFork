/**
 * How an outline plan has to be laid out before it can be submitted (plan readability, after
 * outline P2 PR 8). A person reads a plan as an outline whose root and two levels below it are
 * open and the rest folded (`outline-plan-tree.ts`), so a plan only reads well when its root is a
 * title and every block is one short point: a root that carries the goal and the acceptance in
 * one paragraph, or a block that is a page of prose, is a wall of text however it is folded.
 *
 * `ExitPlanMode` refuses a plan that breaks one of these rules (nothing is submitted, nothing is
 * written; the agent fixes the tree with `OutlineEdit` and submits again), and the plan-mode
 * prompts state the same rules with the same numbers ({@link OUTLINE_PLAN_STRUCTURE}).
 *
 * Text is counted as a reader sees it: the block's plain text (no markup, a link's label rather
 * than its target), one per character whatever the script, so a CJK character counts 1 like a
 * Latin letter. Code blocks and tables are not prose and are not held to the per-block limit
 * (a root still has to be a title). Notes written FOR the agent under the root (a person's
 * returned feedback, an earlier review's comments) and questions put to a person (`Ask`, with
 * their answers) are not the agent's text: they are neither checked nor counted.
 *
 * Pure: no database, no DOM. Content is the block's canonical dialect markdown.
 */
import { parseBlock } from "./outline/dialect";
import type { Inline } from "./outline/dialect/types";

/** The rules a submitted plan is held to (one place: the check and the prompts read these). */
export const OUTLINE_PLAN_STRUCTURE = {
	/** Characters of the plan root's text, which is one line. */
	rootChars: 80,
	/** Characters of any other block's text (prose; code blocks and tables are not counted). */
	blockChars: 300,
	/** Blocks directly under one block (notes for the agent not counted). */
	maxChildren: 15,
	/** Problems one refusal names (the rest are counted). */
	listed: 8,
} as const;

/** A block of the plan as the check sees it (an `OutlineNode` fits). */
export interface PlanStructureNode {
	sid: string;
	/** The block's dialect markdown; null when not loaded (treated as empty). */
	content: string | null;
	children: readonly PlanStructureNode[];
	/** A question put to a person (`Ask`): the tool's text, and a person's answers under it. */
	ask?: unknown;
}

/** One way a plan breaks the rules, about the block `sid`. */
export type PlanStructureIssue =
	/** The root is not a short one-line title. */
	| { kind: "root"; sid: string; chars: number; lines: number }
	/** A block is longer than one short point. */
	| { kind: "long"; sid: string; chars: number }
	/** Too many blocks directly under one block: a flat list, not levels. */
	| { kind: "flat"; sid: string; children: number };

export interface PlanStructureReport {
	/** The first {@link OUTLINE_PLAN_STRUCTURE.listed} problems, in document order. */
	issues: PlanStructureIssue[];
	/** All problems found. */
	total: number;
}

/** A block's text as a reader sees it, and whether it is prose (paragraph, heading, quote). */
export function planBlockText(content: string): { text: string; prose: boolean } {
	const { body } = parseBlock(content);
	switch (body.type) {
		case "paragraph":
		case "heading":
		case "quote":
			return { text: inlineText(body.content), prose: true };
		case "code":
			return { text: body.text, prose: false };
		case "table":
			return {
				text: body.rows.map((row) => row.map(inlineText).join(" ")).join("\n"),
				prose: false,
			};
		case "embed":
			return { text: body.label ?? body.ref, prose: true };
	}
}

function inlineText(inlines: readonly Inline[]): string {
	let out = "";
	for (const node of inlines) {
		if (node.type === "br") out += "\n";
		else if (node.type === "mention") out += node.label ?? node.ref;
		else out += node.text;
	}
	return out;
}

/** Characters of `text` as a reader counts them: code points, line breaks left out. */
export function planTextChars(text: string): number {
	let count = 0;
	for (const ch of text) if (ch !== "\n") count++;
	return count;
}

/** Whether a root's content is a title: one prose line of at most `rootChars` characters. */
function rootIssue(sid: string, content: string): PlanStructureIssue | null {
	const limit = OUTLINE_PLAN_STRUCTURE.rootChars;
	// Fast path: one line no longer than the limit in UTF-16 units is within it in characters too.
	if (!content.includes("\n") && content.length <= limit) return null;
	const { text, prose } = planBlockText(content);
	const lines = text.split("\n").length;
	const chars = planTextChars(text);
	if (prose && lines <= 1 && chars <= limit) return null;
	return { kind: "root", sid, chars, lines };
}

function longIssue(sid: string, content: string): PlanStructureIssue | null {
	const limit = OUTLINE_PLAN_STRUCTURE.blockChars;
	if (content.length <= limit) return null;
	const { text, prose } = planBlockText(content);
	if (!prose) return null;
	const chars = planTextChars(text);
	return chars > limit ? { kind: "long", sid, chars } : null;
}

/**
 * The plan's problems, in document order (each block: its own text, then how many blocks are
 * directly under it). `isNote` names the root's children that are notes for the agent (left out
 * with what is under them).
 */
export function planStructureIssues(
	root: PlanStructureNode,
	options: { isNote?: (node: PlanStructureNode) => boolean } = {},
): PlanStructureReport {
	const issues: PlanStructureIssue[] = [];
	let total = 0;
	const add = (issue: PlanStructureIssue | null) => {
		if (!issue) return;
		total++;
		if (issues.length < OUTLINE_PLAN_STRUCTURE.listed) issues.push(issue);
	};
	const stack: Array<{ node: PlanStructureNode; isRoot: boolean }> = [{ node: root, isRoot: true }];
	while (stack.length > 0) {
		const { node, isRoot } = stack.pop() as { node: PlanStructureNode; isRoot: boolean };
		// A question put to a person, and its answers: not the agent's text to shorten.
		if (!isRoot && node.ask) continue;
		const content = node.content ?? "";
		add(isRoot ? rootIssue(node.sid, content) : longIssue(node.sid, content));
		const children = isRoot
			? node.children.filter((child) => !options.isNote?.(child))
			: node.children;
		if (children.length > OUTLINE_PLAN_STRUCTURE.maxChildren)
			add({ kind: "flat", sid: node.sid, children: children.length });
		for (let i = children.length - 1; i >= 0; i--)
			stack.push({ node: children[i] as PlanStructureNode, isRoot: false });
	}
	return { issues, total };
}
