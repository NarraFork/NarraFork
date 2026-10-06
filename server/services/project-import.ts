/**
 * Importing a project from its portable `project.db` archive.
 *
 * WHAT CHANGED IN PHASE 2, AND WHY IT WAS NOT COSMETIC
 * ---------------------------------------------------
 * This module used to reach into the main database directly: `sqlite.run("BEGIN TRANSACTION")`,
 * a loop of `sqlite.prepare(...)`, then `"COMMIT"` or `"ROLLBACK"` on the shared handle, plus
 * `PRAGMA table_info` against it to discover columns. Three problems, in increasing order of
 * severity:
 *
 *   1. Raw `BEGIN`/`COMMIT` on the shared connection composes with nothing. It cannot nest, and
 *      an unrelated transaction already open on that handle turns the `BEGIN` into an error or,
 *      worse, makes the `COMMIT` end SOMEBODY ELSE's transaction.
 *   2. It read every row of every table into the heap before writing any of them —
 *      `SELECT * FROM narrator_messages` with no bound, including `content_json`.
 *   3. It made the import's correctness depend on the main database being SQLite, so a second
 *      backend would have had to reproduce the statement shape rather than the requirement.
 *
 * The requirement is now stated in `project-archive/main-store.ts` and satisfied by
 * `project-archive/store.ts`. The atomicity guarantee is unchanged in strength and stronger in
 * kind: one transaction the store owns, entered and left in one place.
 *
 * WHAT DELIBERATELY DID NOT CHANGE
 * --------------------------------
 * `ImportResult` and its `tables` counts, the skip-if-already-present behavior, the `git_path`
 * rewrite, the `INSERT OR IGNORE` merge rule, and the table order. The route's responses and
 * every caller keep working exactly as before; `tables[…]` still counts rows OFFERED per table,
 * not rows inserted, which is what it always counted.
 *
 * THE HONEST LIMIT
 * ----------------
 * Two databases are not one transaction. The main database is all-or-nothing here. The archive
 * file is never written at all (opened read-only), so a failure cannot damage the user's backup
 * — which is the asymmetry that actually matters, since the archive is what they would retry
 * from.
 */

import { eq } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../db";
import { getDbPath } from "../db/connection";
import { projects } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { getProjectDbPath } from "../lib/project-db";
import { initializeRefSeqFloor, markNarratorSeqFloorHealedMany } from "./narrator-refs/seq-store";
import type { ArchiveActor } from "./project-archive/access";
import { ProjectArchiveFile } from "./project-archive/archive-file";
import { importLegacyProjectOnWorker } from "./project-archive/legacy-import-job";
import { PROJECT_ARCHIVE_LIMITS } from "./project-archive/limits";
import type { ArchiveBatch, ArchiveRow } from "./project-archive/main-store";
import { ARCHIVE_TABLE_ORDER, type ArchiveTable } from "./project-archive/manifest";
import { projectArchiveMainStore } from "./project-archive/store";
import { sanitizeLegacyPolicyRow } from "./project-archive/untrusted-policy";

export interface ImportResult {
	projectId: string;
	projectName: string;
	tables: Record<string, number>;
	skipped: boolean;
}

export interface ProjectImportLimits {
	/** Retained rows across every table, including the project row. */
	readonly maxTotalRows: number;
	/** Sum of retained batches' JSON-array UTF-8 byte sizes. */
	readonly maxTotalSerializedBytes: number;
	/** One normalized archive row's JSON-object UTF-8 byte size. */
	readonly maxRowSerializedBytes: number;
	/** Rows retained in one batch passed to the main-store transaction. */
	readonly maxBatchRows: number;
	/** One retained batch's JSON-array UTF-8 byte size. */
	readonly maxBatchSerializedBytes: number;
}

/**
 * Hard production ceilings. Test-only overrides may tighten, never increase, these values.
 *
 * The byte budget controls payload size while the row budget controls object/key overhead for
 * projects made of many tiny rows. Batches stay small enough that the synchronous SQLite
 * transaction never receives one giant array, while the 4 MiB row ceiling still permits large
 * conversation/tool payloads.
 */
export const PROJECT_IMPORT_LIMITS: ProjectImportLimits = Object.freeze({
	maxTotalRows: 100_000,
	maxTotalSerializedBytes: 64 * 1024 * 1024,
	maxRowSerializedBytes: 4 * 1024 * 1024,
	maxBatchRows: 500,
	maxBatchSerializedBytes: 8 * 1024 * 1024,
});

