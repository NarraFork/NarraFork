/**
 * Synthetic outline history generator.
 *
 * Simulates an append-only block history (see docs/OUTLINE_KNOWLEDGE-DESIGN.md §2.5, §7.1) and
 * writes it to a SQLite database file plus PostgreSQL COPY files (TSV).
 *
 * Model
 * - `spaces` spaces, each with `pagesPerSpace` pages of `blocksPerPage` blocks (distinct block ids
 *   that ever existed; 90% are created by the import commit, the rest are created later), plus an
 *   optional "giant" page in space 0.
 * - Every commit gets the next `seq` of its space. A commit touches 1..200 blocks (heavy tailed).
 * - Edit hotness is log-normal: a few blocks (task logs, status blocks) are rewritten hundreds of
 *   times, most blocks only a handful of times.
 * - Operations: content edit, task edit, create, delete subtree (tombstone on every descendant),
 *   restore, move inside a page (one version for the moved root), move subtree across pages (one
 *   new version for every descendant, because page_id changes).
 * - A block gets at most one version per commit. A version row is closed (`to_seq`) by the next
 *   version of the same block.
 *
 * Run: bun time-travel/gen.ts --vpb=10 --out=<dir> [--scale=1] [--seed=1]
 */
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { arg, argNum, DATA_ROOT, nanoId, Rng } from "./lib";

export const OPEN = Number.MAX_SAFE_INTEGER;

export const FLAG = {
	CREATED: 1,
	CONTENT: 2,
	MOVED: 4,
	DELETED: 8,
	RESTORED: 16,
	TASK: 32,
	PAGE: 64,
} as const;

export interface GenParams {
	seed: number;
	spaces: number;
	pagesPerSpace: number;
	blocksPerPage: number;
	/** Extra page with this many blocks in space 0 (0 = none). */
	giantBlocks: number;
	/** Target average number of versions per block. */
	vpb: number;
	initialFraction: number;
}

export function defaultParams(scale = 1): GenParams {
	return {
		seed: 1,
		spaces: 5,
		pagesPerSpace: Math.max(1, Math.round(10 * scale)),
		blocksPerPage: 2000,
		giantBlocks: scale >= 0.5 ? 10000 : 0,
		vpb: 10,
		initialFraction: 0.9,
	};
}

class Col {
	a: Int32Array;
	n = 0;
	constructor(cap = 1 << 16) {
		this.a = new Int32Array(cap);
	}
	push(x: number): number {
		if (this.n === this.a.length) {
			const b = new Int32Array(this.a.length * 2);
			b.set(this.a);
			this.a = b;
		}
		this.a[this.n] = x;
		return this.n++;
	}
}

class ColU8 {
	a: Uint8Array;
	n = 0;
	constructor(cap = 1 << 16) {
		this.a = new Uint8Array(cap);
	}
	push(x: number): number {
		if (this.n === this.a.length) {
			const b = new Uint8Array(this.a.length * 2);
			b.set(this.a);
			this.a = b;
		}
		this.a[this.n] = x;
		return this.n++;
	}
}

interface PageRec {
	space: number;
	root: number;
	slots: number[];
	cum: Float64Array;
	total: number;
	tasks: number[];
	pending: number[];
	size: number;
}

export interface History {
	params: GenParams;
	ids: string[];
	pages: PageRec[];
	spaceIds: string[];
	spaceMaxSeq: number[];
	commitIds: string[];
	// commits
	cSpace: Int32Array;
	cSeq: Int32Array;
	cKind: Uint8Array;
	cActorKind: Uint8Array;
	cActor: Int32Array;
	cNarrator: Int32Array;
	cTime: Float64Array;
	cNVers: Int32Array;
	cPage: Int32Array;
	nCommits: number;
	// versions
	V: {
		n: number;
		block: Int32Array;
		from: Int32Array;
		to: Int32Array;
		commit: Int32Array;
		page: Int32Array;
		parent: Int32Array;
		ok: Int32Array;
		off: Int32Array;
		len: Int32Array;
		task: Uint8Array;
		del: Uint8Array;
		flags: Uint8Array;
	};
	okStr: string[];
	// members
	M: { n: number; page: Int32Array; block: Int32Array; from: Int32Array; to: Int32Array };
	// final block state
	blockCount: number;
	live: Uint8Array;
	pageOf: Int32Array;
	parentOf: Int32Array;
	okOf: Int32Array;
	offOf: Int32Array;
	lenOf: Int32Array;
	taskOf: Uint8Array;
	last: Int32Array;
	pool: string;
	users: string[];
	narrators: string[];
	summaryOf: (c: number) => string;
}

// ------------------------------------------------------------------------------------------------
// Text pool

