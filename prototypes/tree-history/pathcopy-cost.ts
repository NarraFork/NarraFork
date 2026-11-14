/**
 * What ONE single-block edit would write under a path-copying (persistent, content-addressed)
 * tree, estimated on the current tree of a gen.ts space. A node holds its content hash and the
 * ordered list of its children's hashes (33 bytes each + 60 bytes of node overhead), so an edit
 * rewrites the block's node and every ancestor's child list, up to and including the space root.
 * Two variants: child lists stored whole; child lists stored as chunked (prolly-style) sequences
 * of ~128 entries, where one changed entry rewrites one leaf chunk plus one chunk per level above.
 * Usage: bun pathcopy-cost.ts <space.db>
 */
import { Database } from "bun:sqlite";
const db = new Database(process.argv[2] ?? "space-10k.db", { readonly: true });
const space = (db.query("SELECT v FROM meta WHERE k='space'").get() as { v: string }).v;
const n = Number((db.query("SELECT v FROM meta WHERE k='blocks'").get() as { v: string }).v);
const parentOf = db.query("SELECT parent_id FROM blocks WHERE id = ?");
const kids = db.query("SELECT count(*) c FROM blocks WHERE space_id = ? AND parent_id IS ? AND deleted = 0");
const pick = db.query("SELECT block_id FROM versions WHERE rowid = ?");
const maxRow = (db.query("SELECT max(rowid) m FROM versions").get() as { m: number }).m;
let s = 99;
const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const whole: number[] = [];
const chunked: number[] = [];
const nodes: number[] = [];
const ENTRY = 33;
const NODE = 60;
const CHUNK = 128;
for (let i = 0; i < 3000; i++) {
	const row = pick.get(1 + Math.floor(rnd() * maxRow)) as { block_id: string } | null;
	if (!row) continue;
	let w = NODE + 200; // the block's own node, with its content
	let c = NODE + 200;
	let count = 1;
	let at: string | null = row.block_id;
	while (true) {
		const p = (parentOf.get(at) as { parent_id: string | null } | null)?.parent_id ?? null;
		const f = (kids.get(space, p) as { c: number }).c;
		w += NODE + f * ENTRY;
		const levels = Math.max(1, Math.ceil(Math.log(Math.max(f, 2)) / Math.log(CHUNK)));
		c += NODE + levels * Math.min(f, CHUNK) * ENTRY;
		count += 1;
		if (p === null) break;
		at = p;
	}
	whole.push(w);
	chunked.push(c);
	nodes.push(count);
}
const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * xs.length)] as number;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`${process.argv[2]}: ${n} blocks, sample of ${whole.length} edited blocks`);
console.log(`nodes rewritten per edit: mean ${mean(nodes).toFixed(1)}  p95 ${q(nodes, 0.95)}  max ${Math.max(...nodes)}`);
console.log(`bytes written, child lists whole:   mean ${mean(whole).toFixed(0)}  p50 ${q(whole, 0.5)}  p95 ${q(whole, 0.95)}`);
console.log(`bytes written, child lists chunked: mean ${mean(chunked).toFixed(0)}  p50 ${q(chunked, 0.5)}  p95 ${q(chunked, 0.95)}`);
