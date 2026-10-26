/**
 * 方言解析：markdown 源文本 → 块体 AST + 源码映射。
 *
 * - parseBlock：一个块的正文。第一个块级 token 是块体，其余（列表、多段……）放进 extra，作为子块（D23）。
 * - parseOutline：多行 markdown 大纲（粘贴、agent 写入），列表项变成块树。
 *
 * 映射：pmToSrc[k] 是内容偏移 k（与 ProseMirror 节点内容偏移一致）对应的源码偏移。
 */
import type { Token, Tokens } from "marked";
import { decodeEntityAt } from "./entities";
import { lexBlocks } from "./lexer";
import type {
	Align,
	Body,
	Inline,
	Mark,
	OutlineNode,
	ParsedBlock,
	SourceMap,
	TaskState,
} from "./types";

type Tr = (i: number) => number;

class InlineBuilder {
	nodes: Inline[] = [];
	points: number[] = [];

	text(text: string, marks: Mark[], starts: number[]) {
		if (!text) return;
		const last = this.nodes[this.nodes.length - 1];
		if (last && last.type === "text" && sameMarks(last.marks, marks)) last.text += text;
		else this.nodes.push({ type: "text", text, marks: marks.slice() });
		for (const s of starts) this.points.push(s);
	}

	atom(node: Inline, start: number) {
		this.nodes.push(node);
		this.points.push(start);
	}
}

export function sameMarks(a: Mark[], b: Mark[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x.type !== y.type || (x.href ?? null) !== (y.href ?? null)) return false;
		if ((x.title ?? null) !== (y.title ?? null)) return false;
	}
	return true;
}

const MARK_ORDER: Record<string, number> = { link: 0, strong: 1, em: 2, strike: 3, code: 4 };

function addMark(marks: Mark[], m: Mark): Mark[] {
	if (marks.some((x) => x.type === m.type)) return marks;
	const out = [...marks, m];
	out.sort((a, b) => MARK_ORDER[a.type] - MARK_ORDER[b.type]);
	return out;
}

/** 把一段原样文字（可能含实体）按字符映射到源码。 */
function emitRaw(b: InlineBuilder, raw: string, marks: Mark[], pos: number, tr: Tr, decode = true) {
	let out = "";
	const starts: number[] = [];
	let i = 0;
	while (i < raw.length) {
		const ent = decode ? decodeEntityAt(raw, i) : null;
		if (ent) {
			for (let k = 0; k < ent[0].length; k++) starts.push(tr(pos + i));
			out += ent[0];
			i += ent[1];
		} else {
			starts.push(tr(pos + i));
			out += raw[i];
			i++;
		}
	}
	b.text(out, marks, starts);
}

