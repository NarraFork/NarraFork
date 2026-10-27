/**
 * Pasting HTML from a web page or a word processor: block-level structure becomes blocks (list
 * items with their nesting, paragraphs, headings, code, quotes, tables), inline formatting the
 * dialect knows is kept (bold, italic, code, strike-through, links, line breaks; also the
 * inline `font-weight` / `font-style` / `text-decoration` styles word processors use), anything
 * else becomes its text. Images become their alt text; scripts, styles and comments go.
 *
 * Contents are built as dialect ASTs and serialized with the dialect's own serializer, so
 * escaping is the dialect's and every block is canonical. Bounded: HTML over
 * {@link HTML_PASTE_LIMITS.maxBytes} or with more than {@link HTML_PASTE_LIMITS.maxBlocks} blocks
 * is not converted (the paste falls back to its plain text).
 */
import {
	type Align,
	type Body,
	type HeadingLevel,
	type Inline,
	type Mark,
	type OutlineItem,
	serializeBody,
	type TaskStatus,
} from "@shared/outline";

export const HTML_PASTE_LIMITS = {
	maxBytes: 1024 * 1024,
	maxBlocks: 2000,
	maxDepth: 40,
} as const;

/** Whether clipboard HTML came from this editor (ProseMirror marks its slices). */
export function isOwnClipboardHtml(html: string): boolean {
	return /data-pm-slice=/.test(html.slice(0, 2000));
}

const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD", "META", "LINK", "TITLE"]);
const BLOCKS = new Set([
	"P",
	"DIV",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"UL",
	"OL",
	"LI",
	"PRE",
	"BLOCKQUOTE",
	"TABLE",
	"SECTION",
	"ARTICLE",
	"HEADER",
	"FOOTER",
	"MAIN",
	"ASIDE",
	"NAV",
	"FIGURE",
	"FIGCAPTION",
	"DL",
	"DT",
	"DD",
	"HR",
	"BODY",
]);

interface Builder {
	items: OutlineItem[];
	count: number;
	overflow: boolean;
}

function marksOf(el: Element, inherited: Mark[]): Mark[] {
	const marks = [...inherited];
	const add = (m: Mark) => {
		if (!marks.some((x) => x.type === m.type)) marks.push(m);
	};
	const tag = el.tagName;
	if (tag === "STRONG" || tag === "B") add({ type: "strong" });
	if (tag === "EM" || tag === "I") add({ type: "em" });
	if (tag === "CODE" || tag === "KBD" || tag === "SAMP") add({ type: "code" });
	if (tag === "S" || tag === "DEL" || tag === "STRIKE") add({ type: "strike" });
	if (tag === "A") {
		const href = el.getAttribute("href");
		if (href && !/^\s*javascript:/i.test(href))
			add({ type: "link", href, title: el.getAttribute("title") });
	}
	const style = (el as HTMLElement).style;
	if (style) {
		const weight = style.fontWeight;
		if (weight === "bold" || weight === "bolder" || Number(weight) >= 600) add({ type: "strong" });
		if (style.fontStyle === "italic") add({ type: "em" });
		if (/line-through/.test(style.textDecoration || style.textDecorationLine || ""))
			add({ type: "strike" });
	}
	// A link carries no code mark in the dialect; a code span carries no other marks.
	if (marks.some((m) => m.type === "code")) return marks.filter((m) => m.type === "code");
	return marks;
}

/** Inline content of an element (block children are not descended into). */
function inlineOf(el: Node, marks: Mark[], out: Inline[], depth = 0): void {
	if (depth > HTML_PASTE_LIMITS.maxDepth) return;
	for (const child of Array.from(el.childNodes)) {
		if (child.nodeType === 3) {
			const text = (child.textContent ?? "").replace(/[\t\n\r ]+/g, " ");
			if (text) out.push({ type: "text", text, marks });
			continue;
		}
		if (child.nodeType !== 1) continue;
		const e = child as Element;
		if (SKIP.has(e.tagName)) continue;
		if (e.tagName === "BR") {
			out.push({ type: "br" });
			continue;
		}
		if (e.tagName === "IMG") {
			const alt = e.getAttribute("alt");
			if (alt) out.push({ type: "text", text: alt, marks });
			continue;
		}
		if (e.tagName === "INPUT") continue;
		if (BLOCKS.has(e.tagName)) continue;
		inlineOf(e, marksOf(e, marks), out, depth + 1);
	}
}