/**
 * Read every archive table into bounded batches, narrowed to columns BOTH sides support.
 *
 * Reading remains outside the main-store transaction because archive I/O may be asynchronous in
 * future implementations, while the SQLite transaction callback must stay strictly synchronous.
 * The cost of preserving whole-import atomicity is therefore buffering, but the total row and
 * serialized-byte ceilings below make that cost explicit and finite.
 */
async function collectBatches(
	archive: ProjectArchiveFile,
	projectRow: ArchiveRow,
	gitPath: string,
	limits: ProjectImportLimits,
): Promise<{ batches: ArchiveBatch[]; counts: Record<string, number> }> {
	const batches: ArchiveBatch[] = [];
	const counts: Record<string, number> = {};
	const budget = { rows: 0, serializedBytes: 0 };

	for (const table of ARCHIVE_TABLE_ORDER) {
		const supported = new Set(await projectArchiveMainStore.supportedColumns(table));
		const columns = archive.columnsFor(table).filter((column) => supported.has(column));
		counts[table] = 0;
		if (columns.length === 0) continue;

		if (table === "projects") {
			const row: Record<string, ArchiveRow[string]> = {};
			for (const column of columns) {
				row[column] = column === "git_path" ? gitPath : (projectRow[column] ?? null);
			}
			const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
			if (rowBytes > limits.maxRowSerializedBytes) {
				throw new ValidationError(
					`Archive row "projects.${String(row.id)}" exceeds the ${limits.maxRowSerializedBytes}-byte serialized row limit`,
					"PROJECT_ARCHIVE_LIMIT_EXCEEDED",
				);
			}
			const rows = [row];
			retainBatch(batches, budget, limits, table, columns, rows, rowBytes + 2);
			counts[table] = 1;
			continue;
		}

		let after: string | null = null;
		for (;;) {
			const page = archive.readTable(table, columns, {
				limit: limits.maxBatchRows,
				after,
				maxRowSerializedBytes: limits.maxRowSerializedBytes,
				maxBatchSerializedBytes: limits.maxBatchSerializedBytes,
			});
			if (page.rows.length > 0) {
				retainBatch(batches, budget, limits, table, columns, page.rows, page.serializedBytes);
				counts[table] += page.rows.length;
			}
			if (page.nextCursor === null) break;
			if (page.nextCursor === after) {
				throw new ValidationError(
					`Archive table "${table}" has a non-advancing cursor at ${after}`,
				);
			}
			after = page.nextCursor;
		}
	}

	return { batches, counts };
}

function retainBatch(
	batches: ArchiveBatch[],
	budget: { rows: number; serializedBytes: number },
	limits: ProjectImportLimits,
	table: ArchiveTable,
	columns: readonly string[],
	rows: readonly ArchiveRow[],
	serializedBytes: number,
): void {
	if (rows.length > limits.maxBatchRows) {
		throw new ValidationError(
			`Archive batch for "${table}" exceeds the ${limits.maxBatchRows}-row batch limit`,
			"PROJECT_ARCHIVE_LIMIT_EXCEEDED",
		);
	}
	if (serializedBytes > limits.maxBatchSerializedBytes) {
		throw new ValidationError(
			`Archive batch for "${table}" exceeds the ${limits.maxBatchSerializedBytes}-byte serialized batch limit`,
			"PROJECT_ARCHIVE_LIMIT_EXCEEDED",
		);
	}
	const nextRows = budget.rows + rows.length;
	if (nextRows > limits.maxTotalRows) {
		throw new ValidationError(
			`Project archive exceeds the ${limits.maxTotalRows}-row import limit`,
			"PROJECT_ARCHIVE_LIMIT_EXCEEDED",
		);
	}
	const nextBytes = budget.serializedBytes + serializedBytes;
	if (nextBytes > limits.maxTotalSerializedBytes) {
		throw new ValidationError(
			`Project archive exceeds the ${limits.maxTotalSerializedBytes}-byte serialized import limit`,
			"PROJECT_ARCHIVE_LIMIT_EXCEEDED",
		);
	}
	budget.rows = nextRows;
	budget.serializedBytes = nextBytes;
	const sanitizedRows = rows.map((row) => {
		const sanitized = { ...row };
		sanitizeLegacyPolicyRow(sanitized);
		return sanitized;
	});
	batches.push({ table, columns, rows: sanitizedRows });
}

