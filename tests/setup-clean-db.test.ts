import { expect, test } from "bun:test";
import { cleanDb, getTestDb } from "./setup";

test("fixture cleanup preserves the migration ledger while clearing application tables", () => {
	const { sqlite } = getTestDb();
	try {
		sqlite.exec(`
			CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC);
			INSERT INTO __drizzle_migrations VALUES (1, 'fixture-hash', 123);
			CREATE TABLE __fixture_business (id TEXT PRIMARY KEY);
			INSERT INTO __fixture_business VALUES ('clear-me');
		`);
		const before = sqlite.query("SELECT * FROM __drizzle_migrations").all();
		cleanDb(sqlite);
		expect(sqlite.query("SELECT * FROM __drizzle_migrations").all()).toEqual(before);
		expect(sqlite.query("SELECT * FROM __fixture_business").all()).toEqual([]);
		cleanDb(sqlite);
		expect(sqlite.query("SELECT * FROM __drizzle_migrations").all()).toEqual(before);
	} finally {
		sqlite.close();
	}
});