function trimInline(content: Inline[]): Inline[] {
	const out = content.filter(
		(n, i, all) => !(n.type === "br" && (i === 0 || i === all.length - 1)),
	);
	const first = out[0];
	if (first?.type === "text") first.text = first.text.replace(/^ +/, "");
	const last = out[out.length - 1];
	if (last?.type === "text") last.text = last.text.replace(/ +$/, "");
	return out.filter((n) => n.type !== "text" || n.text.length > 0);
}

function push(
	b: Builder,
	list: OutlineItem[],
	body: Body,
	task: TaskStatus | null = null,
): OutlineItem | null {
	if (b.count >= HTML_PASTE_LIMITS.maxBlocks) {
		b.overflow = true;
		return null;
	}
	b.count++;
	const item: OutlineItem = {
		content: serializeBody(body),
		task: task ? { status: task, assignee: null } : null,
		props: {},
		children: [],
	};
	list.push(item);
	return item;
}

function hasBlockChild(el: Element): boolean {
	return Array.from(el.children).some((c) => BLOCKS.has(c.tagName));
}

function headingLevel(tag: string): HeadingLevel | null {
	if (tag === "H1") return 1;
	if (tag === "H2") return 2;
	if (tag === "H3") return 3;
	return null;
}

function tableBody(el: Element): Body {
	const rows: Inline[][][] = [];
	const align: Align[] = [];
	for (const tr of Array.from(el.querySelectorAll("tr"))) {
		const cells: Inline[][] = [];
		Array.from(tr.children).forEach((cell, i) => {
			if (cell.tagName !== "TD" && cell.tagName !== "TH") return;
			const content: Inline[] = [];
			inlineOf(cell, [], content);
			cells.push(
				trimInline(content).map((n) =>
					n.type === "br" ? { type: "text", text: " ", marks: [] } : n,
				),
			);
			if (rows.length === 0) {
				const a = (cell as HTMLElement).style?.textAlign || cell.getAttribute("align") || "";
				align[i] = a === "center" || a === "right" || a === "left" ? a : null;
			}
		});
		if (cells.length) rows.push(cells);
	}
	return { type: "table", align, rows };
}

/** Walk block-level content into `list`. */
function blocks(b: Builder, el: Element, list: OutlineItem[], depth: number): void {
	if (depth > HTML_PASTE_LIMITS.maxDepth || b.overflow) return;
	let run: Inline[] = [];
	const flush = () => {
		const content = trimInline(run);
		run = [];
		if (content.length) push(b, list, { type: "paragraph", content });
	};
	for (const child of Array.from(el.childNodes)) {
		if (b.overflow) return;
		if (child.nodeType === 3) {
			const text = (child.textContent ?? "").replace(/[\t\n\r ]+/g, " ");
			if (text.trim()) run.push({ type: "text", text, marks: [] });
			continue;
		}
		if (child.nodeType !== 1) continue;
		const e = child as Element;
		if (SKIP.has(e.tagName)) continue;
		if (!BLOCKS.has(e.tagName)) {
			const wrapper: Inline[] = [];
			if (e.tagName === "BR") wrapper.push({ type: "br" });
			else if (e.tagName === "IMG") {
				const alt = e.getAttribute("alt");
				if (alt) wrapper.push({ type: "text", text: alt, marks: [] });
			} else inlineOf(e, marksOf(e, []), wrapper, depth);
			run.push(...wrapper);
			continue;
		}
		flush();
		const tag = e.tagName;
		if (tag === "HR") continue;
		if (tag === "UL" || tag === "OL") {
			for (const li of Array.from(e.children)) {
				if (li.tagName === "LI") listItem(b, li, list, depth + 1);
				else blocks(b, li, list, depth + 1);
			}
			continue;
		}
		if (tag === "LI") {
			listItem(b, e, list, depth + 1);
			continue;
		}
		const level = headingLevel(tag);
		if (level) {
			const content: Inline[] = [];
			inlineOf(e, [], content);
			const clean = trimInline(content).map((n) =>
				n.type === "br" ? { type: "text" as const, text: " ", marks: [] } : n,
			);
			if (clean.length) push(b, list, { type: "heading", level, content: clean });
			continue;
		}
		if (tag === "H4" || tag === "H5" || tag === "H6") {
			const content: Inline[] = [];
			inlineOf(e, [{ type: "strong" }], content);
			const clean = trimInline(content);
			if (clean.length) push(b, list, { type: "paragraph", content: clean });
			continue;
		}
		if (tag === "PRE") {
			const code = e.querySelector("code");
			const lang = /language-([\w+-]+)/.exec(code?.className ?? e.className)?.[1] ?? "";
			const text = (e.textContent ?? "").replace(/\r\n?/g, "\n").replace(/\n$/, "");
			if (text) push(b, list, { type: "code", lang, text });
			continue;
		}
		if (tag === "BLOCKQUOTE") {
			quote(b, e, list, depth + 1);
			continue;
		}
		if (tag === "TABLE") {
			const body = tableBody(e);
			if (body.type === "table" && body.rows.length) push(b, list, body);
			continue;
		}
		if (hasBlockChild(e)) blocks(b, e, list, depth + 1);
		else {
			const content: Inline[] = [];
			inlineOf(e, [], content);
			const clean = trimInline(content);
			if (clean.length) push(b, list, { type: "paragraph", content: clean });
		}
	}
	flush();
}

