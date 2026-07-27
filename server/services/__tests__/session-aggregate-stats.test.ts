/**
 * Numeric-equivalence tests for the pure-SQL rewrite of `collectSessionAggregateStats`.
 *
 * The original implementation materialised every candidate `narrator_messages` id into a JS array
 * with an unbounded `.all()`, inserted them into a TEMP table row by row, and then joined against
 * that table. That is forbidden on the main thread, but the numbers it produced are the contract:
 * they drive the byte estimate shown in the cleanup preview. `legacyCollectSessionAggregateStats`
 * below reproduces the old algorithm verbatim so the rewrite can be diffed against it on real
 * SQLite data instead of against hand-written expectations.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectSessionAggregateStats,
	countQuery,
	quoteIdentifier,
	type SessionAggregateStats,
	type SessionOwnedTableRelation,
	sumTableApproxBytes,
	tableExists,
} from "../storage-scan-queries";

const RELATIONS: SessionOwnedTableRelation[] = [
	{ tableName: "narrator_message_refs", alias: "r", narratorColumn: "narrator_id" },
	{
		tableName: "narrator_tool_calls",
		alias: "tc",
		narratorColumn: "narrator_id",
		countAs: "toolCalls",
	},
	{ tableName: "narrator_sidecars", alias: "ns", narratorColumn: "narrator_id" },
	{ tableName: "api_requests", alias: "ar", narratorColumn: "narrator_id", countAs: "apiRequests" },
	{ tableName: "terminals", alias: "t", narratorColumn: "narrator_id" },
	{ tableName: "narrator_file_snapshots", alias: "nfs", narratorColumn: "narrator_id" },
	// Intentionally includes a table the fixture never creates, to exercise the tableExists guard.
	{ tableName: "table_that_does_not_exist", alias: "nope", narratorColumn: "narrator_id" },
];

/** The pre-rewrite algorithm, kept only as a test oracle. */
function legacyCollectSessionAggregateStats(
	sqlite: Database,
	narratorIds: string[],
	relations: SessionOwnedTableRelation[],
): SessionAggregateStats {
	if (narratorIds.length === 0) {
		return {
			narrators: 0,
			messages: 0,
			toolCalls: 0,
			apiRequests: 0,
			dumpsCleared: 0,
			approxBytes: 0,
		};
	}

	const withTempIdTable = <T>(ids: string[], prefix: string, fn: (tableName: string) => T): T => {
		const tableName = `temp_${prefix}_${Math.random().toString(36).slice(2, 10)}`;
		sqlite.run(`CREATE TEMP TABLE ${tableName} (id TEXT PRIMARY KEY)`);
		try {
			const insert = sqlite.prepare(`INSERT OR IGNORE INTO ${tableName} (id) VALUES (?)`);
			for (const id of ids) insert.run(id);
			return fn(tableName);
		} finally {
			sqlite.run(`DROP TABLE IF EXISTS ${tableName}`);
		}
	};

	return withTempIdTable(narratorIds, "cleanup_narrators", (narratorTable) => {
		const narratorFrom = `FROM narrators n JOIN ${narratorTable} target_n ON target_n.id = n.id`;
		const narrators = countQuery(sqlite, narratorFrom);
		let toolCalls = 0;
		let apiRequests = 0;
		let approxBytes = sumTableApproxBytes(sqlite, "narrators", "n", narratorFrom);

		for (const relation of relations) {
			if (!tableExists(sqlite, relation.tableName)) continue;
			const fromClause = `FROM ${quoteIdentifier(relation.tableName)} ${relation.alias}
				JOIN ${narratorTable} target_n ON target_n.id = ${relation.alias}.${quoteIdentifier(
					relation.narratorColumn,
				)}`;
			const count = countQuery(sqlite, fromClause);
			approxBytes += sumTableApproxBytes(sqlite, relation.tableName, relation.alias, fromClause);
			if (relation.countAs === "toolCalls") toolCalls += count;
			else if (relation.countAs === "apiRequests") apiRequests += count;
		}

		let dumpsCleared = 0;
		if (tableExists(sqlite, "api_requests")) {
			dumpsCleared = countQuery(
				sqlite,
				`FROM api_requests ar
				 JOIN ${narratorTable} target_n ON target_n.id = ar.narrator_id
				 WHERE ar.raw_dump_json IS NOT NULL`,
			);
		}

		if (tableExists(sqlite, "background_tasks")) {
			const fromClause = `FROM background_tasks bt
				WHERE EXISTS (
					SELECT 1 FROM ${narratorTable} target_n
					WHERE target_n.id = bt.parent_narrator_id
					   OR target_n.id = bt.subagent_narrator_id
				)`;
			approxBytes += sumTableApproxBytes(sqlite, "background_tasks", "bt", fromClause);
		}

		const messageIds = tableExists(sqlite, "narrator_messages")
			? (sqlite
					.prepare(
						`SELECT m.id AS id
						 FROM narrator_messages m
						 JOIN ${narratorTable} target_n ON target_n.id = m.narrator_id
						 WHERE NOT EXISTS (
							SELECT 1
							FROM narrator_message_refs r
							WHERE r.message_id = m.id
							  AND r.narrator_id NOT IN (SELECT id FROM ${narratorTable})
						 )`,
					)
					.all() as Array<{ id: string }>)
			: [];
		const messageIdList = messageIds.map((row) => row.id);
		let messages = 0;
		if (messageIdList.length > 0) {
			messages = messageIdList.length;
			approxBytes += withTempIdTable(messageIdList, "cleanup_messages", (messageTable) =>
				sumTableApproxBytes(
					sqlite,
					"narrator_messages",
					"m",
					`FROM narrator_messages m JOIN ${messageTable} target_m ON target_m.id = m.id`,
				),
			);
		}

		return { narrators, messages, toolCalls, apiRequests, dumpsCleared, approxBytes };
	});
}

