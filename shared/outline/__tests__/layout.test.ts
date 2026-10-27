/**
 * The mind map's tidy-tree layout and visible-block budget (`shared/outline/layout/`): on random
 * trees no boxes overlap, siblings keep their order, a parent is centred on its children and a
 * child sits right after its parent; it packs tightly, runs in linear time and survives deep
 * chains. The budget opens whole levels first and folds the rest into "more" counts.
 */
import { describe, expect, test } from "bun:test";
import { type LayoutDirection, type LayoutNode, layoutTree, planVisible } from "../layout";

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

function node(id: string, w: number, h: number): LayoutNode {
	return { id, w, h, kids: [], x: 0, y: 0, depth: 0 };
}

/** A random tree, wide and shallow or narrow and deep by seed, with random (wrapped) sizes. */
function randomTree(n: number, seed: number): { root: LayoutNode; all: LayoutNode[] } {
	const r = rng(seed);
	const root = node("r", 80 + r() * 200, 20 + r() * 60);
	const all = [root];
	const deep = r() < 0.5;
	for (let i = 1; i < n; i++) {
		const k = deep
			? all.length - 1 - Math.floor(r() * Math.min(all.length, 4))
			: Math.floor(r() * all.length);
		const p = all[k] as LayoutNode;
		const c = node(`n${i}`, 20 + r() * 260, 16 + r() * 100);
		p.kids.push(c);
		all.push(c);
	}
	return { root, all };
}

const opts = (dir: LayoutDirection) => ({ dir, gapDepth: 40, gapSibling: 10 });

function overlaps(a: LayoutNode, b: LayoutNode, eps = 0.01) {
	return (
		a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps
	);
}

describe("tidy tree layout", () => {
	for (const dir of ["right", "down"] as LayoutDirection[]) {
		test(`${dir}: random trees do not overlap, keep sibling order, centre parents`, () => {
			for (let seed = 1; seed <= 30; seed++) {
				const { root, all } = randomTree(40 + (seed % 7) * 40, seed);
				const bounds = layoutTree(root, opts(dir));
				expect(root.x).toBeCloseTo(0, 6);
				expect(root.y).toBeCloseTo(0, 6);
				for (let i = 0; i < all.length; i++) {
					const a = all[i] as LayoutNode;
					expect(a.x).toBeGreaterThanOrEqual(bounds.minX - 1e-6);
					expect(a.y + a.h).toBeLessThanOrEqual(bounds.maxY + 1e-6);
					for (let j = i + 1; j < all.length; j++) {
						const b = all[j] as LayoutNode;
						if (overlaps(a, b)) throw new Error(`seed ${seed} ${dir}: ${a.id} overlaps ${b.id}`);
					}
				}
				for (const p of all) {
					if (!p.kids.length) continue;
					// A child sits right after its parent (non-layered).
					for (const c of p.kids) {
						expect(c.depth).toBe(p.depth + 1);
						if (dir === "right") expect(c.x).toBeCloseTo(p.x + p.w + 40, 6);
						else expect(c.y).toBeCloseTo(p.y + p.h + 40, 6);
					}
					// Siblings in order, at least one gap apart.
					for (let i = 1; i < p.kids.length; i++) {
						const a = p.kids[i - 1] as LayoutNode;
						const b = p.kids[i] as LayoutNode;
						if (dir === "right") expect(b.y).toBeGreaterThanOrEqual(a.y + a.h + 10 - 1e-6);
						else expect(b.x).toBeGreaterThanOrEqual(a.x + a.w + 10 - 1e-6);
					}
					// A parent is centred on its first and last child.
					const f = p.kids[0] as LayoutNode;
					const l = p.kids[p.kids.length - 1] as LayoutNode;
					if (dir === "right") expect(p.y + p.h / 2).toBeCloseTo((f.y + l.y + l.h) / 2, 6);
					else expect(p.x + p.w / 2).toBeCloseTo((f.x + l.x + l.w) / 2, 6);
				}
			}
		});
	}

	test("tight: leaf siblings exactly one gap apart; a short subtree tucks beside a tall one", () => {
		const root = node("r", 100, 20);
		for (let i = 0; i < 5; i++) root.kids.push(node(`k${i}`, 50 + i * 10, 20 + i * 5));
		layoutTree(root, opts("right"));
		for (let i = 1; i < 5; i++) {
			const a = root.kids[i - 1] as LayoutNode;
			const b = root.kids[i] as LayoutNode;
			expect(b.y - (a.y + a.h)).toBeCloseTo(10, 6);
		}
		// Non-layered: the wide parent's child is further right, and the two may interleave.
		const r2 = node("r", 40, 20);
		const wide = node("wide", 300, 20);
		const narrow = node("narrow", 40, 20);
		wide.kids.push(node("w1", 40, 200));
		narrow.kids.push(node("n1", 40, 200));
		r2.kids.push(wide, narrow);
		layoutTree(r2, opts("right"));
		const w1 = wide.kids[0] as LayoutNode;
		const n1 = narrow.kids[0] as LayoutNode;
		expect(w1.x).toBeGreaterThan(n1.x);
		expect(overlaps(w1, n1)).toBe(false);
	});

	test("linear time: 20,000 nodes and 2000 nodes lay out quickly", () => {
		const big = randomTree(20000, 7);
		const t0 = performance.now();
		layoutTree(big.root, opts("right"));
		const ms20k = performance.now() - t0;
		const small = randomTree(2000, 8);
		const t1 = performance.now();
		layoutTree(small.root, opts("down"));
		const ms2k = performance.now() - t1;
		// Generous bounds (shared CI machines); the prototype measured ~1 ms for 2000.
		expect(ms20k).toBeLessThan(1000);
		expect(ms2k).toBeLessThan(100);
	});

	test("a deep chain (one child each) does not overflow the stack: 5000 levels", () => {
		const root = node("r", 50, 20);
		let cur = root;
		for (let i = 0; i < 5000; i++) {
			const c = node(`d${i}`, 50, 20);
			cur.kids.push(c);
			cur = c;
		}
		layoutTree(root, opts("down"));
		expect(cur.y).toBeCloseTo(5000 * 60, 6);
		expect(cur.depth).toBe(5000);
	});
});

