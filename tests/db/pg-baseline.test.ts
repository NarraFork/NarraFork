/**
 * The real PostgreSQL baseline gate: apply `drizzle-postgres` to a throwaway PostgreSQL 17
 * and compare the resulting catalog against the committed snapshot, item by item.
 *
 * How it differs from a schema smoke test:
 *
 *  - **Migrations are applied the way they are actually applied**, through Drizzle's own
 *    `pg-proxy` migrator reading the journal on disk. That is what creates
 *    `drizzle.__drizzle_migrations` and writes one row per migration, so the bookkeeping can
 *    be checked against the journal instead of against a guessed row count.
 *  - **Every item is compared, not just totals.** 107 tables, 1540 columns with type /
 *    NOT NULL / primary key / default, 207 foreign keys with both column lists and both
 *    actions, 391 indexes with ordered key columns and predicates, 5 UNIQUE constraints,
 *    1 CHECK, 2 generated columns, 3 identity columns and backing sequences, plus replayed
 *    physical column order. Server-side counts are read
 *    separately as a landmark, so a facet query that silently returned nothing cannot pass.
 *  - **Expected expressions are canonicalized by the same server**, never by hand
 *    (see `pg-baseline-model.ts`).
 *  - **The gate proves it can still fail.** Live tamper checks re-read the catalog after
 *    dropping a foreign key, dropping an index and changing a default, and assert those
 *    exact differences are reported. The two catalog-query defects that made an earlier
 *    version of this file vacuous — a mis-bound `WITH ORDINALITY` join and an unquoted
 *    JSON alias — are pinned against the live server as well.
 *
 * A migration, assertion or unavailable-container outcome fails this real-PG gate.
 * Nothing is silently skipped when PostgreSQL did not actually run.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import { migrate } from "drizzle-orm/pg-proxy/migrator";
import {
	buildDeparseScript,
	buildExpected,
	CATALOG_FACETS,
	type Catalog,
	COUNTS_SQL,
	checkMigrationLedger,
	compareBaseline,
	deparseRequests,
	dumpFacet,
	type Exec,
	type FacetName,
	type JournalEntry,
	type LedgerRow,
	migrationScript,
	parseCatalog,
	parseDeparseOutput,
	psqlProxyCallback,
	type Snapshot,
} from "./pg-baseline-model";
import { withPostgres } from "./pg-test-harness";

const MIGRATIONS_FOLDER = "drizzle-postgres";
/** One container, sequentially: image pull plus ~800 statements plus ~40 paged reads. */
const RUN_TIMEOUT_MS = 420_000;

async function loadJournal(): Promise<{
	entries: JournalEntry[];
	hashes: string[];
	/** Statements the migrator will hand over: every breakpoint chunk plus one INSERT each. */
	statements: number;
}> {
	const journal = JSON.parse(await readFile(`${MIGRATIONS_FOLDER}/meta/_journal.json`, "utf8")) as {
		entries: JournalEntry[];
	};
	const entries = journal.entries ?? [];
	if (entries.length === 0) throw new Error("PostgreSQL migration journal is empty");
	let statements = 0;
	const hashes = await Promise.all(
		entries.map(async (entry) => {
			const sql = await readFile(`${MIGRATIONS_FOLDER}/${entry.tag}.sql`, "utf8");
			statements += sql.split("--> statement-breakpoint").length + 1;
			// Same digest Drizzle's readMigrationFiles records in __drizzle_migrations.
			return createHash("sha256").update(sql).digest("hex");
		}),
	);
	return { entries, hashes, statements };
}

/** The snapshot belonging to the newest journal entry: the state migrations must produce. */
async function loadSnapshot(entries: JournalEntry[]): Promise<Snapshot> {
	const tag = entries.at(-1)?.tag ?? "";
	const prefix = tag.match(/^\d+/)?.[0];
	if (!prefix) throw new Error(`PostgreSQL migration tag has no numeric prefix: ${tag}`);
	return JSON.parse(
		await readFile(`${MIGRATIONS_FOLDER}/meta/${prefix}_snapshot.json`, "utf8"),
	) as Snapshot;
}

