/**
 * One editing surface of a live page, two views (design §6.10, D29): the outline and the mind map
 * over the same live session, the same outline transactions and undo stack, sharing one view state
 * (`view-state.ts`: focus, folding, selection, viewport anchor, direction). Ported from the outline
 * prototype's editing surface (`prototypes/outline-editor/src/client/surface.ts`) with the
 * practices it measured:
 *
 *   - FOCUS KEEPS THE PAGE. The page's outline view stays (parked: `content-visibility: hidden`,
 *     DOM and layout kept) while a separate view rooted at the focused block is shown; focusing
 *     in and out never tears down 2000 blocks of DOM (prototype: 4–12 ms in, ~5 ms out, instead
 *     of 88–115 ms and ~200 ms). The page view is built the first time it is needed.
 *   - THE HIDDEN VIEW MOVES OFF SCREEN. Behind the map the outline is transparent and translated
 *     out of the frame (layout stays valid, painting is clipped); no inherited property changes
 *     (a `pointer-events` change restyled 20,000 elements in 58 ms), and a DOM selection left in
 *     it is cleared (it cost ~20 ms a frame).
 *   - A SWITCH TAKES TWO FRAMES (`transition.ts`): read and lay out first, show and animate next.
 *   - THE ANCHOR STICKS. The block nearest the viewport's middle keeps its place on screen across
 *     a switch; the previous anchor is kept while it is still in view, so round trips do not
 *     drift.
 *   - Node sizes are measured ahead in a Worker as soon as the page opens (`mindmap/prewarm.ts`).
 *
 * Focus belongs to the host (the route's URL, a dock panel's params): the surface animates a
 * focus change at once and tells the host (`onFocus`); the host's answer comes back as the same
 * focus (`focusFromHost`) and is recognised; any other focus from the host (back, forward, a
 * breadcrumb) is animated as it arrives. A host may show only the last of several quick changes
 * (one render for a focus and its return: its focus never seems to change), so the host also says
 * what it shows after each render (`hostShows`): once that is the newest focus told, nothing told
 * is still on its way, and the next focus from the host is the host's own.
 *
 * No React and no document listeners: the toolbar is React (`OutlineEditor`), keys belong to the
 * editors and the map's stage.
 */
import type { OutlineMapLayout } from "@shared/outline-api";
import type { Command } from "prosemirror-state";
import type { MentionResolver } from "./editor/chrome";
import { mentionLabel } from "./editor/chrome";
import { caretIn } from "./editor/commands";
import type { LiveClient, SelInfo } from "./editor/live-client";
import { findBlockPos, type OutlineLens, type OutlineRefusal, OutlineView } from "./editor/view";
import { MindMapView } from "./mindmap/mindmap";
import { prewarmBodies } from "./mindmap/prewarm";
import {
	FrameDeferral,
	OUTLINE_MOTION_EASING,
	OUTLINE_MOTION_MS,
	reducedMotion,
	type TransitionRecord,
	TransitionTracker,
} from "./transition";
import type { OutlineViewKind, OutlineViewState } from "./view-state";

interface Pos {
	x: number;
	y: number;
}

/** The map waits at most this long for the Worker's sizes of a page that just arrived. */
const PREWARM_HOLD_MS = 1500;
/** Pages smaller than this are measured on the spot (faster than waiting for the Worker). */
const PREWARM_HOLD_MIN_BLOCKS = 300;
/**
 * A cold outline behind the map (see the constructor) is built and laid out once the page is
 * live and nobody touched the surface for this long (in idle time): the switch to the outline is
 * then an ordinary one. Switching sooner builds it on the spot (one long frame).
 */
const COLD_WARM_QUIET_MS = 2000;

/** Blocks most recently focused in this tab (the quick switcher ranks them first). */
const recent: string[] = [];
export function recentFocus(): readonly string[] {
	return recent;
}
export function noteFocusVisit(id: string): void {
	const i = recent.indexOf(id);
	if (i >= 0) recent.splice(i, 1);
	recent.unshift(id);
	if (recent.length > 50) recent.length = 50;
}

/** Surfaces alive in this tab (tests and debugging read them; nothing else does). */
const surfaces = new Set<EditSurface>();
export function liveEditSurfaces(): EditSurface[] {
	return [...surfaces];
}

export interface EditSurfaceOptions {
	client: LiveClient;
	pageId: string;
	state: OutlineViewState;
	/** The frame both views share (the surface fills it). */
	frame: HTMLElement;
	/** The focused block at mount (the page itself when unfocused). */
	focusId: string;
	lens: OutlineLens;
	resolveMention: MentionResolver;
	/** The focus moved here: the host records it (a history entry, panel params). */
	onFocus: (id: string) => void;
	onRefused?: (reason: OutlineRefusal) => void;
	/** Blocks the facts view leaves out under the focused block. */
	onHiddenChange?: (count: number) => void;
	/** Measure the map's nodes ahead in a Worker (default on). */
	premeasure?: boolean;
}

