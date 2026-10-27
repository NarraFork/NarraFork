/**
 * The editor schema (design §6.7): `outline > block+`, `block = body children?`.
 * Bodies: paragraph, heading (1–3), code, quote, table, embed (a whole block, D23). Inline: text
 * with marks (strong, em, code, strike, link), `[[…]]` mentions as inline atoms, hard breaks.
 * Every block node carries its block id; the checkbox is the block's `task` attribute, drawn on
 * the block's frame. Ported unchanged from the editor prototype.
 */
import { Schema } from "prosemirror-model";

export const schema = new Schema({
	topNode: "outline",
	nodes: {
		outline: { content: "block+" },
		block: {
			content: "body children?",
			// `hidden`: blocks under it the view leaves out (tasks in the facts view), for a hint.
			attrs: {
				id: { default: null },
				task: { default: null },
				collapsed: { default: false },
				hidden: { default: 0 },
			},
			defining: true,
			toDOM: (n) => ["div", { class: "ob-block", "data-id": n.attrs.id }, 0],
			parseDOM: [
				{
					tag: "div.ob-block",
					getAttrs: (d) => ({ id: (d as HTMLElement).dataset.id ?? null }),
				},
			],
		},
		children: {
			content: "block+",
			toDOM: () => ["div", { class: "ob-children" }, 0],
			parseDOM: [{ tag: "div.ob-children" }],
		},
		paragraph: {
			group: "body",
			content: "inline*",
			toDOM: () => ["p", 0],
			parseDOM: [{ tag: "p" }],
		},
		heading: {
			group: "body",
			content: "(text | mention)*",
			attrs: { level: { default: 1 } },
			defining: true,
			toDOM: (n) => [`h${n.attrs.level}`, 0],
			parseDOM: [1, 2, 3].map((level) => ({ tag: `h${level}`, attrs: { level } })),
		},
		code_block: {
			group: "body",
			content: "text*",
			marks: "",
			code: true,
			attrs: { lang: { default: "" } },
			defining: true,
			toDOM: (n) => ["pre", { "data-lang": n.attrs.lang }, ["code", 0]],
			parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
		},
		quote: {
			group: "body",
			content: "inline*",
			toDOM: () => ["blockquote", 0],
			parseDOM: [{ tag: "blockquote" }],
		},
		table: {
			group: "body",
			content: "table_row+",
			attrs: { align: { default: [] } },
			isolating: true,
			toDOM: () => ["table", ["tbody", 0]],
			parseDOM: [{ tag: "table" }],
		},
		table_row: {
			content: "table_cell+",
			toDOM: () => ["tr", 0],
			parseDOM: [{ tag: "tr" }],
		},
		table_cell: {
			content: "(text | mention)*",
			isolating: true,
			toDOM: () => ["td", 0],
			parseDOM: [{ tag: "td" }, { tag: "th" }],
		},
		embed: {
			group: "body",
			atom: true,
			selectable: true,
			attrs: { ref: { default: "" }, label: { default: null } },
			toDOM: (n) => ["div", { class: "ob-embed", "data-ref": n.attrs.ref }],
			parseDOM: [
				{ tag: "div.ob-embed", getAttrs: (d) => ({ ref: (d as HTMLElement).dataset.ref ?? "" }) },
			],
		},
		text: { group: "inline" },
		hard_break: {
			group: "inline",
			inline: true,
			selectable: false,
			toDOM: () => ["br"],
			parseDOM: [{ tag: "br" }],
		},
		mention: {
			group: "inline",
			inline: true,
			atom: true,
			attrs: { ref: { default: "" }, label: { default: null } },
			toDOM: (n) => [
				"span",
				{ class: "ob-mention", "data-ref": n.attrs.ref },
				n.attrs.label ?? n.attrs.ref,
			],
			parseDOM: [
				{
					tag: "span.ob-mention",
					getAttrs: (d) => ({ ref: (d as HTMLElement).dataset.ref ?? "" }),
				},
			],
		},
	},
	marks: {
		link: {
			attrs: { href: {}, title: { default: null } },
			inclusive: false,
			toDOM: (m) => ["a", { href: m.attrs.href, title: m.attrs.title }, 0],
			parseDOM: [
				{
					tag: "a[href]",
					getAttrs: (d) => ({ href: (d as HTMLElement).getAttribute("href") }),
				},
			],
		},
		strong: { toDOM: () => ["strong", 0], parseDOM: [{ tag: "strong" }, { tag: "b" }] },
		em: { toDOM: () => ["em", 0], parseDOM: [{ tag: "em" }, { tag: "i" }] },
		strike: { toDOM: () => ["s", 0], parseDOM: [{ tag: "s" }, { tag: "del" }] },
		code: { toDOM: () => ["code", 0], parseDOM: [{ tag: "code" }] },
	},
});
