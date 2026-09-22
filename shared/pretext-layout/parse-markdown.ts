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
import { prepareMarkdownEmphasis, stripEmphasisSentinel } from "../markdown-emphasis-compat";
import { fileLinkLineSuffix, localFileHref, parseLocalFilePath } from "../markdown-file-path";
import type { GlyphVerticalResolver, GlyphWidthResolver, KatexRuntime } from "./katex-geometry";
import { measureKatex } from "./katex-geometry";
import { inlineTokensToPlainText, slugifyHeading } from "./markdown-anchor";
import { normalizeMathDelimiters, splitMathOutsideCode } from "./math-delimiters";
import type {
	InlineMathFragment,
	PreparedBlock,
	PreparedBlockBase,
	PreparedCodeBlock,
	PreparedInlineBlock,
	PreparedRuleBlock,
	PreparedTableBlock,
	PreparedTableCell,
	PreparedUnknownBlock,
} from "./prepared-block";
import {
	BASE_LINE_HEIGHT,
	CODE_BLOCK_FONT_SIZE,
	emToPx,
	FONT_SIZE,
	HEADING,
	headingMetrics,
	LINE_HEIGHT,
	lineBoxHeight,
	typographyMetrics,
} from "./pretext-fonts";
import { letterSpacingForFont, scaleBlockSpacing } from "./typography";

// ── Layout constants (px), mirroring MarkdownContent.module.css ──────────────
//
// These are the NEUTRAL baseline (100% typography). Anything that feeds
// measurement reads `typographyMetrics()` / `markdownMetrics()` instead so the
// reader's font scale and block spacing apply; the constants remain as the
// reference those scalings are defined against, and as the values the render layer
// falls back to when it has no block in hand.
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
 * Upper bound used to measure a cell's max-content width. Large enough that no
 * realistic cell wraps, small enough to stay far from float-precision trouble.
 */
const TABLE_NATURAL_WIDTH_BOUND = 1e7;

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

const EMPTY_MARKS: MarkState = {
	bold: false,
	italic: false,
	strike: false,
	href: null,
};

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
	/** Real-font VERTICAL metrics for the same glyphs (KaTeX reports no descender). */
	glyphVertical?: GlyphVerticalResolver;
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
function extractInlineMath(
	source: string,
	sourceOffsets?: number[],
): { text: string; formulas: string[] } {
	if (!source.includes("$")) return { text: source, formulas: [] };
	const formulas: string[] = [];
	const chunks: string[] = [];
	const mapped: number[] = [];
	splitMathOutsideCode(source, (segment, start, end) => {
		if (segment.kind === "inline-math") {
			const sentinel = `${MATH_SENTINEL_OPEN}${formulas.length}${MATH_SENTINEL_CLOSE}`;
			chunks.push(sentinel);
			formulas.push(segment.latex);
			if (sourceOffsets)
				for (let i = 0; i < sentinel.length; i++) mapped.push(sourceOffsets[start] as number);
			return;
		}
		chunks.push(segment.kind === "text" ? segment.text : `$$${segment.latex}$$`);
		if (!sourceOffsets) return;
		if (segment.kind === "text") {
			for (let i = start; i < end; i++) mapped.push(sourceOffsets[i] as number);
		} else {
			mapped.push(sourceOffsets[start] as number, sourceOffsets[start + 1] as number);
			const body = source.slice(start + 2, end - 2);
			const bodyStart = start + 2 + body.length - body.trimStart().length;
			for (let i = 0; i < segment.latex.length; i++)
				mapped.push(sourceOffsets[bodyStart + i] as number);
			mapped.push(sourceOffsets[end - 2] as number, sourceOffsets[end - 1] as number);
		}
	});
	if (sourceOffsets) {
		mapped.push(sourceOffsets[source.length] as number);
		sourceOffsets.length = 0;
		for (const offset of mapped) sourceOffsets.push(offset);
	}
	return { text: chunks.join(""), formulas };
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
		// MUST stay in lockstep with the font size the render layer pins on the math
		// host — KaTeX's root is `1.21em`, so any mismatch rescales the formula away
		// from this measurement (see MATH_BASE_FONT_SIZE).
		basePx: typographyMetrics().mathSize,
		glyphWidth: math.glyphWidth,
		glyphVertical: math.glyphVertical,
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
	// `prepareMarkdownEmphasis` only rewrites pairs CommonMark would refuse
	// (`**注意：**说明`); legal `**bold**` is byte-identical.
	if (!math) {
		const tokens = marked.lexer(prepareMarkdownEmphasis(markdown), { gfm: true });
		return parseBlockTokens(tokens, { listDepth: 0, quoteDepth: 0 });
	}
	// Normalize `\(...\)` / `\[...\]` to the dollar forms so one code path handles
	// every delimiter models emit, then lift inline formulas out of reach of
	// marked's inline lexer (see MATH_SENTINEL_OPEN).
	const normalized = normalizeMathDelimiters(markdown);
	const { text, formulas } = extractInlineMath(normalized);
	const tokens = marked.lexer(prepareMarkdownEmphasis(text), { gfm: true });
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
	//
	// Both the seed's lex and its block COUNT are constants, so each is computed at
	// most once (see below). This function runs per unit on the streaming path —
	// every frame, for every unit of the live tail — and it used to re-lex `"x\n\n"`
	// and run `parseBlockTokens` TWICE per call to rediscover the same two values.
	const seeded = parseBlockTokens([...marginSeedTokens(), token], ctx);
	return seeded.slice(marginSeedBlockCount());
}

