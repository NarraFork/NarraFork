/**
 * Markdown outline ⇄ block tree: the input of `OutlineEdit`, the output of `OutlineRead`, and
 * the clipboard format.
 *
 * ```text
 * - [ ] Fix the refresh race @agent:w-auth
 *   depends:: [[Add regression test]]
 *   due:: 2026-11-01
 *   - Plan: reject requests that carry an older version
 * ```
 *
 * Rules (the parser accepts all of these; the serializer writes the canonical form):
 * - Every list item (`-`, `*`, `+`, `1.`, `1)`) is a block; indentation is hierarchy. Any
 *   consistent indentation works (2 or 4 spaces, tabs; a tab advances to the next multiple of
 *   4 columns): an item indented deeper than the previous one is its child. The canonical form
 *   uses `- ` and 2 spaces per level.
 * - `[ ]` todo, `[/]` doing, `[x]` done, `[-]` cancelled right after the bullet make a task.
 *   On a task, `@agent:name` / `@human:name` in the first line (outside code) is the assignee.
 * - Lines indented under an item continue its body: hard line breaks, fenced code, tables,
 *   quotes all belong to that block. Lines inside a fence are body lines whatever they look like.
 *   An unindented line directly after an item's text continues it (a CommonMark lazy line).
 * - `key:: value` lines under an item are properties: `depends`, `due`, `alias`, `tags`.
 *   `depends::` and `tags::` hold links (`[[a]], [[b]]`; plain comma-separated words are read as
 *   link targets). Unknown keys and invalid values stay in the body as text, with a note.
 * - The body is normalized with the block dialect: a list, extra paragraphs or another block
 *   inside an item become child blocks before the item's own children (see `normalizeBlock`).
 * - Text after an item's child items (indented to the item's level) becomes a further child.
 * - Text outside any list item becomes top-level blocks, one per paragraph, heading, code
 *   block, table or quote, in document order (so a plain paragraph is a single block).
 *
 * Everything the parser had to split, convert or keep as text is reported in `notes`, with the
 * line it happened at; nothing is dropped silently.
 *
 * The serializer writes exactly what the parser reads back: for items whose `content` is
 * canonical dialect markdown (as stored), `parse(serialize(items))` returns the same items and
 * serializing them again gives the same text.
 */
import { formatLinkList, type LinkTarget, parseAliasValue, parseLinkList } from "./address";
import {
	type BlockNode,
	type DialectNoteCode,
	isValidMention,
	normalizeBlock,
	parseBlocks,
	serializeBody,
	type TaskStatus,
	taskStatusOf,
} from "./dialect";

export const TASK_BOX: Readonly<Record<TaskStatus, string>> = {
	todo: " ",
	doing: "/",
	done: "x",
	cancelled: "-",
};

/** Property keys, in the order the serializer writes them. */
export const PROPERTY_KEYS = ["depends", "due", "alias", "tags"] as const;
export type PropertyKey = (typeof PROPERTY_KEYS)[number];

export interface OutlineTask {
	status: TaskStatus;
	/** `agent:name` or `human:name`, without the `@`. */
	assignee: string | null;
}

export interface OutlineProps {
	depends?: LinkTarget[];
	/** As written, `YYYY-MM-DD` with an optional time. */
	due?: string;
	/** A literal alias (`Q17`) or `Prefix?` asking for the next free number. */
	alias?: string;
	tags?: LinkTarget[];
}

export interface OutlineItem {
	/** Canonical dialect markdown of the block body. */
	content: string;
	task: OutlineTask | null;
	props: OutlineProps;
	children: OutlineItem[];
	/** What `readLabel` took off the front of the item line, if anything. */
	label?: string;
}

export type OutlineNoteCode =
	| DialectNoteCode
	| "top-level-text"
	| "text-after-children"
	| "unknown-property"
	| "invalid-property"
	| "duplicate-property"
	| "bare-link"
	| "extra-assignee";

export interface OutlineNote {
	/** 1-based line of the item (or line) the note is about. */
	line: number;
	code: OutlineNoteCode;
	message: string;
}

export interface ParseOutlineOptions {
	/**
	 * Takes a per-block label (an id prefix, say) off the start of an item line, right after the
	 * bullet. Returns null when there is none. The counterpart of `SerializeOutlineOptions.label`.
	 */
	readLabel?: (head: string) => { label: string; rest: string } | null;
}

