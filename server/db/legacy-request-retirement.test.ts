import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyPendingMigrationsByHash } from "./run-migrations";
import { apiRequests, narrators, users } from "./schema";

const source = join(import.meta.dir, "../../drizzle");
const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8")) as {
	entries: Array<{ tag: string }>;
};
const retirementIndex = journal.entries.findIndex(
	(entry) => entry.tag === "0207_drop_legacy_request_dumps",
);
const folders: string[] = [];
const mib = 1024 * 1024;

afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function migrationFolder(entries: typeof journal.entries): string {
	const folder = mkdtempSync(join(tmpdir(), "nf-legacy-retirement-"));
	folders.push(folder);
	mkdirSync(join(folder, "meta"));
	writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
	for (const entry of entries) {
		writeFileSync(join(folder, `${entry.tag}.sql`), readFileSync(join(source, `${entry.tag}.sql`)));
	}
	return folder;
}

function legacyDatabase(path = ":memory:"): Database {
	expect(retirementIndex).toBeGreaterThan(0);
	const database = new Database(path);
	try {
		database.run("PRAGMA foreign_keys=ON");
		database.run("PRAGMA cache_size=-4096");
		applyPendingMigrationsByHash(
			database,
			migrationFolder(journal.entries.slice(0, retirementIndex)),
		);
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

describe("populated legacy request storage upgrade", () => {
	test("upgrades the real pre-0207 journal through current and preserves ORM CRUD and foreign keys", () => {
		const database = legacyDatabase();
		try {
			database.run(`INSERT INTO api_requests
				(id, created_at, provider, model, input_tokens, raw_dump_json)
				VALUES ('old', '2026-10-01', 'synthetic', 'old-model', 123, 'private-history')`);
			database.run(`INSERT INTO usage_token_repair_jobs
				(id, status, created_by, created_at, updated_at, include_reviewed)
				VALUES ('job', 'completed', 'deleted-user', '2026-10-01', '2026-10-01', 0)`);
			database.run(`INSERT INTO usage_token_repair_candidates
				(id, job_id, request_id, created_at, snapshot_json, evidence_json)
				VALUES ('candidate', 'job', 'old', '2026-10-01', '{}', '{}')`);

			// Includes the real 0208–0212 suffix and every later published migration.
			applyPendingMigrationsByHash(database, source);
			expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(
				database.prepare("SELECT raw_dump_json FROM api_requests WHERE id='old'").get(),
			).toEqual({
				raw_dump_json: "private-history",
			});
			const orm = drizzle(database);
			const old = orm.select().from(apiRequests).where(eq(apiRequests.id, "old")).get();
			expect(old?.inputTokens).toBe(123);
			expect(old).not.toHaveProperty("raw_dump_json");
			expect(old).not.toHaveProperty("rawDumpJson");
			expect(orm.select().from(apiRequests).toSQL().sql).not.toContain("raw_dump_json");
			orm
				.insert(apiRequests)
				.values({ id: "new", createdAt: "2026-10-23", model: "new-model" })
				.run();
			orm.update(apiRequests).set({ outputTokens: 42 }).where(eq(apiRequests.id, "new")).run();
			expect(
				orm.select().from(apiRequests).where(eq(apiRequests.id, "new")).get()?.outputTokens,
			).toBe(42);
			expect(
				database
					.prepare(`SELECT raw_dump_json, token_accounting_version, token_accounting_review_version
				FROM api_requests WHERE id='new'`)
					.get(),
			).toEqual({
				raw_dump_json: null,
				token_accounting_version: null,
				token_accounting_review_version: null,
			});
			// Retained repair rows must not block user deletion or request/session cascades.
			orm
				.insert(users)
				.values({
					id: "deleted-user",
					username: "retirement-fixture",
					passwordHash: "not-a-password",
					createdAt: "2026-10-23",
				})
				.run();
			orm.delete(users).where(eq(users.id, "deleted-user")).run();
			orm
				.insert(narrators)
				.values({
					id: "deleted-session",
					createdAt: "2026-10-23",
					updatedAt: "2026-10-23",
				})
				.run();
			orm
				.update(apiRequests)
				.set({ narratorId: "deleted-session" })
				.where(eq(apiRequests.id, "old"))
				.run();
			orm.delete(narrators).where(eq(narrators.id, "deleted-session")).run();
			expect(orm.select().from(apiRequests).where(eq(apiRequests.id, "old")).get()).toBeUndefined();
			// The repair tables and indexes are dropped now; only the column rewrites wait.
			expect(
				database
					.prepare(
						"SELECT name FROM sqlite_master WHERE name GLOB '*token_repair*' AND sql IS NOT NULL",
					)
					.all(),
			).toEqual([]);
			expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			const ledger = database.prepare("SELECT hash, created_at FROM __drizzle_migrations").all();
			expect(
				ledger.some((row) =>
					String((row as { hash: string }).hash).startsWith(
						"narrafork:0207-logical-retirement:v1:",
					),
				),
			).toBe(true);
			applyPendingMigrationsByHash(database, source);
			expect(database.prepare("SELECT hash, created_at FROM __drizzle_migrations").all()).toEqual(
				ledger,
			);
		} finally {
			database.close();
		}
	}, 30_000);
});

interface ResourceResult {
	elapsedMs: number;
	walGrowth: number;
	rssDelta: number;
	peakRssDelta: number;
	peakRss: number;
}

// The child starts AFTER fixture creation: fixture allocation cannot mask a migration RSS spike.
// No giant stdout capture, production DB, long-running service, or automatic maintenance.
const resourceProbe = String.raw`
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
const { applyPendingMigrationsByHash } = await import(process.argv[1]);
const [path, folder] = process.argv.slice(2);
const db = new Database(path);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250; PRAGMA cache_size=-16000; PRAGMA temp_store=MEMORY; PRAGMA mmap_size=268435456; PRAGMA wal_autocheckpoint=1000;");
const size = () => { try { return statSync(path + "-wal").size; } catch { return 0; } };
// Only the bounded presence probe may name the payload column; table/index drops are cheap.
const PRESENCE_PROBE = /^SELECT 1 FROM api_requests WHERE raw_dump_json IS NOT NULL LIMIT 1$/;
const guard = (sql) => {
  if (PRESENCE_PROBE.test(sql.trim())) return;
  if (/\b(ALTER|UPDATE|DELETE|VACUUM|REPLACE)\b/i.test(sql) ||
      /\b(COUNT|SUM|AVG|length|raw_dump_json)\b/i.test(sql)) {
    throw new Error("Unexpected physical cleanup or payload/aggregate read in retirement");
  }
};
const run = db.run.bind(db), prepare = db.prepare.bind(db);
const exec = db.exec.bind(db), query = db.query.bind(db);
db.run = (sql, ...args) => { guard(sql); return run(sql, ...args); };
db.prepare = (sql, ...args) => { guard(sql); return prepare(sql, ...args); };
db.exec = (sql, ...args) => { guard(sql); return exec(sql, ...args); };
db.query = (sql, ...args) => { guard(sql); return query(sql, ...args); };
const wal = size(), rss = process.memoryUsage.rss(), peak = process.resourceUsage().maxRSS * 1024;
const start = performance.now();
applyPendingMigrationsByHash(db, folder);
const result = { elapsedMs: performance.now()-start, walGrowth:size()-wal,
  rssDelta:process.memoryUsage.rss()-rss, peakRssDelta:process.resourceUsage().maxRSS*1024-peak,
  peakRss:process.resourceUsage().maxRSS*1024 };
const afterFirst = size();
applyPendingMigrationsByHash(db, folder);
if (size() !== afterFirst) throw new Error("Repeated startup wrote to the WAL");
const receipt = prepare("SELECT hash FROM __drizzle_migrations WHERE hash LIKE 'narrafork:0207-logical-retirement:v1:%'").get();
if (!receipt) throw new Error("Missing logical retirement receipt");
console.log("NF_LEGACY_RESOURCE_RESULT:" + JSON.stringify(result));
db.close();
`;

test("0207 resource budget is independent of 8MiB versus 1GiB of retained dumps", () => {
	const results: ResourceResult[] = [];
	const folder = migrationFolder([journal.entries[retirementIndex]]);
	for (const payloadMiB of [8, 1024]) {
		const path = join(folder, `synthetic-${payloadMiB}.sqlite`);
		// Minimal known pre-0207 tables isolate this migration's resource cost.
		const database = new Database(path);
		try {
			database.exec(`PRAGMA cache_size=-4096;
				CREATE TABLE api_requests (id text PRIMARY KEY, raw_dump_json text,
					token_accounting_version integer, token_accounting_review_version integer);
				CREATE TABLE usage_token_repair_jobs (id text PRIMARY KEY);
				CREATE TABLE usage_token_repair_candidates (id text PRIMARY KEY);`);
			const insert = database.prepare("INSERT INTO api_requests (id, raw_dump_json) VALUES (?, ?)");
			const payload = "x".repeat(mib);
			// Small fixture-building transactions, never one multi-GB transaction.
			for (let first = 0; first < payloadMiB; first += 8) {
				database.transaction(() => {
					for (let row = first; row < Math.min(first + 8, payloadMiB); row++) {
						insert.run(String(row), payload);
					}
				})();
			}
		} finally {
			database.close();
		}
		const bytesBefore = statSync(path).size;
		expect(bytesBefore).toBeGreaterThanOrEqual(payloadMiB * mib);
		const child = spawnSync(
			process.execPath,
			[
				"-e",
				resourceProbe,
				pathToFileURL(join(import.meta.dir, "run-migrations.ts")).href,
				path,
				folder,
			],
			{ encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 },
		);
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		const line = child.stdout
			.split("\n")
			.find((line) => line.startsWith("NF_LEGACY_RESOURCE_RESULT:"));
		expect(line).toBeDefined();
		const result = JSON.parse(
			line?.slice("NF_LEGACY_RESOURCE_RESULT:".length) ?? "null",
		) as ResourceResult;
		expect(result.elapsedMs).toBeLessThan(5_000);
		expect(result.walGrowth).toBeLessThan(16 * mib);
		expect(result.rssDelta).toBeLessThan(64 * mib);
		expect(result.peakRssDelta).toBeLessThan(64 * mib);
		// No physical rewrite/shrink of the fixture (ledger pages may be appended).
		expect(statSync(path).size).toBeGreaterThanOrEqual(bytesBefore);
		console.info("Legacy request retirement resource measurement", { payloadMiB, ...result });
		results.push(result);
	}
	expect(results[1].peakRss).toBeLessThan(results[0].peakRss + 64 * mib);
}, 120_000);
