/**
 * Mind-map layout (design §6.10): a non-layered tidy tree for nodes of different sizes, in linear
 * time, growing rightward or downward (no balanced left/right layout, D29).
 *
 * A direct port of A. van der Ploeg, "Drawing non-layered tidy trees in linear time" (Software:
 * Practice and Experience, 2014), as the outline prototype measured it
 * (`prototypes/outline-editor/src/mindmap/layout.ts`):
 *   - on the depth axis a child sits right after its parent (non-layered: a wider parent pushes
 *     its children further out);
 *   - on the sibling axis neighbouring subtrees are packed as tightly as their contours allow
 *     (left and right contours with threads), and a parent is centred on its children.
 * Rightward: depth axis = x, sibling axis = y. Downward (an org chart): the other way round.
 *
 * No DOM: the caller gives node sizes (the mind map measures them with pretext); this only
 * places them. The whole tree is laid out every time (O(n), about 1 ms for 2000 nodes in the
 * prototype); measuring is what costs, and that is cached per body by the caller.
 */

export type LayoutDirection = "right" | "down";

export interface LayoutNode {
	id: string;
	/** Box size, without the gaps. */
	w: number;
	h: number;
	kids: LayoutNode[];
	/** Output: the box's top-left corner (world coordinates, the root's box at (0, 0)). */
	x: number;
	y: number;
	depth: number;
}

export interface LayoutOptions {
	dir: LayoutDirection;
	/** Gap between a parent and its children (depth axis). */
	gapDepth: number;
	/** Gap between neighbouring subtrees (sibling axis). */
	gapSibling: number;
}

export interface LayoutBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** The algorithm's node: `w` = size on the sibling axis (with gap), `h` = on the depth axis. */
class T {
	prelim = 0;
	mod = 0;
	shift = 0;
	change = 0;
	tl: T | null = null;
	tr: T | null = null;
	el: T = this;
	er: T = this;
	msel = 0;
	mser = 0;
	x = 0;
	c: T[] = [];
	constructor(
		readonly src: LayoutNode,
		readonly w: number,
		readonly h: number,
		readonly y: number,
	) {}
}

interface IYL {
	lowY: number;
	index: number;
	nxt: IYL | null;
}

const bottom = (t: T) => t.y + t.h;

function setExtremes(t: T): void {
	const n = t.c.length;
	if (n === 0) {
		t.el = t;
		t.er = t;
		t.msel = 0;
		t.mser = 0;
		return;
	}
	const first = t.c[0] as T;
	const last = t.c[n - 1] as T;
	t.el = first.el;
	t.msel = first.msel;
	t.er = last.er;
	t.mser = last.mser;
}

function updateIYL(minY: number, i: number, ih: IYL | null): IYL {
	// Siblings on the left that the new subtree hides are dropped from the list.
	let cur = ih;
	while (cur !== null && minY >= cur.lowY) cur = cur.nxt;
	return { lowY: minY, index: i, nxt: cur };
}

const nextLeftContour = (t: T): T | null => (t.c.length === 0 ? t.tl : (t.c[0] as T));
const nextRightContour = (t: T): T | null => (t.c.length === 0 ? t.tr : (t.c[t.c.length - 1] as T));

function distributeExtra(t: T, i: number, si: number, dist: number): void {
	if (si === i - 1) return;
	const nr = i - si;
	(t.c[si + 1] as T).shift += dist / nr;
	const ci = t.c[i] as T;
	ci.shift -= dist / nr;
	ci.change -= dist - dist / nr;
}

function moveSubtree(t: T, i: number, si: number, dist: number): void {
	const c = t.c[i] as T;
	c.mod += dist;
	c.msel += dist;
	c.mser += dist;
	distributeExtra(t, i, si, dist);
}

function setLeftThread(t: T, i: number, cl: T, modsumcl: number): void {
	const first = t.c[0] as T;
	const li = first.el;
	li.tl = cl;
	const diff = modsumcl - cl.mod - first.msel;
	li.mod += diff;
	li.prelim -= diff;
	const ci = t.c[i] as T;
	first.el = ci.el;
	first.msel = ci.msel;
}

function setRightThread(t: T, i: number, sr: T, modsumsr: number): void {
	const ci = t.c[i] as T;
	const ri = ci.er;
	ri.tr = sr;
	const diff = modsumsr - sr.mod - ci.mser;
	ri.mod += diff;
	ri.prelim -= diff;
	const prev = t.c[i - 1] as T;
	ci.er = prev.er;
	ci.mser = prev.mser;
}

