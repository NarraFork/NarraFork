/**
 * 编辑面（§6.7 / §6.10）：一个编辑面，两种视图（大纲、导图），共用视图状态。
 * - 大纲视图（OutlineView）一直在：导图的结构命令在它的文档上执行，切回大纲不用重建；
 *   不显示时只是透明（布局还在），切换时读行的位置不用整页重新排版。
 * - 切换：记下切换前每个可见块的屏幕位置，算出目标视图的布局，FLIP（WAAPI，250 ms）；
 *   视口锚点块在屏幕上不动；只有切换前或切换后在视口里的块做位移动画，其余淡入淡出；
 *   prefers-reduced-motion 时直接切换。向右 ↔ 向下同样处理。
 * - 聚焦：点项目符号或 Alt+→ 聚焦，Alt+← 退一层，面包屑任意跳；地址栏记录聚焦，前进后退可用。
 */
import type { Command } from "prosemirror-state";
import type { Dir } from "../mindmap/layout";
import { prewarm } from "../mindmap/measure";
import { MindMapView } from "../mindmap/mindmap";
import { mentionLabel, plainLine } from "./chrome";
import type { Client, SelInfo } from "./client";
import { caretIn } from "./commands";
import { findBlockPos, OutlineView, type Surface } from "./view";
import { type ViewKind, ViewState } from "./viewstate";

export const DURATION = 250;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 最近访问（快速切换器排在前面） */
export const recent: string[] = [];
export function noteVisit(id: string | null) {
	if (!id) return;
	const i = recent.indexOf(id);
	if (i >= 0) recent.splice(i, 1);
	recent.unshift(id);
	if (recent.length > 50) recent.length = 50;
}

interface Pos {
	x: number;
	y: number;
}

interface Transition {
	kind: string;
	anims: Animation[];
	done: () => void;
	t0: number;
}

export interface SurfaceOptions {
	label: string;
	title: string;
	/** 编辑区高度（CSS） */
	height: string;
	/** 打开后在 Worker 里预先测量导图节点（默认开） */
	premeasure?: boolean;
}

export class EditSurface {
	state = new ViewState();
	/**
	 * 大纲视图：整页一个（一直在），聚焦时另建一个以聚焦的块为根的视图，整页那个停放起来
	 * （content-visibility: hidden，DOM 和排版结果都留着）。从 2000 块的整页聚焦进去不用拆掉整页的 DOM，
	 * 退出聚焦回到整页也不用重建。
	 */
	pageView: OutlineView;
	focusView: OutlineView | null = null;
	private pageHost: HTMLElement;
	private focusHost: HTMLElement;
	private pageScroll = 0;
	map: MindMapView;
	panel: HTMLElement;
	frame: HTMLElement;
	scroller: HTMLElement;
	crumbs: HTMLElement;
	private btns: Record<string, HTMLButtonElement> = {};
	private transition: Transition | null = null;
	/** 最近一次切换的耗时拆分（测试读） */
	parts: Record<string, number> = {};
	private keys: Record<string, Command> | null = null;
	/** 每次切换 / 聚焦的记录（测试读） */
	log: Array<{
		kind: string;
		setupMs: number;
		animated: number;
		at: number;
		doneAt?: number;
		parts?: Record<string, number>;
		/** 这次切换的锚点：块和切换前它的块体在编辑区里的位置 */
		anchor?: { blockId: string; x: number; y: number } | null;
	}> = [];

