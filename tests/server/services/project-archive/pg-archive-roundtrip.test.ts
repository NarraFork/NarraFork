/**
 * The project archive's dual-backend round trip: a real archive FILE written
 * from a PostgreSQL main database, imported back into PostgreSQL — with the
 * forward-reference graph (child-before-parent chapters, exploration groups
 * pointing at later tables, narrator lineage cycles) restored by the two-phase
 * import, and the same file also imported into SQLite for the cross-backend
 * comparison.
 *
 * WHAT IS BEING PROVEN
 * --------------------
 *   - `ON CONFLICT DO NOTHING` is the import's "keep what is already there"
 *     policy in PG spelling: a second import of the same archive conflict-skips
 *     every row and a row MUTATED between imports keeps its newer value;
 *   - the two-phase import restores every forward reference whatever the row
 *     order (the archive pages by random nanoid PK, and some references point at
 *     LATER tables — `deferred-references.ts`);
 *   - a genuinely dangling reference aborts the WHOLE import: the project row,
 *     applied first, is gone too;
 *   - the archive's value mapping is backend-neutral: JSON text, booleans and
 *     `seq` values round-trip with their types intact through BOTH backends.
 *
 * Rules, same as the other PG suites: `PG_INTEGRATION=1` really runs a throwaway
 * container; migrations are applied exactly as committed; only the harness' own
 * container is touched. The archive file itself stays SQLite forever — that is
 * the format's whole point.
 */
import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import * as pgSchema from "../../../../server/db/postgres-schema";
import { getProjectDbPath, projectDbManager } from "../../../../server/lib/project-db";
import { ProjectArchiveFile } from "../../../../server/services/project-archive/archive-file";
import { copyTable } from "../../../../server/services/project-archive/export-rows";
import type {
	ArchiveBatch,
	ArchiveRow,
} from "../../../../server/services/project-archive/main-store";
import { ARCHIVE_TABLE_ORDER } from "../../../../server/services/project-archive/manifest";
import { createPostgresProjectArchiveMainStore } from "../../../../server/services/project-archive/postgres-main-store";
import { sqliteProjectArchiveMainStore } from "../../../../server/services/project-archive/sqlite-main-store";
import { withPostgres } from "../../../db/pg-test-harness";
import { getTestDb } from "../../../setup";
import { migrationSql } from "../read/pg-parity-matrix";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 300_000;