export class EditSurface {
	readonly client: LiveClient;
	readonly pageId: string;
	readonly state: OutlineViewState;
	readonly frame: HTMLElement;
	readonly scroller: HTMLElement;
	private readonly pageHost: HTMLElement;
	private readonly focusHost: HTMLElement;
	/** The page's outline view, built when first needed; parked while a block is focused. */
	pageView: OutlineView | null = null;
	/** The outline view rooted at the focused block (none when the page itself is shown). */
	focusView: OutlineView | null = null;
	readonly map: MindMapView;
	private pageScroll = 0;
	private lens: OutlineLens;
	private keys: Record<string, Command> | null = null;
	private readonly deferral = new FrameDeferral();
	private readonly tracker = new TransitionTracker();
	/** Timings of the last switch (tests). */
	parts: Record<string, number> = {};
	/** Focus changes for the host whose echo has not come back yet (`sent`: told already). */
	private echo: Array<{ id: string; sent: boolean }> = [];
	private restoring = false;
	private destroyed = false;
	/** What was measured ahead: nothing yet, the seeded page (HTTP read), the live page. */
	private prewarmed: "none" | "seed" | "live" = "none";
	/** The outline behind the map was never shown (see the constructor). */
	private outlineCold = false;
	private warmTimer: ReturnType<typeof setTimeout> | undefined;
	prewarmDone: Promise<void> = Promise.resolve();
	/**
	 * A focus the host asked for while the page is still seeded and the block is not here yet
	 * (its read is on its way): applied once it arrives.
	 */
	private pendingFocus: string | null = null;
	private readonly offs: Array<() => void> = [];

	constructor(private readonly opts: EditSurfaceOptions) {
		this.client = opts.client;
		this.pageId = opts.pageId;
		this.state = opts.state;
		this.frame = opts.frame;
		this.lens = opts.lens;
		this.frame.classList.add("nf-outline-frame");
		this.scroller = document.createElement("div");
		this.scroller.className = "nf-outline-scroller";
		this.pageHost = document.createElement("div");
		this.pageHost.className = "nf-outline-host";
		this.focusHost = document.createElement("div");
		this.focusHost.className = "nf-outline-host nf-outline-focus-host";
		this.scroller.append(this.pageHost, this.focusHost);
		this.frame.append(this.scroller);
		const self = this;
		this.map = new MindMapView(
			{
				client: this.client,
				state: this.state,
				get outline() {
					return self.outline;
				},
				pageId: this.pageId,
				lens: () => this.lens,
				resolveMention: opts.resolveMention,
				focusBlock: (id) => this.focusBlock(id),
				focusUp: () => this.focusUp(),
				toggleCollapse: (id) => this.toggleCollapse(id),
				surfaceKeys: () => this.surfaceKeys(),
				restoreSel: (sel) => this.restoreSel(sel),
				onSelect: (id) => this.onMapSelect(id),
				onRefused: opts.onRefused,
			},
			this.frame,
		);
		// Shown in the map from the start (a panel restored in the map, a jump to another page in
		// the map): the outline behind it is cold — not built until it is needed (a structural
		// command, the switch to the outline), and out of layout until first shown. Arriving on a
		// large page in the map then draws the map without laying out every block's editor.
		this.outlineCold = this.state.view === "map";
		if (this.outlineCold) this.scroller.classList.add("nf-outline-cold");
		// The initial focus, without animation (the host's: the page may not have arrived yet).
		this.state.focus = opts.focusId;
		this.setOutlineFocus(opts.focusId);
		if (!this.outlineCold && !this.focusView) this.ensurePageView();
		else if (this.outlineCold && this.client.ready) this.scheduleWarm();
		const shownView = this.focusView ?? this.pageView;
		if (shownView) shownView.noScroll = this.state.view === "map";
		if (this.state.view === "map") {
			// Shown again (a panel back on screen): straight into the map, no animation.
			this.map.activate();
			this.map.prepare(0, 0);
			this.map.placeRoot();
			this.map.render();
		}
		this.renderAttrs();
		this.offs.push(
			this.client.on((event) => {
				if (event === "sync") this.onStoreChange();
				else if (event === "presence" && this.state.view === "map") this.map.schedule(false);
				if (this.prewarmed !== this.shownFrom()) this.prewarm();
			}),
			this.state.on((part) => {
				if (part === "stored") this.onStored();
				else if (part === "blocks" && this.state.view === "map") this.map.render();
			}),
		);
		// Input finishes a pending second step first, so it lands on the right view.
		// Input also postpones warming a cold outline (it costs a long frame).
		const flush = () => {
			this.deferral.flush();
			if (this.outlineCold) this.scheduleWarm();
		};
		this.frame.addEventListener("keydown", flush, true);
		this.frame.addEventListener("pointerdown", flush, true);
		this.frame.addEventListener("wheel", flush, { capture: true, passive: true });
		this.offs.push(() => {
			this.frame.removeEventListener("keydown", flush, true);
			this.frame.removeEventListener("pointerdown", flush, true);
			this.frame.removeEventListener("wheel", flush, true);
			clearTimeout(this.warmTimer);
		});
		if (opts.premeasure !== false && this.shownFrom() !== "none")
			setTimeout(() => this.prewarm(), 0);
		surfaces.add(this);
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		surfaces.delete(this);
		this.deferral.cancel();
		this.tracker.finish();
		for (const off of this.offs.splice(0)) off();
		this.map.destroy();
		// The editors stop following the client now; their teardown (a node view and DOM per
		// block) waits until the frame after: another page's surface in the same frame (a jump)
		// paints first.
		const views = [this.focusView, this.pageView].filter((v): v is OutlineView => v !== null);
		for (const v of views) v.detach();
		this.focusView = null;
		this.pageView = null;
		// Hidden without touching its layout (display: none would tear the layout of every block
		// down in the next frame, the new page's first one); removed with the rest after it.
		const scroller = this.scroller;
		scroller.style.opacity = "0";
		scroller.style.zIndex = "-1";
		let torn = false;
		const tearDown = () => {
			if (torn) return;
			torn = true;
			for (const v of views) v.destroy();
			scroller.remove();
		};
		// After the next page has arrived and painted (its read, its snapshot): in idle time a
		// moment later, and at the latest after two seconds (a tab that paints nothing).
		setTimeout(() => {
			if (typeof requestIdleCallback === "function")
				requestIdleCallback(tearDown, { timeout: 1500 });
			else tearDown();
		}, 400);
		setTimeout(tearDown, 2000);
		this.frame.classList.remove("nf-outline-frame");
		delete this.frame.dataset.view;
		delete this.frame.dataset.layout;
	}

