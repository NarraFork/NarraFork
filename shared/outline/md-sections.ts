/**
 * Free markdown (a document, an agent's report) → a block tree whose headings hold their
 * sections: the counterpart of the markdown outline format for text that is not an outline.
 *
 * ```text
 * # Findings                  - # Findings
 * The race is in refresh():     - The race is in refresh():
 * - it reuses the old token  →    - it reuses the old token
 * ## Evidence                   - ## Evidence
 * | case | result |                - | case | result | …
 * ```
 *
 * Rules:
 * - Every top-level markdown block (paragraph, heading, code block, table, quote) is a block;
 *   list items are blocks nested by the list's own structure (`parseBlocks`).
 * - A heading holds everything after it up to the next heading of the same or a higher level
 *   (`#` is the highest). Levels 4–6 nest like the others, though the block dialect shows them as
 *   bold paragraphs.
 * - A list right after a paragraph (blank lines between them or not) goes under that paragraph:
 *   "The race is in refresh():" followed by its points.
 * - Horizontal rules are dropped (as the dialect does everywhere).
 *
 * With `literal` (an agent's report attached under a task, outline P2 PR 9a) nothing in the text
 * is outline syntax: a `- [ ]` item keeps its box as text instead of becoming a task, and
 * `[[…]]` / `![[…]]` stay text instead of becoming links or embeds (written escaped, so they read
 * back as text). `key:: value` lines and `@mentions` are text in a block body anyway. So the
 * blocks hold notes only: no tasks, links, aliases or tags.
 *
 * Every content returned is canonical dialect markdown, as `serializeBody` writes it. Pure; the
 * cost is the dialect parser's (lexing dominates), so large untrusted input belongs off the main
 * thread.
 */
import type { Token, Tokens } from "marked";
import { parseBlocks, serializeBody } from "./dialect";
import { lexBlocks } from "./dialect/lexer";
import type { BlockNode, Body, Inline } from "./dialect/types";
import { type OutlineItem, TASK_BOX } from "./md-outline";

export interface ParseSectionsOptions {
	/** Keep task boxes, links and embeds as text (see the module header). */
	literal?: boolean;
}

/** A mention or embed written out as the text that would make it. */
function refText(embed: boolean, ref: string, label: string | null): string {
	return `${embed ? "!" : ""}[[${ref}${label === null ? "" : `|${label}`}]]`;
}

function literalInline(content: readonly Inline[]): Inline[] {
	return content.map((node) =>
		node.type === "mention"
			? { type: "text", text: refText(false, node.ref, node.label), marks: node.marks }
			: node,
	);
}

/** A body with its references as text, and a task box (when it had one) in front of its text. */
function literalBody(body: Body, box: string | null): Body {
	const lead = (content: Inline[]): Inline[] =>
		box === null ? content : [{ type: "text", text: `[${box}] `, marks: [] }, ...content];
	switch (body.type) {
		case "embed":
			return {
				type: "paragraph",
				content: lead([{ type: "text", text: refText(true, body.ref, body.label), marks: [] }]),
			};
		case "table":
			return { ...body, rows: body.rows.map((row) => row.map(literalInline)) };
		case "code":
			return body;
		default:
			return { ...body, content: lead(literalInline(body.content)) };
	}
}

function toItem(node: BlockNode, literal: boolean): OutlineItem {
	const box = node.task ? TASK_BOX[node.task] : null;
	return {
		content: serializeBody(literal ? literalBody(node.body, box) : node.body),
		task: !literal && node.task ? { status: node.task, assignee: null } : null,
		props: {},
		children: node.children.map((child) => toItem(child, literal)),
	};
}

/** The blocks of one top-level markdown block. */
function blocksOf(token: Token, literal: boolean): OutlineItem[] {
	return parseBlocks(token.raw).nodes.map((node) => toItem(node, literal));
}

/** Parses free markdown into a block tree whose headings hold their sections (module header). */
export function parseMarkdownSections(
	src: string,
	options: ParseSectionsOptions = {},
): OutlineItem[] {
	const literal = options.literal === true;
	const text = src.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
	const out: OutlineItem[] = [];
	/** Open headings, outermost first. */
	const open: Array<{ level: number; item: OutlineItem }> = [];
	/** The paragraph a list right after it goes under. */
	let lead: OutlineItem | null = null;
	const into = (): OutlineItem[] => open[open.length - 1]?.item.children ?? out;
	for (const token of lexBlocks(text)) {
		if (token.type === "space") continue;
		const items = blocksOf(token, literal);
		if (token.type === "heading") {
			const level = (token as Tokens.Heading).depth;
			while (open.length > 0 && (open[open.length - 1]?.level ?? 0) >= level) open.pop();
			const [heading, ...rest] = items;
			lead = null;
			if (!heading) continue;
			into().push(heading, ...rest);
			open.push({ level, item: heading });
			continue;
		}
		if (token.type === "list" && lead) {
			lead.children.push(...items);
			continue;
		}
		into().push(...items);
		lead = token.type === "paragraph" && items.length === 1 ? (items[0] ?? null) : null;
	}
	return out;
}