	constructor(
		public client: Client,
		public pageId: string,
		app: HTMLElement,
		public opts: SurfaceOptions,
	) {
		const panel = document.createElement("section");
		panel.className = "panel sf-panel";
		panel.dataset.surface = opts.label;
		const h = document.createElement("h2");
		h.textContent = opts.title;
		const bar = document.createElement("div");
		bar.className = "sf-bar";
		const mk = (key: string, text: string, title: string, fn: () => void) => {
			const b = document.createElement("button");
			b.type = "button";
			b.textContent = text;
			b.title = title;
			b.dataset.k = key;
			// 工具栏按钮不抢键盘焦点：焦点留在当前视图里（切换视图时再交给目标视图）
			b.addEventListener("mousedown", (e) => e.preventDefault());
			b.addEventListener("click", fn);
			this.btns[key] = b;
			return b;
		};
		const views = document.createElement("span");
		views.className = "sf-seg";
		views.append(
			mk("outline", "大纲", "大纲视图", () => this.setView("outline")),
			mk("map", "导图", "导图视图", () => this.setView("map")),
		);
		const dirs = document.createElement("span");
		dirs.className = "sf-seg sf-dirs";
		dirs.append(
			mk("right", "→ 向右", "向右展开", () => this.setLayout("right")),
			mk("down", "↓ 向下", "向下展开（组织结构图）", () => this.setLayout("down")),
		);
		const tools = document.createElement("span");
		tools.className = "sf-seg";
		tools.append(
			mk("collapseAll", "全部折叠", "Mod-↑", () => this.collapseAll()),
			mk("expandAll", "全部展开", "Mod-↓", () => this.expandAll()),
			mk("fit", "适应窗口", "导图整体放进视口", () => {
				if (this.state.view === "map") this.map.fit();
			}),
		);
		this.crumbs = document.createElement("nav");
		this.crumbs.className = "sf-crumbs";
		this.crumbs.addEventListener("mousedown", (e) => e.preventDefault());
		this.crumbs.addEventListener("click", (e) => {
			const b = (e.target as HTMLElement).closest("[data-crumb]") as HTMLElement | null;
			if (!b) return;
			const id = b.dataset.crumb as string;
			this.focusBlock(id === "" ? null : id);
		});
		bar.append(views, dirs, tools);
		this.frame = document.createElement("div");
		this.frame.className = "sf-frame";
		this.frame.style.height = opts.height;
		this.frame.dataset.view = "outline";
		this.scroller = document.createElement("div");
		this.scroller.className = "sf-scroller";
		this.pageHost = document.createElement("div");
		this.pageHost.className = "editor-host";
		this.focusHost = document.createElement("div");
		this.focusHost.className = "editor-host sf-focus-host";
		this.scroller.append(this.pageHost, this.focusHost);
		this.frame.append(this.scroller);
		panel.append(h, bar, this.crumbs, this.frame);
		app.append(panel);
		this.panel = panel;
		this.pageView = this.makeView({ kind: "page", pageId }, this.pageHost, null);
		const self = this;
		this.map = new MindMapView(
			{
				client,
				state: this.state,
				get outline() {
					return self.outline;
				},
				pageId,
				label: `${opts.label}:map`,
				focusBlock: (id) => this.focusBlock(id),
				focusUp: () => this.focusUp(),
				toggleCollapse: (id) => this.toggleCollapse(id),
				surfaceKeys: () => this.surfaceKeys(),
				restoreSel: (sel) => this.restoreSel(sel),
				onSelect: (id) => this.onMapSelect(id),
			},
			this.frame,
		);
		client.listeners.add((kind) => {
			if (kind === "sync") this.onStoreChange();
			else if (this.state.view === "map") this.map.schedule(false);
		});
		this.panel.addEventListener("focusin", () => {
			activeSurface = this;
		});
		// 输入到来时，没做完的切换第二步先做掉：按键落在正确的视图上
		this.panel.addEventListener("keydown", () => this.flushPending(), true);
		this.panel.addEventListener("pointerdown", () => this.flushPending(), true);
		this.renderBar();
		this.renderCrumbs();
		if (opts.premeasure !== false) setTimeout(() => this.prewarm(), 0);
	}

	/** 预先测量这一页所有块的导图节点尺寸（Worker 里做，不占主线程） */
	prewarmDone: Promise<void> = Promise.resolve();
	prewarm() {
		const v = this.client.visible;
		const labelOf = (ref: string, label: string | null) => mentionLabel(this.client, ref, label);
		const items: Array<{ content: string; labelOf: typeof labelOf }> = [];
		for (const id of v.subtree(this.pageId))
			items.push({
				content: id === this.pageId ? (v.get(id)?.content ?? "") : this.client.textOf(id),
				labelOf,
			});
		this.prewarmDone = prewarm(items);
		return this.prewarmDone;
	}

	/** 当前的大纲视图（聚焦时是聚焦视图） */
	get outline(): OutlineView {
		return this.focusView ?? this.pageView;
	}

	private makeView(surface: Surface, host: HTMLElement, focusRoot: string | null): OutlineView {
		const v = new OutlineView(this.client, surface, host, {
			label: this.opts.label,
			focusRoot,
			collapsed: this.state.collapsed,
			keys: this.surfaceKeys(),
			onBullet: (id) => this.focusBlock(id),
			onCollapse: () => {
				// 折叠集合是共用的：另一个大纲视图（停放的整页 / 聚焦视图）和导图也跟着更新
				this.syncOutlines(v);
				this.map.schedule();
				this.state.emit("collapsed");
			},
			onSelect: () => {
				// 用户在大纲里换块：退出块选择（切换视图时程序放光标不算）
				if (!this.restoring && this.state.blocks.length && this.state.view === "outline")
					this.setBlocks([]);
			},
			restoreSel: (sel) => this.restoreSel(sel),
		});
		v.noScroll = this.state.view === "map";
		return v;
	}

	/** 两个大纲视图都按当前视图状态重新投影（折叠集合变了） */
	private syncOutlines(except?: OutlineView) {
		for (const v of [this.pageView, this.focusView]) if (v && v !== except) v.sync();
	}

