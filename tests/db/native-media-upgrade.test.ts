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
	includeAll = false,
): Promise<string> {
	const folder = await mkdtemp(join(tmpdir(), "nf-native-media-migration-"));
	try {
		const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
		const index = journal.entries.findIndex((item: { tag: string }) => item.tag === tag);
		if (index < 0 || (includePrevious && index === 0))
			throw new Error(`Missing migration ${tag} or its predecessor`);
		const entries = journal.entries.slice(
			includeAll ? 0 : includePrevious ? index - 1 : index,
			index + 1,
		);
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
	])("SQLite 0230 preserves existing rows (legacy column: %s) and is idempotent", async (legacy) => {
		const folder = await migrationFixture(
			resolve(import.meta.dir, "../../drizzle"),
			"0230_native_media",
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

	test("PostgreSQL 0047 preserves old data, is idempotent, and rejects incompatible columns", async () => {
		const folder = await migrationFixture(
			resolve(import.meta.dir, "../../drizzle-postgres"),
			"0047_native_media",
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

	test.each([
		"464e7af3b67b68b65073d71ce14e2bcad9b08ff2b970e99a8638265080672644",
		"75e1fab8ccd88e57be0d5803ecca76e72b86084ae2aa239a57c2ace83ae9843c",
	])("PostgreSQL repairs skipped outline 0046 after legacy watermark %s", async (legacyHash) => {
		const source = resolve(import.meta.dir, "../../drizzle-postgres");
		const baseline = await migrationFixture(
			source,
			"0045_git_identity_visibility_per_account",
			false,
			true,
		);
		try {
			const full = await migrationFixture(source, "0047_native_media", false, true);
			try {
				const journal = JSON.parse(await readFile(join(full, "meta/_journal.json"), "utf8"));
				const outline = journal.entries.find(
					(entry: { tag: string }) => entry.tag === "0046_outline_task_claims",
				);
				const native = journal.entries.find(
					(entry: { tag: string }) => entry.tag === "0047_native_media",
				);
				const legacyWhen = 1793516319086;
				expect(outline.when).toBeLessThan(legacyWhen);
				expect(native.when).toBeGreaterThan(legacyWhen);
				const outlineHash = createHash("sha256")
					.update(await readFile(join(full, `${outline.tag}.sql`)))
					.digest("hex");
				let callbackError: unknown;
				const result = await withPostgres(
					async ({ exec }) => {
						try {
							const run = async (sql: string) => {
								const outcome = await exec(sql);
								if (outcome.code !== 0) throw new Error(outcome.stderr);
								return outcome.stdout.trim();
							};
							const db = drizzleProxy(psqlProxyCallback(exec));
							const apply = (folder: string) =>
								migrate(
									db,
									async (queries) => {
										await run(`BEGIN;\n${migrationScript(queries)}\nCOMMIT;`);
									},
									{ migrationsFolder: folder },
								);
							await apply(baseline);
							await run(`ALTER TABLE narrator_buffered_messages ADD COLUMN media_json text;
							INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('${legacyHash}', ${legacyWhen});
							INSERT INTO outline_spaces (id, key, kind, created_at) VALUES ('s', 's', 'test', 'old');
							INSERT INTO outline_blocks (id, space_id, sid, page_id, order_key, content, content_hash, task_json, author_kind, author_id, version_seq)
							VALUES ('b', 's', 'b', 'b', 'a', 'old content', 'hash', '{"status":"doing"}', 'user', 'u', 1);`);
							expect(await run("SELECT to_regclass('public.outline_task_claims') IS NULL;")).toBe(
								"t",
							);
							await apply(full);
							expect(
								await run(
									"SELECT content || ':' || in_process FROM outline_blocks WHERE id = 'b';",
								),
							).toBe("old content:false");
							expect(
								await run(
									"SELECT in_process_ready || ':' || in_process_epoch FROM outline_spaces WHERE id = 's';",
								),
							).toBe("false:0");
							expect(
								await run("SELECT to_regclass('public.outline_task_claims') IS NOT NULL;"),
							).toBe("t");
							expect(
								await run(
									"SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('idx_outline_task_claims_holder', 'idx_outline_task_claims_expiry', 'idx_outline_blocks_open_tasks', 'idx_outline_blocks_doing_tasks', 'idx_outline_spaces_in_process_pending');",
								),
							).toBe("5");
							expect(
								await run(
									`SELECT count(*) FROM drizzle.__drizzle_migrations WHERE hash = '${outlineHash}';`,
								),
							).toBe("1");
							await run(
								"INSERT INTO outline_task_claims (task_block_id, epoch, task_version_at_claim, claimed_at) VALUES ('b', 1, 1, 'now');",
							);
							await apply(full);
							expect(
								await run(
									`SELECT count(*) FROM drizzle.__drizzle_migrations WHERE hash = '${outlineHash}';`,
								),
							).toBe("1");
							expect(
								await run("SELECT count(*) FROM outline_task_claims WHERE task_block_id = 'b';"),
							).toBe("1");
							expect(await run("SELECT count(*) FROM drizzle.__drizzle_migrations;")).toBe(
								String(journal.entries.length + 1),
							);
							return "pass" as const;
						} catch (error) {
							callbackError = error;
							throw error;
						}
					},
					{ image: process.env.PG_TEST_IMAGE ?? "docker.io/library/postgres:17-alpine" },
				);
				if (callbackError) throw callbackError;
				if (typeof result === "object")
					throw new Error(`Real PostgreSQL upgrade did not execute: ${JSON.stringify(result)}`);
				expect(result).toBe("pass");
			} finally {
				await rm(full, { recursive: true, force: true });
			}
		} finally {
			await rm(baseline, { recursive: true, force: true });
		}
	}, 420_000);
});
