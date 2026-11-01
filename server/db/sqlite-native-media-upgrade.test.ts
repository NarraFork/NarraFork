import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { applyPendingMigrationsByHash } from "./run-migrations";

// Captured independently from the original 0230_native_media.sql, including its final newline.
const OLD_NATIVE_SQL =
	"PRAGMA foreign_keys=OFF;\n--> statement-breakpoint\nALTER TABLE `narrator_buffered_messages` ADD `media_json` text;\n--> statement-breakpoint\nPRAGMA foreign_keys=ON;\n";
const oldHash = (lineEnding: "LF" | "CRLF") =>
	createHash("sha256")
		.update(lineEnding === "LF" ? OLD_NATIVE_SQL : OLD_NATIVE_SQL.replace(/\n/g, "\r\n"))
		.digest("hex");

describe("SQLite native media branch upgrade", () => {
	test.each([
		"LF",
		"CRLF",
	] as const)("repairs the skipped upstream migration with old %s ledger", (lineEnding) => {
		const source = join(import.meta.dir, "../../drizzle");
		const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8"));
		const entries = journal.entries.slice(-2);
		expect(entries.map((entry: { tag: string }) => entry.tag)).toEqual([
			"0230_wealthy_sir_ram",
			"0231_native_media",
		]);
		const folder = mkdtempSync(join(tmpdir(), "nf-sqlite-media-upgrade-"));
		const database = new Database(":memory:");
		try {
			mkdirSync(join(folder, "meta"));
			writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
			for (const { tag } of entries) {
				writeFileSync(join(folder, `${tag}.sql`), readFileSync(join(source, `${tag}.sql`)));
			}
			const migrations = readMigrationFiles({ migrationsFolder: folder });
			expect([oldHash("LF"), oldHash("CRLF")]).toContain(migrations[1].hash);
			database.exec(`
				CREATE TABLE narrators (id TEXT PRIMARY KEY);
				CREATE TABLE narrator_buffered_messages (id TEXT PRIMARY KEY, media_json TEXT);
				INSERT INTO narrators VALUES ('n1');
				INSERT INTO narrator_buffered_messages VALUES ('m1', '[{"url":"keep"}]');
				CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC);
			`);
			database.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [
				oldHash(lineEnding),
				entries[1].when,
			]);
			applyPendingMigrationsByHash(database, folder);
			expect(
				database.query("SELECT media_json FROM narrator_buffered_messages WHERE id = 'm1'").get(),
			).toEqual({ media_json: '[{"url":"keep"}]' });
			expect(
				database
					.query("SELECT hidden_from_lists, modeltrace_key FROM narrators WHERE id = 'n1'")
					.get(),
			).toEqual({ hidden_from_lists: 0, modeltrace_key: null });
			expect(
				database
					.query(
						"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_narrators_modeltrace_key'",
					)
					.get(),
			).toBeTruthy();
			expect(database.query("SELECT COUNT(*) AS count FROM __drizzle_migrations").get()).toEqual({
				count: 2,
			});
			applyPendingMigrationsByHash(database, folder);
			expect(database.query("SELECT COUNT(*) AS count FROM __drizzle_migrations").get()).toEqual({
				count: 2,
			});

			for (const scenario of [
				"media-type",
				"media-not-null",
				"index-nonunique",
				"index-wrong-column",
				"index-partial",
				"index-collation",
				"hidden-default",
			] as const) {
				const db = new Database(":memory:");
				try {
					const media =
						scenario === "media-type"
							? "INTEGER"
							: scenario === "media-not-null"
								? "TEXT NOT NULL DEFAULT ''"
								: "TEXT";
					const hidden = scenario === "hidden-default" ? "DEFAULT 1" : "DEFAULT false";
					db.exec(`CREATE TABLE narrators (id TEXT PRIMARY KEY, hidden_from_lists INTEGER ${hidden} NOT NULL, modeltrace_key TEXT);
						CREATE TABLE narrator_buffered_messages (id TEXT PRIMARY KEY, media_json ${media});
						CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC);`);
					if (scenario.startsWith("index-")) {
						const unique = scenario === "index-nonunique" ? "" : "UNIQUE";
						const key =
							scenario === "index-wrong-column"
								? "id"
								: scenario === "index-collation"
									? "modeltrace_key COLLATE NOCASE"
									: "modeltrace_key";
						const where = scenario === "index-partial" ? "WHERE modeltrace_key IS NOT NULL" : "";
						db.exec(
							`CREATE ${unique} INDEX idx_narrators_modeltrace_key ON narrators (${key}) ${where}`,
						);
					}
					db.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [
						oldHash(lineEnding),
						entries[1].when,
					]);
					expect(() => applyPendingMigrationsByHash(db, folder)).toThrow("Incompatible SQLite");
					expect(db.query("SELECT COUNT(*) AS count FROM __drizzle_migrations").get()).toEqual({
						count: 1,
					});
					if (!scenario.startsWith("index-")) {
						expect(
							db
								.query("SELECT name FROM sqlite_master WHERE name = 'idx_narrators_modeltrace_key'")
								.get(),
						).toBeNull();
					}
				} finally {
					db.close();
				}
			}

			// A pending media migration must not stamp an incompatible existing column either.
			const pendingMedia = new Database(":memory:");
			try {
				pendingMedia.exec(`CREATE TABLE narrators (id TEXT PRIMARY KEY, hidden_from_lists INTEGER DEFAULT false NOT NULL, modeltrace_key TEXT);
					CREATE UNIQUE INDEX idx_narrators_modeltrace_key ON narrators (modeltrace_key);
					CREATE TABLE narrator_buffered_messages (id TEXT, media_json INTEGER);
					CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC);`);
				pendingMedia.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [
					migrations[0].hash,
					entries[0].when,
				]);
				expect(() => applyPendingMigrationsByHash(pendingMedia, folder)).toThrow(
					"Incompatible SQLite media",
				);
				expect(
					pendingMedia.query("SELECT COUNT(*) AS count FROM __drizzle_migrations").get(),
				).toEqual({ count: 1 });
			} finally {
				pendingMedia.close();
			}

			const incompatible = new Database(":memory:");
			try {
				incompatible.exec(`
					CREATE TABLE narrators (id TEXT PRIMARY KEY, modeltrace_key TEXT);
					INSERT INTO narrators VALUES ('a', 'duplicate'), ('b', 'duplicate');
					CREATE TABLE narrator_buffered_messages (id TEXT PRIMARY KEY, media_json TEXT);
					INSERT INTO narrator_buffered_messages VALUES ('m1', 'retained');
					CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC);
				`);
				incompatible.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [
					oldHash(lineEnding),
					entries[1].when,
				]);
				expect(() => applyPendingMigrationsByHash(incompatible, folder)).toThrow();
				expect(
					incompatible
						.query("SELECT COUNT(*) AS count FROM narrators WHERE modeltrace_key = 'duplicate'")
						.get(),
				).toEqual({ count: 2 });
				expect(
					incompatible.query("SELECT media_json FROM narrator_buffered_messages").get(),
				).toEqual({ media_json: "retained" });
				expect(
					incompatible.query("SELECT COUNT(*) AS count FROM __drizzle_migrations").get(),
				).toEqual({ count: 1 });
				expect(
					incompatible
						.query(
							"SELECT name FROM pragma_table_info('narrators') WHERE name = 'hidden_from_lists'",
						)
						.get(),
				).toBeNull();
			} finally {
				incompatible.close();
			}
		} finally {
			database.close();
			rmSync(folder, { recursive: true, force: true });
		}
	});
});
