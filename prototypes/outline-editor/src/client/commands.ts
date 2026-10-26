/**
 * 大纲键位（§6.7）：Enter 拆块，块首 Backspace 合并，Delete 合并下一块，Tab / Shift-Tab 缩进，
 * Alt+↑↓ 移动。全部写成 ProseMirror 事务（对编辑器文档做变换），再由 reconcile 翻译成大纲事务。
 */
import { Fragment, type Node as PMNode, type ResolvedPos } from "prosemirror-model";
import {
	type Command,
	type EditorState,
	NodeSelection,
	TextSelection,
	type Transaction,
} from "prosemirror-state";
import type { SelPoint } from "./client";
import { schema } from "./schema";

const N = schema.nodes;

export interface CmdHost {
	surfaceKind: "page" | "embed" | "stitch" | "node";
	newId(): string;
	locate(doc: PMNode, pos: number): SelPoint | null;
	pointToPos(doc: PMNode, p: SelPoint): number | null;
}

export function blockDepth($pos: ResolvedPos): number {
	for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type === N.block) return d;
	return -1;
}

export function newBlock(host: CmdHost, body?: PMNode, kids?: PMNode[]): PMNode {
	const b = body ?? N.paragraph.create();
	return N.block.create(
		{ id: host.newId() },
		kids?.length ? [b, N.children.create(null, kids)] : [b],
	);
}

function blockIds(frag: Fragment): string[] {
	const out: string[] = [];
	frag.descendants((n) => {
		if (n.type === N.block && n.attrs.id) out.push(n.attrs.id);
		return n.type === N.block || n.type === N.children;
	});
	return out;
}

function restore(host: CmdHost, tr: Transaction, a: SelPoint | null, h: SelPoint | null) {
	if (!a || !h) return;
	const pa = host.pointToPos(tr.doc, a);
	const ph = host.pointToPos(tr.doc, h);
	if (pa == null || ph == null) return;
	tr.setSelection(TextSelection.between(tr.doc.resolve(pa), tr.doc.resolve(ph)));
}

export function splitBlock(host: CmdHost): Command {
	return (state, dispatch) => {
		const tr = state.tr;
		if (state.selection instanceof NodeSelection && state.selection.node.type === N.embed) {
			const $ = state.selection.$from;
			const d = blockDepth($);
			if (d < 0) return false;
			const pos = $.before(d) + $.node(d).nodeSize;
			const nb = newBlock(host);
			tr.insert(pos, nb);
			tr.setSelection(TextSelection.create(tr.doc, pos + 2));
			dispatch?.(tr.scrollIntoView());
			return true;
		}
		if (!state.selection.empty) tr.deleteSelection();
		const $from = tr.selection.$from;
		const d = blockDepth($from);
		if (d < 0) return false;
		const blockNode = $from.node(d);
		const blockPos = $from.before(d);
		const body = blockNode.child(0);
		if ($from.parent !== body) return true; // 表格单元格里：不拆
		if (body.type === N.code_block) {
			dispatch?.(tr.insertText("\n"));
			return true;
		}
		const bodyStart = blockPos + 2;
		const off = $from.pos - bodyStart;
		const size = body.content.size;
		const embedRoot = d === 1 && host.surfaceKind === "embed";
		if (off === 0 && size > 0 && !embedRoot) {
			// 块首回车：在前面插一个空块，id 留给原来的文字
			tr.insert(blockPos, newBlock(host));
			dispatch?.(tr.scrollIntoView());
			return true;
		}
		const after = body.content.cut(off);
		if (off < size) tr.delete(bodyStart + off, bodyStart + size);
		const type = off === size || body.type === N.heading ? N.paragraph : body.type;
		const newBody = type === N.heading ? type.create(body.attrs, after) : type.create(null, after);
		const hasKids = blockNode.childCount > 1;
		const collapsed = blockNode.attrs.collapsed;
		let selPos: number;
		if ((hasKids && !collapsed) || embedRoot) {
			if (hasKids) {
				const kidsStart = tr.mapping.map(blockPos + 1 + body.nodeSize + 1);
				tr.insert(kidsStart, newBlock(host, newBody));
				selPos = kidsStart + 2;
			} else {
				const bodyEnd = tr.mapping.map(blockPos + 1 + body.nodeSize);
				tr.insert(bodyEnd, N.children.create(null, newBlock(host, newBody)));
				selPos = bodyEnd + 3;
			}
		} else {
			const pos = tr.mapping.map(blockPos + blockNode.nodeSize);
			tr.insert(pos, newBlock(host, newBody));
			selPos = pos + 2;
		}
		tr.setSelection(TextSelection.create(tr.doc, selPos));
		dispatch?.(tr.scrollIntoView());
		return true;
	};
}