	/** Where the page on screen comes from: nothing yet, an HTTP read (seed), the live session. */
	private shownFrom(): "none" | "seed" | "live" {
		return this.client.ready ? "live" : this.client.seeded ? "seed" : "none";
	}

	/**
	 * Measure every block of the page for the map, in a Worker: once the page is seeded from its
	 * HTTP read, and again once live (only bodies not measured yet are sent).
	 */
	prewarm(): Promise<void> {
		const from = this.shownFrom();
		if (this.opts.premeasure === false || this.destroyed || from === "none") {
			return this.prewarmDone;
		}
		const firstShown = this.prewarmed === "none";
		this.prewarmed = from;
		const v = this.client.visible;
		const labelOf = (ref: string, label: string | null) =>
			mentionLabel(this.opts.resolveMention, ref, label);
		const client = this.client;
		// Posted after this task (the page arriving is busy enough); the map's hold below starts
		// now, before its first layout.
		this.prewarmDone = new Promise<void>((resolve) => {
			setTimeout(() => {
				if (this.destroyed) return resolve();
				// Every block the client has (a seed of a focused block has no page around it).
				const ids: string[] = [];
				for (const b of client.visible.blocks.values()) if (!b.deleted) ids.push(b.id);
				prewarmBodies(
					(function* () {
						for (const id of ids) yield { content: client.textOf(id), labelOf };
					})(),
				).then(resolve, resolve);
			}, 0);
		});
		// The map on screen as the page arrives (a panel restored in the map, a jump to another
		// page): it lays out only a part until the Worker answers (at most `PREWARM_HOLD_MS`),
		// instead of measuring every body on the main thread.
		if (firstShown && this.state.view === "map" && v.blocks.size > PREWARM_HOLD_MIN_BLOCKS) {
			this.map.holdLayout(
				Promise.race([
					this.prewarmDone,
					new Promise<void>((resolve) => setTimeout(resolve, PREWARM_HOLD_MS)),
				]),
			);
		}
		return this.prewarmDone;
	}

	/** The outline view on screen (or behind the map): the focus view, else the page view. */
	get outline(): OutlineView {
		return this.focusView ?? this.ensurePageView();
	}

	/** Every outline view (the parked page view included). */
	private outlines(): OutlineView[] {
		return [this.pageView, this.focusView].filter((v): v is OutlineView => v !== null);
	}

	get view(): OutlineViewKind {
		return this.state.view;
	}

	get isDestroyed(): boolean {
		return this.destroyed;
	}

	get log(): readonly TransitionRecord[] {
		return this.tracker.log;
	}

	get animating(): boolean {
		return this.deferral.waiting || this.tracker.active;
	}

	setLens(lens: OutlineLens): void {
		if (this.lens === lens) return;
		this.lens = lens;
		for (const v of this.outlines()) v.setLens(lens);
		this.map.schedule();
		this.reportHidden();
	}

	private reportHidden(): void {
		// A cold outline (see the constructor) is not built for this.
		const v = this.focusView ?? this.pageView;
		if (v) this.opts.onHiddenChange?.(v.hiddenByLens);
	}

	private ensurePageView(): OutlineView {
		if (this.pageView) return this.pageView;
		this.pageView = this.makeView(this.pageId, this.pageHost);
		this.pageView.noScroll = this.state.view === "map";
		if (this.focusView) this.pageHost.classList.add("nf-outline-parked");
		return this.pageView;
	}

	/** Warm a cold outline after a quiet moment once the page is live (`COLD_WARM_QUIET_MS`). */
	private scheduleWarm(): void {
		if (!this.outlineCold || this.destroyed || !this.client.ready) return;
		clearTimeout(this.warmTimer);
		this.warmTimer = setTimeout(() => {
			const run = () => {
				if (!this.destroyed && this.outlineCold && this.state.view === "map") this.warmOutline();
			};
			if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
			else run();
		}, COLD_WARM_QUIET_MS);
	}

