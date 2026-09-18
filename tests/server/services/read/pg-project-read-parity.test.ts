/**
 * PostgreSQL / SQLite parity for the project read adapters, on identical non-empty data.
 *
 * The fixtures in `read-fixtures.ts` are written to a throwaway in-memory SQLite database
 * and to a fresh PostgreSQL 17 container that has had every `drizzle-postgres` journal
 * migration applied. Each case in `pg-parity-matrix.ts` then runs the SAME adapter call
 * against both and compares the results, so a difference means the two implementations
 * disagree rather than the two datasets differing.
 *
 * ## The image matrix: musl AND glibc, on purpose
 *
 * The comparison runs against TWO PostgreSQL 17 images, `postgres:17-alpine` (musl) and
 * `postgres:17` (glibc). This is not redundancy: the cross-backend defect this suite exists
 * to prevent is INVISIBLE on musl, because musl's `en_US.utf8` collation degenerates to byte
 * order — the same rule SQLite's BINARY collation uses. glibc's `en_US.utf8` instead orders
 * case-insensitively at the primary level (`'Zed' < 'abc'` is FALSE there, TRUE in byte
 * order), and ids come from `nanoid`'s mixed-case alphabet, so real data always straddles
 * the divergence. A suite that runs Alpine only is green while the agreement it claims does
 * not hold on a glibc deployment — which is precisely how this suite was green while the
 * adapters disagreed.
 *
 * `PG_TEST_IMAGE` still overrides the matrix with a single explicit image, matching the
 * harness' rule that an explicitly requested image is never substituted; with it unset, both
 * variants run, each as its own test so a failure names the image it happened on.
 *
 * Rules this suite does not bend:
 *   - `PG_INTEGRATION=1` means PostgreSQL really has to run. A blocked harness is a
 *     failure in that mode, never a quiet pass;
 *   - migrations are applied EXACTLY as committed. When they fail, this test fails —
 *     patching the SQL to get further would hide a defect that also breaks production;
 *   - an adapter that throws is reported as a difference, not swallowed;
 *   - positive cases assert their shared result is non-empty, because two empty results
 *     agree about nothing;
 *   - nothing is skipped. The four oversized cases (`listChapters`/`getGraph` on a
 *     205-chapter project, and the 200-row clamp) take no paging parameter and produce a
 *     ~221KB payload the harness' 16KiB command cap cannot carry; they are relayed in
 *     chunks instead of being declared unobservable. `OVERSIZED_CASES` is pinned empty.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import * as pgSchema from "../../../../server/db/postgres-schema";
import * as schema from "../../../../server/db/schema";
import { withPostgres } from "../../../db/pg-test-harness";
import { cleanDb, getTestDb } from "../../../setup";
import {
	chunkedProxyDb,
	compareAll,
	migrationSql,
	OVERSIZED_CASES,
	principal,
	type ReadAdapterLike,
	type RelayStats,
} from "./pg-parity-matrix";
import { type FixtureTable, seedFixtures } from "./read-fixture-seed";
import { NARRATOR, PRIV_CHAPTER_IDS_ORDERED, PROJECT, USER } from "./read-fixtures";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
/**
 * Containers run sequentially — the task budget allows no parallel PostgreSQL runs. Each
 * image gets its own timeout; a full matrix run against one image takes ~80s here.
 */
const RUN_TIMEOUT_MS = 300_000;

/**
 * The images every default run compares against, musl first.
 *
 * Both are PostgreSQL 17, so a failure on exactly one of them is about the C LIBRARY, not
 * the server version — and that distinction is the whole point: musl's `en_US.utf8`
 * collation degenerates to byte order and cannot reveal the cross-backend ordering defect,
 * glibc's cannot hide it. `PG_TEST_IMAGE`, when set, narrows the matrix to that one image
 * rather than being added to it: the harness treats an explicit image as "exactly this,
 * never a substitute", and a matrix of three would silently change what the variable means.
 */
const PARITY_IMAGES = process.env.PG_TEST_IMAGE
	? [process.env.PG_TEST_IMAGE]
	: ["docker.io/library/postgres:17-alpine", "docker.io/library/postgres:17"];

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../../server/db")) };
mock.module("../../../../server/db", () => ({ db, sqlite }));

const { SqliteProjectReadAdapter } = await import(
	"../../../../server/services/read/sqlite-project-read-adapter"
);
const { PostgresProjectReadAdapter } = await import(
	"../../../../server/services/read/postgres-project-read-adapter"
);

const sqliteAdapter = new SqliteProjectReadAdapter() as unknown as ReadAdapterLike;

const SQLITE_TABLES: Record<FixtureTable, unknown> = {
	users: schema.users,
	projects: schema.projects,
	chapters: schema.chapters,
	chapterEdges: schema.chapterEdges,
	narrators: schema.narrators,
	containerInstances: schema.containerInstances,
	aclGrants: schema.aclGrants,
};

const PG_TABLES: Record<FixtureTable, unknown> = {
	users: pgSchema.users,
	projects: pgSchema.projects,
	chapters: pgSchema.chapters,
	chapterEdges: pgSchema.chapterEdges,
	narrators: pgSchema.narrators,
	containerInstances: pgSchema.containerInstances,
	aclGrants: pgSchema.aclGrants,
};

beforeAll(async () => {
	await seedFixtures(async (table, rows) => {
		// biome-ignore lint/suspicious/noExplicitAny: fixture rows are backend-agnostic bags
		await (db as any).insert(SQLITE_TABLES[table] as any).values(rows as any);
	});
});

