import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "bun";
import type { TokenRecalculationJob } from "../../shared/token-recalculation";
import { tokenRecalculationRangeSchema } from "../lib/validators/token-recalculation";
import {
	recalculateTokenCounters,
	runTokenRecalculation,
	type TokenCounters,
	type TokenRecalculationRow,
	tokenRecalculationScanSql,
	tokenRecalculationScope,
} from "./token-recalculation";
import { createPostgresTokenRecalculationStore } from "./token-recalculation-postgres";
import {
	getTokenRecalculationService,
	TokenRecalculationService,
} from "./token-recalculation-service";
import { createSqliteTokenRecalculationStore } from "./token-recalculation-sqlite";
import { createTokenRecalculationWorkerStore } from "./token-recalculation-worker-client";

const databases: Database[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const db of databases.splice(0)) {
		try {
			db.close();
		} catch {}
	}
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
function fixture(path = ":memory:") {
	const db = new Database(path);
	databases.push(db);
	db.exec(`CREATE TABLE api_requests (
		id TEXT PRIMARY KEY, created_at TEXT NOT NULL, provider TEXT, model TEXT, credential_id TEXT,
		input_tokens INTEGER NOT NULL DEFAULT 10000, cached_input_tokens INTEGER NOT NULL DEFAULT 3000,
		cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
		cache_creation_5m_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_1h_tokens INTEGER NOT NULL DEFAULT 0,
		output_tokens INTEGER DEFAULT 22, cost_usd REAL DEFAULT 1.5, token_accounting_version INTEGER
	);
	CREATE INDEX idx_api_requests_token_accounting_pending ON api_requests(created_at,id) WHERE token_accounting_version IS NULL;`);
	return db;
}
function insert(
	db: Database,
	id: string,
	date = "2026-01-01T00:00:00.000Z",
	version: number | null = null,
) {
	db.prepare("INSERT INTO api_requests(id,created_at,token_accounting_version) VALUES (?,?,?)").run(
		id,
		date,
		version,
	);
}
function job(): TokenRecalculationJob {
	return {
		id: "job",
		status: "running",
		startedAt: "2026-10-26T12:00:00.000Z",
		finishedAt: null,
		scanned: 0,
		processed: 0,
		changed: 0,
		skipped: 0,
		fallback: 0,
		error: null,
	};
}
const resolver = (row: TokenRecalculationRow) => ({
	protocol: row.provider === "anthropic" ? ("anthropic" as const) : ("openai" as const),
	fallback: row.provider === null,
});
function counters(overrides: Partial<TokenCounters> = {}): TokenCounters {
	return {
		input_tokens: 10000,
		cached_input_tokens: 3000,
		cache_creation_input_tokens: 500,
		cache_creation_5m_tokens: 200,
		cache_creation_1h_tokens: 300,
		...overrides,
	};
}

