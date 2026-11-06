#!/usr/bin/env bun
/**
 * Summarise NF_SQL_TRACE output (see server/lib/sql-trace.ts) into a compact digest that is
 * small enough to hand to an AI for analysis.
 *
 *   bun run sql:report                       # today
 *   bun run sql:report 2025-06-01            # one day
 *   bun run sql:report 2025-06-01 2025-06-07 # inclusive range
 *   bun run sql:report --top 30 --json       # machine-readable
 *   bun run sql:report --latest              # only the most recently started server process
 *   bun run sql:report --pid 1075652         # one process (and its db-worker threads)
 *   bun run sql:report --span <id>           # every record of one span and its children
 *
 * Streams the NDJSON files line by line; memory stays bounded by the number of distinct
 * span labels and statement fingerprints, not by file size.
 */
import {
	closeSync,
	createReadStream,
	existsSync,
	openSync,
	readSync,
	readdirSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getNarraforkPath } from "../server/lib/narrafork-home";

interface StmtRow {
	h: string;
	n: number;
	ms: number;
	max: number;
	rows: number;
}

interface SpanRecord {
	t: "span";
	id: string;
	parent?: string;
	kind: string;
	label: string;
	ts: string;
	ms?: number;
	end?: boolean;
	n: number;
	sqlMs: number;
	maxMs: number;
	txN?: number;
	txMs?: number;
	a?: Record<string, unknown>;
	stmts: StmtRow[];
}

interface LabelAgg {
	kind: string;
	label: string;
	spans: Set<string>;
	ended: number;
	wallMs: number[];
	n: number;
	sqlMs: number;
	maxMs: number;
	perSpanSqlMs: Map<string, number>;
	perSpanN: Map<string, number>;
	stmts: Map<string, { n: number; ms: number }>;
}

interface StmtAgg {
	n: number;
	ms: number;
	max: number;
	rows: number;
	labels: Map<string, number>;
}

function parseArgs(argv: string[]) {
	const days: string[] = [];
	let top = 20;
	let json = false;
	let span: string | null = null;
	let pid: string | null = null;
	let latest = false;
	let dir = process.env.NF_SQL_TRACE_DIR ?? getNarraforkPath("sql-trace");
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--top") top = Number(argv[++i]) || top;
		else if (arg === "--json") json = true;
		else if (arg === "--span") span = argv[++i] ?? null;
		else if (arg === "--pid") pid = argv[++i] ?? null;
		else if (arg === "--latest") latest = true;
		else if (arg === "--dir") dir = argv[++i] ?? dir;
		else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) days.push(arg);
		else if (arg === "-h" || arg === "--help") {
			console.log(
				"usage: bun run sql:report [from [to]] [--top N] [--json] [--span ID] [--dir PATH] [--pid N|--latest]",
			);
			process.exit(0);
		}
	}
	return { days, top, json, span, dir, pid, latest };
}

function today(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Newest server process in the directory, by its first record's timestamp. */
function latestPid(dir: string): string | null {
	let best: { pid: string; at: number } | null = null;
	for (const name of readdirSync(dir)) {
		const match = /^\d{4}-\d{2}-\d{2}-p(\d+)\.ndjson$/.exec(name);
		if (!match) continue;
		try {
			// Only the first line is needed; some of these files grow to tens of MB.
			const fd = openSync(join(dir, name), "r");
			const head = Buffer.alloc(4096);
			const bytes = readSync(fd, head, 0, head.length, 0);
			closeSync(fd);
			const first = head.toString("utf8", 0, bytes).split("\n", 1)[0] ?? "";
			const at = Number((JSON.parse(first) as { at?: number }).at) || 0;
			if (!best || at > best.at) best = { pid: match[1] as string, at };
		} catch {
			// unreadable file: not a candidate
		}
	}
	return best?.pid ?? null;
}

function selectFiles(dir: string, days: string[], pid: string | null): string[] {
	if (!existsSync(dir)) return [];
	const from = days[0] ?? today();
	const to = days[1] ?? from;
	return readdirSync(dir)
		.filter((name) => /^\d{4}-\d{2}-\d{2}-.*\.ndjson$/.test(name))
		.filter((name) => {
			const day = name.slice(0, 10);
			return day >= from && day <= to;
		})
		.filter((name) => !pid || name.includes(`-p${pid}.`) || name.includes(`-p${pid}-`))
		.sort()
		.map((name) => join(dir, name));
}

async function* records(files: string[]): AsyncGenerator<Record<string, unknown>> {
	for (const file of files) {
		const rl = createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY });
		for await (const line of rl) {
			if (!line) continue;
			try {
				yield JSON.parse(line) as Record<string, unknown>;
			} catch {
				// a torn last line from a crash; skip
			}
		}
	}
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
	return sorted[idx] as number;
}