export function buildPool(rng: Rng, size = 8_000_000): string {
	const cjk: string[] = [];
	for (let i = 0; i < 3500; i++) cjk.push(String.fromCharCode(0x4e00 + rng.int(0x9fa5 - 0x4e00)));
	const vocab: string[] = [];
	for (let i = 0; i < 4000; i++) {
		const len = rng.range(2, 10);
		let w = "";
		for (let k = 0; k < len; k++) w += String.fromCharCode(97 + rng.int(26));
		vocab.push(w);
	}
	const zipf = (n: number) => Math.floor(n * rng.rnd() ** 2.2);
	const parts: string[] = [];
	let total = 0;
	while (total < size) {
		const r = rng.rnd();
		let s = "";
		if (r < 0.5) {
			const n = rng.range(8, 30);
			for (let i = 0; i < n; i++) s += cjk[zipf(cjk.length)];
			s += rng.rnd() < 0.5 ? "。" : "，";
		} else if (r < 0.8) {
			const n = rng.range(5, 20);
			const w: string[] = [];
			for (let i = 0; i < n; i++) w.push(vocab[zipf(vocab.length)] as string);
			w[0] = (w[0] as string).charAt(0).toUpperCase() + (w[0] as string).slice(1);
			s = `${w.join(" ")}. `;
		} else if (r < 0.92) {
			const a = vocab[zipf(vocab.length)];
			const b = vocab[zipf(vocab.length)];
			const c = vocab[zipf(vocab.length)];
			s =
				rng.rnd() < 0.5
					? `\`${a}_${b}\` in server/lib/${b}/${c}.ts:${rng.range(1, 900)}\n`
					: `const ${a} = await ${b}(${c}, { ${a}: ${rng.range(0, 99)} });\n`;
		} else {
			s =
				rng.rnd() < 0.6
					? `[[${vocab[zipf(vocab.length)]}]] `
					: `@${vocab[zipf(vocab.length)]} depends:: [[${cjk[zipf(cjk.length)]}${cjk[zipf(cjk.length)]}]] `;
		}
		parts.push(s);
		total += s.length;
	}
	return parts.join("");
}

function sampleLen(rng: Rng): number {
	const r = rng.rnd();
	const logUniform = (lo: number, hi: number) =>
		Math.floor(lo * Math.exp(rng.rnd() * Math.log(hi / lo)));
	if (r < 0.7) return logUniform(8, 120);
	if (r < 0.95) return logUniform(120, 800);
	if (r < 0.995) return logUniform(800, 3000);
	return logUniform(3000, 5000);
}

function sampleOpsPerCommit(rng: Rng): number {
	const u = rng.rnd();
	if (u < 0.62) return 1;
	if (u < 0.86) return rng.range(2, 5);
	if (u < 0.96) return rng.range(6, 20);
	if (u < 0.995) return rng.range(21, 80);
	return rng.range(81, 200);
}

// ------------------------------------------------------------------------------------------------

