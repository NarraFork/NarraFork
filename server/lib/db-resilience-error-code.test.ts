import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteErrorCode } from "./db-resilience";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function pair() {
	const root = mkdtempSync(join(tmpdir(), "db-error-code-"));
	roots.push(root);
	const open = () => {
		const db = new Database(join(root, "test.db"));
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA busy_timeout = 0");
		return db;
	};
	const a = open();
	a.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
	a.run("INSERT INTO t VALUES (1, 'x')");
	return { a, b: open() };
}

function failure(run: () => void): unknown {
	try {
		run();
	} catch (err) {
		return err;
	}
	throw new Error("expected the statement to fail");
}

// Both failures read "database is locked"; only the code says which one production hit.
test("a writer holding the lock and a stale read snapshot report different codes", () => {
	const { a, b } = pair();
	b.run("BEGIN IMMEDIATE");
	const held = failure(() =>
		a.transaction(() => {
			a.query("SELECT v FROM t").all();
			a.run("UPDATE t SET v = 'a'");
		})(),
	);
	b.run("COMMIT");
	const stale = failure(() =>
		a.transaction(() => {
			a.query("SELECT v FROM t").all();
			b.run("UPDATE t SET v = 'b'");
			a.run("UPDATE t SET v = 'a'");
		})(),
	);
	expect(String(held)).toContain("database is locked");
	expect(String(stale)).toContain("database is locked");
	expect(sqliteErrorCode(held)).toBe("SQLITE_BUSY");
	expect(sqliteErrorCode(stale)).toBe("SQLITE_BUSY_SNAPSHOT");
	a.close();
	b.close();
});

test("non-SQLite errors have no code", () => {
	expect(sqliteErrorCode(new Error("boom"))).toBeUndefined();
	expect(sqliteErrorCode(null)).toBeUndefined();
	expect(sqliteErrorCode("database is locked")).toBeUndefined();
});
