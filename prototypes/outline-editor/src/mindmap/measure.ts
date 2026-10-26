/**
 * 导图节点尺寸：用 @chenglou/pretext 免 DOM 测量（§6.10），节点宽度有上限、文字换行。
 * - 段落 / 引用 / 标题：行内内容按标记拆成富文本片段（粗体、斜体、行内代码、提及各用自己的字体和外边距），
 *   硬换行分成几段各自排；
 * - 代码块、表格在节点里按上限缩略（代码最多 6 行、不换行；表格固定宽度、最多 6 行、单元格不换行）；
 * - 嵌入画成固定高度的卡片。
 * 结果按正文源文本缓存：布局时只有变了的块要重测（「只重算变了的部分」落在这里）。
 * 字体必须和 style.css 里 .mm-node / .ob-content 的字体一致；用具名字体（pretext 说 system-ui 在 macOS 上不准）。
 */
import { measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";
import {
	measureRichInlineStats,
	prepareRichInline,
	type RichInlineItem,
} from "@chenglou/pretext/rich-inline";
import type { Node as PMNode } from "prosemirror-model";
import { parseToPM } from "../client/convert";

export const FAMILY = `Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "WenQuanYi Zen Hei", sans-serif`;
export const MONO = `"JetBrains Mono", "DejaVu Sans Mono", Menlo, monospace`;
const PX = 15;
const LH = PX * 1.5;
const CODE_PX = 13;
const CODE_LH = CODE_PX * 1.5;

/** 节点几何（和 style.css 的 .mm-node 一致） */
export const NODE = {
	padX: 8,
	padY: 4,
	gutter: 28,
	check: 18,
	/** 块体最大宽度：超过就换行 */
	maxBody: 264,
	minBody: 6,
	lineH: LH,
	codeLines: 6,
	tableRows: 6,
	embedH: 48,
	border: 1,
};

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
		else if (m.type.name === "code") return `${CODE_PX}px ${MONO}`;
	}
	return `${style}${weight}${px}px ${FAMILY}`;
}

export type LabelOf = (ref: string, label: string | null) => string;
const plainLabel: LabelOf = (ref, label) => label ?? ref;