function createCleanupFixture(dbPath: string): void {
	const db = new Database(dbPath);
	db.run("CREATE TABLE narrators (id TEXT PRIMARY KEY, title TEXT, status TEXT)");
	db.run(
		"CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, narrator_id TEXT, content_json TEXT)",
	);
	db.run(
		"CREATE TABLE narrator_message_refs (id TEXT PRIMARY KEY, narrator_id TEXT, message_id TEXT, seq INTEGER)",
	);
	db.run("CREATE TABLE narrator_tool_calls (id TEXT PRIMARY KEY, narrator_id TEXT, name TEXT)");
	db.run("CREATE TABLE narrator_sidecars (id TEXT PRIMARY KEY, narrator_id TEXT, payload TEXT)");
	db.run(
		"CREATE TABLE api_requests (id TEXT PRIMARY KEY, narrator_id TEXT, raw_dump_json TEXT, created_at TEXT)",
	);
	db.run("CREATE TABLE terminals (id TEXT PRIMARY KEY, narrator_id TEXT, status TEXT)");
	db.run(
		"CREATE TABLE narrator_file_snapshots (id TEXT PRIMARY KEY, narrator_id TEXT, content TEXT)",
	);
	db.run(
		"CREATE TABLE background_tasks (id TEXT PRIMARY KEY, parent_narrator_id TEXT, subagent_narrator_id TEXT, command TEXT)",
	);

	const seed = db.transaction(() => {
		for (let i = 0; i < 12; i++) {
			const narratorId = `n${i}`;
			db.prepare("INSERT INTO narrators VALUES (?, ?, ?)").run(
				narratorId,
				`narrator ${i}`,
				i % 3 === 0 ? "archived" : "idle",
			);
			for (let m = 0; m < 4; m++) {
				const messageId = `msg-${i}-${m}`;
				db.prepare("INSERT INTO narrator_messages VALUES (?, ?, ?)").run(
					messageId,
					narratorId,
					JSON.stringify({ type: "text", text: "z".repeat(30 + m * 7) }),
				);
				// Own ref, always inside the candidate set when this narrator is a target.
				db.prepare("INSERT INTO narrator_message_refs VALUES (?, ?, ?, ?)").run(
					`ref-${i}-${m}-self`,
					narratorId,
					messageId,
					m,
				);
				// Every 3rd message is ALSO referenced by an unrelated narrator, so it survives cleanup
				// and must be excluded from the message count and byte total.
				if (m % 3 === 0) {
					db.prepare("INSERT INTO narrator_message_refs VALUES (?, ?, ?, ?)").run(
						`ref-${i}-${m}-shared`,
						"survivor",
						messageId,
						m,
					);
				}
			}
			db.prepare("INSERT INTO narrator_tool_calls VALUES (?, ?, ?)").run(
				`tc-${i}`,
				narratorId,
				"bash",
			);
			db.prepare("INSERT INTO narrator_sidecars VALUES (?, ?, ?)").run(
				`sc-${i}`,
				narratorId,
				"sidecar payload",
			);
			db.prepare("INSERT INTO api_requests VALUES (?, ?, ?, ?)").run(
				`ar-${i}`,
				narratorId,
				i % 2 === 0 ? "dump-".repeat(20) : null,
				"2024-01-01T00:00:00.000Z",
			);
			db.prepare("INSERT INTO terminals VALUES (?, ?, ?)").run(`t-${i}`, narratorId, "exited");
			db.prepare("INSERT INTO narrator_file_snapshots VALUES (?, ?, ?)").run(
				`fs-${i}`,
				narratorId,
				"snapshot body",
			);
			db.prepare("INSERT INTO background_tasks VALUES (?, ?, ?, ?)").run(
				`bt-${i}`,
				narratorId,
				i % 4 === 0 ? `n${(i + 1) % 12}` : null,
				"echo hi",
			);
		}
		// A narrator that keeps shared messages alive but is never a cleanup target.
		db.prepare("INSERT INTO narrators VALUES (?, ?, ?)").run("survivor", "survivor", "idle");
	});
	seed();
	db.close();
}