/** Read every facet, then fold the pages into the comparable catalog. */
async function readCatalog(
	exec: Exec,
	facets: readonly FacetName[] = Object.keys(CATALOG_FACETS) as FacetName[],
): Promise<{ catalog: Catalog; problems: string[] }> {
	const problems: string[] = [];
	const rows = {} as Record<FacetName, unknown[][]>;
	for (const name of Object.keys(CATALOG_FACETS) as FacetName[]) rows[name] = [];
	for (const name of facets) {
		const dump = await dumpFacet(exec, name, CATALOG_FACETS[name]);
		rows[name] = dump.rows;
		problems.push(...dump.problems);
	}
	const parsed = parseCatalog(rows);
	return { catalog: parsed.catalog, problems: [...problems, ...parsed.problems] };
}

async function readJson(exec: Exec, sql: string, label: string): Promise<unknown> {
	const result = await exec(sql);
	if (result.code !== 0)
		throw new Error(`${label} failed (${result.code}): ${result.stderr.slice(0, 300)}`);
	return JSON.parse(result.stdout.trim());
}

type Outcome = {
	problems: string[];
	/** Landmarks the test pins so a comparison that never ran cannot pass. */
	observed: {
		tables: number;
		columns: number;
		foreignKeys: number;
		indexes: number;
		uniques: number;
		checks: number;
		generated: number;
		canonicalExpressions: number;
		migrationStatements: number;
		ledgerRows: number;
		replayQueries: number;
		rawReplayFailed: boolean;
		swappedOrdinalityDiffers: number;
		unquotedAliasFolds: boolean;
		tamperDetected: string[];
	};
};