	/** The outline is about to be shown: built (if the page view is the one shown) and laid out. */
	private warmOutline(): void {
		if (!this.outlineCold) return;
		this.outlineCold = false;
		if (!this.focusView) this.ensurePageView();
		this.scroller.classList.remove("nf-outline-cold");
	}

	private makeView(rootId: string, host: HTMLElement): OutlineView {
		const v: OutlineView = new OutlineView(this.client, { kind: "focus", rootId }, host, {
			lens: this.lens,
			collapsed: this.state.collapsed,
			keys: this.surfaceKeys(),
			resolveMention: this.opts.resolveMention,
			onBullet: (id) => this.focusBlock(id),
			onCollapse: () => {
				// Folding is shared: the other outline view and the map follow.
				for (const o of this.outlines()) if (o !== v) o.sync();
				this.map.schedule();
				this.state.noteCollapsed();
			},
			onSelect: (blockId) => {
				if (this.restoring || this.state.view !== "outline") return;
				// The person moved to another block in the outline: block selection ends.
				if (this.state.blocks.length && !v.blockSel) this.state.setBlocks([]);
				this.state.setCaret({ blockId, anchor: -2, head: -2 });
			},
			onBlockSelection: (ids) => {
				if (this.restoring) return;
				this.state.setBlocks(ids);
			},
			onRefused: this.opts.onRefused,
			restoreSel: (sel) => this.restoreSel(sel),
		});
		v.noScroll = this.state.view === "map";
		return v;
	}

	/** The outline's focus: build or drop the focus view; park or restore the page view. */
	/**
	 * The outline's focus: build or drop the focus view; park or restore the page view. With
	 * `deferPark`, the page view is parked by the caller (`parkPage`) after the keyboard moved to
	 * the focus view: focusing an editor while a `content-visibility: hidden` subtree of 2000
	 * blocks is in the document costs the browser 50–90 ms; before the lock it is about 1 ms.
	 */
	private setOutlineFocus(id: string, opts: { deferPark?: boolean } = {}): void {
		const cur = this.focusView;
		const want = id === this.pageId ? null : id;
		if ((cur?.rootId ?? null) === want) return;
		if (!cur) this.pageScroll = this.scroller.scrollTop;
		if (cur && want) {
			// From one focused block to another: the same editor takes the new root, so the
			// keyboard does not move (focusing an editor beside a parked page is what costs).
			cur.setRoot(want);
			this.reportHidden();
			return;
		}
		if (cur) {
			this.focusView = null;
			cur.destroy();
			this.focusHost.replaceChildren();
		}
		if (want) {
			this.releaseSelection(this.pageHost);
			if (!opts.deferPark) this.parkPage();
			this.focusView = this.makeView(want, this.focusHost);
		} else {
			// Cold (the map on screen since the page arrived): built when first needed.
			if (!this.outlineCold || this.pageView) this.ensurePageView();
			this.pageHost.classList.remove("nf-outline-parked");
			this.scroller.scrollTop = this.pageScroll;
		}
		this.reportHidden();
	}

	private parkPage(): void {
		this.pageHost.classList.add("nf-outline-parked");
	}

