/**
 * The three markdown parsers in the repository, each reduced to the same semantic projection
 * (block kind, text, marks, link targets, table cells) so their readings of the dialect's
 * output can be compared:
 * - marked@18 via the dialect parser itself (the reference);
 * - marked@17, the copy `@tiptap/markdown` resolves (SpecMarkdownEditor), default options;
 * - micromark via mdast-util-from-markdown + GFM, what react-markdown + remark-gfm display.
 * The last two are dependencies of dependencies; they are resolved through the packages that
 * use them, so the comparison always runs against the copies the product actually loads.
 *
 * Projection rules that are representation, not meaning:
 * - a newline inside a paragraph is a line break whether a parser calls it soft or hard
 *   (the dialect displays every newline as a hard break);
 * - a GFM bare-URL autolink is text (in the dialect a URL is text; display may linkify it);
 * - a mention or embed is its literal `[[…]]` source text, which is what the other parsers see.
 */
import { dirname } from "node:path";
import { type Body, decodeEntities, type Inline, parseBlock } from "../dialect";

/** Resolves `spec` the way the module at `fromFile` would. */
function resolveFrom(spec: string, fromFile: string): string {
	return Bun.resolveSync(spec, dirname(fromFile));
}

export interface Seg {
	t: string;
	m: string;
}