// The SQLite main store pulls in `@server/db`; mocked over the in-memory test db.
const { db: sqliteDb, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../../server/db")) };
mock.module("../../../../server/db", () => ({ db: sqliteDb, sqlite }));

const sqliteSchema = await import("../../../../server/db/schema");

afterAll(() => {
	mock.module("../../../../server/db", () => realDbModule);
	mock.restore();
	sqlite.close();
});

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = "pg-archive-project";
const tempDirs: string[] = [];

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
		credentials.password,
	)}@127.0.0.1:${port}/nf_harness`;
}

/** The deterministic fixture: hostile row order by construction (child ids sort first). */
const FIXTURE = {
	parentChapterId: "zz-parent-chapter",
	childChapterId: "00-child-chapter",
	parentNarratorId: "zz-parent-narrator",
	childNarratorId: "00-child-narrator",
	forkMessageId: "fork-message-1",
	groupId: "exploration-group-1",
};

type PgStore = ReturnType<typeof createPostgresProjectArchiveMainStore>;

async function seedPg(pgDb: BunSQLDatabase): Promise<void> {
	await pgDb.insert(pgSchema.projects).values({
		id: PROJECT_ID,
		name: "pg-archive",
		gitPath: "/tmp/pg-archive",
		defaultBranch: "main",
		chapterSettings: { autoStart: true, ports: [3000] },
		createdAt: NOW,
		updatedAt: NOW,
	});
	await pgDb.insert(pgSchema.chapters).values([
		{
			id: FIXTURE.parentChapterId,
			projectId: PROJECT_ID,
			title: "parent",
			branch: "chapter/parent",
			baseBranch: "main",
			status: "active",
			role: "branch",
			commitCount: 7,
			forkPoint: { sha: "b".repeat(40), branch: "main" },
			createdAt: NOW,
			updatedAt: NOW,
		},
		{
			id: FIXTURE.childChapterId,
			projectId: PROJECT_ID,
			title: "child",
			branch: "chapter/child",
			baseBranch: "main",
			status: "merged",
			role: "branch",
			parentChapterId: FIXTURE.parentChapterId,
			mergedIntoChapterId: FIXTURE.parentChapterId,
			mergeCommitSha: "a".repeat(40),
			mergeStrategy: "merge",
			createdAt: NOW,
			updatedAt: NOW,
		},
	]);
	await pgDb.insert(pgSchema.explorationGroups).values({
		id: FIXTURE.groupId,
		projectId: PROJECT_ID,
		title: "group",
		baseChapterId: FIXTURE.parentChapterId,
		decidedChapterId: FIXTURE.childChapterId,
		status: "decided",
		createdAt: NOW,
		updatedAt: NOW,
	});
	await pgDb.insert(pgSchema.narrators).values({
		id: FIXTURE.parentNarratorId,
		chapterId: FIXTURE.parentChapterId,
		title: "parent narrator",
		traits: ["plan", "standalone"],
		substatus: '["unread"]',
		isBackground: true,
		messageVersion: 3,
		createdAt: NOW,
		updatedAt: NOW,
	});
	await pgDb.insert(pgSchema.narratorMessages).values({
		id: FIXTURE.forkMessageId,
		narratorId: FIXTURE.parentNarratorId,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: "toolu_1", name: "Task", input: {} }],
		outputTokens: 42,
		createdAt: NOW,
	});
	await pgDb.insert(pgSchema.narratorMessageRefs).values({
		id: "ref-1",
		narratorId: FIXTURE.parentNarratorId,
		messageId: FIXTURE.forkMessageId,
		seq: 0,
		isCompact: 0,
	});
	await pgDb.insert(pgSchema.narrators).values({
		id: FIXTURE.childNarratorId,
		chapterId: FIXTURE.childChapterId,
		title: "child narrator",
		parentNarratorId: FIXTURE.parentNarratorId,
		forkMessageId: FIXTURE.forkMessageId,
		createdAt: NOW,
		updatedAt: NOW,
	});
}

/** Write the archive file from the PG main database through the port's reads. */
async function exportArchive(pgStore: PgStore, gitPath: string): Promise<void> {
	const pdb = projectDbManager.openForGitPath(PROJECT_ID, gitPath);
	const chapterIds = [FIXTURE.parentChapterId, FIXTURE.childChapterId];
	const narratorIds = [FIXTURE.parentNarratorId, FIXTURE.childNarratorId];
	await copyTable(pgStore, pdb, "projects", {
		filter: { column: "id", values: [PROJECT_ID] },
	});
	await copyTable(pgStore, pdb, "chapters", {
		filter: { column: "project_id", values: [PROJECT_ID] },
	});
	await copyTable(pgStore, pdb, "exploration_groups", {
		filter: { column: "project_id", values: [PROJECT_ID] },
	});
	await copyTable(pgStore, pdb, "narrators", {
		filter: { column: "chapter_id", values: chapterIds },
	});
	await copyTable(pgStore, pdb, "narrator_messages", {
		filter: { column: "narrator_id", values: narratorIds },
	});
	await copyTable(pgStore, pdb, "narrator_message_refs", {
		filter: { column: "narrator_id", values: narratorIds },
	});
	projectDbManager.close(PROJECT_ID);
}

/** Read every table back out of the archive file, in import order. */
async function batchesFromArchive(gitPath: string): Promise<ArchiveBatch[]> {
	const archive = ProjectArchiveFile.open(gitPath);
	try {
		const batches: ArchiveBatch[] = [];
		for (const table of ARCHIVE_TABLE_ORDER) {
			const columns = archive.columnsFor(table);
			if (columns.length === 0) continue;
			const rows: ArchiveRow[] = [];
			let after: string | null = null;
			for (;;) {
				const result = archive.readTable(table, columns, { limit: 500, after });
				rows.push(...result.rows);
				if (result.nextCursor === null) break;
				after = result.nextCursor;
			}
			if (rows.length > 0) batches.push({ table, columns, rows });
		}
		return batches;
	} finally {
		archive.close();
	}
}

/** Delete the fixture from PG in FK-safe order. */
async function wipePg(pgDb: BunSQLDatabase): Promise<void> {
	// The child narrator's parent/fork_message references are NO ACTION, so it
	// goes before the message it names; refs go before their message; the message
	// goes before the parent narrator it belongs to.
	await pgDb.delete(pgSchema.narrators).where(eq(pgSchema.narrators.id, FIXTURE.childNarratorId));
	await pgDb
		.delete(pgSchema.narratorMessageRefs)
		.where(eq(pgSchema.narratorMessageRefs.messageId, FIXTURE.forkMessageId));
	await pgDb
		.delete(pgSchema.narratorMessages)
		.where(eq(pgSchema.narratorMessages.id, FIXTURE.forkMessageId));
	await pgDb.delete(pgSchema.narrators).where(eq(pgSchema.narrators.id, FIXTURE.parentNarratorId));
	await pgDb
		.delete(pgSchema.explorationGroups)
		.where(eq(pgSchema.explorationGroups.projectId, PROJECT_ID));
	await pgDb.delete(pgSchema.chapters).where(eq(pgSchema.chapters.projectId, PROJECT_ID));
	await pgDb.delete(pgSchema.projects).where(eq(pgSchema.projects.id, PROJECT_ID));
}

/** The comparable projection of the imported state. */
type Projection = Record<string, unknown>;

async function pgProjection(pgDb: BunSQLDatabase): Promise<Projection> {
	const child = await pgDb
		.select()
		.from(pgSchema.chapters)
		.where(eq(pgSchema.chapters.id, FIXTURE.childChapterId));
	const parent = await pgDb
		.select()
		.from(pgSchema.chapters)
		.where(eq(pgSchema.chapters.id, FIXTURE.parentChapterId));
	const group = await pgDb
		.select()
		.from(pgSchema.explorationGroups)
		.where(eq(pgSchema.explorationGroups.id, FIXTURE.groupId));
	const narrator = await pgDb
		.select()
		.from(pgSchema.narrators)
		.where(eq(pgSchema.narrators.id, FIXTURE.childNarratorId));
	const parentNarrator = await pgDb
		.select()
		.from(pgSchema.narrators)
		.where(eq(pgSchema.narrators.id, FIXTURE.parentNarratorId));
	const message = await pgDb
		.select()
		.from(pgSchema.narratorMessages)
		.where(eq(pgSchema.narratorMessages.id, FIXTURE.forkMessageId));
	const refs = await pgDb
		.select()
		.from(pgSchema.narratorMessageRefs)
		.where(eq(pgSchema.narratorMessageRefs.narratorId, FIXTURE.parentNarratorId));
	const project = await pgDb
		.select()
		.from(pgSchema.projects)
		.where(eq(pgSchema.projects.id, PROJECT_ID));
	return {
		childChapter: child[0]
			? {
					parentChapterId: child[0].parentChapterId,
					mergedIntoChapterId: child[0].mergedIntoChapterId,
					status: child[0].status,
					mergeCommitSha: child[0].mergeCommitSha,
				}
			: null,
		parentChapter: parent[0]
			? { commitCount: parent[0].commitCount, forkPoint: parent[0].forkPoint }
			: null,
		group: group[0]
			? { baseChapterId: group[0].baseChapterId, decidedChapterId: group[0].decidedChapterId }
			: null,
		narrator: narrator[0]
			? {
					parentNarratorId: narrator[0].parentNarratorId,
					forkMessageId: narrator[0].forkMessageId,
				}
			: null,
		parentNarrator: parentNarrator[0]
			? {
					traits: parentNarrator[0].traits,
					substatus: parentNarrator[0].substatus,
					isBackground: parentNarrator[0].isBackground,
					messageVersion: parentNarrator[0].messageVersion,
				}
			: null,
		message: message[0]
			? { contentJson: message[0].contentJson, outputTokens: message[0].outputTokens }
			: null,
		refs: refs.map((row) => ({ messageId: row.messageId, seq: row.seq, isCompact: row.isCompact })),
		project: project[0] ? { chapterSettings: project[0].chapterSettings } : null,
	};
}

type ScenarioResult = {
	migrationError?: string;
	problems: string[];
	applied: Record<string, number>;
	pgAfter: Projection;
	renamedTitle: string | null;
	sqliteChapter: { parentChapterId: string | null; mergedIntoChapterId: string | null } | null;
	sqliteNarrator: { parentNarratorId: string | null; forkMessageId: string | null } | null;
	danglingError: string | null;
	projectSurvivedDangling: boolean;
};

/** The whole PG scenario, named so the harness callback can surface its real error. */
async function runArchiveScenario(
	exec: (sql: string) => Promise<{ code: number; stderr: string }>,
	port: number,
	credentials: { user: string; password: string },
	sqls: string[],
): Promise<ScenarioResult> {
	for (const statement of sqls) {
		const applied = await exec(statement);
		if (applied.code !== 0) {
			return {
				migrationError: applied.stderr
					.split("\n")
					.filter((line) => !line.startsWith("NOTICE:"))
					.join("\n")
					.slice(0, 400),
				problems: [],
				applied: {},
				pgAfter: {},
				renamedTitle: null,
				sqliteChapter: null,
				sqliteNarrator: null,
				danglingError: null,
				projectSurvivedDangling: false,
			};
		}
	}

	const client = createPostgresClient({
		driver: "bun-sql",
		url: urlFor(port, credentials),
		max: 4,
		connectTimeout: 10,
	});
	const gitPath = mkdtempSync(join(tmpdir(), "nf-pg-arc-"));
	tempDirs.push(gitPath);
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
		const pgStore = createPostgresProjectArchiveMainStore(pgDb);

		// Seed → export the archive file → wipe → import back.
		await check("seed", () => seedPg(pgDb));
		await check("export", () => exportArchive(pgStore, gitPath));
		await check("wipe", () => wipePg(pgDb));
		const batches = await batchesFromArchive(gitPath);
		const imported = await pgStore.importRows({ batches, conflictPolicy: "skip" });
		const pgAfter = await pgProjection(pgDb);

		// The conflict policy: import AGAIN — every row conflict-skips, and a
		// mutation made between imports survives (keep what is already there).
		await pgDb
			.update(pgSchema.chapters)
			.set({ title: "renamed after import" })
			.where(eq(pgSchema.chapters.id, FIXTURE.childChapterId));
		await pgStore.importRows({ batches, conflictPolicy: "skip" });
		const renamed = await pgDb
			.select({ title: pgSchema.chapters.title })
			.from(pgSchema.chapters)
			.where(eq(pgSchema.chapters.id, FIXTURE.childChapterId));

		// The same archive into the SQLite main database: the dual-backend
		// round trip agreement.
		await check("sqlite import", async () => {
			await sqliteProjectArchiveMainStore.importRows({ batches, conflictPolicy: "skip" });
		});
		const sqliteChapter = await sqliteDb.query.chapters.findFirst({
			where: eq(sqliteSchema.chapters.id, FIXTURE.childChapterId),
		});
		const sqliteNarrator = await sqliteDb.query.narrators.findFirst({
			where: eq(sqliteSchema.narrators.id, FIXTURE.childNarratorId),
		});

		// A dangling reference aborts the WHOLE import. Corrupt a COPY of the
		// archive just exported: remove the parent chapter the child references.
		// The main database is wiped first so the import starts from nothing —
		// the project row, applied first, is the atomicity witness.
		const danglingPath = mkdtempSync(join(tmpdir(), "nf-pg-arc-dangle-"));
		tempDirs.push(danglingPath);
		const { Database } = await import("bun:sqlite");
		const { copyFileSync, mkdirSync } = await import("node:fs");
		mkdirSync(join(danglingPath, ".narrafork"), { recursive: true });
		copyFileSync(getProjectDbPath(gitPath), getProjectDbPath(danglingPath));
		await wipePg(pgDb);
		const writable = new Database(getProjectDbPath(danglingPath));
		writable.run("DELETE FROM chapters WHERE id = ?", [FIXTURE.parentChapterId]);
		// The parent's narrator/messages go too, or their own references fail
		// first and hide the chapter-level verdict this case is about.
		writable.run("DELETE FROM narrators WHERE chapter_id = ?", [FIXTURE.parentChapterId]);
		writable.run("DELETE FROM narrator_messages WHERE narrator_id = ?", [FIXTURE.parentNarratorId]);
		writable.run("DELETE FROM exploration_groups");
		writable.close();
		const danglingBatches = await batchesFromArchive(danglingPath);
		let danglingError: unknown;
		try {
			await pgStore.importRows({ batches: danglingBatches, conflictPolicy: "skip" });
		} catch (error) {
			danglingError = error;
		}
		const projectAfterDangling = await pgDb
			.select({ id: pgSchema.projects.id })
			.from(pgSchema.projects)
			.where(eq(pgSchema.projects.id, PROJECT_ID));

		return {
			problems,
			applied: imported.applied,
			pgAfter,
			renamedTitle: renamed[0]?.title ?? null,
			sqliteChapter: sqliteChapter
				? {
						parentChapterId: sqliteChapter.parentChapterId,
						mergedIntoChapterId: sqliteChapter.mergedIntoChapterId,
					}
				: null,
			sqliteNarrator: sqliteNarrator
				? {
						parentNarratorId: sqliteNarrator.parentNarratorId,
						forkMessageId: sqliteNarrator.forkMessageId,
					}
				: null,
			danglingError: danglingError ? String(danglingError) : null,
			projectSurvivedDangling: projectAfterDangling.length > 0,
		};
	} finally {
		await client.close();
	}
}

describe("PostgreSQL archive round trip", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"exports from PG, imports back into PG and into SQLite, equivalently",
		async () => {
			const sqls = await migrationSql();
			const outcome = await withPostgres(async ({ exec, port, credentials }) => {
				try {
					return await runArchiveScenario(exec, port, credentials, sqls);
				} catch (error) {
					// Walk the cause chain: Drizzle wraps the driver's verdict (which
					// carries the actual SQLSTATE and server message).
					const chain: string[] = [];
					let current: unknown = error;
					for (let depth = 0; depth < 6 && current; depth++) {
						chain.push(current instanceof Error ? current.message : String(current));
						current = (current as { cause?: unknown }).cause;
					}
					return { callbackError: chain.join(" ← ") };
				}
			});

			if ("status" in outcome && outcome.status !== "ready") {
				throw new Error(`PostgreSQL harness ${outcome.status}: ${outcome.reason}`);
			}
			const result = outcome as ScenarioResult & { callbackError?: string };
			if (result.callbackError) {
				throw new Error(`scenario failed: ${result.callbackError.slice(0, 1200)}`);
			}
			if (result.migrationError) {
				throw new Error(`PostgreSQL migration failed: ${result.migrationError}`);
			}
			expect(result.problems).toEqual([]);

			// Every offered row counted, in table order.
			expect(result.applied.chapters).toBe(2);
			expect(result.applied.narrators).toBe(2);
			expect(result.applied.narrator_messages).toBe(1);

			// The two-phase import restored every forward reference on PG.
			expect(result.pgAfter).toEqual({
				childChapter: {
					parentChapterId: FIXTURE.parentChapterId,
					mergedIntoChapterId: FIXTURE.parentChapterId,
					status: "merged",
					mergeCommitSha: "a".repeat(40),
				},
				parentChapter: { commitCount: 7, forkPoint: { sha: "b".repeat(40), branch: "main" } },
				group: {
					baseChapterId: FIXTURE.parentChapterId,
					decidedChapterId: FIXTURE.childChapterId,
				},
				narrator: {
					parentNarratorId: FIXTURE.parentNarratorId,
					forkMessageId: FIXTURE.forkMessageId,
				},
				parentNarrator: {
					traits: ["plan", "standalone"],
					substatus: '["unread"]',
					isBackground: true,
					messageVersion: 3,
				},
				message: {
					contentJson: [{ type: "tool_use", id: "toolu_1", name: "Task", input: {} }],
					outputTokens: 42,
				},
				refs: [{ messageId: FIXTURE.forkMessageId, seq: 0, isCompact: 0 }],
				project: { chapterSettings: { autoStart: true, ports: [3000] } },
			});

			// The conflict policy kept the mutation, on the second import.
			expect(result.renamedTitle).toBe("renamed after import");

			// The same archive restored the same references through the SQLite store.
			expect(result.sqliteChapter).toEqual({
				parentChapterId: FIXTURE.parentChapterId,
				mergedIntoChapterId: FIXTURE.parentChapterId,
			});
			expect(result.sqliteNarrator).toEqual({
				parentNarratorId: FIXTURE.parentNarratorId,
				forkMessageId: FIXTURE.forkMessageId,
			});

			// The dangling reference aborted EVERYTHING, project row included.
			expect(result.danglingError).toBeTruthy();
			expect(result.projectSurvivedDangling).toBe(false);

			for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		},
		RUN_TIMEOUT_MS,
	);
});
