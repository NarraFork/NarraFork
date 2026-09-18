/**
 * The wrapper-equivalence suite, run against the PostgreSQL counterparts on a
 * real PostgreSQL 17 — and PROVEN equal to the SQLite originals.
 *
 * The same four scenarios the SQLite baseline runs
 * (`server/services/__tests__/write-counterparts-equivalence.test.ts`) execute
 * twice here: once through the SQLite kit over an in-memory database (the same
 * `sqlite-kit.ts` factory, with `@server/db` mocked to it), once through the PG
 * kit over a throwaway container with every `drizzle-postgres` migration applied
 * verbatim. The suite's internal assertions pin the expected behavior per
 * backend; the final `toEqual` on the returned projections is the equivalence
 * claim itself — same durable facts, same domain verdicts, same error codes.
 *
 * Rules, same as the other PG suites:
 *   - `PG_INTEGRATION=1` means PostgreSQL really has to run. A blocked harness is
 *     a failure in that mode, never a quiet pass;
 *   - migrations are applied EXACTLY as committed;
 *   - the container is the harness' own random name and only it is cleaned up.
 */
import { afterAll, describe, expect, it, mock } from "bun:test";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import { withPostgres } from "../../../db/pg-test-harness";
import { getTestDb } from "../../../setup";
import { migrationSql } from "../read/pg-parity-matrix";
import {
	blobCatalogScenario,
	evidenceScenario,
	revertFlowScenario,
	workspaceLeaseScenario,
} from "./equivalence-suite";
import { makePostgresKit } from "./pg-kit";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 300_000;

// The SQLite kit pulls in `@server/db` through the production classes' types; it
// is mocked over the isolated in-memory database exactly as the other PG suites
// do — the PG path under test never touches it.
const { db: sqliteDb, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../../server/db")) };
mock.module("../../../../server/db", () => ({ db: sqliteDb, sqlite }));

const { makeSqliteKit } = await import("./sqlite-kit");

afterAll(() => {
	mock.module("../../../../server/db", () => realDbModule);
	mock.restore();
	sqlite.close();
});

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
		credentials.password,
	)}@127.0.0.1:${port}/nf_harness`;
}

describe("PostgreSQL wrapper equivalence", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"produces the same durable facts and verdicts as the SQLite originals",
		async () => {
			const sqls = await migrationSql();
			const outcome = await withPostgres(async ({ exec, port, credentials }) => {
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

				const client = createPostgresClient({
					driver: "bun-sql",
					url: urlFor(port, credentials),
					max: 4,
					connectTimeout: 10,
				});
				try {
					const pgDb: BunSQLDatabase = client.db;
					const problems: string[] = [];
					const check = async (label: string, fn: () => Promise<unknown>): Promise<unknown> => {
						try {
							return await fn();
						} catch (error) {
							problems.push(
								`${label}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`.slice(
									0,
									900,
								),
							);
							return undefined;
						}
					};

					const pgKit = makePostgresKit(pgDb);
					const pgProjections: Record<string, unknown> = {};
					pgProjections.blob = await check("blob", () => blobCatalogScenario(pgKit));
					pgProjections.workspace = await check("workspace", () => workspaceLeaseScenario(pgKit));
					pgProjections.evidence = await check("evidence", () => evidenceScenario(pgKit));
					pgProjections.revert = await check("revert", () => revertFlowScenario(pgKit));

					const sqliteKit = makeSqliteKit(sqliteDb as never);
					const sqliteProjections: Record<string, unknown> = {};
					sqliteProjections.blob = await check("sqlite blob", () => blobCatalogScenario(sqliteKit));
					sqliteProjections.workspace = await check("sqlite workspace", () =>
						workspaceLeaseScenario(sqliteKit),
					);
					sqliteProjections.evidence = await check("sqlite evidence", () =>
						evidenceScenario(sqliteKit),
					);
					sqliteProjections.revert = await check("sqlite revert", () =>
						revertFlowScenario(sqliteKit),
					);

					return { problems, pgProjections, sqliteProjections };
				} finally {
					await client.close();
				}
			});

			if ("status" in outcome && outcome.status === "blocked") {
				throw new Error(`PostgreSQL harness blocked: ${outcome.reason}`);
			}
			if ("status" in outcome && outcome.status === "failed") {
				throw new Error(`PostgreSQL harness failed: ${outcome.reason}`);
			}
			const result = outcome as {
				migrationError?: string;
				problems: string[];
				pgProjections: Record<string, unknown>;
				sqliteProjections: Record<string, unknown>;
			};
			if (result.migrationError) {
				throw new Error(`PostgreSQL migration failed: ${result.migrationError}`);
			}
			expect(result.problems).toEqual([]);
			// THE EQUIVALENCE CLAIM: same scenarios, same projections, both backends.
			expect(result.pgProjections).toEqual(result.sqliteProjections);
		},
		RUN_TIMEOUT_MS,
	);
});