	/** 大纲换聚焦：建 / 拆聚焦视图，整页视图停放或恢复（保留它的滚动位置）。 */
	private setOutlineFocus(id: string | null) {
		const cur = this.focusView;
		if ((cur?.focusRoot ?? null) === id) return;
		if (!cur) this.pageScroll = this.scroller.scrollTop;
		if (cur) {
			this.focusView = null;
			cur.destroy();
			this.focusHost.replaceChildren();
		}
		if (id) {
			this.pageHost.classList.add("sf-parked");
			this.focusView = this.makeView({ kind: "embed", blockId: id }, this.focusHost, id);
		} else {
			this.pageHost.classList.remove("sf-parked");
			this.scroller.scrollTop = this.pageScroll;
		}
	}

	// ---------- 键位（大纲、导图、节点编辑器共用） ----------

	surfaceKeys(): Record<string, Command> {
		if (this.keys) return this.keys;
		const k: Record<string, Command> = {
			"Alt-ArrowRight": () => {
				const id = this.currentBlock();
				if (id && id !== this.pageId) this.focusBlock(id);
				return true;
			},
			"Alt-ArrowLeft": () => {
				this.focusUp();
				return true;
			},
			"Mod-ArrowUp": () => {
				this.collapseAll();
				return true;
			},
			"Mod-ArrowDown": () => {
				this.expandAll();
				return true;
			},
			Escape: () => {
				if (this.state.view !== "outline") return false;
				const id = this.currentBlock();
				this.setBlocks(this.state.blocks.length || !id ? [] : [id]);
				return true;
			},
		};
		for (let n = 1; n <= 9; n++)
			k[`Alt-${n}`] = () => {
				this.expandToLevel(n);
				return true;
			};
		this.keys = k;
		return k;
	}

	/** 当前块：大纲里是光标所在的块，导图里是选中的节点（编辑中就是编辑的块）。 */
	currentBlock(): string | null {
		if (this.state.view === "map") return this.map.editing?.id ?? this.map.selected;
		const s = this.outline.captureSel();
		return s?.head.blockId ?? null;
	}

	private renderBar() {
		const st = this.state;
		this.btns.outline.classList.toggle("on", st.view === "outline");
		this.btns.map.classList.toggle("on", st.view === "map");
		this.btns.right.classList.toggle("on", st.layout === "right");
		this.btns.down.classList.toggle("on", st.layout === "down");
		this.frame.dataset.view = st.view;
		this.frame.dataset.layout = st.layout;
		// 不显示的那个视图对读屏隐藏
		this.scroller.setAttribute("aria-hidden", String(st.view !== "outline"));
		this.map.stage.setAttribute("aria-hidden", String(st.view !== "map"));
	}

	private crumbKey = "";
	/** 面包屑：页标题 › 祖先 … › 聚焦的块（聚焦的块或祖先改了文字也跟着变） */
	renderCrumbs() {
		const v = this.client.visible;
		const chain: string[] = [];
		let cur = this.state.focus;
		while (cur) {
			const b = v.get(cur);
			if (!b || b.parentId === null) break;
			chain.unshift(cur);
			cur = b.parentId;
		}
		const pageRoot = this.state.focus ? this.client.pageOf(this.state.focus) : this.pageId;
		const items: Array<{ id: string; text: string }> = [];
		items.push({
			id: pageRoot === this.pageId ? "" : pageRoot,
			text: v.get(pageRoot)?.content ?? pageRoot,
		});
		for (const id of chain)
			items.push({
				id,
				text: plainLine(this.client, this.client.textOf(id)).slice(0, 24) || "（空）",
			});
		const key = items.map((it) => `${it.id}\u0000${it.text}`).join("\u0001");
		if (key === this.crumbKey) return;
		this.crumbKey = key;
		this.crumbs.replaceChildren(
			...items.flatMap((it, i) => {
				const b = document.createElement("button");
				b.type = "button";
				b.dataset.crumb = it.id;
				b.textContent = it.text;
				if (i === items.length - 1) b.classList.add("here");
				if (i === 0) return [b];
				const sep = document.createElement("span");
				sep.className = "sep";
				sep.textContent = "›";
				return [sep, b];
			}),
		);
	}

	private onStoreChange() {
		// 聚焦的块被删了：退到还在的祖先
		const f = this.state.focus;
		if (f && !this.client.visible.alive(f)) {
			let cur = this.client.visible.get(f)?.parentId ?? null;
			while (cur && !this.client.visible.alive(cur))
				cur = this.client.visible.get(cur)?.parentId ?? null;
			const b = cur ? this.client.visible.get(cur) : null;
			this.focusBlock(b && b.parentId !== null ? cur : null, { push: false, animate: false });
		}
		if (this.state.focus) this.renderCrumbs();
		this.map.schedule();
	}

	// ---------- 选中 ----------

	setBlocks(ids: string[]) {
		this.state.blocks = ids;
		this.outline.setBlockSelection(ids);
		if (this.state.view === "map") this.map.render();
	}

