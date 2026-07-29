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
import type { RichInlineItem } from "@chenglou/pretext/rich-inline";
import { measureRichInlineStats, prepareRichInline } from "@chenglou/pretext/rich-inline";
import { marked, type Token, type Tokens } from "marked";
import type { GlyphWidthResolver, KatexRuntime } from "./katex-geometry";
import { measureKatex } from "./katex-geometry";
import { normalizeMathDelimiters, splitMathOutsideCode } from "./math-delimiters";
import type {
	InlineMathFragment,
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
	/** Present when KaTeX is available; absent means math stays literal text. */
	math?: MathSupport;
	/** Inline formulas lifted out before lexing, indexed by sentinel number. */
	formulas?: readonly string[];
}

interface InlinePiece {
	text: string;
	font: string;
	className: string;
	href: string | null;
	breakMode: "normal" | "never";
	extraWidth: number;
	/** Set when this piece is an inline formula rendered as a fixed-width atom. */
	math?: InlineMathFragment;
}

const EMPTY_MARKS: MarkState = { bold: false, italic: false, strike: false, href: null };

// ─────────────────────────────────────────────────────────────────────────────
// Math support
//
// LaTeX is measured by katex-geometry (pure arithmetic over KaTeX's own layout
// tree). The runtime is injected because KaTeX is lazily loaded — when it has
// not arrived yet, formulas degrade to literal source text rather than blocking.
// ─────────────────────────────────────────────────────────────────────────────

export interface MathSupport {
	katex: KatexRuntime;
	/** Real-font measurement for glyphs KaTeX lacks metrics for (CJK). */
	glyphWidth?: GlyphWidthResolver;
}

/**
 * Sentinel wrapper for an extracted inline formula.
 *
 * marked has no math extension, so LaTeX handed to its inline lexer can be
 * corrupted: `$a*b*c$` comes back with `*b*` turned into emphasis. Inline math is
 * therefore lifted out BEFORE lexing and replaced by a private-use-area sentinel
 * that carries no markdown meaning. Surrounding markdown still works (a formula
 * can sit inside bold, a link, a list item), and the LaTeX arrives verbatim.
 */
const MATH_SENTINEL_OPEN = "\uE000";
const MATH_SENTINEL_CLOSE = "\uE001";
const MATH_SENTINEL_RE = /\uE000(\d+)\uE001/g;

/**
 * Replace inline math with sentinels, leaving display math (`$$…$$`) in place for
 * the paragraph splitter and code regions untouched.
 */
function extractInlineMath(source: string): { text: string; formulas: string[] } {
	if (!source.includes("$")) return { text: source, formulas: [] };
	const formulas: string[] = [];
	let text = "";
	for (const segment of splitMathOutsideCode(source)) {
		if (segment.kind === "inline-math") {
			text += `${MATH_SENTINEL_OPEN}${formulas.length}${MATH_SENTINEL_CLOSE}`;
			formulas.push(segment.latex);
			continue;
		}
		text += segment.kind === "text" ? segment.text : `$$${segment.latex}$$`;
	}
	return { text, formulas };
}

/**
 * Placeholder glyph for an inline-math atom. NBSP is never a line-break
 * opportunity, so the atom can only move as a whole — a formula is never split
 * across lines. Its own advance is subtracted from the reserved `extraWidth`.
 */
const MATH_ATOM_PLACEHOLDER = "\u00a0";

/** Cached advance (px) of the placeholder per font, so the atom lands exactly. */
const placeholderAdvanceCache = new Map<string, number>();

function placeholderAdvance(font: string): number {
	const cached = placeholderAdvanceCache.get(font);
	if (cached !== undefined) return cached;
	const advance = measureRichInlineStats(
		prepareRichInline([{ text: MATH_ATOM_PLACEHOLDER, font, break: "never" }]),
		Number.MAX_SAFE_INTEGER,
	).maxLineWidth;
	placeholderAdvanceCache.set(font, advance);
	return advance;
}

