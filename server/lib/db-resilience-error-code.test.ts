import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteErrorCode, withDbRetry } from "./db-resilience";
import { logger } from "./logger";

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

test("WAL lock retry rolls back the complete transaction before backing off", async () => {
	const { a, b } = pair();
	let attempts = 0;
	b.run("BEGIN IMMEDIATE");
	const warn = spyOn(logger, "warn").mockImplementation(() => {
		expect(a.inTransaction).toBe(false);
		b.run("COMMIT");
	});
	try {
		await withDbRetry(
			async () => {
				attempts++;
				a.transaction(() => {
					a.query("SELECT v FROM t").get();
					a.run("UPDATE t SET v='retried'");
				})();
			},
			{ retryLegacyMessages: false },
		);
		expect(attempts).toBe(2);
		expect(a.query("SELECT v FROM t").get()).toEqual({ v: "retried" });
		expect(warn.mock.calls[0][1]?.code).toBe("SQLITE_BUSY");
	} finally {
		warn.mockRestore();
		a.close();
		b.close();
	}
});

test("BUSY_SNAPSHOT retries a new transaction rather than repeating a stale upgrade", async () => {
	const { a, b } = pair();
	let attempts = 0;
	try {
		await withDbRetry(
			async () => {
				attempts++;
				a.transaction(() => {
					a.query("SELECT v FROM t").get();
					if (attempts === 1) b.run("UPDATE t SET v='concurrent'");
					a.run("UPDATE t SET v='fresh'");
				})();
			},
			{ retryLegacyMessages: false },
		);
		expect(attempts).toBe(2);
		expect(a.inTransaction).toBe(false);
		expect(a.query("SELECT v FROM t").get()).toEqual({ v: "fresh" });
	} finally {
		a.close();
		b.close();
	}
});

test("abort during backoff clears the timer and leaves no active transaction", async () => {
	const { a, b } = pair();
	const signal = new AbortController();
	const retrying = Promise.withResolvers<void>();
	const warn = spyOn(logger, "warn").mockImplementation(() => retrying.resolve());
	const clear = spyOn(globalThis, "clearTimeout");
	let attempts = 0;
	b.run("BEGIN IMMEDIATE");
	try {
		const pending = withDbRetry(
			async () => {
				attempts++;
				a.transaction(() => {
					a.run("UPDATE t SET v='cancelled'");
				})();
			},
			{ signal: signal.signal, retryLegacyMessages: false },
		);
		await retrying.promise;
		expect(a.inTransaction).toBe(false);
		signal.abort(new Error("cancel backoff"));
		await expect(pending).rejects.toThrow("cancel backoff");
		expect(attempts).toBe(1);
		expect(clear).toHaveBeenCalled();
		b.run("COMMIT");
		a.run("UPDATE t SET v='released'");
	} finally {
		warn.mockRestore();
		clear.mockRestore();
		a.close();
		b.close();
	}
});

test.each([
	undefined,
	"SQLITE_ERROR",
	"SQLITE_CONSTRAINT",
	"DB_WORKER_BUILD_MISMATCH",
])("non-lock code %s never retries even when the text says locked", async (code) => {
	let attempts = 0;
	await expect(
		withDbRetry(
			async () => {
				attempts++;
				throw Object.assign(new Error("database is locked"), { code });
			},
			{ retryLegacyMessages: false },
		),
	).rejects.toThrow("database is locked");
	expect(attempts).toBe(1);
});

test("explicit LOCKED results have at most three complete attempts", async () => {
	let attempts = 0;
	await expect(
		withDbRetry(
			async () => {
				attempts++;
				throw Object.assign(new Error("locked"), { code: "SQLITE_LOCKED_SHAREDCACHE" });
			},
			{ retryLegacyMessages: false },
		),
	).rejects.toThrow("locked");
	expect(attempts).toBe(3);
});
