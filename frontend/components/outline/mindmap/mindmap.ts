/**
 * The mind map (design §6.10, D29): the same editing surface drawn as a tree growing rightward or
 * downward. Ported from the outline prototype (`prototypes/outline-editor/src/mindmap/`).
 *
 *   - Nodes are native DOM (no React, no `@xyflow/react`), absolutely positioned in a panned and
 *     zoomed world; edges are one SVG path. Only nodes near the viewport have DOM (plus those a
 *     transition animates); sizes come from pretext (`measure.ts`), not from the DOM.
 *   - What is shown follows the outline: the focused block is the root, folded blocks hide their
 *     children, the facts view leaves tasks out; at most `MAP_BUDGET` blocks are laid out, the
 *     rest fold into "…N more" (design §7.2, `shared/outline/layout`).
 *   - Structure keys (Tab, Enter, Shift-Tab, Alt+arrows, drag, Mod-Enter, Delete) run the SAME
 *     ProseMirror commands on the surface's outline document (`editor/commands.ts`), which the
 *     same reconcile turns into outline transactions on the same undo stack: an edit made here
 *     is exactly the one made in the outline (D33), concurrency and undo included.
 *   - Editing: a node holds an editor of just that block (`OutlineView`, surface kind `node`) with
 *     the same schema, dialect and IME handling. Enter at the caret splits the block through the
 *     outline document too, and editing follows to the new block.
 *   - Folding, focus, selection and direction live in the surface's view state, shared with the
 *     outline. Pan and zoom share `PanZoomStage`'s gesture math (`common/pan-zoom-math.ts`):
 *     wheel pans, Ctrl+wheel (a trackpad pinch) zooms, two fingers pinch; the app's pinch guard
 *     (`lib/pinch-zoom-guard.ts`) keeps the browser from zooming the page meanwhile.
 *
 * Keys are handled on the stage only (it takes keyboard focus): nothing listens on the document.
 */
import {
	type LayoutDirection,
	type LayoutNode,
	layoutTree,
	planVisible,
} from "@shared/outline/layout";
import type { LiveTaskChar } from "@shared/outline-live-protocol";
import type { Command } from "prosemirror-state";
import { pinchStep, wheelZoomFactor, zoomAround } from "../../common/pan-zoom-math";
import {
	applyChrome,
	createGutter,
	type Gutter,
	type MentionResolver,
	mentionLabel,
	renderBody,
	TASK_NEXT,
} from "../editor/chrome";
import {
	addChild,
	addSiblingAfter,
	caretIn,
	type DropWhere,
	deleteBlock,
	moveBlock,
	moveBlockTo,
	outdent,
	splitBlock,
	toggleTask,
} from "../editor/commands";
import type { LiveClient, SelInfo } from "../editor/live-client";
import { findBlockPos, type OutlineLens, type OutlineRefusal, OutlineView } from "../editor/view";
import type { OutlineViewState } from "../view-state";
import { bodySize, MAP_FONT_FAMILY, MAP_MONO_FAMILY, NODE, nodeSize } from "./measure";

/** Most blocks one map lays out and draws (design §7.2: the same cap as an editor view). */
export /** Nodes laid out (and measured on the main thread) while the Worker measures the page. */
const HELD_LAYOUT_MAX = 100;
const MAP_BUDGET = 2000;
/** Nodes this far outside the stage still get DOM (so panning shows them at once). */
const MARGIN = 320;
const MIN_SCALE = 0.1;
const MAX_SCALE = 3;
/** A trackpad pinch (Ctrl+wheel) sends small deltas: a faster step than a mouse wheel's. */
const PINCH_WHEEL_STEP = 0.01;
/** Touch: how long a press waits before it drags a node. */
const LONG_PRESS_MS = 450;
const DOUBLE_TAP_MS = 350;
const MORE = "\u0000more:";

export const GAP: Record<LayoutDirection, { gapDepth: number; gapSibling: number }> = {
	right: { gapDepth: 44, gapSibling: 8 },
	down: { gapDepth: 40, gapSibling: 14 },
};

/** Words the map shows (set from the page's i18n once). */
export const mapText = {
	more: (count: number) => `… ${count}`,
	stage: "Mind map",
};

export interface MapHost {
	client: LiveClient;
	state: OutlineViewState;
	/** The surface's current outline view: structure commands run on its document. */
	readonly outline: OutlineView;
	pageId: string;
	lens(): OutlineLens;
	resolveMention: MentionResolver;
	/** Focus a block (the surface animates and tells its host). */
	focusBlock(id: string): void;
	focusUp(): void;
	toggleCollapse(id: string): void;
	/** Keys shared by the outline, the map and node editors (collapse all, levels, …). */
	surfaceKeys(): Record<string, Command>;
	restoreSel(sel: SelInfo): boolean;
	/** The selected node changed. */
	onSelect(id: string | null): void;
	/** An edit was refused locally (`editor/view.ts`). */
	onRefused?: (reason: OutlineRefusal) => void;
}

interface NInfo {
	node: LayoutNode;
	parent: string | null;
	content: string;
	task: LiveTaskChar | null;
	hasKids: boolean;
	collapsed: boolean;
	/** Children folded away (by the person, or for lack of budget on a "more" node). */
	hidden: number;
	bodyW: number;
	index: number;
	/** A "…N more" node: its parent's children beyond the budget. */
	more: boolean;
}

interface NodeEl {
	el: HTMLElement;
	g: Gutter;
	body: HTMLElement;
	badge: HTMLElement;
	key: string;
	x: number;
	y: number;
	w: number;
}

