/**
 * Print markdown tables from results/tt-*.json (the numbers pasted into RESULTS.md).
 * Run: bun time-travel/report.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Res {
	dialect: string;
	variant: string;
	query: string;
	scope: string;
	bucket: string;
	rows: number;
	summary: { n: number; p50: number; p95: number; p99: number; max: number };
}
interface File {
	label: string;
	sizesBase?: Record<string, number>;
	sizesByVariant?: Record<string, Record<string, number>>;
	results?: Res[];
}
const dir = join(import.meta.dir, "..", "results");
const files: Record<string, File> = {};
for (const f of readdirSync(dir)) {
	if (!f.startsWith("tt-") || f.endsWith(".verify.json")) continue;
	const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as File;
	files[j.label] = j;
}
const f2 = (x: number | undefined) =>
	x === undefined ? "-" : x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : x.toFixed(0);

function find(label: string, variant: string, query: string, scope: string, bucket = "all") {
	return files[label]?.results?.find(
		(r) => r.variant === variant && r.query === query && r.scope === scope && r.bucket === bucket,
	);
}
function cell(label: string, variant: string, query: string, scope: string, bucket = "all") {
	const r = find(label, variant, query, scope, bucket);
	return r ? `${f2(r.summary.p50)} / ${f2(r.summary.p95)}` : "-";
}

function matrix(
	title: string,
	labels: string[],
	rows: { name: string; variant: string; query: string; scope: string }[],
) {
	console.log(`\n### ${title}\n`);
	console.log(`| design | ${labels.join(" | ")} |`);
	console.log(`|---|${labels.map(() => "---").join("|")}|`);
	for (const r of rows)
		console.log(
			`| ${r.name} | ${labels.map((l) => cell(l, r.variant, r.query, r.scope)).join(" | ")} |`,
		);
}

const L10 = ["sqlite-prod-vpb10", "pg-vpb10"];
const designs = (
	q: string,
	scope: string,
	extra: { name: string; variant: string; query?: string }[] = [],
) =>
	[
		{ name: "A1 parent recursion, idx(parent_id, from_seq)", variant: "A1" },
		{ name: "A2 parent recursion, idx(parent_id, from_seq, to_max)", variant: "A2" },
		{ name: "B1 page_id, idx(page_id, from_seq)", variant: "B1" },
		{ name: "B2 page_id, idx(page_id, from_seq, to_seq)", variant: "B2" },
		{ name: "B3 page_id, idx(page_id, from_seq, to_max)", variant: "B3" },
		{ name: "B4 page_id, GiST range (PG)", variant: "B4" },
		{ name: "B5 page_id, covering structure idx", variant: "B5" },
		{ name: "C page-membership interval table", variant: "C" },
		...extra,
	].map((d) => ({
		name: d.name,
		variant: d.variant,
		query: (d as { query?: string }).query ?? q,
		scope,
	}));

console.log(
	"p50 / p95 in ms, N=300 samples per cell, history = 10 versions per block (1.1 M version rows)",
);
// B5 results live in separate files; merge them into the main label for printing
for (const [src, dst] of [
	["sqlite-b5-vpb10", "sqlite-prod-vpb10"],
	["pg-b5-vpb10", "pg-vpb10"],
] as const) {
	const s = files[src];
	const d = files[dst];
	if (s?.results && d?.results) d.results.push(...s.results.filter((r) => r.variant === "B5"));
}

matrix(
	"Q2 whole page at T, 2000-block page",
	L10,
	designs("Q2 page@T", "p2000").filter((d) => d.variant !== "A1" || true),
);
matrix("Q2 whole page at T, 10,000-block page", L10, designs("Q2 page@T", "p10000"));
console.log("\n### Q1 viewport (500 blocks, tree order)\n");
console.log("| design | SQLite 2000 | SQLite 10000 | PG 2000 | PG 10000 |\n|---|---|---|---|---|");
const q1 = (label: string, v: string, scope: string) => {
	const names = [
		"Q1 vp500 native-dfs",
		"Q1 vp500 native-bfs",
		"Q1 vp500 read+js-order",
		"Q1 vp500 two-step",
		"Q1 vp500 dfs-sort",
	];
	return (
		names
			.map((q) => ({ q, c: cell(label, v, q, scope) }))
			.filter((x) => x.c !== "-")
			.map((x) => `${x.c} (${x.q.replace("Q1 vp500 ", "")})`)
			.join("<br>") || "-"
	);
};
for (const v of ["A1", "A2", "B1", "B2", "B3", "B4", "B5", "C"])
	console.log(
		`| ${v} | ${q1("sqlite-prod-vpb10", v, "p2000")} | ${q1("sqlite-prod-vpb10", v, "p10000")} | ${q1("pg-vpb10", v, "p2000")} | ${q1("pg-vpb10", v, "p10000")} |`,
	);

console.log("\n### Q3 changes between two time points (page, 2000 blocks)\n");
console.log("| design | dialect | W=1 | W=100 | W=5000 |\n|---|---|---|---|---|");
for (const v of ["A1", "A2", "B1", "B2", "B3", "B4", "B5", "C"]) {
	for (const l of L10) {
		const mode = (w: number) => {
			const flags = cell(l, v, `Q3 diff W=${w} flags`, "p2000");
			const join = cell(l, v, `Q3 diff W=${w} join`, "p2000");
			const plain = cell(l, v, `Q3 diff W=${w}`, "p2000");
			if (plain !== "-") return plain;
			return flags === "-" ? "-" : `${flags} (flags) / ${join} (join)`;
		};
		if (mode(1) === "-") continue;
		console.log(
			`| ${v} | ${l.startsWith("sqlite") ? "SQLite" : "PG"} | ${mode(1)} | ${mode(100)} | ${mode(5000)} |`,
		);
	}
}

console.log("\n### Q4 commit list (200 per page) and commits of one page\n");
for (const l of L10) {
	console.log(
		`- ${l}: all ${cell(l, "-", "Q4a commits (space)", "200/page")}, agent only ${cell(l, "-", "Q4b commits agent only", "200/page")}, one narrator ${cell(l, "-", "Q4c commits narrator", "200/page")}, one page (B3) ${cell(l, "B3", "Q4d commits of page", "200/page")}`,
	);
}

console.log("\n### Growth with history length (Q2 2000-block page, p50 / p95 ms)\n");
const tiers: [string, string, string][] = [
	["3", "sqlite-prod-vpb3", "pg-vpb3"],
	["10", "sqlite-prod-vpb10", "pg-vpb10"],
	["30", "sqlite-prod-vpb30", "pg-vpb30"],
];
console.log(
	"| design | dialect | " +
		tiers.map((t) => `${t[0]} versions/block`).join(" | ") +
		" |\n|---|---|---|---|---|",
);
for (const v of ["A2", "B2", "B3", "B4", "B5", "C"]) {
	for (const [di, name] of [
		[1, "SQLite"],
		[2, "PG"],
	] as const) {
		const cells = tiers.map((t) => cell(t[di] as string, v, "Q2 page@T", "p2000"));
		if (cells.every((c) => c === "-")) continue;
		console.log(`| ${v} | ${name} | ${cells.join(" | ")} |`);
	}
}
console.log("\n### Growth, 10,000-block page (Q2, p50 / p95)\n");
console.log(
	"| design | dialect | " +
		tiers.map((t) => `${t[0]} v/b`).join(" | ") +
		" |\n|---|---|---|---|---|",
);
for (const v of ["A2", "B3", "B5", "C"]) {
	for (const [di, name] of [
		[1, "SQLite"],
		[2, "PG"],
	] as const) {
		const cells = tiers.map((t) => cell(t[di] as string, v, "Q2 page@T", "p10000"));
		if (cells.every((c) => c === "-")) continue;
		console.log(`| ${v} | ${name} | ${cells.join(" | ")} |`);
	}
}
console.log("\n### Growth, Q1 viewport (best per design; p50 / p95)\n");
console.log(
	"| design | dialect | " +
		tiers.map((t) => `${t[0]} v/b`).join(" | ") +
		" |\n|---|---|---|---|---|",
);
for (const [v, qs] of [
	["A2", ["Q1 vp500 native-dfs", "Q1 vp500 native-bfs"]],
	["B3", ["Q1 vp500 read+js-order"]],
	["B5", ["Q1 vp500 two-step"]],
] as const) {
	for (const [di, name] of [
		[1, "SQLite"],
		[2, "PG"],
	] as const) {
		const cells = tiers.map(
			(t) => qs.map((q) => cell(t[di] as string, v, q, "p2000")).find((c) => c !== "-") ?? "-",
		);
		if (cells.every((c) => c === "-")) continue;
		console.log(`| ${v} | ${name} | ${cells.join(" | ")} |`);
	}
}

console.log("\n### T position (B3, Q2 2000-block page, p50 / p95)\n");
console.log("| dialect | early | mid | late |\n|---|---|---|---|");
for (const l of [...L10, "sqlite-prod-vpb30", "pg-vpb30"]) {
	console.log(
		`| ${l} | ${["early", "mid", "late"].map((b) => cell(l, "B3", "Q2 page@T", "p2000", b)).join(" | ")} |`,
	);
}

console.log(
	"\n### Writes (single transaction: commit row + close previous version + insert version + update current row)\n",
);
console.log(
	"| index set | SQLite 1 block | SQLite 200 blocks | PG 1 block | PG 200 blocks |\n|---|---|---|---|---|",
);
for (const v of ["A1", "A2", "B1", "B2", "B3", "B4", "B5", "C"]) {
	const w = (l: string, q: string) => {
		const r = find(l, v, q, "write");
		return r ? `${f2(r.summary.p50)} / ${f2(r.summary.p95)}` : "-";
	};
	console.log(
		`| ${v} | ${w("sqlite-write-vpb10", "W1 commit 1 block")} | ${w("sqlite-write-vpb10", "W2 commit 200 blocks")} | ${w("pg-vpb10", "W1 commit 1 block")} | ${w("pg-vpb10", "W2 commit 200 blocks")} |`,
	);
}

console.log("\n### Index sizes (MB)\n");
for (const l of ["sqlite-prod-vpb10", "pg-vpb10", "sqlite-prod-vpb30", "pg-vpb30"]) {
	const f = files[l];
	if (!f) continue;
	const b = f.sizesBase ?? {};
	const mb = (x: number | undefined) => (x === undefined ? "-" : (x / 1e6).toFixed(0));
	console.log(
		`- ${l}: versions table ${mb(b.outline_block_versions)} (+toast ${mb(b.outline_block_versions_toast)}), pk ${mb(b.pk_versions ?? b.outline_block_versions_pkey)}, commit idx ${mb(b.v_commit)}; variants: ${Object.entries(
			f.sizesByVariant ?? {},
		)
			.map(
				([v, o]) =>
					`${v}=${Object.values(o)
						.map((x) => mb(x))
						.join("+")}`,
			)
			.join(", ")}`,
	);
}
