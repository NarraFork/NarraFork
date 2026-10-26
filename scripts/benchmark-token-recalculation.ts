/** Isolated, reproducible WAL benchmark. Never opens the application's database. */
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTokenRecalculation } from "../server/services/token-recalculation";
import { createTokenRecalculationWorkerStore } from "../server/services/token-recalculation-worker-client";
import type { TokenRecalculationJob } from "../shared/token-recalculation";

const sizes = process.argv.slice(2).map(Number);
if (sizes.some((size) => !Number.isInteger(size) || size < 1 || size > 1_000_000)) {
	throw new Error("Supply row counts between 1 and 1000000");
}
for (const size of sizes.length ? sizes : [100_000, 1_000_000]) {
	const directory = await mkdtemp(join(tmpdir(), "nf-token-recalculation-benchmark-"));
	const path = join(directory, "fixture.db");
	let db: Database | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let store: Awaited<ReturnType<typeof createTokenRecalculationWorkerStore>> | undefined;
	try {
		db = new Database(path);
		db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
			CREATE TABLE api_requests (
				id TEXT PRIMARY KEY, created_at TEXT NOT NULL, provider TEXT, model TEXT, credential_id TEXT,
				input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
				cache_creation_input_tokens INTEGER NOT NULL, cache_creation_5m_tokens INTEGER NOT NULL,
				cache_creation_1h_tokens INTEGER NOT NULL, token_accounting_version INTEGER
			);
			CREATE INDEX idx_api_requests_token_accounting_pending ON api_requests(created_at,id) WHERE token_accounting_version IS NULL;
			CREATE INDEX idx_api_requests_created ON api_requests(created_at,id);`);
		const insert = db.prepare(
			"INSERT INTO api_requests VALUES (?, ?, ?, 'fixture-model', NULL, ?, ?, 0, 0, 0, NULL)",
		);
		db.transaction(() => {
			for (let i = 0; i < size; i++)
				insert.run(
					String(i).padStart(9, "0"),
					"2026-01-01T00:00:00.000Z",
					i % 3 ? "openai" : "anthropic",
					10000,
					i % 5 ? 3000 : 0,
				);
		})();
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		let maxHeartbeatDelayMs = 0;
		let previous = performance.now();
		heartbeat = setInterval(() => {
			const now = performance.now();
			maxHeartbeatDelayMs = Math.max(maxHeartbeatDelayMs, now - previous - 10);
			previous = now;
		}, 10);
		const makeJob = (): TokenRecalculationJob => ({
			id: "benchmark",
			status: "running",
			startedAt: "2030-01-01T00:00:00.000Z",
			finishedAt: null,
			scanned: 0,
			processed: 0,
			changed: 0,
			skipped: 0,
			fallback: 0,
			error: null,
		});
		const started = performance.now();
		store = await createTokenRecalculationWorkerStore(path);
		const current = makeJob();
		const resolveProtocol = (row: { provider: string | null }) => ({
			protocol: row.provider === "anthropic" ? ("anthropic" as const) : ("openai" as const),
			fallback: false,
		});
		let slowBatches = 0;
		await runTokenRecalculation(
			current,
			store,
			resolveProtocol,
			new AbortController().signal,
			() => {
				slowBatches++;
			},
		);
		const elapsedMs = performance.now() - started;
		const rerun = makeJob();
		const rerunStart = performance.now();
		await runTokenRecalculation(rerun, store, resolveProtocol, new AbortController().signal);
		const rerunMs = performance.now() - rerunStart;
		clearInterval(heartbeat);
		heartbeat = undefined;
		if (current.processed !== size || current.skipped !== 0 || rerun.processed !== 0)
			throw new Error("Benchmark correctness check failed");
		const wrong = db
			.query(
				"SELECT count(*) AS count FROM api_requests WHERE token_accounting_version IS NOT 1 OR input_tokens != CASE WHEN provider='anthropic' THEN 10000 ELSE 10000-cached_input_tokens END",
			)
			.get() as { count: number };
		if (wrong.count) throw new Error("Benchmark row-value check failed");
		console.log(
			JSON.stringify({
				rows: size,
				processed: current.processed,
				changed: current.changed,
				elapsedMs: Math.round(elapsedMs),
				rowsPerSecond: Math.round((size * 1000) / elapsedMs),
				rerunMs: Math.round(rerunMs),
				rerunChanged: rerun.changed,
				maxHeartbeatDelayMs: Math.round(maxHeartbeatDelayMs),
				slowBatches,
			}),
		);
	} finally {
		if (heartbeat) clearInterval(heartbeat);
		await store?.close();
		db?.close();
		await rm(directory, { recursive: true, force: true });
	}
}
