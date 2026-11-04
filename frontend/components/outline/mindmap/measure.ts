/**
 * Mind-map node sizes without the DOM (design §6.10): `@chenglou/pretext` measures a body as the
 * node will draw it, nodes have a maximum width and wrap.
 *
 *   - Paragraphs, quotes and headings: inline content split into rich-text runs (bold, italic,
 *     inline code and mentions each with their own font and padding); hard breaks start a new
 *     run of lines.
 *   - Code blocks and tables are cut short in a node (code: at most 6 lines, not wrapped; tables:
 *     a fixed width, at most 6 rows, cells on one line); an embed is a fixed-height card.
 *
 * Results are cached by the body's source (plus the text of its mentions), so only bodies that
 * changed are measured again. Measuring cold costs 0.2–0.3 ms a block (the prototype: 2000 blocks
 * took 0.4–0.6 s), so a page is measured AHEAD in a Worker (`measure.worker.ts`, OffscreenCanvas,
 * the same code and fonts) as soon as it opens: the first switch to the map then finds the sizes
 * cached (prototype: first draw 42–60 ms instead of 465–623 ms). Without a Worker (or before it
 * is done) a body is measured where it is needed, on the main thread.
 *
 * The fonts must be the ones `mindmap.css` gives `.mm-node`: named families (pretext measures
 * `system-ui` inaccurately on macOS), the app's own sans and mono stacks.
 *
 * Typography is the conversation's (外观 · 排版): body, heading, inline-code and code-block
 * sizes and line boxes come from `typographyMetrics()` / `headingMetrics()` at MEASURE time —
 * the same numbers `mindmap.css` paints with through the `--nf-type-*` variables
 * (`shared/pretext-layout/typography-css.ts`). A change of setting changes the cache key
 * (`typographySignature`), the Worker request (it carries the setting) and the line box, so
 * nothing measured under one setting is drawn under another.
 */
import { measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";
import {
	measureRichInlineStats,
	prepareRichInline,
	type RichInlineItem,
} from "@chenglou/pretext/rich-inline";
import {
	headingMetrics,
	MONO_FAMILY,
	SANS_FAMILY,
	typographyMetrics,
} from "@shared/pretext-layout/pretext-fonts";
import {
	getTypography,
	getTypographyRevision,
	letterSpacingForFont,
	onTypographyChange,
	type TypographySettings,
} from "@shared/pretext-layout/typography";
import type { Node as PMNode } from "prosemirror-model";
import { parseToPM } from "../editor/convert";

export const MAP_FONT_FAMILY = SANS_FAMILY;
export const MAP_MONO_FAMILY = MONO_FAMILY;

/** Node geometry that is not text (must match `mindmap.css`). Text sizes: {@link mapType}. */
export const NODE = {
	padX: 8,
	padY: 4,
	gutter: 28,
	check: 18,
	/** Widest a body grows before it wraps. */
	maxBody: 264,
	minBody: 6,
	codeLines: 6,
	tableRows: 6,
	embedH: 48,
	border: 1,
	/** The "…N more" node. */
	moreW: 96,
} as const;

export interface BodySize {
	w: number;
	h: number;
}

/** The text geometry nodes are measured with, at the reader's current typography. */
export interface MapType {
	/** Body size (px) and line box (px): the conversation's body text. */
	px: number;
	lineH: number;
	/** Inline code: the conversation's inline code font (xs, monospace). */
	codeFont: string;
	/** Code blocks: the conversation's fenced-code font and line box. */
	codeBlockFont: string;
	codeBlockLineH: number;
	/** Headings h1–h3: the conversation's markdown heading sizes and line boxes. */
	heading: Record<1 | 2 | 3, { px: number; lineH: number }>;
}

let typeCache: MapType | null = null;
let typeRevision = -1;

/** Text geometry for nodes, memoised per typography generation. */
export function mapType(): MapType {
	const revision = getTypographyRevision();
	if (typeCache && typeRevision === revision) return typeCache;
	const m = typographyMetrics();
	const h = (level: 1 | 2 | 3) => {
		const hm = headingMetrics(level);
		return { px: hm.size, lineH: hm.lineHeight };
	};
	typeCache = {
		px: m.size.sm,
		lineH: m.line.body,
		codeFont: `${m.size.xs}px ${MAP_MONO_FAMILY}`,
		codeBlockFont: `${m.codeSize}px ${MAP_MONO_FAMILY}`,
		codeBlockLineH: m.line.code,
		heading: { 1: h(1), 2: h(2), 3: h(3) },
	};
	typeRevision = revision;
	return typeCache;
}

/**
 * The settings a size depends on, as a cache-key prefix. Not the revision: the Worker has its
 * own typography module (and revision counter), and its answers are keyed by the main thread.
 * Block spacing is left out: it does not change a node.
 */
export function typographySignature(t: TypographySettings = getTypography()): string {
	return `${t.fontScalePercent}.${t.lineHeightScalePercent}.${t.letterSpacingPercent}`;
}

/** The part of every cache key that names the setting it was measured under. */
function keyPrefix(): string {
	return `${typographySignature()}\u0002`;
}

/**
 * A run for pretext, with the reader's letter spacing.
 *
 * pretext counts the spacing after EVERY grapheme of a run, the last one included
 * (`lineEndFitAdvance` in pretext's layout), which is what CSS `letter-spacing` does too — so
 * node text, which the browser lays out, measures as it is drawn with no correction here.
 */
function run(
	text: string,
	font: string,
	extra = 0,
	item: Partial<RichInlineItem> = {},
): RichInlineItem {
	const spacing = letterSpacingForFont(font);
	return spacing
		? { ...item, text, font, letterSpacing: spacing, extraWidth: extra }
		: { ...item, text, font, extraWidth: extra };
}

/** Width of a short run (punctuation) in a font, with that font's letter spacing. */
function runWidth(text: string, font: string): number {
	const spacing = letterSpacingForFont(font);
	return measureNaturalWidth(
		prepareWithSegments(text, font, spacing ? { letterSpacing: spacing } : undefined),
	);
}

/** Punctuation a line may not start with (closing classes, UAX #14): it stays with what precedes. */
const LEADING_CLOSE = /^[，。、；：！？）」』】〉》〕〗〙〛”’…,.;:!?)\]}%]+/u;
/** Punctuation a line may not end with (opening classes): it stays with what follows. */
const TRAILING_OPEN = /[（「『【〈《〔〖〘〚“‘([{]+$/u;

/**
 * CJK closing punctuation right after a non-CJK character (`aborted；`, `continue」`, `abc）`).
 * pretext keeps such punctuation on its line only after CJK text; after a Latin word it breaks
 * before it, over a wide range of widths, where the browser never does — the node is then
 * measured a line short. A WORD JOINER (zero width, no break) between them makes pretext agree.
 */
const LATIN_BEFORE_CJK_CLOSE =
	/([^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef])(?=[，。、；：！？）」』】〉》〕〗〙〛])/gu;
const WORD_JOINER = "\u2060";

/** A chip (inline code, a mention) that cannot break inside: one word, or never broken. */
function unbreakable(item: RichInlineItem): boolean {
	return item.break === "never" || !/\s/.test(item.text.trim());
}

/**
 * Keep punctuation on the line the browser keeps it on.
 *
 * CSS never starts a line with `，` `。` `)` … nor ends one with `（` `「` …, so `` `aborted`， ``
 * moves to the next line as one piece. Inside one text run pretext keeps the same rule, but
 * rich-inline may break at ANY boundary between runs — which is exactly where a chip meets its
 * punctuation. So the punctuation is moved across the boundary here:
 *   - next to a text run, it joins that run's text (the same size; only weight or style may
 *     differ, which barely changes the advance of punctuation);
 *   - next to a chip (another font and size), its width is added to the chip's reserved width —
 *     only when the chip cannot break inside, since the reserve is paid on every line a run spans.
 */
function keepPunctuationAttached(
	items: RichInlineItem[],
	chips: ReadonlySet<RichInlineItem>,
): void {
	for (let i = 1; i < items.length; i++) {
		const prev = items[i - 1] as RichInlineItem;
		const next = items[i] as RichInlineItem;
		if (!prev.text || !next.text || /\s$/.test(prev.text) || /^\s/.test(next.text)) continue;
		const close = chips.has(next) ? null : LEADING_CLOSE.exec(next.text)?.[0];
		if (close) {
			if (!chips.has(prev)) prev.text += close;
			else if (unbreakable(prev))
				prev.extraWidth = (prev.extraWidth ?? 0) + runWidth(close, next.font);
			else continue;
			next.text = next.text.slice(close.length);
			continue;
		}
		const open = chips.has(prev) ? null : TRAILING_OPEN.exec(prev.text)?.[0];
		if (open) {
			if (!chips.has(next)) next.text = open + next.text;
			else if (unbreakable(next))
				next.extraWidth = (next.extraWidth ?? 0) + runWidth(open, prev.font);
			else continue;
			prev.text = prev.text.slice(0, -open.length);
		}
	}
}

function fontOf(marks: readonly { type: { name: string } }[], px: number, bold: boolean): string {
	let weight = bold ? "700 " : "";
	let style = "";
	for (const m of marks) {
		if (m.type.name === "strong") weight = "700 ";
		else if (m.type.name === "em") style = "italic ";
		else if (m.type.name === "code") return mapType().codeFont;
	}
	return `${style}${weight}${px}px ${MAP_FONT_FAMILY}`;
}

/** What a mention shows (resolved by the caller: a block's title, the label, the address). */
export type LabelOf = (ref: string, label: string | null) => string;
const plainLabel: LabelOf = (ref, label) => label ?? ref;

/** Inline content → lines groups (a hard break starts a group), each a list of rich runs. */
function inlineGroups(
	body: PMNode,
	px: number,
	bold: boolean,
	labelOf: LabelOf,
): RichInlineItem[][] {
	const groups: RichInlineItem[][] = [[]];
	const chips = new Set<RichInlineItem>();
	body.forEach((n) => {
		const g = groups[groups.length - 1] as RichInlineItem[];
		if (n.type.name === "hard_break") groups.push([]);
		else if (n.type.name === "mention") {
			const label = labelOf(n.attrs.ref as string, n.attrs.label as string | null);
			const chip = run(label, `${px}px ${MAP_FONT_FAMILY}`, 6, { break: "never" });
			chips.add(chip);
			g.push(chip);
		} else if (n.isText) {
			const isCode = n.marks.some((m) => m.type.name === "code");
			const item = run(n.text ?? "", fontOf(n.marks, px, bold), isCode ? 6 : 0);
			if (isCode) chips.add(item);
			g.push(item);
		}
	});
	for (const g of groups) {
		keepPunctuationAttached(g, chips);
		for (const item of g) item.text = item.text.replace(LATIN_BEFORE_CJK_CLOSE, `$1${WORD_JOINER}`);
	}
	return groups;
}

function measureInline(
	body: PMNode,
	px: number,
	lh: number,
	bold: boolean,
	maxW: number,
	labelOf: LabelOf,
): BodySize {
	let lines = 0;
	let width = 0;
	for (const g of inlineGroups(body, px, bold, labelOf)) {
		const items = g.filter((x) => x.text.length > 0);
		if (!items.length) {
			lines += 1;
			continue;
		}
		const st = measureRichInlineStats(prepareRichInline(items), maxW);
		lines += Math.max(1, st.lineCount);
		if (st.maxLineWidth > width) width = st.maxLineWidth;
	}
	return { w: width, h: Math.max(1, lines) * lh };
}

/** A body's size (without the frame and padding). Mentions resolve through `labelOf`. */
export function measureBody(body: PMNode, maxW = NODE.maxBody, labelOf = plainLabel): BodySize {
	const t = mapType();
	switch (body.type.name) {
		case "heading": {
			const h = t.heading[body.attrs.level as 1 | 2 | 3];
			if (!h) return measureInline(body, t.px, t.lineH, true, maxW, labelOf);
			return measureInline(body, h.px, h.lineH, true, maxW, labelOf);
		}
		case "quote": {
			// A quote: 3 px left border + 8 px left padding.
			const r = measureInline(body, t.px, t.lineH, false, maxW - 11, labelOf);
			return { w: r.w + 11, h: r.h };
		}
		case "code_block": {
			const lines = body.textContent.split("\n");
			let w = 0;
			for (const l of lines.slice(0, NODE.codeLines)) {
				if (!l) continue;
				const nw = runWidth(l, t.codeBlockFont);
				if (nw > w) w = nw;
			}
			const shown = Math.min(lines.length, NODE.codeLines);
			return { w: Math.min(maxW, w + 16), h: shown * t.codeBlockLineH + 8 };
		}
		case "table": {
			const rows = Math.min(body.childCount, NODE.tableRows);
			// Fixed table layout: each row = line + 4 padding + 1 border, plus the outer border.
			return { w: maxW, h: rows * (t.lineH + 4 + 1) + 1 };
		}
		case "embed":
			return { w: maxW, h: NODE.embedH };
		default:
			return measureInline(body, t.px, t.lineH, false, maxW, labelOf);
	}
}

const MAX_CACHE = 30_000;
const cache = new Map<string, BodySize>();
export const measureStats = { hits: 0, misses: 0, ms: 0 };

/**
 * Cache key: the typography it was measured under, then the source; with mentions, also what
 * they show (a target's title can change).
 */
export function measureKey(
	content: string,
	labelOf: LabelOf,
): { key: string; labels: string[]; node: PMNode } {
	const sig = keyPrefix();
	// Without mentions the key is the text itself: parsed only when it is measured (a cache hit,
	// or a body sent to the Worker, parses nothing here).
	if (!content.includes("[[")) {
		let parsed: PMNode | null = null;
		return {
			key: sig + content,
			labels: [],
			get node() {
				parsed ??= parseToPM(content).node;
				return parsed;
			},
		};
	}
	const node = parseToPM(content).node;
	const labels: string[] = [];
	if (content.includes("[[")) {
		node.descendants((n) => {
			if (n.type.name === "mention") labels.push(labelOf(n.attrs.ref, n.attrs.label));
			return true;
		});
	}
	return {
		key: sig + (labels.length ? `${content}\u0000${labels.join("\u0001")}` : content),
		labels,
		node,
	};
}

/** A body's size from the cache, measured on the spot when it is not there. */
export function bodySize(content: string, labelOf: LabelOf = plainLabel): BodySize {
	const { key, node } = measureKey(content, labelOf);
	const hit = cache.get(key);
	if (hit) {
		measureStats.hits++;
		return hit;
	}
	const t0 = performance.now();
	measureStats.misses++;
	const r = measureBody(node, NODE.maxBody, labelOf);
	if (cache.size > MAX_CACHE) cache.clear();
	cache.set(key, r);
	measureStats.ms += performance.now() - t0;
	return r;
}

/** A body's size if it is cached; never measures. */
export function cachedBodySize(content: string, labelOf: LabelOf = plainLabel): BodySize | null {
	return cache.get(measureKey(content, labelOf).key) ?? null;
}

/** Whether a size is cached under this key (`measureKey`). */
export function hasMeasuredKey(key: string): boolean {
	return cache.has(key);
}

/** Whether a body's size is cached (tests and the first-switch path). */
export function hasMeasured(content: string, labelOf: LabelOf = plainLabel): boolean {
	return cache.has(measureKey(content, labelOf).key);
}

/** Store sizes measured elsewhere (the Worker). */
export function storeMeasured(entries: Iterable<[string, number, number]>): number {
	// A Worker reply measured under a setting the reader has since left would never be hit
	// (its key carries the old signature): it is not kept.
	const current = keyPrefix();
	let n = 0;
	for (const [key, w, h] of entries) {
		if (!key.startsWith(current) || cache.has(key)) continue;
		if (cache.size > MAX_CACHE) cache.clear();
		cache.set(key, { w, h });
		n++;
	}
	return n;
}

export function clearMeasureCache(): void {
	cache.clear();
}

// Sizes measured under another setting are never served (their keys carry the old
// signature); dropping them keeps the cache from holding two generations at once. The text
// geometry is dropped too: it is memoised per generation, and a test may rewind generations.
onTypographyChange(() => {
	cache.clear();
	typeCache = null;
});

/** A node's outer size: padding + frame (arrow, bullet, checkbox) + body. */
export function nodeSize(body: BodySize, task: boolean): { w: number; h: number; bodyW: number } {
	const bodyW = Math.ceil(Math.max(NODE.minBody, body.w)) + 1;
	const gutter = NODE.gutter + (task ? NODE.check : 0);
	return {
		w: NODE.padX * 2 + gutter + bodyW + NODE.border * 2,
		h: NODE.padY * 2 + Math.max(mapType().lineH, body.h) + NODE.border * 2,
		bodyW,
	};
}
