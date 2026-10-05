import { Database } from "bun:sqlite";
import { parentPort } from "node:worker_threads";
import { openDatabase } from "@server/db/connection";
import { NARRATOR_BACKUP_LIMITS as LIMITS } from "@shared/narrator-backup";
import { SQL } from "bun";
import type { BackupActor, BackupTable } from "../narrator-backup/contract";
import { postgresBackupConnection } from "../narrator-backup/postgres-main-store";
import { sqliteBackupConnection } from "../narrator-backup/sqlite-main-store";
import { assertFullExport } from "../narrator-backup/state";
import { forwardReferencesOf } from "./deferred-references";
import type { ArchiveRow, ArchiveValue } from "./main-store";
import {
	ARCHIVE_COLUMNS,
	ARCHIVE_INTERNAL_REFERENCES,
	ARCHIVE_TABLE_ORDER,
	type ArchiveTable,
} from "./manifest";
import { sanitizeLegacyPolicyRow } from "./untrusted-policy";

export interface LegacyImportWorkerRequest {
	archivePath: string;
	gitPath: string;
	databasePath: string;
	backend: "sqlite" | "postgres";
	postgresUrl?: string;
	actor?: BackupActor;
	deadline: number;
	cancellation: SharedArrayBuffer;
}
export interface LegacyWorkerImportResult {
	projectId: string;
	projectName: string;
	tables: Record<string, number>;
	skipped: boolean;
}
const q = (name: string) => `"${name}"`;
// Target-supported safety fields are mandatory writes, not a source/target
// intersection: omitting an old archive column must never activate target defaults.
const FROZEN_FIELDS: Partial<Record<ArchiveTable, ArchiveRow>> = {
	narrators: {
		status: "archived",
		permission_mode: "readOnly",
		previous_permission_mode: null,
		is_background: 0,
		background_status: "cancelled",
		substatus: "[]",
		turn_started_at: null,
	},
	narrator_tool_calls: {
		is_background: 0,
		execution_attempt: 0,
		execution_identity_version: 0,
		execution_origin_tool_call_id: null,
		execution_segment_id: null,
		file_change_operation_id: null,
		permission_started_at: null,
		execution_started_at: null,
	},
};
export async function runLegacyImportWorker(
	request: LegacyImportWorkerRequest,
): Promise<LegacyWorkerImportResult> {
	const check = () => {
		if (Date.now() >= request.deadline || Atomics.load(new Int32Array(request.cancellation), 0))
			throw new Error("Project import cancelled or timed out");
	};
	check();
	const archive = new Database(request.archivePath, { readonly: true });
	let main: Database | undefined;
	let pg: SQL | undefined;
	try {
		archive.run("PRAGMA trusted_schema=OFF");
		main = request.backend === "sqlite" ? openDatabase(request.databasePath) : undefined;
		pg =
			request.backend === "postgres"
				? new SQL(request.postgresUrl ?? "", { max: 1, connectionTimeout: 10 })
				: undefined;
		const connection = main
			? sqliteBackupConnection(main)
			: pg
				? postgresBackupConnection(pg)
				: undefined;
		if (!connection) throw new Error("Project import target unavailable");
		const batches: { table: ArchiveTable; columns: string[]; rows: ArchiveRow[] }[] = [];
		let count = 0;
		let bytes = 0;
		archive.run("BEGIN");
		try {
			for (const table of ARCHIVE_TABLE_ORDER) {
				check();
				const definition = archive
					.prepare("SELECT type,sql FROM sqlite_schema WHERE name=? LIMIT 1")
					.get(table) as { type: string; sql: string } | null;
				if (!definition) continue; // Legacy archives may omit a whole table.
				if (definition.type !== "table" || /CREATE\s+VIRTUAL/i.test(definition.sql))
					throw new Error("Project archive requires plain tables");
				const live = await connection.columns(table as BackupTable);
				const present = archive.prepare(`PRAGMA table_xinfo(${q(table)})`).all() as {
					name: string;
					hidden: number;
				}[];
				if (present.some((field) => field.hidden !== 0))
					throw new Error("Generated project archive columns are forbidden");
				const columns = ARCHIVE_COLUMNS[table].filter(
					(name) => live.includes(name) && present.some((field) => field.name === name),
				);
				if (!columns.length) continue; // Deliberate legacy intersection, never used by v1 narrator profiles.
				const rows: ArchiveRow[] = [];
				let after = "";
				for (;;) {
					check();
					const sizes = archive
						.prepare(
							`SELECT id,(${columns.map((column) => `coalesce(length(CAST(${q(column)} AS BLOB)),0)`).join("+")}) AS size FROM ${q(table)} WHERE id>? ORDER BY id LIMIT 500`,
						)
						.all(after) as { id: string; size: number }[];
					if (!sizes.length) break;
					for (const info of sizes) {
						check();
						if (info.size > LIMITS.rowBytes) throw new Error("Project import row budget exceeded");
						const row = archive
							.prepare(`SELECT ${columns.map(q).join(",")} FROM ${q(table)} WHERE id=? LIMIT 1`)
							.get(info.id) as Record<string, ArchiveValue>;
						if (
							!row ||
							Object.values(row).some(
								(value) =>
									value !== null && !["string", "number", "boolean"].includes(typeof value),
							)
						)
							throw new Error("Invalid legacy archive value");
						if (table === "projects") row.git_path = request.gitPath;
						sanitizeLegacyPolicyRow(row);
						bytes += Buffer.byteLength(JSON.stringify(row));
						if (bytes > LIMITS.stateBytes || ++count > LIMITS.stateRows)
							throw new Error("Project import state budget exceeded");
						rows.push(row);
						after = info.id;
					}
				}
				const frozen = FROZEN_FIELDS[table] ?? {};
				const mandatory = Object.keys(frozen).filter((field) => live.includes(field));
				if (table === "narrators") {
					for (const field of ["status", "permission_mode"])
						if (!live.includes(field))
							throw new Error("Project import target cannot freeze narrators");
				}
				if (table === "narrator_tool_calls" && live.includes("status")) mandatory.push("status");
				batches.push({ table, columns: [...new Set([...columns, ...mandatory])], rows });
			}
			archive.run("COMMIT");
		} catch (error) {
			archive.run("ROLLBACK");
			throw error;
		}
		const project = batches.find((batch) => batch.table === "projects")?.rows[0];
		if (!project || typeof project.id !== "string" || typeof project.name !== "string")
			throw new Error("Project archive contains no project");
		const archiveIds = new Map(
			batches.map((batch) => [batch.table, new Set(batch.rows.map((row) => row.id))]),
		);
		for (const batch of batches)
			for (const row of batch.rows) {
				check();
				if (typeof row.id !== "string" || !row.id) throw new Error("Invalid archive row ID");
				for (const [field, dependency] of Object.entries(
					ARCHIVE_INTERNAL_REFERENCES[batch.table] ?? {},
				)) {
					if (
						row[field] != null &&
						(typeof row[field] !== "string" || !archiveIds.get(dependency)?.has(row[field]))
					)
						throw new Error("Missing self-contained archive dependency");
				}
			}
		return await connection.transaction(true, async (tx) => {
			if (
				(await tx.query("SELECT id FROM projects WHERE id=$1 LIMIT 1", [project.id ?? null])).length
			)
				return {
					projectId: String(project.id),
					projectName: String(project.name),
					tables: {},
					skipped: true,
				};
			let actor = request.actor;
			if (actor) {
				const user = (
					await tx.query("SELECT id,role FROM users WHERE id=$1 LIMIT 1", [actor.userId])
				)[0];
				if (!user) throw new Error("Project import actor no longer exists");
				actor = { userId: actor.userId, isAdmin: actor.isAdmin && user.role === "admin" };
			}
			const projectColumns = await tx.columns("projects" as BackupTable);
			const narratorColumns = await tx.columns("narrators");
			async function authorizeTargetProject(id: unknown) {
				if (!actor || typeof id !== "string" || !projectColumns.includes("owner_user_id")) return;
				const actual = (
					await tx.query("SELECT id,owner_user_id FROM projects WHERE id=$1 LIMIT 1", [id])
				)[0];
				if (actual && !actor.isAdmin && actual.owner_user_id !== actor.userId)
					throw new Error("Existing target project requires owner/admin authority");
			}
			for (const batch of batches)
				for (const row of batch.rows) {
					check();
					if (batch.table === "projects") await authorizeTargetProject(row.id);
					if (batch.columns.includes("project_id")) {
						const actual = (
							await tx.query(`SELECT project_id FROM ${q(batch.table)} WHERE id=$1 LIMIT 1`, [
								row.id ?? null,
							])
						)[0];
						await authorizeTargetProject(actual?.project_id);
					}
				}
			const touched = new Set<string>();
			for (const batch of batches)
				for (const row of batch.rows) {
					const owner = batch.table === "narrators" ? row.id : row.narrator_id;
					if (typeof owner === "string") touched.add(owner);
					// Validate actual target owners of every referenced message, not a payload's
					// claimed narrator_id. A FK that happens to exist is not an authorization grant.
					for (const field of ["message_id", "fork_message_id", "narrator_message_id"])
						if (typeof row[field] === "string") {
							const existingMessage = (
								await tx.query("SELECT narrator_id FROM narrator_messages WHERE id=$1 LIMIT 1", [
									row[field],
								])
							)[0];
							if (typeof existingMessage?.narrator_id === "string")
								touched.add(existingMessage.narrator_id);
						}
					if (
						["narrator_tool_calls", "narrator_message_refs", "narrator_patches"].includes(
							batch.table,
						) &&
						typeof row.id === "string"
					) {
						const existingRow = (
							await tx.query(`SELECT narrator_id FROM ${q(batch.table)} WHERE id=$1 LIMIT 1`, [
								row.id,
							])
						)[0];
						if (typeof existingRow?.narrator_id === "string") touched.add(existingRow.narrator_id);
					}
					if (batch.table === "narrator_messages" && typeof row.id === "string") {
						const existing = (
							await tx.query("SELECT narrator_id FROM narrator_messages WHERE id=$1 LIMIT 1", [
								row.id,
							])
						)[0];
						if (typeof existing?.narrator_id === "string") touched.add(existing.narrator_id);
					}
				}
			if (actor)
				for (const id of touched) {
					check();
					const existing = (
						await tx.query(
							`SELECT id,type,owner_user_id,acl_root_narrator_id${narratorColumns.includes("variant") ? ",variant" : ""} FROM narrators WHERE id=$1 LIMIT 1`,
							[id],
						)
					)[0];
					if (!existing) continue;
					const root =
						typeof existing.acl_root_narrator_id === "string"
							? (
									await tx.query("SELECT id,owner_user_id FROM narrators WHERE id=$1 LIMIT 1", [
										existing.acl_root_narrator_id,
									])
								)[0]
							: undefined;
					assertFullExport(
						typeof existing.variant === "string" && existing.variant.startsWith("subagent:")
							? { ...existing, type: "subagent" }
							: existing,
						actor,
						root,
					); // A source ID never grants access to an existing target.
				}
			const pending: {
				table: ArchiveTable;
				id: ArchiveValue;
				field: string;
				value: ArchiveValue;
			}[] = [];
			const tables: Record<string, number> = {};
			const importedNarrators: string[] = [];
			for (const batch of batches) {
				tables[batch.table] = batch.rows.length;
				const forward = new Set(forwardReferencesOf(batch.table, batch.columns));
				for (const raw of batch.rows) {
					check();
					const row: Record<string, ArchiveValue> = { ...raw, ...FROZEN_FIELDS[batch.table] };
					if (batch.table === "narrator_tool_calls") {
						// Only terminal success/fail are historical. Missing and unknown states
						// also fail closed instead of inheriting the target's initializing default.
						if (!["success", "fail"].includes(String(row.status))) row.status = "fail";
						if (row.status === "fail") {
							row.permission_decided_by = null;
							row.permission_decided_at = null;
						}
					}
					const values = batch.columns.map((field) =>
						forward.has(field) ? null : (row[field] ?? null),
					);
					const inserted = await tx.query(
						`INSERT ${main ? "OR IGNORE " : ""}INTO ${q(batch.table)} (${batch.columns.map(q).join(",")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(",")}) ${main ? "" : "ON CONFLICT DO NOTHING "}RETURNING id`,
						values,
					);
					if (!inserted.length) continue;
					if (batch.table === "narrators") importedNarrators.push(String(row.id));
					for (const field of forward)
						if (row[field] != null)
							pending.push({
								table: batch.table,
								id: row.id ?? null,
								field,
								value: row[field] ?? null,
							});
				}
			}
			for (const reference of pending) {
				check();
				await tx.query(`UPDATE ${q(reference.table)} SET ${q(reference.field)}=$1 WHERE id=$2`, [
					reference.value,
					reference.id,
				]);
			}
			if (narratorColumns.includes("next_seq"))
				for (const id of importedNarrators) {
					check();
					await tx.query(
						"UPDATE narrators SET next_seq=(SELECT coalesce(max(seq)+1,0) FROM narrator_message_refs WHERE narrator_id=$1) WHERE id=$1",
						[id],
					);
				}
			check();
			return {
				projectId: String(project.id),
				projectName: String(project.name),
				tables,
				skipped: false,
			};
		});
	} finally {
		archive.close();
		main?.close();
		await pg?.close();
	}
}
if (parentPort) {
	const port = parentPort;
	port.postMessage({ ready: "private-archive-worker-v1" });
	port.once("message", async (request: LegacyImportWorkerRequest) => {
		try {
			port.postMessage({ value: await runLegacyImportWorker(request) });
		} catch {
			port.postMessage({ error: "Project import validation or operation failed" });
		}
	});
}
