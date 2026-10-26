/**
 * AST of the in-block markdown dialect. One outline block holds exactly one body (paragraph,
 * heading, code, quote, table or embed) with inline text and marks; anything nested lives in
 * child blocks. No DOM and no editor dependency, so server and browser share one implementation.
 *
 * Offset convention (matches ProseMirror node-content offsets so the editor can map
 * "source offset <-> editor position" without translation):
 * - text counts one per UTF-16 code unit; a mention (atom) counts 1; a hard break counts 1;
 * - tables: every row opens and closes (1 each), every cell opens and closes (1 each).
 */

export type MarkType = "strong" | "em" | "code" | "strike" | "link";

export interface Mark {
	type: MarkType;
	/** Link target, only for `link`. */
	href?: string;
	/** Link title, only for `link`. */
	title?: string | null;
}

export interface TextNode {
	type: "text";
	text: string;
	marks: Mark[];
}

/**
 * `[[ref]]` or `[[ref|label]]`. `ref` is the link target as written (an address, alias or
 * title; resolution happens elsewhere). Mentions never carry `code` or `link` marks.
 * Neither `ref` nor `label` may contain `[`, `]` or a line break, and `ref` may not contain `|`.
 */
export interface MentionNode {
	type: "mention";
	ref: string;
	label: string | null;
	marks: Mark[];
}

/** A line break inside a block. Every newline in a block body is a hard break. */
export interface BreakNode {
	type: "br";
}

export type Inline = TextNode | MentionNode | BreakNode;

export type Align = "left" | "center" | "right" | null;

export type HeadingLevel = 1 | 2 | 3;

export type Body =
	| { type: "paragraph"; content: Inline[] }
	| { type: "heading"; level: HeadingLevel; content: Inline[] }
	| { type: "code"; lang: string; text: string }
	| { type: "quote"; content: Inline[] }
	| { type: "table"; align: Align[]; rows: Inline[][][] }
	/** `![[ref]]` / `![[ref|label]]`: an embed always occupies a whole block. */
	| { type: "embed"; ref: string; label: string | null };

export type BodyType = Body["type"];

/** Task checkbox: `[ ]` todo, `[/]` doing, `[x]` done, `[-]` cancelled. */
export type TaskStatus = "todo" | "doing" | "done" | "cancelled";

/** A block produced by splitting markdown that does not fit in one block body. */
export interface BlockNode {
	body: Body;
	task: TaskStatus | null;
	children: BlockNode[];
}

/** `pmToSrc[k]` is the source offset of content offset `k` (non-decreasing; length size + 1). */
export interface SourceMap {
	size: number;
	pmToSrc: number[];
}

/** Why normalization changed the shape of the input. Codes are stable; messages are English. */
export type DialectNoteCode =
	| "split-list"
	| "split-paragraphs"
	| "split-quote"
	| "heading-demoted"
	| "rule-dropped"
	| "indented-code"
	| "kept-as-text";

export interface DialectNote {
	code: DialectNoteCode;
	message: string;
}

export interface ParsedBlock {
	body: Body;
	map: SourceMap;
	/** Out-of-dialect structure (lists, extra paragraphs, ...) split off as child blocks. */
	extra: BlockNode[];
	/** What normalization did to the input, for tool results and tests. */
	notes: DialectNote[];
}