function separate(t: T, i: number, ih0: IYL): void {
	let ih: IYL = ih0;
	// The right contour of the siblings on the left and the left contour of this subtree, each
	// with its sum of modifiers.
	let sr: T | null = t.c[i - 1] as T;
	let mssr = sr.mod;
	let cl: T | null = t.c[i] as T;
	let mscl = cl.mod;
	while (sr !== null && cl !== null) {
		if (bottom(sr) > ih.lowY && ih.nxt) ih = ih.nxt;
		const dist = mssr + sr.prelim + sr.w - (mscl + cl.prelim);
		if (dist > 0) {
			mscl += dist;
			moveSubtree(t, i, ih.index, dist);
		}
		const sy = bottom(sr);
		const cy = bottom(cl);
		if (sy <= cy) {
			sr = nextRightContour(sr);
			if (sr !== null) mssr += sr.mod;
		}
		if (sy >= cy) {
			cl = nextLeftContour(cl);
			if (cl !== null) mscl += cl.mod;
		}
	}
	if (sr === null && cl !== null) setLeftThread(t, i, cl, mscl);
	else if (sr !== null && cl === null) setRightThread(t, i, sr, mssr);
}

function positionRoot(t: T): void {
	const a = t.c[0] as T;
	const b = t.c[t.c.length - 1] as T;
	t.prelim = (a.prelim + a.mod + b.mod + b.prelim + b.w) / 2 - t.w / 2;
}

/** Post-order over an explicit stack, so a deep outline stays off the call stack. */
function firstWalk(root: T): void {
	const stack: Array<{ t: T; i: number; ih: IYL | null }> = [{ t: root, i: 0, ih: null }];
	while (stack.length > 0) {
		const frame = stack[stack.length - 1] as { t: T; i: number; ih: IYL | null };
		const t = frame.t;
		if (t.c.length === 0) {
			setExtremes(t);
			stack.pop();
			continue;
		}
		if (frame.i < t.c.length) {
			// Lay out the next child first; its separation happens when it is done.
			stack.push({ t: t.c[frame.i] as T, i: 0, ih: null });
			frame.i++;
			continue;
		}
		// Every child is laid out: separate them in order (as the recursive version does after
		// each child), then centre the parent.
		let ih = updateIYL(bottom((t.c[0] as T).el), 0, null);
		for (let i = 1; i < t.c.length; i++) {
			const minY = bottom((t.c[i] as T).er);
			separate(t, i, ih);
			ih = updateIYL(minY, i, ih);
		}
		positionRoot(t);
		setExtremes(t);
		stack.pop();
	}
}

function addChildSpacing(t: T): void {
	let d = 0;
	let modsumdelta = 0;
	for (const c of t.c) {
		d += c.shift;
		modsumdelta += d + c.change;
		c.mod += modsumdelta;
	}
}

function secondWalk(root: T): void {
	const stack: Array<{ t: T; modsum: number }> = [{ t: root, modsum: 0 }];
	while (stack.length > 0) {
		const { t, modsum } = stack.pop() as { t: T; modsum: number };
		const m = modsum + t.mod;
		t.x = t.prelim + m;
		addChildSpacing(t);
		for (let i = t.c.length - 1; i >= 0; i--) stack.push({ t: t.c[i] as T, modsum: m });
	}
}

/**
 * Lay out a tree in place: writes every node's `x`, `y` (the box's top-left corner) and `depth`.
 * The root's box is at (0, 0). Returns the bounds of the whole tree.
 */
export function layoutTree(root: LayoutNode, opts: LayoutOptions): LayoutBounds {
	const right = opts.dir === "right";
	const make = (n: LayoutNode, y: number, depth: number): T => {
		n.depth = depth;
		const breadth = (right ? n.h : n.w) + opts.gapSibling;
		const depthSize = (right ? n.w : n.h) + opts.gapDepth;
		return new T(n, breadth, depthSize, y);
	};
	// Build the algorithm's tree breadth first (no recursion).
	const rt = make(root, 0, 0);
	const queue: T[] = [rt];
	for (let q = 0; q < queue.length; q++) {
		const t = queue[q] as T;
		const kids = t.src.kids;
		if (kids.length === 0) continue;
		t.c = new Array(kids.length);
		for (let i = 0; i < kids.length; i++) {
			const c = make(kids[i] as LayoutNode, t.y + t.h, t.src.depth + 1);
			t.c[i] = c;
			queue.push(c);
		}
	}
	firstWalk(rt);
	secondWalk(rt);
	// Write back: on the sibling axis a box is centred in its slot (the slot includes the gap).
	const half = opts.gapSibling / 2;
	const ox = rt.x + half;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const t of queue) {
		const n = t.src;
		const b = t.x + half - ox;
		if (right) {
			n.x = t.y;
			n.y = b;
		} else {
			n.x = b;
			n.y = t.y;
		}
		if (n.x < minX) minX = n.x;
		if (n.y < minY) minY = n.y;
		if (n.x + n.w > maxX) maxX = n.x + n.w;
		if (n.y + n.h > maxY) maxY = n.y + n.h;
	}
	return { minX, minY, maxX, maxY };
}