/**
 * Lexed seed used to give a non-first token its contextual top margin: a plain
 * paragraph plus the blank line after it, the cheapest thing that makes
 * `appendGroup` treat the NEXT token as mid-document.
 */
let cachedMarginSeedTokens: readonly Token[] | undefined;

function marginSeedTokens(): readonly Token[] {
	cachedMarginSeedTokens ??= marked.lexer("x\n\n", { gfm: true });
	return cachedMarginSeedTokens;
}

/**
 * Blocks the seed itself contributes (one paragraph; the `space` token emits none).
 *
 * Independent of the parse context — the seed is plain ASCII with no math, no list
 * nesting and no quote nesting, so no `ParseContext` field can change how many
 * blocks it produces. Derived rather than hard-coded so it follows the seed source.
 *
 * Computed LAZILY, never at module scope: `parseBlockTokens` reaches pretext, which
 * needs a canvas, and measure tests install their stub in `beforeAll` — after the
 * import graph is built (CONTRACT §5). Doing this eagerly threw
 * "Text measurement requires OffscreenCanvas" at import time for every test that
 * loads this module statically.
 */
let cachedMarginSeedBlockCount: number | undefined;

function marginSeedBlockCount(): number {
	cachedMarginSeedBlockCount ??= parseBlockTokens(marginSeedTokens(), {
		listDepth: 0,
		quoteDepth: 0,
	}).length;
	return cachedMarginSeedBlockCount;
}

