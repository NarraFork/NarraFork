/**
 * View state of an outline page, shared by its views (design §6.10): the outline editor, the mind
 * map and the read-only tree. One object per page per surface (`OutlineSurface`), kept across
 * focus changes and across the editor being unmounted (a dock panel in the background): two
 * surfaces showing one page (the outline page and a dock panel) fold, select and scroll
 * independently, while they share the page's live session.
 *
 *   - `focus`: the focused block (the route's block; the page itself when unfocused);
 *   - `collapsed`: folded blocks — personal, never part of the block model or a commit; stored
 *     per person and page in `outline_view_state` (`useOutlineViewStateSync`);
 *   - `caret`: where the cursor is (block and offsets in the block's editor content; -1 for the
 *     whole block), or the selected node in the mind map (offsets -2: only the block is known);
 *   - `blocks`: the block selection (Esc in the outline, Shift-click in the map), in order;
 *   - `anchor`: the viewport anchor, the block nearest the viewport's middle and where its body
 *     sits in the editor's frame, so switching views keeps it on screen;
 *   - `view`: the outline or the mind map (this surface's own, not stored on the server);
 *   - `layout`: the mind map's direction, rightward or downward — stored with the folding.
 *
 * Listeners hear which part changed. Pure state; no DOM.
 */
import type { OutlineMapLayout } from "@shared/outline-api";

export interface OutlineCaret {
	blockId: string;
	/** Offsets in the block's editor content; -1 for the whole block; -2 only the block known. */
	anchor: number;
	head: number;
}

export interface OutlineViewportAnchor {
	blockId: string;
	/** The block body's top-left corner relative to the editor frame, in CSS pixels. */
	x: number;
	y: number;
}

export type OutlineViewKind = "outline" | "map";

export type OutlineViewStatePart =
	| "focus"
	| "collapsed"
	| "caret"
	| "blocks"
	| "anchor"
	| "view"
	| "layout"
	/** Folding and direction were replaced by the stored ones (not a person's change). */
	| "stored";

export class OutlineViewState {
	focus: string;
	readonly collapsed = new Set<string>();
	caret: OutlineCaret | null = null;
	blocks: string[] = [];
	anchor: OutlineViewportAnchor | null = null;
	view: OutlineViewKind = "outline";
	layout: OutlineMapLayout = "right";
	private readonly listeners = new Set<(part: OutlineViewStatePart) => void>();

	constructor(readonly pageId: string) {
		this.focus = pageId;
	}

	on(listener: (part: OutlineViewStatePart) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(part: OutlineViewStatePart): void {
		for (const l of this.listeners) l(part);
	}

	setFocus(id: string): void {
		if (this.focus === id) return;
		this.focus = id;
		this.emit("focus");
	}

	toggleCollapsed(id: string): void {
		if (this.collapsed.has(id)) this.collapsed.delete(id);
		else this.collapsed.add(id);
		this.emit("collapsed");
	}

	/** Fold or unfold many at once (collapse all, expand to a level). */
	setCollapsed(ids: Iterable<string>, collapsed: boolean): void {
		let changed = false;
		for (const id of ids) {
			if (collapsed === this.collapsed.has(id)) continue;
			if (collapsed) this.collapsed.add(id);
			else this.collapsed.delete(id);
			changed = true;
		}
		if (changed) this.emit("collapsed");
	}

	/** Note that a view changed the folding itself (it already re-projected). */
	noteCollapsed(): void {
		this.emit("collapsed");
	}

	setCaret(caret: OutlineCaret | null): void {
		this.caret = caret;
		this.emit("caret");
	}

	setBlocks(ids: string[]): void {
		this.blocks = ids;
		this.emit("blocks");
	}

	setAnchor(anchor: OutlineViewportAnchor | null): void {
		this.anchor = anchor;
		this.emit("anchor");
	}

	setView(view: OutlineViewKind): void {
		if (this.view === view) return;
		this.view = view;
		this.emit("view");
	}

	setLayout(layout: OutlineMapLayout): void {
		if (this.layout === layout) return;
		this.layout = layout;
		this.emit("layout");
	}

	/** Folding and direction as stored for the person (replaces both; one "stored" event). */
	applyStored(collapsed: Iterable<string>, layout: OutlineMapLayout): void {
		this.collapsed.clear();
		for (const id of collapsed) this.collapsed.add(id);
		this.layout = layout;
		this.emit("stored");
	}

	/** Serializable copy (tests, and the transitions). */
	snapshot() {
		return {
			focus: this.focus,
			collapsed: [...this.collapsed].sort(),
			caret: this.caret ? { ...this.caret } : null,
			blocks: [...this.blocks],
			anchor: this.anchor ? { ...this.anchor } : null,
			view: this.view,
			layout: this.layout,
		};
	}
}

/** Pages whose view state one surface keeps (most recently used). */
const MAX_PAGES = 32;

/** The view states of one surface, one per page it showed. */
export class OutlineViewStates {
	private readonly states = new Map<string, OutlineViewState>();

	/** The page's view state in this surface, created on first use. */
	of(pageId: string): OutlineViewState {
		let state = this.states.get(pageId);
		if (state) {
			this.states.delete(pageId);
			this.states.set(pageId, state);
			return state;
		}
		state = new OutlineViewState(pageId);
		this.states.set(pageId, state);
		while (this.states.size > MAX_PAGES) {
			const oldest = this.states.keys().next().value;
			if (oldest === undefined) break;
			this.states.delete(oldest);
		}
		return state;
	}
}
