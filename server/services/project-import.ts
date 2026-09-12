import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../db";
import { projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { getProjectDbPath } from "../lib/project-db";

export interface ImportResult {
	projectId: string;
	projectName: string;
	tables: Record<string, number>;
	skipped: boolean;
}

/**
 * Table import order — respects dependency chain.
 * Project DB uses no foreign keys, but main DB does, so order matters.
 */
const IMPORT_ORDER = [
	"projects",
	"exploration_groups",
	"chapters",
	"chapter_edges",
	"narrators",
	"narrator_messages",
	"narrator_message_refs",
	"narrator_tool_calls",
	"narrator_patches",
	"chapter_commits",
	"merge_sessions",
] as const;

/** Read all rows from a project DB table. */
function readAll(pdb: Database, table: string): Record<string, unknown>[] {
	try {
		return pdb.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
	} catch {
		return [];
	}
}

/** Build an INSERT OR IGNORE statement for a table based on its columns. */
function buildInsertSql(table: string, columns: string[]): string {
	const placeholders = columns.map(() => "?").join(", ");
	return `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
}

/** Get column names for a table from the project DB. */
function getColumns(pdb: Database, table: string): string[] {
	const info = pdb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
	return info.map((col) => col.name);
}

/**
 * Import a project from its project database into the main database.
 * Only reads from the project DB — the project DB is the backup source.
 */
export async function importProject(gitPath: string): Promise<ImportResult> {
	const dbPath = getProjectDbPath(gitPath);
	if (!existsSync(dbPath)) {
		throw new NotFoundError("Project database", dbPath);
	}

	// Open project DB directly (read-only for import)
	const pdb = new Database(dbPath, { readonly: true });

	try {
		// Read project record
		const projectRows = readAll(pdb, "projects");
		if (projectRows.length === 0) {
			throw new ValidationError("Project database contains no project record");
		}
		const projectRow = projectRows[0];
		const projectId = projectRow.id as string;
		const projectName = projectRow.name as string;

		// Check if project already exists in main DB
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
			pdb.close();
			return { projectId, projectName, tables: {}, skipped: true };
		}

		// Update gitPath to the current location (may differ from backup)
		projectRow.git_path = gitPath;

		// Import all tables in dependency order using main DB's raw sqlite connection
		const counts: Record<string, number> = {};

		sqlite.run("BEGIN TRANSACTION");
		try {
			for (const table of IMPORT_ORDER) {
				// For projects table, use the already-loaded row with updated git_path
				const rows = table === "projects" ? [projectRow] : readAll(pdb, table);
				if (rows.length === 0) {
					counts[table] = 0;
					continue;
				}

				// Older backups may contain retired columns. Import only columns supported
				// by the current schema, leaving new columns to their database defaults.
				const targetColumns = new Set(getColumns(sqlite, table));
				const columns = getColumns(pdb, table).filter((column) => targetColumns.has(column));
				const sql = buildInsertSql(table, columns);
				const stmt = sqlite.prepare(sql);

				for (const row of rows) {
					const values = columns.map((col) => {
						const val = row[col];
						if (val === undefined) return null;
						return val as string | number | null;
					});
					stmt.run(...values);
				}

				counts[table] = rows.length;
			}
			sqlite.run("COMMIT");
		} catch (err) {
			sqlite.run("ROLLBACK");
			throw err;
		}

		logger.info("Project imported from backup", { projectId, projectName, gitPath, counts });
		return { projectId, projectName, tables: counts, skipped: false };
	} finally {
		pdb.close();
	}
}
