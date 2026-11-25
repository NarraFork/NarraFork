import { DbReadError } from "./errors";

export interface RecallQuery {
	sql: string;
	params: (string | number | null)[];
}
export type RecallQueryRows = Record<string, unknown>[];
export interface RecallEffectiveRefs {
	/** effective_recall_refs has message_id and seq. Across snapshots use the guard wrapper. */
	cte: string;
	params: RecallQuery["params"];
	/** Captured standalone/materialized state: direct indexed refs need no ancestry union. */
	ownOnly?: boolean;
}
const MAX_LINEAGE_DEPTH = 32;

/** The guard and content execute in ONE database statement/snapshot. Nested WITH is allowed. */
export function guardRecallEffectiveRefsQuery(
	refs: RecallEffectiveRefs,
	selectSql: string,
	tailParams: RecallQuery["params"] = [],
	orderBy?: string,
): RecallQuery {
	return {
		sql: `${refs.cte}, recall_query_result AS (${selectSql}),
		recall_marked_results AS (SELECT recall_query_result.*, 1 AS recall_row_present FROM recall_query_result)
		SELECT recall_marked_results.*, recall_lineage_guard.valid AS recall_lineage_valid
		FROM recall_lineage_guard LEFT JOIN recall_marked_results ON true${orderBy ? ` ORDER BY ${orderBy}` : ""}`,
		params: [...refs.params, ...tailParams],
	};
}

/** A failed guard is never an empty/missing success and never releases ancestor content. */
export function unwrapRecallEffectiveRefsRows(rows: RecallQueryRows): RecallQueryRows {
	if (
		!rows.length ||
		rows.some(
			(row) =>
				(row.recall_lineage_valid !== true && row.recall_lineage_valid !== 1) ||
				!Object.hasOwn(row, "recall_row_present") ||
				(row.recall_row_present !== 1 && row.recall_row_present !== null),
		)
	)
		throw new DbReadError("DB_READ_PROTOCOL", "Recall lineage changed during read");
	return rows
		.filter((row) => row.recall_row_present === 1)
		.map(({ recall_lineage_valid: _valid, recall_row_present: _present, ...row }) => row);
}

/** Read-only counterpart of narrator-refs-backfill's min-cursor/copyWindow rules.
 * Only the small lineage is loaded in JS; message selection stays indexed in SQL.
 * No global database/backend imports: the caller drives the same plan on SQLite or PG.
 */
export function* recallEffectiveRefsQueries(
	narratorId: string,
	postgres = false,
): Generator<RecallQuery, RecallEffectiveRefs, RecallQueryRows> {
	const rows = yield {
		sql: `WITH RECURSIVE lineage(id, refs_inherited_from, refs_backfill_cursor, depth) AS (
			SELECT id, refs_inherited_from, refs_backfill_cursor, 0 FROM narrators WHERE id = ${postgres ? "$1" : "?"}
			UNION ALL SELECT n.id, n.refs_inherited_from, n.refs_backfill_cursor, l.depth + 1
			FROM narrators n JOIN lineage l ON n.id = l.refs_inherited_from
			WHERE l.depth < ${MAX_LINEAGE_DEPTH}
		) SELECT * FROM lineage ORDER BY depth LIMIT ${MAX_LINEAGE_DEPTH + 1}`,
		params: [narratorId],
	};
	const states = new Map(rows.map((row) => [String(row.id), row]));
	const sources: { id: string; bound: number | null }[] = [{ id: narratorId, bound: null }];
	const seen = new Set([narratorId]);
	let observedId = narratorId;
	let bound = Number.POSITIVE_INFINITY;
	for (;;) {
		const state = states.get(observedId);
		if (!state) {
			if (sources.length === 1) break;
			throw new DbReadError("DB_READ_PROTOCOL", "Inherited Recall narrator no longer exists");
		}
		if (state.refs_inherited_from === null && state.refs_backfill_cursor === null) break;
		const cursor = Number(state.refs_backfill_cursor);
		if (
			typeof state.refs_inherited_from !== "string" ||
			!state.refs_inherited_from ||
			state.refs_backfill_cursor === null ||
			!Number.isSafeInteger(cursor) ||
			cursor < 0
		)
			throw new DbReadError("DB_READ_PROTOCOL", "Inherited Recall cursor is invalid");
		if (seen.has(state.refs_inherited_from))
			throw new DbReadError("DB_READ_PROTOCOL", "Inherited Recall lineage contains a cycle");
		if (sources.length > MAX_LINEAGE_DEPTH)
			throw new DbReadError("DB_READ_BUDGET", "Inherited Recall lineage is too deep");
		bound = Math.min(bound, cursor);
		observedId = state.refs_inherited_from;
		seen.add(observedId);
		sources.push({ id: observedId, bound });
	}
	const params: RecallQuery["params"] = [];
	const values = sources.map((source, depth) => {
		const state = states.get(source.id);
		params.push(
			source.id,
			source.bound,
			(state?.refs_inherited_from as string | null) ?? null,
			(state?.refs_backfill_cursor as number | null) ?? null,
		);
		return `(?${postgres ? "::text" : ""}, ?${postgres ? "::bigint" : ""}, ${depth}, ?${postgres ? "::text" : ""}, ?${postgres ? "::bigint" : ""}, ${state ? 1 : 0})`;
	});
	return {
		cte: `WITH recall_ref_sources(narrator_id, upper_bound, depth, expected_parent, expected_cursor, expected_exists) AS (VALUES ${values.join(",")}),
		recall_lineage_guard AS (
			SELECT NOT EXISTS (
				SELECT 1 FROM recall_ref_sources captured LEFT JOIN narrators observed ON observed.id = captured.narrator_id
				WHERE (captured.expected_exists = 1 AND observed.id IS NULL)
				OR (captured.expected_exists = 0 AND observed.id IS NOT NULL)
				OR observed.refs_inherited_from IS DISTINCT FROM captured.expected_parent
				OR observed.refs_backfill_cursor IS DISTINCT FROM captured.expected_cursor
			) AS valid
		), effective_recall_refs AS (
			SELECT r.message_id, r.seq FROM recall_ref_sources s
			JOIN narrator_message_refs r ON r.narrator_id = s.narrator_id
			WHERE (SELECT valid FROM recall_lineage_guard)
			AND (s.depth = 0 OR (r.seq < s.upper_bound AND r.segment_compact_id IS NULL))
			AND NOT EXISTS (
				SELECT 1 FROM recall_ref_sources closer
				JOIN narrator_message_refs own ON own.narrator_id = closer.narrator_id AND own.message_id = r.message_id
				WHERE closer.depth < s.depth AND (closer.depth = 0 OR (own.seq < closer.upper_bound AND own.segment_compact_id IS NULL))
			)
		)`,
		params,
		ownOnly: sources.length === 1,
	};
}
