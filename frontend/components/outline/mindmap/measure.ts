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
 */
import { measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";
import {
	measureRichInlineStats,
	prepareRichInline,
	type RichInlineItem,
} from "@chenglou/pretext/rich-inline";
import { MONO_FAMILY, SANS_FAMILY } from "@shared/pretext-layout/pretext-fonts";
import type { Node as PMNode } from "prosemirror-model";
import { parseToPM } from "../editor/convert";

export const MAP_FONT_FAMILY = SANS_FAMILY;
export const MAP_MONO_FAMILY = MONO_FAMILY;
const PX = 15;
const LH = PX * 1.5;
export const MAP_CODE_PX = 13;
const CODE_LH = MAP_CODE_PX * 1.5;

/** Node geometry (must match `mindmap.css`). */
export const NODE = {
	padX: 8,
	padY: 4,
	gutter: 28,
	check: 18,
	/** Widest a body grows before it wraps. */
	maxBody: 264,
	minBody: 6,
	lineH: LH,
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

const HEADING_PX: Record<number, number> = { 1: PX * 1.5, 2: PX * 1.25, 3: PX * 1.1 };

function fontOf(marks: readonly { type: { name: string } }[], px: number, bold: boolean): string {
	let weight = bold ? "700 " : "";
	let style = "";
	for (const m of marks) {
		if (m.type.name === "strong") weight = "700 ";
		else if (m.type.name === "em") style = "italic ";
		else if (m.type.name === "code") return `${MAP_CODE_PX}px ${MAP_MONO_FAMILY}`;
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
	body.forEach((n) => {
		const g = groups[groups.length - 1] as RichInlineItem[];
		if (n.type.name === "hard_break") groups.push([]);
		else if (n.type.name === "mention") {
			g.push({
				text: labelOf(n.attrs.ref as string, n.attrs.label as string | null),
				font: `${px}px ${MAP_FONT_FAMILY}`,
				break: "never",
				extraWidth: 6,
			});
		} else if (n.isText) {
			const isCode = n.marks.some((m) => m.type.name === "code");
			g.push({ text: n.text ?? "", font: fontOf(n.marks, px, bold), extraWidth: isCode ? 6 : 0 });
		}
	});
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
	switch (body.type.name) {
		case "heading": {
			const px = HEADING_PX[body.attrs.level as number] ?? PX;
			return measureInline(body, px, px * 1.5, true, maxW, labelOf);
		}
		case "quote": {
			// A quote: 3 px left border + 8 px left padding.
			const r = measureInline(body, PX, LH, false, maxW - 11, labelOf);
			return { w: r.w + 11, h: r.h };
		}
		case "code_block": {
			const lines = body.textContent.split("\n");
			let w = 0;
			for (const l of lines.slice(0, NODE.codeLines)) {
				if (!l) continue;
				const nw = measureNaturalWidth(
					prepareWithSegments(l, `${MAP_CODE_PX}px ${MAP_MONO_FAMILY}`),
				);
				if (nw > w) w = nw;
			}
			const shown = Math.min(lines.length, NODE.codeLines);
			return { w: Math.min(maxW, w + 16), h: shown * CODE_LH + 8 };
		}
		case "table": {
			const rows = Math.min(body.childCount, NODE.tableRows);
			// Fixed table layout: each row = line + 4 padding + 1 border, plus the outer border.
			return { w: maxW, h: rows * (LH + 4 + 1) + 1 };
		}
		case "embed":
			return { w: maxW, h: NODE.embedH };
		default:
			return measureInline(body, PX, LH, false, maxW, labelOf);
	}
}

const MAX_CACHE = 30_000;
const cache = new Map<string, BodySize>();
export const measureStats = { hits: 0, misses: 0, ms: 0 };

/** Cache key: the source; with mentions, also what they show (a target's title can change). */
export function measureKey(
	content: string,
	labelOf: LabelOf,
): { key: string; labels: string[]; node: PMNode } {
	// Without mentions the key is the text itself: parsed only when it is measured (a cache hit,
	// or a body sent to the Worker, parses nothing here).
	if (!content.includes("[[")) {
		let parsed: PMNode | null = null;
		return {
			key: content,
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
		key: labels.length ? `${content}\u0000${labels.join("\u0001")}` : content,
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
	let n = 0;
	for (const [key, w, h] of entries) {
		if (cache.has(key)) continue;
		if (cache.size > MAX_CACHE) cache.clear();
		cache.set(key, { w, h });
		n++;
	}
	return n;
}

export function clearMeasureCache(): void {
	cache.clear();
}

/** A node's outer size: padding + frame (arrow, bullet, checkbox) + body. */
export function nodeSize(body: BodySize, task: boolean): { w: number; h: number; bodyW: number } {
	const bodyW = Math.ceil(Math.max(NODE.minBody, body.w)) + 1;
	const gutter = NODE.gutter + (task ? NODE.check : 0);
	return {
		w: NODE.padX * 2 + gutter + bodyW + NODE.border * 2,
		h: NODE.padY * 2 + Math.max(NODE.lineH, body.h) + NODE.border * 2,
		bodyW,
	};
}
