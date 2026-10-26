/**
 * Dialect parser: markdown source of one block → body AST + source map.
 *
 * The first block-level token becomes the body. Everything after it (lists, more paragraphs,
 * ...) is split off as child blocks (`extra`) and explained in `notes`; nothing is dropped
 * silently except a thematic break, which the dialect does not have.
 *
 * `map.pmToSrc[k]` is the source offset of content offset `k` (see types.ts for the offset
 * convention), so the editor can keep a cursor stable while a block is re-parsed.
 */
import type { Token, Tokens } from "marked";
import { decodeEntityAt } from "./entities";
import { lexBlocks, type RefToken } from "./lexer";
import type {
	Align,
	BlockNode,
	Body,
	DialectNote,
	DialectNoteCode,
	Inline,
	Mark,
	ParsedBlock,
	SourceMap,
	TaskStatus,
} from "./types";

type Tr = (i: number) => number;

class InlineBuilder {
	nodes: Inline[] = [];
	points: number[] = [];

	/** At the start of a line: nothing emitted yet, or the last node is a break. */
	atLineStart(): boolean {
		const last = this.nodes[this.nodes.length - 1];
		return !last || last.type === "br";
	}

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

class Notes {
	list: DialectNote[] = [];

	add(code: DialectNoteCode, message: string) {
		if (!this.list.some((n) => n.code === code && n.message === message))
			this.list.push({ code, message });
	}

	has(code: DialectNoteCode): boolean {
		return this.list.some((n) => n.code === code);
	}
}

export function sameMarks(a: Mark[], b: Mark[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] as Mark;
		const y = b[i] as Mark;
		if (x.type !== y.type || (x.href ?? null) !== (y.href ?? null)) return false;
		if ((x.title ?? null) !== (y.title ?? null)) return false;
	}
	return true;
}

/** Canonical mark order; the serializer nests marks the same way (links outermost). */
export const MARK_ORDER: Record<Mark["type"], number> = {
	link: 0,
	strong: 1,
	em: 2,
	strike: 3,
	code: 4,
};

function addMark(marks: Mark[], m: Mark): Mark[] {
	if (marks.some((x) => x.type === m.type)) return marks;
	const out = [...marks, m];
	out.sort((a, b) => MARK_ORDER[a.type] - MARK_ORDER[b.type]);
	return out;
}

/** Emits raw source text (possibly with character references) one character at a time. */
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

const ESCAPABLE = /[!-/:-@[-`{-~]/;

function walkInline(tokens: Token[], b: InlineBuilder, marks: Mark[], pos: number, tr: Tr): number {
	for (const t of tokens) {
		const raw = (t as { raw?: string }).raw ?? "";
		switch (t.type) {
			case "text": {
				const tt = t as Tokens.Text;
				if (tt.tokens && tt.tokens.length > 0) walkInline(tt.tokens, b, marks, pos, tr);
				else {
					// Leading whitespace of a line is indentation, not content (CommonMark strips it;
					// marked keeps it). A character reference such as `&#32;` is content.
					const lead =
						marks.length === 0 && b.atLineStart() ? (/^[ \t]*/.exec(raw)?.[0].length ?? 0) : 0;
					emitRaw(b, raw.slice(lead), marks, pos + lead, tr);
				}
				break;
			}
			case "escape":
				b.text((t as Tokens.Escape).text, marks, [tr(pos)]);
				break;
			case "strong":
			case "em":
			case "del": {
				const tt = t as Tokens.Strong;
				const prefix =
					t.type === "strong" ? 2 : t.type === "del" ? (raw.startsWith("~~") ? 2 : 1) : 1;
				const type = t.type === "del" ? "strike" : t.type;
				walkInline(tt.tokens ?? [], b, addMark(marks, { type }), pos + prefix, tr);
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
					const link: Mark = { type: "link", href: tt.href, title: tt.title ?? null };
					walkInline(tt.tokens ?? [], b, addMark(marks, link), pos + 1, tr);
				} else {
					// `<scheme:…>` autolink: plain text in the dialect (escapes still apply).
					let text = "";
					const starts: number[] = [];
					for (let k = 0; k < raw.length; k++) {
						starts.push(tr(pos + k));
						if (raw[k] === "\\" && k + 1 < raw.length && ESCAPABLE.test(raw[k + 1] as string)) {
							text += raw[k + 1];
							k++;
						} else text += raw[k];
					}
					b.text(text, marks, starts);
				}
				break;
			}
			case "br":
				b.atom({ type: "br" }, tr(pos));
				break;
			case "mention": {
				const tt = t as unknown as RefToken;
				const m = marks.filter((x) => x.type !== "code" && x.type !== "link");
				b.atom({ type: "mention", ref: tt.ref, label: tt.label, marks: m }, tr(pos));
				break;
			}
			default:
				// Inline HTML, images and the like are outside the dialect: keep them as literal text
				// (the serializer escapes them).
				emitRaw(b, raw, marks, pos, tr, false);
		}
		pos += raw.length;
	}
	return pos;
}

