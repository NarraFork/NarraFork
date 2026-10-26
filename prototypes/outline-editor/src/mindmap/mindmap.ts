/**
 * 导图视图（§6.10）：同一个编辑面的另一种投影。
 *
 * - 节点是原生 DOM（不用 React、不用 @xyflow/react），绝对定位在一个做了平移缩放的容器里；连线画在一层 SVG 上。
 *   只为视口附近的节点建 DOM（切换动画要用的节点临时加进来）；节点尺寸用 pretext 免 DOM 测量（measure.ts）。
 * - 结构键位（Tab / Enter / Shift-Tab / Alt+方向键 / 拖动 / Mod-Enter / Delete）都在编辑面的大纲文档上执行
 *   同一套 ProseMirror 命令（commands.ts），经同一个 reconcile 变成大纲事务、进同一个撤销栈，
 *   所以和在大纲里做同样的操作结果一致，并发和撤销也照常。
 * - 编辑：节点里放一个只编辑这一块的 OutlineView（surface kind "node"），同一份 schema、方言、输入法处理。
 * - 折叠、聚焦、选中、布局方向放在视图状态（viewstate.ts）里，和大纲共用。
 */
import type { Command } from "prosemirror-state";
import {
	applyChrome,
	createGutter,
	type Gutter,
	mentionLabel,
	renderBody,
	TASK_NEXT,
} from "../client/chrome";
import type { Client, SelInfo } from "../client/client";
import {
	addChild,
	addTopLevel,
	caretIn,
	type DropWhere,
	deleteBlock,
	moveBlock,
	moveBlockTo,
	outdent,
	toggleTask,
} from "../client/commands";
import { findBlockPos, type OutlineView, OutlineView as OV } from "../client/view";
import type { ViewState } from "../client/viewstate";
import { type Dir, type LNode, layoutTree } from "./layout";
import { bodySize, NODE, nodeSize } from "./measure";

export interface MapHost {
	client: Client;
	state: ViewState;
	/** 编辑面的大纲视图：结构命令在它的文档上执行 */
	outline: OutlineView;
	pageId: string;
	label: string;
	focusBlock(id: string | null): void;
	focusUp(): void;
	toggleCollapse(id: string): void;
	surfaceKeys(): Record<string, Command>;
	restoreSel(sel: SelInfo): boolean;
	/** 导图里的选中变了（同步到视图状态） */
	onSelect(id: string | null): void;
}

interface NInfo {
	node: LNode;
	parent: string | null;
	content: string;
	task: string | null;
	hasKids: boolean;
	collapsed: boolean;
	hidden: number;
	bodyW: number;
	index: number;
}

interface NodeEl {
	el: HTMLElement;
	g: Gutter;
	body: HTMLElement;
	more: HTMLElement;
	key: string;
	x: number;
	y: number;
	w: number;
}

export const GAP = {
	right: { gapDepth: 44, gapSibling: 8 },
	down: { gapDepth: 40, gapSibling: 14 },
};