export function simulate(params: GenParams): History {
	const rng = new Rng(params.seed);
	const pool = buildPool(rng);
	const poolMax = pool.length - 5100;

	// --- layout
	const pages: PageRec[] = [];
	const pageSizes: { space: number; n: number }[] = [];
	for (let s = 0; s < params.spaces; s++) {
		for (let p = 0; p < params.pagesPerSpace; p++)
			pageSizes.push({ space: s, n: params.blocksPerPage });
		if (s === 0 && params.giantBlocks > 0) pageSizes.push({ space: 0, n: params.giantBlocks });
	}
	const B = pageSizes.reduce((a, p) => a + p.n, 0);
	const ids: string[] = [];
	for (let i = 0; i < B; i++) ids.push(nanoId(rng));
	const spaceIds: string[] = [];
	for (let s = 0; s < params.spaces; s++) spaceIds.push(nanoId(rng));
	const users: string[] = [];
	for (let i = 0; i < 24; i++) users.push(nanoId(rng));
	const narrators: string[] = [];
	for (let i = 0; i < 300; i++) narrators.push(nanoId(rng));

	const pageOf = new Int32Array(B).fill(-1);
	const parentOf = new Int32Array(B).fill(-1);
	const okOf = new Int32Array(B);
	const offOf = new Int32Array(B);
	const lenOf = new Int32Array(B);
	const taskOf = new Uint8Array(B);
	const isTask = new Uint8Array(B);
	const live = new Uint8Array(B); // 0 not yet created, 1 live, 2 deleted
	const last = new Int32Array(B).fill(-1);
	const memberPage = new Int32Array(B).fill(-1);
	const memberRow = new Int32Array(B).fill(-1);
	const dirtyFlags = new Uint8Array(B);
	const weight = new Float64Array(B);
	const children: number[][] = new Array(B);
	const childCounter = new Int32Array(B);
	for (let i = 0; i < B; i++) {
		children[i] = [];
		weight[i] = Math.exp(1.6 * rng.normal());
	}

	const okStr: string[] = [];
	const okIndex = new Map<string, number>();
	const keyId = (k: string): number => {
		let i = okIndex.get(k);
		if (i === undefined) {
			i = okStr.length;
			okStr.push(k);
			okIndex.set(k, i);
		}
		return i;
	};
	const nextKey = (parent: number): number => {
		const c = childCounter[parent] as number;
		childCounter[parent] = c + 1;
		return keyId(`k${c.toString(36).padStart(4, "0")}`);
	};
	const randomKey = (): number => {
		let s = "m";
		for (let i = 0; i < 5; i++) s += String.fromCharCode(97 + rng.int(26));
		return keyId(s);
	};

	let cursor = 0;
	for (const ps of pageSizes) {
		const slots: number[] = [];
		for (let i = 0; i < ps.n; i++) slots.push(cursor + i);
		const cum = new Float64Array(ps.n);
		let t = 0;
		for (let i = 0; i < ps.n; i++) {
			t += weight[cursor + i] as number;
			cum[i] = t;
		}
		const pr: PageRec = {
			space: ps.space,
			root: cursor,
			slots,
			cum,
			total: t,
			tasks: [],
			pending: [],
			size: ps.n,
		};
		pages.push(pr);
		const pi = pages.length - 1;
		for (const b of slots) {
			pageOf[b] = pi;
			if (b !== cursor && rng.rnd() < 0.1) {
				isTask[b] = 1;
				pr.tasks.push(b);
			}
		}
		cursor += ps.n;
	}

	// --- versions / commits / members storage
	const V = {
		block: new Col(1 << 20),
		from: new Col(1 << 20),
		to: new Col(1 << 20),
		commit: new Col(1 << 20),
		page: new Col(1 << 20),
		parent: new Col(1 << 20),
		ok: new Col(1 << 20),
		off: new Col(1 << 20),
		len: new Col(1 << 20),
		task: new ColU8(1 << 20),
		del: new ColU8(1 << 20),
		flags: new ColU8(1 << 20),
	};
	const M = {
		page: new Col(1 << 17),
		block: new Col(1 << 17),
		from: new Col(1 << 17),
		to: new Col(1 << 17),
	};
	const C = {
		space: new Col(1 << 16),
		seq: new Col(1 << 16),
		kind: new ColU8(1 << 16),
		actorKind: new ColU8(1 << 16),
		actor: new Col(1 << 16),
		narrator: new Col(1 << 16),
		nvers: new Col(1 << 16),
		page: new Col(1 << 16),
	};
	const cTimeArr: number[] = [];
	const commitIds: string[] = [];
	const spaceSeq = new Int32Array(params.spaces);

	const dirtyList: number[] = [];
	const markDirty = (b: number, flag: number) => {
		if (dirtyFlags[b] === 0) dirtyList.push(b);
		dirtyFlags[b] = (dirtyFlags[b] as number) | flag | 128;
	};

	const depthOf = (b: number): number => {
		let d = 0;
		let x = b;
		while (parentOf[x] !== -1 && d < 40) {
			x = parentOf[x] as number;
			d++;
		}
		return d;
	};

	const pickBlock = (p: number, allowRoot = true): number => {
		const pg = pages[p] as PageRec;
		for (let tries = 0; tries < 40; tries++) {
			const x = rng.rnd() * pg.total;
			let lo = 0;
			let hi = pg.cum.length - 1;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if ((pg.cum[mid] as number) < x) lo = mid + 1;
				else hi = mid;
			}
			const b = pg.slots[lo] as number;
			if (live[b] === 1 && pageOf[b] === p && (allowRoot || b !== pg.root)) return b;
		}
		// fallback: uniform scan
		const start = rng.int(pg.slots.length);
		for (let k = 0; k < pg.slots.length; k++) {
			const b = pg.slots[(start + k) % pg.slots.length] as number;
			if (live[b] === 1 && pageOf[b] === p && (allowRoot || b !== pg.root)) return b;
		}
		return -1;
	};

	const pickUniform = (p: number): number => {
		const pg = pages[p] as PageRec;
		for (let tries = 0; tries < 60; tries++) {
			const b = pg.slots[rng.int(pg.slots.length)] as number;
			if (live[b] === 1 && pageOf[b] === p) return b;
		}
		return pg.root;
	};

	const collectLive = (b: number, limit: number): number[] | null => {
		const out: number[] = [];
		const stack = [b];
		while (stack.length) {
			const x = stack.pop() as number;
			out.push(x);
			if (out.length > limit) return null;
			for (const c of children[x] as number[]) if (live[c] === 1) stack.push(c);
		}
		return out;
	};

	const removeChild = (parent: number, child: number) => {
		const arr = children[parent] as number[];
		const i = arr.indexOf(child);
		if (i >= 0) {
			arr[i] = arr[arr.length - 1] as number;
			arr.pop();
		}
	};

	const isAncestor = (anc: number, x: number): boolean => {
		let y = x;
		for (let i = 0; i < 40 && y !== -1; i++) {
			if (y === anc) return true;
			y = parentOf[y] as number;
		}
		return false;
	};

	// --- import commits
	const finalize = (commitIdx: number, seq: number) => {
		for (const b of dirtyList) {
			let flags = (dirtyFlags[b] as number) & 127;
			dirtyFlags[b] = 0;
			const prev = last[b] as number;
			if (prev >= 0) V.to.a[prev] = seq;
			else flags |= FLAG.CREATED;
			const idx = V.block.push(b);
			V.from.push(seq);
			V.to.push(0);
			V.commit.push(commitIdx);
			V.page.push(pageOf[b] as number);
			V.parent.push(parentOf[b] as number);
			V.ok.push(okOf[b] as number);
			V.off.push(offOf[b] as number);
			V.len.push(lenOf[b] as number);
			V.task.push(taskOf[b] as number);
			V.del.push(live[b] === 2 ? 1 : 0);
			V.flags.push(flags);
			last[b] = idx;
			const want = live[b] === 1 ? (pageOf[b] as number) : -1;
			if (memberPage[b] !== want) {
				if ((memberPage[b] as number) >= 0) M.to.a[memberRow[b] as number] = seq;
				if (want >= 0) {
					memberRow[b] = M.page.push(want);
					M.block.push(b);
					M.from.push(seq);
					M.to.push(0);
				}
				memberPage[b] = want;
			}
		}
		const n = dirtyList.length;
		dirtyList.length = 0;
		return n;
	};

	const startCommit = (space: number, kind: number, page: number): { ci: number; seq: number } => {
		const seq = (spaceSeq[space] as number) + 1;
		spaceSeq[space] = seq;
		const ci = C.space.push(space);
		C.seq.push(seq);
		C.kind.push(kind);
		const u = rng.rnd();
		const ak = kind === 1 ? 0 : u < 0.3 ? 0 : u < 0.93 ? 1 : 2;
		C.actorKind.push(ak);
		C.actor.push(ak === 0 ? rng.int(users.length) : ak === 1 ? rng.int(narrators.length) : 0);
		C.narrator.push(ak === 1 ? rng.int(narrators.length) : -1);
		C.nvers.push(0);
		C.page.push(page);
		commitIds.push(nanoId(rng));
		return { ci, seq };
	};

	const initialStates = () => {
		for (const pg of pages) {
			for (const b of pg.slots) {
				if (isTask[b]) {
					const r = rng.rnd();
					taskOf[b] = r < 0.6 ? 1 : r < 0.7 ? 2 : r < 0.95 ? 3 : 4;
				}
			}
		}
	};
	initialStates();

	for (let pi = 0; pi < pages.length; pi++) {
		const pg = pages[pi] as PageRec;
		const { ci, seq } = startCommit(pg.space, 1, pi);
		const initial = Math.round(pg.size * params.initialFraction);
		// root
		live[pg.root] = 1;
		offOf[pg.root] = rng.int(poolMax);
		lenOf[pg.root] = rng.range(5, 40);
		okOf[pg.root] = keyId("a0");
		markDirty(pg.root, FLAG.CREATED);
		const depth = new Uint8Array(pg.size);
		const sections: number[] = [pg.root];
		for (let i = 1; i < initial; i++) {
			const b = pg.slots[i] as number;
			let parent: number;
			const r = rng.rnd();
			if (r < 0.35) {
				const lo = Math.max(0, i - 20);
				parent = pg.slots[rng.range(lo, i - 1)] as number;
			} else if (r < 0.8) {
				parent = sections[rng.int(sections.length)] as number;
			} else {
				parent = pg.slots[rng.int(i)] as number;
			}
			let guard = 0;
			while ((depth[parent - pg.root] as number) >= 8 && guard++ < 12)
				parent = parentOf[parent] as number;
			parentOf[b] = parent;
			depth[b - pg.root] = (depth[parent - pg.root] as number) + 1;
			if ((depth[b - pg.root] as number) <= 2) sections.push(b);
			(children[parent] as number[]).push(b);
			okOf[b] = nextKey(parent);
			live[b] = 1;
			offOf[b] = rng.int(poolMax);
			lenOf[b] = sampleLen(rng);
			markDirty(b, FLAG.CREATED);
		}
		for (let i = pg.size - 1; i >= initial; i--) pg.pending.push(pg.slots[i] as number);
		const n = finalize(ci, seq);
		C.nvers.a[ci] = n;
	}

	// --- edit commits
	const target = B * params.vpb;
	const groups: { nodes: number[]; root: number; page: number }[][] = Array.from(
		{ length: params.spaces },
		() => [],
	);
	// space / page popularity
	const spaceW = Array.from({ length: params.spaces }, () => Math.exp(0.5 * rng.normal()));
	const spaceCum: number[] = [];
	let st = 0;
	for (const w of spaceW) {
		st += w;
		spaceCum.push(st);
	}
	const pagesBySpace: number[][] = Array.from({ length: params.spaces }, () => []);
	const pageW: number[] = [];
	for (let pi = 0; pi < pages.length; pi++) {
		const pg = pages[pi] as PageRec;
		pagesBySpace[pg.space]?.push(pi);
		pageW.push(Math.exp(1.0 * rng.normal()) * (pg.size / params.blocksPerPage));
	}
	const pickSpace = (): number => {
		const x = rng.rnd() * st;
		for (let i = 0; i < spaceCum.length; i++) if ((spaceCum[i] as number) >= x) return i;
		return spaceCum.length - 1;
	};
	const pickPageIn = (space: number): number => {
		const list = pagesBySpace[space] as number[];
		let tot = 0;
		for (const p of list) tot += pageW[p] as number;
		let x = rng.rnd() * tot;
		for (const p of list) {
			x -= pageW[p] as number;
			if (x <= 0) return p;
		}
		return list[list.length - 1] as number;
	};
	const lastPage = new Int32Array(params.spaces).fill(-1);

	const opEdit = (p: number) => {
		const b = pickBlock(p);
		if (b < 0) return;
		if (rng.rnd() < 0.05) lenOf[b] = sampleLen(rng);
		else
			lenOf[b] = Math.max(
				1,
				Math.min(5000, Math.round((lenOf[b] as number) * Math.exp(0.25 * rng.normal()))),
			);
		offOf[b] = rng.int(poolMax);
		markDirty(b, FLAG.CONTENT);
	};
	const opTask = (p: number) => {
		const pg = pages[p] as PageRec;
		for (let tries = 0; tries < 20; tries++) {
			const b = pg.tasks[rng.int(pg.tasks.length)];
			if (b === undefined) break;
			if (live[b] === 1 && pageOf[b] === p) {
				const cur = taskOf[b] as number;
				taskOf[b] = cur === 1 ? 2 : cur === 2 ? (rng.rnd() < 0.85 ? 3 : 4) : 1;
				if (rng.rnd() < 0.3) {
					offOf[b] = rng.int(poolMax);
					markDirty(b, FLAG.TASK | FLAG.CONTENT);
				} else markDirty(b, FLAG.TASK);
				return;
			}
		}
		opEdit(p);
	};
	const opCreate = (p: number) => {
		const pg = pages[p] as PageRec;
		const b = pg.pending.pop();
		if (b === undefined) return opEdit(p);
		let q = pickUniform(p);
		let guard = 0;
		while (depthOf(q) >= 7 && guard++ < 10) q = parentOf[q] === -1 ? q : (parentOf[q] as number);
		parentOf[b] = q;
		(children[q] as number[]).push(b);
		okOf[b] = nextKey(q);
		live[b] = 1;
		pageOf[b] = p;
		offOf[b] = rng.int(poolMax);
		lenOf[b] = sampleLen(rng);
		markDirty(b, FLAG.CREATED);
	};
	const opDelete = (p: number) => {
		for (let tries = 0; tries < 8; tries++) {
			const b = pickBlock(p, false);
			if (b < 0) return;
			const nodes = collectLive(b, rng.rnd() < 0.05 ? 150 : 12);
			if (!nodes) continue;
			for (const x of nodes) {
				live[x] = 2;
				markDirty(x, FLAG.DELETED);
			}
			(groups[(pages[p] as PageRec).space] as (typeof groups)[number]).push({ nodes, root: b, page: p });
			return;
		}
		opEdit(p);
	};
	const opRestore = (p: number) => {
		const gs = groups[(pages[p] as PageRec).space] as (typeof groups)[number];
		if (gs.length === 0) return opEdit(p);
		const lo = Math.max(0, gs.length - 60);
		const gi = rng.range(lo, gs.length - 1);
		const g = gs[gi] as (typeof gs)[number];
		gs[gi] = gs[gs.length - 1] as (typeof gs)[number];
		gs.pop();
		const par = parentOf[g.root] as number;
		if (par === -1 || live[par] !== 1 || pageOf[par] !== g.page) return opEdit(p);
		for (const x of g.nodes) {
			if (live[x] !== 2) continue;
			live[x] = 1;
			markDirty(x, FLAG.RESTORED);
		}
	};
	const opMoveWithin = (p: number) => {
		const b = pickBlock(p, false);
		if (b < 0) return;
		if (rng.rnd() < 0.4) {
			okOf[b] = randomKey();
			markDirty(b, FLAG.MOVED);
			return;
		}
		for (let tries = 0; tries < 10; tries++) {
			const q = pickUniform(p);
			if (q === b || isAncestor(b, q) || depthOf(q) > 6) continue;
			removeChild(parentOf[b] as number, b);
			parentOf[b] = q;
			(children[q] as number[]).push(b);
			okOf[b] = randomKey();
			markDirty(b, FLAG.MOVED);
			return;
		}
		opEdit(p);
	};
	const opMoveCross = (p: number, space: number) => {
		const list = pagesBySpace[space] as number[];
		if (list.length < 2) return opEdit(p);
		for (let tries = 0; tries < 8; tries++) {
			const b = pickBlock(p, false);
			if (b < 0) return;
			const nodes = collectLive(b, 30);
			if (!nodes) continue;
			let p2 = list[rng.int(list.length)] as number;
			if (p2 === p) p2 = list[(list.indexOf(p) + 1) % list.length] as number;
			const q = pickUniform(p2);
			if (depthOf(q) > 6) continue;
			removeChild(parentOf[b] as number, b);
			parentOf[b] = q;
			(children[q] as number[]).push(b);
			okOf[b] = randomKey();
			for (const x of nodes) {
				pageOf[x] = p2;
				markDirty(x, x === b ? FLAG.MOVED | FLAG.PAGE : FLAG.PAGE);
			}
			return;
		}
		opEdit(p);
	};

	let guardCommits = 0;
	while (V.block.n < target && guardCommits++ < 50_000_000) {
		const space = pickSpace();
		let p = lastPage[space] as number;
		if (p < 0 || rng.rnd() > 0.55) p = pickPageIn(space);
		lastPage[space] = p;
		const pg = pages[p] as PageRec;
		const nOps = sampleOpsPerCommit(rng);
		const { ci, seq } = startCommit(space, 0, p);
		// pre-compute per-op type
		for (let k = 0; k < nOps; k++) {
			const r = rng.rnd();
			if (r < 0.87) opEdit(p);
			else if (r < 0.94) opTask(p);
			else if (r < 0.952 && pg.pending.length > 0) opCreate(p);
			else if (r < 0.964) opDelete(p);
			else if (r < 0.9755) opRestore(p);
			else if (r < 0.9985) opMoveWithin(p);
			else opMoveCross(p, space);
		}
		const n = finalize(ci, seq);
		if (n === 0) {
			// should not happen; make sure every commit is non-empty
			opEdit(p);
			C.nvers.a[ci] = finalize(ci, seq);
		} else C.nvers.a[ci] = n;
	}

	// commit times: 300 days from 2026-01-01
	const nCommits = C.space.n;
	const cTime = new Float64Array(nCommits);
	const t0 = Date.UTC(2026, 0, 1);
	const span = 300 * 86400_000;
	for (let i = 0; i < nCommits; i++) cTime[i] = Math.floor(t0 + (i / nCommits) * span + rng.int(1000));

	const spaceMaxSeq = Array.from(spaceSeq);
	const vSlice = (c: Col | ColU8) => c.a.slice(0, c.n);
	return {
		params,
		ids,
		pages,
		spaceIds,
		spaceMaxSeq,
		commitIds,
		cSpace: vSlice(C.space) as Int32Array,
		cSeq: vSlice(C.seq) as Int32Array,
		cKind: vSlice(C.kind) as Uint8Array,
		cActorKind: vSlice(C.actorKind) as Uint8Array,
		cActor: vSlice(C.actor) as Int32Array,
		cNarrator: vSlice(C.narrator) as Int32Array,
		cTime,
		cNVers: vSlice(C.nvers) as Int32Array,
		cPage: vSlice(C.page) as Int32Array,
		nCommits,
		V: {
			n: V.block.n,
			block: vSlice(V.block) as Int32Array,
			from: vSlice(V.from) as Int32Array,
			to: vSlice(V.to) as Int32Array,
			commit: vSlice(V.commit) as Int32Array,
			page: vSlice(V.page) as Int32Array,
			parent: vSlice(V.parent) as Int32Array,
			ok: vSlice(V.ok) as Int32Array,
			off: vSlice(V.off) as Int32Array,
			len: vSlice(V.len) as Int32Array,
			task: vSlice(V.task) as Uint8Array,
			del: vSlice(V.del) as Uint8Array,
			flags: vSlice(V.flags) as Uint8Array,
		},
		okStr,
		M: {
			n: M.page.n,
			page: vSlice(M.page) as Int32Array,
			block: vSlice(M.block) as Int32Array,
			from: vSlice(M.from) as Int32Array,
			to: vSlice(M.to) as Int32Array,
		},
		blockCount: B,
		live,
		pageOf,
		parentOf,
		okOf,
		offOf,
		lenOf,
		taskOf,
		last,
		pool,
		users,
		narrators,
		summaryOf: (c: number) => {
			const n = C.nvers.a[c] as number;
			const kinds = ["edit", "import", "confirm", "revert"];
			return `${kinds[C.kind.a[c] as number]} ${n} block${n === 1 ? "" : "s"} · page ${(C.page.a[c] as number) + 1}`;
		},
	};
}