function finishMap(b: InlineBuilder, end: number): SourceMap {
	const pts = b.points.slice();
	pts.push(end);
	for (let i = 1; i < pts.length; i++)
		if ((pts[i] as number) < (pts[i - 1] as number)) pts[i] = pts[i - 1] as number;
	return { size: pts.length - 1, pmToSrc: pts };
}

function inlineOf(tokens: Token[], start: number, tr?: Tr): { content: Inline[]; map: SourceMap } {
	const b = new InlineBuilder();
	const t = tr ?? ((i: number) => start + i);
	const end = walkInline(tokens, b, [], 0, t);
	return { content: b.nodes, map: finishMap(b, t(end)) };
}

/** Quote: strips each line's `> ` prefix and maps inner offsets back to the source. */
function quoteTranslation(raw: string, start: number): Tr {
	const offs: number[] = [];
	let i = 0;
	while (i <= raw.length) {
		let j = raw.indexOf("\n", i);
		if (j < 0) j = raw.length;
		const line = raw.slice(i, j);
		const m = /^ {0,3}>[ \t]?/.exec(line);
		const p = m ? m[0].length : 0;
		for (let k = p; k < line.length; k++) offs.push(start + i + k);
		if (j < raw.length) offs.push(start + j);
		i = j + 1;
		if (j >= raw.length) break;
	}
	offs.push(start + raw.length);
	return (x: number) => offs[Math.min(Math.max(x, 0), offs.length - 1)] as number;
}

/** Splits a table row on unescaped `|`; returns the trimmed source range of each cell. */
function splitRow(line: string, lineStart: number): Array<[number, number]> {
	const cells: Array<[number, number]> = [];
	let s = 0;
	let e = line.length;
	while (s < e && /\s/.test(line[s] as string)) s++;
	while (e > s && /\s/.test(line[e - 1] as string)) e--;
	if (line[s] === "|") s++;
	if (e > s && line[e - 1] === "|" && line[e - 2] !== "\\") e--;
	let cs = s;
	for (let i = s; i <= e; i++) {
		if (i === e || (line[i] === "|" && line[i - 1] !== "\\")) {
			let a = cs;
			let z = i;
			while (a < z && /\s/.test(line[a] as string)) a++;
			while (z > a && /\s/.test(line[z - 1] as string)) z--;
			cells.push([lineStart + a, lineStart + z]);
			cs = i + 1;
		}
	}
	return cells;
}

/** Cell text offsets → source offsets (marked has already turned `\|` into `|`). */
function cellTranslation(src: string, a: number, z: number): Tr {
	const offs: number[] = [];
	let j = a;
	while (j < z) {
		offs.push(j);
		j += src[j] === "\\" && src[j + 1] === "|" ? 2 : 1;
	}
	offs.push(z);
	return (x: number) => offs[Math.min(Math.max(x, 0), offs.length - 1)] as number;
}

