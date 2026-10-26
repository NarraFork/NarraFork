/**
 * 一个编辑视图 = 一个编辑面（一页 / 一个嵌入的子树 / 一个拼接视图）。
 *
 * - 投影：块存储 + Y.Text → ProseMirror 文档（只替换变了的范围，未变的节点按身份复用）。
 * - 输入 → 大纲事务：ProseMirror 事务 reconcile 成结构操作 + 受影响块的正文差异。
 * - 远端修改 → 重新解析受影响的块并替换，用「源码偏移 ↔ 编辑器位置」映射保住本地光标；
 *   本地正在用输入法组合的块，推迟应用远端修改（§6.7）。
 */
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { Fragment, type Node as PMNode, Slice } from "prosemirror-model";
import {
	EditorState,
	NodeSelection,
	Plugin,
	PluginKey,
	TextSelection,
	type Transaction,
} from "prosemirror-state";
import { ReplaceStep } from "prosemirror-transform";
import { Decoration, DecorationSet, EditorView, type NodeView } from "prosemirror-view";
import { parseBlock, parseOutline, pmToSrc, srcToPm } from "../dialect/parse";
import { serializeInlineFragment, serializeOutline } from "../dialect/serialize";
import {
	type DeltaOp,
	diffHunks,
	type Hunk,
	hunksToDelta,
	mapOffset,
	simpleDiff,
} from "../model/diff";
import { keyBetween } from "../model/orderkey";
import type { Op } from "../model/store";
import type { BodyChange, Client, SelInfo, SelPoint } from "./client";
import {
	blockDepth,
	type CmdHost,
	hardBreak,
	indent,
	joinBackward,
	joinForward,
	moveBlock,
	outdent,
	splitBlock,
	toggleTask,
} from "./commands";
import {
	bodyToPM,
	fragmentToOutline,
	inlineFromPM,
	outlineToPM,
	parseToPM,
	serializePM,
} from "./convert";
import { schema } from "./schema";

const N = schema.nodes;

export type Surface =
	| { kind: "page"; pageId: string }
	| { kind: "embed"; blockId: string }
	| { kind: "stitch"; roots: string[] };

interface CacheEntry {
	content: string;
	body: PMNode;
	task: string | null;
	collapsed: boolean;
	kids: PMNode[];
	node: PMNode;
}

interface Rec {
	id: string;
	parentId: string;
	node: PMNode;
	pos: number;
	top: boolean;
}

const presenceKey = new PluginKey<DecorationSet>("presence");
const TOP = "\u0000top";

function sameArr(a: PMNode[], b: PMNode[]) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** 最长递增子序列（按排序键），返回保留的下标。 */
function lis(keys: string[]): Set<number> {
	const tails: number[] = [];
	const prev: number[] = new Array(keys.length).fill(-1);
	for (let i = 0; i < keys.length; i++) {
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (keys[tails[mid]] < keys[i]) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) prev[i] = tails[lo - 1];
		tails[lo] = i;
	}
	const out = new Set<number>();
	let k = tails.length ? tails[tails.length - 1] : -1;
	while (k >= 0) {
		out.add(k);
		k = prev[k];
	}
	return out;
}

export function refTarget(ref: string): { pageId: string; blockId: string } {
	const parts = ref.split("/");
	return { pageId: parts.length > 1 ? parts[0] : "", blockId: parts[parts.length - 1] };
}

export interface ViewOptions {
	chain?: string[];
	label?: string;
	parent?: OutlineView;
}

export class OutlineView implements CmdHost {
	pm: EditorView;
	nodeCache = new Map<string, CacheEntry>();
	collapsed = new Set<string>();
	pendingMap = new Map<string, DeltaOp[][] | "reset" | ((s: number) => number)>();
	composingBlock: string | null = null;
	compositionDirty = false;
	compSelBefore: SelInfo | null = null;
	deferred = false;
	destroyed = false;
	chain: string[];
	placeholderId: string;
	lastSelBlock: string | null = null;
	/** reconcile 算出的拼接视图新根序列：本地校验通过后才生效 */
	private pendingRoots: string[] | null = null;
	stats = {
		syncs: 0,
		syncMs: 0,
		reconcileFast: 0,
		reconcileFull: 0,
		deferred: 0,
		frozenSkips: 0,
		fallbackReplace: 0,
		crossPageRefused: 0,
	};

	constructor(
		public client: Client,
		public surface: Surface,
		public mount: HTMLElement,
		public opts: ViewOptions = {},
	) {
		this.chain = opts.chain ?? [];
		this.placeholderId = client.newId();
		client.views.add(this);
		const built = this.buildDoc();
		this.nodeCache = built.staged;
		const state = EditorState.create({ doc: built.doc, plugins: this.plugins() });
		this.pm = new EditorView(mount, {
			state,
			dispatchTransaction: (tr) => this.dispatch(tr),
			nodeViews: {
				block: (node, view, getPos) => new BlockView(node, view, getPos as () => number, this),
				embed: (node, view, getPos) => new EmbedView(node, view, getPos as () => number, this),
				mention: (node) => new MentionView(node, this),
			},
			handlePaste: (_v, ev) => this.handlePaste(ev),
			clipboardTextSerializer: (slice) => this.copyText(slice),
			handleTextInput: (_v, from, to, text) => this.handleTextInput(from, to, text),
			handleDOMEvents: {
				compositionstart: () => {
					const p = this.locate(this.pm.state.doc, this.pm.state.selection.head);
					this.composingBlock = p?.blockId ?? null;
					this.compositionDirty = false;
					this.compSelBefore = this.captureSel();
					return false;
				},
				compositionend: () => {
					setTimeout(() => this.endComposition(), 0);
					return false;
				},
				focus: () => {
					this.afterSelection();
					return false;
				},
			},
		});
		(this.pm.dom as HTMLElement).dataset.surface = surface.kind;
		if (opts.label) (this.pm.dom as HTMLElement).dataset.label = opts.label;
	}

