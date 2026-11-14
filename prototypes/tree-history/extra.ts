/**
 * Two more measurements on a gen.ts space (run on a COPY: the second one writes):
 *   1. a budgeted read: the first 800 blocks of a large subtree, breadth first (current and as of T);
 *   2. what an ordinary one-block content commit costs with and without the touch rows.
 * Usage: bun extra.ts <copy.db>
 */
import { Database } from "bun:sqlite";
const db = new Database(process.argv[2] as string);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA synchronous = NORMAL");
db.run("PRAGMA cache_size = -16000");
db.run("PRAGMA mmap_size = 268435456");
const meta = new Map((db.query("SELECT k, v FROM meta").all() as Array<{ k: string; v: string }>).map((r) => [r.k, r.v]));
const SPACE = meta.get("space") as string;
const LAST = Number(meta.get("lastSeq"));
let s = 5;
const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] as number;
function time(name: string, runs: number, fn: () => unknown) {
	for (let i = 0; i < 3; i++) fn();
	const t: number[] = [];
	let note: unknown;
	for (let i = 0; i < runs; i++) {
		const t0 = performance.now();
		note = fn();
		t.push(performance.now() - t0);
	}
	console.log(`${name.padEnd(64)} p50 ${pct(t, 0.5).toFixed(2).padStart(7)}  p95 ${pct(t, 0.95).toFixed(2).padStart(7)}  max ${Math.max(...t).toFixed(2).padStart(7)} ms  ${note}`);
}
const cur = db.query(`WITH RECURSIVE sub(id, sid, parent_id, order_key, alias, task_json, version_seq) AS (
		SELECT id, sid, parent_id, order_key, alias, task_json, version_seq FROM blocks WHERE id = ?1
		UNION ALL
		SELECT b.id, b.sid, b.parent_id, b.order_key, b.alias, b.task_json, b.version_seq
		FROM sub JOIN blocks b ON b.space_id = ?2 AND b.parent_id = sub.id AND b.deleted = 0)
	SELECT * FROM sub LIMIT 800`);
const asOf = db.query(`WITH RECURSIVE sub(id, parent_id, order_key) AS (
		SELECT ?1, NULL, ''
		UNION ALL
		SELECT e.block_id, e.parent_key, e.order_key
		FROM sub JOIN edges e ON e.parent_key = sub.id AND e.from_seq <= ?2 AND (e.to_seq IS NULL OR e.to_seq > ?2))
	SELECT sub.id, sub.parent_id, sub.order_key, v.alias, v.task_json, v.from_seq, v.content
	FROM (SELECT * FROM sub LIMIT 800) sub CROSS JOIN versions v ON v.block_id = sub.id
		AND v.from_seq = (SELECT max(x.from_seq) FROM versions x WHERE x.block_id = sub.id AND x.from_seq <= ?2)`);
for (const name of ["s2000", "s10000", "s20000", "s100000"]) {
	const root = meta.get(name);
	if (!root) continue;
	const ready = Number(meta.get(`${name}.ready`));
	time(`first 800 blocks of ${name}, current, breadth first`, 40, () => (cur.values(root, SPACE) as unknown[]).length);
	time(`first 800 blocks of ${name}, as of T, with content`, 40, () => {
		const T = Math.max(ready, Math.floor(LAST / 2)) + Math.floor(rnd() * (LAST - Math.max(ready, Math.floor(LAST / 2))));
		return (asOf.values(root, T) as unknown[]).length;
	});
}

// --- 2. one-block content commits -------------------------------------------------------------------
const ids = (db.query("SELECT id FROM blocks WHERE deleted = 0 ORDER BY sid LIMIT 4000 OFFSET 2000").values() as string[][]).map((r) => r[0] as string);
const close = db.query("UPDATE versions SET to_seq = ?1 WHERE block_id = ?2 AND to_seq IS NULL");
const upd = db.query("UPDATE blocks SET content = ?1, content_hash = ?2, version_seq = ?3 WHERE id = ?4");
const ins = db.query(`INSERT INTO versions (block_id, from_seq, to_seq, commit_id, page_id, parent_id, order_key, content, task_json, ask_json, alias, content_hash, change_flags, deleted)
	SELECT id, ?1, NULL, ?2, page_id, parent_id, order_key, content, task_json, ask_json, alias, content_hash, 2, deleted FROM blocks WHERE id = ?3`);
const commit = db.query("INSERT INTO commits VALUES (?, ?, ?, 'edit', 'human', 'u', 'u', NULL, NULL, NULL, ?, 'edit')");
const par = db.query("SELECT parent_id FROM blocks WHERE id = ?");
const touch = db.query("INSERT OR IGNORE INTO touch VALUES (?, ?)");
let seq = LAST + 10;
function run(label: string, withTouch: boolean) {
	const t: number[] = [];
	let rows = 0;
	for (let i = 0; i < 1500; i++) {
		const id = ids[Math.floor(rnd() * ids.length)] as string;
		const t0 = performance.now();
		db.transaction(() => {
			seq++;
			const cid = `c${seq}`.padEnd(21, "x");
			commit.run(cid, SPACE, seq, "2026-11-14T00:00:00.000Z");
			close.run(seq, id);
			upd.run(`edited text of the block at ${seq} with some more words to make a line`, `${seq}`.padStart(64, "0"), seq, id);
			ins.run(seq, cid, id);
			if (withTouch) {
				let at = (par.get(id) as { parent_id: string | null }).parent_id;
				while (at) {
					touch.run(at, seq);
					rows++;
					at = (par.get(at) as { parent_id: string | null }).parent_id;
				}
			}
		})();
		t.push(performance.now() - t0);
	}
	console.log(`${label.padEnd(64)} p50 ${pct(t, 0.5).toFixed(3).padStart(7)}  p95 ${pct(t, 0.95).toFixed(3).padStart(7)} ms  (${(rows / 1500).toFixed(1)} touch rows per commit)`);
}
run("one-block content commit, today's rows", false);
run("one-block content commit, + touch rows for the ancestors", true);
run("one-block content commit, today's rows (again)", false);
run("one-block content commit, + touch rows (again)", true);