function tableBody(t: Tokens.Table, src: string, start: number): { body: Body; map: SourceMap } {
	const raw = t.raw;
	const lines: Array<[string, number]> = [];
	let i = 0;
	for (const line of raw.split("\n")) {
		lines.push([line, start + i]);
		i += line.length + 1;
	}
	const srcRows = [lines[0], ...lines.slice(2)].filter(
		(l): l is [string, number] => l !== undefined && l[0].trim() !== "",
	);
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
			walkInline(cell.tokens, b, [], 0, cellTranslation(src, a, z));
			row.push(b.nodes.filter((n) => n.type !== "br"));
			for (const p of b.points) points.push(p);
			points.push(z);
		});
		points.push(ls + line.length);
		rows.push(row);
	});
	points.push(start + raw.length);
	for (let k = 1; k < points.length; k++)
		if ((points[k] as number) < (points[k - 1] as number)) points[k] = points[k - 1] as number;
	const align = (t.align as Align[]).map((a) => a ?? null);
	return {
		body: { type: "table", align, rows },
		map: { size: points.length - 1, pmToSrc: points },
	};
}

function allStrong(content: Inline[]): Inline[] {
	return content.map((n) =>
		n.type === "br" ? n : { ...n, marks: addMark(n.marks, { type: "strong" }) },
	);
}

interface BodyResult {
	body: Body;
	map: SourceMap;
	extra: BlockNode[];
}

function emptyParagraph(at: number): BodyResult {
	return { body: { type: "paragraph", content: [] }, map: { size: 0, pmToSrc: [at] }, extra: [] };
}