	get surfaceKind() {
		return this.surface.kind;
	}

	newId() {
		return this.client.newId();
	}

	destroy() {
		this.destroyed = true;
		this.client.views.delete(this);
		this.pm.destroy();
	}

	// ---------- 插件 ----------

	private plugins(): Plugin[] {
		const undo = () => {
			this.client.undo();
			return true;
		};
		const redo = () => {
			this.client.redo();
			return true;
		};
		return [
			keymap({
				Enter: splitBlock(this),
				"Shift-Enter": hardBreak(),
				Backspace: joinBackward(this),
				Delete: joinForward(this),
				Tab: indent(this),
				"Shift-Tab": outdent(this),
				"Alt-ArrowUp": moveBlock(this, -1),
				"Alt-ArrowDown": moveBlock(this, 1),
				"Mod-Enter": toggleTask(),
				"Mod-z": undo,
				"Mod-Shift-z": redo,
				"Mod-y": redo,
				"Mod-b": toggleMark(schema.marks.strong),
				"Mod-i": toggleMark(schema.marks.em),
				"Mod-e": toggleMark(schema.marks.code),
			}),
			keymap(baseKeymap),
			new Plugin({
				key: presenceKey,
				state: {
					init: () => DecorationSet.empty,
					apply: (tr, old) => {
						const next = tr.getMeta(presenceKey);
						if (next) return next;
						return old.map(tr.mapping, tr.doc);
					},
				},
				props: { decorations: (s) => presenceKey.getState(s) },
			}),
		];
	}

	// ---------- 投影：存储 → 编辑器文档 ----------

	roots(): string[] {
		const v = this.client.visible;
		switch (this.surface.kind) {
			case "page":
				return v.children(this.surface.pageId);
			case "embed":
				return v.alive(this.surface.blockId) ? [this.surface.blockId] : [];
			case "stitch":
				return this.surface.roots.filter((id) => v.alive(id));
		}
	}

	resetCache() {
		this.nodeCache.clear();
		this.pendingMap.clear();
	}

	buildDoc(): { doc: PMNode; staged: Map<string, CacheEntry>; changed: Set<string> } {
		const v = this.client.visible;
		const staged = new Map<string, CacheEntry>();
		const changed = new Set<string>();
		const frozenId = this.pm?.composing ? this.composingBlock : null;
		let frozenNode: PMNode | null = null;
		if (frozenId && this.pm) {
			const pos = findBlockPos(this.pm.state.doc, frozenId);
			if (pos != null) frozenNode = this.pm.state.doc.nodeAt(pos);
		}
		const build = (id: string, depth: number): PMNode | null => {
			const rec = v.alive(id);
			if (!rec || depth > 100) return null;
			if (id === frozenId && frozenNode) {
				if (this.client.textOf(id) !== this.nodeCache.get(id)?.content) this.stats.frozenSkips++;
				frozenNode.descendants((n) => {
					if (n.type === N.block) {
						const c = this.nodeCache.get(n.attrs.id);
						if (c) staged.set(n.attrs.id, c);
					}
					return n.type === N.block || n.type === N.children;
				});
				const c = this.nodeCache.get(id);
				if (c) staged.set(id, c);
				return frozenNode;
			}
			const content = this.client.textOf(id);
			const c = this.nodeCache.get(id);
			let body: PMNode;
			if (c && c.content === content) {
				body = c.body;
				// 内容没变：之前记下的映射（例如 Y.Text 刚建好时的 reset）作废
				if (this.pendingMap.has(id)) this.pendingMap.delete(id);
			} else {
				body = parseToPM(content).node;
				if (c) changed.add(id);
			}
			const kids: PMNode[] = [];
			for (const k of v.children(id)) {
				const n = build(k, depth + 1);
				if (n) kids.push(n);
			}
			const collapsed = this.collapsed.has(id) && kids.length > 0;
			let node: PMNode;
			if (
				c &&
				c.body === body &&
				c.task === rec.task &&
				c.collapsed === collapsed &&
				sameArr(c.kids, kids)
			)
				node = c.node;
			else
				node = N.block.create(
					{ id, task: rec.task, collapsed },
					kids.length ? [body, N.children.create(null, kids)] : [body],
				);
			staged.set(id, { content, body, task: rec.task, collapsed, kids, node });
			return node;
		};
		const nodes: PMNode[] = [];
		for (const r of this.roots()) {
			const n = build(r, 0);
			if (n) nodes.push(n);
		}
		if (!nodes.length) nodes.push(N.block.create({ id: this.placeholderId }, N.paragraph.create()));
		return { doc: N.outline.create(null, nodes), staged, changed };
	}

	noteDelta(id: string, delta: DeltaOp[]) {
		if (!this.nodeCache.has(id)) return;
		const e = this.pendingMap.get(id);
		if (e === "reset" || typeof e === "function") return;
		if (!e) this.pendingMap.set(id, [delta]);
		else e.push(delta);
	}

	noteTextReset(id: string) {
		if (!this.nodeCache.has(id)) return;
		this.pendingMap.set(id, "reset");
	}