export interface SerializeOutlineOptions {
	/**
	 * Text to put right after the bullet of an item (before its checkbox), e.g. an address.
	 * `path` is the item's index path from the top level. Return null/undefined for none.
	 * For an exact round trip the parser needs a `readLabel` that takes the same text off again.
	 */
	label?: (item: OutlineItem, path: readonly number[]) => string | null | undefined;
}

// ---------------------------------------------------------------------------
// Line syntax

const ITEM_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const RULE_RE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const TASK_BOX_RE = /^\[([ xX/-])\](?:[ \t]+|$)/;
const PROP_RE = /^([a-z][a-z0-9_-]*)::(?:[ \t]+(.*?))?[ \t]*$/;
const ASSIGNEE_RE = /(?<![\\\p{L}\p{N}_`])@((?:agent|human):[\p{L}\p{N}_.-]*[\p{L}\p{N}_])/gu;
const DUE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;
const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const BLOCK_START_RE = /^[ \t]*(?:#{1,6}(?:[ \t]|$)|>|\||`{3,}|~{3,})/;

function isPropertyKey(k: string): k is PropertyKey {
	return (PROPERTY_KEYS as readonly string[]).includes(k);
}

/** Width of leading whitespace in columns (a tab advances to the next multiple of 4). */
function indentWidth(line: string): number {
	let col = 0;
	for (const ch of line) {
		if (ch === " ") col++;
		else if (ch === "\t") col += 4 - (col % 4);
		else break;
	}
	return col;
}

/** Removes up to `n` columns of leading whitespace, splitting a tab that straddles the cut. */
function stripColumns(line: string, n: number): string {
	let col = 0;
	let i = 0;
	while (i < line.length && col < n) {
		const ch = line[i];
		if (ch === " ") col++;
		else if (ch === "\t") {
			const next = col + 4 - (col % 4);
			if (next > n) return " ".repeat(next - n) + line.slice(i + 1);
			col = next;
		} else break;
		i++;
	}
	return line.slice(i);
}

/**
 * Ranges of code spans in a line (or a block's inline text), matched the CommonMark way: a
 * backslash can escape an opening backtick but not a closing one (escapes do not work inside
 * code spans), and a span closes at the next backtick string of exactly the same length.
 */
export function codeSpans(line: string): Array<[number, number]> {
	// Starts of maximal backtick strings, grouped by length (ascending).
	const byLength = new Map<number, number[]>();
	for (let i = 0; i < line.length; ) {
		if (line[i] !== "`") {
			i++;
			continue;
		}
		let n = 0;
		while (line[i + n] === "`") n++;
		const list = byLength.get(n);
		if (list) list.push(i);
		else byLength.set(n, [i]);
		i += n;
	}
	const closer = (n: number, after: number): number => {
		const list = byLength.get(n);
		if (!list) return -1;
		let lo = 0;
		let hi = list.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if ((list[mid] as number) > after) hi = mid;
			else lo = mid + 1;
		}
		return lo < list.length ? (list[lo] as number) : -1;
	};
	const out: Array<[number, number]> = [];
	for (let i = 0; i < line.length; ) {
		if (line[i] === "\\") {
			i += 2;
			continue;
		}
		if (line[i] !== "`") {
			i++;
			continue;
		}
		let n = 0;
		while (line[i + n] === "`") n++;
		const close = closer(n, i + n - 1);
		if (close < 0) {
			i += n;
			continue;
		}
		out.push([i, close + n]);
		i = close + n;
	}
	return out;
}

/** Assignee mentions in a line, outside code spans. */
function assigneeMatches(line: string): RegExpExecArray[] {
	const spans = codeSpans(line);
	const out: RegExpExecArray[] = [];
	for (const m of line.matchAll(ASSIGNEE_RE)) {
		if (!spans.some(([a, b]) => m.index >= a && m.index < b)) out.push(m as RegExpExecArray);
	}
	return out;
}

interface Fence {
	char: string;
	len: number;
}

function fenceOpen(line: string): Fence | null {
	const m = FENCE_OPEN_RE.exec(line);
	if (!m) return null;
	const run = m[1] as string;
	if (run[0] === "`" && (m[2] as string).includes("`")) return null;
	return { char: run[0] as string, len: run.length };
}

