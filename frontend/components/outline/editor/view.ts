/**
 * One outline editor view: a ProseMirror editor over a focused block and its subtree (the page
 * itself or any block of it), on a page's live session (`live-client.ts`). Ported from the
 * editor prototype (`prototypes/outline-editor/src/client/view.ts`), keeping its fixes.
 *
 *   - Projection: block model + Yjs texts → editor document; only the changed range is
 *     replaced, unchanged block nodes are reused by identity.
 *   - Input → outline transaction: a ProseMirror transaction becomes structural operations
 *     (fast path for typing in one body; otherwise the old and new block trees are compared)
 *     plus body changes. A body change is the diff against the source the editor LAST SHOWED
 *     (its shadow), rebased over remote changes received since (a diff against the current
 *     Yjs text would overwrite remote changes not shown yet; the prototype lost text this way
 *     during IME composition).
 *   - Remote change → the affected blocks are re-parsed and replaced; the local cursor is kept
 *     through "source offset ↔ editor position" maps and the Yjs deltas. A block being composed
 *     with an IME is frozen until the composition ends. A block whose content did not change
 *     drops any mapping noted for it (a stale mapping put later cursors in the wrong place).
 *   - Block frames are native DOM node views; remote cursors and selections are decorations.
 *   - Block selection (Esc): whole blocks, moved, indented, deleted, copied together.
 *   - Clipboard: copying gives a markdown outline; pasting markdown splits into blocks; pasted
 *     HTML (from a web page or a word processor) becomes blocks too.
 */
import {
	type DeltaOp,
	diffHunks,
	type Hunk,
	hunksToDelta,
	mapOffset,
	parseMarkdownOutline,
	pmToSrc,
	serializeInlineFragment,
	serializeMarkdownOutline,
	simpleDiff,
	srcToPm,
	titleOf,
} from "@shared/outline";
import type { LiveTaskChar } from "@shared/outline-live-protocol";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { Fragment, type Node as PMNode, Slice } from "prosemirror-model";
import {
	type Command,
	EditorState,
	NodeSelection,
	Plugin,
	PluginKey,
	TextSelection,
	type Transaction,
} from "prosemirror-state";
import { ReplaceStep } from "prosemirror-transform";
import { Decoration, DecorationSet, EditorView, type NodeView } from "prosemirror-view";
import {
	applyChrome,
	chromeText,
	createGutter,
	type Gutter,
	type MentionResolver,
	mentionLabel,
	TASK_NEXT,
} from "./chrome";
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
import { htmlToOutline, isOwnClipboardHtml } from "./html-paste";
import type { BodyChange, ClientView, LiveClient, SelInfo, SelPoint } from "./live-client";
import { schema } from "./schema";
import { type ClientOp, keyBetweenLoose } from "./store";

const N = schema.nodes;
const utf8 = new TextEncoder();

/** UTF-8 bytes of one block's content the write path takes (`OUTLINE_LIMITS.maxBodyBytes`). */
export const MAX_BODY_BYTES = 16 * 1024;

export type Surface =
	/** A block and its subtree; the page itself is focused this way too. */
	| { kind: "focus"; rootId: string }
	/** One block's body only (the mind map's node editor, PR9). */
	| { kind: "node"; blockId: string };

interface CacheEntry {
	content: string;
	body: PMNode;
	task: LiveTaskChar | null;
	collapsed: boolean;
	hidden: number;
	kids: PMNode[];
	node: PMNode;
}

/** Which blocks a view shows: everything, or the facts view (tasks and what is under them
 * left out, as the read-only page does, D19). */
export type OutlineLens = "facts" | "all";

interface Rec {
	id: string;
	parentId: string;
	node: PMNode;
	pos: number;
	top: boolean;
}

const presenceKey = new PluginKey<DecorationSet>("outline-presence");
const bselKey = new PluginKey<DecorationSet>("outline-block-selection");
const TOP = "\u0000top";

function sameArr(a: PMNode[], b: PMNode[]) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Longest increasing subsequence of order keys: the siblings that keep their place. */
function lis(keys: string[]): Set<number> {
	const tails: number[] = [];
	const prev: number[] = new Array(keys.length).fill(-1);
	for (let i = 0; i < keys.length; i++) {
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if ((keys[tails[mid] as number] as string) < (keys[i] as string)) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) prev[i] = tails[lo - 1] as number;
		tails[lo] = i;
	}
	const out = new Set<number>();
	let k = tails.length ? (tails[tails.length - 1] as number) : -1;
	while (k >= 0) {
		out.add(k);
		k = prev[k] as number;
	}
	return out;
}

/**
 * Why an edit was refused: a block too large, the focused root kept, or a structural change
 * while the page is still connecting (shown from its HTTP read).
 */
export type OutlineRefusal = "too-large" | "root" | "connecting";