	/** 旧源码里的偏移 → 新源码里的偏移。 */
	private mapSrc(id: string, s: number, oldText: string, newText: string): number {
		const m = this.pendingMap.get(id);
		if (typeof m === "function") return m(s);
		if (Array.isArray(m)) {
			// 校验：把 delta 依次应用到旧文本应当得到新文本，否则退化为 diff
			let pos = s;
			for (const d of m) pos = mapOffset(d, pos);
			return pos;
		}
		const h = simpleDiff(oldText, newText);
		return h ? mapOffset(hunksToDelta([h]), s) : s;
	}

	sync() {
		if (this.destroyed) return;
		const t0 = performance.now();
		const { doc: newDoc, staged, changed } = this.buildDoc();
		const state = this.pm.state;
		const old = state.doc;
		const start = old.content.findDiffStart(newDoc.content);
		if (start == null) {
			this.nodeCache = staged;
			for (const id of changed) this.pendingMap.delete(id);
			return;
		}
		const end = old.content.findDiffEnd(newDoc.content);
		let endA = end ? end.a : old.content.size;
		let endB = end ? end.b : newDoc.content.size;
		const minEnd = Math.min(endA, endB);
		if (minEnd < start) {
			endA += start - minEnd;
			endB += start - minEnd;
		}
		if (this.pm.composing && this.composingBlock) {
			const cp = findBlockPos(old, this.composingBlock);
			const cn = cp != null ? old.nodeAt(cp) : null;
			if (cp != null && cn && start < cp + cn.nodeSize && endA > cp) {
				this.deferred = true;
				this.stats.deferred++;
				this.client.stats.deferredSyncs++;
				return;
			}
		}
		const sel = this.captureSel();
		let tr = state.tr.replace(start, endA, newDoc.slice(start, endB));
		if (!tr.doc.eq(newDoc)) {
			this.stats.fallbackReplace++;
			tr = state.tr.replaceWith(0, old.content.size, newDoc.content);
		}
		if (sel) {
			const mapPoint = (p: SelPoint): SelPoint => {
				if (!changed.has(p.blockId) || p.offset < 0) return p;
				const oldText = this.nodeCache.get(p.blockId)?.content ?? "";
				const newText = staged.get(p.blockId)?.content ?? "";
				const s = pmToSrc(parseToPM(oldText).map, p.offset);
				const s2 = this.mapSrc(p.blockId, s, oldText, newText);
				return { blockId: p.blockId, offset: srcToPm(parseToPM(newText).map, s2) };
			};
			const a = this.pointToPos(tr.doc, mapPoint(sel.anchor));
			const h = this.pointToPos(tr.doc, mapPoint(sel.head));
			if (a != null && h != null) {
				if (sel.anchor.offset < 0) {
					try {
						tr.setSelection(NodeSelection.create(tr.doc, a));
					} catch {}
				} else tr.setSelection(TextSelection.between(tr.doc.resolve(a), tr.doc.resolve(h)));
			}
		}
		tr.setMeta("remote", true);
		this.nodeCache = staged;
		for (const id of changed) this.pendingMap.delete(id);
		this.pm.updateState(this.pm.state.apply(tr));
		this.stats.syncs++;
		this.stats.syncMs += performance.now() - t0;
	}

	// ---------- 选区 ----------

	locate(doc: PMNode, pos: number): SelPoint | null {
		const $p = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
		for (let d = $p.depth; d > 0; d--) {
			if ($p.node(d).type === N.block) {
				const bodyStart = $p.start(d) + 1;
				return { blockId: $p.node(d).attrs.id, offset: pos - bodyStart };
			}
		}
		// 块与块之间：取后面那一块
		const after = $p.nodeAfter;
		if (after?.type === N.block) return { blockId: after.attrs.id, offset: 0 };
		return null;
	}

	pointToPos(doc: PMNode, p: SelPoint): number | null {
		const bpos = findBlockPos(doc, p.blockId);
		if (bpos == null) return null;
		const block = doc.nodeAt(bpos) as PMNode;
		const body = block.child(0);
		if (p.offset < 0) return bpos + 1;
		return bpos + 2 + Math.min(p.offset, body.content.size);
	}

	captureSel(state = this.pm?.state): SelInfo | null {
		if (!state) return null;
		const a = this.locate(state.doc, state.selection.anchor);
		const h = this.locate(state.doc, state.selection.head);
		if (!a || !h) return null;
		if (state.selection instanceof NodeSelection) {
			a.offset = -1;
			h.offset = -1;
		}
		return { anchor: a, head: h, view: this };
	}

	restoreSelection(sel: SelInfo) {
		const doc = this.pm.state.doc;
		const a = this.pointToPos(doc, sel.anchor);
		const h = this.pointToPos(doc, sel.head);
		if (a == null || h == null) return;
		const tr = this.pm.state.tr;
		if (sel.anchor.offset < 0) {
			try {
				tr.setSelection(NodeSelection.create(doc, a));
			} catch {
				return;
			}
		} else tr.setSelection(TextSelection.between(doc.resolve(a), doc.resolve(h)));
		this.pm.dispatch(tr.setMeta("remote", true).scrollIntoView());
	}

	private afterSelection() {
		const p = this.locate(this.pm.state.doc, this.pm.state.selection.head);
		if (!p || p.blockId === this.lastSelBlock) return;
		this.lastSelBlock = p.blockId;
		this.client.openBlock(p.blockId);
		const pageId = this.client.pageOf(p.blockId);
		if (pageId) this.client.sendPresence(pageId, p.blockId, Math.max(0, p.offset));
	}