// ------------------------------------------------------------------------------------------------
// Row builders (shared by SQLite and PG sinks)

const TASK_NAMES = ["", "todo", "doing", "done", "cancelled"];

export function taskJson(h: History, b: number, task: number): string | null {
	if (task === 0) return null;
	const due = `2026-${String(1 + (b % 12)).padStart(2, "0")}-${String(1 + (b % 28)).padStart(2, "0")}`;
	return `{"status":"${TASK_NAMES[task]}","assignee":"${h.ids[(b * 7919) % h.blockCount]}","due":"${due}"}`;
}

export function escCopy(s: string): string {
	return s.replace(/[\\\t\n\r]/g, (m) =>
		m === "\\" ? "\\\\" : m === "\t" ? "\\t" : m === "\n" ? "\\n" : "\\r",
	);
}

export const SQLITE_DDL = `
CREATE TABLE outline_commits (
	id TEXT NOT NULL, space_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
	actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, responsible_user_id TEXT NOT NULL,
	narrator_id TEXT, message_id TEXT, tool_call_id TEXT, visible INTEGER NOT NULL,
	created_at INTEGER NOT NULL, summary TEXT NOT NULL
);
CREATE TABLE outline_blocks (
	id TEXT NOT NULL, space_id TEXT NOT NULL, page_id TEXT NOT NULL, parent_id TEXT,
	order_key TEXT NOT NULL, content TEXT, task_json TEXT, invalid_reason TEXT,
	version_seq INTEGER NOT NULL, deleted INTEGER NOT NULL
);
CREATE TABLE outline_block_versions (
	block_id TEXT NOT NULL, from_seq INTEGER NOT NULL, to_seq INTEGER, to_max INTEGER NOT NULL,
	commit_id TEXT NOT NULL, page_id TEXT NOT NULL, parent_id TEXT, order_key TEXT NOT NULL,
	content TEXT, task_json TEXT, invalid_reason TEXT, content_hash TEXT NOT NULL,
	deleted INTEGER NOT NULL, redacted INTEGER NOT NULL, change_flags INTEGER NOT NULL
);
CREATE TABLE outline_page_members (
	page_id TEXT NOT NULL, block_id TEXT NOT NULL, from_seq INTEGER NOT NULL, to_seq INTEGER,
	to_max INTEGER NOT NULL
);
`;

