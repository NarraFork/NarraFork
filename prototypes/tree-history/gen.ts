/**
 * Synthetic outline space with history, in ONE SQLite file holding the rows of several history
 * schemes side by side, so every scheme is measured on exactly the same data:
 *
 *   P  (today)   versions.page_id + idx_v_page (page_id, from_seq, to_seq)
 *   A            the same version rows + idx_v_parent (parent_id, from_seq, to_seq)
 *   A' (edges)   edges(parent_key, block_id, from_seq, to_seq, order_key): one row per PLACEMENT
 *                (create / move / reorder / restore), none for a content edit
 *   B  (touch)   touch(ancestor_id, seq): every strict ancestor of a block a commit changed
 *
 * Table shapes follow server/db/schema.ts on origin/main (rowid tables with text primary keys,
 * the same columns); `edges` and `touch` are WITHOUT ROWID.
 *
 * Usage: bun gen.ts <blocks> <out.db> [versionsPerBlock=10]
 */
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";

const N = Number(process.argv[2] ?? 10_000);
const OUT = process.argv[3] ?? `space-${N}.db`;
const VPB = Number(process.argv[4] ?? 10);

function mulberry32(a: number) {
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rand = mulberry32(20261114);
const ri = (n: number) => Math.floor(rand() * n);

const ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-";
/** A 21-character id that looks like a nanoid (random order in an index), from an integer. */
function idOf(prefix: number, i: number): string {
	const r = mulberry32((i * 2654435761 + prefix * 97) | 0);
	let s = "";
	for (let k = 0; k < 21; k++) s += ALPHA[Math.floor(r() * 64)];
	return s;
}
const SPACE = "space000000000000000A";
const WORDS =
	"the outline keeps every block version so a page can be read as of any commit and a reader can drag the timeline to see how the tree grew 历史 时间轴 版本 子树 移动 提交 任务 结论 设计 权限 ".repeat(
		40,
	);
function contentOf(seed: number): string {
	const r = mulberry32(seed);
	// Mostly one-line bullets, a few long ones: mean ≈ 80 characters.
	const u = r();
	const len = u < 0.6 ? 20 + Math.floor(r() * 60) : u < 0.95 ? 80 + Math.floor(r() * 120) : 200 + Math.floor(r() * 600);
	const at = Math.floor(r() * (WORDS.length - len - 1));
	return WORDS.slice(at, at + len);
}
function hashOf(seed: number): string {
	const r = mulberry32(seed ^ 0x5bd1e995);
	let s = "";
	for (let k = 0; k < 8; k++) s += Math.floor(r() * 4294967296).toString(16).padStart(8, "0");
	return s;
}
const okey = (n: number) => `a${n.toString(36).padStart(3, "0")}`;

// ---------------------------------------------------------------------------------------------
// 1. Skeleton: which block goes under which parent when it is created.
// ---------------------------------------------------------------------------------------------
const parent0 = new Int32Array(N).fill(-1);
const special: Record<string, number> = {};
const pageSizes: number[] = [];
{
	const wanted = [2000, 10_000, 20_000, 100_000].filter((s) => s * 4 <= N || (s === 2000 && N >= 8000));
	let left = N;
	for (const s of wanted) {
		pageSizes.push(s);
		left -= s;
	}
	// The hot page: one parent with 50 children that are edited over and over (live typing).
	pageSizes.push(60);
	left -= 60;
	while (left > 0) {
		const u = rand();
		// Median ≈ 150 blocks, a tail up to 3000.
		let s = Math.max(1, Math.floor(Math.exp(5 + 1.2 * (rand() + rand() + rand() - 1.5) * 1.6)));
		if (u < 0.02) s = 1000 + ri(2000);
		s = Math.min(s, left);
		pageSizes.push(s);
		left -= s;
	}
}
const pageStart: number[] = [];
{
	let at = 0;
	for (let p = 0; p < pageSizes.length; p++) {
		const size = pageSizes[p] as number;
		pageStart.push(at);
		if (size === 2000 && special.s2000 === undefined) special.s2000 = at;
		else if (size === 10_000) special.s10000 = at;
		else if (size === 20_000) special.s20000 = at;
		else if (size === 100_000) special.s100000 = at;
		else if (p === pageSizes.findIndex((s) => s === 60) && special.hot === undefined) special.hot = at;
		const byDepth: number[][] = [[at]];
		let j = 1;
		if (special.hot === at) {
			// page -> hot parent -> 50 children, a few more leaves.
			parent0[at + 1] = at;
			for (j = 2; j < size; j++) parent0[at + j] = j < 52 ? at + 1 : at;
			at += size;
			continue;
		}
		if (p % 40 === 7 && size > 40) {
			// A deep chain: each block under the previous one.
			const chain = Math.min(150, Math.floor(size / 4));
			for (; j <= chain; j++) {
				parent0[at + j] = at + j - 1;
				(byDepth[j] ??= []).push(at + j);
			}
		}
		for (; j < size; j++) {
			const u = rand();
			let d = u < 0.25 ? 1 : u < 0.6 ? 2 : u < 0.82 ? 3 : u < 0.92 ? 4 : u < 0.97 ? 5 : 6 + ri(4);
			while (d > 1 && !byDepth[d - 1]) d--;
			const list = byDepth[d - 1] as number[];
			// Locality: an author keeps adding under the block they are on.
			const pick = rand() < 0.35 ? list[Math.max(0, list.length - 1 - ri(4))] : list[ri(list.length)];
			parent0[at + j] = pick as number;
			(byDepth[d] ??= []).push(at + j);
		}
		at += size;
	}
}

// ---------------------------------------------------------------------------------------------
// 2. History: creations interleaved with edits, kept in typed arrays until every interval's end
//    is known, then written in commit order (so the indexes grow the way they would in use).
// ---------------------------------------------------------------------------------------------
const HOT_EDITS = Math.max(50, Math.min(1000, Math.floor(N / 100)));
const CAP = Math.floor(N * (VPB + 1.5)) + 60 * HOT_EDITS;
const vBlock = new Int32Array(CAP);
const vFrom = new Int32Array(CAP);
const vTo = new Int32Array(CAP); // 0 = open
const vParent = new Int32Array(CAP);
const vPage = new Int32Array(CAP);
const vKey = new Int32Array(CAP);
const vFlags = new Uint16Array(CAP);
const vDel = new Uint8Array(CAP);
const vSeed = new Int32Array(CAP);
let nv = 0;
const eBlock = new Int32Array(CAP);
const eParent = new Int32Array(CAP);
const eFrom = new Int32Array(CAP);
const eTo = new Int32Array(CAP);
const eKey = new Int32Array(CAP);
let ne = 0;
let tAnc = new Int32Array(CAP * 3);
let tSeq = new Int32Array(CAP * 3);
let nt = 0;

const parent = new Int32Array(N).fill(-1);
const page = new Int32Array(N);
const key = new Int32Array(N);
const nextKey = new Int32Array(N + 1); // per parent (index N = the space)
const kids = new Int32Array(N);
const alive = new Uint8Array(N);
const lastV = new Int32Array(N).fill(-1);
const lastE = new Int32Array(N).fill(-1);
const task = new Uint8Array(N);
const seedOf = new Int32Array(N);
const firstSeq = new Int32Array(N);

let seq = 0;
let touchedThisCommit = new Set<number>();
function touchAncestors(b: number) {
	for (let a = parent[b] as number; a >= 0; a = parent[a] as number) {
		if (touchedThisCommit.has(a)) break; // its own ancestors are in already
		touchedThisCommit.add(a);
	}
}
function flushTouch() {
	if (nt + touchedThisCommit.size > tAnc.length) {
		const a = new Int32Array(tAnc.length * 2);
		a.set(tAnc);
		tAnc = a;
		const s = new Int32Array(tSeq.length * 2);
		s.set(tSeq);
		tSeq = s;
	}
	for (const a of touchedThisCommit) {
		tAnc[nt] = a;
		tSeq[nt++] = seq;
	}
	touchedThisCommit = new Set();
}
function version(b: number, flags: number) {
	const prev = lastV[b] as number;
	if (prev >= 0) {
		if (vFrom[prev] === seq) {
			vFlags[prev] = (vFlags[prev] as number) | flags;
			vParent[prev] = parent[b] as number;
			vPage[prev] = page[b] as number;
			vKey[prev] = key[b] as number;
			vDel[prev] = alive[b] ? 0 : 1;
			vSeed[prev] = seedOf[b] as number;
			return;
		}
		vTo[prev] = seq;
	}
	vBlock[nv] = b;
	vFrom[nv] = seq;
	vParent[nv] = parent[b] as number;
	vPage[nv] = page[b] as number;
	vKey[nv] = key[b] as number;
	vFlags[nv] = flags;
	vDel[nv] = alive[b] ? 0 : 1;
	vSeed[nv] = seedOf[b] as number;
	lastV[b] = nv++;
}
function edge(b: number) {
	const prev = lastE[b] as number;
	if (prev >= 0 && eTo[prev] === 0) {
		if (eFrom[prev] === seq) {
			eParent[prev] = parent[b] as number;
			eKey[prev] = key[b] as number;
			return;
		}
		eTo[prev] = seq;
	}
	if (!alive[b]) return;
	eBlock[ne] = b;
	eParent[ne] = parent[b] as number;
	eFrom[ne] = seq;
	eKey[ne] = key[b] as number;
	lastE[b] = ne++;
}
function create(b: number) {
	const p = parent0[b] as number;
	parent[b] = p;
	page[b] = p < 0 ? b : (page[p] as number);
	const slot = p < 0 ? N : p;
	key[b] = nextKey[slot] as number;
	nextKey[slot] = (nextKey[slot] as number) + 1;
	if (p >= 0) kids[p] = (kids[p] as number) + 1;
	alive[b] = 1;
	seedOf[b] = (b * 31 + seq) | 0;
	task[b] = rand() < 0.06 ? 1 : 0;
	firstSeq[b] = seq;
	version(b, 1);
	edge(b);
	touchAncestors(b);
}
function content(b: number) {
	seedOf[b] = (b * 31 + seq * 7) | 0;
	version(b, 2);
	touchAncestors(b);
}
/** Put a live block (with whatever is under it; history only moves leaves) under `to`. */
function move(b: number, to: number, flags: number) {
	touchAncestors(b);
	const from = parent[b] as number;
	if (from >= 0) kids[from] = (kids[from] as number) - 1;
	parent[b] = to;
	kids[to] = (kids[to] as number) + 1;
	page[b] = page[to] as number;
	key[b] = nextKey[to] as number;
	nextKey[to] = (nextKey[to] as number) + 1;
	version(b, flags);
	edge(b);
	touchAncestors(b);
}

let created = 0;
const editsWanted = N * (VPB - 1);
let edits = 0;
const isHot = (b: number) => ((b * 2654435761) >>> 0) % 5 === 0;
function pickBlock(): number {
	for (let tries = 0; tries < 8; tries++) {
		const b = rand() < 0.5 ? Math.max(0, created - 1 - ri(Math.min(created, 2000))) : ri(created);
		if (!alive[b]) continue;
		if (isHot(b) || rand() < 0.2) return b;
	}
	return -1;
}
const avgK = 0.7 * 1 + 0.25 * 3 + 0.05 * 20;
const createCommits = N / 4.5;
const pCreate = createCommits / (createCommits + editsWanted / avgK) / 0.9;
const hotKids: number[] = [];
let hotLeft = 0;
const marks: Record<string, number> = {};
while (created < N || edits < editsWanted) {
	seq++;
	if (created < N && (edits >= editsWanted || rand() < pCreate || created < 8)) {
		// Special pages are created in a burst (an import), others a few blocks at a time.
		const k = Math.min(N - created, 1 + ri(8));
		for (let j = 0; j < k; j++) create(created++);
		if (special.hot !== undefined && hotKids.length === 0 && created >= special.hot + 60) {
			for (let j = 2; j < 52; j++) hotKids.push(special.hot + j);
			hotLeft = 50 * HOT_EDITS;
			marks.hotReady = seq;
		}
	} else if (hotLeft > 0 && rand() < 0.25) {
		// Live typing: one block per commit, the same few blocks again and again.
		content(hotKids[ri(hotKids.length)] as number);
		hotLeft--;
	} else {
		const u = rand();
		const k = u < 0.7 ? 1 : u < 0.95 ? 2 + ri(3) : 10 + ri(21);
		for (let j = 0; j < k; j++) {
			const b = pickBlock();
			if (b < 0) continue;
			edits++;
			const r = rand();
			const leaf = kids[b] === 0 && parent[b] !== -1 && !hotKids.includes(b);
			if (r < 0.86 || !leaf) content(b);
			else if (r < 0.9) {
				task[b] = task[b] ? 0 : 1;
				version(b, 32);
				touchAncestors(b);
			} else if (r < 0.95) move(b, parent[b] as number, 4);
			else if (r < 0.98) {
				// Another parent on the same page.
				const pg = page[b] as number;
				let to = pg + ri(Math.max(1, Math.min(created - pg, 200)));
				if (!alive[to] || page[to] !== pg || to === b) to = pg;
				move(b, to, 4);
			} else if (r < 0.99) {
				let to = ri(created);
				if (!alive[to] || to === b) to = page[b] as number;
				move(b, to, page[to] === page[b] ? 4 : 4 | 64);
			} else {
				touchAncestors(b);
				alive[b] = 0;
				kids[parent[b] as number] = (kids[parent[b] as number] as number) - 1;
				version(b, 8);
				edge(b);
			}
		}
	}
	flushTouch();
}
const lastSeq = seq;
console.log(
	`blocks ${N}  commits ${lastSeq}  versions ${nv} (${(nv / N).toFixed(2)}/block)  edges ${ne}  touch ${nt} (${(nt / lastSeq).toFixed(2)}/commit)`,
);

// ---------------------------------------------------------------------------------------------
// 3. Write.
// ---------------------------------------------------------------------------------------------
for (const f of [OUT, `${OUT}-wal`, `${OUT}-shm`]) if (existsSync(f)) unlinkSync(f);
const db = new Database(OUT);
db.run("PRAGMA journal_mode = OFF");
db.run("PRAGMA synchronous = OFF");
db.run("PRAGMA cache_size = -2000000");
db.run("PRAGMA page_size = 4096");
db.run(`
CREATE TABLE commits (
	id TEXT PRIMARY KEY, space_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
	actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, responsible_user_id TEXT, narrator_id TEXT,
	message_id TEXT, tool_call_id TEXT, created_at TEXT NOT NULL, summary TEXT NOT NULL);
CREATE UNIQUE INDEX uq_commits_space_seq ON commits (space_id, seq);
CREATE TABLE blocks (
	id TEXT PRIMARY KEY, space_id TEXT NOT NULL, sid TEXT NOT NULL, parent_id TEXT,
	page_id TEXT NOT NULL, order_key TEXT NOT NULL, content TEXT NOT NULL,
	content_hash TEXT NOT NULL, alias TEXT, task_json TEXT, ask_json TEXT,
	author_kind TEXT NOT NULL, author_id TEXT NOT NULL, version_seq INTEGER NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0, in_process INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX uq_blocks_space_sid ON blocks (space_id, sid);
CREATE INDEX idx_blocks_page ON blocks (page_id);
CREATE INDEX idx_blocks_children ON blocks (space_id, parent_id, order_key);
CREATE TABLE versions (
	block_id TEXT NOT NULL, from_seq INTEGER NOT NULL, to_seq INTEGER, commit_id TEXT NOT NULL,
	page_id TEXT NOT NULL, parent_id TEXT, order_key TEXT NOT NULL, content TEXT,
	task_json TEXT, ask_json TEXT, alias TEXT, content_hash TEXT NOT NULL,
	change_flags INTEGER NOT NULL, deleted INTEGER NOT NULL,
	PRIMARY KEY (block_id, from_seq));
CREATE INDEX idx_v_page ON versions (page_id, from_seq, to_seq);
CREATE INDEX idx_v_commit ON versions (commit_id);
CREATE INDEX idx_v_parent ON versions (parent_id, from_seq, to_seq);
CREATE TABLE edges (
	parent_key TEXT NOT NULL, block_id TEXT NOT NULL, from_seq INTEGER NOT NULL, to_seq INTEGER,
	order_key TEXT NOT NULL,
	PRIMARY KEY (parent_key, block_id, from_seq)) WITHOUT ROWID;
CREATE INDEX idx_e_block ON edges (block_id, from_seq);
CREATE TABLE touch (
	ancestor_id TEXT NOT NULL, seq INTEGER NOT NULL,
	PRIMARY KEY (ancestor_id, seq)) WITHOUT ROWID;
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);
const ids: string[] = new Array(N);
for (let i = 0; i < N; i++) ids[i] = idOf(1, i);
const TASK = (b: number) =>
	`{"status":"${b % 3 === 0 ? "doing" : "todo"}","assignee":{"kind":"human","id":"u000000000000000000001"}}`;

const t0 = performance.now();
const insC = db.prepare(
	"INSERT INTO commits VALUES (?, ?, ?, 'edit', ?, ?, ?, ?, NULL, NULL, ?, ?)",
);
const insV = db.prepare("INSERT INTO versions VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?)");
const insE = db.prepare("INSERT INTO edges VALUES (?,?,?,?,?)");
const insT = db.prepare("INSERT INTO touch VALUES (?,?)");
// Edges in the order they opened.
const eOrder = new Int32Array(ne);
for (let i = 0; i < ne; i++) eOrder[i] = i;
// (already chronological: edges are appended as commits happen)
let iv = 0;
let ie = 0;
let it = 0;
const base = Date.parse("2026-01-01T00:00:00Z");
const BATCH = 20_000;
for (let s = 1; s <= lastSeq; ) {
	const end = Math.min(lastSeq, s + BATCH - 1);
	db.transaction(() => {
		for (; s <= end; s++) {
			const cid = idOf(2, s);
			const agent = s % 3 !== 0;
			insC.run(
				cid,
				SPACE,
				s,
				agent ? "agent" : "human",
				agent ? `n${String(s % 40).padStart(20, "0")}` : `u${String(s % 7).padStart(20, "0")}`,
				`u${String(s % 7).padStart(20, "0")}`,
				agent ? `n${String(s % 40).padStart(20, "0")}` : null,
				new Date(base + s * 20_000).toISOString(),
				"edit blocks",
			);
			for (; iv < nv && vFrom[iv] === s; iv++) {
				const b = vBlock[iv] as number;
				const del = vDel[iv] as number;
				insV.run(
					ids[b] as string,
					s,
					vTo[iv] === 0 ? null : (vTo[iv] as number),
					cid,
					ids[vPage[iv] as number] as string,
					(vParent[iv] as number) < 0 ? null : (ids[vParent[iv] as number] as string),
					okey(vKey[iv] as number),
					del ? null : contentOf(vSeed[iv] as number),
					task[b] && !del ? TASK(b) : null,
					hashOf(vSeed[iv] as number),
					vFlags[iv] as number,
					del,
				);
			}
			for (; ie < ne && eFrom[ie] === s; ie++) {
				insE.run(
					(eParent[ie] as number) < 0 ? SPACE : (ids[eParent[ie] as number] as string),
					ids[eBlock[ie] as number] as string,
					s,
					eTo[ie] === 0 ? null : (eTo[ie] as number),
					okey(eKey[ie] as number),
				);
			}
			for (; it < nt && tSeq[it] === s; it++) insT.run(ids[tAnc[it] as number] as string, s);
		}
	})();
}
const insB = db.prepare("INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,NULL,?,NULL,?,?,?,?,0)");
for (let b = 0; b < N; ) {
	const end = Math.min(N, b + 50_000);
	db.transaction(() => {
		for (; b < end; b++) {
			const v = lastV[b] as number;
			insB.run(
				ids[b] as string,
				SPACE,
				b.toString(36).padStart(8, "0"),
				(parent[b] as number) < 0 ? null : (ids[parent[b] as number] as string),
				ids[page[b] as number] as string,
				okey(key[b] as number),
				contentOf(seedOf[b] as number),
				hashOf(seedOf[b] as number),
				task[b] && alive[b] ? TASK(b) : null,
				"human",
				"u000000000000000000001",
				vFrom[v] as number,
				alive[b] ? 0 : 1,
			);
		}
	})();
}
const meta = db.prepare("INSERT INTO meta VALUES (?, ?)");
meta.run("space", SPACE);
meta.run("blocks", String(N));
meta.run("lastSeq", String(lastSeq));
meta.run("versions", String(nv));
meta.run("edges", String(ne));
meta.run("touch", String(nt));
for (const [name, b] of Object.entries(special)) {
	const size = name === "hot" ? 60 : Number(name.slice(1));
	meta.run(name, ids[b] as string);
	meta.run(`${name}.ready`, String(firstSeq[b + size - 1]));
	if (name === "hot") meta.run("hot.parent", ids[b + 1] as string);
}
// A typical page: the median-sized ordinary one, and a mid-depth parent with ~50 children.
{
	const order = pageSizes.map((s, p) => [s, p] as const).filter(([s]) => s >= 300 && s <= 700);
	const [size, p] = order[Math.floor(order.length / 2)] ?? [0, 0];
	const start = pageStart[p] as number;
	meta.run("typical", ids[start] as string);
	meta.run("typical.size", String(size));
	meta.run("typical.ready", String(firstSeq[start + size - 1]));
}
db.run("PRAGMA journal_mode = WAL");
db.run("ANALYZE");
db.close();
console.log(`written in ${((performance.now() - t0) / 1000).toFixed(1)} s -> ${OUT}`);