/** One top-level markdown block: its source text plus its prepared blocks. */
export interface PreparedMarkdownUnit {
	/** Exact ORIGINAL source slice, before math/emphasis/newline preprocessing. */
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
	// Lexer offsets belong to transformed text, but the streaming cache slices the
	// ORIGINAL input. Carry boundaries through math lifting, inserted emphasis
	// sentinels and marked's CRLF normalization. No second Markdown parse is needed.
	const sourceOffsets = math ? Array.from({ length: markdown.length + 1 }, (_, i) => i) : undefined;
	const source = math
		? extractInlineMath(normalizeMathDelimiters(markdown, sourceOffsets), sourceOffsets)
		: undefined;
	const insertions: number[] = [];
	const text = prepareMarkdownEmphasis(source?.text ?? markdown, (offset) =>
		insertions.push(offset + insertions.length),
	);
	let lexerOffsets: number[] | undefined;
	if (text.includes("\r")) {
		lexerOffsets = [];
		for (let i = 0; i < text.length; i++) {
			lexerOffsets.push(i);
			if (text[i] === "\r" && text[i + 1] === "\n") i++;
		}
		lexerOffsets.push(text.length);
	}
	let inserted = 0;
	const originalOffset = (offset: number): number => {
		const boundary = lexerOffsets?.[offset] ?? offset;
		while ((insertions[inserted] ?? Infinity) < boundary) inserted++;
		const beforeEmphasis = boundary - inserted;
		return sourceOffsets?.[beforeEmphasis] ?? beforeEmphasis;
	};
	const formulas = source?.formulas;
	const tokens = marked.lexer(text, { gfm: true });
	const units: PreparedMarkdownUnit[] = [];
	let isFirst = !continuation;
	let consumed = 0;
	for (const token of tokens) {
		const start = originalOffset(consumed);
		consumed += token.raw.length;
		const end = originalOffset(consumed);
		// `space` / `def` produce no blocks; skipping them here keeps unit identity
		// aligned with what parseBlockTokens would emit. Their length is still counted
		// above so `consumedLength` tracks the real source offset.
		if (token.type === "space" || token.type === "def") continue;
		const raw = markdown.slice(start, end);
		const cached = reuse?.(raw, isFirst);
		const blocks = cached ?? prepareSingleToken(token, isFirst, math, formulas);
		units.push({ raw, isFirst, blocks, consumedLength: end });
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
			case "checkbox":
				// marked (gfm) unshifts a BLOCK-level checkbox token into a non-loose
				// task item's tokens (loose items carry it inline instead — skipped in
				// collectInlineLines). The box is already painted from item.task /
				// item.checked as structured task-marker state, so the token carries no
				// content of its own; the default fallback would print its raw "[ ] ".
				continue;
			case "paragraph": {
				// marked has no math extension, so `$$...$$` arrives inside a normal
				// paragraph. Peel display formulas into their own blocks first.
				const withDisplay = buildParagraphWithDisplayMath(token as Tokens.Paragraph, ctx);
				if (withDisplay) {
					appendGroup(blocks, withDisplay, typographyMetrics().margin.paragraph);
					continue;
				}
				appendGroup(
					blocks,
					buildInlineBlocks(token.tokens ?? [], "body", ctx),
					typographyMetrics().margin.paragraph,
				);
				continue;
			}
			case "heading": {
				const variant = headingVariant(token.depth);
				const headingBlocks = buildInlineBlocks(token.tokens ?? [], variant, ctx);
				// Tag the heading with the anchor slug a `[x](#…)` link resolves against.
				// Derived from the inline TOKENS, not `token.text`: the raw source of
				// `## 见 [文档](https://x)` would slug the url into the anchor.
				//
				// Only the first block is tagged — a heading that wraps produces several
				// inline blocks, and an anchor must name one landing point.
				attachHeadingSlug(
					headingBlocks,
					slugifyHeading(
						inlineTokensToPlainText(
							(token.tokens ?? []) as readonly { type?: string; text?: string }[],
						),
					),
				);
				appendGroup(blocks, headingBlocks, headingMarginTop(variant));
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
						typographyMetrics().margin.code,
					);
					continue;
				}
				// Display-math code fences (if any lexer surfaces them as code).
				if (lang === "math" || lang === "katex" || lang === "latex") {
					appendGroup(
						blocks,
						[buildDisplayMathBlock(token.text, ctx, lang)],
						typographyMetrics().margin.code,
					);
					continue;
				}
				appendGroup(
					blocks,
					[buildCodeBlock(token.text, token.lang ?? null, ctx)],
					typographyMetrics().margin.code,
				);
				continue;
			}
			case "list":
				appendGroup(
					blocks,
					buildListBlocks(token as Tokens.List, ctx),
					typographyMetrics().margin.list,
				);
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
				appendGroup(blocks, [buildRuleBlock(ctx)], typographyMetrics().margin.paragraph);
				continue;
			case "table":
				appendGroup(
					blocks,
					[buildTableBlock(token as Tokens.Table, ctx)],
					typographyMetrics().margin.table,
				);
				continue;
			case "text": {
				const t = token as Tokens.Text;
				if (Array.isArray(t.tokens) && t.tokens.length > 0) {
					appendGroup(
						blocks,
						buildInlineBlocks(t.tokens, "body", ctx),
						typographyMetrics().margin.paragraph,
					);
				} else {
					appendGroup(
						blocks,
						buildPlainText(t.text, "body", ctx),
						typographyMetrics().margin.paragraph,
					);
				}
				continue;
			}
			default: {
				const fallback = fallbackText(token);
				if (fallback.length > 0) {
					appendGroup(
						blocks,
						buildPlainText(fallback, "body", ctx),
						typographyMetrics().margin.paragraph,
					);
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
		// Same lockstep requirement as inline math (see MATH_BASE_FONT_SIZE).
		basePx: typographyMetrics().mathSize,
		glyphWidth: ctx.math.glyphWidth,
		glyphVertical: ctx.math.glyphVertical,
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
		if (item.task && itemBlocks[0]) {
			itemBlocks[0] = {
				...itemBlocks[0],
				taskMarker: { checked: !!item.checked, label: item.text },
			};
		}
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

/**
 * Tag a heading's FIRST inline block with its anchor slug.
 *
 * Mutates the array in place the way `decorateListItem` does, and for the same
 * reason: the blocks were just built here and are not yet shared with anyone. It
 * must stay that way — `prepared-markdown-cache` hands the SAME block objects to
 * every consumer of a given text, so tagging a cached block would leak the slug
 * into unrelated bodies.
 *
 * A slug-less heading (`## ***`) is left untagged rather than tagged with "": an
 * empty attribute would match an empty query and turn every unresolvable anchor
 * into a jump to the first such heading.
 */
function attachHeadingSlug(blocks: PreparedBlock[], slug: string): void {
	if (slug.length === 0) return;
	const first = blocks[0];
	if (!first || first.kind !== "inline") return;
	blocks[0] = { ...first, headingSlug: slug };
}

function markerText(list: Tokens.List, item: Tokens.ListItem, index: number): string {
	if (item.task) return item.checked ? "[x]" : "[ ]";
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
	const lines = collectInlineLines([{ type: "text", raw: text, text }] as Token[], variant, ctx);
	return buildPreparedInline(lines, variant, ctx);
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
	// Letter spacing is PER ITEM because the setting is an em fraction and the items
	// in one line can differ in size (body prose, a smaller inline-code chip, a
	// heading). Applying one line-wide value would over-space the small runs.
	//
	// Resolved from each piece's own font size rather than a role lookup: that keeps
	// this correct for pieces whose size does not come from a named role. Omitted at
	// 0 so an unscaled document produces the same prepared handle as before.
	const items: RichInlineItem[] = pieces.map((p) => {
		const spacing = letterSpacingForFont(p.font);
		return {
			text: p.text,
			font: p.font,
			break: p.breakMode,
			extraWidth: p.extraWidth,
			...(spacing ? { letterSpacing: spacing } : {}),
		};
	});
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

	// Only authored Markdown links carry hrefs. Prose cannot reliably distinguish
	// a Chinese filename from adjacent Chinese narrative, so never scan text for paths.
	const pushPlainText = (text: string, marks: MarkState) => {
		push(textPiece(text, marks, variant));
	};

	/** Expand math sentinels without changing their surrounding text or link marks. */
	const pushText = (text: string, marks: MarkState) => {
		if (ctx.math == null || ctx.formulas == null || !text.includes(MATH_SENTINEL_OPEN)) {
			pushPlainText(text, marks);
			return;
		}
		MATH_SENTINEL_RE.lastIndex = 0;
		let cursor = 0;
		for (;;) {
			const match = MATH_SENTINEL_RE.exec(text);
			if (!match) break;
			if (match.index > cursor) {
				pushPlainText(text.slice(cursor, match.index), marks);
			}
			const latex = ctx.formulas[Number(match[1])];
			const piece = latex != null ? mathPiece(latex, resolveFont(variant, marks), ctx.math) : null;
			// A formula that cannot be measured degrades to its literal source.
			push(piece ?? textPiece(latex != null ? `$${latex}$` : match[0], marks, variant));
			cursor = match.index + match[0].length;
		}
		if (cursor < text.length) pushPlainText(text.slice(cursor), marks);
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
					push(codePiece((token as Tokens.Codespan).text, marks));
					continue;
				case "link": {
					const link = token as Tokens.Link;
					const linkMarks = { ...marks, href: parseHref(link.href) };
					walk(link.tokens ?? [], linkMarks);
					// Append once to the logical link BEFORE measuring. Decorating each
					// painted fragment would repeat the suffix and invalidate line widths.
					const suffix = fileLinkLineSuffix(
						linkMarks.href ?? undefined,
						inlineTokensToPlainText(link.tokens ?? []),
					);
					push(textPiece(suffix, linkMarks, variant));
					continue;
				}
				case "image": {
					const img = token as Tokens.Image;
					push(textPiece(img.text.length > 0 ? img.text : (img.href ?? "image"), marks, variant));
					continue;
				}
				case "br":
					pushBreak();
					continue;
				case "checkbox":
					// Loose task items carry the checkbox as the first INLINE token of
					// their opening paragraph (non-loose items put it at block level —
					// skipped in parseBlockTokens). The list marker already paints the
					// box, so emitting the raw "[ ] " here would duplicate it.
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
	// Flank sentinels (see markdown-emphasis-compat) must never reach measure or paint.
	const visible = stripEmphasisSentinel(text);
	if (visible.length === 0) return null;
	return {
		text: visible,
		font: resolveFont(variant, marks),
		className: resolveClassName(variant, marks),
		href: marks.href,
		breakMode: "normal",
		extraWidth: 0,
	};
}

/**
 * An inline `code` run. `href` is inherited from the surrounding marks so that
 * ``[`code`](url)`` stays a link: the codespan token carries no href of its own,
 * and hardcoding `null` here dropped the target of every link whose label was
 * entirely (or partly) inline code — the render layer emits a `<span>` instead
 * of an `<a>` when the fragment's href is null, so the text simply went dead.
 * Geometry is unaffected: the href only decides which element wraps the same
 * measured fragment box.
 */
function codePiece(text: string, marks: MarkState): InlinePiece | null {
	if (text.length === 0) return null;
	return {
		text,
		font: typographyMetrics().font.inlineCode,
		className: `vlist-frag vlist-frag--code${marks.href !== null ? " is-link" : ""}`,
		href: marks.href,
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
		return headingMetrics(headingLevel(variant)).font;
	}
	// Measure with the SAME weight+style the browser paints, else synthetic
	// bold/italic (applied via CSS) rewraps differently from the prediction.
	//
	// Read live (not from the module-level FONT_BODY* constants) so the reader's
	// font scale reaches measurement; the render layer paints from the same
	// `fonts[]` array these strings land in, which is what keeps the two in step.
	const { font } = typographyMetrics();
	if (marks.bold && marks.italic) return font.bodyBoldItalic;
	if (marks.bold) return font.bodyBold;
	if (marks.italic) return font.bodyItalic;
	// A link measures as plain body text (colour only, no weight change).
	return font.body;
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
	const metrics = typographyMetrics();
	return {
		...blockBase(ctx),
		kind: "code",
		// Called directly, NOT through `prepared-markdown-cache`: that module imports
		// this one, so reaching back would close a cycle. Caching is not lost — the
		// whole parse result is memoised one level up, keyed on the typography
		// generation, so this runs once per (text, generation) anyway.
		//
		// `letterSpacing` is omitted at 0 to keep pretext's no-spacing fast path and
		// to leave an unscaled document's prepared handles byte-identical to before.
		prepared: prepareWithSegments(stripTrailingNewline(text), metrics.font.markdownCode, {
			whiteSpace: "pre-wrap",
			...(metrics.letterSpacing.code ? { letterSpacing: metrics.letterSpacing.code } : {}),
		}),
		lineHeight: metrics.line.code,
		lang: lang && lang.trim().length > 0 ? lang.trim() : null,
	};
}

function buildRuleBlock(ctx: ParseContext): PreparedRuleBlock {
	return { ...blockBase(ctx), kind: "rule", height: RULE_HEIGHT };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a GFM table as a first-class prepared block.
 *
 * Each cell is prepared exactly like a paragraph (same inline walker, so bold /
 * links / inline code / inline math all work inside cells), then measured twice to
 * capture the intrinsic widths the column solver needs:
 *   - natural (max-content): laid out at effectively infinite width
 *   - min     (min-content): laid out at 1px, which forces every legal break
 *
 * Both are width-independent properties of the content, so they belong here in the
 * prepared layer and never need recomputing on resize.
 */
function buildTableBlock(token: Tokens.Table, ctx: ParseContext): PreparedTableBlock {
	const header = token.header.map((cell) => buildTableCell(cell, true, ctx));
	const rows = token.rows.map((row) => row.map((cell) => buildTableCell(cell, false, ctx)));

	let columns = header.length;
	for (const row of rows) {
		if (row.length > columns) columns = row.length;
	}

	// `align` is normalized to `columns` entries so it can be indexed by column.
	//
	// It comes from the DELIMITER row, so `token.align.length` is the HEADER's column
	// count, whereas `columns` is the max across header and body. Those agree for
	// every input marked can currently produce — it truncates a body row to the
	// header's width at the lexer (a 4-cell row under a 2-column header arrives as 2
	// cells) and refuses a table whose delimiter row disagrees with its header
	// outright — so today the two lengths cannot diverge.
	//
	// Normalizing anyway makes `align.length === columns` a property of this block
	// rather than a coincidence of the lexer's ragged-row handling, because the cost
	// of it silently ceasing to hold is high and invisible: every consumer walks by
	// column index (`solveTableColumns`, `layoutTable`, the renderer's
	// `columnWidths[i]` / `align[i]`), so a short `align` would drop the surplus
	// columns from measurement AND paint in lockstep — no layout drift to notice,
	// just content gone. Unspecified columns get GFM's default alignment, which is
	// what the delimiter row says about a column it never described.
	// `parse-markdown-table.test.ts` asserts the invariant across malformed sources.
	const align: Array<"left" | "center" | "right" | null> = new Array(columns).fill(null);
	for (let c = 0; c < columns; c++) {
		align[c] = token.align[c] ?? null;
	}

	return {
		...blockBase(ctx),
		kind: "table",
		header,
		rows,
		align,
		columns,
		lineHeight: typographyMetrics().line.body,
	};
}

/** Prepare one table cell's inline flow plus its two intrinsic widths. */
function buildTableCell(
	cell: Tokens.TableCell,
	isHeader: boolean,
	ctx: ParseContext,
): PreparedTableCell {
	// A cell is single-line by nature: `collectInlineLines` can split on `<br>`,
	// but a table cell has no block flow to stack them into, so every piece is
	// flattened into one flow (which then wraps on width like any inline text).
	const lines = collectInlineLines(cell.tokens ?? [], "body", ctx);
	const pieces: InlinePiece[] = [];
	for (const line of lines) {
		for (const piece of line) pieces.push(piece);
	}
	// Header cells paint at medium weight (Mantine Table.Th), so they must also be
	// MEASURED at that weight or the predicted column width is too narrow.
	const resolved = isHeader ? pieces.map(boldenPiece) : pieces;
	// Letter spacing is applied per piece, exactly as `buildOneInline` does for a
	// paragraph. Leaving it out here did not merely mis-size the text: the render layer
	// paints cell fragments through `letterSpacingForFont` regardless, so measured and
	// painted advances disagreed — the failure mode `letterSpacingForFont` itself warns
	// about. It also fed the column solver: `naturalWidth` and `minWidth` below are the
	// max-content/min-content inputs to `solveTableColumns`, so every column came out
	// narrower than the text it would receive and the cells clipped.
	const items: RichInlineItem[] = resolved.map((p) => {
		const spacing = letterSpacingForFont(p.font);
		return {
			text: p.text,
			font: p.font,
			break: p.breakMode,
			extraWidth: p.extraWidth,
			...(spacing ? { letterSpacing: spacing } : {}),
		};
	});
	const flow = prepareRichInline(items);
	// Natural width (max-content): a bound large enough that no wrap can occur.
	const natural = measureRichInlineStats(flow, TABLE_NATURAL_WIDTH_BOUND);
	// A cell formula must survive into the render layer, exactly like a paragraph's
	// (see PreparedTableCell.mathHtmls). Dropping it here paints the atom placeholder
	// — blank space of the right width. `mathHeight` is the tallest formula, which the
	// row-height solver needs so a stacked formula is not clipped.
	const hasMath = resolved.some((p) => p.math != null);
	let mathHeight = 0;
	if (hasMath) {
		for (const piece of resolved) {
			if (piece.math && piece.math.height > mathHeight) mathHeight = piece.math.height;
		}
	}
	return {
		flow,
		classNames: resolved.map((p) => p.className),
		hrefs: resolved.map((p) => p.href),
		fonts: resolved.map((p) => p.font),
		...(hasMath ? { mathHtmls: resolved.map((p) => p.math ?? null), mathHeight } : {}),
		naturalWidth: natural.maxLineWidth,
		minWidth: measureCellMinWidth(resolved),
	};
}

/**
 * Min-content width of a cell: the widest piece that cannot be broken.
 *
 * Measuring the flow at width 1 does NOT give this. pretext's `break: "normal"`
 * will split mid-word as a last resort when a single word cannot fit, so a 1px
 * probe reports the widest GRAPHEME (~one character) and every column would look
 * infinitely squeezable — collapsing the solver's third regime entirely.
 *
 * Instead the text is re-prepared through `prepareWithSegments`, whose `segments`
 * ARE pretext's own break units (whole words for Latin, per-character for CJK,
 * matching how a browser breaks), and the widest of those is measured as an
 * unbreakable atom.
 */
function measureCellMinWidth(pieces: readonly InlinePiece[]): number {
	let widest = 0;
	for (const piece of pieces) {
		// A math atom is unbreakable and already carries its full width.
		if (piece.math != null) {
			const width = piece.math.width;
			if (width > widest) widest = width;
			continue;
		}
		const pieceMin = pieceMinWidth(piece);
		if (pieceMin > widest) widest = pieceMin;
	}
	return widest;
}

/**
 * Min-content width of ONE piece, memoised on `(font, extraWidth, text)`.
 *
 * The uncached cost is per SEGMENT, not per piece: a 20×10 table with ten words per
 * cell runs 200 `prepareWithSegments` calls plus 2000 single-item
 * `prepareRichInline` + `measureRichInlineStats` pairs, all on the synchronous
 * prepare path. Tables repeat values heavily down a column (statuses, flags, short
 * identifiers, empty cells), so the memo turns most of that into map lookups.
 *
 * The key includes `extraWidth` because it is added to the measured atom, the font
 * because it decides every advance, and the letter spacing because it widens every
 * atom. Text is the rest of the key, so entries are exact — this memoises a pure
 * function, it does not approximate.
 *
 * NOTE: the entries hold NUMBERS, not prepared handles, so this cache is cheap to
 * retain. It is still keyed by font (never by "the current font generation") because
 * a face swap changes the advances: `resetPreparedFontRevisionForTest` and
 * `setPreparedFontRevision` clear it through `clearCellMinWidthCache`.
 */
const cellMinWidthCache = new Map<string, number>();

/**
 * Entry ceiling for the min-width memo. Bulk-clear on overflow, matching the other
 * caches in this layer: recomputing one entry is a single pretext pass, and a
 * sequential table scan is exactly the access pattern an LRU handles worst.
 */
const CELL_MIN_WIDTH_CACHE_CEILING = 16384;

function pieceMinWidth(piece: InlinePiece): number {
	// Spacing widens every atom, so it belongs in the key as well as in the measurement.
	// `clearCellMinWidthCache` on a typography change would cover it, but keying it makes
	// the memo exact on its own rather than dependent on that invalidation firing.
	const spacing = letterSpacingForFont(piece.font);
	const key = `${piece.font}\u0000${piece.extraWidth ?? 0}\u0000${spacing}\u0000${piece.text}`;
	const cached = cellMinWidthCache.get(key);
	if (cached !== undefined) return cached;
	let widest = 0;
	// `segments` ARE pretext's own break units (whole words for Latin, per-character
	// for CJK), which is why each is measured as an unbreakable atom.
	const { segments } = prepareWithSegments(
		piece.text,
		piece.font,
		spacing ? { letterSpacing: spacing } : undefined,
	);
	for (const segment of segments) {
		if (segment.trim().length === 0) continue;
		const atom = prepareRichInline([
			{
				text: segment,
				font: piece.font,
				break: "never",
				extraWidth: piece.extraWidth,
				...(spacing ? { letterSpacing: spacing } : {}),
			},
		]);
		const { maxLineWidth } = measureRichInlineStats(atom, TABLE_NATURAL_WIDTH_BOUND);
		if (maxLineWidth > widest) widest = maxLineWidth;
	}
	if (cellMinWidthCache.size >= CELL_MIN_WIDTH_CACHE_CEILING) cellMinWidthCache.clear();
	cellMinWidthCache.set(key, widest);
	return widest;
}

/**
 * Drop the min-width memo. Called when the font generation advances: the cached
 * advances were measured against the previous face.
 */
export function clearCellMinWidthCache(): void {
	cellMinWidthCache.clear();
	placeholderAdvanceCache.clear();
}

/**
 * Re-resolve a piece at bold weight for header cells. Inline code keeps its own
 * monospace font (the chunked path does not embolden `<code>` inside `<th>`), and
 * a math atom's width is already baked into `extraWidth`, so both pass through.
 */
function boldenPiece(piece: InlinePiece): InlinePiece {
	// Compared against the LIVE strings: the piece was built by `resolveFont` under
	// the same generation, so a stale constant here would fail every match and
	// silently leave header cells measured at regular weight (i.e. too narrow).
	const { font } = typographyMetrics();
	if (piece.math != null || piece.font === font.inlineCode) return piece;
	const bold = piece.font === font.bodyItalic ? font.bodyBoldItalic : font.bodyBold;
	if (piece.font === bold) return piece;
	return { ...piece, font: bold };
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
	if (variant === "body") return typographyMetrics().line.body;
	return headingMetrics(headingLevel(variant)).lineHeight;
}

/**
 * A heading's top margin (px): `0.4em` of its own BASELINE size, then scaled by the
 * block-spacing knob.
 *
 * The em base stays unscaled on purpose. Resolving it against the scaled heading
 * size would make the font-scale knob move block spacing too, so a reader who only
 * enlarged the text would also get looser gaps — the two knobs must stay
 * independent (see TypographySettings.paragraphScalePercent).
 */
function headingMarginTop(variant: InlineVariant): number {
	return scaleBlockSpacing(emToPx(HEADING_MARGIN_TOP, headingSize(variant)));
}

/**
 * The only schemes allowed to reach an `<a href>`.
 *
 * A WHITELIST, not a blacklist of `javascript:` and friends: a blacklist has to
 * anticipate every spelling of every dangerous scheme (and every encoding of it,
 * see `decodeCharacterReferences`), while this only has to name the four forms
 * that are actually wanted. Anything else a model writes stays plain text.
 */
const SAFE_HREF_SCHEME = /^(?:https?|mailto|tel)$/i;

/** Shape of a scheme per the URL parser: alpha, then alphanumeric / `+` `-` `.`. */
const HREF_SCHEME_SHAPE = /^[A-Za-z][A-Za-z0-9+.-]*$/;

/** Numeric character reference, with or without the terminating `;`. */
const NUMERIC_CHARACTER_REFERENCE = /&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?/g;

/** Named character reference candidate; only names in the table below decode. */
const NAMED_CHARACTER_REFERENCE = /&([A-Za-z]+);?/g;

/**
 * Named references that can build URL SYNTAX — a scheme's characters, the colon
 * that ends it, or the `/` `?` `#` that prove a colon is NOT a scheme's.
 *
 * Deliberately not the full HTML entity table (~2200 names): a name that decodes
 * to `é` or `→` cannot appear in a scheme, so decoding it would only add weight to
 * a check that runs per link. `amp` is here because it is what makes a DOUBLE
 * encoding (`&amp;#106;…`) collapse on the second pass.
 */
const NAMED_CHARACTER_REFERENCE_VALUES: Readonly<Record<string, string>> = {
	amp: "&",
	AMP: "&",
	colon: ":",
	semi: ";",
	num: "#",
	sol: "/",
	quest: "?",
	period: ".",
	plus: "+",
	Tab: "\t",
	NewLine: "\n",
};

/** One decoding pass: every reference in `value` replaced by its character. */
function decodeCharacterReferencesOnce(value: string): string {
	return value
		.replace(NUMERIC_CHARACTER_REFERENCE, (_match, hex: string | undefined, dec) => {
			const code = Number.parseInt(hex ?? dec, hex ? 16 : 10);
			// An out-of-range reference is a parse error the browser turns into U+FFFD;
			// keeping the source text would be the only alternative and is strictly
			// less safe (it re-hides whatever follows from the scheme check).
			if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "\ufffd";
			return String.fromCodePoint(code);
		})
		.replace(NAMED_CHARACTER_REFERENCE, (match, name: string) => {
			const decoded = Object.hasOwn(NAMED_CHARACTER_REFERENCE_VALUES, name)
				? NAMED_CHARACTER_REFERENCE_VALUES[name]
				: undefined;
			return decoded ?? match;
		});
}

/**
 * How many decoding passes to run before giving up.
 *
 * One pass is enough for the single-encoded forms; the extra passes exist so a
 * value that arrives double-encoded (`&amp;#106;avascript:`) is still judged on
 * what it would become after an HTML round trip. Three is well past anything a
 * real serializer chain produces, and the loop exits as soon as a pass changes
 * nothing.
 */
const MAX_CHARACTER_REFERENCE_PASSES = 3;

/**
 * Decode the HTML character references in a link target, purely so the scheme
 * check below sees what a BROWSER would see.
 *
 * marked hands over the link destination exactly as written, references intact —
 * unlike remark, which decodes them in the lexer, so react-markdown's sanitizer
 * always receives `javascript:alert(1)` and never the encoded spelling. Without
 * this step the same source reaches our check as `&#106;avascript:alert(1)`, no
 * scheme pattern matches, and the target is waved through: the classic
 * entity-encoded `javascript:` bypass. `&#x6a;`, the semicolon-less `&#106a…`
 * (which the HTML tokenizer still decodes, with a parse error) and `&colon;` /
 * `&Tab;` inside an otherwise plain scheme are the same hole.
 *
 * The result is used ONLY for the accept/reject decision — the href written to the
 * DOM stays the original text. Decoding the output instead would rewrite ordinary
 * links (`?a=1&amp;b=2`) for no reason, and rejecting anything containing `&`
 * would kill every URL with a multi-parameter query.
 */
function decodeCharacterReferences(value: string): string {
	let out = value;
	for (let pass = 0; pass < MAX_CHARACTER_REFERENCE_PASSES; pass++) {
		const next = decodeCharacterReferencesOnce(out);
		if (next === out) break;
		out = next;
	}
	return out;
}

/**
 * The scheme of a link target, or null when it has none (a relative path, a
 * query, a fragment, or a protocol-relative `//host` URL).
 *
 * Mirrors the URL parser rather than reaching for `new URL`, because the question
 * here is "does this string LOOK like it names a scheme", which has to be answered
 * for strings `URL` refuses outright.
 */
function hrefScheme(value: string): string | null {
	// A browser strips ASCII tab / newline from ANYWHERE in a URL, and leading C0
	// controls and spaces from the front, which is how `java\tscript:` and
	// `\u0001javascript:` still execute. Interior spaces are NOT stripped
	// (`my note:1.md` stays a relative path), so the two rules are separate.
	//
	// The leading trim is a loop rather than a character-class regex because the
	// class would be a literal control-character range (biome forbids those, with
	// good reason: they are unreadable and easy to get wrong by one code point).
	let start = 0;
	const stripped = value.replace(/[\t\n\r]/g, "");
	while (start < stripped.length) {
		const code = stripped.charCodeAt(start);
		if (code > 0x20) break;
		start++;
	}
	const cleaned = stripped.slice(start);
	const colon = cleaned.indexOf(":");
	if (colon <= 0) return null;
	// A colon that follows a `/`, `?` or `#` belongs to a path, query or fragment,
	// not to a scheme — same test react-markdown's `defaultUrlTransform` makes, and
	// what keeps `docs/a:b` and `?next=http://x` out of this branch.
	for (const delimiter of "/?#") {
		const at = cleaned.indexOf(delimiter);
		if (at !== -1 && at < colon) return null;
	}
	const scheme = cleaned.slice(0, colon);
	// Not a legal scheme → no browser reads it as one, so it resolves relatively.
	return HREF_SCHEME_SHAPE.test(scheme) ? scheme : null;
}

/**
 * Normalize a link target, or return null when it must not be rendered as a link.
 *
 * Absolute http(s) URLs are canonicalized through `URL` (that is what the chunked
 * path's tests pin: `https://example.com` → `https://example.com/`).
 *
 * Everything the `URL` constructor cannot parse standalone used to be rejected
 * outright, which silently killed every NON-absolute link the model writes —
 * in-app routes (`/knowledge/e1`), same-document anchors (`#section`), relative
 * paths and `mailto:` — the render layer saw `href: null` and painted plain text.
 * A target with no scheme is therefore preserved verbatim, and a target WITH one
 * must name a scheme in `SAFE_HREF_SCHEME`. Geometry is untouched either way: the
 * href only decides whether the same measured fragment is wrapped in an `<a>` or a
 * `<span>`.
 *
 * WHERE THIS DIVERGES FROM THE CHUNKED PATH
 * react-markdown's `defaultUrlTransform` whitelists `^(https?|ircs?|mailto|xmpp)$`
 * under the same "first colon before any `/`, `?`, `#`" rule. Three deliberate
 * differences:
 *   - `tel:` is allowed here and not there. Models write phone numbers into
 *     knowledge-base prose, and a `tel:` target hands the string to the platform's
 *     dialer — it cannot name a page, let alone run script.
 *   - `ircs:` and `xmpp:` are refused here. Neither has ever appeared in this
 *     product's content, and a scheme nobody uses is a handler this app should not
 *     be able to launch. They are one entry away if that changes.
 *   - Protocol-relative `//host/path` is allowed by BOTH, for the same reason: it
 *     carries no colon, so it is not a scheme and inherits the page's own. Worth
 *     naming because it reads like an absolute URL and is not treated as one.
 * The scheme is read from the DECODED target (see `decodeCharacterReferences`),
 * which is the step that makes this comparable to react-markdown at all: remark
 * decodes character references before its sanitizer runs, marked does not.
 */
function parseHref(href: string | null | undefined): string | null {
	if (href == null) return null;
	const trimmed = href.trim();
	if (trimmed.length === 0) return null;
	// Decoding only matters when there is a reference to decode; skipping the
	// regex passes keeps the common link on one string scan.
	const probe = trimmed.includes("&") ? decodeCharacterReferences(trimmed) : trimmed;
	// These are file hints, never browser-navigable schemes. Validate the full
	// shape and carry the location/device in an inert marker before filtering.
	if (/^(?:file:|nf-file:|[a-z]:[\\/])/i.test(probe)) {
		const target = parseLocalFilePath(probe);
		return target ? localFileHref(target) : null;
	}
	const scheme = hrefScheme(probe);
	// No scheme: a relative path, a query or a fragment. Keep it as written so the
	// app's own router (or the browser) resolves it.
	if (scheme === null) return trimmed;
	if (!SAFE_HREF_SCHEME.test(scheme)) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol === "http:" || url.protocol === "https:") return url.href;
		// `mailto:` / `tel:` keep their exact source text: `URL` normalizes neither
		// usefully, and both are opaque to the router.
		return trimmed;
	} catch {
		// A whitelisted scheme that `URL` still refuses (e.g. `https://` with no
		// host) is left as written rather than dropped — the browser will do the
		// same thing with it that it does on the chunked path.
		return trimmed;
	}
}

function fallbackText(token: Token): string {
	if ("text" in token && typeof (token as { text?: unknown }).text === "string") {
		return (token as { text: string }).text;
	}
	return (token as { raw?: string }).raw ?? "";
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