/** A quote: each paragraph of it a quote block; lists and the like inside it as they come. */
function quote(b: Builder, el: Element, list: OutlineItem[], depth: number): void {
	let run: Inline[] = [];
	const flush = () => {
		const content = trimInline(run);
		run = [];
		if (content.length) push(b, list, { type: "quote", content });
	};
	for (const child of Array.from(el.childNodes)) {
		if (child.nodeType === 1 && BLOCKS.has((child as Element).tagName)) {
			flush();
			const e = child as Element;
			if ((e.tagName === "P" || e.tagName === "DIV") && !hasBlockChild(e)) {
				inlineOf(e, [], run);
				flush();
			} else if (e.tagName === "BLOCKQUOTE") quote(b, e, list, depth + 1);
			else {
				const holder = document.createElement("div");
				holder.append(e.cloneNode(true));
				blocks(b, holder, list, depth + 1);
			}
		} else if (child.nodeType === 3) {
			const text = (child.textContent ?? "").replace(/[\t\n\r ]+/g, " ");
			if (text) run.push({ type: "text", text, marks: [] });
		} else if (child.nodeType === 1) {
			const e = child as Element;
			if (e.tagName === "BR") run.push({ type: "br" });
			else if (!SKIP.has(e.tagName)) inlineOf(e, marksOf(e, []), run, depth);
		}
	}
	flush();
}

function listItem(b: Builder, li: Element, list: OutlineItem[], depth: number): void {
	const box = li.querySelector(":scope > input[type=checkbox], :scope > p > input[type=checkbox]");
	const task: TaskStatus | null = box
		? (box as HTMLInputElement).checked
			? "done"
			: "todo"
		: null;
	const own: Inline[] = [];
	const nested: Element[] = [];
	for (const child of Array.from(li.childNodes)) {
		if (child.nodeType === 1 && BLOCKS.has((child as Element).tagName)) {
			const tag = (child as Element).tagName;
			if ((tag === "P" || tag === "DIV") && own.length === 0 && !hasBlockChild(child as Element)) {
				inlineOf(child, [], own);
				continue;
			}
			nested.push(child as Element);
			continue;
		}
		if (child.nodeType === 3) {
			const text = (child.textContent ?? "").replace(/[\t\n\r ]+/g, " ");
			if (text) own.push({ type: "text", text, marks: [] });
		} else if (child.nodeType === 1) {
			const e = child as Element;
			if (SKIP.has(e.tagName) || e.tagName === "INPUT") continue;
			if (e.tagName === "BR") own.push({ type: "br" });
			else inlineOf(e, marksOf(e, []), own, depth);
		}
	}
	const item = push(b, list, { type: "paragraph", content: trimInline(own) }, task);
	if (!item) return;
	const holder = document.createElement("div");
	for (const n of nested) holder.append(n.cloneNode(true));
	blocks(b, holder, item.children, depth + 1);
}

/**
 * HTML as outline items, or null when it is too large or holds nothing worth converting (the
 * caller pastes the plain text then).
 */
export function htmlToOutline(html: string): OutlineItem[] | null {
	if (html.length > HTML_PASTE_LIMITS.maxBytes) return null;
	const doc = new DOMParser().parseFromString(html, "text/html");
	const b: Builder = { items: [], count: 0, overflow: false };
	blocks(b, doc.body, b.items, 0);
	if (b.overflow || b.items.length === 0) return null;
	return b.items;
}