	renderPresence() {
		if (this.destroyed) return;
		const doc = this.pm.state.doc;
		const decos: Decoration[] = [];
		for (const [cid, pr] of this.client.presence) {
			if (cid === this.client.id) continue;
			const bpos = findBlockPos(doc, pr.blockId);
			if (bpos == null) continue;
			const block = doc.nodeAt(bpos) as PMNode;
			decos.push(
				Decoration.node(bpos, bpos + block.nodeSize, {
					class: "ob-peer",
					style: `--peer:${pr.color}`,
				}),
			);
			const map = parseToPM(this.client.textOf(pr.blockId)).map;
			const off = Math.min(srcToPm(map, pr.offset), block.child(0).content.size);
			const el = document.createElement("span");
			el.className = "ob-peer-caret";
			el.style.borderColor = pr.color;
			el.dataset.user = pr.user;
			decos.push(Decoration.widget(bpos + 2 + off, el, { side: 1, key: `peer-${cid}` }));
		}
		this.pm.dispatch(
			this.pm.state.tr
				.setMeta(presenceKey, DecorationSet.create(doc, decos))
				.setMeta("remote", true),
		);
	}

	// ---------- 输入 → 大纲事务 ----------

	private walkRecs(doc: PMNode): Rec[] {
		const out: Rec[] = [];
		const visit = (node: PMNode, pos: number, parentId: string, top: boolean) => {
			out.push({ id: node.attrs.id, parentId, node, pos, top });
			if (node.childCount > 1) {
				const kids = node.child(1);
				let p = pos + 1 + node.child(0).nodeSize + 1;
				kids.forEach((k) => {
					visit(k, p, node.attrs.id, false);
					p += k.nodeSize;
				});
			}
		};
		let pos = 0;
		doc.forEach((n) => {
			visit(n, pos, TOP, true);
			pos += n.nodeSize;
		});
		return out;
	}

	/** 改动是否只落在单个块体内部（打字的快路径）。返回受影响的块 id。 */
	private bodyOnly(tr: Transaction): string[] | null {
		const ids = new Set<string>();
		for (let i = 0; i < tr.steps.length; i++) {
			const step = tr.steps[i];
			const doc = tr.docs[i];
			if (!(step instanceof ReplaceStep)) return null;
			const s = step as unknown as { from: number; to: number; slice: Slice };
			const $a = doc.resolve(s.from);
			const $b = doc.resolve(s.to);
			if (!$a.sameParent($b) || !$a.parent.inlineContent) return null;
			if (s.slice.openStart || s.slice.openEnd) return null;
			let inline = true;
			s.slice.content.forEach((n) => {
				if (!n.isInline) inline = false;
			});
			if (!inline) return null;
			const d = blockDepth($a);
			if (d < 0) return null;
			const id = $a.node(d).attrs.id;
			if (!this.client.visible.alive(id)) return null;
			ids.add(id);
		}
		return ids.size ? [...ids] : null;
	}

	private fixIds(state: EditorState): EditorState {
		const seen = new Set<string>();
		const tr = state.tr;
		for (const r of this.walkRecs(state.doc)) {
			if (!r.id || seen.has(r.id)) {
				const id = this.client.newId();
				tr.setNodeAttribute(r.pos, "id", id);
				seen.add(id);
			} else seen.add(r.id);
		}
		return tr.docChanged ? state.apply(tr) : state;
	}

	private parentOf(id: string): string {
		return this.client.visible.get(id)?.parentId ?? "";
	}

	private reconcileFull(oldDoc: PMNode, newDoc: PMNode, moved: Set<string>) {
		const v = this.client.visible;
		const oldRecs = this.walkRecs(oldDoc);
		const newRecs = this.walkRecs(newDoc);
		const newIds = new Set(newRecs.map((r) => r.id));
		const inserts: Op[] = [];
		const moves: Op[] = [];
		const tasks: Op[] = [];
		const deletes: Op[] = [];
		const bodies: BodyChange[] = [];
		const inserted = new Set<string>();
		const newPage = new Map<string, string>();
		const pageOfParent = (pid: string) => newPage.get(pid) ?? this.client.pageOf(pid);
		const groups = new Map<string, Rec[]>();
		for (const r of newRecs) {
			let g = groups.get(r.parentId);
			if (!g) {
				g = [];
				groups.set(r.parentId, g);
			}
			g.push(r);
		}
		const emit = (r: Rec, parentId: string, key: string) => {
			const ex = v.get(r.id);
			if (!ex || ex.deleted) {
				const pageId = pageOfParent(parentId);
				newPage.set(r.id, pageId);
				inserted.add(r.id);
				inserts.push({
					t: "insert",
					id: r.id,
					pageId,
					parentId,
					orderKey: key,
					content: serializePM(r.node.child(0)),
					task: r.node.attrs.task,
				});
			} else if (ex.parentId !== parentId || ex.orderKey !== key) {
				moves.push({ t: "move", id: r.id, parentId, orderKey: key });
			}
		};
		for (const [gid, kids] of groups) {
			if (gid === TOP && this.surface.kind !== "page") {
				this.reconcileTop(kids, emit);
				continue;
			}
			const parentId = gid === TOP ? (this.surface as { pageId: string }).pageId : gid;
			const keys: string[] = [];
			const idx: number[] = [];
			kids.forEach((r, i) => {
				const ex = v.alive(r.id);
				if (ex && ex.parentId === parentId && !moved.has(r.id)) {
					keys.push(ex.orderKey);
					idx.push(i);
				}
			});
			const keepIdx = lis(keys);
			const kept = new Set<number>();
			for (const k of keepIdx) kept.add(idx[k]);
			let prevKey: string | null = null;
			for (let i = 0; i < kids.length; i++) {
				const r = kids[i];
				if (kept.has(i)) {
					prevKey = v.get(r.id)?.orderKey ?? prevKey;
					continue;
				}
				let nextKey: string | null = null;
				for (let j = i + 1; j < kids.length; j++) {
					if (kept.has(j)) {
						nextKey = v.get(kids[j].id)?.orderKey ?? null;
						break;
					}
				}
				const key = keyBetween(prevKey, nextKey);
				prevKey = key;
				emit(r, parentId, key);
			}
		}
		for (const r of oldRecs)
			if (!newIds.has(r.id) && v.alive(r.id)) deletes.push({ t: "delete", id: r.id });
		for (const r of newRecs) {
			if (inserted.has(r.id)) continue;
			const body = r.node.child(0);
			const c = this.nodeCache.get(r.id);
			if (!(c && c.body === body)) {
				const md = serializePM(body);
				if (md !== this.client.textOf(r.id)) bodies.push({ id: r.id, md });
			}
			const task = r.node.attrs.task ?? null;
			if ((v.get(r.id)?.task ?? null) !== task) tasks.push({ t: "task", id: r.id, task });
		}
		return { ops: [...inserts, ...moves, ...tasks, ...deletes], bodies };
	}