function inlineFor(target: PMNode, src: PMNode): Fragment {
	if (target.type === N.code_block)
		return src.textContent ? Fragment.from(schema.text(src.textContent)) : Fragment.empty;
	if (src.type === N.code_block)
		return src.textContent
			? Fragment.from(schema.text(src.textContent.replace(/\n/g, " ")))
			: Fragment.empty;
	if (target.type === N.heading) {
		const nodes: PMNode[] = [];
		src.content.forEach((n) => {
			if (n.type === N.hard_break) nodes.push(schema.text(" "));
			else nodes.push(n);
		});
		return Fragment.from(nodes);
	}
	return src.content;
}

/** 块首 Backspace：标题 / 引用先变段落；段落并入文档顺序里的上一块，子块跟过去。 */
export function joinBackward(_host: CmdHost): Command {
	return (state, dispatch) => {
		const sel = state.selection;
		if (!sel.empty) return false;
		const $from = sel.$from;
		const d = blockDepth($from);
		if (d < 0) return false;
		const blockNode = $from.node(d);
		const blockPos = $from.before(d);
		const body = blockNode.child(0);
		if ($from.parent !== body || $from.parentOffset !== 0) return false;
		if (body.type === N.heading || body.type === N.quote) {
			dispatch?.(state.tr.setNodeMarkup(blockPos + 1, N.paragraph));
			return true;
		}
		if (body.type === N.code_block) {
			if (body.content.size === 0) dispatch?.(state.tr.setNodeMarkup(blockPos + 1, N.paragraph));
			return true;
		}
		const parent = $from.node(d - 1);
		const index = $from.index(d - 1);
		let tNode: PMNode;
		let tPos: number;
		let targetIsParent = false;
		if (index > 0) {
			tNode = parent.child(index - 1);
			tPos = blockPos - tNode.nodeSize;
			while (tNode.childCount > 1 && !tNode.attrs.collapsed) {
				const kids = tNode.child(1);
				const last = kids.lastChild as PMNode;
				tPos = tPos + 1 + tNode.child(0).nodeSize + 1 + (kids.content.size - last.nodeSize);
				tNode = last;
			}
		} else if (d > 1) {
			tNode = $from.node(d - 2);
			tPos = $from.before(d - 2);
			targetIsParent = true;
		} else return true;
		const tBody = tNode.child(0);
		const tr = state.tr;
		const kids = blockNode.childCount > 1 ? blockNode.child(1).content : Fragment.empty;
		// 上一块是空段落：删掉空块，而不是把有内容的块并进去（保住有内容的块的 id，指向它的链接不断）
		if (
			!targetIsParent &&
			tBody.type === N.paragraph &&
			tBody.content.size === 0 &&
			tNode.childCount === 1
		) {
			const $t = state.doc.resolve(tPos);
			if ($t.parent.type === N.children && $t.parent.childCount === 1)
				tr.delete($t.before(), $t.after());
			else tr.delete(tPos, tPos + tNode.nodeSize);
			tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(blockPos) + 2));
			dispatch?.(tr.scrollIntoView());
			return true;
		}
		if (tBody.type === N.embed || tBody.type === N.table) {
			if (body.content.size === 0 && kids.size === 0) {
				if (parent.childCount === 1 && d > 1) tr.delete($from.before(d - 1), $from.after(d - 1));
				else tr.delete(blockPos, blockPos + blockNode.nodeSize);
				tr.setSelection(NodeSelection.create(tr.doc, tr.mapping.map(tPos + 1)));
				dispatch?.(tr);
			}
			return true;
		}
		const tBodyEnd = tPos + 1 + tBody.nodeSize - 1;
		const content = inlineFor(tBody, body);
		tr.insert(tBodyEnd, content);
		const bp = tr.mapping.map(blockPos);
		if (targetIsParent) {
			if (kids.size === 0 && parent.childCount === 1) {
				const cp = tr.mapping.map($from.before(d - 1));
				tr.delete(cp, cp + parent.nodeSize);
			} else {
				tr.replaceWith(bp, bp + blockNode.nodeSize, kids);
			}
		} else {
			tr.delete(bp, bp + blockNode.nodeSize);
			if (kids.size) {
				const t = tr.doc.nodeAt(tPos) as PMNode;
				if (t.childCount > 1) tr.insert(tPos + t.nodeSize - 2, kids);
				else tr.insert(tPos + 1 + t.child(0).nodeSize, N.children.create(null, kids));
			}
		}
		tr.setSelection(TextSelection.create(tr.doc, tBodyEnd));
		tr.setMeta("moved", new Set(blockIds(kids)));
		dispatch?.(tr.scrollIntoView());
		return true;
	};
}