	private onMapSelect(id: string | null) {
		const st = this.state;
		if (!id) return;
		if (st.caret?.blockId === id) return;
		st.caret = { blockId: id, anchor: -2, head: -2 };
	}

	/** 撤销 / 重做恢复选区：交给当前视图。 */
	restoreSel(sel: SelInfo): boolean {
		if (this.state.view === "outline") {
			if (sel.view === this.outline) return false;
			this.outline.applySelection({ ...sel, view: this.outline });
			return true;
		}
		const id = sel.head.blockId;
		this.state.caret = { blockId: id, anchor: sel.anchor.offset, head: sel.head.offset };
		const ed = this.map.editing;
		if (ed && ed.id === id) ed.view.applySelection({ ...sel, view: ed.view });
		else {
			this.map.flush();
			this.map.select(id);
		}
		return true;
	}

	/** 把当前视图里的光标 / 选中写进视图状态。 */
	captureCaret() {
		const st = this.state;
		if (st.view === "outline") {
			const s = this.outline.captureSel();
			if (s)
				st.caret = {
					blockId: s.head.blockId,
					anchor: s.anchor.blockId === s.head.blockId ? s.anchor.offset : s.head.offset,
					head: s.head.offset,
				};
			return;
		}
		const ed = this.map.editing;
		if (ed) {
			const s = ed.view.captureSel();
			if (s && s.head.blockId === ed.id)
				st.caret = {
					blockId: ed.id,
					anchor: s.anchor.blockId === ed.id ? s.anchor.offset : s.head.offset,
					head: s.head.offset,
				};
		} else if (this.map.selected && st.caret?.blockId !== this.map.selected)
			st.caret = { blockId: this.map.selected, anchor: -2, head: -2 };
	}

	/** 视图状态里的光标放回大纲（不滚动）。-2 = 只知道块，不知道偏移：放在块体末尾。 */
	private restoring = false;

	private applyCaretToOutline() {
		this.restoring = true;
		try {
			this.applyCaretInner();
			if (this.state.blocks.length || this.outline.hasBlockSelection)
				this.outline.setBlockSelection(this.state.blocks);
		} finally {
			this.restoring = false;
		}
	}

	private applyCaretInner() {
		const c = this.state.caret;
		if (!c || !this.client.visible.alive(c.blockId)) return;
		// 大纲里的选区已经是它（来回切换时常见）：不再派发事务
		const cur = this.outline.captureSel();
		if (
			cur &&
			cur.head.blockId === c.blockId &&
			cur.anchor.blockId === c.blockId &&
			cur.head.offset === c.head &&
			cur.anchor.offset === c.anchor
		)
			return;
		if (c.anchor === -2 || c.head === -2) {
			this.placeCaret(c.blockId);
			return;
		}
		this.outline.applySelection(
			{
				anchor: { blockId: c.blockId, offset: c.anchor },
				head: { blockId: c.blockId, offset: c.head },
				view: this.outline,
			},
			false,
		);
	}

	/** 大纲光标放到某块的块体末尾（表格放进第一个单元格、嵌入整块选中），不滚动。 */
	placeCaret(id: string) {
		const v = this.outline;
		const doc = v.pm.state.doc;
		const pos = findBlockPos(doc, id);
		if (pos == null) return;
		v.pm.dispatch(v.pm.state.tr.setSelection(caretIn(doc, pos, -1)).setMeta("remote", true));
	}

	// ---------- 大纲的几何（按块取屏幕位置） ----------

	private frameRect(): DOMRect {
		return this.frame.getBoundingClientRect();
	}

	/** 大纲里一块的块体元素 */
	rowBody(id: string): HTMLElement | null {
		const el = this.outline.blockEls.get(id);
		if (!el) return null;
		const content = el.querySelector(":scope > .ob-content");
		return (content?.firstElementChild as HTMLElement | null) ?? null;
	}