	/** 嵌入 / 拼接视图的顶层：根块的位置不在这里改；新出现的顶层块放在前一个根块后面（同一页）。 */
	private reconcileTop(kids: Rec[], emit: (r: Rec, parentId: string, key: string) => void) {
		const v = this.client.visible;
		const roots =
			this.surface.kind === "stitch"
				? this.surface.roots
				: [(this.surface as { blockId: string }).blockId];
		const rootSet = new Set(roots);
		const order: string[] = [];
		let prevRoot: string | null = null;
		let prevKey: string | null = null;
		for (let i = 0; i < kids.length; i++) {
			const r = kids[i];
			if (rootSet.has(r.id)) {
				prevRoot = r.id;
				prevKey = v.get(r.id)?.orderKey ?? null;
				order.push(r.id);
				continue;
			}
			const anchor = prevRoot ?? kids.slice(i + 1).find((k) => rootSet.has(k.id))?.id ?? null;
			if (!anchor) continue;
			const parentId = this.parentOf(anchor);
			const sibs = v.children(parentId);
			let lo: string | null;
			let hi: string | null;
			if (prevRoot) {
				lo = prevKey;
				const ai = sibs.indexOf(prevRoot);
				hi = ai >= 0 && ai + 1 < sibs.length ? (v.get(sibs[ai + 1])?.orderKey ?? null) : null;
				if (hi !== null && lo !== null && hi <= lo) hi = null;
			} else {
				const ai = sibs.indexOf(anchor);
				lo = ai > 0 ? (v.get(sibs[ai - 1])?.orderKey ?? null) : null;
				hi = v.get(anchor)?.orderKey ?? null;
			}
			const key = keyBetween(lo, hi);
			emit(r, parentId, key);
			prevKey = key;
			prevRoot = prevRoot ?? null;
			order.push(r.id);
			if (this.surface.kind === "stitch") rootSet.add(r.id);
		}
		if (this.surface.kind === "stitch") this.pendingRoots = order;
	}

	private cacheNode(node: PMNode, bodies: Map<string, string>): PMNode[] {
		const id = node.attrs.id as string;
		const kids: PMNode[] = [];
		if (node.childCount > 1)
			node.child(1).forEach((k) => {
				kids.push(k);
			});
		const old = this.nodeCache.get(id);
		const body = node.child(0);
		const content =
			bodies.get(id) ?? (old && old.body === body ? old.content : this.client.textOf(id));
		this.nodeCache.set(id, {
			content,
			body,
			task: node.attrs.task ?? null,
			collapsed: node.attrs.collapsed,
			kids,
			node,
		});
		return kids;
	}

	private refreshCacheFromDoc(doc: PMNode, bodies: Map<string, string>) {
		const visit = (node: PMNode) => {
			for (const k of this.cacheNode(node, bodies)) visit(k);
		};
		doc.forEach((n) => {
			visit(n);
		});
	}

	/**
	 * 本地修改 = shadow（编辑器当前反映的源码）→ local 的差异；当前 Y.Text 里可能还有没投影进来的
	 * 远端修改（输入法组合期间推迟了），所以把差异按这些远端修改映射过去再写，绝不拿 local 直接覆盖当前文本。
	 */
	private rebase(id: string, shadow: string, local: string, current: string) {
		const hunks = diffHunks(shadow, local);
		const pm = this.pendingMap.get(id);
		const R = (p: number): number => {
			if (Array.isArray(pm)) {
				let x = p;
				for (const d of pm) x = mapOffset(d, x);
				return x;
			}
			if (typeof pm === "function") return pm(p);
			const h = simpleDiff(shadow, current);
			return h ? mapOffset(hunksToDelta([h]), p) : p;
		};
		const mapped: Hunk[] = hunks.map((h) => {
			const s = R(h.start);
			const e = h.start === h.end ? s : Math.max(s, R(h.end));
			return { start: s, end: e, text: h.text };
		});
		// 本地坐标 → 最终坐标（用来放光标）
		const finalOf = (p: number): number => {
			let shift = 0;
			let applied = 0;
			for (let i = 0; i < hunks.length; i++) {
				const h = hunks[i];
				const ls = h.start + shift;
				if (p < ls) return R(p - shift) + applied;
				if (p <= ls + h.text.length) return mapped[i].start + applied + (p - ls);
				shift += h.text.length - (h.end - h.start);
				applied += h.text.length - (mapped[i].end - mapped[i].start);
			}
			return R(p - shift) + applied;
		};
		return { hunks: mapped, finalOf };
	}

