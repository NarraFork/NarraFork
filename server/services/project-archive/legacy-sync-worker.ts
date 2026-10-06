import { Database } from "bun:sqlite";
import { parentPort } from "node:worker_threads";
import { SQL } from "bun";
import { type ArchiveActor, assertFullExport, ProjectArchiveAuthorizationError } from "./access";
import { PROJECT_ARCHIVE_LIMITS as LIMITS } from "./limits";
import type { ArchiveRow, ArchiveValue } from "./main-store";
import {
	ARCHIVE_COLUMNS,
	ARCHIVE_INTERNAL_REFERENCES,
	ARCHIVE_TABLE_ORDER,
	type ArchiveTable,
} from "./manifest";
import { postgresArchiveConnection } from "./worker-postgres-store";
import { sqliteArchiveConnection } from "./worker-sqlite-store";

export interface LegacySyncWorkerRequest {
	databasePath: string;
	archivePath: string;
	backend: "sqlite" | "postgres";
	postgresUrl?: string;
	projectId: string;
	actor?: ArchiveActor;
	deadline: number;
	cancellation: SharedArrayBuffer;
}
const q = (name: string) => `"${name}"`;
export async function runLegacySyncWorker(
	request: LegacySyncWorkerRequest,
): Promise<{ tables: Record<string, number> }> {
	const check = () => {
		if (Date.now() >= request.deadline || Atomics.load(new Int32Array(request.cancellation), 0))
			throw new Error("Project backup cancelled or timed out");
	};
	check();
	const source =
		request.backend === "sqlite"
			? new Database(request.databasePath, { readonly: true })
			: undefined;
	const pg =
		request.backend === "postgres"
			? new SQL(request.postgresUrl ?? "", { max: 1, connectionTimeout: 10 })
			: undefined;
	const sourceConnection = source
		? sqliteArchiveConnection(source)
		: pg
			? postgresArchiveConnection(pg)
			: undefined;
	if (!sourceConnection) throw new Error("Project backup source unavailable");
	const archive = new Database(request.archivePath);
	archive.run("PRAGMA busy_timeout=250");
	try {
		return await sourceConnection.transaction(false, async (tx) => {
			const rows = new Map<ArchiveTable, Map<string, ArchiveRow>>();
			const columns = new Map<ArchiveTable, string[]>();
			let totalBytes = 0;
			let totalRows = 0;
			const dependencyQueue: [ArchiveTable, ArchiveRow][] = [];
			const refMembership = new Set<string>();
			for (const table of ARCHIVE_TABLE_ORDER) {
				const available = await tx.columns(table);
				const target = archive.prepare(`PRAGMA table_info(${q(table)})`).all() as {
					name: string;
				}[];
				columns.set(
					table,
					ARCHIVE_COLUMNS[table].filter(
						(name) => available.includes(name) && target.some((field) => field.name === name),
					),
				);
				rows.set(table, new Map());
			}
			async function read(
				table: ArchiveTable,
				column: string,
				values: string[],
				extra = "",
				projectRow?: (row: ArchiveRow) => ArchiveRow,
			) {
				const selection = columns.get(table) ?? [];
				const found = rows.get(table);
				if (!selection.length || !found) return;
				for (let offset = 0; offset < values.length; offset += 200) {
					const params: ArchiveValue[] = values.slice(offset, offset + 200);
					let after = "";
					for (;;) {
						check();
						const sizes = await tx.query(
							`SELECT id,(${selection.map((name) => tx.byteLength(name)).join("+")}) AS size FROM ${q(table)} WHERE ${q(column)} IN (${params.map((_, i) => `$${i + 1}`).join(",")}) AND id>$${params.length + 1} ${extra} ORDER BY id LIMIT 500`,
							[...params, after],
						);
						if (!sizes.length) break;
						for (const info of sizes) {
							check();
							const id = String(info.id);
							after = id;
							if (!projectRow && found.has(id)) continue;
							if (Number(info.size) > LIMITS.rowBytes)
								throw new Error("Project backup row byte limit exceeded");
							const raw = (
								await tx.query(
									`SELECT ${selection.map(q).join(",")} FROM ${q(table)} WHERE id=$1 LIMIT 1`,
									[id],
								)
							)[0];
							if (!raw) throw new Error("Project snapshot row disappeared");
							const row = projectRow ? projectRow(raw) : raw;
							if (typeof row.id !== "string") throw new Error("Invalid project row ID");
							if (found.has(row.id)) continue;
							if (table === "narrator_message_refs") {
								const membership = JSON.stringify([row.narrator_id, row.message_id]);
								if (refMembership.has(membership)) continue;
								refMembership.add(membership);
							}
							totalBytes += Buffer.byteLength(JSON.stringify(row));
							if (totalBytes > LIMITS.stateBytes || ++totalRows > LIMITS.stateRows)
								throw new Error("Project backup state limit exceeded");
							found.set(row.id, row);
							dependencyQueue.push([table, row]);
						}
					}
				}
			}
			await read("projects", "id", [request.projectId]);
			if (!rows.get("projects")?.size) throw new Error("Project backup source missing");
			await read("chapters", "project_id", [request.projectId]);
			const chapterIds = [...(rows.get("chapters")?.keys() ?? [])];
			await read("chapter_edges", "project_id", [request.projectId]);
			await read("exploration_groups", "project_id", [request.projectId]);
			await read("narrators", "chapter_id", chapterIds);
			await read("narrators", "context_project_id", [request.projectId]);
			// Only selected roots grow a transcript selection. Provenance-only primary
			// dependencies below never pull in siblings or ask-other conversations.
			let frontier = [...(rows.get("narrators")?.keys() ?? [])];
			const expanded = new Set(frontier);
			const narratorSourceColumns = await tx.columns("narrators");
			const subagentPredicate = narratorSourceColumns.includes("variant")
				? "AND (type='subagent' OR variant LIKE 'subagent:%')"
				: "AND type='subagent'";
			while (frontier.length) {
				check();
				await read("narrators", "parent_narrator_id", frontier, subagentPredicate);
				frontier = [...(rows.get("narrators")?.keys() ?? [])].filter((id) => !expanded.has(id));
				for (const id of frontier) expanded.add(id);
			}
			const narratorIds = [...expanded];
			let actor = request.actor;
			if (actor) {
				const user = (
					await tx.query("SELECT id,role FROM users WHERE id=$1 LIMIT 1", [actor.userId])
				)[0];
				if (!user) throw new ProjectArchiveAuthorizationError();
				actor = { userId: actor.userId, isAdmin: actor.isAdmin && user.role === "admin" };
			}
			const authorized = new Set<string>();
			async function authorize(narratorId: string) {
				if (!actor) return;
				const pending = new Set([narratorId]);
				// Metadata-only parent/lazy/ACL dependencies still require independent full
				// authority, even when their rows or transcripts are not portable archive data.
				const metadataFields = [
					"parent_narrator_id",
					"refs_inherited_from",
					"acl_root_narrator_id",
					"variant",
				].filter((field) => narratorSourceColumns.includes(field));
				for (const id of pending) {
					check();
					if (authorized.has(id)) continue;
					if (authorized.size + pending.size > LIMITS.stateRows)
						throw new Error("Project archive authorization closure budget exceeded");
					const row = (
						await tx.query(
							`SELECT id,type,owner_user_id${metadataFields.map((field) => `,${q(field)}`).join("")} FROM narrators WHERE id=$1 LIMIT 1`,
							[id],
						)
					)[0];
					if (!row) throw new ProjectArchiveAuthorizationError();
					const root =
						typeof row.acl_root_narrator_id === "string"
							? (
									await tx.query(
										"SELECT id,type,owner_user_id FROM narrators WHERE id=$1 LIMIT 1",
										[row.acl_root_narrator_id],
									)
								)[0]
							: undefined;
					assertFullExport(
						typeof row.variant === "string" && row.variant.startsWith("subagent:")
							? { ...row, type: "subagent" }
							: row,
						actor,
						root,
					);
					authorized.add(id);
					for (const field of ["parent_narrator_id", "refs_inherited_from", "acl_root_narrator_id"])
						if (typeof row[field] === "string" && !authorized.has(row[field]))
							pending.add(row[field]);
				}
			}
			for (const id of narratorIds) await authorize(id);
			await read("narrator_message_refs", "narrator_id", narratorIds);
			// Materialize effective lazy windows only in the portable archive. The source
			// stays read-only, including its refs/backfill cursor and ownership metadata.
			if (
				narratorSourceColumns.includes("refs_inherited_from") &&
				narratorSourceColumns.includes("refs_backfill_cursor")
			) {
				for (const narratorId of narratorIds) {
					let current = narratorId;
					let cut = Number.POSITIVE_INFINITY;
					const visited = new Set<string>();
					for (;;) {
						check();
						if (visited.has(current) || visited.size >= LIMITS.stateRows)
							throw new Error("Cyclic or excessive project lazy history");
						visited.add(current);
						const metadata = (
							await tx.query(
								"SELECT refs_inherited_from,refs_backfill_cursor FROM narrators WHERE id=$1 LIMIT 1",
								[current],
							)
						)[0];
						if (typeof metadata?.refs_inherited_from !== "string") break;
						if (
							!Number.isSafeInteger(metadata.refs_backfill_cursor) ||
							Number(metadata.refs_backfill_cursor) < 0
						)
							throw new Error("Invalid project lazy history cut");
						cut = Math.min(cut, Number(metadata.refs_backfill_cursor));
						current = metadata.refs_inherited_from;
						await authorize(current);
						await read("narrators", "id", [current]);
						await read(
							"narrator_message_refs",
							"narrator_id",
							[current],
							`AND seq<${cut}`,
							(row) => ({
								...row,
								id: `legacy-inherited:${narratorId}:${row.message_id}`,
								narrator_id: narratorId,
							}),
						);
					}
				}
			}
			const messageIds = [
				...new Set(
					[...(rows.get("narrator_message_refs")?.values() ?? [])].map((row) =>
						String(row.message_id),
					),
				),
			];
			await read("narrator_messages", "id", messageIds);
			await read("narrator_tool_calls", "message_id", messageIds);
			for (const table of ["narrator_messages", "narrator_tool_calls"] as const)
				for (const row of rows.get(table)?.values() ?? []) await authorize(String(row.narrator_id));
			await read("chapter_commits", "chapter_id", chapterIds);
			await read("merge_sessions", "target_chapter_id", chapterIds);
			// Follow only explicit immutable dependencies, never another narrator's entire
			// conversation. A source-contained file must restore into an empty target.
			for (let offset = 0; offset < dependencyQueue.length; offset++) {
				check();
				const [table, row] = dependencyQueue[offset];
				if (table === "narrators") await authorize(String(row.id));
				for (const [field, dependency] of Object.entries(
					ARCHIVE_INTERNAL_REFERENCES[table] ?? {},
				)) {
					const id = row[field];
					if (id == null) continue;
					if (typeof id !== "string") throw new Error("Invalid project dependency ID");
					if (dependency === "projects" && id !== request.projectId)
						throw new Error("Cross-project dependency requires a separate archive; export blocked");
					await read(dependency, "id", [id]);
					if (!rows.get(dependency)?.has(id))
						throw new Error("Missing self-contained project dependency; export blocked");
				}
			}
			const tables: Record<string, number> = {};
			// Entire SQLite write happens on this dedicated worker connection, never on HTTP's
			// main thread. Failure/cancel before COMMIT rolls every scope back together.
			archive.run("BEGIN IMMEDIATE");
			try {
				// Capture the OLD explicit scope before replacing chapters. Removed chapters and
				// narrators must not leave dangling refs, while NULL/unknown affiliation survives.
				const oldNarratorIds: string[] = [];
				let after = "";
				for (;;) {
					check();
					const page = archive
						.prepare(
							"SELECT id FROM narrators WHERE id>? AND (context_project_id=? OR chapter_id IN (SELECT id FROM chapters WHERE project_id=?)) ORDER BY id LIMIT 500",
						)
						.all(after, request.projectId, request.projectId) as { id: string }[];
					if (!page.length) break;
					oldNarratorIds.push(...page.map((row) => row.id));
					if (oldNarratorIds.length > LIMITS.stateRows)
						throw new Error("Project archive old scope budget exceeded");
					after = page[page.length - 1].id;
				}
				// Keep historical identity/dependency metadata available for surviving unknown
				// refs. It is archive evidence, NEVER a substitute for a live source ACL owner.
				const historical = new Map<ArchiveTable, Map<string, ArchiveRow>>();
				let historicalBytes = 0;
				let historicalRows = 0;
				for (const table of ["narrators", "chapters", "exploration_groups"] as const) {
					const fields = (
						archive.prepare(`PRAGMA table_info(${q(table)})`).all() as { name: string }[]
					)
						.map((field) => field.name)
						.filter((field) => ARCHIVE_COLUMNS[table].includes(field));
					const saved = new Map<string, ArchiveRow>();
					historical.set(table, saved);
					let cursor = "";
					for (;;) {
						check();
						const page = archive
							.prepare(
								`SELECT id,(${fields.map((field) => `coalesce(length(CAST(${q(field)} AS BLOB)),0)`).join("+")}) AS size FROM ${q(table)} WHERE id>? ORDER BY id LIMIT 500`,
							)
							.all(cursor) as { id: string; size: number }[];
						if (!page.length) break;
						for (const info of page) {
							check();
							historicalRows++;
							historicalBytes += info.size;
							if (
								info.size > LIMITS.rowBytes ||
								historicalRows > LIMITS.stateRows ||
								historicalBytes > LIMITS.stateBytes
							)
								throw new Error("Project archive history metadata budget exceeded");
							const row = archive
								.prepare(`SELECT ${fields.map(q).join(",")} FROM ${q(table)} WHERE id=?`)
								.get(info.id) as ArchiveRow;
							saved.set(info.id, row);
							cursor = info.id;
						}
					}
				}
				for (const id of oldNarratorIds)
					archive.prepare("DELETE FROM narrators WHERE id=?").run(id);
				for (const table of ["chapters", "chapter_edges", "exploration_groups"])
					archive.prepare(`DELETE FROM ${q(table)} WHERE project_id=?`).run(request.projectId);
				for (const id of new Set([...oldNarratorIds, ...narratorIds])) {
					archive.prepare("DELETE FROM narrator_message_refs WHERE narrator_id=?").run(id);
					archive
						.prepare(
							"DELETE FROM narrator_tool_calls WHERE narrator_id=? AND NOT EXISTS (SELECT 1 FROM narrator_message_refs r WHERE r.message_id=narrator_tool_calls.message_id) AND NOT EXISTS (SELECT 1 FROM narrators n WHERE n.fork_message_id=narrator_tool_calls.message_id)",
						)
						.run(id);
				}
				for (const table of ARCHIVE_TABLE_ORDER) {
					const fields = columns.get(table) ?? [];
					const values = [...(rows.get(table)?.values() ?? [])];
					tables[table] = values.length;
					if (!fields.length) continue;
					const insert = archive.prepare(
						`INSERT OR REPLACE INTO ${q(table)} (${fields.map(q).join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
					);
					for (const row of values) {
						check();
						insert.run(
							...fields.map((field) =>
								typeof row[field] === "boolean" ? Number(row[field]) : (row[field] ?? null),
							),
						);
					}
				}
				// No NULL-chapter sweep. Unknown legacy affiliation and live shared refs survive.
				archive.run(
					"DELETE FROM narrator_messages WHERE NOT EXISTS (SELECT 1 FROM narrator_message_refs r WHERE r.message_id=narrator_messages.id) AND NOT EXISTS (SELECT 1 FROM narrators n WHERE n.fork_message_id=narrator_messages.id) AND NOT EXISTS (SELECT 1 FROM narrator_tool_calls t WHERE t.message_id=narrator_messages.id) AND NOT EXISTS (SELECT 1 FROM chapter_commits c WHERE c.narrator_message_id=narrator_messages.id) AND NOT EXISTS (SELECT 1 FROM narrator_patches p WHERE p.message_id=narrator_messages.id)",
				);
				// Validate the ENTIRE published file, including preserved unknown affiliation,
				// not just the newly selected source rows. Restore minimal historical metadata
				// only when an actual surviving row points at it; never restore its refs.
				const repairQueue: [ArchiveTable, ArchiveRow][] = [];
				let archiveRows = 0;
				let archiveBytes = 0;
				for (const table of ARCHIVE_TABLE_ORDER) {
					const available = new Set(
						(archive.prepare(`PRAGMA table_info(${q(table)})`).all() as { name: string }[]).map(
							(field) => field.name,
						),
					);
					const references = Object.keys(ARCHIVE_INTERNAL_REFERENCES[table] ?? {}).filter((field) =>
						available.has(field),
					);
					const fields = ARCHIVE_COLUMNS[table].filter((field) => available.has(field));
					let cursor = "";
					for (;;) {
						check();
						const page = archive
							.prepare(
								`SELECT ${["id", ...references].map(q).join(",")},(${fields.map((field) => `coalesce(length(CAST(${q(field)} AS BLOB)),0)`).join("+")}) AS size FROM ${q(table)} WHERE id>? ORDER BY id LIMIT 500`,
							)
							.all(cursor) as ArchiveRow[];
						if (!page.length) break;
						for (const row of page) {
							check();
							archiveRows++;
							archiveBytes += Number(row.size);
							if (
								Number(row.size) > LIMITS.rowBytes ||
								archiveRows > LIMITS.stateRows ||
								archiveBytes > LIMITS.stateBytes
							)
								throw new Error("Project complete archive budget exceeded");
							repairQueue.push([table, row]);
							cursor = String(row.id);
						}
					}
				}
				for (let offset = 0; offset < repairQueue.length; offset++) {
					check();
					const [table, row] = repairQueue[offset];
					for (const [field, dependency] of Object.entries(
						ARCHIVE_INTERNAL_REFERENCES[table] ?? {},
					)) {
						const id = row[field];
						if (id == null) continue;
						if (typeof id !== "string") throw new Error("Invalid historical project dependency");
						if (archive.prepare(`SELECT id FROM ${q(dependency)} WHERE id=? LIMIT 1`).get(id))
							continue;
						const metadata = historical.get(dependency)?.get(id);
						if (
							!metadata ||
							(metadata.project_id != null && metadata.project_id !== request.projectId) ||
							(metadata.context_project_id != null &&
								metadata.context_project_id !== request.projectId)
						)
							throw new Error("Incomplete historical archive dependency; export blocked");
						const fields = Object.keys(metadata);
						archiveRows++;
						archiveBytes += Buffer.byteLength(JSON.stringify(metadata));
						if (archiveRows > LIMITS.stateRows || archiveBytes > LIMITS.stateBytes)
							throw new Error("Project historical dependency budget exceeded");
						archive
							.prepare(
								`INSERT INTO ${q(dependency)} (${fields.map(q).join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
							)
							.run(...fields.map((field) => metadata[field] ?? null));
						repairQueue.push([dependency, metadata]);
					}
				}
				check();
				archive.run("COMMIT");
			} catch (error) {
				archive.run("ROLLBACK");
				throw error;
			}
			return { tables };
		});
	} finally {
		archive.close();
		source?.close();
		await pg?.close();
	}
}
if (parentPort) {
	const port = parentPort;
	port.postMessage({ ready: "private-archive-worker-v1" });
	port.once("message", async (request: LegacySyncWorkerRequest) => {
		try {
			port.postMessage({ value: await runLegacySyncWorker(request) });
		} catch (error) {
			port.postMessage({
				error: "Project archive validation or operation failed",
				code:
					error instanceof ProjectArchiveAuthorizationError
						? "PROJECT_ARCHIVE_FORBIDDEN"
						: undefined,
			});
		}
	});
}