/** 行内内容 → 若干段（硬换行分段），每段一组富文本片段。 */
function inlineGroups(
	body: PMNode,
	px: number,
	bold: boolean,
	labelOf: LabelOf,
): RichInlineItem[][] {
	const groups: RichInlineItem[][] = [[]];
	body.forEach((n) => {
		const g = groups[groups.length - 1];
		if (n.type.name === "hard_break") groups.push([]);
		else if (n.type.name === "mention") {
			g.push({
				text: labelOf(n.attrs.ref as string, n.attrs.label as string | null),
				font: `${px}px ${FAMILY}`,
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
) {
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

/** 一个块体的尺寸（不含外框和内边距）。mention 的显示文字在调用方解析（labelOf）。 */
export function measureBody(body: PMNode, maxW = NODE.maxBody, labelOf = plainLabel): BodySize {
	switch (body.type.name) {
		case "heading": {
			const px = HEADING_PX[body.attrs.level as number] ?? PX;
			const r = measureInline(body, px, px * 1.5, true, maxW, labelOf);
			return { w: r.w, h: r.h };
		}
		case "quote": {
			// 引用：左边框 3px + 左内边距 8px
			const r = measureInline(body, PX, LH, false, maxW - 11, labelOf);
			return { w: r.w + 11, h: r.h };
		}
		case "code_block": {
			const text = body.textContent;
			const lines = text.split("\n");
			let w = 0;
			for (const l of lines.slice(0, NODE.codeLines)) {
				if (!l) continue;
				const nw = measureNaturalWidth(prepareWithSegments(l, `${CODE_PX}px ${MONO}`));
				if (nw > w) w = nw;
			}
			const shown = Math.min(lines.length, NODE.codeLines);
			return { w: Math.min(maxW, w + 16), h: shown * CODE_LH + 8 };
		}
		case "table": {
			const rows = Math.min(body.childCount, NODE.tableRows);
			// 固定表格布局：每行 = 行高 + 上下内边距 4 + 边框 1，再加最外一条边框
			return { w: maxW, h: rows * (LH + 4 + 1) + 1 };
		}
		case "embed":
			return { w: maxW, h: NODE.embedH };
		default: {
			const r = measureInline(body, PX, LH, false, maxW, labelOf);
			return { w: r.w, h: r.h };
		}
	}
}

const cache = new Map<string, BodySize>();
export const measureStats = { hits: 0, misses: 0, ms: 0 };

/** 缓存键：源文本；有提及时加上各提及的显示文字（目标改了文字，提及变宽）。 */
function keyOf(content: string, labelOf: LabelOf): { key: string; labels: string[]; node: PMNode } {
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

/** 按正文源文本缓存的块体尺寸；没测过的当场测（同步）。 */
export function bodySize(content: string, labelOf: LabelOf = plainLabel): BodySize {
	const { key, node } = keyOf(content, labelOf);
	const hit = cache.get(key);
	if (hit) {
		measureStats.hits++;
		return hit;
	}
	const t0 = performance.now();
	measureStats.misses++;
	const r = measureBody(node, NODE.maxBody, labelOf);
	if (cache.size > 30000) cache.clear();
	cache.set(key, r);
	measureStats.ms += performance.now() - t0;
	return r;
}

// ---------- 预先测量：放进 Worker（pretext 在 Worker 里用 OffscreenCanvas），不占主线程 ----------

let worker: Worker | null = null;
let workerFailed = false;
let reqId = 0;
const inflight = new Set<string>();
const waiting = new Map<number, () => void>();
export const prewarmStats = { posted: 0, done: 0, workerMs: 0, wallMs: 0, batches: 0 };

function getWorker(): Worker | null {
	if (worker || workerFailed) return worker;
	try {
		worker = new Worker("measure-worker.js", { type: "module" });
		worker.onmessage = (
			e: MessageEvent<{ id: number; out: Array<[string, number, number]>; ms: number }>,
		) => {
			for (const [key, w, h] of e.data.out) {
				inflight.delete(key);
				if (!cache.has(key)) cache.set(key, { w, h });
			}
			prewarmStats.done += e.data.out.length;
			prewarmStats.workerMs += e.data.ms;
			waiting.get(e.data.id)?.();
			waiting.delete(e.data.id);
		};
		worker.onerror = () => {
			workerFailed = true;
		};
	} catch {
		workerFailed = true;
	}
	return worker;
}

/**
 * 在 Worker 里预先测量一批块体（打开页面后就做，第一次切到导图时就不用当场测 2000 块）。
 * 结果和主线程测的一样（同一份代码、同一套系统字体）；Worker 不可用时什么也不做，用到时同步测。
 */
export function prewarm(items: Array<{ content: string; labelOf: LabelOf }>): Promise<void> {
	const w = getWorker();
	if (!w) return Promise.resolve();
	const t0 = performance.now();
	const batch: Array<{ key: string; content: string; labels: string[] }> = [];
	for (const it of items) {
		const { key, labels } = keyOf(it.content, it.labelOf);
		if (cache.has(key) || inflight.has(key)) continue;
		inflight.add(key);
		batch.push({ key, content: it.content, labels });
	}
	const jobs: Promise<void>[] = [];
	for (let i = 0; i < batch.length; i += 250) {
		const id = ++reqId;
		const chunk = batch.slice(i, i + 250);
		jobs.push(new Promise<void>((r) => waiting.set(id, r)));
		w.postMessage({ id, items: chunk });
		prewarmStats.posted += chunk.length;
		prewarmStats.batches++;
	}
	return Promise.all(jobs).then(() => {
		prewarmStats.wallMs += performance.now() - t0;
	});
}

export function clearMeasureCache() {
	cache.clear();
}

/** 节点外框尺寸：内边距 + 外框（箭头、项目符号、复选框）+ 块体。 */
export function nodeSize(body: BodySize, task: boolean): { w: number; h: number; bodyW: number } {
	const bodyW = Math.ceil(Math.max(NODE.minBody, body.w)) + 1;
	const gutter = NODE.gutter + (task ? NODE.check : 0);
	return {
		w: NODE.padX * 2 + gutter + bodyW + NODE.border * 2,
		h: NODE.padY * 2 + Math.max(NODE.lineH, body.h) + NODE.border * 2,
		bodyW,
	};
}
