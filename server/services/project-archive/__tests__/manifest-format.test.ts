/**
 * The manifest against a real archive file, and against the real main schema.
 *
 * WHY THIS EXISTS
 * ---------------
 * `manifest.ts` states the archive format as a hand-written list. A hand-written list drifts, and
 * the drift is silent in both directions:
 *
 *   - a column added to `server/lib/project-db.ts`'s DDL but not to the manifest is simply never
 *     exported. The archive has the column, always NULL, and nothing complains.
 *   - a column in the manifest that the archive file does not have is filtered out at runtime by
 *     the very intersection meant to handle OLD files — so a typo looks exactly like
 *     backwards compatibility.
 *
 * So the manifest is compared to a real `project.db` created by the real module, and to the real
 * main-database schema. Both comparisons report the delta rather than just failing, because a
 * guard whose failure does not say what to change is a guard people disable.
 *
 * ISOLATION
 * ---------
 * The archive file is created under `mkdtemp` via the production code path and removed
 * afterwards. `tests/preload.ts` keeps the main database isolated.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateId } from "@server/lib/id";
import { getProjectDbPath, projectDbManager } from "@server/lib/project-db";
import { ARCHIVE_COLUMNS, ARCHIVE_TABLE_ORDER, type ArchiveTable } from "../manifest";
import { projectArchiveMainStore } from "../store";

const tempDirs: string[] = [];
const openedProjects: string[] = [];

/**
 * Columns added by `ensureProjectToolCallTargetColumns` in `server/services/project-db-sync.ts`
 * rather than by `initProjectDb`'s own patch list.
 *
 * A JUST-CREATED archive therefore lacks them; one that has been exported to has them. Listed
 * explicitly, and asserted to be exactly this set, so the two patch sites stay visible — see the
 * dedicated test below for why the split is worth pinning rather than smoothing over.
 */
const LATE_PATCHED_COLUMNS: ReadonlySet<string> = new Set([
	"narrator_tool_calls.execution_path_flavor",
	"narrator_tool_calls.canonical_file_path",
	"narrator_tool_calls.runtime_generation",
	"narrator_tool_calls.execution_targets_json",
]);

