/**
 * A delegated subagent's report as outline blocks (outline P2 PR 9a): the text work of attaching
 * it under its task (`delegation.ts`). Pure and free of the database, so it runs on the edit-text
 * worker when the report is large (`edit-text.ts`, job `report`).
 *
 *   - STRUCTURE: `parseMarkdownSections` with `literal`: headings hold their sections, a list
 *     right after a paragraph goes under it, every paragraph, table, quote and code block is a
 *     block. Nothing is read as outline syntax: a checkbox stays text, `[[…]]` stays text.
 *   - LARGE BLOCKS: a block over {@link OUTLINE_REPORT_LIMITS.maxBlockBytes} is cut into
 *     consecutive blocks by lines (a table repeats its header; a code block stays code); the
 *     pieces after the first start with the `continued` marker (code pieces do not: the marker
 *     would become code).
 *   - LIMITS: at most {@link OUTLINE_REPORT_LIMITS.maxBlocks} blocks and
 *     {@link OUTLINE_REPORT_LIMITS.maxBytes} of content, taken in document order (a block before
 *     the blocks under it). The first block that does not fit ends it; what is left is counted in
 *     `omittedBytes`, and one block's room is kept for the caller's line saying so. Input past
 *     {@link OUTLINE_REPORT_LIMITS.maxInputBytes} is not parsed at all and counts as left out.
 *
 * Every content returned is canonical (`normalizeBlock(content).content === content`), with the
 * links `contentLinks` reads from it (none: references are text), as `writeOutline` takes
 * `canonical` content.
 */
import {
	type Inline,
	normalizeBlock,
	type OutlineItem,
	parseBlock,
	parseMarkdownSections,
	serializeBody,
} from "@shared/outline";
import { bodyLinks, type ExtractedLink } from "./links";

export const OUTLINE_REPORT_LIMITS = {
	/** Blocks under the report's container: one commit with it holds at most 200 operations. */
	maxBlocks: 199,
	/** UTF-8 bytes of their content: within the 128 KiB a transaction may carry. */
	maxBytes: 120 * 1024,
	/** UTF-8 bytes of one block's content (the write path's limit). */
	maxBlockBytes: 16 * 1024,
	/** UTF-8 bytes of report text parsed at all; more cannot fit in `maxBytes` anyway. */
	maxInputBytes: 160 * 1024,
	/** Room kept for the caller's line about what was left out. */
	omissionReserveBytes: 512,
} as const;

/** Lines of a large block go into pieces of at most this many bytes before normalization. */
const PIECE_BYTES = 12 * 1024;
/** Plain text cut without line breaks: escaping at most doubles it. */
const HARD_PIECE_BYTES = 6 * 1024;

export interface ReportBlock {
	/** Canonical dialect markdown. */
	content: string;
	/** What `contentLinks(content)` reads. */
	links: ExtractedLink[];
	children: ReportBlock[];
}

export interface ReportConversion {
	blocks: ReportBlock[];
	/** Blocks in `blocks`, at every depth. */
	count: number;
	/** UTF-8 bytes of their content. */
	bytes: number;
	/** UTF-8 bytes of the report (parsed or not) that did not fit. */
	omittedBytes: number;
}

export interface ReportInput {
	text: string;
	/** Put in front of the pieces of a block cut in several (`(cont.)`, `（续）`). */
	continued: string;
}

