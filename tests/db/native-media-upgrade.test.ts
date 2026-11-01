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
	test("SQLite validates recorded ModelTrace schemas without changing rows or ledger", async () => {
		const folder = await migrationFixture(
			resolve(import.meta.dir, "../../drizzle"),
			"0230_wealthy_sir_ram",
		);
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE narrators (id text PRIMARY KEY)");
			db.run("INSERT INTO narrators VALUES ('old')");
			applyPendingMigrationsByHash(db, folder);
			const ledger = db.query("SELECT * FROM __drizzle_migrations").all();
			db.run("DROP INDEX idx_narrators_modeltrace_key");
			expect(() => applyPendingMigrationsByHash(db, folder)).toThrow(
				"Incompatible SQLite modeltrace migration schema",
			);
			expect(db.query("SELECT id FROM narrators").all()).toEqual([{ id: "old" }]);
			expect(db.query("SELECT * FROM __drizzle_migrations").all()).toEqual(ledger);
		} finally {
			db.close();
			await rm(folder, { recursive: true, force: true });
		}
	});

	test("SQLite rejects recorded ModelTrace drift before applying later migrations", async () => {
		const folder = await migrationFixture(
			resolve(import.meta.dir, "../../drizzle"),
			"0231_native_media",
			true,
		);
		const db = new Database(":memory:");
		try {
			const hash = createHash("sha256")
				.update(await readFile(join(folder, "0230_wealthy_sir_ram.sql")))
				.digest("hex");
			db.run(
				"CREATE TABLE narrators (id text PRIMARY KEY, hidden_from_lists integer DEFAULT false NOT NULL, modeltrace_key text)",
			);
			db.run("CREATE TABLE narrator_buffered_messages (id text PRIMARY KEY)");
			db.run(
				"CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
			);
			db.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, 1)", [hash]);
			expect(() => applyPendingMigrationsByHash(db, folder)).toThrow(
				"Incompatible SQLite modeltrace migration schema",
			);
			expect(db.query("PRAGMA table_info('narrator_buffered_messages')").all()).toHaveLength(1);
			expect(db.query("SELECT hash FROM __drizzle_migrations").all()).toEqual([{ hash }]);
		} finally {
			db.close();
			await rm(folder, { recursive: true, force: true });
		}
	});

	test("SQLite accepts ASCII case differences in native upgrade identifiers", async () => {
		const folder = await migrationFixture(
			resolve(import.meta.dir, "../../drizzle"),
			"0230_wealthy_sir_ram",
		);
		const db = new Database(":memory:");
		try {
			db.run(
				"CREATE TABLE NARRATORS (id text PRIMARY KEY, HIDDEN_FROM_LISTS integer DEFAULT false NOT NULL, MODELTRACE_KEY text)",
			);
			db.run("CREATE UNIQUE INDEX IDX_NARRATORS_MODELTRACE_KEY ON NARRATORS (MODELTRACE_KEY)");
			applyPendingMigrationsByHash(db, folder);
			applyPendingMigrationsByHash(db, folder);
			expect(db.query("SELECT hash FROM __drizzle_migrations").all()).toHaveLength(1);
		} finally {
			db.close();
			await rm(folder, { recursive: true, force: true });
		}
	});
	test.each([
		true,
		false,
	])("SQLite 0231 preserves existing rows (legacy column: %s) and is idempotent", async (legacy) => {
		const folder = await migrationFixture(
			resolve(import.meta.dir, "../../drizzle"),
			"0231_native_media",
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

	test("PostgreSQL 0048 preserves old data, is idempotent, and rejects incompatible columns", async () => {
		const folder = await migrationFixture(
			resolve(import.meta.dir, "../../drizzle-postgres"),
			"0048_native_media",
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
			const full = await migrationFixture(source, "0048_native_media", false, true);
			try {
				const journal = JSON.parse(await readFile(join(full, "meta/_journal.json"), "utf8"));
				const outline = journal.entries.find(
					(entry: { tag: string }) => entry.tag === "0046_outline_task_claims",
				);
				const native = journal.entries.find(
					(entry: { tag: string }) => entry.tag === "0048_native_media",
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

	test.each([
		"9c78534134d6f92741a478b05e4290f62b72d8b073d9ee5f052b5c15db0043d7",
		"f2ecf4303ae75d856f1fe37c88ca9419e21131b8e34edbbef2d982a812945728",
	])("PostgreSQL repairs ModelTrace skipped by old media 0047 watermark %s", async (oldHash) => {
		const source = resolve(import.meta.dir, "../../drizzle-postgres");
		const baseline = await migrationFixture(source, "0046_outline_task_claims", false, true);
		const full = await migrationFixture(source, "0048_native_media", false, true);
		try {
			const journal = JSON.parse(await readFile(join(full, "meta/_journal.json"), "utf8"));
			const model = journal.entries.find(
				(entry: { tag: string }) => entry.tag === "0047_modeltrace_narrator",
			);
			const native = journal.entries.find(
				(entry: { tag: string }) => entry.tag === "0048_native_media",
			);
			const oldWhen = 1793521234696;
			const modelHash = createHash("sha256")
				.update((await readFile(join(full, `${model.tag}.sql`), "utf8")).replace(/\r\n/g, "\n"))
				.digest("hex");
			expect(model.when).toBeLessThan(oldWhen);
			expect(native.when).toBeGreaterThan(oldWhen);
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
						INSERT INTO narrators (id, title, created_at, updated_at) VALUES ('old', 'preserved', 'then', 'then');
						INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('${oldHash}', ${oldWhen});`);
						await apply(full);
						expect(
							await run(
								"SELECT title || ':' || hidden_from_lists || ':' || coalesce(modeltrace_key, '<null>') FROM narrators WHERE id='old';",
							),
						).toBe("preserved:false:<null>");
						expect(
							await run(
								"SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='narrators' AND column_name IN ('hidden_from_lists', 'modeltrace_key');",
							),
						).toBe("2");
						expect(
							await run(
								"SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='idx_narrators_modeltrace_key' AND indexdef LIKE 'CREATE UNIQUE INDEX%';",
							),
						).toBe("1");
						expect(
							await run(
								`SELECT count(*) FROM drizzle.__drizzle_migrations WHERE hash='${modelHash}';`,
							),
						).toBe("1");
						await apply(full);
						expect(
							await run(
								`SELECT count(*) FROM drizzle.__drizzle_migrations WHERE hash='${modelHash}';`,
							),
						).toBe("1");
						expect(await run("SELECT count(*) FROM drizzle.__drizzle_migrations;")).toBe(
							String(journal.entries.length + 1),
						);
						const compensation = (await readFile(join(full, `${native.tag}.sql`), "utf8")).split(
							"--> statement-breakpoint",
						)[2];
						const modelCrlfHash = createHash("sha256")
							.update(
								(await readFile(join(full, `${model.tag}.sql`), "utf8"))
									.replace(/\r\n/g, "\n")
									.replace(/\n/g, "\r\n"),
							)
							.digest("hex");
						expect(modelCrlfHash).toBe(
							"9506699a359b5c8a6e1ec148461b126a721ff3807bca63904d699d30c823e562",
						);
						// Existing upstream CRLF fingerprint must suppress duplicate DDL.
						const modelLfHash = "d837b29b7004e8d02c4f88f098d0747e1944972dbf2b02a0faa29b88f8a1fd4e";
						await run(
							`DELETE FROM drizzle.__drizzle_migrations WHERE hash IN ('${modelHash}', '${modelLfHash}', '${modelCrlfHash}'); INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('${modelCrlfHash}', ${model.when});`,
						);
						await run(compensation);
						expect(
							await run(
								`SELECT count(*) FROM drizzle.__drizzle_migrations WHERE hash='${modelLfHash}';`,
							),
						).toBe("0");
						// An unrelated fingerprint must not trigger the repair, even with a newer watermark.
						await run(
							`DELETE FROM drizzle.__drizzle_migrations WHERE hash IN ('${oldHash}', '${modelCrlfHash}'); INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('unrelated', ${oldWhen});`,
						);
						await run(compensation);
						expect(
							await run(
								`SELECT count(*) FROM drizzle.__drizzle_migrations WHERE hash IN ('${modelLfHash}', '${modelCrlfHash}');`,
							),
						).toBe("0");
						return "pass" as const;
					} catch (error) {
						callbackError = error;
						throw error;
					}
				},
				{ image: process.env.PG_TEST_IMAGE ?? "docker.io/library/postgres:17-alpine" },
			);
			if (callbackError) throw callbackError;
			if (result !== "pass")
				throw new Error(`Real PostgreSQL upgrade did not execute: ${JSON.stringify(result)}`);
		} finally {
			await rm(baseline, { recursive: true, force: true });
			await rm(full, { recursive: true, force: true });
		}
	}, 420_000);
});
