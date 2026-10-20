/** Read-only, worker-backed view of a portable project.db archive. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { closeDbWorkerConnections, runReadTask } from "@server/lib/db-worker/pool";
import { NotFoundError } from "@server/lib/errors";
import { getProjectDbPath } from "@server/lib/project-db";
import { beginReadWorkerDiagnostic } from "@server/lib/sql-execution-diagnostics";
import {
	ARCHIVE_FILE_MAX_PAGE_SIZE,
	type ArchiveTablePage,
	type ArchiveTableReadOptions,
} from "./archive-file-reader";
import type { ArchiveRow } from "./main-store";
import type { ArchiveTable } from "./manifest";

export type { ArchiveTablePage, ArchiveTableReadOptions } from "./archive-file-reader";
export { ARCHIVE_FILE_MAX_PAGE_SIZE } from "./archive-file-reader";
export { isArchiveTable } from "./manifest";

/** Callers await close before replacing or removing the archive file. */
export class ProjectArchiveFile {
	private closed = false;
	private readonly columnCache = new Map<string, readonly string[]>();

	private constructor(readonly path: string) {}

	static open(gitPath: string): ProjectArchiveFile {
		return ProjectArchiveFile.openFile(getProjectDbPath(gitPath));
	}

	static openFile(path: string): ProjectArchiveFile {
		if (!existsSync(path)) throw new NotFoundError("Project database", path);
		return new ProjectArchiveFile(resolve(path));
	}

	async close(): Promise<void> {
		this.closed = true;
		await closeDbWorkerConnections(this.path);
	}

	/** Intersect the legacy file's schema with the current portable manifest. */
	async columnsFor(table: ArchiveTable): Promise<readonly string[]> {
		this.assertOpen();
		const cached = this.columnCache.get(table);
		if (cached) return cached;
		const columns = await runReadTask<readonly string[]>(
			this.path,
			{
				kind: "projectArchiveReadV1",
				operation: "columns",
				table,
			},
			{ onComplete: beginReadWorkerDiagnostic() },
		);
		this.columnCache.set(table, columns);
		return columns;
	}

	async hasTable(table: ArchiveTable): Promise<boolean> {
		return (await this.columnsFor(table)).length > 0;
	}

	/** Row and page byte ceilings are checked inside the worker before IPC. */
	async readTable(
		table: ArchiveTable,
		columns: readonly string[],
		options: ArchiveTableReadOptions = { limit: ARCHIVE_FILE_MAX_PAGE_SIZE },
	): Promise<ArchiveTablePage> {
		this.assertOpen();
		return runReadTask<ArchiveTablePage>(
			this.path,
			{
				kind: "projectArchiveReadV1",
				operation: "page",
				table,
				columns,
				options,
			},
			{ onComplete: beginReadWorkerDiagnostic() },
		);
	}

	async readProjectRow(): Promise<ArchiveRow | null> {
		const columns = await this.columnsFor("projects");
		if (columns.length === 0) return null;
		const { rows } = await this.readTable("projects", columns, { limit: 1 });
		return rows[0] ?? null;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Project archive is closed");
	}
}