function utf8(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** The longest prefix of `text` of at most `max` UTF-8 bytes, cut at a line end when there is one. */
function prefixWithin(text: string, max: number): string {
	if (text.length <= max / 3 || utf8(text) <= max) return text;
	let cut = Buffer.from(text, "utf8").subarray(0, max).toString("utf8");
	// A cut inside a character leaves a replacement character at the end.
	if (cut.endsWith("�")) cut = cut.slice(0, -1);
	const line = cut.lastIndexOf("\n");
	return line > 0 ? cut.slice(0, line) : cut;
}

/** Pieces of plain text of at most `max` bytes each, cut between characters. */
function hardPieces(text: string, max: number): string[] {
	const out: string[] = [];
	let piece = "";
	let bytes = 0;
	for (const ch of text) {
		const size = utf8(ch);
		if (bytes + size > max && piece) {
			out.push(piece);
			piece = "";
			bytes = 0;
		}
		piece += ch;
		bytes += size;
	}
	if (piece) out.push(piece);
	return out;
}

/** Lines grouped into pieces of at most `max` bytes (a longer line is a piece of its own). */
function linePieces(lines: readonly string[], max: number): string[][] {
	const out: string[][] = [];
	let piece: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		const size = utf8(line) + 1;
		if (bytes + size > max && piece.length > 0) {
			out.push(piece);
			piece = [];
			bytes = 0;
		}
		piece.push(line);
		bytes += size;
	}
	if (piece.length > 0) out.push(piece);
	return out;
}

/** Plain text as paragraphs of at most {@link HARD_PIECE_BYTES} each, its markup escaped. */
function textBlocks(text: string): string[] {
	return hardPieces(text, HARD_PIECE_BYTES).map((piece) => {
		const content: Inline[] = [];
		piece.split("\n").forEach((line, i) => {
			if (i > 0) content.push({ type: "br" });
			if (line) content.push({ type: "text", text: line, marks: [] });
		});
		return normalizeBlock(serializeBody({ type: "paragraph", content })).content;
	});
}

/** One content as pieces within the block limit; pieces after the first marked `continued`. */
function splitContent(content: string, continued: string): string[] {
	const max = OUTLINE_REPORT_LIMITS.maxBlockBytes;
	if (utf8(content) <= max) return [content];
	const body = parseBlock(content).body;
	if (body.type === "code") {
		const fence = "`".repeat(Math.max(3, longestRun(body.text, "`") + 1));
		const lines = body.text
			.split("\n")
			.flatMap((line) => (utf8(line) > PIECE_BYTES ? hardPieces(line, PIECE_BYTES) : [line]));
		return linePieces(lines, PIECE_BYTES).map(
			(piece) => normalizeBlock(`${fence}${body.lang}\n${piece.join("\n")}\n${fence}`).content,
		);
	}
	const lines = content.split("\n");
	// A table's pieces each repeat its header, so they stay tables.
	const head = body.type === "table" ? lines.slice(0, 2) : [];
	const rest = body.type === "table" ? lines.slice(2) : lines;
	const out: string[] = [];
	for (const [i, piece] of linePieces(rest, PIECE_BYTES - utf8(head.join("\n"))).entries()) {
		const lead = i === 0 || body.type === "table" ? "" : `${continued} `;
		const text = [...head, ...piece].join("\n");
		const normalized = normalizeBlock(lead + text).content;
		if (utf8(normalized) <= max) out.push(normalized);
		// One line too long to fit: cut as plain text.
		else out.push(...textBlocks(lead + text));
	}
	return out;
}

function longestRun(text: string, ch: string): number {
	let best = 0;
	let run = 0;
	for (const c of text) {
		run = c === ch ? run + 1 : 0;
		if (run > best) best = run;
	}
	return best;
}

interface Sized {
	content: string;
	bytes: number;
	children: Sized[];
}

/**
 * The items as blocks within the block limit: a large one becomes consecutive siblings, the
 * blocks under it going under its first piece.
 */
function sized(items: readonly OutlineItem[], continued: string): Sized[] {
	const out: Sized[] = [];
	for (const item of items) {
		const pieces = splitContent(item.content, continued);
		pieces.forEach((content, i) => {
			out.push({
				content,
				bytes: utf8(content),
				children: i === 0 ? sized(item.children, continued) : [],
			});
		});
	}
	return out;
}

function totalBytes(nodes: readonly Sized[]): number {
	let total = 0;
	for (const node of nodes) total += node.bytes + totalBytes(node.children);
	return total;
}