describe("PostgreSQL baseline", () => {
	it(
		"applies the journal to a real PostgreSQL 17 and matches the committed snapshot",
		async () => {
			const { entries, hashes, statements } = await loadJournal();
			const snapshot = await loadSnapshot(entries);
			const prior = await Promise.all(entries.slice(0, -1).map((entry) => loadSnapshot([entry])));
			const built = buildExpected(snapshot, prior);
			const expected = built.expected;
			const requests = deparseRequests(expected);

			const result = await withPostgres(async ({ exec }): Promise<Outcome> => {
				const problems = [...built.problems];
				expect(
					Number(
						await readJson(exec, "SELECT current_setting('server_version_num')", "PG version"),
					),
				).toBeGreaterThanOrEqual(170000);
				expect(
					Number(
						await readJson(exec, "SELECT current_setting('server_version_num')", "PG version"),
					),
				).toBeLessThan(180000);

				// --- apply migrations exactly as the migrator would ---------------------------
				// Drizzle hands over every statement of every pending migration plus its own
				// bookkeeping INSERT. They are concatenated into one psql script (ON_ERROR_STOP=1
				// still aborts at the first failure) instead of ~700 container round trips.
				const db = drizzleProxy(psqlProxyCallback(exec)) as unknown as PgRemoteDatabase;
				let migrationStatements = 0;
				await migrate(
					db,
					async (queries) => {
						migrationStatements += queries.length;
						const applied = await exec(migrationScript(queries));
						if (applied.code !== 0) {
							throw new Error(`migration failed (${applied.code}): ${applied.stderr.slice(-600)}`);
						}
					},
					{ migrationsFolder: MIGRATIONS_FOLDER },
				);

				// --- Drizzle's own ledger, against the journal on disk ------------------------
				const ledger = (await readJson(
					exec,
					`SELECT coalesce(json_agg(json_build_object('id', id, 'hash', hash, 'created_at', created_at) ORDER BY id), '[]')::text
						FROM "drizzle"."__drizzle_migrations"`,
					"migration ledger",
				)) as LedgerRow[];
				problems.push(...checkMigrationLedger(entries, hashes, ledger));

				// Re-running the migrator must be a no-op: the ledger already covers the journal.
				let replayQueries = 0;
				await migrate(
					db,
					async (queries) => {
						replayQueries += queries.length;
					},
					{ migrationsFolder: MIGRATIONS_FOLDER },
				);
				if (replayQueries !== 0) {
					problems.push(`migrator re-ran ${replayQueries} statements over an applied journal`);
				}
				// The SQL itself must NOT be idempotent: if it were, applying it over an existing
				// database would silently do nothing and the ledger would be the only guard.
				const rawReplay = await exec(
					await readFile(`${MIGRATIONS_FOLDER}/${entries.at(-1)?.tag}.sql`, "utf8"),
				);
				if (rawReplay.code === 0) {
					problems.push("re-applying the migration SQL succeeded; it is not creating anything");
				}

				// --- catalog ------------------------------------------------------------------
				const read = await readCatalog(exec);
				problems.push(...read.problems);
				const serverCounts = (await readJson(exec, COUNTS_SQL, "counts")) as Record<string, number>;

				// --- canonical form of every expected expression, from this same server -------
				const deparsed = await exec(buildDeparseScript(requests));
				if (deparsed.code !== 0) {
					problems.push(
						`canonicalization failed (${deparsed.code}): ${deparsed.stderr.slice(-300)}`,
					);
				}
				const canonical = parseDeparseOutput(requests, deparsed.stdout);
				problems.push(...canonical.problems);

				problems.push(
					...compareBaseline(expected, read.catalog, canonical.canonical, serverCounts),
				);

				// Empty-table setval must leave the first identity draw at 1, not 2 or NULL.
				const fresh =
					await exec(`INSERT INTO narrators (id,created_at,updated_at) VALUES ('fresh-n','t','t');
INSERT INTO narrator_messages (id,narrator_id,role,content_json,created_at) VALUES ('fresh-m','fresh-n','user','[]','t');
INSERT INTO narrator_tool_calls (id,narrator_id,message_id,tool_use_id,tool_name,created_at) VALUES ('fresh-tc','fresh-n','fresh-m','fresh-tu','Bash','t');
INSERT INTO narrator_tool_continuations (id,tool_call_id,narrator_id,update_epoch,kind,created_at,updated_at) VALUES ('fresh-c','fresh-tc','fresh-n','e','deferred_tool','t','t');
INSERT INTO background_tasks (id,parent_narrator_id,type,status,started_at,created_at,updated_at) VALUES ('fresh-b','fresh-n','bash','running','t','t','t');
SELECT json_build_array((SELECT next_seq FROM narrators WHERE id='fresh-n'), (SELECT insert_seq FROM narrators WHERE id='fresh-n'), (SELECT insert_seq FROM background_tasks WHERE id='fresh-b'), (SELECT insert_seq FROM narrator_tool_continuations WHERE id='fresh-c'))::text;`);
				if (fresh.code !== 0) throw new Error(`Fresh identity probe failed: ${fresh.stderr}`);
				expect(JSON.parse(fresh.stdout.trim())).toEqual([0, 1, 1, 1]);

				// --- the two defects that made this gate vacuous, pinned against the server ---
				// `u(n, attnum)` binds the ordinality to attnum and vice versa. It returns a
				// plausible column list built from the table's leading columns, so it must be
				// shown to disagree with the correct binding on real indexes.
				const ordinality = (await readJson(
					exec,
					`SELECT count(*)::text FROM (
						SELECT (SELECT json_agg(z.attname ORDER BY u.n) FROM unnest(ix.indkey) WITH ORDINALITY u(attnum, n)
							JOIN pg_attribute z ON z.attrelid = ix.indrelid AND z.attnum = u.attnum)::text AS correct,
						(SELECT json_agg(z.attname ORDER BY u.n) FROM unnest(ix.indkey) WITH ORDINALITY u(n, attnum)
							JOIN pg_attribute z ON z.attrelid = ix.indrelid AND z.attnum = u.attnum)::text AS swapped
						FROM pg_index ix JOIN pg_class c ON c.oid = ix.indrelid
						JOIN pg_namespace n2 ON n2.oid = c.relnamespace
						WHERE n2.nspname = 'public' AND c.relkind = 'r' AND NOT ix.indisprimary
					) s WHERE correct IS DISTINCT FROM swapped`,
					"ordinality probe",
				)) as string;
				// An unquoted alias is folded to lower case, so a reader looking up the camelCase
				// key gets undefined — which reads as "this schema has none of those".
				const alias = (await readJson(
					exec,
					`SELECT to_json(x)::text FROM (SELECT 1 AS foreignKeys) x`,
					"alias probe",
				)) as Record<string, unknown>;

				// --- live tamper checks: prove real damage is still reported -------------------
				// Run last, on a container that is about to be destroyed.
				const tamperDetected: string[] = [];
				const tampers: Array<{ label: string; sql: string; facets: FacetName[]; match: RegExp }> = [
					{
						label: "dropped foreign key",
						sql: `ALTER TABLE "chapters" DROP CONSTRAINT "chapters_project_id_projects_id_fk";`,
						facets: ["foreignKeys"],
						match: /^foreign key chapters_project_id_projects_id_fk: missing/,
					},
					{
						label: "dropped index",
						sql: `DROP INDEX "idx_acl_event_created";`,
						facets: ["indexes"],
						match: /^index acl_events\.idx_acl_event_created: missing/,
					},
					{
						label: "changed default",
						sql: `ALTER TABLE "narrator_tool_calls" ALTER COLUMN "status" SET DEFAULT 'tampered';`,
						facets: ["columns"],
						match: /^column narrator_tool_calls\.status: expected/,
					},
					{
						label: "dropped unique constraint",
						sql: `ALTER TABLE "users" DROP CONSTRAINT "users_username_unique";`,
						facets: ["uniques", "indexes"],
						match: /^unique constraint users_username_unique: missing/,
					},
					{
						label: "dropped check constraint",
						sql: `ALTER TABLE "file_attributions" DROP CONSTRAINT "ck_file_attr_line_counts";`,
						facets: ["checks"],
						match: /^check constraint ck_file_attr_line_counts: missing/,
					},
					{
						label: "dropped identity",
						sql: `ALTER TABLE "narrators" ALTER COLUMN "insert_seq" DROP IDENTITY;`,
						facets: ["columns", "sequences"],
						match: /^column narrators\.insert_seq: expected/,
					},
					{
						label: "dropped generated column",
						sql: `ALTER TABLE "narrator_tool_calls" DROP COLUMN "started_at";`,
						facets: ["columns", "generated", "indexes"],
						match: /^generated column narrator_tool_calls\.started_at: missing/,
					},
				];
				for (const tamper of tampers) {
					const applied = await exec(tamper.sql);
					if (applied.code !== 0) {
						problems.push(
							`tamper "${tamper.label}" could not be applied: ${applied.stderr.slice(0, 200)}`,
						);
						continue;
					}
					const after = await readCatalog(exec, tamper.facets);
					const reported = compareBaseline(
						expected,
						{ ...read.catalog, ...pick(after.catalog, tamper.facets) },
						canonical.canonical,
						serverCounts,
					);
					if (reported.some((problem) => tamper.match.test(problem))) {
						tamperDetected.push(tamper.label);
					}
				}

				return {
					problems,
					observed: {
						tables: read.catalog.tables.length,
						columns: read.catalog.columns.length,
						foreignKeys: read.catalog.foreignKeys.length,
						indexes: read.catalog.indexes.length,
						uniques: read.catalog.uniques.length,
						checks: read.catalog.checks.length,
						generated: read.catalog.generated.length,
						canonicalExpressions: canonical.canonical.size,
						migrationStatements,
						ledgerRows: ledger.length,
						replayQueries,
						rawReplayFailed: rawReplay.code !== 0,
						swappedOrdinalityDiffers: Number(ordinality),
						unquotedAliasFolds: !("foreignKeys" in alias) && "foreignkeys" in alias,
						tamperDetected,
					},
				};
			});

			// A harness status means PostgreSQL never ran the comparison. Only an unusable
			// container runtime may be reported as blocked; a failed callback is a failure.
			if ("status" in result) {
				throw new Error(`PostgreSQL baseline did not complete: ${JSON.stringify(result)}`);
			}

			const { problems, observed } = result;
			console.log("PG17 fresh baseline:", JSON.stringify(observed));
			// Landmarks first: they make an empty problem list mean "compared and agreed"
			// rather than "compared nothing".
			// Exactly the statements on disk: a migrator that silently applied a subset (or
			// nothing, because the ledger looked satisfied) must not reach the comparison.
			expect(observed.migrationStatements).toBe(statements);
			expect(observed.ledgerRows).toBe(entries.length);
			expect(observed.replayQueries).toBe(0);
			expect(observed.rawReplayFailed).toBe(true);
			expect({
				tables: observed.tables,
				columns: observed.columns,
				foreignKeys: observed.foreignKeys,
				uniques: observed.uniques,
				checks: observed.checks,
				generated: observed.generated,
			}).toEqual({
				tables: expected.counts.tables,
				columns: expected.counts.columns,
				foreignKeys: expected.counts.foreignKeys,
				uniques: expected.counts.uniqueConstraints,
				checks: expected.counts.checkConstraints,
				generated: expected.counts.generatedColumns,
			});
			expect(observed.indexes).toBe(expected.counts.indexes);
			expect(observed.canonicalExpressions).toBe(requests.length);
			// The catalog query defects this file used to have are load-bearing to fix.
			expect(observed.swappedOrdinalityDiffers).toBeGreaterThan(0);
			expect(observed.unquotedAliasFolds).toBe(true);
			// And the gate can still fail on real damage.
			expect(observed.tamperDetected).toEqual([
				"dropped foreign key",
				"dropped index",
				"changed default",
				"dropped unique constraint",
				"dropped check constraint",
				"dropped identity",
				"dropped generated column",
			]);
			expect(problems).toEqual([]);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"upgrades the real old baseline with rows, backfills counters and preserves every constraint",
		async () => {
			const { entries, hashes } = await loadJournal();
			expect(entries[0]?.tag).toBe("0000_elite_unus");
			expect(entries[1]?.tag).toBe("0001_seq_counters");
			const baselineFolder = await mkdtemp(join(tmpdir(), "nf-pg-baseline-prefix-"));
			let callbackError: unknown;
			try {
				// Use the authentic journal prefix and SQL, not invented timestamps/hashes.
				const journal = JSON.parse(
					await readFile(`${MIGRATIONS_FOLDER}/meta/_journal.json`, "utf8"),
				);
				await mkdir(join(baselineFolder, "meta"));
				await writeFile(
					join(baselineFolder, "meta/_journal.json"),
					JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }),
				);
				await copyFile(
					`${MIGRATIONS_FOLDER}/${entries[0].tag}.sql`,
					join(baselineFolder, `${entries[0].tag}.sql`),
				);
				const snapshot = await loadSnapshot(entries);
				const prior = await Promise.all(entries.slice(0, -1).map((entry) => loadSnapshot([entry])));
				const built = buildExpected(snapshot, prior);
				const result = await withPostgres(async ({ exec }) => {
					try {
						const run = async (sql: string) => {
							const outcome = await exec(sql);
							if (outcome.code !== 0)
								throw new Error(`upgrade SQL failed: ${outcome.stderr.slice(-1500)}`);
							return outcome;
						};
						const db = drizzleProxy(psqlProxyCallback(exec)) as unknown as PgRemoteDatabase;
						const apply = (folder: string) =>
							migrate(
								db,
								async (queries) => {
									await run(`BEGIN;\n${migrationScript(queries)}\nCOMMIT;`);
								},
								{ migrationsFolder: folder },
							);
						await apply(baselineFolder);
						await run(`INSERT INTO narrators (id, created_at, updated_at) VALUES ('old-a','t','t'), ('old-empty','t','t');
INSERT INTO narrator_messages (id,narrator_id,role,content_json,created_at) VALUES ('m0','old-a','user','[]','t'),('m5','old-a','user','[]','t'),('m11','old-a','user','[]','t');
INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES ('r0','old-a','m0',0),('r5','old-a','m5',5),('r11','old-a','m11',11);
INSERT INTO narrator_tool_calls (id,narrator_id,message_id,tool_use_id,tool_name,created_at) VALUES ('tc1','old-a','m0','tu1','Bash','t'),('tc2','old-a','m0','tu2','Bash','t');
INSERT INTO narrator_tool_continuations (id,tool_call_id,narrator_id,update_epoch,kind,created_at,updated_at) VALUES ('c1','tc1','old-a','epoch','deferred_tool','t','t'),('c2','tc2','old-a','epoch','deferred_tool','t','t');
INSERT INTO background_tasks (id,parent_narrator_id,type,status,started_at,created_at,updated_at) VALUES ('b1','old-a','bash','running','t','t','t'),('b2','old-a','bash','running','t','t','t');`);
						const constraintsSql = `SELECT json_build_object('count',count(*),'signature',md5(string_agg(json_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid))::text,E'\\n' ORDER BY c.relname,k.conname)))::text FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE k.connamespace='public'::regnamespace`;
						const oldConstraints = await readJson(exec, constraintsSql, "old constraints");
						await apply(MIGRATIONS_FOLDER);
						expect(await readJson(exec, constraintsSql, "upgraded constraints")).toEqual(
							oldConstraints,
						);
						const queryRows = async (sql: string) =>
							(await readJson(
								exec,
								`SELECT coalesce(json_agg(x),'[]'::json)::text FROM (${sql}) x`,
								"upgrade probe",
							)) as Record<string, unknown>[];
						expect(await queryRows(`SELECT id,next_seq FROM narrators ORDER BY id`)).toEqual([
							{ id: "old-a", next_seq: 12 },
							{ id: "old-empty", next_seq: 0 },
						]);
						for (const table of ["background_tasks", "narrators", "narrator_tool_continuations"]) {
							expect(
								await queryRows(`SELECT insert_seq FROM ${table} ORDER BY insert_seq`),
							).toEqual([{ insert_seq: 1 }, { insert_seq: 2 }]);
							const sequence = `${table}_insert_seq_seq`;
							expect(await queryRows(`SELECT last_value,is_called FROM ${sequence}`)).toEqual([
								{ last_value: 3, is_called: false },
							]);
						}
						await run(`INSERT INTO narrators (id,created_at,updated_at) VALUES ('new','t','t');
INSERT INTO background_tasks (id,parent_narrator_id,type,status,started_at,created_at,updated_at) VALUES ('b3','old-a','bash','running','t','t','t');
INSERT INTO narrator_tool_calls (id,narrator_id,message_id,tool_use_id,tool_name,created_at) VALUES ('tc3','old-a','m0','tu3','Bash','t');
INSERT INTO narrator_tool_continuations (id,tool_call_id,narrator_id,update_epoch,kind,created_at,updated_at) VALUES ('c3','tc3','old-a','epoch','deferred_tool','t','t');`);
						expect(
							await queryRows(`SELECT next_seq,insert_seq FROM narrators WHERE id='new'`),
						).toEqual([{ next_seq: 0, insert_seq: 3 }]);
						for (const table of ["background_tasks", "narrators", "narrator_tool_continuations"]) {
							expect(
								await queryRows(`SELECT insert_seq FROM ${table} ORDER BY insert_seq`),
							).toEqual([{ insert_seq: 1 }, { insert_seq: 2 }, { insert_seq: 3 }]);
						}
						// Append and interior shift share the counter, with no unique seq index.
						await run(`INSERT INTO narrator_messages (id,narrator_id,role,content_json,created_at) VALUES ('m12','old-a','user','[]','t'),('m-shift','old-a','user','[]','t');
BEGIN;
WITH claimed AS (UPDATE narrators SET next_seq=next_seq+1 WHERE id='old-a' RETURNING next_seq-1 AS seq)
INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) SELECT 'new-ref','old-a','m12',seq FROM claimed;
COMMIT;
BEGIN;
UPDATE narrators SET next_seq=next_seq+1 WHERE id='old-a';
UPDATE narrator_message_refs SET seq=seq+1 WHERE narrator_id='old-a' AND seq>=5;
INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES ('shift-ref','old-a','m-shift',5);
COMMIT;
BEGIN; UPDATE narrators SET next_seq=next_seq+1 WHERE id='old-a'; ROLLBACK;`);
						expect(await queryRows(`SELECT next_seq FROM narrators WHERE id='old-a'`)).toEqual([
							{ next_seq: 14 },
						]);
						expect(
							(
								await queryRows(
									`SELECT seq FROM narrator_message_refs WHERE narrator_id='old-a' ORDER BY seq`,
								)
							).map((row) => row.seq),
						).toEqual([0, 5, 6, 12, 13]);
						// Explicit SQLite-rowid-style imports are accepted by BY DEFAULT on all three tables.
						await run(`INSERT INTO narrators (id,created_at,updated_at,insert_seq) VALUES ('imported','t','t',42);
INSERT INTO background_tasks (id,parent_narrator_id,type,status,started_at,created_at,updated_at,insert_seq) VALUES ('b-imported','old-a','bash','running','t','t','t',42);
INSERT INTO narrator_tool_calls (id,narrator_id,message_id,tool_use_id,tool_name,created_at) VALUES ('tc4','old-a','m0','tu4','Bash','t'),('tc5','old-a','m0','tu5','Bash','t');
INSERT INTO narrator_tool_continuations (id,tool_call_id,narrator_id,update_epoch,kind,created_at,updated_at,insert_seq) VALUES ('c-imported','tc4','old-a','epoch','deferred_tool','t','t',42);`);
						// Execute the exact generated migration setval statements, not a test-only variant.
						const counterSql = await readFile(`${MIGRATIONS_FOLDER}/${entries[1].tag}.sql`, "utf8");
						const setvals = counterSql
							.split("--> statement-breakpoint")
							.filter((sql) => /^\s*SELECT setval\(/.test(sql));
						expect(setvals.length).toBe(3);
						await run(setvals.join("\n"));
						await run(`INSERT INTO narrators (id,created_at,updated_at) VALUES ('after-import','t','t');
INSERT INTO background_tasks (id,parent_narrator_id,type,status,started_at,created_at,updated_at) VALUES ('b-after','old-a','bash','running','t','t','t');
INSERT INTO narrator_tool_continuations (id,tool_call_id,narrator_id,update_epoch,kind,created_at,updated_at) VALUES ('c-after','tc5','old-a','epoch','deferred_tool','t','t');`);
						for (const table of ["background_tasks", "narrators", "narrator_tool_continuations"]) {
							expect(await queryRows(`SELECT max(insert_seq) AS top FROM ${table}`)).toEqual([
								{ top: 43 },
							]);
						}
						const read = await readCatalog(exec);
						const counts = (await readJson(exec, COUNTS_SQL, "upgraded counts")) as Record<
							string,
							number
						>;
						const requests = deparseRequests(built.expected);
						const deparsed = await run(buildDeparseScript(requests));
						const canonical = parseDeparseOutput(requests, deparsed.stdout);
						expect([
							...built.problems,
							...read.problems,
							...canonical.problems,
							...compareBaseline(built.expected, read.catalog, canonical.canonical, counts),
						]).toEqual([]);
						expect(counts.foreignKeys).toBe(207);
						expect(counts.identityColumns).toBe(3);
						expect(counts.sequences).toBe(3);
						const ledger = await queryRows(
							`SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
						);
						expect(checkMigrationLedger(entries, hashes, ledger as LedgerRow[])).toEqual([]);
						// A real ledger replay must not rerun backfill and lower an already-advanced counter.
						await run(`UPDATE narrators SET next_seq=99 WHERE id='old-a'`);
						await apply(MIGRATIONS_FOLDER);
						expect(await queryRows(`SELECT next_seq FROM narrators WHERE id='old-a'`)).toEqual([
							{ next_seq: 99 },
						]);
						return {
							counts,
							ledgerRows: ledger.length,
							refSeqs: [0, 5, 6, 12, 13],
							importedIdentityNext: 43,
						};
					} catch (error) {
						callbackError = error;
						throw error;
					}
				});
				if (callbackError) throw callbackError;
				if ("status" in result)
					throw new Error(`Real PG17 upgrade did not execute: ${JSON.stringify(result)}`);
				console.log("PG17 old-baseline upgrade:", JSON.stringify(result));
			} finally {
				await rm(baselineFolder, { recursive: true, force: true });
			}
		},
		RUN_TIMEOUT_MS,
	);
});

/** Replace only the re-read facets, keeping the rest of the first full read. */
function pick(catalog: Catalog, facets: FacetName[]): Partial<Catalog> {
	const out: Partial<Catalog> = {};
	for (const facet of facets) out[facet] = catalog[facet] as never;
	return out;
}