/** One block-level token → body; null when the token produces no body (blank, rule). */
function tokenToBody(t: Token, src: string, start: number, notes: Notes): BodyResult | null {
	switch (t.type) {
		case "space":
			return null;
		case "hr":
			notes.add("rule-dropped", "dropped a horizontal rule (the dialect has none)");
			return null;
		case "paragraph": {
			const { content, map } = inlineOf((t as Tokens.Paragraph).tokens, start);
			return { body: { type: "paragraph", content }, map, extra: [] };
		}
		case "text": {
			const { content, map } = inlineOf((t as Tokens.Text).tokens ?? [], start);
			return { body: { type: "paragraph", content }, map, extra: [] };
		}
		case "heading": {
			const tt = t as Tokens.Heading;
			const off = Math.max(0, tt.raw.indexOf(tt.text));
			const { content, map } = inlineOf(tt.tokens, start + off);
			const flat = content.filter((n) => n.type !== "br");
			if (tt.depth <= 3) {
				const level = tt.depth as 1 | 2 | 3;
				return { body: { type: "heading", level, content: flat }, map, extra: [] };
			}
			notes.add("heading-demoted", `turned a level-${tt.depth} heading into a bold paragraph`);
			return { body: { type: "paragraph", content: allStrong(flat) }, map, extra: [] };
		}
		case "code": {
			const tt = t as Tokens.Code;
			const fenced = tt.codeBlockStyle !== "indented";
			const off = fenced ? tt.raw.indexOf("\n") + 1 : 4;
			if (!fenced) notes.add("indented-code", "turned an indented code block into a fenced one");
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
			const tr = quoteTranslation(tt.raw, start);
			let pos = 0;
			let first: BodyResult | null = null;
			const extra: BlockNode[] = [];
			for (const inner of tt.tokens) {
				if (!first && inner.type === "paragraph") {
					const at = pos;
					const { content, map } = inlineOf((inner as Tokens.Paragraph).tokens, 0, (x) =>
						tr(at + x),
					);
					first = { body: { type: "quote", content }, map, extra: [] };
				} else if (inner.type !== "space") {
					for (const n of tokenToNodes(inner, notes)) {
						if (n.body.type === "paragraph") n.body = { type: "quote", content: n.body.content };
						extra.push(n);
					}
				}
				pos += inner.raw.length;
			}
			if (extra.length) notes.add("split-quote", "split a multi-paragraph quote into child blocks");
			const head = first ?? {
				body: { type: "quote", content: [] },
				map: { size: 0, pmToSrc: [start] },
				extra: [],
			};
			head.extra = extra;
			return head;
		}
		case "table":
			return { ...tableBody(t as Tokens.Table, src, start), extra: [] };
		case "embed": {
			const tt = t as unknown as RefToken;
			return {
				body: { type: "embed", ref: tt.ref, label: tt.label },
				map: { size: 0, pmToSrc: [start] },
				extra: [],
			};
		}
		case "list": {
			const nodes = tokenToNodes(t, notes);
			notes.add("split-list", "split a list into child blocks");
			const [head, ...rest] = nodes;
			if (!head) return null;
			return {
				body: head.body,
				map: { size: 0, pmToSrc: [start] },
				extra: [...head.children, ...rest],
			};
		}
		default: {
			// HTML blocks, link reference definitions, ...: keep the source as literal text.
			notes.add("kept-as-text", `kept an out-of-dialect ${t.type} as text`);
			const raw = t.raw.replace(/\n+$/, "");
			const b = new InlineBuilder();
			let p = start;
			raw.split("\n").forEach((line, idx) => {
				if (idx > 0) b.atom({ type: "br" }, p - 1);
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

const TASK_RE = /^\[([ xX/-])\](?:[ \t]+|$)/;

/** Checkbox character → task status (`X` is accepted as done). */
export function taskStatusOf(box: string): TaskStatus | null {
	switch (box) {
		case " ":
			return "todo";
		case "/":
			return "doing";
		case "x":
		case "X":
			return "done";
		case "-":
			return "cancelled";
		default:
			return null;
	}
}

function itemToNode(item: Tokens.ListItem, notes: Notes): BlockNode {
	let task: TaskStatus | null = null;
	const parts: Token[] = [];
	const nested: BlockNode[] = [];
	for (const t of item.tokens) {
		if (t.type === "checkbox") {
			task = (t as unknown as { checked: boolean }).checked ? "done" : "todo";
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
		headSrc = (parts[0] as Token).raw.replace(/\n+$/, "");
		rest = parts.slice(1);
		if (task === null) {
			const m = TASK_RE.exec(headSrc);
			if (m) {
				task = taskStatusOf(m[1] as string);
				headSrc = headSrc.slice(m[0].length);
			}
		}
	}
	const head = parseBlock(headSrc);
	const children: BlockNode[] = [...head.extra];
	for (const t of rest) children.push(...tokenToNodes(t, notes));
	if (rest.length) notes.add("split-paragraphs", "split extra paragraphs into child blocks");
	children.push(...nested);
	for (const n of head.notes) notes.add(n.code, n.message);
	return { body: head.body, task, children };
}

function tokenToNodes(t: Token, notes: Notes): BlockNode[] {
	if (t.type === "list") return (t as Tokens.List).items.map((it) => itemToNode(it, notes));
	if (t.type === "space") return [];
	const r = tokenToBody(t, t.raw, 0, notes);
	if (!r) return [];
	return [{ body: r.body, task: null, children: r.extra }];
}

/** Parses the markdown source of one block. */
export function parseBlock(src: string): ParsedBlock {
	const notes = new Notes();
	const tokens = lexBlocks(src);
	let pos = 0;
	let first: BodyResult | null = null;
	const extra: BlockNode[] = [];
	for (const t of tokens) {
		if (!first) {
			first = tokenToBody(t, src, pos, notes);
		} else if (t.type !== "space") {
			if (t.type === "list") notes.add("split-list", "split a list into child blocks");
			else if (t.type !== "hr")
				notes.add("split-paragraphs", "split extra paragraphs into child blocks");
			extra.push(...tokenToNodes(t, notes));
		}
		pos += t.raw.length;
	}
	const r = first ?? emptyParagraph(src.length);
	return { body: r.body, map: r.map, extra: [...r.extra, ...extra], notes: notes.list };
}

/**
 * Parses free markdown into a sequence of blocks: every top-level markdown block becomes one
 * node, list items become nodes nested by the list structure. Used for text that is not inside
 * an outline list item.
 */
export function parseBlocks(src: string): { nodes: BlockNode[]; notes: DialectNote[] } {
	const notes = new Notes();
	const nodes: BlockNode[] = [];
	for (const t of lexBlocks(src)) nodes.push(...tokenToNodes(t, notes));
	return { nodes, notes: notes.list };
}

/** Source offset → content offset: the largest `k` with `pmToSrc[k] <= s`. */
export function srcToPm(map: SourceMap, s: number): number {
	const a = map.pmToSrc;
	let lo = 0;
	let hi = a.length - 1;
	if (s <= (a[0] as number)) return 0;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((a[mid] as number) <= s) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** Content offset → source offset. */
export function pmToSrc(map: SourceMap, k: number): number {
	const a = map.pmToSrc;
	return a[Math.min(Math.max(k, 0), a.length - 1)] as number;
}
