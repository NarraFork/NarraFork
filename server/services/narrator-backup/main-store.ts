import { NARRATOR_BACKUP_LIMITS as LIMITS } from "@shared/narrator-backup";
import type { ArchiveRow, ArchiveValue } from "../project-archive/main-store";
import {
	backupChapterProject,
	requireBackupDeviceAccess,
	requireBackupProjectAccess,
} from "./access";
import {
	BACKUP_TABLES,
	type BackupActor,
	type BackupReadQuery,
	type BackupState,
	type BackupTable,
	backupColumns,
	type NarratorBackupMainStore,
	quoteBackupIdentifier as q,
} from "./contract";
import { archivedBackupState, assertFullExport } from "./state";

export interface BackupSqlConnection {
	byteLength(column: string): string;
	query(text: string, values?: ArchiveValue[]): Promise<ArchiveRow[]>;
	/** Each transaction owns an independent connection. SQLite runs in a worker. */
	transaction<T>(write: boolean, action: (tx: BackupSqlConnection) => Promise<T>): Promise<T>;
	columns(table: BackupTable): Promise<string[]>;
}
const FORWARD: Partial<Record<BackupTable, string[]>> = {
	narrators: [
		"parent_narrator_id",
		"fork_message_id",
		"refs_inherited_from",
		"acl_root_narrator_id",
	],
	spec_namespaces: ["forked_from_namespace_id"],
	spec_file_revisions: ["parent_revision_id"],
};

/** The same bounded scoped SQL, closure and conflict rules on SQLite and PostgreSQL. */
export class SqlNarratorBackupMainStore implements NarratorBackupMainStore {
	private connection: BackupSqlConnection;
	constructor(connection: BackupSqlConnection) {
		this.connection = connection;
	}
	async columns(table: BackupTable) {
		const live = await this.connection.columns(table);
		const result = backupColumns(table).filter((column) => live.includes(column));
		for (const required of backupColumns(table))
			if (!result.includes(required))
				throw new Error(`Required backup column missing: ${table}.${required}`);
		return result;
	}
	async read(query: BackupReadQuery) {
		if (!query.values.length) return [];
		if (query.values.length > 200) throw new Error("Backup filter budget exceeded");
		const columns = await this.columns(query.table);
		if (!columns.includes(query.column)) throw new Error("Unsupported backup scope");
		const values: ArchiveValue[] = [...query.values];
		const marks = values.map((_, index) => `$${index + 1}`).join(",");
		let where = `${q(query.column)} IN (${marks})`;
		if (query.subagentsOnly) {
			if (query.table !== "narrators") throw new Error("Invalid subagent scope");
			where += " AND type='subagent'";
		}
		if (query.beforeSeq !== undefined) {
			if (
				query.table !== "narrator_message_refs" ||
				!Number.isSafeInteger(query.beforeSeq) ||
				query.beforeSeq < 0
			)
				throw new Error("Invalid backup history prefix");
			values.push(query.beforeSeq);
			where += ` AND seq < $${values.length} AND segment_compact_id IS NULL`;
		}
		if (query.after) {
			values.push(query.after);
			where += ` AND id > $${values.length}`;
		}
		values.push(Math.max(1, Math.min(500, query.limit ?? 500)));
		// Read byte lengths before materializing large content columns. A page is also byte
		// bounded, so 500 individually legal 4MiB rows can never allocate a multi-GiB batch.
		const sizes = await this.connection.query(
			`SELECT id, (${columns.map((column) => this.connection.byteLength(column)).join("+")}) AS size FROM ${q(query.table)} WHERE ${where} ORDER BY id LIMIT $${values.length}`,
			values,
		);
		const selected: ArchiveValue[] = [];
		let pageBytes = 0;
		for (const row of sizes) {
			const size = Number(row.size);
			if (!Number.isSafeInteger(size) || size > LIMITS.rowBytes)
				throw new Error("Backup row byte budget exceeded");
			if (selected.length && pageBytes + size > LIMITS.rowBytes * 2) break;
			pageBytes += size;
			selected.push(row.id ?? null);
		}
		if (!selected.length) return [];
		return this.connection.query(
			`SELECT ${columns.map(q).join(",")} FROM ${q(query.table)} WHERE id IN (${selected.map((_, i) => `$${i + 1}`).join(",")}) ORDER BY id`,
			selected,
		);
	}
	async sourceProjectIds(state: BackupState): Promise<string[]> {
		const result = new Set<string>();
		for (const row of state.rows.narrators ?? []) {
			if (typeof row.context_project_id === "string") result.add(row.context_project_id);
			if (typeof row.chapter_id === "string") {
				const chapter = (
					await this.connection.query("SELECT project_id FROM chapters WHERE id=$1 LIMIT 1", [
						row.chapter_id,
					])
				)[0];
				if (!chapter || typeof chapter.project_id !== "string")
					throw new Error("Missing source chapter context");
				result.add(chapter.project_id);
			}
		}
		return [...result];
	}
	async readFileBlobDigests(operationId: string): Promise<string[]> {
		const effects = await this.connection.query(
			"SELECT id,before_blob_digest,intended_after_blob_digest,observed_after_blob_digest FROM file_change_effects WHERE operation_id=$1 ORDER BY id LIMIT 501",
			[operationId],
		);
		if (!effects.length || effects.length > 500)
			throw new Error("Missing or oversized file blob dependency closure");
		return [
			...new Set(
				effects.flatMap((row) =>
					[
						row.before_blob_digest,
						row.intended_after_blob_digest,
						row.observed_after_blob_digest,
					].filter((value): value is string => typeof value === "string"),
				),
			),
		];
	}
	async snapshot<T>(action: () => Promise<T>): Promise<T> {
		return this.connection.transaction(false, async (tx) => {
			const original = this.connection;
			this.connection = tx;
			try {
				return await action();
			} finally {
				this.connection = original;
			}
		});
	}
	async restore(state: BackupState, actor: BackupActor, check: () => void): Promise<void> {
		await this.connection.transaction(true, async (tx) => {
			await validateRestoreTarget(tx, state, actor, check);
			const archived = archivedBackupState(state);
			const forwards: {
				table: BackupTable;
				id: ArchiveValue;
				column: string;
				value: ArchiveValue;
			}[] = [];
			for (const table of Object.keys(BACKUP_TABLES) as BackupTable[]) {
				const live = await tx.columns(table);
				for (const row of archived.rows[table] ?? []) {
					check();
					// New profiles never silently drop a required field like legacy project.db does.
					const columns = Object.keys(row);
					if (
						columns.some(
							(column) => !live.includes(column) || !backupColumns(table).includes(column),
						)
					)
						throw new Error("Target schema cannot preserve backup fields");
					const values = columns.map((column) => {
						if (FORWARD[table]?.includes(column) && row[column] != null) {
							forwards.push({ table, id: row.id ?? null, column, value: row[column] ?? null });
							return null;
						}
						return row[column] ?? null;
					});
					await tx.query(
						`INSERT INTO ${q(table)} (${columns.map(q).join(",")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(",")})`,
						values,
					);
				}
			}
			for (const ref of forwards) {
				check();
				await tx.query(`UPDATE ${q(ref.table)} SET ${q(ref.column)}=$1 WHERE id=$2`, [
					ref.value,
					ref.id,
				]);
			}
			check();
		});
	}
}

