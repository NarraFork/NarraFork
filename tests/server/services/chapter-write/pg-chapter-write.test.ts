/**
 * The chapter write path on a real PostgreSQL 17: create → fork → merge →
 * unmerge → split, end to end, plus the graph read-back equivalence against the
 * same sequence executed on SQLite.
 *
 * WHAT IS BEING PROVEN
 * --------------------
 *   - the write port's operations commit the same facts on both backends, driven
 *     with ONE deterministic id/timestamp set so the two databases are comparable
 *     row for row;
 *   - the edge upsert race is closed on PostgreSQL: N concurrent upserts of the
 *     same (source, target, type) — the table has no unique constraint — produce
 *     exactly one edge, serialized by the source chapter's row lock;
 *   - a lost `(project_id, branch)` race crosses as `WriteConflictError` (the
 *     port's vocabulary), never a driver error;
 *   - `getGraph` — through each backend's own `ProjectReadAdapter` — returns the
 *     SAME payload after the same write sequence (timestamps are excluded from
 *     the graph projection by its own contract, so the comparison is exact).
 *
 * Rules, same as the other PG suites: `PG_INTEGRATION=1` really runs a throwaway
 * container; migrations are applied exactly as committed; only the harness' own
 * container is touched.
 */
import { afterAll, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { WriteConflictError } from "../../../../server/db/backend/write-port";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import * as pgSchema from "../../../../server/db/postgres-schema";
import { generateId } from "../../../../server/lib/id";
import { createPostgresChapterWriteStore } from "../../../../server/services/chapter-write/postgres-write-store";
import type { ChapterWriteStore } from "../../../../server/services/chapter-write/write-store";
import { PostgresProjectReadAdapter } from "../../../../server/services/read/postgres-project-read-adapter";
import type { ProjectReadAdapter } from "../../../../server/services/read/project-read-adapter";
import { withPostgres } from "../../../db/pg-test-harness";
import { getTestDb } from "../../../setup";
import { migrationSql } from "../read/pg-parity-matrix";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 300_000;

// The SQLite write store and read adapter pull in `@server/db`; it is mocked over
// the isolated in-memory database exactly as the other PG suites do.
const { db: sqliteDb, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../../server/db")) };
mock.module("../../../../server/db", () => ({ db: sqliteDb, sqlite }));

const { sqliteChapterWriteStore } = await import(
	"../../../../server/services/chapter-write/sqlite-write-store"
);
const { SqliteProjectReadAdapter } = await import(
	"../../../../server/services/read/sqlite-project-read-adapter"
);
const sqliteSchema = await import("../../../../server/db/schema");

afterAll(() => {
	mock.module("../../../../server/db", () => realDbModule);
	mock.restore();
	sqlite.close();
});

const NOW = "2026-01-01T00:00:00.000Z";
const SHA = (n: number) => n.toString(16).padStart(40, "0");
const PROJECT_ID = "pg-chapter-e2e-project";
const ADMIN = { userId: "admin-user", isAdmin: true };

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
		credentials.password,
	)}@127.0.0.1:${port}/nf_harness`;
}

function chapterValues(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		projectId: PROJECT_ID,
		title: `Chapter ${id}`,
		description: null,
		status: "active",
		role: "branch",
		branch: `chapter/${id}`,
		worktreePath: null,
		baseBranch: "main",
		parentChapterId: null,
		forkPoint: null,
		startCommitSha: null,
		lastAccessedAt: null,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

/**
 * The deterministic create → fork → merge → unmerge → split sequence, driven
 * against either backend's store. Returns nothing; the graph is compared after.
 */
async function runChapterLifecycle(store: ChapterWriteStore): Promise<void> {
	await store.insertChapter(chapterValues("ch-root", { isRoot: 1, role: "trunk", branch: "main" }));
	// Forks A and B descend from root.
	await store.insertChapter(chapterValues("ch-a", { parentChapterId: "ch-root" }));
	await store.upsertForkEdge({
		id: "edge-fork-a",
		projectId: PROJECT_ID,
		sourceId: "ch-root",
		targetId: "ch-a",
		metadata: { commitSha: SHA(1), worktreeSource: "commit", inheritMode: "full" },
		now: NOW,
	});
	await store.insertChapter(chapterValues("ch-b", { parentChapterId: "ch-root" }));
	await store.upsertForkEdge({
		id: "edge-fork-b",
		projectId: PROJECT_ID,
		sourceId: "ch-root",
		targetId: "ch-b",
		metadata: { commitSha: SHA(2), worktreeSource: "commit", inheritMode: "full" },
		now: NOW,
	});
	// Re-upserting an edge updates it in place rather than duplicating the graph line.
	await store.upsertForkEdge({
		id: generateId(),
		projectId: PROJECT_ID,
		sourceId: "ch-root",
		targetId: "ch-b",
		metadata: { commitSha: SHA(3), worktreeSource: "commit", inheritMode: "full" },
		now: NOW,
	});
	// Merge A into root, then unmerge it.
	await store.recordChapterMerge({
		sourceChapterId: "ch-a",
		targetChapterId: "ch-root",
		strategy: "merge",
		mergeCommitSha: SHA(4),
		preMergeTargetSha: SHA(5),
		now: NOW,
	});
	await store.upsertMergeEdge({
		id: "edge-merge-a",
		projectId: PROJECT_ID,
		sourceId: "ch-a",
		targetId: "ch-root",
		metadata: { mergeCommitSha: SHA(4), strategy: "merge", status: "completed" },
		now: NOW,
	});
	await store.restoreMergedChapter({
		chapterId: "ch-a",
		worktreePath: "/wt/a",
		clearSnapshotMergeFields: false,
		now: NOW,
	});
	await store.deleteMergeEdgesBySource("ch-a");
	// The split: a prefix takes over ch-b's lineage; ch-b becomes the continuation.
	await store.insertChapter(
		chapterValues("ch-prefix", {
			parentChapterId: "ch-root",
			status: "dormant",
			headCommitSha: SHA(6),
			startCommitSha: SHA(7),
		}),
	);
	await store.updateSplitPrefixHead({
		prefixId: "ch-prefix",
		startCommitSha: SHA(7),
		headCommitSha: SHA(6),
		now: NOW,
	});
	const forkB = "edge-fork-b";
	expect(await store.retargetForkEdge({ edgeId: forkB, newTargetId: "ch-prefix" })).toBe("ch-b");
	await store.rewriteSplitContinuation({
		chapterId: "ch-b",
		prefixId: "ch-prefix",
		commitSha: SHA(8),
		fallbackCommitCount: null,
		now: NOW,
	});
}

/** The graph payload, compared field-for-field across backends. */
async function graphOf(adapter: ProjectReadAdapter): Promise<unknown> {
	return adapter.getGraph(PROJECT_ID, ADMIN);
}

describe("PostgreSQL chapter write path", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"runs create/fork/merge/unmerge/split end to end, with graph equivalence",
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
					max: 8,
					connectTimeout: 10,
				});
				try {
					const pgDb: BunSQLDatabase = client.db;
					const problems: string[] = [];
					const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
						try {
							await fn();
						} catch (error) {
							problems.push(
								`${label}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`.slice(
									0,
									900,
								),
							);
						}
					};
					const store = createPostgresChapterWriteStore(pgDb);
					const readAdapter = new PostgresProjectReadAdapter(pgDb);

					// Seed the project, run the lifecycle, and read the graph back.
					await pgDb.insert(pgSchema.projects).values({
						id: PROJECT_ID,
						name: "pg-chapter-e2e",
						gitPath: "/tmp/pg-chapter-e2e",
						defaultBranch: "main",
						createdAt: NOW,
						updatedAt: NOW,
					});
					await check("lifecycle", () => runChapterLifecycle(store));
					const pgGraph = await graphOf(readAdapter);

					// The split's continuation rewrite recomputed the commit count from
					// chapter_commits (zero rows here, falling back to 0) and reparented.
					const continuation = await pgDb
						.select()
						.from(pgSchema.chapters)
						.where(eq(pgSchema.chapters.id, "ch-b"));
					const prefix = await pgDb
						.select()
						.from(pgSchema.chapters)
						.where(eq(pgSchema.chapters.id, "ch-prefix"));

					// The edge upsert race, on a real server: N concurrent upserts of the
					// same (source, target, type) leave exactly ONE edge — the source
					// chapter's row lock is the serialization point.
					await check("concurrent upserts", async () => {
						await Promise.all(
							Array.from({ length: 6 }, (_, index) =>
								store.upsertForkEdge({
									id: `race-${index}`,
									projectId: PROJECT_ID,
									sourceId: "ch-root",
									targetId: "ch-a",
									metadata: {
										commitSha: SHA(10 + index),
										worktreeSource: "commit",
										inheritMode: "full",
									},
									now: NOW,
								}),
							),
						);
					});
					const racedEdges = await pgDb
						.select()
						.from(pgSchema.chapterEdges)
						.where(
							and(
								eq(pgSchema.chapterEdges.sourceId, "ch-root"),
								eq(pgSchema.chapterEdges.targetId, "ch-a"),
								eq(pgSchema.chapterEdges.type, "fork"),
							),
						);

					// A lost (project, branch) race crosses as port vocabulary.
					let conflict: unknown;
					try {
						await store.insertChapter(chapterValues("ch-dup", { branch: "main" }));
					} catch (error) {
						conflict = error;
					}

					// The same sequence on SQLite, then the graph comparison.
					await sqliteDb.insert(sqliteSchema.projects).values({
						id: PROJECT_ID,
						name: "pg-chapter-e2e",
						gitPath: "/tmp/pg-chapter-e2e",
						defaultBranch: "main",
						createdAt: NOW,
						updatedAt: NOW,
					});
					await check("sqlite lifecycle", () => runChapterLifecycle(sqliteChapterWriteStore));
					const sqliteGraph = await graphOf(new SqliteProjectReadAdapter());

					return {
						problems,
						pgGraph,
						sqliteGraph,
						continuation: continuation[0] ?? null,
						prefix: prefix[0] ?? null,
						racedEdgeCount: racedEdges.length,
						conflict,
					};
				} finally {
					await client.close();
				}
			});

			if ("status" in outcome && outcome.status !== "ready") {
				throw new Error(`PostgreSQL harness ${outcome.status}: ${outcome.reason}`);
			}
			const result = outcome as {
				migrationError?: string;
				problems: string[];
				pgGraph: unknown;
				sqliteGraph: unknown;
				continuation: {
					parentChapterId: string | null;
					startCommitSha: string | null;
					commitCount: number | null;
					forkPoint: unknown;
				} | null;
				prefix: { headCommitSha: string | null; startCommitSha: string | null } | null;
				racedEdgeCount: number;
				conflict: unknown;
			};
			if (result.migrationError) {
				throw new Error(`PostgreSQL migration failed: ${result.migrationError}`);
			}
			expect(result.problems).toEqual([]);

			// The split wrote the lineage exactly as the port states it.
			expect(result.continuation?.parentChapterId).toBe("ch-prefix");
			expect(result.continuation?.startCommitSha).toBe(SHA(8));
			expect(result.continuation?.commitCount).toBe(0);
			expect(result.continuation?.forkPoint).toEqual({ commitSha: SHA(8) });
			expect(result.prefix?.headCommitSha).toBe(SHA(6));

			// Six concurrent upserts, one edge.
			expect(result.racedEdgeCount).toBe(1);

			// The conflict crossed as vocabulary.
			expect(result.conflict).toBeInstanceOf(WriteConflictError);

			// THE GRAPH EQUIVALENCE: same write sequence, same graph, both backends.
			expect(result.pgGraph).toEqual(result.sqliteGraph);
		},
		RUN_TIMEOUT_MS,
	);
});