	/** 一个块的正文修改：没有未投影的远端修改时直接 diff，否则 rebase。 */
	private bodyChange(
		id: string,
		md: string,
		rebased: Map<string, (p: number) => number>,
	): BodyChange | null {
		const current = this.client.textOf(id);
		const shadow = this.nodeCache.get(id)?.content;
		if (shadow === undefined || shadow === current || !this.client.ytext(id)) {
			return md === current ? null : { id, md };
		}
		if (md === shadow) return null; // 本地没改，只是有待投影的远端修改
		const r = this.rebase(id, shadow, md, current);
		rebased.set(id, r.finalOf);
		return { id, md, hunks: r.hunks };
	}

	dispatch(tr: Transaction) {
		if (this.destroyed) return;
		const before = this.pm.state;
		let state = before.apply(tr);
		if (tr.getMeta("remote") || !tr.docChanged) {
			this.pm.updateState(state);
			if (tr.selectionSet) this.afterSelection();
			if (!this.pm.composing && this.composingBlock) this.endComposition();
			return;
		}
		const fast = this.bodyOnly(tr);
		if (!fast) state = this.fixIds(state);
		this.pm.updateState(state);
		if (fast && this.pm.composing && fast.length === 1 && fast[0] === this.composingBlock) {
			// 输入法组合中：不写进 Y.Text（别人不会看到拼音），组合结束再写
			this.compositionDirty = true;
			return;
		}
		const doc = state.doc;
		let ops: Op[] = [];
		let bodies: BodyChange[] = [];
		const bodyMd = new Map<string, string>();
		const rebased = new Map<string, (p: number) => number>();
		if (fast) {
			this.stats.reconcileFast++;
			for (const id of fast) {
				const pos = findBlockPos(doc, id);
				if (pos == null) continue;
				const md = serializePM((doc.nodeAt(pos) as PMNode).child(0));
				bodyMd.set(id, md);
				const b = this.bodyChange(id, md, rebased);
				if (b) bodies.push(b);
			}
			// 快路径：只刷新这个块和它的祖先在缓存里的节点
			for (const id of fast) {
				const pos = findBlockPos(doc, id);
				if (pos == null) continue;
				const $p = doc.resolve(pos + 1);
				for (let d = $p.depth; d > 0; d--) {
					const n = $p.node(d);
					if (n.type === N.block) this.cacheNode(n, bodyMd);
				}
			}
		} else {
			this.stats.reconcileFull++;
			const moved = (tr.getMeta("moved") as Set<string> | undefined) ?? new Set<string>();
			this.pendingRoots = null;
			const r = this.reconcileFull(before.doc, doc, moved);
			// 块不跨页移动：ProseMirror 的默认合并（跨页的跨块删除）会把后一页的子块挂到前一页的块下面，
			// 服务端会拒绝。这里先在本地拒绝，避免往返和重新同步。
			const v = this.client.visible;
			const pageOfNew = new Map<string, string>();
			for (const op of r.ops) if (op.t === "insert") pageOfNew.set(op.id, op.pageId);
			const cross = r.ops.find((op) => {
				if (op.t !== "move") return false;
				const pid = pageOfNew.get(op.parentId) ?? this.client.pageOf(op.parentId);
				return pid !== v.get(op.id)?.pageId;
			});
			if (cross) {
				this.stats.crossPageRefused++;
				this.client.log.push(`跨页移动被拒绝：${cross.t} ${(cross as { id: string }).id}`);
				this.pendingRoots = null;
				this.pm.updateState(before);
				return;
			}
			if (this.pendingRoots && this.surface.kind === "stitch")
				this.surface.roots = this.pendingRoots;
			this.pendingRoots = null;
			ops = r.ops;
			bodies = [];
			for (const b of r.bodies) {
				const c = this.bodyChange(b.id, b.md, rebased);
				if (c) bodies.push(c);
			}
			for (const b of bodies) bodyMd.set(b.id, b.md);
			for (const op of ops) if (op.t === "insert") bodyMd.set(op.id, op.content);
			this.refreshCacheFromDoc(doc, bodyMd);
		}
		if (!ops.length && !bodies.length) return;
		this.client.commit({
			ops,
			bodies,
			kind: fast ? "typing" : "struct",
			blockId: fast ? fast[0] : null,
			selBefore: this.captureSel(before),
			selAfter: this.captureSel(state),
			view: this,
		});
		if (rebased.size) {
			// 编辑器里还是 local；最终文本里多了远端修改：按映射重新投影这些块，保住光标
			for (const [id, f] of rebased) this.pendingMap.set(id, f);
			this.sync();
		}
		this.afterSelection();
	}

	/** 组合结束：把组合期间本地的修改按三方方式写进 Y.Text（期间远端的修改已经在 Y.Text 里）。 */
	endComposition() {
		if (this.pm.composing) return;
		const id = this.composingBlock;
		this.composingBlock = null;
		const dirty = this.compositionDirty;
		this.compositionDirty = false;
		if (id && dirty) {
			const pos = findBlockPos(this.pm.state.doc, id);
			if (pos != null && this.nodeCache.get(id)) {
				const node = this.pm.state.doc.nodeAt(pos) as PMNode;
				const local = serializePM(node.child(0));
				const rebased = new Map<string, (p: number) => number>();
				const b = this.bodyChange(id, local, rebased);
				if (b) {
					this.client.commit({
						ops: [],
						bodies: [b],
						kind: "typing",
						blockId: id,
						selBefore: this.compSelBefore,
						selAfter: this.captureSel(),
						view: this,
					});
				}
				const c = this.nodeCache.get(id);
				if (c) this.nodeCache.set(id, { ...c, content: local, body: node.child(0), node });
				for (const [k, f] of rebased) this.pendingMap.set(k, f);
			}
		}
		this.deferred = false;
		this.sync();
	}

	// ---------- 剪贴板 ----------