describe("collectSessionAggregateStats", () => {
	let home = "";
	let dbPath = "";
	let db: Database;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "narrafork-session-aggregate-"));
		dbPath = join(home, "fixture.db");
		createCleanupFixture(dbPath);
		db = new Database(dbPath);
	});

	afterEach(() => {
		db.close();
		rmSync(home, { recursive: true, force: true });
	});

	test("matches the legacy TEMP-table implementation field for field", () => {
		const targets = ["n0", "n1", "n2", "n3", "n4"];
		const legacy = legacyCollectSessionAggregateStats(db, targets, RELATIONS);
		const rewritten = collectSessionAggregateStats(db, targets, RELATIONS);
		expect(rewritten).toEqual(legacy);
		// Guard against a vacuous comparison: the fixture must produce real numbers.
		expect(legacy.narrators).toBe(5);
		expect(legacy.messages).toBeGreaterThan(0);
		expect(legacy.toolCalls).toBe(5);
		expect(legacy.approxBytes).toBeGreaterThan(0);
	});

	test("matches the legacy implementation for the whole candidate set", () => {
		const targets = Array.from({ length: 12 }, (_, i) => `n${i}`);
		expect(collectSessionAggregateStats(db, targets, RELATIONS)).toEqual(
			legacyCollectSessionAggregateStats(db, targets, RELATIONS),
		);
	});

	test("matches the legacy implementation for a single narrator", () => {
		expect(collectSessionAggregateStats(db, ["n7"], RELATIONS)).toEqual(
			legacyCollectSessionAggregateStats(db, ["n7"], RELATIONS),
		);
	});

	test("excludes messages still referenced by a narrator outside the target set", () => {
		const stats = collectSessionAggregateStats(db, ["n0"], RELATIONS);
		// 4 messages per narrator; indices 0 and 3 are also referenced by `survivor`.
		expect(stats.messages).toBe(2);
	});

	test("counts every exclusively owned message once, even with duplicate refs", () => {
		db.run("INSERT INTO narrator_message_refs VALUES ('ref-extra', 'n1', 'msg-1-1', 99)");
		const stats = collectSessionAggregateStats(db, ["n1"], RELATIONS);
		// The duplicate ref belongs to a target narrator, so it must not double-count the message.
		expect(stats.messages).toBe(legacyCollectSessionAggregateStats(db, ["n1"], RELATIONS).messages);
	});

	test("deduplicates repeated narrator ids like the TEMP-table primary key did", () => {
		expect(collectSessionAggregateStats(db, ["n2", "n2", "n2"], RELATIONS)).toEqual(
			collectSessionAggregateStats(db, ["n2"], RELATIONS),
		);
	});

	test("returns zeroes for an empty target list without touching the database", () => {
		expect(collectSessionAggregateStats(db, [], RELATIONS)).toEqual({
			narrators: 0,
			messages: 0,
			toolCalls: 0,
			apiRequests: 0,
			dumpsCleared: 0,
			approxBytes: 0,
		});
	});

	test("counts only api_requests rows that still hold a dump", () => {
		const targets = ["n0", "n1", "n2", "n3"];
		const stats = collectSessionAggregateStats(db, targets, RELATIONS);
		expect(stats.apiRequests).toBe(4);
		// Even-indexed narrators got a dump payload.
		expect(stats.dumpsCleared).toBe(2);
	});

	/**
	 * The forbidden pattern this rewrite removed. `.all()` over `narrator_messages` scaled with the
	 * number of sessions being cleaned; the replacement must issue only bounded aggregate queries.
	 */
	test("issues no unbounded row-materialising query", () => {
		const statements: string[] = [];
		const originalPrepare = db.prepare.bind(db);
		// biome-ignore lint/suspicious/noExplicitAny: test spy over a bun:sqlite method
		(db as any).prepare = (sql: string, ...rest: unknown[]) => {
			statements.push(sql);
			// biome-ignore lint/suspicious/noExplicitAny: forwarding spy arguments
			return (originalPrepare as any)(sql, ...rest);
		};
		try {
			collectSessionAggregateStats(db, ["n0", "n1", "n2"], RELATIONS);
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: restoring the spied method
			(db as any).prepare = originalPrepare;
		}

		expect(statements.length).toBeGreaterThan(0);
		for (const sql of statements) {
			const normalized = sql.replace(/\s+/g, " ").trim();
			if (normalized.startsWith("PRAGMA") || normalized.startsWith("SELECT 1 FROM sqlite_schema")) {
				continue;
			}
			// Every data query must be an aggregate, never a row-returning SELECT of ids.
			expect(normalized).toMatch(/SELECT COUNT\(\*\)/i);
			expect(normalized).not.toMatch(/CREATE TEMP TABLE/i);
		}
	});
});
