import type { Database } from "bun:sqlite";
import { AppError } from "../lib/errors";

type Column = { name: string; notnull: number; dflt_value: unknown };
const tables = ["context_memories", "context_memory_events"] as const;
type MemoryTable = (typeof tables)[number];

/** Copy only new memory identities; restoring a session must not merge divergent audit chains. */
export function importContextMemoryTables(
	database: Database,
	source: string,
	excludedNarrators: readonly string[],
): void {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(source)) throw new Error("Invalid snapshot schema");
	const columns = (schema: string, table: MemoryTable) =>
		database.query<Column, []>(`PRAGMA ${schema}.table_info(${table})`).all();
	const incoming = new Map(tables.map((table) => [table, columns(source, table)]));
	if (tables.every((table) => incoming.get(table)?.length === 0)) return;
	const shared = new Map<MemoryTable, string[]>();
	for (const table of tables) {
		const target = columns("main", table);
		const names = new Set(incoming.get(table)?.map((column) => column.name));
		// Do not erase provenance by importing a partial memory schema with null defaults.
		const required =
			table === "context_memories"
				? ["project_id", "narrator_id", "source_narrator_id", "source_message_id"]
				: [];
		if (
			names.size === 0 ||
			required.some((name) => !names.has(name)) ||
			target.some(
				(column) => column.notnull && column.dflt_value === null && !names.has(column.name),
			)
		) {
			throw new AppError("Import failed: incomplete memory snapshot", 400);
		}
		shared.set(
			table,
			target.filter((column) => names.has(column.name)).map((column) => column.name),
		);
	}
	const copy = (
		table: MemoryTable,
		where: string,
		params: Array<string | number>,
		ignore: boolean,
	) => {
		const names = shared.get(table) ?? [];
		const quoted = names.map((name) => `"${name.replaceAll('"', '""')}"`);
		database.run(
			`INSERT ${ignore ? "OR IGNORE " : ""}INTO main.${table} (${quoted.join(", ")})
			 SELECT ${quoted.map((name) => `incoming.${name}`).join(", ")}
			 FROM ${source}.${table} AS incoming WHERE ${where}`,
			params,
		);
	};
	const baseline =
		database
			.query<{ value: number }, []>(
				"SELECT COALESCE(MAX(rowid), 0) AS value FROM main.context_memories",
			)
			.get()?.value ?? 0;

	// Users/projects are not snapshot tables. Missing ownership or source references must
	// reject the memory, not become NULL and weaken its later authorization checks.
	copy(
		"context_memories",
		`
		EXISTS (SELECT 1 FROM main.users WHERE id = incoming.owner_user_id)
		AND (incoming.project_id IS NULL OR EXISTS (
			SELECT 1 FROM main.projects WHERE id = incoming.project_id))
		AND (incoming.narrator_id IS NULL OR EXISTS (
			SELECT 1 FROM main.narrators WHERE id = incoming.narrator_id))
		AND (incoming.source_narrator_id IS NULL OR EXISTS (
			SELECT 1 FROM main.narrators WHERE id = incoming.source_narrator_id))
		AND (incoming.source_message_id IS NULL OR EXISTS (
			SELECT 1 FROM main.narrator_message_refs
			WHERE narrator_id = incoming.source_narrator_id AND message_id = incoming.source_message_id))
		AND (incoming.narrator_id IS NULL OR incoming.narrator_id NOT IN (
			SELECT value FROM json_each(?)))
		AND (incoming.source_narrator_id IS NULL OR incoming.source_narrator_id NOT IN (
			SELECT value FROM json_each(?)))
		AND incoming.id NOT IN (SELECT audit.memory_id FROM ${source}.context_memory_events AS audit
			WHERE audit.memory_id IS NOT NULL AND (
				NOT EXISTS (SELECT 1 FROM main.users WHERE id = audit.actor_user_id)
				OR EXISTS (SELECT 1 FROM main.context_memory_events WHERE id = audit.id)
			))`,
		[JSON.stringify(excludedNarrators), JSON.stringify(excludedNarrators)],
		true,
	);
	// A primary/key conflict above keeps the LOCAL memory; none of its incoming audit is
	// appended. Constraint failures in a new audit chain roll back the surrounding import.
	copy(
		"context_memory_events",
		`EXISTS (
		SELECT 1 FROM main.context_memories
		WHERE id = incoming.memory_id AND rowid > ?
	)`,
		[baseline],
		false,
	);
}
