/**
 * Dialect AST ⇄ ProseMirror nodes (ported from the editor prototype). Both sides count offsets
 * the same way (`shared/outline/dialect/types.ts`), so the dialect's source maps translate
 * editor positions directly.
 */
import {
	type Body,
	type Inline,
	type Mark,
	type OutlineItem,
	parseBlock,
	type SourceMap,
	serializeBody,
} from "@shared/outline";
import {
	LIVE_STATUS_OF_TASK,
	LIVE_TASK_OF_STATUS,
	type LiveTaskChar,
} from "@shared/outline-live-protocol";
import { Fragment, type Mark as PMMark, type Node as PMNode } from "prosemirror-model";
import { schema } from "./schema";

function pmMarks(marks: Mark[]): PMMark[] {
	return marks.map((m) =>
		m.type === "link"
			? schema.marks.link.create({ href: m.href ?? "", title: m.title ?? null })
			: schema.marks[m.type].create(),
	);
}

function inlineToPM(content: Inline[]): PMNode[] {
	const out: PMNode[] = [];
	for (const n of content) {
		if (n.type === "text") {
			if (n.text) out.push(schema.text(n.text, pmMarks(n.marks)));
		} else if (n.type === "mention") {
			out.push(schema.nodes.mention.create({ ref: n.ref, label: n.label }, null, pmMarks(n.marks)));
		} else out.push(schema.nodes.hard_break.create());
	}
	return out;
}

export function bodyToPM(body: Body): PMNode {
	switch (body.type) {
		case "paragraph":
			return schema.nodes.paragraph.create(null, inlineToPM(body.content));
		case "heading":
			return schema.nodes.heading.create({ level: body.level }, inlineToPM(body.content));
		case "quote":
			return schema.nodes.quote.create(null, inlineToPM(body.content));
		case "code":
			return schema.nodes.code_block.create(
				{ lang: body.lang },
				body.text ? schema.text(body.text) : null,
			);
		case "embed":
			return schema.nodes.embed.create({ ref: body.ref, label: body.label });
		case "table": {
			const rows = body.rows.map((r) =>
				schema.nodes.table_row.create(
					null,
					(r.length ? r : [[]]).map((c) => schema.nodes.table_cell.create(null, inlineToPM(c))),
				),
			);
			return schema.nodes.table.create(
				{ align: body.align },
				rows.length
					? rows
					: [schema.nodes.table_row.create(null, schema.nodes.table_cell.create())],
			);
		}
	}
}

function markOf(m: PMMark): Mark {
	if (m.type.name === "link") return { type: "link", href: m.attrs.href, title: m.attrs.title };
	return { type: m.type.name as Mark["type"] };
}

export function inlineFromPM(frag: Fragment): Inline[] {
	const out: Inline[] = [];
	frag.forEach((n) => {
		if (n.isText) out.push({ type: "text", text: n.text ?? "", marks: n.marks.map(markOf) });
		else if (n.type.name === "mention")
			out.push({
				type: "mention",
				ref: n.attrs.ref,
				label: n.attrs.label,
				marks: n.marks.map(markOf),
			});
		else if (n.type.name === "hard_break") out.push({ type: "br" });
	});
	return out;
}

export function bodyFromPM(n: PMNode): Body {
	switch (n.type.name) {
		case "heading":
			return { type: "heading", level: n.attrs.level, content: inlineFromPM(n.content) };
		case "quote":
			return { type: "quote", content: inlineFromPM(n.content) };
		case "code_block":
			return { type: "code", lang: n.attrs.lang, text: n.textContent };
		case "embed":
			return { type: "embed", ref: n.attrs.ref, label: n.attrs.label };
		case "table": {
			const rows: Inline[][][] = [];
			n.forEach((row) => {
				const cells: Inline[][] = [];
				row.forEach((cell) => {
					cells.push(inlineFromPM(cell.content));
				});
				rows.push(cells);
			});
			return { type: "table", align: n.attrs.align ?? [], rows };
		}
		default:
			return { type: "paragraph", content: inlineFromPM(n.content) };
	}
}

/** A block body node as the canonical markdown the block stores. */
export function serializePM(body: PMNode): string {
	return serializeBody(bodyFromPM(body));
}

export interface ParsedPM {
	node: PMNode;
	map: SourceMap;
}

const PARSE_CACHE_LIMIT = 20_000;
const parseCache = new Map<string, ParsedPM>();

/** A block's source as a body node with its source map. Nodes are immutable: cached by source. */
export function parseToPM(src: string): ParsedPM {
	const hit = parseCache.get(src);
	if (hit) return hit;
	const p = parseBlock(src);
	const r = { node: bodyToPM(p.body), map: p.map };
	if (parseCache.size > PARSE_CACHE_LIMIT) parseCache.clear();
	parseCache.set(src, r);
	return r;
}

/** Outline items (a pasted markdown outline, HTML turned into one) as new block nodes. */
export function outlineToPM(items: readonly OutlineItem[], newId: () => string): PMNode[] {
	return items.map((item) => {
		const body = parseToPM(item.content).node;
		const kids = outlineToPM(item.children, newId);
		const task: LiveTaskChar | null = item.task ? LIVE_TASK_OF_STATUS[item.task.status] : null;
		return schema.nodes.block.create(
			{ id: newId(), task },
			kids.length ? [body, schema.nodes.children.create(null, kids)] : [body],
		);
	});
}

function item(body: Body, task: LiveTaskChar | null, children: OutlineItem[]): OutlineItem {
	return {
		content: serializeBody(body),
		task: task ? { status: LIVE_STATUS_OF_TASK[task], assignee: null } : null,
		props: {},
		children,
	};
}

/** A (possibly half-open) editor fragment as outline items, for copying. */
export function fragmentToOutline(frag: Fragment): OutlineItem[] {
	const out: OutlineItem[] = [];
	let inline: PMNode[] = [];
	const flushInline = () => {
		if (inline.length) {
			out.push(item({ type: "paragraph", content: inlineFromPM(Fragment.from(inline)) }, null, []));
			inline = [];
		}
	};
	frag.forEach((n) => {
		if (n.isInline) {
			inline.push(n);
			return;
		}
		flushInline();
		if (n.type.name === "block") {
			const first = n.firstChild;
			const hasBody = first && first.type.name !== "children";
			const kidsNode = hasBody ? (n.childCount > 1 ? n.child(1) : null) : first;
			out.push(
				item(
					hasBody && first ? bodyFromPM(first) : { type: "paragraph", content: [] },
					n.attrs.task,
					kidsNode ? fragmentToOutline(kidsNode.content) : [],
				),
			);
		} else if (n.type.name === "children" || n.type.name === "outline") {
			out.push(...fragmentToOutline(n.content));
		} else if (n.type.name === "table_row" || n.type.name === "table_cell") {
			out.push(
				item({ type: "paragraph", content: inlineFromPM(Fragment.from(n.content)) }, null, []),
			);
		} else {
			out.push(item(bodyFromPM(n), null, []));
		}
	});
	flushInline();
	return out;
}
