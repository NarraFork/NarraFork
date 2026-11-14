/**
 * Reads and moves on a space written by gen.ts, under each history scheme.
 * Usage: bun bench.ts <space.db> [--plans] [--no-moves] [--sizes]
 *
 * The connection uses the application's pragmas (server/db/connection.ts): WAL, synchronous
 * NORMAL, 16 MB page cache, 256 MB mmap. Times are wall clock around the statement(s) AND the
 * JavaScript that turns rows into a tree where the product does that too. Each read is repeated
 * at random seqs of the second half of history; p50 / p95 / max over the runs are printed.
 */
import { Database } from "bun:sqlite";

const FILE = process.argv[2] ?? "space-10k.db";
const PLANS = process.argv.includes("--plans");
const MOVES = !process.argv.includes("--no-moves");
const ONLY_MOVES = process.argv.includes("--only-moves");
const SIZES = process.argv.includes("--sizes");
const db = new Database(FILE);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA synchronous = NORMAL");
db.run("PRAGMA cache_size = -16000");
db.run("PRAGMA temp_store = MEMORY");
db.run("PRAGMA mmap_size = 268435456");

const meta = new Map(
	(db.query("SELECT k, v FROM meta").all() as Array<{ k: string; v: string }>).map((r) => [r.k, r.v]),
);
const SPACE = meta.get("space") as string;
const LAST = Number(meta.get("lastSeq"));
const N = Number(meta.get("blocks"));
let seed = 7;
const rnd = () => {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
};

type Row = unknown[];
const out: string[] = [];
function pct(xs: number[], p: number): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
}
const f = (ms: number) => (ms < 10 ? ms.toFixed(2) : ms.toFixed(1));
function report(name: string, times: number[], note = "") {
	const line = `${name.padEnd(58)} p50 ${f(pct(times, 0.5)).padStart(7)}  p95 ${f(pct(times, 0.95)).padStart(7)}  max ${f(Math.max(...times)).padStart(7)} ms  n=${times.length}  ${note}`;
	console.log(line);
	out.push(line);
}
function time(name: string, runs: number, fn: (i: number) => number | string, warm = 3) {
	for (let i = 0; i < warm; i++) fn(-1 - i);
	const times: number[] = [];
	let note: number | string = "";
	for (let i = 0; i < runs; i++) {
		const t = performance.now();
		note = fn(i);
		times.push(performance.now() - t);
	}
	report(name, times, String(note));
}
function plan(label: string, sql: string, params: unknown[]) {
	if (!PLANS) return;
	console.log(`  plan ${label}:`);
	for (const r of db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>)
		console.log(`    ${r.detail}`);
}

// --- the statements -----------------------------------------------------------------------------
/** P, as server/services/outline/store/sqlite-read.ts STRUCTURE_AS_OF. */
const P_STRUCT = `SELECT v.block_id, b.sid, v.parent_id, v.order_key, v.alias, v.task_json, v.from_seq, v.ask_json
	FROM versions v JOIN blocks b ON b.id = v.block_id
	WHERE v.page_id = ? AND v.from_seq <= ? AND (v.to_seq IS NULL OR v.to_seq > ?) AND v.deleted = 0
	LIMIT ? OFFSET ?`;
const P_CURRENT = `SELECT id, sid, parent_id, order_key, alias, task_json, version_seq, ask_json
	FROM blocks WHERE page_id = ? AND deleted = 0 LIMIT ? OFFSET ?`;
/** A: the same version rows, reached level by level through (parent_id, from_seq, to_seq). */
const A_SUBTREE = `WITH RECURSIVE sub(id, parent_id, order_key, alias, task_json, from_seq, ask_json) AS (
		SELECT v.block_id, v.parent_id, v.order_key, v.alias, v.task_json, v.from_seq, v.ask_json
		FROM versions v WHERE v.block_id = ?1 AND v.from_seq <= ?2 AND (v.to_seq IS NULL OR v.to_seq > ?2) AND v.deleted = 0
		UNION ALL
		SELECT v.block_id, v.parent_id, v.order_key, v.alias, v.task_json, v.from_seq, v.ask_json
		FROM sub JOIN versions v INDEXED BY idx_v_parent ON v.parent_id = sub.id
			AND v.from_seq <= ?2 AND (v.to_seq IS NULL OR v.to_seq > ?2) AND v.deleted = 0)
	SELECT * FROM sub LIMIT ?3`;
