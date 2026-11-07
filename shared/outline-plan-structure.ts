/**
 * The format an outline plan is written in before it can be submitted (plan readability, after
 * outline P2 PR 8). The owner's template, top to bottom:
 *
 *   - [ ] A one-line title                       ← the plan root (approval lists, inbox, digest)
 *     - A background paragraph                   ← the root's first child: shown whole
 *     - [ ] A big point (a phase, a workstream)   ← depth 1
 *       - [ ] A small point (a task)             ← depth 2
 *         - Implementation details               ← depth 3+: one preview line until opened
 *     - Notable points / 特别值得注意的点          ← the root's last child, items shown whole
 *       - A risk, an irreversible step, …
 *
 * An approver tracks many plans at once and knows each project only roughly: the title names the
 * plan in a list, the background brings back what it is about and leads into the points, the
 * points read as one idea each, the details stay folded behind one preview line
 * (`outline-plan-tree.ts`), and what needs their attention is gathered at the end.
 *
 * `ExitPlanMode` refuses a plan that breaks the template (nothing is submitted, nothing is
 * written; the agent fixes the tree with `OutlineEdit` and submits again), and the plan-mode
 * prompts state it with the same numbers ({@link OUTLINE_PLAN_STRUCTURE}).
 *
 * Text is counted as a reader sees it: the block's plain text (no markup, a link's label rather
 * than its target), one per character whatever the script, so a CJK character counts 1 like a
 * Latin letter. Code blocks and tables are not prose and are not held to the length limits (a
 * root still has to be a title, a background a paragraph). Notes written FOR the agent under the
 * root (a person's returned feedback, an earlier review's comments) and questions put to a person
 * (`Ask`, with their answers) are not the agent's text: they are neither checked nor counted, nor
 * do they take the background's or the notable points' place.
 *
 * Pure: no database, no DOM. Content is the block's canonical dialect markdown.
 */
import { parseBlock } from "./outline/dialect";
import type { Inline } from "./outline/dialect/types";

/** The rules a submitted plan is held to (one place: the check and the prompts read these). */
export const OUTLINE_PLAN_STRUCTURE = {
	/** Characters of the plan root's text, which is one line. */
	rootChars: 80,
	/**
	 * Characters of the background (the root's first child): one concise paragraph, always shown
	 * whole. 400 is three to five sentences — about 65 English words, or a full paragraph of
	 * Chinese (CJK counts 1, and carries more per character) — enough to say what the work is,
	 * why, and where it stands, and short enough to read at a glance (≈ 9 lines of Chinese at a
	 * desktop card's width).
	 */
	backgroundChars: 400,
	/**
	 * Characters of a big or a small point (depths 1 and 2, shown by default): one idea, one
	 * sentence. 120 is what three lines of Chinese hold at a desktop card's width (≈ 43 a line),
	 * so a point within it is never clamped there; in English it is about 20 words.
	 */
	pointChars: 120,
	/**
	 * Characters of an implementation detail (depth 3 and deeper): hidden behind one preview line
	 * until the reader opens them, so a detail may be a short paragraph (which files, how, how it
	 * is checked); longer than that is several details or a detail with children.
	 */
	detailChars: 600,
	/** Blocks directly under one block (notes for the agent not counted). */
	maxChildren: 15,
	/** Problems one refusal names (the rest are counted). */
	listed: 8,
} as const;

/** The notable points section's title, as the prompts write it (other variants are accepted). */
export const NOTABLE_POINTS_TITLE = { en: "Notable points", "zh-CN": "特别值得注意的点" } as const;

/** A block of the plan as the check sees it (an `OutlineNode` fits). */
export interface PlanStructureNode {
	sid: string;
	/** The block's dialect markdown; null when not loaded (treated as empty). */
	content: string | null;
	children: readonly PlanStructureNode[];
	/** The block's task, when it is one (a checkbox); null or absent when it is not. */
	task?: unknown;
	/** A question put to a person (`Ask`): the tool's text, and a person's answers under it. */
	ask?: unknown;
}

/** Why the root's first block is not a background. */
export type PlanBackgroundProblem =
	/** The root has no block under it (other than notes and questions). */
	| "none"
	/** The first block is a task (a phase, a step), not a paragraph. */
	| "task"
	/** The first block is a heading (a label such as "Background"), not the paragraph itself. */
	| "heading"
	/** The first block is a code block, a table or an embed. */
	| "notProse"
	/** The first block has no text. */
	| "empty"
	/** The first block has blocks under it: a background is one paragraph. */
	| "children";

/** What a block is in the template, by where it sits (the limit its text is held to). */
export type PlanBlockRole = "background" | "point" | "detail";

/** One way a plan breaks the template, about the block `sid`. */
export type PlanStructureIssue =
	/** The root is not a short one-line title. */
	| { kind: "root"; sid: string; chars: number; lines: number }
	/** The root's first block is not a background paragraph (`sid`: that block, or the root). */
	| { kind: "background"; sid: string; problem: PlanBackgroundProblem }
	/** A block is longer than its role allows. */
	| { kind: "long"; sid: string; chars: number; role: PlanBlockRole }
	/** Too many blocks directly under one block: a flat list, not levels. */
	| { kind: "flat"; sid: string; children: number }
	/** The notable points section is not the root's last block. */
	| { kind: "notable"; sid: string };

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

