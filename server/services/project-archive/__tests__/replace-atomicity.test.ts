/**
 * A replacement is all-or-nothing, verified against a real archive file.
 *
 * WHAT THIS FILE EXISTS TO CATCH
 * -----------------------------
 * A delete-then-insert whose DELETE commits separately from its refill. That shape passes every
 * other test in this directory: the round trip and the paging tests only ever export SUCCESSFULLY,
 * so a scope that empties the table, commits, and then writes the rows back page by page produces
 * the identical final file. The damage is only observable when the export FAILS in between —
 * which is when a user's backup is left empty or half-refilled and the next thing they do is
 * restore from it.
 *
 * So every test here interrupts an export mid-flight and then asks the file what it holds:
 *
 *   - a page that fails to read (the second one, so a first page has already been staged)
 *   - a row the archive rejects at load time (a NOT NULL violation)
 *   - cancellation through an `AbortSignal`, and a deadline that has passed
 *   - the staging ceiling
 *   - a failure in the SECOND scope of a multi-table replacement, which must roll back the
 *     FIRST scope's delete with it
 *
 * The answer must always be the complete previous contents — never empty, never a prefix.
 *
 * WHY A FAKE MAIN STORE
 * ---------------------
 * The failures above have to happen at an exact page boundary. `MainStoreStub` serves rows from
 * arrays through the real `ProjectArchiveMainStore` contract (cursor, limit, filter) and can be
 * told to throw on the n-th read of a table. The ARCHIVE side is not faked: it is a real
 * `project.db` created by the real `server/lib/project-db.ts` under `mkdtemp`, and the assertions
 * read it back through a SEPARATE read-only handle — the same way another machine would.
 *
 * The last describe block runs the actual `fullSync` against the real main database, so the wiring
 * is covered too and not just the primitive.
 *
 * ISOLATION
 * ---------
 * `tests/preload.ts` isolates the main database. Every archive lives under `mkdtemp` and is
 * removed afterwards. No user database is opened.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@server/db";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
} from "@server/db/schema";
import { generateId } from "@server/lib/id";
import { getProjectDbPath, projectDbManager } from "@server/lib/project-db";
import { fullSync } from "@server/services/project-db-sync";
import { eq } from "drizzle-orm";
import { ArchiveStagingLimitError, ArchiveStagingTable } from "../archive-writer";
import {
	ARCHIVE_EXPORT_PAGE_SIZE,
	ArchiveExportCancelledError,
	type ReplaceScope,
	replaceTables,
} from "../export-rows";
import type {
	ArchiveRow,
	ImportRowsResult,
	ProjectArchiveMainStore,
	ReadRowsPage,
	ReadRowsQuery,
} from "../main-store";
import type { ArchiveTable } from "../manifest";
import { projectArchiveMainStore } from "../store";

const tempDirs: string[] = [];
const openedArchives: string[] = [];
const createdProjects: string[] = [];
const createdNarrators: string[] = [];

afterEach(async () => {
	for (const id of openedArchives.splice(0)) projectDbManager.close(id);
	for (const narratorId of createdNarrators.splice(0)) {
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, narratorId));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, narratorId));
		await db.delete(narrators).where(eq(narrators.id, narratorId));
	}
	for (const projectId of createdProjects.splice(0)) {
		projectDbManager.close(projectId);
		await db.delete(chapters).where(eq(chapters.projectId, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// A real archive file, and a fake main database
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a real `project.db` through the real initializer and return its write handle.
 *
 * `openForGitPath` is used rather than `getDb` on purpose: it takes the path directly, so the
 * archive needs no `projects` row in the main database and these tests stay independent of it.
 */
function createArchive(prefix: string): { conn: Database; gitPath: string } {
	const gitPath = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(gitPath);
	const key = `test-archive-${generateId()}`;
	openedArchives.push(key);
	return { conn: projectDbManager.openForGitPath(key, gitPath), gitPath };
}

/** Read a table through a SEPARATE read-only handle — what another machine would see. */
function readBack(gitPath: string, sql: string): Record<string, unknown>[] {
	const conn = new Database(getProjectDbPath(gitPath), { readonly: true });
	try {
		return conn.prepare(sql).all() as Record<string, unknown>[];
	} finally {
		conn.close();
	}
}