	private copyText(slice: Slice): string {
		// 选区的 slice 带着外层节点（outline > block > 块体）：两端都开着的单个外层节点逐层剥掉
		let frag = slice.content;
		let os = slice.openStart;
		let oe = slice.openEnd;
		while (frag.childCount === 1 && os > 0 && oe > 0 && !(frag.firstChild as PMNode).isTextblock) {
			frag = (frag.firstChild as PMNode).content;
			os--;
			oe--;
		}
		if (frag.childCount === 1 && (frag.firstChild as PMNode).isTextblock && os > 0 && oe > 0)
			frag = (frag.firstChild as PMNode).content;
		let inline = true;
		frag.forEach((n) => {
			if (!n.isInline) inline = false;
		});
		if (inline) return serializeInlineFragment(inlineFromPM(frag));
		return serializeOutline(fragmentToOutline(frag));
	}

	private handlePaste(ev: ClipboardEvent): boolean {
		const raw = ev.clipboardData?.getData("text/plain");
		if (!raw) return false;
		const text = raw.replace(/\r\n?/g, "\n");
		const state = this.pm.state;
		const $from = state.selection.$from;
		if ($from.parent.type === N.code_block) {
			this.pm.dispatch(state.tr.insertText(text));
			return true;
		}
		const single =
			!text.trim().includes("\n") && !/^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|>|```|\|)/.test(text);
		if (single || !$from.parent.type.spec.group?.includes("body")) {
			const p = parseBlock(text.trim().replace(/\n/g, " "));
			const frag =
				p.body.type === "paragraph"
					? bodyToPM(p.body).content
					: Fragment.from(schema.text(text.trim()));
			const nodes: PMNode[] = [];
			frag.forEach((n) => {
				if (n.type === N.hard_break && $from.parent.type !== N.paragraph)
					nodes.push(schema.text(" "));
				else nodes.push(n);
			});
			this.pm.dispatch(
				state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)).scrollIntoView(),
			);
			return true;
		}
		const parsed = parseOutline(text);
		if (!parsed.nodes.length) return true;
		this.insertBlocks(outlineToPM(parsed.nodes, () => this.newId()));
		return true;
	}

	insertBlocks(nodes: PMNode[]) {
		const state = this.pm.state;
		const tr = state.tr;
		if (!state.selection.empty) tr.deleteSelection();
		const $from = tr.selection.$from;
		const d = blockDepth($from);
		if (d < 0) return;
		const blockNode = $from.node(d);
		const blockPos = $from.before(d);
		const body = blockNode.child(0);
		const bodyStart = blockPos + 2;
		const off = $from.parent === body ? $from.pos - bodyStart : body.content.size;
		const embedRoot = d === 1 && this.surface.kind === "embed";
		const lastId = nodes[nodes.length - 1].attrs.id as string;
		if (embedRoot) {
			if (blockNode.childCount > 1) tr.insert(blockPos + 1 + body.nodeSize + 1, nodes);
			else tr.insert(blockPos + 1 + body.nodeSize, N.children.create(null, nodes));
		} else if (body.type === N.paragraph && body.content.size === 0 && blockNode.childCount === 1) {
			tr.replaceWith(blockPos, blockPos + blockNode.nodeSize, nodes);
		} else if (off >= body.content.size || !body.isTextblock) {
			tr.insert(blockPos + blockNode.nodeSize, nodes);
		} else if (off === 0) {
			tr.insert(blockPos, nodes);
		} else {
			const after = body.content.cut(off);
			tr.delete(bodyStart + off, bodyStart + body.content.size);
			const tail = N.block.create({ id: this.newId() }, [body.type.create(body.attrs, after)]);
			tr.insert(tr.mapping.map(blockPos + blockNode.nodeSize), [...nodes, tail]);
		}
		const lp = findBlockPos(tr.doc, lastId);
		if (lp != null) {
			const ln = tr.doc.nodeAt(lp) as PMNode;
			tr.setSelection(TextSelection.near(tr.doc.resolve(lp + 2 + ln.child(0).content.size)));
		}
		this.pm.dispatch(tr.scrollIntoView());
	}

	// ---------- 行内输入规则 ----------

	private handleTextInput(from: number, to: number, text: string): boolean {
		if (this.pm.composing) return false;
		const state = this.pm.state;
		const $from = state.doc.resolve(from);
		const parent = $from.parent;
		if (!parent.inlineContent || parent.type === N.code_block) return false;
		const before = parent.textBetween(
			Math.max(0, $from.parentOffset - 200),
			$from.parentOffset,
			null,
			"￼",
		);
		if (text === "]") {
			const m = /\[\[([^[\]\n|￼]+)(?:\|([^[\]\n￼]*))?\]$/.exec(before);
			if (m) {
				const node = N.mention.create({ ref: m[1].trim(), label: m[2] ?? null });
				this.pm.dispatch(state.tr.replaceWith(from - m[0].length, to, node));
				return true;
			}
		}
		if (text === " " && parent.type === N.paragraph && $from.parentOffset === before.length) {
			const d = blockDepth($from);
			const bodyPos = $from.before(d) + 1;
			const h = /^(#{1,3})$/.exec(before);
			if (h) {
				const tr = state.tr
					.delete(from - before.length, to)
					.setNodeMarkup(bodyPos, N.heading, { level: h[1].length });
				this.pm.dispatch(tr);
				return true;
			}
			if (before === ">") {
				this.pm.dispatch(state.tr.delete(from - 1, to).setNodeMarkup(bodyPos, N.quote));
				return true;
			}
		}
		if (
			text === "`" &&
			parent.type === N.paragraph &&
			before === "``" &&
			$from.parentOffset === 2 &&
			parent.content.size === 2
		) {
			const d = blockDepth($from);
			const bodyPos = $from.before(d) + 1;
			this.pm.dispatch(state.tr.delete(from - 2, to).setNodeMarkup(bodyPos, N.code_block));
			return true;
		}
		return false;
	}

	toggleCollapse(id: string) {
		if (this.collapsed.has(id)) this.collapsed.delete(id);
		else this.collapsed.add(id);
		this.sync();
	}
}