export interface ViewOptions {
	/** The facts view or everything (default). */
	lens?: OutlineLens;
	/** Collapsed blocks (shared view state, `view-state.ts`). */
	collapsed?: Set<string>;
	/** Keys that win over the outline keys (focus, collapse all, …). */
	keys?: Record<string, Command>;
	/** The bullet was clicked: focus that block. */
	onBullet?: (id: string) => void;
	/** A block was folded or unfolded here. */
	onCollapse?: (id: string) => void;
	/** The cursor moved to another block. */
	onSelect?: (blockId: string) => void;
	/** Block selection changed (empty: left block selection). */
	onBlockSelection?: (ids: string[]) => void;
	/** An edit was refused locally (`too-large`: a block over the size limit; `root`: the
	 * focused block cannot be removed). */
	onRefused?: (reason: OutlineRefusal) => void;
	/** Mention targets: the text of a block a `[[…]]` names, when it is on this page. */
	resolveMention?: MentionResolver;
	/**
	 * Undo or redo puts a selection back: the surface may take it (to the view on screen, the
	 * mind map's node or node editor) and return true; otherwise this view applies it.
	 */
	restoreSel?: (sel: SelInfo) => boolean;
}

export class OutlineView implements CmdHost, ClientView {
	pm: EditorView;
	nodeCache = new Map<string, CacheEntry>();
	collapsed = new Set<string>();
	pendingMap = new Map<string, DeltaOp[][] | "reset" | ((s: number) => number)>();
	composingBlock: string | null = null;
	compositionDirty = false;
	compSelBefore: SelInfo | null = null;
	deferred = false;
	destroyed = false;
	placeholderId: string;
	lastSelBlock: string | null = null;
	/** Block id → its frame's DOM (presence, anchors, PR9's animations). */
	blockEls = new Map<string, HTMLElement>();
	/** Block selection: the selected sibling range, anchor and head ids. */
	blockSel: { anchor: string; head: string } | null = null;
	lens: OutlineLens;
	/** Blocks the facts view leaves out under the root, after the last projection. */
	hiddenByLens = 0;
	/**
	 * Never scroll to the selection: the view is not on screen (the outline behind the mind map,
	 * a parked page view) or scrolls itself (a node editor), and the mind map's commands put the
	 * cursor in it.
	 */
	noScroll = false;
	stats = {
		syncs: 0,
		syncMs: 0,
		reconcileFast: 0,
		reconcileFull: 0,
		deferred: 0,
		frozenSkips: 0,
		fallbackReplace: 0,
		refused: 0,
	};