/** 块尾 Delete：把文档顺序里的下一块并进来。 */
export function joinForward(host: CmdHost): Command {
	return (state, dispatch) => {
		const sel = state.selection;
		if (!sel.empty) return false;
		const $from = sel.$from;
		const d = blockDepth($from);
		if (d < 0) return false;
		const body = $from.node(d).child(0);
		if ($from.parent !== body || $from.parentOffset !== body.content.size) return false;
		if (body.type === N.code_block) return false;
		// 当前块是空的且没有子块：删掉它，光标去下一块开头（保住下一块的 id）
		if (body.type === N.paragraph && body.content.size === 0 && $from.node(d).childCount === 1) {
			const bp = $from.before(d);
			const parent = $from.node(d - 1);
			if (bp + $from.node(d).nodeSize >= state.doc.content.size && d === 1) return true;
			const tr = state.tr;
			if (parent.type === N.children && parent.childCount === 1)
				tr.delete($from.before(d - 1), $from.after(d - 1));
			else tr.delete(bp, bp + $from.node(d).nodeSize);
			const $n = tr.doc.resolve(Math.min(tr.mapping.map(bp), tr.doc.content.size));
			dispatch?.(tr.setSelection(TextSelection.near($n, 1)).scrollIntoView());
			return true;
		}
		// 下一块的块体起点
		let next: number | null = null;
		state.doc.nodesBetween($from.pos, state.doc.content.size, (n, pos) => {
			if (next !== null) return false;
			if (n.type === N.block && pos > $from.before(d)) {
				next = pos + 2;
				return false;
			}
			return true;
		});
		if (next === null) return true;
		const sub = state.apply(state.tr.setSelection(TextSelection.create(state.doc, next)));
		return joinBackward(host)(sub, (tr) => {
			// 在原 state 上重放这些步骤
			const real = state.tr;
			for (const step of tr.steps) real.step(step);
			real.setSelection(TextSelection.create(real.doc, tr.selection.from));
			real.setMeta("moved", tr.getMeta("moved"));
			dispatch?.(real);
		});
	};
}

function siblingRange(state: EditorState) {
	const { $from, $to } = state.selection;
	return $from.blockRange($to, (n) => n.type === N.children || n.type === N.outline);
}

function capture(host: CmdHost, state: EditorState) {
	return {
		a: host.locate(state.doc, state.selection.anchor),
		h: host.locate(state.doc, state.selection.head),
	};
}

export function indent(host: CmdHost): Command {
	return (state, dispatch) => {
		const range = siblingRange(state);
		if (!range) return false;
		if (range.startIndex === 0) return true;
		const top = range.depth === 0;
		if (top && host.surfaceKind !== "page") return true; // 拼接 / 嵌入的根：不跨页
		const prev = range.parent.child(range.startIndex - 1);
		const prevPos = range.start - prev.nodeSize;
		const moved = range.parent.content.cut(
			range.start - range.$from.start(range.depth),
			range.end - range.$from.start(range.depth),
		);
		const { a, h } = capture(host, state);
		const tr = state.tr.delete(range.start, range.end);
		const p = tr.doc.nodeAt(prevPos) as PMNode;
		if (p.childCount > 1) tr.insert(prevPos + p.nodeSize - 2, moved);
		else tr.insert(prevPos + p.nodeSize - 1, N.children.create(null, moved));
		restore(host, tr, a, h);
		tr.setMeta("moved", new Set(blockIds(moved)));
		dispatch?.(tr.scrollIntoView());
		return true;
	};
}

