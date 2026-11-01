import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import { migrate } from "drizzle-orm/pg-proxy/migrator";
import { applyPendingMigrationsByHash } from "../../server/db/run-migrations";
import { migrationScript, psqlProxyCallback } from "./pg-baseline-model";
import { withPostgres } from "./pg-test-harness";

async function migrationFixture(
	source: string,
	tag: string,
	includePrevious = false,
): Promise<string> {
	const folder = await mkdtemp(join(tmpdir(), "nf-native-media-migration-"));
	try {
		const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
		const index = journal.entries.findIndex((item: { tag: string }) => item.tag === tag);
		if (index < 0 || (includePrevious && index === 0))
			throw new Error(`Missing migration ${tag} or its predecessor`);
		const entries = journal.entries.slice(includePrevious ? index - 1 : index, index + 1);
		await mkdir(join(folder, "meta"));
		await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
		for (const entry of entries)
			await copyFile(join(source, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
		return folder;
	} catch (error) {
		await rm(folder, { recursive: true, force: true });
		throw error;
	}
}

describe("native media migration upgrades", () => {
	test.each([
		true,
		false,
	])("SQLite 0229 preserves existing rows (legacy column: %s) and is idempotent", async (legacy) => {
		const folder = await migrationFixture(
			resolve(import.meta.dir, "../../drizzle"),
			"0229_native_media",
		);
		const db = new Database(":memory:");
		try {
			db.run(
				`CREATE TABLE narrator_buffered_messages (id text PRIMARY KEY${legacy ? ", media_json text" : ""})`,
			);
			if (legacy)
				db.run("INSERT INTO narrator_buffered_messages VALUES (?, ?)", [
					"old",
					'[{"type":"image","url":"legacy"}]',
				]);
			else db.run("INSERT INTO narrator_buffered_messages (id) VALUES (?)", ["old"]);
			applyPendingMigrationsByHash(db, folder);
			const expected = [
				{ id: "old", media_json: legacy ? '[{"type":"image","url":"legacy"}]' : null },
			];
			expect(db.query("SELECT id, media_json FROM narrator_buffered_messages").all()).toEqual(
				expected,
			);
			expect(db.query("SELECT hash FROM __drizzle_migrations").all()).toHaveLength(1);
			applyPendingMigrationsByHash(db, folder);
			expect(db.query("SELECT id, media_json FROM narrator_buffered_messages").all()).toEqual(
				expected,
			);
			expect(db.query("SELECT hash FROM __drizzle_migrations").all()).toHaveLength(1);
		} finally {
			db.close();
			await rm(folder, { recursive: true, force: true });
		}
	});

	test("PostgreSQL 0046 preserves old data, is idempotent, and rejects incompatible columns", async () => {
		const folder = await migrationFixture(
			resolve(import.meta.dir, "../../drizzle-postgres"),
			"0046_native_media",
			true,
		);
		let callbackError: unknown;
		try {
			const journal = JSON.parse(await readFile(join(folder, "meta/_journal.json"), "utf8"));
			const previous = journal.entries[0] as { tag: string; when: number };
			const previousHash = createHash("sha256")
				.update(await readFile(join(folder, `${previous.tag}.sql`)))
				.digest("hex");
			const seedLedger = `CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at numeric); INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('${previousHash}', ${previous.when});`;
			// An explicit image forces the disposable Podman harness even if an external URL is set.
			const result = await withPostgres(
				async ({ exec }) => {
					try {
						const run = async (sql: string) => {
							const outcome = await exec(sql);
							if (outcome.code !== 0) throw new Error(outcome.stderr);
							return outcome.stdout.trim();
						};
						const db = drizzleProxy(psqlProxyCallback(exec));
						const apply = () =>
							migrate(
								db,
								async (queries) => {
									await run(`BEGIN;\n${migrationScript(queries)}\nCOMMIT;`);
								},
								{ migrationsFolder: folder },
							);
						for (const legacy of [true, false]) {
							await run(
								`DROP TABLE IF EXISTS narrator_buffered_messages; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE TABLE narrator_buffered_messages (id text PRIMARY KEY${legacy ? ", media_json text" : ""}); ${seedLedger}`,
							);
							await run(
								legacy
									? `INSERT INTO narrator_buffered_messages VALUES ('old', '[{"type":"image","url":"legacy"}]');`
									: "INSERT INTO narrator_buffered_messages (id) VALUES ('old');",
							);
							await apply();
							const expected = legacy ? '[{"type":"image","url":"legacy"}]' : "<null>";
							expect(
								await run(
									"SELECT coalesce(media_json, '<null>') FROM narrator_buffered_messages WHERE id='old';",
								),
							).toBe(expected);
							await apply();
							expect(await run("SELECT count(*) FROM drizzle.__drizzle_migrations;")).toBe("2");
							expect(
								await run(
									"SELECT coalesce(media_json, '<null>') FROM narrator_buffered_messages WHERE id='old';",
								),
							).toBe(expected);
						}
						await run(
							`DROP TABLE narrator_buffered_messages; DROP SCHEMA drizzle CASCADE; CREATE TABLE narrator_buffered_messages (id text PRIMARY KEY, media_json integer); INSERT INTO narrator_buffered_messages VALUES ('old', 42); ${seedLedger}`,
						);
						await expect(apply()).rejects.toThrow("Migration 0046");
						expect(
							await run("SELECT media_json FROM narrator_buffered_messages WHERE id='old';"),
						).toBe("42");
						expect(await run("SELECT count(*) FROM drizzle.__drizzle_migrations;")).toBe("1");
						return "pass" as const;
					} catch (error) {
						callbackError = error;
						throw error;
					}
				},
				{ image: process.env.PG_TEST_IMAGE ?? "docker.io/library/postgres:17-alpine" },
			);
			if (callbackError) throw callbackError;
			if (typeof result === "object") {
				throw new Error(`Real PostgreSQL upgrade did not execute: ${JSON.stringify(result)}`);
			}
			expect(result).toBe("pass");
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	}, 420_000);
});
