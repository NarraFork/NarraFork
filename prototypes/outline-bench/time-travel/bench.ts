/**
 * Point-in-time read benchmark driver.
 *
 * Run: bun time-travel/bench.ts --dialect=sqlite|pg --dir=<datadir> [--db=ob10] [--variants=A1,A2,B1,B2,B3,C]
 *        [--n=300] [--sqlite-cache=prod|big] [--out=results/xxx.json] [--no-write]
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Db, openPg, openSqlite, type Row, SQLITE_BIG, SQLITE_PROD } from "./db";
import { arg, argNum, DATA_ROOT, fmt, Rng, type Summary, summarize } from "./lib";
import {
	changesBetween,
	commitList,
	pageAt,
	pageAtSql,
	structureAt,
	treeOrder,
	VARIANTS,
	type VariantDef,
	type VariantId,
	viewport,
	viewportTwoStep,
} from "./queries";

interface PageMeta {
	id: string;
	space: string;
	spaceIdx: number;
	size: number;
	idx: number;
}
interface Meta {
	params: { vpb: number };
	info: { versions: number; commits: number; blocks: number };
	pages: PageMeta[];
	spaceIds: string[];
	spaceMaxSeq: number[];
}

interface Result {
	dialect: string;
	variant: string;
	query: string;
	scope: string;
	bucket: string;
	rows: number;
	summary: Summary;
}

const dialect = (arg("dialect") ?? "sqlite") as "sqlite" | "pg";
const dir = arg("dir") ?? join(DATA_ROOT, "tt-vpb10");
const dbName = arg("db") ?? "ob10";
const N = argNum("n", 300);
const variantIds = (arg("variants") ?? "A1,A2,B1,B2,B3,C").split(",") as VariantId[];
const tuningName = arg("sqlite-cache") ?? "prod";
const doWrite = arg("no-write") === undefined;
const onlyWrite = arg("only-write") !== undefined;
const label = arg("label") ?? `${dialect}${dialect === "sqlite" ? `-${tuningName}` : ""}`;
const outPath = arg("out") ?? join(import.meta.dir, "..", "results", `tt-${label}.json`);

const meta = JSON.parse(await Bun.file(join(dir, "meta.json")).text()) as Meta;
const results: Result[] = [];
const plans: Record<string, string> = {};
const verifyHashes: Record<string, Record<string, string[]>> = {};

const db: Db =
	dialect === "sqlite"
		? openSqlite(join(dir, "bench.db"), tuningName === "big" ? SQLITE_BIG : SQLITE_PROD)
		: openPg(dbName);

// -------------------------------------------------------------------------------------------------
// setup

async function setupBase() {
	if (dialect !== "sqlite") return;
	const have = new Set(
		(await db.all("SELECT name FROM sqlite_master WHERE type='index'")).map((r) => r.name),
	);
	const base = [
		[
			"pk_versions",
			"CREATE UNIQUE INDEX pk_versions ON outline_block_versions (block_id, from_seq)",
		],
		["v_commit", "CREATE INDEX v_commit ON outline_block_versions (commit_id)"],
		["pk_commits", "CREATE UNIQUE INDEX pk_commits ON outline_commits (id)"],
		["c_space_seq", "CREATE UNIQUE INDEX c_space_seq ON outline_commits (space_id, seq)"],
		["pk_blocks", "CREATE UNIQUE INDEX pk_blocks ON outline_blocks (id)"],
	];
	for (const [name, ddl] of base) {
		if (!have.has(name as string)) {
			const t0 = performance.now();
			await db.exec(ddl as string);
			console.log(`  built ${name} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
		}
	}
}

async function createVariant(def: VariantDef) {
	const ddls = def.ddl[dialect];
	if (!ddls) return false;
	await dropVariant(def);
	for (const ddl of ddls) {
		const t0 = performance.now();
		await db.exec(ddl);
		console.log(`  ${ddl.slice(0, 90)}  (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
	}
	if (dialect === "pg")
		await db.exec("ANALYZE outline_block_versions; ANALYZE outline_page_members");
	return true;
}

async function dropVariant(def: VariantDef) {
	for (const n of def.drop) await db.exec(`DROP INDEX IF EXISTS ${n}`);
}

async function indexSizes(): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	if (dialect === "sqlite") {
		const rows = await db.all("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name");
		for (const r of rows) out[r.name] = Number(r.bytes);
	} else {
		const rows = await db.all(
			"SELECT c.relname AS name, pg_relation_size(c.oid) AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','i')",
		);
		for (const r of rows) out[r.name] = Number(r.bytes);
		const toast = await db.all(
			"SELECT pg_total_relation_size('outline_block_versions') - pg_relation_size('outline_block_versions') - pg_indexes_size('outline_block_versions') AS toast",
		);
		out.outline_block_versions_toast = Number(toast[0]?.toast ?? 0);
	}
	return out;
}

// -------------------------------------------------------------------------------------------------
// samples

interface Sample {
	page: PageMeta;
	t: number;
	bucket: "early" | "mid" | "late";
}

function makeSamples(pages: PageMeta[], n: number, seed: number): Sample[] {
	const rng = new Rng(seed);
	const out: Sample[] = [];
	const buckets: [Sample["bucket"], number, number][] = [
		["early", 0.02, 0.3],
		["mid", 0.3, 0.7],
		["late", 0.7, 1.0],
	];
	for (let i = 0; i < n; i++) {
		const [bucket, lo, hi] = buckets[i % 3] as (typeof buckets)[number];
		const page = pages[rng.int(pages.length)] as PageMeta;
		const max = meta.spaceMaxSeq[page.spaceIdx] as number;
		const t = Math.max(12, Math.floor(max * (lo + rng.rnd() * (hi - lo))));
		out.push({ page, t, bucket });
	}
	return out;
}

const normalPages = meta.pages.filter((p) => p.size <= 2000);
const giantPages = meta.pages.filter((p) => p.size > 2000);

// -------------------------------------------------------------------------------------------------
// measuring

async function measure<T>(
	variant: string,
	query: string,
	scope: string,
	samples: Sample[],
	run: (s: Sample) => Promise<T>,
	count: (r: T) => number,
	opts: { warmup?: number; verify?: (r: T) => string } = {},
) {
	const warm = opts.warmup ?? 12;
	for (let i = 0; i < Math.min(warm, samples.length); i++)
		await run(samples[samples.length - 1 - i] as Sample);
	const all: number[] = [];
	const by: Record<string, number[]> = { early: [], mid: [], late: [] };
	const rowCounts: number[] = [];
	for (let i = 0; i < samples.length; i++) {
		const s = samples[i] as Sample;
		const t0 = performance.now();
		const r = await run(s);
		const dt = performance.now() - t0;
		all.push(dt);
		by[s.bucket]?.push(dt);
		rowCounts.push(count(r));
		if (opts.verify && i < 60) {
			const key = `${scope}:${query}`;
			const perVariant = verifyHashes[key] ?? {};
			verifyHashes[key] = perVariant;
			const list = perVariant[variant] ?? [];
			perVariant[variant] = list;
			list[i] = opts.verify(r);
		}
	}
	rowCounts.sort((a, b) => a - b);
	const medRows = rowCounts[Math.floor(rowCounts.length / 2)] ?? 0;
	const sum = summarize(all);
	results.push({
		dialect: label,
		variant,
		query,
		scope,
		bucket: "all",
		rows: medRows,
		summary: sum,
	});
	for (const b of ["early", "mid", "late"]) {
		if (by[b]?.length)
			results.push({
				dialect: label,
				variant,
				query,
				scope,
				bucket: b,
				rows: medRows,
				summary: summarize(by[b] as number[]),
			});
	}
	console.log(
		`  ${variant.padEnd(4)} ${query.padEnd(22)} ${scope.padEnd(8)} rows~${String(medRows).padStart(5)}  p50 ${fmt(sum.p50).padStart(8)}  p95 ${fmt(sum.p95).padStart(8)}  p99 ${fmt(sum.p99).padStart(8)}  max ${fmt(sum.max).padStart(8)} ms`,
	);
	return sum;
}

function keyHash(rows: Row[]): string {
	const keys = rows.map((r) => `${r.block_id}:${r.from_seq}`).sort();
	return Bun.hash(keys.join("|")).toString(16);
}

async function explainOnce(name: string, sql: string, params: unknown[]) {
	try {
		if (dialect === "sqlite") {
			const rows = await db.once(`EXPLAIN QUERY PLAN ${sql}`, params);
			plans[name] = rows.map((r) => `${"  ".repeat(Math.max(0, 0))}${r.detail}`).join("\n");
		} else {
			const rows = await db.once(
				`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${sql}`,
				params,
			);
			plans[name] = rows.map((r) => r["QUERY PLAN"]).join("\n");
		}
	} catch (e) {
		plans[name] = `explain failed: ${String(e)}`;
	}
}

// page -> sorted list of seqs at which the page was touched (for picking meaningful Q3 windows)
const pageSeqs = new Map<string, number[]>();
async function loadPageSeqs() {
	const rows = await db.all(
		"SELECT page_id, from_seq FROM outline_block_versions GROUP BY page_id, from_seq",
	);
	for (const r of rows) {
		const a = pageSeqs.get(r.page_id) ?? [];
		pageSeqs.set(r.page_id, a);
		a.push(Number(r.from_seq));
	}
	for (const a of pageSeqs.values()) a.sort((x, y) => x - y);
}

// -------------------------------------------------------------------------------------------------
// query suites

async function runVariant(def: VariantDef) {
	console.log(`\n== ${label}: ${def.title}`);
	if (!(await createVariant(def))) {
		console.log("  (not available on this dialect)");
		return;
	}
	const v = def.id;
	if (onlyWrite) {
		await writeBench(def);
		await dropVariant(def);
		return;
	}
	const samples = makeSamples(normalPages, N, 7);
	const giantSamples = giantPages.length
		? makeSamples(giantPages, Math.max(60, Math.floor(N / 3)), 11)
		: [];
	const probe = samples[0] as Sample;
	await explainOnce(`${label}/${v}/page2000`, pageAtSql(dialect, def), [probe.page.id, probe.t]);

	// Q2 whole page
	await measure(
		v,
		"Q2 page@T",
		"p2000",
		samples,
		(s) => pageAt(db, def, s.page.id, s.t),
		(r) => r.length,
		{ verify: keyHash },
	);
	if (giantSamples.length)
		await measure(
			v,
			"Q2 page@T",
			"p10000",
			giantSamples,
			(s) => pageAt(db, def, s.page.id, s.t),
			(r) => r.length,
		);
	if (def.approach === "page" && def.id === "B3")
		await measure(
			v,
			"Q2 page@T no-content",
			"p2000",
			samples,
			(s) => pageAt(db, def, s.page.id, s.t, { noContent: true }),
			(r) => r.length,
		);

	// Q1 viewport (500)
	if (def.approach === "parent") {
		await measure(
			v,
			`Q1 vp500 native-${dialect === "sqlite" ? "dfs" : "bfs"}`,
			"p2000",
			samples,
			(s) => viewport(db, def, s.page.id, s.t, "native"),
			(r) => r.length,
		);
		if (giantSamples.length)
			await measure(
				v,
				`Q1 vp500 native-${dialect === "sqlite" ? "dfs" : "bfs"}`,
				"p10000",
				giantSamples,
				(s) => viewport(db, def, s.page.id, s.t, "native"),
				(r) => r.length,
			);
		if (dialect === "pg")
			await measure(
				v,
				"Q1 vp500 dfs-sort",
				"p2000",
				samples,
				(s) => viewport(db, def, s.page.id, s.t, "fullsort"),
				(r) => r.length,
			);
		else
			await measure(
				v,
				"Q1 vp500 read+js-order",
				"p2000",
				samples,
				async (s) => {
					const rows = await pageAt(db, def, s.page.id, s.t);
					return treeOrder(rows, 500);
				},
				(r) => r.length,
			);
	} else {
		await measure(
			v,
			"Q1 vp500 read+js-order",
			"p2000",
			samples,
			(s) => viewport(db, def, s.page.id, s.t, "fullsort"),
			(r) => r.length,
		);
		if (giantSamples.length)
			await measure(
				v,
				"Q1 vp500 read+js-order",
				"p10000",
				giantSamples,
				(s) => viewport(db, def, s.page.id, s.t, "fullsort"),
				(r) => r.length,
			);
	}

	if (def.id === "B5") {
		await measure(
			v,
			"Q2s structure only",
			"p2000",
			samples,
			(s) => structureAt(db, def, s.page.id, s.t),
			(r) => r.length,
		);
		await measure(
			v,
			"Q1 vp500 two-step",
			"p2000",
			samples,
			(s) => viewportTwoStep(db, def, s.page.id, s.t),
			(r) => r.length,
		);
		if (giantSamples.length) {
			await measure(
				v,
				"Q2s structure only",
				"p10000",
				giantSamples,
				(s) => structureAt(db, def, s.page.id, s.t),
				(r) => r.length,
			);
			await measure(
				v,
				"Q1 vp500 two-step",
				"p10000",
				giantSamples,
				(s) => viewportTwoStep(db, def, s.page.id, s.t),
				(r) => r.length,
			);
		}
	}

	// Q3 changes between two time points
	for (const W of [1, 100, 5000]) {
		const rng = new Rng(100 + W);
		const q3: Sample[] = [];
		for (let i = 0; i < Math.max(90, Math.floor(N / 2)); i++) {
			const page = normalPages[rng.int(normalPages.length)] as PageMeta;
			const seqs = pageSeqs.get(page.id) ?? [];
			// start right before a commit that touched this page, so the window is never empty
			const base = seqs[12 + rng.int(Math.max(1, seqs.length - 14))] ?? 20;
			q3.push({
				page,
				t: Math.max(1, base - 1),
				bucket: (["early", "mid", "late"] as const)[i % 3] as Sample["bucket"],
			});
		}
		const modes: ("flags" | "join")[] = def.approach === "page" ? ["flags", "join"] : ["flags"];
		for (const mode of modes) {
			const name = `Q3 diff W=${W}${def.approach === "page" ? ` ${mode}` : ""}`;
			await measure(
				v,
				name,
				"p2000",
				q3,
				(s) => changesBetween(db, def, s.page.id, s.t, s.t + W, mode),
				(r) => r.rows.length,
				{ warmup: 8 },
			);
		}
	}

	// Q4 page-filtered commit list
	if (def.approach === "page") {
		const rng = new Rng(55);
		const q4: Sample[] = [];
		for (let i = 0; i < Math.max(90, Math.floor(N / 2)); i++) {
			const page = normalPages[rng.int(normalPages.length)] as PageMeta;
			q4.push({
				page,
				t: Math.floor((meta.spaceMaxSeq[page.spaceIdx] as number) * (0.3 + 0.7 * rng.rnd())),
				bucket: "mid",
			});
		}
		await measure(
			v,
			"Q4d commits of page",
			"200/page",
			q4,
			(s) => commitList(db, "page", { space: s.page.space, cursor: s.t, page: s.page.id }),
			(r) => r.length,
		);
	}

	// write cost with this index set
	if (doWrite) await writeBench(def);
	await dropVariant(def);
}

async function suiteBase() {
	console.log(`\n== ${label}: Q4 commit list (base indexes)`);
	const rng = new Rng(77);
	const picks: { space: string; cursor: number; narrator: string }[] = [];
	const nar = await db.all(
		"SELECT space_id, narrator_id FROM outline_commits WHERE narrator_id IS NOT NULL LIMIT 3000",
	);
	for (let i = 0; i < Math.max(90, Math.floor(N / 2)); i++) {
		const si = rng.int(meta.spaceIds.length);
		const max = meta.spaceMaxSeq[si] as number;
		const cand = nar.filter((r) => r.space_id === meta.spaceIds[si]);
		picks.push({
			space: meta.spaceIds[si] as string,
			cursor: Math.floor(max * (0.1 + 0.9 * rng.rnd())),
			narrator: (cand[rng.int(cand.length)]?.narrator_id as string) ?? "x",
		});
	}
	const fake = picks.map((p) => ({
		page: { id: p.space } as PageMeta,
		t: p.cursor,
		bucket: "mid" as const,
		p,
	}));
	await measure(
		"-",
		"Q4a commits (space)",
		"200/page",
		fake as unknown as Sample[],
		(s) => commitList(db, "all", (s as unknown as { p: (typeof picks)[number] }).p),
		(r) => r.length,
	);
	await measure(
		"-",
		"Q4b commits agent only",
		"200/page",
		fake as unknown as Sample[],
		(s) => commitList(db, "agent", (s as unknown as { p: (typeof picks)[number] }).p),
		(r) => r.length,
	);
	await db.exec(
		"CREATE INDEX IF NOT EXISTS c_space_narr ON outline_commits (space_id, narrator_id, seq)",
	);
	if (dialect === "pg") await db.exec("ANALYZE outline_commits");
	await measure(
		"-",
		"Q4c commits narrator",
		"200/page",
		fake as unknown as Sample[],
		(s) => commitList(db, "narrator", (s as unknown as { p: (typeof picks)[number] }).p),
		(r) => r.length,
	);
	await db.exec("DROP INDEX IF EXISTS c_space_narr");
}

// -------------------------------------------------------------------------------------------------
// write cost: single-block edit commit, 200-op batch commit (append a version, close the old one)

async function writeBench(def: VariantDef) {
	const blocks = await db.all(
		"SELECT id, space_id, page_id, parent_id, order_key, version_seq FROM outline_blocks WHERE deleted = 0 LIMIT 5000",
	);
	const rng = new Rng(900 + def.id.charCodeAt(0));
	const sp = meta.spaceIds[0] as string;
	const spBlocks = blocks.filter((b) => b.space_id === sp);
	const ph = (i: number) => (dialect === "sqlite" ? `?${i}` : `$${i}`);
	const spaceMax = await db.all(
		`SELECT MAX(seq) AS m FROM outline_commits WHERE space_id = ${ph(1)}`,
		[sp],
	);
	let seq = Number(spaceMax[0]?.m) + 1;
	const content = "x".repeat(300);
	const doCommit = async (k: number) => {
		const seqNow = seq++;
		const cid = `w${seqNow}_${rng.int(1e9)}`.padEnd(21, "_");
		await db.tx(async (q) => {
			await q(
				`INSERT INTO outline_commits (id, space_id, seq, kind, actor_kind, actor_id, responsible_user_id, narrator_id, message_id, tool_call_id, visible, created_at, summary) VALUES (${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(ph).join(",")})`,
				[cid, sp, seqNow, "edit", "agent", "a", "u", "n", null, null, 1, Date.now(), `bench ${k}`],
			);
			for (let i = 0; i < k; i++) {
				const b = spBlocks[rng.int(spBlocks.length)] as Row;
				const cur = await q(`SELECT version_seq FROM outline_blocks WHERE id = ${ph(1)}`, [b.id]);
				const prevSeq = Number(cur[0]?.version_seq);
				if (prevSeq >= seqNow) continue;
				await q(
					`UPDATE outline_block_versions SET to_seq = ${ph(1)}, to_max = ${ph(1)} WHERE block_id = ${ph(2)} AND from_seq = ${ph(3)}`,
					[seqNow, b.id, prevSeq],
				);
				await q(
					`INSERT INTO outline_block_versions (block_id, from_seq, to_seq, to_max, commit_id, page_id, parent_id, order_key, content, task_json, invalid_reason, content_hash, deleted, redacted, change_flags) VALUES (${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(ph).join(",")})`,
					[
						b.id,
						seqNow,
						null,
						Number.MAX_SAFE_INTEGER,
						cid,
						b.page_id,
						b.parent_id,
						b.order_key,
						content,
						null,
						null,
						"deadbeef",
						0,
						0,
						2,
					],
				);
				await q(
					`UPDATE outline_blocks SET content = ${ph(1)}, version_seq = ${ph(2)} WHERE id = ${ph(3)}`,
					[content, seqNow, b.id],
				);
			}
		});
	};
	const single: number[] = [];
	await db.exec(dialect === "sqlite" ? "PRAGMA wal_checkpoint(TRUNCATE)" : "CHECKPOINT");
	for (let i = 0; i < 30; i++) await doCommit(1);
	for (let i = 0; i < 6; i++) await doCommit(200);
	for (let i = 0; i < 400; i++) {
		const t0 = performance.now();
		await doCommit(1);
		single.push(performance.now() - t0);
	}
	const batch: number[] = [];
	for (let i = 0; i < 30; i++) {
		const t0 = performance.now();
		await doCommit(200);
		batch.push(performance.now() - t0);
	}
	for (const [name, s] of [
		["W1 commit 1 block", single],
		["W2 commit 200 blocks", batch],
	] as const) {
		const sum = summarize(s);
		results.push({
			dialect: label,
			variant: def.id,
			query: name,
			scope: "write",
			bucket: "all",
			rows: name.includes("200") ? 200 : 1,
			summary: sum,
		});
		console.log(
			`  ${def.id.padEnd(4)} ${name.padEnd(22)} write    p50 ${fmt(sum.p50).padStart(8)}  p95 ${fmt(sum.p95).padStart(8)}  max ${fmt(sum.max).padStart(8)} ms`,
		);
	}
}

// -------------------------------------------------------------------------------------------------

console.log(`dialect=${label} dir=${dir} variants=${variantIds.join(",")} N=${N}`);
await setupBase();
await loadPageSeqs();
const sizesBase = await indexSizes();
if (!onlyWrite) await suiteBase();
const sizesByVariant: Record<string, Record<string, number>> = {};
for (const id of variantIds) {
	const def = VARIANTS[id];
	if (!def) throw new Error(`unknown variant ${id}`);
	await runVariant(def);
}
// index sizes are captured while the indexes exist -> re-create quickly to measure (cheap relative to the run)
for (const id of variantIds) {
	const def = VARIANTS[id];
	if (!def.ddl[dialect]) continue;
	await createVariant(def);
	const s = await indexSizes();
	sizesByVariant[id] = Object.fromEntries(def.drop.map((n) => [n, s[n] ?? 0]));
	await dropVariant(def);
}

// verification: every variant must return the exact same live set for the same (page, T)
const verifyReport: Record<
	string,
	{ variants: string[]; samples: number; mismatches: Record<string, number> }
> = {};
for (const [key, perVariant] of Object.entries(verifyHashes)) {
	const names = Object.keys(perVariant);
	const ref = perVariant[names[0] as string] as string[];
	const mism: Record<string, number> = {};
	for (const n of names) {
		let bad = 0;
		for (let i = 0; i < ref.length; i++) if (ref[i] !== (perVariant[n] as string[])[i]) bad++;
		mism[n] = bad;
	}
	verifyReport[key] = { variants: names, samples: ref.length, mismatches: mism };
	console.log(
		`verify ${key}: ${ref.length} samples, mismatches vs ${names[0]}: ${JSON.stringify(mism)}`,
	);
}
mkdirSync(join(import.meta.dir, "..", "results"), { recursive: true });
await Bun.write(
	outPath,
	JSON.stringify(
		{
			label,
			meta: { info: meta.info, params: meta.params },
			sizesBase,
			sizesByVariant,
			verifyReport,
			plans,
			results,
		},
		null,
		1,
	),
);
console.log(`\nwrote ${outPath}`);
await db.close();