	/**
	 * Drop keyboard focus and the DOM selection from a view about to be parked, while it still has
	 * its layout: a selection or focused editor left inside a skipped subtree makes the browser
	 * lay it out again when focus moves on (~70–90 ms for 2000 blocks).
	 */
	private releaseSelection(host: HTMLElement): void {
		const active = document.activeElement;
		if (active instanceof HTMLElement && host.contains(active)) active.blur();
		const sel = document.getSelection();
		if (sel?.rangeCount && host.contains(sel.anchorNode)) sel.removeAllRanges();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Keys shared by the outline, the map and node editors
	// ─────────────────────────────────────────────────────────────────────────

	surfaceKeys(): Record<string, Command> {
		if (this.keys) return this.keys;
		const k: Record<string, Command> = {
			"Alt-ArrowRight": () => {
				const id = this.currentBlock();
				if (id && id !== this.state.focus) this.focusBlock(id);
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
		};
		for (let n = 1; n <= 9; n++)
			k[`Alt-${n}`] = () => {
				this.expandToLevel(n);
				return true;
			};
		this.keys = k;
		return k;
	}

	/** The current block: the cursor's in the outline, the selected (or edited) node in the map. */
	currentBlock(): string | null {
		if (this.state.view === "map") return this.map.editing?.id ?? this.map.selected;
		return this.outline.captureSel()?.head.blockId ?? null;
	}

	private renderAttrs(): void {
		this.frame.dataset.view = this.state.view;
		this.frame.dataset.layout = this.state.layout;
		// The view not shown is hidden from assistive technology.
		this.scroller.setAttribute("aria-hidden", String(this.state.view !== "outline"));
		this.map.stage.setAttribute("aria-hidden", String(this.state.view !== "map"));
	}

	private onStoreChange(): void {
		const v = this.client.visible;
		if (this.outlineCold && this.client.ready && this.warmTimer === undefined) this.scheduleWarm();
		// A focus asked for before its block arrived (seeded from another read).
		const pending = this.pendingFocus;
		if (pending && (pending === this.pageId || v.alive(pending))) {
			this.pendingFocus = null;
			this.focusBlock(pending, { notify: false });
		} else if (pending && this.client.ready) this.pendingFocus = null;
		// The focused block was deleted: back to its nearest live ancestor.
		const f = this.state.focus;
		if (this.client.ready && f !== this.pageId && v.get(f) && !v.alive(f)) {
			let cur = v.get(f)?.parentId ?? null;
			while (cur && !v.alive(cur)) cur = v.get(cur)?.parentId ?? null;
			this.focusBlock(cur ?? this.pageId, { animate: false });
		}
		this.map.schedule();
		this.reportHidden();
	}

	/** The stored folding and direction arrived: every view follows. */
	private onStored(): void {
		for (const v of this.outlines()) v.sync();
		this.map.schedule();
		if (this.state.view === "map") this.map.flush();
		this.renderAttrs();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Selection
	// ─────────────────────────────────────────────────────────────────────────

	private onMapSelect(id: string | null): void {
		const st = this.state;
		if (!id || st.caret?.blockId === id) return;
		st.setCaret({ blockId: id, anchor: -2, head: -2 });
	}

	/** Undo or redo puts a selection back: into the view on screen. */
	restoreSel(sel: SelInfo): boolean {
		if (this.destroyed) return true;
		if (this.state.view === "outline") {
			if (sel.view === this.outline) return false;
			this.outline.applySelection({ ...sel, view: this.outline });
			return true;
		}
		const id = sel.head.blockId;
		this.state.caret = { blockId: id, anchor: sel.anchor.offset, head: sel.head.offset };
		const ed = this.map.editing;
		if (ed && ed.id === id) ed.view.applySelection({ ...sel, view: ed.view }, false);
		else {
			this.map.flush();
			if (this.map.info.has(id)) this.map.select(id);
		}
		return true;
	}

	/** The cursor or selected node into the view state. */
	captureCaret(): void {
		const st = this.state;
		if (st.view === "outline") {
			// In block selection the text selection only spans the selected blocks: the caret
			// is where it was before.
			if (this.outline.blockSel) return;
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

	/** The view state's caret and block selection into the outline, without scrolling it. */
	private applyCaretToOutline(): void {
		this.restoring = true;
		const v = this.outline;
		const noScroll = v.noScroll;
		v.noScroll = true;
		try {
			if (!this.applyBlocksToOutline()) this.applyCaretInner();
		} finally {
			v.noScroll = noScroll;
			this.restoring = false;
		}
	}

	/**
	 * The block selection back into the outline when it is one run of siblings (the outline's
	 * block selection is a run); true when the outline is in block selection now. Blocks picked
	 * one by one in the map stay in the view state; the outline then shows the caret.
	 */
	private applyBlocksToOutline(): boolean {
		const ids = this.state.blocks;
		const v = this.outline;
		if (!ids.length) {
			if (v.blockSel) v.setBlockSelection(null);
			return false;
		}
		const parent = this.client.visible.get(ids[0] as string)?.parentId;
		const sibs = parent ? this.client.visible.children(parent) : [];
		const first = sibs.indexOf(ids[0] as string);
		if (first < 0 || !ids.every((id, i) => sibs[first + i] === id)) {
			if (v.blockSel) v.setBlockSelection(null);
			return false;
		}
		// Always again: the map's commands move the outline's text selection meanwhile.
		v.setBlockSelection({ anchor: ids[0] as string, head: ids[ids.length - 1] as string });
		return true;
	}

	private applyCaretInner(): void {
		const c = this.state.caret;
		if (!c || !this.client.visible.alive(c.blockId)) return;
		// Already there (round trips): no transaction.
		const cur = this.outline.captureSel();
		if (
			cur &&
			cur.head.blockId === c.blockId &&
			cur.anchor.blockId === c.blockId &&
			(c.head === -2 || (cur.head.offset === c.head && cur.anchor.offset === c.anchor))
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

	/** The outline's cursor at the end of a block's body, without scrolling. */
	placeCaret(id: string): void {
		const v = this.outline;
		const doc = v.pm.state.doc;
		const pos = findBlockPos(doc, id);
		if (pos == null) return;
		v.pm.dispatch(v.pm.state.tr.setSelection(caretIn(doc, pos, -1)).setMeta("remote", true));
	}

	// ─────────────────────────────────────────────────────────────────────────
	// The outline's geometry
	// ─────────────────────────────────────────────────────────────────────────

	private frameRect(): DOMRect {
		return this.frame.getBoundingClientRect();
	}

	/** A block's body element in the outline. */
	rowBody(id: string): HTMLElement | null {
		const el = this.outline.blockEls.get(id);
		if (!el) return null;
		return (
			(el.querySelector(":scope > .ob-content")?.firstElementChild as HTMLElement | null) ?? null
		);
	}

	/** A body's top-left corner relative to the frame; null when folded away. */
	rowPos(id: string, fr = this.frameRect()): Pos | null {
		const b = this.rowBody(id);
		if (!b) return null;
		const r = b.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) return null;
		return { x: r.left - fr.left, y: r.top - fr.top };
	}

	/** Blocks the outline shows unfolded, in document order. */
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

	/** Rows in the viewport: bodies only grow downwards, so binary search the first, read on. */
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
			const r = this.rowBody(order[mid] as string)?.getBoundingClientRect();
			if (!r || r.bottom - fr.top < top) lo = mid + 1;
			else hi = mid;
		}
		for (let i = lo; i < order.length; i++) {
			const el = this.rowBody(order[i] as string);
			if (!el) continue;
			const r = el.getBoundingClientRect();
			if (r.top - fr.top > bottom) break;
			if (r.bottom - fr.top < top) continue;
			out.set(order[i] as string, { x: r.left - fr.left, y: r.top - fr.top });
		}
		return out;
	}

	/** The anchor: the last one while still in view (round trips do not drift), else nearest. */
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

	/** Where an anchor block's body is on screen now (tests: drift after a switch). */
	anchorScreen(id: string): Pos | null {
		if (this.state.view === "map") return this.map.bodyScreen(id);
		return this.rowPos(id);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Switching views
	// ─────────────────────────────────────────────────────────────────────────

	/** Finish a running animation and a pending second step (before anything new starts). */
	finishTransition(): void {
		this.deferral.flush();
		this.tracker.finish();
	}

	/** Switch views; `focus`: give the target view the keyboard (a toolbar button was used). */
	setView(kind: OutlineViewKind, opts: { focus?: boolean } = {}): void {
		if (this.destroyed || this.state.view === kind) return;
		if (kind === "map") this.toMap(opts.focus === true);
		else this.toOutline(opts.focus === true);
	}

	private track(kind: string, anims: Animation[], done: () => void, t0: number): void {
		this.tracker.track(kind, anims, done, t0, {
			parts: this.parts,
			anchor: this.state.anchor ? { ...this.state.anchor } : null,
		});
		this.parts = {};
	}

	private toMap(takeFocus: boolean): void {
		this.finishTransition();
		const t0 = performance.now();
		const st = this.state;
		this.captureCaret();
		// Read only: the outline's rows on screen and the anchor; the map's layout and pan are
		// computed (no DOM); rows of blocks entering the viewport are read while the outline still
		// has its layout.
		const fr = this.frameRect();
		const rows = this.outlineRows();
		const anchor = this.pickAnchor(rows, { x: fr.width / 2, y: fr.height / 2 });
		const hadFocus = takeFocus || this.frame.contains(document.activeElement);
		const map = this.map;
		const t1 = performance.now();
		map.prepare(fr.width, fr.height);
		if (anchor && map.info.has(anchor.blockId)) map.placeBody(anchor.blockId, anchor.x, anchor.y);
		else map.placeRoot();
		const after = map.visibleIds(0);
		const t2 = performance.now();
		// Only blocks on screen before or after move; the rest fade.
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
		// Node DOM is built in the still transparent stage (laid out and painted this frame);
		// keys go to the stage at once.
		for (const id of from.keys()) map.force.add(id);
		map.render(true);
		map.stage.classList.add("pre");
		if (hadFocus || document.activeElement === document.body) map.focusStage();
		else {
			const s = document.getSelection();
			if (s?.anchorNode && this.scroller.contains(s.anchorNode)) s.removeAllRanges();
		}
		const t3 = performance.now();
		const parts = { read: t1 - t0, layout: t2 - t1, render: t3 - t2 };
		st.emit("view");
		const show = () => {
			const t4 = performance.now();
			map.stage.classList.remove("pre");
			this.renderAttrs();
			map.activate();
			map.render();
			const anims = reducedMotion() ? [] : map.flipFrom(from, fadeIn, OUTLINE_MOTION_MS);
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
		};
		this.deferral.defer(show);
	}

	private toOutline(takeFocus: boolean): void {
		this.finishTransition();
		const t0 = performance.now();
		// The first time after arriving in the map: the outline is built and laid out now (one
		// long frame instead of a long arrival).
		this.warmOutline();
		const st = this.state;
		const map = this.map;
		map.flush();
		this.captureCaret();
		const cands = new Map<string, Pos>();
		for (const id of map.visibleIds(0)) {
			const p = map.bodyScreen(id);
			if (p && id !== this.pageId && map.info.get(id)?.more !== true) cands.set(id, p);
		}
		const anchor = this.pickAnchor(cands, { x: map.width / 2, y: map.height / 2 });
		const hadFocus = takeFocus || this.frame.contains(document.activeElement);
		map.exitEdit(false);
		st.view = "outline";
		st.anchor = anchor;
		this.outline.noScroll = false;
		this.renderAttrs();
		this.frame.classList.add("morphing");
		// The cursor and keyboard focus go to the outline now (still transparent, but it takes
		// keys and input methods).
		this.applyCaretToOutline();
		if (hadFocus || document.activeElement === document.body) {
			this.restoring = true;
			this.outline.pm.focus();
			this.restoring = false;
		}
		const parts0 = { map: performance.now() - t0 };
		st.emit("view");
		// This frame only unlocks the outline (still transparent); the next reads rows, places the
		// anchor and animates.
		this.deferral.defer(() => {
			const t2 = performance.now();
			const fr = this.frameRect();
			if (anchor) {
				const p = this.rowPos(anchor.blockId, fr);
				// Usually already in place on round trips: no scrollTop write (it costs a hit test).
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
			let anims: Animation[] = [];
			if (!reducedMotion()) {
				map.materialize([...to.keys()].filter((id) => map.info.has(id)));
				anims = map.morphTo(to, OUTLINE_MOTION_MS);
			}
			this.parts = { ...parts0, read: t3 - t2, anim: performance.now() - t3 };
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

	setLayout(dir: OutlineMapLayout): void {
		const st = this.state;
		if (this.destroyed || st.layout === dir) return;
		if (st.view !== "map") {
			st.setLayout(dir);
			this.map.schedule();
			this.renderAttrs();
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
		// Where blocks off screen were too (those entering the viewport move in from there).
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
		const parts = { layout: performance.now() - t0 };
		st.emit("layout");
		// Next frame: nodes to their new places and the animation, in one frame (no flash of the
		// end state).
		this.deferral.defer(() => {
			const t1 = performance.now();
			this.renderAttrs();
			for (const id of from.keys()) map.force.add(id);
			map.render();
			const anims = reducedMotion() ? [] : map.flipFrom(from, [], OUTLINE_MOTION_MS);
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
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Folding
	// ─────────────────────────────────────────────────────────────────────────

	toggleCollapse(id: string): void {
		const c = this.state.collapsed;
		if (c.has(id)) c.delete(id);
		else c.add(id);
		this.applyCollapse();
	}

	/** Blocks under the focused one (not itself) with their level (its children are level 1). */
	private subtree(): Array<{ id: string; depth: number; kids: number }> {
		const v = this.client.visible;
		const root = this.state.focus;
		const out: Array<{ id: string; depth: number; kids: number }> = [];
		const stack: Array<{ id: string; depth: number }> = [{ id: root, depth: 0 }];
		while (stack.length) {
			const { id, depth } = stack.pop() as { id: string; depth: number };
			const kids = v.children(id);
			if (id !== root) out.push({ id, depth, kids: kids.length });
			for (const k of kids) stack.push({ id: k, depth: depth + 1 });
		}
		return out;
	}

	private applyCollapse(): void {
		for (const v of this.outlines()) v.sync();
		this.map.schedule();
		if (this.state.view === "map") this.map.flush();
		this.state.noteCollapsed();
	}

	collapseAll(): void {
		for (const b of this.subtree()) if (b.kids) this.state.collapsed.add(b.id);
		this.applyCollapse();
	}

	expandAll(): void {
		for (const b of this.subtree()) this.state.collapsed.delete(b.id);
		this.applyCollapse();
	}

	/** Alt+N: open down to level N (level N and deeper folded). */
	expandToLevel(n: number): void {
		for (const b of this.subtree()) {
			if (b.kids && b.depth >= n) this.state.collapsed.add(b.id);
			else this.state.collapsed.delete(b.id);
		}
		this.applyCollapse();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Focus
	// ─────────────────────────────────────────────────────────────────────────

	focusUp(): void {
		const f = this.state.focus;
		if (f === this.pageId) return;
		const parent = this.client.visible.get(f)?.parentId ?? null;
		// Seeded from the read of the focused block: its parent is not here yet. The host reads
		// it (and seeds it); the focus moves when it arrives.
		if (parent && !this.client.visible.alive(parent) && this.client.provisional) {
			this.pendingFocus = parent;
			// Not an echo to wait for: the host's answer moves the focus (when the parent is here).
			this.notifyHost({ id: parent, sent: false });
			return;
		}
		this.focusBlock(parent ?? this.pageId);
	}

	/** The host's focus (a navigation): animate unless it is the echo of one made here. */
	focusFromHost(id: string): void {
		const at = this.echo.findIndex((e) => e.id === id);
		if (at >= 0) {
			this.echo.splice(0, at + 1);
			return;
		}
		this.echo = [];
		// Not here yet while seeded: focused when its read arrives.
		this.pendingFocus = !this.focusBlock(id, { notify: false }) && !this.client.ready ? id : null;
	}

	/**
	 * Focus a block (the page id: the whole page). Animated; the host is told unless the change
	 * came from it. A block not on this page is ignored (the host is loading another page).
	 */
	focusBlock(
		id: string,
		opts: { notify?: boolean; animate?: boolean; takeFocus?: boolean } = {},
	): boolean {
		if (this.destroyed) return false;
		const st = this.state;
		if (id !== this.pageId && !this.client.visible.alive(id)) return false;
		if (st.focus === id) return true;
		this.finishTransition();
		const t0 = performance.now();
		const prev = st.focus;
		const animate = opts.animate !== false && !reducedMotion();
		const takeFocus = opts.takeFocus === true;
		if (st.view === "map") this.zoomMap(id, animate, t0, takeFocus);
		else this.zoomOutline(prev, id, animate, t0, takeFocus);
		noteFocusVisit(id);
		st.emit("focus");
		if (opts.notify !== false) {
			const told = { id, sent: false };
			this.echo.push(told);
			if (this.echo.length > 20) this.echo.splice(0, this.echo.length - 20);
			this.notifyHost(told);
		}
		return true;
	}

	/**
	 * Tell the host after the frame with the new focus is painted: what the host does with it (a
	 * route change, reading the block for the toolbar) does not hold up that frame.
	 */
	private notifyHost(told: { id: string; sent: boolean }): void {
		requestAnimationFrame(() => {
			setTimeout(() => {
				if (this.destroyed) return;
				told.sent = true;
				this.opts.onFocus(told.id);
			}, 0);
		});
	}

	/**
	 * What the host shows after a render. The newest focus told, and told already: the host has
	 * caught up (whether it showed the ones before or not), so nothing is on its way any more.
	 */
	hostShows(id: string): void {
		const newest = this.echo[this.echo.length - 1];
		if (newest?.sent && newest.id === id) this.echo = [];
	}

	private zoomOutline(
		prev: string,
		id: string,
		animate: boolean,
		t0: number,
		takeFocus: boolean,
	): void {
		const st = this.state;
		const fr = this.frameRect();
		const unfocused = (x: string) => x === this.pageId;
		// In: the focused block grows from where it was to the root's place; out: the reverse.
		const subject = unfocused(id) ? prev : id;
		const before = unfocused(subject) ? null : this.rowPos(subject, fr);
		const caret = this.outline.captureSel();
		const hadFocus = takeFocus || this.frame.contains(document.activeElement);
		st.focus = id;
		this.setOutlineFocus(id, { deferPark: true });
		this.map.schedule();
		// The cursor comes along when it is under the new root; otherwise it goes to the root.
		// The keyboard moves before the page view is parked (see `setOutlineFocus`).
		const inside = caret && this.inFocus(caret.head.blockId);
		this.restoring = true;
		try {
			if (inside && caret) this.outline.applySelection({ ...caret, view: this.outline }, false);
			else this.placeCaret(id);
			if (hadFocus) this.outline.pm.focus();
		} finally {
			this.restoring = false;
		}
		if (!unfocused(id)) {
			this.parkPage();
			this.scroller.scrollTop = 0;
		} else if (before) {
			const p = this.rowPos(prev, fr);
			if (p) this.scroller.scrollTop += p.y - before.y;
		}
		const after = unfocused(subject) ? null : this.rowPos(subject, fr);
		const anims: Animation[] = [];
		if (animate && before && after) {
			const dx = before.x - after.x;
			const dy = before.y - after.y;
			const dom = this.outline.pm.dom as HTMLElement;
			dom.style.transformOrigin = `${after.x}px ${after.y + this.scroller.scrollTop}px`;
			anims.push(
				dom.animate(
					[
						{
							transform: `translate(${dx}px, ${dy}px) scale(${unfocused(id) ? 1.15 : 0.85})`,
							opacity: 0.4,
						},
						{ transform: "none", opacity: 1 },
					],
					{ duration: OUTLINE_MOTION_MS, easing: OUTLINE_MOTION_EASING },
				),
			);
		}
		this.track(unfocused(id) ? "focusOut" : "focusIn", anims, () => {}, t0);
	}

	private inFocus(blockId: string): boolean {
		const f = this.state.focus;
		if (blockId === f) return true;
		return this.client.visible.isAncestor(f, blockId);
	}

	private zoomMap(id: string, animate: boolean, t0: number, takeFocus: boolean): void {
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
		const anims: Animation[] = map.fadeOutGhosts(ghosts, animate ? OUTLINE_MOTION_MS * 0.6 : 0);
		const from = new Map<string, Pos>();
		const fadeIn: string[] = [];
		for (const vid of [...visBefore, ...map.visibleIds(0)]) {
			if (!map.info.has(vid) || from.has(vid)) continue;
			const p = oldPos.get(vid);
			if (p) from.set(vid, p);
			else fadeIn.push(vid);
		}
		for (const k of from.keys()) map.force.add(k);
		const sel = map.selected && map.info.has(map.selected) ? map.selected : id;
		map.select(sel, {
			reveal: false,
			focus: takeFocus || this.frame.contains(document.activeElement),
		});
		if (animate) anims.push(...map.flipFrom(from, fadeIn, OUTLINE_MOTION_MS));
		this.track(
			id === this.pageId ? "focusOut" : "focusIn",
			anims,
			() => {
				map.force.clear();
				map.render();
			},
			t0,
		);
	}

	/** Focus a block and put the cursor (or the map's selection) on it: the quick switcher. */
	reveal(id: string): boolean {
		const v = this.client.visible;
		if (id !== this.pageId && !v.alive(id)) return false;
		// The keyboard moves inside the focus change (before the page view is parked).
		this.focusBlock(id, { takeFocus: true });
		if (this.state.view === "map") {
			const map = this.map;
			map.flush();
			if (map.holding && !map.info.has(id)) {
				// A large tree waiting for the Worker: the keyboard stays in the map, the block is
				// selected once it is laid out (if the map is still on screen).
				map.focusStage();
				map.afterHold(() => {
					if (this.destroyed || this.state.view !== "map") return;
					map.select(id, { reveal: false, focus: this.frame.contains(document.activeElement) });
				});
			} else map.select(id, { reveal: false });
		} else {
			const target = id === this.pageId ? (v.children(this.pageId)[0] ?? id) : id;
			const at = this.outline.captureSel()?.head.blockId;
			if (at !== target) this.placeCaret(target);
			if (!this.outline.pm.hasFocus()) this.outline.pm.focus();
		}
		return true;
	}

	/** Keyboard focus back into the view on screen (the quick switcher closed). */
	focusActiveView(): void {
		if (this.state.view === "map") this.map.focusStage();
		else this.outline.pm.focus();
	}
}