/**
 * Whether a block is a background's shape (null) or why not: a paragraph (or a quote) with text,
 * not a task, with nothing under it. Its length is checked on its own
 * ({@link OUTLINE_PLAN_STRUCTURE.backgroundChars}). The reader's tree (`outline-plan-tree.ts`)
 * shows the root's first block as the background by the same test.
 */
export function planBackgroundProblem(block: {
	content: string | null;
	task: boolean;
	children: number;
}): Exclude<PlanBackgroundProblem, "none"> | null {
	if (block.task) return "task";
	const content = block.content ?? "";
	const { body } = parseBlock(content);
	if (body.type === "heading") return "heading";
	if (body.type !== "paragraph" && body.type !== "quote") return "notProse";
	if (!planBlockText(content).text.trim()) return "empty";
	if (block.children > 0) return "children";
	return null;
}

const NOTABLE_HEADINGS: readonly RegExp[] = [
	// 特别值得注意的点 / 特别值得注意 / 值得注意的点 / 需要注意的地方 / 注意事项 / 特别注意
	/^(特别)?(值得|需要|要)?注意(的)?(点|地方|事项|问题)?$/u,
	/^(notable|noteworthy)( (points?|things|items))?$/,
	/^((points?|things|items) )?(to note|worth noting)$/,
];

/**
 * Whether a block is the notable points section by its words (「特别值得注意的点」, "Notable
 * points", and small variants: the case, punctuation and markup around them, 「值得注意的点」,
 * 「注意事项」, "Points to note"). Its words must be the whole block: a block that goes on after
 * them is a point, not the section.
 */
export function isNotablePointsHeading(content: string | null): boolean {
	if (!content || content.length > 80) return false;
	const { text, prose } = planBlockText(content);
	if (!prose) return false;
	const words = text
		.replace(/[^\p{L}\p{N}\s]/gu, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
	if (!words) return false;
	return NOTABLE_HEADINGS.some((pattern) => pattern.test(words));
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

const LIMIT_OF: Record<PlanBlockRole, number> = {
	background: OUTLINE_PLAN_STRUCTURE.backgroundChars,
	point: OUTLINE_PLAN_STRUCTURE.pointChars,
	detail: OUTLINE_PLAN_STRUCTURE.detailChars,
};

/** The limit a block of `role` is held to. */
export function planBlockLimit(role: PlanBlockRole): number {
	return LIMIT_OF[role];
}

function longIssue(sid: string, content: string, role: PlanBlockRole): PlanStructureIssue | null {
	const limit = LIMIT_OF[role];
	if (content.length <= limit) return null;
	const { text, prose } = planBlockText(content);
	if (!prose) return null;
	const chars = planTextChars(text);
	return chars > limit ? { kind: "long", sid, chars, role } : null;
}

/**
 * The plan's problems, in document order (each block: its own text, then how many blocks are
 * directly under it; the background's and the notable section's place where they sit). `isNote`
 * names the root's children that are notes for the agent (left out with what is under them).
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
	add(rootIssue(root.sid, root.content ?? ""));
	const top = root.children.filter((child) => !options.isNote?.(child));
	if (top.length > OUTLINE_PLAN_STRUCTURE.maxChildren)
		add({ kind: "flat", sid: root.sid, children: top.length });
	// The plan's own blocks under the root: the background first, the notable section last.
	const plan = top.filter((child) => !child.ask);
	const first = plan[0];
	if (!first) add({ kind: "background", sid: root.sid, problem: "none" });
	const last = plan[plan.length - 1];
	for (const child of top) {
		if (child.ask) continue;
		if (child === first) {
			const problem = planBackgroundProblem({
				content: child.content,
				task: !!child.task,
				children: child.children.length,
			});
			if (!problem) {
				add(longIssue(child.sid, child.content ?? "", "background"));
				continue;
			}
			// Not a background: say so, and check it as the point it is.
			add({ kind: "background", sid: child.sid, problem });
		}
		if (child !== last && isNotablePointsHeading(child.content))
			add({ kind: "notable", sid: child.sid });
		walk(child, 1, add);
	}
	return { issues, total };
}

/** A block at `depth` (1 under the root) and what is under it, in document order. */
function walk(
	start: PlanStructureNode,
	depth: number,
	add: (issue: PlanStructureIssue | null) => void,
): void {
	const stack: Array<{ node: PlanStructureNode; depth: number }> = [{ node: start, depth }];
	while (stack.length > 0) {
		const { node, depth: at } = stack.pop() as { node: PlanStructureNode; depth: number };
		// A question put to a person, and its answers: not the agent's text to shorten.
		if (node.ask) continue;
		add(longIssue(node.sid, node.content ?? "", at <= 2 ? "point" : "detail"));
		if (node.children.length > OUTLINE_PLAN_STRUCTURE.maxChildren)
			add({ kind: "flat", sid: node.sid, children: node.children.length });
		for (let i = node.children.length - 1; i >= 0; i--)
			stack.push({ node: node.children[i] as PlanStructureNode, depth: at + 1 });
	}
}
