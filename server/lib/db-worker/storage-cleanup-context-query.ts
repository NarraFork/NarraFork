import type { Database } from "bun:sqlite";

export const CLEANUP_CONTEXT_BUDGET_EXCEEDED = "DATABASE_CLEANUP_CONTEXT_BUDGET_EXCEEDED";
const PAGE_SIZE = 256;
const MAX_ROWS = 50_000;
const MAX_BYTES = 8 * 1024 * 1024;

export const NARRATOR_CLEANUP_COLUMNS = `
	id,
	parent_narrator_id AS parentNarratorId,
	type,
	variant,
	traits,
	title,
	status,
	COALESCE(message_count, 0) AS messageCount,
	created_at AS createdAt,
	updated_at AS updatedAt,
	last_message_at AS lastMessageAt,
	COALESCE(is_background, 0) AS isBackground,
	background_status AS backgroundStatus`;

export interface CleanupContextRow extends Record<string, unknown> {
	id: string;
	hasRunningTerminal: number;
}

/** Only preview metadata. Keep keyset pages in one committed snapshot, never return a prefix. */
export function readDatabaseCleanupContext(sqlite: Database, signal: AbortSignal) {
	const query = `
		SELECT ${NARRATOR_CLEANUP_COLUMNS},
			EXISTS (SELECT 1 FROM terminals t WHERE t.narrator_id = narrators.id AND t.status = 'running')
				AS hasRunningTerminal
		FROM narrators`;
	const first = sqlite.prepare<CleanupContextRow, [number]>(`${query} ORDER BY id LIMIT ?`);
	const next = sqlite.prepare<CleanupContextRow, [string, number]>(
		`${query} WHERE id > ? ORDER BY id LIMIT ?`,
	);
	try {
		return sqlite.transaction(() => {
			const rows: CleanupContextRow[] = [];
			let cursor: string | undefined;
			let bytes = 0;
			while (true) {
				signal.throwIfAborted();
				const page =
					cursor === undefined ? first.iterate(PAGE_SIZE) : next.iterate(cursor, PAGE_SIZE);
				let count = 0;
				for (const row of page) {
					count++;
					bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
					if (rows.length >= MAX_ROWS || bytes > MAX_BYTES) {
						throw Object.assign(new Error("Database cleanup context exceeds its budget"), {
							code: CLEANUP_CONTEXT_BUDGET_EXCEEDED,
						});
					}
					rows.push(row);
					cursor = row.id;
				}
				if (count < PAGE_SIZE) return rows;
			}
		})();
	} finally {
		first.finalize();
		next.finalize();
	}
}