export function outdent(host: CmdHost): Command {
	return (state, dispatch) => {
		const range = siblingRange(state);
		if (!range) return false;
		if (range.depth === 0) return true;
		const parentDepth = range.depth - 1;
		if (parentDepth === 1 && host.surfaceKind === "embed") return true;
		const parentNode = range.$from.node(parentDepth);
		const parentPos = range.$from.before(parentDepth);
		const kidsNode = range.parent;
		const moved = kidsNode.content.cut(
			range.start - range.$from.start(range.depth),
			range.end - range.$from.start(range.depth),
		);
		const { a, h } = capture(host, state);
		const tr = state.tr;
		if (range.startIndex === 0 && range.endIndex === kidsNode.childCount) {
			const cp = range.$from.before(range.depth);
			tr.delete(cp, cp + kidsNode.nodeSize);
		} else tr.delete(range.start, range.end);
		tr.insert(tr.mapping.map(parentPos + parentNode.nodeSize), moved);
		restore(host, tr, a, h);
		tr.setMeta("moved", new Set(blockIds(moved)));
		dispatch?.(tr.scrollIntoView());
		return true;
	};
}

export function moveBlock(host: CmdHost, dir: -1 | 1): Command {
	return (state, dispatch) => {
		const range = siblingRange(state);
		if (!range) return false;
		const moved = range.parent.content.cut(
			range.start - range.$from.start(range.depth),
			range.end - range.$from.start(range.depth),
		);
		const { a, h } = capture(host, state);
		const tr = state.tr;
		if (dir < 0) {
			if (range.startIndex === 0) return true;
			const prev = range.parent.child(range.startIndex - 1);
			const prevPos = range.start - prev.nodeSize;
			tr.delete(range.start, range.end);
			tr.insert(prevPos, moved);
		} else {
			if (range.endIndex >= range.parent.childCount) return true;
			const next = range.parent.child(range.endIndex);
			tr.insert(range.end + next.nodeSize, moved);
			tr.delete(range.start, range.end);
		}
		restore(host, tr, a, h);
		tr.setMeta("moved", new Set(blockIds(moved)));
		dispatch?.(tr.scrollIntoView());
		return true;
	};
}

export function hardBreak(): Command {
	return (state, dispatch) => {
		const { $from } = state.selection;
		const p = $from.parent;
		if (p.type === N.code_block) {
			dispatch?.(state.tr.insertText("\n"));
			return true;
		}
		if (p.type !== N.paragraph && p.type !== N.quote) return true;
		// 块里不能有空行：前面已经是换行就不再加
		if ($from.parentOffset === 0 || $from.nodeBefore?.type === N.hard_break) return true;
		dispatch?.(state.tr.replaceSelectionWith(N.hard_break.create()).scrollIntoView());
		return true;
	};
}

export function toggleTask(): Command {
	return (state, dispatch) => {
		const d = blockDepth(state.selection.$from);
		if (d < 0) return false;
		const pos = state.selection.$from.before(d);
		const cur = state.selection.$from.node(d).attrs.task;
		dispatch?.(state.tr.setNodeAttribute(pos, "task", cur ? null : " "));
		return true;
	};
}

// ---------- 导图键位（§6.10）：同样是对编辑面文档的 ProseMirror 事务，经 reconcile 变成大纲事务 ----------

/** 块在文档里的位置（只走块和子块容器）。 */
export function blockPos(doc: PMNode, id: string): number | null {
	let found: number | null = null;
	doc.descendants((n, pos) => {
		if (found !== null) return false;
		if (n.type === N.block) {
			if (n.attrs.id === id) {
				found = pos;
				return false;
			}
			return true;
		}
		return n.type === N.children;
	});
	return found;
}

/** 块体里的一个合法光标位置：offset < 0 表示块体末尾。 */
export function caretIn(doc: PMNode, pos: number, offset = -1): TextSelection | NodeSelection {
	const block = doc.nodeAt(pos) as PMNode;
	const body = block.child(0);
	if (body.type === N.embed) return NodeSelection.create(doc, pos + 1);
	if (!body.isTextblock) return TextSelection.near(doc.resolve(pos + 2)) as TextSelection;
	const off = offset < 0 ? body.content.size : Math.min(offset, body.content.size);
	return TextSelection.create(doc, pos + 2 + off);
}

