import { Database } from "bun:sqlite";
import { basename, resolve } from "node:path";
import { getDbPath } from "../db/connection";

type BenchmarkRow = Record<string, unknown>;
type PlanRow = { detail?: string };

type Options = {
	database: string;
	narratorId?: string;
	limit: number;
	iterations: number;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv: string[]): Options | null {
	const values = new Map<string, string>();
	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") return null;
		if (!arg.startsWith("--")) continue;
		const separator = arg.indexOf("=");
		if (separator < 0) {
			values.set(arg.slice(2), "true");
			continue;
		}
		values.set(arg.slice(2, separator), arg.slice(separator + 1));
	}

	return {
		database: resolve(values.get("database") ?? getDbPath()),
		narratorId: values.get("narrator"),
		limit: Math.min(parsePositiveInt(values.get("limit"), 200), 2_000),
		iterations: Math.min(parsePositiveInt(values.get("iterations"), 20), 200),
	};
}

function printUsage(): void {
	console.log(`Usage:
  bun server/scripts/benchmark-narrator-history.ts [options]

Options:
  --database=/path/to/narrafork.db  Read-only SQLite database (default: configured DB)
  --narrator=<id>                   Narrator to inspect (default: first narrator)
  --limit=200                       Maximum visible messages per iteration (max 2000)
  --iterations=20                   Timed iterations (max 200)
  --help                            Show this help

The script only reads SQLite and compares narrow-vs-full row projection in the same
 database. It does not compare different database engines or modify the database.`);
}

function percentile(values: number[], ratio: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio));
	return sorted[index] ?? 0;
}

function summarizeDurations(values: number[]): string {
	return (
		`p50=${percentile(values, 0.5).toFixed(3)}ms ` +
		`p95=${percentile(values, 0.95).toFixed(3)}ms ` +
		`min=${Math.min(...values).toFixed(3)}ms ` +
		`max=${Math.max(...values).toFixed(3)}ms`
	);
}

function jsonBytes(rows: BenchmarkRow[]): number {
	return Buffer.byteLength(JSON.stringify(rows));
}

const NARROW_SQL = `
	SELECT
		r.seq AS seq,
		m.id AS id,
		m.narrator_id AS narratorId,
		m.role AS role,
		m.content_json AS contentJson,
		m.content_text AS contentText,
		m.parent_tool_use_id AS parentToolUseId,
		m.sdk_message_uuid AS messageUuid
	FROM narrator_message_refs r
	INNER JOIN narrator_messages m ON m.id = r.message_id
	WHERE r.narrator_id = ?
		AND r.seq > ?
		AND r.segment_compact_id IS NULL
	ORDER BY r.seq
	LIMIT ?
`;

const FULL_SQL = `
	SELECT r.seq AS seq, m.*
	FROM narrator_message_refs r
	INNER JOIN narrator_messages m ON m.id = r.message_id
	WHERE r.narrator_id = ?
		AND r.seq > ?
		AND r.segment_compact_id IS NULL
	ORDER BY r.seq
	LIMIT ?
`;

const NARROW_FIELDS = [
	"seq",
	"id",
	"narratorId",
	"role",
	"contentJson",
	"contentText",
	"parentToolUseId",
	"messageUuid",
];

function getNarratorId(sqlite: Database, requestedId?: string): string {
	if (requestedId) return requestedId;
	const row = sqlite.prepare("SELECT id FROM narrators ORDER BY created_at, id LIMIT 1").get() as {
		id: string;
	} | null;
	if (!row) throw new Error("No narrator exists in the selected database; pass --narrator=<id>.");
	return row.id;
}

function getCompactSeq(sqlite: Database, narratorId: string): number {
	const row = sqlite
		.prepare(
			`SELECT seq
			 FROM narrator_message_refs
			 WHERE narrator_id = ?
				 AND is_compact = 1
				 AND segment_compact_id IS NULL
			 ORDER BY seq DESC
			 LIMIT 1`,
		)
		.get(narratorId) as { seq: number } | null;
	return row?.seq ?? 0;
}

function runBenchmark(
	sqlite: Database,
	sql: string,
	narratorId: string,
	compactSeq: number,
	limit: number,
	iterations: number,
): { rows: BenchmarkRow[]; durations: number[]; bytes: number; queryCount: number } {
	const statement = sqlite.prepare(sql);
	let rows: BenchmarkRow[] = [];
	for (let i = 0; i < 2; i++) statement.all(narratorId, compactSeq, limit);

	const durations: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const started = performance.now();
		rows = statement.all(narratorId, compactSeq, limit) as BenchmarkRow[];
		durations.push(performance.now() - started);
	}
	return { rows, durations, bytes: jsonBytes(rows), queryCount: 1 };
}

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	if (!options) {
		printUsage();
		return;
	}

	const sqlite = new Database(options.database, { readonly: true });
	try {
		const narratorId = getNarratorId(sqlite, options.narratorId);
		const compactSeq = getCompactSeq(sqlite, narratorId);
		const narrow = runBenchmark(
			sqlite,
			NARROW_SQL,
			narratorId,
			compactSeq,
			options.limit,
			options.iterations,
		);
		const full = runBenchmark(
			sqlite,
			FULL_SQL,
			narratorId,
			compactSeq,
			options.limit,
			options.iterations,
		);
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${NARROW_SQL}`)
			.all(narratorId, compactSeq, options.limit) as PlanRow[];

		const byteReduction = full.bytes > 0 ? ((full.bytes - narrow.bytes) / full.bytes) * 100 : 0;
		console.log(`database=${basename(options.database)}`);
		console.log(`narrator=${narratorId}`);
		console.log(`postCompactSeq=${compactSeq}`);
		console.log(`limit=${options.limit} iterations=${options.iterations}`);
		console.log(`rows=${narrow.rows.length}`);
		console.log(`narrowProjectionQueryCount=${narrow.queryCount}`);
		console.log(`fullProjectionQueryCount=${full.queryCount}`);
		console.log(`narrowFields=${NARROW_FIELDS.join(",")}`);
		console.log("fullFields=*");
		console.log(`narrow ${summarizeDurations(narrow.durations)} payload=${narrow.bytes}B`);
		console.log(`full   ${summarizeDurations(full.durations)} payload=${full.bytes}B`);
		console.log(`payloadReduction=${byteReduction.toFixed(2)}%`);
		console.log("narrowQueryPlan:");
		for (const row of plan) console.log(`  ${row.detail ?? "<unknown>"}`);
	} finally {
		sqlite.close();
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