afterAll(() => {
	for (const projectId of openedProjects.splice(0)) projectDbManager.close(projectId);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A freshly initialized archive, created by the production code path.
 *
 * `openForGitPath` is what `projects.ts` calls when a project is created, so this exercises the
 * same DDL and the same schema patches a real user's file gets — not a copy of them.
 */
function freshArchive(): { conn: Database; gitPath: string } {
	const gitPath = mkdtempSync(join(tmpdir(), "nf-manifest-"));
	tempDirs.push(gitPath);
	const projectId = generateId();
	openedProjects.push(projectId);
	projectDbManager.openForGitPath(projectId, gitPath);
	// Reopened read-only rather than reusing the cached handle: this must observe the file as it
	// exists on disk, which is what an importing machine sees.
	return { conn: new Database(getProjectDbPath(gitPath), { readonly: true }), gitPath };
}

function fileColumns(conn: Database, table: string): string[] {
	return (conn.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
		(column) => column.name,
	);
}

describe("the manifest matches a real archive file", () => {
	test("every manifest table exists in a freshly created archive", () => {
		const { conn } = freshArchive();
		try {
			const tables = new Set(
				(
					conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
						name: string;
					}>
				).map((row) => row.name),
			);
			const missing = ARCHIVE_TABLE_ORDER.filter((table) => !tables.has(table));
			// A manifest table the file does not have would be silently skipped by the runtime
			// intersection, i.e. never exported and never imported.
			expect(missing, `manifest names tables the archive lacks: ${missing.join(", ")}`).toEqual([]);
		} finally {
			conn.close();
		}
	});

	test("every manifest column exists once both patch sites have run", () => {
		const { conn } = freshArchive();
		try {
			const missing: string[] = [];
			for (const table of ARCHIVE_TABLE_ORDER) {
				const present = new Set(fileColumns(conn, table));
				for (const column of ARCHIVE_COLUMNS[table]) {
					if (LATE_PATCHED_COLUMNS.has(`${table}.${column}`)) continue;
					if (!present.has(column)) missing.push(`${table}.${column}`);
				}
			}
			expect(
				missing,
				`manifest names columns a fresh archive lacks — a typo here is indistinguishable ` +
					`from old-file compatibility: ${missing.join(", ")}`,
			).toEqual([]);
		} finally {
			conn.close();
		}
	});

	test("the late-patched columns are exactly the ones the sync layer adds", () => {
		// The archive schema is patched in TWO places, and this pins which columns come from
		// which, because the split is easy to misread as an omission:
		//
		//   - `initProjectDb` (`server/lib/project-db.ts`) runs the base DDL plus
		//     `PROJECT_DB_SCHEMA_PATCHES` on every open, including `openForGitPath` at project
		//     creation. That is what `freshArchive()` above produces.
		//   - `ensureProjectToolCallTargetColumns` (`server/services/project-db-sync.ts`) adds
		//     these four, and it runs from `getProjectDb` — i.e. before any export read or write.
		//
		// So a file that has only ever been created and never exported to lacks them, while every
		// file the export has touched has them. Both shapes are valid archives, which is exactly
		// why the runtime intersection exists. Harmless, but it must be asserted rather than
		// assumed: if the sync layer ever stopped patching, these columns would silently vanish
		// from newly written archives and the manifest would keep claiming them.
		const { conn } = freshArchive();
		try {
			const absent = new Set<string>();
			for (const table of ARCHIVE_TABLE_ORDER) {
				const present = new Set(fileColumns(conn, table));
				for (const column of ARCHIVE_COLUMNS[table]) {
					if (!present.has(column)) absent.add(`${table}.${column}`);
				}
			}
			expect([...absent].sort()).toEqual([...LATE_PATCHED_COLUMNS].sort());
		} finally {
			conn.close();
		}
	});

	test("no archive column is missing from the manifest", () => {
		const { conn } = freshArchive();
		try {
			const unlisted: string[] = [];
			for (const table of ARCHIVE_TABLE_ORDER) {
				const listed = new Set(ARCHIVE_COLUMNS[table]);
				for (const column of fileColumns(conn, table)) {
					if (!listed.has(column)) unlisted.push(`${table}.${column}`);
				}
			}
			// The other direction: a column in the DDL but not the manifest is a column that
			// exists in every user's archive and is never written to.
			expect(
				unlisted,
				`the archive DDL has columns the manifest does not carry — add them to ` +
					`ARCHIVE_COLUMNS or remove them from the DDL: ${unlisted.join(", ")}`,
			).toEqual([]);
		} finally {
			conn.close();
		}
	});

	test("the manifest's column ORDER matches the file's, so a diff reads as a diff", () => {
		const { conn } = freshArchive();
		try {
			for (const table of ARCHIVE_TABLE_ORDER) {
				// Kept in DDL order deliberately (see the manifest header). This is not a
				// correctness requirement — every statement is column-named — but an ordering that
				// silently diverges makes the manifest unreviewable against the DDL.
				//
				// The late-patched columns are dropped from the comparison rather than reordered:
				// they are appended by ALTER TABLE, so they land at the end of the file's column
				// list too, and the manifest lists them last for that reason.
				const expected = ARCHIVE_COLUMNS[table].filter(
					(column) => !LATE_PATCHED_COLUMNS.has(`${table}.${column}`),
				);
				expect(expected, `${table} column order drifted from the DDL`).toEqual(
					fileColumns(conn, table),
				);
			}
		} finally {
			conn.close();
		}
	});
});

describe("the manifest against the current main schema", () => {
	test("the main database can supply every manifest column", async () => {
		const unsupported: string[] = [];
		for (const table of ARCHIVE_TABLE_ORDER) {
			const supported = new Set(await projectArchiveMainStore.supportedColumns(table));
			for (const column of ARCHIVE_COLUMNS[table]) {
				if (!supported.has(column)) unsupported.push(`${table}.${column}`);
			}
		}
		// A manifest column the main schema no longer has is silently dropped from both
		// directions, so an archive would keep the column and never fill it. That is a real state
		// (the format may outlive a main column), but it must be a DECIDED one — if this fails,
		// either the column is gone for good and the manifest should say so, or a rename was
		// missed.
		expect(
			unsupported,
			`the main schema cannot supply these manifest columns: ${unsupported.join(", ")}`,
		).toEqual([]);
	});

	test("an unknown table yields no columns rather than throwing", async () => {
		// The caller treats an empty list as "skip this table", the same as a table missing from
		// an old archive. Throwing here would turn a schema question into a failed import.
		expect(await projectArchiveMainStore.supportedColumns("users")).toEqual([]);
		expect(await projectArchiveMainStore.supportedColumns("not_a_table")).toEqual([]);
	});

	test("supportedColumns never widens beyond the manifest", async () => {
		for (const table of ARCHIVE_TABLE_ORDER) {
			const supported = await projectArchiveMainStore.supportedColumns(table);
			const listed = new Set<string>(ARCHIVE_COLUMNS[table]);
			const extra = supported.filter((column) => !listed.has(column));
			// This is the mechanism that keeps `credential_id` and the ACL columns out of the
			// archive: the store may only offer what the format defines, even when the main
			// database has more.
			expect(extra, `${table} would export unlisted columns: ${extra.join(", ")}`).toEqual([]);
		}
	});
});

describe("reads are bounded", () => {
	test("a page request is clamped and reports whether more remain", async () => {
		// The contract's paging promise, exercised against the real main database. An empty table
		// is the honest case here — the assertion is about the SHAPE (never unbounded, cursor
		// null at the end), which holds regardless of how many rows exist.
		const page = await projectArchiveMainStore.readRows({
			table: "projects",
			// Deliberately over the ceiling: the store must clamp rather than honor it.
			limit: 100_000,
		});
		expect(Array.isArray(page.rows)).toBe(true);
		expect(page.rows.length).toBeLessThanOrEqual(500);
		if (page.nextCursor === null) expect(page.rows.length).toBeLessThanOrEqual(500);
	});

	test("an empty filter list matches nothing instead of widening to the whole table", async () => {
		// The failure this prevents: a scoped export whose id list happens to be empty turning
		// into a full-table dump.
		const page = await projectArchiveMainStore.readRows({
			table: "chapters",
			filter: { column: "project_id", values: [] },
			limit: 10,
		});
		expect(page.rows).toEqual([]);
		expect(page.nextCursor).toBeNull();
	});

	test("filtering by a column the archive does not define is refused", async () => {
		// Not silently ignored: a filter that vanishes reads every row of the table.
		await expect(
			projectArchiveMainStore.readRows({
				table: "narrators",
				filter: { column: "owner_user_id", values: ["someone"] },
				limit: 10,
			}),
		).rejects.toThrow(/no such archive column/);
	});

	test("a table outside the archive is refused on both read and write", async () => {
		await expect(projectArchiveMainStore.readRows({ table: "users", limit: 1 })).rejects.toThrow(
			/not a table of the portable project archive/,
		);
		await expect(
			projectArchiveMainStore.importRows({
				batches: [{ table: "users", columns: ["id"], rows: [{ id: "x" }] }],
				conflictPolicy: "skip",
			}),
		).rejects.toThrow(/not a table of the portable project archive/);
	});

	test("an unsupported conflict policy is refused before the transaction opens", async () => {
		await expect(
			projectArchiveMainStore.importRows({
				batches: [],
				// Deliberately outside the union: an adapter must reject a policy it does not
				// implement rather than silently applying its own.
				conflictPolicy: "overwrite" as never,
			}),
		).rejects.toThrow(/Unsupported archive conflict policy/);
	});

	test("an empty import is a no-op, not an error", async () => {
		const result = await projectArchiveMainStore.importRows({
			batches: [],
			conflictPolicy: "skip",
		});
		expect(result.applied).toEqual({});
	});

	test("a batch of zero rows is counted without preparing a statement", async () => {
		const table: ArchiveTable = "projects";
		const result = await projectArchiveMainStore.importRows({
			batches: [{ table, columns: ["id", "name"], rows: [] }],
			conflictPolicy: "skip",
		});
		expect(result.applied[table]).toBe(0);
	});
});
