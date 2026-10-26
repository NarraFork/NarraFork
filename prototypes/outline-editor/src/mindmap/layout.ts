/**
 * 导图布局（§6.10）：非分层的紧凑树布局，节点大小不一，线性时间。
 *
 * 算法是 A. van der Ploeg, "Drawing non-layered tidy trees in linear time"
 * (Software: Practice and Experience, 2014) 的直译：
 * - 「层级轴」上子块紧贴父块之后（非分层：父块越宽，子块越靠后），
 * - 「顺序轴」上用左右轮廓 + 线程把相邻子树尽量挤紧，父块居中于子块。
 * 向右展开：层级轴 = x，顺序轴 = y；向下展开（组织结构图）反过来。
 *
 * 不依赖 DOM：节点尺寸由调用方给出（导图用 pretext 测量），这里只算位置。
 * 布局本身每次整棵树重算（O(n)，2000 块约 1 ms 量级）；贵的是测量，测量按正文缓存，只重测变了的块。
 */

export type Dir = "right" | "down";

export interface LNode {
	id: string;
	/** 盒子尺寸（不含间距） */
	w: number;
	h: number;
	kids: LNode[];
	/** 输出：盒子左上角（世界坐标，根在 (0, 0) 附近） */
	x: number;
	y: number;
	depth: number;
}

export interface LayoutOpts {
	dir: Dir;
	/** 父块与子块之间（层级轴）的间距 */
	gapDepth: number;
	/** 相邻子树之间（顺序轴）的间距 */
	gapSibling: number;
}

/** 算法内部节点：w = 顺序轴尺寸（含间距），h = 层级轴尺寸（含间距），y = 层级轴位置。 */
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
		public src: LNode,
		public w: number,
		public h: number,
		public y: number,
	) {}
}

interface IYL {
	lowY: number;
	index: number;
	nxt: IYL | null;
}

const bottom = (t: T) => t.y + t.h;

function setExtremes(t: T) {
	const n = t.c.length;
	if (n === 0) {
		t.el = t;
		t.er = t;
		t.msel = 0;
		t.mser = 0;
	} else {
		t.el = t.c[0].el;
		t.msel = t.c[0].msel;
		t.er = t.c[n - 1].er;
		t.mser = t.c[n - 1].mser;
	}
}

function updateIYL(minY: number, i: number, ih: IYL | null): IYL {
	// 新子树挡住的左侧兄弟从表里去掉
	while (ih !== null && minY >= ih.lowY) ih = ih.nxt;
	return { lowY: minY, index: i, nxt: ih };
}

const nextLeftContour = (t: T) => (t.c.length === 0 ? t.tl : t.c[0]);
const nextRightContour = (t: T) => (t.c.length === 0 ? t.tr : t.c[t.c.length - 1]);

function distributeExtra(t: T, i: number, si: number, dist: number) {
	if (si !== i - 1) {
		const nr = i - si;
		t.c[si + 1].shift += dist / nr;
		t.c[i].shift -= dist / nr;
		t.c[i].change -= dist - dist / nr;
	}
}

function moveSubtree(t: T, i: number, si: number, dist: number) {
	const c = t.c[i];
	c.mod += dist;
	c.msel += dist;
	c.mser += dist;
	distributeExtra(t, i, si, dist);
}

function setLeftThread(t: T, i: number, cl: T, modsumcl: number) {
	const li = t.c[0].el;
	li.tl = cl;
	const diff = modsumcl - cl.mod - t.c[0].msel;
	li.mod += diff;
	li.prelim -= diff;
	t.c[0].el = t.c[i].el;
	t.c[0].msel = t.c[i].msel;
}

function setRightThread(t: T, i: number, sr: T, modsumsr: number) {
	const ri = t.c[i].er;
	ri.tr = sr;
	const diff = modsumsr - sr.mod - t.c[i].mser;
	ri.mod += diff;
	ri.prelim -= diff;
	t.c[i].er = t.c[i - 1].er;
	t.c[i].mser = t.c[i - 1].mser;
}

function separate(t: T, i: number, ih0: IYL) {
	let ih: IYL = ih0;
	// 左侧兄弟们的右轮廓，和当前子树的左轮廓，各带修正量之和
	let sr: T | null = t.c[i - 1];
	let mssr = sr.mod;
	let cl: T | null = t.c[i];
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

function positionRoot(t: T) {
	const a = t.c[0];
	const b = t.c[t.c.length - 1];
	t.prelim = (a.prelim + a.mod + b.mod + b.prelim + b.w) / 2 - t.w / 2;
}

function firstWalk(t: T) {
	if (t.c.length === 0) {
		setExtremes(t);
		return;
	}
	firstWalk(t.c[0]);
	let ih = updateIYL(bottom(t.c[0].el), 0, null);
	for (let i = 1; i < t.c.length; i++) {
		firstWalk(t.c[i]);
		// 极端节点还指向当前子树时记下最低的层级坐标
		const minY = bottom(t.c[i].er);
		separate(t, i, ih);
		ih = updateIYL(minY, i, ih);
	}
	positionRoot(t);
	setExtremes(t);
}

function addChildSpacing(t: T) {
	let d = 0;
	let modsumdelta = 0;
	for (const c of t.c) {
		d += c.shift;
		modsumdelta += d + c.change;
		c.mod += modsumdelta;
	}
}

function secondWalk(t: T, modsum: number) {
	const m = modsum + t.mod;
	t.x = t.prelim + m;
	addChildSpacing(t);
	for (const c of t.c) secondWalk(c, m);
}

/**
 * 原地写入每个节点的 x、y（盒子左上角）。根的盒子放在 (0, 0)。
 * 返回整棵树的包围盒。
 */
export function layoutTree(
	root: LNode,
	opts: LayoutOpts,
): { minX: number; minY: number; maxX: number; maxY: number } {
	const right = opts.dir === "right";
	const make = (n: LNode, y: number, depth: number): T => {
		n.depth = depth;
		const breadth = (right ? n.h : n.w) + opts.gapSibling;
		const depthSize = (right ? n.w : n.h) + opts.gapDepth;
		const t = new T(n, breadth, depthSize, y);
		const kids = n.kids;
		if (kids.length) {
			t.c = new Array(kids.length);
			for (let i = 0; i < kids.length; i++) t.c[i] = make(kids[i], y + depthSize, depth + 1);
		}
		return t;
	};
	const rt = make(root, 0, 0);
	firstWalk(rt);
	secondWalk(rt, 0);
	// 写回：顺序轴上盒子居中于它的槽（槽宽含间距）
	const half = opts.gapSibling / 2;
	const ox = rt.x + half;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	const out = (t: T) => {
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
		for (const c of t.c) out(c);
	};
	out(rt);
	return { minX, minY, maxX, maxY };
}