const A_CHILDREN = `SELECT v.block_id, v.order_key, v.alias, v.task_json, v.from_seq, v.content
	FROM versions v INDEXED BY idx_v_parent
	WHERE v.parent_id = ?1 AND v.from_seq <= ?2 AND (v.to_seq IS NULL OR v.to_seq > ?2) AND v.deleted = 0
	ORDER BY v.order_key LIMIT ?3`;
/** A': placements only. */
const E_SUBTREE = `WITH RECURSIVE sub(id, parent_id, order_key) AS (
		SELECT ?1, NULL, ''
		UNION ALL
		SELECT e.block_id, e.parent_key, e.order_key
		FROM sub JOIN edges e ON e.parent_key = sub.id AND e.from_seq <= ?2 AND (e.to_seq IS NULL OR e.to_seq > ?2))
	SELECT * FROM sub LIMIT ?3`;
/** A' with what the structure row of today carries (alias, task, the version's seq). */
const E_SUBTREE_META = `WITH RECURSIVE sub(id, parent_id, order_key) AS (
		SELECT ?1, NULL, ''
		UNION ALL
		SELECT e.block_id, e.parent_key, e.order_key
		FROM sub JOIN edges e ON e.parent_key = sub.id AND e.from_seq <= ?2 AND (e.to_seq IS NULL OR e.to_seq > ?2))
	SELECT sub.id, sub.parent_id, sub.order_key, v.alias, v.task_json, v.from_seq, v.ask_json
	FROM sub CROSS JOIN versions v ON v.block_id = sub.id
		AND v.from_seq = (SELECT max(x.from_seq) FROM versions x WHERE x.block_id = sub.id AND x.from_seq <= ?2)
	LIMIT ?3`;
const E_CHILDREN = `SELECT e.block_id, e.order_key FROM edges e
	WHERE e.parent_key = ?1 AND e.from_seq <= ?2 AND (e.to_seq IS NULL OR e.to_seq > ?2)
	ORDER BY e.order_key LIMIT ?3`;
const V_AT = `SELECT block_id, from_seq, alias, task_json, content FROM versions
	WHERE block_id = ? AND from_seq <= ? ORDER BY from_seq DESC LIMIT 1`;
const V_CONTENT = (n: number) =>
	`SELECT block_id, from_seq, content FROM versions WHERE (block_id, from_seq) IN (VALUES ${Array(n).fill("(?, ?)").join(", ")})`;
/** Current state without page_id: the children index of outline_blocks. */
const CUR_SUBTREE = `WITH RECURSIVE sub(id, sid, parent_id, order_key, alias, task_json, version_seq, ask_json) AS (
		SELECT id, sid, parent_id, order_key, alias, task_json, version_seq, ask_json FROM blocks WHERE id = ?1
		UNION ALL
		SELECT b.id, b.sid, b.parent_id, b.order_key, b.alias, b.task_json, b.version_seq, b.ask_json
		FROM sub JOIN blocks b ON b.space_id = ?2 AND b.parent_id = sub.id AND b.deleted = 0)
	SELECT * FROM sub LIMIT ?3`;

const q = (sql: string) => db.query(sql);
const pStruct = q(P_STRUCT);
const pCurrent = q(P_CURRENT);
const aSubtree = q(A_SUBTREE);
const aChildren = q(A_CHILDREN);
const eSubtree = q(E_SUBTREE);
const eSubtreeMeta = q(E_SUBTREE_META);
const eChildren = q(E_CHILDREN);
const vAt = q(V_AT);
const curSubtree = q(CUR_SUBTREE);