/** 导图 Tab：在当前块的子块末尾加一个空块，光标进新块。 */
export function addChild(host: CmdHost): Command {
	return (state, dispatch) => {
		const $ = state.selection.$from;
		const d = blockDepth($);
		if (d < 0) return false;
		const pos = $.before(d);
		const node = $.node(d);
		const nb = newBlock(host);
		const tr = state.tr;
		let at: number;
		if (node.childCount > 1) {
			at = pos + node.nodeSize - 2;
			tr.insert(at, nb);
		} else {
			at = pos + 1 + node.child(0).nodeSize;
			tr.insert(at, N.children.create(null, nb));
			at += 1;
		}
		tr.setSelection(TextSelection.create(tr.doc, at + 2));
		dispatch?.(tr.scrollIntoView());
		return true;
	};
}

/** 导图里选中节点按 Enter：在当前块（连同子树）后面加一个同级空块，光标进新块。 */
export function addSiblingAfter(host: CmdHost): Command {
	return (state, dispatch) => {
		const $ = state.selection.$from;
		const d = blockDepth($);
		if (d < 0) return false;
		const at = $.before(d) + $.node(d).nodeSize;
		const tr = state.tr.insert(at, newBlock(host));
		tr.setSelection(TextSelection.create(tr.doc, at + 2));
		dispatch?.(tr.scrollIntoView());
		return true;
	};
}

/** 在文档最后加一个顶层空块（导图里在页根上按 Tab）。 */
export function addTopLevel(host: CmdHost): Command {
	return (state, dispatch) => {
		const at = state.doc.content.size;
		const tr = state.tr.insert(at, newBlock(host));
		tr.setSelection(TextSelection.create(tr.doc, at + 2));
		dispatch?.(tr.scrollIntoView());
		return true;
	};
}

export type DropWhere = "before" | "after" | "child";

/** 拖动：把块（连同子块）挪到目标块之前 / 之后 / 子块末尾。不能挪进自己的子树。 */
export function moveBlockTo(id: string, targetId: string, where: DropWhere): Command {
	return (state, dispatch) => {
		const doc = state.doc;
		const from = blockPos(doc, id);
		const to0 = blockPos(doc, targetId);
		if (from == null || to0 == null || id === targetId) return false;
		const node = doc.nodeAt(from) as PMNode;
		if (to0 > from && to0 < from + node.nodeSize) return false; // 目标在自己的子树里
		const tr = state.tr;
		const $f = doc.resolve(from);
		if ($f.parent.type === N.children && $f.parent.childCount === 1)
			tr.delete($f.before(), $f.after());
		else tr.delete(from, from + node.nodeSize);
		const tp = blockPos(tr.doc, targetId);
		if (tp == null) return false;
		const tn = tr.doc.nodeAt(tp) as PMNode;
		let at: number;
		if (where === "before") {
			at = tp;
			tr.insert(at, node);
		} else if (where === "after") {
			at = tp + tn.nodeSize;
			tr.insert(at, node);
		} else if (tn.childCount > 1) {
			at = tp + tn.nodeSize - 2;
			tr.insert(at, node);
		} else {
			at = tp + 1 + tn.child(0).nodeSize;
			tr.insert(at, N.children.create(null, node));
			at += 1;
		}
		tr.setSelection(caretIn(tr.doc, at));
		tr.setMeta("moved", new Set([id]));
		dispatch?.(tr.scrollIntoView());
		return true;
	};
}

/** 删除当前块（连同子块）。光标去前一块（没有就后一块）。 */
export function deleteBlock(): Command {
	return (state, dispatch) => {
		const $ = state.selection.$from;
		const d = blockDepth($);
		if (d < 0) return false;
		const pos = $.before(d);
		const node = $.node(d);
		const tr = state.tr;
		if ($.node(d - 1).type === N.children && $.node(d - 1).childCount === 1)
			tr.delete($.before(d - 1), $.after(d - 1));
		else tr.delete(pos, pos + node.nodeSize);
		const near = Math.max(0, Math.min(tr.mapping.map(pos) - 1, tr.doc.content.size));
		tr.setSelection(TextSelection.near(tr.doc.resolve(near), -1));
		dispatch?.(tr.scrollIntoView());
		return true;
	};
}
