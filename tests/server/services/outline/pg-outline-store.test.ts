/**
 * The outline store and read contracts against a real PostgreSQL: the same cases as
 * `server/services/outline/__tests__/store-contract.test.ts` (SQLite), run through the
 * PostgreSQL store, the write path and the read services over a pooled network connection, on a
 * database that has every `drizzle-postgres` migration applied verbatim plus the pg_trgm search
 * catalog (`ensurePgFts`).
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
import { eq, inArray, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { ensurePgFts } from "../../../../server/db/pg-fts";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import * as pgSchema from "../../../../server/db/postgres-schema";
import { generateId } from "../../../../server/lib/id";
import {
	OUTLINE_STORE_CONTRACT,
	type SpaceDump,
} from "../../../../server/services/outline/__tests__/contract";
import {
	OUTLINE_DIGEST_CONTRACT,
	type OutlineDigestContractContext,
} from "../../../../server/services/outline/__tests__/digest-contract";
import { OUTLINE_HISTORY_CONTRACT } from "../../../../server/services/outline/__tests__/history-contract";
import { OUTLINE_PENDING_CONTRACT } from "../../../../server/services/outline/__tests__/pending-contract";
import { OUTLINE_QUESTION_CONTRACT } from "../../../../server/services/outline/__tests__/question-contract";
import { OUTLINE_READ_CONTRACT } from "../../../../server/services/outline/__tests__/read-contract";
import { OUTLINE_TASK_CONTRACT } from "../../../../server/services/outline/__tests__/task-contract";
import type { OutlineTaskJson } from "../../../../server/services/outline/model";
import type { OutlineEdgeRow } from "../../../../server/services/outline/store/history-port";
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
		"satisfies the outline store and read contracts on a real server",
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
				const ctx: OutlineDigestContractContext = {
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
					async seedNarrator(related) {
						const id = generateId();
						await pgDb.insert(pgSchema.narrators).values({
							id,
							title: "outline",
							createdAt: NOW,
							updatedAt: NOW,
							...(related && "forkOf" in related
								? { parentNarratorId: related.forkOf }
								: related
									? {
											type: "subagent" as const,
											parentNarratorId: related.parentId,
											aclRootNarratorId: related.rootId,
										}
									: {}),
						});
						return id;
					},
					async archiveNarrator(narratorId) {
						await pgDb
							.update(pgSchema.narrators)
							.set({ status: "archived" })
							.where(eq(pgSchema.narrators.id, narratorId));
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
							askJson: (b.askJson ?? null) as OutlineVersionRow["askJson"],
							authorKind: b.authorKind as "human" | "agent" | "system",
						}));
						const versions: OutlineVersionRow[] = [];
						const edges: OutlineEdgeRow[] = [];
						const marks: Array<{ ancestorId: string; seq: number }> = [];
						for (const ids of chunked(blocks.map((b) => b.id))) {
							edges.push(
								...(await pgDb
									.select()
									.from(pgSchema.outlineBlockEdges)
									.where(inArray(pgSchema.outlineBlockEdges.blockId, ids))),
							);
							marks.push(
								...(await pgDb
									.select()
									.from(pgSchema.outlineSubtreeChanges)
									.where(inArray(pgSchema.outlineSubtreeChanges.ancestorId, ids))),
							);
							const rows = await pgDb
								.select()
								.from(pgSchema.outlineBlockVersions)
								.where(inArray(pgSchema.outlineBlockVersions.blockId, ids));
							for (const v of rows)
								versions.push({
									...v,
									taskJson: task(v.taskJson),
									askJson: (v.askJson ?? null) as OutlineVersionRow["askJson"],
								});
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
						const claims = await store.getTaskClaims(blocks.map((b) => b.id));
						const history = (await store.getHistoryStates([spaceId])).get(spaceId);
						if (!history) throw new Error(`no history state for ${spaceId}`);
						return { space, blocks, versions, links, commits, claims, edges, marks, history };
					},
					async resetInProcess(spaceId) {
						await pgDb
							.update(pgSchema.outlineSpaces)
							.set({ inProcessReady: false })
							.where(eq(pgSchema.outlineSpaces.id, spaceId));
						await pgDb
							.update(pgSchema.outlineBlocks)
							.set({ inProcess: false })
							.where(eq(pgSchema.outlineBlocks.spaceId, spaceId));
					},
					async forgetClaims(taskBlockIds) {
						await pgDb
							.delete(pgSchema.outlineTaskClaims)
							.where(inArray(pgSchema.outlineTaskClaims.taskBlockId, [...taskBlockIds]));
					},
					async forgetHistory(spaceId) {
						const blocks = sql`(SELECT id FROM outline_blocks WHERE space_id = ${spaceId})`;
						await pgDb.execute(sql`DELETE FROM outline_block_edges WHERE block_id IN ${blocks}`);
						await pgDb.execute(
							sql`DELETE FROM outline_subtree_changes WHERE ancestor_id IN ${blocks}`,
						);
						await pgDb
							.update(pgSchema.outlineSpaces)
							.set({ edgesReady: false, historyFloorSeq: 0 })
							.where(eq(pgSchema.outlineSpaces.id, spaceId));
					},
					async setLastCommitAt(spaceId, value) {
						await pgDb
							.update(pgSchema.outlineSpaces)
							.set({ lastCommitAt: value })
							.where(eq(pgSchema.outlineSpaces.id, spaceId));
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
					for (const contractCase of [
						...OUTLINE_STORE_CONTRACT,
						...OUTLINE_TASK_CONTRACT,
						...OUTLINE_PENDING_CONTRACT,
						...OUTLINE_QUESTION_CONTRACT,
						...OUTLINE_HISTORY_CONTRACT,
						...OUTLINE_READ_CONTRACT,
						...OUTLINE_DIGEST_CONTRACT,
					]) {
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
			expect(outcome.passed).toHaveLength(
				OUTLINE_STORE_CONTRACT.length +
					OUTLINE_TASK_CONTRACT.length +
					OUTLINE_PENDING_CONTRACT.length +
					OUTLINE_QUESTION_CONTRACT.length +
					OUTLINE_HISTORY_CONTRACT.length +
					OUTLINE_READ_CONTRACT.length +
					OUTLINE_DIGEST_CONTRACT.length,
			);
		},
		RUN_TIMEOUT_MS,
	);
});
