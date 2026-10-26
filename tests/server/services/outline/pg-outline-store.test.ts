/**
 * The outline store contract against a real PostgreSQL: the same cases as
 * `server/services/outline/__tests__/store-contract.test.ts` (SQLite), run through the
 * PostgreSQL store and the write path over a pooled network connection, on a database that has
 * every `drizzle-postgres` migration applied verbatim plus the pg_trgm search catalog
 * (`ensurePgFts`).
 *
 * The concurrency case is genuine here: racing writers hold separate pooled connections, so the
 * space counter's row lock is what serializes them.
 *
 * Rules, same as the other PostgreSQL suites:
 *   - `PG_INTEGRATION=1` means PostgreSQL really has to run; a blocked harness fails;
 *   - migrations are applied exactly as committed;
 *   - the harness owns and removes its database.
 */
import { describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { ensurePgFts } from "../../../../server/db/pg-fts";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import * as pgSchema from "../../../../server/db/postgres-schema";
import { generateId } from "../../../../server/lib/id";
import {
	OUTLINE_STORE_CONTRACT,
	type OutlineContractContext,
	type SpaceDump,
} from "../../../../server/services/outline/__tests__/contract";
import type { OutlineTaskJson } from "../../../../server/services/outline/model";
import {
	chunked,
	type OutlineLinkRow,
	type OutlineVersionRow,
} from "../../../../server/services/outline/store/port";
import { createPostgresOutlineStore } from "../../../../server/services/outline/store/postgres-store";
import { withPostgres } from "../../../db/pg-test-harness";
import { migrationSql } from "../read/pg-parity-matrix";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 600_000;
const NOW = "2026-10-26T00:00:00.000Z";

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
		credentials.password,
	)}@127.0.0.1:${port}/nf_harness`;
}

const task = (value: unknown) => (value ?? null) as OutlineTaskJson | null;

describe("PostgreSQL outline store", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			// Explicitly a skip, not a pass: no PostgreSQL work happened here.
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"satisfies the outline store contract on a real server",
		async () => {
			const sqls = await migrationSql();
			const outcome = await withPostgres(async ({ exec, port, credentials }) => {
				for (const statement of sqls) {
					const applied = await exec(statement);
					if (applied.code !== 0) return { migrationError: applied.stderr.slice(0, 400) };
				}
				const client = createPostgresClient({
					driver: "bun-sql",
					url: urlFor(port, credentials),
					max: 8,
					connectTimeout: 10,
				});
				const pgDb: BunSQLDatabase = client.db;
				await ensurePgFts(client.sql);
				const store = createPostgresOutlineStore(pgDb);
				const ctx: OutlineContractContext = {
					store,
					randomTransactions: 40,
					async seedUser() {
						const id = generateId();
						await pgDb.insert(pgSchema.users).values({
							id,
							username: `outline-${id}`,
							passwordHash: "x",
							role: "user",
							createdAt: NOW,
						});
						return id;
					},
					async seedProject() {
						const id = generateId();
						await pgDb
							.insert(pgSchema.projects)
							.values({ id, name: `outline-${id}`, createdAt: NOW, updatedAt: NOW });
						return id;
					},
					async seedNarrator() {
						const id = generateId();
						await pgDb
							.insert(pgSchema.narrators)
							.values({ id, title: "outline", createdAt: NOW, updatedAt: NOW });
						return id;
					},
					async dump(spaceId): Promise<SpaceDump> {
						const space = await store.getSpace(spaceId);
						if (!space) throw new Error(`no space ${spaceId}`);
						const blocks = (
							await pgDb
								.select()
								.from(pgSchema.outlineBlocks)
								.where(eq(pgSchema.outlineBlocks.spaceId, spaceId))
						).map((b) => ({
							...b,
							taskJson: task(b.taskJson),
							authorKind: b.authorKind as "human" | "agent" | "system",
						}));
						const versions: OutlineVersionRow[] = [];
						for (const ids of chunked(blocks.map((b) => b.id))) {
							const rows = await pgDb
								.select()
								.from(pgSchema.outlineBlockVersions)
								.where(inArray(pgSchema.outlineBlockVersions.blockId, ids));
							for (const v of rows) versions.push({ ...v, taskJson: task(v.taskJson) });
						}
						const links = (
							await pgDb
								.select()
								.from(pgSchema.outlineLinks)
								.where(eq(pgSchema.outlineLinks.spaceId, spaceId))
						).map((l) => l as OutlineLinkRow);
						const commits = (
							await pgDb
								.select()
								.from(pgSchema.outlineCommits)
								.where(eq(pgSchema.outlineCommits.spaceId, spaceId))
								.orderBy(pgSchema.outlineCommits.seq)
						).map((c) => c as SpaceDump["commits"][number]);
						return { space, blocks, versions, links, commits };
					},
					async searchContent(needle) {
						const rows = await client.sql.unsafe(
							"SELECT id FROM search_outline_blocks WHERE content ILIKE $1",
							[`%${needle}%`],
						);
						return rows.map((r: { id: string }) => r.id).sort();
					},
				};

				const problems: string[] = [];
				const passed: string[] = [];
				try {
					for (const contractCase of OUTLINE_STORE_CONTRACT) {
						try {
							await contractCase.run(ctx);
							passed.push(contractCase.name);
						} catch (error) {
							problems.push(
								`${contractCase.name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`.slice(
									0,
									2000,
								),
							);
						}
					}
				} finally {
					await client.close();
				}
				return { problems, passed };
			});
			if (!outcome || typeof outcome !== "object" || !("problems" in outcome)) {
				throw new Error(`PostgreSQL harness did not run: ${JSON.stringify(outcome)}`);
			}
			expect(outcome.problems).toEqual([]);
			expect(outcome.passed).toHaveLength(OUTLINE_STORE_CONTRACT.length);
		},
		RUN_TIMEOUT_MS,
	);
});
