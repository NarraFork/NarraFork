/**
 * Phase 0 baseline: with no extra configuration, the database backend is SQLite.
 *
 * This exists ahead of the dual-database work as a tripwire, not as documentation, and it
 * pins a DEFAULT — not a prohibition. A PostgreSQL path is expected to arrive incrementally,
 * and it is welcome to arrive; what must not happen is a second dialect becoming reachable
 * WITHOUT anyone choosing it, because a stray `dialect`/`DATABASE_URL` knob started steering
 * the main connection or a foreign table definition slipped into the schema module. That
 * failure is invisible to every other suite here — they all pass just as happily against a
 * half-wired second backend, since they run whatever the default resolves to.
 *
 * So the assertions below are about the default, no-extra-config state:
 *
 *   - every table/view the schema module exports belongs to the SQLite dialect (checked
 *     structurally, without importing the giant db module);
 *   - the migration journal still declares `dialect: "sqlite"`, which is what `db:generate`
 *     writes and what `run-migrations` replays;
 *   - `openDatabase()` hands back a real `bun:sqlite` handle pointed at the isolated test
 *     home, with the PRAGMA set the main-thread performance rules depend on;
 *   - an ambient `DATABASE_URL` changes none of it.
 *
 * WHEN POSTGRESQL LANDS, THESE TESTS GET UPDATED, NOT DELETED. The successor assertion is
 * "an absent or unrecognized selector still resolves to SQLite", which is the same property
 * one level up: adding a backend stays a deliberate, visible edit. Nothing here is a claim
 * that a second backend must never be enabled.
 *
 * `server/db/index.ts` is intentionally NOT imported: its module body acquires the instance
 * lock, runs migrations and performs backfill writes. A backend-identity assertion does not
 * need any of that.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { is, isTable, isView } from "drizzle-orm";
import { SQLiteTable, SQLiteView } from "drizzle-orm/sqlite-core";
import { testEnvironment } from "../../../tests/preload";
import { getDbPath, openDatabase } from "../connection";
import * as schema from "../schema";

describe("SQLite is the default database backend", () => {
	test("every table or view the schema exports belongs to the SQLite dialect", () => {
		// Enumerate by "is a table/view at all" (dialect-agnostic), THEN require each one to be
		// SQLite. Filtering to SQLiteTable first and re-checking the survivors — which is what
		// this test did originally — is vacuous: a `pgTable` added to schema.ts is filtered out
		// and the assertion still passes. Verified against drizzle-orm 0.45: adding a pgTable
		// export leaves the filter-first form green and makes this form fail.
		//
		// Views are covered too, because they are a second, easy-to-overlook way for a foreign
		// dialect to enter the schema module. `sqliteView(...)` satisfies `isView` but is NOT a
		// `SQLiteTable`, so checking tables and views against the same class would report a
		// legitimate SQLite view as foreign.
		const objects = Object.entries(schema).filter(([, value]) => isTable(value) || isView(value));

		// Guard against a vacuous pass if the export shape ever changes.
		expect(objects.length).toBeGreaterThan(20);
		const foreign = objects
			.filter(([, value]) => !(is(value, SQLiteTable) || is(value, SQLiteView)))
			.map(([name, value]) => `${name} (${(value as object).constructor.name})`);
		expect(foreign).toEqual([]);
	});

	test("the migration journal declares the sqlite dialect", () => {
		// `db:generate` writes this field; a second dialect would surface here first.
		const journalPath = resolve(import.meta.dir, "../../../drizzle/meta/_journal.json");
		const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
			dialect: string;
			entries: unknown[];
		};

		expect(journal.dialect).toBe("sqlite");
		expect(journal.entries.length).toBeGreaterThan(0);
	});

	test("openDatabase returns a bun:sqlite handle with no extra configuration", () => {
		// No env var, no settings key: the default path is what is being pinned.
		expect(process.env.NARRAFORK_HOME).toBe(testEnvironment.narraforkHome);
		expect(getDbPath()).toBe(resolve(testEnvironment.narraforkHome, "narrafork.db"));

		const conn = openDatabase();
		try {
			expect(conn).toBeInstanceOf(Database);
			expect(conn.query("SELECT sqlite_version() AS v").get()).toMatchObject({
				v: expect.any(String),
			});
		} finally {
			conn.close();
		}
	});

	test("the default connection keeps the PRAGMA set the main thread relies on", () => {
		// These are not cosmetic: WAL + a short busy_timeout are what keep a
		// synchronous bun:sqlite call on the HTTP thread from stalling the server.
		const conn = openDatabase();
		try {
			expect(conn.query("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
			expect(conn.query("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });

			// 0..250ms is the project-wide bound, not a rough sanity range. Three services
			// REFUSE to run outside it — workspace-write-coordinator.ts:287,
			// revert-mutation-journal.ts:145 and file-change-physical-audit-worker.ts:284 all
			// throw above 250 — so a laxer bound here (this test first allowed up to 1000) would
			// call a connection healthy that those services reject at startup.
			const { timeout } = conn.query("PRAGMA busy_timeout").get() as { timeout: number };
			expect(Number.isInteger(timeout)).toBe(true);
			expect(timeout).toBeGreaterThanOrEqual(0);
			expect(timeout).toBeLessThanOrEqual(250);
			// Pinned exactly: bun:sqlite runs on the JS thread, so this value is the ceiling on
			// how long one lock conflict can freeze all HTTP/WS traffic. Retries are async, in
			// withDbRetry. Raising it is a deliberate edit, not a drift.
			expect(timeout).toBe(250);
		} finally {
			conn.close();
		}
	});

	test("an ambient DATABASE_URL does not silently steer the default connection", () => {
		// The hazard is ACCIDENTAL selection, not PostgreSQL. `DATABASE_URL` is set in plenty of
		// developer shells for unrelated projects; today nothing reads it, and this pins that so
		// a future backend cannot become reachable just because a variable happens to be exported.
		//
		// This is deliberately NOT "PostgreSQL must never be selectable". When a second backend
		// lands it will need an explicit, documented switch, and this test should then be updated
		// to assert THAT rule (an unset/unknown selector still resolves to SQLite) rather than
		// being deleted. Asserting the default is what makes flipping it a visible edit.
		const previous = process.env.DATABASE_URL;
		process.env.DATABASE_URL = "postgres://user:pw@127.0.0.1:5432/narrafork";
		try {
			expect(getDbPath()).toBe(resolve(testEnvironment.narraforkHome, "narrafork.db"));
			const conn = openDatabase();
			try {
				expect(conn).toBeInstanceOf(Database);
				// Reading the variable back proves the assertion above ran with it set, rather
				// than passing because some earlier cleanup had already removed it.
				expect(process.env.DATABASE_URL).toContain("postgres://");
			} finally {
				conn.close();
			}
		} finally {
			if (previous === undefined) delete process.env.DATABASE_URL;
			else process.env.DATABASE_URL = previous;
		}
		expect(process.env.DATABASE_URL).toBe(previous);
	});
});
