/**
 * parse-markdown.ts — marked.lexer → PreparedBlock[] for the pretext vlist.
 *
 * Ported and adapted from the pretext markdown-chat demo
 * (~/projects/pretext/pages/demos/markdown-chat.model.ts), rewritten against
 * our PreparedBlock model (prepared-block.ts) and Mantine-derived font
 * constants (pretext-fonts.ts).
 *
 * This is the width-INDEPENDENT "Prepared layer": it parses markdown into
 * inline/code/rule blocks and runs pretext's one-time precompute
 * (prepareRichInline / prepareWithSegments). No width, no DOM, no line counts
 * here — those come later in the Frame layer (measure-markdown.ts).
 *
 * Parity target: MarkdownContent.tsx (react-markdown + remark-gfm) +
 * MarkdownContent.module.css. Key CSS constants encoded below:
 *   - paragraph / list / link: 14px / line-height 1.45, margin 0.35em 0 0
 *   - inline code: 12px monospace, line-height 1.55, padding 2px 5px
 *   - headings h1..h6: Mantine heading sizes, margin-top 0.4em
 *   - blockquote: padding xs(10px), border-inline-start 3px
 *   - fenced code: margin-top 0.35em, +12px top pad when lang label present
 *   - lists: padding-inline-start 1.5em
 *
 * Unpredictable content (mermaid / katex) is emitted as PreparedUnknownBlock
 * with a conservative placeholder (controlled zero-DOM exception).
 */

import { prepareWithSegments } from "@chenglou/pretext";
import { prepareRichInline, type RichInlineItem } from "@chenglou/pretext/rich-inline";
import { marked, type Token, type Tokens } from "marked";
import type {
	PreparedBlock,
	PreparedBlockBase,
	PreparedCodeBlock,
	PreparedInlineBlock,
	PreparedRuleBlock,
	PreparedUnknownBlock,
} from "./prepared-block";
import {
	BASE_LINE_HEIGHT,
	CODE_BLOCK_FONT_SIZE,
	emToPx,
	FONT_BODY,
	FONT_BODY_BOLD,
	FONT_BODY_BOLD_ITALIC,
	FONT_BODY_ITALIC,
	FONT_INLINE_CODE,
	FONT_MARKDOWN_CODE,
	FONT_SIZE,
	FONT_WEIGHT,
	HEADING,
	headingFont,
	LINE_HEIGHT,
	lineBoxHeight,
	SANS_FAMILY,
} from "./pretext-fonts";

// ── Layout constants (px), mirroring MarkdownContent.module.css ──────────────
const BODY_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.sm, LINE_HEIGHT.sm); // 14 * 1.45 ≈ 20px
// Fenced code renders at 11px / 1.55 (settled Shiki view, HighlightedCode.module.css).
const CODE_LINE_HEIGHT = lineBoxHeight(CODE_BLOCK_FONT_SIZE, BASE_LINE_HEIGHT); // 11 * 1.55 ≈ 17
const PARAGRAPH_MARGIN_TOP = emToPx(0.35, FONT_SIZE.sm); // 0.35em @14px ≈ 4.9
const LIST_MARGIN_TOP = emToPx(0.35, FONT_SIZE.sm);
const HEADING_MARGIN_TOP = 0.4; // em, resolved per-heading font size below
const CODE_MARGIN_TOP = emToPx(0.35, FONT_SIZE.sm);
// Chunk renders `<Divider my={4}>`: a 1px rule + 4px margin top/bottom ≈ 9px.
const RULE_HEIGHT = 1 + 4 * 2; // 9
const LIST_INDENT = emToPx(1.5, FONT_SIZE.sm); // padding-inline-start 1.5em @14px = 21
const BLOCKQUOTE_PADDING = 10; // spacing xs
const BLOCKQUOTE_BORDER = 3;
const CODE_LANG_EXTRA_TOP = 12; // codeBlockWithLang: pad-top = xs + 12px (12px extra)

/**
 * Conservative placeholder heights for intrinsically unpredictable blocks.
 * Render/shell may refine once via a one-shot local measurement (the only
 * controlled DOM exception in the vlist path).
 */
export const MERMAID_PLACEHOLDER_HEIGHT = 240;
export const KATEX_PLACEHOLDER_HEIGHT = 64;

const MARKER_GAP = 6;

