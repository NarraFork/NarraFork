/**
 * Print markdown tables from results/vec-*.json (the numbers pasted into RESULTS.md).
 * Run: bun vector/report.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
	extra?: { recallAt10?: number; recallAt50?: number; eventLoopLagMaxMs?: number; mbPerQuery?: number; kernelAgreement?: string };
}
interface File {
	n: number;
	dim: number;
	dtype: string;
	loads: { layout: string; loadFrom: string; loadMs?: number; matrixBytes?: number; rssDeltaMB?: number; vmHwmMB?: number; steadyRssMB?: number; error?: string }[];
	rows: Row[];
	peakRssMB: number;
}
const dir = join(import.meta.dir, "..", "results");
const files: File[] = readdirSync(dir)
	.filter((f) => /^vec-\d+-\d+-(i8|f32)\.json$/.test(f))
	.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as File)
	.sort((a, b) => a.dim - b.dim || a.n - b.n || a.dtype.localeCompare(b.dtype));
const f = (x: number | undefined) => (x === undefined ? "-" : x < 10 ? x.toFixed(1) : x.toFixed(0));
const find = (file: File, scenario: string, filter: string, kernel: string, layout?: string) =>
	file.rows.find((r) => r.scenario === scenario && r.filter === filter && r.kernel === kernel && (layout === undefined || r.layout === layout));
const cell = (r: Row | undefined) => (r ? `${f(r.p50)} / ${f(r.p95)}` : "-");

for (const dim of [768, 1024]) {
	console.log(`\n### dim = ${dim}: resident in worker memory, p50 / p95 ms per query (top-50)\n`);
	console.log("| N | dtype | wasm 10% range | wasm 10% tag | wasm 10% id list | wasm 100% | js 10% range | js 10% tag | js 100% | matrix MB | load r2 s | load r3 s | steady RSS MB |");
	console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
	for (const file of files.filter((x) => x.dim === dim)) {
		const cl = file.loads.find((l) => l.layout === "clustered" && l.loadFrom === "r2");
		const l3 = file.loads.find((l) => l.loadFrom === "r3");
		console.log(
			`| ${file.n.toLocaleString("en")} | ${file.dtype} | ${cell(find(file, "resident", "range", "wasm"))} | ${cell(find(file, "resident", "tag", "wasm"))} | ${cell(find(file, "resident", "ids", "wasm"))} | ${cell(find(file, "resident", "none", "wasm"))} | ${cell(find(file, "resident", "range", "js"))} | ${cell(find(file, "resident", "tag", "js"))} | ${cell(find(file, "resident", "none", "js"))} | ${cl ? f((cl.matrixBytes ?? 0) / 1e6) : "-"} | ${cl ? f((cl.loadMs ?? 0) / 1000) : "-"} | ${l3?.loadMs ? f(l3.loadMs / 1000) : "-"} | ${cl?.steadyRssMB ? f(cl.steadyRssMB) : `(${f(cl?.rssDeltaMB)} peak)`} |`,
		);
	}
	console.log(`\n### dim = ${dim}: read from SQLite on every query (10% of the vectors, JS scoring), p50 / p95 ms\n`);
	console.log("| N | dtype | r2 clustered rows: read only | r2 + score | r3 chunk packs: read only | r3 + score | r1 design-literal join: read only | r1 + score | MB read per query |");
	console.log("|---|---|---|---|---|---|---|---|---|");
	for (const file of files.filter((x) => x.dim === dim)) {
		const r2 = find(file, "sqlite", "r2", "js");
		console.log(
			`| ${file.n.toLocaleString("en")} | ${file.dtype} | ${cell(find(file, "sqlite", "r2-read", "js"))} | ${cell(r2)} | ${cell(find(file, "sqlite", "r3-read", "js"))} | ${cell(find(file, "sqlite", "r3", "js"))} | ${cell(find(file, "sqlite", "r1-read", "js"))} | ${cell(find(file, "sqlite", "r1", "js"))} | ${r2?.extra?.mbPerQuery ? f(r2.extra.mbPerQuery) : "-"} |`,
		);
	}
	console.log(`\n### dim = ${dim}: int8 recall against exact float32 (same 10% filter, synthetic clustered vectors)\n`);
	for (const file of files.filter((x) => x.dim === dim && x.dtype === "i8")) {
		const r = find(file, "resident", "range", "wasm");
		console.log(`- N=${file.n.toLocaleString("en")}: recall@10 ${r?.extra?.recallAt10?.toFixed(3) ?? "-"}, recall@50 ${r?.extra?.recallAt50?.toFixed(3) ?? "-"}`);
	}
}
console.log("\n### max event-loop lag seen on the main thread while a worker scan ran (ms)\n");
console.log(files.map((x) => `${x.n}/${x.dim}/${x.dtype}: ${f(Math.max(...x.rows.map((r) => r.extra?.eventLoopLagMaxMs ?? 0)))}`).join("; "));