	/** 块体左上角相对编辑区的位置；块被折叠在别的块里时返回 null。 */
	rowPos(id: string, fr = this.frameRect()): Pos | null {
		const b = this.rowBody(id);
		if (!b) return null;
		const r = b.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) return null;
		return { x: r.left - fr.left, y: r.top - fr.top };
	}

	/** 大纲里展开可见的块（文档顺序，跳过折叠的子块） */
	outlineOrder(): string[] {
		const out: string[] = [];
		this.outline.pm.state.doc.descendants((n) => {
			if (n.type.name === "block") {
				out.push(n.attrs.id);
				return !n.attrs.collapsed;
			}
			return n.type.name === "children" || n.type.name === "outline";
		});
		return out;
	}

	/** 视口里的行：块体位置单调递增，二分找到第一行，再往后读到视口底部（只读几十个元素的位置）。 */
	outlineRows(margin = 0): Map<string, Pos> {
		const out = new Map<string, Pos>();
		const order = this.outlineOrder();
		if (!order.length) return out;
		const fr = this.frameRect();
		const top = -margin;
		const bottom = fr.height + margin;
		let lo = 0;
		let hi = order.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const el = this.rowBody(order[mid]);
			const r = el?.getBoundingClientRect();
			if (!r || r.bottom - fr.top < top) lo = mid + 1;
			else hi = mid;
		}
		for (let i = lo; i < order.length; i++) {
			const el = this.rowBody(order[i]);
			if (!el) continue;
			const r = el.getBoundingClientRect();
			if (r.top - fr.top > bottom) break;
			if (r.bottom - fr.top < top) continue;
			out.set(order[i], { x: r.left - fr.left, y: r.top - fr.top });
		}
		return out;
	}

	/** 锚点：上次的锚点块还在视口里就沿用（来回切换不漂），否则取离视口中心最近的块。 */
	private pickAnchor(
		cands: Map<string, Pos>,
		center: Pos,
	): { blockId: string; x: number; y: number } | null {
		const prev = this.state.anchor;
		if (prev && cands.has(prev.blockId)) {
			const p = cands.get(prev.blockId) as Pos;
			return { blockId: prev.blockId, x: p.x, y: p.y };
		}
		let best: { blockId: string; x: number; y: number } | null = null;
		let bd = Number.POSITIVE_INFINITY;
		for (const [id, p] of cands) {
			const d = Math.abs(p.y + 11 - center.y) * 2 + Math.abs(p.x - center.x) * 0.1;
			if (d < bd) {
				bd = d;
				best = { blockId: id, x: p.x, y: p.y };
			}
		}
		return best;
	}

	// ---------- 动画的收尾 ----------

	private track(kind: string, anims: Animation[], done: () => void, t0: number) {
		const t: Transition = { kind, anims, done, t0 };
		this.log.push({
			kind,
			setupMs: performance.now() - t0,
			animated: anims.length,
			at: t0,
			parts: this.parts,
			anchor: this.state.anchor ? { ...this.state.anchor } : null,
		});
		this.parts = {};
		if (this.log.length > 500) this.log.splice(0, 250);
		const entry = this.log[this.log.length - 1];
		if (!anims.length) {
			done();
			entry.doneAt = performance.now();
			return;
		}
		this.transition = t;
		Promise.all(anims.map((a) => a.finished)).then(
			() => {
				if (this.transition !== t) return;
				this.transition = null;
				done();
				entry.doneAt = performance.now();
			},
			() => {},
		);
	}

	/** 正在进行的动画直接跳到结束（新的切换、聚焦开始前调用，状态不会叠在半截动画上）。 */
	finishTransition() {
		this.flushPending();
		const t = this.transition;
		if (!t) return;
		this.transition = null;
		for (const a of t.anims) {
			try {
				a.finish();
			} catch {}
		}
		t.done();
	}

	get animating() {
		return this.pending !== null || this.transition !== null;
	}

	/**
	 * 切换分两帧做：调用时只算（读位置、算布局，不改 DOM，或只改看不见的 DOM），这一帧画完之后再改看得见的 DOM、
	 * 起动画。单帧的活儿少一半，用户感知只晚一帧。新的切换、按键、指针按下会先把没做完的第二步做掉。
	 * reduced motion 时直接做。
	 */
	private pending: { run: () => void } | null = null;
	private defer(run: () => void) {
		if (reducedMotion()) {
			run();
			return;
		}
		const p = {
			run: () => {
				if (this.pending !== p) return;
				this.pending = null;
				run();
			},
		};
		this.pending = p;
		requestAnimationFrame(() => {
			const ch = new MessageChannel();
			ch.port1.onmessage = () => p.run();
			ch.port2.postMessage(0);
		});
	}

	flushPending() {
		this.pending?.run();
	}

	// ---------- 视图切换 ----------

	setView(kind: ViewKind) {
		if (this.state.view === kind) return;
		// 工具栏和编辑区的 data-view 由各自的切换步骤在合适的那一帧更新
		if (kind === "map") this.toMap();
		else this.toOutline();
		this.state.emit("view");
	}

	private toMap() {
		this.finishTransition();
		const t0 = performance.now();
		const st = this.state;
		this.captureCaret();
		// 先只读：大纲的可见行、锚点；导图的布局和平移只是计算（不碰 DOM），
		// 切换后进入视口的块在大纲里的位置也在这里读（大纲还没隐藏，布局是现成的）
		const fr = this.frameRect();
		const rows = this.outlineRows();
		const anchor = this.pickAnchor(rows, { x: fr.width / 2, y: fr.height / 2 });
		const hadFocus = this.panel.contains(document.activeElement);
		const map = this.map;
		const t1 = performance.now();
		map.prepare(fr.width, fr.height);
		if (anchor && map.info.has(anchor.blockId)) map.placeBody(anchor.blockId, anchor.x, anchor.y);
		else map.placeRoot();
		const after = map.visibleIds(0);
		const t2 = performance.now();
		// 只给切换前或切换后在视口里的块做位移动画
		const from = new Map<string, Pos>();
		for (const [id, p] of rows) if (map.info.has(id)) from.set(id, p);
		for (const id of after) {
			if (from.has(id)) continue;
			const p = this.rowPos(id, fr);
			if (p) from.set(id, p);
		}
		const fadeIn = after.filter((id) => !from.has(id));
		st.view = "map";
		st.anchor = anchor;
		this.outline.noScroll = true;
		const sel = st.caret?.blockId;
		map.selected = sel && map.info.has(sel) ? sel : null;
		// 节点 DOM 先建在透明的舞台里（这一帧排版、绘制节点）；键盘焦点马上给舞台，之后的按键落在导图上
		for (const id of from.keys()) map.force.add(id);
		map.render(true);
		map.stage.classList.add("pre");
		if (hadFocus || document.activeElement === document.body) map.focusStage();
		else {
			const sel = document.getSelection();
			if (sel?.anchorNode && this.scroller.contains(sel.anchorNode)) sel.removeAllRanges();
		}
		const t3 = performance.now();
		this.parts = { read: t1 - t0, layout: t2 - t1, render: t3 - t2 };
		const parts = this.parts;
		this.defer(() => {
			// 第二帧：显示导图、隐藏大纲、起动画
			const t4 = performance.now();
			map.stage.classList.remove("pre");
			this.renderBar();
			map.activate();
			map.render();
			const anims = reducedMotion() ? [] : map.flipFrom(from, fadeIn, DURATION);
			this.parts = { ...parts, show: performance.now() - t4 };
			this.track(
				"toMap",
				anims,
				() => {
					map.force.clear();
					map.render();
				},
				t0,
			);
		});
	}

	private toOutline() {
		this.finishTransition();
		const t0 = performance.now();
		const st = this.state;
		const map = this.map;
		map.flush();
		this.captureCaret();
		const cands = new Map<string, Pos>();
		for (const id of map.visibleIds(0)) {
			const p = map.bodyScreen(id);
			if (p && id !== this.pageId) cands.set(id, p);
		}
		const anchor = this.pickAnchor(cands, { x: map.width / 2, y: map.height / 2 });
		const hadFocus = this.panel.contains(document.activeElement);
		map.exitEdit(false);
		st.view = "outline";
		st.anchor = anchor;
		this.outline.noScroll = false;
		this.renderBar();
		this.frame.classList.add("morphing");
		// 光标和键盘焦点马上给大纲（还透明，但能接按键和输入法；不经 keydown 的输入也落在对的位置）
		this.applyCaretToOutline();
		if (hadFocus || document.activeElement === document.body) {
			this.restoring = true;
			this.outline.pm.focus();
			this.restoring = false;
		}
		const t1 = performance.now();
		const parts0 = { map: t1 - t0 };
		// 这一帧只把大纲解锁（还透明），第二帧再读行的位置、放光标、起动画（解锁后的排版 / 绘制在这一帧做掉）
		this.defer(() => {
			const t2 = performance.now();
			// 先只读：大纲滚动到锚点块落在原来的屏幕位置，读出切换后视口里的行和导图可见节点在大纲里的位置
			const fr = this.frameRect();
			if (anchor) {
				const p = this.rowPos(anchor.blockId, fr);
				// 来回切换时通常已经在原位：不写 scrollTop（写了会触发一次悬停命中测试）
				if (p && Math.abs(p.y - anchor.y) >= 0.5) this.scroller.scrollTop += p.y - anchor.y;
			}
			const rows = this.outlineRows();
			const to = new Map<string, Pos>(rows);
			for (const id of cands.keys()) {
				if (to.has(id)) continue;
				const p = this.rowPos(id, fr);
				if (p) to.set(id, p);
			}
			const t3 = performance.now();
			const t4 = t3;
			let anims: Animation[] = [];
			if (!reducedMotion()) {
				map.materialize([...to.keys()].filter((id) => map.info.has(id)));
				anims = map.morphTo(to, DURATION);
			}
			this.parts = { ...parts0, read: t3 - t2, caret: t4 - t3, anim: performance.now() - t4 };
			this.track(
				"toOutline",
				anims,
				() => {
					for (const a of anims) a.cancel();
					map.force.clear();
					map.deactivate();
					this.frame.classList.remove("morphing");
				},
				t0,
			);
		});
	}

	setLayout(dir: Dir) {
		const st = this.state;
		if (st.layout === dir) return;
		if (st.view !== "map") {
			st.layout = dir;
			this.map.schedule();
			this.renderBar();
			return;
		}
		this.finishTransition();
		const t0 = performance.now();
		const map = this.map;
		map.flush();
		const old = new Map<string, Pos>();
		for (const id of map.visibleIds(0)) {
			const p = map.bodyScreen(id);
			if (p) old.set(id, p);
		}
		const anchor = this.pickAnchor(old, { x: map.width / 2, y: map.height / 2 });
		// 切换前不在视口里的块，也要知道它们的旧位置（切换后进入视口的从那里移过来）
		const oldAll = new Map<string, Pos>();
		for (const id of map.order) {
			const p = map.bodyScreen(id);
			if (p) oldAll.set(id, p);
		}
		st.layout = dir;
		st.anchor = anchor;
		map.relayout();
		if (anchor) map.placeBody(anchor.blockId, anchor.x, anchor.y);
		else map.placeRoot();
		const from = new Map<string, Pos>(old);
		for (const id of map.visibleIds(0))
			if (!from.has(id) && oldAll.has(id)) from.set(id, oldAll.get(id) as Pos);
		this.parts = { layout: performance.now() - t0 };
		const parts = this.parts;
		// 第二帧：节点挪到新位置、起动画（同一帧里做，避免先闪一下终态）
		this.defer(() => {
			const t1 = performance.now();
			this.renderBar();
			for (const id of from.keys()) map.force.add(id);
			map.render();
			const anims = reducedMotion() ? [] : map.flipFrom(from, [], DURATION);
			this.parts = { ...parts, show: performance.now() - t1 };
			this.track(
				"layout",
				anims,
				() => {
					map.force.clear();
					map.render();
				},
				t0,
			);
		});
		this.state.emit("layout");
	}

	// ---------- 折叠 ----------

	toggleCollapse(id: string) {
		const c = this.state.collapsed;
		if (c.has(id)) c.delete(id);
		else c.add(id);
		this.syncOutlines();
		this.map.schedule();
		if (this.state.view === "map") this.map.flush();
		this.state.emit("collapsed");
	}

	/** 聚焦子树里的块（不含聚焦的根），带层级（根的子块是第 1 层） */
	private subtree(): Array<{ id: string; depth: number; kids: number }> {
		const v = this.client.visible;
		const root = this.state.focus ?? this.pageId;
		const out: Array<{ id: string; depth: number; kids: number }> = [];
		const walk = (id: string, depth: number) => {
			const kids = v.children(id);
			if (id !== root) out.push({ id, depth, kids: kids.length });
			for (const k of kids) walk(k, depth + 1);
		};
		walk(root, 0);
		return out;
	}

	private applyCollapse() {
		this.syncOutlines();
		this.map.schedule();
		if (this.state.view === "map") this.map.flush();
		this.state.emit("collapsed");
	}

	collapseAll() {
		for (const b of this.subtree()) if (b.kids) this.state.collapsed.add(b.id);
		this.applyCollapse();
	}

	expandAll() {
		for (const b of this.subtree()) this.state.collapsed.delete(b.id);
		this.applyCollapse();
	}

	/** Alt+N：展开到第 N 层（第 N 层及更深的块折叠） */
	expandToLevel(n: number) {
		for (const b of this.subtree()) {
			if (b.kids && b.depth >= n) this.state.collapsed.add(b.id);
			else this.state.collapsed.delete(b.id);
		}
		this.applyCollapse();
	}

	// ---------- 聚焦 ----------

	focusUp() {
		const f = this.state.focus;
		if (!f) return;
		const p = this.client.visible.get(f)?.parentId ?? null;
		const pb = p ? this.client.visible.get(p) : null;
		this.focusBlock(pb && pb.parentId !== null ? p : null);
	}

	focusBlock(id: string | null, opts: { push?: boolean; animate?: boolean } = {}) {
		const st = this.state;
		if (id === this.pageId) id = null;
		if (id && !this.client.visible.alive(id)) return;
		if (st.focus === id) return;
		this.finishTransition();
		const t0 = performance.now();
		const prev = st.focus;
		const animate = opts.animate !== false && !reducedMotion();
		if (st.view === "map") this.zoomMap(id, animate, t0);
		else this.zoomOutline(prev, id, animate, t0);
		noteVisit(id ?? this.pageId);
		this.renderCrumbs();
		if (opts.push !== false) focusHistory?.push(this);
		st.emit("focus");
	}

	private zoomOutline(prev: string | null, id: string | null, animate: boolean, t0: number) {
		const st = this.state;
		const fr = this.frameRect();
		// 放大：被聚焦的块从它原来的位置放大到根的位置；缩小：反过来
		const before = id ? this.rowPos(id, fr) : prev ? this.rowPos(prev, fr) : null;
		const caret = this.outline.captureSel();
		const hadFocus = this.panel.contains(document.activeElement);
		st.focus = id;
		this.setOutlineFocus(id);
		this.map.schedule();
		if (id) this.scroller.scrollTop = 0;
		else if (prev && before) {
			const p = this.rowPos(prev, fr);
			if (p) this.scroller.scrollTop += p.y - before.y;
		}
		// 光标在新的根下面就带过去，否则放到根的末尾
		const root = id ?? this.client.visible.children(this.pageId)[0];
		const inside = caret && this.inFocus(caret.head.blockId);
		this.restoring = true;
		if (inside && caret) this.outline.applySelection({ ...caret, view: this.outline }, false);
		else if (root) this.placeCaret(root);
		if (hadFocus) this.outline.pm.focus();
		this.restoring = false;
		const after = id ? this.rowPos(id, fr) : prev ? this.rowPos(prev, fr) : null;
		const anims: Animation[] = [];
		if (animate && before && after) {
			const dx = before.x - after.x;
			const dy = before.y - after.y;
			const dom = this.outline.pm.dom as HTMLElement;
			dom.style.transformOrigin = `${after.x}px ${after.y + this.scroller.scrollTop}px`;
			anims.push(
				dom.animate(
					[
						{ transform: `translate(${dx}px, ${dy}px) scale(${id ? 0.85 : 1.15})`, opacity: 0.4 },
						{ transform: "none", opacity: 1 },
					],
					{ duration: DURATION, easing: "ease" },
				),
			);
		}
		this.track(id ? "focusIn" : "focusOut", anims, () => {}, t0);
	}

	private inFocus(blockId: string): boolean {
		const f = this.state.focus;
		if (!f) return this.client.pageOf(blockId) === this.pageId;
		return blockId === f || this.client.visible.isAncestor(f, blockId);
	}

	private zoomMap(id: string | null, animate: boolean, t0: number) {
		const st = this.state;
		const map = this.map;
		map.flush();
		const oldPos = new Map<string, Pos>();
		for (const oid of map.order) {
			const p = map.bodyScreen(oid);
			if (p) oldPos.set(oid, p);
		}
		const visBefore = new Set(map.visibleIds(0));
		const oldEls = [...map.els.keys()];
		st.focus = id;
		this.setOutlineFocus(id);
		map.relayout();
		map.placeRoot();
		const ghosts = oldEls.filter((x) => !map.info.has(x));
		const anims: Animation[] = map.fadeOutGhosts(ghosts, animate ? DURATION * 0.6 : 0);
		const from = new Map<string, Pos>();
		const fadeIn: string[] = [];
		for (const vid of [...visBefore, ...map.visibleIds(0)]) {
			if (!map.info.has(vid) || from.has(vid)) continue;
			const p = oldPos.get(vid);
			if (p) from.set(vid, p);
			else fadeIn.push(vid);
		}
		for (const k of from.keys()) map.force.add(k);
		const sel = map.selected && map.info.has(map.selected) ? map.selected : (id ?? this.pageId);
		map.select(sel, { reveal: false });
		if (animate) anims.push(...map.flipFrom(from, fadeIn, DURATION));
		this.track(
			id ? "focusIn" : "focusOut",
			anims,
			() => {
				map.force.clear();
				map.render();
			},
			t0,
		);
	}
}