export const PG_DDL = SQLITE_DDL.replace(/INTEGER/g, "BIGINT");

export const SINK_TABLE_COLS = {
	outline_commits: 13,
	outline_blocks: 10,
	outline_block_versions: 15,
	outline_page_members: 5,
} as const;

type Row = (string | number | null)[];

export function* commitRows(h: History): Generator<Row> {
	const kinds = ["edit", "import", "confirm", "revert"];
	const actorKinds = ["human", "agent", "system"];
	for (let c = 0; c < h.nCommits; c++) {
		const ak = h.cActorKind[c] as number;
		const actor = h.cActor[c] as number;
		const actorId = ak === 0 ? h.users[actor] : ak === 1 ? h.narrators[actor] : "system";
		const resp = h.users[(actor * 7 + c) % h.users.length] as string;
		yield [
			h.commitIds[c] as string,
			h.spaceIds[h.cSpace[c] as number] as string,
			h.cSeq[c] as number,
			kinds[h.cKind[c] as number] as string,
			actorKinds[ak] as string,
			actorId as string,
			ak === 0 ? (actorId as string) : resp,
			ak === 1 ? (h.narrators[h.cNarrator[c] as number] as string) : null,
			ak === 1 ? h.commitIds[(c * 31) % h.nCommits]?.slice(0, 12) ?? null : null,
			ak === 1 ? `tc_${(c % 9973).toString(36)}` : null,
			c % 20 === 0 ? 0 : 1,
			h.cTime[c] as number,
			h.summaryOf(c),
		];
	}
}