export type PBlock =
	| { k: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"; inl: Seg[] }
	| { k: "q"; children: PBlock[] }
	| { k: "code"; lang: string; text: string }
	| { k: "table"; align: Array<string | null>; rows: Seg[][][] }
	| { k: "other"; what: string };

interface MarkInfo {
	type: "strong" | "em" | "strike" | "code" | "link";
	href?: string;
	title?: string | null;
}

class SegBuilder {
	segs: Seg[] = [];

	push(text: string, marks: MarkInfo[]) {
		if (!text) return;
		const lines = text.split("\n");
		lines.forEach((line, i) => {
			if (i > 0) this.raw("\n", "");
			this.raw(line, markKey(text, marks));
		});
	}

	br() {
		this.raw("\n", "");
	}

	private raw(t: string, m: string) {
		if (!t) return;
		const last = this.segs[this.segs.length - 1];
		if (last && last.m === m) last.t += t;
		else this.segs.push({ t, m });
	}
}

/** Links whose text is their own target are GFM autolinks: project them as plain text. */
function markKey(text: string, marks: MarkInfo[]): string {
	return marks
		.filter((m) => !(m.type === "link" && isAutolink(text, m.href ?? "")))
		.map((m) => (m.type === "link" ? `link(${m.href ?? ""}|${m.title ?? ""})` : m.type))
		.sort()
		.join(",");
}

function isAutolink(text: string, href: string): boolean {
	return href === text || href === `http://${text}` || href === `mailto:${text}`;
}

function trimSegs(segs: Seg[]): Seg[] {
	// Trailing line breaks and whitespace are never content (the serializer writes none).
	const out = segs.map((s) => ({ ...s }));
	while (out.length && /^[\s]*$/.test((out[out.length - 1] as Seg).t)) out.pop();
	return out;
}

// ---------------------------------------------------------------------------
// marked@18 through the dialect

function dialectInline(content: Inline[]): Seg[] {
	const b = new SegBuilder();
	for (const n of content) {
		if (n.type === "br") b.br();
		else if (n.type === "mention")
			b.push(n.label === null ? `[[${n.ref}]]` : `[[${n.ref}|${n.label}]]`, n.marks);
		else {
			// Link marks are checked for autolinks per text run, like the other parsers' link nodes.
			b.push(n.text, n.marks as MarkInfo[]);
		}
	}
	return trimSegs(b.segs);
}

function dialectBlock(body: Body): PBlock {
	switch (body.type) {
		case "paragraph":
			return { k: "p", inl: dialectInline(body.content) };
		case "heading":
			return { k: `h${body.level}`, inl: dialectInline(body.content) };
		case "quote":
			return {
				k: "q",
				children: body.content.length ? [{ k: "p", inl: dialectInline(body.content) }] : [],
			};
		case "code":
			return { k: "code", lang: body.lang, text: body.text };
		case "table":
			return {
				k: "table",
				align: body.align,
				rows: body.rows.map((r) => r.map((c) => dialectInline(c))),
			};
		case "embed":
			return {
				k: "p",
				inl: [{ t: `![[${body.ref}${body.label === null ? "" : `|${body.label}`}]]`, m: "" }],
			};
	}
}

export function projectDialect(src: string): PBlock[] {
	const p = parseBlock(src);
	const out = [dialectBlock(p.body)];
	if (p.extra.length) out.push({ k: "other", what: `extra:${p.extra.length}` });
	if (src === "") return [];
	return out;
}

// ---------------------------------------------------------------------------
// marked@17 (resolved through @tiptap/markdown, never by a hard-coded path)

interface MarkedToken {
	type: string;
	raw: string;
	text?: string;
	depth?: number;
	lang?: string;
	href?: string;
	title?: string | null;
	tokens?: MarkedToken[];
	header?: Array<{ tokens: MarkedToken[] }>;
	rows?: Array<Array<{ tokens: MarkedToken[] }>>;
	align?: Array<string | null>;
}

interface MarkedLike {
	lexer(src: string): MarkedToken[];
}

const tiptapMarkdownEntry = Bun.resolveSync("@tiptap/markdown", import.meta.dir);
const marked17Module = (await import(resolveFrom("marked", tiptapMarkdownEntry))) as {
	Marked: new (opts?: object) => MarkedLike;
};
/** Version of the marked copy @tiptap/markdown uses (expected 17.x). */
export const marked17Version: string = (
	(await import(resolveFrom("marked/package.json", tiptapMarkdownEntry))) as { version: string }
).version;
const marked17 = new marked17Module.Marked();

function markedInline(tokens: MarkedToken[], marks: MarkInfo[], b: SegBuilder): void {
	for (const t of tokens) {
		switch (t.type) {
			case "text":
				if (t.tokens?.length) markedInline(t.tokens, marks, b);
				else b.push(decodeEntities(t.text ?? ""), marks);
				break;
			case "escape":
				b.push(t.text ?? "", marks);
				break;
			case "strong":
			case "em":
			case "del": {
				const type = t.type === "del" ? "strike" : t.type;
				markedInline(t.tokens ?? [], [...marks, { type }], b);
				break;
			}
			case "codespan":
				b.push(t.text ?? "", [...marks, { type: "code" }]);
				break;
			case "link":
				markedInline(
					t.tokens ?? [],
					[...marks, { type: "link", href: t.href ?? "", title: t.title || null }],
					b,
				);
				break;
			case "br":
				b.br();
				break;
			default:
				b.push(`<${t.type}:${t.raw}>`, marks);
		}
	}
}

function markedSegs(tokens: MarkedToken[]): Seg[] {
	const b = new SegBuilder();
	markedInline(tokens, [], b);
	return trimSegs(b.segs);
}

function markedBlocks(tokens: MarkedToken[]): PBlock[] {
	const out: PBlock[] = [];
	for (const t of tokens) {
		switch (t.type) {
			case "space":
				break;
			case "paragraph":
				out.push({ k: "p", inl: markedSegs(t.tokens ?? []) });
				break;
			case "heading":
				out.push({ k: `h${t.depth}` as "h1", inl: markedSegs(t.tokens ?? []) });
				break;
			case "blockquote":
				out.push({ k: "q", children: markedBlocks(t.tokens ?? []) });
				break;
			case "code":
				out.push({ k: "code", lang: (t.lang ?? "").trim(), text: t.text ?? "" });
				break;
			case "table":
				out.push({
					k: "table",
					align: (t.align ?? []).map((a) => a ?? null),
					rows: [t.header ?? [], ...(t.rows ?? [])].map((r) => r.map((c) => markedSegs(c.tokens))),
				});
				break;
			default:
				out.push({ k: "other", what: t.type });
		}
	}
	return out;
}

export function projectMarked17(src: string): PBlock[] {
	return markedBlocks(marked17.lexer(src));
}

// ---------------------------------------------------------------------------
// micromark (react-markdown + remark-gfm)

interface MdNode {
	type: string;
	value?: string;
	depth?: number;
	lang?: string | null;
	meta?: string | null;
	url?: string;
	title?: string | null;
	align?: Array<string | null> | null;
	children?: MdNode[];
}

function mdInline(nodes: MdNode[], marks: MarkInfo[], b: SegBuilder): void {
	for (const n of nodes) {
		switch (n.type) {
			case "text":
				b.push(n.value ?? "", marks);
				break;
			case "strong":
				mdInline(n.children ?? [], [...marks, { type: "strong" }], b);
				break;
			case "emphasis":
				mdInline(n.children ?? [], [...marks, { type: "em" }], b);
				break;
			case "delete":
				mdInline(n.children ?? [], [...marks, { type: "strike" }], b);
				break;
			case "inlineCode":
				b.push(n.value ?? "", [...marks, { type: "code" }]);
				break;
			case "link":
				mdInline(
					n.children ?? [],
					[...marks, { type: "link", href: n.url ?? "", title: n.title ?? null }],
					b,
				);
				break;
			case "break":
				b.br();
				break;
			default:
				b.push(`<${n.type}:${n.value ?? ""}>`, marks);
		}
	}
}

function mdSegs(nodes: MdNode[]): Seg[] {
	const b = new SegBuilder();
	mdInline(nodes, [], b);
	return trimSegs(b.segs);
}

function mdBlocks(nodes: MdNode[]): PBlock[] {
	const out: PBlock[] = [];
	for (const n of nodes) {
		switch (n.type) {
			case "paragraph":
				out.push({ k: "p", inl: mdSegs(n.children ?? []) });
				break;
			case "heading":
				out.push({ k: `h${n.depth}` as "h1", inl: mdSegs(n.children ?? []) });
				break;
			case "blockquote":
				out.push({ k: "q", children: mdBlocks(n.children ?? []) });
				break;
			case "code": {
				const lang = [n.lang, n.meta].filter((x) => x).join(" ");
				out.push({ k: "code", lang, text: n.value ?? "" });
				break;
			}
			case "table":
				out.push({
					k: "table",
					align: (n.align ?? []).map((a) => a ?? null),
					rows: (n.children ?? []).map((row) =>
						(row.children ?? []).map((cell) => mdSegs(cell.children ?? [])),
					),
				});
				break;
			default:
				out.push({ k: "other", what: n.type });
		}
	}
	return out;
}

const remarkParseEntry = resolveFrom(
	"remark-parse",
	Bun.resolveSync("react-markdown", import.meta.dir),
);
const remarkGfmEntry = Bun.resolveSync("remark-gfm", import.meta.dir);
const { fromMarkdown } = (await import(
	resolveFrom("mdast-util-from-markdown", remarkParseEntry)
)) as {
	fromMarkdown: (
		src: string,
		opts: { extensions: unknown[]; mdastExtensions: unknown[] },
	) => MdNode;
};
const { gfm } = (await import(resolveFrom("micromark-extension-gfm", remarkGfmEntry))) as {
	gfm: () => unknown;
};
const { gfmFromMarkdown } = (await import(resolveFrom("mdast-util-gfm", remarkGfmEntry))) as {
	gfmFromMarkdown: () => unknown;
};

export function projectMicromark(src: string): PBlock[] {
	const tree = fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
	return mdBlocks(tree.children ?? []);
}