async function spanDetail(files: string[], target: string, json: boolean): Promise<void> {
	// Pass 1: the span tree. Children usually END (and are written) before their parent, so
	// descendants are resolved from the full parent map rather than in file order.
	const children = new Map<string, string[]>();
	for await (const rec of records(files)) {
		if (rec.t !== "span" || !rec.parent) continue;
		const list = children.get(rec.parent as string) ?? [];
		if (!list.includes(rec.id as string)) list.push(rec.id as string);
		children.set(rec.parent as string, list);
	}
	const ids = new Set<string>();
	const stack = [target];
	while (stack.length) {
		const id = stack.pop() as string;
		if (ids.has(id)) continue;
		ids.add(id);
		stack.push(...(children.get(id) ?? []));
	}
	// Pass 2: the records.
	const out: Record<string, unknown>[] = [];
	const sqlText = new Map<string, string>();
	for await (const rec of records(files)) {
		if (rec.t === "stmt") sqlText.set(rec.h as string, rec.sql as string);
		else if (rec.t === "span" && ids.has(rec.id as string)) out.push(rec);
		else if ((rec.t === "sql" || rec.t === "tx") && ids.has(rec.span as string)) out.push(rec);
	}
	const used = new Set<string>();
	for (const rec of out) {
		if (rec.t === "sql") used.add(rec.h as string);
		for (const s of (rec.stmts as StmtRow[] | undefined) ?? []) used.add(s.h);
	}
	const sql = Object.fromEntries([...used].map((h) => [h, sqlText.get(h) ?? "?"]));
	if (json) {
		console.log(JSON.stringify({ span: target, records: out, sql }, null, 2));
		return;
	}
	console.log(`# Span ${target} (${out.length} records)\n`);
	for (const rec of out) console.log(JSON.stringify(rec));
	console.log("\n## SQL\n");
	for (const [h, text] of Object.entries(sql)) console.log(`- \`${h}\` ${text}`);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const { days, top, json, span, dir } = args;
	const pid = args.latest ? latestPid(dir) : args.pid;
	const files = selectFiles(dir, days, pid);
	if (files.length === 0) {
		console.error(`No trace files in ${dir} for ${days.join("..") || today()}.`);
		console.error("Start the server with NF_SQL_TRACE=summary (bun run start:dev enables it).");
		process.exit(1);
	}
	if (span) return spanDetail(files, span, json);

	const sqlText = new Map<string, string>();
	const labels = new Map<string, LabelAgg>();
	const stmts = new Map<string, StmtAgg>();
	const spanLabel = new Map<string, string>();
	const slowSql: Array<{ at: number; span: string; h: string; op: string; ms: number; rows: number }> =
		[];
	const slowTx: Array<{ at: number; span: string; ms: number; site: string }> = [];
	const slowSpans: Array<{ id: string; label: string; ms: number; sqlMs: number; n: number; ts: string; a?: unknown }> =
		[];
	const metas: Record<string, unknown>[] = [];
	let dropped = 0;
	let totalN = 0;
	let totalMs = 0;
	let firstTs = "";
	let lastTs = "";
	const KEEP_SLOW = Math.max(top * 5, 200);

	for await (const rec of records(files)) {
		switch (rec.t) {
			case "meta":
				metas.push(rec);
				break;
			case "stmt":
				sqlText.set(rec.h as string, rec.sql as string);
				break;
			case "dropped":
				dropped += Number(rec.count) || 0;
				break;
			case "sql":
				slowSql.push(rec as never);
				if (slowSql.length > KEEP_SLOW * 2) {
					slowSql.sort((a, b) => b.ms - a.ms);
					slowSql.length = KEEP_SLOW;
				}
				break;
			case "tx":
				slowTx.push(rec as never);
				if (slowTx.length > KEEP_SLOW * 2) {
					slowTx.sort((a, b) => b.ms - a.ms);
					slowTx.length = KEEP_SLOW;
				}
				break;
			case "span": {
				const s = rec as unknown as SpanRecord;
				if (!firstTs || s.ts < firstTs) firstTs = s.ts;
				if (s.ts > lastTs) lastTs = s.ts;
				const key = `${s.kind}\u0000${s.label}`;
				spanLabel.set(s.id, s.label);
				let agg = labels.get(key);
				if (!agg) {
					agg = {
						kind: s.kind,
						label: s.label,
						spans: new Set(),
						ended: 0,
						wallMs: [],
						n: 0,
						sqlMs: 0,
						maxMs: 0,
						perSpanSqlMs: new Map(),
						perSpanN: new Map(),
						stmts: new Map(),
					};
					labels.set(key, agg);
				}
				agg.spans.add(s.id);
				agg.n += s.n;
				agg.sqlMs += s.sqlMs;
				agg.maxMs = Math.max(agg.maxMs, s.maxMs);
				agg.perSpanSqlMs.set(s.id, (agg.perSpanSqlMs.get(s.id) ?? 0) + s.sqlMs);
				agg.perSpanN.set(s.id, (agg.perSpanN.get(s.id) ?? 0) + s.n);
				if (s.end && typeof s.ms === "number") {
					agg.ended++;
					agg.wallMs.push(s.ms);
					slowSpans.push({ id: s.id, label: s.label, ms: s.ms, sqlMs: s.sqlMs, n: s.n, ts: s.ts, a: s.a });
					if (slowSpans.length > KEEP_SLOW * 2) {
						slowSpans.sort((a, b) => b.sqlMs - a.sqlMs);
						slowSpans.length = KEEP_SLOW;
					}
				}
				totalN += s.n;
				totalMs += s.sqlMs;
				for (const st of s.stmts) {
					const ls = agg.stmts.get(st.h) ?? { n: 0, ms: 0 };
					ls.n += st.n;
					ls.ms += st.ms;
					agg.stmts.set(st.h, ls);
					let g = stmts.get(st.h);
					if (!g) {
						g = { n: 0, ms: 0, max: 0, rows: 0, labels: new Map() };
						stmts.set(st.h, g);
					}
					g.n += st.n;
					g.ms += st.ms;
					g.max = Math.max(g.max, st.max);
					g.rows += st.rows;
					g.labels.set(s.label, (g.labels.get(s.label) ?? 0) + st.ms);
				}
				break;
			}
		}
	}

	const sqlOf = (h: string) => (h === "_other" ? "(other statements)" : (sqlText.get(h) ?? "?"));
	const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text);

	const byLabel = [...labels.values()]
		.map((agg) => {
			const per = [...agg.perSpanSqlMs.values()].sort((a, b) => a - b);
			const perN = [...agg.perSpanN.values()].sort((a, b) => a - b);
			const wall = agg.wallMs.sort((a, b) => a - b);
			const topStmts = [...agg.stmts.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 3);
			return {
				kind: agg.kind,
				label: agg.label,
				count: agg.spans.size,
				sqlMs: r1(agg.sqlMs),
				calls: agg.n,
				callsPerSpan: r1(agg.n / Math.max(1, agg.spans.size)),
				p50SqlMs: r1(quantile(per, 0.5)),
				p95SqlMs: r1(quantile(per, 0.95)),
				maxCallsInSpan: perN.at(-1) ?? 0,
				p95WallMs: wall.length ? r1(quantile(wall, 0.95)) : null,
				maxStmtMs: r1(agg.maxMs),
				topStmts: topStmts.map(([h, v]) => ({ h, n: v.n, ms: r1(v.ms) })),
			};
		})
		.sort((a, b) => b.sqlMs - a.sqlMs);

	const byStmt = [...stmts.entries()]
		.map(([h, g]) => ({
			h,
			calls: g.n,
			totalMs: r1(g.ms),
			avgMs: Math.round((g.ms / Math.max(1, g.n)) * 1000) / 1000,
			maxMs: r1(g.max),
			avgRows: r1(g.rows / Math.max(1, g.n)),
			topCallers: [...g.labels.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
				.map(([label, ms]) => ({ label, ms: r1(ms) })),
			sql: sqlOf(h),
		}))
		.sort((a, b) => b.totalMs - a.totalMs);

	// N+1 candidates: one fingerprint executed many times inside single spans.
	const nPlusOne = [...labels.values()]
		.flatMap((agg) =>
			[...agg.stmts.entries()].map(([h, v]) => ({
				label: agg.label,
				h,
				perSpan: r1(v.n / Math.max(1, agg.spans.size)),
				ms: r1(v.ms),
			})),
		)
		.filter((x) => x.perSpan >= 20 && x.h !== "_other")
		.sort((a, b) => b.perSpan * b.ms - a.perSpan * a.ms)
		.slice(0, top);

	slowSql.sort((a, b) => b.ms - a.ms);
	slowTx.sort((a, b) => b.ms - a.ms);
	slowSpans.sort((a, b) => b.sqlMs - a.sqlMs);

	const report = {
		window: { from: firstTs, to: lastTs, files: files.map((f) => f.split("/").pop()), pid },
		totals: {
			sqlCalls: totalN,
			sqlMs: r1(totalMs),
			spans: spanLabel.size,
			distinctStatements: stmts.size,
			droppedRecords: dropped,
			processes: metas.length,
			mode: [...new Set(metas.map((m) => m.mode))],
			slowThresholdMs: metas[0]?.slowMs,
		},
		byKind: Object.entries(
			byLabel.reduce<Record<string, { calls: number; sqlMs: number; spans: number }>>((acc, row) => {
				const k = (acc[row.kind] ??= { calls: 0, sqlMs: 0, spans: 0 });
				k.calls += row.calls;
				k.sqlMs = r1(k.sqlMs + row.sqlMs);
				k.spans += row.count;
				return acc;
			}, {}),
		).map(([kind, v]) => ({ kind, ...v })),
		topLabels: byLabel.slice(0, top),
		topStatements: byStmt.slice(0, top),
		nPlusOneCandidates: nPlusOne,
		slowestSpans: slowSpans.slice(0, top),
		slowestStatements: slowSql.slice(0, top).map((s) => ({
			...s,
			at: new Date(s.at).toISOString(),
			label: spanLabel.get(s.span) ?? "?",
			sql: clip(sqlOf(s.h)),
		})),
		slowestTransactions: slowTx.slice(0, top).map((t) => ({
			...t,
			at: new Date(t.at).toISOString(),
			label: spanLabel.get(t.span) ?? "?",
		})),
	};

	if (json) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}

	const lines: string[] = [];
	const p = (s = "") => lines.push(s);
	p("# SQLite trace report");
	p();
	p(`Window: ${report.window.from} → ${report.window.to} (${files.length} file(s))`);
	p(
		`Totals: ${totalN} SQL calls, ${r1(totalMs)} ms main+worker SQLite time, ${spanLabel.size} spans, ` +
			`${stmts.size} distinct statements, mode=${report.totals.mode.join("/")}, ` +
			`slow threshold=${report.totals.slowThresholdMs} ms${dropped ? `, DROPPED ${dropped} records` : ""}`,
	);
	p();
	p("Kinds: http = API request, ws = WebSocket message, agent = narrator run, tool = tool call,");
	p("worker = db-worker task, bg = no request context. Its label is the calling code location,");
	p("or `async <table>` when the query ran in a continuation whose stack has no app frame left.");
	p("Span SQL time excludes child spans (tool calls inside an agent run are counted separately).");
	p();
	p("## By kind");
	p("| kind | spans | calls | sql ms |");
	p("|---|---:|---:|---:|");
	for (const k of report.byKind) p(`| ${k.kind} | ${k.spans} | ${k.calls} | ${k.sqlMs} |`);
	p();
	p(`## Top ${top} span labels by total SQL time`);
	p("| kind | label | count | sql ms | calls/span | p50 sql | p95 sql | max calls | p95 wall | max stmt | top stmts |");
	p("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
	for (const r of report.topLabels) {
		p(
			`| ${r.kind} | ${r.label} | ${r.count} | ${r.sqlMs} | ${r.callsPerSpan} | ${r.p50SqlMs} | ${r.p95SqlMs} | ` +
				`${r.maxCallsInSpan} | ${r.p95WallMs ?? "-"} | ${r.maxStmtMs} | ` +
				`${r.topStmts.map((s) => `${s.h}×${s.n}=${s.ms}ms`).join(", ")} |`,
		);
	}
	p();
	p(`## Top ${top} statements by total time`);
	p("| h | calls | total ms | avg ms | max ms | avg rows | top callers | sql |");
	p("|---|---:|---:|---:|---:|---:|---|---|");
	for (const s of report.topStatements) {
		p(
			`| ${s.h} | ${s.calls} | ${s.totalMs} | ${s.avgMs} | ${s.maxMs} | ${s.avgRows} | ` +
				`${s.topCallers.map((c) => `${c.label} (${c.ms})`).join("; ")} | \`${clip(s.sql).replaceAll("|", "\\|")}\` |`,
		);
	}
	p();
	if (nPlusOne.length) {
		p("## N+1 candidates (same statement ≥20× per span on average)");
		p("| label | h | per span | total ms | sql |");
		p("|---|---|---:|---:|---|");
		for (const x of nPlusOne) {
			p(`| ${x.label} | ${x.h} | ${x.perSpan} | ${x.ms} | \`${clip(sqlOf(x.h), 160).replaceAll("|", "\\|")}\` |`);
		}
		p();
	}
	p(`## Slowest ${top} spans by SQL time`);
	p("| id | ts | label | wall ms | sql ms | calls | attrs |");
	p("|---|---|---|---:|---:|---:|---|");
	for (const s of report.slowestSpans) {
		p(`| ${s.id} | ${s.ts} | ${s.label} | ${s.ms} | ${s.sqlMs} | ${s.n} | ${s.a ? JSON.stringify(s.a) : ""} |`);
	}
	p();
	p(`## Slowest ${top} individual statements`);
	p("| at | ms | rows | op | span | label | sql |");
	p("|---|---:|---:|---|---|---|---|");
	for (const s of report.slowestStatements) {
		p(`| ${s.at} | ${s.ms} | ${s.rows} | ${s.op} | ${s.span} | ${s.label} | \`${s.sql.replaceAll("|", "\\|")}\` |`);
	}
	if (report.slowestTransactions.length) {
		p();
		p(`## Slowest ${top} transactions`);
		p("| at | ms | span | label | site |");
		p("|---|---:|---|---|---|");
		for (const t of report.slowestTransactions) p(`| ${t.at} | ${t.ms} | ${t.span} | ${t.label} | ${t.site} |`);
	}
	p();
	p("Drill into one span (and its children): `bun run sql:report <day> --span <id>`.");
	console.log(lines.join("\n"));
}

await main();