function buildTree(rows: Row[], idCol: number, parentCol: number): number {
	const kids = new Map<string | null, string[]>();
	for (const r of rows) {
		const p = r[parentCol] as string | null;
		const list = kids.get(p);
		if (list) list.push(r[idCol] as string);
		else kids.set(p, [r[idCol] as string]);
	}
	return kids.size;
}
function seqAfter(ready: number): number {
	const lo = Math.max(ready, Math.floor(LAST / 2));
	return lo + Math.floor(rnd() * (LAST - lo));
}

console.log(`\n=== ${FILE}: ${N} blocks, ${LAST} commits, ${meta.get("versions")} versions, ${meta.get("edges")} edges, ${meta.get("touch")} touch rows ===`);

if (!ONLY_MOVES) {
// --- 1. a 50-block visible window ----------------------------------------------------------------
function window50(name: string, pageId: string, ready: number) {
	// The window: the page's first 50 children and nothing under them (collapsed).
	const size = (db.query("SELECT count(*) c FROM blocks WHERE page_id = ? AND deleted = 0").get(pageId) as { c: number }).c;
	console.log(`\n-- 50-block window (page block + its first 50 children, with content) of ${name}, ${size} blocks`);
	const content50 = q(V_CONTENT(51));
	plan("P", P_STRUCT, [pageId, 1, 1, 2001, 0]);
	time(`P  page structure as of T + 51 contents`, 60, () => {
		const T = seqAfter(ready);
		const rows = pStruct.values(pageId, T, T, 10_001, 0) as Row[];
		buildTree(rows, 0, 2);
		const kids = rows.filter((r) => r[2] === pageId).sort((a, b) => ((a[3] as string) < (b[3] as string) ? -1 : 1)).slice(0, 50);
		const params: Array<string | number> = [pageId, rows.find((r) => r[0] === pageId)?.[6] as number];
		for (const k of kids) params.push(k[0] as string, k[6] as number);
		while (params.length < 102) params.push(params[0] as string, params[1] as number);
		content50.values(...params);
		return `${rows.length} rows read`;
	});
	plan("A", A_CHILDREN, [pageId, 1, 50]);
	time(`A  children by (parent_id, from_seq, to_seq)`, 200, () => {
		const T = seqAfter(ready);
		const rows = aChildren.values(pageId, T, 50) as Row[];
		vAt.values(pageId, T);
		return `${rows.length} rows`;
	});
	plan("A'", E_CHILDREN, [pageId, 1, 50]);
	plan("A' content", V_AT, [pageId, 1]);
	time(`A' edges + one version seek per block`, 200, () => {
		const T = seqAfter(ready);
		const rows = eChildren.values(pageId, T, 50) as Row[];
		vAt.values(pageId, T);
		for (const r of rows) vAt.values(r[0] as string, T);
		return `${rows.length} rows`;
	});
}
window50("a typical page", meta.get("typical") as string, Number(meta.get("typical.ready")));
if (meta.has("s2000")) window50("the 2,000-block page", meta.get("s2000") as string, Number(meta.get("s2000.ready")));
if (meta.has("s10000")) window50("the 10,000-block page", meta.get("s10000") as string, Number(meta.get("s10000.ready")));

// --- 1b. the hot parent: 50 children, each rewritten hundreds of times ----------------------------
{
	const hot = meta.get("hot.parent") as string;
	const page = meta.get("hot") as string;
	const ready = Number(meta.get("hot.ready"));
	const nv = (db.query("SELECT count(*) c FROM versions WHERE page_id = ?").get(page) as { c: number }).c;
	console.log(`\n-- hot parent: 50 children typed in again and again; the 60-block page holds ${nv} versions`);
	time(`P  page structure as of T`, 60, () => {
		const T = seqAfter(ready);
		return `${(pStruct.values(page, T, T, 10_001, 0) as Row[]).length} rows`;
	});
	time(`A  children by (parent_id, from_seq, to_seq)`, 60, () => {
		const T = seqAfter(ready);
		return `${(aChildren.values(hot, T, 50) as Row[]).length} rows`;
	});
	time(`A' edges + one version seek per block`, 200, () => {
		const T = seqAfter(ready);
		const rows = eChildren.values(hot, T, 50) as Row[];
		for (const r of rows) vAt.values(r[0] as string, T);
		return `${rows.length} rows`;
	});
}

// --- 2. whole subtrees -----------------------------------------------------------------------------
function subtree(name: string, size: number) {
	const root = meta.get(name);
	if (!root) return;
	const ready = Number(meta.get(`${name}.ready`));
	const runs = size >= 10_000 ? 20 : 40;
	console.log(`\n-- subtree of ${size} blocks (structure, tree built in JS)`);
	plan("A", A_SUBTREE, [root, 1, 10]);
	plan("A'", E_SUBTREE, [root, 1, 10]);
	plan("A'+meta", E_SUBTREE_META, [root, 1, 10]);
	plan("current, no page_id", CUR_SUBTREE, [root, SPACE, 10]);
	time(`P  current rows by page_id`, runs, () => {
		const rows = pCurrent.values(root, size * 2, 0) as Row[];
		buildTree(rows, 0, 2);
		return `${rows.length} rows`;
	});
	time(`-  current rows, recursive over the children index`, runs, () => {
		const rows = curSubtree.values(root, SPACE, size * 2) as Row[];
		buildTree(rows, 0, 2);
		return `${rows.length} rows`;
	});
	time(`P  as of T by (page_id, from_seq, to_seq)`, runs, () => {
		const T = seqAfter(ready);
		const rows = pStruct.values(root, T, T, size * 2, 0) as Row[];
		buildTree(rows, 0, 2);
		return `${rows.length} rows`;
	});
	time(`A  as of T, recursive by (parent_id, from_seq, to_seq)`, runs, () => {
		const T = seqAfter(ready);
		const rows = aSubtree.values(root, T, size * 2) as Row[];
		buildTree(rows, 0, 1);
		return `${rows.length} rows`;
	});
	time(`A' as of T, recursive over edges (ids, parents, order)`, runs, () => {
		const T = seqAfter(ready);
		const rows = eSubtree.values(root, T, size * 2) as Row[];
		buildTree(rows, 0, 1);
		return `${rows.length} rows`;
	});
	time(`A' as of T, edges + version seek per block (as today's row)`, runs, () => {
		const T = seqAfter(ready);
		const rows = eSubtreeMeta.values(root, T, size * 2) as Row[];
		buildTree(rows, 0, 1);
		return `${rows.length} rows`;
	});
	// Content of the 800 blocks a default view shows, by exact version (the same for every scheme).
	const T = seqAfter(ready);
	const rows = (pStruct.values(root, T, T, size * 2, 0) as Row[]).slice(0, 800);
	const stmt = q(V_CONTENT(250));
	time(`=  content of 800 blocks by exact version (all schemes)`, 20, () => {
		let bytes = 0;
		for (let i = 0; i < rows.length; i += 250) {
			const params: Array<string | number> = [];
			for (let j = 0; j < 250; j++) {
				const r = rows[Math.min(rows.length - 1, i + j)] as Row;
				params.push(r[0] as string, r[6] as number);
			}
			for (const c of stmt.values(...params) as Row[]) bytes += ((c[2] as string) ?? "").length;
		}
		return `${bytes} chars`;
	});
}
subtree("s2000", 2000);
subtree("s10000", 10_000);
subtree("s20000", 20_000);
subtree("s100000", 100_000);

// --- 3. diff of a subtree between two commits 1,000 apart -------------------------------------------
const E_SPAN = q(`SELECT e.block_id, e.from_seq, e.to_seq, e.order_key,
		EXISTS (SELECT 1 FROM versions v WHERE v.block_id = e.block_id AND v.from_seq > ?1 AND v.from_seq <= ?2),
		EXISTS (SELECT 1 FROM touch t WHERE t.ancestor_id = e.block_id AND t.seq > ?1 AND t.seq <= ?2)
	FROM edges e WHERE e.parent_key = ?3 AND e.from_seq <= ?2 AND (e.to_seq IS NULL OR e.to_seq > ?1)`);
const TOUCHED = q("SELECT 1 FROM touch WHERE ancestor_id = ?1 AND seq > ?2 AND seq <= ?3 LIMIT 1");
const RANGE_VERSIONS = q(`SELECT v.block_id, v.from_seq, v.parent_id, v.change_flags
	FROM commits c JOIN versions v ON v.commit_id = c.id
	WHERE c.space_id = ?1 AND c.seq > ?2 AND c.seq <= ?3 LIMIT 20000`);
const PARENT_AT = q(`SELECT parent_key FROM edges INDEXED BY idx_e_block
	WHERE block_id = ?1 AND from_seq <= ?2 AND (to_seq IS NULL OR to_seq > ?2) ORDER BY from_seq DESC LIMIT 1`);
function diff(name: string, size: number, gap: number) {
	const root = meta.get(name);
	if (!root) return;
	const ready = Number(meta.get(`${name}.ready`));
	console.log(`\n-- diff of the ${size}-block subtree between T and T-${gap}`);
	plan("touch span", `SELECT e.block_id, EXISTS (SELECT 1 FROM touch t WHERE t.ancestor_id = e.block_id AND t.seq > ?1 AND t.seq <= ?2) FROM edges e WHERE e.parent_key = ?3 AND e.from_seq <= ?2 AND (e.to_seq IS NULL OR e.to_seq > ?1)`, [1, 2, root]);
	plan("commit range", `SELECT v.block_id FROM commits c JOIN versions v ON v.commit_id = c.id WHERE c.space_id = ?1 AND c.seq > ?2 AND c.seq <= ?3`, [SPACE, 1, 2]);
	const pick = () => {
		const T2 = Math.max(seqAfter(ready), ready + gap + 1);
		return [Math.min(T2, LAST) - gap, Math.min(T2, LAST)] as const;
	};
	const runs = size >= 10_000 ? 15 : 40;
	const two = (read: (T: number) => Row[], idCol: number, seqCol: number | null) => () => {
		const [T1, T2] = pick();
		const a = new Map<string, Row>();
		for (const r of read(T1)) a.set(r[idCol] as string, r);
		let changed = 0;
		const b = read(T2);
		for (const r of b) {
			const old = a.get(r[idCol] as string);
			if (!old) changed++;
			else if (seqCol !== null && old[seqCol] !== r[seqCol]) changed++;
			else if (seqCol === null && (old[1] !== r[1] || old[2] !== r[2])) changed++;
		}
		changed += Math.max(0, a.size - (b.length - changed));
		return `${changed} changed`;
	};
	time(`P  two page reads, compared by id`, runs, two((T) => pStruct.values(root, T, T, size * 2, 0) as Row[], 0, 6));
	time(`A' two reads (edges + version seek), compared by id`, runs, two((T) => eSubtreeMeta.values(root, T, size * 2) as Row[], 0, 5));
	time(`B  descent over edges, skipping untouched subtrees`, runs, () => {
		const [T1, T2] = pick();
		let changed = 0;
		let visited = 0;
		if (TOUCHED.values(root, T1, T2).length === 0) return "0 changed, 1 seek";
		const stack = [root];
		while (stack.length > 0) {
			const node = stack.pop() as string;
			for (const r of E_SPAN.values(T1, T2, node) as Row[]) {
				visited++;
				const from = r[1] as number;
				const to = r[2] as number | null;
				const same = from <= T1 && (to === null || to > T2);
				if (!same || r[4]) changed++;
				// An added or removed subtree would be listed whole here (not counted in this timing).
				if (r[5]) stack.push(r[0] as string);
			}
		}
		return `${changed} changed, ${visited} edges looked at`;
	});
	time(`D  versions of the ${gap} commits, each placed by walking up`, runs, () => {
		const [T1, T2] = pick();
		const rows = RANGE_VERSIONS.values(SPACE, T1, T2) as Row[];
		const inside = new Map<string, boolean>();
		let changed = 0;
		for (const r of rows) {
			let at = r[0] as string;
			const path: string[] = [];
			let hit: boolean | undefined;
			for (let depth = 0; depth < 1000; depth++) {
				if (at === root) hit = true;
				else hit = inside.get(at);
				if (hit !== undefined) break;
				path.push(at);
				const p = PARENT_AT.values(at, T2)[0] as Row | undefined;
				if (!p || p[0] === SPACE) {
					hit = false;
					break;
				}
				at = p[0] as string;
			}
			for (const id of path) inside.set(id, hit === true);
			if (hit) changed++;
		}
		return `${changed} changed of ${rows.length} versions in range`;
	});
}
diff("s2000", 2000, 1000);
diff("s10000", 10_000, 1000);
diff("s100000", 100_000, 1000);

// --- 4. timeline, block history, adjacent-commit delta, aggregates -----------------------------------
{
	console.log("\n-- timeline (newest 50 commits that touched a subtree), block history, one commit's delta");
	for (const name of ["typical", "s2000", "s10000", "s100000"]) {
		const root = meta.get(name);
		if (!root) continue;
		const P_SEQS = `SELECT DISTINCT from_seq FROM versions WHERE page_id = ? AND from_seq < ? AND from_seq > 0 ORDER BY from_seq DESC LIMIT 51`;
		const B_SEQS = `SELECT seq FROM touch WHERE ancestor_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT 51`;
		const B_OWN = `SELECT from_seq FROM versions WHERE block_id = ?1 AND from_seq < ?2 ORDER BY from_seq DESC LIMIT 51`;
		if (name === "typical") {
			plan("P timeline", P_SEQS, [root, 1]);
			plan("B timeline", B_SEQS, [root, 1]);
		}
		const ps = q(P_SEQS);
		const bs = q(B_SEQS);
		const bo = q(B_OWN);
		const ready = Number(meta.get(`${name}.ready`));
		time(`P  timeline of ${name} by (page_id, from_seq)`, 100, () => (ps.values(root, seqAfter(ready)) as Row[]).length);
		time(`B  timeline of ${name} by touch(ancestor, seq) + own versions`, 100, () => {
			const T = seqAfter(ready);
			return (bs.values(root, T) as Row[]).length + (bo.values(root, T) as Row[]).length;
		});
	}
	const anyBlock = q("SELECT id FROM blocks LIMIT 1 OFFSET ?");
	const hist = q("SELECT from_seq, to_seq, commit_id, change_flags, deleted FROM versions WHERE block_id = ? ORDER BY from_seq DESC LIMIT 50");
	time(`=  history of one block (50 versions, all schemes)`, 300, () => {
		const id = (anyBlock.values(Math.floor(rnd() * Math.min(N, 5000)))[0] as Row)[0] as string;
		return (hist.values(id) as Row[]).length;
	});
	const delta = q(`SELECT v.block_id, v.parent_id, v.order_key, v.change_flags, v.deleted, v.content
		FROM commits c JOIN versions v ON v.commit_id = c.id WHERE c.space_id = ? AND c.seq = ?`);
	time(`=  the versions one commit wrote (a timeline step)`, 300, () => (delta.values(SPACE, seqAfter(1)) as Row[]).length);

	console.log("\n-- aggregates under a subtree: tasks in progress, now");
	for (const name of ["s2000", "s10000", "s100000"]) {
		const root = meta.get(name);
		if (!root) continue;
		const size = Number(name.slice(1));
		const walk = q(`WITH RECURSIVE sub(id, doing) AS (SELECT ?1, 0 UNION ALL
				SELECT b.id, json_extract(b.task_json, '$.status') = 'doing'
				FROM sub JOIN blocks b ON b.space_id = ?2 AND b.parent_id = sub.id AND b.deleted = 0)
			SELECT sum(doing) FROM sub`);
		time(`-  walk the ${size}-block subtree and count`, size >= 100_000 ? 5 : 20, () => (walk.values(root, SPACE)[0] as Row)[0] as number);
	}
}

// --- 5. sizes ---------------------------------------------------------------------------------------
if (SIZES) {
	console.log("\n-- storage (dbstat)");
	const rows = db.query("SELECT name, sum(pgsize) bytes, sum(payload) payload FROM dbstat GROUP BY name ORDER BY bytes DESC").all() as Array<{ name: string; bytes: number; payload: number }>;
	const count: Record<string, number> = {
		versions: Number(meta.get("versions")),
		sqlite_autoindex_versions_1: Number(meta.get("versions")),
		idx_v_page: Number(meta.get("versions")),
		idx_v_parent: Number(meta.get("versions")),
		idx_v_commit: Number(meta.get("versions")),
		edges: Number(meta.get("edges")),
		idx_e_block: Number(meta.get("edges")),
		touch: Number(meta.get("touch")),
		commits: LAST,
		blocks: N,
	};
	for (const r of rows) {
		const n = count[r.name];
		const line = `${r.name.padEnd(34)} ${(r.bytes / 1048576).toFixed(1).padStart(9)} MiB${n ? `  ${(r.bytes / n).toFixed(0).padStart(5)} bytes/row` : ""}`;
		console.log(line);
		out.push(line);
	}
}

if (SIZES && N <= 100_000) {
	console.log("\n-- touch rows by the ancestor's depth today (0 = top-level block)");
	const rows = db.query(`WITH RECURSIVE d(id, depth) AS (
			SELECT id, 0 FROM blocks WHERE space_id = ?1 AND parent_id IS NULL
			UNION ALL SELECT b.id, d.depth + 1 FROM d JOIN blocks b ON b.space_id = ?1 AND b.parent_id = d.id)
		SELECT min(depth, 8) dd, (SELECT count(*) FROM touch t WHERE t.ancestor_id = d.id) n FROM d`).values(SPACE) as Row[];
	const by = new Map<number, number>();
	for (const r of rows) by.set(r[0] as number, (by.get(r[0] as number) ?? 0) + (r[1] as number));
	for (const [d, n] of [...by].sort((a, b) => a[0] - b[0])) {
		const line = `depth ${d === 8 ? "8+" : d}: ${n} rows`;
		console.log(line);
		out.push(line);
	}
}

}