/** Converts a report (see the module header). */
export function convertReport(input: ReportInput): ReportConversion {
	const limits = OUTLINE_REPORT_LIMITS;
	const parsed = prefixWithin(input.text, limits.maxInputBytes);
	const unparsed = utf8(input.text) - utf8(parsed);
	const tree = sized(parseMarkdownSections(parsed, { literal: true }), input.continued);
	const all = totalBytes(tree);
	let maxBlocks: number = limits.maxBlocks;
	let maxBytes: number = limits.maxBytes;
	const take = (): { blocks: ReportBlock[]; count: number; bytes: number; complete: boolean } => {
		let count = 0;
		let bytes = 0;
		let full = false;
		const walk = (nodes: readonly Sized[]): ReportBlock[] => {
			const kept: ReportBlock[] = [];
			for (const node of nodes) {
				if (full) break;
				if (count + 1 > maxBlocks || bytes + node.bytes > maxBytes) {
					full = true;
					break;
				}
				count++;
				bytes += node.bytes;
				const block: ReportBlock = {
					content: node.content,
					links: bodyLinks(parseBlock(node.content).body),
					children: [],
				};
				kept.push(block);
				block.children = walk(node.children);
			}
			return kept;
		};
		const blocks = walk(tree);
		return { blocks, count, bytes, complete: !full };
	};
	let result = take();
	if (!result.complete || unparsed > 0) {
		// Something is left out: keep room for the line that says so.
		maxBlocks = limits.maxBlocks - 1;
		maxBytes = limits.maxBytes - limits.omissionReserveBytes;
		if (result.count > maxBlocks || result.bytes > maxBytes) result = take();
	}
	return {
		blocks: result.blocks,
		count: result.count,
		bytes: result.bytes,
		omittedBytes: all - result.bytes + unparsed,
	};
}

/** A whole text as blocks, nothing left out (the import of Dynamic Spec files, `spec-import/`). */
export interface NotesConversion {
	blocks: ReportBlock[];
	/** Blocks in `blocks`, at every depth. */
	count: number;
	/** UTF-8 bytes of their content. */
	bytes: number;
}

export interface NotesInput extends ReportInput {
	/**
	 * Not markdown (a `.json`, `.yaml` file): the text becomes code blocks in this language, cut
	 * by lines so each fits a block.
	 */
	code?: string | null;
}

/** A code fence's language: what a fence line may carry. */
function fenceLang(lang: string): string {
	return /^[A-Za-z0-9_+-]{1,20}$/.test(lang) ? lang : "";
}

/**
 * Converts a whole text as {@link convertReport} does (headings hold their sections, nothing is
 * outline syntax, a large block is cut into consecutive blocks), without its limits: the caller
 * bounds the input and writes the blocks in as many commits as they need. Nothing is dropped.
 */
export function convertNotes(input: NotesInput): NotesConversion {
	let tree: Sized[];
	if (input.code !== undefined && input.code !== null) {
		const lang = fenceLang(input.code);
		const fence = "`".repeat(Math.max(3, longestRun(input.text, "`") + 1));
		const lines = input.text
			.replace(/\n+$/, "")
			.split("\n")
			.flatMap((line) => (utf8(line) > PIECE_BYTES ? hardPieces(line, PIECE_BYTES) : [line]));
		tree = linePieces(lines, PIECE_BYTES).map((piece) => {
			const content = normalizeBlock(`${fence}${lang}\n${piece.join("\n")}\n${fence}`).content;
			return { content, bytes: utf8(content), children: [] };
		});
	} else tree = sized(parseMarkdownSections(input.text, { literal: true }), input.continued);
	let count = 0;
	let bytes = 0;
	const walk = (nodes: readonly Sized[]): ReportBlock[] =>
		nodes.map((node) => {
			count++;
			bytes += node.bytes;
			return {
				content: node.content,
				links: bodyLinks(parseBlock(node.content).body),
				children: walk(node.children),
			};
		});
	const blocks = walk(tree);
	return { blocks, count, bytes };
}