afterAll(() => {
	mock.module("../../../../server/db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
	sqlite.close();
});

/**
 * Landmarks proving the fixtures reached PostgreSQL, read with plain counts.
 *
 * Deliberately not read through `getGraphAuxiliaryData`: a broken adapter must surface as
 * a parity failure naming the call, not as a misleading "fixtures missing".
 */
async function pgFixtureProblems(pgDb: BunSQLDatabase): Promise<string[]> {
	const problems: string[] = [];
	const rows = await pgDb
		.select({
			projects: sql<number>`(select count(*) from ${pgSchema.projects})`,
			chapters: sql<number>`(select count(*) from ${pgSchema.chapters})`,
			edges: sql<number>`(select count(*) from ${pgSchema.chapterEdges})`,
			narrators: sql<number>`(select count(*) from ${pgSchema.narrators})`,
			containers: sql<number>`(select count(*) from ${pgSchema.containerInstances} where status <> 'removed')`,
			panels: sql<number>`(select count(*) from ${pgSchema.chapters} where detached_panels_json is not null)`,
			grants: sql<number>`(select count(*) from ${pgSchema.aclGrants})`,
			privNarrator: sql<number>`(select count(*) from ${pgSchema.narrators} where id = ${NARRATOR.privOther})`,
		})
		.from(pgSchema.projects)
		.limit(1);
	const row = rows[0];
	for (const [label, value] of Object.entries(row ?? {})) {
		if (Number(value) === 0) problems.push(`PostgreSQL fixture group empty: ${label}`);
	}
	return problems;
}

describe("PostgreSQL vs SQLite project read parity", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL comparison", () => {
			// Explicitly a skip, not a pass: no PostgreSQL work happened here.
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	for (const image of PARITY_IMAGES) {
		it(
			`agrees on every case of the read matrix against ${image}`,
			async () => {
				const sqls = await migrationSql();
				const outcome = await withPostgres(
					async ({ exec, port }) => {
						expect(port).toBeGreaterThan(0);
						for (const statement of sqls) {
							const applied = await exec(statement);
							if (applied.code !== 0) {
								return {
									migrationError: applied.stderr
										.split("\n")
										.filter((line) => !line.startsWith("NOTICE:"))
										.join("\n")
										.slice(0, 400),
								};
							}
						}
						// The relaying handle: identical for every ordinary statement, and able to carry
						// the unpaged 201-row responses that used to be skipped outright.
						const relayStats: RelayStats = { relayed: 0 };
						const pgDb = chunkedProxyDb(exec, relayStats);
						try {
							await seedFixtures(async (table, rows) => {
								// biome-ignore lint/suspicious/noExplicitAny: fixture rows are backend-agnostic bags
								await (pgDb as any).insert(PG_TABLES[table] as any).values(rows as any);
							});
						} catch (error) {
							return { seedError: String(error).slice(0, 400) };
						}
						const fixtureProblems = await pgFixtureProblems(pgDb);
						if (fixtureProblems.length > 0) return { problems: fixtureProblems, skipped: [] };
						const pgAdapter = new PostgresProjectReadAdapter(pgDb) as unknown as ReadAdapterLike;
						// A landmark read before the matrix, so "PostgreSQL answered at all" is
						// established independently of the comparison.
						const landmark = (await pgAdapter.listChapters(
							PROJECT.priv,
							principal(USER.admin, true),
						)) as Array<{ id: string }>;
						if (landmark.map((r) => r.id).join(",") !== PRIV_CHAPTER_IDS_ORDERED.join(",")) {
							return {
								problems: [`PostgreSQL landmark read wrong: ${landmark.map((r) => r.id)}`],
								skipped: [],
							};
						}
						const compared = await compareAll(sqliteAdapter, pgAdapter);
						return { ...compared, relayed: relayStats.relayed };
					},
					{ image },
				);

				// A harness status here means PostgreSQL did not actually run the matrix. With
				// PG_INTEGRATION=1 that is a failure, never a skip.
				if ("status" in (outcome as Record<string, unknown>)) {
					throw new Error(
						`PostgreSQL integration required but harness returned ${JSON.stringify(outcome)} for ${image}`,
					);
				}
				const result = outcome as {
					problems?: string[];
					skipped?: string[];
					compared?: number;
					relayed?: number;
					migrationError?: string;
					seedError?: string;
				};
				if (result.migrationError) {
					throw new Error(`PostgreSQL migration failed: ${result.migrationError}`);
				}
				if (result.seedError) {
					throw new Error(`PostgreSQL fixture seeding failed: ${result.seedError}`);
				}
				// Skips are pinned, and the set is now EMPTY: every case in the matrix is compared
				// against real PostgreSQL. A case that starts skipping itself fails here rather than
				// quietly dropping out of the comparison.
				expect(OVERSIZED_CASES).toEqual([]);
				expect(result.skipped ?? ["matrix did not run"]).toEqual([...OVERSIZED_CASES]);
				// Pinned exactly, not as a lower bound: a case silently dropping out of the matrix
				// would otherwise still satisfy a `>` check. Raise this when cases are added.
				expect(result.compared ?? 0).toBe(103);
				// At least one response really exceeded the harness cap and was relayed. Without
				// this, shrinking the bulk fixtures below 200 rows would leave the oversized cases
				// green while no longer testing anything oversized.
				expect(result.relayed ?? 0).toBeGreaterThan(0);
				expect(result.problems ?? ["matrix did not run"]).toEqual([]);
			},
			RUN_TIMEOUT_MS,
		);
	}
});