// --- 6. moving a subtree to another page --------------------------------------------------------------
if (MOVES) {
	console.log("\n-- move a subtree under a block of another page (committed, WAL, synchronous NORMAL)");
	const target = meta.get("typical") as string;
	const PARENT_AT = q(`SELECT parent_key FROM edges INDEXED BY idx_e_block
		WHERE block_id = ?1 AND from_seq <= ?2 AND (to_seq IS NULL OR to_seq > ?2) ORDER BY from_seq DESC LIMIT 1`);
	let seq = LAST;
	const CHUNK = 500;
	for (const name of ["s2000", "s20000", "s100000", "s10000"]) {
		const root = meta.get(name);
		if (!root) continue;
		const size = Number(name.slice(1));
		// --- A / A' + B: one version row, one edge closed and one opened, the two ancestor chains.
		{
			seq++;
			const cid = `move-A-${name}`.padEnd(21, "0");
			const times: number[] = [];
			let rows = 0;
			for (let rep = 0; rep < 5; rep++) {
				const to = rep % 2 === 0 ? (meta.get("hot") as string) : target;
				const t1 = performance.now();
				rows = 0;
				db.transaction(() => {
					seq++;
					db.query("INSERT INTO commits VALUES (?, ?, ?, 'edit', 'human', 'u', 'u', NULL, NULL, NULL, ?, 'move')").run(`mvA${seq}`.padEnd(21, "0"), SPACE, seq, new Date().toISOString());
					const old = (PARENT_AT.values(root, seq)[0] as Row)[0] as string;
					db.query(`UPDATE versions SET to_seq = ${seq} WHERE block_id = ? AND to_seq IS NULL`).run(root);
					db.query("UPDATE blocks SET parent_id = ?, order_key = ?, version_seq = ? WHERE id = ?").run(to, `zz${rep}`, seq, root);
					db.query(`INSERT INTO versions (block_id, from_seq, to_seq, commit_id, page_id, parent_id, order_key, content, task_json, ask_json, alias, content_hash, change_flags, deleted)
						SELECT id, ${seq}, NULL, ?, page_id, parent_id, order_key, content, task_json, ask_json, alias, content_hash, 4, deleted FROM blocks WHERE id = ?`).run(`mvA${seq}`.padEnd(21, "0"), root);
					db.query(`UPDATE edges SET to_seq = ${seq} WHERE parent_key = ? AND block_id = ? AND to_seq IS NULL`).run(old, root);
					db.query("INSERT INTO edges VALUES (?, ?, ?, NULL, ?)").run(to, root, seq, `zz${rep}`);
					rows += 4;
					for (const start of [old, to]) {
						let at: string | undefined = start;
						for (let d = 0; at && at !== SPACE && d < 1000; d++) {
							db.query("INSERT OR IGNORE INTO touch VALUES (?, ?)").run(at, seq);
							rows++;
							at = (PARENT_AT.values(at, seq)[0] as Row | undefined)?.[0] as string | undefined;
						}
					}
				})();
				times.push(performance.now() - t1);
			}
			const line = `A' move ${String(size).padStart(6)} blocks: ${f(pct(times, 0.5))} ms (max ${f(Math.max(...times))}); ${rows} rows written`;
			console.log(line);
			out.push(line);
		}
	}
	// P is measured without the rows and index only the other schemes keep.
	db.run("DROP INDEX idx_v_parent");
	db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	for (const name of ["s2000", "s20000", "s100000", "s10000"]) {
		const root = meta.get(name);
		if (!root) continue;
		const size = Number(name.slice(1));
		// --- P: every descendant gets a new version row (what write.ts + sqlite-store.ts do).
		{
			const t0 = performance.now();
			const ids = (db.query(`WITH RECURSIVE sub(id) AS (SELECT ?1 UNION ALL
					SELECT b.id FROM sub JOIN blocks b ON b.space_id = ?2 AND b.parent_id = sub.id AND b.deleted = 0)
				SELECT id FROM sub`).values(root, SPACE) as Row[]).map((r) => r[0] as string);
			const tPlan = performance.now() - t0;
			seq++;
			const cid = `mvP${seq}`.padEnd(21, "0");
			let rowsWritten = 0;
			const t1 = performance.now();
			db.transaction(() => {
				db.query("INSERT INTO commits VALUES (?, ?, ?, 'edit', 'human', 'u', 'u', NULL, NULL, NULL, ?, 'move')").run(cid, SPACE, seq, new Date().toISOString());
				for (let i = 0; i < ids.length; i += CHUNK) {
					const chunk = ids.slice(i, i + CHUNK);
					const list = chunk.map(() => "?").join(",");
					db.query(`UPDATE versions SET to_seq = ${seq} WHERE block_id IN (${list}) AND to_seq IS NULL`).run(...chunk);
					db.query(`UPDATE blocks SET page_id = ?, version_seq = ${seq} WHERE id IN (${list})`).run(target, ...chunk);
					db.query(`INSERT INTO versions (block_id, from_seq, to_seq, commit_id, page_id, parent_id, order_key, content, task_json, ask_json, alias, content_hash, change_flags, deleted)
						SELECT id, ${seq}, NULL, ?, page_id, parent_id, order_key, content, task_json, ask_json, alias, content_hash, 64, deleted FROM blocks WHERE id IN (${list})`).run(cid, ...chunk);
					rowsWritten += chunk.length;
				}
				db.query("UPDATE blocks SET parent_id = ?, order_key = 'zz1' WHERE id = ?").run(target, root);
				db.query(`UPDATE versions SET parent_id = ?, order_key = 'zz1', change_flags = 68 WHERE block_id = ? AND from_seq = ${seq}`).run(target, root);
			})();
			const tWrite = performance.now() - t1;
			const line = `P  move ${String(size).padStart(6)} blocks: collect ${f(tPlan)} ms + write ${f(tWrite)} ms; ${rowsWritten} version rows, ${rowsWritten} rows closed, ${rowsWritten} block rows`;
			console.log(line);
			out.push(line);
		}
	}
}
db.close();
