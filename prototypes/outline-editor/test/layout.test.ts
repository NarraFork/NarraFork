// 导图布局（src/mindmap/layout.ts）：随机树上检查不重叠、同级有序、父块居中、紧凑，以及线性时间。
import { describe, expect, test } from "bun:test";
import { type Dir, type LNode, layoutTree } from "../src/mindmap/layout";

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

function node(id: string, w: number, h: number): LNode {
	return { id, w, h, kids: [], x: 0, y: 0, depth: 0 };
}

/** 随机树：形状偏「宽而浅」或「窄而深」随种子变化，尺寸随机（模拟换行后的节点）。 */
function randomTree(n: number, seed: number): { root: LNode; all: LNode[] } {
	const r = rng(seed);
	const root = node("r", 80 + r() * 200, 20 + r() * 60);
	const all = [root];
	const deep = r() < 0.5;
	for (let i = 1; i < n; i++) {
		const k = deep
			? all.length - 1 - Math.floor(r() * Math.min(all.length, 4))
			: Math.floor(r() * all.length);
		const p = all[k];
		const c = node(`n${i}`, 20 + r() * 260, 16 + r() * 100);
		p.kids.push(c);
		all.push(c);
	}
	return { root, all };
}

const opts = (dir: Dir) => ({ dir, gapDepth: 40, gapSibling: 10 });

function overlaps(a: LNode, b: LNode, eps = 0.01) {
	return (
		a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps
	);
}

describe("紧凑树布局", () => {
	for (const dir of ["right", "down"] as Dir[]) {
		test(`${dir}：随机树不重叠、同级有序、父块居中`, () => {
			for (let seed = 1; seed <= 30; seed++) {
				const { root, all } = randomTree(40 + (seed % 7) * 40, seed);
				layoutTree(root, opts(dir));
				expect(root.x).toBeCloseTo(0, 6);
				expect(root.y).toBeCloseTo(0, 6);
				// 不重叠（任意两块）
				for (let i = 0; i < all.length; i++)
					for (let j = i + 1; j < all.length; j++) {
						if (overlaps(all[i], all[j]))
							throw new Error(`seed ${seed} ${dir}: ${all[i].id} 与 ${all[j].id} 重叠`);
					}
				for (const p of all) {
					if (!p.kids.length) continue;
					// 子块紧贴父块之后（非分层）
					for (const c of p.kids) {
						if (dir === "right") expect(c.x).toBeCloseTo(p.x + p.w + 40, 6);
						else expect(c.y).toBeCloseTo(p.y + p.h + 40, 6);
					}
					// 同级按顺序排列、至少隔一个间距
					for (let i = 1; i < p.kids.length; i++) {
						const a = p.kids[i - 1];
						const b = p.kids[i];
						if (dir === "right") expect(b.y).toBeGreaterThanOrEqual(a.y + a.h + 10 - 1e-6);
						else expect(b.x).toBeGreaterThanOrEqual(a.x + a.w + 10 - 1e-6);
					}
					// 父块居中于第一个与最后一个子块
					const f = p.kids[0];
					const l = p.kids[p.kids.length - 1];
					if (dir === "right") expect(p.y + p.h / 2).toBeCloseTo((f.y + l.y + l.h) / 2, 6);
					else expect(p.x + p.w / 2).toBeCloseTo((f.x + l.x + l.w) / 2, 6);
				}
			}
		});
	}

	test("紧凑：叶子兄弟之间正好一个间距；矮的子树可以塞进高的子树旁边", () => {
		const root = node("r", 100, 20);
		for (let i = 0; i < 5; i++) root.kids.push(node(`k${i}`, 50 + i * 10, 20 + i * 5));
		layoutTree(root, opts("right"));
		for (let i = 1; i < 5; i++) {
			const a = root.kids[i - 1];
			const b = root.kids[i];
			expect(b.y - (a.y + a.h)).toBeCloseTo(10, 6);
		}
		// 非分层：宽父块的子块比窄父块的子块更靠右，但纵向可以交错
		const r2 = node("r", 40, 20);
		const wide = node("wide", 300, 20);
		const narrow = node("narrow", 40, 20);
		wide.kids.push(node("w1", 40, 200));
		narrow.kids.push(node("n1", 40, 200));
		r2.kids.push(wide, narrow);
		layoutTree(r2, opts("right"));
		expect(wide.kids[0].x).toBeGreaterThan(narrow.kids[0].x);
		// 两个高子块不重叠
		expect(overlaps(wide.kids[0], narrow.kids[0])).toBe(false);
	});

	test("线性时间：2 万块 < 200 ms，2000 块 < 20 ms", () => {
		const big = randomTree(20000, 7);
		const t0 = performance.now();
		layoutTree(big.root, opts("right"));
		const ms20k = performance.now() - t0;
		const small = randomTree(2000, 8);
		const t1 = performance.now();
		layoutTree(small.root, opts("down"));
		const ms2k = performance.now() - t1;
		expect(ms20k).toBeLessThan(200);
		expect(ms2k).toBeLessThan(20);
	});

	test("深链（每块一个子块）不爆栈：200 层", () => {
		const root = node("r", 50, 20);
		let cur = root;
		for (let i = 0; i < 200; i++) {
			const c = node(`d${i}`, 50, 20);
			cur.kids.push(c);
			cur = c;
		}
		layoutTree(root, opts("down"));
		expect(cur.y).toBeCloseTo(200 * 60, 6);
	});
});