// Inline code occupies extra horizontal box due to padding (2px * 2 + a little).
const INLINE_CODE_EXTRA_WIDTH = 10;

type InlineVariant = "body" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

interface MarkState {
	bold: boolean;
	italic: boolean;
	strike: boolean;
	href: string | null;
}

interface ParseContext {
	listDepth: number;
	quoteDepth: number;
}

interface InlinePiece {
	text: string;
	font: string;
	className: string;
	href: string | null;
	breakMode: "normal" | "never";
	extraWidth: number;
}

const EMPTY_MARKS: MarkState = { bold: false, italic: false, strike: false, href: null };

// ─────────────────────────────────────────────────────────────────────────────
// Public entry: markdown string → PreparedBlock[]
// ─────────────────────────────────────────────────────────────────────────────
export function parseMarkdownToPreparedBlocks(markdown: string): PreparedBlock[] {
	const tokens = marked.lexer(markdown, { gfm: true });
	return parseBlockTokens(tokens, { listDepth: 0, quoteDepth: 0 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Block-level token walk
// ─────────────────────────────────────────────────────────────────────────────
function parseBlockTokens(tokens: readonly Token[], ctx: ParseContext): PreparedBlock[] {
	const blocks: PreparedBlock[] = [];

	for (const token of tokens) {
		switch (token.type) {
			case "space":
			case "def":
				continue;
			case "paragraph":
				appendGroup(
					blocks,
					buildInlineBlocks(token.tokens ?? [], "body", ctx),
					PARAGRAPH_MARGIN_TOP,
				);
				continue;
			case "heading": {
				const variant = headingVariant(token.depth);
				appendGroup(
					blocks,
					buildInlineBlocks(token.tokens ?? [], variant, ctx),
					emToPx(HEADING_MARGIN_TOP, headingSize(variant)),
				);
				continue;
			}
			case "code": {
				const lang = (token.lang ?? "").trim().toLowerCase();
				// Mermaid diagrams have intrinsic SVG height that cannot be predicted
				// from the source text; emit an unknown placeholder (not a code block).
				if (lang === "mermaid") {
					appendGroup(
						blocks,
						[
							buildUnknownBlock("mermaid", MERMAID_PLACEHOLDER_HEIGHT, ctx, {
								source: token.text,
								lang: "mermaid",
							}),
						],
						CODE_MARGIN_TOP,
					);
					continue;
				}
				// Display-math code fences (if any lexer surfaces them as code).
				if (lang === "math" || lang === "katex" || lang === "latex") {
					appendGroup(
						blocks,
						[
							buildUnknownBlock("katex", KATEX_PLACEHOLDER_HEIGHT, ctx, {
								source: token.text,
								lang,
							}),
						],
						CODE_MARGIN_TOP,
					);
					continue;
				}
				appendGroup(blocks, [buildCodeBlock(token.text, token.lang ?? null, ctx)], CODE_MARGIN_TOP);
				continue;
			}
			case "list":
				appendGroup(blocks, buildListBlocks(token as Tokens.List, ctx), LIST_MARGIN_TOP);
				continue;
			case "blockquote":
				appendGroup(
					blocks,
					parseBlockTokens(token.tokens ?? [], {
						listDepth: ctx.listDepth,
						quoteDepth: ctx.quoteDepth + 1,
					}),
					0,
				);
				continue;
			case "hr":
				appendGroup(blocks, [buildRuleBlock(ctx)], PARAGRAPH_MARGIN_TOP);
				continue;
			case "table":
				// Render tables as a monospace pre-wrap block (parity-lite; matches
				// the demo's approach of formatting a table as fixed text).
				appendGroup(
					blocks,
					[buildCodeBlock(formatTable(token as Tokens.Table), null, ctx)],
					CODE_MARGIN_TOP,
				);
				continue;
			case "text": {
				const t = token as Tokens.Text;
				if (Array.isArray(t.tokens) && t.tokens.length > 0) {
					appendGroup(blocks, buildInlineBlocks(t.tokens, "body", ctx), PARAGRAPH_MARGIN_TOP);
				} else {
					appendGroup(blocks, buildPlainText(t.text, "body", ctx), PARAGRAPH_MARGIN_TOP);
				}
				continue;
			}
			default: {
				const fallback = fallbackText(token);
				if (fallback.length > 0) {
					appendGroup(blocks, buildPlainText(fallback, "body", ctx), PARAGRAPH_MARGIN_TOP);
				}
			}
		}
	}

	return blocks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lists
// ─────────────────────────────────────────────────────────────────────────────
function buildListBlocks(token: Tokens.List, ctx: ParseContext): PreparedBlock[] {
	const blocks: PreparedBlock[] = [];
	const itemCtx: ParseContext = { listDepth: ctx.listDepth + 1, quoteDepth: ctx.quoteDepth };

	for (let index = 0; index < token.items.length; index++) {
		const item = token.items[index];
		if (!item) continue;
		let itemBlocks = parseBlockTokens(item.tokens, itemCtx);
		if (itemBlocks.length === 0) itemBlocks = buildPlainText(item.text, "body", itemCtx);
		decorateListItem(itemBlocks, markerText(token, item, index), markerClassName(token, item));
		appendGroup(blocks, itemBlocks, 0);
	}
	return blocks;
}

function decorateListItem(blocks: PreparedBlock[], marker: string, markerClass: string): void {
	if (blocks.length === 0) return;
	const markerArea = LIST_INDENT; // reserve indent already implied by contentLeft
	const first = blocks[0];
	if (!first) return;
	blocks[0] = {
		...first,
		markerText: marker,
		markerLeft: Math.max(0, first.contentLeft - markerArea + MARKER_GAP),
		markerClassName: markerClass,
	};
}

function markerText(list: Tokens.List, item: Tokens.ListItem, index: number): string {
	if (item.task) return item.checked ? "☑" : "☐";
	if (list.ordered) {
		const start = typeof list.start === "number" ? list.start : 1;
		return `${start + index}.`;
	}
	return "•";
}

function markerClassName(list: Tokens.List, item: Tokens.ListItem): string {
	if (item.task) return "vlist-marker vlist-marker--task";
	return list.ordered ? "vlist-marker vlist-marker--ordered" : "vlist-marker vlist-marker--bullet";
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline blocks
// ─────────────────────────────────────────────────────────────────────────────
function buildPlainText(text: string, variant: InlineVariant, ctx: ParseContext): PreparedBlock[] {
	const piece = textPiece(text, EMPTY_MARKS, variant);
	if (piece === null) return [];
	return buildPreparedInline([[piece]], variant, ctx);
}

function buildInlineBlocks(
	tokens: readonly Token[],
	variant: InlineVariant,
	ctx: ParseContext,
): PreparedBlock[] {
	const lines = collectInlineLines(tokens, variant);
	return buildPreparedInline(lines, variant, ctx);
}

function buildPreparedInline(
	lines: InlinePiece[][],
	variant: InlineVariant,
	ctx: ParseContext,
): PreparedBlock[] {
	const blocks: PreparedBlock[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		const block = buildOneInline(line, variant, ctx);
		if (block === null) continue;
		blocks.push({ ...block, marginTop: blocks.length === 0 ? 0 : 4 });
	}
	return blocks;
}

function buildOneInline(
	pieces: InlinePiece[],
	variant: InlineVariant,
	ctx: ParseContext,
): PreparedInlineBlock | null {
	if (pieces.length === 0) return null;
	const items: RichInlineItem[] = pieces.map((p) => ({
		text: p.text,
		font: p.font,
		break: p.breakMode,
		extraWidth: p.extraWidth,
	}));
	return {
		...blockBase(ctx),
		kind: "inline",
		flow: prepareRichInline(items),
		lineHeight: lineHeightForVariant(variant),
		classNames: pieces.map((p) => p.className),
		hrefs: pieces.map((p) => p.href),
		fonts: pieces.map((p) => p.font),
	};
}

function collectInlineLines(tokens: readonly Token[], variant: InlineVariant): InlinePiece[][] {
	const lines: InlinePiece[][] = [[]];
	const current = (): InlinePiece[] => {
		const line = lines.at(-1);
		if (line) return line;
		const next: InlinePiece[] = [];
		lines.push(next);
		return next;
	};
	const pushBreak = () => lines.push([]);
	const push = (piece: InlinePiece | null) => {
		if (piece === null) return;
		const line = current();
		const prev = line[line.length - 1];
		if (prev !== undefined && canMerge(prev, piece)) {
			prev.text += piece.text;
			return;
		}
		line.push(piece);
	};

	const walk = (list: readonly Token[], marks: MarkState) => {
		for (const token of list) {
			switch (token.type) {
				case "text": {
					const t = token as Tokens.Text;
					if (Array.isArray(t.tokens) && t.tokens.length > 0) walk(t.tokens, marks);
					else push(textPiece(t.text, marks, variant));
					continue;
				}
				case "escape":
					push(textPiece((token as Tokens.Escape).text, marks, variant));
					continue;
				case "strong":
					walk((token as Tokens.Strong).tokens ?? [], { ...marks, bold: true });
					continue;
				case "em":
					walk((token as Tokens.Em).tokens ?? [], { ...marks, italic: true });
					continue;
				case "del":
					walk((token as Tokens.Del).tokens ?? [], { ...marks, strike: true });
					continue;
				case "codespan":
					push(codePiece((token as Tokens.Codespan).text));
					continue;
				case "link":
					walk((token as Tokens.Link).tokens ?? [], {
						...marks,
						href: parseHref((token as Tokens.Link).href),
					});
					continue;
				case "image": {
					const img = token as Tokens.Image;
					push(textPiece(img.text.length > 0 ? img.text : (img.href ?? "image"), marks, variant));
					continue;
				}
				case "br":
					pushBreak();
					continue;
				case "html":
					push(textPiece((token as Tokens.HTML).text, marks, variant));
					continue;
				default: {
					const fb = fallbackText(token);
					if (fb.length > 0) push(textPiece(fb, marks, variant));
				}
			}
		}
	};

	walk(tokens, EMPTY_MARKS);
	while (lines.length > 0 && lines.at(-1)?.length === 0) lines.pop();
	return lines.length === 0 ? [[]] : lines;
}

function textPiece(text: string, marks: MarkState, variant: InlineVariant): InlinePiece | null {
	if (text.length === 0) return null;
	return {
		text,
		font: resolveFont(variant, marks),
		className: resolveClassName(variant, marks),
		href: marks.href,
		breakMode: "normal",
		extraWidth: 0,
	};
}

function codePiece(text: string): InlinePiece | null {
	if (text.length === 0) return null;
	return {
		text,
		font: FONT_INLINE_CODE,
		className: "vlist-frag vlist-frag--code",
		href: null,
		breakMode: "normal",
		extraWidth: INLINE_CODE_EXTRA_WIDTH,
	};
}

function canMerge(a: InlinePiece, b: InlinePiece): boolean {
	return (
		a.font === b.font &&
		a.className === b.className &&
		a.href === b.href &&
		a.breakMode === b.breakMode &&
		a.extraWidth === b.extraWidth
	);
}

function resolveFont(variant: InlineVariant, marks: MarkState): string {
	if (variant !== "body") {
		return headingFont(headingLevel(variant));
	}
	// Measure with the SAME weight+style the browser paints, else synthetic
	// bold/italic (applied via CSS) rewraps differently from the prediction.
	if (marks.bold && marks.italic) return FONT_BODY_BOLD_ITALIC;
	if (marks.bold) return FONT_BODY_BOLD;
	if (marks.italic) return FONT_BODY_ITALIC;
	if (marks.href !== null) return `${FONT_WEIGHT.regular} ${FONT_SIZE.sm}px ${SANS_FAMILY}`;
	return FONT_BODY;
}

function resolveClassName(variant: InlineVariant, marks: MarkState): string {
	let cls = "vlist-frag";
	if (variant === "body") cls += " vlist-frag--body";
	else cls += ` vlist-frag--${variant}`;
	if (marks.href !== null) cls += " is-link";
	if (marks.bold) cls += " is-strong";
	if (marks.italic) cls += " is-em";
	if (marks.strike) cls += " is-del";
	return cls;
}

// ─────────────────────────────────────────────────────────────────────────────
// Code / rule / unknown blocks
// ─────────────────────────────────────────────────────────────────────────────
function buildCodeBlock(text: string, lang: string | null, ctx: ParseContext): PreparedCodeBlock {
	return {
		...blockBase(ctx),
		kind: "code",
		prepared: prepareWithSegments(stripTrailingNewline(text), FONT_MARKDOWN_CODE, {
			whiteSpace: "pre-wrap",
		}),
		lineHeight: CODE_LINE_HEIGHT,
		lang: lang && lang.trim().length > 0 ? lang.trim() : null,
	};
}

function buildRuleBlock(ctx: ParseContext): PreparedRuleBlock {
	return { ...blockBase(ctx), kind: "rule", height: RULE_HEIGHT };
}

/** Build an unknown-height placeholder block (mermaid / katex). */
export function buildUnknownBlock(
	tag: PreparedUnknownBlock["tag"],
	placeholderHeight: number,
	ctx: ParseContext = { listDepth: 0, quoteDepth: 0 },
	data?: Record<string, unknown>,
): PreparedUnknownBlock {
	return { ...blockBase(ctx), kind: "unknown", tag, placeholderHeight, data };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────
function blockBase(ctx: ParseContext): PreparedBlockBase {
	const listIndent = ctx.listDepth * LIST_INDENT;
	const contentLeft = listIndent + ctx.quoteDepth * (BLOCKQUOTE_PADDING + BLOCKQUOTE_BORDER);
	const quoteRailLefts: number[] = [];
	for (let depth = 0; depth < ctx.quoteDepth; depth++) {
		quoteRailLefts.push(listIndent + depth * (BLOCKQUOTE_PADDING + BLOCKQUOTE_BORDER));
	}
	return {
		marginTop: 0,
		contentLeft,
		quoteRailLefts,
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
}

function appendGroup(target: PreparedBlock[], group: PreparedBlock[], firstMargin: number): void {
	if (group.length === 0) return;
	for (let i = 0; i < group.length; i++) {
		const block = group[i];
		if (!block) continue;
		const marginTop = i === 0 ? (target.length === 0 ? 0 : firstMargin) : block.marginTop;
		target.push({ ...block, marginTop });
	}
}

function headingVariant(depth: number): InlineVariant {
	if (depth <= 1) return "h1";
	if (depth === 2) return "h2";
	if (depth === 3) return "h3";
	if (depth === 4) return "h4";
	if (depth === 5) return "h5";
	return "h6";
}

function headingLevel(variant: InlineVariant): 1 | 2 | 3 | 4 | 5 | 6 {
	switch (variant) {
		case "h1":
			return 1;
		case "h2":
			return 2;
		case "h3":
			return 3;
		case "h4":
			return 4;
		case "h5":
			return 5;
		default:
			return 6;
	}
}

function headingSize(variant: InlineVariant): number {
	if (variant === "body") return FONT_SIZE.sm;
	return HEADING[variant].size;
}

function lineHeightForVariant(variant: InlineVariant): number {
	if (variant === "body") return BODY_LINE_HEIGHT;
	const h = HEADING[variant];
	return lineBoxHeight(h.size, h.lineHeight);
}

function parseHref(href: string | null | undefined): string | null {
	if (href == null) return null;
	try {
		const url = new URL(href);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

function fallbackText(token: Token): string {
	if ("text" in token && typeof (token as { text?: unknown }).text === "string") {
		return (token as { text: string }).text;
	}
	return (token as { raw?: string }).raw ?? "";
}

function formatTable(token: Tokens.Table): string {
	const header = token.header.map((cell) => inlineToPlain(cell.tokens)).join(" | ");
	const divider = token.header.map(() => "---").join(" | ");
	const rows = token.rows.map((row) => row.map((cell) => inlineToPlain(cell.tokens)).join(" | "));
	return [header, divider, ...rows].join("\n");
}

function inlineToPlain(tokens: readonly Token[]): string {
	let text = "";
	for (const token of tokens) {
		switch (token.type) {
			case "strong":
			case "em":
			case "del":
			case "link":
				text += inlineToPlain((token as Tokens.Strong).tokens ?? []);
				break;
			case "br":
				text += "\n";
				break;
			default:
				text += fallbackText(token);
		}
	}
	return text;
}

function stripTrailingNewline(text: string): string {
	return text.endsWith("\n") ? text.slice(0, -1) : text;
}

// Exported constants for the measure layer / tests.
export const MARKDOWN_CONSTANTS = {
	BODY_LINE_HEIGHT,
	CODE_LINE_HEIGHT,
	PARAGRAPH_MARGIN_TOP,
	LIST_MARGIN_TOP,
	CODE_MARGIN_TOP,
	RULE_HEIGHT,
	LIST_INDENT,
	BLOCKQUOTE_PADDING,
	BLOCKQUOTE_BORDER,
	CODE_LANG_EXTRA_TOP,
	INLINE_CODE_EXTRA_WIDTH,
	MERMAID_PLACEHOLDER_HEIGHT,
	KATEX_PLACEHOLDER_HEIGHT,
} as const;