export function* blockRows(h: History): Generator<Row> {
	for (let b = 0; b < h.blockCount; b++) {
		if (h.live[b] === 0) continue;
		const p = h.pageOf[b] as number;
		const pg = h.pages[p] as (typeof h.pages)[number];
		const deleted = h.live[b] === 2 ? 1 : 0;
		const vi = h.last[b] as number;
		yield [
			h.ids[b] as string,
			h.spaceIds[pg.space] as string,
			h.ids[pg.root] as string,
			h.parentOf[b] === -1 ? null : (h.ids[h.parentOf[b] as number] as string),
			h.okStr[h.okOf[b] as number] as string,
			deleted ? null : h.pool.substr(h.offOf[b] as number, h.lenOf[b] as number),
			taskJson(h, b, h.taskOf[b] as number),
			null,
			h.V.from[vi] as number,
			deleted,
		];
	}
}

export function* versionRows(h: History): Generator<Row> {
	const V = h.V;
	for (let i = 0; i < V.n; i++) {
		const b = V.block[i] as number;
		const del = V.del[i] as number;
		const content = del ? null : h.pool.substr(V.off[i] as number, V.len[i] as number);
		const to = V.to[i] as number;
		const pg = h.pages[V.page[i] as number] as (typeof h.pages)[number];
		yield [
			h.ids[b] as string,
			V.from[i] as number,
			to === 0 ? null : to,
			to === 0 ? OPEN : to,
			h.commitIds[V.commit[i] as number] as string,
			h.ids[pg.root] as string,
			V.parent[i] === -1 ? null : (h.ids[V.parent[i] as number] as string),
			h.okStr[V.ok[i] as number] as string,
			content,
			taskJson(h, b, V.task[i] as number),
			null,
			(Bun.hash(content ?? "") as bigint).toString(16),
			del,
			0,
			V.flags[i] as number,
		];
	}
}