function walkInline(tokens: Token[], b: InlineBuilder, marks: Mark[], pos: number, tr: Tr): number {
	for (const t of tokens) {
		const raw = (t as { raw: string }).raw ?? "";
		switch (t.type) {
			case "text": {
				const tt = t as Tokens.Text;
				if (tt.tokens && tt.tokens.length > 0) walkInline(tt.tokens, b, marks, pos, tr);
				else emitRaw(b, raw, marks, pos, tr);
				break;
			}
			case "escape": {
				b.text((t as Tokens.Escape).text, marks, [tr(pos)]);
				break;
			}
			case "strong":
			case "em":
			case "del": {
				const tt = t as Tokens.Strong;
				const prefix = t.type === "strong" ? 2 : t.type === "del" ? (raw.startsWith("~~") ? 2 : 1) : 1;
				const type = t.type === "del" ? "strike" : t.type;
				walkInline(tt.tokens ?? [], b, addMark(marks, { type } as Mark), pos + prefix, tr);
				break;
			}
			case "codespan": {
				const tt = t as Tokens.Codespan;
				let n = 0;
				while (raw[n] === "`") n++;
				let inner = n;
				const mid = raw.slice(n, raw.length - n);
				if (mid !== tt.text && mid.length >= 2 && mid[0] === " " && mid[mid.length - 1] === " ")
					inner = n + 1;
				const starts: number[] = [];
				for (let k = 0; k < tt.text.length; k++) starts.push(tr(pos + inner + k));
				b.text(tt.text, addMark(marks, { type: "code" }), starts);
				break;
			}
			case "link": {
				const tt = t as Tokens.Link;
				if (raw.startsWith("[")) {
					walkInline(
						tt.tokens ?? [],
						b,
						addMark(marks, { type: "link", href: tt.href, title: tt.title ?? null }),
						pos + 1,
						tr,
					);
				} else {
					// GFM 裸链接 / <autolink>：当作普通文字（裸链接里的反斜杠转义按转义处理）。
					let text = "";
					const starts: number[] = [];
					for (let k = 0; k < raw.length; k++) {
						if (raw[k] === "\\" && k + 1 < raw.length && /[!-/:-@[-`{-~]/.test(raw[k + 1])) {
							starts.push(tr(pos + k));
							text += raw[k + 1];
							k++;
						} else {
							starts.push(tr(pos + k));
							text += raw[k];
						}
					}
					b.text(text, marks, starts);
				}
				break;
			}
			case "br":
				b.atom({ type: "br" }, tr(pos));
				break;
			case "mention": {
				const tt = t as unknown as { ref: string; label?: string };
				const m = marks.filter((x) => x.type !== "code" && x.type !== "link");
				b.atom({ type: "mention", ref: tt.ref, label: tt.label ?? null, marks: m }, tr(pos));
				break;
			}
			default:
				// html、image 等方言外的行内写法：原样保留为文字（序列化时转义）。
				emitRaw(b, raw, marks, pos, tr, false);
		}
		pos += raw.length;
	}
	return pos;
}

function finishMap(b: InlineBuilder, end: number): SourceMap {
	const pts = b.points.slice();
	pts.push(end);
	for (let i = 1; i < pts.length; i++) if (pts[i] < pts[i - 1]) pts[i] = pts[i - 1];
	return { size: pts.length - 1, pmToSrc: pts };
}

function inlineOf(tokens: Token[], start: number, tr?: Tr): { content: Inline[]; map: SourceMap } {
	const b = new InlineBuilder();
	const t = tr ?? ((i: number) => start + i);
	const end = walkInline(tokens, b, [], 0, t);
	return { content: b.nodes, map: finishMap(b, t(end)) };
}

/** 引用：去掉每行的 `> ` 前缀，建立「内文偏移 → 源码偏移」。 */
function quoteTranslation(raw: string, start: number): { inner: string; tr: Tr } {
	const offs: number[] = [];
	let inner = "";
	let i = 0;
	while (i <= raw.length) {
		let j = raw.indexOf("\n", i);
		if (j < 0) j = raw.length;
		const line = raw.slice(i, j);
		const m = /^ {0,3}>[ \t]?/.exec(line);
		const p = m ? m[0].length : 0;
		for (let k = p; k < line.length; k++) {
			offs.push(start + i + k);
			inner += line[k];
		}
		if (j < raw.length) {
			offs.push(start + j);
			inner += "\n";
		}
		i = j + 1;
		if (j >= raw.length) break;
	}
	offs.push(start + raw.length);
	return { inner, tr: (x: number) => offs[Math.min(Math.max(x, 0), offs.length - 1)] };
}

/** 表格一行按未转义的 `|` 切成单元格，返回每格去空白后的源码区间。 */
function splitRow(line: string, lineStart: number): Array<[number, number]> {
	const cells: Array<[number, number]> = [];
	let s = 0;
	let e = line.length;
	while (s < e && /\s/.test(line[s])) s++;
	while (e > s && /\s/.test(line[e - 1])) e--;
	if (line[s] === "|") s++;
	if (e > s && line[e - 1] === "|" && line[e - 2] !== "\\") e--;
	let cs = s;
	for (let i = s; i <= e; i++) {
		if (i === e || (line[i] === "|" && line[i - 1] !== "\\")) {
			let a = cs;
			let z = i;
			while (a < z && /\s/.test(line[a])) a++;
			while (z > a && /\s/.test(line[z - 1])) z--;
			cells.push([lineStart + a, lineStart + z]);
			cs = i + 1;
		}
	}
	return cells;
}

function cellTranslation(src: string, a: number, z: number): Tr {
	const offs: number[] = [];
	let j = a;
	while (j < z) {
		offs.push(j);
		j += src[j] === "\\" && src[j + 1] === "|" ? 2 : 1;
	}
	offs.push(z);
	return (x: number) => offs[Math.min(Math.max(x, 0), offs.length - 1)];
}

function tableBody(
	t: Tokens.Table,
	src: string,
	start: number,
): { body: Body; map: SourceMap } {
	const raw = t.raw;
	const lines: Array<[string, number]> = [];
	let i = 0;
	for (const line of raw.split("\n")) {
		lines.push([line, start + i]);
		i += line.length + 1;
	}
	const srcRows = [lines[0], ...lines.slice(2)].filter((l) => l !== undefined && l[0].trim() !== "");
	const tokenRows = [t.header, ...t.rows];
	const points: number[] = [];
	const rows: Inline[][][] = [];
	tokenRows.forEach((cells, r) => {
		const [line, ls] = srcRows[r] ?? ["", start + raw.length];
		const spans = splitRow(line, ls);
		points.push(ls);
		const row: Inline[][] = [];
		cells.forEach((cell, c) => {
			const [a, z] = spans[c] ?? [ls + line.length, ls + line.length];
			points.push(a);
			const b = new InlineBuilder();
			const tr = cellTranslation(src, a, z);
			walkInline(cell.tokens, b, [], 0, tr);
			const content = b.nodes.filter((n) => n.type !== "br");
			row.push(content);
			for (const p of b.points) points.push(p);
			points.push(z);
		});
		points.push(ls + line.length);
		rows.push(row);
	});
	points.push(start + raw.length);
	for (let k = 1; k < points.length; k++) if (points[k] < points[k - 1]) points[k] = points[k - 1];
	const align = (t.align as Align[]).map((a) => a ?? null);
	return { body: { type: "table", align, rows }, map: { size: points.length - 1, pmToSrc: points } };
}

function allStrong(content: Inline[]): Inline[] {
	return content.map((n) =>
		n.type === "br" ? n : { ...n, marks: addMark(n.marks, { type: "strong" }) },
	);
}

interface BodyResult {
	body: Body;
	map: SourceMap;
	extra: OutlineNode[];
}

function emptyParagraph(at: number): BodyResult {
	return { body: { type: "paragraph", content: [] }, map: { size: 0, pmToSrc: [at] }, extra: [] };
}

/** 一个块级 token → 块体。返回 null 表示这个 token 不产生块体（如分隔线、空白）。 */
function tokenToBody(t: Token, src: string, start: number, notes: string[]): BodyResult | null {
	switch (t.type) {
		case "space":
			return null;
		case "hr":
			notes.push("丢弃分隔线（D23：分隔线不做）");
			return null;
		case "paragraph": {
			const { content, map } = inlineOf((t as Tokens.Paragraph).tokens, start);
			return { body: { type: "paragraph", content }, map, extra: [] };
		}
		case "text": {
			const tt = t as Tokens.Text;
			const { content, map } = inlineOf(tt.tokens ?? [], start);
			return { body: { type: "paragraph", content }, map, extra: [] };
		}
		case "heading": {
			const tt = t as Tokens.Heading;
			const off = Math.max(0, tt.raw.indexOf(tt.text));
			const { content, map } = inlineOf(tt.tokens, start + off);
			const flat = content.filter((n) => n.type !== "br");
			if (tt.depth <= 3) {
				return {
					body: { type: "heading", level: tt.depth as 1 | 2 | 3, content: flat },
					map,
					extra: [],
				};
			}
			notes.push(`h${tt.depth} 改成粗体段落（D23）`);
			return { body: { type: "paragraph", content: allStrong(flat) }, map, extra: [] };
		}
		case "code": {
			const tt = t as Tokens.Code;
			const fenced = tt.codeBlockStyle !== "indented";
			const off = fenced ? tt.raw.indexOf("\n") + 1 : 4;
			if (!fenced) notes.push("缩进代码块改成围栏代码块");
			const text = tt.text;
			const pts: number[] = [];
			for (let k = 0; k <= text.length; k++) pts.push(start + Math.min(off + k, tt.raw.length));
			return {
				body: { type: "code", lang: (tt.lang ?? "").trim(), text },
				map: { size: text.length, pmToSrc: pts },
				extra: [],
			};
		}
		case "blockquote": {
			const tt = t as Tokens.Blockquote;
			const { tr } = quoteTranslation(tt.raw, start);
			let pos = 0;
			let first: BodyResult | null = null;
			const extra: OutlineNode[] = [];
			for (const inner of tt.tokens) {
				if (!first && inner.type === "paragraph") {
					const { content, map } = inlineOf((inner as Tokens.Paragraph).tokens, 0, (x) =>
						tr(pos + x),
					);
					first = { body: { type: "quote", content }, map, extra: [] };
				} else if (inner.type !== "space") {
					const sub = tokenToNodes(inner, notes);
					for (const n of sub) {
						if (n.body.type === "paragraph") n.body = { type: "quote", content: n.body.content };
						extra.push(n);
					}
				}
				pos += inner.raw.length;
			}
			if (extra.length) notes.push("多段引用拆成子块");
			if (!first) first = { body: { type: "quote", content: [] }, map: { size: 0, pmToSrc: [start] }, extra: [] };
			first.extra = extra;
			return first;
		}
		case "table": {
			const r = tableBody(t as Tokens.Table, src, start);
			return { ...r, extra: [] };
		}
		case "embed": {
			const tt = t as unknown as { ref: string; label?: string };
			return {
				body: { type: "embed", ref: tt.ref, label: tt.label ?? null },
				map: { size: 0, pmToSrc: [start] },
				extra: [],
			};
		}
		case "list": {
			const nodes = tokenToNodes(t, notes);
			notes.push("列表拆成子块");
			const [head, ...rest] = nodes;
			if (!head) return null;
			return {
				body: head.body,
				map: { size: 0, pmToSrc: [start] },
				extra: [...head.children, ...rest],
			};
		}
		default: {
			// html 块、引用定义等：原样保留为文字。
			notes.push(`方言外的 ${t.type} 原样保留为文字`);
			const raw = t.raw.replace(/\n+$/, "");
			const b = new InlineBuilder();
			const parts = raw.split("\n");
			let p = start;
			parts.forEach((line, idx) => {
				if (idx > 0) {
					b.atom({ type: "br" }, p - 1);
				}
				emitRaw(b, line, [], p, (x) => x, false);
				p += line.length + 1;
			});
			return {
				body: { type: "paragraph", content: b.nodes },
				map: finishMap(b, start + raw.length),
				extra: [],
			};
		}
	}
}

const TASK_RE = /^\[([ xX/-])\][ \t]+/;

function itemToNode(item: Tokens.ListItem, notes: string[]): OutlineNode {
	let task: TaskState | null = null;
	const parts: Token[] = [];
	const nested: OutlineNode[] = [];
	for (const t of item.tokens) {
		if (t.type === "checkbox") {
			task = (t as unknown as { checked: boolean }).checked ? "x" : " ";
			continue;
		}
		if (t.type === "list") {
			nested.push(...tokenToNodes(t, notes));
			continue;
		}
		if (t.type === "space") continue;
		parts.push(t);
	}
	let headSrc = "";
	let rest: Token[] = parts;
	if (parts.length) {
		headSrc = parts[0].raw.replace(/\n+$/, "");
		rest = parts.slice(1);
		if (task === null) {
			const m = TASK_RE.exec(headSrc);
			if (m) {
				task = (m[1] === "X" ? "x" : m[1]) as TaskState;
				headSrc = headSrc.slice(m[0].length);
			}
		}
	}
	const head = parseBlock(headSrc);
	const children: OutlineNode[] = [...head.extra];
	for (const t of rest) children.push(...tokenToNodes(t, notes));
	if (rest.length) notes.push("列表项里的多段拆成子块");
	children.push(...nested);
	notes.push(...head.notes);
	return { body: head.body, task, children };
}

function tokenToNodes(t: Token, notes: string[]): OutlineNode[] {
	if (t.type === "list") return (t as Tokens.List).items.map((it) => itemToNode(it, notes));
	if (t.type === "space") return [];
	const r = tokenToBody(t, t.raw, 0, notes);
	if (!r) return [];
	return [{ body: r.body, task: null, children: r.extra }];
}

/** 一个块的正文。 */
export function parseBlock(src: string): ParsedBlock {
	const notes: string[] = [];
	const tokens = lexBlocks(src);
	let pos = 0;
	let first: BodyResult | null = null;
	const extra: OutlineNode[] = [];
	for (const t of tokens) {
		if (!first) {
			first = tokenToBody(t, src, pos, notes);
		} else if (t.type !== "space") {
			extra.push(...tokenToNodes(t, notes));
		}
		pos += t.raw.length;
	}
	if (extra.length && !notes.some((n) => n.includes("拆成子块"))) notes.push("多段拆成子块");
	const r = first ?? emptyParagraph(src.length);
	return { body: r.body, map: r.map, extra: [...r.extra, ...extra], notes };
}

/** 多行 markdown 大纲 → 块树。顶层的列表项、段落、标题……各成一块。 */
export function parseOutline(src: string): { nodes: OutlineNode[]; notes: string[] } {
	const notes: string[] = [];
	const nodes: OutlineNode[] = [];
	for (const t of lexBlocks(src)) nodes.push(...tokenToNodes(t, notes));
	return { nodes, notes };
}

/** 源码偏移 → 内容偏移：取最大的 k 使 pmToSrc[k] <= s。 */
export function srcToPm(map: SourceMap, s: number): number {
	const a = map.pmToSrc;
	let lo = 0;
	let hi = a.length - 1;
	if (s <= a[0]) return 0;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (a[mid] <= s) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

export function pmToSrc(map: SourceMap, k: number): number {
	const a = map.pmToSrc;
	return a[Math.min(Math.max(k, 0), a.length - 1)];
}
