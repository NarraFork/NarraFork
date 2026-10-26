/**
 * Cold-cache variant of the point-in-time reads: before every query the OS page cache for the
 * database files is dropped for that file only (dd iflag=nocache => posix_fadvise DONTNEED) and the
 * database cache is emptied (SQLite: new connection; PostgreSQL: run the cluster with a tiny
 * shared_buffers, see README). This is what "open an old time point after a restart" costs.
 *
 * Run: bun time-travel/cold.ts --dialect=sqlite|pg --dir=<datadir> [--db=ob10] [--variants=B3,B5,A2,C] [--n=40]
 *        [--pgdata=<cluster dir>]
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Db, openPg, openSqlite } from "./db";
import { arg, argNum, DATA_ROOT, fmt, Rng, summarize } from "./lib";
import {
	pageAt,
	structureAt,
	VARIANTS,
	type VariantDef,
	type VariantId,
	viewport,
	viewportTwoStep,
} from "./queries";

const dialect = (arg("dialect") ?? "sqlite") as "sqlite" | "pg";
const dir = arg("dir") ?? join(DATA_ROOT, "tt-vpb10");
const dbName = arg("db") ?? "ob10";
const N = argNum("n", 40);
const variantIds = (arg("variants") ?? "B3,B5,A2,C").split(",") as VariantId[];
const pgdata =
	arg("pgdata") ??
	"/tmp/claude-0/-home-user-NarraFork/13582635-c8be-5e3d-9f41-f14f8cb5ad58/scratchpad/pgbench/data";
const label = arg("label") ?? `${dialect}-cold`;

interface PageMeta {
	id: string;
	spaceIdx: number;
	size: number;
}
const meta = JSON.parse(await Bun.file(join(dir, "meta.json")).text()) as {
	pages: PageMeta[];
	spaceMaxSeq: number[];
};
const pages = meta.pages.filter((p) => p.size <= 2000);

let evictCmd: string;
async function setupEvict() {
	if (dialect === "sqlite") {
		evictCmd = `for f in ${join(dir, "bench.db")} ${join(dir, "bench.db-wal")}; do [ -f "$f" ] && dd if="$f" iflag=nocache count=0 status=none; done; true`;
	} else {
		const admin = openPg(dbName);
		const oid = (
			await admin.all("SELECT oid FROM pg_database WHERE datname = current_database()")
		)[0]?.oid;
		await admin.close();
		evictCmd = `find ${pgdata}/base/${oid} -type f -print0 | xargs -0 -P4 -I{} dd if={} iflag=nocache count=0 status=none; true`;
	}
}
function evict() {
	Bun.spawnSync(["sh", "-c", evictCmd]);
}

async function openDb(): Promise<Db> {
	return dialect === "sqlite" ? openSqlite(join(dir, "bench.db")) : openPg(dbName);
}

const out: Record<string, unknown>[] = [];
await setupEvict();
let db = await openDb();

for (const id of variantIds) {
	const def = VARIANTS[id] as VariantDef;
	const ddls = def.ddl[dialect];
	if (!ddls) continue;
	for (const n of def.drop) await db.exec(`DROP INDEX IF EXISTS ${n}`);
	for (const d of ddls) await db.exec(d);
	if (dialect === "pg")
		await db.exec("ANALYZE outline_block_versions; ANALYZE outline_page_members");
	console.log(`\n== ${label}: ${def.title}`);
	const rng = new Rng(4242);
	const samples = Array.from({ length: N }, () => {
		const page = pages[rng.int(pages.length)] as PageMeta;
		const max = meta.spaceMaxSeq[page.spaceIdx] as number;
		return { page, t: Math.floor(max * (0.1 + 0.9 * rng.rnd())) };
	});
	const tests: [string, (s: (typeof samples)[number]) => Promise<unknown>][] = [
		["Q2 page@T", (s) => pageAt(db, def, s.page.id, s.t)],
	];
	if (def.id === "B5") {
		tests.push(["Q2s structure only", (s) => structureAt(db, def, s.page.id, s.t)]);
		tests.push(["Q1 vp500 two-step", (s) => viewportTwoStep(db, def, s.page.id, s.t)]);
	} else if (def.approach === "parent") {
		tests.push(["Q1 vp500 native", (s) => viewport(db, def, s.page.id, s.t, "native")]);
	} else {
		tests.push(["Q1 vp500 read+js-order", (s) => viewport(db, def, s.page.id, s.t, "fullsort")]);
	}
	for (const [name, fn] of tests) {
		const cold: number[] = [];
		const warm: number[] = [];
		for (const s of samples) {
			if (dialect === "sqlite") {
				await db.close();
				evict();
				db = await openDb();
			} else evict();
			let t0 = performance.now();
			await fn(s);
			cold.push(performance.now() - t0);
			t0 = performance.now();
			await fn(s);
			warm.push(performance.now() - t0);
		}
		const c = summarize(cold);
		const w = summarize(warm);
		console.log(
			`  ${def.id.padEnd(3)} ${name.padEnd(22)} cold p50 ${fmt(c.p50).padStart(8)} p95 ${fmt(c.p95).padStart(8)} max ${fmt(c.max).padStart(8)} ms | same query again: p50 ${fmt(w.p50).padStart(7)} p95 ${fmt(w.p95).padStart(7)}`,
		);
		out.push({ variant: def.id, query: name, cold: c, warm: w });
	}
	for (const n of def.drop) await db.exec(`DROP INDEX IF EXISTS ${n}`);
}
await db.close();
mkdirSync(join(import.meta.dir, "..", "results"), { recursive: true });
await Bun.write(
	join(import.meta.dir, "..", "results", `tt-${label}.json`),
	JSON.stringify({ label, n: N, results: out }, null, 1),
);