export function* memberRows(h: History): Generator<Row> {
	const M = h.M;
	for (let i = 0; i < M.n; i++) {
		const pg = h.pages[M.page[i] as number] as (typeof h.pages)[number];
		const to = M.to[i] as number;
		yield [
			h.ids[pg.root] as string,
			h.ids[M.block[i] as number] as string,
			M.from[i] as number,
			to === 0 ? null : to,
			to === 0 ? OPEN : to,
		];
	}
}

function writeSqlite(h: History, dbPath: string) {
	const db = new Database(dbPath, { create: true });
	db.run("PRAGMA journal_mode = OFF");
	db.run("PRAGMA synchronous = OFF");
	db.run("PRAGMA page_size = 4096");
	db.run("PRAGMA cache_size = -400000");
	for (const stmt of SQLITE_DDL.split(";")) if (stmt.trim()) db.run(stmt);
	const load = (table: string, nCols: number, rows: Generator<Row>) => {
		const stmt = db.prepare(`INSERT INTO ${table} VALUES (${Array(nCols).fill("?").join(",")})`);
		db.run("BEGIN");
		let n = 0;
		for (const r of rows) {
			stmt.run(...r);
			if (++n % 100_000 === 0) {
				db.run("COMMIT");
				db.run("BEGIN");
			}
		}
		db.run("COMMIT");
		return n;
	};
	const t0 = performance.now();
	console.log("sqlite commits", load("outline_commits", 13, commitRows(h)));
	console.log("sqlite blocks", load("outline_blocks", 10, blockRows(h)));
	console.log("sqlite versions", load("outline_block_versions", 15, versionRows(h)));
	console.log("sqlite members", load("outline_page_members", 5, memberRows(h)));
	console.log(`sqlite load ${((performance.now() - t0) / 1000).toFixed(1)}s`);
	db.close();
}