function fenceCloses(line: string, f: Fence): boolean {
	const t = line.trim();
	return t.length >= f.len && /^(`+|~+)$/.test(t) && t[0] === f.char;
}

// ---------------------------------------------------------------------------
// Parser

/** A source line; `indented` lines still carry indentation that belongs to the outline. */
interface Line {
	text: string;
	indented: boolean;
}

interface RawText {
	kind: "text";
	line: number;
	/** Text under an item (dedented when finished), or top-level text (kept as written). */
	underItem: boolean;
	lines: Line[];
}

interface RawItem {
	kind: "item";
	line: number;
	indent: number;
	label?: string;
	task: OutlineTask | null;
	lines: Line[];
	props: OutlineProps;
	children: Array<RawItem | RawText>;
}

type Sink = RawItem | RawText;

class NoteList {
	list: OutlineNote[] = [];

	add(line: number, code: OutlineNoteCode, message: string) {
		if (!this.list.some((n) => n.line === line && n.code === code && n.message === message))
			this.list.push({ line, code, message });
	}
}

function linkKey(l: LinkTarget): string {
	return `${l.target}|${l.label ?? ""}`;
}

/** Applies one `key:: value` line; false when the line must stay body text. */
function applyProperty(
	item: RawItem,
	key: string,
	value: string,
	line: number,
	notes: NoteList,
): boolean {
	if (!isPropertyKey(key)) {
		notes.add(
			line,
			"unknown-property",
			`kept "${key}::" as text (properties: ${PROPERTY_KEYS.join(", ")})`,
		);
		return false;
	}
	if (key === "depends" || key === "tags") {
		const { links, bare } = parseLinkList(value);
		const bad = bare.filter((t) => !isValidMention(t, null));
		if ((!links.length && !bare.length) || bad.length) {
			notes.add(line, "invalid-property", `kept "${key}::" as text: expected [[links]]`);
			return false;
		}
		if (bare.length)
			notes.add(line, "bare-link", `read ${key}:: ${bare.join(", ")} as links ([[…]])`);
		const all = [
			...(item.props[key] ?? []),
			...links,
			...bare.map((target) => ({ target, label: null })),
		];
		const seen = new Set<string>();
		item.props[key] = all.filter((l) => !seen.has(linkKey(l)) && !!seen.add(linkKey(l)));
		return true;
	}
	if (key === "due") {
		if (!DUE_RE.test(value) || Number.isNaN(Date.parse(value))) {
			notes.add(line, "invalid-property", `kept "due::" as text: expected YYYY-MM-DD`);
			return false;
		}
	} else if (!parseAliasValue(value)) {
		notes.add(line, "invalid-property", `kept "alias::" as text: expected one word such as Q17`);
		return false;
	}
	if (item.props[key] !== undefined && item.props[key] !== value)
		notes.add(line, "duplicate-property", `"${key}::" given twice; kept the last value`);
	item.props[key] = value;
	return true;
}

/** Takes the assignee off a task's first line. */
function takeAssignee(
	head: string,
	line: number,
	notes: NoteList,
): { head: string; assignee: string | null } {
	const ms = assigneeMatches(head);
	const first = ms[0];
	if (!first) return { head, assignee: null };
	if (ms.length > 1)
		notes.add(line, "extra-assignee", "a task has one assignee; kept the first, the rest is text");
	const before = head.slice(0, first.index);
	const after = head.slice(first.index + first[0].length);
	const joined =
		/[ \t]$/.test(before) && /^[ \t]/.test(after) ? before + after.slice(1) : before + after;
	return { head: joined.trim(), assignee: first[1] as string };
}

/**
 * Parses a markdown outline into items. Never throws on malformed input: what does not fit is
 * split, converted or kept as text, and reported in `notes`.
 */
export function parseMarkdownOutline(
	src: string,
	opts: ParseOutlineOptions = {},
): { items: OutlineItem[]; notes: OutlineNote[] } {
	const notes = new NoteList();
	const roots: Sink[] = [];
	const stack: RawItem[] = [];
	/** An open code fence; a line at or left of `owner`'s bullet ends it (CommonMark). */
	let fence: (Fence & { sink: Sink; owner: number }) | null = null;
	let blanks = 0;
	/** Sink of the previous non-blank line, if a lazy continuation line may follow it. */
	let lazy: Sink | null = null;
	const lines = src
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.split("\n");

	const append = (sink: Sink, text: string, indented: boolean) => {
		if (sink.lines.length)
			for (; blanks > 0; blanks--) sink.lines.push({ text: "", indented: false });
		blanks = 0;
		sink.lines.push({ text, indented });
	};

	lines.forEach((raw, li) => {
		const lineNo = li + 1;
		if (fence) {
			const blank = raw.trim() === "";
			if (blank || indentWidth(raw) > fence.owner) {
				// Whitespace-only lines are code too; only an empty line carries no indentation.
				fence.sink.lines.push({ text: raw, indented: raw !== "" });
				if (fenceCloses(raw, fence)) fence = null;
				lazy = null;
				return;
			}
			fence = null;
		}
		if (raw.trim() === "") {
			blanks++;
			return;
		}
		const m = RULE_RE.test(raw) ? null : ITEM_RE.exec(raw);
		if (m) {
			const indent = indentWidth(m[1] as string);
			while (stack.length && (stack[stack.length - 1] as RawItem).indent >= indent) stack.pop();
			let head = m[4] ?? "";
			const item: RawItem = {
				kind: "item",
				line: lineNo,
				indent,
				task: null,
				lines: [],
				props: {},
				children: [],
			};
			const label = opts.readLabel?.(head);
			if (label) {
				item.label = label.label;
				head = label.rest.replace(/^[ \t]+/, "");
			}
			const box = TASK_BOX_RE.exec(head);
			if (box) {
				item.task = { status: taskStatusOf(box[1] as string) as TaskStatus, assignee: null };
				head = head.slice(box[0].length);
				const a = takeAssignee(head, lineNo, notes);
				head = a.head;
				item.task.assignee = a.assignee;
			}
			const parent = stack[stack.length - 1];
			if (parent) parent.children.push(item);
			else roots.push(item);
			stack.push(item);
			blanks = 0;
			item.lines.push({ text: head, indented: false });
			const f = fenceOpen(head);
			fence = f ? { ...f, sink: item, owner: indent } : null;
			lazy = !f && head.trim() !== "" && !/^#{1,6}(?:[ \t]|$)/.test(head) ? item : null;
			return;
		}
		const indent = indentWidth(raw);
		// The deepest open item this line is indented under owns it.
		let k = stack.length - 1;
		while (k >= 0 && (stack[k] as RawItem).indent >= indent) k--;
		const isLazy = k < 0 && lazy !== null && blanks === 0 && !BLOCK_START_RE.test(raw);
		let owner: RawItem | null = null;
		if (k >= 0) {
			stack.length = k + 1;
			owner = stack[k] as RawItem;
		} else if (isLazy && lazy?.kind === "item") owner = lazy;
		else if (!isLazy) stack.length = 0;

		const prop = owner && !fenceOpen(raw) ? PROP_RE.exec(raw.trim()) : null;
		if (owner && prop && applyProperty(owner, prop[1] as string, prop[2] ?? "", lineNo, notes)) {
			blanks = 0;
			lazy = owner;
			return;
		}
		let sink: Sink;
		if (isLazy) sink = lazy as Sink;
		else if (owner) sink = bodySink(owner, lineNo);
		else {
			const last = roots[roots.length - 1];
			if (last?.kind === "text") sink = last;
			else {
				sink = { kind: "text", line: lineNo, underItem: false, lines: [] };
				roots.push(sink);
			}
		}
		if (isLazy) append(sink, raw.trimStart(), false);
		else append(sink, raw, sink.kind === "item" || sink.underItem);
		const f = fenceOpen(raw);
		fence = f ? { ...f, sink, owner: owner && !isLazy ? owner.indent : -1 } : null;
		lazy = f || /^[ \t]*#{1,6}(?:[ \t]|$)/.test(raw) ? null : sink;
	});

	/** Where body text of `owner` goes: the item itself, or a text block after its children. */
	function bodySink(owner: RawItem, lineNo: number): Sink {
		if (!owner.children.length) return owner;
		const last = owner.children[owner.children.length - 1];
		if (last?.kind === "text") return last;
		const text: RawText = { kind: "text", line: lineNo, underItem: true, lines: [] };
		owner.children.push(text);
		notes.add(lineNo, "text-after-children", "text after child items became a child block");
		return text;
	}

	const finishText = (t: RawText): OutlineItem[] => {
		const { nodes, notes: dn } = parseBlocks(sinkSource(t.lines));
		for (const n of dn) notes.add(t.line, n.code, n.message);
		return nodes.map(fromBlockNode);
	};
	const finishItem = (it: RawItem): OutlineItem => {
		const norm = normalizeBlock(sinkSource(it.lines));
		for (const n of norm.notes) notes.add(it.line, n.code, n.message);
		const children = norm.children.map(fromBlockNode);
		for (const c of it.children) {
			if (c.kind === "item") children.push(finishItem(c));
			else children.push(...finishText(c));
		}
		const out: OutlineItem = { content: norm.content, task: it.task, props: it.props, children };
		if (it.label !== undefined) out.label = it.label;
		return out;
	};
	const items: OutlineItem[] = [];
	const hasItems = roots.some((r) => r.kind === "item");
	for (const r of roots) {
		if (r.kind === "item") items.push(finishItem(r));
		else {
			const blocks = finishText(r);
			if (hasItems || blocks.length > 1)
				notes.add(
					r.line,
					"top-level-text",
					`text outside list items became ${blocks.length} top-level block(s)`,
				);
			items.push(...blocks);
		}
	}
	return { items, notes: notes.list };
}

/**
 * Joins a block's lines, removing the indentation its lines share: whatever indentation style
 * the outline uses (2 or 4 spaces, tabs), the body comes out as written relative to itself.
 */
function sinkSource(lines: Line[]): string {
	let common = Number.POSITIVE_INFINITY;
	for (const l of lines)
		if (l.indented && l.text.trim() !== "") common = Math.min(common, indentWidth(l.text));
	return lines.map((l) => (l.indented ? stripColumns(l.text, common) : l.text)).join("\n");
}

function fromBlockNode(n: BlockNode): OutlineItem {
	return {
		content: serializeBody(n.body),
		task: n.task ? { status: n.task, assignee: null } : null,
		props: {},
		children: n.children.map(fromBlockNode),
	};
}

// ---------------------------------------------------------------------------
// Serializer

/** Content lines of an item, escaped so the outline parser reads them back as body text. */
function contentLines(item: OutlineItem): string[] {
	const lines = item.content.split("\n");
	let first = lines[0] ?? "";
	// A non-task block whose text starts like a checkbox, or a task whose text mentions an
	// assignee, would otherwise be read back as task syntax.
	if (!item.task && TASK_BOX_RE.test(first)) first = `\\${first}`;
	if (item.task) {
		for (const m of assigneeMatches(first).reverse())
			first = `${first.slice(0, m.index)}\\${first.slice(m.index)}`;
	}
	lines[0] = first;
	if (fenceOpen(first)) return lines;
	return lines.map((l, i) => (i > 0 && PROP_RE.test(l) ? l.replace("::", "\\::") : l));
}

function propertyLines(props: OutlineProps): string[] {
	const out: string[] = [];
	for (const key of PROPERTY_KEYS) {
		const v = props[key];
		if (v === undefined) continue;
		if (typeof v === "string") out.push(`${key}:: ${v}`);
		else if (v.length) out.push(`${key}:: ${formatLinkList(v)}`);
	}
	return out;
}

/** Writes items as a canonical markdown outline (`- ` bullets, 2 spaces per level). */
export function serializeMarkdownOutline(
	items: readonly OutlineItem[],
	opts: SerializeOutlineOptions = {},
): string {
	const out: string[] = [];
	const walk = (list: readonly OutlineItem[], depth: number, path: readonly number[]) => {
		list.forEach((item, i) => {
			const at = [...path, i];
			const pad = "  ".repeat(depth);
			const [first = "", ...rest] = contentLines(item);
			let line = "- ";
			const label = opts.label?.(item, at);
			if (label) line += `${label} `;
			if (item.task) line += `[${TASK_BOX[item.task.status]}] `;
			line += first;
			if (item.task?.assignee) line += ` @${item.task.assignee}`;
			out.push(pad + line.trimEnd());
			for (const l of rest) out.push(l === "" ? "" : `${pad}  ${l}`);
			for (const p of propertyLines(item.props)) out.push(`${pad}  ${p}`);
			walk(item.children, depth + 1, at);
		});
	};
	walk(items, 0, []);
	return out.join("\n");
}