interface Pos {
	x: number;
	y: number;
}

type Gesture =
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
	  };

const isMore = (id: string) => id.startsWith(MORE);

export class MindMapView {
	readonly stage: HTMLElement;
	readonly world: HTMLElement;
	readonly svg: SVGSVGElement;
	private readonly edges: SVGPathElement;
	private readonly dropMark: HTMLElement;
	tx = 40;
	ty = 40;
	scale = 1;
	active = false;
	info = new Map<string, NInfo>();
	order: string[] = [];
	rootId = "";
	readonly els = new Map<string, NodeEl>();
	/** Nodes that must have DOM while a transition runs. */
	readonly force = new Set<string>();
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
		{ content: string; task: LiveTaskChar | null; w: number; h: number; bodyW: number }
	>();
	private dirtyLayout = true;
	private dirtyRender = true;
	private raf = 0;
	private stageW = 0;
	private stageH = 0;
	private layoutDir: LayoutDirection = "right";
	private edgeKey = "";
	private layoutSeq = 0;
	private readonly ro: ResizeObserver;
	private destroyed = false;
	stats = {
		layouts: [] as number[],
		measureMs: [] as number[],
		treeMs: [] as number[],
		renders: [] as number[],
		nodesInDom: 0,
	};

	constructor(
		readonly host: MapHost,
		frame: HTMLElement,
	) {
		this.stage = document.createElement("div");
		this.stage.className = "mm-stage";
		this.stage.tabIndex = 0;
		this.stage.setAttribute("role", "tree");
		this.stage.setAttribute("aria-label", mapText.stage);
		this.stage.dataset.testid = "outline-map";
		// The fonts nodes are measured with (`measure.ts`).
		this.stage.style.setProperty("--nf-mm-font", MAP_FONT_FAMILY);
		this.stage.style.setProperty("--nf-mm-mono", MAP_MONO_FAMILY);
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
		// The stage's size comes from a ResizeObserver: reading clientWidth here would force the
		// whole outline's layout early.
		this.ro = new ResizeObserver((entries) => {
			const r = (entries[entries.length - 1] as ResizeObserverEntry).contentRect;
			if (r.width === 0 && r.height === 0) return;
			this.stageW = r.width;
			this.stageH = r.height;
			if (this.placeWhenSized) {
				this.placeWhenSized = false;
				this.placeRoot();
			}
			this.schedule(false);
		});
		this.ro.observe(this.stage);
		this.stage.addEventListener("keydown", (e) => this.onKey(e));
		this.stage.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
		this.stage.addEventListener("pointerdown", (e) => this.onPointerDown(e));
		this.stage.addEventListener("pointermove", (e) => this.onPointerMove(e));
		this.stage.addEventListener("pointerup", (e) => this.onPointerUp(e));
		this.stage.addEventListener("pointercancel", (e) => this.onPointerUp(e, true));
		this.stage.addEventListener("dblclick", (e) => e.preventDefault());
		this.applyTransform();
	}

	get client(): LiveClient {
		return this.host.client;
	}

	get dir(): LayoutDirection {
		return this.host.state.layout;
	}