async function writeTsv(h: History, dir: string) {
	const w = async (name: string, rows: Generator<Row>) => {
		const sink = Bun.file(join(dir, `${name}.tsv`)).writer();
		let buf: string[] = [];
		let n = 0;
		for (const r of rows) {
			buf.push(r.map((x) => (x === null ? "\\N" : typeof x === "number" ? String(x) : escCopy(x))).join("\t"));
			if (buf.length >= 20_000) {
				sink.write(`${buf.join("\n")}\n`);
				buf = [];
				await sink.flush();
			}
			n++;
		}
		if (buf.length) sink.write(`${buf.join("\n")}\n`);
		await sink.end();
		console.log("tsv", name, n);
	};
	await w("outline_commits", commitRows(h));
	await w("outline_blocks", blockRows(h));
	await w("outline_block_versions", versionRows(h));
	await w("outline_page_members", memberRows(h));
}

export function describe(h: History) {
	const V = h.V;
	const perBlock = new Int32Array(h.blockCount);
	for (let i = 0; i < V.n; i++) perBlock[V.block[i] as number]++;
	const arr = Array.from(perBlock).filter((x) => x > 0).sort((a, b) => a - b);
	const q = (p: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] as number;
	const perCommit = Array.from(h.cNVers).sort((a, b) => a - b);
	const qc = (p: number) => perCommit[Math.min(perCommit.length - 1, Math.floor(perCommit.length * p))] as number;
	let contentBytes = 0;
	let cnt = 0;
	for (let i = 0; i < V.n; i += 7) {
		if (V.del[i]) continue;
		contentBytes += Buffer.byteLength(h.pool.substr(V.off[i] as number, V.len[i] as number));
		cnt++;
	}
	const flagCounts: Record<string, number> = {};
	for (const [k, v] of Object.entries(FLAG)) {
		let c = 0;
		for (let i = 0; i < V.n; i++) if ((V.flags[i] as number) & v) c++;
		flagCounts[k] = c;
	}
	return {
		blocks: h.blockCount,
		pages: h.pages.length,
		versions: V.n,
		commits: h.nCommits,
		members: h.M.n,
		versionsPerBlock: {
			mean: V.n / h.blockCount,
			p50: q(0.5),
			p90: q(0.9),
			p99: q(0.99),
			max: arr[arr.length - 1],
		},
		versionsPerCommit: { mean: V.n / h.nCommits, p50: qc(0.5), p95: qc(0.95), max: qc(1) },
		avgContentBytes: Math.round(contentBytes / cnt),
		spaceMaxSeq: h.spaceMaxSeq,
		flagCounts,
	};
}

if (import.meta.main) {
	const scale = argNum("scale", 1);
	const vpb = argNum("vpb", 10);
	const out = arg("out") ?? join(DATA_ROOT, `tt-vpb${vpb}`);
	const params = { ...defaultParams(scale), vpb, seed: argNum("seed", 1) };
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	let t = performance.now();
	const h = simulate(params);
	console.log(`simulated in ${((performance.now() - t) / 1000).toFixed(1)}s`);
	const info = describe(h);
	console.log(JSON.stringify(info, null, 1));
	await Bun.write(
		join(out, "meta.json"),
		JSON.stringify({
			params,
			info,
			pages: h.pages.map((p, i) => ({
				id: h.ids[p.root],
				space: h.spaceIds[p.space],
				spaceIdx: p.space,
				size: p.size,
				idx: i,
			})),
			spaceIds: h.spaceIds,
			spaceMaxSeq: h.spaceMaxSeq,
		}),
	);
	t = performance.now();
	writeSqlite(h, join(out, "bench.db"));
	if (arg("tsv", "true") !== "false") {
		await writeTsv(h, out);
		console.log(`tsv done ${((performance.now() - t) / 1000).toFixed(1)}s total with sqlite`);
	}
}
