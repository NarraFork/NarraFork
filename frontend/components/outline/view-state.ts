/**
 * View state of an outline page, shared by its views (design §6.10): the outline editor and the
 * read-only tree now, the mind map in PR9. One object per page per surface (`OutlineSurface`),
 * kept across focus changes: two surfaces showing one page (the outline page and a dock panel)
 * fold, select and scroll independently, while they share the page's live session.
 *
 *   - `focus`: the focused block (the route's block; the page itself when unfocused);
 *   - `collapsed`: folded blocks — personal, never part of the block model or a commit (PR9
 *     stores them per person and page in `outline_view_state`);
 *   - `caret`: where the cursor is (block and offsets in the block's editor content), or the
 *     selected node in the mind map;
 *   - `blocks`: the block selection (Esc), in order; empty outside block selection;
 *   - `anchor`: the viewport anchor, the block nearest the viewport's middle and where it sits,
 *     so switching views keeps it on screen.
 *
 * Listeners hear which part changed. Pure state; no DOM.
 */

export interface OutlineCaret {
	blockId: string;
	/** Offsets in the block's editor content; -1 for the whole block. */
	anchor: number;
	head: number;
}

export interface OutlineViewportAnchor {
	blockId: string;
	/** The block's top relative to the viewport's top, in CSS pixels. */
	top: number;
}

export type OutlineViewStatePart = "focus" | "collapsed" | "caret" | "blocks" | "anchor";

export class OutlineViewState {
	focus: string;
	readonly collapsed = new Set<string>();
	caret: OutlineCaret | null = null;
	blocks: string[] = [];
	anchor: OutlineViewportAnchor | null = null;
	private readonly listeners = new Set<(part: OutlineViewStatePart) => void>();

	constructor(readonly pageId: string) {
		this.focus = pageId;
	}

	on(listener: (part: OutlineViewStatePart) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(part: OutlineViewStatePart): void {
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

	/** Serializable copy (tests, and PR9's transitions). */
	snapshot() {
		return {
			focus: this.focus,
			collapsed: [...this.collapsed].sort(),
			caret: this.caret ? { ...this.caret } : null,
			blocks: [...this.blocks],
			anchor: this.anchor ? { ...this.anchor } : null,
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