/** Build an inline piece that occupies exactly the formula's measured width. */
function mathPiece(latex: string, font: string, math: MathSupport): InlinePiece | null {
	const geometry = measureKatex(math.katex, latex, {
		displayMode: false,
		basePx: FONT_SIZE.sm,
		glyphWidth: math.glyphWidth,
	});
	if (geometry.width <= 0) return null;
	return {
		text: MATH_ATOM_PLACEHOLDER,
		font,
		className: "vlist-frag vlist-frag--math",
		href: null,
		breakMode: "never",
		// pretext lays out `placeholderAdvance + extraWidth`; solve for the target.
		extraWidth: geometry.width - placeholderAdvance(font),
		math: {
			html: geometry.html,
			width: geometry.width,
			height: geometry.height,
			latex,
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry: markdown string → PreparedBlock[]
// ─────────────────────────────────────────────────────────────────────────────
export function parseMarkdownToPreparedBlocks(
	markdown: string,
	math?: MathSupport,
): PreparedBlock[] {
	if (!math) {
		const tokens = marked.lexer(markdown, { gfm: true });
		return parseBlockTokens(tokens, { listDepth: 0, quoteDepth: 0 });
	}
	// Normalize `\(...\)` / `\[...\]` to the dollar forms so one code path handles
	// every delimiter models emit, then lift inline formulas out of reach of
	// marked's inline lexer (see MATH_SENTINEL_OPEN).
	const normalized = normalizeMathDelimiters(markdown);
	const { text, formulas } = extractInlineMath(normalized);
	const tokens = marked.lexer(text, { gfm: true });
	return parseBlockTokens(tokens, { listDepth: 0, quoteDepth: 0, math, formulas });
}

/**
 * Prepare ONE top-level token, positioned as first or non-first in the document.
 *
 * `appendGroup` zeroes the leading margin of whatever lands at index 0, so a
 * non-first token is prepared into a pre-seeded target and the seed is then dropped.
 * That reproduces the contextual `marginTop` the token would receive mid-document —
 * which is not a single constant (a heading and a paragraph differ), so it must come
 * from the parser rather than be assumed.
 */
function prepareSingleToken(
	token: Token,
	isFirst: boolean,
	math: MathSupport | undefined,
	formulas: readonly string[] | undefined,
): PreparedBlock[] {
	const ctx: ParseContext = {
		listDepth: 0,
		quoteDepth: 0,
		...(math ? { math, formulas } : {}),
	};
	if (isFirst) return parseBlockTokens([token], ctx);
	// Any preceding block makes the next one "non-first"; a plain paragraph is the
	// cheapest seed and its own blocks are discarded.
	const seedTokens = marked.lexer("x\n\n", { gfm: true });
	const seeded = parseBlockTokens([...seedTokens, token], ctx);
	const seedOnly = parseBlockTokens(seedTokens, ctx);
	return seeded.slice(seedOnly.length);
}

/** One top-level markdown block: its source text plus its prepared blocks. */
export interface PreparedMarkdownUnit {
	/** Exact source slice this unit was produced from (`token.raw`). */
	raw: string;
	/** True when this unit is the document's first rendered block (marginTop 0). */
	isFirst: boolean;
	blocks: PreparedBlock[];
	/**
	 * Source length consumed up to and including this unit, counting the `space` /
	 * `def` tokens that produce no blocks.
	 *
	 * `raw` alone does not add up to the source: blank lines between blocks live in
	 * separate `space` tokens. A caller using `raw` lengths to locate a resume offset
	 * would fall short by every gap and never make progress, so the running total is
	 * reported here instead of left to be re-derived.
	 */
	consumedLength: number;
}

/**
 * Parse markdown into per-top-level-block units.
 *
 * Same result as {@link parseMarkdownToPreparedBlocks} when the units' blocks are
 * concatenated in order, but it exposes the LEXER's own block boundaries and the
 * source slice behind each one. That is what makes incremental preparation of a
 * streaming body possible without guessing where blocks end: a growing body changes
 * only its final token(s), so every earlier unit's `raw` is unchanged and its
 * (expensive) preparation can be reused verbatim.
 *
 * `reuse` is consulted per unit, keyed on `(isFirst, raw)`. Returning cached blocks
 * from it skips the pretext pre-measurement for that block — the dominant cost.
 */
export interface ParseMarkdownUnitsOptions {
	/**
	 * True when `markdown` is a CONTINUATION of a longer document rather than its
	 * start.
	 *
	 * The first rendered block of a document has `marginTop: 0`; a mid-document block
	 * carries its contextual top margin instead. When a caller prepares only the live
	 * remainder of a streaming body, that remainder's first unit is NOT the document's
	 * first block — without this flag it silently loses one block margin.
	 */
	continuation?: boolean;
	/** Reuse hook, consulted per unit as `(raw, isFirst)`. */
	reuse?: (raw: string, isFirst: boolean) => PreparedBlock[] | undefined;
}

export function parseMarkdownUnits(
	markdown: string,
	math?: MathSupport,
	options: ParseMarkdownUnitsOptions = {},
): PreparedMarkdownUnit[] {
	const { continuation = false, reuse } = options;
	// Math lifting rewrites the source before lexing, so the units' `raw` values are
	// slices of the REWRITTEN text. That is internally consistent (they are only ever
	// compared against each other and re-parsed through this same path), and it keeps
	// formula handling identical to the whole-document parse.
	const source = math ? extractInlineMath(normalizeMathDelimiters(markdown)) : undefined;
	const text = source?.text ?? markdown;
	const formulas = source?.formulas;
	const tokens = marked.lexer(text, { gfm: true });
	const units: PreparedMarkdownUnit[] = [];
	let isFirst = !continuation;
	let consumed = 0;
	for (const token of tokens) {
		consumed += token.raw.length;
		// `space` / `def` produce no blocks; skipping them here keeps unit identity
		// aligned with what parseBlockTokens would emit. Their length is still counted
		// above so `consumedLength` tracks the real source offset.
		if (token.type === "space" || token.type === "def") continue;
		const raw = token.raw;
		const cached = reuse?.(raw, isFirst);
		const blocks = cached ?? prepareSingleToken(token, isFirst, math, formulas);
		units.push({ raw, isFirst, blocks, consumedLength: consumed });
		isFirst = false;
	}
	return units;
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
			case "paragraph": {
				// marked has no math extension, so `$$...$$` arrives inside a normal
				// paragraph. Peel display formulas into their own blocks first.
				const withDisplay = buildParagraphWithDisplayMath(token as Tokens.Paragraph, ctx);
				if (withDisplay) {
					appendGroup(blocks, withDisplay, PARAGRAPH_MARGIN_TOP);
					continue;
				}
				appendGroup(
					blocks,
					buildInlineBlocks(token.tokens ?? [], "body", ctx),
					PARAGRAPH_MARGIN_TOP,
				);
				continue;
			}
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
					appendGroup(blocks, [buildDisplayMathBlock(token.text, ctx, lang)], CODE_MARGIN_TOP);
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
						...ctx,
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
// Display math
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a measured display-math block.
 *
 * Reuses the `unknown` block channel (its render path already stacks in normal
 * flow), but unlike mermaid the height here is EXACT: `placeholderHeight` is the
 * measured value and `intrinsicWidth` is set, so virtualization needs no
 * post-paint correction. Without KaTeX loaded it degrades to the conservative
 * placeholder and the renderer shows the source.
 */
function buildDisplayMathBlock(
	latex: string,
	ctx: ParseContext,
	lang = "math",
): PreparedUnknownBlock {
	const source = latex.trim();
	if (!ctx.math) {
		return buildUnknownBlock("katex", KATEX_PLACEHOLDER_HEIGHT, ctx, { source, lang });
	}
	const geometry = measureKatex(ctx.math.katex, source, {
		displayMode: true,
		basePx: FONT_SIZE.sm,
		glyphWidth: ctx.math.glyphWidth,
	});
	const block = buildUnknownBlock("katex", Math.max(1, Math.ceil(geometry.height)), ctx, {
		source,
		lang,
		html: geometry.html,
		displayMode: true,
		error: geometry.error,
	});
	return { ...block, intrinsicWidth: geometry.width };
}

/**
 * Split a paragraph that contains `$$...$$` into inline runs and display blocks.
 *
 * Returns null when the paragraph has no display math, so the ordinary path
 * stays untouched. marked lexes the paragraph as plain inline tokens (it has no
 * math extension), so the `raw`/`text` source is re-scanned here.
 */
function buildParagraphWithDisplayMath(
	token: Tokens.Paragraph,
	ctx: ParseContext,
): PreparedBlock[] | null {
	if (!ctx.math) return null;
	const source = token.raw ?? token.text ?? "";
	if (!source.includes("$$")) return null;
	const segments = splitMathOutsideCode(source);
	if (!segments.some((segment) => segment.kind === "display-math")) return null;

	const blocks: PreparedBlock[] = [];
	let pending = "";
	const flushText = () => {
		const text = pending.trim();
		pending = "";
		if (text.length === 0) return;
		// Re-lex the prose run so its own markdown (and any INLINE math) is honored.
		for (const block of parseInlineSource(text, ctx)) blocks.push(block);
	};

	for (const segment of segments) {
		if (segment.kind === "display-math") {
			flushText();
			blocks.push(buildDisplayMathBlock(segment.latex, ctx));
			continue;
		}
		pending += segment.kind === "text" ? segment.text : `$${segment.latex}$`;
	}
	flushText();
	return blocks.length > 0 ? blocks : null;
}

/** Lex a prose run as inline markdown and build its inline blocks. */
function parseInlineSource(source: string, ctx: ParseContext): PreparedBlock[] {
	const tokens = marked.lexer(source, { gfm: true });
	const blocks: PreparedBlock[] = [];
	for (const block of parseBlockTokens(tokens, ctx)) blocks.push(block);
	return blocks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lists
// ─────────────────────────────────────────────────────────────────────────────
function buildListBlocks(token: Tokens.List, ctx: ParseContext): PreparedBlock[] {
	const blocks: PreparedBlock[] = [];
	const itemCtx: ParseContext = { ...ctx, listDepth: ctx.listDepth + 1 };

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
	// A bare text run can still carry inline-math sentinels (list items and
	// token-less text blocks reach here), so expand them the same way.
	if (ctx.math != null && ctx.formulas != null && text.includes(MATH_SENTINEL_OPEN)) {
		const lines = collectInlineLines([{ type: "text", raw: text, text }] as Token[], variant, ctx);
		return buildPreparedInline(lines, variant, ctx);
	}
	const piece = textPiece(text, EMPTY_MARKS, variant);
	if (piece === null) return [];
	return buildPreparedInline([[piece]], variant, ctx);
}

function buildInlineBlocks(
	tokens: readonly Token[],
	variant: InlineVariant,
	ctx: ParseContext,
): PreparedBlock[] {
	const lines = collectInlineLines(tokens, variant, ctx);
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
	const hasMath = pieces.some((p) => p.math != null);
	// A formula taller than the text line box must grow the line, or its glyphs
	// would overlap the neighbouring lines. `PreparedInlineBlock` carries a single
	// lineHeight, so the whole block adopts the tallest formula's height — the same
	// thing the browser's own line-height calculation does.
	let lineHeight = lineHeightForVariant(variant);
	if (hasMath) {
		for (const piece of pieces) {
			if (piece.math && piece.math.height > lineHeight) lineHeight = Math.ceil(piece.math.height);
		}
	}
	return {
		...blockBase(ctx),
		kind: "inline",
		flow: prepareRichInline(items),
		lineHeight,
		classNames: pieces.map((p) => p.className),
		hrefs: pieces.map((p) => p.href),
		fonts: pieces.map((p) => p.font),
		...(hasMath ? { mathHtmls: pieces.map((p) => p.math ?? null) } : {}),
	};
}

function collectInlineLines(
	tokens: readonly Token[],
	variant: InlineVariant,
	ctx: ParseContext,
): InlinePiece[][] {
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

	/**
	 * Push a text run, expanding any inline-math sentinels it contains into
	 * fixed-width atoms. Text without sentinels takes the plain path.
	 */
	const pushText = (text: string, marks: MarkState) => {
		if (ctx.math == null || ctx.formulas == null || !text.includes(MATH_SENTINEL_OPEN)) {
			push(textPiece(text, marks, variant));
			return;
		}
		MATH_SENTINEL_RE.lastIndex = 0;
		let cursor = 0;
		for (;;) {
			const match = MATH_SENTINEL_RE.exec(text);
			if (!match) break;
			if (match.index > cursor) {
				push(textPiece(text.slice(cursor, match.index), marks, variant));
			}
			const latex = ctx.formulas[Number(match[1])];
			const piece = latex != null ? mathPiece(latex, resolveFont(variant, marks), ctx.math) : null;
			// A formula that cannot be measured degrades to its literal source.
			push(piece ?? textPiece(latex != null ? `$${latex}$` : match[0], marks, variant));
			cursor = match.index + match[0].length;
		}
		if (cursor < text.length) push(textPiece(text.slice(cursor), marks, variant));
	};

	const walk = (list: readonly Token[], marks: MarkState) => {
		for (const token of list) {
			switch (token.type) {
				case "text": {
					const t = token as Tokens.Text;
					if (Array.isArray(t.tokens) && t.tokens.length > 0) walk(t.tokens, marks);
					else pushText(t.text, marks);
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
	// A math atom's width lives in its own `extraWidth`; concatenating its
	// placeholder text into a neighbour would silently drop the formula.
	if (a.math != null || b.math != null) return false;
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