	destroy(): void {
		this.destroyed = true;
		this.exitEdit(false);
		// A long press under way would fire on a destroyed map.
		const g = this.gesture;
		if (g?.kind === "node") clearTimeout(g.timer);
		this.gesture = null;
		this.pointers.clear();
		this.afterHoldRuns.length = 0;
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.ro.disconnect();
		this.stage.remove();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Layout
	// ─────────────────────────────────────────────────────────────────────────

	/** A tree was laid out before the stage had a size: its root goes in place once it has. */
	private placeWhenSized = false;
	private hold: Promise<void> | null = null;
	private readonly afterHoldRuns: Array<() => void> = [];

	/**
	 * Until `until` settles (the page's bodies are being measured in the Worker), lay out at most
	 * `HELD_LAYOUT_MAX` nodes (breadth first, the rest folded into "N more"): laying out the
	 * whole page now would measure every body on the main thread. Then the whole tree, the root
	 * kept where it is on screen.
	 */
	holdLayout(until: Promise<unknown>): void {
		const p: Promise<void> = until.then(
			() => undefined,
			() => undefined,
		);
		this.hold = p;
		void p.then(() => {
			if (this.hold !== p || this.destroyed) return;
			this.hold = null;
			if (this.active) {
				const at = this.bodyScreen(this.rootId);
				this.relayout();
				if (at) this.placeBody(this.rootId, at.x, at.y);
				else this.placeRoot();
			} else this.dirtyLayout = true;
			for (const run of this.afterHoldRuns.splice(0)) run();
			this.schedule();
		});
	}

	get holding(): boolean {
		return this.hold !== null;
	}

	/** Run once the hold is over (at once without one). */
	afterHold(run: () => void): void {
		if (this.hold) this.afterHoldRuns.push(run);
		else run();
	}

	/** The store or view state changed: lay out and draw next frame (merged within a frame). */
	schedule(layout = true): void {
		if (layout) this.dirtyLayout = true;
		this.dirtyRender = true;
		if (!this.active || this.raf || this.destroyed) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			this.flush();
		});
	}

	/** Bring layout and DOM up to date now (tests and transitions). */
	flush(): void {
		if (this.raf) {
			cancelAnimationFrame(this.raf);
			this.raf = 0;
		}
		if (this.dirtyLayout) this.relayout();
		if (this.dirtyRender) this.render();
	}

	get layoutDirty(): boolean {
		return this.dirtyLayout;
	}

	private labelOf = (ref: string, label: string | null) =>
		mentionLabel(this.host.resolveMention, ref, label);

	/** Whether the facts view leaves tasks out under the root (not inside a task). */
	private factsHere(rootId: string): boolean {
		if (this.host.lens() !== "facts") return false;
		const v = this.client.visible;
		for (let cur: string | null = rootId; cur; cur = v.get(cur)?.parentId ?? null) {
			if (v.get(cur)?.task) return false;
		}
		return true;
	}

	relayout(): void {
		const t0 = performance.now();
		const client = this.client;
		const v = client.visible;
		const st = this.host.state;
		const rootId = st.focus && v.alive(st.focus) ? st.focus : this.host.pageId;
		// The first layout of a tree (the page arrived, another root): its root goes in place.
		const fresh = this.rootId !== rootId || this.info.size <= 1;
		this.rootId = rootId;
		const facts = this.factsHere(rootId);
		const kidsOf = (id: string): readonly string[] => {
			const kids = v.children(id);
			return facts ? kids.filter((k) => !v.get(k)?.task) : kids;
		};
		const collapsedOf = (id: string) => st.collapsed.has(id);
		const plan = planVisible({
			rootId,
			children: kidsOf,
			collapsed: collapsedOf,
			budget: this.hold ? HELD_LAYOUT_MAX : MAP_BUDGET,
		});
		const info = new Map<string, NInfo>();
		const order: string[] = [];
		let measureMs = 0;
		const ed = this.editing;
		const make = (id: string, parent: string | null, index: number): LayoutNode => {
			const content = client.textOf(id);
			const task = v.get(id)?.task ?? null;
			const allKids = kidsOf(id);
			const collapsed = id !== rootId && collapsedOf(id) && allKids.length > 0;
			// Sizes cached per block: unchanged text and checkbox skip the measure cache too (a block
			// with mentions is looked up every time: what its targets show may have changed).
			let sz = this.sizes.get(id);
			if (!sz || sz.content !== content || sz.task !== task || content.includes("[[")) {
				const m0 = performance.now();
				const ns = nodeSize(bodySize(content, this.labelOf), !!task);
				measureMs += performance.now() - m0;
				sz = { content, task, ...ns };
				this.sizes.set(id, sz);
			}
			const editingSize = ed && ed.id === id ? ed.size : null;
			const node: LayoutNode = {
				id,
				w: editingSize?.w ?? sz.w,
				h: editingSize?.h ?? sz.h,
				kids: [],
				x: 0,
				y: 0,
				depth: 0,
			};
			order.push(id);
			info.set(id, {
				node,
				parent,
				content,
				task,
				hasKids: allKids.length > 0,
				collapsed,
				hidden: collapsed ? allKids.length : 0,
				bodyW: sz.bodyW,
				index,
				more: false,
			});
			return node;
		};
		// Build the layout tree breadth first from the plan (no recursion).
		const root = make(rootId, null, 0);
		const queue: LayoutNode[] = [root];
		for (let q = 0; q < queue.length; q++) {
			const parent = queue[q] as LayoutNode;
			if (isMore(parent.id)) continue;
			const shown = plan.shown.get(parent.id) ?? [];
			const kids: LayoutNode[] = [];
			for (let i = 0; i < shown.length; i++) {
				const k = make(shown[i] as string, parent.id, i);
				kids.push(k);
				queue.push(k);
			}
			const more = plan.more.get(parent.id);
			if (more && !(info.get(parent.id) as NInfo).collapsed) {
				const id = `${MORE}${parent.id}`;
				const node: LayoutNode = {
					id,
					w: NODE.moreW,
					h: NODE.padY * 2 + NODE.lineH + NODE.border * 2,
					kids: [],
					x: 0,
					y: 0,
					depth: 0,
				};
				order.push(id);
				info.set(id, {
					node,
					parent: parent.id,
					content: "",
					task: null,
					hasKids: false,
					collapsed: false,
					hidden: more,
					bodyW: NODE.moreW,
					index: shown.length,
					more: true,
				});
				kids.push(node);
			}
			parent.kids = kids;
		}
		const t1 = performance.now();
		layoutTree(root, { dir: this.dir, ...GAP[this.dir] });
		const t2 = performance.now();
		this.info = info;
		this.order = order;
		this.layoutDir = this.dir;
		this.layoutSeq++;
		this.dirtyLayout = false;
		this.dirtyRender = true;
		if (fresh && info.size > 1) {
			if (this.stageW > 0 && this.stageH > 0) this.placeRoot();
			else this.placeWhenSized = true;
		}
		this.stats.layouts.push(t2 - t0);
		this.stats.measureMs.push(measureMs);
		this.stats.treeMs.push(t2 - t1);
		if (this.stats.layouts.length > 5000) {
			this.stats.layouts.splice(0, 2500);
			this.stats.measureMs.splice(0, 2500);
			this.stats.treeMs.splice(0, 2500);
		}
		if (this.sizes.size > info.size * 2 + 1000) {
			for (const id of this.sizes.keys()) if (!info.has(id)) this.sizes.delete(id);
		}
		// The block being edited is gone (deleted, folded away, focus moved): stop editing it.
		if (this.editing && !info.has(this.editing.id)) this.exitEdit(false);
		if (this.selected && !info.has(this.selected)) this.selected = null;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Coordinates
	// ─────────────────────────────────────────────────────────────────────────

	/** Where a body's top-left corner is inside its node (world units). */
	bodyOffset(id: string): Pos {
		const inf = this.info.get(id);
		const gutter = inf?.more ? 0 : NODE.gutter + (inf?.task ? NODE.check : 0);
		return { x: NODE.border + NODE.padX + gutter, y: NODE.border + NODE.padY };
	}

	toScreen(wx: number, wy: number): Pos {
		return { x: this.tx + this.scale * wx, y: this.ty + this.scale * wy };
	}

	/** A body's top-left corner on screen (relative to the stage). */
	bodyScreen(id: string): Pos | null {
		const inf = this.info.get(id);
		if (!inf) return null;
		const o = this.bodyOffset(id);
		return this.toScreen(inf.node.x + o.x, inf.node.y + o.y);
	}

	nodeScreenRect(id: string): { x: number; y: number; w: number; h: number } | null {
		const inf = this.info.get(id);
		if (!inf) return null;
		const p = this.toScreen(inf.node.x, inf.node.y);
		return { x: p.x, y: p.y, w: inf.node.w * this.scale, h: inf.node.h * this.scale };
	}

	/** Nodes meeting the stage (from the layout; no DOM read). */
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

	/** Move the world so a body's top-left corner lands at stage point (sx, sy). */
	placeBody(id: string, sx: number, sy: number): void {
		const inf = this.info.get(id);
		if (!inf) return;
		this.placeWhenSized = false;
		const o = this.bodyOffset(id);
		this.tx = sx - this.scale * (inf.node.x + o.x);
		this.ty = sy - this.scale * (inf.node.y + o.y);
		this.applyTransform();
	}

	/** The root where a root goes: left and vertically centred (rightward), top and centred. */
	placeRoot(): void {
		const inf = this.info.get(this.rootId);
		if (!inf) return;
		this.placeWhenSized = false;
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

	/** The whole tree in view (no smaller than 0.2). */
	fit(): void {
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
		if (!Number.isFinite(x0) || this.stageW === 0) return;
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

	setTransform(tx: number, ty: number, s = this.scale): void {
		this.tx = tx;
		this.ty = ty;
		this.scale = clampScale(s);
		this.applyTransform();
		this.schedule(false);
	}

	private applyTransform(): void {
		this.world.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
	}

	/** Pan so a node is inside the stage. */
	ensureVisible(id: string): void {
		const r = this.nodeScreenRect(id);
		if (!r || this.stageW === 0) return;
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

	// ─────────────────────────────────────────────────────────────────────────
	// Drawing
	// ─────────────────────────────────────────────────────────────────────────

	/** `hidden`: draw even though the stage is not shown yet (a switch's first frame). */
	render(hidden = false): void {
		if ((!this.active && !hidden) || this.destroyed) return;
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
		for (const peer of this.client.presence.values()) {
			const sel = peer.sel;
			if (!sel) continue;
			if ("b" in sel) {
				for (const id of sel.b) presence.set(id, peer.color);
			} else {
				const at = this.client.resolvePos(sel.h);
				if (at) presence.set(at.blockId, peer.color);
			}
		}
		for (const id of want) this.updateEl(id, presence.get(id));
		this.renderEdges();
		this.stats.nodesInDom = this.els.size;
		this.stats.renders.push(performance.now() - t0);
		if (this.stats.renders.length > 5000) this.stats.renders.splice(0, 2500);
	}

	private updateEl(id: string, peer: string | undefined): void {
		const inf = this.info.get(id) as NInfo;
		let ne = this.els.get(id);
		if (!ne) {
			ne = this.createEl(id, inf.more);
			this.els.set(id, ne);
			this.world.append(ne.el);
		}
		const editing = this.editing?.id === id;
		const key = `${inf.content}\u0000${inf.task}\u0000${inf.hasKids}\u0000${inf.collapsed}\u0000${inf.hidden}`;
		if (ne.key !== key) {
			ne.key = key;
			if (inf.more) {
				ne.body.textContent = mapText.more(inf.hidden);
			} else {
				applyChrome(ne.el, ne.g, {
					hasKids: inf.hasKids,
					collapsed: inf.collapsed,
					task: inf.task,
				});
				if (!editing) {
					ne.body.replaceChildren(renderBody(inf.content, this.host.resolveMention));
					ne.body.style.width = `${inf.bodyW}px`;
				}
				ne.badge.textContent = inf.hidden ? `+${inf.hidden}` : "";
			}
		}
		ne.el.classList.toggle("is-root", id === this.rootId);
		ne.el.classList.toggle("is-page", id === this.host.pageId);
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
		ne.el.setAttribute("aria-selected", String(this.selected === id));
		ne.el.classList.toggle("msel", this.host.state.blocks.includes(id));
		if (peer) {
			ne.el.classList.add("ob-peer");
			ne.el.style.setProperty("--peer", peer);
		} else if (ne.el.classList.contains("ob-peer")) ne.el.classList.remove("ob-peer");
	}

	private createEl(id: string, more: boolean): NodeEl {
		const el = document.createElement("div");
		el.className = more ? "mm-node mm-more-node" : "mm-node";
		el.dataset.id = id;
		el.setAttribute("role", "treeitem");
		const g = createGutter();
		const body = document.createElement("div");
		body.className = "mm-body ob-content";
		const badge = document.createElement("span");
		badge.className = "mm-more";
		if (more) el.append(body);
		else el.append(g.el, body, badge);
		return { el, g, body, badge, key: "", x: Number.NaN, y: Number.NaN, w: -1 };
	}

	private renderEdges(): void {
		const key = `${this.layoutDir}:${this.layoutSeq}`;
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

	/** Give these nodes DOM (for an animation) and draw now. */
	materialize(ids: Iterable<string>): void {
		for (const id of ids) this.force.add(id);
		this.render();
	}

	get width(): number {
		return this.stageW;
	}

	get height(): number {
		return this.stageH;
	}

	/** Before a switch: lay out only (no DOM). The stage is the frame's size, given by the caller. */
	prepare(w: number, h: number): void {
		if (w > 0 && h > 0) {
			this.stageW = w;
			this.stageH = h;
		}
		// Layout does not depend on the stage's size: unchanged tree, folding, focus and direction
		// since the last time need no new layout.
		if (this.dirtyLayout) this.relayout();
	}

	activate(): void {
		this.active = true;
		this.stage.classList.add("active");
		if (this.dirtyLayout) this.relayout();
	}

	deactivate(): void {
		this.exitEdit(false);
		this.active = false;
		this.stage.classList.remove("active");
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Selection and editing
	// ─────────────────────────────────────────────────────────────────────────

	select(id: string | null, opts: { focus?: boolean; reveal?: boolean } = {}): void {
		if (this.dirtyLayout) this.relayout();
		if (id && (!this.info.has(id) || isMore(id))) return;
		if (this.editing && this.editing.id !== id) this.exitEdit(false);
		this.selected = id;
		this.host.onSelect(id);
		if (id) {
			this.client.cursorBlock = id;
			this.client.setSelection({ blocks: [id] });
		}
		if (id && opts.reveal !== false) this.ensureVisible(id);
		this.dirtyRender = true;
		this.render();
		if (opts.focus !== false && !this.editing) this.focusStage();
	}

	/**
	 * Keyboard focus to the stage, and drop a DOM selection left in the (hidden) outline: the
	 * browser otherwise works out its bounds every frame (the prototype measured ~20 ms a frame).
	 */
	focusStage(): void {
		this.stage.focus({ preventScroll: true });
		const sel = document.getSelection();
		if (sel?.rangeCount && !this.stage.contains(sel.anchorNode)) sel.removeAllRanges();
	}

	/** Edit a node: an editor of just this block (same schema, dialect, IME handling). */
	enterEdit(id: string, caret: "end" | "start" | number = "end", insert?: string): void {
		if (isMore(id) || !this.client.editable) {
			this.select(id);
			return;
		}
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
		const view = new OutlineView(this.client, { kind: "node", blockId: id }, ne.body, {
			lens: this.host.lens(),
			collapsed: this.host.state.collapsed,
			keys: this.host.surfaceKeys(),
			resolveMention: this.host.resolveMention,
			restoreSel: (sel) => this.host.restoreSel(sel),
			onRefused: this.host.onRefused,
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
		// Structure keys while editing, before ProseMirror's (capture phase on the node; never
		// while composing): Esc back to node selection; Tab adds a child; Shift-Tab outdents and
		// keeps editing; Enter splits through the outline document and editing follows.
		const onKey = (e: KeyboardEvent) => {
			if (e.isComposing || e.keyCode === 229) return;
			const plain = !e.altKey && !e.ctrlKey && !e.metaKey;
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				this.exitEdit(true);
			} else if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
				e.preventDefault();
				e.stopPropagation();
				if (e.shiftKey) {
					const off = this.editOffset(view, id);
					this.exitEdit(true);
					this.cmdOutdent(id);
					if (this.info.has(id)) this.enterEdit(id, off < 0 ? "end" : off);
				} else {
					this.exitEdit(true);
					this.cmdAddChild(id);
				}
			} else if (e.key === "Enter" && plain && !e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				this.splitEditing(view, id);
			}
		};
		ne.body.addEventListener("keydown", onKey, true);
		this.editing = { id, view, ro, size: null, mount: ne.body, onKey };
		ro.observe(ne.el);
		view.pm.focus();
		const doc = view.pm.state.doc;
		const pos = findBlockPos(doc, id);
		if (pos != null) {
			const body = doc.nodeAt(pos)?.child(0);
			const size = body?.isTextblock ? body.content.size : 0;
			const off =
				caret === "start" ? 0 : caret === "end" ? size : Math.max(0, Math.min(caret, size));
			view.applySelection(
				{ anchor: { blockId: id, offset: off }, head: { blockId: id, offset: off }, view },
				false,
			);
		}
		if (insert && view.pm.editable) view.pm.dispatch(view.pm.state.tr.insertText(insert));
		this.render();
	}

	/** The caret's offset in the edited block (-1 when it is elsewhere). */
	private editOffset(view: OutlineView, id: string): number {
		const p = view.locate(view.pm.state.doc, view.pm.state.selection.head);
		return p && p.blockId === id ? p.offset : -1;
	}

	/** Enter while editing a node: split at the caret in the outline document; edit the new block. */
	private splitEditing(view: OutlineView, id: string): void {
		const off = this.editOffset(view, id);
		this.exitEdit(false);
		const next = this.runCmd(id, (v) => splitBlock(v), off);
		if (next) {
			this.flush();
			const outline = this.host.outline;
			const at = outline.locate(outline.pm.state.doc, outline.pm.state.selection.head);
			this.enterEdit(next, at && at.blockId === next ? at.offset : "start");
		} else if (this.info.has(id)) this.enterEdit(id, off < 0 ? "end" : off);
	}

	exitEdit(focusStage: boolean): void {
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
		if (this.active && !this.destroyed) {
			this.flush();
			if (focusStage) this.focusStage();
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Commands: the outline's own ProseMirror commands, on the surface's outline document
	// ─────────────────────────────────────────────────────────────────────────

	/** Put the outline's cursor in a block, run a command; returns where the cursor went. */
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

	/** Tab: a new last child, edited at once. */
	cmdAddChild(id: string): void {
		if (isMore(id)) return;
		if (this.host.state.collapsed.has(id)) this.host.toggleCollapse(id);
		const nid = this.runCmd(id, (v) => addChild(v));
		if (nid && nid !== id) {
			this.flush();
			this.enterEdit(nid, "end");
		}
	}

	/** Enter on a selected node: a new next sibling, edited at once; the root has none (Tab). */
	cmdAddSibling(id: string): void {
		if (isMore(id)) return;
		if (id === this.rootId) {
			this.cmdAddChild(id);
			return;
		}
		const nid = this.runCmd(id, (v) => addSiblingAfter(v));
		if (nid && nid !== id) {
			this.flush();
			this.enterEdit(nid, "end");
		}
	}

	cmdOutdent(id: string): void {
		if (id === this.rootId || isMore(id)) return;
		this.runCmd(id, (v) => outdent(v));
		this.flush();
		this.select(id);
	}

	cmdMove(id: string, dir: -1 | 1): void {
		if (id === this.rootId || isMore(id)) return;
		this.runCmd(id, (v) => moveBlock(v, dir));
		this.flush();
		this.select(id);
	}

	cmdToggleTask(id: string): void {
		if (id === this.rootId || isMore(id)) return;
		this.runCmd(id, () => toggleTask());
		this.flush();
	}

	/** The checkbox clicked: its next state. */
	cmdCycleTask(id: string): void {
		const task = this.client.visible.get(id)?.task;
		if (!task) return;
		const v = this.host.outline;
		const pos = findBlockPos(v.pm.state.doc, id);
		if (pos == null) return;
		v.pm.dispatch(v.pm.state.tr.setNodeAttribute(pos, "task", TASK_NEXT[task]));
		this.dirtyLayout = true;
		this.flush();
	}

	cmdDelete(id: string): void {
		if (id === this.rootId || isMore(id)) return;
		const inf = this.info.get(id);
		const parent = inf?.parent ?? null;
		const sibs = parent ? (this.info.get(parent)?.node.kids ?? []) : [];
		const i = sibs.findIndex((n) => n.id === id);
		const next =
			sibs[i - 1]?.id ??
			(sibs[i + 1] && !isMore(sibs[i + 1]?.id ?? "") ? sibs[i + 1]?.id : null) ??
			parent;
		this.runCmd(id, () => deleteBlock());
		this.flush();
		if (next) this.select(next);
	}

	cmdDrop(id: string, target: string, where: DropWhere): void {
		if (where === "child" && this.host.state.collapsed.has(target))
			this.host.toggleCollapse(target);
		this.runCmd(id, () => moveBlockTo(id, target, where));
		this.flush();
		this.select(id);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Keys
	// ─────────────────────────────────────────────────────────────────────────

	private kidsOf(id: string): string[] {
		return (this.info.get(id)?.node.kids ?? []).map((n) => n.id).filter((x) => !isMore(x));
	}

	private nav(id: string, key: string): string | null {
		const inf = this.info.get(id);
		if (!inf) return null;
		const right = this.dir === "right";
		const toChild = right ? "ArrowRight" : "ArrowDown";
		const toParent = right ? "ArrowLeft" : "ArrowUp";
		const prev = right ? "ArrowUp" : "ArrowLeft";
		const next = right ? "ArrowDown" : "ArrowRight";
		if (key === toChild) return this.kidsOf(id)[0] ?? null;
		if (key === toParent) return inf.parent;
		if (key === prev || key === next) {
			const sibs = inf.parent ? this.kidsOf(inf.parent) : [];
			const j = sibs.indexOf(id) + (key === prev ? -1 : 1);
			if (j >= 0 && sibs[j]) return sibs[j] as string;
			return this.nearestInDirection(id, key);
		}
		return null;
	}

	/** No sibling that way: the nearest node on screen in that direction (a cousin). */
	private nearestInDirection(id: string, key: string): string | null {
		const a = (this.info.get(id) as NInfo).node;
		const ax = a.x + a.w / 2;
		const ay = a.y + a.h / 2;
		let best: string | null = null;
		let bd = Number.POSITIVE_INFINITY;
		for (const [oid, inf] of this.info) {
			if (oid === id || inf.more) continue;
			const b = inf.node;
			const dx = b.x + b.w / 2 - ax;
			const dy = b.y + b.h / 2 - ay;
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

	onKey(e: KeyboardEvent): void {
		if (this.editing || e.defaultPrevented) return;
		if (e.isComposing || e.keyCode === 229) {
			// An input method starts: edit the node so the composition lands in its editor.
			if (this.selected && this.selected !== this.rootId) this.enterEdit(this.selected, "end");
			return;
		}
		const mod = e.ctrlKey || e.metaKey;
		const id = this.selected ?? this.rootId;
		const k = e.key;
		const handled = (): void => {
			e.preventDefault();
			e.stopPropagation();
		};
		if (mod && !e.altKey && (k === "z" || k === "Z")) {
			handled();
			if (e.shiftKey) this.client.redo();
			else this.client.undo();
			return;
		}
		if (mod && !e.altKey && k === "y") {
			handled();
			this.client.redo();
			return;
		}
		if (mod && !e.altKey && k === "Enter") {
			handled();
			this.cmdToggleTask(id);
			return;
		}
		const right = this.dir === "right";
		if (e.altKey && !mod && k.startsWith("Arrow")) {
			handled();
			// Along the sibling axis: move the block; along the depth axis: focus in or out.
			const sibAxis = right
				? k === "ArrowUp" || k === "ArrowDown"
				: k === "ArrowLeft" || k === "ArrowRight";
			if (sibAxis) this.cmdMove(id, k === "ArrowUp" || k === "ArrowLeft" ? -1 : 1);
			else if (k === (right ? "ArrowRight" : "ArrowDown")) {
				if (id !== this.rootId && !isMore(id)) this.host.focusBlock(id);
			} else this.host.focusUp();
			return;
		}
		// The surface's shared keys (collapse all, expand to a level).
		const keys = this.host.surfaceKeys();
		const name = `${e.altKey ? "Alt-" : ""}${mod ? "Mod-" : ""}${e.shiftKey ? "Shift-" : ""}${k}`;
		const shared = keys[name];
		if (shared && /^(Mod-Arrow|Alt-\d)/.test(name)) {
			handled();
			shared(this.host.outline.pm.state);
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
				// A selected node: Enter adds the next sibling and edits it (D29a); typing, F2 or a
				// double click edits the node itself. Editing, Enter splits as in the outline.
				handled();
				if (e.shiftKey) return;
				if (isMore(id)) {
					const parent = this.info.get(id)?.parent;
					if (parent) this.host.focusBlock(parent);
					return;
				}
				this.cmdAddSibling(id);
				return;
			case "F2":
				handled();
				this.enterEdit(id, "end");
				return;
			case " ":
				handled();
				if (this.info.get(id)?.hasKids && id !== this.rootId) this.host.toggleCollapse(id);
				return;
			case "Delete":
			case "Backspace":
				handled();
				this.cmdDelete(id);
				return;
			case "Escape":
				if (this.host.state.blocks.length) {
					handled();
					this.host.state.setBlocks([]);
					this.render();
				}
				return;
		}
		if (k.length === 1 && this.selected && this.selected !== this.rootId) {
			// Typing on a selected node edits it; the character goes at the end.
			handled();
			this.enterEdit(this.selected, "end", k);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Pan, zoom, pick, drag
	// ─────────────────────────────────────────────────────────────────────────

	private onWheel(e: WheelEvent): void {
		e.preventDefault();
		const r = this.stage.getBoundingClientRect();
		if (e.ctrlKey || e.metaKey) {
			const next = clampScale(this.scale * wheelZoomFactor(e.deltaY, PINCH_WHEEL_STEP));
			const t = zoomAround(
				{ scale: this.scale, tx: this.tx, ty: this.ty },
				next,
				{ x: e.clientX - r.left, y: e.clientY - r.top },
				{ x: 0, y: 0 },
			);
			this.setTransform(t.tx, t.ty, t.scale);
		} else this.setTransform(this.tx - e.deltaX, this.ty - e.deltaY);
	}

	/** Zoom to `s` around stage point (sx, sy). */
	zoomAt(s: number, sx: number, sy: number): void {
		const t = zoomAround(
			{ scale: this.scale, tx: this.tx, ty: this.ty },
			clampScale(s),
			{ x: sx, y: sy },
			{ x: 0, y: 0 },
		);
		this.setTransform(t.tx, t.ty, t.scale);
	}

	private nodeIdAt(t: EventTarget | null): string | null {
		const el = (t as HTMLElement | null)?.closest?.(".mm-node") as HTMLElement | null;
		return el?.dataset.id ?? null;
	}

	private pointers = new Map<number, Pos>();
	private gesture: Gesture | null = null;
	private lastTap: { id: string; t: number } | null = null;

	private local(e: PointerEvent): Pos {
		const r = this.stage.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	private onPointerDown(e: PointerEvent): void {
		if (e.button !== 0 && e.pointerType === "mouse") return;
		const p = this.local(e);
		const target = e.target as HTMLElement;
		const id = this.nodeIdAt(target);
		// Inside the node being edited, the editor handles the pointer itself.
		if (this.editing && id === this.editing.id && !target.closest(".ob-gutter")) return;
		this.pointers.set(e.pointerId, p);
		if (this.pointers.size === 2) {
			// A second finger: pinch.
			if (this.gesture?.kind === "node") clearTimeout(this.gesture.timer);
			const [a, b] = [...this.pointers.values()] as [Pos, Pos];
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
			else if (target.closest(".ob-bullet")) {
				if (id === this.rootId) this.host.focusUp();
				else this.host.focusBlock(id);
			} else if (target.closest(".ob-check")) this.cmdCycleTask(id);
			this.pointers.delete(e.pointerId);
			return;
		}
		this.stage.setPointerCapture?.(e.pointerId);
		if (id) {
			e.preventDefault();
			const touch = e.pointerType === "touch";
			const g: Extract<Gesture, { kind: "node" }> = {
				kind: "node",
				id,
				x: p.x,
				y: p.y,
				touch,
				timer: 0,
				drag: false,
				moved: false,
				target: null,
			};
			// Touch: a long press starts dragging; mouse: moving past a threshold does.
			if (touch)
				g.timer = window.setTimeout(() => {
					if (this.gesture === g && !g.moved) this.startDrag(g);
				}, LONG_PRESS_MS);
			this.gesture = g;
			return;
		}
		e.preventDefault();
		if (this.editing) this.exitEdit(false);
		this.stage.focus({ preventScroll: true });
		this.gesture = { kind: "pan", x: p.x, y: p.y, tx: this.tx, ty: this.ty, moved: false };
	}

	private startDrag(g: Extract<Gesture, { kind: "node" }>): void {
		if (g.id === this.rootId || isMore(g.id) || !this.client.editable) return;
		g.drag = true;
		if (this.editing) this.exitEdit(false);
		this.select(g.id, { reveal: false });
		this.els.get(g.id)?.el.classList.add("dragging");
	}

	private onPointerMove(e: PointerEvent): void {
		if (!this.pointers.has(e.pointerId)) return;
		const p = this.local(e);
		this.pointers.set(e.pointerId, p);
		const g = this.gesture;
		if (!g) return;
		if (g.kind === "pinch" && this.pointers.size >= 2) {
			const [a, b] = [...this.pointers.values()] as [Pos, Pos];
			const dist = Math.hypot(a.x - b.x, a.y - b.y);
			const mx = (a.x + b.x) / 2;
			const my = (a.y + b.y) / 2;
			const t = pinchStep(
				{ scale: this.scale, tx: this.tx, ty: this.ty },
				g.dist > 0 ? dist / g.dist : 1,
				{ x: mx, y: my },
				{ x: mx - g.mx, y: my - g.my },
				{ x: 0, y: 0 },
				clampScale,
			);
			this.setTransform(t.tx, t.ty, t.scale);
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
				if (g.touch || !this.client.editable || g.id === this.rootId || isMore(g.id)) {
					// One finger drawn across a node pans (so does a drag on the root or read only).
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

	private onPointerUp(e: PointerEvent, cancel = false): void {
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
			if (!g.moved && !cancel && this.host.state.blocks.length) {
				this.host.state.setBlocks([]);
				this.render();
			}
			return;
		}
		clearTimeout(g.timer);
		if (g.drag) {
			this.els.get(g.id)?.el.classList.remove("dragging");
			this.showDrop(null);
			const ne = this.els.get(g.id);
			if (ne) ne.x = Number.NaN; // back to its layout position on the next draw
			if (g.target && !cancel) this.cmdDrop(g.id, g.target.id, g.target.where);
			else this.render();
			return;
		}
		if (cancel || g.moved) return;
		if (isMore(g.id)) {
			const parent = this.info.get(g.id)?.parent;
			if (parent) this.host.focusBlock(parent);
			return;
		}
		// Click: select; Shift-click: add to or remove from the block selection; a double click
		// (or two taps) edits.
		if (e.shiftKey) {
			const st = this.host.state;
			st.setBlocks(
				st.blocks.includes(g.id) ? st.blocks.filter((x) => x !== g.id) : [...st.blocks, g.id],
			);
			this.render();
			return;
		}
		const now = performance.now();
		const dbl = this.lastTap && this.lastTap.id === g.id && now - this.lastTap.t < DOUBLE_TAP_MS;
		this.lastTap = { id: g.id, t: now };
		if (dbl) {
			this.lastTap = null;
			this.enterEdit(g.id, "end");
			return;
		}
		this.select(g.id, { reveal: false });
	}

	/** Where a drag would drop: a node's middle = under it; its first or last quarter = before or after. */
	dropTarget(dragId: string, sx: number, sy: number): { id: string; where: DropWhere } | null {
		const wx = (sx - this.tx) / this.scale;
		const wy = (sy - this.ty) / this.scale;
		const right = this.dir === "right";
		const half = GAP[this.dir].gapSibling / 2 + 1;
		// The dragged subtree is no target.
		const banned = new Set<string>();
		const stack: LayoutNode[] = [];
		const d = this.info.get(dragId);
		if (d) stack.push(d.node);
		while (stack.length) {
			const n = stack.pop() as LayoutNode;
			banned.add(n.id);
			stack.push(...n.kids);
		}
		for (const id of this.visibleIds(0)) {
			if (banned.has(id) || isMore(id)) continue;
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

	private showDrop(t: { id: string; where: DropWhere } | null): void {
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

	// ─────────────────────────────────────────────────────────────────────────
	// Animation (FLIP with WAAPI)
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * From the given old screen positions (body top-left, stage coordinates, at 1:1) to the current
	 * layout. Only the given nodes move (the caller passes those on screen before or after); the
	 * `fadeIn` ones fade in.
	 */
	flipFrom(from: Map<string, Pos>, fadeIn: string[], ms: number): Animation[] {
		const anims: Animation[] = [];
		if (ms <= 0) return anims;
		const s = this.scale;
		for (const [id, p] of from) {
			const ne = this.els.get(id);
			const inf = this.info.get(id);
			if (!ne || !inf) continue;
			const o = this.bodyOffset(id);
			const wx = (p.x - this.tx - o.x) / s;
			const wy = (p.y - this.ty - o.y) / s;
			if (Math.abs(wx - inf.node.x) < 0.5 && Math.abs(wy - inf.node.y) < 0.5 && s === 1) continue;
			const to = `translate(${inf.node.x}px, ${inf.node.y}px)`;
			const fromT = `translate(${wx}px, ${wy}px) scale(${1 / s})`;
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

	/** The other way: nodes from where they are to target screen positions (the outline's rows). */
	morphTo(to: Map<string, Pos>, ms: number): Animation[] {
		const anims: Animation[] = [];
		if (ms <= 0) return anims;
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

	/** Nodes leaving the tree (focus moved elsewhere) fade out, keeping their DOM until done. */
	fadeOutGhosts(ids: string[], ms: number): Animation[] {
		const anims: Animation[] = [];
		for (const id of ids) {
			const ne = this.els.get(id);
			if (!ne) continue;
			this.els.delete(id);
			if (ms <= 0) {
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

function clampScale(s: number): number {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}