/** Staging tables left behind on a connection, which must always be none. */
function leftoverStaging(conn: Database): string[] {
	const temp = conn
		.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'nf_archive_stage%'")
		.all() as { name: string }[];
	return temp.map((row) => row.name);
}

/** Tables in the FILE itself, so a staging table leaking into the portable artifact is caught. */
function fileTables(gitPath: string): string[] {
	return readBack(gitPath, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(
		(row) => String(row.name),
	);
}

interface StubFailure {
	readonly table: ArchiveTable;
	/** 1-based read index for that table. 2 = "fail the second page". */
	readonly onRead: number;
	readonly error?: Error;
}

/**
 * An in-memory `ProjectArchiveMainStore` that pages exactly like the real one.
 *
 * `reads` counts per table so a test can name the page it wants to break, and `rowsServed`
 * proves a failing test actually served earlier pages rather than failing before it began.
 */
class MainStoreStub implements ProjectArchiveMainStore {
	readonly reads = new Map<string, number>();
	rowsServed = 0;

	constructor(
		private readonly tables: Partial<Record<ArchiveTable, readonly ArchiveRow[]>>,
		private readonly failure?: StubFailure,
	) {}

	async supportedColumns(table: string): Promise<readonly string[]> {
		const rows = this.tables[table as ArchiveTable] ?? [];
		return rows.length > 0 ? Object.keys(rows[0] as object) : [];
	}

	async readRows(query: ReadRowsQuery): Promise<ReadRowsPage> {
		const count = (this.reads.get(query.table) ?? 0) + 1;
		this.reads.set(query.table, count);
		if (this.failure && this.failure.table === query.table && this.failure.onRead === count) {
			throw this.failure.error ?? new Error(`main-store read #${count} of ${query.table} failed`);
		}

		let rows = [...(this.tables[query.table as ArchiveTable] ?? [])];
		if (query.filter) {
			if (query.filter.values.length === 0) return { rows: [], nextCursor: null };
			const wanted = new Set(query.filter.values);
			rows = rows.filter((row) => wanted.has(String(row[query.filter?.column ?? ""])));
		}
		rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
		if (query.after != null) {
			const after = query.after;
			rows = rows.filter((row) => String(row.id) > after);
		}
		const limit = Math.max(1, Math.min(query.limit, ARCHIVE_EXPORT_PAGE_SIZE));
		const page = rows.slice(0, limit);
		this.rowsServed += page.length;
		const hasMore = rows.length > limit;
		return { rows: page, nextCursor: hasMore ? String(page.at(-1)?.id) : null };
	}

	async importRows(): Promise<ImportRowsResult> {
		throw new Error("the export never imports");
	}
}

/** Deterministic, ascending ids so the stub's cursor order matches the assertions. */
function chapterRow(projectId: string, index: number, overrides: ArchiveRow = {}): ArchiveRow {
	const n = String(index).padStart(6, "0");
	return {
		id: `chapter-${n}`,
		project_id: projectId,
		title: `chapter ${index}`,
		status: "active",
		role: "branch",
		branch: `chapter/${n}`,
		base_branch: "main",
		commit_count: index,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

/**
 * A ref row. The id carries the narrator, because `narrator_message_refs.id` is a PRIMARY KEY and
 * two narrators seeded at the same indices would otherwise collide on it.
 */
function refRow(narratorId: string, index: number, overrides: ArchiveRow = {}): ArchiveRow {
	const n = String(index).padStart(6, "0");
	return {
		id: `ref-${narratorId}-${n}`,
		narrator_id: narratorId,
		message_id: `msg-${n}`,
		seq: index,
		is_compact: 0,
		...overrides,
	};
}

/** Write the "previous contents" straight into the archive, bypassing the export. */
function seedChapters(conn: Database, rows: readonly ArchiveRow[]): void {
	const statement = conn.prepare(
		`INSERT INTO chapters (id, project_id, title, status, role, branch, base_branch,
			commit_count, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const tx = conn.transaction(() => {
		for (const row of rows) {
			statement.run(
				String(row.id),
				String(row.project_id),
				String(row.title),
				String(row.status),
				String(row.role),
				String(row.branch),
				String(row.base_branch),
				Number(row.commit_count),
				String(row.created_at),
				String(row.updated_at),
			);
		}
	});
	tx();
}

const PROJECT = "project-under-test";

/** More rows than one page holds, so a "fail the second page" test is meaningful. */
const MULTI_PAGE = ARCHIVE_EXPORT_PAGE_SIZE * 2 + 37;

/** Large enough that the row-count ceiling is what the staging-limit test hits first. */
const ARCHIVE_STAGING_TEST_BYTES = 1024 * 1024;

/**
 * The chapters scope, filtered the way `fullSync` filters it: by `project_id`.
 *
 * The column matters for what this file tests. An `id IN (…)` filter is chunked at
 * `ARCHIVE_EXPORT_FILTER_CHUNK` (200), which is BELOW the page size, so such a scope never
 * advances a cursor and "the second read" would be a second filter chunk rather than a second
 * page. Filtering by one `project_id` puts every row in one query, so 537 rows really are read as
 * a 500-row page followed by a 37-row page — the boundary a replacement has to survive.
 */
function chapterScope(): ReplaceScope {
	return {
		table: "chapters",
		filter: { column: "project_id", values: [PROJECT] },
		clear: [{ sql: "DELETE FROM chapters WHERE project_id = ?", params: [PROJECT] }],
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// The happy path, across pages
// ─────────────────────────────────────────────────────────────────────────────

describe("a successful multi-page replacement swaps the whole table", () => {
	test("every new row lands and every stale row is gone", async () => {
		const { conn, gitPath } = createArchive("nf-arc-replace-ok-");
		// Two rows that the main database no longer has. A replacement must remove them; an
		// append would leave them behind, which is the difference this scope exists for.
		seedChapters(conn, [
			chapterRow(PROJECT, 900_001, { title: "deleted upstream" }),
			chapterRow(PROJECT, 900_002, { title: "also deleted upstream" }),
		]);

		const fresh = Array.from({ length: MULTI_PAGE }, (_, i) => chapterRow(PROJECT, i));
		const store = new MainStoreStub({ chapters: fresh });
		const result = await replaceTables(store, conn, [chapterScope()]);

		expect(result.rows).toEqual([MULTI_PAGE]);
		// More than one page was actually served, or this proves nothing about paging.
		expect(store.reads.get("chapters")).toBeGreaterThan(1);

		const rows = readBack(gitPath, "SELECT id, title, commit_count FROM chapters ORDER BY id");
		expect(rows).toHaveLength(MULTI_PAGE);
		expect(rows.map((row) => String(row.id))).toEqual(fresh.map((row) => String(row.id)));
		// Values survive the staging round trip with their types — a staging table with declared
		// affinities would coerce these.
		expect(rows[0]).toEqual({ id: "chapter-000000", title: "chapter 0", commit_count: 0 });
		expect(rows.some((row) => String(row.title).includes("deleted upstream"))).toBe(false);

		expect(leftoverStaging(conn)).toEqual([]);
		expect(fileTables(gitPath).some((name) => name.startsWith("nf_archive_stage"))).toBe(false);
	});

	test("a staged duplicate resolves last-write-wins, as a direct write would", async () => {
		const { conn, gitPath } = createArchive("nf-arc-replace-dup-");
		// The archive's own `INSERT OR REPLACE` semantics: the LAST row written for a key wins.
		// The load has to replay staging order to match, which is what `ORDER BY rowid` is for.
		const stage = new ArchiveStagingTable(conn, "chapters", [
			"id",
			"project_id",
			"title",
			"branch",
			"base_branch",
			"created_at",
			"updated_at",
		]);
		try {
			stage.stage([
				chapterRow(PROJECT, 1, { title: "first write" }),
				chapterRow(PROJECT, 1, { title: "second write" }),
				chapterRow(PROJECT, 1, { title: "last write" }),
			]);
			const tx = conn.transaction(() => stage.loadInto());
			tx();
		} finally {
			stage.drop();
		}

		const rows = readBack(gitPath, "SELECT id, title FROM chapters");
		expect(rows).toEqual([{ id: "chapter-000001", title: "last write" }]);
		expect(leftoverStaging(conn)).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Every way a replacement can fail
// ─────────────────────────────────────────────────────────────────────────────

describe("a failed replacement leaves the previous contents whole", () => {
	/** The seeded "previous contents" every failure test below must find unchanged. */
	function seedPrevious(conn: Database): ArchiveRow[] {
		const previous = Array.from({ length: 7 }, (_, i) =>
			chapterRow(PROJECT, 800_000 + i, { title: `previous ${i}` }),
		);
		seedChapters(conn, previous);
		return previous;
	}

	function expectUnchanged(gitPath: string, previous: readonly ArchiveRow[]): void {
		const rows = readBack(gitPath, "SELECT id, title FROM chapters ORDER BY id");
		// Not empty (the DELETE never committed) and not a mixture (nothing was loaded).
		expect(rows).toEqual(previous.map((row) => ({ id: String(row.id), title: String(row.title) })));
	}

	test("a second-page read failure aborts before anything is deleted", async () => {
		const { conn, gitPath } = createArchive("nf-arc-replace-read-");
		const previous = seedPrevious(conn);

		const fresh = Array.from({ length: MULTI_PAGE }, (_, i) => chapterRow(PROJECT, i));
		const store = new MainStoreStub({ chapters: fresh }, { table: "chapters", onRead: 2 });

		await expect(replaceTables(store, conn, [chapterScope()])).rejects.toThrow(
			"main-store read #2 of chapters failed",
		);

		// The first page WAS served and staged, so this is a failure mid-replacement rather than
		// one before it started.
		expect(store.rowsServed).toBe(ARCHIVE_EXPORT_PAGE_SIZE);
		expectUnchanged(gitPath, previous);
		expect(leftoverStaging(conn)).toEqual([]);
	});

	test("a row the archive rejects rolls the delete back with it", async () => {
		const { conn, gitPath } = createArchive("nf-arc-replace-load-");
		const previous = seedPrevious(conn);

		// `chapters.title` is NOT NULL in the archive's DDL, so this row fails during the load —
		// INSIDE the transaction, after the DELETE has run. Rolling that DELETE back is the only
		// thing standing between this failure and an emptied table.
		const fresh = [
			chapterRow(PROJECT, 1),
			chapterRow(PROJECT, 2, { title: null }),
			chapterRow(PROJECT, 3),
		];
		const store = new MainStoreStub({ chapters: fresh });

		await expect(replaceTables(store, conn, [chapterScope()])).rejects.toThrow(
			/NOT NULL constraint failed/,
		);
		expectUnchanged(gitPath, previous);
		expect(leftoverStaging(conn)).toEqual([]);
	});

	test("an aborted export writes nothing", async () => {
		const { conn, gitPath } = createArchive("nf-arc-replace-abort-");
		const previous = seedPrevious(conn);

		const fresh = Array.from({ length: MULTI_PAGE }, (_, i) => chapterRow(PROJECT, i));
		const controller = new AbortController();
		// Aborted between pages: the first page is staged, then the signal is seen.
		const store = new MainStoreStub({ chapters: fresh });
		const originalRead = store.readRows.bind(store);
		store.readRows = async (query) => {
			const page = await originalRead(query);
			controller.abort();
			return page;
		};

		await expect(
			replaceTables(store, conn, [chapterScope()], { signal: controller.signal }),
		).rejects.toBeInstanceOf(ArchiveExportCancelledError);
		expect(store.rowsServed).toBe(ARCHIVE_EXPORT_PAGE_SIZE);
		expectUnchanged(gitPath, previous);
		expect(leftoverStaging(conn)).toEqual([]);
	});

	test("a deadline that has passed writes nothing", async () => {
		const { conn, gitPath } = createArchive("nf-arc-replace-timeout-");
		const previous = seedPrevious(conn);

		const fresh = [chapterRow(PROJECT, 1)];
		const store = new MainStoreStub({ chapters: fresh });
		const failure = replaceTables(store, conn, [chapterScope()], {
			deadline: Date.now() - 1,
		});

		await expect(failure).rejects.toBeInstanceOf(ArchiveExportCancelledError);
		await expect(failure).rejects.toThrow(/exceeded its time budget/);
		expectUnchanged(gitPath, previous);
		expect(leftoverStaging(conn)).toEqual([]);
	});

	test("exceeding the staging ceiling refuses rather than half-replacing", async () => {
		const { conn, gitPath } = createArchive("nf-arc-replace-limit-");
		const previous = seedPrevious(conn);

		// A tiny ceiling stands in for a real one: the behavior under test is what happens when
		// a replacement is too large to stage, not where the production number sits.
		const stage = new ArchiveStagingTable(
			conn,
			"chapters",
			["id", "project_id", "title", "branch", "base_branch", "created_at", "updated_at"],
			{ maxRows: 2, maxBytes: ARCHIVE_STAGING_TEST_BYTES },
		);
		try {
			expect(() =>
				stage.stage([chapterRow(PROJECT, 1), chapterRow(PROJECT, 2), chapterRow(PROJECT, 3)]),
			).toThrow(ArchiveStagingLimitError);
		} finally {
			stage.drop();
		}

		// The staging transaction rolled back and nothing was loaded, so the table is untouched.
		expectUnchanged(gitPath, previous);
		expect(leftoverStaging(conn)).toEqual([]);

		const byBytes = new ArchiveStagingTable(
			conn,
			"chapters",
			["id", "project_id", "title", "branch", "base_branch", "created_at", "updated_at"],
			{ maxRows: 1_000, maxBytes: 8 },
		);
		try {
			expect(() => byBytes.stage([chapterRow(PROJECT, 1)])).toThrow(ArchiveStagingLimitError);
		} finally {
			byBytes.drop();
		}
		expectUnchanged(gitPath, previous);
		expect(leftoverStaging(conn)).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Several tables, one commit
// ─────────────────────────────────────────────────────────────────────────────

describe("a multi-table replacement commits or rolls back as one", () => {
	function seedRefs(conn: Database, narratorId: string, count: number): ArchiveRow[] {
		const rows = Array.from({ length: count }, (_, i) => refRow(narratorId, 700_000 + i));
		const statement = conn.prepare(
			"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq, is_compact) VALUES (?, ?, ?, ?, ?)",
		);
		const tx = conn.transaction(() => {
			for (const row of rows) {
				statement.run(
					String(row.id),
					String(row.narrator_id),
					String(row.message_id),
					Number(row.seq),
					Number(row.is_compact),
				);
			}
		});
		tx();
		return rows;
	}

	test("a failure in the second scope rolls back the first scope's delete", async () => {
		const { conn, gitPath } = createArchive("nf-arc-replace-multi-");
		const previousChapters = [chapterRow(PROJECT, 600_001, { title: "still here" })];
		seedChapters(conn, previousChapters);
		const previousRefs = seedRefs(conn, "narrator-1", 3);

		const freshChapters = [chapterRow(PROJECT, 1)];
		// `seq` is NOT NULL in the archive, so this fails during the load of the SECOND scope —
		// after the first scope's DELETE has already run inside the same transaction.
		const freshRefs = [refRow("narrator-1", 1, { seq: null })];
		const store = new MainStoreStub({
			chapters: freshChapters,
			narrator_message_refs: freshRefs,
		});

		await expect(
			replaceTables(store, conn, [
				chapterScope(),
				{
					table: "narrator_message_refs",
					filter: { column: "id", values: freshRefs.map((row) => String(row.id)) },
					clear: [
						{
							sql: "DELETE FROM narrator_message_refs WHERE narrator_id = ?",
							params: ["narrator-1"],
						},
					],
				},
			]),
		).rejects.toThrow(/NOT NULL constraint failed/);

		// Both tables are as they were. A per-table transaction would have committed the chapters
		// swap and left the refs deleted.
		expect(readBack(gitPath, "SELECT id, title FROM chapters ORDER BY id")).toEqual([
			{ id: "chapter-600001", title: "still here" },
		]);
		expect(readBack(gitPath, "SELECT id FROM narrator_message_refs ORDER BY id")).toEqual(
			previousRefs.map((row) => ({ id: String(row.id) })),
		);
		expect(leftoverStaging(conn)).toEqual([]);
	});

	test("all clears precede all loads, so one scope adds while another replaces", async () => {
		const { conn, gitPath } = createArchive("nf-arc-replace-order-");
		const previousRefs = seedRefs(conn, "narrator-1", 4);
		// A ref belonging to a DIFFERENT narrator: the clear is scoped, so it must survive.
		seedRefs(conn, "narrator-2", 1);

		const freshRefs = [refRow("narrator-1", 1), refRow("narrator-1", 2)];
		const store = new MainStoreStub({ narrator_message_refs: freshRefs });
		await replaceTables(store, conn, [
			{
				table: "narrator_message_refs",
				filter: { column: "id", values: freshRefs.map((row) => String(row.id)) },
				clear: [
					{
						sql: "DELETE FROM narrator_message_refs WHERE narrator_id = ?",
						params: ["narrator-1"],
					},
				],
			},
		]);

		const rows = readBack(gitPath, "SELECT id, narrator_id FROM narrator_message_refs ORDER BY id");
		expect(rows.filter((row) => row.narrator_id === "narrator-1")).toEqual(
			freshRefs.map((row) => ({ id: String(row.id), narrator_id: "narrator-1" })),
		);
		// The other narrator's ref is untouched, and none of narrator-1's old refs remain.
		expect(rows.filter((row) => row.narrator_id === "narrator-2")).toHaveLength(1);
		expect(rows.map((row) => String(row.id))).not.toContain(String(previousRefs[0]?.id));
	});

	test("a table absent from an older archive is skipped, not failed", async () => {
		const { conn, gitPath } = createArchive("nf-arc-replace-missing-");
		const previousChapters = [chapterRow(PROJECT, 500_001, { title: "kept" })];
		seedChapters(conn, previousChapters);
		// An archive predating a table has neither the table nor its rows. The scope's DELETE
		// would fail against it, so the scope must be a no-op instead of failing the whole
		// replacement (and taking the chapters swap with it).
		conn.run("DROP TABLE narrator_patches");

		const freshChapters = [chapterRow(PROJECT, 1)];
		const store = new MainStoreStub({ chapters: freshChapters });
		const result = await replaceTables(store, conn, [
			chapterScope(),
			{
				table: "narrator_patches",
				filter: { column: "id", values: ["patch-1"] },
				clear: [{ sql: "DELETE FROM narrator_patches", params: [] }],
			},
		]);

		expect(result.rows).toEqual([1, 0]);
		expect(readBack(gitPath, "SELECT id FROM chapters")).toEqual([{ id: "chapter-000001" }]);
		expect(fileTables(gitPath)).not.toContain("narrator_patches");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The same guarantee through the real `fullSync`
// ─────────────────────────────────────────────────────────────────────────────

describe("fullSync keeps the archive whole when it fails", () => {
	/** More refs than one page holds, so the injected failure lands mid-export. */
	const MESSAGE_COUNT = ARCHIVE_EXPORT_PAGE_SIZE + 61;

	async function createProjectFixture(): Promise<{
		gitPath: string;
		projectId: string;
		narratorId: string;
	}> {
		const gitPath = mkdtempSync(join(tmpdir(), "nf-arc-fullsync-atomic-"));
		tempDirs.push(gitPath);
		const now = new Date().toISOString();
		const projectId = generateId();
		const chapterId = generateId();
		const narratorId = generateId();
		createdProjects.push(projectId);
		createdNarrators.push(narratorId);

		await db
			.insert(projects)
			.values({ id: projectId, name: "Atomic", gitPath, createdAt: now, updatedAt: now });
		await db.insert(chapters).values({
			id: chapterId,
			projectId,
			title: "conversation",
			branch: "chapter/atomic",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(narrators).values({
			id: narratorId,
			chapterId,
			title: "Atomic narrator",
			createdAt: now,
			updatedAt: now,
		});

		const messageIds = Array.from({ length: MESSAGE_COUNT }, () => generateId());
		const CHUNK = 200;
		for (let i = 0; i < messageIds.length; i += CHUNK) {
			const slice = messageIds.slice(i, i + CHUNK);
			await db.insert(narratorMessages).values(
				slice.map((id, offset) => ({
					id,
					narratorId,
					role: "assistant" as const,
					contentJson: [{ type: "text", text: `message ${i + offset}` }],
					createdAt: now,
				})),
			);
			await db.insert(narratorMessageRefs).values(
				slice.map((id, offset) => ({
					id: generateId(),
					narratorId,
					messageId: id,
					seq: i + offset,
					isCompact: 0,
				})),
			);
		}
		return { gitPath, projectId, narratorId };
	}

	test("a mid-export read failure leaves the previous conversation complete", async () => {
		const fixture = await createProjectFixture();
		// A first, successful export: this is the backup the user already has.
		await fullSync(fixture.projectId);
		const before = readBack(
			fixture.gitPath,
			"SELECT COUNT(*) AS messages, (SELECT COUNT(*) FROM narrator_message_refs) AS refs FROM narrator_messages",
		);
		expect(before[0]).toEqual({ messages: MESSAGE_COUNT, refs: MESSAGE_COUNT });

		// Now break the export partway through the refs REPLACEMENT — the scope whose clear
		// deletes the narrator's refs and whose refill puts them back.
		//
		// The failure has to be injected into a read of that scope specifically, not any read of
		// the table: `fullSyncNarratorMessages` first reads every ref by `narrator_id` (to learn
		// the message ids) and only then replaces them, filtering by `id`. Breaking the earlier
		// read would fail before any clear could run, so the test would pass against a
		// non-atomic implementation too — which is exactly what it must not do.
		let scopeReads = 0;
		const spy = spyOn(projectArchiveMainStore, "readRows");
		const real = spy.getMockImplementation();
		spy.mockImplementation(async (query: ReadRowsQuery) => {
			if (query.table === "narrator_message_refs" && query.filter?.column === "id") {
				scopeReads += 1;
				// The second read of the scope: one filter chunk has already been staged, so a
				// per-page-committing implementation has already emptied and partly refilled.
				if (scopeReads === 2) throw new Error("injected main-store failure");
			}
			return (await real?.(query)) as ReadRowsPage;
		});

		try {
			await expect(fullSync(fixture.projectId)).rejects.toThrow("injected main-store failure");
		} finally {
			spy.mockRestore();
		}

		// The archive still holds the entire previous conversation: not empty, not a prefix.
		const after = readBack(
			fixture.gitPath,
			"SELECT COUNT(*) AS messages, (SELECT COUNT(*) FROM narrator_message_refs) AS refs FROM narrator_messages",
		);
		expect(after[0]).toEqual({ messages: MESSAGE_COUNT, refs: MESSAGE_COUNT });
		const seqs = readBack(
			fixture.gitPath,
			"SELECT MIN(seq) AS lo, MAX(seq) AS hi, COUNT(DISTINCT seq) AS n FROM narrator_message_refs",
		);
		expect(seqs[0]).toEqual({ lo: 0, hi: MESSAGE_COUNT - 1, n: MESSAGE_COUNT });

		// And no staging table leaked into the user's file.
		expect(fileTables(fixture.gitPath).some((t) => t.startsWith("nf_archive_stage"))).toBe(false);
	});

	test("an already-cancelled sync changes nothing", async () => {
		const fixture = await createProjectFixture();
		await fullSync(fixture.projectId);

		const controller = new AbortController();
		controller.abort();
		await expect(fullSync(fixture.projectId, { signal: controller.signal })).rejects.toBeInstanceOf(
			ArchiveExportCancelledError,
		);

		const rows = readBack(
			fixture.gitPath,
			"SELECT COUNT(*) AS chapters, (SELECT COUNT(*) FROM narrator_message_refs) AS refs FROM chapters",
		);
		expect(rows[0]).toEqual({ chapters: 1, refs: MESSAGE_COUNT });
	});

	test("a successful re-export replaces rows the main database no longer has", async () => {
		const fixture = await createProjectFixture();
		await fullSync(fixture.projectId);

		// Delete half the conversation upstream, then re-export. A replacement removes the refs
		// that are gone; an append would keep reporting them.
		const refs = await db
			.select({ id: narratorMessageRefs.id, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, fixture.narratorId));
		const doomed = refs.filter((ref) => ref.seq >= MESSAGE_COUNT / 2).map((ref) => ref.id);
		for (let i = 0; i < doomed.length; i += 200) {
			const slice = new Set(doomed.slice(i, i + 200));
			for (const id of slice) {
				await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.id, id));
			}
		}

		await fullSync(fixture.projectId);
		const remaining = refs.length - doomed.length;
		expect(readBack(fixture.gitPath, "SELECT COUNT(*) AS c FROM narrator_message_refs")[0]).toEqual(
			{ c: remaining },
		);
		// The orphan sweep removed the messages those refs pointed at.
		expect(readBack(fixture.gitPath, "SELECT COUNT(*) AS c FROM narrator_messages")[0]).toEqual({
			c: remaining,
		});
	});
});