describe("token counter conversion", () => {
	test("protocols, full hit, clamp and no double-counting cache-write buckets", () => {
		expect(recalculateTokenCounters(counters(), "openai")?.input_tokens).toBe(6500);
		expect(recalculateTokenCounters(counters(), "anthropic")?.input_tokens).toBe(10000);
		expect(recalculateTokenCounters(counters(), "gemini")?.input_tokens).toBe(7000);
		expect(
			recalculateTokenCounters(
				counters({
					input_tokens: 3000,
					cache_creation_input_tokens: 0,
					cache_creation_5m_tokens: 0,
					cache_creation_1h_tokens: 0,
				}),
				"openai",
			)?.input_tokens,
		).toBe(0);
		expect(recalculateTokenCounters(counters({ input_tokens: 1 }), "openai")?.input_tokens).toBe(0);
		expect(
			recalculateTokenCounters(counters({ cache_creation_input_tokens: 0 }), "openai")
				?.cache_creation_input_tokens,
		).toBe(500);
		expect(recalculateTokenCounters(counters({ input_tokens: -1 }), "openai")).toBeNull();
	});
	test("UTC date ranges are validated and end date includes the whole day", () => {
		expect(tokenRecalculationRangeSchema.safeParse({ startDate: "2026-02-30" }).success).toBe(
			false,
		);
		expect(
			tokenRecalculationRangeSchema.safeParse({ startDate: "2026-02-03", endDate: "2026-02-02" })
				.success,
		).toBe(false);
		expect(
			tokenRecalculationRangeSchema.safeParse({ startDate: "2026-01-01", force: true }).success,
		).toBe(false);
		expect(
			tokenRecalculationScope({ ...job(), startDate: "2026-01-01", endDate: "2026-01-01" }),
		).toEqual({ start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" });
	});
});

describe("batch recalculation", () => {
	test("processes over 10k rows, marks unchanged rows, and reruns are no-ops", async () => {
		const db = fixture();
		db.transaction(() => {
			for (let i = 0; i < 10_501; i++) insert(db, String(i));
		})();
		insert(db, "new-writer", undefined, 1);
		db.run("UPDATE api_requests SET provider='anthropic' WHERE id='0'");
		const store = createSqliteTokenRecalculationStore(db);
		const first = job();
		await runTokenRecalculation(first, store, resolver, new AbortController().signal);
		expect(first).toMatchObject({
			scanned: 10_501,
			processed: 10_501,
			changed: 10_500,
			skipped: 0,
			fallback: 10_500,
		});
		expect(
			db
				.query(
					"SELECT input_tokens,token_accounting_version,output_tokens,cost_usd FROM api_requests WHERE id='1'",
				)
				.get(),
		).toEqual({
			input_tokens: 7000,
			token_accounting_version: 1,
			output_tokens: 22,
			cost_usd: 1.5,
		});
		expect(db.query("SELECT input_tokens FROM api_requests WHERE id='new-writer'").get()).toEqual({
			input_tokens: 10000,
		});
		const again = job();
		await runTokenRecalculation(again, store, resolver, new AbortController().signal);
		expect(again).toMatchObject({ scanned: 0, processed: 0, changed: 0 });
		const scan = tokenRecalculationScanSql(tokenRecalculationScope(job()));
		const plan = JSON.stringify(db.query(`EXPLAIN QUERY PLAN ${scan.sql}`).all(...scan.params));
		expect(plan).toContain("idx_api_requests_token_accounting_pending");
	});
	test("scope excludes rows outside dates and rows inserted after the job boundary", async () => {
		const db = fixture();
		insert(db, "before", "2025-12-31T23:59:59.999Z");
		insert(db, "during", "2026-01-01T23:59:59.999Z");
		insert(db, "after", "2026-01-02T00:00:00.000Z");
		insert(db, "future", "2030-01-01T00:00:00.000Z");
		const current = { ...job(), startDate: "2026-01-01", endDate: "2026-01-01" };
		await runTokenRecalculation(
			current,
			createSqliteTokenRecalculationStore(db),
			resolver,
			new AbortController().signal,
		);
		expect(current.processed).toBe(1);
		expect(
			db.query("SELECT id FROM api_requests WHERE token_accounting_version = 1").all(),
		).toEqual([{ id: "during" }]);
	});
	test("concurrent updates and invalid counters are skipped, not overwritten", async () => {
		const db = fixture();
		insert(db, "changed");
		insert(db, "invalid");
		db.run("UPDATE api_requests SET input_tokens=-2 WHERE id='invalid'");
		const store = createSqliteTokenRecalculationStore(db);
		const current = job();
		await runTokenRecalculation(
			current,
			{
				...store,
				async apply(updates) {
					db.run("UPDATE api_requests SET input_tokens=42 WHERE id='changed'");
					return store.apply(updates);
				},
			},
			resolver,
			new AbortController().signal,
		);
		expect(current).toMatchObject({ scanned: 2, processed: 0, skipped: 2 });
		expect(db.query("SELECT input_tokens FROM api_requests WHERE id='changed'").get()).toEqual({
			input_tokens: 42,
		});
	});
	test("cancellation preserves committed batches and restart only handles remaining rows", async () => {
		const db = fixture();
		db.transaction(() => {
			for (let i = 0; i < 1200; i++) insert(db, String(i));
		})();
		const store = createSqliteTokenRecalculationStore(db);
		const controller = new AbortController();
		const first = job();
		await runTokenRecalculation(
			first,
			{
				...store,
				async apply(updates) {
					const result = await store.apply(updates);
					controller.abort();
					return result;
				},
			},
			resolver,
			controller.signal,
		);
		expect(first.processed).toBe(500);
		const second = job();
		await runTokenRecalculation(second, store, resolver, new AbortController().signal);
		expect(second.processed).toBe(700);
		expect(db.query("SELECT DISTINCT input_tokens FROM api_requests").all()).toEqual([
			{ input_tokens: 7000 },
		]);
	});
	test("batch rollback includes the version marker", async () => {
		const db = fixture();
		insert(db, "a");
		insert(db, "b");
		db.exec(
			"CREATE TRIGGER reject_b BEFORE UPDATE ON api_requests WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
		);
		const current = job();
		await expect(
			runTokenRecalculation(
				current,
				createSqliteTokenRecalculationStore(db),
				resolver,
				new AbortController().signal,
			),
		).rejects.toThrow("fixture failure");
		expect(
			db
				.query(
					"SELECT count(*) AS n FROM api_requests WHERE token_accounting_version IS NULL AND input_tokens=10000",
				)
				.get(),
		).toEqual({ n: 2 });
		expect(current.processed).toBe(0);
	});
	test("worker operates on an isolated WAL database and can close/reopen", async () => {
		const directory = await mkdtemp(join(tmpdir(), "nf-token-recalculation-test-"));
		directories.push(directory);
		const path = join(directory, "fixture.db");
		const db = fixture(path);
		insert(db, "a");
		const store = await createTokenRecalculationWorkerStore(path);
		try {
			const current = job();
			await runTokenRecalculation(current, store, resolver, new AbortController().signal);
			expect(current.processed).toBe(1);
		} finally {
			await store.close();
		}
		expect(db.query("SELECT input_tokens FROM api_requests").get()).toEqual({ input_tokens: 7000 });
	}, 30_000);
	test("PostgreSQL sends one CAS update for the batch with transaction-local limits", async () => {
		const calls: Array<{ text: string; params?: unknown[] }> = [];
		const client = {
			begin: async (fn: (tx: unknown) => Promise<unknown>) =>
				fn({
					unsafe: async (text: string, params?: unknown[]) => {
						calls.push({ text, params });
						return text.startsWith("WITH changes") ? [{ id: "a" }] : [];
					},
				}),
		} as unknown as SQL;
		const store = createPostgresTokenRecalculationStore(client);
		const before: TokenRecalculationRow = {
			...counters(),
			id: "a",
			created_at: "2026-01-01",
			provider: null,
			model: null,
			credential_id: null,
		};
		const after = recalculateTokenCounters(before, "openai");
		if (!after) throw new Error("Expected valid fixture counters");
		expect(await store.apply([{ before, after, fallback: true }])).toEqual({
			processed: 1,
			changed: 1,
			fallback: 1,
		});
		expect(calls).toHaveLength(3);
		expect(calls[2]?.text).toContain("a.token_accounting_version IS NULL");
		expect(calls[2]?.text).toContain("IS NOT DISTINCT FROM");
		expect(JSON.parse(calls[2]?.params?.[0] as string)[0]).toMatchObject({
			old_input_tokens: 10000,
			input_tokens: 6500,
		});
	});
});

describe("single in-memory job", () => {
	test("rejects overlapping jobs, cancellation is harmless, status is a snapshot", async () => {
		const db = fixture();
		insert(db, "a");
		const service = new TokenRecalculationService({
			createStore: async () => createSqliteTokenRecalculationStore(db),
			createResolver: async () => resolver,
		});
		const started = service.start({});
		started.scanned = 999;
		expect(service.get()?.scanned).toBe(0);
		expect(() => service.start({})).toThrow("already running");
		expect(() => service.cancel("other")).toThrow("not found");
		service.cancel(started.id);
		await service.wait();
		expect(service.get()?.status).toBe("cancelled");
		expect(service.get()?.processed).toBe(0);
	});
	test("errors don't leak driver credentials and don't leave the job running", async () => {
		const service = new TokenRecalculationService({
			createStore: async () => {
				throw new Error("secret postgres credentials");
			},
			createResolver: async () => resolver,
		});
		service.start({});
		await service.wait();
		expect(service.get()?.status).toBe("failed");
		expect(service.get()?.error).not.toContain("secret");
		expect(service.get()?.finishedAt).not.toBeNull();
	});
});

// Exercise the real lazy wiring, not just injected stores. Test preload isolates this DB/home.
test("production service wiring converts fixture history through its worker and protocol resolver", async () => {
	const { sqlite } = await import("../db");
	const id = `token-recalc-wiring-${crypto.randomUUID()}`;
	sqlite
		.prepare(
			"INSERT INTO api_requests(id,created_at,provider,model,input_tokens,cached_input_tokens) VALUES (?,?,?,?,?,?)",
		)
		.run(
			id,
			"2026-01-01T12:00:00.000Z",
			"unrecognized-fixture-provider",
			"fixture-model",
			10000,
			3000,
		);
	const service = getTokenRecalculationService();
	try {
		service.start({ startDate: "2026-01-01", endDate: "2026-01-01" });
		await service.wait();
		expect(service.get()).toMatchObject({
			status: "completed",
			processed: 1,
			changed: 1,
			fallback: 1,
		});
		expect(
			sqlite
				.query("SELECT input_tokens,token_accounting_version FROM api_requests WHERE id=?")
				.get(id),
		).toEqual({ input_tokens: 7000, token_accounting_version: 1 });
	} finally {
		sqlite.prepare("DELETE FROM api_requests WHERE id=?").run(id);
	}
}, 30_000);