// ---------- 聚焦写进地址栏：前进后退走聚焦历史 ----------

export let activeSurface: EditSurface | null = null;

export class FocusHistory {
	surfaces = new Map<string, EditSurface>();
	private applying = false;

	constructor(public primary: string) {
		window.addEventListener("popstate", (e) => this.apply(e.state));
	}

	add(key: string, s: EditSurface) {
		this.surfaces.set(key, s);
		activeSurface ??= s;
	}

	private snapshot() {
		const focus: Record<string, string | null> = {};
		for (const [k, s] of this.surfaces) focus[k] = s.state.focus;
		return { focus };
	}

	private url(): string {
		const s = this.surfaces.get(this.primary);
		if (!s) return location.href;
		const f = s.state.focus;
		const base = `${location.pathname}${location.search}`;
		return f ? `${base}#/outline/${s.client.pageOf(f)}/${f}` : `${base}#/outline/${s.pageId}`;
	}

	push(_from: EditSurface) {
		if (this.applying) return;
		window.history.pushState(this.snapshot(), "", this.url());
	}

	replace() {
		window.history.replaceState(this.snapshot(), "", this.url());
	}

	private apply(state: { focus?: Record<string, string | null> } | null) {
		this.applying = true;
		try {
			for (const [k, s] of this.surfaces) s.focusBlock(state?.focus?.[k] ?? null, { push: false });
		} finally {
			this.applying = false;
		}
	}

	/** 地址栏里的聚焦（#/outline/<页>/<块>） */
	static fromHash(): string | null {
		const m = /^#\/outline\/[^/]+\/([^/]+)$/.exec(location.hash);
		return m ? decodeURIComponent(m[1]) : null;
	}
}

let focusHistory: FocusHistory | null = null;
export function setHistory(h: FocusHistory) {
	focusHistory = h;
}