export function findBlockPos(doc: PMNode, id: string): number | null {
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

// ---------- node views ----------

const TASK_GLYPH: Record<string, string> = { " ": "☐", "/": "◐", x: "☑", "-": "⊘" };
const TASK_NEXT: Record<string, string> = { " ": "/", "/": "x", x: " ", "-": " " };

/** 块的外框：项目符号、折叠箭头、复选框，原生 DOM（不是每块一个 React 根）。 */
class BlockView implements NodeView {
	dom: HTMLElement;
	contentDOM: HTMLElement;
	private gutter: HTMLElement;
	private toggle: HTMLElement;
	private check: HTMLElement;

	constructor(
		private node: PMNode,
		private view: EditorView,
		private getPos: () => number,
		private owner: OutlineView,
	) {
		this.dom = document.createElement("div");
		this.dom.className = "ob-block";
		this.gutter = document.createElement("div");
		this.gutter.className = "ob-gutter";
		this.gutter.contentEditable = "false";
		this.toggle = document.createElement("span");
		this.toggle.className = "ob-bullet";
		this.toggle.addEventListener("mousedown", (e) => {
			e.preventDefault();
			this.owner.toggleCollapse(this.node.attrs.id);
		});
		this.check = document.createElement("span");
		this.check.className = "ob-check";
		this.check.addEventListener("mousedown", (e) => {
			e.preventDefault();
			const task = this.node.attrs.task as string | null;
			if (!task) return;
			const pos = this.getPos();
			this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, "task", TASK_NEXT[task]));
		});
		this.gutter.append(this.toggle, this.check);
		this.contentDOM = document.createElement("div");
		this.contentDOM.className = "ob-content";
		this.dom.append(this.gutter, this.contentDOM);
		this.render();
	}

	private render() {
		const n = this.node;
		this.dom.dataset.id = n.attrs.id ?? "";
		this.dom.classList.toggle("collapsed", !!n.attrs.collapsed);
		this.dom.classList.toggle("has-kids", n.childCount > 1);
		this.dom.dataset.task = n.attrs.task ?? "";
		this.check.textContent = n.attrs.task ? TASK_GLYPH[n.attrs.task] : "";
		this.check.style.display = n.attrs.task ? "" : "none";
	}

	update(node: PMNode) {
		if (node.type !== this.node.type) return false;
		this.node = node;
		this.render();
		return true;
	}

	ignoreMutation(m: MutationRecord | { type: "selection"; target: Node }) {
		if (m.type === "selection") return false;
		return !this.contentDOM.contains(m.target) || m.target === this.dom;
	}

	stopEvent(e: Event) {
		return this.gutter.contains(e.target as Node);
	}
}

class MentionView implements NodeView {
	dom: HTMLElement;
	constructor(node: PMNode, owner: OutlineView) {
		this.dom = document.createElement("span");
		this.dom.className = "ob-mention";
		this.dom.dataset.ref = node.attrs.ref;
		const { blockId } = refTarget(node.attrs.ref);
		const text = owner.client.visible.alive(blockId)
			? owner.client.textOf(blockId).split("\n")[0]
			: null;
		this.dom.textContent =
			node.attrs.label ??
			(text ? text.replace(/[#*_`~[\]>!\\]/g, "").slice(0, 40) : node.attrs.ref);
	}
	ignoreMutation() {
		return true;
	}
}

/** 嵌入：node view 里放一个子编辑视图，选区不跨越嵌入边界。 */
class EmbedView implements NodeView {
	dom: HTMLElement;
	sub: OutlineView | null = null;
	private destroyed = false;

	constructor(
		private node: PMNode,
		_view: EditorView,
		_getPos: () => number,
		owner: OutlineView,
	) {
		this.dom = document.createElement("div");
		this.dom.className = "ob-embed";
		this.dom.contentEditable = "false";
		const head = document.createElement("div");
		head.className = "ob-embed-head";
		head.textContent = `嵌入 ${node.attrs.ref}`;
		const body = document.createElement("div");
		body.className = "ob-embed-body";
		this.dom.append(head, body);
		const { pageId, blockId } = refTarget(node.attrs.ref);
		this.dom.dataset.target = blockId;
		if (owner.chain.includes(blockId)) {
			body.textContent = "（循环嵌入，不再展开）";
			return;
		}
		const client = owner.client;
		const mountSub = () => {
			if (this.destroyed) return;
			if (!client.visible.alive(blockId)) {
				body.textContent = "（目标不存在或无权查看）";
				return;
			}
			this.sub = new OutlineView(client, { kind: "embed", blockId }, body, {
				chain: [...owner.chain, blockId],
				parent: owner,
			});
		};
		if (pageId) client.joinPage(pageId).then(mountSub);
		else mountSub();
	}

	update(node: PMNode) {
		return node.type === this.node.type && node.attrs.ref === this.node.attrs.ref;
	}

	selectNode() {
		this.dom.classList.add("selected");
	}

	deselectNode() {
		this.dom.classList.remove("selected");
	}

	stopEvent() {
		return true;
	}

	ignoreMutation() {
		return true;
	}

	destroy() {
		this.destroyed = true;
		this.sub?.destroy();
	}
}