const MARGIN = 320;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class MindMapView {
	stage: HTMLElement;
	world: HTMLElement;
	svg: SVGSVGElement;
	edges: SVGPathElement;
	dropMark: HTMLElement;
	tx = 40;
	ty = 40;
	scale = 1;
	active = false;
	info = new Map<string, NInfo>();
	order: string[] = [];
	rootId = "";
	els = new Map<string, NodeEl>();
	/** 动画期间必须有 DOM 的节点 */
	force = new Set<string>();
	selected: string | null = null;
	editing: {
		id: string;
		view: OutlineView;
		ro: ResizeObserver;
		size: { w: number; h: number } | null;
		mount: HTMLElement;
		onKey: (e: KeyboardEvent) => void;
	} | null = null;
	private sizes = new Map<
		string,
		{ content: string; task: string | null; w: number; h: number; bodyW: number }
	>();
	private dirtyLayout = true;
	private dirtyRender = true;
	private raf = 0;
	private stageW = 0;
	private stageH = 0;
	private layoutDir: Dir = "right";
	private edgeKey = "";
	stats = {
		layouts: [] as number[],
		measureMs: [] as number[],
		treeMs: [] as number[],
		renders: [] as number[],
		nodesInDom: 0,
	};

	constructor(
		public host: MapHost,
		frame: HTMLElement,
	) {
		this.stage = document.createElement("div");
		this.stage.className = "mm-stage";
		this.stage.tabIndex = 0;
		this.stage.dataset.label = host.label;
		this.world = document.createElement("div");
		this.world.className = "mm-world";
		this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		this.svg.setAttribute("class", "mm-edges");
		this.edges = document.createElementNS("http://www.w3.org/2000/svg", "path");
		this.svg.append(this.edges);
		this.dropMark = document.createElement("div");
		this.dropMark.className = "mm-drop";
		this.world.append(this.svg, this.dropMark);
		this.stage.append(this.world);
		frame.append(this.stage);
		// 舞台尺寸由 ResizeObserver 给（构造时不读 clientWidth：会把整页大纲的排版强制提前）
		new ResizeObserver((es) => {
			const r = es[es.length - 1].contentRect;
			this.stageW = r.width;
			this.stageH = r.height;
			this.schedule(false);
		}).observe(this.stage);
		this.stage.addEventListener("keydown", (e) => this.onKey(e));
		this.stage.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
		this.stage.addEventListener("pointerdown", (e) => this.onPointerDown(e));
		this.stage.addEventListener("pointermove", (e) => this.onPointerMove(e));
		this.stage.addEventListener("pointerup", (e) => this.onPointerUp(e));
		this.stage.addEventListener("pointercancel", (e) => this.onPointerUp(e, true));
		this.applyTransform();
	}

	get client() {
		return this.host.client;
	}

	get dir(): Dir {
		return this.host.state.layout;
	}

	// ---------- 布局 ----------

	/** 存储 / 视图状态变了：下一帧重新布局并渲染（同一帧里多次合并）。 */
	schedule(layout = true) {
		if (layout) this.dirtyLayout = true;
		this.dirtyRender = true;
		if (!this.active || this.raf) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			this.flush();
		});
	}

	/** 立即把布局和 DOM 更新到最新（测试和切换动画用）。 */
	flush() {
		if (this.raf) {
			cancelAnimationFrame(this.raf);
			this.raf = 0;
		}
		if (this.dirtyLayout) this.relayout();
		if (this.dirtyRender) this.render();
	}

	private labelOf = (ref: string, label: string | null) => mentionLabel(this.client, ref, label);

	relayout() {
		const t0 = performance.now();
		const client = this.client;
		const v = client.visible;
		const st = this.host.state;
		const rootId = st.focus && v.alive(st.focus) ? st.focus : this.host.pageId;
		this.rootId = rootId;
		const info = new Map<string, NInfo>();
		const order: string[] = [];
		let measureMs = 0;
		const build = (id: string, parent: string | null, depth: number, index: number): LNode => {
			const rec = v.get(id);
			const content = id === this.host.pageId ? (rec?.content ?? "") : client.textOf(id);
			const task = id === this.host.pageId ? null : (rec?.task ?? null);
			const kidsIds = depth > 100 ? [] : v.children(id);
			const collapsed = id !== rootId && st.collapsed.has(id) && kidsIds.length > 0;
			let w: number;
			let h: number;
			let bodyW: number;
			const ed = this.editing;
			// 按块缓存尺寸：正文和任务状态没变就不再查测量缓存（有提及的块每次查：目标的文字可能变了）
			let sz = this.sizes.get(id);
			if (!sz || sz.content !== content || sz.task !== task || content.includes("[[")) {
				const m0 = performance.now();
				const ns = nodeSize(bodySize(content, this.labelOf), !!task);
				measureMs += performance.now() - m0;
				sz = { content, task, ...ns };
				this.sizes.set(id, sz);
			}
			if (ed && ed.id === id && ed.size) {
				w = ed.size.w;
				h = ed.size.h;
				bodyW = sz.bodyW;
			} else {
				w = sz.w;
				h = sz.h;
				bodyW = sz.bodyW;
			}
			const node: LNode = { id, w, h, kids: [], x: 0, y: 0, depth };
			order.push(id);
			info.set(id, {
				node,
				parent,
				content,
				task,
				hasKids: kidsIds.length > 0,
				collapsed,
				hidden: collapsed ? kidsIds.length : 0,
				bodyW,
				index,
			});
			if (!collapsed) {
				node.kids = new Array(kidsIds.length);
				for (let i = 0; i < kidsIds.length; i++) node.kids[i] = build(kidsIds[i], id, depth + 1, i);
			}
			return node;
		};
		const root = build(rootId, null, 0, 0);
		const t1 = performance.now();
		layoutTree(root, { dir: this.dir, ...GAP[this.dir] });
		const t2 = performance.now();
		this.info = info;
		this.order = order;
		this.layoutDir = this.dir;
		this.dirtyLayout = false;
		this.dirtyRender = true;
		this.stats.layouts.push(t2 - t0);
		this.stats.measureMs.push(measureMs);
		this.stats.treeMs.push(t2 - t1);
		if (this.stats.layouts.length > 5000) this.stats.layouts.splice(0, 2500);
		// 正在编辑的块不在了（被删除、被折叠进去、聚焦到别处）：退出编辑
		if (this.editing && !info.has(this.editing.id)) this.exitEdit(false);
		if (this.selected && !info.has(this.selected)) this.selected = null;
	}

	// ---------- 坐标 ----------

	/** 块体左上角相对节点左上角的偏移（世界坐标单位） */
	bodyOffset(id: string): { x: number; y: number } {
		const inf = this.info.get(id);
		const gutter = NODE.gutter + (inf?.task ? NODE.check : 0);
		return { x: NODE.border + NODE.padX + gutter, y: NODE.border + NODE.padY };
	}

	toScreen(wx: number, wy: number) {
		return { x: this.tx + this.scale * wx, y: this.ty + this.scale * wy };
	}

	/** 块体左上角的屏幕位置（相对舞台） */
	bodyScreen(id: string): { x: number; y: number } | null {
		const inf = this.info.get(id);
		if (!inf) return null;
		const o = this.bodyOffset(id);
		return this.toScreen(inf.node.x + o.x, inf.node.y + o.y);
	}

	nodeScreenRect(id: string) {
		const inf = this.info.get(id);
		if (!inf) return null;
		const p = this.toScreen(inf.node.x, inf.node.y);
		return { x: p.x, y: p.y, w: inf.node.w * this.scale, h: inf.node.h * this.scale };
	}

	/** 和舞台相交的节点（按布局算，不读 DOM） */
	visibleIds(margin = 0): string[] {
		const out: string[] = [];
		const s = this.scale;
		const x0 = (-margin - this.tx) / s;
		const y0 = (-margin - this.ty) / s;
		const x1 = (this.stageW + margin - this.tx) / s;
		const y1 = (this.stageH + margin - this.ty) / s;
		for (const id of this.order) {
			const n = (this.info.get(id) as NInfo).node;
			if (n.x < x1 && n.x + n.w > x0 && n.y < y1 && n.y + n.h > y0) out.push(id);
		}
		return out;
	}

	/** 离舞台中心最近的节点 */
	nearestCenter(): string | null {
		const cx = (this.stageW / 2 - this.tx) / this.scale;
		const cy = (this.stageH / 2 - this.ty) / this.scale;
		let best: string | null = null;
		let bd = Number.POSITIVE_INFINITY;
		for (const id of this.visibleIds()) {
			const n = (this.info.get(id) as NInfo).node;
			const dx = Math.max(n.x - cx, 0, cx - (n.x + n.w));
			const dy = Math.max(n.y - cy, 0, cy - (n.y + n.h));
			const d = dx * dx + dy * dy;
			if (d < bd) {
				bd = d;
				best = id;
			}
		}
		return best;
	}

	/** 平移，让某块的块体左上角落在舞台坐标 (sx, sy)。 */
	placeBody(id: string, sx: number, sy: number) {
		const inf = this.info.get(id);
		if (!inf) return;
		const o = this.bodyOffset(id);
		this.tx = sx - this.scale * (inf.node.x + o.x);
		this.ty = sy - this.scale * (inf.node.y + o.y);
		this.applyTransform();
	}

	/** 把根放到「根的位置」：向右展开时在左侧垂直居中，向下展开时在上方水平居中。 */
	placeRoot() {
		const inf = this.info.get(this.rootId);
		if (!inf) return;
		const n = inf.node;
		if (this.dir === "right") {
			this.tx = 24 - this.scale * n.x;
			this.ty = this.stageH / 2 - this.scale * (n.y + n.h / 2);
		} else {
			this.tx = this.stageW / 2 - this.scale * (n.x + n.w / 2);
			this.ty = 24 - this.scale * n.y;
		}
		this.applyTransform();
	}

	/** 整棵树放进舞台（最小缩放 0.2）。 */
	fit() {
		if (this.dirtyLayout) this.relayout();
		let x0 = Number.POSITIVE_INFINITY;
		let y0 = Number.POSITIVE_INFINITY;
		let x1 = Number.NEGATIVE_INFINITY;
		let y1 = Number.NEGATIVE_INFINITY;
		for (const inf of this.info.values()) {
			const n = inf.node;
			x0 = Math.min(x0, n.x);
			y0 = Math.min(y0, n.y);
			x1 = Math.max(x1, n.x + n.w);
			y1 = Math.max(y1, n.y + n.h);
		}
		if (!Number.isFinite(x0)) return;
		const pad = 24;
		const s = Math.max(
			0.2,
			Math.min(1, (this.stageW - pad * 2) / (x1 - x0), (this.stageH - pad * 2) / (y1 - y0)),
		);
		this.setTransform(
			(this.stageW - (x1 - x0) * s) / 2 - x0 * s,
			(this.stageH - (y1 - y0) * s) / 2 - y0 * s,
			s,
		);
		this.flush();
	}

	setTransform(tx: number, ty: number, s = this.scale) {
		this.tx = tx;
		this.ty = ty;
		this.scale = Math.min(3, Math.max(0.1, s));
		this.applyTransform();
		this.schedule(false);
	}

	private applyTransform() {
		this.world.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
	}

	/** 选中的节点不在视口里就平移过去。 */
	ensureVisible(id: string) {
		const r = this.nodeScreenRect(id);
		if (!r) return;
		const pad = 24;
		let dx = 0;
		let dy = 0;
		if (r.x < pad) dx = pad - r.x;
		else if (r.x + r.w > this.stageW - pad)
			dx = Math.max(pad - r.x, this.stageW - pad - (r.x + r.w));
		if (r.y < pad) dy = pad - r.y;
		else if (r.y + r.h > this.stageH - pad)
			dy = Math.max(pad - r.y, this.stageH - pad - (r.y + r.h));
		if (dx || dy) this.setTransform(this.tx + dx, this.ty + dy);
	}

	// ---------- 渲染 ----------

	/** hidden = true：舞台还没显示也建 DOM（切换的第一帧，只排版不绘制） */
	render(hidden = false) {
		if (!this.active && !hidden) return;
		const t0 = performance.now();
		this.dirtyRender = false;
		const want = new Set(this.visibleIds(MARGIN));
		for (const id of this.force) if (this.info.has(id)) want.add(id);
		if (this.editing) want.add(this.editing.id);
		for (const [id, ne] of this.els) {
			if (!want.has(id) || !this.info.has(id)) {
				ne.el.remove();
				this.els.delete(id);
			}
		}
		const presence = new Map<string, string>();
		for (const [cid, pr] of this.client.presence)
			if (cid !== this.client.id) presence.set(pr.blockId, pr.color);
		for (const id of want) this.updateEl(id, presence.get(id));
		this.renderEdges();
		this.stats.nodesInDom = this.els.size;
		this.stats.renders.push(performance.now() - t0);
		if (this.stats.renders.length > 5000) this.stats.renders.splice(0, 2500);
	}

	private updateEl(id: string, peer: string | undefined) {
		const inf = this.info.get(id) as NInfo;
		let ne = this.els.get(id);
		if (!ne) {
			ne = this.createEl(id);
			this.els.set(id, ne);
			this.world.append(ne.el);
		}
		const editing = this.editing?.id === id;
		const key = `${inf.content}\u0000${inf.task}\u0000${inf.hasKids}\u0000${inf.collapsed}\u0000${inf.hidden}`;
		if (ne.key !== key) {
			ne.key = key;
			applyChrome(ne.el, ne.g, { hasKids: inf.hasKids, collapsed: inf.collapsed, task: inf.task });
			if (!editing) {
				ne.body.replaceChildren(renderBody(inf.content, this.client));
				ne.body.style.width = `${inf.bodyW}px`;
			}
			ne.more.textContent = inf.hidden ? `+${inf.hidden}` : "";
			ne.el.classList.toggle("is-root", id === this.rootId);
			ne.el.classList.toggle("is-page", id === this.host.pageId);
		}
		ne.el.classList.toggle("is-root", id === this.rootId);
		const n = inf.node;
		if (!editing && ne.w !== n.w) {
			ne.w = n.w;
			ne.el.style.width = `${n.w}px`;
		}
		if (ne.x !== n.x || ne.y !== n.y) {
			ne.x = n.x;
			ne.y = n.y;
			ne.el.style.transform = `translate(${n.x}px, ${n.y}px)`;
		}
		ne.el.classList.toggle("sel", this.selected === id);
		ne.el.classList.toggle("msel", this.host.state.blocks.includes(id));
		if (peer) {
			ne.el.classList.add("ob-peer");
			ne.el.style.setProperty("--peer", peer);
		} else if (ne.el.classList.contains("ob-peer")) ne.el.classList.remove("ob-peer");
	}

	private createEl(id: string): NodeEl {
		const el = document.createElement("div");
		el.className = "mm-node";
		el.dataset.id = id;
		const g = createGutter();
		const body = document.createElement("div");
		body.className = "mm-body ob-content";
		const more = document.createElement("span");
		more.className = "mm-more";
		el.append(g.el, body, more);
		return { el, g, body, more, key: "", x: Number.NaN, y: Number.NaN, w: -1 };
	}

	private renderEdges() {
		const key = `${this.layoutDir}:${this.order.length}:${this.stats.layouts.length}`;
		if (key === this.edgeKey) return;
		this.edgeKey = key;
		const parts: string[] = [];
		const right = this.layoutDir === "right";
		for (const id of this.order) {
			const inf = this.info.get(id) as NInfo;
			if (!inf.parent) continue;
			const p = (this.info.get(inf.parent) as NInfo).node;
			const c = inf.node;
			if (right) {
				const x1 = p.x + p.w;
				const y1 = p.y + p.h / 2;
				const x2 = c.x;
				const y2 = c.y + c.h / 2;
				const mx = (x1 + x2) / 2;
				parts.push(`M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`);
			} else {
				const x1 = p.x + p.w / 2;
				const y1 = p.y + p.h;
				const x2 = c.x + c.w / 2;
				const y2 = c.y;
				const my = (y1 + y2) / 2;
				parts.push(`M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}`);
			}
		}
		this.edges.setAttribute("d", parts.join(""));
	}

	el(id: string): HTMLElement | null {
		return this.els.get(id)?.el ?? null;
	}

	/** 让这些节点有 DOM（动画用），并立刻渲染。 */
	materialize(ids: Iterable<string>) {
		for (const id of ids) this.force.add(id);
		this.render();
	}

	get width() {
		return this.stageW;
	}

	get height() {
		return this.stageH;
	}

	/** 切换前的准备：只算布局（不碰 DOM）。舞台和编辑区一样大，尺寸由调用方给出，避免强制排版。 */
	prepare(w: number, h: number) {
		this.stageW = w;
		this.stageH = h;
		// 布局不依赖舞台尺寸：上次切走之后块树、折叠、聚焦、方向都没变就不用重算
		if (this.dirtyLayout) this.relayout();
	}

	activate() {
		this.active = true;
		this.stage.classList.add("active");
		if (this.dirtyLayout) this.relayout();
	}

	deactivate() {
		this.exitEdit(false);
		this.active = false;
		this.stage.classList.remove("active");
	}

	// ---------- 选中与编辑 ----------

	select(id: string | null, opts: { focus?: boolean; reveal?: boolean } = {}) {
		if (this.dirtyLayout) this.relayout();
		if (id && !this.info.has(id)) return;
		if (this.editing && this.editing.id !== id) this.exitEdit(false);
		this.selected = id;
		this.host.onSelect(id);
		if (id && id !== this.host.pageId) {
			this.client.openBlock(id);
			const pageId = this.client.pageOf(id);
			if (pageId) this.client.sendPresence(pageId, id, 0);
		}
		if (id && opts.reveal !== false) this.ensureVisible(id);
		this.dirtyRender = true;
		this.render();
		if (opts.focus !== false && !this.editing) this.focusStage();
	}

	/**
	 * 键盘焦点给舞台，并清掉留在（不显示的）大纲里的 DOM 选区：否则浏览器每帧都要为它算选区边界，
	 * 大纲被 content-visibility 跳过布局时要往后扫整页找位置（实测每帧 ~20 ms）。
	 */
	focusStage() {
		this.stage.focus({ preventScroll: true });
		const sel = document.getSelection();
		if (sel?.rangeCount && !this.stage.contains(sel.anchorNode)) sel.removeAllRanges();
	}

	/** 进入编辑：节点里放一个只编辑这一块的 ProseMirror 视图（同一份 schema、方言、输入法处理）。 */
	enterEdit(id: string, caret: "end" | "start" | number = "end", insert?: string) {
		if (id === this.host.pageId) return;
		if (this.editing?.id === id) {
			this.editing.view.pm.focus();
			return;
		}
		this.exitEdit(false);
		this.select(id, { focus: false });
		const ne = this.els.get(id);
		if (!ne) return;
		ne.el.classList.add("editing");
		ne.el.style.width = "";
		ne.body.style.width = "";
		ne.body.replaceChildren();
		const view = new OV(this.client, { kind: "node", blockId: id }, ne.body, {
			label: `${this.host.label}:node`,
			collapsed: this.host.state.collapsed,
			restoreSel: (sel) => this.host.restoreSel(sel),
			keys: this.host.surfaceKeys(),
		});
		view.noScroll = true;
		const ro = new ResizeObserver(() => {
			if (!this.editing || this.editing.view !== view) return;
			const w = ne.el.offsetWidth;
			const h = ne.el.offsetHeight;
			const s = this.editing.size;
			if (!s || s.w !== w || s.h !== h) {
				this.editing.size = { w, h };
				this.dirtyLayout = true;
				this.flush();
			}
		});
		// 编辑态的结构键：Esc 回到节点选择；Tab / Shift-Tab 退出编辑再按导图键位执行（输入法组合中不拦）。
		// 挂在编辑器外层的捕获阶段，先于 ProseMirror 的键位
		const onKey = (e: KeyboardEvent) => {
			if (e.isComposing || e.keyCode === 229) return;
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				this.exitEdit(true);
			} else if (e.key === "Tab") {
				e.preventDefault();
				e.stopPropagation();
				if (e.shiftKey) {
					// 编辑中提升一级：提升之后接着编辑，光标不动
					const p = view.locate(view.pm.state.doc, view.pm.state.selection.head);
					const off = p && p.blockId === id ? p.offset : -1;
					this.exitEdit(true);
					this.cmdOutdent(id);
					if (this.info.has(id)) this.enterEdit(id, off < 0 ? "end" : off);
				} else {
					this.exitEdit(true);
					this.cmdAddChild(id);
				}
			}
		};
		ne.body.addEventListener("keydown", onKey, true);
		this.editing = { id, view, ro, size: null, mount: ne.body, onKey };
		ro.observe(ne.el);
		const origDispatch = view.dispatch.bind(view);
		view.dispatch = (tr) => {
			origDispatch(tr);
			// Enter 拆块：光标去了新块，编辑跟过去
			const p = view.locate(view.pm.state.doc, view.pm.state.selection.head);
			if (p && p.blockId !== id && this.client.visible.alive(p.blockId)) {
				const next = p.blockId;
				const off = p.offset;
				queueMicrotask(() => {
					if (this.editing?.view === view) {
						this.dirtyLayout = true;
						this.enterEdit(next, off);
					}
				});
			}
		};
		view.pm.focus();
		const doc = view.pm.state.doc;
		const pos = findBlockPos(doc, id);
		if (pos != null) {
			const body = doc.nodeAt(pos)?.child(0);
			const off =
				caret === "start" ? 0 : caret === "end" ? (body?.content.size ?? 0) : Math.max(0, caret);
			view.applySelection({
				anchor: { blockId: id, offset: off },
				head: { blockId: id, offset: off },
				view,
			});
		}
		if (insert) view.pm.dispatch(view.pm.state.tr.insertText(insert));
		this.render();
	}

	exitEdit(focusStage: boolean) {
		const ed = this.editing;
		if (!ed) return;
		this.editing = null;
		ed.ro.disconnect();
		ed.mount.removeEventListener("keydown", ed.onKey, true);
		ed.view.destroy();
		const ne = this.els.get(ed.id);
		if (ne) {
			ne.el.classList.remove("editing");
			ne.key = "";
			ne.w = -1;
		}
		this.dirtyLayout = true;
		if (this.active) {
			this.flush();
			if (focusStage) this.focusStage();
		}
	}

	// ---------- 命令：在编辑面的大纲文档上执行同一套 ProseMirror 命令 ----------

	/** 把大纲文档的光标放进这一块，再执行命令；返回命令之后光标所在的块。 */
	runCmd(id: string, make: (v: OutlineView) => Command, offset = -1): string | null {
		const v = this.host.outline;
		const doc = v.pm.state.doc;
		const pos = findBlockPos(doc, id);
		if (pos == null) return null;
		v.pm.updateState(
			v.pm.state.apply(
				v.pm.state.tr.setSelection(caretIn(doc, pos, offset)).setMeta("remote", true),
			),
		);
		const ok = make(v)(v.pm.state, (tr) => v.pm.dispatch(tr));
		if (!ok) return null;
		this.dirtyLayout = true;
		const p = v.locate(v.pm.state.doc, v.pm.state.selection.head);
		return p?.blockId ?? null;
	}

	cmdAddChild(id: string) {
		if (this.host.state.collapsed.has(id)) this.host.toggleCollapse(id);
		const nid =
			id === this.host.pageId && !this.host.state.focus
				? this.runTop()
				: this.runCmd(id, (v) => addChild(v));
		if (nid) {
			this.flush();
			this.enterEdit(nid, "end");
		}
	}

	private runTop(): string | null {
		const v = this.host.outline;
		const ok = addTopLevel(v)(v.pm.state, (tr) => v.pm.dispatch(tr));
		if (!ok) return null;
		this.dirtyLayout = true;
		return v.locate(v.pm.state.doc, v.pm.state.selection.head)?.blockId ?? null;
	}

	cmdOutdent(id: string) {
		if (id === this.rootId) return;
		this.runCmd(id, (v) => outdent(v));
		this.flush();
		this.select(id);
	}

	cmdMove(id: string, dir: -1 | 1) {
		if (id === this.rootId) return;
		this.runCmd(id, (v) => moveBlock(v, dir));
		this.flush();
		this.select(id);
	}

	cmdToggleTask(id: string) {
		if (id === this.host.pageId) return;
		this.runCmd(id, () => toggleTask());
		this.flush();
		this.render();
	}

	cmdCycleTask(id: string) {
		const task = this.client.visible.get(id)?.task;
		if (!task) return;
		const v = this.host.outline;
		const pos = findBlockPos(v.pm.state.doc, id);
		if (pos == null) return;
		v.pm.dispatch(v.pm.state.tr.setNodeAttribute(pos, "task", TASK_NEXT[task]));
		this.dirtyLayout = true;
		this.flush();
	}

	cmdDelete(id: string) {
		if (id === this.rootId) return;
		const inf = this.info.get(id);
		const parent = inf?.parent ?? null;
		const sibs = parent ? (this.info.get(parent)?.node.kids ?? []) : [];
		const i = sibs.findIndex((n) => n.id === id);
		const next = sibs[i - 1]?.id ?? sibs[i + 1]?.id ?? parent;
		this.runCmd(id, () => deleteBlock());
		this.flush();
		if (next) this.select(next);
	}

	cmdDrop(id: string, target: string, where: DropWhere) {
		if (where === "child" && this.host.state.collapsed.has(target))
			this.host.toggleCollapse(target);
		if (target === this.host.pageId && !this.host.state.focus) {
			// 拖到页根上：挂到最后一个顶层块后面
			const tops = this.client.visible.children(this.host.pageId).filter((x) => x !== id);
			const last = tops[tops.length - 1];
			if (!last) return;
			this.runCmd(id, () => moveBlockTo(id, last, "after"));
		} else this.runCmd(id, () => moveBlockTo(id, target, where));
		this.flush();
		this.select(id);
	}

	// ---------- 键盘 ----------

	private nav(id: string, key: string): string | null {
		const inf = this.info.get(id);
		if (!inf) return null;
		const right = this.dir === "right";
		const toChild = right ? "ArrowRight" : "ArrowDown";
		const toParent = right ? "ArrowLeft" : "ArrowUp";
		const prev = right ? "ArrowUp" : "ArrowLeft";
		const next = right ? "ArrowDown" : "ArrowRight";
		if (key === toChild) return inf.node.kids[0]?.id ?? null;
		if (key === toParent) return inf.parent;
		if (key === prev || key === next) {
			const sibs = inf.parent ? (this.info.get(inf.parent) as NInfo).node.kids : [];
			const j = inf.index + (key === prev ? -1 : 1);
			if (sibs[j]) return sibs[j].id;
			return this.nearestInDirection(id, key);
		}
		return null;
	}

	/** 同级到头了：按屏幕方向找最近的节点（表兄弟等）。 */
	private nearestInDirection(id: string, key: string): string | null {
		const a = (this.info.get(id) as NInfo).node;
		const ax = a.x + a.w / 2;
		const ay = a.y + a.h / 2;
		let best: string | null = null;
		let bd = Number.POSITIVE_INFINITY;
		for (const [oid, inf] of this.info) {
			if (oid === id) continue;
			const b = inf.node;
			const bx = b.x + b.w / 2;
			const by = b.y + b.h / 2;
			const dx = bx - ax;
			const dy = by - ay;
			let main: number;
			let cross: number;
			if (key === "ArrowUp") [main, cross] = [-dy, dx];
			else if (key === "ArrowDown") [main, cross] = [dy, dx];
			else if (key === "ArrowLeft") [main, cross] = [-dx, dy];
			else [main, cross] = [dx, dy];
			if (main <= 1) continue;
			const d = main + Math.abs(cross) * 2;
			if (d < bd) {
				bd = d;
				best = oid;
			}
		}
		return best;
	}

	onKey(e: KeyboardEvent) {
		if (this.editing) return;
		if (e.isComposing || e.keyCode === 229) {
			// 输入法开始：进入编辑，让组合落在节点的编辑器里
			if (this.selected) this.enterEdit(this.selected, "end");
			return;
		}
		const mod = e.ctrlKey || e.metaKey;
		const id = this.selected ?? this.rootId;
		const k = e.key;
		const handled = (): void => {
			e.preventDefault();
			e.stopPropagation();
		};
		if (mod && (k === "z" || k === "Z")) {
			handled();
			if (e.shiftKey) this.client.redo();
			else this.client.undo();
			return;
		}
		if (mod && k === "y") {
			handled();
			this.client.redo();
			return;
		}
		if (mod && k === "Enter") {
			handled();
			this.cmdToggleTask(id);
			return;
		}
		// 编辑面共用的键（Mod-↑ / Mod-↓ / Alt+1…9 等）
		const keys = this.host.surfaceKeys();
		const name = `${e.altKey ? "Alt-" : ""}${mod ? "Mod-" : ""}${e.shiftKey ? "Shift-" : ""}${k}`;
		const right = this.dir === "right";
		if (e.altKey && !mod && k.startsWith("Arrow")) {
			handled();
			const sibAxis = right
				? k === "ArrowUp" || k === "ArrowDown"
				: k === "ArrowLeft" || k === "ArrowRight";
			if (sibAxis) {
				this.cmdMove(id, k === "ArrowUp" || k === "ArrowLeft" ? -1 : 1);
			} else if (k === (right ? "ArrowRight" : "ArrowDown")) {
				if (id !== this.host.pageId) this.host.focusBlock(id);
			} else this.host.focusUp();
			return;
		}
		if (!e.altKey && keys[name] && /^(Mod-Arrow|Alt-\d)/.test(name)) {
			handled();
			keys[name](this.host.outline.pm.state);
			return;
		}
		if (e.altKey && /^\d$/.test(k)) {
			const kk = keys[`Alt-${k}`];
			if (kk) {
				handled();
				kk(this.host.outline.pm.state);
			}
			return;
		}
		if (mod || e.altKey) return;
		if (k.startsWith("Arrow")) {
			handled();
			const n = this.nav(id, k);
			if (n) this.select(n);
			return;
		}
		switch (k) {
			case "Tab":
				handled();
				if (e.shiftKey) this.cmdOutdent(id);
				else this.cmdAddChild(id);
				return;
			case "Enter":
				// 选中节点按 Enter 进入编辑（光标在末尾）；编辑中的 Enter 和大纲一样拆块 / 加下一个同级（同一条 splitBlock）
				handled();
				if (e.shiftKey) return;
				this.enterEdit(id, "end");
				return;
			case "F2":
				handled();
				this.enterEdit(id, "end");
				return;
			case " ":
				handled();
				if (this.info.get(id)?.hasKids) this.host.toggleCollapse(id);
				return;
			case "Delete":
			case "Backspace":
				handled();
				this.cmdDelete(id);
				return;
			case "Escape":
				handled();
				if (this.host.state.blocks.length) {
					this.host.state.blocks = [];
					this.render();
				}
				return;
		}
		if (k.length === 1 && this.selected && this.selected !== this.host.pageId) {
			// 直接打字：进入编辑，字接在末尾
			handled();
			this.enterEdit(this.selected, "end", k);
		}
	}

	// ---------- 平移缩放、点选、拖动 ----------

	private onWheel(e: WheelEvent) {
		e.preventDefault();
		const r = this.stage.getBoundingClientRect();
		if (e.ctrlKey) {
			const f = Math.exp(-e.deltaY * 0.01);
			this.zoomAt(this.scale * f, e.clientX - r.left, e.clientY - r.top);
		} else this.setTransform(this.tx - e.deltaX, this.ty - e.deltaY);
	}

	zoomAt(s: number, sx: number, sy: number) {
		const ns = Math.min(3, Math.max(0.1, s));
		const k = ns / this.scale;
		this.setTransform(sx - (sx - this.tx) * k, sy - (sy - this.ty) * k, ns);
	}

	private nodeIdAt(t: EventTarget | null): string | null {
		const el = (t as HTMLElement | null)?.closest?.(".mm-node") as HTMLElement | null;
		return el?.dataset.id ?? null;
	}

	private pointers = new Map<number, { x: number; y: number }>();
	private gesture:
		| { kind: "pan"; x: number; y: number; tx: number; ty: number; moved: boolean }
		| { kind: "pinch"; dist: number; mx: number; my: number }
		| {
				kind: "node";
				id: string;
				x: number;
				y: number;
				touch: boolean;
				timer: number;
				drag: boolean;
				moved: boolean;
				target: { id: string; where: DropWhere } | null;
		  }
		| null = null;
	private lastTap: { id: string; t: number } | null = null;

	private local(e: PointerEvent) {
		const r = this.stage.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	private onPointerDown(e: PointerEvent) {
		const p = this.local(e);
		const target = e.target as HTMLElement;
		const id = this.nodeIdAt(target);
		if (this.editing && id === this.editing.id && !target.closest(".ob-gutter")) return; // 编辑器自己处理
		this.pointers.set(e.pointerId, p);
		if (this.pointers.size === 2) {
			// 第二根手指：捏合
			if (this.gesture?.kind === "node") clearTimeout(this.gesture.timer);
			const [a, b] = [...this.pointers.values()];
			this.gesture = {
				kind: "pinch",
				dist: Math.hypot(a.x - b.x, a.y - b.y),
				mx: (a.x + b.x) / 2,
				my: (a.y + b.y) / 2,
			};
			return;
		}
		if (this.pointers.size > 2) return;
		if (id && target.closest(".ob-gutter")) {
			e.preventDefault();
			if (target.closest(".ob-arrow")) this.host.toggleCollapse(id);
			else if (target.closest(".ob-bullet")) this.host.focusBlock(id === this.rootId ? null : id);
			else if (target.closest(".ob-check")) this.cmdCycleTask(id);
			this.pointers.delete(e.pointerId);
			return;
		}
		this.stage.setPointerCapture?.(e.pointerId);
		if (id) {
			e.preventDefault();
			const touch = e.pointerType === "touch";
			const g = {
				kind: "node" as const,
				id,
				x: p.x,
				y: p.y,
				touch,
				timer: 0,
				drag: false,
				moved: false,
				target: null,
			};
			// 触屏：长按开始拖动；鼠标：移动超过阈值开始拖动
			if (touch)
				g.timer = window.setTimeout(() => {
					if (this.gesture === g && !g.moved) this.startDrag(g);
				}, 450);
			this.gesture = g;
			return;
		}
		e.preventDefault();
		if (this.editing) this.exitEdit(false);
		this.stage.focus({ preventScroll: true });
		this.gesture = { kind: "pan", x: p.x, y: p.y, tx: this.tx, ty: this.ty, moved: false };
	}

	private startDrag(g: Extract<NonNullable<MindMapView["gesture"]>, { kind: "node" }>) {
		if (g.id === this.rootId) return;
		g.drag = true;
		if (this.editing) this.exitEdit(false);
		this.select(g.id, { reveal: false });
		this.els.get(g.id)?.el.classList.add("dragging");
	}

	private onPointerMove(e: PointerEvent) {
		if (!this.pointers.has(e.pointerId)) return;
		const p = this.local(e);
		this.pointers.set(e.pointerId, p);
		const g = this.gesture;
		if (!g) return;
		if (g.kind === "pinch" && this.pointers.size >= 2) {
			const [a, b] = [...this.pointers.values()];
			const dist = Math.hypot(a.x - b.x, a.y - b.y);
			const mx = (a.x + b.x) / 2;
			const my = (a.y + b.y) / 2;
			const k = g.dist > 0 ? dist / g.dist : 1;
			const ns = Math.min(3, Math.max(0.1, this.scale * k));
			const kk = ns / this.scale;
			this.setTransform(mx - (g.mx - this.tx) * kk, my - (g.my - this.ty) * kk, ns);
			g.dist = dist;
			g.mx = mx;
			g.my = my;
			return;
		}
		if (g.kind === "pan") {
			if (Math.abs(p.x - g.x) + Math.abs(p.y - g.y) > 3) g.moved = true;
			this.setTransform(g.tx + p.x - g.x, g.ty + p.y - g.y);
			return;
		}
		if (g.kind === "node") {
			const dist = Math.abs(p.x - g.x) + Math.abs(p.y - g.y);
			if (!g.drag) {
				if (dist <= 6) return;
				g.moved = true;
				clearTimeout(g.timer);
				if (g.touch) {
					// 触屏单指在节点上划：平移
					this.gesture = { kind: "pan", x: g.x, y: g.y, tx: this.tx, ty: this.ty, moved: true };
					this.setTransform(this.tx + p.x - g.x, this.ty + p.y - g.y);
					return;
				}
				this.startDrag(g);
			}
			const ne = this.els.get(g.id);
			const inf = this.info.get(g.id);
			if (ne && inf) {
				const dx = (p.x - g.x) / this.scale;
				const dy = (p.y - g.y) / this.scale;
				ne.el.style.transform = `translate(${inf.node.x + dx}px, ${inf.node.y + dy}px)`;
			}
			g.target = this.dropTarget(g.id, p.x, p.y);
			this.showDrop(g.target);
		}
	}

	private onPointerUp(e: PointerEvent, cancel = false) {
		if (!this.pointers.has(e.pointerId)) return;
		this.pointers.delete(e.pointerId);
		const g = this.gesture;
		if (g?.kind === "pinch") {
			if (this.pointers.size === 0) this.gesture = null;
			return;
		}
		this.gesture = null;
		if (!g) return;
		if (g.kind === "pan") {
			if (!g.moved && !cancel) {
				this.selectBlocksClear();
			}
			return;
		}
		if (g.kind === "node") {
			clearTimeout(g.timer);
			if (g.drag) {
				this.els.get(g.id)?.el.classList.remove("dragging");
				this.showDrop(null);
				const ne = this.els.get(g.id);
				if (ne) ne.x = Number.NaN; // 强制下次渲染回到布局位置
				if (g.target && !cancel) this.cmdDrop(g.id, g.target.id, g.target.where);
				else this.render();
				return;
			}
			if (cancel || g.moved) return;
			// 点选；Shift 点加入 / 移出块选择；触屏双击进入编辑
			if (e.shiftKey) {
				const st = this.host.state;
				st.blocks = st.blocks.includes(g.id)
					? st.blocks.filter((x) => x !== g.id)
					: [...st.blocks, g.id];
				this.render();
				return;
			}
			// 双击（鼠标）/ 连点两下（触屏）进入编辑
			const now = performance.now();
			const dbl = this.lastTap && this.lastTap.id === g.id && now - this.lastTap.t < 350;
			this.lastTap = { id: g.id, t: now };
			if (dbl) {
				this.lastTap = null;
				this.enterEdit(g.id, "end");
				return;
			}
			this.select(g.id, { reveal: false });
		}
	}

	private selectBlocksClear() {
		if (this.host.state.blocks.length) {
			this.host.state.blocks = [];
			this.render();
		}
	}

	/** 拖动的落点：节点中间 = 挂到它下面；靠前 / 靠后的四分之一（含同级间隙的一半）= 放在它前 / 后。 */
	dropTarget(dragId: string, sx: number, sy: number): { id: string; where: DropWhere } | null {
		const wx = (sx - this.tx) / this.scale;
		const wy = (sy - this.ty) / this.scale;
		const right = this.dir === "right";
		const half = GAP[this.dir].gapSibling / 2 + 1;
		// 被拖的子树不能当落点
		const banned = new Set<string>();
		const ban = (n: LNode) => {
			banned.add(n.id);
			for (const k of n.kids) ban(k);
		};
		const d = this.info.get(dragId);
		if (d) ban(d.node);
		for (const id of this.visibleIds(0)) {
			if (banned.has(id)) continue;
			const n = (this.info.get(id) as NInfo).node;
			const x0 = n.x - (right ? 0 : half);
			const x1 = n.x + n.w + (right ? 0 : half);
			const y0 = n.y - (right ? half : 0);
			const y1 = n.y + n.h + (right ? half : 0);
			if (wx < x0 || wx > x1 || wy < y0 || wy > y1) continue;
			if (id === this.rootId) return { id, where: "child" };
			const t = right ? (wy - n.y) / n.h : (wx - n.x) / n.w;
			if (t < 0.25) return { id, where: "before" };
			if (t > 0.75) return { id, where: "after" };
			return { id, where: "child" };
		}
		return null;
	}

	private showDrop(t: { id: string; where: DropWhere } | null) {
		const m = this.dropMark;
		if (!t) {
			m.style.display = "none";
			return;
		}
		const n = (this.info.get(t.id) as NInfo).node;
		const right = this.dir === "right";
		m.style.display = "block";
		m.dataset.where = t.where;
		if (t.where === "child") {
			m.style.transform = `translate(${n.x - 3}px, ${n.y - 3}px)`;
			m.style.width = `${n.w + 6}px`;
			m.style.height = `${n.h + 6}px`;
		} else if (right) {
			const y = t.where === "before" ? n.y - 5 : n.y + n.h + 3;
			m.style.transform = `translate(${n.x}px, ${y}px)`;
			m.style.width = `${n.w}px`;
			m.style.height = "2px";
		} else {
			const x = t.where === "before" ? n.x - 5 : n.x + n.w + 3;
			m.style.transform = `translate(${x}px, ${n.y}px)`;
			m.style.width = "2px";
			m.style.height = `${n.h}px`;
		}
	}

	// ---------- 动画（FLIP，WAAPI） ----------

	/**
	 * 从给定的旧屏幕位置（块体左上角，舞台坐标，屏幕上 1:1 大小）移动到当前布局位置。
	 * 只给 ids 里的节点做位移动画（调用方只传切换前后在视口里的块）；fade 里的淡入。
	 */
	flipFrom(from: Map<string, { x: number; y: number }>, fadeIn: string[], ms: number): Animation[] {
		const anims: Animation[] = [];
		if (reducedMotion() || ms <= 0) return anims;
		const s = this.scale;
		for (const [id, p] of from) {
			const ne = this.els.get(id);
			const inf = this.info.get(id);
			if (!ne || !inf) continue;
			const o = this.bodyOffset(id);
			const wx = (p.x - this.tx - o.x) / s;
			const wy = (p.y - this.ty - o.y) / s;
			const to = `translate(${inf.node.x}px, ${inf.node.y}px)`;
			const fromT = `translate(${wx}px, ${wy}px) scale(${1 / s})`;
			if (Math.abs(wx - inf.node.x) < 0.5 && Math.abs(wy - inf.node.y) < 0.5 && s === 1) continue;
			anims.push(
				ne.el.animate([{ transform: fromT }, { transform: to }], { duration: ms, easing: "ease" }),
			);
		}
		for (const id of fadeIn) {
			const ne = this.els.get(id);
			if (ne)
				anims.push(
					ne.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: "ease" }),
				);
		}
		anims.push(
			this.svg.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], {
				duration: ms,
				easing: "linear",
			}),
		);
		return anims;
	}

	/** 反方向：节点从当前位置移动到目标屏幕位置（例如大纲里对应的行），其余淡出。 */
	morphTo(to: Map<string, { x: number; y: number }>, ms: number): Animation[] {
		const anims: Animation[] = [];
		if (reducedMotion() || ms <= 0) return anims;
		const s = this.scale;
		for (const [id, ne] of this.els) {
			const inf = this.info.get(id);
			if (!inf) continue;
			const p = to.get(id);
			const cur = `translate(${inf.node.x}px, ${inf.node.y}px)`;
			if (p) {
				const o = this.bodyOffset(id);
				const wx = (p.x - this.tx - o.x) / s;
				const wy = (p.y - this.ty - o.y) / s;
				anims.push(
					ne.el.animate(
						[
							{ transform: cur, opacity: 1 },
							{ transform: `translate(${wx}px, ${wy}px) scale(${1 / s})`, opacity: 1 },
						],
						{ duration: ms, easing: "ease", fill: "forwards" },
					),
				);
			} else
				anims.push(
					ne.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms * 0.6, fill: "forwards" }),
				);
		}
		anims.push(
			this.svg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms * 0.4, fill: "forwards" }),
		);
		return anims;
	}

	/** 节点被移出树（聚焦到别处）时的淡出：先留着 DOM，动画结束再删。 */
	fadeOutGhosts(ids: string[], ms: number): Animation[] {
		const anims: Animation[] = [];
		for (const id of ids) {
			const ne = this.els.get(id);
			if (!ne) continue;
			this.els.delete(id);
			if (reducedMotion() || ms <= 0) {
				ne.el.remove();
				continue;
			}
			const a = ne.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, fill: "forwards" });
			a.finished.then(
				() => ne.el.remove(),
				() => ne.el.remove(),
			);
			anims.push(a);
		}
		return anims;
	}
}