describe("visible-block budget", () => {
	/** root → a(a1, a2, a3), b(b1, b2), c(c1(c11)) */
	const tree: Record<string, string[]> = {
		root: ["a", "b", "c"],
		a: ["a1", "a2", "a3"],
		b: ["b1", "b2"],
		c: ["c1"],
		c1: ["c11"],
	};
	const children = (id: string) => tree[id] ?? [];
	const none = () => false;

	test("everything fits: every block shown, nothing folded", () => {
		const plan = planVisible({ rootId: "root", children, collapsed: none, budget: 100 });
		expect(plan.count).toBe(11);
		expect(plan.more.size).toBe(0);
		expect(plan.shown.get("c1")).toEqual(["c11"]);
	});

	test("a whole level before the next; the cut folds later parents' children", () => {
		// Root + 3 top-level + 4 more = 8: a's three, then one of b's.
		const plan = planVisible({ rootId: "root", children, collapsed: none, budget: 8 });
		expect(plan.count).toBe(8);
		expect(plan.shown.get("root")).toEqual(["a", "b", "c"]);
		expect(plan.shown.get("a")).toEqual(["a1", "a2", "a3"]);
		expect(plan.shown.get("b")).toEqual(["b1"]);
		expect(plan.more.get("b")).toBe(1);
		expect(plan.more.get("c")).toBe(1);
		expect(plan.shown.has("c")).toBe(false);
	});

	test("the root alone when the budget is one; its children are counted as more", () => {
		const plan = planVisible({ rootId: "root", children, collapsed: none, budget: 1 });
		expect(plan.count).toBe(1);
		expect(plan.more.get("root")).toBe(3);
	});

	test("collapsed blocks spend nothing and show nothing; the root is never collapsed", () => {
		const plan = planVisible({
			rootId: "root",
			children,
			collapsed: (id) => id === "a" || id === "root",
			budget: 100,
		});
		expect(plan.shown.has("a")).toBe(false);
		expect(plan.more.has("a")).toBe(false);
		expect(plan.count).toBe(8);
	});

	test("a cycle in corrupt input stops at the depth guard", () => {
		const loop = (id: string) => (id === "x" ? ["y"] : ["x"]);
		const plan = planVisible({
			rootId: "x",
			children: loop,
			collapsed: none,
			budget: 10_000,
			maxDepth: 50,
		});
		expect(plan.count).toBe(51);
	});
});