function resolveImportLimits(overrides: Partial<ProjectImportLimits>): ProjectImportLimits {
	const resolved = { ...PROJECT_IMPORT_LIMITS };
	for (const key of Object.keys(PROJECT_IMPORT_LIMITS) as Array<keyof ProjectImportLimits>) {
		const value = overrides[key];
		if (value === undefined) continue;
		if (!Number.isSafeInteger(value) || value < 1 || value > PROJECT_IMPORT_LIMITS[key]) {
			throw new ValidationError(
				`Invalid project archive import limit ${key}: expected an integer from 1 to ${PROJECT_IMPORT_LIMITS[key]}`,
			);
		}
		resolved[key] = value;
	}
	return resolved;
}

/**
 * Import a project from its archive into the main database.
 *
 * Only reads the archive — it is the backup source and is opened read-only, so a failure here
 * cannot damage it.
 */
export async function importProject(
	gitPath: string,
	limitOverrides: Partial<ProjectImportLimits> = {},
	options: { actor?: ArchiveActor; signal?: AbortSignal; worker?: boolean } = {},
): Promise<ImportResult> {
	const limits = resolveImportLimits(limitOverrides);
	// HTTP and production callers never stage or commit a large archive on the main thread.
	// The old adapter path remains solely for isolated legacy-format/limit override tests.
	if (options.worker ?? process.env.NODE_ENV !== "test") {
		if (Object.keys(limitOverrides).length)
			throw new ValidationError("Worker import uses fixed production budgets");
		return importLegacyProjectOnWorker(
			{
				gitPath,
				archivePath: getProjectDbPath(gitPath),
				databasePath: getDbPath(),
				backend: activeDatabaseBackend === "postgres" ? "postgres" : "sqlite",
				postgresUrl:
					activeDatabaseBackend === "postgres"
						? (process.env.NF_DATABASE_URL ?? process.env.DATABASE_URL)
						: undefined,
				actor: options.actor,
				deadline: Date.now() + PROJECT_ARCHIVE_LIMITS.jobMs,
			},
			options.signal,
		);
	}
	const archive = ProjectArchiveFile.open(gitPath);

	try {
		const projectPage = archive.readTable("projects", archive.columnsFor("projects"), {
			limit: 1,
			maxRowSerializedBytes: limits.maxRowSerializedBytes,
			maxBatchSerializedBytes: limits.maxBatchSerializedBytes,
		});
		const projectRow = projectPage.rows[0];
		if (!projectRow) {
			throw new ValidationError("Project database contains no project record");
		}
		const projectId = projectRow.id as string;
		const projectName = projectRow.name as string;

		const existing = await db.query.projects.findFirst({
			where: eq(projects.id, projectId),
			columns: { id: true, gitPath: true },
		});

		if (existing) {
			logger.info("Project already exists in main DB, skipping import", {
				projectId,
				existingGitPath: existing.gitPath,
				importGitPath: gitPath,
			});
			return { projectId, projectName, tables: {}, skipped: true };
		}

		// The project may have moved since the archive was written, so the current location wins.
		const { batches, counts } = await collectBatches(archive, projectRow, gitPath, limits);

		// One indivisible change. On failure the main database is exactly as it was found — see
		// the store's contract; nothing partial is left behind for the user to clean up.
		await projectArchiveMainStore.importRows({ batches, conflictPolicy: "skip" });

		// Archive narrators omit next_seq (defaults to 0) while refs keep historical seq.
		// Raise floors now so the first claim after import cannot collide; mark healed only
		// after each raise transaction commits.
		const importedNarratorIds: string[] = [];
		for (const batch of batches) {
			if (batch.table !== "narrators") continue;
			for (const row of batch.rows) {
				const id = row.id;
				if (typeof id === "string" && id) importedNarratorIds.push(id);
			}
		}
		const uniqueNarratorIds = [...new Set(importedNarratorIds)];
		const CHUNK = 400;
		for (let i = 0; i < uniqueNarratorIds.length; i += CHUNK) {
			const chunk = uniqueNarratorIds.slice(i, i + CHUNK);
			db.transaction((tx) => {
				for (const id of chunk) initializeRefSeqFloor(tx, id);
			});
			markNarratorSeqFloorHealedMany(chunk);
		}

		logger.info("Project imported from backup", { projectId, projectName, gitPath, counts });
		return { projectId, projectName, tables: counts, skipped: false };
	} finally {
		archive.close();
	}
}