	constructor(
		public client: LiveClient,
		public surface: Surface,
		public mount: HTMLElement,
		public opts: ViewOptions = {},
	) {
		if (opts.collapsed) this.collapsed = opts.collapsed;
		this.lens = opts.lens ?? "all";
		this.placeholderId = client.newId();
		client.views.add(this);
		const built = this.buildDoc();
		this.nodeCache = built.staged;
		const state = EditorState.create({ doc: built.doc, plugins: this.plugins() });
		this.pm = new EditorView(mount, {
			state,
			editable: () => this.client.editable,
			dispatchTransaction: (tr) => this.dispatch(tr),
			nodeViews: {
				block: (node, view, getPos) => new BlockView(node, view, getPos as () => number, this),
				embed: (node) => new EmbedView(node, this),
				mention: (node) => new MentionView(node, this),
			},
			handlePaste: (_v, ev) => this.handlePaste(ev),
			clipboardTextSerializer: (slice) => this.copyText(slice),
			handleTextInput: (_v, from, to, text) => this.handleTextInput(from, to, text),
			handleKeyDown: (_v, ev) => this.handleBlockKeys(ev),
			handleScrollToSelection: () => this.noScroll,
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
				mousedown: () => {
					if (this.blockSel) this.setBlockSelection(null);
					return false;
				},
				copy: (_v, ev) => this.copyBlocks(ev, false),
				cut: (_v, ev) => this.copyBlocks(ev, true),
			},
		});
		(this.pm.dom as HTMLElement).dataset.surface = surface.kind;
		(this.pm.dom as HTMLElement).classList.add("nf-outline-pm");
	}

	get surfaceKind() {
		return this.surface.kind;
	}

	get rootId(): string {
		return this.surface.kind === "focus" ? this.surface.rootId : this.surface.blockId;
	}

	newId() {
		return this.client.newId();
	}

	destroy() {
		this.detach();
		this.pm.destroy();
	}

	/**
	 * Stop following the client (no more syncs, no more input into it); `destroy` tears the
	 * editor down later (its node views and DOM: costly for a large page).
	 */
	detach() {
		this.destroyed = true;
		this.client.views.delete(this);
	}

	/**
	 * Show another block as the root (a focus view moving to another focused block): the same
	 * editor, so keyboard focus stays where it is; only the document changes.
	 */
	setRoot(rootId: string): void {
		if (this.destroyed || this.surface.kind !== "focus" || this.surface.rootId === rootId) return;
		this.surface = { kind: "focus", rootId };
		this.blockSel = null;
		this.lastSelBlock = null;
		(this.pm.dom as HTMLElement).classList.remove("ob-blockmode");
		this.sync();
	}

	/** Re-read `editable` (write access or status changed). */
	refreshEditable(): void {
		if (!this.destroyed) this.pm.setProps({});
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Plugins
	// ─────────────────────────────────────────────────────────────────────────

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
			keymap(this.opts.keys ?? {}),
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
				Escape: () => {
					const p = this.locate(this.pm.state.doc, this.pm.state.selection.head);
					if (!p) return false;
					this.setBlockSelection({ anchor: p.blockId, head: p.blockId });
					return true;
				},
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
			new Plugin({
				key: bselKey,
				state: {
					init: () => DecorationSet.empty,
					apply: (tr, old) => tr.getMeta(bselKey) ?? old.map(tr.mapping, tr.doc),
				},
				props: { decorations: (s) => bselKey.getState(s) },
			}),
		];
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Projection: block model → editor document
	// ─────────────────────────────────────────────────────────────────────────

	roots(): string[] {
		return this.client.visible.alive(this.rootId) ? [this.rootId] : [];
	}

	resetCache() {
		this.nodeCache.clear();
		this.pendingMap.clear();
	}

	/** Switch between the facts view and everything. */
	setLens(lens: OutlineLens): void {
		if (this.lens === lens) return;
		this.lens = lens;
		this.sync();
	}

	/** Whether the facts view applies under the root (not inside a task, as the server reads). */
	private factsHere(): boolean {
		if (this.lens !== "facts") return false;
		const v = this.client.visible;
		for (let cur: string | null = this.rootId; cur; cur = v.get(cur)?.parentId ?? null) {
			if (v.get(cur)?.task) return false;
		}
		return true;
	}

	private countSubtree(id: string): number {
		let n = 0;
		const stack = [id];
		while (stack.length > 0) {
			n++;
			stack.push(...this.client.visible.children(stack.pop() as string));
		}
		return n;
	}

	buildDoc(): { doc: PMNode; staged: Map<string, CacheEntry>; changed: Set<string> } {
		const v = this.client.visible;
		const facts = this.factsHere();
		let hiddenTotal = 0;
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
				// Unchanged content: a mapping noted for it meanwhile (a text reset) is stale.
				if (this.pendingMap.has(id)) this.pendingMap.delete(id);
			} else {
				body = parseToPM(content).node;
				if (c) changed.add(id);
			}
			const kids: PMNode[] = [];
			let hidden = 0;
			const single = depth === 0 && this.surface.kind === "node";
			if (!single)
				for (const k of v.children(id)) {
					if (facts && v.get(k)?.task) {
						hidden += this.countSubtree(k);
						continue;
					}
					const n = build(k, depth + 1);
					if (n) kids.push(n);
				}
			hiddenTotal += hidden;
			const collapsed = depth > 0 && this.collapsed.has(id) && kids.length > 0;
			let node: PMNode;
			if (
				c &&
				c.body === body &&
				c.task === rec.task &&
				c.collapsed === collapsed &&
				c.hidden === hidden &&
				sameArr(c.kids, kids)
			)
				node = c.node;
			else
				node = N.block.create(
					{ id, task: rec.task, collapsed, hidden },
					kids.length ? [body, N.children.create(null, kids)] : [body],
				);
			staged.set(id, { content, body, task: rec.task, collapsed, hidden, kids, node });
			return node;
		};
		const nodes: PMNode[] = [];
		for (const r of this.roots()) {
			const n = build(r, 0);
			if (n) nodes.push(n);
		}
		if (!nodes.length) nodes.push(N.block.create({ id: this.placeholderId }, N.paragraph.create()));
		this.hiddenByLens = hiddenTotal;
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

	/** An offset in the old source mapped into the new source. */
	private mapSrc(id: string, s: number, oldText: string, newText: string): number {
		const m = this.pendingMap.get(id);
		if (typeof m === "function") return m(s);
		if (Array.isArray(m)) {
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
		if (this.blockSel) this.renderBlockSelection();
		this.renderPresence();
		this.stats.syncs++;
		this.stats.syncMs += performance.now() - t0;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Selection
	// ─────────────────────────────────────────────────────────────────────────

	locate(doc: PMNode, pos: number): SelPoint | null {
		const $p = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
		for (let d = $p.depth; d > 0; d--) {
			if ($p.node(d).type === N.block) {
				const bodyStart = $p.start(d) + 1;
				return { blockId: $p.node(d).attrs.id, offset: pos - bodyStart };
			}
		}
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
		if (this.opts.restoreSel?.(sel)) return;
		this.applySelection(sel);
	}

	applySelection(sel: SelInfo, scroll = true) {
		if (this.destroyed) return;
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
		tr.setMeta("remote", true);
		this.pm.dispatch(scroll ? tr.scrollIntoView() : tr);
	}

	/** Put the cursor at the end of a block (or at a body offset). */
	focusBlock(id: string, offset = -1): boolean {
		const pos = findBlockPos(this.pm.state.doc, id);
		if (pos == null) return false;
		const block = this.pm.state.doc.nodeAt(pos) as PMNode;
		const body = block.child(0);
		const off = offset < 0 ? body.content.size : Math.min(offset, body.content.size);
		this.applySelection({
			anchor: { blockId: id, offset: off },
			head: { blockId: id, offset: off },
			view: this,
		});
		this.pm.focus();
		return true;
	}

	/** Source offset of an editor offset in a block (presence travels in source offsets). */
	private srcOffset(blockId: string, offset: number): number {
		return pmToSrc(parseToPM(this.client.textOf(blockId)).map, Math.max(0, offset));
	}

	private afterSelection() {
		const p = this.locate(this.pm.state.doc, this.pm.state.selection.head);
		if (!p) return;
		this.client.cursorBlock = p.blockId;
		if (!this.blockSel) {
			const a = this.locate(this.pm.state.doc, this.pm.state.selection.anchor) ?? p;
			this.client.setSelection({
				anchor: { blockId: a.blockId, offset: this.srcOffset(a.blockId, a.offset) },
				head: { blockId: p.blockId, offset: this.srcOffset(p.blockId, p.offset) },
			});
		}
		if (p.blockId === this.lastSelBlock) return;
		this.lastSelBlock = p.blockId;
		this.opts.onSelect?.(p.blockId);
	}

	/** Peers' cursors, selections and block selections, as decorations. */
	renderPresence() {
		if (this.destroyed) return;
		const doc = this.pm.state.doc;
		const decos: Decoration[] = [];
		const editorPos = (pos: { blockId: string; offset: number } | null) => {
			if (!pos) return null;
			const bpos = findBlockPos(doc, pos.blockId);
			if (bpos == null) return null;
			const block = doc.nodeAt(bpos) as PMNode;
			const map = parseToPM(this.client.textOf(pos.blockId)).map;
			const off = Math.min(srcToPm(map, pos.offset), block.child(0).content.size);
			return { bpos, block, pos: bpos + 2 + off };
		};
		for (const peer of this.client.presence.values()) {
			const sel = peer.sel;
			if (!sel) continue;
			const style = `--peer:${peer.color}`;
			if ("b" in sel) {
				for (const id of sel.b) {
					const bpos = findBlockPos(doc, id);
					if (bpos == null) continue;
					const block = doc.nodeAt(bpos) as PMNode;
					decos.push(
						Decoration.node(bpos, bpos + block.nodeSize, { class: "ob-peer-bsel", style }),
					);
				}
				continue;
			}
			const head = editorPos(this.client.resolvePos(sel.h));
			const anchor = editorPos(this.client.resolvePos(sel.a));
			if (!head) continue;
			decos.push(
				Decoration.node(head.bpos, head.bpos + head.block.nodeSize, {
					class: "ob-peer",
					style,
					"data-peer": peer.name,
				}),
			);
			if (anchor && anchor.pos !== head.pos) {
				const from = Math.min(anchor.pos, head.pos);
				const to = Math.max(anchor.pos, head.pos);
				decos.push(Decoration.inline(from, to, { class: "ob-peer-range", style }));
			}
			const el = document.createElement("span");
			el.className = "ob-peer-caret";
			el.style.setProperty("--peer", peer.color);
			el.dataset.user = peer.name;
			decos.push(
				Decoration.widget(head.pos, el, { side: 1, key: `peer-${peer.pno}-${peer.color}` }),
			);
		}
		this.pm.dispatch(
			this.pm.state.tr
				.setMeta(presenceKey, DecorationSet.create(doc, decos))
				.setMeta("remote", true),
		);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Block selection (Esc)
	// ─────────────────────────────────────────────────────────────────────────

	/** The selected sibling range, in order (empty when not in block selection). */
	selectedBlocks(): string[] {
		const sel = this.blockSel;
		if (!sel) return [];
		const parent = this.client.visible.get(sel.anchor)?.parentId;
		if (!parent || this.client.visible.get(sel.head)?.parentId !== parent) return [sel.anchor];
		const sibs = this.client.visible.children(parent);
		const a = sibs.indexOf(sel.anchor);
		const h = sibs.indexOf(sel.head);
		if (a < 0 || h < 0) return [];
		return sibs.slice(Math.min(a, h), Math.max(a, h) + 1);
	}

	/** Enter, change or leave block selection. The root cannot be block-selected. */
	setBlockSelection(sel: { anchor: string; head: string } | null) {
		if (sel && (sel.anchor === this.rootId || sel.head === this.rootId)) sel = null;
		this.blockSel = sel;
		(this.pm.dom as HTMLElement).classList.toggle("ob-blockmode", !!sel);
		const ids = this.selectedBlocks();
		if (sel && ids.length) this.selectRange(ids);
		this.renderBlockSelection();
		this.client.setSelection(ids.length ? { blocks: ids } : null);
		if (!sel) this.afterSelection();
		this.opts.onBlockSelection?.(ids);
	}

	/** A text selection over whole blocks, so the structure commands and the clipboard apply. */
	private selectRange(ids: string[]) {
		const doc = this.pm.state.doc;
		const first = findBlockPos(doc, ids[0] as string);
		const last = findBlockPos(doc, ids[ids.length - 1] as string);
		if (first == null || last == null) return;
		const lastNode = doc.nodeAt(last) as PMNode;
		const from = first + 2;
		const to = last + 1 + lastNode.child(0).nodeSize - 1;
		const tr = this.pm.state.tr.setSelection(TextSelection.create(doc, from, Math.max(from, to)));
		tr.setMeta("remote", true);
		this.pm.dispatch(tr.scrollIntoView());
	}

	private renderBlockSelection() {
		const doc = this.pm.state.doc;
		const decos: Decoration[] = [];
		for (const id of this.selectedBlocks()) {
			const pos = findBlockPos(doc, id);
			if (pos == null) continue;
			const n = doc.nodeAt(pos) as PMNode;
			decos.push(Decoration.node(pos, pos + n.nodeSize, { class: "ob-bsel" }));
		}
		this.pm.dispatch(
			this.pm.state.tr.setMeta(bselKey, DecorationSet.create(doc, decos)).setMeta("remote", true),
		);
	}

	/** Keys while blocks are selected: move, extend, indent, delete; anything else leaves. */
	private handleBlockKeys(ev: KeyboardEvent): boolean {
		const sel = this.blockSel;
		if (!sel) return false;
		const mod = ev.metaKey || ev.ctrlKey;
		const ids = this.selectedBlocks();
		const run = (cmd: Command) => {
			cmd(this.pm.state, (tr) => this.pm.dispatch(tr));
			this.setBlockSelection(this.blockSel);
			ev.preventDefault();
			return true;
		};
		const sibling = (id: string, dir: -1 | 1): string | null => {
			const parent = this.client.visible.get(id)?.parentId;
			if (!parent) return null;
			const sibs = this.client.visible.children(parent);
			return sibs[sibs.indexOf(id) + dir] ?? null;
		};
		switch (ev.key) {
			case "Escape":
				ev.preventDefault();
				this.setBlockSelection(null);
				this.focusBlock(sel.head);
				return true;
			case "Enter":
				ev.preventDefault();
				this.setBlockSelection(null);
				this.focusBlock(sel.head);
				return true;
			case "ArrowUp":
			case "ArrowDown": {
				const dir = ev.key === "ArrowUp" ? -1 : 1;
				if (ev.altKey) return run(moveBlock(this, dir));
				const next = sibling(sel.head, dir);
				ev.preventDefault();
				if (next)
					this.setBlockSelection(
						ev.shiftKey ? { anchor: sel.anchor, head: next } : { anchor: next, head: next },
					);
				return true;
			}
			case "Tab":
				return run(ev.shiftKey ? outdent(this) : indent(this));
			case "Backspace":
			case "Delete":
				ev.preventDefault();
				this.deleteBlocks(ids);
				return true;
			default:
				if (mod && (ev.key === "c" || ev.key === "x" || ev.key === "a")) return false;
				if (ev.key === "Shift" || ev.key === "Alt" || ev.key === "Control" || ev.key === "Meta")
					return true;
				// Typing leaves block selection at the end of the head block (nothing is replaced).
				this.setBlockSelection(null);
				this.focusBlock(sel.head);
				return false;
		}
	}

	/** Delete whole blocks (with their subtrees) in one transaction. */
	deleteBlocks(ids: readonly string[]) {
		const tr = this.pm.state.tr;
		for (const id of [...ids].reverse()) {
			const pos = findBlockPos(tr.doc, id);
			if (pos == null) continue;
			const n = tr.doc.nodeAt(pos) as PMNode;
			const $p = tr.doc.resolve(pos);
			if ($p.parent.type === N.children && $p.parent.childCount === 1)
				tr.delete($p.before(), $p.after());
			else tr.delete(pos, pos + n.nodeSize);
		}
		const near = Math.max(0, Math.min(tr.mapping.map(tr.selection.from), tr.doc.content.size));
		tr.setSelection(TextSelection.near(tr.doc.resolve(near), -1));
		this.blockSel = null;
		this.pm.dispatch(tr);
		this.setBlockSelection(null);
	}

	/** Copy (or cut) the selected blocks with their subtrees as a markdown outline. */
	private copyBlocks(ev: ClipboardEvent, cut: boolean): boolean {
		if (!this.blockSel || !ev.clipboardData) return false;
		const ids = this.selectedBlocks();
		const doc = this.pm.state.doc;
		const nodes: PMNode[] = [];
		for (const id of ids) {
			const pos = findBlockPos(doc, id);
			if (pos != null) nodes.push(doc.nodeAt(pos) as PMNode);
		}
		ev.preventDefault();
		ev.clipboardData.setData(
			"text/plain",
			serializeMarkdownOutline(fragmentToOutline(Fragment.from(nodes))),
		);
		if (cut && this.client.editable) this.deleteBlocks(ids);
		return true;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Input → outline transaction
	// ─────────────────────────────────────────────────────────────────────────

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

	/** The blocks a transaction changed, when it only typed inside block bodies (fast path). */
	private bodyOnly(tr: Transaction): string[] | null {
		const ids = new Set<string>();
		for (let i = 0; i < tr.steps.length; i++) {
			const step = tr.steps[i];
			const doc = tr.docs[i];
			if (!(step instanceof ReplaceStep) || !doc) return null;
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

	private reconcileFull(oldDoc: PMNode, newDoc: PMNode, moved: Set<string>) {
		const v = this.client.visible;
		const oldRecs = this.walkRecs(oldDoc);
		const newRecs = this.walkRecs(newDoc);
		const newIds = new Set(newRecs.map((r) => r.id));
		const inserts: ClientOp[] = [];
		const moves: ClientOp[] = [];
		const tasks: ClientOp[] = [];
		const deletes: ClientOp[] = [];
		const bodies: BodyChange[] = [];
		const inserted = new Set<string>();
		const groups = new Map<string, Rec[]>();
		for (const r of newRecs) {
			if (r.parentId === TOP) continue;
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
				inserted.add(r.id);
				inserts.push({
					t: "i",
					id: r.id,
					p: parentId,
					k: key,
					task: r.node.attrs.task,
					content: serializePM(r.node.child(0)),
				});
			} else if (ex.parentId !== parentId || ex.orderKey !== key) {
				moves.push({ t: "m", id: r.id, p: parentId, k: key });
			}
		};
		for (const [parentId, kids] of groups) {
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
			for (const k of keepIdx) kept.add(idx[k] as number);
			let prevKey: string | null = null;
			for (let i = 0; i < kids.length; i++) {
				const r = kids[i] as Rec;
				if (kept.has(i)) {
					prevKey = v.get(r.id)?.orderKey ?? prevKey;
					continue;
				}
				let nextKey: string | null = null;
				for (let j = i + 1; j < kids.length; j++) {
					if (kept.has(j)) {
						nextKey = v.get((kids[j] as Rec).id)?.orderKey ?? null;
						break;
					}
				}
				const key = keyBetweenLoose(prevKey, nextKey);
				prevKey = key;
				emit(r, parentId, key);
			}
		}
		// Deepest first, so undo (the inverses in reverse) restores parents before children.
		for (const r of [...oldRecs].reverse())
			if (!newIds.has(r.id) && v.alive(r.id)) deletes.push({ t: "d", id: r.id });
		for (const r of newRecs) {
			if (inserted.has(r.id)) continue;
			const body = r.node.child(0);
			const c = this.nodeCache.get(r.id);
			if (!(c && c.body === body)) {
				const md = serializePM(body);
				if (md !== this.client.textOf(r.id)) bodies.push({ id: r.id, md });
			}
			const task = r.node.attrs.task ?? null;
			if ((v.get(r.id)?.task ?? null) !== task) tasks.push({ t: "k", id: r.id, task });
		}
		return { ops: [...inserts, ...moves, ...tasks, ...deletes], bodies };
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
			hidden: node.attrs.hidden ?? 0,
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
	 * A local edit is shadow (the source the editor shows) → local; the Yjs text may also hold
	 * remote changes not shown yet, so the edit is mapped over them, never written over them.
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
		const finalOf = (p: number): number => {
			let shift = 0;
			let applied = 0;
			for (let i = 0; i < hunks.length; i++) {
				const h = hunks[i] as Hunk;
				const m = mapped[i] as Hunk;
				const ls = h.start + shift;
				if (p < ls) return R(p - shift) + applied;
				if (p <= ls + h.text.length) return m.start + applied + (p - ls);
				shift += h.text.length - (h.end - h.start);
				applied += h.text.length - (m.end - m.start);
			}
			return R(p - shift) + applied;
		};
		return { hunks: mapped, finalOf };
	}

	/** One block's body change: a plain diff, or a rebase when remote changes are not shown. */
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
		if (md === shadow) return null;
		const r = this.rebase(id, shadow, md, current);
		rebased.set(id, r.finalOf);
		return { id, md, hunks: r.hunks };
	}

	/** Blocks whose body this state makes larger than the write path takes. */
	private oversize(doc: PMNode, ids: Iterable<string>): boolean {
		for (const id of ids) {
			const pos = findBlockPos(doc, id);
			if (pos == null) continue;
			const md = serializePM((doc.nodeAt(pos) as PMNode).child(0));
			if (md.length * 3 > MAX_BODY_BYTES && utf8.encode(md).length > MAX_BODY_BYTES) return true;
		}
		return false;
	}

	private refuse(before: EditorState, reason: OutlineRefusal) {
		this.stats.refused++;
		this.pm.updateState(before);
		this.opts.onRefused?.(reason);
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
		if (!this.client.editable) {
			this.pm.updateState(before);
			return;
		}
		const fast = this.bodyOnly(tr);
		// Shown from an HTTP read, not live yet: typing is queued, structure waits.
		if (!fast && this.client.provisional) return this.refuse(before, "connecting");
		if (!fast) state = this.fixIds(state);
		this.pm.updateState(state);
		if (fast && this.pm.composing && fast.length === 1 && fast[0] === this.composingBlock) {
			// Composing: nothing goes into Yjs (nobody sees the pinyin); written when it ends.
			this.compositionDirty = true;
			return;
		}
		const doc = state.doc;
		let ops: ClientOp[] = [];
		let bodies: BodyChange[] = [];
		const bodyMd = new Map<string, string>();
		const rebased = new Map<string, (p: number) => number>();
		if (fast) {
			if (this.oversize(doc, fast)) return this.refuse(before, "too-large");
			this.stats.reconcileFast++;
			for (const id of fast) {
				const pos = findBlockPos(doc, id);
				if (pos == null) continue;
				const md = serializePM((doc.nodeAt(pos) as PMNode).child(0));
				bodyMd.set(id, md);
				const b = this.bodyChange(id, md, rebased);
				if (b) bodies.push(b);
			}
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
			// The focused block stays the one root.
			if (doc.childCount !== 1 || doc.child(0).attrs.id !== this.rootId)
				return this.refuse(before, "root");
			this.stats.reconcileFull++;
			const moved = (tr.getMeta("moved") as Set<string> | undefined) ?? new Set<string>();
			const r = this.reconcileFull(before.doc, doc, moved);
			const touched = [
				...r.bodies.map((b) => b.id),
				...r.ops.filter((op) => op.t === "i").map((op) => op.id),
			];
			if (this.oversize(doc, touched)) return this.refuse(before, "too-large");
			ops = r.ops;
			bodies = [];
			for (const b of r.bodies) {
				const c = this.bodyChange(b.id, b.md, rebased);
				if (c) bodies.push(c);
			}
			for (const b of bodies) bodyMd.set(b.id, b.md);
			for (const op of ops) if (op.t === "i") bodyMd.set(op.id, op.content);
			this.refreshCacheFromDoc(doc, bodyMd);
		}
		if (!ops.length && !bodies.length) return;
		this.client.commit({
			ops,
			bodies,
			kind: fast ? "typing" : "struct",
			blockId: fast ? (fast[0] as string) : null,
			selBefore: this.captureSel(before),
			selAfter: this.captureSel(state),
			view: this,
		});
		if (rebased.size) {
			// The editor shows the local text; the final text has remote changes too: re-project
			// those blocks through the mapping, keeping the cursor.
			for (const [id, f] of rebased) this.pendingMap.set(id, f);
			this.sync();
		}
		this.afterSelection();
	}

	/** Composition ended: what was typed goes into Yjs, rebased over what arrived meanwhile. */
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

	// ─────────────────────────────────────────────────────────────────────────
	// Clipboard
	// ─────────────────────────────────────────────────────────────────────────

	private copyText(slice: Slice): string {
		// The slice keeps its wrappers (outline > block > body): peel single wrappers open at
		// both ends, so a selection inside one block copies as inline markdown.
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
		return serializeMarkdownOutline(fragmentToOutline(frag));
	}

	private handlePaste(ev: ClipboardEvent): boolean {
		if (!this.client.editable) return true;
		const html = ev.clipboardData?.getData("text/html") ?? "";
		const plain = (ev.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
		const state = this.pm.state;
		const $from = state.selection.$from;
		if ($from.parent.type === N.code_block) {
			if (!plain) return false;
			this.pm.dispatch(state.tr.insertText(plain));
			return true;
		}
		// HTML from elsewhere (a web page, a word processor) becomes blocks; our own copies and
		// plain text go through the markdown outline, which carries the exact dialect.
		if (html && !isOwnClipboardHtml(html)) {
			const items = htmlToOutline(html);
			if (items) {
				if (items.length === 1 && items[0]?.children.length === 0 && !items[0].task) {
					const p = parseToPM(items[0].content).node;
					if (p.type === N.paragraph && $from.parent.type.spec.group?.includes("body")) {
						this.pm.dispatch(
							state.tr.replaceSelection(new Slice(p.content, 0, 0)).scrollIntoView(),
						);
						return true;
					}
				}
				if (items.length) this.insertBlocks(outlineToPM(items, () => this.newId()));
				return true;
			}
		}
		if (!plain) return false;
		const single =
			!plain.trim().includes("\n") && !/^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|>|```|\|)/.test(plain);
		if (single || !$from.parent.type.spec.group?.includes("body")) {
			const p = parseToPM(plain.trim().replace(/\n/g, " ")).node;
			const frag = p.type === N.paragraph ? p.content : Fragment.from(schema.text(plain.trim()));
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
		const parsed = parseMarkdownOutline(plain);
		if (!parsed.items.length) return true;
		this.insertBlocks(outlineToPM(parsed.items, () => this.newId()));
		return true;
	}

	insertBlocks(nodes: PMNode[]) {
		const state = this.pm.state;
		const tr = state.tr;
		if (!state.selection.empty) tr.deleteSelection();
		const $from = tr.selection.$from;
		const d = blockDepth($from);
		if (d < 0 || !nodes.length) return;
		const blockNode = $from.node(d);
		const blockPos = $from.before(d);
		const body = blockNode.child(0);
		const bodyStart = blockPos + 2;
		const off = $from.parent === body ? $from.pos - bodyStart : body.content.size;
		const root = d === 1;
		const lastId = nodes[nodes.length - 1]?.attrs.id as string;
		if (root) {
			// Pasting into the focused block's own line: the blocks become its first children.
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

	// ─────────────────────────────────────────────────────────────────────────
	// Input rules
	// ─────────────────────────────────────────────────────────────────────────

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
				const node = N.mention.create({ ref: (m[1] as string).trim(), label: m[2] ?? null });
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
					.setNodeMarkup(bodyPos, N.heading, { level: (h[1] as string).length });
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
		this.opts.onCollapse?.(id);
	}

	/** Text a mention shows (`chrome.ts`). */
	mention(ref: string, label: string | null): string {
		return mentionLabel(this.opts.resolveMention ?? (() => null), ref, label);
	}

	/** The page's plain title (breadcrumbs). */
	titleOf(id: string): string {
		return titleOf(this.client.textOf(id));
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

// ─────────────────────────────────────────────────────────────────────────────
// Node views
// ─────────────────────────────────────────────────────────────────────────────

/** A block's frame: folding arrow, bullet, checkbox; native DOM (`chrome.ts`). */
class BlockView implements NodeView {
	dom: HTMLElement;
	contentDOM: HTMLElement;
	private g: Gutter;

	constructor(
		private node: PMNode,
		private view: EditorView,
		private getPos: () => number,
		private owner: OutlineView,
	) {
		this.dom = document.createElement("div");
		this.dom.className = "ob-block";
		this.g = createGutter();
		this.g.arrow.addEventListener("mousedown", (e) => {
			e.preventDefault();
			this.owner.toggleCollapse(this.node.attrs.id);
		});
		this.g.bullet.addEventListener("mousedown", (e) => {
			e.preventDefault();
			const id = this.node.attrs.id as string;
			if (this.owner.opts.onBullet) this.owner.opts.onBullet(id);
			else this.owner.toggleCollapse(id);
		});
		this.g.check.addEventListener("mousedown", (e) => {
			e.preventDefault();
			const task = this.node.attrs.task as LiveTaskChar | null;
			if (!task || !this.owner.client.editable) return;
			const pos = this.getPos();
			this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, "task", TASK_NEXT[task]));
		});
		this.contentDOM = document.createElement("div");
		this.contentDOM.className = "ob-content";
		this.chip = document.createElement("span");
		this.chip.className = "ob-hidden";
		this.chip.contentEditable = "false";
		this.dom.append(this.g.el, this.chip, this.contentDOM);
		this.render();
	}

	private chip: HTMLElement;

	private render() {
		const n = this.node;
		const id = n.attrs.id ?? "";
		if (this.dom.dataset.id && this.dom.dataset.id !== id) {
			if (this.owner.blockEls.get(this.dom.dataset.id) === this.dom)
				this.owner.blockEls.delete(this.dom.dataset.id);
		}
		this.dom.dataset.id = id;
		if (id) this.owner.blockEls.set(id, this.dom);
		applyChrome(this.dom, this.g, {
			hasKids: n.childCount > 1,
			collapsed: !!n.attrs.collapsed,
			task: n.attrs.task ?? null,
		});
		const hidden = (n.attrs.hidden as number) ?? 0;
		this.chip.textContent = hidden > 0 ? chromeText.hidden(hidden) : "";
		this.chip.style.display = hidden > 0 ? "" : "none";
	}

	update(node: PMNode) {
		if (node.type !== this.node.type) return false;
		this.node = node;
		this.render();
		return true;
	}

	destroy() {
		const id = this.dom.dataset.id;
		if (id && this.owner.blockEls.get(id) === this.dom) this.owner.blockEls.delete(id);
	}

	ignoreMutation(m: MutationRecord | { type: "selection"; target: Node }) {
		if (m.type === "selection") return false;
		return !this.contentDOM.contains(m.target) || m.target === this.dom;
	}

	stopEvent(e: Event) {
		return this.g.el.contains(e.target as Node) || this.chip.contains(e.target as Node);
	}
}

class MentionView implements NodeView {
	dom: HTMLElement;
	constructor(node: PMNode, owner: OutlineView) {
		this.dom = document.createElement("span");
		this.dom.className = "ob-mention";
		this.dom.dataset.ref = node.attrs.ref;
		this.dom.textContent = owner.mention(node.attrs.ref, node.attrs.label);
	}
	ignoreMutation() {
		return true;
	}
}

/**
 * An embed `![[…]]`: shown, not edited in place in P1a (editing an embedded block of another
 * page would join that page's session too; design §6.2). Selecting it selects the whole block.
 */
class EmbedView implements NodeView {
	dom: HTMLElement;

	constructor(
		private node: PMNode,
		owner: OutlineView,
	) {
		this.dom = document.createElement("div");
		this.dom.className = "ob-embed";
		this.dom.contentEditable = "false";
		const head = document.createElement("div");
		head.className = "ob-embed-head";
		head.textContent = `![[${node.attrs.ref}]]`;
		const body = document.createElement("div");
		body.className = "ob-embed-body";
		body.textContent = owner.mention(node.attrs.ref, node.attrs.label);
		this.dom.append(head, body);
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
		return false;
	}

	ignoreMutation() {
		return true;
	}
}

export { bodyToPM };
