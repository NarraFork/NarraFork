/**
 * Brute-force vector scan benchmark (one process per dataset/dtype so memory numbers are clean).
 *
 * Run: bun vector/bench.ts --db=<file> --n=200000 --dim=1024 --dtype=i8 [--queries=100] [--budget=20000]
 *        [--k=50] [--scenarios=resident,sqlite] [--out=results/vec-....json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { arg, argNum, DATA_ROOT, fmt, summarize } from "../time-travel/lib";
import { genVector, makeGen, quantize, SPACES } from "./common";
import type { InitMsg, QueryMsg } from "./worker";

const dbPath = arg("db") as string;
const n = argNum("n", 200000);
const dim = argNum("dim", 1024);
const dtype = (arg("dtype") ?? "i8") as "i8" | "f32";
const Q = argNum("queries", 100);
const budgetMs = argNum("budget", 20000);
const K = argNum("k", 50);
const scenarios = (arg("scenarios") ?? "resident,sqlite").split(",");
const tag = `${n}-${dim}-${dtype}`;
const outPath = arg("out") ?? join(import.meta.dir, "..", "results", `vec-${tag}.json`);
const truthPath = join(DATA_ROOT, `truth-${n}-${dim}.json`);
const wantTables = (arg("tables") ?? "r1,r2,r3").split(",");

function vmKb(key: string): number {
	const m = readFileSync("/proc/self/status", "utf8").match(new RegExp(`${key}:\\s+(\\d+) kB`));
	return m ? Number(m[1]) : 0;
}

// ---- queries (same for every dtype so recall can be compared)
const g = makeGen(dim, n);
const queries: { f32: Float32Array; i8: Int8Array; scale: number; space: number }[] = [];
for (let j = 0; j < Q; j++) {
	const f = new Float32Array(dim);
	genVector(g, n + 1 + j, f, 1.1);
	const i8 = new Int8Array(dim);
	const scale = quantize(f, i8);
	queries.push({ f32: f, i8, scale, space: j % SPACES });
}

// ---- event loop lag monitor
let lagMax = 0;
const lagSamples: number[] = [];
{
	let last = performance.now();
	setInterval(() => {
		const now = performance.now();
		const lag = now - last - 2;
		last = now;
		if (lag > lagMax) lagMax = lag;
		lagSamples.push(lag);
	}, 2);
}

interface Row {
	scenario: string;
	layout?: string;
	filter: string;
	kernel: string;
	n: number;
	dim: number;
	dtype: string;
	queries: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
	scanP50: number;
	scanned: number;
	extra?: Record<string, unknown>;
}
const rows: Row[] = [];
const kernelResults = new Map<string, { kernel: string; got: number[][] }>();
const loads: Record<string, unknown>[] = [];
const truth: Record<string, number[][]> = existsSync(truthPath)
	? JSON.parse(readFileSync(truthPath, "utf8"))
	: {};
const saveTruth = dtype === "f32";
const newTruth: Record<string, number[][]> = {};

function spawn(): Worker {
	return new Worker(new URL("./worker.ts", import.meta.url).href);
}

function call<T>(w: Worker, msg: object, transfer?: Transferable[]): Promise<T> {
	return new Promise((resolve, reject) => {
		const onMsg = (ev: MessageEvent) => {
			const d = ev.data;
			if (d.type === "error") {
				w.removeEventListener("message", onMsg);
				reject(new Error(`${d.error}\n${d.stack}`));
			} else if (d.type === "ready" || d.type === "result" || d.type === "closed") {
				w.removeEventListener("message", onMsg);
				resolve(d as T);
			}
		};
		w.addEventListener("message", onMsg);
		w.postMessage(msg, transfer ?? []);
	});
}

function recall(ids: number[], ref: number[], at: number): number {
	const r = new Set(ref.slice(0, at));
	let hit = 0;
	for (const x of ids.slice(0, at)) if (r.has(x)) hit++;
	return hit / Math.max(1, Math.min(at, ref.length));
}

async function runQueries(
	w: Worker,
	scenario: string,
	layout: string | undefined,
	filter: QueryMsg["filter"],
	kernel: "js" | "wasm",
	nCandidates: number,
) {
	const times: number[] = [];
	const scans: number[] = [];
	const lagStart = lagSamples.length;
	const got: number[][] = [];
	let extra: Record<string, unknown> | undefined;
	const t00 = performance.now();
	for (let j = 0; j < Q; j++) {
		const qq = queries[j] as (typeof queries)[number];
		const buf = (dtype === "i8" ? qq.i8 : qq.f32).slice().buffer;
		const msg: QueryMsg = {
			type: "query",
			id: j,
			q: buf,
			qscale: qq.scale,
			kernel,
			filter,
			space: qq.space,
		};
		const t0 = performance.now();
		const r = await call<{
			scanMs: number;
			ids: Int32Array;
			scores: Float32Array;
			rows?: number;
			bytes?: number;
		}>(w, msg, [buf]);
		const dt = performance.now() - t0;
		if (j >= 3) {
			times.push(dt);
			scans.push(r.scanMs);
		}
		if (j < 40) got[j] = Array.from(r.ids);
		if (r.rows !== undefined) extra = { rowsPerQuery: r.rows, mbPerQuery: (r.bytes ?? 0) / 1e6 };
		if (j >= 12 && performance.now() - t00 > budgetMs) break;
	}
	const s = summarize(times);
	const sc = summarize(scans);
	const lags = lagSamples.slice(lagStart);
	const lagP99 = [...lags].sort((a, b) => a - b)[Math.floor(lags.length * 0.99)] ?? 0;
	const row: Row = {
		scenario,
		layout,
		filter,
		kernel,
		n,
		dim,
		dtype,
		queries: times.length,
		p50: s.p50,
		p95: s.p95,
		p99: s.p99,
		max: s.max,
		scanP50: sc.p50,
		scanned: nCandidates,
		extra: { ...extra, eventLoopLagP99Ms: lagP99, eventLoopLagMaxMs: Math.max(0, ...lags) },
	};
	// recall against float32 exact (range filter, same space)
	const tkey = `${filter}`;
	if (
		saveTruth &&
		(filter === "range" || filter === "r2" || filter === "r3") &&
		kernel !== undefined
	) {
		if (!newTruth.range) newTruth.range = got;
	}
	if (
		!saveTruth &&
		truth.range &&
		(filter === "range" ||
			filter === "tag" ||
			filter === "ids" ||
			filter === "r2" ||
			filter === "r3" ||
			filter === "r1")
	) {
		const t = truth.range as number[][];
		let r10 = 0;
		let r50 = 0;
		let c = 0;
		for (let j = 0; j < got.length; j++) {
			if (!got[j] || !t[j]) continue;
			r10 += recall(got[j] as number[], t[j] as number[], 10);
			r50 += recall(got[j] as number[], t[j] as number[], 50);
			c++;
		}
		row.extra = { ...row.extra, recallAt10: r10 / c, recallAt50: r50 / c };
	}
	void tkey;
	// the two kernels must return the same ids (exact for float32, near-exact for int8: only fp rounding differs)
	const agreeKey = `${layout}:${filter}`;
	const prev = kernelResults.get(agreeKey);
	if (prev && prev.kernel !== kernel) {
		let same = 0;
		let tot = 0;
		for (let j = 0; j < got.length; j++) {
			if (!got[j] || !prev.got[j]) continue;
			tot++;
			if (JSON.stringify(got[j]) === JSON.stringify(prev.got[j])) same++;
		}
		row.extra = { ...row.extra, kernelAgreement: `${same}/${tot}` };
	} else kernelResults.set(agreeKey, { kernel, got });
	rows.push(row);
	const mb =
		row.extra && typeof row.extra.mbPerQuery === "number"
			? ` read ${fmt(row.extra.mbPerQuery as number, 1)}MB`
			: "";
	console.log(
		`  ${scenario.padEnd(9)} ${(layout ?? "").padEnd(11)} ${filter.padEnd(8)} ${kernel.padEnd(4)} scanned~${String(nCandidates).padStart(8)}  p50 ${fmt(s.p50).padStart(8)}  p95 ${fmt(s.p95).padStart(8)}  p99 ${fmt(s.p99).padStart(8)} ms (scan p50 ${fmt(sc.p50)})  n=${times.length}  lag99 ${fmt(lagP99)}ms${mb}${row.extra?.kernelAgreement !== undefined ? `  js/wasm identical ${row.extra.kernelAgreement}` : ""}${row.extra?.recallAt50 !== undefined ? `  recall@10 ${fmt(row.extra.recallAt10 as number, 3)} @50 ${fmt(row.extra.recallAt50 as number, 3)}` : ""}`,
	);
}

console.log(`\n== vector bench n=${n} dim=${dim} dtype=${dtype} k=${K} db=${dbPath}`);
const rss0 = process.memoryUsage().rss;

if (scenarios.includes("resident")) {
	for (const layout of ["clustered", "interleaved"] as const) {
		const w = spawn();
		try {
			const init: InitMsg = {
				type: "init",
				mode: "resident",
				dbPath,
				dtype,
				dim,
				n,
				layout,
				loadFrom: "r2",
				k: K,
			};
			const r = await call<{ loadMs: number; bytes: number }>(w, init);
			const rss = process.memoryUsage().rss;
			const load = {
				layout,
				loadFrom: "r2",
				loadMs: r.loadMs,
				matrixBytes: r.bytes,
				rssDeltaMB: (rss - rss0) / 1e6,
				vmRssMB: vmKb("VmRSS") / 1024,
				vmHwmMB: vmKb("VmHWM") / 1024,
			};
			loads.push(load);
			console.log(
				`  resident ${layout}: loaded ${fmt(r.loadMs / 1000, 1)}s from r2, matrix ${fmt(r.bytes / 1e6, 0)}MB, RSS +${fmt((rss - rss0) / 1e6, 0)}MB, VmHWM ${fmt(vmKb("VmHWM") / 1024, 0)}MB`,
			);
			const per = n / SPACES;
			if (layout === "clustered") {
				for (const kernel of ["wasm", "js"] as const) {
					await runQueries(w, "resident", layout, "range", kernel, per);
					await runQueries(w, "resident", layout, "none", kernel, n);
				}
			} else {
				for (const kernel of ["wasm", "js"] as const) {
					await runQueries(w, "resident", layout, "tag", kernel, per);
					await runQueries(w, "resident", layout, "ids", kernel, per);
				}
			}
			await call(w, { type: "close" });
		} catch (e) {
			console.log(`  resident ${layout} FAILED: ${String(e).slice(0, 200)}`);
			loads.push({ layout, error: String(e).slice(0, 300) });
		}
		w.terminate();
		await Bun.sleep(300);
	}
	// load time from the chunked table (r3) as well
	if (wantTables.includes("r3")) {
		try {
			const w = spawn();
			const init: InitMsg = {
				type: "init",
				mode: "resident",
				dbPath,
				dtype,
				dim,
				n,
				layout: "clustered",
				loadFrom: "r3",
				k: K,
			};
			const r = await call<{ loadMs: number; bytes: number }>(w, init);
			loads.push({ layout: "clustered", loadFrom: "r3", loadMs: r.loadMs, matrixBytes: r.bytes });
			console.log(`  resident clustered: loaded ${fmt(r.loadMs / 1000, 1)}s from r3 (chunk packs)`);
			w.terminate();
		} catch (e) {
			console.log(`  r3 load skipped: ${String(e).slice(0, 120)}`);
		}
	}
}

if (scenarios.includes("sqlite")) {
	const w = spawn();
	const init: InitMsg = {
		type: "init",
		mode: "sqlite",
		dbPath,
		dtype,
		dim,
		n,
		layout: "clustered",
		loadFrom: "r2",
		k: K,
	};
	await call(w, init);
	const per = n / SPACES;
	for (const f of ["r2-read", "r2", "r3-read", "r3", "r1-read", "r1"] as const) {
		if (!wantTables.includes(f.slice(0, 2))) continue;
		try {
			await runQueries(w, "sqlite", undefined, f, "js", per);
		} catch (e) {
			console.log(`  sqlite ${f} skipped: ${String(e).slice(0, 100)}`);
		}
	}
	w.terminate();
}

if (saveTruth && newTruth.range) {
	const cur = existsSync(truthPath) ? JSON.parse(readFileSync(truthPath, "utf8")) : {};
	cur.range = newTruth.range;
	writeFileSync(truthPath, JSON.stringify(cur));
}
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
	outPath,
	JSON.stringify({ n, dim, dtype, k: K, loads, rows, peakRssMB: vmKb("VmHWM") / 1024 }, null, 1),
);
console.log(
	`peak RSS (main process incl. worker) ${fmt(vmKb("VmHWM") / 1024, 0)} MB; wrote ${outPath}`,
);
process.exit(0);