/** Runs again inside the write transaction, including current actor/admin and target ACL. */
export async function validateRestoreTarget(
	connection: BackupSqlConnection,
	state: BackupState,
	actor: BackupActor,
	check: () => void,
): Promise<void> {
	const user = (
		await connection.query("SELECT id, role FROM users WHERE id=$1 LIMIT 1", [actor.userId])
	)[0];
	if (!user) throw new Error("Restore actor no longer exists");
	const freshActor = { userId: actor.userId, isAdmin: actor.isAdmin && user.role === "admin" };
	const narrators = state.rows.narrators ?? [];
	if (!narrators.length) throw new Error("Backup has no narrators");
	const byId = new Map(narrators.map((row) => [String(row.id), row]));
	for (const row of narrators) {
		check();
		assertFullExport(row, freshActor, byId.get(String(row.acl_root_narrator_id)));
		if (
			typeof row.owner_user_id === "string" &&
			!(await connection.query("SELECT id FROM users WHERE id=$1 LIMIT 1", [row.owner_user_id]))
				.length
		)
			throw new Error("Missing target owner_user_id");
		// Chapter context takes priority over nullable standalone context, exactly as
		// runtime policy does. Resolve it inside this transaction, not from preview.
		const projectId = await backupChapterProject(connection, row);
		if (projectId) await requireBackupProjectAccess(connection, projectId, freshActor, "write");
		if (typeof row.context_project_id === "string" && row.context_project_id !== projectId)
			await requireBackupProjectAccess(connection, row.context_project_id, freshActor, "write");
		if (typeof row.default_device_id === "string")
			await requireBackupDeviceAccess(connection, row.default_device_id, projectId, freshActor);
		for (const resource of state.rows.narrator_worktree_resources ?? [])
			if (resource.owner_narrator_id === row.id && typeof resource.device_id === "string")
				await requireBackupDeviceAccess(connection, resource.device_id, projectId, freshActor);
	}
	for (const table of Object.keys(BACKUP_TABLES) as BackupTable[]) {
		for (const row of state.rows[table] ?? []) {
			check();
			if (
				(await connection.query(`SELECT id FROM ${q(table)} WHERE id=$1 LIMIT 1`, [row.id ?? null]))
					.length
			)
				throw new Error("Existing object ID conflicts with restore (active or archived)");
			if (
				table === "narrator_worktree_resources" &&
				(
					await connection.query(
						"SELECT id FROM narrator_worktree_resources WHERE device_id=$1 AND worktree_path=$2 LIMIT 1",
						[row.device_id ?? null, row.worktree_path ?? null],
					)
				).length
			)
				throw new Error("Target registry path conflicts with restore");
		}
	}
}
